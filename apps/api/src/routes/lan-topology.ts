/**
 * LAN topology — branch desktop masters, reported to the cloud (r21-9).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every BLASTI desktop reports itself here every 30s (local-api
 * lan-authority.js): its identity, election role/term, spec score, uptime and
 * its joined-LAN-device registry. The Owner Device Manager renders this as
 * the "Branch LAN & Master PC" section: all connected branch machines, the
 * CURRENT MASTER PC, and a manual master pin (isPreferredMaster) that the
 * desktops fetch and enforce in their election.
 *
 *   POST /report      — desktop heartbeat (auth: any workspace member's JWT)
 *   GET  /            — topology snapshot for the owner dashboard
 *   POST /preference  — owner/manager pins the master PC (instanceId | null)
 *   GET  /preference  — desktops poll this to learn the pin (any member)
 */
import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { emitAgencyEvent } from '../lib/realtime-emit'

const app = new Hono()

/** A node is "reachable" while it reported within this window. */
const ONLINE_WINDOW_MS = 90_000
/** Hard TTL — nodes silent for a day are pruned on read. */
const RETENTION_MS = 24 * 60 * 60 * 1000
/** Joined-device registry cap mirrored from the desktop's MAX_DEVICES. */
const MAX_JOINED_DEVICES = 50

const ROLES = new Set(['CANDIDATE', 'FOLLOWER', 'MASTER'])

/** Owner of the agency, SUPER_ADMIN, or active staff of the agency. */
async function canAccessAgency(user: { id: string; role: string }, agencyId: string): Promise<boolean> {
  if (user.role === 'SUPER_ADMIN') return true
  const owned = await db.agency.findFirst({ where: { id: agencyId, ownerId: user.id }, select: { id: true } })
  if (owned) return true
  const staff = await db.agencyStaff.findFirst({
    where: { userId: user.id, agencyId, isActive: true },
    select: { id: true },
  })
  return !!staff
}

/** Only the OWNER (or SUPER_ADMIN / branch MANAGER) may pin the master PC. */
async function canManageMasterSelection(user: { id: string; role: string }, agencyId: string): Promise<boolean> {
  if (user.role === 'SUPER_ADMIN') return true
  const owned = await db.agency.findFirst({ where: { id: agencyId, ownerId: user.id }, select: { id: true } })
  if (owned) return true
  const manager = await db.agencyStaff.findFirst({
    where: { userId: user.id, agencyId, isActive: true, role: 'MANAGER' },
    select: { id: true },
  })
  return !!manager
}

type JoinedDevice = { deviceId: string; name?: string; platform?: string; username?: string | null; lastSeenAt?: string | null }

function sanitizeJoinedDevices(raw: unknown): JoinedDevice[] {
  if (!Array.isArray(raw)) return []
  const out: JoinedDevice[] = []
  for (const item of raw.slice(0, MAX_JOINED_DEVICES)) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const deviceId = typeof rec.deviceId === 'string' ? rec.deviceId.slice(0, 80) : ''
    if (!deviceId) continue
    out.push({
      deviceId,
      name: typeof rec.name === 'string' ? rec.name.slice(0, 80) : undefined,
      platform: typeof rec.platform === 'string' ? rec.platform.slice(0, 16) : undefined,
      username: typeof rec.username === 'string' ? rec.username.slice(0, 80) : null,
      lastSeenAt: typeof rec.lastSeenAt === 'string' ? rec.lastSeenAt.slice(0, 40) : null,
    })
  }
  return out
}

// POST /lan-topology/report — desktop heartbeat (30s cadence).
app.post('/report', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ success: false, error: 'Invalid JSON body' }, 400)

    const agencyId = typeof body.agencyId === 'string' ? body.agencyId : ''
    const instanceId = typeof body.instanceId === 'string' ? body.instanceId.slice(0, 80) : ''
    if (!agencyId || !instanceId) {
      return c.json({ success: false, error: 'agencyId and instanceId are required' }, 400)
    }
    if (!(await canAccessAgency(user, agencyId))) {
      return c.json({ success: false, error: 'FORBIDDEN_AGENCY' }, 403)
    }

    const role = typeof body.role === 'string' && ROLES.has(body.role) ? body.role : 'CANDIDATE'
    const term = Number.isFinite(Number(body.term)) ? Math.max(0, Math.floor(Number(body.term))) : 0
    const specScore = Number.isFinite(Number(body.specScore)) ? Number(body.specScore) : 0
    const uptimeSec = Number.isFinite(Number(body.uptimeSec)) ? Math.max(0, Math.floor(Number(body.uptimeSec))) : 0
    const lanPort = Number.isFinite(Number(body.lanPort)) ? Math.min(65535, Math.max(1, Math.floor(Number(body.lanPort)))) : 3080
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : ''
    const hostname = typeof body.hostname === 'string' && body.hostname.trim() ? body.hostname.trim().slice(0, 120) : null
    const ipAddress = typeof body.ipAddress === 'string' && body.ipAddress.trim() ? body.ipAddress.trim().slice(0, 45) : null
    const branchId = typeof body.branchId === 'string' && body.branchId ? body.branchId : null
    const devices = sanitizeJoinedDevices(body.devices)

    const existing = await db.lanNode.findUnique({
      where: { agencyId_instanceId: { agencyId, instanceId } },
      select: { id: true, role: true, isPreferredMaster: true },
    })

    const node = await db.lanNode.upsert({
      where: { agencyId_instanceId: { agencyId, instanceId } },
      update: {
        name: name || undefined,
        hostname,
        ipAddress,
        lanPort,
        role,
        term,
        specScore,
        uptimeSec,
        ...(branchId ? { branchId } : {}),
        devicesJson: JSON.stringify(devices),
        lastReportAt: new Date(),
      },
      create: {
        agencyId,
        instanceId,
        name,
        hostname,
        ipAddress,
        lanPort,
        role,
        term,
        specScore,
        uptimeSec,
        branchId,
        devicesJson: JSON.stringify(devices),
      },
    })

    // Realtime nudge only when the topology actually CHANGED (role flip or a
    // brand-new node) — a 30s heartbeat must not flood the agency room.
    if (!existing || existing.role !== role) {
      void emitAgencyEvent('agency:updated', agencyId, {
        action: 'lan-topology',
        kind: existing ? 'role-changed' : 'node-joined',
        instanceId,
        name: name || hostname || instanceId,
        role,
        term,
      })
    }

    return c.json({ success: true, nodeId: node.id, isPreferredMaster: node.isPreferredMaster })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /lan-topology?agencyId= — snapshot for the Owner Device Manager.
app.get('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = c.req.query('agencyId') || user.agencyId || ''
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)
    if (!(await canAccessAgency(user, agencyId))) {
      return c.json({ success: false, error: 'FORBIDDEN_AGENCY' }, 403)
    }

    // Occasional retention prune (cheap, indexed by agencyId+lastReportAt).
    // An owner-PINNED PC is never pruned — the manual master choice must
    // survive even if that machine stops reporting for days.
    await db.lanNode.deleteMany({
      where: { agencyId, isPreferredMaster: false, lastReportAt: { lt: new Date(Date.now() - RETENTION_MS) } },
    }).catch(() => null)

    const nodes = await db.lanNode.findMany({
      where: { agencyId },
      orderBy: { lastReportAt: 'desc' },
      take: 50,
    })

    const now = Date.now()
    const onlineCutoff = now - ONLINE_WINDOW_MS
    const shaped = nodes.map((n) => {
      let joined: JoinedDevice[] = []
      try {
        const parsed = n.devicesJson ? JSON.parse(n.devicesJson) : []
        if (Array.isArray(parsed)) joined = parsed as JoinedDevice[]
      } catch { /* corrupt JSON — ignore */ }
      return {
        id: n.id,
        instanceId: n.instanceId,
        name: n.name || n.hostname || n.instanceId,
        hostname: n.hostname,
        ipAddress: n.ipAddress,
        lanPort: n.lanPort,
        role: n.role,
        term: n.term,
        specScore: n.specScore,
        uptimeSec: n.uptimeSec,
        branchId: n.branchId,
        isPreferredMaster: n.isPreferredMaster,
        online: n.lastReportAt.getTime() >= onlineCutoff,
        lastReportAt: n.lastReportAt.toISOString(),
        joinedDevices: joined,
      }
    })

    // CURRENT MASTER PC: a live node wearing the MASTER role; the owner's pin
    // wins as the fallback display when no live master has reported yet.
    const liveMaster = shaped.find((n) => n.online && n.role === 'MASTER') ?? null
    const preferred = shaped.find((n) => n.isPreferredMaster) ?? null
    const currentMaster = liveMaster ?? (preferred && preferred.online ? preferred : null)

    return c.json({
      success: true,
      nodes: shaped,
      currentMaster: currentMaster
        ? {
            instanceId: currentMaster.instanceId,
            name: currentMaster.name,
            ipAddress: currentMaster.ipAddress,
            lanPort: currentMaster.lanPort,
            role: currentMaster.role,
            term: currentMaster.term,
            specScore: currentMaster.specScore,
            online: currentMaster.online,
            lastReportAt: currentMaster.lastReportAt,
          }
        : null,
      preferredInstanceId: preferred?.instanceId ?? null,
      totalJoinedDevices: shaped.reduce((acc, n) => acc + (n.online ? n.joinedDevices.length : 0), 0),
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /lan-topology/preference — owner/manager pins the master PC.
app.post('/preference', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ success: false, error: 'Invalid JSON body' }, 400)

    const agencyId = typeof body.agencyId === 'string' ? body.agencyId : ''
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)
    if (!(await canManageMasterSelection(user, agencyId))) {
      return c.json({ success: false, error: 'FORBIDDEN_MASTER_PIN' }, 403)
    }

    // instanceId: string pins that node; null/'' clears the pin (auto election).
    const instanceId = typeof body.instanceId === 'string' && body.instanceId ? body.instanceId.slice(0, 80) : null

    await db.lanNode.updateMany({ where: { agencyId }, data: { isPreferredMaster: false } })
    if (instanceId) {
      const res = await db.lanNode.updateMany({
        where: { agencyId, instanceId },
        data: { isPreferredMaster: true },
      })
      if (res.count === 0) {
        return c.json({ success: false, error: 'NODE_NOT_FOUND — that PC has never reported to this agency' }, 404)
      }
    }

    void emitAgencyEvent('agency:updated', agencyId, {
      action: 'lan-topology',
      kind: 'preference-changed',
      preferredInstanceId: instanceId,
      actorUserId: user.id,
    })

    return c.json({ success: true, preferredInstanceId: instanceId })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /lan-topology/preference?agencyId= — desktops poll this (any member).
app.get('/preference', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = c.req.query('agencyId') || user.agencyId || ''
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)
    if (!(await canAccessAgency(user, agencyId))) {
      return c.json({ success: false, error: 'FORBIDDEN_AGENCY' }, 403)
    }
    const pinned = await db.lanNode.findFirst({
      where: { agencyId, isPreferredMaster: true },
      select: { instanceId: true, name: true, hostname: true, updatedAt: true },
    })
    return c.json({
      success: true,
      preferredInstanceId: pinned?.instanceId ?? null,
      preferredName: pinned?.name ?? pinned?.hostname ?? null,
      updatedAt: pinned?.updatedAt?.toISOString() ?? null,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const lanTopologyRoutes = app
