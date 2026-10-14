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

/** Which caller triggered the settlement — used for audit-log action naming. */
export type FulfillmentSource = 'webhook' | 'poll' | 'sweep' | 'sweep-expired'

/**
 * Audit-log action for a settlement — keeps the pre-existing webhook/poll
 * action names byte-identical and adds SWEEP variants for Task 2-e's sweeper.
 */
function settlementAuditAction(
  base: 'PAYMENT' | 'SMS_PURCHASE' | 'HARDWARE_ORDER',
  outcome: 'PAID' | 'FAILED',
  source: FulfillmentSource,
): string {
  if (source === 'webhook') return `${base}_WEBHOOK_${outcome}`
  if (source === 'poll') return `${base}_POLL_${outcome === 'PAID' ? 'CONFIRMED' : 'FAILED'}`
  return `${base}_SWEEP_${outcome === 'PAID' ? 'CONFIRMED' : 'FAILED'}`
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

// ─── Paid ─────────────────────────────────────────────────────────────────

/**
 * Task 2-e: best-effort in-app Notification for Transaction settlements.
 *
 * SMS purchases have always notified their buyer on settle/fail — but plain
 * Transaction rows (agency subscriptions, hardware payments) were silent, so
 * the agency only discovered the activation by accident. Creates a bilingual
 * (FR + EN) Notification for the agency OWNER with amount + plan name and
 * mirrors it to the agency's desktops via recordSyncChange (same shape as the
 * SMS purchase notification block).
 */
async function createTransactionSettlementNotification(params: {
  agencyId: string
  ownerId: string
  transactionId: string
  amount: number
  plan: string | null | undefined
  type: string
  paid: boolean
}): Promise<void> {
  const { agencyId, ownerId, transactionId, amount, plan, type, paid } = params
  const isHardware = type === 'HARDWARE'
  const planLabel = plan || (isHardware ? 'Hardware' : 'Subscription')
  const amountLabel = `${amount} DA`

  const title = paid
    ? 'Paiement confirmé — Payment confirmed'
    : 'Paiement échoué — Payment failed'
  const message = paid
    ? isHardware
      ? `Paiement de ${amountLabel} confirmé pour votre commande d'équipement (${planLabel}). / ` +
        `Your payment of ${amountLabel} for your hardware order (${planLabel}) was confirmed.`
      : `Paiement de ${amountLabel} confirmé (plan ${planLabel}) — votre abonnement est désormais actif. / ` +
        `Your payment of ${amountLabel} for the ${planLabel} plan was confirmed and your subscription is now active.`
    : isHardware
      ? `Votre paiement de ${amountLabel} (commande d'équipement) n'a pas abouti — aucun montant n'a été débité. / ` +
        `Your hardware payment of ${amountLabel} did not complete — no amount was charged.`
      : `Votre paiement de ${amountLabel} (plan ${planLabel}) n'a pas abouti — aucun montant n'a été débité. / ` +
        `Your payment of ${amountLabel} for the ${planLabel} plan did not complete — no amount was charged.`

  await db.$transaction(async (tx) => {
    const notif = await tx.notification.create({
      data: {
        userId: ownerId,
        type: paid ? 'PAYMENT_COMPLETED' : 'PAYMENT_FAILED',
        title,
        message,
        entityId: transactionId,
      },
    })
    await recordSyncChange({
      tx,
      agencyId,
      model: 'Notification',
      recordId: notif.id,
      operation: 'create',
    })
  })
}

/**
 * Settle a PAID Chargily checkout: complete the transaction (and activate the
 * subscription when applicable), grant SMS credits, approve hardware orders.
 *
 * @param checkout - The Chargily checkout data (webhook payload, GET result,
 *                   or sweeper probe)
 * @param source   - 'webhook' | 'poll' | 'sweep' | 'sweep-expired' — used for audit logging
 */
export async function fulfillCheckoutPaid(
  checkout: FulfillmentCheckout,
  source: FulfillmentSource = 'webhook',
): Promise<FulfillmentResult> {
  const result: FulfillmentResult = { handled: false }
  const methodSnapshot = mapPaymentMethod(checkout.payment_method)

  // ── 1. Transaction (subscriptions + hardware payments) ──
  const transaction = await db.transaction.findFirst({
    where: { providerRef: checkout.id },
    include: { agency: { select: { id: true, name: true, subscriptionStatus: true, ownerId: true } } },
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
      const { subscriptionExpiresAt: termExpiry } = computeSubscriptionExpiry(
        transaction.planName,
        planRecord?.billingCycle,
      )

      // ── Upgrade / early-renewal stacking (proration counterpart) ──
      // Checkout creation does NOT touch subscriptionExpiresAt, so at
      // settlement time it still holds the CURRENT window's expiry. When
      // that window is still active, the purchased term STACKS on top of it
      // (remaining days preserved — the agency paid for them). An expired
      // window behaves exactly as before (term starts now).
      const current = await db.agency.findUnique({
        where: { id: transaction.agencyId },
        select: { subscriptionStartsAt: true, subscriptionExpiresAt: true },
      })
      const now = new Date()
      const stillActive = !!current?.subscriptionExpiresAt && current.subscriptionExpiresAt.getTime() > now.getTime()
      const base = stillActive ? (current.subscriptionExpiresAt as Date) : now

      let subscriptionExpiresAt: Date | null = termExpiry
      if (termExpiry && stillActive) {
        const stacked = new Date(base)
        stacked.setTime(stacked.getTime() + (termExpiry.getTime() - now.getTime()))
        subscriptionExpiresAt = stacked
      }

      await db.agency.update({
        where: { id: transaction.agencyId },
        data: {
          subscriptionStatus: 'ACTIVE',
          subscriptionTier: transaction.plan,
          subscriptionPlanId: planRecord?.id || undefined,
          subscriptionStartsAt: stillActive ? (current?.subscriptionStartsAt ?? now) : now,
          subscriptionExpiresAt,
        },
      })
    }

    await db.auditLog.create({
      data: {
        action: settlementAuditAction('PAYMENT', 'PAID', source),
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

    // Task 2-e: notify the agency owner (best-effort — never fail settlement).
    try {
      await createTransactionSettlementNotification({
        agencyId: transaction.agencyId,
        ownerId: transaction.agency.ownerId,
        transactionId: transaction.id,
        amount: transaction.amount,
        plan: transaction.planName || transaction.plan,
        type: transaction.type,
        paid: true,
      })
    } catch (err) {
      console.warn('[chargily-fulfill] Failed to create payment-completed notification:', err)
    }

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
          action: settlementAuditAction('SMS_PURCHASE', 'PAID', source),
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
          action: settlementAuditAction('HARDWARE_ORDER', 'PAID', source),
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
  source: FulfillmentSource = 'webhook',
): Promise<FulfillmentResult> {
  const result: FulfillmentResult = { handled: false }

  const transaction = await db.transaction.findFirst({
    where: { providerRef: checkout.id },
    include: { agency: { select: { id: true, subscriptionStatus: true, ownerId: true } } },
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
          action: settlementAuditAction('PAYMENT', 'FAILED', source),
          entityType: 'TRANSACTION',
          entityId: transaction.id,
          details: JSON.stringify({ checkoutId: checkout.id, agencyId: transaction.agencyId, source }),
        },
      })

      // Task 2-e: notify the agency owner (best-effort — never fail settlement).
      try {
        await createTransactionSettlementNotification({
          agencyId: transaction.agencyId,
          ownerId: transaction.agency.ownerId,
          transactionId: transaction.id,
          amount: transaction.amount,
          plan: transaction.planName || transaction.plan,
          type: transaction.type,
          paid: false,
        })
      } catch (err) {
        console.warn('[chargily-fulfill] Failed to create payment-failed notification:', err)
      }

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
          action: settlementAuditAction('SMS_PURCHASE', 'FAILED', source),
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
