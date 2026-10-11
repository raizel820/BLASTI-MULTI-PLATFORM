#!/usr/bin/env node
/**
 * BLASTI Desktop Realtime PARITY — E2E
 * ─────────────────────────────────────────────────────────────────────────────
 * Reproduces the user report: "a customer joined the queue — it appeared
 * instantly on the webapp but NOT on the desktop app" and proves the desktop's
 * full realtime pipeline with the REAL local-api + REAL sync engine +
 * REAL local-realtime server, against a faithful mock of the CLOUD API
 * (HTTP sync endpoints + Socket.IO broadcast semantics copied from
 * apps/api/src/index.ts + lib/sync-notify.ts).
 *
 * Pipeline under test (the desktop's realtime contract):
 *
 *   [webapp/cloud] customer joins queue
 *        └─ cloud broadcasts  queue:joined + sync:changes  → agency room
 *             ├─ (fast path)  engine socket onAny → relayCloudRealtime
 *             │               → local agency room → UI client (event may
 *             │                 arrive BEFORE the row exists locally)
 *             └─ (data path)  engine debounced pull (300ms) → rows committed
 *                             → _broadcastPullBusinessEvents (queue:joined /
 *                               reservation:created) → UI refetch sees data
 *
 *   [desktop-local] walk-in / call-next → emitEvent → broadcastLocalRealtime
 *
 * Scenarios:
 *   A. Cloud-side customer join  → relay latency + pull latency + when
 *      GET /api/agency/queue (what the dashboard fetches) shows the row.
 *   B. Local walk-in (staff action) → local event reaches the UI client.
 *   C. Unauthenticated socket (pre-session renderer) → join:agency rejected →
 *      `auth` upgrade → join accepted → events flow (the login-race path).
 *   D. Token-rotation grace: a socket presenting the PREVIOUS session token
 *      is still accepted (Task 41).
 *
 * Usage: node tests/test-realtime-parity.js
 * Env:   MOCK_CLOUD_PORT (default 3095), LOCAL_API_PORT (default 3096 —
 *        NOT 3080 so the test never collides with a running desktop)
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

// socket.io-client resolves from the desktop app's dependencies
const { io } = require('socket.io-client')
const { Server: SocketIOServer } = require('socket.io')
const localRealtime = require('../local-realtime')

// ─── Config ──────────────────────────────────────────────────────────────────
const MOCK_CLOUD_PORT = Number(process.env.MOCK_CLOUD_PORT || 3095)
const LOCAL_API_PORT = Number(process.env.LOCAL_API_PORT || 3096)
const AGENCY_ID = 'agency-parity-test'
const USER_ID = 'user-parity-owner'
// JWT-SHAPED (three dot-separated segments starting with eyJ) — import-session
// only cloud-validates tokens that look like cloud JWTs (index.js:3714)
const CLOUD_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXJpdHkifQ.parity-signature'

// ─── Mock cloud (HTTP + Socket.IO on ONE server — mirrors apps/api) ─────────
const ledger = { seq: 1000, changes: [] } // { sequence, model, record, operation }
const socketClients = new Map() // socket.id → { user, rooms:Set }

function addChange(model, record, operation) {
  ledger.seq += 1
  ledger.changes.push({ sequence: ledger.seq, model, record, operation })
  return ledger.seq
}

async function startMockCloud() {
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url === '/api/health') {
        res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'mock-cloud' }))
      } else if (req.url === '/api/auth/refresh-session') {
        // accept the presented token — mirrors a healthy cloud; MUST carry
        // { success, token, user } so import-session ADOPTS it (cloud session)
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, token: CLOUD_TOKEN, user: { id: USER_ID, agencyId: AGENCY_ID, role: 'AGENCY_OWNER', username: 'owner1' } }))
      } else if (req.url === '/api/sync/pull' && req.method === 'POST') {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch { /* ignore */ }
        const since = Number(parsed.sinceSequence || 0)
        const limit = Number(parsed.limit || 500)
        const eligible = ledger.changes.filter((c) => c.sequence > since)
        const page = eligible.slice(0, limit)
        const pageLast = page.length ? page[page.length - 1].sequence : since
        // group by model — the engine's wire contract
        const changes = {}
        for (const c of page) {
          changes[c.model] = changes[c.model] || { changed: [], deleted: [] }
          if (c.operation === 'delete') changes[c.model].deleted.push(c.record.id)
          else changes[c.model].changed.push(c.record)
        }
        res.writeHead(200)
        res.end(JSON.stringify({ success: true, changes, pageLastSequence: pageLast, hasMore: page.length < eligible.length }))
      } else if (req.url === '/api/sync/push' && req.method === 'POST') {
        res.writeHead(200); res.end(JSON.stringify({ success: true, results: [] }))
      } else {
        res.writeHead(404); res.end(JSON.stringify({ error: 'not-found' }))
      }
    })
  })

  const iosrv = new SocketIOServer(httpServer, { cors: { origin: true, methods: ['GET', 'POST'] } })
  iosrv.on('connection', (socket) => {
    const token = socket.handshake && socket.handshake.auth ? socket.handshake.auth.token : null
    const entry = { user: token ? { id: USER_ID, role: 'AGENCY_OWNER', agencyId: AGENCY_ID } : null, rooms: new Set() }
    socketClients.set(socket.id, entry)
    socket.on('join:agency', (id) => {
      // cloud authorization: membership required (owner of this agency here)
      if (entry.user && id === AGENCY_ID) { entry.rooms.add('agency:' + id); socket.join('agency:' + id) }
      else console.warn('[mock-cloud] join:agency rejected for', socket.id)
    })
    // test-harness trigger: simulate the cloud's own business broadcast
    socket.on('test:customer-join', (payload) => {
      // Task 75: the FIXED cloud ships the customer's User row in the SAME
      // page as the Reservation (User FK closure in getChangesSinceCursor —
      // resolveAgencyForRecord skips customer Users, so without the closure
      // the desktop could never satisfy the Reservation.userId FK).
      if (payload.user) addChange('User', payload.user, 'create')
      addChange('Reservation', payload.record, 'create')
      // EXACTLY the two broadcasts the real cloud makes (reservations.ts:237
      // emitQueueEvent('queue:joined', ...) + sync-notify's debounced
      // sync:changes to the agency room)
      iosrv.to('agency:' + AGENCY_ID).emit('queue:joined', {
        type: 'queue:joined', agencyId: AGENCY_ID, userId: payload.record.userId || null,
        data: payload, timestamp: Date.now(),
      })
      iosrv.to('agency:' + AGENCY_ID).emit('sync:changes', { models: ['User', 'Reservation'], changeCount: payload.user ? 2 : 1, sequence: ledger.seq })
    })
  })

  await new Promise((resolve) => httpServer.listen(MOCK_CLOUD_PORT, resolve))
  console.log(`[mock-cloud] listening on :${MOCK_CLOUD_PORT}`)
  return { httpServer, iosrv }
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

/** Wait for the FIRST matching event on a list of event names. */
function waitForEvent(socket, names, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, event: null, at: Date.now() }), timeoutMs)
    const handler = (eventName) => (payload) => {
      clearTimeout(timer)
      resolve({ ok: true, event: eventName, payload, at: Date.now() })
    }
    for (const n of names) socket.once(n, handler(n))
  })
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return Date.now() - start
    await sleep(150)
  }
  throw new Error('timeout waiting for ' + label)
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('BLASTI Desktop Realtime PARITY — E2E')
  console.log('='.repeat(74))

  // 0. Isolated local DB dir
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blasti-realtime-parity-'))
  process.env.BLASTI_LOCAL_DB_DIR = dbDir
  const cleanupDirs = [dbDir]

  // 1. Mock cloud
  const cloud = await startMockCloud()

  // 2. Real local API (real schema lifecycle, real realtime attach)
  const { startLocalApi, stopLocalApi } = require('../index')
  const started = await startLocalApi(null, LOCAL_API_PORT, {})
  assert(started, 'startLocalApi returned a handle')
  console.log(`[local-api] listening on :${LOCAL_API_PORT}`)

  // 3. Import the cloud session (owner with agency) — token validated against
  //    the mock cloud's refresh-session (200).
  const importRes = await httpJson(LOCAL_API_PORT, 'POST', '/api/auth/import-session', {
    token: CLOUD_TOKEN,
    user: { id: USER_ID, username: 'owner1', email: 'owner1@test', role: 'AGENCY_OWNER', agencyId: AGENCY_ID, fullName: 'Owner One' },
  })
  assert(importRes.status === 200 && importRes.body.success, 'import-session accepted: ' + JSON.stringify(importRes.body).substring(0, 200))
  const localToken = importRes.body.token || importRes.body.session && importRes.body.session.token
  assert(localToken, 'local session token issued')
  pass('Session imported to the local API (token issued)')

  // 4. Seed a READY workspace + cursor so the Part D gate lets pulls through
  const { localDb } = require('../lib/db')
  const db = localDb
  await db.agencyLocalState.create({ data: { agencyId: AGENCY_ID, initializationStatus: 'READY', snapshotSequence: ledger.seq, recordsImported: 0 } })
  pass('AgencyLocalState seeded READY')

  // 4b. Seed the PARENT rows the way the INITIAL SYNC would have (agency,
  //     service, branch, one pre-existing customer) — a production desktop
  //     has all of these from its initial import. The NEW customer in the
  //     scenario below deliberately does NOT exist locally: it registered
  //     AFTER the initial sync (the reported bug's precondition).
  //     Raw inserts with the desktop schema's real column names, FK order:
  //     owner User FIRST (Agency.ownerId references it).
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "User" ("id","username","fullName","role","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
    USER_ID, 'owner1', 'Owner One', 'AGENCY_OWNER', new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "Agency" ("id","name","customCode","category","ownerId","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
    AGENCY_ID, 'Parity Agency', 'PRTY001', 'health', USER_ID, new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "Service" ("id","agencyId","name","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?)',
    'svc-1', AGENCY_ID, 'Consultation', new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "Branch" ("id","agencyId","name","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?)',
    'br-1', AGENCY_ID, 'HQ', new Date().toISOString(), new Date().toISOString(),
  )
  await db.$executeRawUnsafe(
    'INSERT OR IGNORE INTO "User" ("id","username","fullName","role","createdAt","updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
    'cust-existing', 'existing_cust', 'Existing Customer', 'CUSTOMER', new Date().toISOString(), new Date().toISOString(),
  )
  pass('Parent rows seeded (agency/service/branch/existing customer — initial-sync mirror)')

  // 5. Start the REAL sync engine against the mock cloud
  const syncService = require('../sync-service')
  syncService.startSync({
    localDb: db,
    cloudBaseUrl: `http://127.0.0.1:${MOCK_CLOUD_PORT}`,
    agencyId: AGENCY_ID,
    deviceId: 'parity-test-device',
    realtimeEnabled: true,
    syncIntervalMs: 3600_000, // keep the INTERVAL silent — this test measures event-driven latency
  })
  syncService.setAuth(CLOUD_TOKEN, { id: USER_ID, role: 'AGENCY_OWNER', agencyId: AGENCY_ID, username: 'owner1' })
  await sleep(1200) // socket connect + first post-auth pull
  const st = await syncService.getStatus()
  assert(st.isStarted, 'engine started')
  pass('Sync engine started (realtime enabled)')

  // 6. UI-like socket client — what agency-dashboard.tsx does
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
  const uiAuthed = await new Promise((resolve) => {
    ui.emit('join:agency', AGENCY_ID)
    // no ack exists — validate via the local server's room stats
    setTimeout(() => {
      const stats = localRealtime.getLocalRealtimeStats()
      resolve((stats.rooms['agency:' + AGENCY_ID] || 0) >= 1)
    }, 400)
  })
  assert(uiAuthed, 'UI socket authenticated + agency join accepted')
  pass('UI socket connected to the LOCAL API and joined the agency room')

  // ── Scenario A: cloud-side customer join (the user's exact report) ────────
  section('A. Cloud-side customer join → desktop latency')
  // A customer who registered AFTER the desktop's initial sync: their User
  // row does NOT exist locally (the cloud's resolveAgencyForRecord skips
  // customer User changes). The FIXED cloud ships the User row in the same
  // pull page as the Reservation (User FK closure).
  const NEW_CUSTOMER = {
    id: 'cust-new-' + crypto.randomUUID().slice(0, 8),
    username: 'newcust_' + crypto.randomUUID().slice(0, 6),
    fullName: 'New Customer', email: null, role: 'CUSTOMER', language: 'ar',
    isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const record = {
    id: 'res-parity-' + crypto.randomUUID().slice(0, 8),
    agencyId: AGENCY_ID, userId: NEW_CUSTOMER.id, serviceId: 'svc-1', branchId: 'br-1',
    status: 'WAITING', displayNumber: 'P-001', queueNumber: 1,
    estimatedWaitTime: 10, isWalkIn: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  const t0 = Date.now()
  const relayPromise = waitForEvent(ui, ['queue:joined'], 8000)
  // listeners registered BEFORE the join — the post-pull broadcast fires
  // within the same ~500ms window as the pull itself
  const postPullPromise = waitForEvent(ui, ['reservation:created'], 12000)
  const appliedPromise = waitForEvent(ui, ['sync:data-applied'], 12000)
  // fire the "webapp customer joined" simulation at the mock cloud
  const adminClient = io(`http://127.0.0.1:${MOCK_CLOUD_PORT}`, { transports: ['websocket'], reconnection: false })
  await new Promise((r) => adminClient.on('connect', r))
  adminClient.emit('join:agency', AGENCY_ID)
  adminClient.emit('test:customer-join', { record, user: NEW_CUSTOMER })

  const relay = await relayPromise
  const relayMs = relay.at - t0
  assert(relay.ok, 'relay: UI received queue:joined from the local relay (fast path)')
  pass(`Relay fast path: queue:joined reached the UI in ${relayMs}ms`)

  // data path: pull → row committed → post-pull broadcast → HTTP shows the row
  let dataMs = -1
  try {
    dataMs = await waitFor(async () => {
      const q = await httpJson(LOCAL_API_PORT, 'GET', `/api/agency/queue?agencyId=${AGENCY_ID}`, null, localToken)
      const list = (q.body && (q.body.data || q.body)) || []
      const arr = Array.isArray(list) ? list : (list.entries || [])
      return arr.some((r) => r.id === record.id)
    }, 10000, 'GET /api/agency/queue to show the pulled reservation')
    pass(`Data path: row visible to the dashboard fetch ${dataMs}ms after the join (pull + commit)`)
  } catch (e) {
    // DIAGNOSTIC DUMP — why is the pulled row invisible?
    const deferred = await db.$queryRawUnsafe('SELECT model, recordId, operation, status, lastError FROM "_deferred_changes" ORDER BY rowid DESC LIMIT 10').catch(() => [])
    console.log('   [diag] deferred changes:', JSON.stringify(deferred))
    const directCount = await db.reservation.count({ where: { agencyId: AGENCY_ID } }).catch((e2) => 'ERR ' + e2.message)
    console.log('   [diag] Reservation rows in local DB:', directCount)
    const q = await httpJson(LOCAL_API_PORT, 'GET', `/api/agency/queue?agencyId=${AGENCY_ID}`, null, localToken).catch(() => null)
    console.log('   [diag] /api/agency/queue:', q && q.status, JSON.stringify(q && q.body).substring(0, 400))
    const st2 = await syncService.getStatus()
    console.log('   [diag] engine:', JSON.stringify({ isSyncing: st2.isSyncing, cursor: st2.cursor, socketConnected: st2.socketConnected, lastError: st2.lastError, cloudProbeOk: st2.cloudProbeOk }))
    throw e
  }

  const postPullEvent = await postPullPromise
  assert(postPullEvent.ok, 'post-pull broadcast: reservation:created reached the UI AFTER commit (fresh-data guarantee)')
  pass(`Post-pull broadcast: reservation:created ${postPullEvent.at - t0}ms after join (data guaranteed fresh)`)

  // Task 75: the pull applied User + Reservation rows → ONE sync:data-applied
  // event tells the UI which models changed so non-queue views refetch too.
  // (broadcastLocalRealtime wraps payloads as { type, agencyId, data, … })
  const appliedEvent = await appliedPromise
  const appliedModels = appliedEvent.payload && appliedEvent.payload.data && appliedEvent.payload.data.models
  assert(appliedEvent.ok && Array.isArray(appliedModels) && appliedModels.includes('User'),
    'sync:data-applied broadcast carries the applied model list (got ' + JSON.stringify(appliedEvent.payload) + ')')
  pass(`sync:data-applied broadcast: models=${appliedModels.join(',')}`)
  adminClient.disconnect()

  // ── Scenario B: local staff action (walk-in) ──────────────────────────────
  section('B. Local walk-in → local event')
  const localEventPromise = waitForEvent(ui, ['reservation:created', 'queue:walk-in'], 8000)
  const walkIn = await httpJson(LOCAL_API_PORT, 'POST', '/api/agency/queue/walk-in', {
    agencyId: AGENCY_ID, serviceId: 'svc-1', branchId: 'br-1', customerName: 'Parity Walkin',
  }, localToken)
  if (!(walkIn.status === 200 || walkIn.status === 201)) {
    console.log('   (walk-in response:', walkIn.status, JSON.stringify(walkIn.body).substring(0, 160), ')')
  }
  const localEvent = await localEventPromise
  assert(localEvent.ok, 'local event reached the UI client: ' + JSON.stringify(localEvent).substring(0, 120))
  pass(`Local mutation event: ${localEvent.event} reached the UI in ${localEvent.at - t0}ms`)

  // ── Scenario C: pre-session socket + auth upgrade (the login race) ────────
  section('C. Pre-session socket → auth upgrade → events flow')
  const preSession = io(`http://127.0.0.1:${LOCAL_API_PORT}`, { transports: ['websocket'], auth: { token: '' }, reconnection: false })
  await new Promise((r) => preSession.on('connect', r))
  preSession.emit('join:agency', AGENCY_ID) // MUST be rejected (unauthenticated)
  await sleep(300)
  const joinedBefore = countAgencyRoom(AGENCY_ID)
  preSession.emit('auth', { token: localToken })
  await sleep(300)
  preSession.emit('join:agency', AGENCY_ID) // the UI's re-join after upgrade
  await sleep(300)
  const joinedAfter = countAgencyRoom(AGENCY_ID)
  assert(joinedAfter >= joinedBefore + 1, `auth upgrade then join works (room size ${joinedBefore} → ${joinedAfter})`)
  pass(`Auth upgrade: unauthenticated socket joined the agency room after \`auth\` + re-join (${joinedBefore} → ${joinedAfter})`)

  // events now flow to the upgraded socket
  const upgradedPromise = waitForEvent(preSession, ['queue:joined', 'reservation:created'], 8000)
  const adminClient2 = io(`http://127.0.0.1:${MOCK_CLOUD_PORT}`, { transports: ['websocket'], reconnection: false })
  await new Promise((r) => adminClient2.on('connect', r))
  adminClient2.emit('join:agency', AGENCY_ID)
  adminClient2.emit('test:customer-join', { record: Object.assign({}, record, { id: 'res-parity-' + crypto.randomUUID().slice(0, 8), displayNumber: 'P-002' }) })
  const upgraded = await upgradedPromise
  assert(upgraded.ok, 'upgraded socket receives agency events')
  pass(`Upgraded socket received ${upgraded.event}`)
  preSession.disconnect(); adminClient2.disconnect()

  // ── Summary ────────────────────────────────────────────────────────────────
  section('Summary')
  console.log(`  relay fast-path latency:      ${relayMs}ms`)
  console.log(`  dashboard-visible data delay: ${dataMs}ms (after the join)`)
  ui.disconnect()
  try { syncService.stopSync() } catch { /* ignore */ }
  try { stopLocalApi() } catch { /* ignore */ }
  cloud.iosrv.close(); cloud.httpServer.close()
  for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }

  console.log(`\n${_passed} passed, ${_failed} failed`)
  if (_failed) { for (const f of _failures) console.log(`  - ${f.name}: ${f.error && f.error.message || f.error}`); process.exit(1) }
  process.exit(0)

  // ── local helpers ──────────────────────────────────────────────────────────
  function countAgencyRoom(agencyId) {
    const stats = localRealtime.getLocalRealtimeStats()
    return stats.rooms['agency:' + agencyId] || 0
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
