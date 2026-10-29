/**
 * BLASTI Online Operational Mode (Task UQ — Unified Queue Management Among
 * Branch Staff + Enhanced Online Operational Mode)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *   Every desktop workstation used to run its own local-first SQLite queue:
 *   two receptionists saw two independent queues, both could "call" the same
 *   ticket, and changes reached each other only via the ≤15s sync pull.
 *
 *   When the branch is ONLINE, the centralized PostgreSQL database is now the
 *   DEFINITIVE source of truth for critical operations: this module routes
 *   ticket-calling, status updates, and walk-in creation through the CENTRAL
 *   API, which claims tickets with database-level compare-and-swap statements
 *   (two workstations can never win the same ticket) and broadcasts realtime
 *   events to every staff workstation via the cloud socket relay.
 *
 * CONTRACT
 *   - `executeOnline()` is called at the TOP of each queue-mutating local
 *     route. It returns null when the branch is offline → the caller runs the
 *     EXISTING local-first path unchanged (offline behavior is preserved).
 *   - When online, the mutation is executed on the cloud with:
 *       · the CURRENT cloud session token (Bearer)
 *       · an `X-Idempotency-Key` header — exactly-once business effect. The
 *         key may be supplied by the client (header/body); otherwise one is
 *         generated per incoming request. The SAME key is reused for the
 *         in-proxy retry, so a request retransmission (response lost after
 *         the cloud applied it) replays the STORED cloud response instead of
 *         executing twice (cloud-side SyncMutation ledger).
 *   - On cloud 2xx: the result is MIRRORED into the local SQLite (best
 *     effort) so this workstation's UI is instantly consistent. No local
 *     realtime emit for mirrored call-next/walk-in — the cloud relay
 *     (relayCloudRealtime) delivers the authoritative event to ALL
 *     workstations uniformly (echo suppression). If the cloud socket is
 *     down, a local emit is fired so THIS workstation still updates live.
 *   - On cloud 4xx: the response is returned VERBATIM — the cloud is the
 *     authority while online (paused queue, permissions, concurrent-update
 *     conflicts…). 409 CONCURRENT_UPDATE is retried ONCE automatically
 *     (automatic conflict retry) before surfacing.
 *   - On confirmed cloud unreachability: returns null → local-first path +
 *     outbox (offline resilience is unchanged).
 *   - On an AMBIGUOUS outcome (timeout while the cloud is still reachable):
 *     NEVER run locally — return 503 and let the staff retry; the ledger
 *     makes the retry safe.
 */

'use strict'

const crypto = require('crypto')

const VERDICT_TTL_MS = 5000          // how long a cached online verdict may be reused
const PROBE_TIMEOUT_MS = 2500        // /api/health probe budget
const PROXY_TIMEOUT_MS = 9000        // cloud mutation budget
const IDEMPOTENCY_RETRY_DELAY_MS = 400

let _getDb = null                    // () => local Prisma client | null
let _cachedVerdict = null            // { online, reason, checkedAt }

function configure(opts) {
  if (opts && typeof opts.getDb === 'function') _getDb = opts.getDb
}

function getSyncService() {
  try { return require('./sync-service') } catch { return null }
}

function log() {
  try { console.log('[OnlineMode]', ...arguments) } catch { /* noop */ }
}

async function probeCloudHealth(base) {
  try {
    const res = await fetch(base + '/api/health', {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Online verdict — cached for VERDICT_TTL_MS.
 *   online ⇔ a cloud session token exists AND the workspace is not REVOKED
 *            AND the cloud answers /api/health (or the sync socket is live).
 */
async function getOnlineModeState(forceProbe) {
  const sync = getSyncService()
  const snap = sync && typeof sync.getAuthSnapshot === 'function' ? sync.getAuthSnapshot() : null

  const now = Date.now()
  if (!forceProbe && _cachedVerdict && (now - _cachedVerdict.checkedAt) < VERDICT_TTL_MS) {
    return _cachedVerdict
  }

  let state
  if (!snap || !snap.token) {
    state = { online: false, reason: 'NO_CLOUD_SESSION' }
  } else if (snap.authorization === 'REVOKED') {
    state = { online: false, reason: 'WORKSPACE_REVOKED' }
  } else {
    const base = snap.cloudBaseUrl || (process.env.BLASTI_CLOUD_URL || 'http://localhost:3003')
    if (snap.fastOnline === true) {
      state = { online: true, reason: 'SYNC_SOCKET_LIVE', token: snap.token, cloudBaseUrl: base }
    } else if (snap.fastOnline === false) {
      state = { online: false, reason: 'CLOUD_PROBE_FAILED' }
    } else {
      const up = await probeCloudHealth(base)
      state = up
        ? { online: true, reason: 'HEALTH_PROBE_OK', token: snap.token, cloudBaseUrl: base }
        : { online: false, reason: 'CLOUD_PROBE_FAILED' }
    }
  }

  _cachedVerdict = { ...state, checkedAt: now }
  return state
}

function invalidateVerdict() {
  _cachedVerdict = null
}

/**
 * Diagnostics/UX surface — NEVER probes, NEVER blocks. Returns the last
 * cached verdict (or 'UNKNOWN' when cold) so /api/db-status stays fast.
 */
function getStatusFast() {
  const sync = getSyncService()
  const snap = sync && typeof sync.getAuthSnapshot === 'function' ? sync.getAuthSnapshot() : null
  const cached = _cachedVerdict
  return {
    mode: cached ? (cached.online ? 'ONLINE' : 'OFFLINE') : 'UNKNOWN',
    reason: cached ? cached.reason || null : 'COLD',
    checkedAt: cached ? cached.checkedAt : null,
    hasCloudSession: !!(snap && snap.token),
    authorization: snap ? snap.authorization : 'UNKNOWN',
    syncSocketConnected: !!(snap && snap.fastOnline === true),
    contract: 'online = central PostgreSQL is the source of truth (unified queue); offline = local-first + outbox',
  }
}

function extractClientKey(c, body) {
  try {
    const headerKey = c.req.header('x-idempotency-key')
    if (headerKey && headerKey.length >= 8) return headerKey
    if (body && typeof body === 'object' && typeof body.idempotencyKey === 'string' && body.idempotencyKey.length >= 8) {
      return body.idempotencyKey
    }
  } catch { /* noop */ }
  return null
}

/**
 * Execute a queue mutation on the CENTRAL API.
 *
 * @param {object} opts
 *   c          — Hono context of the incoming local request (for the client key)
 *   routeTag   — diagnostics label ('call-next' | 'queue-action' | 'walk-in')
 *   method     — HTTP verb for the cloud call
 *   cloudPath  — absolute cloud path, e.g. '/api/agency/queue/call-next'
 *   body       — JSON body for the cloud call (already excludes local-only fields)
 *   mirror     — (responseData) => Promise<void>  local best-effort mirror on 2xx
 *   retryOnConflict — re-send once automatically when the cloud answers 409 CONCURRENT_UPDATE
 *
 * @returns null when the branch is offline / cloud confirmed unreachable
 *          (caller MUST run its local path), otherwise { status, body } to
 *          return to the UI verbatim.
 */
async function executeOnline(opts) {
  const { c, routeTag, method, cloudPath, body, mirror, retryOnConflict } = opts || {}
  if (!c || !cloudPath) return null

  const state = await getOnlineModeState()
  if (!state.online) return null

  const idemKey = extractClientKey(c, body) || ('uq-' + routeTag + '-' + crypto.randomUUID())

  let attempt = await callCloudOnce(state, method, cloudPath, body, idemKey)

  // ── Automatic conflict retry (Task UQ): another workstation advanced the
  // same ticket mid-flight. Re-send ONCE with a FRESH key — the cloud's CAS
  // layer then either applies against the new state or reports a real error.
  if (
    retryOnConflict &&
    attempt.kind === 'business' &&
    attempt.status === 409 &&
    attempt.data && attempt.data.errorKey === 'CONCURRENT_UPDATE'
  ) {
    log(routeTag, '409 CONCURRENT_UPDATE — automatic retry with fresh key')
    await new Promise((r) => setTimeout(r, IDEMPOTENCY_RETRY_DELAY_MS))
    attempt = await callCloudOnce(state, method, cloudPath, body, 'uq-' + routeTag + '-' + crypto.randomUUID())
  }

  // ── Ambiguous outcome (response lost while cloud reachable): retry the
  // SAME idempotency key once — the cloud replays the stored response when
  // the first attempt landed (exactly-once despite retransmission).
  if (attempt.kind === 'ambiguous') {
    log(routeTag, 'ambiguous cloud outcome — idempotent retry with the SAME key')
    await new Promise((r) => setTimeout(r, IDEMPOTENCY_RETRY_DELAY_MS))
    attempt = await callCloudOnce(state, method, cloudPath, body, idemKey)
    if (attempt.kind === 'ambiguous') {
      const stillUp = await probeCloudHealth(state.cloudBaseUrl)
      if (stillUp) {
        // Cloud alive but unreachable-for-us mid-flight: DO NOT run locally
        // (the first attempt may have applied) — surface a retryable error.
        log(routeTag, 'cloud alive, mutation outcome unknown → 503 (no local fallback)')
        invalidateVerdict()
        return {
          status: 503,
          body: {
            success: false,
            error: 'The central server is not responding reliably — nothing was changed locally. Please retry.',
            errorKey: 'CENTRAL_UNREACHABLE_RETRY',
          },
        }
      }
      // Confirmed down → fall back to the local-first path.
      log(routeTag, 'cloud went down mid-flight → local fallback')
      invalidateVerdict()
      return null
    }
  }

  // ── Confirmed unreachable at first call → local-first path.
  if (attempt.kind === 'unreachable') {
    log(routeTag, 'cloud unreachable → local fallback')
    invalidateVerdict()
    return null
  }

  if (attempt.kind === 'ok') {
    if (typeof mirror === 'function') {
      try { await mirror(attempt.data) } catch (err) {
        log(routeTag, 'mirror failed (pull will reconcile):', err && err.message)
      }
    }
    // Echo suppression: the cloud socket relay delivers the authoritative
    // event to every workstation (including this one). Only when the relay
    // is DOWN do we emit a local event so THIS UI still updates live.
    if (routeTag === 'call-next' && typeof opts.emitLocalFallback === 'function') {
      const sync = getSyncService()
      let socketUp = false
      try { socketUp = !!(sync && sync.getStatus && sync.getStatus().socketConnected) } catch { /* noop */ }
      if (!socketUp) {
        try { await opts.emitLocalFallback(attempt.data) } catch { /* noop */ }
      }
    }
  }

  return { status: attempt.status, body: attempt.data }
}

async function callCloudOnce(state, method, cloudPath, body, idemKey) {
  try {
    const res = await fetch(state.cloudBaseUrl + cloudPath, {
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + state.token,
        'X-Idempotency-Key': idemKey,
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    })
    let data = null
    try { data = await res.json() } catch { /* non-JSON body */ }
    if (res.status >= 200 && res.status < 300) {
      return { kind: 'ok', status: res.status, data }
    }
    return { kind: 'business', status: res.status, data }
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
    if (isTimeout) return { kind: 'ambiguous', error: err && err.message }
    return { kind: 'unreachable', error: err && err.message }
  }
}

// ─── Local mirrors (best effort — the ≤15s pull is the safety net) ──────────

function db() {
  return typeof _getDb === 'function' ? _getDb() : null
}

/** Mirror a cloud call-next result into the local SQLite. */
async function mirrorCallNext(data, agencyId) {
  const d = db()
  if (!d || !data || !data.reservation || !data.reservation.id) return
  const r = data.reservation
  const now = new Date()

  if (Array.isArray(data.autoCompleted)) {
    for (const done of data.autoCompleted) {
      if (!done || !done.id) continue
      await d.reservation.updateMany({
        where: { id: done.id, status: { in: ['CALLED', 'SERVING', 'WAITING'] } },
        data: { status: 'COMPLETED', completedAt: now },
      }).catch(() => {})
    }
  }

  const localRow = await d.reservation.findUnique({ where: { id: r.id }, select: { id: true, queueNumber: true } }).catch(() => null)
  await d.reservation.updateMany({
    where: { id: r.id, status: { in: ['WAITING', 'CALLED', 'SERVING'] } },
    data: {
      status: 'CALLED',
      calledAt: now,
      claimedAt: now,
      counterId: r.counterId || null,
      calledBy: r.calledBy || null,
    },
  }).catch(() => {})

  if (r.counterId) {
    await d.counter.updateMany({
      where: { id: r.counterId, OR: [{ currentReservationId: null }, { currentReservationId: r.id }] },
      data: { currentReservationId: r.id },
    }).catch(() => {})
  }

  if (localRow && localRow.queueNumber != null) {
    const qs = await d.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
    if (qs) {
      await d.queueSettings.update({ where: { id: qs.id }, data: { currentServingNumber: localRow.queueNumber } }).catch(() => {})
    }
  }
}

/** Mirror a cloud PATCH (complete/no_show/cancel) into the local SQLite. */
async function mirrorQueueAction(reservationId, action) {
  const d = db()
  if (!d || !reservationId) return
  const now = new Date()
  const map = { complete: 'COMPLETED', no_show: 'NO_SHOW', cancel: 'CANCELLED' }
  const status = map[action]
  if (!status) return
  const data = { status }
  if (action === 'complete') data.completedAt = now
  if (action === 'cancel') data.cancelledAt = now

  const row = await d.reservation.findUnique({ where: { id: reservationId }, select: { counterId: true, status: true } }).catch(() => null)
  await d.reservation.updateMany({
    where: { id: reservationId, status: row ? row.status : undefined },
    data,
  }).catch(() => {})
  if (row && row.counterId) {
    await d.counter.updateMany({
      where: { id: row.counterId, currentReservationId: reservationId },
      data: { currentReservationId: null },
    }).catch(() => {})
  }
}

/** Mirror a cloud walk-in creation into the local SQLite. */
async function mirrorWalkIn(data, agencyId) {
  const d = db()
  if (!d || !data || !data.reservation || !data.reservation.id) return
  const r = data.reservation
  try {
    const existing = await d.reservation.findUnique({ where: { id: r.id }, select: { id: true } })
    if (existing) {
      await d.reservation.update({
        where: { id: r.id },
        data: {
          queueNumber: r.queueNumber != null ? r.queueNumber : undefined,
          displayNumber: r.displayNumber || undefined,
          estimatedWait: r.estimatedWait != null ? r.estimatedWait : undefined,
        },
      })
    } else {
      await d.reservation.create({
        data: {
          id: r.id,
          agencyId: r.agencyId || agencyId,
          serviceId: r.serviceId,
          userId: r.userId || null,
          queueNumber: r.queueNumber != null ? r.queueNumber : 0,
          displayNumber: r.displayNumber || '',
          status: r.status || 'WAITING',
          walkInCustomerName: r.walkInCustomerName || null,
          isWalkIn: true,
          joinedAt: r.joinedAt ? new Date(r.joinedAt) : new Date(),
          estimatedWait: r.estimatedWait != null ? r.estimatedWait : 0,
          importToken: r.importToken || null,
          offlineCreatedAt: new Date(),
          syncDeviceId: 'cloud-mirror',
        },
      })
    }
    // Keep the issued-number cursor in lockstep with the cloud's atomic cursor.
    if (r.queueNumber != null) {
      const qs = await d.queueSettings.findFirst({ where: { agencyId } })
      if (qs && (qs.lastIssuedNumber || 0) < r.queueNumber) {
        await d.queueSettings.update({ where: { id: qs.id }, data: { lastIssuedNumber: r.queueNumber } })
      }
    }
  } catch (err) {
    log('walk-in mirror failed (pull will reconcile):', err && err.message)
  }
}

module.exports = {
  configure,
  getOnlineModeState,
  invalidateVerdict,
  getStatusFast,
  executeOnline,
  mirrorCallNext,
  mirrorQueueAction,
  mirrorWalkIn,
}
