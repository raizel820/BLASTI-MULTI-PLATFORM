import { Hono } from 'hono'
import { db } from '@blasti/db'
import { normalizeDzPhone, getSmsTemplate, sendSms } from '../lib/sms-service'
import { recordSyncChange } from '../lib/sync-helpers'
import { emitNotificationEvent } from '../lib/realtime-emit'
import { sendViaPushNotification } from '../lib/notification-router'
import { getCheckoutStatus, expireCheckout } from '../lib/chargily-service'
import {
  fulfillCheckoutPaid,
  fulfillCheckoutFailed,
  normalizeChargilyStatus,
} from '../lib/chargily-fulfill'

const app = new Hono()

const NO_SHOW_SKIP_MINUTES = 3
const SMS_FALLBACK_MINUTES = 10

// Helper: verify cron secret
function verifyCronSecret(c: import('hono').Context): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const authHeader = c.req.header('Authorization')
    if (authHeader !== `Bearer ${cronSecret}`) return false
  }
  return true
}

// GET /cron/auto-skip — Auto-skip no-show reservations
app.get('/auto-skip', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const cutoffTime = new Date(Date.now() - NO_SHOW_SKIP_MINUTES * 60 * 1000)

    const candidates = await db.reservation.findMany({
      where: {
        status: 'CALLED',
        calledAt: { not: null, lte: cutoffTime },
      },
      include: {
        user: { select: { id: true, fullName: true, language: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
      },
    })

    const unskippedCandidates = candidates.filter(r => {
      const rAny = r as Record<string, unknown>
      return rAny.skippedForNoShow !== true && !rAny.reclaimRequestedAt
    })

    let skipped = 0

    for (const reservation of unskippedCandidates) {
      if (!reservation.user) continue

      const agencyName =
        reservation.user.language === 'ar' ? reservation.agency.nameAr || reservation.agency.name
          : reservation.user.language === 'fr' ? reservation.agency.nameFr || reservation.agency.name
          : reservation.agency.name

      await db.$transaction(async (tx) => {
        try {
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { skippedForNoShow: true, skippedAt: new Date() },
          })
        } catch {
          console.warn('[cron/auto-skip] Could not set skippedForNoShow, column may not exist')
        }
        // Spec Part O: tx ops are invisible to the auto-tracking extension.
        await recordSyncChange({ tx, agencyId: reservation.agencyId, model: 'Reservation', recordId: reservation.id, operation: 'update' })

        if (reservation.userId) {
          const notif = await tx.notification.create({
            data: {
              userId: reservation.userId,
              type: 'NO_SHOW_WARNING',
              title: 'You Were Skipped',
              message: `Your ticket ${reservation.displayNumber} at ${agencyName} was skipped because you did not respond within ${NO_SHOW_SKIP_MINUTES} minutes. You can still reclaim your position if you arrive soon.`,
            },
          })
          await recordSyncChange({ tx, agencyId: reservation.agencyId, model: 'Notification', recordId: notif.id, operation: 'create' })
        }

        await tx.auditLog.create({
          data: {
            userId: reservation.userId || undefined,
            action: 'AUTO_SKIP_NO_SHOW',
            entityType: 'RESERVATION',
            entityId: reservation.id,
            details: JSON.stringify({ displayNumber: reservation.displayNumber, agencyId: reservation.agencyId, calledAt: reservation.calledAt }),
          },
        })
      })

      skipped++
    }

    return c.json({ checked: unskippedCandidates.length, skipped })
  } catch (error) {
    console.error('[cron/auto-skip] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /cron/check-reminders — Check and send queue reminders
app.get('/check-reminders', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const today = new Date().toISOString().split('T')[0]

    const allCandidates = await db.reservation.findMany({
      where: {
        status: 'WAITING',
        reminderSent: false,
        OR: [{ reservedDate: today }, { reservedDate: null }],
        user: { reminderMinutes: { gt: 0 } },
      },
      include: {
        user: { select: { id: true, reminderMinutes: true, fullName: true, language: true, fcmToken: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true, averageServiceTime: true } },
      },
      orderBy: { queueNumber: 'asc' },
    })

    const candidates = allCandidates.filter(r => {
      const rAny = r as Record<string, unknown>
      return rAny.skippedForNoShow !== true
    })

    let remindersSent = 0

    for (const reservation of candidates) {
      if (!reservation.user) continue

      const peopleAhead = await db.reservation.count({
        where: { agencyId: reservation.agencyId, status: 'WAITING', joinedAt: { lt: reservation.joinedAt }, id: { not: reservation.id } },
      })

      const avgServiceTime = reservation.agency.averageServiceTime || 10
      const userReminderMinutes = reservation.user.reminderMinutes || 10

      const estimatedMinutesUntilTurn = peopleAhead * avgServiceTime
      if (estimatedMinutesUntilTurn <= userReminderMinutes) {
        const agencyName =
          reservation.user.language === 'ar' ? reservation.agency.nameAr || reservation.agency.name
            : reservation.user.language === 'fr' ? reservation.agency.nameFr || reservation.agency.name
            : reservation.agency.name

        let turnApproachingEvent: { userId: string; ticketNumber: string; agencyName: string; peopleAhead: number } | null = null

        await db.$transaction(async (tx) => {
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { reminderSent: true, reminderSentAt: new Date() },
          })
          // Spec Part O: tx ops are invisible to the auto-tracking extension.
          await recordSyncChange({ tx, agencyId: reservation.agencyId, model: 'Reservation', recordId: reservation.id, operation: 'update' })

          if (reservation.userId) {
            const notif = await tx.notification.create({
              data: {
                userId: reservation.userId,
                type: 'TURN_APPROACHING',
                title: 'Your Turn is Approaching',
                message: `Your ticket ${reservation.displayNumber} at ${agencyName} is coming up soon. ${peopleAhead === 0 ? 'You are next!' : `Approximately ${peopleAhead} ahead of you.`}`,
              },
            })
            await recordSyncChange({ tx, agencyId: reservation.agencyId, model: 'Notification', recordId: notif.id, operation: 'create' })
            // Task 24: also emit the realtime event the customer app listens for
            // (customer-queue.tsx 'notification:turn-approaching' toast). The
            // socket event was typed but NEVER emitted anywhere — dead alert.
            turnApproachingEvent = { userId: reservation.userId, ticketNumber: reservation.displayNumber, agencyName, peopleAhead }
          }
        })

        if (turnApproachingEvent) {
          const ev = turnApproachingEvent as { userId: string; ticketNumber: string; agencyName: string; peopleAhead: number }
          emitNotificationEvent('notification:turn-approaching', ev.userId, {
            ticketNumber: ev.ticketNumber,
            agencyName: ev.agencyName,
            peopleAhead: ev.peopleAhead,
            userId: ev.userId,
            reservationId: reservation.id,
          }).catch(() => {})

          // ── Lock-screen delivery when the app is CLOSED/backgrounded ──
          // The socket event above only reaches a LIVE webview; the field
          // report ("cooling turn notification is no longer showing in lock
          // screen") is exactly the app-dead case. FCM notification message
          // → OS tray on the blasti-turn-alert channel (high-importance,
          // PUBLIC → lock-screen content, native swipe dismiss).
          const fcmToken = (reservation.user as { fcmToken?: string | null }).fcmToken
          if (fcmToken) {
            void sendViaPushNotification(fcmToken, {
              userId: reservation.userId!,
              reservationId: reservation.id,
              agencyId: reservation.agencyId,
              type: 'ADVANCE_WARNING',
              message: `Your ticket ${reservation.displayNumber} at ${agencyName} is coming up soon. ${ev.peopleAhead === 0 ? 'You are next!' : `Approximately ${ev.peopleAhead} ahead of you.`}`,
              messageAr: `تذكرتك ${reservation.displayNumber} في ${agencyName} يقترب دورك قريبًا.`,
              remainingMinutes: estimatedMinutesUntilTurn,
            }).catch(() => { /* push is best-effort — the in-app row already exists */ })
          }
        }

        remindersSent++
      }
    }

    return c.json({ checked: candidates.length, remindersSent })
  } catch (error) {
    console.error('[cron/check-reminders] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /cron/check-sms-fallback — Check and send SMS fallback reminders
app.get('/check-sms-fallback', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const cutoffTime = new Date(Date.now() - SMS_FALLBACK_MINUTES * 60 * 1000)

    const allCandidates = await db.reservation.findMany({
      where: {
        status: { in: ['WAITING', 'CALLED'] },
        user: { smsNotificationsEnabled: true, phoneNumber: { not: null }, isActive: true },
      },
      include: {
        user: {
          select: { id: true, fullName: true, phoneNumber: true, freeSmsCount: true, language: true, smsPurchases: { select: { id: true, quantity: true, price: true }, orderBy: { createdAt: 'asc' } } },
        },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true, averageServiceTime: true } },
      },
    })

    const candidates = allCandidates.filter(r => {
      const rAny = r as Record<string, unknown>
      if (rAny.reminderSent !== true) return false
      const reminderSentAt = rAny.reminderSentAt as Date | null
      if (!reminderSentAt || reminderSentAt > cutoffTime) return false
      if (rAny.smsReminderSent === true) return false
      if (rAny.skippedForNoShow === true) return false
      return true
    })

    let smsSent = 0
    let noCredit = 0

    for (const reservation of candidates) {
      const user = reservation.user
      if (!user) continue

      const totalFreeCredits = user.freeSmsCount || 0
      const totalPurchasedCredits = user.smsPurchases.reduce((sum, p) => sum + p.quantity, 0)

      if (totalFreeCredits + totalPurchasedCredits <= 0) { noCredit++; continue }

      const normalizedPhone = normalizeDzPhone(user.phoneNumber!)
      if (!normalizedPhone) {
        await db.smsLog.create({
          data: { userId: user.id, phoneNumber: user.phoneNumber!, message: 'SMS fallback - invalid phone', status: 'FAILED', provider: 'system', errorMessage: `Invalid phone number format: ${user.phoneNumber}` },
        })
        continue
      }

      const lang = user.language || 'ar'
      const agencyName = lang === 'ar' ? reservation.agency.nameAr || reservation.agency.name
        : lang === 'fr' ? reservation.agency.nameFr || reservation.agency.name
        : reservation.agency.name

      const position = reservation.queueNumber
      const estimatedMinutes = Math.max(1, Math.round(reservation.agency.averageServiceTime || 10))

      const smsMessage = await getSmsTemplate('turnApproaching', lang, {
        customerName: user.fullName,
        ticketNumber: reservation.displayNumber,
        agencyName,
        position,
        estimatedMinutes,
      })

      const result = await sendSms(normalizedPhone, smsMessage, user.id)

      if (result.success) {
        try {
          await db.reservation.update({
            where: { id: reservation.id },
            data: { smsReminderSent: true, smsReminderSentAt: new Date() },
          })
        } catch {
          console.warn('[cron/check-sms-fallback] Could not set smsReminderSent, column may not exist')
        }
        smsSent++
      } else {
        console.error(`[cron/check-sms-fallback] Failed to send SMS to ${normalizedPhone}: ${result.error}`)
      }
    }

    return c.json({ checked: candidates.length, smsSent, noCredit })
  } catch (error) {
    console.error('[cron/check-sms-fallback] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /cron/handle-downgrades — Soft-lock excess services/staff when agency downgrades
app.get('/handle-downgrades', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    // Find all agencies with active subscriptions
    const agencies = await db.agency.findMany({
      where: { subscriptionStatus: 'ACTIVE' },
      include: {
        subscriptionPlan: true,
        services: { where: { isActive: true }, orderBy: { createdAt: 'desc' } },
        staff: { where: { isActive: true }, orderBy: { joinedAt: 'desc' } },
      },
    })

    let lockedServices = 0
    let lockedStaff = 0

    for (const agency of agencies) {
      const plan = agency.subscriptionPlan
      if (!plan) continue

      // Check if agency has more active services than the plan allows
      if (agency.services.length > plan.maxServices) {
        const excess = agency.services.length - plan.maxServices
        // Soft-lock the MOST RECENTLY created excess services
        const toLock = agency.services.slice(0, excess)
        for (const service of toLock) {
          await db.service.update({
            where: { id: service.id },
            data: { isActive: false },
          })
          lockedServices++
        }
      }

      // Check if agency has more active staff than the plan allows
      if (agency.staff.length > plan.maxStaff) {
        const excess = agency.staff.length - plan.maxStaff
        const toLock = agency.staff.slice(0, excess)
        for (const staff of toLock) {
          await db.agencyStaff.update({
            where: { id: staff.id },
            data: { isActive: false },
          })
          lockedStaff++
        }
      }
    }

    return c.json({ checked: agencies.length, lockedServices, lockedStaff })
  } catch (error) {
    console.error('[cron/handle-downgrades] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /cron/sweep-offline — Sweep stale DEFERRED_OFFLINE reservations older than 24 hours
app.post('/sweep-offline', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago

    // Find all DEFERRED_OFFLINE reservations older than 24h
    const staleReservations = await db.reservation.findMany({
      where: {
        status: 'DEFERRED_OFFLINE',
        offlineCreatedAt: { not: null, lte: staleThreshold },
      },
      include: {
        user: { select: { id: true, fullName: true, language: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
      },
    })

    let expired = 0
    let cancelled = 0
    let notified = 0

    for (const reservation of staleReservations) {
      // Mark as CANCELLED and set sync conflict flag
      await db.$transaction(async (tx) => {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            syncConflict: true,
          },
        })
        // Spec Part O: tx ops are invisible to the auto-tracking extension.
        await recordSyncChange({ tx, agencyId: reservation.agencyId, model: 'Reservation', recordId: reservation.id, operation: 'update' })

        // Notify the customer if they have a user account
        if (reservation.userId) {
          const lang = (reservation.user as any)?.language || 'ar'
          const agencyName =
            lang === 'ar' ? (reservation.agency as any)?.nameAr || (reservation.agency as any)?.name
              : lang === 'fr' ? (reservation.agency as any)?.nameFr || (reservation.agency as any)?.name
              : (reservation.agency as any)?.name

          const notif = await tx.notification.create({
            data: {
              userId: reservation.userId,
              type: 'RESERVATION_CANCELLED',
              title: 'Offline Reservation Expired',
              message: `Your offline reservation at ${agencyName} could not be synced within 24 hours and has been cancelled. Please try booking again when you have internet access.`,
            },
          })
          await recordSyncChange({ tx, agencyId: reservation.agencyId, model: 'Notification', recordId: notif.id, operation: 'create' })
          notified++
        }

        // Create audit log
        await tx.auditLog.create({
          data: {
            userId: reservation.userId || undefined,
            action: 'RESERVATION_CANCEL',
            entityType: 'RESERVATION',
            entityId: reservation.id,
            details: JSON.stringify({
              reason: 'stale_offline_reservation',
              offlineCreatedAt: (reservation as any).offlineCreatedAt,
              displayNumber: reservation.displayNumber,
              agencyId: reservation.agencyId,
            }),
          },
        })
      })

      cancelled++
    }

    // Also handle DEFERRED_OFFLINE reservations without offlineCreatedAt (orphaned)
    const orphanedReservations = await db.reservation.findMany({
      where: {
        status: 'DEFERRED_OFFLINE',
        offlineCreatedAt: null,
        joinedAt: { lte: staleThreshold },
      },
    })

    for (const reservation of orphanedReservations) {
      await db.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          syncConflict: true,
        },
      })
      expired++
    }

    return c.json({
      success: true,
      staleChecked: staleReservations.length,
      cancelled,
      expired,
      notified,
    })
  } catch (error) {
    console.error('[cron/sweep-offline] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// ─── Task 2-e: Stale-PENDING payment sweeper ────────────────────────────────
// A PENDING Transaction / SmsPurchase whose Chargily webhook never arrives AND
// whose customer never returns to the app (so the poll fallback never runs)
// would stay PENDING forever — the agency's subscriptionStatus stuck on
// 'PENDING', SMS credits never granted, hardware orders never approved.
//
// This sweeper asks Chargily for the live checkout status and settles through
// the SAME idempotent fulfillment used by the webhook and poll paths.
//
//   Interval ....... every 5 minutes (in-process, unref'd)
//   Candidate ...... status PENDING · paymentProvider 'chargily' ·
//                    providerRef set · createdAt older than 30 minutes
//   unreachable .... skip silently (retried on the next sweep)
//   status paid .... fulfillCheckoutPaid(..., 'sweep')
//   status failed .. fulfillCheckoutFailed(..., 'sweep')
//   pending >24h ... expireCheckout() then fulfillCheckoutFailed(...,
//                    'sweep-expired')
//
// Also exposed as POST /api/cron/sweep-payments (verifyCronSecret) so an
// external scheduler can trigger a run on demand.

const PAYMENT_SWEEP_INTERVAL_MS = 5 * 60 * 1000     // every 5 minutes
const PAYMENT_STALE_AFTER_MS = 30 * 60 * 1000       // 30 min without settlement → ask Chargily
const PAYMENT_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000 // 24h still pending → force-expire at gateway
const PAYMENT_SWEEP_BATCH = 25                      // max Chargily round-trips per run

interface PaymentSweepStats {
  checked: number
  settledPaid: number
  settledFailed: number
  expired: number
  skipped: number
}

export async function sweepPendingPayments(): Promise<PaymentSweepStats> {
  const stats: PaymentSweepStats = { checked: 0, settledPaid: 0, settledFailed: 0, expired: 0, skipped: 0 }
  const staleBefore = new Date(Date.now() - PAYMENT_STALE_AFTER_MS)
  const expireBefore = new Date(Date.now() - PAYMENT_EXPIRE_AFTER_MS)

  // `not: ''` also excludes NULL rows (SQL `<>` semantics) — manual transactions
  // (empty providerRef, awaiting admin review) are never swept.
  const pendingChargily = {
    status: 'PENDING',
    paymentProvider: 'chargily',
    providerRef: { not: '' },
    createdAt: { lt: staleBefore },
  }

  // Cheap guard first — one COUNT per table; skip the whole sweep when no
  // record is eligible (the overwhelmingly common case).
  const [txCount, smsCount] = await Promise.all([
    db.transaction.count({ where: pendingChargily }),
    db.smsPurchase.count({ where: pendingChargily }),
  ])
  if (txCount + smsCount === 0) return stats

  const [staleTx, staleSms] = await Promise.all([
    db.transaction.findMany({
      where: pendingChargily,
      select: { id: true, providerRef: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: PAYMENT_SWEEP_BATCH,
    }),
    db.smsPurchase.findMany({
      where: pendingChargily,
      select: { id: true, providerRef: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: PAYMENT_SWEEP_BATCH,
    }),
  ])

  const candidates = [
    ...staleTx.map((t) => ({ kind: 'transaction' as const, ...t })),
    ...staleSms.map((s) => ({ kind: 'sms_purchase' as const, ...s })),
  ]
    .filter((c) => !!c.providerRef)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, PAYMENT_SWEEP_BATCH)

  stats.checked = candidates.length
  if (candidates.length === 0) return stats
  console.log(
    `[cron:payments] Sweeping ${candidates.length} stale PENDING payment record(s) (eligible: tx=${txCount}, sms=${smsCount})`,
  )

  for (const candidate of candidates) {
    const providerRef = candidate.providerRef as string
    try {
      const checkout = await getCheckoutStatus(providerRef)
      const normalized = normalizeChargilyStatus(checkout.status)
      const payload = {
        id: checkout.id || providerRef,
        status: checkout.status,
        amount: typeof checkout.amount === 'number' ? checkout.amount : 0,
        payment_method: checkout.payment_method ?? null,
        metadata: checkout.metadata ?? null,
      }

      if (normalized === 'paid') {
        await fulfillCheckoutPaid(payload, 'sweep')
        stats.settledPaid++
        console.log(`[cron:payments] Settled ${candidate.kind} ${candidate.id} as PAID (checkout ${providerRef})`)
      } else if (normalized === 'failed') {
        await fulfillCheckoutFailed(payload, 'sweep')
        stats.settledFailed++
        console.log(`[cron:payments] Settled ${candidate.kind} ${candidate.id} as FAILED (checkout ${providerRef})`)
      } else if (candidate.createdAt < expireBefore) {
        // Genuinely still pending at the gateway after 24h — force-expire the
        // checkout remotely, then settle the local record as failed so nothing
        // stays PENDING forever. If the expire call fails, retry next sweep.
        try {
          await expireCheckout(providerRef)
        } catch (err) {
          console.warn(`[cron:payments] Could not expire checkout ${providerRef}:`, err instanceof Error ? err.message : err)
          stats.skipped++
          continue
        }
        await fulfillCheckoutFailed(payload, 'sweep-expired')
        stats.expired++
        console.log(`[cron:payments] Expired + settled ${candidate.kind} ${candidate.id} as FAILED (checkout ${providerRef}, pending >24h)`)
      } else {
        // Still pending inside the window — retry on the next sweep.
        stats.skipped++
      }
    } catch (err) {
      // Chargily unreachable / keys misconfigured / bad row — one bad record
      // must never kill the sweep; it is simply retried on the next run.
      stats.skipped++
      console.warn(
        `[cron:payments] Skipped ${candidate.kind} ${candidate.id} (checkout ${providerRef}):`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return stats
}

// POST /cron/sweep-payments — settle stale PENDING Chargily payments now
app.post('/sweep-payments', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const stats = await sweepPendingPayments()
    return c.json({ success: true, ...stats })
  } catch (error) {
    console.error('[cron/sweep-payments] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export const cronRoutes = app

// In-process registration — index.ts imports this module for the /api/cron
// routes, so starting the interval here keeps the sweeper next to the cron
// endpoints without touching index.ts (same start-from-worker-module pattern
// as workers/notification-worker.ts).
let paymentSweeperStarted = false
export function startPaymentSweeper(): void {
  if (paymentSweeperStarted) return
  paymentSweeperStarted = true
  console.log(
    '[cron:payments] Payment sweeper registered (interval=5min, stale>30min, expire>24h, batch=25)',
  )
  setInterval(() => {
    sweepPendingPayments()
      .then((stats) => {
        if (stats.checked > 0) {
          console.log(
            `[cron:payments] Sweep done: checked=${stats.checked} paid=${stats.settledPaid} failed=${stats.settledFailed} expired=${stats.expired} skipped=${stats.skipped}`,
          )
        }
      })
      .catch((err) => console.error('[cron:payments] Sweep failed:', err))
  }, PAYMENT_SWEEP_INTERVAL_MS).unref()
}
startPaymentSweeper()
