/**
 * BLASTI Sync Routes — v2 (cursor-based change feed)
 *
 * The authoritative synchronization endpoints for offline-first clients.
 *
 *   POST /api/sync/pull   — Pull changes since a sequence cursor
 *   POST /api/sync/push   — Push mutations (idempotent, conflict-aware)
 *   GET  /api/sync/status — Sync service diagnostics
 *   POST /api/sync/initial-data — Stage-based initial import (initial-sync.ts)
 *
 * PROTOCOL v2 (SYNC_PROTOCOL_VERSION = 2, @blasti/core/sync-registry):
 *
 *   Pull request:  { agencyId?, sinceSequence?, limit? }
 *   Pull response: { success, timestamp, latestSequence, hasMore,
 *                    changes: { [Model]: { changed: [records], deleted: [ids] } } }
 *
 *   Push request:  { agencyId?, mutations: [{ mutationId, model, recordId,
 *                    operation, data, expectedVersion?, localUpdatedAt? }] }
 *   Push response: { success, results: [{ mutationId,
 *                    status: applied|duplicate|conflict|error, conflict? }] }
 *
 * Real-time delivery: SyncChange rows are recorded by the tracking layer and
 * a debounced `sync:changes` Socket.IO event notifies agency rooms. Events
 * are a fast-path hint ONLY — the cursor pull above is the authoritative
 * reconciliation mechanism (missed events are always recovered).
 */

import { Hono } from 'hono'
import { requireAuth, authErrorResponse, AuthError, requireAgencyAccess } from '../lib/auth'
import { SYNC_PROTOCOL_VERSION } from '@blasti/core/sync-registry'
import {
  getChangesSinceCursor,
  processPushMutation,
  getLatestSequence,
  type ProcessPushMutationResult,
} from '../lib/sync-helpers'
import { getPendingSyncNotifications } from '../lib/sync-notify'
import { z } from 'zod'

const app = new Hono()

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the agency a sync consumer operates on.
 * SUPER_ADMINs must pass agencyId explicitly; staff/owners resolve from DB.
 */
async function resolveTargetAgencyId(
  user: { id: string; role: string },
  requestedAgencyId?: string,
): Promise<string | null> {
  if (requestedAgencyId) return requestedAgencyId
  if (user.role === 'SUPER_ADMIN') return null

  const { db } = await import('@blasti/db')
  const staffRecord = await db.agencyStaff.findFirst({
    where: { userId: user.id, isActive: true },
    select: { agencyId: true },
  })
  if (staffRecord?.agencyId) return staffRecord.agencyId

  const ownedAgency = await db.agency.findFirst({
    where: { ownerId: user.id },
    select: { id: true },
  })
  return ownedAgency?.id ?? null
}

function authError(c: any, error: unknown) {
  if (error instanceof AuthError) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
  const message = error instanceof Error ? error.message : 'Internal server error'
  console.error('[SYNC] endpoint error:', error)
  return c.json({ success: false, error: message }, 500)
}

// ─── Pull ────────────────────────────────────────────────────────────────────

const pullSchema = z.object({
  agencyId: z.string().optional(),
  sinceSequence: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  protocolVersion: z.number().optional(),
})

/**
 * Protocol negotiation (spec Part AM): a client speaking a NEWER protocol
 * than this server MUST be rejected with UPDATE_REQUIRED instead of silently
 * receiving mismatched semantics.
 */
function checkProtocolVersion(clientVersion: number | undefined): boolean {
  return clientVersion === undefined || clientVersion <= SYNC_PROTOCOL_VERSION
}

// POST /api/sync/pull — incremental change feed since a cursor
app.post('/pull', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json().catch(() => ({}))
    const validation = pullSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid pull request', details: validation.error.issues }, 400)
    }

    const { agencyId: requestedAgencyId, sinceSequence = 0, limit = 500, protocolVersion } = validation.data

    if (!checkProtocolVersion(protocolVersion)) {
      return c.json({
        success: false,
        error: 'UPDATE_REQUIRED',
        detail: `Client protocol ${protocolVersion} is newer than server protocol ${SYNC_PROTOCOL_VERSION} — update the server`,
        serverProtocolVersion: SYNC_PROTOCOL_VERSION,
      }, 400)
    }

    const targetAgencyId = await resolveTargetAgencyId(user, requestedAgencyId)
    if (!targetAgencyId) {
      return c.json({ success: false, error: 'agencyId is required for SUPER_ADMIN pull' }, 400)
    }

    await requireAgencyAccess(c, targetAgencyId)

    const result = await getChangesSinceCursor(targetAgencyId, sinceSequence, limit)

    return c.json({
      success: true,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      agencyId: targetAgencyId,
      sinceSequence,
      // SAFE cursor (spec Part L): last sequence INCLUDED in this page.
      pageLastSequence: result.pageLastSequence,
      latestSequence: result.pageLastSequence,
      // Observability only — clients must NEVER advance to this.
      globalCurrentSequence: result.globalCurrentSequence,
      // Retention signal (spec Part AB): cursor < oldestAvailable → reconcile.
      oldestAvailableSequence: result.oldestAvailableSequence,
      hasMore: result.hasMore,
      timestamp: new Date().toISOString(),
      changes: result.changes,
    })
  } catch (error: unknown) {
    return authError(c, error)
  }
})

// ─── Push ────────────────────────────────────────────────────────────────────

const pushMutationSchema = z.object({
  mutationId: z.string().optional(),
  model: z.string().min(1),
  recordId: z.string().min(1),
  operation: z.enum(['create', 'update', 'delete']),
  data: z.record(z.string(), z.any()).default({}),
  expectedVersion: z.number().int().optional(),
  localUpdatedAt: z.string().optional(),
})

const pushSchemaV2 = z.object({
  agencyId: z.string().optional(),
  mutations: z.array(pushMutationSchema).optional(),
  // Legacy WatermelonDB-shaped payload (changes map) — converted server-side.
  changes: z.record(z.string(), z.any()).optional(),
  protocolVersion: z.number().optional(),
})

// POST /api/sync/push — idempotent, conflict-aware mutation processing
app.post('/push', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json().catch(() => ({}))
    const validation = pushSchemaV2.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid push request', details: validation.error.issues }, 400)
    }

    const { agencyId: requestedAgencyId, mutations, changes, protocolVersion } = validation.data

    if (!checkProtocolVersion(protocolVersion)) {
      return c.json({
        success: false,
        error: 'UPDATE_REQUIRED',
        detail: `Client protocol ${protocolVersion} is newer than server protocol ${SYNC_PROTOCOL_VERSION} — update the server`,
        serverProtocolVersion: SYNC_PROTOCOL_VERSION,
      }, 400)
    }

    const targetAgencyId = await resolveTargetAgencyId(user, requestedAgencyId)
    if (!targetAgencyId && (mutations?.length || changes)) {
      // Pushes always act on agency data; customers push their own reservations
      if (user.role === 'CUSTOMER' && !requestedAgencyId) {
        return c.json({ success: false, error: 'agencyId is required for customer push' }, 400)
      }
      return c.json({ success: false, error: 'agencyId is required for SUPER_ADMIN push' }, 400)
    }
    const agencyId = targetAgencyId || requestedAgencyId || ''
    if (agencyId) await requireAgencyAccess(c, agencyId)

    // Normalize input: v2 mutations array, or legacy changes map
    const normalized: z.infer<typeof pushMutationSchema>[] = mutations ? [...mutations] : []

    if (changes) {
      for (const [modelName, modelChanges] of Object.entries(changes)) {
        const mc = modelChanges as { created?: any[]; updated?: any[]; deleted?: string[] }
        for (const rec of mc.created || []) {
          normalized.push({
            mutationId: rec.mutationId,
            model: modelName,
            recordId: rec.id,
            operation: 'create',
            data: rec,
          })
        }
        for (const rec of mc.updated || []) {
          normalized.push({
            mutationId: rec.mutationId,
            model: modelName,
            recordId: rec.id,
            operation: 'update',
            data: rec,
            localUpdatedAt: rec.updatedAt,
          })
        }
        for (const recordId of mc.deleted || []) {
          normalized.push({ model: modelName, recordId, operation: 'delete', data: {} })
        }
      }
    }

    if (normalized.length === 0) {
      return c.json({ success: true, results: [], timestamp: new Date().toISOString() })
    }

    // Cap batch size for responsiveness (desktop pages its outbox)
    const batch = normalized.slice(0, 500)

    const results: Array<{ mutationId: string | null; model: string; recordId: string; status: ProcessPushMutationResult['status']; conflict?: any }> = []
    for (const mutation of batch) {
      const res = await processPushMutation({
        agencyId: agencyId || '',
        model: mutation.model,
        recordId: mutation.recordId,
        operation: mutation.operation,
        data: mutation.data,
        mutationId: mutation.mutationId,
        expectedVersion: mutation.expectedVersion,
        localUpdatedAt: mutation.localUpdatedAt,
      })
      results.push({
        mutationId: mutation.mutationId ?? null,
        model: mutation.model,
        recordId: mutation.recordId,
        status: res.status,
        conflict: res.conflict,
      })
    }

    const counts = results.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1
        return acc
      },
      { applied: 0, duplicate: 0, conflict: 0, error: 0 } as Record<string, number>,
    )

    return c.json({
      success: true,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      results,
      counts,
      hasMore: normalized.length > batch.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error: unknown) {
    return authError(c, error)
  }
})

// ─── Status ──────────────────────────────────────────────────────────────────

// GET /api/sync/status — sync service diagnostics
app.get('/status', async (c) => {
  try {
    const user = await requireAuth(c)
    const targetAgencyId = await resolveTargetAgencyId(user)

    let latestSequence = 0
    try {
      latestSequence = await getLatestSequence()
    } catch { /* feed may not exist yet */ }

    return c.json({
      success: true,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      syncedModels: 19,
      serverTime: new Date().toISOString(),
      latestSequence,
      realtime: { healthy: true, notifierPending: Object.keys(getPendingSyncNotifications()).length },
    })
  } catch (error: unknown) {
    return authError(c, error)
  }
})

export default app
export { app as syncRoutes }
