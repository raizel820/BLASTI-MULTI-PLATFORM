/**
 * BLASTI Desktop — Sync Record Sanitizer (Task 46)
 *
 * ONE shared, schema-aware guard for EVERY record that arrives from the
 * cloud (initial-sync staged import, empty-stage reconciliation, snapshot
 * bridge, incremental pull, deferred retry). It makes the local database
 * FUNCTIONAL when some fields are NULL — the "owner registered on the
 * webapp, filled only part of the profile, then opened the desktop app"
 * scenario:
 *
 *   1. UNKNOWN COLUMNS are dropped (Prisma relation objects like
 *      `branch: {...}` / `staff: null`, `_count`, and any field the local
 *      schema does not have yet). Without this, a single unknown key makes
 *      the Prisma upsert throw "Unknown argument" and the whole stage FAILS
 *      → the workspace never reaches READY → the branch list stays empty.
 *
 *   2. NULL values on NOT-NULL columns are dropped so the column's DEFAULT
 *      applies (SQLite leaves the column unset → DEFAULT fires). The cloud
 *      cannot produce these values through its own schema, but drifted /
 *      older / newer cloud builds can — and one `category: null` must never
 *      cost the entire Agency/branches import. NULL on NULLABLE columns is
 *      KEPT: it faithfully means "not set by the user yet" and propagates
 *      clears from the webapp.
 *
 *   3. TYPE DRIFT is repaired per column type (from the authoritative local
 *      DDL): booleans normalized to true/false, numbers parsed, datetimes
 *      validated (epoch numbers → ISO), objects/arrays rejected.
 *
 * The column metadata is parsed ONCE from lib/schema-init-sql.js — the same
 * authoritative DDL the local database is created from — so this map can
 * never drift from the actual SQLite schema.
 */

'use strict'

const fs = require('fs')
const path = require('path')

// ─── DDL parsing ─────────────────────────────────────────────────────────────

let _columnsByTable = null
let _parseSource = null

function _parseDdl() {
  if (_columnsByTable) return _columnsByTable
  _columnsByTable = {}
  try {
    const ddlPath = path.join(__dirname, 'schema-init-sql.js')
    const sql = require(ddlPath)
    _parseSource = ddlPath
    const createRe = /CREATE TABLE "([^"]+)" \(([\s\S]*?)\n\);/g
    let m
    while ((m = createRe.exec(sql)) !== null) {
      const table = m[1]
      const body = m[2]
      const cols = {}
      for (let line of body.split('\n')) {
        line = line.trim()
        if (!line || line.startsWith('--')) continue
        if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK)\b/i.test(line)) continue
        const cm = line.match(/^"([^"]+)"\s+([A-Za-z]+)\s*(.*)$/)
        if (!cm) continue
        const name = cm[1]
        const type = String(cm[2] || '').toUpperCase()
        const rest = cm[3] || ''
        cols[name] = {
          type,
          notNull: /NOT NULL/i.test(rest),
          hasDefault: /DEFAULT/i.test(rest),
          primaryKey: /PRIMARY KEY/i.test(rest),
        }
      }
      if (Object.keys(cols).length > 0) _columnsByTable[table] = cols
    }
    console.log(`[SyncSanitize] parsed ${Object.keys(_columnsByTable).length} table definition(s) from ${path.basename(ddlPath)}`)
  } catch (e) {
    console.warn('[SyncSanitize] DDL parse failed (records will pass through unsanitized):', e.message)
    _columnsByTable = {}
  }
  return _columnsByTable
}

/** Column metadata for a table, or null when the table is unknown/local-only. */
function getTableColumns(table) {
  return _parseDdl()[table] || null
}

// ─── Sanitizer ───────────────────────────────────────────────────────────────

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/
const NUMERIC_TYPES = new Set(['INTEGER', 'BIGINT', 'REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL'])

/**
 * Task 46: fallbacks for NOT NULL columns that carry NO database default
 * (Prisma create fails with "Argument X is missing" when the cloud arrives
 * null or omits them). Only PROFILE-ish fields get fabricated values —
 * identity/FK columns (name, ownerId, agencyId, …) are deliberately NOT
 * listed: a null there means real corruption and the record must be
 * deferred/quarantined, not silently invented.
 *
 * - Agency.category → 'OTHER' (a valid UI choice; the real value lands on
 *   the next sync update once the owner completes the profile).
 * - Agency.customCode → deterministic 'AG' + id-derived suffix (unique-ish,
 *   valid join-code shape; the cloud's real unique code overwrites it on
 *   the next update).
 */
const REQUIRED_FALLBACKS = {
  Agency: {
    category: () => 'OTHER',
    customCode: (record) => 'AG' + String((record && record.id) || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase().padEnd(6, 'X'),
  },
}

/**
 * Sanitize one cloud record against the local table definition.
 * Returns { clean, dropped } where dropped is [{ key, reason }].
 * Unknown tables pass through unchanged (local-only tables are never synced).
 */
function sanitizeSyncRecord(table, record) {
  const cols = getTableColumns(table)
  if (!cols || !record || typeof record !== 'object') {
    return { clean: record, dropped: [] }
  }

  const clean = {}
  const dropped = []

  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') { clean.id = value; continue }

    const col = cols[key]

    // 1) Unknown column — relation object, _count, or a field the local
    //    schema does not carry yet. Prisma would reject the whole record.
    if (!col) { dropped.push({ key, reason: 'unknown-column' }); continue }

    // 2) undefined → drop (Prisma treats it as "not provided"; keep the
    //    payload explicit).
    if (value === undefined) { dropped.push({ key, reason: 'undefined' }); continue }

    // 3) null — the heart of the "fields not set by the user yet" contract:
    //    - NOT NULL column  → the column's DEFAULT applies (drop the key);
    //      a column with NO default gets a REQUIRED_FALLBACKS value when one
    //      is defined (profile-ish fields), otherwise the key is dropped and
    //      the record legitimately fails/defers (identity corruption).
    //    - NULLABLE column  → KEEP the null: it legitimately means
    //      "not set yet / cleared on the webapp" and must propagate.
    if (value === null) {
      if (col.notNull) {
        const fallback = REQUIRED_FALLBACKS[table] && REQUIRED_FALLBACKS[table][key]
        if (fallback) {
          clean[key] = fallback(record)
          _tagFallbackKey(clean, key)
          dropped.push({ key, reason: 'null-fallback' })
        } else {
          dropped.push({ key, reason: 'null-on-not-null' })
        }
        continue
      }
      clean[key] = null
      continue
    }

    // 4) Objects / arrays — no Prisma Json columns exist in this schema
    //    (they were deliberately converted to plain strings for byte-exact
    //    sync), so every object here is a nested relation that the upsert
    //    contract cannot persist.
    if (typeof value === 'object') {
      if (value instanceof Date) {
        clean[key] = value.toISOString()
        continue
      }
      dropped.push({ key, reason: 'object' })
      continue
    }

    // 5) Per-type scalar repair.
    if (col.type === 'BOOLEAN') {
      if (typeof value === 'boolean') { clean[key] = value; continue }
      if (value === 1 || value === 0) { clean[key] = value === 1; continue }
      if (value === 'true' || value === 'false') { clean[key] = value === 'true'; continue }
      dropped.push({ key, reason: 'invalid-boolean' })
      continue
    }

    if (NUMERIC_TYPES.has(col.type)) {
      if (typeof value === 'number' && isFinite(value)) { clean[key] = value; continue }
      if (typeof value === 'string' && value.trim() !== '' && isFinite(Number(value))) {
        clean[key] = Number(value)
        continue
      }
      dropped.push({ key, reason: 'invalid-number' })
      continue
    }

    if (col.type === 'DATETIME') {
      if (typeof value === 'string' && ISO_DATETIME_RE.test(value)) { clean[key] = value; continue }
      // epoch-millis number → ISO (legacy local rows / drifted feeds)
      if (typeof value === 'number' && value > 1e11 && value < 4e12) {
        clean[key] = new Date(value).toISOString()
        continue
      }
      dropped.push({ key, reason: 'invalid-datetime' })
      continue
    }

    // TEXT and everything else — keep any scalar as-is.
    clean[key] = value
  }

  // 6) Missing NOT-NULL-no-default columns with a defined fallback — a
  //    drifted feed that omits them entirely would fail the create the same
  //    way a null would. Inject the fallback so the import succeeds.
  const tableFallbacks = REQUIRED_FALLBACKS[table]
  if (tableFallbacks) {
    for (const [key, fallback] of Object.entries(tableFallbacks)) {
      if (!(key in clean) && cols[key]) {
        clean[key] = fallback(record)
        _tagFallbackKey(clean, key)
        dropped.push({ key, reason: 'missing-fallback' })
      }
    }
  }

  return { clean, dropped }
}

/** Human-readable one-line summary of a dropped-keys array (for logs). */
function formatDropped(dropped) {
  if (!dropped || dropped.length === 0) return ''
  return dropped.map((d) => `${d.key}(${d.reason})`).join(', ')
}

/**
 * Symbol-tag on a sanitized record listing keys whose values were FABRICATED
 * by the fallback mechanism (not real cloud data). Symbols are invisible to
 * Object.entries/JSON.stringify, so the tag travels with the record without
 * polluting payloads or SQL. Consumers MUST exclude these keys from UPDATE
 * paths — the local row may already hold the user's real value, and a
 * drifted cloud payload must never reset it. Create paths keep them.
 */
const FALLBACK_KEYS = Symbol('syncFallbackKeys')

function _tagFallbackKey(clean, key) {
  if (!Array.isArray(clean[FALLBACK_KEYS])) clean[FALLBACK_KEYS] = []
  clean[FALLBACK_KEYS].push(key)
}

/** Fallback-fabricated keys for a sanitized record (empty when none). */
function getFallbackKeys(cleanRecord) {
  if (!cleanRecord || typeof cleanRecord !== 'object') return []
  return Array.isArray(cleanRecord[FALLBACK_KEYS]) ? cleanRecord[FALLBACK_KEYS] : []
}

/**
 * Carry the fallback tag from a sanitized record onto a transformed copy
 * (symbol props are invisible to Object.entries — assign directly).
 */
function copyFallbackTags(from, to) {
  if (from && to && typeof to === 'object' && Array.isArray(from[FALLBACK_KEYS])) {
    to[FALLBACK_KEYS] = from[FALLBACK_KEYS].slice()
  }
  return to
}

/**
 * Shallow copy of a record WITHOUT the fallback-fabricated keys (and the
 * tag symbol) — the shape UPDATE paths must persist so a drifted payload
 * can never reset a real local value.
 */
function stripFallbackKeys(record) {
  if (!record || typeof record !== 'object') return record
  const fb = getFallbackKeys(record)
  const out = {}
  for (const [key, value] of Object.entries(record)) {
    if (fb.indexOf(key) !== -1) continue
    out[key] = value
  }
  return out
}

module.exports = {
  sanitizeSyncRecord,
  getTableColumns,
  formatDropped,
  getFallbackKeys,
  copyFallbackTags,
  stripFallbackKeys,
}
