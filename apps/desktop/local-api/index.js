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
const { randomBytes, timingSafeEqual, createHash, scryptSync } = require('crypto')
const { localDb, setupPragmas, ensureDatabaseReady } = require('./lib/db')
const localRealtime = require('./local-realtime')
const fileStore = require('./lib/file-store')
const { createFileSync } = require('./lib/file-sync')

// ─── Configuration ────────────────────────────────────────────────────────

const DEFAULT_PORT = 3080
const BIND_ADDRESS = '127.0.0.1'
const CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3080',
  'http://localhost:3111',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3080',
  'http://127.0.0.1:3111',
]

// ─── Module-level State ───────────────────────────────────────────────────

let db = null
let httpServer = null
let sessionToken = null
let sessionUser = null
let eventListeners = []
let mutationListeners = []
let idemColumnEnsured = false
let outboxV3Ensured = false

// Round 15 — local file store origin + file-sync worker handle. The local
// origin is what every locally stored file URL is built against; it is
// refreshed at startLocalApi() with the actual bound port.
let localOrigin = `http://${BIND_ADDRESS}:${DEFAULT_PORT}`
let fileSync = null

// ─── Local Device Identity & Unlock Credentials (Task 14) ───────────────
// Desktop authentication model:
//
//   CLOUD LOGIN (password enters ONLY here, over 127.0.0.1 or the cloud)
//        → create/update the LOCAL OPERATIONAL User (profile-only)
//        → create LocalDeviceCredential for THIS user on THIS device
//        → logout / restart
//        → LOCAL UNLOCK (scrypt verifier check — no cloud, no User.passwordHash)
//
// User.passwordHash stays NULL for synced profiles: the cloud sync feed
// never ships authentication secrets. Only the user who actually logged in
// on THIS device receives a credential — every other synced user has none.
// The optional "keep signed in" flag is persisted in _sync_meta and controls
// whether the app auto-restores the session on restart or requires unlock.

const UNLOCK_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

async function getLocalMeta(key) {
  try {
    const rows = await db.$queryRawUnsafe('SELECT value FROM "_sync_meta" WHERE key = ?', key)
    return rows && rows[0] ? String(rows[0].value) : null
  } catch { return null }
}

async function setLocalMeta(key, value) {
  await db.$executeRawUnsafe(
    'INSERT INTO "_sync_meta" ("key", "value") VALUES (?, ?) ' +
    'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"',
    key, String(value)
  )
}

/**
 * Round 15 — LOCALIZE a file URL: when the URL points at a file that ALSO
 * exists in this device's local file store, rewrite it to the local API
 * origin so <img> tags render instantly and OFFLINE. Anything else (cloud
 * URLs for files we never downloaded, data: URIs, …) passes through
 * untouched — the cloud remains the cross-device source of truth.
 */
async function localizeFileUrl(url) {
  try {
    if (!url || typeof url !== 'string' || url.indexOf('/api/upload/file/') === -1) return url
    const storagePath = fileStore.storagePathFromUrl(url)
    if (!storagePath) return url
    const abs = fileStore.resolveRelativeStoragePath(storagePath)
    if (abs && require('fs').existsSync(abs)) {
      return localOrigin + fileStore.publicFilePath(storagePath)
    }
    return url
  } catch {
    return url
  }
}

/**
 * Resolve the agency id the current session may read/write, mirroring the
 * cloud's ensureAgencyIdOwnership/requireAgencyAccess pair.
 *
 * The web UI always sends ?agencyId=<user.agencyId> on /api/agency/* reads,
 * but the local endpoints used to ignore it and read sessionUser.agencyId —
 * when the local session carried no agencyId (e.g. an owner re-login before
 * the owner fallback existed) every read 403'd and the profile/settings
 * pages rendered empty. This helper accepts the explicit param ONLY when the
 * session user genuinely has access to that agency.
 */
async function resolveSessionAgencyId(explicitAgencyId) {
  const sessionAgencyId = sessionUser ? sessionUser.agencyId : null
  if (!explicitAgencyId) return sessionAgencyId
  if (sessionAgencyId && explicitAgencyId === sessionAgencyId) return explicitAgencyId
  if (!sessionUser) return null
  try {
    if (sessionUser.role === 'AGENCY_OWNER') {
      const owned = await db.agency.findFirst({ where: { id: explicitAgencyId, ownerId: sessionUser.id } })
      if (owned) return explicitAgencyId
    }
    const staff = await db.agencyStaff.findFirst({
      where: { agencyId: explicitAgencyId, userId: sessionUser.id, isActive: true },
    })
    if (staff) return explicitAgencyId
  } catch { /* fall through */ }
  return null
}

/**
 * Stable per-installation device id, persisted in _sync_meta on first use.
 * LocalDeviceCredential is scoped to (user, device) — never global.
 */
async function getDeviceId() {
  const existing = await getLocalMeta('device_id')
  if (existing) return existing
  const id = 'dev-' + randomBytes(12).toString('hex')
  try { await setLocalMeta('device_id', id) } catch { /* next call retries */ }
  return id
}

/** Derive the scrypt verifier hex for a password + salt hex. */
function deriveUnlockVerifier(password, saltHex, params) {
  const p = params || UNLOCK_SCRYPT
  return scryptSync(
    String(password),
    Buffer.from(saltHex, 'hex'),
    p.keylen,
    { N: p.N, r: p.r, p: p.p, maxmem: 128 * 1024 * 1024 }
  ).toString('hex')
}

/** Timing-safe verification of a password against a stored credential. */
function verifierMatches(cred, password) {
  try {
    if (!cred || !cred.verifierHash || !cred.salt) return false
    const candidate = scryptSync(
      String(password),
      Buffer.from(cred.salt, 'hex'),
      UNLOCK_SCRYPT.keylen,
      { N: cred.scryptN || UNLOCK_SCRYPT.N, r: cred.scryptR || UNLOCK_SCRYPT.r, p: cred.scryptP || UNLOCK_SCRYPT.p, maxmem: 128 * 1024 * 1024 }
    )
    const stored = Buffer.from(cred.verifierHash, 'hex')
    if (stored.length !== candidate.length) return false
    return timingSafeEqual(stored, candidate)
  } catch { return false }
}

function cloudBaseUrl() {
  return process.env.BLASTI_CLOUD_URL || 'http://localhost:3003'
}

/**
 * Attempt a cloud login (username + password) from the local API. Used when
 * the local profile has no unlock credential yet (first login through the
 * LAN-failover path) or no local profile at all. NEVER throws.
 */
async function cloudLoginProxy(username, password, extra) {
  const base = cloudBaseUrl()
  try {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ username, password }, extra || {})),
      signal: AbortSignal.timeout(8000),
    })
    let data = null
    try { data = await res.json() } catch { /* non-JSON error body */ }
    return { ok: res.ok, status: res.status, data }
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || 'cloud unreachable' }
  }
}

/**
 * Create/update the LOCAL OPERATIONAL User row from a cloud login user
 * object — PROFILE-ONLY. Authentication secrets are never written here
 * (passwordHash stays NULL for synced profiles).
 */
async function upsertLocalUserFromCloud(cloudUser) {
  if (!cloudUser || !cloudUser.id || !db.user) return null
  const profile = {
    username: cloudUser.username || cloudUser.email || ('user-' + String(cloudUser.id).slice(-8)),
    fullName: cloudUser.fullName || cloudUser.name || '',
    email: cloudUser.email ?? null,
    phoneNumber: cloudUser.phoneNumber ?? null,
    shortAppId: cloudUser.shortAppId ?? null,
    role: cloudUser.role || 'CUSTOMER',
    language: cloudUser.language || 'ar',
    avatarUrl: cloudUser.avatarUrl ?? null,
    isActive: cloudUser.isActive !== false,
  }
  await db.user.upsert({
    where: { id: cloudUser.id },
    update: profile,
    create: Object.assign({ id: cloudUser.id }, profile),
  })
  return Object.assign({ id: cloudUser.id }, profile)
}

/**
 * Store/refresh THIS user's LocalDeviceCredential for THIS device from a
 * plaintext password (the only moment the password exists locally), and
 * optionally persist the keep-signed-in preference.
 */
async function storeDeviceCredential(userId, password, keepSignedIn) {
  if (!db.localDeviceCredential) {
    console.warn('[LocalAPI] localDeviceCredential model unavailable — regenerate the Prisma client (cd packages/db && npx prisma generate)')
    return null
  }
  const deviceId = await getDeviceId()
  const salt = randomBytes(16).toString('hex')
  const verifierHash = deriveUnlockVerifier(password, salt)
  const existing = await db.localDeviceCredential.findUnique({
    where: { userId_deviceId: { userId, deviceId } },
  }).catch(() => null)
  if (existing) {
    await db.localDeviceCredential.update({
      where: { id: existing.id },
      data: { verifierHash, salt, revokedAt: null },
    })
  } else {
    await db.localDeviceCredential.create({ data: { userId, deviceId, verifierHash, salt } })
  }
  if (typeof keepSignedIn === 'boolean') {
    await setLocalMeta('keep_signed_in', keepSignedIn ? 'true' : 'false')
  }
  return deviceId
}

// ─── Event Emitter (UI reactivity) ────────────────────────────────────────

/**
 * Emit a local event to all registered UI listeners.
 * @param {string} event
 * @param {object} payload
 */
function emitEvent(event, payload) {
  for (const cb of eventListeners) {
    try {
      cb(event, payload)
    } catch (err) {
      console.error('[LocalAPI] Event listener error:', err)
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

// ─── Mutation Listeners (local→cloud sync immediacy) ──────────────────

/**
 * Register a callback fired (fire-and-forget) after every pending mutation
 * is logged. main.js wires this to syncService.onLocalMutation() so the
 * outbox replays to the cloud immediately when online.
 * NOTE: do NOT require sync-service from inside this module at top level —
 * sync-service lazily requires ./index (circular dependency).
 * @param {() => void} callback
 * @returns {() => void} unsubscribe function
 */
function setMutationListener(callback) {
  mutationListeners.push(callback)
  return () => {
    mutationListeners = mutationListeners.filter((cb) => cb !== callback)
  }
}

function notifyMutationLogged() {
  for (const cb of mutationListeners) {
    try {
      cb()
    } catch (err) {
      console.error('[LocalAPI] Mutation listener error:', err)
    }
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
    c.json({ success: false, error: 'No agency associated with this account' }, 403)
    return null
  }
  return agencyId
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

let _pendingMutationsBigintDone = false

/**
 * One-time in-place migration: legacy `_pending_mutations` tables declared
 * `created_at`/`last_attempt_at` as INTEGER. quaint binds INTEGER columns as
 * Int32 and epoch-millis values (Date.now()) overflow — every outbox insert
 * would fail with "does not fit in an INT column". SQLite cannot ALTER a
 * column type, so the table is rebuilt (rows preserved) with BIGINT columns.
 */
async function _migratePendingMutationsBigint() {
  if (_pendingMutationsBigintDone || !db) return
  try {
    const cols = await db.$queryRawUnsafe('PRAGMA table_info("_pending_mutations")')
    if (!cols || cols.length === 0) return
    const createdCol = cols.find((c) => c.name === 'created_at')
    if (!createdCol || String(createdCol.type || '').toUpperCase() === 'BIGINT') {
      _pendingMutationsBigintDone = true
      return
    }
    console.log('[LocalAPI] Migrating _pending_mutations timestamps INTEGER → BIGINT')
    await db.$executeRawUnsafe('ALTER TABLE "_pending_mutations" RENAME TO "_pending_mutations_old"')
    await db.$executeRawUnsafe(
      'CREATE TABLE "_pending_mutations" (' +
      '"id" TEXT PRIMARY KEY,' +
      '"method" TEXT NOT NULL,' +
      '"path" TEXT NOT NULL,' +
      '"body" TEXT,' +
      '"headers" TEXT,' +
      '"status" TEXT NOT NULL DEFAULT \'pending\',' +
      '"attempts" INTEGER NOT NULL DEFAULT 0,' +
      '"max_attempts" INTEGER NOT NULL DEFAULT 5,' +
      '"created_at" BIGINT NOT NULL,' +
      '"last_attempt_at" BIGINT,' +
      '"last_error" TEXT,' +
      '"response_data" TEXT,' +
      '"idempotency_key" TEXT' +
      ')'
    )
    // The old table's shape varies by install age — introspect before copying.
    const oldCols = await db.$queryRawUnsafe('PRAGMA table_info("_pending_mutations_old")')
    const oldNames = new Set((oldCols || []).map((c) => c.name))
    const headersExpr = oldNames.has('headers') ? '"headers"' : 'NULL'
    const idemExpr = oldNames.has('idempotency_key') ? '"idempotency_key"' : 'NULL'
    const attemptsExpr = oldNames.has('attempts') ? '"attempts"' : '0'
    const maxAttemptsExpr = oldNames.has('max_attempts') ? '"max_attempts"' : '5'
    const lastAttemptExpr = oldNames.has('last_attempt_at') ? '"last_attempt_at"' : 'NULL'
    const lastErrorExpr = oldNames.has('last_error') ? '"last_error"' : 'NULL'
    const statusExpr = oldNames.has('status') ? '"status"' : "'pending'"
    await db.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "_pending_mutations" ' +
      '("id","method","path","body","headers","status","attempts","max_attempts","created_at","last_attempt_at","last_error","response_data","idempotency_key") ' +
      'SELECT "id","method","path","body",' + headersExpr + ',' + statusExpr + ',' + attemptsExpr + ',' + maxAttemptsExpr + ',"created_at",' + lastAttemptExpr + ',' + lastErrorExpr + ',"response_data",' + idemExpr + ' ' +
      'FROM "_pending_mutations_old"'
    )
    await db.$executeRawUnsafe('DROP TABLE "_pending_mutations_old"')
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_pending_mutations_status" ON "_pending_mutations"("status")'
    )
    await db.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_pending_mutations_idem" ON "_pending_mutations"("idempotency_key")'
    ).catch(() => {})
    _pendingMutationsBigintDone = true
    console.log('[LocalAPI] _pending_mutations timestamps migrated to BIGINT')
  } catch (e) {
    console.warn('[LocalAPI] _pending_mutations BIGINT migration skipped:', e.message)
  }
}

/**
 * Create the _pending_mutations table if it doesn't exist.
 * Also (guarded) adds the v2 `idempotency_key` column + unique index and
 * backfills legacy rows. Existing table name/columns are never changed
 * (backward compat).
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
      '"status" TEXT NOT NULL DEFAULT \'pending\',' +
      '"attempts" INTEGER NOT NULL DEFAULT 0,' +
      '"max_attempts" INTEGER NOT NULL DEFAULT 5,' +
      '"created_at" BIGINT NOT NULL,' +
      '"last_attempt_at" BIGINT,' +
      '"next_retry_at" BIGINT,' +
      '"last_http_status" INTEGER,' +
      '"last_error" TEXT,' +
      '"response_data" TEXT' +
      ')'
    )
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_pending_mutations_status" ON "_pending_mutations"("status")'
    )

    await _migratePendingMutationsBigint()

    // ── v3 (Parts R/S): retry-scheduling columns + legacy status sweep ──
    if (!outboxV3Ensured) {
      try {
        const cols = await db.$queryRawUnsafe('PRAGMA table_info("_pending_mutations")')
        const colNames = new Set((cols || []).map((c) => c && c.name))
        for (const [col, ddl] of [
          ['next_retry_at', 'ALTER TABLE "_pending_mutations" ADD COLUMN "next_retry_at" BIGINT'],
          ['last_http_status', 'ALTER TABLE "_pending_mutations" ADD COLUMN "last_http_status" INTEGER'],
        ]) {
          if (!colNames.has(col)) {
            await db.$executeRawUnsafe(ddl)
            console.log('[LocalAPI] Added _pending_mutations.' + col + ' column')
          }
        }
      } catch (e) {
        console.warn('[LocalAPI] retry-column ensure skipped:', e.message)
      }
      try {
        // Legacy rows: 'failed' was a permanent-quarantine bug — they become
        // retryable again; 'abandoned' becomes visible permanent_failed.
        const r1 = await db.$executeRawUnsafe('UPDATE "_pending_mutations" SET status = \'retry\', "next_retry_at" = NULL WHERE status = \'failed\'')
        const r2 = await db.$executeRawUnsafe('UPDATE "_pending_mutations" SET status = \'permanent_failed\' WHERE status = \'abandoned\'')
        // Crash sweep: 'sending' rows older than 10 min were in-flight when
        // the process died — back to pending.
        const r3 = await db.$executeRawUnsafe('UPDATE "_pending_mutations" SET status = \'pending\' WHERE status = \'sending\' AND "last_attempt_at" IS NOT NULL AND "last_attempt_at" < ?', Date.now() - 10 * 60 * 1000)
        const swept = Number(r1) + Number(r2) + Number(r3)
        if (swept > 0) console.log('[LocalAPI] Outbox legacy/crash sweep:', swept, 'row(s) rescheduled')
      } catch (e) {
        console.warn('[LocalAPI] outbox status sweep skipped:', e.message)
      }
      outboxV3Ensured = true
    }

    // ── v2: stable idempotency key column ──
    if (!idemColumnEnsured) {
      try {
        // Introspection-guarded: the schema-migrations top-up (lib/db.js) or
        // the BIGINT rebuild DDL above may already have added this column.
        // An unguarded ALTER fails with "duplicate column name" and Prisma
        // logs noisy prisma:error output even when the failure is swallowed.
        const colsNow = await db.$queryRawUnsafe('PRAGMA table_info("_pending_mutations")')
        const hasIdemCol = (colsNow || []).some((c) => c && c.name === 'idempotency_key')
        if (!hasIdemCol) {
          await db.$executeRawUnsafe('ALTER TABLE "_pending_mutations" ADD COLUMN "idempotency_key" TEXT')
          console.log('[LocalAPI] Added _pending_mutations.idempotency_key column')
        }
      } catch (e) {
        // ALTER unsupported or introspection failed — non-fatal (the derived
        // -key replay fallback still works without the physical column).
        console.warn('[LocalAPI] idempotency_key column ensure skipped:', e.message)
      }
      try {
        await db.$executeRawUnsafe(
          'CREATE UNIQUE INDEX IF NOT EXISTS "idx_pending_mutations_idem" ON "_pending_mutations"("idempotency_key")'
        )
      } catch (e) {
        // Pre-existing duplicate non-NULL keys would block the index — log
        // loudly; replay still works via the derived-key fallback.
        console.warn('[LocalAPI] Could not create idempotency unique index:', e.message)
      }
      try {
        // Backfill legacy rows (NULL keys) with the same derivation.
        const backfillRows = await db.$queryRawUnsafe(
          'SELECT id, method, path, body FROM "_pending_mutations" WHERE "idempotency_key" IS NULL'
        )
        for (const row of backfillRows || []) {
          const key = deriveStableIdempotencyKey(row.method, row.path, row.body)
          await db.$executeRawUnsafe(
            'UPDATE "_pending_mutations" SET "idempotency_key" = ? WHERE id = ?',
            key, row.id
          ).catch(() => {}) // duplicate key on backfill → leave NULL (unique index allows NULLs)
        }
        if ((backfillRows || []).length > 0) {
          console.log('[LocalAPI] Backfilled idempotency keys for', (backfillRows || []).length, 'pending mutation rows')
        }
      } catch (e) {
        console.warn('[LocalAPI] idempotency key backfill failed:', e.message)
      }
      idemColumnEnsured = true
    }
  } catch (e) {
    console.error('[LocalAPI] Failed to create _pending_mutations table:', e.message)
  }
}

// Volatile fields stripped before hashing (they never repeat across retries
// of the same logical operation and would defeat content-derived keys).
const VOLATILE_IDEM_FIELDS = ['clientTimestamp', 'clientTime', 'timestamp', 'issuedAt', 'nonce', 'requestId', 'localId']

/**
 * Recursively sort object keys and strip volatile fields, returning a
 * deterministic JSON string (for content-derived idempotency keys).
 */
function stableStringify(value) {
  if (Array.isArray(value)) return value.map(stableStringify)
  if (value && typeof value === 'object') {
    const sorted = {}
    Object.keys(value).sort().forEach((k) => {
      if (VOLATILE_IDEM_FIELDS.includes(k)) return
      sorted[k] = stableStringify(value[k])
    })
    return sorted
  }
  return value
}

/**
 * Derive the stable idempotency key for an outbox mutation:
 *   `${method}:${path}:${sha256(sorted-JSON of body)}`
 * Volatile fields (clientTimestamp, timestamp, nonce, ...) are stripped
 * recursively before hashing so retries hash identically.
 * @param {string} method
 * @param {string} path
 * @param {string|object|null} body - raw JSON string (as stored) or object
 * @returns {string}
 */
function deriveStableIdempotencyKey(method, path, body) {
  let parsed = {}
  if (body) {
    try {
      parsed = typeof body === 'string' ? JSON.parse(body) : body
    } catch {
      parsed = { _unparseable: String(body).substring(0, 128) }
    }
  }
  const hash = createHash('sha256').update(JSON.stringify(stableStringify(parsed))).digest('hex')
  return `${method}:${path}:${hash}`
}

/**
 * Log a mutation to the pending outbox.
 * Called by write handlers (POST/PUT/PATCH/DELETE) after EVERY local
 * business mutation. The sync service replays the queue to the cloud with a
 * stable X-Idempotency-Key header (route rows) or as canonical /api/sync/push
 * mutations (SYNC_PUSH rows), so the cloud applies each logical operation
 * exactly once.
 *
 * Part T (identity): the idempotency key is a UUID generated when the
 * business operation runs — ONE logical operation = ONE mutationId, reused
 * across every retry. Two separate legitimate operations with identical
 * payloads get DIFFERENT keys (the old content-hash collapsed them).
 *
 * Part Q (durability): pass opts.tx (the interactive-transaction client of
 * the business write) to commit the business mutation and the outbox row
 * ATOMICALLY. Without tx the row is still persisted immediately (SQLite,
 * awaited) — a smaller but real durability window.
 *
 * Canonical rows (Part V): method='SYNC_PUSH', path='/api/sync/push', body =
 * JSON { model, recordId, operation, data, localUpdatedAt } — replayed via
 * the cloud push protocol as a deterministic outcome instead of re-running
 * a business action.
 */
async function logPendingMutation(method, path, body, responseData, opts) {
  opts = opts || {}
  const executor = opts.tx || db
  if (!executor) return
  try {
    if (!opts.tx) await ensurePendingMutationsTable()
    const id = require('crypto').randomUUID()
    const bodyStr = body ? JSON.stringify(body) : null
    const mutationId = 'mut-' + id
    const stmt = 'INSERT OR IGNORE INTO "_pending_mutations" (id, method, path, body, status, created_at, response_data, idempotency_key) VALUES (?, ?, ?, ?, \'pending\', ?, ?, ?)'
    const params = [id, method, path, bodyStr, Date.now(), responseData ? JSON.stringify(responseData) : null, mutationId]
    if (opts.tx) {
      await opts.tx.$executeRawUnsafe(stmt, ...params)
    } else {
      await executor.$executeRawUnsafe(stmt, ...params)
    }
    console.log('[LocalAPI] Logged outbox mutation:', method, path, 'id:', mutationId)
    if (!opts.tx) {
      // Immediate replay trigger (skip when transactional — the caller emits
      // after commit).
      notifyMutationLogged()
    }
  } catch (e) {
    console.error('[LocalAPI] Failed to log pending mutation:', e.message)
    if (opts.tx) throw e // transactional callers MUST know the outbox row failed
  }
}

/**
 * Canonical push payload (Parts V/W): a deterministic record-level mutation
 * for the cloud /api/sync/push protocol - "Reservation R was set to state S",
 * never "please run action X again".
 */
function canonicalPushPayload(model, recordId, operation, data, localUpdatedAt) {
  const clean = data && typeof data === 'object'
    ? JSON.parse(JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? Number(v) : v === undefined ? null : v)))
    : {}
  return {
    model,
    recordId,
    operation,
    data: clean,
    localUpdatedAt: localUpdatedAt || new Date().toISOString(),
  }
}

/**
 * Log a canonical outcome mutation (replayed via POST /api/sync/push).
 * Use for every state-changing action whose cloud replay must be
 * DETERMINISTIC (queue actions, :id routes, deletes).
 */
async function logDeterministicOutcome(model, recordId, operation, data, localUpdatedAt, opts) {
  // Defensive arg-shim: callers sometimes write (..., data, { tx }) placing the
  // opts object in the localUpdatedAt slot — shift it so the outbox row really
  // joins the caller's transaction instead of corrupting the payload.
  // (Dates and arrays are legitimate localUpdatedAt values and are NOT opts.)
  if (
    localUpdatedAt &&
    typeof localUpdatedAt === 'object' &&
    !Array.isArray(localUpdatedAt) &&
    !(localUpdatedAt instanceof Date)
  ) {
    if (!opts) opts = localUpdatedAt
    localUpdatedAt = undefined
  }
  return logPendingMutation('SYNC_PUSH', '/api/sync/push',
    canonicalPushPayload(model, recordId, operation, data, localUpdatedAt), null, opts)
}

/**
 * P1-5 (spec Part Q): run a business mutation and its outbox row in ONE
 * SQLite transaction — the historic pattern (business write commits, then
 * `logPendingMutation()` afterwards) had a crash window that could produce
 * an APPLIED local mutation with NO outbox entry: the cloud would never
 * learn the mutation happened.
 *
 * The callback receives the interactive-transaction client `tx` — perform
 * ALL business writes through it and log the outbox row inside the same
 * callback via logDeterministicOutcome(..., { tx }) / logPendingMutation(..., { tx }).
 * An outbox INSERT failure rolls the business write back (the client sees
 * the 500 and retries) — the two sides can never diverge.
 * notifyMutationLogged() fires only AFTER commit so the replay never races
 * an uncommitted row.
 */
async function withOutboxTransaction(work) {
  if (!db) throw new Error('Local database not initialized')
  const result = await db.$transaction(async (tx) => work(tx), { maxWait: 5000, timeout: 20000 })
  notifyMutationLogged()
  return result
}

/**
 * Get due outbox mutations (for sync service replay).
 * Part R: 'retry' rows re-join the queue once their backoff expires — a
 * transient failure NEVER removes a mutation from the retry pool.
 * Legacy 'failed' rows (pre-v3 quarantine bug) are also retryable again.
 */
async function getPendingMutations() {
  if (!db) return []
  try {
    await ensurePendingMutationsTable()
    const rows = await db.$queryRawUnsafe(
      'SELECT * FROM "_pending_mutations" ' +
      'WHERE status IN (\'pending\', \'retry\', \'failed\') ' +
      'AND ("next_retry_at" IS NULL OR "next_retry_at" <= ?) ' +
      'ORDER BY created_at ASC LIMIT 100',
      Date.now()
    )
    return (rows || []).map(row => ({
      ...row,
      // BIGINT columns arrive as JS BigInt — JSON.stringify throws on BigInt,
      // so convert timestamp fields to Numbers for the response payload.
      created_at: typeof row.created_at === 'bigint' ? Number(row.created_at) : row.created_at,
      last_attempt_at: typeof row.last_attempt_at === 'bigint' ? Number(row.last_attempt_at) : row.last_attempt_at,
      next_retry_at: typeof row.next_retry_at === 'bigint' ? Number(row.next_retry_at) : row.next_retry_at,
      body: row.body ? JSON.parse(row.body) : null,
      responseData: row.response_data ? JSON.parse(row.response_data) : null,
    }))
  } catch (e) {
    console.error('[LocalAPI] Failed to get pending mutations:', e.message)
    return []
  }
}

/**
 * Get outbox counters for /api/db-status (Part AT).
 */
async function getOutboxStats() {
  if (!db) return { pending: 0, retry: 0, permanentFailed: 0, conflict: 0, completedToday: 0 }
  try {
    await ensurePendingMutationsTable()
    const rows = await db.$queryRawUnsafe(
      'SELECT status, COUNT(*) as n FROM "_pending_mutations" GROUP BY status'
    )
    const byStatus = {}
    for (const r of rows || []) byStatus[r.status] = Number(r.n)
    return {
      pending: (byStatus.pending || 0),
      retry: (byStatus.retry || 0) + (byStatus.failed || 0),
      permanentFailed: (byStatus.permanent_failed || 0) + (byStatus.abandoned || 0),
      conflict: (byStatus.conflict || 0),
      sending: (byStatus.sending || 0),
    }
  } catch {
    return { pending: 0, retry: 0, permanentFailed: 0, conflict: 0, sending: 0 }
  }
}

/**
 * Mark a mutation as completed (successfully synced to cloud).
 */
async function markMutationCompleted(id, responseData) {
  if (!db) return
  try {
    if (responseData !== undefined) {
      await db.$executeRawUnsafe(
        'UPDATE "_pending_mutations" SET status = \'completed\', "response_data" = COALESCE(?, "response_data") WHERE id = ?',
        responseData ? JSON.stringify(responseData) : null, id
      )
    } else {
      await db.$executeRawUnsafe(
        'UPDATE "_pending_mutations" SET status = \'completed\' WHERE id = ?', id
      )
    }
  } catch (e) {
    console.error('[LocalAPI] Failed to mark mutation completed:', e.message)
  }
}

// --- Part R/S: failure classification + bounded exponential backoff ------

/** HTTP statuses that can NEVER succeed by retrying. */
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 422])
/** Transient statuses that MUST be retried (spec Part R). */
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/**
 * Classify a replay failure: 'permanent' | 'transient'.
 * Network-level errors (no HTTP status) are transient by definition — a
 * dropped connection must never permanently silence a business operation.
 */
function classifyMutationFailure(httpStatus, errorMessage) {
  const msg = String(errorMessage || '')
  if (httpStatus === undefined || httpStatus === null || httpStatus === 0) {
    return /validation|malformed|schema/i.test(msg) ? 'permanent' : 'transient'
  }
  if (RETRYABLE_HTTP_STATUSES.has(httpStatus)) return 'transient'
  if (PERMANENT_HTTP_STATUSES.has(httpStatus)) return 'permanent'
  if (httpStatus >= 500) return 'transient'
  return 'transient' // unknown 4xx — retryable rather than data loss
}

/** Bounded exponential backoff with jitter: 15s * 2^n, capped at 15 min. */
function computeRetryBackoffMs(attempts) {
  const base = 15000 * Math.pow(2, Math.max(0, attempts - 1))
  const capped = Math.min(base, 15 * 60 * 1000)
  const jitter = capped * (0.15 * Math.random())
  return Math.round(capped + jitter)
}

/**
 * Mark a mutation as 'sending' before the replay fetch (crash-safe in-flight
 * marker). The boot sweep returns stale 'sending' rows (>10 min) to 'pending'.
 */
async function markMutationSending(id) {
  if (!db) return
  try {
    await db.$executeRawUnsafe(
      'UPDATE "_pending_mutations" SET status = \'sending\', "last_attempt_at" = ? WHERE id = ?',
      Date.now(), id
    )
  } catch (e) {
    console.error('[LocalAPI] Failed to mark mutation sending:', e.message)
  }
}

// Legacy create-row repair map (round-7): path → Prisma model for locally
// created records whose HTTP-replay rows could never succeed.
const LEGACY_CREATE_PATH_MODELS = [
  { path: '/api/reservations', model: 'Reservation' },
  { path: '/api/agency/queue/walk-in', model: 'Reservation' },
  { path: '/api/services', model: 'Service' },
  { path: '/api/agency/services', model: 'Service' },
  { path: '/api/agency/branches', model: 'Branch' },
  { path: '/api/agency/counters', model: 'Counter' },
]

/**
 * One-time startup repair (round-7): rows logged BEFORE the canonical
 * SYNC_PUSH conversion as HTTP create replays are permanently failed by
 * definition (the cloud route is customer-only / schema-incompatible), so
 * their outbox rows sit in permanent_failed forever and any dependent
 * SYNC_PUSH update rows retry against a cloud record that never existed.
 *
 * Repair: for each permanent_failed legacy create row, re-log its stored
 * response record as a CANONICAL id-preserving SYNC_PUSH create (idempotent
 * cloud upsert — safe even if the record already reached the cloud by
 * another path). The original row is kept untouched as truthful history;
 * the new canonical row tracks the real delivery exactly-once.
 */
async function repairLegacyReservationCreates() {
  if (!db) return
  try {
    await ensurePendingMutationsTable()
    for (const { path, model } of LEGACY_CREATE_PATH_MODELS) {
      let rows = []
      try {
        rows = await db.$queryRawUnsafe(
          'SELECT id, response_data FROM "_pending_mutations" ' +
          "WHERE status = 'permanent_failed' AND method = 'POST' AND path = ? ORDER BY created_at ASC",
          path
        )
      } catch (e) {
        console.warn('[LocalAPI] Legacy create repair scan failed for', path, ':', e.message)
        continue
      }
      for (const row of rows || []) {
        let record = null
        try {
          const parsed = row.response_data ? JSON.parse(row.response_data) : null
          // response_data stored by logPendingMutation is the created record
          // itself (reservations/walk-in) — unwrap common wrappers too.
          record = parsed && typeof parsed === 'object'
            ? (parsed.data || parsed.reservation || parsed.record || parsed)
            : null
        } catch { record = null }
        if (!record || typeof record !== 'object' || !record.id || typeof record.id !== 'string') {
          continue
        }
        // Idempotence: skip only if a canonical CREATE row for this record
        // already exists (a previous repair already scheduled the delivery).
        // A SYNC_PUSH update row for the same record must NOT suppress the
        // create repair — the update is useless until the create lands.
        let already = []
        try {
          already = await db.$queryRawUnsafe(
            'SELECT id FROM "_pending_mutations" WHERE method = \'SYNC_PUSH\' AND body LIKE ? AND body LIKE ? LIMIT 1',
            '%"recordId":"' + record.id + '"%',
            '%"operation":"create"%'
          )
        } catch { already = [] }
        if (already && already.length > 0) continue
        await logDeterministicOutcome(model, record.id, 'create', record, record.updatedAt || null, {})
        console.log('[LocalAPI] Legacy create repair: re-queued', model, record.id, 'as canonical SYNC_PUSH create (was permanently-failed HTTP replay', row.id + ')')
      }
    }
  } catch (e) {
    console.warn('[LocalAPI] Legacy create repair error (non-fatal):', e.message)
  }
}

/**
 * Mark a mutation failed with Part R/S semantics:
 *   transient (network/timeout/5xx/429) -> status='retry' + exponential
 *     backoff with jitter - retried INDEFINITELY (never abandoned;
 *     bounded backoff keeps it visible and eligible forever).
 *   permanent (400/401/403/404/422/malformed) -> status='permanent_failed'
 *     - surfaced loudly; requires remediation/reconciliation.
 */
async function markMutationFailed(id, error, httpStatus) {
  if (!db) return
  try {
    const verdict = classifyMutationFailure(httpStatus, error)
    const now = Date.now()
    if (verdict === 'permanent') {
      await db.$executeRawUnsafe(
        'UPDATE "_pending_mutations" SET status = \'permanent_failed\', attempts = attempts + 1, "last_attempt_at" = ?, "last_http_status" = ?, "last_error" = ?, "next_retry_at" = NULL WHERE id = ?',
        now, httpStatus ?? null, String(error || '').substring(0, 500), id
      )
      console.error('[LocalAPI] Outbox mutation PERMANENTLY FAILED (needs attention - not retried):', id, httpStatus || '', String(error || '').substring(0, 160))
      emitEvent('mutation:permanent-failure', { id, httpStatus: httpStatus ?? null, error: String(error || '').substring(0, 200) })
    } else {
      const row = await db.$queryRawUnsafe('SELECT attempts FROM "_pending_mutations" WHERE id = ?', id)
      const attempts = Number(row?.[0]?.attempts || 0) + 1
      const nextRetryAt = now + computeRetryBackoffMs(attempts)
      await db.$executeRawUnsafe(
        'UPDATE "_pending_mutations" SET status = \'retry\', attempts = ?, "last_attempt_at" = ?, "last_http_status" = ?, "last_error" = ?, "next_retry_at" = ? WHERE id = ?',
        attempts, now, httpStatus ?? null, String(error || '').substring(0, 500), nextRetryAt, id
      )
      console.warn('[LocalAPI] Outbox mutation failed (transient) - retry', attempts, 'scheduled in', Math.round((nextRetryAt - now) / 1000) + 's:', String(error || '').substring(0, 120))
    }
  } catch (e) {
    console.error('[LocalAPI] Failed to mark mutation failed:', e.message)
  }
}

/**
 * Mark a mutation as conflicted (cloud rejected with a conflict verdict) -
 * kept OUT of the retry pool; surfaced via _sync_conflicts reconciliation.
 */
async function markMutationConflict(id, error) {
  if (!db) return
  try {
    await db.$executeRawUnsafe(
      'UPDATE "_pending_mutations" SET status = \'conflict\', attempts = attempts + 1, "last_attempt_at" = ?, "last_error" = ? WHERE id = ?',
      Date.now(), String(error || '').substring(0, 500), id
    )
    console.warn('[LocalAPI] Outbox mutation CONFLICT - needs reconciliation:', id)
  } catch (e) {
    console.error('[LocalAPI] Failed to mark mutation conflict:', e.message)
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

  /**
   * Desktop login = CLOUD LOGIN → LOCAL UNLOCK (Task 14).
   *
   * Resolution order (generic for every role — no per-user special cases):
   *   1. LOCAL UNLOCK — LocalDeviceCredential (user+device) scrypt verifier.
   *      Works with the cloud completely offline. Only the user who logged
   *      in on THIS device has one.
   *   2. LEGACY LOCAL HASH — pre-contract local rows that still carry a
   *      passwordHash (dev fixtures / accounts created before the sync
   *      contract change). A mismatch FALLS THROUGH to the cloud so a
   *      password changed on the cloud still logs in.
   *   3. CLOUD LOGIN PROXY — forwards the credentials to the cloud API; on
   *      success upserts the local profile (profile-only), imports the
   *      cloud session, and creates THIS user's device credential so the
   *      next restart can unlock offline.
   *   4. NO LOCAL CREDENTIAL — an explicit, machine-readable verdict so the
   *      UI can say "log in with the cloud once to enable offline unlock".
   */
  app.post('/api/auth/login', async (c) => {
    try {
      const body = await c.req.json()
      const { username, password } = body

      if (!username || !password) {
        return c.json({ success: false, error: 'Username and password required' }, 400)
      }
      if (!db) {
        return c.json({ success: false, error: 'Local database not ready' }, 503)
      }

      const invalid = () => c.json({ success: false, error: 'Invalid username or password' }, 401)
      const deactivated = () => c.json({ success: false, error: 'Account is deactivated' }, 403)

      const buildStaffAgencyId = async (user) => {
        if (user.role === 'AGENCY_OWNER' || user.role === 'AGENCY_STAFF') {
          const staff = await db.agencyStaff.findFirst({
            where: { userId: user.id, isActive: true },
          })
          if (staff) return staff.agencyId
          // Owner fallback: the cloud's agency-create flow binds an owner via
          // Agency.ownerId ONLY (no AgencyStaff row is ever created), so a
          // wizard-created owner syncing locally has no staff row. Without
          // this fallback the local session gets agencyId: null after
          // re-login and every /api/agency/* read returns 403 → the profile,
          // settings and QR pages all render empty (mirrors cloud auth.ts).
          if (user.role === 'AGENCY_OWNER') {
            const owned = await db.agency.findFirst({ where: { ownerId: user.id } })
            if (owned) return owned.id
          }
          return null
        }
        return null
      }

      // Find user in local SQLite (may be absent on a fresh machine)
      const user = await db.user.findUnique({ where: { username } }).catch(() => null)

      // ── 1. Local unlock via device credential (fully offline) ──
      if (user && db.localDeviceCredential) {
        const deviceId = await getDeviceId()
        const cred = await db.localDeviceCredential.findUnique({
          where: { userId_deviceId: { userId: user.id, deviceId } },
        }).catch(() => null)
        if (cred && !cred.revokedAt && verifierMatches(cred, password)) {
          if (!user.isActive) return deactivated()
          const sessionData = {
            id: user.id,
            username: user.username,
            fullName: user.fullName,
            role: user.role,
            language: user.language || 'ar',
            avatarUrl: user.avatarUrl || null,
            agencyId: await buildStaffAgencyId(user),
          }
          sessionToken = randomBytes(32).toString('hex')
          sessionUser = sessionData
          emitEvent('auth:login', { user: sessionData })
          console.log('[LocalAPI] Local unlock via device credential:', sessionData.username)
          return c.json({ success: true, user: sessionData, token: sessionToken, unlockedLocally: true })
        }
      }

      // ── 2. Legacy local passwordHash (pre-contract rows only) ──
      // NOTE: a mismatch falls through to the cloud (the local hash may be
      // stale after a cloud-side password change) — it does NOT return 401.
      if (user && user.passwordHash) {
        const inputHash = createHash('sha256').update(password).digest('hex')
        try {
          const storedBuf = Buffer.from(user.passwordHash, 'utf-8')
          const inputBuf = Buffer.from(inputHash, 'utf-8')
          let ok = storedBuf.length === inputBuf.length && timingSafeEqual(storedBuf, inputBuf)
          if (!ok && user.passwordHash.startsWith('$2')) {
            try {
              const bcrypt = require('bcryptjs')
              ok = await bcrypt.compare(password, user.passwordHash)
            } catch { ok = false }
          }
          if (ok) {
            if (!user.isActive) return deactivated()
            const sessionData = {
              id: user.id,
              username: user.username,
              fullName: user.fullName,
              role: user.role,
              language: user.language || 'ar',
              avatarUrl: await localizeFileUrl(user.avatarUrl || null),
              agencyId: await buildStaffAgencyId(user),
            }
            sessionToken = randomBytes(32).toString('hex')
            sessionUser = sessionData
            emitEvent('auth:login', { user: sessionData })
            return c.json({ success: true, user: sessionData, token: sessionToken })
          }
        } catch { /* fall through to the cloud */ }
      }

      // ── 3. Cloud login through the local API (+ device credential) ──
      const cloud = await cloudLoginProxy(username, password, body && body.rememberMe ? { rememberMe: true } : undefined)

      // ── Task 22: cloud requires email/phone OTP verification ──
      // The account exists but is NOT verified: pass the verification payload
      // through and DO NOT establish any session (local or cloud) until the
      // codes are confirmed via POST /api/auth/verify.
      if (cloud.ok && cloud.data && cloud.data.requiresVerification) {
        console.log(`[LocalAPI] Cloud login requires verification for: ${username}`)
        return c.json(cloud.data, 200)
      }

      if (cloud.ok && cloud.data && cloud.data.user && cloud.data.token) {
        const cloudUser = cloud.data.user
        try {
          await upsertLocalUserFromCloud(cloudUser)
        } catch (e) {
          console.warn('[LocalAPI] Local profile upsert after cloud login failed:', e?.message || e)
        }
        try {
          await storeDeviceCredential(cloudUser.id, password, body ? body.keepSignedIn : undefined)
        } catch (e) {
          console.warn('[LocalAPI] Device credential store failed:', e?.message || e)
        }
        sessionToken = cloud.data.token
        sessionUser = {
          id: cloudUser.id,
          username: cloudUser.username || cloudUser.email || 'imported',
          fullName: cloudUser.fullName || cloudUser.name || '',
          role: cloudUser.role || 'CUSTOMER',
          language: cloudUser.language || 'ar',
          avatarUrl: await localizeFileUrl(cloudUser.avatarUrl || null),
          agencyId: cloudUser.agencyId || null,
        }
        emitEvent('auth:login', { user: sessionUser })
        // Round 15 — push any local-only files (e.g. an avatar uploaded
        // offline) now that a session exists.
        if (fileSync) fileSync.schedule('login')
        console.log('[LocalAPI] Cloud login via local API — device credential stored:', sessionUser.username)
        return c.json({ success: true, user: sessionUser, token: sessionToken })
      }

      // The cloud REJECTED the credentials — a definitive wrong-password (not offline).
      if (cloud.status === 401 || cloud.status === 403) return invalid()

      // Cloud unreachable and no local unlock is possible for this profile.
      if (user) {
        return c.json({
          success: false,
          error: 'Invalid username or password',
          code: 'NO_LOCAL_CREDENTIAL',
          cloudLoginRequired: true,
        }, 401)
      }
      return invalid()
    } catch (error) {
      console.error('[LocalAPI] Login error:', error)
      return c.json({ success: false, error: 'Login failed' }, 500)
    }
  })

  /**
   * Plaintext passwords stashed between REGISTER and VERIFY (Task 22).
   * Keyed by verificationToken; only used to derive the offline unlock
   * credential the moment verification completes. Memory-only — a restart
   * simply means the credential is stored at the next successful login.
   */
  const pendingVerificationPasswords = new Map()

  /**
   * Register a new account — CLOUD-NATIVE operation proxied through the
   * local API. The desktop UI always targets 127.0.0.1:3080 (local-first
   * contract), so without this route account creation was impossible in the
   * desktop app even though the web register form existed.
   *
   * Flow (registration REQUIRES the cloud — an offline-created account would
   * never exist on the cloud and could never sync or log in elsewhere):
   *   1. Forward the payload to the cloud POST /api/auth/register.
   *   2. Cloud rejection (409 username/phone taken, validation, …) is passed
   *      through verbatim so the form can map field errors.
   *   3. Task 22: the cloud now returns requiresVerification=true + a
   *      verificationToken — OTP codes are sent for email + phone and NO
   *      session exists until the codes are confirmed (POST /api/auth/verify).
   *      The plaintext password is stashed in memory so the offline unlock
   *      credential can be derived the moment verification completes.
   *   4. Legacy path (cloud WITHOUT verification enforcement): sign in
   *      immediately as before.
   */
  app.post('/api/auth/register', async (c) => {
    try {
      if (!db) {
        return c.json({ success: false, error: 'Local database not ready' }, 503)
      }

      let body
      try { body = await c.req.json() } catch { body = null }
      if (!body || typeof body !== 'object' || !String(body.username || '').trim() || !String(body.password || '') || !String(body.fullName || '').trim()) {
        return c.json({ success: false, error: 'username, fullName and password are required' }, 400)
      }
      if (String(body.password).length < 6) {
        return c.json({ success: false, error: 'Password must be at least 6 characters' }, 400)
      }

      const base = cloudBaseUrl()
      let reg
      try {
        const res = await fetch(base + '/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        })
        let data = null
        try { data = await res.json() } catch { /* non-JSON error body */ }
        reg = { ok: res.ok, status: res.status, data }
      } catch (err) {
        console.warn('[LocalAPI] Register proxy: cloud unreachable:', err?.message || err)
        return c.json({
          success: false,
          error: 'Account creation requires an internet connection — the cloud API is unreachable',
          code: 'CLOUD_UNREACHABLE',
        }, 503)
      }

      if (!reg.ok || !reg.data || !reg.data.user) {
        const status = reg.status || 500
        const errBody = reg.data && typeof reg.data === 'object'
          ? reg.data
          : { success: false, error: 'Registration failed' }
        console.warn(`[LocalAPI] Register rejected by cloud: HTTP ${status} — ${errBody.error || '(no error body)'}`)
        return c.json(errBody, status)
      }

      const cloudUser = reg.data.user
      const password = String(body.password)
      const username = String(body.username).trim()

      // ── Task 22: account created but UNVERIFIED — no session yet ──
      if (reg.data.requiresVerification && reg.data.verificationToken) {
        try {
          await upsertLocalUserFromCloud(cloudUser)
        } catch (e) {
          console.warn('[LocalAPI] Register: local profile upsert failed:', e?.message || e)
        }
        pendingVerificationPasswords.set(reg.data.verificationToken, {
          userId: cloudUser.id,
          password,
          storedAt: Date.now(),
        })
        // Prune stashes older than 30 minutes (verificationToken TTL is 15)
        for (const [k, v] of pendingVerificationPasswords) {
          if (Date.now() - v.storedAt > 30 * 60 * 1000) pendingVerificationPasswords.delete(k)
        }
        console.log(`[LocalAPI] Account registered — awaiting email/phone verification: ${cloudUser.username || username}`)
        return c.json(reg.data, 201)
      }

      // Legacy path — cloud without verification enforcement: sign in now

      // Sign in immediately — acquire the cloud session token (best effort).
      let token = null
      try {
        const cloud = await cloudLoginProxy(username, password)
        if (cloud.ok && cloud.data && cloud.data.user && cloud.data.token) {
          token = cloud.data.token
        }
      } catch { /* tolerated — local token minted below */ }
      if (!token) {
        token = randomBytes(32).toString('hex')
        console.warn('[LocalAPI] Register: cloud token unavailable — minted a LOCAL session token (a cloud token will be acquired at the next login)')
      }

      try {
        await upsertLocalUserFromCloud(cloudUser)
      } catch (e) {
        console.warn('[LocalAPI] Register: local profile upsert failed:', e?.message || e)
      }
      try {
        await storeDeviceCredential(cloudUser.id, password)
      } catch (e) {
        console.warn('[LocalAPI] Register: device credential store failed:', e?.message || e)
      }

      sessionToken = token
      sessionUser = {
        id: cloudUser.id,
        username: cloudUser.username || username,
        fullName: cloudUser.fullName || '',
        role: cloudUser.role || 'CUSTOMER',
        language: cloudUser.language || 'ar',
        avatarUrl: cloudUser.avatarUrl || null,
        agencyId: cloudUser.agencyId || null,
      }
      emitEvent('auth:login', { user: sessionUser })
      console.log(`[LocalAPI] Account registered + session established: ${sessionUser.username} (${sessionUser.role})`)
      return c.json({
        success: true,
        user: { ...sessionUser, phoneNumber: cloudUser.phoneNumber ?? null },
        token,
        isNewUser: true,
      }, 201)
    } catch (error) {
      console.error('[LocalAPI] Register error:', error)
      return c.json({ success: false, error: 'Registration failed' }, 500)
    }
  })

  // ── Task 22: OTP verification proxies (cloud-native operations) ─────────

  /**
   * POST /api/auth/verify — proxy to the cloud. On FULL verification the
   * cloud returns { verified: true, user, token }: the local profile is
   * upserted, the offline unlock credential is derived from the stashed
   * register password (when available), and the local session is established
   * with the CLOUD token — exactly the pre-Task-22 register success shape.
   */
  app.post('/api/auth/verify', async (c) => {
    try {
      let body
      try { body = await c.req.json() } catch { body = null }
      if (!body || !body.verificationToken) {
        return c.json({ success: false, error: 'verificationToken is required' }, 400)
      }
      const base = cloudBaseUrl()
      let cloud
      try {
        const res = await fetch(base + '/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        })
        let data = null
        try { data = await res.json() } catch { /* non-JSON */ }
        cloud = { ok: res.ok, status: res.status, data }
      } catch (err) {
        return c.json({
          success: false,
          error: 'Verification requires an internet connection — the cloud API is unreachable',
          code: 'CLOUD_UNREACHABLE',
        }, 503)
      }

      if (!cloud.ok || !cloud.data) {
        return c.json(cloud.data || { success: false, error: 'Verification failed' }, cloud.status || 500)
      }

      // Partial verification (one channel done, the other pending) → pass through
      if (!cloud.data.verified) {
        return c.json(cloud.data, cloud.status || 200)
      }

      // FULL verification → establish the local session (parity with register)
      const verifiedUser = cloud.data.user
      const token = cloud.data.token
      try {
        await upsertLocalUserFromCloud(verifiedUser)
      } catch (e) {
        console.warn('[LocalAPI] Verify: local profile upsert failed:', e?.message || e)
      }

      const stashed = pendingVerificationPasswords.get(body.verificationToken)
      if (stashed && stashed.userId === verifiedUser.id) {
        try {
          await storeDeviceCredential(verifiedUser.id, stashed.password)
        } catch (e) {
          console.warn('[LocalAPI] Verify: device credential store failed:', e?.message || e)
        }
        pendingVerificationPasswords.delete(body.verificationToken)
      }

      sessionToken = token
      sessionUser = {
        id: verifiedUser.id,
        username: verifiedUser.username || 'verified',
        fullName: verifiedUser.fullName || '',
        role: verifiedUser.role || 'CUSTOMER',
        language: verifiedUser.language || 'ar',
        avatarUrl: await localizeFileUrl(verifiedUser.avatarUrl || null),
        agencyId: verifiedUser.agencyId || null,
      }
      emitEvent('auth:login', { user: sessionUser })
      console.log(`[LocalAPI] Account VERIFIED + session established: ${sessionUser.username} (${sessionUser.role})`)
      // Round 15 — with a session in hand the file-sync worker can finally
      // push the register-time avatar (and any other local-only files) to
      // the cloud. Fire it now so the avatar appears on the user's OTHER
      // devices within seconds.
      if (fileSync) fileSync.schedule('verified')
      return c.json({
        success: true,
        verified: true,
        user: { ...sessionUser, email: verifiedUser.email ?? null, phoneNumber: verifiedUser.phoneNumber ?? null },
        token,
        isNewUser: true,
      })
    } catch (error) {
      console.error('[LocalAPI] Verify error:', error)
      return c.json({ success: false, error: 'Verification failed' }, 500)
    }
  })

  /** POST /api/auth/resend-verification — thin proxy (rate limits live on the cloud). */
  app.post('/api/auth/resend-verification', async (c) => {
    try {
      let body
      try { body = await c.req.json() } catch { body = null }
      if (!body || !body.verificationToken || !body.channel) {
        return c.json({ success: false, error: 'verificationToken and channel are required' }, 400)
      }
      const base = cloudBaseUrl()
      const res = await fetch(base + '/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      let data = null
      try { data = await res.json() } catch { /* non-JSON */ }
      return c.json(data || { success: false, error: 'Resend failed' }, res.ok ? 200 : (res.status || 500))
    } catch (err) {
      return c.json({
        success: false,
        error: 'Resending the code requires an internet connection — the cloud API is unreachable',
        code: 'CLOUD_UNREACHABLE',
      }, 503)
    }
  })

  /** POST /api/auth/verification-status — thin proxy (resume an interrupted flow). */
  app.post('/api/auth/verification-status', async (c) => {
    try {
      let body
      try { body = await c.req.json() } catch { body = null }
      if (!body || !body.verificationToken) {
        return c.json({ success: false, error: 'verificationToken is required' }, 400)
      }
      const base = cloudBaseUrl()
      const res = await fetch(base + '/api/auth/verification-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
      let data = null
      try { data = await res.json() } catch { /* non-JSON */ }
      return c.json(data || { success: false, error: 'Status check failed' }, res.ok ? 200 : (res.status || 500))
    } catch (err) {
      return c.json({
        success: false,
        error: 'The cloud API is unreachable',
        code: 'CLOUD_UNREACHABLE',
      }, 503)
    }
  })

  /**
   * Task 23: file-upload proxies — the desktop UI (apiClient) always targets
   * 127.0.0.1:3080 (local-first contract), but file STORAGE is a cloud
   * property (the returned URL must be reachable from every device), so the
   * local API forwards the multipart/JSON body to the cloud verbatim. Offline
   * → explicit 503 CLOUD_UNREACHABLE, same contract as the register/verify
   * proxies.
   *
   * POST is deliberately NOT session-gated here: account creation uploads an
   * avatar BEFORE the account exists (no session until OTP verification), so
   * the cloud's own per-type policy applies (public avatar path under strict
   * limits, every other type requires the forwarded cloud token).
   */

  /**
   * Round 15 — POST /api/upload is now LOCAL-FIRST. The previous
   * implementation forwarded the multipart body verbatim to the cloud, so a
   * registration-time avatar upload failed the instant the cloud was
   * unreachable (the reported "the image never shows in the preview") and
   * the desktop stored no files at all. Now:
   *   1. The file is written to THIS device's organized file store
   *      (lib/file-store.js → <files>/<bucket>/<yyyy>/<mm>/…).
   *   2. A local FileAsset row is created (syncState LOCAL_ONLY).
   *   3. The response URL points at THIS local API, so the preview renders
   *      immediately and offline.
   *   4. lib/file-sync.js mirrors the file to the cloud in the background
   *      (POST /api/files/sync/push) and flips the row to SYNCED.
   * Cloud-side URL normalization (apps/api/src/lib/file-url.ts) rewrites the
   * local URL carried in records (avatarUrl, receiptUrl, …) to the cloud's
   * public URL at sync intake, so other devices keep working.
   *
   * Validation mirrors the cloud's per-type policy: the avatar path stays
   * PUBLIC (register-time upload, no session yet) with the strict image-only
   * whitelist + 2MB cap; every other bucket requires a session.
   */
  const UPLOAD_LIMITS = {
    avatar: 2 * 1024 * 1024,
    logo: 2 * 1024 * 1024,
    receipt: 5 * 1024 * 1024,
    document: 10 * 1024 * 1024,
    general: 5 * 1024 * 1024,
  }
  const PUBLIC_AVATAR_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
  const ALL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf'])

  app.post('/api/upload', async (c) => {
    try {
      let formData
      try {
        formData = await c.req.formData()
      } catch (parseErr) {
        return c.json({ success: false, error: 'multipart/form-data body required' }, 400)
      }
      const file = formData.get('file')
      const rawType = String(formData.get('type') || c.req.query('type') || 'general').trim().toLowerCase()
      const bucket = ['general', 'avatar', 'logo', 'receipt', 'document'].includes(rawType) && /^[a-z][a-z0-9-]{0,23}$/.test(rawType)
        ? rawType
        : 'general'

      if (!file || typeof file === 'string') {
        return c.json({ success: false, error: 'No file provided' }, 400)
      }

      const ext = (String(file.name || '').split('.').pop() || '').toLowerCase()

      // ── Auth + extension policy (mirrors the cloud route) ──
      if (bucket === 'avatar') {
        // PUBLIC path — registration uploads an avatar before any session exists.
        if (!PUBLIC_AVATAR_EXTENSIONS.has(ext)) {
          return c.json({ success: false, error: `Invalid image type ".${ext}" — allowed: ${[...PUBLIC_AVATAR_EXTENSIONS].join(', ')}` }, 400)
        }
      } else {
        if (!sessionToken) {
          return c.json({ success: false, error: 'Authentication required' }, 401)
        }
        if (!ALL_EXTENSIONS.has(ext)) {
          return c.json({ success: false, error: `Invalid file type ".${ext}" — allowed: ${[...ALL_EXTENSIONS].join(', ')}` }, 400)
        }
      }

      const maxBytes = UPLOAD_LIMITS[bucket] || UPLOAD_LIMITS.general
      if (file.size > maxBytes) {
        return c.json({ success: false, error: `File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB` }, 400)
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      const filename = fileStore.makeFilename(ext)
      const saved = await fileStore.saveUpload(bucket, buffer, filename)

      const checksum = createHash('sha256').update(buffer).digest('hex')
      const deviceFileId = 'dev-' + randomBytes(12).toString('hex')
      const url = fileStore.absoluteFileUrl(localOrigin, saved.storagePath)

      try {
        await db.fileAsset.create({
          data: {
            deviceFileId,
            bucket,
            storagePath: saved.storagePath,
            originalName: String(file.name || filename).slice(0, 200),
            mimeType: file.type || 'application/octet-stream',
            size: buffer.length,
            checksum,
            url,
            ownerId: sessionUser ? sessionUser.id : null,
            agencyId: sessionUser && sessionUser.agencyId ? sessionUser.agencyId : null,
            syncState: 'LOCAL_ONLY',
          },
        })
      } catch (regErr) {
        // The blob is durably stored; a registry hiccup must not fail the upload.
        console.warn('[LocalAPI] FileAsset registration failed:', regErr?.message || regErr)
      }

      // Kick the file-sync worker — the blob reaches the cloud in the background.
      if (fileSync) fileSync.schedule('upload')

      return c.json({
        success: true,
        url,
        path: fileStore.publicFilePath(saved.storagePath),
        filename,
        storagePath: saved.storagePath,
        deviceFileId,
        provider: 'local-device',
        size: buffer.length,
        type: bucket,
        syncState: 'LOCAL_ONLY',
      }, 201)
    } catch (error) {
      console.error('[LocalAPI] Upload error:', error)
      return c.json({ success: false, error: 'Upload failed' }, 500)
    }
  })

  /**
   * Round 15 — GET /api/upload/file/* serves the LOCAL file store (both the
   * organized <bucket>/<yyyy>/<mm>/<name> shape and the legacy flat
   * <bucket>/<name> shape). Public like the cloud (capability URLs — the
   * filenames are unguessable); this is what makes uploaded avatars/logos/
   * receipts render instantly in the desktop UI, OFFLINE included.
   */
  const MIME_BY_EXT = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  }
  const serveLocalFile = async (c) => {
    const type = c.req.param('type')
    const yyyy = c.req.param('yyyy')
    const mm = c.req.param('mm')
    const name = c.req.param('name') || c.req.param('rest')
    if (!type || !name || !/^[a-z][a-z0-9-]{0,23}$/.test(type)) {
      return c.json({ success: false, error: 'Invalid file path' }, 400)
    }
    // Organized route has yyyy/mm params; legacy flat route passes only the name.
    const storagePath = yyyy && mm ? `${type}/${yyyy}/${mm}/${name}` : `${type}/${name}`
    const data = await fileStore.readByStoragePath(storagePath)
    if (!data) {
      return c.json({ success: false, error: 'File not found' }, 404)
    }
    const ext = (name.split('.').pop() || '').toLowerCase()
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': 'inline',
      },
    })
  }
  app.get('/api/upload/file/:type/:yyyy/:mm/:name', serveLocalFile)
  app.get('/api/upload/file/:type/:name', serveLocalFile)

  /**
   * Round 15 — GET /api/files/status: local file store + sync diagnostics.
   */
  app.get('/api/files/status', requireAuth(), async (c) => {
    try {
      const status = fileStore.getStatus()
      const counts = { LOCAL_ONLY: 0, DIRTY: 0, SYNCED: 0, DELETED: 0 }
      try {
        const rows = await db.$queryRawUnsafe('SELECT "syncState", COUNT(*) as n FROM "FileAsset" GROUP BY "syncState"')
        for (const row of rows || []) counts[String(row.syncState)] = Number(row.n)
      } catch { /* table may be absent on ancient DBs */ }
      const cursor = await getLocalMeta('file_sync_cursor')
      return c.json({ success: true, store: status, counts, pullCursor: cursor })
    } catch (error) {
      return c.json({ success: false, error: 'File status failed' }, 500)
    }
  })

  /**
   * Round 15 — POST /api/files/sync-now: run one file-sync round on demand
   * (diagnostics / Settings → Sync recovery).
   */
  app.post('/api/files/sync-now', requireAuth(), async (c) => {
    try {
      if (!fileSync) return c.json({ success: false, error: 'File sync not initialized' }, 503)
      const result = await fileSync.syncNow('manual')
      return c.json({ success: true, result })
    } catch (error) {
      return c.json({ success: false, error: 'File sync failed' }, 500)
    }
  })

  /**
   * Round 15 — DELETE /api/upload removes the LOCAL copy first (offline-safe)
   * and mirrors the deletion to the cloud: a SYNCED file is tombstoned right
   * away (best-effort) or, when offline, the row flips to DELETED so the
   * file-sync worker replays the tombstone once the cloud is reachable.
   */
  app.delete('/api/upload', requireAuth(), async (c) => {
    try {
      let body
      try { body = await c.req.json() } catch { body = {} }
      const url = body && body.url
      if (!url) {
        return c.json({ success: false, error: 'No URL provided' }, 400)
      }
      const storagePath = fileStore.storagePathFromUrl(url)
      if (!storagePath) {
        return c.json({ success: false, error: 'Invalid file URL — only /api/upload/file/* paths are allowed' }, 400)
      }

      // Local removal + registry update.
      await fileStore.deleteByStoragePath(storagePath)
      const row = await db.fileAsset.findFirst({ where: { storagePath } })
      if (row) {
        if (row.syncState === 'SYNCED') {
          // Already on the cloud — tombstone there immediately (best-effort).
          let cloudDeleted = false
          try {
            const res = await fetch(cloudBaseUrl() + `/api/files/sync/${encodeURIComponent(row.deviceFileId)}`, {
              method: 'DELETE',
              headers: { ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
              signal: AbortSignal.timeout(10000),
            })
            cloudDeleted = res.ok || res.status === 404
          } catch { /* offline — replay via the worker */ }
          if (cloudDeleted) {
            await db.fileAsset.delete({ where: { id: row.id } }).catch(() => {})
          } else {
            await db.fileAsset.update({ where: { id: row.id }, data: { syncState: 'DELETED' } }).catch(() => {})
            if (fileSync) fileSync.schedule('delete')
          }
        } else if (row.syncState === 'LOCAL_ONLY' || row.syncState === 'DIRTY') {
          // Never reached the cloud — the local row is enough.
          await db.fileAsset.delete({ where: { id: row.id } }).catch(() => {})
        } else {
          await db.fileAsset.update({ where: { id: row.id }, data: { syncState: 'DELETED' } }).catch(() => {})
        }
      }
      return c.json({ success: true, message: 'File deleted' })
    } catch (error) {
      console.error('[LocalAPI] Upload delete error:', error)
      return c.json({ success: false, error: 'Delete failed' }, 500)
    }
  })

  /**
   * Task 24: /api/app-versions cloud passthrough — app binaries and version
   * records exist ONLY on the cloud, but the admin panel (rendered inside the
   * desktop shell too) posts uploads to the local-first base URL and used to
   * get a bare local 404. Every method is forwarded verbatim — multipart
   * bodies included — with the cloud session token attached when one exists.
   * Authorization is enforced by the cloud (requireAdmin); without a session
   * the forwarded request simply carries no token and the cloud answers 401.
   */
  const forwardAppVersions = async (c) => {
    try {
      const reqUrl = new URL(c.req.url)
      const base = cloudBaseUrl()
      const target = base + reqUrl.pathname + (reqUrl.search || '')
      const method = c.req.method
      const isBodyful = method !== 'GET' && method !== 'HEAD'
      const contentType = c.req.header('Content-Type')
      let bodyBuffer = null
      if (isBodyful) {
        try { bodyBuffer = Buffer.from(await c.req.arrayBuffer()) } catch { bodyBuffer = null }
      }
      let res
      try {
        res = await fetch(target, {
          method,
          headers: {
            ...(contentType ? { 'Content-Type': contentType } : {}),
            ...(bodyBuffer ? { 'Content-Length': String(bodyBuffer.length) } : {}),
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
          },
          body: bodyBuffer,
          signal: AbortSignal.timeout(120000),
        })
      } catch (err) {
        console.warn('[LocalAPI] App-versions proxy: cloud unreachable:', err?.message || err)
        return c.json({
          success: false,
          error: 'App version management requires an internet connection — the cloud API is unreachable',
          code: 'CLOUD_UNREACHABLE',
        }, 503)
      }
      const resContentType = res.headers.get('Content-Type') || ''
      if (resContentType.includes('application/json')) {
        let data = null
        try { data = await res.json() } catch { /* non-JSON body */ }
        return c.json(data || { success: res.ok }, res.status)
      }
      // Binary passthrough (e.g. /download) — stream the bytes back untouched.
      const buf = Buffer.from(await res.arrayBuffer())
      return new Response(buf, {
        status: res.status,
        headers: {
          'Content-Type': resContentType || 'application/octet-stream',
          'Content-Length': String(buf.length),
        },
      })
    } catch (error) {
      console.error('[LocalAPI] App-versions proxy error:', error)
      return c.json({ success: false, error: 'App version request failed' }, 500)
    }
  }
  app.all('/api/app-versions', forwardAppVersions)
  app.all('/api/app-versions/*', forwardAppVersions)

  /**
   * Round 15 — /api/agencies cloud proxy. Agency CREATION is a cloud-native
   * operation (customCode uniqueness, the owner relation, the web/mobile
   * catalogue), but the create-agency form posts to the local-first base
   * URL and the local API had NO /api/agencies route — every attempt 404'd
   * with the self-identifying "Not found" body. POST forwards to the cloud
   * with the session token, then kicks a sync round so the new agency (and
   * its services) land in the local DB immediately; GET forwards admin
   * listings. Authorization stays cloud-enforced.
   */
  const forwardAgencies = async (c) => {
    try {
      const reqUrl = new URL(c.req.url)
      // Strip the web-gateway routing hint — meaningless to the cloud.
      reqUrl.searchParams.delete('XTransformPort')
      const target = cloudBaseUrl() + reqUrl.pathname + (reqUrl.search || '')
      const method = c.req.method
      let bodyBuffer = null
      if (method !== 'GET' && method !== 'HEAD') {
        try { bodyBuffer = Buffer.from(await c.req.arrayBuffer()) } catch { bodyBuffer = null }
      }
      let res
      try {
        res = await fetch(target, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(bodyBuffer ? { 'Content-Length': String(bodyBuffer.length) } : {}),
            ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
          },
          body: bodyBuffer,
          signal: AbortSignal.timeout(30000),
        })
      } catch (err) {
        console.warn('[LocalAPI] Agencies proxy: cloud unreachable:', err?.message || err)
        return c.json({
          success: false,
          error: 'Creating an agency requires an internet connection — the cloud API is unreachable',
          code: 'CLOUD_UNREACHABLE',
        }, 503)
      }
      let data = null
      try { data = await res.json() } catch { /* non-JSON */ }
      if (res.ok && (method === 'POST' || method === 'PUT' || method === 'PATCH') && data && data.success) {
        // Round 16 — agency CREATED: adopt it into the local session at once.
        // The cloud 201 now carries an upgraded token whose JWT embeds the new
        // agencyId; the renderer adopts it (setSessionToken → IPC setAuth),
        // but the local session must not stay agency-less until then — every
        // /api/agency/* read would 403 and the db-status readiness gate would
        // keep reporting NOT_INITIALIZED.
        if (method === 'POST' && data.agency && data.agency.id && sessionUser) {
          sessionUser.agencyId = data.agency.id
          console.log('[LocalAPI] Session agencyId updated after agency create:', data.agency.id)
          emitEvent('auth:login', { user: sessionUser })
        }
        // Kick a sync round so the created/updated agency appears locally at once.
        try { if (fileSync) fileSync.schedule('agency-created') } catch { /* non-fatal */ }
        try {
          // Lazy require — sync-service lazily requires ./index (circular dep).
          const syncService = require('./sync-service')
          if (syncService && syncService.triggerSyncNow) syncService.triggerSyncNow()
        } catch { /* non-fatal */ }
      }
      return c.json(data || { success: res.ok }, res.ok ? (res.status === 201 ? 201 : 200) : (res.status || 500))
    } catch (error) {
      console.error('[LocalAPI] Agencies proxy error:', error)
      return c.json({ success: false, error: 'Agency request failed' }, 500)
    }
  }
  app.post('/api/agencies', forwardAgencies)
  app.get('/api/agencies', forwardAgencies)
  // Round 17 — sub-path GETs forward too: the create-agency wizard live-checks
  // the chosen code via GET /api/agencies/check-code?code=XXX before submit.
  app.get('/api/agencies/*', forwardAgencies)
  app.put('/api/agencies/*', forwardAgencies)
  app.patch('/api/agencies/*', forwardAgencies)

  /**
   * Round 16 — /api/auth/refresh-session proxy. Asks the cloud to re-issue
   * the session token from the DATABASE's current state (role + agency
   * ownership). This upgrades a stale snapshot token — the exact situation
   * of an AGENCY_OWNER whose token predates their agency (agencyId: '') —
   * and imports the fresh token + user into THIS local session so the sync
   * engine and every local agency endpoint see the agency immediately.
   * No local body needed; the CURRENT stored cloud token is forwarded.
   */
  app.post('/api/auth/refresh-session', async (c) => {
    try {
      if (!sessionToken) {
        return c.json({ success: false, error: 'No active session' }, 401)
      }
      let res
      try {
        res = await fetch(cloudBaseUrl() + '/api/auth/refresh-session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': 2,
            Authorization: 'Bearer ' + sessionToken,
          },
          body: '{}',
          signal: AbortSignal.timeout(15000),
        })
      } catch (err) {
        console.warn('[LocalAPI] Refresh-session proxy: cloud unreachable:', err?.message || err)
        return c.json({ success: false, error: 'Refreshing the session requires an internet connection', code: 'CLOUD_UNREACHABLE' }, 503)
      }
      let data = null
      try { data = await res.json() } catch { /* non-JSON */ }
      if (res.ok && data && data.success && data.token && data.user) {
        // Adopt the refreshed session locally (same contract as import-session).
        sessionToken = data.token
        sessionUser = {
          id: data.user.id,
          username: data.user.username || data.user.email || 'imported',
          fullName: data.user.fullName || data.user.name || '',
          role: data.user.role || 'CUSTOMER',
          language: data.user.language || 'ar',
          avatarUrl: await localizeFileUrl(data.user.avatarUrl || null),
          agencyId: data.user.agencyId || null,
        }
        console.log('[LocalAPI] Session refreshed from cloud:', sessionUser.username, 'agency:', sessionUser.agencyId || 'none')
        emitEvent('auth:login', { user: sessionUser })
        if (fileSync) fileSync.schedule('refresh-session')
      }
      return c.json(data || { success: res.ok }, res.ok ? 200 : (res.status || 500))
    } catch (error) {
      console.error('[LocalAPI] Refresh-session proxy error:', error)
      return c.json({ success: false, error: 'Session refresh failed' }, 500)
    }
  })

  /**
   * Username availability check for the register form — cloud-first (global
   * uniqueness is a cloud property), with a LOCAL fallback so the form still
   * behaves sensibly when the cloud is briefly unreachable. Same response
   * contract as the cloud route: { available: boolean }.
   */
  app.get('/api/auth/check-username', async (c) => {
    const username = (c.req.query('username') || '').trim()
    const validShape = username.length >= 3 && username.length <= 30 && /^[a-zA-Z0-9_]+$/.test(username)
    if (!validShape) {
      // Short names never block typing (same as the cloud route); invalid
      // shapes are reported unavailable.
      return c.json({ available: username.length >= 3 })
    }
    try {
      const res = await fetch(cloudBaseUrl() + '/api/auth/check-username?username=' + encodeURIComponent(username), {
        signal: AbortSignal.timeout(5000),
      })
      const data = await res.json().catch(() => null)
      if (data && typeof data.available === 'boolean') {
        return c.json({ available: data.available })
      }
    } catch { /* fall through to the local check */ }
    try {
      if (db) {
        const existing = await db.user.findUnique({ where: { username }, select: { id: true } }).catch(() => null)
        return c.json({ available: !existing })
      }
    } catch { /* ignore */ }
    // Never block registration on an unavailable check.
    return c.json({ available: true })
  })

  app.get('/api/auth/session', async (c) => {
    if (!sessionUser) {
      return c.json({ success: false, error: 'No active session' }, 401)
    }
    // "Keep signed in on this device" preference (Task 14). Default TRUE —
    // matches the historic auto-restore behavior — and only an explicit
    // 'false' in _sync_meta disables it.
    let keepSignedIn = true
    try { keepSignedIn = (await getLocalMeta('keep_signed_in')) !== 'false' } catch { keepSignedIn = true }
    // Return in NextAuth-compatible format (same as cloud API)
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
      keepSignedIn,
    })
  })

  app.post('/api/auth/logout', (c) => {
    const previousUser = sessionUser
    sessionToken = null
    sessionUser = null
    emitEvent('auth:logout', { previousUser })
    return c.json({ success: true, data: { message: 'Logged out' } })
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
        avatarUrl: await localizeFileUrl(user.avatarUrl || null),
        agencyId: user.agencyId || null,
      }

      console.log('[LocalAPI] Session imported from cloud:', sessionUser.username, 'role:', sessionUser.role)
      emitEvent('auth:login', { user: sessionUser })
      if (fileSync) fileSync.schedule('import-session')

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

  // ═════════════════════════════════════════════════════════════════
  // LOCAL DEVICE CREDENTIAL (desktop unlock — Task 14)
  // ═════════════════════════════════════════════════════════════════

  /**
   * Store/refresh the CURRENT session user's local unlock credential for
   * THIS device. Callable any time while the session is valid — after a
   * cloud login (the local login proxy already does this automatically) or
   * explicitly from the Electron main process/renderer.
   *
   * Body: { password?: string, verifier?: string, salt?: string, keepSignedIn?: boolean }
   *  - password  → server derives the scrypt verifier (request never leaves 127.0.0.1)
   *  - verifier+salt → pre-derived by the caller (Electron main process)
   * The credential is bound to (sessionUser.id, deviceId) — never global.
   */
  app.post('/api/auth/device-credential', authMiddleware, async (c) => {
    try {
      if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
      if (!db.localDeviceCredential) {
        return c.json({ success: false, error: 'localDeviceCredential model unavailable — regenerate the Prisma client' }, 503)
      }
      const userId = sessionUser && sessionUser.id
      if (!userId) return c.json({ success: false, error: 'No active session user' }, 401)

      const body = await c.req.json().catch(() => ({}))
      let verifierHash = null
      let salt = null
      if (body && typeof body.password === 'string' && body.password.length > 0) {
        salt = randomBytes(16).toString('hex')
        verifierHash = deriveUnlockVerifier(body.password, salt)
      } else if (
        body && typeof body.verifier === 'string' && typeof body.salt === 'string' &&
        /^[0-9a-f]{32,}$/i.test(body.salt) && /^[0-9a-f]{64,}$/i.test(body.verifier)
      ) {
        verifierHash = body.verifier.toLowerCase()
        salt = body.salt.toLowerCase()
      } else {
        return c.json({ success: false, error: 'password or (verifier + salt) required' }, 400)
      }

      const deviceId = await getDeviceId()
      const existing = await db.localDeviceCredential.findUnique({
        where: { userId_deviceId: { userId, deviceId } },
      }).catch(() => null)
      if (existing) {
        await db.localDeviceCredential.update({
          where: { id: existing.id },
          data: { verifierHash, salt, revokedAt: null },
        })
      } else {
        await db.localDeviceCredential.create({ data: { userId, deviceId, verifierHash, salt } })
      }
      let keepSignedIn = null
      if (body && typeof body.keepSignedIn === 'boolean') {
        await setLocalMeta('keep_signed_in', body.keepSignedIn ? 'true' : 'false')
        keepSignedIn = body.keepSignedIn
      }
      console.log('[LocalAPI] Device credential stored for user', String(userId).substring(0, 8) + '…', 'device', deviceId.substring(0, 12) + '…')
      return c.json({ success: true, deviceId, keepSignedIn })
    } catch (error) {
      console.error('[LocalAPI] Device credential error:', error)
      return c.json({ success: false, error: 'Failed to store device credential' }, 500)
    }
  })

  /**
   * Revoke the CURRENT session user's local unlock credential for THIS
   * device (e.g. "sign out of this device"). Logout alone does NOT revoke —
   * the credential is what enables offline unlock after a restart.
   */
  app.delete('/api/auth/device-credential', authMiddleware, async (c) => {
    try {
      const userId = sessionUser && sessionUser.id
      if (!userId || !db || !db.localDeviceCredential) {
        return c.json({ success: false, error: 'No active session or model unavailable' }, 401)
      }
      const deviceId = await getDeviceId()
      const result = await db.localDeviceCredential.updateMany({
        where: { userId, deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      return c.json({ success: true, revoked: result?.count || 0 })
    } catch (error) {
      console.error('[LocalAPI] Device credential revoke error:', error)
      return c.json({ success: false, error: 'Failed to revoke device credential' }, 500)
    }
  })

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

  app.get('/api/admin/announcements', authMiddleware, async (c) => {
    return c.json({
      success: true,
      data: { available: false, reason: 'offline', message: 'Announcements require cloud connection' },
    })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 3. AGENCY (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/profile — current agency with stats
  app.get('/api/agency/profile', authMiddleware, async (c) => {
    try {
      // The UI sends ?agencyId=<user.agencyId> — accept it when the session
      // genuinely has access (previously the param was ignored entirely and
      // a session without a bound agencyId 403'd, leaving the profile page
      // with no data at all).
      const agencyId = await resolveSessionAgencyId(c.req.query('agencyId'))
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const agency = await db.agency.findUnique({ where: { id: agencyId } })
      if (!agency) {
        // Problem 6 (review): a session-based fallback must NEVER masquerade
        // as a valid workspace. Session exists ≠ agency workspace initialized.
        //   - pre-READY: fallback is legitimate bootstrap (data not imported
        //     yet) — but flagged so the frontend knows.
        //   - READY + missing Agency row: LOCAL DATA CORRUPTION / INCOMPLETE
        //     WORKSPACE — reported as an error, never as a working profile.
        let workspaceStatus = null
        try {
          const state = await db.agencyLocalState.findFirst({ where: { agencyId }, select: { initializationStatus: true } })
          workspaceStatus = state?.initializationStatus || null
        } catch { /* state table may not exist on ancient DBs */ }

        if (workspaceStatus === 'READY') {
          console.error(`[LocalAPI] CORRUPTION/INCOMPLETE WORKSPACE: status is READY but Agency ${agencyId} is missing locally — refusing the session-based fallback`)
          return c.json({
            success: false,
            error: 'Local workspace incomplete: READY but agency record missing — re-run initial sync (Settings → Sync recovery) or re-login while online',
            code: 'LOCAL_WORKSPACE_INCOMPLETE',
            agencyId,
            initializationStatus: workspaceStatus,
          }, 412)
        }
        console.log(`[LocalAPI] Agency ${agencyId} not in local DB, returning session-based fallback (workspace status: ${workspaceStatus || 'unknown'} — pre-READY bootstrap)`)
        return c.json({
          id: agencyId,
          name: sessionUser.agencyName || sessionUser.name || 'Unknown Agency',
          _partial: true,
          _reason: 'Agency not yet synced to local database',
          _workspaceInitialized: false,
          _workspaceStatus: workspaceStatus,
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

      // Remove sensitive fields
      const { passwordHash, ...safeAgency } = agency

      return c.json({
        id: agency.id,
        name: agency.name,
        nameAr: agency.nameAr,
        nameFr: agency.nameFr,
        address: agency.address,
        category: agency.category,
        phone: agency.phone,
        email: agency.email,
        code: agency.customCode,
        logoUrl: await localizeFileUrl(agency.logoUrl),
        coverUrl: agency.coverUrl ? await localizeFileUrl(agency.coverUrl) : null,
        workingHoursStart: agency.workingHoursStart,
        workingHoursEnd: agency.workingHoursEnd,
        workingDays: agency.workingDays || '1,2,3,4,5',
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
      ])

      return c.json({
        success: true,
        data: {
          totalToday,
          waiting,
          serving,
          completed,
          noShow,
          cancelled,
          averageWaitMinutes: 0, // placeholder — would need actual wait calculations
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

      // Only allow basic fields (Round 15: + workingDays/coverUrl)
      const allowedFields = ['name', 'phone', 'workingHoursStart', 'workingHoursEnd', 'description', 'address', 'logoUrl', 'coverUrl', 'workingDays']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          updateData[field] = body[field]
        }
      }

      if (Object.keys(updateData).length === 0) {
        return c.json({ success: false, error: 'No valid fields to update' }, 400)
      }

      // Part Q: business write + outbox row commit atomically — a crash can
      // no longer produce an agency update the cloud never learns about.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.agency.update({
          where: { id: agencyId },
          data: updateData,
        })
        await logPendingMutation('PUT', '/api/agency/profile', body, row, { tx })
        return row
      })

      emitEvent('agency:updated', { agencyId, ...updateData })

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

      // Part Q: settings write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        if (qs) {
          await tx.queueSettings.update({
            where: { id: qs.id },
            data: { isPaused },
          })
        } else {
          await tx.queueSettings.create({
            data: {
              agencyId,
              isPaused,
              lastIssuedNumber: 0,
              currentServingNumber: 0,
            },
          })
        }
        await logPendingMutation('PATCH', '/api/agency/queue-status', body, { queueOpen: !isPaused }, { tx })
      })

      emitEvent('agency:queue-status', { agencyId, queueOpen: !isPaused })

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

      // Part Q: business write + outbox row commit atomically.
      const service = await withOutboxTransaction(async (tx) => {
        const created = await tx.service.create({
          data: {
            agencyId,
            name,
            prefix: prefix || name.charAt(0).toUpperCase(),
            // estimatedDuration: removed — not a Service schema field
            description: description || null,
            isActive: true,
          },
        })
        // Canonical replay (round-7): record-level create preserves the LOCAL
        // id on the cloud — HTTP replays of create routes recreate the record
        // under a NEW cloud id, permanently breaking later updates by id.
        await logDeterministicOutcome('Service', created.id, 'create', created, null, { tx })
        return created
      })

      emitEvent('service:created', { agencyId, service })

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

      // Part Q: business write + outbox row commit atomically.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.service.update({ where: { id }, data: updateData })
        await logDeterministicOutcome('Service', id, 'update', row, null, { tx })
        return row
      })

      emitEvent('service:updated', { agencyId, serviceId: id, ...updateData })

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

      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        await tx.service.update({
          where: { id },
          data: { isActive: false },
        })
        await logDeterministicOutcome('Service', id, 'delete', {}, null, { tx })
      })

      emitEvent('service:deleted', { agencyId, serviceId: id })

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

      // Part Q: business write + outbox row commit atomically.
      const branch = await withOutboxTransaction(async (tx) => {
        const created = await tx.branch.create({
          data: {
            agencyId,
            name,
            address: address || null,
            phone: phone || null,
            isActive: isActive !== undefined ? Boolean(isActive) : true,
          },
        })
        // Canonical replay (round-7): see the reservation create note —
        // id-preserving record-level create, never an HTTP route replay.
        await logDeterministicOutcome('Branch', created.id, 'create', created, null, { tx })
        return created
      })

      emitEvent('branch:created', { agencyId, branch })

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

        // Part Q: every write below (including the isMain sweep) + the outbox
        // row commit atomically — a crash cannot half-apply a main-branch flip.
        const updated = await withOutboxTransaction(async (tx) => {
          // If setting as main, unset other main branches
          if (updateData.isMain) {
            await tx.branch.updateMany({
              where: { agencyId, isMain: true },
              data: { isMain: false },
            })
          }
          const row = await tx.branch.update({ where: { id }, data: updateData })
          await logDeterministicOutcome('Branch', id, 'update', row, null, { tx })
          return row
        })

        emitEvent('branch:updated', { agencyId, branchId: id, ...updateData })

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
      // Soft delete: set isActive = false — Part Q: atomic with the outbox row.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.branch.update({ where: { id }, data: { isActive: false } })
        await logDeterministicOutcome('Branch', id, 'delete', {}, null, { tx })
        return row
      })
      emitEvent('branch:deleted', { agencyId, branchId: id })
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

      // Part Q: business write + outbox row commit atomically.
      const counter = await withOutboxTransaction(async (tx) => {
        const created = await tx.counter.create({
          data: {
            // agencyId removed — Counter has no direct agencyId, only branchId
            name: name || `Counter ${number}`,
            number,
            branchId: branchId || null,
            isActive: isActive !== undefined ? Boolean(isActive) : true,
          },
        })
        // Canonical replay (round-7): id-preserving record-level create.
        await logDeterministicOutcome('Counter', created.id, 'create', created, null, { tx })
        return created
      })

      emitEvent('counter:created', { agencyId, counter })

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

      // Part Q: business write + outbox row commit atomically.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.counter.update({ where: { id }, data: updateData })
        await logDeterministicOutcome('Counter', id, 'update', row, null, { tx })
        return row
      })

      emitEvent('counter:updated', { agencyId, counterId: id, ...updateData })

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
      const counters = await db.counter.findMany({
        where: { agencyId, branchId },
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
      const { counterId } = c.req.param()
      const counter = await db.counter.findUnique({ where: { id: counterId } })
      if (!counter || counter.agencyId !== agencyId) {
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
        const { counterId } = c.req.param()
        const body = await c.req.json()
        const existing = await db.counter.findUnique({ where: { id: counterId } })
        if (!existing || existing.agencyId !== agencyId) {
          return c.json({ success: false, error: 'Counter not found' }, 404)
        }
        const allowedFields = ['name', 'branchId', 'isActive', 'prefix']
        const updateData = {}
        for (const field of allowedFields) {
          if (body[field] !== undefined) updateData[field] = body[field]
        }
        // Part Q: business write + outbox row commit atomically.
        const updated = await withOutboxTransaction(async (tx) => {
          const row = await tx.counter.update({ where: { id: counterId }, data: updateData })
          await logDeterministicOutcome('Counter', counterId, 'update', row, null, { tx })
          return row
        })
        emitEvent('counter:updated', { agencyId, counterId, ...updateData })
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
      const { counterId } = c.req.param()
      const existing = await db.counter.findUnique({ where: { id: counterId } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Counter not found' }, 404)
      }
      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        await tx.counter.delete({ where: { id: counterId } })
        await logDeterministicOutcome('Counter', counterId, 'delete', {}, null, { tx })
      })
      emitEvent('counter:deleted', { agencyId, counterId })
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
      const agencyId = await resolveSessionAgencyId(c.req.query('agencyId'))
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      // Cloud contract (apps/api/src/routes/agency.ts GET /staff): rows
      // include the joined user and permissions parsed from JSON, returned
      // as { staff: [...] } — the settings UI reads data.staff.
      const staffList = await db.agencyStaff.findMany({
        where: { agencyId },
        include: {
          user: {
            select: { id: true, username: true, fullName: true, role: true, isActive: true },
          },
        },
        orderBy: { joinedAt: 'desc' },
      })

      const staffWithPermissions = staffList.map((s) => {
        let permissions = {}
        try { permissions = s.permissions ? JSON.parse(s.permissions) : {} } catch { permissions = {} }
        return { ...s, permissions }
      })

      return c.json({ success: true, staff: staffWithPermissions, data: staffWithPermissions })
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
  app.post('/api/reservations', authMiddleware, async (c) => {
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

      const reservation = await withOutboxTransaction(async (tx) => {
        const created = await tx.reservation.create({
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
            // Prisma 6 rejects Int 0/1 for Boolean fields (field-discovered by
            // Task-15 live repro — the old `? 1 : 0` 500'd every create).
            fixedTimeEnabled: !!fixedTimeEnabled,
          },
        })

        // Update queue settings (same transaction — the counter and the
        // ticket must commit or roll back together)
        if (qs) {
          await tx.queueSettings.update({
            where: { id: qs.id },
            data: { lastIssuedNumber: newNumber },
          })
        } else {
          await tx.queueSettings.create({
            data: {
              agencyId,
              lastIssuedNumber: newNumber,
              currentServingNumber: 0,
              isPaused: false,
            },
          })
        }

        // Part Q: the outbox row commits ATOMICALLY with the ticket — a crash
        // can no longer produce an issued ticket the cloud never learns about.
        //
        // Round-7 fix: replay as a CANONICAL SYNC_PUSH record-level CREATE,
        // NOT as an HTTP POST replay. The cloud's POST /api/reservations is
        // the CUSTOMER join-queue route — it 403s for AGENCY_OWNER
        // ("Only customers can join queues") and its Zod schema requires
        // agencyId (the local route derives it from the session), so every
        // replayed HTTP row failed permanently (400/403) and locally-issued
        // tickets NEVER reached the cloud. The canonical push applies the
        // exact local record (same id, full data) role-agnostically via
        // POST /api/sync/push — deterministic, idempotent, id-preserving.
        await logDeterministicOutcome('Reservation', created.id, 'create', created, null, { tx })
        return created
      })

      emitEvent('reservation:created', { agencyId, reservation })

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

      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.reservation.update({
          where: { id },
          data: updateData,
        })
        // Part Q: outbox row is atomic with the business write.
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      emitEvent('reservation:updated', { agencyId, reservationId: id, ...updateData })

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
  app.post('/api/queue/call-next', authMiddleware, async (c) => {
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

      // P1-5 (Part Q): the CALLED flip, the serving-number advance and the
      // outbox row commit as ONE transaction — a crash mid-call can never
      // leave the ticket called locally while the cloud believes it WAITING.
      const updated = await withOutboxTransaction(async (tx) => {
        await tx.reservation.update({
          where: { id: next.id },
          data: {
            status: 'CALLED',
            calledAt: now,
            // calledBy: removed — not a Reservation schema field
            counterId: counterId || null,
          },
        })

        // Update current serving number in queue settings
        const qsTx = await tx.queueSettings.findFirst({ where: { agencyId } })
        if (qsTx) {
          await tx.queueSettings.update({
            where: { id: qsTx.id },
            data: { currentServingNumber: next.queueNumber },
          })
        }

        const row = await tx.reservation.findUnique({ where: { id: next.id } })
        await logDeterministicOutcome('Reservation', row && row.id, 'update', row, null, { tx })
        return row
      })

      // Update positions of remaining waiting reservations
      const remainingWaiting = await db.reservation.findMany({
        where: { agencyId, status: 'WAITING' },
        orderBy: { joinedAt: 'asc' },
      })
      // position reassignment loop removed — position is not a schema field

      emitEvent('queue:called', { agencyId, reservation: updated })

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Call-next error:', error)
      return c.json({ success: false, error: 'Failed to call next customer' }, 500)
    }
  })

  // POST /api/queue/call/:id — call specific reservation
  app.post('/api/queue/call/:id', authMiddleware, async (c) => {
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
      const updated = await withOutboxTransaction(async (tx) => {
        await tx.reservation.update({
          where: { id },
          data: {
            status: 'CALLED',
            calledAt: now,
            // calledBy: removed — not a Reservation schema field
            counterId: counterId || null,
          },
        })
        const row = await tx.reservation.findUnique({ where: { id } })
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      emitEvent('queue:called', { agencyId, reservation: updated })

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] Call specific error:', error)
      return c.json({ success: false, error: 'Failed to call reservation' }, 500)
    }
  })

  // POST /api/queue/complete/:id
  app.post('/api/queue/complete/:id', authMiddleware, async (c) => {
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
      const reservation = await withOutboxTransaction(async (tx) => {
        const row = await tx.reservation.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            completedAt: now,
            // completedBy: removed — not a Reservation schema field
          },
        })
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      // Update positions of remaining waiting
      const remainingWaiting = await db.reservation.findMany({
        where: { agencyId, status: 'WAITING' },
        orderBy: { joinedAt: 'asc' },
      })
      // position reassignment loop removed — position is not a schema field

      emitEvent('queue:completed', { agencyId, reservation })

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Complete error:', error)
      return c.json({ success: false, error: 'Failed to complete reservation' }, 500)
    }
  })

  // POST /api/queue/no-show/:id
  app.post('/api/queue/no-show/:id', authMiddleware, async (c) => {
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
      const reservation = await withOutboxTransaction(async (tx) => {
        const row = await tx.reservation.update({
          where: { id },
          data: {
            status: 'NO_SHOW',
            skippedAt: now,
          },
        })
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      // Update positions
      const remainingWaiting = await db.reservation.findMany({
        where: { agencyId, status: 'WAITING' },
        orderBy: { joinedAt: 'asc' },
      })
      // position reassignment loop removed — position is not a schema field

      emitEvent('queue:no-show', { agencyId, reservation })

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] No-show error:', error)
      return c.json({ success: false, error: 'Failed to mark no-show' }, 500)
    }
  })

  // POST /api/queue/cancel/:id
  app.post('/api/queue/cancel/:id', authMiddleware, async (c) => {
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
      const reservation = await withOutboxTransaction(async (tx) => {
        const row = await tx.reservation.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            // cancelledBy: removed — not a Reservation schema field
          },
        })
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      // Update positions
      const remainingWaiting = await db.reservation.findMany({
        where: { agencyId, status: 'WAITING' },
        orderBy: { joinedAt: 'asc' },
      })
      // position reassignment loop removed — position is not a schema field

      emitEvent('queue:cancelled', { agencyId, reservation })

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Cancel error:', error)
      return c.json({ success: false, error: 'Failed to cancel reservation' }, 500)
    }
  })

  // POST /api/queue/postpone/:id
  app.post('/api/queue/postpone/:id', authMiddleware, async (c) => {
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
      const reservation = await withOutboxTransaction(async (tx) => {
        const row = await tx.reservation.update({
          where: { id },
          data: {
            status: 'POSTPONED',
            // postponedAt: removed — not a Reservation schema field
          },
        })
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      // Update positions
      const remainingWaiting = await db.reservation.findMany({
        where: { agencyId, status: 'WAITING' },
        orderBy: { joinedAt: 'asc' },
      })
      // position reassignment loop removed — position is not a schema field

      emitEvent('queue:postponed', { agencyId, reservation })

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Postpone error:', error)
      return c.json({ success: false, error: 'Failed to postpone reservation' }, 500)
    }
  })

  // POST /api/queue/recall/:id — re-call a CALLED reservation
  app.post('/api/queue/recall/:id', authMiddleware, async (c) => {
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
      const reservation = await withOutboxTransaction(async (tx) => {
        const row = await tx.reservation.update({
          where: { id },
          data: {
            calledAt: now,
          },
        })
        await logDeterministicOutcome('Reservation', id, 'update', row, null, { tx })
        return row
      })

      emitEvent('queue:recalled', { agencyId, reservation })

      return c.json({ success: true, data: reservation })
    } catch (error) {
      console.error('[LocalAPI] Recall error:', error)
      return c.json({ success: false, error: 'Failed to recall reservation' }, 500)
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

      return c.json({ success: true, notifications, unreadCount })
    } catch (error) {
      console.error('[LocalAPI] List notifications error:', error)
      return c.json({ success: false, error: 'Failed to list notifications' }, 500)
    }
  })

  // POST /api/notifications/read-all — mark all as read
  app.post('/api/notifications/read-all', authMiddleware, async (c) => {
    try {
      const user = sessionUser

      // Part Q: read-state sweep + outbox row commit atomically.
      // Logged with method PUT + the CLOUD path (cloud route is
      // PUT /api/notifications/read-all) so the replay hits the live route.
      await withOutboxTransaction(async (tx) => {
        await tx.notification.updateMany({
          where: { userId: user.id, isRead: false },
          data: { isRead: true },
        })
        await logPendingMutation('PUT', '/api/notifications/read-all', {}, { success: true }, { tx })
      })

      emitEvent('notifications:read-all', { userId: user.id })

      return c.json({ success: true, data: { message: 'All notifications marked as read' } })
    } catch (error) {
      console.error('[LocalAPI] Read-all notifications error:', error)
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

        // Part Q: read-state is a business mutation — write + deterministic
        // outbox outcome atomically (this route previously had NO outbox at
        // all: an offline mark-read never reached the cloud or other devices).
        const updated = await withOutboxTransaction(async (tx) => {
          const row = await tx.notification.update({
            where: { id },
            data: updateData,
          })
          await logDeterministicOutcome('Notification', id, 'update', row, null, { tx })
          return row
        })

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
      // Part Q: delete + deterministic outbox outcome atomically (previously
      // NO outbox — an offline notification delete never reached the cloud).
      await withOutboxTransaction(async (tx) => {
        await tx.notification.delete({ where: { id } })
        await logDeterministicOutcome('Notification', id, 'delete', {}, null, { tx })
      })
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
      // Round 15 — serve the local copy of the avatar when we have one.
      safeUser.avatarUrl = await localizeFileUrl(safeUser.avatarUrl)

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

      // Part Q: business write + outbox row commit atomically. Session-user
      // mirroring stays outside the tx — it touches no database rows.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.user.update({
          where: { id: user.id },
          data: updateData,
        })
        const { passwordHash: _omit, ...safeRow } = row
        await logPendingMutation('PUT', '/api/user/profile', body, safeRow, { tx })
        return row
      })

      // Update session user if name/language/avatar changed
      if (updateData.fullName) sessionUser.fullName = updateData.fullName
      if (updateData.language) sessionUser.language = updateData.language
      if (updateData.avatarUrl !== undefined) sessionUser.avatarUrl = updateData.avatarUrl

      const { passwordHash, ...safeUser } = updated

      emitEvent('user:updated', { userId: user.id, ...updateData })

      return c.json({ success: true, data: safeUser })
    } catch (error) {
      console.error('[LocalAPI] Update user profile error:', error)
      return c.json({ success: false, error: 'Failed to update user profile' }, 500)
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 12. SETTINGS (auth required)
  // ═══════════════════════════════════════════════════════════════════════

  // GET /api/agency/settings — MUST match the cloud contract exactly
  // (apps/api/src/routes/agency.ts GET /settings): a FLAT object with
  // services + working hours + queue knobs. The old local shape wrapped a
  // bare QueueSettings row in { success, data } with NO services and NO
  // working hours, so the desktop settings page rendered empty even when
  // the data existed locally.
  app.get('/api/agency/settings', authMiddleware, async (c) => {
    try {
      const agencyId = await resolveSessionAgencyId(c.req.query('agencyId'))
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }

      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        include: {
          services: {
            where: { isActive: true },
            select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true },
          },
          queueSettings: true,
        },
      })

      if (!agency) {
        // Agency not pulled yet — same defaults the cloud returns for an
        // unknown agency (never 500, never an empty wrapped row).
        return c.json({
          success: true,
          _partial: true,
          _reason: 'Agency not yet synced to local database',
          avgServiceTime: 10,
          maxReservations: 50,
          isQueueOpen: true,
          services: [],
          workingHoursStart: '08:00',
          workingHoursEnd: '17:00',
          autoPauseWhenFull: false,
          kioskModeEnabled: false,
          sponsorSms: false,
          smsBalance: 0,
        })
      }

      const qs = agency.queueSettings
      const settings = {
        avgServiceTime: agency.averageServiceTime ?? qs?.avgServiceTime ?? 10,
        maxReservations: agency.maxActiveReservations ?? 50,
        isQueueOpen: agency.isQueueOpen ?? true,
        services: agency.services,
        workingHoursStart: agency.workingHoursStart ?? '08:00',
        workingHoursEnd: agency.workingHoursEnd ?? '17:00',
        autoPauseWhenFull: agency.autoPauseWhenFull ?? false,
        kioskModeEnabled: agency.kioskModeEnabled ?? false,
        sponsorSms: agency.sponsorSms ?? false,
        smsBalance: agency.smsBalance ?? 0,
        // Local queue runtime state (superset — other local consumers +
        // the queue UI read these from the same endpoint)
        workingDays: agency.workingDays || '1,2,3,4,5',
        lastIssuedNumber: qs?.lastIssuedNumber ?? 0,
        currentServingNumber: qs?.currentServingNumber ?? 0,
        isPaused: qs?.isPaused ?? false,
        maxDailyTickets: qs?.maxDailyTickets ?? 500,
      }
      // Flat (cloud contract) + legacy { success, data } envelope so older
      // local consumers keep working.
      return c.json({ success: true, data: settings, ...settings })
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
  app.patch('/api/agency/queue/:id', authMiddleware, async (c) => {
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

      const updatedReservation = await withOutboxTransaction(async (tx) => {
        await tx.reservation.update({ where: { id: reservationId }, data: updateData })
        // Part Q: outcome row is atomic with the state flip. The logged
        // outcome merges the pre-read with the intended delta (deterministic
        // desired-state replay per Part V).
        await logDeterministicOutcome('Reservation', reservationId, 'update', { ...reservation, ...updateData }, null, { tx })
        return { ...reservation, ...updateData }
      })

      emitEvent('queue:updated', { reservationId, action, ...updateData })
      return c.json({ success: true, reservation: updatedReservation })
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

      const result = {
        todayReservations: total,
        currentlyWaiting: waiting,
        servedToday: completed,
        noShowCount: noShow,
        cancelledCount: cancelled,
        avgWaitTime: agency?.averageServiceTime || 10,
        currentQueueNumber: queueSettings?.currentServingNumber ? String(queueSettings.currentServingNumber) : '—',
        isPaused,
        peakHour: '—',
        avgRating: 0,
        totalRatings: 0,
        completionRate: 0,
        noShowRate: 0,
        hourlyWaitTime: new Array(24).fill(0),
        ratingDistribution: new Array(5).fill(0),
        subscriptionStatus: agency?.subscriptionStatus
          || 'ACTIVE',  // Default to ACTIVE in offline mode if not set
        estimatedWaitRange: { minMinutes: 0, maxMinutes: 0, confidence: 'LOW' },
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
      // Part Q: business write + outbox row commit atomically.
      const service = await withOutboxTransaction(async (tx) => {
        const created = await tx.service.create({
          data: {
            agencyId,
            name,
            nameAr: nameAr || null,
            nameFr: nameFr || null,
            prefix: prefix || null,
            averageServiceTime: avgServiceTime ? Number(avgServiceTime) : 10,
            isActive: true,
          },
        })
        // Canonical replay (round-7): id-preserving record-level create.
        await logDeterministicOutcome('Service', created.id, 'create', created, null, { tx })
        return created
      })
      emitEvent('service:created', { agencyId, service })
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
      // Fetch recent reservations with status changes as activity events
      const recent = await db.reservation.findMany({
        where: { agencyId },
        orderBy: { joinedAt: 'desc' },
        take: 10,
      })
      // Build service lookup map
      const servicesIds = new Set()
      for (const r of recent) {
        if (r.serviceId) servicesIds.add(r.serviceId)
      }
      const serviceList = servicesIds.size > 0 ? await db.service.findMany({ where: { id: { in: [...servicesIds] } } }).catch(() => []) : []
      const serviceMap = new Map(serviceList.map((s) => [s.id, s]))
      const events = recent.map((r) => ({
        id: r.id,
        eventType: r.status === 'COMPLETED' ? 'completed' : r.status === 'CANCELLED' ? 'cancelled' : r.status === 'NO_SHOW' ? 'no_show' : r.status === 'CALLED' ? 'called' : 'joined',
        eventKey: r.status === 'COMPLETED' ? 'customerCompletedService' : r.status === 'CANCELLED' ? 'customerCancelledRes' : r.status === 'NO_SHOW' ? 'customerNoShow' : r.status === 'CALLED' ? 'customerWasCalled' : 'customerJoinedQueue',
        customerName: r.walkInCustomerName || 'Walk-in',
        queueNumber: r.displayNumber || String(r.queueNumber),
        timestamp: r.joinedAt instanceof Date ? r.joinedAt.toISOString() : String(r.joinedAt),
        serviceName: serviceMap.get(r.serviceId)?.name || null,
      }))
      return c.json({ success: true, events })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/activity error:', error)
      return c.json({ success: false, error: 'Failed to load activity', detail: error?.message || String(error) }, 500)
    }
  })

  // POST /api/queue/pause — explicit pause (used by SimpleMobileDashboard)
  app.post('/api/queue/pause', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      // Part V: replayed as the DESIRED STATE (isPaused=true), not an action.
      // Part Q: state change + outbox row commit atomically.
      const qsOutcome = await withOutboxTransaction(async (tx) => {
        let row = null
        if (existing) {
          row = await tx.queueSettings.update({ where: { id: existing.id }, data: { isPaused: true, pausedAt: new Date() } })
        } else {
          row = await tx.queueSettings.create({ data: { agencyId, isPaused: true, pausedAt: new Date() } })
        }
        await logDeterministicOutcome('QueueSettings', row && row.id, 'update', row, null, { tx })
        return row
      })
      emitEvent('queue:paused', {})
      return c.json({ success: true, isPaused: true })
    } catch (error) {
      console.error('[LocalAPI] /api/queue/pause error:', error)
      return c.json({ success: false, error: 'Failed to pause' }, 500)
    }
  })

  // POST /api/queue/resume — explicit resume (used by SimpleMobileDashboard)
  app.post('/api/queue/resume', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency' }, 403)
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      // Part V: replayed as the DESIRED STATE (isPaused=false), not an action.
      // Part Q: state change + outbox row commit atomically.
      let qsOutcome = null
      if (existing) {
        qsOutcome = await withOutboxTransaction(async (tx) => {
          const row = await tx.queueSettings.update({ where: { id: existing.id }, data: { isPaused: false, pausedAt: null } })
          await logDeterministicOutcome('QueueSettings', row && row.id, 'update', row, null, { tx })
          return row
        })
      }
      emitEvent('queue:resumed', {})
      return c.json({ success: true, isPaused: false })
    } catch (error) {
      console.error('[LocalAPI] /api/queue/resume error:', error)
      return c.json({ success: false, error: 'Failed to resume' }, 500)
    }
  })

  // POST /api/agency/queue/toggle-pause
  app.post('/api/agency/queue/toggle-pause', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated' }, 403)
      }
      const existing = await db.queueSettings.findFirst({ where: { agencyId } }).catch(() => null)
      const currentPaused = existing ? (existing.isPaused === 1 || existing.isPaused === true) : false
      const now = new Date()
      // Part V: the replayed mutation expresses the DESIRED STATE (paused=true/false),
      // never a toggle instruction whose effect depends on remote state.
      // Part Q: state change + outbox row commit atomically.
      const qsOutcome = await withOutboxTransaction(async (tx) => {
        let row = null
        if (existing) {
          row = await tx.queueSettings.update({
            where: { id: existing.id },
            data: { isPaused: !currentPaused, pausedAt: !currentPaused ? now : null },
          })
        } else {
          row = await tx.queueSettings.create({
            data: { agencyId, isPaused: true, pausedAt: now },
          })
        }
        await logDeterministicOutcome('QueueSettings', row && row.id, 'update', row, null, { tx })
        return row
      })
      emitEvent('queue:pause-toggled', { isPaused: !currentPaused })
      return c.json({ success: true, isPaused: !currentPaused })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue/toggle-pause error:', error)
      return c.json({ success: false, error: 'Failed to toggle pause' }, 500)
    }
  })

  // POST /api/agency/queue/walk-in — create walk-in reservation
  app.post('/api/agency/queue/walk-in', authMiddleware, async (c) => {
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

      const reservation = await withOutboxTransaction(async (tx) => {
        const created = await tx.reservation.create({
          data: {
            id: require('crypto').randomUUID(),
            agencyId,
            serviceId,
            userId: sessionUser.id,
            queueNumber,
            displayNumber: queueNumber,
            status: 'WAITING',
            customerName,
            walkInCustomerName: customerName,
            isWalkIn: true,
            joinedAt: now,
            estimatedWait: 0,
          },
        })
        // Part Q: the outbox row commits ATOMICALLY with the walk-in ticket.
        // Canonical replay (round-7): the cloud POST route is customer-only
        // (403 for owners) — replay as a record-level create like /api/reservations.
        await logDeterministicOutcome('Reservation', created.id, 'create', created, null, { tx })
        return created
      })

      emitEvent('queue:walk-in', { reservation })
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
      // Round 16: a session without an agency used to feed Prisma
      // agencyId: null → validation error → 500. An empty list is the
      // honest pre-wizard answer.
      if (!agencyId) {
        return c.json({ announcements: [] })
      }
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
    return c.json({ success: true, message: 'Announcement created (offline)' })
  })

  // DELETE /api/agency/announcements?id= — delete announcement
  app.delete('/api/agency/announcements', authMiddleware, async (c) => {
    return c.json({ success: true })
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
        const completed = await db.reservation.count({
          where: { agencyId, serviceId: s.id, status: 'COMPLETED', completedAt: { gte: startMs, lte: endMs } },
        })
        return { serviceId: s.id, name: s.name, prefix: s.prefix, served: completed }
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
          { customerName: { contains: search } },
          { walkInCustomerName: { contains: search } },
          { displayNumber: { contains: search } },
          { customerPhone: { contains: search } },
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

      // Enrich with service data
      const service = reservation.serviceId
        ? await db.service.findUnique({ where: { id: reservation.serviceId } }).catch(() => null)
        : null
      const user = reservation.userId
        ? await db.user.findUnique({ where: { id: reservation.userId } }).catch(() => null)
        : null

      return c.json({
        ...reservation,
        serviceName: service?.name || null,
        serviceNameAr: service?.nameAr || null,
        serviceNameFr: service?.nameFr || null,
        customerPhone: user?.phoneNumber || null,
        customerName: user?.fullName || reservation.walkInCustomerName || null,
      })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/history/:id error:', error)
      return c.json({ success: false, error: 'Failed to load reservation' }, 500)
    }
  })

  // GET /api/agency/subscription — subscription status from local Agency record
  // Subscription data (tier, status, dates) is embedded in the Agency table and
  // synced to local SQLite at login. SubscriptionPlan catalog and Transaction
  // history are NOT synced, so those return empty arrays.
  // Payment/cancellation/unsubscribe actions require cloud — not available offline.
  app.get('/api/agency/subscription', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) {
        return c.json({
          currentPlan: 'BASIC',
          status: 'INACTIVE',
          subscriptionStartsAt: null,
          subscriptionExpiresAt: null,
          daysRemaining: null,
          isExpired: false,
          isExpiringSoon: false,
          availablePlans: [],
          recentTransactions: [],
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
          availablePlans: [],
          recentTransactions: [],
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

      return c.json({
        currentPlan: agency.subscriptionTier || 'BASIC',
        status,
        subscriptionStartsAt: agency.subscriptionStartsAt?.toISOString() ?? null,
        subscriptionExpiresAt: agency.subscriptionExpiresAt?.toISOString() ?? null,
        daysRemaining,
        isExpired,
        isExpiringSoon,
        availablePlans: [],
        recentTransactions: [],
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
      // Part Q: business write + outbox row commit atomically.
      const counter = await withOutboxTransaction(async (tx) => {
        const created = await tx.counter.create({
          data: { number, name, nameAr: nameAr || null, nameFr: nameFr || null, branchId },
        })
        await logDeterministicOutcome('Counter', created && created.id, 'create', created, null, { tx })
        return created
      })
      emitEvent('counter:created', { agencyId, counterId: counter.id, branchId })
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
      // Part Q: business write + outbox row commit atomically.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.counter.update({ where: { id: counterId }, data: updateData })
        await logDeterministicOutcome('Counter', counterId, 'update', row, null, { tx })
        return row
      })
      emitEvent('counter:updated', { agencyId, counterId, branchId })
      return c.json({ success: true, counter: updated })
    } catch (error) {
      console.error('[LocalAPI] PATCH counter error:', error)
      return c.json({ success: false, error: 'Failed to update counter' }, 500)
    }
  })

  // PATCH /api/agency/profile — alias for PUT (cloud uses PATCH)
  app.patch('/api/agency/profile', authMiddleware, async (c) => {
    try {
      const agencyId = await resolveSessionAgencyId(c.req.query('agencyId'))
      if (!agencyId) return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      const body = await c.req.json()
      // Field whitelist extended to match PUT + the cloud PATCH route —
      // the profile form updates email/working hours/days and the cover.
      const allowedFields = ['name', 'nameAr', 'nameFr', 'phone', 'email', 'description', 'descriptionAr', 'descriptionFr', 'address', 'city', 'category', 'website', 'logoUrl', 'coverUrl', 'workingHoursStart', 'workingHoursEnd', 'workingDays']
      const updateData = {}
      for (const field of allowedFields) {
        if (body[field] !== undefined) updateData[field] = body[field]
      }
      // The UI may send workingDays as an array — normalize to the CSV string
      // stored on the Agency row (same normalization the create wizard uses).
      if (Array.isArray(updateData.workingDays)) updateData.workingDays = updateData.workingDays.join(',')
      if (updateData.workingDays !== undefined && !/^([0-6])(,[0-6])*$/.test(String(updateData.workingDays))) {
        return c.json({ success: false, error: 'Invalid workingDays format' }, 400)
      }
      if (Object.keys(updateData).length === 0) return c.json({ success: false, error: 'No valid fields to update' }, 400)

      // The agency row may not exist locally yet (created on the cloud via
      // the wizard and the initial sync has not completed). The old code
      // ran tx.agency.update anyway → Prisma P2025 → 500 "Failed to update
      // profile". Now: apply on the cloud (source of truth) and let the
      // sync bring the row down; fail with an honest 412 when offline.
      const agencyExists = await db.agency.findUnique({ where: { id: agencyId }, select: { id: true } })
      if (!agencyExists) {
        if (sessionToken) {
          try {
            const target = `${cloudBaseUrl()}/api/agency/profile?agencyId=${encodeURIComponent(agencyId)}`
            const cloudRes = await fetch(target, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(8000),
            })
            const cloudData = await cloudRes.json().catch(() => ({}))
            if (cloudRes.ok) {
              try { if (fileSync) fileSync.schedule('agency-profile-cloud-patch') } catch {}
              try { const syncService = require('./sync-service'); if (syncService.triggerSyncNow) syncService.triggerSyncNow() } catch {}
              return c.json({ success: true, appliedOn: 'cloud' })
            }
            if (cloudRes.status === 401 || cloudRes.status === 403) {
              return c.json({ success: false, error: cloudData.error || 'Session not valid for this agency — please log in again', code: 'SESSION_INVALID' }, cloudRes.status)
            }
            return c.json({ success: false, error: cloudData.error || 'Cloud update failed', code: 'CLOUD_UPDATE_FAILED' }, 502)
          } catch (cloudErr) {
            return c.json({ success: false, error: 'Agency not synced to this device yet and the cloud is unreachable — reconnect to the internet and try again', code: 'AGENCY_NOT_SYNCED' }, 412)
          }
        }
        return c.json({ success: false, error: 'Agency not synced to this device yet — connect to the internet and try again', code: 'AGENCY_NOT_SYNCED' }, 412)
      }

      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        await tx.agency.update({ where: { id: agencyId }, data: updateData })
        await logPendingMutation('PATCH', '/api/agency/profile', body, updateData, { tx })
      })
      emitEvent('agency:updated', { agencyId, ...updateData })
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] PATCH /api/agency/profile error:', error)
      const msg = String((error && (error.message || error)) || '')
      if (msg.includes('P2025') || msg.toLowerCase().includes('not found')) {
        return c.json({ success: false, error: 'Agency not synced to this device yet — reconnect to the internet and try again', code: 'AGENCY_NOT_SYNCED' }, 412)
      }
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
        select: { joinedAt: true, status: true },
      })
      const hourlyData = []
      for (let h = 7; h <= 22; h++) {
        const hourReservations = reservations.filter((r) => new Date(r.joinedAt).getHours() === h)
        const completed = hourReservations.filter((r) => r.status === 'COMPLETED').length
        hourlyData.push({ hour: h, count: hourReservations.length, completed })
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
      if (!agencyId) return c.json({ error: 'No agency found' }, 404)
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
      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        const row = await tx.agency.update({ where: { id: agencyId }, data: updateData })
        await logPendingMutation('PATCH', '/api/agency/settings', body, row, { tx })
      })
      emitEvent('agency:updated', { agencyId, action: 'settings-updated', ...updateData })
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
      if (!agencyId) return c.json({ error: 'agencyId required' }, 400)
      const { agencyId: bodyAgencyId, username } = await c.req.json()
      const targetAgencyId = bodyAgencyId || agencyId
      if (!username) return c.json({ error: 'username required' }, 400)
      // Find user by username
      const user = await db.user.findUnique({ where: { username: username.trim() } })
      if (!user) return c.json({ error: 'User not found' }, 404)
      // Check if already staff
      const existing = await db.agencyStaff.findUnique({
        where: { userId_agencyId: { userId: user.id, agencyId: targetAgencyId } },
      })
      if (existing) return c.json({ error: 'Staff already exists in this agency' }, 409)
      // Part Q: business write + outbox row commit atomically. The pre-reads
      // (user lookup, duplicate check) stay outside — only writes join the tx.
      const staff = await withOutboxTransaction(async (tx) => {
        const created = await tx.agencyStaff.create({
          data: { userId: user.id, agencyId: targetAgencyId, role: user.role === 'AGENCY_OWNER' ? 'OWNER' : 'STAFF' },
          include: { user: { select: { id: true, username: true, fullName: true, role: true } } },
        })
        await logPendingMutation('POST', '/api/agency/staff', { username }, created, { tx })
        return created
      })
      emitEvent('staff:updated', { agencyId: targetAgencyId, action: 'staff-added', staffId: staff.id })
      return c.json({ staff }, 201)
    } catch (error) {
      console.error('[LocalAPI] POST /api/agency/staff error:', error)
      return c.json({ error: 'Failed to add staff' }, 500)
    }
  })

  // DELETE /api/agency/staff?staffId=xxx&agencyId=xxx — remove staff by query param
  app.delete('/api/agency/staff', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ error: 'agencyId required' }, 400)
      const staffId = c.req.query('staffId')
      const queryAgencyId = c.req.query('agencyId') || agencyId
      if (!staffId) return c.json({ error: 'staffId required' }, 400)
      const staffMember = await db.agencyStaff.findUnique({ where: { id: staffId } })
      if (!staffMember) return c.json({ error: 'Staff member not found' }, 404)
      if (staffMember.agencyId !== queryAgencyId) return c.json({ error: 'Staff not in this agency' }, 403)
      if (staffMember.role === 'OWNER') return c.json({ error: 'Cannot remove agency owner' }, 403)
      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        await tx.agencyStaff.delete({ where: { id: staffId } })
        await logPendingMutation('DELETE', '/api/agency/staff', { staffId }, null, { tx })
      })
      emitEvent('staff:updated', { agencyId: queryAgencyId, action: 'staff-removed', staffId })
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] DELETE /api/agency/staff error:', error)
      return c.json({ error: 'Failed to remove staff' }, 500)
    }
  })

  // PATCH /api/agency/staff/:id — update staff member
  app.patch('/api/agency/staff/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ error: 'No agency found' }, 403)
      const id = c.req.param('id')
      const body = await c.req.json()
      const staffMember = await db.agencyStaff.findUnique({
        where: { id },
        include: { user: { select: { id: true, username: true, fullName: true, role: true, isActive: true } } },
      })
      if (!staffMember) return c.json({ error: 'Staff member not found' }, 404)
      if (staffMember.agencyId !== agencyId) return c.json({ error: 'Not your agency' }, 403)
      if (staffMember.role === 'OWNER') return c.json({ error: 'Cannot modify owner' }, 403)
      const { fullName, role, isActive, permissions } = body
      // Part Q: ALL staff/user writes below + the outbox row commit atomically
      // — a crash can no longer half-apply a staff edit (e.g. role changed but
      // name not, or activation written with no outbox entry).
      const updated = await withOutboxTransaction(async (tx) => {
        // Update user fullName
        if (fullName !== undefined && fullName.trim()) {
          await tx.user.update({ where: { id: staffMember.userId }, data: { fullName: fullName.trim() } })
        }
        // Update staff role
        if (role !== undefined && ['STAFF', 'MANAGER'].includes(role)) {
          await tx.agencyStaff.update({ where: { id }, data: { role } })
        }
        // Update isActive
        if (isActive !== undefined) {
          await tx.user.update({ where: { id: staffMember.userId }, data: { isActive } })
          await tx.agencyStaff.update({ where: { id }, data: { isActive } })
        }
        // Update permissions
        if (permissions !== undefined) {
          const currentPerms = staffMember.permissions ? JSON.parse(staffMember.permissions) : {}
          const mergedPerms = { ...currentPerms, ...permissions }
          await tx.agencyStaff.update({ where: { id }, data: { permissions: JSON.stringify(mergedPerms) } })
        }
        // Fetch updated
        const row = await tx.agencyStaff.findUnique({
          where: { id },
          include: { user: { select: { id: true, username: true, fullName: true, role: true, isActive: true } } },
        })
        await logDeterministicOutcome('AgencyStaff', id, 'update', row, null, { tx })
        return row
      })
      emitEvent('staff:updated', { agencyId, action: 'staff-updated', staffId: id })
      return c.json({ staff: updated, success: true })
    } catch (error) {
      console.error('[LocalAPI] PATCH /api/agency/staff/:id error:', error)
      return c.json({ success: false, error: 'Failed to update staff' }, 500)
    }
  })

  // GET /api/agency/subscription-plans — list available plans (offline: empty)
  app.get('/api/agency/subscription-plans', authMiddleware, async (c) => {
    try {
      // SubscriptionPlan table is NOT synced locally.
      // Return empty array — the subscription page will show cached plan data from session.
      return c.json({ plans: [] })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/subscription-plans error:', error)
      return c.json({ plans: [] })
    }
  })

  // PATCH /api/agency/working-hours — update working hours
  app.patch('/api/agency/working-hours', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency found' }, 404)
      const body = await c.req.json()
      const { workingHoursStart, workingHoursEnd, workingDays } = body
      if (workingHoursStart === undefined && workingHoursEnd === undefined && workingDays === undefined) {
        return c.json({ success: false, error: 'workingHoursStart, workingHoursEnd or workingDays required' }, 400)
      }
      if (workingDays !== undefined && !/^([0-6])(,[0-6])*$/.test(String(workingDays))) {
        return c.json({ success: false, error: 'workingDays must be a comma-separated list of weekday numbers 0-6' }, 400)
      }
      const updateData = {}
      if (workingHoursStart !== undefined) updateData.workingHoursStart = workingHoursStart
      if (workingHoursEnd !== undefined) updateData.workingHoursEnd = workingHoursEnd
      if (workingDays !== undefined) updateData.workingDays = String(workingDays)
      // Part Q: business write + outbox row commit atomically.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.agency.update({
          where: { id: agencyId },
          data: updateData,
          select: { id: true, workingHoursStart: true, workingHoursEnd: true, workingDays: true },
        })
        await logPendingMutation('PATCH', '/api/agency/working-hours', body, row, { tx })
        return row
      })
      emitEvent('agency:updated', { agencyId, action: 'working-hours-updated', ...updateData })
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
      if (!reviewId) return c.json({ error: 'reviewId is required' }, 400)
      const review = await db.review.findUnique({ where: { id: reviewId } })
      if (!review) return c.json({ error: 'Review not found' }, 404)
      if (review.agencyId !== sessionUser.agencyId && review.userId !== sessionUser.id) {
        return c.json({ error: 'Not authorized to delete this review' }, 403)
      }
      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        await tx.review.delete({ where: { id: reviewId } })
        await logPendingMutation('DELETE', '/api/reviews', { reviewId }, null, { tx })
      })
      emitEvent('review:deleted', { agencyId: review.agencyId, reviewId })
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] DELETE /api/reviews error:', error)
      return c.json({ error: 'Failed to delete review' }, 500)
    }
  })

  // DELETE /api/agency/reviews — delete a review (agency-scoped alias)
  app.delete('/api/agency/reviews', authMiddleware, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const { reviewId } = body
      if (!reviewId) return c.json({ error: 'reviewId is required' }, 400)
      const review = await db.review.findUnique({ where: { id: reviewId } })
      if (!review) return c.json({ error: 'Review not found' }, 404)
      if (review.agencyId !== sessionUser.agencyId) {
        return c.json({ error: 'Not authorized' }, 403)
      }
      // Part Q: business write + outbox row commit atomically.
      await withOutboxTransaction(async (tx) => {
        await tx.review.delete({ where: { id: reviewId } })
        await logPendingMutation('DELETE', '/api/agency/reviews', { reviewId }, null, { tx })
      })
      emitEvent('review:deleted', { agencyId: review.agencyId, reviewId })
      return c.json({ success: true })
    } catch (error) {
      console.error('[LocalAPI] DELETE /api/agency/reviews error:', error)
      return c.json({ error: 'Failed to delete review' }, 500)
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
      // Part Q: business write + outbox row commit atomically. The upsert
      // branch decision uses the pre-read `existing` — both branches join tx.
      const review = await withOutboxTransaction(async (tx) => {
        const row = existing
          ? await tx.review.update({
              where: { id: existing.id },
              data: { rating, comment: comment || null },
              include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
            })
          : await tx.review.create({
              data: { agencyId, userId: sessionUser.id, rating, comment: comment || null },
              include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
            })
        await logPendingMutation('POST', '/api/agency/reviews', body, row, { tx })
        return row
      })
      emitEvent('review:created', { agencyId, review })
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
      if (!agencyId) return c.json({ error: 'agencyId is required' }, 400)
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
      // Rating distribution
      const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
      const allRatings = await db.review.findMany({ where: { agencyId }, select: { rating: true } })
      for (const r of allRatings) {
        if (r.rating >= 1 && r.rating <= 5) ratingDistribution[r.rating]++
      }
      const agg = await db.review.aggregate({ where: { agencyId }, _avg: { rating: true } })
      const avgRating = agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : 0
      return c.json({
        reviews: reviews.map((r) => ({
          id: r.id, rating: r.rating, comment: r.comment,
          replyText: r.replyText, repliedAt: r.repliedAt?.toISOString() ?? null,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          user: r.user ? { id: r.user.id, fullName: r.user.fullName, avatarUrl: r.user.avatarUrl } : { id: '', fullName: 'Unknown' },
        })),
        avgRating, totalReviews, ratingDistribution,
        hasMore: skip + limit < totalReviews,
      })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/reviews error:', error)
      return c.json({ reviews: [], avgRating: 0, totalReviews: 0, ratingDistribution: {}, hasMore: false })
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
  //
  // v2: now also returns the LIVE background sync engine status (lazy
  // require of sync-service to avoid a circular module dependency; falls
  // back gracefully when the sync service isn't loadable).
  app.get('/api/sync/status', (c) => {
    const base = {
      service: 'blasti-lan-sync',
      local: { ready: !!db, mode: 'sqlite' },
      sessionActive: !!sessionToken,
    }
    try {
      const syncService = require('./sync-service')
      const status = syncService.getStatus()
      // getStatus is async — answer synchronously with the discovery
      // contract + a promise-resolved snapshot is not possible here, so
      // expose the non-async subset and let clients use /api/sync-status
      // for the full live snapshot.
      return c.json({
        ...base,
        syncServiceAvailable: true,
        isStarted: status.isStarted,
        hasAuth: status.hasAuth,
        socketConnected: status.socketConnected,
        cursor: status.cursor,
        syncProtocolVersion: status.syncProtocolVersion,
        syncModelCount: status.syncModelCount,
      })
    } catch {
      return c.json({ ...base, syncServiceAvailable: false })
    }
  })

  // GET /api/sync-status — local sync status for diagnosis panel
  // v2: returns the live background sync engine status (awaited).
  app.get('/api/sync-status', async (c) => {
    const base = {
      success: true,
      localReady: !!db,
      sessionActive: !!sessionToken,
    }
    try {
      const syncService = require('./sync-service')
      const status = await syncService.getStatus()
      return c.json({
        ...base,
        syncServiceAvailable: true,
        cloudConnected: !!(status.socketConnected || (status.lastPullAt && status.lastError === null)),
        ...status,
      })
    } catch {
      return c.json({
        ...base,
        syncServiceAvailable: false,
        cloudConnected: false,
        lastSyncAt: null,
      })
    }
  })

  // GET /api/db-status — database diagnostics for the diagnosis panel
  // v2: extended with initialization status (AgencyLocalState), required
  // dataset counts, sync timestamps, pending outbox size and a readiness
  // verdict (ready = initialization READY + Agency data present).
  app.get('/api/db-status', async (c) => {
    if (!db) {
      return c.json({ success: false, error: 'Database not initialized', tables: 0 })
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

      // ── v2 additions: initialization + readiness ──
      const agencyId = sessionUser?.agencyId || null

      // Initialization status from AgencyLocalState (model exists in the
      // shared schema; older local DBs may predate it → NOT_INITIALIZED).
      let localState = null
      try {
        localState = await db.agencyLocalState.findUnique({ where: { agencyId: agencyId || '__none__' } })
      } catch {
        localState = null
      }
      const initializationStatus = localState?.initializationStatus || 'NOT_INITIALIZED'
      const effectiveAgencyId = agencyId || localState?.agencyId || null

      // Required dataset counts (-1 on error): the minimum tables the app
      // needs before it is usable offline.
      const requiredModels = ['Agency', 'AgencyStaff', 'Service', 'Branch', 'Counter', 'QueueSettings', 'Reservation']
      const requiredDataset = {}
      for (const model of requiredModels) {
        requiredDataset[model] = typeof counts[model] === 'number' ? counts[model] : -1
      }

      // Sync timestamps: prefer _sync_meta (live engine), fall back to
      // AgencyLocalState, then null.
      let lastFullSyncAt = null
      let lastIncrementalSyncAt = null
      let lastError = localState?.lastError || null
      try {
        const metaRows = await db.$queryRawUnsafe(
          "SELECT key, value FROM \"_sync_meta\" WHERE key IN ('lastFullSyncAt', 'lastIncrementalSyncAt', 'lastPulledSequence')"
        )
        for (const row of metaRows || []) {
          if (row.key === 'lastFullSyncAt' && row.value) lastFullSyncAt = row.value
          if (row.key === 'lastIncrementalSyncAt' && row.value) lastIncrementalSyncAt = row.value
        }
      } catch { /* _sync_meta may not exist yet */ }
      if (!lastFullSyncAt && localState?.lastFullSyncAt) {
        lastFullSyncAt = localState.lastFullSyncAt instanceof Date ? localState.lastFullSyncAt.toISOString() : String(localState.lastFullSyncAt)
      }
      if (!lastIncrementalSyncAt && localState?.lastIncrementalSyncAt) {
        lastIncrementalSyncAt = localState.lastIncrementalSyncAt instanceof Date ? localState.lastIncrementalSyncAt.toISOString() : String(localState.lastIncrementalSyncAt)
      }

      // Pending outgoing mutations (Part AT: full outbox breakdown)
      let pendingOutgoingMutations = 0
      let outbox = { pending: 0, retry: 0, permanentFailed: 0, conflict: 0, sending: 0 }
      try {
        const statusRows = await db.$queryRawUnsafe('SELECT status, COUNT(*) as cnt FROM "_pending_mutations" GROUP BY status')
        const byStatus = {}
        for (const row of statusRows || []) byStatus[row.status] = Number(row.cnt)
        outbox = {
          pending: byStatus.pending || 0,
          retry: (byStatus.retry || 0) + (byStatus.failed || 0),
          permanentFailed: (byStatus.permanent_failed || 0) + (byStatus.abandoned || 0),
          conflict: byStatus.conflict || 0,
          sending: byStatus.sending || 0,
        }
        pendingOutgoingMutations = outbox.pending + outbox.retry
      } catch { /* outbox table may not exist yet */ }

      // Part K/AT: durable deferred changes + conflicts + cursor
      let deferredChanges = 0
      let deferredQuarantined = 0
      try {
        const defRows = await db.$queryRawUnsafe(
          'SELECT status, COUNT(*) as cnt FROM "_deferred_changes" GROUP BY status'
        )
        for (const row of defRows || []) {
          if (row.status === 'PENDING') deferredChanges = Number(row.cnt)
          if (row.status === 'QUARANTINED') deferredQuarantined = Number(row.cnt)
        }
      } catch { /* deferred table may not exist yet */ }
      let conflictCount = 0
      try {
        const confRows = await db.$queryRawUnsafe(
          'SELECT COUNT(*) as cnt FROM "_sync_conflicts" WHERE resolution = \'pending\''
        )
        conflictCount = Number(confRows?.[0]?.cnt || 0)
      } catch { /* conflicts table may not exist yet */ }
      let cursor = null
      try {
        const curRows = await db.$queryRawUnsafe(
          "SELECT value FROM \"_sync_meta\" WHERE key = 'lastPulledSequence'"
        )
        cursor = curRows && curRows[0] ? parseInt(curRows[0].value, 10) || null : null
      } catch { /* meta table may not exist yet */ }

      // Readiness verdict: initialized AND agency data actually imported.
      const agencyCount = typeof counts.Agency === 'number' ? counts.Agency : -1
      const ready = initializationStatus === 'READY' && agencyCount > 0
      let reason = 'ready'
      if (initializationStatus !== 'READY') {
        reason = 'initialization ' + initializationStatus
      } else if (agencyCount <= 0) {
        reason = 'initialization READY but no Agency records imported'
      }

      // Spec §24 contract fields
      const { getDbStatus: _getDbStatus } = require('./lib/db')
      const dbFileStatus = _getDbStatus()
      let schemaVersion = null
      try {
        const vRows = await db.$queryRawUnsafe("SELECT value FROM \"_sync_meta\" WHERE key = 'schema_version'")
        schemaVersion = vRows && vRows[0] ? parseInt(vRows[0].value, 10) || null : null
      } catch { /* meta table may not exist yet */ }
      const syncInfraTables = ['_sync_meta', '_sync_conflicts', '_pending_mutations', '_sync_applied_mutations', '_deferred_changes']
      const syncTablesStatus = {}
      for (const t of syncInfraTables) syncTablesStatus[t] = tables.includes(t)
      let realtimeConnected = false
      try {
        realtimeConnected = !!require('./sync-service').getStatus()?.socketConnected
      } catch { /* engine not started */ }

      return c.json({
        success: true,
        tables: tables.length,
        tableNames: tables,
        counts,
        mode: 'sqlite',
        sessionActive: !!sessionToken,
        user: sessionUser ? { id: sessionUser.id, username: sessionUser.username, role: sessionUser.role } : null,
        // v2 fields
        agencyId: effectiveAgencyId,
        initializationStatus,
        initialization: {
          status: initializationStatus,
          currentStage: localState?.currentStage || null,
          recordsImported: localState?.recordsImported ?? null,
          snapshotSequence: localState?.snapshotSequence ?? null,
        },
        requiredDataset,
        lastFullSyncAt,
        lastIncrementalSyncAt,
        lastError,
        pendingOutgoingMutations,
        // Part AT observability contract
        cursor,
        outbox,
        deferredChanges,
        deferredQuarantined,
        conflicts: conflictCount,
        ready,
        readiness: { ready, reason },
        // Spec §24 canonical names (aliases kept above for existing consumers)
        databasePath: dbFileStatus.path,
        databaseExists: dbFileStatus.path ? require('fs').existsSync(dbFileStatus.path) : false,
        schemaStatus: {
          ok: Object.values(syncTablesStatus).every(Boolean) && !!schemaVersion,
          version: schemaVersion,
          syncTables: syncTablesStatus,
        },
        initializationState: initializationStatus,
        pendingMutations: pendingOutgoingMutations,
        realtimeConnected,
        lastSyncError: lastError,
      })
    } catch (err) {
      return c.json({ success: false, error: String(err), tables: 0 })
    }
  })

  // POST /api/sync/initial-sync/run — run the stage-based initial sync
  // (local-api/initial-sync.js runInitialSync) with the current session.
  // This is the loading-screen fallback path (primary is the IPC bridge →
  // cloud-sync:initial-sync). Progress events are emitted on the local
  // event bus as 'initial-sync:progress'. On success the sync engine's
  // pull cursor is initialized from the snapshot sequence and the
  // background engine is started.
  app.post('/api/sync/initial-sync/run', authMiddleware, async (c) => {
    try {
      const { runInitialSync } = require('./initial-sync')
      const user = c.get('user')
      const agencyId = user?.agencyId
      if (!agencyId) {
        return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      }
      const token = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-Local-Token')
      const cloudUrl = process.env.BLASTI_CLOUD_URL || 'http://localhost:3003'

      const result = await runInitialSync({
        agencyId,
        cloudAuthToken: token,
        cloudUrl,
        db,
        emitFn: (evt) => {
          emitEvent('initial-sync:progress', evt)
          console.log('[LocalAPI][InitialSync evt]', evt.type, evt.stage || '')
        },
      })

      // Initialize the engine cursor + start the background engine.
      try {
        const syncService = require('./sync-service')
        if (result && result.success && typeof result.snapshotSequence === 'number') {
          // CURSOR INVARIANT (field round 6): prefer the BRIDGE's final
          // sequence (ledger-proven coverage) over the raw snapshotSequence.
          const adoptedSeq = (typeof result.bridgeFinalSequence === 'number' && result.bridgeFinalSequence >= result.snapshotSequence)
            ? result.bridgeFinalSequence
            : result.snapshotSequence
          await syncService.setInitialCursor(adoptedSeq, { source: 'http-post-init', snapshotSequence: result.snapshotSequence, bridgeFinalSequence: result.bridgeFinalSequence ?? null })
        }
        if (!syncService.getStatus()?.isStarted) {
          syncService.startSync({ localDb: db, cloudBaseUrl: cloudUrl, agencyId })
        }
      } catch (syncErr) {
        console.warn('[LocalAPI] post-initial-sync engine wiring failed:', syncErr.message)
      }

      return c.json({
        success: !!result?.success,
        totalRecords: result?.totalRecords ?? 0,
        duration: result?.duration ?? 0,
        alreadyInitialized: !!result?.alreadyInitialized,
        snapshotSequence: result?.snapshotSequence,
        error: result?.error || undefined,
      })
    } catch (error) {
      console.error('[LocalAPI] /api/sync/initial-sync/run error:', error)
      return c.json({ success: false, error: error?.message || 'Initial sync failed' }, 500)
    }
  })

  // GET /api/cloud-health — check if local API can reach the cloud API
  // This endpoint is used by the diagnosis panel to verify local→cloud connectivity
  app.get('/api/cloud-health', async (c) => {
    const cloudUrl = process.env.BLASTI_CLOUD_URL || 'http://localhost:3003'
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

  // POST /api/agency/queue/call-next — alias (frontend calls this path)
  app.post('/api/agency/queue/call-next', authMiddleware, async (c) => {
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

      // Update positions of remaining waiting reservations
      const remainingWaiting = await db.reservation.findMany({
        where: { agencyId, status: 'WAITING' },
        orderBy: { joinedAt: 'asc' },
      })
      // position reassignment loop removed — position is not a schema field

      const updated = await db.reservation.findUnique({ where: { id: next.id } })

      emitEvent('queue:called', { agencyId, reservation: updated })

      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue/call-next error:', error)
      return c.json({ success: false, error: 'Failed to call next customer' }, 500)
    }
  })

  // POST /api/agency/queue/walk-in-token — QR-based walk-in
  app.post('/api/agency/queue/walk-in-token', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const body = await c.req.json().catch(() => ({}))
      const { serviceId, customerName, phone } = body
      if (!serviceId) return c.json({ success: false, error: 'serviceId required' }, 400)
      const service = await db.service.findUnique({ where: { id: serviceId } })
      if (!service || service.agencyId !== agencyId) return c.json({ success: false, error: 'Service not found' }, 404)
      // Generate a 6-digit token code
      const tokenCode = String(Math.floor(100000 + Math.random() * 900000))
      const now = new Date()
      const reservation = await db.reservation.create({
        data: {
          agencyId,
          serviceId,
          userId: sessionUser.id,
          queueNumber: tokenCode,
          displayNumber: tokenCode,
          status: 'WAITING',
          walkInCustomerName: customerName || 'Token',
          isWalkIn: true,
          joinedAt: now,
          estimatedWait: 0,
        },
      })
      emitEvent('reservation:created', { agencyId, reservation })
      return c.json({ success: true, data: { ...reservation, tokenCode } }, 201)
    } catch (error) {
      console.error('[LocalAPI] walk-in-token error:', error)
      return c.json({ success: false, error: 'Failed to create token walk-in' }, 500)
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
      return c.json({ success: true, data: staff }, 201)
    } catch (error) {
      console.error('[LocalAPI] Create staff error:', error)
      return c.json({ success: false, error: 'Failed to create staff' }, 500)
    }
  })

  // PUT/PATCH /api/agency/staff/:id — update staff
  for (const method of ['put', 'patch']) {
    app[method]('/api/agency/staff/:id', authMiddleware, async (c) => {
      try {
        const agencyId = sessionUser.agencyId
        if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
        const id = c.req.param('id')
        const body = await c.req.json()
        const existing = await db.agencyStaff.findUnique({ where: { id } })
        if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'Staff not found' }, 404)
        const allowedFields = ['role', 'permissions', 'isActive']
        const updateData = {}
        for (const field of allowedFields) {
          if (body[field] !== undefined) updateData[field] = body[field]
        }
        const updated = await db.agencyStaff.update({ where: { id }, data: updateData })
        emitEvent('staff:updated', { agencyId, staffId: id, ...updateData })
        return c.json({ success: true, data: updated })
      } catch (error) {
        console.error('[LocalAPI] Update staff error:', error)
        return c.json({ success: false, error: 'Failed to update staff' }, 500)
      }
    })
  }

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
      return c.json({ success: true, data: { id, deleted: true } })
    } catch (error) {
      console.error('[LocalAPI] DELETE staff error:', error)
      return c.json({ success: false, error: 'Failed to delete staff' }, 500)
    }
  })

  // GET /api/agency/qr-code — QR code info (cloud-contract compatible)
  // Mirrors apps/api/src/routes/agency.ts GET /qr-code: with ?code= (or the
  // session agency's customCode) it returns a real SVG QR encoding the
  // public queue URL — fully offline. ?format=json returns the structured
  // info the local UI previously expected.
  app.get('/api/agency/qr-code', authMiddleware, async (c) => {
    try {
      const agencyId = await resolveSessionAgencyId(c.req.query('agencyId'))
      if (!agencyId) return c.json({ success: false, error: 'No agency associated with this account' }, 403)
      const agency = await db.agency.findUnique({ where: { id: agencyId } })
      if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

      const code = c.req.query('code') || agency.customCode
      if (!code) return c.json({ success: false, error: 'Agency has no custom code' }, 400)

      // Same payload the cloud encodes: <app-url>/?code=<customCode>
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.BLASTI_PUBLIC_BASE_URL || 'http://localhost:3000'
      const qrData = `${appUrl}/?code=${encodeURIComponent(code)}`

      if (c.req.query('format') === 'json') {
        return c.json({
          success: true,
          data: {
            qrCodeUrl: null,
            qrData,
            displayUrl: qrData,
            agencyName: agency.name,
            agencyCode: code,
            message: 'Use qrData with a client-side QR generator (works offline)',
          },
        })
      }

      // Default: SVG — identical content-type contract to the cloud route.
      let QRCode = null
      try { QRCode = require('qrcode') } catch { /* not bundled — optional */ }
      if (QRCode && typeof QRCode.toString === 'function') {
        const svg = await QRCode.toString(qrData, { type: 'svg', margin: 1, width: 240 })
        return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' })
      }

      // qrcode module unavailable in this build → JSON describing the data
      // so the renderer can generate the QR client-side (qrcode npm package
      // is bundled with the web UI).
      return c.json({
        success: true,
        qrData,
        agencyName: agency.name,
        agencyCode: code,
        message: 'QR generation module unavailable — render client-side from qrData',
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

      // Part Q: business write + outbox row commit atomically.
      const updated = await withOutboxTransaction(async (tx) => {
        const row = await tx.review.update({
          where: { id: reviewId },
          data: { replyText: text.trim(), repliedAt: new Date() },
        })
        await logDeterministicOutcome('Review', reviewId, 'update', { replyText: text.trim() }, null, { tx })
        return row
      })
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
      const dateFrom = c.req.query('dateFrom')
      const dateTo = c.req.query('dateTo')
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
      // Build CSV
      const header = 'ID,Ticket,Display Number,Status,Service,Customer,Created At,Completed At\n'
      const rows = reservations.map(r => {
        const svc = r.serviceId || ''
        const name = r.walkInCustomerName || ''
        const created = r.joinedAt ? new Date(r.joinedAt).toISOString() : ''
        const completed = r.completedAt ? new Date(r.completedAt).toISOString() : ''
        return `${r.id},${r.displayNumber},${r.status},${svc},${name},${created},${completed}`
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

  // POST /api/agency/queue/call/:id — call specific reservation
  app.post('/api/agency/queue/call/:id', authMiddleware, async (c) => {
    try {
      const agencyId = sessionUser.agencyId
      if (!agencyId) return c.json({ success: false, error: 'No agency associated' }, 403)
      const id = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const { counterId } = body
      const existing = await db.reservation.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) return c.json({ success: false, error: 'Reservation not found' }, 404)
      if (!['WAITING', 'CALLED'].includes(existing.status)) {
        return c.json({ success: false, error: 'Cannot call reservation with status: ' + existing.status }, 400)
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
      emitEvent('queue:called', { agencyId, reservation: updated })
      return c.json({ success: true, data: updated })
    } catch (error) {
      console.error('[LocalAPI] /api/agency/queue/call/:id error:', error)
      return c.json({ success: false, error: 'Failed to call reservation' }, 500)
    }
  })

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
  // BUGFIX: the handler MUST return the awaited response to Hono. The old
  // fire-and-forget `.then(r => c.json(...))` returned undefined from the
  // handler → Hono threw "Context is not finalized" → 500 on every call.
  app.get('/api/pending-mutations/count', async (c) => {
    if (!db) return c.json({ success: true, count: 0 })
    try {
      const r = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "_pending_mutations" WHERE status = \'pending\''
      )
      const raw = r && r[0] ? r[0].cnt : 0
      return c.json({ success: true, count: typeof raw === 'bigint' ? Number(raw) : (raw || 0) })
    } catch {
      return c.json({ success: true, count: 0 })
    }
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
  // Prevents 500 crashes when db is null (e.g. during startup race).
  // Must be applied AFTER authMiddleware so it runs after auth.
  const requireDb = async (c, next) => {
    if (!db) {
      return c.json({ success: false, error: 'Database not initialized' }, 503)
    }
    await next()
  }

  // Route count at registration-complete time (used by the 404 handler and
  // the startup registry summary to prove which build is actually running).
  let registeredRouteCount = -1
  try { registeredRouteCount = (app.routes || []).length } catch { /* older hono — unknown */ }

  // 404 handler — self-identifying (isolation aid): logs the unmatched
  // method+path so a stale running build is immediately visible in the
  // console (e.g. a 404 on /api/auth/import-session, which IS registered in
  // the current checkout). The response also echoes the path so callers can
  // distinguish this local 404 from any other server's.
  app.notFound((c) => {
    console.warn(`[LocalAPI] 404 — no route matched: ${c.req.method} ${c.req.path} (registered routes: ${registeredRouteCount}) — if this path should exist, the RUNNING local-api build is older than the checkout; fully restart the app`)
    return c.json({ success: false, error: 'Not found', path: c.req.path }, 404)
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

  // ── Authoritative local DB startup (spec §3/§28) ────────────────────────
  // Resolves the single authoritative path, migrates a legacy database if
  // present (copy + verify), applies the controlled NON-DESTRUCTIVE schema
  // lifecycle (create / adopt / upgrade / verify — never `prisma db push`
  // with --accept-data-loss), sets pragmas, and logs the durable
  // initialization state. Safe on every startup; idempotent.
  db = localDb
  const dbReady = await ensureDatabaseReady()
  if (!dbReady.ok) {
    console.error('[LocalAPI] Local database failed startup initialization:', dbReady.error)
    // Keep serving so /api/db-status can surface the diagnostic state; the
    // readiness gate will block the dashboard (no READY DB → no dashboard).
  }
  await setupPragmas()
  console.log(`[LocalAPI] Prisma database initialized (local SQLite)`)

  // ── Round 15: local FILE STORE + FILE SYNC worker ─────────────────────
  // Uploads land locally first (lib/file-store.js, under
  // BLASTI_LOCAL_FILES_DIR); this worker mirrors them with the cloud
  // (push local-only blobs / pull remote blobs / replay tombstones) as part
  // of the sync engine. The v2 record engine above is untouched.
  localOrigin = `http://${BIND_ADDRESS}:${port}`
  fileSync = createFileSync({
    db,
    getCloudBaseUrl: cloudBaseUrl,
    getSessionToken: () => sessionToken,
    getSyncMeta: getLocalMeta,
    setSyncMeta: setLocalMeta,
  })
  fileSync.start()
  console.log(`[LocalAPI] File store: ${fileStore.resolveFilesRoot()} — file-sync worker started`)

  // Round-7: repair legacy permanently-failed HTTP create rows before the
  // sync engine starts replaying (idempotent — safe on every startup).
  try {
    await repairLegacyReservationCreates()
  } catch (repairErr) {
    console.warn('[LocalAPI] Legacy create repair skipped (non-fatal):', repairErr.message)
  }

  // Create Hono app
  const app = createApp()

  // Route registry summary (isolation aid): proves which routes the RUNNING
  // build actually registered, so "404 on a known route" is instantly
  // diagnosable as a stale build/checkout.
  try {
    const registeredRoutes = (app.routes || []).map(function (r) { return r.method + ' ' + r.path })
    const hasImportSession = registeredRoutes.indexOf('POST /api/auth/import-session') !== -1
    console.log(`[LocalAPI] Router: ${registeredRoutes.length} routes registered — POST /api/auth/import-session: ${hasImportSession ? 'registered' : 'MISSING (stale build!)'}`)
  } catch (routeErr) {
    console.warn('[LocalAPI] Route registry summary unavailable:', routeErr.message)
  }

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
        resolve(serverInfo)
      }
    })

    // Store the server reference for stopLocalApi() and getStatus()
    httpServer = server

    // Handle listen errors (e.g. EADDRINUSE — port already in use)
    server.on('error', (err) => {
      if (!settled) {
        settled = true
        console.error(`[LocalAPI] Failed to listen on port ${port}:`, err.message)
        reject(err)
      }
    })
  })

  // ── Local realtime socket server (local-first, spec §7/§8) ────────────────
  // The desktop UI connects its Socket.IO client to THIS server (use-realtime
  // resolveSocketUrl → http://127.0.0.1:3080). Without it every UI realtime
  // connection 404'd and the dashboard showed "offline mode" even while the
  // cloud was healthy. Attach Socket.IO to the SAME HTTP server here.
  try {
    localRealtime.initLocalRealtime(httpServer, {
      getSession: () => (sessionToken && sessionUser ? { token: sessionToken, user: sessionUser } : null),
    })
    // Bridge the in-process event stream (emitEvent) onto the socket server —
    // every local business mutation becomes a live UI event, OFFLINE included.
    onEvent((event, payload) => {
      try { localRealtime.broadcastLocalRealtime(event, payload) } catch { /* non-fatal */ }
    })
  } catch (rtErr) {
    console.warn('[LocalAPI] Local realtime init failed (non-fatal — interval sync unaffected):', rtErr.message)
  }

  return { port, db }
}

/**
 * Stop the embedded local API server.
 */
function stopLocalApi() {
  // Close the realtime socket server BEFORE the HTTP server (it wraps it).
  try { localRealtime.closeLocalRealtime() } catch { /* not started */ }
  try { if (fileSync) fileSync.stop() } catch { /* not started */ }
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

// ─── Module Exports ──────────────────────────────────────────────────────

module.exports = {
  startLocalApi,
  stopLocalApi,
  getSession,
  setSession,
  clearSession,
  onEvent,
  setMutationListener,
  getStatus,
  logPendingMutation,
  logDeterministicOutcome,
  withOutboxTransaction,
  notifyMutationLogged,
  getPendingMutations,
  getOutboxStats,
  markMutationCompleted,
  markMutationFailed,
  markMutationConflict,
  markMutationSending,
  classifyMutationFailure,
  computeRetryBackoffMs,
  deriveStableIdempotencyKey,
  broadcastLocalRealtime: (...args) => localRealtime.broadcastLocalRealtime(...args),
  setLocalRealtimeRelayContext: (...args) => localRealtime.setLocalRealtimeRelayContext(...args),
  relayCloudRealtime: (...args) => localRealtime.relayCloudRealtime(...args),
  getLocalRealtimeStats: () => localRealtime.getLocalRealtimeStats(),
  repairLegacyReservationCreates,
  DEFAULT_PORT,
}