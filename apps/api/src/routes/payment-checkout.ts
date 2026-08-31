/**
 * @blasti/api — Payment Checkout Route
 *
 * Creates Chargily checkout sessions for agency subscription payments
 * and retrieves checkout status.
 *
 * Routes:
 *   POST /api/payment/create-checkout  — Create a Chargily checkout session
 *   GET  /api/payment/checkout/:id     — Get checkout status
 *
 * Both routes require authentication and validate that the user
 * owns or has access to the specified agency.
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireAgencyAccess, authErrorResponse } from '../lib/auth'
import { createCheckout, getCheckoutStatus } from '../lib/chargily-service'
import { validateBody } from '../lib/validations'
import { z } from 'zod'

const app = new Hono()

// ─── Schema ────────────────────────────────────────────────────────────────

const createCheckoutSchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
  plan: z.enum(['BASIC', 'PREMIUM'], { message: 'Invalid plan. Must be BASIC or PREMIUM' }),
  paymentMethod: z.enum(['edahabia', 'cib']).default('edahabia'),
})

// ─── POST /create-checkout — Create a Chargily checkout session ───────

app.post('/create-checkout', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = validateBody(createCheckoutSchema, body)

    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, plan, paymentMethod } = validation.data

    // Verify the user has access to this agency
    await requireAgencyAccess(c, agencyId)

    // Get the agency
    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    // Get the subscription plan details
    const subscriptionPlan = await db.subscriptionPlan.findFirst({
      where: { name: plan, isActive: true },
    })

    const amount = subscriptionPlan?.price || (plan === 'BASIC' ? 0 : 5000)
    const planDisplayName = subscriptionPlan?.displayName || plan

    // Determine the base URL for success/failure redirects
    // In production, this would be the actual domain; in dev, localhost:3000
    const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'

    // Create the Chargily checkout session
    const checkout = await createCheckout({
      amount,
      description: `BLASTI ${planDisplayName} Subscription - ${agency.name}`,
      metadata: {
        agencyId,
        plan,
        userId: user.id,
        transactionType: 'subscription',
      },
      successUrl: `${baseUrl}/#/agency/payment/success?agency=${agencyId}`,
      failureUrl: `${baseUrl}/#/agency/payment/failure?agency=${agencyId}`,
      customerName: user.fullName,
      customerEmail: user.email || undefined,
      paymentMethod,
    })

    // Create a pending transaction linked to this checkout
    const transaction = await db.transaction.create({
      data: {
        agencyId,
        amount,
        plan,
        paymentMethod: paymentMethod === 'edahabia' ? 'E_WALLET' : 'CCP',
        status: 'PENDING',
        paymentProvider: 'chargily',
        providerRef: checkout.id,
        amountPaid: amount,
        planName: planDisplayName,
      },
    })

    // Update agency subscription status to pending
    await db.agency.update({
      where: { id: agencyId },
      data: { subscriptionStatus: 'PENDING' },
    })

    // Create audit log
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
          amount,
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
        amount,
        currency: 'DZD',
      },
    })

  } catch (error) {
    const err = authErrorResponse(error)
    if (err.status === 401 || err.status === 403) {
      return c.json({ success: false, error: err.error }, err.status as 400)
    }
    console.error('[payment-checkout] Error creating checkout:', error)
    return c.json({ success: false, error: 'Failed to create checkout session' }, 500)
  }
})

// ─── GET /checkout/:id — Get checkout status ──────────────────────────

app.get('/checkout/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    const checkoutId = c.req.param('id')

    // Find the transaction associated with this checkout
    const transaction = await db.transaction.findFirst({
      where: { providerRef: checkoutId },
    })

    if (!transaction) {
      return c.json({ success: false, error: 'Transaction not found' }, 404)
    }

    // Verify the user has access to this agency's transaction
    if (user.role !== 'SUPER_ADMIN') {
      await requireAgencyAccess(c, transaction.agencyId)
    }

    // Get the latest status from Chargily
    let checkoutStatus
    try {
      checkoutStatus = await getCheckoutStatus(checkoutId)
    } catch (err) {
      console.warn('[payment-checkout] Failed to fetch Chargily status:', err)
      // Return the local transaction status instead
      return c.json({
        success: true,
        data: {
          checkoutId,
          transactionId: transaction.id,
          status: transaction.status,
          amount: transaction.amount,
          currency: 'DZD',
          source: 'local',
        },
      })
    }

    return c.json({
      success: true,
      data: {
        checkoutId,
        transactionId: transaction.id,
        status: checkoutStatus.status || transaction.status,
        amount: transaction.amount,
        currency: 'DZD',
        checkoutUrl: checkoutStatus.checkout_url,
        source: 'chargily',
      },
    })

  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

export const paymentCheckoutRoutes = app
