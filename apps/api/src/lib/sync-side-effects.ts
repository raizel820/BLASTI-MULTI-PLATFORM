/**
 * BLASTI Sync Push Side-Effects — realtime + notification parity for
 * DEVICE-ORIGINATED (offline-first desktop/mobile) mutations.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Direct API routes emit Socket.IO business events inline:
 *   • agency/queue/call-next            → queue:called + notification:your-turn
 *                                         + kiosk:update + Notification row
 *                                         (agency.ts processCandidate)
 *   • agency/queue/:id action=complete  → queue:completed + notification:new
 *     /no_show/cancel                     + kiosk:update + Notification row
 *                                         (agency.ts PATCH /queue/:id)
 *   • notifications POST                → notification:new
 *                                         (notifications.ts)
 *
 * Device mutations travel a DIFFERENT path: local SQLite → outbox →
 * POST /api/sync/push → processPushMutation — which only APPLIED the rows and
 * stayed silent. Result: a call-next from the DESKTOP updated the cloud DB but
 * never rang the customer's phone (no notification:your-turn), never refreshed
 * the webapp (no queue:called) and never updated kiosks — every client only
 * converged on its next poll / section swap, and the phone notification only
 * ever arrived when the agency operated from the webapp.
 *
 * This module restores parity at the single choke point every pushed mutation
 * flows through (processPushMutation). It mirrors the direct-route payloads
 * EXACTLY (same event names, same shapes, same Notification rows) and never
 * double-fires:
 *
 *   • Webapp/route writes NEVER flow through /api/sync/push — they emit their
 *     own events inline. Only device pushes land here.
 *   • Emissions fire only on a real status TRANSITION (prev !== next).
 *     Idempotent replays and re-pushes of an unchanged status stay silent.
 *   • Notification-row emission (model Notification, create) fires only when
 *     the row did not already exist cloud-side.
 *
 * Everything is best-effort: a realtime/notification failure must never fail
 * the sync push itself. The only awaited side-effect is the Notification row
 * creation (durable parity data); the socket emits are fire-and-forget exactly
 * like the direct routes (which never await them either).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Reservation statuses that drive customer/agency-facing side effects. */
export type QueuePushStatus = 'CALLED' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED'

export const QUEUE_PUSH_STATUSES: ReadonlySet<string> = new Set([
  'CALLED',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED',
])

/** Pre-apply snapshot captured by the caller (processPushMutation). */
export interface PreApplySnapshot {
  /** For Reservation: the status BEFORE the pushed mutation applied. */
  status?: string | null
  /** For Notification (create): whether the row already existed. */
  existed?: boolean
  /** Best-effort identity fields of the pre-apply Reservation row. */
  userId?: string | null
  displayNumber?: string | null
  walkInCustomerName?: string | null
  isWalkIn?: boolean | null
  serviceId?: string | null
}

/** Injectable emit surface — defaults to the real Socket.IO emit helpers. */
export interface PushSideEffectEmit {
  queue(type: string, agencyId: string, data: Record<string, unknown>): unknown
  notify(type: string, userId: string, data: Record<string, unknown>): unknown
  kiosk(agencyId: string, data: Record<string, unknown>): unknown
}

export interface EmitPushSideEffectsParams {
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
  data: Record<string, unknown>
  prev: PreApplySnapshot | null
  /** The extended Prisma client (Notification/User/Agency lookups + row create). */
  db: any
  /** Override for tests; defaults to the live realtime-emit helpers. */
  emit?: PushSideEffectEmit
}

// ─── Pure decision helpers (unit-testable without any I/O) ───────────────────

/** Map a Reservation status to the direct-route `action` naming. */
export function resolveQueueAction(status: string): 'call' | 'complete' | 'no_show' | 'cancel' | null {
  switch (status) {
    case 'CALLED': return 'call'
    case 'COMPLETED': return 'complete'
    case 'NO_SHOW': return 'no_show'
    case 'CANCELLED': return 'cancel'
    default: return null
  }
}

/** Map a Reservation status to the direct-route queue event name. */
export function resolveQueueEventType(status: string): string | null {
  switch (status) {
    case 'CALLED': return 'queue:called'
    case 'COMPLETED': return 'queue:completed'
    case 'NO_SHOW': return 'queue:no-show'
    case 'CANCELLED': return 'queue:cancelled'
    default: return null
  }
}

/**
 * Whether a pushed mutation needs a pre-apply snapshot at all. Deliberately
 * narrow — the snapshot query is a per-mutation cost and only the models that
 * can ring a phone justify it.
 */
export function needsPreApplySnapshot(model: string, operation: string, data: Record<string, unknown> | undefined): boolean {
  if (operation === 'delete') return false // deletes never announce transitions
  if (model === 'Reservation' && QUEUE_PUSH_STATUSES.has(String(data?.status ?? ''))) return true
  if (model === 'Notification' && operation === 'create') return true
  return false
}

/**
 * True when the pushed Reservation mutation is a REAL status transition
 * (replays / no-op status re-pushes are silent).
 */
export function isQueueStatusTransition(prev: PreApplySnapshot | null, nextStatus: string): boolean {
  if (!QUEUE_PUSH_STATUSES.has(nextStatus)) return false
  return (prev?.status ?? null) !== nextStatus
}

// ─── Pre-apply capture ────────────────────────────────────────────────────────

const RESERVATION_SNAPSHOT_SELECT = {
  status: true,
  userId: true,
  displayNumber: true,
  walkInCustomerName: true,
  isWalkIn: true,
  serviceId: true,
} as const

/**
 * Capture the PRE-apply state the side-effect emitter needs. Cheap: one
 * findUnique, only for the models that can ring a phone. Never throws.
 */
export async function capturePreApplySnapshot(
  db: any,
  model: string,
  recordId: string,
  operation: string,
  data: Record<string, unknown> | undefined,
): Promise<PreApplySnapshot | null> {
  try {
    if (!db || !needsPreApplySnapshot(model, operation, data)) return null
    if (model === 'Reservation') {
      const row = await db.reservation.findUnique({
        where: { id: recordId },
        select: RESERVATION_SNAPSHOT_SELECT,
      })
      if (!row) return { status: null } // create — everything is a transition
      return {
        status: row.status ?? null,
        userId: row.userId ?? null,
        displayNumber: row.displayNumber ?? null,
        walkInCustomerName: row.walkInCustomerName ?? null,
        isWalkIn: row.isWalkIn ?? null,
        serviceId: row.serviceId ?? null,
      }
    }
    if (model === 'Notification') {
      const row = await db.notification.findUnique({ where: { id: recordId }, select: { id: true } })
      return { existed: !!row }
    }
  } catch {
    // Snapshot is an optimization — on failure treat as "no prior knowledge".
    // The transition guard then uses prev=null, which can only OVER-emit in
    // the rare case of a DB error on a repeated status push; acceptable.
  }
  return null
}

// ─── Emit orchestration ───────────────────────────────────────────────────────

/** Fire-and-forget an emit exactly like the direct routes (never awaited). */
function fire(fn: () => unknown): void {
  try {
    const result = fn()
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).catch(() => { /* realtime emit is best-effort */ })
    }
  } catch { /* idem */ }
}

async function resolveCustomerName(
  db: any,
  data: Record<string, unknown>,
  prev: PreApplySnapshot | null,
): Promise<string> {
  const walkIn = (data.walkInCustomerName ?? prev?.walkInCustomerName ?? null) as string | null
  if (walkIn) return walkIn
  const userId = (data.userId ?? prev?.userId ?? null) as string | null
  if (!userId) return ''
  try {
    const user = await db.user.findUnique({ where: { id: userId }, select: { fullName: true } })
    return user?.fullName || ''
  } catch {
    return ''
  }
}

async function resolveAgencyName(db: any, agencyId: string): Promise<string> {
  try {
    const agency = await db.agency.findUnique({ where: { id: agencyId }, select: { name: true } })
    return agency?.name || 'the agency'
  } catch {
    return 'the agency'
  }
}

/**
 * Notification row parity with the direct routes:
 *   CALLED    → QUEUE_CALLED  (agency.ts processCandidate)
 *   cancel    → CANCELLED     (agency.ts PATCH /queue/:id)
 *   complete  → COMPLETED
 *   no_show   → NO_SHOW
 * Written through the extended client (non-transactional) so the installed
 * sync-tracking extension records the SyncChange — the row also reaches every
 * other device via the change feed, exactly like route-created rows.
 */
function notificationRowFor(action: string, displayNumber: string, agencyName: string): { type: string; title: string; message: string } {
  if (action === 'call') {
    return {
      type: 'QUEUE_CALLED',
      title: 'Queue Called',
      message: `Your number ${displayNumber} has been called. Please proceed.`,
    }
  }
  if (action === 'cancel') {
    return {
      type: 'CANCELLED',
      title: 'Reservation Cancelled by Agency',
      message: `Your reservation #${displayNumber} at ${agencyName} has been cancelled by the agency.`,
    }
  }
  if (action === 'complete') {
    return {
      type: 'COMPLETED',
      title: 'Service Completed',
      message: `Your reservation #${displayNumber} at ${agencyName} has been marked as completed. Thank you for your visit!`,
    }
  }
  return {
    type: 'NO_SHOW',
    title: 'Marked as No-Show',
    message: `Your reservation #${displayNumber} at ${agencyName} has been marked as no-show. Please contact the agency if this is an error.`,
  }
}

/** notification:new socket payload parity with the direct routes. */
function notificationNewMessageFor(action: string, displayNumber: string, agencyName: string): string {
  switch (action) {
    case 'complete': return `Your reservation #${displayNumber} at ${agencyName} has been completed.`
    case 'no_show': return `Your reservation #${displayNumber} at ${agencyName} was marked as no-show.`
    case 'cancel': return `Your reservation #${displayNumber} at ${agencyName} has been cancelled by the agency.`
    default: return `Your reservation #${displayNumber} has been updated.`
  }
}

/**
 * Emit the direct-route side effects for one successfully-APPLIED pushed
 * mutation. Never throws; called only for non-duplicate applies (the caller
 * already dedupes exact replays via the mutationId ledger, and this module
 * additionally guards on real status transitions).
 */
export async function emitPushSideEffects(params: EmitPushSideEffectsParams): Promise<void> {
  const { agencyId, model, recordId, operation, data, prev, db } = params
  try {
    if (operation === 'delete') return
    const emit = params.emit || defaultEmit()

    // ── Notification rows pushed by devices → notification:new ──────────
    if (model === 'Notification') {
      if (operation !== 'create') return
      if (prev?.existed) return // already known cloud-side — no re-announce
      const userId = String(data.userId || '')
      if (!userId) return
      fire(() => emit.notify('notification:new', userId, {
        notificationId: recordId,
        type: data.type,
        title: data.title,
      }))
      return
    }

    // ── Reservation queue-status transitions ─────────────────────────────
    if (model !== 'Reservation') return
    const nextStatus = String(data.status || '')
    if (!isQueueStatusTransition(prev, nextStatus)) return

    const action = resolveQueueAction(nextStatus)
    const eventType = resolveQueueEventType(nextStatus)
    if (!action || !eventType) return

    const displayNumber = String(data.displayNumber ?? prev?.displayNumber ?? recordId)
    const userId = (data.userId ?? prev?.userId ?? null) as string | null
    const serviceId = (data.serviceId ?? prev?.serviceId ?? null) as string | null
    const isWalkIn = !!(data.isWalkIn ?? prev?.isWalkIn)

    if (action === 'call') {
      // Payload parity: agency.ts POST /queue/call-next.
      const customerName = await resolveCustomerName(db, data, prev)
      fire(() => emit.queue('queue:called', agencyId, {
        reservationId: recordId,
        displayNumber,
        userId: userId || null,
        customerName,
        isWalkIn,
        serviceId,
      }))
      if (userId) {
        fire(() => emit.notify('notification:your-turn', userId, {
          ticketNumber: displayNumber,
          agencyId,
          userId,
          reservationId: recordId,
        }))
      }
      fire(() => emit.kiosk(agencyId, { nowServing: displayNumber, action: 'called' }))
    } else {
      // Payload parity: agency.ts PATCH /queue/:id (complete/no_show/cancel).
      fire(() => emit.queue(eventType, agencyId, {
        reservationId: recordId,
        displayNumber,
        action,
        status: nextStatus,
      }))
      if (userId) {
        const agencyName = await resolveAgencyName(db, agencyId)
        fire(() => emit.notify('notification:new', userId, {
          type: eventType,
          ticketNumber: displayNumber,
          message: notificationNewMessageFor(action, displayNumber, agencyName),
        }))
      }
      fire(() => emit.kiosk(agencyId, { action, displayNumber }))
    }

    // Durable parity: the same Notification row the direct route creates.
    if (userId && db) {
      const agencyName = action === 'call' ? 'the agency' : await resolveAgencyName(db, agencyId)
      const row = notificationRowFor(action, displayNumber, agencyName)
      await db.notification.create({
        data: { userId, type: row.type, title: row.title, message: row.message },
      }).catch((err: unknown) => {
        console.warn('[sync-side-effects] Notification row create failed (push already applied):', (err as Error)?.message)
      })
    }
  } catch (err) {
    // Side effects must never fail the sync push.
    console.warn('[sync-side-effects] emit failed (push already applied):', (err as Error)?.message)
  }
}

// ─── Default emit surface (live Socket.IO helpers, lazy-imported) ─────────────

let liveEmit: PushSideEffectEmit | null = null

function defaultEmit(): PushSideEffectEmit {
  if (liveEmit) return liveEmit
  // Lazy require keeps this module importable by hermetic tests and avoids a
  // load-time cycle through realtime-emit → data-usage → @blasti/db.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rt = require('./realtime-emit') as typeof import('./realtime-emit')
  liveEmit = {
    queue: (type, agencyId, data) => rt.emitQueueEvent(type as Parameters<typeof rt.emitQueueEvent>[0], agencyId, data),
    notify: (type, userId, data) => rt.emitNotificationEvent(type as Parameters<typeof rt.emitNotificationEvent>[0], userId, data),
    kiosk: (agencyId, data) => rt.emitKioskEvent(agencyId, data),
  }
  return liveEmit
}
