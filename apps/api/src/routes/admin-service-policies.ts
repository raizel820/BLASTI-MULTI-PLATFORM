/**
 * Admin Service Policies — Task C "Services Management" section.
 *
 * Per AGENCY TYPE (the 4 built-in categories), the admin decides the service
 * conditions. For now the section carries ONE policy dimension:
 *   - servicePriceMode: OPTIONAL | MANDATORY
 *   - enforce: when true, the API rejects service writes that violate the mode
 *
 * All endpoints are admin-only. Rows are ensured (4 defaults) on read so the
 * UI always has the full matrix. The enforcement hook lives in
 * routes/agency.ts POST/PATCH /services (getServicePolicyForCategory).
 */
import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { BUILT_IN_AGENCY_CATEGORY_KEYS } from '../lib/enums'
import { z } from 'zod'

export const adminServicePolicyRoutes = new Hono()

const BUILT_IN_CATEGORIES: string[] = [...BUILT_IN_AGENCY_CATEGORY_KEYS]

const updatePolicySchema = z.object({
  servicePriceMode: z.enum(['OPTIONAL', 'MANDATORY']),
  enforce: z.boolean(),
})

/** Idempotently materialize the default policy rows (built-ins + any custom dictionary rows). */
async function ensureDefaultPolicies() {
  const custom = await db.agencyCategory.findMany({ select: { slug: true } })
  const all = Array.from(new Set([...BUILT_IN_CATEGORIES, ...custom.map((c) => c.slug)]))
  await db.servicePolicy.createMany({
    data: all.map((agencyCategory) => ({ agencyCategory })),
    skipDuplicates: true,
  })
}

// GET /api/admin/service-policies — full matrix (admin)
adminServicePolicyRoutes.get('/', async (c) => {
  try {
    await requireAdmin(c)
    await ensureDefaultPolicies()
    const policies = await db.servicePolicy.findMany({
      orderBy: { agencyCategory: 'asc' },
    })
    return c.json({ success: true, policies })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /api/admin/service-policies/:category — upsert one row (admin)
adminServicePolicyRoutes.put('/:category', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const category = c.req.param('category').toUpperCase()
    // Dictionary-backed: accept any active category (built-in or custom).
    const categoryExists = await db.agencyCategory.findFirst({
      where: { OR: [{ slug: category }, { name: category }] },
      select: { slug: true },
    })
    if (!categoryExists) {
      return c.json(
        { success: false, error: `Unknown agency category: ${category}` },
        400,
      )
    }
    const policyCategory = categoryExists.slug

    const body = await c.req.json()
    const validation = validateBody(updatePolicySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { servicePriceMode, enforce } = validation.data
    const policy = await db.servicePolicy.upsert({
      where: { agencyCategory: policyCategory },
      create: { agencyCategory: policyCategory, servicePriceMode, enforce, updatedBy: admin.id },
      update: { servicePriceMode, enforce, updatedBy: admin.id },
    })

    return c.json({ success: true, policy })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

/**
 * Effective policy for an agency category — used by the service create/update
 * routes to enforce mandatory price when the admin turned enforce on.
 */
export async function getServicePolicyForCategory(category: string | null | undefined) {
  if (!category) return null
  return db.servicePolicy.findUnique({ where: { agencyCategory: category } })
}

/**
 * Central enforcement check shared by POST/PATCH /services.
 * Returns an error message when the write violates the policy, else null.
 */
export async function servicePolicyPriceViolation(
  agencyCategory: string | null | undefined,
  price: number | null | undefined,
): Promise<string | null> {
  const policy = await getServicePolicyForCategory(agencyCategory)
  if (!policy?.enforce) return null
  if (policy.servicePriceMode === 'MANDATORY' && (price === undefined || price === null || price <= 0)) {
    return 'SERVICE_PRICE_REQUIRED'
  }
  return null
}
