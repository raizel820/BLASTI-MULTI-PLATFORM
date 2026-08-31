import os from 'node:os'
import { Hono, type Context } from 'hono'
import { db, dbRaw } from '@blasti/db'
import { requireAuth, authErrorResponse, AuthError } from '../lib/auth'
import { z } from 'zod'
import crypto from 'crypto'
import { validateBody, kioskJoinSchema } from '../lib/validations'
import { emitQueueEvent, emitKioskEvent, emitAgencyDeviceEvent } from '../lib/realtime-emit'
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
import {
  runDiscoveryScan,
  getLocalSubnets,
  getNetworkInterfacesDetailed,
  getProtocolAvailability,
  SCAN_PORTS as EMBEDDED_SCAN_PORTS,
  type DiscoveredDeviceRaw,
  type ScanPhase,
} from '../lib/discovery/scanner'

const app = new Hono()

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

const createDeviceSchema = z.object({
  name: z.string().min(1).max(100),
  nameAr: z.string().max(100).optional(),
  nameFr: z.string().max(100).optional(),
  type: z.enum(['TV', 'KIOSK', 'DISPLAY', 'PRINTER', 'APP'], { message: 'Invalid device type' }).default('TV'),
  connectionType: z.enum(['LAN', 'WIFI', 'CABLE', 'MANUAL'], { message: 'Invalid connection type' }).default('LAN'),
  ipAddress: z.string().max(50).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  autoDiscovery: z.boolean().default(true),
  screenLayout: z.enum(['QUEUE_BOARD', 'TICKET_PRINTER', 'SERVICE_SELECTOR', 'CUSTOM'], { message: 'Invalid screen layout' }).default('QUEUE_BOARD'),
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
  screenLayout: z.enum(['QUEUE_BOARD', 'TICKET_PRINTER', 'SERVICE_SELECTOR', 'CUSTOM'], { message: 'Invalid screen layout' }).optional(),
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

async function requireDeviceAuth(c: Context) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const device = await db.agencyDevice.findUnique({
    where: { deviceToken: token },
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
  const result = await db.agencyDevice.updateMany({
    where: { lastHeartbeatAt: { lt: staleThreshold }, status: 'ONLINE', createdAt: { lt: graceThreshold } },
    data: { status: 'OFFLINE', statusChangedAt: new Date() },
  })
  if (result.count > 0) {
    const offlineDevices = await db.agencyDevice.findMany({
      where: { lastHeartbeatAt: { lt: staleThreshold }, status: 'OFFLINE' },
      select: { id: true, agencyId: true, name: true, type: true },
    })
    for (const d of offlineDevices) {
      emitAgencyDeviceEvent('agency-device:updated', d.agencyId, { deviceId: d.id, deviceName: d.name, deviceType: d.type })
    }
  }

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
  deviceType: z.enum(['KIOSK', 'TV', 'DISPLAY', 'PRINTER', 'APP'], { message: 'Invalid device type' }).default('KIOSK'),
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

      // 4. Create new AgencyDevice
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
// (dual auth: deviceToken OR IP rate-limit)

app.post('/public/join-queue', async (c) => {
  let clientIp: string | undefined
  try {
    const device = await requireDeviceAuth(c)
    let deviceId: string | undefined = undefined

    if (device) {
      deviceId = device.id
      console.log(`[DEVICE/PUBLIC/JOIN] Trusted device: ${device.name} (${device.id})`)
    } else {
      clientIp = enforceRateLimit(c, KIOSK_RATE_LIMIT)
    }

    const body = await c.req.json()
    const validation = validateBody(kioskJoinSchema, body)
    if (validation.error) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, serviceId, customerName } = validation.data

    // C1: Cross-Agency Queue Join — ensure authenticated device belongs to this agency
    if (device && agencyId !== device.agencyId) {
      return c.json({ success: false, error: 'Device not authorized for this agency' }, 403)
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
        },
      })

      if (agency.queueSettings.length > 0) {
        await tx.queueSettings.update({ where: { id: agency.queueSettings[0].id }, data: { lastIssuedNumber: nextNumber } })
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
      select: { id: true, displayNumber: true, status: true, calledAt: true, service: { select: { prefix: true, name: true } } },
      orderBy: { calledAt: 'desc' },
      take: 5,
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

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      agency: { id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr, isQueueOpen: agency.isQueueOpen, isPaused },
      currentlyServing: servingReservations.map((r) => ({ id: r.id, ticketNumber: r.displayNumber, serviceId: r.serviceId, serviceName: r.service.name, status: r.status, calledAt: r.calledAt, counterName: r.counter?.name ?? null })),
      serviceStats,
      totalWaiting,
      totalEstimatedWait,
      activeCounters: totalActiveCounters,
      recentCalls: recentCalls.map((r) => ({ id: r.id, ticketNumber: r.displayNumber, status: r.status, calledAt: r.calledAt })),
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
        services: { where: { isActive: true }, select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
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
    const services = agency.services.map((s) => ({ ...s, avgTime: agency.averageServiceTime }))

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

    // Look up device by pairing code (case-insensitive)
    const foundDevice = await db.agencyDevice.findUnique({
      where: { pairingCode: pairingCode.toUpperCase() },
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
      return c.json({ success: false, error: 'Device not found. Check pairing code.' }, 404)
    }

    // Validate deviceToken matches
    if (foundDevice.deviceToken !== deviceToken) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Invalid device token. Contact your agency admin.' }, 401)
    }

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

    // Check if device with same fingerprint already exists
    let existingDevice: any = null
    if (deviceFingerprint) {
      try {
        existingDevice = await db.agencyDevice.findFirst({
          where: { deviceFingerprint, status: 'PAIRING' },
        })
      } catch (e) {
        console.error('[DISCOVER-REGISTER] findFirst error:', e)
      }
    }

    if (existingDevice) {
      // Return existing token
      const token = existingDevice.deviceToken
      if (!token) {
        const newToken = crypto.randomBytes(32).toString('hex')
        await db.agencyDevice.update({
          where: { id: existingDevice.id },
          data: { deviceToken: newToken, connectionType: connectionType || 'LAN', name: effectiveName, type: deviceType },
        })
        if (clientIp) recordSuccessfulRequest(clientIp)
        return c.json({ success: true, device: { id: existingDevice.id, name: effectiveName, type: deviceType, status: 'PAIRING' }, deviceToken: newToken })
      }
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({ success: true, device: { id: existingDevice.id, name: existingDevice.name, type: existingDevice.type, status: existingDevice.status }, deviceToken: token })
    }

    // Create new orphan device
    const deviceToken = crypto.randomBytes(32).toString('hex')
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
      emitAgencyDeviceEvent('device:registered', 'discovery', {
        deviceId: newDevice.id,
        deviceName: newDevice.name,
        deviceType: newDevice.type,
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

    // M3: Rate limit heartbeats to max 1 per 10s per device
    const hbNow = Date.now()
    const lastHeartbeat = heartbeatRateLimits.get(device.id) || 0
    if (hbNow - lastHeartbeat < HEARTBEAT_MIN_INTERVAL) {
      return c.json({ success: false, error: 'Heartbeat too frequent' }, 429)
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

    // C2: Cross-Agency Device Pairing — verify device belongs to same agency
    if (targetDevice.agencyId !== device.agencyId) {
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
    const device = await requireDeviceAuth(c)
    if (!device) {
      return c.json({ success: false, error: 'Device not authenticated' }, 401)
    }

    const body = await c.req.json().catch(() => ({}))
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

    emitAgencyDeviceEvent('agency-device:connected', agencyId, {
      deviceId: device.id,
      deviceName: device.name,
      deviceType: device.type,
    })

    return c.json({
      success: true,
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

    return c.json({ success: true })
  } catch (error: unknown) {
    console.error('[DEVICE/REJECT-PAIRING]', error)
    return c.json({ success: false, error: 'Internal server error' }, 500)
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

    return c.json({ success: true, devices })
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
      select: { id: true, name: true, type: true, status: true, agencyId: true, lastHeartbeatAt: true },
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

    // Check for recent heartbeat (must be within 90 seconds)
    const ninetySecAgo = new Date(Date.now() - 90 * 1000)
    if (!device.lastHeartbeatAt || device.lastHeartbeatAt < ninetySecAgo) {
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

    // Emit realtime event to the device room
    emitAgencyDeviceEvent('agency-device:pairing-request', 'discovery', {
      deviceId: device.id,
      deviceName: device.name,
      commandId: command.id,
      agencyId: agency.id,
      agencyName: agency.name,
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

    // M7: Parse JSON string fields before returning
    const parsedDevices = devices.map(d => ({
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

// ─── POST /scan-network — Proxy to Discovery Service ──────────────────────
// Triggers the embedded multi-protocol LAN discovery scanner (ARP + ping
// sweep + mDNS + SSDP + HTTP probe). Returns immediately with a scanId;
// poll /discovery/scan/status for progress and /discovery/devices for results.

app.post('/scan-network', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    return c.json(scanStartResponse())
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

    // Emit realtime event
    emitAgencyDeviceEvent('agency-device:disconnected', existing.agencyId || 'system', { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type })

    return c.json({ success: true })
  } catch (error: unknown) {
    console.error('[AgencyDevice] DELETE error:', error)
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
    return c.json({ success: false, error: 'Failed to delete device' }, 500)
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

// ─── POST /scan — Proxy to Discovery Service ──────────────────────────────
// Triggers the embedded multi-protocol LAN discovery scanner.
// Poll /discovery/scan/status for progress and /discovery/devices for results.

app.post('/scan', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    return c.json(scanStartResponse())
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

    return c.json({ success: true, pairingCode, deviceToken, regenerated: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /discovery-token ───────────────────────────────────────────────────
// No longer needed — discovery is embedded in the API process, no separate
// service to authenticate against. Kept for backward compatibility with the
// frontend hook that may still call it.
app.get('/discovery-token', async (c) => {
  try {
    await requireAuth(c)
    return c.json({ token: null, mode: 'embedded' })
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
let scanDevices: Array<DiscoveredDeviceRaw> = []
let scanAbort: { aborted: boolean } | null = null
let scanTimer: ReturnType<typeof setInterval> | null = null

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
  scanDevices = []
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
      },
    })
    scanState.phase = scanAbort?.aborted ? 'idle' : 'complete'
  } catch (err) {
    scanState.phase = 'error'
    // eslint-disable-next-line no-console
    console.error('[discovery] scan failed:', err)
  } finally {
    scanState.scanning = false
    scanState.devicesFound = scanDevices.length
    scanState.elapsed = Math.floor((Date.now() - startTime) / 1000)
    if (scanTimer) {
      clearInterval(scanTimer)
      scanTimer = null
    }
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
}

// ─── Response shapers (keep REST contract identical to old proxy) ──────────

function healthResponse() {
  return {
    status: 'ok',
    message: 'Embedded multi-protocol discovery active (ARP + Ping + mDNS + SSDP + HTTP)',
    fallback: 'embedded',
    uptime: process.uptime(),
    version: '2.0.0-embedded',
  }
}

function devicesResponse(category?: string, status?: string) {
  let devices = [...scanDevices]
  if (category) devices = devices.filter((d) => d.category === category.toUpperCase())
  if (status) devices = devices.filter((d) => d.status === status.toUpperCase())
  return {
    devices,
    total: devices.length,
    source: 'embedded',
    scannedAt: scanState.scanId ? new Date().toISOString() : null,
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

// ─── Route Handlers ──────────────────────────────────────────────────────────

// GET /discovery/health — Embedded scanner is always healthy when the API is up
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
    await requireAuth(c)
    const category = c.req.query('category')
    const status = c.req.query('status')
    return c.json(devicesResponse(category, status))
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

// POST /discovery/cast — Cast the BLASTI TV board to a discovered/saved TV.
// Tries, in order:
//   1. If the TV is a Samsung/LG with a known REST cast API and is reachable
//      → send the cast command.
//   2. Otherwise → return the TV board URL so the frontend can open it in a new
//      tab (Smart TV browser) or hand off to Chromecast / HDMI desktop app.
app.post('/discovery/cast', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user.agencyId) {
      return c.json({ success: false, error: 'No agency assigned' }, 403)
    }
    const body = await c.req.json()
    const ip = String(body.ip || '')
    const port = Number(body.port) || 0
    const manufacturer = String(body.manufacturer || '').toLowerCase()
    const ssdpLocation = String(body.ssdpLocation || '')
    const tvName = String(body.name || 'BLASTI TV')

    if (!ip) {
      return c.json({ success: false, error: 'IP required' }, 400)
    }

    // The TV board URL we want to display on the TV
    const origin = new URL(c.req.url).origin
    const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`

    // Build a list of cast targets to try
    const castTargets: Array<{ kind: string; url: string; method?: string; body?: string; headers?: Record<string, string> }> = []

    // 1. Samsung Tizen (port 8001 / 9197) — REST channel sendCustomCommand
    if (manufacturer.includes('samsung') || port === 8001 || port === 9197) {
      const samsungPort = port === 9197 ? 9197 : 8001
      castTargets.push({
        kind: 'samsung-tizen',
        url: `http://${ip}:${samsungPort}/ws/app/WEBAPP`,
        method: 'POST',
        body: JSON.stringify({ method: 'ms.webapp.launch', id: tvBoardUrl, token: '' }),
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2. LG WebOS (port 3000 / 3001) — requires websocket; we can't do that
    //    here in a simple HTTP route, so we just return the URL for the
    //    frontend to open in the TV's browser.

    // 3. Roku (port 8060) — launch the web browser with the URL
    if (manufacturer.includes('roku') || port === 8060) {
      castTargets.push({
        kind: 'roku',
        url: `http://${ip}:8060/launch/11?contentId=${encodeURIComponent(tvBoardUrl)}`,
        method: 'POST',
      })
    }

    // Try each cast target sequentially
    for (const target of castTargets) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3000)
        const res = await fetch(target.url, {
          method: (target.method as any) || 'GET',
          headers: target.headers,
          body: target.body,
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (res.ok || res.status < 500) {
          return c.json({
            success: true,
            castKind: target.kind,
            tvBoardUrl,
            message: `Cast sent to ${target.kind} at ${ip}`,
          })
        }
      } catch {
        // try next target
      }
    }

    // Fallback: return the URL — the frontend will open it in a new tab so the
    // user can navigate to it on the TV's browser, or use Chromecast / HDMI.
    return c.json({
      success: true,
      castKind: 'url',
      tvBoardUrl,
      ssdpLocation,
      message: 'Open the TV board URL on the TV or use Chromecast / HDMI',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const agencyDeviceRoutes = app