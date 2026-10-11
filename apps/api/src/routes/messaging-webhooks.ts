/**
 * @blasti/api — Messaging Provider Webhooks (Task 3)
 *
 * Public, SELF-VERIFIED endpoints where the messaging providers push
 * delivery reports. Mounted at /api/webhooks (no session auth — each
 * provider's signature/verify-token mechanism is the authentication):
 *
 *   POST /api/webhooks/esms      — eSMS Africa DLR (X-Webhook-Signature,
 *                                  HMAC-SHA256 over the raw body with the
 *                                  stored webhookSigningSecret; enforced
 *                                  only when a secret is configured)
 *   GET  /api/webhooks/whatsapp  — Meta subscription handshake
 *                                  (hub.challenge echoed back when
 *                                  hub.verify_token === webhookVerifyToken)
 *   POST /api/webhooks/whatsapp  — Meta status events (sent/delivered/read/
 *                                  failed), optionally signature-verified
 *                                  against metaAppSecret (X-Hub-Signature-256)
 *
 * Correlation: SmsLog.providerMessageId (the provider's message id returned
 * by every send path). Status machine is FORWARD-ONLY:
 *   PENDING → SENT → DELIVERED → READ
 * FAILED is terminal and unreachable once DELIVERED/READ — a late failure
 * webhook can never downgrade a confirmed delivery.
 */

import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@blasti/db'
import { getProviderConfig } from '../lib/messaging/provider-config'

const app = new Hono()

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Forward-only rank of SmsLog delivery statuses. */
const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
}

/**
 * Compute the next status for a log row. Returns null when the update must
 * be ignored (backward/ repeated / illegal transition) — keeps DLR replays
 * and racing webhooks idempotent.
 */
function nextDeliveryStatus(current: string, incoming: string): string | null {
  const incomingUpper = incoming.toUpperCase()
  if (incomingUpper === 'FAILED') {
    // FAILED is terminal — and unreachable once confirmed delivered/read
    if (current === 'DELIVERED' || current === 'READ' || current === 'FAILED') return null
    return 'FAILED'
  }
  const nextRank = STATUS_RANK[incomingUpper]
  if (nextRank === undefined) return null
  const currentRank = STATUS_RANK[current] ?? 0
  if (nextRank <= currentRank) return null
  return incomingUpper
}

/** Timing-safe hex HMAC comparison. */
function verifyHmac(rawBody: string, secret: string, received: string | undefined): boolean {
  if (!received) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (received.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

/** Normalize an eSMS/Meta delivery status onto the local status vocabulary. */
function normalizeProviderStatus(status: string | undefined): string {
  const s = (status || '').toLowerCase()
  if (s === 'delivered') return 'DELIVERED'
  if (s === 'read') return 'READ'
  if (s === 'failed' || s === 'undelivered' || s === 'rejected' || s === 'expired' || s === 'canceled') return 'FAILED'
  if (s === 'sent' || s === 'submitted' || s === 'scheduled' || s === 'accepted' || s === 'sending') return 'SENT'
  return ''
}

// ─── POST /esms — eSMS Africa delivery reports ──────────────────────────────

app.post('/esms', async (c) => {
  const rawBody = await c.req.text()

  // Signature enforcement — only when the admin stored a signing secret.
  const cfg = await getProviderConfig('SMS')
  const signingSecret = cfg?.extra?.webhookSigningSecret
  if (signingSecret) {
    const signature =
      c.req.header('X-Webhook-Signature') || c.req.header('x-webhook-signature') || ''
    if (!verifyHmac(rawBody, signingSecret, signature)) {
      return c.json({ success: false, error: 'Invalid webhook signature' }, 401)
    }
  }

  let event: {
    id?: string
    message_id?: string
    messageId?: string
    status?: string
    to?: string
    error?: { message?: string } | string
    errorMessage?: string
  }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  const providerMessageId = event.id || event.message_id || event.messageId
  const providerStatus = normalizeProviderStatus(event.status)
  if (!providerMessageId || !providerStatus) {
    // Not a delivery report we can correlate — acknowledge so retries stop
    return c.json({ success: true, ignored: true })
  }

  const log = await db.smsLog.findFirst({ where: { providerMessageId } })
  if (!log) return c.json({ success: true, ignored: true, reason: 'unknown message id' })

  const next = nextDeliveryStatus(log.status, providerStatus)
  if (!next) return c.json({ success: true, ignored: true, reason: `no forward move from ${log.status}` })

  const errorMessage =
    next === 'FAILED'
      ? typeof event.error === 'string'
        ? event.error.slice(0, 400)
        : event.error?.message?.slice(0, 400) ?? event.errorMessage?.slice(0, 400) ?? 'Provider reported failure'
      : undefined

  await db.smsLog.update({
    where: { id: log.id },
    data: { status: next, ...(errorMessage !== undefined ? { errorMessage } : {}) },
  })

  return c.json({ success: true, status: next })
})

// ─── GET /whatsapp — Meta subscription handshake ────────────────────────────

app.get('/whatsapp', async (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode !== 'subscribe' || !token || !challenge) {
    return c.json({ success: false, error: 'Expected hub.mode, hub.verify_token and hub.challenge' }, 400)
  }

  const cfg = await getProviderConfig('WHATSAPP')
  const verifyToken = cfg?.extra?.webhookVerifyToken
  if (!verifyToken || token !== verifyToken) {
    return c.json({ success: false, error: 'Verification token mismatch' }, 403)
  }

  // Meta expects the RAW challenge as text/plain
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
})

// ─── POST /whatsapp — Meta status events ────────────────────────────────────

app.post('/whatsapp', async (c) => {
  const rawBody = await c.req.text()

  // Optional payload signature (X-Hub-Signature-256) — enforced when a Meta
  // App Secret is configured. SHA-256 = '<hex>' digest form.
  const waCfg = await getProviderConfig('WHATSAPP')
  const appSecret = waCfg?.extra?.metaAppSecret
  if (appSecret) {
    const received = (c.req.header('X-Hub-Signature-256') || '').replace(/^sha256=/i, '')
    if (!verifyHmac(rawBody, appSecret, received)) {
      return c.json({ success: false, error: 'Invalid webhook signature' }, 401)
    }
  }

  let event: {
    object?: string
    entry?: Array<{
      changes?: Array<{
        value?: {
          statuses?: Array<{ id?: string; status?: string; recipient_id?: string; errors?: Array<{ message?: string; title?: string }> }>
        }
      }>
    }>
  }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }

  let advanced = 0
  const statuses = (event.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((ch) => ch.value?.statuses ?? [])

  for (const st of statuses) {
    if (!st.id) continue
    const providerStatus = normalizeProviderStatus(st.status)
    if (!providerStatus) continue

    const log = await db.smsLog.findFirst({ where: { providerMessageId: st.id } })
    if (!log) continue

    const next = nextDeliveryStatus(log.status, providerStatus)
    if (!next) continue

    const errorMessage =
      next === 'FAILED'
        ? st.errors?.[0]?.message?.slice(0, 400) ?? st.errors?.[0]?.title?.slice(0, 400) ?? 'Provider reported failure'
        : undefined

    await db.smsLog.update({
      where: { id: log.id },
      data: { status: next, ...(errorMessage !== undefined ? { errorMessage } : {}) },
    })
    advanced++
  }

  // Meta requires a fast 200 for ANY accepted payload — unknown ids are
  // silently acknowledged so the subscription is never disabled.
  return c.json({ success: true, updated: advanced })
})

export const messagingWebhookRoutes = app
