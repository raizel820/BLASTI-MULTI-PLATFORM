/**
 * BLASTI Cloud Sync Helpers — v2 (cursor-based change feed)
 *
 * The authoritative cloud-side sync infrastructure. Guarantees:
 *
 *   1. Every mutation on a synced model produces a SyncChange row:
 *      - NON-transactional route mutations → auto-recorded via the Prisma
 *        extension hook installed by installSyncTracking().
 *      - Transactional route mutations ($transaction callbacks) → the route
 *        calls recordSyncChange(tx, ...) explicitly inside the transaction.
 *   2. Global monotonic `sequence` on SyncChange → one integer cursor per
 *      client (desktop/web) for incremental pull.
 *   3. Deletes produce BOTH a SyncChange(operation=delete) AND a
 *      DeletedRecord tombstone (fixes the Prisma-6 ghost-delete passthrough).
 *   4. Push processing is idempotent (SyncMutation ledger keyed by the
 *      client-supplied mutationId) and transactional (business write +
 *      syncVersion bump + SyncChange in the SAME transaction).
 *
 * Usage:
 *   import { recordSyncChange, processPushMutation } from '../lib/sync-helpers'
 */

import { randomUUID } from 'node:crypto'
import { db, dbRaw, setSyncQueryHook, SYNC_TRACKED_MODELS } from '@blasti/db'
import {
  SYNC_REGISTRY,
  ConflictStrategy,
  type SyncModelConfig,
} from '@blasti/core/sync-registry'
import { noteSyncChange, getSyncContext } from './sync-notify'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Interactive transaction client — the `$transaction(fn)` callback parameter.
 * `any` because the extended client's $transaction overloads are complex.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TxClient = any

/** Global sentinel agencyId for platform-wide synced models. */
export const GLOBAL_AGENCY = '__global__'

/** Map model name → Prisma delegate, from the single-source registry. */
const MODEL_DELEGATES: Map<string, string> = new Map(
  SYNC_REGISTRY.filter((c) => c.isSynced).map((c) => [c.model, c.delegate]),
)

function getSyncModelConfig(model: string): SyncModelConfig | undefined {
  return SYNC_REGISTRY.find((c) => c.model === model)
}

// ─── 1. recordSyncChange() ───────────────────────────────────────────────────

export interface RecordSyncChangeParams {
  tx: TxClient
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
  syncVersion?: number
  mutationId?: string | null
  origin?: string
}

/**
 * Record a SyncChange entry inside the current transaction.
 *
 * The `sequence` is a GLOBAL monotonic integer allocated ATOMICALLY in a
 * single INSERT..SELECT statement — SQLite evaluates the subquery and the
 * insert under one write lock, so no interleaving writer (auto-track worker,
 * another request) can observe or claim the same value. The sequence is the
 * pull cursor currency: it MUST be monotonic per database (GLOBAL — not
 * per-agency; the feed interleaves agencies by sequence and every consumer
 * filter is agency+global). The allocated sequence IS the record's sync
 * version (Part X Option B: version lives centrally in the SyncChange log,
 * because business tables have no syncVersion column).
 *
 * @returns the allocated global sequence (also usable as the record version)
 */
export async function recordSyncChange(params: RecordSyncChangeParams): Promise<number> {
  const { tx, agencyId, model, recordId, operation, mutationId, origin } = params

  // Global sentinel keeps platform-wide models (SMS settings, plans…) in the
  // feed of every agency without exploding rows per agency.
  const scopedAgencyId = agencyId || GLOBAL_AGENCY

  // Both MAX+1 subquery evaluations run inside ONE statement under one write
  // lock — they observe the same MAX, so sequence and syncVersion agree.
  const rows = (await tx.$queryRawUnsafe(
    'INSERT INTO "SyncChange" ' +
    '("id", "sequence", "agencyId", "model", "recordId", "operation", "syncVersion", "mutationId", "origin", "changedAt") ' +
    'SELECT ?, COALESCE((SELECT MAX("sequence") FROM "SyncChange"), 0) + 1, ?, ?, ?, ?, COALESCE((SELECT MAX("sequence") FROM "SyncChange"), 0) + 1, ?, ?, ? ' +
    'RETURNING "sequence"',
    randomUUID(),
    scopedAgencyId,
    model,
    recordId,
    operation,
    mutationId ?? null,
    origin ?? getSyncContext()?.origin ?? 'cloud',
    new Date().toISOString(),
  )) as Array<{ sequence: number }>
  const seq = Number(Array.isArray(rows) ? rows[0]?.sequence : (rows as any)?.sequence) || 0
  return seq
}

/**
 * Record a SyncChange OUTSIDE any transaction (fire-safe, awaited).
 *
 * Use for mutations the auto-tracking hook cannot see:
 *   - `$executeRaw` writes (raw SQL updates)
 *   - nested writes inside a create/update payload (e.g. `queueSettings` in
 *     `agency.create`) — Prisma fires the extension once for the top-level op
 *   - writes on the second connection of an already-committed flow
 *
 * The insert is awaited (same durability contract as the auto-hook) and
 * retried on sequence collisions. Failure is logged, never thrown — after the
 * business write has committed, a capture failure must not 500 the request.
 */
export async function recordSyncChangeNow(params: {
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
}): Promise<void> {
  return recordChangeAuto(params)
}

/**
 * Resolve the agency a USER belongs to (staff membership first, then agency
 * ownership). Used by explicit-capture call sites for USER-scoped records
 * (User, Notification) so the change lands in the right agency feed.
 * Returns null when the user has no agency — the change is then skipped
 * (same semantics as the auto-capture resolver).
 */
export async function resolveAgencyIdForUser(userId: string): Promise<string | null> {
  try {
    const staff = await dbRaw.agencyStaff.findFirst({
      where: { userId, isActive: true },
      select: { agencyId: true },
    })
    if (staff?.agencyId) return staff.agencyId
    const owned = await dbRaw.agency.findFirst({
      where: { ownerId: userId },
      select: { id: true },
    })
    return owned?.id ?? null
  } catch {
    return null
  }
}

// ─── 2. Agency resolution for auto-tracked records ──────────────────────────

/** Models whose records carry the agency directly. */
const DIRECT_AGENCY_FIELD: Record<string, (r: any) => string | null> = {
  Agency: (r) => r.id,
  AgencyStaff: (r) => r.agencyId,
  Service: (r) => r.agencyId,
  Branch: (r) => r.agencyId,
  QueueSettings: (r) => r.agencyId,
  Reservation: (r) => r.agencyId,
  Transaction: (r) => r.agencyId,
  Review: (r) => r.agencyId,
  Favorite: (r) => r.agencyId,
  Announcement: (r) => r.agencyId,
}

/** Platform-wide models — recorded under the global sentinel. */
const GLOBAL_MODELS = new Set([
  'SmsSettings',
  'PaymentSettings',
  'FAQ',
  'GlobalAnnouncement',
  'SubscriptionPlan',
  'PlanFeature',
])

/**
 * Resolve which agency a record change belongs to. Returns null when the
 * relation cannot be resolved (change is skipped — full reconciliation heals).
 *
 * P1-6/E2: ALL reads here use dbRaw (the un-extended client). This function
 * runs INSIDE the capture FIFO worker — a read through the extended client
 * would fire the sync hook again, enqueue a capture task BEHIND the current
 * one, and await it → circular wait that deadlocks the whole API on the
 * first tracked read of Counter/Notification/User (empirically verified).
 */
async function resolveAgencyForRecord(model: string, record: any): Promise<string | null> {
  if (!record) return null

  const direct = DIRECT_AGENCY_FIELD[model]
  if (direct) return direct(record) || null
  if (GLOBAL_MODELS.has(model)) return GLOBAL_AGENCY

  try {
    if (model === 'Counter' && record.branchId) {
      const branch = await dbRaw.branch.findUnique({
        where: { id: record.branchId },
        select: { agencyId: true },
      })
      return branch?.agencyId ?? null
    }

    if (model === 'Notification' && record.userId) {
      const staff = await dbRaw.agencyStaff.findFirst({
        where: { userId: record.userId },
        select: { agencyId: true },
        
      })
      if (staff?.agencyId) return staff.agencyId
      const owned = await dbRaw.agency.findFirst({
        where: { ownerId: record.userId },
        select: { id: true },
      })
      return owned?.id ?? null
    }

    if (model === 'User' && record.id) {
      const staff = await dbRaw.agencyStaff.findFirst({
        where: { userId: record.id, isActive: true },
        select: { agencyId: true },
        
      })
      if (staff?.agencyId) return staff.agencyId
      const owned = await dbRaw.agency.findFirst({
        where: { ownerId: record.id },
        select: { id: true },
      })
      return owned?.id ?? null
    }
  } catch (err) {
    console.warn(`[sync-helpers] resolveAgencyForRecord(${model}) failed:`, (err as Error)?.message)
  }

  return null
}

// ─── 3. Auto-tracking hook (Prisma extension) ────────────────────────────────

/**
 * Background event queue for auto-tracking.
 *
 * CRITICAL ARCHITECTURAL RULE: sync bookkeeping must NEVER delay or fail a
 * business mutation. The Prisma hook fires synchronously in the mutation
 * path — often INSIDE an interactive $transaction (5s timeout). Doing awaited
 * reads/writes there caused SQLite write contention, transaction expiry and
 * 500s on business routes. Instead the hook enqueues a closure and returns
 * immediately; a serialized worker applies tombstones + SyncChange rows AFTER
 * the mutation resolves.
 *
 * Ordering: the queue is FIFO and drained by ONE worker at a time, so the
 * per-record operation order the extension observed is preserved (the
 * "last operation wins" pull-collapse stays correct). A crash losing queued
 * events is healed by the periodic full reconciliation (the authoritative
 * record-diff safety net).
 */
type SyncEventTask = () => Promise<void>
const _syncEventQueue: SyncEventTask[] = []
let _syncEventDraining = false

/**
 * Enqueue a capture task and return a promise that resolves when the task
 * has been EXECUTED by the serialized worker (FIFO order preserved — a task
 * only runs after every earlier task completed). Awaited by the Prisma hook
 * so a business request cannot complete before its SyncChange is durable.
 */
function enqueueSyncEvent(task: SyncEventTask): Promise<void> {
  return new Promise<void>((resolve) => {
    _syncEventQueue.push(async () => {
      try {
        await task()
      } finally {
        resolve()
      }
    })
    if (!_syncEventDraining) {
      _syncEventDraining = true
      void Promise.resolve()
        .then(_drainSyncEvents)
        .finally(() => {
          _syncEventDraining = false
        })
    }
  })
}

async function _drainSyncEvents(): Promise<void> {
  while (_syncEventQueue.length > 0) {
    const task = _syncEventQueue.shift()
    if (!task) continue
    try {
      await task()
    } catch (err) {
      console.warn('[sync-helpers] background sync-record failed:', (err as Error)?.message)
    }
  }
}

/** Record id outside tx with retry on sequence collisions. */
async function recordChangeAuto(params: {
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
}): Promise<void> {
  const { agencyId, model, recordId, operation } = params
  const ctx = getSyncContext()
  const scoped = agencyId || GLOBAL_AGENCY

  noteSyncChange(scoped, model, 0) // sequence filled below; notify uses latest anyway

  // Atomic single-statement allocation: the sequence subquery and the insert
  // run under one SQLite write lock — no reader/writer can interleave, so a
  // MAX+1 collision is impossible (unlike the previous read-then-write).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const inserted = await dbRaw.$queryRawUnsafe(
        'INSERT INTO "SyncChange" ' +
        '("id", "sequence", "agencyId", "model", "recordId", "operation", "syncVersion", "mutationId", "origin", "changedAt") ' +
        'SELECT ?, COALESCE((SELECT MAX("sequence") FROM "SyncChange"), 0) + 1, ?, ?, ?, ?, COALESCE((SELECT MAX("sequence") FROM "SyncChange"), 0) + 1, ?, ?, ? ' +
        'RETURNING "sequence"',
        randomUUID(),
        scoped,
        model,
        recordId,
        operation,
        ctx?.idempotencyKey ?? null,
        ctx?.origin ?? 'cloud',
        new Date().toISOString(),
      )
      const rawSeq = Array.isArray(inserted)
        ? inserted[0]?.sequence
        : (inserted as any)?.sequence
      const assignedSeq = Number(rawSeq) || 0
      if (assignedSeq > 0) {
        noteSyncChange(scoped, model, assignedSeq)
      }
      return
    } catch (err: any) {
      const isSeqCollision = String(err?.message || '').includes('sequence') &&
        (String(err?.message || '').includes('UNIQUE') || String(err?.message || '').includes('Unique') || err?.code === 'P2002')
      if (isSeqCollision && attempt < 2) continue
      console.warn(`[sync-helpers] SyncChange auto-record failed (${model}/${recordId}):`, err?.message)
      return
    }
  }
}

/**
 * Install the auto-tracking hook on the shared Prisma client.
 * Called ONCE from apps/api startup. Records SyncChange + tombstones for all
 * mutations flowing through the extended client (non-transactional paths).
 */
export function installSyncTracking(): void {
  setSyncQueryHook(async (evt) => {
    // DURABLE CAPTURE (spec Part O): the hook AWAITS its own capture task.
    // The queue stays FIFO with one serialized worker (order preserved), but
    // the request no longer returns before the SyncChange row is committed —
    // the crash window shrinks from "unbounded background queue" to the gap
    // between the business COMMIT and the awaited capture insert. A capture
    // failure is logged loudly (reconciliation heals); we do NOT throw after
    // the business write has committed — that would invite duplicate retries.
    try {
      await enqueueSyncEvent(async () => {
        await _processSyncEvent(evt)
      })
    } catch (err) {
      console.error('[sync-helpers] SYNC CAPTURE FAILED (business write committed without SyncChange — full reconciliation will heal):', evt.model, evt.operation, (err as Error)?.message)
    }
  })
}

/** Apply one captured sync event (runs on the serialized background worker). */
async function _processSyncEvent(evt: {
  model: string
  operation: string
  args: any
  result: any
  preDeleteRecords: any[] | null
  preUpdateManyRecords?: any[] | null
}): Promise<void> {
  const { model, operation, args, result, preDeleteRecords, preUpdateManyRecords } = evt

    // ── Deletes: record tombstone + change per pre-captured record ───────
    if (operation === 'delete' || operation === 'deleteMany') {
      const records = preDeleteRecords && preDeleteRecords.length > 0
        ? preDeleteRecords
        : (args?.where?.id ? [{ id: args.where.id }] : [])
      for (const rec of records) {
        const id = rec?.id
        if (!id || typeof id !== 'string') continue

        // Tombstone (DeletedRecord) — restores the Prisma-6 ghost-delete trap
        try {
          await dbRaw.deletedRecord.create({ data: { modelName: model, recordId: id } })
        } catch { /* duplicate tombstone is fine */ }

        const agencyId = await resolveAgencyForRecord(model, rec)
        if (agencyId) {
          await recordChangeAuto({ agencyId, model, recordId: id, operation: 'delete' })
        }
      }
      return
    }

    // ── Bulk updates: emit one per-record 'update' per pre-captured record ─
    // updateMany's result is only { count } — without the pre-read the whole
    // operation would be invisible to the change feed (mark-read sweeps, OCC
    // approve/reject, credit deductions, batch-complete, suspend cascades…).
    if (operation === 'updateMany') {
      const records = preUpdateManyRecords || []
      if (records.length === 0) {
        console.warn(`[sync-helpers] updateMany on ${model} produced no pre-captured records — change feed misses this bulk update (reconciliation heals)`)
        return
      }
      for (const rec of records) {
        const id = rec?.id
        if (!id || typeof id !== 'string') continue
        const agencyId = await resolveAgencyForRecord(model, rec)
        if (!agencyId) continue
        await recordChangeAuto({ agencyId, model, recordId: id, operation: 'update' })
      }
      return
    }

    // ── Creates / updates ─────────────────────────────────────────────────
    const op: 'create' | 'update' =
      operation === 'create' || operation === 'upsert' || operation === 'createMany'
        ? 'create'
        : 'update'

    // createMany returns a count, not records — skip (reconciliation heals)
    if (operation === 'createMany' && !result?.id) return

    let record = result
    if (!record && args?.where?.id) {
      // updateMany / upsert before-create — try to read the record back
      try {
        const delegate = (dbRaw as any)[MODEL_DELEGATES.get(model) || '']
        record = delegate ? await delegate.findUnique({ where: { id: args.where.id } }) : null
      } catch { /* ignore */ }
    }
    if (!record) return

    const recordId = record.id
    if (!recordId || typeof recordId !== 'string') return

    const agencyId = await resolveAgencyForRecord(model, record)
    if (!agencyId) return

    await recordChangeAuto({
      agencyId,
      model,
      recordId,
      operation: op,
    })
}

// ─── 4. Change feed query ────────────────────────────────────────────────────

export interface PullChangesResult {
  changes: Record<string, { changed: any[]; deleted: string[] }>
  hasMore: boolean
  /** SAFE cursor: the last sequence INCLUDED in this page (spec Part L). */
  pageLastSequence: number
  /** Observability only — global max at query time; NEVER a page cursor. */
  globalCurrentSequence: number
  /** Feed retention signal (spec Part AB): cursor older than this = full reconcile. */
  oldestAvailableSequence: number
  /** @deprecated legacy alias — now equals pageLastSequence (safe cursor). */
  latestSequence: number
}

/**
 * Fields NEVER shipped through the sync feed (spec Part AF). The initial
 * snapshot stages apply the same map — the two channels must stay consistent.
 */
export const REDACTED_FIELDS: Record<string, string[]> = {
  SmsSettings: ['apiKey'],
  User: ['passwordHash', 'fcmToken'],
}

/** Strip redacted fields from a wire record (mutates a shallow copy). */
export function redactRecord(model: string, record: any): any {
  const fields = REDACTED_FIELDS[model]
  if (!fields || !record || typeof record !== 'object') return record
  const out = { ...record }
  for (const f of fields) delete out[f]
  return out
}

export interface SyncChangeRecord {
  id: string
  sequence: number
  agencyId: string
  model: string
  recordId: string
  operation: string
  syncVersion: number
  mutationId: string | null
  origin: string
  changedAt: Date
}

export interface PullChangesResult {
  changes: Record<string, { changed: any[]; deleted: string[] }>
  hasMore: boolean
  latestSequence: number
}

/**
 * Get all changes since a cursor for one agency (plus platform-wide changes).
 *
 * - Superseded operations on the same record are collapsed: the LAST
 *   operation (by sequence) wins, so one record appears at most once per page.
 * - Records for create/update rows are fetched fresh from the primary tables
 *   (scalar fields only — safe for raw-SQL upsert into the local SQLite),
 *   filtered through REDACTED_FIELDS (spec Part AF — no credentials on wire).
 * - CURSOR SEMANTICS (spec Part L): the returned pageLastSequence is the
 *   sequence of the LAST ROW INCLUDED IN THIS PAGE — the only safe value the
 *   client may advance to. The global max is returned separately as
 *   globalCurrentSequence for observability and must NEVER be used as a page
 *   cursor (rows committed between the two queries would be skipped forever).
 * - oldestAvailableSequence exposes the prune horizon so retention-blind
 *   clients can detect a stale cursor and full-reconcile (spec Part AB).
 */
export async function getChangesSinceCursor(
  agencyId: string,
  sinceSequence: number,
  limit: number = 500,
): Promise<PullChangesResult> {
  const rows = await db.syncChange.findMany({
    where: {
      sequence: { gt: sinceSequence },
      OR: [{ agencyId }, { agencyId: GLOBAL_AGENCY }],
    },
    orderBy: { sequence: 'asc' },
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const changes = (hasMore ? rows.slice(0, limit) : rows) as SyncChangeRecord[]

  // SAFE page cursor: last row actually included in this page. Empty page →
  // stay at the incoming cursor.
  const pageLastSequence = changes.length > 0
    ? Number(changes[changes.length - 1].sequence) || sinceSequence
    : sinceSequence

  // Global max + prune horizon — observability / retention signal only.
  const [latestRows, oldestRows] = await Promise.all([
    db.syncChange.findFirst({ orderBy: { sequence: 'desc' }, select: { sequence: true } }),
    db.syncChange.findFirst({ orderBy: { sequence: 'asc' }, select: { sequence: true } }),
  ])
  const globalCurrentSequence = latestRows?.sequence ?? sinceSequence
  const oldestAvailableSequence = oldestRows?.sequence ?? 0

  // Collapse superseded ops per (model, recordId)
  const lastOpByRecord = new Map<string, SyncChangeRecord>()
  for (const row of changes) {
    lastOpByRecord.set(`${row.model}:${row.recordId}`, row)
  }

  // Group records to fetch by model
  const fetchById = new Map<string, Set<string>>()
  const deletedByModel = new Map<string, string[]>()
  for (const row of lastOpByRecord.values()) {
    if (row.operation === 'delete') {
      const list = deletedByModel.get(row.model) || []
      list.push(row.recordId)
      deletedByModel.set(row.model, list)
    } else {
      let ids = fetchById.get(row.model)
      if (!ids) {
        ids = new Set()
        fetchById.set(row.model, ids)
      }
      ids.add(row.recordId)
    }
  }

  const out: Record<string, { changed: any[]; deleted: string[] }> = {}
  for (const row of lastOpByRecord.values()) {
    if (!out[row.model]) out[row.model] = { changed: [], deleted: [] }
  }

  for (const [model, ids] of fetchById) {
    const delegateName = MODEL_DELEGATES.get(model)
    const delegate = delegateName ? (db as any)[delegateName] : null
    if (!delegate) continue
    try {
      const records = await delegate.findMany({
        where: { id: { in: Array.from(ids) } },
      })
      const missing = Array.from(ids).filter(
        (id) => !records.some((r: any) => r.id === id),
      )
      for (const r of records) {
        out[model].changed.push(redactRecord(model, scalarizeRecord(r)))
      }
      // Record deleted after the page snapshot — emit as delete
      if (missing.length > 0) {
        for (const id of missing) {
          const list = deletedByModel.get(model) || []
          list.push(id)
          deletedByModel.set(model, list)
        }
      }
    } catch (err) {
      console.warn(`[sync-helpers] fetch records failed for ${model}:`, (err as Error)?.message)
    }
  }

  for (const [model, ids] of deletedByModel) {
    if (!out[model]) out[model] = { changed: [], deleted: [] }
    out[model].deleted.push(...ids)
  }

  return {
    changes: out,
    hasMore,
    pageLastSequence,
    globalCurrentSequence,
    oldestAvailableSequence,
    latestSequence: pageLastSequence,
  }
}

/** Strip non-scalar fields (relations, nested objects) for wire transfer. */
export function scalarizeRecord(record: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(record || {})) {
    if (value === null || value === undefined) {
      out[key] = value === undefined ? null : value
      continue
    }
    const t = typeof value
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[key] = value
    } else if (value instanceof Date) {
      out[key] = value.toISOString()
    } else if (t === 'object') {
      // Skip relations / nested objects / arrays
      continue
    } else {
      out[key] = value
    }
  }
  return out
}

// ─── 5. Idempotency (SyncMutation ledger) ────────────────────────────────────

export interface WithIdempotencyResult<T> {
  result: T
  mutationId: string
  wasDuplicate: boolean
}

/**
 * Wrap a mutation handler with durable idempotency protection.
 *
 * ATOMIC ACQUISITION (spec Part Z): the ledger row is created INSIDE the same
 * interactive transaction as the business mutation + SyncChange recording.
 * Two concurrent requests with the same key: one wins the UNIQUE insert, the
 * loser observes P2002 inside its own (rolled-back) transaction and either
 * replays the winner's completed result (duplicate) or surfaces a conflict.
 * A crash mid-transaction rolls the ledger row back — the retry starts clean
 * (no 2-minute pending reclaim needed for new rows; legacy stale pendings are
 * still reclaimed below).
 */
export async function withIdempotency<T>(
  params: {
    idempotencyKey: string
    agencyId: string
    model: string
    recordId?: string
    operation: string
    payloadHash?: string
  },
  mutation: (tx: TxClient) => Promise<T>,
): Promise<WithIdempotencyResult<T>> {
  const { idempotencyKey, agencyId, model, recordId, operation } = params

  // Fast path: completed key → replay the cached result (safe, no side effects)
  const existing = await db.syncMutation.findUnique({ where: { idempotencyKey } })
  if (existing && existing.status === 'completed') {
    const cached = existing.result ? JSON.parse(existing.result) : null
    return { result: cached as T, mutationId: existing.id, wasDuplicate: true }
  }
  if (existing && existing.status === 'pending') {
    // Stale pending (legacy row from the pre-atomic design — crashed run)
    // older than 2 minutes → reclaim. Fresh pending → concurrent in flight.
    const age = Date.now() - new Date(existing.processedAt).getTime()
    if (age < 120_000) {
      throw new IdempotencyConflictError(
        `Concurrent mutation in progress for key: ${idempotencyKey}`,
        existing.id,
      )
    }
    await db.syncMutation.delete({ where: { id: existing.id } })
  }

  try {
    const outcome = await dbRaw.$transaction(async (tx: TxClient) => {
      // Atomic acquisition: UNIQUE(idempotencyKey) decides the winner.
      let ledgerId: string
      try {
        const created = await tx.syncMutation.create({
          data: {
            idempotencyKey,
            agencyId: agencyId || GLOBAL_AGENCY,
            model,
            recordId: recordId ?? null,
            operation,
            status: 'pending',
            processedAt: new Date(),
          },
        })
        ledgerId = created.id
      } catch (err: any) {
        if (err?.code === 'P2002') {
          const winner = await tx.syncMutation.findUnique({ where: { idempotencyKey } })
          if (winner && winner.status === 'completed') {
            const cached = winner.result ? JSON.parse(winner.result) : null
            return { duplicate: true as const, mutationId: winner.id, result: cached as T }
          }
          throw new IdempotencyConflictError(
            `Concurrent mutation in progress for key: ${idempotencyKey}`,
            winner?.id ?? idempotencyKey,
          )
        }
        throw err
      }

      // Business mutation + SyncChange recording — SAME transaction.
      const result = await mutation(tx)

      // Ledger completion — SAME transaction (ledger ⇔ business ⇔ feed all
      // commit atomically or not at all).
      await tx.syncMutation.update({
        where: { id: ledgerId },
        data: { status: 'completed', result: JSON.stringify(result ?? null), processedAt: new Date() },
      })
      return { duplicate: false as const, mutationId: ledgerId, result }
    })

    return {
      result: outcome.result,
      mutationId: outcome.mutationId,
      wasDuplicate: outcome.duplicate,
    }
  } catch (error) {
    // Post-transaction failure bookkeeping: nothing was committed, so no
    // 'failed' row needs to survive — absence of a completed row = not done.
    throw error
  }
}

// ─── 6. atomicMutation() — business write + SyncChange in one transaction ───

/**
 * Execute a business mutation atomically with SyncChange recording.
 * The auto-tracking hook does NOT fire inside $transaction callbacks, so this
 * helper performs the recording explicitly — exactly one SyncChange per call.
 */
export async function atomicMutation<T>(
  agencyId: string,
  model: string,
  recordId: string,
  operation: 'create' | 'update' | 'delete',
  mutation: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return dbRaw.$transaction(async (tx: TxClient) => {
    const result = await mutation(tx)

    // The allocated sequence IS the record's new sync version (Part X Option B
    // — versions live centrally in the SyncChange log).
    await recordSyncChange({ tx, agencyId, model, recordId, operation })
    return result
  })
}

/**
 * The record's current sync version = sequence of its LATEST SyncChange row
 * (Part X Option B - central version ledger; business tables carry no
 * syncVersion column).
 */
export async function getRecordSyncVersion(model: string, recordId: string): Promise<number> {
  const last = await db.syncChange.findFirst({
    where: { model, recordId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  return last?.sequence ?? 0
}

/** Oldest SyncChange sequence still retained (prune horizon - Part AB). */
export async function getOldestAvailableSequence(): Promise<number> {
  const oldest = await db.syncChange.findFirst({
    orderBy: { sequence: 'asc' },
    select: { sequence: true },
  })
  return oldest?.sequence ?? 0
}

// ─── 7. processPushMutation() — desktop push processing ─────────────────────

export interface ProcessPushMutationParams {
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
  data: Record<string, any>
  mutationId?: string
  expectedVersion?: number
  localUpdatedAt?: string
}

export interface ProcessPushMutationConflict {
  reason: string
  localVersion: number
  cloudVersion: number
}

export interface ProcessPushMutationResult {
  status: 'applied' | 'duplicate' | 'conflict' | 'error'
  result?: any
  conflict?: ProcessPushMutationConflict
}

/**
 * Apply an inbound mutation from a client with full safety:
 *   idempotency (mutationId) → conflict strategy → transactional apply with
 *   SyncChange recording (so OTHER clients converge).
 */

/** Realtime hint after a committed push so other devices pull immediately. */
function notifyApplied(agencyId: string, model: string, sequence: number): void {
  if (!sequence) return
  try {
    noteSyncChange(agencyId || GLOBAL_AGENCY, model, sequence)
  } catch { /* notifier not wired — 30s poll covers */ }
}

export async function processPushMutation(
  params: ProcessPushMutationParams,
): Promise<ProcessPushMutationResult> {
  const { agencyId, model, recordId, operation, data, mutationId, expectedVersion, localUpdatedAt } = params
  const config = getSyncModelConfig(model)

  if (!config) {
    return { status: 'error', conflict: { reason: `Unknown sync model: ${model}`, localVersion: 0, cloudVersion: 0 } }
  }

  // ── Strategy guards ─────────────────────────────────────────────────────
  if (config.conflictStrategy === ConflictStrategy.CLOUD_AUTHORITATIVE && operation !== 'create') {
    return {
      status: 'conflict',
      conflict: { reason: 'Model is cloud-authoritative — local mutations not allowed', localVersion: expectedVersion ?? 0, cloudVersion: 0 },
    }
  }
  if (config.conflictStrategy === ConflictStrategy.APPEND_ONLY && operation !== 'create') {
    return {
      status: 'conflict',
      conflict: { reason: 'Model is append-only — updates and deletes not allowed', localVersion: expectedVersion ?? 0, cloudVersion: 0 },
    }
  }

  // ── Version-aware conflict detection (Part X/Y — Option B) ──────────────
  // The record's version is the sequence of its latest SyncChange row — the
  // central ledger. A client pushing an OLDER version than cloud's latest
  // change gets a deterministic conflict (no silent overwrite).
  if (config.conflictStrategy === ConflictStrategy.VERSION_AWARE && expectedVersion !== undefined) {
    const cloudVersion = await getRecordSyncVersion(model, recordId)
    if (cloudVersion > 0 && expectedVersion < cloudVersion) {
      return {
        status: 'conflict',
        conflict: {
          reason: 'Version mismatch — cloud record has been modified since last sync',
          localVersion: expectedVersion,
          cloudVersion,
        },
      }
    }
  }

  let appliedSequence = 0
  const apply = async (tx: TxClient): Promise<any> => {
    const result = await applyMutationInTx(tx, config, model, recordId, operation, data, localUpdatedAt)

    // Record the change so OTHER clients (web, other desktops) converge.
    // The allocated sequence IS the record's new version (Part X Option B).
    appliedSequence = await recordSyncChange({
      tx,
      agencyId,
      model,
      recordId,
      operation,
      mutationId: mutationId ?? null,
      origin: getSyncContext()?.origin ?? 'desktop',
    })

    return result
  }

  try {
    if (mutationId) {
      const res = await withIdempotency(
        { idempotencyKey: mutationId, agencyId, model, recordId, operation },
        apply,
      )
      if (!res.wasDuplicate) notifyApplied(agencyId, model, appliedSequence)
      return {
        status: res.wasDuplicate ? 'duplicate' : 'applied',
        result: res.result,
      }
    }

    const result = await atomicMutation(agencyId, model, recordId, operation, apply)
    notifyApplied(agencyId, model, appliedSequence)
    return { status: 'applied', result }
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return {
        status: 'conflict',
        conflict: { reason: error.message, localVersion: expectedVersion ?? 0, cloudVersion: 0 },
      }
    }
    return {
      status: 'error',
      conflict: {
        reason: `Mutation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        localVersion: expectedVersion ?? 0,
        cloudVersion: 0,
      },
    }
  }
}

/**
 * Apply a mutation inside a transaction client (registry-driven).
 * Creates use upsert; updates are LWW-guarded against cloud updatedAt;
 * deletes are LWW-guarded too (never resurrect a newer cloud record).
 */
async function applyMutationInTx(
  tx: TxClient,
  config: SyncModelConfig,
  model: string,
  recordId: string,
  operation: 'create' | 'update' | 'delete',
  data: Record<string, any>,
  localUpdatedAt?: string,
): Promise<any> {
  const delegate = (tx as any)[config.delegate]
  if (!delegate) {
    throw new Error(`No Prisma delegate for model: ${model} (delegate: ${config.delegate})`)
  }

  const dataWithMeta = { ...data }
  delete dataWithMeta.syncVersion // server-managed

  // LWW guard: cloud record strictly newer than the local mutation -> keep
  // cloud. ONLY for models that actually have an updatedAt column - the
  // previous .catch(() => null) silently skipped Reservation/AgencyStaff;
  // the skip is now explicit and documented.
  const LWW_UNSUPPORTED = new Set(['Reservation', 'AgencyStaff']) // no updatedAt column
  if (localUpdatedAt && !LWW_UNSUPPORTED.has(model)) {
    const cloudRecord = await delegate.findUnique({
      where: { id: recordId },
      select: { updatedAt: true, id: true },
    }).catch(() => null)
    if (cloudRecord?.updatedAt && new Date(cloudRecord.updatedAt).getTime() > new Date(localUpdatedAt).getTime()) {
      return { lwwKeptCloud: true, record: cloudRecord }
    }
  }

  switch (operation) {
    case 'create': {
      // Resurrection guard (spec Part AA): a create whose id matches a cloud
      // tombstone is a deleted record coming back. Allowed ONLY when the
      // local mutation is strictly newer than the tombstone (documented
      // legitimate re-creation); otherwise deterministic conflict.
      const tomb = await tx.deletedRecord.findFirst({ where: { modelName: model, recordId } })
      if (tomb) {
        const tombMs = new Date(tomb.deletedAt).getTime()
        const localMs = localUpdatedAt ? new Date(localUpdatedAt).getTime() : 0
        if (localMs <= tombMs) {
          const err = new Error('Resurrection blocked - record ' + model + '/' + recordId + ' was deleted on cloud at ' + tomb.deletedAt.toISOString())
          ;(err as any).code = 'RESURRECTION_BLOCKED'
          throw err
        }
      }
      const createData = sanitizeDateStrings({ id: recordId, ...dataWithMeta })
      return delegate.upsert({
        where: { id: recordId },
        create: createData,
        update: sanitizeDateStrings(dataWithMeta),
      })
    }
    case 'update': {
      const filtered: Record<string, any> = {}
      for (const field of config.mutableFields) {
        if (field in dataWithMeta) filtered[field] = dataWithMeta[field]
      }
      if (Object.keys(filtered).length === 0) return { noop: true }
      return delegate.update({
        where: { id: recordId },
        data: sanitizeDateStrings(filtered),
      })
    }
    case 'delete': {
      try {
        await delegate.delete({ where: { id: recordId } })
      } catch (err: any) {
        // P2025 = already gone — idempotent success
        if (err?.code !== 'P2025') throw err
      }
      await tx.deletedRecord.create({
        data: { modelName: model, recordId },
      }).catch(() => { /* tombstone may exist */ })
      return { deleted: true }
    }
    default:
      throw new Error(`Unknown operation: ${operation}`)
  }
}

/** Convert ISO date strings to Date objects for Prisma writes. */
function sanitizeDateStrings(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && ISO_DATE_RE.test(value) && LOOKS_LIKE_DATE_FIELD_RE.test(key)) {
      const d = new Date(value)
      if (!Number.isNaN(d.getTime())) {
        out[key] = d
        continue
      }
    }
    out[key] = value
  }
  return out
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const LOOKS_LIKE_DATE_FIELD_RE = /At$|^At|Date$|date$|Deadline$|deadline$/

// ─── 8. Cursor + diagnostics helpers ────────────────────────────────────────

/** Latest global SyncChange sequence (0 when feed is empty). */
export async function getLatestSequence(_agencyId?: string): Promise<number> {
  const latest = await db.syncChange.findFirst({
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  return latest?.sequence ?? 0
}

/**
 * Prune old SyncChange rows (feed compaction). Cursors beyond the prune
 * horizon heal via the desktop's periodic FULL reconciliation (cursor reset).
 */
export async function pruneSyncChanges(days: number = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  try {
    const res = await dbRaw.$executeRawUnsafe(
      'DELETE FROM "SyncChange" WHERE "changedAt" < ?',
      cutoff.toISOString(),
    )
    return typeof res === 'number' ? res : 0
  } catch (err) {
    console.warn('[sync-helpers] prune failed:', (err as Error)?.message)
    return 0
  }
}

// ─── Error classes ───────────────────────────────────────────────────────────

export class IdempotencyConflictError extends Error {
  public readonly mutationId: string
  constructor(message: string, mutationId: string) {
    super(message)
    this.name = 'IdempotencyConflictError'
    this.mutationId = mutationId
  }
}
