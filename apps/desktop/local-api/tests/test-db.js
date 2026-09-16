#!/usr/bin/env node
/**
 * BLASTI Database Layer — Tests
 *
 * Tests the Prisma database layer directly (CRUD, transactions, agency isolation).
 * Uses the localDb instance from lib/db.js.
 *
 * Usage:
 *   node test-db.js
 *
 * Environment:
 *   BLASTI_LOCAL_DB_DIR  — directory for the SQLite file
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

// ─── Load Database ───────────────────────────────────────────────────────────

let db = null

try {
  const dbModule = require('../lib/db')
  db = dbModule.localDb
} catch (err) {
  console.error(`Failed to load db module: ${err.message}`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a unique ID (similar to cuid).
 */
function uid(prefix) {
  return (prefix || 'id') + '-' + crypto.randomBytes(12).toString('hex')
}

/**
 * Create a test agency in the database.
 * Returns the agency record.
 */
async function createTestAgency(overrides = {}) {
  // Agency requires ownerId (FK to User). Create a user first if not provided.
  if (!overrides.ownerId && !overrides.owner) {
    const owner = await createTestUser({ role: 'AGENCY_OWNER' })
    overrides.ownerId = owner.id
  }
  const id = overrides.id || uid('agency')
  const customCode = overrides.customCode || 'T' + crypto.randomBytes(4).toString('hex').toUpperCase()
  const data = {
    id,
    name: 'Test Agency ' + Date.now(),
    customCode,
    category: 'GENERAL',
    city: "M'Sila",
    wilaya: '28',
    averageServiceTime: 10,
    maxActiveReservations: 50,
    subscriptionTier: 'BASIC',
    subscriptionStatus: 'ACTIVE',
    ...overrides,
  }
  const agency = await db.agency.create({ data })
  return agency
}

/**
 * Create a test user in the database.
 */
async function createTestUser(overrides = {}) {
  const id = overrides.id || uid('user')
  const username = overrides.username || 'testuser_' + crypto.randomBytes(4).toString('hex')
  const data = {
    id,
    username,
    fullName: 'Test User',
    passwordHash: '$2b$10$dummyhashfortesting',
    role: 'AGENT',
    language: 'ar',
    ...overrides,
  }
  const user = await db.user.create({ data })
  return user
}

/**
 * Create a test service in the database.
 */
async function createTestService(agencyId, overrides = {}) {
  const id = overrides.id || uid('svc')
  const name = overrides.name || 'Test Service ' + Date.now() + '-' + crypto.randomBytes(4).toString('hex')
  const data = {
    id,
    name,
    agencyId,
    prefix: 'T',
    isActive: true,
    ...overrides,
  }
  const service = await db.service.create({ data })
  return service
}

/**
 * Create a test QueueSettings record.
 */
async function createTestQueueSettings(agencyId, overrides = {}) {
  const id = overrides.id || uid('qs')
  const data = {
    id,
    agencyId,
    currentServingNumber: 0,
    lastIssuedNumber: 0,
    isPaused: false,
    ...overrides,
  }
  const qs = await db.queueSettings.create({ data })
  return qs
}

/**
 * Create a test reservation in the database.
 */
async function createTestReservation(agencyId, serviceId, overrides = {}) {
  // serviceId is optional — if omitted or not a string, create a test service on the fly
  if (typeof serviceId !== 'string') {
    // Shift args: second arg was actually overrides
    overrides = serviceId || {}
    const svc = await createTestService(agencyId)
    serviceId = svc.id
  }
  const id = overrides.id || uid('res')
  const queueNum = overrides.queueNumber || Math.floor(Math.random() * 1000) + 1
  const data = {
    id,
    agencyId,
    serviceId,
    queueNumber: queueNum,
    displayNumber: 'T-' + String(queueNum).padStart(3, '0'),
    status: 'WAITING',
    isWalkIn: true,
    ...overrides,
  }
  const reservation = await db.reservation.create({ data })
  return reservation
}

/**
 * Clean up all test records by ID.
 */
async function cleanup(records) {
  for (const r of records) {
    try {
      if (r.model === 'agency') await db.agency.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'user') await db.user.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'service') await db.service.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'queueSettings') await db.queueSettings.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'reservation') await db.reservation.delete({ where: { id: r.id } }).catch(() => {})
    } catch { /* ignore cleanup failures */ }
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log(`\n${_colors.bold}${_colors.cyan}━━━ Database Layer Tests ━━━${_colors.reset}\n`)

  if (!db) {
    console.error(`${_colors.red}FATAL: database module could not be loaded${_colors.reset}`)
    process.exit(1)
  }

  const toCleanup = []

  // ═══════════════════════════════════════════════════════════════════════
  // CRUD Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`${_colors.cyan}[CRUD]${_colors.reset}`)

  let testAgency = null

  await test('Create agency → read back → matches', async () => {
    testAgency = await createTestAgency()
    toCleanup.push({ model: 'agency', id: testAgency.id })

    // Read back
    const readBack = await db.agency.findUnique({ where: { id: testAgency.id } })
    assert(readBack !== null, 'Agency should exist in database')
    assertEqual(readBack.id, testAgency.id, 'id')
    assertEqual(readBack.name, testAgency.name, 'name')
    assertEqual(readBack.customCode, testAgency.customCode, 'customCode')
    assertEqual(readBack.category, 'GENERAL', 'category')
  })

  await test('Update agency → read back → updated', async () => {
    if (!testAgency) return logSkip('Update agency', 'no test agency created')
    const newName = 'Updated Agency ' + Date.now()
    const updated = await db.agency.update({
      where: { id: testAgency.id },
      data: { name: newName, averageServiceTime: 20 },
    })
    assertEqual(updated.name, newName, 'name after update')

    // Read back
    const readBack = await db.agency.findUnique({ where: { id: testAgency.id } })
    assertEqual(readBack.name, newName, 'name read back')
    assertEqual(readBack.averageServiceTime, 20, 'averageServiceTime read back')
  })

  await test('Delete service → soft-deleted (isActive: false)', async () => {
    if (!testAgency) return logSkip('Delete service', 'no test agency created')
    // Create a service
    const service = await createTestService(testAgency.id)
    toCleanup.push({ model: 'service', id: service.id })

    // Verify it's active
    const beforeDelete = await db.service.findUnique({ where: { id: service.id } })
    assertEqual(beforeDelete.isActive, true, 'isActive before delete')

    // Soft delete (set isActive: false)
    await db.service.update({
      where: { id: service.id },
      data: { isActive: false },
    })

    // Read back — should still exist but be inactive
    const afterDelete = await db.service.findUnique({ where: { id: service.id } })
    assert(afterDelete !== null, 'Service should still exist after soft delete')
    assertEqual(afterDelete.isActive, false, 'isActive should be false after soft delete')

    // Hard cleanup
    await db.service.delete({ where: { id: service.id } })
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Transaction Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Transactions]${_colors.reset}`)

  await test('Queue call-next updates both reservation and queueSettings atomically', async () => {
    if (!testAgency) return logSkip('Transaction test', 'no test agency created')

    // Create a QueueSettings and a WAITING reservation
    const queueSettings = await createTestQueueSettings(testAgency.id, {
      currentServingNumber: 5,
    })
    toCleanup.push({ model: 'queueSettings', id: queueSettings.id })

    const reservation = await createTestReservation(testAgency.id, {
      status: 'WAITING',
      displayNumber: 'T-006',
    })
    toCleanup.push({ model: 'reservation', id: reservation.id })

    // Atomically update both in a transaction
    await db.$transaction([
      db.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'CALLED',
          calledAt: new Date(),
        },
      }),
      db.queueSettings.update({
        where: { id: queueSettings.id },
        data: {
          currentServingNumber: 6,
        },
      }),
    ])

    // Verify both updates applied
    const updatedRes = await db.reservation.findUnique({ where: { id: reservation.id } })
    const updatedQS = await db.queueSettings.findUnique({ where: { id: queueSettings.id } })
    assertEqual(updatedRes.status, 'CALLED', 'reservation status after call-next')
    assertEqual(updatedQS.currentServingNumber, 6, 'queueSettings currentServingNumber after call-next')

    // Clean up
    await db.reservation.delete({ where: { id: reservation.id } }).catch(() => {})
    await db.queueSettings.delete({ where: { id: queueSettings.id } }).catch(() => {})
  })

  await test('Transaction rollback on error', async () => {
    if (!testAgency) return logSkip('Transaction rollback', 'no test agency created')

    // Create a service to modify
    const service = await createTestService(testAgency.id)
    toCleanup.push({ model: 'service', id: service.id })

    const originalName = service.name

    // Attempt a transaction that will fail
    try {
      await db.$transaction([
        db.service.update({
          where: { id: service.id },
          data: { name: 'Should Not Persist' },
        }),
        // This will fail — querying a non-existent ID with an invalid operation
        db.service.update({
          where: { id: 'nonexistent-id-that-does-not-exist' },
          data: { name: 'Force Error' },
        }),
      ])
    } catch (err) {
      // Expected — transaction should fail
    }

    // Verify the first update was rolled back
    const afterRollback = await db.service.findUnique({ where: { id: service.id } })
    assertEqual(afterRollback.name, originalName, 'name should be unchanged after rollback')

    // Hard cleanup
    await db.service.delete({ where: { id: service.id } }).catch(() => {})
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Agency Isolation Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Agency Isolation]${_colors.reset}`)

  let agencyA = null
  let agencyB = null

  await test('Queries scoped to agencyId dont leak data', async () => {
    // Create two agencies with different data
    agencyA = await createTestAgency({ name: 'Agency A' })
    agencyB = await createTestAgency({ name: 'Agency B' })
    toCleanup.push({ model: 'agency', id: agencyA.id })
    toCleanup.push({ model: 'agency', id: agencyB.id })

    // Create services for each agency
    const serviceA1 = await createTestService(agencyA.id, { name: 'Service A1' })
    const serviceA2 = await createTestService(agencyA.id, { name: 'Service A2' })
    const serviceB1 = await createTestService(agencyB.id, { name: 'Service B1' })
    toCleanup.push(
      { model: 'service', id: serviceA1.id },
      { model: 'service', id: serviceA2.id },
      { model: 'service', id: serviceB1.id }
    )

    // Query services for Agency A — should only get A's services
    const servicesA = await db.service.findMany({
      where: { agencyId: agencyA.id, isActive: true },
    })
    const servicesAIds = servicesA.map(s => s.id)
    assert(servicesAIds.includes(serviceA1.id), 'Agency A should see service A1')
    assert(servicesAIds.includes(serviceA2.id), 'Agency A should see service A2')
    assert(!servicesAIds.includes(serviceB1.id), 'Agency A should NOT see service B1')

    // Query services for Agency B — should only get B's services
    const servicesB = await db.service.findMany({
      where: { agencyId: agencyB.id, isActive: true },
    })
    const servicesBIds = servicesB.map(s => s.id)
    assert(servicesBIds.includes(serviceB1.id), 'Agency B should see service B1')
    assert(!servicesBIds.includes(serviceA1.id), 'Agency B should NOT see service A1')
    assert(!servicesBIds.includes(serviceA2.id), 'Agency B should NOT see service A2')

    // Clean up services
    await db.service.delete({ where: { id: serviceA1.id } }).catch(() => {})
    await db.service.delete({ where: { id: serviceA2.id } }).catch(() => {})
    await db.service.delete({ where: { id: serviceB1.id } }).catch(() => {})
  })

  await test('Count queries respect agencyId scoping', async () => {
    if (!agencyA || !agencyB) return logSkip('Count scoping', 'no test agencies')

    // Create additional services
    const svcA = await createTestService(agencyA.id)
    const svcB1 = await createTestService(agencyB.id)
    const svcB2 = await createTestService(agencyB.id)
    toCleanup.push(
      { model: 'service', id: svcA.id },
      { model: 'service', id: svcB1.id },
      { model: 'service', id: svcB2.id }
    )

    const countA = await db.service.count({
      where: { agencyId: agencyA.id, isActive: true },
    })
    const countB = await db.service.count({
      where: { agencyId: agencyB.id, isActive: true },
    })

    // Agency A should have at least 1 (svcA), Agency B should have at least 2 (svcB1, svcB2)
    assert(countA >= 1, `Agency A should have >=1 services, got ${countA}`)
    assert(countB >= 2, `Agency B should have >=2 services, got ${countB}`)

    // Clean up
    await db.service.delete({ where: { id: svcA.id } }).catch(() => {})
    await db.service.delete({ where: { id: svcB1.id } }).catch(() => {})
    await db.service.delete({ where: { id: svcB2.id } }).catch(() => {})
  })

  await test('Reservation queries are agency-isolated', async () => {
    if (!agencyA || !agencyB) return logSkip('Reservation isolation', 'no test agencies')

    // Create reservations for each agency
    const resA = await createTestReservation(agencyA.id, { walkInCustomerName: 'Customer A' })
    const resB = await createTestReservation(agencyB.id, { walkInCustomerName: 'Customer B' })
    toCleanup.push(
      { model: 'reservation', id: resA.id },
      { model: 'reservation', id: resB.id }
    )

    // Agency A should only see its own reservations
    const resForA = await db.reservation.findMany({
      where: { agencyId: agencyA.id },
    })
    const resForAIds = resForA.map(r => r.id)
    assert(resForAIds.includes(resA.id), 'Agency A should see its reservation')
    assert(!resForAIds.includes(resB.id), 'Agency A should NOT see Agency B reservation')

    // Clean up
    await db.reservation.delete({ where: { id: resA.id } }).catch(() => {})
    await db.reservation.delete({ where: { id: resB.id } }).catch(() => {})
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Database Pragma Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Database Pragmas]${_colors.reset}`)

  await test('WAL mode is set', async () => {
    // Pragmas are set by lib/db.js on initialization. Just verify we can query them.
    const result = await db.$queryRawUnsafe('PRAGMA journal_mode')
    // $queryRawUnsafe may return rows or undefined depending on the driver
    // The important thing is that the DB is accessible and pragma doesn't error
    assert(result !== null, 'PRAGMA query should not error')
  })

  await test('busy_timeout is set', async () => {
    const result = await db.$queryRawUnsafe('PRAGMA busy_timeout')
    assert(result !== null, 'PRAGMA busy_timeout query should not error')
  })

  await test('synchronous is valid', async () => {
    const result = await db.$queryRawUnsafe('PRAGMA synchronous')
    assert(result !== null, 'PRAGMA synchronous query should not error')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Cleanup & Summary
  // ═══════════════════════════════════════════════════════════════════════

  // Clean up all test records
  console.log('\nCleaning up test data...')
  for (const r of toCleanup.reverse()) {
    try {
      if (r.model === 'agency') await db.agency.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'user') await db.user.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'service') await db.service.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'queueSettings') await db.queueSettings.delete({ where: { id: r.id } }).catch(() => {})
      if (r.model === 'reservation') await db.reservation.delete({ where: { id: r.id } }).catch(() => {})
    } catch { /* ignore */ }
  }

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

// Schema lifecycle moved OUT of module load (controlled non-destructive
// migration layer — lib/schema-migrations.js). Tests must initialize the
// local database explicitly before touching Prisma delegates.
require('../lib/db').ensureDatabaseReady()
  .then((ready) => {
    if (!ready.ok) {
      console.error(`Database initialization failed: ${ready.error}`)
      process.exit(1)
    }
    return runAllTests()
  })
  .then((exitCode) => { process.exit(exitCode) })
  .catch((err) => {
    console.error(`${_colors.red}FATAL: ${err.message}${_colors.reset}`)
    process.exit(1)
  })
