// agency-devices.js — Agency device management + embedded LAN discovery + cast.
// ─────────────────────────────────────────────────────────────────────────────
// CommonJS port of apps/api/src/routes/agency-devices.ts for the desktop's
// embedded local API (Electron main process). Works fully OFFLINE against the
// local SQLite mirror — the same REST contract the agency UI already uses on
// the cloud (web) is now served by 127.0.0.1:3080.
//
// Registered into the Hono app by local-api/index.js BEFORE the static-UI
// catch-all. ctx = { authMiddleware, requireAgencyId, broadcast, diagLog }.
//
// Scope:
//   - Management: list / unpaired / create / get / patch / delete / pair /
//     unpair / pairing-request / command / commands / kiosk-credentials
//     (+ regenerate) / reboot / refresh / connect / disconnect / scan-network /
//     scan / discovery-token
//   - Discovery (embedded scanner, lib/discovery-scanner.js): health, devices,
//     scan start/stop/status, protocols, diagnostics
//   - Saved TVs + Default Printer (per-agency, upsert semantics)
//   - Cast: /discovery/cast (cloud contract) plus per-protocol endpoints the
//     cast dialog calls (dlna/samsung/lg/roku, stop, protocols) via
//     lib/cast-service.js — these do not exist on the cloud API; on desktop
//     they make real device casting work offline.
//
// Device-side (kiosk) endpoints (/public/*, /device/*) are intentionally NOT
// part of this module — they use deviceToken auth and are a separate concern.
//
// All output/comments in English. No new npm dependencies.

'use strict'

const os = require('os')
const crypto = require('crypto')
const scanner = require('./lib/discovery-scanner')
const castService = require('./lib/cast-service')

// ─── Helpers (mirror cloud route) ────────────────────────────────────────────

function parseJSON(str) {
  if (typeof str !== 'string') return str == null ? {} : str
  try { return JSON.parse(str || '{}') } catch { return {} }
}

function generatePairingCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase()
}

const DEVICE_SELECT_FIELDS = {
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
}

const BRANCH_SELECT = { id: true, name: true, nameAr: true, nameFr: true }

const DEVICE_TYPES = ['TV', 'KIOSK', 'DISPLAY', 'PRINTER', 'APP']
const CONNECTION_TYPES = ['LAN', 'WIFI', 'CABLE', 'MANUAL']
const SCREEN_LAYOUTS = ['QUEUE_BOARD', 'TICKET_PRINTER', 'SERVICE_SELECTOR', 'CUSTOM']
const DEVICE_STATUSES = ['ONLINE', 'OFFLINE', 'PAIRING', 'DISABLED', 'UPDATING']

// Hand-rolled validators (zod is not available in the local API). They accept
// exactly the same values as the cloud zod schemas and return
// { ok: true, data } or { ok: false, issues }.
function str(v, max) {
  if (typeof v !== 'string') return null
  if (max && v.length > max) return null
  return v
}
function optStr(v, max) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || (max && v.length > max)) return null // null = invalid
  return v
}
function optInt(v, min, max) {
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}
function optBool(v) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') return null
  return v
}
function optEnum(v, list) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !list.includes(v)) return null
  return v
}
function optRecord(v) {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) return null
  return v
}

function validateCreateDevice(body) {
  const issues = []
  const name = str(body.name, 100)
  if (!name) issues.push('name: required string (max 100)')
  const type = optEnum(body.type, DEVICE_TYPES)
  if (type === null) issues.push('type: invalid device type')
  const connectionType = optEnum(body.connectionType, CONNECTION_TYPES)
  if (connectionType === null) issues.push('connectionType: invalid connection type')
  const ipAddress = optStr(body.ipAddress, 50)
  if (ipAddress === null) issues.push('ipAddress: invalid')
  const port = optInt(body.port, 1, 65535)
  if (port === null) issues.push('port: invalid')
  const autoDiscovery = optBool(body.autoDiscovery)
  if (autoDiscovery === null) issues.push('autoDiscovery: invalid')
  const screenLayout = optEnum(body.screenLayout, SCREEN_LAYOUTS)
  if (screenLayout === null) issues.push('screenLayout: invalid screen layout')
  const branchId = optStr(body.branchId, 100)
  if (branchId === null) issues.push('branchId: invalid')
  const displaySettings = optRecord(body.displaySettings)
  if (displaySettings === null) issues.push('displaySettings: invalid')
  const printerConfig = optRecord(body.printerConfig)
  if (printerConfig === null) issues.push('printerConfig: invalid')
  const serviceFilter = optStr(body.serviceFilter, 5000)
  if (serviceFilter === null) issues.push('serviceFilter: invalid')
  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    data: {
      name,
      nameAr: optStr(body.nameAr, 100),
      nameFr: optStr(body.nameFr, 100),
      type: type === undefined ? 'TV' : type,
      connectionType: connectionType === undefined ? 'LAN' : connectionType,
      ipAddress,
      port,
      autoDiscovery: autoDiscovery === undefined ? true : autoDiscovery,
      screenLayout: screenLayout === undefined ? 'QUEUE_BOARD' : screenLayout,
      branchId,
      displaySettings: displaySettings === undefined ? {} : displaySettings,
      printerConfig: printerConfig === undefined ? {} : printerConfig,
      serviceFilter: serviceFilter === undefined ? '' : serviceFilter,
    },
  }
}

function validateUpdateDevice(body) {
  const issues = []
  const out = {}
  const checks = [
    ['name', () => { const v = optStr(body.name, 100); if (v === null) issues.push('name: invalid'); else out.name = v }],
    ['nameAr', () => { const v = optStr(body.nameAr, 100); if (v === null) issues.push('nameAr: invalid'); else out.nameAr = v }],
    ['nameFr', () => { const v = optStr(body.nameFr, 100); if (v === null) issues.push('nameFr: invalid'); else out.nameFr = v }],
    ['type', () => { const v = optEnum(body.type, DEVICE_TYPES); if (v === null) issues.push('type: invalid'); else out.type = v }],
    ['status', () => { const v = optEnum(body.status, DEVICE_STATUSES); if (v === null) issues.push('status: invalid'); else out.status = v }],
    ['connectionType', () => { const v = optEnum(body.connectionType, CONNECTION_TYPES); if (v === null) issues.push('connectionType: invalid'); else out.connectionType = v }],
    ['ipAddress', () => { const v = optStr(body.ipAddress, 50); if (v === null) issues.push('ipAddress: invalid'); else out.ipAddress = v }],
    ['port', () => { const v = optInt(body.port, 1, 65535); if (v === null) issues.push('port: invalid'); else out.port = v }],
    ['autoDiscovery', () => { const v = optBool(body.autoDiscovery); if (v === null) issues.push('autoDiscovery: invalid'); else out.autoDiscovery = v }],
    ['screenLayout', () => { const v = optEnum(body.screenLayout, SCREEN_LAYOUTS); if (v === null) issues.push('screenLayout: invalid'); else out.screenLayout = v }],
    ['branchId', () => { if (body.branchId === null) { out.branchId = null; return } const v = optStr(body.branchId, 100); if (v === null) issues.push('branchId: invalid'); else out.branchId = v }],
    ['displaySettings', () => { const v = optRecord(body.displaySettings); if (v === null) issues.push('displaySettings: invalid'); else out.displaySettings = v }],
    ['printerConfig', () => { const v = optRecord(body.printerConfig); if (v === null) issues.push('printerConfig: invalid'); else out.printerConfig = v }],
    ['serviceFilter', () => { const v = optStr(body.serviceFilter, 5000); if (v === null) issues.push('serviceFilter: invalid'); else out.serviceFilter = v }],
    ['appVersion', () => { const v = optStr(body.appVersion, 50); if (v === null) issues.push('appVersion: invalid'); else out.appVersion = v }],
    ['offlineCapable', () => { const v = optBool(body.offlineCapable); if (v === null) issues.push('offlineCapable: invalid'); else out.offlineCapable = v }],
  ]
  for (const [, fn] of checks) fn()
  if (issues.length) return { ok: false, issues }
  return { ok: true, data: out }
}

function validateSendCommand(body) {
  const issues = []
  const type = str(body.type, 100)
  if (!type) issues.push('type: required string')
  const payload = optRecord(body.payload)
  if (payload === null) issues.push('payload: invalid')
  const ttl = optInt(body.ttl, 10, 3600)
  if (ttl === null) issues.push('ttl: must be 10..3600')
  if (issues.length) return { ok: false, issues }
  return { ok: true, data: { type, payload, ttl } }
}

function validateSaveTv(body) {
  const issues = []
  const name = str(body.name, 200)
  if (!name) issues.push('name: required string (max 200)')
  const ip = str(body.ip, 50)
  if (!ip) issues.push('ip: required string (max 50)')
  const port = body.port === undefined ? 0 : optInt(body.port, 0, 65535)
  if (port === null) issues.push('port: invalid')
  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    data: {
      name,
      nameAr: optStr(body.nameAr, 200),
      nameFr: optStr(body.nameFr, 200),
      ip,
      port: port === undefined ? 0 : port,
      mac: optStr(body.mac, 50),
      manufacturer: optStr(body.manufacturer, 200),
      model: optStr(body.model, 200),
      ssdpLocation: optStr(body.ssdpLocation, 500),
      mdnsService: optStr(body.mdnsService, 200),
      source: str(body.source, 50) || 'ssdp',
    },
  }
}

function validateSavePrinter(body) {
  const issues = []
  const name = str(body.name, 200)
  if (!name) issues.push('name: required string (max 200)')
  const port = body.port === undefined ? 9100 : optInt(body.port, 0, 65535)
  if (port === null) issues.push('port: invalid')
  const connectionType = body.connectionType === undefined ? 'LAN' : optEnum(body.connectionType, ['LAN', 'WIFI', 'USB'])
  if (connectionType === null) issues.push('connectionType: invalid')
  if (issues.length) return { ok: false, issues }
  return {
    ok: true,
    data: {
      name,
      nameAr: optStr(body.nameAr, 200),
      nameFr: optStr(body.nameFr, 200),
      ip: optStr(body.ip, 50),
      port: port === undefined ? 9100 : port,
      mac: optStr(body.mac, 50),
      manufacturer: optStr(body.manufacturer, 200),
      model: optStr(body.model, 200),
      cupsName: optStr(body.cupsName, 200),
      cupsUri: optStr(body.cupsUri, 500),
      usbVendorId: optStr(body.usbVendorId, 20),
      usbProductId: optStr(body.usbProductId, 20),
      connectionType: connectionType === undefined ? 'LAN' : connectionType,
      source: str(body.source, 50) || 'http_probe',
    },
  }
}

// Attach the branch relation without relying on Prisma include (the local
// schema mirrors the cloud one, but this keeps the module resilient).
async function attachBranches(db, devices) {
  if (!Array.isArray(devices) || devices.length === 0) return devices
  const branchIds = [...new Set(devices.map((d) => d.branchId).filter(Boolean))]
  if (branchIds.length === 0) return devices
  let branches = []
  try {
    branches = await db.branch.findMany({ where: { id: { in: branchIds } }, select: BRANCH_SELECT })
  } catch { /* branch table unavailable — return devices without branch */ }
  const byId = new Map(branches.map((b) => [b.id, b]))
  return devices.map((d) => ({ ...d, branch: d.branchId ? (byId.get(d.branchId) || null) : null }))
}

// ─── Embedded discovery scanner state (mirror cloud runEmbeddedScan) ────────

let scanState = {
  scanning: false,
  scanId: null,
  totalIPs: 0,
  scannedIPs: 0,
  currentSubnet: '',
  phase: 'idle',
  devicesFound: 0,
  subnets: [],
  protocolsUsed: [],
  elapsed: 0,
}
let scanDevices = []
let scanAbort = null
let scanTimer = null

async function runEmbeddedScan() {
  if (scanState.scanning) return
  const scanId = `scan-${Date.now()}`
  const subnets = scanner.getLocalSubnets()
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
    await scanner.runDiscoveryScan(subnets, {
      isAborted: () => (scanAbort ? scanAbort.aborted : false),
      onProgress: (p) => {
        scanState.scannedIPs = p.scannedIPs
        scanState.currentSubnet = p.currentSubnet
        scanState.phase = p.phase
        scanState.protocolsUsed = p.protocolsUsed
        scanState.devicesFound = p.devicesFound
      },
      onDevice: (d) => {
        const idx = scanDevices.findIndex((x) => x.ip === d.ip)
        if (idx >= 0) scanDevices[idx] = d
        else scanDevices.push(d)
      },
    })
    scanState.phase = scanAbort && scanAbort.aborted ? 'idle' : 'complete'
  } catch (err) {
    scanState.phase = 'error'
    console.error('[agency-devices] scan failed:', err && err.message ? err.message : err)
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

// ─── Discovery response shapers (identical to the cloud contract) ───────────

function healthResponse() {
  return {
    status: 'ok',
    message: 'Embedded multi-protocol discovery active (ARP + Ping + mDNS + SSDP + HTTP)',
    fallback: 'embedded',
    uptime: process.uptime(),
    version: '2.0.0-embedded',
  }
}

function devicesResponse(category, status) {
  let devices = [...scanDevices]
  if (category) devices = devices.filter((d) => String(d.category).toUpperCase() === String(category).toUpperCase())
  if (status) devices = devices.filter((d) => String(d.status).toUpperCase() === String(status).toUpperCase())
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
  const subnets = scanner.getLocalSubnets()
  runEmbeddedScan().catch(() => { /* scan logs its own errors */ })
  return {
    scanId: scanState.scanId,
    totalIPs: subnets.length * 254,
    subnets,
  }
}

function scanStopResponse() {
  if (!scanState.scanning && !(scanAbort && scanAbort.aborted) && scanState.phase === 'idle') {
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
    protocols: scanner.getProtocolAvailability(),
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
      cpuModel: (cpus[0] && cpus[0].model) || 'unknown',
      totalMemoryMB: Math.round(totalMem / 1024 / 1024),
      freeMemoryMB: Math.round(freeMem / 1024 / 1024),
      memoryUsagePercent: Math.round((1 - freeMem / totalMem) * 100),
      networkInterfaces: scanner.getNetworkInterfacesDetailed().map((i) => ({ name: i.name, ip: i.ip, mac: i.mac })),
    },
    discovery: {
      mode: 'embedded',
      scanPorts: scanner.SCAN_PORTS,
      scannedSubnets: scanner.getLocalSubnets(),
      devicesFound: scanDevices.length,
      lastScanId: scanState.scanId,
      protocols: scanner.getProtocolAvailability(),
    },
    memoryUsage: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
    },
    source: 'embedded',
  }
}

// ─── Route registration ──────────────────────────────────────────────────────

module.exports = function registerAgencyDeviceRoutes(app, ctx) {
  const { authMiddleware, requireAgencyId, broadcast, diagLog, getDb } = ctx

  // Optional-auth wrapper for GET /discovery/default-printer (cloud parity:
  // a kiosk may look up its agency's printer via ?agencyId= without a staff
  // session; a staff request without the query goes through full auth).
  const defaultPrinterAuth = async (c, next) => {
    if (c.req.query('agencyId')) {
      if (typeof getDb === 'function') c.set('db', getDb())
      await next()
      return
    }
    return authMiddleware(c, next)
  }

  const broadcastSafe = (type, payload) => {
    try {
      if (typeof broadcast === 'function') broadcast(type, payload)
    } catch { /* realtime must never break a route */ }
  }

  // ═══ Discovery (embedded scanner) — registered BEFORE /:id routes ════════

  app.get('/api/agency-devices/discovery/health', authMiddleware, (c) => {
    return c.json(healthResponse())
  })

  app.get('/api/agency-devices/discovery/devices', authMiddleware, (c) => {
    const category = c.req.query('category')
    const status = c.req.query('status')
    return c.json(devicesResponse(category, status))
  })

  app.post('/api/agency-devices/discovery/scan/start', authMiddleware, (c) => {
    return c.json(scanStartResponse())
  })

  app.post('/api/agency-devices/discovery/scan/stop', authMiddleware, (c) => {
    return c.json(scanStopResponse())
  })

  app.get('/api/agency-devices/discovery/scan/status', authMiddleware, (c) => {
    return c.json(scanStatusResponse())
  })

  app.get('/api/agency-devices/discovery/protocols', authMiddleware, (c) => {
    return c.json(protocolsResponse())
  })

  app.get('/api/agency-devices/discovery/diagnostics', authMiddleware, (c) => {
    return c.json(diagnosticsResponse())
  })

  // ═══ Saved TVs ═══════════════════════════════════════════════════════════

  app.get('/api/agency-devices/discovery/saved-tvs', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return // 403 already sent
    try {
      const tvs = await db.savedTv.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'desc' },
      })
      return c.json({ success: true, savedTvs: tvs })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE saved-tvs GET error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load saved TVs' }, 500)
    }
  })

  app.post('/api/agency-devices/discovery/saved-tvs', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const body = await c.req.json().catch(() => ({}))
      const v = validateSaveTv(body)
      if (!v.ok) {
        return c.json({ success: false, error: 'Invalid input', details: v.issues }, 400)
      }
      // Upsert by (agencyId, ip) — re-saving the same TV updates its metadata
      const existing = await db.savedTv.findFirst({ where: { agencyId, ip: v.data.ip } })
      let tv
      if (existing) {
        tv = await db.savedTv.update({
          where: { id: existing.id },
          data: {
            name: v.data.name, nameAr: v.data.nameAr, nameFr: v.data.nameFr,
            port: v.data.port, mac: v.data.mac, manufacturer: v.data.manufacturer,
            model: v.data.model, ssdpLocation: v.data.ssdpLocation,
            mdnsService: v.data.mdnsService, source: v.data.source,
            lastSeenAt: new Date(),
          },
        })
      } else {
        tv = await db.savedTv.create({
          data: { ...v.data, agencyId, lastSeenAt: new Date() },
        })
      }
      return c.json({ success: true, savedTv: tv })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE saved-tvs POST error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to save TV' }, 500)
    }
  })

  app.delete('/api/agency-devices/discovery/saved-tvs/:id', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const id = c.req.param('id')
      const existing = await db.savedTv.findUnique({ where: { id } })
      if (!existing || existing.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Saved TV not found' }, 404)
      }
      await db.savedTv.delete({ where: { id } })
      return c.json({ success: true })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE saved-tvs DELETE error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to delete saved TV' }, 500)
    }
  })

  // ═══ Default Printer (per-agency) ════════════════════════════════════════

  app.post('/api/agency-devices/discovery/default-printer', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const body = await c.req.json().catch(() => ({}))
      const v = validateSavePrinter(body)
      if (!v.ok) {
        return c.json({ success: false, error: 'Invalid input', details: v.issues }, 400)
      }
      // Upsert by agencyId — only one default printer per agency
      const existing = await db.defaultPrinter.findUnique({ where: { agencyId } })
      let printer
      if (existing) {
        printer = await db.defaultPrinter.update({
          where: { id: existing.id },
          data: {
            name: v.data.name, nameAr: v.data.nameAr, nameFr: v.data.nameFr,
            ip: v.data.ip, port: v.data.port, mac: v.data.mac,
            manufacturer: v.data.manufacturer, model: v.data.model,
            cupsName: v.data.cupsName, cupsUri: v.data.cupsUri,
            usbVendorId: v.data.usbVendorId, usbProductId: v.data.usbProductId,
            connectionType: v.data.connectionType, source: v.data.source,
            lastSeenAt: new Date(),
          },
        })
      } else {
        printer = await db.defaultPrinter.create({
          data: { ...v.data, agencyId, lastSeenAt: new Date() },
        })
      }
      return c.json({ success: true, defaultPrinter: printer })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE default-printer POST error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to save default printer' }, 500)
    }
  })

  // GET /discovery/default-printer — allow agencyId query (kiosk lookup) OR auth
  app.get('/api/agency-devices/discovery/default-printer', defaultPrinterAuth, async (c) => {
    const db = c.get('db')
    let agencyId = c.req.query('agencyId')
    if (!agencyId) {
      // Authenticated staff lookup (authMiddleware populated the user)
      const user = c.get('user')
      agencyId = user && user.agencyId ? user.agencyId : null
      if (!agencyId) {
        return c.json({ success: false, error: 'agencyId required' }, 400)
      }
    }
    try {
      const printer = await db.defaultPrinter.findUnique({ where: { agencyId } })
      return c.json({ success: true, defaultPrinter: printer })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE default-printer GET error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load default printer' }, 500)
    }
  })

  app.delete('/api/agency-devices/discovery/default-printer', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      await db.defaultPrinter.deleteMany({ where: { agencyId } })
      return c.json({ success: true })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE default-printer DELETE error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to delete default printer' }, 500)
    }
  })

  // ═══ Cast to TV ══════════════════════════════════════════════════════════

  // POST /discovery/cast — cloud contract: Samsung/Roku HTTP attempts with a
  // URL fallback. When the body carries an explicit protocol (the cast dialog
  // does), route through the ported cast-service for a real device cast.
  app.post('/api/agency-devices/discovery/cast', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      if (!user || !user.agencyId) {
        return c.json({ success: false, error: 'No agency assigned' }, 403)
      }
      const body = await c.req.json().catch(() => ({}))
      const ip = String(body.ip || '')
      const port = Number(body.port) || 0
      const manufacturer = String(body.manufacturer || '')
      const ssdpLocation = String(body.ssdpLocation || '')
      const mdnsService = String(body.mdnsService || '')
      const protocol = body.protocol ? String(body.protocol) : null

      if (!ip) {
        return c.json({ success: false, error: 'IP required' }, 400)
      }

      const origin = new URL(c.req.url).origin
      const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`

      // Explicit protocol from the cast dialog → use the cast service.
      if (protocol && protocol !== 'url') {
        const target = { ip, port, manufacturer, ssdpLocation, mdnsService, name: String(body.name || 'BLASTI TV') }
        try {
          let result = null
          if (protocol === 'dlna') result = await castService.castViaDlna(target, tvBoardUrl)
          else if (protocol === 'samsung-tizen' || protocol === 'samsung') result = await castService.castViaSamsungTizen(target, tvBoardUrl)
          else if (protocol === 'lg-webos' || protocol === 'lg') result = await castService.castViaLgWebOS(target, tvBoardUrl)
          else if (protocol === 'roku-ecp' || protocol === 'roku') result = await castService.castViaRokuEcp(target, tvBoardUrl)
          if (result && result.ok !== false && result.success !== false) {
            return c.json({
              success: true,
              protocol: protocol.startsWith('samsung') ? 'samsung-tizen' : protocol.startsWith('lg') ? 'lg-webos' : protocol.startsWith('roku') ? 'roku-ecp' : protocol,
              castKind: protocol,
              tvBoardUrl,
              message: result.message || `Cast sent via ${protocol} to ${ip}`,
            })
          }
          return c.json({
            success: false,
            protocol,
            tvBoardUrl,
            message: (result && result.message) || `Cast via ${protocol} failed`,
            error: (result && result.error) || null,
          })
        } catch (castErr) {
          return c.json({
            success: false,
            protocol,
            tvBoardUrl,
            message: 'Cast failed: ' + (castErr && castErr.message ? castErr.message : 'unknown error'),
          })
        }
      }

      // Cloud-contract path — try Samsung Tizen REST, then Roku, then URL.
      const man = manufacturer.toLowerCase()
      const castTargets = []
      if (man.includes('samsung') || port === 8001 || port === 9197) {
        const samsungPort = port === 9197 ? 9197 : 8001
        castTargets.push({
          kind: 'samsung-tizen',
          url: `http://${ip}:${samsungPort}/ws/app/WEBAPP`,
          method: 'POST',
          body: JSON.stringify({ method: 'ms.webapp.launch', id: tvBoardUrl, token: '' }),
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (man.includes('roku') || port === 8060) {
        castTargets.push({
          kind: 'roku',
          url: `http://${ip}:8060/launch/11?contentId=${encodeURIComponent(tvBoardUrl)}`,
          method: 'POST',
        })
      }
      for (const target of castTargets) {
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 3000)
          const res = await fetch(target.url, {
            method: target.method || 'GET',
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
        } catch { /* try next target */ }
      }
      return c.json({
        success: true,
        castKind: 'url',
        tvBoardUrl,
        ssdpLocation,
        message: 'Open the TV board URL on the TV or use Chromecast / HDMI',
      })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE cast error: ' + (err && err.message))
      return c.json({ success: false, error: 'Cast failed' }, 500)
    }
  })

  // Per-protocol cast endpoints the cast dialog calls (no cloud equivalent —
  // desktop implements them for real device casting).
  app.post('/api/agency-devices/discovery/cast/dlna', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const origin = new URL(c.req.url).origin
      const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
      const target = {
        ip: String(body.ip || ''),
        port: Number(body.port) || 0,
        manufacturer: String(body.manufacturer || ''),
        ssdpLocation: String(body.ssdpLocation || ''),
        mdnsService: String(body.mdnsService || ''),
      }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaDlna(target, tvBoardUrl)
      return c.json({ success: !!(result && result.ok !== false && result.success !== false), protocol: 'dlna', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'dlna', message: err && err.message ? err.message : 'DLNA cast failed' })
    }
  })

  app.post('/api/agency-devices/discovery/cast/samsung', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const origin = new URL(c.req.url).origin
      const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
      const target = { ip: String(body.ip || ''), port: Number(body.port) || 8001, manufacturer: String(body.manufacturer || '') }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaSamsungTizen(target, tvBoardUrl)
      return c.json({ success: !!(result && result.ok !== false && result.success !== false), protocol: 'samsung-tizen', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'samsung-tizen', message: err && err.message ? err.message : 'Samsung cast failed' })
    }
  })

  app.post('/api/agency-devices/discovery/cast/lg', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const origin = new URL(c.req.url).origin
      const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
      const target = { ip: String(body.ip || ''), port: Number(body.port) || 3000, manufacturer: String(body.manufacturer || '') }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaLgWebOS(target, tvBoardUrl)
      return c.json({ success: !!(result && result.ok !== false && result.success !== false), protocol: 'lg-webos', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'lg-webos', message: err && err.message ? err.message : 'LG cast failed' })
    }
  })

  app.post('/api/agency-devices/discovery/cast/roku', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const origin = new URL(c.req.url).origin
      const tvBoardUrl = `${origin}/?mode=device&type=TV&agencyId=${user.agencyId}`
      const target = { ip: String(body.ip || ''), port: Number(body.port) || 8060, manufacturer: String(body.manufacturer || '') }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaRokuEcp(target, tvBoardUrl)
      return c.json({ success: !!(result && result.ok !== false && result.success !== false), protocol: 'roku-ecp', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'roku-ecp', message: err && err.message ? err.message : 'Roku cast failed' })
    }
  })

  app.post('/api/agency-devices/discovery/cast/stop', authMiddleware, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const target = {
        ip: String(body.ip || ''),
        port: Number(body.port) || 0,
        ssdpLocation: String(body.ssdpLocation || ''),
        manufacturer: String(body.manufacturer || ''),
      }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.stopDlnaCast(target)
      return c.json({ success: true, ...(result || {}) })
    } catch (err) {
      return c.json({ success: false, message: err && err.message ? err.message : 'Stop cast failed' })
    }
  })

  app.get('/api/agency-devices/discovery/cast/protocols', authMiddleware, async (c) => {
    try {
      const target = {
        ip: c.req.query('ip') || '',
        port: Number(c.req.query('port')) || 0,
        manufacturer: c.req.query('manufacturer') || '',
        ssdpLocation: c.req.query('ssdpLocation') || '',
        mdnsService: c.req.query('mdnsService') || '',
      }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const protocols = castService.detectCastProtocols(target)
      return c.json({ success: true, protocols })
    } catch (err) {
      return c.json({ success: false, error: err && err.message ? err.message : 'Protocol detection failed' })
    }
  })

  // ═══ Back-compat token endpoint (cloud parity) ═══════════════════════════

  app.get('/api/agency-devices/discovery-token', authMiddleware, (c) => {
    return c.json({ token: null, mode: 'embedded' })
  })

  // ═══ Management ══════════════════════════════════════════════════════════

  // GET /unpaired — devices broadcasting for pairing (heartbeat ≤ 90 s)
  app.get('/api/agency-devices/unpaired', authMiddleware, async (c) => {
    const db = c.get('db')
    if (!requireAgencyId(c)) return
    try {
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
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE unpaired error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load unpaired devices' }, 500)
    }
  })

  // POST /scan-network and /scan — kick off the embedded scan (cloud parity)
  app.post('/api/agency-devices/scan-network', authMiddleware, (c) => {
    return c.json(scanStartResponse())
  })

  app.post('/api/agency-devices/scan', authMiddleware, (c) => {
    return c.json(scanStartResponse())
  })

  // GET / — List devices for the agency
  app.get('/api/agency-devices', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const status = c.req.query('status')
      const type = c.req.query('type')
      const where = { agencyId }
      if (status) where.status = status
      if (type) where.type = type
      let devices = await db.agencyDevice.findMany({
        where,
        select: DEVICE_SELECT_FIELDS,
        orderBy: { createdAt: 'desc' },
      })
      devices = await attachBranches(db, devices)
      // M7: parse JSON string fields before returning
      const parsedDevices = devices.map((d) => ({
        ...d,
        displaySettings: parseJSON(d.displaySettings),
        printerConfig: parseJSON(d.printerConfig),
      }))
      return c.json({ success: true, devices: parsedDevices })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE list error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load devices' }, 500)
    }
  })

  // POST / — Create a new device (kiosk/TV)
  app.post('/api/agency-devices', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const body = await c.req.json().catch(() => ({}))
      const v = validateCreateDevice(body)
      if (!v.ok) {
        return c.json({ success: false, error: 'Invalid input', details: v.issues }, 400)
      }
      const data = v.data
      // Generate a unique pairing code
      let pairingCode = generatePairingCode()
      let attempts = 0
      while (attempts < 10) {
        const existing = await db.agencyDevice.findUnique({ where: { pairingCode } })
        if (!existing) break
        pairingCode = generatePairingCode()
        attempts++
      }
      // Device token — returned ONLY on creation
      const deviceToken = crypto.randomBytes(32).toString('hex')
      const device = await db.agencyDevice.create({
        data: {
          agencyId,
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
        select: DEVICE_SELECT_FIELDS,
      })
      broadcastSafe('device:registered', { agencyId, deviceId: device.id, deviceName: device.name, deviceType: device.type })
      return c.json({ success: true, device, deviceToken })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE create error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to create device' }, 500)
    }
  })

  // GET /:id — Device detail
  app.get('/api/agency-devices/:id', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      let device = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
        select: DEVICE_SELECT_FIELDS,
      })
      if (!device) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const [withBranch] = await attachBranches(db, [device])
      device = withBranch
      return c.json({
        success: true,
        device: {
          ...device,
          displaySettings: parseJSON(device.displaySettings),
          printerConfig: parseJSON(device.printerConfig),
        },
      })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE get error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load device' }, 500)
    }
  })

  // PATCH /:id — Update a device
  app.patch('/api/agency-devices/:id', authMiddleware, async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const body = await c.req.json().catch(() => ({}))
      const v = validateUpdateDevice(body)
      if (!v.ok) {
        return c.json({ success: false, error: 'Invalid input', details: v.issues }, 400)
      }
      const data = v.data
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const updateData = {}
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
        where: { id: existing.id },
        data: updateData,
        select: DEVICE_SELECT_FIELDS,
      })
      // Auto-create CONFIG_UPDATE command when settings change on an ONLINE device
      const configChanged = data.displaySettings !== undefined || data.printerConfig !== undefined
      if (configChanged && existing.status === 'ONLINE') {
        await db.deviceCommand.create({
          data: {
            deviceId: existing.id,
            type: 'CONFIG_UPDATE',
            payload: JSON.stringify({
              displaySettings: data.displaySettings !== undefined ? data.displaySettings : undefined,
              printerConfig: data.printerConfig !== undefined ? data.printerConfig : undefined,
              screenLayout: data.screenLayout !== undefined ? data.screenLayout : undefined,
              serviceFilter: data.serviceFilter !== undefined ? data.serviceFilter : undefined,
            }),
            status: 'PENDING',
          },
        })
      }
      broadcastSafe('agency-device:updated', { agencyId, deviceId: existing.id })
      broadcastSafe('device:status-changed', { agencyId, deviceId: existing.id, status: device.status })
      return c.json({ success: true, device })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE patch error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to update device' }, 500)
    }
  })

  // DELETE /:id — Delete a device (+ its commands)
  app.delete('/api/agency-devices/:id', authMiddleware, async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    try {
      const whereClause = { id: c.req.param('id') }
      if (user && user.agencyId) whereClause.agencyId = user.agencyId
      const existing = await db.agencyDevice.findFirst({ where: whereClause })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      await db.deviceCommand.deleteMany({ where: { deviceId: existing.id } })
      await db.agencyDevice.delete({ where: { id: existing.id } })
      broadcastSafe('agency-device:disconnected', {
        agencyId: existing.agencyId || 'system',
        deviceId: existing.id,
        deviceName: existing.name,
        deviceType: existing.type,
      })
      return c.json({ success: true })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE delete error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to delete device' }, 500)
    }
  })

  // POST /:id/pair — (re)generate pairing credentials, status → PAIRING
  app.post('/api/agency-devices/:id/pair', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
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
      const device = await db.agencyDevice.update({
        where: { id: existing.id },
        data: {
          pairingCode,
          deviceToken,
          status: 'PAIRING',
          statusChangedAt: new Date(),
        },
        select: DEVICE_SELECT_FIELDS,
      })
      return c.json({ success: true, pairingCode: device.pairingCode, deviceToken })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE pair error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to initiate pairing' }, 500)
    }
  })

  // POST /:id/connect — Mark device connected (manual staff action)
  app.post('/api/agency-devices/:id/connect', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const now = new Date()
      const device = await db.agencyDevice.update({
        where: { id: existing.id },
        data: {
          status: 'ONLINE',
          statusChangedAt: now,
          connectedAt: existing.connectedAt || now,
        },
        select: DEVICE_SELECT_FIELDS,
      })
      broadcastSafe('agency-device:connected', { agencyId, deviceId: device.id, deviceName: device.name })
      broadcastSafe('device:online', { agencyId, deviceId: device.id })
      return c.json({ success: true, device })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE connect error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to connect device' }, 500)
    }
  })

  // POST /:id/disconnect — Mark device disconnected (manual staff action)
  app.post('/api/agency-devices/:id/disconnect', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const device = await db.agencyDevice.update({
        where: { id: existing.id },
        data: {
          status: 'OFFLINE',
          statusChangedAt: new Date(),
        },
        select: DEVICE_SELECT_FIELDS,
      })
      broadcastSafe('agency-device:disconnected', { agencyId, deviceId: device.id, deviceName: device.name })
      return c.json({ success: true, device })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE disconnect error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to disconnect device' }, 500)
    }
  })

  // POST /:id/unpair — Detach from the agency, invalidate credentials
  app.post('/api/agency-devices/:id/unpair', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const deviceId = c.req.param('id')
      const existing = await db.agencyDevice.findFirst({
        where: { id: deviceId, agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      if (!existing.agencyId) {
        return c.json({ success: false, error: 'Device is not paired with any agency' }, 400)
      }
      // FORCE_DISCONNECT so a live kiosk drops immediately via heartbeat
      await db.deviceCommand.create({
        data: {
          deviceId: existing.id,
          type: 'FORCE_DISCONNECT',
          payload: JSON.stringify({ reason: 'unpaired_by_admin', agencyName: existing.name }),
          status: 'PENDING',
          ttl: 300,
        },
      })
      const device = await db.agencyDevice.update({
        where: { id: deviceId },
        data: {
          agencyId: null,
          branchId: null,
          status: 'OFFLINE',
          deviceToken: null,
          pairingCode: null,
          statusChangedAt: new Date(),
          connectedAt: null,
        },
        select: DEVICE_SELECT_FIELDS,
      })
      broadcastSafe('agency-device:disconnected', {
        agencyId,
        deviceId: existing.id,
        deviceName: existing.name,
        deviceType: existing.type,
        reason: 'unpaired',
      })
      return c.json({ success: true, device })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE unpair error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to unpair device' }, 500)
    }
  })

  // POST /:id/reboot — Send REBOOT command
  app.post('/api/agency-devices/:id/reboot', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const command = await db.deviceCommand.create({
        data: { deviceId: existing.id, type: 'REBOOT', payload: '{}', status: 'PENDING' },
      })
      broadcastSafe('agency-device:updated', { agencyId, deviceId: existing.id })
      return c.json({ success: true, command })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE reboot error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to send reboot command' }, 500)
    }
  })

  // POST /:id/refresh — Send REFRESH command
  app.post('/api/agency-devices/:id/refresh', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const command = await db.deviceCommand.create({
        data: { deviceId: existing.id, type: 'REFRESH', payload: '{}', status: 'PENDING' },
      })
      broadcastSafe('agency-device:updated', { agencyId, deviceId: existing.id })
      return c.json({ success: true, command })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE refresh error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to send refresh command' }, 500)
    }
  })

  // POST /:id/command — Send a custom command
  app.post('/api/agency-devices/:id/command', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const body = await c.req.json().catch(() => ({}))
      const v = validateSendCommand(body)
      if (!v.ok) {
        return c.json({ success: false, error: 'Invalid input', details: v.issues }, 400)
      }
      const command = await db.deviceCommand.create({
        data: {
          deviceId: existing.id,
          type: v.data.type,
          payload: JSON.stringify(v.data.payload == null ? {} : v.data.payload),
          status: 'PENDING',
          ttl: v.data.ttl == null ? 300 : v.data.ttl,
        },
      })
      broadcastSafe('agency-device:updated', { agencyId, deviceId: existing.id })
      return c.json({ success: true, command })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE command error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to send command' }, 500)
    }
  })

  // GET /:id/commands — Command history for a device
  app.get('/api/agency-devices/:id/commands', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const deviceId = c.req.param('id')
      const device = await db.agencyDevice.findFirst({
        where: { id: deviceId, agencyId },
        select: { id: true },
      })
      if (!device) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      const statusFilter = c.req.query('status')
      const where = { deviceId }
      if (statusFilter) where.status = statusFilter
      const commands = await db.deviceCommand.findMany({
        where,
        orderBy: { createdAt: 'desc' },
      })
      return c.json({ success: true, commands })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE commands list error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load commands' }, 500)
    }
  })

  // POST /:id/pairing-request — Ask an unpaired (broadcasting) device to pair
  app.post('/api/agency-devices/:id/pairing-request', authMiddleware, async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const deviceId = c.req.param('id')
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
      const ninetySecAgo = new Date(Date.now() - 90 * 1000)
      if (!device.lastHeartbeatAt || device.lastHeartbeatAt < ninetySecAgo) {
        return c.json({ success: false, error: 'Device is not currently online' }, 400)
      }
      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        select: { id: true, name: true, nameAr: true, nameFr: true },
      })
      if (!agency) {
        return c.json({ success: false, error: 'Agency not found' }, 404)
      }
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
          ttl: 600,
        },
      })
      broadcastSafe('agency-device:pairing-request', {
        agencyId: agency.id,
        deviceId: device.id,
        deviceName: device.name,
        commandId: command.id,
        agencyName: agency.name,
      })
      return c.json({
        success: true,
        message: `Pairing request sent to ${device.name}`,
        commandId: command.id,
      })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE pairing-request error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to send pairing request' }, 500)
    }
  })

  // POST /:id/kiosk-credentials — Return existing credentials or create them
  app.post('/api/agency-devices/:id/kiosk-credentials', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
      })
      if (!existing) {
        return c.json({ success: false, error: 'Device not found' }, 404)
      }
      if (existing.pairingCode && existing.deviceToken) {
        return c.json({
          success: true,
          pairingCode: existing.pairingCode,
          deviceToken: existing.deviceToken,
          regenerated: false,
        })
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
          status: existing.status === 'DISABLED' ? 'OFFLINE' : existing.status,
        },
      })
      return c.json({ success: true, pairingCode, deviceToken, regenerated: true })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE kiosk-credentials error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to get kiosk credentials' }, 500)
    }
  })

  // POST /:id/kiosk-credentials/regenerate — Force-regenerate credentials
  app.post('/api/agency-devices/:id/kiosk-credentials/regenerate', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const existing = await db.agencyDevice.findFirst({
        where: { id: c.req.param('id'), agencyId },
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
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE kiosk-credentials regenerate error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to regenerate kiosk credentials' }, 500)
    }
  })

  if (diagLog) diagLog('AGENCY-DEVICES routes registered (management + embedded discovery + cast)')
}
