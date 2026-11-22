/**
 * BLASTI Local Realtime Socket Server (local-first, spec §7/§8)
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (field log, round 7):
 *   The desktop UI connects its Socket.IO client to the EMBEDDED LOCAL API
 *   (http://127.0.0.1:3080 — see use-realtime.ts resolveSocketUrl). The local
 *   API previously had NO Socket.IO server, so every UI realtime connection
 *   404'd ("404 — no route matched: GET /socket.io/"), the UI stayed
 *   "disconnected" forever, and the agency dashboard showed
 *   "Operating in offline mode" EVEN WHEN THE CLOUD WAS HEALTHY.
 *
 * CONTRACT (mirrors the cloud Socket.IO server in apps/api/src/index.ts):
 *   - Same room protocol:  join:room / leave:room / join:agency / leave:agency /
 *     join:customer / leave:customer / join:kiosk / leave:kiosk / join:admin /
 *     leave:admin, plus an `auth` upgrade event.
 *   - Same event payload shape: { type, agencyId, userId, data, timestamp }
 *     (RealtimeEventData in the UI), emitted with the SAME event names
 *     (queue:*, reservation:*, notification:*, kiosk:update, agency:*,
 *     staff:*, admin:*).
 *   - Two event sources feed the same router:
 *       1. LOCAL business mutations — the local API's in-process `emitEvent`
 *          stream (bridged in index.js), so realtime works FULLY OFFLINE.
 *       2. CLOUD relays — sync-service's cloud socket re-emits cloud events
 *          (relayCloudRealtime), so the desktop sees other clients' changes
 *          while online.
 *
 * SECURITY (strict invariant — never weaken):
 *   - Server binds loopback only (the local API already binds 127.0.0.1).
 *   - Handshake auth.token must equal the CURRENT local session token
 *     (timing-safe compare). Invalid/absent token → socket may CONNECT
 *     (kiosk screens may mirror displays) but is UNAUTHENTICATED: it can
 *     only join kiosk rooms, and it never receives agency data events.
 *   - A socket may upgrade to authenticated later via the `auth` event
 *     (covers the renderer that connected before its session token was
 *     restored — use-realtime re-emits `auth` when the token changes).
 *   - Room authorization: an authenticated principal may only join rooms for
 *     ITS OWN agency / user id (SUPER_ADMIN exempt). No DB lookups needed —
 *     the only valid credential IS the current local session.
 */

const { timingSafeEqual } = require('crypto')

// ─── Module state ────────────────────────────────────────────────────────────

let _io = null
let _getSession = null // () => ({ token, user } | null)
let _getDb = null // () => local Prisma client | null (device room joins)
let _getPreviousSessionToken = null // Task 41 — () => previous-token | null (rotation grace)
let _relayAgencyId = null // agency room the cloud relay targets
let _startedAt = null

const _stats = {
  connectionsTotal: 0,
  authenticatedTotal: 0,
  rejectionsTotal: 0,
  eventsBroadcast: 0,
  eventsRelayedFromCloud: 0,
}

// Internal event names that must NEVER be relayed cloud → UI verbatim.
const RELAY_SKIP_EVENTS = new Set([
  'sync:changes', // internal pull trigger — the engine already pulls
  'connect',
  'disconnect',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timingSafeTokenCompare(a, b) {
  try {
    if (!a || !b) return false
    const ab = Buffer.from(String(a), 'utf-8')
    const bb = Buffer.from(String(b), 'utf-8')
    if (ab.length !== bb.length) return false
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

function log(...args) {
  console.log('[LocalRealtime]', ...args)
}

function warn(...args) {
  console.warn('[LocalRealtime]', ...args)
}

/**
 * Is this origin allowed to open a socket to the local API?
 * The local server binds 127.0.0.1 by default; the renderer origins we serve
 * are the dev server (localhost:3000), the packaged web origin, Electron
 * file:// pages (which send NO origin header), and Capacitor shells.
 * When the local API is bound to the LAN (BLASTI_LAN_BIND / BLASTI_ENABLE_LAN
 * — same resolution as index.js), private http origins (the kiosk/TV
 * webviews on the same network) are accepted too, mirroring the HTTP CORS
 * layer so Socket.IO never gets stricter than fetch.
 */
const { isLanHttpOrigin, resolveLanBind } = require('./lib/lan-origin')

function isLocalOriginAllowed(origin) {
  if (!origin) return true // Electron/websocket handshakes may omit Origin
  if (resolveLanBind().lan && isLanHttpOrigin(origin)) return true
  try {
    const u = new URL(origin)
    const host = u.hostname
    if (host === 'localhost' || host === '127.0.0.1') return true
    if (origin === 'capacitor://localhost' || origin === 'file://') return true
    // Self-hosted deployments serve the web UI from the operator's own
    // origin — extra origins can be allowed via BLASTI_LAN_ORIGINS.
    const allowed = String(process.env.BLASTI_LAN_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean)
    if (allowed.includes(origin)) return true
  } catch { /* malformed origin */ }
  return false
}

/** Short SAFE fingerprint for logs — never log the full token. */
function tokenFingerprint(token) {
  if (!token) return '(null)'
  const s = String(token)
  return s.slice(0, 10) + '…(len ' + s.length + ')'
}

/** Resolve the current local session (token + user) safely. */
function currentSession() {
  try {
    const s = _getSession && _getSession()
    return s && s.token && s.user ? s : null
  } catch {
    return null
  }
}

/**
 * Validate an incoming token against the CURRENT session (or, Task 41, the
 * rotation-grace predecessor of the same session). Returns the session user
 * when valid, else null. (Re-checked on every `auth` event so token rotations
 * are picked up mid-connection.)
 */
function authenticateToken(token) {
  const session = currentSession()
  if (!session) return null
  if (timingSafeTokenCompare(token, session.token)) return session.user
  // Task 41 — the cloud re-issues tokens on import/refresh; a renderer socket
  // presenting the IMMEDIATE predecessor token of the same session must not
  // be rejected (this was the "auth event rejected" spam in the field logs).
  try {
    const prev = _getPreviousSessionToken && _getPreviousSessionToken()
    if (prev && timingSafeTokenCompare(token, prev)) return session.user
  } catch { /* grace lookup is best-effort */ }
  return null
}

// ─── Room protocol ───────────────────────────────────────────────────────────

function canJoinAgency(user, agencyId) {
  if (!user || !agencyId) return false
  if (user.role === 'SUPER_ADMIN') return true
  return user.agencyId === agencyId
}

function canJoinCustomer(user, userId) {
  if (!user || !userId) return false
  if (user.role === 'SUPER_ADMIN') return true
  return user.id === userId
}

function canJoinAdmin(user) {
  return !!user && user.role === 'SUPER_ADMIN'
}

/**
 * 0.6.101 — room keys for the pre-pairing delivery rooms. Accepts either a
 * plain object { deviceId?, fingerprint? } or a bare string (fingerprint).
 * Keys are sanitized to safe room suffixes (alnum, dash, underscore, colon —
 * max 200 chars) so a malicious payload can never craft a wildcard room.
 */
function pairingWaitRoomKeys(payload) {
  const keys = []
  const push = (val) => {
    if (typeof val !== 'string') return
    const clean = val.trim().slice(0, 200).replace(/[^a-zA-Z0-9:_-]/g, '')
    if (clean && !keys.includes(clean)) keys.push(clean)
  }
  if (typeof payload === 'string') {
    push(payload)
  } else if (payload && typeof payload === 'object') {
    push(payload.deviceId)
    push(payload.fingerprint)
  }
  return keys
}

function _registerRoomHandlers(socket, authRef) {
  const ensureAuth = () => authRef.user

  socket.on('join:room', (room) => {
    if (!room || typeof room !== 'string') return
    // Task 75 (parity with the cloud's join:room): agency:* and customer:*
    // rooms are AUTHORIZED rooms — the generic path must not become an
    // unauthenticated bypass around join:agency / join:customer. Only
    // admin:* was checked before, so any loopback socket (kiosk webviews,
    // a pre-session renderer) could join agency rooms via join:room and
    // receive queue events without a session.
    if (room.startsWith('admin:')) {
      if (!canJoinAdmin(ensureAuth())) {
        warn('socket', socket.id, 'rejected join:room(' + room + ') — not authorized')
        return
      }
    } else if (room.startsWith('agency:')) {
      if (!canJoinAgency(ensureAuth(), room.slice('agency:'.length))) {
        warn('socket', socket.id, 'rejected join:room(' + room + ') — not authorized')
        return
      }
    } else if (room.startsWith('customer:')) {
      if (!canJoinCustomer(ensureAuth(), room.slice('customer:'.length))) {
        warn('socket', socket.id, 'rejected join:room(' + room + ') — not authorized')
        return
      }
    }
    socket.join(room)
  })

  socket.on('leave:room', (room) => {
    if (room && typeof room === 'string') socket.leave(room)
  })

  socket.on('join:agency', (agencyId) => {
    if (!canJoinAgency(ensureAuth(), agencyId)) {
      warn('socket', socket.id, 'rejected join:agency(' + agencyId + ') — not authorized')
      return
    }
    socket.join('agency:' + agencyId)
  })

  socket.on('leave:agency', (agencyId) => {
    if (agencyId) socket.leave('agency:' + agencyId)
  })

  socket.on('join:customer', (userId) => {
    if (!canJoinCustomer(ensureAuth(), userId)) {
      warn('socket', socket.id, 'rejected join:customer(' + userId + ') — not authorized')
      return
    }
    socket.join('customer:' + userId)
  })

  socket.on('leave:customer', (userId) => {
    if (userId) socket.leave('customer:' + userId)
  })

  // Kiosk rooms: authenticated staff may join their own agency's kiosk room;
  // unauthenticated (LAN TV / kiosk screens) may also join kiosk rooms only —
  // same policy as the cloud ("allow connection without auth but restrict
  // which rooms they can join").
  socket.on('join:kiosk', (agencyId) => {
    const user = ensureAuth()
    if (user && !canJoinAgency(user, agencyId)) {
      warn('socket', socket.id, 'rejected join:kiosk(' + agencyId + ') — not authorized')
      return
    }
    socket.join('kiosk:' + agencyId)
  })

  socket.on('leave:kiosk', (agencyId) => {
    if (agencyId) socket.leave('kiosk:' + agencyId)
  })

  // ─── 0.6.101 — PRE-PAIRING DELIVERY ROOMS ────────────────────────────────
  // A kiosk / phone / desktop shell WAITING for pairing has no agency room
  // (it joins rooms only AFTER it has a token + agency). Its 5-second
  // /device-status poll was the ONLY delivery channel, so a pairing request
  // written while the poll was mid-flight (or aimed at the other store)
  // waited up to a full poll cycle — or never arrived ("pairing request is
  // not reaching to the kiosk device"). These PUBLIC rooms are keyed by the
  // waiting device's OWN identity (device id and/or stable fingerprint) and
  // carry exactly one event type: 'pairing-request'. No secrets, no agency
  // data — the same payload the poll already returns to the device itself.
  socket.on('join:pairing-wait', (payload) => {
    const keys = pairingWaitRoomKeys(payload)
    if (!keys.length) {
      warn('socket', socket.id, 'join:pairing-wait without a usable identity — ignored')
      return
    }
    for (const key of keys) socket.join('pairing-wait:' + key)
  })

  socket.on('leave:pairing-wait', (payload) => {
    for (const key of pairingWaitRoomKeys(payload)) socket.leave('pairing-wait:' + key)
  })

  // Device rooms (TV boards / kiosks authenticated by deviceToken — mirrors
  // the cloud join:device): validates the token against the LOCAL AgencyDevice
  // mirror, then joins device:* + agency:* + kiosk:* so display devices
  // receive queue:* and kiosk:update while offline/LAN-mode.
  socket.on('join:device', async (deviceToken) => {
    if (!deviceToken || typeof deviceToken !== 'string') return
    const db = _getDb && _getDb()
    if (!db) {
      warn('socket', socket.id, 'rejected join:device — local database not ready')
      return
    }
    let device = null
    try {
      device = await db.agencyDevice.findUnique({
        where: { deviceToken },
        select: { id: true, agencyId: true, type: true, status: true },
      })
    } catch (err) {
      warn('socket', socket.id, 'join:device lookup failed: ' + (err && err.message))
      return
    }
    if (!device) {
      warn('socket', socket.id, 'rejected join:device with invalid token')
      return
    }
    socket.join('device:' + device.id)
    if (device.agencyId) {
      socket.join('agency:' + device.agencyId)
      socket.join('kiosk:' + device.agencyId)
    }
    socket._blastiDeviceId = device.id
    socket._blastiDeviceAgencyId = device.agencyId || null
    socket._blastiIsDevice = true
    // Flip the device ONLINE (respect DISABLED) — parity with the cloud
    if (device.status !== 'DISABLED') {
      try {
        await db.agencyDevice.update({
          where: { id: device.id },
          data: { status: 'ONLINE', lastHeartbeatAt: new Date(), statusChangedAt: new Date() },
        })
      } catch { /* best-effort */ }
    } else {
      try {
        await db.agencyDevice.update({ where: { id: device.id }, data: { lastHeartbeatAt: new Date() } })
      } catch { /* best-effort */ }
    }
    log('Device joined:', socket.id, '(device:', device.id + ', type:', device.type + ', agency:', String(device.agencyId) + ')')
  })

  socket.on('leave:device', () => {
    if (socket._blastiDeviceId) {
      socket.leave('device:' + socket._blastiDeviceId)
      if (socket._blastiDeviceAgencyId) {
        socket.leave('kiosk:' + socket._blastiDeviceAgencyId)
        socket.leave('agency:' + socket._blastiDeviceAgencyId)
      }
      socket._blastiDeviceId = null
      socket._blastiDeviceAgencyId = null
      socket._blastiIsDevice = false
    }
  })

  socket.on('join:admin', () => {
    if (!canJoinAdmin(ensureAuth())) {
      warn('socket', socket.id, 'rejected join:admin — not authorized')
      return
    }
    socket.join('admin:global')
  })

  socket.on('leave:admin', () => {
    socket.leave('admin:global')
  })

  // Auth upgrade (use-realtime C3 emits `auth` whenever the session token
  // changes). A socket that connected before the session existed can use
  // this to become authenticated WITHOUT a reconnect.
  socket.on('auth', (payload) => {
    try {
      const token = payload && typeof payload === 'object' ? payload.token : payload
      const user = authenticateToken(token)
      if (user) {
        authRef.user = user
        _stats.authenticatedTotal++
        log('socket', socket.id, 'authenticated via auth event (user:', (user.username || user.id) + ')')
      } else {
        // Task 41 — actionable rejection log: fingerprint what was presented
        // vs what the session holds, so mismatch reports are diagnosable.
        const session = currentSession()
        warn('socket', socket.id, 'auth event rejected — token', tokenFingerprint(token),
          'does not match the current local session',
          session ? '(current=' + tokenFingerprint(session.token) + ')' : '(no active session)')
      }
    } catch (e) {
      warn('auth event error (non-fatal):', e.message)
    }
  })
}

// ─── Init / teardown ─────────────────────────────────────────────────────────

/**
 * Attach the local Socket.IO server to the embedded API's HTTP server.
 * @param {import('http').Server} httpServer - the @hono/node-server instance
 * @param {{ getSession: () => { token: string, user: object } | null, getDb?: () => object | null }} options
 */
function initLocalRealtime(httpServer, options) {
  if (_io) return _io
  _getSession = (options && options.getSession) || null
  _getDb = (options && options.getDb) || null
  _getPreviousSessionToken = (options && options.getPreviousSessionToken) || null

  let ServerCtor
  try {
    ;({ Server: ServerCtor } = require('socket.io'))
  } catch (e) {
    warn('socket.io server package unavailable — local realtime disabled:', e.message)
    return null
  }

  _io = new ServerCtor(httpServer, {
    // Loopback-only server: reflect the origin for the local dev server and
    // native shells; reject foreign origins at handshake (CSWSH protection).
    cors: {
      origin: (origin, callback) => {
        if (isLocalOriginAllowed(origin)) return callback(null, true)
        warn('rejected handshake from origin:', origin)
        _stats.rejectionsTotal++
        callback(new Error('Origin not allowed'), false)
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 10000,
    pingTimeout: 5000,
    allowUpgrades: true,
    maxHttpBufferSize: 1e6,
  })

  _io.on('connection', (socket) => {
    _stats.connectionsTotal++

    // Handshake auth — token must match the CURRENT local session.
    const handshakeToken =
      socket.handshake && socket.handshake.auth ? socket.handshake.auth.token : null
    const user = authenticateToken(handshakeToken)

    // authRef lets the `auth` event upgrade this socket later.
    const authRef = { user: user || null }
    socket._blastiAuthRef = authRef

    if (user) {
      _stats.authenticatedTotal++
      log('Client connected:', socket.id, '(user:', (user.username || user.id) + ', role:', user.role + ')')
    } else {
      log('Client connected:', socket.id, '(unauthenticated — kiosk/limited until a valid auth event)')
    }

    _registerRoomHandlers(socket, authRef)

    socket.on('disconnect', (reason) => {
      log('Disconnected:', socket.id, '(' + reason + ')')
    })
  })

  _startedAt = Date.now()
  log('Local realtime socket server attached — UI realtime now works offline (local-first)')
  return _io
}

function closeLocalRealtime() {
  if (_io) {
    try { _io.disconnectSockets(true) } catch { /* already down */ }
    try { _io.close() } catch { /* already down */ }
    _io = null
    log('Local realtime socket server closed')
  }
  _getSession = null
  _getDb = null
  _relayAgencyId = null
}

// ─── Broadcasting ────────────────────────────────────────────────────────────

/**
 * Route a business event to rooms — EXACTLY the cloud broadcastEvent policy
 * (apps/api/src/index.ts). Event shape sent to clients mirrors the cloud:
 *   { type, agencyId, userId, data, timestamp }
 * The local `emitEvent` payload (e.g. { agencyId, reservation }) is wrapped
 * as `data`.
 * @returns {number} recipient socket count (0 when no server/room members)
 */
function broadcastLocalRealtime(type, payload) {
  if (!_io || !type) return 0
  const data = payload && typeof payload === 'object' ? payload : {}
  const agencyId = data.agencyId || null
  const userId =
    data.userId ||
    (data.reservation && data.reservation.userId) ||
    (data.user && data.user.id) ||
    null
  const event = { type, agencyId, userId, data, timestamp: Date.now() }
  const room = (name) => {
    try {
      const sockets = _io.sockets.adapter.rooms.get(name)
      return sockets ? sockets.size : 0
    } catch { return 0 }
  }
  let recipients = 0

  if (type.startsWith('queue:')) {
    if (agencyId) {
      _io.to('agency:' + agencyId).emit(type, event)
      recipients += room('agency:' + agencyId)
    }
  } else if (type.startsWith('reservation:')) {
    if (agencyId) {
      _io.to('agency:' + agencyId).emit(type, event)
      recipients += room('agency:' + agencyId)
    }
    if (userId) {
      _io.to('customer:' + userId).emit(type, event)
      recipients += room('customer:' + userId)
    }
  } else if (type.startsWith('notification:') || type.startsWith('notifications:')) {
    if (userId) {
      _io.to('customer:' + userId).emit(type, event)
      recipients += room('customer:' + userId)
    } else if (agencyId) {
      // Local API also emits agency-wide notification events (read-all etc.)
      _io.to('agency:' + agencyId).emit(type, event)
      recipients += room('agency:' + agencyId)
    }
  } else if (type === 'kiosk:update') {
    if (agencyId) {
      _io.to('kiosk:' + agencyId).emit(type, event)
      recipients += room('kiosk:' + agencyId)
    }
  } else if (type.startsWith('agency-device:')) {
    if (agencyId) {
      // 0.6.105 — PAIRED-DEVICE SAVE FIX: the historic local emit wrapped the
      // payload as the literal event name 'realtime-event' { type, data } —
      // a name NO client subscribes to. The Device Manager listens for the
      // RAW names ('agency-device:connected', 'agency-device:pairing-request'
      // …), so local pairing acceptances never refreshed the paired-devices
      // list in realtime. Emit the RAW event name with a FLAT payload, same
      // as the cloud relay now does.
      _io.to('agency:' + agencyId).emit(type, { ...data, agencyId, timestamp: Date.now() })
      recipients += room('agency:' + agencyId)
    }
  } else if (type === 'pairing-request') {
    // 0.6.101 — INSTANT pairing delivery to the waiting device. The payload is
    // the SAME shape the /device-status poll returns for pairingRequests, so
    // the kiosk handles both channels with one code path. Rooms are keyed by
    // device id AND fingerprint — whichever identity the waiting device used
    // to join. Delivered FLAT (not wrapped in {type,data}) to match the poll.
    const pushed = pairingWaitRoomKeys({ deviceId: data.deviceId, fingerprint: data.fingerprint })
    for (const key of pushed) {
      _io.to('pairing-wait:' + key).emit('pairing-request', {
        ...data,
        sentAt: data.sentAt || new Date().toISOString(),
      })
      recipients += room('pairing-wait:' + key)
    }
  } else if (
    type.startsWith('agency:') ||
    type.startsWith('staff:') ||
    type.startsWith('service:') ||
    type.startsWith('branch:') ||
    type.startsWith('counter:') ||
    type.startsWith('device:') ||
    type.startsWith('user:') ||
    type === 'queue:agency-offline'
  ) {
    if (agencyId) {
      _io.to('agency:' + agencyId).emit(type, event)
      recipients += room('agency:' + agencyId)
    } else if (type.startsWith('device:') && userId) {
      _io.to('customer:' + userId).emit(type, event)
      recipients += room('customer:' + userId)
    }
  } else if (type.startsWith('admin:')) {
    _io.to('admin:global').emit(type, event)
    recipients += room('admin:global')
  } else {
    // Unknown/local-internal event — deliver to the agency room when the
    // payload identifies one, otherwise drop (never broadcast globally).
    if (agencyId) {
      _io.to('agency:' + agencyId).emit(type, event)
      recipients += room('agency:' + agencyId)
    }
  }

  if (recipients > 0) _stats.eventsBroadcast++
  return recipients
}

/**
 * Relay context — the agency room the sync engine's cloud socket joined.
 * Called by sync-service whenever the socket (re)connects with an agency.
 */
function setLocalRealtimeRelayContext(agencyId) {
  _relayAgencyId = agencyId || null
}

// 0.6.103 — local-db reconcile callback for cloud-accepted pairing (registered
// from index.js where the Prisma client lives; see relayCloudRealtime).
let _reconcileCloudDeviceAccept = null
function setCloudDeviceAcceptReconciler(fn) {
  _reconcileCloudDeviceAccept = typeof fn === 'function' ? fn : null
}

// 0.6.104 — CLOUD WALK-IN MIRROR. A kiosk that joined the queue against the
// CLOUD store (LAN pin failed) emits queue:walk-in there; the relay below
// delivered the EVENT to the desktop UI instantly, but the RESERVATION ROW
// itself only landed in the local DB at the next sync pull — the full-screen
// display fetched nothing new and the ticket appeared seconds late. The
// mirror callback (registered from index.js, where the Prisma client lives)
// upserts the reservation row BEFORE the relayed event fans out, so the UI's
// refetch triggered by this very event finds the data already present.
let _mirrorCloudWalkIn = null
function setCloudWalkInMirror(fn) {
  _mirrorCloudWalkIn = typeof fn === 'function' ? fn : null
}

// 0.6.105 — CLOUD PRINT-JOB RELAY. A kiosk that prints its receipt against
// the CLOUD store targets a printer that hangs off a branch PC's USB port —
// the cloud box can never raw-TCP or HTTP-forward to a LAN address it cannot
// reach. The job therefore travels over the agency's realtime room (event
// 'agency-device:print-job'), the engine socket receives it here, and the
// handler registered from index.js prints it through the OS print service
// when THIS machine is the printer's host (instance id / LAN IP match) —
// all in the background, no kiosk round-trip.
let _cloudPrintJobHandler = null
function setCloudPrintJobHandler(fn) {
  _cloudPrintJobHandler = typeof fn === 'function' ? fn : null
}

/**
 * Relay one event received on the SYNC ENGINE's cloud socket into the local
 * rooms. The cloud already routed the event to the agency room the engine
 * joined, so everything arriving here is agency-scoped data for THIS agency.
 * @param {string} eventName
 * @param {Array} args - socket.io handler arguments ([payload])
 */
function relayCloudRealtime(eventName, args) {
  if (!_io || !eventName || RELAY_SKIP_EVENTS.has(eventName)) return 0
  if (!_relayAgencyId) return 0
  const payload = Array.isArray(args) && args.length > 0 ? args[0] : {}
  const event =
    payload && typeof payload === 'object'
      ? Object.assign({}, payload, { agencyId: payload.agencyId || _relayAgencyId })
      : { data: payload, agencyId: _relayAgencyId }

  // 0.6.103 — CLOUD-ACCEPT RECONCILE. A device that polls the CLOUD accepts
  // its pairing request THERE: the cloud AgencyDevice row flips ONLINE, but
  // the desktop's LOCAL mirror (created when the manager sent the pairing
  // request) stayed PAIRING forever — the device never appeared in the
  // registered/saved paired-devices list. The cloud acceptance event now
  // carries the stable fingerprint + the canonical token; match the local
  // orphan and complete its pairing in THIS store too.
  if (eventName === 'agency-device:connected' && typeof _reconcileCloudDeviceAccept === 'function') {
    try { _reconcileCloudDeviceAccept(event) } catch (reconcileErr) {
      warn('cloud device-accept reconcile failed:', reconcileErr && reconcileErr.message)
    }
  }

  // 0.6.104 — CLOUD WALK-IN MIRROR (before the relay: the event handlers the
  // relay triggers refetch immediately, so the row must exist first).
  if (eventName === 'queue:walk-in' && typeof _mirrorCloudWalkIn === 'function') {
    try { _mirrorCloudWalkIn(event) } catch (mirrorErr) {
      warn('cloud walk-in mirror failed:', mirrorErr && mirrorErr.message)
    }
  }

  // 0.6.105 — CLOUD PRINT-JOB RELAY (before the relay: the print happens on
  // THIS machine; the UI relay of the same event stays informational).
  if (eventName === 'agency-device:print-job' && typeof _cloudPrintJobHandler === 'function') {
    try { _cloudPrintJobHandler(event) } catch (printErr) {
      warn('cloud print-job relay failed:', printErr && printErr.message)
    }
  }

  _io.to('agency:' + _relayAgencyId).emit(eventName, event)
  _stats.eventsRelayedFromCloud++
  return 1
}

function getLocalRealtimeStats() {
  let clients = 0
  let authenticated = 0
  const rooms = {}
  if (_io) {
    try {
      clients = _io.engine.clientsCount
      for (const [id, s] of _io.sockets.sockets) {
        if (s._blastiAuthRef && s._blastiAuthRef.user) authenticated++
        void id
      }
      // Field diagnostics (realtime-parity reports): the #1 question when the
      // desktop "doesn't update live" is whether ANY socket actually sits in
      // the agency room. room name → member count, kiosk/admin included.
      for (const [roomName, members] of _io.sockets.adapter.rooms) {
        rooms[roomName] = members.size
      }
    } catch { /* engine not ready */ }
  }
  return Object.assign({}, _stats, {
    running: !!_io,
    startedAt: _startedAt,
    clients,
    authenticated,
    rooms,
    relayAgencyId: _relayAgencyId,
    uptimeSec: _startedAt ? Math.floor((Date.now() - _startedAt) / 1000) : 0,
  })
}

module.exports = {
  initLocalRealtime,
  closeLocalRealtime,
  broadcastLocalRealtime,
  setLocalRealtimeRelayContext,
  setCloudDeviceAcceptReconciler,
  setCloudWalkInMirror,
  // 0.6.105 — background receipt printing on the printer-host PC
  setCloudPrintJobHandler,
  relayCloudRealtime,
  getLocalRealtimeStats,
  // 0.6.101 — pre-pairing delivery rooms (join sanitation + tests)
  pairingWaitRoomKeys,
}
