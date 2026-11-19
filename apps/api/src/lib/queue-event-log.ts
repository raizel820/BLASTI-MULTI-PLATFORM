/**
 * queue-event-log.ts — Unified QUEUE EVENT STREAM (0.6.94)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE canonical store for every QUEUE-ENGINE event on the platform — the
 * classes of events that were previously invisible to support and made the
 * queue/discovery fault reports undiagnosable. The user's mandate:
 *
 *   • QUEUE ENGINE — pause/resume/settings changes on any queue.
 *   • ALL QUEUE OPERATIONS from ONLINE reservation → LOCAL walk-in →
 *     KIOSK dispensing, on ALL devices/platforms (web console, phone app,
 *     desktop LAN box, kiosk): created / claimed / recalled / completed /
 *     no-show / cancelled / postponed / status / reclaimed / rated / shared /
 *     fixed-time / batch-complete / QR import.
 *   • COUNTER OPERATIONS — counters managing the SAME queue list for the SAME
 *     services: claim / release / control request/approve/reject / assign /
 *     CRUD + claim contention (two counters racing for the next ticket).
 *   • KIOSK MODE queue interactions — offline ticket sync.
 *   • INTERACTIONS BETWEEN DEVICES ON THE SAME LOCAL NETWORK — the desktop
 *     LAN outbox (offline mutations queued), push replays to cloud, pull
 *     applies from cloud, and sync conflicts that desync a shared queue list.
 *   • FULL-SCREEN MODE — queue display enter/exit.
 *
 * DESIGN — same one-pipeline model as device-event-log.ts (0.6.88) / tx-log.ts
 * (0.6.81):
 *   • CLIENT events (web console, Capacitor mobile, Electron renderer, kiosk
 *     webviews) ride the EXISTING remote-logger batch ingest
 *     (POST /api/logs) tagged `tag:'queue'` + `channel:'queue'`; the ingest
 *     route MIRRORS them here (routes/logs.ts) via logQueue() on the client.
 *   • DESKTOP LOCAL-API events (LAN queue mutations, outbox, sync) are queued
 *     through the existing local /api/logs ingest → cloud forward, so they
 *     survive offline periods and carry the desktop identity.
 *   • SERVER events (authoritative mutations on the cloud API: reservations,
 *     call-next, counter control, kiosk join, scheduler) are written DIRECTLY
 *     by this helper — one function call at each authoritative mutation point.
 *   • Both sides land in the SAME stream file with the SAME line schema, so
 *     the Logs Manager "Queue" tab (GET /api/logs/queue) sees ONE coherent
 *     timeline per ticket, per counter, and per agency.
 *
 * Storage: ${BLASTI_LOG_DIR:-<repo>/logs}/_queue/<YYYY-MM-DD>.ndjson
 * (the `_` prefix keeps the folder out of the per-account vault listings,
 * exactly like `_transactions`, `_devices` and `_analysis`).
 */

import fs from 'node:fs'
import path from 'node:path'

// ─── Canonical event taxonomy ────────────────────────────────────────────────

export const QUEUE_EVENTS = [
  // queue engine state
  'queue_paused',             // queue paused (toggle-pause / pause / resume=off)
  'queue_resumed',            // queue resumed
  'queue_settings_updated',   // queue settings PUT (service times, callable rules)
  // ticket lifecycle — creation sources (online → local → kiosk)
  'ticket_created_online',    // customer reservation (web/phone app booking)
  'ticket_created_walkin',    // staff walk-in (agency console / mobile dashboard / desktop LAN)
  'ticket_created_kiosk',     // kiosk self-service dispensing
  'ticket_imported',          // QR claim / walk-in import into a customer account
  // ticket lifecycle — serving
  'ticket_claimed',           // call-next assigned a ticket to a counter/staff
  'claim_contention',         // concurrent claim retry (two counters raced)
  'ticket_recalled',          // ticket re-called
  'ticket_completed',         // service finished
  'ticket_no_show',           // marked absent
  'ticket_cancelled',         // cancelled (customer self-cancel or staff)
  'ticket_postponed',         // postponed N positions
  'ticket_status_changed',    // generic status transition (unified status PUT)
  'ticket_reclaimed',         // customer reclaimed their spot
  'ticket_rated',             // service rating submitted
  'ticket_shared',            // ticket status shared with a contact
  'ticket_fixed_time_toggled', // fixed-time reservation toggled
  'batch_completed',          // batch completion (agency sweep)
  // counter operations — counters managing the same queue list
  'counter_claimed',          // staff took control of a counter
  'counter_released',         // staff released a counter
  'counter_control_requested', // takeover request filed
  'counter_control_approved', // takeover request approved
  'counter_control_rejected', // takeover request rejected
  'counter_assigned',         // force takeover / admin assign
  'counter_created',          // counter CRUD
  'counter_updated',          // counter CRUD
  'counter_deleted',          // counter CRUD
  // kiosk mode queue interactions
  'kiosk_ticket_synced',      // offline kiosk tickets synced after reconnect
  // full-screen mode (queue display)
  'fullscreen_enter',         // queue display entered full-screen
  'fullscreen_exit',          // queue display exited full-screen
  // LAN sync propagation — devices sharing the same queue list
  'sync_mutation_queued',     // offline LAN mutation written to the outbox
  'sync_push_replayed',       // outbox batch replayed to the cloud
  'sync_pull_applied',        // cloud delta applied locally + re-broadcast on LAN
  'sync_conflict',            // conflict desynced a shared queue record
] as const
export type QueueEvent = (typeof QUEUE_EVENTS)[number]

// ─── Event shape ─────────────────────────────────────────────────────────────

export interface QueueEventIdentity {
  uid?: string | null
  userId?: string | null
  username?: string | null
  role?: string | null
  agencyId?: string | null
}

export interface QueueEventInput {
  event: string
  message: string
  level?: 'debug' | 'info' | 'warn' | 'error'
  /** Structured extras — kept small; the whole line is capped. */
  data?: Record<string, unknown>
  identity?: QueueEventIdentity
  /** 'server' for direct writes; the ingest mirror stamps 'client'. */
  origin?: 'client' | 'server'
  platform?: string
  appVersion?: string
  /** Agency + branch + service scope. */
  agencyId?: string | null
  branchId?: string | null
  serviceId?: string | null
  serviceName?: string | null
  /** The counter that performed / received the operation. */
  counterId?: string | null
  counterName?: string | null
  /** The ticket (Reservation row) the operation is about. */
  ticketId?: string | null
  ticketNumber?: string | null
  /** Where the ticket came from: online | walkin | kiosk | import | unknown */
  source?: string | null
  /** Resulting status (WAITING / CALLED / COMPLETED / …). */
  status?: string | null
  /** Wait (created→called) / service (called→completed) durations in ms. */
  waitMs?: number | null
  serviceMs?: number | null
  /** Correlation id — groups a batch / sync cycle / kiosk sync session. */
  sessionId?: string | null
  /** The device identity where a CLIENT event originated (desktop box etc.). */
  deviceId?: string | null
  deviceName?: string | null
}

/** The canonical NDJSON line — identical for client-mirrored + server events. */
export interface QueueEventRecord {
  ts: string
  level: string
  tag: 'queue'
  channel: 'queue'
  origin: 'client' | 'server'
  event: string
  message: string
  agencyId?: string
  branchId?: string
  serviceId?: string
  serviceName?: string
  counterId?: string
  counterName?: string
  ticketId?: string
  ticketNumber?: string
  source?: string
  status?: string
  waitMs?: number
  serviceMs?: number
  sessionId?: string
  deviceId?: string
  deviceName?: string
  uid?: string | null
  userId?: string | null
  username?: string | null
  role?: string | null
  platform?: string
  appVersion?: string
  data?: Record<string, unknown>
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const MAX_LINE_CHARS = 8_000
const MAX_DATA_KEYS = 24
const DAY_FILE_TRIM_BYTES = 20 * 1024 * 1024 // trim oldest half past 20 MB

export function queueLogRoot(): string {
  return path.join(
    process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs'),
    '_queue',
  )
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export function queueDayFile(date = dayStamp()): string {
  return path.join(queueLogRoot(), `${date}.ndjson`)
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

function safeMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return Math.round(v)
}

/** Build ONE canonical record from either side's input. Never throws. */
export function buildQueueRecord(input: QueueEventInput): QueueEventRecord {
  const id = input.identity ?? {}
  let message = typeof input.message === 'string' ? input.message : String(input.message ?? '')
  if (message.length > 400) message = message.slice(0, 400) + '…'
  const event = safeStr(input.event, 40) || 'unknown'
  const agencyId = safeStr(input.agencyId ?? id.agencyId, 64)
  const branchId = safeStr(input.branchId, 64)
  const serviceId = safeStr(input.serviceId, 64)
  const serviceName = safeStr(input.serviceName, 80)
  const counterId = safeStr(input.counterId, 64)
  const counterName = safeStr(input.counterName, 80)
  const ticketId = safeStr(input.ticketId, 64)
  const ticketNumber = safeStr(input.ticketNumber, 24)
  const source = safeStr(input.source, 16)
  const status = safeStr(input.status, 24)
  const waitMs = safeMs(input.waitMs)
  const serviceMs = safeMs(input.serviceMs)
  const sessionId = safeStr(input.sessionId, 64)
  const deviceId = safeStr(input.deviceId, 64)
  const deviceName = safeStr(input.deviceName, 80)
  const platform = safeStr(input.platform, 20)
  const appVersion = safeStr(input.appVersion, 20)
  const uid = safeStr(id.uid, 64)
  const userId = safeStr(id.userId, 64)
  const username = safeStr(id.username, 64)
  const role = safeStr(id.role, 32)
  const data = sanitizeData(input.data)
  const record: QueueEventRecord = {
    ts: new Date().toISOString(),
    level: input.level || 'info',
    tag: 'queue',
    channel: 'queue',
    origin: input.origin === 'client' ? 'client' : 'server',
    event,
    message,
    ...(agencyId ? { agencyId } : {}),
    ...(branchId ? { branchId } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(serviceName ? { serviceName } : {}),
    ...(counterId ? { counterId } : {}),
    ...(counterName ? { counterName } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(ticketNumber ? { ticketNumber } : {}),
    ...(source ? { source } : {}),
    ...(status ? { status } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
    ...(serviceMs !== undefined ? { serviceMs } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    ...(uid ? { uid } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(role ? { role } : {}),
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
 * Server-side write. NEVER throws — queue mutations must never break because
 * their log line could not be appended.
 */
export function appendQueueEvent(input: QueueEventInput): void {
  try {
    const record = buildQueueRecord(input)
    let line = JSON.stringify(record)
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS) // hard ceiling
    const file = queueDayFile()
    fs.mkdirSync(queueLogRoot(), { recursive: true })
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' })
    trimDayFile(file)
  } catch (err) {
    console.warn('[queue-log] append failed:', err)
  }
}

// ─── Reading (Logs Manager "Queue" tab + unified export) ────────────────────

export interface QueueFilters {
  q?: string
  event?: string
  agencyId?: string
  branchId?: string
  serviceId?: string
  counterId?: string
  ticketId?: string
  ticketNumber?: string
  source?: string
  status?: string
  origin?: string
  platform?: string
  sessionId?: string
  level?: string
  uid?: string
  from?: string // YYYY-MM-DD inclusive
  to?: string   // YYYY-MM-DD inclusive
  limit?: number
}

export interface QueueReadResult {
  entries: QueueEventRecord[]
  scanned: number
  files: number
  truncated: boolean
}

const QUEUE_SCAN_TOTAL_BYTES = 64 * 1024 * 1024
const QUEUE_LIMIT_MAX = 5_000

function matchFilters(r: QueueEventRecord, f: QueueFilters): boolean {
  if (f.event && r.event !== f.event) return false
  if (f.agencyId && r.agencyId !== f.agencyId) return false
  if (f.branchId && r.branchId !== f.branchId) return false
  if (f.serviceId && r.serviceId !== f.serviceId) return false
  if (f.counterId && r.counterId !== f.counterId) return false
  if (f.ticketId && r.ticketId !== f.ticketId) return false
  if (f.ticketNumber && r.ticketNumber !== f.ticketNumber) return false
  if (f.source && r.source !== f.source) return false
  if (f.status && r.status !== f.status) return false
  if (f.origin && r.origin !== f.origin) return false
  if (f.platform && r.platform !== f.platform) return false
  if (f.sessionId && r.sessionId !== f.sessionId) return false
  if (f.level && r.level !== f.level) return false
  if (f.uid && !(r.uid ?? '').toLowerCase().includes(f.uid.toLowerCase())) return false
  if (f.q) {
    const hay = `${r.message} ${r.event} ${r.ticketId ?? ''} ${r.ticketNumber ?? ''} ${r.counterName ?? ''} ${r.counterId ?? ''} ${r.serviceName ?? ''} ${r.agencyId ?? ''} ${r.uid ?? ''} ${r.username ?? ''} ${r.deviceName ?? ''} ${r.sessionId ?? ''}`.toLowerCase()
    if (!hay.includes(f.q.toLowerCase())) return false
  }
  return true
}

/**
 * Read the queue event stream, NEWEST first. Day files are walked backwards
 * (today → oldest) and lines within a file backwards, so the admin sees the
 * live tail immediately. Bounded by the byte budget + row limit.
 */
export function readQueueEntries(f: QueueFilters): QueueReadResult {
  const out: QueueEventRecord[] = []
  let scanned = 0
  let filesSeen = 0
  let totalBytes = 0
  let truncated = false
  const limit = Math.max(1, Math.min(f.limit ?? 500, QUEUE_LIMIT_MAX))

  let names: string[] = []
  try {
    names = fs.readdirSync(queueLogRoot()).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort()
  } catch {
    return { entries: out, scanned, files: 0, truncated }
  }
  if (f.from) names = names.filter((n) => n.slice(0, 10) >= f.from!)
  if (f.to) names = names.filter((n) => n.slice(0, 10) <= f.to!)

  outer:
  for (let i = names.length - 1; i >= 0; i--) {
    const name = names[i]
    const full = path.join(queueLogRoot(), name)
    filesSeen++
    let bytes = 0
    try { bytes = fs.statSync(full).size } catch { continue }
    if (totalBytes + bytes > QUEUE_SCAN_TOTAL_BYTES) { truncated = true; break }
    totalBytes += bytes
    let content = ''
    try { content = fs.readFileSync(full, 'utf8') } catch { continue }
    const lines = content.split('\n').filter((l) => l.trim())
    for (let j = lines.length - 1; j >= 0; j--) {
      scanned++
      let obj: QueueEventRecord
      try { obj = JSON.parse(lines[j]) as QueueEventRecord } catch { continue }
      if (!obj || typeof obj !== 'object' || !obj.ts) continue
      if (!matchFilters(obj, f)) continue
      out.push(obj)
      if (out.length >= limit) { truncated = true; break outer }
    }
  }
  return { entries: out, scanned, files: filesSeen, truncated }
}

// ─── Aggregation (KPI tiles + per-ticket / per-counter timelines) ────────────

export interface QueueSummary {
  total: number
  last24h: number
  byEvent: Record<string, number>
  byPlatform: Record<string, number>
  bySource: Record<string, number>
  byStatus: Record<string, number>
  /** Median wait/service of the entries that carry durations (ms). */
  medianWaitMs: number | null
  medianServiceMs: number | null
  errors24h: number
  /** Per-ticket timelines — the newest 200 tickets. */
  ticketTimelines: Array<{
    ticketId: string | null
    ticketNumber: string | null
    agencyId: string | null
    serviceName: string | null
    source: string | null
    status: string | null
    platform: string | null
    firstTs: string
    lastTs: string
    events: string[]
    eventCount: number
    lastLevel: string | null
  }>
  /** Per-counter timelines — the newest 100 counters. */
  counterTimelines: Array<{
    counterId: string | null
    counterName: string | null
    agencyId: string | null
    platform: string | null
    firstTs: string
    lastTs: string
    events: string[]
    eventCount: number
    lastLevel: string | null
  }>
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Build KPI counts + per-ticket/per-counter timelines from a NEWEST-first
 * entry list. Timeline caps keep the payload sane (200 tickets / 100 counters).
 */
export function summarizeQueueEntries(entries: QueueEventRecord[], maxTimelines = 200): QueueSummary {
  const byEvent: Record<string, number> = {}
  const byPlatform: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  let last24h = 0
  let errors24h = 0
  const dayAgo = Date.now() - 24 * 3_600_000
  const waits: number[] = []
  const services: number[] = []

  interface Timeline {
    ticketId: string | null
    ticketNumber: string | null
    agencyId: string | null
    serviceName: string | null
    source: string | null
    status: string | null
    platform: string | null
    firstTs: string
    lastTs: string
    events: string[]
    eventCount: number
    lastLevel: string | null
  }
  const ticketMap = new Map<string, Timeline>()
  const counterMap = new Map<string, {
    counterId: string | null
    counterName: string | null
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
    const plat = e.platform || 'server'
    byPlatform[plat] = (byPlatform[plat] ?? 0) + 1
    if (e.source) bySource[e.source] = (bySource[e.source] ?? 0) + 1
    if (e.status) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
    if (e.waitMs !== undefined) waits.push(e.waitMs)
    if (e.serviceMs !== undefined) services.push(e.serviceMs)
    const ts = Date.parse(e.ts)
    const fresh = Number.isFinite(ts) && ts >= dayAgo
    if (fresh) {
      last24h++
      if (e.level === 'warn' || e.level === 'error') errors24h++
    }

    // Per-ticket timeline (only entries tied to a ticket).
    if (e.ticketId) {
      let t = ticketMap.get(e.ticketId)
      if (!t) {
        t = {
          ticketId: e.ticketId,
          ticketNumber: e.ticketNumber ?? null,
          agencyId: e.agencyId ?? null,
          serviceName: e.serviceName ?? null,
          source: e.source ?? null,
          status: e.status ?? null,
          platform: e.platform ?? null,
          firstTs: e.ts,
          lastTs: e.ts,
          events: [e.event],
          eventCount: 1,
          lastLevel: e.level ?? null,
        }
        ticketMap.set(e.ticketId, t)
      } else {
        t.eventCount++
        if (e.ts < t.firstTs) t.firstTs = e.ts
        if (e.ts > t.lastTs) t.lastTs = e.ts
        if (!t.ticketNumber && e.ticketNumber) t.ticketNumber = e.ticketNumber
        if (!t.agencyId && e.agencyId) t.agencyId = e.agencyId
        if (!t.serviceName && e.serviceName) t.serviceName = e.serviceName
        if (!t.source && e.source) t.source = e.source
        if (e.status) t.status = e.status // newest status wins
        if (!t.platform && e.platform) t.platform = e.platform
        if (!t.events.includes(e.event)) t.events.unshift(e.event) // newest-first
        if (!t.lastLevel && e.level) t.lastLevel = e.level
      }
    }

    // Per-counter timeline.
    if (e.counterId) {
      let ct = counterMap.get(e.counterId)
      if (!ct) {
        ct = {
          counterId: e.counterId,
          counterName: e.counterName ?? null,
          agencyId: e.agencyId ?? null,
          platform: e.platform ?? null,
          firstTs: e.ts,
          lastTs: e.ts,
          events: [e.event],
          eventCount: 1,
          lastLevel: e.level ?? null,
        }
        counterMap.set(e.counterId, ct)
      } else {
        ct.eventCount++
        if (e.ts < ct.firstTs) ct.firstTs = e.ts
        if (e.ts > ct.lastTs) ct.lastTs = e.ts
        if (!ct.counterName && e.counterName) ct.counterName = e.counterName
        if (!ct.agencyId && e.agencyId) ct.agencyId = e.agencyId
        if (!ct.platform && e.platform) ct.platform = e.platform
        if (!ct.events.includes(e.event)) ct.events.unshift(e.event) // newest-first
        if (!ct.lastLevel && e.level) ct.lastLevel = e.level
      }
    }
  }

  return {
    total: entries.length,
    last24h,
    byEvent,
    byPlatform,
    bySource,
    byStatus,
    medianWaitMs: median(waits),
    medianServiceMs: median(services),
    errors24h,
    ticketTimelines: [...ticketMap.values()].slice(0, maxTimelines),
    counterTimelines: [...counterMap.values()].slice(0, 100),
  }
}
