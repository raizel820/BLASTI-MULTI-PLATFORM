/**
 * BLASTI Smart Notification Router
 *
 * Cost-saving notification routing layer that treats paid SMS/WhatsApp as a
 * premium last resort, using real-time WebSockets and Push Notifications first.
 *
 * Channel priority (cheapest first):
 *   1. WebSocket  (Socket.io)  → Cost: 0 DZD  (user is online in-app)
 *   2. Push       (FCM)        → Cost: 0 DZD  (device has FCM token)
 *   3. SMS / WhatsApp / Both   → Cost: paid   (carrier gateway, last resort)
 *
 * Special rules:
 *   - ADVANCE_WARNING alerts use the 25% Mathematical Buffer Rule:
 *       ExecutionTime = Date.now() + (remainingMinutes * 0.25 * 60 * 1000)
 *     The notification is scheduled as a DelayedJob with PENDING status.
 *   - TURN_CALL alerts bypass the delay engine and dispatch immediately
 *     through the carrier gateway if the user is offline.
 *
 * Balance deduction:
 *   - If agency.sponsorSms is true → deduct from agency.smsBalance
 *   - Otherwise → deduct from user.freeSmsCount
 *
 * IMPORTANT: The existing sendSms() in sms-service.ts already handles user-level
 * balance deduction when a userId is passed. To avoid double-deduction, this
 * router handles agency-sponsored deductions separately and calls sendSms()
 * WITHOUT userId when the agency is sponsoring (skipping its internal deduction).
 */

import type { Server as SocketIOServer } from 'socket.io'
import { db } from '@blasti/db'
import { sendSms, normalizeDzPhone } from './sms-service'

// ─── Types ──────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'TURN_CALL'
  | 'ADVANCE_WARNING'
  | 'TURN_COMPLETED'
  | 'QUEUE_UPDATE'

export interface NotificationPayload {
  userId: string
  reservationId: string
  agencyId: string
  type: NotificationType
  message: string
  messageAr?: string
  remainingMinutes?: number // Only for ADVANCE_WARNING
  metadata?: Record<string, unknown>
}

export interface RouteResult {
  channel: 'websocket' | 'push' | 'sms' | 'whatsapp' | 'delayed' | 'skipped'
  cost: number
  success: boolean
  jobId?: string
  reason?: string
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Cost per SMS/WhatsApp in Algerian Dinars (approximate) */
const SMS_COST_DZD = 3
const WHATSAPP_COST_DZD = 2

// ─── Main Router Function ───────────────────────────────────────────────────

/**
 * Route a notification through the cheapest available channel.
 *
 * Priority:
 *   1. If user.isAppOnline → WebSocket (free, instant)
 *   2. If user.fcmToken exists → FCM Push (free, instant)
 *   3. If type is ADVANCE_WARNING → apply 25% buffer rule (delayed carrier job)
 *   4. If type is TURN_CALL → immediate carrier dispatch (SMS/WhatsApp based on pref)
 *   5. For other types → carrier dispatch based on notificationPref
 */
export async function routeNotification(
  io: SocketIOServer,
  payload: NotificationPayload
): Promise<RouteResult> {
  const { userId, agencyId, type } = payload

  // ── Fetch user and agency data ──────────────────────────────────────────
  const [user, agency] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phoneNumber: true,
        language: true,
        notificationPref: true,
        isAppOnline: true,
        fcmToken: true,
        freeSmsCount: true,
        smsNotificationsEnabled: true,
      },
    }),
    db.agency.findUnique({
      where: { id: agencyId },
      select: {
        id: true,
        sponsorSms: true,
        smsBalance: true,
      },
    }),
  ])

  if (!user) {
    return {
      channel: 'skipped',
      cost: 0,
      success: false,
      reason: `User not found: ${userId}`,
    }
  }

  // If user has disabled SMS notifications and it's a carrier-only scenario,
  // we still allow free channels (websocket/push)
  const smsDisabled = !user.smsNotificationsEnabled

  // ── Channel 1: WebSocket (free) ─────────────────────────────────────────
  if (user.isAppOnline) {
    const wsSent = await sendViaWebSocket(io, userId, payload)
    if (wsSent) {
      return {
        channel: 'websocket',
        cost: 0,
        success: true,
        reason: 'User is online — delivered via Socket.io',
      }
    }
    // If WS failed despite isAppOnline being true, fall through to next channel
    // (the flag might be stale or socket disconnected between checks)
  }

  // ── Channel 2: FCM Push Notification (free) ─────────────────────────────
  if (user.fcmToken) {
    const pushSent = await sendViaPushNotification(user.fcmToken, payload)
    if (pushSent) {
      return {
        channel: 'push',
        cost: 0,
        success: true,
        reason: 'User has FCM token — delivered via push notification',
      }
    }
    // If push failed, fall through to carrier channels
  }

  // ── Free channels exhausted — check if carrier is viable ────────────────

  // If user has APP_ONLY preference, skip carrier channels entirely
  if (user.notificationPref === 'APP_ONLY') {
    // Still record in-app notification for when they open the app
    await createInAppNotification(payload)
    return {
      channel: 'skipped',
      cost: 0,
      success: true,
      reason: 'User preference is APP_ONLY — notification saved in-app only',
    }
  }

  // If SMS notifications are disabled, skip carrier channels
  if (smsDisabled) {
    await createInAppNotification(payload)
    return {
      channel: 'skipped',
      cost: 0,
      success: true,
      reason: 'SMS notifications disabled — notification saved in-app only',
    }
  }

  // Check carrier balance before proceeding
  const hasBalance = await checkCarrierBalance(agencyId, userId)
  if (!hasBalance) {
    await createInAppNotification(payload)
    return {
      channel: 'skipped',
      cost: 0,
      success: false,
      reason: 'No SMS balance available (agency or user)',
    }
  }

  // ── ADVANCE_WARNING: Apply 25% Mathematical Buffer Rule ─────────────────
  if (type === 'ADVANCE_WARNING' && payload.remainingMinutes !== undefined) {
    const remainingMinutes = payload.remainingMinutes
    // 25% of remaining time in milliseconds
    const delayMs = Math.floor(remainingMinutes * 0.25 * 60 * 1000)

    // Ensure minimum delay of 1 second to avoid immediate execution
    const effectiveDelayMs = Math.max(delayMs, 1000)

    const jobId = await scheduleDelayedJob(payload, effectiveDelayMs)

    return {
      channel: 'delayed',
      cost: 0, // Cost will be incurred when the job executes
      success: true,
      jobId,
      reason: `ADVANCE_WARNING: scheduled with ${effectiveDelayMs}ms delay (25% of ${remainingMinutes}min)`,
    }
  }

  // ── TURN_CALL: Immediate carrier dispatch (bypass delay engine) ─────────
  if (type === 'TURN_CALL') {
    return await dispatchViaCarrier(payload, user, agency)
  }

  // ── Other types (TURN_COMPLETED, QUEUE_UPDATE): carrier dispatch ────────
  // These also go through the carrier but are lower priority
  return await dispatchViaCarrier(payload, user, agency)
}

// ─── Helper: Send via Socket.io WebSocket ────────────────────────────────────

/**
 * Emit a notification directly to the user's Socket.io room.
 * Uses the `customer:${userId}` room pattern established in the main server.
 */
export async function sendViaWebSocket(
  io: SocketIOServer,
  userId: string,
  payload: NotificationPayload
): Promise<boolean> {
  try {
    const room = `customer:${userId}`
    const notificationData = {
      type: payload.type,
      reservationId: payload.reservationId,
      agencyId: payload.agencyId,
      message: payload.message,
      messageAr: payload.messageAr,
      remainingMinutes: payload.remainingMinutes,
      metadata: payload.metadata,
      timestamp: Date.now(),
    }

    io.to(room).emit('notification', notificationData)

    // Check if there are actual sockets in the room
    const sockets = io.sockets.adapter.rooms.get(room)
    const recipientCount = sockets ? sockets.size : 0

    console.log(
      `[NotificationRouter] WebSocket → ${room} (${recipientCount} recipients, type: ${payload.type})`
    )

    return recipientCount > 0
  } catch (error) {
    console.warn(
      `[NotificationRouter] WebSocket delivery failed for user ${userId}:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

// ─── Helper: Send via FCM Push Notification ──────────────────────────────────

/**
 * Send a push notification via Firebase Cloud Messaging.
 *
 * NOTE: This is a stub implementation. When the Firebase Admin SDK is
 * configured, replace the stub body with actual FCM dispatch logic.
 * The stub logs the attempt and returns true to simulate successful delivery.
 */
export async function sendViaPushNotification(
  fcmToken: string,
  payload: NotificationPayload
): Promise<boolean> {
  try {
    // ── Stub: Simulate FCM push ─────────────────────────────────────────
    // TODO: Replace with actual Firebase Admin SDK call:
    //
    // import * as admin from 'firebase-admin'
    // const message: admin.messaging.Message = {
    //   token: fcmToken,
    //   notification: {
    //     title: payload.type === 'TURN_CALL' ? 'Your Turn!' : 'Queue Update',
    //     body: payload.messageAr || payload.message,
    //   },
    //   data: {
    //     type: payload.type,
    //     reservationId: payload.reservationId,
    //     agencyId: payload.agencyId,
    //   },
    //   android: { priority: 'high' },
    //   apns: { payload: { aps: { sound: 'default' } } },
    // }
    // const response = await admin.messaging().send(message)
    // return !!response

    console.log(
      `[NotificationRouter] FCM Push → token:${fcmToken.substring(0, 8)}… ` +
        `(type: ${payload.type}, msg: "${(payload.messageAr || payload.message).substring(0, 40)}…")`
    )

    // Stub returns true to simulate successful delivery
    return true
  } catch (error) {
    console.warn(
      `[NotificationRouter] FCM Push delivery failed for token ${fcmToken.substring(0, 8)}…:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

// ─── Helper: Send via SMS carrier ────────────────────────────────────────────

/**
 * Send a notification via SMS through the existing SMS infrastructure.
 *
 * Balance handling strategy (avoids double-deduction with sms-service.ts):
 *   - If agency.sponsorSms → deduct from agency.smsBalance here, then call
 *     sendSms() WITHOUT userId (skips its internal user-level deduction).
 *     We manually create an SmsLog entry with userId for tracking.
 *   - If not agency-sponsored → call sendSms() WITH userId and let it handle
 *     the user-level balance deduction naturally (freeSmsCount + purchased credits).
 */
export async function sendViaSms(
  phoneNumber: string,
  message: string,
  agencyId: string,
  userId: string
): Promise<boolean> {
  try {
    // Normalize the phone number for Algerian carriers
    const normalizedPhone = normalizeDzPhone(phoneNumber)
    if (!normalizedPhone) {
      console.warn(
        `[NotificationRouter] Invalid phone number for SMS: ${phoneNumber}`
      )
      return false
    }

    // Determine who pays for this SMS
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { sponsorSms: true, smsBalance: true },
    })

    const isAgencySponsored = agency?.sponsorSms && agency.smsBalance > 0

    if (isAgencySponsored) {
      // ── Agency-sponsored path ──────────────────────────────────────────
      // 1. Deduct from agency balance (atomic with gte guard)
      const deducted = await db.agency.updateMany({
        where: { id: agencyId, smsBalance: { gte: 1 } },
        data: { smsBalance: { decrement: 1 } },
      })

      if (deducted.count === 0) {
        // Agency balance exhausted between check and deduction — fall through
        // to user-sponsored path
        console.warn(
          `[NotificationRouter] Agency ${agencyId} smsBalance exhausted mid-flight — falling back to user balance`
        )
        // Fall through to user-sponsored path below
      } else {
        // 2. Call sendSms WITHOUT userId (skip its internal user deduction)
        const result = await sendSms(normalizedPhone, message)

        if (!result.success) {
          // Refund agency balance on failure
          await db.agency.update({
            where: { id: agencyId },
            data: { smsBalance: { increment: 1 } },
          })
          console.warn(
            `[NotificationRouter] Agency-sponsored SMS failed: ${result.error} (user: ${userId})`
          )
          return false
        }

        // 3. Manually create an SmsLog with userId for tracking
        await db.smsLog.create({
          data: {
            userId,
            phoneNumber: normalizedPhone,
            message,
            status: 'SENT',
            provider: 'agency-sponsored',
          },
        })

        console.log(
          `[NotificationRouter] SMS sent (agency-sponsored) → ${normalizedPhone} (user: ${userId})`
        )
        return true
      }
    }

    // ── User-sponsored path ────────────────────────────────────────────────
    // sendSms with userId handles: freeSmsCount deduction, purchased credit
    // check, daily limit, and SmsLog creation — all internally.
    const result = await sendSms(normalizedPhone, message, userId)

    if (!result.success) {
      console.warn(
        `[NotificationRouter] SMS send failed: ${result.error} (user: ${userId})`
      )
      return false
    }

    console.log(
      `[NotificationRouter] SMS sent (user-sponsored) → ${normalizedPhone} (user: ${userId}, logId: ${result.logId})`
    )
    return true
  } catch (error) {
    console.error(
      `[NotificationRouter] SMS send error for user ${userId}:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

// ─── Helper: Send via WhatsApp carrier ───────────────────────────────────────

/**
 * Send a notification via WhatsApp.
 *
 * NOTE: This is a stub implementation. WhatsApp Business API integration
 * will be wired here when the provider is configured.
 *
 * Balance handling follows the same agency-sponsorship logic as SMS.
 */
export async function sendViaWhatsApp(
  phoneNumber: string,
  message: string,
  agencyId: string,
  userId: string
): Promise<boolean> {
  try {
    const normalizedPhone = normalizeDzPhone(phoneNumber)
    if (!normalizedPhone) {
      console.warn(
        `[NotificationRouter] Invalid phone number for WhatsApp: ${phoneNumber}`
      )
      return false
    }

    // Determine who pays
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { sponsorSms: true, smsBalance: true },
    })

    const isAgencySponsored = agency?.sponsorSms && agency.smsBalance > 0
    let agencyDeducted = false

    if (isAgencySponsored) {
      // Deduct from agency balance
      const deducted = await db.agency.updateMany({
        where: { id: agencyId, smsBalance: { gte: 1 } },
        data: { smsBalance: { decrement: 1 } },
      })
      agencyDeducted = deducted.count > 0

      if (!agencyDeducted) {
        console.warn(
          `[NotificationRouter] Agency ${agencyId} smsBalance exhausted for WhatsApp — falling back to user balance`
        )
      }
    }

    // If not agency-sponsored, deduct from user balance
    if (!agencyDeducted) {
      const userDeducted = await db.user.updateMany({
        where: { id: userId, freeSmsCount: { gte: 1 } },
        data: { freeSmsCount: { decrement: 1 } },
      })

      if (userDeducted.count === 0) {
        // Check purchased credits
        const purchasedTotal = await db.smsPurchase.aggregate({
          where: { userId, status: 'APPROVED' },
          _sum: { quantity: true },
        })
        const totalPurchased = purchasedTotal._sum.quantity ?? 0
        const usedCount = await db.smsLog.count({
          where: { userId, status: 'SENT' },
        })

        if (totalPurchased - usedCount <= 0) {
          console.warn(
            `[NotificationRouter] No balance for WhatsApp — user ${userId}`
          )
          return false
        }
      }
    }

    // ── Stub: Simulate WhatsApp send ────────────────────────────────────
    // TODO: Replace with actual WhatsApp Business API call:
    //
    // const response = await fetch('https://graph.facebook.com/v17.0/{PHONE_NUMBER_ID}/messages', {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     messaging_product: 'whatsapp',
    //     to: normalizedPhone,
    //     type: 'text',
    //     text: { body: message },
    //   }),
    // })
    // if (!response.ok) { ... refund ...; return false }

    console.log(
      `[NotificationRouter] WhatsApp → ${normalizedPhone} ` +
        `(user: ${userId}, sponsored: ${agencyDeducted}, msg: "${message.substring(0, 40)}…")`
    )

    // Create an SMS log entry for tracking (even though it's WhatsApp)
    await db.smsLog.create({
      data: {
        userId,
        phoneNumber: normalizedPhone,
        message,
        status: 'SENT',
        provider: 'whatsapp',
      },
    })

    return true
  } catch (error) {
    // Attempt refund on unexpected error
    await refundSmsBalance(agencyId, userId)
    console.error(
      `[NotificationRouter] WhatsApp send error for user ${userId}:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

// ─── Helper: Schedule a Delayed Job ──────────────────────────────────────────

/**
 * Schedule a delayed notification job for ADVANCE_WARNING alerts.
 *
 * The 25% Mathematical Buffer Rule:
 *   ExecutionTime = Date.now() + (remainingMinutes * 0.25 * 60 * 1000)
 *
 * The job is inserted into the DelayedJob table with PENDING status.
 * A separate cron worker picks up PENDING jobs when their executeAt time
 * has arrived and dispatches them through the carrier gateway.
 */
export async function scheduleDelayedJob(
  payload: NotificationPayload,
  delayMs: number
): Promise<string> {
  const executeAt = new Date(Date.now() + delayMs)

  const job = await db.delayedJob.create({
    data: {
      reservationId: payload.reservationId,
      userId: payload.userId,
      jobType: payload.type,
      payload: JSON.stringify({
        message: payload.message,
        messageAr: payload.messageAr,
        agencyId: payload.agencyId,
        remainingMinutes: payload.remainingMinutes,
        metadata: payload.metadata,
      }),
      executeAt,
      status: 'PENDING',
    },
  })

  console.log(
    `[NotificationRouter] DelayedJob scheduled → id:${job.id} ` +
      `type:${payload.type} executeAt:${executeAt.toISOString()} ` +
      `delay:${delayMs}ms`
  )

  return job.id
}

// ─── Helper: Deduct SMS Balance ──────────────────────────────────────────────

/**
 * Deduct SMS balance based on agency sponsorship:
 *   - If agency.sponsorSms is true → deduct from agency.smsBalance
 *   - Otherwise → deduct from user.freeSmsCount
 *
 * Uses atomic operations with gte guards to prevent race conditions.
 * Falls back to user balance if agency balance is exhausted.
 * Also checks purchased SMS credits as a last resort.
 *
 * NOTE: This function is used by the WhatsApp carrier path and by
 * checkCarrierBalance pre-flight. For the SMS carrier path, balance
 * deduction is integrated directly into sendViaSms() to avoid
 * double-deduction with sms-service.ts's sendSms().
 *
 * @returns true if deduction succeeded, false otherwise
 */
export async function deductSmsBalance(
  agencyId: string,
  userId: string
): Promise<boolean> {
  try {
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { sponsorSms: true, smsBalance: true },
    })

    if (agency?.sponsorSms) {
      // Agency sponsors SMS — deduct from agency balance
      const result = await db.agency.updateMany({
        where: { id: agencyId, smsBalance: { gte: 1 } },
        data: { smsBalance: { decrement: 1 } },
      })

      if (result.count > 0) {
        console.log(
          `[NotificationRouter] Deducted 1 from agency ${agencyId} smsBalance (sponsored)`
        )
        return true
      }

      // Agency balance exhausted — fall through to user balance
      console.warn(
        `[NotificationRouter] Agency ${agencyId} smsBalance exhausted — falling back to user balance`
      )
    }

    // Deduct from user's free SMS count
    const userResult = await db.user.updateMany({
      where: { id: userId, freeSmsCount: { gte: 1 } },
      data: { freeSmsCount: { decrement: 1 } },
    })

    if (userResult.count > 0) {
      console.log(
        `[NotificationRouter] Deducted 1 from user ${userId} freeSmsCount`
      )
      return true
    }

    // Check if user has purchased SMS credits as fallback
    const purchasedTotal = await db.smsPurchase.aggregate({
      where: { userId, status: 'APPROVED' },
      _sum: { quantity: true },
    })
    const totalPurchased = purchasedTotal._sum.quantity ?? 0
    const usedCount = await db.smsLog.count({
      where: { userId, status: 'SENT' },
    })

    if (totalPurchased - usedCount > 0) {
      // User has purchased credits — the SMS log creation
      // will track usage against purchased credits
      console.log(
        `[NotificationRouter] User ${userId} using purchased SMS credits (${totalPurchased - usedCount} remaining)`
      )
      return true
    }

    console.warn(
      `[NotificationRouter] No SMS balance available for user ${userId} (agency: ${agencyId})`
    )
    return false
  } catch (error) {
    console.error(
      `[NotificationRouter] SMS balance deduction error:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

// ─── Helper: Refund SMS Balance ──────────────────────────────────────────────

/**
 * Refund a previously deducted SMS balance if the send operation failed.
 * This reverses the deduction made by deductSmsBalance.
 *
 * Checks who originally paid (agency vs user) and refunds accordingly.
 */
export async function refundSmsBalance(
  agencyId: string,
  userId: string
): Promise<void> {
  try {
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { sponsorSms: true },
    })

    if (agency?.sponsorSms) {
      // Try to refund to agency balance first
      await db.agency.update({
        where: { id: agencyId },
        data: { smsBalance: { increment: 1 } },
      })
      console.log(
        `[NotificationRouter] Refunded 1 to agency ${agencyId} smsBalance`
      )
    } else {
      // Refund to user's free SMS count
      await db.user.update({
        where: { id: userId },
        data: { freeSmsCount: { increment: 1 } },
      })
      console.log(
        `[NotificationRouter] Refunded 1 to user ${userId} freeSmsCount`
      )
    }
  } catch (error) {
    console.error(
      `[NotificationRouter] SMS balance refund error:`,
      error instanceof Error ? error.message : error
    )
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Check if there is sufficient carrier balance (agency or user)
 * before attempting to send a paid notification.
 */
async function checkCarrierBalance(
  agencyId: string,
  userId: string
): Promise<boolean> {
  const [agency, user] = await Promise.all([
    db.agency.findUnique({
      where: { id: agencyId },
      select: { sponsorSms: true, smsBalance: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { freeSmsCount: true },
    }),
  ])

  // Agency-sponsored and has balance
  if (agency?.sponsorSms && agency.smsBalance > 0) {
    return true
  }

  // User has free credits
  if (user && user.freeSmsCount > 0) {
    return true
  }

  // Check purchased credits
  const purchasedTotal = await db.smsPurchase.aggregate({
    where: { userId, status: 'APPROVED' },
    _sum: { quantity: true },
  })
  const totalPurchased = purchasedTotal._sum.quantity ?? 0
  const usedCount = await db.smsLog.count({
    where: { userId, status: 'SENT' },
  })

  return totalPurchased - usedCount > 0
}

/**
 * Dispatch a notification through the carrier gateway based on
 * the user's notificationPref setting (SMS | WHATSAPP | BOTH).
 */
async function dispatchViaCarrier(
  payload: NotificationPayload,
  user: {
    id: string
    phoneNumber: string | null
    language: string
    notificationPref: string
    isAppOnline: boolean
    fcmToken: string | null
    freeSmsCount: number
    smsNotificationsEnabled: boolean
  },
  agency: {
    id: string
    sponsorSms: boolean
    smsBalance: number
  } | null
): Promise<RouteResult> {
  // Need a phone number for carrier channels
  if (!user.phoneNumber) {
    await createInAppNotification(payload)
    return {
      channel: 'skipped',
      cost: 0,
      success: false,
      reason: 'User has no phone number — cannot send via carrier',
    }
  }

  const message = user.language === 'ar' && payload.messageAr
    ? payload.messageAr
    : payload.message

  const pref = user.notificationPref as string

  // Determine which carrier channel(s) to use
  if (pref === 'SMS') {
    const sent = await sendViaSms(
      user.phoneNumber,
      message,
      payload.agencyId,
      user.id
    )
    return {
      channel: 'sms',
      cost: sent ? SMS_COST_DZD : 0,
      success: sent,
      reason: sent ? 'Delivered via SMS' : 'SMS delivery failed',
    }
  }

  if (pref === 'WHATSAPP') {
    const sent = await sendViaWhatsApp(
      user.phoneNumber,
      message,
      payload.agencyId,
      user.id
    )
    return {
      channel: 'whatsapp',
      cost: sent ? WHATSAPP_COST_DZD : 0,
      success: sent,
      reason: sent ? 'Delivered via WhatsApp' : 'WhatsApp delivery failed',
    }
  }

  if (pref === 'BOTH') {
    // Send via both channels — SMS first (more reliable), then WhatsApp
    const smsSent = await sendViaSms(
      user.phoneNumber,
      message,
      payload.agencyId,
      user.id
    )

    // Only send WhatsApp if SMS failed or as a redundant channel for critical alerts
    let whatsappSent = false
    if (payload.type === 'TURN_CALL' || !smsSent) {
      // For TURN_CALL: send via both channels for maximum reliability
      // For other types: only send WhatsApp if SMS failed
      whatsappSent = await sendViaWhatsApp(
        user.phoneNumber,
        message,
        payload.agencyId,
        user.id
      )
    }

    const anySent = smsSent || whatsappSent
    return {
      channel: anySent ? (smsSent ? 'sms' : 'whatsapp') : 'sms',
      cost: anySent
        ? (smsSent ? SMS_COST_DZD : 0) + (whatsappSent ? WHATSAPP_COST_DZD : 0)
        : 0,
      success: anySent,
      reason: anySent
        ? `Delivered via ${smsSent ? 'SMS' : ''}${smsSent && whatsappSent ? ' + ' : ''}${whatsappSent ? 'WhatsApp' : ''}`
        : 'Both SMS and WhatsApp delivery failed',
    }
  }

  // Fallback — shouldn't reach here but handle gracefully
  await createInAppNotification(payload)
  return {
    channel: 'skipped',
    cost: 0,
    success: false,
    reason: `Unknown notificationPref: ${pref}`,
  }
}

/**
 * Create an in-app notification record so the user sees it
 * when they next open the application.
 */
async function createInAppNotification(
  payload: NotificationPayload
): Promise<void> {
  try {
    await db.notification.create({
      data: {
        userId: payload.userId,
        type: payload.type,
        title:
          payload.type === 'TURN_CALL'
            ? 'Your Turn!'
            : payload.type === 'ADVANCE_WARNING'
              ? 'Turn Approaching'
              : payload.type === 'TURN_COMPLETED'
                ? 'Turn Completed'
                : 'Queue Update',
        message: payload.messageAr || payload.message,
        isRead: false,
        entityId: payload.reservationId,
      },
    })
  } catch (error) {
    console.warn(
      `[NotificationRouter] Failed to create in-app notification:`,
      error instanceof Error ? error.message : error
    )
  }
}
