/**
 * subscription.ts — ONE shared subscription gate helper (R-6b, AUD-1 P0).
 *
 * Single source of truth for "may this agency use gated features right now?"
 * keyed on Agency.subscriptionStatus + Agency.gracePeriodEndsAt:
 *
 *   ACTIVE   → allowed
 *   TRIAL    → allowed ONLY while the grace window is open
 *              (gracePeriodEndsAt is null = no deadline yet, or >= now)
 *   INACTIVE / PENDING / EXPIRED (anything else) → blocked
 *
 * TRIAL semantics: an agency can be put on TRIAL with an optional grace
 * window (gracePeriodEndsAt — the same column the downgrade flow uses to let
 * in-flight reservations finish). A TRIAL agency whose grace window has
 * already ended is treated like EXPIRED.
 *
 * NOTE: never key on subscriptionTier/plan (a FREE plan with an ACTIVE status
 * is fully functional). This helper intentionally does NOT mutate anything —
 * the lazy EXPIRED flip in agency.ts and whatever status new agencies get at
 * creation are untouched.
 */

export type SubscriptionGateReason =
  | 'ACTIVE'
  | 'TRIAL_ACTIVE'
  | 'TRIAL_GRACE_OVER'
  | 'BLOCKED'

export interface SubscriptionStatusInput {
  subscriptionStatus?: string | null | undefined
  gracePeriodEndsAt?: Date | string | null | undefined
}

/**
 * Full verdict — use when the caller wants to know WHY (audit rows, error
 * details). `now` defaults to Date.now(); injectable for deterministic tests.
 */
export function evaluateSubscription(
  agency: SubscriptionStatusInput,
  now: number = Date.now(),
): { allowed: boolean; reason: SubscriptionGateReason } {
  const status = agency?.subscriptionStatus ?? null
  if (status === 'ACTIVE') return { allowed: true, reason: 'ACTIVE' }
  if (status === 'TRIAL') {
    const grace = parseGrace(agency?.gracePeriodEndsAt)
    if (grace === null || grace >= now) return { allowed: true, reason: 'TRIAL_ACTIVE' }
    return { allowed: false, reason: 'TRIAL_GRACE_OVER' }
  }
  return { allowed: false, reason: 'BLOCKED' }
}

/**
 * Boolean gate — drop-in replacement for the legacy
 * `status === 'ACTIVE' || status === 'TRIAL'` checks, with the TRIAL grace
 * rule applied. Accepts the whole agency row (or just the two fields).
 */
export function hasActiveSubscription(
  agency: SubscriptionStatusInput | string | null | undefined,
  now: number = Date.now(),
): boolean {
  // Back-compat convenience: a bare string is treated as the status with no
  // grace info — TRIAL without a known gracePeriodEndsAt stays allowed (the
  // grace column is nullable and "null = no deadline").
  if (typeof agency === 'string' || agency === null || agency === undefined) {
    return evaluateSubscription({ subscriptionStatus: agency }, now).allowed
  }
  return evaluateSubscription(agency, now).allowed
}

function parseGrace(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const t = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(t) ? null : t
}
