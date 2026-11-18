import { Hono } from 'hono'
import type { Context } from 'hono'
import { requireAuth, requireRole, authErrorResponse } from '../lib/auth'
import { db } from '@blasti/db'
import {
  enforceRateLimit,
  LOGS_INGEST_RATE_LIMIT,
  isRateLimitError,
  rateLimitErrorResponse,
} from '../lib/rate-limit'
import { normalizeTrigger } from '../lib/logs-analyzer'
import { collectServerSnapshot } from './server-logs'

/**
 * BLASTI Account Log Vault (logs-1) + Logs Manager backend (logs-2 / 0.6.19).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every app surface (web console, Capacitor mobile, Electron desktop) ships a
 * detailed client logger (apps/web/src/lib/remote-logger.ts) that batches its
 * entries and POSTs them here. 0.6.19 SEPARATES THE PLATFORMS under the same
 * account UID — support can now diff web vs mobile vs desktop behavior for
 * ONE account without grepping mixed streams:
 *
 *   ${BLASTI_LOG_DIR:-<repo>/logs}/<UID>/<platform>/<YYYY-MM-DD>.ndjson
 *
 * - <platform> ∈ web | mobile | desktop (client-reported, sanitized).
 * - Legacy pre-0.6.19 files (<UID>/<date>.ndjson) stay in place and remain
 *   browsable (platform label "legacy").
 * - Super admin has no UID → folder "admin-<userId>"; unauth'd crashes →
 *   "anonymous" (folderFor).
 *
 * Enriched envelopes (0.6.19): each batch carries deviceSpecs (cores, memory,
 * screen, network, timezone, …) and perf (page load, DOM ready, JS heap) so
 * the analyzer can correlate bugs with device classes and study performance
 * across platforms/devices. Everything is size-capped and whitelisted.
 *
 * Realtime analysis: every ingested batch feeds logs-analyzer.ts (fingerprint
 * index + severity + daily per-platform JSON with all accounts). The Logs
 * Manager UI consumes these endpoints:
 *
 *   GET /api/logs/analysis                      — filtered error index
 *   GET /api/logs/analysis/summary              — KPI counts
 *   GET /api/logs/analysis/errors/:fp           — one bug, full detail
 *   GET /api/logs/analysis/daily                — list daily JSON files
 *   GET /api/logs/analysis/daily/:platform/:date — the daily aggregate JSON
 *   GET /api/logs/analysis/report               — report (one bug or all)
 *   GET /api/logs/analysis/export               — 0.6.66 UNIFIED DOWNLOAD: the
 *             admin picks log types (errors/daily/raw/agent/server), an
 *             analyze mode (raw/report/summary), a file format (json/md/csv/
 *             ndjson) and every filter (time range, platform, account role,
 *             uid, device, app version, severity, trigger, agent action/
 *             status, server sources) — the response IS the final file.
 *   GET /api/logs            — account folders (SUPER_ADMIN)
 *   GET /api/logs/:uid       — platforms + files in one account folder
 *   GET /api/logs/:uid/:platform/:file — raw NDJSON (also legacy 2-segment)
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  analyzeBatch,
  bootBackfill,
  queryErrors,
  getError,
  analysisSummary,
  listDailyFiles,
  readDailyFile,
  buildReport,
  deepScanHistory,
  type AnalysisFilters,
} from '../lib/logs-analyzer'
import {
  appendTxEvent,
  readTxEntries,
  summarizeTxEntries,
  type TxFilters,
} from '../lib/tx-log'
import {
  appendDeviceEvent,
  readDeviceEntries,
  summarizeDeviceEntries,
  type DeviceFilters,
} from '../lib/device-event-log'

const app = new Hono()

// ─── Storage layout ──────────────────────────────────────────────────────────

function logRoot(): string {
  return process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs')
}

/** Folder name for an account — UID when present, else safe fallbacks. */
function folderFor(uid: string | null | undefined, userId: string, role: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  if (uid) return safe(uid)
  if (role === 'SUPER_ADMIN') return `admin-${safe(userId)}`
  return `user-${safe(userId)}`
}

// Session JWTs do not carry the uid claim (uid-0.6.14 kept tokens slim), so
// the vault resolves it with one cheap indexed lookup per account, cached —
// uploads arrive at most every ~30s per account.
const uidCache = new Map<string, { uid: string | null; at: number }>()
const UID_CACHE_TTL_MS = 10 * 60_000

async function resolveUid(userId: string): Promise<string | null> {
  const hit = uidCache.get(userId)
  if (hit && Date.now() - hit.at < UID_CACHE_TTL_MS) return hit.uid
  let uid: string | null = null
  try {
    const row = await db.user.findUnique({ where: { id: userId }, select: { uid: true } })
    uid = row?.uid ?? null
  } catch { /* DB hiccup → fallback folder name (never lose logs) */ }
  uidCache.set(userId, { uid, at: Date.now() })
  return uid
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function safeComponent(s: unknown, max: number, fallback: string): string {
  const v = typeof s === 'string' && s.trim() ? s.trim() : fallback
  return v.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, max) || fallback
}

/** Recursive byte total for one account folder (platform subdirs included). */
function folderBytes(dir: string): number {
  let total = 0
  try {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name)
      if (f.isDirectory()) total += folderBytes(full)
      else {
        try { total += fs.statSync(full).size } catch { /* raced delete */ }
      }
    }
  } catch { /* missing dir */ }
  return total
}

const MAX_ENTRY_CHARS = 8_000        // one NDJSON line ceiling (post-trim)
const MAX_ENTRIES_PER_BATCH = 200    // client batches stay well under this
const MAX_BODY_ENTRIES = 500         // hard ceiling across all body shapes
const PER_UID_BYTE_CAP = 25 * 1024 * 1024 // 25 MB per account — oldest days get truncated first
const KNOWN_PLATFORMS = new Set(['web', 'mobile', 'desktop', 'kiosk', 'tv', 'legacy'])

interface IncomingEntry {
  ts?: unknown
  level?: unknown
  tag?: unknown
  message?: unknown
  data?: unknown
  /** 0.6.55 — per-entry error-trigger reason (update / profile-image / …). */
  trigger?: unknown
  /** 0.6.81 — 'transactions' entries are mirrored into the dedicated tx stream. */
  channel?: unknown
}

/** Shallow whitelist-flatten for deviceSpecs / perf objects (values capped). */
function sanitizeSmallObject(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string | number | boolean> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 16) break
    const key = k.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32)
    if (!key) continue
    if (typeof v === 'string') { out[key] = v.slice(0, 60); n++ }
    else if (typeof v === 'number' && Number.isFinite(v)) { out[key] = Math.round(v * 100) / 100; n++ }
    else if (typeof v === 'boolean') { out[key] = v; n++ }
  }
  return n > 0 ? out : undefined
}

function sanitizeEntry(raw: IncomingEntry): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const ts = typeof raw.ts === 'string' && raw.ts.length <= 40 ? raw.ts : new Date().toISOString()
  const level = typeof raw.level === 'string' ? raw.level.slice(0, 10) : 'info'
  const tag = typeof raw.tag === 'string' ? raw.tag.slice(0, 60) : 'app'
  let message = typeof raw.message === 'string' ? raw.message : JSON.stringify(raw.message ?? '')
  if (message.length > MAX_ENTRY_CHARS) message = message.slice(0, MAX_ENTRY_CHARS) + '…[truncated]'
  let data: unknown = raw.data
  if (data !== undefined && data !== null) {
    try {
      const json = JSON.stringify(data)
      if (json && json.length > MAX_ENTRY_CHARS) data = { truncated: json.slice(0, MAX_ENTRY_CHARS) + '…' }
    } catch { data = { unserializable: true } }
  }
  return { ts, level, tag, message, ...(data !== undefined ? { data } : {}), ...(
    // 0.6.55 — normalized error-trigger slug rides the stored entry so the
    // analyzer and the Logs Manager can attribute the bug to its cause.
    normalizeTrigger(raw.trigger) ? { trigger: normalizeTrigger(raw.trigger) } : {}
  ), ...(
    // 0.6.81 — the transaction channel survives sanitization so the ingest
    // mirror can route these entries into the dedicated tx stream.
    raw.channel === 'transactions' ? { channel: 'transactions' as const } : {}
  ) }
}

function appendNdjson(file: string, lines: string[]): void {
  if (lines.length === 0) return
  fs.appendFileSync(file, lines.join('\n') + '\n', { encoding: 'utf8' })
}

/** Keep an account under the byte cap: delete oldest day-files first (both layouts). */
function enforceCap(uidDir: string): void {
  try {
    let guard = 0
    while (folderBytes(uidDir) > PER_UID_BYTE_CAP && guard++ < 50) {
      const candidates: Array<{ file: string; full: string }> = []
      for (const f of fs.readdirSync(uidDir, { withFileTypes: true })) {
        const full = path.join(uidDir, f.name)
        if (f.isDirectory()) {
          for (const g of fs.readdirSync(full)) {
            if (g.endsWith('.ndjson') && !g.startsWith('manual-')) candidates.push({ file: g, full: path.join(full, g) })
          }
        } else if (f.name.endsWith('.ndjson') && !f.name.startsWith('manual-')) {
          candidates.push({ file: f.name, full })
        }
      }
      if (candidates.length === 0) break
      candidates.sort((a, b) => a.file.localeCompare(b.file)) // YYYY-MM-DD names sort chronologically
      fs.unlinkSync(candidates[0].full)
    }
  } catch { /* best-effort housekeeping */ }
}

// ─── Ingestion ───────────────────────────────────────────────────────────────

const ingestSchema = {
  parse(body: unknown): {
    entries: IncomingEntry[]
    platform?: string
    appVersion?: string
    device?: string
    sessionHref?: string
    sessionId?: string
    deviceId?: string
    deviceSpecs?: Record<string, string | number | boolean>
    perf?: Record<string, string | number | boolean>
    manual?: boolean
    reason?: string
    trigger?: string
  } | null {
    if (!body || typeof body !== 'object') return null
    const b = body as Record<string, unknown>
    const rawEntries = Array.isArray(b.entries) ? b.entries : [b]
    if (rawEntries.length === 0 || rawEntries.length > MAX_BODY_ENTRIES) return null
    return {
      entries: rawEntries as IncomingEntry[],
      platform: typeof b.platform === 'string' ? b.platform.slice(0, 20) : undefined,
      appVersion: typeof b.appVersion === 'string' ? b.appVersion.slice(0, 20) : undefined,
      device: typeof b.device === 'string' ? b.device.slice(0, 120) : undefined,
      sessionHref: typeof b.sessionHref === 'string' ? b.sessionHref.slice(0, 300) : undefined,
      sessionId: typeof b.sessionId === 'string' ? b.sessionId.slice(0, 64) : undefined,
      // 0.6.55 — stable install/device id (device-fingerprint / desktop install
      // identity). Folders UNLINKED from any account are filed per-device
      // instead of one shared "anonymous" bucket.
      deviceId: typeof b.deviceId === 'string' ? b.deviceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : undefined,
      deviceSpecs: sanitizeSmallObject(b.deviceSpecs),
      perf: sanitizeSmallObject(b.perf),
      manual: b.manual === true,
      reason: typeof b.reason === 'string' ? b.reason.slice(0, 20) : undefined,
      // 0.6.55 — WHY this batch was flushed (error trigger taxonomy).
      trigger: normalizeTrigger(b.trigger),
    }
  },
}

// ── STRICT MODE (0.6.30) identity resolution ─────────────────────────────────
// The kiosk/TV surfaces hold NO user session — every upload 401'd and their
// buffer stayed on-device forever. resolveUploader() accepts:
//   1. a user session JWT (the classic requireAuth path), or
//   2. an AgencyDevice token (Bearer) from the kiosk join/pair flow.
// Device folders land as "device-<id>" with the device's agency in the meta.
//
// 0.6.55 — THIRD path: a tokenless upload (update failed on a machine where
// nobody signed in, an anonymous crash before login) is ACCEPTED as kind
// 'anonymous' and filed under `anon-<deviceId>` — one folder per DEVICE, no
// longer the shared pre-0.6.55 "anonymous" bucket. Without a client-reported
// deviceId the batch still lands in the shared "anonymous" folder so nothing
// is ever dropped.
interface UploaderIdentity {
  kind: 'user' | 'device' | 'anonymous'
  folder: string
  label: string
  meta: Record<string, unknown>
}

async function resolveUploader(c: Context, body?: { deviceId?: string }): Promise<UploaderIdentity> {
  // Try the user session first (requireAuth throws on failure).
  try {
    const user = await requireAuth(c)
    const resolvedUid = await resolveUid(user.id)
    return {
      kind: 'user',
      folder: folderFor(resolvedUid, user.id, user.role),
      label: user.username,
      meta: { uid: resolvedUid, userId: user.id, username: user.username, role: user.role },
    }
  } catch { /* fall through to device-token auth */ }
  // Device token — Bearer <agencyDevice.deviceToken> (same token the kiosk
  // already uses for status/heartbeat/realtime).
  const authHeader = c.req.header('authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (c.req.header('x-device-token') || '').trim()
  if (token) {
    const device = await db.agencyDevice.findUnique({
      where: { deviceToken: token },
      select: { id: true, name: true, type: true, agencyId: true, branchId: true },
    })
    if (device) {
      return {
        kind: 'device',
        folder: `device-${safeComponent(device.id, 40, 'unknown')}`,
        label: device.name || device.type || 'device',
        meta: { deviceId: device.id, deviceName: device.name, deviceType: device.type, agencyId: device.agencyId, branchId: device.branchId },
      }
    }
  }
  // 0.6.55 — ANONYMOUS accept: update failures / pre-login crashes must reach
  // the vault even with NO account and NO device token (the user's mandate).
  // Rate limiting (LOGS_INGEST_RATE_LIMIT) + the per-folder byte cap bound the
  // abuse surface; the deviceId keeps every device's trail separable.
  const anonDevice = body?.deviceId
    ? safeComponent(body.deviceId, 48, '')
    : ''
  return {
    kind: 'anonymous',
    folder: anonDevice ? `anon-${anonDevice}` : 'anonymous',
    label: anonDevice ? `device ${anonDevice.slice(0, 12)}` : 'anonymous',
    meta: { anonymous: true, deviceId: anonDevice || undefined },
  }
}

app.post('/', async (c) => {
  // 0.6.55 — DEDICATED ingest rate limit: anonymous uploads are accepted on
  // this route now, so the bucket (120/min/IP) is the first abuse gate.
  try {
    enforceRateLimit(c, LOGS_INGEST_RATE_LIMIT)
  } catch (error) {
    if (isRateLimitError(error)) {
      const rl = rateLimitErrorResponse(error)
      return c.json(rl.data, rl.status as any)
    }
    throw error
  }

  // Body FIRST — the anonymous fallback needs the client deviceId.
  let body: ReturnType<typeof ingestSchema.parse>
  try {
    body = ingestSchema.parse(await c.req.json())
  } catch {
    return c.json({ success: false, error: 'Invalid log payload' }, 400)
  }
  if (!body) return c.json({ success: false, error: 'Invalid log payload' }, 400)

  let uploader: UploaderIdentity
  try {
    uploader = await resolveUploader(c, body)
  } catch (error) {
    const status = (error as { status?: number }).status === 401 ? 401 : 500
    return c.json({ success: false, error: status === 401 ? 'Unauthorized' : 'Auth check failed' }, status as any)
  }

  const uidDir = path.join(logRoot(), uploader.folder)
  // 0.6.19 — PLATFORM-SEPARATED streams under the SAME account folder.
  // 0.6.30 — 'kiosk' and 'tv' streams join the whitelist (device-mode URLs).
  const platform = safeComponent(
    body.platform && KNOWN_PLATFORMS.has(body.platform) ? body.platform : 'web',
    20,
    'web',
  )
  const dir = path.join(uidDir, platform)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.error('[logs] mkdir failed:', err)
    return c.json({ success: false, error: 'Log storage unavailable' }, 500)
  }

  const sanitized = body.entries
    .slice(0, MAX_ENTRIES_PER_BATCH)
    .map(sanitizeEntry)
    .filter((e): e is Record<string, unknown> => e !== null)

  if (sanitized.length === 0) return c.json({ success: true, accepted: 0 })

  const deviceSpecs = sanitizeSmallObject(body.deviceSpecs)
  const perf = sanitizeSmallObject(body.perf)

  // Session envelope on the first entry of each batch — support context.
  const envelope = {
    ts: new Date().toISOString(),
    level: 'meta',
    tag: 'session',
    message: `batch ${body.manual ? '(MANUAL)' : '(auto)'}${body.reason ? `[${body.reason}]` : ''} from ${platform} v${body.appVersion ?? '?'}`,
    data: {
      ...uploader.meta,
      uploaderKind: uploader.kind,
      label: uploader.label,
      platform,
      appVersion: body.appVersion,
      device: body.device,
      deviceId: body.deviceId,
      href: body.sessionHref,
      sessionId: body.sessionId,
      flushReason: body.reason,
      trigger: body.trigger,
      deviceSpecs,
      perf,
      count: sanitized.length,
    },
  }

  const lines = [JSON.stringify(envelope), ...sanitized.map((e) => JSON.stringify(e))]
  const dayFile = path.join(dir, `${dayStamp()}.ndjson`)
  try {
    appendNdjson(dayFile, lines)
    // Manual uploads ALSO write a standalone snapshot — a single file support
    // can download without parsing the whole day stream.
    if (body.manual) {
      const manualFile = path.join(dir, `manual-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`)
      appendNdjson(manualFile, lines)
    }
    enforceCap(uidDir)
    // Last-seen metadata sidecars: one per platform stream + one for the
    // account (legacy readers + the folder list "last activity" column).
    const metaPayload = {
      at: new Date().toISOString(),
      platform,
      appVersion: body.appVersion,
      device: body.device,
      deviceSpecs,
      perf,
      ...uploader.meta,
      uploaderKind: uploader.kind,
      label: uploader.label,
    }
    fs.writeFileSync(path.join(dir, `meta-${dayStamp()}.json`), JSON.stringify(metaPayload, null, 1), { encoding: 'utf8' })
    fs.writeFileSync(path.join(uidDir, `meta-${dayStamp()}.json`), JSON.stringify(metaPayload, null, 1), { encoding: 'utf8' })
  } catch (err) {
    console.error('[logs] append failed:', err)
    return c.json({ success: false, error: 'Log write failed' }, 500)
  }

  // ── 0.6.81 — TRANSACTION CHANNEL MIRROR (one pipeline, one store) ──
  // Entries tagged channel:'transactions' (the client tx funnel logger) are
  // mirrored into the dedicated cross-account stream
  // logs/_transactions/<date>.ndjson with the uploader identity resolved
  // HERE — the Logs Manager "Transactions" tab reads exactly that stream.
  // The account-vault write above is untouched: the full per-account trail
  // still carries the tx entries too (two VIEWS, one ingest path).
  const txMirrored = sanitized.filter((e) => (e as { channel?: string }).channel === 'transactions')
  if (txMirrored.length > 0) {
    for (const e of txMirrored) {
      const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>
      try {
        appendTxEvent({
          stage: typeof d.stage === 'string' ? d.stage : 'unknown',
          message: String(e.message ?? ''),
          level: typeof e.level === 'string' && ['debug', 'info', 'warn', 'error'].includes(e.level)
            ? (e.level as 'debug' | 'info' | 'warn' | 'error')
            : 'info',
          data: d.stage !== undefined || d.txType !== undefined || d.ref !== undefined || d.checkoutId !== undefined || d.status !== undefined || d.amount !== undefined || d.method !== undefined
            ? Object.fromEntries(Object.entries(d).filter(([k]) => !['stage', 'txType', 'ref', 'checkoutId', 'status', 'amount', 'method'].includes(k)))
            : d,
          identity: {
            uid: (uploader.meta.uid as string | null) ?? null,
            userId: (uploader.meta.userId as string | null) ?? null,
            username: (uploader.meta.username as string | null) ?? null,
            role: (uploader.meta.role as string | null) ?? null,
            agencyId: (d.agencyId as string | undefined) ?? null,
          },
          origin: 'client',
          platform,
          appVersion: body.appVersion,
          ref: typeof d.ref === 'string' ? d.ref : undefined,
          checkoutId: typeof d.checkoutId === 'string' ? d.checkoutId : undefined,
          txType: typeof d.txType === 'string' ? d.txType : undefined,
          status: typeof d.status === 'string' ? d.status : undefined,
          amount: typeof d.amount === 'number' ? d.amount : undefined,
          method: typeof d.method === 'string' ? d.method : undefined,
        })
      } catch { /* the mirror never fails the ingestion */ }
    }
  }

  // ── 0.6.88 — DEVICE CHANNEL MIRROR (one pipeline, one store) ──
  // Entries tagged channel:'device' (client device/kiosk funnel logger) are
  // mirrored into the dedicated cross-account stream
  // logs/_devices/<date>.ndjson — the Logs Manager "Devices" tab reads
  // exactly that stream. The account-vault write above is untouched.
  const deviceMirrored = sanitized.filter((e) => (e as { channel?: string }).channel === 'device')
  if (deviceMirrored.length > 0) {
    for (const e of deviceMirrored) {
      const d = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>
      try {
        appendDeviceEvent({
          event: typeof d.event === 'string' ? d.event : 'unknown',
          message: String(e.message ?? ''),
          level: typeof e.level === 'string' && ['debug', 'info', 'warn', 'error'].includes(e.level)
            ? (e.level as 'debug' | 'info' | 'warn' | 'error')
            : 'info',
          data: d.event !== undefined
            ? Object.fromEntries(Object.entries(d).filter(([k]) => !['event', 'deviceId', 'deviceName', 'deviceType', 'sessionId', 'status', 'agencyId'].includes(k)))
            : d,
          identity: {
            uid: (uploader.meta.uid as string | null) ?? null,
            userId: (uploader.meta.userId as string | null) ?? null,
            username: (uploader.meta.username as string | null) ?? null,
            role: (uploader.meta.role as string | null) ?? null,
            agencyId: (d.agencyId as string | undefined) ?? null,
          },
          origin: 'client',
          platform,
          appVersion: body.appVersion,
          deviceId: typeof d.deviceId === 'string' ? d.deviceId : undefined,
          deviceName: typeof d.deviceName === 'string' ? d.deviceName : undefined,
          deviceType: typeof d.deviceType === 'string' ? d.deviceType : undefined,
          sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
          status: typeof d.status === 'string' ? d.status : undefined,
        })
      } catch { /* the mirror never fails the ingestion */ }
    }
  }

  // ── Realtime analysis (logs-2) — never fails the ingestion. ──
  try {
    analyzeBatch(
      {
        uid: uploader.kind === 'user' ? ((uploader.meta.uid as string | null) ?? null) : uploader.folder,
        role: uploader.kind === 'user' ? String(uploader.meta.role ?? 'USER') : uploader.kind === 'device' ? 'DEVICE' : 'ANONYMOUS',
        platform,
        appVersion: body.appVersion ?? 'unknown',
        device: body.device ?? 'unknown',
        date: dayStamp(),
        deviceSpecs,
        perf,
        // 0.6.55 — the batch trigger feeds the analyzer's per-cause index.
        trigger: body.trigger,
      },
      sanitized,
      body.manual === true,
    )
  } catch { /* analyzer guards itself too */ }

  return c.json({ success: true, accepted: sanitized.length, folder: `${uploader.folder}/${platform}` })
})

// ─── Realtime analysis endpoints (SUPER_ADMIN — the Logs Manager) ────────────

function analysisFiltersFromQuery(c: { req: { query(name: string): string | undefined } }): AnalysisFilters {
  // NOTE: bind — destructuring `const q = c.req.query` loses `this` and Hono
  // throws "undefined is not an object (evaluating 'this.url')".
  const q = (name: string) => c.req.query(name)
  const intOr = (s: string | undefined, dflt: number): number => {
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
  }
  return {
    uid: q('uid') || undefined,
    platform: q('platform') || undefined,
    role: q('role') || undefined,
    appVersion: q('appVersion') || undefined,
    device: q('device') || undefined,
    severity: q('severity') || undefined,
    minCount: q('minCount') ? intOr(q('minCount'), 1) : undefined,
    q: q('q') || undefined,
    from: q('from') || undefined,
    to: q('to') || undefined,
    // 0.6.55 — filter the error index by the triggering reason.
    trigger: q('trigger') || undefined,
    limit: intOr(q('limit'), 100),
  }
}

/** GET /api/logs/analysis/summary — KPI tiles for the manager header. */
app.get('/analysis/summary', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  return c.json({ success: true, summary: analysisSummary() })
})

/** GET /api/logs/analysis/daily — list available daily aggregate files. */
app.get('/analysis/daily', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  return c.json({ success: true, files: listDailyFiles() })
})

/** GET /api/logs/analysis/daily/:platform/:date — one day, one platform, all accounts. */
app.get('/analysis/daily/:platform/:date', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const content = readDailyFile(c.req.param('platform'), c.req.param('date'))
  if (!content) return c.json({ success: false, error: 'Daily aggregate not found' }, 404)
  try {
    return c.json({ success: true, daily: JSON.parse(content) })
  } catch {
    return c.body(content, 200, { 'Content-Type': 'application/json; charset=utf-8' })
  }
})

/** GET /api/logs/analysis/report — one bug (fp=…) or all matching filters. */
app.get('/analysis/report', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const fp = c.req.query('fp') || null
  const report = buildReport(fp, analysisFiltersFromQuery(c))
  return c.json({ success: true, report })
})

// ─── Unified export (0.6.66) — the "final log" composer ──────────────────────
//
// GET /api/logs/analysis/export?types=errors,daily,raw,agent,server
//                              &analyze=raw|report|summary
//                              &format=json|md|csv|ndjson
//                              &uid=&platform=&role=&appVersion=&device=
//                              &severity=&trigger=&minCount=&q=&from=&to=
//                              &range=all|1h|24h|7d|30d&limit=
//                              &action=&status=            (agent trail)
//                              &serverSources=&serverLines= (VPS journal/files)
//                              &deep=1&deepMaxFiles=       (OLD logs on disk —
//                               replay day-files older than the live 3-day
//                               boot window into the index before collecting)
//
// Every "Create / update download" button in the Logs Manager (per-tab and
// the Overview advanced dialog) rides this ONE route: the admin tunes the
// parameters, hits download, and the response body IS the final file.

const EXPORT_RAW_LIMIT_MAX = 20_000
const EXPORT_AGENT_ROWS_MAX = 10_000
const EXPORT_DAILY_FILES_MAX = 31
const EXPORT_SERVER_LINES_MAX = 1_000
// Old vaults can hold big day-files (before the 25 MB per-UID cap existed) —
// per-file and total read budgets keep the export bounded without skipping
// meaningful history.
const RAW_SCAN_FILE_BYTES = 32 * 1024 * 1024
const RAW_SCAN_TOTAL_BYTES = 128 * 1024 * 1024
const RAW_SCAN_LINES_MAX = 80_000
const DEEP_SCAN_DEFAULT_FILES = 600
/** Time-range presets — hours back from now (the `range` query param). */
const EXPORT_RANGE_HOURS: Record<string, number> = { '1h': 1, '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }

interface RawExportFilters {
  uid?: string
  platform?: string
  date?: string
  level?: string
  tag?: string
  role?: string
  appVersion?: string
  device?: string
  q?: string
  from?: string
  to?: string
  limit: number
}

interface RawExportEntry {
  ts: string
  level: string
  tag: string
  message: string
  data?: unknown
  uid: string | null
  username: string | null
  role: string | null
  platform: string
  appVersion: string | null
  device: string | null
  file: string
}

/** Old logs may carry legacy role labels (AGENCY_STAFF) or different casing —
 *  the export role (account type) filter matches BOTH vintages. */
function roleMatches(ctxRole: string | null, want: string | undefined): boolean {
  if (!want) return true
  if (!ctxRole) return false
  const a = ctxRole.toLowerCase()
  const b = want.toLowerCase()
  if (a === b) return true
  if ((a === 'staff' && b === 'agency_staff') || (a === 'agency_staff' && b === 'staff')) return true
  return false
}

/**
 * Walk the per-UID NDJSON vault with the export filters — the same session-
 * ctx enrichment the Logs Manager entry browser uses (a `session` envelope
 * line carries uid/username/role/appVersion/device for the batch after it).
 * Handles ALL layout vintages on the server: platform subfolders (0.6.19+),
 * the legacy flat <UID>/<date>.ndjson layout, kiosk/tv/unknown platform
 * folders, and big old day-files (bounded by the byte budgets above).
 */
function collectRawExportEntries(f: RawExportFilters): {
  entries: RawExportEntry[]
  scanned: number
  files: number
  truncated: boolean
} {
  const root = logRoot()
  const out: RawExportEntry[] = []
  let scanned = 0
  let filesSeen = 0
  let totalBytes = 0
  let truncated = false

  let accounts: string[] = []
  try {
    accounts = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
  } catch {
    return { entries: out, scanned, files: 0, truncated }
  }
  if (f.uid) accounts = accounts.filter((a) => a.toLowerCase().includes(f.uid!.toLowerCase()))

  outer:
  for (const uid of accounts) {
    const accDir = path.join(root, uid)
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(accDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const isPlatformDir = entry.isDirectory()
      const isLegacy = entry.isFile() && entry.name.endsWith('.ndjson')
      if (f.platform) {
        if (f.platform === 'legacy' ? !isLegacy : !(isPlatformDir && entry.name === f.platform)) continue
      }
      const platformLabel = isPlatformDir ? entry.name : 'legacy'
      const dir = isPlatformDir ? path.join(accDir, entry.name) : accDir
      let names: string[] = []
      try { names = isPlatformDir ? fs.readdirSync(dir) : [entry.name] } catch { continue }
      for (const name of names) {
        if (!name.endsWith('.ndjson')) continue
        // Day-files are named YYYY-MM-DD.ndjson — the date filters ride the
        // filename (no per-line timestamp parsing needed for the window).
        const fileDate = name.slice(0, 10)
        const isDated = /^\d{4}-\d{2}-\d{2}$/.test(fileDate)
        if (f.date && (!isDated || fileDate !== f.date)) continue
        if (f.from && isDated && fileDate < f.from) continue
        if (f.to && isDated && fileDate > f.to) continue
        const full = path.join(dir, name)
        filesSeen++
        let bytes = 0
        try { bytes = fs.statSync(full).size } catch { continue }
        if (bytes > RAW_SCAN_FILE_BYTES) { truncated = true; continue }
        if (totalBytes + bytes > RAW_SCAN_TOTAL_BYTES) { truncated = true; break outer }
        totalBytes += bytes
        let content = ''
        try { content = fs.readFileSync(full, 'utf8') } catch { continue }
        // Session envelopes PRECEDE their batch in file order — attribute the
        // context with one FORWARD pass (exact per-batch ctx, important for
        // old files holding many batches), then collect NEWEST first.
        const lines = content.split('\n').filter((l) => l.trim())
        let ctx: { uid: string | null; username: string | null; role: string | null; appVersion: string | null; device: string | null } =
          { uid: null, username: null, role: null, appVersion: null, device: null }
        const rows: Array<{ obj: Record<string, unknown>; ctx: typeof ctx }> = []
        for (const line of lines) {
          scanned++
          if (scanned > RAW_SCAN_LINES_MAX) { truncated = true; break outer }
          let obj: Record<string, unknown>
          try { obj = JSON.parse(line) } catch { continue }
          if (obj.tag === 'session' && obj.data && typeof obj.data === 'object') {
            const d = obj.data as Record<string, unknown>
            ctx = {
              uid: typeof d.uid === 'string' ? d.uid : ctx.uid,
              username: typeof d.username === 'string' ? d.username : ctx.username,
              role: typeof d.role === 'string' ? d.role : ctx.role,
              appVersion: typeof d.appVersion === 'string' ? d.appVersion : ctx.appVersion,
              device: typeof d.device === 'string' ? d.device : ctx.device,
            }
            continue
          }
          rows.push({ obj, ctx })
        }
        for (let i = rows.length - 1; i >= 0; i--) {
          const { obj, ctx: rowCtx } = rows[i]
          if (f.level && String(obj.level ?? '') !== f.level) continue
          if (f.tag && String(obj.tag ?? '') !== f.tag) continue
          if (!roleMatches(rowCtx.role, f.role)) continue
          if (f.appVersion && rowCtx.appVersion !== f.appVersion) continue
          if (f.device && !(rowCtx.device ?? '').toLowerCase().includes(f.device.toLowerCase())) continue
          const message = String(obj.message ?? '')
          if (f.q && !`${obj.tag ?? ''} ${message}`.toLowerCase().includes(f.q.toLowerCase())) continue
          out.push({
            ts: String(obj.ts ?? ''),
            level: String(obj.level ?? ''),
            tag: String(obj.tag ?? ''),
            message,
            data: obj.data,
            uid: rowCtx.uid,
            username: rowCtx.username,
            role: rowCtx.role,
            platform: platformLabel,
            appVersion: rowCtx.appVersion,
            device: rowCtx.device,
            file: `${uid}/${platformLabel}/${name}`,
          })
          if (out.length >= f.limit) { truncated = true; break outer }
        }
      }
    }
  }
  return { entries: out, scanned, files: filesSeen, truncated }
}

/** Agent-trail where-builder (mirrors translation-agent.ts /logs filters). */
async function agentExportRows(opts: {
  action?: string
  status?: string
  q?: string
  since?: string
  until?: string
  limit: number
}) {
  const where: Record<string, unknown> = {}
  if (opts.action) where.action = opts.action
  if (opts.status) where.status = opts.status
  const createdAt: Record<string, Date> = {}
  if (opts.since) {
    const d = new Date(opts.since)
    if (!Number.isNaN(d.getTime())) createdAt.gte = d
  }
  if (opts.until) {
    const d = new Date(opts.until)
    if (!Number.isNaN(d.getTime())) createdAt.lte = d
  }
  if (Object.keys(createdAt).length) where.createdAt = createdAt
  if (opts.q) {
    where.AND = [{
      OR: [
        { summary: { contains: opts.q, mode: 'insensitive' as const } },
        { details: { contains: opts.q, mode: 'insensitive' as const } },
      ],
    }]
  }
  return db.translationAgentLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(opts.limit, EXPORT_AGENT_ROWS_MAX),
  })
}

function csvCell(v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : String(v ?? '')
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** GET /api/logs/analysis/export — see the block comment above. */
app.get('/analysis/export', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const q = (name: string) => (c.req.query(name) || '').trim()

  // ── Resolve types ──
  const ALL_TYPES = ['errors', 'daily', 'raw', 'agent', 'server', 'transactions'] as const
  const typesRaw = q('types') || ALL_TYPES.join(',')
  const types = new Set<string>(
    typesRaw.split(',').map((s) => s.trim()).filter((s) => (ALL_TYPES as readonly string[]).includes(s)),
  )
  if (types.size === 0) return c.json({ success: false, error: 'types must include at least one of: errors, daily, raw, agent, server, transactions' }, 400)

  // ── Resolve analyze + format ──
  const analyzeRaw = q('analyze') || 'raw'
  const analyze = ['raw', 'report', 'summary'].includes(analyzeRaw) ? analyzeRaw : 'raw'
  const formatRaw = q('format') || 'json'
  const format = ['json', 'md', 'csv', 'ndjson'].includes(formatRaw) ? formatRaw : 'json'
  if (format === 'csv' && types.size > 1) {
    return c.json({ success: false, error: 'CSV export needs exactly ONE log type — pick a single type or use json/md' }, 400)
  }
  if (format === 'ndjson' && !(types.size === 1 && types.has('raw'))) {
    return c.json({ success: false, error: 'NDJSON export applies to the raw type only' }, 400)
  }

  // ── Resolve the time window: preset range wins only when from/to absent ──
  const range = q('range') || 'all'
  const rangeHours = EXPORT_RANGE_HOURS[range]
  const from = q('from') || (rangeHours ? new Date(Date.now() - rangeHours * 3_600_000).toISOString().slice(0, 10) : '')
  const to = q('to') || ''
  const rangeLabel = rangeHours ? range : from || to ? 'custom' : 'all'

  const limitRaw = Number(q('limit')) || 0
  // PRODUCTION FIX (export truncation): the DEFAULT when the caller sends no
  // limit was 5_000 — a 7-day export silently truncated ("Raw entries — 5000
  // row(s) (TRUNCATED)") and diagnosticians never saw the rest of the week.
  // Default now equals the hard cap (20_000); an explicit ?limit still wins.
  const limit = Math.max(1, Math.min(limitRaw || EXPORT_RAW_LIMIT_MAX, EXPORT_RAW_LIMIT_MAX))

  const filters = {
    uid: q('uid') || undefined,
    platform: q('platform') || undefined,
    role: q('role') || undefined,
    appVersion: q('appVersion') || undefined,
    device: q('device') || undefined,
    severity: q('severity') || undefined,
    trigger: q('trigger') || undefined,
    minCount: q('minCount') ? Number(q('minCount')) || undefined : undefined,
    q: q('q') || undefined,
    from: from || undefined,
    to: to || undefined,
  }

  const bundle: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    analyze,
    filters,
    range: rangeLabel,
    types: [...types],
    summary: analysisSummary(),
  }

  // ── Deep scan (OLD logs) ──
  // bootBackfill only replays the last 3 days at boot — everything older sits
  // on disk unseen by the index. deep=1 replays the requested window's
  // day-files (both layouts, idempotent via _analysis/deepscan.json markers)
  // BEFORE any section is collected, so errors + daily aggregates include the
  // FULL history on the server. The raw section never needs it (it walks the
  // whole vault directly).
  if (q('deep') === '1') {
    const deepMaxFiles = Math.max(1, Math.min(Number(q('deepMaxFiles')) || DEEP_SCAN_DEFAULT_FILES, 5_000))
    try {
      bundle.deepScan = deepScanHistory(logRoot(), { from: from || undefined, to: to || undefined, maxFiles: deepMaxFiles })
      // Counts may have changed — refresh the summary AFTER the replay.
      bundle.summary = analysisSummary()
    } catch { /* never fail the export because of the deep scan */ }
  }

  // ── errors ──
  if (types.has('errors')) {
    const errFilters = {
      ...filters,
      minCount: filters.minCount,
      limit: Math.min(limit, 500),
    } as AnalysisFilters
    if (analyze === 'summary') {
      const top = queryErrors(errFilters)
      bundle.errors = {
        total: top.total,
        topBugs: top.errors.slice(0, 20).map((b) => ({
          fp: b.fp, tag: b.tag, level: b.level, count: b.count, severity: b.severity,
          severityScore: b.severityScore, lastSeen: b.lastSeen, message: b.message,
        })),
      }
    } else {
      const top = queryErrors(errFilters)
      bundle.errors = { total: top.total, updatedAt: top.updatedAt, bugs: top.errors }
    }
  }

  // ── daily ──
  if (types.has('daily')) {
    const all = listDailyFiles().filter((f) => {
      if (filters.platform && f.platform !== filters.platform) return false
      if (from && f.date < from) return false
      if (to && f.date > to) return false
      return true
    })
    const files = analyze === 'summary'
      ? all.slice(0, EXPORT_DAILY_FILES_MAX)
      : all.slice(0, EXPORT_DAILY_FILES_MAX).map((f) => {
          let content: unknown = null
          try { content = JSON.parse(readDailyFile(f.platform, f.date) ?? 'null') } catch { content = null }
          return { ...f, content }
        })
    bundle.daily = {
      count: all.length,
      truncated: all.length > files.length,
      files,
    }
  }

  // ── raw (per-UID NDJSON vault) ──
  if (types.has('raw')) {
    if (analyze === 'summary') {
      bundle.raw = { note: 'raw entries are excluded in summary mode — use analyze=raw or report' }
    } else {
      const scan = collectRawExportEntries({
        ...filters,
        level: q('level') || undefined,
        tag: q('tag') || undefined,
        date: q('date') || undefined,
        limit: analyze === 'report' ? Math.min(limit, 2_000) : limit,
      })
      bundle.raw = scan
    }
  }

  // ── agent (translation agent trail — DB rows) ──
  if (types.has('agent')) {
    const since = from ? `${from}T00:00:00.000Z` : rangeHours ? new Date(Date.now() - rangeHours * 3_600_000).toISOString() : ''
    const until = to ? `${to}T23:59:59.999Z` : ''
    if (analyze === 'summary') {
      const [total, errors, byActionRaw] = await Promise.all([
        db.translationAgentLog.count(),
        db.translationAgentLog.count({ where: { status: 'error' } }),
        db.translationAgentLog.groupBy({ by: ['action'], _count: { _all: true } }),
      ])
      const byAction: Record<string, number> = {}
      for (const g of byActionRaw) byAction[g.action] = g._count._all
      bundle.agent = { total, errors, byAction, since: since || null, until: until || null }
    } else {
      const rows = await agentExportRows({ action: q('action') || undefined, status: q('status') || undefined, q: filters.q, since, until, limit })
      bundle.agent = { count: rows.length, truncated: rows.length >= EXPORT_AGENT_ROWS_MAX, since: since || null, until: until || null, rows }
    }
  }

  // ── server (VPS journal + deploy/file logs) ──
  if (types.has('server')) {
    const serverSources = q('serverSources')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12)
    const serverLines = Math.max(1, Math.min(Number(q('serverLines')) || 300, EXPORT_SERVER_LINES_MAX))
    // Journal bounds: journalctl understands both "YYYY-MM-DD" and ISO.
    const since = from || (rangeHours ? `-${rangeHours}h` : '')
    const snapshot = await collectServerSnapshot({
      sources: serverSources,
      linesPerSource: serverLines,
      level: q('level') || null,
      q: filters.q ?? null,
      since: since || null,
      until: to || null,
    })
    if (analyze === 'summary') {
      bundle.server = {
        journalAvailable: snapshot.journalAvailable,
        generatedAt: snapshot.generatedAt,
        errors: snapshot.errors,
        sources: snapshot.sources.map((s) => ({
          id: s.id, kind: s.kind, available: s.available, count: s.count, truncated: s.truncated,
          errorWarn: s.entries.filter((e) => e.level === 'error' || e.level === 'warn').length,
        })),
      }
    } else {
      bundle.server = snapshot
    }
  }

  // ── transactions (0.6.81 — the unified payment/checkout funnel stream) ──
  if (types.has('transactions')) {
    const txRead = readTxEntries({
      stage: q('stage') || undefined,
      txType: q('txType') || undefined,
      status: q('status') || undefined,
      origin: q('origin') || undefined,
      ref: q('ref') || undefined,
      checkoutId: q('checkoutId') || undefined,
      uid: filters.uid,
      agencyId: q('agencyId') || undefined,
      q: filters.q,
      from: from || undefined,
      to: to || undefined,
      limit,
    })
    if (analyze === 'summary') {
      bundle.transactions = summarizeTxEntries(txRead.entries)
    } else {
      bundle.transactions = {
        count: txRead.entries.length,
        truncated: txRead.truncated,
        scanned: txRead.scanned,
        summary: summarizeTxEntries(txRead.entries),
        entries: txRead.entries,
      }
    }
  }

  // ── Render ──
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const base = `blasti-logs_${[...types].join('+')}_${rangeLabel}_${stamp}`

  if (format === 'json') {
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.json"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  if (format === 'ndjson') {
    const scan = bundle.raw as { entries: RawExportEntry[] } | undefined
    const lines = (scan?.entries ?? []).map((e) => JSON.stringify(e))
    return new Response(lines.join('\n') + '\n', {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.ndjson"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  if (format === 'csv') {
    const type = [...types][0]
    const COLS: Record<string, readonly string[]> = {
      errors: ['fp', 'tag', 'level', 'severity', 'severityScore', 'count', 'firstSeen', 'lastSeen', 'message', 'platforms', 'roles', 'uids', 'devices', 'triggers'],
      daily: ['platform', 'date', 'bytes', 'totals.entries', 'totals.errors', 'totals.warns', 'totals.accounts', 'updatedAt'],
      raw: ['ts', 'level', 'tag', 'message', 'uid', 'username', 'role', 'platform', 'appVersion', 'device', 'file'],
      agent: ['createdAt', 'action', 'status', 'summary', 'refType', 'refId', 'actor', 'provider', 'durationMs'],
      server: ['ts', 'source', 'level', 'message'],
      transactions: ['ts', 'stage', 'txType', 'status', 'amount', 'method', 'origin', 'ref', 'checkoutId', 'uid', 'username', 'role', 'agencyId', 'platform', 'appVersion', 'message'],
    }
    const rowsOf = (b: Record<string, unknown>): Array<Record<string, unknown>> => {
      if (type === 'errors') {
        const sec = b.errors as { bugs?: Array<Record<string, unknown>> } | undefined
        return (sec?.bugs ?? []).map((bug) => ({
          ...bug,
          platforms: ((bug.affected as { platforms?: string[] })?.platforms ?? []).join('|'),
          roles: ((bug.affected as { roles?: string[] })?.roles ?? []).join('|'),
          uids: ((bug.affected as { uids?: string[] })?.uids ?? []).join('|'),
          devices: ((bug.affected as { devices?: string[] })?.devices ?? []).join('|'),
          triggers: ((bug.affected as { triggers?: string[] })?.triggers ?? []).join('|'),
          affected: undefined,
          samples: undefined,
        }))
      }
      if (type === 'daily') {
        const sec = b.daily as { files?: Array<Record<string, unknown>> } | undefined
        return (sec?.files ?? []).map((f) => {
          const content = (f.content ?? {}) as { totals?: Record<string, unknown>; updatedAt?: string }
          return {
            platform: f.platform, date: f.date, bytes: f.bytes,
            'totals.entries': content.totals?.entries, 'totals.errors': content.totals?.errors,
            'totals.warns': content.totals?.warns, 'totals.accounts': content.totals?.accounts,
            updatedAt: content.updatedAt,
          }
        })
      }
      if (type === 'raw') return ((b.raw as { entries?: RawExportEntry[] })?.entries ?? []) as unknown as Array<Record<string, unknown>>
      if (type === 'agent') return (((b.agent as { rows?: unknown[] })?.rows ?? []) as Array<Record<string, unknown>>)
      if (type === 'transactions') return ((b.transactions as { entries?: Array<Record<string, unknown>> })?.entries ?? []) as unknown as Array<Record<string, unknown>>
      // server — flatten the per-source entries
      const snap = b.server as { sources?: Array<{ id: string; entries: Array<Record<string, unknown>> }> } | undefined
      return (snap?.sources ?? []).flatMap((s) => (s.entries ?? []).map((e) => ({ ...e, source: e.source ?? s.id })))
    }
    const rows = rowsOf(bundle)
    const lines = [COLS[type].join(',')]
    for (const row of rows) lines.push(COLS[type].map((col) => csvCell(row[col])).join(','))
    // UTF-8 BOM → Excel renders Arabic messages correctly.
    return new Response('\uFEFF' + lines.join('\r\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${base}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // ── markdown ──
  const s = bundle.summary as ReturnType<typeof analysisSummary>
  const md: string[] = [
    '# BLASTI Logs Export',
    '',
    `- Generated: ${bundle.generatedAt}`,
    `- Log types: ${[...types].join(', ')}`,
    `- Analyze mode: ${analyze}`,
    `- Time range: ${rangeLabel}${from ? ` (from ${from})` : ''}${to ? ` (to ${to})` : ''}`,
    `- Filters: ${JSON.stringify(filters)}`,
    `- Tracked bugs: ${s.totalErrors} (last 24h: ${s.last24h})`,
    `- By severity: ${Object.entries(s.bySeverity).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `- By platform: ${Object.entries(s.byPlatform).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `- By trigger: ${Object.entries(s.byTrigger).map(([k, v]) => `${k}=${v}`).join(', ') || 'n/a'}`,
    '',
    '---',
    '',
  ]
  if (types.has('errors')) {
    const sec = bundle.errors as { total: number; bugs?: Array<Record<string, unknown>>; topBugs?: Array<Record<string, unknown>> }
    const bugs = (sec.bugs ?? sec.topBugs ?? []) as Array<{
      severity: string; tag: string; count: number; fp: string; level: string; message: string
      firstSeen?: string; lastSeen: string; affected?: Record<string, string[] | undefined>
    }>
    md.push(`## Errors — ${sec.total} tracked bug(s), showing ${bugs.length}`, '')
    for (const b of bugs) {
      md.push(
        `### [${b.severity}] ${b.tag} — ${b.count} hit(s)`,
        '',
        `- Fingerprint: \`${b.fp}\` · Level: ${b.level} · Last seen: ${b.lastSeen}`,
        b.affected ? `- Platforms: ${(b.affected.platforms ?? []).join(', ')} · Roles: ${(b.affected.roles ?? []).join(', ')} · Triggers: ${(b.affected.triggers ?? []).join(', ') || 'n/a'}` : '',
        b.affected ? `- Devices: ${(b.affected.devices ?? []).slice(0, 5).join(' | ')}` : '',
        '',
        'Latest message:',
        '```',
        b.message,
        '```',
        '',
      )
    }
  }
  if (types.has('daily')) {
    const sec = bundle.daily as { count: number; truncated: boolean; files: Array<{ platform: string; date: string; bytes: number; content?: { totals?: Record<string, number>; updatedAt?: string } }> }
    md.push(`## Daily aggregates — ${sec.count} file(s)${sec.truncated ? ' (truncated)' : ''}`, '')
    for (const f of sec.files) {
      const t = f.content?.totals
      md.push(`### ${f.platform} · ${f.date}`, '', t ? `- entries=${t.entries} errors=${t.errors} warns=${t.warns} accounts=${t.accounts}` : '- (no content)', '')
    }
  }
  if (types.has('raw')) {
    const sec = bundle.raw as { entries?: RawExportEntry[]; scanned?: number; truncated?: boolean }
    const entries = sec.entries ?? []
    md.push(`## Raw entries — ${entries.length} row(s)${sec.truncated ? ' (TRUNCATED — raise the row limit)' : ''}`, '')
    for (const e of entries.slice(0, 500)) {
      md.push(`- \`${e.ts}\` **${e.level}** [${e.tag}] (${e.platform}${e.uid ? ` · ${e.uid}` : ''}${e.role ? ` · ${e.role}` : ''}) ${e.message.replace(/\n/g, ' ').slice(0, 400)}`)
    }
    md.push('')
  }
  if (types.has('agent')) {
    const sec = bundle.agent as { count?: number; total?: number; errors?: number; byAction?: Record<string, number>; rows?: Array<{ createdAt: Date | string; action: string; status: string; summary: string; actor: string; provider?: string | null; durationMs?: number | null }> }
    if (sec.rows) {
      md.push(`## Translation agent trail — ${sec.count} row(s)`, '')
      for (const r of sec.rows) {
        md.push(`- \`${typeof r.createdAt === 'string' ? r.createdAt : r.createdAt.toISOString()}\` **${r.action}** · ${r.status.toUpperCase()} — ${r.summary.slice(0, 300)}`)
      }
      md.push('')
    } else {
      md.push(`## Translation agent trail — total ${sec.total ?? 0}, errors ${sec.errors ?? 0}`, '', `Actions: ${JSON.stringify(sec.byAction ?? {})}`, '')
    }
  }
  if (types.has('server')) {
    const sec = bundle.server as { journalAvailable: boolean; sources: Array<{ id: string; kind: string; available: boolean; count: number; truncated: boolean; entries: Array<{ ts: string; source: string; level: string; message: string }> }>; errors: Array<{ id: string; error: string }> }
    md.push(`## Server logs — journal ${sec.journalAvailable ? 'available' : 'NOT available'}`, '')
    for (const e of sec.errors) md.push(`- ⚠ ${e.id}: ${e.error}`)
    for (const src of sec.sources) {
      md.push(`### ${src.id} (${src.kind}) — ${src.count} line(s)${src.truncated ? ' (truncated)' : ''}${src.available ? '' : ' · UNAVAILABLE'}`, '')
      for (const e of src.entries.slice(0, 300)) {
        md.push(`- \`${e.ts}\` **${e.level}** ${e.message.replace(/\n/g, ' ').slice(0, 300)}`)
      }
      md.push('')
    }
  }
  if (types.has('transactions')) {
    const sec = bundle.transactions as { count?: number; truncated?: boolean; entries?: Array<{ ts: string; stage: string; txType?: string; status?: string; amount?: number; origin: string; ref?: string; checkoutId?: string; uid?: string | null; message: string }> ; summary?: { byType?: Record<string, number> } }
    md.push(`## Transaction events — ${sec.count ?? 0} row(s)${sec.truncated ? ' (TRUNCATED)' : ''}`, '')
    md.push(`- By type: ${Object.entries(sec.summary?.byType ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'n/a'}`, '')
    for (const e of (sec.entries ?? []).slice(0, 500)) {
      md.push(`- \`${e.ts}\` **${e.stage}** ${e.txType ?? ''}${e.amount !== undefined ? ` ${e.amount} DA` : ''}${e.origin === 'server' ? ' [server]' : ''}${e.ref ? ` ref=${e.ref}` : ''}${e.uid ? ` uid=${e.uid}` : ''} — ${e.message.replace(/\n/g, ' ').slice(0, 300)}`)
    }
    md.push('')
  }

  return new Response(md.filter((l) => l !== undefined).join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${base}.md"`,
      'Cache-Control': 'no-store',
    },
  })
})

// ─── Transaction event stream (0.6.81) — the Logs Manager "Transactions" tab ─
//
// GET /api/logs/transactions?stage=&txType=&status=&origin=&uid=&agencyId=
//                          &ref=&checkoutId=&q=&from=&to=&limit=
//
// Reads the unified cross-account stream (logs/_transactions/<date>.ndjson)
// that BOTH the client funnel logger (mirrored by the ingest route) and the
// server-side payment mutations (tx-log.ts) write to. Returns the newest
// entries + KPI aggregation + per-transaction funnels.

app.get('/transactions', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const q = (name: string) => (c.req.query(name) || '').trim()
  const limitRaw = Number(q('limit')) || 0
  const filters: TxFilters = {
    stage: q('stage') || undefined,
    txType: q('txType') || undefined,
    status: q('status') || undefined,
    origin: q('origin') || undefined,
    uid: q('uid') || undefined,
    agencyId: q('agencyId') || undefined,
    ref: q('ref') || undefined,
    checkoutId: q('checkoutId') || undefined,
    q: q('q') || undefined,
    from: q('from') || undefined,
    to: q('to') || undefined,
    limit: Math.max(1, Math.min(limitRaw || 600, 5_000)),
  }
  const read = readTxEntries(filters)
  const summary = summarizeTxEntries(read.entries)
  return c.json({
    success: true,
    entries: read.entries,
    scanned: read.scanned,
    files: read.files,
    truncated: read.truncated,
    summary,
  })
})

// ─── Device event stream (0.6.88) — the Logs Manager "Devices" tab ──────────
//
// GET /api/logs/devices?event=&deviceId=&agencyId=&origin=&platform=
//                     &deviceType=&sessionId=&level=&uid=&q=&from=&to=&limit=
//
// Reads the unified cross-account stream (logs/_devices/<date>.ndjson)
// that BOTH the client device logger (mirrored by the ingest route) and the
// server-side device/pairing/kiosk mutations (device-event-log.ts) write to.
// Returns the newest entries + KPI aggregation + per-device timelines.

app.get('/devices', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const q = (name: string) => (c.req.query(name) || '').trim()
  const limitRaw = Number(q('limit')) || 0
  const filters: DeviceFilters = {
    event: q('event') || undefined,
    deviceId: q('deviceId') || undefined,
    agencyId: q('agencyId') || undefined,
    uid: q('uid') || undefined,
    origin: q('origin') || undefined,
    platform: q('platform') || undefined,
    deviceType: q('deviceType') || undefined,
    sessionId: q('sessionId') || undefined,
    level: q('level') || undefined,
    q: q('q') || undefined,
    from: q('from') || undefined,
    to: q('to') || undefined,
    limit: Math.max(1, Math.min(limitRaw || 600, 5_000)),
  }
  const read = readDeviceEntries(filters)
  const summary = summarizeDeviceEntries(read.entries)
  return c.json({
    success: true,
    entries: read.entries,
    scanned: read.scanned,
    files: read.files,
    truncated: read.truncated,
    summary,
  })
})

/** GET /api/logs/analysis/errors/:fp — full detail for ONE bug. */
app.get('/analysis/errors/:fp', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const rec = getError(c.req.param('fp').replace(/[^a-f0-9]/gi, ''))
  if (!rec) return c.json({ success: false, error: 'Error fingerprint not found' }, 404)
  return c.json({ success: true, error: rec })
})

/**
 * GET /api/logs/analysis — the filtered, severity-sorted error index.
 * Filters: uid, platform, role, appVersion, device, severity, minCount,
 *          q (text), from, to (YYYY-MM-DD), limit.
 */
app.get('/analysis', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const result = queryErrors(analysisFiltersFromQuery(c))
  return c.json({ success: true, ...result, summary: analysisSummary() })
})

// ─── Admin browsing (SUPER_ADMIN) ────────────────────────────────────────────

/** GET /api/logs — list account folders (with platform breakdown + sizes). */
app.get('/', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const root = logRoot()
  try {
    const folders = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => {
        const dir = path.join(root, d.name)
        let bytes = 0
        let files = 0
        let lastAt: string | null = null
        const platforms: string[] = []
        const walk = (p: string, depth: number) => {
          let entries: fs.Dirent[] = []
          try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            const full = path.join(p, e.name)
            if (e.isDirectory()) {
              if (depth === 0 && KNOWN_PLATFORMS.has(e.name)) platforms.push(e.name)
              walk(full, depth + 1)
            } else {
              if (e.name.endsWith('.ndjson') || e.name.endsWith('.json')) {
                files += 1
                try { bytes += fs.statSync(full).size } catch { /* raced */ }
              }
              if (e.name.startsWith('meta-')) {
                try {
                  const at = JSON.parse(fs.readFileSync(full, 'utf8')).at
                  if (typeof at === 'string' && (!lastAt || at > lastAt)) lastAt = at
                } catch { /* ignore */ }
              }
            }
          }
        }
        walk(dir, 0)
        return { uid: d.name, files, bytes, lastAt, platforms: platforms.sort() }
      })
      .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
    return c.json({ success: true, root, folders })
  } catch (err) {
    console.error('[logs] list failed:', err)
    return c.json({ success: false, error: 'Log storage unavailable' }, 500)
  }
})

/** GET /api/logs/:uid — one account folder: platform streams + legacy files. */
app.get('/:uid', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const uid = c.req.param('uid').replace(/[^A-Za-z0-9._-]/g, '')
  const dir = path.join(logRoot(), uid)
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const streams: Array<{ platform: string; files: Array<{ file: string; bytes: number; modified: string }> }> = []
    const legacyFiles: Array<{ file: string; bytes: number; modified: string }> = []

    const fileRow = (f: string, full: string) => {
      const st = fs.statSync(full)
      return { file: f, bytes: st.size, modified: st.mtime.toISOString() }
    }

    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory() && KNOWN_PLATFORMS.has(e.name)) {
        const files = fs.readdirSync(full)
          .filter((f) => f.endsWith('.ndjson') || f.endsWith('.json'))
          .map((f) => fileRow(f, path.join(full, f)))
          .sort((a, b) => b.file.localeCompare(a.file))
        streams.push({ platform: e.name, files })
      } else if (e.isFile() && (e.name.endsWith('.ndjson') || e.name.endsWith('.json'))) {
        // Pre-0.6.19 flat layout (or the account-level meta sidecar).
        if (e.name.startsWith('meta-')) continue // per-platform sidecars cover it now
        legacyFiles.push(fileRow(e.name, full))
      }
    }
    streams.sort((a, b) => a.platform.localeCompare(b.platform))
    legacyFiles.sort((a, b) => b.file.localeCompare(a.file))
    return c.json({ success: true, uid, streams, legacyFiles })
  } catch {
    return c.json({ success: false, error: 'No logs for this account' }, 404)
  }
})

/** GET /api/logs/:uid/:platform/:file — raw content from a platform stream. */
app.get('/:uid/:platform/:file', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const uid = c.req.param('uid').replace(/[^A-Za-z0-9._-]/g, '')
  const platform = c.req.param('platform').replace(/[^A-Za-z0-9_-]/g, '')
  const file = c.req.param('file').replace(/[^A-Za-z0-9._-]/g, (ch) => (ch === '-' || ch === '.' ? ch : '_'))
  if (!file.endsWith('.ndjson') && !file.endsWith('.json')) {
    return c.json({ success: false, error: 'Invalid file type' }, 400)
  }
  const root = logRoot()
  const target = path.join(root, uid, platform, file)
  if (!target.startsWith(root)) return c.json({ success: false, error: 'Invalid path' }, 400)
  try {
    const content = fs.readFileSync(target, 'utf8')
    return c.body(content, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
  } catch {
    return c.json({ success: false, error: 'Log file not found' }, 404)
  }
})

/** GET /api/logs/:uid/:file — LEGACY flat-layout raw content (pre-0.6.19). */
app.get('/:uid/:file', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const uid = c.req.param('uid').replace(/[^A-Za-z0-9._-]/g, '')
  const file = c.req.param('file').replace(/[^A-Za-z0-9._-]/g, (ch) => (ch === '-' || ch === '.' ? ch : '_'))
  if (!file.endsWith('.ndjson') && !file.endsWith('.json')) {
    return c.json({ success: false, error: 'Invalid file type' }, 400)
  }
  const root = logRoot()
  const target = path.join(root, uid, file)
  if (!target.startsWith(root)) return c.json({ success: false, error: 'Invalid path' }, 400)
  try {
    const content = fs.readFileSync(target, 'utf8')
    return c.body(content, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
  } catch {
    return c.json({ success: false, error: 'Log file not found' }, 404)
  }
})

// One-time cold-start restore of the analyzer state (last 3 days + index.json).
bootBackfill(logRoot())

export const logRoutes = app
