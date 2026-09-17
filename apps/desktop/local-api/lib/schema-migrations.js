/**
 * BLASTI Desktop — Controlled Local SQLite Schema Management
 * ═════════════════════════════════════════════════════════════════════════
 *
 * THE authoritative, NON-DESTRUCTIVE schema lifecycle for the desktop local
 * database. This module REPLACES the old `prisma db push --accept-data-loss`
 * startup mechanism, which was destructive: when the shared Prisma schema
 * drifted from the local database it dropped untracked tables — including
 * `_sync_meta` — silently destroying the sync cursor and local sync state
 * ("no such table: _sync_meta" after every schema-affecting release).
 *
 * Lifecycle implemented here (spec §3):
 *
 *   detect current DB schema/version
 *        ↓
 *   apply only required safe migrations
 *        ↓
 *   preserve existing data
 *        ↓
 *   verify required tables
 *        ↓
 *   continue
 *
 * Rules enforced by this module:
 *   - NEVER drops a table. NEVER drops a column. NEVER recreates an existing
 *     database. There is no code path here that can erase user/agency data.
 *   - The sync infrastructure tables (`_sync_meta`, `_sync_conflicts`,
 *     `_pending_mutations`, `_sync_applied_mutations`) are created with
 *     CREATE TABLE IF NOT EXISTS and are additionally declared in the shared
 *     Prisma schema (LocalSyncMeta / LocalSyncConflict / LocalPendingMutation /
 *     LocalSyncAppliedMutation) so even a dev-time `prisma db push` cannot
 *     remove them.
 *   - Schema version is stamped in `_sync_meta` ('schema_version'). Existing
 *     databases created by the legacy db-push mechanism are recognized,
 *     verified, topped-up with any missing infrastructure, and stamped —
 *     their data is never touched.
 *   - First-time creation applies the full embedded DDL
 *     (lib/schema-init-sql.js, generated from the shared Prisma schema) with
 *     IF NOT EXISTS hardening, so creation is idempotent and safe to
 *     re-run over any partial state.
 *   - Works fully self-contained at runtime (no Prisma CLI, no monorepo
 *     directory, no network) — packaged-app safe.
 *
 * Future schema upgrades: append a step to MIGRATION_STEPS with the next
 * version number. Only missing versions run. Upgrades must be additive
 * (CREATE ... IF NOT EXISTS / ALTER TABLE ADD COLUMN guarded by introspection).
 */

const fs = require('fs')
const path = require('path')

// ─── Versioning ─────────────────────────────────────────────────────────────

/** Current local schema version. Bump when adding MIGRATION_STEPS. */
const LOCAL_SCHEMA_VERSION = 1

/**
 * Incremental upgrade steps BETWEEN versions. Each step:
 *   { version: <int>, name: <string>, statements: [sql, ...] }
 * Steps run in ascending order for any DB whose stamped version is lower
 * than the step version. Statements must be idempotent/additive.
 */
const MIGRATION_STEPS = []

// ─── Embedded first-creation DDL ────────────────────────────────────────────

const SCHEMA_INIT_SQL = require('./schema-init-sql')

// ─── Protected sync infrastructure tables ───────────────────────────────────
// Must stay byte-compatible with the Prisma models (LocalSyncMeta etc.) and
// with the runtime DDL in sync-service.js / index.js.

const SYNC_INFRA_DDL = [
  'CREATE TABLE IF NOT EXISTS "_sync_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "_sync_conflicts" ("id" TEXT PRIMARY KEY, "modelName" TEXT NOT NULL, "recordId" TEXT NOT NULL, "agencyId" TEXT, "localVersion" BIGINT, "cloudVersion" BIGINT, "localData" TEXT, "cloudData" TEXT, "resolution" TEXT DEFAULT \'pending\', "resolvedAt" BIGINT, "createdAt" BIGINT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_model" ON "_sync_conflicts"("modelName")',
  'CREATE INDEX IF NOT EXISTS "idx_sync_conflicts_resolution" ON "_sync_conflicts"("resolution")',
  'CREATE TABLE IF NOT EXISTS "_pending_mutations" ("id" TEXT PRIMARY KEY, "method" TEXT NOT NULL, "path" TEXT NOT NULL, "body" TEXT, "headers" TEXT, "status" TEXT NOT NULL DEFAULT \'pending\', "attempts" INTEGER NOT NULL DEFAULT 0, "max_attempts" INTEGER NOT NULL DEFAULT 5, "created_at" BIGINT NOT NULL, "last_attempt_at" BIGINT, "next_retry_at" BIGINT, "last_http_status" INTEGER, "last_error" TEXT, "response_data" TEXT, "idempotency_key" TEXT)',
  'CREATE INDEX IF NOT EXISTS "idx_pending_mutations_status" ON "_pending_mutations"("status")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "idx_pending_mutations_idem" ON "_pending_mutations"("idempotency_key")',
  'CREATE TABLE IF NOT EXISTS "_sync_applied_mutations" ("key" TEXT PRIMARY KEY, "appliedAt" BIGINT NOT NULL)',
  // Part K: durable deferred-change queue — a dependency-failed change is
  // PERSISTED here before the pull cursor may advance past it. Never in-memory.
  'CREATE TABLE IF NOT EXISTS "_deferred_changes" ("id" TEXT PRIMARY KEY, "agencyId" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT \'pull\', "sequence" INTEGER, "stage" TEXT, "model" TEXT NOT NULL, "recordId" TEXT NOT NULL, "operation" TEXT NOT NULL, "payload" TEXT, "dependencyError" TEXT, "retryCount" INTEGER NOT NULL DEFAULT 0, "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "lastRetryAt" DATETIME, "nextRetryAt" DATETIME, "status" TEXT NOT NULL DEFAULT \'PENDING\', "lastError" TEXT)',
  'CREATE INDEX IF NOT EXISTS "idx_deferred_agency_status" ON "_deferred_changes"("agencyId", "status")',
  'CREATE INDEX IF NOT EXISTS "idx_deferred_status_next" ON "_deferred_changes"("status", "nextRetryAt")',
]

const SYNC_INFRA_TABLES = [
  '_sync_meta',
  '_sync_conflicts',
  '_pending_mutations',
  '_sync_applied_mutations',
  '_deferred_changes',
]

// ─── Required-table verification list ───────────────────────────────────────
// The 19 synced models come from the sync registry when available; core
// operational/infrastructure tables are always required.

const CORE_REQUIRED_TABLES = [
  // sessions & identity
  'User',
  // agency + dataset
  'Agency', 'AgencyStaff', 'Service', 'Branch', 'Counter',
  'QueueSettings', 'Reservation',
  // sync engine infrastructure
  'SyncChange', 'SyncMutation', 'AgencyLocalState', 'DeletedRecord',
  // protected sync tables
  ...SYNC_INFRA_TABLES,
]

function loadRegistryModels() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', '..', 'packages', 'core', 'sync-registry.json'),
    path.join(__dirname, 'sync-registry.json'), // packaged copy
  ]
  for (const p of candidates) {
    try {
      const reg = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (Array.isArray(reg.syncedModels) && reg.syncedModels.length > 0) {
        return reg.syncedModels
      }
    } catch { /* try next */ }
  }
  // Frozen fallback mirrors packages/core/sync-registry.json (protocol v2)
  return ['Agency', 'User', 'AgencyStaff', 'Service', 'Branch', 'Counter', 'QueueSettings',
    'Reservation', 'Transaction', 'SmsSettings', 'PaymentSettings', 'Notification',
    'Announcement', 'GlobalAnnouncement', 'Review', 'Favorite', 'FAQ',
    'SubscriptionPlan', 'PlanFeature']
}

// ─── SQL utilities ──────────────────────────────────────────────────────────

/**
 * Split a SQL script into individual statements. Quote-aware: semicolons
 * inside single-quoted string literals never split.
 */
function splitSqlStatements(sql) {
  const out = []
  let current = ''
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (c === "'") {
      inString = !inString
      current += c
    } else if (c === ';' && !inString) {
      if (current.trim()) out.push(current.trim())
      current = ''
    } else {
      current += c
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** Strip comment-only lines from a Prisma migrate diff script. */
function stripCommentLines(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
}

/** Harden CREATE statements so they can run safely over existing objects. */
function hardenCreate(sql) {
  return sql
    .replace(/CREATE TABLE "/g, 'CREATE TABLE IF NOT EXISTS "')
    .replace(/CREATE UNIQUE INDEX "/g, 'CREATE UNIQUE INDEX IF NOT EXISTS "')
    .replace(/CREATE INDEX "/g, 'CREATE INDEX IF NOT EXISTS "')
}

async function listTables(db) {
  const rows = await db.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  return (rows || []).map((r) => r.name)
}

async function tableColumns(db, table) {
  try {
    const rows = await db.$queryRawUnsafe(`PRAGMA table_info("${table}")`)
    return (rows || []).map((r) => r.name)
  } catch {
    return []
  }
}

/**
 * Parse the embedded init DDL into { table: { column: addColumnSqlFragment } }.
 * Used for additive column top-up on databases created by older schema
 * versions (the historic destructive db-push handled this by recreating
 * tables — we do it with guarded ALTER TABLE ADD COLUMN instead).
 */
function parseDdlColumns(initSql) {
  const map = {}
  const statements = splitSqlStatements(stripCommentLines(initSql))
  for (const stmt of statements) {
    const m = stmt.match(/^CREATE TABLE "([^"]+)"\s*\(([\s\S]*)\)\s*$/)
    if (!m) continue
    const table = m[1]
    const body = m[2]
    // Split top-level commas only (respect nested parens in FOREIGN KEY(...)).
    const parts = []
    let depth = 0
    let cur = ''
    let inStr = false
    for (const c of body) {
      if (c === "'") { inStr = !inStr; cur += c; continue }
      if (!inStr) {
        if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
      }
      cur += c
    }
    if (cur.trim()) parts.push(cur)
    const cols = {}
    for (const raw of parts) {
      const part = raw.trim()
      const cm = part.match(/^"([^"]+)"\s+(.*)$/s)
      if (!cm) continue // table-level constraint (PRIMARY KEY / FOREIGN KEY / UNIQUE)
      const colName = cm[1]
      let def = cm[2].trim()
      // Transform to an ADD COLUMN fragment SQLite accepts:
      def = def.replace(/\bPRIMARY KEY\b/gi, '')
      // NOT NULL without DEFAULT is illegal in ADD COLUMN → make nullable.
      const hasDefault = /\bDEFAULT\b/i.test(def)
      if (!hasDefault) def = def.replace(/\bNOT NULL\b/gi, '')
      // Non-constant defaults (now()) are illegal in ADD COLUMN → drop them.
      const dm = def.match(/\bDEFAULT\s+(now\(\)|CURRENT_TIMESTAMP)/i)
      if (dm) def = def.replace(dm[0], '')
      // REFERENCES cannot always be attached via ADD COLUMN — strip (FKs are
      // enforced at the application layer for top-up columns).
      def = def.replace(/\bREFERENCES\s+[^,]*/gi, '')
      def = def.replace(/\s+/g, ' ').trim().replace(/,$/, '')
      cols[colName] = def
    }
    map[table] = cols
  }
  return map
}

// ─── Meta helpers (self-bootstrapping) ──────────────────────────────────────

async function ensureMetaTable(db) {
  await db.$executeRawUnsafe(
    'CREATE TABLE IF NOT EXISTS "_sync_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)'
  )
}

async function getMeta(db, key) {
  try {
    const rows = await db.$queryRawUnsafe('SELECT value FROM "_sync_meta" WHERE key = ?', key)
    return rows && rows[0] ? String(rows[0].value) : null
  } catch {
    return null
  }
}

async function setMeta(db, key, value) {
  await db.$executeRawUnsafe(
    'INSERT INTO "_sync_meta" ("key", "value") VALUES (?, ?) ' +
    'ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"',
    key, String(value)
  )
}

// ─── Execution ──────────────────────────────────────────────────────────────

async function runStatements(db, statements, { tolerant = false } = {}) {
  const errors = []
  for (const stmt of statements) {
    try {
      await db.$executeRawUnsafe(stmt)
    } catch (err) {
      const msg = err?.message || String(err)
      // Benign when running hardened DDL over existing objects.
      const benign = /already exists/i.test(msg)
      if (tolerant && benign) continue
      errors.push({ statement: stmt.substring(0, 100), error: msg })
    }
  }
  return errors
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure the local database schema is present, current, and verified —
 * WITHOUT any destructive operation. Safe to call on every startup.
 *
 * @param {PrismaClient} db  The local Prisma client (SQLite).
 * @param {object} [opts]    { log?: (msg:string)=>void }
 * @returns {Promise<{ok:boolean, action:string, version:number,
 *                   tables:number, errors:object[], verified:string[]}>}
 */
async function ensureSchema(db, opts = {}) {
  const log = opts.log || ((m) => console.log(`[LocalDB] ${m}`))
  const result = { ok: false, action: 'unknown', version: 0, tables: 0, errors: [], verified: [] }

  if (!db) {
    result.action = 'no-database-client'
    result.errors.push({ error: 'Prisma client is not available' })
    return result
  }

  // 0. Bootstrap metadata table (never fails an existing DB — IF NOT EXISTS)
  await ensureMetaTable(db)

  // 1. Detect current state
  const tables = await listTables(db)
  result.tables = tables.length
  const stampedVersion = parseInt(await getMeta(db, 'schema_version') || '0', 10) || 0
  const businessTables = tables.filter((t) => !SYNC_INFRA_TABLES.includes(t))
  const isFresh = businessTables.length === 0

  // 2. Apply the correct path — every branch preserves data.
  if (isFresh) {
    // First-time creation: full embedded DDL (harden → idempotent).
    log('No existing tables — creating local schema (first-time initialization)')
    const statements = splitSqlStatements(stripCommentLines(SCHEMA_INIT_SQL)).map(hardenCreate)
    const errs = await runStatements(db, statements)
    if (errs.length) {
      result.action = 'create-failed'
      result.errors.push(...errs)
      log(`ERROR: schema creation had ${errs.length} failing statement(s): ${errs[0]?.error}`)
      return result
    }
    await setMeta(db, 'schema_version', LOCAL_SCHEMA_VERSION)
    await setMeta(db, 'schema_created_at', String(Date.now()))
    result.action = 'created'
    result.version = LOCAL_SCHEMA_VERSION
    log(`Schema created (version ${LOCAL_SCHEMA_VERSION}, ${statements.length} statements)`)
  } else if (stampedVersion === 0) {
    // Existing database from the legacy db-push era: no version stamp.
    // DO NOT recreate. Verify + top up missing infrastructure + stamp.
    log(`Existing local database detected (${tables.length} tables, no schema version) — adopting non-destructively`)
    const infraErrs = await runStatements(db, SYNC_INFRA_DDL.map(hardenCreate), { tolerant: true })
    if (infraErrs.length) {
      result.action = 'adopt-failed'
      result.errors.push(...infraErrs)
      log(`ERROR: infrastructure top-up failed: ${infraErrs[0]?.error}`)
      return result
    }
    await _ensurePendingMutationsIdempotencyColumn(db, log)
    await setMeta(db, 'schema_version', LOCAL_SCHEMA_VERSION)
    await setMeta(db, 'schema_adopted_at', String(Date.now()))
    result.action = 'adopted-legacy'
    result.version = LOCAL_SCHEMA_VERSION
    log(`Legacy database adopted and stamped as schema version ${LOCAL_SCHEMA_VERSION} — data preserved`)
  } else {
    // Stamped database — run any pending incremental upgrades.
    let applied = 0
    for (const step of MIGRATION_STEPS) {
      if (step.version > stampedVersion && step.version <= LOCAL_SCHEMA_VERSION) {
        log(`Applying migration v${step.version}: ${step.name}`)
        const errs = await runStatements(db, step.statements.map(hardenCreate))
        if (errs.length) {
          result.action = 'upgrade-failed'
          result.errors.push(...errs)
          log(`ERROR: migration v${step.version} failed: ${errs[0]?.error}`)
          result.version = stampedVersion
          return result
        }
        await setMeta(db, 'schema_version', step.version)
        result.version = step.version
        applied++
      }
    }
    result.action = applied > 0 ? 'upgraded' : 'up-to-date'
    result.version = applied > 0 ? LOCAL_SCHEMA_VERSION : stampedVersion
    if (applied === 0) log(`Schema version ${stampedVersion} is up to date`)
    // Opportunistic top-up of protected tables (IF NOT EXISTS — zero-risk).
    await runStatements(db, SYNC_INFRA_DDL.map(hardenCreate), { tolerant: true })
    await _ensurePendingMutationsIdempotencyColumn(db, log)
  }

  // 3. CONVERGENCE TOP-UP — bring ANY database shape up to the current schema
  //    additively (data never touched):
  //    a. missing TABLES ← init DDL (hardened CREATE IF NOT EXISTS)
  //    b. missing COLUMNS on required tables ← guarded ALTER TABLE ADD COLUMN
  const finalTables = await listTables(db)
  result.tables = finalTables.length
  const registryModels = loadRegistryModels()
  const required = [...new Set([...CORE_REQUIRED_TABLES, ...registryModels])]
  const missingTables = required.filter((t) => !finalTables.includes(t))
  if (missingTables.length > 0) {
    // Apply only the DDL statements for missing tables (+ their indexes).
    const allStatements = splitSqlStatements(stripCommentLines(SCHEMA_INIT_SQL)).map(hardenCreate)
    const relevant = allStatements.filter((s) => {
      const tm = s.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/)
      const target = tm ? tm[1] : null
      if (target) return missingTables.includes(target)
      // Index statements: keep only when their parent table is among the
      // tables being created — an index over an absent table would fail
      // (SQLite validates FK/index parent tables at prepare time).
      const im = s.match(/ON "([^"]+)"/)
      return im ? missingTables.includes(im[1]) : false
    })
    const errs = await runStatements(db, relevant, { tolerant: true })
    if (errs.length) {
      result.action = 'topup-failed'
      result.errors.push(...errs)
      log(`ERROR: missing-table top-up failed: ${errs[0]?.error}`)
      return result
    }
    log(`Top-up created missing tables: ${missingTables.join(', ')}`)
  }

  // Column top-up (additive only).
  try {
    const expected = parseDdlColumns(SCHEMA_INIT_SQL)
    const addedCols = []
    for (const table of required) {
      const cols = expected[table]
      if (!cols) continue
      const existingCols = new Set(await tableColumns(db, table))
      if (existingCols.size === 0) continue // table missing entirely — handled above
      for (const [colName, colDef] of Object.entries(cols)) {
        if (existingCols.has(colName)) continue
        try {
          await db.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${colName}" ${colDef}`)
          addedCols.push(`${table}.${colName}`)
        } catch (err) {
          log(`Warning: column top-up ${table}.${colName} skipped: ${err?.message || err}`)
        }
      }
    }
    if (addedCols.length > 0) log(`Column top-up added ${addedCols.length} missing column(s): ${addedCols.join(', ')} — data preserved`)
  } catch (err) {
    log(`Warning: column top-up skipped: ${err?.message || err}`)
  }

  // 4. Verify required tables exist (gate — this is what makes readiness mean
  //    something more than "the file exists").
  const verifiedTables = await listTables(db)
  result.tables = verifiedTables.length
  const stillMissing = required.filter((t) => !verifiedTables.includes(t))
  if (stillMissing.length > 0) {
    result.action = `verify-failed-after-${result.action}`
    result.errors.push({ error: `Missing required tables: ${stillMissing.join(', ')}` })
    log(`ERROR: required tables missing after schema step: ${stillMissing.join(', ')}`)
    return result
  }
  result.verified = required

  // 5. Integrity check (with non-destructive self-heal)
  // KNOWN QUIRK: SQLite 3.46 (bundled with Prisma/quaint) + pooled DDL
  // connections can leave an index missing entries when CREATE INDEX is
  // followed by further ALTER TABLE ADD COLUMN statements in the same top-up
  // pass — integrity_check then reports "row N missing from index X". This
  // is fully repairable WITHOUT touching any data by rebuilding the affected
  // indexes (REINDEX). Real corruption (any other problem type) still fails
  // the gate loudly.
  try {
    const runCheck = async () => {
      const rows = await db.$queryRawUnsafe('PRAGMA integrity_check')
      return (rows || []).map((r) => String(r.integrity_check))
    }
    const isClean = (probs) => probs.length === 0 || (probs.length === 1 && probs[0].toLowerCase() === 'ok')

    let problems = await runCheck()
    if (!isClean(problems)) {
      const healable = problems.length > 0 && problems.every((p) => /missing from index/i.test(p))
      if (healable) {
        const idxNames = [...new Set(problems
          .map((p) => (p.match(/missing from index ([^\s"]+)/i) || [])[1])
          .filter(Boolean))]
        for (const idx of idxNames) {
          try { await db.$executeRawUnsafe(`REINDEX "${idx}"`) } catch (err) {
            log(`Warning: REINDEX ${idx} failed: ${err?.message || err}`)
          }
        }
        problems = await runCheck()
        if (isClean(problems)) {
          log(`Self-heal: rebuilt ${idxNames.join(', ')} via REINDEX — integrity now OK (no data touched)`)
        }
      }
    }

    if (!isClean(problems)) {
      result.errors.push({ error: `integrity_check: ${problems.join(' | ')}` })
      const detail = problems.slice(0, 5).map((p) => p.substring(0, 120)).join(' | ')
      log(`ERROR: SQLite integrity_check reported ${problems.length} problem(s): ${detail || '(no detail)'}`)
      return result
    }
  } catch (err) {
    result.errors.push({ error: `integrity_check failed: ${err?.message || err}` })
    return result
  }

  result.ok = true
  log(`Sync metadata verified — schema version ${result.version}, ${result.tables} tables, integrity OK`)
  return result
}

/**
 * Ensure the outbox idempotency column + unique index exist (v2 contract).
 * Additive-only; existing rows are never modified beyond NULL-key backfill
 * which is owned by index.js — here we only guarantee the column/index.
 */
async function _ensurePendingMutationsIdempotencyColumn(db, log) {
  try {
    const cols = await tableColumns(db, '_pending_mutations')
    if (cols.length && !cols.includes('idempotency_key')) {
      await db.$executeRawUnsafe('ALTER TABLE "_pending_mutations" ADD COLUMN "idempotency_key" TEXT')
      log('Added _pending_mutations.idempotency_key column')
    }
    await db.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_pending_mutations_idem" ON "_pending_mutations"("idempotency_key")'
    )
  } catch (err) {
    log(`Warning: idempotency column/index check skipped: ${err?.message || err}`)
  }
}

module.exports = {
  ensureSchema,
  LOCAL_SCHEMA_VERSION,
  SYNC_INFRA_TABLES,
  SYNC_INFRA_DDL,
  CORE_REQUIRED_TABLES,
  loadRegistryModels,
  splitSqlStatements,
  stripCommentLines,
  hardenCreate,
  parseDdlColumns,
}
