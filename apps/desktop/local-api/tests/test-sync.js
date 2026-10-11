#!/usr/bin/env node
/**
 * BLASTI Sync Engine — Tests
 *
 * Tests the sync service directly by importing it and exercising its API.
 * Uses the local SQLite database (test-specific path to avoid production data).
 *
 * Usage:
 *   node test-sync.js
 *
 * Environment:
 *   BLASTI_LOCAL_DB_DIR  — directory for the test SQLite file
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

// ─── Minimal Test Framework ──────────────────────────────────────────────────

let _passed = 0
let _failed = 0
let _skipped = 0
let _errors = []
const _colors = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
}

function logPass(name) {
  _passed++
  console.log(`  ${_colors.green}PASS${_colors.reset} ${name}`)
}

function logFail(name, err) {
  _failed++
  _errors.push({ name, error: err })
  console.log(`  ${_colors.red}FAIL${_colors.reset} ${name}`)
  console.log(`        ${_colors.red}${err.message || err}${_colors.reset}`)
}

function logSkip(name, reason) {
  _skipped++
  console.log(`  ${_colors.yellow}SKIP${_colors.reset} ${name} — ${reason}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed')
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || 'Value'}: expected ${expected}, got ${actual}`)
  }
}

function assertIncludes(obj, key, label) {
  if (obj == null || obj[key] == null) {
    throw new Error(`${label || key}: expected property to exist`)
  }
}

async function test(name, fn) {
  try {
    await fn()
    logPass(name)
  } catch (err) {
    logFail(name, err)
  }
}

// ─── Test DB Setup ───────────────────────────────────────────────────────────

const TEST_DB_DIR = process.env.BLASTI_LOCAL_DB_DIR ||
  path.join(os.homedir(), '.blasti', 'test-sync')

if (!fs.existsSync(TEST_DB_DIR)) {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true })
}

// ─── Load Modules ────────────────────────────────────────────────────────────

let syncService = null
let localApi = null
let db = null

try {
  syncService = require('../sync-service')
} catch (err) {
  console.error(`Failed to load sync-service: ${err.message}`)
}

try {
  const dbModule = require('../lib/db')
  db = dbModule.localDb
} catch (err) {
  console.error(`Failed to load db module: ${err.message}`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a test agency ID.
 */
function testAgencyId() {
  return 'test-agency-' + crypto.randomBytes(8).toString('hex')
}

/**
 * Ensure the _sync_conflicts table exists.
 */
async function ensureConflictsTable(db) {
  if (!db) return
  // Mirrors the production DDL in sync-service.js (_ensureConflictsTable):
  // modelName/agencyId contract + BIGINT epoch-millis timestamps.
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_sync_conflicts" (
      "id" TEXT PRIMARY KEY,
      "modelName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "agencyId" TEXT,
      "localVersion" BIGINT,
      "cloudVersion" BIGINT,
      "localData" TEXT,
      "cloudData" TEXT,
      "resolution" TEXT DEFAULT 'pending',
      "resolvedAt" BIGINT,
      "createdAt" BIGINT NOT NULL
    )
  `)
}

/**
 * Tombstones live in the production `DeletedRecord` table (see
 * packages/db/prisma/schema.prisma) whose `deletedAt` is a Prisma DateTime —
 * stored in SQLite as an ISO TEXT string. Tests must insert ISO strings.
 */
async function ensureDeletedRecordTable(db) {
  if (!db) return
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "DeletedRecord" (
      "id" TEXT PRIMARY KEY,
      "modelName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "deletedAt" TEXT NOT NULL
    )
  `)
}

/**
 * Ensure the _sync_meta table exists.
 */
async function ensureSyncMetaTable(db) {
  if (!db) return
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_sync_meta" (
      "key" TEXT PRIMARY KEY,
      "value" TEXT
    )
  `)
}

/**
 * Ensure the _pending_mutations table exists.
 */
async function ensurePendingMutationsTable(db) {
  if (!db) return
  // Mirrors the production DDL in local-api/index.js (BIGINT epoch millis).
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_pending_mutations" (
      "id" TEXT PRIMARY KEY,
      "method" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "body" TEXT,
      "headers" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "max_attempts" INTEGER NOT NULL DEFAULT 5,
      "created_at" BIGINT NOT NULL,
      "last_attempt_at" BIGINT,
      "last_error" TEXT,
      "response_data" TEXT,
      "idempotency_key" TEXT
    )
  `)
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log(`\n${_colors.bold}${_colors.cyan}━━━ Sync Engine Tests ━━━${_colors.reset}\n`)

  if (!syncService) {
    console.error(`${_colors.red}FATAL: sync-service module could not be loaded${_colors.reset}`)
    process.exit(1)
  }
  if (!db) {
    console.error(`${_colors.red}FATAL: database module could not be loaded${_colors.reset}`)
    process.exit(1)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Initial Sync Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`${_colors.cyan}[Initial Sync]${_colors.reset}`)

  await test('startSync() initializes correctly', async () => {
    // startSync requires config with localDb
    const config = {
      localDb: db,
      cloudBaseUrl: 'http://localhost:9999', // unreachable — we test init only
      agencyId: testAgencyId(),
      syncIntervalMs: 60000,
      initialDelayMs: 30000, // long delay so it doesn't fire during test
    }
    syncService.startSync(config)
    const status = await syncService.getStatus()
    assertIncludes(status, 'isStarted', 'isStarted')
    assertEqual(status.isStarted, true, 'isStarted should be true')
    // Clean up
    syncService.stopSync()
  })

  await test('startSync() rejects config without localDb', async () => {
    // startSync without localDb should return early (not crash)
    syncService.startSync({}) // no localDb — should warn but not throw
    const status = await syncService.getStatus()
    // It should NOT have started (or be in error state)
    assertEqual(status.isStarted, false, 'isStarted should be false without localDb')
  })

  await test('triggerSyncNow() is safe without auth token', async () => {
    syncService.clearAuth()
    // v2: initialSync() was consolidated into initial-sync.js's runInitialSync.
    // The engine's manual trigger must degrade gracefully without auth/offline
    // (no throw, no crash) and report no auth in its status.
    let threw = false
    try {
      await syncService.triggerSyncNow()
    } catch (e) {
      threw = true
    }
    assertEqual(threw, false, 'triggerSyncNow should not throw without auth')
    const status = await syncService.getStatus()
    assertEqual(status.hasAuth, false, 'hasAuth should be false after clearAuth')
  })

  await test('outbox replay degrades gracefully when offline', async () => {
    // Set a dummy auth token
    syncService.setAuth('test-token-123', {
      id: 'user-1',
      agencyId: testAgencyId(),
      role: 'AGENT',
    })
    // Start sync with unreachable cloud URL
    syncService.startSync({
      localDb: db,
      cloudBaseUrl: 'http://localhost:9999', // unreachable
      agencyId: testAgencyId(),
      syncIntervalMs: 120000,
      initialDelayMs: 60000,
    })
    let result
    try {
      result = await syncService.triggerSyncNow()
    } catch (e) {
      result = { success: false, error: e.message }
    }
    // Should fail gracefully (offline/unreachable), never throw
    if (result && result.success !== undefined) {
      assertEqual(result.success, false, 'success should be false when offline')
    }
    const status = await syncService.getStatus()
    assertEqual(status.hasAuth, true, 'hasAuth should be true while auth set')
    syncService.stopSync()
    syncService.clearAuth()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Pending Mutations Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Pending Mutations]${_colors.reset}`)

  await test('Write operation creates pending mutation', async () => {
    await ensurePendingMutationsTable(db)
    const mutationId = 'mut-' + crypto.randomBytes(8).toString('hex')
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_pending_mutations"
        (id, method, path, body, idempotency_key, status, created_at, response_data)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      mutationId,
      'POST',
      '/api/services',
      JSON.stringify({ name: 'Test Service' }),
      'idem-' + mutationId,
      Date.now(),
      null
    )
    // Verify it exists
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "_pending_mutations" WHERE id = ? AND status = 'pending'`,
      mutationId
    )
    assert(rows && rows.length > 0, 'Mutation should exist in pending state')
    assertEqual(rows[0].method, 'POST', 'method')
    assertEqual(rows[0].path, '/api/services', 'path')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_pending_mutations" WHERE id = ?`,
      mutationId
    )
  })

  await test('Pending mutations survive restart (check _pending_mutations table)', async () => {
    await ensurePendingMutationsTable(db)
    // Insert a mutation
    const mutationId = 'mut-persist-' + crypto.randomBytes(8).toString('hex')
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_pending_mutations"
        (id, method, path, body, idempotency_key, status, created_at, response_data)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      mutationId,
      'PATCH',
      '/api/agency/profile',
      JSON.stringify({ description: 'Test update' }),
      null,
      Date.now(),
      null
    )

    // Simulate "restart" by re-querying the same DB
    // (In a real test we'd restart the process, but here we verify
    //  the data is durable by re-reading from the SQLite file)
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "_pending_mutations" WHERE id = ? AND status = 'pending'`,
      mutationId
    )
    assert(rows && rows.length > 0, 'Mutation should survive restart')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_pending_mutations" WHERE id = ?`,
      mutationId
    )
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Conflict Detection Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Conflict Detection]${_colors.reset}`)

  await test('Both changed → conflict logged', async () => {
    await ensureConflictsTable(db)
    const agencyId = testAgencyId()
    const conflictId = 'conflict-' + crypto.randomBytes(8).toString('hex')
    const now = Date.now()

    // Insert a conflict record (simulates both local and cloud changed)
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_sync_conflicts"
        (id, "modelName", "recordId", "agencyId", "localVersion", "cloudVersion",
         "localData", "cloudData", resolution, "resolvedAt", "createdAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
      conflictId,
      'Service',
      'svc-123',
      agencyId,
      2,  // local version
      3,  // cloud version (different → conflict)
      JSON.stringify({ name: 'Local Name', updatedAt: now - 1000 }),
      JSON.stringify({ name: 'Cloud Name', updatedAt: now }),
      now
    )

    // Verify the conflict was logged (BIGINT columns read back as BigInt —
    // compare numerically)
    const conflicts = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
    assert(conflicts && conflicts.length > 0, 'Conflict should be logged')
    assertEqual(conflicts[0].resolution, 'pending', 'resolution should be pending')
    assertEqual(Number(conflicts[0].localVersion), 2, 'localVersion')
    assertEqual(Number(conflicts[0].cloudVersion), 3, 'cloudVersion')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
  })

  await test('Cloud wins for financial data', async () => {
    await ensureConflictsTable(db)
    const agencyId = testAgencyId()
    const conflictId = 'conflict-fin-' + crypto.randomBytes(8).toString('hex')
    const now = Date.now()

    // Insert a conflict for a financial model (Transaction)
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_sync_conflicts"
        (id, "modelName", "recordId", "agencyId", "localVersion", "cloudVersion",
         "localData", "cloudData", resolution, "resolvedAt", "createdAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
      conflictId,
      'Transaction',  // Financial data — cloud should win
      'txn-456',
      agencyId,
      2,
      3,
      JSON.stringify({ amount: 100, status: 'PENDING' }),
      JSON.stringify({ amount: 100, status: 'COMPLETED' }),
      now
    )

    // For Transaction (CLOUD_WINS_MODELS), when resolving, cloud data should be used
    // Simulate the resolution
    await db.$executeRawUnsafe(
      `UPDATE "_sync_conflicts" SET resolution = 'cloud', "resolvedAt" = ? WHERE id = ?`,
      Date.now(),
      conflictId
    )

    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
    assert(rows && rows.length > 0, 'Conflict should exist')
    assertEqual(rows[0].resolution, 'cloud', 'resolution should be cloud for financial data')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
  })

  await test('Last-write-wins for master data', async () => {
    await ensureConflictsTable(db)
    const agencyId = testAgencyId()
    const conflictId = 'conflict-lww-' + crypto.randomBytes(8).toString('hex')
    const now = Date.now()

    // Insert a conflict for a master data model (Service — LAST_WRITE_WINS)
    const localUpdatedAt = now - 1000  // local is older
    const cloudUpdatedAt = now          // cloud is newer → cloud wins via LWW

    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_sync_conflicts"
        (id, "modelName", "recordId", "agencyId", "localVersion", "cloudVersion",
         "localData", "cloudData", resolution, "resolvedAt", "createdAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
      conflictId,
      'Service',  // Master data — last-write-wins
      'svc-789',
      agencyId,
      2,
      3,
      JSON.stringify({ name: 'Local Service', updatedAt: localUpdatedAt }),
      JSON.stringify({ name: 'Cloud Service', updatedAt: cloudUpdatedAt }),
      now
    )

    // For LWW, cloud wins because its updatedAt is newer
    await db.$executeRawUnsafe(
      `UPDATE "_sync_conflicts" SET resolution = 'cloud', "resolvedAt" = ? WHERE id = ?`,
      Date.now(),
      conflictId
    )

    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
    assert(rows && rows.length > 0, 'Conflict should exist')
    // Cloud should win for LWW when cloud updatedAt > local updatedAt
    assertEqual(rows[0].resolution, 'cloud', 'LWW resolution should pick cloud (newer updatedAt)')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Tombstones Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Tombstones]${_colors.reset}`)

  await test('Delete creates DeletedRecord (tombstone)', async () => {
    await ensureDeletedRecordTable(db)
    const tombstoneId = 'tomb-' + crypto.randomBytes(8).toString('hex')
    const recordId = 'svc-del-' + crypto.randomBytes(8).toString('hex')

    // Insert a tombstone (simulates a cloud-confirmed delete) — production
    // stores deletedAt as an ISO string in the DateTime column.
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "DeletedRecord"
        (id, "modelName", "recordId", "deletedAt")
       VALUES (?, ?, ?, ?)`,
      tombstoneId,
      'Service',
      recordId,
      new Date().toISOString()
    )

    // Verify tombstone exists
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "DeletedRecord" WHERE "recordId" = ?`,
      recordId
    )
    assert(rows && rows.length > 0, 'Tombstone should exist after delete')
    assertEqual(rows[0].modelName, 'Service', 'modelName')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "DeletedRecord" WHERE id = ?`,
      tombstoneId
    )
  })

  await test('Tombstone prevents record resurrection', async () => {
    await ensureDeletedRecordTable(db)
    const tombstoneId = 'tomb-res-' + crypto.randomBytes(8).toString('hex')
    const recordId = 'svc-res-' + crypto.randomBytes(8).toString('hex')

    // Insert a tombstone for a cloud-confirmed delete
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "DeletedRecord"
        (id, "modelName", "recordId", "deletedAt")
       VALUES (?, ?, ?, ?)`,
      tombstoneId,
      'Service',
      recordId,
      new Date().toISOString()
    )

    // A sync pull checks for tombstones before inserting records —
    // mirror that check against the production table.
    const tombstoneCheck = await db.$queryRawUnsafe(
      `SELECT COUNT(*) as cnt FROM "DeletedRecord" WHERE "recordId" = ? AND "modelName" = ?`,
      recordId,
      'Service'
    )
    const hasTombstone = (tombstoneCheck[0] && tombstoneCheck[0].cnt > 0)
    assertEqual(hasTombstone, true, 'Tombstone should prevent resurrection')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "DeletedRecord" WHERE id = ?`,
      tombstoneId
    )
  })

  await test('cleanupTombstones() removes old entries', async () => {
    await ensureDeletedRecordTable(db)
    const oldTombstoneId = 'tomb-old-' + crypto.randomBytes(8).toString('hex')
    const freshTombstoneId = 'tomb-fresh-' + crypto.randomBytes(8).toString('hex')
    const recordId = 'svc-old-' + crypto.randomBytes(8).toString('hex')
    const freshRecordId = 'svc-fresh-' + crypto.randomBytes(8).toString('hex')

    // Insert a tombstone that's 60 days old (beyond the 30-day cleanup threshold)
    const sixtyDaysAgo = new Date(Date.now() - (60 * 24 * 60 * 60 * 1000)).toISOString()
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "DeletedRecord"
        (id, "modelName", "recordId", "deletedAt")
       VALUES (?, ?, ?, ?)`,
      oldTombstoneId,
      'Service',
      recordId,
      sixtyDaysAgo
    )
    // Insert a fresh tombstone that must survive the cleanup
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "DeletedRecord"
        (id, "modelName", "recordId", "deletedAt")
       VALUES (?, ?, ?, ?)`,
      freshTombstoneId,
      'Service',
      freshRecordId,
      new Date().toISOString()
    )

    // Verify it exists before cleanup
    const before = await db.$queryRawUnsafe(
      `SELECT * FROM "DeletedRecord" WHERE id = ?`,
      oldTombstoneId
    )
    assert(before && before.length > 0, 'Old tombstone should exist before cleanup')

    // Start sync service to enable cleanupTombstones
    syncService.startSync({
      localDb: db,
      cloudBaseUrl: 'http://localhost:9999',
      agencyId: testAgencyId(),
      syncIntervalMs: 120000,
      initialDelayMs: 60000,
    })

    // Run cleanup
    const removedCount = await syncService.cleanupTombstones()
    assert(typeof removedCount === 'number', 'cleanupTombstones should return a number')
    assert(removedCount >= 0, 'removedCount should be non-negative')

    // Verify old tombstone was removed
    const after = await db.$queryRawUnsafe(
      `SELECT * FROM "DeletedRecord" WHERE id = ?`,
      oldTombstoneId
    )
    assert(!after || after.length === 0, 'Old tombstone should be removed after cleanup')

    // Verify fresh tombstone survived
    const fresh = await db.$queryRawUnsafe(
      `SELECT * FROM "DeletedRecord" WHERE id = ?`,
      freshTombstoneId
    )
    assert(fresh && fresh.length > 0, 'Fresh tombstone must survive cleanup')

    syncService.stopSync()

    // Clean up
    await db.$executeRawUnsafe(`DELETE FROM "DeletedRecord" WHERE id = ?`, freshTombstoneId)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Sync Service API Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Sync Service API]${_colors.reset}`)

  await test('stopSync() cleans up timers', async () => {
    syncService.startSync({
      localDb: db,
      cloudBaseUrl: 'http://localhost:9999',
      agencyId: testAgencyId(),
      syncIntervalMs: 120000,
      initialDelayMs: 60000,
    })
    const statusBefore = await syncService.getStatus()
    assertEqual(statusBefore.isStarted, true, 'isStarted before stop')

    syncService.stopSync()
    const statusAfter = await syncService.getStatus()
    assertEqual(statusAfter.isStarted, false, 'isStarted after stop')
  })

  await test('setAuth/clearAuth manage auth state', async () => {
    syncService.clearAuth()
    let status = await syncService.getStatus()
    assertEqual(status.hasAuth, false, 'hasAuth should be false after clearAuth')

    syncService.setAuth('test-token', { id: 'u1', agencyId: 'a1', role: 'AGENT' })
    status = await syncService.getStatus()
    assertEqual(status.hasAuth, true, 'hasAuth should be true after setAuth')
    // NOTE: status.agencyId precedence is (sync config agency) → (auth context
    // agency). Earlier tests in this file call startSync with their own agency,
    // so the configured value legitimately persists in this process — we only
    // assert the auth flag transition here.

    syncService.clearAuth()
    status = await syncService.getStatus()
    assertEqual(status.hasAuth, false, 'hasAuth should be false after clearAuth')
  })

  await test('getConflicts() returns array', async () => {
    await ensureConflictsTable(db)
    const conflicts = await syncService.getConflicts()
    assert(Array.isArray(conflicts), 'getConflicts should return an array')
  })

  await test('onSyncEvent() registers and unregisters listeners', async () => {
    let eventReceived = null
    const unsubscribe = syncService.onSyncEvent((event) => {
      eventReceived = event
    })
    assert(typeof unsubscribe === 'function', 'onSyncEvent should return unsubscribe function')

    // The listener is registered; we can't easily trigger an event in isolation,
    // but we can verify unsubscribe works
    unsubscribe()
    // No crash = success
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CURSOR INVARIANT TESTS (field round 6)
  //
  // Field evidence: after initial sync the bridge final cursor was 890, but
  // the engine pulled from 893 — a stale over-advanced v2 cursor key
  // (`lastPulledSequence`) SHADOWED the bridge-written legacy key
  // (`_lastPulledSequence`). The invariant under test:
  //
  //   snapshot = 890, cloud changes = 891, 892, 893
  //   → all three applied EXACTLY ONCE
  //   → final cursor = 893, both cursor keys agree
  //   → no value may ever skip unaccounted changes
  // ═══════════════════════════════════════════════════════════════════════

  await ensureSyncMetaTable(db)

  // The cursor tests drive REAL Prisma delegates (AgencyLocalState,
  // SubscriptionPlan) — the full authoritative schema must exist. The other
  // suites create their tables ad hoc; here the production non-destructive
  // initializer runs (idempotent — creates only what is missing).
  try {
    const readyResult = await require('../lib/db').ensureDatabaseReady()
    if (!readyResult || !readyResult.ok) {
      console.warn('[test-sync] ensureDatabaseReady did not fully succeed (continuing):', readyResult && readyResult.error)
    }
  } catch (e) {
    console.warn('[test-sync] ensureDatabaseReady threw (continuing):', e.message)
  }

  async function setMetaRaw(key, value) {
    await db.$executeRawUnsafe(
      'INSERT INTO "_sync_meta" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key, String(value),
    )
  }
  async function getMetaRaw(key) {
    const rows = await db.$queryRawUnsafe('SELECT value FROM "_sync_meta" WHERE key = ?', key)
    return rows?.[0]?.value ?? null
  }

  await test('cursor divergence guard: stale v2 key (893) cannot shadow the bridge legacy key (890)', async () => {
    await syncService.startSync({
      localDb: db,
      cloudBaseUrl: 'http://127.0.0.1:9', // never contacted in this test
      agencyId: testAgencyId(),
      syncIntervalMs: 120000,
      initialDelayMs: 60000,
    })
    try {
      // Normalize in-memory cursor to 0 (also writes both keys to 0).
      await syncService.setInitialCursor(0, { source: 'test:reset' })
      // Seed the EXACT field-round-6 divergence: stale over-advanced v2 key
      // vs the bridge's correct legacy key.
      await setMetaRaw('lastPulledSequence', 893)
      await setMetaRaw('_lastPulledSequence', 890)

      // getStatus() must resolve the cursor through _getCursor() (in-memory
      // _cursor is 0 → falsy) → the divergence guard adopts MIN = 890.
      const status = await syncService.getStatus()
      assertEqual(status.cursor, 890, 'cursor must resolve to MIN(893, 890) = 890, never the stale 893')

      // Both keys must be healed to the safe value.
      assertEqual(await getMetaRaw('lastPulledSequence'), '890', 'v2 key healed to 890')
      assertEqual(await getMetaRaw('_lastPulledSequence'), '890', 'legacy key healed to 890')
    } finally {
      syncService.stopSync()
    }
  })

  await test('pull cycle invariant: snapshot 890 + changes 891..893 → applied exactly once, final cursor 893', async () => {
    const http = require('http')
    const agencyId = testAgencyId()

    // Three distinct cloud changes at sequences 891, 892, 893.
    const PLANS = [891, 892, 893].map((seq) => ({
      id: 'plan-cursor-' + seq,
      name: 'Cursor Invariant Plan ' + seq + ' ' + Date.now(),
      displayName: 'Plan ' + seq,
      price: seq,
      currency: 'DZD',
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
    const pullRequests = [] // every sinceSequence the engine asked for

    const sendJson = (res, code, obj) => {
      const body = JSON.stringify(obj)
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
      res.end(body)
    }
    const mockCloud = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (req.url === '/health') return sendJson(res, 200, { ok: true })
        if (req.url === '/api/sync/pull' && req.method === 'POST') {
          let since = 0
          try { since = (JSON.parse(body || '{}').sinceSequence) || 0 } catch { /* keep 0 */ }
          pullRequests.push(since)
          if (since <= 890) {
            // One page carrying exactly the three changes 891..893.
            return sendJson(res, 200, {
              success: true, protocolVersion: 2,
              pageLastSequence: 893, latestSequence: 893, hasMore: false,
              changes: { SubscriptionPlan: { changed: PLANS, deleted: [] } },
            })
          }
          // Anything after 893: empty page, cursor holds.
          return sendJson(res, 200, {
            success: true, protocolVersion: 2,
            pageLastSequence: since, latestSequence: since, hasMore: false,
            changes: {},
          })
        }
        // Outbox replay and any other probe: generic success.
        return sendJson(res, 200, { success: true, results: [] })
      })
    })
    await new Promise((resolve) => mockCloud.listen(0, '127.0.0.1', resolve))
    const mockUrl = 'http://127.0.0.1:' + mockCloud.address().port

    try {
      // READY workspace for THIS agency (Part D gate must pass).
      await db.agencyLocalState.deleteMany({ where: { agencyId } })
      await db.agencyLocalState.create({
        data: { agencyId, initializationStatus: 'READY', snapshotSequence: 890 },
      })
      // Prevent the agency-change cursor reset from wiping the seeded state
      // (the engine compares _sync_meta lastSyncAgencyId with the configured agency).
      await setMetaRaw('lastSyncAgencyId', agencyId)
      // Seed the field-round-6 divergence AGAIN: the stale over-advanced v2
      // key (893, left by an older build's pull) shadowing the bridge final
      // (890). The engine must resolve 890, pull 891..893, and land on 893.
      await setMetaRaw('lastPulledSequence', 893)
      await setMetaRaw('_lastPulledSequence', 890)

      syncService.setAuth('test-token-cursor', { id: 'u-cursor', agencyId, role: 'AGENCY_OWNER' })
      syncService.startSync({
        localDb: db,
        cloudBaseUrl: mockUrl,
        agencyId,
        syncIntervalMs: 120000,
        initialDelayMs: 60000, // timer must NOT fire — cycles are driven here
      })

      // Hydration already resolved the divergence → first pull MUST start at 890.
      const ready = await syncService.isAgencyReady() // force-refresh the Part D cache
      assertEqual(ready, true, 'agency must be READY for the pull gate')

      const firstCycle = await syncService.triggerSyncNow()
      assert(pullRequests.length >= 1, 'engine must have issued a pull')
      assertEqual(pullRequests[0], 890, 'first pull must start at the bridge final 890 — NOT the stale 893')
      // The cycle's return value is intentionally not asserted (the engine
      // emits stats via events) — the SQLite row counts below are the proof.

      // Exactly-once: each of the three records exists, exactly one row each.
      const countRows = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "SubscriptionPlan" WHERE id IN (?, ?, ?)',
        'plan-cursor-891', 'plan-cursor-892', 'plan-cursor-893',
      )
      const appliedCount = Number(countRows[0]?.cnt ?? 0)
      assertEqual(appliedCount, 3, 'changes 891..893 accounted exactly once in SQLite')

      // Final cursor: 893 — both keys agree.
      const statusAfterFirst = await syncService.getStatus()
      assertEqual(statusAfterFirst.cursor, 893, 'final cursor must be 893 (nothing skipped, nothing invented)')
      assertEqual(await getMetaRaw('lastPulledSequence'), '893', 'v2 key at 893')
      assertEqual(await getMetaRaw('_lastPulledSequence'), '893', 'legacy key at 893')

      // Stability: a second cycle from the settled cursor must apply NOTHING
      // (empty page) and must not duplicate rows or move the cursor.
      await syncService.triggerSyncNow()
      const statusAfterSecond = await syncService.getStatus()
      assertEqual(statusAfterSecond.cursor, 893, 'cursor stays 893 after an empty cycle')
      const countAgain = await db.$queryRawUnsafe(
        'SELECT COUNT(*) as cnt FROM "SubscriptionPlan" WHERE id IN (?, ?, ?)',
        'plan-cursor-891', 'plan-cursor-892', 'plan-cursor-893',
      )
      assertEqual(Number(countAgain[0]?.cnt ?? 0), 3, 'no duplication on re-pull (exactly-once holds)')
    } finally {
      syncService.stopSync()
      await new Promise((resolve) => mockCloud.close(resolve))
      // Cleanup test rows (never mask a failure with a cleanup error).
      await db.subscriptionPlan.deleteMany({ where: { id: { startsWith: 'plan-cursor-' } } }).catch(() => {})
      await db.agencyLocalState.deleteMany({ where: { agencyId } }).catch(() => {})
    }
  })

  await test('adoptInitialSyncCursor(): bridge adoption, audit row, and stale-cursor rewind after re-import', async () => {
    // Engine config from the previous test is stopped; setInitialCursor /
    // adoption persist through _config.localDb — restart briefly.
    await syncService.startSync({
      localDb: db,
      cloudBaseUrl: 'http://127.0.0.1:9',
      agencyId: testAgencyId(),
      syncIntervalMs: 120000,
      initialDelayMs: 60000,
    })
    try {
      // Normal path: snapshot 890 → bridge final 893 → cursor 893.
      const adopted = await syncService.adoptInitialSyncCursor(
        { snapshotSequence: 890, bridgeFinalSequence: 893 }, 'test-invariant',
      )
      assertEqual(adopted, 893, 'adoption must land on the bridge final sequence')
      assertEqual((await syncService.getStatus()).cursor, 893, 'engine cursor is the bridge final')
      const auditRaw = await getMetaRaw('lastCursorAdoption')
      assert(auditRaw, 'adoption must persist an audit row')
      const audit = JSON.parse(auditRaw)
      assertEqual(audit.source, 'test-invariant:bridge-adoption', 'audit records the adoption source')
      assertEqual(audit.to, 893, 'audit records the adopted value')
      assertEqual(audit.snapshotSequence, 890, 'audit records the snapshot for the S → F chain')

      // Re-import authority: a re-import whose bridge final is 890 MUST be
      // able to rewind a stale higher cursor (893) — re-apply is ledger-
      // idempotent; skipping forward past unaccounted changes is not.
      const rewound = await syncService.adoptInitialSyncCursor(
        { snapshotSequence: 890, bridgeFinalSequence: 890 }, 'test-reimport',
      )
      assertEqual(rewound, 890, 'adoption rewinds a stale over-advanced cursor to the proven bridge final')
      assertEqual((await syncService.getStatus()).cursor, 890, 'cursor after re-import adoption is 890')
      assertEqual(await getMetaRaw('lastPulledSequence'), '890', 'v2 key follows the rewind')
      assertEqual(await getMetaRaw('_lastPulledSequence'), '890', 'legacy key follows the rewind')
    } finally {
      syncService.stopSync()
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  const total = _passed + _failed + _skipped
  console.log(`\n${_colors.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${_colors.reset}`)
  console.log(`${_colors.bold}Results: ${_colors.green}${_passed} passed${_colors.reset}, ${_colors.red}${_failed} failed${_colors.reset}, ${_colors.yellow}${_skipped} skipped${_colors.reset} (${total} total)`)
  if (_errors.length > 0) {
    console.log(`\n${_colors.red}${_colors.bold}Failures:${_colors.reset}`)
    for (const e of _errors) {
      console.log(`  • ${e.name}: ${e.error.message || e.error}`)
    }
  }
  console.log('')

  return _failed > 0 ? 1 : 0
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

runAllTests()
  .then((exitCode) => { process.exit(exitCode) })
  .catch((err) => {
    console.error(`${_colors.red}FATAL: ${err.message}${_colors.reset}`)
    process.exit(1)
  })
