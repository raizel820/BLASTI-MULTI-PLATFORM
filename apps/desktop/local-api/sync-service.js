/**
 * BLASTI Desktop — Background Sync Service
 *
 * Incremental, version-based sync between local SQLite and cloud API.
 * Runs in the Electron main process.
 *
 * Architecture:
 *   Local SQLite ──sync-service.js──► Cloud API (when online)
 *                                       │
 *                                       ▼
 *                                 Version-based conflict resolution
 *                                 Only agent data synced
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const SYNC_TABLES = [
  'Agency',
  'Service',
  'Branch',
  'Counter',
  'Reservation',
  'Notification',
  'QueueSettings',
  'AgencyStaff',
  'Review',
  'User',
  'SmsSettings',
  'PaymentSettings',
  'Announcement',
  'GlobalAnnouncement',
  'Transaction',
  'SubscriptionPlan',
  'PlanFeature',
  'Favorite',
  'FAQ',
];

const AGENCY_SCOPED_TABLES = new Set([
  'Agency',
  'Service',
  'Branch',
  'Reservation',
  'QueueSettings',
  'AgencyStaff',
  'Review',
  'SmsSettings',
  'PaymentSettings',
  'Announcement',
  'Transaction',
  'SubscriptionPlan',
  'PlanFeature',
  'Favorite',
  'FAQ',
]);

const DATE_FIELDS = new Set([
  'joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'noShowAt',
  'pausedAt', 'createdAt', 'updatedAt', 'openedAt', 'repliedAt',
  'reviewedAt', 'lastRoleChangeAt', 'gracePeriodEndsAt',
  'subscriptionStartsAt', 'subscriptionExpiresAt', 'reminderSentAt',
  'smsReminderSentAt', 'skippedAt', 'reclaimRequestedAt', 'qrClaimedAt',
  'offlineCreatedAt', 'lastActiveAt', 'resolvedAt',
  'sentAt', 'scheduledAt', 'expiresAt', 'startsAt',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_SYNC_INTERVAL_MS = 120_000;
const DEFAULT_INITIAL_DELAY_MS = 3_000;
const TOMBSTONE_CLEANUP_DAYS = 30;
const TOMBSTONE_CLEANUP_MS = TOMBSTONE_CLEANUP_DAYS * 24 * 60 * 60 * 1000;
const MAX_SYNC_LOG_ENTRIES = 100;
const SYNC_PROTOCOL_VERSION = 2;
const CURSOR_PULL_LIMIT = 500;

// ─── Per-Model Sync Priority ──────────────────────────────────────────────────
// High-frequency: synced every cycle
const HIGH_FREQUENCY_MODELS = new Set(['Reservation', 'QueueSettings', 'Counter']);
// Normal-frequency: synced every cycle
const NORMAL_FREQUENCY_MODELS = new Set(['Service', 'Branch', 'AgencyStaff', 'Notification']);
// Low-frequency: synced every 3rd cycle
const LOW_FREQUENCY_MODELS = new Set(['Agency', 'SmsSettings', 'PaymentSettings', 'Announcement']);

// ─── Conflict Resolution Categories ─────────────────────────────────────────
// Queue operational state: CLOUD WINS (server authority during active sync)
const CLOUD_WINS_MODELS = new Set([
  'Reservation',   // WAITING/CALLED/COMPLETED — server is source of truth
  'Transaction',   // financial data — never overwrite locally
  'SubscriptionPlan',
  'PlanFeature',
  'PaymentSettings',
]);

// Agency profile/settings: LAST-WRITE-WINS based on updatedAt
const LAST_WRITE_WINS_MODELS = new Set([
  'Agency',
  'QueueSettings',
  'SmsSettings',
  'Announcement',
  'GlobalAnnouncement',
  'FAQ',
]);

// Reservation statuses that indicate active queue operations
const ACTIVE_QUEUE_STATUSES = new Set(['WAITING', 'CALLED', 'COMPLETED']);

// ─── State ────────────────────────────────────────────────────────────────────

let _config = null;
let _authToken = null;
let _userContext = null;
let _syncIntervalId = null;
let _initialTimeoutId = null;
let _onlineListener = null;
let _isSyncing = false;
let _isStarted = false;
let _lastError = null;
let _backoffMs = 2000;
let _consecutiveFailures = 0;
let _lastSyncAt = null;
let _listeners = new Set();
let _syncCycleCount = 0;

// ─── Sync Metrics ─────────────────────────────────────────────────────────────
let _syncMetrics = {
  lastPullAt: null,
  lastPushAt: null,
  pullDuration: 0,
  pushDuration: 0,
  recordsPulled: 0,
  recordsPushed: 0,
  conflictsDetected: 0,
  mutationsPushed: 0,
  mutationsFailed: 0,
};

// ─── Per-Model Sync State ─────────────────────────────────────────────────────
// Key: modelName, Value: { lastSyncTimestamp, lastSyncVersion, failedAt }
let _perModelSyncState = {};

// ─── Sync Log (ring buffer) ──────────────────────────────────────────────────
let _syncLog = [];

// ─── Pending Mutations (Write-Ahead Log) ─────────────────────────────────────

let _getPendingMutations = null;
let _markMutationCompleted = null;
let _markMutationFailed = null;

function _loadMutationFunctions() {
  try {
    const localApi = require('./index');
    _getPendingMutations = localApi.getPendingMutations;
    _markMutationCompleted = localApi.markMutationCompleted;
    _markMutationFailed = localApi.markMutationFailed;
  } catch (e) {
    console.warn('[SyncService] Could not load mutation functions:', e.message);
  }
}

// Load mutation functions on first require
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
  'fixedTimeEnabled',
]);

function _isBooleanField(key) {
  return key.startsWith('is') || key.endsWith('Enabled') || BOOLEAN_FIELDS.has(key);
}

function _cloudRecordToLocal(record) {
  const result = { id: record.id };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    if (DATE_FIELDS.has(key) && typeof value === 'string' && ISO_DATE_RE.test(value)) {
      // Keep as ISO string — Prisma stores DateTime as TEXT in SQLite
      result[key] = value;
    } else if (DATE_FIELDS.has(key) && value instanceof Date) {
      // Cloud may return Date objects — convert to ISO string
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

function _localRecordToCloud(record) {
  const result = { id: record.id };
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    if (DATE_FIELDS.has(key) && typeof value === 'number') {
      result[key] = new Date(value).toISOString();
    } else if (_isBooleanField(key) && (value === 0 || value === 1)) {
      result[key] = value === 1;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Sync Meta ─────────────────────────────────────────────────────────────

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

async function _getLastSyncVersion() {
  var v = await _getSyncMeta('_lastSyncVersion');
  return v ? parseInt(v, 10) : 0;
}
async function _setLastSyncVersion(v) { await _setSyncMeta('_lastSyncVersion', v); }
async function _getLastPushedVersion() {
  var v = await _getSyncMeta('_lastPushedVersion');
  return v ? parseInt(v, 10) : 0;
}
async function _setLastPushedVersion(v) { await _setSyncMeta('_lastPushedVersion', v); }
async function _getLastSyncTimestamp() {
  var v = await _getSyncMeta('_lastSyncTimestamp');
  return v ? parseInt(v, 10) : 0;
}
async function _setLastSyncTimestamp(v) { await _setSyncMeta('_lastSyncTimestamp', v); }
async function _getLastSyncAgencyId() { return await _getSyncMeta('_lastSyncAgencyId'); }
async function _setLastSyncAgencyId(id) { await _setSyncMeta('_lastSyncAgencyId', id); }
async function _getLastPulledSequence() {
  var v = await _getSyncMeta('_lastPulledSequence');
  return v ? parseInt(v, 10) : 0;
}
async function _setLastPulledSequence(v) { await _setSyncMeta('_lastPulledSequence', v); }

// ─── Conflicts Table ──────────────────────────────────────────────────────────

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
      '"localVersion" INTEGER,' +
      '"cloudVersion" INTEGER,' +
      '"localData" TEXT,' +
      '"cloudData" TEXT,' +
      '"resolution" TEXT NOT NULL DEFAULT \'pending\',' +
      '"resolvedAt" INTEGER,' +
      '"createdAt" INTEGER NOT NULL' +
      ')'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_model" ON "_sync_conflicts"("modelName")'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_resolution" ON "_sync_conflicts"("resolution")'
    );
    // Migration: Add agencyId column if upgrading from old schema (pre-agency-isolation)
    // Use column-existence check to avoid Prisma logging "duplicate column name" error
    try {
      const cols = await db.$queryRawUnsafe('PRAGMA table_info("_sync_conflicts")');
      const hasAgencyId = cols.some(c => c.name === 'agencyId');
      if (!hasAgencyId) {
        await db.$executeRawUnsafe('ALTER TABLE "_sync_conflicts" ADD COLUMN "agencyId" TEXT NOT NULL DEFAULT \'\'');
      }
    } catch (e) { /* table may not exist yet or other harmless error */ }
  } catch (e) {
    console.error('[SyncService] Failed to create _sync_conflicts table:', e.message);
  }
}

let _conflictCounter = 0;
function _generateConflictId() {
  _conflictCounter++;
  return 'conflict_' + Date.now().toString(36) + '_' + _conflictCounter;
}

async function _logConflict(db, modelName, recordId, localVersion, cloudVersion, localData, cloudData) {
  if (!db) return null;
  var id = _generateConflictId();
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_conflicts" (id, modelName, recordId, localVersion, cloudVersion, localData, cloudData, resolution, createdAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, modelName, recordId,
      localVersion || null, cloudVersion || null,
      localData ? JSON.stringify(localData) : null,
      cloudData ? JSON.stringify(cloudData) : null,
      'pending',
      Date.now()
    );
    console.log('[SyncService] Conflict logged: ' + id + ' for ' + modelName + '/' + recordId);
  } catch (e) {
    console.error('[SyncService] Failed to log conflict:', e.message);
  }
  return id;
}

// ─── Conflict Resolution Strategy ────────────────────────────────────────────

/**
 * Determine conflict resolution strategy for a given model/record.
 * Returns: 'cloud_wins' | 'local_wins' | 'last_write_wins'
 */
function _resolveConflictStrategy(modelName, localRecord, cloudRecord) {
  // Queue operational state (Reservation with active status): CLOUD WINS
  if (modelName === 'Reservation') {
    var status = (cloudRecord && cloudRecord.status) || (localRecord && localRecord.status);
    if (ACTIVE_QUEUE_STATUSES.has(status)) {
      return 'cloud_wins';
    }
    // Non-active reservations: last-write-wins
    return 'last_write_wins';
  }

  // Financial/transaction data: CLOUD WINS (never overwrite)
  if (CLOUD_WINS_MODELS.has(modelName)) {
    return 'cloud_wins';
  }

  // Agency profile/settings: LAST-WRITE-WINS based on updatedAt
  if (LAST_WRITE_WINS_MODELS.has(modelName)) {
    return 'last_write_wins';
  }

  // Default: cloud wins for all other models
  return 'cloud_wins';
}

/**
 * Apply conflict resolution. Returns 'cloud' or 'local' indicating which version wins.
 */
function _applyConflictResolution(modelName, localRecord, cloudRecord) {
  var strategy = _resolveConflictStrategy(modelName, localRecord, cloudRecord);
  if (strategy === 'cloud_wins') return 'cloud';
  if (strategy === 'local_wins') return 'local';
  if (strategy === 'last_write_wins') {
    var localTs = (localRecord && localRecord.updatedAt) ? new Date(localRecord.updatedAt).getTime() : 0;
    var cloudTs = (cloudRecord && cloudRecord.updatedAt) ? new Date(cloudRecord.updatedAt).getTime() : 0;
    return cloudTs >= localTs ? 'cloud' : 'local';
  }
  return 'cloud'; // safe default
}

// ─── Tombstone Helpers ───────────────────────────────────────────────────────

async function _ensureTombstonesTable(db) {
  if (!db) return;
  try {
    await db.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS "_sync_tombstones" (' +
      '"id" TEXT PRIMARY KEY,' +
      '"modelName" TEXT NOT NULL,' +
      '"recordId" TEXT NOT NULL,' +
      '"agencyId" TEXT NOT NULL,' +
      '"syncSequence" INTEGER NOT NULL DEFAULT 0,' +
      '"createdAt" INTEGER NOT NULL' +
      ')'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_tombstones_model" ON "_sync_tombstones"("modelName")'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_tombstones_record" ON "_sync_tombstones"("modelName", "recordId")'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_tombstones_created" ON "_sync_tombstones"("createdAt")'
    );
    // Migration: Add syncSequence column if upgrading from old schema (pre-cursor-sync)
    // Use column-existence check to avoid Prisma logging "duplicate column name" error
    try {
      const cols = await db.$queryRawUnsafe('PRAGMA table_info("_sync_tombstones")');
      const hasSyncSequence = cols.some(c => c.name === 'syncSequence');
      if (!hasSyncSequence) {
        await db.$executeRawUnsafe('ALTER TABLE "_sync_tombstones" ADD COLUMN "syncSequence" INTEGER NOT NULL DEFAULT 0');
      }
    } catch (e) { /* table may not exist yet or other harmless error */ }
  } catch (e) {
    console.error('[SyncService] Failed to create _sync_tombstones table:', e.message);
  }
}

let _tombstoneCounter = 0;
async function _writeTombstone(db, modelName, recordId, agencyId, syncSequence) {
  if (!db) return;
  _tombstoneCounter++;
  var id = 'tomb_' + Date.now().toString(36) + '_' + _tombstoneCounter;
  syncSequence = syncSequence || 0;
  try {
    await db.$executeRawUnsafe(
      'INSERT OR IGNORE INTO "_sync_tombstones" (id, modelName, recordId, agencyId, syncSequence, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      id, modelName, recordId, agencyId, syncSequence, Date.now()
    );
  } catch (e) {
    console.error('[SyncService] Failed to write tombstone:', e.message);
  }
}

async function _hasTombstone(db, modelName, recordId) {
  if (!db) return false;
  try {
    var rows = await db.$queryRawUnsafe(
      'SELECT id FROM "_sync_tombstones" WHERE modelName = ? AND recordId = ? LIMIT 1',
      modelName, recordId
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Returns the syncSequence of the tombstone for a given model/record,
 * or -1 if no tombstone exists. Used for resurrection protection.
 */
async function _getTombstoneSequence(db, modelName, recordId) {
  if (!db) return -1;
  try {
    var rows = await db.$queryRawUnsafe(
      'SELECT syncSequence FROM "_sync_tombstones" WHERE modelName = ? AND recordId = ? LIMIT 1',
      modelName, recordId
    );
    if (rows.length > 0) return rows[0].syncSequence || 0;
    return -1;
  } catch (e) {
    return -1;
  }
}

/**
 * Remove a tombstone (when a record is resurrected by a newer sequence).
 */
async function _removeTombstone(db, modelName, recordId) {
  if (!db) return;
  try {
    await db.$executeRawUnsafe(
      'DELETE FROM "_sync_tombstones" WHERE modelName = ? AND recordId = ?',
      modelName, recordId
    );
  } catch (e) {
    console.error('[SyncService] Failed to remove tombstone:', e.message);
  }
}

async function _cleanupTombstones(db) {
  if (!db) return 0;
  var cutoff = Date.now() - TOMBSTONE_CLEANUP_MS;
  try {
    var result = await db.$executeRawUnsafe(
      'DELETE FROM "_sync_tombstones" WHERE "createdAt" < ?',
      cutoff
    );
    if (result > 0) {
      console.log('[SyncService] Cleaned up ' + result + ' tombstones older than ' + TOMBSTONE_CLEANUP_DAYS + ' days');
    }
    return result;
  } catch (e) {
    console.error('[SyncService] Tombstone cleanup error:', e.message);
    return 0;
  }
}

// ─── Agency Validation ────────────────────────────────────────────────────────

function _validateAgencyId(agencyId) {
  if (!agencyId || typeof agencyId !== 'string' || agencyId.trim() === '') {
    throw new Error('Invalid or missing agencyId — sync aborted for agency isolation');
  }
  return agencyId;
}

function _getCurrentAgencyId() {
  var id = (_config && _config.agencyId) || (_userContext && _userContext.agencyId);
  return _validateAgencyId(id);
}

// ─── Per-Model Sync State ─────────────────────────────────────────────────────

async function _getPerModelSyncTimestamp(modelName) {
  var db = _config?.localDb;
  if (!db) return 0;
  var v = await _getSyncMeta('_perModel_' + modelName + '_timestamp');
  return v ? parseInt(v, 10) : 0;
}

async function _setPerModelSyncTimestamp(modelName, timestamp) {
  await _setSyncMeta('_perModel_' + modelName + '_timestamp', timestamp);
}

// ─── Sync Log ─────────────────────────────────────────────────────────────────

function _addSyncLogEntry(entry) {
  entry.timestamp = Date.now();
  _syncLog.push(entry);
  if (_syncLog.length > MAX_SYNC_LOG_ENTRIES) {
    _syncLog = _syncLog.slice(-MAX_SYNC_LOG_ENTRIES);
  }
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

async function _cloudPost(path, body, options) {
  options = options || {};
  const baseUrl = _config.cloudBaseUrl;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + _authToken,
    'X-Sync-Protocol-Version': String(SYNC_PROTOCOL_VERSION),
  };
  // Idempotency: include X-Idempotency-Key header if provided
  if (options.idempotencyKey) {
    headers['X-Idempotency-Key'] = options.idempotencyKey;
  }
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeout || 15000),
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

// ─── Apply Pull Change (with resurrection protection) ─────────────────────────

/**
 * Apply a single pull change (create/update/delete) from the cloud.
 * Handles tombstone-based resurrection protection:
 *   - For deletes: writes tombstone with syncSequence, removes local record
 *   - For creates/updates: checks tombstone sequence; skips if tombstone >= change sequence,
 *     removes tombstone + applies if change sequence > tombstone sequence (resurrection)
 *
 * Returns: { applied: bool, conflict: bool, deleted: bool, skippedByTombstone: bool }
 */
async function _applyPullChange(tx, modelName, change, agencyId) {
  var table = modelName;
  var operation = change.operation; // 'create' | 'update' | 'delete'
  var sequence = change.sequence || 0;
  var recordId = change.recordId || (change.data && change.data.id);
  var result = { applied: false, conflict: false, deleted: false, skippedByTombstone: false };

  if (operation === 'delete') {
    // Write tombstone with syncSequence, then delete local record
    await _writeTombstone(tx, modelName, recordId, agencyId, sequence);
    await _deleteLocalRecord(tx, table, recordId);
    result.deleted = true;
    result.applied = true;
    return result;
  }

  // create or update
  var cloudRecord = change.data;
  if (!cloudRecord || !cloudRecord.id) {
    console.warn('[SyncService] _applyPullChange: skipping change with missing data for ' + modelName + '/' + recordId);
    return result;
  }
  var local = _cloudRecordToLocal(cloudRecord);

  // Resurrection protection: check if tombstone exists for this record
  var tombstoneSequence = await _getTombstoneSequence(tx, modelName, local.id);
  if (tombstoneSequence >= 0) {
    if (tombstoneSequence >= sequence) {
      // Tombstone is at same or higher sequence — record stays deleted
      result.skippedByTombstone = true;
      return result;
    } else {
      // Change sequence > tombstone sequence — record was resurrected on cloud
      await _removeTombstone(tx, modelName, local.id);
      console.log('[SyncService] Record resurrected: ' + modelName + '/' + local.id + ' (tombstone seq ' + tombstoneSequence + ' < change seq ' + sequence + ')');
    }
  }

  var existing = await _fetchLocalRecord(tx, table, local.id);
  if (!existing) {
    await _insertLocalRecord(tx, table, local);
    result.applied = true;
    return result;
  }

  // Check if local was modified since last sync (syncVersion comparison)
  var localSyncVersion = existing.syncVersion || 0;
  var cloudSyncVersion = local.syncVersion || 0;
  var localModifiedSinceSync = localSyncVersion > 0 && existing.updatedAt && existing.syncVersion !== cloudSyncVersion;

  if (localModifiedSinceSync) {
    // CONFLICT: both local and cloud were modified
    var winner = _applyConflictResolution(modelName, existing, local);
    await _logConflict(tx, modelName, local.id, existing.updatedAt, local.updatedAt, existing, local);
    result.conflict = true;
    if (winner === 'cloud') {
      await _updateLocalRecord(tx, table, local);
      result.applied = true;
      emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'cloud_applied' });
    } else {
      emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'local_kept' });
    }
  } else if (!existing.updatedAt || String(existing.updatedAt) <= String(local.updatedAt)) {
    await _updateLocalRecord(tx, table, local);
    result.applied = true;
  } else {
    // Local is newer — apply conflict resolution
    var winner = _applyConflictResolution(modelName, existing, local);
    await _logConflict(tx, modelName, local.id, existing.updatedAt, local.updatedAt, existing, local);
    result.conflict = true;
    if (winner === 'cloud') {
      await _updateLocalRecord(tx, table, local);
      result.applied = true;
      emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'cloud_applied' });
    } else {
      emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'local_kept' });
    }
  }

  return result;
}

// ─── Per-Model Sync Priority Filter ────────────────────────────────────────────

/**
 * Returns true if the given model should be synced in the current cycle
 * based on its priority group and the current cycle count.
 */
function _shouldSyncModel(modelName) {
  if (HIGH_FREQUENCY_MODELS.has(modelName) || NORMAL_FREQUENCY_MODELS.has(modelName)) {
    return true;
  }
  if (LOW_FREQUENCY_MODELS.has(modelName)) {
    return (_syncCycleCount % 3) === 0;
  }
  // Unknown models: sync every cycle (safe default)
  return true;
}

// ─── Pull Cycle ───────────────────────────────────────────────────────────────

async function _pullFromCloud() {
  var db = _config.localDb;
  var agencyId;
  try {
    agencyId = _getCurrentAgencyId();
  } catch (e) {
    console.warn('[SyncService] Pull skipped: ' + e.message);
    return { applied: 0, conflicts: 0, deleted: 0 };
  }
  if (!db) return { applied: 0, conflicts: 0, deleted: 0 };

  var pullStart = Date.now();
  var sinceSequence = await _getLastPulledSequence();

  // ── Snapshot sequence baseline ─────────────────────────────────────────
  // If _lastPulledSequence is 0 (never synced incrementally), check if
  // initial sync has completed and use its snapshotSequence as the baseline.
  // This ensures incremental sync only pulls changes AFTER the initial sync
  // snapshot was taken, avoiding redundant re-processing of already-imported data.
  if (sinceSequence === 0 && agencyId) {
    try {
      const initialSync = require('./initial-sync');
      const ready = await initialSync.isAgencyReady(db, agencyId);
      if (ready) {
        // Read snapshotSequence from AgencyLocalState
        const state = await db.agencyLocalState.findUnique({
          where: { agencyId },
          select: { snapshotSequence: true },
        });
        if (state && state.snapshotSequence > 0) {
          sinceSequence = state.snapshotSequence;
          // Persist as _lastPulledSequence so we don't re-check every cycle
          await _setLastPulledSequence(sinceSequence);
          console.log('[SyncService] Using initial sync snapshot sequence as baseline: ' + sinceSequence);
        }
      }
    } catch (e) {
      // AgencyLocalState may not exist — proceed with sinceSequence=0
      console.warn('[SyncService] Could not read snapshot sequence from AgencyLocalState:', e.message);
    }
  }

  console.log('[SyncService] Pulling from cloud - agency: ' + agencyId + ', sinceSequence: ' + sinceSequence);

  var pullData = await _cloudPost('/api/sync/pull', {
    agencyId: agencyId,
    sinceSequence: sinceSequence,
    limit: CURSOR_PULL_LIMIT,
    protocolVersion: SYNC_PROTOCOL_VERSION,
  });

  // Validate agency isolation in response
  if (pullData.agencyId && pullData.agencyId !== agencyId) {
    throw new Error('Agency isolation violation: pull response agencyId=' + pullData.agencyId + ' does not match requested=' + agencyId);
  }

  // New protocol returns changes as flat array of { model, operation, data, recordId, sequence }
  // Fall back to old grouped format for backward compat
  var cloudChanges = pullData.changes || [];
  var isFlatFormat = Array.isArray(cloudChanges);

  var applied = 0;
  var conflictCount = 0;
  var deletedCount = 0;
  var skippedByTombstone = 0;
  var failedChanges = 0;
  var maxSequence = sinceSequence;

  if (isFlatFormat) {
    // ── Cursor-based flat format: apply changes in order ──
    // Group by model for per-model filtering
    var changesByModel = {};
    for (var ci = 0; ci < cloudChanges.length; ci++) {
      var change = cloudChanges[ci];
      var modelName = change.model;
      if (!modelName) continue;
      if (!_shouldSyncModel(modelName)) continue;
      if (SYNC_TABLES.indexOf(modelName) === -1) {
        console.warn('[SyncService] Skipping unknown model in pull: ' + modelName);
        continue;
      }
      if (!changesByModel[modelName]) changesByModel[modelName] = [];
      changesByModel[modelName].push(change);
    }

    // Process each model — if one model fails, don't block others (partial failure recovery)
    var modelNames = Object.keys(changesByModel);
    for (var mi = 0; mi < modelNames.length; mi++) {
      var modelName = modelNames[mi];
      var modelChanges = changesByModel[modelName];

      try {
        await db.$transaction(async function(tx) {
          for (var ci = 0; ci < modelChanges.length; ci++) {
            var change = modelChanges[ci];
            try {
              var r = await _applyPullChange(tx, modelName, change, agencyId);
              if (r.applied) applied++;
              if (r.conflict) conflictCount++;
              if (r.deleted) deletedCount++;
              if (r.skippedByTombstone) skippedByTombstone++;
              // Track the highest sequence successfully applied
              var seq = change.sequence || 0;
              if (seq > maxSequence) maxSequence = seq;
            } catch (changeErr) {
              // Individual change failed — log but continue with other changes
              // DO NOT advance cursor past this change
              console.error('[SyncService] Pull change failed for ' + modelName + '/' + (change.recordId || '?') + ': ' + changeErr.message);
              failedChanges++;
              _addSyncLogEntry({ phase: 'pull', model: modelName, recordId: change.recordId, error: changeErr.message, status: 'change_failed' });
            }
          }
        });

        // Per-model: update sync timestamp on success
        await _setPerModelSyncTimestamp(modelName, Date.now());
      } catch (modelErr) {
        // Transaction failed for this model — don't advance cursor
        console.error('[SyncService] Pull transaction failed for model ' + modelName + ': ' + modelErr.message + ' (continuing with other models)');
        _addSyncLogEntry({ phase: 'pull', model: modelName, error: modelErr.message, status: 'failed' });
        failedChanges += modelChanges.length;
      }
    }

    // Only advance cursor if ALL changes were applied successfully
    if (failedChanges === 0) {
      await _setLastPulledSequence(maxSequence);
    } else {
      console.warn('[SyncService] Pull had ' + failedChanges + ' failed changes — cursor NOT advanced (will retry on next cycle)');
    }

  } else {
    // ── Legacy grouped format (backward compat) ──
    var cloudTimestamp = pullData.timestamp ? new Date(pullData.timestamp).getTime() : Date.now();
    var tableNames = Object.keys(cloudChanges);
    for (var ti = 0; ti < tableNames.length; ti++) {
      var modelName = tableNames[ti];
      if (!_shouldSyncModel(modelName)) continue;
      if (SYNC_TABLES.indexOf(modelName) === -1) {
        console.warn('[SyncService] Skipping unknown model in pull: ' + modelName);
        continue;
      }
      var table = modelName;
      var modelChanges = cloudChanges[modelName];

      try {
        await db.$transaction(async function(tx) {
          var createdList = modelChanges.created || [];
          for (var ci = 0; ci < createdList.length; ci++) {
            var cloudRecord = createdList[ci];
            var local = _cloudRecordToLocal(cloudRecord);

            // Resurrection protection using sequence-aware tombstones
            var tombstoneSequence = await _getTombstoneSequence(tx, modelName, local.id);
            if (tombstoneSequence >= 0) {
              skippedByTombstone++;
              continue;
            }

            var existing = await _fetchLocalRecord(tx, table, local.id);
            if (!existing) {
              await _insertLocalRecord(tx, table, local);
              applied++;
            } else {
              var localSyncVersion = existing.syncVersion || 0;
              var cloudSyncVersion = local.syncVersion || 0;
              var localModifiedSinceSync = localSyncVersion > 0 && existing.updatedAt && existing.syncVersion !== cloudSyncVersion;

              if (localModifiedSinceSync) {
                var winner = _applyConflictResolution(modelName, existing, local);
                await _logConflict(tx, modelName, local.id, existing.updatedAt, local.updatedAt, existing, local);
                conflictCount++;
                if (winner === 'cloud') {
                  await _updateLocalRecord(tx, table, local);
                  applied++;
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'cloud_applied' });
                } else {
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'local_kept' });
                }
              } else if (!existing.updatedAt || String(existing.updatedAt) <= String(local.updatedAt)) {
                await _updateLocalRecord(tx, table, local);
                applied++;
              } else {
                var winner = _applyConflictResolution(modelName, existing, local);
                await _logConflict(tx, modelName, local.id, existing.updatedAt, local.updatedAt, existing, local);
                conflictCount++;
                if (winner === 'cloud') {
                  await _updateLocalRecord(tx, table, local);
                  applied++;
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'cloud_applied' });
                } else {
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'local_kept' });
                }
              }
            }
          }

          var updatedList = modelChanges.updated || [];
          for (var ui = 0; ui < updatedList.length; ui++) {
            var cloudRecord = updatedList[ui];
            var local = _cloudRecordToLocal(cloudRecord);

            var tombstoneSequence = await _getTombstoneSequence(tx, modelName, local.id);
            if (tombstoneSequence >= 0) {
              skippedByTombstone++;
              continue;
            }

            var existing = await _fetchLocalRecord(tx, table, local.id);
            if (!existing) {
              await _insertLocalRecord(tx, table, local);
              applied++;
            } else {
              var localSyncVersion = existing.syncVersion || 0;
              var cloudSyncVersion = local.syncVersion || 0;
              var localModifiedSinceSync = localSyncVersion > 0 && existing.updatedAt && existing.syncVersion !== cloudSyncVersion;

              if (localModifiedSinceSync) {
                var winner = _applyConflictResolution(modelName, existing, local);
                await _logConflict(tx, modelName, local.id, existing.updatedAt, local.updatedAt, existing, local);
                conflictCount++;
                if (winner === 'cloud') {
                  await _updateLocalRecord(tx, table, local);
                  applied++;
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'cloud_applied' });
                } else {
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'local_kept' });
                }
              } else if (!existing.updatedAt || String(existing.updatedAt) <= String(local.updatedAt)) {
                await _updateLocalRecord(tx, table, local);
                applied++;
              } else {
                var winner = _applyConflictResolution(modelName, existing, local);
                await _logConflict(tx, modelName, local.id, existing.updatedAt, local.updatedAt, existing, local);
                conflictCount++;
                if (winner === 'cloud') {
                  await _updateLocalRecord(tx, table, local);
                  applied++;
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'cloud_applied' });
                } else {
                  emit({ type: 'sync-conflict', tableName: modelName, recordId: local.id, resolution: 'local_kept' });
                }
              }
            }
          }

          var deletedList = modelChanges.deleted || [];
          for (var di = 0; di < deletedList.length; di++) {
            var deletedId = deletedList[di];
            // Legacy delete: use sequence 0 (no sequence info in old format)
            await _writeTombstone(tx, modelName, deletedId, agencyId, 0);
            await _deleteLocalRecord(tx, table, deletedId);
            deletedCount++;
          }
        });

        await _setPerModelSyncTimestamp(modelName, cloudTimestamp);
      } catch (modelErr) {
        console.error('[SyncService] Pull failed for model ' + modelName + ': ' + modelErr.message + ' (continuing with other models)');
        _addSyncLogEntry({ phase: 'pull', model: modelName, error: modelErr.message, status: 'failed' });
      }
    }

    // Legacy: update timestamp-based cursors
    await _setLastSyncVersion(cloudTimestamp);
    await _setLastSyncTimestamp(Date.now());
    // Also update sequence cursor from response if provided
    if (pullData.latestSequence) {
      await _setLastPulledSequence(pullData.latestSequence);
    }
  }

  // Update global sync cursors
  await _setLastSyncTimestamp(Date.now());

  // Update metrics
  _syncMetrics.lastPullAt = new Date().toISOString();
  _syncMetrics.pullDuration = Date.now() - pullStart;
  _syncMetrics.recordsPulled = applied;
  _syncMetrics.conflictsDetected = conflictCount;

  _addSyncLogEntry({
    phase: 'pull',
    status: failedChanges > 0 ? 'partial' : 'completed',
    applied: applied,
    conflicts: conflictCount,
    deleted: deletedCount,
    skippedByTombstone: skippedByTombstone,
    failedChanges: failedChanges,
    sinceSequence: sinceSequence,
    maxSequence: maxSequence,
    duration: _syncMetrics.pullDuration,
  });

  console.log('[SyncService] Pull applied: ' + applied + ', conflicts: ' + conflictCount + ', deleted: ' + deletedCount + ', tombstoneSkipped: ' + skippedByTombstone + (failedChanges > 0 ? ', FAILED: ' + failedChanges : ''));
  return { applied: applied, conflicts: conflictCount, deleted: deletedCount };
}

// ─── Push Cycle ───────────────────────────────────────────────────────────────

async function _gatherLocalChanges(db, agencyId, sinceVersion) {
  var changes = {};
  for (var ti = 0; ti < SYNC_TABLES.length; ti++) {
    var table = SYNC_TABLES[ti];

    // Skip models not scheduled for this sync cycle
    if (!_shouldSyncModel(table)) continue;

    var modelChanges = { created: [], updated: [], deleted: [] };
    var whereClause = '';
    var params = [];

    if (table === 'Agency') {
      whereClause = 'id = ? AND ';
      params.push(agencyId);
    } else if (AGENCY_SCOPED_TABLES.has(table)) {
      whereClause = 'agencyId = ? AND ';
      params.push(agencyId);
    } else if (table === 'Counter') {
      whereClause = 'branchId IN (SELECT id FROM "Branch" WHERE agencyId = ?) AND ';
      params.push(agencyId);
    }

    var sinceISO = sinceVersion > 0 ? new Date(sinceVersion).toISOString() : '1970-01-01T00:00:00.000Z';

    var fetchSql = 'SELECT * FROM "' + table + '" WHERE ' + whereClause + '"updatedAt" > ?';
    try {
      var rows = await db.$queryRawUnsafe(fetchSql, ...params, sinceISO);
      for (var ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        // Handle both ISO string and epoch number (backward compat)
        var createdTs = typeof row.createdAt === 'string' ? new Date(row.createdAt).getTime() : (row.createdAt || 0);
        if (createdTs > sinceVersion) {
          modelChanges.created.push(row);
        } else {
          modelChanges.updated.push(row);
        }
      }
    } catch (e) {
      console.warn('[SyncService] Failed to gather changes for ' + table + ':', e.message);
    }

    try {
      var deletedSql = 'SELECT recordId FROM "DeletedRecord" WHERE modelName = ? AND "createdAt" > ?';
      var deletedRows = await db.$queryRawUnsafe(deletedSql, table, sinceISO);
      modelChanges.deleted = deletedRows.map(function(r) { return r.recordId; });
    } catch (e) { /* DeletedRecord may not have relevant entries */ }

    changes[table] = modelChanges;
  }
  return changes;
}

function _hasChanges(changes) {
  return Object.values(changes).some(function(m) {
    return (m.created && m.created.length > 0) || (m.updated && m.updated.length > 0) || (m.deleted && m.deleted.length > 0);
  });
}

async function _pushToCloud() {
  var db = _config.localDb;
  var agencyId;
  try {
    agencyId = _getCurrentAgencyId();
  } catch (e) {
    console.warn('[SyncService] Push skipped: ' + e.message);
    return { pushed: 0, conflicts: 0 };
  }
  if (!db) return { pushed: 0, conflicts: 0 };

  var pushStart = Date.now();
  var lastPushedVersion = await _getLastPushedVersion();
  console.log('[SyncService] Pushing to cloud - agency: ' + agencyId + ', lastPushed: ' + (lastPushedVersion || 'none'));

  // ── Push pending mutations with idempotency and partial failure ──
  var mutationsPushed = 0;
  var mutationsFailed = 0;
  if (_getPendingMutations && _authToken && _config?.cloudBaseUrl) {
    try {
      var mutations = await _getPendingMutations();
      if (mutations && mutations.length > 0) {
        for (var mi = 0; mi < mutations.length; mi++) {
          var mutation = mutations[mi];
          // Idempotency: skip if already successfully pushed
          if (mutation.status === 'completed' || mutation.response_data) {
            continue;
          }
          try {
            var mutUrl = _config.cloudBaseUrl + mutation.path;
            var mutHeaders = {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + _authToken,
            };
            // Include X-Idempotency-Key header for cloud deduplication
            if (mutation.idempotency_key) {
              mutHeaders['X-Idempotency-Key'] = mutation.idempotency_key;
            }
            var mutResponse;
            if (mutation.method === 'GET') {
              mutResponse = await fetch(mutUrl, { method: 'GET', headers: mutHeaders, signal: AbortSignal.timeout(10000) });
            } else if (mutation.method === 'DELETE') {
              mutResponse = await fetch(mutUrl, { method: 'DELETE', headers: mutHeaders, signal: AbortSignal.timeout(10000) });
            } else {
              mutResponse = await fetch(mutUrl, {
                method: mutation.method,
                headers: mutHeaders,
                body: mutation.body ? JSON.stringify(mutation.body) : undefined,
                signal: AbortSignal.timeout(10000),
              });
            }
            if (mutResponse.ok || mutResponse.status === 201) {
              var responseData = null;
              try { responseData = await mutResponse.json(); } catch { /* no body */ }
              await _markMutationCompleted(mutation.id, responseData);
              mutationsPushed++;
            } else {
              var errorText = await mutResponse.text().catch(function() { return ''; });
              // Partial failure: log but don't block subsequent mutations
              await _markMutationFailed(mutation.id, 'HTTP ' + mutResponse.status + ': ' + errorText.substring(0, 200));
              mutationsFailed++;
              console.warn('[SyncService] Mutation push failed (skipping, will retry): ' + mutation.id + ' - HTTP ' + mutResponse.status);
            }
          } catch (mutErr) {
            // Network error after server may have processed — idempotency key ensures safe retry
            try {
              await _markMutationFailed(mutation.id, mutErr.message);
            } catch (markErr) { /* ignore */ }
            mutationsFailed++;
            console.warn('[SyncService] Mutation push error (skipping, will retry): ' + mutation.id + ' - ' + mutErr.message);
          }
        }
      }
    } catch (e) {
      console.error('[SyncService] Error gathering mutations for push:', e.message);
    }
  }

  // ── Push gathered local changes ──
  var localChanges = await _gatherLocalChanges(db, agencyId, lastPushedVersion);
  if (!_hasChanges(localChanges)) {
    console.log('[SyncService] No local changes to push');

    // Update metrics even if no changes
    _syncMetrics.lastPushAt = new Date().toISOString();
    _syncMetrics.pushDuration = Date.now() - pushStart;
    _syncMetrics.recordsPushed = 0;
    _syncMetrics.mutationsPushed = mutationsPushed;
    _syncMetrics.mutationsFailed = mutationsFailed;

    return { pushed: 0, conflicts: 0, mutationsPushed: mutationsPushed, mutationsFailed: mutationsFailed };
  }

  var cloudChanges = {};
  Object.keys(localChanges).forEach(function(table) {
    var mc = localChanges[table];
    cloudChanges[table] = {
      created: (mc.created || []).map(_localRecordToCloud),
      updated: (mc.updated || []).map(_localRecordToCloud),
      deleted: mc.deleted || [],
    };
  });

  // Build mutations array with version and idempotency info for conflict-aware push
  var mutations = [];
  Object.keys(localChanges).forEach(function(table) {
    var mc = localChanges[table];
    var allRecords = [].concat(mc.created || []).concat(mc.updated || []);
    for (var ri = 0; ri < allRecords.length; ri++) {
      var record = allRecords[ri];
      var isCreate = (mc.created || []).indexOf(record) >= 0;
      mutations.push({
        model: table,
        recordId: record.id,
        operation: isCreate ? 'create' : 'update',
        data: _localRecordToCloud(record),
        expectedVersion: record.syncVersion || 0,
        idempotencyKey: table + '_' + record.id + '_' + (record.syncVersion || 0) + '_' + Date.now().toString(36),
      });
    }
    for (var di = 0; di < (mc.deleted || []).length; di++) {
      var deletedId = mc.deleted[di];
      mutations.push({
        model: table,
        recordId: deletedId,
        operation: 'delete',
        data: null,
        expectedVersion: 0,
        idempotencyKey: table + '_delete_' + deletedId + '_' + Date.now().toString(36),
      });
    }
  });

  var pushResponse = await _cloudPost('/api/sync/push', {
    mutations: mutations,
    changes: cloudChanges,
    agencyId: agencyId,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    deviceInfo: {
      deviceId: _config.deviceId || 'unknown',
      platform: process.platform,
      lastPushedVersion: lastPushedVersion,
    },
  });

  // Validate agency isolation in response
  if (pushResponse.agencyId && pushResponse.agencyId !== agencyId) {
    throw new Error('Agency isolation violation: push response agencyId=' + pushResponse.agencyId + ' does not match requested=' + agencyId);
  }

  var pushed = (pushResponse.accepted || []).length;
  var conflictCount = 0;

  var conflictList = pushResponse.conflicts || [];
  for (var ci = 0; ci < conflictList.length; ci++) {
    var conflict = conflictList[ci];
    conflictCount++;
    var modelName = conflict.modelName || conflict.model || conflict.table;
    var recordId = conflict.recordId || conflict.id;
    var cloudData = conflict.cloudData || conflict.record;

    if (cloudData && modelName && recordId) {
      var localExisting = await _fetchLocalRecord(db, modelName, recordId);
      await _logConflict(db, modelName, recordId, (localExisting && localExisting.updatedAt) || null, cloudData.updatedAt ? new Date(cloudData.updatedAt).getTime() : null, localExisting, cloudData);
      // Apply conflict resolution from push conflicts
      var winner = _applyConflictResolution(modelName, localExisting, cloudData);
      if (winner === 'cloud') {
        var localCloudRecord = _cloudRecordToLocal(cloudData);
        if (localExisting) {
          await _updateLocalRecord(db, modelName, localCloudRecord);
        } else {
          await _insertLocalRecord(db, modelName, localCloudRecord);
        }
      }
      emit({ type: 'sync-conflict', tableName: modelName, recordId: recordId, resolution: winner === 'cloud' ? 'cloud_applied' : 'local_kept' });
    }
  }

  // Increment syncVersion for successfully pushed records and mark as synced
  var acceptedList = pushResponse.accepted || [];
  for (var ai = 0; ai < acceptedList.length; ai++) {
    var accepted = acceptedList[ai];
    var aModel = accepted.modelName || accepted.model;
    var aRecordId = accepted.recordId || accepted.id;
    if (aModel && aRecordId) {
      try {
        // Increment syncVersion and set syncedAt = now
        await db.$executeRawUnsafe(
          'UPDATE "' + aModel + '" SET "syncVersion" = COALESCE("syncVersion", 0) + 1, "syncedAt" = ? WHERE id = ?',
          new Date().toISOString(), aRecordId
        );
      } catch (e) {
        // Non-critical — record was pushed successfully
        console.warn('[SyncService] Could not increment syncVersion for ' + aModel + '/' + aRecordId + ': ' + e.message);
      }
    }
  }

  if (pushed > 0 || conflictCount > 0) {
    await _setLastPushedVersion(Date.now());
  }

  // Update metrics
  _syncMetrics.lastPushAt = new Date().toISOString();
  _syncMetrics.pushDuration = Date.now() - pushStart;
  _syncMetrics.recordsPushed = pushed;
  _syncMetrics.mutationsPushed = mutationsPushed;
  _syncMetrics.mutationsFailed = mutationsFailed;
  _syncMetrics.conflictsDetected += conflictCount;

  _addSyncLogEntry({
    phase: 'push',
    status: 'completed',
    pushed: pushed,
    conflicts: conflictCount,
    mutationsPushed: mutationsPushed,
    mutationsFailed: mutationsFailed,
    duration: _syncMetrics.pushDuration,
  });

  console.log('[SyncService] Push result: ' + pushed + ' accepted, ' + conflictCount + ' conflicts, ' + mutationsPushed + ' mutations pushed, ' + mutationsFailed + ' mutations failed');
  return { pushed: pushed, conflicts: conflictCount, mutationsPushed: mutationsPushed, mutationsFailed: mutationsFailed };
}

// ─── Agency Switch Detection ─────────────────────────────────────────────────

async function _checkAndResetForNewAgency() {
  var currentAgency = _config.agencyId || (_userContext && _userContext.agencyId);
  var lastAgency = await _getLastSyncAgencyId();
  if (currentAgency && lastAgency && currentAgency !== lastAgency) {
    console.log('[SyncService] Agency changed: ' + lastAgency + ' -> ' + currentAgency + '. Resetting sync cursors for full sync.');
    await _setLastSyncVersion(0);
    await _setLastPushedVersion(0);
    await _setLastPulledSequence(0);
    await _setLastSyncAgencyId(currentAgency);
  } else if (currentAgency && !lastAgency) {
    await _setLastSyncAgencyId(currentAgency);
  }
}

// ─── Replay Pending Mutations ───────────────────────────────────────────────

/**
 * Replay pending mutations to the cloud API.
 * Called after a successful sync cycle or when connectivity is restored.
 *
 * For each pending mutation:
 * 1. Idempotency check: skip if already completed
 * 2. Send the same request to the cloud API with X-Idempotency-Key header
 * 3. If successful, mark as completed and store response_data
 * 4. If failed, log error but don't block subsequent mutations (partial failure)
 */
async function _replayPendingMutations() {
  if (!_getPendingMutations || !_authToken || !_config?.cloudBaseUrl) return;

  try {
    const mutations = await _getPendingMutations();
    if (!mutations || mutations.length === 0) return;

    console.log(`[SyncService] Replaying ${mutations.length} pending mutations...`);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const mutation of mutations) {
      // Idempotency: skip if already successfully pushed
      if (mutation.status === 'completed' || mutation.response_data) {
        skipped++;
        continue;
      }

      try {
        const url = `${_config.cloudBaseUrl}${mutation.path}`;
        const controller = AbortSignal.timeout(10000);

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_authToken}`,
        };

        // Include X-Idempotency-Key header for cloud deduplication
        if (mutation.idempotency_key) {
          headers['X-Idempotency-Key'] = mutation.idempotency_key;
        }

        let response;
        if (mutation.method === 'GET') {
          response = await fetch(url, { method: 'GET', headers, signal: controller });
        } else if (mutation.method === 'DELETE') {
          response = await fetch(url, { method: 'DELETE', headers, signal: controller });
        } else {
          response = await fetch(url, {
            method: mutation.method,
            headers,
            body: mutation.body ? JSON.stringify(mutation.body) : undefined,
            signal: controller,
          });
        }

        if (response.ok || response.status === 201) {
          let responseData = null;
          try { responseData = await response.json(); } catch { /* no body */ }
          // Store response_data for idempotency check on retry
          await _markMutationCompleted(mutation.id, responseData);
          succeeded++;
        } else {
          const errorText = await response.text().catch(() => '');
          // Partial failure: log error but don't block subsequent mutations
          await _markMutationFailed(mutation.id, `HTTP ${response.status}: ${errorText.substring(0, 200)}`);
          failed++;
          console.warn(`[SyncService] Mutation replay failed (skipping): ${mutation.id} - HTTP ${response.status}`);
        }
      } catch (e) {
        // Network error after server may have processed — idempotency key ensures safe retry
        try {
          await _markMutationFailed(mutation.id, e.message);
        } catch (markErr) { /* ignore */ }
        failed++;
        console.warn(`[SyncService] Mutation replay error (skipping): ${mutation.id} - ${e.message}`);
      }
    }

    if (succeeded > 0 || failed > 0 || skipped > 0) {
      console.log(`[SyncService] Mutation replay: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (idempotent)`);
      emit({ type: 'mutations-replayed', succeeded, failed, skipped });

      // Update mutation metrics
      _syncMetrics.mutationsPushed += succeeded;
      _syncMetrics.mutationsFailed += failed;
    }
  } catch (e) {
    console.error('[SyncService] _replayPendingMutations error:', e.message);
  }
}

// ─── Main Sync Cycle ──────────────────────────────────────────────────────────

async function _syncCycle() {
  if (_isSyncing) {
    console.log('[SyncService] Already syncing - skipping');
    return;
  }
  if (!_authToken) {
    console.log('[SyncService] No auth token - skipping');
    return;
  }
  if (!_config || !_config.localDb) {
    console.log('[SyncService] Local DB not ready - skipping');
    return;
  }

  // Check AgencyLocalState — only pull from cloud if initial sync is READY.
  // If initial sync hasn't completed yet, skip incremental pull (initial-sync.js
  // handles first-time bulk import via POST /api/sync/initial-data).
  if (_config.agencyId) {
    try {
      const initialSync = require('./initial-sync');
      const ready = await initialSync.isAgencyReady(_config.localDb, _config.agencyId);
      if (!ready) {
        console.log('[SyncService] Agency not initialized yet — skipping incremental pull (waiting for initial sync)');
        emit({ type: 'sync-paused', reason: 'initial-sync-pending' });
        // Still replay any pending local mutations
        await _replayPendingMutations().catch(() => {});
        return;
      }
    } catch (e) {
      // If AgencyLocalState table doesn't exist yet, allow sync to proceed
      // (backward compatibility — the table will be created after prisma generate)
      console.warn('[SyncService] Could not check AgencyLocalState:', e.message);
    }
  }

  var online = await _isOnline();
  if (!online) {
    // Cloud is unreachable — check if local API is healthy.
    // In "local-only" mode, replay pending mutations (offline changes)
    // but skip cloud pull/push.
    const localUp = await _isLocalApiUp();
    if (localUp && _authToken) {
      console.log('[SyncService] Cloud offline, local API healthy — local-only mode (replaying mutations)');
      _lastError = 'cloud-offline';
      emit({ type: 'sync-paused', reason: 'cloud-offline' });
      // Still replay any pending local mutations
      await _replayPendingMutations().catch(() => {});
      return;
    }
    console.log('[SyncService] Offline - skipping');
    _lastError = 'offline';
    emit({ type: 'sync-paused', reason: 'offline' });
    return;
  }

  _isSyncing = true;
  _lastError = null;
  _syncCycleCount++;
  emit({ type: 'sync-start' });

  try {
    await _checkAndResetForNewAgency();
    var pullResult = await _pullFromCloud();
    var pushResult = await _pushToCloud();
    _lastSyncAt = new Date();
    _resetBackoff();

    // Cleanup old tombstones (30 days)
    await _cleanupTombstones(_config.localDb);

    // Mark successful cloud contact for 3-day offline token policy
    try {
      const localApi = require('./index');
      if (localApi.markCloudContact) localApi.markCloudContact();
    } catch {}

    var totalConflicts = pullResult.conflicts + pushResult.conflicts;
    emit({
      type: 'sync-complete',
      stats: {
        pulled: pullResult.applied,
        pushed: pushResult.pushed,
        deleted: pullResult.deleted,
        conflicts: totalConflicts,
        mutationsPushed: pushResult.mutationsPushed || 0,
        mutationsFailed: pushResult.mutationsFailed || 0,
      },
    });
    console.log('[SyncService] Sync complete - pulled: ' + pullResult.applied + ', pushed: ' + pushResult.pushed + ', deleted: ' + pullResult.deleted + ', conflicts: ' + totalConflicts);

    // After successful sync, replay any pending mutations (already handled in _pushToCloud,
    // but also replay for any that arrived after push started)
    await _replayPendingMutations().catch(() => {});

    // Also reload mutation functions in case they weren't available before
    _loadMutationFunctions();

    _addSyncLogEntry({
      phase: 'sync-cycle',
      status: 'completed',
      pull: pullResult,
      push: pushResult,
    });
  } catch (err) {
    _lastError = err.message;
    _increaseBackoff();
    console.error('[SyncService] Sync failed (' + _backoffMs + 'ms backoff):', err.message);
    emit({ type: 'sync-error', error: err.message, backoffMs: _backoffMs, failures: _consecutiveFailures });
    _addSyncLogEntry({ phase: 'sync-cycle', status: 'failed', error: err.message });
  } finally {
    _isSyncing = false;
  }
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
    initialDelayMs: DEFAULT_INITIAL_DELAY_MS,
    cloudBaseUrl: '',
    agencyId: '',
    deviceId: 'unknown',
  };
  Object.keys(config).forEach(function(k) { _config[k] = config[k]; });

  _isStarted = true;
  await _ensureConflictsTable();
  await _ensureTombstonesTable(_config.localDb);
  console.log('[SyncService] Starting - cloud: ' + _config.cloudBaseUrl + ', agency: ' + (_config.agencyId || 'pending auth') + ', interval: ' + (_config.syncIntervalMs / 1000) + 's');

  _initialTimeoutId = setTimeout(function() {
    _syncCycle().catch(function(err) { console.error('[SyncService] Initial sync error:', err.message); });
  }, _config.initialDelayMs);

  // Use recursive setTimeout instead of setInterval so we can apply backoff dynamically
  function _scheduleNextSync() {
    if (!_isStarted) return;
    var delay = _consecutiveFailures > 0 ? Math.min(_config.syncIntervalMs + _backoffMs, 300_000) : _config.syncIntervalMs;
    _syncIntervalId = setTimeout(function() {
      _syncCycle().catch(function(err) { console.error('[SyncService] Periodic sync error:', err.message); }).finally(function() {
        _scheduleNextSync(); // Schedule next cycle after this one completes
      });
    }, delay);
  }
  _scheduleNextSync();

  _onlineListener = function() {
    console.log('[SyncService] Network online - triggering sync');
    _syncCycle().catch(function(err) { console.error('[SyncService] Online-event sync error:', err.message); });
  };
  if (typeof process !== 'undefined' && process.on) {
    process.on('online', _onlineListener);
  }
}

function stopSync() {
  if (!_isStarted) return;
  if (_initialTimeoutId) { clearTimeout(_initialTimeoutId); _initialTimeoutId = null; }
  if (_syncIntervalId) { clearTimeout(_syncIntervalId); _syncIntervalId = null; }
  if (_onlineListener) {
    if (typeof process !== 'undefined' && process.off) { process.off('online', _onlineListener); }
    _onlineListener = null;
  }
  _isStarted = false;
  _isSyncing = false;
  console.log('[SyncService] Stopped');
}

function triggerSyncNow() {
  // Also replay pending mutations
  _replayPendingMutations().catch(() => {});
  return _syncCycle();
}

async function getStatus() {
  // Get pending mutations count (non-blocking)
  let pendingMutations = 0;
  if (_getPendingMutations) {
    try {
      const pending = await _getPendingMutations();
      pendingMutations = pending?.length || 0;
    } catch { /* ignore */ }
  }

  // Get unresolved conflicts count
  let unresolvedConflicts = 0;
  var db = _config && _config.localDb;
  if (db) {
    try {
      var rows = await db.$queryRawUnsafe('SELECT COUNT(*) as cnt FROM "_sync_conflicts" WHERE resolution = \'pending\' OR resolution IS NULL');
      unresolvedConflicts = (rows[0] && rows[0].cnt) || 0;
    } catch { /* ignore */ }
  }

  return {
    isSyncing: _isSyncing,
    isStarted: _isStarted,
    hasAuth: !!_authToken,
    agencyId: (_config && _config.agencyId) || (_userContext && _userContext.agencyId) || null,
    cloudBaseUrl: (_config && _config.cloudBaseUrl) || null,
    lastSyncAt: _lastSyncAt ? _lastSyncAt.toISOString() : null,
    lastPullVersion: (await _getLastSyncVersion()) || null,
    lastPushVersion: (await _getLastPushedVersion()) || null,
    lastPulledSequence: (await _getLastPulledSequence()) || null,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    syncCycleCount: _syncCycleCount,
    lastError: _lastError,
    backoffMs: _backoffMs,
    consecutiveFailures: _consecutiveFailures,
    syncIntervalMs: (_config && _config.syncIntervalMs) || null,
    pendingMutations: pendingMutations,
    unresolvedConflicts: unresolvedConflicts,
    // Detailed sync metrics
    metrics: {
      lastPullAt: _syncMetrics.lastPullAt,
      lastPushAt: _syncMetrics.lastPushAt,
      pullDuration: _syncMetrics.pullDuration,
      pushDuration: _syncMetrics.pushDuration,
      recordsPulled: _syncMetrics.recordsPulled,
      recordsPushed: _syncMetrics.recordsPushed,
      conflictsDetected: _syncMetrics.conflictsDetected,
      mutationsPushed: _syncMetrics.mutationsPushed,
      mutationsFailed: _syncMetrics.mutationsFailed,
    },
  };
}

/**
 * Returns the last N sync operations for diagnostics.
 * @param {number} limit - Max entries to return (default 50)
 */
function getSyncLog(limit) {
  limit = limit || 50;
  return _syncLog.slice(-limit);
}

/**
 * Cleanup tombstones older than 30 days. Can be called manually.
 */
async function cleanupTombstones() {
  var db = _config && _config.localDb;
  if (!db) return 0;
  return await _cleanupTombstones(db);
}

function setAuth(token, userContext) {
  _authToken = token;
  _userContext = userContext;
  if (userContext && userContext.agencyId && _config && !_config.agencyId) {
    _config.agencyId = userContext.agencyId;
  }
  console.log('[SyncService] Auth set - user: ' + (userContext && userContext.id) + ', role: ' + (userContext && userContext.role) + ', agency: ' + (userContext && userContext.agencyId || 'none'));

  // ── Check AgencyLocalState to determine sync readiness ──────────────────
  // After setting auth, check if the agency is initialized:
  //   - READY:      start incremental sync immediately
  //   - NOT_INITIALIZED: emit 'sync:initial-required' so the frontend triggers initial sync
  const agencyId = userContext && userContext.agencyId;
  if (agencyId && _config && _config.localDb && _isStarted) {
    try {
      const initialSync = require('./initial-sync');
      initialSync.isAgencyReady(_config.localDb, agencyId).then(function(ready) {
        if (ready) {
          console.log('[SyncService] Agency is READY — triggering incremental sync');
          _syncCycle().catch(function(err) {
            console.error('[SyncService] Incremental sync error after setAuth:', err.message);
          });
        } else {
          console.log('[SyncService] Agency NOT_INITIALIZED — emitting sync:initial-required');
          emit({ type: 'sync:initial-required', agencyId: agencyId });
        }
      }).catch(function(e) {
        // AgencyLocalState may not exist yet — emit initial-required as default
        console.warn('[SyncService] Could not check AgencyLocalState after setAuth:', e.message);
        emit({ type: 'sync:initial-required', agencyId: agencyId });
      });
    } catch (e) {
      // initial-sync module not available — skip check
      console.warn('[SyncService] Could not load initial-sync module:', e.message);
    }
  }
}

function clearAuth() {
  _authToken = null;
  _userContext = null;
  console.log('[SyncService] Auth cleared');
}

async function getConflicts() {
  var db = _config && _config.localDb;
  if (!db) return [];
  try {
    var rows = await db.$queryRawUnsafe('SELECT * FROM "_sync_conflicts" WHERE resolution = \'pending\' OR resolution IS NULL ORDER BY "createdAt" DESC');
    return rows.map(function(row) {
      return {
        id: row.id,
        modelName: row.modelName || row.tableName,
        recordId: row.recordId,
        localVersion: row.localVersion,
        cloudVersion: row.cloudVersion,
        localData: row.localData ? JSON.parse(row.localData) : null,
        cloudData: row.cloudData ? JSON.parse(row.cloudData) : null,
        resolution: row.resolution,
        resolvedAt: row.resolvedAt,
        createdAt: row.createdAt,
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
  var rows = await db.$queryRawUnsafe('SELECT * FROM "_sync_conflicts" WHERE id = ? AND (resolution = \'pending\' OR resolution IS NULL)', conflictId);
  var conflict = rows[0] || null;
  if (!conflict) {
    throw new Error('Conflict not found or already resolved: ' + conflictId);
  }
  var modelName = conflict.modelName || conflict.tableName;
  var recordId = conflict.recordId;

  if (resolution === 'cloud') {
    var cloudData = conflict.cloudData ? JSON.parse(conflict.cloudData) : null;
    if (cloudData) {
      var localRecord = _cloudRecordToLocal(cloudData);
      var existing = await _fetchLocalRecord(db, modelName, recordId);
      if (existing) {
        await _updateLocalRecord(db, modelName, localRecord);
      } else {
        await _insertLocalRecord(db, modelName, localRecord);
      }
    }
  }

  await db.$executeRawUnsafe('UPDATE "_sync_conflicts" SET resolution = ?, "resolvedAt" = ? WHERE id = ?', resolution, Date.now(), conflictId);
  emit({ type: 'sync-conflict', tableName: modelName, recordId: recordId, resolution: resolution, conflictId: conflictId });
  console.log('[SyncService] Conflict ' + conflictId + ' resolved: ' + resolution);
}

module.exports = {
  startSync: startSync,
  stopSync: stopSync,
  triggerSyncNow: triggerSyncNow,
  getStatus: getStatus,
  setAuth: setAuth,
  clearAuth: clearAuth,
  onSyncEvent: onSyncEvent,
  getConflicts: getConflicts,
  resolveConflict: resolveConflict,
  getSyncLog: getSyncLog,
  cleanupTombstones: cleanupTombstones,
  // Accessors for main.js to get auth/agency info for initial-sync IPC
  _getAuthToken: function() { return _authToken; },
  _getAgencyId: function() { return _config ? _config.agencyId : ''; },
};
