/**
 * BLASTI Sync Notify — request-scoped sync context + real-time change notifier
 *
 * Two responsibilities:
 *
 * 1. AsyncLocalStorage request context — lets the sync-tracking layer know
 *    WHICH request caused a mutation (idempotency key / origin), so SyncChange
 *    rows can carry mutationId for echo suppression and exactly-once apply.
 *
 * 2. Debounced real-time notifier — after SyncChange rows are recorded, we
 *    coalesce notifications per agency and emit a single lightweight
 *    `sync:changes` Socket.IO event per flush window. The desktop reacts by
 *    pulling with its cursor (events notify; pull reconciles — never the
 *    other way around).
 */

import { AsyncLocalStorage } from 'node:async_hooks'

// ─── Request-scoped sync context ─────────────────────────────────────────────

export interface SyncRequestContext {
  /** Stable idempotency key from X-Idempotency-Key header (outbox replay). */
  idempotencyKey?: string
  /** Agency the request acts on (when resolvable). */
  agencyId?: string
  /** Where the mutation originated: 'cloud' | 'desktop' | 'web'. */
  origin?: string
}

const syncAls = new AsyncLocalStorage<SyncRequestContext>()

/** Run `fn` with a sync request context (used by the idempotency middleware). */
export function runWithSyncContext<T>(ctx: SyncRequestContext, fn: () => Promise<T>): Promise<T> {
  return syncAls.run(ctx, fn)
}

/** Current sync request context, or undefined when outside a tracked request. */
export function getSyncContext(): SyncRequestContext | undefined {
  return syncAls.getStore()
}

// ─── Debounced per-agency change notifier ────────────────────────────────────

interface PendingNotification {
  maxSequence: number
  models: Set<string>
  changeCount: number
  firstAt: number
}

const pendingByAgency = new Map<string, PendingNotification>()

let notifyTimer: ReturnType<typeof setInterval> | null = null
let ioRef: { io: any } | null = null

/**
 * Record that a change happened. Called by the sync-tracking layer after a
 * SyncChange row is committed. Coalesced into one Socket.IO event per agency
 * per flush window (~700ms) so bursts of writes do not spam clients.
 */
export function noteSyncChange(agencyId: string, model: string, sequence: number): void {
  let entry = pendingByAgency.get(agencyId)
  if (!entry) {
    entry = { maxSequence: sequence, models: new Set(), changeCount: 0, firstAt: Date.now() }
    pendingByAgency.set(agencyId, entry)
  }
  entry.maxSequence = Math.max(entry.maxSequence, sequence)
  entry.models.add(model)
  entry.changeCount++
}

/**
 * Flush pending notifications as `sync:changes` events.
 *
 * Payload is intentionally tiny (no records): the desktop pulls with its own
 * cursor, which is the authoritative reconciliation mechanism.
 */
export function flushSyncNotifications(): void {
  if (pendingByAgency.size === 0) return
  const io = ioRef?.io
  if (!io) return

  const entries = Array.from(pendingByAgency.entries())
  pendingByAgency.clear()

  for (const [agencyId, entry] of entries) {
    try {
      io.to(`agency:${agencyId}`).emit('sync:changes', {
        agencyId,
        latestSequence: entry.maxSequence,
        models: Array.from(entry.models),
        changeCount: entry.changeCount,
        at: new Date().toISOString(),
      })
    } catch (err) {
      console.warn('[sync-notify] emit failed for agency', agencyId, (err as Error)?.message)
    }
  }
}

/** Provide the Socket.IO instance (called once from index.ts after io setup). */
export function setSyncNotifyIo(io: unknown): void {
  ioRef = { io }
}

/** Start the flush timer (~700ms cadence). Safe to call multiple times. */
export function startSyncNotifyTimer(): void {
  if (notifyTimer) return
  notifyTimer = setInterval(() => {
    try {
      flushSyncNotifications()
    } catch (err) {
      console.warn('[sync-notify] flush failed:', (err as Error)?.message)
    }
  }, 700)
  // Do not hold the process open on its own
  if (typeof notifyTimer.unref === 'function') notifyTimer.unref()
}

/** Diagnostics: current pending notification snapshot. */
export function getPendingSyncNotifications(): Record<string, { latestSequence: number; models: string[]; changeCount: number }> {
  const out: Record<string, { latestSequence: number; models: string[]; changeCount: number }> = {}
  for (const [agencyId, entry] of pendingByAgency) {
    out[agencyId] = {
      latestSequence: entry.maxSequence,
      models: Array.from(entry.models),
      changeCount: entry.changeCount,
    }
  }
  return out
}
