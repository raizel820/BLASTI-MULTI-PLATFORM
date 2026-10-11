/**
 * @blasti/api — Chargily Webhook Route
 *
 * Receives and processes webhook events from Chargily Pay (EDAHABIA / CIB).
 * Verifies the HMAC-SHA256 signature, then settles ALL payment surfaces via
 * the shared fulfillment library (chargily-fulfill.ts):
 *
 *   Subscriptions  — Transaction COMPLETED + agency activated with expiry
 *   SMS packs      — SmsPurchase APPROVED + credits granted atomically
 *   Hardware orders — HardwareOrder APPROVED (payment confirmed)
 *
 * The webhook is the PRIMARY confirmation channel; the status-polling route
 * (GET /api/payment/checkout/:id) runs the exact same fulfillment logic as a
 * fallback, so payments complete even when the webhook URL is not configured
 * in the Chargily dashboard (super admin only needs to enter the API keys).
 *
 * Supported events:
 *   checkout.paid   — payment confirmed
 *   checkout.failed — payment failed / canceled
 *
 * Route:
 *   POST /api/payment/webhook
 *
 * Docs: https://dev.chargily.com/pay-v2/webhooks
 */

import { Hono } from 'hono'
import { verifyWebhookSignature, type ChargilyWebhookEvent } from '../lib/chargily-service'
import { fulfillCheckoutPaid, fulfillCheckoutFailed } from '../lib/chargily-fulfill'

const app = new Hono()

// POST / — Process Chargily webhook
app.post('/', async (c) => {
  try {
    // Read the raw body for signature verification (HMAC is computed over
    // the exact bytes — never over a re-serialized JSON object).
    const rawBody = await c.req.text()
    // Chargily sends the header as `signature` (HTTP headers are
    // case-insensitive; Hono's header() lookup handles that).
    const signature = c.req.header('signature') || c.req.header('Signature')

    if (!signature) {
      console.warn('[payment-webhook] Missing signature header')
      return c.json({ success: false, error: 'Missing signature' }, 400)
    }

    // Verify the webhook signature
    let isValid: boolean
    try {
      isValid = await verifyWebhookSignature(rawBody, signature)
    } catch (err) {
      console.error('[payment-webhook] Signature verification error:', err)
      return c.json({ success: false, error: 'Signature verification failed' }, 500)
    }

    if (!isValid) {
      console.warn('[payment-webhook] Invalid webhook signature')
      return c.json({ success: false, error: 'Invalid signature' }, 401)
    }

    // Parse the event payload
    let event: ChargilyWebhookEvent
    try {
      event = JSON.parse(rawBody)
    } catch {
      console.warn('[payment-webhook] Invalid JSON payload')
      return c.json({ success: false, error: 'Invalid JSON' }, 400)
    }

    const { type, data } = event

    console.log(`[payment-webhook] Received event: ${type}, checkout: ${data?.id}`)

    if (!data?.id) {
      return c.json({ success: true, message: 'No checkout id (ignored)' })
    }

    // Process based on event type — shared idempotent fulfillment.
    if (type === 'checkout.paid') {
      const result = await fulfillCheckoutPaid(
        {
          id: data.id,
          status: data.status,
          amount: data.amount,
          payment_method: data.payment_method,
          metadata: data.metadata,
        },
        'webhook',
      )
      if (!result.handled) {
        console.warn(`[payment-webhook] No local records for checkout ${data.id} (ignored)`)
      }
    } else if (type === 'checkout.failed') {
      const result = await fulfillCheckoutFailed(
        {
          id: data.id,
          status: data.status,
          amount: data.amount,
          payment_method: data.payment_method,
          metadata: data.metadata,
        },
        'webhook',
      )
      if (!result.handled) {
        console.warn(`[payment-webhook] No local records for checkout ${data.id} (ignored)`)
      }
    } else {
      console.log(`[payment-webhook] Unhandled event type: ${type}`)
    }

    // Always 200 once the signature is valid — stops Chargily retries for
    // events we have nothing to settle (e.g. webhooks for other apps).
    return c.json({ success: true })
  } catch (error) {
    console.error('[payment-webhook] Error processing webhook:', error)
    return c.json({ success: false, error: 'Webhook processing failed' }, 500)
  }
})

export const paymentWebhookRoutes = app
