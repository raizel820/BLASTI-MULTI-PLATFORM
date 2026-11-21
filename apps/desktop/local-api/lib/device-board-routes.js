// device-board-routes.js — Device-facing endpoints for the desktop local API.
// ─────────────────────────────────────────────────────────────────────────────
// The desktop TV/kiosk screens are the SAME webapp UI as the cloud (loaded
// from the static export). They call /api/agency-devices/public/* and
// /device/* — endpoints that historically existed ONLY on the cloud API.
// On the desktop they 404'd, so the TV window could never load data at all.
//
// This module ports those endpoints against the LOCAL SQLite mirror
// (deviceToken auth, not session auth), making the TV board work fully
// offline / LAN-mode:
//   - POST /api/agency-devices/public/register        (deviceToken create)
//   - GET  /api/agency-devices/public/agency?code=    (resolve agency)
//   - GET  /api/agency-devices/public/queue-status    (TV/kiosk board data)
//   - GET  /api/agency-devices/device/config          (Bearer deviceToken)
//   - POST /api/agency-devices/device/heartbeat       (+ pending commands)
//   - POST /api/agency-devices/device/command/:id/ack
//   - POST /api/agency-devices/discovery/probe        (session auth — the
//     shared discovery panel "Test" button; TCP reachability check)
//
// Kiosk discovery flow (Task 2-b, ported 1:1 from the cloud route file so
// device-kiosk.tsx works UNMODIFIED against the local API):
//   - POST /api/agency-devices/public/discover-register (orphan device)
//   - GET  /api/agency-devices/public/device-status     (poll pairing reqs)
//   - POST /api/agency-devices/public/kiosk-auth        (pairing code login)
//   - POST /api/agency-devices/public/join-queue        (kiosk walk-in ticket)
//   - POST /api/agency-devices/device/accept-pairing    (kiosk approves)
//   - POST /api/agency-devices/device/reject-pairing    (kiosk declines)
//   - POST /api/agency-devices/device/pair              (pairing-code link)
//   - POST /api/agency-devices/device/sync              (offline handshake)
//
// All output/comments in English. No new npm dependencies.

'use strict'

const crypto = require('crypto')
const net = require('node:net')

// ─── Helpers (mirror cloud route) ────────────────────────────────────────────

function parseJSON(str) {
  if (typeof str !== 'string') return str == null ? {} : str
  try { return JSON.parse(str || '{}') } catch { return {} }
}

function generatePairingCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase()
}

function errorMessage(err) {
  return err && err.message ? err.message : 'Internal server error'
}

// Compact local ETA: waiting × avg service time, parallelised across active
// counters. (The cloud adds historical variance — good enough parity for a
// LAN display while staying fully deterministic offline.)
function estimateWaitMinutes(waiting, avgServiceTimeMinutes, activeCounters) {
  if (!waiting || waiting <= 0) return 0
  const avg = avgServiceTimeMinutes && avgServiceTimeMinutes > 0 ? avgServiceTimeMinutes : 5
  const counters = activeCounters && activeCounters > 0 ? activeCounters : 1
  return Math.ceil((waiting * avg) / counters)
}

async function requireDeviceAuth(db, c) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  try {
    return await db.agencyDevice.findUnique({ where: { deviceToken: token } })
  } catch {
    return null
  }
}

// ─── Watchdog-lite: flip stale ONLINE devices OFFLINE (90s, 120s grace) ─────
let lastWatchdogRun = 0
async function runHeartbeatWatchdog(db) {
  const staleThreshold = new Date(Date.now() - 90_000)
  const graceThreshold = new Date(Date.now() - 120_000)
  try {
    await db.agencyDevice.updateMany({
      where: { lastHeartbeatAt: { lt: staleThreshold }, status: 'ONLINE', createdAt: { lt: graceThreshold } },
      data: { status: 'OFFLINE', statusChangedAt: new Date() },
    })
    await db.agencyDevice.updateMany({
      where: { lastHeartbeatAt: { lt: staleThreshold }, status: 'PAIRING', agencyId: null, createdAt: { lt: graceThreshold } },
      data: { status: 'OFFLINE', statusChangedAt: new Date() },
    })
  } catch { /* best-effort */ }
}

// ─── Cloud-parity device response select (never includes deviceToken) ──────
// Mirrors DEVICE_SELECT in apps/api/src/routes/agency-devices.ts — every
// field exists on the local AgencyDevice mirror (apps/desktop/prisma).
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
}

/**
 * HMAC-signed QR import token (cloud parity — kiosk ticket → customer app).
 * Same payload/sig format as apps/api/src/routes/agency-devices.ts so the
 * printed QR scans against either backend.
 */
function generateImportToken(reservationId, agencyId, customerName) {
  const secret = process.env.NEXTAUTH_SECRET || 'blast1-qr-dev-key'
  const exp = Math.floor(Date.now() / 1000) + 30 * 60 // 30 min
  const payload = JSON.stringify({ reservationId, agencyId, customerId: customerName || 'Anonymous', exp })
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return Buffer.from(payload).toString('base64url') + '.' + sig
}

/** Resolve the branch display names for a kiosk join response (cloud parity). */
async function branchNamesForDevice(db, device) {
  let branchName = null
  let branchNameAr = null
  let branchNameFr = null
  if (!device) return { branchName, branchNameAr, branchNameFr }
  let branch = null
  if (device.branchId) {
    branch = await db.branch.findUnique({
      where: { id: device.branchId },
      select: { name: true, nameAr: true, nameFr: true },
    }).catch(() => null)
  }
  if (!branch && device.agencyId) {
    branch = await db.branch.findFirst({
      where: { agencyId: device.agencyId, isActive: true },
      select: { name: true, nameAr: true, nameFr: true },
      orderBy: { createdAt: 'asc' },
    }).catch(() => null)
  }
  if (branch) {
    branchName = branch.name
    branchNameAr = branch.nameAr
    branchNameFr = branch.nameFr
  }
  return { branchName, branchNameAr, branchNameFr }
}

async function expireOldDeliveredCommands(db, deviceId) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000)
  try {
    await db.deviceCommand.updateMany({
      where: { deviceId, status: 'DELIVERED', deliveredAt: { lt: fiveMinAgo } },
      data: { status: 'EXPIRED' },
    })
  } catch { /* table may be empty/absent on very old local DBs */ }
}

// ─── GET /public/queue-status — the TV board's primary data feed ─────────────
async function queueStatusResponse(db, agencyId, deviceId) {
  const agency = await db.agency.findUnique({
    where: { id: agencyId, isActive: true },
    include: {
      services: { where: { isActive: true }, select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
      queueSettings: { select: { isPaused: true, currentServingNumber: true }, take: 1, orderBy: { updatedAt: 'desc' } },
    },
  })
  if (!agency) return { status: 404, body: { success: false, error: 'Agency not found' } }

  const isPaused = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false

  const servingReservations = await db.reservation.findMany({
    where: { agencyId, status: { in: ['CALLED', 'SERVING'] } },
    select: {
      id: true, displayNumber: true, status: true, serviceId: true, calledAt: true,
      service: { select: { id: true, name: true, prefix: true } },
      counter: { select: { id: true, name: true, number: true } },
    },
    orderBy: { calledAt: 'desc' },
  })

  const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
  const totalActiveCounters = await db.counter.count({
    where: { isActive: true, staffId: { not: null }, branch: { agencyId, isActive: true }, updatedAt: { gte: fortyFiveMinsAgo } },
  })

  const serviceStats = await Promise.all(agency.services.map(async (service) => {
    const waiting = await db.reservation.count({ where: { agencyId, serviceId: service.id, status: 'WAITING' } })
    return {
      serviceId: service.id,
      serviceName: service.name,
      serviceNameAr: service.nameAr,
      serviceNameFr: service.nameFr,
      prefix: service.prefix,
      waiting,
      estimatedWait: estimateWaitMinutes(waiting, agency.averageServiceTime, totalActiveCounters),
    }
  }))

  const recentCalls = await db.reservation.findMany({
    where: { agencyId, status: { in: ['CALLED', 'SERVING', 'COMPLETED'] }, calledAt: { not: null } },
    select: {
      id: true, displayNumber: true, status: true, calledAt: true,
      service: { select: { prefix: true, name: true } },
      counter: { select: { name: true } },
    },
    orderBy: { calledAt: 'desc' },
    take: 5,
  })

  const totalWaiting = serviceStats.reduce((sum, s) => sum + s.waiting, 0)
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
  const totalServedToday = await db.reservation.count({
    where: { agencyId, status: 'COMPLETED', completedAt: { gte: startOfToday } },
  })

  // ── Active CLAIMED counters with their current ticket (0.6.74 TV screens,
    // cloud parity with apps/api/src/routes/agency-devices.ts queue-status).
    // Only counters that are active, on a live branch, touched within 45min
    // AND claimed (controlled by a user / mirrored-occupied) are returned.
  let counters = []
  try {
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
    counters = claimedCounters.map((ctr) => ({
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
    }))
  } catch { /* very old local mirrors may lack control columns */ }

  // Average SERVING time today (cloud parity — completedAt − calledAt,
  // outliers >4h excluded, null when nothing completed yet today).
  let avgServiceTimeSec = null
  try {
    const todayServedTimes = await db.reservation.findMany({
      where: { agencyId, status: 'COMPLETED', calledAt: { not: null }, completedAt: { gte: startOfToday } },
      select: { calledAt: true, completedAt: true },
      take: 500,
      orderBy: { completedAt: 'desc' },
    })
    const todayDurations = todayServedTimes
      .filter((r) => r.completedAt && r.calledAt)
      .map((r) => new Date(r.completedAt).getTime() - new Date(r.calledAt).getTime())
      .filter((ms) => ms > 0 && ms < 4 * 3_600_000)
    if (todayDurations.length) {
      avgServiceTimeSec = Math.round(todayDurations.reduce((a, b) => a + b, 0) / todayDurations.length / 1000)
    }
  } catch { /* best-effort */ }

  const nowForAnnouncements = new Date()
  let announcements = []
  try {
    const [agencyAnnouncements, globalAnnouncements] = await Promise.all([
      db.announcement.findMany({
        where: { agencyId, isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: nowForAnnouncements } }] },
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
    announcements = [...agencyAnnouncements, ...globalAnnouncements]
  } catch { /* announcement tables may be absent on very old mirrors */ }

  return {
    status: 200,
    body: {
      success: true,
      agency: {
        id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr,
        logoUrl: agency.logoUrl, isQueueOpen: agency.isQueueOpen, isPaused,
        // 0.6.76 — mirrors the cloud queue-status: TV boards use it to
        // activate the agency's specialized terminology scope.
        category: agency.category || null,
      },
      currentlyServing: servingReservations.map((r) => ({
        id: r.id, ticketNumber: r.displayNumber, serviceId: r.serviceId, serviceName: r.service.name,
        status: r.status, calledAt: r.calledAt, counterName: r.counter ? r.counter.name : null,
      })),
      serviceStats,
      totalWaiting,
      totalServedToday,
      avgServiceTimeSec,
      counters,
      totalEstimatedWait: estimateWaitMinutes(totalWaiting, agency.averageServiceTime, totalActiveCounters),
      activeCounters: totalActiveCounters,
      recentCalls: recentCalls.map((r) => ({
        id: r.id, ticketNumber: r.displayNumber, status: r.status, calledAt: r.calledAt,
        counterName: r.counter ? r.counter.name : null,
      })),
      announcements,
      deviceId: deviceId || null,
    },
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

function registerDeviceBoardRoutes(app, ctx) {
  const {
    getDb, broadcast, authMiddleware, diagLog,
    // Cloud-sync plumbing (join-queue walk-ins reach the cloud via the
    // canonical outbox — same transactional pattern as /api/agency/queue/walk-in).
    withOutboxTransaction, logDeterministicOutcome, checkQueueIssuanceGates,
  } = ctx
  // Defensive fallbacks: never let a missing helper break the kiosk flow.
  const txRunner = withOutboxTransaction || ((work) => getDb().$transaction(work))
  const logOutcome = logDeterministicOutcome || (() => {})

  const log = (...args) => { try { (diagLog || console.log)('[device-board]', ...args) } catch { /* ignore */ } }

  // ═══ POST /public/register — auto-register a device ═══════════════════════
  app.post('/api/agency-devices/public/register', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const body = await c.req.json().catch(() => ({}))
      const agencyCode = body.agencyCode
      if (!agencyCode) return c.json({ success: false, error: 'Agency code is required' }, 400)

      const deviceType = ['KIOSK', 'TV', 'DISPLAY', 'PRINTER', 'APP'].includes(body.deviceType) ? body.deviceType : 'KIOSK'
      const connectionType = ['LAN', 'WIFI', 'CABLE', 'MANUAL'].includes(body.connectionType) ? body.connectionType : 'LAN'
      const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 100) : 'Auto-Kiosk'
      const deviceFingerprint = typeof body.deviceFingerprint === 'string' ? body.deviceFingerprint.slice(0, 200) : null

      // 1. Agency by customCode, fallback to ID (same contract as cloud)
      let agency = await db.agency.findUnique({ where: { customCode: agencyCode, isActive: true } })
      if (!agency) agency = await db.agency.findUnique({ where: { id: agencyCode, isActive: true } })
      if (!agency) return c.json({ success: false, error: 'Agency not found or inactive' }, 404)

      // 2. Existing device with the same fingerprint? re-issue token
      const existingDevice = deviceFingerprint
        ? await db.agencyDevice.findFirst({ where: { agencyId: agency.id, type: deviceType, deviceFingerprint } })
        : null

      if (existingDevice) {
        let token = existingDevice.deviceToken
        if (!token) {
          token = crypto.randomBytes(32).toString('hex')
          await db.agencyDevice.update({
            where: { id: existingDevice.id },
            data: { deviceToken: token, status: 'PAIRING', name: deviceName, connectionType },
          })
        }
        return c.json({
          success: true,
          device: { id: existingDevice.id, name: existingDevice.name, type: existingDevice.type, status: existingDevice.status },
          deviceToken: token,
        })
      }

      // 3. Create new
      const pairingCode = generatePairingCode()
      const deviceToken = crypto.randomBytes(32).toString('hex')
      const screenLayout = deviceType === 'KIOSK' ? 'SERVICE_SELECTOR' : 'QUEUE_BOARD'
      const newDevice = await db.agencyDevice.create({
        data: {
          agencyId: agency.id,
          name: deviceName,
          type: deviceType,
          status: 'PAIRING',
          connectionType,
          pairingCode,
          deviceToken,
          deviceFingerprint: deviceFingerprint || null,
          screenLayout,
          offlineCapable: deviceType === 'KIOSK',
          autoDiscovery: true,
        },
      })

      try {
        broadcast('device:registered', { agencyId: agency.id, deviceId: newDevice.id, deviceName: newDevice.name, deviceType: newDevice.type })
      } catch { /* non-fatal */ }

      return c.json({
        success: true,
        device: { id: newDevice.id, name: newDevice.name, type: newDevice.type, status: newDevice.status },
        deviceToken,
      }, 201)
    } catch (err) {
      log('register failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═══ GET /public/agency?code= — resolve agency by short code ══════════════
  app.get('/api/agency-devices/public/agency', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const code = c.req.query('code')
      if (!code) return c.json({ success: false, error: 'Agency code is required' }, 400)

      const agency = await db.agency.findUnique({
        where: { customCode: code, isActive: true },
        include: {
          services: { where: { isActive: true }, select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
          queueSettings: { select: { id: true, isPaused: true }, take: 1, orderBy: { updatedAt: 'desc' } },
        },
      })
      if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

      const waiting = await db.reservation.count({ where: { agencyId: agency.id, status: 'WAITING' } })
      const currentServing = await db.reservation.findFirst({
        where: { agencyId: agency.id, status: { in: ['CALLED', 'SERVING'] } },
        select: { displayNumber: true },
        orderBy: { calledAt: 'desc' },
      })
      const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
      const activeCounters = await db.counter.count({
        where: { isActive: true, staffId: { not: null }, branch: { agencyId: agency.id, isActive: true }, updatedAt: { gte: fortyFiveMinsAgo } },
      })
      const isPaused = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false

      // Cloud parity: every service carries avgTime, and the envelope carries
      // deviceId (null when the caller has no deviceToken).
      const device = await requireDeviceAuth(db, c)
      const servicesWithAvg = agency.services.map((s) => ({ ...s, avgTime: agency.averageServiceTime }))

      return c.json({
        success: true,
        agency: {
          id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr,
          category: agency.category, logoUrl: agency.logoUrl,
          workingHoursStart: agency.workingHoursStart, workingHoursEnd: agency.workingHoursEnd,
          isQueueOpen: agency.isQueueOpen, isPaused,
        },
        services: servicesWithAvg,
        queueStats: {
          waiting,
          currentServing: currentServing ? currentServing.displayNumber : null,
          estimatedWait: estimateWaitMinutes(waiting, agency.averageServiceTime, activeCounters),
        },
        deviceId: device ? device.id : null,
      })
    } catch (err) {
      log('public/agency failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═══ GET /public/queue-status — TV board primary data feed ════════════════
  app.get('/api/agency-devices/public/queue-status', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      const agencyId = c.req.query('agencyId')
      if (!agencyId) return c.json({ success: false, error: 'Agency ID is required' }, 400)
      const result = await queueStatusResponse(db, agencyId, device ? device.id : undefined)
      return c.json(result.body, result.status)
    } catch (err) {
      log('queue-status failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═══ GET /device/config — display settings for a paired device ════════════
  app.get('/api/agency-devices/device/config', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      const fullDevice = await db.agencyDevice.findUnique({
        where: { id: device.id },
        select: {
          id: true, name: true, type: true, status: true, screenLayout: true,
          displaySettings: true, printerConfig: true, serviceFilter: true,
          agency: { select: { id: true, name: true, nameAr: true, nameFr: true, logoUrl: true, category: true } },
          branch: { select: { id: true, name: true, nameAr: true, nameFr: true, address: true, phone: true } },
        },
      })
      if (!fullDevice) return c.json({ success: false, error: 'Device not found' }, 404)

      return c.json({
        success: true,
        config: {
          displaySettings: parseJSON(fullDevice.displaySettings),
          printerConfig: parseJSON(fullDevice.printerConfig),
          screenLayout: fullDevice.screenLayout,
          serviceFilter: fullDevice.serviceFilter,
          agency: fullDevice.agency,
          branch: fullDevice.branch,
        },
      })
    } catch (err) {
      log('device/config failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═══ POST /device/heartbeat — presence + pending command delivery ═════════
  app.post('/api/agency-devices/device/heartbeat', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      const body = await c.req.json().catch(() => ({}))
      const updateData = { lastHeartbeatAt: new Date() }

      // Cap uptime delta like the cloud (max 24h between beats)
      if (typeof body.appVersion === 'string' && body.appVersion) updateData.appVersion = body.appVersion.slice(0, 32)
      if (typeof body.ipAddress === 'string' && body.ipAddress) updateData.ipAddress = body.ipAddress.slice(0, 64)
      if (device.lastHeartbeatAt) {
        const deltaSec = Math.floor((Date.now() - new Date(device.lastHeartbeatAt).getTime()) / 1000)
        if (deltaSec > 0 && deltaSec < 86400) {
          updateData.totalUptimeSec = (device.totalUptimeSec || 0) + deltaSec
        }
      }

      if (device.status === 'OFFLINE' || device.status === 'PAIRING') {
        if (device.agencyId && device.status !== 'DISABLED') {
          updateData.status = 'ONLINE'
          updateData.statusChangedAt = new Date()
        }
      }

      const updated = await db.agencyDevice.update({
        where: { id: device.id },
        data: updateData,
        select: { id: true, status: true, lastHeartbeatAt: true, totalUptimeSec: true, appVersion: true, ipAddress: true },
      })

      await expireOldDeliveredCommands(db, device.id)

      // Pending commands with TTL filtering (parity with cloud)
      let pendingCommands = []
      try {
        const rows = await db.deviceCommand.findMany({
          where: { deviceId: device.id, status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
        })
        const cmdNow = Date.now()
        pendingCommands = rows.filter((cmd) => cmdNow - new Date(cmd.createdAt).getTime() < (cmd.ttl || 300) * 1000)
        const expiredIds = rows
          .filter((cmd) => cmdNow - new Date(cmd.createdAt).getTime() >= (cmd.ttl || 300) * 1000)
          .map((cmd) => cmd.id)
        if (expiredIds.length > 0) {
          await db.deviceCommand.updateMany({ where: { id: { in: expiredIds } }, data: { status: 'EXPIRED' } })
        }
      } catch { /* DeviceCommand table absent on very old mirrors */ }

      // Watchdog-lite, throttled to 30s
      if (Date.now() - lastWatchdogRun > 30_000) {
        lastWatchdogRun = Date.now()
        runHeartbeatWatchdog(db)
      }

      return c.json({ success: true, device: updated, pendingCommands })
    } catch (err) {
      log('heartbeat failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═══ POST /device/command/:id/ack — device acknowledges a command ═════════
  app.post('/api/agency-devices/device/command/:id/ack', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)
      const commandId = c.req.param('id')
      const body = await c.req.json().catch(() => ({}))
      const cmd = await db.deviceCommand.findUnique({ where: { id: commandId } })
      if (!cmd || cmd.deviceId !== device.id) {
        return c.json({ success: false, error: 'Command not found' }, 404)
      }
      const updated = await db.deviceCommand.update({
        where: { id: commandId },
        data: {
          status: body.status === 'DELIVERED' ? 'DELIVERED' : 'PENDING',
          deliveredAt: new Date(),
        },
      })
      return c.json({ success: true, command: updated })
    } catch (err) {
      log('command ack failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═════════════════════════════════════════════════════════════════════════
  //  KIOSK DISCOVERY FLOW — ported 1:1 from apps/api/src/routes/
  //  agency-devices.ts so device-kiosk.tsx works UNMODIFIED against the
  //  desktop local API (LAN / offline). Request+response shapes match the
  //  cloud exactly; writes go to the local SQLite mirror.
  // ═════════════════════════════════════════════════════════════════════════

  // ─── POST /public/discover-register — "Wait for Discovery" (no agency) ────
  // Creates an ORPHAN device (agencyId: null) in PAIRING status. The agency
  // manager later sends a pairing request (:id/pairing-request in
  // agency-devices.js, already ported) and the kiosk accepts it below.
  app.post('/api/agency-devices/public/discover-register', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const body = await c.req.json().catch(() => ({}))
      const deviceType = ['KIOSK', 'TV', 'DISPLAY', 'PRINTER', 'APP'].includes(body.deviceType) ? body.deviceType : 'KIOSK'
      const connectionType = ['LAN', 'WIFI', 'CABLE', 'MANUAL'].includes(body.connectionType) ? body.connectionType : 'LAN'
      const deviceFingerprint = typeof body.deviceFingerprint === 'string' && body.deviceFingerprint ? body.deviceFingerprint.slice(0, 200) : null
      const effectiveName = typeof body.deviceName === 'string' && body.deviceName.trim()
        ? body.deviceName.trim().slice(0, 100)
        : 'BLASTI Kiosk (Discovering)'

      // Same fingerprint already waiting for discovery? re-issue its token.
      let existingDevice = null
      if (deviceFingerprint) {
        try {
          existingDevice = await db.agencyDevice.findFirst({
            where: { deviceFingerprint, status: 'PAIRING' },
          })
        } catch { /* non-fatal */ }
      }

      if (existingDevice) {
        let token = existingDevice.deviceToken
        if (!token) {
          token = crypto.randomBytes(32).toString('hex')
          await db.agencyDevice.update({
            where: { id: existingDevice.id },
            data: { deviceToken: token, connectionType, name: effectiveName, type: deviceType },
          })
          return c.json({ success: true, device: { id: existingDevice.id, name: effectiveName, type: deviceType, status: 'PAIRING' }, deviceToken: token })
        }
        return c.json({
          success: true,
          device: { id: existingDevice.id, name: existingDevice.name, type: existingDevice.type, status: existingDevice.status },
          deviceToken: token,
        })
      }

      // Create a new orphan device (no agencyId — that's the whole point).
      const deviceToken = crypto.randomBytes(32).toString('hex')
      const newDevice = await db.agencyDevice.create({
        data: {
          name: effectiveName,
          type: deviceType,
          status: 'PAIRING',
          connectionType,
          deviceToken,
          deviceFingerprint,
          screenLayout: deviceType === 'KIOSK' ? 'SERVICE_SELECTOR' : 'QUEUE_BOARD',
          offlineCapable: deviceType === 'KIOSK',
          autoDiscovery: true,
          lastHeartbeatAt: new Date(),
        },
      })

      try {
        broadcast('device:registered', { agencyId: 'discovery', deviceId: newDevice.id, deviceName: newDevice.name, deviceType: newDevice.type })
      } catch { /* non-fatal */ }

      return c.json({
        success: true,
        device: { id: newDevice.id, name: newDevice.name, type: newDevice.type, status: newDevice.status },
        deviceToken,
      }, 201)
    } catch (err) {
      log('discover-register failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── POST /public/pairing-offer — LAN DIRECT pairing delivery (0.6.99) ────
  // THE missing half of "pairing request is not reaching to the kiosk device":
  // a kiosk shell (BLASTI app in kiosk mode on its own PC) polls ITS OWN local
  // API, but the manager's pairing request used to be written ONLY to the
  // MANAGER's store — two databases, zero delivery. The manager's local API
  // now ALSO posts the offer straight to the discovered device's HTTP API
  // (this route), which lands the PAIRING_REQUEST command in the store the
  // kiosk actually polls.
  // 0.6.100 — MANDATORY ACCEPTANCE:
  //   • The command payload now carries the manager-minted deviceToken — the
  //     device ADOPTS it on accept, so the manager store and the device share
  //     ONE token (this is what lets print jobs forward to the host PC later).
  //   • A DESKTOP target (body.deviceType 'desktop'/'pc') that never created a
  //     kiosk orphan gets one here, and ctx.onPairingOffer fires a NATIVE
  //     Accept/Reject dialog on THIS machine — the PC operator must accept
  //     before the pairing completes. Kiosk targets keep the on-screen
  //     Accept/Reject cards (the 0.6.95 auto-accept is REMOVED).
  //   target row match order:
  //     1. deviceFingerprint === body.fingerprint (current builds)
  //     2. newest unpaired PAIRING orphan (legacy beacons without uid)
  //     3. desktop shell → create the orphan on the spot
  // Public (device-surface route, like discover-register) — the offer only
  // CREATES a request; the device still has to accept it. Rate-limited per IP.
  const pairingOfferHits = new Map()
  const PAIRING_OFFER_LIMIT = 12
  const PAIRING_OFFER_WINDOW_MS = 60_000

  app.post('/api/agency-devices/public/pairing-offer', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      // ── Per-IP rate limit (simple, in-memory) ──
      const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
        || c.req.header('x-real-ip')
        || 'lan'
      const now = Date.now()
      const entry = pairingOfferHits.get(clientIp) || { count: 0, windowStart: now }
      if (now - entry.windowStart > PAIRING_OFFER_WINDOW_MS) {
        entry.count = 0
        entry.windowStart = now
      }
      entry.count += 1
      pairingOfferHits.set(clientIp, entry)
      if (entry.count > PAIRING_OFFER_LIMIT) {
        return c.json({ success: false, error: 'Too many pairing offers — slow down' }, 429)
      }

      const body = await c.req.json().catch(() => ({}))
      const fingerprint = typeof body.fingerprint === 'string' && body.fingerprint
        ? body.fingerprint.slice(0, 200)
        : ''
      const agencyName = typeof body.agencyName === 'string' && body.agencyName.trim()
        ? body.agencyName.trim().slice(0, 100)
        : ''
      if (!agencyName) {
        return c.json({ success: false, error: 'agencyName is required' }, 400)
      }

      // ── Find the target device row on THIS machine's store ──
      let device = null
      if (fingerprint) {
        try {
          device = await db.agencyDevice.findFirst({ where: { deviceFingerprint: fingerprint } })
        } catch { /* non-fatal */ }
      }
      if (!device) {
        // Legacy fallback: the newest unpaired orphan heartbeat (≤90s) — the
        // device that is currently WAITING on this machine.
        try {
          const ninetySecAgo = new Date(now - 90 * 1000)
          device = await db.agencyDevice.findFirst({
            where: { agencyId: null, status: 'PAIRING', lastHeartbeatAt: { gte: ninetySecAgo } },
            orderBy: { lastHeartbeatAt: 'desc' },
          })
        } catch { /* non-fatal */ }
      }
      const offerDeviceType = typeof body.deviceType === 'string' ? body.deviceType.toLowerCase() : ''
      const isDesktopTarget = offerDeviceType === 'desktop' || offerDeviceType === 'pc'
      if (!device && isDesktopTarget) {
        // 0.6.100 — DESKTOP SHELL TARGET: a PC running the BLASTI desktop app
        // has no kiosk orphan, so the match above 404s and the pairing request
        // never reached it. Create the shell's row here (the desktop's own
        // fingerprint rides the offer) — then the native dialog asks the
        // operator to accept.
        try {
          device = await db.agencyDevice.create({
            data: {
              name: typeof body.deviceName === 'string' && body.deviceName.trim()
                ? body.deviceName.trim().slice(0, 100)
                : 'BLASTI Desktop',
              type: 'APP',
              status: 'PAIRING',
              connectionType: 'LAN',
              deviceToken: typeof body.deviceToken === 'string' && /^[0-9a-f]{64}$/i.test(body.deviceToken)
                ? body.deviceToken
                : crypto.randomBytes(32).toString('hex'),
              deviceFingerprint: fingerprint || null,
              offlineCapable: true,
              autoDiscovery: true,
              lastHeartbeatAt: new Date(),
            },
          })
        } catch (createErr) {
          log('pairing-offer desktop orphan create failed:', errorMessage(createErr))
        }
      }
      if (!device) {
        return c.json({ success: false, error: 'No waiting device found on this machine' }, 404)
      }
      if (device.agencyId) {
        return c.json({ success: false, error: 'Device is already paired' }, 409)
      }

      // ── Land the PAIRING_REQUEST in the store the kiosk POLLS ──
      // 0.6.100 — the manager's token rides the payload: when the row has no
      // token yet it is adopted NOW (single canonical token across stores);
      // the device also receives it in the device-status payload so it uses
      // the same id after accept.
      const managerToken = typeof body.deviceToken === 'string' && /^[0-9a-f]{64}$/i.test(body.deviceToken)
        ? body.deviceToken
        : null
      if (managerToken && !device.deviceToken) {
        try {
          await db.agencyDevice.update({ where: { id: device.id }, data: { deviceToken: managerToken } })
          device.deviceToken = managerToken
        } catch { /* non-fatal */ }
      }
      const command = await db.deviceCommand.create({
        data: {
          deviceId: device.id,
          type: 'PAIRING_REQUEST',
          payload: JSON.stringify({
            agencyId: typeof body.agencyId === 'string' ? body.agencyId : undefined,
            agencyName,
            agencyNameAr: typeof body.agencyNameAr === 'string' ? body.agencyNameAr : undefined,
            agencyNameFr: typeof body.agencyNameFr === 'string' ? body.agencyNameFr : undefined,
            branchId: typeof body.branchId === 'string' ? body.branchId : undefined,
            branchName: typeof body.branchName === 'string' ? body.branchName : undefined,
            customCode: typeof body.customCode === 'string' ? body.customCode : undefined,
            sentByName: typeof body.sentByName === 'string' ? body.sentByName.slice(0, 100) : undefined,
            deviceToken: managerToken || device.deviceToken || undefined,
            source: 'lan-offer',
          }),
          status: 'PENDING',
          ttl: 600,
        },
      })

      // Refresh the orphan's presence so the unpaired strip stays accurate.
      try {
        await db.agencyDevice.update({
          where: { id: device.id },
          data: {
            lastHeartbeatAt: new Date(),
            ...(body.managerIp ? { ipAddress: String(body.managerIp).slice(0, 50) } : {}),
          },
        })
      } catch { /* non-fatal */ }

      try {
        broadcast('agency-device:pairing-request', {
          agencyId: body.agencyId || undefined,
          deviceId: device.id,
          deviceName: device.name,
          commandId: command.id,
          agencyName,
        })
      } catch { /* non-fatal */ }

      try {
        require('./device-event').deviceEvent(
          'pairing_requested',
          `Pairing offer (LAN direct) delivered to ${device.name || device.id} from ${agencyName}`,
          { deviceId: device.id, deviceName: device.name, deviceType: device.type, agencyName, sessionId: command.id, source: 'lan-offer' },
        )
      } catch { /* never block */ }

      // 0.6.100 — DESKTOP TARGET: pop the native Accept/Reject dialog. The PC
      // operator must accept BEFORE the pairing completes (mandatory
      // acceptance). Kiosk targets keep their on-screen approval cards.
      if (isDesktopTarget && typeof ctx.onPairingOffer === 'function') {
        try {
          ctx.onPairingOffer({
            deviceId: device.id,
            deviceName: device.name,
            commandId: command.id,
            agencyId: typeof body.agencyId === 'string' ? body.agencyId : null,
            branchId: typeof body.branchId === 'string' ? body.branchId : null,
            agencyName,
            sentByName: typeof body.sentByName === 'string' ? body.sentByName : '',
          })
        } catch { /* dialog must never break the offer */ }
      }

      return c.json({
        success: true,
        delivered: true,
        needsApproval: true,
        deviceId: device.id,
        commandId: command.id,
        matchedBy: fingerprint && device.deviceFingerprint === fingerprint ? 'fingerprint' : isDesktopTarget && device.deviceFingerprint === fingerprint ? 'desktop-shell' : 'newest-orphan',
        message: `Pairing offer delivered to ${device.name || 'device'} — the device must accept it`,
      })
    } catch (err) {
      log('pairing-offer failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── GET /public/device-status — poll status + pending pairing requests ───
  app.get('/api/agency-devices/public/device-status', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      // Pending PAIRING_REQUEST commands (sent by the agency manager panel).
      let pairingRequests = []
      try {
        const pending = await db.deviceCommand.findMany({
          where: { deviceId: device.id, type: 'PAIRING_REQUEST', status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: 5,
        })
        pairingRequests = pending.map((cmd) => {
          let payload = {}
          try { payload = JSON.parse(cmd.payload || '{}') } catch { /* corrupt payload */ }
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
      } catch { /* DeviceCommand absent on very old mirrors */ }

      // When paired, return the full agency context (kiosk switches screens).
      let agencyData = null
      if (device.agencyId) {
        const agency = await db.agency.findUnique({
          where: { id: device.agencyId, isActive: true },
          select: {
            id: true, name: true, nameAr: true, nameFr: true, customCode: true,
            isQueueOpen: true, logoUrl: true, category: true,
            workingHoursStart: true, workingHoursEnd: true,
          },
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
            isPaused: queueSettings ? queueSettings.isPaused : false,
            services,
            queueStats: queueSettings
              ? { currentServingNumber: queueSettings.currentServingNumber, lastIssuedNumber: queueSettings.lastIssuedNumber }
              : null,
          }
        }
      }

      return c.json({
        success: true,
        status: device.status,
        agency: agencyData,
        pairingRequests,
      })
    } catch (err) {
      log('device-status failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── Pairing brute-force guard (0.6.74 — cloud parity) ────────────────────
  // Locks a pairing code for 10 minutes after 6 consecutive failed kiosk-auth
  // attempts, on top of any per-IP limiting. In-memory (resets on restart).
  const pairingFailures = new Map()
  const PAIRING_MAX_FAILURES = 6
  const PAIRING_LOCKOUT_MS = 10 * 60 * 1000

  function isPairingCodeLocked(pairingCode) {
    const entry = pairingFailures.get(pairingCode)
    if (!entry) return false
    if (entry.lockedUntil > Date.now()) return true
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= Date.now()) {
      pairingFailures.delete(pairingCode)
    }
    return false
  }

  function recordPairingFailure(pairingCode) {
    const entry = pairingFailures.get(pairingCode) || { count: 0, lockedUntil: 0 }
    entry.count += 1
    if (entry.count >= PAIRING_MAX_FAILURES) {
      entry.lockedUntil = Date.now() + PAIRING_LOCKOUT_MS
    }
    pairingFailures.set(pairingCode, entry)
  }

  function clearPairingFailures(pairingCode) {
    pairingFailures.delete(pairingCode)
  }

  // ─── POST /public/kiosk-auth — login with pairing code + device token ─────
  app.post('/api/agency-devices/public/kiosk-auth', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const body = await c.req.json().catch(() => ({}))
      const pairingCode = typeof body.pairingCode === 'string' ? body.pairingCode.trim().toUpperCase() : ''
      const deviceToken = typeof body.deviceToken === 'string' ? body.deviceToken : ''
      if (!pairingCode || !deviceToken) {
        return c.json({ success: false, error: 'Pairing code and device token are required' }, 400)
      }

      // Brute-force guard (0.6.74): a code with too many recent failures is
      // rejected even for the correct token until the lockout expires.
      if (isPairingCodeLocked(pairingCode)) {
        return c.json({ success: false, error: 'Too many failed attempts for this pairing code. Try again later.' }, 429)
      }

      const foundDevice = await db.agencyDevice.findUnique({
        where: { pairingCode },
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
        recordPairingFailure(pairingCode)
        return c.json({ success: false, error: 'Device not found. Check pairing code.' }, 404)
      }
      if (foundDevice.deviceToken !== deviceToken) {
        recordPairingFailure(pairingCode)
        return c.json({ success: false, error: 'Invalid device token. Contact your agency admin.' }, 401)
      }
      clearPairingFailures(pairingCode)
      if (!foundDevice.agency || !foundDevice.agency.isActive) {
        return c.json({ success: false, error: 'Agency is not active' }, 403)
      }

      // Mark the device ONLINE (parity with the cloud route).
      await db.agencyDevice.update({
        where: { id: foundDevice.id },
        data: {
          status: 'ONLINE',
          statusChangedAt: new Date(),
          lastHeartbeatAt: new Date(),
          connectedAt: foundDevice.connectedAt || new Date(),
        },
      })

      try {
        broadcast('agency-device:connected', {
          agencyId: foundDevice.agencyId, deviceId: foundDevice.id,
          deviceName: foundDevice.name, deviceType: foundDevice.type,
        })
      } catch { /* non-fatal */ }

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
    } catch (err) {
      log('kiosk-auth failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── POST /public/join-queue — kiosk walk-in ticket ───────────────────────
  // Cloud semantics: per-service numbering ("R-001"), QR import token,
  // WAITING reservation + lastIssuedNumber bump — with the local outbox so
  // the cloud learns the walk-in once online. Broadcasts queue events so the
  // desktop dashboard sees the new ticket in realtime.
  app.post('/api/agency-devices/public/join-queue', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)

      const body = await c.req.json().catch(() => ({}))
      const { agencyId, serviceId } = body
      const customerName = typeof body.customerName === 'string' ? body.customerName.slice(0, 100) : undefined
      if (!agencyId || typeof agencyId !== 'string') return c.json({ success: false, error: 'Agency ID is required' }, 400)
      if (!serviceId || typeof serviceId !== 'string') return c.json({ success: false, error: 'Service ID is required' }, 400)

      // C1: a device already bound to a DIFFERENT agency may never join this
      // one. 0.6.95 — orphan auto-bind (mirrors the cloud fix): a freshly
      // discovered kiosk registers with agencyId=null (PAIRING) and joins
      // immediately — bind it to the requested agency instead of 403ing
      // ("Device not authorized for this agency" rendered as a permissions
      // failure on the kiosk and pairing never completed).
      if (device && !device.agencyId) {
        try {
          await db.agencyDevice.update({
            where: { id: device.id },
            data: { agencyId, updatedAt: new Date() },
          })
          device.agencyId = agencyId
        } catch (bindErr) {
          log('orphan auto-bind failed:', errorMessage(bindErr))
        }
      } else if (device && agencyId !== device.agencyId) {
        return c.json({ success: false, error: 'Device not authorized for this agency' }, 403)
      }

      // Open / not paused / not full (shared with the local walk-in route).
      // NOTE: the gate returns null both for "may proceed" and "unknown
      // agency" — the explicit agency lookup below still yields the 404.
      if (checkQueueIssuanceGates) {
        const gate = await checkQueueIssuanceGates(agencyId)
        if (gate) return c.json(gate.body, gate.status)
      }

      const agency = await db.agency.findUnique({
        where: { id: agencyId, isActive: true },
        include: { queueSettings: { take: 1, orderBy: { updatedAt: 'desc' } } },
      })
      if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)
      if (!agency.isQueueOpen) return c.json({ success: false, error: 'Queue is currently closed' }, 400)
      if (agency.queueSettings.length > 0 && agency.queueSettings[0].isPaused) {
        return c.json({ success: false, error: 'Queue is currently paused' }, 400)
      }

      const service = await db.service.findUnique({ where: { id: serviceId } })
      if (!service || service.agencyId !== agencyId || !service.isActive) {
        return c.json({ success: false, error: 'Service not found or inactive' }, 404)
      }

      const activeCount = await db.reservation.count({ where: { agencyId, status: { in: ['WAITING', 'CALLED'] } } })
      if (activeCount >= agency.maxActiveReservations) {
        return c.json({ success: false, error: 'Queue is full' }, 400)
      }

      // Compact local ETA (same helper the TV board uses).
      const waitingCount = await db.reservation.count({ where: { agencyId, serviceId, status: 'WAITING' } })
      const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
      const activeCounters = await db.counter.count({
        where: { isActive: true, staffId: { not: null }, branch: { agencyId, isActive: true }, updatedAt: { gte: fortyFiveMinsAgo } },
      })
      const estimatedWait = estimateWaitMinutes(waitingCount, agency.averageServiceTime, activeCounters)

      // Create the reservation with per-service numbering (cloud parity),
      // atomically with its canonical outbox row.
      const reservation = await txRunner(async (tx) => {
        const lastReservation = await tx.reservation.findFirst({
          where: { serviceId },
          orderBy: { queueNumber: 'desc' },
        })
        const nextNumber = ((lastReservation && lastReservation.queueNumber) || 0) + 1
        const displayNumber = `${service.prefix}-${String(nextNumber).padStart(3, '0')}`

        const created = await tx.reservation.create({
          data: {
            id: crypto.randomBytes(16).toString('hex'),
            agencyId,
            serviceId,
            queueNumber: nextNumber,
            displayNumber,
            status: 'WAITING',
            estimatedWait,
            isWalkIn: true,
            walkInCustomerName: (customerName && customerName.trim()) || 'Anonymous',
            userId: null,
            joinedAt: new Date(),
          },
        })
        // Keep the global issued-number cursor in lockstep (same transaction).
        if (agency.queueSettings.length > 0) {
          await tx.queueSettings.update({
            where: { id: agency.queueSettings[0].id },
            data: { lastIssuedNumber: nextNumber },
          })
        }
        // Awaited (Task 2-b fix): the outbox INSERT must join THIS open
        // transaction — floating it commits the business write first and the
        // INSERT then hits the closed transaction (Prisma P2028).
        await logOutcome('Reservation', created.id, 'create', created, null, { tx })
        return created
      })

      // QR import token so a customer can claim the ticket into their app.
      let importToken = ''
      try {
        importToken = generateImportToken(reservation.id, agencyId, customerName)
        await db.reservation.update({ where: { id: reservation.id }, data: { importToken } })
      } catch (tokenErr) {
        log('import token generation failed (non-fatal):', errorMessage(tokenErr))
      }

      const position = await db.reservation.count({
        where: { agencyId, serviceId, status: 'WAITING', joinedAt: { lte: reservation.joinedAt } },
      })

      // Realtime: desktop dashboard (data.reservation consumer) + kiosk event.
      const queueEventData = {
        agencyId,
        reservation,
        reservationId: reservation.id,
        displayNumber: reservation.displayNumber,
        customerName: (customerName && customerName.trim()) || 'Anonymous',
        serviceId,
        estimatedWait,
        importToken,
      }
      if (device) queueEventData.deviceId = device.id
      try {
        broadcast('queue:walk-in', queueEventData)
        broadcast('kiosk:kiosk:update', {
          agencyId,
          action: 'kiosk-join',
          displayNumber: reservation.displayNumber,
          deviceId: device ? device.id : null,
        })
      } catch { /* non-fatal */ }

      // 0.6.89 — QUEUE event: the kiosk walk-in ticket was created LOCALLY
      // (canonical outbox row → the sync engine replays it; the cloud logs
      // its own copy only when that replay lands).
      // NOTE: this file lives INSIDE lib/ — the sibling module is './queue-event'.
      require('./queue-event').queueEvent(
        'ticket_created_kiosk',
        'Kiosk ticket created: ' + reservation.displayNumber + ' (queued for cloud push)',
        {
          agencyId,
          ticketId: reservation.id,
          ticketNumber: reservation.displayNumber,
          serviceId,
          serviceName: service.name,
          source: 'kiosk',
          status: 'WAITING',
          deviceId: device ? device.id : undefined,
        },
      )

      const branchInfo = await branchNamesForDevice(db, device)

      return c.json({
        success: true,
        reservation: {
          id: reservation.id,
          ticketNumber: reservation.displayNumber,
          position,
          estimatedWaitMinutes: estimatedWait,
          customerName: (customerName && customerName.trim()) || 'Anonymous',
          serviceName: service.name,
          serviceNameAr: service.nameAr,
          serviceNameFr: service.nameFr,
          agencyName: agency.name,
          agencyNameAr: agency.nameAr,
          agencyNameFr: agency.nameFr,
          branchName: branchInfo.branchName,
          branchNameAr: branchInfo.branchNameAr,
          branchNameFr: branchInfo.branchNameFr,
          method: 'WALK_IN',
          joinedAt: reservation.joinedAt,
          importToken,
        },
        deviceId: device ? device.id : null,
      }, 201)
    } catch (err) {
      if (err && err.message === 'FULL') {
        return c.json({ success: false, error: 'Queue is full' }, 400)
      }
      log('join-queue failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── POST /device/accept-pairing — kiosk approves a pairing request ───────
  app.post('/api/agency-devices/device/accept-pairing', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      const body = await c.req.json().catch(() => ({}))
      const { commandId, agencyId, branchId } = body
      if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)

      const agency = await db.agency.findUnique({
        where: { id: agencyId, isActive: true },
        select: {
          id: true, name: true, nameAr: true, nameFr: true, customCode: true,
          isQueueOpen: true, logoUrl: true, category: true,
          workingHoursStart: true, workingHoursEnd: true,
        },
      })
      if (!agency) return c.json({ success: false, error: 'Agency not found or inactive' }, 404)

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

      // Mark the accepted request COMPLETED and every other pending one FAILED.
      if (commandId) {
        await db.deviceCommand.updateMany({
          where: { id: commandId, deviceId: device.id, type: 'PAIRING_REQUEST' },
          data: { status: 'COMPLETED', completedAt: now },
        }).catch(() => { /* DeviceCommand absent on very old mirrors */ })
      }
      await db.deviceCommand.updateMany({
        where: { deviceId: device.id, type: 'PAIRING_REQUEST', status: 'PENDING', id: { not: commandId || '___none___' } },
        data: { status: 'FAILED', error: 'Rejected — another pairing was accepted' },
      }).catch(() => { /* non-fatal */ })

      const services = await db.service.findMany({
        where: { agencyId, isActive: true },
        select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true },
      })
      const queueSettings = await db.queueSettings.findFirst({
        where: { agencyId },
        select: { isPaused: true, currentServingNumber: true, lastIssuedNumber: true },
        orderBy: { updatedAt: 'desc' },
      })

      try {
        broadcast('agency-device:connected', {
          agencyId, deviceId: device.id, deviceName: device.name, deviceType: device.type,
        })
      } catch { /* non-fatal */ }

      return c.json({
        success: true,
        device: updatedDevice,
        agency: { ...agency, isPaused: queueSettings ? queueSettings.isPaused : false },
        services,
      })
    } catch (err) {
      log('accept-pairing failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── POST /device/reject-pairing — kiosk declines a pairing request ───────
  app.post('/api/agency-devices/device/reject-pairing', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      const body = await c.req.json().catch(() => ({}))
      if (!body.commandId) return c.json({ success: false, error: 'commandId is required' }, 400)

      const result = await db.deviceCommand.updateMany({
        where: { id: body.commandId, deviceId: device.id, type: 'PAIRING_REQUEST', status: 'PENDING' },
        data: { status: 'FAILED', error: 'Rejected by kiosk operator' },
      }).catch(() => ({ count: 0 }))

      if (result.count === 0) {
        return c.json({ success: false, error: 'Pairing request not found or already processed' }, 404)
      }
      return c.json({ success: true })
    } catch (err) {
      log('reject-pairing failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── POST /device/pair — link via a pairing code shown on another device ──
  app.post('/api/agency-devices/device/pair', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      const body = await c.req.json().catch(() => ({}))
      const pairingCode = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : ''
      if (!pairingCode) return c.json({ success: false, error: 'Invalid input' }, 400)

      const targetDevice = await db.agencyDevice.findUnique({
        where: { pairingCode },
        include: {
          agency: { select: { id: true, name: true, nameAr: true, nameFr: true, logoUrl: true, category: true } },
          branch: { select: { id: true, name: true, nameAr: true, nameFr: true, address: true, phone: true } },
        },
      })
      if (!targetDevice) return c.json({ success: false, error: 'Invalid pairing code' }, 404)

      // C2: cross-agency protection (cloud parity).
      // 0.6.96 — ORPHAN ADOPTION FIX: an unpaired device (agencyId null) has
      // no agency yet, so strict equality ALWAYS 403'd it with "Pairing code
      // not valid for your agency" — the kiosk-visible error that looked like
      // a missing-permission problem. An orphan may adopt the target's agency.
      if (targetDevice.agencyId && device.agencyId && targetDevice.agencyId !== device.agencyId) {
        return c.json({ success: false, error: 'Pairing code not valid for your agency' }, 403)
      }

      const now = new Date()
      const updatedDevice = await db.agencyDevice.update({
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
      })
      // The pairing code is single-use.
      await db.agencyDevice.update({ where: { id: targetDevice.id }, data: { pairingCode: null } })

      return c.json({
        success: true,
        device: updatedDevice,
        agency: targetDevice.agency,
        branch: targetDevice.branch,
      })
    } catch (err) {
      log('device/pair failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ─── POST /device/sync — offline reconciliation handshake (cloud parity) ──
  app.post('/api/agency-devices/device/sync', async (c) => {
    const db = getDb()
    if (!db) return c.json({ success: false, error: 'Local database not ready' }, 503)
    try {
      const device = await requireDeviceAuth(db, c)
      if (!device) return c.json({ success: false, error: 'Device not authenticated' }, 401)

      const body = await c.req.json().catch(() => ({}))
      if (Array.isArray(body.offlineData) && body.offlineData.length > 0) {
        // Same acknowledgement contract as the cloud (queue reconciliation
        // is not implemented on either side yet).
        return c.json({ success: true, syncedCount: 0, message: 'Offline sync not yet implemented' })
      }

      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const waitingCount = await db.reservation.count({
        where: { agencyId: device.agencyId, status: 'WAITING' },
      }).catch(() => 0)
      // Local status vocabulary: COMPLETED is the served terminal state.
      // NOTE: the local Reservation mirror has NO createdAt column (Task 24
      // established joinedAt as the arrival timestamp) — filtering on
      // createdAt threw a Prisma validation error and silently degraded to 0.
      const servedTodayCount = await db.reservation.count({
        where: { agencyId: device.agencyId, status: { in: ['COMPLETED', 'NO_SHOW', 'CANCELLED'] }, joinedAt: { gte: todayStart } },
      }).catch(() => 0)

      const latestDevice = await db.agencyDevice.findUnique({
        where: { id: device.id },
        select: { updatedAt: true, status: true },
      })

      return c.json({
        success: true,
        syncedCount: 0,
        queueStatus: { waitingCount, servedTodayCount },
        configVersion: latestDevice && latestDevice.updatedAt ? new Date(latestDevice.updatedAt).toISOString() : null,
        deviceStatus: latestDevice ? latestDevice.status : device.status,
      })
    } catch (err) {
      log('device/sync failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═══ POST /discovery/probe — TCP reachability for the panel "Test" button ══
  // Session-authenticated (agency-side action, same as the cloud contract).
  app.post('/api/agency-devices/discovery/probe', authMiddleware, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      if (!body.ip && body.usbPath) {
        return c.json({ success: true, reachable: true, target: body.usbPath, detail: 'USB device — locally attached' })
      }
      if (!body.ip) return c.json({ success: false, reachable: false, error: 'ip or usbPath is required' }, 400)
      const port = Number(body.port) > 0 ? Number(body.port) : 9100
      const timeoutMs = Number(body.timeoutMs) > 0 ? Math.min(Number(body.timeoutMs), 10000) : 3000
      const startedAt = Date.now()

      const reachable = await new Promise((resolve) => {
        const socket = new net.Socket()
        let settled = false
        const finish = (ok) => {
          if (settled) return
          settled = true
          try { socket.destroy() } catch { /* already closed */ }
          resolve(ok)
        }
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => finish(true))
        socket.once('timeout', () => finish(false))
        socket.once('error', () => finish(false))
        socket.connect(port, body.ip)
      })

      return c.json({
        success: true,
        reachable,
        target: body.ip + ':' + port,
        latencyMs: reachable ? Date.now() - startedAt : undefined,
        detail: reachable ? 'TCP connection accepted' : 'No response within ' + timeoutMs + 'ms',
      })
    } catch (err) {
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // ═════════════════════════════════════════════════════════════════════════
  // 0.6.100 — HOST PRINT SERVICE (cascade peripherals / shared printer)
  // ═════════════════════════════════════════════════════════════════════════
  // A USB printer attached to THIS PC is usable by EVERY branch device: any
  // kiosk / PC / manager sends its ticket here (directly or forwarded by the
  // manager's store through POST /discovery/print) and THIS machine — the one
  // with the physical USB link — does the OS printing.
  //
  // Auth: any registered device token (the caller device), the master's LAN
  // token (blan-…), or the local session token — a kiosk paired on another
  // store reaches this endpoint only through its manager's forward, which
  // authenticates with the HOST's adopted token.
  //
  // Strategies (first match wins):
  //   1. escposBase64 + CUPS queue  → raw ESC/POS via `lp -d <queue> -o raw`
  //      (thermal receipts keep their exact formatting: QR + cut).
  //   2. ticket JSON → HTML receipt rendered in a hidden Electron window and
  //      silently printed to the named printer (cross-platform default).
  const hostPrintLimiter = new Map()
  const HOST_PRINT_LIMIT = 30
  const HOST_PRINT_WINDOW_MS = 60_000

  function hostPrintLimiterCheck(ip) {
    const now = Date.now()
    const entry = hostPrintLimiter.get(ip) || { count: 0, windowStart: now }
    if (now - entry.windowStart > HOST_PRINT_WINDOW_MS) { entry.count = 0; entry.windowStart = now }
    entry.count += 1
    hostPrintLimiter.set(ip, entry)
    return entry.count <= HOST_PRINT_LIMIT
  }

  /** Escape a string for HTML receipt rendering. */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  /** 80mm receipt HTML — mirrors the kiosk browser fallback styling. */
  function buildReceiptHtml(ticket) {
    const lines = Array.isArray(ticket.lines) ? ticket.lines.slice(0, 40) : []
    const lineRows = lines.map((l) => {
      const left = typeof l === 'string' ? l : String(l.left || '')
      const right = typeof l === 'object' && l && l.right != null ? String(l.right) : ''
      return `<div class="row"><span>${escHtml(left)}</span><span>${escHtml(right)}</span></div>`
    }).join('')
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page { margin: 4mm; }
      body { font-family: 'Courier New', monospace; width: 72mm; margin: 0; padding: 0; color: #000; }
      .center { text-align: center; }
      .title { font-size: 15px; font-weight: 700; margin: 4px 0 2px; }
      .sub { font-size: 11px; margin: 1px 0; }
      .num { font-size: 42px; font-weight: 700; letter-spacing: 2px; margin: 10px 0 6px; }
      .row { display: flex; justify-content: space-between; font-size: 11px; margin: 1px 0; }
      .sep { border-top: 1px dashed #000; margin: 6px 0; }
      .footer { text-align: center; font-size: 10px; margin-top: 8px; letter-spacing: 3px; }
    </style></head><body>
      <div class="center title">${escHtml(ticket.agencyName || 'BLASTI')}</div>
      ${ticket.branchName ? `<div class="center sub">${escHtml(ticket.branchName)}</div>` : ''}
      <div class="sep"></div>
      ${ticket.serviceName ? `<div class="center sub">${escHtml(ticket.serviceName)}</div>` : ''}
      <div class="center num">${escHtml(ticket.ticketNumber || '—')}</div>
      <div class="sep"></div>
      ${lineRows}
      <div class="sep"></div>
      ${ticket.qrData ? `<div class="center"><img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(ticket.qrData)}" width="120" height="120" alt="QR" /></div>` : ''}
      <div class="footer">${escHtml(ticket.footer || 'BLASTI')}</div>
    </body></html>`
  }

  /** Print HTML via a hidden Electron window (silent, named printer). */
  async function printHtmlSilent(html, deviceName) {
    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, sandbox: true },
    })
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      const printers = await win.webContents.getPrintersAsync().catch(() => [])
      if (Array.isArray(printers) && printers.length === 0) {
        return { ok: false, error: 'No printers available on this system' }
      }
      if (deviceName && Array.isArray(printers) && printers.length > 0 && !printers.some((p) => p.name === deviceName)) {
        return { ok: false, error: `Printer "${deviceName}" not found on this system` }
      }
      return await new Promise((resolve) => {
        win.webContents.print(
          { silent: true, printBackground: true, ...(deviceName ? { deviceName } : {}), margins: { marginType: 'none' } },
          (success, errorType) => resolve(success ? { ok: true } : { ok: false, error: errorType || 'print failed' }),
        )
      })
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    } finally {
      try { win.destroy() } catch { /* already gone */ }
    }
  }

  /** Raw ESC/POS through CUPS (`lp -o raw`) — Linux / macOS hosts. */
  function printEscposRaw(buffer, cupsName) {
    const { spawnSync } = require('child_process')
    const os = require('os')
    const fs = require('fs')
    const path = require('path')
    const tmp = path.join(os.tmpdir(), `blasti-print-${Date.now()}-${Math.floor(Math.random() * 1e6)}.bin`)
    try {
      fs.writeFileSync(tmp, buffer)
      const res = spawnSync('lp', ['-d', String(cupsName).slice(0, 120), '-o', 'raw', tmp], { timeout: 15_000 })
      if (res.status === 0) return { ok: true, via: 'cups-raw' }
      return { ok: false, error: (res.stderr && res.stderr.toString().slice(0, 200)) || 'lp failed' }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    }
  }

  // GET /api/agency-devices/host/printers — the OS printers of THIS machine
  // (the manager uses it to pick a target for a USB-attached printer).
  app.get('/api/agency-devices/host/printers', async (c) => {
    const token = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-Device-Token') || ''
    const isLocalCaller = !!(ctx.sessionToken && token && token === ctx.sessionToken)
    const db = getDb()
    let isDeviceCaller = false
    if (db && token) {
      try { isDeviceCaller = !!(await db.agencyDevice.findFirst({ where: { deviceToken: token } })) } catch { /* not a device */ }
    }
    if (!isDeviceCaller) {
      try { isDeviceCaller = !!require('./lib/lan-authority').verifyDeviceToken(token) } catch { /* not a lan token */ }
    }
    if (!isLocalCaller && !isDeviceCaller) {
      return c.json({ success: false, error: 'Device or session token required' }, 401)
    }
    try {
      const scanner = require('./lib/discovery-scanner')
      const printers = typeof scanner.getLocalPeripheralsCached === 'function' ? scanner.getLocalPeripheralsCached() : []
      return c.json({ success: true, host: { platform: process.platform }, printers })
    } catch (err) {
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  // POST /api/agency-devices/host/print-job — print a ticket/receipt/invoice
  // on THIS machine's printer. Body: { printerName?, cupsName?, ticket?, escposBase64? }
  app.post('/api/agency-devices/host/print-job', async (c) => {
    const clientIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'lan'
    if (!hostPrintLimiterCheck(clientIp)) {
      return c.json({ success: false, error: 'Too many print jobs — slow down' }, 429)
    }
    const bearer = c.req.header('Authorization')?.replace('Bearer ', '') || ''
    const deviceHeader = c.req.header('X-Device-Token') || ''
    const token = bearer || deviceHeader
    const db = getDb()
    let isDeviceCaller = false
    if (db && token) {
      try { isDeviceCaller = !!(await db.agencyDevice.findFirst({ where: { deviceToken: token } })) } catch { /* not a device */ }
    }
    if (!isDeviceCaller) {
      try { isDeviceCaller = !!require('./lib/lan-authority').verifyDeviceToken(token) } catch { /* not a lan token */ }
    }
    if (!isDeviceCaller && !!(ctx.sessionToken && token === ctx.sessionToken)) isDeviceCaller = true
    if (!isDeviceCaller) {
      return c.json({ success: false, error: 'Device or session token required' }, 401)
    }
    try {
      const body = await c.req.json().catch(() => ({}))
      const printerName = typeof body.printerName === 'string' && body.printerName.trim() ? body.printerName.trim().slice(0, 120) : ''
      const cupsName = typeof body.cupsName === 'string' && body.cupsName.trim() ? body.cupsName.trim().slice(0, 120) : printerName
      const escposBase64 = typeof body.escposBase64 === 'string' ? body.escposBase64 : ''
      const ticket = body.ticket && typeof body.ticket === 'object' ? body.ticket : null

      // 1) Raw ESC/POS when the caller provides the buffer AND a CUPS queue.
      if (escposBase64 && cupsName && process.platform !== 'win32') {
        try {
          const buf = Buffer.from(escposBase64, 'base64')
          if (buf.length > 0 && buf.length < 1_000_000) {
            const res = printEscposRaw(buf, cupsName)
            if (res.ok) {
              try { require('./device-event').deviceEvent('print_job_done', `Raw ESC/POS print via ${cupsName}`, { deviceType: 'PRINTER', status: 'OK', source: 'host-print-job' }) } catch { /* log only */ }
              return c.json({ success: true, via: res.via })
            }
            log('host print-job lp failed:', res.error, '— falling back to HTML print')
          }
        } catch { /* fall through to HTML print */ }
      }

      // 2) HTML receipt via Electron silent print (cross-platform).
      if (ticket && (ticket.ticketNumber || ticket.agencyName)) {
        const html = buildReceiptHtml(ticket)
        const res = await printHtmlSilent(html, printerName || undefined)
        try {
          require('./device-event').deviceEvent(res.ok ? 'print_job_done' : 'print_job_failed',
            res.ok ? `Ticket ${ticket.ticketNumber || ''} printed on ${printerName || 'default printer'}` : `Host print failed: ${res.error}`,
            { deviceType: 'PRINTER', status: res.ok ? 'OK' : 'FAILED', source: 'host-print-job', deviceName: printerName || undefined })
        } catch { /* log only */ }
        if (res.ok) return c.json({ success: true, via: 'electron-silent' })
        return c.json({ success: false, error: res.error }, 500)
      }

      return c.json({ success: false, error: 'Nothing to print — provide ticket or escposBase64' }, 400)
    } catch (err) {
      log('host print-job failed:', errorMessage(err))
      return c.json({ success: false, error: errorMessage(err) }, 500)
    }
  })

  log('device board routes registered (public/*, device/*, discovery/probe, host/print-*)')
}

module.exports = { registerDeviceBoardRoutes }
