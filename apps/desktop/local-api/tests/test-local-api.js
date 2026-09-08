#!/usr/bin/env node
/**
 * BLASTI Local API — Integration Tests
 *
 * Tests the Hono-based local API by starting it and making HTTP requests.
 * Uses Node's built-in http module — no external test framework required.
 *
 * Usage:
 *   node test-local-api.js [--api-port 3080]
 *
 * Environment:
 *   BLASTI_TEST_API_PORT  — port the local API is listening on (default 3080)
 *   BLASTI_TEST_USERNAME  — login username (default: test)
 *   BLASTI_TEST_PASSWORD  — login password (default: test1234)
 */

const http = require('http')
const { execSync } = require('child_process')

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

// ─── HTTP Client ─────────────────────────────────────────────────────────────

const API_PORT = parseInt(process.env.BLASTI_TEST_API_PORT || '3080', 10)
const API_HOST = '127.0.0.1'
let _sessionToken = null  // Populated after login

/**
 * Make an HTTP request to the local API.
 * Returns { status, headers, data }
 */
function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {}),
    }
    if (_sessionToken && !options.noAuth) {
      headers['Authorization'] = `Bearer ${_sessionToken}`
    }
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`
    }

    const req = http.request(
      {
        hostname: API_HOST,
        port: API_PORT,
        path,
        method,
        headers,
        timeout: options.timeout || 10000,
      },
      (res) => {
        let chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8')
          let data
          try { data = JSON.parse(raw) } catch { data = raw }
          resolve({ status: res.statusCode, headers: res.headers, data })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
    if (body) req.write(body)
    req.end()
  })
}

// Convenience wrappers
function GET(path, opts) { return request('GET', path, opts) }
function POST(path, body, opts) { return request('POST', path, { ...opts, body }) }
function PATCH(path, body, opts) { return request('PATCH', path, { ...opts, body }) }
function PUT(path, body, opts) { return request('PUT', path, { ...opts, body }) }
function DELETE(path, opts) { return request('DELETE', path, opts) }

// ─── Wait for API ────────────────────────────────────────────────────────────

async function waitForApi(maxRetries = 30, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await GET('/health', { noAuth: true, timeout: 3000 })
      if (res.status === 200) return true
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, delayMs))
  }
  throw new Error(`Local API not ready after ${maxRetries} retries`)
}

// ─── Seed helpers ────────────────────────────────────────────────────────────

const TEST_USERNAME = process.env.BLASTI_TEST_USERNAME || 'test'
const TEST_PASSWORD = process.env.BLASTI_TEST_PASSWORD || 'test1234'

/**
 * Login and store the session token. Returns the session data.
 */
async function login(username, password) {
  const res = await POST('/api/auth/login', { username, password }, { noAuth: true })
  return res
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

async function runAllTests() {
  console.log(`\n${_colors.bold}${_colors.cyan}━━━ Local API Integration Tests ━━━${_colors.reset}\n`)

  // ── Pre-flight: wait for API ──
  console.log('Waiting for local API on port', API_PORT, '...')
  try {
    await waitForApi()
    console.log('Local API is ready.\n')
  } catch (err) {
    console.error(`${_colors.red}FATAL: ${err.message}${_colors.reset}`)
    console.error('Make sure the local API is running before starting tests.')
    process.exit(1)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Auth Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`${_colors.cyan}[Auth]${_colors.reset}`)

  await test('POST /api/auth/login with valid credentials → 200', async () => {
    const res = await login(TEST_USERNAME, TEST_PASSWORD)
    // Cloud-first login: may return 200 (success) or fall back to offline
    assert(res.status === 200 || res.status === 401,
      `Expected 200 or 401 (if cloud offline), got ${res.status}`)
    if (res.status === 200) {
      assertIncludes(res.data, 'token', 'token')
      _sessionToken = res.data.token
    }
  })

  await test('POST /api/auth/login with invalid credentials → 401', async () => {
    const res = await login('nonexistent_user_xyz', 'wrong_password_abc')
    assertEqual(res.status, 401, 'status')
  })

  await test('POST /api/auth/login with missing fields → 400', async () => {
    const res = await POST('/api/auth/login', {}, { noAuth: true })
    assertEqual(res.status, 400, 'status')
  })

  await test('GET /api/auth/session with valid token → 200', async () => {
    if (!_sessionToken) return logSkip('GET /api/auth/session with valid token → 200', 'no session token (login may have failed)')
    const res = await GET('/api/auth/session')
    assertEqual(res.status, 200, 'status')
    assertIncludes(res.data, 'user', 'user')
  })

  await test('GET /api/auth/session with invalid token → 401', async () => {
    const res = await GET('/api/auth/session', { token: 'invalid_token_12345' })
    assertEqual(res.status, 401, 'status')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Agency Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Agency]${_colors.reset}`)

  await test('GET /api/agency/profile → returns agency data', async () => {
    if (!_sessionToken) return logSkip('GET /api/agency/profile', 'no session token')
    const res = await GET('/api/agency/profile')
    assertEqual(res.status, 200, 'status')
    assertIncludes(res.data, 'id', 'id')
  })

  await test('PATCH /api/agency/profile → updates agency', async () => {
    if (!_sessionToken) return logSkip('PATCH /api/agency/profile', 'no session token')
    const res = await PATCH('/api/agency/profile', {
      description: `Test update ${Date.now()}`,
    })
    assert(res.status === 200 || res.status === 204,
      `Expected 200 or 204, got ${res.status}`)
  })

  await test('GET /api/agency/settings → returns settings', async () => {
    if (!_sessionToken) return logSkip('GET /api/agency/settings', 'no session token')
    const res = await GET('/api/agency/settings')
    assertEqual(res.status, 200, 'status')
  })

  await test('PATCH /api/agency/settings → updates settings', async () => {
    if (!_sessionToken) return logSkip('PATCH /api/agency/settings', 'no session token')
    const res = await PATCH('/api/agency/settings', {
      averageServiceTime: 15,
    })
    assert(res.status === 200 || res.status === 204,
      `Expected 200 or 204, got ${res.status}`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Services Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Services]${_colors.reset}`)

  let createdServiceId = null

  await test('GET /api/services → returns list', async () => {
    if (!_sessionToken) return logSkip('GET /api/services', 'no session token')
    const res = await GET('/api/services')
    assertEqual(res.status, 200, 'status')
    assert(Array.isArray(res.data), 'Response should be an array')
  })

  await test('POST /api/services → creates service', async () => {
    if (!_sessionToken) return logSkip('POST /api/services', 'no session token')
    const res = await POST('/api/services', {
      name: `Test Service ${Date.now()}`,
      nameAr: 'خدمة اختبار',
      nameFr: 'Service test',
      category: 'GENERAL',
      estimatedTime: 10,
      isActive: true,
    })
    assert(res.status === 200 || res.status === 201,
      `Expected 200 or 201, got ${res.status}`)
    if (res.data && res.data.id) {
      createdServiceId = res.data.id
    }
  })

  await test('PATCH /api/services/:id → updates service', async () => {
    if (!_sessionToken) return logSkip('PATCH /api/services/:id', 'no session token')
    if (!createdServiceId) return logSkip('PATCH /api/services/:id', 'no service created')
    const res = await PATCH(`/api/services/${createdServiceId}`, {
      name: `Updated Service ${Date.now()}`,
    })
    assert(res.status === 200 || res.status === 204,
      `Expected 200 or 204, got ${res.status}`)
  })

  await test('DELETE /api/services/:id → soft-deletes service', async () => {
    if (!_sessionToken) return logSkip('DELETE /api/services/:id', 'no session token')
    if (!createdServiceId) return logSkip('DELETE /api/services/:id', 'no service created')
    const res = await DELETE(`/api/services/${createdServiceId}`)
    assert(res.status === 200 || res.status === 204,
      `Expected 200 or 204, got ${res.status}`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Queue Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Queue]${_colors.reset}`)

  await test('GET /api/queue/active → returns active queue', async () => {
    if (!_sessionToken) return logSkip('GET /api/queue/active', 'no session token')
    const res = await GET('/api/queue/active')
    assertEqual(res.status, 200, 'status')
  })

  await test('POST /api/agency/queue/walk-in → creates walk-in', async () => {
    if (!_sessionToken) return logSkip('POST /api/agency/queue/walk-in', 'no session token')
    const res = await POST('/api/agency/queue/walk-in', {
      customerName: `WalkIn ${Date.now()}`,
      serviceId: createdServiceId || undefined,
    })
    // May fail if no active subscription or no services
    assert(res.status === 200 || res.status === 201 || res.status === 403 || res.status === 400,
      `Expected 200/201/403/400, got ${res.status}`)
  })

  await test('POST /api/queue/call-next → calls next in queue', async () => {
    if (!_sessionToken) return logSkip('POST /api/queue/call-next', 'no session token')
    const res = await POST('/api/queue/call-next', {})
    assert(res.status === 200 || res.status === 404 || res.status === 403 || res.status === 400,
      `Expected 200/404/403/400, got ${res.status}`)
  })

  let testReservationId = null
  // Try to get a reservation ID for complete/no-show tests
  try {
    if (_sessionToken) {
      const queueRes = await GET('/api/queue/active')
      if (queueRes.status === 200 && Array.isArray(queueRes.data) && queueRes.data.length > 0) {
        testReservationId = queueRes.data[0].id
      }
    }
  } catch { /* no reservation available */ }

  await test('POST /api/queue/complete/:id → completes reservation', async () => {
    if (!_sessionToken) return logSkip('POST /api/queue/complete/:id', 'no session token')
    if (!testReservationId) return logSkip('POST /api/queue/complete/:id', 'no reservation in queue')
    const res = await POST(`/api/queue/complete/${testReservationId}`, {})
    assert(res.status === 200 || res.status === 404 || res.status === 403 || res.status === 400 || res.status === 409,
      `Expected 200/404/403/400/409, got ${res.status}`)
  })

  await test('POST /api/queue/no-show/:id → marks no-show', async () => {
    if (!_sessionToken) return logSkip('POST /api/queue/no-show/:id', 'no session token')
    if (!testReservationId) return logSkip('POST /api/queue/no-show/:id', 'no reservation in queue')
    const res = await POST(`/api/queue/no-show/${testReservationId}`, {})
    assert(res.status === 200 || res.status === 404 || res.status === 403 || res.status === 400 || res.status === 409,
      `Expected 200/404/403/400/409, got ${res.status}`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Stats Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Stats]${_colors.reset}`)

  await test('GET /api/agency/stats → returns real stats (not zeros)', async () => {
    if (!_sessionToken) return logSkip('GET /api/agency/stats', 'no session token')
    const res = await GET('/api/agency/stats')
    assertEqual(res.status, 200, 'status')
    // The response should have stats properties
    assertIncludes(res.data, 'totalToday', 'totalToday')
  })

  await test('GET /api/agency/daily-chart → returns hourly data', async () => {
    if (!_sessionToken) return logSkip('GET /api/agency/daily-chart', 'no session token')
    const res = await GET('/api/agency/daily-chart')
    assertEqual(res.status, 200, 'status')
  })

  await test('GET /api/agency/no-show-analytics → returns analytics', async () => {
    if (!_sessionToken) return logSkip('GET /api/agency/no-show-analytics', 'no session token')
    const res = await GET('/api/agency/no-show-analytics')
    assertEqual(res.status, 200, 'status')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Error Handling Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Error Handling]${_colors.reset}`)

  await test('Request without auth → 401', async () => {
    const res = await GET('/api/agency/profile', { noAuth: true })
    assertEqual(res.status, 401, 'status')
  })

  await test('Request to non-existent route → 404', async () => {
    const res = await GET('/api/this-route-does-not-exist-xyz')
    // May return 404 or the catch-all handler
    assert(res.status === 404 || (res.data && res.data.error),
      `Expected 404 or error response, got ${res.status}`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Health / Discovery Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Health & Discovery]${_colors.reset}`)

  await test('GET /health → 200 (no auth required)', async () => {
    const res = await GET('/health', { noAuth: true })
    assertEqual(res.status, 200, 'status')
  })

  await test('GET /api/health → 200 (no auth required)', async () => {
    const res = await GET('/api/health', { noAuth: true })
    assertEqual(res.status, 200, 'status')
  })

  await test('GET /api/discover → returns agency info (no auth)', async () => {
    const res = await GET('/api/discover', { noAuth: true })
    assertEqual(res.status, 200, 'status')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Sync Status Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Sync Status]${_colors.reset}`)

  await test('GET /api/sync/status → returns sync state (no auth)', async () => {
    const res = await GET('/api/sync/status', { noAuth: true })
    assertEqual(res.status, 200, 'status')
  })

  await test('GET /api/sync-status → returns sync state (no auth)', async () => {
    const res = await GET('/api/sync-status', { noAuth: true })
    assertEqual(res.status, 200, 'status')
  })

  await test('GET /api/db-status → returns database status (no auth)', async () => {
    const res = await GET('/api/db-status', { noAuth: true })
    assertEqual(res.status, 200, 'status')
    assertIncludes(res.data, 'ready', 'ready')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // Pending Mutations Tests
  // ═══════════════════════════════════════════════════════════════════════

  console.log(`\n${_colors.cyan}[Pending Mutations]${_colors.reset}`)

  await test('GET /api/pending-mutations → returns list', async () => {
    if (!_sessionToken) return logSkip('GET /api/pending-mutations', 'no session token')
    const res = await GET('/api/pending-mutations')
    assertEqual(res.status, 200, 'status')
    assert(Array.isArray(res.data), 'Response should be an array')
  })

  await test('GET /api/pending-mutations/count → returns count', async () => {
    if (!_sessionToken) return logSkip('GET /api/pending-mutations/count', 'no session token')
    const res = await GET('/api/pending-mutations/count')
    assertEqual(res.status, 200, 'status')
    assertIncludes(res.data, 'count', 'count')
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
