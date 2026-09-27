#!/usr/bin/env node
/**
 * BLASTI Stale Cloud Generation — Tests (Task 48)
 *
 * Scenario: the cloud database is re-seeded — emails/usernames persist but
 * every row id is NEW. A local mirror of the previous generation then collides
 * on unique columns during login/initial-sync (P2002 on `email`).
 *
 * Covered defenses:
 *   Layer 1 — row-level rescue: _resolveStaleUniqueRow + _upsertRecord retry
 *   Layer 2 — stale-generation pre-flight: detect + guarded wipe (Step 0b)
 *   Layer 3 — login-path rescue in local-api/index.js (verified by review;
 *             this suite covers the shared initial-sync helpers)
 *
 * Usage: node test-stale-generation.js
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

// Isolated per-run DB dir — MUST be set before requiring lib/db.
const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'blasti-stale-gen-'))
process.env.BLASTI_LOCAL_DB_DIR = TEST_DB_DIR

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

const dbModule = require('../lib/db')
const initialSync = require('../initial-sync')

if (!dbModule.localDb) {
  console.error('FATAL: local Prisma client not available')
  process.exit(1)
}

async function main() {
  const ready = await dbModule.ensureDatabaseReady()
  if (!ready || !ready.ok) {
    console.error('FATAL: ensureDatabaseReady failed: ' + (ready && ready.error))
    process.exit(1)
  }
  const db = dbModule.localDb

  console.log(`\n${'━'.repeat(55)}`)
  console.log('  Stale Cloud Generation defenses (Task 48)')
  console.log(`${'━'.repeat(55)}\n`)

  // ─── Exports ───────────────────────────────────────────────────────────────

  await test('exports — stale-generation API + wipe order', () => {
    assert(typeof initialSync.isUniqueConstraintError === 'function', 'isUniqueConstraintError missing')
    assert(typeof initialSync.extractConflictFields === 'function', 'extractConflictFields missing')
    assert(typeof initialSync.resolveStaleUniqueRow === 'function', 'resolveStaleUniqueRow missing')
    assert(typeof initialSync.detectStaleGeneration === 'function', 'detectStaleGeneration missing')
    assert(typeof initialSync.wipeAllSyncedData === 'function', 'wipeAllSyncedData missing')
    assert(typeof initialSync.wipeIfStaleGeneration === 'function', 'wipeIfStaleGeneration missing')
    assert(Array.isArray(initialSync.STALE_WIPE_ORDER) && initialSync.STALE_WIPE_ORDER.includes('User'), 'STALE_WIPE_ORDER missing User')
    assert(initialSync.STALE_WIPE_ORDER.includes('AgencyLocalState'), 'STALE_WIPE_ORDER missing AgencyLocalState')
  })

  // ─── Layer 1 helpers: classification + field extraction ────────────────────

  await test('isUniqueConstraintError — P2002 code, SQLITE message, negatives', () => {
    assert(initialSync.isUniqueConstraintError({ code: 'P2002', message: 'x' }) === true, 'P2002 not recognized')
    assert(initialSync.isUniqueConstraintError(new Error('UNIQUE constraint failed: User.email')) === true, 'SQLITE message not recognized')
    assert(initialSync.isUniqueConstraintError(new Error('Connection refused')) === false, 'false positive on network error')
    assert(initialSync.isUniqueConstraintError(null) === false, 'false positive on null')
  })

  await test('extractConflictFields — P2002 meta.target variants', () => {
    const e1 = { code: 'P2002', meta: { target: ['User.email_key'] } }
    assert(JSON.stringify(initialSync.extractConflictFields(e1)) === '["email"]', 'index-name form: ' + JSON.stringify(initialSync.extractConflictFields(e1)))
    const e2 = { code: 'P2002', meta: { target: ['email', 'username'] } }
    assert(JSON.stringify(initialSync.extractConflictFields(e2)) === '["email","username"]', 'field-list form')
    assert(initialSync.extractConflictFields(new Error('no info')).length === 0, 'expected empty for unparseable')
  })

  await test('extractConflictFields — raw SQLite message', () => {
    const e = new Error('UNIQUE constraint failed: User.email, User.username')
    const fields = initialSync.extractConflictFields(e)
    assert(fields.includes('email') && fields.includes('username'), 'got: ' + JSON.stringify(fields))
  })

  // ─── Layer 1: row-level rescue ─────────────────────────────────────────────

  await test('resolveStaleUniqueRow — deletes stale row with SAME email DIFFERENT id', async () => {
    await db.user.deleteMany({})
    await db.user.create({ data: { id: 'old-user-id', username: 'owner', fullName: 'Old Gen', email: 'owner@test' } })
    const fakeP2002 = { code: 'P2002', meta: { target: ['User.email_key'] } }
    const rescued = await initialSync.resolveStaleUniqueRow(db, 'User', fakeP2002, { id: 'new-user-id', email: 'owner@test', username: 'owner' })
    assert(rescued === true, 'rescue returned falsy')
    const stale = await db.user.findUnique({ where: { id: 'old-user-id' } })
    assert(!stale, 'stale row still present')
  })

  await test('resolveStaleUniqueRow — leaves same-id rows untouched', async () => {
    await db.user.deleteMany({})
    await db.user.create({ data: { id: 'same-id', username: 'owner2', fullName: 'Same', email: 'same@test' } })
    const fakeP2002 = { code: 'P2002', meta: { target: ['User.email_key'] } }
    const rescued = await initialSync.resolveStaleUniqueRow(db, 'User', fakeP2002, { id: 'same-id', email: 'same@test' })
    assert(rescued === false, 'rescued a row with the SAME id')
    const row = await db.user.findUnique({ where: { id: 'same-id' } })
    assert(row, 'row was deleted')
  })

  await test('resolveStaleUniqueRow — ignores unresolvable fields', async () => {
    const fakeP2002 = { code: 'P2002', meta: { target: ['User.deviceFingerprint_key'] } }
    const rescued = await initialSync.resolveStaleUniqueRow(db, 'User', fakeP2002, { id: 'u1', deviceFingerprint: 'fp' })
    assert(rescued === false, 'probed a non-identity field')
  })

  await test('upsertBatch — unique conflict is rescued in the REAL import path', async () => {
    await db.user.deleteMany({})
    await db.user.create({ data: { id: 'gen1-user', username: 'owner3', fullName: 'Gen1', email: 'gen3@test' } })
    const result = await initialSync.upsertBatch(db, 'User', [
      { id: 'gen2-user', username: 'owner3', fullName: 'Gen2', email: 'gen3@test', role: 'OWNER', language: 'ar' },
    ], [])
    assert(result.upserted === 1 && result.deferred === 0, 'batch result: ' + JSON.stringify(result))
    const rows = await db.user.findMany({})
    assert(rows.length === 1 && rows[0].id === 'gen2-user', 'expected exactly the new-generation row, got: ' + JSON.stringify(rows.map(r => r.id)))
  })

  // ─── Layer 2: stale-generation detection + guarded wipe ────────────────────

  await test('detectStaleGeneration — same email different id → stale', async () => {
    await db.user.deleteMany({})
    await db.user.create({ data: { id: 'local-old-id', username: 'owner4', fullName: 'Local', email: 'gen4@test' } })
    const verdict = await initialSync.detectStaleGeneration(db, { agencyId: 'agency-x', userId: 'cloud-new-id', email: 'gen4@test', username: 'owner4' })
    assert(verdict.stale === true, 'expected stale verdict, got: ' + JSON.stringify(verdict))
    assert(String(verdict.reason).includes('local-old-id') && String(verdict.reason).includes('cloud-new-id'), 'reason lacks ids: ' + verdict.reason)
  })

  await test('detectStaleGeneration — matching id or empty DB → clean', async () => {
    const v1 = await initialSync.detectStaleGeneration(db, { agencyId: 'agency-x', userId: 'local-old-id', email: 'gen4@test', username: 'owner4' })
    assert(v1.stale === false, 'same id flagged stale')
    await db.user.deleteMany({})
    const v2 = await initialSync.detectStaleGeneration(db, { agencyId: 'agency-x', userId: 'cloud-new-id', email: 'gen4@test', username: 'owner4' })
    assert(v2.stale === false, 'empty DB flagged stale')
    const v3 = await initialSync.detectStaleGeneration(db, { agencyId: 'agency-x', userId: null, email: 'gen4@test' })
    assert(v3.stale === false, 'missing userId flagged stale')
  })

  await test('wipeIfStaleGeneration — skipped while INITIALIZING (resume-safe)', async () => {
    await db.user.deleteMany({}).catch(() => {})
    await db.agency.deleteMany({}).catch(() => {})
    await db.user.create({ data: { id: 'owner-of-agx', username: 'agx-owner', fullName: 'AGX Owner', email: 'agx-owner@test' } })
    await db.agency.create({ data: { id: 'agency-x', name: 'A', customCode: 'AGX1', category: 'OTHER', ownerId: 'owner-of-agx' } })
    const existing = await db.agencyLocalState.findUnique({ where: { agencyId: 'agency-x' } })
    if (existing) {
      await db.agencyLocalState.update({ where: { agencyId: 'agency-x' }, data: { initializationStatus: 'INITIALIZING' } })
    } else {
      await db.agencyLocalState.create({ data: { id: 'als-1', agencyId: 'agency-x', initializationStatus: 'INITIALIZING' } })
    }
    await db.user.create({ data: { id: 'stale-gen-user', username: 'owner5', fullName: 'Stale', email: 'gen5@test' } })
    const result = await initialSync.wipeIfStaleGeneration(db, { agencyId: 'agency-x', userId: 'cloud-new-id', email: 'gen5@test', username: 'owner5' }, null)
    assert(result.wiped === false && result.skipped === true, 'expected skip, got: ' + JSON.stringify(result))
    const still = await db.user.findUnique({ where: { id: 'stale-gen-user' } })
    assert(still, 'INITIALIZING workspace was wiped (resume corruption!)')
  })

  await test('wipeIfStaleGeneration — stale generation wipes the local mirror', async () => {
    // NOT_INITIALIZED + stale user present → wipe everything synced
    await db.agencyLocalState.update({ where: { agencyId: 'agency-x' }, data: { initializationStatus: 'NOT_INITIALIZED' } }).catch(async () => {
      await db.agencyLocalState.create({ data: { id: 'als-2', agencyId: 'agency-x', initializationStatus: 'NOT_INITIALIZED' } })
    })
    await db.branch.create({ data: { id: 'br-1', name: 'B', agencyId: 'agency-x' } }).catch(() => {})
    const result = await initialSync.wipeIfStaleGeneration(db, { agencyId: 'agency-x', userId: 'cloud-new-id', email: 'gen5@test', username: 'owner5' }, null)
    assert(result.wiped === true, 'expected wipe, got: ' + JSON.stringify(result))
    const users = await db.user.findMany({})
    const agencies = await db.agency.findMany({})
    const branches = await db.branch.findMany({})
    const als = await db.agencyLocalState.findMany({})
    assert(users.length === 0, 'User rows survived: ' + users.length)
    assert(agencies.length === 0, 'Agency rows survived: ' + agencies.length)
    assert(branches.length === 0, 'Branch rows survived: ' + branches.length)
    assert(als.length === 0, 'AgencyLocalState survived: ' + als.length)
  })

  await test('wipeIfStaleGeneration — clean workspace is NOT wiped', async () => {
    await db.user.create({ data: { id: 'owner-of-agy', username: 'agy-owner', fullName: 'AGY Owner', email: 'agy-owner@test' } })
    await db.agency.create({ data: { id: 'agency-y', name: 'Y', customCode: 'AGY1', category: 'OTHER', ownerId: 'owner-of-agy' } })
    const result = await initialSync.wipeIfStaleGeneration(db, { agencyId: 'agency-y', userId: 'brand-new-user', email: 'nobody@test', username: 'nobody' }, null)
    assert(result.wiped === false, 'clean workspace wiped: ' + JSON.stringify(result))
    const agency = await db.agency.findUnique({ where: { id: 'agency-y' } })
    assert(agency, 'clean workspace data destroyed')
  })

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'━'.repeat(55)}`)
  console.log(`  ${_colors.green}${_passed} passed${_colors.reset}, ${_failed ? _colors.red : _colors.green}${_failed} failed${_colors.reset}`)
  console.log(`${'━'.repeat(55)}\n`)

  if (_errors.length) {
    console.error('Failures:')
    for (const e of _errors) console.error('  -', e.name, '::', (e.error && e.error.message) || e.error)
  }

  await db.$disconnect().catch(() => {})
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }) } catch { /* keep temp dir on lock */ }
  process.exit(_failed ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
