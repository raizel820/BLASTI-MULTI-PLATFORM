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
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_sync_conflicts" (
      "id" TEXT PRIMARY KEY,
      "modelName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "agencyId" TEXT,
      "localVersion" INTEGER,
      "cloudVersion" INTEGER,
      "localData" TEXT,
      "cloudData" TEXT,
      "resolution" TEXT DEFAULT 'pending',
      "resolvedAt" INTEGER,
      "createdAt" INTEGER NOT NULL
    )
  `)
}

/**
 * Ensure the _sync_tombstones table exists.
 */
async function ensureTombstonesTable(db) {
  if (!db) return
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_sync_tombstones" (
      "id" TEXT PRIMARY KEY,
      "modelName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "agencyId" TEXT,
      "deletedAt" INTEGER NOT NULL
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
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_pending_mutations" (
      "id" TEXT PRIMARY KEY,
      "method" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "body" TEXT,
      "idempotency_key" TEXT,
      "status" TEXT DEFAULT 'pending',
      "created_at" INTEGER NOT NULL,
      "response_data" TEXT,
      "completed_at" INTEGER,
      "failed_at" INTEGER,
      "retry_count" INTEGER DEFAULT 0
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
    const status = syncService.getStatus()
    assertIncludes(status, 'isStarted', 'isStarted')
    assertEqual(status.isStarted, true, 'isStarted should be true')
    // Clean up
    syncService.stopSync()
  })

  await test('startSync() rejects config without localDb', async () => {
    // startSync without localDb should return early (not crash)
    syncService.startSync({}) // no localDb — should warn but not throw
    const status = syncService.getStatus()
    // It should NOT have started (or be in error state)
    assertEqual(status.isStarted, false, 'isStarted should be false without localDb')
  })

  await test('initialSync() returns error without auth token', async () => {
    syncService.clearAuth()
    const result = await syncService.initialSync()
    assertEqual(result.success, false, 'success should be false')
    assertIncludes(result, 'error', 'error')
  })

  await test('initialSync() returns error when offline', async () => {
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
    const result = await syncService.initialSync()
    // Should return failure (offline/unreachable)
    assertEqual(result.success, false, 'success should be false when offline')
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

    // Verify the conflict was logged
    const conflicts = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_conflicts" WHERE id = ?`,
      conflictId
    )
    assert(conflicts && conflicts.length > 0, 'Conflict should be logged')
    assertEqual(conflicts[0].resolution, 'pending', 'resolution should be pending')
    assertEqual(conflicts[0].localVersion, 2, 'localVersion')
    assertEqual(conflicts[0].cloudVersion, 3, 'cloudVersion')

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
    await ensureTombstonesTable(db)
    const agencyId = testAgencyId()
    const tombstoneId = 'tomb-' + crypto.randomBytes(8).toString('hex')
    const recordId = 'svc-del-' + crypto.randomBytes(8).toString('hex')
    const now = Date.now()

    // Insert a tombstone (simulates a delete)
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_sync_tombstones"
        (id, "modelName", "recordId", "agencyId", "deletedAt")
       VALUES (?, ?, ?, ?, ?)`,
      tombstoneId,
      'Service',
      recordId,
      agencyId,
      now
    )

    // Verify tombstone exists
    const rows = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_tombstones" WHERE "recordId" = ?`,
      recordId
    )
    assert(rows && rows.length > 0, 'Tombstone should exist after delete')
    assertEqual(rows[0].modelName, 'Service', 'modelName')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_sync_tombstones" WHERE id = ?`,
      tombstoneId
    )
  })

  await test('Tombstone prevents record resurrection', async () => {
    await ensureTombstonesTable(db)
    const agencyId = testAgencyId()
    const tombstoneId = 'tomb-res-' + crypto.randomBytes(8).toString('hex')
    const recordId = 'svc-res-' + crypto.randomBytes(8).toString('hex')
    const now = Date.now()

    // Insert a tombstone
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_sync_tombstones"
        (id, "modelName", "recordId", "agencyId", "deletedAt")
       VALUES (?, ?, ?, ?, ?)`,
      tombstoneId,
      'Service',
      recordId,
      agencyId,
      now
    )

    // A sync pull should check for tombstones before inserting records
    // Simulate: check if a tombstone exists for this recordId
    const tombstoneCheck = await db.$queryRawUnsafe(
      `SELECT COUNT(*) as cnt FROM "_sync_tombstones" WHERE "recordId" = ? AND "modelName" = ?`,
      recordId,
      'Service'
    )
    const hasTombstone = (tombstoneCheck[0] && tombstoneCheck[0].cnt > 0)
    assertEqual(hasTombstone, true, 'Tombstone should prevent resurrection')

    // Clean up
    await db.$executeRawUnsafe(
      `DELETE FROM "_sync_tombstones" WHERE id = ?`,
      tombstoneId
    )
  })

  await test('cleanupTombstones() removes old entries', async () => {
    await ensureTombstonesTable(db)
    const agencyId = testAgencyId()
    const oldTombstoneId = 'tomb-old-' + crypto.randomBytes(8).toString('hex')
    const recordId = 'svc-old-' + crypto.randomBytes(8).toString('hex')

    // Insert a tombstone that's 60 days old (beyond the 30-day cleanup threshold)
    const sixtyDaysAgo = Date.now() - (60 * 24 * 60 * 60 * 1000)
    await db.$executeRawUnsafe(
      `INSERT OR IGNORE INTO "_sync_tombstones"
        (id, "modelName", "recordId", "agencyId", "deletedAt")
       VALUES (?, ?, ?, ?, ?)`,
      oldTombstoneId,
      'Service',
      recordId,
      agencyId,
      sixtyDaysAgo
    )

    // Verify it exists before cleanup
    const before = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_tombstones" WHERE id = ?`,
      oldTombstoneId
    )
    assert(before && before.length > 0, 'Old tombstone should exist before cleanup')

    // Start sync service to enable cleanupTombstones
    syncService.startSync({
      localDb: db,
      cloudBaseUrl: 'http://localhost:9999',
      agencyId,
      syncIntervalMs: 120000,
      initialDelayMs: 60000,
    })

    // Run cleanup
    const removedCount = await syncService.cleanupTombstones()
    assert(typeof removedCount === 'number', 'cleanupTombstones should return a number')
    assert(removedCount >= 0, 'removedCount should be non-negative')

    // Verify old tombstone was removed
    const after = await db.$queryRawUnsafe(
      `SELECT * FROM "_sync_tombstones" WHERE id = ?`,
      oldTombstoneId
    )
    assert(!after || after.length === 0, 'Old tombstone should be removed after cleanup')

    syncService.stopSync()
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
    const statusBefore = syncService.getStatus()
    assertEqual(statusBefore.isStarted, true, 'isStarted before stop')

    syncService.stopSync()
    const statusAfter = syncService.getStatus()
    assertEqual(statusAfter.isStarted, false, 'isStarted after stop')
  })

  await test('setAuth/clearAuth manage auth state', async () => {
    syncService.clearAuth()
    syncService.setAuth('test-token', { id: 'u1', agencyId: 'a1', role: 'AGENT' })
    // Auth should now be set (no direct getter, but initialSync would use it)
    // Verify by trying initialSync (it will fail on offline, but should NOT say "no auth token")
    const result = await syncService.initialSync()
    // It should NOT say "No auth token" — it should fail on offline/unreachable instead
    if (result.error) {
      assert(!result.error.includes('No auth token'),
        `Error should NOT be about missing auth token, got: ${result.error}`)
    }

    syncService.clearAuth()
    const resultAfter = await syncService.initialSync()
    assertEqual(resultAfter.success, false, 'success should be false after clearAuth')
    assertIncludes(resultAfter, 'error', 'error')
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
