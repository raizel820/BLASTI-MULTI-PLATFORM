/**
 * duplicate-join.ts — shared duplicate-join guard (R-6b, AUD-1 P0 item 5).
 *
 * WHY: a reservation can be created through SEVERAL surfaces (customer app
 * join, kiosk/device walk-in join, offline-sync bridge). Before the DB gained
 * @@unique([serviceId, queueNumber, reservedDate]) ("Reservation_service_queue_date_key")
 * none of the app-level checks were shared and the queueNumber allocation
 * (max+1) could race into a duplicate ticket or a raw 500.
 *
 * TWO layers, both mandatory on every creation path:
 *
 *   1. APP-LEVEL GUARD (duplicateJoinWhere) — same identity + agency +
 *      service + reservedDate with an active WAITING ticket already existing
 *      → the caller returns the existing ticket or a friendly 409.
 *      Identity is userId for authenticated joins and (for walk-ins, which
 *      have no user) the walk-in display name when the kiosk collected one —
 *      anonymous walk-ins carry no identity and are intentionally not
 *      name-guarded (a shared kiosk legitimately joins many people).
 *
 *   2. DB RACE MAPPING (isDuplicateTicketError) — two concurrent creations can
 *      still allocate the same max+1 queueNumber inside their transactions;
 *      PostgreSQL settles the race via the unique key and the loser sees
 *      Prisma error P2002. Callers MUST catch it and answer the friendly 409
 *      (code DUPLICATE_TICKET) instead of a 500.
 */

import { Prisma } from '@blasti/db'

/** Machine-readable code carried on every friendly duplicate response. */
export const DUPLICATE_TICKET = 'DUPLICATE_TICKET'

/**
 * WHERE shape for "an active ticket already exists for this identity on this
 * service/date". reservedDate follows the creation-path convention:
 * a 'YYYY-MM-DD' string targets the dated rows, null targets the undated
 * (same-day / walk-in) rows via IS NULL.
 */
export interface DuplicateJoinIdentity {
  /** Authenticated customer id — or null for walk-in rows. */
  userId?: string | null
  /** Identified walk-in name (exact, trimmed) — omit for user-keyed guards. */
  walkInCustomerName?: string | null
  agencyId: string
  serviceId: string
  /** 'YYYY-MM-DD' or null (null matches undated rows). */
  reservedDate?: string | null
  /**
   * Statuses that count as "already in the queue". Default ['WAITING'] per
   * the P0 spec; the customer join path passes ['WAITING', 'CALLED'] so a
   * second ticket cannot be minted while the first one is being served.
   */
  statuses?: string[]
  /** Extra scoping (e.g. { isWalkIn: true }). */
  extra?: Record<string, unknown>
}

export function duplicateJoinWhere(identity: DuplicateJoinIdentity): Record<string, unknown> {
  return {
    agencyId: identity.agencyId,
    serviceId: identity.serviceId,
    status: { in: identity.statuses ?? ['WAITING'] },
    reservedDate: identity.reservedDate ?? null,
    ...(identity.userId !== undefined ? { userId: identity.userId } : {}),
    ...(identity.walkInCustomerName !== undefined
      ? { walkInCustomerName: identity.walkInCustomerName }
      : {}),
    ...(identity.extra ?? {}),
  }
}

/**
 * True when the thrown error is the unique-key violation that a concurrent
 * duplicate reservation create produces (Prisma P2002 on
 * Reservation_service_queue_date_key). Only Reservation.create catch blocks
 * feed this helper: the model's other unique constraint (importToken) is
 * never written inside those creates, so any P2002 here is the queue/date
 * key — the meta target is verified when Prisma supplies it.
 */
export function isDuplicateTicketError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  const target = (error.meta as { target?: unknown } | undefined)?.target
  if (target === undefined || target === null) return true
  const targetStr = Array.isArray(target) ? target.join(',') : String(target)
  return (
    targetStr.includes('Reservation_service_queue_date_key') ||
    (targetStr.includes('serviceId') &&
      targetStr.includes('queueNumber') &&
      targetStr.includes('reservedDate'))
  )
}
