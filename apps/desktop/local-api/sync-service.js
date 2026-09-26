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

// Task 33-C — authorization state cache (workspace lock).
//   'AUTHORIZED' → fresh proof of authorization (refresh 200 / fresh login).
//   'REVOKED'    → the cloud EXPLICITLY rejected the session (401/403 verified
//                  through the refresh-session discriminator) — the workspace
//                  is LOCKED: no pull/push/replay, engine stopped, re-login required.
//   null         → unknown / not yet proven — behaves exactly like the
//                  pre-33-C offline-first engine (never blocks on its own).
// Mirrored in _sync_meta ('authorization_status') so the lock survives restarts.
let _authzStatus = null;
let _authzRevokedAt = null;
let _authzReason = null;
let _authzBlockedWarnedAt = 0;
let _lastRevocationReason = null;

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
    _markMutationConflict = localApi.markMutationConflict;
    _markMutationSending = localApi.markMutationSending;
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

// Task 46: schema-aware record sanitizer shared with initial-sync. The
// incremental pull path previously passed relation objects / unknown columns
// / null-on-NOT-NULL values straight into raw INSERT/UPDATE — one `staff:
// null` or a drifted field wedged the record in _deferred_changes forever.
// The sanitizer drops unknown columns, keeps null only on NULLABLE columns
// ("not set by the user yet" is real data), and repairs type drift.
var _recordSanitizer = null
function _getRecordSanitizer() {
  if (_recordSanitizer === null) {
    try {
      _recordSanitizer = require('./lib/sync-record-sanitize')
    } catch (e) {
      console.warn('[SyncService] record sanitizer unavailable (pass-through): ' + e.message)
      _recordSanitizer = false
    }
  }
  return _recordSanitizer || null
}

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
/**
 * Per-model fields that must never be persisted from the wire even if a
 * cloud build regresses (Task 14 — User sync/auth contract, defense in
 * depth; the cloud's USER_SYNC projection + REDACTED_FIELDS are the first
 * two layers). Generic for every role.
 */
var SYNC_EXCLUDED_FIELDS = {
  User: ['passwordHash', 'fcmToken'],
}

function _cloudRecordToLocal(record, modelName) {
  // Task 46: sanitize FIRST (schema-aware drop/repair), then the existing
  // scalar conversions. Dropped keys are logged for core models so a wedged
  // record can be diagnosed from the console alone.
  var sanitizer = _getRecordSanitizer()
  var source = record
  if (sanitizer) {
    try {
      var s = sanitizer.sanitizeSyncRecord(modelName, record)
      if (s.dropped.length > 0) {
        console.log('[SyncService] sanitize ' + modelName + '/' + record.id + ': dropped ' + sanitizer.formatDropped(s.dropped))
      }
      source = s.clean || {}
    } catch (e) {
      console.warn('[SyncService] sanitize failed for ' + modelName + '/' + record.id + ' (pass-through): ' + e.message)
      source = record
    }
  }
  const excluded = modelName ? (SYNC_EXCLUDED_FIELDS[modelName] || null) : null
  const result = { id: source.id };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'id') continue;
    if (excluded && excluded.indexOf(key) !== -1) continue;
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
  // Task 46: carry the fallback-fabrication tag (symbol — invisible to
  // Object.entries/JSON) so the UPDATE branch can exclude fabricated values.
  if (sanitizer && typeof sanitizer.copyFallbackTags === 'function') {
    sanitizer.copyFallbackTags(source, result);
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
  //
  // CURSOR INVARIANT GUARD (field round 6): the two keys MUST agree.
  // Historically the initial-sync bridge wrote ONLY the legacy key while a
  // stale v2 key (over-advanced by an older build's pull, e.g. 893) SHADOWED
  // the bridge's correct final sequence (890) — the engine then pulled from
  // 893, silently skipping 891..893 relative to the import baseline. The
  // invariant is: the cursor may only cover changes that are LEDGER-ACCOUNTED.
  // When the keys disagree we adopt the MINIMUM (re-applying is idempotent
  // via upserts + the page ledger; advancing past unaccounted changes is not
  // recoverable) and heal both keys so divergence cannot persist.
  var v2Raw = await _getSyncMeta('lastPulledSequence');
  var legacyRaw = await _getSyncMeta('_lastPulledSequence');
  var v2 = (v2Raw !== null && v2Raw !== undefined && v2Raw !== '') ? parseInt(v2Raw, 10) : NaN;
  var legacy = (legacyRaw !== null && legacyRaw !== undefined && legacyRaw !== '') ? parseInt(legacyRaw, 10) : NaN;

  if (!isNaN(v2) && !isNaN(legacy) && v2 !== legacy) {
    var safe = Math.min(v2, legacy);
    console.warn('[SyncService] CURSOR KEYS DIVERGED (lastPulledSequence=' + v2 + ', _lastPulledSequence=' + legacy +
      ') — adopting MIN ' + safe + ' and healing both keys. NEVER skip changes that are not ledger-accounted.');
    await _setCursor(safe);
    return safe;
  }
  if (!isNaN(v2)) return v2;
  if (!isNaN(legacy)) {
    // Legacy-only value (e.g. written by the initial-sync bridge): heal it
    // into both keys so the engine and any external readers stay coherent.
    await _setCursor(legacy);
    return legacy;
  }
  return 0;
}
async function _setCursor(sequence) {
  if (typeof _cursor === 'number' && _cursor > 0 && sequence < _cursor) {
    console.warn('[SyncService] Cursor REWIND ' + _cursor + ' -> ' + sequence +
      ' (safe: page application is ledger-idempotent via upserts; advancing past unaccounted changes would NOT be)');
  }
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

// ─── Backoff ──────────────────────────────────────────────────────────────────

function _resetBackoff() { _backoffMs = 2000; _consecutiveFailures = 0; }
function _increaseBackoff() { _consecutiveFailures++; _backoffMs = Math.min(_backoffMs * 2, MAX_BACKOFF_MS); }

// ─── Cloud error classification (Task 33-C) ──────────────────────────────
/**
 * HARD USER REQUIREMENT: an explicit cloud REJECTION (401/403) is NEVER
 * "offline". Offline mode is only allowed when the cloud is unreachable
 * (network failure / timeout) or answering 5xx. Classification:
 *
 *   'UNREACHABLE'    → no HTTP response at all (ECONNREFUSED / ENOTFOUND /
 *                      abort / timeout / connection reset) OR a cloud 5xx.
 *   'AUTH_REJECTED'  → the cloud ANSWERED 401/403 — explicit rejection.
 *   'TRANSIENT'      → any other 4xx (request problem, not an auth verdict).
 */
function classifyCloudError(err) {
  var status = (err && typeof err.status === 'number') ? err.status : null;
  if (status === null && err && err.cause && typeof err.cause === 'object' && typeof err.cause.status === 'number') {
    status = err.cause.status;
  }
  if (status !== null) {
    if (status === 401 || status === 403) return 'AUTH_REJECTED';
    if (status >= 500) return 'UNREACHABLE';
    return 'TRANSIENT';
  }
  // No HTTP status anywhere in the chain → the request never got a response.
  return 'UNREACHABLE';
}

// ─── Cloud sync-route probe (initialization precondition) ────────────────────
/**
 * Authoritative reachability probe for the INITIALIZER: does the cloud origin
 * actually host the v2 sync API? Health alone is NOT sufficient — a static
 * host or a stale apps/api build can answer /health while every /api/sync/*
 * route 404s (observed in the field, Task 12/15).
 *
 * Classification:
 *   available=true            → route answered (ANY status except 404; 401/403
 *                               mean the route EXISTS but rejected the token)
 *   available=false, notFound → 404 — routes missing (stale build / wrong service)
 *   available=false, network  → unreachable / offline
 */
async function _probeCloudSyncRoutes() {
  var baseUrl = _config && _config.cloudBaseUrl;
  if (!baseUrl) return { available: false, reason: 'no-base-url' };
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId) || 'probe';
  try {
    var response = await fetch(baseUrl + '/api/sync/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (_authToken || 'none'),
      },
      body: JSON.stringify({ agencyId: agencyId, sinceSequence: 0, limit: 1 }),
      signal: AbortSignal.timeout(6000),
    });
    if (response.status === 404) {
      var body = '';
      try { body = (await response.text()).replace(/\s+/g, ' ').substring(0, 160); } catch { }
      return { available: false, reason: 'not-found', status: 404, body: body };
    }
    // ANY other status (200/400/401/403/422/500) proves the route exists.
    return { available: true, status: response.status, authRejected: response.status === 401 || response.status === 403 };
  } catch (e) {
    return { available: false, reason: 'network', error: (e && e.message) || String(e) };
  }
}

// ─── Workspace Initialization Coordinator (P0: deadlock breaker) ─────────────
/**
 * ONE trigger point that wakes the initializer (initial-sync.js — the single
 * OWNER of initialization) whenever the engine observes:
 *   NOT_INITIALIZED / FAILED workspace + auth present + cloud sync API reachable.
 *
 * Historic deadlock (field log, round 4): the loading-screen cloud probe made
 * ONE 404 observation, concluded "cloud unavailable", skipped the initial
 * import, and NOTHING ever re-tried — while the realtime socket proved the
 * cloud WAS reachable seconds later. The pull engine correctly BLOCKS
 * incremental sync until READY (Part D), so the workspace stayed
 * NOT_INITIALIZED forever. This coordinator closes that loop:
 *
 *   NOT_INITIALIZED + cloud becomes available  →  initial sync auto-starts.
 *   Incremental sync stays blocked until READY (unchanged, Part D).
 *
 * Guarantees:
 *   - single-flight: concurrent triggers join the in-flight promise;
 *   - rate-limited: failed attempts back off (10s) so offline machines and
 *     wrong-origin setups don't hammer the probe every cycle;
 *   - delegated ownership: actual import runs ONLY inside
 *     initial-sync.js runInitialSync (its own _activeSync lock applies).
 */
var _initAttempt = null;
var _lastInitAttemptAt = 0;
var INIT_ATTEMPT_MIN_INTERVAL_MS = 10_000;

// Round 16 — stale-context heal: when the session context carries NO agency
// (fresh owner before the setup wizard, or the agency was created on another
// device), ask the cloud to re-issue the session from the DATABASE's current
// state. Rate-limited separately so an agency-less desktop doesn't call the
// cloud on every engine tick.
var _lastSessionProbeAt = 0;
var SESSION_PROBE_MIN_INTERVAL_MS = 60_000;

async function _refreshSessionFromCloud() {
  var now = Date.now();
  if (now - _lastSessionProbeAt < SESSION_PROBE_MIN_INTERVAL_MS) return null;
  _lastSessionProbeAt = now;
  if (!_authToken || !_config || !_config.cloudBaseUrl) return null;
  try {
    var res = await fetch(_config.cloudBaseUrl + '/api/auth/refresh-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + _authToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log('[SyncService] Session refresh probe → HTTP ' + res.status + ' (agency stays unresolved)');
      return null;
    }
    var data = await res.json();
    if (data && data.success && data.user) return data;
    return null;
  } catch (e) {
    console.warn('[SyncService] Session refresh probe failed:', (e && e.message) || e);
    return null;
  }
}

/**
 * Task 33-C — status-PROPAGATING variant of _refreshSessionFromCloud.
 * The stale-context probe above swallows every non-OK answer (it only heals
 * an unresolved agency); the revocation discriminator NEEDS the verdict:
 * 200 (authorized), 401/403 (explicitly rejected) or a network failure.
 * Returns { kind: 'ok'|'rejected'|'network', status?, body?, error? }.
 */
async function _refreshSessionStrict() {
  if (!_authToken || !_config || !_config.cloudBaseUrl) {
    return { kind: 'network', error: 'no-auth-or-config' };
  }
  try {
    var res = await fetch(_config.cloudBaseUrl + '/api/auth/refresh-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + _authToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    var data = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    return { kind: res.ok ? 'ok' : 'rejected', status: res.status, body: data };
  } catch (e) {
    return { kind: 'network', error: (e && e.message) || String(e) };
  }
}

/**
 * Task 33-C — the revocation DISCRIMINATOR. A single 401 on pull/replay may
 * mean an expired token OR a dead account; only an explicit rejection from a
 * REACHABLE cloud (the refresh attempt itself being answered) may revoke.
 * A network failure NEVER revokes (hard invariant 1).
 *
 * Returns:
 *   'RESTORED' → refresh 200: session re-issued from the cloud DB's CURRENT
 *                state — adopt token+user (same adoption as the stale-context
 *                probe) and record AUTHORIZED.
 *   'REVOKED'  → refresh 401/403 from the reachable cloud: the account/token
 *                is genuinely rejected (ghost session after a cloud DB reset,
 *                deleted user, revoked device).
 *   'OFFLINE'  → cloud unreachable / inconclusive — stay offline-first, DO
 *                NOT revoke.
 */
async function _confirmRevocation() {
  // (a) A network failure is never a revocation — reachability first.
  if (!(await _isOnline())) {
    console.log('[SyncService] Cloud unreachable — staying in offline mode (not revoked)');
    return 'OFFLINE';
  }
  if (!_authToken || !_config || !_config.cloudBaseUrl) return 'OFFLINE';
  // (b) Ask the cloud to re-issue the session from its CURRENT DB state.
  var attempt = await _refreshSessionStrict();
  if (attempt.kind === 'network') {
    console.log('[SyncService] Cloud unreachable — staying in offline mode (not revoked)');
    return 'OFFLINE';
  }
  if (attempt.kind === 'ok' && attempt.body && attempt.body.success && attempt.body.token && attempt.body.user) {
    // (c) Fresh proof of authorization — adopt the re-issued session.
    _authToken = attempt.body.token;
    _userContext = attempt.body.user;
    if (_config && !_config.agencyId && attempt.body.user.agencyId) _config.agencyId = attempt.body.user.agencyId;
    _authzStatus = 'AUTHORIZED';
    _authzRevokedAt = null;
    _authzReason = null;
    _setSyncMeta('authorization_status', 'AUTHORIZED').catch(function () { });
    console.log('[SyncService] Refresh confirmed the session — authorization RESTORED (token re-issued from the cloud DB)');
    return 'RESTORED';
  }
  if (attempt.status === 401 || attempt.status === 403) {
    // (d) EXPLICIT rejection from a reachable cloud.
    var bodyMsg = (attempt.body && (attempt.body.error || attempt.body.message)) || '';
    _lastRevocationReason = String(bodyMsg).indexOf('Account not found') !== -1 ? 'account-not-found' : 'token-rejected';
    return 'REVOKED';
  }
  // (e) Any other answer (5xx, malformed body) — not an explicit auth verdict.
  return 'OFFLINE';
}

/**
 * Shared handler for every explicit 401/403 observed on a cloud call.
 * Confirms via the refresh discriminator, then — and ONLY then — locks the
 * workspace. Idempotent once REVOKED.
 */
async function _handleAuthRejection(source) {
  if (_authzStatus === 'REVOKED') return 'REVOKED';
  console.log('[SyncService] Cloud rejected the session (HTTP 401/403) — confirming with refresh… (' + source + ')');
  var verdict = await _confirmRevocation();
  if (verdict === 'REVOKED') {
    await _executeRevocation(_lastRevocationReason || 'token-rejected');
  }
  // 'OFFLINE' already logged its "staying in offline mode" line; 'RESTORED'
  // logged the adoption. The caller decides what each verdict means for it.
  return verdict;
}

/**
 * Task 33-C — the revocation routine (sync-engine side). Locks the sync
 * surface, delegates the LOCAL lock (device credential revocation, session
 * clear, file-sync stop) to local-api/index.js revokeLocalAuthorization via
 * the established lazy require (module cycle), and notifies the app through
 * the event bus. Data rows are NEVER touched (lock access only).
 */
async function _executeRevocation(reason) {
  if (_authzStatus === 'REVOKED' && _authzRevokedAt) {
    return; // already locked
  }
  console.log('[SyncService] Authorization REVOKED — locking workspace (reason: ' + reason + ')');
  _authzStatus = 'REVOKED';
  _authzRevokedAt = new Date().toISOString();
  _authzReason = reason;
  try {
    await _setSyncMeta('authorization_status', 'REVOKED');
    await _setSyncMeta('authorization_revoked_at', _authzRevokedAt);
    await _setSyncMeta('authorization_reason', reason);
  } catch (metaErr) {
    console.warn('[SyncService] Could not persist revocation meta:', metaErr.message);
  }
  var locked = false;
  try {
    var localApi = require('./index'); // lazy — existing module-cycle pattern
    if (typeof localApi.revokeLocalAuthorization === 'function') {
      locked = await localApi.revokeLocalAuthorization(reason);
    }
  } catch (e) {
    console.warn('[SyncService] Local revocation routine unavailable:', (e && e.message) || e);
  }
  if (!locked) {
    // Graceful degradation: still stop the engine + clear the credential
    // cache here so no further cloud calls carry the rejected token.
    try { clearAuth(); } catch { }
    try { stopSync(); } catch { }
  }
  console.log('[SyncService] Workspace LOCKED — sync stopped, re-login required (local data kept for recovery/audit)');
  emit({ type: 'authorization-revoked', reason: reason });
}

// ─── Task 44: READY-workspace empty-core reconciliation ─────────────────────
//
// Rate-limited (once per hour, in-memory — an app restart deliberately
// re-arms it) cross-check of the two tables whose emptiness breaks the
// workspace UI. Delegates to initial-sync.reconcileEmptyBusinessStages,
// which itself no-ops for any table with rows and imports straight from the
// cloud's canonical list endpoints when a table is empty AND the cloud
// still reports rows. Emits the same SYNC_STAGE_COMPLETED events the
// initializer emits so the UI/diagnostics stay uniform.
var _lastReadyReconcileAt = 0;
var READY_RECONCILE_MIN_INTERVAL_MS = 60 * 60 * 1000;

async function _reconcileReadyWorkspace(agencyId) {
  var db = _config && _config.localDb;
  if (!db || !agencyId || !_authToken || !_config || !_config.cloudBaseUrl) return null;
  var now = Date.now();
  if (now - _lastReadyReconcileAt < READY_RECONCILE_MIN_INTERVAL_MS) return null;
  _lastReadyReconcileAt = now;

  var initialSync = require('./initial-sync'); // lazy — module cycle
  if (typeof initialSync.reconcileEmptyBusinessStages !== 'function') return null;

  var report = await initialSync.reconcileEmptyBusinessStages(db, agencyId, _config.cloudBaseUrl, _authToken, null, function (evt) {
    try { emit(evt); } catch { }
  });

  if (report) {
    var healed = [];
    Object.keys(report).forEach(function (stage) {
      var r = report[stage];
      if (r && r.reconciled > 0) healed.push(stage + '=' + r.reconciled);
      else if (r && r.cloudCheckError) console.warn('[SyncService] Ready-reconcile ' + stage + ': cloud check failed — ' + r.cloudCheckError);
    });
    if (healed.length > 0) {
      console.log('[SyncService] READY-workspace reconciliation HEALED empty core tables: ' + healed.join(', ') + ' (agency ' + agencyId + ')');
      emit({ type: 'workspace-reconciled', agencyId: agencyId, report: report });
    } else {
      console.log('[SyncService] Ready-reconcile check: no empty core tables to heal (or the cloud is empty too)');
    }
  }
  return report;
}

function ensureWorkspaceInitialized(trigger) {
  if (!_isStarted) return Promise.resolve({ skipped: 'engine-not-started' });
  if (!_authToken) return Promise.resolve({ skipped: 'no-auth' });
  var db = _config && _config.localDb;
  if (!db) return Promise.resolve({ skipped: 'no-db' });
  if (_initAttempt) return _initAttempt;
  var now = Date.now();
  if (now - _lastInitAttemptAt < INIT_ATTEMPT_MIN_INTERVAL_MS) {
    return Promise.resolve({ skipped: 'rate-limited' });
  }
  _lastInitAttemptAt = now;

  _initAttempt = (async function () {
    var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);

    // Round 16 (field deadlock): a session WITHOUT an agency is not terminal.
    // The token is a snapshot — the agency may exist in the cloud already
    // (created by the setup wizard seconds ago, or on another device) while
    // this context is stale. Ask the cloud for the CURRENT session truth;
    // only skip when the cloud confirms there is genuinely no agency.
    if (!agencyId) {
      var refreshed = await _refreshSessionFromCloud();
      if (!refreshed || !(refreshed.user && refreshed.user.agencyId)) {
        return { skipped: 'no-agency' };
      }
      _authToken = refreshed.token || _authToken;
      _userContext = refreshed.user;
      agencyId = refreshed.user.agencyId;
      if (_config && !_config.agencyId) _config.agencyId = agencyId;
      console.log('[SyncService] Session agency resolved from cloud: ' + agencyId + ' — resuming initialization');
    }

    // Fast path: already READY → nothing to do (5s-cached check, force=false).
    if (await _isAgencyReady()) {
      // Task 44: READY does not mean CORRECT. A workspace that imported while
      // the cloud genuinely had no branches/services (or whose change feed
      // could not deliver them — pre-extension cloud build, pruned
      // SyncChange rows, agency resolved differently at import time) stays
      // READY forever with EMPTY core tables: the exact "webapp shows
      // branches, desktop shows none" incident. Task 43's reconciliation
      // only runs INSIDE runInitialSync — which never re-runs for a READY
      // workspace — so it could never heal this state. Fire the same
      // empty-core reconciliation here (rate-limited, no-op when the tables
      // are populated or the cloud reports 0 too).
      _reconcileReadyWorkspace(agencyId).catch(function (e) {
        console.warn('[SyncService] READY-workspace reconciliation failed (non-fatal):', (e && e.message) || e);
      });
      return { skipped: 'ready' };
    }

    // The cloud sync API must genuinely host /api/sync/* before importing.
    var probe = await _probeCloudSyncRoutes();
    if (!probe.available) {
      console.log('[SyncService] Init coordinator (' + trigger + '): cloud sync API not confirmed (' +
        probe.reason + (probe.status ? ' HTTP ' + probe.status : '') + ') — initial sync stays deferred');
      return { skipped: 'cloud-unavailable', probe: probe };
    }
    if (probe.authRejected) {
      // Task 33-C: the sync route EXPLICITLY rejected the token — confirm
      // with the refresh discriminator before deciding anything. A confirmed
      // rejection locks the workspace (STOP, no retries); an unreachable
      // cloud keeps the offline-first deferral.
      console.warn('[SyncService] Init coordinator (' + trigger + '): sync route present but token rejected (HTTP ' + probe.status + ') — confirming with refresh…');
      var authzVerdict = await _handleAuthRejection('init-coordinator');
      if (authzVerdict === 'REVOKED') {
        return { skipped: 'authorization-revoked', probe: probe };
      }
      if (authzVerdict === 'RESTORED') {
        console.log('[SyncService] Init coordinator (' + trigger + '): session restored via refresh — continuing initialization with the re-issued token');
        // fall through: runInitialSync below uses the ADOPTED _authToken.
      } else {
        return { skipped: 'auth-rejected', probe: probe };
      }
    }

    console.log('[SyncService] Init coordinator (' + trigger + '): workspace not READY but cloud sync API IS reachable → AUTO-STARTING initial sync');
    var initialSync = require('./initial-sync'); // lazy — avoids the module cycle
    var result;
    try {
      result = await initialSync.runInitialSync({
        agencyId: agencyId,
        cloudAuthToken: _authToken,
        cloudUrl: _config.cloudBaseUrl,
        db: db,
        emitFn: function (evt) { try { emit(evt); } catch { } },
      });
    } catch (e) {
      result = { success: false, error: (e && e.message) || String(e) };
    }

    if (result && result.success) {
      await _isAgencyReady(true); // force-refresh the gate cache
      console.log('[SyncService] Init coordinator: initial sync COMPLETED — workspace READY (' +
        (result.totalRecords || 0) + ' records)');
      // CURSOR INVARIANT (field round 6): adopt the initializer's cursor
      // BEFORE the first post-READY pull — the bridge proved coverage up to
      // its final sequence; a stale pre-import cursor (e.g. 893 vs bridge
      // 890) must never decide where the next pull starts.
      try {
        await adoptInitialSyncCursor(result, 'init-coordinator');
      } catch (cursorErr) {
        console.warn('[SyncService] Cursor adoption after initial sync failed (continuing):', cursorErr.message);
      }
      emit({ type: 'workspace-ready', agencyId: agencyId, totalRecords: result.totalRecords || 0 });
      // Kick the engine immediately — replay + pull start now, not in 30s.
      _incrementalPullCycle('post-init').catch(function (err) {
        console.warn('[SyncService] Post-init cycle error:', err.message);
      });
    } else {
      console.warn('[SyncService] Init coordinator: auto initial sync FAILED — will re-attempt on the next trigger:',
        (result && result.error) || 'unknown');
      emit({ type: 'workspace-init-failed', agencyId: agencyId, error: (result && result.error) || 'unknown' });
    }
    return result;
  })().catch(function (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }).finally(function () {
    _initAttempt = null;
  });

  return _initAttempt;
}

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

  // Part D hard gate: even fullSync pull-from-0 must not populate an
  // uninitialized agency (that would fake partial progress without READY).
  if (!(await _isAgencyReady())) {
    console.warn('[SyncService] Pull BLOCKED - agency not READY (Part D gate)');
    return { applied: 0, conflicts: 0, deleted: 0, pages: 0, deferred: 0, blockedNotReady: true };
  }

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

    // Part L: the SAFE page cursor is pageLastSequence (last row INCLUDED in
    // this page). The global max must NEVER advance a cursor - rows committed
    // between the page query and a global-max query would be skipped forever.
    var pageLastSequence = typeof pullData.pageLastSequence === 'number'
      ? pullData.pageLastSequence
      : (typeof pullData.latestSequence === 'number' ? pullData.latestSequence : sinceSequence);
    var cloudChanges = pullData.changes || {};

    // Part AB (retention awareness): a cursor older than the prune horizon
    // means feed changes were compacted - schedule a full reconciliation.
    var oldestAvailable = typeof pullData.oldestAvailableSequence === 'number' ? pullData.oldestAvailableSequence : null;
    if (!fullSync && oldestAvailable !== null && oldestAvailable > 0 && sinceSequence > 0 && sinceSequence < oldestAvailable) {
      console.warn('[SyncService] Cursor ' + sinceSequence + ' is OLDER than the feed retention horizon (' + oldestAvailable + ') - scheduling full snapshot reconciliation (Part AB)');
      _retentionRepairNeeded = true;
    }

    // Exactly-once ledger key: re-applying the exact same page window after a
    // crash (cursor failed to advance) is skipped. Record-level LWW inside
    // _applyPullChanges keeps any other replay path idempotent as well.
    // Part M: the page is only claimed applied once every failed record in it
    // is DURABLY persisted in _deferred_changes (inside the same transaction).
    var pageKey = 'pull:' + agencyId + ':' + sinceSequence + ':' + pageLastSequence;
    var alreadyApplied = await _isPullPageApplied(pageKey);

    if (alreadyApplied) {
      console.log('[SyncService] Pull page ' + sinceSequence + ' -> ' + pageLastSequence + ' already applied (ledger) - skipping');
    } else {
      var result = await _applyPullChanges(db, cloudChanges, { agencyId: agencyId, pageLastSequence: pageLastSequence });
      applied += result.applied;
      conflictCount += result.conflicts;
      deletedCount += result.deleted;
      await _markPullPageApplied(pageKey);
    }

    pages++;
    sinceSequence = pageLastSequence;
    _lastPullAt = new Date();

    // Advance the cursor ONLY after the page applied (failures durably deferred).
    await _setCursor(pageLastSequence);

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

  var deferredTotal = await _countDeferredChanges(db, agencyId);
  console.log('[SyncService] Pull applied: ' + applied + ', conflicts: ' + conflictCount + ', deleted: ' + deletedCount + ', pages: ' + pages + ', deferredPending: ' + deferredTotal);
  return { applied: applied, conflicts: conflictCount, deleted: deletedCount, pages: pages, deferred: deferredTotal };
}

// ─── Durable Deferred-Change Queue (Part K) ──────────────────────────────────
// A cloud change that fails with a genuine dependency/FK error is PERSISTED
// here inside the pull transaction - NEVER held only in memory. Every change
// is exactly one of: APPLIED | PENDING here | CONFLICT (_sync_conflicts) |
// QUARANTINED here. Nothing is ever "skipped and forgotten" (Part M).

async function _ensureDeferredTable(db) {
  if (!db) return;
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_deferred_changes" (' +
      '"id" TEXT PRIMARY KEY,' +
      '"agencyId" TEXT NOT NULL,' +
      '"source" TEXT NOT NULL DEFAULT \'pull\',' +
      '"sequence" INTEGER,' +
      '"stage" TEXT,' +
      '"model" TEXT NOT NULL,' +
      '"recordId" TEXT NOT NULL,' +
      '"operation" TEXT NOT NULL,' +
      '"payload" TEXT,' +
      '"dependencyError" TEXT,' +
      '"retryCount" INTEGER NOT NULL DEFAULT 0,' +
      '"firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '"lastRetryAt" DATETIME,' +
      '"nextRetryAt" DATETIME,' +
      '"status" TEXT NOT NULL DEFAULT \'PENDING\',' +
      '"lastError" TEXT' +
      ')'
    );
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_deferred_agency_status" ON "_deferred_changes"("agencyId", "status")');
    await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "idx_deferred_status_next" ON "_deferred_changes"("status", "nextRetryAt")');
  } catch (e) {
    console.error('[SyncService] Failed to ensure _deferred_changes:', e.message);
  }
}

async function _countDeferredChanges(db, agencyId) {
  try {
    var rows = await db.$queryRawUnsafe(
      'SELECT COUNT(*) as n FROM "_deferred_changes" WHERE "agencyId" = ? AND "status" = \'PENDING\'', agencyId
    );
    return Number(rows?.[0]?.n || 0);
  } catch { return 0; }
}

/** Is this error a genuine FK/dependency failure (retryable, Part J)? */
function _isDependencyError(err) {
  var msg = String((err && err.message) || err || '');
  return /FOREIGN KEY|SQLITE_CONSTRAINT.*FOREIGNKEY|constraint failed.*foreign/i.test(msg);
}

/**
 * Retry due deferred changes: re-apply each persisted payload; success ->
 * remove; repeated dependency failure -> keep pending with backoff; repeated
 * NON-dependency failure -> QUARANTINE (visible, blocks trust in completeness).
 */
async function _retryDeferredChanges() {
  var db = _config && _config.localDb;
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
  if (!db || !agencyId) return { resolved: 0, retried: 0, quarantined: 0 };
  await _ensureDeferredTable(db);
  var resolved = 0, attempted = 0, quarantined = 0;
  try {
    var due = await db.$queryRawUnsafe(
      'SELECT * FROM "_deferred_changes" WHERE "agencyId" = ? AND "status" = \'PENDING\' ' +
      'AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= ?) ORDER BY "firstSeenAt" ASC LIMIT 100',
      agencyId, new Date().toISOString()
    );
    if (!due || due.length === 0) return { resolved: 0, retried: 0, quarantined: 0 };

    console.log('[SyncService] Retrying ' + due.length + ' deferred change(s)...');
    for (var i = 0; i < due.length; i++) {
      var row = due[i];
      attempted++;
      var payload = null;
      try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
      if (!payload || !payload.id) {
        // Malformed persisted payload - cannot ever apply -> quarantine.
        await db.$executeRawUnsafe('UPDATE "_deferred_changes" SET "status" = \'QUARANTINED\', "lastError" = ? WHERE "id" = ?', 'malformed payload', row.id);
        quarantined++;
        continue;
      }
      var op = row.operation === 'delete' ? 'delete' : 'update';
      var ok = false, err = null;
      try {
        await db.$transaction(async function(tx) {
          if (op === 'delete') {
            await _deleteLocalRecord(tx, row.model, row.recordId);
            await _tombstoneLocalRecord(tx, row.model, row.recordId);
          } else {
            var existing = await _fetchLocalRecord(tx, row.model, row.recordId);
            var local = _cloudRecordToLocal(payload);
            if (!existing) {
              await _insertLocalRecord(tx, row.model, local);
            } else {
              var cloudMs = _recordTimeMs(local.updatedAt);
              var localMs = _recordTimeMs(existing.updatedAt);
              if (cloudMs >= localMs) await _updateLocalRecord(tx, row.model, local);
            }
          }
        }, { maxWait: 2000, timeout: 15000 });
        ok = true;
      } catch (e) {
        err = e;
      }

      if (ok) {
        await db.$executeRawUnsafe('DELETE FROM "_deferred_changes" WHERE "id" = ?', row.id);
        resolved++;
        emit({ type: 'deferred-resolved', model: row.model, recordId: row.recordId });
      } else if (_isDependencyError(err)) {
        var retryCount = Number(row.retryCount || 0) + 1;
        // Task 43: dependency deferrals used to retry FOREVER (15-min backoff
        // cap) when the parent row no longer exists in the cloud feed (e.g.
        // orphaned child of a branch that was hard-deleted cloud-side). Cap
        // it: after 20 dependency retries (~1 day of backoff), QUARANTINE
        // with an explicit reason instead of spinning + spamming every cycle.
        if (retryCount >= 20) {
          await db.$executeRawUnsafe(
            'UPDATE "_deferred_changes" SET "status" = \'QUARANTINED\', "retryCount" = ?, "lastRetryAt" = ?, "dependencyError" = ? WHERE "id" = ?',
            retryCount, new Date().toISOString(),
            'dependency never resolved after 20 retries — parent row not delivered by the cloud (likely orphaned data whose parent was deleted cloud-side); quarantined to stop infinite retries',
            row.id
          );
          quarantined++;
          console.error('[SyncService] Deferred change QUARANTINED (dependency unresolved after 20 retries — parent never arrives):', row.model + '/' + row.recordId);
          emit({ type: 'deferred-quarantined', model: row.model, recordId: row.recordId, error: 'dependency unresolved after 20 retries' });
          continue;
        }
        var backoffSec = Math.min(15 * 60, 15 * Math.pow(2, Math.min(retryCount, 10)));
        await db.$executeRawUnsafe(
          'UPDATE "_deferred_changes" SET "retryCount" = ?, "lastRetryAt" = ?, "nextRetryAt" = ?, "dependencyError" = ? WHERE "id" = ?',
          retryCount, new Date().toISOString(), new Date(Date.now() + backoffSec * 1000).toISOString(),
          String(err && err.message || '').substring(0, 300), row.id
        );
      } else {
        // Not a dependency problem: schema/validation/data corruption must
        // NEVER masquerade as "deferred" (Part J) - quarantine loudly.
        await db.$executeRawUnsafe(
          'UPDATE "_deferred_changes" SET "status" = \'QUARANTINED\', "retryCount" = "retryCount" + 1, "lastRetryAt" = ?, "lastError" = ? WHERE "id" = ?',
          new Date().toISOString(), String(err && err.message || '').substring(0, 300), row.id
        );
        quarantined++;
        console.error('[SyncService] Deferred change QUARANTINED (non-dependency failure - needs attention):', row.model + '/' + row.recordId, String(err && err.message || '').substring(0, 160));
        emit({ type: 'deferred-quarantined', model: row.model, recordId: row.recordId, error: String(err && err.message || '').substring(0, 200) });
      }
    }
    if (attempted > 0) console.log('[SyncService] Deferred retry pass: ' + resolved + ' resolved, ' + attempted + ' attempted, ' + quarantined + ' quarantined');
  } catch (e) {
    console.warn('[SyncService] Deferred retry pass failed:', e.message);
  }
  return { resolved: resolved, retried: attempted, quarantined: quarantined };
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
async function _applyPullChanges(db, cloudChanges, pageCtx) {
  pageCtx = pageCtx || {};
  var applied = 0;
  var conflictCount = 0;
  var deletedCount = 0;
  var deferred = 0;
  await _ensureDeferredTable(db);

  await db.$transaction(async function(tx) {
    var spCounter = 0;

    var lastApplyError = null;
    async function withSavepoint(fn) {
      var sp = 'sp_pull_' + (++spCounter);
      lastApplyError = null;
      try {
        await tx.$executeRawUnsafe('SAVEPOINT ' + sp);
        await fn();
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT ' + sp);
        return true;
      } catch (e) {
        lastApplyError = e;
        try {
          await tx.$executeRawUnsafe('ROLLBACK TO ' + sp);
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT ' + sp);
        } catch { /* savepoint bookkeeping is best-effort */ }
        console.warn('[SyncService] Record apply failed (deferred, page continues): ' + e.message.substring(0, 160));
        return false;
      }
    }

    /**
     * Part M: persist a failed change DURABLY inside the same transaction as
     * the page apply - the page ledger may then claim the page, because every
     * change is either applied or durably pending in _deferred_changes.
     */
    async function deferChange(modelName, recordId, operation, payload, err) {
      var isDep = _isDependencyError(err);
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO "_deferred_changes" ("id","agencyId","source","sequence","model","recordId","operation","payload","dependencyError","retryCount","firstSeenAt","status","lastError") ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
          crypto.randomUUID(),
          pageCtx.agencyId || '',
          'pull',
          pageCtx.pageLastSequence != null ? pageCtx.pageLastSequence : null,
          modelName,
          recordId,
          operation,
          payload ? JSON.stringify(payload) : null,
          isDep ? String(err && err.message || '').substring(0, 300) : null,
          new Date().toISOString(),
          'PENDING',
          String(err && err.message || '').substring(0, 300)
        );
        if (!isDep) {
          console.error('[SyncService] Non-dependency failure persisted as deferred for review (will quarantine on retry):', modelName + '/' + recordId, String(err && err.message || '').substring(0, 160));
        }
      } catch (deferErr) {
        // The deferred row itself failed to persist - this MUST fail the page
        // (otherwise the change would be silently forgotten, Part M violation).
        throw new Error('Failed to persist deferred change ' + modelName + '/' + recordId + ': ' + deferErr.message + ' (original: ' + (err && err.message || '') + ')');
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

        var local = _cloudRecordToLocal(cloudRecord, modelName);
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
              // Task 46: exclude fallback-fabricated values from the UPDATE —
              // they are create-only (a drifted payload must never reset the
              // user's real category/customCode already stored locally).
              var updatePayload = local;
              var sanitizerModule = _getRecordSanitizer();
              if (sanitizerModule && typeof sanitizerModule.stripFallbackKeys === 'function') {
                updatePayload = sanitizerModule.stripFallbackKeys(local);
              }
              await _updateLocalRecord(tx, table, updatePayload);
            } else {
              await _logConflict(tx, table, local.id, existing.updatedAt, local.updatedAt, existing, local);
              conflictCount++;
              emit({ type: 'sync-conflict', tableName: table, recordId: local.id, resolution: 'local_kept' });
            }
          }
        });
        if (ok) {
          applied++;
        } else {
          deferred++;
          await deferChange(table, cloudRecord.id, existing ? 'update' : 'create', local, lastApplyError);
        }
      }

      var deletedList = modelChanges.deleted || [];
      for (var di = 0; di < deletedList.length; di++) {
        var deleteId = deletedList[di];
        var delOk = await withSavepoint(async function() {
          await _deleteLocalRecord(tx, table, deleteId);
          await _tombstoneLocalRecord(tx, table, deleteId);
        });
        if (delOk) {
          deletedCount++;
        } else {
          deferred++;
          await deferChange(table, deleteId, 'delete', null, lastApplyError);
        }
      }
    }
  }, { maxWait: 5000, timeout: 60000 });

  if (deferred > 0) {
    console.warn('[SyncService] ' + deferred + ' pulled record(s) DURABLY deferred to _deferred_changes (dependency failures) - will re-apply when their parents arrive');
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

      // Crash-safe in-flight marker (boot sweep resets stale rows).
      if (_markMutationSending) await _markMutationSending(mutation.id);

      var idemKey = mutation.idempotency_key
        || (mutation.idempotencyKey)
        || _deriveIdempotencyKeyFallback(method, mutation.path, typeof mutation.body === 'string' ? mutation.body : JSON.stringify(mutation.body || {}));

      var bodyStr = mutation.body === null || mutation.body === undefined
        ? undefined
        : (typeof mutation.body === 'string' ? mutation.body : JSON.stringify(mutation.body));

      // Round-7 compat shim for LEGACY outbox rows: the cloud route schemas
      // require agencyId in the body, but the local routes derive it from the
      // session (local-first), so rows logged before the canonical SYNC_PUSH
      // conversion carry no agencyId and every replay 400'd
      // ("Invalid input: expected string, received undefined ... agencyId").
      // Inject the session agency at REPLAY time. The idempotency key was
      // derived from the RAW body above, so dedup stays stable across retries.
      // (New rows are canonical SYNC_PUSH creates and never need this.)
      try {
        if (
          method === 'POST' &&
          typeof mutation.path === 'string' &&
          mutation.path.indexOf('/api/reservations') === 0 &&
          _userContext && _userContext.agencyId
        ) {
          var legacyBody = bodyStr ? JSON.parse(bodyStr) : {};
          if (legacyBody && typeof legacyBody === 'object' && !Array.isArray(legacyBody) && !legacyBody.agencyId) {
            legacyBody.agencyId = _userContext.agencyId;
            bodyStr = JSON.stringify(legacyBody);
          }
        }
      } catch (shimErr) { /* keep the original body — never block replay on the shim */ }

      try {
        // Part V/W: canonical SYNC_PUSH rows replay through the cloud push
        // protocol as deterministic record-level mutations — never by
        // re-running business actions (whose effect depends on remote state).
        var isCanonicalPush = method === 'SYNC_PUSH';
        var requestUrl = isCanonicalPush
          ? _config.cloudBaseUrl + '/api/sync/push'
          : _config.cloudBaseUrl + mutation.path;
        var requestMethod = isCanonicalPush ? 'POST' : method;
        var requestBodyStr = isCanonicalPush
          ? JSON.stringify({
              protocolVersion: 2,
              mutations: [Object.assign({ mutationId: idemKey }, mutation.body || {})],
            })
          : bodyStr;

        var response = await fetch(requestUrl, {
          method: requestMethod,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + _authToken,
            'X-Idempotency-Key': idemKey,
          },
          body: requestBodyStr,
          signal: AbortSignal.timeout(15000),
        });

        // Canonical push: map the mutation-level result to outbox states (Part W).
        if (isCanonicalPush && response.ok) {
          var pushJson = await response.json().catch(function() { return null; });
          var pushResult = pushJson && Array.isArray(pushJson.results) ? pushJson.results[0] : null;
          var pushStatus = pushResult && pushResult.status;
          if (pushStatus === 'applied' || pushStatus === 'duplicate') {
            await _markMutationCompleted(mutation.id);
            succeeded++;
            _lastPushAt = new Date();
            continue;
          }
          if (pushStatus === 'conflict') {
            await _markMutationConflict(mutation.id, pushResult && pushResult.conflict ? JSON.stringify(pushResult.conflict) : 'conflict');
            failed++;
            continue;
          }
          // rejected / error / retryable_error → classified failure
          var pushErrText = pushResult && pushResult.conflict ? JSON.stringify(pushResult.conflict).substring(0, 200) : 'push mutation failed';
          await _markMutationFailed(mutation.id, 'SYNC_PUSH ' + (pushStatus || 'error') + ': ' + pushErrText, pushStatus === 'error' ? 500 : 400);
          failed++;
          continue;
        }

        if (response.ok) {
          // 2xx (including replayed duplicates) = business effect applied.
          await _markMutationCompleted(mutation.id);
          succeeded++;
          _lastPushAt = new Date();
        } else if (response.status === 401 || response.status === 403) {
          // Task 33-C: the cloud EXPLICITLY rejected the session (NOT an
          // offline condition). Confirm with the refresh-session
          // discriminator: a confirmed revocation locks the workspace and
          // stops the engine; an unreachable cloud keeps the historic pause
          // (offline-first, do NOT burn attempts).
          console.warn('[SyncService] Replay got ' + response.status + ' — cloud rejected the session');
          var authzVerdict = await _handleAuthRejection('replay');
          if (authzVerdict === 'REVOKED') {
            paused = true;
            break;
          }
          emit({ type: 'auth-expired' });
          _lastError = 'auth-rejected (HTTP ' + response.status + ' during replay, not confirmed)';
          paused = true;
          break;
        } else if (response.status === 409) {
          // Cloud: concurrent duplicate in progress — transient, retry with backoff.
          await _markMutationFailed(mutation.id, 'HTTP 409: duplicate in progress', 409);
          failed++;
        } else {
          // Part R/S: classification happens inside markMutationFailed —
          // transient failures retry INDEFINITELY with bounded backoff;
          // permanent ones become visible permanent_failed. No abandonment.
          var errorText = await response.text().catch(() => '');
          await _markMutationFailed(mutation.id, 'HTTP ' + response.status + ': ' + errorText.substring(0, 200), response.status);
          failed++;
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
  // Part AD: the watermark may ONLY advance when EVERY eligible row of EVERY
  // table was processed. Any gather/push failure or interruption keeps the
  // old watermark so nothing is skipped on the next run.
  var allTablesComplete = true;
  var runStartIso = new Date().toISOString();

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

    // Part AD: keyset pagination with a (updatedAt, id) tuple cursor — pages
    // are walked until EXHAUSTED (never a single LIMIT-capped window whose
    // remainder would be skipped by the advancing watermark).
    var lastSeenUpdatedAt = sinceISO;
    var lastSeenId = '';
    var tableComplete = false;
    var tableFailed = false;

    while (!tableComplete && !tableFailed) {
      var rows = [];
      try {
        rows = await db.$queryRawUnsafe(
          'SELECT * FROM "' + table + '" WHERE ' + whereClause +
          ' AND ("updatedAt" > ? OR ("updatedAt" = ? AND "id" > ?)) ' +
          'ORDER BY "updatedAt" ASC, "id" ASC LIMIT ?',
          ...params, lastSeenUpdatedAt, lastSeenUpdatedAt, lastSeenId, MAX_RECONCILE_ROWS_PER_TABLE
        );
      } catch (e) {
        console.warn('[SyncService] Reconcile gather failed for ' + table + ':', e.message);
        allTablesComplete = false;
        break;
      }
      if (!rows || rows.length === 0) {
        tableComplete = true;
        break;
      }

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
        allTablesComplete = false;
        tableFailed = true;
        break; // stop pushing this table; remaining pages retry next run
      }
      // Advance the keyset cursor to the last row of this page.
      var lastRow = rows[rows.length - 1];
      lastSeenUpdatedAt = typeof lastRow.updatedAt === 'string' ? lastRow.updatedAt : new Date(lastRow.updatedAt).toISOString();
      lastSeenId = lastRow.id;
      if (rows.length < MAX_RECONCILE_ROWS_PER_TABLE) {
        tableComplete = true; // page not full = table exhausted
      }
      }
    }
  }

  // Part AD: advance the watermark ONLY when every eligible row was processed.
  if (allTablesComplete) {
    await _setSyncMeta('lastReconcileAt', runStartIso);
    console.log('[SyncService] Reconcile done (complete): pushed ' + pushed + ', conflicts ' + conflicts + ', errors ' + errors);
  } else {
    console.warn('[SyncService] Reconcile INCOMPLETE - watermark NOT advanced (rows remain for the next run): pushed ' + pushed + ', conflicts ' + conflicts + ', errors ' + errors);
  }
  return { pushed: pushed, conflicts: conflicts, errors: errors, complete: allTablesComplete };
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

    // ── Cloud → local realtime relay (local-first, spec §7/§8) ──────────────
    // The desktop UI listens for realtime events on the LOCAL API socket
    // (127.0.0.1:3080), which must work offline. While ONLINE, this cloud
    // socket is the desktop's window into events other clients caused
    // (another branch calling a ticket, a customer joining, etc.) — every
    // event the cloud sends to the agency room this engine joined is
    // re-emitted verbatim into the local agency room by local-realtime.js.
    // 'sync:changes' is skipped: it is the engine's internal pull trigger.
    try {
      var localApiModule = require('./index'); // lazy — avoids the module cycle
      if (localApiModule && typeof localApiModule.relayCloudRealtime === 'function') {
        if (typeof localApiModule.setLocalRealtimeRelayContext === 'function') {
          localApiModule.setLocalRealtimeRelayContext(agencyId || null);
        }
        _socket.onAny(function() {
          try {
            var relayArgs = Array.prototype.slice.call(arguments);
            var relayEvent = relayArgs.shift();
            localApiModule.relayCloudRealtime(relayEvent, relayArgs);
          } catch (relayErr) { /* relay is best-effort — never break the engine */ }
        });
      }
    } catch (relayWireErr) {
      // Local API module not loaded yet (unit tests) — relay stays disabled.
      console.warn('[SyncService] Cloud→local realtime relay not wired (non-fatal):', relayWireErr.message);
    }

    _socket.on('connect', function() {
      try {
        _socketId = _socket.id || null;
        _lastPingAt = Date.now();
        console.log('[SyncService] Realtime socket connected:', _socketId);
        if (agencyId) _socket.emit('join:agency', agencyId);
        // The socket connect is the STRONGEST cloud-reachability signal there
        // is: if the workspace is still NOT_INITIALIZED, wake the initializer
        // immediately (P0 deadlock breaker — no more waiting for a screen).
        ensureWorkspaceInitialized('socket-connected').catch(function (err) {
          console.warn('[SyncService] Init coordinator error (socket connect):', err && err.message);
        });
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

// --- Part D: READY gate -----------------------------------------------------
// The incremental engine MUST NOT pull/apply/replay against an uninitialized
// or partially-initialized agency. Recovery belongs to the initializer
// (initial-sync.js runInitialSync), never to the background engine.

var _agencyReadyCache = { checkedAt: 0, ready: false };
var _readyGateWarnedAt = 0;
var _readyGateDetailLoggedAt = 0;
var _retentionRepairNeeded = false;

async function _isAgencyReady(force) {
  var db = _config && _config.localDb;
  if (!db) return false;
  var now = Date.now();
  if (!force && now - _agencyReadyCache.checkedAt < 5000) return _agencyReadyCache.ready;
  _agencyReadyCache.checkedAt = now;
  _agencyReadyCache.ready = false;
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
  try {
    var state = agencyId
      ? await db.agencyLocalState.findFirst({ where: { agencyId: agencyId }, select: { initializationStatus: true } })
      : await db.agencyLocalState.findFirst({ select: { initializationStatus: true } });
    _agencyReadyCache.ready = !!(state && state.initializationStatus === 'READY');
    // Truthful diagnostics (field round 7): a BLOCKED gate with an
    // unexplained reason is undiscoverable — the workspace WAS READY earlier
    // in the same session. Log WHAT the gate actually saw, rate-limited so
    // offline retries don't spam.
    if (!_agencyReadyCache.ready && now - (_readyGateDetailLoggedAt || 0) > 60000) {
      _readyGateDetailLoggedAt = now;
      if (!state) {
        console.warn('[SyncService] READY gate detail: NO AgencyLocalState row for agency ' + (agencyId || '(none)') + ' — the initializer must create it (checkInitialSyncStatus/_getOrCreateLocalState)');
      } else {
        console.warn('[SyncService] READY gate detail: AgencyLocalState for agency ' + (agencyId || '(none)') + ' has initializationStatus=' + state.initializationStatus + ' (expected READY)');
      }
    }
  } catch (e) {
    if (now - (_readyGateDetailLoggedAt || 0) > 60000) {
      _readyGateDetailLoggedAt = now;
      console.warn('[SyncService] READY check failed:', e.message);
    }
  }
  return _agencyReadyCache.ready;
}

async function _preCheck() {
  if (_isSyncing) return false;
  if (!_authToken) return false;
  if (!_config || !_config.localDb) return false;
  // Task 33-C: a confirmed revocation LOCKS the workspace — no pull/push/
  // replay until a fresh login proves authorization again. Rate-limited log
  // (the engine timer keeps firing while locked).
  if (_authzStatus === 'REVOKED') {
    if (Date.now() - _authzBlockedWarnedAt > 60000) {
      _authzBlockedWarnedAt = Date.now();
      console.warn('[SyncService] Pull/replay BLOCKED — authorization REVOKED (' + (_authzReason || 'unknown') + '). Re-login required; local data is kept for recovery/audit.');
    }
    return false;
  }
  // Part D: block pull/replay unless AgencyLocalState.initializationStatus == READY.
  if (!(await _isAgencyReady())) {
    if (Date.now() - _readyGateWarnedAt > 60000) {
      _readyGateWarnedAt = Date.now();
      console.warn('[SyncService] Pull/replay BLOCKED - AgencyLocalState is not READY yet (initial sync pending). The initializer owns recovery — waking it if the cloud is reachable.');
    }
    // P0 deadlock breaker: every gate block is also a chance to start the
    // initializer (rate-limited + single-flight inside the coordinator).
    ensureWorkspaceInitialized('gate-blocked').catch(function (err) {
      console.warn('[SyncService] Init coordinator error (gate):', err && err.message);
    });
    return false;
  }
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

  var replayResult = { succeeded: 0, failed: 0 };
  var pullResult = { applied: 0, conflicts: 0, deleted: 0, pages: 0 };
  var deferredResult = null;
  try {
    await _checkAndResetForNewAgency();
    try {
      replayResult = await _replayPendingMutations();
      // Task 33-C: the replay may have confirmed a revocation (401/403 →
      // refresh rejected). The workspace is locked and the engine stopped —
      // skip the pull and leave WITHOUT a backoff retry.
      if (_authzStatus === 'REVOKED') {
        _lastError = 'authorization-revoked';
        return { revoked: true };
      }
      pullResult = await _pullFromCloud();
    } finally {
      // Part K invariant (spec Part M): every change up to the cursor must be
      // APPLIED, durably DEFERRED, or QUARANTINED. Deferred records are
      // re-applied LOCALLY (no network involved), so the retry pass runs even
      // when the pull itself failed — parents may have landed on a previous
      // cycle and waiting a full interval adds nothing.
      try {
        deferredResult = await _retryDeferredChanges();
      } catch (deferredErr) {
        console.warn('[SyncService] Deferred retry pass error (non-fatal):', deferredErr.message);
      }
    }

    // Part AB: a cursor older than the feed retention horizon is repaired by
    // a full snapshot reconciliation (record-diff push + pull-from-0 LWW).
    if (_retentionRepairNeeded) {
      _retentionRepairNeeded = false;
      console.log('[SyncService] Running full snapshot reconciliation (retention repair, Part AB)');
      await reconcileRecords();
      await _pullFromCloud({ fullSync: true });
    }
    _resetBackoff();

    emit({
      type: 'sync-complete',
      stats: {
        pulled: pullResult.applied,
        replayed: replayResult.succeeded,
        replayFailed: replayResult.failed,
        deleted: pullResult.deleted,
        conflicts: pullResult.conflicts,
        deferredResolved: deferredResult ? deferredResult.resolved : 0,
      },
    });
  } catch (err) {
    // Task 33-C: classify BEFORE backing off — an explicit cloud rejection
    // (401/403) is NEVER "offline". Confirm via the refresh discriminator;
    // only a CONFIRMED rejection locks the workspace (and stops the cycle).
    var cloudClass = classifyCloudError(err);
    if (cloudClass === 'AUTH_REJECTED') {
      var authzVerdict = await _handleAuthRejection('pull');
      if (authzVerdict === 'REVOKED') {
        _lastError = 'authorization-revoked';
        return { revoked: true }; // STOP — no backoff retries while locked
      }
      // OFFLINE (cloud flapped between calls) or RESTORED (token re-issued,
      // the next cycle succeeds with the adopted token) → normal handling.
    }
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
    // Task 33-C: same classification contract as the incremental cycle —
    // an explicit 401/403 must be CONFIRMED (refresh discriminator) before
    // it may lock the workspace; network failures never revoke.
    var cloudClass = classifyCloudError(err);
    if (cloudClass === 'AUTH_REJECTED') {
      var authzVerdict = await _handleAuthRejection('full-reconcile');
      if (authzVerdict === 'REVOKED') {
        _lastError = 'authorization-revoked';
        return { revoked: true }; // STOP — no backoff retries while locked
      }
    }
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

  // Task 33-C: hydrate the persisted authorization state so a REVOKED
  // workspace stays locked across restarts (the lock lives in _sync_meta,
  // NOT in memory only).
  try {
    var storedAuthz = await _getSyncMeta('authorization_status');
    if (storedAuthz === 'REVOKED' || storedAuthz === 'AUTHORIZED') {
      _authzStatus = storedAuthz;
    }
    var storedRevokedAt = await _getSyncMeta('authorization_revoked_at');
    if (storedRevokedAt) _authzRevokedAt = storedRevokedAt;
    var storedAuthzReason = await _getSyncMeta('authorization_reason');
    if (storedAuthzReason) _authzReason = storedAuthzReason;
    if (_authzStatus === 'REVOKED') {
      console.warn('[SyncService] Persisted authorization status is REVOKED (' + (_authzReason || 'unknown') + ') — workspace stays locked until a fresh login');
    }
  } catch (authzErr) {
    console.warn('[SyncService] Could not hydrate authorization status:', authzErr.message);
  }

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
 *
 * `meta` (optional) tags the adoption with its source for the audit trail —
 * every cursor rewrite outside the pull cycle must be attributable.
 */
async function setInitialCursor(sequence, meta) {
  var seq = parseInt(sequence, 10);
  if (isNaN(seq) || seq < 0) seq = 0;
  var prev = _cursor;
  await _setCursor(seq);
  console.log('[SyncService] Initial cursor set to ' + seq +
    (meta && meta.source ? ' (source: ' + meta.source + (prev ? ', previous: ' + prev : '') + ')' : ''));
  try {
    await _setSyncMeta('lastCursorAdoption', JSON.stringify({
      from: prev || null,
      to: seq,
      source: (meta && meta.source) || 'unspecified',
      snapshotSequence: (meta && meta.snapshotSequence) != null ? meta.snapshotSequence : null,
      bridgeFinalSequence: (meta && meta.bridgeFinalSequence) != null ? meta.bridgeFinalSequence : null,
      at: new Date().toISOString(),
    }));
  } catch { /* audit is best-effort */ }
}

/**
 * CURSOR INVARIANT (Part M reinforcement, field round 6):
 * Adopt the cursor produced by the initial import — preferring the BRIDGE's
 * final sequence (every change > snapshotSequence was pulled and applied
 * through the ledger) over the raw snapshotSequence.
 *
 * Proves and logs the full chain:
 *   snapshot S → bridge pages → final F (≥ S) → engine cursor = F.
 * "final cursor means: every change up to this sequence is durably
 *  accounted for" — never a value that silently jumped over changes.
 *
 * @returns {number} the adopted sequence.
 */
async function adoptInitialSyncCursor(result, source) {
  result = result || {};
  var snapshot = parseInt(result.snapshotSequence, 10);
  if (isNaN(snapshot) || snapshot < 0) snapshot = 0;
  var bridge = parseInt(result.bridgeFinalSequence, 10);
  if (isNaN(bridge) || bridge < snapshot) bridge = snapshot; // defensive: feed may never go backward
  var prev = _cursor || (await _getCursor());
  await setInitialCursor(bridge, {
    source: (source || 'initial-sync') + ':bridge-adoption',
    snapshotSequence: result.snapshotSequence != null ? snapshot : null,
    bridgeFinalSequence: result.bridgeFinalSequence != null ? bridge : null,
  });
  console.log('[SyncService] Cursor invariant: snapshot=' + snapshot + ' → bridge final=' + bridge +
    ' → engine cursor=' + bridge + ' (every change ≤ ' + bridge + ' is ledger-accounted; previous cursor=' + (prev || 0) +
    (prev > bridge ? ' — REWIND of a stale over-advanced cursor; re-apply is idempotent' : '') + ')');
  return bridge;
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
    // Task 33-C: authorization (workspace lock) state
    authorizationStatus: _authzStatus || null,
    authorizationRevokedAt: _authzRevokedAt || null,
    authorizationReason: _authzReason || null,
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
  // Task 33-C: a session being set is treated as authorized UNLESS the
  // workspace is locked — a REVOKED status can only be cleared by an
  // explicit fresh-proof signal (markAuthorizationAuthorized from the local
  // API after a REAL cloud login, or a refresh 200 in _confirmRevocation),
  // never by re-arming a stale token behind the engine's back.
  if (_authzStatus !== 'REVOKED') {
    _authzStatus = 'AUTHORIZED';
    _setSyncMeta('authorization_status', 'AUTHORIZED').catch(function () { });
  } else {
    console.warn('[SyncService] setAuth: workspace authorization is REVOKED — engine stays locked (fresh cloud login required)');
  }
  // ── Agency REBIND (was: only fill an EMPTY pin) ──────────────────────────
  // The engine used to pin `_config.agencyId` once at startSync (often to a
  // demo/previous-workspace agency) and setAuth never replaced it. Every
  // incremental pull then kept POSTing the OLD agencyId while the fresh
  // token belonged to a NEW account/agency → the cloud answered
  // 403 "You do not have access to this agency" on every cycle and the
  // socket joined the wrong agency room (rejected). New-agency data never
  // arrived, so profile/settings/QR rendered empty after re-login.
  // Now: when the incoming session carries a DIFFERENT agencyId, rebind the
  // engine to it. The cursor reset is NOT done here — the sync cycle's
  // _checkAndResetForNewAgency() detects the switch via the
  // lastSyncAgencyId meta and rewinds the cursor for a full pull of the new
  // agency (an inline reset here would race the cursor-bridge hydration).
  var incomingAgency = userContext && userContext.agencyId;
  if (_config && incomingAgency && _config.agencyId !== incomingAgency) {
    var previousAgency = _config.agencyId || null;
    _config.agencyId = incomingAgency;
    console.log('[SyncService] Agency rebind: ' + (previousAgency || 'none') + ' -> ' + incomingAgency + ' (cycle will reset the cursor for a full pull)');
  }
  console.log('[SyncService] Auth set - user: ' + (userContext && userContext.id) + ', role: ' + (userContext && userContext.role) + ', agency: ' + (userContext && userContext.agencyId || 'none'));

  // (Re)initialize the realtime socket with the fresh token.
  if (_isStarted && _config?.cloudBaseUrl) {
    _setupSocket();
  }

  // Trigger a cycle shortly after auth is set (post-login replay + pull).
  if (_isStarted && token) {
    setTimeout(function() {
      // P0: auth arrival is itself a wakeup for the initializer — when the
      // workspace is NOT_INITIALIZED and the cloud hosts the sync API, the
      // import starts here instead of waiting for a screen or a login form.
      ensureWorkspaceInitialized('post-auth').catch(function (err) {
        console.error('[SyncService] Post-auth init error:', err.message);
      });
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
  // Task 33-C: deliberately do NOT touch _authzStatus here — a REVOKED lock
  // must survive logout/clear (it only clears via fresh-proof signals).
  console.log('[SyncService] Auth cleared');
}

/**
 * Task 33-C: fresh proof of authorization (a REAL cloud login succeeded and
 * the local API confirmed it). Clears the workspace lock — both the in-memory
 * cache and the persisted meta. Called by local-api/index.js
 * markAuthorizationAuthorized() (login path 3 / main.js cloud-sync:set-auth).
 * Returns true when a REVOKED lock was actually lifted (restore logging).
 */
function markAuthorizationAuthorized() {
  var wasRevoked = _authzStatus === 'REVOKED';
  _authzStatus = 'AUTHORIZED';
  _authzRevokedAt = null;
  _authzReason = null;
  _setSyncMeta('authorization_status', 'AUTHORIZED').catch(function () { });
  if (wasRevoked) {
    console.log('[SyncService] Authorization restored — workspace unlocked (fresh session accepted)');
  }
  return wasRevoked;
}

/**
 * Task 33-C: mark the workspace REVOKED from the local-API side (import-time
 * cloud rejection). Keeps the sync-service cache in lockstep with the
 * _sync_meta keys written by revokeLocalAuthorization().
 */
function markAuthorizationRevoked(reason) {
  if (_authzStatus !== 'REVOKED') {
    _authzStatus = 'REVOKED';
    _authzRevokedAt = new Date().toISOString();
    _authzReason = reason || 'token-rejected';
    _setSyncMeta('authorization_status', 'REVOKED').catch(function () { });
  }
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
  adoptInitialSyncCursor: adoptInitialSyncCursor,
  reconcileRecords: reconcileRecords,
  // offline-first spec additions (Parts D/K/L/AB/AD/AE)
  isAgencyReady: function() { return _isAgencyReady(true); },
  applyPullChanges: function(db, cloudChanges, pageCtx) { return _applyPullChanges(db, cloudChanges, pageCtx); },
  retryDeferredChanges: function() { return _retryDeferredChanges(); },
  // P0 deadlock breaker: wakes the initializer when NOT_INITIALIZED + cloud reachable
  ensureWorkspaceInitialized: ensureWorkspaceInitialized,
  probeCloudSyncRoutes: function() { return _probeCloudSyncRoutes(); },
  // Task 33-C: authorization (workspace lock) surface
  classifyCloudError: classifyCloudError,
  markAuthorizationAuthorized: markAuthorizationAuthorized,
  markAuthorizationRevoked: markAuthorizationRevoked,
  getAuthorizationStatus: function () { return _authzStatus; },
};
