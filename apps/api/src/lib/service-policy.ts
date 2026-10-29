/**
 * @blasti/api — Service field policy engine (AUD-1 roadmap: Services Management)
 *
 * The SUPER_ADMIN decides, PER AGENCY CATEGORY, whether individual Service
 * fields are OPTIONAL or MANDATORY (Admin → Settings → Services Management).
 * Policies live in the ServiceFieldPolicy table (packages/db schema):
 *
 *   ServiceFieldPolicy { category, field, isRequired }
 *
 * A missing row ALWAYS means "optional" — backward compatible default, so the
 * feature ships inert until an admin explicitly enforces a field.
 *
 * This module is the single source of truth for:
 *   - the extensible policy-field whitelist (SERVICE_POLICY_FIELDS)
 *   - price normalization/validation shared by all service write paths
 *   - policy lookup + enforcement helpers used by
 *       POST   /api/agency/services        (agency.ts)
 *       PATCH  /api/agency/services/:id    (agency.ts)
 *       POST   /api/services               (services.ts)
 */

import { db } from '@blasti/db'

/** Extensible whitelist of Service fields that can be governed by a policy. */
export const SERVICE_POLICY_FIELDS = ['PRICE'] as const
export type ServicePolicyField = (typeof SERVICE_POLICY_FIELDS)[number]

export function isServicePolicyField(field: unknown): field is ServicePolicyField {
  return typeof field === 'string' && (SERVICE_POLICY_FIELDS as readonly string[]).includes(field)
}

// ─── Price normalization ─────────────────────────────────────────────────────
// Prices are stored as whole DZD integers (Int?). Empty string / null /
// undefined all normalize to null ("not set") — the distinction between
// "optional and left empty" and zero is preserved by allowing explicit 0.

export type PriceParseResult =
  | { ok: true; value: number | null }
  | { ok: false; error: string }

const MAX_SERVICE_PRICE = 100_000_000 // 100M DZD — catches input typos, not real businesses

export function validateServicePrice(raw: unknown): PriceParseResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'Service price must be a whole number (DZD)' }
  }
  if (n < 0) return { ok: false, error: 'Service price cannot be negative' }
  if (n > MAX_SERVICE_PRICE) return { ok: false, error: 'Service price is too large' }
  return { ok: true, value: n }
}

// ─── Policy lookup ───────────────────────────────────────────────────────────

export interface AgencyPricePolicy {
  category: string | null
  required: boolean
}

/**
 * Resolve the PRICE policy for one agency via its category.
 * Missing agency / missing policy row → optional (fail-open by design:
 * the admin feature must never brick existing service flows).
 */
export async function getAgencyPricePolicy(agencyId: string): Promise<AgencyPricePolicy> {
  const agency = await db.agency.findUnique({
    where: { id: agencyId },
    select: { category: true },
  })
  if (!agency) return { category: null, required: false }

  const policy = await db.serviceFieldPolicy.findUnique({
    where: { category_field: { category: agency.category, field: 'PRICE' } },
    select: { isRequired: true },
  })
  return { category: agency.category, required: policy?.isRequired ?? false }
}

/**
 * Enforcement guard for service writes. Returns a 400-ready error message
 * when the agency's category policy makes PRICE mandatory and the effective
 * price is "not set" — null when the write may proceed.
 */
export async function servicePricePolicyError(
  agencyId: string,
  effectivePrice: number | null
): Promise<string | null> {
  const policy = await getAgencyPricePolicy(agencyId)
  if (policy.required && (effectivePrice === null || effectivePrice === undefined)) {
    return `Service price is required for agencies in the "${policy.category}" category (set by the platform admin)`
  }
  return null
}
