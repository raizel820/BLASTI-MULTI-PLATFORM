/**
 * BLASTI Desktop — Background Sync Service v2
 *
 * Protocol v2 sync between local SQLite and the cloud API (apps/api).
 * Runs in the Electron main process.
 *
 * Architecture (v2):
 *   ┌──────────────┐   1. OUTBOX REPLAY (authoritative outbound path)
 *   │ Local SQLite │ ─────────────────────────────────────────────► Cloud
 *   │  (local API) │      _pending_mutations rows are replayed to the
 *   └──────┬───────┘      ORIGINAL business route with a stable
 *          │              X-Idempotency-Key header. Cloud dedupes.
 *          │ 2. PULL (sequence-cursor change feed)
 *          │ ◄─────────────────────────────────────────────────────────
 *          │      POST /api/sync/pull { agencyId, sinceSequence } →
 *          │      { changes: { [Model]: { changed, deleted } } }
 *          │      Cursor advances ONLY after a page applies in a tx.
 *          │ 3. REALTIME hint: socket.io-client listens for
 *          │    'sync:changes' → debounced incremental pull.
 *          │ 4. SAFETY NETS: 30s incremental cycle (jittered) +
 *          │    6h full reconciliation (LWW) + record-level
 *          │    reconcileRecords() push after offline periods.
 *
 * Outbound consolidation (spec §11): the outbox replay is the ONLY
 * operational outbound path. The old table-diff push (_gatherLocalChanges +
 * _pushToCloud) was deleted. reconcileRecords() is the single remaining
 * record-diff path — a LWW reconciliation push used only during full
 * reconciliation and after connectivity restoration.
 */

const path = require('path');
const crypto = require('crypto');

// ─── Sync Registry (SSOT artifact from packages/core) ───────────────────────

let SYNC_TABLES = null;
let SYNC_REGISTRY_VERSION = 0;

function _loadSyncRegistry() {
  // 1. Relative path to the generated JSON artifact (preferred — works in
  //    Electron packaging when the repo layout is preserved).
  try {
    const registry = require(path.join(__dirname, '..', '..', '..', 'packages', 'core', 'sync-registry.json'));
    if (registry && Array.isArray(registry.syncedModels) && registry.syncedModels.length > 0) {
      SYNC_TABLES = registry.syncedModels.slice();
      SYNC_REGISTRY_VERSION = registry.protocolVersion || 2;
      console.log('[SyncService] SYNC_TABLES loaded from packages/core/sync-registry.json (' + SYNC_TABLES.length + ' models, protocol v' + SYNC_REGISTRY_VERSION + ')');
      return;
    }
  } catch { /* fall through */ }
  // 2. Packaged copy bundled next to this file (electron-builder 'files'
  //    includes local-api/** — the monorepo packages/ tree does NOT ship).
  try {
    const registry = require(path.join(__dirname, 'lib', 'sync-registry.json'));
    if (registry && Array.isArray(registry.syncedModels) && registry.syncedModels.length > 0) {
      SYNC_TABLES = registry.syncedModels.slice();
      SYNC_REGISTRY_VERSION = registry.protocolVersion || 2;
      console.log('[SyncService] SYNC_TABLES loaded from packaged local-api/lib/sync-registry.json (' + SYNC_TABLES.length + ' models, protocol v' + SYNC_REGISTRY_VERSION + ')');
      return;
    }
  } catch { /* fall through */ }
  // 3. @blasti/core subpath (resolvable in some workspace layouts).
  try {
    const registry = require('@blasti/core/sync-registry.json');
    if (registry && Array.isArray(registry.syncedModels) && registry.syncedModels.length > 0) {
      SYNC_TABLES = registry.syncedModels.slice();
      SYNC_REGISTRY_VERSION = registry.protocolVersion || 2;
      console.log('[SyncService] SYNC_TABLES loaded from @blasti/core/sync-registry.json (' + SYNC_TABLES.length + ' models, protocol v' + SYNC_REGISTRY_VERSION + ')');
      return;
    }
  } catch { /* fall through */ }
  // 4. Frozen fallback (kept in lockstep with packages/core/src/sync-registry.ts).
  console.warn('[SyncService] sync-registry.json not found — using FROZEN in-file model list (19 models). Regenerate packages/core/sync-registry.json if models changed.');
  SYNC_TABLES = [
    'Agency', 'User', 'AgencyStaff', 'Service', 'Branch', 'Counter',
    'QueueSettings', 'Reservation', 'Transaction', 'SmsSettings',
    'PaymentSettings', 'Notification', 'Announcement', 'GlobalAnnouncement',
    'Review', 'Favorite', 'FAQ', 'SubscriptionPlan', 'PlanFeature',
  ];
  SYNC_REGISTRY_VERSION = 2;
}
_loadSyncRegistry();

// Models WITHOUT an agencyId scalar column — they cannot be agency-scoped
// in the record-level reconciliation push (they flow via outbox replay and
// cloud→local pull only). Used by reconcileRecords() to skip unsafe tables.
const UNSCOPED_TABLES = new Set([
  'User', 'Notification', 'SmsSettings', 'PaymentSettings',
  'GlobalAnnouncement', 'FAQ', 'SubscriptionPlan', 'PlanFeature',
]);

// Agency-scoped tables (agencyId scalar column): used for the record-diff
// reconciliation push scoping. Counter is scoped via branchId → Branch.
const AGENCY_SCOPED_TABLES = new Set([
  'AgencyStaff', 'Service', 'Branch', 'QueueSettings', 'Reservation',
  'Transaction', 'Announcement', 'Review', 'Favorite',
]);

const DATE_FIELDS = new Set([
  'joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'noShowAt',
  'pausedAt', 'createdAt', 'updatedAt', 'openedAt', 'repliedAt',
  'reviewedAt', 'lastRoleChangeAt', 'gracePeriodEndsAt',
  'subscriptionStartsAt', 'subscriptionExpiresAt', 'reminderSentAt',
  'smsReminderSentAt', 'skippedAt', 'reclaimRequestedAt', 'qrClaimedAt',
  'offlineCreatedAt', 'lastActiveAt', 'resolvedAt', 'deletedAt',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_SYNC_INTERVAL_MS = 30_000;          // incremental pull cycle
const SYNC_INTERVAL_JITTER_MS = 5_000;            // ±5s jitter
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const PULL_PAGE_LIMIT = 500;
const RECONCILE_BATCH_SIZE = 200;
const MAX_RECONCILE_ROWS_PER_TABLE = 2000;
const LOCAL_MUTATION_DEBOUNCE_MS = 400;
const SOCKET_EVENT_DEBOUNCE_MS = 300;
const SOCKET_STALENESS_WATCHDOG_MS = 60_000;
const SOCKET_STALENESS_THRESHOLD_MS = 90_000;

// ─── State ────────────────────────────────────────────────────────────────────

let _config = null;
let _authToken = null;
let _userContext = null;
let _isSyncing = false;
let _isStarted = false;
let _lastError = null;
let _backoffMs = 2000;
let _consecutiveFailures = 0;
let _listeners = new Set();

// Timers
let _incrementalTimeoutId = null;   // self-rescheduling jittered incremental cycle
let _fullReconcileTimeoutId = null; // self-rescheduling 6h full reconcile
let _onlineListener = null;
let _watchdogIntervalId = null;
let _localMutationDebounceId = null;
let _socketPullDebounceId = null;

// Cursor / timestamps (mirrored in _sync_meta)
let _cursor = 0;                    // lastPulledSequence
let _lastPullAt = null;             // Date of last successful pull page batch
let _lastPushAt = null;             // Date of last successful outbox replay
let _lastFullSyncAt = null;
let _lastIncrementalSyncAt = null;

// Realtime socket
let _socket = null;
let _socketId = null;
let _lastEventAt = null;
let _lastPingAt = null;
let _realtimeEnabled = true;

// Replay serialization (never run two replays concurrently)
let _replayInFlight = false;
let _replayQueued = false;

// ─── Pending Mutations (Write-Ahead Log) — lazy circular-dep-safe loading ────

let _getPendingMutations = null;
let _markMutationCompleted = null;
let _markMutationFailed = null;

function _loadMutationFunctions() {
  // IMPORTANT: lazy require INSIDE the function — local-api/index.js must
  // never be required from this module's top level (circular dependency).
  try {
    const localApi = require('./index');
    _getPendingMutations = localApi.getPendingMutations;
    _markMutationCompleted = localApi.markMutationCompleted;
    _markMutationFailed = localApi.markMutationFailed;
  } catch (e) {
    console.warn('[SyncService] Could not load mutation functions:', e.message);
  }
}
_loadMutationFunctions();

// ─── Event System ──────────────────────────────────────────────────────────────

function emit(event) {
  for (const listener of _listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error('[SyncService] Listener error:', e);
    }
  }
}

function onSyncEvent(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

// Fields known to be Boolean in the Prisma schema that don't match the pattern
const BOOLEAN_FIELDS = new Set([
  'reminderSent', 'smsReminderSent', 'syncConflict', 'skippedForNoShow',
  'fixedTimeEnabled', 'enabled', 'isActive', 'isRead', 'isWalkIn', 'isPaused',
  'isRequired', 'allowWalkIn', 'autoComplete', 'isOpen', 'verified',
]);

function _isBooleanField(key) {
  return key.startsWith('is') || key.endsWith('Enabled') || BOOLEAN_FIELDS.has(key);
}

/**
 * Convert a scalar-only cloud record into a local-SQLite-safe row
 * (ISO date strings stay ISO strings; booleans → 0/1; nulls kept).
 */
function _cloudRecordToLocal(record) {
  const result = { id: record.id };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    if (DATE_FIELDS.has(key) && typeof value === 'string' && ISO_DATE_RE.test(value)) {
      // Keep as ISO string — Prisma stores DateTime as TEXT in SQLite
      result[key] = value;
    } else if (value instanceof Date) {
      result[key] = value.toISOString();
    } else if (_isBooleanField(key) && typeof value === 'boolean') {
      // SQLite stores booleans as 0/1 — Prisma handles the conversion
      result[key] = value ? 1 : 0;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Convert a local raw row into a cloud-safe payload
 * (epoch-number dates → ISO; 0/1 booleans → true/false).
 */
function _localRecordToCloud(record) {
  const result = { id: record.id };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    if (DATE_FIELDS.has(key) && typeof value === 'number') {
      result[key] = new Date(value).toISOString();
    } else if (DATE_FIELDS.has(key) && typeof value === 'string' && ISO_DATE_RE.test(value)) {
      result[key] = value;
    } else if (_isBooleanField(key) && (value === 0 || value === 1)) {
      result[key] = value === 1;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse a timestamp value into epoch ms. Handles:
 *  - epoch numbers (legacy local rows)
 *  - ISO strings from the cloud ("2025-01-01T10:00:00.000Z")
 *  - Prisma's SQLite TEXT format ("2025-01-01 10:00:00.123 +00:00")
 * Returns 0 when unparseable (treated as "very old").
 */
function _recordTimeMs(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return 0;
  try {
    var parsed = Date.parse(value);
    if (!isNaN(parsed)) return parsed;
    // Prisma SQLite format: "2025-01-01 10:00:00.123 +00:00"
    var normalized = value.trim().replace(' ', 'T').replace(/\s*\+00:00$/, 'Z');
    parsed = Date.parse(normalized);
    return isNaN(parsed) ? 0 : parsed;
  } catch {
    return 0;
  }
}

// ─── Sync Meta (_sync_meta key/value) ───────────────────────────────────────

async function _getSyncMeta(key) {
  const db = _config?.localDb;
  if (!db) return null;
  try {
    var rows = await db.$queryRawUnsafe('SELECT value FROM "_sync_meta" WHERE key = ?', key);
    var row = rows[0] || null;
    return row ? row.value : null;
  } catch (e) {
    console.error('[SyncService] _getSyncMeta error:', e.message);
    return null;
  }
}

async function _setSyncMeta(key, value) {
  const db = _config?.localDb;
  if (!db) return;
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_meta" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, String(value)
    );
  } catch (e) {
    console.error('[SyncService] _setSyncMeta error:', e.message);
  }
}

async function _getCursor() {
  // v2 cursor key. initial-sync.js bridges its snapshot with the legacy
  // '_lastPulledSequence' key — read that as a fallback so the engine
  // continues exactly where the initial import ended.
  var v = await _getSyncMeta('lastPulledSequence');
  if (v === null || v === undefined) {
    v = await _getSyncMeta('_lastPulledSequence');
  }
  var n = v ? parseInt(v, 10) : 0;
  return isNaN(n) ? 0 : n;
}
async function _setCursor(sequence) {
  _cursor = sequence;
  await _setSyncMeta('lastPulledSequence', sequence);
  // Keep the legacy bridge key in sync (initial-sync.js consumers).
  await _setSyncMeta('_lastPulledSequence', sequence);
}

// ─── Conflicts Table (kept from v1 — used by LWW + reconcile) ────────────────

async function _ensureConflictsTable() {
  const db = _config?.localDb;
  if (!db) return;
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_sync_meta" (' +
      '"key" TEXT PRIMARY KEY,' +
      '"value" TEXT NOT NULL' +
      ')'
    );
  } catch (e) {
    console.error('[SyncService] Failed to create _sync_meta table:', e.message);
  }
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_sync_conflicts" (' +
      '"id" TEXT PRIMARY KEY,' +
      '"modelName" TEXT NOT NULL,' +
      '"recordId" TEXT NOT NULL,' +
      '"agencyId" TEXT,' +
      '"localVersion" BIGINT,' +
      '"cloudVersion" BIGINT,' +
      '"localData" TEXT,' +
      '"cloudData" TEXT,' +
      '"resolution" TEXT DEFAULT \'pending\',' +
      '"resolvedAt" BIGINT,' +
      '"createdAt" BIGINT NOT NULL' +
      ')'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_model" ON "_sync_conflicts"("modelName")'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_resolution" ON "_sync_conflicts"("resolution")'
    );
    await _migrateSyncConflictsSchema(db);
  } catch (e) {
    console.error('[SyncService] Failed to create _sync_conflicts table:', e.message);
  }
}

/**
 * In-place migration for legacy _sync_conflicts shapes:
 *   - v1 tables used "tableName" (no modelName/agencyId) → add columns, copy data.
 *   - Timestamp/version columns were INTEGER → quaint binds INTEGER as Int32 and
 *     epoch-millis values overflow, so rebuild with BIGINT when needed.
 * Conflict rows are diagnostic bookkeeping; the rebuild preserves them.
 */
async function _migrateSyncConflictsSchema(db) {
  try {
    var cols = await db.$queryRawUnsafe('PRAGMA table_info("_sync_conflicts")');
    if (!cols || cols.length === 0) return;
    var colByName = {};
    cols.forEach(function (c) { colByName[c.name] = c; });

    var needsRebuild = false;
    ['resolvedAt', 'createdAt', 'localVersion', 'cloudVersion'].forEach(function (name) {
      if (colByName[name] && String(colByName[name].type || '').toUpperCase() !== 'BIGINT') {
        needsRebuild = true;
      }
    });

    if (needsRebuild) {
      await db.$executeRawUnsafe('ALTER TABLE "_sync_conflicts" RENAME TO "_sync_conflicts_old"');
      await db.$executeRawUnsafe(
        'CREATE TABLE "_sync_conflicts" (' +
        '"id" TEXT PRIMARY KEY,' +
        '"modelName" TEXT NOT NULL,' +
        '"recordId" TEXT NOT NULL,' +
        '"agencyId" TEXT,' +
        '"localVersion" BIGINT,' +
        '"cloudVersion" BIGINT,' +
        '"localData" TEXT,' +
        '"cloudData" TEXT,' +
        '"resolution" TEXT DEFAULT \'pending\',' +
        '"resolvedAt" BIGINT,' +
        '"createdAt" BIGINT NOT NULL' +
        ')'
      );
      // The old table may be v1 (tableName only) or current (modelName) —
      // introspect and build the copy SELECT accordingly.
      var oldCols = await db.$queryRawUnsafe('PRAGMA table_info("_sync_conflicts_old")');
      var oldNames = {};
      (oldCols || []).forEach(function (c) { oldNames[c.name] = true; });
      var modelExpr = oldNames['modelName']
        ? 'COALESCE("modelName", "tableName", \'\')'
        : 'COALESCE("tableName", \'\')';
      var agencyExpr = oldNames['agencyId'] ? '"agencyId"' : 'NULL';
      await db.$executeRawUnsafe(
        'INSERT OR IGNORE INTO "_sync_conflicts" ("id","modelName","recordId","agencyId","localVersion","cloudVersion","localData","cloudData","resolution","resolvedAt","createdAt") ' +
        'SELECT "id", ' + modelExpr + ', "recordId", ' + agencyExpr + ', "localVersion", "cloudVersion", "localData", "cloudData", COALESCE("resolution", \'pending\'), "resolvedAt", "createdAt" ' +
        'FROM "_sync_conflicts_old"'
      );
      await db.$executeRawUnsafe('DROP TABLE "_sync_conflicts_old"');
      await db.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_model" ON "_sync_conflicts"("modelName")'
      );
      await db.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_resolution" ON "_sync_conflicts"("resolution")'
      );
      console.log('[SyncService] Migrated _sync_conflicts to modelName/BIGINT schema');
      return;
    }

    // Same-shape upgrade: legacy tableName-only tables just gain columns.
    if (!colByName['modelName']) {
      await db.$executeRawUnsafe('ALTER TABLE "_sync_conflicts" ADD COLUMN "modelName" TEXT');
      await db.$executeRawUnsafe('UPDATE "_sync_conflicts" SET "modelName" = "tableName" WHERE "modelName" IS NULL');
    }
    if (!colByName['agencyId']) {
      await db.$executeRawUnsafe('ALTER TABLE "_sync_conflicts" ADD COLUMN "agencyId" TEXT');
    }
  } catch (e) {
    console.warn('[SyncService] _sync_conflicts migration skipped:', e.message);
  }
}

// ─── Exactly-Once Apply Ledger (pull idempotency) ─────────────────────────────

async function _ensureAppliedMutationsTable() {
  const db = _config?.localDb;
  if (!db) return;
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_sync_applied_mutations" (' +
      '"key" TEXT PRIMARY KEY,' +
      '"appliedAt" BIGINT NOT NULL' +
      ')'
    );
    // Legacy INTEGER appliedAt → BIGINT (epoch millis overflow Int32 binding).
    var cols = await db.$queryRawUnsafe('PRAGMA table_info("_sync_applied_mutations")');
    var col = cols && cols.find(function (c) { return c.name === 'appliedAt'; });
    if (col && String(col.type || '').toUpperCase() !== 'BIGINT') {
      await db.$executeRawUnsafe('ALTER TABLE "_sync_applied_mutations" RENAME TO "_sync_applied_mutations_old"');
      await db.$executeRawUnsafe(
        'CREATE TABLE "_sync_applied_mutations" ("key" TEXT PRIMARY KEY, "appliedAt" BIGINT NOT NULL)'
      );
      await db.$executeRawUnsafe(
        'INSERT OR IGNORE INTO "_sync_applied_mutations" ("key", "appliedAt") ' +
        'SELECT "key", "appliedAt" FROM "_sync_applied_mutations_old"'
      );
      await db.$executeRawUnsafe('DROP TABLE "_sync_applied_mutations_old"');
      console.log('[SyncService] Migrated _sync_applied_mutations.appliedAt to BIGINT');
    }
  } catch (e) {
    console.error('[SyncService] Failed to create _sync_applied_mutations table:', e.message);
  }
}

async function _isPullPageApplied(key) {
  const db = _config?.localDb;
  if (!db || !key) return false;
  try {
    var rows = await db.$queryRawUnsafe('SELECT key FROM "_sync_applied_mutations" WHERE key = ?', key);
    return !!(rows && rows[0]);
  } catch {
    return false;
  }
}

async function _markPullPageApplied(key) {
  const db = _config?.localDb;
  if (!db || !key) return;
  try {
    await db.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "_sync_applied_mutations" (key, appliedAt) VALUES (?, ?)',
      key, Date.now()
    );
  } catch (e) {
    console.warn('[SyncService] Failed to record applied pull page:', e.message);
  }
}

let _conflictCounter = 0;
function _generateConflictId() {
  _conflictCounter++;
  return 'conflict_' + Date.now().toString(36) + '_' + _conflictCounter;
}

/**
 * Coerce a loosely-typed version marker (millis number, Date, ISO string, or
 * integer) into a value safe to bind into a BIGINT column. Unparseable → null.
 */
function _versionToNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    var n = Number(v);
    if (isFinite(n)) return n;
    var ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
  }
  return null;
}

async function _logConflict(db, tableName, recordId, localVersion, cloudVersion, localData, cloudData) {
  if (!db) return null;
  var id = _generateConflictId();
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_conflicts" (id, "modelName", "recordId", "agencyId", "localVersion", "cloudVersion", "localData", "cloudData", "resolution", "resolvedAt", "createdAt") ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      id, tableName, recordId,
      (_config && _config.agencyId) || null,
      _versionToNum(localVersion), _versionToNum(cloudVersion),
      localData ? JSON.stringify(localData) : null,
      cloudData ? JSON.stringify(cloudData) : null,
      'pending',
      Date.now()
    );
  } catch (e) {
    console.error('[SyncService] Failed to log conflict:', e.message);
  }
  return id;
}

// ─── Network Check ────────────────────────────────────────────────────────────

async function _isOnline() {
  const baseUrl = _config?.cloudBaseUrl;
  if (!baseUrl) return false;
  try {
    // Use /health (not /api/health) — the cloud API serves the health
    // endpoint at the root level, not under /api/.
    const response = await fetch(baseUrl + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if the local embedded API (port 3080) is healthy.
 * Used to determine if we're in "local-only" mode.
 */
async function _isLocalApiUp() {
  try {
    const response = await fetch('http://127.0.0.1:3080/health', {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── Cloud HTTP Helpers ───────────────────────────────────────────────────────

async function _cloudPost(path, body, timeoutMs) {
  const baseUrl = _config.cloudBaseUrl;
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + _authToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 15000), // Prevent indefinite hangs when offline
  });
  if (!response.ok) {
    let errorDetail = response.statusText;
    try {
      const errData = await response.json();
      errorDetail = errData.error || errData.message || errorDetail;
    } catch { /* ignore */ }
    const err = new Error('Cloud ' + path + ' failed: ' + response.status + ' - ' + errorDetail);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

// ─── Backoff ───────────────────────────────────────────────────────────────────

function _resetBackoff() { _backoffMs = 2000; _consecutiveFailures = 0; }
function _increaseBackoff() { _consecutiveFailures++; _backoffMs = Math.min(_backoffMs * 2, MAX_BACKOFF_MS); }

// ─── Local Record CRUD Helpers ───────────────────────────────────────────────

async function _fetchLocalRecord(db, table, id) {
  try {
    var rows = await db.$queryRawUnsafe('SELECT * FROM "' + table + '" WHERE id = ?', id);
    return rows[0] || null;
  } catch (e) {
    console.error('[SyncService] _fetchLocalRecord(' + table + ', ' + id + ') error:', e.message);
    return null;
  }
}

async function _insertLocalRecord(db, table, record) {
  var entries = Object.entries(record);
  if (entries.length === 0) return;
  var columns = entries.map(function(kv) { return '"' + kv[0] + '"'; });
  var placeholders = entries.map(function() { return '?'; });
  var values = entries.map(function(kv) { return kv[1]; });
  var sql = 'INSERT OR IGNORE INTO "' + table + '" (' + columns.join(', ') + ') VALUES (' + placeholders.join(', ') + ')';
  await db.$executeRawUnsafe(sql, ...values);
}

async function _updateLocalRecord(db, table, record) {
  var entries = Object.entries(record).filter(function(kv) { return kv[0] !== 'id'; });
  if (entries.length === 0) return;
  var setClauses = entries.map(function(kv) { return '"' + kv[0] + '" = ?'; });
  var values = entries.map(function(kv) { return kv[1]; });
  var sql = 'UPDATE "' + table + '" SET ' + setClauses.join(', ') + ' WHERE id = ?';
  await db.$executeRawUnsafe(sql, ...values, record.id);
}

async function _deleteLocalRecord(db, table, id) {
  try {
    await db.$executeRawUnsafe('DELETE FROM "' + table + '" WHERE id = ?', id);
  } catch (e) {
    console.warn('[SyncService] Could not delete ' + table + '/' + id + ': ' + e.message);
  }
}

/**
 * Insert a local tombstone for a cloud-confirmed deletion.
 * Uses INSERT OR IGNORE on the cuid id so re-tombstoning is harmless.
 */
async function _tombstoneLocalRecord(db, table, id) {
  try {
    var tombId = 'tomb_' + crypto.randomBytes(12).toString('hex');
    await db.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "DeletedRecord" (id, "modelName", "recordId", "deletedAt") VALUES (?, ?, ?, ?)',
      tombId, table, id, new Date().toISOString()
    );
  } catch (e) {
    // Non-fatal: the table may be missing in very old local DBs.
    console.warn('[SyncService] Could not tombstone ' + table + '/' + id + ': ' + e.message);
  }
}

/**
 * Resurrection guard: a cloud record whose updatedAt predates a local
 * tombstone must NOT be re-applied (the record was deleted locally after
 * the cloud snapshot was taken).
 */
async function _isTombstonedNewer(db, table, recordId, recordUpdatedAt) {
  try {
    var rows = await db.$queryRawUnsafe(
      'SELECT "deletedAt" FROM "DeletedRecord" WHERE "modelName" = ? AND "recordId" = ?',
      table, recordId
    );
    if (!rows || rows.length === 0) return false;
    var recordMs = _recordTimeMs(recordUpdatedAt);
    for (var i = 0; i < rows.length; i++) {
      var tombMs = _recordTimeMs(rows[i].deletedAt !== undefined ? rows[i].deletedAt : rows[i].createdAt);
      if (tombMs >= recordMs) return true;
    }
    return false;
  } catch {
    return false; // tombstone table missing → don't block applies
  }
}

// ─── Agency Switch Detection ─────────────────────────────────────────────────

async function _checkAndResetForNewAgency() {
  var currentAgency = _config.agencyId || (_userContext && _userContext.agencyId);
  var lastAgency = await _getSyncMeta('lastSyncAgencyId');
  if (currentAgency && lastAgency && currentAgency !== lastAgency) {
    console.log('[SyncService] Agency changed: ' + lastAgency + ' -> ' + currentAgency + '. Resetting sync cursor for full pull.');
    await _setCursor(0);
    await _setSyncMeta('lastReconcileAt', '');
    await _setSyncMeta('lastFullSyncAt', '');
    await _setSyncMeta('lastSyncAgencyId', currentAgency);
  } else if (currentAgency && !lastAgency) {
    await _setSyncMeta('lastSyncAgencyId', currentAgency);
  }
}

// ─── Pull Cycle (protocol v2 sequence cursor) ────────────────────────────────

/**
 * Pull changes from the cloud change feed.
 *
 * @param {object} [options]
 * @param {boolean} [options.fullSync=false] — pull from sequence 0 (LWW still
 *   protects locally-newer records). Used by the 6h reconciliation cycle.
 * @returns {{ applied: number, conflicts: number, deleted: number, pages: number }}
 */
async function _pullFromCloud(options) {
  options = options || {};
  var db = _config.localDb;
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
  if (!db || !agencyId) return { applied: 0, conflicts: 0, deleted: 0, pages: 0 };

  var fullSync = options.fullSync === true;
  var applied = 0;
  var conflictCount = 0;
  var deletedCount = 0;
  var pages = 0;

  var sinceSequence = fullSync ? 0 : (await _getCursor());
  console.log('[SyncService] Pulling from cloud - agency: ' + agencyId + ', sinceSequence: ' + sinceSequence + (fullSync ? ' (FULL)' : ''));

  // Paginate: while hasMore === true, pull again from the page's latestSequence.
  for (var guard = 0; guard < 1000; guard++) {
    var pullData = await _cloudPost('/api/sync/pull', {
      agencyId: agencyId,
      sinceSequence: sinceSequence,
      limit: PULL_PAGE_LIMIT,
    });

    if (!pullData || !pullData.success) {
      throw new Error('Pull failed: ' + ((pullData && pullData.error) || 'unknown error'));
    }

    var latestSequence = typeof pullData.latestSequence === 'number' ? pullData.latestSequence : sinceSequence;
    var cloudChanges = pullData.changes || {};

    // Exactly-once ledger key: re-applying the exact same page window after a
    // crash (cursor failed to advance) is skipped. Record-level LWW inside
    // _applyPullChanges keeps any other replay path idempotent as well.
    var pageKey = 'pull:' + agencyId + ':' + sinceSequence + ':' + latestSequence;
    var alreadyApplied = await _isPullPageApplied(pageKey);

    if (alreadyApplied) {
      console.log('[SyncService] Pull page ' + sinceSequence + '→' + latestSequence + ' already applied (ledger) — skipping');
    } else {
      var result = await _applyPullChanges(db, cloudChanges);
      applied += result.applied;
      conflictCount += result.conflicts;
      deletedCount += result.deleted;
      await _markPullPageApplied(pageKey);
    }

    pages++;
    sinceSequence = latestSequence;
    _lastPullAt = new Date();

    // Advance the cursor ONLY after the page applied successfully.
    await _setCursor(latestSequence);

    if (!pullData.hasMore) break;
  }

  var nowIso = new Date().toISOString();
  if (fullSync) {
    _lastFullSyncAt = new Date();
    await _setSyncMeta('lastFullSyncAt', nowIso);
  } else {
    _lastIncrementalSyncAt = new Date();
    await _setSyncMeta('lastIncrementalSyncAt', nowIso);
  }
  await _touchAgencyLocalState(db, agencyId, { full: fullSync });

  console.log('[SyncService] Pull applied: ' + applied + ', conflicts: ' + conflictCount + ', deleted: ' + deletedCount + ', pages: ' + pages);
  return { applied: applied, conflicts: conflictCount, deleted: deletedCount, pages: pages };
}

/**
 * Apply one page of pull changes inside a single local transaction.
 * The pull transaction is the ONLY writer during pull.
 *
 * Hardening:
 *  - Models are applied in SYNC_TABLES (registry) order so parents
 *    (Agency/User/Service/Branch) land before children (Counter/Reservation).
 *  - Each record is wrapped in a SAVEPOINT: a record that fails (e.g. a
 *    foreign key whose parent row was never emitted to the change feed)
 *    is rolled back individually, logged loudly, and does NOT abort the
 *    page — the cursor still advances so one bad row can't wedge sync.
 */
async function _applyPullChanges(db, cloudChanges) {
  var applied = 0;
  var conflictCount = 0;
  var deletedCount = 0;
  var deferred = 0;

  await db.$transaction(async function(tx) {
    var spCounter = 0;

    async function withSavepoint(fn) {
      var sp = 'sp_pull_' + (++spCounter);
      try {
        await tx.$executeRawUnsafe('SAVEPOINT ' + sp);
        await fn();
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT ' + sp);
        return true;
      } catch (e) {
        try {
          await tx.$executeRawUnsafe('ROLLBACK TO ' + sp);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT ' + sp);
        } catch { /* savepoint bookkeeping is best-effort */ }
        console.warn('[SyncService] Record apply failed (deferred, page continues): ' + e.message.substring(0, 160));
        return false;
      }
    }

    // Apply models in registry (dependency) order, not wire order.
    var orderedModels = SYNC_TABLES.filter(function(m) { return cloudChanges[m] !== undefined; });
    Object.keys(cloudChanges).forEach(function(m) {
      if (SYNC_TABLES.indexOf(m) === -1) {
        console.warn('[SyncService] Skipping unknown model in pull: ' + m);
      }
    });

    for (var oi = 0; oi < orderedModels.length; oi++) {
      var modelName = orderedModels[oi];
      var table = modelName;
      var modelChanges = cloudChanges[modelName] || {};

      var changedList = modelChanges.changed || [];
      for (var ci = 0; ci < changedList.length; ci++) {
        var cloudRecord = changedList[ci];
        if (!cloudRecord || !cloudRecord.id) continue;

        // Resurrection guard: skip records a newer local tombstone deleted.
        var tombstoned = await _isTombstonedNewer(tx, table, cloudRecord.id, cloudRecord.updatedAt);
        if (tombstoned) {
          console.log('[SyncService] Resurrection guard: skipping ' + table + '/' + cloudRecord.id + ' (tombstoned locally)');
          continue;
        }

        var local = _cloudRecordToLocal(cloudRecord);
        var existing = await _fetchLocalRecord(tx, table, local.id);
        var ok = await withSavepoint(async function() {
          if (!existing) {
            await _insertLocalRecord(tx, table, local);
          } else {
            // LWW by updatedAt (epoch-ms comparison handles both ISO strings
            // and Prisma's SQLite TEXT datetime format).
            var cloudMs = _recordTimeMs(local.updatedAt);
            var localMs = _recordTimeMs(existing.updatedAt);
            if (cloudMs >= localMs) {
              await _updateLocalRecord(tx, table, local);
            } else {
              await _logConflict(tx, table, local.id, existing.updatedAt, local.updatedAt, existing, local);
              conflictCount++;
              emit({ type: 'sync-conflict', tableName: table, recordId: local.id, resolution: 'local_kept' });
            }
          }
        });
        if (ok) applied++; else deferred++;
      }

      var deletedList = modelChanges.deleted || [];
      for (var di = 0; di < deletedList.length; di++) {
        var deleteId = deletedList[di];
        var delOk = await withSavepoint(async function() {
          await _deleteLocalRecord(tx, table, deleteId);
          await _tombstoneLocalRecord(tx, table, deleteId);
        });
        if (delOk) deletedCount++; else deferred++;
      }
    }
  }, { maxWait: 5000, timeout: 60000 });

  if (deferred > 0) {
    console.warn('[SyncService] ' + deferred + ' pulled record(s) deferred (FK/missing parent) — will re-apply when their parents arrive');
  }
  return { applied: applied, conflicts: conflictCount, deleted: deletedCount, deferred: deferred };
}

/**
 * Best-effort mirror of pull timestamps into AgencyLocalState (used by
 * /api/db-status readiness reporting). Never throws.
 */
async function _touchAgencyLocalState(db, agencyId, opts) {
  try {
    var data = {};
    if (opts && opts.full) data.lastFullSyncAt = new Date();
    data.lastIncrementalSyncAt = new Date();
    await db.agencyLocalState.updateMany({ where: { agencyId: agencyId }, data: data });
  } catch { /* table/state row may not exist yet — non-fatal */ }
}

// ─── Outbox Replay (authoritative outbound mechanism) ────────────────────────

/**
 * Derive the stable idempotency key for a WAL row (matches the local API's
 * derivation: method:path:sha256(sorted body JSON, volatile fields stripped)).
 * Only used as a fallback for legacy rows logged before the
 * `idempotency_key` column existed.
 */
function _deriveIdempotencyKeyFallback(method, path, bodyStr) {
  try {
    var VolatileFields = ['clientTimestamp', 'clientTime', 'timestamp', 'issuedAt', 'nonce', 'requestId', 'localId'];
    function stripVolatile(value) {
      if (Array.isArray(value)) return value.map(stripVolatile);
      if (value && typeof value === 'object') {
        var sorted = {};
        Object.keys(value).sort().forEach(function(k) {
          if (VolatileFields.indexOf(k) !== -1) return;
          sorted[k] = stripVolatile(value[k]);
        });
        return sorted;
      }
      return value;
    }
    var body = bodyStr ? JSON.parse(bodyStr) : {};
    var hash = crypto.createHash('sha256').update(JSON.stringify(stripVolatile(body))).digest('hex');
    return method + ':' + path + ':' + hash;
  } catch {
    // Last resort: per-attempt key (cloud will treat it as a fresh mutation).
    return 'replay:' + method + ':' + path + ':' + crypto.randomUUID();
  }
}

/**
 * Replay pending mutations (the durable outbox) to the cloud.
 *
 * Each row is sent to the ORIGINAL route with the ORIGINAL method/body and
 * the stable X-Idempotency-Key header. The cloud's route-agnostic
 * idempotency middleware stores the first 2xx and returns it verbatim for
 * duplicates (X-Idempotency-Replayed: true) — so ANY 2xx means the business
 * effect happened exactly once → mark completed.
 *
 * - 401 → emit {type:'auth-expired'} and PAUSE (attempts are not burned).
 * - network errors → stop the batch (connectivity down), set _lastError.
 * - non-2xx → markMutationFailed (attempts+1; auto-abandoned after max).
 */
async function _replayPendingMutations() {
  if (!_authToken || !_config?.cloudBaseUrl) return { succeeded: 0, failed: 0 };
  if (!_getPendingMutations || !_markMutationCompleted || !_markMutationFailed) {
    _loadMutationFunctions();
    if (!_getPendingMutations) return { succeeded: 0, failed: 0 };
  }
  if (_replayInFlight) {
    _replayQueued = true;
    return { succeeded: 0, failed: 0, queued: true };
  }
  _replayInFlight = true;

  let succeeded = 0;
  let failed = 0;
  let paused = false;

  try {
    const mutations = await _getPendingMutations();
    if (!mutations || mutations.length === 0) return { succeeded: 0, failed: 0 };

    console.log('[SyncService] Replaying ' + mutations.length + ' pending mutations...');

    for (const mutation of mutations) {
      if (!_authToken) { paused = true; break; } // auth cleared mid-replay

      var method = (mutation.method || 'POST').toUpperCase();
      if (method === 'GET') {
        // GETs are never mutations — mark completed to unstick legacy rows.
        await _markMutationCompleted(mutation.id);
        continue;
      }

      var idemKey = mutation.idempotency_key
        || (mutation.idempotencyKey)
        || _deriveIdempotencyKeyFallback(method, mutation.path, typeof mutation.body === 'string' ? mutation.body : JSON.stringify(mutation.body || {}));

      var bodyStr = mutation.body === null || mutation.body === undefined
        ? undefined
        : (typeof mutation.body === 'string' ? mutation.body : JSON.stringify(mutation.body));

      try {
        var response = await fetch(_config.cloudBaseUrl + mutation.path, {
          method: method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + _authToken,
            'X-Idempotency-Key': idemKey,
          },
          body: bodyStr,
          signal: AbortSignal.timeout(15000),
        });

        if (response.ok) {
          // 2xx (including replayed duplicates) = business effect applied.
          await _markMutationCompleted(mutation.id);
          succeeded++;
          _lastPushAt = new Date();
        } else if (response.status === 401) {
          // Auth expired — pause replay, do NOT burn attempts.
          console.warn('[SyncService] Replay got 401 — pausing outbox (auth expired)');
          emit({ type: 'auth-expired' });
          _lastError = 'auth-expired (401 during replay)';
          paused = true;
          break;
        } else if (response.status === 409) {
          // Cloud: concurrent duplicate in progress — retry next cycle.
          await _markMutationFailed(mutation.id, 'HTTP 409: duplicate in progress');
          failed++;
        } else {
          var errorText = await response.text().catch(() => '');
          var willAbandon = (mutation.attempts || 0) + 1 >= (mutation.max_attempts || 5);
          await _markMutationFailed(mutation.id, 'HTTP ' + response.status + ': ' + errorText.substring(0, 200));
          failed++;
          if (willAbandon) {
            console.error('[SyncService] Mutation abandoned after max attempts:', method, mutation.path, '—', errorText.substring(0, 200));
            emit({
              type: 'mutation-abandoned',
              mutationId: mutation.id,
              method: method,
              path: mutation.path,
              lastError: errorText.substring(0, 200),
            });
          }
        }
      } catch (e) {
        // Network error / timeout — connectivity is down; stop burning
        // attempts on the rest of the batch and let the retry paths
        // (30s cycle, socket connect, 'online' event) reschedule.
        await _markMutationFailed(mutation.id, e.message);
        failed++;
        _lastError = 'replay network error: ' + e.message;
        _increaseBackoff();
        emit({ type: 'replay-network-error', error: e.message, backoffMs: _backoffMs });
        break;
      }
    }

    if (succeeded > 0 || failed > 0) {
      console.log('[SyncService] Mutation replay: ' + succeeded + ' succeeded, ' + failed + ' failed' + (paused ? ' (paused)' : ''));
      emit({ type: 'mutations-replayed', succeeded: succeeded, failed: failed, paused: paused });
    }
    if (succeeded > 0 && !paused) {
      _resetBackoff();
    }
    return { succeeded: succeeded, failed: failed };
  } catch (e) {
    console.error('[SyncService] _replayPendingMutations error:', e.message);
    _lastError = e.message;
    return { succeeded: succeeded, failed: failed, error: e.message };
  } finally {
    _replayInFlight = false;
    if (_replayQueued) {
      _replayQueued = false;
      setTimeout(function() {
        _replayPendingMutations().catch(function(err) {
          console.error('[SyncService] Queued replay error:', err.message);
        });
      }, 500);
    }
  }
}

// ─── Record-Level Reconciliation Push (the ONLY record-diff outbound path) ───

/**
 * Record-level LWW reconciliation push (spec §11).
 *
 * Gathers local rows updated since lastReconcileAt (agency-scoped) and pushes
 * each as a /api/sync/push mutation. Deletion of local records is NOT pushed
 * this way — deletions only flow through the outbox replay.
 *
 * Runs ONLY during the 6h full reconciliation and immediately after
 * connectivity restoration following an offline period.
 */
async function reconcileRecords() {
  var db = _config && _config.localDb;
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
  if (!db || !agencyId || !_authToken || !_config.cloudBaseUrl) {
    return { pushed: 0, conflicts: 0, errors: 0, skipped: 'not-ready' };
  }

  var lastReconcileRaw = await _getSyncMeta('lastReconcileAt');
  var sinceMs = lastReconcileRaw ? _recordTimeMs(lastReconcileRaw) : 0;
  var sinceISO = sinceMs > 0 ? new Date(sinceMs).toISOString() : '1970-01-01T00:00:00.000Z';
  console.log('[SyncService] Reconciling records since ' + sinceISO + (sinceMs === 0 ? ' (baseline run)' : ''));

  var pushed = 0;
  var conflicts = 0;
  var errors = 0;

  for (var ti = 0; ti < SYNC_TABLES.length; ti++) {
    var table = SYNC_TABLES[ti];
    var whereClause = null;
    var params = [];

    if (table === 'Agency') {
      whereClause = '"id" = ?';
      params.push(agencyId);
    } else if (AGENCY_SCOPED_TABLES.has(table)) {
      whereClause = '"agencyId" = ?';
      params.push(agencyId);
    } else if (table === 'Counter') {
      whereClause = '"branchId" IN (SELECT id FROM "Branch" WHERE "agencyId" = ?)';
      params.push(agencyId);
    } else {
      // Unscoped/global tables (User, Notification, SmsSettings, ...) flow via
      // the outbox replay + cloud→local pull only — never record-diff pushed.
      continue;
    }

    var rows = [];
    try {
      rows = await db.$queryRawUnsafe(
        'SELECT * FROM "' + table + '" WHERE ' + whereClause + ' AND "updatedAt" > ? ORDER BY "updatedAt" ASC LIMIT ?',
        ...params, sinceISO, MAX_RECONCILE_ROWS_PER_TABLE
      );
    } catch (e) {
      console.warn('[SyncService] Reconcile gather failed for ' + table + ':', e.message);
      continue;
    }
    if (!rows || rows.length === 0) continue;

    for (var ri = 0; ri < rows.length; ri += RECONCILE_BATCH_SIZE) {
      var batch = rows.slice(ri, ri + RECONCILE_BATCH_SIZE);
      var mutations = batch.map(function(row) {
        var isCreate = _recordTimeMs(row.createdAt) > sinceMs;
        var mutation = {
          mutationId: 'recon-' + crypto.randomUUID(),
          model: table,
          recordId: row.id,
          operation: isCreate ? 'create' : 'update',
          data: _localRecordToCloud(row),
        };
        if (row.updatedAt) mutation.localUpdatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : new Date(row.updatedAt).toISOString();
        if (typeof row.syncVersion === 'number') mutation.expectedVersion = row.syncVersion;
        return mutation;
      });

      try {
        var pushResponse = await _cloudPost('/api/sync/push', {
          agencyId: agencyId,
          mutations: mutations,
        });
        var results = (pushResponse && pushResponse.results) || [];
        for (var mi = 0; mi < results.length; mi++) {
          var r = results[mi];
          if (r.status === 'applied' || r.status === 'duplicate') {
            pushed++;
          } else if (r.status === 'conflict') {
            conflicts++;
            var localRow = batch.find(function(b) { return b.id === r.recordId; });
            await _logConflict(db, table, r.recordId,
              localRow ? localRow.updatedAt : null,
              r.conflict ? r.conflict.cloudVersion : null,
              localRow, r.conflict || null);
            emit({ type: 'sync-conflict', tableName: table, recordId: r.recordId, resolution: 'reconcile_conflict' });
          } else {
            errors++;
            console.warn('[SyncService] Reconcile mutation error (' + table + '/' + r.recordId + '):', JSON.stringify(r.conflict || r));
          }
        }
        // Cloud caps batches at 500; if it reports more pending, keep going
        // on the next reconcile — per-batch results above are authoritative
        // for what was submitted.
      } catch (e) {
        errors++;
        _lastError = 'reconcile push failed: ' + e.message;
        console.warn('[SyncService] Reconcile push failed for ' + table + ':', e.message);
        break; // stop pushing this table; other tables continue next run
      }
    }
  }

  await _setSyncMeta('lastReconcileAt', new Date().toISOString());
  console.log('[SyncService] Reconcile done: pushed ' + pushed + ', conflicts ' + conflicts + ', errors ' + errors);
  return { pushed: pushed, conflicts: conflicts, errors: errors };
}

// ─── Realtime Socket (cloud → local fast-path hint) ──────────────────────────

function _destroySocket() {
  if (_socket) {
    try { _socket.disconnect(); } catch { /* ignore */ }
    try { _socket.removeAllListeners(); } catch { /* ignore */ }
    _socket = null;
  }
  _socketId = null;
}

function _setupSocket() {
  if (!_realtimeEnabled) return;
  if (!_isStarted || !_authToken || !_config?.cloudBaseUrl) return;

  _destroySocket();
  try {
    // Lazy require so a missing dependency never crashes the sync engine.
    var io;
    try {
      io = require('socket.io-client').io;
    } catch (e) {
      console.warn('[SyncService] socket.io-client not available — realtime disabled (interval fallback covers sync):', e.message);
      _realtimeEnabled = false;
      return;
    }

    var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
    _socket = io(_config.cloudBaseUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
      auth: { token: _authToken },
    });

    _socket.on('connect', function() {
      try {
        _socketId = _socket.id || null;
        _lastPingAt = Date.now();
        console.log('[SyncService] Realtime socket connected:', _socketId);
        if (agencyId) _socket.emit('join:agency', agencyId);
        // Trigger a pull on (re)connect — catches changes missed while offline.
        _scheduleSocketPull(SOCKET_EVENT_DEBOUNCE_MS);
      } catch (e) {
        console.warn('[SyncService] socket connect handler error:', e.message);
      }
    });

    _socket.on('sync:changes', function(payload) {
      try {
        _lastEventAt = Date.now();
        var p = payload || {};
        console.log('[SyncService] sync:changes received — models:', (p.models || []).join(',') || '?', 'count:', p.changeCount);
        _scheduleSocketPull(SOCKET_EVENT_DEBOUNCE_MS);
      } catch (e) {
        console.warn('[SyncService] sync:changes handler error:', e.message);
      }
    });

    _socket.on('disconnect', function(reason) {
      _socketId = null;
      console.log('[SyncService] Realtime socket disconnected:', reason);
    });

    _socket.on('connect_error', function(err) {
      // Logged only — the 30s interval fallback covers sync while offline.
      console.warn('[SyncService] Realtime socket connect_error:', (err && err.message) || err);
    });

    // Track engine ping/pong for the staleness watchdog.
    try {
      if (_socket.io && typeof _socket.io.on === 'function') {
        _socket.io.on('ping', function() { _lastPingAt = Date.now(); });
        _socket.io.on('pong', function() { _lastPingAt = Date.now(); });
      }
    } catch { /* manager events are best-effort */ }

    console.log('[SyncService] Realtime socket initialized →', _config.cloudBaseUrl);
  } catch (e) {
    console.error('[SyncService] Failed to setup realtime socket (non-fatal):', e.message);
    _socket = null;
  }
}

function _scheduleSocketPull(debounceMs) {
  if (_socketPullDebounceId) clearTimeout(_socketPullDebounceId);
  _socketPullDebounceId = setTimeout(function() {
    _socketPullDebounceId = null;
    _incrementalPullCycle('realtime').catch(function(err) {
      console.error('[SyncService] Realtime pull error:', err.message);
    });
  }, debounceMs || SOCKET_EVENT_DEBOUNCE_MS);
}

/**
 * Staleness watchdog: if the socket claims to be connected but we have seen
 * no ping/pong (or any pull/event activity) within 90s, force a reconnect.
 * socket.io has its own ping/pong (25s/20s) — this catches stuck states.
 */
function _startWatchdog() {
  if (_watchdogIntervalId) return;
  _watchdogIntervalId = setInterval(function() {
    try {
      if (!_socket || !_socket.connected) return;
      var lastAlive = Math.max(_lastPingAt || 0, _lastEventAt || 0, _lastPullAt ? _lastPullAt.getTime() : 0);
      if (Date.now() - lastAlive > SOCKET_STALENESS_THRESHOLD_MS) {
        console.warn('[SyncService] Realtime socket stale (>90s without ping/pong) — forcing reconnect');
        _lastPingAt = Date.now(); // avoid re-triggering before reconnect completes
        _setupSocket();
      }
    } catch (e) {
      console.warn('[SyncService] Watchdog error (non-fatal):', e.message);
    }
  }, SOCKET_STALENESS_WATCHDOG_MS);
}

function _stopWatchdog() {
  if (_watchdogIntervalId) { clearInterval(_watchdogIntervalId); _watchdogIntervalId = null; }
}

// ─── Sync Cycles ──────────────────────────────────────────────────────────────

async function _preCheck() {
  if (_isSyncing) return false;
  if (!_authToken) return false;
  if (!_config || !_config.localDb) return false;
  return true;
}

async function _handleOffline() {
  const localUp = await _isLocalApiUp();
  if (localUp && _authToken) {
    console.log('[SyncService] Cloud offline, local API healthy — local-only mode');
    _lastError = 'cloud-offline';
    emit({ type: 'sync-paused', reason: 'cloud-offline' });
    return;
  }
  console.log('[SyncService] Offline - skipping');
  _lastError = 'offline';
  emit({ type: 'sync-paused', reason: 'offline' });
}

/**
 * One incremental cycle: replay outbox (authoritative outbound) + pull.
 * Triggered by the jittered 30s interval, socket events, 'online' events,
 * and triggerSyncNow().
 */
async function _incrementalPullCycle(trigger) {
  if (!(await _preCheck())) return;
  var online = await _isOnline();
  if (!online) {
    await _handleOffline();
    return;
  }

  _isSyncing = true;
  _lastError = null;
  emit({ type: 'sync-start', trigger: trigger || 'interval' });

  try {
    await _checkAndResetForNewAgency();
    var replayResult = await _replayPendingMutations();
    var pullResult = await _pullFromCloud();
    _resetBackoff();

    emit({
      type: 'sync-complete',
      stats: {
        pulled: pullResult.applied,
        replayed: replayResult.succeeded,
        replayFailed: replayResult.failed,
        deleted: pullResult.deleted,
        conflicts: pullResult.conflicts,
      },
    });
  } catch (err) {
    _lastError = err.message;
    _increaseBackoff();
    console.error('[SyncService] Sync failed (' + _backoffMs + 'ms backoff):', err.message);
    emit({ type: 'sync-error', error: err.message, backoffMs: _backoffMs, failures: _consecutiveFailures });
  } finally {
    _isSyncing = false;
  }
}

/**
 * Full reconciliation (every 6h): pull from sequence 0 with LWW
 * (recovers from SyncChange compaction and missed events) + the
 * record-level reconcileRecords() push.
 */
async function _fullReconcileCycle() {
  if (!(await _preCheck())) return;
  var online = await _isOnline();
  if (!online) {
    await _handleOffline();
    return;
  }

  _isSyncing = true;
  emit({ type: 'sync-start', trigger: 'full-reconcile' });

  try {
    await _checkAndResetForNewAgency();
    var pullResult = await _pullFromCloud({ fullSync: true });
    var replayResult = await _replayPendingMutations();
    var reconcileResult = await reconcileRecords();
    _resetBackoff();
    _lastFullSyncAt = new Date();
    await _setSyncMeta('lastFullSyncAt', _lastFullSyncAt.toISOString());

    emit({
      type: 'sync-complete',
      stats: {
        pulled: pullResult.applied,
        replayed: replayResult.succeeded,
        reconciled: reconcileResult.pushed,
        conflicts: pullResult.conflicts + reconcileResult.conflicts,
      },
      full: true,
    });
    console.log('[SyncService] Full reconciliation complete');
  } catch (err) {
    _lastError = err.message;
    _increaseBackoff();
    console.error('[SyncService] Full reconciliation failed:', err.message);
    emit({ type: 'sync-error', error: err.message, backoffMs: _backoffMs, failures: _consecutiveFailures });
  } finally {
    _isSyncing = false;
  }
}

function _scheduleNextIncremental() {
  if (!_isStarted) return;
  if (_incrementalTimeoutId) clearTimeout(_incrementalTimeoutId);
  var jitter = Math.floor(Math.random() * (2 * SYNC_INTERVAL_JITTER_MS + 1)) - SYNC_INTERVAL_JITTER_MS;
  var delay = Math.max(5000, (_config.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS) + jitter);
  _incrementalTimeoutId = setTimeout(async function() {
    try {
      await _incrementalPullCycle('interval');
    } catch (err) {
      console.error('[SyncService] Periodic sync error:', err.message);
    }
    _scheduleNextIncremental();
  }, delay);
}

function _scheduleNextFullReconcile() {
  if (!_isStarted) return;
  if (_fullReconcileTimeoutId) clearTimeout(_fullReconcileTimeoutId);
  _fullReconcileTimeoutId = setTimeout(async function() {
    try {
      await _fullReconcileCycle();
    } catch (err) {
      console.error('[SyncService] Full reconcile error:', err.message);
    }
    _scheduleNextFullReconcile();
  }, FULL_RECONCILE_INTERVAL_MS);
}

// ─── Public API ────────────────────────────────────────────────────────────────

async function startSync(config) {
  if (_isStarted) {
    console.warn('[SyncService] Already started');
    return;
  }
  if (!config || !config.localDb) {
    console.error('[SyncService] startSync requires config with localDb');
    return;
  }
  _config = {
    syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
    initialDelayMs: 3000,
    cloudBaseUrl: '',
    agencyId: '',
    deviceId: 'unknown',
    realtimeEnabled: true,
  };
  Object.keys(config).forEach(function(k) { _config[k] = config[k]; });
  _realtimeEnabled = _config.realtimeEnabled !== false;

  _isStarted = true;
  await _ensureConflictsTable();
  await _ensureAppliedMutationsTable();

  // ── Self-wire the local-mutation → outbox-replay fast path ──────────────
  // The engine registers its own mutation listener so the replay is
  // triggered even when the host (Electron main.js normally, but also tests
  // and scripts that require this module directly) never calls
  // localApi.setMutationListener(). Double registration with main.js's
  // wiring is harmless: notifyMutationLogged invokes both listeners and the
  // LOCAL_MUTATION_DEBOUNCE_MS debounce coalesces them into ONE replay.
  try {
    var localApiForListener = require('./index'); // safe here: both modules fully loaded at runtime
    if (typeof localApiForListener.setMutationListener === 'function') {
      localApiForListener.setMutationListener(function() {
        try { onLocalMutation(); } catch (e) { /* engine not ready */ }
      });
      console.log('[SyncService] Local mutation listener self-wired to outbox replay');
    }
  } catch (e) {
    console.warn('[SyncService] Could not self-wire mutation listener:', e.message);
  }

  // Hydrate the persisted cursor (initial sync writes it via setInitialCursor).
  _cursor = await _getCursor();

  console.log('[SyncService] Starting v2 - cloud: ' + _config.cloudBaseUrl +
    ', agency: ' + (_config.agencyId || (_userContext && _userContext.agencyId) || 'pending auth') +
    ', auth: ' + (_authToken ? 'set (user: ' + ((_userContext && _userContext.id) || 'unknown') + ')' : 'none — waiting for setAuth()/import-session; stored-auth restore happens in diagnostics step 3.1') +
    ', interval: ' + (_config.syncIntervalMs / 1000) + 's' +
    ', cursor: ' + _cursor +
    ', realtime: ' + _realtimeEnabled);

  // First cycle after a short delay (lets initial sync finish first when
  // both are triggered by the same login flow).
  _incrementalTimeoutId = setTimeout(async function() {
    try {
      await _incrementalPullCycle('startup');
    } catch (err) {
      console.error('[SyncService] Initial cycle error:', err.message);
    }
    _scheduleNextIncremental();
  }, _config.initialDelayMs);

  _scheduleNextFullReconcile();

  _onlineListener = function() {
    console.log('[SyncService] Network online - triggering sync');
    // Connectivity restored: replay the outbox immediately, then pull.
    _incrementalPullCycle('online-event').catch(function(err) {
      console.error('[SyncService] Online-event sync error:', err.message);
    });
    // After an offline period, also run the record-level reconciliation push
    // (safety net for anything that missed the outbox).
    setTimeout(function() {
      reconcileRecords().catch(function(err) {
        console.error('[SyncService] Post-online reconcile error:', err.message);
      });
    }, 5000);
  };
  if (typeof process !== 'undefined' && process.on) {
    process.on('online', _onlineListener);
  }

  // Realtime socket (lazy — only when a cloud URL is configured).
  if (_config.cloudBaseUrl) {
    _setupSocket();
    _startWatchdog();
  }
}

function stopSync() {
  if (!_isStarted) return;
  if (_incrementalTimeoutId) { clearTimeout(_incrementalTimeoutId); _incrementalTimeoutId = null; }
  if (_fullReconcileTimeoutId) { clearTimeout(_fullReconcileTimeoutId); _fullReconcileTimeoutId = null; }
  if (_socketPullDebounceId) { clearTimeout(_socketPullDebounceId); _socketPullDebounceId = null; }
  if (_localMutationDebounceId) { clearTimeout(_localMutationDebounceId); _localMutationDebounceId = null; }
  if (_onlineListener) {
    if (typeof process !== 'undefined' && process.off) { process.off('online', _onlineListener); }
    _onlineListener = null;
  }
  _stopWatchdog();
  _destroySocket();
  _isStarted = false;
  _isSyncing = false;
  console.log('[SyncService] Stopped');
}

/**
 * Manual trigger: replay pending mutations + one incremental pull cycle.
 * (The old table-diff push is gone — the outbox is the outbound path.)
 */
function triggerSyncNow() {
  _replayPendingMutations().catch(() => {});
  return _incrementalPullCycle('manual');
}

/**
 * Local→cloud immediacy: called by the local API (via main.js mutation
 * listener) after every local business mutation. Debounced 400ms so a burst
 * of mutations coalesces into one outbox replay.
 */
function onLocalMutation() {
  if (!_isStarted || !_authToken) return;
  if (_localMutationDebounceId) clearTimeout(_localMutationDebounceId);
  _localMutationDebounceId = setTimeout(async function() {
    _localMutationDebounceId = null;
    try {
      // Only replay when actually online — otherwise the 30s cycle,
      // socket 'connect' and 'online' event paths pick it up (no attempt
      // burn on fetch failures).
      if (!(await _isOnline())) return;
      await _replayPendingMutations();
    } catch (e) {
      console.warn('[SyncService] onLocalMutation replay error:', e.message);
    }
  }, LOCAL_MUTATION_DEBOUNCE_MS);
}

/**
 * Initialize the pull cursor from the initial sync's snapshotSequence.
 * Called by main.js after runInitialSync() completes successfully.
 */
async function setInitialCursor(sequence) {
  var seq = parseInt(sequence, 10);
  if (isNaN(seq) || seq < 0) seq = 0;
  await _setCursor(seq);
  console.log('[SyncService] Initial cursor set to ' + seq);
}

async function getStatus() {
  // Pending mutations count (non-blocking)
  let pendingMutations = 0;
  if (_getPendingMutations) {
    try {
      const pending = await _getPendingMutations();
      pendingMutations = pending?.length || 0;
    } catch { /* ignore */ }
  }
  if (!_getPendingMutations) {
    try {
      var db = _config && _config.localDb;
      if (db) {
        var rows = await db.$queryRawUnsafe("SELECT COUNT(*) as cnt FROM \"_pending_mutations\" WHERE status = 'pending'");
        pendingMutations = Number(rows[0]?.cnt ?? 0);
      }
    } catch { /* ignore */ }
  }

  var cursorVal = _cursor || (await _getCursor());

  return {
    // v2 diagnostics
    isSyncing: _isSyncing,
    isStarted: _isStarted,
    hasAuth: !!_authToken,
    agencyId: (_config && _config.agencyId) || (_userContext && _userContext.agencyId) || null,
    cloudBaseUrl: (_config && _config.cloudBaseUrl) || null,
    socketConnected: !!(_socket && _socket.connected),
    socketId: _socketId,
    lastEventAt: _lastEventAt ? new Date(_lastEventAt).toISOString() : null,
    lastPingAt: _lastPingAt ? new Date(_lastPingAt).toISOString() : null,
    lastPullAt: _lastPullAt ? _lastPullAt.toISOString() : null,
    lastPushAt: _lastPushAt ? _lastPushAt.toISOString() : null,
    lastFullSyncAt: _lastFullSyncAt ? _lastFullSyncAt.toISOString() : await _getSyncMeta('lastFullSyncAt') || null,
    lastIncrementalSyncAt: _lastIncrementalSyncAt ? _lastIncrementalSyncAt.toISOString() : await _getSyncMeta('lastIncrementalSyncAt') || null,
    cursor: cursorVal,
    pendingMutations: pendingMutations,
    lastError: _lastError,
    backoffMs: _backoffMs,
    consecutiveFailures: _consecutiveFailures,
    syncIntervalMs: (_config && _config.syncIntervalMs) || null,
    realtimeEnabled: _realtimeEnabled,

    // Backward-compat fields (v1 consumers: sync-status-detail, stores)
    lastSyncAt: (_lastIncrementalSyncAt || _lastPullAt) ? (_lastIncrementalSyncAt || _lastPullAt).toISOString() : null,
    lastPullVersion: cursorVal || null,
    lastPushVersion: _lastPushAt ? _lastPushAt.getTime() : null,
    syncProtocolVersion: 2,
    syncModelCount: SYNC_TABLES.length,
  };
}

function setAuth(token, userContext) {
  _authToken = token;
  _userContext = userContext;
  if (userContext && userContext.agencyId && _config && !_config.agencyId) {
    _config.agencyId = userContext.agencyId;
  }
  console.log('[SyncService] Auth set - user: ' + (userContext && userContext.id) + ', role: ' + (userContext && userContext.role) + ', agency: ' + (userContext && userContext.agencyId || 'none'));

  // (Re)initialize the realtime socket with the fresh token.
  if (_isStarted && _config?.cloudBaseUrl) {
    _setupSocket();
  }

  // Trigger a cycle shortly after auth is set (post-login replay + pull).
  if (_isStarted && token) {
    setTimeout(function() {
      _incrementalPullCycle('post-auth').catch(function(err) {
        console.error('[SyncService] Post-auth sync error:', err.message);
      });
    }, 1000);
  }
}

function clearAuth() {
  _authToken = null;
  _userContext = null;
  _destroySocket();
  console.log('[SyncService] Auth cleared');
}

async function getConflicts() {
  var db = _config && _config.localDb;
  if (!db) return [];
  try {
    var rows = await db.$queryRawUnsafe('SELECT * FROM "_sync_conflicts" WHERE resolution IS NULL OR resolution = \'pending\' ORDER BY "createdAt" DESC');
    return rows.map(function(row) {
      var modelName = row.modelName || row.tableName || null;
      // BIGINT columns arrive as JS BigInt — convert for JSON safety.
      var toNum = function (v) { return typeof v === 'bigint' ? Number(v) : v; };
      return {
        id: row.id,
        modelName: modelName,
        tableName: modelName, // backward-compatible field name for v1 UI consumers
        agencyId: row.agencyId || null,
        recordId: row.recordId,
        localVersion: toNum(row.localVersion),
        cloudVersion: toNum(row.cloudVersion),
        localData: row.localData ? JSON.parse(row.localData) : null,
        cloudData: row.cloudData ? JSON.parse(row.cloudData) : null,
        resolution: row.resolution,
        resolvedAt: toNum(row.resolvedAt),
        createdAt: toNum(row.createdAt),
      };
    });
  } catch (e) {
    console.error('[SyncService] getConflicts error:', e.message);
    return [];
  }
}

async function resolveConflict(conflictId, resolution) {
  var db = _config && _config.localDb;
  if (!db) throw new Error('Database not available');
  if (resolution !== 'local' && resolution !== 'cloud') {
    throw new Error('Resolution must be "local" or "cloud"');
  }
  await _ensureConflictsTable();
  var rows = await db.$queryRawUnsafe('SELECT * FROM "_sync_conflicts" WHERE id = ? AND (resolution IS NULL OR resolution = \'pending\')', conflictId);
  var conflict = rows[0] || null;
  if (!conflict) {
    var notFound = new Error('Conflict not found or already resolved: ' + conflictId);
    notFound.notFound = true;
    throw notFound;
  }
  var tableName = conflict.modelName || conflict.tableName;
  var recordId = conflict.recordId;

  if (resolution === 'cloud') {
    var cloudData = conflict.cloudData ? JSON.parse(conflict.cloudData) : null;
    if (cloudData) {
      var localRecord = _cloudRecordToLocal(cloudData);
      var existing = await _fetchLocalRecord(db, tableName, recordId);
      if (existing) {
        await _updateLocalRecord(db, tableName, localRecord);
      } else {
        await _insertLocalRecord(db, tableName, localRecord);
      }
    }
  }

  await db.$executeRawUnsafe('UPDATE "_sync_conflicts" SET resolution = ?, "resolvedAt" = ? WHERE id = ?', resolution, Date.now(), conflictId);
  emit({ type: 'sync-conflict', tableName: tableName, recordId: recordId, resolution: resolution, conflictId: conflictId });
  console.log('[SyncService] Conflict ' + conflictId + ' resolved: ' + resolution);
}

/**
 * Prune local tombstones older than maxAgeMs (default 30 days).
 * Tombstones exist to block resurrection of records deleted while a peer was
 * offline; once every client has long since reconciled, they are safe to drop.
 * DeletedRecord.deletedAt is a Prisma DateTime (stored as ISO TEXT in SQLite),
 * so the cutoff is compared as an ISO string (lexicographic order holds).
 */
async function cleanupTombstones(maxAgeMs) {
  var db = _config && _config.localDb;
  if (!db) return 0;
  var age = typeof maxAgeMs === 'number' && maxAgeMs > 0 ? maxAgeMs : 30 * 24 * 60 * 60 * 1000;
  var cutoffIso = new Date(Date.now() - age).toISOString();
  try {
    var res = await db.$executeRawUnsafe(
      'DELETE FROM "DeletedRecord" WHERE "deletedAt" < ?',
      cutoffIso
    );
    var removed = typeof res === 'number' ? res : 0;
    if (removed > 0) console.log('[SyncService] Pruned ' + removed + ' old tombstone(s)');
    return removed;
  } catch (e) {
    console.error('[SyncService] cleanupTombstones error:', e.message);
    return 0;
  }
}

module.exports = {
  startSync: startSync,
  stopSync: stopSync,
  triggerSyncNow: triggerSyncNow,
  cleanupTombstones: cleanupTombstones,
  getStatus: getStatus,
  setAuth: setAuth,
  clearAuth: clearAuth,
  onSyncEvent: onSyncEvent,
  getConflicts: getConflicts,
  resolveConflict: resolveConflict,
  // v2 additions
  onLocalMutation: onLocalMutation,
  setInitialCursor: setInitialCursor,
  reconcileRecords: reconcileRecords,
};
