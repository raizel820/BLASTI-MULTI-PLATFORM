/**
 * @blasti/api — Agency Categories routes (Agencies Management)
 *
 * The AgencyCategory dictionary is the single source of truth for agency
 * categories. `slug` is the stable identity stored in Agency.category
 * (built-ins: DOCTOR | CLINIC | LAW_FIRM | BARBER; custom rows: their name —
 * the legacy contract). The admin Categories Manager + Categories Language
 * pages drive this route file.
 *
 * Routes:
 *   GET    /api/agency-categories                      — any authenticated role → active rows (+specialties); ?all=1 for admin
 *   POST   /api/agency-categories                      — agency roles → create custom category
 *   PATCH  /api/agency-categories/:id                  — SUPER_ADMIN → edit names/icon/active/order (+slug for custom rows)
 *   DELETE /api/agency-categories/:id                  — SUPER_ADMIN → delete (blocked when agencies attached)
 *   POST   /api/agency-categories/:id/specialties      — SUPER_ADMIN → add specialty
 *   PATCH  /api/agency-categories/specialties/:specId  — SUPER_ADMIN → edit specialty
 *   DELETE /api/agency-categories/specialties/:specId  — SUPER_ADMIN → delete specialty (strips agency references)
 *   GET    /api/agency-categories/terms                — any authenticated role → terms (?category=SLUG or all for admin)
 *   POST   /api/agency-categories/:id/terms            — SUPER_ADMIN → add term override
 *   PATCH  /api/agency-categories/terms/:termId        — SUPER_ADMIN → edit term
 *   DELETE /api/agency-categories/terms/:termId        — SUPER_ADMIN → delete term
 *
 * Sync: AgencyCategory stays in SYNC_TRACKED_MODELS (packages/db) — the
 * auto-tracking extension records SyncChanges for create/update/delete.
 * Specialty/CategoryTerm are cloud-only by design (not synced).
 */

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { db, Prisma } from '@blasti/db'
import { ensureCategoryDictionary } from '../lib/ensure-category-dictionary'
import { requireAuth, requireRole, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { BUILT_IN_AGENCY_CATEGORY_KEYS } from '../lib/enums'
import { enforceRateLimit, GENERAL_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'
// Performance Round — eager invalidation of cached public GETs.
import { invalidateResponseCacheTag } from '../lib/response-cache'

const app = new Hono()

// Task 42-b: body contract. `name` is length-validated AFTER normalization
// (trim + collapse internal whitespace), so the zod schema only pins the TYPES.
const createCategorySchema = z.object({
  name: z.string(),
  nameFr: z.string().nullable().optional(),
  nameAr: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
})

const updateCategorySchema = z.object({
  name: z.string().min(2).max(40).optional(),
  nameFr: z.string().max(40).nullable().optional(),
  nameAr: z.string().max(40).nullable().optional(),
  icon: z.string().max(8).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  slug: z.string().min(2).max(40).optional(),
})

const specialtySchema = z.object({
  nameEn: z.string().min(1).max(80),
  nameAr: z.string().min(1).max(80),
  nameFr: z.string().min(1).max(80),
  sortOrder: z.number().int().min(0).max(999).optional(),
})

const specialtyUpdateSchema = specialtySchema.partial().extend({
  isActive: z.boolean().optional(),
})

const termSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{1,59}$/, 'key must be an i18n dictionary key (letters/digits/dots)'),
  valueAr: z.string().min(1).max(120),
  valueEn: z.string().min(1).max(120),
  valueFr: z.string().min(1).max(120),
})

const termUpdateSchema = termSchema.partial()

/** Trim + collapse internal whitespace runs to single spaces. */
function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** Case-insensitive collision check against built-in keys + existing rows. */
async function categoryCollisionError(candidate: string, excludeId?: string): Promise<boolean> {
  const lower = candidate.toLowerCase()
  if (BUILT_IN_AGENCY_CATEGORY_KEYS.some((key) => key.toLowerCase() === lower)) return true
  const rows = await db.agencyCategory.findMany({
    where: excludeId ? { id: { not: excludeId } } : {},
    select: { name: true, slug: true },
  })
  return rows.some((row) => row.name.toLowerCase() === lower || row.slug.toLowerCase() === lower)
}

/** JSON-string containment filter for Agency.specialtyIds (quoted id = exact boundaries). */
function agenciesWithSpecialtyWhere(specialtyId: string) {
  return { specialtyIds: { contains: `"${specialtyId}"` } }
}

// ─── GET / — list categories (any authenticated role) ───────────────────────

app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    const user = await requireAuth(c)
    const wantAll = c.req.query('all') === '1' && user.role === 'SUPER_ADMIN'

    // Self-healing dictionary (memoized no-op after first success) — a fresh
    // environment (e.g. the VPS before its first seed) answers with real data
    // instead of an empty list.
    await ensureCategoryDictionary()

    const categories = await db.agencyCategory.findMany({
      where: wantAll ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        specialties: {
          where: wantAll ? {} : { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }],
          select: { id: true, nameEn: true, nameAr: true, nameFr: true, isActive: true },
        },
      },
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({ success: true, data: categories })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      // Rate limiting IS the punishment — a 429 must NOT also feed the
      // abuse blocker (10 failures/5min → 30-min IP lockout), otherwise a
      // single burst locks a legitimate user out of every public route.
      // Genuine business 4xxs (400/404) below still record failures.
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] GET Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /terms — terminology overrides (any authenticated role) ────────────

app.get('/terms', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    const user = await requireAuth(c)
    const slug = c.req.query('category')

    // Same self-healing guarantee as GET / (memoized — zero cost when warm).
    await ensureCategoryDictionary()

    if (slug) {
      const category = await db.agencyCategory.findUnique({
        where: { slug },
        select: { id: true, slug: true, name: true },
      })
      if (!category) {
        return c.json({ success: false, error: 'CATEGORY_NOT_FOUND' }, 404)
      }
      const terms = await db.categoryTerm.findMany({
        where: { categoryId: category.id },
        orderBy: { key: 'asc' },
      })
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({ success: true, data: { category, terms } })
    }

    // No category param → admin overview (all terms with their category).
    if (user.role !== 'SUPER_ADMIN') {
      return c.json({ success: false, error: 'FORBIDDEN' }, 403)
    }
    const terms = await db.categoryTerm.findMany({
      orderBy: [{ categoryId: 'asc' }, { key: 'asc' }],
      include: { category: { select: { id: true, slug: true, name: true, nameAr: true, nameFr: true, icon: true } } },
    })
    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ success: true, data: terms })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] GET terms Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST / — create a custom category (agency roles only) ──────────────────

app.post('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    // 401 anonymous, 403 CUSTOMER / any other non-agency role
    const user = await requireRole(c, 'AGENCY_OWNER', 'AGENCY_STAFF', 'SUPER_ADMIN')

    const body = await c.req.json()
    const validation = validateBody(createCategorySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const name = normalizeCategoryName(validation.data.name)
    if (name.length < 2 || name.length > 40) {
      return c.json({ success: false, error: 'INVALID_NAME' }, 400)
    }

    // Collision check, case-insensitive, against BOTH the built-in key
    // dictionary and existing rows (SQLite Prisma has no mode:'insensitive',
    // so compare in JS — the table is small).
    if (await categoryCollisionError(name)) {
      return c.json({ success: false, error: 'CATEGORY_EXISTS' }, 409)
    }

    let category
    try {
      category = await db.$transaction(async (tx) => {
        const row = await tx.agencyCategory.create({
          data: {
            id: randomUUID(),
            slug: name, // legacy contract: the name is the value stored in Agency.category
            name,
            nameFr: validation.data.nameFr ?? null,
            nameAr: validation.data.nameAr ?? null,
            icon: validation.data.icon ?? null,
            isCustom: true,
            isActive: true,
            sortOrder: 100,
            createdBy: user.id,
          },
        })
        // Services Management matrix: give the new category a default policy row.
        await tx.servicePolicy.createMany({
          data: [{ agencyCategory: row.slug }],
          skipDuplicates: true,
        })
        return row
      })
    } catch (createErr) {
      // Unique-constraint race: two concurrent creates with the same name —
      // surface the client-handled 409, never a raw 500.
      if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2002') {
        return c.json({ success: false, error: 'CATEGORY_EXISTS' }, 409)
      }
      throw createErr
    }

    if (clientIp) recordSuccessfulRequest(clientIp)

    // Performance Round — the dictionary feeds the customer filter bar.
    invalidateResponseCacheTag('categories')

    return c.json({ success: true, data: category }, 201)
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] POST Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── PATCH /:id — edit a category (SUPER_ADMIN) ─────────────────────────────

app.patch('/:id', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(updateCategorySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const data = validation.data

    const category = await db.agencyCategory.findUnique({ where: { id } })
    if (!category) {
      return c.json({ success: false, error: 'CATEGORY_NOT_FOUND' }, 404)
    }

    // Name change → collision check.
    if (data.name !== undefined) {
      const name = normalizeCategoryName(data.name)
      if (name.length < 2 || name.length > 40) {
        return c.json({ success: false, error: 'INVALID_NAME' }, 400)
      }
      if (name !== category.name && (await categoryCollisionError(name, id))) {
        return c.json({ success: false, error: 'CATEGORY_EXISTS' }, 409)
      }
      data.name = name
    }

    // Slug change → custom rows only, collision-checked, and every agency
    // row carrying the old slug is repointed inside one transaction.
    let slugChange: { from: string; to: string } | null = null
    if (data.slug !== undefined && data.slug !== category.slug) {
      if (category.isCustom === false) {
        return c.json({ success: false, error: 'BUILT_IN_SLUG_IMMUTABLE' }, 400)
      }
      const slug = data.slug.trim()
      if (slug.length < 2 || slug.length > 40) {
        return c.json({ success: false, error: 'INVALID_SLUG' }, 400)
      }
      if (await categoryCollisionError(slug, id)) {
        return c.json({ success: false, error: 'CATEGORY_EXISTS' }, 409)
      }
      slugChange = { from: category.slug, to: slug }
    }

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.agencyCategory.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.nameFr !== undefined && { nameFr: data.nameFr }),
          ...(data.nameAr !== undefined && { nameAr: data.nameAr }),
          ...(data.icon !== undefined && { icon: data.icon }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
          ...(slugChange && { slug: slugChange.to }),
        },
      })
      if (slugChange) {
        await tx.agency.updateMany({
          where: { category: slugChange.from },
          data: { category: slugChange.to },
        })
      }
      return row
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    invalidateResponseCacheTag('categories')

    return c.json({ success: true, data: updated })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] PATCH Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── DELETE /:id — delete a category (SUPER_ADMIN) ──────────────────────────

app.delete('/:id', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const id = c.req.param('id')
    const category = await db.agencyCategory.findUnique({ where: { id } })
    if (!category) {
      return c.json({ success: false, error: 'CATEGORY_NOT_FOUND' }, 404)
    }

    // Agencies may reference the slug OR the legacy name (pre-slug rows).
    const agencyCount = await db.agency.count({
      where: { OR: [{ category: category.slug }, { category: category.name }] },
    })
    if (agencyCount > 0) {
      return c.json(
        { success: false, error: 'AGENCY_CATEGORY_IN_USE', agencyCount },
        409,
      )
    }

    await db.agencyCategory.delete({ where: { id } })

    if (clientIp) recordSuccessfulRequest(clientIp)
    invalidateResponseCacheTag('categories')

    return c.json({ success: true })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] DELETE Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Specialties ────────────────────────────────────────────────────────────

// POST /:id/specialties — add a specialty (SUPER_ADMIN)
app.post('/:id/specialties', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const id = c.req.param('id')
    const category = await db.agencyCategory.findUnique({ where: { id }, select: { id: true } })
    if (!category) {
      return c.json({ success: false, error: 'CATEGORY_NOT_FOUND' }, 404)
    }

    const body = await c.req.json()
    const validation = validateBody(specialtySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const nameEn = validation.data.nameEn.trim()
    const dupe = await db.specialty.findFirst({
      where: { categoryId: id, nameEn: { equals: nameEn, mode: 'insensitive' } },
      select: { id: true },
    })
    if (dupe) {
      return c.json({ success: false, error: 'SPECIALTY_EXISTS' }, 409)
    }

    try {
      const specialty = await db.specialty.create({
        data: {
          categoryId: id,
          nameEn,
          nameAr: validation.data.nameAr.trim(),
          nameFr: validation.data.nameFr.trim(),
          sortOrder: validation.data.sortOrder ?? 100,
        },
      })
      if (clientIp) recordSuccessfulRequest(clientIp)
      invalidateResponseCacheTag('categories')
      return c.json({ success: true, data: specialty }, 201)
    } catch (createErr) {
      if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2002') {
        return c.json({ success: false, error: 'SPECIALTY_EXISTS' }, 409)
      }
      throw createErr
    }
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] POST specialty Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /specialties/:specId — edit a specialty (SUPER_ADMIN)
app.patch('/specialties/:specId', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const specId = c.req.param('specId')
    const body = await c.req.json()
    const validation = validateBody(specialtyUpdateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const existing = await db.specialty.findUnique({ where: { id: specId } })
    if (!existing) {
      return c.json({ success: false, error: 'SPECIALTY_NOT_FOUND' }, 404)
    }

    const data = validation.data
    if (data.nameEn !== undefined && data.nameEn.trim().toLowerCase() !== existing.nameEn.toLowerCase()) {
      const dupe = await db.specialty.findFirst({
        where: { categoryId: existing.categoryId, nameEn: { equals: data.nameEn.trim(), mode: 'insensitive' }, id: { not: specId } },
        select: { id: true },
      })
      if (dupe) return c.json({ success: false, error: 'SPECIALTY_EXISTS' }, 409)
    }

    const specialty = await db.specialty.update({
      where: { id: specId },
      data: {
        ...(data.nameEn !== undefined && { nameEn: data.nameEn.trim() }),
        ...(data.nameAr !== undefined && { nameAr: data.nameAr.trim() }),
        ...(data.nameFr !== undefined && { nameFr: data.nameFr.trim() }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    invalidateResponseCacheTag('categories')
    return c.json({ success: true, data: specialty })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] PATCH specialty Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /specialties/:specId — delete a specialty (SUPER_ADMIN)
app.delete('/specialties/:specId', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const specId = c.req.param('specId')
    const existing = await db.specialty.findUnique({ where: { id: specId } })
    if (!existing) {
      return c.json({ success: false, error: 'SPECIALTY_NOT_FOUND' }, 404)
    }

    // Strip the id from every agency referencing it (JSON column, no FK).
    const referencing = await db.agency.findMany({
      where: agenciesWithSpecialtyWhere(specId),
      select: { id: true, specialtyIds: true },
    })
    await db.$transaction(async (tx) => {
      await tx.specialty.delete({ where: { id: specId } })
      for (const agency of referencing) {
        const ids: string[] = (() => {
          try {
            const parsed = JSON.parse(agency.specialtyIds ?? '[]')
            return Array.isArray(parsed) ? parsed.filter((v: unknown): v is string => typeof v === 'string' && v !== specId) : []
          } catch {
            return []
          }
        })()
        await tx.agency.update({ where: { id: agency.id }, data: { specialtyIds: JSON.stringify(ids) } })
      }
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    invalidateResponseCacheTag('categories')
    return c.json({ success: true })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] DELETE specialty Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Terminology ────────────────────────────────────────────────────────────

// POST /:id/terms — add a term override (SUPER_ADMIN)
app.post('/:id/terms', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const id = c.req.param('id')
    const category = await db.agencyCategory.findUnique({ where: { id }, select: { id: true } })
    if (!category) {
      return c.json({ success: false, error: 'CATEGORY_NOT_FOUND' }, 404)
    }

    const body = await c.req.json()
    const validation = validateBody(termSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    try {
      const term = await db.categoryTerm.create({
        data: {
          categoryId: id,
          key: validation.data.key,
          valueAr: validation.data.valueAr.trim(),
          valueEn: validation.data.valueEn.trim(),
          valueFr: validation.data.valueFr.trim(),
        },
      })
      if (clientIp) recordSuccessfulRequest(clientIp)
      invalidateResponseCacheTag('categories')
      return c.json({ success: true, data: term }, 201)
    } catch (createErr) {
      if (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === 'P2002') {
        return c.json({ success: false, error: 'TERM_EXISTS' }, 409)
      }
      throw createErr
    }
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] POST term Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /terms/:termId — edit a term (SUPER_ADMIN)
app.patch('/terms/:termId', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const termId = c.req.param('termId')
    const body = await c.req.json()
    const validation = validateBody(termUpdateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const existing = await db.categoryTerm.findUnique({ where: { id: termId } })
    if (!existing) {
      return c.json({ success: false, error: 'TERM_NOT_FOUND' }, 404)
    }

    const data = validation.data
    const term = await db.categoryTerm.update({
      where: { id: termId },
      data: {
        ...(data.key !== undefined && { key: data.key }),
        ...(data.valueAr !== undefined && { valueAr: data.valueAr.trim() }),
        ...(data.valueEn !== undefined && { valueEn: data.valueEn.trim() }),
        ...(data.valueFr !== undefined && { valueFr: data.valueFr.trim() }),
      },
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    invalidateResponseCacheTag('categories')
    return c.json({ success: true, data: term })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] PATCH term Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /terms/:termId — delete a term (SUPER_ADMIN)
app.delete('/terms/:termId', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireRole(c, 'SUPER_ADMIN')

    const termId = c.req.param('termId')
    const existing = await db.categoryTerm.findUnique({ where: { id: termId } })
    if (!existing) {
      return c.json({ success: false, error: 'TERM_NOT_FOUND' }, 404)
    }

    await db.categoryTerm.delete({ where: { id: termId } })

    if (clientIp) recordSuccessfulRequest(clientIp)
    invalidateResponseCacheTag('categories')
    return c.json({ success: true })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[AGENCY-CATEGORIES] DELETE term Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const agencyCategoriesRoutes = app
