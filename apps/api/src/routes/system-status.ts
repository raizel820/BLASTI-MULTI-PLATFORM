import { Hono } from 'hono'
import { z } from 'zod'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { getConfigJSON, setConfig } from '../lib/config-manager'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { STORAGE_ROOT } from '../lib/storage'

const execFileAsync = promisify(execFile)

// ====================================================================
// System / deployment status API  (mounted at /api/system)
//
// Answers two operational questions from the admin panel:
//   1. Is the GitHub repo watcher (blasti-watcher.timer) alive?
//   2. Did the droplet pull the latest code and rebuild the API?
//
// The watcher + deploy scripts POST a heartbeat here after every check
// and every deploy (see scripts/watch-and-deploy.sh + deploy-digitalocean.sh).
// The heartbeat is authenticated with the shared DEPLOY_TOKEN from
// /etc/blasti/blasti.env (systemd exports it to both the API and the
// watcher, so no manual configuration is needed on the VPS).
// ====================================================================

const app = new Hono()

// ─── Storage keys (SystemSetting, category "deployment") ────────────────────

const KEY_WATCHER = 'deploy.watcher.lastCheck'
const KEY_LAST_DEPLOY = 'deploy.last'
const KEY_EVENTS = 'deploy.events'
const CATEGORY = 'deployment'
const MAX_EVENTS = 15

// The on-VPS systemd timer fires every 2 minutes; the long-running loop
// defaults to 300 s. If no heartbeat arrives within this window we call
// the watcher inactive.
const WATCHER_STALE_SEC = 15 * 60

// ─── Repo root resolution (VPS: API cwd = /opt/blasti/apps/api) ───────────

const DEFAULT_REPO_URL = 'https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git'

let cachedRepoRoot: string | null | undefined
function findRepoRoot(): string | null {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot
  const candidates: string[] = []
  if (process.env.BLASTI_REPO_DIR) candidates.push(process.env.BLASTI_REPO_DIR)
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const cand of candidates) {
    try {
      if (fs.existsSync(path.join(cand, '.git'))) {
        cachedRepoRoot = cand
        return cand
      }
    } catch {
      // keep walking
    }
  }
  cachedRepoRoot = null
  return null
}

async function git(args: string[], cwd: string, timeoutMs = 30000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

function parseRepoSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i)
  return m ? `${m[1]}/${m[2]}` : null
}

function githubToken(): string {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.BLASTI_GITHUB_TOKEN || ''
}

// ─── VPS resource samplers (CPU / RAM / disk) ──────────────────────────────

interface CpuSample {
  idle: number
  total: number
  at: number
}
let lastCpuSample: CpuSample | null = null
let lastCpuPct: number | null = null

function readProcStatCpu(): CpuSample | null {
  try {
    const firstLine = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0]
    if (!firstLine.startsWith('cpu ')) return null
    const cols = firstLine.trim().split(/\s+/).slice(1).map(Number)
    if (cols.length < 4) return null
    const [user, nice, sys, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = cols
    const idleAll = idle + iowait
    const total = user + nice + sys + idle + iowait + irq + softirq + steal
    return { idle: idleAll, total, at: Date.now() }
  } catch {
    return null
  }
}

async function getCpuUsagePct(): Promise<number | null> {
  // Reuse a fresh (<5 s) measured delta before sampling again.
  if (lastCpuSample && lastCpuPct !== null && Date.now() - lastCpuSample.at < 5000) {
    return lastCpuPct
  }
  const s1 = readProcStatCpu()
  if (!s1) {
    // Non-Linux fallback: load1/cores heuristic.
    const cores = os.cpus()?.length || 1
    return Math.min(100, Math.round((os.loadavg()[0] / cores) * 100))
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  const s2 = readProcStatCpu()
  if (!s2) return null
  const dTotal = s2.total - s1.total
  const dIdle = s2.idle - s1.idle
  if (dTotal <= 0) return null
  const pct = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 100)))
  lastCpuSample = s2
  lastCpuPct = pct
  return pct
}

interface MemoryInfo {
  totalMb: number
  usedMb: number
  availableMb: number
  usagePct: number
}

function getMemoryInfo(): MemoryInfo {
  // MemAvailable (includes reclaimable caches) is the honest "free" on Linux.
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8')
    const getKb = (key: string): number | null => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
      return m ? parseInt(m[1], 10) : null
    }
    const totalKb = getKb('MemTotal')
    const availKb = getKb('MemAvailable')
    if (totalKb && availKb !== null) {
      const usedKb = Math.max(0, totalKb - availKb)
      return {
        totalMb: Math.round(totalKb / 1024),
        usedMb: Math.round(usedKb / 1024),
        availableMb: Math.round(availKb / 1024),
        usagePct: totalKb > 0 ? Math.round((usedKb / totalKb) * 100) : 0,
      }
    }
  } catch {
    // fall through to os module
  }
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  return {
    totalMb: Math.round(total / 1048576),
    usedMb: Math.round(used / 1048576),
    availableMb: Math.round(free / 1048576),
    usagePct: total > 0 ? Math.round((used / total) * 100) : 0,
  }
}

interface DiskInfo {
  totalGb: number
  freeGb: number
  usedGb: number
  usagePct: number
}

function buildDiskInfo(totalBytes: number, freeBytes: number): DiskInfo {
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  const gb = (b: number) => Math.round((b / 1073741824) * 10) / 10
  return {
    totalGb: gb(totalBytes),
    freeGb: gb(freeBytes),
    usedGb: gb(usedBytes),
    usagePct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  }
}

function statfsAsync(dir: string): Promise<{ blocks: number; bsize: number; bavail: number } | null> {
  return new Promise((resolve) => {
    const anyFs = fs as unknown as {
      statfs?: (p: string, cb: (err: unknown, s: Record<string, number>) => void) => void
    }
    if (typeof anyFs.statfs !== 'function') return resolve(null)
    try {
      anyFs.statfs(dir, (err, s) => {
        if (err || !s || !s.blocks) return resolve(null)
        resolve({ blocks: s.blocks, bsize: s.bsize, bavail: s.bavail })
      })
    } catch {
      resolve(null)
    }
  })
}

async function getDiskUsage(dir: string): Promise<DiskInfo | null> {
  const s = await statfsAsync(dir)
  if (s) return buildDiskInfo(s.blocks * s.bsize, s.bavail * s.bsize)
  // df -kP fallback (POSIX portable output, 1K blocks)
  try {
    const { stdout } = await execFileAsync('df', ['-kP', dir], { timeout: 5000 })
    const line = stdout.trim().split('\n').pop()
    if (line) {
      const cols = line.split(/\s+/)
      const totalKb = parseInt(cols[1], 10)
      const availKb = parseInt(cols[3], 10)
      if (!Number.isNaN(totalKb) && !Number.isNaN(availKb)) {
        return buildDiskInfo(totalKb * 1024, availKb * 1024)
      }
    }
  } catch {
    // disk info stays null — the panel hides the tile
  }
  return null
}

async function getRepoInfo(repoRoot: string): Promise<Record<string, unknown>> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
  const sha = await git(['rev-parse', 'HEAD'], repoRoot)
  const subject = await git(['log', '-1', '--pretty=%s'], repoRoot)
  const commitTime = await git(['log', '-1', '--pretty=%cI'], repoRoot)
  let dirtyFiles = 0
  try {
    const st = await git(['status', '--porcelain'], repoRoot)
    dirtyFiles = st ? st.split('\n').filter(Boolean).length : 0
  } catch {
    // ignore
  }
  let remoteUrl = ''
  try {
    remoteUrl = await git(['config', '--get', 'remote.origin.url'], repoRoot)
  } catch {
    // ignore
  }
  return {
    dir: repoRoot,
    branch,
    sha,
    short: sha.slice(0, 7),
    subject,
    commitTime,
    dirtyFiles,
    remoteUrl,
    slug: parseRepoSlug(remoteUrl),
  }
}

// ─── API build info ─────────────────────────────────────────────────────────

let cachedApiVersion = ''
function getApiVersion(): string {
  if (cachedApiVersion) return cachedApiVersion
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../package.json') as { version?: string }
    cachedApiVersion = pkg.version || 'unknown'
  } catch {
    cachedApiVersion = 'unknown'
  }
  return cachedApiVersion
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface DeployEvent {
  at: string
  kind: string
  status: string
  commit: string | null
  message: string
}

// ─── Validation ─────────────────────────────────────────────────────────────

const heartbeatSchema = z.object({
  kind: z.enum(['watcher-check', 'deploy-start', 'deploy-result']),
  status: z.enum(['ok', 'success', 'failure', 'error']).default('ok'),
  commit: z.string().max(64).optional(),
  branch: z.string().max(128).optional(),
  repo: z.string().max(256).optional(),
  intervalSec: z.number().int().min(0).max(86400).optional(),
  durationSec: z.number().int().min(0).max(86400).optional(),
  message: z.string().max(500).default(''),
})

// ─── Auth helper ────────────────────────────────────────────────────────────

/**
 * Heartbeat auth: the caller must present the shared deploy token.
 * The token lives in /etc/blasti/blasti.env as DEPLOY_TOKEN and is
 * exported by systemd to both the API and the watcher, so the VPS
 * wires itself up automatically. If no token is configured at all
 * the endpoint is disabled (fail-closed).
 */
function requireDeployToken(c: { req: { header: (name: string) => string | undefined } }): void {
  const expected = process.env.BLASTI_DEPLOY_TOKEN || process.env.DEPLOY_TOKEN
  if (!expected) {
    throw new Error('heartbeat_disabled: set DEPLOY_TOKEN in /etc/blasti/blasti.env')
  }
  const provided = c.req.header('x-deploy-token')
  if (!provided || provided !== expected) {
    throw new Error('invalid_deploy_token')
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function recordEvent(event: DeployEvent): Promise<void> {
  const history = await getConfigJSON<DeployEvent[]>(KEY_EVENTS, [])
  const next = [event, ...history].slice(0, MAX_EVENTS)
  await setConfig(KEY_EVENTS, JSON.stringify(next), {
    category: CATEGORY,
    valueType: 'json',
    description: 'Recent watcher/deploy heartbeat events (newest first)',
  })
}

function timeAgo(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.round((now - t) / 1000))
}

// ─── POST /api/system/deploy-heartbeat — watcher + deploy scripts report ────

app.post('/deploy-heartbeat', async (c) => {
  try {
    requireDeployToken(c)

    const body = await c.req.json()
    const parsed = heartbeatSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid heartbeat payload', details: parsed.error.issues }, 400)
    }
    const hb = parsed.data
    const at = new Date().toISOString()

    if (hb.kind === 'watcher-check') {
      // The watcher reports every poll cycle — this is the liveness signal.
      await setConfig(
        KEY_WATCHER,
        JSON.stringify({
          at,
          commit: hb.commit ?? null,
          branch: hb.branch ?? null,
          repo: hb.repo ?? null,
          intervalSec: hb.intervalSec ?? null,
          result: hb.status,
          message: hb.message,
        }),
        { category: CATEGORY, valueType: 'json', description: 'Last GitHub watcher check-in' }
      )
      await recordEvent({ at, kind: 'watcher-check', status: hb.status, commit: hb.commit ?? null, message: hb.message })
    } else {
      // deploy-start / deploy-result
      if (hb.kind === 'deploy-start') {
        await setConfig(
          KEY_LAST_DEPLOY,
          JSON.stringify({
            at,
            commit: hb.commit ?? null,
            branch: hb.branch ?? null,
            status: 'started',
            kind: 'watcher',
            durationSec: null,
            message: hb.message,
          }),
          { category: CATEGORY, valueType: 'json', description: 'Last deploy attempt/result' }
        )
      } else {
        await setConfig(
          KEY_LAST_DEPLOY,
          JSON.stringify({
            at,
            commit: hb.commit ?? null,
            branch: hb.branch ?? null,
            status: hb.status === 'failure' ? 'failure' : 'success',
            kind: 'deploy',
            durationSec: hb.durationSec ?? null,
            message: hb.message,
          }),
          { category: CATEGORY, valueType: 'json', description: 'Last deploy attempt/result' }
        )
      }
      await recordEvent({
        at,
        kind: hb.kind,
        status: hb.status,
        commit: hb.commit ?? null,
        message: hb.message || (hb.kind === 'deploy-start' ? 'deploy started' : 'deploy finished'),
      })
    }

    return c.json({ success: true })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'heartbeat failed'
    if (msg.includes('deploy_token') || msg.includes('heartbeat_disabled')) {
      return c.json({ success: false, error: msg }, 401)
    }
    return c.json({ success: false, error: 'Heartbeat failed' }, 500)
  }
})

// ─── GET /api/system/vps-status — live server resources + served build ─────

app.get('/vps-status', async (c) => {
  try {
    await requireAdmin(c)

    const cpuPct = await getCpuUsagePct()
    const memory = getMemoryInfo()
    const disk = await getDiskUsage(process.cwd())

    let repo: Record<string, unknown> | null = null
    const repoRoot = findRepoRoot()
    if (repoRoot) {
      try {
        repo = await getRepoInfo(repoRoot)
      } catch {
        repo = { dir: repoRoot, error: 'git info unavailable' }
      }
    }

    const bunGlobal = (globalThis as { Bun?: { version?: string } }).Bun
    const runtime = bunGlobal ? `Bun ${bunGlobal.version ?? ''}`.trim() : `Node ${process.version}`

    return c.json({
      success: true,
      vps: {
        hostname: os.hostname(),
        platform: `${os.platform()} ${os.arch()}`,
        osRelease: os.release(),
        cpu: {
          model: os.cpus()[0]?.model ?? 'unknown',
          cores: os.cpus()?.length ?? 0,
          usagePct: cpuPct,
          loadAvg: os.loadavg().map((l) => Math.round(l * 100) / 100),
        },
        memory,
        disk,
        uptimeSec: Math.round(os.uptime()),
        processUptimeSec: Math.round(process.uptime()),
        runtime,
        apiVersion: getApiVersion(),
        nodeEnv: process.env.NODE_ENV ?? null,
        repo,
        now: new Date().toISOString(),
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /api/system/github-check — manual "is there a new commit?" ────────

app.get('/github-check', async (c) => {
  try {
    await requireAdmin(c)

    const repoRoot = findRepoRoot()
    if (!repoRoot) {
      return c.json({ success: false, error: 'no_repo: this server does not serve from a git checkout' }, 500)
    }
    const branch = process.env.BLASTI_DEPLOY_BRANCH || 'master'
    let remoteUrl = ''
    try {
      remoteUrl = await git(['config', '--get', 'remote.origin.url'], repoRoot)
    } catch {
      // fall through to defaults
    }
    if (!remoteUrl) remoteUrl = process.env.BLASTI_REPO_URL || DEFAULT_REPO_URL

    // Read-only fetch: downloads refs/objects, NEVER touches the working tree.
    try {
      await git(['fetch', 'origin', branch], repoRoot, 45000)
    } catch {
      return c.json(
        { success: false, error: 'fetch_failed: could not reach the git remote (offline or missing credentials)' },
        502
      )
    }

    const localSha = await git(['rev-parse', 'HEAD'], repoRoot)
    const remoteSha = await git(['rev-parse', 'FETCH_HEAD'], repoRoot)
    const behind = parseInt(await git(['rev-list', '--count', 'HEAD..FETCH_HEAD'], repoRoot), 10) || 0
    const ahead = parseInt(await git(['rev-list', '--count', 'FETCH_HEAD..HEAD'], repoRoot), 10) || 0

    let newCommits: Array<{ sha: string; short: string; subject: string; date: string }> = []
    if (behind > 0) {
      const log = await git(['log', 'HEAD..FETCH_HEAD', '--pretty=%H|%s|%cI', '-n', '10'], repoRoot)
      newCommits = log
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, subject, date] = line.split('|')
          return { sha, short: (sha || '').slice(0, 7), subject: subject ?? '', date: date ?? '' }
        })
    }

    const subject = await git(['log', '-1', '--pretty=%s'], repoRoot)
    const commitTime = await git(['log', '-1', '--pretty=%cI'], repoRoot)

    await recordEvent({
      at: new Date().toISOString(),
      kind: 'manual-check',
      status: behind > 0 ? 'behind' : 'ok',
      commit: remoteSha,
      message:
        behind > 0
          ? `manual GitHub check: ${behind} new commit(s) on ${branch}`
          : 'manual GitHub check: up to date',
    })

    return c.json({
      success: true,
      check: {
        repo: { url: remoteUrl, slug: parseRepoSlug(remoteUrl), branch },
        local: { sha: localSha, short: localSha.slice(0, 7), subject, commitTime },
        remote: { sha: remoteSha, short: remoteSha.slice(0, 7) },
        upToDate: behind === 0,
        behind,
        ahead,
        newCommits,
        checkedAt: new Date().toISOString(),
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /api/system/rebuild — manual "pull + rebuild + restart" ───────────
//
// Spawns the SAME pipeline the watcher uses (scripts/watch-and-deploy.sh
// watch --on-server --once), detached, so it survives the API restart that
// happens mid-deploy. The script posts its own deploy heartbeats, holds the
// shared update lock (never races a running install/update) and logs here:
// <STORAGE_ROOT>/logs/rebuild-<timestamp>.log

const rebuildSchema = z.object({
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
})

let rebuildInFlightUntil = 0

app.post('/rebuild', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json().catch(() => ({}))
    const parsed = rebuildSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid payload' }, 400)
    }
    const { force, dryRun } = parsed.data

    if (Date.now() < rebuildInFlightUntil) {
      return c.json(
        { success: false, error: 'already_running: a rebuild was triggered less than 10 minutes ago' },
        409
      )
    }
    const repoRoot = findRepoRoot()
    if (!repoRoot) {
      return c.json({ success: false, error: 'no_repo: this server does not serve from a git checkout' }, 500)
    }
    const scriptPath = path.join(repoRoot, 'scripts', 'watch-and-deploy.sh')
    if (!fs.existsSync(scriptPath)) {
      return c.json({ success: false, error: 'missing_script: scripts/watch-and-deploy.sh not found' }, 500)
    }

    const localSha = await git(['rev-parse', 'HEAD'], repoRoot).catch(() => '')
    const logDir = path.join(STORAGE_ROOT, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const logFile = path.join(logDir, `rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)

    const args = ['watch', '--on-server', '--once', '--dir', repoRoot]
    if (force) args.push('--force')
    if (dryRun) args.push('--dry-run')

    const out = fs.openSync(logFile, 'a')
    const child = spawn('bash', [scriptPath, ...args], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env },
    })
    child.unref()
    fs.closeSync(out)

    rebuildInFlightUntil = Date.now() + 10 * 60_000

    await recordEvent({
      at: new Date().toISOString(),
      kind: 'rebuild-start',
      status: 'ok',
      commit: localSha || null,
      message: dryRun
        ? 'manual rebuild (dry run) started from the admin panel'
        : `manual rebuild started from the admin panel${force ? ' (forced)' : ''}`,
    })

    return c.json({
      success: true,
      started: true,
      pid: child.pid ?? null,
      logFile,
      force,
      dryRun,
      hint: dryRun
        ? 'Dry run: the pipeline only reports what it would do (see the log file on the server).'
        : 'The pipeline pulls the new commit, rebuilds and restarts the services. Live progress: Auto-Deploy activity in Public Apps Settings, or tail -f the log file on the server.',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /api/system/installers/generate — manual CI installer build ──────
//
// Triggers the build-releases.yml GitHub Actions workflow for ONE platform
// (or all). For Android, `androidBuild` selects which APK(s) the pipeline
// builds: 'release' (store/keystore build), 'debug' (debug-keystore build,
// installable on any device — published to the android-debug channel) or
// 'both'. Requires GITHUB_TOKEN (Actions: write) in the API environment:
// add GITHUB_TOKEN to /etc/blasti/blasti.env and restart blasti-api.

const generateSchema = z.object({
  platform: z.enum(['all', 'android', 'windows', 'mac', 'linux']).default('all'),
  androidBuild: z.enum(['release', 'debug', 'both']).default('release'),
  upload: z.boolean().default(true),
})

app.post('/installers/generate', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json().catch(() => ({}))
    const parsed = generateSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid payload' }, 400)
    }
    const { platform, androidBuild, upload } = parsed.data

    const token = githubToken()
    if (!token) {
      return c.json(
        {
          success: false,
          error:
            'no_github_token: add GITHUB_TOKEN to /etc/blasti/blasti.env (a repository token with Actions: write permission) and restart blasti-api to enable manual installer generation',
        },
        400
      )
    }

    const repoRoot = findRepoRoot()
    let remoteUrl = ''
    if (repoRoot) {
      try {
        remoteUrl = await git(['config', '--get', 'remote.origin.url'], repoRoot)
      } catch {
        // fall through to defaults
      }
    }
    if (!remoteUrl) remoteUrl = process.env.BLASTI_REPO_URL || DEFAULT_REPO_URL
    const slug = parseRepoSlug(remoteUrl)
    if (!slug) {
      return c.json({ success: false, error: `cannot_parse_repo: "${remoteUrl}" is not a github.com remote` }, 400)
    }
    const branch = process.env.BLASTI_DEPLOY_BRANCH || 'master'

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20000)
    let res: Response
    try {
      res = await fetch(`https://api.github.com/repos/${slug}/actions/workflows/build-releases.yml/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'blasti-api',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: branch,
          inputs: {
            platform,
            upload: upload ? 'true' : 'false',
            android_build: androidBuild,
          },
        }),
        signal: ac.signal,
      })
    } catch {
      return c.json({ success: false, error: 'github_unreachable: could not reach api.github.com from the server' }, 502)
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 204) {
      await recordEvent({
        at: new Date().toISOString(),
        kind: 'installer-gen',
        status: 'ok',
        commit: null,
        message: `manual installer generation requested (${platform}${
          platform === 'android' ? `, ${androidBuild} APK` : ''
        }, upload=${upload ? 'yes' : 'no'})`,
      })
      return c.json({
        success: true,
        platform,
        androidBuild,
        upload,
        repo: slug,
        branch,
        hint: 'GitHub Actions is building the installer; it will appear here as a DRAFT when the pipeline finishes.',
      })
    }

    const detail = await res.text().catch(() => '')
    if (res.status === 401) {
      return c.json({ success: false, error: 'github_rejected_token (401): check GITHUB_TOKEN on the server' }, 400)
    }
    if (res.status === 404) {
      return c.json(
        { success: false, error: 'not_found (404): build-releases.yml must exist on the default branch of the repo' },
        400
      )
    }
    if (res.status === 422) {
      return c.json({ success: false, error: `github_rejected_request (422): ${detail.slice(0, 300)}` }, 400)
    }
    return c.json({ success: false, error: `github_error (HTTP ${res.status}): ${detail.slice(0, 300)}` }, 502)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /api/system/deploy-status — admin panel reads this ─────────────────

app.get('/deploy-status', async (c) => {
  try {
    await requireAdmin(c)

    const now = Date.now()
    const watcher = await getConfigJSON<{
      at?: string
      commit?: string | null
      branch?: string | null
      repo?: string | null
      intervalSec?: number | null
      result?: string
      message?: string
    } | null>(KEY_WATCHER, null)

    const lastDeploy = await getConfigJSON<{
      at?: string
      commit?: string | null
      branch?: string | null
      status?: string
      kind?: string
      durationSec?: number | null
      message?: string
    } | null>(KEY_LAST_DEPLOY, null)

    const events = await getConfigJSON<DeployEvent[]>(KEY_EVENTS, [])

    const sinceCheckSec = timeAgo(watcher?.at ?? null, now)
    const active = sinceCheckSec !== null && sinceCheckSec < WATCHER_STALE_SEC

    // Diagnose the "watcher shows no data" case: when no DEPLOY_TOKEN is
    // configured in THIS API process, every watcher/CI heartbeat is rejected
    // with 401 and the panel stays empty forever. Surface it explicitly so
    // the admin sees the fix (add DEPLOY_TOKEN to /etc/blasti/blasti.env and
    // restart) instead of an unexplained "no data".
    const heartbeatAuth = Boolean(process.env.BLASTI_DEPLOY_TOKEN || process.env.DEPLOY_TOKEN)

    return c.json({
      success: true,
      watcher: {
        active,
        lastCheckAt: watcher?.at ?? null,
        sinceCheckSec,
        staleAfterSec: WATCHER_STALE_SEC,
        lastCommit: watcher?.commit ?? null,
        branch: watcher?.branch ?? null,
        repo: watcher?.repo ?? null,
        intervalSec: watcher?.intervalSec ?? null,
        lastResult: watcher?.result ?? null,
        lastMessage: watcher?.message ?? null,
        heartbeatAuth,
      },
      lastDeploy: lastDeploy
        ? {
            at: lastDeploy.at ?? null,
            sinceSec: timeAgo(lastDeploy.at ?? null, now),
            commit: lastDeploy.commit ?? null,
            branch: lastDeploy.branch ?? null,
            status: lastDeploy.status ?? null,
            kind: lastDeploy.kind ?? null,
            durationSec: lastDeploy.durationSec ?? null,
            message: lastDeploy.message ?? null,
          }
        : null,
      events: events.map((e) => ({ ...e, sinceSec: timeAgo(e.at, now) })),
      api: {
        version: getApiVersion(),
        uptimeSec: Math.round(process.uptime()),
        nodeEnv: process.env.NODE_ENV ?? null,
        now: new Date(now).toISOString(),
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const systemStatusRoutes = app
