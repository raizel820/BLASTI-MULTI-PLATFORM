/**
 * @blasti/api — Chargily Payment Fulfillment
 *
 * Shared, idempotent fulfillment logic for Chargily checkout events.
 * Used by BOTH:
 *   - the webhook route (POST /api/payment/webhook — signed push from Chargily)
 *   - the status polling route (GET /api/payment/checkout/:id — pull fallback
 *     that runs when the user returns from the hosted checkout page; this
 *     makes the system work even when the webhook URL is not configured in
 *     the Chargily dashboard, so the super admin only needs to enter keys)
 *
 * Handles ALL payment surfaces:
 *   - Subscriptions  (Transaction type=SUBSCRIPTION → agency activation + expiry)
 *   - SMS packs      (SmsPurchase → atomic credit grant, mirrors /api/sms/approve)
 *   - Hardware/device orders (HardwareOrder → APPROVED; payment confirmed)
 *
 * Matching is done via providerRef (the Chargily checkout ID) on each table,
 * so one checkout can settle several records at once (e.g. a subscription
 * payment that also includes pending hardware orders).
 *
 * All state transitions are guarded by status==='PENDING' checks (idempotent —
 * replayed webhooks and racing polls converge to the same result).
 */

import { db } from '@blasti/db'
import { recordSyncChange, resolveAgencyIdForUser } from './sync-helpers'

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal checkout payload shape needed for fulfillment (from webhook data or GET /checkouts/:id). */
export interface FulfillmentCheckout {
  id: string
  status: string
  amount: number
  payment_method?: string | null
  metadata?: Record<string, string> | null
}

export interface FulfillmentResult {
  handled: boolean
  /** Which records were settled by this call. */
  transactionId?: string
  smsPurchaseId?: string
  hardwareOrderIds?: string[]
  agencyId?: string
  smsCreditsGranted?: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map Chargily payment method to the internal paymentMethod enum value. */
function mapPaymentMethod(chargilyMethod: string | null | undefined): string | undefined {
  if (!chargilyMethod) return undefined
  const m = chargilyMethod.toLowerCase()
  if (m === 'edahabia') return 'EDAHABIA'
  if (m === 'cib') return 'CIB'
  if (m === 'chargily_app') return 'EDAHABIA'
  return undefined
}

/**
 * Compute the subscription expiry for a paid transaction — identical to the
 * admin manual-approval logic (agency.ts POST /admin/transactions/:id):
 *   - period is recovered from the planName snapshot "(Nm)" suffix
 *   - period > 1  → now + period months
 *   - else plan's billingCycle: MONTHLY +30d, YEARLY +365d, ONE_TIME null
 */
function computeSubscriptionExpiry(
  planName: string | null | undefined,
  billingCycle: string | null | undefined,
): { subscriptionExpiresAt: Date | null } {
  const periodMatch = planName?.match(/\((\d+)m\)$/)
  const period = periodMatch ? parseInt(periodMatch[1], 10) : 1
  const now = new Date()

  if (period > 1) {
    const expiresAt = new Date(now)
    expiresAt.setMonth(expiresAt.getMonth() + period)
    return { subscriptionExpiresAt: expiresAt }
  }

  switch (billingCycle) {
    case 'YEARLY': {
      const expiresAt = new Date(now)
      expiresAt.setDate(expiresAt.getDate() + 365)
      return { subscriptionExpiresAt: expiresAt }
    }
    case 'ONE_TIME':
      return { subscriptionExpiresAt: null }
    case 'MONTHLY':
    default: {
      const expiresAt = new Date(now)
      expiresAt.setDate(expiresAt.getDate() + 30)
      return { subscriptionExpiresAt: expiresAt }
    }
  }
}

/** Best-effort realtime emit (never throws). Payment events are routed by
 * the API's broadcastEvent to agency:{agencyId} and/or customer:{userId}. */
async function emitPaymentEvent(
  eventName: 'payment:completed' | 'payment:failed',
  payload: Record<string, unknown>,
) {
  try {
    await fetch(`http://127.0.0.1:${process.env.API_PORT || '3003'}/emit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.INTERNAL_SECRET || '',
      },
      body: JSON.stringify({ type: eventName, ...payload }),
    })
  } catch (err) {
    console.warn('[chargily-fulfill] Failed to emit real-time event:', err)
  }
}

// ─── Paid ───────────────────────────────────────────────────────────────────

/**
 * Settle a PAID Chargily checkout: complete the transaction (and activate the
 * subscription when applicable), grant SMS credits, approve hardware orders.
 *
 * @param checkout - The Chargily checkout data (webhook payload or GET result)
 * @param source   - 'webhook' | 'poll' — used for audit logging
 */
export async function fulfillCheckoutPaid(
  checkout: FulfillmentCheckout,
  source: 'webhook' | 'poll' = 'webhook',
): Promise<FulfillmentResult> {
  const result: FulfillmentResult = { handled: false }
  const methodSnapshot = mapPaymentMethod(checkout.payment_method)

  // ── 1. Transaction (subscriptions + hardware payments) ──
  const transaction = await db.transaction.findFirst({
    where: { providerRef: checkout.id },
    include: { agency: { select: { id: true, name: true, subscriptionStatus: true } } },
  })

  if (transaction && transaction.status === 'PENDING') {
    await db.transaction.update({
      where: { id: transaction.id },
      data: {
        status: 'COMPLETED',
        webhookVerified: true,
        reviewedAt: new Date(),
        amountPaid: transaction.amount,
        ...(methodSnapshot ? { paymentMethod: methodSnapshot } : {}),
        version: { increment: 1 },
      },
    })
    result.transactionId = transaction.id
    result.agencyId = transaction.agencyId
    result.handled = true

    // Subscription activation — only for SUBSCRIPTION-type transactions
    // (HARDWARE transactions just complete; the linked order is approved below).
    if (transaction.type !== 'HARDWARE') {
      const planRecord = await db.subscriptionPlan.findFirst({
        where: { name: transaction.plan, isActive: true },
      })
      const { subscriptionExpiresAt } = computeSubscriptionExpiry(
        transaction.planName,
        planRecord?.billingCycle,
      )
      await db.agency.update({
        where: { id: transaction.agencyId },
        data: {
          subscriptionStatus: 'ACTIVE',
          subscriptionTier: transaction.plan,
          subscriptionPlanId: planRecord?.id || undefined,
          subscriptionStartsAt: new Date(),
          subscriptionExpiresAt,
        },
      })
    }

    await db.auditLog.create({
      data: {
        action: source === 'webhook' ? 'PAYMENT_WEBHOOK_PAID' : 'PAYMENT_POLL_CONFIRMED',
        entityType: 'TRANSACTION',
        entityId: transaction.id,
        details: JSON.stringify({
          checkoutId: checkout.id,
          amount: checkout.amount,
          paymentMethod: checkout.payment_method,
          agencyId: transaction.agencyId,
          type: transaction.type,
          source,
        }),
      },
    })

    await emitPaymentEvent('payment:completed', {
      agencyId: transaction.agencyId,
      data: {
        transactionId: transaction.id,
        amount: transaction.amount,
        plan: transaction.plan,
        type: transaction.type,
      },
    })
  } else if (transaction) {
    // Already settled — still count as handled so callers can report state.
    result.transactionId = transaction.id
    result.agencyId = transaction.agencyId
    result.handled = true
  }

  // ── 2. SMS purchase (customer credit packs) ──
  const smsPurchase = await db.smsPurchase.findFirst({
    where: { providerRef: checkout.id },
  })

  if (smsPurchase) {
    result.smsPurchaseId = smsPurchase.id
    result.handled = true

    if (smsPurchase.status === 'PENDING') {
      // Atomic grant — mirrors POST /api/sms/approve/:id exactly
      // (update purchase + increment user credits + notification + sync change).
      const userAgencyId = await resolveAgencyIdForUser(smsPurchase.userId)
      await db.$transaction(async (tx) => {
        await tx.smsPurchase.update({
          where: { id: smsPurchase.id },
          data: {
            status: 'APPROVED',
            webhookVerified: true,
            ...(methodSnapshot ? { paymentMethod: methodSnapshot } : {}),
          },
        })

        await tx.user.update({
          where: { id: smsPurchase.userId },
          data: { freeSmsCount: { increment: smsPurchase.quantity } },
        })
        if (userAgencyId) {
          await recordSyncChange({
            tx,
            agencyId: userAgencyId,
            model: 'User',
            recordId: smsPurchase.userId,
            operation: 'update',
          })
        }

        const notif = await tx.notification.create({
          data: {
            userId: smsPurchase.userId,
            type: 'SMS_PURCHASED',
            title: 'SMS Credits Added',
            message: `Your purchase of ${smsPurchase.quantity} SMS credits was confirmed by Chargily and added to your account.`,
          },
        })
        if (userAgencyId) {
          await recordSyncChange({
            tx,
            agencyId: userAgencyId,
            model: 'Notification',
            recordId: notif.id,
            operation: 'create',
          })
        }
      })

      result.smsCreditsGranted = smsPurchase.quantity

      await emitPaymentEvent('payment:completed', {
        userId: smsPurchase.userId,
        data: {
          smsPurchaseId: smsPurchase.id,
          quantity: smsPurchase.quantity,
          type: 'sms',
        },
      })

      await db.auditLog.create({
        data: {
          action: source === 'webhook' ? 'SMS_PURCHASE_WEBHOOK_PAID' : 'SMS_PURCHASE_POLL_CONFIRMED',
          entityType: 'SMS_PURCHASE',
          entityId: smsPurchase.id,
          details: JSON.stringify({
            checkoutId: checkout.id,
            userId: smsPurchase.userId,
            quantity: smsPurchase.quantity,
            source,
          }),
        },
      })
    }
  }

  // ── 3. Hardware / device orders ──
  const hardwareOrders = await db.hardwareOrder.findMany({
    where: { providerRef: checkout.id },
  })

  if (hardwareOrders.length > 0) {
    result.handled = true
    result.hardwareOrderIds = []

    for (const order of hardwareOrders) {
      result.hardwareOrderIds.push(order.id)
      if (order.status !== 'PENDING') continue

      await db.hardwareOrder.update({
        where: { id: order.id },
        data: {
          status: 'APPROVED', // payment confirmed — physical fulfilment stays manual
          webhookVerified: true,
        },
      })

      await db.auditLog.create({
        data: {
          action: source === 'webhook' ? 'HARDWARE_ORDER_WEBHOOK_PAID' : 'HARDWARE_ORDER_POLL_CONFIRMED',
          entityType: 'HARDWARE_ORDER',
          entityId: order.id,
          details: JSON.stringify({
            checkoutId: checkout.id,
            agencyId: order.agencyId,
            upfrontTotal: order.upfrontTotal,
            source,
          }),
        },
      })

      await emitPaymentEvent('payment:completed', {
        agencyId: order.agencyId,
        data: {
          hardwareOrderId: order.id,
          amount: order.upfrontTotal,
          type: 'hardware',
        },
      })
    }
  }

  return result
}

// ─── Failed ─────────────────────────────────────────────────────────────────

/**
 * Settle a FAILED/CANCELED Chargily checkout.
 *
 * - Transaction  → FAILED
 * - Agency       → only demoted from PENDING back to INACTIVE (an agency that
 *                  was ACTIVE before attempting a renewal stays ACTIVE)
 * - SmsPurchase  → FAILED (credits were never granted)
 * - HardwareOrder → stays PENDING so the customer can retry the payment
 */
export async function fulfillCheckoutFailed(
  checkout: FulfillmentCheckout,
  source: 'webhook' | 'poll' = 'webhook',
): Promise<FulfillmentResult> {
  const result: FulfillmentResult = { handled: false }

  const transaction = await db.transaction.findFirst({
    where: { providerRef: checkout.id },
    include: { agency: { select: { id: true, subscriptionStatus: true } } },
  })

  if (transaction) {
    result.transactionId = transaction.id
    result.agencyId = transaction.agencyId
    result.handled = true

    if (transaction.status === 'PENDING') {
      await db.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          webhookVerified: true,
          rejectionReason: 'Chargily checkout failed or was canceled',
          version: { increment: 1 },
        },
      })

      // Only demote agencies that were flipped to PENDING by the checkout
      // creation — never downgrade an already-ACTIVE subscription.
      if (transaction.agency.subscriptionStatus === 'PENDING') {
        await db.agency.update({
          where: { id: transaction.agencyId },
          data: { subscriptionStatus: 'INACTIVE' },
        })
      }

      await db.auditLog.create({
        data: {
          action: source === 'webhook' ? 'PAYMENT_WEBHOOK_FAILED' : 'PAYMENT_POLL_FAILED',
          entityType: 'TRANSACTION',
          entityId: transaction.id,
          details: JSON.stringify({ checkoutId: checkout.id, agencyId: transaction.agencyId, source }),
        },
      })

      await emitPaymentEvent('payment:failed', {
        agencyId: transaction.agencyId,
        data: {
          transactionId: transaction.id,
          amount: transaction.amount,
          plan: transaction.plan,
        },
      })
    }
  }

  const smsPurchase = await db.smsPurchase.findFirst({
    where: { providerRef: checkout.id },
  })

  if (smsPurchase) {
    result.smsPurchaseId = smsPurchase.id
    result.handled = true

    if (smsPurchase.status === 'PENDING') {
      await db.smsPurchase.update({
        where: { id: smsPurchase.id },
        data: {
          status: 'FAILED',
          webhookVerified: true,
        },
      })

      await db.notification.create({
        data: {
          userId: smsPurchase.userId,
          type: 'SMS_PURCHASE_FAILED',
          title: 'SMS Purchase Failed',
          message: `Your payment of ${smsPurchase.price} DA for ${smsPurchase.quantity} SMS credits was not completed. No charges were made.`,
        },
      })

      await db.auditLog.create({
        data: {
          action: 'SMS_PURCHASE_WEBHOOK_FAILED',
          entityType: 'SMS_PURCHASE',
          entityId: smsPurchase.id,
          details: JSON.stringify({ checkoutId: checkout.id, userId: smsPurchase.userId, source }),
        },
      })
    }
  }

  // Hardware orders intentionally stay PENDING — the customer can retry
  // payment (new checkout) or fall back to manual admin approval.

  return result
}

// ─── Status normalization ───────────────────────────────────────────────────

/**
 * Normalize a Chargily checkout status ('pending' | 'processing' | 'paid' |
 * 'failed' | 'canceled') into the three-way lifecycle used by clients.
 */
export function normalizeChargilyStatus(status: string): 'pending' | 'paid' | 'failed' {
  const s = (status || '').toLowerCase()
  if (s === 'paid') return 'paid'
  if (s === 'failed' || s === 'canceled' || s === 'expired') return 'failed'
  return 'pending' // pending | processing
}
