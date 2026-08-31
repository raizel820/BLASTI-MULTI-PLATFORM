/**
 * BLASTI Desktop — Local SQLite Sync Cache
 *
 * Main-process SQLite database that acts as the LAN sync hub.
 * Kiosks and tablets on the LAN sync to THIS database (via the
 * /api/sync/pull and /api/sync/push endpoints on port 3080),
 * and the desktop's own cloud-sync loop pushes/pulls to the
 * remote server when internet is available.
 *
 * Architecture:
 *   Kiosk (WDB/LokiJS)  ──LAN sync──►  Desktop SQLite (this file)
 *                                            │
 *                                            │ cloud sync loop
 *                                            ▼
 *                                      Cloud /api/sync/*
 *
 * This is NOT a full WatermelonDB instance — it's a lightweight
 * sync cache that speaks the WatermelonDB sync protocol so kiosks
 * can use their existing synchronize() call without modification.
 *
 * Storage: better-sqlite3 (synchronous, fast, file-based)
 * File: <userData>/blasti-lan-sync.db
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Lazy-load better-sqlite3 (native addon — may need electron-rebuild)
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.error('[LocalDB] better-sqlite3 could not be loaded:', err.message);
  console.error('[LocalDB] LAN sync will be disabled. Run: cd apps/desktop && npx electron-rebuild -f -w better-sqlite3');
  Database = null;
}

// ─── Schema Definition ──────────────────────────────────────────────────────

const SYNC_TABLES = [
  'agencies',
  'services',
  'branches',
  'counters',
  'reservations',
  'notifications',
  'queue_settings',
];

// Per-table column definitions (snake_case to match WDB schema)
const TABLE_COLUMNS = {
  agencies: [
    'name', 'name_fr', 'name_ar', 'custom_code', 'category', 'address', 'city',
    'phone', 'email', 'average_service_time', 'max_active_reservations',
    'is_queue_open', 'subscription_tier', 'subscription_status',
    'working_hours_start', 'working_hours_end', 'is_active',
  ],
  services: ['agency_id', 'name', 'name_fr', 'name_ar', 'prefix', 'is_active'],
  branches: ['agency_id', 'name', 'name_ar', 'name_fr', 'address', 'phone', 'is_main', 'is_active'],
  counters: ['branch_id', 'number', 'name', 'name_ar', 'name_fr', 'is_active'],
  reservations: [
    'user_id', 'agency_id', 'service_id', 'queue_number', 'display_number',
    'status', 'estimated_wait', 'joined_at', 'called_at', 'completed_at',
    'cancelled_at', 'preferred_time', 'fixed_time_enabled', 'postpone_count',
    'is_walk_in', 'walk_in_customer_name', 'counter_id', 'sync_device_id',
    'offline_created_at',
  ],
  notifications: ['user_id', 'type', 'title', 'message', 'is_read', 'entity_id'],
  queue_settings: ['agency_id', 'current_serving_number', 'last_issued_number', 'is_paused', 'paused_at'],
};

// ─── Database Singleton ──────────────────────────────────────────────────────

let _db = null;
let _dbPath = null;

/**
 * Initialize the SQLite database.
 * @param {string} userDataPath - Electron app.getPath('userData')
 * @returns {object|null} better-sqlite3 instance, or null if unavailable
 */
function initDatabase(userDataPath) {
  if (_db) return _db;
  if (!Database) {
    console.warn('[LocalDB] Cannot init — better-sqlite3 not available');
    return null;
  }

  _dbPath = path.join(userDataPath, 'blasti-lan-sync.db');
  console.log('[LocalDB] Opening database at:', _dbPath);

  try {
    _db = new Database(_dbPath, {
      // WAL mode for better concurrent read performance
      // (kiosks reading while desktop writes)
      fileMustExist: false,
      readonly: false,
    });

    // Enable WAL mode + optimizations
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');

    _createSchema(_db);
    console.log('[LocalDB] Schema ready —', SYNC_TABLES.length, 'tables');
    return _db;
  } catch (err) {
    console.error('[LocalDB] Failed to open database:', err.message);
    _db = null;
    return null;
  }
}

/**
 * Create the sync cache schema.
 * Each table has: id (PK), all model columns, created_at, updated_at, deleted_at (tombstone)
 */
function _createSchema(db) {
  // Track cloud sync cursor (last successful cloud pull/push timestamp)
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  for (const table of SYNC_TABLES) {
    const columns = TABLE_COLUMNS[table];
    const columnDefs = [
      'id TEXT PRIMARY KEY',
      ...columns.map((col) => {
        // Boolean columns stored as INTEGER (0/1) for WDB compatibility
        if (col.startsWith('is_') || col === 'fixed_time_enabled') {
          return `${col} INTEGER DEFAULT 0`;
        }
        // Number columns
        if (['average_service_time', 'max_active_reservations', 'queue_number',
             'estimated_wait', 'postpone_count', 'number',
             'current_serving_number', 'last_issued_number'].includes(col)) {
          return `${col} INTEGER`;
        }
        // Timestamp columns (stored as ms epoch for WDB compatibility)
        if (['joined_at', 'called_at', 'completed_at', 'cancelled_at', 'paused_at'].includes(col)) {
          return `${col} INTEGER`;
        }
        return `${col} TEXT`;
      }),
      'created_at INTEGER NOT NULL',
      'updated_at INTEGER NOT NULL',
      'deleted_at INTEGER DEFAULT NULL', // tombstone: non-null = deleted
    ].join(', ');

    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${columnDefs});`);

    // Index for incremental sync queries (WHERE updated_at > ?)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_updated ON ${table}(updated_at);`);
    // Index for filtering by agency (most queries scope to agency)
    if (columns.includes('agency_id')) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_agency ON ${table}(agency_id);`);
    }
  }
}

/**
 * Get the database instance. Returns null if not initialized.
 */
function getDatabase() {
  return _db;
}

// ─── Sync Protocol Implementation ────────────────────────────────────────────

/**
 * Get changes since a given timestamp (for /api/sync/pull).
 * @param {number} since - epoch ms, or 0 for full sync
 * @param {object} options - { agencyId?: string, userId?: string, role?: string }
 * @returns {{ changes: object, timestamp: number }}
 */
function getChanges(since = 0, options = {}) {
  if (!_db) return { changes: {}, timestamp: Date.now() };

  const sinceMs = since || 0;
  const changes = {};
  const now = Date.now();

  for (const table of SYNC_TABLES) {
    const modelChanges = { created: [], updated: [], deleted: [] };

    // Build WHERE clause
    const whereParts = ['updated_at >= ?'];
    const params = [sinceMs];

    // Scope to agency for non-admin users
    if (options.agencyId && TABLE_COLUMNS[table].includes('agency_id')) {
      whereParts.push('agency_id = ?');
      params.push(options.agencyId);
    }

    const whereClause = whereParts.join(' AND ');

    // Fetch created/updated records (deleted_at IS NULL)
    const rows = _db.prepare(
      `SELECT * FROM ${table} WHERE ${whereClause} AND deleted_at IS NULL`
    ).all(...params);

    for (const row of rows) {
      const transformed = _transformRowForClient(table, row);
      if (row.created_at > sinceMs) {
        modelChanges.created.push(transformed);
      } else {
        modelChanges.updated.push(transformed);
      }
    }

    // Fetch deleted record IDs (tombstones)
    const deletedRows = _db.prepare(
      `SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND updated_at >= ?`
    ).all(sinceMs);
    modelChanges.deleted = deletedRows.map((r) => r.id);

    changes[table] = modelChanges;
  }

  return { changes, timestamp: now };
}

/**
 * Apply incoming changes from a client (for /api/sync/push).
 * @param {object} changes - { table: { created: [], updated: [], deleted: [] } }
 * @returns {{ applied: number, rejected: number }}
 */
function applyChanges(changes) {
  if (!_db) return { applied: 0, rejected: 0 };

  let applied = 0;
  let rejected = 0;
  const now = Date.now();

  const upsertStmt = _db.prepare(`
    INSERT INTO ${'_placeholder'} (id, created_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = ?
  `);

  const transaction = _db.transaction(() => {
    for (const [table, modelChanges] of Object.entries(changes)) {
      if (!SYNC_TABLES.includes(table)) {
        console.warn('[LocalDB] Unknown table in push:', table);
        rejected += (modelChanges.created?.length || 0) +
                    (modelChanges.updated?.length || 0) +
                    (modelChanges.deleted?.length || 0);
        continue;
      }

      const columns = TABLE_COLUMNS[table];
      const allColumns = ['id', ...columns, 'created_at', 'updated_at', 'deleted_at'];
      const placeholders = allColumns.map(() => '?').join(', ');
      const updateSet = columns
        .map((c) => `${c} = excluded.${c}`)
        .concat(['updated_at = excluded.updated_at'])
        .join(', ');

      const stmt = _db.prepare(
        `INSERT INTO ${table} (${allColumns.join(', ')})
         VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updateSet}`
      );

      const deleteStmt = _db.prepare(
        `UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`
      );

      // Process created
      for (const record of modelChanges.created || []) {
        try {
          const values = _transformRecordForDb(table, record, now);
          stmt.run(...values);
          applied++;
        } catch (err) {
          console.warn('[LocalDB] Failed to insert into', table, ':', err.message);
          rejected++;
        }
      }

      // Process updated
      for (const record of modelChanges.updated || []) {
        try {
          const values = _transformRecordForDb(table, record, now);
          stmt.run(...values);
          applied++;
        } catch (err) {
          console.warn('[LocalDB] Failed to update', table, ':', err.message);
          rejected++;
        }
      }

      // Process deleted (create tombstone)
      for (const id of modelChanges.deleted || []) {
        try {
          deleteStmt.run(now, now, id);
          applied++;
        } catch (err) {
          console.warn('[LocalDB] Failed to delete from', table, ':', err.message);
          rejected++;
        }
      }
    }
  });

  try {
    transaction();
  } catch (err) {
    console.error('[LocalDB] Transaction failed:', err.message);
    return { applied: 0, rejected: applied + rejected };
  }

  console.log(`[LocalDB] Applied ${applied} changes, rejected ${rejected}`);
  return { applied, rejected };
}

// ─── Transformers ────────────────────────────────────────────────────────────

/**
 * Transform a DB row for client (WDB format).
 * - snake_case keys preserved (WDB expects snake_case)
 * - Booleans → 1/0 (WDB boolean)
 * - ISO date strings → epoch ms (WDB date)
 */
function _transformRowForClient(table, row) {
  const result = { id: row.id };

  for (const [key, value] of Object.entries(row)) {
    if (key === 'id') continue;
    // Pass through created_at/updated_at as epoch ms
    if (key === 'created_at' || key === 'updated_at') {
      result[key] = value;
      continue;
    }
    // Skip deleted_at (internal tombstone field)
    if (key === 'deleted_at') continue;
    result[key] = value;
  }

  return result;
}

/**
 * Transform an incoming client record for DB storage.
 * Returns an array of values matching allColumns order.
 */
function _transformRecordForDb(table, record, now) {
  const columns = TABLE_COLUMNS[table];
  const allColumns = ['id', ...columns, 'created_at', 'updated_at', 'deleted_at'];
  const values = [];

  for (const col of allColumns) {
    if (col === 'id') {
      values.push(record.id || crypto.randomUUID());
    } else if (col === 'created_at') {
      values.push(record.created_at || now);
    } else if (col === 'updated_at') {
      values.push(now);
    } else if (col === 'deleted_at') {
      values.push(null);
    } else {
      let val = record[col];
      // Boolean columns → 0/1
      if (col.startsWith('is_') || col === 'fixed_time_enabled') {
        val = val ? 1 : 0;
      }
      // Date columns: ISO string → epoch ms
      if (['joined_at', 'called_at', 'completed_at', 'cancelled_at', 'paused_at'].includes(col)) {
        if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}/)) {
          val = new Date(val).getTime();
        }
        if (val === undefined || val === null) val = null;
      }
      values.push(val === undefined ? null : val);
    }
  }

  return values;
}

// ─── Sync Meta (cloud cursor) ─────────────────────────────────────────────────

function getSyncMeta(key) {
  if (!_db) return null;
  const row = _db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSyncMeta(key, value) {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`
  ).run(key, value, Date.now(), value, Date.now());
}

function getLastCloudSync() {
  const v = getSyncMeta('last_cloud_sync');
  return v ? parseInt(v, 10) : 0;
}

function setLastCloudSync(ts) {
  setSyncMeta('last_cloud_sync', String(ts));
}

// ─── Query Helpers (for desktop UI via IPC) ──────────────────────────────────

function query(table, options = {}) {
  if (!_db) return [];
  if (!SYNC_TABLES.includes(table)) return [];

  const whereParts = ['deleted_at IS NULL'];
  const params = [];

  if (options.agencyId && TABLE_COLUMNS[table].includes('agency_id')) {
    whereParts.push('agency_id = ?');
    params.push(options.agencyId);
  }

  let sql = `SELECT * FROM ${table} WHERE ${whereParts.join(' AND ')}`;
  if (options.limit) {
    sql += ` LIMIT ?`;
    params.push(options.limit);
  }

  return _db.prepare(sql).all(...params).map((row) => _transformRowForClient(table, row));
}

function getById(table, id) {
  if (!_db || !SYNC_TABLES.includes(table)) return null;
  const row = _db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
  return row ? _transformRowForClient(table, row) : null;
}

function count(table, options = {}) {
  if (!_db || !SYNC_TABLES.includes(table)) return 0;
  const whereParts = ['deleted_at IS NULL'];
  const params = [];

  if (options.agencyId && TABLE_COLUMNS[table].includes('agency_id')) {
    whereParts.push('agency_id = ?');
    params.push(options.agencyId);
  }

  const row = _db.prepare(
    `SELECT COUNT(*) as cnt FROM ${table} WHERE ${whereParts.join(' AND ')}`
  ).get(...params);
  return row ? row.cnt : 0;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function close() {
  if (_db) {
    try {
      _db.close();
      console.log('[LocalDB] Database closed');
    } catch (err) {
      console.error('[LocalDB] Error closing database:', err.message);
    }
    _db = null;
  }
}

module.exports = {
  SYNC_TABLES,
  TABLE_COLUMNS,
  initDatabase,
  getDatabase,
  getChanges,
  applyChanges,
  getSyncMeta,
  setSyncMeta,
  getLastCloudSync,
  setLastCloudSync,
  query,
  getById,
  count,
  close,
};
