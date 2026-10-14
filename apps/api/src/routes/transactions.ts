import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireAgencyAccess, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { z } from 'zod'

const app = new Hono()

const createTransactionSchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
  amount: z.number().int().positive('Amount must be a positive number'),
  plan: z.enum(['BASIC', 'PREMIUM'], { message: 'Invalid plan. Must be BASIC or PREMIUM' }),
  paymentMethod: z.enum(['CCP', 'BANK_TRANSFER', 'E_WALLET', 'CASH'], { message: 'Invalid payment method' }),
  receiptUrl: z.string().optional(),
})

// POST /transactions — Create transaction
app.post('/', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateBody(createTransactionSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, amount, plan, paymentMethod, receiptUrl } = validation.data

    await requireAgencyAccess(c, agencyId)

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

    // Snapshot: look up the current SubscriptionPlan to freeze price & name
    let planName: string | undefined
    let amountPaid: number | undefined
    const subscriptionPlan = await db.subscriptionPlan.findFirst({
      where: { name: plan, isActive: true },
    })
    if (subscriptionPlan) {
      planName = subscriptionPlan.displayName || subscriptionPlan.name
      amountPaid = subscriptionPlan.price
    } else {
      // Fallback: use the plan string and amount from the request
      planName = plan
      amountPaid = amount
    }

    const transaction = await db.transaction.create({
      data: { agencyId, amount, plan, paymentMethod, receiptUrl, status: 'PENDING', amountPaid, planName },
    })

    await db.agency.update({ where: { id: agencyId }, data: { subscriptionStatus: 'PENDING' } })

    return c.json({ success: true, transaction }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /transactions — List transactions
//
// Query params:
//   status  — PENDING | APPROVED | REJECTED | COMPLETED | FAILED (optional)
//   type    — 'online' (Chargily checkout payments: providerRef set) |
//             'manual' (receipt-upload payments: no gateway reference) |
//             omitted → both (optional)
//   limit / offset — pagination (defaults 20 / 0)
//
// Online vs manual discrimination: online payments are created by
// payment-checkout.ts which ALWAYS stamps providerRef with the Chargily
// checkout id; manual receipts leave providerRef at its schema default ('').
// The schema default of paymentProvider is 'chargily' for legacy rows, so
// providerRef — not paymentProvider — is the reliable discriminator.
app.get('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const status = c.req.query('status')
    const type = c.req.query('type')
    const limit = parseInt(c.req.query('limit') || '20', 10)
    const offset = parseInt(c.req.query('offset') || '0', 10)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (type === 'online') {
      where.providerRef = { not: '' }
    } else if (type === 'manual') {
      where.OR = [{ providerRef: '' }, { providerRef: null }]
    }

    // SMS purchase feed filters — same semantics, different columns:
    //   status: SmsPurchase has no COMPLETED (Chargily settles at APPROVED) —
    //           map a COMPLETED filter to APPROVED so the admin's "settled"
    //           query returns the SMS equivalent too.
    //   type:   online = chargily checkout (providerRef stamped), manual =
    //           receipt upload (paymentProvider stays 'manual').
    const smsWhere: Record<string, unknown> = {}
    if (status) smsWhere.status = status === 'COMPLETED' ? 'APPROVED' : status
    if (type === 'online') {
      smsWhere.paymentProvider = 'chargily'
    } else if (type === 'manual') {
      smsWhere.paymentProvider = 'manual'
    }

    if (user.role !== 'SUPER_ADMIN') {
      const ownedAgency = await db.agency.findFirst({
        where: { ownerId: user.id },
        select: { id: true },
      })
      if (ownedAgency) {
        where.agencyId = ownedAgency.id
      } else {
        const staffRecord = await db.agencyStaff.findFirst({
          where: { userId: user.id, isActive: true },
          select: { agencyId: true },
        })
        if (staffRecord) {
          where.agencyId = staffRecord.agencyId
        } else {
          return c.json({ success: true, transactions: [], total: 0, limit, offset })
        }
      }
    }

    const [transactions, total, smsPurchases, smsTotal] = await Promise.all([
      db.transaction.findMany({
        where,
        include: {
          agency: {
            select: {
              id: true, name: true, customCode: true, category: true,
              subscriptionTier: true, subscriptionStatus: true,
              // Payer account contact (admin online-payment reconciliation view)
              owner: { select: { username: true, fullName: true, email: true } },
            },
          },
          reviewer: { select: { id: true, fullName: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.transaction.count({ where }),
      // ── ALL-transactions mandate (field report: "admin transactions must
      // include ALL transactions with no exception") — the admin console must
      // show SMS pack purchases NEXT TO subscription payments. For
      // SUPER_ADMIN the SmsPurchase feed is merged into the same
      // desc-by-createdAt page; agency-scoped callers keep the
      // subscription-only view (SmsPurchase has no agency dimension).
      user.role === 'SUPER_ADMIN'
        ? db.smsPurchase.findMany({
            where: smsWhere,
            include: { user: { select: { id: true, username: true, fullName: true, email: true } } },
            orderBy: { createdAt: 'desc' },
            take: limit + offset,
          })
        : Promise.resolve([] as never[]),
      user.role === 'SUPER_ADMIN' ? db.smsPurchase.count({ where: smsWhere }) : Promise.resolve(0),
    ])

    // Normalize SMS purchases into the transaction row shape the admin
    // console renders, tagged with kind so the UI can badge + hide
    // subscription-only actions (review/reconcile).
    const smsRows = (smsPurchases as Array<Record<string, unknown>>).map((p) => ({
      id: p.id,
      kind: 'sms_purchase' as const,
      amount: p.price,
      amountPaid: p.price,
      currencySnapshot: 'DZD',
      plan: 'SMS_PACK',
      planName: `SMS Pack ×${p.quantity}`,
      quantity: p.quantity,
      status: p.status,
      paymentMethod: p.paymentMethod ?? null,
      paymentProvider: p.paymentProvider,
      providerRef: p.providerRef ?? null,
      receiptUrl: p.receiptUrl ?? null,
      webhookVerified: p.webhookVerified,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      agency: null,
      reviewer: null,
      user: p.user,
    }))

    // Merge + single desc-by-createdAt page. Both sides were already limited
    // to limit+offset rows, so slicing in memory is bounded.
    const merged = ([
      ...(transactions as Array<Record<string, unknown>>).map((t) => ({ ...t, kind: 'subscription' as const })),
      ...smsRows,
    ] as Array<Record<string, unknown>>)
      .sort((a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime())
      .slice(offset, offset + limit)

    return c.json({ success: true, transactions: merged, total: total + smsTotal, limit, offset })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /transactions/:id/review — Review (approve/reject) a transaction
app.put('/:id/review', async (c) => {
  try {
    const user = await requireAuth(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const transactionReviewSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED']), rejectionReason: z.string().max(500).optional() })
    const validation = validateBody(transactionReviewSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { status, rejectionReason } = validation.data

    const existingTransaction = await db.transaction.findUnique({ where: { id } })
    if (!existingTransaction) return c.json({ success: false, error: 'Transaction not found' }, 404)

    const reviewedBy = user.id

    // Optimistic Concurrency Control: include current version in WHERE, increment in data.
    // If two admins approve simultaneously, only the first update will match the version;
    // the second will affect 0 rows → conflict error, preventing double-grant.
    const updateResult = await db.transaction.updateMany({
      where: { id, status: 'PENDING', version: existingTransaction.version },
      data: {
        status,
        reviewedBy,
        reviewedAt: new Date(),
        rejectionReason: status === 'REJECTED' ? rejectionReason : null,
        version: { increment: 1 },
      },
    })

    if (updateResult.count === 0) {
      return c.json({ success: false, error: 'Transaction already reviewed or concurrently modified' }, 409)
    }

    // Fetch the updated record separately for the response
    const updatedTransaction = await db.transaction.findUnique({
      where: { id },
      include: {
        agency: { select: { id: true, name: true, customCode: true, subscriptionTier: true, subscriptionStatus: true } },
      },
    })

    if (status === 'APPROVED') {
      // Use snapshot values (amountPaid / planName) when updating agency tier
      const effectivePlan = existingTransaction.planName || existingTransaction.plan
      await db.agency.update({ where: { id: existingTransaction.agencyId }, data: { subscriptionStatus: 'ACTIVE', subscriptionTier: existingTransaction.plan } })

      // If amountPaid wasn't set at creation (legacy rows), backfill it now
      if (existingTransaction.amountPaid === null || existingTransaction.amountPaid === undefined) {
        await db.transaction.update({
          where: { id: existingTransaction.id },
          data: {
            amountPaid: existingTransaction.amount,
            planName: existingTransaction.plan,
          },
        })
      }
    }

    if (status === 'REJECTED') {
      await db.agency.update({ where: { id: existingTransaction.agencyId }, data: { subscriptionStatus: 'INACTIVE' } })
    }

    await db.auditLog.create({
      data: {
        userId: reviewedBy,
        action: status === 'APPROVED' ? 'PAYMENT_APPROVE' : 'PAYMENT_REJECT',
        entityType: 'TRANSACTION',
        entityId: id,
        details: JSON.stringify({ transactionId: id, agencyId: existingTransaction.agencyId, amount: existingTransaction.amount, plan: existingTransaction.plan, status, rejectionReason }),
      },
    })

    return c.json({ success: true, transaction: updatedTransaction })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const transactionRoutes = app
