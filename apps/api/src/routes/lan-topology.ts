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
 *   GET  /resolve     — PUBLIC (0.6.86): kiosk/tablet resolves a branch code
 *                       to the candidate LAN hosts (ip:port) reported by that
 *                       agency's desktops. This is the CLOUD ASSIST for
 *                       "kiosk cannot connect by branch code": the kiosk
 *                       enters the branch code, gets the desktop's LAN IP
 *                       here, probes it locally and pairs on the LAN store
 *                       (same DB the desktop Device Manager reads) — no
 *                       subnet sweep required (works across AP isolation,
 *                       VLANs with inter-guest routing, or a missed sweep).
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

// GET /lan-topology/resolve?code=XXX — PUBLIC branch-code → LAN host(s).
// (0.6.86) The kiosk/tablet "connect by branch code" flow calls this on the
// CLOUD api, then probes the returned hosts on the LAN (GET /api/discover →
// service 'blasti-local') and registers/pairs against the FIRST live one —
// which lands the device in the SAME local store the desktop manager polls.
app.get('/resolve', async (c) => {
  try {
    const code = (c.req.query('code') || '').trim().toUpperCase()
    if (!code) return c.json({ success: false, error: 'code is required' }, 400)
    const agency = await db.agency.findUnique({
      where: { customCode: code },
      select: {
        id: true, name: true, nameAr: true, nameFr: true, customCode: true,
        isActive: true, isQueueOpen: true, logoUrl: true, category: true,
      },
    })
    if (!agency || !agency.isActive) {
      return c.json({ success: false, error: 'AGENCY_NOT_FOUND' }, 404)
    }
    // Reachable window: nodes that reported in the last 5 minutes (2× the
    // online window — a desktop behind a flaky link is still worth probing).
    const cutoff = new Date(Date.now() - 5 * 60 * 1000)
    const nodes = await db.lanNode.findMany({
      where: {
        agencyId: agency.id,
        ipAddress: { not: null },
        lastReportAt: { gte: cutoff },
      },
      orderBy: [
        { role: 'desc' },   // MASTER first, then FOLLOWER, CANDIDATE (desc alphabetical)
        { lastReportAt: 'desc' },
      ],
      take: 8,
      select: {
        name: true, hostname: true, ipAddress: true, lanPort: true,
        role: true, lastReportAt: true,
      },
    })
    return c.json({
      success: true,
      agency: {
        id: agency.id, name: agency.name, nameAr: agency.nameAr,
        nameFr: agency.nameFr, customCode: agency.customCode,
        isQueueOpen: agency.isQueueOpen, logoUrl: agency.logoUrl,
        category: agency.category,
      },
      hosts: nodes.map((n: { name: string; hostname: string | null; ipAddress: string | null; lanPort: number; role: string; lastReportAt: Date }) => ({
        ip: n.ipAddress,
        port: n.lanPort,
        name: n.name,
        hostname: n.hostname,
        role: n.role,
        reportedAt: n.lastReportAt.toISOString(),
      })),
    })
  } catch (error: unknown) {
    console.error('[lan-topology/resolve] failed:', error)
    return c.json({ success: false, error: 'Resolve failed' }, 500)
  }
})

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

type JoinedDevice = {
  /** 0.6.100 — entry discriminator: undefined = joined device, otherwise a
   *  kind-tagged report entry ('pending-join' | 'peripheral'). */
  kind?: string;
  deviceId?: string;
  name?: string;
  platform?: string;
  role?: string;
  username?: string | null;
  requestedAt?: string;
  lastSeenAt?: string | null;
  /** peripheral-only fields */
  pkind?: string;
  cupsName?: string;
  cupsUri?: string;
  usbVendorId?: string;
  usbProductId?: string;
  state?: string;
}

// 0.6.100 — kind-tagged entries ride the same devices array:
//   kind:'pending-join'  → a pairing request waiting on that master
//   kind:'peripheral'    → a USB peripheral (printer) attached to that node
//   (no kind)            → a joined device
function sanitizeJoinedDevices(raw: unknown): JoinedDevice[] {
  if (!Array.isArray(raw)) return []
  const out: JoinedDevice[] = []
  for (const item of raw.slice(0, MAX_JOINED_DEVICES + 40)) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const kind = typeof rec.kind === 'string' ? rec.kind : ''
    if (kind === 'pending-join') {
      const deviceId = typeof rec.deviceId === 'string' ? rec.deviceId.slice(0, 80) : ''
      if (!deviceId) continue
      out.push({
        kind: 'pending-join',
        deviceId,
        name: typeof rec.name === 'string' ? rec.name.slice(0, 80) : undefined,
        platform: typeof rec.platform === 'string' ? rec.platform.slice(0, 16) : undefined,
        role: typeof rec.role === 'string' ? rec.role.slice(0, 24) : undefined,
        username: typeof rec.username === 'string' ? rec.username.slice(0, 80) : null,
        requestedAt: typeof rec.requestedAt === 'string' ? rec.requestedAt.slice(0, 40) : undefined,
      })
      continue
    }
    if (kind === 'peripheral') {
      const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim().slice(0, 100) : ''
      if (!name) continue
      out.push({
        kind: 'peripheral',
        name,
        pkind: typeof rec.pkind === 'string' ? rec.pkind.slice(0, 24) : 'printer',
        cupsName: typeof rec.cupsName === 'string' ? rec.cupsName.slice(0, 120) : undefined,
        cupsUri: typeof rec.cupsUri === 'string' ? rec.cupsUri.slice(0, 200) : undefined,
        usbVendorId: typeof rec.usbVendorId === 'string' ? rec.usbVendorId.slice(0, 20) : undefined,
        usbProductId: typeof rec.usbProductId === 'string' ? rec.usbProductId.slice(0, 20) : undefined,
        state: typeof rec.state === 'string' ? rec.state.slice(0, 24) : undefined,
      })
      continue
    }
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
// 0.6.103 — KIOSK DEVICE-TOKEN ACCESS: a pairing-standby kiosk has NO staff
// session, so its topology-assisted discovery probe (lan-discovery.ts
// probeTopologyServers) used to 401 here and fall back to the slow 4-subnet
// sweep (6-18s, 1100+ daily "NO desktop box found" events). A kiosk device
// token resolves its agency and may read the same snapshot (read-only, no
// preference fields are sensitive) — the sweep collapses to ONE probe of the
// exact desktop IP the desktop itself reported.
app.get('/', async (c) => {
  try {
    let agencyId = ''
    try {
      const user = await requireAuth(c)
      agencyId = c.req.query('agencyId') || user.agencyId || ''
      if (agencyId && !(await canAccessAgency(user, agencyId))) {
        return c.json({ success: false, error: 'FORBIDDEN_AGENCY' }, 403)
      }
    } catch {
      // Staff auth absent → try the DEVICE token (kiosk/TV waiting for pairing)
      const deviceToken = c.req.header('X-Device-Token') || c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') || ''
      if (!deviceToken) throw new Error('Authentication required')
      const device = await db.agencyDevice.findUnique({ where: { deviceToken }, select: { agencyId: true, status: true } })
      if (!device || !device.agencyId) {
        return c.json({ success: false, error: 'Authentication required' }, 401)
      }
      agencyId = device.agencyId
    }
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)

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
      const kindTagged = joined.filter((d) => (d as unknown as { kind?: string }).kind)
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
        joinedDevices: joined.filter((d) => !(d as unknown as { kind?: string }).kind && d.deviceId),
        // 0.6.100 — pairing requests waiting on this node's approval
        pendingJoins: kindTagged.filter((d) => (d as unknown as { kind?: string }).kind === 'pending-join'),
        // 0.6.100 — USB peripherals (printers) attached to this node
        peripherals: kindTagged.filter((d) => (d as unknown as { kind?: string }).kind === 'peripheral'),
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

// ── 0.6.100 — REMOTE JOIN APPROVAL (devices must accept before pairing) ────
// The master reports its pending join requests (devicesJson kind:'pending-join')
// → the Device Manager tree shows them with Accept/Reject buttons → the
// verdict lands here → the master's reporter pull (≤30s) applies it and the
// device's next join attempt is granted (or refused with 403).
const VERDICTS = new Set(['ACCEPT', 'REJECT'])

app.post('/join-verdict', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    const agencyId = typeof body.agencyId === 'string' ? body.agencyId : user.agencyId || ''
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : ''
    const verdict = typeof body.verdict === 'string' ? body.verdict.toUpperCase() : ''
    if (!agencyId || !deviceId) return c.json({ success: false, error: 'agencyId and deviceId are required' }, 400)
    if (!VERDICTS.has(verdict)) return c.json({ success: false, error: 'verdict must be ACCEPT or REJECT' }, 400)
    if (!(await canManageMasterSelection(user, agencyId))) {
      return c.json({ success: false, error: 'FORBIDDEN_VERDICT' }, 403)
    }
    // Verdicts older than a day are worthless (the request TTL is 10min).
    await db.lanJoinVerdict.deleteMany({
      where: { agencyId, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }).catch(() => null)
    const row = await db.lanJoinVerdict.upsert({
      where: { agencyId_deviceId: { agencyId, deviceId } },
      update: { verdict, decidedById: user.id, decidedByName: user.fullName || user.username || null, createdAt: new Date() },
      create: { agencyId, deviceId, verdict, decidedById: user.id, decidedByName: user.fullName || user.username || null },
    })
    void emitAgencyEvent('agency:updated', agencyId, {
      action: 'lan-topology',
      kind: 'join-verdict',
      deviceId,
      verdict,
    })
    return c.json({ success: true, verdict: row.verdict })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.get('/join-verdicts', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = c.req.query('agencyId') || user.agencyId || ''
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)
    if (!(await canAccessAgency(user, agencyId))) {
      return c.json({ success: false, error: 'FORBIDDEN_AGENCY' }, 403)
    }
    const sinceRaw = c.req.query('since') || ''
    const since = sinceRaw ? new Date(sinceRaw) : null
    const rows = await db.lanJoinVerdict.findMany({
      where: {
        agencyId,
        createdAt: { gte: since && !Number.isNaN(since.getTime()) ? since : new Date(Date.now() - 15 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { deviceId: true, verdict: true, createdAt: true },
    })
    return c.json({
      success: true,
      verdicts: rows.map((r) => ({ deviceId: r.deviceId, verdict: r.verdict, createdAt: r.createdAt.toISOString() })),
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const lanTopologyRoutes = app
