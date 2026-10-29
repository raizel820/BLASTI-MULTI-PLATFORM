/**
 * BLASTI Log Analyzer (logs-0.6.18) — realtime issue extraction + severity.
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs INLINE on every POST /api/logs batch (analysis happens as the entries
 * land — no cron, no delay). It:
 *
 *   1. Fingerprints every warn/error entry into a stable issue id
 *      (tag + normalized message — numbers/UUIDs/URLs stripped so "error on
 *      row 4171" and "error on row 88" are ONE issue, not thousands).
 *   2. Maintains a rolling issues index on disk:
 *        ${logRoot}/_analysis/issues-index.json
 *      each issue: signature, severity, count, first/last seen, per-day
 *      counts (14-day retention), affected UIDs / platforms / appVersions /
 *      roles / devices, and up to 5 raw samples.
 *   3. Aggregates performance signals (perf-boot / perf-sync / perf
 *      heartbeats) into the per-day per-platform daily aggregate the Logs
 *      Manager charts:
 *        ${logRoot}/_daily/<YYYY-MM-DD>/<platform>.json
 *
 * Severity ladder (deterministic, first match wins):
 *   critical — client crashes (unhandled-rejection / window-error) or
 *              renderer THROW pipeline failures
 *   high     — any error-level entry, or a warn firing ≥25×/day (noisy
 *              recurring warn is production-impacting even when "handled")
 *   medium   — warn-level entries (incl. sync failures)
 *   low      — everything else worth surfacing (stale-server cooldowns, …)
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnalyzerEntry {
  ts?: unknown
  level?: unknown
  tag?: unknown
  message?: unknown
  data?: unknown
}

export interface AnalyzerCtx {
  uid: string | null
  username: string | null
  role: string | null
  platform: string | null
  appVersion: string | null
  device: string | null
  deviceSpecs?: unknown
}

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface IssueSample {
  ts: string
  uid: string | null
  platform: string | null
  appVersion: string | null
  role: string | null
  level: string
  message: string
  data?: unknown
}

export interface IssueRecord {
  id: string
  tag: string
  level: string
  message: string
  severity: Severity
  count: number
  firstSeen: string
  lastSeen: string
  days: Record<string, number>
  affected: {
    uids: Record<string, number>
    platforms: Record<string, number>
    appVersions: Record<string, number>
    roles: Record<string, number>
    devices: Record<string, number>
  }
  samples: IssueSample[]
}

export interface IssuesIndex {
  updatedAt: string
  totalIssues: number
  issues: IssueRecord[]
}

// ─── Tunables ────────────────────────────────────────────────────────────────

const DAY_RETENTION = 14            // per-day issue counts kept
const MAX_ISSUES = 400              // index size cap (evict oldest lastSeen)
const MAX_SAMPLES_PER_ISSUE = 5
const NOISY_WARN_DAILY = 25         // warn ×/day → escalates to high
const MAX_ENTRY_MESSAGE = 200       // signature keeps a compact message
const MAX_MESSAGE_CHARS = 8_000     // sample keeps the full (sanitized) message

// ─── Storage layout ──────────────────────────────────────────────────────────

/** Canonical vault root (shared by ingestion, analyzer and manager routes). */
export function logRootOf(): string {
  return process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs')
}

export function analysisDir(logRoot: string): string {
  return path.join(logRoot, '_analysis')
}

export function issuesIndexPath(logRoot: string): string {
  return path.join(analysisDir(logRoot), 'issues-index.json')
}

export function dailyDir(logRoot: string, date: string): string {
  return path.join(logRoot, '_daily', date)
}

// ─── Normalization / fingerprinting ──────────────────────────────────────────

/** Stable compact fingerprint of (tag + normalized message). */
export function fingerprint(tag: string, level: string, message: string): string {
  return crypto.createHash('sha1').update(`${tag}::${level}::${normalizeMessage(message)}`).digest('hex').slice(0, 12)
}

/**
 * Collapse volatile noise so one root cause maps to ONE issue id:
 * numbers → N, ids/UUIDs/cuids → #, URLs → <url>, hex → <hex>, whitespace.
 */
export function normalizeMessage(message: string): string {
  let m = message
    .slice(0, 500)
    .replace(/https?:\/\/[^\s"')\]]+/g, '<url>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[c][mp][a-z0-9]{20,}\b/g, '<id>') // cuid/cmid family
    .replace(/\b\d[\d.,]*\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
  return m.slice(0, MAX_ENTRY_MESSAGE)
}

// ─── Severity ────────────────────────────────────────────────────────────────

const CRASH_TAGS = new Set(['window-error', 'unhandled-rejection'])

export function severityFor(level: string, tag: string, message: string, dayCount: number): Severity {
  const msg = message.toLowerCase()
  if (level === 'error') {
    if (CRASH_TAGS.has(tag) || msg.includes('[apiclient:throw]') || msg.includes('[renderererror]')) return 'critical'
    return 'high'
  }
  if (level === 'warn') {
    if (dayCount >= NOISY_WARN_DAILY) return 'high'
    if (tag === 'perf-sync' || tag === 'logger' || tag === 'boot-gate') return 'medium'
    return 'medium'
  }
  return 'low'
}

// ─── Index IO (mtime-cached so bursts don't re-read the file) ────────────────

let indexCache: { body: IssuesIndex; mtimeMs: number } | null = null

function readIndex(logRoot: string): IssuesIndex {
  const file = issuesIndexPath(logRoot)
  try {
    const st = fs.statSync(file)
    if (indexCache && indexCache.mtimeMs === st.mtimeMs) return indexCache.body
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as IssuesIndex
    if (!body || !Array.isArray(body.issues)) throw new Error('bad index')
    indexCache = { body, mtimeMs: st.mtimeMs }
    return body
  } catch {
    const fresh: IssuesIndex = { updatedAt: new Date().toISOString(), totalIssues: 0, issues: [] }
    indexCache = { body: fresh, mtimeMs: -1 }
    return fresh
  }
}

function writeIndex(logRoot: string, index: IssuesIndex): void {
  const dir = analysisDir(logRoot)
  try {
    fs.mkdirSync(dir, { recursive: true })
    // Evict: cap issue count (least recently seen first) + stale day buckets.
    const cutoff = dayStamp(Date.now() - DAY_RETENTION * 86_400_000)
    for (const issue of index.issues) {
      for (const day of Object.keys(issue.days)) {
        if (day < cutoff) delete issue.days[day]
      }
    }
    index.issues = index.issues
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, MAX_ISSUES)
    index.totalIssues = index.issues.length
    index.updatedAt = new Date().toISOString()
    const tmp = issuesIndexPath(logRoot) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(index))
    fs.renameSync(tmp, issuesIndexPath(logRoot))
    indexCache = { body: index, mtimeMs: fs.statSync(issuesIndexPath(logRoot)).mtimeMs }
  } catch { /* analysis is best-effort — ingestion must never fail for it */ }
}

function dayStamp(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function readIssuesIndex(logRoot: string): IssuesIndex {
  return readIndex(logRoot)
}

// ─── Realtime batch analysis ─────────────────────────────────────────────────

/**
 * Analyze ONE ingested batch. Called from the POST /api/logs handler after
 * sanitization — updates the issues index (warn/error) and the daily
 * per-platform aggregate (all levels + perf stats). Never throws.
 */
export function analyzeBatch(logRoot: string, entries: Record<string, unknown>[], ctx: AnalyzerCtx, platformKey: string): void {
  try {
    const today = dayStamp()
    const index = readIndex(logRoot)

    for (const entry of entries) {
      const level = String(entry.level ?? 'info')
      const tag = String(entry.tag ?? 'app')
      const message = String(entry.message ?? '').slice(0, MAX_MESSAGE_CHARS)
      const ts = String(entry.ts ?? new Date().toISOString())

      // ── 1. Issue fingerprinting (warn/error only) ──
      if (level === 'warn' || level === 'error') {
        const id = fingerprint(tag, level, message)
        let issue = index.issues.find((i) => i.id === id)
        if (!issue) {
          issue = {
            id,
            tag,
            level,
            message: normalizeMessage(message),
            severity: 'low',
            count: 0,
            firstSeen: ts,
            lastSeen: ts,
            days: {},
            affected: { uids: {}, platforms: {}, appVersions: {}, roles: {}, devices: {} },
            samples: [],
          }
          index.issues.push(issue)
        }
        issue.count += 1
        issue.lastSeen = ts
        issue.days[today] = (issue.days[today] ?? 0) + 1
        bump(issue.affected.uids, ctx.uid ?? 'anonymous')
        bump(issue.affected.platforms, platformKey)
        bump(issue.affected.appVersions, ctx.appVersion ?? '?')
        bump(issue.affected.roles, ctx.role ?? '?')
        bump(issue.affected.devices, deviceKey(ctx))
        // Severity uses today's running count (noisy warn escalates live).
        issue.severity = severityFor(level, tag, message, issue.days[today] ?? 1)
        if (issue.samples.length < MAX_SAMPLES_PER_ISSUE) {
          issue.samples.push({
            ts,
            uid: ctx.uid,
            platform: platformKey,
            appVersion: ctx.appVersion,
            role: ctx.role,
            level,
            message: message.slice(0, MAX_MESSAGE_CHARS),
            ...(entry.data !== undefined ? { data: entry.data } : {}),
          })
        }
      }

      // ── 2. Perf aggregation ──
      const data = (entry.data && typeof entry.data === 'object') ? entry.data as Record<string, unknown> : null
      if (tag === 'perf-boot' || tag === 'perf-sync' || tag === 'perf') {
        dailyPerf(logRoot, today, platformKey, tag, data, level === 'warn')
      }
    }

    writeIndex(logRoot, index)

    // ── 3. Daily per-platform aggregate (all accounts) ──
    updateDailyAggregate(logRoot, today, platformKey, entries, ctx, index)
  } catch { /* analysis must never break ingestion */ }
}

function bump(map: Record<string, number>, key: string): void {
  const k = key.slice(0, 80) || '?'
  map[k] = (map[k] ?? 0) + 1
}

function deviceKey(ctx: AnalyzerCtx): string {
  const specs = (ctx.deviceSpecs && typeof ctx.deviceSpecs === 'object') ? ctx.deviceSpecs as Record<string, unknown> : {}
  const model = typeof specs.model === 'string' && specs.model ? specs.model : null
  if (model) return model
  if (typeof ctx.device === 'string' && ctx.device) {
    // "capacitor-android; Mozilla/5.0 (Linux; Android 13; SM-A536B)…" → SM-A536B
    const m = ctx.device.match(/\b([A-Z][A-Za-z0-9-]+(?:-[A-Za-z0-9]+)+)\b(?!.*\))|\bSM-[A-Z0-9]+\b|\bPixel \d\w?\b/)
    if (m) return m[0].slice(0, 60)
    return ctx.device.split(';')[0].slice(0, 60)
  }
  return 'unknown'
}

// ─── Daily aggregates (all accounts, per platform, per day) ──────────────────

interface DailyAccount {
  username: string | null
  role: string | null
  batches: number
  entries: number
  levels: Record<string, number>
  appVersions: Record<string, number>
  devices: Record<string, number>
  lastDeviceSpecs?: unknown
  lastAt: string | null
}

interface DailyPerf {
  boot: { count: number; maxMs: number; sumMs: number }
  sync: { count: number; failCount: number; maxMs: number; sumMs: number; rows: number }
  heap: { count: number; maxMb: number; sumMb: number }
}

function emptyPerf(): DailyPerf {
  return {
    boot: { count: 0, maxMs: 0, sumMs: 0 },
    sync: { count: 0, failCount: 0, maxMs: 0, sumMs: 0, rows: 0 },
    heap: { count: 0, maxMb: 0, sumMb: 0 },
  }
}

function readDaily(logRoot: string, date: string, platformKey: string): Record<string, unknown> {
  const file = path.join(dailyDir(logRoot, date), `${platformKey}.json`)
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
    return { date, platform: platformKey, updatedAt: null, totals: { batches: 0, entries: 0, levels: {} }, accounts: {}, perf: emptyPerf(), topIssues: [] }
  }
}

function writeDaily(logRoot: string, date: string, platformKey: string, body: Record<string, unknown>): void {
  const dir = dailyDir(logRoot, date)
  try {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${platformKey}.json.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(body))
    fs.renameSync(tmp, path.join(dir, `${platformKey}.json`))
  } catch { /* best-effort */ }
}

function dailyPerf(logRoot: string, date: string, platformKey: string, tag: string, data: Record<string, unknown> | null, failed: boolean): void {
  const body = readDaily(logRoot, date, platformKey)
  const perf = (body.perf as DailyPerf | undefined) ?? emptyPerf()
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  if (tag === 'perf-boot') {
    perf.boot.count += 1
    perf.boot.sumMs += num(data?.elapsedMs)
    perf.boot.maxMs = Math.max(perf.boot.maxMs, num(data?.elapsedMs))
  } else if (tag === 'perf-sync') {
    perf.sync.count += 1
    if (failed) perf.sync.failCount += 1
    perf.sync.sumMs += num(data?.durationMs)
    perf.sync.maxMs = Math.max(perf.sync.maxMs, num(data?.durationMs))
    perf.sync.rows += num(data?.rows)
  } else if (tag === 'perf') {
    perf.heap.count += 1
    perf.heap.sumMb += num(data?.heapMb)
    perf.heap.maxMb = Math.max(perf.heap.maxMb, num(data?.heapMb))
  }
  body.perf = perf
  writeDaily(logRoot, date, platformKey, body)
}

function updateDailyAggregate(
  logRoot: string,
  date: string,
  platformKey: string,
  entries: Record<string, unknown>[],
  ctx: AnalyzerCtx,
  index: IssuesIndex,
): void {
  const body = readDaily(logRoot, date, platformKey)
  const uidKey = ctx.uid ?? 'anonymous'

  const totals = (body.totals as { batches?: number; entries?: number; levels?: Record<string, number> } | undefined) ?? {}
  totals.batches = (totals.batches ?? 0) + 1
  totals.entries = (totals.entries ?? 0) + entries.length
  const levels = (totals.levels as Record<string, number> | undefined) ?? {}
  for (const entry of entries) {
    const lv = String(entry.level ?? 'info')
    levels[lv] = (levels[lv] ?? 0) + 1
  }
  totals.levels = levels
  body.totals = totals
  body.updatedAt = new Date().toISOString()

  const accounts = (body.accounts as Record<string, DailyAccount> | undefined) ?? {}
  const acc: DailyAccount = accounts[uidKey] ?? {
    username: ctx.username,
    role: ctx.role,
    batches: 0,
    entries: 0,
    levels: {},
    appVersions: {},
    devices: {},
    lastAt: null,
  }
  acc.batches += 1
  acc.entries += entries.length
  acc.username = ctx.username ?? acc.username
  acc.role = ctx.role ?? acc.role
  for (const entry of entries) {
    const lv = String(entry.level ?? 'info')
    acc.levels[lv] = (acc.levels[lv] ?? 0) + 1
  }
  if (ctx.appVersion) acc.appVersions[ctx.appVersion] = (acc.appVersions[ctx.appVersion] ?? 0) + 1
  const devK = deviceKey(ctx)
  acc.devices[devK] = (acc.devices[devK] ?? 0) + 1
  if (ctx.deviceSpecs) acc.lastDeviceSpecs = ctx.deviceSpecs
  acc.lastAt = new Date().toISOString()
  accounts[uidKey] = acc
  body.accounts = accounts

  // Top issues snapshot for this day+platform (count desc, 10 max).
  body.topIssues = index.issues
    .filter((i) => (i.affected.platforms[platformKey] ?? 0) > 0)
    .sort((a, b) => (b.days[date] ?? 0) - (a.days[date] ?? 0) || b.count - a.count)
    .slice(0, 10)
    .map((i) => ({ id: i.id, severity: i.severity, count: i.count, today: i.days[date] ?? 0, tag: i.tag, message: i.message }))

  writeDaily(logRoot, date, platformKey, body)
}

// ─── Filtering + reports ─────────────────────────────────────────────────────

export interface IssueFilters {
  severity?: string | null
  platform?: string | null
  role?: string | null
  appVersion?: string | null
  uid?: string | null
  minCount?: number
  q?: string | null
  date?: string | null
}

export function filterIssues(index: IssuesIndex, f: IssueFilters): IssueRecord[] {
  const q = (f.q ?? '').toLowerCase()
  return index.issues
    .filter((i) => {
      if (f.severity && f.severity !== 'all' && i.severity !== f.severity) return false
      if (f.platform && f.platform !== 'all' && !(i.affected.platforms[f.platform] > 0)) return false
      if (f.role && f.role !== 'all' && !(i.affected.roles[f.role] > 0)) return false
      if (f.appVersion && f.appVersion !== 'all' && !(i.affected.appVersions[f.appVersion] > 0)) return false
      if (f.uid && f.uid !== 'all' && !(i.affected.uids[f.uid] > 0)) return false
      if (f.minCount && f.minCount > 0 && i.count < f.minCount) return false
      if (f.date && !(i.days[f.date] > 0)) return false
      if (q && !`${i.tag} ${i.message}`.toLowerCase().includes(q)) return false
      return true
    })
    .sort((a, b) => (b.days[f.date ?? ''] ?? 0) - (a.days[f.date ?? ''] ?? 0) || b.count - a.count)
}

/** Human-readable triage report (markdown) for one or ALL filtered issues. */
export function buildIssueReportMd(issues: IssueRecord[], filters: IssueFilters): string {
  const lines: string[] = []
  lines.push(`# BLASTI Log Issues Report`)
  lines.push('')
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Filters: ${JSON.stringify(filters)}`)
  lines.push(`- Issues: ${issues.length}`)
  lines.push('')
  for (const i of issues) {
    lines.push(`## [${i.severity.toUpperCase()}] ${i.tag} — ${i.message}`)
    lines.push('')
    lines.push(`- id: \`${i.id}\` · level: ${i.level} · count: ${i.count}`)
    lines.push(`- first seen: ${i.firstSeen} · last seen: ${i.lastSeen}`)
    lines.push(`- per-day: ${JSON.stringify(i.days)}`)
    lines.push(`- UIDs: ${topKeys(i.affected.uids)}`)
    lines.push(`- platforms: ${topKeys(i.affected.platforms)}`)
    lines.push(`- app versions: ${topKeys(i.affected.appVersions)}`)
    lines.push(`- roles: ${topKeys(i.affected.roles)}`)
    lines.push(`- devices: ${topKeys(i.affected.devices)}`)
    if (i.samples.length > 0) {
      lines.push('')
      lines.push('```json')
      lines.push(JSON.stringify(i.samples[0], null, 1).slice(0, 2_000))
      lines.push('```')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function topKeys(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}×${v}`)
    .join(', ') || '—'
}

// ─── Full rebuild (admin "reanalyze" button) ─────────────────────────────────

/** Re-scan every stored NDJSON file and rebuild the issues index from zero. */
export function rebuildIssuesIndex(logRoot: string, opts: { maxFileBytes?: number } = {}): { issues: number; scanned: number; skipped: number } {
  const MAX_FILE_BYTES = opts.maxFileBytes ?? 8 * 1024 * 1024
  const fresh: IssuesIndex = { updatedAt: new Date().toISOString(), totalIssues: 0, issues: [] }
  let scanned = 0
  let skipped = 0

  let folders: string[] = []
  try { folders = fs.readdirSync(logRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name) } catch { /* no root yet */ }

  for (const folder of folders) {
    // Layout: <UID>/<platform>/<date>.ndjson (+ legacy <UID>/<date>.ndjson).
    const platformDirs: Array<{ platform: string; dir: string }> = []
    try {
      for (const d of fs.readdirSync(path.join(logRoot, folder), { withFileTypes: true })) {
        if (d.isDirectory() && ['web', 'mobile', 'desktop', 'unknown'].includes(d.name)) {
          platformDirs.push({ platform: d.name, dir: path.join(logRoot, folder, d.name) })
        }
      }
      platformDirs.push({ platform: 'legacy', dir: path.join(logRoot, folder) })
    } catch { continue }

    for (const { platform, dir } of platformDirs) {
      let files: string[] = []
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')) } catch { continue }
      for (const file of files) {
        const full = path.join(dir, file)
        try {
          const st = fs.statSync(full)
          if (st.size > MAX_FILE_BYTES) { skipped++; continue }
          const content = fs.readFileSync(full, 'utf8')
          // Batch ctx — refreshed by each session envelope line, applied to the
          // warn/error lines that follow it (mirrors the realtime path).
          let ctx: { uid: string | null; role: string | null; appVersion: string | null; device: string | null } = { uid: null, role: null, appVersion: null, device: null }
          for (const line of content.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            let obj: Record<string, unknown>
            try { obj = JSON.parse(trimmed) } catch { continue }
            const tag = String(obj.tag ?? '')
            const level = String(obj.level ?? '')

            if (tag === 'session' && obj.data && typeof obj.data === 'object') {
              const d = obj.data as Record<string, unknown>
              ctx = {
                uid: typeof d.uid === 'string' ? d.uid : null,
                role: typeof d.role === 'string' ? d.role : null,
                appVersion: typeof d.appVersion === 'string' ? d.appVersion : null,
                device: typeof d.device === 'string' ? d.device : null,
              }
              scanned++
              continue
            }
            if (level !== 'warn' && level !== 'error') { scanned++; continue }
            scanned++
            const message = String(obj.message ?? '')
            const id = fingerprint(tag || 'app', level, message)
            let issue = fresh.issues.find((i) => i.id === id)
            if (!issue) {
              issue = {
                id, tag: tag || 'app', level, message: normalizeMessage(message), severity: 'low',
                count: 0, firstSeen: String(obj.ts ?? ''), lastSeen: String(obj.ts ?? ''),
                days: {}, affected: { uids: {}, platforms: {}, appVersions: {}, roles: {}, devices: {} },
                samples: [],
              }
              fresh.issues.push(issue)
            }
            const ts = String(obj.ts ?? '')
            issue.count += 1
            if (ts && ts > issue.lastSeen) issue.lastSeen = ts
            const day = ts.slice(0, 10) || dayStamp()
            issue.days[day] = (issue.days[day] ?? 0) + 1
            const platformLabel = platform === 'legacy' ? 'web' : platform
            bump(issue.affected.platforms, platformLabel)
            bump(issue.affected.uids, ctx.uid ?? 'anonymous')
            bump(issue.affected.roles, ctx.role ?? '?')
            bump(issue.affected.appVersions, ctx.appVersion ?? '?')
            bump(issue.affected.devices, ctx.device ? ctx.device.split(';')[0].slice(0, 60) : 'unknown')
            issue.severity = severityFor(level, tag || 'app', message, issue.days[day] ?? 1)
          }
        } catch { skipped++ }
      }
    }
  }

  fresh.totalIssues = fresh.issues.length
  const tmp = issuesIndexPath(logRoot) + '.tmp'
  try {
    fs.mkdirSync(analysisDir(logRoot), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(fresh))
    fs.renameSync(tmp, issuesIndexPath(logRoot))
    indexCache = { body: fresh, mtimeMs: fs.statSync(issuesIndexPath(logRoot)).mtimeMs }
  } catch { /* best-effort */ }

  return { issues: fresh.issues.length, scanned, skipped }
}
