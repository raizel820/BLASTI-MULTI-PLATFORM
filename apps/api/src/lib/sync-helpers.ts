/**
 * BLASTI Cloud Sync Helpers — Phase 5
 *
 * Provides the cloud-side sync infrastructure that every mutation route MUST use.
 * Guarantees:
 *   - Every business mutation records a SyncChange in the SAME transaction
 *   - Idempotency protection via SyncMutation (prevents duplicate retries)
 *   - Atomic syncVersion bumps on affected records
 *   - Cursor-based pull with monotonic sequence numbers
 *
 * Usage:
 *   import { atomicMutation, withIdempotency, processPushMutation } from '../lib/sync-helpers'
 */

import { cloudDb, suppressAutoSyncChange } from '@blasti/cloud-db'
import {
  SYNC_REGISTRY,
  ConflictStrategy,
  type SyncModelConfig,
} from '@blasti/core/sync-registry'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Interactive transaction client — the `$transaction(fn)` callback parameter.
 *
 * We use `any` here because the extended Prisma client's $transaction
 * overload signatures are complex and vary across Prisma versions.
 * The actual runtime type is the full Prisma delegate set scoped to the tx.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TxClient = any

// ─── 1. recordSyncChange() ───────────────────────────────────────────────────

export interface RecordSyncChangeParams {
  tx: TxClient
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
  syncVersion: number
  mutationId?: string
}

/**
 * Record a SyncChange entry INSIDE the current transaction.
 *
 * Must be called after every successful business mutation so the change
 * is visible to pull consumers. The `sequence` field uses PostgreSQL
 * autoincrement — no manual MAX+1 required.
 */
export async function recordSyncChange(params: RecordSyncChangeParams): Promise<void> {
  const { tx, agencyId, model, recordId, operation, syncVersion, mutationId } = params

  await tx.syncChange.create({
    data: {
      agencyId,
      model,
      recordId,
      operation,
      syncVersion,
      mutationId,
    },
  })
}

// ─── 2. withIdempotency() ────────────────────────────────────────────────────

export interface WithIdempotencyParams {
  idempotencyKey: string
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
  payloadHash: string
}

export interface WithIdempotencyResult<T> {
  result: T
  mutationId: string
  wasDuplicate: boolean
}

/**
 * Wrap a mutation handler with durable idempotency protection.
 *
 * - If the idempotency key was already completed → return cached result
 * - If pending (concurrent request in progress) → reject with 409
 * - Otherwise → create SyncMutation (pending), execute in $transaction,
 *   mark completed, return result
 * - On failure → mark SyncMutation as failed
 */
export async function withIdempotency<T>(
  params: WithIdempotencyParams,
  mutation: (tx: TxClient) => Promise<T>,
): Promise<WithIdempotencyResult<T>> {
  const { idempotencyKey, agencyId, model, recordId, operation, payloadHash } = params

  // Check for existing SyncMutation with the same idempotency key
  const existing = await cloudDb.syncMutation.findUnique({
    where: { idempotencyKey },
  })

  if (existing) {
    if (existing.status === 'completed') {
      // Return cached result — safe replay
      const cached = existing.result ? JSON.parse(existing.result) : null
      return {
        result: cached as T,
        mutationId: existing.id,
        wasDuplicate: true,
      }
    }

    if (existing.status === 'pending') {
      // Concurrent mutation in progress — reject
      throw new IdempotencyConflictError(
        `Concurrent mutation in progress for key: ${idempotencyKey}`,
        existing.id,
      )
    }

    // Status is "failed" — allow retry by deleting the old entry
    await cloudDb.syncMutation.delete({ where: { id: existing.id } })
  }

  // Create SyncMutation as pending
  const syncMutation = await cloudDb.syncMutation.create({
    data: {
      idempotencyKey,
      agencyId,
      model,
      recordId,
      operation,
      payloadHash,
      status: 'pending',
    },
  })

  try {
    // Execute the mutation inside a transaction
    // Use type assertion to bypass the extended client's complex $transaction overloads
    const result = await (cloudDb as any).$transaction(async (tx: TxClient) => {
      return mutation(tx)
    }) as T

    // Mark as completed with serialized result
    await cloudDb.syncMutation.update({
      where: { id: syncMutation.id },
      data: {
        status: 'completed',
        result: JSON.stringify(result),
        processedAt: new Date(),
      },
    })

    return {
      result,
      mutationId: syncMutation.id,
      wasDuplicate: false,
    }
  } catch (error) {
    // Mark as failed
    await cloudDb.syncMutation.update({
      where: { id: syncMutation.id },
      data: {
        status: 'failed',
        processedAt: new Date(),
      },
    })
    throw error
  }
}

// ─── 3. atomicMutation() ─────────────────────────────────────────────────────

/**
 * Execute a business mutation atomically with SyncChange recording.
 *
 * This is the primary helper for cloud-side mutations. It:
 *   1. Opens a $transaction
 *   2. Executes the mutation callback
 *   3. Increments syncVersion on the affected record
 *   4. Records a SyncChange in the same transaction
 *   5. Commits
 */
export async function atomicMutation<T>(
  agencyId: string,
  model: string,
  recordId: string,
  operation: 'create' | 'update' | 'delete',
  mutation: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return (cloudDb as any).$transaction(async (tx: TxClient) => {
    // Execute the business mutation
    const result = await mutation(tx)

    // Determine the new syncVersion
    // For create: start at 1, for update/delete: increment existing
    let newSyncVersion = 1

    if (operation !== 'create') {
      // Fetch the current syncVersion from the record
      const config = getSyncModelConfig(model)
      if (config) {
        const delegate = (tx as any)[config.delegate]
        if (delegate) {
          const record = await delegate.findUnique({
            where: { id: recordId },
            select: { syncVersion: true },
          })
          if (record) {
            newSyncVersion = (record.syncVersion ?? 0) + 1
          }
        }
      }
    }

    // Bump syncVersion on the affected record (create already has default 0,
    // but we want it at 1 for the first sync)
    const config = getSyncModelConfig(model)
    if (config) {
      const delegate = (tx as any)[config.delegate]
      if (delegate && operation !== 'delete') {
        try {
          await delegate.update({
            where: { id: recordId },
            data: { syncVersion: newSyncVersion },
          })
        } catch {
          // Record may not exist or may be in a different state — non-fatal
          // for sync purposes; the SyncChange will still be recorded.
        }
      }
    }

    // Record the SyncChange in the same transaction
    await recordSyncChange({
      tx,
      agencyId,
      model,
      recordId,
      operation,
      syncVersion: newSyncVersion,
    })

    return result
  })
}

// ─── 4. getChangesSinceCursor() ──────────────────────────────────────────────

export interface SyncChangeRecord {
  id: string
  sequence: number
  agencyId: string
  model: string
  recordId: string
  operation: string
  syncVersion: number
  changedAt: Date
  mutationId: string | null
}

export interface GetChangesSinceCursorResult {
  changes: SyncChangeRecord[]
  hasMore: boolean
  latestSequence: number
}

/**
 * Get all SyncChange records since a cursor (for pull endpoint).
 *
 * Uses the monotonic `sequence` field for efficient cursor-based pagination.
 * Returns up to `limit` changes plus a `hasMore` flag.
 */
export async function getChangesSinceCursor(
  agencyId: string,
  sinceSequence: number,
  limit: number = 500,
): Promise<GetChangesSinceCursorResult> {
  // Fetch limit + 1 to determine if there are more results
  const rows = await cloudDb.syncChange.findMany({
    where: {
      agencyId,
      sequence: { gt: sinceSequence },
    },
    orderBy: { sequence: 'asc' },
    take: limit + 1,
  })

  const hasMore = rows.length > limit
  const changes = hasMore ? rows.slice(0, limit) : rows

  // Compute the latest sequence in the result set
  const latestSequence =
    changes.length > 0
      ? changes[changes.length - 1].sequence
      : sinceSequence

  return {
    changes: changes as SyncChangeRecord[],
    hasMore,
    latestSequence,
  }
}

// ─── 5. advanceCursor() ──────────────────────────────────────────────────────

/**
 * Update the agency's SyncCursor after a successful pull.
 *
 * Creates the cursor row if it doesn't exist (first pull).
 */
export async function advanceCursor(
  agencyId: string,
  pulledSeq: number,
): Promise<void> {
  await cloudDb.syncCursor.upsert({
    where: { agencyId },
    create: {
      agencyId,
      lastPulledSeq: pulledSeq,
      lastPulledAt: new Date(),
    },
    update: {
      lastPulledSeq: pulledSeq,
      lastPulledAt: new Date(),
    },
  })
}

// ─── 6. processPushMutation() ────────────────────────────────────────────────

export interface ProcessPushMutationParams {
  agencyId: string
  model: string
  recordId: string
  operation: 'create' | 'update' | 'delete'
  data: Record<string, any>
  idempotencyKey?: string
  expectedVersion?: number
}

export interface ProcessPushMutationConflict {
  reason: string
  localVersion: number
  cloudVersion: number
}

export interface ProcessPushMutationResult {
  success: boolean
  conflict?: ProcessPushMutationConflict
  result?: any
}

/**
 * Process an incoming mutation from desktop with full safety:
 *
 * 1. Look up the SyncModelConfig for conflict strategy
 * 2. If version-aware: check expectedVersion against cloud syncVersion
 * 3. Apply the mutation inside atomicMutation (syncVersion bump + SyncChange)
 * 4. If idempotencyKey provided: wrap in withIdempotency
 */
export async function processPushMutation(
  params: ProcessPushMutationParams,
): Promise<ProcessPushMutationResult> {
  const { agencyId, model, recordId, operation, data, idempotencyKey, expectedVersion } = params

  const config = getSyncModelConfig(model)

  // ── Version-aware conflict detection ──────────────────────────────────
  if (config && config.conflictStrategy === ConflictStrategy.VERSION_AWARE) {
    if (expectedVersion !== undefined) {
      const delegate = (cloudDb as any)[config.delegate]
      if (delegate) {
        const cloudRecord = await delegate.findUnique({
          where: { id: recordId },
          select: { syncVersion: true },
        })

        if (cloudRecord && cloudRecord.syncVersion !== expectedVersion) {
          return {
            success: false,
            conflict: {
              reason: 'Version mismatch — cloud record has been modified since last sync',
              localVersion: expectedVersion,
              cloudVersion: cloudRecord.syncVersion,
            },
          }
        }
      }
    }
  }

  // ── Cloud-authoritative check ─────────────────────────────────────────
  if (config && config.conflictStrategy === ConflictStrategy.CLOUD_AUTHORITATIVE) {
    if (operation === 'update' || operation === 'delete') {
      return {
        success: false,
        conflict: {
          reason: 'Model is cloud-authoritative — local mutations not allowed',
          localVersion: expectedVersion ?? 0,
          cloudVersion: 0,
        },
      }
    }
  }

  // ── Append-only check ─────────────────────────────────────────────────
  if (config && config.conflictStrategy === ConflictStrategy.APPEND_ONLY) {
    if (operation === 'update' || operation === 'delete') {
      return {
        success: false,
        conflict: {
          reason: 'Model is append-only — updates and deletes not allowed',
          localVersion: expectedVersion ?? 0,
          cloudVersion: 0,
        },
      }
    }
  }

  // ── Build and execute the mutation ────────────────────────────────────
  try {
    // If an idempotency key is provided, use withIdempotency
    if (idempotencyKey) {
      const payloadHash = hashPayload(data)
      // suppressAutoSyncChange: atomicMutation/withIdempotency record SyncChange
      // explicitly — the @blasti/cloud-db auto-hook must stay silent inside
      // push processing or every push yields 2-3 redundant rows.
      const idemResult = await suppressAutoSyncChange(() =>
        withIdempotency(
          {
            idempotencyKey,
            agencyId,
            model,
            recordId,
            operation,
            payloadHash,
          },
          async (tx) => {
            return applyMutationInTx(tx, config, model, recordId, operation, data)
          },
        ),
      )

      return {
        success: true,
        result: idemResult.result,
      }
    }

    // No idempotency key — use atomicMutation directly (auto-hook suppressed,
    // same reason as the withIdempotency path above)
    const result = await suppressAutoSyncChange(() =>
      atomicMutation(
        agencyId,
        model,
        recordId,
        operation,
        async (tx) => {
          return applyMutationInTx(tx, config, model, recordId, operation, data)
        },
      ),
    )

    return {
      success: true,
      result,
    }
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return {
        success: false,
        conflict: {
          reason: error.message,
          localVersion: expectedVersion ?? 0,
          cloudVersion: 0,
        },
      }
    }

    // Other errors — return as failure
    const message = error instanceof Error ? error.message : 'Unknown mutation error'
    return {
      success: false,
      conflict: {
        reason: `Mutation failed: ${message}`,
        localVersion: expectedVersion ?? 0,
        cloudVersion: 0,
      },
    }
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Look up a SyncModelConfig from the registry.
 */
function getSyncModelConfig(model: string): SyncModelConfig | undefined {
  return SYNC_REGISTRY.find((c) => c.model === model)
}

/**
 * Apply a mutation inside a transaction client.
 *
 * Uses the model config's delegate name to access the correct Prisma delegate.
 * For creates: uses `upsert` (idempotent create-or-noop).
 * For updates: uses `updateMany` with the filtered data.
 * For deletes: uses `delete`.
 */
async function applyMutationInTx(
  tx: TxClient,
  config: SyncModelConfig | undefined,
  model: string,
  recordId: string,
  operation: 'create' | 'update' | 'delete',
  data: Record<string, any>,
): Promise<any> {
  if (!config) {
    throw new Error(`No sync registry config for model: ${model}`)
  }

  const delegate = (tx as any)[config.delegate]
  if (!delegate) {
    throw new Error(`No Prisma delegate for model: ${model} (delegate: ${config.delegate})`)
  }

  // Filter data to only include mutable fields for updates
  let filteredData = data
  if (operation === 'update') {
    filteredData = {}
    for (const field of config.mutableFields) {
      if (field in data) {
        filteredData[field] = data[field]
      }
    }
    if (Object.keys(filteredData).length === 0) {
      return null // No mutable fields to update
    }
  }

  switch (operation) {
    case 'create': {
      // Use upsert for idempotent create — if record already exists, no-op
      return delegate.upsert({
        where: { id: recordId },
        create: { id: recordId, ...data },
        update: {},
      })
    }

    case 'update': {
      return delegate.update({
        where: { id: recordId },
        data: filteredData,
      })
    }

    case 'delete': {
      return delegate.delete({
        where: { id: recordId },
      })
    }

    default:
      throw new Error(`Unknown operation: ${operation}`)
  }
}

/**
 * Compute a SHA-256 hash of the payload for idempotency dedup verification.
 * Uses Node.js crypto when available; falls back to a fast deterministic hash.
 */
function hashPayload(data: Record<string, any>): string {
  const str = JSON.stringify(data, Object.keys(data).sort())

  try {
    // Use Node.js crypto for proper SHA-256
    const crypto = require('crypto')
    return crypto.createHash('sha256').update(str).digest('hex')
  } catch {
    // Fallback: simple hash for environments without crypto
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash + char) | 0
    }
    return `h:${hash.toString(36)}`
  }
}

// ─── Error Classes ────────────────────────────────────────────────────────────

export class IdempotencyConflictError extends Error {
  public readonly mutationId: string

  constructor(message: string, mutationId: string) {
    super(message)
    this.name = 'IdempotencyConflictError'
    this.mutationId = mutationId
  }
}

// ─── Convenience: getCursor() ────────────────────────────────────────────────

/**
 * Get the current sync cursor for an agency.
 * Returns 0 if no cursor exists (never synced).
 */
export async function getCursor(agencyId: string): Promise<number> {
  const cursor = await cloudDb.syncCursor.findUnique({
    where: { agencyId },
    select: { lastPulledSeq: true },
  })
  return cursor?.lastPulledSeq ?? 0
}

/**
 * Get the latest SyncChange sequence for an agency.
 * Returns 0 if no changes exist.
 */
export async function getLatestSequence(agencyId: string): Promise<number> {
  const latest = await cloudDb.syncChange.findFirst({
    where: { agencyId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  })
  return latest?.sequence ?? 0
}
