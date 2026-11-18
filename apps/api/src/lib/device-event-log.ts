/**
 * device-event-log.ts — Unified DEVICE EVENT STREAM (0.6.88)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE canonical store for every DEVICE + KIOSK lifecycle event on the
 * platform — the classes of events that were previously invisible to support
 * and made the device-manager / kiosk-mode fault reports undiagnosable:
 *
 *   • Device-manager SCANNING (desktop LAN multi-protocol scan, mobile LAN /
 *     branch-code discovery) — started / found / completed / failed.
 *   • Device PAIRING + LINKING — pair, pairing-request, accept, reject,
 *     unpair, connect, disconnect, kiosk-credentials issued.
 *   • Device CONNECTIONS — socket join/leave/auth-fail, online/offline
 *     transitions, LAN authority joins.
 *   • KIOSK MODE — enter/exit, kiosk-auth success/fail, discover-register,
 *     credentials regenerated, TV/kiosk window open/close.
 *
 * DESIGN — same one-pipeline model as tx-log.ts (0.6.81):
 *   • CLIENT events (web console, Capacitor mobile, Electron renderer, kiosk
 *     webviews) ride the EXISTING remote-logger batch ingest
 *     (POST /api/logs) tagged `tag:'device'` + `channel:'device'`; the
 *     ingest route MIRRORS them here (routes/logs.ts).
 *   • Desktop LOCAL-API events (scan/pair/connect on the LAN box) are queued
 *     through the existing local /api/logs ingest → cloud forward, so they
 *     survive offline periods and carry the device identity.
 *   • SERVER events (socket joins, kiosk-auth, pairing decisions, cloud
 *     discovery scans, heartbeat state changes) are written DIRECTLY by this
 *     helper — one function call at each authoritative mutation point.
 *   • Both sides land in the SAME stream file with the SAME line schema, so
 *     the Logs Manager "Devices" tab (GET /api/logs/devices) sees ONE
 *     coherent timeline per device.
 *
 * Storage: ${BLASTI_LOG_DIR:-<repo>/logs}/_devices/<YYYY-MM-DD>.ndjson
 * (the `_` prefix keeps the folder out of the per-account vault listings,
 * exactly like `_transactions` and `_analysis`).
 */

import fs from 'node:fs'
import path from 'node:path'

// ─── Canonical event taxonomy ────────────────────────────────────────────────

export const DEVICE_EVENTS = [
  // device-manager scanning
  'scan_started',           // a discovery scan was kicked off
  'scan_completed',         // scan finished (found count in data)
  'scan_failed',            // scan crashed / aborted with error
  'scan_stopped',           // operator stopped the scan early
  'devices_found',          // N devices discovered (batch summary)
  // pairing / linking
  'pair_started',           // pair attempt initiated (desktop UI or cloud)
  'pair_success',           // device paired with the agency
  'pair_failed',            // pair attempt failed (reason in data)
  'unpair',                 // device unpaired (deliberate unlink)
  'pairing_requested',      // kiosk sent a pairing request (needs approval)
  'pairing_accepted',       // agency approved a pending pairing request
  'pairing_rejected',       // agency rejected a pending pairing request
  'connect_success',        // explicit connect/link succeeded
  'connect_failed',         // explicit connect/link failed
  'disconnect',             // device link dropped (deliberate or error)
  'kiosk_credentials_issued', // credentials created/regenerated for a kiosk
  // connections (cloud socket + heartbeat)
  'socket_connected',       // device/kiosk joined via socket (join:device / join:kiosk)
  'socket_disconnected',    // device socket dropped
  'socket_auth_failed',     // join:device rejected — bad device token
  'device_online',          // status transition → ONLINE
  'device_offline',         // status transition → OFFLINE (watchdog or explicit)
  'lan_join',               // LAN authority join (master election context)
  // kiosk mode
  'kiosk_enter',            // kiosk mode entered (web surface or TV window opened)
  'kiosk_exit',             // kiosk mode exited / TV window closed
  'kiosk_registered',       // kiosk self-registered via discover-register
  'kiosk_auth_success',     // kiosk credentials accepted
  'kiosk_auth_failed',      // kiosk credentials rejected
  'heartbeat_state_change', // watchdog flipped device status (OFFLINE↔ONLINE)
] as const
export type DeviceEvent = (typeof DEVICE_EVENTS)[number]

// ─── Event shape ─────────────────────────────────────────────────────────────

export interface DeviceEventIdentity {
  uid?: string | null
  userId?: string | null
  username?: string | null
  role?: string | null
  agencyId?: string | null
}

export interface DeviceEventInput {
  event: string
  message: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Structured extras — kept small; the whole line is capped. */
  data?: Record<string, unknown>
  identity?: DeviceEventIdentity
  /** 'server' for direct writes; the ingest mirror stamps 'client'. */
  origin?: 'client' | 'server'
  platform?: string
  appVersion?: string
  /** AgencyDevice row id (or local device id on the desktop box). */
  deviceId?: string | null
  deviceName?: string | null
  deviceType?: string | null
  /** Agency scope — accepted top-level too (identity.agencyId wins if both). */
  agencyId?: string | null
  /** Scan/pair correlation id — groups a scan or pairing session. */
  sessionId?: string | null
  status?: string
}

/** The canonical NDJSON line — identical for client-mirrored + server events. */
export interface DeviceEventRecord {
  ts: string
  level: string
  tag: 'device'
  channel: 'device'
  origin: 'client' | 'server'
  event: string
  message: string
  deviceId?: string
  deviceName?: string
  deviceType?: string
  sessionId?: string
  status?: string
  uid?: string | null
  userId?: string | null
  username?: string | null
  role?: string | null
  agencyId?: string | null
  platform?: string
  appVersion?: string
  data?: Record<string, unknown>
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const MAX_LINE_CHARS = 8_000
const MAX_DATA_KEYS = 24
const DAY_FILE_TRIM_BYTES = 20 * 1024 * 1024 // trim oldest half past 20 MB

export function deviceLogRoot(): string {
  return path.join(
    process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs'),
    '_devices',
  )
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function deviceDayFile(date = dayStamp()): string {
  return path.join(deviceLogRoot(), `${date}.ndjson`)
}

function sanitizeData(raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_DATA_KEYS) break
    const key = k.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)
    if (!key) continue
    if (v === undefined) continue
    if (typeof v === 'string') { out[key] = v.slice(0, 300); n++ }
    else if (typeof v === 'number' && Number.isFinite(v)) { out[key] = Math.round(v * 100) / 100; n++ }
    else if (typeof v === 'boolean') { out[key] = v; n++ }
    else if (v === null) { out[key] = null; n++ }
  }
  return n > 0 ? out : undefined
}

function safeStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return v.replace(/[^A-Za-z0-9._:@ -]/g, '').slice(0, max) || undefined
}

/** Build ONE canonical record from either side's input. Never throws. */
export function buildDeviceRecord(input: DeviceEventInput): DeviceEventRecord {
  const id = input.identity ?? {}
  let message = typeof input.message === 'string' ? input.message : String(input.message ?? '')
  if (message.length > 400) message = message.slice(0, 400) + '…'
  const event = safeStr(input.event, 40) || 'unknown'
  const deviceId = safeStr(input.deviceId, 64)
  const deviceName = safeStr(input.deviceName, 80)
  const deviceType = safeStr(input.deviceType, 24)
  const sessionId = safeStr(input.sessionId, 64)
  const status = safeStr(input.status, 24)
  const platform = safeStr(input.platform, 20)
  const appVersion = safeStr(input.appVersion, 20)
  const uid = safeStr(id.uid, 64)
  const userId = safeStr(id.userId, 64)
  const username = safeStr(id.username, 64)
  const role = safeStr(id.role, 32)
  const agencyId = safeStr(input.agencyId ?? id.agencyId, 64)
  const data = sanitizeData(input.data)
  const record: DeviceEventRecord = {
    ts: new Date().toISOString(),
    level: input.level || 'info',
    tag: 'device',
    channel: 'device',
    origin: input.origin === 'client' ? 'client' : 'server',
    event,
    message,
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(deviceType ? { deviceType } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(status ? { status } : {}),
    ...(uid ? { uid } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(role ? { role } : {}),
    ...(agencyId ? { agencyId } : {}),
    ...(platform ? { platform } : {}),
    ...(appVersion ? { appVersion } : {}),
    ...(data ? { data } : {}),
  }
  return record
}

/** Keep a day file under the byte cap: trim the oldest half when oversized. */
function trimDayFile(file: string): void {
  try {
    const st = fs.statSync(file)
    if (st.size <= DAY_FILE_TRIM_BYTES) return
    const raw = fs.readFileSync(file, 'utf8').split('\n')
    fs.writeFileSync(file, raw.slice(Math.floor(raw.length / 2)).join('\n'), 'utf8')
  } catch { /* best-effort housekeeping */ }
}

/**
 * Server-side write. NEVER throws — device/pairing mutations must never
 * break because their log line could not be appended.
 */
export function appendDeviceEvent(input: DeviceEventInput): void {
  try {
    const record = buildDeviceRecord(input)
    let line = JSON.stringify(record)
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) // hard ceiling
    const file = deviceDayFile()
    fs.mkdirSync(deviceLogRoot(), { recursive: true })
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' })
    trimDayFile(file)
  } catch (err) {
    console.warn('[device-log] append failed:', err)
  }
}

// ─── Reading (Logs Manager "Devices" tab + unified export) ──────────────────

export interface DeviceFilters {
  q?: string
  event?: string
  deviceId?: string
  agencyId?: string
  uid?: string
  origin?: string
  platform?: string
  deviceType?: string
  sessionId?: string
  level?: string
  from?: string // YYYY-MM-DD inclusive
  to?: string   // YYYY-MM-DD inclusive
  limit?: number
}

export interface DeviceReadResult {
  entries: DeviceEventRecord[]
  scanned: number
  files: number
  truncated: boolean
}

const DEVICE_SCAN_TOTAL_BYTES = 64 * 1024 * 1024
const DEVICE_LIMIT_MAX = 5_000

function matchFilters(r: DeviceEventRecord, f: DeviceFilters): boolean {
  if (f.event && r.event !== f.event) return false
  if (f.deviceId && r.deviceId !== f.deviceId) return false
  if (f.agencyId && r.agencyId !== f.agencyId) return false
  if (f.origin && r.origin !== f.origin) return false
  if (f.platform && r.platform !== f.platform) return false
  if (f.deviceType && r.deviceType !== f.deviceType) return false
  if (f.sessionId && r.sessionId !== f.sessionId) return false
  if (f.level && r.level !== f.level) return false
  if (f.uid && !(r.uid ?? '').toLowerCase().includes(f.uid.toLowerCase())) return false
  if (f.q) {
    const hay = `${r.message} ${r.event} ${r.deviceId ?? ''} ${r.deviceName ?? ''} ${r.deviceType ?? ''} ${r.uid ?? ''} ${r.username ?? ''} ${r.agencyId ?? ''} ${r.sessionId ?? ''}`.toLowerCase()
    if (!hay.includes(f.q.toLowerCase())) return false
  }
  return true
}

/**
 * Read the device event stream, NEWEST first. Day files are walked backwards
 * (today → oldest) and lines within a file backwards, so the admin sees the
 * live tail immediately. Bounded by the byte budget + row limit.
 */
export function readDeviceEntries(f: DeviceFilters): DeviceReadResult {
  const out: DeviceEventRecord[] = []
  let scanned = 0
  let filesSeen = 0
  let totalBytes = 0
  let truncated = false
  const limit = Math.max(1, Math.min(f.limit ?? 500, DEVICE_LIMIT_MAX))

  let names: string[] = []
  try {
    names = fs.readdirSync(deviceLogRoot()).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort()
  } catch {
    return { entries: out, scanned, files: 0, truncated }
  }
  if (f.from) names = names.filter((n) => n.slice(0, 10) >= f.from!)
  if (f.to) names = names.filter((n) => n.slice(0, 10) <= f.to!)

  outer:
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]
    const full = path.join(deviceLogRoot(), name)
    filesSeen++
    let bytes = 0
    try { bytes = fs.statSync(full).size } catch { continue }
    if (totalBytes + bytes > DEVICE_SCAN_TOTAL_BYTES) { truncated = true; break }
    totalBytes += bytes
    let content = ''
    try { content = fs.readFileSync(full, 'utf8') } catch { continue }
    const lines = content.split('\n').filter((l) => l.trim())
    for (let j = lines.length - 1; j >= 0; j--) {
      scanned++
      let obj: DeviceEventRecord
      try { obj = JSON.parse(lines[j]) as DeviceEventRecord } catch { continue }
      if (!obj || typeof obj !== 'object' || !obj.ts) continue
      if (!matchFilters(obj, f)) continue
      out.push(obj)
      if (out.length >= limit) { truncated = true; break outer }
    }
  }
  return { entries: out, scanned, files: filesSeen, truncated }
}

// ─── Aggregation (KPI tiles + per-device timelines) ──────────────────────────

export interface DeviceSummary {
  total: number
  last24h: number
  byEvent: Record<string, number>
  byPlatform: Record<string, number>
  byType: Record<string, number>
  errors24h: number
  /** Per-device timelines — the newest 200 devices. */
  timelines: Array<{
    deviceId: string | null
    deviceName: string | null
    deviceType: string | null
    agencyId: string | null
    platform: string | null
    firstTs: string
    lastTs: string
    events: string[]
    eventCount: number
    lastLevel: string | null
  }>
}

/**
 * Build KPI counts + per-device timelines from a NEWEST-first entry list.
 * The timeline cap keeps the payload sane (the newest 200 devices).
 */
export function summarizeDeviceEntries(entries: DeviceEventRecord[], maxTimelines = 200): DeviceSummary {
  const byEvent: Record<string, number> = {}
  const byPlatform: Record<string, number> = {}
  const byType: Record<string, number> = {}
  let last24h = 0
  let errors24h = 0
  const dayAgo = Date.now() - 24 * 3_600_000

  const deviceMap = new Map<string, {
    deviceId: string | null
    deviceName: string | null
    deviceType: string | null
    agencyId: string | null
    platform: string | null
    firstTs: string
    lastTs: string
    events: string[]
    eventCount: number
    lastLevel: string | null
  }>()

  for (const e of entries) { // newest-first input
    byEvent[e.event] = (byEvent[e.event] ?? 0) + 1
    const plat = e.platform || 'unknown'
    byPlatform[plat] = (byPlatform[plat] ?? 0) + 1
    const dt = e.deviceType || 'unknown'
    byType[dt] = (byType[dt] ?? 0) + 1
    const ts = Date.parse(e.ts)
    const fresh = Number.isFinite(ts) && ts >= dayAgo
    if (fresh) {
      last24h++
      if (e.level === 'warn' || e.level === 'error') errors24h++
    }

    const key = e.deviceId || `anon:${Math.abs(hashStr(e.ts + e.message))}`
    let dev = deviceMap.get(key)
    if (!dev) {
      dev = {
        deviceId: e.deviceId ?? null,
        deviceName: e.deviceName ?? null,
        deviceType: e.deviceType ?? null,
        agencyId: e.agencyId ?? null,
        platform: e.platform ?? null,
        firstTs: e.ts,
        lastTs: e.ts,
        events: [e.event],
        eventCount: 1,
        lastLevel: e.level ?? null,
      }
      deviceMap.set(key, dev)
    } else {
      dev.eventCount++
      if (e.ts < dev.firstTs) dev.firstTs = e.ts
      if (e.ts > dev.lastTs) dev.lastTs = e.ts
      if (!dev.deviceName && e.deviceName) dev.deviceName = e.deviceName
      if (!dev.deviceType && e.deviceType) dev.deviceType = e.deviceType
      if (!dev.agencyId && e.agencyId) dev.agencyId = e.agencyId
      if (!dev.platform && e.platform) dev.platform = e.platform
      if (!dev.events.includes(e.event)) dev.events.unshift(e.event) // newest-first
      if (!dev.lastLevel && e.level) dev.lastLevel = e.level
    }
  }

  return {
    total: entries.length,
    last24h,
    byEvent,
    byPlatform,
    byType,
    errors24h,
    timelines: [...deviceMap.values()].slice(0, maxTimelines),
  }
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
