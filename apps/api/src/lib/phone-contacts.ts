/**
 * @blasti/api — Phone contact uniqueness rules (0.6.54)
 *
 * One phone number must never silently alias two unrelated identities:
 *
 *   • Between USER accounts  — enforced by User.phoneNumber @unique plus the
 *     explicit pre-checks below (friendly 409 instead of a raw P2002 500).
 *   • Between a USER and an AGENCY — a user's phone may match an agency's
 *     phone ONLY when that user is the agency OWNER or an active STAFF
 *     member (any branch) of that agency. Everyone else gets a 409.
 *   • When SETTING an agency phone — the number must be "dedicated" (not
 *     used by any user who is not the owner/staff of THAT agency) or one of
 *     the current owner's/staff's own numbers (the /agency/phone-options
 *     picker surfaces exactly those choices).
 */

import { db } from '@blasti/db'

export interface PhoneRuleViolation {
  ok: false
  error: string
  /** Display names of the conflicting identities (for logs / toasts). */
  conflicts: string[]
}

export interface PhoneRuleOk {
  ok: true
}

type PhoneRuleResult = PhoneRuleOk | PhoneRuleViolation

function violation(error: string, conflicts: string[]): PhoneRuleViolation {
  return { ok: false, error, conflicts }
}

/** True when the user owns the agency or is an ACTIVE staff member (any branch). */
export async function userBelongsToAgency(userId: string, agencyId: string): Promise<boolean> {
  const agency = await db.agency.findUnique({
    where: { id: agencyId },
    select: { ownerId: true },
  })
  if (agency?.ownerId === userId) return true
  const staff = await db.agencyStaff.findFirst({
    where: { userId, agencyId, isActive: true },
    select: { id: true },
  })
  return Boolean(staff)
}

/**
 * USER-side rule (requirement: "no user account has the same phone number as
 * an agency unless he is the owner or a staff in that agency and branch").
 *
 * `allowOwnerOfAgencyCodes` — agency CUSTOM CODES the user is about to own
 * (register payload) — matching those agencies' phones is allowed because the
 * registrant becomes their owner milliseconds later.
 */
export async function assertUserPhoneNotAgencyConflicting(
  userId: string | null,
  phone: string,
  opts: { allowOwnerOfAgencyCodes?: string[] } = {},
): Promise<PhoneRuleResult> {
  const agencies = await db.agency.findMany({
    where: { phone },
    select: { id: true, name: true, customCode: true, ownerId: true },
  })
  if (agencies.length === 0) return { ok: true }

  const allowedCodes = new Set((opts.allowOwnerOfAgencyCodes ?? []).map((c) => c.toUpperCase()))

  for (const agency of agencies) {
    if (allowedCodes.has(agency.customCode.toUpperCase())) continue // registrant becomes its owner
    if (userId && (agency.ownerId === userId || (await userBelongsToAgency(userId, agency.id)))) continue
    return violation('PHONE_USED_BY_AGENCY', [agency.name])
  }
  return { ok: true }
}

/**
 * AGENCY-side rule (requirement: the agency phone must be a DEDICATED number
 * or one of the current owner's/staff's numbers — never an unrelated user's
 * phone).
 */
export async function assertAgencyPhoneUsable(agencyId: string, phone: string | null | undefined): Promise<PhoneRuleResult> {
  if (!phone || !phone.trim()) return { ok: true }

  const holders = await db.user.findMany({
    where: { phoneNumber: phone },
    select: { id: true, username: true, fullName: true },
  })
  if (holders.length === 0) return { ok: true } // dedicated number — free to use

  for (const holder of holders) {
    if (!(await userBelongsToAgency(holder.id, agencyId))) {
      return violation('PHONE_USED_BY_USER', [holder.fullName || holder.username])
    }
  }
  return { ok: true }
}

/**
 * Phone choices for the agency-phone picker: the owner's and the ACTIVE
 * staff members' own numbers (deduped, names attached) — the ONLY user
 * numbers an agency may legally adopt, plus any dedicated unused number the
 * agency types freely.
 */
export async function getAgencyPhoneOptions(agencyId: string): Promise<{
  owner: { name: string; phone: string } | null
  staff: { name: string; phone: string }[]
  current: string | null
}> {
  const agency = await db.agency.findUnique({
    where: { id: agencyId },
    select: {
      phone: true,
      ownerId: true,
      owner: { select: { fullName: true, phoneNumber: true } },
    },
  })
  if (!agency) return { owner: null, staff: [], current: null }

  const staffRows = await db.agencyStaff.findMany({
    where: { agencyId, isActive: true, user: { phoneNumber: { not: null } } },
    select: { user: { select: { fullName: true, username: true, phoneNumber: true } } },
    orderBy: { joinedAt: 'asc' },
  })

  const seen = new Set<string>()
  const staff: { name: string; phone: string }[] = []
  for (const row of staffRows) {
    const phone = row.user.phoneNumber
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    staff.push({ name: row.user.fullName || row.user.username, phone })
  }

  const ownerPhone = agency.owner?.phoneNumber || null
  const owner = ownerPhone && !seen.has(ownerPhone)
    ? { name: agency.owner?.fullName || 'Owner', phone: ownerPhone }
    : null

  return { owner, staff, current: agency.phone ?? null }
}

/**
 * Compact user-side availability check used by register/profile endpoints:
 * friendly message instead of a raw unique-constraint 500. Returns the error
 * string when the phone is already taken by ANOTHER user account.
 */
export async function assertUserPhoneAvailable(userId: string | null, phone: string): Promise<string | null> {
  const holder = await db.user.findFirst({
    where: { phoneNumber: phone, ...(userId ? { id: { not: userId } } : {}) },
    select: { id: true },
  })
  return holder ? 'Phone number already registered' : null
}
