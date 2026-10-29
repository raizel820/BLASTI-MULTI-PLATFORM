import { Hono } from 'hono'
import { requireRole, authErrorResponse } from '../lib/auth'

/**
 * BLASTI Logs Manager API (logs-0.6.18) — SUPER_ADMIN console behind the new
 * "Logs Manager" admin page (Database & Storage group). READ-HEAVY analytics
 * over the per-UID / per-platform log vault:
 *
 *   GET  /api/admin/logs-manager/overview          → stats cards + platform totals
 *   GET  /api/admin/logs-manager/entries           → filtered/paginated entry browser
 *   GET  /api/admin/logs-manager/facets            → distinct filter values
 *   GET  /api/admin/logs-manager/issues            → auto-extracted issue groups
 *   GET  /api/admin/logs-manager/issues/report     → per-issue / all-issues report (json|md)
 *   GET  /api/admin/logs-manager/daily             → daily per-platform aggregates
 *   POST /api/admin/logs-manager/reanalyze         → rebuild the issues index from disk
 *   DELETE /api/admin/logs-manager/files           → manage/delete stored files
 *
 * The analyzer itself (fingerprinting, severity, index maintenance) lives in
 * lib/log-analyzer.ts and runs REALTIME on every ingestion batch — these
 * routes only read/serve/manage its artifacts.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  logRootOf,
  readIssuesIndex,
  filterIssues,
  buildIssueReportMd,
  rebuildIssuesIndex,
  fingerprint,
  normalizeMessage,
  severityFor,
  type IssueRecord,
} from '../lib/log-analyzer'

const app = new Hono()

const PLATFORMS = ['web', 'mobile', 'desktop'] as const
const LEVELS = ['debug', 'info', 'warn', 'error', 'meta'] as const
const ROLES = ['SUPER_ADMIN', 'AGENCY_OWNER', 'AGENCY_STAFF', 'CUSTOMER'] as const

// Scan guards — the browser must stay responsive even with heavy vaults.
const MAX_FILE_BYTES_SCAN = 8 * 1024 * 1024
const MAX_LINES_SCAN = 60_000
const MAX_ENTRIES_RETURN = 300

function logRoot(): string {
  return logRootOf()
}

// ─── Vault walking helpers ───────────────────────────────────────────────────

interface AccountFolder {
  uid: string
  dir: string
}

function listAccounts(root: string): AccountFolder[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => ({ uid: d.name, dir: path.join(root, d.name) }))
  } catch {
    return []
  }
}

interface PlatformFile {
  uid: string
  platform: string
  file: string
  path: string
  bytes: number
}

/** All ndjson files matching the uid/platform/date filters (newest name first). */
function selectFiles(opts: { uid?: string | null; platform?: string | null; date?: string | null }): PlatformFile[] {
  const root = logRoot()
  const out: PlatformFile[] = []
  const accounts = opts.uid && opts.uid !== 'all'
    ? listAccounts(root).filter((a) => a.uid === opts.uid)
    : listAccounts(root)
  for (const acc of accounts) {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(acc.dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const isPlatformDir = entry.isDirectory() && [...PLATFORMS, 'unknown'].includes(entry.name as any)
      const isLegacy = entry.isFile() && entry.name.endsWith('.ndjson')
      if (opts.platform && opts.platform !== 'all') {
        // Legacy files only match the synthetic "legacy" platform selector.
        if (opts.platform === 'legacy' ? !isLegacy : !(isPlatformDir && entry.name === opts.platform)) continue
      }
      if (isPlatformDir) {
        let files: string[] = []
        try { files = fs.readdirSync(path.join(acc.dir, entry.name)) } catch { continue }
        for (const f of files) {
          if (!f.endsWith('.ndjson')) continue
          if (opts.date && !f.startsWith(opts.date)) continue
          const full = path.join(acc.dir, entry.name, f)
          try { out.push({ uid: acc.uid, platform: entry.name, file: f, path: full, bytes: fs.statSync(full).size }) } catch { /* raced */ }
        }
      } else if (isLegacy) {
        if (opts.date && !entry.name.startsWith(opts.date)) continue
        const full = path.join(acc.dir, entry.name)
        try { out.push({ uid: acc.uid, platform: 'legacy', file: entry.name, path: full, bytes: fs.statSync(full).size }) } catch { /* raced */ }
      }
    }
  }
  return out.sort((a, b) => b.file.localeCompare(a.file) || a.uid.localeCompare(b.uid))
}

// ─── Overview ────────────────────────────────────────────────────────────────

app.get('/overview', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const root = logRoot()
  const today = new Date().toISOString().slice(0, 10)

  const accounts = listAccounts(root)
  const perPlatform: Record<string, { files: number; bytes: number; accounts: number }> = {}
  for (const p of [...PLATFORMS, 'legacy', 'unknown']) perPlatform[p] = { files: 0, bytes: 0, accounts: 0 }
  let totalBytes = 0
  let totalFiles = 0
  const accountRows: Array<{ uid: string; bytes: number; files: number; platforms: Record<string, number>; lastAt: string | null }> = []

  for (const acc of accounts) {
    const platformsCount: Record<string, number> = {}
    let accBytes = 0
    let accFiles = 0
    let lastAt: string | null = null
    try {
      for (const entry of fs.readdirSync(acc.dir, { withFileTypes: true })) {
        const label = entry.isDirectory() ? entry.name : 'legacy'
        const dir = entry.isDirectory() ? path.join(acc.dir, entry.name) : acc.dir
        const names = entry.isDirectory()
          ? fs.readdirSync(dir)
          : [entry.name].filter((n) => n.endsWith('.ndjson') || n.endsWith('.json'))
        for (const f of names) {
          if (!f.endsWith('.ndjson') && !f.endsWith('.json')) continue
          try {
            const st = fs.statSync(path.join(dir, f))
            accBytes += st.size
            if (f.endsWith('.ndjson')) {
              accFiles++
              perPlatform[label] = perPlatform[label] ?? { files: 0, bytes: 0, accounts: 0 }
              perPlatform[label].files++
              perPlatform[label].bytes += st.size
              platformsCount[label] = (platformsCount[label] ?? 0) + 1
            }
          } catch { /* raced */ }
        }
        // Meta sidecars carry the freshest "last seen" per platform.
        for (const f of names) {
          if (f.startsWith('meta-')) {
            try {
              const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
              if (!lastAt || (meta.at ?? '') > lastAt) lastAt = meta.at ?? lastAt
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* missing dir */ }
    totalBytes += accBytes
    totalFiles += accFiles
    for (const label of Object.keys(platformsCount)) {
      if ((perPlatform[label]?.files ?? 0) > 0 && platformsCount[label] > 0) perPlatform[label].accounts++
    }
    accountRows.push({ uid: acc.uid, bytes: accBytes, files: accFiles, platforms: platformsCount, lastAt })
  }

  const index = readIssuesIndex(root)
  const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const i of index.issues) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1

  // Daily aggregate availability (per platform, per date).
  const daily: Array<{ date: string; platforms: string[] }> = []
  try {
    const dates = fs.readdirSync(path.join(root, '_daily')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 14)
    for (const date of dates) {
      const plats = fs.readdirSync(path.join(root, '_daily', date))
        .filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
      daily.push({ date, platforms: plats })
    }
  } catch { /* no aggregates yet */ }

  return c.json({
    success: true,
    root,
    today,
    totals: { accounts: accounts.length, files: totalFiles, bytes: totalBytes },
    perPlatform,
    issues: { total: index.totalIssues, bySeverity, updatedAt: index.updatedAt },
    daily,
    accounts: accountRows.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '')),
  })
})

// ─── Facets (distinct filter values) ─────────────────────────────────────────

app.get('/facets', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const root = logRoot()
  const index = readIssuesIndex(root)
  const uids = new Set<string>()
  const appVersions = new Set<string>()
  const devices = new Set<string>()
  const tags = new Set<string>()
  for (const issue of index.issues) {
    for (const k of Object.keys(issue.affected.uids)) uids.add(k)
    for (const k of Object.keys(issue.affected.appVersions)) appVersions.add(k)
    for (const k of Object.keys(issue.affected.devices)) devices.add(k)
    tags.add(issue.tag)
  }
  // Account folders fill the UID list even before issues exist.
  for (const acc of listAccounts(root)) uids.add(acc.uid)
  const dates = new Set<string>()
  try {
    for (const d of fs.readdirSync(path.join(root, '_daily'))) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d)
  } catch { /* none yet */ }
  return c.json({
    success: true,
    uids: [...uids].sort(),
    platforms: [...PLATFORMS, 'legacy', 'unknown'],
    levels: [...LEVELS],
    roles: [...ROLES],
    appVersions: [...appVersions].sort(),
    devices: [...devices].sort(),
    tags: [...tags].sort(),
    dates: [...dates].sort().reverse(),
  })
})

// ─── Entry browser ───────────────────────────────────────────────────────────

interface EnrichedEntry {
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
  deviceSpecs?: unknown
  file: string
}

app.get('/entries', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const q = (key: string) => {
    const v = c.req.query(key)
    return v && v !== 'all' && v !== '' ? v : null
  }
  const uid = q('uid')
  const platform = q('platform')
  const date = q('date')
  const level = q('level')
  const tag = q('tag')
  const role = q('role')
  const appVersion = q('appVersion')
  const device = q('device')
  const search = (c.req.query('q') ?? '').toLowerCase()
  const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, MAX_ENTRIES_RETURN)
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0)

  const files = selectFiles({ uid, platform, date })
  const collected: EnrichedEntry[] = []
  let scanned = 0
  let truncatedScan = false

  outer:
  for (const pf of files) {
    if (collected.length >= offset + limit) break
    if (pf.bytes > MAX_FILE_BYTES_SCAN) { truncatedScan = true; continue }
    let content: string
    try { content = fs.readFileSync(pf.path, 'utf8') } catch { continue }
    // Newest first within a file: files are appended chronologically.
    const lines = content.split('\n').filter((l) => l.trim()).reverse()
    // Session ctx — enriched as we walk backwards; session envelope lines
    // appear BEFORE their batch, so keep the last seen ctx across lines.
    let ctx: { uid: string | null; username: string | null; role: string | null; appVersion: string | null; device: string | null; deviceSpecs?: unknown } = { uid: null, username: null, role: null, appVersion: null, device: null }
    for (const line of lines) {
      scanned++
      if (scanned > MAX_LINES_SCAN) { truncatedScan = true; break outer }
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) } catch { continue }
      if (obj.tag === 'session' && obj.data && typeof obj.data === 'object') {
        const d = obj.data as Record<string, unknown>
        ctx = {
          uid: typeof d.uid === 'string' ? d.uid : null,
          username: typeof d.username === 'string' ? d.username : null,
          role: typeof d.role === 'string' ? d.role : null,
          appVersion: typeof d.appVersion === 'string' ? d.appVersion : null,
          device: typeof d.device === 'string' ? d.device : null,
          deviceSpecs: d.deviceSpecs,
        }
        continue
      }
      if (level && String(obj.level ?? '') !== level) continue
      if (tag && String(obj.tag ?? '') !== tag) continue
      if (role && ctx.role !== role) continue
      if (appVersion && ctx.appVersion !== appVersion) continue
      if (device && !(ctx.device ?? '').toLowerCase().includes(device.toLowerCase())) continue
      const message = String(obj.message ?? '')
      if (search && !`${obj.tag ?? ''} ${message}`.toLowerCase().includes(search)) continue
      collected.push({
        ts: String(obj.ts ?? ''),
        level: String(obj.level ?? ''),
        tag: String(obj.tag ?? ''),
        message,
        data: obj.data,
        uid: ctx.uid,
        username: ctx.username,
        role: ctx.role,
        platform: pf.platform,
        appVersion: ctx.appVersion,
        device: ctx.device,
        deviceSpecs: ctx.deviceSpecs,
        file: `${pf.uid}/${pf.platform}/${pf.file}`,
      })
    }
  }

  return c.json({
    success: true,
    entries: collected.slice(offset, offset + limit),
    total: collected.length,
    scanned,
    truncatedScan,
    hasMore: collected.length > offset + limit,
  })
})

// ─── Issues ──────────────────────────────────────────────────────────────────

app.get('/issues', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const root = logRoot()
  const index = readIssuesIndex(root)
  const minCount = Number(c.req.query('minCount') ?? 0) || 0
  const issues = filterIssues(index, {
    severity: c.req.query('severity'),
    platform: c.req.query('platform'),
    role: c.req.query('role'),
    appVersion: c.req.query('appVersion'),
    uid: c.req.query('uid'),
    minCount,
    q: c.req.query('q'),
    date: c.req.query('date'),
  })
  return c.json({ success: true, total: issues.length, updatedAt: index.updatedAt, issues })
})

app.get('/issues/report', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const root = logRoot()
  const index = readIssuesIndex(root)
  const id = c.req.query('id')
  const format = c.req.query('format') === 'md' ? 'md' : 'json'
  const filters = {
    severity: c.req.query('severity') ?? null,
    platform: c.req.query('platform') ?? null,
    role: c.req.query('role') ?? null,
    appVersion: c.req.query('appVersion') ?? null,
    uid: c.req.query('uid') ?? null,
    minCount: Number(c.req.query('minCount') ?? 0) || 0,
    q: c.req.query('q') ?? null,
    date: c.req.query('date') ?? null,
  }
  let issues: IssueRecord[]
  if (id) {
    issues = index.issues.filter((i) => i.id === id)
  } else {
    issues = filterIssues(index, filters)
  }
  if (format === 'md') {
    return c.body(buildIssueReportMd(issues, filters), 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  }
  return c.json({ success: true, generatedAt: new Date().toISOString(), filters, count: issues.length, issues })
})

// ─── Daily aggregates ────────────────────────────────────────────────────────

app.get('/daily', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const root = logRoot()
  const date = c.req.query('date') ?? new Date().toISOString().slice(0, 10)
  const dir = path.join(root, '_daily', date)
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    const platforms: Record<string, unknown> = {}
    for (const f of files) {
      try { platforms[f.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { /* skip */ }
    }
    return c.json({ success: true, date, platforms })
  } catch {
    return c.json({ success: true, date, platforms: {}, note: 'No aggregate for this date yet' })
  }
})

// ─── Reanalyze + manage ──────────────────────────────────────────────────────

app.post('/reanalyze', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const result = rebuildIssuesIndex(logRoot())
  return c.json({ success: true, ...result, rebuiltAt: new Date().toISOString() })
})

app.delete('/files', async (c) => {
  try { await requireRole(c, 'SUPER_ADMIN') } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as any)
  }
  const uid = c.req.query('uid')
  const platform = c.req.query('platform')
  const date = c.req.query('date')
  if (!uid) return c.json({ success: false, error: 'uid is required (safety — no wildcard account deletion)' }, 400)
  const files = selectFiles({ uid, platform: platform ?? null, date: date ?? null })
  let deleted = 0
  for (const f of files) {
    try { fs.unlinkSync(f.path); deleted++ } catch { /* raced */ }
    // Prune now-empty platform dirs + the account dir itself.
    try {
      const dir = path.dirname(f.path)
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
      const parent = path.dirname(dir)
      if (path.dirname(parent) === logRoot() && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
    } catch { /* non-empty or raced */ }
  }
  // Deleting raw files invalidates the index counts — refresh it.
  const result = rebuildIssuesIndex(logRoot())
  return c.json({ success: true, deleted, reindex: result })
})

export const adminLogsManagerRoutes = app
