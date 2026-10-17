/**
 * queue-claim.ts — UNIFIED QUEUE: atomic next-ticket claiming.
 *
 * The central PostgreSQL API is the definitive source of truth for staff
 * workstations (Enhanced Online Operational Mode). This module is the ONE
 * implementation both call-next routes delegate to.
 *
 * WHY THIS EXISTS (Unified Queue Management among branch staff):
 * The historic call-next flow selected a candidate with a plain read and then
 * updated it UNCONDITIONALLY inside a READ COMMITTED transaction. Two desks
 * (or a desk + the auto-skip cron) could both pass the read-recheck and both
 * flip the SAME ticket to CALLED — the only DB guard was
 * Counter.currentReservationId uniqueness, which only covers same-counter
 * cases, and the staff/counter assignment itself was not atomic.
 *
 * THE CONTRACT:
 *  1. DB-LEVEL MUTUAL EXCLUSION — the claim is an optimistic-concurrency
 *     `updateMany({ where: { id, status: 'WAITING' } })`: exactly ONE desk's
 *     UPDATE matches a given ticket; every loser sees count===0 and moves to
 *     the NEXT candidate inside the same transaction. The same ticket can
 *     never be called by multiple staff simultaneously.
 *  2. ATOMIC STAFF + COUNTER ASSIGNMENT — the reservation (status CALLED +
 *     calledAt + counterId), the counter (currentReservationId) and the
 *     queueSettings (currentServingNumber) — plus the QUEUE_CALLED customer
 *     notification and the audit log — commit in ONE transaction, with all
 *     recordSyncChange rows captured INSIDE it (Spec Part O: transactional
 *     writes are invisible to the auto-tracking extension).
 *  3. AUTOMATIC CONFLICT RETRY — the transaction is wrapped in withTxRetry
 *     (write-conflict/serialization backoff). Candidate races are absorbed by
 *     the candidate loop, so `CONFLICT` is only returned after EVERY callable
 *     candidate was taken by concurrent desks mid-transaction (the client
 *     retry then re-evaluates the queue).
 *  4. IDEMPOTENCY — callers send X-Idempotency-Key (the global
 *     idempotencyGuard replays the stored response for retransmissions, so
 *     the same operation never executes twice).
 *  5. SHARED SELECTION CRITERIA — candidates are partitioned through
 *     lib/queue-waiting.ts (the SAME predicate the waiting list and stats
 *     counts use), so "the list says N waiting" and "claim says none" can
 *     never disagree.
 */
import { db } from '@blasti/db'
import { partitionWaiting, WAITING_CRITERIA_SELECT } from './queue-waiting'
import { recordSyncChange } from './sync-helpers'
import { withTxRetry } from './tx-retry'

export interface ClaimNextTicketParams {
  agencyId: string
  /** Counter to assign the ticket to (currentReservationId link). */
  counterId?: string | null
  /** Optional service filter — claims across all services when omitted. */
  serviceId?: string | null
  /** Feature C: when the counter is assigned specific services, claims are
   *  restricted to them. null/undefined = no restriction (counter serves all). */
  allowedServiceIds?: string[] | null
  /** Authenticated staff id for the QUEUE_CALL audit row. */
  actorUserId?: string | null
}

export interface ClaimCounts {
  waitingCount: number
  callableCount: number
  scheduledCount: number
}

export type ClaimNextTicketResult =
  | {
      ok: true
      reservation: Record<string, unknown>
      autoCompleted: { id: string; displayNumber: string }[]
      counts: ClaimCounts
    }
  | { ok: false; kind: 'NO_CALLABLE'; counts: ClaimCounts }
  | { ok: false; kind: 'CONFLICT'; counts: ClaimCounts }

/**
 * Claim the next callable ticket as ONE atomic, retried transaction.
 * Returns a discriminated result — callers map the kinds to their own
 * response shapes (the two call-next routes keep their legacy contracts).
 */
export async function claimNextTicket(
  params: ClaimNextTicketParams,
): Promise<ClaimNextTicketResult> {
  return withTxRetry((tx) => claimNextTicketTx(tx, params))
}

/** Transaction-body variant — reusable when composing larger transactions. */
export async function claimNextTicketTx(
  // Prisma interactive-transaction client (loosely typed to match the
  // codebase's route-level `tx: any` convention — the delegatee models are
  // validated by Prisma itself at runtime).
  tx: any,
  params: ClaimNextTicketParams,
): Promise<ClaimNextTicketResult> {
  const { agencyId, counterId, serviceId, allowedServiceIds, actorUserId } = params

  // Feature C: a counter assigned specific services only draws tickets for
  // those services — but every counter sharing a service still draws from the
  // SAME pool (tickets are agency+service scoped). Explicit serviceId wins;
  // allowedServiceIds applies when the desk calls "next" without a service.

  // ── Auto-complete the PREVIOUS customer for THIS counter only ──
  // Scoping to counterId keeps multiple receptions serving simultaneously.
  const autoCompleted: { id: string; displayNumber: string }[] = []
  if (counterId) {
    const counterCalled = (await tx.reservation.findMany({
      where: { counterId, status: 'CALLED' },
      select: { id: true, displayNumber: true },
    })) as { id: string; displayNumber: string }[]
    for (const called of counterCalled) {
      await tx.reservation.update({
        where: { id: called.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      })
      await recordSyncChange({ tx, agencyId, model: 'Reservation', recordId: called.id, operation: 'update' })
      await (tx as any).auditLog.create({
        data: {
          action: 'QUEUE_AUTO_COMPLETE',
          entityType: 'RESERVATION',
          entityId: called.id,
          details: JSON.stringify({
            displayNumber: called.displayNumber,
            agencyId,
            counterId,
            reason: 'Auto-completed when counter called next customer',
          }),
        },
      })
      autoCompleted.push({ id: called.id, displayNumber: called.displayNumber })
    }
  }

  // ── Shared callable criteria (list/stats/claim can never disagree) ──
  const waiting = (await tx.reservation.findMany({
    where: {
      agencyId,
      status: 'WAITING',
      ...(serviceId
        ? { serviceId }
        : allowedServiceIds && allowedServiceIds.length > 0
          ? { serviceId: { in: allowedServiceIds } }
          : {}),
    },
    orderBy: { queueNumber: 'asc' },
    select: WAITING_CRITERIA_SELECT,
  })) as Parameters<typeof partitionWaiting>[0]

  const { callable, scheduled } = partitionWaiting(waiting)
  const counts: ClaimCounts = {
    waitingCount: waiting.length,
    callableCount: callable.length,
    scheduledCount: scheduled.length,
  }

  if (callable.length === 0) {
    return { ok: false, kind: 'NO_CALLABLE', counts }
  }

  // ── OCC claim loop: first candidate whose WAITING row we atomically win ──
  for (const cand of callable) {
    const occ = await tx.reservation.updateMany({
      where: { id: cand.id, status: 'WAITING' },
      data: {
        status: 'CALLED',
        calledAt: new Date(),
        ...(counterId ? { counterId } : {}),
      },
    })
    if (occ.count === 0) {
      // Another desk/cron won THIS ticket between our read and our write —
      // DB-level mutual exclusion held; advance to the next candidate.
      continue
    }

    const claimed = (await tx.reservation.findUnique({
      where: { id: cand.id },
      include: {
        agency: { select: { id: true, name: true, nameFr: true, nameAr: true } },
        service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        user: { select: { id: true, username: true, fullName: true, language: true, phoneNumber: true, fcmToken: true } },
        counter: { select: { id: true, name: true, number: true } },
      },
    })) as Record<string, any> | null
    if (!claimed) continue // vanished mid-transaction (defensive) — next candidate

    await recordSyncChange({ tx, agencyId, model: 'Reservation', recordId: claimed.id, operation: 'update' })

    // Link the ticket to the counter as the active serving one.
    if (counterId) {
      await (tx as any).counter.update({
        where: { id: counterId },
        data: { currentReservationId: claimed.id },
      })
      await recordSyncChange({ tx, agencyId, model: 'Counter', recordId: counterId, operation: 'update' })
    }

    // Keep every surface on the same "now serving" number.
    const queueSettingsRow = await (tx as any).queueSettings.findFirst({ where: { agencyId } })
    if (queueSettingsRow) {
      await (tx as any).queueSettings.update({
        where: { id: queueSettingsRow.id },
        data: { currentServingNumber: claimed.queueNumber },
      })
      await recordSyncChange({ tx, agencyId, model: 'QueueSettings', recordId: queueSettingsRow.id, operation: 'update' })
    }

    // Customer notification (registered users only — walk-ins have none).
    if (claimed.userId) {
      const notif = await (tx as any).notification.create({
        data: {
          userId: claimed.userId,
          type: 'QUEUE_CALLED',
          title: 'Queue Called',
          message: `Your number ${claimed.displayNumber} has been called. Please proceed.`,
        },
      })
      await recordSyncChange({ tx, agencyId, model: 'Notification', recordId: notif.id, operation: 'create' })
    }

    await (tx as any).auditLog.create({
      data: {
        userId: actorUserId || claimed.userId || null,
        action: 'QUEUE_CALL',
        entityType: 'RESERVATION',
        entityId: claimed.id,
        details: JSON.stringify({
          displayNumber: claimed.displayNumber,
          agencyId,
          serviceId: claimed.serviceId,
          isWalkIn: claimed.isWalkIn || false,
          walkInCustomerName: claimed.walkInCustomerName || null,
          counterId: counterId || null,
        }),
      },
    })

    return { ok: true, reservation: claimed, autoCompleted, counts }
  }

  // Every callable candidate was taken by a concurrent claimant between our
  // read and our write. Surface CONFLICT so the caller can retry cleanly —
  // falling back to any local state here could double-call a ticket.
  return { ok: false, kind: 'CONFLICT', counts }
}
