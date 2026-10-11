#!/usr/bin/env node
/**
 * BLASTI Desktop LATENCY FAST-PATH — E2E (Task 77)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Task 77 latency work on the REAL local-api + REAL sync engine
 * against a faithful mock of the CLOUD API (same harness as
 * test-realtime-parity.js):
 *
 *   A. LEADING-EDGE PULL: the first sync:changes event of a burst pulls
 *      IMMEDIATELY (no 150ms debounce, no /api/health probe round trip) —
 *      a cloud-side join becomes dashboard-visible in ~1 pull RTT.
 *      ALSO: zero health probes while the cloud socket is live.
 *
 *   B. LEADING-EDGE PUSH: the first local mutation after an idle period
 *      replays IMMEDIATELY (no 150ms debounce, no probe) — a desktop
 *      call-next-class action reaches the cloud in ~1 push RTT, which is
 *      what makes the phone ring fast after the Task 76 cloud fix.
 *      ALSO: zero health probes on the push hot path.
 *
 *   C. NO-DROP CATCH-UP: a sync:changes event that arrives while a slow pull
 *      cycle is still running is remembered (_pendingRealtimePull) and ONE
 *      catch-up pull runs the moment the cycle drains — changes are never
 *      silently dropped by the _isSyncing guard.
 *
 *   D. OFFLINE VERDICT SEMANTICS: cloudReachableFast() is true on a live
 *      socket, flips false the moment the socket drops (no wasted 5s fetch
 *      attempts while offline), and returns to true after the fast
 *      reconnect (0.5s delay, 5s cap).
 *
 * Usage: node tests/test-latency-fastpath.js
 * Env:   MOCK_CLOUD_PORT (default 3097), LOCAL_API_PORT (default 3098 —
 *        NOT 3080/3095/3096 so no running desktop / sibling test collides)
 */

const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

// ─── Minimal test framework (same style as the sibling tests) ────────────────
let _passed = 0, _failed = 0
const _failures = []
function pass(name) { _passed++; console.log(`  PASS ${name}`) }
function fail(name, err) { _failed++; _failures.push({ name, error: err }); console.log(`  FAIL ${name}`); console.log(`       ${err && err.message || err}`) }
function section(name) { console.log(`\n── ${name} ${'─'.repeat(Math.max(1, 62 - name.length))}`) }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { io } = require('socket.io-client')
const { Server: SocketIOServer } = require('socket.io')
const localRealtime = require('../local-realtime')

// ─── Config ──────────────────────────────────────────────────────────────────
const MOCK_CLOUD_PORT = Number(process.env.MOCK_CLOUD_PORT || 3097)
const LOCAL_API_PORT = Number(process.env.LOCAL_API_PORT || 3098)
const AGENCY_ID = 'agency-latency-test'
const USER_ID = 'user-latency-owner'
const CLOUD_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsYXRlbmN5InQ.latency-signature'

// ─── Mock cloud (HTTP + Socket.IO on ONE server — mirrors apps/api) ─────────
const ledger = { seq: 2000, changes: [] }
const counters = { probes: 0, pulls: 0, pushes: 0 }
let pullDelayMs = 0
let pushWaiters = [] // resolvers waiting for the next /api/sync/push

function addChange(model, record, operation) {
  ledger.seq += 1
  ledger.changes.push({ sequence: ledger.seq, model, record, operation })
  return ledger.seq
}

function resetCounters() { counters.probes = 0; counters.pulls = 0; counters.pushes = 0 }

async function startMockCloud() {
  const tcpSockets = new Set()
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url === '/api/health') {
        counters.probes++
        res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'mock-cloud' }))
      } else if (req.url === '/api/auth/refresh-session') {
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, token: CLOUD_TOKEN, user: { id: USER_ID, agencyId: AGENCY_ID, role: 'AGENCY_OWNER', username: 'owner1' } }))
      } else if (req.url === '/api/sync/pull' && req.method === 'POST') {
        counters.pulls++
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch { /* ignore */ }
        const since = Number(parsed.sinceSequence || 0)
        const limit = Number(parsed.limit || 500)
        const respond = () => {
          // eligible computed AT RESPONSE TIME (mirrors the real feed: rows
          // committed while the response was in flight are included)
          const eligible = ledger.changes.filter((c) => c.sequence > since)
          const page = eligible.slice(0, limit)
          const pageLast = page.length ? page[page.length - 1].sequence : since
          const changes = {}
          for (const c of page) {
            changes[c.model] = changes[c.model] || { changed: [], deleted: [] }
            if (c.operation === 'delete') changes[c.model].deleted.push(c.record.id)
            else changes[c.model].changed.push(c.record)
          }
          res.writeHead(200)
          res.end(JSON.stringify({ success: true, changes, pageLastSequence: pageLast, hasMore: page.length < eligible.length }))
        }
        if (pullDelayMs > 0) setTimeout(respond, pullDelayMs)
        else respond()
      } else if (req.url === '/api/sync/push' && req.method === 'POST') {
        counters.pushes++
        const waiters = pushWaiters; pushWaiters = []
        for (const w of waiters) w()
        // status:'applied' per mutation → the outbox drains cleanly
        res.writeHead(200); res.end(JSON.stringify({ success: true, results: [{ status: 'applied' }] }))
      } else {
        res.writeHead(404); res.end(JSON.stringify({ error: 'not-found' }))
      }
    })
  })

  const iosrv = new SocketIOServer(httpServer, { cors: { origin: true, methods: ['GET', 'POST'] } })
  iosrv.on('connection', (socket) => {
    const token = socket.handshake && socket.handshake.auth ? socket.handshake.auth.token : null
    const entry = { user: token ? { id: USER_ID, role: 'AGENCY_OWNER', agencyId: AGENCY_ID } : null }
    socket.on('join:agency', (id) => {
      if (entry.user && id === AGENCY_ID) socket.join('agency:' + id)
    })
    // test-harness trigger: simulate the cloud's own business broadcast
    socket.on('test:customer-join', (payload) => {
      if (payload.user) addChange('User', payload.user, 'create')
      addChange('Reservation', payload.record, 'create')
      iosrv.to('agency:' + AGENCY_ID).emit('queue:joined', {
        type: 'queue:joined', agencyId: AGENCY_ID, userId: payload.record.userId || null,
        data: payload, timestamp: Date.now(),
      })
      iosrv.to('agency:' + AGENCY_ID).emit('sync:changes', { models: payload.user ? ['User', 'Reservation'] : ['Reservation'], changeCount: payload.user ? 2 : 1, sequence: ledger.seq })
    })
  })

  // raw-TCP kill switch — simulates a real network drop (transport close,
  // NO disconnect packet) so socket.io-client's auto-reconnect engages
  httpServer.on('connection', (tcp) => {
    tcpSockets.add(tcp)
    tcp.on('close', () => tcpSockets.delete(tcp))
  })

  await new Promise((resolve) => httpServer.listen(MOCK_CLOUD_PORT, resolve))
  console.log(`[mock-cloud] listening on :${MOCK_CLOUD_PORT}`)
  return { httpServer, iosrv, killAllConnections: () => { for (const t of tcpSockets) t.destroy() } }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function httpJson(port, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
    }, (res) => {
      let out = ''
      res.on('data', (c) => { out += c })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }) }
        catch { resolve({ status: res.statusCode, body: out }) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return Date.now() - start
    await sleep(40)
  }
  throw new Error('timeout waiting for ' + label)
}

async function queueShows(agencyId, recordId, token) {
  const q = await httpJson(LOCAL_API_PORT, 'GET', `/api/agency/queue?agencyId=${agencyId}`, null, token)
  const list = (q.body && (q.body.data || q.body)) || []
  const arr = Array.isArray(list) ? list : (list.entries || [])
  return arr.some((r) => r.id === recordId)
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('BLASTI Desktop LATENCY FAST-PATH — E2E (Task 77)')
  console.log('='.repeat(74))

  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blasti-latency-fastpath-'))
  process.env.BLASTI_LOCAL_DB_DIR = dbDir

  const cloud = await startMockCloud()

  const { startLocalApi, stopLocalApi } = require('../index')
  const started = await startLocalApi(null, LOCAL_API_PORT, {})
  assert(started, 'startLocalApi returned a handle')
  console.log(`[local-api] listening on :${LOCAL_API_PORT}`)

  const importRes = await httpJson(LOCAL_API_PORT, 'POST', '/api/auth/import-session', {
    token: CLOUD_TOKEN,
    user: { id: USER_ID, username: 'owner1', email: 'owner1@test', role: 'AGENCY_OWNER', agencyId: AGENCY_ID, fullName: 'Owner One' },
  })
  assert(importRes.status === 200 && importRes.body.success, 'import-session accepted')
  const localToken = importRes.body.token || importRes.body.session && importRes.body.session.token
  assert(localToken, 'local session token issued')
  pass('Session imported to the local API (token issued)')

  const { localDb: db } = require('../lib/db')
  await db.agencyLocalState.create({ data: { agencyId: AGENCY_ID, initializationStatus: 'READY', snapshotSequence: ledger.seq, recordsImported: 0 } })

  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "User" ("id","username","fullName","role","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
    USER_ID, 'owner1', 'Owner One', 'AGENCY_OWNER', new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "Agency" ("id","name","customCode","category","ownerId","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
    AGENCY_ID, 'Latency Agency', 'LTNC001', 'health', USER_ID, new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "Service" ("id","agencyId","name","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?)',
    'svc-1', AGENCY_ID, 'Consultation', new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "Branch" ("id","agencyId","name","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?)',
    'br-1', AGENCY_ID, 'HQ', new Date().toISOString(), new Date().toISOString(),
  )
  pass('Workspace seeded READY (agency/service/branch/owner — initial-sync mirror)')

  const syncService = require('../sync-service')
  syncService.startSync({
    localDb: db,
    cloudBaseUrl: `http://127.0.0.1:${MOCK_CLOUD_PORT}`,
    agencyId: AGENCY_ID,
    deviceId: 'latency-test-device',
    realtimeEnabled: true,
    syncIntervalMs: 3600_000, // interval silent — event-driven latency only
    probeKeepFresh: false,    // the 30s background probe would pollute probe-count assertions
  })
  syncService.setAuth(CLOUD_TOKEN, { id: USER_ID, role: 'AGENCY_OWNER', agencyId: AGENCY_ID, username: 'owner1' })
  await sleep(1200) // socket connect + startup cycle (its own probe/pull) drains
  assert((await syncService.getStatus()).isStarted, 'engine started')
  pass('Sync engine started (realtime enabled, interval + keep-fresh probe silenced)')

  // UI-like socket client on the LOCAL API (agency-dashboard equivalent)
  const ui = io(`http://127.0.0.1:${LOCAL_API_PORT}`, {
    transports: ['websocket', 'polling'],
    auth: { token: localToken },
    reconnection: false,
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('UI socket connect timeout')), 8000)
    ui.on('connect', () => { clearTimeout(t); resolve() })
    ui.on('connect_error', (e) => { clearTimeout(t); reject(new Error('UI socket connect_error: ' + e.message)) })
  })
  ui.emit('join:agency', AGENCY_ID)
  await sleep(400)
  pass('UI socket joined the local agency room')

  const adminClient = io(`http://127.0.0.1:${MOCK_CLOUD_PORT}`, { transports: ['websocket'], reconnection: false })
  await new Promise((r) => adminClient.on('connect', r))
  adminClient.emit('join:agency', AGENCY_ID)

  // ── A. Leading-edge pull (cloud-side join → dashboard-visible) ────────────
  section('A. Leading-edge pull: cloud join → desktop data, zero probes')
  const NEW_CUSTOMER = {
    id: 'cust-lat-' + crypto.randomUUID().slice(0, 8),
    username: 'latcust_' + crypto.randomUUID().slice(0, 6),
    fullName: 'Latency Customer', email: null, role: 'CUSTOMER', language: 'ar',
    isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const recA = {
    id: 'res-lat-a-' + crypto.randomUUID().slice(0, 8),
    agencyId: AGENCY_ID, userId: NEW_CUSTOMER.id, serviceId: 'svc-1', branchId: 'br-1',
    status: 'WAITING', displayNumber: 'L-001', queueNumber: 1,
    estimatedWaitTime: 10, isWalkIn: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  resetCounters()
  const tA = Date.now()
  adminClient.emit('test:customer-join', { record: recA, user: NEW_CUSTOMER })
  const visibleA = await waitFor(() => queueShows(AGENCY_ID, recA.id, localToken), 8000, 'leading pull to land the joined reservation')
  pass(`Leading-edge pull: row dashboard-visible ${visibleA}ms after the cloud join (old path: ~300ms debounce + probe RTT + pull)`)
  assert(visibleA < 2500, `leading pull latency sane on loopback (got ${visibleA}ms)`)
  assert(counters.probes === 0, `zero /api/health probes on the pull hot path while the socket is live (got ${counters.probes})`)
  pass(`Probe fast path: 0 health probes for the whole pull (socket IS reachability)`)
  assert(counters.pulls >= 1, 'the pull happened')

  // ── B. Leading-edge push (local staff action → cloud) ─────────────────────
  section('B. Leading-edge push: local walk-in → cloud push, zero probes')
  resetCounters()
  const pushSeen = new Promise((resolve) => { pushWaiters.push(resolve) })
  const tB = Date.now()
  const walkIn = await httpJson(LOCAL_API_PORT, 'POST', '/api/agency/queue/walk-in', {
    agencyId: AGENCY_ID, serviceId: 'svc-1', branchId: 'br-1', customerName: 'Latency Walkin',
  }, localToken)
  assert(walkIn.status === 200 || walkIn.status === 201, 'walk-in accepted: ' + walkIn.status + ' ' + JSON.stringify(walkIn.body).substring(0, 160))
  await pushSeen
  const pushMs = Date.now() - tB
  pass(`Leading-edge push: mutation hit the cloud ${pushMs}ms after the local action (old path: 400ms debounce + probe RTT + push)`)
  assert(pushMs < 1500, `leading push latency sane on loopback (got ${pushMs}ms)`)
  assert(counters.probes === 0, `zero /api/health probes on the push hot path (got ${counters.probes})`)
  pass('Probe fast path: 0 health probes for the push')
  // the outbox drained (mock returned status:'applied')
  await waitFor(async () => {
    const rows = await db.$queryRawUnsafe("SELECT COUNT(*) as n FROM \"_pending_mutations\" WHERE status IN ('pending','sending','failed')").catch(() => [{ n: 0 }])
    return Number(rows[0].n) === 0
  }, 5000, 'outbox to drain')
  pass('Outbox drained after the leading-edge replay')

  // ── C. No-drop catch-up during an in-flight slow cycle ────────────────────
  section('C. No-drop: sync:changes during a slow pull cycle → catch-up pull')
  resetCounters()
  const recC1 = Object.assign({}, recA, { id: 'res-lat-c1-' + crypto.randomUUID().slice(0, 8), displayNumber: 'L-002', queueNumber: 2 })
  const recC2 = Object.assign({}, recA, { id: 'res-lat-c2-' + crypto.randomUUID().slice(0, 8), displayNumber: 'L-003', queueNumber: 3 })
  pullDelayMs = 700 // make the FIRST (leading) pull cycle slow
  const tC = Date.now()
  adminClient.emit('test:customer-join', { record: recC1 }) // no user row → user already local
  await sleep(120)                                          // cycle is now in flight (_isSyncing)
  adminClient.emit('test:customer-join', { record: recC2 }) // arrives DURING the cycle → must NOT be dropped
  await waitFor(() => queueShows(AGENCY_ID, recC2.id, localToken), 10000, 'the mid-cycle change to become visible (catch-up pull)')
  const cMs = Date.now() - tC
  pullDelayMs = 0
  pass(`Mid-cycle change visible ${cMs}ms after the second join (slow cycle drained, data applied)`)
  // the catch-up pull fires ~150ms AFTER the cycle drains — wait for it
  await waitFor(() => counters.pulls >= 2, 6000, 'the catch-up pull to fire after the cycle drained')
  assert(counters.pulls >= 2, `catch-up pull ran (expected ≥2 pulls in the window, got ${counters.pulls})`)
  pass(`Catch-up pull confirmed: ${counters.pulls} pulls for 2 events (first + post-drain catch-up)`)
  assert(await queueShows(AGENCY_ID, recC1.id, localToken), 'first change applied too')

  // ── D. Offline verdict semantics (fast-path safety) ───────────────────────
  section('D. cloudReachableFast(): live → false on network drop → true on fast auto-reconnect')
  assert(syncService.cloudReachableFast() === true, 'fast verdict TRUE while the socket is live')
  pass('Live socket → cloudReachableFast() === true (hot paths skip the probe)')
  const pullsBeforeD = counters.pulls
  cloud.killAllConnections() // abrupt TCP destroy = real network blip (transport close)
  await waitFor(() => syncService.cloudReachableFast() === false, 3000, 'fast verdict to flip false after the drop')
  pass('Network dropped → verdict false immediately (no wasted push attempts while offline)')
  await waitFor(() => syncService.cloudReachableFast() === true, 8000, 'fast verdict to return after auto-reconnect')
  pass('Fast auto-reconnect (0.5s delay, 5s cap) → verdict true again')
  await waitFor(() => counters.pulls > pullsBeforeD, 8000, 'the reconnect pull')
  pass('Reconnect triggered a catch-up pull (missed changes recovered)')

  // ── Summary ────────────────────────────────────────────────────────────────
  section('Summary')
  console.log(`  leading-edge PULL latency:  ${visibleA}ms (join → dashboard-visible)`)
  console.log(`  leading-edge PUSH latency:  ${pushMs}ms (local action → cloud hit)`)
  console.log(`  mid-cycle change latency:   ${cMs}ms (incl. a 700ms artificial pull delay)`)
  ui.disconnect(); adminClient.disconnect()
  try { syncService.stopSync() } catch { /* ignore */ }
  try { stopLocalApi() } catch { /* ignore */ }
  cloud.iosrv.close(); cloud.httpServer.close()
  try { fs.rmSync(dbDir, { recursive: true, force: true }) } catch { /* ignore */ }

  console.log(`\n${_passed} passed, ${_failed} failed`)
  if (_failed) { for (const f of _failures) console.log(`  - ${f.name}: ${f.error && f.error.message || f.error}`); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
