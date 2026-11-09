/**
 * @blasti/api — Billing routes (mounted at /api/billing)
 *
 * Invoice/receipt management for the BLASTI billing system:
 *  - GET/PUT /legal-info           SUPER_ADMIN — BLASTI legal identity (NIF/NIS/RIB/RC/…)
 *  - GET    /invoices              auth-scoped list (admin all / agency own / customer own)
 *  - GET    /invoices/:id          auth-scoped full invoice record (for on-device PDF rendering)
 *  - GET    /invoices/:id/qr       auth-scoped QR code (data URL) + verify URL
 *  - GET    /invoices/:id/verifications   SUPER_ADMIN — QR verification audit trail
 *  - POST   /invoices/ensure       SUPER_ADMIN — backfill an invoice for a legacy settled payment
 *  - POST   /invoices/:id/cancel   SUPER_ADMIN — cancel (QR then reports invalid)
 *  - GET    /verify/:token         PUBLIC  — web-link verification (marks invoice checked)
 *  - POST   /invoices/verify       PUBLIC  — in-app QR scanner verification (marks invoice checked)
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '@blasti/db'
import {
  getBlastiLegalInfo,
  saveBlastiLegalInfo,
  formatInvoiceNumber,
  buildInvoiceVerifyUrl,
  ensureInvoiceForTransaction,
  ensureInvoiceForSmsPurchase,
  ensureInvoiceForHardwareOrder,
  verifyInvoiceByToken,
} from '../lib/billing-invoices'
import {
  requireAuth,
  requireAdmin,
  getSessionUser,
  resolveUserAgencyId,
  authErrorResponse,
} from '../lib/auth'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse } from '../lib/rate-limit'
import QRCode from 'qrcode'
import type { Context } from 'hono'

const app = new Hono()

function handleError(c: Context, error: unknown) {
  if (isRateLimitError(error)) {
    const rl = rateLimitErrorResponse(error)
    // 0.6.55 fix — the payload lives under rl.data (rateLimitErrorResponse
    // returns { data, status, headers }); rl.error was always undefined, so
    // rate-limited billing calls answered with a bodyless error message.
    return c.json({ success: false, error: rl.data.error }, rl.status as any)
  }
  const err = authErrorResponse(error)
  return c.json({ success: err.success, error: err.error }, err.status as any)
}

function clientIp(c: Context): string | undefined {
  try { return enforceRateLimit(c, PUBLIC_RATE_LIMIT) } catch (e) { throw e }
}

/** Parse snapshot JSON fields of an invoice row into plain objects. */
function parseInvoice(inv: {
  id: string; number: number; year: number; sourceType: string; sourceId: string
  agencyId: string | null; userId: string; recipientType: string; recipientName: string
  issuerSnapshot: string; recipientSnapshot: string; detailsSnapshot: string
  amount: number; currency: string; status: string; verificationToken: string
  verificationCount: number; lastVerifiedAt: Date | null; issuedBy: string
  issuedAt: Date; createdAt: Date; updatedAt: Date
}) {
  const safeParse = (raw: string): Record<string, unknown> => {
    try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
  }
  return {
    id: inv.id,
    displayNumber: formatInvoiceNumber(inv.year, inv.number),
    number: inv.number,
    year: inv.year,
    sourceType: inv.sourceType,
    sourceId: inv.sourceId,
    agencyId: inv.agencyId,
    userId: inv.userId,
    recipientType: inv.recipientType,
    recipientName: inv.recipientName,
    issuer: safeParse(inv.issuerSnapshot),
    recipient: safeParse(inv.recipientSnapshot),
    details: safeParse(inv.detailsSnapshot),
    amount: inv.amount,
    currency: inv.currency,
    status: inv.status,
    verificationToken: inv.verificationToken,
    verificationCount: inv.verificationCount,
    lastVerifiedAt: inv.lastVerifiedAt?.toISOString() || null,
    issuedBy: inv.issuedBy,
    issuedAt: inv.issuedAt.toISOString(),
    createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
  }
}

// ─── Scope resolution ───────────────────────────────────────────────────────

interface InvoiceScope {
  isAdmin: boolean
  agencyId: string | null
  userId: string
}

async function resolveScope(user: { id: string; role: string }): Promise<InvoiceScope> {
  if (user.role === 'SUPER_ADMIN') {
    return { isAdmin: true, agencyId: null, userId: user.id }
  }
  const agencyId = await resolveUserAgencyId(user as any).catch(() => null)
  return { isAdmin: false, agencyId, userId: user.id }
}

/** True when `inv` is visible to the resolved scope. */
function inScope(inv: { agencyId: string | null; userId: string }, scope: InvoiceScope): boolean {
  if (scope.isAdmin) return true
  if (scope.agencyId && inv.agencyId === scope.agencyId) return true
  if (inv.userId === scope.userId) return true
  return false
}

// ─── BLASTI legal info (admin) ──────────────────────────────────────────────

const legalInfoSchema = z.object({
  name: z.string().max(120).optional(),
  address: z.string().max(300).optional(),
  nif: z.string().max(60).optional(),
  nis: z.string().max(60).optional(),
  rib: z.string().max(80).optional(),
  rc: z.string().max(60).optional(),
  rcType: z.enum(['RC', 'AUTO_ENTREPRENEUR']).optional(),
  servicePhone: z.string().max(200).optional(),
})

app.get('/legal-info', async (c) => {
  try {
    await requireAdmin(c)
    const info = await getBlastiLegalInfo()
    return c.json({ success: true, legalInfo: info })
  } catch (error) {
    return handleError(c, error)
  }
})

app.put('/legal-info', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const body = legalInfoSchema.parse(await c.req.json())
    const info = await saveBlastiLegalInfo(body)
    try {
      await db.auditLog.create({
        data: {
          userId: admin.id,
          action: 'BILLING_LEGAL_INFO_UPDATE',
          entityType: 'SYSTEM_SETTING',
          entityId: 'billing_legal',
          details: JSON.stringify({ updated: Object.keys(body) }),
        },
      })
    } catch { /* audit best-effort */ }
    return c.json({ success: true, legalInfo: info })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Invoice list (scoped) ──────────────────────────────────────────────────

app.get('/invoices', async (c) => {
  try {
    const user = await requireAuth(c)
    const scope = await resolveScope(user)
    const year = c.req.query('year') ? parseInt(c.req.query('year')!, 10) : undefined
    const sourceType = c.req.query('sourceType') || undefined
    const status = c.req.query('status') || undefined
    const q = (c.req.query('q') || '').trim()
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200)
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0)

    const where: Record<string, unknown> = {}
    if (year && !Number.isNaN(year)) where.year = year
    if (sourceType) where.sourceType = sourceType
    if (status) where.status = status
    if (!scope.isAdmin) {
      where.OR = [{ agencyId: scope.agencyId ?? '__none__' }, { userId: scope.userId }]
      if (scope.agencyId) where.OR = [{ agencyId: scope.agencyId }, { userId: scope.userId }]
      else where.OR = [{ userId: scope.userId }]
    }

    // Display-number search ("0003/2026") → exact (number, year) match.
    if (q) {
      const m = q.match(/^(\d{1,6})\/(\d{4})$/)
      if (m) {
        where.number = parseInt(m[1], 10)
        where.year = parseInt(m[2], 10)
      } else {
        where.recipientName = { contains: q, mode: 'insensitive' }
      }
    }

    const [rows, total] = await Promise.all([
      db.invoice.findMany({
        where: where as any,
        orderBy: [{ createdAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      db.invoice.count({ where: where as any }),
    ])

    // 0.6.55 — page-independent KPI totals over the SAME filtered set: issued
    // count + invoiced amount (ISSUED only), cancelled count and the QR
    // verification counter sum. The panel used to compute these from the
    // loaded page only, so "invoiced total" lied whenever >50 invoices.
    const [issuedAgg, cancelledCount] = await Promise.all([
      db.invoice.aggregate({
        where: { ...(where as any), status: 'ISSUED' },
        _count: { _all: true },
        _sum: { amount: true, verificationCount: true },
      }),
      db.invoice.count({ where: { ...(where as any), status: 'CANCELLED' } as any }),
    ])
    const totals = {
      issuedCount: issuedAgg._count._all || 0,
      invoicedAmount: issuedAgg._sum.amount ?? 0,
      cancelled: cancelledCount,
      verifications: issuedAgg._sum.verificationCount ?? 0,
    }

    return c.json({
      success: true,
      invoices: rows.map(parseInvoice),
      total,
      limit,
      offset,
      totals,
    })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── 0.6.55 — legacy backfill STATUS (admin) ────────────────────────────────
// NOTE: MUST stay BEFORE GET /invoices/:id — otherwise Hono matches
// "backfill-status" as an :id (same trap admin.ts documents for
// /hardware/orders/stats). Drives the manager's backfill banner.
app.get('/invoices/backfill-status', async (c) => {
  try {
    await requireAdmin(c)
    const settledTx = await db.transaction.findMany({
      where: { status: { in: ['APPROVED', 'COMPLETED'] }, type: { not: 'HARDWARE' } },
      select: { id: true },
    })
    const settledSms = await db.smsPurchase.findMany({
      where: { status: 'APPROVED' },
      select: { id: true },
    })
    const candidateIds = [...settledTx.map((t) => t.id), ...settledSms.map((s) => s.id)]
    const invoiced = await db.invoice.findMany({
      where: { sourceId: { in: candidateIds } },
      select: { sourceId: true },
    })
    const invoicedSet = new Set(invoiced.map((i) => i.sourceId))
    const missing = candidateIds.filter((id) => !invoicedSet.has(id))
    return c.json({
      success: true,
      missing: missing.length,
      candidates: candidateIds.length,
      byType: {
        transaction: settledTx.filter((t) => !invoicedSet.has(t.id)).length,
        sms: settledSms.filter((s) => !invoicedSet.has(s.id)).length,
      },
    })
  } catch (error) {
    return handleError(c, error)
  }
})

const backfillAllSchema = z.object({
  /** Per-call batch cap — the button repeats until "missing" hits zero. */
  max: z.number().int().min(1).max(500).optional(),
})

/**
 * POST /api/billing/invoices/backfill-all
 * Idempotently issues invoices for up to `max` (default 100) settled payments
 * that lack one. Returns what was created and how many remain, so the UI can
 * loop or report completion. Year attribution follows the PAYMENT's year
 * (createdAt) via the ensure helpers' numbering when they run in that year —
 * the invoice NUMBER sequence stays per-issue-year as designed.
 */
app.post('/invoices/backfill-all', async (c) => {
  try {
    const admin = await requireAdmin(c)
    let max = 100
    try {
      const parsed = backfillAllSchema.parse(await c.req.json().catch(() => ({})))
      max = parsed.max ?? 100
    } catch { /* default cap */ }

    const settledTx = await db.transaction.findMany({
      where: { status: { in: ['APPROVED', 'COMPLETED'] }, type: { not: 'HARDWARE' } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    const settledSms = await db.smsPurchase.findMany({
      where: { status: 'APPROVED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    const candidateIds: Array<{ sourceType: 'TRANSACTION' | 'SMS'; sourceId: string }> = [
      ...settledTx.map((t) => ({ sourceType: 'TRANSACTION' as const, sourceId: t.id })),
      ...settledSms.map((s) => ({ sourceType: 'SMS' as const, sourceId: s.id })),
    ]
    const invoiced = await db.invoice.findMany({
      where: { sourceId: { in: candidateIds.map((x) => x.sourceId) } },
      select: { sourceId: true },
    })
    const invoicedSet = new Set(invoiced.map((i) => i.sourceId))
    const missing = candidateIds.filter((x) => !invoicedSet.has(x.sourceId))

    let created = 0
    let failed = 0
    const errors: Array<{ sourceId: string; error: string }> = []
    for (const candidate of missing.slice(0, max)) {
      try {
        const result = candidate.sourceType === 'TRANSACTION'
          ? await ensureInvoiceForTransaction(candidate.sourceId, { issuedBy: `ADMIN:${admin.id}` })
          : await ensureInvoiceForSmsPurchase(candidate.sourceId, { issuedBy: `ADMIN:${admin.id}` })
        if (result) created += 1
        else failed += 1
      } catch (err) {
        failed += 1
        errors.push({ sourceId: candidate.sourceId, error: (err as Error)?.message || String(err) })
      }
    }

    try {
      await db.auditLog.create({
        data: {
          userId: admin.id,
          action: 'INVOICE_BACKFILL_RUN',
          entityType: 'INVOICE',
          entityId: 'backfill-all',
          details: JSON.stringify({ created, failed, remaining: Math.max(0, missing.length - created - failed), scanned: candidateIds.length }),
        },
      })
    } catch { /* audit best-effort */ }

    return c.json({
      success: true,
      created,
      failed,
      remaining: Math.max(0, missing.length - created - failed),
      scanned: candidateIds.length,
      errors: errors.slice(0, 10),
    })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Invoice detail (scoped) ────────────────────────────────────────────────

app.get('/invoices/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    const scope = await resolveScope(user)
    const inv = await db.invoice.findUnique({ where: { id: c.req.param('id') } })
    if (!inv) return c.json({ success: false, error: 'Invoice not found' }, 404)
    if (!inScope(inv, scope)) return c.json({ success: false, error: 'Access denied' }, 403)
    return c.json({ success: true, invoice: parseInvoice(inv) })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Invoice QR (scoped) ────────────────────────────────────────────────────

app.get('/invoices/:id/qr', async (c) => {
  try {
    const user = await requireAuth(c)
    const scope = await resolveScope(user)
    const inv = await db.invoice.findUnique({ where: { id: c.req.param('id') } })
    if (!inv) return c.json({ success: false, error: 'Invoice not found' }, 404)
    if (!inScope(inv, scope)) return c.json({ success: false, error: 'Access denied' }, 403)

    const verifyUrl = buildInvoiceVerifyUrl(inv.verificationToken)
    const dataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
    return c.json({ success: true, dataUrl, verifyUrl, token: inv.verificationToken })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Verification audit trail (admin) ───────────────────────────────────────

app.get('/invoices/:id/verifications', async (c) => {
  try {
    await requireAdmin(c)
    const events = await db.invoiceVerification.findMany({
      where: { invoiceId: c.req.param('id') },
      orderBy: { verifiedAt: 'desc' },
      take: 100,
    })
    return c.json({
      success: true,
      verifications: events.map((v) => ({
        id: v.id,
        verifierRole: v.verifierRole,
        verifierId: v.verifierId,
        ip: v.ip,
        verifiedAt: v.verifiedAt.toISOString(),
      })),
    })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Backfill (admin) — issue an invoice for a legacy settled payment ───────

const ensureSchema = z.object({
  sourceType: z.enum(['TRANSACTION', 'SMS']),
  sourceId: z.string().min(1),
})

app.post('/invoices/ensure', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const { sourceType, sourceId } = ensureSchema.parse(await c.req.json())
    const result = sourceType === 'TRANSACTION'
      ? await ensureInvoiceForTransaction(sourceId, { issuedBy: `ADMIN:${admin.id}` })
      : await ensureInvoiceForSmsPurchase(sourceId, { issuedBy: `ADMIN:${admin.id}` })
    if (!result) {
      return c.json({ success: false, error: 'Payment not found, not settled, or not invoiceable' }, 400)
    }
    const inv = await db.invoice.findUnique({ where: { id: result.id } })
    return c.json({ success: true, invoice: inv ? parseInvoice(inv) : null })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Cancel (admin) — QR then reports invalid ───────────────────────────────

app.post('/invoices/:id/cancel', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const inv = await db.invoice.findUnique({ where: { id: c.req.param('id') } })
    if (!inv) return c.json({ success: false, error: 'Invoice not found' }, 404)
    const updated = await db.invoice.update({
      where: { id: inv.id },
      data: { status: 'CANCELLED' },
    })
    try {
      await db.auditLog.create({
        data: {
          userId: admin.id,
          action: 'INVOICE_CANCEL',
          entityType: 'INVOICE',
          entityId: inv.id,
          details: JSON.stringify({ displayNumber: formatInvoiceNumber(inv.year, inv.number) }),
        },
      })
    } catch { /* audit best-effort */ }
    return c.json({ success: true, invoice: parseInvoice(updated) })
  } catch (error) {
    return handleError(c, error)
  }
})

// ─── Public verification (QR scan / web link) ───────────────────────────────

async function handleVerify(c: Context, token: string) {
  // Rate limit BEFORE any DB work (public endpoint).
  let ip: string | undefined
  try {
    ip = enforceRateLimit(c, PUBLIC_RATE_LIMIT)
  } catch (error) {
    if (isRateLimitError(error)) {
      const rl = rateLimitErrorResponse(error)
      return c.json({ success: false, error: rl.error }, rl.status as any)
    }
    throw error
  }

  // Optional session — when the scanner runs inside an authenticated app,
  // the verification is attributed to the account that checked it.
  const session = await getSessionUser(c).catch(() => null)

  const result = await verifyInvoiceByToken(token, {
    role: session?.role,
    id: session?.id,
    ip,
  })

  return c.json({ success: result.valid, ...result })
}

app.get('/verify/:token', async (c) => {
  try {
    return await handleVerify(c, c.req.param('token'))
  } catch (error) {
    return handleError(c, error)
  }
})

app.post('/invoices/verify', async (c) => {
  try {
    const body = z.object({ token: z.string().min(10).max(200) }).parse(await c.req.json())
    return await handleVerify(c, body.token.trim())
  } catch (error) {
    return handleError(c, error)
  }
})

export const billingRoutes = app
