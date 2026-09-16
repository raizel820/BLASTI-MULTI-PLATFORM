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
 * pull cursor currency: it MUST be monotonic per database, not per agency.
 */
export async function recordSyncChange(params: RecordSyncChangeParams): Promise<void> {
  const { tx, agencyId, model, recordId, operation, syncVersion, mutationId, origin } = params

  // Global sentinel keeps platform-wide models (SMS settings, plans…) in the
  // feed of every agency without exploding rows per agency.
  const scopedAgencyId = agencyId || GLOBAL_AGENCY

  await tx.$executeRawUnsafe(
    'INSERT INTO "SyncChange" ' +
    '("id", "sequence", "agencyId", "model", "recordId", "operation", "syncVersion", "mutationId", "origin", "changedAt") ' +
    'SELECT ?, COALESCE((SELECT MAX("sequence") FROM "SyncChange"), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?',
    randomUUID(),
    scopedAgencyId,
    model,
    recordId,
    operation,
    syncVersion ?? 0,
    mutationId ?? null,
    origin ?? getSyncContext()?.origin ?? 'cloud',
    new Date().toISOString(),
  )
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
 */
async function resolveAgencyForRecord(model: string, record: any): Promise<string | null> {
  if (!record) return null

  const direct = DIRECT_AGENCY_FIELD[model]
  if (direct) return direct(record) || null
  if (GLOBAL_MODELS.has(model)) return GLOBAL_AGENCY

  try {
    if (model === 'Counter' && record.branchId) {
      const branch = await db.branch.findUnique({
        where: { id: record.branchId },
        select: { agencyId: true },
      })
      return branch?.agencyId ?? null
    }

    if (model === 'Notification' && record.userId) {
      const staff = await db.agencyStaff.findFirst({
        where: { userId: record.userId },
        select: { agencyId: true },
        
      })
      if (staff?.agencyId) return staff.agencyId
      const owned = await db.agency.findFirst({
        where: { ownerId: record.userId },
        select: { id: true },
      })
      return owned?.id ?? null
    }

    if (model === 'User' && record.id) {
      const staff = await db.agencyStaff.findFirst({
        where: { userId: record.id, isActive: true },
        select: { agencyId: true },
        
      })
      if (staff?.agencyId) return staff.agencyId
      const owned = await db.agency.findFirst({
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

function enqueueSyncEvent(task: SyncEventTask): void {
  _syncEventQueue.push(task)
  if (!_syncEventDraining) {
    _syncEventDraining = true
    void Promise.resolve()
      .then(_drainSyncEvents)
      .finally(() => {
        _syncEventDraining = false
      })
  }
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
  syncVersion?: number
}): Promise<void> {
  const { agencyId, model, recordId, operation, syncVersion } = params
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
        'SELECT ?, COALESCE((SELECT MAX("sequence") FROM "SyncChange"), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ? ' +
        'RETURNING "sequence"',
        randomUUID(),
        scoped,
        model,
        recordId,
        operation,
        syncVersion ?? 0,
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
    // Fire-and-forget: the business mutation must never wait on sync
    // bookkeeping (see the background-queue rationale above). The awaited
    // promise resolves immediately — the work runs on the background worker.
    enqueueSyncEvent(async () => {
      await _processSyncEvent(evt)
    })
  })
}

/** Apply one captured sync event (runs on the serialized background worker). */
async function _processSyncEvent(evt: {
  model: string
  operation: string
  args: any
  result: any
  preDeleteRecords: any[] | null
}): Promise<void> {
  const { model, operation, args, result, preDeleteRecords } = evt

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

    const syncVersion = typeof record.syncVersion === 'number' ? record.syncVersion : 0
    await recordChangeAuto({
      agencyId,
      model,
      recordId,
      operation: op,
      syncVersion,
    })
}

// ─── 4. Change feed query ────────────────────────────────────────────────────

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
 *   (scalar fields only — safe for raw-SQL upsert into the local SQLite).
 * - latestSequence is the GLOBAL max at snapshot time: safe to advance to even
 *   when rows of other agencies were skipped (they are beyond the cursor).
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

  const latestRows = await db.syncChange.findFirst({
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  const globalMax = latestRows?.sequence ?? sinceSequence

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
        out[model].changed.push(scalarizeRecord(r))
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
    latestSequence: Math.max(globalMax, sinceSequence),
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
 * - completed key  → return the cached result (safe replay)
 * - new key        → execute inside $transaction, store result, return
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

  const existing = await db.syncMutation.findUnique({ where: { idempotencyKey } })
  if (existing && existing.status === 'completed') {
    const cached = existing.result ? JSON.parse(existing.result) : null
    return { result: cached as T, mutationId: existing.id, wasDuplicate: true }
  }
  if (existing && existing.status === 'pending') {
    // Stale pending (crashed run) — older than 2 minutes → reclaim
    const age = Date.now() - new Date(existing.processedAt).getTime()
    if (age < 120_000) {
      throw new IdempotencyConflictError(
        `Concurrent mutation in progress for key: ${idempotencyKey}`,
        existing.id,
      )
    }
    await db.syncMutation.delete({ where: { id: existing.id } })
  }

  const syncMutation = await db.syncMutation.create({
    data: {
      idempotencyKey,
      agencyId: agencyId || GLOBAL_AGENCY,
      model,
      recordId: recordId ?? null,
      operation,
      status: 'pending',
    },
  })

  try {
    const result = await dbRaw.$transaction(async (tx: TxClient) => mutation(tx))
    await db.syncMutation.update({
      where: { id: syncMutation.id },
      data: { status: 'completed', result: JSON.stringify(result ?? null), processedAt: new Date() },
    })
    return { result, mutationId: syncMutation.id, wasDuplicate: false }
  } catch (error) {
    try {
      await db.syncMutation.update({
        where: { id: syncMutation.id },
        data: { status: 'failed', processedAt: new Date() },
      })
    } catch { /* ignore */ }
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

    let newSyncVersion = 1
    if (operation !== 'create') {
      const config = getSyncModelConfig(model)
      if (config) {
        const delegate = (tx as any)[config.delegate]
        if (delegate) {
          const rec = await delegate.findUnique({
            where: { id: recordId },
            select: { syncVersion: true },
          }).catch(() => null)
          if (rec) newSyncVersion = (rec.syncVersion ?? 0) + 1
        }
      }
    }

    const config = getSyncModelConfig(model)
    if (config && operation !== 'delete') {
      const delegate = (tx as any)[config.delegate]
      if (delegate) {
        await delegate.update({
          where: { id: recordId },
          data: { syncVersion: newSyncVersion },
        }).catch(() => { /* record may be gone — SyncChange still recorded */ })
      }
    }

    await recordSyncChange({ tx, agencyId, model, recordId, operation, syncVersion: newSyncVersion })
    return result
  })
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

  // ── Version-aware conflict detection ────────────────────────────────────
  if (config.conflictStrategy === ConflictStrategy.VERSION_AWARE && expectedVersion !== undefined) {
    const delegate = (dbRaw as any)[config.delegate]
    if (delegate) {
      const cloudRecord = await delegate.findUnique({
        where: { id: recordId },
        select: { syncVersion: true },
      }).catch(() => null)
      if (cloudRecord && cloudRecord.syncVersion !== expectedVersion) {
        return {
          status: 'conflict',
          conflict: {
            reason: 'Version mismatch — cloud record has been modified since last sync',
            localVersion: expectedVersion,
            cloudVersion: cloudRecord.syncVersion,
          },
        }
      }
    }
  }

  const apply = async (tx: TxClient): Promise<any> => {
    const result = await applyMutationInTx(tx, config, model, recordId, operation, data, localUpdatedAt)

    // Record the change so OTHER clients (web, other desktops) converge.
    // The originator suppresses its own echo via mutationId on pull.
    let newSyncVersion = 0
    try {
      if (operation !== 'delete') {
        const delegate = (tx as any)[config.delegate]
        const rec = await delegate.findUnique({
          where: { id: recordId },
          select: { syncVersion: true },
        }).catch(() => null)
        if (rec) {
          newSyncVersion = (rec.syncVersion ?? 0) + 1
          await delegate.update({
            where: { id: recordId },
            data: { syncVersion: newSyncVersion },
          }).catch(() => { /* non-fatal */ })
        }
      }
    } catch { /* non-fatal */ }

    await recordSyncChange({
      tx,
      agencyId,
      model,
      recordId,
      operation,
      syncVersion: newSyncVersion,
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
      return {
        status: res.wasDuplicate ? 'duplicate' : 'applied',
        result: res.result,
      }
    }

    const result = await atomicMutation(agencyId, model, recordId, operation, apply)
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

  // LWW guard: cloud record strictly newer than the local mutation → keep cloud
  if (localUpdatedAt) {
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
