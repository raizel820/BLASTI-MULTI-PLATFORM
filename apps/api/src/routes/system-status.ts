import { Hono } from 'hono'
import { z } from 'zod'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { getConfigJSON, setConfig } from '../lib/config-manager'

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
      return c.json({ success: false, error: 'Invalid heartbeat payload', details: parsed.error.errors }, 400)
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
