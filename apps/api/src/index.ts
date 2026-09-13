/**
 * @blasti/api — Headless Backend Server
 *
 * Hono-based HTTP API + Socket.IO realtime server.
 * Port: 3003
 *
 * Routes:
 *   GET  /health          → Service health check
 *   GET  /stats           → Socket.IO connection stats
 *   ALL  /api/*           → REST API routes (migrated from Next.js)
 *   POST /emit            → Emit a single realtime event (internal, requires x-internal-secret)
 *   POST /emit-batch      → Emit multiple realtime events (internal, requires x-internal-secret)
 *   Socket.IO             → Real-time event broadcasting
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import os from 'os'
import { Server as SocketIOServer } from 'socket.io'
import type { Socket } from 'socket.io'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { verifySessionToken, SessionToken } from './lib/auth'
import {
  getClientIp,
  checkRateLimit,
  checkIpBlocked,
  RateLimitError,
  IpBlockedError,
  GENERAL_RATE_LIMIT,
  REGISTRATION_RATE_LIMIT,
} from './lib/rate-limit'

// ─── Route Modules ──────────────────────────────────────────────────────────

import { authRoutes } from './routes/auth'
import { agencyRoutes } from './routes/agency'
import { adminRoutes } from './routes/admin'
import { agenciesRoutes } from './routes/agencies'
import { reservationsRoutes } from './routes/reservations'
import { queueRoutes } from './routes/queue'
import { notificationRoutes } from './routes/notifications'
import { userRoutes } from './routes/user'
import { reviewRoutes } from './routes/reviews'
import { serviceRoutes } from './routes/services'
import { faqRoutes } from './routes/faqs'
import { statsRoutes } from './routes/stats'
import { smsRoutes } from './routes/sms'
import { cronRoutes } from './routes/cron'
import { deviceRoutes } from './routes/devices'
import { favoriteRoutes } from './routes/favorites'
import { paymentSettingsRoutes } from './routes/payment-settings'
import { qrRoutes } from './routes/qr'
import { transactionRoutes } from './routes/transactions'
import { uploadRoutes } from './routes/upload'
import { syncRoutes } from './routes/sync'
import { settingsRoutes } from './routes/settings'
import { paymentWebhookRoutes } from './routes/payment-webhook'
import { paymentCheckoutRoutes } from './routes/payment-checkout'
import { reconciliationRoutes } from './routes/reconciliation'
import { offlineSyncRoutes } from './routes/offline-sync'
import { qrClaimRoutes } from './routes/qr-claim'
import { agencyDeviceRoutes } from './routes/agency-devices'
import { appVersionRoutes } from './routes/app-versions'
import { db, setupSQLitePragmas } from '@blasti/db'
import { cancelPendingCustomerAlerts } from './lib/cancel-pending-alerts'
import { startNotificationWorker, stopNotificationWorker } from './workers/notification-worker'

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT || '3003', 10)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'

// Phase 1a: Internal secret for securing /emit and /emit-batch endpoints
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || ''

// ─── Startup validation: DATABASE_URL ────────────────────────────────────────
// The root .env is gitignored, so a freshly-cloned/copied project has NO
// DATABASE_URL set. Prisma would then fail on every query with a cryptic
// "Environment variable not found" error, surfacing as HTTP 500 on every
// API call. Fail fast with an actionable message instead.
//
// Additionally, .env.example uses a RELATIVE path (file:./packages/db/data/custom.db)
// but the API's CWD is apps/api/, so Prisma would resolve it wrong. We detect
// relative paths, resolve them against the monorepo root, and rewrite the env
// var to an absolute path before Prisma reads it.
const fs = require('fs')
const path = require('path')

function findMonorepoRoot(): string {
  // Walk up from CWD looking for the packages/ directory (monorepo root marker).
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'packages', 'db'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd() // fallback
}

let DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('\n❌ FATAL: DATABASE_URL is not set.')
  console.error('   The root .env file is gitignored and was not included when the project was copied.')
  console.error('   Fix: copy .env.example → .env at the project root, then restart:\n')
  console.error('       cp .env.example .env')
  console.error('       # then edit .env if your DB path differs\n')
  process.exit(1)
}

// Resolve relative SQLite paths to absolute (against monorepo root) so they
// work regardless of the API's CWD (which is apps/api/ in dev).
if (DATABASE_URL.startsWith('file:')) {
  const dbPath = DATABASE_URL.replace(/^file:/, '').replace(/\?.*$/, '')
  if (!path.isAbsolute(dbPath)) {
    const root = findMonorepoRoot()
    const absolute = path.resolve(root, dbPath)
    DATABASE_URL = `file:${absolute}`
    process.env.DATABASE_URL = DATABASE_URL // rewrite so Prisma picks it up
    console.log(`[db] Resolved relative DATABASE_URL → ${DATABASE_URL}`)
  }
  // Verify the DB file actually exists (Prisma error 14 is opaque).
  const checkPath = DATABASE_URL.replace(/^file:/, '').replace(/\?.*$/, '')
  if (!fs.existsSync(checkPath)) {
    console.error(`\n❌ FATAL: SQLite database file not found: ${checkPath}`)
    console.error('   DATABASE_URL =', DATABASE_URL)
    console.error('   Fix: run the database migration to create it:\n')
    console.error('       bun run db:push\n')
    process.exit(1)
  }
}

// Phase 1c: Allowed origins for CSWSH protection
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(o => o.trim())

// ─── Hono App ──────────────────────────────────────────────────────────────

const app = new Hono()

// Global middleware
// Phase 4: Explicitly allow capacitor://localhost and file:// origins for native CORS
// IMPORTANT: When CORS_ORIGIN is '*', Hono sends Access-Control-Allow-Origin: * which
// is incompatible with credentials: true per the CORS spec. For Electron (page at
// localhost:3000, API at localhost:3003), we must echo the request Origin header
// instead of sending '*'. We use a function to dynamically set the origin.
app.use('*', cors({
  origin: CORS_ORIGIN === '*' ? ((origin) => origin || '*') : [
    ...CORS_ORIGIN.split(',').map(o => o.trim()),
    // Phase 4: Native app origins
    'capacitor://localhost',
    'http://localhost',
    'file://',
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Cookie', 'x-internal-secret'],
  exposeHeaders: ['Set-Cookie'],
  credentials: true,
  maxAge: 86400,
}))
app.use('*', logger())

// ─── Global API Rate Limiting Middleware ────────────────────────────────────
//
// Applies to ALL /api/* routes. Runs after CORS + logger, before route handlers.
// Per-route rate limiting (e.g., auth.ts LOGIN_RATE_LIMIT) is STILL applied —
// the global middleware is a baseline, per-route limits are stricter additions.
//
// Rate limit tiers:
//   General API:   100 req/min per IP (all /api/* routes)
//   Registration:   3 req/min per IP (/api/auth/register — stricter overlay)
//   Login:          5 req/min per IP (handled in auth.ts, not duplicated here)
//   WebSocket:      No rate limit (Socket.IO is handled separately)
//
// Exempt endpoints: /health, /stats (root-level, not under /api/*)

app.use('/api/*', async (c, next) => {
  const path = c.req.path
  const method = c.req.method

  // Get client IP using the existing rate-limit utility.
  // Priority: x-connecting-ip (injected by server) → x-forwarded-for → x-real-ip
  const ip = getClientIp(c)

  // Check if IP is blocked due to repeated abuse
  try {
    checkIpBlocked(ip)
  } catch (error) {
    if (error instanceof IpBlockedError) {
      console.warn(`[RATE-LIMIT] IP blocked: ${ip} tried ${method} ${path}`)
      return c.json(
        { success: false, error: error.message, retryAfter: error.retryAfter },
        429,
        { 'Retry-After': String(error.retryAfter) },
      )
    }
    throw error
  }

  // Apply global rate limit: 100 req/min per IP for all API routes
  try {
    checkRateLimit(ip, GENERAL_RATE_LIMIT)
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.warn(`[RATE-LIMIT] Rate limited: ${ip} on ${method} ${path} (global: 100/min)`)
      return c.json(
        { success: false, error: error.message, retryAfter: error.retryAfter },
        429,
        { 'Retry-After': String(error.retryAfter) },
      )
    }
    throw error
  }

  // Apply stricter registration rate limit: 3 req/min per IP
  if (path === '/api/auth/register') {
    try {
      checkRateLimit(ip, REGISTRATION_RATE_LIMIT)
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.warn(`[RATE-LIMIT] Rate limited: ${ip} on ${method} ${path} (registration: 3/min)`)
        return c.json(
          { success: false, error: error.message, retryAfter: error.retryAfter },
          429,
          { 'Retry-After': String(error.retryAfter) },
        )
      }
      throw error
    }
  }

  await next()
})

// Global error handler
app.onError((err, c) => {
  console.error(`[API Error] ${c.req.method} ${c.req.path}:`, err)
  // P2 FIX: Catch JSON parse errors and return 400 instead of 500
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400)
  }
  if (err instanceof Error && 'statusCode' in err) {
    const authErr = err as { statusCode: number; message: string }
    return c.json({ success: false, error: authErr.message }, authErr.statusCode as 400)
  }
  return c.json({ success: false, error: 'Internal server error' }, 500)
})

// ─── Health & Info Endpoints ────────────────────────────────────────────────

app.get('/', (c) => {
  return c.json({
    name: '@blasti/api',
    version: '0.2.0',
    description: 'BLASTI Headless Backend Server',
    endpoints: {
      health: 'GET /health',
      stats: 'GET /stats',
      api: '/api/*',
      emit: 'POST /emit (requires x-internal-secret)',
      emitBatch: 'POST /emit-batch (requires x-internal-secret)',
      websocket: 'Socket.IO connection (JWT auth required)',
    },
  })
})

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: '@blasti/api',
    version: '0.2.0',
    connections: io?.engine?.clientsCount ?? 0,
    totalConnections,
    totalEventsEmitted,
    uptime: Math.floor(process.uptime()),
    rooms: io?.sockets?.adapter?.rooms?.size ?? 0,
  })
})

// ─── LAN Discovery Endpoint ──────────────────────────────────────────────────
// Used by kiosk devices to auto-discover the BLASTI server on the local network.
// Scanned by the client at http://{ip}:{port}/api/discover

app.get('/api/discover', (c) => {
  const hostname = os.hostname()
  const networkInterfaces = os.networkInterfaces()
  // Find the first non-internal IPv4 address
  let ip = '127.0.0.1'
  for (const name of Object.keys(networkInterfaces)) {
    for (const iface of networkInterfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ip = iface.address
        break
      }
    }
  }
  return c.json({
    service: 'blasti-lan',
    version: '0.2.0',
    name: 'BLASTI Server',
    hostname,
    ip,
    port: PORT,
    apiPort: PORT,
    webPort: parseInt(process.env.WEB_PORT || '3000', 10),
    platform: os.platform(),
    uptime: Math.floor(process.uptime()),
  })
})

app.get('/stats', (c) => {
  const roomList = io ? Array.from(io.sockets.adapter.rooms.keys()) : []
  const roomCounts: Record<string, number> = {}
  for (const room of roomList) {
    const sockets = io.sockets.adapter.rooms.get(room)
    roomCounts[room] = sockets ? sockets.size : 0
  }
  return c.json({
    connections: io?.engine?.clientsCount ?? 0,
    totalConnections,
    totalEventsEmitted,
    rooms: roomCounts,
    uptime: Math.floor(process.uptime()),
  })
})

// ─── API Routes ────────────────────────────────────────────────────────────

app.route('/api/auth', authRoutes)
app.route('/api/agency', agencyRoutes)
app.route('/api/admin', adminRoutes)
app.route('/api/agencies', agenciesRoutes)
app.route('/api/reservations', reservationsRoutes)
app.route('/api/queue', queueRoutes)
app.route('/api/notifications', notificationRoutes)
app.route('/api/user', userRoutes)
app.route('/api/reviews', reviewRoutes)
app.route('/api/services', serviceRoutes)
app.route('/api/faq', faqRoutes)
app.route('/api/faqs', faqRoutes)
app.route('/api/stats', statsRoutes)
app.route('/api/sms', smsRoutes)
app.route('/api/cron', cronRoutes)
app.route('/api/devices', deviceRoutes)
app.route('/api/favorites', favoriteRoutes)
app.route('/api/payment-settings', paymentSettingsRoutes)
app.route('/api/qr', qrRoutes)
app.route('/api/transactions', transactionRoutes)
app.route('/api/upload', uploadRoutes)
app.route('/api/sync', syncRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/payment/webhook', paymentWebhookRoutes)
app.route('/api/payment', paymentCheckoutRoutes)
app.route('/api/reconciliation', reconciliationRoutes)
app.route('/api/offline-sync', offlineSyncRoutes)
app.route('/api/qr-claim', qrClaimRoutes)
app.route('/api/agency-devices', agencyDeviceRoutes)
app.route('/api/app-versions', appVersionRoutes)

// ─── Emit Endpoints (Phase 1a: Secured with x-internal-secret) ────────────

/**
 * Phase 1a: Validate the internal secret header.
 * Only backend services that know the secret can trigger realtime broadcasts.
 */
function validateInternalSecret(c: { req: { header: (name: string) => string | undefined } }): { allowed: boolean; reason?: string } {
  if (!INTERNAL_SECRET) {
    console.error('[SECURITY] INTERNAL_SECRET not configured — /emit endpoints are blocked!')
    return { allowed: false, reason: 'INTERNAL_SECRET must be configured to use emit endpoints' }
  }
  const provided = c.req.header('x-internal-secret')
  if (!provided) {
    return { allowed: false, reason: 'Unauthorized: missing x-internal-secret' }
  }
  // Phase 4d: Use timing-safe comparison to prevent V8 timing leaks
  const providedBuf = Buffer.from(provided, 'utf-8')
  const secretBuf = Buffer.from(INTERNAL_SECRET, 'utf-8')
  if (providedBuf.length !== secretBuf.length) {
    return { allowed: false, reason: 'Unauthorized: invalid x-internal-secret' }
  }
  if (!timingSafeEqual(providedBuf, secretBuf)) {
    return { allowed: false, reason: 'Unauthorized: invalid x-internal-secret' }
  }
  return { allowed: true }
}

app.post('/emit', async (c) => {
  // Phase 1a: Authenticate with x-internal-secret
  const auth = validateInternalSecret(c)
  if (!auth.allowed) {
    return c.json({ success: false, error: auth.reason }, 403)
  }

  try {
    const body = await c.req.json()
    if (!body.type) {
      return c.json({ success: false, error: 'Missing event type' }, 400)
    }
    const result = broadcastEvent(body)
    return c.json({ success: true, recipients: result })
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400)
  }
})

app.post('/emit-batch', async (c) => {
  // Phase 1a: Authenticate with x-internal-secret
  const auth = validateInternalSecret(c)
  if (!auth.allowed) {
    return c.json({ success: false, error: auth.reason }, 403)
  }

  try {
    const body = await c.req.json()
    if (!Array.isArray(body.events)) {
      return c.json({ success: false, error: 'Missing events array' }, 400)
    }
    let totalRecipients = 0
    for (const evt of body.events) {
      totalRecipients += broadcastEvent(evt)
    }
    return c.json({ success: true, count: body.events.length, recipients: totalRecipients })
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400)
  }
})

// ─── Socket.IO Server ──────────────────────────────────────────────────────

let totalConnections = 0
let totalEventsEmitted = 0
let io: SocketIOServer | null = null

// Phase 3: Agency Presence Tracking
const agencyPresence = new Map<string, Set<string>>() // agencyId → Set of socket IDs
const socketAgencyMap = new Map<string, Set<string>>() // socketId → Set of agencyIds

// ─── Event Broadcasting ────────────────────────────────────────────────────

function broadcastEvent(event: Record<string, unknown>): number {
  const type = event.type as string
  const timestamp = Date.now()
  totalEventsEmitted++

  if (!type || !io) return 0

  if (type.startsWith('queue:')) {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → ${room} (${count} recipients)`)
      return count
    }
  }

  if (type.startsWith('reservation:')) {
    const agencyId = event.agencyId as string
    const userId = event.userId as string
    let recipients = 0
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      recipients += sockets ? sockets.size : 0
    }
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      recipients += sockets ? sockets.size : 0
    }
    console.log(`[${type}] → agency:${agencyId || 'none'}, customer:${userId || 'none'} (${recipients} recipients)`)
    return recipients
  }

  if (type.startsWith('notification:')) {
    const userId = event.userId as string
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      console.log(`[${type}] → customer:${userId} (${count} recipients)`)
      return count
    }
  }

  if (type === 'kiosk:update') {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `kiosk:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      const count = sockets ? sockets.size : 0
      return count
    }
  }

  if (type.startsWith('agency:')) {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      return sockets ? sockets.size : 0
    }
  }

  if (type.startsWith('agency-device:')) {
    const agencyId = event.agencyId as string
    const data = event.data as Record<string, unknown>
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit('realtime-event', { type, data })
      return 1
    }
  }

  if (type.startsWith('device:')) {
    const userId = event.userId as string
    const agencyId = event.agencyId as string
    // Agency device events (e.g. device:registered, device:online) go to the agency room
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      return sockets ? sockets.size : 0
    }
    // User device registration events go to the customer room
    if (userId) {
      const room = `customer:${userId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      return sockets ? sockets.size : 0
    }
  }

  if (type.startsWith('admin:')) {
    const room = 'admin:global'
    io.to(room).emit(type, { ...event, timestamp })
    const sockets = io.sockets.adapter.rooms.get(room)
    return sockets ? sockets.size : 0
  }

  if (type.startsWith('staff:')) {
    const agencyId = event.agencyId as string
    if (agencyId) {
      const room = `agency:${agencyId}`
      io.to(room).emit(type, { ...event, timestamp })
      const sockets = io.sockets.adapter.rooms.get(room)
      return sockets ? sockets.size : 0
    }
  }

  return 0
}

// ─── Start Server ──────────────────────────────────────────────────────────

// Create the HTTP server that both Hono and Socket.IO will share
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Convert Node.js IncomingMessage to Web API Request for Hono
  const url = `http://localhost:${PORT}${req.url}`
  const method = req.method || 'GET'
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  // Phase 2a: Inject the TCP socket remote address for rate limiting.
  // This header is set by our own server from the actual socket, so it cannot
  // be spoofed by clients. The rate-limit module reads it as the highest-
  // priority IP source (before X-Forwarded-For etc.).
  const remoteAddress = req.socket?.remoteAddress
  if (remoteAddress) {
    headers.set('x-connecting-ip', remoteAddress)
  }

  let body: ReadableStream | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = new ReadableStream({
      start(controller) {
        req.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
        req.on('end', () => controller.close())
        req.on('error', (err) => controller.error(err))
      }
    })
  }

  // Note: Node.js 18+ requires duplex: 'half' when sending a body with Request
  const webRequest = new Request(url, { method, headers, body, ...(body ? { duplex: 'half' } : {}) })

  try {
    const response = await app.fetch(webRequest)
    res.statusCode = response.status

    // P0 FIX: Handle Set-Cookie headers separately using getSetCookie()
    // The Web API Headers iterator deduplicates header names, causing
    // multiple Set-Cookie headers to be silently dropped (only last one kept).
    // getSetCookie() returns ALL Set-Cookie values as an array.
    const setCookieHeaders = response.headers.getSetCookie?.() ?? []
    if (setCookieHeaders.length > 0) {
      res.setHeader('Set-Cookie', setCookieHeaders)
    }

    // Handle all other headers normally
    for (const [key, value] of response.headers) {
      // Skip transfer-encoding (Node.js handles it) and set-cookie (handled above)
      if (key.toLowerCase() === 'transfer-encoding') continue
      if (key.toLowerCase() === 'set-cookie') continue
      res.setHeader(key, value)
    }
    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    }
    res.end()
  } catch (error) {
    console.error('Hono fetch error:', error)
    res.statusCode = 500
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }))
  }
})

// Phase 1c: Strict Origin checking for CSWSH protection
// Phase 4b: Strict exact-match only — no startsWith, no regex

// Build the full allowed origins list from env + known dev/native origins
const DEV_ORIGINS = new Set([
  'http://localhost:3000',
  'http://localhost:3003',
  'http://localhost:3001',
  'http://localhost',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3003',
  'http://127.0.0.1:3001',
  'http://127.0.0.1',
  'capacitor://localhost',
])

// Phase 4b: Strict exact-match Set — no startsWith, no regex
const STRICT_ALLOWED_ORIGINS = new Set([
  ...ALLOWED_ORIGINS,
  ...DEV_ORIGINS,
  'capacitor://localhost',
  'file://',
])

const isDevelopment = process.env.NODE_ENV !== 'production'

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    // Electron desktop clients may drop the origin header.
    // In production, require JWT auth via the handshake.
    // In development, allow for convenience.
    return isDevelopment
  }
  // Strict exact match ONLY — no startsWith, no regex
  return STRICT_ALLOWED_ORIGINS.has(origin)
}

// Phase 1b: JWT Authentication middleware for Socket.IO
async function authenticateSocket(socket: Socket): Promise<SessionToken | null> {
  const auth = socket.handshake.auth
  const token = auth?.token as string | undefined

  if (!token) {
    // For kiosk and public displays, allow connection without auth
    // but restrict which rooms they can join
    return null
  }

  try {
    const payload = await verifySessionToken(token)
    return payload
  } catch {
    return null
  }
}

// Initialize Socket.IO on the same HTTP server
io = new SocketIOServer(httpServer, {
  // Phase 1c: Strict CORS/Origin check for CSWSH protection
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true)
      } else {
        console.warn(`[CSWSH] Rejected connection from origin: ${origin}`)
        callback(new Error('Origin not allowed'), false)
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  allowUpgrades: true,
  maxHttpBufferSize: 1e6,
  // Phase 1b: Allow unauthenticated connections but track auth state
  allowRequest: async (req, fn) => {
    const origin = req.headers.origin
    // Phase 1c: Reject connections from disallowed origins at handshake level
    if (origin && !isOriginAllowed(origin)) {
      console.warn(`[CSWSH] Blocked handshake from origin: ${origin}`)
      fn('Origin not allowed', false)
      return
    }
    fn(null, true)
  },
})

// Phase 3: Agency Presence Tracking — Heartbeat system
const AGENCY_HEARTBEAT_INTERVAL = 30000 // 30 seconds
const AGENCY_HEARTBEAT_TIMEOUT = 90000  // 90 seconds (3 missed heartbeats)

interface AgencyHeartbeat {
  lastBeat: number
  socketIds: Set<string>
}

const agencyHeartbeats = new Map<string, AgencyHeartbeat>()

// Periodically check for offline agencies
setInterval(() => {
  if (!io) return
  const now = Date.now()
  for (const [agencyId, hb] of agencyHeartbeats.entries()) {
    if (now - hb.lastBeat > AGENCY_HEARTBEAT_TIMEOUT && hb.socketIds.size > 0) {
      console.log(`[PRESENCE] Agency ${agencyId} appears offline (last heartbeat ${Math.round((now - hb.lastBeat) / 1000)}s ago)`)
      // Emit offline event to all customers waiting for this agency
      io.to(`agency:${agencyId}`).emit('queue:agency-offline', {
        type: 'queue:agency-offline',
        agencyId,
        timestamp: now,
        data: { message: 'Agency is temporarily offline' },
      })
      // Clear the heartbeat since we've notified
      hb.socketIds.clear()
    }
  }
}, AGENCY_HEARTBEAT_INTERVAL)

// Socket.IO connection handling
io.on('connection', async (socket) => {
  totalConnections++

  // Phase 1b: Authenticate the socket connection
  const authUser = await authenticateSocket(socket)
  const isAuthenticated = !!authUser

  if (isAuthenticated) {
    console.log(`⚡ Client connected: ${socket.id} (user: ${authUser!.username}, role: ${authUser!.role}) (total: ${io.engine.clientsCount})`)
  } else {
    console.log(`⚡ Client connected: ${socket.id} (unauthenticated/kiosk) (total: ${io.engine.clientsCount})`)
  }

  // Store auth state on socket for room join validation
  ;(socket as any)._authUser = authUser
  ;(socket as any)._isAuthenticated = isAuthenticated

  // ─── Cancel pending carrier alerts when the customer app comes online ───
  // If a customer connects via Socket.IO, they are actively using the app
  // and don't need carrier (SMS/WhatsApp) alerts anymore.
  if (isAuthenticated && authUser) {
    try {
      // Mark user as online in the database
      await db.user.update({ where: { id: authUser.id }, data: { isAppOnline: true } })

      // Cancel any pending delayed alerts for this user's active reservations
      const activeReservations = await db.reservation.findMany({
        where: { userId: authUser.id, status: { in: ['WAITING', 'CALLED'] } },
        select: { id: true },
      })
      for (const res of activeReservations) {
        await cancelPendingCustomerAlerts(authUser.id, res.id)
      }
    } catch (error) {
      console.error('[socket] Error cancelling pending alerts on connect:', error)
    }
  }

  // ─── Phase 1b: Secure Room Joining ────────────────────────────────────

  socket.on('join:room', (room: string) => {
    if (room && typeof room === 'string') {
      // Phase 1b: Validate access to sensitive rooms
      if (room.startsWith('admin:global') && !isAuthenticated) {
        console.warn(`[AUTH] Unauthenticated socket ${socket.id} tried to join admin:global — rejected`)
        return
      }
      if (room.startsWith('agency:') && !isAuthenticated && !(socket as any)._isDevice) {
        console.warn(`[AUTH] Unauthenticated socket ${socket.id} tried to join agency room via join:room — rejected`)
        return
      }
      if (room.startsWith('customer:') && !isAuthenticated) {
        console.warn(`[AUTH] Unauthenticated socket ${socket.id} tried to join customer room via join:room — rejected`)
        return
      }
      socket.join(room)
    }
  })

  socket.on('leave:room', (room: string) => {
    if (room && typeof room === 'string') socket.leave(room)
  })

  socket.on('join:agency', (id: string) => {
    if (id) {
      // M36: Verify the socket is authenticated or is a device
      const auth = (socket as any)._authUser
      const isDevice = (socket as any)._isDevice
      if (!auth && !isDevice) {
        console.warn(`[Socket] Unauthenticated socket tried to join agency:${id}`)
        return
      }

      socket.join(`agency:${id}`)

      // Phase 3: Track agency presence
      if (!agencyPresence.has(id)) agencyPresence.set(id, new Set())
      agencyPresence.get(id)!.add(socket.id)
      if (!socketAgencyMap.has(socket.id)) socketAgencyMap.set(socket.id, new Set())
      socketAgencyMap.get(socket.id)!.add(id)

      // Update heartbeat
      if (!agencyHeartbeats.has(id)) agencyHeartbeats.set(id, { lastBeat: Date.now(), socketIds: new Set() })
      agencyHeartbeats.get(id)!.lastBeat = Date.now()
      agencyHeartbeats.get(id)!.socketIds.add(socket.id)
    }
  })

  socket.on('leave:agency', (id: string) => {
    if (id) {
      socket.leave(`agency:${id}`)
      // Phase 3: Update presence tracking
      agencyPresence.get(id)?.delete(socket.id)
      socketAgencyMap.get(socket.id)?.delete(id)
      agencyHeartbeats.get(id)?.socketIds.delete(socket.id)
    }
  })

  socket.on('join:customer', (id: string) => {
    // Phase 1b: Customers can only join their own room unless admin
    if (id) {
      if (isAuthenticated && authUser && (authUser.id === id || authUser.role === 'SUPER_ADMIN')) {
        socket.join(`customer:${id}`)
      } else if (!isAuthenticated) {
        // Reject unauthenticated customer room joins
        console.warn(`[AUTH] Unauthenticated socket ${socket.id} tried to join customer:${id} — rejected`)
        return
      } else {
        console.warn(`[AUTH] Socket ${socket.id} (user: ${authUser?.username}) tried to join customer:${id} — not authorized`)
        return
      }
    }
  })

  socket.on('leave:customer', (id: string) => {
    if (id) socket.leave(`customer:${id}`)
  })

  socket.on('join:kiosk', (id: string) => {
    if (id) {
      // Log if this is an unauthenticated kiosk (no device token)
      if (!(socket as any)._isDevice) {
        console.log(`[KIOSK] Unauthenticated kiosk joined agency ${id} (legacy mode)`)
      }
      socket.join(`kiosk:${id}`)
    }
  })

  socket.on('leave:kiosk', (id: string) => {
    if (id) socket.leave(`kiosk:${id}`)
  })

  socket.on('join:device', async (token: string) => {
    if (!token || typeof token !== 'string') return

    // Look up device by deviceToken
    const device = await db.agencyDevice.findUnique({
      where: { deviceToken: token },
      select: { id: true, agencyId: true, type: true, status: true }
    })

    if (!device) {
      console.warn(`[AUTH] Socket ${socket.id} tried join:device with invalid token — rejected`)
      return // REJECTED
    }

    // Join device-specific room
    socket.join(`device:${device.id}`)
    // Also join agency room for queue updates
    socket.join(`agency:${device.agencyId}`)
    // Also join kiosk room for backwards compatibility
    socket.join(`kiosk:${device.agencyId}`)

    // Store device info on socket
    ;(socket as any)._deviceId = device.id
    ;(socket as any)._deviceAgencyId = device.agencyId
    ;(socket as any)._isDevice = true

    // Update device status to ONLINE (H7: only if not DISABLED)
    if (device.status !== 'DISABLED') {
      await db.agencyDevice.update({
        where: { id: device.id },
        data: { status: 'ONLINE', lastHeartbeatAt: new Date(), statusChangedAt: new Date() }
      })
    } else {
      // Still update heartbeat but don't change status
      await db.agencyDevice.update({
        where: { id: device.id },
        data: { lastHeartbeatAt: new Date() }
      })
    }

    console.log(`⚡ Device joined: ${socket.id} (device: ${device.id}, type: ${device.type}, agency: ${device.agencyId})`)
  })

  socket.on('leave:device', () => {
    const deviceId = (socket as any)._deviceId
    if (deviceId) {
      socket.leave(`device:${deviceId}`)
      socket.leave(`kiosk:${(socket as any)._deviceAgencyId}`)
      // M5: Also leave the agency room
      socket.leave(`agency:${(socket as any)._deviceAgencyId}`)
    }
  })

  socket.on('join:admin', () => {
    // Phase 1b: Only authenticated admins can join admin room
    if (isAuthenticated && authUser && authUser.role === 'SUPER_ADMIN') {
      socket.join('admin:global')
    } else {
      console.warn(`[AUTH] Socket ${socket.id} tried to join admin:global — not authorized`)
    }
  })

  socket.on('leave:admin', () => {
    socket.leave('admin:global')
  })

  // Phase 3: Agency heartbeat from client
  socket.on('heartbeat:agency', (agencyId: string) => {
    if (agencyId && agencyHeartbeats.has(agencyId)) {
      const hb = agencyHeartbeats.get(agencyId)!
      hb.lastBeat = Date.now()
      hb.socketIds.add(socket.id)
    }
  })

  socket.on('disconnect', async (reason) => {
    console.log(`⚡ Disconnected: ${socket.id} (${reason}) (remaining: ${io.engine.clientsCount})`)

    // Mark user as offline when they disconnect
    const disconnectUser = (socket as any)._authUser as SessionToken | null
    if (disconnectUser) {
      try {
        await db.user.update({ where: { id: disconnectUser.id }, data: { isAppOnline: false } })
      } catch (error) {
        console.error('[socket] Error marking user offline on disconnect:', error)
      }
    }

    // Phase 3: Clean up presence tracking
    const agencyIds = socketAgencyMap.get(socket.id)
    if (agencyIds) {
      for (const agencyId of agencyIds) {
        const presenceSet = agencyPresence.get(agencyId)
        if (presenceSet) {
          presenceSet.delete(socket.id)
          // Fix: Delete empty Sets to prevent Map memory leak
          if (presenceSet.size === 0) {
            agencyPresence.delete(agencyId)
          }
        }
        const hb = agencyHeartbeats.get(agencyId)
        if (hb) {
          hb.socketIds.delete(socket.id)
          // Also clean up empty heartbeat entries
          if (hb.socketIds.size === 0) {
            agencyHeartbeats.delete(agencyId)
          }
        }
      }
      socketAgencyMap.delete(socket.id)
    }

    // Device cleanup on disconnect
    const deviceId = (socket as any)._deviceId
    if (deviceId) {
      // M2: Don't immediately mark OFFLINE — let the heartbeat watchdog handle it
      console.log(`🔌 Device ${deviceId} disconnected`)
      socket.leave(`device:${deviceId}`)
    }
  })
})

httpServer.listen(PORT, '127.0.0.1', async () => {
  // Phase 3b: Set SQLite busy_timeout PRAGMA on startup
  await setupSQLitePragmas()
  console.log(`🚀 @blasti/api server running on port ${PORT}`)
  console.log(`   API:    http://localhost:${PORT}/`)
  console.log(`   Health: http://localhost:${PORT}/health`)
  console.log(`   Routes: http://localhost:${PORT}/api/*`)
  if (INTERNAL_SECRET) {
    console.log(`   🔒 Emit endpoints secured with x-internal-secret`)
  } else {
    console.warn(`   ⛔ INTERNAL_SECRET not set — emit endpoints are BLOCKED (403)`)
  }

  // Start the background notification worker
  startNotificationWorker()
  console.log('   📨 Notification worker started (30s poll interval)')
})

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

// MUST be registered before any async operations
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  // In production, consider exiting and letting the process manager restart.
  // In development, we keep running for easier debugging.
  // To enable auto-restart, set CRASH_ON_UNCAUGHT=1
  if (process.env.CRASH_ON_UNCAUGHT === '1') {
    setTimeout(() => process.exit(1), 500)
  }
})

process.on('SIGTERM', () => {
  stopNotificationWorker()
  if (io) io.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  stopNotificationWorker()
  if (io) io.close()
  process.exit(0)
})
