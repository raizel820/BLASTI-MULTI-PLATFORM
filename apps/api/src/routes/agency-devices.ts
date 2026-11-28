import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { db, dbRaw } from '@blasti/db'
import { requireAuth, authErrorResponse, AuthError } from '../lib/auth'
import { z } from 'zod'
import { recordSyncChange } from '../lib/sync-helpers'
import crypto from 'crypto'
// 0.6.122 — PRESET LAN protocol constants (ports/channels/protocols of the
// reservation-receipt pipeline): the cloud dials host PCs through the SAME
// port ladder as the desktop's own print-relay sender — dedicated :3083
// first, compat :3080 second. Canonical registry: @blasti/core/lan-protocol
// (value-mirrored in apps/desktop/local-api/lib/lan-ports.js).
import {
  LAN_HTTP_API_PORT,
  PRINT_RELAY_TARGET_PORTS,
  PRINT_RELAY_ATTEMPT_TIMEOUT_MS,
  printRelayRequestPath,
} from '@blasti/core/lan-protocol'
import { validateBody, kioskJoinSchema } from '../lib/validations'
import { emitQueueEvent, emitKioskEvent, emitAgencyDeviceEvent, emitPairingWaitEvent } from '../lib/realtime-emit'
// Task 2-a — device walk-in joins create reservations → invalidate cached
// public GETs that expose reservation-derived numbers.
import { invalidateResponseCacheTag } from '../lib/response-cache'
import {
  enforceRateLimit,
  KIOSK_RATE_LIMIT,
  KIOSK_READ_RATE_LIMIT,
  isRateLimitError,
  rateLimitErrorResponse,
  recordSuccessfulRequest,
  recordFailedRequest,
} from '../lib/rate-limit'
import { calculateETA, getEffectiveServiceTime, filterGhostTickets } from '../lib/eta-calculator'
import { appendDeviceEvent } from '../lib/device-event-log'
import { todayLocalDateString } from '../lib/queue-waiting'
// 0.6.119 — deleted-fingerprint blocklist (ghost kiosk fix): a manager-deleted
// device must never resurrect itself through the register routes, and the
// /unpaired strip keeps showing it so the manager can allow re-discovery.
import {
  isDeviceTombstoned,
  addDeviceTombstone,
  clearDeviceTombstone,
  listDeviceTombstones,
  mergeDeviceTombstones,
} from '../lib/device-tombstones'
// 0.6.124 — host-side spooler queues (OneNote / PDF / XPS / fax) must never
// appear as discovered/registered printers on any cloud surface either.
import { isVirtualPrinterName, filterVirtualPrinterDevices } from '../lib/virtual-printers'
import {
  runDiscoveryScan,
  getLocalSubnets,
  getNetworkInterfacesDetailed,
  getProtocolAvailability,
  tcpProbePort,
  httpProbe,
  fingerprintDevice,
  isSignalBackedDevice,
  blastiIdentifyProbe,
  SCAN_PORTS as EMBEDDED_SCAN_PORTS,
  TCP_SWEEP_PORTS,
  type BlastiIdentifyResult,
  type DiscoveredDeviceRaw,
  type DeviceType,
  type ScanPhase,
} from '../lib/discovery/scanner'
// Task 5-a — real multi-protocol cast engine (DLNA SOAP, Samsung Tizen WS,
// LG webOS WS, Roku ECP). Previously dead code; now wired into the routes
// below, mirroring the working desktop local-api implementation.
import {
  castToTv,
  castViaDlna,
  castViaSamsungTizen,
  castViaLgWebOS,
  castViaRokuEcp,
  stopDlnaCast,
  detectCastProtocols,
  type CastProtocol,
  type CastResult,
  type CastTarget,
} from '../lib/discovery/cast-service'

// 0.6.78 — the printAuth middleware on POST /discovery/print resolves the
// kiosk device from the X-Device-Token header and hands it to the route
// handler through this context variable.
// 0.6.104 — kiosk-assigned default printer: the full kiosk row is needed so
// the print route can read its printerConfig JSON (`defaultPrinterDeviceId`).
interface AgencyDevicesEnv {
  Variables: {
    printDevice?: {
      id: string
      name: string
      type: string
      agencyId: string | null
      printerConfig: string | null
    }
  }
}

const app = new Hono<AgencyDevicesEnv>()

// ─── JSON parse helper (M8) ────────────────────────────────────────────────

const parseJSON = (str: unknown): any => {
  if (typeof str !== 'string') return str ?? {}
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

// ─── Rate Limit Maps (M3, M4) ──────────────────────────────────────────────

const heartbeatRateLimits = new Map<string, number>()
const HEARTBEAT_MIN_INTERVAL = 10_000 // 10 seconds

const pairAttemptLimits = new Map<string, { count: number; resetAt: number }>()
const PAIR_MAX_ATTEMPTS = 5
const PAIR_WINDOW_MS = 60_000

// ─── Watchdog throttle (L1) ────────────────────────────────────────────────

let lastWatchdogRun = 0

// ─── Validation Schemas ─────────────────────────────────────────────────────

// TV screen layouts — 0.6.74 adds four simple TV board designs alongside the
// historic rich board (QUEUE_BOARD). Pure string values, no DB enum change.
const SCREEN_LAYOUT_VALUES = [
  'QUEUE_BOARD', 'TICKET_PRINTER', 'SERVICE_SELECTOR', 'CUSTOM',
  'TV_CLASSIC', 'TV_COUNTERS', 'TV_FOCUS', 'TV_MINIMAL',
] as const

const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional(),
  nameFr: z.string().max(100).optional(),
  type: z.enum(['TV', 'KIOSK', 'DISPLAY', 'PRINTER', 'APP'], { message: 'Invalid device type' }).default('TV'),
  connectionType: z.enum(['LAN', 'WIFI', 'CABLE', 'MANUAL'], { message: 'Invalid connection type' }).default('LAN'),
  ipAddress: z.string().max(50).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  autoDiscovery: z.boolean().default(true),
  screenLayout: z.enum(SCREEN_LAYOUT_VALUES, { message: 'Invalid screen layout' }).default('QUEUE_BOARD'),
  branchId: z.string().optional(),
  displaySettings: z.record(z.any()).default({}),
  printerConfig: z.record(z.any()).default({}),
  serviceFilter: z.string().default(''),
})

const updateDeviceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  nameAr: z.string().max(100).optional(),
  nameFr: z.string().max(100).optional(),
  type: z.enum(['TV', 'KIOSK', 'DISPLAY', 'PRINTER', 'APP'], { message: 'Invalid device type' }).optional(),
  status: z.enum(['ONLINE', 'OFFLINE', 'PAIRING', 'DISABLED', 'UPDATING'], { message: 'Invalid status' }).optional(),
  connectionType: z.enum(['LAN', 'WIFI', 'CABLE', 'MANUAL'], { message: 'Invalid connection type' }).optional(),
  ipAddress: z.string().max(50).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  autoDiscovery: z.boolean().optional(),
  screenLayout: z.enum(SCREEN_LAYOUT_VALUES, { message: 'Invalid screen layout' }).optional(),
  branchId: z.string().nullable().optional(),
  displaySettings: z.record(z.any()).optional(),
  printerConfig: z.record(z.any()).optional(),
  serviceFilter: z.string().optional(),
  appVersion: z.string().optional(),
  offlineCapable: z.boolean().optional(),
})

const heartbeatSchema = z.object({
  deviceFingerprint: z.string().optional(),
  appVersion: z.string().optional(),
  ipAddress: z.string().max(50).optional(),
  status: z.enum(['ONLINE', 'OFFLINE'], { message: 'Invalid status' }).optional(),
})

const pairDeviceSchema = z.object({
  pairingCode: z.string().min(1),
})

const ackCommandSchema = z.object({
  status: z.enum(['DELIVERED', 'COMPLETED', 'FAILED'], { message: 'Invalid command status' }),
  error: z.string().optional(),
})

const sendCommandSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.any()).optional(),
  ttl: z.number().int().min(10).max(3600).optional(),
})

const syncDeviceSchema = z.object({
  offlineData: z.array(z.record(z.any())).optional(),
})

// ─── Helpers ────────────────────────────────────────────────────────────────

function generatePairingCode(): string {
  return crypto.randomBytes(2).toString('hex').toUpperCase()
}

// ─── Pairing brute-force guard (0.6.74) ────────────────────────────────────
// 4-char pairing codes (65 536 combinations) are brute-forceable by a bot
// hammering /public/kiosk-auth. We now track consecutive failures per code
// (in-memory — resets on API restart, acceptable for a 10-minute code TTL).
// After PAIRING_MAX_FAILURES wrong token attempts the code is locked out for
// 10 minutes, on top of the per-IP rate limit.
const pairingFailures = new Map<string, { count: number; lockedUntil: number }>()
const PAIRING_MAX_FAILURES = 6
const PAIRING_LOCKOUT_MS = 10 * 60 * 1000

function isPairingCodeLocked(pairingCode: string): boolean {
  const entry = pairingFailures.get(pairingCode)
  if (!entry) return false
  if (entry.lockedUntil > Date.now()) return true
  if (entry.lockedUntil !== 0 && entry.lockedUntil <= Date.now()) {
    pairingFailures.delete(pairingCode)
  }
  return false
}

function recordPairingFailure(pairingCode: string): void {
  const entry = pairingFailures.get(pairingCode) || { count: 0, lockedUntil: 0 }
  entry.count += 1
  if (entry.count >= PAIRING_MAX_FAILURES) {
    entry.lockedUntil = Date.now() + PAIRING_LOCKOUT_MS
  }
  pairingFailures.set(pairingCode, entry)
}

function clearPairingFailures(pairingCode: string): void {
  pairingFailures.delete(pairingCode)
}

/** Select clause used for every device response — never includes deviceToken. */
const DEVICE_SELECT = {
  id: true,
  agencyId: true,
  name: true,
  nameAr: true,
  nameFr: true,
  type: true,
  status: true,
  connectionType: true,
  ipAddress: true,
  port: true,
  pairingCode: true,
  deviceFingerprint: true,
  appVersion: true,
  autoDiscovery: true,
  displaySettings: true,
  printerConfig: true,
  screenLayout: true,
  branchId: true,
  serviceFilter: true,
  lastHeartbeatAt: true,
  statusChangedAt: true,
  connectedAt: true,
  totalUptimeSec: true,
  offlineCapable: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, name: true, nameAr: true, nameFr: true } },
} as const

const DEVICE_INCLUDE = {
  branch: { select: { id: true, name: true, nameAr: true, nameFr: true } },
} as const

// ─── Device Auth Middleware ─────────────────────────────────────────────────
// Authenticates via `Authorization: Bearer <deviceToken>` (NOT JWT).
// SECURITY (0.6.126 audit T1-5): DISABLED (revoked) devices no longer
// authenticate to ANY device route — the token resolves to null, so every
// call site's existing `if (!device) → 401` becomes a revocation enforcement
// point (previously a revoked device kept full device API access forever).

async function requireDeviceAuth(c: Context) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const device = await db.agencyDevice.findFirst({
    where: { deviceToken: token, status: { not: 'DISABLED' } },
    include: DEVICE_INCLUDE,
  })
  return device
}

// ─── Heartbeat Watchdog ────────────────────────────────────────────────────
// Built into the heartbeat handler: marks devices OFFLINE if no heartbeat for 90s.

async function runHeartbeatWatchdog() {
  const staleThreshold = new Date(Date.now() - 90_000)
  // Grace period: don't mark devices offline if created within the last 120 seconds
  const graceThreshold = new Date(Date.now() - 120_000)

  // Mark stale ONLINE devices as OFFLINE (respecting grace period)
  // 0.6.123 — PRINTER rows are EXCLUDED from this blind sweep. Field fault
  // 2026-11-25 ("the printer is connected and I can use it to print but shows
  // as not connected in registered devices"): a printer is PASSIVE hardware —
  // it can never send its own heartbeat, so 90s after registration the sweep
  // flipped every PRINTER row to OFFLINE while the Canon was printing fine.
  // Printer liveness now rides its HOST PC: see the printer pass below and
  // the heartbeat-side touch (POST /device/heartbeat).
  await db.agencyDevice.updateMany({
    where: { lastHeartbeatAt: { lt: staleThreshold }, status: 'ONLINE', createdAt: { lt: graceThreshold }, type: { not: 'PRINTER' } },
    data: { status: 'OFFLINE', statusChangedAt: new Date() },
  })

  // 0.6.123 — PRINTER-DETERMINED LIVENESS: a PRINTER row goes OFFLINE only
  // when its HOST PC is itself stale. The host is the (non-printer) device row
  // registered at the same ipAddress (register-peripheral writes the host's
  // address into the printer row's ipAddress column). Loopback printers and
  // printers with no matching host row are left untouched — no host row means
  // we cannot prove the host is dead, and the user's printer must not show
  // "not connected" while it prints.
  try {
    const printers = await db.agencyDevice.findMany({
      where: { type: 'PRINTER', status: 'ONLINE' },
      select: { id: true, agencyId: true, ipAddress: true },
      take: 200,
    })
    for (const p of printers) {
      const hostIp = typeof p.ipAddress === 'string' ? p.ipAddress : ''
      if (!hostIp || hostIp === '127.0.0.1' || hostIp === 'localhost' || hostIp === '::1') continue
      const host = await db.agencyDevice.findFirst({
        where: { ipAddress: hostIp, type: { not: 'PRINTER' }, ...(p.agencyId ? { agencyId: p.agencyId } : {}) },
        select: { id: true, lastHeartbeatAt: true },
        orderBy: { lastHeartbeatAt: 'desc' },
      })
      if (!host || !host.lastHeartbeatAt) continue
      if (host.lastHeartbeatAt < staleThreshold) {
        await db.agencyDevice.update({
          where: { id: p.id },
          data: { status: 'OFFLINE', statusChangedAt: new Date() },
        }).catch(() => null)
        emitAgencyDeviceEvent('agency-device:updated', p.agencyId, { deviceId: p.id, deviceType: 'PRINTER', hostStale: true })
      }
    }
  } catch { /* printer pass is best-effort */ }

  // Mark stale PAIRING devices (unpaired) as OFFLINE so they disappear from /unpaired (respecting grace period)
  await db.agencyDevice.updateMany({
    where: { lastHeartbeatAt: { lt: staleThreshold }, status: 'PAIRING', agencyId: null, createdAt: { lt: graceThreshold } },
    data: { status: 'OFFLINE', statusChangedAt: new Date() },
  })
}

// ─── Expire old DELIVERED commands (older than 5 minutes) ─────────────────

async function expireOldDeliveredCommands(deviceId: string) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000)
  await db.deviceCommand.updateMany({
    where: {
      deviceId,
      status: 'DELIVERED',
      deliveredAt: { lt: fiveMinAgo },
    },
    data: { status: 'EXPIRED' },
  })
}

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC DEVICE ENDPOINTS (no JWT, dual auth: deviceToken OR IP rate-limit)
//  Used by kiosks, TV boards, and other self-service devices.
//  Mounted at /public/* to avoid conflicts with /:id and /device/* routes.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Validation Schemas for Public Endpoints ─────────────────────────────────

const deviceRegisterSchema = z.object({
  agencyCode: z.string().min(1, 'Agency code is required'),
  deviceName: z.string().max(100).optional(),
  deviceType: z.enum(['KIOSK', 'TV', 'DISPLAY', 'PRINTER', 'APP'], { message: 'Invalid device type' }).optional(),
  connectionType: z.enum(['LAN', 'WIFI', 'CABLE', 'MANUAL'], { message: 'Invalid connection type' }).optional(),
  deviceFingerprint: z.string().max(200).optional(),
})

const discoverRegisterSchema = z.object({
  // NOTE: No agencyCode — discovery registers orphan devices (agencyId: null) in PAIRING status.
  // The manager sends a pairing request later to assign an agency.
  deviceName: z.string().max(100).optional(),
  // 0.6.102 — audit fix: PHONE joins the whitelist so a phone running the
  // BLASTI app (agency account opened) can register as a "PHONE WITH BLASTI
  // APP" device waiting for approval (same channels the kiosk uses).
  deviceType: z.enum(['KIOSK', 'TV', 'DISPLAY', 'PRINTER', 'APP', 'PHONE'], { message: 'Invalid device type' }).default('KIOSK'),
  connectionType: z.enum(['LAN', 'WIFI', 'CABLE', 'MANUAL'], { message: 'Invalid connection type' }).optional(),
  deviceFingerprint: z.string().max(200).optional(),
})

// ─── POST /public/register — Auto-register a device as AgencyDevice ─────────

app.post('/public/register', async (c) => {
  try {
    enforceRateLimit(c, KIOSK_RATE_LIMIT)
    const body = await c.req.json()
    const validation = validateBody(deviceRegisterSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyCode, deviceName, deviceType, connectionType, deviceFingerprint } = validation.data

    // 1. Look up agency by customCode first, then fallback to ID
    let agency = await db.agency.findUnique({
      where: { customCode: agencyCode, isActive: true },
    })
    // Fallback: agencyCode might be an agency ID (e.g. TV board loaded via ?agencyId=)
    if (!agency) {
      agency = await db.agency.findUnique({
        where: { id: agencyCode, isActive: true },
      })
    }

    if (!agency) {
      return c.json({ success: false, error: 'Agency not found or inactive' }, 404)
    }

    const effectiveDeviceType = deviceType || 'KIOSK'
    const effectiveConnectionType = connectionType || 'LAN'
    const effectiveName = deviceName || 'Auto-Kiosk'

    // 2. Check if an AgencyDevice already exists (only match fingerprint when provided)
    const result = await db.$transaction(async (tx) => {
      const existingDevice = deviceFingerprint
        ? await tx.agencyDevice.findFirst({
            where: { agencyId: agency.id, type: effectiveDeviceType, deviceFingerprint },
          })
        : null

      if (existingDevice) {
        // 3. Return existing device + deviceToken (re-generate if needed)
        let token = existingDevice.deviceToken
        if (!token) {
          token = crypto.randomBytes(32).toString('hex')
          await tx.agencyDevice.update({
            where: { id: existingDevice.id },
            data: {
              deviceToken: token,
              status: 'PAIRING',
              name: effectiveName,
              connectionType: effectiveConnectionType,
            },
          })
        }
        return { type: 'existing' as const, device: existingDevice, token }
      }

      // 4. Create new AgencyDevice — BUT a fingerprint the manager
      // deliberately deleted must never resurrect itself here (the kiosk
      // auto-registers on every mount with its saved branch code).
      if (deviceFingerprint && (await isDeviceTombstoned(deviceFingerprint))) {
        return { type: 'removed' as const }
      }
      const pairingCode = generatePairingCode()
      const deviceToken = crypto.randomBytes(32).toString('hex')

      const screenLayout = effectiveDeviceType === 'KIOSK' ? 'SERVICE_SELECTOR' : 'QUEUE_BOARD'
      const offlineCapable = effectiveDeviceType === 'KIOSK'

      const newDevice = await tx.agencyDevice.create({
        data: {
          agencyId: agency.id,
          name: effectiveName,
          type: effectiveDeviceType,
          status: 'PAIRING',
          connectionType: effectiveConnectionType,
          pairingCode,
          deviceToken,
          deviceFingerprint: deviceFingerprint ?? null,
          screenLayout,
          offlineCapable,
          autoDiscovery: true,
        },
      })
      return { type: 'new' as const, device: newDevice, token: deviceToken }
    })

    if (result.type === 'removed') {
      return c.json({ success: false, error: 'DEVICE_REMOVED_BY_MANAGER', removed: true }, 409)
    }

    if (result.type === 'existing') {
      return c.json({
        success: true,
        device: {
          id: result.device.id,
          name: result.device.name,
          type: result.device.type,
          status: result.device.status,
        },
        deviceToken: result.token,
      })
    }

    // Emit device registered event
    emitAgencyDeviceEvent('device:registered', agency.id, {
      deviceId: result.device.id,
      deviceName: result.device.name,
      deviceType: result.device.type,
    })

    return c.json({
      success: true,
      device: {
        id: result.device.id,
        name: result.device.name,
        type: result.device.type,
        status: result.device.status,
      },
      deviceToken: result.token,
    }, 201)
  } catch (error: unknown) {
    console.error('[DEVICE/PUBLIC/REGISTER]', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── POST /public/join-queue — Walk-in customer joins queue ────────────────
// (0.6.124 — KIOSK DEVICE AUTH REQUIRED: paired device rows only; anonymous
//  callers are answered 401 DEVICE_AUTH_REQUIRED. See the route body.)

app.post('/public/join-queue', async (c) => {
  let clientIp: string | undefined
  try {
    // 0.6.124 — REVOCATION ENFORCEMENT (field fault: "unpair/delete should
    // revoke device access but the kiosk can connect normally after been
    // deleted"). The kiosk-only join route used to admit ANY caller: an
    // unauthenticated request passed the IP rate limit, and an authenticated
    // orphan (agencyId null — exactly what remains after a manager deletes or
    // unpairs the device) was silently AUTO-BOUND to the requested agency, so
    // a deleted kiosk kept issuing tickets forever. Tickets now require a
    // device row that STILL exists in this store AND is paired to THIS
    // agency. Walk-in customers keep their own channels (staff walk-in,
    // QR import, mobile app) — this route is the kiosk's.
    const device = await requireDeviceAuth(c)
    let deviceId: string | undefined = undefined

    if (device) {
      deviceId = device.id
      console.log(`[DEVICE/PUBLIC/JOIN] Trusted device: ${device.name} (${device.id})`)
    } else {
      clientIp = enforceRateLimit(c, KIOSK_RATE_LIMIT)
      return c.json({
        success: false,
        error: 'Device not authenticated — this kiosk must be paired with the branch desktop before it can issue tickets',
        code: 'DEVICE_AUTH_REQUIRED',
      }, 401)
    }

    const body = await c.req.json()
    const validation = validateBody(kioskJoinSchema, body)
    if (validation.error) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, serviceId, customerName } = validation.data

    // C1: Cross-Agency Queue Join — STRICT pairing gate (no auto-bind).
    // 0.6.95 had bound orphan rows to the requested agency on first join;
    // that auto-bind is precisely the revocation hole. A device bound to a
    // DIFFERENT agency is rejected, and an unpaired device (deleted,
    // unpaired, freshly registered) must be paired by the manager first —
    // it stays visible in /unpaired so the manager can approve it.
    if (agencyId !== device.agencyId) {
      return c.json({ success: false, error: 'Device not authorized for this agency', code: 'DEVICE_NOT_PAIRED' }, 403)
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId, isActive: true },
      include: { queueSettings: { take: 1, orderBy: { updatedAt: 'desc' } } },
    })

    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)
    if (!agency.isQueueOpen) return c.json({ success: false, error: 'Queue is currently closed' }, 400)
    if (agency.queueSettings.length > 0 && agency.queueSettings[0].isPaused) return c.json({ success: false, error: 'Queue is currently paused' }, 400)

    const service = await db.service.findUnique({ where: { id: serviceId, agencyId } })
    if (!service || !service.isActive) return c.json({ success: false, error: 'Service not found or inactive' }, 404)

    const activeCount = await db.reservation.count({ where: { agencyId, status: { in: ['WAITING', 'CALLED'] } } })
    if (activeCount >= agency.maxActiveReservations) return c.json({ success: false, error: 'Queue is full' }, 400)

    const waitingCount = await db.reservation.count({ where: { agencyId, serviceId, status: 'WAITING' } })

    // ── Unified ETA ──
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const effective = getEffectiveServiceTime(recentCompleted, agency.averageServiceTime)

    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const activeCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
    })

    const isPaused = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false
    const eta = calculateETA({
      peopleAhead: waitingCount,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: activeCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused,
      historicalSampleSize: effective.sampleSize,
    })
    const estimatedWait = eta.estimatedMaxMinutes

    const reservation = await db.$transaction(async (tx) => {
      const cnt = await tx.reservation.count({ where: { agencyId, status: { in: ['WAITING', 'CALLED'] } } })
      if (cnt >= agency.maxActiveReservations) throw new Error('FULL')

      const lastReservation = await tx.reservation.findFirst({ where: { serviceId }, orderBy: { queueNumber: 'desc' } })
      const nextNumber = (lastReservation?.queueNumber || 0) + 1
      const displayNumber = `${service.prefix}-${String(nextNumber).padStart(3, '0')}`

      const res = await tx.reservation.create({
        data: {
          agencyId,
          serviceId,
          queueNumber: nextNumber,
          displayNumber,
          status: 'WAITING',
          estimatedWait,
          isWalkIn: true,
          walkInCustomerName: customerName?.trim() || 'Anonymous',
          userId: null,
          reservedDate: todayLocalDateString(),
        },
      })
      // Spec Part O: tx ops are invisible to the auto-tracking extension.
      await recordSyncChange({ tx, agencyId, model: 'Reservation', recordId: res.id, operation: 'create' })

      if (agency.queueSettings.length > 0) {
        await tx.queueSettings.update({ where: { id: agency.queueSettings[0].id }, data: { lastIssuedNumber: nextNumber } })
        await recordSyncChange({ tx, agencyId, model: 'QueueSettings', recordId: agency.queueSettings[0].id, operation: 'update' })
      }

      return res
    })

    // Generate import token so customer can scan QR to claim reservation into their app
    let importToken = ''
    try {
      const QR_SECRET = process.env.NEXTAUTH_SECRET || 'blast1-qr-dev-key'
      const exp = Math.floor(Date.now() / 1000) + (30 * 60) // 30 min expiry
      const payload = JSON.stringify({ reservationId: reservation.id, agencyId, customerId: customerName?.trim() || 'Anonymous', exp })
      const sig = crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex')
      importToken = Buffer.from(payload).toString('base64url') + '.' + sig
      await db.reservation.update({ where: { id: reservation.id }, data: { importToken } })
    } catch (tokenErr) {
      console.warn('[DEVICE/PUBLIC/JOIN] Failed to generate import token:', tokenErr)
    }

    const position = await db.reservation.count({
      where: { agencyId, serviceId, status: 'WAITING', joinedAt: { lte: reservation.joinedAt } },
    })

    const queueEventData: Record<string, unknown> = {
      reservationId: reservation.id,
      displayNumber: reservation.displayNumber,
      customerName: customerName || 'Anonymous',
      serviceId,
      estimatedWait,
      importToken,
    }
    if (deviceId) queueEventData.deviceId = deviceId

    const kioskEventData: Record<string, unknown> = { action: 'kiosk-join', displayNumber: reservation.displayNumber }
    if (deviceId) kioskEventData.deviceId = deviceId

    emitQueueEvent('queue:walk-in', agencyId, queueEventData)
    emitKioskEvent(agencyId, kioskEventData)

    // Task 2-a — device join is a reservation create.
    invalidateResponseCacheTag('stats', 'agencies')

    // Fetch branch info if device is authenticated and has a branch
    let branchName: string | null = null
    let branchNameAr: string | null = null
    let branchNameFr: string | null = null
    if (device && device.branchId) {
      const branch = await db.branch.findUnique({
        where: { id: device.branchId },
        select: { name: true, nameAr: true, nameFr: true },
      })
      if (branch) {
        branchName = branch.name
        branchNameAr = branch.nameAr
        branchNameFr = branch.nameFr
      }
    } else if (device && device.agencyId) {
      // Try to get default branch
      const defaultBranch = await db.branch.findFirst({
        where: { agencyId: device.agencyId, isActive: true },
        select: { name: true, nameAr: true, nameFr: true },
        orderBy: { createdAt: 'asc' },
      })
      if (defaultBranch) {
        branchName = defaultBranch.name
        branchNameAr = defaultBranch.nameAr
        branchNameFr = defaultBranch.nameFr
      }
    }

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      reservation: {
        id: reservation.id,
        ticketNumber: reservation.displayNumber,
        position,
        estimatedWaitMinutes: estimatedWait,
        customerName: customerName?.trim() || 'Anonymous',
        serviceName: service.name,
        serviceNameAr: service.nameAr,
        serviceNameFr: service.nameFr,
        agencyName: agency.name,
        agencyNameAr: agency.nameAr,
        agencyNameFr: agency.nameFr,
        branchName,
        branchNameAr,
        branchNameFr,
        method: 'WALK_IN',
        joinedAt: reservation.joinedAt,
        importToken,
      },
      deviceId: deviceId ?? null,
    }, 201)
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    if (clientIp) recordFailedRequest(clientIp)
    if (error instanceof Error && error.message === 'FULL') {
      return c.json({ success: false, error: 'Queue is full' }, 400)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── GET /public/queue-status — Queue status for display boards ────────────
// (dual auth: deviceToken OR IP rate-limit)

app.get('/public/queue-status', async (c) => {
  let clientIp: string | undefined
  try {
    const device = await requireDeviceAuth(c)
    let deviceId: string | undefined = undefined

    if (device) {
      deviceId = device.id
    } else {
      clientIp = enforceRateLimit(c, KIOSK_READ_RATE_LIMIT)
    }

    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency ID is required' }, 400)
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId, isActive: true },
      include: {
        services: { where: { isActive: true }, select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
        queueSettings: { select: { isPaused: true, currentServingNumber: true }, take: 1, orderBy: { updatedAt: 'desc' } },
      },
    })

    if (!agency) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    const isPaused = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false

    // Local midnight — drives "served today" and the average serving time.
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompletedForAgency = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true, serviceId: true },
      take: 200,
    })
    const effective = getEffectiveServiceTime(recentCompletedForAgency, agency.averageServiceTime)

    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const totalActiveCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
    })

    const servingReservations = await db.reservation.findMany({
      where: { agencyId, status: { in: ['CALLED', 'SERVING'] } },
      select: { id: true, displayNumber: true, status: true, serviceId: true, calledAt: true, service: { select: { id: true, name: true, prefix: true } }, counter: { select: { id: true, name: true, number: true } } },
      orderBy: { calledAt: 'desc' },
    })

    const serviceStats = await Promise.all(
      agency.services.map(async (service) => {
        const waiting = await db.reservation.count({ where: { agencyId, serviceId: service.id, status: 'WAITING' } })
        const svcCompleted = recentCompletedForAgency.filter(r => r.serviceId === service.id)
        const svcEffective = getEffectiveServiceTime(svcCompleted, agency.averageServiceTime)
        const svcEta = calculateETA({
          peopleAhead: waiting,
          avgServiceTimeMinutes: svcEffective.avgMinutes,
          activeCounters: totalActiveCounters || 1,
          historicalVarianceFactor: svcEffective.varianceFactor,
          isPaused,
          historicalSampleSize: svcEffective.sampleSize,
        })
        return { serviceId: service.id, serviceName: service.name, serviceNameAr: service.nameAr, serviceNameFr: service.nameFr, prefix: service.prefix, waiting, estimatedWait: svcEta.estimatedMaxMinutes }
      })
    )

    const recentCalls = await db.reservation.findMany({
      where: { agencyId, status: { in: ['CALLED', 'SERVING', 'COMPLETED'] }, calledAt: { not: null } },
      select: { id: true, displayNumber: true, status: true, calledAt: true, service: { select: { prefix: true, name: true } }, counter: { select: { name: true } } },
      orderBy: { calledAt: 'desc' },
      take: 5,
    })

    // ── Active CLAIMED counters with their current ticket (0.6.74 TV screens).
    // A counter appears only when it is active, belongs to a live branch, was
    // touched within the last 45 minutes, AND is actually claimed (controlled
    // by a user or mirrored-occupied). Only such counters are rendered by the
    // new simple TV designs.
    const claimedCounters = await db.counter.findMany({
      where: {
        isActive: true,
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
        OR: [{ controlledByUserId: { not: null } }, { staffId: { not: null } }],
      },
      select: {
        id: true, number: true, name: true, nameAr: true, nameFr: true, controlClaimedAt: true,
        currentReservation: {
          select: {
            id: true, displayNumber: true, status: true, calledAt: true,
            service: { select: { name: true, nameAr: true, nameFr: true, prefix: true } },
          },
        },
      },
      orderBy: { number: 'asc' },
    })

    const totalWaiting = serviceStats.reduce((sum, s) => sum + s.waiting, 0)
    const overallEta = calculateETA({
      peopleAhead: totalWaiting,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: totalActiveCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused,
      historicalSampleSize: effective.sampleSize,
    })
    const totalEstimatedWait = overallEta.estimatedMaxMinutes

    // TV footer "Served Today" — COMPLETED reservations within the local day.
    // (Historically missing from this response → the TV footer showed 0 forever.)
    const totalServedToday = await db.reservation.count({
      where: { agencyId, status: 'COMPLETED', completedAt: { gte: startOfToday } },
    })

    // Average SERVING time today (completedAt − calledAt) for the new TV
    // designs. Outliers (>4h — forgotten open ticket) are excluded; null when
    // no completed ticket exists yet today (UI falls back to “—”).
    const todayServedTimes = await db.reservation.findMany({
      where: { agencyId, status: 'COMPLETED', calledAt: { not: null }, completedAt: { gte: startOfToday } },
      select: { calledAt: true, completedAt: true },
      take: 500,
      orderBy: { completedAt: 'desc' },
    })
    const todayDurations = todayServedTimes
      .filter((r) => r.completedAt && r.calledAt)
      .map((r) => (r.completedAt as Date).getTime() - (r.calledAt as Date).getTime())
      .filter((ms) => ms > 0 && ms < 4 * 3_600_000)
    const avgServiceTimeSec = todayDurations.length
      ? Math.round(todayDurations.reduce((a, b) => a + b, 0) / todayDurations.length / 1000)
      : null

    // Active announcements for the TV ticker (agency-scoped first, then
    // platform-wide). Expired agency announcements are excluded.
    const nowForAnnouncements = new Date()
    const [agencyAnnouncements, globalAnnouncements] = await Promise.all([
      db.announcement.findMany({
        where: {
          agencyId,
          isActive: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: nowForAnnouncements } }],
        },
        select: { id: true, message: true, type: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      db.globalAnnouncement.findMany({
        select: { id: true, message: true, type: true, createdAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      }),
    ])
    const announcements = [...agencyAnnouncements, ...globalAnnouncements]

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      // 0.6.76 — `category` rides along so TV boards activate the agency's
      // SPECIALIZED terminology scope (Patient/Client/Customer...).
      agency: { id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr, logoUrl: agency.logoUrl, isQueueOpen: agency.isQueueOpen, isPaused, category: agency.category },
      currentlyServing: servingReservations.map((r) => ({ id: r.id, ticketNumber: r.displayNumber, serviceId: r.serviceId, serviceName: r.service.name, status: r.status, calledAt: r.calledAt, counterName: r.counter?.name ?? null })),
      serviceStats,
      totalWaiting,
      totalServedToday,
      avgServiceTimeSec,
      counters: claimedCounters.map((ctr) => ({
        id: ctr.id,
        number: ctr.number,
        name: ctr.name,
        nameAr: ctr.nameAr,
        nameFr: ctr.nameFr,
        claimedAt: ctr.controlClaimedAt,
        ticket: ctr.currentReservation && (ctr.currentReservation.status === 'CALLED' || ctr.currentReservation.status === 'SERVING')
          ? {
              id: ctr.currentReservation.id,
              ticketNumber: ctr.currentReservation.displayNumber,
              status: ctr.currentReservation.status,
              calledAt: ctr.currentReservation.calledAt,
              serviceName: ctr.currentReservation.service.name,
              serviceNameAr: ctr.currentReservation.service.nameAr,
              serviceNameFr: ctr.currentReservation.service.nameFr,
              servicePrefix: ctr.currentReservation.service.prefix,
            }
          : null,
      })),
      totalEstimatedWait,
      activeCounters: totalActiveCounters,
      recentCalls: recentCalls.map((r) => ({ id: r.id, ticketNumber: r.displayNumber, status: r.status, calledAt: r.calledAt, counterName: r.counter?.name ?? null })),
      announcements,
      deviceId: deviceId ?? null,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    if (clientIp) recordFailedRequest(clientIp)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── GET /public/agency — Get agency info by short code ─────────────────────
// (dual auth: deviceToken OR IP rate-limit)

app.get('/public/agency', async (c) => {
  let clientIp: string | undefined
  try {
    const device = await requireDeviceAuth(c)
    let deviceId: string | undefined = undefined

    if (device) {
      deviceId = device.id
    } else {
      clientIp = enforceRateLimit(c, KIOSK_READ_RATE_LIMIT)
    }

    const code = c.req.query('code')
    if (!code) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency code is required' }, 400)
    }

    const agency = await db.agency.findUnique({
      where: { customCode: code, isActive: true },
      include: {
        services: { where: { isActive: true }, select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true, durationMinutes: true } },
        queueSettings: { select: { id: true, currentServingNumber: true, lastIssuedNumber: true, isPaused: true }, take: 1, orderBy: { updatedAt: 'desc' } },
      },
    })

    if (!agency) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    const waiting = await db.reservation.count({ where: { agencyId: agency.id, status: 'WAITING' } })

    const currentServing = await db.reservation.findFirst({
      where: { agencyId: agency.id, status: { in: ['CALLED', 'SERVING'] } },
      select: { displayNumber: true, service: { select: { prefix: true } } },
      orderBy: { calledAt: 'desc' },
    })

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: { agencyId: agency.id, status: 'COMPLETED', calledAt: { not: null }, completedAt: { gte: sevenDaysAgo } },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const effective = getEffectiveServiceTime(recentCompleted, agency.averageServiceTime)
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const activeCounters = await db.counter.count({
      where: { isActive: true, staffId: { not: null }, branch: { agencyId: agency.id, isActive: true }, updatedAt: { gte: fortyFiveMinsAgo } },
    })
    const isPausedAgency = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false
    const eta = calculateETA({
      peopleAhead: waiting,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: activeCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused: isPausedAgency,
      historicalSampleSize: effective.sampleSize,
    })
    const estimatedWait = eta.estimatedMaxMinutes
    // P2-10 — per-service avgTime honors the owner-set duration first.
    const services = agency.services.map((s) => ({ ...s, avgTime: s.durationMinutes ?? agency.averageServiceTime }))

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      agency: {
        id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr, category: agency.category, logoUrl: agency.logoUrl,
        workingHoursStart: agency.workingHoursStart, workingHoursEnd: agency.workingHoursEnd, isQueueOpen: agency.isQueueOpen,
        isPaused: agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false,
      },
      services,
      queueStats: { waiting, currentServing: currentServing?.displayNumber || null, estimatedWait },
      deviceId: deviceId ?? null,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    if (clientIp) recordFailedRequest(clientIp)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  KIOSK CREDENTIAL AUTH — used by kiosk login on the login page
// ═══════════════════════════════════════════════════════════════════════════

const kioskAuthSchema = z.object({
  pairingCode: z.string().min(1, 'Pairing code is required'),
  deviceToken: z.string().min(1, 'Device token is required'),
})

// ─── POST /public/kiosk-auth — Authenticate kiosk with credentials ─────────
// Validates pairingCode + deviceToken and returns full device + agency context

app.post('/public/kiosk-auth', async (c) => {
  try {
    let clientIp: string | undefined
    const device = await requireDeviceAuth(c)
    if (!device) {
      clientIp = enforceRateLimit(c, KIOSK_RATE_LIMIT)
    }

    const body = await c.req.json()
    const validation = validateBody(kioskAuthSchema, body)
    if (validation.error) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { pairingCode, deviceToken } = validation.data

    // Brute-force guard: a code with too many recent failures is temporarily
    // rejected even for the CORRECT token (the kiosk retries — legitimate
    // clients recover automatically when the lockout expires).
    const normalizedPairingCode = pairingCode.toUpperCase()
    if (isPairingCodeLocked(normalizedPairingCode)) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Too many failed attempts for this pairing code. Try again later.' }, 429)
    }

    // Look up device by pairing code (case-insensitive)
    const foundDevice = await db.agencyDevice.findUnique({
      where: { pairingCode: normalizedPairingCode },
      include: {
        branch: { select: { id: true, name: true, nameAr: true, nameFr: true } },
        agency: {
          select: {
            id: true, name: true, nameAr: true, nameFr: true,
            customCode: true, category: true, logoUrl: true,
            isQueueOpen: true, isActive: true,
            workingHoursStart: true, workingHoursEnd: true,
            queueSettings: { select: { isPaused: true, currentServingNumber: true }, take: 1, orderBy: { updatedAt: 'desc' } },
            services: { where: { isActive: true }, select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
          },
        },
      },
    })

    if (!foundDevice) {
      if (clientIp) recordFailedRequest(clientIp)
      recordPairingFailure(normalizedPairingCode)
      // 0.6.88 — device event stream: kiosk credentials rejected.
      appendDeviceEvent({
        event: 'kiosk_auth_failed',
        message: 'kiosk-auth rejected — pairing code not found',
        level: 'warn',
        data: { reason: 'not_found' },
      })
      return c.json({ success: false, error: 'Device not found. Check pairing code.' }, 404)
    }

    // Validate deviceToken matches
    if (foundDevice.deviceToken !== deviceToken) {
      if (clientIp) recordFailedRequest(clientIp)
      recordPairingFailure(normalizedPairingCode)
      // 0.6.88 — device event stream: kiosk credentials rejected.
      appendDeviceEvent({
        event: 'kiosk_auth_failed',
        message: 'kiosk-auth rejected — device token mismatch',
        level: 'warn',
        deviceId: foundDevice.id,
        deviceName: foundDevice.name,
        deviceType: foundDevice.type,
        agencyId: foundDevice.agencyId,
        data: { reason: 'token_mismatch' },
      })
      return c.json({ success: false, error: 'Invalid device token. Contact your agency admin.' }, 401)
    }

    clearPairingFailures(normalizedPairingCode)

    // Check agency is active
    if (!foundDevice.agency.isActive) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency is not active' }, 403)
    }

    // Mark device as ONLINE
    await db.agencyDevice.update({
      where: { id: foundDevice.id },
      data: {
        status: 'ONLINE',
        statusChangedAt: new Date(),
        lastHeartbeatAt: new Date(),
        connectedAt: foundDevice.connectedAt ?? new Date(),
      },
    })

    // Emit device online event
    emitAgencyDeviceEvent('agency-device:connected', foundDevice.agencyId, {
      deviceId: foundDevice.id,
      deviceName: foundDevice.name,
      deviceType: foundDevice.type,
    })

    // 0.6.88 — device event stream: kiosk login succeeded → ONLINE.
    appendDeviceEvent({
      event: 'kiosk_auth_success',
      message: `Kiosk authenticated with pairing code (${foundDevice.name})`,
      deviceId: foundDevice.id,
      deviceName: foundDevice.name,
      deviceType: foundDevice.type,
      agencyId: foundDevice.agencyId,
      status: 'ONLINE',
    })
    appendDeviceEvent({
      event: 'device_online',
      message: 'Device marked ONLINE via kiosk-auth',
      deviceId: foundDevice.id,
      deviceName: foundDevice.name,
      deviceType: foundDevice.type,
      agencyId: foundDevice.agencyId,
      status: 'ONLINE',
    })

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      device: {
        id: foundDevice.id,
        name: foundDevice.name,
        type: foundDevice.type,
        status: 'ONLINE',
        branch: foundDevice.branch,
        screenLayout: foundDevice.screenLayout,
        serviceFilter: foundDevice.serviceFilter,
        displaySettings: parseJSON(foundDevice.displaySettings),
      },
      deviceToken: foundDevice.deviceToken,
      agency: {
        id: foundDevice.agency.id,
        name: foundDevice.agency.name,
        nameAr: foundDevice.agency.nameAr,
        nameFr: foundDevice.agency.nameFr,
        customCode: foundDevice.agency.customCode,
        category: foundDevice.agency.category,
        logoUrl: foundDevice.agency.logoUrl,
        isQueueOpen: foundDevice.agency.isQueueOpen,
        isPaused: foundDevice.agency.queueSettings.length > 0 ? foundDevice.agency.queueSettings[0].isPaused : false,
        workingHoursStart: foundDevice.agency.workingHoursStart,
        workingHoursEnd: foundDevice.agency.workingHoursEnd,
        services: foundDevice.agency.services,
      },
    })
  } catch (error: unknown) {
    console.error('[DEVICE/PUBLIC/KIOSK-AUTH]', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── POST /public/discover-register — Register device for discovery (NO agency) ──
// Kiosk calls this when clicking "Wait for Discovery" — no agency code needed.
// The device is created as an orphan (agencyId: null) in PAIRING status.

app.post('/public/discover-register', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, KIOSK_RATE_LIMIT)
    const body = await c.req.json()
    const validation = validateBody(discoverRegisterSchema, body)
    if (validation.error) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { deviceName, deviceType, connectionType, deviceFingerprint } = validation.data
    const effectiveName = deviceName || 'BLASTI Kiosk (Discovering)'

    // ── 0.6.115 — ONE ROW PER DEVICE, TYPE = THE APP CURRENTLY RUNNING ──
    // Field report (2026-11-23): "device manager could not discover kiosk
    // device and discovered only the phone … before it shows the phone that
    // run kiosk mode and kiosk mode as separated devices".
    // Two defects caused it:
    //   (a) the fingerprint match was filtered to status 'PAIRING' — the same
    //       physical phone whose row had gone OFFLINE re-registered as a SECOND
    //       row (the "device AND app" duplicates the user saw);
    //   (b) a successful reuse NEVER updated the row's type — the phone's
    //       staff surface registered the shared fingerprint as PHONE first,
    //       then the kiosk surface silently reused that row, so the manager
    //       saw a PHONE forever and "the kiosk was never discovered".
    // Fix: match by fingerprint REGARDLESS of status (newest first, unpaired
    // rows preferred over paired ones — never a duplicate), and ALWAYS update
    // type/name/connection to the surface that is announcing right now.
    let existingDevice: any = null
    if (deviceFingerprint) {
      try {
        const candidates = await db.agencyDevice.findMany({
          where: { deviceFingerprint },
          orderBy: { createdAt: 'desc' },
          take: 5,
        })
        // Prefer the device's own unpaired row (it keeps its token + PAIRING
        // visibility); a paired row is still THE SAME physical device — reuse
        // it (never mint a second row) and let device-status reflect the pair.
        existingDevice = candidates.find((d: any) => !d.agencyId) || candidates[0] || null
      } catch (e) {
        console.error('[DISCOVER-REGISTER] findFirst error:', e)
      }
    }

    if (existingDevice) {
      // Refresh the row to the surface that is announcing NOW.
      const now = new Date()
      const wasUnpaired = !existingDevice.agencyId
      await db.agencyDevice.update({
        where: { id: existingDevice.id },
        data: {
          type: deviceType,
          name: effectiveName,
          connectionType: connectionType || 'LAN',
          ...(deviceType === 'KIOSK' ? { screenLayout: 'SERVICE_SELECTOR', offlineCapable: true } : {}),
          // An unpaired row must stay visible in /unpaired — restore PAIRING
          // when an older run left it OFFLINE.
          ...(wasUnpaired && existingDevice.status !== 'PAIRING'
            ? { status: 'PAIRING', statusChangedAt: now }
            : {}),
          lastHeartbeatAt: now,
        },
      })
      const token = existingDevice.deviceToken || crypto.randomBytes(32).toString('hex')
      if (!existingDevice.deviceToken) {
        await db.agencyDevice.update({ where: { id: existingDevice.id }, data: { deviceToken: token } })
      }
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({
        success: true,
        device: { id: existingDevice.id, name: effectiveName, type: deviceType, status: wasUnpaired ? 'PAIRING' : existingDevice.status },
        deviceToken: token,
      })
    }

    // Create new orphan device
    const deviceToken = crypto.randomBytes(32).toString('hex')
    // ── 0.6.119 — GHOST GATE (discover-register) ──
    // A fingerprint the manager deliberately deleted never re-registers:
    // the kiosk's 10s waiting-mode retry would otherwise mint a fresh row
    // seconds after every delete. 409 + removed:true lets the kiosk clear
    // its stored identity and stop the retry loop.
    if (deviceFingerprint && (await isDeviceTombstoned(deviceFingerprint))) {
      return c.json({ success: false, error: 'DEVICE_REMOVED_BY_MANAGER', removed: true }, 409)
    }
    let newDevice: any = null
    try {
      newDevice = await db.agencyDevice.create({
        data: {
          name: effectiveName,
          type: deviceType,
          status: 'PAIRING',
          connectionType: connectionType || 'LAN',
          deviceToken,
          deviceFingerprint: deviceFingerprint ?? null,
          screenLayout: deviceType === 'KIOSK' ? 'SERVICE_SELECTOR' : 'QUEUE_BOARD',
          offlineCapable: deviceType === 'KIOSK',
          autoDiscovery: true,
          lastHeartbeatAt: new Date(),
        },
      })
    } catch (createErr) {
      console.error('[DISCOVER-REGISTER] create error:', createErr)
      if (clientIp) recordFailedRequest(clientIp)
      const isDev = process.env.NODE_ENV !== 'production'
      const detail = createErr instanceof Error ? createErr.message : String(createErr)
      return c.json({
        success: false,
        error: 'Failed to register device',
        ...(isDev ? { detail } : {}),
      }, 500)
    }

    if (newDevice) {
      // 0.6.101 — the historic emit passed the literal 'discovery' agencyId →
      // room agency:discovery, which NO client ever joins — dead air. The
      // unpaired strip discovers new orphans via its 10s poll; pairing
      // requests now use the pairing-wait rooms instead.
      // 0.6.88 — device event stream: kiosk self-registered for discovery.
      appendDeviceEvent({
        event: 'kiosk_registered',
        message: `Kiosk registered for discovery (${newDevice.name})`,
        deviceId: newDevice.id,
        deviceName: newDevice.name,
        deviceType: newDevice.type,
        status: 'PAIRING',
        data: { connectionType: connectionType || 'LAN', fingerprinted: Boolean(deviceFingerprint) },
      })
    }

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      device: { id: newDevice.id, name: newDevice.name, type: newDevice.type, status: newDevice.status },
      deviceToken,
    }, 201)
  } catch (error: unknown) {
    console.error('[DEVICE/PUBLIC/DISCOVER-REGISTER]', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── GET /public/device-status — Poll device status + pending pairing requests ──
// Used by kiosk discovery flow to check if an agency manager has sent a pairing request.

app.get('/public/device-status', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    // Get pending PAIRING_REQUEST commands
    const pendingPairingRequests = await db.deviceCommand.findMany({
      where: { deviceId: device.id, type: 'PAIRING_REQUEST', status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })

    const pairingRequests = pendingPairingRequests.map(cmd => {
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(cmd.payload) } catch {}
      return {
        id: cmd.id,
        agencyId: payload.agencyId,
        agencyName: payload.agencyName,
        agencyNameAr: payload.agencyNameAr,
        agencyNameFr: payload.agencyNameFr,
        branchId: payload.branchId,
        branchName: payload.branchName,
        sentByName: payload.sentByName,
        // 0.6.100 — the manager-issued token the device adopts on accept
        // (single canonical token across the manager store and this one).
        deviceToken: payload.deviceToken,
        sentAt: cmd.createdAt,
      }
    })

    // If device is paired (has agency), fetch full agency + services data
    let agencyData: Record<string, unknown> | null = null
    if (device.agencyId) {
      const agency = await db.agency.findUnique({
        where: { id: device.agencyId, isActive: true },
        select: { id: true, name: true, nameAr: true, nameFr: true, customCode: true, isQueueOpen: true, logoUrl: true, category: true, workingHoursStart: true, workingHoursEnd: true },
      })
      if (agency) {
        const services = await db.service.findMany({
          where: { agencyId: device.agencyId, isActive: true },
          select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true },
        })
        const queueSettings = await db.queueSettings.findFirst({
          where: { agencyId: device.agencyId },
          select: { isPaused: true, currentServingNumber: true, lastIssuedNumber: true },
          orderBy: { updatedAt: 'desc' },
        })
        agencyData = {
          ...agency,
          isPaused: queueSettings?.isPaused ?? false,
          services,
          queueStats: queueSettings ? { currentServingNumber: queueSettings.currentServingNumber, lastIssuedNumber: queueSettings.lastIssuedNumber } : null,
        }
      }
    }

    return c.json({
      success: true,
      status: device.status,
      agency: agencyData,
      pairingRequests,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/PUBLIC/DEVICE-STATUS]', error)
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  DEVICE-FACING ENDPOINTS  (authenticated via deviceToken, NOT JWT)
//  Mounted at /device/* to avoid conflicts with /:id param routes
// ═══════════════════════════════════════════════════════════════════════════

// ─── POST /device/heartbeat ────────────────────────────────────────────────

app.post('/device/heartbeat', async (c) => {
  console.log('[HEARTBEAT] START');
  try {
    const device = await requireDeviceAuth(c)
    console.log('[HEARTBEAT] device:', device ? device.id : 'null');
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    // M3: Rate limit heartbeats to max 1 per 10s per device.
    // 0.6.95 — a too-frequent beat is IDEMPOTENT (the device is clearly
    // alive and was already marked online by the previous beat), so answer
    // 200-noop with Retry-After instead of an error-shaped 429. The field
    // logs flagged the 429s as a CRITICAL tracked bug ("rate limited by the
    // server (HTTP 429) — POST /api/agency-devices/device/heartbeat") even
    // though they were harmless restart races. Still return the device's
    // pending commands so a restarting client never loses a command poll.
    const hbNow = Date.now()
    const lastHeartbeat = heartbeatRateLimits.get(device.id) || 0
    const heartbeatGap = hbNow - lastHeartbeat
    if (heartbeatGap < HEARTBEAT_MIN_INTERVAL) {
      const retryAfterSec = Math.max(1, Math.ceil((HEARTBEAT_MIN_INTERVAL - heartbeatGap) / 1000))
      try { c.header('Retry-After', String(retryAfterSec)) } catch { /* header best-effort */ }
      const pendingCommands = await db.deviceCommand.findMany({
        where: { deviceId: device.id, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      })
      const cmdNow = Date.now()
      const activeCommands = pendingCommands.filter((cmd: { createdAt: Date | string; ttl?: number | null }) => {
        const cmdAge = cmdNow - new Date(cmd.createdAt).getTime()
        const ttl = (cmd.ttl || 300) * 1000
        return cmdAge < ttl
      })
      return c.json({
        success: true,
        deduped: true,
        retryAfter: retryAfterSec,
        pendingCommands: activeCommands,
        device: { id: device.id, status: device.status },
      })
    }
    heartbeatRateLimits.set(device.id, hbNow)

    const body = await c.req.json().catch(() => ({}))
    const validation = heartbeatSchema.safeParse(body)

    // ── Calculate uptime delta (L4: only count if already ONLINE) ──
    let uptimeDelta = 0
    if (device.status === 'ONLINE' && device.lastHeartbeatAt) {
      uptimeDelta = Math.round((Date.now() - device.lastHeartbeatAt.getTime()) / 1000)
      // Cap at 5 minutes to avoid absurd deltas from long offline gaps
      if (uptimeDelta > 300) uptimeDelta = 300
    }

    // ── Build update data ──
    const updateData: Record<string, unknown> = {
      lastHeartbeatAt: new Date(),
      totalUptimeSec: { increment: uptimeDelta },
    }

    // M11: Only set statusChangedAt when status actually changes
    // Keep PAIRING status for unpaired devices (no agencyId) so they remain
    // visible in the /unpaired endpoint for the agency manager to discover.
    // IMPORTANT: Unpaired devices (agencyId === null) should never become ONLINE.
    if (device.agencyId && (device.status === 'OFFLINE' || (device.status === 'PAIRING' && device.agencyId !== null))) {
      // H7: Only set ONLINE if not DISABLED
      updateData.status = 'ONLINE'
      updateData.statusChangedAt = new Date()
    }

    if (validation.success) {
      const data = validation.data
      if (data.deviceFingerprint) updateData.deviceFingerprint = data.deviceFingerprint
      if (data.appVersion) updateData.appVersion = data.appVersion
      if (data.ipAddress) updateData.ipAddress = data.ipAddress
    }

    const updated = await db.agencyDevice.update({
      where: { id: device.id },
      data: updateData,
      select: { id: true, status: true, lastHeartbeatAt: true, totalUptimeSec: true, appVersion: true, ipAddress: true },
    })

    // ── 0.6.123 — PRINTER LIVENESS RIDES THE HOST HEARTBEAT ──
    // A PRINTER row can never heartbeat for itself (passive hardware). Every
    // PRINTER registered via cascade discovery carries its HOST PC's address
    // in the ipAddress column, so whenever a device AT THAT ADDRESS beats,
    // its printers are alive too: touch their lastHeartbeatAt and bring any
    // OFFLINE row back ONLINE. The watchdog's printer pass then flips them
    // OFFLINE only when this host goes quiet — "connected" finally mirrors
    // reality instead of turning red 90s after registration.
    if (updated.ipAddress && device.agencyId) {
      try {
        const printers = await db.agencyDevice.findMany({
          where: { agencyId: device.agencyId, type: 'PRINTER', ipAddress: updated.ipAddress, status: { not: 'DISABLED' } },
          select: { id: true, status: true },
          take: 20,
        })
        const touchNow = new Date()
        for (const pr of printers) {
          const bringOnline = pr.status !== 'ONLINE'
          await db.agencyDevice.update({
            where: { id: pr.id },
            data: bringOnline
              ? { lastHeartbeatAt: touchNow, status: 'ONLINE', statusChangedAt: touchNow }
              : { lastHeartbeatAt: touchNow },
          }).catch(() => null)
          if (bringOnline) {
            emitAgencyDeviceEvent('agency-device:updated', device.agencyId, { deviceId: pr.id, deviceType: 'PRINTER', via: 'host-heartbeat' })
          }
        }
      } catch { /* printer touch is best-effort */ }
    }

    // ── Expire old DELIVERED commands ──
    await expireOldDeliveredCommands(device.id)

    // ── Fetch pending commands (H4: filter by TTL) ──
    const pendingCommands = await db.deviceCommand.findMany({
      where: { deviceId: device.id, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    })

    const cmdNow = Date.now()
    const activeCommands = pendingCommands.filter(cmd => {
      const cmdAge = cmdNow - new Date(cmd.createdAt).getTime()
      const ttl = (cmd.ttl || 300) * 1000
      return cmdAge < ttl
    })
    // Mark expired ones as EXPIRED
    const expiredIds = pendingCommands.filter(cmd => {
      const cmdAge = cmdNow - new Date(cmd.createdAt).getTime()
      return cmdAge >= (cmd.ttl || 300) * 1000
    }).map(cmd => cmd.id)
    if (expiredIds.length > 0) {
      await db.deviceCommand.updateMany({ where: { id: { in: expiredIds } }, data: { status: 'EXPIRED' } })
    }

    // ── Run heartbeat watchdog (L1: throttle to at most once per 30s) ──
    if (Date.now() - lastWatchdogRun > 30_000) {
      lastWatchdogRun = Date.now()
      runHeartbeatWatchdog().catch(() => {})
    }

    // ── Return response (never include deviceToken) ──
    return c.json({
      success: true,
      device: updated,
      pendingCommands: activeCommands,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/HEARTBEAT]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ─── POST /device/pair ─────────────────────────────────────────────────────

app.post('/device/pair', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    // M4: Rate limit pair attempts (max 5 per minute per device)
    const pairNow = Date.now()
    let pairEntry = pairAttemptLimits.get(device.id)
    if (!pairEntry || pairNow > pairEntry.resetAt) {
      pairEntry = { count: 0, resetAt: pairNow + PAIR_WINDOW_MS }
      pairAttemptLimits.set(device.id, pairEntry)
    }
    pairEntry.count++
    if (pairEntry.count > PAIR_MAX_ATTEMPTS) {
      return c.json({ success: false, error: 'Too many pairing attempts. Try again later.' }, 429)
    }

    const body = await c.req.json()
    const validation = pairDeviceSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const { pairingCode } = validation.data

    // Find the agency device record that has this pairing code
    const targetDevice = await db.agencyDevice.findUnique({
      where: { pairingCode },
      include: {
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true, logoUrl: true, category: true } },
        branch: { select: { id: true, name: true, nameAr: true, nameFr: true, address: true, phone: true } },
      },
    })

    if (!targetDevice) {
      return c.json({ success: false, error: 'Invalid pairing code' }, 404)
    }

    // C2: Cross-Agency Device Pairing — verify device belongs to same agency.
    // 0.6.96 — ORPHAN ADOPTION FIX: an unpaired device (agencyId null) has no
    // agency yet, so the old strict equality (`targetDevice.agencyId !==
    // device.agencyId`) ALWAYS 403'd it with "Pairing code not valid for your
    // agency" — the kiosk-visible error that looked like a missing-permission
    // problem. An orphan may now adopt the target's agency via pairing code.
    if (targetDevice.agencyId && device.agencyId && targetDevice.agencyId !== device.agencyId) {
      return c.json({ success: false, error: 'Pairing code not valid for your agency' }, 403)
    }

    // Validate device type matches (if target has a type restriction set)
    // Allow any type pairing by default — no type restriction unless explicitly added
    // (the spec says "or no type restriction" so we just allow all for now)

    // Link the calling device: transfer the pairing target's agency/branch to the
    // authenticated device, then clear the pairing code from the target.
    const now = new Date()
    const [updatedDevice] = await db.$transaction([
      db.agencyDevice.update({
        where: { id: device.id },
        data: {
          agencyId: targetDevice.agencyId,
          branchId: targetDevice.branchId,
          status: 'ONLINE',
          connectedAt: now,
          statusChangedAt: now,
          lastHeartbeatAt: now,
          pairingCode: null,
          screenLayout: targetDevice.screenLayout,
          displaySettings: targetDevice.displaySettings,
          printerConfig: targetDevice.printerConfig,
          serviceFilter: targetDevice.serviceFilter,
        },
        select: DEVICE_SELECT,
      }),
      // Remove the pairing code from the original device so it can't be reused
      db.agencyDevice.update({
        where: { id: targetDevice.id },
        data: { pairingCode: null },
      }),
    ])

    return c.json({
      success: true,
      device: updatedDevice,
      agency: targetDevice.agency,
      branch: targetDevice.branch,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/PAIR]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ─── POST /device/command/:commandId/ack ───────────────────────────────────

app.post('/device/command/:commandId/ack', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    const commandId = c.req.param('commandId')

    // Verify the command belongs to this device
    const command = await db.deviceCommand.findFirst({
      where: { id: commandId, deviceId: device.id },
    })
    if (!command) {
      return c.json({ success: false, error: 'Command not found' }, 404)
    }

    const body = await c.req.json()
    const validation = ackCommandSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const { status, error } = validation.data

    // M14: Command ACK state machine validation
    const VALID_TRANSITIONS: Record<string, string[]> = {
      PENDING: ['DELIVERED', 'FAILED'],
      DELIVERED: ['COMPLETED', 'FAILED'],
    }
    if (command.status !== 'EXPIRED' && !VALID_TRANSITIONS[command.status]?.includes(status)) {
      return c.json({ success: false, error: `Invalid transition: ${command.status} → ${status}` }, 409)
    }

    const updateData: Record<string, unknown> = { status }
    if (status === 'DELIVERED') updateData.deliveredAt = new Date()
    if (status === 'COMPLETED') updateData.completedAt = new Date()
    if (status === 'FAILED' && error) updateData.error = error

    const updated = await db.deviceCommand.update({
      where: { id: commandId },
      data: updateData,
    })

    return c.json({ success: true, command: updated })
  } catch (error: unknown) {
    console.error('[DEVICE/ACK]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ─── GET /device/config ────────────────────────────────────────────────────

app.get('/device/config', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    // Re-fetch with full relations (avoid relying on cached select)
    const fullDevice = await db.agencyDevice.findUnique({
      where: { id: device.id },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        screenLayout: true,
        displaySettings: true,
        printerConfig: true,
        serviceFilter: true,
        agency: {
          select: {
            id: true,
            name: true,
            nameAr: true,
            nameFr: true,
            logoUrl: true,
            category: true,
          },
        },
        branch: {
          select: {
            id: true,
            name: true,
            nameAr: true,
            nameFr: true,
            address: true,
            phone: true,
          },
        },
      },
    })

    if (!fullDevice) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    // Parse JSON strings before returning
    const displaySettings = parseJSON(fullDevice.displaySettings)

    const printerConfig = parseJSON(fullDevice.printerConfig)

    return c.json({
      success: true,
      config: {
        displaySettings,
        printerConfig,
        screenLayout: fullDevice.screenLayout,
        serviceFilter: fullDevice.serviceFilter,
        agency: fullDevice.agency,
        branch: fullDevice.branch,
      },
    })
  } catch (error: unknown) {
    console.error('[DEVICE/CONFIG]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ─── POST /device/accept-pairing — Kiosk approves a pairing request ──────────

app.post('/device/accept-pairing', async (c) => {
  try {
    // 0.6.126 — BOOTSTRAP-TOLERANT AUTH (mirrors the desktop local API fix):
    // 112× field 401s showed a first-time device CAN fail token-only auth on
    // the one request whose purpose is to establish the token. A caller that
    // presents the PAIRING_REQUEST command's own minted deviceToken (a
    // secret delivered exclusively inside the pairing offer) IS the intended
    // device — resolve it through the command when token lookup misses.
    let device = await requireDeviceAuth(c)
    const body = await c.req.json().catch(() => ({})) as { commandId?: string; agencyId?: string; branchId?: string }
    if (!device && body.commandId) {
      const cmd = await db.deviceCommand.findUnique({ where: { id: body.commandId } }).catch(() => null)
      let minted = ''
      if (cmd && cmd.type === 'PAIRING_REQUEST' && cmd.status === 'PENDING') {
        try {
          const payload = JSON.parse(cmd.payload || '{}') as { deviceToken?: string }
          if (typeof payload.deviceToken === 'string') minted = payload.deviceToken
        } catch { /* payload parse — stay unauthenticated */ }
      }
      const authHeader = c.req.header('Authorization') || ''
      const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
      if (cmd && minted && presented && presented === minted) {
        device = await db.agencyDevice.findUnique({
          where: { id: cmd.deviceId },
          include: DEVICE_INCLUDE,
        })
      }
    }
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    const { commandId, agencyId, branchId } = body as { commandId?: string; agencyId?: string; branchId?: string }

    if (!agencyId) {
      return c.json({ success: false, error: 'agencyId is required' }, 400)
    }

    // Verify the agency exists
    const agency = await db.agency.findUnique({
      where: { id: agencyId, isActive: true },
      select: { id: true, name: true, nameAr: true, nameFr: true, customCode: true, isQueueOpen: true, logoUrl: true, category: true, workingHoursStart: true, workingHoursEnd: true },
    })
    if (!agency) {
      return c.json({ success: false, error: 'Agency not found or inactive' }, 404)
    }

    // Update device to belong to this agency
    const now = new Date()
    const updatedDevice = await db.agencyDevice.update({
      where: { id: device.id },
      data: {
        agencyId,
        branchId: branchId || null,
        status: 'ONLINE',
        statusChangedAt: now,
        connectedAt: now,
        lastHeartbeatAt: now,
      },
      select: DEVICE_SELECT,
    })

    // Mark the pairing request command as COMPLETED
    if (commandId) {
      await db.deviceCommand.updateMany({
        where: { id: commandId, deviceId: device.id, type: 'PAIRING_REQUEST' },
        data: { status: 'COMPLETED', completedAt: now },
      })
    }

    // Mark ALL other pending pairing requests as FAILED (only one can be accepted)
    await db.deviceCommand.updateMany({
      where: { deviceId: device.id, type: 'PAIRING_REQUEST', status: 'PENDING', id: { not: commandId || '___none___' } },
      data: { status: 'FAILED', error: 'Rejected — another pairing was accepted' },
    })

    // ── 0.6.113 — HARDENED PROTOCOL: READ-BACK REGISTRATION VERIFICATION ──────
    // The response is NOT access. Before this endpoint reports success the
    // written row is RE-READ from the store and must PROVE the registration
    // persisted: agency bound (exactly the requested one) + ONLINE status +
    // the authenticating token still on the row. Any miss → registered:false
    // and the kiosk withholds the token and stays on the waiting screen.
    let registeredRow: { id: string; name: string; status: string; agencyId: string | null; branchId: string | null; deviceToken: string | null; connectedAt: Date | null } | null = null
    try {
      registeredRow = await db.agencyDevice.findUnique({
        where: { id: device.id },
        select: { id: true, name: true, status: true, agencyId: true, branchId: true, deviceToken: true, connectedAt: true },
      })
    } catch { /* read failure = unverified */ }
    const registrationVerified = !!(
      registeredRow &&
      registeredRow.agencyId === agencyId &&
      registeredRow.status === 'ONLINE' &&
      (!registeredRow.deviceToken || !device.deviceToken || registeredRow.deviceToken === device.deviceToken)
    )
    if (!registrationVerified) {
      console.error('[DEVICE/ACCEPT-PAIRING] registration NOT persisted for device', device.id, '— access token withheld')
      return c.json({
        success: false as const,
        registered: false as const,
        error: 'Registration could not be persisted — access token not granted',
      }, 500)
    }

    // 0.6.119 — the pair is live: lift any deleted-device blocklist so a
    // previously ghosted fingerprint can exist again.
    try { if (device.deviceFingerprint) await clearDeviceTombstone(device.deviceFingerprint) } catch { /* non-fatal */ }

    // Fetch services for the kiosk
    const services = await db.service.findMany({
      where: { agencyId, isActive: true },
      select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true },
    })

    // Get queue settings
    const queueSettings = await db.queueSettings.findFirst({
      where: { agencyId },
      select: { isPaused: true, currentServingNumber: true, lastIssuedNumber: true },
      orderBy: { updatedAt: 'desc' },
    })

    // 0.6.103 — the emit now carries the STABLE FINGERPRINT and the CANONICAL
    // DEVICE TOKEN. A kiosk that polls the CLOUD and accepts HERE updates the
    // cloud row only — the branch desktop's LOCAL mirror kept its PAIRING
    // orphan forever ("the paired device never appears in the registered
    // devices list"). With the fingerprint + token in the event, the desktop's
    // cloud-realtime relay reconciles the local row (same device, single
    // canonical token) the moment the acceptance lands.
    let acceptFingerprint: string | null = device.deviceFingerprint ?? null
    let acceptCanonicalToken: string | undefined
    if (!acceptFingerprint || !updatedDevice.deviceToken) {
      try {
        const full = await db.agencyDevice.findUnique({
          where: { id: device.id },
          select: { deviceFingerprint: true, deviceToken: true },
        })
        if (full) {
          acceptFingerprint = acceptFingerprint || full.deviceFingerprint
          acceptCanonicalToken = full.deviceToken || undefined
        }
      } catch { /* best-effort — reconcile falls back to name matching */ }
    } else {
      acceptCanonicalToken = updatedDevice.deviceToken || undefined
    }
    emitAgencyDeviceEvent('agency-device:connected', agencyId, {
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      deviceFingerprint: acceptFingerprint || undefined,
      deviceToken: acceptCanonicalToken,
      acceptedVia: 'accept-pairing',
    })

    // 0.6.88 — device event stream: kiosk approved the agency pairing request.
    appendDeviceEvent({
      event: 'pairing_accepted',
      message: `Kiosk accepted pairing with agency ${agency.name}`,
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      agencyId,
      status: 'ONLINE',
    })

    return c.json({
      success: true,
      registered: true,
      registration: {
        verified: true,
        deviceId: registeredRow.id,
        deviceName: registeredRow.name,
        agencyId: registeredRow.agencyId,
        branchId: registeredRow.branchId || null,
        status: registeredRow.status,
        registeredAt: registeredRow.connectedAt || now,
        verifiedAt: new Date(),
      },
      device: updatedDevice,
      agency: {
        ...agency,
        isPaused: queueSettings?.isPaused ?? false,
      },
      services,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/ACCEPT-PAIRING]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ─── GET /public/pairing-verify — FINAL REGISTRATION CHECK (0.6.113) ─────────
// Hardened pairing protocol, phase B: the kiosk does NOT adopt the access
// token or navigate to the service selector on the bare accept response.
// It first INDEPENDENTLY re-reads the registration from this endpoint — a
// second, read-only view of the same store — and only proceeds when the
// device row PROVES: bound to the requested agency + ONLINE (+, when the
// caller passes commandId, that specific PAIRING_REQUEST completed).
// Query: ?agencyId=<expected>&commandId=<pairing command id>  Auth: Bearer
// deviceToken (the candidate token the kiosk would adopt).

app.get('/public/pairing-verify', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: true, registered: false, reason: 'NOT_AUTHENTICATED' })
    }

    const expectedAgencyId = c.req.query('agencyId') || ''
    const commandId = c.req.query('commandId') || ''

    const row = await db.agencyDevice.findUnique({
      where: { id: device.id },
      select: {
        id: true, name: true, type: true, status: true,
        agencyId: true, branchId: true, screenLayout: true, deviceToken: true,
      },
    })
    if (!row) return c.json({ success: true, registered: false, reason: 'DEVICE_GONE' })

    const bound = !!row.agencyId && (!expectedAgencyId || row.agencyId === expectedAgencyId)
    const online = row.status === 'ONLINE'
    let commandConfirmed = true
    if (commandId) {
      try {
        const cmd = await db.deviceCommand.findFirst({
          where: { id: commandId, deviceId: row.id, type: 'PAIRING_REQUEST' },
          select: { status: true },
        })
        // A still-PENDING command means the accept never landed on the
        // pairing itself — not registered. A missing row is tolerated (the
        // offer may predate the command store on legacy paths).
        if (cmd && cmd.status !== 'COMPLETED') commandConfirmed = false
      } catch { /* legacy store without DeviceCommand — tolerated */ }
    }

    if (!(bound && online && commandConfirmed)) {
      return c.json({
        success: true,
        registered: false,
        reason: !bound ? 'NOT_BOUND' : !online ? 'NOT_ONLINE' : 'COMMAND_PENDING',
        device: { id: row.id, name: row.name, status: row.status, agencyId: row.agencyId || null, branchId: row.branchId || null },
      })
    }

    const agency = await db.agency.findUnique({
      where: { id: row.agencyId!, isActive: true },
      select: { id: true, name: true, nameAr: true, nameFr: true, customCode: true, isQueueOpen: true, logoUrl: true, category: true, workingHoursStart: true, workingHoursEnd: true },
    })
    if (!agency) {
      return c.json({ success: true, registered: false, reason: 'AGENCY_INACTIVE', device: { id: row.id, name: row.name, status: row.status, agencyId: row.agencyId } })
    }

    const services = await db.service.findMany({
      where: { agencyId: row.agencyId!, isActive: true },
      select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true },
    })
    const queueSettings = await db.queueSettings.findFirst({
      where: { agencyId: row.agencyId! },
      select: { isPaused: true },
      orderBy: { updatedAt: 'desc' },
    })

    return c.json({
      success: true,
      registered: true,
      registration: {
        verified: true,
        deviceId: row.id,
        deviceName: row.name,
        agencyId: row.agencyId,
        branchId: row.branchId || null,
        status: row.status,
        verifiedAt: new Date(),
      },
      device: { id: row.id, name: row.name, status: row.status, agencyId: row.agencyId, branchId: row.branchId, screenLayout: row.screenLayout },
      agency: { ...agency, isPaused: queueSettings?.isPaused ?? false },
      services,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/PAIRING-VERIFY]', error)
    return c.json({ success: false, registered: false, error: 'Internal server error' }, 500)
  }
})

// ─── POST /device/reject-pairing — Kiosk rejects a pairing request ──────────

app.post('/device/reject-pairing', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
    const { commandId } = body as { commandId?: string }

    if (!commandId) {
      return c.json({ success: false, error: 'commandId is required' }, 400)
    }

    const result = await db.deviceCommand.updateMany({
      where: { id: commandId, deviceId: device.id, type: 'PAIRING_REQUEST', status: 'PENDING' },
      data: { status: 'FAILED', error: 'Rejected by kiosk operator' },
    })

    if (result.count === 0) {
      return c.json({ success: false, error: 'Pairing request not found or already processed' }, 404)
    }

    // 0.6.88 — device event stream: kiosk rejected the pairing request.
    appendDeviceEvent({
      event: 'pairing_rejected',
      message: 'Kiosk rejected the pairing request',
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      level: 'warn',
    })

    return c.json({ success: true })
  } catch (error: unknown) {
    console.error('[DEVICE/REJECT-PAIRING]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ─── 0.6.114 — KIOSK PRINTER SETTINGS (the setting ON the kiosk) ───────────
// User requirement: "there is no setting for select default printer for kiosk
// among registered printers". The Device Manager kiosk card already carries
// the Default-printer select (0.6.104), but the operator standing IN FRONT of
// the kiosk has no surface. These device-token routes give the KIOSK APP
// ITSELF a printer-settings sheet over the agency's REGISTERED printers
// (PRINTER AgencyDevice rows) and persist the choice on the kiosk's OWN row
// (printerConfig.defaultPrinterDeviceId — the same key the print route's
// resolveKioskDefaultPrinter reads when a receipt is printed).

interface PrinterOptionItem {
  id: string
  name: string
  nameAr: string | null
  nameFr: string | null
  connectionType: string
  ipAddress: string | null
  port: number | null
  attachment: string | null
  hostIp: string | null
  cupsName: string | null
}

function parsePrinterConfigJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {}
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} }
}

app.get('/device/printer-options', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }
    if (!device.agencyId) {
      return c.json({ success: false, error: 'Device is not paired with an agency yet' }, 409)
    }
    const printers = await db.agencyDevice.findMany({
      where: { agencyId: device.agencyId, type: 'PRINTER' },
      select: { id: true, name: true, nameAr: true, nameFr: true, connectionType: true, ipAddress: true, port: true, printerConfig: true },
      orderBy: { createdAt: 'asc' },
    })
    const items: PrinterOptionItem[] = printers.map((p: { id: string; name: string; nameAr: string | null; nameFr: string | null; connectionType: string | null; ipAddress: string | null; port: number | null; printerConfig: string | null }) => {
      const pCfg = parsePrinterConfigJson(p.printerConfig)
      return {
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        nameFr: p.nameFr,
        connectionType: p.connectionType || 'LAN',
        ipAddress: p.ipAddress,
        port: p.port,
        attachment: typeof pCfg.attachment === 'string' ? pCfg.attachment : null,
        hostIp: typeof pCfg.hostIp === 'string' ? pCfg.hostIp : null,
        cupsName: typeof pCfg.cupsName === 'string' ? pCfg.cupsName : (typeof pCfg.osPrinterName === 'string' ? pCfg.osPrinterName : null),
      }
    })
    const kioskCfg = parsePrinterConfigJson(device.printerConfig)
    const agencyDefault = await db.defaultPrinter.findUnique({ where: { agencyId: device.agencyId } }).catch(() => null)
    return c.json({
      success: true,
      printers: items,
      assignedPrinterId: typeof kioskCfg.defaultPrinterDeviceId === 'string' ? kioskCfg.defaultPrinterDeviceId : '',
      agencyDefault: agencyDefault ? { name: agencyDefault.name || null, ip: agencyDefault.ip || null } : null,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/PRINTER-OPTIONS]', error)
    return c.json({ success: false, error: 'Failed to load printer options' }, 500)
  }
})

app.post('/device/printer-default', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }
    if (!device.agencyId) {
      return c.json({ success: false, error: 'Device is not paired with an agency yet' }, 409)
    }
    if (device.type !== 'KIOSK') {
      return c.json({ success: false, error: 'Only kiosk devices can set a default printer this way' }, 403)
    }
    const body = await c.req.json().catch(() => ({})) as { printerId?: unknown }
    const printerId = typeof body.printerId === 'string' ? body.printerId.trim() : ''
    const kioskCfg = parsePrinterConfigJson(device.printerConfig)
    const nextCfg: Record<string, unknown> = { ...kioskCfg }
    if (printerId) {
      // The chosen printer MUST be one of the agency's registered printers —
      // an id from another store/agency would silently break receipt printing.
      const printerRow = await db.agencyDevice.findUnique({ where: { id: printerId } })
      if (!printerRow || printerRow.type !== 'PRINTER' || printerRow.agencyId !== device.agencyId) {
        return c.json({ success: false, error: 'Selected printer is not a registered printer of this agency' }, 400)
      }
      nextCfg.defaultPrinterDeviceId = printerId
    } else {
      // Empty printerId clears the assignment → the agency DefaultPrinter
      // becomes the print target again.
      delete nextCfg.defaultPrinterDeviceId
    }
    await db.agencyDevice.update({
      where: { id: device.id },
      data: { printerConfig: JSON.stringify(nextCfg) },
    })
    emitAgencyDeviceEvent('agency-device:updated', device.agencyId, { deviceId: device.id, deviceName: device.name })
    appendDeviceEvent({
      event: 'kiosk_printer_default_set',
      message: printerId
        ? `Kiosk "${device.name}" default printer set to a registered printer (set on the kiosk itself)`
        : `Kiosk "${device.name}" default printer cleared (agency default applies)`,
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
    })
    return c.json({ success: true, assignedPrinterId: printerId })
  } catch (error: unknown) {
    console.error('[DEVICE/PRINTER-DEFAULT]', error)
    return c.json({ success: false, error: 'Failed to save the default printer' }, 500)
  }
})

// ─── POST /device/sync ─────────────────────────────────────────────────────

app.post('/device/sync', async (c) => {
  try {
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
    const validation = syncDeviceSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const { offlineData } = validation.data

    // If there's offline data (e.g. offline-created tickets), process them
    // For now, we acknowledge receipt. The actual queue sync logic would
    // integrate with the queue module.
    if (offlineData && offlineData.length > 0) {
      // TODO: integrate with queue module for offline ticket reconciliation
      return c.json({ success: true, syncedCount: 0, message: 'Offline sync not yet implemented' })
    }

    // Fetch current queue status for the agency/branch
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    const waitingCount = await db.reservation.count({
      where: {
        agencyId: device.agencyId,
        branchId: device.branchId ?? null,
        status: 'WAITING',
      },
    })

    const servedTodayCount = await db.reservation.count({
      where: {
        agencyId: device.agencyId,
        branchId: device.branchId ?? null,
        status: { in: ['SERVED', 'NO_SHOW', 'CANCELLED'] },
        createdAt: { gte: todayStart },
      },
    })

    // Get the latest config version (device updatedAt serves as config version)
    const latestDevice = await db.agencyDevice.findUnique({
      where: { id: device.id },
      select: { updatedAt: true, status: true },
    })

    return c.json({
      success: true,
      syncedCount: 0,
      queueStatus: {
        waitingCount,
        servedTodayCount,
      },
      configVersion: latestDevice?.updatedAt?.toISOString() ?? null,
      deviceStatus: latestDevice?.status ?? device.status,
    })
  } catch (error: unknown) {
    console.error('[DEVICE/SYNC]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  AGENCY-FACING ENDPOINTS  (authenticated via JWT — requireAuth)
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET /unpaired — List unpaired devices available for pairing ──────────
// Returns orphan devices (no agencyId) that are in PAIRING status and have a recent heartbeat.

app.get('/unpaired', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const ninetySecAgo = new Date(Date.now() - 90 * 1000)

    const devices = await db.agencyDevice.findMany({
      where: {
        agencyId: null,
        status: 'PAIRING',
        lastHeartbeatAt: { gte: ninetySecAgo },
      },
      select: {
        id: true, name: true, nameAr: true, nameFr: true, type: true,
        status: true, connectionType: true, ipAddress: true, port: true,
        deviceFingerprint: true, appVersion: true, autoDiscovery: true,
        screenLayout: true, lastHeartbeatAt: true, statusChangedAt: true,
        createdAt: true,
      },
      orderBy: { lastHeartbeatAt: 'desc' },
      take: 50,
    })

    // ── 0.6.115 — ONE CARD PER PHYSICAL DEVICE (legacy duplicate collapse) ──
    // discover-register before 0.6.115 could mint several rows for the same
    // fingerprint (status-filtered match). Collapse them here to the newest
    // heartbeat so the approval strip never shows "phone + kiosk" twice for
    // one device — display-only, no destructive writes.
    const seenFingerprints = new Set<string>()
    const collapsedDevices = (devices as any[]).filter((d: any) => {
      if (!d.deviceFingerprint) return true
      const key = d.deviceFingerprint.toLowerCase()
      if (seenFingerprints.has(key)) return false
      seenFingerprints.add(key)
      return true
    })

    // ── 0.6.119 — BLOCKED (deleted) fingerprints stay visible ──
    // Deliberately deleted devices no longer re-register; the strip shows a
    // "Removed — re-registration blocked" chip with an explicit "allow
    // re-discovery" action so re-pairing stays possible.
    try {
      const tombstones = await listDeviceTombstones()
      for (const t of tombstones) {
        if (collapsedDevices.some((d: any) => d.deviceFingerprint === t.fingerprint)) continue
        if (t.agencyId && t.agencyId !== user.agencyId) continue
        collapsedDevices.push({
          id: 'tombstone-' + t.fingerprint,
          name: t.name || 'Removed device',
          type: t.type || 'KIOSK',
          status: 'REMOVED',
          connectionType: 'LAN',
          ipAddress: t.ipAddress || null,
          port: null,
          deviceFingerprint: t.fingerprint,
          tombstoned: true,
          tombstonedAt: t.deletedAt,
        })
      }
    } catch { /* display-only — never break the strip */ }

    return c.json({ success: true, devices: collapsedDevices })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/pairing-request — Send pairing request to an unpaired device ──

app.post('/:id/pairing-request', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const deviceId = c.req.param('id')

    // Verify device exists and is unpaired
    const device = await db.agencyDevice.findUnique({
      where: { id: deviceId },
      // 0.6.101 — deviceFingerprint/deviceToken selected: the pairing-wait
      // socket push and the adopted-token payload key on the device identity.
      select: { id: true, name: true, type: true, status: true, agencyId: true, lastHeartbeatAt: true, deviceFingerprint: true, deviceToken: true },
    })

    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    if (device.agencyId) {
      return c.json({ success: false, error: 'Device is already paired with an agency' }, 409)
    }

    if (device.status !== 'PAIRING') {
      return c.json({ success: false, error: `Device is not in PAIRING status (current: ${device.status})` }, 409)
    }

    // Check for a recent heartbeat.
    // 0.6.95 — widened 90s → 10min: the kiosk beats every 30s but skips beats
    // inside the server's 10s dedupe window, may pause while the network
    // reconnects, and the manager's strip can lag one poll behind. A 90s
    // freshness wall 400'd legitimate pairings ("Device is not currently
    // online") moments after a beat skip. The PAIRING_REQUEST command itself
    // carries a 10-minute TTL, so a 10-minute freshness window can never
    // deliver a request to a device that cannot still receive it.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
    if (!device.lastHeartbeatAt || device.lastHeartbeatAt < tenMinAgo) {
      return c.json({ success: false, error: 'Device is not currently online' }, 400)
    }

    // Get agency info for the pairing request payload
    const agency = await db.agency.findUnique({
      where: { id: user.agencyId },
      select: { id: true, name: true, nameAr: true, nameFr: true },
    })

    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    // Create a PAIRING_REQUEST command for the device
    const command = await db.deviceCommand.create({
      data: {
        deviceId,
        type: 'PAIRING_REQUEST',
        payload: JSON.stringify({
          agencyId: agency.id,
          agencyName: agency.name,
          agencyNameAr: agency.nameAr,
          agencyNameFr: agency.nameFr,
          sentBy: user.id,
          sentByName: user.fullName || user.username,
        }),
        status: 'PENDING',
        ttl: 600, // 10 minutes to respond
      },
    })

    // Emit realtime event to the AGENCY room (0.6.96 fix: the historic call
    // passed the literal string 'discovery' as the agencyId, so the event
    // went to a room no client was ever in — realtime pairing requests were
    // silently dead and the kiosk only learned of them via the 5s poll).
    emitAgencyDeviceEvent('agency-device:pairing-request', agency.id, {
      deviceId: device.id,
      deviceName: device.name,
      commandId: command.id,
      agencyId: agency.id,
      agencyName: agency.name,
    })
    // 0.6.101 — INSTANT delivery into the waiting device's pre-pairing socket
    // room (keyed by device id + fingerprint). The 5s /device-status poll
    // stays as the fallback — the socket push removes the whole "pairing
    // request never reached the kiosk" class of failures.
    void emitPairingWaitEvent({
      id: command.id,
      deviceId: device.id,
      fingerprint: device.deviceFingerprint || undefined,
      agencyId: agency.id,
      agencyName: agency.name,
      agencyNameAr: agency.nameAr || undefined,
      agencyNameFr: agency.nameFr || undefined,
      sentByName: user.fullName || user.username,
      deviceToken: device.deviceToken || undefined,
      sentAt: command.createdAt instanceof Date ? command.createdAt.toISOString() : String(command.createdAt),
    })

    // 0.6.88 — device event stream: agency sent a pairing request to a kiosk.
    appendDeviceEvent({
      event: 'pairing_requested',
      message: `Pairing request sent to ${device.name} by ${user.fullName || user.username}`,
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      agencyId: agency.id,
      userId: user.id,
      username: user.username,
      data: { commandId: command.id },
    })

    return c.json({
      success: true,
      message: `Pairing request sent to ${device.name}`,
      commandId: command.id,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET / — List devices for the agency ───────────────────────────────────

app.get('/', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const status = c.req.query('status')
    const type = c.req.query('type')

    const where: Record<string, unknown> = { agencyId: user.agencyId }
    if (status) where.status = status
    if (type) where.type = type

    const devices = await db.agencyDevice.findMany({
      where,
      select: DEVICE_SELECT,
      orderBy: { createdAt: 'desc' },
    })

    // ── 0.6.115 — ONE ROW PER PHYSICAL DEVICE (legacy duplicate collapse) ──
    // Legacy pairing bugs could leave two rows with the same fingerprint in
    // one agency (e.g. "phone" + "kiosk mode" for a single tablet). Collapse
    // them to the newest row — display-only, ids stay valid for actions.
    const seenListFingerprints = new Set<string>()
    const collapsedListDevices = (devices as any[]).filter((d: any) => {
      const fp = typeof d.deviceFingerprint === 'string' && d.deviceFingerprint
      if (!fp) return true
      const key = fp.toLowerCase()
      if (seenListFingerprints.has(key)) return false
      seenListFingerprints.add(key)
      return true
    })

    // M7: Parse JSON string fields before returning
    const parsedDevices = collapsedListDevices.map((d: any) => ({
      ...d,
      displaySettings: parseJSON(d.displaySettings),
      printerConfig: parseJSON(d.printerConfig),
    }))

    return c.json({ success: true, devices: parsedDevices })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST / — Create a new device ──────────────────────────────────────────

app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const body = await c.req.json()
    const validation = createDeviceSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const data = validation.data

    // Generate unique pairing code
    let pairingCode = generatePairingCode()
    let attempts = 0
    while (attempts < 10) {
      const existing = await db.agencyDevice.findUnique({ where: { pairingCode } })
      if (!existing) break
      pairingCode = generatePairingCode()
      attempts++
    }

    // Generate device token (returned only this one time)
    const deviceToken = crypto.randomBytes(32).toString('hex')

    const device = await db.agencyDevice.create({
      data: {
        agencyId: user.agencyId,
        name: data.name,
        nameAr: data.nameAr,
        nameFr: data.nameFr,
        type: data.type,
        status: 'OFFLINE',
        connectionType: data.connectionType,
        ipAddress: data.ipAddress,
        port: data.port,
        pairingCode,
        deviceToken,
        autoDiscovery: data.autoDiscovery,
        displaySettings: JSON.stringify(data.displaySettings),
        printerConfig: JSON.stringify(data.printerConfig),
        screenLayout: data.screenLayout,
        branchId: data.branchId,
        serviceFilter: data.serviceFilter,
      },
      select: DEVICE_SELECT,
    })

    // Return deviceToken ONLY on creation — never again
    return c.json({ success: true, device, deviceToken })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /auto-register — Auto-register a discovered device ───────────────

app.post('/auto-register', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const body = await c.req.json()
    const validation = z.object({
      deviceId: z.string().min(1),
      name: z.string().min(1).max(100).optional(),
    }).safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const { deviceId, name } = validation.data

    const device = await db.agencyDevice.findUnique({
      where: { id: deviceId },
    })

    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    if (device.status !== 'PAIRING') {
      return c.json({ success: false, error: `Device is not in PAIRING status (current: ${device.status})` }, 409)
    }

    const updated = await db.agencyDevice.update({
      where: { id: deviceId },
      data: {
        agencyId: user.agencyId,
        name: name ?? device.name,
        status: 'ONLINE',
        statusChangedAt: new Date(),
        connectedAt: device.connectedAt ?? new Date(),
      },
      select: DEVICE_SELECT,
    })

    emitAgencyDeviceEvent('agency:device-connected', user.agencyId, {
      deviceId: updated.id,
      deviceName: updated.name,
      deviceType: updated.type,
    })

    return c.json({ success: true, device: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /test-printer — Test printer connectivity ─────────────────────────

app.post('/test-printer', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const body = await c.req.json()
    const validation = z.object({
      deviceId: z.string().min(1),
    }).safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const { deviceId } = validation.data

    const device = await db.agencyDevice.findFirst({
      where: { id: deviceId, agencyId: user.agencyId },
      select: { id: true, name: true, type: true, ipAddress: true, port: true },
    })

    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    if (device.type !== 'PRINTER') {
      return c.json({ success: false, error: 'Device is not a printer' }, 400)
    }

    if (!device.ipAddress) {
      return c.json({ success: false, error: 'Printer has no IP address configured' }, 400)
    }

    const printerPort = device.port ?? 9100
    const url = `http://${device.ipAddress}:${printerPort}`

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Connection': 'close' },
      })
      clearTimeout(timeout)

      return c.json({
        success: true,
        message: `Printer at ${device.ipAddress}:${printerPort} is reachable (HTTP ${response.status})`,
      })
    } catch (fetchError: unknown) {
      const isTimeout = fetchError instanceof DOMException && fetchError.name === 'AbortError'
      const message = isTimeout
        ? `Printer at ${device.ipAddress}:${printerPort} did not respond within 5 seconds`
        : `Cannot connect to printer at ${device.ipAddress}:${printerPort} — device may be offline or port ${printerPort} is not accepting connections`

      return c.json({ success: false, message })
    }
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /tombstones — cloud blocklist → branch desktop pull (0.6.126) ────
// The realtime 'agency-device:revoked' push only reaches a CONNECTED desktop.
// When the branch was offline at delete time, its mirror row survived and
// the deleted kiosk kept working device-to-device. The desktop now PULLS
// this list on every (re)connect of its sync socket and applies it locally —
// the offline-delete hole closes with the same data the push used.
app.get('/tombstones', async (c) => {
  try {
    const user = await requireAuth(c)
    const all = await listDeviceTombstones()
    // Agency scoping mirrors /tombstones/sync: unscoped entries are global
    // (an agency-less device row), agency-scoped entries only go home.
    const visible = all.filter((t) => !t.agencyId || !user.agencyId || t.agencyId === user.agencyId)
    return c.json({ success: true, tombstones: visible })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})
// REGISTERED BEFORE GET /:id — Hono matches in registration order and the
// /:id handler would otherwise capture "tombstones" as a device id.

// ─── GET /:id — Get a single device ────────────────────────────────────────

app.get('/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const device = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
      select: DEVICE_SELECT,
    })

    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    // M7: Parse JSON string fields before returning
    const parsedDevice = {
      ...device,
      displaySettings: parseJSON(device.displaySettings),
      printerConfig: parseJSON(device.printerConfig),
    }

    return c.json({ success: true, device: parsedDevice })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── PATCH /:id — Update a device ──────────────────────────────────────────

app.patch('/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const body = await c.req.json()
    const validation = updateDeviceSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const data = validation.data

    // Verify ownership
    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const updateData: Record<string, unknown> = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.nameAr !== undefined) updateData.nameAr = data.nameAr
    if (data.nameFr !== undefined) updateData.nameFr = data.nameFr
    if (data.type !== undefined) updateData.type = data.type
    if (data.status !== undefined) {
      updateData.status = data.status
      updateData.statusChangedAt = new Date()
    }
    if (data.connectionType !== undefined) updateData.connectionType = data.connectionType
    if (data.ipAddress !== undefined) updateData.ipAddress = data.ipAddress
    if (data.port !== undefined) updateData.port = data.port
    if (data.autoDiscovery !== undefined) updateData.autoDiscovery = data.autoDiscovery
    if (data.screenLayout !== undefined) updateData.screenLayout = data.screenLayout
    if (data.serviceFilter !== undefined) updateData.serviceFilter = data.serviceFilter
    if (data.appVersion !== undefined) updateData.appVersion = data.appVersion
    if (data.offlineCapable !== undefined) updateData.offlineCapable = data.offlineCapable
    if (data.branchId !== undefined) updateData.branchId = data.branchId
    if (data.displaySettings !== undefined) updateData.displaySettings = JSON.stringify(data.displaySettings)
    if (data.printerConfig !== undefined) updateData.printerConfig = JSON.stringify(data.printerConfig)

    const device = await db.agencyDevice.update({
      where: { id: c.req.param('id') },
      data: updateData,
      select: DEVICE_SELECT,
    })

    // Auto-create CONFIG_UPDATE command if display settings or printer config
    // changed and the device is currently ONLINE
    const configChanged = data.displaySettings !== undefined || data.printerConfig !== undefined
    if (configChanged && existing.status === 'ONLINE') {
      await db.deviceCommand.create({
        data: {
          deviceId: existing.id,
          type: 'CONFIG_UPDATE',
          payload: JSON.stringify({
            displaySettings: data.displaySettings ?? undefined,
            printerConfig: data.printerConfig ?? undefined,
            screenLayout: data.screenLayout ?? undefined,
            serviceFilter: data.serviceFilter ?? undefined,
          }),
          status: 'PENDING',
        },
      })
    }

    // H2: Emit realtime event
    emitAgencyDeviceEvent('agency-device:updated', user.agencyId, { deviceId: existing.id })

    return c.json({ success: true, device })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── DELETE /:id — Delete a device ─────────────────────────────────────────

app.delete('/:id', async (c) => {
  try {
    const user = await requireAuth(c)

    // Build query: SUPER_ADMIN can delete any device; agency staff can only delete their own
    const whereClause: any = { id: c.req.param('id') }
    if (user.agencyId) {
      whereClause.agencyId = user.agencyId
    }

    const existing = await db.agencyDevice.findFirst({ where: whereClause })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    // Delete related commands first, then delete the device
    await dbRaw.deviceCommand.deleteMany({ where: { deviceId: c.req.param('id') } })
    await dbRaw.agencyDevice.delete({ where: { id: c.req.param('id') } })

    // 0.6.119 — GHOST FIX: tombstone the fingerprint so discover-register /
    // public-register can never mint the row again (the physical device keeps
    // re-announcing with its stable fingerprint). Lifted automatically on a
    // genuine re-pair or via POST /tombstones/clear.
    if (existing.deviceFingerprint) {
      await addDeviceTombstone(existing.deviceFingerprint, {
        name: existing.name,
        type: existing.type,
        ipAddress: existing.ipAddress,
        agencyId: existing.agencyId,
      })
    }

    // Emit realtime event
    emitAgencyDeviceEvent('agency-device:disconnected', existing.agencyId || 'system', { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type })
    // 0.6.126 — REVOCATION PROPAGATION: the branch desktop mirrors this device
    // in its OWN local store (same canonical token). Without an explicit
    // revocation push the deleted kiosk kept working device-to-device against
    // the desktop forever — the desktop relay (local-realtime) deletes the
    // mirror row + tombstones the fingerprint when this event lands.
    emitAgencyDeviceEvent('agency-device:revoked', existing.agencyId || 'system', {
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      deviceFingerprint: existing.deviceFingerprint || undefined,
      ipAddress: existing.ipAddress || undefined,
      reason: 'deleted',
    })

    return c.json({ success: true, tombstoned: !!existing.deviceFingerprint })
  } catch (error: unknown) {
    console.error('[AgencyDevice] DELETE error:', error)
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
    return c.json({ success: false, error: 'Failed to delete device' }, 500)
  }
})

// ─── POST /delete-by-fingerprint — cross-store delete (0.6.119) ──────────
// The desktop's local DELETE proxies here (best-effort) so a ghost deleted
// on the LAN manager is ALSO removed + tombstoned in the cloud store the
// kiosk may be registering against. Idempotent: no rows → success.
app.post('/delete-by-fingerprint', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json().catch(() => ({}))
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim().slice(0, 200) : ''
    if (!fingerprint) {
      return c.json({ success: false, error: 'fingerprint required' }, 400)
    }
    const whereClause: any = { deviceFingerprint: fingerprint }
    if (user.agencyId) whereClause.agencyId = user.agencyId
    const rows = await dbRaw.agencyDevice.findMany({ where: whereClause, select: { id: true, name: true, type: true, ipAddress: true, agencyId: true } })
    let deleted = 0
    for (const row of rows) {
      await dbRaw.deviceCommand.deleteMany({ where: { deviceId: row.id } })
      await dbRaw.agencyDevice.delete({ where: { id: row.id } })
      deleted += 1
    }
    if (fingerprint) {
      await addDeviceTombstone(fingerprint, rows[0] || { agencyId: user.agencyId })
    }
    if (rows[0]) {
      emitAgencyDeviceEvent('agency-device:disconnected', rows[0].agencyId || 'system', { deviceId: rows[0].id, deviceName: rows[0].name, deviceType: rows[0].type })
      // 0.6.126 — REVOCATION PROPAGATION (see DELETE /:id): the deleting side
      // is usually the desktop itself, but the cloud row can also exist
      // independently (cloud-registered kiosk) — push the revocation so the
      // desktop's mirror dies with it.
      emitAgencyDeviceEvent('agency-device:revoked', rows[0].agencyId || 'system', {
        deviceId: rows[0].id,
        deviceName: rows[0].name,
        deviceType: rows[0].type,
        deviceFingerprint: fingerprint,
        ipAddress: rows[0].ipAddress || undefined,
        reason: 'deleted-by-fingerprint',
      })
    }
    return c.json({ success: true, deleted, tombstoned: true })
  } catch (error: unknown) {
    console.error('[AgencyDevice] DELETE-by-fingerprint error:', error)
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
    return c.json({ success: false, error: 'Failed to delete device' }, 500)
  }
})

// ─── POST /tombstones/clear — "Allow re-discovery" (0.6.119) ──────────────
// Lift the deleted-device blocklist for one fingerprint (manager UI action
// on the unpaired strip; also called by the desktop proxy).
app.post('/tombstones/clear', async (c) => {
  try {
    await requireAuth(c)
    const body = await c.req.json().catch(() => ({}))
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim().slice(0, 200) : ''
    if (!fingerprint) {
      return c.json({ success: false, error: 'fingerprint required' }, 400)
    }
    const cleared = await clearDeviceTombstone(fingerprint)
    return c.json({ success: true, cleared })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /tombstones/sync — branch → cloud blocklist merge (0.6.124) ─────
// A manager can delete a device while the branch desktop is OFFLINE: the
// desktop tombstones locally and its delete-by-fingerprint relay fails, so
// the cloud store never learns about the deletion and the kiosk's token
// stays valid against its cloud row ("the kiosk can connect normally after
// been deleted"). The branch desktop now pushes its full blocklist (LAN
// status reporter tick + right after a failed delete relay); this route
// MERGES it idempotently (newest deletedAt wins — replays are safe). Scoped
// to the caller's agency so one branch can never blocklist another's
// fingerprints: only entries whose meta.agencyId is null or matches.
app.post('/tombstones/sync', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json().catch(() => ({})) as { tombstones?: Array<Record<string, unknown>> }
    const incoming = Array.isArray(body.tombstones) ? body.tombstones : []
    const scoped = incoming.filter((t) => {
      if (!t || typeof t.fingerprint !== 'string' || !t.fingerprint.trim()) return false
      if (typeof t.agencyId === 'string' && t.agencyId && user.agencyId && t.agencyId !== user.agencyId) return false
      return true
    }).map((t) => ({
      ...t,
      // Stamp the caller's agency on unscoped entries so the blocklist stays
      // attributable (the desktop always sends its own agencyId).
      agencyId: typeof t.agencyId === 'string' && t.agencyId ? t.agencyId : (user.agencyId || undefined),
    }))
    const applied = await mergeDeviceTombstones(scoped as any)
    return c.json({ success: true, received: scoped.length, applied })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/pair — Initiate pairing (regenerate pairing code + token) ──

app.post('/:id/pair', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    // Generate new unique pairing code
    let pairingCode = generatePairingCode()
    let attempts = 0
    while (attempts < 10) {
      const dupe = await db.agencyDevice.findUnique({ where: { pairingCode } })
      if (!dupe) break
      pairingCode = generatePairingCode()
      attempts++
    }

    // Security measure: regenerate deviceToken on pairing initiation
    const deviceToken = crypto.randomBytes(32).toString('hex')

    const device = await db.agencyDevice.update({
      where: { id: c.req.param('id') },
      data: {
        pairingCode,
        deviceToken,
        status: 'PAIRING',
        statusChangedAt: new Date(),
      },
      select: DEVICE_SELECT,
    })

    // 0.6.88 — device event stream: pairing initiated (credentials issued).
    appendDeviceEvent({
      event: 'pair_started',
      message: `Pairing initiated for ${existing.name || existing.id} — new pairing code issued`,
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
      status: 'PAIRING',
    })

    return c.json({ success: true, pairingCode: device.pairingCode, deviceToken })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/connect — Mark device as connected (manual staff action) ────

app.post('/:id/connect', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const device = await db.agencyDevice.update({
      where: { id: c.req.param('id') },
      data: {
        status: 'ONLINE',
        connectedAt: new Date(),
        lastHeartbeatAt: new Date(),
        statusChangedAt: new Date(),
      },
      select: DEVICE_SELECT,
    })

    // H2: Emit realtime event
    emitAgencyDeviceEvent('agency-device:connected', user.agencyId, { deviceId: existing.id })

    // 0.6.88 — device event stream: manual connect.
    appendDeviceEvent({
      event: 'connect_success',
      message: `Device marked connected by ${user.fullName || user.username}`,
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
      status: 'ONLINE',
    })

    return c.json({ success: true, device })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/disconnect — Mark device as disconnected + invalidate token ─

app.post('/:id/disconnect', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const device = await db.agencyDevice.update({
      where: { id: c.req.param('id') },
      data: {
        status: 'OFFLINE',
        statusChangedAt: new Date(),
        deviceToken: null, // Invalidate the token
      },
      select: DEVICE_SELECT,
    })

    // H2: Emit realtime event
    emitAgencyDeviceEvent('agency-device:disconnected', user.agencyId, { deviceId: existing.id })

    // 0.6.88 — device event stream: manual disconnect (token invalidated).
    appendDeviceEvent({
      event: 'disconnect',
      message: `Device disconnected by ${user.fullName || user.username} — token invalidated`,
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
      status: 'OFFLINE',
    })

    return c.json({ success: true, device })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/unpair — Unpair device, invalidate token, force disconnect ───

app.post('/:id/unpair', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const deviceId = c.req.param('id')
    const existing = await db.agencyDevice.findFirst({
      where: { id: deviceId, agencyId: user.agencyId },
      include: { branch: { select: { id: true, name: true, nameAr: true, nameFr: true } } },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    if (!existing.agencyId) {
      return c.json({ success: false, error: 'Device is not paired with any agency' }, 400)
    }

    const now = new Date()

    // Create FORCE_DISCONNECT command so the kiosk gets notified immediately via heartbeat
    await db.deviceCommand.create({
      data: {
        deviceId: existing.id,
        type: 'FORCE_DISCONNECT',
        payload: JSON.stringify({ reason: 'unpaired_by_admin', agencyName: existing.name }),
        status: 'PENDING',
        ttl: 300, // 5 minutes TTL
      },
    })

    // Update device: remove agency, invalidate token, set offline
    const device = await db.agencyDevice.update({
      where: { id: deviceId },
      data: {
        agencyId: null,
        branchId: null,
        status: 'OFFLINE',
        deviceToken: null, // Invalidate the token — device can't authenticate anymore
        pairingCode: null,
        statusChangedAt: now,
        connectedAt: null,
      },
      select: DEVICE_SELECT,
    })

    // Emit realtime event for agency dashboard
    emitAgencyDeviceEvent('agency-device:disconnected', user.agencyId, {
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      reason: 'unpaired',
    })
    // 0.6.126 — REVOCATION PROPAGATION: the branch desktop's mirror row keeps
    // the same canonical token — it must detach its copy too (see DELETE /:id).
    emitAgencyDeviceEvent('agency-device:revoked', user.agencyId, {
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      deviceFingerprint: existing.deviceFingerprint || undefined,
      ipAddress: existing.ipAddress || undefined,
      reason: 'unpaired',
    })

    return c.json({ success: true, device })
  } catch (error: unknown) {
    console.error('[AgencyDevice] UNPAIR error:', error)
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/reboot — Send reboot command ────────────────────────────────

app.post('/:id/reboot', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const command = await db.deviceCommand.create({
      data: {
        deviceId: existing.id,
        type: 'REBOOT',
        payload: '{}',
        status: 'PENDING',
      },
    })

    // H2: Emit realtime event
    emitAgencyDeviceEvent('agency-device:updated', user.agencyId, { deviceId: existing.id })

    return c.json({ success: true, command })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/refresh — Send refresh command ──────────────────────────────

app.post('/:id/refresh', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const command = await db.deviceCommand.create({
      data: {
        deviceId: existing.id,
        type: 'REFRESH',
        payload: '{}',
        status: 'PENDING',
      },
    })

    // H2: Emit realtime event
    emitAgencyDeviceEvent('agency-device:updated', user.agencyId, { deviceId: existing.id })

    return c.json({ success: true, command })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/cast — Direct board cast to a registered TV (0.6.96) ────────

app.post('/:id/cast', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }
    if (!['TV', 'DISPLAY', 'KIOSK'].includes(existing.type)) {
      return c.json({ success: false, error: `Casting applies to TV/DISPLAY devices (this is a ${existing.type})` }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const origin = new URL(c.req.url).origin
    let url = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
    if (body && typeof body.url === 'string' && /^https?:\/\//.test(body.url)) url = body.url
    const command = await db.deviceCommand.create({
      data: {
        deviceId: existing.id,
        type: 'CAST_URL',
        payload: JSON.stringify({ url, agencyId: user.agencyId }),
        status: 'PENDING',
        ttl: 300,
      },
    })
    emitAgencyDeviceEvent('agency-device:updated', user.agencyId, { deviceId: existing.id })
    appendDeviceEvent({
      event: 'cast_sent',
      message: `Board cast sent to ${existing.name || existing.id} (CAST_URL)`,
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
      data: { commandId: command.id },
    })
    return c.json({ success: true, command, url, message: `Cast sent to ${existing.name || 'TV'}` })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/command — Send custom command ───────────────────────────────

app.post('/:id/command', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const body = await c.req.json()
    const validation = sendCommandSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }

    const { type, payload, ttl } = validation.data

    const command = await db.deviceCommand.create({
      data: {
        deviceId: existing.id,
        type,
        payload: JSON.stringify(payload ?? {}),
        status: 'PENDING',
        ttl: ttl ?? 300,
      },
    })

    // H2: Emit realtime event
    emitAgencyDeviceEvent('agency-device:updated', user.agencyId, { deviceId: existing.id })

    return c.json({ success: true, command })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /:id/commands — List commands for a device ────────────────────────

app.get('/:id/commands', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const deviceId = c.req.param('id')

    // Verify the device belongs to this agency
    const device = await db.agencyDevice.findFirst({
      where: { id: deviceId, agencyId: user.agencyId },
      select: { id: true },
    })
    if (!device) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    const statusFilter = c.req.query('status')

    const where: Record<string, unknown> = { deviceId }
    if (statusFilter) where.status = statusFilter

    const commands = await db.deviceCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return c.json({ success: true, commands })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/kiosk-credentials — Get/regenerate kiosk login credentials ──
// Returns pairingCode + deviceToken that the kiosk operator uses to log in

app.post('/:id/kiosk-credentials', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    // If device already has credentials, return them
    if (existing.pairingCode && existing.deviceToken) {
      return c.json({
        success: true,
        pairingCode: existing.pairingCode,
        deviceToken: existing.deviceToken,
        regenerated: false,
      })
    }

    // Otherwise regenerate
    let pairingCode = generatePairingCode()
    let attempts = 0
    while (attempts < 10) {
      const dupe = await db.agencyDevice.findUnique({ where: { pairingCode } })
      if (!dupe) break
      pairingCode = generatePairingCode()
      attempts++
    }

    const deviceToken = crypto.randomBytes(32).toString('hex')

    await db.agencyDevice.update({
      where: { id: existing.id },
      data: { pairingCode, deviceToken, status: existing.status === 'DISABLED' ? 'OFFLINE' : existing.status },
    })

    // 0.6.88 — device event stream: kiosk credentials (re)issued.
    appendDeviceEvent({
      event: 'kiosk_credentials_issued',
      message: `Kiosk credentials generated for ${existing.name || existing.id}`,
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
    })

    return c.json({ success: true, pairingCode, deviceToken, regenerated: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /:id/kiosk-credentials/regenerate — Force-regenerate credentials ─

app.post('/:id/kiosk-credentials/regenerate', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }

    const existing = await db.agencyDevice.findFirst({
      where: { id: c.req.param('id'), agencyId: user.agencyId },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Device not found' }, 404)
    }

    let pairingCode = generatePairingCode()
    let attempts = 0
    while (attempts < 10) {
      const dupe = await db.agencyDevice.findUnique({ where: { pairingCode } })
      if (!dupe) break
      pairingCode = generatePairingCode()
      attempts++
    }

    const deviceToken = crypto.randomBytes(32).toString('hex')

    await db.agencyDevice.update({
      where: { id: existing.id },
      data: {
        pairingCode,
        deviceToken,
        status: 'PAIRING',
        statusChangedAt: new Date(),
      },
    })

    // 0.6.88 — device event stream: kiosk credentials force-regenerated.
    appendDeviceEvent({
      event: 'kiosk_credentials_issued',
      message: `Kiosk credentials FORCE-regenerated for ${existing.name || existing.id} (old tokens invalidated)`,
      deviceId: existing.id,
      deviceName: existing.name,
      deviceType: existing.type,
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
      status: 'PAIRING',
    })

    return c.json({ success: true, pairingCode, deviceToken, regenerated: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Embedded Discovery Scanner (ARP + Ping + mDNS + SSDP + HTTP) ──────────
// Real multi-protocol LAN discovery running inside the API process — no
// external port-3010 service required. See src/lib/discovery/scanner.ts.

let scanState = {
  scanning: false,
  scanId: null as string | null,
  totalIPs: 0,
  scannedIPs: 0,
  currentSubnet: '',
  phase: 'idle' as ScanPhase | string,
  devicesFound: 0,
  subnets: [] as string[],
  protocolsUsed: [] as string[],
  elapsed: 0,
}
/** One entry of the embedded scan device list. `cached` / `verifiedAt` are
 *  0.6.78 additions from the persistent discovery cache (additive JSON). */
type ScanDeviceRecord = DiscoveredDeviceRaw & { cached?: boolean; verifiedAt?: number }
let scanDevices: ScanDeviceRecord[] = []
let scanAbort: { aborted: boolean } | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null

// ─── Persistent discovery cache (0.6.78) ─────────────────────────────────────
// The last scan's results are written to ~/.blasti/discovery-cache.json so the
// Device Manager opens with the PREVIOUSLY DISCOVERED devices (typed, named,
// marked STALE) instead of an empty list. Live scan results replace them as
// they stream in; the cache is refreshed (debounced) during the scan.

function discoveryCachePath(): string {
  return process.env.BLASTI_DISCOVERY_CACHE
    ? path.resolve(process.env.BLASTI_DISCOVERY_CACHE)
    : path.join(os.homedir(), '.blasti', 'discovery-cache.json')
}

function loadDiscoveryCache(): ScanDeviceRecord[] {
  try {
    const raw = fs.readFileSync(discoveryCachePath(), 'utf8')
    const parsed = JSON.parse(raw) as { devices?: unknown } | null
    if (!parsed || !Array.isArray(parsed.devices)) return []
    return (parsed.devices as ScanDeviceRecord[])
      .filter((d) => d && typeof d.ip === 'string' && !d.ip.startsWith('local:'))
      .slice(0, 500)
  } catch { return [] }
}

function markCachedDevice(d: ScanDeviceRecord): ScanDeviceRecord {
  return { ...d, status: 'STALE', cached: true, capabilities: Array.isArray(d.capabilities) ? d.capabilities : [] }
}

let discoveryCacheSaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDiscoveryCacheSave(): void {
  if (discoveryCacheSaveTimer) return
  discoveryCacheSaveTimer = setTimeout(() => {
    discoveryCacheSaveTimer = null
    try {
      const file = discoveryCachePath()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = {
        savedAt: new Date().toISOString(),
        devices: scanDevices
          .filter((d) => d && typeof d.ip === 'string' && !d.ip.startsWith('local:'))
          .slice(0, 500),
      }
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload))
      fs.renameSync(`${file}.tmp`, file)
    } catch { /* best-effort — cache must never break a scan */ }
  }, 2000)
}

// Preload the cache so the UI shows previously discovered devices instantly.
scanDevices = loadDiscoveryCache().map(markCachedDevice)

async function runEmbeddedScan() {
  if (scanState.scanning) return

  const scanId = `scan-${Date.now()}`
  const subnets = getLocalSubnets()
  scanState = {
    scanning: true,
    scanId,
    totalIPs: subnets.length * 254,
    scannedIPs: 0,
    currentSubnet: '',
    phase: 'arp',
    devicesFound: 0,
    subnets,
    protocolsUsed: [],
    elapsed: 0,
  }
  // Start from the cached devices (STALE) — live results replace them as the
  // scanner streams each identified device, so the UI never shows an empty
  // list and previously discovered entries keep their type/name while the
  // fresh scan runs. (0.6.78)
  scanDevices = loadDiscoveryCache().map(markCachedDevice)
  scanAbort = { aborted: false }

  const startTime = Date.now()
  scanTimer = setInterval(() => {
    scanState.elapsed = Math.floor((Date.now() - startTime) / 1000)
  }, 1000)

  try {
    await runDiscoveryScan(subnets, {
      isAborted: () => scanAbort?.aborted ?? false,
      onProgress: (p) => {
        scanState.scannedIPs = p.scannedIPs
        scanState.currentSubnet = p.currentSubnet
        scanState.phase = p.phase
        scanState.protocolsUsed = p.protocolsUsed
        scanState.devicesFound = p.devicesFound
      },
      onDevice: (d) => {
        // Replace if exists (same IP), else add
        const idx = scanDevices.findIndex((x) => x.ip === d.ip)
        if (idx >= 0) scanDevices[idx] = d
        else scanDevices.push(d)
        scheduleDiscoveryCacheSave()
      },
    })
    scanState.phase = scanAbort?.aborted ? 'idle' : 'complete'
    // 0.6.88 — device event stream: cloud scan outcome.
    appendDeviceEvent({
      event: scanAbort?.aborted ? 'scan_stopped' : 'scan_completed',
      message: `Embedded discovery scan ${scanAbort?.aborted ? 'stopped' : 'completed'} — ${scanDevices.length} device(s) known`,
      sessionId: scanId,
      data: {
        subnets: subnets.length,
        totalIPs: scanState.totalIPs,
        devicesFound: scanDevices.length,
        elapsedSec: Math.floor((Date.now() - startTime) / 1000),
      },
    })
  } catch (err) {
    scanState.phase = 'error'
    // eslint-disable-next-line no-console
    console.error('[discovery] scan failed:', err)
    // 0.6.88 — device event stream: scan crashed.
    appendDeviceEvent({
      event: 'scan_failed',
      message: `Embedded discovery scan failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`,
      level: 'error',
      sessionId: scanId,
    })
  } finally {
    scanState.scanning = false
    scanState.devicesFound = scanDevices.length
    scanState.elapsed = Math.floor((Date.now() - startTime) / 1000)
    if (scanTimer) {
      clearInterval(scanTimer)
      scanTimer = null
    }
    scheduleDiscoveryCacheSave()
  }
}

function stopEmbeddedScan() {
  if (scanAbort) scanAbort.aborted = true
  if (scanTimer) {
    clearInterval(scanTimer)
    scanTimer = null
  }
  scanState.scanning = false
  scanState.phase = 'idle'
  // 0.6.88 — device event stream: operator stopped the scan.
  appendDeviceEvent({
    event: 'scan_stopped',
    message: `Embedded discovery scan stopped by operator`,
    sessionId: scanState.scanId,
    data: { devicesFound: scanDevices.length },
  })
}

// ─── Response shapers (keep REST contract identical to old proxy) ──────────

function healthResponse() {
  return {
    status: 'ok',
    message: 'Embedded multi-protocol discovery active (ARP + Ping + TCP + mDNS + SSDP + WS-Discovery + HTTP)',
    fallback: 'embedded',
    uptime: process.uptime(),
    version: '2.0.0-embedded',
  }
}

function devicesResponse(category?: string, status?: string) {
  let devices = [...scanDevices]
  if (category) devices = devices.filter((d) => d.category === category.toUpperCase())
  if (status) devices = devices.filter((d) => d.status === status.toUpperCase())
  // 0.6.99 — SIGNAL-BASED whitelist (user requirement): only devices that
  // ANSWERED a discovery signal — BLASTI apps (beacon/mDNS/probe), TVs and
  // printers. Generic phones/PCs/routers/IoT/unknown never reach the manager.
  devices = devices.filter((d) => isSignalBackedDevice(d))
  return {
    devices,
    total: devices.length,
    source: 'embedded',
    scannedAt: scanState.scanId ? new Date().toISOString() : null,
  }
}

/**
 * 0.6.95 — registry merge (the "manager on the phone can never discover
 * active BLASTI apps" report): the embedded scan runs on the machine that
 * ANSWERS the request. On the cloud that is the VPS — it can never see the
 * venue LAN, so a phone manager scanning via the cloud got an empty (or
 * datacenter-only) list. But the cloud DOES know every BLASTI app that
 * registered and heartbeat: AgencyDevice rows. Merge them into the response
 * (as `source:'database'` cards) so the manager sees the agency's phones,
 * tablets, kiosks and desktops regardless of scan mechanics. Network-level
 * discoveries (printers, casts, PCs found by a real LAN scanner) stay
 * untouched; registry entries dedupe against BLASTI entries the scanner
 * already found at the same IP (the scanner card is richer).
 */
async function devicesResponseWithRegistry(
  category: string | undefined,
  status: string | undefined,
  agencyId: string | null | undefined,
) {
  const base = devicesResponse(category, status)
  // 0.6.124 — strip host-side spooler queues from the scan/cache side too
  // (cloud-saved discovery snapshots may pre-date the 0.6.123 filter).
  const scanDeviceStr = (d: ScanDeviceRecord, key: string): string | null => {
    const v = (d as unknown as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  }
  base.devices = base.devices.filter((d) => {
    const nameCandidates = [d.name, scanDeviceStr(d, 'cupsName'), scanDeviceStr(d, 'model'), scanDeviceStr(d, 'httpTitle')]
    return !nameCandidates.some((s) => isVirtualPrinterName(s))
  })
  if (!agencyId) return base
  try {
    const onlineWindow = new Date(Date.now() - 90 * 1000)
    const registryDevices = await db.agencyDevice.findMany({
      where: {
        agencyId,
        status: { not: 'DISABLED' },
        OR: [
          { lastHeartbeatAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
          { status: 'PAIRING' },
        ],
      },
      select: {
        id: true, name: true, nameAr: true, nameFr: true, type: true,
        status: true, connectionType: true, ipAddress: true, port: true,
        deviceFingerprint: true, appVersion: true, lastHeartbeatAt: true,
        statusChangedAt: true, createdAt: true,
      },
      orderBy: { lastHeartbeatAt: 'desc' },
      take: 100,
    })
    const blastiIps = new Set(
      base.devices
        .filter((d) => d.blastiMode || d.category === 'BLASTI')
        .map((d) => d.ip)
        .filter(Boolean),
    )
    const registryCards = registryDevices
      .filter((dev: { ipAddress?: string | null }) => !(dev.ipAddress && blastiIps.has(dev.ipAddress)))
      // 0.6.124 — rows saved BEFORE the virtual-printer guard (a manager
      // could register "Send To OneNote 16" back then) must not resurface as
      // discovery cards; the register route now blocks new ones.
      .filter((dev: { name?: string | null }) => !isVirtualPrinterName(dev.name))
      .map((dev: typeof registryDevices[number]) => {
        const isOnline = !!dev.lastHeartbeatAt && dev.lastHeartbeatAt >= onlineWindow
        const type = ['TV', 'KIOSK', 'DISPLAY', 'PRINTER'].includes(dev.type)
          ? (dev.type === 'PRINTER' ? 'BLASTI_PRINTER' : dev.type === 'KIOSK' ? 'BLASTI_APP' : dev.type)
          : 'BLASTI_APP'
        return {
          id: `registry-${dev.id}`,
          source: 'database' as const,
          category: 'BLASTI' as const,
          type,
          name: dev.name,
          nameAr: dev.nameAr || undefined,
          nameFr: dev.nameFr || undefined,
          ip: dev.ipAddress || '',
          port: dev.port || 0,
          manufacturer: 'BLASTI',
          model: dev.type,
          appVersion: dev.appVersion || undefined,
          fingerprint: dev.deviceFingerprint || undefined,
          capabilities: ['blasti-app'] as string[],
          status: (isOnline && dev.status !== 'OFFLINE' ? 'ONLINE' : 'STALE') as 'ONLINE' | 'STALE',
          lastSeen: dev.lastHeartbeatAt ? dev.lastHeartbeatAt.getTime() : (dev.statusChangedAt?.getTime() ?? Date.now()),
          firstSeen: dev.createdAt?.getTime() ?? Date.now(),
          connectionType: (['LAN', 'WIFI', 'USB', 'UNKNOWN'].includes(dev.connectionType)
            ? dev.connectionType
            : 'UNKNOWN') as 'LAN' | 'WIFI' | 'USB' | 'UNKNOWN',
          registryDeviceId: dev.id,
          registryStatus: dev.status,
        }
      })
    const existingIds = new Set(base.devices.map((d) => d.id))
    // 0.6.100 — CASCADE PERIPHERALS (cloud): the desktops report their USB
    // peripherals (printers) in the lan-topology report (devicesJson
    // kind:'peripheral'). A manager scanning via the CLOUD sees them here as
    // peripheral-report printer cards — the shared printer is discoverable
    // even when the scan cannot touch the venue LAN.
    const peripheralCards: Array<Record<string, unknown>> = []
    try {
      const lanNodes = await db.lanNode.findMany({
        where: { agencyId, lastReportAt: { gte: new Date(Date.now() - 10 * 60 * 1000) } },
        select: { instanceId: true, name: true, ipAddress: true, lanPort: true, devicesJson: true, lastReportAt: true },
        take: 50,
      })
      for (const node of lanNodes) {
        if (!node.ipAddress || !node.devicesJson) continue
        let entries: Array<Record<string, unknown>> = []
        try {
          const parsed = JSON.parse(node.devicesJson)
          if (Array.isArray(parsed)) entries = parsed as Array<Record<string, unknown>>
        } catch { /* corrupt JSON — skip node */ }
        entries.filter((e) => e && e.kind === 'peripheral').slice(0, 12).forEach((p, idx) => {
          const pname = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 100) : ''
          if (!pname) return
          peripheralCards.push({
            id: `peripheral-${node.instanceId}-${idx}`,
            source: 'peripheral-report',
            category: 'LOCAL',
            type: 'PRINTER',
            name: pname,
            ip: node.ipAddress,
            port: 0,
            manufacturer: typeof p.manufacturer === 'string' ? p.manufacturer : undefined,
            model: typeof p.model === 'string' ? p.model : undefined,
            cupsName: typeof p.cupsName === 'string' ? p.cupsName : undefined,
            cupsUri: typeof p.cupsUri === 'string' ? p.cupsUri : undefined,
            usbVendorId: typeof p.usbVendorId === 'string' ? p.usbVendorId : undefined,
            usbProductId: typeof p.usbProductId === 'string' ? p.usbProductId : undefined,
            hostIp: node.ipAddress,
            hostName: node.name,
            hostInstanceId: node.instanceId,
            hostPort: node.lanPort,
            capabilities: ['USB_HOST', 'PERIPHERAL_REPORT', 'SHARED_PRINT'],
            status: 'ONLINE',
            lastSeen: node.lastReportAt.getTime(),
            firstSeen: node.lastReportAt.getTime(),
            connectionType: 'USB',
            confidence: 92,
          })
        })
      }
    } catch { /* lanNode table absent on very old DBs — skip */ }
    const merged = [
      ...base.devices,
      ...registryCards.filter((card: { id: string }) => !existingIds.has(card.id)),
      ...peripheralCards.filter((card) => {
        // Dedupe: same host IP + same printer name already surfaced by a scan.
        return !base.devices.some((d) => d.type === 'PRINTER' && d.ip === (card as { hostIp?: string }).hostIp && d.name === card.name)
      }),
    ]
    return {
      devices: merged,
      total: merged.length,
      source: 'embedded+registry',
      scannedAt: scanState.scanId ? new Date().toISOString() : null,
    }
  } catch (err) {
    console.error('[discovery] registry merge failed:', err)
    return base
  }
}

function scanStartResponse() {
  if (scanState.scanning) {
    return {
      status: 'already_scanning',
      scanId: scanState.scanId,
      totalIPs: scanState.totalIPs,
      subnets: scanState.subnets,
    }
  }
  const subnets = getLocalSubnets()
  runEmbeddedScan().catch(() => { /* scan logs its own errors */ })
  return {
    scanId: scanState.scanId,
    totalIPs: subnets.length * 254,
    subnets,
  }
}

function scanStopResponse() {
  if (!scanState.scanning && !scanAbort?.aborted && scanState.phase === 'idle') {
    return { status: 'not_scanning' }
  }
  stopEmbeddedScan()
  return { status: 'stopped', scanId: scanState.scanId }
}

function scanStatusResponse() {
  return {
    ...scanState,
    devicesFound: scanDevices.length,
  }
}

function protocolsResponse() {
  return {
    protocols: getProtocolAvailability(),
    source: 'embedded',
  }
}

function diagnosticsResponse() {
  const cpus = os.cpus()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const mem = process.memoryUsage()
  return {
    timestamp: new Date().toISOString(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      uptime: process.uptime(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'unknown',
      totalMemoryMB: Math.round(totalMem / 1024 / 1024),
      freeMemoryMB: Math.round(freeMem / 1024 / 1024),
      memoryUsagePercent: Math.round((1 - freeMem / totalMem) * 100),
      networkInterfaces: getNetworkInterfacesDetailed().map((i) => ({ name: i.name, ip: i.ip, mac: i.mac })),
    },
    discovery: {
      mode: 'embedded',
      scanPorts: EMBEDDED_SCAN_PORTS,
      scannedSubnets: getLocalSubnets(),
      devicesFound: scanDevices.length,
      lastScanId: scanState.scanId,
      protocols: getProtocolAvailability(),
    },
    memoryUsage: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    source: 'embedded',
  }
}

// ─── Raw ESC/POS network printing (0.6.78 connect protocol) ─────────────────
// Kiosk / counter ticket printing over the LAN without any OS driver:
// a raw TCP socket to the printer's JetDirect port (default 9100) carrying an
// ESC/POS receipt (header, big ticket number, service lines, optional QR,
// paper cut). Works for every ESC/POS thermal printer — Epson, Xprinter,
// GPrinter, Rongta, HP, Bixolon, … — as long as :9100 is reachable.

/** One detail line of an ESC/POS receipt. */
interface EscposTicketLine {
  text: string
  bold?: boolean
}

interface EscposTicketSpec {
  title?: string
  subtitle?: string
  ticketNumber?: string
  lines?: Array<string | EscposTicketLine>
  qrData?: string
  footer?: string
  /** Characters per line (32 for 58mm printers, 42/48 for 80mm). */
  widthCols?: number
}

/** Build one ESC/POS receipt buffer. All inputs optional; sane defaults. */
function buildEscposTicket({ title, subtitle, ticketNumber, lines = [], qrData, footer, widthCols = 42 }: EscposTicketSpec): Buffer {
  const ESC = 0x1b
  const GS = 0x1d
  const chunks: Buffer[] = []
  const push = (...bytes: number[]) => chunks.push(Buffer.from(bytes))
  const text = (s: unknown) => chunks.push(Buffer.from(String(s == null ? '' : s), 'latin1'))
  const textLine = (s: unknown) => { text(String(s == null ? '' : s).slice(0, widthCols)); push(0x0a) }
  const sep = () => textLine('-'.repeat(Math.max(16, Math.min(48, widthCols))))

  // init — reset styles
  push(ESC, 0x40)
  // codepage CP437-ish; keep latin1 (Arabic receipts should use the OS print path)
  // centered ON
  push(ESC, 0x61, 0x01)
  if (title) {
    // double height+width for the header
    push(GS, 0x21, 0x11)
    textLine(title)
    push(GS, 0x21, 0x00)
  }
  if (subtitle) textLine(subtitle)
  // normal style, center
  push(ESC, 0x61, 0x01)
  sep()
  if (ticketNumber) {
    // 4× tall for the ticket number
    push(GS, 0x21, 0x33)
    textLine(ticketNumber)
    push(GS, 0x21, 0x00)
  }
  sep()
  // left-aligned detail lines
  push(ESC, 0x61, 0x00)
  for (const line of lines) {
    if (line == null) continue
    if (typeof line === 'object' && line.bold) {
      push(ESC, 0x45, 0x01)
      textLine(line.text)
      push(ESC, 0x45, 0x00)
    } else {
      textLine(typeof line === 'string' ? line : line.text)
    }
  }
  // QR (standard ESC/POS GS ( k commands)
  if (qrData) {
    try {
      const data = Buffer.from(String(qrData), 'utf8')
      if (data.length > 0 && data.length < 1024) {
        push(ESC, 0x61, 0x01)
        // function 165: model
        push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)
        // function 167: module size (6)
        push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06)
        // function 169: error correction M
        push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31)
        // function 180: store data
        const pl = (data.length + 3) & 0xff
        const ph = ((data.length + 3) >> 8) & 0xff
        push(GS, 0x28, 0x6b, pl, ph, 0x31, 0x50, 0x30)
        chunks.push(data)
        // function 181: print
        push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30)
      }
    } catch { /* skip QR on any error */ }
  }
  push(ESC, 0x61, 0x01)
  if (footer) textLine(footer)
  // feed + partial cut
  push(0x0a, 0x0a, 0x0a)
  push(GS, 0x56, 0x42, 0x00)
  return Buffer.concat(chunks)
}

type RawPrintResult = { ok: true; bytesSent: number; latencyMs: number } | { ok: false; error: string }

/**
 * Open a raw TCP socket to ip:port and write the payload.
 * Resolves {ok, bytesSent, latencyMs} or {ok:false, error}.
 */
function sendRawToPrinter(ip: string, port: number, payload: Buffer, timeoutMs = 6000): Promise<RawPrintResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const sock = new net.Socket()
    const finish = (result: RawPrintResult) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch { /* already closed */ }
      resolve(result)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => {
      sock.write(payload, (err) => {
        if (err) finish({ ok: false, error: err.message })
        // give the printer a moment to accept the buffer, then close
        setTimeout(() => finish({ ok: true, bytesSent: payload.length, latencyMs: Date.now() - startedAt }), 250)
      })
    })
    sock.once('timeout', () => finish({ ok: false, error: 'timeout' }))
    sock.once('error', (err) => finish({ ok: false, error: err && err.message ? err.message : 'connect failed' }))
    try { sock.connect(port, ip) } catch (err) { finish({ ok: false, error: err instanceof Error ? err.message : 'connect failed' }) }
  })
}

/** Connection profile returned by POST /discovery/connect (0.6.78). */
interface DeviceConnectionProfile {
  reachable: boolean
  latencyMs: number | null
  openPorts: number[]
  type: DeviceType
  name: string
  manufacturer: undefined
  confidence: number
  blasti: BlastiIdentifyResult | null
  connection: {
    ip: string
    port: number
    protocols: {
      rawPrint: boolean
      ipp: boolean
      blastiApi: boolean
      castSamsung: boolean
      castRoku: boolean
      smb: boolean
      rdp: boolean
    }
  }
}

/**
 * Deep-identification probe behind POST /discovery/connect.
 * TCP-connects the device's ports, asks for the BLASTI /api/discover marker,
 * and returns a connection profile the UI can act on.
 */
async function buildConnectionProfile(ip: string, preferredPort?: number): Promise<DeviceConnectionProfile> {
  const portsToTry = preferredPort ? [preferredPort] : [3080, 9100, 80, 8001, 8060, 445, 631, 3389]
  const openPorts: number[] = []
  for (const p of portsToTry.slice(0, 8)) {
    // eslint-disable-next-line no-await-in-loop — bounded (≤8) sequential probes
    if (await tcpProbePort(ip, p, 900)) openPorts.push(p)
  }
  // BLASTI identity (kiosk vs desktop, version, role)
  let blasti: BlastiIdentifyResult | null = null
  const blastiPorts = [...new Set([preferredPort, 3080, 3003, 3000].filter((p): p is number => !!p))]
  for (const p of blastiPorts) {
    // eslint-disable-next-line no-await-in-loop — bounded (≤4) sequential probes
    const found = await blastiIdentifyProbe(ip, p, 1200)
    if (found) { blasti = { ...found, apiPort: p }; break }
  }
  // HTTP title on the first open non-BLASTI port (best-effort name hint)
  let httpTitle: string | undefined
  const httpPort = openPorts.find((p) => p === 80 || p === 8080 || p === 5000) || openPorts[0]
  if (httpPort && !blasti) {
    const probe = await httpProbe(ip, httpPort, { timeoutMs: 1200 })
    if (probe && probe.title) httpTitle = probe.title
  }
  const fp = fingerprintDevice({
    ip,
    port: preferredPort || openPorts[0] || 0,
    httpTitle,
    httpServer: blasti ? 'blasti-local' : undefined,
    tcpServices: openPorts.map((p) => {
      const entry = TCP_SWEEP_PORTS.find((t) => t.port === p)
      return entry ? entry.service : `port-${p}`
    }),
    blastiMode: blasti ? blasti.mode : undefined,
  })
  return {
    reachable: openPorts.length > 0 || !!blasti,
    latencyMs: null,
    openPorts,
    type: fp.type,
    name: blasti ? blasti.name : (fp.name && !fp.name.startsWith('Device @') ? fp.name : (httpTitle || fp.name)),
    manufacturer: undefined,
    confidence: fp.confidence,
    blasti,
    connection: {
      ip,
      port: preferredPort || openPorts[0] || 0,
      protocols: {
        rawPrint: openPorts.includes(9100),
        ipp: openPorts.includes(631),
        blastiApi: !!blasti,
        castSamsung: openPorts.includes(8001),
        castRoku: openPorts.includes(8060),
        smb: openPorts.includes(445),
        rdp: openPorts.includes(3389),
      },
    },
  }
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

// GET /discovery/health — Embedded scanner is always healthy when the API is up
// ─── POST /discovery/probe — Reachability + name probe for one host ─────────
// Restores the discovery-panel "Test" action: TCP-connect (+ optional HTTP
// title probe) against ip:port for a printer/TV. Historic implementation
// pointed at the retired :3010 mini-service and could never succeed.
const probeSchema = z.object({
  ip: z.string().min(1).max(64).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  usbPath: z.string().max(200).optional(),
  timeoutMs: z.coerce.number().int().min(250).max(10_000).optional(),
})

app.post('/discovery/probe', async (c) => {
  try {
    await requireAuth(c)
    const rawBody = await c.req.json().catch(() => ({}))
    const validation = validateBody(probeSchema, rawBody)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const body = validation.data
    const net = await import('node:net')

    // USB (CUPS) targets are local by definition — report them as online.
    if (!body.ip && body.usbPath) {
      return c.json({ success: true, reachable: true, target: body.usbPath, detail: 'USB device — locally attached' })
    }
    if (!body.ip) {
      return c.json({ success: false, reachable: false, error: 'ip or usbPath is required' }, 400)
    }

    const port = body.port || 9100 // raw-printing default
    const timeoutMs = body.timeoutMs || 3000
    const startedAt = Date.now()

    const reachable = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket()
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch { /* already closed */ }
        resolve(ok)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
      socket.connect(port, body.ip!)
    })

    return c.json({
      success: true,
      reachable,
      target: `${body.ip}:${port}`,
      latencyMs: reachable ? Date.now() - startedAt : undefined,
      detail: reachable ? 'TCP connection accepted' : `No response within ${timeoutMs}ms`,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error ?? (error instanceof Error ? error.message : 'Internal server error') }, err.status as any)
  }
})

// ─── POST /discovery/pairing-request-by-identity — pair from a scan card ────
// 0.6.96 — "pairing request buttons on discovery results": a discovered BLASTI
// card (live beacon / scan) carries its self-announced fingerprint; the cloud
// matches (or creates) the device record and sends the PAIRING_REQUEST. The
// waiting kiosk/phone polls /public/device-status (5s) and auto-accepts.
//   fingerprint found + already ours  → auto-connect (mark ONLINE)
//   fingerprint found + other agency → 409
//   fingerprint unknown               → create the orphan, then request
const pairByIdentitySchema = z.object({
  fingerprint: z.string().min(1).max(200).optional(),
  name: z.string().max(100).optional(),
  ip: z.string().max(50).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  deviceType: z.string().max(40).optional(),
})

app.post('/discovery/pairing-request-by-identity', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const rawBody = await c.req.json().catch(() => ({}))
    const validation = validateBody(pairByIdentitySchema, rawBody)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const body = validation.data
    const fingerprint = body.fingerprint || ''
    if (!fingerprint && !body.ip) {
      return c.json({ success: false, error: 'fingerprint or ip required' }, 400)
    }

    let device = fingerprint
      ? await db.agencyDevice.findFirst({ where: { deviceFingerprint: fingerprint } })
      : null
    if (!device && body.ip && fingerprint) {
      device = await db.agencyDevice.findFirst({ where: { ipAddress: body.ip, status: 'PAIRING' } })
    }
    // 0.6.119 — the manager is explicitly pairing this fingerprint, which is
    // consent: lift any deleted-device blocklist so the row can be created.
    if (fingerprint) await clearDeviceTombstone(fingerprint)

    if (device && device.agencyId && device.agencyId !== user.agencyId) {
      return c.json({ success: false, error: 'Device is already paired with another agency' }, 409)
    }

    let created = false
    if (!device) {
      const rawType = String(body.deviceType || '').toUpperCase()
      // 0.6.102 — audit fix: a PHONE card pairs into a PHONE row (the old
      // mapping collapsed phones into APP, rendering them as desktop shells
      // in the registry + device tree).
      const deviceType = rawType === 'TV' ? 'TV' : rawType === 'KIOSK' ? 'KIOSK' : rawType === 'PRINTER' ? 'PRINTER' : rawType === 'PHONE' ? 'PHONE' : 'APP'
      device = await db.agencyDevice.create({
        data: {
          agencyId: null,
          name: body.name || 'BLASTI Device',
          type: deviceType,
          status: 'PAIRING',
          connectionType: 'LAN',
          // 0.6.100 — the manager MINTS the device token: the device adopts it
          // on accept, so the manager store and the device share ONE canonical
          // token (what later authorizes cross-store commands).
          deviceToken: crypto.randomBytes(32).toString('hex'),
          ipAddress: body.ip || null,
          port: body.port || null,
          deviceFingerprint: fingerprint || null,
          lastHeartbeatAt: new Date(),
          statusChangedAt: new Date(),
        },
      })
      created = true
    }

    if (device.agencyId === user.agencyId) {
      // Already ours → auto-connect (it was detected again).
      const now = new Date()
      const wasOffline = device.status !== 'ONLINE'
      const updated = await db.agencyDevice.update({
        where: { id: device.id },
        data: {
          status: 'ONLINE',
          statusChangedAt: now,
          connectedAt: device.connectedAt || now,
          lastHeartbeatAt: now,
          ...(body.ip && device.ipAddress !== body.ip ? { ipAddress: body.ip } : {}),
          ...(body.port && device.port !== body.port ? { port: body.port } : {}),
        },
      })
      emitAgencyDeviceEvent('agency-device:connected', user.agencyId, { deviceId: device.id, deviceName: device.name })
      appendDeviceEvent({
        event: 'connect_success',
        message: `Auto-connected detected device: ${device.name || device.id}`,
        deviceId: device.id,
        deviceName: device.name,
        deviceType: device.type,
        agencyId: user.agencyId,
        userId: user.id,
        username: user.username,
        data: { autoConnected: true, wasOffline },
      })
      return c.json({ success: true, autoConnected: true, wasOffline, device: updated })
    }

    // Orphan (existing or just created) → refresh presence + pairing request.
    const now = new Date()
    await db.agencyDevice.update({
      where: { id: device.id },
      data: {
        status: 'PAIRING',
        lastHeartbeatAt: now,
        ...(body.ip ? { ipAddress: body.ip } : {}),
        ...(body.port ? { port: body.port } : {}),
      },
    })
    const agency = await db.agency.findUnique({
      where: { id: user.agencyId },
      select: { id: true, name: true, nameAr: true, nameFr: true },
    })
    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }
    const command = await db.deviceCommand.create({
      data: {
        deviceId: device.id,
        type: 'PAIRING_REQUEST',
        payload: JSON.stringify({
          agencyId: agency.id,
          agencyName: agency.name,
          agencyNameAr: agency.nameAr,
          agencyNameFr: agency.nameFr,
          sentBy: user.id,
          sentByName: user.fullName || user.username,
          // 0.6.100 — the device adopts this token on accept (canonical id).
          deviceToken: device.deviceToken || undefined,
        }),
        status: 'PENDING',
        ttl: 600,
      },
    })
    emitAgencyDeviceEvent('agency-device:pairing-request', agency.id, {
      deviceId: device.id,
      deviceName: device.name,
      commandId: command.id,
      agencyId: agency.id,
      agencyName: agency.name,
    })
    // 0.6.101 — INSTANT delivery into the waiting device's pre-pairing socket
    // room (scan-result path — same channel as /:id/pairing-request).
    void emitPairingWaitEvent({
      id: command.id,
      deviceId: device.id,
      fingerprint: device.deviceFingerprint || fingerprint || undefined,
      agencyId: agency.id,
      agencyName: agency.name,
      agencyNameAr: agency.nameAr || undefined,
      agencyNameFr: agency.nameFr || undefined,
      sentByName: user.fullName || user.username,
      deviceToken: device.deviceToken || undefined,
      sentAt: command.createdAt instanceof Date ? command.createdAt.toISOString() : String(command.createdAt),
    })
    appendDeviceEvent({
      event: 'pairing_requested',
      message: `Pairing request (scan-result) sent to ${device.name} by ${user.fullName || user.username}`,
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
      agencyId: agency.id,
      userId: user.id,
      username: user.username,
      data: { commandId: command.id, created },
    })
    return c.json({ success: true, created, deviceId: device.id, commandId: command.id, message: `Pairing request sent to ${device.name}` })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /discovery/pairing-state — fingerprint → paired-state lookup ──────
// 0.6.105 — PAIRED-DEVICE BACKSTOP. The desktop reconciles a cloud-accepted
// pairing via the realtime 'agency-device:connected' event, but an event can
// be missed (engine socket down at accept time, relay not joined yet) — and
// then the local PAIRING orphan never settles ("الأجهزة المقترنة غير محفوظة").
// The desktop now ALSO polls this endpoint (throttled) with the fingerprints
// of its local orphans and settles every row the cloud reports as paired.
const pairingStateSchema = z.object({
  fingerprints: z.array(z.string().min(1).max(200)).max(50),
})

app.post('/discovery/pairing-state', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const rawBody = await c.req.json().catch(() => ({}))
    const validation = validateBody(pairingStateSchema, rawBody)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const fingerprints = [...new Set(validation.data.fingerprints)].slice(0, 50)
    if (fingerprints.length === 0) {
      return c.json({ success: true, states: {} })
    }
    // Only rows PAIRED WITH THIS agency are reported — a fingerprint that
    // belongs to another agency (or is still an orphan everywhere) stays
    // absent from the map, so the local orphan keeps waiting normally.
    const rows = await db.agencyDevice.findMany({
      where: { deviceFingerprint: { in: fingerprints }, agencyId: user.agencyId },
      select: { id: true, deviceFingerprint: true, deviceToken: true, status: true, name: true, type: true },
    })
    const states: Record<string, { paired: boolean; deviceToken?: string; status: string; name?: string; type?: string }> = {}
    for (const row of rows) {
      if (!row.deviceFingerprint) continue
      states[row.deviceFingerprint] = {
        paired: row.status === 'ONLINE',
        deviceToken: row.deviceToken || undefined,
        status: row.status,
        name: row.name,
        type: row.type,
      }
    }
    return c.json({ success: true, states })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ── 0.6.100 — CASCADE PERIPHERAL REGISTRATION (cloud) ───────────────────────
// A discovered USB printer attached to ANOTHER branch PC (source
// 'peripheral-report') is registered here as a PRINTER AgencyDevice. The
// printerConfig JSON pins the attachment: hostIp/hostPort is where LAN print
// jobs get forwarded, cupsName/usb ids identify the queue on the host.
app.post('/discovery/register-peripheral', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const printer = (body.printer && typeof body.printer === 'object' ? body.printer : {}) as Record<string, unknown>
    const name = (typeof printer.name === 'string' && printer.name.trim() ? printer.name.trim() : '') ||
      (typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '')
    const hostIp = (typeof body.hostIp === 'string' && body.hostIp.trim() ? body.hostIp.trim() : '') ||
      (typeof printer.hostIp === 'string' && printer.hostIp.trim() ? printer.hostIp.trim() : '')
    if (!name) return c.json({ success: false, error: 'printer.name is required' }, 400)
    if (!hostIp) return c.json({ success: false, error: 'hostIp is required (which PC owns the USB printer?)' }, 400)
    // 0.6.124 — a host-side spooler queue ("Send To OneNote 16", "OneNote for
    // Windows 10", PDF/XPS/fax writers) must never become a REGISTERED
    // printer row in the cloud store. Same rule as the desktop register
    // route (0.6.123 discovery filter + 0.6.124 register guard).
    {
      const cfgName = typeof printer.cupsName === 'string' ? printer.cupsName : ''
      if (isVirtualPrinterName(name) || (cfgName && isVirtualPrinterName(cfgName))) {
        return c.json({ success: false, error: `"${name.slice(0, 80)}" is a virtual/software printer queue, not a physical printer — it cannot be registered` }, 422)
      }
    }
    // 0.6.122 — the compat print port default comes from the PRESET registry
    // (LAN_HTTP_API_PORT, @blasti/core/lan-protocol) — never a bare literal.
    const hostPort = Number(body.hostPort) > 0 ? Math.min(65535, Math.max(1, Math.floor(Number(body.hostPort)))) : LAN_HTTP_API_PORT
    const cupsName = typeof printer.cupsName === 'string' ? printer.cupsName.slice(0, 120) : null
    const usbVendorId = typeof printer.usbVendorId === 'string' ? printer.usbVendorId.slice(0, 20) : null
    const usbProductId = typeof printer.usbProductId === 'string' ? printer.usbProductId.slice(0, 20) : null
    const printerConfig = JSON.stringify({
      attachment: 'USB',
      hostIp,
      hostPort,
      hostInstanceId: typeof body.hostInstanceId === 'string' ? body.hostInstanceId.slice(0, 80) : null,
      hostName: typeof body.hostName === 'string' ? body.hostName.slice(0, 100) : null,
      cupsName,
      cupsUri: typeof printer.cupsUri === 'string' ? printer.cupsUri.slice(0, 200) : null,
      usbVendorId,
      usbProductId,
      registeredFrom: 'cascade-discovery',
      registeredAt: new Date().toISOString(),
    })
    // Idempotent: same host + same printer name updates the same row.
    const existing = await db.agencyDevice.findFirst({
      where: { agencyId: user.agencyId, type: 'PRINTER', connectionType: 'USB', ipAddress: hostIp, name: name.slice(0, 100) },
    })
    let row
    if (existing) {
      row = await db.agencyDevice.update({
        where: { id: existing.id },
        data: { printerConfig, port: hostPort, status: 'ONLINE', statusChangedAt: new Date(), lastHeartbeatAt: new Date() },
      })
    } else {
      row = await db.agencyDevice.create({
        data: {
          agencyId: user.agencyId,
          name: name.slice(0, 100),
          type: 'PRINTER',
          status: 'ONLINE',
          statusChangedAt: new Date(),
          connectionType: 'USB',
          ipAddress: hostIp,
          port: hostPort,
          printerConfig,
          autoDiscovery: true,
          lastHeartbeatAt: new Date(),
        },
      })
    }
    const shaped = await db.agencyDevice.findUnique({ where: { id: row.id }, select: DEVICE_SELECT }).catch(() => row)
    emitAgencyDeviceEvent('agency-device:updated', user.agencyId, { deviceId: row.id, deviceName: row.name, action: 'peripheral-registered' })
    appendDeviceEvent({
      event: 'connect_success',
      message: `USB printer "${row.name}" registered via host ${hostIp}:${hostPort} (cascade discovery)`,
      deviceId: row.id,
      deviceName: row.name,
      deviceType: 'PRINTER',
      agencyId: user.agencyId,
      userId: user.id,
      username: user.username,
      data: { source: 'cascade', hostIp },
    })
    return c.json({ success: true, device: shaped ?? row })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── 0.6.113 — CONNECTION MODE (Device Manager "Local only / Cloud" switch) ──
// Cloud parity with the desktop local API (same contract, same
// SystemSetting key 'device_connection_mode'). The branch desktop is the
// ENFORCER of this mode for discovery/pairing; this cloud copy exists so the
// switch also works and persists when the manager is rendered against the
// cloud API (plain browser) instead of the desktop's local API.
const CONNECTION_MODE_KEY = 'device_connection_mode'

app.get('/connection-mode', async (c) => {
  try {
    await requireAuth(c)
    const row = await db.systemSetting.findUnique({ where: { key: CONNECTION_MODE_KEY } })
    const mode = row && row.value === 'local' ? 'local' : 'cloud'
    return c.json({ success: true, mode, cloudAllowed: mode !== 'local' })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.put('/connection-mode', async (c) => {
  try {
    await requireAuth(c)
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
    const mode = body && body.mode === 'local' ? 'local' : body && body.mode === 'cloud' ? 'cloud' : null
    if (!mode) return c.json({ success: false, error: "mode must be 'local' or 'cloud'" }, 400)
    const existing = await db.systemSetting.findUnique({ where: { key: CONNECTION_MODE_KEY } })
    if (existing) {
      await db.systemSetting.update({ where: { key: CONNECTION_MODE_KEY }, data: { value: mode } })
    } else {
      await db.systemSetting.create({
        data: {
          key: CONNECTION_MODE_KEY,
          value: mode,
          category: 'devices',
          valueType: 'string',
          description: 'Device connection & discovery protocol: "cloud" allows the cloud relay/merge paths, "local" is strict LAN/Wi-Fi device-to-device.',
        },
      })
    }
    return c.json({ success: true, mode, cloudAllowed: mode !== 'local' })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.get('/discovery/health', async (c) => {
  try {
    await requireAuth(c)
    return c.json(healthResponse())
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /discovery/devices — Return currently discovered devices (filtered)
app.get('/discovery/devices', async (c) => {
  try {
    const user = await requireAuth(c)
    const category = c.req.query('category')
    const status = c.req.query('status')
    return c.json(await devicesResponseWithRegistry(category, status, user.agencyId))
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /discovery/scan/start — Kick off an embedded multi-protocol scan
app.post('/discovery/scan/start', async (c) => {
  try {
    await requireAuth(c)
    return c.json(scanStartResponse())
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /discovery/scan/stop — Abort a running scan
app.post('/discovery/scan/stop', async (c) => {
  try {
    await requireAuth(c)
    return c.json(scanStopResponse())
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /discovery/scan/status — Live progress of the current scan
app.get('/discovery/scan/status', async (c) => {
  try {
    await requireAuth(c)
    return c.json(scanStatusResponse())
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /discovery/protocols — Which discovery protocols are active
app.get('/discovery/protocols', async (c) => {
  try {
    await requireAuth(c)
    return c.json(protocolsResponse())
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /discovery/diagnostics — System + discovery diagnostics
app.get('/discovery/diagnostics', async (c) => {
  try {
    await requireAuth(c)
    return c.json(diagnosticsResponse())
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ═══ Connect protocol (0.6.78) ═══════════════════════════════════════
// Deep-identify one discovered device and return its connection profile —
// the ports that are actually open, whether it is a BLASTI instance (and in
// which mode), and which cast/print protocols the UI can offer. Also marks
// the device as verified in the persistent discovery cache.

// POST /discovery/connect — Deep-identify one device + mark it verified
app.post('/discovery/connect', async (c) => {
  try {
    await requireAuth(c)
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>
    // Same validation contract as the desktop CommonJS port: ip required
    // (≤50 chars), port optional 1..65535 (invalid → treated as absent).
    const ip = typeof raw.ip === 'string' && raw.ip.length > 0 && raw.ip.length <= 50 ? raw.ip : null
    if (!ip) return c.json({ success: false, error: 'ip: required string' }, 400)
    const port = raw.port === undefined || raw.port === null
      ? undefined
      : (Number.isInteger(Number(raw.port)) && Number(raw.port) >= 1 && Number(raw.port) <= 65535 ? Number(raw.port) : undefined)
    const startedAt = Date.now()
    const profile = await buildConnectionProfile(ip, port)
    profile.latencyMs = Date.now() - startedAt
    // Mark verified in the in-memory list + refresh the cache entry
    const entry = scanDevices.find((d) => d.ip === ip)
    if (entry) {
      entry.status = 'ONLINE'
      entry.lastSeen = Date.now()
      entry.cached = false
      entry.verifiedAt = Date.now()
      if (profile.type && entry.type !== profile.type) entry.type = profile.type
      if (profile.blasti) {
        entry.blastiMode = profile.blasti.mode
        entry.appVersion = profile.blasti.version || entry.appVersion
        entry.blastiInfo = { ...(entry.blastiInfo || {}), instanceId: profile.blasti.instanceId, master: profile.blasti.master, role: profile.blasti.role }
      }
      scheduleDiscoveryCacheSave()
    }
    return c.json({ success: true, verified: profile.reachable, profile })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error ?? (error instanceof Error ? error.message : 'Connect probe failed') }, err.status as any)
  }
})

// Raw ESC/POS ticket print — accepts EITHER a staff session (manager "print
// test page") OR a kiosk deviceToken in the X-Device-Token header, so a
// kiosk can print its tickets on the agency's LAN printer without any OS
// driver. The printer target: explicit ip:port, else — for a KIOSK device —
// the printer assigned on its own row (printerConfig.defaultPrinterDeviceId,
// 0.6.104), else the agency's saved default printer.
const printAuth: MiddlewareHandler<AgencyDevicesEnv> = async (c, next) => {
  const deviceToken = c.req.header('x-device-token')
  if (deviceToken) {
    try {
      const device = await db.agencyDevice.findUnique({ where: { deviceToken } })
      if (device) {
        c.set('printDevice', device)
        await next()
        return
      }
    } catch { /* fall through to staff auth */ }
  }
  // Staff session path — shape auth failures like every other route here.
  try {
    await requireAuth(c)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
  await next()
}

const discoveryPrintSchema = z.object({
  ip: z.string().max(50).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  // 0.6.100 — target a REGISTERED printer device (cascade peripheral): the
  // API resolves the row; USB-attached ones get a LAN-mode guidance error.
  printerDeviceId: z.string().max(80).optional(),
  test: z.boolean().optional(),
  ticket: z.object({
    agencyName: z.string().max(200).optional(),
    branchName: z.string().max(200).optional(),
    ticketNumber: z.string().max(100).optional(),
    lines: z.array(z.union([
      z.string().max(500),
      z.object({ text: z.string().max(500), bold: z.boolean().optional() }),
    ])).max(200).optional(),
    qrData: z.string().max(1000).optional(),
    footer: z.string().max(200).optional(),
  }).optional(),
})

// 0.6.105 — REALTIME PRINT-JOB RELAY. A kiosk registered against the CLOUD
// prints its receipt through THIS route. A printer attached to a branch PC's
// USB port can never be raw-TCP'd or HTTP-forwarded from the cloud box (the
// host IP is a private LAN address) — the historic answer was a 409
// "USB_PRINTER_NEEDS_LAN", so the kiosk fell back to the browser popup and
// the receipt never reached the thermal printer. The job now travels the
// agency's realtime room ('agency-device:print-job'): every branch PC running
// the active BLASTI desktop app receives it, and the machine that is the
// printer's HOST (instance id / LAN IP match, or the named OS queue exists)
// silently prints it in the background through the OS print service.
/** Staff-session agency id without throwing (kiosk-token callers have none). */
async function safeAuthAgencyId(c: Context): Promise<string | null> {
  try {
    const user = await requireAuth(c)
    return user.agencyId || null
  } catch {
    return null
  }
}

function relayPrintJobToAgencyRoom(
  agencyId: string,
  job: {
    printerDeviceId?: string
    printerName?: string
    cupsName?: string
    hostInstanceId?: string
    hostIp?: string
    hostMatch?: 'host-identity' | 'printer-name'
    ticket?: Record<string, unknown>
    test?: boolean
    kioskDeviceId?: string
    kioskDeviceName?: string
  },
): string {
  const jobId = crypto.randomBytes(12).toString('hex')
  void emitAgencyDeviceEvent('agency-device:print-job', agencyId, {
    jobId,
    ...job,
    agencyId,
    relayedAt: new Date().toISOString(),
  })
  appendDeviceEvent({
    event: 'print_job_relayed',
    message: `Receipt print job relayed to the branch desktop app over realtime (${job.printerName || job.cupsName || 'printer'})`,
    deviceId: job.printerDeviceId,
    deviceType: 'PRINTER',
    agencyId,
    data: { jobId, source: 'cloud-print-relay', kioskDeviceId: job.kioskDeviceId },
  })
  return jobId
}

// POST /discovery/print — Raw ESC/POS ticket print (kiosk token OR staff)
app.post('/discovery/print', printAuth, async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const validation = discoveryPrintSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }
    const printBody = validation.data
    // Kiosk device stashed by the printAuth middleware (kiosk path only).
    const kioskDevice = c.get('printDevice')
    let ip = printBody.ip
    let port = printBody.port

    // 0.6.103 — an explicit loopback target means a USB printer card reached
    // the CLOUD API: the printer hangs off a branch PC's USB port, the cloud
    // can never raw-TCP it. Answer with the actionable LAN-mode error.
    if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') {
      return c.json({
        success: false,
        error: 'USB_PRINTER_NEEDS_LAN — this printer is attached to a branch PC; print via the branch desktop (LAN mode) so the OS print service receives the job',
        target: `${ip}:${port || 9100}`,
      }, 409)
    }

    // 0.6.100 — USB-attached printers (cascade peripherals) cannot be raw-TCP
    // printed from the CLOUD: the printer hangs off a branch PC's USB port.
    // 0.6.105 — instead of failing with USB_PRINTER_NEEDS_LAN, the job is now
    // RELAYED over the agency realtime room to the active BLASTI desktop app
    // on the printer-host machine, which prints it in the background.
    if (printBody.printerDeviceId) {
      try {
        const printerRow = await db.agencyDevice.findUnique({ where: { id: printBody.printerDeviceId } })
        if (printerRow && printerRow.type === 'PRINTER') {
          const cfg = typeof printerRow.printerConfig === 'string'
            ? JSON.parse(printerRow.printerConfig || '{}')
            : (printerRow.printerConfig || {}) as Record<string, unknown>
          if (cfg && cfg.attachment === 'USB') {
            const relayAgencyId = kioskDevice?.agencyId || (await safeAuthAgencyId(c))
            if (!relayAgencyId) {
              return c.json({ success: false, error: 'No agency context for the print relay' }, 403)
            }
            const hostInstanceId = typeof cfg.hostInstanceId === 'string' ? cfg.hostInstanceId
              : (typeof cfg.hostFingerprint === 'string' ? cfg.hostFingerprint : undefined)
            const hostIp = typeof cfg.hostIp === 'string' ? cfg.hostIp : undefined
            const relayJobId = relayPrintJobToAgencyRoom(relayAgencyId, {
              printerDeviceId: printerRow.id,
              printerName: (typeof cfg.cupsName === 'string' && cfg.cupsName)
                || (typeof cfg.osPrinterName === 'string' && cfg.osPrinterName)
                || printerRow.name,
              cupsName: typeof cfg.cupsName === 'string' ? cfg.cupsName : undefined,
              hostInstanceId,
              hostIp,
              hostMatch: (hostInstanceId || hostIp) ? 'host-identity' : 'printer-name',
              ticket: (printBody.ticket || undefined) as Record<string, unknown> | undefined,
              test: printBody.test || undefined,
              kioskDeviceId: kioskDevice?.id,
              kioskDeviceName: kioskDevice?.name,
            })
            return c.json({ success: true, via: 'realtime-relay', jobId: relayJobId })
          }
        }
      } catch { /* fall through to the normal path */ }
    }

    // 0.6.104 — kiosk-assigned default printer (Fault: kiosk must print on the
    // printer registered/attached to its branch, assignable per-kiosk from the
    // device manager). When the authenticated print device is a KIOSK and the
    // request carries NO explicit target (ip/port/printerDeviceId), read the
    // kiosk row's printerConfig JSON key `defaultPrinterDeviceId` — the
    // printer AgencyDevice id chosen in the Device Manager:
    //   • USB-attached printer with a host PC (printerConfig.attachment USB +
    //     hostIp) → forward the job to http://<hostIp>:<hostPort|3080>
    //     /api/agency-devices/host/print-job, authenticated with the printer
    //     row's adopted deviceToken (mirror of the local route's host-forward).
    //   • Network printer (row ipAddress / printerConfig.ip) → raw ESC/POS
    //     target, port from printerConfig.port || 9100 (shared code below).
    //   • Loopback / USB-local printer → realtime relay to the host PC app
    //     (0.6.105 — was a 409; the receipt now prints in the background).
    // No assignment (or a missing/deleted/unusable printer row) → fall back to
    // the agency DefaultPrinter logic below; the success response then carries
    // a `note` so the kiosk UI can surface the degraded path.
    let printNote: string | undefined
    const hasExplicitTarget = !!(ip || port || printBody.printerDeviceId)
    // 0.6.105 — a printing kiosk must be paired (the relay targets its agency
    // room; an unpaired kiosk has no room to receive anything anyway).
    if (kioskDevice && !kioskDevice.agencyId) {
      return c.json({ success: false, error: 'Kiosk is not paired with an agency — pair it first' }, 403)
    }
    if (!hasExplicitTarget && kioskDevice && kioskDevice.type === 'KIOSK') {
      const kioskAgencyId = kioskDevice.agencyId as string
      const kioskCfg = parseJSON(kioskDevice.printerConfig) as Record<string, unknown>
      const assignedId = typeof kioskCfg.defaultPrinterDeviceId === 'string' ? kioskCfg.defaultPrinterDeviceId : ''
      if (assignedId) {
        let assignedUsed = false
        try {
          const printerRow = await db.agencyDevice.findUnique({ where: { id: assignedId } })
          if (printerRow && printerRow.type === 'PRINTER') {
            const pcfg = parseJSON(printerRow.printerConfig) as Record<string, unknown>
            const hostIp = typeof pcfg.hostIp === 'string' ? pcfg.hostIp : ''
            const hostInstanceId = typeof pcfg.hostInstanceId === 'string' ? pcfg.hostInstanceId
              : (typeof pcfg.hostFingerprint === 'string' ? pcfg.hostFingerprint : undefined)
            const relayJob = (extraNote?: string) => {
              const relayJobId = relayPrintJobToAgencyRoom(kioskAgencyId, {
                printerDeviceId: printerRow.id,
                printerName: (typeof pcfg.cupsName === 'string' && pcfg.cupsName)
                  || (typeof pcfg.osPrinterName === 'string' && pcfg.osPrinterName)
                  || printerRow.name,
                cupsName: (typeof pcfg.cupsName === 'string' && pcfg.cupsName) || undefined,
                hostInstanceId,
                hostIp: hostIp || undefined,
                hostMatch: (hostInstanceId || hostIp) ? 'host-identity' : 'printer-name',
                ticket: (printBody.ticket || undefined) as Record<string, unknown> | undefined,
                test: printBody.test || undefined,
                kioskDeviceId: kioskDevice.id,
                kioskDeviceName: kioskDevice.name,
              })
              return c.json({ success: true, via: 'realtime-relay', jobId: relayJobId, ...(extraNote ? { note: extraNote } : {}) })
            }
            if (pcfg.attachment === 'USB' && hostIp) {
              // USB-attached — first try the DIRECT LAN forward to the host
              // PC's print services (works when the host is LAN-reachable
              // from the requester's store); on failure fall back to the
              // realtime relay (0.6.105) instead of a 502 — the active
              // desktop app on the host still prints the receipt in the
              // background.
              //
              // 0.6.122 — PRESET PORT LADDER (user mandate: "pre-set this
              // services ports and channels and communication protocols"):
              // the cloud now dials the host exactly like the desktop's own
              // print-relay sender — the DEDICATED listener :3083 /print-job
              // first, then the compat route :3080
              // /api/agency-devices/host/print-job. Pre-0.6.122 the cloud
              // dialed compat :3080 only, so a host whose firewall allows
              // only the dedicated port (or vice versa) failed the direct
              // leg and degraded to the realtime relay.
              const configuredPort = Number(pcfg.hostPort) > 0 ? Number(pcfg.hostPort) : 0
              // An explicitly configured NON-compat hostPort wins; a stored
              // compat default (:3080 — what register-peripheral presets) or
              // no port at all walks the preset ladder (dedicated :3083 →
              // compat :3080), matching the desktop print-relay sender.
              const targetPorts: number[] = configuredPort > 0 && configuredPort !== LAN_HTTP_API_PORT
                ? [configuredPort]
                : [...PRINT_RELAY_TARGET_PORTS]
              const hostToken = printerRow.deviceToken || ''
              if (!hostToken) {
                // Not paired → the direct path cannot authenticate, but the
                // relay path authenticates via the agency room membership.
                return relayJob('host not paired — job relayed over realtime')
              }
              const perAttemptCtl = () => {
                const ctl = new AbortController()
                const timer = setTimeout(() => ctl.abort(), PRINT_RELAY_ATTEMPT_TIMEOUT_MS)
                return { ctl, clear: () => clearTimeout(timer) }
              }
              try {
                for (const targetPort of targetPorts) {
                  const { ctl, clear } = perAttemptCtl()
                  try {
                    const fwd = await fetch(`http://${hostIp}:${targetPort}${printRelayRequestPath(targetPort)}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` },
                      body: JSON.stringify({
                        printerName: (typeof pcfg.cupsName === 'string' && pcfg.cupsName)
                          || (typeof pcfg.osPrinterName === 'string' && pcfg.osPrinterName)
                          || printerRow.name
                          || undefined,
                        cupsName: (typeof pcfg.cupsName === 'string' && pcfg.cupsName) || undefined,
                        ticket: printBody.ticket || undefined,
                      }),
                      signal: ctl.signal,
                    })
                    const fwdData = await fwd.json().catch(() => null) as { success?: boolean; error?: string } | null
                    if (fwd.ok && fwdData && fwdData.success) {
                      try {
                        appendDeviceEvent({
                          event: 'print_job_done',
                          message: `USB print job forwarded to host ${hostIp}:${targetPort} for ${printerRow.name}`,
                          deviceId: printerRow.id,
                          deviceName: printerRow.name,
                          deviceType: 'PRINTER',
                          agencyId: printerRow.agencyId,
                          data: { source: 'usb-forward', kioskDeviceId: kioskDevice.id },
                        })
                      } catch { /* log only */ }
                      return c.json({ success: true, via: 'host-forward', host: `${hostIp}:${targetPort}` })
                    }
                    // A 4xx the host UNDERSTOOD means its listener is alive —
                    // auth/payload problems will not improve on other ports.
                    if (fwd.status === 400 || fwd.status === 401) {
                      try {
                        appendDeviceEvent({
                          event: 'print_job_failed',
                          message: `USB print job rejected by host ${hostIp}:${targetPort}: ${(fwdData && fwdData.error) || `status ${fwd.status}`}`,
                          deviceId: printerRow.id,
                          deviceName: printerRow.name,
                          deviceType: 'PRINTER',
                          agencyId: printerRow.agencyId,
                          data: { source: 'usb-forward', kioskDeviceId: kioskDevice.id, status: fwd.status },
                        })
                      } catch { /* log only */ }
                      return relayJob('direct host forward rejected the job — relayed over realtime')
                    }
                  } catch { /* port unreachable → next ladder port */ }
                  finally { clear() }
                }
                // 0.6.105 — direct forward failed on every preset port (host
                // offline / LAN split) → realtime relay fallback; the job
                // still reaches the active desktop app through the socket.
                return relayJob('direct host forward failed — job relayed over realtime')
              } finally {
                // Per-attempt timers are cleared in the loop above; nothing
                // shared to clean here (kept for structural symmetry with the
                // pre-0.6.122 guard rails).
              }
            }
            // Raw ESC/POS target for network printers (NOT for USB-local ones:
            // the row's ipAddress then holds the HOST pc address, and a
            // loopback target can never be reached from the cloud box).
            const rawIp = (typeof printerRow.ipAddress === 'string' && printerRow.ipAddress)
              || (typeof pcfg.ip === 'string' && pcfg.ip)
              || ''
            const isUsbLocal = printerRow.connectionType === 'USB'
              || pcfg.attachment === 'USB'
              || rawIp === '127.0.0.1'
              || rawIp === 'localhost'
              || rawIp === '::1'
            if (isUsbLocal) {
              // 0.6.105 — USB printer on a branch PC → realtime relay to the
              // active desktop app on the host (background OS print).
              return relayJob()
            }
            if (rawIp) {
              ip = rawIp
              port = Number(pcfg.port) > 0 ? Number(pcfg.port) : 9100
              assignedUsed = true
            }
          }
        } catch { /* treat as a missing assignment below */ }
        if (!assignedUsed && !ip) {
          printNote = 'assigned printer missing — used agency default'
        }
      }
    }

    // No explicit target → the agency's saved default printer
    if (!ip) {
      let agencyId: string | null = null
      if (kioskDevice) {
        agencyId = kioskDevice.agencyId
      } else {
        const user = await requireAuth(c)
        agencyId = user.agencyId
      }
      if (!agencyId) return c.json({ success: false, error: 'ip required (no default printer context)' }, 400)
      try {
        const def = await db.defaultPrinter.findUnique({ where: { agencyId } })
        if (def && def.ip) {
          // 0.6.103 — a USB-attached default printer (loopback ip, OS queue)
          // can never be raw-TCP printed FROM THE CLOUD: the printer hangs off
          // a branch PC. Answer with the actionable error instead of the
          // cryptic 502 "connect ECONNREFUSED 127.0.0.1:9100".
          const isUsbDefault = def.connectionType === 'USB' || def.ip === '127.0.0.1' || def.ip === 'localhost'
          if (isUsbDefault) {
            // 0.6.105 — USB default printer → realtime relay to the branch
            // desktop apps (was USB_PRINTER_NEEDS_LAN 409). No host identity
            // is pinned on the DefaultPrinter row, so the relay asks for a
            // printer-NAME match: the PC whose OS print service owns that
            // queue prints the receipt in the background.
            const relayJobId = relayPrintJobToAgencyRoom(agencyId, {
              printerName: def.cupsName || def.name,
              cupsName: def.cupsName || undefined,
              hostMatch: 'printer-name',
              ticket: (printBody.ticket || undefined) as Record<string, unknown> | undefined,
              test: printBody.test || undefined,
              kioskDeviceId: kioskDevice?.id,
              kioskDeviceName: kioskDevice?.name,
            })
            return c.json({ success: true, via: 'realtime-relay', jobId: relayJobId })
          }
          ip = def.ip
          port = port || (def.port || 9100)
        }
      } catch { /* fall through */ }
    }
    if (!ip) return c.json({ success: false, error: 'No printer target — save a default printer or pass ip' }, 400)

    // Ticket content: either a structured ticket, or a simple test page
    const isTest = !!printBody.test
    const ticket = printBody.ticket || {}
    const payload = buildEscposTicket({
      title: ticket.agencyName || (isTest ? 'BLASTI' : undefined),
      subtitle: ticket.branchName || (isTest ? 'Printer test page' : undefined),
      ticketNumber: ticket.ticketNumber || (isTest ? 'T-001' : undefined),
      lines: isTest
        ? [
            { text: `Date: ${new Date().toISOString()}`, bold: false },
            { text: `Target: ${ip}:${port || 9100}` },
            'Connection: raw TCP / ESC-POS',
            'If you can read this, the',
            'printer is connected.',
          ]
        : (ticket.lines || []),
      qrData: ticket.qrData,
      footer: ticket.footer || (isTest ? 'BLASTI' : 'Thank you'),
    })
    const result = await sendRawToPrinter(ip, port || 9100, payload, 6000)
    if (!result.ok) {
      return c.json({ success: false, error: result.error || 'Printer unreachable', target: `${ip}:${port || 9100}` }, 502)
    }
    // 0.6.104 — `note` surfaces the degraded path: the kiosk's assigned
    // printer was missing/unusable and the agency default was used instead.
    return c.json({ success: true, bytesSent: result.bytesSent, latencyMs: result.latencyMs, target: `${ip}:${port || 9100}`, ...(printNote ? { note: printNote } : {}) })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error ?? (error instanceof Error ? error.message : 'Print failed') }, err.status as any)
  }
})

// ─── Saved TVs (discovered TVs saved for later operation) ────────────────────

const saveTvSchema = z.object({
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  nameFr: z.string().max(200).optional(),
  ip: z.string().min(1).max(50),
  port: z.number().int().min(0).max(65535).default(0),
  mac: z.string().max(50).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  ssdpLocation: z.string().max(500).optional(),
  mdnsService: z.string().max(200).optional(),
  source: z.string().max(50).default('ssdp'),
})

// POST /discovery/saved-tvs — Save a discovered TV for later operation
app.post('/discovery/saved-tvs', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const body = await c.req.json()
    const validation = saveTvSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }
    const v = validation.data
    // Upsert by (agencyId, ip) — re-saving the same TV updates its metadata
    const tv = await db.savedTv.upsert({
      where: { agencyId_ip: { agencyId: user.agencyId, ip: v.ip } },
      create: { ...v, agencyId: user.agencyId, lastSeenAt: new Date() },
      update: {
        name: v.name, nameAr: v.nameAr, nameFr: v.nameFr,
        port: v.port, mac: v.mac, manufacturer: v.manufacturer, model: v.model,
        ssdpLocation: v.ssdpLocation, mdnsService: v.mdnsService, source: v.source,
        lastSeenAt: new Date(),
      },
    })
    // ── 0.6.119 — "SAVE TV" ALSO REGISTERS THE DEVICE (desktop parity) ──
    // The registered-devices list reads AgencyDevice; without this row the TV
    // never appeared there and the screen-template picker was unreachable.
    try {
      const layoutInput = ['TV_CLASSIC', 'TV_COUNTERS', 'TV_FOCUS', 'TV_MINIMAL', 'QUEUE_BOARD'].includes(String(body.screenLayout || ''))
        ? String(body.screenLayout)
        : null
      const existingDev = await db.agencyDevice.findFirst({
        where: { agencyId: user.agencyId, type: { in: ['TV', 'DISPLAY'] }, ipAddress: v.ip },
        select: { id: true },
      })
      if (existingDev) {
        await db.agencyDevice.update({
          where: { id: existingDev.id },
          data: {
            name: String(v.name || 'BLASTI TV').slice(0, 100),
            ...(v.port > 0 ? { port: v.port } : {}),
            ...(layoutInput ? { screenLayout: layoutInput } : {}),
          },
        })
      } else {
        await db.agencyDevice.create({
          data: {
            agencyId: user.agencyId,
            name: String(v.name || 'BLASTI TV').slice(0, 100),
            type: 'TV',
            status: 'OFFLINE',
            connectionType: 'LAN',
            ipAddress: v.ip,
            ...(v.port > 0 ? { port: v.port } : {}),
            screenLayout: layoutInput || 'TV_CLASSIC',
            autoDiscovery: true,
          },
        })
      }
    } catch { /* display-only — never fail the save */ }
    return c.json({ success: true, savedTv: tv })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /discovery/saved-tvs — List all saved TVs for the agency
app.get('/discovery/saved-tvs', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const tvs = await db.savedTv.findMany({
      where: { agencyId: user.agencyId },
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ success: true, savedTvs: tvs })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /discovery/saved-tvs/:id — Remove a saved TV
app.delete('/discovery/saved-tvs/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const id = c.req.param('id')
    const existing = await db.savedTv.findUnique({ where: { id } })
    if (!existing || existing.agencyId !== user.agencyId) {
      return c.json({ success: false, error: 'Saved TV not found' }, 404)
    }
    await db.savedTv.delete({ where: { id } })
    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Default Printer (per-agency preferred printer) ─────────────────────────

const saveDefaultPrinterSchema = z.object({
  name: z.string().min(1).max(200),
  nameAr: z.string().max(200).optional(),
  nameFr: z.string().max(200).optional(),
  ip: z.string().max(50).optional(),
  port: z.number().int().min(0).max(65535).default(9100),
  mac: z.string().max(50).optional(),
  manufacturer: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  cupsName: z.string().max(200).optional(),
  cupsUri: z.string().max(500).optional(),
  usbVendorId: z.string().max(20).optional(),
  usbProductId: z.string().max(20).optional(),
  connectionType: z.enum(['LAN', 'WIFI', 'USB']).default('LAN'),
  source: z.string().max(50).default('http_probe'),
})

// POST /discovery/default-printer — Set the default printer for the agency
// (kiosks + desktop apps on the same network query this to know which printer
//  to send ticket jobs to)
app.post('/discovery/default-printer', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const body = await c.req.json()
    const validation = saveDefaultPrinterSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.issues }, 400)
    }
    const v = validation.data
    // Upsert by agencyId — only one default printer per agency
    const printer = await db.defaultPrinter.upsert({
      where: { agencyId: user.agencyId },
      create: { ...v, agencyId: user.agencyId, lastSeenAt: new Date() },
      update: {
        name: v.name, nameAr: v.nameAr, nameFr: v.nameFr,
        ip: v.ip, port: v.port, mac: v.mac, manufacturer: v.manufacturer, model: v.model,
        cupsName: v.cupsName, cupsUri: v.cupsUri,
        usbVendorId: v.usbVendorId, usbProductId: v.usbProductId,
        connectionType: v.connectionType, source: v.source,
        lastSeenAt: new Date(),
      },
    })
    return c.json({ success: true, defaultPrinter: printer })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /discovery/default-printer — Get the default printer for the agency
// (public-ish: kiosks + desktop apps query this without agency context)
app.get('/discovery/default-printer', async (c) => {
  try {
    // Allow lookup by agencyId query param (for kiosk/desktop apps) OR by auth
    let agencyId = c.req.query('agencyId')
    if (!agencyId) {
      try {
        const user = await requireAuth(c)
        agencyId = user.agencyId || undefined
      } catch {
        return c.json({ success: false, error: 'agencyId required' }, 400)
      }
    }
    const printer = await db.defaultPrinter.findUnique({ where: { agencyId } })
    return c.json({ success: true, defaultPrinter: printer })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /discovery/default-printer — Clear the default printer
app.delete('/discovery/default-printer', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    await db.defaultPrinter.deleteMany({ where: { agencyId: user.agencyId } })
    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Cast to TV ─────────────────────────────────────────────────────────────

// Task 5-a — the old inline implementation POSTed plain HTTP to Samsung's
// WebSocket endpoint (always failed) and had no DLNA/LG support at all, while
// the real multi-protocol engine in lib/discovery/cast-service.ts was dead
// code. Everything below now routes through that engine, mirroring the
// desktop local-api cast routes (the behavioral reference).

/** Per-attempt timeout — the cast dialog should never wait longer than 8s. */
const CAST_TIMEOUT_MS = 8000

/** Normalize a client-supplied protocol name to a CastProtocol, or null. */
function normalizeCastProtocol(raw: string | undefined): CastProtocol | null {
  const p = (raw || '').toLowerCase()
  if (p === 'dlna') return 'dlna'
  if (p === 'samsung-tizen' || p === 'samsung') return 'samsung-tizen'
  if (p === 'lg-webos' || p === 'lg') return 'lg-webos'
  if (p === 'roku-ecp' || p === 'roku') return 'roku-ecp'
  if (p === 'url') return 'url'
  return null
}

/** Run a single cast protocol with a hard timeout (≤ CAST_TIMEOUT_MS). */
async function castAttempt(target: CastTarget, mediaUrl: string, protocol: CastProtocol, timeoutMs = CAST_TIMEOUT_MS): Promise<CastResult> {
  const run = ((): Promise<CastResult> => {
    switch (protocol) {
      case 'dlna': return castViaDlna(target, mediaUrl)
      case 'samsung-tizen': return castViaSamsungTizen(target, mediaUrl)
      case 'lg-webos': return castViaLgWebOS(target, mediaUrl)
      case 'roku-ecp': return castViaRokuEcp(target, mediaUrl)
      default:
        return Promise.resolve({ success: false, protocol, message: `Unsupported cast protocol: ${protocol}` })
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<CastResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ success: false, protocol, message: `${protocol} cast timed out after ${Math.round(timeoutMs / 1000)}s — TV did not respond.` }),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([run, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Build a CastTarget from request fields, enriched from the agency's saved
 *  TV row (SavedTv carries manufacturer/model/ssdpLocation/mdnsService/port)
 *  when the caller omits discovery metadata. */
async function buildCastTarget(agencyId: string, ip: string, fields: {
  port: number
  manufacturer: string
  model: string
  ssdpLocation: string
  mdnsService: string
  name: string
}): Promise<CastTarget> {
  let { port, manufacturer, model, ssdpLocation, mdnsService, name } = fields
  if (!manufacturer || !ssdpLocation || !mdnsService || !port) {
    try {
      const saved = await db.savedTv.findUnique({ where: { agencyId_ip: { agencyId, ip } } })
      if (saved) {
        manufacturer = manufacturer || saved.manufacturer || ''
        model = model || saved.model || ''
        ssdpLocation = ssdpLocation || saved.ssdpLocation || ''
        mdnsService = mdnsService || saved.mdnsService || ''
        if (!port && saved.port) port = saved.port
        name = name || saved.name || ''
      }
    } catch { /* best-effort enrichment — saved TV lookup is optional */ }
  }
  return { ip, port, manufacturer, model, ssdpLocation, mdnsService, name }
}

// POST /discovery/cast — Cast the BLASTI TV board to a discovered/saved TV.
// Body: { ip, port?, manufacturer?, model?, ssdpLocation?, mdnsService?, name?, protocol? }
//   protocol 'dlna' | 'samsung-tizen' | 'lg-webos' | 'roku' → single real attempt
//   protocol 'auto'/omitted → try in order [dlna, samsung, lg, roku], brand /
//     detected-protocol first when the TV metadata says so (via castToTv +
//     detectCastProtocols, fed by the saved TV row when available)
//   protocol 'url' → unchanged behavior: hand the TV board URL back to the
//     frontend (opened in a new tab / used by Chromecast or HDMI)
// Response shape preserved: { success, message?, tvBoardUrl?, error? }
// (+ castKind/protocol additively, same as the desktop implementation).
app.post('/discovery/cast', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const body = await c.req.json()
    const ip = String(body.ip || '')
    const port = Number(body.port) || 0
    const tvName = String(body.name || 'BLASTI TV')
    const protocol = normalizeCastProtocol(body.protocol ? String(body.protocol) : undefined)

    if (!ip) {
      return c.json({ success: false, error: 'IP required' }, 400)
    }

    // The TV board URL we want to display on the TV.
    // 0.6.74: the manager may send its OWN origin-built URL (mediaUrl) — the
    // browser origin is what the TV on the same LAN can actually reach, while
    // the server-side origin can differ (proxy / gateway deployments).
    const origin = new URL(c.req.url).origin
    let tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
    if (typeof body.mediaUrl === 'string') {
      try {
        const parsed = new URL(body.mediaUrl)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') tvBoardUrl = parsed.toString()
      } catch { /* invalid → keep the origin-built URL */ }
    }

    // ── 0.6.119 — TEMPLATE + REGISTRATION (desktop parity) ──
    // The manager's chosen screen style rides the cast URL, and the cast
    // target is REGISTERED as an AgencyDevice (type TV, keyed by agency + IP)
    // so it appears in the registered list and its template is configurable.
    const layoutRaw = typeof body.screenLayout === 'string' ? body.screenLayout.trim().toUpperCase() : ''
    const TV_LAYOUT_URL_PARAM: Record<string, string> = {
      TV_CLASSIC: 'classic', TV_COUNTERS: 'counters', TV_FOCUS: 'focus', TV_MINIMAL: 'minimal', QUEUE_BOARD: 'board',
    }
    const layoutParam = TV_LAYOUT_URL_PARAM[layoutRaw] || null
    if (layoutParam) {
      try {
        const boardUrl = new URL(tvBoardUrl)
        boardUrl.searchParams.set('layout', layoutParam)
        tvBoardUrl = boardUrl.toString()
      } catch { /* keep the original URL */ }
    }
    try {
      const layoutInput = ['TV_CLASSIC', 'TV_COUNTERS', 'TV_FOCUS', 'TV_MINIMAL', 'QUEUE_BOARD'].includes(layoutRaw) ? layoutRaw : null
      const existingTv = await db.agencyDevice.findFirst({
        where: { agencyId: user.agencyId, type: { in: ['TV', 'DISPLAY'] }, ipAddress: ip },
        select: { id: true },
      })
      if (existingTv) {
        await db.agencyDevice.update({
          where: { id: existingTv.id },
          data: {
            ...(tvName && tvName !== 'BLASTI TV' ? { name: tvName.slice(0, 100) } : {}),
            ...(port > 0 ? { port } : {}),
            ...(layoutInput ? { screenLayout: layoutInput } : {}),
          },
        })
      } else {
        await db.agencyDevice.create({
          data: {
            agencyId: user.agencyId,
            name: (tvName || `TV @ ${ip}`).slice(0, 100),
            type: 'TV',
            status: 'OFFLINE',
            connectionType: 'LAN',
            ipAddress: ip,
            ...(port > 0 ? { port } : {}),
            screenLayout: layoutInput || 'TV_CLASSIC',
            autoDiscovery: true,
          },
        })
      }
    } catch { /* display-only — never block the cast */ }

    // 'url' → unchanged behavior: hand the URL to the frontend (it opens it
    // in a new tab so the user can navigate on the TV or use Chromecast/HDMI).
    if (protocol === 'url') {
      return c.json({
        success: true,
        castKind: 'url',
        tvBoardUrl,
        message: 'Open the TV board URL on the TV or use Chromecast / HDMI',
      })
    }

    const target = await buildCastTarget(user.agencyId, ip, {
      port,
      manufacturer: String(body.manufacturer || ''),
      model: String(body.model || ''),
      ssdpLocation: String(body.ssdpLocation || ''),
      mdnsService: String(body.mdnsService || ''),
      name: tvName,
    })

    // Explicit protocol → one real attempt through the cast engine.
    if (protocol) {
      const result = await castAttempt(target, tvBoardUrl, protocol)
      if (result.success) {
        return c.json({
          success: true,
          protocol: result.protocol,
          castKind: result.protocol,
          tvBoardUrl,
          message: result.message,
        })
      }
      // Clear per-failure error message (cast-service error style, ≤8s).
      return c.json({
        success: false,
        protocol: result.protocol,
        castKind: result.protocol,
        tvBoardUrl,
        message: result.message,
        error: result.message,
      })
    }

    // 'auto'/omitted → castToTv tries the best-matching real protocol first
    // (brand-native when manufacturer/ports say Samsung/LG/Roku, then DLNA),
    // falling back through the list until one succeeds. Raced against the
    // ≤8s ceiling; on total failure we degrade gracefully to the URL fallback
    // the frontend already knows how to handle.
    const man = (target.manufacturer || '').toLowerCase()
    const svc = (target.mdnsService || '').toLowerCase()
    const isSamsung = man.includes('samsung') || svc.includes('samsung') || port === 8001 || port === 9197
    const isLg = man.includes('lg ') || man.includes('lge') || man.includes('webos') || svc.includes('webos') || svc.includes('lg') || port === 3000
    const isRoku = man.includes('roku') || port === 8060
    const preferred: CastProtocol | undefined = isSamsung ? 'samsung-tizen' : isLg ? 'lg-webos' : isRoku ? 'roku-ecp' : undefined

    let autoResult: CastResult | undefined
    try {
      autoResult = await Promise.race([
        castToTv(target, tvBoardUrl, preferred),
        new Promise<CastResult>((resolve) => {
          setTimeout(() => resolve({ success: false, protocol: 'url', message: `Cast timed out after ${Math.round(CAST_TIMEOUT_MS / 1000)}s — TV did not respond to any cast protocol.` }), CAST_TIMEOUT_MS)
        }),
      ])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      autoResult = { success: false, protocol: 'url', message: `Cast failed: ${msg}` }
    }

    if (autoResult?.success && autoResult.protocol !== 'url') {
      return c.json({
        success: true,
        protocol: autoResult.protocol,
        castKind: autoResult.protocol,
        tvBoardUrl,
        message: autoResult.message,
      })
    }

    // Fallback (unchanged shape): return the URL — the frontend opens it in a
    // new tab so the user can navigate to it on the TV's browser, or use
    // Chromecast / HDMI.
    return c.json({
      success: true,
      castKind: 'url',
      tvBoardUrl,
      ssdpLocation: target.ssdpLocation || undefined,
      message: 'Open the TV board URL on the TV or use Chromecast / HDMI',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// Per-protocol cast endpoints the cast dialog calls on desktop (cloud parity —
// Task 5-a). Same request/response contract as apps/desktop/local-api.
app.post('/discovery/cast/dlna', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) return c.json({ success: false, error: 'No agency assigned' }, 403)
    const body = await c.req.json()
    const origin = new URL(c.req.url).origin
    const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
    const target = await buildCastTarget(user.agencyId, String(body.ip || ''), {
      port: Number(body.port) || 0,
      manufacturer: String(body.manufacturer || ''),
      model: String(body.model || ''),
      ssdpLocation: String(body.ssdpLocation || ''),
      mdnsService: String(body.mdnsService || ''),
      name: String(body.name || ''),
    })
    if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
    const result = await castAttempt(target, tvBoardUrl, 'dlna')
    return c.json({ success: result.success, protocol: 'dlna', tvBoardUrl, message: result.message })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, protocol: 'dlna', message: err.error }, err.status as any)
  }
})

app.post('/discovery/cast/samsung', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) return c.json({ success: false, error: 'No agency assigned' }, 403)
    const body = await c.req.json()
    const origin = new URL(c.req.url).origin
    const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
    const target = await buildCastTarget(user.agencyId, String(body.ip || ''), {
      port: Number(body.port) || 8001,
      manufacturer: String(body.manufacturer || ''),
      model: String(body.model || ''),
      ssdpLocation: String(body.ssdpLocation || ''),
      mdnsService: String(body.mdnsService || ''),
      name: String(body.name || ''),
    })
    if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
    const result = await castAttempt(target, tvBoardUrl, 'samsung-tizen')
    return c.json({ success: result.success, protocol: 'samsung-tizen', tvBoardUrl, message: result.message })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, protocol: 'samsung-tizen', message: err.error }, err.status as any)
  }
})

app.post('/discovery/cast/lg', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) return c.json({ success: false, error: 'No agency assigned' }, 403)
    const body = await c.req.json()
    const origin = new URL(c.req.url).origin
    const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
    const target = await buildCastTarget(user.agencyId, String(body.ip || ''), {
      port: Number(body.port) || 3000,
      manufacturer: String(body.manufacturer || ''),
      model: String(body.model || ''),
      ssdpLocation: String(body.ssdpLocation || ''),
      mdnsService: String(body.mdnsService || ''),
      name: String(body.name || ''),
    })
    if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
    const result = await castAttempt(target, tvBoardUrl, 'lg-webos')
    return c.json({ success: result.success, protocol: 'lg-webos', tvBoardUrl, message: result.message })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, protocol: 'lg-webos', message: err.error }, err.status as any)
  }
})

app.post('/discovery/cast/roku', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) return c.json({ success: false, error: 'No agency assigned' }, 403)
    const body = await c.req.json()
    const origin = new URL(c.req.url).origin
    const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
    const target = await buildCastTarget(user.agencyId, String(body.ip || ''), {
      port: Number(body.port) || 8060,
      manufacturer: String(body.manufacturer || ''),
      model: String(body.model || ''),
      ssdpLocation: String(body.ssdpLocation || ''),
      mdnsService: String(body.mdnsService || ''),
      name: String(body.name || ''),
    })
    if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
    const result = await castAttempt(target, tvBoardUrl, 'roku-ecp')
    return c.json({ success: result.success, protocol: 'roku-ecp', tvBoardUrl, message: result.message })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, protocol: 'roku-ecp', message: err.error }, err.status as any)
  }
})

app.post('/discovery/cast/stop', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) return c.json({ success: false, error: 'No agency assigned' }, 403)
    const body = await c.req.json()
    const target: CastTarget = {
      ip: String(body.ip || ''),
      port: Number(body.port) || 0,
      ssdpLocation: String(body.ssdpLocation || ''),
      manufacturer: String(body.manufacturer || ''),
    }
    if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
    const result = await stopDlnaCast(target)
    return c.json({ success: result.success, message: result.message })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, message: err.error }, err.status as any)
  }
})

app.get('/discovery/cast/protocols', async (c) => {
  try {
    await requireAuth(c)
    const target: CastTarget = {
      ip: c.req.query('ip') || '',
      port: Number(c.req.query('port')) || 0,
      manufacturer: c.req.query('manufacturer') || '',
      model: c.req.query('model') || '',
      ssdpLocation: c.req.query('ssdpLocation') || '',
      mdnsService: c.req.query('mdnsService') || '',
    }
    if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
    const protocols = detectCastProtocols(target)
    return c.json({ success: true, protocols })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const agencyDeviceRoutes = app