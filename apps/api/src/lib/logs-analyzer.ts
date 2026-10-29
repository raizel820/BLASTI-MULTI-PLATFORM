/**
 * BLASTI Realtime Log Analyzer (logs-2 / 0.6.19)
 * ─────────────────────────────────────────────────────────────────────────────
 * The brain behind the Logs Manager. Every batch that lands on POST /api/logs
 * is fed here SYNCHRONOUSLY (in-memory, microseconds) and the disk artifacts
 * are flushed on a short debounce:
 *
 *   logs/_analysis/index.json                    — error fingerprint index
 *   logs/_daily/<platform>/<YYYY-MM-DD>.json     — per-day per-platform aggregate
 *                                                  (ALL accounts, auto-updated)
 *
 * What it does per batch:
 *   1. ERROR/WARN intake — each entry is normalized into a fingerprint
 *      (tag + message shape with numbers/uuids/hashes/paths collapsed) so
 *      "user AO-28-00001 not found" and "user AO-31-00007 not found" are ONE
 *      bug with many hits, not a thousand phantom bugs.
 *   2. Co-occurrence tracking — every hit records the shared attributes of the
 *      session that produced it (uid, platform, appVersion, device, role,
 *      date) so bugs can be isolated by ANY shared dimension.
 *   3. Severity scoring — level base + frequency + spread (distinct UIDs /
 *      platforms) + recency + crash-tags bonus → LOW/MEDIUM/HIGH/CRITICAL.
 *   4. Daily aggregates per platform — entries/warns/errors totals, per-account
 *      breakdown, top bugs, performance averages (page load, sync) — the
 *      "general json file for each day per platform including all accounts".
 *
 * Resilience: the index survives API restarts via the persisted JSON, and on
 * cold boot backfills itself from the last 3 days of NDJSON on disk (both the
 * platform-separated layout and the legacy per-UID layout) so a crash never
 * loses more than the unswept tail. Everything is best-effort: analysis
 * failures NEVER fail the log ingestion.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LogMeta {
  uid: string | null
  role: string
  platform: string
  appVersion: string
  device: string
  date: string // YYYY-MM-DD (UTC day the batch belongs to)
  deviceSpecs?: Record<string, unknown>
  perf?: Record<string, unknown>
}

interface HitSample {
  ts: string
  message: string
  data?: unknown
}

export interface ErrorRecord {
  fp: string
  tag: string
  level: 'warn' | 'error'
  /** Latest raw sample — what the admin sees first. */
  message: string
  count: number
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  severityScore: number
  firstSeen: string
  lastSeen: string
  samples: HitSample[]
  affected: {
    uids: string[]
    platforms: string[]
    appVersions: string[]
    devices: string[]
    roles: string[]
    dates: string[]
  }
}

interface AccountDaily {
  uid: string
  role: string
  appVersion: string
  device: string
  entries: number
  errors: number
  warns: number
  lastSeen: string
}

export interface DailyRecord {
  date: string
  platform: string
  updatedAt: string
  totals: {
    batches: number
    entries: number
    errors: number
    warns: number
    accounts: number
  }
  accounts: AccountDaily[]
  topErrors: Array<{ fp: string; count: number; severity: string; message: string; uids: number }>
  perf: {
    pageLoadMsAvg: number | null
    pageLoadMsSamples: number
    domReadyMsAvg: number | null
    heapMbAvg: number | null
  }
}

// ─── State ───────────────────────────────────────────────────────────────────

const INDEX_VERSION = 1
const MAX_ERRORS = 2000            // fingerprint cap (oldest lastSeen evicted)
const MAX_SAMPLES_PER_FP = 5
const MAX_LIST_PER_DIM = 40        // cap the affected.* arrays
const FLUSH_DEBOUNCE_MS = 2_000
const BACKFILL_DAYS = 3
const MAX_BACKFILL_FILE_BYTES = 20 * 1024 * 1024

const errors = new Map<string, ErrorRecord>()
const dailies = new Map<string, DailyRecord>() // key: `${platform}|${date}`

let flushTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false
let booted = false

// ─── Fingerprinting ──────────────────────────────────────────────────────────

/**
 * Collapse volatile parts of a message so the same bug produces ONE
 * fingerprint regardless of ids/paths/values embedded in it.
 */
export function normalizeMessage(tag: string, message: string): string {
  let m = (message || '')
    .slice(0, 4000)
    .toLowerCase()
  m = m
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ' <uuid>')
    .replace(/[0-9a-f]{16,}/g, ' <hex>')
    .replace(/(?:\/|\\)[\w.\-{}[\]@$!%+~]+(?:\/|\\[\w.\-{}[\]@$!%+~]+)+/g, ' <path>')
    .replace(/https?:\/\/\S+/g, ' <url>')
    .replace(/(["'`])[\s\S]{0,120}?\1/g, ' <str>')
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|gb|px)?\b/g, ' <n>')
    .replace(/[a-z]{1,3}-\d{2,}-\d{4,}/g, ' <uid>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  return `${tag.toLowerCase()}|${m}`
}

function fingerprint(tag: string, message: string): string {
  return crypto
    .createHash('sha1')
    .update(normalizeMessage(tag, message))
    .digest('hex')
    .slice(0, 16)
}

// ─── Severity ────────────────────────────────────────────────────────────────

const CRASH_TAGS = new Set(['window-error', 'unhandled-rejection', 'electron-main'])

function scoreSeverity(rec: { level: 'warn' | 'error'; count: number; affected: { uids: string[]; platforms: string[] }; lastSeen: string; tag: string }): { score: number; severity: ErrorRecord['severity'] } {
  const now = Date.now()
  let score = rec.level === 'error' ? 40 : 14
  score += Math.min(25, Math.log2(rec.count + 1) * 8)
  score += Math.min(20, rec.affected.uids.length * 4)
  score += Math.min(12, rec.affected.platforms.length * 6)
  const ageMs = now - new Date(rec.lastSeen).getTime()
  if (ageMs < 60 * 60_000) score += 15
  else if (ageMs < 24 * 60 * 60_000) score += 8
  if (CRASH_TAGS.has(rec.tag)) score += 10
  score = Math.round(score)
  const severity =
    score >= 70 ? 'CRITICAL' : score >= 50 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW'
  return { score, severity }
}

// ─── Intake ──────────────────────────────────────────────────────────────────

function pushToList(arr: string[], v: string): void {
  const s = (v || '').slice(0, 80)
  if (!s) return
  if (!arr.includes(s)) {
    arr.push(s)
    if (arr.length > MAX_LIST_PER_DIM) arr.shift() // drop the oldest
  }
}

function addError(meta: LogMeta, level: 'warn' | 'error', tag: string, message: string, ts: string, data?: unknown): void {
  const fp = fingerprint(tag, message)
  let rec = errors.get(fp)
  if (!rec) {
    rec = {
      fp,
      tag: tag.slice(0, 60),
      level,
      message: message.slice(0, 500),
      count: 0,
      severity: 'LOW',
      severityScore: 0,
      firstSeen: ts,
      lastSeen: ts,
      samples: [],
      affected: { uids: [], platforms: [], appVersions: [], devices: [], roles: [], dates: [] },
    }
    errors.set(fp, rec)
  }
  rec.count += 1
  rec.lastSeen = ts > rec.lastSeen ? ts : rec.lastSeen
  rec.message = message.slice(0, 500) // freshest sample wins for the list view
  if (rec.samples.length >= MAX_SAMPLES_PER_FP) rec.samples.shift()
  rec.samples.push({ ts, message: message.slice(0, 800), ...(data !== undefined ? { data } : {}) })
  pushToList(rec.affected.uids, meta.uid ?? (meta.role === 'SUPER_ADMIN' ? 'admin' : 'anonymous'))
  pushToList(rec.affected.platforms, meta.platform)
  pushToList(rec.affected.appVersions, meta.appVersion)
  pushToList(rec.affected.devices, meta.device)
  pushToList(rec.affected.roles, meta.role)
  pushToList(rec.affected.dates, meta.date)
  const scored = scoreSeverity({ level: rec.level, count: rec.count, affected: rec.affected, lastSeen: rec.lastSeen, tag: rec.tag })
  rec.severityScore = scored.score
  rec.severity = scored.severity
}

function dailyKey(platform: string, date: string): string {
  return `${platform || 'unknown'}|${date}`
}

function blankDaily(platform: string, date: string): DailyRecord {
  return {
    date,
    platform,
    updatedAt: new Date().toISOString(),
    totals: { batches: 0, entries: 0, errors: 0, warns: 0, accounts: 0 },
    accounts: [],
    topErrors: [],
    perf: { pageLoadMsAvg: null, pageLoadMsSamples: 0, domReadyMsAvg: null, heapMbAvg: null },
  }
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

function avg(base: number | null, sample: number, samples: number): number | null {
  if (base === null) return sample
  return (base * samples + sample) / (samples + 1)
}

function addDaily(meta: LogMeta, entries: Array<Record<string, unknown>>, batchCount: number): void {
  const key = dailyKey(meta.platform, meta.date)
  let d = dailies.get(key)
  if (!d) {
    d = blankDaily(meta.platform, meta.date)
    dailies.set(key, d)
  }
  d.updatedAt = new Date().toISOString()
  d.totals.batches += batchCount
  d.totals.entries += entries.length

  let uidKey = meta.uid ?? (meta.role === 'SUPER_ADMIN' ? 'admin' : 'anonymous')
  uidKey = uidKey.slice(0, 64)
  let acc = d.accounts.find((a) => a.uid === uidKey)
  if (!acc) {
    acc = { uid: uidKey, role: meta.role, appVersion: meta.appVersion, device: meta.device, entries: 0, errors: 0, warns: 0, lastSeen: d.updatedAt }
    d.accounts.push(acc)
  }
  acc.entries += entries.length
  acc.appVersion = meta.appVersion || acc.appVersion
  acc.device = meta.device || acc.device
  acc.role = meta.role || acc.role
  acc.lastSeen = d.updatedAt

  const perfLoad = meta.perf ? num(meta.perf.pageLoadMs) : null
  const perfDom = meta.perf ? num(meta.perf.domReadyMs) : null
  const perfHeap = meta.perf ? num(meta.perf.heapMb) : null
  if (perfLoad !== null) {
    d.perf.pageLoadMsAvg = Math.round(avg(d.perf.pageLoadMsAvg, perfLoad, d.perf.pageLoadMsSamples)!)
    d.perf.pageLoadMsSamples += 1
  }
  if (perfDom !== null) d.perf.domReadyMsAvg = Math.round(avg(d.perf.domReadyMsAvg, perfDom, d.perf.pageLoadMsSamples)!)
  if (perfHeap !== null) d.perf.heapMbAvg = Math.round(avg(d.perf.heapMbAvg, perfHeap, d.perf.pageLoadMsSamples)!)

  for (const e of entries) {
    const level = String(e.level ?? '')
    if (level === 'error') {
      d.totals.errors += 1
      acc.errors += 1
    } else if (level === 'warn') {
      d.totals.warns += 1
      acc.warns += 1
    }
  }
  d.accounts.sort((a, b) => b.entries - a.entries)
  if (d.accounts.length > 500) d.accounts.length = 500
  d.totals.accounts = d.accounts.length
}

/** Recompute the daily topErrors projection from the live error index. */
function refreshDailyTopErrors(d: DailyRecord): void {
  const date = d.date
  const rows = [...errors.values()]
    .filter((r) => r.affected.dates.includes(date) && r.affected.platforms.includes(d.platform))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)
    .map((r) => ({ fp: r.fp, count: r.count, severity: r.severity, message: r.message.slice(0, 160), uids: r.affected.uids.length }))
  d.topErrors = rows
}

/**
 * THE realtime hook — called from POST /api/logs with the sanitized batch.
 * Synchronous in-memory work only; disk writes are debounced.
 */
export function analyzeBatch(meta: LogMeta, entries: Array<Record<string, unknown>>, manual: boolean): void {
  try {
    addDaily(meta, entries, 1)
    for (const e of entries) {
      const level = String(e.level ?? 'info')
      if (level !== 'error' && level !== 'warn') continue
      // Session envelopes are the server's own bookkeeping — never bugs.
      if (String(e.tag ?? '') === 'session') continue
      addError(meta, level === 'error' ? 'error' : 'warn', String(e.tag ?? 'app'), String(e.message ?? ''), String(e.ts ?? new Date().toISOString()), e.data)
    }
    if (manual) markDirty() // manual uploads flush fast so the UI shows them immediately
    markDirty()
  } catch { /* analysis must never break ingestion */ }
}

function markDirty(): void {
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DEBOUNCE_MS)
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function analysisRoot(): string {
  return process.env.BLASTI_LOG_DIR
    ? path.join(process.env.BLASTI_LOG_DIR, '_analysis')
    : path.join(process.cwd(), 'logs', '_analysis')
}

function dailyRoot(): string {
  return process.env.BLASTI_LOG_DIR
    ? path.join(process.env.BLASTI_LOG_DIR, '_daily')
    : path.join(process.cwd(), 'logs', '_daily')
}

function atomicWrite(file: string, content: string): void {
  const dir = path.dirname(file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, content, { encoding: 'utf8' })
    fs.renameSync(tmp, file)
  } catch { /* best-effort */ }
}

async function flush(): Promise<void> {
  if (!dirty) return
  dirty = false
  try {
    // Evict the coldest fingerprints when the index outgrows its cap.
    if (errors.size > MAX_ERRORS) {
      const sorted = [...errors.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))
      for (const stale of sorted.slice(0, errors.size - MAX_ERRORS)) errors.delete(stale.fp)
    }
    for (const d of dailies.values()) refreshDailyTopErrors(d)
    const indexPayload = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      totalErrors: errors.size,
      errors: Object.fromEntries([...errors.values()].sort((a, b) => b.severityScore - a.severityScore).map((r) => [r.fp, r])),
    }
    atomicWrite(path.join(analysisRoot(), 'index.json'), JSON.stringify(indexPayload))
    for (const d of dailies.values()) {
      atomicWrite(path.join(dailyRoot(), d.platform.replace(/[^a-z0-9_-]/gi, '_'), `${d.date}.json`), JSON.stringify(d, null, 1))
    }
  } catch { /* never crash the API on analysis housekeeping */ }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export interface AnalysisFilters {
  uid?: string
  platform?: string
  role?: string
  appVersion?: string
  device?: string
  severity?: string
  minCount?: number
  q?: string
  from?: string
  to?: string
  limit?: number
}

function matchesFilters(rec: ErrorRecord, f: AnalysisFilters): boolean {
  if (f.uid && !rec.affected.uids.some((u) => u.toLowerCase().includes(f.uid!.toLowerCase()))) return false
  if (f.platform && !rec.affected.platforms.includes(f.platform)) return false
  if (f.role && !rec.affected.roles.includes(f.role)) return false
  if (f.appVersion && !rec.affected.appVersions.includes(f.appVersion)) return false
  if (f.device && !rec.affected.devices.some((d) => d.toLowerCase().includes(f.device!.toLowerCase()))) return false
  if (f.severity && rec.severity !== f.severity) return false
  if (f.minCount && rec.count < f.minCount) return false
  if (f.from && rec.lastSeen.slice(0, 10) < f.from) return false
  if (f.to && rec.firstSeen.slice(0, 10) > f.to) return false
  if (f.q) {
    const q = f.q.toLowerCase()
    const hay = `${rec.tag} ${rec.message}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

export function queryErrors(f: AnalysisFilters): { updatedAt: string; total: number; errors: ErrorRecord[] } {
  const all = [...errors.values()]
    .filter((r) => matchesFilters(r, f))
    .sort((a, b) => b.severityScore - a.severityScore || b.count - a.count)
  const limit = Math.min(f.limit ?? 100, 500)
  return { updatedAt: new Date().toISOString(), total: all.length, errors: all.slice(0, limit) }
}

export function getError(fp: string): ErrorRecord | null {
  return errors.get(fp) ?? null
}

export function analysisSummary(): {
  totalErrors: number
  bySeverity: Record<string, number>
  byPlatform: Record<string, number>
  last24h: number
  updatedAt: string
} {
  const bySeverity: Record<string, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
  const byPlatform: Record<string, number> = {}
  let last24h = 0
  const cutoff = Date.now() - 24 * 60 * 60_000
  for (const r of errors.values()) {
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1
    for (const p of r.affected.platforms) byPlatform[p] = (byPlatform[p] ?? 0) + 1
    if (new Date(r.lastSeen).getTime() >= cutoff) last24h += 1
  }
  return { totalErrors: errors.size, bySeverity, byPlatform, last24h, updatedAt: new Date().toISOString() }
}

export function listDailyFiles(): Array<{ platform: string; date: string; file: string; bytes: number }> {
  const out: Array<{ platform: string; date: string; file: string; bytes: number }> = []
  try {
    const root = dailyRoot()
    for (const plat of fs.readdirSync(root, { withFileTypes: true })) {
      if (!plat.isDirectory()) continue
      const dir = path.join(root, plat.name)
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try {
          out.push({ platform: plat.name, date: f.replace('.json', ''), file: `${plat.name}/${f}`, bytes: fs.statSync(path.join(dir, f)).size })
        } catch { /* raced */ }
      }
    }
  } catch { /* no dailies yet */ }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.platform.localeCompare(b.platform))
}

export function readDailyFile(platform: string, date: string): string | null {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '')
  const file = path.join(dailyRoot(), safe(platform), `${safe(date)}.json`)
  if (!file.startsWith(dailyRoot())) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    // Fall back to the in-memory copy (debounce may not have flushed yet).
    const d = dailies.get(dailyKey(platform, date))
    return d ? JSON.stringify(d, null, 1) : null
  }
}

/** Full report payload — one bug (fp) or all matching the filters. */
export function buildReport(fp: string | null, f: AnalysisFilters): {
  generatedAt: string
  scope: string
  filters: AnalysisFilters
  summary: ReturnType<typeof analysisSummary>
  bugs: ErrorRecord[]
} {
  const bugs = fp ? ([getError(fp)].filter((r): r is ErrorRecord => !!r)) : queryErrors(f).errors
  return {
    generatedAt: new Date().toISOString(),
    scope: fp ? `single-error:${fp}` : 'all-filtered-errors',
    filters: f,
    summary: analysisSummary(),
    bugs,
  }
}

// ─── Boot backfill (rebuild from disk after a restart/crash) ─────────────────

function metaFromEnvelope(obj: Record<string, unknown>, fallback: LogMeta): LogMeta {
  const d = (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>
  return {
    uid: typeof d.uid === 'string' ? d.uid : fallback.uid,
    role: typeof d.role === 'string' ? d.role : fallback.role,
    platform: typeof d.platform === 'string' && d.platform ? d.platform : fallback.platform,
    appVersion: typeof d.appVersion === 'string' ? d.appVersion : fallback.appVersion,
    device: typeof d.device === 'string' ? d.device : fallback.device,
    date: fallback.date,
    // 0.6.19 envelopes carry the perf/deviceSpecs objects — restore them so
    // restart backfills keep the daily performance averages alive.
    deviceSpecs: (d.deviceSpecs && typeof d.deviceSpecs === 'object' ? d.deviceSpecs : fallback.deviceSpecs) as LogMeta['deviceSpecs'],
    perf: (d.perf && typeof d.perf === 'object' ? d.perf : fallback.perf) as LogMeta['perf'],
  }
}

function backfillFile(file: string, fallback: LogMeta): void {
  let content = ''
  try {
    if (fs.statSync(file).size > MAX_BACKFILL_FILE_BYTES) return
    content = fs.readFileSync(file, 'utf8')
  } catch {
    return
  }
  let meta = fallback
  // Batch-grouped replay: a session envelope starts a new batch; entries
  // accumulate until the next envelope/EOF, then feed analyzeBatch ONCE —
  // keeps daily batch/entry counts and perf averages faithful to the live
  // ingestion path.
  let pending: Array<Record<string, unknown>> = []
  const drain = () => {
    if (pending.length === 0) return
    analyzeBatch(meta, pending, false)
    pending = []
  }
  for (const line of content.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      const tag = String(obj.tag ?? '')
      if (tag === 'session') {
        drain()
        meta = metaFromEnvelope(obj, fallback)
        continue
      }
      // ALL levels flow into the batch (analyzeBatch routes them exactly like
      // the live POST path: daily counts every entry, error intake filters).
      pending.push(obj)
    } catch { /* skip malformed line */ }
  }
  drain()
}

/**
 * Idempotent cold-start restore. Called once from the logs route mount.
 * Reads the last BACKFILL_DAYS days from BOTH layouts:
 *   <UID>/<platform>/<date>.ndjson (0.6.19+) and <UID>/<date>.ndjson (legacy).
 */
export function bootBackfill(root: string): void {
  if (booted) return
  booted = true
  try {
    const since = new Date(Date.now() - BACKFILL_DAYS * 24 * 60 * 60_000).toISOString().slice(0, 10)
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('_')) continue
      const uidDir = path.join(root, ent.name)
      // guess platform from subfolders; legacy files default to "legacy"
      for (const f of fs.readdirSync(uidDir)) {
        const full = path.join(uidDir, f)
        try {
          const st = fs.statSync(full)
          if (st.isDirectory()) {
            // platform subfolder (0.6.19 layout)
            if (f.startsWith('meta-')) continue
            for (const day of fs.readdirSync(full)) {
              if (!day.endsWith('.ndjson')) continue
              if (day.slice(0, 10) < since) continue
              backfillFile(path.join(full, day), { uid: ent.name, role: 'unknown', platform: f, appVersion: 'unknown', device: 'unknown', date: day.slice(0, 10) })
            }
          } else if (f.endsWith('.ndjson') && f.slice(0, 10) >= since) {
            backfillFile(full, { uid: ent.name, role: 'unknown', platform: 'legacy', appVersion: 'unknown', device: 'unknown', date: f.slice(0, 10) })
          }
        } catch { /* raced file */ }
      }
    }
    // hydrate from the persisted index last (disk truth beats the backfill
    // for records that were evicted by the day window)
    try {
      const raw = fs.readFileSync(path.join(analysisRoot(), 'index.json'), 'utf8')
      const parsed = JSON.parse(raw) as { errors?: Record<string, ErrorRecord> }
      for (const [fp, rec] of Object.entries(parsed.errors ?? {})) {
        const existing = errors.get(fp)
        if (!existing || existing.count < rec.count) errors.set(fp, { ...rec })
      }
    } catch { /* no index yet — backfill result stands */ }
    markDirty()
  } catch { /* empty root or unreadable — start clean */ }
}

/** Test/diagnostic helper — current in-memory sizes. */
export function analyzerStats(): { errorsInMemory: number; dailiesInMemory: number } {
  return { errorsInMemory: errors.size, dailiesInMemory: dailies.size }
}
