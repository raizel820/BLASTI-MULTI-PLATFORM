/**
 * @blasti/api — Payment Checkout Route (Chargily Pay v2)
 *
 * Unified Chargily checkout creation for ALL payment surfaces:
 *   - Subscriptions      (agency plan + billing period, incl. period discounts)
 *   - SMS credit packs   (customer wallet top-ups)
 *   - Hardware orders    (devices: TV / PC / KIOSK / PRINTER, UPFRONT model)
 *
 * Routes:
 *   POST /api/payment/create-checkout  — Create a Chargily checkout session
 *   GET  /api/payment/checkout/:id     — Get checkout status (with automatic
 *                                        fulfillment fallback when the webhook
 *                                        has not been configured — this makes
 *                                        the integration work with ONLY the
 *                                        API keys entered by the super admin)
 *
 * Payment methods: EDAHABIA (Algérie Poste) and CIB (SATIM) — the two
 * gateways supported by Chargily Pay in Algeria.
 *
 * Docs: https://dev.chargily.com/pay-v2/introduction
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireAdmin, requireAgencyAccess, requireAgencyAuthority, authErrorResponse } from '../lib/auth'
import {
  createCheckout,
  getCheckoutStatus,
  getBalance,
  isChargilyConfigured,
  isChargilyLiveMode,
} from '../lib/chargily-service'
import { fulfillCheckoutPaid, fulfillCheckoutFailed, normalizeChargilyStatus } from '../lib/chargily-fulfill'
import { validateBody } from '../lib/validations'
import { z } from 'zod'

const app = new Hono()

// ─── Schemas ────────────────────────────────────────────────────────────────

const SMS_PACKS: Record<string, { quantity: number; price: number }> = {
  '20': { quantity: 20, price: 200 },
  '50': { quantity: 50, price: 400 },
  '100': { quantity: 100, price: 700 },
  '200': { quantity: 200, price: 1200 },
}

const createCheckoutSchema = z.object({
  type: z.enum(['subscription', 'sms', 'hardware'], {
    message: 'type must be subscription, sms or hardware',
  }),
  paymentMethod: z.enum(['edahabia', 'cib']).default('edahabia'),
  locale: z.enum(['ar', 'en', 'fr']).optional(),
  // Optional explicit return base (http/https) — overrides Origin detection
  // (used by the Capacitor/Electron shells whose origin is not a web URL).
  returnUrl: z.string().url().optional(),
  // subscription:
  agencyId: z.string().min(1).optional(),
  plan: z.string().min(1).optional(),
  period: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]).optional(),
  hardwareOrderIds: z.array(z.string().min(1)).optional(),
  // sms:
  packId: z.enum(['20', '50', '100', '200']).optional(),
  // hardware:
  orderId: z.string().min(1).optional(),
})

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the public base URL for success/failure redirects.
 *
 * Priority:
 *   1. explicit returnUrl from the client (Capacitor/Electron shells)
 *   2. the request Origin header (regular web browsers — works on the
 *      droplet domain, the preview gateway and localhost alike)
 *   3. NEXTAUTH_URL (production env)
 *   4. http://localhost:3000 (dev fallback)
 */
function resolveBaseUrl(c: { req: { header(name: string): string | undefined; url: string } }, explicit?: string): string {
  if (explicit && /^https?:\/\//i.test(explicit)) {
    // Use only the origin part (strip any path — we append hash routes).
    try {
      return new URL(explicit).origin
    } catch {
      /* fall through */
    }
  }
  const origin = c.req.header('Origin')
  if (origin && /^https?:\/\//i.test(origin)) {
    try {
      return new URL(origin).origin
    } catch {
      /* fall through */
    }
  }
  return process.env.NEXTAUTH_URL || 'http://localhost:3000'
}

/** Ensure Chargily keys are configured before creating a checkout. */
async function ensureChargilyReady() {
  const configured = await isChargilyConfigured()
  if (!configured) {
    throw Object.assign(new Error('chargily_not_configured'), { status: 503 })
  }
}

// ─── POST /create-checkout — Create a Chargily checkout session ───────

app.post('/create-checkout', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = validateBody(createCheckoutSchema, body)

    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { type, paymentMethod, locale, returnUrl } = validation.data
    await ensureChargilyReady()

    const baseUrl = resolveBaseUrl(c, returnUrl)
    // Static redirect targets — the Chargily hosted page redirects the
    // customer's browser here after payment. The checkout id is NOT known at
    // creation time, so the payment-result page recovers it from localStorage
    // (stored by the initiating client right before the redirect) or via
    // GET /api/payment/pending (latest pending checkout for the caller).
    const successUrl = `${baseUrl}/#/payment/result?status=success`
    const failureUrl = `${baseUrl}/#/payment/result?status=failed`

    // ─────────────────────────────────────────────────────────────
    // SUBSCRIPTION (optionally bundling pending UPFRONT hardware orders)
    // ─────────────────────────────────────────────────────────────
    if (type === 'subscription') {
      const { agencyId, plan, period, hardwareOrderIds } = validation.data
      if (!agencyId || !plan) {
        return c.json({ success: false, error: 'agencyId and plan are required for subscription checkouts' }, 400)
      }

      // Verify the user has access to this agency + purchase authority
      // (same gate as the manual POST /agency/subscription/pay).
      await requireAgencyAccess(c, agencyId)
      await requireAgencyAuthority(c, agencyId, 'canPurchaseSubscription')

      const agency = await db.agency.findUnique({ where: { id: agencyId } })
      if (!agency) {
        return c.json({ success: false, error: 'Agency not found' }, 404)
      }

      const planRecord = await db.subscriptionPlan.findFirst({
        where: { name: plan, isActive: true },
      })
      if (!planRecord) {
        return c.json({ success: false, error: 'Invalid or inactive plan' }, 400)
      }
      if (planRecord.isEnterprise && planRecord.ownerAgencyId && planRecord.ownerAgencyId !== agencyId) {
        return c.json({ success: false, error: 'This enterprise plan is not available for your agency' }, 403)
      }

      // Period discount — identical computation to /agency/subscription/pay.
      const effectivePeriod = period ?? 1
      let discountPercent = 0
      if (effectivePeriod === 3) discountPercent = planRecord.quarterlyDiscount
      else if (effectivePeriod === 6) discountPercent = planRecord.semiAnnualDiscount
      else if (effectivePeriod === 12) discountPercent = planRecord.annualDiscount
      else if (effectivePeriod === 24) discountPercent = planRecord.biennialDiscount

      const subscriptionAmount = Math.round(planRecord.price * effectivePeriod * (1 - discountPercent / 100))
      const planNameSnapshot = effectivePeriod > 1 ? `${plan} (${effectivePeriod}m)` : plan

      // Optional hardware add-on: bundle pending UPFRONT orders from the
      // same agency into the SAME checkout (one payment for everything).
      let hardwareAmount = 0
      const bundledOrders: { id: string; upfrontTotal: number }[] = []
      if (hardwareOrderIds && hardwareOrderIds.length > 0) {
        const orders = await db.hardwareOrder.findMany({
          where: {
            id: { in: hardwareOrderIds },
            agencyId, // only this agency's orders
            status: 'PENDING',
            paymentModel: 'UPFRONT',
          },
        })
        for (const order of orders) {
          hardwareAmount += order.upfrontTotal
          bundledOrders.push({ id: order.id, upfrontTotal: order.upfrontTotal })
        }
      }

      const totalAmount = subscriptionAmount + hardwareAmount

      const checkout = await createCheckout({
        amount: totalAmount,
        description: `BLASTI ${planRecord.displayName || plan} Subscription - ${agency.name}${
          bundledOrders.length > 0 ? ` (+${bundledOrders.length} hardware order${bundledOrders.length > 1 ? 's' : ''})` : ''
        }`,
        metadata: {
          agencyId,
          plan,
          period: String(effectivePeriod),
          userId: user.id,
          transactionType: 'subscription',
          ...(bundledOrders.length > 0
            ? { hardwareOrderIds: bundledOrders.map((o) => o.id).join(',') }
            : {}),
        },
        successUrl,
        failureUrl,
        customerName: user.fullName,
        paymentMethod,
        locale: locale || 'ar',
      })

      // Create a pending transaction linked to this checkout
      const transaction = await db.transaction.create({
        data: {
          agencyId,
          amount: totalAmount,
          plan,
          paymentMethod: paymentMethod === 'edahabia' ? 'EDAHABIA' : 'CIB',
          status: 'PENDING',
          paymentProvider: 'chargily',
          providerRef: checkout.id,
          amountPaid: totalAmount,
          planName: planNameSnapshot,
          priceSnapshot: planRecord.price,
          currencySnapshot: planRecord.currency,
          type: 'SUBSCRIPTION',
        },
      })

      // Link the bundled hardware orders to the same checkout id so the
      // fulfillment pass approves them together with the subscription.
      if (bundledOrders.length > 0) {
        await db.hardwareOrder.updateMany({
          where: { id: { in: bundledOrders.map((o) => o.id) } },
          data: { providerRef: checkout.id, paymentProvider: 'chargily' },
        })
      }

      // Update agency subscription status to pending
      await db.agency.update({
        where: { id: agencyId },
        data: {
          subscriptionStatus: 'PENDING',
          subscriptionTier: plan,
          subscriptionPlanId: planRecord.id,
        },
      })

      await db.auditLog.create({
        data: {
          userId: user.id,
          action: 'PAYMENT_CHECKOUT_CREATED',
          entityType: 'TRANSACTION',
          entityId: transaction.id,
          details: JSON.stringify({
            checkoutId: checkout.id,
            agencyId,
            plan,
            period: effectivePeriod,
            amount: totalAmount,
            subscriptionAmount,
            hardwareAmount,
            paymentMethod,
          }),
        },
      })

      return c.json({
        success: true,
        data: {
          checkoutUrl: checkout.checkout_url,
          checkoutId: checkout.id,
          transactionId: transaction.id,
          amount: totalAmount,
          currency: planRecord.currency || 'DZD',
          type: 'subscription',
          hardwareOrderIds: bundledOrders.map((o) => o.id),
        },
      })
    }

    // ─────────────────────────────────────────────────────────────
    // SMS PACK (customer wallet top-up)
    // ─────────────────────────────────────────────────────────────
    if (type === 'sms') {
      const { packId } = validation.data
      if (!packId) {
        return c.json({ success: false, error: 'packId is required for sms checkouts' }, 400)
      }
      const pack = SMS_PACKS[packId]

      const checkout = await createCheckout({
        amount: pack.price,
        description: `BLASTI SMS Pack - ${pack.quantity} credits`,
        metadata: {
          userId: user.id,
          packId,
          quantity: String(pack.quantity),
          transactionType: 'sms',
        },
        successUrl,
        failureUrl,
        customerName: user.fullName,
        paymentMethod,
        locale: locale || 'ar',
      })

      // Create the pending purchase — credits are granted automatically when
      // Chargily confirms the payment (webhook or return-trip polling).
      const purchase = await db.smsPurchase.create({
        data: {
          userId: user.id,
          quantity: pack.quantity,
          price: pack.price,
          status: 'PENDING',
          paymentMethod: paymentMethod === 'edahabia' ? 'EDAHABIA' : 'CIB',
          paymentProvider: 'chargily',
          providerRef: checkout.id,
        },
      })

      await db.auditLog.create({
        data: {
          userId: user.id,
          action: 'SMS_PURCHASE_CHECKOUT_CREATED',
          entityType: 'SMS_PURCHASE',
          entityId: purchase.id,
          details: JSON.stringify({
            checkoutId: checkout.id,
            quantity: pack.quantity,
            price: pack.price,
            paymentMethod,
          }),
        },
      })

      return c.json({
        success: true,
        data: {
          checkoutUrl: checkout.checkout_url,
          checkoutId: checkout.id,
          smsPurchaseId: purchase.id,
          amount: pack.price,
          currency: 'DZD',
          type: 'sms',
          quantity: pack.quantity,
        },
      })
    }

    // ─────────────────────────────────────────────────────────────
    // HARDWARE ORDER (devices: TV / PC / KIOSK / PRINTER)
    // ─────────────────────────────────────────────────────────────
    // type === 'hardware'
    const { orderId } = validation.data
    if (!orderId) {
      return c.json({ success: false, error: 'orderId is required for hardware checkouts' }, 400)
    }

    const order = await db.hardwareOrder.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: true } } },
    })
    if (!order) {
      return c.json({ success: false, error: 'Hardware order not found' }, 404)
    }

    // The caller must have access to the order's agency.
    await requireAgencyAccess(c, order.agencyId)

    if (order.status !== 'PENDING') {
      return c.json({ success: false, error: `Order is already ${order.status.toLowerCase()}` }, 400)
    }
    if (order.paymentModel !== 'UPFRONT') {
      return c.json(
        { success: false, error: 'Only UPFRONT hardware orders can be paid online. Monthly-commitment orders are invoiced with the subscription.' },
        400,
      )
    }
    if (order.upfrontTotal <= 0) {
      return c.json({ success: false, error: 'This order has no amount to pay' }, 400)
    }

    const agency = await db.agency.findUnique({ where: { id: order.agencyId } })
    const itemsSummary = order.items
      .map((i) => `${i.quantity}× ${i.product.name}`)
      .join(', ')

    const checkout = await createCheckout({
      amount: order.upfrontTotal,
      description: `BLASTI Hardware - ${itemsSummary || 'Devices'}${agency ? ` - ${agency.name}` : ''}`,
      metadata: {
        agencyId: order.agencyId,
        orderId: order.id,
        userId: user.id,
        transactionType: 'hardware',
      },
      successUrl,
      failureUrl,
      customerName: user.fullName,
      paymentMethod,
      locale: locale || 'ar',
    })

    // Payment ledger entry (shows up in admin transactions + analytics).
    const transaction = await db.transaction.create({
      data: {
        agencyId: order.agencyId,
        amount: order.upfrontTotal,
        plan: 'HARDWARE',
        paymentMethod: paymentMethod === 'edahabia' ? 'EDAHABIA' : 'CIB',
        status: 'PENDING',
        paymentProvider: 'chargily',
        providerRef: checkout.id,
        amountPaid: order.upfrontTotal,
        planName: itemsSummary || 'Hardware order',
        currencySnapshot: 'DZD',
        type: 'HARDWARE',
        hardwareOrderId: order.id,
      },
    })

    // Link the order to the checkout — the fulfillment pass approves it.
    await db.hardwareOrder.update({
      where: { id: order.id },
      data: { providerRef: checkout.id, paymentProvider: 'chargily' },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'PAYMENT_CHECKOUT_CREATED',
        entityType: 'HARDWARE_ORDER',
        entityId: order.id,
        details: JSON.stringify({
          checkoutId: checkout.id,
          agencyId: order.agencyId,
          amount: order.upfrontTotal,
          paymentMethod,
          type: 'hardware',
        }),
      },
    })

    return c.json({
      success: true,
      data: {
        checkoutUrl: checkout.checkout_url,
        checkoutId: checkout.id,
        transactionId: transaction.id,
        orderId: order.id,
        amount: order.upfrontTotal,
        currency: 'DZD',
        type: 'hardware',
      },
    })
  } catch (error: unknown) {
    // Surface the chargily-not-configured and Chargily API errors usefully.
    const err = error as { status?: number; message?: string }
    if (err?.message === 'chargily_not_configured') {
      return c.json(
        {
          success: false,
          error: 'Chargily is not configured. Ask the platform administrator to enter the Chargily API keys in Platform Settings.',
          code: 'chargily_not_configured',
        },
        503,
      )
    }
    const authErr = authErrorResponse(error)
    if (authErr.status === 401 || authErr.status === 403) {
      return c.json({ success: false, error: authErr.error }, authErr.status as 400)
    }
    if (error instanceof Error && error.message.startsWith('Chargily API error')) {
      console.error('[payment-checkout] Chargily API rejected the checkout:', error.message)
      return c.json(
        { success: false, error: 'The payment gateway rejected the request. Check the Chargily API keys in Platform Settings.', details: error.message },
        502,
      )
    }
    console.error('[payment-checkout] Error creating checkout:', error)
    return c.json({ success: false, error: 'Failed to create checkout session' }, 500)
  }
})

// ─── GET /checkout/:id — Get checkout status (with fulfillment fallback) ──
//
// Called by the payment-result page when the customer returns from the
// hosted Chargily checkout. If the webhook already settled the payment the
// local status is returned immediately. If the webhook has NOT been
// configured (or is late), the Chargily API is queried directly and the
// SAME fulfillment logic runs here — so payments complete with only the
// API keys configured, no webhook setup required.

app.get('/checkout/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    const checkoutId = c.req.param('id')

    if (!/^[a-zA-Z0-9_-]+$/.test(checkoutId)) {
      return c.json({ success: false, error: 'Invalid checkout id' }, 400)
    }

    // Find the local records associated with this checkout.
    const transaction = await db.transaction.findFirst({
      where: { providerRef: checkoutId },
    })
    const smsPurchase = await db.smsPurchase.findFirst({
      where: { providerRef: checkoutId },
    })

    if (!transaction && !smsPurchase) {
      return c.json({ success: false, error: 'Checkout not found' }, 404)
    }

    // Ownership: super admin sees everything; otherwise the caller must be
    // connected to the transaction's agency or own the SMS purchase.
    if (user.role !== 'SUPER_ADMIN') {
      if (transaction) {
        try {
          await requireAgencyAccess(c, transaction.agencyId)
        } catch {
          return c.json({ success: false, error: 'Access denied' }, 403)
        }
      }
      if (smsPurchase && smsPurchase.userId !== user.id) {
        return c.json({ success: false, error: 'Access denied' }, 403)
      }
    }

    // Local record type for the client UI.
    const type = transaction
      ? transaction.type === 'HARDWARE'
        ? 'hardware'
        : 'subscription'
      : 'sms'

    // ── Local status first (webhook may already have settled everything) ──
    const localPending =
      (transaction && transaction.status === 'PENDING') ||
      (smsPurchase && smsPurchase.status === 'PENDING')

    if (!localPending) {
      // Everything is already settled locally — no need to call Chargily.
      const status = transaction
        ? transaction.status
        : smsPurchase
          ? smsPurchase.status === 'APPROVED'
            ? 'paid'
            : smsPurchase.status === 'FAILED'
              ? 'failed'
              : smsPurchase.status
          : 'unknown'

      return c.json({
        success: true,
        data: {
          checkoutId,
          transactionId: transaction?.id,
          smsPurchaseId: smsPurchase?.id,
          status,
          normalizedStatus: normalizeChargilyStatus(
            transaction
              ? transaction.status === 'COMPLETED'
                ? 'paid'
                : transaction.status === 'FAILED'
                  ? 'failed'
                  : 'pending'
              : smsPurchase?.status === 'APPROVED'
                ? 'paid'
                : smsPurchase?.status === 'FAILED'
                  ? 'failed'
                  : 'pending',
          ),
          amount: transaction?.amount ?? smsPurchase?.price ?? 0,
          currency: transaction?.currencySnapshot || 'DZD',
          type,
          plan: transaction?.plan,
          planName: transaction?.planName,
          smsQuantity: smsPurchase?.quantity,
          source: 'local',
        },
      })
    }

    // ── Still pending locally → ask Chargily for the live status ──
    let remoteStatus: string | null = null
    let remoteCheckoutUrl: string | undefined
    try {
      const remote = await getCheckoutStatus(checkoutId)
      remoteStatus = remote.status
      remoteCheckoutUrl = remote.checkout_url
    } catch (err) {
      console.warn('[payment-checkout] Failed to fetch Chargily status:', err)
      // Unreachable / keys rotated — return the local pending state.
      return c.json({
        success: true,
        data: {
          checkoutId,
          transactionId: transaction?.id,
          smsPurchaseId: smsPurchase?.id,
          status: 'pending',
          normalizedStatus: 'pending',
          amount: transaction?.amount ?? smsPurchase?.price ?? 0,
          currency: transaction?.currencySnapshot || 'DZD',
          type,
          plan: transaction?.plan,
          planName: transaction?.planName,
          smsQuantity: smsPurchase?.quantity,
          source: 'local',
        },
      })
    }

    // ── Fulfillment fallback: Chargily says paid/failed but we are still
    //    pending → run the SAME settlement the webhook would have run.
    const normalized = normalizeChargilyStatus(remoteStatus || 'pending')
    if (normalized === 'paid') {
      await fulfillCheckoutPaid(
        {
          id: checkoutId,
          status: remoteStatus || 'paid',
          amount: 0,
          payment_method: null,
          metadata: null,
        },
        'poll',
      )
    } else if (normalized === 'failed') {
      await fulfillCheckoutFailed(
        {
          id: checkoutId,
          status: remoteStatus || 'failed',
          amount: 0,
          payment_method: null,
          metadata: null,
        },
        'poll',
      )
    }

    // Re-read the settled state.
    const [txAfter, smsAfter] = await Promise.all([
      transaction ? db.transaction.findUnique({ where: { id: transaction.id } }) : null,
      smsPurchase ? db.smsPurchase.findUnique({ where: { id: smsPurchase.id } }) : null,
    ])

    const finalStatus = txAfter
      ? txAfter.status === 'COMPLETED'
        ? 'paid'
        : txAfter.status === 'FAILED'
          ? 'failed'
          : remoteStatus || txAfter.status
      : smsAfter
        ? smsAfter.status === 'APPROVED'
          ? 'paid'
          : smsAfter.status === 'FAILED'
            ? 'failed'
            : remoteStatus || smsAfter.status
        : remoteStatus

    return c.json({
      success: true,
      data: {
        checkoutId,
        transactionId: txAfter?.id ?? transaction?.id,
        smsPurchaseId: smsAfter?.id ?? smsPurchase?.id,
        status: finalStatus,
        normalizedStatus: normalizeChargilyStatus(
          txAfter
            ? txAfter.status === 'COMPLETED'
              ? 'paid'
              : txAfter.status === 'FAILED'
                ? 'failed'
                : 'pending'
            : smsAfter?.status === 'APPROVED'
              ? 'paid'
              : smsAfter?.status === 'FAILED'
                ? 'failed'
                : 'pending',
        ),
        amount: txAfter?.amount ?? smsAfter?.price ?? 0,
        currency: txAfter?.currencySnapshot || 'DZD',
        type,
        plan: txAfter?.plan,
        planName: txAfter?.planName,
        smsQuantity: smsAfter?.quantity,
        checkoutUrl: normalized === 'pending' ? remoteCheckoutUrl : undefined,
        source: 'chargily',
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /test — Validate the configured Chargily keys (super admin) ──────
//
// Used by the Payment Engine settings card: calls the Chargily balance
// endpoint with the currently configured keys so the super admin can verify
// the keys are correct without making a real payment.

app.get('/test', async (c) => {
  try {
    await requireAdmin(c)

    const configured = await isChargilyConfigured()
    if (!configured) {
      return c.json(
        {
          success: false,
          error:
            'No usable Chargily SECRET key found. Enter the SECRET key (test_sk_… in sandbox / sk_… in live) — the PUBLIC key (test_pk_…) is never valid server-side.',
          code: 'not_configured',
        },
        400,
      )
    }

    const [balance, live] = await Promise.all([getBalance(), isChargilyLiveMode()])
    const dzd = balance.wallets?.find((w) => w.currency === 'dzd')

    return c.json({
      success: true,
      data: {
        mode: live ? 'live' : 'sandbox',
        livemode: balance.livemode,
        wallets: balance.wallets,
        dzdBalance: dzd?.balance ?? null,
      },
    })
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string }
    if (err?.status === 401 || err?.status === 403) {
      const authErr = authErrorResponse(error)
      return c.json({ success: false, error: authErr.error }, authErr.status as 400)
    }
    if (error instanceof Error && error.message.startsWith('Chargily API error')) {
      // Surface WHY Chargily rejected the call: 401/403 = wrong key (the
      // public …pk_… key is never valid server-side) or mode mismatch
      // (test_… keys only work in sandbox).
      const statusMatch = error.message.match(/Chargily API error: (\d+)/)
      const status = statusMatch?.[1] ?? ''
      let hint = 'Chargily rejected the keys. Verify the API key/secret and the mode (sandbox vs live).'
      if (status === '401' || status === '403') {
        hint =
          'Chargily rejected the keys (HTTP ' +
          status +
          '). Use the SECRET key (test_sk_… / sk_…) — the PUBLIC key (test_pk_…) is never valid server-side — and make sure the mode matches the keys (test_… = sandbox).'
      }
      return c.json(
        { success: false, error: hint, details: error.message },
        400,
      )
    }
    if (error instanceof Error && error.message.includes('not configured')) {
      return c.json({ success: false, error: error.message, code: 'not_configured' }, 400)
    }
    console.error('[payment-test] Error testing Chargily connection:', error)
    return c.json({ success: false, error: 'Connection test failed' }, 500)
  }
})

// ─── GET /pending — Latest pending Chargily checkout for the caller ──────
//
// Fallback lookup used by the payment-result page when the checkout id is
// not in localStorage (e.g. the customer finished the payment in a
// different browser than the one that started it).

app.get('/pending', async (c) => {
  try {
    const user = await requireAuth(c)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

    // SMS purchases are user-scoped.
    const smsPurchase = await db.smsPurchase.findFirst({
      where: {
        userId: user.id,
        paymentProvider: 'chargily',
        status: 'PENDING',
        createdAt: { gte: oneHourAgo },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Transactions are agency-scoped — resolve the caller's agency.
    let transaction = null
    if (user.agencyId) {
      transaction = await db.transaction.findFirst({
        where: {
          agencyId: user.agencyId,
          paymentProvider: 'chargily',
          status: 'PENDING',
          createdAt: { gte: oneHourAgo },
        },
        orderBy: { createdAt: 'desc' },
      })
    } else if (user.role === 'SUPER_ADMIN') {
      transaction = await db.transaction.findFirst({
        where: {
          paymentProvider: 'chargily',
          status: 'PENDING',
          createdAt: { gte: oneHourAgo },
        },
        orderBy: { createdAt: 'desc' },
      })
    }

    if (!transaction && !smsPurchase) {
      return c.json({ success: true, data: null })
    }

    // Prefer the most recent of the two.
    const txTime = transaction?.createdAt?.getTime() ?? 0
    const smsTime = smsPurchase?.createdAt?.getTime() ?? 0
    const isTransaction = txTime >= smsTime
    const primary = isTransaction ? transaction : smsPurchase

    return c.json({
      success: true,
      data: primary
        ? {
            checkoutId: primary.providerRef,
            type: isTransaction ? 'subscription' : 'sms',
            amount: isTransaction ? (transaction?.amount ?? 0) : (smsPurchase?.price ?? 0),
          }
        : null,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

export const paymentCheckoutRoutes = app
