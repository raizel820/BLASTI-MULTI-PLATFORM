/**
 * BLASTI Idempotency Middleware — exactly-once business effect for outbox replay
 *
 * Route-agnostic Hono middleware. When a mutation request carries an
 * `X-Idempotency-Key` header (the desktop outbox always sends one):
 *
 *   1. The key is looked up in the SyncMutation ledger.
 *      - completed → the STORED response is returned verbatim (duplicate).
 *      - pending & fresh (<2 min) → 409 (concurrent retry).
 *   2. Otherwise the handler chain runs inside a sync request context
 *      (AsyncLocalStorage) so the sync-tracking layer can stamp SyncChange
 *      rows with the mutationId (echo suppression on pull).
 *   3. On a 2xx response the result is stored → future replays return it.
 *
 * This guarantees "first request applies, duplicate is recognized" for every
 * business route without touching each handler.
 */

import type { MiddlewareHandler } from 'hono'
import { db, dbRaw } from '@blasti/db'
import { verifySessionToken } from './auth'
import { runWithSyncContext } from './sync-notify'
import { randomUUID } from 'node:crypto'

const IDEMPOTENCY_HEADER = 'x-idempotency-key'
const PENDING_GRACE_MS = 120_000

export const idempotencyGuard: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase()
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
    return next()
  }

  const key = c.req.header(IDEMPOTENCY_HEADER)
  if (!key || key.length < 8 || key.length > 256) {
    return next()
  }

  // Resolve the caller for scoping/diagnostics (best-effort — routes still
  // enforce their own auth).
  let agencyId = ''
  let userId = ''
  try {
    const authHeader = c.req.header('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (token) {
      const payload = await verifySessionToken(token, { checkStaleRole: false })
      if (payload) {
        userId = payload.id
        agencyId = (payload as any).agencyId || ''
      }
    }
  } catch { /* non-fatal */ }

  // 1. Duplicate check
  try {
    const existing = await db.syncMutation.findUnique({ where: { idempotencyKey: key } })
    if (existing?.status === 'completed' && existing.result) {
      const body = existing.result
      c.header('X-Idempotency-Replayed', 'true')
      return c.body(body, 200, { 'Content-Type': 'application/json' })
    }
    if (existing?.status === 'pending') {
      const age = Date.now() - new Date(existing.processedAt).getTime()
      if (age < PENDING_GRACE_MS) {
        return c.json({ success: false, error: 'Duplicate request in progress', idempotencyKey: key }, 409)
      }
      await db.syncMutation.delete({ where: { id: existing.id } }).catch(() => {})
    }
  } catch (err) {
    console.warn('[idempotency] lookup failed:', (err as Error)?.message)
    return next()
  }

  // 2. Run handler inside sync context; 3. store 2xx result
  return runWithSyncContext(
    { idempotencyKey: key, agencyId, origin: 'desktop' },
    async () => {
      await next()

      try {
        const res = c.res
        if (res && res.status >= 200 && res.status < 300) {
          const text = await res.clone().text()
          // Cap stored results (bodies can be large)
          const trimmed = text.length > 64_000 ? text.slice(0, 64_000) : text
          await db.syncMutation.upsert({
            where: { idempotencyKey: key },
            create: {
              idempotencyKey: key,
              agencyId: agencyId || 'unknown',
              model: 'route',
              recordId: null,
              operation: method.toLowerCase(),
              status: 'completed',
              result: trimmed,
              processedAt: new Date(),
            },
            update: { status: 'completed', result: trimmed, processedAt: new Date() },
          }).catch((err: unknown) => {
            console.warn('[idempotency] store failed:', (err as Error)?.message)
          })
        }
      } catch { /* never break the response path */ }
    },
  ).catch(async (err) => {
    // Record the failure so the client may retry the same key later
    try {
      await dbRaw.syncMutation.upsert({
        where: { idempotencyKey: key },
        create: {
          idempotencyKey: key,
          agencyId: agencyId || 'unknown',
          model: 'route',
          recordId: null,
          operation: method.toLowerCase(),
          status: 'failed',
          result: null,
          processedAt: new Date(),
        },
        update: { status: 'failed', processedAt: new Date() },
      })
    } catch { /* ignore */ }
    throw err
  })
}

/** Internal: build a fresh idempotency key (used by tests/tools). */
export function newIdempotencyKey(): string {
  return randomUUID()
}
