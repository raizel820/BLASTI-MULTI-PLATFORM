import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import {
  enforceRateLimit,
  PUBLIC_RATE_LIMIT,
  isRateLimitError,
  rateLimitErrorResponse,
  recordSuccessfulRequest,
} from '../lib/rate-limit'
import { ensureDefaultLegalDocuments, getActiveLegalDocument } from '../lib/legal-server'
import { LEGAL_DOC_TYPES, LEGAL_DOC_TYPE_LABELS } from '../lib/legal'

const app = new Hono()

// ─── Public surface (no auth) ───────────────────────────────────────────────

/**
 * GET /api/legal-documents
 * Active versions, localized. Query:
 *   types=AGREEMENT_CUSTOMER,PRIVACY_POLICY  (subset; default = all four)
 *   lang=en|fr|ar                            (fallback chain ar→content, fr→content)
 * Used by registration forms (customers/owners), the staff-create dialog and
 * the create-agency wizard to show the exact document being agreed to.
 */
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)
    await ensureDefaultLegalDocuments()

    const lang = (c.req.query('lang') || 'en').toLowerCase()
    const typesParam = (c.req.query('types') || '').split(',').map((t) => t.trim()).filter(Boolean)
    const types = typesParam.length ? typesParam.filter((t) => LEGAL_DOC_TYPES.includes(t)) : LEGAL_DOC_TYPES

    const documents = []
    for (const docType of LEGAL_DOC_TYPES) {
      if (!types.includes(docType)) continue
      const doc = await getActiveLegalDocument(docType)
      if (!doc) continue
      documents.push({
        docType: doc.docType,
        version: doc.version,
        title: lang === 'ar' && doc.titleAr ? doc.titleAr : lang === 'fr' && doc.titleFr ? doc.titleFr : doc.title,
        content: lang === 'ar' && doc.contentAr ? doc.contentAr : lang === 'fr' && doc.contentFr ? doc.contentFr : doc.content,
        effectiveDate: doc.effectiveDate,
        updatedAt: doc.updatedAt,
      })
    }

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ documents, labels: LEGAL_DOC_TYPE_LABELS })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[legal-documents GET] Error:', message)
    return c.json({ error: 'Operation failed', details: message }, 500)
  }
})

// ─── Admin surface (SUPER_ADMIN) ────────────────────────────────────────────

const DOC_TYPE_ENUM = ['AGREEMENT_AGENCY_OWNER', 'AGREEMENT_STAFF', 'AGREEMENT_CUSTOMER', 'PRIVACY_POLICY'] as const

const publishSchema = z.object({
  docType: z.enum(DOC_TYPE_ENUM),
  title: z.string().min(1, 'Title is required').max(300),
  titleFr: z.string().max(300).optional().or(z.literal('')),
  titleAr: z.string().max(300).optional().or(z.literal('')),
  content: z.string().min(1, 'Document content is required').max(400_000),
  contentFr: z.string().max(400_000).optional().or(z.literal('')),
  contentAr: z.string().max(400_000).optional().or(z.literal('')),
})

const activateSchema = z.object({
  id: z.string().min(1, 'Document ID is required'),
})

/**
 * GET /api/legal-documents/admin — every version of every document, newest
 * first, plus the consent-ledger summary. Powers the admin Legal & Agreements
 * console (read / edit / download / activate).
 */
app.get('/admin', async (c) => {
  try {
    await requireAdmin(c)
    await ensureDefaultLegalDocuments()

    const docs = await db.legalDocument.findMany({
      orderBy: [{ docType: 'asc' }, { version: 'desc' }],
    })
    const consents = await db.consentRecord.count()
    return c.json({
      documents: docs,
      labels: LEGAL_DOC_TYPE_LABELS,
      docTypes: LEGAL_DOC_TYPES,
      consentsRecorded: consents,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

/**
 * POST /api/legal-documents/admin — publish an edited agreement as a NEW
 * version: the previous active row is deactivated, the new row becomes active
 * immediately with an effectiveDate of now. Old versions stay on disk for
 * audit and download (they remain referenceable by every consent record).
 */
app.post('/admin', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(publishSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const { docType, title, titleFr, titleAr, content, contentFr, contentAr } = validation.data

    const latest = await db.legalDocument.findFirst({
      where: { docType },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    const nextVersion = (latest?.version ?? 0) + 1

    const doc = await db.$transaction(async (tx) => {
      await tx.legalDocument.updateMany({ where: { docType, isActive: true }, data: { isActive: false } })
      return tx.legalDocument.create({
        data: {
          docType,
          version: nextVersion,
          title,
          titleFr: titleFr || null,
          titleAr: titleAr || null,
          content,
          contentFr: contentFr || null,
          contentAr: contentAr || null,
          isActive: true,
          effectiveDate: new Date(),
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      })
    })

    return c.json({ success: true, document: doc }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

/**
 * PUT /api/legal-documents/admin/activate — roll back to a previous version:
 * deactivates the current active row and activates the targeted one.
 */
app.put('/admin/activate', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(activateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const target = await db.legalDocument.findUnique({ where: { id: validation.data.id } })
    if (!target) {
      return c.json({ success: false, error: 'Document version not found' }, 404)
    }

    const doc = await db.$transaction(async (tx) => {
      await tx.legalDocument.updateMany({ where: { docType: target.docType, isActive: true }, data: { isActive: false } })
      return tx.legalDocument.update({
        where: { id: target.id },
        data: { isActive: true, effectiveDate: new Date(), updatedBy: admin.id },
      })
    })

    return c.json({ success: true, document: doc })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

/**
 * GET /api/legal-documents/admin/consents — the proof-of-consent ledger,
 * newest first (joined with the basic user identity for readability).
 */
app.get('/admin/consents', async (c) => {
  try {
    await requireAdmin(c)

    const take = Math.min(Number(c.req.query('limit')) || 100, 500)
    const records = await db.consentRecord.findMany({
      orderBy: { consentedAt: 'desc' },
      take,
    })
    const userIds = [...new Set(records.map((r) => r.userId))]
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, fullName: true, role: true },
    })
    const userMap = new Map(users.map((u) => [u.id, u]))
    const total = await db.consentRecord.count()

    return c.json({
      total,
      consents: records.map((r) => ({
        id: r.id,
        userId: r.userId,
        username: userMap.get(r.userId)?.username ?? null,
        fullName: userMap.get(r.userId)?.fullName ?? null,
        role: userMap.get(r.userId)?.role ?? null,
        docType: r.docType,
        docVersion: r.docVersion,
        context: r.context,
        requestIp: r.requestIp,
        consentedAt: r.consentedAt,
      })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const legalDocumentRoutes = app
