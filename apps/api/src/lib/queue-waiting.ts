/**
 * queue-waiting.ts — SINGLE SOURCE OF TRUTH for "who is waiting and callable".
 *
 * Task 2-a (VPS bug: "waiting list shows a customer, call-next says none").
 *
 * ROOT CAUSE: the staff-facing surfaces and the call action each had their own
 * private definition of "waiting":
 *
 *   GET /api/agency/queue (list)  → status ∈ {WAITING, CALLED}, ANY reservedDate
 *                                   or fixed preferredTime — future-scheduled
 *                                   tickets shown as "waiting NOW".
 *   GET /api/agency/stats         → count(status ∈ {WAITING, CALLED}) — same
 *                                   over-count.
 *   POST …/call-next              → status = WAITING, then skips tickets whose
 *                                   reservedDate is in the future or whose
 *                                   fixed preferredTime has not arrived
 *                                   (lib/queue-scheduler.ts Task 24 rules) —
 *                                   so it correctly refused the scheduled
 *                                   tickets the other surfaces had counted.
 *
 * Result: a customer booking for tomorrow (or picking a fixed time later
 * today) appears as "waiting" everywhere, but Call Next reports
 * "No customers waiting" — the exact VPS report.
 *
 * CONTRACT: every surface that answers "how many are waiting / who can be
 * called" MUST derive its answer from the helpers in THIS file. The time
 * logic itself stays in lib/queue-scheduler.ts (shouldSkipForPreferredTime)
 * — we wrap it, never re-implement it, so the two can never drift again.
 *
 * Terminology used across responses:
 *   callable  — status WAITING and callable right now (queueNumber order).
 *   scheduled — status WAITING but booked for a later date/time; NOT callable
 *               yet. Becomes callable automatically once its date/time arrives
 *               (self-healing by construction — no sweeper needed).
 *   called    — status CALLED (already at a desk, not re-callable).
 *
 * CANONICAL COUNT NAMES (identical meaning on EVERY surface that returns
 * them — staff list, stats, and both call-next variants):
 *   waitingCount   — ALL WAITING tickets in the queue (callable + scheduled).
 *   callableCount  — the tickets call-next would take RIGHT NOW.
 *   scheduledCount — WAITING tickets booked for a later date/time.
 * Invariant: waitingCount === callableCount + scheduledCount, and
 * callableCount > 0 ⇔ call-next WILL find a ticket. A surface that shows
 * waitingCount without callableCount/scheduledCount invites the phantom
 * report, so always return the triple together.
 */

import { shouldSkipForPreferredTime } from './queue-scheduler'

/** Minimal shape every caller must provide (Prisma rows satisfy this). */
export interface WaitingCandidate {
  id: string
  status: string
  /** Ticket order — call-next honors this ordering (Postpone Paradox fix). */
  queueNumber?: number
  preferredTime?: string | null
  fixedTimeEnabled?: boolean | null
  reservedDate?: string | null
}

/** Local 'YYYY-MM-DD' — MUST match lib/queue-scheduler.ts localDateString. */
export function todayLocalDateString(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Why a WAITING ticket is not callable yet (null → it IS callable). */
export function scheduledReason(
  r: Pick<WaitingCandidate, 'preferredTime' | 'fixedTimeEnabled' | 'reservedDate'>,
  now: Date = new Date(),
): 'FUTURE_DATE' | 'FIXED_TIME_LATER' | null {
  if (r.reservedDate && r.reservedDate > todayLocalDateString(now)) return 'FUTURE_DATE'
  if (
    r.preferredTime &&
    r.fixedTimeEnabled &&
    shouldSkipForPreferredTime({ preferredTime: r.preferredTime, fixedTimeEnabled: true, reservedDate: null }, now)
  ) {
    return 'FIXED_TIME_LATER'
  }
  return null
}

/**
 * Canonical callable test for a ticket. A WAITING ticket is callable NOW iff
 * its scheduled date/time (if any) has arrived. Mirrors exactly what
 * getNextCustomerToCall() enforces, expressed as a single predicate so lists,
 * counts and call-next all evaluate the SAME predicate.
 */
export function isCallableNow(
  r: Pick<WaitingCandidate, 'status' | 'preferredTime' | 'fixedTimeEnabled' | 'reservedDate'>,
  now: Date = new Date(),
): boolean {
  if (r.status !== 'WAITING') return false
  return scheduledReason(r, now) === null
}

/** Partition WAITING rows into callable-now vs scheduled-for-later. */
export function partitionWaiting<T extends WaitingCandidate>(
  rows: T[],
  now: Date = new Date(),
): { callable: T[]; scheduled: T[] } {
  const callable: T[] = []
  const scheduled: T[] = []
  for (const r of rows) {
    if (isCallableNow(r, now)) callable.push(r)
    else scheduled.push(r)
  }
  return { callable, scheduled }
}

/**
 * The ticket to call next: first callable row in the caller's order
 * (call-next fetches with orderBy queueNumber asc — preserved here), or null
 * when only scheduled rows remain.
 */
export function pickNextCallable<T extends WaitingCandidate>(
  rows: T[],
  now: Date = new Date(),
): T | null {
  for (const r of rows) {
    if (isCallableNow(r, now)) return r
  }
  return null
}

/**
 * DB-level filter for the DATE half of the callable criteria (reservedDate is
 * a plain 'YYYY-MM-DD' string column, so ≤ today is expressible in SQL). The
 * preferredTime half is a 'HH:MM' string compared against the wall clock —
 * NOT expressible in SQL — so count endpoints that need the exact callable
 * number must select the WAITING rows (tiny, bounded by maxActiveReservations)
 * and run them through partitionWaiting().
 */
export function callableWaitingDateFilter(now: Date = new Date()): {
  OR: Array<{ reservedDate: null } | { reservedDate: { lte: string } }>
} {
  return { OR: [{ reservedDate: null }, { reservedDate: { lte: todayLocalDateString(now) } }] }
}

/** Prisma select for the four columns the criteria need (count endpoints). */
export const WAITING_CRITERIA_SELECT = {
  id: true,
  status: true,
  queueNumber: true,
  preferredTime: true,
  fixedTimeEnabled: true,
  reservedDate: true,
} as const
