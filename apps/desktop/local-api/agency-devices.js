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
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const net = require('net')
const scanner = require('./lib/discovery-scanner')
const castService = require('./lib/cast-service')
// 0.6.96 — live BLASTI beacon registry (lan-authority listener): ACTIVE apps
// between scans + the auto-connect-on-detection hook.
const lanAuthority = require('./lib/lan-authority')
// 0.6.88 — DEVICE EVENT STREAM producer (module-level: runEmbeddedScan and
// stopEmbeddedScan live outside the route-registration closure).
const deviceEvents = require('./lib/device-event')

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
const SCREEN_LAYOUTS = ['QUEUE_BOARD', 'TICKET_PRINTER', 'SERVICE_SELECTOR', 'CUSTOM', 'TV_CLASSIC', 'TV_COUNTERS', 'TV_FOCUS', 'TV_MINIMAL']
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

// ─── Persistent discovery cache (0.6.78) ─────────────────────────────────────
// The last scan's results are written to ~/.blasti/discovery-cache.json so the
// Device Manager opens with the PREVIOUSLY DISCOVERED devices (typed, named,
// marked STALE) instead of an empty list. Live scan results replace them as
// they stream in; the cache is refreshed (debounced) during the scan.

function discoveryCachePath() {
  return process.env.BLASTI_DISCOVERY_CACHE
    ? path.resolve(process.env.BLASTI_DISCOVERY_CACHE)
    : path.join(os.homedir(), '.blasti', 'discovery-cache.json')
}

function loadDiscoveryCache() {
  try {
    const raw = fs.readFileSync(discoveryCachePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.devices)) return []
    return parsed.devices
      .filter((d) => d && typeof d.ip === 'string' && !d.ip.startsWith('local:'))
      .slice(0, 500)
  } catch { return [] }
}

function markCachedDevice(d) {
  return { ...d, status: 'STALE', cached: true, capabilities: Array.isArray(d.capabilities) ? d.capabilities : [] }
}

let discoveryCacheSaveTimer = null
function scheduleDiscoveryCacheSave() {
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
  const subnets = scanner.getLocalSubnets()
  // 0.6.88 — device event stream: scan started.
  deviceEvents.deviceEvent('scan_started', `Multi-protocol LAN scan started (${subnets.length} subnet(s))`, { sessionId: scanId, subnets: subnets.length })
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
  // fresh scan runs.
  scanDevices = loadDiscoveryCache().map(markCachedDevice)
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
        // 0.6.101 — dedupe by CARD IDENTITY first, IP second. The IP-only rule
        // collapsed every locally-attached printer (all keyed ip 127.0.0.1)
        // into one entry — only the last USB printer survived the scan.
        // Local printer cards carry unique ids ('local-cups:*'/'local-usb:*');
        // network cards fall back to the IP merge as before.
        let idx = -1
        if (d && d.id && !String(d.id).startsWith('beacon:')) {
          idx = scanDevices.findIndex((x) => x.id === d.id)
        }
        if (idx < 0 && d && d.ip && d.ip !== '127.0.0.1') {
          idx = scanDevices.findIndex((x) => x.ip === d.ip)
        }
        if (idx >= 0) scanDevices[idx] = d
        else scanDevices.push(d)
        scheduleDiscoveryCacheSave()
      },
    })
    scanState.phase = scanAbort && scanAbort.aborted ? 'idle' : 'complete'
    // 0.6.88 — device event stream: scan outcome.
    deviceEvents.deviceEvent(
      scanAbort && scanAbort.aborted ? 'scan_stopped' : 'scan_completed',
      `LAN scan ${scanAbort && scanAbort.aborted ? 'stopped' : 'completed'} — ${scanDevices.length} device(s) known`,
      { sessionId: scanId, devicesFound: scanDevices.length, elapsedSec: Math.floor((Date.now() - startTime) / 1000) },
    )
  } catch (err) {
    scanState.phase = 'error'
    console.error('[agency-devices] scan failed:', err && err.message ? err.message : err)
    // 0.6.88 — device event stream: scan crashed.
    deviceEvents.deviceEvent('scan_failed', `LAN scan failed: ${err && err.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200)}`, { sessionId: scanId }, 'error')
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
  try {
    deviceEvents.deviceEvent('scan_stopped', 'LAN scan stopped by operator', { sessionId: scanState.scanId, devicesFound: scanDevices.length })
  } catch { /* logging must never break the stop path */ }
}

// ─── Discovery response shapers (identical to the cloud contract) ───────────

function healthResponse() {
  return {
    status: 'ok',
    message: 'Embedded multi-protocol discovery active (ARP + Ping + TCP + mDNS + SSDP + WS-Discovery + HTTP)',
    fallback: 'embedded',
    uptime: process.uptime(),
    version: '2.2.0-embedded',
  }
}

// 0.6.99 — SIGNAL-BACKED WHITELIST (user requirement: "device manager
// discovery should discover ONLY devices with the BLASTI app running on them
// (by responding to the app signal) or TVs, printers and kiosk mode on the
// BLASTI app (responding to the signal)"). The predicate lives in the scanner
// port (1:1 with apps/api) and requires POSITIVE signal evidence:
//   BLASTI apps — answered the beacon / mDNS _blasti / /api/discover probe
//   TVs         — answered cast mDNS/SSDP/TCP/HTTP signals
//   Printers    — answered IPP/JetDirect/WSD/SSDP/USB/HTTP signals
// PCs, routers, IoT, generic phones and UNKNOWN are never listed. An OUI
// vendor guess alone does NOT qualify. `?include=all` bypasses the whitelist
// for the diagnostics surface.

/** Live BLASTI beacons → manager cards (source 'live-beacon', status ONLINE). */
function liveBeaconDeviceCards() {
  let beacons = []
  try { beacons = lanAuthority.getLiveBlastiBeacons() || [] } catch { beacons = [] }
  return beacons.map((b) => ({
    id: 'beacon:' + b.ip,
    source: 'live-beacon',
    category: 'BLASTI',
    // 0.6.102 — STRICT result-filter categories (audit fix): the announcing
    // mode decides the card type. A phone beacon in kiosk mode must render
    // as KIOSK ("PHONE/TABLET WITH BLASTI APP IN KIOSK MODE"), NOT as a
    // generic phone — the old `blasti-phone → PHONE` first-match hid the
    // kiosk category entirely for phones/tablets running kiosk mode.
    type: String(b.mode || '').toUpperCase() === 'KIOSK'
      ? 'KIOSK'
      : b.service === 'blasti-phone' || String(b.mode || '').toUpperCase() === 'PHONE'
        ? 'PHONE'
        : 'APP',
    name: b.name || `BLASTI @ ${b.ip}`,
    ip: b.ip,
    port: b.httpPort || 0,
    status: 'ONLINE',
    lastSeen: b.lastSeenAt,
    firstSeen: b.firstSeenAt,
    connectionType: 'LAN',
    capabilities: ['UDP_BEACON', 'BLASTI_APP', 'LIVE'],
    appVersion: b.appVersion,
    platform: b.platform,
    deviceTypeShared: b.deviceType,
    fingerprint: b.uid || b.instanceId || undefined,
    blastiMode: b.mode || (b.service === 'blasti-phone' ? 'phone' : 'desktop'),
    blastiInfo: { instanceId: b.instanceId || undefined, fingerprint: b.uid || undefined, pairingStatus: b.status || undefined },
    confidence: 97,
    identitySource: 'self-announced',
    identitySourcePriority: 97,
    pairable: true,
  }))
}

function devicesResponse(category, status, includeAll) {
  let devices = [...scanDevices]
  if (category) devices = devices.filter((d) => String(d.category).toUpperCase() === String(category).toUpperCase())
  if (status) devices = devices.filter((d) => String(d.status).toUpperCase() === String(status).toUpperCase())
  // 0.6.99 — signal-based whitelist (routers AND generic PC/IoT/phone/unknown
  // noise filtered; TVs and printers must have answered a discovery signal).
  if (!includeAll) {
    devices = devices.filter((d) => {
      try { return scanner.isSignalBackedDevice(d) } catch { return false }
    })
  }
  // 0.6.96 — merge LIVE beacon cards so ACTIVE BLASTI apps appear INSTANTLY
  // (before/without a scan). Scan cards at the same IP win (they are richer).
  // 0.6.101 — dedupe by FINGERPRINT too: a beacon card and a scan card for the
  // same physical device (same uid, transiently different IPs) must never
  // both render — "discovered apps double appeared in results".
  const seenIps = new Set(devices.map((d) => d.ip).filter(Boolean))
  const seenFingerprints = new Set(
    devices
      .map((d) => String(d.fingerprint || (d.blastiInfo && d.blastiInfo.fingerprint) || (d.blastiInfo && d.blastiInfo.instanceId) || '').toLowerCase())
      .filter(Boolean),
  )
  for (const card of liveBeaconDeviceCards()) {
    const cardFp = String(card.fingerprint || '').toLowerCase()
    if (card.ip && !seenIps.has(card.ip) && !(cardFp && seenFingerprints.has(cardFp))) {
      devices.push(card)
      seenIps.add(card.ip)
      if (cardFp) seenFingerprints.add(cardFp)
    }
  }
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

// ─── Raw ESC/POS network printing (0.6.78 connect protocol) ─────────────────
// Kiosk / counter ticket printing over the LAN without any OS driver:
// a raw TCP socket to the printer's JetDirect port (default 9100) carrying an
// ESC/POS receipt (header, big ticket number, service lines, optional QR,
// paper cut). Works for every ESC/POS thermal printer — Epson, Xprinter,
// GPrinter, Rongta, HP, Bixolon, … — as long as :9100 is reachable.

/** Build one ESC/POS receipt buffer. All inputs optional; sane defaults. */
function buildEscposTicket({ title, subtitle, ticketNumber, lines = [], qrData, footer, widthCols = 42 }) {
  const ESC = 0x1b
  const GS = 0x1d
  const chunks = []
  const push = (...bytes) => chunks.push(Buffer.from(bytes))
  const text = (s) => chunks.push(Buffer.from(String(s == null ? '' : s), 'latin1'))
  const textLine = (s) => { text(String(s == null ? '' : s).slice(0, widthCols)); push(0x0a) }
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

/**
 * Open a raw TCP socket to ip:port and write the payload.
 * Resolves {ok, bytesSent, latencyMs} or {ok:false, error}.
 */
function sendRawToPrinter(ip, port, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const sock = new net.Socket()
    const finish = (result) => {
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
    try { sock.connect(port, ip) } catch (err) { finish({ ok: false, error: err && err.message }) }
  })
}

/**
 * Deep-identification probe behind POST /discovery/connect.
 * TCP-connects the device's ports, asks for the BLASTI /api/discover marker,
 * and returns a connection profile the UI can act on.
 */
async function buildConnectionProfile(ip, preferredPort) {
  const portsToTry = preferredPort ? [preferredPort] : [3080, 9100, 80, 8001, 8060, 445, 631, 3389]
  const openPorts = []
  for (const p of portsToTry.slice(0, 8)) {
    // eslint-disable-next-line no-await-in-loop — bounded (≤8) sequential probes
    if (await scanner.tcpProbePort(ip, p, 900)) openPorts.push(p)
  }
  // BLASTI identity (kiosk vs desktop, version, role)
  let blasti = null
  const blastiPorts = [...new Set([preferredPort, 3080, 3003, 3000].filter(Boolean))]
  for (const p of blastiPorts) {
    // eslint-disable-next-line no-await-in-loop — bounded (≤4) sequential probes
    const found = await scanner.blastiIdentifyProbe(ip, p, 1200)
    if (found) { blasti = { ...found, apiPort: p }; break }
  }
  // HTTP title on the first open non-BLASTI port (best-effort name hint)
  let httpTitle
  const httpPort = openPorts.find((p) => p === 80 || p === 8080 || p === 5000) || openPorts[0]
  if (httpPort && !blasti) {
    const probe = await scanner.httpProbe(ip, httpPort, { timeoutMs: 1200 })
    if (probe && probe.title) httpTitle = probe.title
  }
  const fp = scanner.fingerprintDevice({
    ip,
    port: preferredPort || openPorts[0] || 0,
    httpTitle,
    httpServer: blasti ? 'blasti-local' : undefined,
    tcpServices: openPorts.map((p) => {
      const entry = scanner.TCP_SWEEP_PORTS.find((t) => t.port === p)
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

// ─── Route registration ──────────────────────────────────────────────────────

module.exports = function registerAgencyDeviceRoutes(app, ctx) {
  const { authMiddleware, requireAgencyId, broadcast, diagLog, getDb } = ctx
  // 0.6.88 — DEVICE EVENT STREAM: every scan/pair/link/kiosk event below is
  // emitted through lib/device-event.js (local diag trail + cloud _devices
  // stream via the local /api/logs forward pipeline).
  deviceEvents.setDiagLogger(diagLog)

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
    const includeAll = c.req.query('include') === 'all'
    return c.json(devicesResponse(category, status, includeAll))
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

  // ═══ 0.6.96 — pair-by-identity + probe + cast snapshot ═══════════════════

  // POST /discovery/probe — TCP reachability probe (CLOUD PARITY: this route
  // existed only on the cloud API, so the manager's printer "Test" button 404'd
  // inside Electron forever). Body { ip, port?, timeoutMs? }.
  app.post('/api/agency-devices/discovery/probe', authMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ip = str(body.ip, 50)
    if (!ip) return c.json({ success: false, error: 'ip: required string' }, 400)
    // 0.6.103 — a locally-attached USB printer has NO JetDirect listener on
    // 127.0.0.1:9100, so the old TCP probe always failed ("الطابعة لا تستجيب").
    // For loopback targets the honest reachability check is the OS printer
    // list: the card is reachable when the named/any local printer exists.
    if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') {
      try {
        const peripherals = typeof scanner.getLocalPeripheralsCached === 'function' ? scanner.getLocalPeripheralsCached() : []
        const wanted = typeof body.cupsName === 'string' ? body.cupsName : ''
        const match = wanted
          ? peripherals.find((p) => p && (p.cupsName === wanted || p.name === wanted))
          : (peripherals.find((p) => p && p.cupsName) || peripherals[0] || null)
        if (match) {
          return c.json({ success: true, reachable: true, latencyMs: 1, ip, via: 'os-printer', printer: match.name || match.cupsName || null })
        }
        return c.json({ success: true, reachable: false, latencyMs: null, ip, error: 'No OS printer found on this machine' })
      } catch (err) {
        return c.json({ success: true, reachable: false, latencyMs: null, ip, error: (err && err.message) || 'OS printer enumeration failed' })
      }
    }
    const port = optInt(body.port, 1, 65535) || 9100
    const timeoutMs = Math.min(Math.max(Number(body.timeoutMs || body.timeout || 3000), 300), 8000)
    const startedAt = Date.now()
    const reachable = await scanner.tcpProbePort(ip, port, timeoutMs)
    return c.json({ success: true, reachable, latencyMs: reachable ? Date.now() - startedAt : null, ip, port })
  })

  // GET /discovery/cast/snapshot.jpg — the TV-board snapshot pushed to DLNA /
  // Chromecast / Roku renderers. PUBLIC on purpose: the TV cannot authenticate,
  // and the payload is just the last captured board image (LAN-only surface,
  // no tokens, no secrets). main.js registers the real capture provider.
  app.get('/api/agency-devices/discovery/cast/snapshot.jpg', async (c) => {
    const buf = await castService.getLastSnapshot()
    if (!buf) return c.json({ success: false, error: 'No board snapshot captured yet' }, 404)
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
  })

  // POST /discovery/pairing-request-by-identity — "Request pairing" button on
  // the SCAN RESULTS (user requirement 0.6.96): a discovered BLASTI card
  // (phone in pairing standby, kiosk shell, desktop app) carries its
  // self-announced fingerprint; the manager pairs it directly WITHOUT waiting
  // for the /unpaired strip (which only lists devices that already managed a
  // discover-register round-trip).
  //   fingerprint found + already ours  → auto-connect (mark ONLINE)
  //   fingerprint found + orphan        → PAIRING_REQUEST command
  //   fingerprint unknown               → create the orphan, then request
  app.post('/api/agency-devices/discovery/pairing-request-by-identity', authMiddleware, async (c) => {
    const db = c.get('db')
    const user = c.get('user')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const body = await c.req.json().catch(() => ({}))
      const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 200) : ''
      const ip = optStr(body.ip, 50) || null
      const port = optInt(body.port, 1, 65535) || null
      const rawName = typeof body.name === 'string' ? body.name.slice(0, 100) : ''
      const rawType = String(body.deviceType || body.blastiMode || '').toUpperCase()
      // 0.6.102 — audit fix: a PHONE card pairs into a PHONE row. The old
      // mapping collapsed every non-TV/KIOSK/PRINTER type into APP, so a
      // paired phone rendered as "BLASTI App" (desktop) in the registry and
      // the device tree — wrong role for the shared-queue purpose.
      const deviceType = rawType === 'TV' ? 'TV'
        : rawType === 'KIOSK' ? 'KIOSK'
          : rawType === 'PRINTER' ? 'PRINTER'
            : rawType === 'PHONE' ? 'PHONE'
              : 'APP'
      if (!fingerprint && !ip) {
        return c.json({ success: false, error: 'fingerprint or ip required' }, 400)
      }

      let device = fingerprint
        ? await db.agencyDevice.findFirst({ where: { deviceFingerprint: fingerprint } })
        : null
      if (!device && ip && fingerprint) {
        device = await db.agencyDevice.findFirst({ where: { ipAddress: ip, status: 'PAIRING' } })
      }

      if (device && device.agencyId && device.agencyId !== agencyId) {
        return c.json({ success: false, error: 'Device is already paired with another agency' }, 409)
      }

      let created = false
      if (!device) {
        device = await db.agencyDevice.create({
          data: {
            agencyId: null,
            name: rawName || 'BLASTI Device',
            type: deviceType,
            status: 'PAIRING',
            connectionType: 'LAN',
            // 0.6.100 — the manager MINTS the device token: the device adopts
            // it on accept, so both stores share ONE canonical token (this is
            // what later authorizes USB print forwards to the host PC).
            deviceToken: crypto.randomBytes(32).toString('hex'),
            ipAddress: ip,
            port,
            deviceFingerprint: fingerprint || null,
            lastHeartbeatAt: new Date(),
            statusChangedAt: new Date(),
          },
        })
        created = true
      }

      if (device.agencyId === agencyId) {
        // Already ours → auto-connect (it was detected on the LAN again).
        const now = new Date()
        const wasOffline = device.status !== 'ONLINE'
        const updated = await db.agencyDevice.update({
          where: { id: device.id },
          data: {
            status: 'ONLINE',
            statusChangedAt: now,
            connectedAt: device.connectedAt || now,
            lastHeartbeatAt: now,
            ...(ip && device.ipAddress !== ip ? { ipAddress: ip } : {}),
            ...(port && device.port !== port ? { port } : {}),
          },
          select: DEVICE_SELECT_FIELDS,
        })
        broadcastSafe('agency-device:connected', { agencyId, deviceId: device.id, deviceName: device.name })
        broadcastSafe('device:online', { agencyId, deviceId: device.id })
        deviceEvents.deviceEvent('connect_success', `Auto-connected detected device: ${device.name || device.id}`, { deviceId: device.id, deviceName: device.name, deviceType: device.type, agencyId, status: 'ONLINE' })
        return c.json({ success: true, autoConnected: true, wasOffline, device: updated })
      }

      // Orphan (existing or just created) → refresh presence + pairing request.
      const now = new Date()
      await db.agencyDevice.update({
        where: { id: device.id },
        data: { status: 'PAIRING', lastHeartbeatAt: now, ...(ip ? { ipAddress: ip } : {}), ...(port ? { port } : {}) },
      })
      const agency = await db.agency.findUnique({
        where: { id: agencyId },
        select: { id: true, name: true, nameAr: true, nameFr: true, customCode: true },
      })
      if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)
      const command = await db.deviceCommand.create({
        data: {
          deviceId: device.id,
          type: 'PAIRING_REQUEST',
          payload: JSON.stringify({
            agencyId: agency.id,
            agencyName: agency.name,
            agencyNameAr: agency.nameAr,
            agencyNameFr: agency.nameFr,
            customCode: agency.customCode || undefined,
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
      // 0.6.101 — INSTANT delivery: push the request into the waiting device's
      // pre-pairing socket room (keyed by device id + fingerprint). The 5s
      // poll stays as the fallback, but the socket push removes the whole
      // "pairing request never reached the kiosk" class of delays.
      broadcastSafe('pairing-request', {
        id: command.id,
        agencyId: agency.id,
        agencyName: agency.name,
        agencyNameAr: agency.nameAr,
        agencyNameFr: agency.nameFr,
        sentByName: user.fullName || user.username,
        deviceId: device.id,
        fingerprint: device.deviceFingerprint || fingerprint || undefined,
        deviceToken: device.deviceToken || undefined,
        sentAt: command.createdAt,
      })

      deviceEvents.deviceEvent('pairing_requested', `Pairing request (scan-result) sent to ${device.name} by ${user.fullName || user.username}`, { deviceId: device.id, deviceName: device.name, deviceType: device.type || deviceType, agencyId: agency.id, sessionId: command.id })

      // ── 0.6.99 — CROSS-STORE DELIVERY FALLBACKS ───────────────────────────
      // The command above lives in THIS store. The waiting device may poll a
      // DIFFERENT store (a kiosk shell polls its own local API; a tablet that
      // missed the LAN sweep polls the cloud) — then the request never
      // arrives ("pairing request is not reaching to the kiosk device").
      // Two best-effort relays close the gap:
      //   (1) LAN DIRECT — the discovered device runs its own BLASTI local
      //       API: POST the offer straight to it, landing the command in the
      //       store the kiosk actually polls.
      //   (2) CLOUD RELAY — 0.6.101: attempted for EVERY orphan, not just
      //       freshly-created ones. The old `if (created)` gate silently
      //       dropped the relay whenever the device had ALREADY registered
      //       here — but that says nothing about which store the DEVICE
      //       polls; a kiosk registered locally yet polling the cloud never
      //       saw its request.
      const delivery = { lanOffer: false, cloudRelay: false, needsApproval: false }
      if (ip && port && port > 0) {
        try {
          const offerCtl = new AbortController()
          const offerTimer = setTimeout(() => offerCtl.abort(), 2500)
          const offerRes = await fetch(`http://${ip}:${port}/api/agency-devices/public/pairing-offer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fingerprint: device.deviceFingerprint || fingerprint || undefined,
              deviceName: device.name || undefined,
              // 0.6.100 — shared identity + acceptance fields: the target PC
              // uses deviceType to pop its Accept/Reject dialog, and adopts
              // deviceToken on accept (single canonical token across stores).
              deviceType: deviceType === 'APP' ? 'desktop' : deviceType.toLowerCase(),
              deviceToken: device.deviceToken || undefined,
              managerIp: ctx.getManagerIp ? ctx.getManagerIp() : undefined,
              agencyId: agency.id,
              agencyName: agency.name,
              agencyNameAr: agency.nameAr || undefined,
              agencyNameFr: agency.nameFr || undefined,
              customCode: agency.customCode || undefined,
              sentByName: user.fullName || user.username,
            }),
            signal: offerCtl.signal,
          })
          clearTimeout(offerTimer)
          const offerData = await offerRes.json().catch(() => null)
          delivery.lanOffer = !!(offerData && offerData.success)
          delivery.needsApproval = !!(offerData && offerData.needsApproval)
        } catch { /* offline / firewall — the local command + cloud relay remain */ }
      }
      // 0.6.101 — ALWAYS relay (not only when `created`): which store the
      // DEVICE polls is unknowable from here, so a session token + cloud
      // session means the relay is cheap insurance against the store mismatch.
      const token = typeof ctx.getSessionToken === 'function' ? ctx.getSessionToken() : null
      if (token && typeof ctx.cloudFetch === 'function') {
        try {
          const cloudRes = await ctx.cloudFetch('/api/agency-devices/discovery/pairing-request-by-identity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({
              fingerprint: fingerprint || undefined,
              name: rawName || device.name || undefined,
              ip: ip || undefined,
              port: port || undefined,
              deviceType: deviceType,
            }),
          }, { timeoutMs: 6000, attempts: 1 })
          const cloudData = await cloudRes.json().catch(() => null)
          delivery.cloudRelay = !!(cloudData && cloudData.success)
        } catch (relayErr) {
          if (diagLog) diagLog('AGENCY-DEVICE pairing cloud relay skipped: ' + (relayErr && relayErr.message))
        }
      }

      return c.json({
        success: true,
        created,
        deviceId: device.id,
        commandId: command.id,
        delivery,
        message: `Pairing request sent to ${device.name}`,
      })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE pairing-by-identity error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to send pairing request' }, 500)
    }
  })

  // ═══ Connect protocol (0.6.78) ═══════════════════════════════════════════
  // Deep-identify one discovered device and return its connection profile —
  // the ports that are actually open, whether it is a BLASTI instance (and in
  // which mode), and which cast/print protocols the UI can offer. Also marks
  // the device as verified in the persistent discovery cache.

  app.post('/api/agency-devices/discovery/connect', authMiddleware, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ip = str(body.ip, 50)
    if (!ip) return c.json({ success: false, error: 'ip: required string' }, 400)
    const port = optInt(body.port, 1, 65535)
    const startedAt = Date.now()
    try {
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
      // 0.6.88 — device event stream: deep-identify probe outcome.
      deviceEvents.deviceEvent(
        profile.reachable ? 'connect_success' : 'connect_failed',
        `Connection probe ${ip}:${port || 0} — ${profile.reachable ? `reachable as ${profile.type || 'unknown'}` : 'unreachable'}`,
        { deviceType: profile.type, status: profile.reachable ? 'ONLINE' : 'OFFLINE', latencyMs: profile.latencyMs, ip, port: port || undefined },
        profile.reachable ? 'info' : 'warn',
      )
      return c.json({ success: true, verified: profile.reachable, profile })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE connect error: ' + (err && err.message))
      // 0.6.88 — device event stream: probe crashed.
      deviceEvents.deviceEvent('connect_failed', `Connection probe ${ip} failed: ${err && err.message ? String(err.message).slice(0, 150) : 'unknown error'}`, { ip, port: port || undefined }, 'error')
      return c.json({ success: false, error: 'Connect probe failed' }, 500)
    }
  })

  // Raw ESC/POS ticket print — accepts EITHER a staff session (manager "print
  // test page") OR a kiosk deviceToken in the X-Device-Token header, so a
  // kiosk can print its tickets on the agency's LAN printer without any OS
  // driver. The printer target: explicit ip:port, else the agency's saved
  // default printer.
  const printAuth = async (c, next) => {
    const deviceToken = c.req.header('x-device-token')
    if (deviceToken && typeof getDb === 'function') {
      try {
        const db = getDb()
        const device = await db.agencyDevice.findUnique({ where: { deviceToken } })
        if (device) {
          c.set('db', db)
          c.set('printDevice', device)
          await next()
          return
        }
      } catch { /* fall through to staff auth */ }
    }
    return authMiddleware(c, next)
  }

  app.post('/api/agency-devices/discovery/print', printAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const db = c.get('db')
    const kioskDevice = c.get('printDevice')
    let ip = optStr(body.ip, 50)
    let port = optInt(body.port, 1, 65535)

    // 0.6.100 — registered USB-attached printer (cascade peripherals): the
    // printer is physically plugged into a HOST branch PC — the raw TCP path
    // below cannot reach it. Resolve the AgencyDevice row and forward the job
    // to the host's local API, authenticated with the host's adopted token.
    const printerDeviceId = typeof body.printerDeviceId === 'string' ? body.printerDeviceId : ''
    if (printerDeviceId) {
      try {
        const printerRow = await db.agencyDevice.findUnique({ where: { id: printerDeviceId } })
        const cfg = printerRow && typeof printerRow.printerConfig === 'string'
          ? JSON.parse(printerRow.printerConfig || '{}')
          : (printerRow && printerRow.printerConfig) || {}
        if (printerRow && printerRow.type === 'PRINTER' && cfg && cfg.attachment === 'USB' && cfg.hostIp) {
          const hostPort = Number(cfg.hostPort) > 0 ? Number(cfg.hostPort) : 3080
          const hostToken = printerRow.deviceToken || ''
          if (!hostToken) {
            return c.json({ success: false, error: 'HOST_NOT_PAIRED — pair the host PC first so print jobs can be authenticated' }, 409)
          }
          const ctl = new AbortController()
          const timer = setTimeout(() => ctl.abort(), 20_000)
          try {
            const fwd = await fetch(`http://${cfg.hostIp}:${hostPort}/api/agency-devices/host/print-job`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + hostToken },
              body: JSON.stringify({
                printerName: cfg.cupsName || cfg.osPrinterName || printerRow.name || undefined,
                cupsName: cfg.cupsName || undefined,
                ticket: body.ticket || undefined,
                escposBase64: body.escposBase64 || undefined,
              }),
              signal: ctl.signal,
            })
            const fwdData = await fwd.json().catch(() => null)
            if (fwd.ok && fwdData && fwdData.success) {
              try { deviceEvents.deviceEvent('print_job_done', `USB print job forwarded to host ${cfg.hostIp}:${hostPort} for ${printerRow.name}`, { deviceType: 'PRINTER', status: 'OK', sessionId: printerDeviceId, source: 'usb-forward' }) } catch { /* log only */ }
              return c.json({ success: true, via: 'host-forward', host: `${cfg.hostIp}:${hostPort}` })
            }
            return c.json({ success: false, error: (fwdData && fwdData.error) || `Host print failed (${fwd.status})`, host: `${cfg.hostIp}:${hostPort}` }, 502)
          } finally {
            clearTimeout(timer)
          }
        }
      } catch (fwdErr) {
        if (diagLog) diagLog('AGENCY-DEVICE print usb-forward error: ' + (fwdErr && fwdErr.message))
      }
    }

    // No explicit target → the agency's saved default printer
    let defaultPrinterRow = null
    if (!ip) {
      const agencyId = kioskDevice ? kioskDevice.agencyId : requireAgencyId(c)
      if (!agencyId) return c.json({ success: false, error: 'ip required (no default printer context)' }, 400)
      try {
        const def = await db.defaultPrinter.findUnique({ where: { agencyId } })
        if (def && def.ip) {
          defaultPrinterRow = def
          ip = def.ip
          port = port || (def.port || 9100)
        }
      } catch { /* fall through */ }
    }
    if (!ip) return c.json({ success: false, error: 'No printer target — save a default printer or pass ip' }, 400)

    // 0.6.103 — LOCALLY-ATTACHED (USB / loopback) printers: raw JetDirect TCP
    // can never reach a printer plugged into THIS PC's USB port — the old code
    // probed 127.0.0.1:9100 and always answered "connect ECONNREFUSED 127.0.0.1:9100"
    // ("the printer does not respond"). Route these jobs through the OS print
    // service (CUPS raw / Electron silent print) instead.
    const isLoopbackTarget = ip === '127.0.0.1' || ip === 'localhost' || ip === '::1'
      || (defaultPrinterRow && defaultPrinterRow.connectionType === 'USB')
      || (!defaultPrinterRow && !port && typeof body.connectionType === 'string' && body.connectionType.toUpperCase() === 'USB')
    if (isLoopbackTarget) {
      const osPrint = require('./lib/os-print')
      const isTest = !!body.test
      const ticket = body.ticket && typeof body.ticket === 'object' ? body.ticket : {}
      const printerName = (body.cupsName || (defaultPrinterRow && (defaultPrinterRow.cupsName || defaultPrinterRow.name)) || (isTest ? undefined : ticket.printerName) || '').trim()
      const localTicket = isTest
        ? {
            agencyName: 'BLASTI',
            branchName: 'Printer test page (OS print service)',
            ticketNumber: 'T-001',
            lines: [
              { left: 'Date', right: new Date().toISOString().slice(0, 19).replace('T', ' ') },
              { left: 'Printer', right: printerName || 'system default' },
              { left: 'Path', right: 'USB / OS print service' },
            ],
            footer: 'If you can read this, the printer works.',
          }
        : ticket
      const localRes = await osPrint.printLocalTicket({
        printerName: printerName || undefined,
        cupsName: (body.cupsName || (defaultPrinterRow && defaultPrinterRow.cupsName) || undefined),
        ticket: localTicket,
        escposBase64: typeof body.escposBase64 === 'string' ? body.escposBase64 : undefined,
      })
      try { deviceEvents.deviceEvent(localRes.ok ? 'print_job_done' : 'print_job_failed', localRes.ok
        ? `Local USB print job completed on ${printerName || 'system default'}`
        : `Local USB print failed: ${localRes.error}`, { deviceType: 'PRINTER', status: localRes.ok ? 'OK' : 'FAILED', source: 'usb-local' }) } catch { /* log only */ }
      if (!localRes.ok) {
        return c.json({ success: false, error: localRes.error || 'Local OS print failed', target: printerName || 'system default' }, 502)
      }
      return c.json({ success: true, via: localRes.via || 'os-print', target: printerName || 'system default' })
    }

    // Ticket content: either a structured ticket, or a simple test page
    const isTest = !!body.test
    const ticket = body.ticket && typeof body.ticket === 'object' ? body.ticket : {}
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
        : (Array.isArray(ticket.lines) ? ticket.lines : []),
      qrData: ticket.qrData,
      footer: ticket.footer || (isTest ? 'BLASTI' : 'Thank you'),
    })
    const result = await sendRawToPrinter(ip, port || 9100, payload, 6000)
    if (!result.ok) {
      return c.json({ success: false, error: result.error || 'Printer unreachable', target: `${ip}:${port || 9100}` }, 502)
    }
    return c.json({ success: true, bytesSent: result.bytesSent, latencyMs: result.latencyMs, target: `${ip}:${port || 9100}` })
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

  // 0.6.100 — CASCADE PERIPHERAL REGISTRATION: a discovered USB printer that
  // is physically attached to ANOTHER branch PC (source 'peripheral-report',
  // hostIp/hostName carry the host) is registered here as a PRINTER
  // AgencyDevice. The printerConfig JSON pins the attachment: hostIp/hostPort
  // is where print jobs get forwarded, cupsName/usb ids identify the queue.
  app.post('/api/agency-devices/discovery/register-peripheral', authMiddleware, async (c) => {
    const db = c.get('db')
    const agencyId = requireAgencyId(c)
    if (!agencyId) return
    try {
      const body = await c.req.json().catch(() => ({}))
      const printer = body.printer && typeof body.printer === 'object' ? body.printer : {}
      const name = (typeof printer.name === 'string' && printer.name.trim() && printer.name.trim()) ||
        (typeof body.name === 'string' && body.name.trim() && body.name.trim()) || ''
      const hostIp = (typeof body.hostIp === 'string' && body.hostIp.trim()) || (typeof printer.hostIp === 'string' && printer.hostIp.trim()) || ''
      if (!name) return c.json({ success: false, error: 'printer.name is required' }, 400)
      if (!hostIp) return c.json({ success: false, error: 'hostIp is required (which PC owns the USB printer?)' }, 400)
      const hostPort = optInt(body.hostPort, 1, 65535) || 3080
      // Idempotent: same host + same USB/CUPS identity updates the same row.
      const cupsName = typeof printer.cupsName === 'string' ? printer.cupsName.slice(0, 120) : null
      const usbVendorId = typeof printer.usbVendorId === 'string' ? printer.usbVendorId.slice(0, 20) : null
      const usbProductId = typeof printer.usbProductId === 'string' ? printer.usbProductId.slice(0, 20) : null
      const fingerprintKey = [cupsName || '', usbVendorId || '', usbProductId || '', name].join('|')
      const existing = await db.agencyDevice.findFirst({
        where: { agencyId, type: 'PRINTER', connectionType: 'USB' },
      })
      let row = null
      for (const cand of (existing ? [existing] : [])) {
        try {
          const cfg = typeof cand.printerConfig === 'string' ? JSON.parse(cand.printerConfig || '{}') : (cand.printerConfig || {})
          const candKey = [cfg.cupsName || '', cfg.usbVendorId || '', cfg.usbProductId || '', cand.name || ''].join('|')
          if (cfg.hostIp === hostIp && candKey === fingerprintKey) { row = cand; break }
        } catch { /* corrupt config — skip */ }
      }
      const printerConfig = JSON.stringify({
        attachment: 'USB',
        hostIp,
        hostPort,
        hostDeviceId: typeof body.hostDeviceId === 'string' ? body.hostDeviceId.slice(0, 80) : null,
        hostInstanceId: typeof body.hostInstanceId === 'string' ? body.hostInstanceId.slice(0, 80) : null,
        hostName: typeof body.hostName === 'string' ? body.hostName.slice(0, 100) : null,
        cupsName,
        cupsUri: typeof printer.cupsUri === 'string' ? printer.cupsUri.slice(0, 200) : null,
        usbVendorId,
        usbProductId,
        osPrinterName: typeof printer.osPrinterName === 'string' ? printer.osPrinterName.slice(0, 120) : null,
        registeredFrom: 'cascade-discovery',
        registeredAt: new Date().toISOString(),
      })
      if (row) {
        row = await db.agencyDevice.update({
          where: { id: row.id },
          data: { name: name.slice(0, 100), printerConfig, ipAddress: hostIp, port: hostPort, lastHeartbeatAt: new Date() },
        })
      } else {
        row = await db.agencyDevice.create({
          data: {
            agencyId,
            branchId: typeof body.branchId === 'string' && body.branchId ? body.branchId : null,
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
      broadcastSafe('device:registered', { agencyId, deviceId: row.id, deviceName: row.name, deviceType: row.type })
      deviceEvents.deviceEvent('peripheral_registered', `USB printer "${row.name}" registered via host ${hostIp}:${hostPort} (cascade discovery)`, { deviceId: row.id, deviceName: row.name, deviceType: 'PRINTER', agencyId, status: 'ONLINE', source: 'cascade' })
      return c.json({ success: true, device: row })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE register-peripheral error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to register peripheral' }, 500)
    }
  })

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

  // 0.6.96 — LAN-REACHABLE URL BUILDER. The historic code built the board URL
  // from the REQUEST origin — inside Electron that is http://127.0.0.1:3080,
  // a loopback address NO TV can fetch. Every cast URL is now built from the
  // host's real LAN IP (lan-origin.bestLanIp), so Samsung/LG/DLNA/Chromecast
  // targets load the actual board.
  const buildLanTvBoardUrl = (agencyIdForUrl) => {
    let lanIp = null
    let apiPort = Number(process.env.BLASTI_LOCAL_PORT) || 3080
    try {
      const lanOrigin = require('./lib/lan-origin')
      lanIp = lanOrigin.bestLanIp()
    } catch { /* fall through to loopback */ }
    const base = lanIp ? `http://${lanIp}:${apiPort}` : `http://127.0.0.1:${apiPort}`
    return `${base}/?mode=device&type=TV&agencyId=${agencyIdForUrl || ''}`
  }

  // Capture (or reuse a fresh) board snapshot and return its LAN URL — the
  // media form DLNA / Chromecast / Roku renderers can actually display.
  const snapshotMediaUrl = async (boardUrl, lanBase) => {
    const buf = await castService.captureSnapshot(boardUrl)
    if (!buf) return null
    const ts = castService.getLastSnapshotTs() || Date.now()
    return `${lanBase}/api/agency-devices/discovery/cast/snapshot.jpg?ts=${ts}`
  }

  // POST /discovery/cast — 0.6.96 rework. Cast order:
  //   1. 'blasti-tv' (DIRECT): the target is a REGISTERED TV of this agency
  //      (by deviceId or by IP) → CAST_URL device command → the TV's board
  //      app navigates to the board. Live, LAN-direct, no browser involved.
  //   2. Vendor protocols: Samsung Tizen WS, LG webOS WS (they load the board
  //      URL in the TV's own web engine).
  //   3. Media protocols: DLNA SOAP, Chromecast CASTv2, Roku ECP — these push
  //      the board SNAPSHOT JPEG (a media renderer cannot load a web page).
  //   4. NO browser fallback — if everything fails we say so honestly.
  app.post('/api/agency-devices/discovery/cast', authMiddleware, async (c) => {
    const user = c.get('user')
    const db = c.get('db')
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
      const deviceId = body.deviceId ? String(body.deviceId) : null

      if (!ip && !deviceId) {
        return c.json({ success: false, error: 'IP required' }, 400)
      }

      const apiPort = Number(process.env.BLASTI_LOCAL_PORT) || 3080
      const lanIp = (() => { try { return require('./lib/lan-origin').bestLanIp() } catch { return null } })()
      const lanBase = lanIp ? `http://${lanIp}:${apiPort}` : new URL(c.req.url).origin
      const tvBoardUrl = buildLanTvBoardUrl(user.agencyId)

      // ── 1. BLASTI-TV DIRECT ── a registered TV renders the board itself;
      // casting = one CAST_URL command over the existing command channel.
      let registeredTv = null
      if (deviceId) {
        registeredTv = await db.agencyDevice.findFirst({
          where: { id: deviceId, agencyId: user.agencyId, type: { in: ['TV', 'DISPLAY'] }, status: { not: 'DISABLED' } },
          select: { id: true, name: true, type: true, ipAddress: true },
        })
      } else if (ip) {
        registeredTv = await db.agencyDevice.findFirst({
          where: { agencyId: user.agencyId, type: { in: ['TV', 'DISPLAY'] }, ipAddress: ip, status: { not: 'DISABLED' } },
          select: { id: true, name: true, type: true, ipAddress: true },
        })
      }
      const wantsDirect = !protocol || protocol === 'blasti-tv' || protocol === 'direct'
      if (registeredTv && wantsDirect) {
        const command = await db.deviceCommand.create({
          data: {
            deviceId: registeredTv.id,
            type: 'CAST_URL',
            payload: JSON.stringify({ url: tvBoardUrl, agencyId: user.agencyId }),
            status: 'PENDING',
            ttl: 300,
          },
        })
        broadcastSafe('agency-device:updated', { agencyId: user.agencyId, deviceId: registeredTv.id })
        deviceEvents.deviceEvent('cast_sent', `Direct board cast to registered TV ${registeredTv.name || registeredTv.id} (CAST_URL)`, { deviceId: registeredTv.id, deviceName: registeredTv.name, deviceType: registeredTv.type, agencyId: user.agencyId, sessionId: command.id })
        return c.json({
          success: true,
          protocol: 'blasti-tv',
          castKind: 'direct',
          tvBoardUrl,
          message: `Board cast sent directly to ${registeredTv.name || 'TV'} (BLASTI app)`,
        })
      }

      // ── 2/3. Vendor + media protocols ──
      const target = { ip, port, manufacturer, ssdpLocation, mdnsService, name: String(body.name || 'BLASTI TV') }
      const sendVia = async (proto) => {
        // Webview-capable protocols load the live board URL; media renderers
        // get the JPEG snapshot (captured from the real board).
        const mediaProto = proto === 'dlna' || proto === 'roku-ecp' || proto === 'roku' || proto === 'google-cast'
        let mediaUrl = tvBoardUrl
        if (mediaProto && lanIp) {
          mediaUrl = (await snapshotMediaUrl(tvBoardUrl, lanBase)) || tvBoardUrl
        }
        if (proto === 'dlna') return castService.castViaDlna(target, mediaUrl)
        if (proto === 'samsung-tizen' || proto === 'samsung') return castService.castViaSamsungTizen(target, tvBoardUrl)
        if (proto === 'lg-webos' || proto === 'lg') return castService.castViaLgWebOS(target, tvBoardUrl)
        if (proto === 'roku-ecp' || proto === 'roku') return castService.castViaRokuEcp(target, mediaUrl)
        if (proto === 'google-cast') return castService.castViaGoogleCast(target, mediaUrl, { title: 'BLASTI Queue Board' })
        return { success: false, message: `Unknown protocol ${proto}` }
      }

      if (protocol && protocol !== 'url' && protocol !== 'auto') {
        try {
          const result = await sendVia(protocol)
          if (result && result.success !== false) {
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

      // Auto order: brand-native first, then CASTv2, then DLNA, then Roku.
      const man = manufacturer.toLowerCase()
      const autoOrder = []
      if (man.includes('samsung') || port === 8001 || port === 9197) autoOrder.push('samsung-tizen')
      if (man.includes('lg') || man.includes('webos') || port === 3000) autoOrder.push('lg-webos')
      if (mdnsService.toLowerCase().includes('googlecast') || man.includes('google') || port === 8009 || port === 8008) autoOrder.push('google-cast')
      autoOrder.push('dlna')
      if (man.includes('roku') || port === 8060) autoOrder.push('roku-ecp')
      for (const proto of autoOrder) {
        try {
          const result = await sendVia(proto)
          if (result && result.success !== false) {
            return c.json({
              success: true,
              protocol: proto.startsWith('samsung') ? 'samsung-tizen' : proto.startsWith('lg') ? 'lg-webos' : proto.startsWith('roku') ? 'roku-ecp' : proto,
              castKind: proto,
              tvBoardUrl,
              message: result.message || `Cast sent via ${proto} to ${ip}`,
            })
          }
        } catch { /* try the next protocol */ }
      }
      return c.json({
        success: false,
        castKind: 'none',
        tvBoardUrl,
        ssdpLocation,
        message: 'No cast protocol reachable on this TV (DLNA/Tizen/webOS/CASTv2/Roku all failed). Save it and retry, or use HDMI.',
      }, 200)
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE cast error: ' + (err && err.message))
      return c.json({ success: false, error: 'Cast failed' }, 500)
    }
  })

  // Per-protocol cast endpoints the cast dialog calls (no cloud equivalent —
  // desktop implements them for real device casting). 0.6.96: all URLs are
  // LAN-reachable and DLNA pushes the board snapshot JPEG.
  app.post('/api/agency-devices/discovery/cast/dlna', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const tvBoardUrl = buildLanTvBoardUrl(user && user.agencyId)
      const lanIp = (() => { try { return require('./lib/lan-origin').bestLanIp() } catch { return null } })()
      const lanBase = lanIp ? `http://${lanIp}:${Number(process.env.BLASTI_LOCAL_PORT) || 3080}` : new URL(c.req.url).origin
      const mediaUrl = lanIp ? ((await snapshotMediaUrl(tvBoardUrl, lanBase)) || tvBoardUrl) : tvBoardUrl
      const target = {
        ip: String(body.ip || ''),
        port: Number(body.port) || 0,
        manufacturer: String(body.manufacturer || ''),
        ssdpLocation: String(body.ssdpLocation || ''),
        mdnsService: String(body.mdnsService || ''),
      }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaDlna(target, mediaUrl)
      return c.json({ success: !!(result && result.ok !== false && result.success !== false), protocol: 'dlna', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'dlna', message: err && err.message ? err.message : 'DLNA cast failed' })
    }
  })

  app.post('/api/agency-devices/discovery/cast/samsung', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const tvBoardUrl = buildLanTvBoardUrl(user && user.agencyId)
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
      const tvBoardUrl = buildLanTvBoardUrl(user && user.agencyId)
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
      const tvBoardUrl = buildLanTvBoardUrl(user && user.agencyId)
      const lanIp = (() => { try { return require('./lib/lan-origin').bestLanIp() } catch { return null } })()
      const lanBase = lanIp ? `http://${lanIp}:${Number(process.env.BLASTI_LOCAL_PORT) || 3080}` : new URL(c.req.url).origin
      const mediaUrl = lanIp ? ((await snapshotMediaUrl(tvBoardUrl, lanBase)) || tvBoardUrl) : tvBoardUrl
      const target = { ip: String(body.ip || ''), port: Number(body.port) || 8060, manufacturer: String(body.manufacturer || '') }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaRokuEcp(target, mediaUrl)
      return c.json({ success: !!(result && result.ok !== false && result.success !== false), protocol: 'roku-ecp', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'roku-ecp', message: err && err.message ? err.message : 'Roku cast failed' })
    }
  })

  app.post('/api/agency-devices/discovery/cast/google-cast', authMiddleware, async (c) => {
    const user = c.get('user')
    try {
      const body = await c.req.json().catch(() => ({}))
      const tvBoardUrl = buildLanTvBoardUrl(user && user.agencyId)
      const lanIp = (() => { try { return require('./lib/lan-origin').bestLanIp() } catch { return null } })()
      const lanBase = lanIp ? `http://${lanIp}:${Number(process.env.BLASTI_LOCAL_PORT) || 3080}` : new URL(c.req.url).origin
      const mediaUrl = lanIp ? ((await snapshotMediaUrl(tvBoardUrl, lanBase)) || tvBoardUrl) : tvBoardUrl
      const target = { ip: String(body.ip || ''), port: 8009, manufacturer: String(body.manufacturer || '') }
      if (!target.ip) return c.json({ success: false, error: 'IP required' }, 400)
      const result = await castService.castViaGoogleCast(target, mediaUrl, { title: 'BLASTI Queue Board' })
      return c.json({ success: !!(result && result.success !== false), protocol: 'google-cast', tvBoardUrl, ...result })
    } catch (err) {
      return c.json({ success: false, protocol: 'google-cast', message: err && err.message ? err.message : 'Google Cast failed' })
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


  // ═══ Management ══════════════════════════════════════════════════════════

  // GET /unpaired — devices broadcasting for pairing (heartbeat ≤ 90 s)
  // 0.6.95 — split-brain fix: ALSO merge the CLOUD's unpaired orphans. A
  // kiosk that could not find this desktop on the LAN registers against the
  // cloud store, so it never appeared here and the desktop manager could not
  // send a pairing request. Cloud entries arrive prefixed `cloud-` (the
  // manager routes their pairing requests to the cloud API), deduped against
  // local entries by deviceFingerprint.
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
      // Cloud merge (best-effort — an offline desktop just sees local orphans).
      let cloudDevices = []
      try {
        const token = typeof ctx.getSessionToken === 'function' ? ctx.getSessionToken() : null
        if (token && typeof ctx.cloudFetch === 'function') {
          const cloudRes = await ctx.cloudFetch('/api/agency-devices/unpaired', {
            headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
          }, { timeoutMs: 6000, attempts: 1 })
          if (cloudRes.ok) {
            const cloudData = await cloudRes.json().catch(() => null)
            if (cloudData && cloudData.success && Array.isArray(cloudData.devices)) cloudDevices = cloudData.devices
          }
        }
      } catch (cloudErr) {
        if (diagLog) diagLog('AGENCY-DEVICE unpaired cloud merge skipped: ' + (cloudErr && cloudErr.message))
      }
      const localFingerprints = new Set(devices.map((d) => d.deviceFingerprint).filter(Boolean))
      const merged = [...devices]
      for (const cd of cloudDevices) {
        if (cd.deviceFingerprint && localFingerprints.has(cd.deviceFingerprint)) continue
        if (devices.some((d) => d.id === cd.id)) continue
        merged.push({ ...cd, id: 'cloud-' + cd.id, cloudDevice: true })
      }
      return c.json({ success: true, devices: merged })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE unpaired error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to load unpaired devices' }, 500)
    }
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
      // 0.6.88 — device event stream: pairing initiated (credentials issued).
      deviceEvents.deviceEvent('pair_started', `Pairing initiated for ${existing.name || existing.id} — new pairing code issued`, { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type, agencyId, status: 'PAIRING' })
      return c.json({ success: true, pairingCode: device.pairingCode, deviceToken })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE pair error: ' + (err && err.message))
      // 0.6.88 — device event stream: pair attempt crashed.
      deviceEvents.deviceEvent('pair_failed', `Pair attempt failed: ${err && err.message ? String(err.message).slice(0, 150) : 'unknown error'}`, { deviceId: c.req.param('id'), agencyId }, 'error')
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
      // 0.6.88 — device event stream: manual connect.
      deviceEvents.deviceEvent('connect_success', `Device marked connected: ${device.name || device.id}`, { deviceId: device.id, deviceName: device.name, deviceType: device.type, agencyId, status: 'ONLINE' })
      return c.json({ success: true, device })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE connect error: ' + (err && err.message))
      // 0.6.88 — device event stream: connect crashed.
      deviceEvents.deviceEvent('connect_failed', `Connect failed: ${err && err.message ? String(err.message).slice(0, 150) : 'unknown error'}`, { deviceId: c.req.param('id'), agencyId }, 'error')
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
      // 0.6.88 — device event stream: manual disconnect.
      deviceEvents.deviceEvent('disconnect', `Device disconnected: ${device.name || device.id}`, { deviceId: device.id, deviceName: device.name, deviceType: device.type, agencyId, status: 'OFFLINE' })
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
      // 0.6.88 — device event stream: device unlinked from the agency.
      deviceEvents.deviceEvent('unpair', `Device unpaired: ${existing.name || existing.id} (credentials invalidated)`, { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type, agencyId, status: 'OFFLINE' })
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

  // POST /:id/cast — Cast the board to a REGISTERED TV directly (0.6.96).
  // Sends one CAST_URL command over the device command channel — the TV's
  // BLASTI board app navigates to the board URL. Live board, LAN-direct,
  // no browser, works offline through the local store.
  app.post('/api/agency-devices/:id/cast', authMiddleware, async (c) => {
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
      if (!['TV', 'DISPLAY', 'KIOSK'].includes(existing.type)) {
        return c.json({ success: false, error: `Casting applies to TV/DISPLAY devices (this is a ${existing.type})` }, 400)
      }
      const body = await c.req.json().catch(() => ({}))
      let url = buildLanTvBoardUrl(agencyId)
      if (typeof body.url === 'string' && /^https?:\/\//.test(body.url)) url = body.url
      const command = await db.deviceCommand.create({
        data: {
          deviceId: existing.id,
          type: 'CAST_URL',
          payload: JSON.stringify({ url, agencyId }),
          status: 'PENDING',
          ttl: 300,
        },
      })
      broadcastSafe('agency-device:updated', { agencyId, deviceId: existing.id })
      deviceEvents.deviceEvent('cast_sent', `Board cast sent to ${existing.name || existing.id} (CAST_URL)`, { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type, agencyId, sessionId: command.id })
      return c.json({ success: true, command, url, message: `Cast sent to ${existing.name || 'TV'}` })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE cast-to-device error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to send cast command' }, 500)
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
        // 0.6.101 — deviceFingerprint selected: the socket push and the cloud
        // relay both key the delivery on the device's stable identity.
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
      // 0.6.95 — widened 90s → 10min (mirrors the cloud fix): the kiosk
      // beats every 30s but may skip a beat inside the server's dedupe
      // window; the PAIRING_REQUEST command TTL (10 min) bounds delivery.
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
      if (!device.lastHeartbeatAt || device.lastHeartbeatAt < tenMinAgo) {
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
      // 0.6.101 — INSTANT delivery into the waiting device's pre-pairing room
      // (same channel + payload shape as pairing-request-by-identity above).
      broadcastSafe('pairing-request', {
        id: command.id,
        agencyId: agency.id,
        agencyName: agency.name,
        agencyNameAr: agency.nameAr,
        agencyNameFr: agency.nameFr,
        sentByName: user.fullName || user.username,
        deviceId: device.id,
        fingerprint: device.deviceFingerprint || undefined,
        deviceToken: device.deviceToken || undefined,
        sentAt: command.createdAt,
      })
      // 0.6.101 — cross-store relay: the device may poll the CLOUD store even
      // though its orphan row lives here (discovered locally, registered in
      // the cloud earlier). Relay the same request so it lands wherever the
      // device actually listens. Best-effort — never blocks the response.
      try {
        const token = typeof ctx.getSessionToken === 'function' ? ctx.getSessionToken() : null
        if (token && device.deviceFingerprint && typeof ctx.cloudFetch === 'function') {
          await ctx.cloudFetch('/api/agency-devices/discovery/pairing-request-by-identity', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({
              fingerprint: device.deviceFingerprint,
              name: device.name || undefined,
              deviceType: device.type === 'TV' ? 'TV' : device.type === 'KIOSK' ? 'KIOSK' : 'APP',
            }),
          }, { timeoutMs: 6000, attempts: 1 })
        }
      } catch { /* relay is best-effort */ }
      // 0.6.88 — device event stream: agency sent a pairing request to a kiosk.
      deviceEvents.deviceEvent('pairing_requested', `Pairing request sent to ${device.name} by ${user.fullName || user.username}`, { deviceId: device.id, deviceName: device.name, deviceType: device.type, agencyId: agency.id, sessionId: command.id })
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
      // 0.6.88 — device event stream: kiosk credentials issued.
      deviceEvents.deviceEvent('kiosk_credentials_issued', `Kiosk credentials generated for ${existing.name || existing.id}`, { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type, agencyId })
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
      // 0.6.88 — device event stream: credentials force-regenerated.
      deviceEvents.deviceEvent('kiosk_credentials_issued', `Kiosk credentials FORCE-regenerated for ${existing.name || existing.id} (old tokens invalidated)`, { deviceId: existing.id, deviceName: existing.name, deviceType: existing.type, agencyId, status: 'PAIRING' })
      return c.json({ success: true, pairingCode, deviceToken, regenerated: true })
    } catch (err) {
      if (diagLog) diagLog('AGENCY-DEVICE kiosk-credentials regenerate error: ' + (err && err.message))
      return c.json({ success: false, error: 'Failed to regenerate kiosk credentials' }, 500)
    }
  })

  // ═══ 0.6.96 — AUTO-CONNECT on detection (beacon-driven) ═════════════════
  // "After pairing the device becomes a registered device eligible for auto
  // connection when detected." The lan-authority UDP listener hears every
  // BLASTI beacon (desktop shells + phones in pairing standby); when the
  // announcing identity matches a PAIRED device of ANY stored agency
  // (deviceFingerprint == beacon uid, or same LAN IP) the device is flipped
  // ONLINE immediately — no operator action, no scan required.
  const beaconAutoConnectState = new Map() // ip → { deviceId, lastTouchAt }
  const autoConnectFromBeacon = async (rec) => {
    if (!rec || (!rec.ip && !rec.uid)) return
    const db = typeof getDb === 'function' ? getDb() : null
    if (!db) return
    try {
      const now = Date.now()
      const seen = beaconAutoConnectState.get(rec.ip)
      if (seen && now - seen.lastTouchAt < 60_000) return // throttle: one touch/minute per IP
      const fingerprint = rec.uid || rec.instanceId || null
      const candidates = await db.agencyDevice.findMany({
        where: { agencyId: { not: null }, status: { not: 'DISABLED' } },
        select: { id: true, name: true, type: true, status: true, agencyId: true, ipAddress: true, deviceFingerprint: true, port: true, connectedAt: true, appVersion: true },
        take: 300,
      })
      const match = candidates.find((d) =>
        (fingerprint && d.deviceFingerprint === fingerprint)
        || (rec.ip && d.ipAddress === rec.ip))
      if (!match) return
      const wasOffline = match.status !== 'ONLINE'
      const touchAt = new Date()
      await db.agencyDevice.update({
        where: { id: match.id },
        data: {
          status: 'ONLINE',
          statusChangedAt: wasOffline ? touchAt : undefined,
          lastHeartbeatAt: touchAt,
          connectedAt: match.connectedAt || touchAt,
          ...(rec.ip && match.ipAddress !== rec.ip ? { ipAddress: rec.ip } : {}),
          ...(rec.appVersion && match.appVersion !== rec.appVersion ? { appVersion: rec.appVersion.slice(0, 32) } : {}),
          ...(fingerprint && !match.deviceFingerprint ? { deviceFingerprint: fingerprint.slice(0, 200) } : {}),
        },
      })
      beaconAutoConnectState.set(rec.ip, { deviceId: match.id, lastTouchAt: now })
      if (beaconAutoConnectState.size > 200) beaconAutoConnectState.clear()
      if (wasOffline) {
        broadcastSafe('agency-device:connected', { agencyId: match.agencyId, deviceId: match.id, deviceName: match.name })
        broadcastSafe('device:online', { agencyId: match.agencyId, deviceId: match.id })
        deviceEvents.deviceEvent('device_online', `Auto-connected detected device: ${match.name || match.id} (beacon @ ${rec.ip})`, { deviceId: match.id, deviceName: match.name, deviceType: match.type, agencyId: match.agencyId, status: 'ONLINE' })
      }
    } catch { /* auto-connect is best-effort */ }
  }
  try {
    lanAuthority.onBlastiBeacon((rec) => { autoConnectFromBeacon(rec).catch(() => {}) })
  } catch { /* hook registration is best-effort */ }

  if (diagLog) diagLog('AGENCY-DEVICES routes registered (management + embedded discovery + cast + live beacons)')
}
