/**
 * @blasti/api — Background Notification Worker
 *
 * Runs a 30-second interval loop that:
 * 1. Fetches DelayedJob records where executeAt <= now() and status === PENDING
 * 2. Processes each job by parsing payload, checking SMS balance (agency vs user),
 *    sending the notification, and updating the job status
 * 3. Logs each processed job for observability
 */

import { db } from '@blasti/db'
import { sendSms, type SendSmsResult } from '../lib/sms-service'

const POLL_INTERVAL_MS = 30_000 // 30 seconds
let workerInterval: ReturnType<typeof setInterval> | null = null

// ─── Public API ──────────────────────────────────────────────────────────────

export function startNotificationWorker(): void {
  if (workerInterval) return // Already running

  console.log('[notification-worker] Starting background worker (30s interval)')

  workerInterval = setInterval(async () => {
    try {
      await processPendingJobs()
    } catch (error) {
      console.error('[notification-worker] Error processing jobs:', error)
    }
  }, POLL_INTERVAL_MS)

  // Process immediately on start
  processPendingJobs().catch(console.error)
}

export function stopNotificationWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval)
    workerInterval = null
    console.log('[notification-worker] Stopped')
  }
}

// ─── Core Processing ─────────────────────────────────────────────────────────

interface DelayedJobPayload {
  phone: string
  message: string
  agencyId: string
  userId: string
  channel?: 'SMS' | 'WHATSAPP' | 'BOTH' // defaults to SMS
}

async function processPendingJobs(): Promise<number> {
  const now = new Date()

  const pendingJobs = await db.delayedJob.findMany({
    where: {
      status: 'PENDING',
      executeAt: { lte: now },
    },
    include: {
      user: {
        select: {
          id: true,
          phoneNumber: true,
          notificationPref: true,
          freeSmsCount: true,
        },
      },
    },
    take: 50, // Process in batches to avoid memory spikes
  })

  if (pendingJobs.length === 0) return 0

  console.log(`[notification-worker] Processing ${pendingJobs.length} pending jobs`)

  let processed = 0
  for (const job of pendingJobs) {
    try {
      const payload: DelayedJobPayload = JSON.parse(job.payload)
      const { phone, message, agencyId, userId, channel } = payload

      // ── Step 1: Look up agency to decide who pays for SMS ──
      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        select: {
          id: true,
          sponsorSms: true,
          smsBalance: true,
          name: true,
        },
      })

      if (!agency) {
        console.warn(`[notification-worker] Agency ${agencyId} not found for job ${job.id} — cancelling`)
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
        continue
      }

      // ── Step 2: Determine the channel ──
      // If user is APP_ONLY or already online, cancel the carrier alert
      if (job.user.isAppOnline) {
        console.log(`[notification-worker] User ${userId} is online — cancelling carrier alert job ${job.id}`)
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
        continue
      }

      const effectiveChannel = channel || resolveChannel(job.user.notificationPref)

      // APP_ONLY preference → no carrier alert needed
      if (effectiveChannel === 'APP_ONLY') {
        console.log(`[notification-worker] User ${userId} pref is APP_ONLY — cancelling job ${job.id}`)
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
        continue
      }

      // ── Step 3: Check balance / credits ──
      let hasBalance = false

      if (agency.sponsorSms) {
        // Agency sponsors SMS — check agency's smsBalance
        hasBalance = agency.smsBalance > 0
      } else {
        // User pays — check user's freeSmsCount
        hasBalance = job.user.freeSmsCount > 0
      }

      if (!hasBalance) {
        console.warn(
          `[notification-worker] Insufficient balance for job ${job.id} ` +
          `(agency.sponsorSms=${agency.sponsorSms}, agency.smsBalance=${agency.smsBalance}, user.freeSmsCount=${job.user.freeSmsCount}) — cancelling`
        )
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
        continue
      }

      // ── Step 4: Send the notification ──
      const targetPhone = phone || job.user.phoneNumber

      if (!targetPhone) {
        console.warn(`[notification-worker] No phone number for user ${userId} — cancelling job ${job.id}`)
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
        continue
      }

      let sendResult: SendSmsResult

      if (effectiveChannel === 'WHATSAPP') {
        // For now, WhatsApp sends are not implemented — fall back to SMS
        // TODO: integrate WhatsApp Business API when available
        console.log(`[notification-worker] WhatsApp not yet available — falling back to SMS for job ${job.id}`)
        sendResult = await sendSms(targetPhone, message, userId)
      } else {
        // SMS or BOTH — send via SMS
        sendResult = await sendSms(targetPhone, message, agency.sponsorSms ? undefined : userId)
      }

      // ── Step 5: Update status and deduct balance ──
      if (sendResult.success) {
        // Deduct 1 from the appropriate balance
        if (agency.sponsorSms) {
          await db.agency.update({
            where: { id: agencyId },
            data: { smsBalance: { decrement: 1 } },
          })
        }
        // Note: sendSms() already deducts from user.freeSmsCount when userId is passed,
        // so we only need to handle the agency-sponsored case explicitly.

        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'SENT' },
        })

        console.log(
          `[notification-worker] Job ${job.id} SENT to ${targetPhone} ` +
          `via ${effectiveChannel} (agency-sponsored: ${agency.sponsorSms})`
        )
        processed++
      } else {
        console.error(
          `[notification-worker] Failed to send job ${job.id}: ${sendResult.error} — cancelling`
        )
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
      }
    } catch (error) {
      console.error(`[notification-worker] Failed to process job ${job.id}:`, error)
      try {
        await db.delayedJob.update({
          where: { id: job.id },
          data: { status: 'CANCELLED' },
        })
      } catch {
        // Best-effort status update
      }
    }
  }

  return processed
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type NotificationChannel = 'SMS' | 'WHATSAPP' | 'BOTH' | 'APP_ONLY'

/**
 * Resolve the effective carrier channel from the user's notification preference.
 * Maps the Prisma enum values to the channel we should use.
 */
function resolveChannel(pref: string): NotificationChannel {
  switch (pref) {
    case 'SMS':
      return 'SMS'
    case 'WHATSAPP':
      return 'WHATSAPP'
    case 'BOTH':
      return 'BOTH'
    case 'APP_ONLY':
      return 'APP_ONLY'
    default:
      return 'SMS' // Safe default
  }
}
