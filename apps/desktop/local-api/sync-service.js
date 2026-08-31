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
];

const AGENCY_SCOPED_TABLES = new Set([
  'Agency',
  'Service',
  'Branch',
  'Reservation',
  'QueueSettings',
]);

const DATE_FIELDS = new Set([
  'joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'noShowAt',
  'pausedAt', 'createdAt', 'updatedAt', 'openedAt', 'repliedAt',
  'reviewedAt', 'lastRoleChangeAt', 'gracePeriodEndsAt',
  'subscriptionStartsAt', 'subscriptionExpiresAt', 'reminderSentAt',
  'smsReminderSentAt', 'skippedAt', 'reclaimRequestedAt', 'qrClaimedAt',
  'offlineCreatedAt', 'lastActiveAt', 'resolvedAt',
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_SYNC_INTERVAL_MS = 120_000;
const DEFAULT_INITIAL_DELAY_MS = 3_000;

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
      '"tableName" TEXT NOT NULL,' +
      '"recordId" TEXT NOT NULL,' +
      '"localVersion" INTEGER,' +
      '"cloudVersion" INTEGER,' +
      '"localData" TEXT,' +
      '"cloudData" TEXT,' +
      '"resolution" TEXT,' +
      '"resolvedAt" INTEGER,' +
      '"createdAt" INTEGER NOT NULL' +
      ')'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_table" ON "_sync_conflicts"("tableName")'
    );
    await db.$executeRawUnsafe(
      'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_resolution" ON "_sync_conflicts"("resolution")'
    );
  } catch (e) {
    console.error('[SyncService] Failed to create _sync_conflicts table:', e.message);
  }
}

let _conflictCounter = 0;
function _generateConflictId() {
  _conflictCounter++;
  return 'conflict_' + Date.now().toString(36) + '_' + _conflictCounter;
}

async function _logConflict(db, tableName, recordId, localVersion, cloudVersion, localData, cloudData) {
  if (!db) return null;
  var id = _generateConflictId();
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_conflicts" (id, tableName, recordId, localVersion, cloudVersion, localData, cloudData, createdAt) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, tableName, recordId,
      localVersion || null, cloudVersion || null,
      localData ? JSON.stringify(localData) : null,
      cloudData ? JSON.stringify(cloudData) : null,
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

async function _cloudPost(path, body) {
  const baseUrl = _config.cloudBaseUrl;
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + _authToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000), // Prevent indefinite hangs when offline
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

// ─── Pull Cycle ───────────────────────────────────────────────────────────────

async function _pullFromCloud() {
  var db = _config.localDb;
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
  if (!db || !agencyId) return { applied: 0, conflicts: 0, deleted: 0 };

  var lastVersion = await _getLastSyncTimestamp();
  var lastPulledAt = lastVersion > 0 ? new Date(lastVersion).toISOString() : undefined;
  console.log('[SyncService] Pulling from cloud - agency: ' + agencyId + ', lastPulledAt: ' + (lastPulledAt || 'none (full sync)'));

  var pullData = await _cloudPost('/api/sync/pull', {
    lastPulledAt: lastPulledAt,
    agencyId: agencyId,
  });

  var cloudChanges = pullData.changes || {};
  var cloudTimestamp = pullData.timestamp ? new Date(pullData.timestamp).getTime() : Date.now();

  var applied = 0;
  var conflictCount = 0;
  var deletedCount = 0;

  await db.$transaction(async function(tx) {
    var tableNames = Object.keys(cloudChanges);
    for (var ti = 0; ti < tableNames.length; ti++) {
      var modelName = tableNames[ti];
      if (SYNC_TABLES.indexOf(modelName) === -1) {
        console.warn('[SyncService] Skipping unknown model in pull: ' + modelName);
        continue;
      }
      var table = modelName;
      var modelChanges = cloudChanges[modelName];

      var createdList = modelChanges.created || [];
      for (var ci = 0; ci < createdList.length; ci++) {
        var cloudRecord = createdList[ci];
        var local = _cloudRecordToLocal(cloudRecord);
        var existing = await _fetchLocalRecord(tx, table, local.id);
        if (!existing) {
          await _insertLocalRecord(tx, table, local);
          applied++;
        } else if (!existing.updatedAt || String(existing.updatedAt) <= String(local.updatedAt)) {
          await _updateLocalRecord(tx, table, local);
          applied++;
        } else {
          await _logConflict(tx, table, local.id, existing.updatedAt, local.updatedAt, existing, local);
          conflictCount++;
          emit({ type: 'sync-conflict', tableName: table, recordId: local.id, resolution: 'local_kept' });
        }
      }

      var updatedList = modelChanges.updated || [];
      for (var ui = 0; ui < updatedList.length; ui++) {
        var cloudRecord = updatedList[ui];
        var local = _cloudRecordToLocal(cloudRecord);
        var existing = await _fetchLocalRecord(tx, table, local.id);
        if (!existing) {
          await _insertLocalRecord(tx, table, local);
          applied++;
        } else if (!existing.updatedAt || String(existing.updatedAt) <= String(local.updatedAt)) {
          await _updateLocalRecord(tx, table, local);
          applied++;
        } else {
          await _logConflict(tx, table, local.id, existing.updatedAt, local.updatedAt, existing, local);
          conflictCount++;
          emit({ type: 'sync-conflict', tableName: table, recordId: local.id, resolution: 'local_kept' });
        }
      }

      var deletedList = modelChanges.deleted || [];
      for (var di = 0; di < deletedList.length; di++) {
        await _deleteLocalRecord(tx, table, deletedList[di]);
        deletedCount++;
      }
    }
  });

  await _setLastSyncVersion(cloudTimestamp);
  await _setLastSyncTimestamp(Date.now());

  console.log('[SyncService] Pull applied: ' + applied + ', conflicts: ' + conflictCount + ', deleted: ' + deletedCount);
  return { applied: applied, conflicts: conflictCount, deleted: deletedCount };
}

// ─── Push Cycle ───────────────────────────────────────────────────────────────

async function _gatherLocalChanges(db, agencyId, sinceVersion) {
  var changes = {};
  for (var ti = 0; ti < SYNC_TABLES.length; ti++) {
    var table = SYNC_TABLES[ti];
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
  var agencyId = _config.agencyId || (_userContext && _userContext.agencyId);
  if (!db || !agencyId) return { pushed: 0, conflicts: 0 };

  var lastPushedVersion = await _getLastPushedVersion();
  console.log('[SyncService] Pushing to cloud - agency: ' + agencyId + ', lastPushed: ' + (lastPushedVersion || 'none'));

  var localChanges = await _gatherLocalChanges(db, agencyId, lastPushedVersion);
  if (!_hasChanges(localChanges)) {
    console.log('[SyncService] No local changes to push');
    return { pushed: 0, conflicts: 0 };
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

  var pushResponse = await _cloudPost('/api/sync/push', {
    changes: cloudChanges,
    agencyId: agencyId,
    deviceInfo: {
      deviceId: _config.deviceId || 'unknown',
      platform: process.platform,
      lastPushedVersion: lastPushedVersion,
    },
  });

  var pushed = (pushResponse.accepted || []).length;
  var conflictCount = 0;

  var conflictList = pushResponse.conflicts || [];
  for (var ci = 0; ci < conflictList.length; ci++) {
    var conflict = conflictList[ci];
    conflictCount++;
    var tableName = conflict.modelName || conflict.table;
    var recordId = conflict.recordId || conflict.id;
    var cloudData = conflict.cloudData || conflict.record;

    if (cloudData && tableName && recordId) {
      var localExisting = await _fetchLocalRecord(db, tableName, recordId);
      await _logConflict(db, tableName, recordId, (localExisting && localExisting.updatedAt) || null, cloudData.updatedAt ? new Date(cloudData.updatedAt).getTime() : null, localExisting, cloudData);
      var localCloudRecord = _cloudRecordToLocal(cloudData);
      if (localExisting) {
        await _updateLocalRecord(db, tableName, localCloudRecord);
      } else {
        await _insertLocalRecord(db, tableName, localCloudRecord);
      }
      emit({ type: 'sync-conflict', tableName: tableName, recordId: recordId, resolution: 'cloud_applied' });
    }
  }

  if (pushed > 0 || conflictCount > 0) {
    await _setLastPushedVersion(Date.now());
  }

  console.log('[SyncService] Push result: ' + pushed + ' accepted, ' + conflictCount + ' conflicts');
  return { pushed: pushed, conflicts: conflictCount };
}

// ─── Agency Switch Detection ─────────────────────────────────────────────────

async function _checkAndResetForNewAgency() {
  var currentAgency = _config.agencyId || (_userContext && _userContext.agencyId);
  var lastAgency = await _getLastSyncAgencyId();
  if (currentAgency && lastAgency && currentAgency !== lastAgency) {
    console.log('[SyncService] Agency changed: ' + lastAgency + ' -> ' + currentAgency + '. Resetting sync cursors for full sync.');
    await _setLastSyncVersion(0);
    await _setLastPushedVersion(0);
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
 * 1. Send the same request to the cloud API
 * 2. If successful, mark as completed
 * 3. If failed, mark as failed (will retry on next cycle)
 */
async function _replayPendingMutations() {
  if (!_getPendingMutations || !_authToken || !_config?.cloudBaseUrl) return;

  try {
    const mutations = await _getPendingMutations();
    if (!mutations || mutations.length === 0) return;

    console.log(`[SyncService] Replaying ${mutations.length} pending mutations...`);

    let succeeded = 0;
    let failed = 0;

    for (const mutation of mutations) {
      try {
        const url = `${_config.cloudBaseUrl}${mutation.path}`;
        const controller = AbortSignal.timeout(10000);

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_authToken}`,
        };

        let response;
        if (mutation.method === 'GET') {
          response = await fetch(url, { method: 'GET', headers, signal: controller });
        } else {
          response = await fetch(url, {
            method: mutation.method,
            headers,
            body: mutation.body ? JSON.stringify(mutation.body) : undefined,
            signal: controller,
          });
        }

        if (response.ok || response.status === 201) {
          await _markMutationCompleted(mutation.id);
          succeeded++;
        } else {
          const errorText = await response.text().catch(() => '');
          await _markMutationFailed(mutation.id, `HTTP ${response.status}: ${errorText.substring(0, 200)}`);
          failed++;
        }
      } catch (e) {
        await _markMutationFailed(mutation.id, e.message);
        failed++;
      }
    }

    if (succeeded > 0 || failed > 0) {
      console.log(`[SyncService] Mutation replay: ${succeeded} succeeded, ${failed} failed`);
      emit({ type: 'mutations-replayed', succeeded, failed });
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
  emit({ type: 'sync-start' });

  try {
    await _checkAndResetForNewAgency();
    var pullResult = await _pullFromCloud();
    var pushResult = await _pushToCloud();
    _lastSyncAt = new Date();
    _resetBackoff();

    var totalConflicts = pullResult.conflicts + pushResult.conflicts;
    emit({
      type: 'sync-complete',
      stats: { pulled: pullResult.applied, pushed: pushResult.pushed, deleted: pullResult.deleted, conflicts: totalConflicts },
    });
    console.log('[SyncService] Sync complete - pulled: ' + pullResult.applied + ', pushed: ' + pushResult.pushed + ', deleted: ' + pullResult.deleted + ', conflicts: ' + totalConflicts);

    // After successful sync, replay any pending mutations
    await _replayPendingMutations().catch(() => {});

    // Also reload mutation functions in case they weren't available before
    _loadMutationFunctions();
  } catch (err) {
    _lastError = err.message;
    _increaseBackoff();
    console.error('[SyncService] Sync failed (' + _backoffMs + 'ms backoff):', err.message);
    emit({ type: 'sync-error', error: err.message, backoffMs: _backoffMs, failures: _consecutiveFailures });
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
  console.log('[SyncService] Starting - cloud: ' + _config.cloudBaseUrl + ', agency: ' + (_config.agencyId || 'pending auth') + ', interval: ' + (_config.syncIntervalMs / 1000) + 's');

  _initialTimeoutId = setTimeout(function() {
    _syncCycle().catch(function(err) { console.error('[SyncService] Initial sync error:', err.message); });
  }, _config.initialDelayMs);

  _syncIntervalId = setInterval(function() {
    _syncCycle().catch(function(err) { console.error('[SyncService] Periodic sync error:', err.message); });
  }, _config.syncIntervalMs);

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
  if (_syncIntervalId) { clearInterval(_syncIntervalId); _syncIntervalId = null; }
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

  return {
    isSyncing: _isSyncing,
    isStarted: _isStarted,
    hasAuth: !!_authToken,
    agencyId: (_config && _config.agencyId) || (_userContext && _userContext.agencyId) || null,
    cloudBaseUrl: (_config && _config.cloudBaseUrl) || null,
    lastSyncAt: _lastSyncAt ? _lastSyncAt.toISOString() : null,
    lastPullVersion: (await _getLastSyncVersion()) || null,
    lastPushVersion: (await _getLastPushedVersion()) || null,
    lastError: _lastError,
    backoffMs: _backoffMs,
    consecutiveFailures: _consecutiveFailures,
    syncIntervalMs: (_config && _config.syncIntervalMs) || null,
    pendingMutations: pendingMutations,
  };
}

function setAuth(token, userContext) {
  _authToken = token;
  _userContext = userContext;
  if (userContext && userContext.agencyId && _config && !_config.agencyId) {
    _config.agencyId = userContext.agencyId;
  }
  console.log('[SyncService] Auth set - user: ' + (userContext && userContext.id) + ', role: ' + (userContext && userContext.role) + ', agency: ' + (userContext && userContext.agencyId || 'none'));

  // Trigger an immediate sync after auth is set (for post-login initial sync)
  if (_isStarted && token) {
    // Reset sync version to force a full pull on first sync after login
    _setLastSyncVersion(0).then(function() {
      console.log('[SyncService] Auth set — triggering immediate initial sync');
      _syncCycle().catch(function(err) {
        console.error('[SyncService] Post-auth sync error:', err.message);
      });
    }).catch(function() { /* ignore */ });
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
    var rows = await db.$queryRawUnsafe('SELECT * FROM "_sync_conflicts" WHERE resolution IS NULL ORDER BY "createdAt" DESC');
    return rows.map(function(row) {
      return {
        id: row.id,
        tableName: row.tableName,
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
  var rows = await db.$queryRawUnsafe('SELECT * FROM "_sync_conflicts" WHERE id = ? AND resolution IS NULL', conflictId);
  var conflict = rows[0] || null;
  if (!conflict) {
    throw new Error('Conflict not found or already resolved: ' + conflictId);
  }
  var tableName = conflict.tableName;
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
 * Perform an initial full sync after login.
 * Resets sync cursor to epoch to pull ALL agency data from cloud.
 * Returns a promise that resolves when sync completes (or fails).
 */
async function initialSync() {
  if (!_authToken) {
    console.warn('[SyncService] initialSync called but no auth token set');
    return { success: false, error: 'No auth token' };
  }
  if (!_config || !_config.localDb) {
    console.warn('[SyncService] initialSync called but local DB not ready');
    return { success: false, error: 'Local DB not ready' };
  }

  // Reset sync cursor to force full pull
  await _setLastSyncVersion(0);
  await _setLastSyncTimestamp(0);

  console.log('[SyncService] Starting initial full sync (post-login)...');
  emit({ type: 'sync-start', initial: true });

  try {
    var online = await _isOnline();
    if (!online) {
      _lastError = 'offline';
      emit({ type: 'sync-paused', reason: 'offline' });
      return { success: false, error: 'Cloud API is offline — will sync when connection returns' };
    }

    await _checkAndResetForNewAgency();
    var pullResult = await _pullFromCloud();
    var pushResult = await _pushToCloud();
    _lastSyncAt = new Date();
    _resetBackoff();

    var totalConflicts = pullResult.conflicts + pushResult.conflicts;
    var result = {
      success: true,
      pulled: pullResult.applied,
      pushed: pushResult.pushed,
      deleted: pullResult.deleted,
      conflicts: totalConflicts,
    };
    emit({
      type: 'sync-complete',
      stats: { pulled: pullResult.applied, pushed: pushResult.pushed, deleted: pullResult.deleted, conflicts: totalConflicts },
    });
    console.log('[SyncService] Initial sync complete - pulled: ' + pullResult.applied + ', pushed: ' + pushResult.pushed);
    return result;
  } catch (err) {
    _lastError = err.message;
    console.error('[SyncService] Initial sync failed:', err.message);
    emit({ type: 'sync-error', error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = {
  startSync: startSync,
  stopSync: stopSync,
  triggerSyncNow: triggerSyncNow,
  initialSync: initialSync,
  getStatus: getStatus,
  setAuth: setAuth,
  clearAuth: clearAuth,
  onSyncEvent: onSyncEvent,
  getConflicts: getConflicts,
  resolveConflict: resolveConflict,
};
