import { Hono } from 'hono'
import { requireAuth, requireRole, authErrorResponse } from '../lib/auth'
import { db } from '@blasti/db'

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
  type AnalysisFilters,
} from '../lib/logs-analyzer'

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
const KNOWN_PLATFORMS = new Set(['web', 'mobile', 'desktop', 'legacy'])

interface IncomingEntry {
  ts?: unknown
  level?: unknown
  tag?: unknown
  message?: unknown
  data?: unknown
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
  return { ts, level, tag, message, ...(data !== undefined ? { data } : {}) }
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
    deviceSpecs?: Record<string, string | number | boolean>
    perf?: Record<string, string | number | boolean>
    manual?: boolean
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
      deviceSpecs: sanitizeSmallObject(b.deviceSpecs),
      perf: sanitizeSmallObject(b.perf),
      manual: b.manual === true,
    }
  },
}

app.post('/', async (c) => {
  let user: Awaited<ReturnType<typeof requireAuth>>
  try {
    user = await requireAuth(c)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }

  let body: ReturnType<typeof ingestSchema.parse>
  try {
    body = ingestSchema.parse(await c.req.json())
  } catch {
    return c.json({ success: false, error: 'Invalid log payload' }, 400)
  }
  if (!body) return c.json({ success: false, error: 'Invalid log payload' }, 400)

  const resolvedUid = await resolveUid(user.id)
  const uidDir = path.join(logRoot(), folderFor(resolvedUid, user.id, user.role))
  // 0.6.19 — PLATFORM-SEPARATED streams under the SAME account folder.
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
    message: `batch ${body.manual ? '(MANUAL)' : '(auto)'} from ${platform} v${body.appVersion ?? '?'}`,
    data: {
      uid: resolvedUid,
      userId: user.id,
      username: user.username,
      role: user.role,
      platform,
      appVersion: body.appVersion,
      device: body.device,
      href: body.sessionHref,
      sessionId: body.sessionId,
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
      uid: resolvedUid,
      username: user.username,
      role: user.role,
    }
    fs.writeFileSync(path.join(dir, `meta-${dayStamp()}.json`), JSON.stringify(metaPayload, null, 1), { encoding: 'utf8' })
    fs.writeFileSync(path.join(uidDir, `meta-${dayStamp()}.json`), JSON.stringify(metaPayload, null, 1), { encoding: 'utf8' })
  } catch (err) {
    console.error('[logs] append failed:', err)
    return c.json({ success: false, error: 'Log write failed' }, 500)
  }

  // ── Realtime analysis (logs-2) — never fails the ingestion. ──
  try {
    analyzeBatch(
      {
        uid: resolvedUid,
        role: user.role,
        platform,
        appVersion: body.appVersion ?? 'unknown',
        device: body.device ?? 'unknown',
        date: dayStamp(),
        deviceSpecs,
        perf,
      },
      sanitized,
      body.manual === true,
    )
  } catch { /* analyzer guards itself too */ }

  return c.json({ success: true, accepted: sanitized.length, folder: `${folderFor(resolvedUid, user.id, user.role)}/${platform}` })
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
