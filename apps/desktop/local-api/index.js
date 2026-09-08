/**
 * BLASTI Embedded Local API Server
 *
 * A Hono-based HTTP server that runs inside Electron on localhost.
 * Agent-scoped: every query is filtered by the logged-in agent's agencyId.
 *
 * Architecture:
 *   Electron BrowserWindow → http://127.0.0.1:3080/api/* → Hono → SQLite
 *                                                         → Background Sync → Cloud API (when online)
 *
 * Security:
 *   - Binds ONLY to 127.0.0.1 (never 0.0.0.0)
 *   - Per-launch session token (random hex, timing-safe comparison)
 *   - All requests (except health/login/discover/sync-status) require valid session token
 *   - NO admin endpoints — agent-level only
 *
 * This file is meant to be run inside Electron's main process,
 * NOT as a standalone Node.js script.
 */

const { Hono } = require('hono')
const { cors } = require('hono/cors')
const { createServer } = require('http')
const path = require('path')
const { randomBytes, timingSafeEqual, createHash } = require('crypto')
const { localDb, setupPragmas } = require('./lib/db')

// ─── Socket.IO (optional) ────────────────────────────────────────────────────
let socketIO = null
try {
  socketIO = require('socket.io')
} catch (_e) {
  // socket.io not installed — realtime events will only go to local listeners
}

// ─── Configuration ────────────────────────────────────────────────────────

const DEFAULT_PORT = 3080
const BIND_ADDRESS = '127.0.0.1'
const CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3080',
  'http://localhost:3111',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3080',
  'http://127.0.0.1:3111',
  'http://127.0.0.1:5173',
]

// ─── Cloud URL Resolution ─────────────────────────────────────────────────

let _resolvedCloudUrl = null

/**
 * Get the resolved cloud API base URL.
 * Priority: BLASTI_CLOUD_URL → BLASTI_API_URL → dev/prod defaults.
 * The result is cached after first call and logged once.
 *
 * IMPORTANT: This points to the Hono API server, NOT the Next.js frontend.
 * - ✅ https://blasti-api.vercel.app  (API server)
 * - ✅ http://localhost:3003           (local dev API)
 * - ❌ https://blasti.vercel.app       (Next.js frontend — will 404 on /api/auth/login)
 */
function getCloudUrl() {
  if (_resolvedCloudUrl) return _resolvedCloudUrl

  // Dev mode detection — check env vars AND --dev CLI flag (Electron passes it via process.argv)
  const isDevMode = process.env.NODE_ENV === 'development' ||
    process.env.ELECTRON_DEV === '1' ||
    (process.argv && process.argv.includes('--dev'))

  if (process.env.BLASTI_CLOUD_URL) {
    _resolvedCloudUrl = process.env.BLASTI_CLOUD_URL
  } else if (process.env.BLASTI_API_URL) {
    _resolvedCloudUrl = process.env.BLASTI_API_URL
  } else if (isDevMode) {
    _resolvedCloudUrl = 'http://localhost:3003'
  } else {
    _resolvedCloudUrl = 'https://blasti-api.vercel.app'
  }

  console.log('[LocalAPI] Cloud API URL resolved to:', _resolvedCloudUrl, '(isDevMode:', isDevMode, ')')
  return _resolvedCloudUrl
}

// ─── Module-level State ───────────────────────────────────────────────────

let db = null
let httpServer = null
let ioServer = null  // Socket.IO server instance (optional)
let sessionToken = null
let sessionUser = null
let eventListeners = []
let _isSyncing = false
let _lastSyncAt = null
let _pendingMutationsCount = 0
let _lastCloudContactAt = null  // Timestamp of last successful cloud communication
const OFFLINE_TOKEN_MAX_MS = 3 * 24 * 60 * 60 * 1000  // 3 days — max offline duration before re-auth required
let _monotonicStart = process.hrtime.bigint()  // Monotonic clock reference point for clock-manipulation detection
let _wallClockAtStart = Date.now()  // Wall clock at monotonic start

// ─── Transactional Write Helpers ───────────────────────────────────────────

/**
 * Execute a write operation atomically with the local SQLite database.
 * Wraps the operation in a Prisma $transaction for crash safety.
 * If the transaction fails, it rolls back and the error is thrown.
 */
async function atomicWrite(writeFn) {
  if (!db) throw new Error('Database not initialized')
  return db.$transaction(writeFn, { maxWait: 5000, timeout: 10000 })
}

/**
 * Execute a write + pending mutation record atomically.
 * This ensures that if the local write succeeds but the mutation record fails,
 * the entire operation rolls back. This prevents orphaned writes without
 * mutation tracking (which would be lost on the next sync push).
 */
async function atomicWriteWithMutation(writeFn, mutationData) {
  if (!db) throw new Error('Database not initialized')
  return db.$transaction(async (tx) => {
    const result = await writeFn(tx)
    if (mutationData) {
      await ensurePendingMutationsTable()
      const id = require('crypto').randomUUID()
      const iKey = mutationData.idempotencyKey || 
        (mutationData.method === 'POST' ? `${mutationData.method}:${mutationData.path}:${id}` : null)
      await tx.$executeRawUnsafe(
        'INSERT OR IGNORE INTO "_pending_mutations" (id, method, path, body, idempotency_key, status, created_at, response_data) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?)',
        id,
        mutationData.method,
        mutationData.path,
        mutationData.body ? JSON.stringify(mutationData.body) : null,
        iKey,
        Date.now(),
        result ? JSON.stringify(result) : null
      )
    }
    return result
  }, { maxWait: 5000, timeout: 10000 })
}

// ─── Sync Cursor State ────────────────────────────────────────────────────

let _lastPulledSequence = 0
let _lastPushedSequence = 0
const _syncProtocolVersion = 1
const _syncModelCount = 12  // Number of syncable models

/**
 * Get a tamper-resistant timestamp. Uses monotonic clock (hrtime) as primary
 * and falls back to wall clock. Detects clock manipulation by comparing
 * the wall clock delta vs monotonic delta.
 */
function _safeTimestamp() {
  const monotonicMs = Number(process.hrtime.bigint() - _monotonicStart) / 1_000_000
  const wallClockDelta = Date.now() - _wallClockAtStart
  // If wall clock went backward or drifted >10min from monotonic, prefer monotonic
  if (wallClockDelta < 0 || Math.abs(wallClockDelta - monotonicMs) > 600_000) {
    return _wallClockAtStart + Math.round(monotonicMs)
  }
  return Date.now()
}

/**
 * Persist _lastCloudContactAt to a file so it survives app restarts.
 */
function _persistCloudContact() {
  try {
    const fs = require('fs')
    const os = require('os')
    const dir = process.env.BLASTI_LOCAL_DB_DIR || path.join(os.homedir(), '.blasti', 'local')
    const filePath = path.join(dir, 'last-cloud-contact.json')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ lastCloudContactAt: _lastCloudContactAt, persistedAt: Date.now() }), 'utf-8')
  } catch (e) {
    // Non-critical — best effort
  }
}

/**
 * Restore _lastCloudContactAt from persisted file on startup.
 */
function _restoreCloudContact() {
  try {
    const fs = require('fs')
    const os = require('os')
    const dir = process.env.BLASTI_LOCAL_DB_DIR || path.join(os.homedir(), '.blasti', 'local')
    const filePath = path.join(dir, 'last-cloud-contact.json')
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      if (data && data.lastCloudContactAt) {
        _lastCloudContactAt = data.lastCloudContactAt
        _monotonicStart = process.hrtime.bigint()
        _wallClockAtStart = Date.now()
        console.log('[LocalAPI] Restored _lastCloudContactAt from disk:', new Date(_lastCloudContactAt).toISOString())
      }
    }
  } catch (e) {
    // Non-critical
  }
}

// ─── Session Persistence ──────────────────────────────────────────────────

/**
 * Get the path for the persisted session file.
 */
function _sessionFilePath() {
  const fs = require('fs')
  const os = require('os')
  const dir = process.env.BLASTI_LOCAL_DB_DIR || path.join(os.homedir(), '.blasti', 'local')
  return path.join(dir, 'session.json')
}

/**
 * Persist current session to disk so it survives Electron restarts.
 */
function persistSession() {
  if (!sessionToken || !sessionUser) return
  try {
    const fs = require('fs')
    const filePath = _sessionFilePath()
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({
      token: sessionToken,
      user: sessionUser,
      persistedAt: Date.now(),
      lastCloudContactAt: _lastCloudContactAt,
    }, null, 0), 'utf-8')
    console.log('[LocalAPI] Session persisted to disk')
  } catch (e) {
    console.warn('[LocalAPI] Failed to persist session:', e.message)
  }
}

/**
 * Load persisted session from disk (called at startup).
 * Restores sessionToken, sessionUser, and _lastCloudContactAt.
 */
function loadPersistedSession() {
  try {
    const fs = require('fs')
    const filePath = _sessionFilePath()
    if (!fs.existsSync(filePath)) return false
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (!data || !data.token || !data.user) return false
    // Don't restore sessions older than 3 days
    if (data.persistedAt && (Date.now() - data.persistedAt > OFFLINE_TOKEN_MAX_MS)) {
      console.log('[LocalAPI] Persisted session expired (>3 days old), discarding')
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      return false
    }
    sessionToken = data.token
    sessionUser = data.user
    if (data.lastCloudContactAt) {
      _lastCloudContactAt = data.lastCloudContactAt
    }
    console.log('[LocalAPI] Restored session from disk for:', data.user.username || data.user.id)
    return true
  } catch (e) {
    console.warn('[LocalAPI] Failed to load persisted session:', e.message)
    return false
  }
}

/**
 * Delete the persisted session file (called on logout).
 */
function deletePersistedSession() {
  try {
    const fs = require('fs')
    const filePath = _sessionFilePath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      console.log('[LocalAPI] Persisted session deleted')
    }
  } catch (e) {
    console.warn('[LocalAPI] Failed to delete persisted session:', e.message)
  }
}

// ─── Event Emitter (UI reactivity) ────────────────────────────────────────

/**
 * Emit a local event to all registered UI listeners.
 * @param {string} event
 * @param {object} payload
 */
function emitEvent(event, payload) {
  // Broadcast to all registered local UI listeners
  for (const cb of eventListeners) {
    try {
      cb(event, payload)
    } catch (err) {
      console.error('[LocalAPI] Event listener error:', err)
    }
  }
  // Broadcast to Socket.IO clients if available
  if (ioServer) {
    try {
      const agencyId = payload?.agencyId || (sessionUser && sessionUser.agencyId)
      if (agencyId) {
        ioServer.to(`agency:${agencyId}`).emit(event, payload)
      }
      // Also emit to a global room for admin/monitoring clients
      ioServer.emit(event, payload)
    } catch (err) {
      console.error('[LocalAPI] Socket.IO broadcast error:', err)
    }
  }
}

/**
 * Register a callback for local events.
 * @param {(event: string, payload: any) => void} callback
 * @returns {() => void} unsubscribe function
 */
function onEvent(callback) {
  eventListeners.push(callback)
  return () => {
    eventListeners = eventListeners.filter((cb) => cb !== callback)
  }
}

// ─── Socket.IO Setup ────────────────────────────────────────────────────────

/**
 * Set up Socket.IO on the given HTTP server for local realtime events.
 * If socket.io is not available, this is a no-op.
 * @param {import('http').Server} server - The HTTP server to attach Socket.IO to
 * @returns {import('socket.io').Server | null} The Socket.IO server instance, or null
 */
function setupSocketIO(server) {
  if (!socketIO || !server) {
    console.log('[LocalAPI] Socket.IO not available — realtime events are local-only')
    return null
  }
  try {
    ioServer = new socketIO.Server(server, {
      cors: {
        origin: CORS_ORIGINS,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      path: '/socket.io',
      // Reduce overhead for local-only usage
      pingInterval: 25000,
      pingTimeout: 5000,
    })

    // Client authentication middleware
    ioServer.use((socket, next) => {
      const token = socket.handshake.auth.token || socket.handshake.query.token
      if (!token || !sessionToken || !timingSafeEqual(
        Buffer.from(String(token)),
        Buffer.from(String(sessionToken))
      )) {
        return next(new Error('Authentication failed'))
      }
      next()
    })

    ioServer.on('connection', (socket) => {
      const agencyId = sessionUser?.agencyId
      if (agencyId) {
        socket.join(`agency:${agencyId}`)
      }
      console.log(`[LocalAPI] Socket.IO client connected: ${socket.id} (agency: ${agencyId || 'none'})`)

      socket.on('disconnect', () => {
        console.log(`[LocalAPI] Socket.IO client disconnected: ${socket.id}`)
      })

      // Allow clients to explicitly join an agency room
      socket.on('join:agency', (joinAgencyId, ack) => {
        if (joinAgencyId && typeof ack === 'function') {
          socket.join(`agency:${joinAgencyId}`)
          ack({ success: true })
        } else if (typeof ack === 'function') {
          ack({ success: false, error: 'agencyId required' })
        }
      })
    })

    console.log('[LocalAPI] Socket.IO realtime server attached')
    return ioServer
  } catch (err) {
    console.error('[LocalAPI] Failed to set up Socket.IO:', err)
    ioServer = null
    return null
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────

/**
 * Middleware that validates the session token and attaches user + db to context.
 */
function requireAuth() {
  return async (c, next) => {
    const token =
      c.req.header('Authorization')?.replace('Bearer ', '') ||
      c.req.header('X-Local-Token') ||
      c.req.query('token')

    if (!token) {
      return c.json({ success: false, error: 'Authentication required' }, 401)
    }

    if (!sessionToken) {
      return c.json({ success: false, error: 'No active session' }, 401)
    }

    // Critical: also check sessionUser is non-null.
    // After a Fast Refresh or app reload, the renderer rehydrates from
    // localStorage (token + user) but the IPC setLocalApiSession may not
    // have fired yet, leaving sessionToken set (from a previous import-session
    // HTTP call or IPC) but sessionUser null.
    if (!sessionUser) {
      return c.json({ success: false, error: 'No active session (user not loaded)' }, 401)
    }

    // Timing-safe comparison
    try {
      const expectedBuf = Buffer.from(sessionToken, 'utf-8')
      const providedBuf = Buffer.from(token, 'utf-8')
      if (
        expectedBuf.length !== providedBuf.length ||
        !timingSafeEqual(expectedBuf, providedBuf)
      ) {
        return c.json({ success: false, error: 'Invalid session token' }, 401)
      }
    } catch {
      return c.json({ success: false, error: 'Invalid session token' }, 401)
    }

    // Guard: if db (PrismaClient) is not initialized, no data queries can run.
    // Return 503 so the client knows to retry later rather than getting a
    // cryptic 500 from a null-pointer crash inside the route handler.
    if (!db) {
      return c.json({ success: false, error: 'Local database not ready (PrismaClient not initialized)' }, 503)
    }

    // 3-day offline token policy: if the app hasn't contacted the cloud in 3 days,
    // require re-authentication. This ensures stale offline sessions are eventually
    // refreshed. Cloud-only routes (registration, payment) are already blocked by
    // the cloud-proxy returning 503, but data routes should still force re-auth.
    // If _lastCloudContactAt is null (never had cloud contact or not yet restored),
    // allow a 24-hour grace window for local-only login, then require re-auth.
    if (_lastCloudContactAt) {
      const offlineDuration = _safeTimestamp() - _lastCloudContactAt
      if (offlineDuration > OFFLINE_TOKEN_MAX_MS) {
        return c.json({
          success: false,
          error: 'Session expired — offline for more than 3 days. Please reconnect to the internet and log in again.',
          code: 'OFFLINE_SESSION_EXPIRED',
          offlineDays: Math.floor(offlineDuration / (24 * 60 * 60 * 1000)),
        }, 401)
      }
    } else if (!sessionToken?.startsWith?.('eyJ')) {
      // No cloud contact recorded and this is a local-only session (not a JWT from cloud).
      // Allow a 24-hour grace period, then require online login.
      // JWT sessions (from cloud import-session) are exempt — they were just authenticated.
      const localLoginGrace = 24 * 60 * 60 * 1000 // 24 hours
      if (sessionUser?._loggedInAt) {
        const sinceLocalLogin = _safeTimestamp() - sessionUser._loggedInAt
        if (sinceLocalLogin > localLoginGrace) {
          return c.json({
            success: false,
            error: 'Local session expired — no cloud contact recorded. Please connect to the internet and log in.',
            code: 'OFFLINE_SESSION_EXPIRED',
          }, 401)
        }
      }
    }

    // Attach user and db to context
    c.set('user', sessionUser)
    c.set('db', db)
    await next()
  }
}

/**
 * Helper: get agencyId from session user, return 403 if missing.
 */
function requireAgencyId(c) {
  const user = c.get('user')
  const agencyId = user?.agencyId
  if (!agencyId) {
    return null
  }
  return agencyId
}

/**
 * Middleware: require active subscription for queue operations.
 * Checks the agency's subscriptionStatus in local DB.
 * Allows ACTIVE and TRIAL statuses. Blocks EXPIRED, INACTIVE, PENDING.
 * Also enforces subscriptionExpiresAt — if past, flips to EXPIRED in DB.
 */
function requireActiveSubscription() {
  return async (c, next) => {
    if (!db || !sessionUser?.agencyId) {
      // No agency or no DB — let the route handler deal with it
      await next()
      return
    }
    try {
      const agency = await db.agency.findUnique({
        where: { id: sessionUser.agencyId },
        select: { subscriptionStatus: true, subscriptionExpiresAt: true },
      })
      if (!agency) {
        await next()
        return
      }

      // Check if subscription has expired based on date
      let status = agency.subscriptionStatus
      if (agency.subscriptionExpiresAt) {
        const diffMs = new Date(agency.subscriptionExpiresAt).getTime() - Date.now()
        if (diffMs <= 0 && (status === 'ACTIVE' || status === 'TRIAL')) {
          // Subscription has expired — persist to local DB
          status = 'EXPIRED'
          await db.agency.update({
            where: { id: sessionUser.agencyId },
            data: { subscriptionStatus: 'EXPIRED' },
          }).catch(() => {})
        }
      }

      // Only ACTIVE and TRIAL can use queue features
      if (status !== 'ACTIVE' && status !== 'TRIAL') {
        return c.json({
          success: false,
          error: 'An active subscription is required to use queue features',
          subscriptionStatus: status,
        }, 403)
      }

      await next()
    } catch (err) {
      // On error, allow the request through — don't block on subscription check failure
      console.error('[LocalAPI] Subscription check error:', err.message)
      await next()
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function parsePagination(c) {
  return {
    take: Math.min(parseInt(c.req.query('take') || '50', 10), 200),
    skip: parseInt(c.req.query('skip') || '0', 10),
  }
}

function todayStartMs() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function todayEndMs() {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d
}

// ─── Offline Mutation Queue (write-ahead log) ───────────────────────────

/**
 * Create the _pending_mutations table if it doesn't exist.
 */
async function ensurePendingMutationsTable() {
  if (!db) return
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_pending_mutations" (' +
      '"id" TEXT PRIMARY KEY,' +
      '"method" TEXT NOT NULL,' +
      '"path" TEXT NOT NULL,' +
      '"body" TEXT,' +
      '"headers" TEXT,' +
      '"idempotency_key" TEXT,' +
      '"status" TEXT NOT NULL DEFAULT \'pending\',' +
      '"attempts" INTEGER NOT NULL DEFAULT 0,' +
      '"max_attempts" INTEGER NOT NULL DEFAULT 5,' +
      '"created_at" INTEGER NOT NULL,' +
      '"last_attempt_at" INTEGER,' +
      '"last_error" TEXT,' +
      '"response_data" TEXT' +
      ')'
    )
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_pending_mutations_status" ON "_pending_mutations"("status")'
    )
    await db.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_pending_mutations_idempotency" ON "_pending_mutations"("idempotency_key") WHERE "idempotency_key" IS NOT NULL'
    ).catch(() => {}) // Ignore if already exists
  } catch (e) {
    console.error('[LocalAPI] Failed to create _pending_mutations table:', e.message)
  }
}

/**
 * Log a mutation to the pending queue.
 * Called by write handlers (POST/PUT/PATCH/DELETE) when cloud is unreachable.
 */
async function logPendingMutation(method, path, body, responseData, idempotencyKey) {
  if (!db) return
  try {
    await ensurePendingMutationsTable()
    const id = require('crypto').randomUUID()
    // Generate idempotency key for POST creates to prevent duplicates on replay
    const iKey = idempotencyKey || (method === 'POST' ? `${method}:${path}:${id}` : null)
    await db.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "_pending_mutations" (id, method, path, body, idempotency_key, status, created_at, response_data) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?)',
      id,
      method,
      path,
      body ? JSON.stringify(body) : null,
      iKey,
      Date.now(),
      responseData ? JSON.stringify(responseData) : null
    )
    console.log('[LocalAPI] Logged pending mutation:', method, path)
  } catch (e) {
    console.error('[LocalAPI] Failed to log pending mutation:', e.message)
  }
}

/**
 * Get all pending mutations (for sync service to replay).
 */
async function getPendingMutations() {
  if (!db) return []
  try {
    await ensurePendingMutationsTable()
    const rows = await db.$queryRawUnsafe(
      'SELECT * FROM "_pending_mutations" WHERE status = \'pending\' ORDER BY created_at ASC LIMIT 100'
    )
    return (rows || []).map(row => ({
      ...row,
      body: row.body ? JSON.parse(row.body) : null,
      responseData: row.response_data ? JSON.parse(row.response_data) : null,
    }))
  } catch (e) {
    console.error('[LocalAPI] Failed to get pending mutations:', e.message)
    return []
  }
}

/**
 * Mark a mutation as completed (successfully synced to cloud).
 */
async function markMutationCompleted(id) {
  if (!db) return
  try {
    await db.$executeRawUnsafe(
      'UPDATE "_pending_mutations" SET status = \'completed\' WHERE id = ?', id
    )
  } catch (e) {
    console.error('[LocalAPI] Failed to mark mutation completed:', e.message)
  }
}

/**
 * Mark a mutation as failed (will be retried on next sync).
 */
async function markMutationFailed(id, error) {
  if (!db) return
  try {
    await db.$executeRawUnsafe(
      'UPDATE "_pending_mutations" SET status = \'failed\', attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ? AND attempts < max_attempts',
      Date.now(),
      String(error || '').substring(0, 500),
      id
    )
    // If max attempts reached, mark as permanently failed
    await db.$executeRawUnsafe(
      'UPDATE "_pending_mutations" SET status = \'abandoned\' WHERE id = ? AND attempts >= max_attempts', id
    )
  } catch (e) {
    console.error('[LocalAPI] Failed to mark mutation failed:', e.message)
  }
}

// ─── Create Hono App ─────────────────────────────────────────────────────

function createApp() {
  const app = new Hono()

  // CORS — localhost only
  app.use(
    '*',
    cors({
      origin: CORS_ORIGINS,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Local-Token'],
      credentials: true,
      maxAge: 86400,
    }),
  )

  // ═══════════════════════════════════════════════════════════════════════
  // 1. HEALTH / DISCOVERY (no auth)
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      mode: 'local',
      uptime: Math.floor(process.uptime()),
      dbReady: !!db,
    })
  })

  // Alias: /api/health (used by loading-screen diagnostics probe)
  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      mode: 'local',
      uptime: Math.floor(process.uptime()),
      dbReady: !!db,
    })
  })

  app.get('/api/discover', (c) => {
    return c.json({
      service: 'blasti-local',
      version: '1.0.0',
      mode: 'local-first',
      port: DEFAULT_PORT,
      apiPort: DEFAULT_PORT,
      webPort: 3000,
      capabilities: [
        'auth',
        'agency',
        'services',
        'branches',
        'counters',
        'staff',
        'reservations',
        'queue',
        'notifications',
        'user',
        'settings',
        'sync',
      ],
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 2. AUTH (no auth)
  // ═══════════════════════════════════════════════════════════════════════

  app.post('/api/auth/login', async (c) => {
    try {
      const body = await c.req.json()
      const { username, password } = body

      if (!username || !password) {
        return c.json({ success: false, error: 'Username and password required' }, 400)
      }

      // ══════════════════════════════════════════════════════════════════
      // CLOUD-FIRST LOGIN ARCHITECTURE
      //
      // 1. When ONLINE: Authenticate against cloud API first.
      //    - Cloud login succeeds → cache password hash locally (bcrypt),
      //      import session, start sync, return success.
      //    - Cloud login fails (401) → return error immediately (bad creds).
      //
      // 2. When OFFLINE: Fall back to locally cached credentials.
      //    - User must have logged in at least once while online.
      //    - Password hash is stored as real bcrypt (not placeholder).
      //    - Must be within 3-day offline window (_lastCloudContactAt).
      //    - If offline > 3 days → require online re-auth.
      //
      // 3. First run (no local users): Must be online.
      // ══════════════════════════════════════════════════════════════════

      const cloudUrl = getCloudUrl()

      // ── Step 0: Cloud health check — skip cloud login if API is unreachable ──
      let cloudHealthy = false
      try {
        const healthResp = await fetch(`${cloudUrl}/health`, {
          signal: AbortSignal.timeout(5000),
        })
        cloudHealthy = healthResp.ok
        if (!cloudHealthy) {
          console.warn('[LocalAPI] Cloud API health check failed (status', healthResp.status, ') at', cloudUrl, '— skipping cloud login')
        }
      } catch (healthErr) {
        console.warn('[LocalAPI] Cloud API unreachable at', cloudUrl, '— skipping cloud login, falling back to offline:', healthErr.message)
      }

      // ── Step 1: Try cloud API first (when online and healthy) ────────
      let cloudLoginSucceeded = false
      let cloudUser = null
      let cloudToken = null

      if (cloudHealthy) {
        try {
          console.log('[LocalAPI] Trying cloud login for:', username)
          const cloudResp = await fetch(`${cloudUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
            signal: AbortSignal.timeout(15000),
          })

          if (cloudResp.ok) {
            const cloudData = await cloudResp.json()
            cloudUser = cloudData.user || cloudData.data?.user
            cloudToken = cloudData.token || cloudData.accessToken

            if (cloudUser && cloudToken) {
              cloudLoginSucceeded = true
              console.log('[LocalAPI] Cloud login successful for:', cloudUser.username || cloudUser.email || username)
            }
          } else if (cloudResp.status === 401 || cloudResp.status === 403) {
            // Cloud rejected credentials — don't try local fallback
            const errBody = await cloudResp.json().catch(() => ({}))
            console.log('[LocalAPI] Cloud rejected credentials:', cloudResp.status, errBody.error || '')
            return c.json({ success: false, error: errBody.error || 'Invalid username or password' }, cloudResp.status)
          } else if (cloudResp.status === 404) {
            // Cloud API endpoint not found — likely wrong URL (e.g. Next.js frontend instead of API)
            console.error(`[LocalAPI] Cloud API endpoint not found at ${cloudUrl}/api/auth/login — check BLASTI_CLOUD_URL/BLASTI_API_URL environment variables. Falling back to offline login.`)
          } else {
            // Cloud returned unexpected status (5xx, etc.) — fall through to offline
            const errBody = await cloudResp.json().catch(() => ({}))
            console.warn('[LocalAPI] Cloud returned unexpected status:', cloudResp.status, errBody.error || '')
          }
        } catch (cloudErr) {
          // Cloud unreachable (network error) — fall through to offline login
          console.warn('[LocalAPI] Cloud unreachable, falling back to offline login:', cloudErr.message)
        }
      }

      // ── Step 2: Cloud login succeeded — import session & cache creds ────
      if (cloudLoginSucceeded && cloudUser && cloudToken) {
        // Hash the password for offline re-login capability
        // Try bcryptjs first, then fall back to Node crypto.scryptSync
        let bcryptHash = null
        try {
          let bcrypt = null
          try { bcrypt = require('bcryptjs') } catch { /* try alternate paths */ }
          if (!bcrypt) {
            try { bcrypt = require(require('path').join(process.cwd(), 'node_modules', 'bcryptjs')) } catch { /* nope */ }
          }
          if (!bcrypt) {
            try { bcrypt = require(require('path').join(__dirname, '..', 'node_modules', 'bcryptjs')) } catch { /* nope */ }
          }
          if (bcrypt) {
            bcryptHash = await bcrypt.hash(password, 10)
          } else {
            // Fallback: use Node built-in scrypt to produce a bcrypt-like hash string
            const { scryptSync } = require('crypto')
            const salt = require('crypto').randomBytes(16).toString('base64')
            const derived = scryptSync(password, salt, 64).toString('base64')
            bcryptHash = `$scrypt$${salt}$${derived}`
            console.log('[LocalAPI] bcryptjs unavailable — using scrypt fallback for password hash')
          }
        } catch (e) {
          // Last resort: SHA256 hash (better than nothing for offline re-login)
          console.warn('[LocalAPI] bcrypt and scrypt failed, using SHA256 fallback:', e.message)
          bcryptHash = require('crypto').createHash('sha256').update(password).digest('hex')
        }

        // Upsert user into local SQLite with REAL bcrypt hash
        try {
          const existingUser = await db.user.findUnique({ where: { id: cloudUser.id } }).catch(() => null)
          const userData = {
            id: cloudUser.id,
            username: cloudUser.username || cloudUser.email || username,
            fullName: cloudUser.fullName || cloudUser.name || '',
            email: cloudUser.email || null,
            role: cloudUser.role || 'CUSTOMER',
            language: cloudUser.language || 'ar',
            avatarUrl: cloudUser.avatarUrl || null,
            isActive: cloudUser.isActive !== false,
            passwordHash: bcryptHash, // Real bcrypt hash for offline re-login!
          }

          if (existingUser) {
            await db.user.update({ where: { id: cloudUser.id }, data: userData })
          } else {
            await db.user.create({ data: userData }).catch(e => {
              console.warn('[LocalAPI] Could not create user in local DB:', e.message)
            })
          }
        } catch (e) {
          console.warn('[LocalAPI] Could not upsert user from cloud:', e.message)
        }

        // Create local session
        const sessionData = {
          id: cloudUser.id,
          username: cloudUser.username || cloudUser.email || username,
          fullName: cloudUser.fullName || cloudUser.name || '',
          role: cloudUser.role || 'CUSTOMER',
          language: cloudUser.language || 'ar',
          avatarUrl: cloudUser.avatarUrl || null,
          agencyId: cloudUser.agencyId || null,
          _loggedInAt: Date.now(),
        }
        sessionToken = cloudToken
        sessionUser = sessionData

        // Mark cloud contact for offline token policy
        _lastCloudContactAt = _safeTimestamp()
        _persistCloudContact()
        persistSession()

        emitEvent('auth:login', { user: sessionData })

        // Trigger initial sync in background to pull agency data
        try {
          const syncService = require('./sync-service')
          if (!syncService.getStatus()?.isStarted) {
            const { localDb } = require('./lib/db')
            if (localDb) {
              syncService.startSync({
                localDb,
                cloudBaseUrl: cloudUrl,
                agencyId: sessionData.agencyId || '',
              })
            }
          }
          syncService.setAuth(cloudToken, cloudUser)
          syncService.initialSync().catch(e => {
            console.warn('[LocalAPI] Background initial sync error:', e.message)
          })
        } catch (e) {
          console.warn('[LocalAPI] Could not start sync after cloud login:', e.message)
        }

        return c.json({
          success: true,
          user: sessionData,
          token: sessionToken,
          source: 'cloud',
        })
      }

      // ── Step 3: Cloud was unreachable — try offline re-login ───────────
      console.log('[LocalAPI] Cloud unreachable — trying offline login for:', username)

      // Check offline window: must have contacted cloud within 3 days
      if (_lastCloudContactAt) {
        const offlineDuration = _safeTimestamp() - _lastCloudContactAt
        if (offlineDuration > OFFLINE_TOKEN_MAX_MS) {
          const offlineDays = Math.floor(offlineDuration / (24 * 60 * 60 * 1000))
          return c.json({
            success: false,
            error: `Offline for ${offlineDays} days. Please connect to the internet and log in again.`,
            code: 'OFFLINE_SESSION_EXPIRED',
            offlineDays,
          }, 401)
        }
      } else {
        // Never had cloud contact — must be online for first login
        return c.json({
          success: false,
          error: 'No cached session found. Please connect to the internet to log in for the first time.',
          code: 'NO_CACHED_SESSION',
        }, 401)
      }

      // Find user in local DB and verify password
      const user = await db.user.findUnique({ where: { username } })
      if (!user) {
        return c.json({ success: false, error: 'Invalid username or password' }, 401)
      }

      if (!user.isActive) {
        return c.json({ success: false, error: 'Account is deactivated' }, 403)
      }

      // Verify password against locally cached hash
      let localAuthOk = false

      if (!user.passwordHash) {
        return c.json({ success: false, error: 'Invalid username or password' }, 401)
      }

      // Strategy 1: bcrypt compare (cloud-cached passwords are bcrypt $2a$/$2b$)
      if (user.passwordHash.startsWith('$2')) {
        try {
          let bcrypt = null
          try { bcrypt = require('bcryptjs') } catch { /* try alternate paths */ }
          if (!bcrypt) {
            try { bcrypt = require(require('path').join(process.cwd(), 'node_modules', 'bcryptjs')) } catch { /* nope */ }
          }
          if (!bcrypt) {
            try { bcrypt = require(require('path').join(__dirname, '..', 'node_modules', 'bcryptjs')) } catch { /* nope */ }
          }
          if (bcrypt && await bcrypt.compare(password, user.passwordHash)) {
            localAuthOk = true
          }
        } catch { /* bcrypt not available */ }
      }

      // Strategy 2: scrypt verify ($scrypt$ format written by our fallback)
      if (!localAuthOk && user.passwordHash.startsWith('$scrypt$')) {
        try {
          const { scryptSync } = require('crypto')
          const parts = user.passwordHash.split('$')
          // Format: $scrypt$<salt>$<derived>
          if (parts.length >= 4) {
            const salt = parts[2]
            const storedDerived = parts[3]
            const derived = scryptSync(password, salt, 64).toString('base64')
            const storedBuf = Buffer.from(storedDerived, 'utf-8')
            const inputBuf = Buffer.from(derived, 'utf-8')
            if (storedBuf.length === inputBuf.length && timingSafeEqual(storedBuf, inputBuf)) {
              localAuthOk = true
            }
          }
        } catch { /* scrypt verify failed */ }
      }

      // Strategy 3: SHA256 compare (for locally created users or last-resort hash)
      if (!localAuthOk) {
        const inputHash = require('crypto')
          .createHash('sha256')
          .update(password)
          .digest('hex')
        try {
          const storedBuf = Buffer.from(user.passwordHash, 'utf-8')
          const inputBuf = Buffer.from(inputHash, 'utf-8')
          if (storedBuf.length === inputBuf.length && timingSafeEqual(storedBuf, inputBuf)) {
            localAuthOk = true
          }
        } catch { /* comparison failed */ }
      }

      if (!localAuthOk) {
        return c.json({ success: false, error: 'Invalid username or password' }, 401)
      }

      // Offline login succeeded — create local session
      const sessionData = {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        language: user.language || 'ar',
        avatarUrl: user.avatarUrl || null,
        agencyId: null,
        _loggedInAt: Date.now(),
      }

      // Look up agencyId from agency-staff membership
      if (user.role === 'AGENCY_OWNER' || user.role === 'AGENCY_STAFF') {
        const staff = await db.agencyStaff.findFirst({
          where: { userId: user.id, isActive: true },
        })
        if (staff) sessionData.agencyId = staff.agencyId
      } else if (user.role === 'SUPER_ADMIN') {
        const agency = await db.agency.findFirst({ select: { id: true } })
        if (agency) sessionData.agencyId = agency.id
      }

      sessionToken = randomBytes(32).toString('hex')
      sessionUser = sessionData
      persistSession()

      emitEvent('auth:login', { user: sessionData })

      return c.json({
        success: true,
        user: sessionData,
        token: sessionToken,
        source: 'offline',
        offlineWarning: 'Logged in offline — some features may be limited',
      })
    } catch (error) {
      console.error('[LocalAPI] Login error:', error)
      return c.json({ success: false, error: 'Login failed' }, 500)
    }
  })

  app.get('/api/auth/session', (c) => {
    if (!sessionUser) {
      return c.json({ success: false, error: 'No active session' }, 401)
    }
    // Return in NextAuth-compatible format (same as cloud API)
    // Include offline token status for the frontend to act on
    const offlineDuration = _lastCloudContactAt ? _safeTimestamp() - _lastCloudContactAt : null
    const offlineDays = offlineDuration ? Math.floor(offlineDuration / (24 * 60 * 60 * 1000)) : null
    const offlineTokenRemaining = _lastCloudContactAt
      ? Math.max(0, OFFLINE_TOKEN_MAX_MS - offlineDuration)
      : null
    return c.json({
      user: {
        id: sessionUser.id,
        username: sessionUser.username,
        fullName: sessionUser.fullName,
        role: sessionUser.role,
        language: sessionUser.language,
        avatarUrl: sessionUser.avatarUrl,
        agencyId: sessionUser.agencyId,
      },
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      offline: {
        lastCloudContact: _lastCloudContactAt,
        offlineDays,
        offlineTokenRemainingMs: offlineTokenRemaining,
        offlineTokenMaxMs: OFFLINE_TOKEN_MAX_MS,
        isExpiringSoon: offlineTokenRemaining !== null && offlineTokenRemaining < 24 * 60 * 60 * 1000, // < 1 day remaining
      },
    })
  })

  app.post('/api/auth/logout', (c) => {
    const previousUser = sessionUser
    sessionToken = null
    sessionUser = null
    deletePersistedSession()
    emitEvent('auth:logout', { previousUser })
    return c.json({ success: true, data: { message: 'Logged out' } })
  })

  // ── Password Reset (Cloud-Only) ─────────────────────────────────────────
  // Password reset ALWAYS requires cloud connectivity.
  // These routes proxy to the cloud API and return errors if offline.

  app.post('/api/auth/forgot-password', async (c) => {
    const cloudUrl = getCloudUrl()

    try {
      const body = await c.req.json()
      console.log('[LocalAPI] Proxying forgot-password to cloud')
      const cloudResp = await fetch(`${cloudUrl}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      const cloudData = await cloudResp.json()
      return c.json(cloudData, cloudResp.status)
    } catch (e) {
      return c.json({
        success: false,
        error: 'Password reset requires an internet connection. Please check your network and try again.',
        code: 'CLOUD_REQUIRED',
      }, 503)
    }
  })

  app.post('/api/auth/reset-password', async (c) => {
    const cloudUrl = getCloudUrl()

    try {
      const body = await c.req.json()
      console.log('[LocalAPI] Proxying reset-password to cloud')
      const cloudResp = await fetch(`${cloudUrl}/api/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      const cloudData = await cloudResp.json()

      // If reset succeeded, also update the local password hash
      if (cloudResp.ok && cloudData.success && body.newPassword && sessionUser) {
        try {
          const bcrypt = require('bcryptjs')
          const newHash = await bcrypt.hash(body.newPassword, 10)
          await db.user.update({
            where: { id: sessionUser.id },
            data: { passwordHash: newHash },
          })
          console.log('[LocalAPI] Local password hash updated after cloud reset')
        } catch (updateErr) {
          console.warn('[LocalAPI] Could not update local password hash after reset:', updateErr.message)
        }
      }

      return c.json(cloudData, cloudResp.status)
    } catch (e) {
      return c.json({
        success: false,
        error: 'Password reset requires an internet connection. Please check your network and try again.',
        code: 'CLOUD_REQUIRED',
      }, 503)
    }
  })

  app.get('/api/auth/check-username', async (c) => {
    const cloudUrl = getCloudUrl()

    try {
      const username = c.req.query('username')
      console.log('[LocalAPI] Proxying check-username to cloud')
      const cloudResp = await fetch(`${cloudUrl}/api/auth/check-username?username=${encodeURIComponent(username || '')}`, {
        signal: AbortSignal.timeout(5000),
      })
      const cloudData = await cloudResp.json()
      return c.json(cloudData, cloudResp.status)
    } catch (e) {
      // Offline fallback: check local DB
      try {
        const username = c.req.query('username')
        if (!username || username.length < 3) return c.json({ available: true })
        const existing = await db.user.findUnique({ where: { username }, select: { id: true } })
        return c.json({ available: !existing })
      } catch {
        return c.json({ available: true })
      }
    }
  })

  /**
   * Import a cloud session into the local API.
   * Called by the renderer after cloud login to create a local session
   * that uses the same token, so LAN failover works seamlessly.
   *
   * This is critical for offline mode:
   * 1. User logs in via cloud API (gets cloud JWT + user data)
   * 2. Renderer calls this endpoint with the cloud token + user
   * 3. Local API creates a session with the SAME token
   * 4. When cloud goes down, LAN failover sends the same Bearer token
   * 5. Local API validates it → request succeeds
   *
   * Body: { token: string, user: { id, username, fullName, role, agencyId, language, avatarUrl } }
   */
  app.post('/api/auth/import-session', async (c) => {
    try {
      const body = c.req.json ? c.req.json.bind(c.req) : async () => ({})

      // Hono may have already parsed the body; handle both cases
      let data
      try {
        data = typeof body === 'function' ? await body() : body
      } catch {
        data = {}
      }

      const { token, user } = data

      if (!token || !user || !user.id) {
        return c.json({ success: false, error: 'Token and user required' }, 400)
      }

      // Set session with the CLOUD token (so LAN failover works with the same token)
      sessionToken = token
      sessionUser = {
        id: user.id,
        username: user.username || user.email || 'imported',
        fullName: user.fullName || user.name || '',
        role: user.role || 'CUSTOMER',
        language: user.language || 'ar',
        avatarUrl: user.avatarUrl || null,
        agencyId: user.agencyId || null,
        _loggedInAt: Date.now(),
      }

      console.log('[LocalAPI] Session imported from cloud:', sessionUser.username, 'role:', sessionUser.role)
      emitEvent('auth:login', { user: sessionUser })

      // Mark that we had cloud contact (import-session is called after cloud login)
      _lastCloudContactAt = _safeTimestamp()
      _persistCloudContact()
      persistSession()

      return c.json({
        success: true,
        user: sessionUser,
        token: sessionToken,
      })
    } catch (error) {
      console.error('[LocalAPI] Import session error:', error)
      return c.json({ success: false, error: 'Import failed' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // ALL ROUTES BELOW REQUIRE AUTH
  // ═══════════════════════════════════════════════════════════════════════

  const authMiddleware = requireAuth()

  // ═══════════════════════════════════════════════════════════════════════
  // CLOUD-ONLY STUBS — return 200 with available:false so the dashboard
  // knows the feature exists but requires a cloud connection, instead of
  // letting the request fall through to a 404 (which would incorrectly
  // mark the app as fully offline).
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/api/agency/no-show-analytics', authMiddleware, async (c) => {
    const agencyId = requireAgencyId(c)
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const periodDays = parseInt(c.req.query('period') || '30', 10)
    const periodAgo = new Date(Date.now() - periodDays * 86400000).toISOString()

    try {
      const [summaryRows, dailyRows, serviceRows, hourlyRows] = await Promise.all([
        db.$queryRawUnsafe(`
          SELECT
            COUNT(*) as totalReservations,
            SUM(CASE WHEN status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows,
            SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
            SUM(CASE WHEN status = 'NO_SHOW' AND skippedForNoShow = 1 AND reclaimRequestedAt IS NOT NULL THEN 1 ELSE 0 END) as reclaimedNoShows
          FROM Reservation
          WHERE agencyId = ? AND joinedAt >= ?
        `, agencyId, periodAgo),
        db.$queryRawUnsafe(`
          SELECT
            DATE(joinedAt) as date,
            COUNT(*) as total,
            SUM(CASE WHEN status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows
          FROM Reservation
          WHERE agencyId = ? AND joinedAt >= ?
          GROUP BY DATE(joinedAt)
          ORDER BY date ASC
        `, agencyId, periodAgo),
        db.$queryRawUnsafe(`
          SELECT
            r.serviceId,
            s.name as serviceName,
            COUNT(*) as total,
            SUM(CASE WHEN r.status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows
          FROM Reservation r
          LEFT JOIN Service s ON r.serviceId = s.id
          WHERE r.agencyId = ? AND r.joinedAt >= ?
          GROUP BY r.serviceId, s.name
          ORDER BY noShows DESC
          LIMIT 10
        `, agencyId, periodAgo),
        db.$queryRawUnsafe(`
          SELECT
            CAST(strftime('%H', joinedAt) AS INTEGER) as hour,
            COUNT(*) as total,
            SUM(CASE WHEN status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows
          FROM Reservation
          WHERE agencyId = ? AND joinedAt >= ?
          GROUP BY hour
          ORDER BY hour ASC
        `, agencyId, periodAgo),
      ])

      const s = summaryRows[0]
      const totalReservations = Number(s.totalReservations)
      const noShows = Number(s.noShows)
      const cancelled = Number(s.cancelled)
      const reclaimedNoShows = Number(s.reclaimedNoShows)

      return c.json({
        success: true,
        analytics: {
          summary: {
            totalReservations,
            noShows,
            cancelled,
            noShowRate: totalReservations > 0 ? Math.round((noShows / totalReservations) * 100) : 0,
            cancelRate: totalReservations > 0 ? Math.round((cancelled / totalReservations) * 100) : 0,
            reclaimedNoShows,
            reclaimRate: noShows > 0 ? Math.round((reclaimedNoShows / noShows) * 100) : 0,
          },
          dailyTrend: dailyRows.map((d) => ({
            date: d.date,
            total: Number(d.total),
            noShows: Number(d.noShows),
            rate: Number(d.total) > 0 ? Math.round((Number(d.noShows) / Number(d.total)) * 100) : 0,
          })),
          byService: serviceRows.map((sv) => ({
            serviceId: sv.serviceId,
            serviceName: sv.serviceName || 'Unknown',
            total: Number(sv.total),
            noShows: Number(sv.noShows),
            rate: Number(sv.total) > 0 ? Math.round((Number(sv.noShows) / Number(sv.total)) * 100) : 0,
          })),
          byHour: hourlyRows.map((h) => ({
            hour: Number(h.hour),
            total: Number(h.total),
            noShows: Number(h.noShows),
            rate: Number(h.total) > 0 ? Math.round((Number(h.noShows) / Number(h.total)) * 100) : 0,
          })),
        },
      })
    } catch (err) {
      console.error('[LocalAPI] no-show-analytics error:', err)
      return c.json({ success: true, analytics: { summary: { totalReservations: 0, noShows: 0, cancelled: 0, noShowRate: 0, cancelRate: 0, reclaimedNoShows: 0, reclaimRate: 0 }, dailyTrend: [], byService: [], byHour: [] } })
    }
  })

  app.get('/api/agency/peak-hours', authMiddleware, async (c) => {
    const agencyId = requireAgencyId(c)
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

    try {
      const [hourlyRows, weekdayRows, serviceRows, dailyRows] = await Promise.all([
        db.$queryRawUnsafe(`
          SELECT
            CAST(strftime('%H', joinedAt) AS INTEGER) as hour,
            COUNT(*) as count,
            COALESCE(AVG(estimatedWait), 0) as avgWait
          FROM Reservation
          WHERE agencyId = ? AND joinedAt >= ?
          GROUP BY hour
          ORDER BY hour ASC
        `, agencyId, thirtyDaysAgo),
        db.$queryRawUnsafe(`
          SELECT
            CAST(strftime('%w', joinedAt) AS INTEGER) as weekday,
            COUNT(*) as count,
            COALESCE(AVG(estimatedWait), 0) as avgWait
          FROM Reservation
          WHERE agencyId = ? AND joinedAt >= ?
          GROUP BY weekday
          ORDER BY weekday ASC
        `, agencyId, thirtyDaysAgo),
        db.$queryRawUnsafe(`
          SELECT
            r.serviceId,
            s.name as serviceName,
            CAST(strftime('%H', r.joinedAt) AS INTEGER) as peakHour,
            COUNT(*) as count
          FROM Reservation r
          LEFT JOIN Service s ON r.serviceId = s.id
          WHERE r.agencyId = ? AND r.joinedAt >= ?
          GROUP BY r.serviceId, s.name, peakHour
          ORDER BY r.serviceId, count DESC
        `, agencyId, thirtyDaysAgo),
        db.$queryRawUnsafe(`
          SELECT
            DATE(joinedAt) as date,
            COALESCE(AVG(estimatedWait), 0) as avgWait,
            COUNT(*) as count
          FROM Reservation
          WHERE agencyId = ? AND joinedAt >= ?
          GROUP BY DATE(joinedAt)
          ORDER BY date ASC
        `, agencyId, thirtyDaysAgo),
      ])

      const hourlyDemand = hourlyRows
        .map((h) => ({ hour: Number(h.hour), count: Number(h.count), avgWait: Math.round(Number(h.avgWait)) }))
        .sort((a, b) => b.count - a.count)

      const peakHours = hourlyDemand.slice(0, 3)

      const weekdayDemand = weekdayRows.map((d) => ({
        weekday: Number(d.weekday),
        name: weekdayNames[Number(d.weekday)],
        count: Number(d.count),
        avgWait: Math.round(Number(d.avgWait)),
      }))

      const busiestDay = weekdayDemand.length > 0
        ? [...weekdayDemand].sort((a, b) => b.count - a.count)[0]
        : null

      return c.json({
        success: true,
        analytics: {
          peakHours,
          busiestDay,
          hourlyDemand: hourlyRows.map((h) => ({
            hour: Number(h.hour),
            count: Number(h.count),
            avgWait: Math.round(Number(h.avgWait)),
          })),
          weekdayDemand,
          servicePeakHours: serviceRows.map((sv) => ({
            serviceId: sv.serviceId,
            serviceName: sv.serviceName || 'Unknown',
            peakHour: Number(sv.peakHour),
            count: Number(sv.count),
          })),
          dailyWaitTrend: dailyRows.map((d) => ({
            date: d.date,
            avgWait: Math.round(Number(d.avgWait)),
            count: Number(d.count),
          })),
        },
      })
    } catch (err) {
      console.error('[LocalAPI] peak-hours error:', err)
      return c.json({ success: true, analytics: { peakHours: [], busiestDay: null, hourlyDemand: [], weekdayDemand: [], servicePeakHours: [], dailyWaitTrend: [] } })
    }
  })

  // NOTE: /api/admin/announcements moved to /api/agency/announcements (line ~3230)
  // The /api/admin/ prefix is not allowed per security policy (NO admin endpoints).

  // ═══════════════════════════════════════════════════════════════════════
  // 3. AGENCY (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/profile — current agency with stats
  app.get('/api/agency/profile', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const agency = await db.agency.findUnique({ where: { id: agencyId } })
      if (!agency) {
        // Agency record not yet synced to local DB.
        // Return a minimal profile using sessionUser data so the dashboard
        // doesn't break. The profile will be fully populated after sync.
        console.log(`[LocalAPI] Agency ${agencyId} not in local DB, returning session-based fallback`)
        return c.json({
          id: agencyId,
          name: sessionUser.fullName || 'Unknown Agency',
          _partial: true,
          _reason: 'Agency not yet synced to local database',
        })
      }

      const [serviceCount, staffCount, branchCount, branchIds] = await Promise.all([
        db.service.count({ where: { agencyId, isActive: true } }),
        db.agencyStaff.count({ where: { agencyId, isActive: true } }),
        db.branch.count({ where: { agencyId, isActive: true } }),
        db.branch.findMany({ where: { agencyId }, select: { id: true } }),
      ])
      const counterCount = branchIds.length > 0
        ? await db.counter.count({ where: { branchId: { in: branchIds.map(b => b.id) }, isActive: true } })
        : 0

      // Remove sensitive fields and include computed stats
      const { passwordHash, ...safeAgency } = agency

      return c.json({
        ...safeAgency,
        code: agency.customCode,
        // Include computed stats that were previously wasted
        _stats: { serviceCount, staffCount, branchCount, counterCount },
      })
    } catch (error) {
      console.error('[LocalAPI] Agency profile error:', error)
      return c.json({ success: false, error: 'Failed to load agency profile' }, 500)
    }
  })

  // GET /api/agency/dashboard — today's stats
  app.get('/api/agency/dashboard', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const startMs = todayStartMs()
      const endMs = todayEndMs()

      const [
        totalToday,
        waiting,
        serving,
        completed,
        noShow,
        cancelled,
        queueSettings,
        activeCounters,
        recentReservations,
      ] = await Promise.all([
        db.reservation.count({
          where: { agencyId, joinedAt: { gte: startMs, lte: endMs } },
        }),
        db.reservation.count({ where: { agencyId, status: 'WAITING' } }),
        db.reservation.count({
          where: { agencyId, status: { in: ['CALLED', 'SERVING'] } },
        }),
        db.reservation.count({
          where: { agencyId, status: 'COMPLETED', completedAt: { gte: startMs } },
        }),
        db.reservation.count({
          where: { agencyId, status: 'NO_SHOW', skippedAt: { gte: startMs } },
        }),
        db.reservation.count({
          where: { agencyId, status: 'CANCELLED', cancelledAt: { gte: startMs } },
        }),
        // Queue settings for currentServingNumber
        db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null),
        // Active counters with their current reservations
        db.counter.findMany({
          where: { agencyId, isActive: true },
          include: {
            reservations: {
              where: { status: { in: ['CALLED', 'SERVING'] } },
              take: 1,
              orderBy: { calledAt: 'desc' },
            },
          },
          orderBy: { number: 'asc' },
        }).catch(() => []),
        // Recent activity (last 5 completed/changed reservations today)
        db.reservation.findMany({
          where: { agencyId, joinedAt: { gte: startMs } },
          orderBy: { updatedAt: 'desc' },
          take: 5,
          select: {
            id: true,
            queueNumber: true,
            displayNumber: true,
            status: true,
            walkInCustomerName: true,
            serviceId: true,
            joinedAt: true,
            calledAt: true,
            completedAt: true,
            updatedAt: true,
            estimatedWait: true,
          },
        }).catch(() => []),
      ])

      // Average wait time today
      const avgWaitResult = completed > 0
        ? await db.reservation.aggregate({
            where: { agencyId, status: 'COMPLETED', completedAt: { gte: startMs } },
            _avg: { estimatedWait: true },
          }).catch(() => ({ _avg: { estimatedWait: 0 } }))
        : { _avg: { estimatedWait: 0 } }
      const averageWaitMinutes = Math.round(avgWaitResult._avg.estimatedWait || 0)

      // Estimated wait for next in queue
      // Based on average service time of completed reservations today
      let estimatedWaitForNext = 0
      if (waiting > 0) {
        const avgServiceResult = await db.reservation.aggregate({
          where: { agencyId, status: 'COMPLETED', completedAt: { gte: startMs }, calledAt: { not: null } },
          _avg: { estimatedWait: true },
        }).catch(() => ({ _avg: { estimatedWait: 0 } }))
        const avgServiceMinutes = avgServiceResult._avg.estimatedWait || 5 // default 5 min
        estimatedWaitForNext = Math.round(waiting * avgServiceMinutes)
      }

      // Build recent activity events
      const serviceIds = new Set(recentReservations.map((r) => r.serviceId).filter(Boolean))
      const serviceList = serviceIds.size > 0
        ? await db.service.findMany({ where: { id: { in: [...serviceIds] } } }).catch(() => [])
        : []
      const serviceMap = new Map(serviceList.map((s) => [s.id, s]))
      const recentActivity = recentReservations.map((r) => ({
        id: r.id,
        queueNumber: r.queueNumber,
        displayNumber: r.displayNumber || String(r.queueNumber),
        status: r.status,
        customerName: r.walkInCustomerName || 'Walk-in',
        serviceName: serviceMap.get(r.serviceId)?.name || null,
        joinedAt: r.joinedAt instanceof Date ? r.joinedAt.toISOString() : (r.joinedAt ? String(r.joinedAt) : null),
        calledAt: r.calledAt instanceof Date ? r.calledAt.toISOString() : (r.calledAt ? String(r.calledAt) : null),
        completedAt: r.completedAt instanceof Date ? r.completedAt.toISOString() : (r.completedAt ? String(r.completedAt) : null),
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : (r.updatedAt ? String(r.updatedAt) : null),
      }))

      // Format active counters
      const counters = activeCounters.map((c) => ({
        id: c.id,
        number: c.number,
        name: c.name,
        currentReservation: c.reservations?.[0] || null,
      }))

      return c.json({
        success: true,
        data: {
          // Today's queue summary
          totalToday,
          waiting,
          serving,
          completed,
          noShow,
          cancelled,
          // Current serving info
          currentServingNumber: queueSettings?.currentServingNumber || 0,
          lastIssuedNumber: queueSettings?.lastIssuedNumber || 0,
          isPaused: queueSettings?.isPaused || false,
          // Active counters with their current reservations
          activeCounters: counters,
          // Recent activity (last 5 events)
          recentActivity,
          // Average wait time today
          averageWaitMinutes,
          // Estimated wait for next in queue
          estimatedWaitForNext,
        },
      })
    } catch (error) {
      console.error('[LocalAPI] Dashboard error:', error)
      return c.json({ success: false, error: 'Failed to load dashboard' }, 500)
    }
  })

  // PUT /api/agency/profile — update agency basic fields
  app.put('/api/agency/profile', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json()

      // Only allow basic fields
      const allowedFields = ['name', 'phone', 'workingHoursStart', 'workingHoursEnd', 'description', 'address', 'logoUrl']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }

      if (Object.keys(updateData).length === 0) {
        return c.json({ success: false, error: 'No valid fields to update' }, 400)
      }

      const updated = await db.agency.update({
        where: { id: agencyId },
        data: updateData,
      })

      emitEvent('agency:updated', { agencyId, ...updateData })
      logPendingMutation('PUT', '/api/agency/profile', body, updated).catch(() => {})

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Update agency profile error:', error)
      return c.json({ success: false, error: 'Failed to update agency profile' }, 500)
    }
  })

  // PATCH /api/agency/queue-status — toggle queue open/paused
  app.patch('/api/agency/queue-status', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json()
      const newStatus = body.queueOpen // boolean or 0/1

      if (newStatus === undefined) {
        return c.json({ success: false, error: 'queueOpen field is required' }, 400)
      }

      // Update queue settings
      const qs = await db.queueSettings.findFirst({ where: { agencyId } })
      const isPaused = !newStatus

      if (qs) {
        await db.queueSettings.update({
          where: { id: qs.id },
          data: { isPaused },
        })
      } else {
        await db.queueSettings.create({
          data: {
            agencyId,
            isPaused,
            lastIssuedNumber: 0,
            currentServingNumber: 0,
          },
        })
      }

      emitEvent('agency:queue-status', { agencyId, queueOpen: !isPaused })
      logPendingMutation('PATCH', '/api/agency/queue-status', body, { queueOpen: !isPaused }).catch(() => {})

      return c.json({
        success: true,
        data: { queueOpen: !isPaused },
      })
    } catch (error) {
      console.error('[LocalAPI] Queue status error:', error)
      return c.json({ success: false, error: 'Failed to update queue status' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 4. SERVICES (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/services — list active services for agency
  app.get('/api/services', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const services = await db.service.findMany({
        where: { agencyId, isActive: true },
        orderBy: { createdAt: 'asc' },
      })

      return c.json({ success: true, data: services })
    } catch (error) {
      console.error('[LocalAPI] List services error:', error)
      return c.json({ success: false, error: 'Failed to list services' }, 500)
    }
  })

  // POST /api/services — create service
  app.post('/api/services', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json()
      const { name, prefix, estimatedDuration, description } = body

      if (!name) {
        return c.json({ success: false, error: 'Service name is required' }, 400)
      }

      const service = await db.service.create({
        data: {
          agencyId,
          name,
          prefix: prefix || name.charAt(0).toUpperCase(),
          // estimatedDuration: removed — not a Service schema field
          description: description || null,
          isActive: true,
        },
      })

      emitEvent('service:created', { agencyId, service })
      logPendingMutation('POST', '/api/services', body, service).catch(() => {})

      return c.json({ success: true, data: service }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create service error:', error)
      return c.json({ success: false, error: 'Failed to create service' }, 500)
    }
  })

  // PUT /api/services/:id — update service
  app.put('/api/services/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')
      const body = await c.req.json()

      // Verify service belongs to this agency
      const existing = await db.service.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Service not found' }, 404)
      }

      const allowedFields = ['name', 'prefix', 'description', 'isActive'] // estimatedDuration removed — not a Service schema field
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }

      const updated = await db.service.update({ where: { id }, data: updateData })

      emitEvent('service:updated', { agencyId, serviceId: id, ...updateData })
      logPendingMutation('PUT', '/api/services/:id', body, updated).catch(() => {})

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Update service error:', error)
      return c.json({ success: false, error: 'Failed to update service' }, 500)
    }
  })

  // DELETE /api/services/:id — soft delete service
  app.delete('/api/services/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')

      // Verify ownership
      const existing = await db.service.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Service not found' }, 404)
      }

      await db.service.update({
        where: { id },
        data: { isActive: false },
      })

      emitEvent('service:deleted', { agencyId, serviceId: id })
      logPendingMutation('DELETE', '/api/services/:id', {}, { id, deleted: true }).catch(() => {})

      return c.json({ success: true, data: { id, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] Delete service error:', error)
      return c.json({ success: false, error: 'Failed to delete service' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 5. BRANCHES (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/branches
  app.get('/api/agency/branches', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const branches = await db.branch.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'asc' },
      })

      return c.json({ success: true, data: branches })
    } catch (error) {
      console.error('[LocalAPI] List branches error:', error)
      return c.json({ success: false, error: 'Failed to list branches' }, 500)
    }
  })

  // POST /api/agency/branches — create branch
  app.post('/api/agency/branches', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json()
      const { name, address, phone, isActive } = body

      if (!name) {
        return c.json({ success: false, error: 'Branch name is required' }, 400)
      }

      const branch = await db.branch.create({
        data: {
          agencyId,
          name,
          address: address || null,
          phone: phone || null,
          isActive: isActive !== undefined ? Boolean(isActive) : true,
        },
      })

      emitEvent('branch:created', { agencyId, branch })
      logPendingMutation('POST', '/api/agency/branches', body, branch).catch(() => {})

      return c.json({ success: true, data: branch }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create branch error:', error)
      return c.json({ success: false, error: 'Failed to create branch' }, 500)
    }
  })

  // PUT /api/agency/branches/:id — update branch
  // Also accepts PATCH for compatibility
  for (const method of ['put', 'patch']) {
    app[method]('/api/agency/branches/:id', authMiddleware, async (c) => {
      try {
        const agencyId = sessionUser.agencyId
        if (!agencyId) {
          return c.json({ success: false, error: 'No agency associated with this account' }, 403)
        }

        const id = c.req.param('id')
        const body = await c.req.json()

        // Verify ownership
        const existing = await db.branch.findUnique({ where: { id } })
        if (!existing || existing.agencyId !== agencyId) {
          return c.json({ success: false, error: 'Branch not found' }, 404)
        }

        const allowedFields = ['name', 'nameAr', 'nameFr', 'address', 'phone', 'isActive', 'isMain']
        const updateData = {}
        for (const field of allowedFields) {
          if (body[field] !== undefined) {
            updateData[field] = body[field]
          }
        }

        // If setting as main, unset other main branches
        if (updateData.isMain) {
          await db.branch.updateMany({
            where: { agencyId, isMain: true },
            data: { isMain: false },
          })
        }

        const updated = await db.branch.update({ where: { id }, data: updateData })

        emitEvent('branch:updated', { agencyId, branchId: id, ...updateData })
        logPendingMutation(method.toUpperCase(), '/api/agency/branches/:id', body, updated).catch(() => {})

        return c.json({ success: true, data: updated })
      } catch (error) {
        console.error('[LocalAPI] Update branch error:', error)
        return c.json({ success: false, error: 'Failed to update branch' }, 500)
      }
    })
  }

  // DELETE /api/agency/branches/:id — delete branch
  app.delete('/api/agency/branches/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }
      const id = c.req.param('id')
      const existing = await db.branch.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Branch not found' }, 404)
      }
      // Soft delete: set isActive = false
      const updated = await db.branch.update({ where: { id }, data: { isActive: false } })
      emitEvent('branch:deleted', { agencyId, branchId: id })
      logPendingMutation('DELETE', '/api/agency/branches/:id', {}, { id }).catch(() => {})
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Delete branch error:', error)
      return c.json({ success: false, error: 'Failed to delete branch' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 6. COUNTERS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/counters
  app.get('/api/agency/counters', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const branchId = c.req.query('branchId')

      // Counter has no agencyId — route through Branch
      let where = {}
      if (branchId) {
        where.branchId = branchId
      } else {
        // Get all branch IDs for this agency
        const branches = await db.branch.findMany({ where: { agencyId }, select: { id: true } })
        where = { branchId: { in: branches.map(b => b.id) } }
      }

      const counters = await db.counter.findMany({
        where,
        orderBy: { number: 'asc' },
      })

      return c.json({ success: true, data: counters })
    } catch (error) {
      console.error('[LocalAPI] List counters error:', error)
      return c.json({ success: false, error: 'Failed to list counters' }, 500)
    }
  })

  // POST /api/agency/counters — create counter
  app.post('/api/agency/counters', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json()
      const { name, number, branchId, isActive } = body

      if (number === undefined) {
        return c.json({ success: false, error: 'Counter number is required' }, 400)
      }

      const counter = await db.counter.create({
        data: {
          // agencyId removed — Counter has no direct agencyId, only branchId
          name: name || `Counter ${number}`,
          number,
          branchId: branchId || null,
          isActive: isActive !== undefined ? Boolean(isActive) : true,
        },
      })

      emitEvent('counter:created', { agencyId, counter })
      logPendingMutation('POST', '/api/agency/counters', body, counter).catch(() => {})

      return c.json({ success: true, data: counter }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create counter error:', error)
      return c.json({ success: false, error: 'Failed to create counter' }, 500)
    }
  })

  // PUT /api/agency/counters/:id — update counter
  app.put('/api/agency/counters/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')
      const body = await c.req.json()

      const existing = await db.counter.findUnique({ where: { id } })
      if (!existing) {
        return c.json({ success: false, error: 'Counter not found' }, 404)
      }
      // Counter has no agencyId — verify ownership through Branch
      if (existing.branchId) {
        const branch = await db.branch.findUnique({ where: { id: existing.branchId } }).catch(() => null)
        if (!branch || branch.agencyId !== agencyId) {
          return c.json({ success: false, error: 'Counter not found' }, 404)
        }
      }

      const allowedFields = ['name', 'number', 'branchId', 'isActive']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }

      const updated = await db.counter.update({ where: { id }, data: updateData })

      emitEvent('counter:updated', { agencyId, counterId: id, ...updateData })
      logPendingMutation('PUT', '/api/agency/counters/:id', body, updated).catch(() => {})

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Update counter error:', error)
      return c.json({ success: false, error: 'Failed to update counter' }, 500)
    }
  })

  // ── Branch-nested counter routes (used by agency-branches.tsx) ──────
  // These proxy to the same counter logic but use the branch path pattern.

  // GET /api/agency/branches/:branchId/counters — list counters for a branch
  app.get('/api/agency/branches/:branchId/counters', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const branchId = c.req.param('branchId')
      // Verify branch belongs to agency first
      const branch = await db.branch.findUnique({ where: { id: branchId } })
      if (!branch || branch.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Branch not found' }, 404)
      }
      const counters = await db.counter.findMany({
        where: { branchId },
        orderBy: { name: 'asc' },
      })
      return c.json({ success: true, data: counters })
    } catch (error) {
      console.error('[LocalAPI] List branch counters error:', error)
      return c.json({ success: false, error: 'Failed to list counters' }, 500)
    }
  })

  // GET /api/agency/branches/:branchId/counters/:counterId — get single counter
  app.get('/api/agency/branches/:branchId/counters/:counterId', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const { branchId, counterId } = c.req.param()
      // Verify branch belongs to this agency
      const branch = await db.branch.findUnique({ where: { id: branchId } }).catch(() => null)
      if (!branch || branch.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Branch not found' }, 404)
      }
      const counter = await db.counter.findUnique({ where: { id: counterId } })
      if (!counter || counter.branchId !== branchId) {
        return c.json({ success: false, error: 'Counter not found' }, 404)
      }
      return c.json({ success: true, data: counter })
    } catch (error) {
      console.error('[LocalAPI] Get counter error:', error)
      return c.json({ success: false, error: 'Failed to get counter' }, 500)
    }
  })

  // PUT/PATCH /api/agency/branches/:branchId/counters/:counterId — update counter
  for (const method of ['put', 'patch']) {
    app[method]('/api/agency/branches/:branchId/counters/:counterId', authMiddleware, async (c) => {
      try {
        const agencyId = sessionUser.agencyId
        if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
        const { branchId, counterId } = c.req.param()
        // Verify branch belongs to this agency
        const branch = await db.branch.findUnique({ where: { id: branchId } }).catch(() => null)
        if (!branch || branch.agencyId !== agencyId) {
          return c.json({ success: false, error: 'Branch not found' }, 404)
        }
        const body = await c.req.json()
        const existing = await db.counter.findUnique({ where: { id: counterId } })
        if (!existing || existing.branchId !== branchId) {
          return c.json({ success: false, error: 'Counter not found' }, 404)
        }
        const allowedFields = ['name', 'branchId', 'isActive']
        const updateData = {}
        for (const field of allowedFields) {
          if (body[field] !== undefined) updateData[field] = body[field]
        }
        const updated = await db.counter.update({ where: { id: counterId }, data: updateData })
        emitEvent('counter:updated', { agencyId, counterId, ...updateData })
        logPendingMutation(method.toUpperCase(), '/api/agency/branches/:branchId/counters/:counterId', body, updated).catch(() => {})
        return c.json({ success: true, data: updated })
      } catch (error) {
        console.error('[LocalAPI] Update branch counter error:', error)
        return c.json({ success: false, error: 'Failed to update counter' }, 500)
      }
    })
  }

  // DELETE /api/agency/branches/:branchId/counters/:counterId — delete counter
  app.delete('/api/agency/branches/:branchId/counters/:counterId', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const { branchId, counterId } = c.req.param()
      // Verify branch belongs to this agency
      const branch = await db.branch.findUnique({ where: { id: branchId } }).catch(() => null)
      if (!branch || branch.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Branch not found' }, 404)
      }
      const existing = await db.counter.findUnique({ where: { id: counterId } })
      if (!existing || existing.branchId !== branchId) {
        return c.json({ success: false, error: 'Counter not found' }, 404)
      }
      await db.counter.delete({ where: { id: counterId } })
      emitEvent('counter:deleted', { agencyId, counterId })
      logPendingMutation('DELETE', '/api/agency/branches/:branchId/counters/:counterId', {}, { id: counterId }).catch(() => {})
      return c.json({ success: true, data: { id: counterId, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] Delete branch counter error:', error)
      return c.json({ success: false, error: 'Failed to delete counter' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 7. STAFF (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/staff
  app.get('/api/agency/staff', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const staffList = await db.agencyStaff.findMany({
        where: { agencyId },
        orderBy: { joinedAt: 'asc' },
      })

      return c.json({ success: true, data: staffList })
    } catch (error) {
      console.error('[LocalAPI] List staff error:', error)
      return c.json({ success: false, error: 'Failed to list staff' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 8. RESERVATIONS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/reservations — list with filters
  app.get('/api/reservations', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const { take, skip } = parsePagination(c)
      const status = c.req.query('status')
      const serviceId = c.req.query('serviceId')
      const branchId = c.req.query('branchId')
      const dateFrom = c.req.query('dateFrom')
      const dateTo = c.req.query('dateTo')

      const where = { agencyId }
      if (status) where.status = status
      if (serviceId) where.serviceId = serviceId
      // branchId filter removed — Reservation has no branchId field

      // Date range filters
      if (dateFrom || dateTo) {
        where.joinedAt = {}
        if (dateFrom) where.joinedAt.gte = new Date(dateFrom).getTime()
        if (dateTo) where.joinedAt.lte = new Date(dateTo).getTime()
      }

      const [reservations, total] = await Promise.all([
        db.reservation.findMany({
          where,
          orderBy: { joinedAt: 'desc' },
          take,
          skip,
        }),
        db.reservation.count({ where }),
      ])

      return c.json({ success: true, data: reservations, total })
    } catch (error) {
      console.error('[LocalAPI] List reservations error:', error)
      return c.json({ success: false, error: 'Failed to list reservations' }, 500)
    }
  })

  // POST /api/reservations — create reservation with auto queue number
  app.post('/api/reservations', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json()
      const {
        serviceId,
        // branchId removed — Reservation has no branchId,
        userId,
        walkInCustomerName,
        preferredTime,
        fixedTimeEnabled,
        estimatedWait,
        isWalkIn,
      } = body

      if (!serviceId) {
        return c.json({ success: false, error: 'serviceId is required' }, 400)
      }

      // Get service prefix
      const service = await db.service.findUnique({ where: { id: serviceId } })
      if (!service || service.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Service not found' }, 404)
      }

      // Get or create queue settings to determine next number
      let qs = await db.queueSettings.findFirst({ where: { agencyId } })
      const lastNumber = qs?.lastIssuedNumber || 0
      const newNumber = lastNumber + 1
      const servicePrefix = service.prefix || 'A'
      const displayNumber = `${servicePrefix}${String(newNumber).padStart(3, '0')}`

      // Calculate position in queue (number of WAITING reservations before this one)
      const waitingCount = await db.reservation.count({
        where: { agencyId, status: 'WAITING' },
      })

      const reservation = await db.reservation.create({
        data: {
          agencyId,
          serviceId,
          // branchId: removed — Reservation has no branchId field
          userId: userId || sessionUser.id,
          queueNumber: newNumber,
          displayNumber,
          status: 'WAITING',
        // position: removed — not a Reservation schema field
          estimatedWait: estimatedWait || 0,
          isWalkIn: !!isWalkIn,
          walkInCustomerName: walkInCustomerName || null,
          preferredTime: preferredTime || null,
          fixedTimeEnabled: !!fixedTimeEnabled,
        },
      })

      // Update queue settings
      if (qs) {
        await db.queueSettings.update({
          where: { id: qs.id },
          data: { lastIssuedNumber: newNumber },
        })
      } else {
        await db.queueSettings.create({
          data: {
            agencyId,
            lastIssuedNumber: newNumber,
            currentServingNumber: 0,
            isPaused: false,
          },
        })
      }

      emitEvent('reservation:created', { agencyId, reservation })
      logPendingMutation('POST', '/api/reservations', body, reservation).catch(() => {})

      return c.json({ success: true, data: reservation }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create reservation error:', error)
      return c.json({ success: false, error: 'Failed to create reservation' }, 500)
    }
  })

  // PUT /api/reservations/:id — update reservation details
  app.put('/api/reservations/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')
      const body = await c.req.json()

      // Verify ownership
      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      // Only allow certain fields to be updated
      const allowedFields = [
        'serviceId', 'walkInCustomerName', // branchId removed — Reservation has no branchId field
        'preferredTime', 'fixedTimeEnabled', 'estimatedWait',
        'notes',
      ]
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }

      if (Object.keys(updateData).length === 0) {
        return c.json({ success: false, error: 'No valid fields to update' }, 400)
      }

      const updated = await db.reservation.update({
        where: { id },
        data: updateData,
      })

      emitEvent('reservation:updated', { agencyId, reservationId: id, ...updateData })
      logPendingMutation('PUT', '/api/reservations/:id', body, updated).catch(() => {})

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Update reservation error:', error)
      return c.json({ success: false, error: 'Failed to update reservation' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 9. QUEUE OPERATIONS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/queue/active — waiting + called/serving
  app.get('/api/queue/active', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const branchId = c.req.query('branchId')
      const baseWhere = { agencyId }
      // branchId filter removed — Reservation has no branchId field

      const [waiting, called] = await Promise.all([
        db.reservation.findMany({
          where: { ...baseWhere, status: 'WAITING' },
          orderBy: { joinedAt: 'asc' },
        }),
        db.reservation.findMany({
          where: { ...baseWhere, status: { in: ['CALLED', 'SERVING'] } },
          orderBy: { calledAt: 'asc' },
        }),
      ])

      return c.json({
        success: true,
        data: {
          waiting,
          serving: called.filter((r) => r.status === 'SERVING'),
          called: called.filter((r) => r.status === 'CALLED'),
        },
      })
    } catch (error) {
      console.error('[LocalAPI] Active queue error:', error)
      return c.json({ success: false, error: 'Failed to load active queue' }, 500)
    }
  })

  // GET /api/queue/today — all today's reservations
  app.get('/api/queue/today', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const startMs = todayStartMs()
      const endMs = todayEndMs()

      const reservations = await db.reservation.findMany({
        where: { agencyId, joinedAt: { gte: startMs, lte: endMs } },
        orderBy: { joinedAt: 'desc' },
      })

      return c.json({ success: true, data: reservations, total: reservations.length })
    } catch (error) {
      console.error('[LocalAPI] Today queue error:', error)
      return c.json({ success: false, error: 'Failed to load today queue' }, 500)
    }
  })

  // POST /api/queue/call-next — call next customer
  app.post('/api/queue/call-next', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const body = await c.req.json().catch(() => ({}))
      const { serviceId, counterId, branchId } = body

      // Build where clause for next waiting
      const where = { agencyId, status: 'WAITING' }
      if (serviceId) where.serviceId = serviceId
      // branchId filter removed — Reservation has no branchId field

      const next = await db.reservation.findFirst({
        where,
        orderBy: { joinedAt: 'asc' },
      })

      if (!next) {
        return c.json({ success: false, error: 'No customers in queue' }, 404)
      }

      const now = new Date()

      // Call the customer
      await db.reservation.update({
        where: { id: next.id },
        data: {
          status: 'CALLED',
          calledAt: now,
          // calledBy: removed — not a Reservation schema field
          counterId: counterId || null,
        },
      })

      // Update current serving number in queue settings
      const qs = await db.queueSettings.findFirst({ where: { agencyId } })
      if (qs) {
        await db.queueSettings.update({
          where: { id: qs.id },
          data: { currentServingNumber: next.queueNumber },
        })
      }

      const updated = await db.reservation.findUnique({ where: { id: next.id } })

      emitEvent('queue:called', { agencyId, reservation: updated, counterId: counterId || null })
      logPendingMutation('POST', '/api/queue/call-next', body, updated).catch(() => {})

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Call-next error:', error)
      return c.json({ success: false, error: 'Failed to call next customer' }, 500)
    }
  })

  // POST /api/queue/call/:id — call specific reservation
  app.post('/api/queue/call/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const { counterId } = body

      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      if (!['WAITING', 'CALLED'].includes(existing.status)) {
        return c.json(
          { success: false, error: `Cannot call a reservation with status: ${existing.status}` },
          400,
        )
      }

      const now = new Date()
      await db.reservation.update({
        where: { id },
        data: {
          status: 'CALLED',
          calledAt: now,
          // calledBy: removed — not a Reservation schema field
          counterId: counterId || null,
        },
      })

      const updated = await db.reservation.findUnique({ where: { id } })

      emitEvent('queue:called', { agencyId, reservation: updated, counterId: counterId || null })
      logPendingMutation('POST', '/api/queue/call/:id', body, updated).catch(() => {})

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Call specific error:', error)
      return c.json({ success: false, error: 'Failed to call reservation' }, 500)
    }
  })

  // POST /api/queue/complete/:id
  app.post('/api/queue/complete/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')

      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      const now = new Date()
      const reservation = await db.reservation.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          // completedBy: removed — not a Reservation schema field
        },
      })

      emitEvent('queue:completed', { agencyId, reservation })
      logPendingMutation('POST', '/api/queue/complete/:id', {}, reservation).catch(() => {})

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Complete error:', error)
      return c.json({ success: false, error: 'Failed to complete reservation' }, 500)
    }
  })

  // POST /api/queue/no-show/:id
  app.post('/api/queue/no-show/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')

      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      const now = new Date()
      const reservation = await db.reservation.update({
        where: { id },
        data: {
          status: 'NO_SHOW',
          skippedAt: now,
        },
      })

      emitEvent('queue:no-show', { agencyId, reservation })
      logPendingMutation('POST', '/api/queue/no-show/:id', {}, reservation).catch(() => {})

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] No-show error:', error)
      return c.json({ success: false, error: 'Failed to mark no-show' }, 500)
    }
  })

  // POST /api/queue/cancel/:id
  app.post('/api/queue/cancel/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')

      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      const now = new Date()
      const reservation = await db.reservation.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          // cancelledBy: removed — not a Reservation schema field
        },
      })

      emitEvent('queue:cancelled', { agencyId, reservation })
      logPendingMutation('POST', '/api/queue/cancel/:id', {}, reservation).catch(() => {})

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Cancel error:', error)
      return c.json({ success: false, error: 'Failed to cancel reservation' }, 500)
    }
  })

  // POST /api/queue/postpone/:id
  app.post('/api/queue/postpone/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')

      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      if (!['WAITING', 'CALLED'].includes(existing.status)) {
        return c.json(
          { success: false, error: `Cannot postpone reservation with status: ${existing.status}` },
          400,
        )
      }

      const now = new Date()
      const reservation = await db.reservation.update({
        where: { id },
        data: {
          status: 'POSTPONED',
          // postponedAt: removed — not a Reservation schema field
        },
      })

      emitEvent('queue:postponed', { agencyId, reservation })
      logPendingMutation('POST', '/api/queue/postpone/:id', {}, reservation).catch(() => {})

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Postpone error:', error)
      return c.json({ success: false, error: 'Failed to postpone reservation' }, 500)
    }
  })

  // POST /api/queue/recall/:id — re-call a CALLED reservation
  app.post('/api/queue/recall/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const id = c.req.param('id')

      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      if (existing.status !== 'CALLED') {
        return c.json(
          { success: false, error: 'Can only recall a CALLED reservation' },
          400,
        )
      }

      const now = new Date()
      const reservation = await db.reservation.update({
        where: { id },
        data: {
          calledAt: now,
        },
      })

      emitEvent('queue:recalled', { agencyId, reservation })
      logPendingMutation('POST', '/api/queue/recall/:id', {}, reservation).catch(() => {})

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Recall error:', error)
      return c.json({ success: false, error: 'Failed to recall reservation' }, 500)
    }
  })

  // GET /api/queue/status — current serving info
  app.get('/api/queue/status', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const qs = await db.queueSettings.findFirst({ where: { agencyId } })
      const waitingCount = await db.reservation.count({ where: { agencyId, status: 'WAITING' } })
      const servingCount = await db.reservation.count({ where: { agencyId, status: { in: ['CALLED', 'SERVING'] } } })
      return c.json({
        success: true,
        data: {
          currentServingNumber: qs?.currentServingNumber || 0,
          lastIssuedNumber: qs?.lastIssuedNumber || 0,
          isPaused: qs?.isPaused || false,
          waitingCount,
          servingCount,
        },
      })
    } catch (error) {
      console.error('[LocalAPI] Queue status error:', error)
      return c.json({ success: false, error: 'Failed to get queue status' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 10. NOTIFICATIONS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/notifications — list with pagination
  app.get('/api/notifications', authMiddleware, async (c) => {
    try {
      const user = sessionUser
      const { take, skip } = parsePagination(c)

      const [notifications, total, unreadCount] = await Promise.all([
        db.notification.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take,
          skip,
        }),
        db.notification.count({ where: { userId: user.id } }),
        db.notification.count({ where: { userId: user.id, isRead: false } }),
      ])

      return c.json({ success: true, notifications, total: total, unreadCount, page: 1, limit: take })
    } catch (error) {
      console.error('[LocalAPI] List notifications error:', error)
      return c.json({ success: false, error: 'Failed to list notifications' }, 500)
    }
  })

  // POST /api/notifications/read-all — mark all as read
  app.post('/api/notifications/read-all', authMiddleware, async (c) => {
    try {
      const user = sessionUser

      await db.notification.updateMany({
        where: { userId: user.id, isRead: false },
        data: { isRead: true },
      })

      emitEvent('notifications:read-all', { userId: user.id })
      logPendingMutation('POST', '/api/notifications/read-all', {}, {}).catch(() => {})

      return c.json({ success: true, data: { message: 'All notifications marked as read' } })
    } catch (error) {
      console.error('[LocalAPI] Read-all notifications error:', error)
      return c.json({ success: false, error: 'Failed to mark notifications as read' }, 500)
    }
  })

  // PUT /api/notifications/read-all — alias (cloud uses PUT)
  app.put('/api/notifications/read-all', authMiddleware, async (c) => {
    try {
      const user = sessionUser
      await db.notification.updateMany({
        where: { userId: user.id, isRead: false },
        data: { isRead: true },
      })
      emitEvent('notifications:read-all', { userId: user.id })
      logPendingMutation('PUT', '/api/notifications/read-all', {}, {}).catch(() => {})
      return c.json({ success: true, data: { message: 'All notifications marked as read' } })
    } catch (error) {
      console.error('[LocalAPI] PUT read-all notifications error:', error)
      return c.json({ success: false, error: 'Failed to mark notifications as read' }, 500)
    }
  })

  // PUT /api/notifications/:id — mark as read
  // Also accepts PATCH for compatibility (some web clients use PATCH)
  for (const method of ['put', 'patch']) {
    app[method]('/api/notifications/:id', authMiddleware, async (c) => {
      try {
        const id = c.req.param('id')
        const body = await c.req.json().catch(() => ({}))

        const existing = await db.notification.findUnique({ where: { id } })
        if (!existing || existing.userId !== sessionUser.id) {
          return c.json({ success: false, error: 'Notification not found' }, 404)
        }

        const updateData = {}
        if (body.isRead !== undefined) {
          updateData.isRead = body.isRead ? true : false
        }

        const updated = await db.notification.update({
          where: { id },
          data: updateData,
        })

        logPendingMutation(method.toUpperCase(), '/api/notifications/:id', body, updated).catch(() => {})
        return c.json({ success: true, data: updated })
      } catch (error) {
        console.error('[LocalAPI] Update notification error:', error)
        return c.json({ success: false, error: 'Failed to update notification' }, 500)
      }
    })
  }

  // DELETE /api/notifications/:id — delete a notification
  app.delete('/api/notifications/:id', authMiddleware, async (c) => {
    try {
      const id = c.req.param('id')
      const existing = await db.notification.findUnique({ where: { id } })
      if (!existing || existing.userId !== sessionUser.id) {
        return c.json({ success: false, error: 'Notification not found' }, 404)
      }
      await db.notification.delete({ where: { id } })
      logPendingMutation('DELETE', '/api/notifications/:id', {}, { id }).catch(() => {})
      return c.json({ success: true, data: { deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] Delete notification error:', error)
      return c.json({ success: false, error: 'Failed to delete notification' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 11. USER PROFILE (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/user/profile
  app.get('/api/user/profile', authMiddleware, async (c) => {
    try {
      const user = sessionUser
      const fullUser = await db.user.findUnique({ where: { id: user.id } })
      if (!fullUser) {
        return c.json({ success: false, error: 'User not found' }, 404)
      }

      // Remove passwordHash from response
      const { passwordHash, ...safeUser } = fullUser

      return c.json({ success: true, data: safeUser })
    } catch (error) {
      console.error('[LocalAPI] User profile error:', error)
      return c.json({ success: false, error: 'Failed to load user profile' }, 500)
    }
  })

  // PUT /api/user/profile — update name, language, avatar
  app.put('/api/user/profile', authMiddleware, async (c) => {
    try {
      const user = sessionUser
      const body = await c.req.json()

      const allowedFields = ['fullName', 'language', 'avatarUrl']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }

      if (Object.keys(updateData).length === 0) {
        return c.json({ success: false, error: 'No valid fields to update' }, 400)
      }

      const updated = await db.user.update({
        where: { id: user.id },
        data: updateData,
      })

      // Update session user if name/language/avatar changed
      if (updateData.fullName) sessionUser.fullName = updateData.fullName
      if (updateData.language) sessionUser.language = updateData.language
      if (updateData.avatarUrl !== undefined) sessionUser.avatarUrl = updateData.avatarUrl

      const { passwordHash, ...safeUser } = updated

      emitEvent('user:updated', { userId: user.id, ...updateData })
      logPendingMutation('PUT', '/api/user/profile', body, safeUser).catch(() => {})

      return c.json({ success: true, data: safeUser })
    } catch (error) {
      console.error('[LocalAPI] Update user profile error:', error)
      return c.json({ success: false, error: 'Failed to update user profile' }, 500)
    }
  })

  // PATCH /api/user/profile — alias for PUT (cloud uses PATCH)
  app.patch('/api/user/profile', authMiddleware, async (c) => {
    // Delegate to the same logic as PUT
    try {
      const user = sessionUser
      const body = await c.req.json()
      const allowedFields = ['fullName', 'language', 'avatarUrl']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }
      if (Object.keys(updateData).length === 0) {
        return c.json({ success: false, error: 'No valid fields to update' }, 400)
      }
      const updated = await db.user.update({ where: { id: user.id }, data: updateData })
      if (updateData.fullName) sessionUser.fullName = updateData.fullName
      if (updateData.language) sessionUser.language = updateData.language
      if (updateData.avatarUrl !== undefined) sessionUser.avatarUrl = updateData.avatarUrl
      const { passwordHash, ...safeUser } = updated
      emitEvent('user:updated', { userId: user.id, ...updateData })
      logPendingMutation('PATCH', '/api/user/profile', body, safeUser).catch(() => {})
      return c.json({ success: true, data: safeUser })
    } catch (error) {
      console.error('[LocalAPI] PATCH user profile error:', error)
      return c.json({ success: false, error: 'Failed to update user profile' }, 500)
    }
  })

  // PATCH /api/user/change-password — change password (requires cloud connection)
  app.patch('/api/user/change-password', authMiddleware, async (c) => {
    try {
      const body = await c.req.json()
      const { currentPassword, newPassword } = body
      if (!currentPassword || !newPassword) {
        return c.json({ success: false, error: 'currentPassword and newPassword are required' }, 400)
      }
      if (newPassword.length < 6) {
        return c.json({ success: false, error: 'New password must be at least 6 characters' }, 400)
      }
      // Password change requires cloud — forward via cloud-proxy pattern
      const cloudUrl = getCloudUrl()

      // Check if cloud is reachable
      let cloudHealthy = false
      try {
        const healthResp = await fetch(`${cloudUrl}/health`, { signal: AbortSignal.timeout(5000) })
        cloudHealthy = healthResp.ok
      } catch { /* cloud unreachable */ }

      if (!cloudHealthy) {
        return c.json({ success: false, error: 'Password change requires internet connection', code: 'CLOUD_REQUIRED' }, 403)
      }

      try {
        const resp = await fetch(`${cloudUrl}/api/user/change-password`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ currentPassword, newPassword }),
          signal: AbortSignal.timeout(15000),
        })
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({ error: 'Cloud request failed' }))
          return c.json({ success: false, error: errData.error || 'Password change failed', offline: resp.status === 503 }, resp.status)
        }
        const data = await resp.json()
        // Update local password hash if cloud succeeded
        if (data.success || data.user) {
          try {
            let bcrypt = null
            try { bcrypt = require('bcryptjs') } catch { /* try alternate paths */ }
            if (!bcrypt) {
              try { bcrypt = require(require('path').join(process.cwd(), 'node_modules', 'bcryptjs')) } catch { /* nope */ }
            }
            if (!bcrypt) {
              try { bcrypt = require(require('path').join(__dirname, '..', 'node_modules', 'bcryptjs')) } catch { /* nope */ }
            }
            let newHash
            if (bcrypt) {
              newHash = await bcrypt.hash(newPassword, 10)
            } else {
              // Fallback: scrypt
              const { scryptSync } = require('crypto')
              const salt = require('crypto').randomBytes(16).toString('base64')
              const derived = scryptSync(newPassword, salt, 64).toString('base64')
              newHash = `$scrypt$${salt}$${derived}`
            }
            await db.user.update({ where: { id: sessionUser.id }, data: { passwordHash: newHash } })
            console.log('[LocalAPI] Local password hash updated after cloud change-password')
          } catch (updateErr) {
            console.warn('[LocalAPI] Could not update local password hash after change:', updateErr.message)
          }
        }
        return c.json(data)
      } catch (fetchErr) {
        return c.json({ success: false, error: 'Password change requires internet connection', code: 'CLOUD_REQUIRED' }, 403)
      }
    } catch (error) {
      console.error('[LocalAPI] Change password error:', error)
      return c.json({ success: false, error: 'Failed to change password' }, 500)
    }
  })

  // GET /api/user/preferences
  app.get('/api/user/preferences', authMiddleware, async (c) => {
    try {
      const user = await db.user.findUnique({
        where: { id: sessionUser.id },
        select: { id: true, language: true, notificationPreferences: true },
      })
      if (!user) return c.json({ success: false, error: 'User not found' }, 404)
      return c.json({ success: true, data: user })
    } catch (error) {
      console.error('[LocalAPI] Get preferences error:', error)
      return c.json({ success: false, error: 'Failed to get preferences' }, 500)
    }
  })

  // PATCH /api/user/preferences
  app.patch('/api/user/preferences', authMiddleware, async (c) => {
    try {
      const body = await c.req.json()
      const allowedFields = ['language', 'notificationPreferences']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) updateData[field] = body[field]
      }
      if (Object.keys(updateData).length === 0) {
        return c.json({ success: false, error: 'No valid fields to update' }, 400)
      }
      const updated = await db.user.update({ where: { id: sessionUser.id }, data: updateData })
      emitEvent('user:updated', { userId: sessionUser.id, ...updateData })
      logPendingMutation('PATCH', '/api/user/preferences', body, updated).catch(() => {})
      return c.json({ success: true, data: { id: updated.id, language: updated.language, notificationPreferences: updated.notificationPreferences } })
    } catch (error) {
      console.error('[LocalAPI] Update preferences error:', error)
      return c.json({ success: false, error: 'Failed to update preferences' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 12. SETTINGS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/settings — queue settings
  app.get('/api/agency/settings', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      let settings = await db.queueSettings.findFirst({ where: { agencyId } })

      // Return defaults if no settings exist yet
      if (!settings) {
        settings = {
          agencyId,
          lastIssuedNumber: 0,
          currentServingNumber: 0,
          isPaused: false,
          avgServiceTime: 5,
          maxDailyTickets: 500,
        }
      }

      return c.json({ success: true, data: settings })
    } catch (error) {
      console.error('[LocalAPI] Queue settings error:', error)
      return c.json({ success: false, error: 'Failed to load queue settings', detail: error?.message || String(error) }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 13. FRONTEND ROUTE ALIASES (/api/agency/* paths)
  //    The frontend (page.tsx, dashboard, fullscreen) calls /api/agency/queue,
  //    /api/agency/stats, /api/agency/services etc. These are aliases that
  //    delegate to the existing routes above, keeping the response format
  //    compatible with the cloud API so the frontend works offline.
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/queue?status=WAITING,CALLED — active queue entries
  app.get('/api/agency/queue', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }

      const statusParam = c.req.query('status') || 'WAITING,CALLED'
      const statuses = statusParam.split(',').map(s => s.trim())
      const where = { agencyId }
      if (statuses.length === 1) {
        where.status = statuses[0]
      } else {
        where.status = { in: statuses }
      }

      const reservations = await db.reservation.findMany({
        where,
        orderBy: { joinedAt: statuses.includes('CALLED') ? 'desc' : 'asc' },
      })

      // Enrich with service/branch/counter data
      const entries = []
      for (const r of reservations) {
        const service = r.serviceId ? await db.service.findUnique({ where: { id: r.serviceId } }).catch(() => null) : null
        const user = r.userId ? await db.user.findUnique({ where: { id: r.userId } }).catch(() => null) : null
        entries.push({
          id: r.id,
          queueNumber: r.displayNumber,
          customerName: r.walkInCustomerName || null,
          customerPhone: user?.phoneNumber || null,
          customerAvatar: null,
          serviceName: service ? service.name : null,
          serviceNameAr: service?.nameAr || null,
          serviceNameFr: service?.nameFr || null,
          joinedAt: r.joinedAt instanceof Date ? r.joinedAt.toISOString() : String(r.joinedAt),
          status: r.status,
          position: r.status === 'WAITING' ? (entries.length - entries.filter((e) => e.status === 'WAITING').length + 1) : 0,
          isWalkIn: r.isWalkIn || false,
          walkInCustomerName: r.walkInCustomerName || null,
          importToken: null,
          preferredTime: r.preferredTime || null,
          fixedTimeEnabled: r.fixedTimeEnabled || false,
          postponeCount: r.postponeCount || 0,
        })
      }

      return c.json({ entries })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue error:', error)
      return c.json({ success: false, error: 'Failed to load queue', detail: error?.message || String(error) }, 500)
    }
  })

  // PATCH /api/agency/queue/:id — complete / no_show / cancel
  app.patch('/api/agency/queue/:id', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const reservationId = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const { action } = body

      if (!['complete', 'no_show', 'cancel', 'serve', 'recall'].includes(action)) {
        return c.json({ success: false, error: 'Invalid action' }, 400)
      }

      const reservation = await db.reservation.findUnique({ where: { id: reservationId } })
      if (!reservation) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      const updateData = {}
      const now = new Date()
      if (action === 'complete') {
        updateData.status = 'COMPLETED'
        updateData.completedAt = now
      } else if (action === 'no_show') {
        updateData.status = 'NO_SHOW'
        updateData.skippedAt = now
      } else if (action === 'cancel') {
        updateData.status = 'CANCELLED'
        updateData.cancelledAt = now
      } else if (action === 'serve') {
        updateData.status = 'SERVING'
      } else if (action === 'recall') {
        updateData.status = 'CALLED'
      }

      await db.reservation.update({ where: { id: reservationId }, data: updateData })

      emitEvent('queue:updated', { reservationId, action, ...updateData })
      logPendingMutation('PATCH', '/api/agency/queue/:id', body, updateData).catch(() => {})
      return c.json({ success: true, reservation: { ...reservation, ...updateData } })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue/:id PATCH error:', error)
      return c.json({ success: false, error: 'Failed to update reservation' }, 500)
    }
  })

  // GET /api/agency/stats — queue statistics
  app.get('/api/agency/stats', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }

      const startMs = todayStartMs()
      const endMs = todayEndMs()

      const agency = await db.agency.findUnique({ where: { id: agencyId } }).catch(() => null)
      const branchRows = await db.branch.findMany({ where: { agencyId }, select: { id: true } }).catch(() => [])
      const branchIds = branchRows.map((b) => b.id)

      const [waiting, called, serving, completed, cancelled, noShow, total, activeCounters, walkInCount, onlineReservationCount] = await Promise.all([
        db.reservation.count({ where: { agencyId, status: 'WAITING' } }),
        db.reservation.count({ where: { agencyId, status: 'CALLED' } }),
        db.reservation.count({ where: { agencyId, status: 'SERVING' } }),
        db.reservation.count({ where: { agencyId, status: 'COMPLETED', completedAt: { gte: startMs, lte: endMs } } }),
        db.reservation.count({ where: { agencyId, status: 'CANCELLED', cancelledAt: { gte: startMs, lte: endMs } } }),
        db.reservation.count({ where: { agencyId, status: 'NO_SHOW', skippedAt: { gte: startMs, lte: endMs } } }),
        db.reservation.count({ where: { agencyId, joinedAt: { gte: startMs, lte: endMs } } }),
        branchIds.length > 0
          ? db.counter.count({ where: { branchId: { in: branchIds }, isActive: true } })
          : Promise.resolve(0),
        db.reservation.count({ where: { agencyId, isWalkIn: true, joinedAt: { gte: startMs, lte: endMs } } }),
        db.reservation.count({ where: { agencyId, isWalkIn: false, userId: { not: null }, joinedAt: { gte: startMs, lte: endMs } } }),
      ])

      // Queue settings (paused state)
      const queueSettings = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      const isPaused = queueSettings ? queueSettings.isPaused === 1 || queueSettings.isPaused === true : false

      // ── Rating stats ──
      const reviewAgg = await db.review.aggregate({
        where: { agencyId },
        _avg: { rating: true },
        _count: true,
      }).catch(() => ({ _avg: { rating: null }, _count: 0 }))
      const avgRating = reviewAgg._avg.rating ? Math.round(reviewAgg._avg.rating * 10) / 10 : 0
      const totalRatings = reviewAgg._count || 0

      // ── Rating distribution (1-5) ──
      const ratingDistribution = await Promise.all(
        [1, 2, 3, 4, 5].map((r) =>
          db.review.count({ where: { agencyId, rating: r } }).catch(() => 0)
        )
      )

      // ── Completion & no-show rates (today) ──
      const todayCompletedCount = completed
      const todayNoShowCount = noShow
      const todayTotal = total || 0
      const completionRate = todayTotal > 0 ? Math.round((todayCompletedCount / todayTotal) * 100) : 0
      const noShowRate = todayTotal > 0 ? Math.round((todayNoShowCount / todayTotal) * 100) : 0

      // ── Peak hour: hour with most reservations today ──
      let peakHour = '—'
      try {
        const todayReservations = await db.reservation.findMany({
          where: { agencyId, joinedAt: { gte: startMs, lte: endMs } },
          select: { joinedAt: true },
        })
        if (todayReservations.length > 0) {
          const hourCounts = new Array(24).fill(0)
          for (const r of todayReservations) {
            const hour = new Date(r.joinedAt).getHours()
            hourCounts[hour]++
          }
          let maxHour = 0
          let maxCount = 0
          for (let h = 0; h < 24; h++) {
            if (hourCounts[h] > maxCount) {
              maxCount = hourCounts[h]
              maxHour = h
            }
          }
          peakHour = `${String(maxHour).padStart(2, '0')}:00`
        }
      } catch (_) { /* keep default */ }

      // ── Hourly wait time: average wait per hour for completed reservations today ──
      const hourlyWaitTime = new Array(24).fill(0)
      try {
        const completedToday = await db.reservation.findMany({
          where: {
            agencyId,
            status: 'COMPLETED',
            completedAt: { gte: startMs, lte: endMs },
            calledAt: { not: null },
          },
          select: { calledAt: true, joinedAt: true },
        })
        const hourBuckets = new Array(24).fill(null).map(() => [])
        for (const r of completedToday) {
          if (r.calledAt && r.joinedAt) {
            const waitMin = (new Date(r.calledAt).getTime() - new Date(r.joinedAt).getTime()) / 60000
            const hour = new Date(r.joinedAt).getHours()
            hourBuckets[hour].push(waitMin)
          }
        }
        for (let h = 0; h < 24; h++) {
          if (hourBuckets[h].length > 0) {
            hourlyWaitTime[h] = Math.round(hourBuckets[h].reduce((a, b) => a + b, 0) / hourBuckets[h].length)
          }
        }
      } catch (_) { /* keep zeros */ }

      // ── Estimated wait range ──
      const avgServiceTime = agency?.averageServiceTime || 10
      const queueLength = waiting + called
      let estimatedWaitRange = { minMinutes: 0, maxMinutes: 0, confidence: 'LOW' }
      if (queueLength > 0 && activeCounters > 0) {
        const minMin = Math.round((queueLength * avgServiceTime) / activeCounters)
        const maxMin = Math.round(minMin * 1.5)
        estimatedWaitRange = {
          minMinutes: minMin,
          maxMinutes: maxMin,
          confidence: queueLength >= 5 ? 'MEDIUM' : 'HIGH',
        }
      }

      const result = {
        todayReservations: total,
        currentlyWaiting: waiting,
        servedToday: completed,
        noShowCount: noShow,
        cancelledCount: cancelled,
        avgWaitTime: agency?.averageServiceTime || 10,
        currentQueueNumber: queueSettings?.currentServingNumber ? String(queueSettings.currentServingNumber) : '—',
        isPaused,
        peakHour,
        avgRating,
        totalRatings,
        completionRate,
        noShowRate,
        hourlyWaitTime,
        ratingDistribution,
        subscriptionStatus: agency?.subscriptionStatus || 'INACTIVE',  // Default to INACTIVE if not set (safe default)
        estimatedWaitRange,
        activeCounters,
        walkInCount,
        onlineReservationCount,
      }
      return c.json(result)
    } catch (error) {
      console.error('[LocalAPI] /api/agency/stats error:', error)
      return c.json({ success: false, error: 'Failed to load stats', detail: error?.message || String(error) }, 500)
    }
  })

  // GET /api/agency/services — list services (alias for /api/services)
  app.get('/api/agency/services', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      const services = await db.service.findMany({
        where: { agencyId, isActive: true },
        orderBy: { name: 'asc' },
      })
      return c.json({ services })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/services error:', error)
      return c.json({ success: false, error: 'Failed to load services', detail: error?.message || String(error) }, 500)
    }
  })

  // POST /api/agency/services — create service (alias for /api/services)
  app.post('/api/agency/services', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const body = await c.req.json()
      const { name, nameAr, nameFr, prefix, avgServiceTime } = body
      if (!name) return c.json({ success: false, error: 'Service name is required' }, 400)
      const service = await db.service.create({
        data: {
          agencyId,
          name,
          nameAr: nameAr || null,
          nameFr: nameFr || null,
          prefix: prefix || null,
          isActive: true,
        },
      })
      emitEvent('service:created', { agencyId, service })
      logPendingMutation('POST', '/api/agency/services', body, service).catch(() => {})
      return c.json({ success: true, data: service }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create service error:', error)
      return c.json({ success: false, error: 'Failed to create service' }, 500)
    }
  })

  // GET /api/agency/activity — recent activity events (for dashboard feed)
  app.get('/api/agency/activity', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      // Fetch last 20 reservations with status changes, ordered by most recently updated
      const recent = await db.reservation.findMany({
        where: { agencyId },
        orderBy: { updatedAt: 'desc' },
        take: 20,
      })
      // Build service lookup map
      const serviceIds = new Set()
      for (const r of recent) {
        if (r.serviceId) serviceIds.add(r.serviceId)
      }
      const serviceList = serviceIds.size > 0 ? await db.service.findMany({ where: { id: { in: [...serviceIds] } } }).catch(() => []) : []
      const serviceMap = new Map(serviceList.map((s) => [s.id, s]))
      const events = recent.map((r) => ({
        id: r.id,
        queueNumber: r.queueNumber,
        displayNumber: r.displayNumber || String(r.queueNumber),
        status: r.status,
        customerName: r.walkInCustomerName || 'Walk-in',
        serviceName: serviceMap.get(r.serviceId)?.name || null,
        joinedAt: r.joinedAt instanceof Date ? r.joinedAt.toISOString() : (r.joinedAt ? String(r.joinedAt) : null),
        calledAt: r.calledAt instanceof Date ? r.calledAt.toISOString() : (r.calledAt ? String(r.calledAt) : null),
        completedAt: r.completedAt instanceof Date ? r.completedAt.toISOString() : (r.completedAt ? String(r.completedAt) : null),
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : (r.updatedAt ? String(r.updatedAt) : null),
        eventType: r.status === 'COMPLETED' ? 'completed' : r.status === 'CANCELLED' ? 'cancelled' : r.status === 'NO_SHOW' ? 'no_show' : r.status === 'CALLED' ? 'called' : 'joined',
        eventKey: r.status === 'COMPLETED' ? 'customerCompletedService' : r.status === 'CANCELLED' ? 'customerCancelledRes' : r.status === 'NO_SHOW' ? 'customerNoShow' : r.status === 'CALLED' ? 'customerWasCalled' : 'customerJoinedQueue',
      }))
      return c.json({ success: true, events })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/activity error:', error)
      return c.json({ success: false, error: 'Failed to load activity', detail: error?.message || String(error) }, 500)
    }
  })

  // POST /api/queue/pause — explicit pause (used by SimpleMobileDashboard)
  app.post('/api/queue/pause', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      if (existing) {
        await db.queueSettings.update({ where: { id: existing.id }, data: { isPaused: true, pausedAt: new Date() } })
      } else {
        await db.queueSettings.create({ data: { agencyId, isPaused: true, pausedAt: new Date() } })
      }
      emitEvent('queue:paused', { agencyId, queueSettings: { isPaused: true } })
      logPendingMutation('POST', '/api/queue/pause', {}, { isPaused: true }).catch(() => {})
      return c.json({ success: true, isPaused: true })
    } catch (error) {
      console.error('[LocalAPI] /api/queue/pause error:', error)
      return c.json({ success: false, error: 'Failed to pause' }, 500)
    }
  })

  // PUT /api/queue/pause — alias (cloud uses PUT)
  app.put('/api/queue/pause', authMiddleware, requireActiveSubscription(), async (c) => {
    // Same logic as POST above
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      if (existing) {
        await db.queueSettings.update({ where: { id: existing.id }, data: { isPaused: true, pausedAt: new Date() } })
      } else {
        await db.queueSettings.create({ data: { agencyId, isPaused: true, pausedAt: new Date() } })
      }
      emitEvent('queue:paused', { agencyId, queueSettings: { isPaused: true } })
      logPendingMutation('PUT', '/api/queue/pause', {}, { isPaused: true }).catch(() => {})
      return c.json({ success: true, isPaused: true })
    } catch (error) {
      console.error('[LocalAPI] PUT /api/queue/pause error:', error)
      return c.json({ success: false, error: 'Failed to pause' }, 500)
    }
  })

  // POST /api/queue/resume — explicit resume (used by SimpleMobileDashboard)
  app.post('/api/queue/resume', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      if (existing) {
        await db.queueSettings.update({ where: { id: existing.id }, data: { isPaused: false, pausedAt: null } })
      }
      emitEvent('queue:resumed', { agencyId, queueSettings: { isPaused: false } })
      logPendingMutation('POST', '/api/queue/resume', {}, { isPaused: false }).catch(() => {})
      return c.json({ success: true, isPaused: false })
    } catch (error) {
      console.error('[LocalAPI] /api/queue/resume error:', error)
      return c.json({ success: false, error: 'Failed to resume' }, 500)
    }
  })

  // PUT /api/queue/resume — alias (cloud uses PUT)
  app.put('/api/queue/resume', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      if (existing) {
        await db.queueSettings.update({ where: { id: existing.id }, data: { isPaused: false, pausedAt: null } })
      }
      emitEvent('queue:resumed', { agencyId, queueSettings: { isPaused: false } })
      logPendingMutation('PUT', '/api/queue/resume', {}, { isPaused: false }).catch(() => {})
      return c.json({ success: true, isPaused: false })
    } catch (error) {
      console.error('[LocalAPI] PUT /api/queue/resume error:', error)
      return c.json({ success: false, error: 'Failed to resume' }, 500)
    }
  })

  // POST /api/agency/queue/toggle-pause
  app.post('/api/agency/queue/toggle-pause', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      const currentPaused = existing ? (existing.isPaused === 1 || existing.isPaused === true) : false
      const now = new Date()
      if (existing) {
        await db.queueSettings.update({
          where: { id: existing.id },
          data: { isPaused: !currentPaused, pausedAt: !currentPaused ? now : null },
        })
      } else {
        await db.queueSettings.create({
          data: { agencyId, isPaused: true, pausedAt: now },
        })
      }
      emitEvent('queue:pause-toggled', { agencyId, isPaused: !currentPaused })
      emitEvent(!currentPaused ? 'queue:paused' : 'queue:resumed', { agencyId, queueSettings: { isPaused: !currentPaused } })
      logPendingMutation('POST', '/api/agency/queue/toggle-pause', {}, { isPaused: !currentPaused }).catch(() => {})
      return c.json({ success: true, isPaused: !currentPaused })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue/toggle-pause error:', error)
      return c.json({ success: false, error: 'Failed to toggle pause' }, 500)
    }
  })

  // POST /api/agency/queue/walk-in — create walk-in reservation
  app.post('/api/agency/queue/walk-in', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      const body = await c.req.json().catch(() => ({}))
      const { customerName, serviceId, phone } = body
      if (!serviceId || !customerName) {
        return c.json({ success: false, error: 'Service and name are required' }, 400)
      }

      // Get next queue number
      const service = await db.service.findUnique({ where: { id: serviceId } })
      const prefix = service?.prefix || 'A'
      const now = new Date()
      const todayCount = await db.reservation.count({
        where: { agencyId, serviceId, joinedAt: { gte: todayStartMs() } },
      })
      const queueNumber = `${prefix}${String(todayCount + 1).padStart(3, '0')}`

      const reservation = await db.reservation.create({
        data: {
          id: require('crypto').randomUUID(),
          agencyId,
          serviceId,
          userId: sessionUser.id,
          queueNumber: todayCount + 1,
          displayNumber: queueNumber,
          status: 'WAITING',
          walkInCustomerName: customerName,
          isWalkIn: true,
          joinedAt: now,
          estimatedWait: 0,
        },
      })

      emitEvent('queue:joined', { agencyId, reservation })
      logPendingMutation('POST', '/api/agency/queue/walk-in', body, reservation).catch(() => {})
      return c.json({ success: true, reservation })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue/walk-in error:', error)
      return c.json({ success: false, error: 'Failed to create walk-in' }, 500)
    }
  })

  // GET /api/agency/announcements — list announcements
  app.get('/api/agency/announcements', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      const announcements = await db.announcement.findMany({
        where: { agencyId, isActive: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
      return c.json({ announcements })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/announcements error:', error)
      return c.json({ success: false, error: 'Failed to load announcements' }, 500)
    }
  })

  // POST /api/agency/announcements — create announcement
  app.post('/api/agency/announcements', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const body = await c.req.json()
      const { title, message, type } = body
      if (!title || !message) return c.json({ success: false, error: 'Title and message required' }, 400)
      const announcement = await db.announcement.create({
        data: {
          agencyId,
          title,
          message,
          type: type || 'INFO',
          isActive: true,
        },
      })
      emitEvent('announcement:created', { agencyId, announcement })
      logPendingMutation('POST', '/api/agency/announcements', body, announcement).catch(() => {})
      return c.json({ success: true, data: announcement }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create announcement error:', error)
      return c.json({ success: false, error: 'Failed to create announcement' }, 500)
    }
  })

  // DELETE /api/agency/announcements?id= — delete announcement
  app.delete('/api/agency/announcements', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const id = c.req.query('id')
      if (!id) return c.json({ success: false, error: 'Announcement id required' }, 400)
      const existing = await db.announcement.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'Announcement not found' }, 404)
      await db.announcement.delete({ where: { id } })
      logPendingMutation('DELETE', '/api/agency/announcements', { id }, null).catch(() => {})
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] Delete announcement error:', error)
      return c.json({ success: false, error: 'Failed to delete announcement' }, 500)
    }
  })

  // GET /api/agency/analytics — service analytics
  app.get('/api/agency/analytics', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      const startMs = todayStartMs()
      const endMs = todayEndMs()
      const services = await db.service.findMany({ where: { agencyId, isActive: true } })
      const result = services.map(async (s) => {
        const [completed, avgWaitAgg] = await Promise.all([
          db.reservation.count({
            where: { agencyId, serviceId: s.id, status: 'COMPLETED', completedAt: { gte: startMs, lte: endMs } },
          }),
          db.reservation.aggregate({
            where: { agencyId, serviceId: s.id, status: 'COMPLETED', completedAt: { gte: startMs, lte: endMs }, waitTime: { not: null } },
            _avg: { waitTime: true },
          }),
        ])
        return {
          serviceId: s.id,
          name: s.name,
          prefix: s.prefix,
          count: completed,
          avgWaitTime: Math.round(avgWaitAgg._avg.waitTime || 0),
        }
      })
      return c.json({ success: true, services: await Promise.all(result) })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/analytics error:', error)
      return c.json({ success: false, error: 'Failed to load analytics' }, 500)
    }
  })

  // GET /api/agency/history — reservation history
  // Matches the cloud API response format expected by AgencyHistorySheet:
  //   { reservations: [...], total: N, page: N, limit: N, totalPages: N }
  app.get('/api/agency/history', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      const status = c.req.query('status')
      const search = c.req.query('search')
      const page = parseInt(c.req.query('page') || '1', 10)
      const limit = parseInt(c.req.query('limit') || '20', 10)
      const skip = (page - 1) * limit
      const where = { agencyId }
      if (status && status !== 'ALL') where.status = status
      if (search) {
        where.OR = [
          { walkInCustomerName: { contains: search } },
          { displayNumber: { contains: search } },
        ]
      }

      const [reservations, total] = await Promise.all([
        db.reservation.findMany({
          where,
          orderBy: { joinedAt: 'desc' },
          take: limit,
          skip,
        }),
        db.reservation.count({ where }),
      ])
      const totalPages = Math.max(1, Math.ceil(total / limit))
      return c.json({
        success: true,
        reservations,
        total,
        page,
        limit,
        totalPages,
      })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/history error:', error)
      return c.json({ success: false, error: 'Failed to load history' }, 500)
    }
  })

  // GET /api/agency/history/:id — single reservation detail (for history sheet detail view)
  app.get('/api/agency/history/:id', authMiddleware, async (c) => {
    try {
      const reservationId = c.req.param('id')
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

      const reservation = await db.reservation.findUnique({
        where: { id: reservationId },
      })
      if (!reservation || reservation.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Reservation not found' }, 404)
      }

      // Enrich with service, counter, and user data in parallel
      const [service, counter, user, review] = await Promise.all([
        reservation.serviceId
          ? db.service.findUnique({ where: { id: reservation.serviceId } }).catch(() => null)
          : Promise.resolve(null),
        reservation.counterId
          ? db.counter.findUnique({ where: { id: reservation.counterId } }).catch(() => null)
          : Promise.resolve(null),
        reservation.userId
          ? db.user.findUnique({ where: { id: reservation.userId } }).catch(() => null)
          : Promise.resolve(null),
        // Check for review linked to this reservation
        db.review.findFirst({ where: { agencyId, reservationId: reservation.id } }).catch(() => null),
      ])

      return c.json({
        success: true,
        data: {
          ...reservation,
          // Service enrichment
          serviceName: service?.name || null,
          serviceNameAr: service?.nameAr || null,
          serviceNameFr: service?.nameFr || null,
          // Counter enrichment
          counterName: counter?.name || null,
          counterNumber: counter?.number || null,
          // User enrichment
          customerPhone: user?.phoneNumber || null,
          customerName: user?.fullName || reservation.walkInCustomerName || null,
          customerEmail: user?.email || null,
          // All timestamps
          joinedAt: reservation.joinedAt,
          calledAt: reservation.calledAt || null,
          completedAt: reservation.completedAt || null,
          cancelledAt: reservation.cancelledAt || null,
          skippedAt: reservation.skippedAt || null,
          // Review info
          review: review ? {
            id: review.id,
            rating: review.rating,
            comment: review.comment,
            replyText: review.replyText,
            repliedAt: review.repliedAt,
            createdAt: review.createdAt,
          } : null,
        },
      })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/history/:id error:', error)
      return c.json({ success: false, error: 'Failed to load reservation' }, 500)
    }
  })

  // GET /api/agency/subscription — subscription status from local Agency record
  // Subscription data (tier, status, dates) is embedded in the Agency table and
  // synced to local SQLite at login. SubscriptionPlan catalog and Transaction
  // history are queried from the local DB (synced via background sync).
  // Payment/cancellation/unsubscribe actions require cloud — not available offline.
  app.get('/api/agency/subscription', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      // Pre-load plans/transactions even for early-return paths
      const [fallbackPlans, fallbackTxns] = await Promise.all([
        db.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }).catch(() => []),
        agencyId ? db.transaction.findMany({ where: { agencyId }, orderBy: { createdAt: 'desc' }, take: 10 }).catch(() => []) : Promise.resolve([]),
      ])
      if (!agencyId) {
        return c.json({
          currentPlan: 'BASIC',
          status: 'INACTIVE',
          subscriptionStartsAt: null,
          subscriptionExpiresAt: null,
          daysRemaining: null,
          isExpired: false,
          isExpiringSoon: false,
          availablePlans: fallbackPlans,
          recentTransactions: fallbackTxns,
        })
      }

      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        select: {
          subscriptionTier: true,
          subscriptionStatus: true,
          subscriptionStartsAt: true,
          subscriptionExpiresAt: true,
        },
      })

      if (!agency) {
        return c.json({
          currentPlan: 'BASIC',
          status: 'INACTIVE',
          subscriptionStartsAt: null,
          subscriptionExpiresAt: null,
          daysRemaining: null,
          isExpired: false,
          isExpiringSoon: false,
          availablePlans: fallbackPlans,
          recentTransactions: fallbackTxns,
        })
      }

      // Calculate expiry flags (mirrors cloud's checkSubscriptionExpiry logic)
      const now = new Date()
      const expiresAt = agency.subscriptionExpiresAt
      let isExpired = false
      let isExpiringSoon = false
      let daysRemaining = null
      let status = agency.subscriptionStatus

      if (expiresAt) {
        const diffMs = expiresAt.getTime() - now.getTime()
        daysRemaining = Math.max(0, Math.ceil(diffMs / 86400000))
        isExpired = diffMs <= 0
        isExpiringSoon = !isExpired && daysRemaining <= 7
        if (isExpired && status === 'ACTIVE') {
          status = 'EXPIRED'
        }
      }

      // Query available plans and recent transactions from local DB
      const [availablePlans, recentTransactions] = await Promise.all([
        db.subscriptionPlan.findMany({
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
        }).catch(() => []),
        db.transaction.findMany({
          where: { agencyId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }).catch(() => []),
      ])

      return c.json({
        currentPlan: agency.subscriptionTier || 'BASIC',
        status,
        subscriptionStartsAt: agency.subscriptionStartsAt?.toISOString() ?? null,
        subscriptionExpiresAt: agency.subscriptionExpiresAt?.toISOString() ?? null,
        daysRemaining,
        isExpired,
        isExpiringSoon,
        availablePlans,
        recentTransactions,
      })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/subscription error:', error)
      return c.json({ success: false, error: 'Failed to load subscription' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 13b. ADDITIONAL MISSING AGENCY ROUTES (offline parity with cloud API)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/branches/:id — single branch with counters
  app.get('/api/agency/branches/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const id = c.req.param('id')
      const branch = await db.branch.findUnique({
        where: { id },
        include: {
          counters: {
            where: { isActive: true },
            include: {
              staff: { include: { user: { select: { fullName: true, username: true } } } },
            },
            orderBy: { number: 'asc' },
          },
          _count: { select: { staff: true } },
        },
      })
      if (!branch || branch.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Branch not found' }, 404)
      }
      return c.json({ success: true, branch })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/branches/:id error:', error)
      return c.json({ success: false, error: 'Failed to load branch' }, 500)
    }
  })

  // POST /api/agency/branches/:id/counters — create counter under branch
  app.post('/api/agency/branches/:id/counters', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const branchId = c.req.param('id')
      const body = await c.req.json()
      const { number, name, nameAr, nameFr } = body
      if (!number || !name) return c.json({ success: false, error: 'number and name required' }, 400)
      // Verify branch ownership
      const branch = await db.branch.findUnique({ where: { id: branchId } })
      if (!branch || branch.agencyId !== agencyId) return c.json({ success: false, error: 'Branch not found' }, 404)
      // Check duplicate
      const existing = await db.counter.findFirst({ where: { branchId, number } })
      if (existing) return c.json({ success: false, error: 'Counter number already exists in this branch' }, 409)
      const counter = await db.counter.create({
        data: { number, name, nameAr: nameAr || null, nameFr: nameFr || null, branchId },
      })
      emitEvent('counter:created', { agencyId, counterId: counter.id, branchId })
      logPendingMutation('POST', '/api/agency/branches/:id/counters', body, counter).catch(() => {})
      return c.json({ success: true, counter }, 201)
    } catch (error) {
      console.error('[LocalAPI] /api/agency/branches/:id/counters POST error:', error)
      return c.json({ success: false, error: 'Failed to create counter' }, 500)
    }
  })

  // PATCH /api/agency/branches/:id/counters/:counterId — update counter
  app.patch('/api/agency/branches/:id/counters/:counterId', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const branchId = c.req.param('id')
      const counterId = c.req.param('counterId')
      const counter = await db.counter.findUnique({ where: { id: counterId }, include: { branch: true } })
      if (!counter || counter.branchId !== branchId || counter.branch.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Counter not found' }, 404)
      }
      const body = await c.req.json()
      const allowedFields = ['name', 'nameAr', 'nameFr', 'isActive', 'staffId']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) updateData[field] = body[field]
      }
      const updated = await db.counter.update({ where: { id: counterId }, data: updateData })
      emitEvent('counter:updated', { agencyId, counterId, branchId })
      logPendingMutation('PATCH', `/api/agency/branches/${branchId}/counters/${counterId}`, body, updated).catch(() => {})
      return c.json({ success: true, counter: updated })
    } catch (error) {
      console.error('[LocalAPI] PATCH counter error:', error)
      return c.json({ success: false, error: 'Failed to update counter' }, 500)
    }
  })

  // PATCH /api/agency/profile — alias for PUT (cloud uses PATCH)
  app.patch('/api/agency/profile', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const body = await c.req.json()
      const allowedFields = ['name', 'nameAr', 'nameFr', 'phone', 'description', 'descriptionAr', 'descriptionFr', 'address', 'category', 'website', 'logoUrl']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) updateData[field] = body[field]
      }
      if (Object.keys(updateData).length === 0) return c.json({ success: false, error: 'No valid fields to update' }, 400)
      await db.agency.update({ where: { id: agencyId }, data: updateData })
      emitEvent('agency:updated', { agencyId, ...updateData })
      logPendingMutation('PATCH', '/api/agency/profile', body, updateData).catch(() => {})
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] PATCH /api/agency/profile error:', error)
      return c.json({ success: false, error: 'Failed to update profile' }, 500)
    }
  })

  // GET /api/agency/daily-chart — hourly chart data for today
  app.get('/api/agency/daily-chart', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: true, data: [] })
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const reservations = await db.reservation.findMany({
        where: { agencyId, joinedAt: { gte: today } },
        select: { joinedAt: true, completedAt: true, status: true },
      })
      const hourlyData = []
      for (let h = 7; h <= 22; h++) {
        // count = reservations that joined in this hour
        const joinedInHour = reservations.filter((r) => new Date(r.joinedAt).getHours() === h)
        // completed = reservations whose completedAt falls in this hour
        const completedInHour = reservations.filter((r) => r.completedAt && new Date(r.completedAt).getHours() === h)
        hourlyData.push({ hour: h, count: joinedInHour.length, completed: completedInHour.length })
      }
      return c.json({ success: true, data: hourlyData })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/daily-chart error:', error)
      return c.json({ success: true, data: [] })
    }
  })

  // PATCH /api/agency/settings — update agency settings
  app.patch('/api/agency/settings', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency found' }, 404)
      const body = await c.req.json()
      const updateData = {}
      if (body.avgServiceTime !== undefined) updateData.averageServiceTime = body.avgServiceTime
      if (body.maxQueueSize !== undefined) updateData.maxActiveReservations = body.maxQueueSize
      if (body.isQueueOpen !== undefined) updateData.isQueueOpen = Boolean(body.isQueueOpen)
      if (body.workingHoursStart !== undefined) updateData.workingHoursStart = body.workingHoursStart
      if (body.workingHoursEnd !== undefined) updateData.workingHoursEnd = body.workingHoursEnd
      if (body.autoPauseWhenFull !== undefined) updateData.autoPauseWhenFull = Boolean(body.autoPauseWhenFull)
      if (body.kioskModeEnabled !== undefined) updateData.kioskModeEnabled = Boolean(body.kioskModeEnabled)
      if (Object.keys(updateData).length === 0) return c.json({ success: false, error: 'No valid fields to update' }, 400)
      const updated = await db.agency.update({ where: { id: agencyId }, data: updateData })
      emitEvent('agency:updated', { agencyId, action: 'settings-updated', ...updateData })
      logPendingMutation('PATCH', '/api/agency/settings', body, updated).catch(() => {})
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] PATCH /api/agency/settings error:', error)
      return c.json({ success: false, error: 'Failed to update settings' }, 500)
    }
  })

  // POST /api/agency/staff — add existing user as staff by username
  app.post('/api/agency/staff', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'agencyId required' }, 400)
      const { agencyId: bodyAgencyId, username } = await c.req.json()
      const targetAgencyId = bodyAgencyId || agencyId
      if (!username) return c.json({ success: false, error: 'username required' }, 400)
      // Find user by username
      const user = await db.user.findUnique({ where: { username: username.trim() } })
      if (!user) return c.json({ success: false, error: 'User not found' }, 404)
      // Check if already staff
      const existing = await db.agencyStaff.findUnique({
        where: { userId_agencyId: { userId: user.id, agencyId: targetAgencyId } },
      })
      if (existing) return c.json({ success: false, error: 'Staff already exists in this agency' }, 409)
      const staff = await db.agencyStaff.create({
        data: { userId: user.id, agencyId: targetAgencyId, role: user.role === 'AGENCY_OWNER' ? 'OWNER' : 'STAFF' },
        include: { user: { select: { id: true, username: true, fullName: true, role: true } } },
      })
      emitEvent('staff:updated', { agencyId: targetAgencyId, action: 'staff-added', staffId: staff.id })
      logPendingMutation('POST', '/api/agency/staff', { username }, staff).catch(() => {})
      return c.json({ staff }, 201)
    } catch (error) {
      console.error('[LocalAPI] POST /api/agency/staff error:', error)
      return c.json({ success: false, error: 'Failed to add staff' }, 500)
    }
  })

  // DELETE /api/agency/staff?staffId=xxx&agencyId=xxx — remove staff by query param
  app.delete('/api/agency/staff', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'agencyId required' }, 400)
      const staffId = c.req.query('staffId')
      const queryAgencyId = c.req.query('agencyId') || agencyId
      if (!staffId) return c.json({ success: false, error: 'staffId required' }, 400)
      const staffMember = await db.agencyStaff.findUnique({ where: { id: staffId } })
      if (!staffMember) return c.json({ success: false, error: 'Staff member not found' }, 404)
      if (staffMember.agencyId !== queryAgencyId) return c.json({ success: false, error: 'Staff not in this agency' }, 403)
      if (staffMember.role === 'OWNER') return c.json({ success: false, error: 'Cannot remove agency owner' }, 403)
      await db.agencyStaff.delete({ where: { id: staffId } })
      emitEvent('staff:updated', { agencyId: queryAgencyId, action: 'staff-removed', staffId })
      logPendingMutation('DELETE', '/api/agency/staff', { staffId }, null).catch(() => {})
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] DELETE /api/agency/staff error:', error)
      return c.json({ success: false, error: 'Failed to remove staff' }, 500)
    }
  })

  // PATCH /api/agency/staff/:id — update staff member
  app.patch('/api/agency/staff/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency found' }, 403)
      const id = c.req.param('id')
      const body = await c.req.json()
      const staffMember = await db.agencyStaff.findUnique({
        where: { id },
        include: { user: { select: { id: true, username: true, fullName: true, role: true, isActive: true } } },
      })
      if (!staffMember) return c.json({ success: false, error: 'Staff member not found' }, 404)
      if (staffMember.agencyId !== agencyId) return c.json({ success: false, error: 'Not your agency' }, 403)
      if (staffMember.role === 'OWNER') return c.json({ success: false, error: 'Cannot modify owner' }, 403)
      const { fullName, role, isActive, permissions } = body
      // Update user fullName
      if (fullName !== undefined && fullName.trim()) {
        await db.user.update({ where: { id: staffMember.userId }, data: { fullName: fullName.trim() } })
      }
      // Update staff role
      if (role !== undefined && ['STAFF', 'MANAGER'].includes(role)) {
        await db.agencyStaff.update({ where: { id }, data: { role } })
      }
      // Update isActive
      if (isActive !== undefined) {
        await db.user.update({ where: { id: staffMember.userId }, data: { isActive } })
        await db.agencyStaff.update({ where: { id }, data: { isActive } })
      }
      // Update permissions
      if (permissions !== undefined) {
        const currentPerms = staffMember.permissions ? JSON.parse(staffMember.permissions) : {}
        const mergedPerms = { ...currentPerms, ...permissions }
        await db.agencyStaff.update({ where: { id }, data: { permissions: JSON.stringify(mergedPerms) } })
      }
      // Fetch updated
      const updated = await db.agencyStaff.findUnique({
        where: { id },
        include: { user: { select: { id: true, username: true, fullName: true, role: true, isActive: true } } },
      })
      emitEvent('staff:updated', { agencyId, action: 'staff-updated', staffId: id })
      logPendingMutation('PATCH', `/api/agency/staff/${id}`, body, updated).catch(() => {})
      return c.json({ staff: updated, success: true })
    } catch (error) {
      console.error('[LocalAPI] PATCH /api/agency/staff/:id error:', error)
      return c.json({ success: false, error: 'Failed to update staff' }, 500)
    }
  })

  // GET /api/agency/subscription-plans — list available plans
  app.get('/api/agency/subscription-plans', authMiddleware, async (c) => {
    try {
      const plans = await db.subscriptionPlan.findMany({
        where: { isActive: true, isEnterprise: false },
        orderBy: { sortOrder: 'asc' },
        include: { features: true },
      })
      return c.json({ success: true, plans })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/subscription-plans error:', error)
      // If SubscriptionPlan table not yet synced, return empty
      return c.json({ success: true, plans: [] })
    }
  })

  // GET /api/agency/working-hours — get working hours configuration
  app.get('/api/agency/working-hours', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency found' }, 404)
      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        select: { id: true, workingHoursStart: true, workingHoursEnd: true, isQueueOpen: true },
      })
      if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)
      // Also check queueSettings for isPaused state
      const queueSettings = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      const isQueueOpen = agency.isQueueOpen !== false && !(queueSettings?.isPaused)
      return c.json({
        success: true,
        data: {
          workingHoursStart: agency.workingHoursStart || '08:00',
          workingHoursEnd: agency.workingHoursEnd || '17:00',
          isQueueOpen,
        },
      })
    } catch (error) {
      console.error('[LocalAPI] GET /api/agency/working-hours error:', error)
      return c.json({ success: false, error: 'Failed to get working hours' }, 500)
    }
  })

  // PATCH /api/agency/working-hours — update working hours
  app.patch('/api/agency/working-hours', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency found' }, 404)
      const body = await c.req.json()
      const { workingHoursStart, workingHoursEnd } = body
      if (workingHoursStart === undefined && workingHoursEnd === undefined) {
        return c.json({ success: false, error: 'workingHoursStart or workingHoursEnd required' }, 400)
      }
      const updateData = {}
      if (workingHoursStart !== undefined) updateData.workingHoursStart = workingHoursStart
      if (workingHoursEnd !== undefined) updateData.workingHoursEnd = workingHoursEnd
      const updated = await db.agency.update({
        where: { id: agencyId },
        data: updateData,
        select: { id: true, workingHoursStart: true, workingHoursEnd: true },
      })
      emitEvent('agency:updated', { agencyId, action: 'working-hours-updated', ...updateData })
      logPendingMutation('PATCH', '/api/agency/working-hours', body, updated).catch(() => {})
      return c.json(updated)
    } catch (error) {
      console.error('[LocalAPI] PATCH /api/agency/working-hours error:', error)
      return c.json({ success: false, error: 'Failed to update working hours' }, 500)
    }
  })

  // DELETE /api/reviews — delete a review (by body.reviewId)
  app.delete('/api/reviews', authMiddleware, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { reviewId } = body
      if (!reviewId) return c.json({ success: false, error: 'reviewId is required' }, 400)
      const review = await db.review.findUnique({ where: { id: reviewId } })
      if (!review) return c.json({ success: false, error: 'Review not found' }, 404)
      if (review.agencyId !== sessionUser.agencyId && review.userId !== sessionUser.id) {
        return c.json({ success: false, error: 'Not authorized to delete this review' }, 403)
      }
      await db.review.delete({ where: { id: reviewId } })
      emitEvent('review:deleted', { agencyId: review.agencyId, reviewId })
      logPendingMutation('DELETE', '/api/reviews', { reviewId }, null).catch(() => {})
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] DELETE /api/reviews error:', error)
      return c.json({ success: false, error: 'Failed to delete review' }, 500)
    }
  })

  // DELETE /api/agency/reviews — delete a review (agency-scoped alias)
  app.delete('/api/agency/reviews', authMiddleware, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { reviewId } = body
      if (!reviewId) return c.json({ success: false, error: 'reviewId is required' }, 400)
      const review = await db.review.findUnique({ where: { id: reviewId } })
      if (!review) return c.json({ success: false, error: 'Review not found' }, 404)
      if (review.agencyId !== sessionUser.agencyId) {
        return c.json({ success: false, error: 'Not authorized' }, 403)
      }
      await db.review.delete({ where: { id: reviewId } })
      emitEvent('review:deleted', { agencyId: review.agencyId, reviewId })
      logPendingMutation('DELETE', '/api/agency/reviews', { reviewId }, null).catch(() => {})
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] DELETE /api/agency/reviews error:', error)
      return c.json({ success: false, error: 'Failed to delete review' }, 500)
    }
  })

  // POST /api/agency/reviews — create or update review (agency-scoped alias)
  app.post('/api/agency/reviews', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const body = await c.req.json()
      const { rating, comment } = body
      if (!rating || rating < 1 || rating > 5) return c.json({ success: false, error: 'Rating must be 1-5' }, 400)
      // Check if user already reviewed this agency (upsert)
      const existing = await db.review.findUnique({
        where: { userId_agencyId: { userId: sessionUser.id, agencyId } },
      })
      let review
      if (existing) {
        review = await db.review.update({
          where: { id: existing.id },
          data: { rating, comment: comment || null },
          include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
        })
      } else {
        review = await db.review.create({
          data: { agencyId, userId: sessionUser.id, rating, comment: comment || null },
          include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
        })
      }
      emitEvent('review:created', { agencyId, review })
      logPendingMutation('POST', '/api/agency/reviews', body, review).catch(() => {})
      return c.json({
        review: {
          id: review.id, rating: review.rating, comment: review.comment,
          createdAt: review.createdAt, user: review.user,
        },
        updated: !!existing,
      })
    } catch (error) {
      console.error('[LocalAPI] POST /api/agency/reviews error:', error)
      return c.json({ success: false, error: 'Failed to create review' }, 500)
    }
  })

  // GET /api/agency/reviews — list reviews (agency-scoped, matches cloud format)
  app.get('/api/agency/reviews', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const page = parseInt(c.req.query('page') || '1', 10)
      const limit = parseInt(c.req.query('limit') || '10', 10)
      const skip = (page - 1) * limit
      const [reviews, totalReviews] = await Promise.all([
        db.review.findMany({
          where: { agencyId }, orderBy: { createdAt: 'desc' }, skip, take: limit,
          include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
        }),
        db.review.count({ where: { agencyId } }),
      ])
      // Rating distribution from real data
      const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
      const ratingCounts = await Promise.all(
        [1, 2, 3, 4, 5].map((r) => db.review.count({ where: { agencyId, rating: r } }))
      )
      for (let i = 0; i < 5; i++) ratingDistribution[i + 1] = ratingCounts[i]
      const agg = await db.review.aggregate({ where: { agencyId }, _avg: { rating: true } })
      const avgRating = agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0
      return c.json({
        success: true,
        reviews: reviews.map((r) => ({
          id: r.id, rating: r.rating, comment: r.comment,
          replyText: r.replyText, repliedAt: r.repliedAt?.toISOString() ?? null,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          user: r.user ? { id: r.user.id, fullName: r.user.fullName, avatarUrl: r.user.avatarUrl } : { id: '', fullName: 'Unknown' },
        })),
        avgRating, totalReviews, ratingDistribution,
        page, limit,
        hasMore: skip + limit < totalReviews,
      })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/reviews error:', error)
      return c.json({ success: false, reviews: [], avgRating: 0, totalReviews: 0, ratingDistribution: {}, hasMore: false, page: 1, limit: 10 })
    }
  })

  // POST /api/agency/reviews/:id/reply — agency reply to a review
  app.post('/api/agency/reviews/:id/reply', authMiddleware, async (c) => {
    try {
      const reviewId = c.req.param('id')
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const body = await c.req.json()
      const { text } = body
      if (!text?.trim()) return c.json({ success: false, error: 'Reply text is required' }, 400)

      const review = await db.review.findUnique({ where: { id: reviewId } })
      if (!review || review.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Review not found' }, 404)
      }

      const updated = await db.review.update({
        where: { id: reviewId },
        data: { replyText: text.trim(), repliedAt: new Date() },
      })
      emitEvent('review:replied', { agencyId, reviewId })
      logPendingMutation('POST', `/api/agency/reviews/${reviewId}/reply`, body, { replyText: text.trim() }).catch(() => {})
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] POST /api/agency/reviews/:id/reply error:', error)
      return c.json({ success: false, error: 'Failed to reply' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 13c. FAVORITES (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/favorites — list user's favorites (local)
  app.get('/api/agency/favorites', authMiddleware, async (c) => {
    try {
      const favorites = await db.favorite.findMany({
        where: { userId: sessionUser.id },
        orderBy: { createdAt: 'desc' },
      })
      return c.json({ success: true, data: favorites })
    } catch (error) {
      console.error('[LocalAPI] List favorites error:', error)
      return c.json({ success: false, error: 'Failed to list favorites' }, 500)
    }
  })

  // POST /api/agency/favorites — add favorite
  app.post('/api/agency/favorites', authMiddleware, async (c) => {
    try {
      const body = await c.req.json()
      const { agencyId: targetAgencyId } = body
      if (!targetAgencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)
      const existing = await db.favorite.findFirst({ where: { userId: sessionUser.id, agencyId: targetAgencyId } })
      if (existing) return c.json({ success: true, data: existing })
      const favorite = await db.favorite.create({ data: { userId: sessionUser.id, agencyId: targetAgencyId } })
      emitEvent('favorite:added', { userId: sessionUser.id, agencyId: targetAgencyId })
      logPendingMutation('POST', '/api/agency/favorites', body, favorite).catch(() => {})
      return c.json({ success: true, data: favorite }, 201)
    } catch (error) {
      console.error('[LocalAPI] Add favorite error:', error)
      return c.json({ success: false, error: 'Failed to add favorite' }, 500)
    }
  })

  // DELETE /api/agency/favorites — remove favorite
  app.delete('/api/agency/favorites', authMiddleware, async (c) => {
    try {
      const agencyIdTarget = c.req.query('agencyId')
      if (!agencyIdTarget) return c.json({ success: false, error: 'agencyId query param required' }, 400)
      const existing = await db.favorite.findFirst({ where: { userId: sessionUser.id, agencyId: agencyIdTarget } })
      if (!existing) return c.json({ success: false, error: 'Favorite not found' }, 404)
      await db.favorite.delete({ where: { id: existing.id } })
      emitEvent('favorite:removed', { userId: sessionUser.id, agencyId: agencyIdTarget })
      logPendingMutation('DELETE', '/api/agency/favorites', { agencyId: agencyIdTarget }, { id: existing.id }).catch(() => {})
      return c.json({ success: true, data: { id: existing.id, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] Remove favorite error:', error)
      return c.json({ success: false, error: 'Failed to remove favorite' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 13d. FAQs (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/faqs — list FAQs
  app.get('/api/agency/faqs', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const faqs = await db.fAQ.findMany({ where: { agencyId }, orderBy: { createdAt: 'asc' } })
      return c.json({ success: true, data: faqs })
    } catch (error) {
      console.error('[LocalAPI] List FAQs error:', error)
      return c.json({ success: false, error: 'Failed to list FAQs' }, 500)
    }
  })

  // POST /api/agency/faqs — create FAQ
  app.post('/api/agency/faqs', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const body = await c.req.json()
      const { question, answer, questionFr, answerFr, questionAr, answerAr } = body
      if (!question || !answer) return c.json({ success: false, error: 'question and answer are required' }, 400)
      const faq = await db.fAQ.create({ data: { agencyId, question, answer, questionFr: questionFr || null, answerFr: answerFr || null, questionAr: questionAr || null, answerAr: answerAr || null } })
      emitEvent('faq:created', { agencyId, faq })
      logPendingMutation('POST', '/api/agency/faqs', body, faq).catch(() => {})
      return c.json({ success: true, data: faq }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create FAQ error:', error)
      return c.json({ success: false, error: 'Failed to create FAQ' }, 500)
    }
  })

  // PATCH /api/agency/faqs/:id — update FAQ
  app.patch('/api/agency/faqs/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const id = c.req.param('id')
      const existing = await db.fAQ.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'FAQ not found' }, 404)
      const body = await c.req.json()
      const allowedFields = ['question', 'answer', 'questionFr', 'answerFr', 'questionAr', 'answerAr']
      const updateData = {}
      for (const field of allowedFields) { if (body[field] !== undefined) updateData[field] = body[field] }
      const updated = await db.fAQ.update({ where: { id }, data: updateData })
      emitEvent('faq:updated', { agencyId, faqId: id })
      logPendingMutation('PATCH', '/api/agency/faqs/:id', body, updated).catch(() => {})
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Update FAQ error:', error)
      return c.json({ success: false, error: 'Failed to update FAQ' }, 500)
    }
  })

  // DELETE /api/agency/faqs/:id — delete FAQ
  app.delete('/api/agency/faqs/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const id = c.req.param('id')
      const existing = await db.fAQ.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'FAQ not found' }, 404)
      await db.fAQ.delete({ where: { id } })
      emitEvent('faq:deleted', { agencyId, faqId: id })
      logPendingMutation('DELETE', '/api/agency/faqs/:id', {}, { id }).catch(() => {})
      return c.json({ success: true, data: { id, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] Delete FAQ error:', error)
      return c.json({ success: false, error: 'Failed to delete FAQ' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 13e. TRANSACTIONS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/transactions — list transactions
  app.get('/api/agency/transactions', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const { take, skip } = parsePagination(c)
      const transactions = await db.transaction.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      })
      return c.json({ success: true, data: transactions })
    } catch (error) {
      console.error('[LocalAPI] List transactions error:', error)
      return c.json({ success: false, error: 'Failed to list transactions' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 14. SYNC STATUS (no auth)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/sync/status — LAN discovery endpoint probed by the sync engine.
  // The sync engine (db/sync.ts _probeSyncEndpoint) fetches /api/sync/status and
  // checks for { service: 'blasti-lan-sync' } or { local: { ready: true } }.
  // Without this route, the sync engine never discovers the local API,
  // so WatermelonDB never syncs → offline mode has no data.
  app.get('/api/sync/status', (c) => {
    return c.json({
      service: 'blasti-lan-sync',
      local: { ready: !!db, mode: 'sqlite' },
      sessionActive: !!sessionToken,
      isSyncing: _isSyncing || false,
      lastSyncAt: _lastSyncAt || null,
      pendingMutations: _pendingMutationsCount || 0,
      lastPulledSequence: _lastPulledSequence || 0,
      lastPushedSequence: _lastPushedSequence || 0,
      syncProtocolVersion: _syncProtocolVersion,
      syncModelCount: _syncModelCount,
    })
  })

  // POST /api/sync/trigger — manual sync trigger (used by desktop frontend)
  app.post('/api/sync/trigger', requireAuth(), async (c) => {
    try {
      // Trigger the sync service if available
      const syncService = require('./sync-service')
      if (syncService.triggerSyncNow) {
        const result = await syncService.triggerSyncNow()
        // If sync succeeded, update cloud contact time
        if (result?.success !== false) {
          _lastCloudContactAt = _safeTimestamp()
          _persistCloudContact()
        }
        return c.json({ success: true, message: 'Sync triggered', result })
      }
      return c.json({ success: false, error: 'Sync service not available' }, 503)
    } catch (e) {
      return c.json({ success: false, error: e.message || 'Sync trigger failed' }, 500)
    }
  })

  // GET /api/sync-status — local sync status for diagnosis panel
  app.get('/api/sync-status', async (c) => {
    const offlineDuration = _lastCloudContactAt ? _safeTimestamp() - _lastCloudContactAt : null

    // Actually check cloud health with a 3-second timeout
    let cloudConnected = false
    try {
      const cloudUrl = getCloudUrl()
      const healthUrl = `${cloudUrl}/health`
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(healthUrl, { signal: controller.signal })
      clearTimeout(timeout)
      cloudConnected = res.ok
    } catch (_) {
      cloudConnected = false
    }

    return c.json({
      success: true,
      localReady: !!db,
      sessionActive: !!sessionToken,
      cloudConnected,
      lastSyncAt: _lastSyncAt || null,
      lastCloudContactAt: _lastCloudContactAt || null,
      offlineDurationMs: offlineDuration,
      offlineDays: offlineDuration ? Math.floor(offlineDuration / (24 * 60 * 60 * 1000)) : null,
      offlineTokenRemainingMs: offlineDuration ? Math.max(0, OFFLINE_TOKEN_MAX_MS - offlineDuration) : null,
      pendingMutations: _pendingMutationsCount || 0,
    })
  })

  // GET /api/db-status — database diagnostics for the diagnosis panel
  app.get('/api/db-status', async (c) => {
    if (!db) {
      return c.json({ success: false, error: 'Database not initialized', tables: 0 }, 503)
    }
    try {
      // Count tables and records in the local SQLite database
      const tablesResult = await db.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      const tables = tablesResult ? tablesResult.map(r => r.name) : []
      
      // Get record counts for key tables
      const counts = {}
      for (const table of tables) {
        try {
          const r = await db.$queryRawUnsafe(`SELECT COUNT(*) as cnt FROM \"${table}\"`)
          // Prisma may return BigInt for COUNT(*) — convert to Number for JSON serialization
          const raw = Array.isArray(r) ? r[0]?.cnt : r?.cnt
          counts[table] = typeof raw === 'bigint' ? Number(raw) : (raw || 0)
        } catch {
          counts[table] = -1 // error
        }
      }
      
      return c.json({
        success: true,
        tables: tables.length,
        tableNames: tables,
        counts,
        mode: 'sqlite',
        sessionActive: !!sessionToken,
        user: sessionUser ? { id: sessionUser.id, username: sessionUser.username, role: sessionUser.role } : null,
      })
    } catch (err) {
      return c.json({ success: false, error: String(err), tables: 0 }, 500)
    }
  })

  // GET /api/cloud-health — check if local API can reach the cloud API
  // This endpoint is used by the diagnosis panel to verify local→cloud connectivity
  app.get('/api/cloud-health', async (c) => {
    const cloudUrl = getCloudUrl()
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2000)
      const res = await fetch(`${cloudUrl}/health`, { signal: controller.signal })
      clearTimeout(timer)
      return c.json({
        success: res.ok,
        cloudReachable: true,
        cloudUrl,
        statusCode: res.status,
        latency: null, // measured externally
      })
    } catch (err) {
      return c.json({
        success: false,
        cloudReachable: false,
        cloudUrl,
        error: err.message || 'Connection failed',
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 15. ADDITIONAL OFFLINE ROUTES
  // ═══════════════════════════════════════════════════════════════════════

  // NOTE: /api/agency/queue/call-next is handled by /api/queue/call-next above (same logic)

  // POST /api/agency/queue/walk-in-token — QR-based walk-in token call
  app.post('/api/agency/queue/walk-in-token', authMiddleware, requireActiveSubscription(), async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const body = await c.req.json().catch(() => ({}))
      const { importToken } = body
      if (!importToken) return c.json({ success: false, error: 'importToken required' }, 400)
      // Look up reservation by the 6-digit token code (stored in displayNumber or importToken)
      const reservation = await db.reservation.findFirst({
        where: {
          agencyId,
          OR: [
            { displayNumber: String(importToken) },
            { importToken: String(importToken) },
          ],
        },
      })
      if (!reservation) return c.json({ success: false, error: 'Invalid token — reservation not found' }, 404)
      if (reservation.status !== 'WAITING') {
        return c.json({ success: false, error: `Token already used or reservation is ${reservation.status}` }, 400)
      }
      // Update reservation status to CALLED
      const now = new Date()
      const updated = await db.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'CALLED',
          calledAt: now,
          updatedAt: now,
        },
      })
      // Update queueSettings.currentServingNumber
      const qs = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      if (qs) {
        await db.queueSettings.update({
          where: { id: qs.id },
          data: { currentServingNumber: reservation.queueNumber },
        }).catch(() => {})
      }
      emitEvent('queue:called', { agencyId, reservation: updated, counterId: null })
      logPendingMutation('POST', '/api/agency/queue/walk-in-token', body, updated).catch(() => {})
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] walk-in-token error:', error)
      return c.json({ success: false, error: 'Failed to process walk-in token' }, 500)
    }
  })

  // PATCH /api/agency/services/:id — update service
  app.patch('/api/agency/services/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const id = c.req.param('id')
      const body = await c.req.json()
      const existing = await db.service.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'Service not found' }, 404)
      const allowedFields = ['name', 'prefix', 'description', 'isActive'] // estimatedDuration removed — not a Service schema field
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) updateData[field] = body[field]
      }
      if (Object.keys(updateData).length === 0) return c.json({ success: false, error: 'No valid fields' }, 400)
      const updated = await db.service.update({ where: { id }, data: updateData })
      emitEvent('service:updated', { agencyId, serviceId: id, ...updateData })
      logPendingMutation('PATCH', '/api/agency/services/:id', body, updated).catch(() => {})
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] PATCH service error:', error)
      return c.json({ success: false, error: 'Failed to update service' }, 500)
    }
  })

  // DELETE /api/agency/services/:id — soft-delete service
  app.delete('/api/agency/services/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const id = c.req.param('id')
      const existing = await db.service.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'Service not found' }, 404)
      await db.service.update({ where: { id }, data: { isActive: false } })
      emitEvent('service:deleted', { agencyId, serviceId: id })
      logPendingMutation('DELETE', '/api/agency/services/:id', {}, { id }).catch(() => {})
      return c.json({ success: true, data: { id, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] DELETE service error:', error)
      return c.json({ success: false, error: 'Failed to delete service' }, 500)
    }
  })

  // POST /api/agency/staff/create — add staff member
  app.post('/api/agency/staff/create', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const body = await c.req.json()
      const { userId, role, permissions, isActive } = body
      if (!userId) return c.json({ success: false, error: 'userId is required' }, 400)
      // Verify user exists
      const user = await db.user.findUnique({ where: { id: userId } })
      if (!user) return c.json({ success: false, error: 'User not found' }, 404)
      // Check if already a member
      const existing = await db.agencyStaff.findFirst({ where: { agencyId, userId } })
      if (existing) return c.json({ success: false, error: 'User is already a staff member' }, 409)
      const staff = await db.agencyStaff.create({
        data: {
          agencyId,
          userId,
          role: role || 'AGENCY_STAFF',
          permissions: permissions || null,
          isActive: isActive !== undefined ? Boolean(isActive) : true,
          joinedAt: new Date(),
        },
      })
      emitEvent('staff:created', { agencyId, staff })
      logPendingMutation('POST', '/api/agency/staff/create', body, staff).catch(() => {})
      return c.json({ success: true, data: staff }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create staff error:', error)
      return c.json({ success: false, error: 'Failed to create staff' }, 500)
    }
  })

  // NOTE: /api/agency/staff/:id PATCH is handled by the standalone route above

  // DELETE /api/agency/staff/:id — remove staff
  app.delete('/api/agency/staff/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const id = c.req.param('id')
      const existing = await db.agencyStaff.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'Staff not found' }, 404)
      await db.agencyStaff.delete({ where: { id } })
      emitEvent('staff:deleted', { agencyId, staffId: id })
      logPendingMutation('DELETE', '/api/agency/staff/:id', {}, { id }).catch(() => {})
      return c.json({ success: true, data: { id, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] DELETE staff error:', error)
      return c.json({ success: false, error: 'Failed to delete staff' }, 500)
    }
  })

  // GET /api/agency/qr-code — QR code info
  app.get('/api/agency/qr-code', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const agency = await db.agency.findUnique({ where: { id: agencyId } })
      if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

      // Build the public queue URL from the agency's customCode
      const displayUrl = `https://blasti.vercel.app/queue/${agency.customCode}`

      // Try to generate a QR code SVG using the 'qrcode' package if available
      let qrCodeSvg = null
      try {
        const QRCode = require('qrcode')
        qrCodeSvg = await QRCode.toString(displayUrl, { type: 'svg', width: 256, margin: 2 })
      } catch (_) {
        // qrcode package not available — return URL without SVG
        qrCodeSvg = null
      }

      return c.json({
        success: true,
        data: {
          qrCodeUrl: qrCodeSvg,
          displayUrl,
          agencyName: agency.name,
          customCode: agency.customCode,
          message: qrCodeSvg ? 'QR code generated' : 'QR code URL ready (install qrcode package for SVG)',
        },
      })
    } catch (error) {
      console.error('[LocalAPI] QR code error:', error)
      return c.json({ success: false, error: 'Failed to generate QR' }, 500)
    }
  })

  // GET /api/reviews — list reviews (matches cloud API response format)
  app.get('/api/reviews', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const limit = parseInt(c.req.query('limit') || '100', 10)

      const reviews = await db.review.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true } },
        },
      })

      const totalReviews = await db.review.count({ where: { agencyId } })
      const agg = await db.review.aggregate({
        where: { agencyId },
        _avg: { rating: true },
      })
      const averageRating = agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0

      return c.json({
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          replyText: r.replyText,
          repliedAt: r.repliedAt?.toISOString() ?? null,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          userId: r.userId,
          agencyId: r.agencyId,
          user: r.user ? { id: r.user.id, fullName: r.user.fullName, avatarUrl: r.user.avatarUrl } : { id: '', fullName: 'Unknown' },
        })),
        averageRating,
        totalCount: totalReviews,
      })
    } catch (error) {
      console.error('[LocalAPI] List reviews error:', error)
      return c.json({ reviews: [], averageRating: 0, totalCount: 0 })
    }
  })

  // POST /api/reviews/:id/reply — reply to a review
  app.post('/api/reviews/:id/reply', authMiddleware, async (c) => {
    try {
      const reviewId = c.req.param('id')
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const body = await c.req.json()
      const { text } = body
      if (!text?.trim()) return c.json({ success: false, error: 'Reply text is required' }, 400)

      const review = await db.review.findUnique({ where: { id: reviewId } })
      if (!review || review.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Review not found' }, 404)
      }

      const updated = await db.review.update({
        where: { id: reviewId },
        data: { replyText: text.trim(), repliedAt: new Date() },
      })
      logPendingMutation('POST', `/api/reviews/${reviewId}/reply`, body, { replyText: text.trim() }).catch(() => {})
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Reply to review error:', error)
      return c.json({ success: false, error: 'Failed to reply' }, 500)
    }
  })

  // POST /api/reviews — create review
  app.post('/api/reviews', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const body = await c.req.json()
      const { rating, comment } = body
      if (!rating || rating < 1 || rating > 5) return c.json({ success: false, error: 'Rating must be 1-5' }, 400)
      const review = await db.review.create({
        data: {
          agencyId,
          userId: sessionUser.id,
          rating,
          comment: comment || null,
        },
      })
      emitEvent('review:created', { agencyId, review })
      logPendingMutation('POST', '/api/reviews', body, review).catch(() => {})
      return c.json({ success: true, data: review }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create review error:', error)
      return c.json({ success: false, error: 'Failed to create review' }, 500)
    }
  })

  // GET /api/agency/export-csv — export reservations as CSV
  app.get('/api/agency/export-csv', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const dateFrom = c.req.query('from') || c.req.query('dateFrom')
      const dateTo = c.req.query('to') || c.req.query('dateTo')
      const where = { agencyId }
      if (dateFrom || dateTo) {
        where.joinedAt = {}
        if (dateFrom) where.joinedAt.gte = new Date(dateFrom).getTime()
        if (dateTo) where.joinedAt.lte = new Date(dateTo).getTime()
      }
      const reservations = await db.reservation.findMany({
        where,
        orderBy: { joinedAt: 'desc' },
        take: 5000,
      })
      // Build service lookup map for serviceName resolution
      const serviceIds = [...new Set(reservations.map((r) => r.serviceId).filter(Boolean))]
      const serviceList = serviceIds.length > 0 ? await db.service.findMany({ where: { id: { in: serviceIds } } }).catch(() => []) : []
      const serviceMap = new Map(serviceList.map((s) => [s.id, s.name]))
      // CSV escape: wrap in quotes if contains comma, quote, or newline
      const csvEscape = (val) => {
        const str = String(val ?? '')
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return '"' + str.replace(/"/g, '""') + '"'
        }
        return str
      }
      // Build CSV with full columns matching cloud API format
      const header = 'Queue Number,Customer Name,Service Name,Status,Joined At,Called At,Completed At,Wait Time (min)\n'
      const rows = reservations.map((r) => {
        const queueNumber = r.displayNumber || String(r.queueNumber || '')
        const customerName = r.walkInCustomerName || ''
        const serviceName = serviceMap.get(r.serviceId) || ''
        const joinedAt = r.joinedAt ? new Date(r.joinedAt).toISOString() : ''
        const calledAt = r.calledAt ? new Date(r.calledAt).toISOString() : ''
        const completedAt = r.completedAt ? new Date(r.completedAt).toISOString() : ''
        const waitTime = r.waitTime != null ? String(r.waitTime) : ''
        return [queueNumber, customerName, serviceName, r.status, joinedAt, calledAt, completedAt, waitTime]
          .map(csvEscape).join(',')
      })
      const csv = header + rows.join('\n')
      return c.text(csv, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename=export.csv',
      })
    } catch (error) {
      console.error('[LocalAPI] Export CSV error:', error)
      return c.json({ success: false, error: 'Failed to export CSV' }, 500)
    }
  })

  // NOTE: /api/agency/queue/call/:id is handled by /api/queue/call/:id above (same logic)

  // GET /api/probe — health check used by frontend
  app.get('/api/probe', (c) => {
    return c.json({ success: true, mode: 'local', timestamp: Date.now() })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 16. OFFLINE MUTATION QUEUE (write-ahead log)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/pending-mutations — get pending mutations (for sync service)
  app.get('/api/pending-mutations', authMiddleware, async (c) => {
    const mutations = await getPendingMutations()
    return c.json({ success: true, data: mutations, total: mutations.length })
  })

  // GET /api/pending-mutations/count — quick count
  app.get('/api/pending-mutations/count', (c) => {
    if (!db) return c.json({ success: true, count: 0 })
    db.$queryRawUnsafe('SELECT COUNT(*) as cnt FROM "_pending_mutations" WHERE status = \'pending\'')
      .then(r => c.json({ success: true, count: (r[0]?.cnt || 0) }))
      .catch(() => c.json({ success: true, count: 0 }))
  })

  // Initialize the pending mutations table on startup
  ensurePendingMutationsTable().catch(() => {})

  // ═══════════════════════════════════════════════════════════════════════
  // GLOBAL ERROR HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  app.onError((err, c) => {
    console.error(`[LocalAPI Error] ${c.req.method} ${c.req.path}:`, err)
    const detail = err?.message || String(err)
    // Include error detail so the renderer can log it for debugging
    return c.json({ success: false, error: 'Internal server error', detail }, 500)
  })

  // ── Middleware: require DB ───────────────────────────────────────────
  // NOTE: requireDb middleware removed — requireAuth() already checks for !db at line 187.

  // ═══════════════════════════════════════════════════════════════════════
  // DESKTOP FRONTEND — Static file serving for the dedicated desktop UI
  // ═══════════════════════════════════════════════════════════════════════
  // The desktop frontend is a Vite-built React SPA that ONLY talks to this
  // local API. It's served from the frontend/dist/ directory.
  // This replaces the old architecture where the web app (Next.js) was loaded
  // via Electron and had to failover between cloud and local API.

  const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist')

  // Serve static files from the frontend dist directory
  // This handles all non-API routes (the SPA)
  app.get('/*', async (c) => {
    // Only serve static files for non-API routes
    const urlPath = c.req.path
    if (urlPath.startsWith('/api/')) {
      return c.notFound()
    }

    // Try to serve the exact file first
    let filePath = path.join(FRONTEND_DIST, urlPath)
    if (urlPath === '/' || urlPath === '') {
      filePath = path.join(FRONTEND_DIST, 'index.html')
    }

    try {
      const fs = require('fs')
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath)
        const ext = path.extname(filePath)
        const mimeTypes = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
        }
        const contentType = mimeTypes[ext] || 'application/octet-stream'
        return new Response(content, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
          },
        })
      }

      // SPA fallback: serve index.html for client-side routing
      const indexPath = path.join(FRONTEND_DIST, 'index.html')
      if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath)
        return new Response(indexContent, {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
          },
        })
      }

      return c.json({ success: false, error: 'Frontend not built — run: cd apps/desktop/frontend && bun run build' }, 404)
    } catch (e) {
      return c.json({ success: false, error: 'Frontend not available' }, 404)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CLOUD PROXY — Proxy cloud-only features when online
  // ═══════════════════════════════════════════════════════════════════════
  // The desktop frontend ONLY talks to this local API. For features that
  // require the cloud (registration, password reset, payment), the local API
  // proxies the request to the cloud when online, and returns an error when offline.

  app.post('/api/cloud-proxy/*', requireAuth(), async (c) => {
    const cloudPath = c.req.path.replace('/api/cloud-proxy/', '/api/')
    const cloudBase = getCloudUrl()

    try {
      const body = await c.req.json().catch(() => null)
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': c.req.header('Authorization') || '',
      }

      const cloudUrl = `${cloudBase}${cloudPath}`
      const resp = await fetch(cloudUrl, {
        method: c.req.method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })

      const data = await resp.json()
      return c.json(data, resp.status)
    } catch (e) {
      return c.json({
        success: false,
        error: 'Cloud unavailable — this feature requires internet connection',
        offline: true,
      }, 503)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // ROUTE ALIASES — Frontend compatibility routes
  // These map frontend API client paths to the actual local API routes.
  // Without these, the desktop frontend would get 404s.
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency → alias for /api/agency/profile
  app.get('/api/agency', authMiddleware, async (c) => {
    const agencyId = requireAgencyId(c)
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)
    return c.json({ success: true, data: agency })
  })

  // GET /api/queue → alias for /api/queue/active
  app.get('/api/queue', authMiddleware, async (c) => {
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const waiting = await db.reservation.findMany({
      where: { agencyId, status: 'WAITING' },
      orderBy: { joinedAt: 'asc' },
      take: 100,
    })
    const calledOrServing = await db.reservation.findMany({
      where: { agencyId, status: { in: ['CALLED', 'SERVING'] } },
      orderBy: { calledAt: 'desc' },
    })
    return c.json({ success: true, data: { waiting, active: calledOrServing } })
  })

  // PATCH /api/services/:id → alias for PUT /api/services/:id
  app.patch('/api/services/:id', authMiddleware, async (c) => {
    const { id } = c.req.param()
    try {
      const body = await c.req.json()
      const user = c.get('user')
      const agencyId = user?.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

      const existing = await db.service.findFirst({ where: { id, agencyId } })
      if (!existing) return c.json({ success: false, error: 'Service not found' }, 404)

      const allowedFields = ['name', 'nameAr', 'nameFr', 'description', 'descriptionAr', 'descriptionFr', 'estimatedTime', 'isActive', 'prefix', 'fixedTimeEnabled', 'fixedTimeMinutes']
      const data = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          if (field === 'fixedTimeEnabled') data[field] = !!body[field]
          else data[field] = body[field]
        }
      }
      data.updatedAt = new Date().toISOString()

      const updated = await db.service.update({ where: { id }, data })
      logPendingMutation('update', 'Service', id, data)
      return c.json({ success: true, data: updated })
    } catch (e) {
      return c.json({ success: false, error: e.message }, 500)
    }
  })

  // POST /api/reservations/:id/call → proxy to queue logic
  app.post('/api/reservations/:id/call', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const reservation = await db.reservation.findFirst({ where: { id, agencyId } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    const updated = await db.reservation.update({
      where: { id },
      data: { status: 'CALLED', calledAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    })
    logPendingMutation('update', 'Reservation', id, { status: 'CALLED' })
    return c.json({ success: true, data: updated })
  })

  // POST /api/reservations/:id/complete
  app.post('/api/reservations/:id/complete', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const reservation = await db.reservation.findFirst({ where: { id, agencyId } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    const completedAt = new Date().toISOString()
    const waitTime = reservation.joinedAt ? Math.round((new Date(completedAt) - new Date(reservation.joinedAt)) / 60000) : null
    const updated = await db.reservation.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt, waitTime, updatedAt: completedAt },
    })
    logPendingMutation('update', 'Reservation', id, { status: 'COMPLETED' })
    return c.json({ success: true, data: updated })
  })

  // POST /api/reservations/:id/noshow
  app.post('/api/reservations/:id/noshow', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const reservation = await db.reservation.findFirst({ where: { id, agencyId } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    const updated = await db.reservation.update({
      where: { id },
      data: { status: 'NO_SHOW', updatedAt: new Date().toISOString() },
    })
    logPendingMutation('update', 'Reservation', id, { status: 'NO_SHOW' })
    return c.json({ success: true, data: updated })
  })

  // POST /api/reservations/:id/cancel
  app.post('/api/reservations/:id/cancel', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const reservation = await db.reservation.findFirst({ where: { id, agencyId } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    const updated = await db.reservation.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    })
    logPendingMutation('update', 'Reservation', id, { status: 'CANCELLED' })
    return c.json({ success: true, data: updated })
  })

  // POST /api/reservations/:id/recall
  app.post('/api/reservations/:id/recall', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

    const reservation = await db.reservation.findFirst({ where: { id, agencyId, status: 'CALLED' } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found or not called' }, 404)

    const updated = await db.reservation.update({
      where: { id },
      data: { calledAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    })
    logPendingMutation('update', 'Reservation', id, { action: 'recall' })
    return c.json({ success: true, data: updated })
  })

  // POST /api/reservations/:id/postpone
  app.post('/api/reservations/:id/postpone', authMiddleware, async (c) => {
    try {
      const { id } = c.req.param()
      const user = c.get('user')
      const agencyId = user?.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)

      const reservation = await db.reservation.findFirst({ where: { id, agencyId } })
      if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

      if (!['WAITING', 'CALLED'].includes(reservation.status)) {
        return c.json({ success: false, error: `Cannot postpone reservation with status: ${reservation.status}` }, 400)
      }

      const postponeCount = (reservation.postponeCount || 0) + 1
      const now = new Date()
      let updateData

      if (reservation.status === 'CALLED') {
        // If CALLED, move back to WAITING
        updateData = { status: 'WAITING', postponeCount, updatedAt: now }
      } else {
        // If WAITING, move to end of queue — get the highest queueNumber and re-assign
        const maxReservation = await db.reservation.findFirst({
          where: { agencyId, status: { in: ['WAITING', 'CALLED'] } },
          orderBy: { queueNumber: 'desc' },
          select: { queueNumber: true },
        })
        const newQueueNumber = (maxReservation?.queueNumber || reservation.queueNumber) + 1
        updateData = { status: 'WAITING', postponeCount, queueNumber: newQueueNumber, updatedAt: now }
      }

      const updated = await db.reservation.update({
        where: { id },
        data: updateData,
      })
      emitEvent('queue:postponed', { agencyId, reservation: updated })
      logPendingMutation('update', 'Reservation', id, { action: 'postpone', postponeCount, ...updateData })
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] /api/reservations/:id/postpone error:', error)
      return c.json({ success: false, error: 'Failed to postpone reservation' }, 500)
    }
  })

  // GET /api/stats/* → alias routes for the desktop frontend stats methods
  app.get('/api/stats/daily', authMiddleware, async (c) => {
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    // Reuse the existing agency stats logic
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const todayISO = today.toISOString()
    const [totalToday, servedToday, waitingToday, noShowToday, cancelledToday, avgWait] = await Promise.all([
      db.reservation.count({ where: { agencyId, joinedAt: { gte: todayISO } } }),
      db.reservation.count({ where: { agencyId, status: 'COMPLETED', completedAt: { gte: todayISO } } }),
      db.reservation.count({ where: { agencyId, status: 'WAITING' } }),
      db.reservation.count({ where: { agencyId, status: 'NO_SHOW', updatedAt: { gte: todayISO } } }),
      db.reservation.count({ where: { agencyId, status: 'CANCELLED', updatedAt: { gte: todayISO } } }),
      db.reservation.aggregate({ where: { agencyId, status: 'COMPLETED', completedAt: { gte: todayISO }, waitTime: { not: null } }, _avg: { waitTime: true } }),
    ])
    return c.json({
      success: true, data: {
        totalToday, servedToday, waitingToday, noShowToday, cancelledToday,
        avgWaitTime: Math.round(avgWait._avg.waitTime || 0),
      }
    })
  })

  app.get('/api/stats/service-breakdown', authMiddleware, async (c) => {
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    const services = await db.service.findMany({ where: { agencyId, isActive: true }, select: { id: true, name: true, nameAr: true, nameFr: true } })
    const breakdown = await Promise.all(services.map(async (s) => ({
      ...s,
      waiting: await db.reservation.count({ where: { agencyId, serviceId: s.id, status: 'WAITING' } }),
      completed: await db.reservation.count({ where: { agencyId, serviceId: s.id, status: 'COMPLETED', completedAt: { gte: new Date(new Date().setHours(0,0,0,0)).toISOString() } } }),
    })))
    return c.json({ success: true, data: breakdown })
  })

  app.get('/api/stats/wait-times', authMiddleware, async (c) => {
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const result = await db.reservation.aggregate({
      where: { agencyId, status: 'COMPLETED', completedAt: { gte: today.toISOString() }, waitTime: { not: null } },
      _avg: { waitTime: true }, _min: { waitTime: true }, _max: { waitTime: true }, _count: true,
    })
    return c.json({ success: true, data: { avg: Math.round(result._avg.waitTime || 0), min: result._min.waitTime || 0, max: result._max.waitTime || 0, count: result._count } })
  })

  app.get('/api/stats/no-show', authMiddleware, async (c) => {
    // Redirect to the existing no-show analytics
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    const periodDays = parseInt(c.req.query('period') || '30', 10)
    const periodAgo = new Date(Date.now() - periodDays * 86400000).toISOString()
    const [total, noShow] = await Promise.all([
      db.reservation.count({ where: { agencyId, joinedAt: { gte: periodAgo } } }),
      db.reservation.count({ where: { agencyId, status: 'NO_SHOW', updatedAt: { gte: periodAgo } } }),
    ])
    return c.json({ success: true, data: { total, noShow, rate: total > 0 ? (noShow / total * 100).toFixed(1) : '0' } })
  })

  app.get('/api/stats/peak-hours', authMiddleware, async (c) => {
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    // Return hourly distribution
    const periodDays = parseInt(c.req.query('period') || '7', 10)
    const periodAgo = new Date(Date.now() - periodDays * 86400000).toISOString()
    const reservations = await db.reservation.findMany({
      where: { agencyId, joinedAt: { gte: periodAgo } },
      select: { joinedAt: true },
    })
    const hourly = new Array(24).fill(0)
    for (const r of reservations) {
      if (r.joinedAt) { const h = new Date(r.joinedAt).getHours(); hourly[h]++ }
    }
    const peakHour = hourly.indexOf(Math.max(...hourly))
    return c.json({ success: true, data: { hourly, peakHour } })
  })

  // GET /api/reservations/history → alias for /api/agency/history
  app.get('/api/reservations/history', authMiddleware, async (c) => {
    const user = c.get('user')
    const agencyId = user?.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    const skip = parseInt(c.req.query('skip') || '0', 10)
    const take = parseInt(c.req.query('take') || '50', 10)
    const status = c.req.query('status')

    const where = { agencyId }
    if (status && status !== 'ALL') where.status = status

    const [data, total] = await Promise.all([
      db.reservation.findMany({ where, orderBy: { joinedAt: 'desc' }, skip, take }),
      db.reservation.count({ where }),
    ])
    return c.json({ success: true, data, total, skip, take })
  })

  // POST /api/notifications/:id/read → alias for PATCH/PUT notifications
  app.post('/api/notifications/:id/read', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const user = c.get('user')
    try {
      const existing = await db.notification.findUnique({ where: { id } })
      if (!existing || existing.userId !== user.id) {
        return c.json({ success: false, error: 'Notification not found' }, 404)
      }
      const updated = await db.notification.update({
        where: { id },
        data: { isRead: true, readAt: new Date().toISOString() },
      })
      return c.json({ success: true, data: updated })
    } catch (e) {
      return c.json({ success: false, error: e.message }, 500)
    }
  })

  // DELETE /api/agency/announcements/:id → path-param variant (frontend uses this)
  app.delete('/api/agency/announcements/:id', authMiddleware, async (c) => {
    const { id } = c.req.param()
    const agencyId = sessionUser.agencyId
    if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
    try {
      const existing = await db.announcement.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Announcement not found' }, 404)
      }
      await db.announcement.delete({ where: { id } })
      logPendingMutation('delete', 'Announcement', id, {})
      return c.json({ success: true })
    } catch (e) {
      return c.json({ success: false, error: e.message }, 500)
    }
  })

  // 404 handler
  app.notFound((c) => {
    return c.json({ success: false, error: 'Not found' }, 404)
  })

  return app
}

// ─── Start / Stop ─────────────────────────────────────────────────────────

/**
 * Start the embedded local API server.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {number} [port] - Port to listen on (default: 3080)
 * @param {object} [options] - Additional options
 * @returns {Promise<{ port: number, db: SqliteDatabase }>}
 */
async function startLocalApi(dbPath, port, options) {
  port = port || DEFAULT_PORT
  options = options || {}

  // Initialize Prisma database
  db = localDb
  await setupPragmas()

  // Runtime safety: verify local DB is SQLite
  if (db) {
    try {
      const result = await db.$queryRaw`SELECT 1 FROM sqlite_master LIMIT 1`
      // If we get here, it's SQLite — OK
      console.log('[LocalAPI] SQLite database verified')
    } catch (e) {
      console.error('[LocalAPI] FATAL: Local database is not SQLite! This configuration is unsupported.')
    }
  }

  // Restore persisted cloud contact timestamp from previous session
  _restoreCloudContact()
  // Restore session from disk if available (survives Electron restart)
  loadPersistedSession()
  // Ensure schema is pushed to the local database
  // (The Prisma schema matches @blasti/db — same models, same structure)
  console.log(`[LocalAPI] Prisma database initialized (local SQLite)`)

  // Create Hono app
  const app = createApp()

  // ── IMPORTANT: DO NOT pre-create httpServer and pass it via createServer ──
  // The @hono/node-server createAdaptorServer() attaches the Hono request
  // listener to the server internally. If you pre-create the server with
  // createServer() and pass it via createServer: () => httpServer, the
  // request listener is NOT attached because the pre-created server ignores
  // the requestListener argument. The server accepts connections but never
  // responds, causing health probes to timeout.
  //
  // Instead, use serve() directly and capture the returned server reference.
  // serve() creates the server with the listener attached, calls listen(),
  // and returns the server. We wrap it in a Promise to await the listen callback.

  const { serve } = require('@hono/node-server')

  await new Promise((resolve, reject) => {
    let settled = false

    const server = serve({
      fetch: app.fetch,
      port,
      hostname: BIND_ADDRESS,
    }, (serverInfo) => {
      // This callback fires when server.listen() succeeds
      if (!settled) {
        settled = true
        console.log(`[LocalAPI] BLASTI Embedded API running on http://${BIND_ADDRESS}:${port}`)
        console.log('[LocalAPI] Cloud API URL:', getCloudUrl())
        resolve(serverInfo)
      }
    })

    // Store the server reference for stopLocalApi() and getStatus()
    httpServer = server

    // Set up Socket.IO for local realtime events (no-op if socket.io not installed)
    setupSocketIO(server)

    // Handle listen errors (e.g. EADDRINUSE — port already in use)
    server.on('error', (err) => {
      if (!settled) {
        settled = true
        console.error(`[LocalAPI] Failed to listen on port ${port}:`, err.message)
        reject(err)
      }
    })
  })

  return { port, db }
}

/**
 * Stop the embedded local API server.
 */
function stopLocalApi() {
  if (ioServer) {
    ioServer.close()
    ioServer = null
  }
  if (httpServer) {
    httpServer.close()
    httpServer = null
  }
  if (db) {
    try {
      db.$disconnect()
    } catch (e) {
      console.warn('[LocalAPI] Error disconnecting database:', e.message)
    }
    db = null
  }
  sessionToken = null
  sessionUser = null
  eventListeners = []
  deletePersistedSession()
  console.log('[LocalAPI] Stopped')
}

/**
 * Get the current session info.
 * @returns {{ token: string, user: object } | null}
 */
function getSession() {
  if (!sessionToken || !sessionUser) return null
  return { token: sessionToken, user: sessionUser }
}

/**
 * Set an active session (called from Electron main process).
 * @param {string} token
 * @param {object} user
 */
function setSession(token, user) {
  // Defensive: never set a token without a valid user object.
  // If user is null/undefined, both should stay null to keep them in sync.
  if (!token || !user || typeof user !== 'object') {
    console.warn('[LocalAPI] setSession called with invalid args — skipping')
    return
  }
  sessionToken = token
  sessionUser = user
}

/**
 * Clear the active session.
 */
function clearSession() {
  sessionToken = null
  sessionUser = null
}

/**
 * Get the current status of the local API.
 * @returns {{ port: number|null, dbReady: boolean, sessionActive: boolean, uptime: number }}
 */
function getStatus() {
  return {
    port: httpServer ? httpServer.address()?.port : null,
    dbReady: !!db,
    sessionActive: !!sessionToken,
    uptime: Math.floor(process.uptime()),
    address: BIND_ADDRESS,
  }
}

/**
 * Mark that cloud contact was successful (called by sync-service on successful sync).
 */
function markCloudContact() {
  _lastCloudContactAt = _safeTimestamp()
  _persistCloudContact()
}

/**
 * Get the last cloud contact timestamp.
 */
function getLastCloudContact() {
  return _lastCloudContactAt
}

// ─── Module Exports ──────────────────────────────────────────────────────

module.exports = {
  startLocalApi,
  stopLocalApi,
  getSession,
  setSession,
  clearSession,
  onEvent,
  emitEvent,
  setupSocketIO,
  getStatus,
  logPendingMutation,
  getPendingMutations,
  markMutationCompleted,
  markMutationFailed,
  markCloudContact,
  getLastCloudContact,
  requireActiveSubscription,
  DEFAULT_PORT,
  getCloudUrl,
  atomicWrite,
  atomicWriteWithMutation,
}