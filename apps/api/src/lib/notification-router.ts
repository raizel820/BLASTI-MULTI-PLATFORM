/**
 * BLASTI FCM Push sender (trimmed 0.6.42)
 *
 * This module used to contain a full "smart notification router"
 * (routeNotification → WebSocket / FCM / SMS / WhatsApp with balance
 * deduction and delayed jobs). That router was never wired: the only live
 * path — and the only thing any caller imports — is sendViaPushNotification(),
 * used by routes/queue.ts, routes/cron.ts and workers/notification-worker.ts.
 * The dead router surface (~770 lines) was removed in the 0.6.42 cleanup.
 */

import type { Message, Messaging } from 'firebase-admin/messaging'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'
import { readFileSync } from 'fs'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  userId: string
  reservationId: string
  agencyId: string
  type: string
  message: string
  messageAr?: string
  remainingMinutes?: number
  metadata?: Record<string, unknown>
}

// ─── Firebase Admin (FCM) — Lazy Init ───────────────────────────────────────

/**
 * Module-level Firebase messaging singleton.
 *
 * Credentials come from either (checked in this order):
 *   - FIREBASE_SERVICE_ACCOUNT_JSON  — inline JSON string of the service
 *     account (recommended; e.g. set from a platform secret manager)
 *   - FIREBASE_SERVICE_ACCOUNT_PATH  — path to the service-account JSON file
 *
 * When neither variable is set (or init fails), push is DISABLED gracefully:
 * sendViaPushNotification() logs one clear line and returns false.
 */
let cachedMessaging: Messaging | null = null
let firebaseInitAttempted = false

function getFirebaseMessaging(): Messaging | null {
  if (firebaseInitAttempted) return cachedMessaging
  firebaseInitAttempted = true

  const jsonRaw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim()
  const jsonPath = (process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim()

  if (!jsonRaw && !jsonPath) {
    console.log(
      '[NotificationRouter] Push disabled: FIREBASE_SERVICE_ACCOUNT_JSON not configured'
    )
    return null
  }

  try {
    const serviceAccount: Record<string, unknown> = jsonRaw
      ? JSON.parse(jsonRaw)
      : JSON.parse(readFileSync(jsonPath, 'utf-8'))

    // Reuse an already-initialized app (e.g. after hot reload) instead of
    // re-initializing, which Firebase throws on.
    const existingApps = getApps()
    const app =
      existingApps.length > 0
        ? initializeApp({ credential: cert(serviceAccount) }, existingApps[0].name)
        : initializeApp({ credential: cert(serviceAccount) })

    cachedMessaging = getMessaging(app)
    console.log('[NotificationRouter] Firebase Admin initialized — FCM push enabled')
  } catch (error) {
    console.warn(
      '[NotificationRouter] Firebase Admin init failed — push disabled:',
      error instanceof Error ? error.message : error
    )
    cachedMessaging = null
  }

  return cachedMessaging
}

// ─── FCM Push ───────────────────────────────────────────────────────────────

/**
 * Send a push notification through Firebase Cloud Messaging.
 * Returns false (never throws) so callers can fall back to their next
 * channel without try/catch boilerplate.
 */
export async function sendViaPushNotification(
  fcmToken: string,
  payload: NotificationPayload
): Promise<boolean> {
  try {
    const messaging = getFirebaseMessaging()
    if (!messaging) return false

    const message: Message = {
      token: fcmToken,
      notification: {
        // TURN_CALL gets an immediate "your turn" title (Arabic-first);
        // other types use the app name.
        title:
          payload.type === 'TURN_CALL'
            ? payload.messageAr || 'دورك الآن!'
            : 'BLASTI',
        body: payload.messageAr || payload.message,
      },
      // FCM data payload values MUST all be strings.
      data: {
        type: payload.type,
        reservationId: payload.reservationId ?? '',
        agencyId: payload.agencyId ?? '',
      },
      android: {
        priority: 'high',
        notification: {
          // Matches the notification channel the mobile shell creates
          // for turn alerts (high-importance, alarm sound).
          channelId: 'blasti-turn-alert',
          sound: 'blasti_alarm.wav',
        },
      },
      apns: {
        payload: {
          aps: { sound: 'default' },
        },
      },
    }

    const messageId = await messaging.send(message)

    console.log(
      `[NotificationRouter] FCM Push → token:${fcmToken.substring(0, 8)}… ` +
        `(type: ${payload.type}, msg: "${(payload.messageAr || payload.message).substring(0, 40)}…", messageId: ${messageId})`
    )

    return true
  } catch (error) {
    console.warn(
      `[NotificationRouter] FCM Push delivery failed for token ${fcmToken.substring(0, 8)}…:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}
