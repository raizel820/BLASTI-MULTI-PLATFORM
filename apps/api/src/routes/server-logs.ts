import { Hono } from 'hono'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { requireRole, authErrorResponse } from '../lib/auth'
import { STORAGE_ROOT } from '../lib/storage'
import { queryErrors, analysisSummary, type ErrorRecord } from '../lib/logs-analyzer'

/**
 * VPS SERVER-LOGS backend (0.6.59) — mounted at /api/logs/server.
 * ─────────────────────────────────────────────────────────────────────────────
 * The Logs Manager gained a dedicated "Server logs" section (user request):
 * the VPS journal (systemd units) + the deploy-log files on disk are now
 * browsable, downloadable in EVERY format the server can produce, and
 * CORRELATED with the app-side error index so a server event and the client
 * bugs around it are analyzed together.
 *
 *   GET  /sources                 — units + log files (availability, size, mtime)
 *   GET  /view                    — structured tail of one source (filters)
 *   GET  /download                — raw download in ALL available forms
 *                                    (journalctl output formats + gzip +
 *                                    JSON array post-processing; files: txt/gz)
 *   GET  /analysis                — server error groups for a time window,
 *                                    each correlated with the app-side bugs
 *                                    (logs-analyzer fingerprints) by keyword
 *                                    overlap + time-window proximity
 *
 * Security: SUPER_ADMIN only · argv arrays (no shell interpolation) ·
 * byte/line caps + timeouts on every external read · path traversal refused
 * for file sources (STORAGE_ROOT/logs + the repo's own logs dir ONLY).
 */

const execFileAsync = promisify(execFile)

const app = new Hono()

// ─── Sources registry ────────────────────────────────────────────────────────

/** systemd units worth watching on the Blasti VPS. */
const JOURNAL_UNITS = [
  'blasti-api',
  'blasti-web',
  'blasti-rebuild',
  'blasti-watcher',
  'blasti-watcher.timer',
  'caddy',
] as const

/** Hard ceilings — the VPS is a 2-core box; never stream a whole journal. */
const MAX_TAIL_LINES = 1000
const MAX_TAIL_BYTES = 2 * 1024 * 1024 // 2 MB per view response
const MAX_DOWNLOAD_LINES = 50_000
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 // 64 MB cap per download
const EXEC_TIMEOUT_MS = 30_000
const MAX_BUFFER = 128 * 1024 * 1024 // journalctl stdout ceiling (matches byte cap)

interface LogSource {
  kind: 'journal' | 'file'
  /** journal: unit name · file: "vpslogs" | the file name (safe slug). */
  id: string
  label: string
  available: boolean
  sizeBytes: number | null
  modifiedAt: string | null
}

function deployLogsDir(): string {
  return path.join(STORAGE_ROOT, 'logs')
}

/** The repo's own logs directory (dev.log / deploy artifacts during dev). */
function repoLogsDir(): string {
  return process.env.BLASTI_LOG_DIR || path.join(process.cwd(), 'logs')
}

async function journalAvailable(): Promise<boolean> {
  try {
    await execFileAsync('journalctl', ['--version'], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Unit-existence probe — MUST stay fast: the Logs Manager calls /sources on
 * every open and the apiClient times requests out at 10 s. systemctl gets a
 * 3 s budget; the journalctl fallback (its own 3 s) covers units systemctl
 * cannot resolve. Results are cached for 60 s per process — unit availability
 * effectively never changes while the API runs.
 */
const UNIT_PROBE_TIMEOUT_MS = 3_000
const UNIT_CACHE_TTL_MS = 60_000
const unitCache = new Map<string, { available: boolean; at: number }>()

async function unitExists(unit: string): Promise<boolean> {
  const hit = unitCache.get(unit)
  if (hit && Date.now() - hit.at < UNIT_CACHE_TTL_MS) return hit.available
  let available = false
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['list-unit-files', '--no-legend', '--no-pager', `${unit}.service`, `${unit}.timer`, unit],
      { timeout: UNIT_PROBE_TIMEOUT_MS },
    )
    available = stdout.trim().length > 0
  } catch {
    // systemctl missing or unit unknown — journalctl is the fallback probe.
    try {
      await execFileAsync('journalctl', ['--unit', unit, '--no-pager', '-n', '1'], { timeout: UNIT_PROBE_TIMEOUT_MS })
      available = true
    } catch {
      available = false
    }
  }
  unitCache.set(unit, { available, at: Date.now() })
  return available
}

async function listLogFiles(): Promise<Array<{ id: string; label: string; dir: string; sizeBytes: number; modifiedAt: string }>> {
  const out: Array<{ id: string; label: string; dir: string; sizeBytes: number; modifiedAt: string }> = []
  const dirs: Array<[string, string]> = [
    [deployLogsDir(), 'vps'],
    [repoLogsDir(), 'app'],
  ]
  for (const [dir, prefix] of dirs) {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!/\.(log|txt|ndjson|json)$/i.test(e.name)) continue
      try {
        const st = fs.statSync(path.join(dir, e.name))
        if (st.size > 512 * 1024 * 1024) continue // absurd file — skip
        out.push({
          id: `${prefix}:${e.name}`,
          label: e.name,
          dir,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
        })
      } catch { /* raced delete */ }
    }
  }
  return out
}

/** GET /sources — what can be read on THIS machine right now. */
app.get('/sources', async (c) => {
  try {
    await requireRole(c, 'SUPER_ADMIN')
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }

  const hasJournal = await journalAvailable()
  const units: LogSource[] = []
  if (hasJournal) {
    // PARALLEL probes — sequential ×6 could blow the client's 10 s budget on
    // a sluggish systemd; Promise.all caps the whole list at one probe time.
    const probed = await Promise.all(
      JOURNAL_UNITS.map(async (unit) => ({
        kind: 'journal' as const,
        id: unit,
        label: unit,
        available: await unitExists(unit),
        // Journal sizes are unbounded (rotated by journald) — surfaced as
        // null; the /view endpoint caps lines per request instead.
        sizeBytes: null,
        modifiedAt: null,
      })),
    )
    units.push(...probed)
  }

  const files = (await listLogFiles()).map<LogSource>((f) => ({
    kind: 'file',
    id: f.id,
    label: f.label,
    available: true,
    sizeBytes: f.sizeBytes,
    modifiedAt: f.modifiedAt,
  }))

  return c.json({
    success: true,
    journalAvailable: hasJournal,
    units,
    files,
    generatedAt: new Date().toISOString(),
  })
})

// ─── Source resolution + readers ─────────────────────────────────────────────

/** "journal:<unit>" | "<unit>" | "vps:<name>" | "app:<name>" → a safe reader target. */
function resolveSource(raw: string): { kind: 'journal'; unit: string } | { kind: 'file'; full: string; name: string } | null {
  const spec = String(raw || '')
  // Bare unit id (the /sources payload uses `unit` as the id) — accepted as a
  // journal source so UI call sites never need to remember the prefix.
  if ((JOURNAL_UNITS as readonly string[]).includes(spec)) {
    return { kind: 'journal', unit: spec }
  }
  if (spec.startsWith('journal:')) {
    const unit = spec.slice('journal:'.length).replace(/[^A-Za-z0-9._@-]/g, '')
    if (!unit || !(JOURNAL_UNITS as readonly string[]).includes(unit)) return null
    return { kind: 'journal', unit }
  }
  const sep = spec.indexOf(':')
  if (sep <= 0) return null
  const prefix = spec.slice(0, sep)
  const name = spec.slice(sep + 1)
  // Strict name shape — refuses traversal outright ("../", slashes, dotfiles).
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) || name.includes('..')) return null
  const dir = prefix === 'vps' ? deployLogsDir() : prefix === 'app' ? repoLogsDir() : null
  if (!dir) return null
  const full = path.resolve(dir, name)
  if (!full.startsWith(path.resolve(dir) + path.sep)) return null
  try {
    if (!fs.statSync(full).isFile()) return null
  } catch {
    return null
  }
  return { kind: 'file', full, name }
}

function levelFromPriority(prio: number | null): 'debug' | 'info' | 'warn' | 'error' {
  if (prio == null) return 'info'
  if (prio <= 3) return 'error' // emerg/alert/crit/err
  if (prio === 4) return 'warn' // warning
  if (prio <= 6) return 'info'
  return 'debug'
}

function isoFromJournalTs(micros: string | undefined): string {
  const n = Number(micros)
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString()
  return new Date(Math.floor(n / 1000)).toISOString()
}

interface ServerLogEntry {
  ts: string
  source: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
}

async function readJournal(
  unit: string,
  opts: { lines: number; priority: number | null; since: string | null },
): Promise<ServerLogEntry[]> {
  const args = ['--unit', unit, '--no-pager', '--quiet', '--output=json', '-n', String(Math.min(opts.lines, MAX_TAIL_LINES))]
  if (opts.priority != null) args.push('--priority', String(opts.priority))
  if (opts.since) args.push('--since', opts.since)
  let stdout = ''
  try {
    const res = await execFileAsync('journalctl', args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER })
    stdout = res.stdout
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string }
    // journalctl exits 1 when the unit has no entries yet — that is fine.
    if (e.stdout && typeof e.stdout === 'string') stdout = e.stdout
    else if (e.code !== 1) throw err
  }
  const entries: ServerLogEntry[] = []
  for (const line of stdout.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const j = JSON.parse(s) as Record<string, unknown>
      const msg = Array.isArray(j.MESSAGE) ? (j.MESSAGE as string[]).join('') : String(j.MESSAGE ?? '')
      entries.push({
        ts: isoFromJournalTs(j.__REALTIME_TIMESTAMP as string | undefined),
        source: String(j._SYSTEMD_UNIT ?? j.SYSLOG_IDENTIFIER ?? unit),
        level: levelFromPriority(j.PRIORITY != null ? Number(j.PRIORITY) : null),
        message: msg.slice(0, 4_000),
      })
    } catch { /* malformed line — skip */ }
  }
  return entries
}

async function readFileTail(
  full: string,
  name: string,
  opts: { lines: number },
): Promise<ServerLogEntry[]> {
  const want = Math.min(opts.lines, MAX_TAIL_LINES)
  let data = ''
  try {
    const st = fs.statSync(full)
    const readBytes = Math.min(st.size, MAX_TAIL_BYTES)
    const fd = fs.openSync(full, 'r')
    try {
      const buf = Buffer.alloc(readBytes)
      fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes))
      data = buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    throw new Error(`log file unreadable: ${(err as Error).message}`)
  }
  const lines = data.split('\n').filter((l) => l.trim().length > 0)
  return lines.slice(-want).map<ServerLogEntry>((line) => {
    // Try to lift an ISO timestamp prefix into the structured ts (deploy logs
    // write "2026-01-15 10:22:33 …" / ISO-ish first tokens).
    const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(line)
    const ts = m ? new Date(m[1].replace(' ', 'T')).toISOString() : new Date().toISOString()
    const lower = line.toLowerCase()
    const level: ServerLogEntry['level'] =
      /\b(error|failed|failure|fatal|crit|✖|⨯|exception|denied)\b/.test(lower) || /⨯/.test(line)
        ? 'error'
        : /\b(warn|warning|deprecated|retry|skipping)\b/.test(lower)
          ? 'warn'
          : /\b(debug|trace)\b/.test(lower)
            ? 'debug'
            : 'info'
    return { ts, source: name, level, message: line.slice(0, 4_000) }
  })
}

/** GET /view?source=…&lines=…&priority=…&since=…&level=…&q=… */
app.get('/view', async (c) => {
  try {
    await requireRole(c, 'SUPER_ADMIN')
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const src = resolveSource(c.req.query('source') || '')
  if (!src) return c.json({ success: false, error: 'Unknown or unsafe log source' }, 400)
  const lines = Math.min(Math.max(parseInt(c.req.query('lines') || '200', 10) || 200, 1), MAX_TAIL_LINES)
  const priorityRaw = c.req.query('priority')
  const priority = priorityRaw != null && priorityRaw !== '' && Number.isFinite(Number(priorityRaw)) ? Number(priorityRaw) : null
  const since = c.req.query('since') || null
  const q = (c.req.query('q') || '').toLowerCase().slice(0, 200)
  const levelFilter = c.req.query('level') || ''

  try {
    let entries =
      src.kind === 'journal'
        ? await readJournal(src.unit, { lines, priority, since })
        : await readFileTail(src.full, src.name, { lines })
    if (levelFilter) entries = entries.filter((e) => e.level === levelFilter)
    if (q) entries = entries.filter((e) => e.message.toLowerCase().includes(q))
    return c.json({ success: true, source: c.req.query('source'), count: entries.length, entries })
  } catch (err) {
    return c.json({ success: false, error: String((err as Error).message || err).slice(0, 200) }, 500)
  }
})

// ─── Downloads — EVERY form the server can produce ───────────────────────────

interface DownloadFormat {
  id: string
  /** journalctl --output value; null for post-processed or file formats. */
  journalOutput: string | null
  ext: string
  mime: string
  gzip?: boolean
  /** post-process: NDJSON journal lines → a proper pretty-printed JSON array */
  jsonArray?: boolean
  /** file-source formats */
  raw?: boolean
}

const JOURNAL_FORMATS: DownloadFormat[] = [
  { id: 'txt', journalOutput: 'short', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'short-full', journalOutput: 'short-full', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'short-iso', journalOutput: 'short-iso', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'short-iso-precise', journalOutput: 'short-iso-precise', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'short-precise', journalOutput: 'short-precise', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'short-monotonic', journalOutput: 'short-monotonic', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'short-unix', journalOutput: 'short-unix', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'verbose', journalOutput: 'verbose', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'export', journalOutput: 'export', ext: 'journal-export', mime: 'application/octet-stream' },
  { id: 'cat', journalOutput: 'cat', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'ndjson', journalOutput: 'json', ext: 'ndjson', mime: 'application/x-ndjson; charset=utf-8' },
  { id: 'json-pretty', journalOutput: 'json-pretty', ext: 'log', mime: 'text/plain; charset=utf-8' },
  { id: 'json-array', journalOutput: 'json', ext: 'json', mime: 'application/json; charset=utf-8', jsonArray: true },
  // gzip companions of the two most-used forms
  { id: 'txt.gz', journalOutput: 'short', ext: 'log.gz', mime: 'application/gzip', gzip: true },
  { id: 'ndjson.gz', journalOutput: 'json', ext: 'ndjson.gz', mime: 'application/gzip', gzip: true },
  { id: 'export.gz', journalOutput: 'export', ext: 'journal-export.gz', mime: 'application/gzip', gzip: true },
]

const FILE_FORMATS: DownloadFormat[] = [
  { id: 'txt', journalOutput: null, ext: 'log', mime: 'text/plain; charset=utf-8', raw: true },
  { id: 'ndjson', journalOutput: null, ext: 'ndjson', mime: 'application/x-ndjson; charset=utf-8', raw: true },
  { id: 'json-array', journalOutput: null, ext: 'json', mime: 'application/json; charset=utf-8', raw: true, jsonArray: true },
  { id: 'txt.gz', journalOutput: null, ext: 'log.gz', mime: 'application/gzip', gzip: true, raw: true },
]

/** GET /download?source=…&format=…[&lines=…][&since=…] */
app.get('/download', async (c) => {
  try {
    await requireRole(c, 'SUPER_ADMIN')
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const src = resolveSource(c.req.query('source') || '')
  if (!src) return c.json({ success: false, error: 'Unknown or unsafe log source' }, 400)
  const formatId = c.req.query('format') || 'txt'
  const formats = src.kind === 'journal' ? JOURNAL_FORMATS : FILE_FORMATS
  const fmt = formats.find((f) => f.id === formatId)
  if (!fmt) return c.json({ success: false, error: `Unsupported format "${formatId.slice(0, 40)}" — use /formats` }, 400)

  try {
    let body: Buffer
    if (src.kind === 'journal') {
      const args = [
        '--unit', src.unit,
        '--no-pager', '--quiet',
        '--output', String(fmt.journalOutput),
        '-n', String(MAX_DOWNLOAD_LINES),
      ]
      const since = c.req.query('since')
      if (since) args.push('--since', since)
      const res = await execFileAsync('journalctl', args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER })
      let out: Buffer = Buffer.from(res.stdout, 'utf8')
      if (out.length > MAX_DOWNLOAD_BYTES) out = out.subarray(0, MAX_DOWNLOAD_BYTES)
      if (fmt.jsonArray) {
        const rows: unknown[] = []
        for (const line of out.toString('utf8').split('\n')) {
          const s = line.trim()
          if (!s) continue
          try { rows.push(JSON.parse(s)) } catch { /* skip malformed */ }
        }
        out = Buffer.from(JSON.stringify(rows, null, 2), 'utf8')
      }
      body = fmt.gzip ? zlib.gzipSync(out, { level: 6 }) : out
    } else {
      const st = fs.statSync(src.full)
      const readBytes = Math.min(st.size, MAX_DOWNLOAD_BYTES)
      const fd = fs.openSync(src.full, 'r')
      let out: Buffer
      try {
        const buf = Buffer.alloc(readBytes)
        fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes))
        out = buf
      } finally {
        fs.closeSync(fd)
      }
      if (fmt.jsonArray) {
        // NDJSON-ish text → structured array document (one object per line).
        const rows: unknown[] = []
        for (const line of out.toString('utf8').split('\n')) {
          const s = line.trim()
          if (!s) continue
          try { rows.push(JSON.parse(s)) } catch { rows.push({ line: s }) }
        }
        out = Buffer.from(JSON.stringify(rows, null, 2), 'utf8')
      }
      body = fmt.gzip ? zlib.gzipSync(out, { level: 6 }) : out
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = src.kind === 'journal' ? `blasti-${src.unit}` : src.name.replace(/\.[^.]+$/, '')
    const fileName = `${base}-${stamp}.${fmt.ext}`
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'Content-Type': fmt.mime,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return c.json({ success: false, error: String((err as Error).message || err).slice(0, 200) }, 500)
  }
})

/** GET /formats — the downloadable forms for a source (drives the UI menu). */
app.get('/formats', async (c) => {
  try {
    await requireRole(c, 'SUPER_ADMIN')
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const src = resolveSource(c.req.query('source') || '')
  if (!src) return c.json({ success: false, error: 'Unknown or unsafe log source' }, 400)
  const formats = (src.kind === 'journal' ? JOURNAL_FORMATS : FILE_FORMATS).map((f) => ({
    id: f.id,
    ext: f.ext,
    mime: f.mime,
    gzip: !!f.gzip,
    jsonArray: !!f.jsonArray,
  }))
  return c.json({ success: true, source: c.req.query('source'), formats })
})

// ─── Cross-analysis — server events × app-side bug index ─────────────────────

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'has', 'had', 'not', 'but', 'all', 'can', 'will',
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'into', 'your', 'out', 'new', 'one',
  'error', 'warning', 'failed', 'undefined', 'null', 'true', 'false', 'http', 'https',
  'com', 'org', 'www', 'node', 'bash', 'sh', 'bin', 'usr', 'var', 'opt', 'etc', 'tmp',
])

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9_.]+/)) {
    if (raw.length < 4 || raw.length > 40) continue
    if (/^\d+$/.test(raw)) continue
    if (STOPWORDS.has(raw)) continue
    tokens.add(raw)
  }
  return tokens
}

function normalizeServerMessage(msg: string): string {
  return String(msg || '')
    .slice(0, 400)
    .replace(/\d+/g, '#') // ids/ports/bytes → template
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

interface ServerErrorGroup {
  id: string
  source: string
  level: 'warn' | 'error'
  template: string
  sample: string
  count: number
  firstTs: string
  lastTs: string
  keywords: string[]
}

async function collectServerGroups(hours: number): Promise<ServerErrorGroup[]> {
  const sinceIso = new Date(Date.now() - hours * 60 * 60_000).toISOString()
  const sinceArg = `-${Math.round(hours * 60)}min`
  const groups = new Map<string, ServerErrorGroup>()

  const push = (source: string, level: 'warn' | 'error', message: string, ts: string) => {
    const template = normalizeServerMessage(message)
    if (!template) return
    const id = `${source}::${template}`
    const g = groups.get(id)
    if (g) {
      g.count += 1
      if (ts < g.firstTs) g.firstTs = ts
      if (ts > g.lastTs) g.lastTs = ts
      return
    }
    groups.set(id, {
      id,
      source,
      level,
      template,
      sample: message.slice(0, 600),
      count: 1,
      firstTs: ts,
      lastTs: ts,
      keywords: [...tokenize(template)].slice(0, 14),
    })
  }

  // 1) systemd journal — warnings + errors only, inside the window.
  //    Units are read in PARALLEL: six sequential journalctl calls on a
  //    2-core VPS could exceed the client's request budget.
  if (await journalAvailable()) {
    const perUnit = await Promise.all(
      JOURNAL_UNITS.map(async (unit) => {
        try {
          const entries = await readJournal(unit, { lines: 2000, priority: 4, since: sinceArg })
          return entries.filter((e) => {
            if (new Date(e.ts).getTime() < Date.now() - hours * 60 * 60_000) return false
            return e.level === 'warn' || e.level === 'error'
          })
        } catch {
          return [] as ServerLogEntry[] // unit may not exist — fine
        }
      }),
    )
    for (const entries of perUnit) {
      for (const e of entries) push(e.source, e.level === 'warn' ? 'warn' : 'error', e.message, e.ts)
    }
  }

  // 2) deploy/file logs — grep error/warn lines, respect the window by mtime.
  const cutoff = Date.now() - hours * 60 * 60_000
  try {
    for (const f of await listLogFiles()) {
      try {
        if (new Date(f.modifiedAt).getTime() < cutoff) continue
        const entries = await readFileTail(path.join(f.dir, f.label), f.id, { lines: 1500 })
        for (const e of entries) {
          if (e.level !== 'warn' && e.level !== 'error') continue
          if (new Date(e.ts).getTime() < cutoff) continue
          push(f.id, e.level, e.message, e.ts)
        }
      } catch { /* unreadable file — skip */ }
    }
  } catch { /* listing failed — journal groups alone are still returned */ }

  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 60)
}

/** GET /analysis?hours=24 — server error groups correlated with app bugs. */
app.get('/analysis', async (c) => {
  try {
    await requireRole(c, 'SUPER_ADMIN')
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const hoursRaw = Number(c.req.query('hours') || '24')
  const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(Math.round(hoursRaw), 1), 168) : 24

  const serverGroups = await collectServerGroups(hours)
  // App-side index: the SAME fingerprints the Logs Manager "Errors" tab shows.
  const appIndex = queryErrors({ limit: 500 })

  const PROXIMITY_MS = 10 * 60_000
  const correlations = serverGroups.map((g) => {
    const gStart = new Date(g.firstTs).getTime() - PROXIMITY_MS
    const gEnd = new Date(g.lastTs).getTime() + PROXIMITY_MS
    const scored = appIndex.errors
      .map((bug: ErrorRecord) => {
        const bugTokens = tokenize(`${bug.tag} ${bug.message}`)
        const overlap = g.keywords.filter((k) => bugTokens.has(k))
        const timeOverlap =
          new Date(bug.lastSeen).getTime() >= gStart && new Date(bug.firstSeen).getTime() <= gEnd
        const score = overlap.length * 2 + (timeOverlap ? 2 : 0)
        return {
          fp: bug.fp,
          tag: bug.tag,
          message: bug.message,
          count: bug.count,
          severity: bug.severity,
          triggers: bug.affected.triggers ?? [],
          platforms: bug.affected.platforms,
          lastSeen: bug.lastSeen,
          match: { keywords: overlap, timeOverlap },
          score,
        }
      })
      .filter((m) => m.score >= 2)
      .sort((a, b) => b.score - a.score || b.count - a.count)
      .slice(0, 3)
    return { server: g, correlatedBugs: scored }
  })

  // Topic flags — the questions this panel exists to answer.
  const deltaTopicHits = correlations.filter((c) =>
    /delta|asar|outref|release-?ref|differential|hop/i.test(c.server.template) ||
    c.correlatedBugs.some((b) => (b.triggers ?? []).includes('update')),
  ).length

  return c.json({
    success: true,
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    summary: {
      serverGroups: serverGroups.length,
      serverHits: serverGroups.reduce((n, g) => n + g.count, 0),
      appBugs: appIndex.total,
      appSummary: analysisSummary(),
      deltaTopicHits,
      correlated: correlations.filter((c) => c.correlatedBugs.length > 0).length,
    },
    correlations,
  })
})

export const serverLogRoutes = app
