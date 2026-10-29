/**
 * @blasti/api — Service field policy routes (AUD-1 roadmap: Services Management)
 *
 * Lets the SUPER_ADMIN decide, per agency category, whether Service fields
 * (currently: price) are OPTIONAL or MANDATORY — and exposes the caller's
 * own agency policy to agency roles so the UI can mark fields accordingly.
 * Enforcement happens in the service write paths (see lib/service-policy.ts).
 *
 * Routes (mounted at /api/service-policies):
 *   GET  /       — SUPER_ADMIN → full policy matrix + merged category catalog
 *   PUT  /       — SUPER_ADMIN → upsert one (category, field) policy row
 *   GET  /mine   — any agency role → policies for the caller's agency category
 *
 * Cache: PUT invalidates the 'categories' + 'stats' response-cache tags so
 * cached public reads never serve stale policy-derived data.
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '@blasti/db'
import { requireAuth, requireAdmin, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { BUILT_IN_AGENCY_CATEGORY_KEYS } from '../lib/enums'
import { SERVICE_POLICY_FIELDS, isServicePolicyField } from '../lib/service-policy'
import { invalidateResponseCacheTag } from '../lib/response-cache'
import { enforceRateLimit, GENERAL_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

const upsertPolicySchema = z.object({
  category: z.string().min(1).max(64),
  field: z.string().min(1).max(32),
  isRequired: z.boolean(),
})

// ─── GET / — admin policy matrix + category catalog ──────────────────────────

app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    await requireAdmin(c)

    // Category catalog = built-in keys ∪ AgencyCategory dictionary rows ∪
    // any category actually in use on an agency (legacy/free-text values).
    const [customRows, usedGroups, policies] = await Promise.all([
      db.agencyCategory.findMany({ orderBy: { name: 'asc' } }),
      db.agency.groupBy({ by: ['category'], _count: { _all: true } }),
      db.serviceFieldPolicy.findMany({ orderBy: [{ category: 'asc' }, { field: 'asc' }] }),
    ])

    const countByCategory = new Map<string, number>(
      usedGroups.map((g) => [g.category, g._count._all])
    )

    interface CategoryEntry {
      name: string
      nameAr: string | null
      nameFr: string | null
      icon: string | null
      isCustom: boolean
      agencyCount: number
    }

    const catalog = new Map<string, CategoryEntry>()

    for (const key of BUILT_IN_AGENCY_CATEGORY_KEYS) {
      catalog.set(key, { name: key, nameAr: null, nameFr: null, icon: null, isCustom: false, agencyCount: countByCategory.get(key) ?? 0 })
    }
    for (const row of customRows) {
      catalog.set(row.name, {
        name: row.name,
        nameAr: row.nameAr,
        nameFr: row.nameFr,
        icon: row.icon,
        isCustom: true,
        agencyCount: countByCategory.get(row.name) ?? 0,
      })
    }
    // Legacy categories that exist only on agencies (not built-in, not custom).
    for (const [category, count] of countByCategory) {
      if (!catalog.has(category)) {
        catalog.set(category, { name: category, nameAr: null, nameFr: null, icon: null, isCustom: false, agencyCount: count })
      }
    }

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      fields: SERVICE_POLICY_FIELDS,
      categories: Array.from(catalog.values()).sort((a, b) => a.name.localeCompare(b.name)),
      policies,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── PUT / — upsert one policy row (SUPER_ADMIN) ─────────────────────────────

app.put('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(upsertPolicySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    if (!isServicePolicyField(validation.data.field)) {
      return c.json({ success: false, error: `Unknown service policy field "${validation.data.field}"` }, 400)
    }

    const category = validation.data.category.trim()
    if (!category) {
      return c.json({ success: false, error: 'Category is required' }, 400)
    }

    const policy = await db.serviceFieldPolicy.upsert({
      where: { category_field: { category, field: validation.data.field } },
      create: {
        category,
        field: validation.data.field,
        isRequired: validation.data.isRequired,
        updatedBy: admin.id,
      },
      update: {
        isRequired: validation.data.isRequired,
        updatedBy: admin.id,
      },
    })

    invalidateResponseCacheTag('categories', 'stats')
    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({ success: true, policy })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    if (err.status === 500) {
      console.error('[SERVICE-POLICIES] PUT Error:', error instanceof Error ? error.message : error)
    }
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /mine — the caller's own agency policy (agency roles) ───────────────

app.get('/mine', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)
    const user = await requireAuth(c)

    const agencyId = user.agencyId ?? null
    const agency = agencyId
      ? await db.agency.findUnique({ where: { id: agencyId }, select: { category: true } })
      : null

    if (!agency) {
      return c.json({ success: true, category: null, policies: [] })
    }

    const policies = await db.serviceFieldPolicy.findMany({
      where: { category: agency.category },
      select: { field: true, isRequired: true },
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ success: true, category: agency.category, policies })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export { app as servicePolicyRoutes }
