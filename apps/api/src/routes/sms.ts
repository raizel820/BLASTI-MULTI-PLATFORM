import { Hono } from 'hono'
import { db, Prisma } from '@blasti/db'
import { requireAuth, requireAdmin, authErrorResponse, AuthError } from '../lib/auth'
import { checkRateLimit, RateLimitError, SMS_RATE_LIMIT } from '../lib/rate-limit'
import { validateBody } from '../lib/validations'
import { z } from 'zod'

const app = new Hono()

const smsPurchaseSchema = z.object({
  packId: z.enum(['20', '50', '100'], { message: 'Invalid pack ID. Allowed: 20, 50, 100' }),
})

/**
 * Phase 1e: SMS packs now require admin approval or webhook confirmation
 * before credits are granted. Direct DB increments are removed.
 * Purchase creates a PENDING record that must be approved.
 */
const ALLOWED_PACKS: Record<string, { quantity: number; price: number }> = {
  '20': { quantity: 20, price: 200 },
  '50': { quantity: 50, price: 400 },
  '100': { quantity: 100, price: 700 },
}

// POST /sms/purchase — Purchase an SMS pack (creates PENDING record, no credits yet)
app.post('/purchase', async (c) => {
  try {
    const user = await requireAuth(c)

    checkRateLimit(user.id, SMS_RATE_LIMIT)

    const body = await c.req.json()
    const validation = validateBody(smsPurchaseSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { packId } = validation.data
    const pack = ALLOWED_PACKS[packId]
    const userId = user.id

    // Deduplication: 5-minute cooldown per pack per user
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const recentPurchase = await db.smsPurchase.findFirst({
      where: { userId, quantity: pack.quantity, createdAt: { gte: fiveMinutesAgo } },
    })

    if (recentPurchase) {
      return c.json({ error: 'You already purchased this pack recently. Please wait a few minutes.' }, 429)
    }

    // Phase 1e: Create PENDING purchase — NO direct increment of freeSmsCount
    // Credits are only granted when admin approves or webhook confirms payment
    const purchase = await db.smsPurchase.create({
      data: {
        userId,
        quantity: pack.quantity,
        price: pack.price,
        status: 'PENDING', // Must be approved before credits are granted
      },
    })

    // Notify user that purchase is pending approval
    await db.notification.create({
      data: {
        userId,
        type: 'SMS_PURCHASE_PENDING',
        title: 'SMS Purchase Pending',
        message: `Your purchase of ${pack.quantity} SMS credits (${pack.price} DA) is pending payment verification. Credits will be added once approved.`,
      },
    })

    return c.json({
      success: true,
      purchaseId: purchase.id,
      status: 'PENDING',
      message: 'Purchase created. Credits will be added once payment is verified.',
    })
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      return c.json({ success: false, error: error.message, retryAfter: error.retryAfter }, 429)
    }
    if (error instanceof AuthError) {
      const err = authErrorResponse(error)
      return c.json({ success: err.success, error: err.error }, err.status as any)
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return c.json({ success: false, error: 'Database error occurred' }, 500)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /sms/purchase — Get user's SMS purchase history
app.get('/purchase', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const purchases = await db.smsPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })

    return c.json({ purchases })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /sms/approve/:id — Admin approves an SMS purchase and grants credits
// Phase 1e: This is the ONLY way credits are added (replacing direct DB increments)
app.post('/approve/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const purchaseId = c.req.param('id')

    const purchase = await db.smsPurchase.findUnique({ where: { id: purchaseId } })
    if (!purchase) {
      return c.json({ success: false, error: 'Purchase not found' }, 404)
    }

    if (purchase.status !== 'PENDING') {
      return c.json({ success: false, error: `Purchase already ${purchase.status.toLowerCase()}` }, 400)
    }

    // Phase 1e: Atomic transaction — approve purchase AND increment credits
    const result = await db.$transaction(async (tx) => {
      const updatedPurchase = await tx.smsPurchase.update({
        where: { id: purchaseId },
        data: { status: 'APPROVED' },
      })

      await tx.user.update({
        where: { id: purchase.userId },
        data: { freeSmsCount: { increment: purchase.quantity } },
      })

      await tx.notification.create({
        data: {
          userId: purchase.userId,
          type: 'SMS_PURCHASED',
          title: 'SMS Credits Approved',
          message: `Your purchase of ${purchase.quantity} SMS credits has been approved and added to your account.`,
        },
      })

      return updatedPurchase
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SMS_PURCHASE_APPROVE',
        entityType: 'SMS_PURCHASE',
        entityId: purchaseId,
        details: JSON.stringify({ approvedFor: purchase.userId, quantity: purchase.quantity }),
      },
    })

    return c.json({ success: true, purchase: result })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /sms/reject/:id — Admin rejects an SMS purchase
app.post('/reject/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const purchaseId = c.req.param('id')

    const purchase = await db.smsPurchase.findUnique({ where: { id: purchaseId } })
    if (!purchase) {
      return c.json({ success: false, error: 'Purchase not found' }, 404)
    }

    if (purchase.status !== 'PENDING') {
      return c.json({ success: false, error: `Purchase already ${purchase.status.toLowerCase()}` }, 400)
    }

    const result = await db.$transaction(async (tx) => {
      const updatedPurchase = await tx.smsPurchase.update({
        where: { id: purchaseId },
        data: { status: 'REJECTED' },
      })

      await tx.notification.create({
        data: {
          userId: purchase.userId,
          type: 'SMS_PURCHASE_REJECTED',
          title: 'SMS Purchase Rejected',
          message: `Your purchase of ${purchase.quantity} SMS credits was not approved. Please contact support.`,
        },
      })

      return updatedPurchase
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SMS_PURCHASE_REJECT',
        entityType: 'SMS_PURCHASE',
        entityId: purchaseId,
        details: JSON.stringify({ rejectedFor: purchase.userId, quantity: purchase.quantity }),
      },
    })

    return c.json({ success: true, purchase: result })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const smsRoutes = app
