/**
 * BLASTI UID system (UID-0.6.14)
 * ─────────────────────────────
 * Every user EXCEPT the super admin gets an immutable, permanently-unique UID:
 *
 *     {TYPE}-{WILAYA}-{SEQ}      e.g.  CU-16-00042
 *
 *   • TYPE   — account type: AO (agency owner) / ST (agency staff) / CU (customer)
 *   • WILAYA — the user's wilaya, the official two-digit ANI code ('01'..'58');
 *              '00' when the account has no wilaya. Agency owners/staff fall
 *              back to their agency's wilaya when their own is unset.
 *   • SEQ    — the joining order number for that type+wilaya pair, zero-padded
 *              to 5 digits, allocated from the monotonic UidCounter table.
 *
 * GUARANTEES:
 *   1. UNIQUENESS        — User.uid is @unique at the schema level.
 *   2. NEVER REUSED      — UidCounter.nextNumber only ever INCREMENTS. Deleting
 *                          a user account never frees its number.
 *   3. NEVER EDITABLE    — assigned exactly once at creation (or by the boot
 *                          backfill for legacy accounts); no API endpoint may
 *                          write User.uid afterwards, and the sync layer lists
 *                          it as an immutable field.
 *   4. SUPER_ADMIN       — intentionally has NO uid (always null).
 */

import { db } from '@blasti/db'

/** Account-type prefix segment of the UID. SUPER_ADMIN → null (no UID). */
export function uidPrefixForRole(role: string): string | null {
  switch (role) {
    case 'AGENCY_OWNER': return 'AO'
    case 'AGENCY_STAFF': return 'ST'
    case 'CUSTOMER': return 'CU'
    default: return null
  }
}

/** Normalize a wilaya to the two-digit segment ('01'..'58', or '00' unset). */
export function uidWilayaSegment(wilaya: string | null | undefined): string {
  if (!wilaya) return '00'
  const normalized = String(wilaya).trim().padStart(2, '0')
  return /^(0[1-9]|[1-5][0-8])$/.test(normalized) ? normalized : '00'
}

/** Build the full UID string from its parts. */
export function formatUid(prefix: string, wilaya: string, seq: number): string {
  return `${prefix}-${wilaya}-${String(seq).padStart(5, '0')}`
}

/** P2002 = unique-constraint violation in Prisma. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002'
}

/**
 * Allocate the next number for a "{TYPE}-{WILAYA}" prefix.
 *
 * The counter is atomically incremented (SQL `nextNumber = nextNumber + 1`
 * under the row's write lock), so concurrent allocations for the same prefix
 * always receive distinct numbers. The row is created on first use starting
 * from 0 → the first allocated number is 1. The counter NEVER decreases, so
 * numbers of deleted accounts are never handed out again.
 */
async function allocateSequence(prefix: string): Promise<number> {
  await db.uidCounter.upsert({
    where: { prefix },
    create: { prefix, nextNumber: 0 },
    update: {},
  })
  const counter = await db.uidCounter.update({
    where: { prefix },
    data: { nextNumber: { increment: 1 } },
  })
  return counter.nextNumber
}

/**
 * Assign the immutable UID to a user if (and only if) they don't have one.
 *
 * `fallbackWilaya` — used when the user's own wilaya is unset (e.g. the
 * agency's wilaya for owner/staff accounts). Pass it BEFORE the value is
 * needed; the UID is written once and never changed afterwards.
 *
 * Returns the assigned/existing UID ('' for SUPER_ADMIN / unknown roles —
 * those accounts intentionally have no UID).
 */
export async function assignUidToUser(
  userId: string,
  fallbackWilaya?: string | null,
): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, wilaya: true, uid: true },
  })
  if (!user) return ''
  // Immutability guard: never overwrite an existing UID.
  if (user.uid) return user.uid

  const prefix = uidPrefixForRole(user.role)
  if (!prefix) return '' // SUPER_ADMIN (and any future role) — no UID

  const wilaya = uidWilayaSegment(user.wilaya || fallbackWilaya)
  const counterPrefix = `${prefix}-${wilaya}`

  // Retry loop covers the paranoid case where two racers somehow derived the
  // same sequence (the atomic increment makes this virtually impossible).
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = await allocateSequence(counterPrefix)
    const uid = formatUid(prefix, wilaya, seq)
    try {
      await db.user.update({
        where: { id: userId },
        data: { uid },
        select: { id: true },
      })
      return uid
    } catch (err) {
      if (isUniqueViolation(err)) continue // take the next number
      throw err
    }
  }
  // Should never happen (atomic counter) — leave uid null rather than fail
  // the surrounding business flow; the boot backfill will fill it later.
  console.error(`[UID] failed to allocate a unique uid for user ${userId} after 5 attempts`)
  return ''
}

/**
 * Best-effort wilaya for legacy accounts without their own: agency-scoped
 * roles inherit their agency's wilaya, customers keep their own.
 */
async function resolveBackfillWilaya(user: {
  id: string
  role: string
  wilaya: string | null
}): Promise<string | null> {
  if (user.wilaya) return user.wilaya
  if (user.role === 'AGENCY_OWNER') {
    const agency = await db.agency.findFirst({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { wilaya: true },
    })
    if (agency?.wilaya) return agency.wilaya
  }
  if (user.role === 'AGENCY_STAFF') {
    const link = await db.agencyStaff.findFirst({
      where: { userId: user.id, isActive: true },
      orderBy: { joinedAt: 'asc' },
      select: { agency: { select: { wilaya: true } } },
    })
    if (link?.agency?.wilaya) return link.agency.wilaya
  }
  return null
}

/**
 * Boot-time backfill (runs on EVERY API boot — "auto create UID for accounts
 * without one each time the app rebuild"): walks every user that has no UID
 * (legacy VPS accounts, freshly-seeded users, any allocation that raced a
 * crash) in JOINING ORDER (createdAt ascending) and assigns UIDs. Users that
 * already have one are untouched, the counter state guarantees the numbers
 * never collide with anything issued before or after.
 */
export async function ensureUserUids(): Promise<{ assigned: number }> {
  const pending = await db.user.findMany({
    where: { uid: null, role: { not: 'SUPER_ADMIN' } },
    select: { id: true, role: true, wilaya: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!pending.length) return { assigned: 0 }

  let assigned = 0
  for (const user of pending) {
    const fallbackWilaya = await resolveBackfillWilaya(user)
    const uid = await assignUidToUser(user.id, fallbackWilaya)
    if (uid) assigned++
  }
  if (assigned > 0) {
    console.log(`[UID] backfill assigned ${assigned} uid(s) to legacy accounts`)
  }
  return { assigned }
}
