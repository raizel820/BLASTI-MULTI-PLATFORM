/**
 * lan-authority.js — Offline LAN authority (election, master registry, join).
 * ─────────────────────────────────────────────────────────────────────────────
 * R-21F / 0.6.23. Implements the offline single-source-of-truth design
 * (docs/offline-lan-authority-design.md) with the user's confirmed answers:
 *
 *   1. Every branch runs at least one desktop → the desktop-anchored local API
 *      is the authority; election is the failover safety net.
 *   2. Devices only follow the desktop of the branch their OPENED ACCOUNT
 *      belongs to → the join scope is the workspace agencyId (staff may be
 *      branch-bound; the owner spans all branches of the agency).
 *   3. Per-device tokens → the master mints an HMAC device token at join time
 *      (requireAuth accepts it alongside the shared session token).
 *   4. Auto-join, no approval step — the CLIENT validates LAN reachability and
 *      account↔branch scope; this module validates the token + scope again.
 *   5. Master selection weighs BOTH raw specs AND OS modernity (specScore).
 *   6. The master is the only write target while it lives; followers keep a
 *      local read copy (WatermelonDB + IndexedDB outbox) so when the master
 *      dies, re-election (term+1) hands the truth to the next-best desktop and
 *      followers replay their deltas through its /api/sync/push.
 *
 * Design constraints:
 *   - Pure Node (runs inside the Electron main process, no Electron APIs).
 *   - The UDP broadcast stays owned by main.js (startLanBeacon) — this module
 *     only LISTENS on :3081 (SO_REUSEADDR lets both bind) to learn about peer
 *     desktops, then probes their HTTP /api/discover for authoritative state.
 *   - main.js enriches its beacon payload via publicBeaconExtras().
 *   - Every state transition is written to the rolling diag log with a
 *     LAN-AUTH prefix — the user explicitly requires detailed offline-system
 *     logs that reach the cloud log vault (console → main-process ring buffer
 *     → remote-logger merge → POST /api/logs).
 *   - NEVER throws out of module scope; every timer guarded; shutdown() clears
 *     everything (called from stopLocalApi).
 */

'use strict'

const dgram = require('dgram')
const os = require('os')
const { createHmac, randomBytes, timingSafeEqual } = require('crypto')

// ─── Tunables ────────────────────────────────────────────────────────────────

const BEACON_PORT = 3081            // same channel main.js broadcasts on
const BEACON_INTERVAL_MS = 3_000    // self-broadcast cadence (peers + election)
const PEER_TTL_MS = 12_000          // beacon silence ⇒ peer presumed dead
const ELECTION_TICK_MS = 3_000      // role evaluation cadence
const PROBE_TICK_MS = 6_000         // HTTP /api/discover refresh of peers
const CLAIM_WINDOWS = 2             // consecutive quiet windows before claiming
const PROBE_TIMEOUT_MS = 2_000
const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days, renewable
const MAX_DEVICES = 50
const MAX_PEERS = 20

// ─── Module state ────────────────────────────────────────────────────────────

const state = {
  inited: false,
  lanEnabled: false,
  instanceId: null,          // stable per-installation device id (index.js)
  identity: {},              // { name, hostname, httpPort }
  role: 'CANDIDATE',         // CANDIDATE | MASTER | FOLLOWER
  term: 0,                   // monotonic election term (persisted)
  claimedAt: null,
  master: null,              // { instanceId, name, ip, port, term, specScore, lastSeenAt }
  peers: new Map(),          // instanceId → peer record
  quietWindows: 0,
  // injected adapters (from index.js startLocalApi)
  metaGet: null,
  metaSet: null,
  getSession: null,          // () => ({ token, previousToken, user } | null)
  getDb: null,               // () => local PrismaClient | null — User-mirror checks
  diag: null,                // diagLog adapter
  broadcast: null,           // (event, payload) => void — local realtime
  secret: null,              // HMAC secret for device tokens (persisted)
  devices: [],               // joined-device registry (persisted)
  // r21-9 — the OWNER's manual master pick (instanceId). Cloud-pinned via the
  // lan-status reporter, or set locally through POST /api/lan/preferred-master.
  // Persisted in _sync_meta so it survives restarts AND offline periods.
  preferredMasterInstanceId: null,
}

let listenSocket = null
let electionTimer = null
let probeTimer = null
let beaconTimer = null
let probeBusy = false
let electionBusy = false

// ─── Small helpers ───────────────────────────────────────────────────────────

function log(msg) {
  const line = '[LAN-AUTH] ' + msg
  // Console reaches the main-process ring buffer → remote-logger → cloud vault.
  try { console.log(line) } catch { /* ignore */ }
  try { state.diag && state.diag('LAN-AUTH ' + msg) } catch { /* ignore */ }
}

function nowIso() { return new Date().toISOString() }

/** Cloud API base for join-time validation (BLASTI_CLOUD_URL / default). */
function cloudHealthUrl() {
  const base = String(process.env.BLASTI_CLOUD_URL || process.env.BLASTI_API_URL || 'http://localhost:3003').replace(/\/+$/, '')
  return base + '/api'
}

/**
 * specScore — higher = more worthy master. Weighs raw specs AND OS modernity
 * (user's answer 5: "both better specs and modern OS go into account").
 *   cpu:      cores × per-core MHz/1000 (capped 3.0 GHz per core)
 *   memory:   total GB × 2
 *   os:       0-6 pts by platform+release recency:
 *               win32  release 10.0.22000+ (Win11) = 6 · 10.0.x (Win10) = 3
 *               darwin Darwin 21+ (Monterey…) = 4 + min(major-21, 2)
 *               linux  kernel 6.x = 5 · 5.x = 3 · older = 1
 * Deterministic tie-break (design §3.3): specScore → uptime → instanceId.
 */
function computeSpecScore() {
  let score = 0
  try {
    const cpus = os.cpus() || []
    const perCoreMhz = cpus.length ? Math.min(cpus[0].speed || 0, 3000) : 0
    score += cpus.length * (perCoreMhz / 1000)
    score += (os.totalmem() / (1024 * 1024 * 1024)) * 2
  } catch { /* keep partial */ }
  try {
    const release = String(os.release() || '')
    if (process.platform === 'win32') {
      const build = parseInt(release.split('.')[2] || '0', 10)
      score += build >= 22000 ? 6 : 3
    } else if (process.platform === 'darwin') {
      const major = parseInt(release.split('.')[0] || '0', 10)
      score += major >= 21 ? 4 + Math.min(major - 21, 2) : 2
    } else {
      const major = parseInt(release.split('.')[0] || '0', 10)
      score += major >= 6 ? 5 : major >= 5 ? 3 : 1
    }
  } catch { /* keep partial */ }
  return Math.round(score * 10) / 10
}

/** Strictly better master candidate ordering (design §3.3). */
function betterThan(a, b) {
  if (!a) return false
  if (!b) return true
  if ((a.specScore || 0) !== (b.specScore || 0)) return (a.specScore || 0) > (b.specScore || 0)
  if ((a.uptime || 0) !== (b.uptime || 0)) return (a.uptime || 0) > (b.uptime || 0)
  return String(a.instanceId || '') < String(b.instanceId || '')
}

function workspaceScope() {
  try {
    const s = state.getSession && state.getSession()
    if (!s || !s.user) return { agencyId: null, branchId: null, userRole: null, userId: null, username: null }
    return {
      agencyId: s.user.agencyId || null,
      branchId: s.user.branchId || null,
      userRole: s.user.role || null,
      userId: s.user.id || null,
      username: s.user.username || null,
    }
  } catch { return { agencyId: null, branchId: null, userRole: null, userId: null, username: null } }
}

function peerAlive(peer) {
  return peer && (Date.now() - peer.lastSeenAt) < PEER_TTL_MS
}

function activeMasterPeer() {
  for (const peer of state.peers.values()) {
    if (peerAlive(peer) && peer.role === 'MASTER') {
      const scope = workspaceScope()
      // Scope rule (user answer 2): only desktops of the SAME workspace count.
      if (!scope.agencyId || !peer.agencyId || peer.agencyId === scope.agencyId) return peer
    }
  }
  return null
}

// ─── r21-9 — Manual master selection (owner's pin) ──────────────────────────

/** The live peer record of the owner-pinned master, or null when absent/dead. */
function preferredPeerAlive() {
  if (!state.preferredMasterInstanceId) return null
  for (const peer of state.peers.values()) {
    if (peer.instanceId === state.preferredMasterInstanceId && peerAlive(peer)) return peer
  }
  return null
}

/** TRUE when the given instanceId is the owner's pinned master. */
function isPreferredMaster(instanceId) {
  return !!state.preferredMasterInstanceId && !!instanceId && state.preferredMasterInstanceId === instanceId
}

/**
 * Apply the owner's manual master pick. `instanceId` = the pinned desktop's
 * durable id, or null to return to automatic election. Called by the local
 * POST /api/lan/preferred-master route and by the cloud reporter when the
 * owner pins from the web Device Manager. Persists + re-evaluates at once.
 */
async function setPreferredMaster(instanceId) {
  const next = typeof instanceId === 'string' && instanceId.trim() ? instanceId.trim().slice(0, 80) : null
  const prev = state.preferredMasterInstanceId
  if (prev === next) return state.preferredMasterInstanceId
  state.preferredMasterInstanceId = next
  await persistElection().catch(() => {})
  log(`PREFERRED MASTER ${prev ? prev.slice(0, 12) + '…' : '∅'} → ${next ? next.slice(0, 12) + '…' : '∅ (automatic)'} — re-evaluating role now`)
  // Re-run the election immediately so the pin takes effect within one tick.
  evaluateRole().catch(() => {})
  return state.preferredMasterInstanceId
}

function getPreferredMasterInstanceId() {
  return state.preferredMasterInstanceId
}

// ─── Persistence (meta adapters) ─────────────────────────────────────────────

async function persistElection() {
  try {
    if (state.metaSet) {
      await state.metaSet('lan_authority_term', String(state.term))
      await state.metaSet('lan_authority_role', state.role)
      await state.metaSet('lan_authority_preferred_master', state.preferredMasterInstanceId || '')
    }
  } catch { /* non-fatal */ }
}

async function persistDevices() {
  try {
    if (state.metaSet) await state.metaSet('lan_authority_devices', JSON.stringify(state.devices.slice(-MAX_DEVICES)))
  } catch { /* non-fatal */ }
}

// ─── Device tokens (user answer 3: per-device tokens) ────────────────────────

function deviceHmac(payload) {
  return createHmac('sha256', state.secret || 'blasti-lan-dev').update(payload).digest('hex')
}

function mintDeviceToken(deviceId) {
  const exp = Date.now() + DEVICE_TOKEN_TTL_MS
  const payload = deviceId + '.' + exp
  return 'blan-' + payload + '.' + deviceHmac(payload)
}

/** Verify a presented LAN device token → its device record, or null. */
function verifyDeviceToken(token) {
  try {
    if (!token || typeof token !== 'string' || !token.startsWith('blan-')) return null
    const parts = token.slice(5).split('.')
    if (parts.length !== 3) return null
    const [deviceId, expStr, mac] = parts
    const expected = deviceHmac(deviceId + '.' + expStr)
    const a = Buffer.from(mac, 'utf-8')
    const b = Buffer.from(expected, 'utf-8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    if (parseInt(expStr, 10) < Date.now()) return null
    const rec = state.devices.find((d) => d.deviceId === deviceId)
    if (!rec) return null
    rec.lastSeenAt = nowIso()
    return rec
  } catch { return null }
}

// ─── Join (user answers 2/4: scope-validated auto-join) ──────────────────────

/**
 * Validate a presented CLOUD JWT against the local mirror when the cloud is
 * unreachable. The desktop never holds the cloud signing secret, so offline
 * validation is necessarily structural + identity-based (LAN-trust model,
 * consistent with the open RFC1918 CORS the local API already runs):
 *   - three-segment HS256 JWT, not expired;
 *   - payload user exists in the local User mirror AND belongs to the
 *     workspace agency (owner/spans-all or staff of the same agency).
 * Every acceptance is logged with the decision basis — the user requires
 * detailed offline-system logs in the cloud vault.
 */
async function validateForeignCloudTokenOffline(presentedToken, scope) {
  try {
    const t = String(presentedToken || '')
    const segs = t.split('.')
    if (segs.length !== 3 || !t.startsWith('eyJ')) return { ok: false, reason: 'not-a-jwt' }
    const payload = JSON.parse(Buffer.from(segs[1], 'base64url').toString('utf-8'))
    if (!payload || !payload.id) return { ok: false, reason: 'no-subject' }
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return { ok: false, reason: 'expired' }
    if (scope.agencyId && String(payload.agencyId || '') !== String(scope.agencyId)) {
      return { ok: false, reason: 'payload-agency-mismatch' }
    }
    const db = state.getDb && state.getDb()
    if (!db) return { ok: false, reason: 'db-unavailable' }
    const rows = await db.$queryRawUnsafe(
      'SELECT id, username, role, agencyId FROM "User" WHERE id = ? LIMIT 1', payload.id
    ).catch(() => [])
    const user = rows && rows[0]
    if (!user) return { ok: false, reason: 'user-not-in-mirror' }
    // Agency scope: the user row itself carries the agency (owner profile) —
    // staff users resolve via AgencyStaff; both must land on this workspace.
    if (scope.agencyId && String(user.agencyId || '') !== String(scope.agencyId)) {
      const staff = await db.$queryRawUnsafe(
        'SELECT 1 AS ok FROM "AgencyStaff" WHERE "userId" = ? AND "agencyId" = ? AND "isActive" = 1 LIMIT 1',
        payload.id, scope.agencyId
      ).catch(() => [])
      if (!staff || !staff.length) return { ok: false, reason: 'not-a-workspace-member' }
    }
    return { ok: true, user: { id: user.id, username: user.username, role: user.role, agencyId: user.agencyId || scope.agencyId } }
  } catch (err) {
    return { ok: false, reason: 'error:' + ((err && err.message) || 'unknown') }
  }
}

/**
 * Handle POST /api/lan/join. Returns { status, body } for the route to send.
 * The caller presents its OWN CLOUD token (per-login JWTs differ per device).
 * Validation chain, every step logged:
 *   1. same workspace session (current token or rotation-grace predecessor);
 *   2. cloud REACHABLE → POST /api/auth/refresh-session must accept it;
 *   3. cloud OFFLINE → structural JWT + local User-mirror identity check.
 */
async function joinHandler(body, bearerToken) {
  try {
    if (state.role !== 'MASTER') {
      return { status: 409, body: { success: false, code: 'NOT_MASTER', error: 'This device is not the offline master', master: masterHint() } }
    }
    if (!bearerToken || !body) {
      return { status: 401, body: { success: false, code: 'AUTH_NO_TOKEN', error: 'Cloud session token required' } }
    }
    const session = state.getSession && state.getSession()
    if (!session || !session.token || !session.user) {
      return { status: 503, body: { success: false, code: 'LAN_NO_WORKSPACE', error: 'Master has no open workspace yet' } }
    }
    // Validation chain (see the function doc above).
    const scope = workspaceScope()
    let validatedUser = null
    const presented = String(bearerToken)
    const sameSession = [String(session.token), session.previousToken ? String(session.previousToken) : null]
      .filter(Boolean)
      .some((cand) => {
        const b = Buffer.from(cand, 'utf-8')
        const p = Buffer.from(presented, 'utf-8')
        return b.length === p.length && timingSafeEqual(b, p)
      })
    if (sameSession) {
      validatedUser = { id: session.user.id, username: session.user.username, role: session.user.role, agencyId: scope.agencyId }
      log('JOIN token basis=same-session')
    } else {
      // 2) Cloud validation when the internet exists (mirrors import-session).
      let cloudVerdict = null
      try {
        const vRes = await fetch(cloudHealthUrl() + '/auth/refresh-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + presented },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        }).catch(() => null)
        if (vRes && vRes.status === 200) {
          const vData = await vRes.json().catch(() => null)
          if (vData && vData.success && vData.user) {
            cloudVerdict = { ok: true, user: vData.user }
          }
        } else if (vRes && (vRes.status === 401 || vRes.status === 403)) {
          cloudVerdict = { ok: false, reason: 'cloud-rejected' }
        } // else: inconclusive → fall through to offline validation
      } catch { /* offline — fall through */ }
      if (cloudVerdict && cloudVerdict.ok) {
        validatedUser = { id: cloudVerdict.user.id, username: cloudVerdict.user.username || cloudVerdict.user.email || 'member', role: cloudVerdict.user.role || 'STAFF', agencyId: cloudVerdict.user.agencyId || scope.agencyId }
        log('JOIN token basis=cloud-validated')
      } else if (cloudVerdict && !cloudVerdict.ok) {
        log('JOIN DENIED cloud-rejected fp=' + presented.slice(0, 8) + '…')
        return { status: 401, body: { success: false, code: 'AUTH_TOKEN_MISMATCH', error: 'Cloud rejected this session token' } }
      } else {
        // 3) Offline structural + mirror validation.
        const offline = await validateForeignCloudTokenOffline(presented, scope)
        if (!offline.ok) {
          log('JOIN DENIED offline-validation basis=' + offline.reason + ' fp=' + presented.slice(0, 8) + '…')
          return { status: 401, body: { success: false, code: 'AUTH_TOKEN_MISMATCH', error: 'Session token could not be validated (offline mirror check: ' + offline.reason + ')' } }
        }
        validatedUser = offline.user
        log('JOIN token basis=offline-mirror user=' + (validatedUser.username || validatedUser.id))
      }
    }
    const scopeAtDevice = scope
    const callerAgencyId = body.agencyId || null
    const callerBranchId = body.branchId || null
    if (!callerAgencyId || callerAgencyId !== scopeAtDevice.agencyId) {
      log(`JOIN DENIED scope agency caller=${callerAgencyId || '∅'} master=${scope.agencyId || '∅'} device=${body.deviceName || '?'}`)
      return { status: 403, body: { success: false, code: 'LAN_SCOPE_MISMATCH', error: 'Device belongs to a different agency workspace' } }
    }
    // Branch refinement: a BRANCH-BOUND staff device may only join a master of
    // the same branch. OWNER/agency-wide roles span all branches by definition.
    const ownerish = ['OWNER', 'AGENCY_OWNER', 'ADMIN', 'SUPER_ADMIN'].includes(String(body.role || '').toUpperCase()) ||
      ['OWNER', 'AGENCY_OWNER', 'ADMIN', 'SUPER_ADMIN'].includes(String(scope.userRole || '').toUpperCase())
    if (!ownerish && callerBranchId && scope.branchId && callerBranchId !== scope.branchId) {
      log(`JOIN DENIED scope branch caller=${callerBranchId} master=${scope.branchId} device=${body.deviceName || '?'}`)
      return { status: 403, body: { success: false, code: 'LAN_SCOPE_MISMATCH', error: 'Device belongs to a different branch' } }
    }
    // Register / refresh the device, mint its token.
    const deviceId = String(body.deviceFingerprint || randomBytes(12).toString('hex')).slice(0, 64)
    let rec = state.devices.find((d) => d.deviceId === deviceId)
    if (!rec) {
      rec = { deviceId }
      state.devices.push(rec)
      if (state.devices.length > MAX_DEVICES) state.devices.shift()
    }
    Object.assign(rec, {
      name: String(body.deviceName || 'device').slice(0, 80),
      platform: String(body.platform || 'web').slice(0, 16),
      agencyId: callerAgencyId,
      branchId: callerBranchId,
      role: String(body.role || validatedUser.role || '').slice(0, 24) || null,
      userId: validatedUser.id || session.user.id || null,
      username: validatedUser.username || session.user.username || null,
      joinedAt: rec.joinedAt || nowIso(),
      lastSeenAt: nowIso(),
      expiresAt: new Date(Date.now() + DEVICE_TOKEN_TTL_MS).toISOString(),
    })
    const lanToken = mintDeviceToken(deviceId)
    await persistDevices()
    log(`JOIN GRANTED device=${rec.name} platform=${rec.platform} term=${state.term} devices=${state.devices.length} agency=${callerAgencyId}${callerBranchId ? ' branch=' + callerBranchId : ''}`)
    return {
      status: 200,
      body: {
        success: true,
        data: {
          lanToken,
          term: state.term,
          master: masterHint(),
          expiresAt: rec.expiresAt,
        },
      },
    }
  } catch (err) {
    log('JOIN ERROR ' + (err && err.message))
    return { status: 500, body: { success: false, code: 'LAN_JOIN_FAILED', error: 'Join failed' } }
  }
}

function masterHint() {
  if (state.role === 'MASTER') {
    return {
      instanceId: state.instanceId,
      name: state.identity.name || os.hostname(),
      ip: state.identity.lanIp || null,
      port: state.identity.httpPort || 3080,
      term: state.term,
    }
  }
  if (state.master) {
    return {
      instanceId: state.master.instanceId,
      name: state.master.name,
      ip: state.master.ip,
      port: state.master.port,
      term: state.master.term,
    }
  }
  return null
}

// ─── UDP listener (peer presence) ────────────────────────────────────────────

function startListener() {
  if (listenSocket || !state.lanEnabled) return
  try {
    listenSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    listenSocket.on('error', () => { /* keep election best-effort */ })
    listenSocket.on('message', (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString('utf-8'))
        if (!msg || msg.service !== 'blasti-local') return
        const id = msg.instanceId || (rinfo.address + ':' + (msg.httpPort || 3080))
        if (state.instanceId && id === state.instanceId) return // self-echo
        const peer = state.peers.get(id) || { firstSeenAt: Date.now() }
        peer.instanceId = id
        peer.ip = rinfo.address
        peer.port = msg.httpPort || 3080
        peer.name = msg.name || peer.name || id
        peer.role = msg.role || peer.role || null
        peer.term = typeof msg.term === 'number' ? msg.term : (peer.term || 0)
        peer.specScore = typeof msg.specScore === 'number' ? msg.specScore : (peer.specScore || 0)
        peer.uptime = typeof msg.uptime === 'number' ? msg.uptime : (peer.uptime || 0)
        peer.agencyId = msg.agencyId !== undefined ? msg.agencyId : peer.agencyId
        peer.lastSeenAt = Date.now()
        peer.probed = peer.probed || false
        if (state.peers.size > MAX_PEERS) {
          // Evict the stalest peer.
          let oldestKey = null; let oldest = Infinity
          for (const [k, v] of state.peers) if (v.lastSeenAt < oldest) { oldest = v.lastSeenAt; oldestKey = k }
          if (oldestKey) state.peers.delete(oldestKey)
        }
        state.peers.set(id, peer)
      } catch { /* malformed beacon — ignore */ }
    })
    listenSocket.bind(BEACON_PORT, () => {
      try { listenSocket.setBroadcast(true) } catch { /* ignore */ }
      log(`peer listener bound on UDP :${BEACON_PORT}`)
      // R-21F fix: the authority ALSO broadcasts its own beacon — main.js's
      // beacon alone made election correctness depend on Electron boot order;
      // standalone hosts (and any desktop where the beacon failed) then ran
      // BLIND and two desktops could both claim mastership (split brain —
      // caught by the two-node E2E drill). Broadcasts dedupe by instanceId,
      // so coexisting with main.js's beacon is harmless.
      try {
        beaconTimer = setInterval(() => {
          try {
            const payload = Buffer.from(JSON.stringify({
              service: 'blasti-local',
              name: state.identity.name || os.hostname(),
              hostname: state.identity.hostname || os.hostname(),
              lanIp: state.identity.lanIp || null,
              httpPort: state.identity.httpPort || 3080,
              ...(publicBeaconExtras() || {}),
            }))
            const targets = new Set(['255.255.255.255'])
            try {
              for (const addrs of Object.values(os.networkInterfaces())) {
                for (const iface of addrs || []) {
                  if (iface.family !== 'IPv4' || iface.internal) continue
                  if (iface.broadcast) targets.add(iface.broadcast)
                }
              }
            } catch { /* global broadcast alone */ }
            for (const target of targets) {
              try { listenSocket.send(payload, 0, payload.length, BEACON_PORT, target, () => {}) } catch { /* skip */ }
            }
          } catch { /* non-fatal */ }
        }, BEACON_INTERVAL_MS)
        beaconTimer.unref && beaconTimer.unref()
      } catch { /* broadcast best-effort */ }
    })
  } catch (err) {
    log('listener unavailable (non-fatal): ' + (err && err.message))
    listenSocket = null
  }
}

// ─── Peer HTTP probing (authoritative role/term/specScore) ───────────────────

async function probePeers() {
  if (probeBusy) return
  probeBusy = true
  try {
    const targets = []
    for (const peer of state.peers.values()) {
      if (peerAlive(peer) && peer.ip && peer.port) targets.push(peer)
      if (targets.length >= 8) break // bound the probe burst
    }
    await Promise.all(targets.map(async (peer) => {
      try {
        const ctl = new AbortController()
        const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
        const res = await fetch(`http://${peer.ip}:${peer.port}/api/discover`, { signal: ctl.signal })
        clearTimeout(t)
        if (!res.ok) return
        const data = await res.json()
        if (!data || data.service !== 'blasti-local') return
        const wasMaster = peer.role === 'MASTER'
        peer.role = data.role || peer.role
        peer.term = typeof data.term === 'number' ? data.term : peer.term
        peer.specScore = typeof data.specScore === 'number' ? data.specScore : peer.specScore
        peer.uptime = typeof data.uptime === 'number' ? data.uptime : peer.uptime
        peer.agencyId = data.agencyId !== undefined ? data.agencyId : peer.agencyId
        peer.name = data.hostname || peer.name
        peer.lastSeenAt = Date.now()
        peer.probed = true
        if (wasMaster && peer.role !== 'MASTER' && state.master && state.master.instanceId === peer.instanceId) {
          log(`master ${peer.name || peer.instanceId} stepped down (role=${peer.role}, term=${peer.term})`)
        }
      } catch { /* dead/slow peer — expiry handles it */ }
    }))
  } finally {
    probeBusy = false
  }
}

// ─── Election state machine (design §3.3/§3.6) ───────────────────────────────

async function evaluateRole() {
  if (electionBusy) return
  electionBusy = true
  try {
    const prevRole = state.role

    // 0) r21-9 — the OWNER'S PIN outranks every automatic rule: when THIS
    //    machine is the pinned master it claims (or keeps) mastership at once;
    //    every other path below defers to a live pinned peer.
    if (isPreferredMaster(state.instanceId) && state.role !== 'MASTER') {
      let maxTerm = state.term
      for (const peer of state.peers.values()) if (peerAlive(peer)) maxTerm = Math.max(maxTerm, peer.term || 0)
      state.term = maxTerm + 1
      state.role = 'MASTER'
      state.claimedAt = nowIso()
      state.master = null
      await persistElection()
      log(`CLAIMED MASTER by OWNER PIN term=${state.term} (this machine is the manual master pick)`)
      notifyRole(prevRole)
      return
    }

    const masterPeer = activeMasterPeer()

    // 1) FOLLOWER upkeep: follow a live master; otherwise start claiming.
    if (state.role === 'FOLLOWER') {
      // The owner pinned a DIFFERENT live machine → switch to it at once.
      const pinned = preferredPeerAlive()
      if (pinned && pinned.instanceId !== state.master?.instanceId) {
        log(`owner pin — follower switches to preferred master ${pinned.name || pinned.instanceId} @${pinned.ip}:${pinned.port}`)
        state.master = { instanceId: pinned.instanceId, name: pinned.name, ip: pinned.ip, port: pinned.port, term: pinned.term, specScore: pinned.specScore, lastSeenAt: pinned.lastSeenAt }
        return
      }
      if (masterPeer && state.master && masterPeer.instanceId === state.master.instanceId) {
        state.master.lastSeenAt = masterPeer.lastSeenAt
        state.master.term = masterPeer.term
        // Term continuity: the follower tracks its master's term so a failover
        // claim always EXCEEDS the dead master's term (the E2E drill showed a
        // re-claim reusing term=1 when the follower never adopted it).
        if ((masterPeer.term || 0) > state.term) {
          state.term = masterPeer.term
          persistElection().catch(() => {})
        }
        return
      }
      if (masterPeer) {
        log(`following master ${masterPeer.name || masterPeer.instanceId} @${masterPeer.ip}:${masterPeer.port} (term=${masterPeer.term})`)
        state.master = { instanceId: masterPeer.instanceId, name: masterPeer.name, ip: masterPeer.ip, port: masterPeer.port, term: masterPeer.term, specScore: masterPeer.specScore, lastSeenAt: masterPeer.lastSeenAt }
        return
      }
      state.master = null
      state.role = 'CANDIDATE'
      state.quietWindows = 0
      log(`master lost — re-election begins (term was ${state.term})`)
      await persistElection()
      return
    }

    // 2) MASTER upkeep: a strictly better live master ⇒ step down (answer 5:
    //    better specs AND modern OS win via specScore; term outranks both).
    //    r21-9: the owner's pin outranks EVERYTHING — a live pinned peer takes
    //    over regardless of term/spec, while the pinned machine never yields.
    if (state.role === 'MASTER') {
      if (masterPeer && masterPeer.instanceId !== state.instanceId) {
        if (isPreferredMaster(state.instanceId)) return // owner pinned ME — keep mastership
        const peerWins = isPreferredMaster(masterPeer.instanceId) ||
          masterPeer.term > state.term ||
          (masterPeer.term === state.term && betterThan(masterPeer, { instanceId: state.instanceId, specScore: computeSpecScore(), uptime: Math.floor(process.uptime()) }))
        if (peerWins) {
          log(`STEPPING DOWN — ${isPreferredMaster(masterPeer.instanceId) ? 'OWNER-PINNED' : 'better'} master ${masterPeer.name || masterPeer.instanceId} (term ${masterPeer.term} ≥ ${state.term}, spec ${masterPeer.specScore})`)
          state.role = 'FOLLOWER'
          state.master = { instanceId: masterPeer.instanceId, name: masterPeer.name, ip: masterPeer.ip, port: masterPeer.port, term: masterPeer.term, specScore: masterPeer.specScore, lastSeenAt: masterPeer.lastSeenAt }
          await persistElection()
          notifyRole(prevRole)
        }
      }
      return
    }

    // 3) CANDIDATE: adopt a live same-scope master whose term outranks ours
    //    (split-brain prevention — the E2E drill caught both nodes claiming
    //    when term equality made neither "strictly better"), otherwise claim
    //    after CLAIM_WINDOWS quiet windows. r21-9: a live pinned peer is
    //    adopted unconditionally (owner's will) and blocks claiming.
    const pinned = preferredPeerAlive()
    if (pinned) {
      log(`candidate adopts OWNER-PINNED master ${pinned.name || pinned.instanceId} @${pinned.ip}:${pinned.port}`)
      state.role = 'FOLLOWER'
      state.master = { instanceId: pinned.instanceId, name: pinned.name, ip: pinned.ip, port: pinned.port, term: pinned.term, specScore: pinned.specScore, lastSeenAt: pinned.lastSeenAt }
      await persistElection()
      notifyRole(prevRole)
      return
    }
    if (masterPeer && masterPeer.term > state.term) {
      log(`candidate adopts live master ${masterPeer.name || masterPeer.instanceId} (term ${masterPeer.term} > ${state.term})`)
      state.role = 'FOLLOWER'
      state.master = { instanceId: masterPeer.instanceId, name: masterPeer.name, ip: masterPeer.ip, port: masterPeer.port, term: masterPeer.term, specScore: masterPeer.specScore, lastSeenAt: masterPeer.lastSeenAt }
      await persistElection()
      notifyRole(prevRole)
      return
    }
    const betterPeer = [...state.peers.values()].filter(peerAlive).find((peer) => {
      const scope = workspaceScope()
      if (scope.agencyId && peer.agencyId && peer.agencyId !== scope.agencyId) return false
      const me = { instanceId: state.instanceId, specScore: computeSpecScore(), uptime: Math.floor(process.uptime()) }
      return betterThan(peer, me) && peer.term >= state.term
    })
    if (betterPeer) {
      state.quietWindows = 0
      return
    }
    state.quietWindows += 1
    if (state.quietWindows >= CLAIM_WINDOWS) {
      let maxTerm = state.term
      for (const peer of state.peers.values()) if (peerAlive(peer)) maxTerm = Math.max(maxTerm, peer.term || 0)
      state.term = maxTerm + 1
      state.role = 'MASTER'
      state.claimedAt = nowIso()
      state.master = null
      await persistElection()
      log(`CLAIMED MASTER term=${state.term} spec=${computeSpecScore()} agency=${(workspaceScope().agencyId) || '∅'} (after ${state.quietWindows} quiet windows)`)
      notifyRole(prevRole)
    }
  } finally {
    electionBusy = false
  }
}

function notifyRole(prevRole) {
  try {
    state.broadcast && state.broadcast('lan:role', {
      role: state.role,
      term: state.term,
      master: masterHint(),
      instanceId: state.instanceId,
    })
  } catch { /* non-fatal */ }
  if (prevRole !== state.role) {
    log(`ROLE ${prevRole} → ${state.role} (term=${state.term})`)
  }
}

// ─── Public surface ──────────────────────────────────────────────────────────

/** Extra identity fields for /api/discover (additive; old clients ignore). */
function publicIdentity() {
  if (!state.inited) return null
  return {
    lanAuthority: true,
    role: state.role,
    term: state.term,
    specScore: computeSpecScore(),
    instanceId: state.instanceId,
    agencyId: workspaceScope().agencyId,
    branchId: workspaceScope().branchId,
    master: masterHint(),
  }
}

/** Extra fields main.js merges into its UDP beacon payload. */
function publicBeaconExtras() {
  if (!state.inited) return {}
  const id = publicIdentity()
  return {
    role: id.role,
    term: id.term,
    specScore: id.specScore,
    instanceId: id.instanceId,
    agencyId: id.agencyId,
    uptime: Math.floor(process.uptime()),
  }
}

/** Follower write-gate verdict for an HTTP request, or null when allowed. */
function followerWriteGate(method, pathname) {
  if (state.role !== 'FOLLOWER' || !state.master) return null
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null
  // Allowlist — infrastructure + read-cache maintenance endpoints.
  if (/^\/api\/(lan\/|auth\/|health|discover|db-status|sync\/pull|sync\/status|pending-mutations|initial-sync)/.test(pathname || '')) return null
  return {
    status: 409,
    body: {
      success: false,
      code: 'NOT_MASTER',
      error: 'This device is a follower — the offline master owns all writes while it is alive',
      master: masterHint(),
    },
  }
}

/** LAN status for /api/lan/status + the cloud reporter (r21-9). */
function statusSnapshot() {
  return {
    role: state.role,
    term: state.term,
    specScore: computeSpecScore(),
    instanceId: state.instanceId,
    agencyId: workspaceScope().agencyId,
    branchId: workspaceScope().branchId,
    master: masterHint(),
    startedAt: state.claimedAt,
    deviceCount: state.role === 'MASTER' ? state.devices.length : undefined,
    // r21-9 — identity + manual-master fields for the topology report/panel
    name: state.identity.name || state.identity.hostname || os.hostname(),
    hostname: state.identity.hostname || os.hostname(),
    lanIp: state.identity.lanIp || null,
    lanPort: state.identity.httpPort || 3080,
    uptimeSec: Math.floor(process.uptime()),
    preferredMasterInstanceId: state.preferredMasterInstanceId,
    // The joined-device registry — MASTER only (followers keep no registry).
    devices: state.role === 'MASTER'
      ? state.devices.slice(-MAX_DEVICES).map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          platform: d.platform,
          username: d.username,
          lastSeenAt: d.lastSeenAt,
        }))
      : [],
  }
}

/**
 * Init the authority. Called once from startLocalApi after the DB is ready.
 * @param {object} opts { metaGet, metaSet, getSession, diag, broadcast, lanEnabled, instanceId, identity }
 */
async function initAuthority(opts) {
  if (state.inited) return
  state.metaGet = opts.metaGet || null
  state.metaSet = opts.metaSet || null
  state.getSession = opts.getSession || null
  state.getDb = opts.getDb || null
  state.diag = opts.diag || null
  state.broadcast = opts.broadcast || null
  state.lanEnabled = !!opts.lanEnabled
  state.instanceId = opts.instanceId || ('dev-' + randomBytes(8).toString('hex'))
  state.identity = opts.identity || {}
  state.inited = true

  // Resume durable election state (term must never regress across restarts).
  try {
    if (state.metaGet) {
      const t = parseInt(await state.metaGet('lan_authority_term') || '0', 10)
      if (Number.isFinite(t) && t > 0) state.term = t
      const savedRole = await state.metaGet('lan_authority_role')
      if (savedRole === 'MASTER' || savedRole === 'FOLLOWER' || savedRole === 'CANDIDATE') state.role = 'CANDIDATE' // always re-elect on boot (§3.6 old-master demotion)
      const devRaw = await state.metaGet('lan_authority_devices')
      if (devRaw) {
        const parsed = JSON.parse(devRaw)
        if (Array.isArray(parsed)) state.devices = parsed.slice(-MAX_DEVICES)
      }
      const sec = await state.metaGet('lan_authority_secret')
      if (sec) state.secret = sec
      // r21-9 — resume the owner's manual master pick across restarts.
      const pref = await state.metaGet('lan_authority_preferred_master')
      if (pref) state.preferredMasterInstanceId = pref
    }
  } catch { /* defaults hold */ }
  if (!state.secret) {
    state.secret = randomBytes(32).toString('hex')
    try { if (state.metaSet) await state.metaSet('lan_authority_secret', state.secret) } catch { /* regenerates */ }
  }

  if (!state.lanEnabled) {
    // Loopback-only dev runs stay single-node masters of nothing.
    state.role = 'CANDIDATE'
    log(`init — LAN disabled (loopback bind), election idle, term=${state.term}`)
    return
  }

  startListener()
  electionTimer = setInterval(() => { evaluateRole().catch(() => {}) }, ELECTION_TICK_MS + Math.floor(Math.random() * 700))
  electionTimer.unref && electionTimer.unref()
  probeTimer = setInterval(() => { probePeers().catch(() => {}) }, PROBE_TICK_MS)
  probeTimer.unref && probeTimer.unref()
  log(`init — LAN mode, instance=${state.instanceId} spec=${computeSpecScore()} resumed term=${state.term}`)
}

/** Stop all timers/sockets (called from stopLocalApi). */
function shutdownAuthority() {
  try { electionTimer && clearInterval(electionTimer) } catch { /* ignore */ }
  try { probeTimer && clearInterval(probeTimer) } catch { /* ignore */ }
  try { beaconTimer && clearInterval(beaconTimer) } catch { /* ignore */ }
  try { listenSocket && listenSocket.close() } catch { /* ignore */ }
  electionTimer = null
  probeTimer = null
  beaconTimer = null
  listenSocket = null
  state.peers.clear()
  state.role = 'CANDIDATE'
  state.master = null
  state.inited = false
}

module.exports = {
  initAuthority,
  shutdownAuthority,
  publicIdentity,
  publicBeaconExtras,
  followerWriteGate,
  statusSnapshot,
  joinHandler,
  verifyDeviceToken,
  computeSpecScore,
  // r21-9 — manual master selection
  setPreferredMaster,
  getPreferredMasterInstanceId,
  isPreferredMaster,
}
