/**
 * @blasti/api — Agency Categories routes (Task 42-b)
 *
 * User-created agency "fields"/industries on top of the BUILT_IN_AGENCY_CATEGORY_KEYS
 * dictionary (apps/api/src/lib/enums.ts). Categories are a GLOBAL shared dictionary
 * (AgencyCategory model, Task 42-a) — any authenticated caller (including CUSTOMER)
 * may LIST them (customer browse/filters use this), but only agency roles may CREATE.
 *
 * Routes:
 *   GET  /api/agency-categories  — any authenticated role → { success, data: [rows] }
 *   POST /api/agency-categories  — AGENCY_OWNER | AGENCY_STAFF | SUPER_ADMIN → 201 { success, data: row }
 *
 * Sync: AgencyCategory is in SYNC_TRACKED_MODELS (packages/db) — the auto-tracking
 * extension records the SyncChange on create. No manual capture needed.
 */

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { db, Prisma } from '@blasti/db'
import { requireAuth, requireRole, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { BUILT_IN_AGENCY_CATEGORY_KEYS } from '../lib/enums'
import { enforceRateLimit, GENERAL_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// Task 42-b: body contract. `name` is length-validated AFTER normalization
// (trim + collapse internal whitespace), so the zod schema only pins the TYPES.
const createCategorySchema = z.object({
  name: z.string(),
  nameFr: z.string().nullable().optional(),
  nameAr: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
})

/** Trim + collapse internal whitespace runs to single spaces. */
function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

// ─── GET / — list custom categories (any authenticated role) ────────────────

app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    await requireAuth(c)

    const categories = await db.agencyCategory.findMany({
      orderBy: [{ createdAt: 'asc' }],
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({ success: true, data: categories })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
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
    // dictionary and existing custom rows (SQLite Prisma has no
    // mode:'insensitive', so compare in JS — the table is small).
    const lower = name.toLowerCase()
    if (BUILT_IN_AGENCY_CATEGORY_KEYS.some((key) => key.toLowerCase() === lower)) {
      return c.json({ success: false, error: 'CATEGORY_EXISTS' }, 409)
    }
    const existing = await db.agencyCategory.findMany({ select: { name: true } })
    if (existing.some((row) => row.name.toLowerCase() === lower)) {
      return c.json({ success: false, error: 'CATEGORY_EXISTS' }, 409)
    }

    let category
    try {
      category = await db.agencyCategory.create({
        data: {
          id: randomUUID(),
          name,
          nameFr: validation.data.nameFr ?? null,
          nameAr: validation.data.nameAr ?? null,
          icon: validation.data.icon ?? null,
          isCustom: true,
          createdBy: user.id,
        },
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

    return c.json({ success: true, data: category }, 201)
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
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

export const agencyCategoriesRoutes = app
