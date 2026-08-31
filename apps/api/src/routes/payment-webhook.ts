/**
 * @blasti/api — Chargily Webhook Route
 *
 * Receives and processes webhook events from Chargily payment gateway.
 * Verifies the HMAC-SHA256 signature, then updates the corresponding
 * Transaction record and emits real-time notifications.
 *
 * Supported events:
 *   checkout.paid   — Transaction marked as COMPLETED, agency subscription activated
 *   checkout.failed — Transaction marked as FAILED
 *
 * Route:
 *   POST /api/payment/webhook
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { verifyWebhookSignature, type ChargilyWebhookEvent } from '../lib/chargily-service'

const app = new Hono()

// POST / — Process Chargily webhook
app.post('/', async (c) => {
  try {
    // Read the raw body for signature verification
    const rawBody = await c.req.text()
    const signature = c.req.header('Signature')

    if (!signature) {
      console.warn('[payment-webhook] Missing Signature header')
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

    console.log(`[payment-webhook] Received event: ${type}, checkout: ${data.id}`)

    // Find the transaction by provider reference (Chargily checkout ID)
    const transaction = await db.transaction.findFirst({
      where: { providerRef: data.id },
    })

    if (!transaction) {
      console.warn(`[payment-webhook] No transaction found for checkout ID: ${data.id}`)
      // Return 200 so Chargily doesn't retry indefinitely
      return c.json({ success: true, message: 'No matching transaction (ignored)' })
    }

    // Process based on event type
    if (type === 'checkout.paid') {
      // Mark transaction as completed
      await db.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'COMPLETED',
          webhookVerified: true,
          reviewedAt: new Date(),
        },
      })

      // Activate the agency subscription
      await db.agency.update({
        where: { id: transaction.agencyId },
        data: {
          subscriptionStatus: 'ACTIVE',
          subscriptionTier: transaction.plan,
        },
      })

      // Create audit log
      await db.auditLog.create({
        data: {
          action: 'PAYMENT_WEBHOOK_PAID',
          entityType: 'TRANSACTION',
          entityId: transaction.id,
          details: JSON.stringify({
            checkoutId: data.id,
            amount: data.amount,
            paymentMethod: data.payment_method,
            agencyId: transaction.agencyId,
          }),
        },
      })

      console.log(`[payment-webhook] Transaction ${transaction.id} marked as COMPLETED`)

      // Emit real-time notification to the agency room
      try {
        await fetch(`http://127.0.0.1:3003/emit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env.INTERNAL_SECRET || '',
          },
          body: JSON.stringify({
            room: `agency:${transaction.agencyId}`,
            event: 'payment:completed',
            data: {
              transactionId: transaction.id,
              amount: transaction.amount,
              plan: transaction.plan,
            },
          }),
        })
      } catch (emitErr) {
        console.warn('[payment-webhook] Failed to emit real-time event:', emitErr)
      }

    } else if (type === 'checkout.failed') {
      // Mark transaction as failed
      await db.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          webhookVerified: true,
          rejectionReason: 'Chargily checkout failed',
        },
      })

      // Update agency subscription status
      await db.agency.update({
        where: { id: transaction.agencyId },
        data: { subscriptionStatus: 'INACTIVE' },
      })

      // Create audit log
      await db.auditLog.create({
        data: {
          action: 'PAYMENT_WEBHOOK_FAILED',
          entityType: 'TRANSACTION',
          entityId: transaction.id,
          details: JSON.stringify({
            checkoutId: data.id,
            agencyId: transaction.agencyId,
          }),
        },
      })

      console.log(`[payment-webhook] Transaction ${transaction.id} marked as FAILED`)

      // Emit real-time notification
      try {
        await fetch(`http://127.0.0.1:3003/emit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env.INTERNAL_SECRET || '',
          },
          body: JSON.stringify({
            room: `agency:${transaction.agencyId}`,
            event: 'payment:failed',
            data: {
              transactionId: transaction.id,
              amount: transaction.amount,
              plan: transaction.plan,
            },
          }),
        })
      } catch (emitErr) {
        console.warn('[payment-webhook] Failed to emit real-time event:', emitErr)
      }

    } else {
      console.log(`[payment-webhook] Unhandled event type: ${type}`)
    }

    return c.json({ success: true })

  } catch (error) {
    console.error('[payment-webhook] Error processing webhook:', error)
    return c.json({ success: false, error: 'Webhook processing failed' }, 500)
  }
})

export const paymentWebhookRoutes = app
