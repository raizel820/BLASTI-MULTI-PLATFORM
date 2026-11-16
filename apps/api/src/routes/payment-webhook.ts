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
import { appendTxEvent } from '../lib/tx-log'

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
      appendTxEvent({
        stage: 'webhook_rejected',
        message: 'Chargily webhook rejected — missing signature header',
        level: 'warn',
      })
      return c.json({ success: false, error: 'Missing signature' }, 400)
    }

    // Verify the webhook signature
    let isValid: boolean
    try {
      isValid = await verifyWebhookSignature(rawBody, signature)
    } catch (err) {
      console.error('[payment-webhook] Signature verification error:', err)
      appendTxEvent({
        stage: 'webhook_rejected',
        message: 'Chargily webhook rejected — signature verification threw',
        level: 'warn',
        data: { error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
        identity: { role: 'SERVER' },
      })
      return c.json({ success: false, error: 'Signature verification failed' }, 500)
    }

    if (!isValid) {
      console.warn('[payment-webhook] Invalid webhook signature')
      appendTxEvent({
        stage: 'webhook_rejected',
        message: 'Chargily webhook rejected — invalid HMAC signature',
        level: 'warn',
      })
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

    // 0.6.81 — the gateway just spoke: land the push in the transaction
    // stream the moment it arrives (settlement events follow from the
    // shared fulfillment library).
    appendTxEvent({
      stage: 'webhook_received',
      message: `Chargily webhook: ${type} for checkout ${data.id}`,
      level: type === 'checkout.paid' ? 'info' : type === 'checkout.failed' ? 'warn' : 'info',
      data: { eventType: type, gatewayStatus: data.status, paymentMethod: data.payment_method },
      checkoutId: data.id,
      identity: { role: 'SERVER' },
    })

    // Process based on event type — shared idempotent fulfillment.
    // PRODUCTION FIX (tx-stream error-path coverage): a throw INSIDE the
    // fulfillment (the db.$transaction settlement blocks) propagated straight
    // to the outer catch — a crash mid-settlement was completely invisible in
    // the transaction stream (no settle_failed, no webhook event at all after
    // webhook_received). Both fulfill legs are now guarded: the exception is
    // recorded as settle_failed with the error message, and the webhook still
    // returns 500 so Chargily retries the delivery (same as before).
    if (type === 'checkout.paid') {
      let result: Awaited<ReturnType<typeof fulfillCheckoutPaid>>
      try {
        result = await fulfillCheckoutPaid(
          {
            id: data.id,
            status: data.status,
            amount: data.amount,
            payment_method: data.payment_method,
            metadata: data.metadata,
          },
          'webhook',
        )
      } catch (fulfillErr) {
        console.error('[payment-webhook] fulfillCheckoutPaid threw:', fulfillErr)
        appendTxEvent({
          stage: 'settle_failed',
          message: `Settlement CRASHED while fulfilling checkout.paid — ${fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr)}`,
          level: 'error',
          checkoutId: data.id,
          identity: { role: 'SERVER' },
          data: { source: 'webhook', eventType: type, error: fulfillErr instanceof Error ? fulfillErr.message.slice(0, 300) : String(fulfillErr).slice(0, 300) },
        })
        throw fulfillErr
      }
      if (!result.handled) {
        console.warn(`[payment-webhook] No local records for checkout ${data.id} (ignored)`)
      }
    } else if (type === 'checkout.failed') {
      let result: Awaited<ReturnType<typeof fulfillCheckoutFailed>>
      try {
        result = await fulfillCheckoutFailed(
          {
            id: data.id,
            status: data.status,
            amount: data.amount,
            payment_method: data.payment_method,
            metadata: data.metadata,
          },
          'webhook',
        )
      } catch (fulfillErr) {
        console.error('[payment-webhook] fulfillCheckoutFailed threw:', fulfillErr)
        appendTxEvent({
          stage: 'settle_failed',
          message: `Settlement CRASHED while fulfilling checkout.failed — ${fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr)}`,
          level: 'error',
          checkoutId: data.id,
          identity: { role: 'SERVER' },
          data: { source: 'webhook', eventType: type, error: fulfillErr instanceof Error ? fulfillErr.message.slice(0, 300) : String(fulfillErr).slice(0, 300) },
        })
        throw fulfillErr
      }
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
