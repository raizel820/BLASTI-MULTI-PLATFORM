#!/usr/bin/env node
/**
 * BLASTI Local Database Schema Lifecycle — Tests
 *
 * Covers the non-destructive schema management contract (spec §1-§7, §10, §31):
 *   1.  Fresh creation — full schema + protected sync tables + version stamp
 *   2.  Restart idempotency — second run is a no-op ("up-to-date")
 *   3.  Sync tables NEVER dropped — rows in _sync_meta/_pending_mutations
 *       survive repeated ensure runs (regression for the reported startup bug
 *       where `prisma db push --accept-data-loss` deleted `_sync_meta`)
 *   4.  Business data preserved across schema ensure runs
 *   5.  Legacy (db-push era) database adoption — no version stamp → verified,
 *       topped-up, stamped, data intact
 *   6.  Missing table convergence — dropped table recreated additively
 *   7.  Missing column convergence — old-shape table gains columns additively
 *   8.  Legacy DB FILE migration — database at the old ~/.blasti/local path is
 *       copied (never moved) to the authoritative <dir>/blasti-local path,
 *       verified, and recorded in _sync_meta (cross-process scenario)
 *
 * Environment:
 *   BLASTI_LOCAL_DB_DIR — directory for the SQLite file (this process's tests)
 *
 * Usage: node test-schema-migrations.js
 */

const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { PrismaClient } = require('@prisma/client')

// ─── Minimal Test Framework ──────────────────────────────────────────────────

let _passed = 0
let _failed = 0
const _errors = []
const _colors = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' }

function logPass(name) { _passed++; console.log(`  ${_colors.green}PASS${_colors.reset} ${name}`) }
function logFail(name, err) {
  _failed++
  _errors.push({ name, error: err })
  console.log(`  ${_colors.red}FAIL${_colors.reset} ${name}`)
  console.log(`        ${_colors.red}${(err && err.message) || err}${_colors.reset}`)
}
function assert(condition, message) { if (!condition) throw new Error(message || 'Assertion failed') }

async function test(name, fn) {
  try { await fn(); logPass(name) } catch (err) { logFail(name, err) }
}

// ─── Subject Under Test ──────────────────────────────────────────────────────

const migrations = require('../lib/schema-migrations')
const dbModule = require('../lib/db')
const db = dbModule.localDb

if (!db) {
  console.error('FATAL: local Prisma client not available')
  process.exit(1)
}

/** Build an independent PrismaClient against an arbitrary SQLite file. */
function clientFor(dbPath) {
  return new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } }, log: ['error'] })
}

async function tableNames(client) {
  const rows = await client.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  return (rows || []).map((r) => r.name)
}

// ─── This-process scenarios (authoritative test DB dir) ─────────────────────

async function runTests() {
  console.log(`\n${'━'.repeat(55)}`)
  console.log('  Schema Lifecycle (controlled non-destructive migrations)')
  console.log(`${'━'.repeat(55)}\n`)

  const DB_PATH = dbModule.DB_PATH

  // 1 ── Schema presence + version stamp. The DB dir may already hold a
  //      database from a previous suite run, so the action can be created /
  //      adopted-legacy / up-to-date — the INVARIANTS are what matter here.
  //      True first-time creation is covered precisely by the separate-client
  //      scenarios below (tests 6/7/8 start from controlled states).
  await test('schema present → all tables + sync tables + version stamp', async () => {
    const r = await dbModule.ensureDatabaseReady()
    assert(r.ok, 'ensureDatabaseReady not ok: ' + r.error)
    const tables = await tableNames(db)
    for (const t of migrations.SYNC_INFRA_TABLES) {
      assert(tables.includes(t), 'missing protected table: ' + t)
    }
    assert(r.schema.version === migrations.LOCAL_SCHEMA_VERSION, 'version not stamped')
  })

  // 2 ── Restart idempotency (ensureSchema directly — ensureDatabaseReady
  //      caches its result per process, so restart semantics are observed
  //      through the raw migration layer)
  await test('restart → up-to-date, no errors', async () => {
    const r = await migrations.ensureSchema(db)
    assert(r.ok, 'not ok')
    assert(r.action === 'up-to-date', 'expected up-to-date, got: ' + r.action)
    assert(r.errors.length === 0, 'errors reported: ' + JSON.stringify(r.errors))
  })

  // 3 ── Sync tables never dropped (THE reported production bug)
  await test('sync state survives repeated ensure runs (no _sync_meta drop)', async () => {
    await db.$executeRawUnsafe("INSERT OR REPLACE INTO '_sync_meta' (key, value) VALUES ('lastPulledSequence', '777')")
    await db.$executeRawUnsafe(
      "INSERT INTO '_pending_mutations' (id, method, path, status, attempts, max_attempts, created_at, idempotency_key) " +
      "VALUES ('m1', 'POST', '/api/x', 'pending', 0, 5, 1700000000000, 'test-key-1') " +
      "ON CONFLICT(id) DO NOTHING"
    )
    for (let i = 0; i < 3; i++) {
      const r = await dbModule.ensureDatabaseReady()
      assert(r.ok, 'ensure failed on run ' + i)
    }
    const cursor = await db.$queryRawUnsafe("SELECT value FROM '_sync_meta' WHERE key = 'lastPulledSequence'")
    assert(cursor[0] && String(cursor[0].value) === '777', 'cursor lost — sync state was destroyed')
    const pend = await db.$queryRawUnsafe("SELECT COUNT(*) as c FROM '_pending_mutations' WHERE id = 'm1'")
    assert(Number(pend[0].c) === 1, 'outbox row lost — durable mutations were destroyed')
  })

  // 4 ── Business data preserved
  await test('business data preserved across schema ensure', async () => {
    await db.user.create({ data: {
      id: 'mig-user-1', username: 'miguser', fullName: 'Migration User',
      passwordHash: 'x', role: 'AGENCY_OWNER', language: 'ar', freeSmsCount: 10,
      notificationPref: 'APP_ONLY', isAppOnline: false,
    } }).catch(() => {})
    await db.agency.create({ data: {
      id: 'mig-agency-1', name: 'Migration Agency', customCode: 'MIG001',
      category: 'GENERAL', ownerId: 'mig-user-1',
    } }).catch(() => {})
    await dbModule.ensureDatabaseReady()
    const agency = await db.$queryRawUnsafe("SELECT name FROM \"Agency\" WHERE id = 'mig-agency-1'")
    assert(agency[0] && agency[0].name === 'Migration Agency', 'agency record lost during schema ensure')
  })

  // 5 ── Legacy db-push-era adoption (no version stamp, _sync_meta dropped —
  //      exactly the state the old destructive startup produced)
  await test('legacy database (unversioned, _sync_meta dropped) adopted without data loss', async () => {
    const legacyPath = path.join('/tmp', 'blasti-mig-test-legacy-' + Date.now() + '.db')
    const lc = clientFor(legacyPath)
    try {
      // Simulate a db-push-era DB: ALL business tables exist, sync tables
      // were dropped by the old destructive startup push.
      const { splitSqlStatements, stripCommentLines, hardenCreate } = migrations
      const stmts = splitSqlStatements(stripCommentLines(require('../lib/schema-init-sql')))
      for (const s of stmts) {
        if (/CREATE TABLE "/.test(s)) {
          await lc.$executeRawUnsafe(hardenCreate(s)).catch(() => {})
        }
      }
      await lc.$executeRawUnsafe("INSERT INTO \"User\" (id, username, fullName, passwordHash, role, language, freeSmsCount, notificationPref, isAppOnline, createdAt, updatedAt) VALUES ('lu1','legacyu','Legacy','x','AGENCY_OWNER','ar',10,'APP_ONLY',0,'2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')")
      await lc.$executeRawUnsafe("INSERT INTO \"Agency\" (id, name, customCode, category, ownerId, createdAt, updatedAt) VALUES ('la1','Legacy Agency','LGC001','GENERAL','lu1','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')")
      // The destructive event: _sync_meta removed by old startup push.
      await lc.$executeRawUnsafe('DROP TABLE IF EXISTS "_sync_meta"')

      const r = await migrations.ensureSchema(lc)
      assert(r.ok, 'adopt failed: ' + JSON.stringify(r.errors))
      assert(r.action === 'adopted-legacy', 'expected adopted-legacy, got: ' + r.action)
      const names = await tableNames(lc)
      assert(names.includes('_sync_meta'), '_sync_meta not recreated')
      const ag = await lc.$queryRawUnsafe("SELECT name FROM \"Agency\" WHERE id = 'la1'")
      assert(ag[0] && ag[0].name === 'Legacy Agency', 'legacy agency data destroyed during adoption')
      const us = await lc.$queryRawUnsafe("SELECT username FROM \"User\" WHERE id = 'lu1'")
      assert(us[0] && us[0].username === 'legacyu', 'legacy user data destroyed during adoption')
    } finally {
      await lc.$disconnect().catch(() => {})
      fs.rmSync(legacyPath, { force: true })
    }
  })

  // 6 ── Missing table convergence
  await test('dropped business table is recreated additively (convergence)', async () => {
    const p2 = path.join('/tmp', 'blasti-mig-test-conv-' + Date.now() + '.db')
    const c2 = clientFor(p2)
    try {
      await migrations.ensureSchema(c2)
      await c2.$executeRawUnsafe('DROP TABLE "Counter"')
      const r = await migrations.ensureSchema(c2)
      assert(r.ok, 'ensure not ok after table drop')
      const names = await tableNames(c2)
      assert(names.includes('Counter'), 'Counter not recreated')
    } finally {
      await c2.$disconnect().catch(() => {})
      fs.rmSync(p2, { force: true })
    }
  })

  // 7 ── Missing column convergence
  await test('old-shape table gains missing columns additively', async () => {
    const p3 = path.join('/tmp', 'blasti-mig-test-col-' + Date.now() + '.db')
    const c3 = clientFor(p3)
    try {
      await migrations.ensureSchema(c3)
      // Simulate an older Service shape: rebuild without a recent column.
      await c3.$executeRawUnsafe('ALTER TABLE "Service" RENAME TO "Service_new"')
      const cols = await c3.$queryRawUnsafe('PRAGMA table_info("Service_new")')
      const keep = cols.filter((c) => c.name !== 'prefix')
      const colDefs = keep.map((c) => `"${c.name}" ${c.type}${c.pk ? ' PRIMARY KEY' : ''}`).join(', ')
      await c3.$executeRawUnsafe(`CREATE TABLE "Service" (${colDefs})`)
      await c3.$executeRawUnsafe('DROP TABLE "Service_new"')
      const r = await migrations.ensureSchema(c3)
      assert(r.ok, 'ensure not ok after column removal')
      const after = await c3.$queryRawUnsafe('PRAGMA table_info("Service")')
      assert(after.some((c) => c.name === 'prefix'), 'missing column not added')
    } finally {
      await c3.$disconnect().catch(() => {})
      fs.rmSync(p3, { force: true })
    }
  })

  // 8 ── Cross-process: legacy DB FILE migration to authoritative path
  await test('legacy DB file migrated (copied+verified) to authoritative blasti-local path', () => {
    const home = '/tmp/blasti-mig-home-' + Date.now()
    const legacyDir = path.join(home, '.blasti', 'local')
    const authDir = path.join(home, 'app-data', 'blasti-local')
    fs.mkdirSync(legacyDir, { recursive: true })

    // Build a small legacy DB using this process's client machinery.
    const legacyPath = path.join(legacyDir, 'local.db')
    // Seed via sqlite through Prisma raw on a temp client.
    const seed = clientFor(legacyPath)
    return migrations.ensureSchema(seed).then(async (r) => {
      assert(r.ok, 'seed ensureSchema failed')
      await seed.$executeRawUnsafe("INSERT INTO '_sync_meta' (key, value) VALUES ('lastPulledSequence', '31337')")
      await seed.$disconnect()
      // Run the migration in a CHILD process with the authoritative env.
      const script = `
        process.env.BLASTI_LOCAL_DB_DIR = ${JSON.stringify(authDir)};
        const dbm = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'db.js'))});
        dbm.ensureDatabaseReady().then(async (res) => {
          if (!res.ok) { console.error('CHILD-FAIL ' + res.error); process.exit(1) }
          const cur = await dbm.localDb.$queryRawUnsafe("SELECT value FROM '_sync_meta' WHERE key='lastPulledSequence'");
          if (!cur[0] || String(cur[0].value) !== '31337') { console.error('CHILD-FAIL cursor lost'); process.exit(1) }
          console.log('CHILD-OK');
          process.exit(0);
        }).catch((e) => { console.error('CHILD-FAIL ' + e.message); process.exit(1) });
      `
      execFileSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 120000, encoding: 'utf-8' })
      // Authoritative file exists with migrated data; legacy file KEPT (never deleted).
      assert(fs.existsSync(path.join(authDir, 'local.db')), 'authoritative DB not created')
      assert(fs.existsSync(legacyPath), 'legacy DB was deleted — must be preserved as backup')
      const probe = clientFor(path.join(authDir, 'local.db'))
      return probe.$queryRawUnsafe("SELECT value FROM '_sync_meta' WHERE key='migrated_from'").then(async (rows) => {
        assert(rows[0] && String(rows[0].value).includes('.blasti'), 'migration not recorded in _sync_meta')
        await probe.$disconnect()
        fs.rmSync(home, { recursive: true, force: true })
      })
    })
  })

  // ── Report ──
  console.log(`\n${'━'.repeat(55)}`)
  console.log(`Results: ${_colors.green}${_passed} passed${_colors.reset}, ${_colors.red}${_failed} failed${_colors.reset} (${_passed + _failed} total)`)
  if (_errors.length > 0) {
    console.log(`\n${_colors.red}Failures:${_colors.reset}`)
    for (const e of _errors) console.log(`  • ${e.name}: ${e.error.message || e.error}`)
  }
  console.log('')
  return _failed > 0 ? 1 : 0
}

runTests()
  .then((code) => process.exit(code))
  .catch((err) => { console.error(`FATAL: ${err.message}`); process.exit(1) })
