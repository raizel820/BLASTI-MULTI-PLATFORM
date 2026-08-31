/**
 * BLASTI Desktop — Cloud Sync Loop
 *
 * Pushes local SQLite cache changes to the cloud server and pulls
 * cloud changes back, so the desktop stays in sync when internet
 * is available. This runs in the Electron main process.
 *
 * Flow:
 *   1. Pull from cloud /api/sync/pull → apply to local SQLite
 *   2. Push local SQLite changes → cloud /api/sync/push
 *   3. Repeat every 5 minutes (or on online event from renderer)
 *
 * Auth: Uses the JWT session token from the renderer process
 * (passed via IPC). The desktop main process does NOT have direct
 * access to NextAuth cookies, so the renderer must provide the token.
 */

const localDb = require('./local-db');

// ─── Config ──────────────────────────────────────────────────────────────────

const CLOUD_BASE_URL = process.env.BLASTI_API_URL || 'https://blasti.vercel.app';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 5000;

// In dev mode, use local API server
const isDev = process.env.NODE_ENV === 'development' ||
              process.env.ELECTRON_DEV === '1' ||
              (process.argv && process.argv.includes('--dev'));

// In dev mode, point to the local API server (port 3003), not the Next.js web server (port 3000)
const API_BASE = isDev
  ? (process.env.BLASTI_API_URL || 'http://localhost:3003')
  : CLOUD_BASE_URL;

// ─── State ────────────────────────────────────────────────────────────────────

let _syncIntervalId = null;
let _isSyncing = false;
let _authToken = null;
let _userContext = null; // { agencyId, userId, role }
let _lastError = null;
let _listeners = new Set();

// ─── Event System ──────────────────────────────────────────────────────────────

function emit(event) {
  for (const listener of _listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error('[CloudSync] Listener error:', e);
    }
  }
}

function onSyncEvent(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ─── Auth Management ─────────────────────────────────────────────────────────

/**
 * Called by the renderer (via IPC) to provide the auth token and user context.
 * Required before cloud sync can run.
 */
function setAuth(token, userContext) {
  _authToken = token;
  _userContext = userContext;
  console.log('[CloudSync] Auth set — user:', userContext?.id, 'role:', userContext?.role);
}

function clearAuth() {
  _authToken = null;
  _userContext = null;
  console.log('[CloudSync] Auth cleared');
}

// ─── Network Check ────────────────────────────────────────────────────────────

async function isOnline() {
  try {
    // Use /health (not /api/health) — the cloud API serves the health
    // endpoint at the root level, not under /api/.
    const response = await fetch(`${API_BASE}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── Sync Cycle ───────────────────────────────────────────────────────────────

async function syncWithCloud() {
  if (_isSyncing) {
    console.log('[CloudSync] Already syncing — skipping');
    return;
  }

  if (!_authToken) {
    console.log('[CloudSync] No auth token — skipping');
    return;
  }

  const db = localDb.getDatabase();
  if (!db) {
    console.log('[CloudSync] Local DB not ready — skipping');
    return;
  }

  // Check connectivity
  const online = await isOnline();
  if (!online) {
    console.log('[CloudSync] Offline — skipping');
    _lastError = 'offline';
    emit({ type: 'sync-skipped', reason: 'offline' });
    return;
  }

  _isSyncing = true;
  _lastError = null;
  emit({ type: 'sync-start' });

  try {
    const lastCloudSync = localDb.getLastCloudSync();
    console.log('[CloudSync] Starting sync — last sync:', new Date(lastCloudSync).toISOString());

    // ── Phase 1: Pull from cloud ──────────────────────────────────────────────
    const pullResponse = await fetch(`${API_BASE}/api/sync/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${_authToken}`,
      },
      body: JSON.stringify({
        lastPulledAt: lastCloudSync ? new Date(lastCloudSync).toISOString() : undefined,
      }),
    });

    if (!pullResponse.ok) {
      const errData = await pullResponse.json().catch(() => ({}));
      throw new Error(`Pull failed: ${pullResponse.status} — ${errData.error || pullResponse.statusText}`);
    }

    const pullData = await pullResponse.json();
    const cloudTimestamp = new Date(pullData.timestamp).getTime();
    const cloudChanges = _transformCloudChangesToLocal(pullData.changes);

    // Apply cloud changes to local SQLite
    const pullResult = localDb.applyChanges(cloudChanges);
    console.log('[CloudSync] Pull applied:', pullResult);

    // ── Phase 2: Push local changes to cloud ──────────────────────────────────
    // Get all local changes since last cloud sync
    const localChanges = localDb.getChanges(lastCloudSync, {
      agencyId: _userContext?.agencyId,
      userId: _userContext?.userId,
      role: _userContext?.role,
    });

    // Transform local changes for cloud (WDB format → server format)
    const cloudPushChanges = _transformLocalChangesToCloud(localChanges.changes);

    if (_hasChanges(cloudPushChanges)) {
      const pushResponse = await fetch(`${API_BASE}/api/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${_authToken}`,
        },
        body: JSON.stringify({
          changes: cloudPushChanges,
          lastPulledAt: pullData.timestamp,
        }),
      });

      if (!pushResponse.ok) {
        const errData = await pushResponse.json().catch(() => ({}));
        throw new Error(`Push failed: ${pushResponse.status} — ${errData.error || pushResponse.statusText}`);
      }

      console.log('[CloudSync] Push complete');
    } else {
      console.log('[CloudSync] No local changes to push');
    }

    // Update cloud sync cursor
    localDb.setLastCloudSync(cloudTimestamp);

    emit({
      type: 'sync-complete',
      stats: {
        pulled: pullResult.applied,
        pushed: _countChanges(cloudPushChanges),
      },
    });

    console.log('[CloudSync] Sync complete at', new Date(cloudTimestamp).toISOString());
  } catch (err) {
    _lastError = err.message;
    console.error('[CloudSync] Sync failed:', err.message);
    emit({ type: 'sync-error', error: err.message });
  } finally {
    _isSyncing = false;
  }
}

// ─── Transformers ────────────────────────────────────────────────────────────

/**
 * Cloud returns PascalCase model names (Agency, Service, etc.)
 * with camelCase field names and ISO date strings.
 * Local DB uses snake_case table names + snake_case columns + epoch ms.
 */
function _transformCloudChangesToLocal(cloudChanges) {
  const localChanges = {};

  const modelNameToTable = {
    Agency: 'agencies',
    Service: 'services',
    Branch: 'branches',
    Counter: 'counters',
    Reservation: 'reservations',
    Notification: 'notifications',
    QueueSettings: 'queue_settings',
  };

  for (const [modelName, modelChanges] of Object.entries(cloudChanges)) {
    const table = modelNameToTable[modelName] || modelName.toLowerCase() + 's';
    localChanges[table] = {
      created: (modelChanges.created || []).map(_cloudRecordToLocal),
      updated: (modelChanges.updated || []).map(_cloudRecordToLocal),
      deleted: modelChanges.deleted || [],
    };
  }

  return localChanges;
}

function _cloudRecordToLocal(record) {
  const result = { id: record.id };

  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    // camelCase → snake_case
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();

    // ISO date string → epoch ms
    if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      result[snakeKey] = new Date(value).getTime();
    }
    // Boolean → 1/0
    else if (typeof value === 'boolean') {
      result[snakeKey] = value ? 1 : 0;
    }
    else {
      result[snakeKey] = value;
    }
  }

  return result;
}

/**
 * Local DB uses snake_case. Cloud expects PascalCase model names
 * with camelCase fields and ISO date strings.
 */
function _transformLocalChangesToCloud(localChanges) {
  const cloudChanges = {};

  const tableNameToModel = {
    agencies: 'Agency',
    services: 'Service',
    branches: 'Branch',
    counters: 'Counter',
    reservations: 'Reservation',
    notifications: 'Notification',
    queue_settings: 'QueueSettings',
  };

  for (const [table, modelChanges] of Object.entries(localChanges)) {
    const modelName = tableNameToModel[table] || table;
    cloudChanges[modelName] = {
      created: (modelChanges.created || []).map(_localRecordToCloud),
      updated: (modelChanges.updated || []).map(_localRecordToCloud),
      deleted: modelChanges.deleted || [],
    };
  }

  return cloudChanges;
}

function _localRecordToCloud(record) {
  const result = { id: record.id };

  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue;
    // snake_case → camelCase
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

    // epoch ms → ISO string
    if (['joinedAt', 'calledAt', 'completedAt', 'cancelledAt', 'pausedAt',
         'createdAt', 'updatedAt'].includes(camelKey) && typeof value === 'number') {
      result[camelKey] = new Date(value).toISOString();
    }
    // 0/1 → boolean
    else if (camelKey.startsWith('is') || camelKey === 'fixedTimeEnabled') {
      result[camelKey] = value === 1 || value === true;
    }
    else {
      result[camelKey] = value;
    }
  }

  return result;
}

function _hasChanges(changes) {
  return Object.values(changes).some(
    (m) => m.created.length > 0 || m.updated.length > 0 || m.deleted.length > 0
  );
}

function _countChanges(changes) {
  return Object.values(changes).reduce(
    (sum, m) => sum + m.created.length + m.updated.length + m.deleted.length,
    0
  );
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

function startCloudSync() {
  if (_syncIntervalId) return;

  console.log('[CloudSync] Starting — API base:', API_BASE, 'interval:', SYNC_INTERVAL_MS / 1000, 's');

  // Initial sync after a short delay (let the app settle)
  setTimeout(() => {
    syncWithCloud().catch((err) => {
      console.error('[CloudSync] Initial sync failed:', err.message);
    });
  }, INITIAL_DELAY_MS);

  // Periodic sync
  _syncIntervalId = setInterval(() => {
    syncWithCloud().catch((err) => {
      console.error('[CloudSync] Periodic sync failed:', err.message);
    });
  }, SYNC_INTERVAL_MS);
}

function stopCloudSync() {
  if (_syncIntervalId) {
    clearInterval(_syncIntervalId);
    _syncIntervalId = null;
    console.log('[CloudSync] Stopped');
  }
}

function getStatus() {
  return {
    isSyncing: _isSyncing,
    lastSync: localDb.getLastCloudSync(),
    lastError: _lastError,
    hasAuth: !!_authToken,
    apiBase: API_BASE,
  };
}

function triggerSyncNow() {
  return syncWithCloud();
}

module.exports = {
  startCloudSync,
  stopCloudSync,
  syncWithCloud,
  triggerSyncNow,
  getStatus,
  setAuth,
  clearAuth,
  onSyncEvent,
};
