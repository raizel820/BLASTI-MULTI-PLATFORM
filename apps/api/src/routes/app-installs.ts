import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
// r20-3(a): rank "latest published" by semantic name when versionCode is 0
// (CI rows) so an old admin row (code 5000) can't shadow a newer CI build.
import { pickLatestAppVersion } from '../lib/app-version-rank'
import { z } from 'zod'

// ─── App Install Tracking & Update Pusher (Public App Settings rebuild) ─────
//
// REAL device telemetry — no hardcoded numbers anywhere:
//   • POST /register + /heartbeat (PUBLIC): installed devices check in with a
//     STABLE machine fingerprint that survives updates AND uninstall→reinstall,
//     so one physical machine is exactly one AppDevice row (user requirement:
//     "uninstall and re-install on the same device do not count as active
//     device"). Reinstalls are detected via a regenerated client UUID and
//     counted, but never duplicate the device.
//   • Admin surfaces: /devices, /stats, /events and the update-pusher
//     (/pushes) — every number is aggregated from live DB rows.
//
// Update push delivery is poll-based: devices receive the newest applicable
// ACTIVE push in every register/heartbeat response, and when a device reports
// running a pushed target version the ack is recorded automatically —
// giving per-push DELIVERED (checked in after push) and UPDATED (ack) counts.

const app = new Hono()

const PLATFORMS = ['android', 'android-debug', 'ios', 'electron', 'windows', 'mac', 'linux'] as const
type Platform = (typeof PLATFORMS)[number]

// ─── Validation ──────────────────────────────────────────────────────────────

const deviceCheckInSchema = z.object({
  platform: z.enum(PLATFORMS),
  // Stable machine fingerprint — the dedupe key (survives updates/reinstalls).
  fingerprint: z.string().min(8).max(128),
  // Client UUID — regenerated on reinstall; used to DETECT reinstalls.
  deviceId: z.string().min(4).max(128),
  version: z.string().min(1).max(50),
  label: z.string().max(200).nullish(),
  osName: z.string().max(100).nullish(),
  osVersion: z.string().max(100).nullish(),
})

const heartbeatSchema = z.object({
  platform: z.enum(PLATFORMS),
  fingerprint: z.string().min(8).max(128),
  version: z.string().min(1).max(50),
})

const createPushSchema = z.object({
  platform: z.enum(PLATFORMS),
  appVersionId: z.string().min(1),
  isMandatory: z.boolean().default(false),
  message: z.string().max(2000).default(''),
  messageAr: z.string().max(2000).nullish(),
  messageFr: z.string().max(2000).nullish(),
})

// ─── Helpers ─────────────────────────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const aVal = aParts[i] || 0
    const bVal = bParts[i] || 0
    if (aVal > bVal) return 1
    if (aVal < bVal) return -1
  }
  return 0
}

/**
 * Public update payload for a device: latest published version for the
 * platform + the newest applicable ACTIVE push (target newer than the
 * reported version). Also records push acknowledgements for pushes this
 * device has already satisfied (it now runs ≥ the pushed target).
 */
async function buildUpdatePayload(platform: string, currentVersion: string, deviceId: string) {
  const latestCandidates = await db.appVersion.findMany({
    where: { platform, isPublished: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  const latest = pickLatestAppVersion(latestCandidates)

  const updateAvailable = !!latest && compareVersions(latest.version, currentVersion) > 0

  const activePushes = await db.updatePush.findMany({
    where: { platform, status: 'ACTIVE' },
    include: { appVersion: true },
    orderBy: { createdAt: 'desc' },
  })

  // Record acks for pushes this device has satisfied (now runs ≥ target).
  const satisfied = activePushes.filter((p) => compareVersions(p.appVersion.version, currentVersion) <= 0)
  if (satisfied.length > 0) {
    await db.updatePushAck
      .createMany({
        data: satisfied.map((p) => ({
          pushId: p.id,
          deviceId,
          fromVersion: null,
          toVersion: currentVersion,
        })),
        skipDuplicates: true,
      })
      .catch(() => undefined) // ack bookkeeping must never break a check-in
  }

  // Newest applicable push = target version NEWER than what the device runs.
  const applicable = activePushes.find((p) => compareVersions(p.appVersion.version, currentVersion) > 0) ?? null

  const isMandatory = updateAvailable
    ? (applicable?.isMandatory ?? latest?.isMandatory ?? false)
    : false

  return {
    available: updateAvailable,
    currentVersion,
    latestVersion: latest?.version ?? null,
    isMandatory,
    downloadUrl: updateAvailable
      ? latest?.downloadUrl || (latest ? `/api/app-versions/${latest.id}/download` : '')
      : '',
    fileSize: latest?.fileSize ?? null,
    fileHash: latest?.fileHash ?? null,
    releaseNotes: latest?.releaseNotes ?? '',
    releaseNotesAr: latest?.releaseNotesAr ?? '',
    releaseNotesFr: latest?.releaseNotesFr ?? '',
    push: applicable
      ? {
          id: applicable.id,
          isMandatory: applicable.isMandatory,
          message: applicable.message,
          messageAr: applicable.messageAr,
          messageFr: applicable.messageFr,
          targetVersion: applicable.appVersion.version,
          createdAt: applicable.createdAt,
        }
      : null,
  }
}

/**
 * Dedupe-first device upsert (the heart of accurate counting):
 *   new (platform, fingerprint)  → INSTALL, installCount = 1
 *   same fingerprint, new UUID   → REINSTALL, installCount += 1
 *   same fingerprint, new version → UPDATE
 *   otherwise                    → HEARTBEAT
 */
async function checkInDevice(input: {
  platform: Platform
  fingerprint: string
  deviceId: string
  version: string
  label?: string | null
  osName?: string | null
  osVersion?: string | null
}) {
  const existing = await db.appDevice.findUnique({
    where: {
      platform_fingerprint: { platform: input.platform, fingerprint: input.fingerprint },
    },
  })

  if (!existing) {
    const device = await db.appDevice.create({
      data: {
        platform: input.platform,
        fingerprint: input.fingerprint,
        deviceId: input.deviceId,
        label: input.label ?? null,
        osName: input.osName ?? null,
        osVersion: input.osVersion ?? null,
        appVersion: input.version,
        installCount: 1,
        lastActiveAt: new Date(),
      },
    })
    await db.appInstallEvent.create({
      data: { deviceId: device.id, platform: input.platform, version: input.version, eventType: 'INSTALL' },
    })
    return { device, event: 'INSTALL' as const }
  }

  const isReinstall = existing.deviceId !== input.deviceId
  const isUpdate = !!existing.appVersion && existing.appVersion !== input.version
  const eventType = isReinstall ? 'REINSTALL' : isUpdate ? 'UPDATE' : 'HEARTBEAT'

  const device = await db.appDevice.update({
    where: { id: existing.id },
    data: {
      deviceId: input.deviceId,
      label: input.label ?? existing.label,
      osName: input.osName ?? existing.osName,
      osVersion: input.osVersion ?? existing.osVersion,
      appVersion: input.version,
      installCount: isReinstall ? { increment: 1 } : undefined,
      lastActiveAt: new Date(),
    },
  })
  await db.appInstallEvent.create({
    data: { deviceId: device.id, platform: input.platform, version: input.version, eventType },
  })
  return { device, event: eventType }
}

// ─── POST /app-installs/register — PUBLIC device registration + check-in ─────
//
// Called once by the app on every launch (and by heartbeats as a fallback).
// Public by design: pre-login devices must be able to report. Returns the
// update payload so the SAME call powers update pushing.

app.post('/register', async (c) => {
  try {
    const body = await c.req.json().catch(() => null)
    const parsed = deviceCheckInSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input', details: parsed.error.issues }, 400)
    }
    const input = parsed.data

    const { device, event } = await checkInDevice(input)
    const update = await buildUpdatePayload(input.platform, input.version, device.id)

    return c.json({
      success: true,
      event,
      device: {
        id: device.id,
        installCount: device.installCount,
        firstSeenAt: device.firstSeenAt,
      },
      update,
    })
  } catch (error: unknown) {
    console.error('[app-installs] register failed:', error)
    return c.json({ success: false, error: 'Register failed' }, 500)
  }
})

// ─── POST /app-installs/heartbeat — PUBLIC lightweight activity ping ────────
//
// Same dedupe semantics as /register but only needs (platform, fingerprint,
// version). Devices that already registered can skip the label/os fields.

app.post('/heartbeat', async (c) => {
  try {
    const body = await c.req.json().catch(() => null)
    const parsed = heartbeatSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input', details: parsed.error.issues }, 400)
    }
    const { platform, fingerprint, version } = parsed.data

    const existing = await db.appDevice.findUnique({
      where: { platform_fingerprint: { platform, fingerprint } },
    })
    if (!existing) {
      // Never seen → treat as a first check-in with a synthetic UUID so the
      // device still counts exactly once.
      const { device, event } = await checkInDevice({
        platform,
        fingerprint,
        deviceId: `hb-${fingerprint.slice(0, 16)}`,
        version,
      })
      const update = await buildUpdatePayload(platform, version, device.id)
      return c.json({ success: true, event, update })
    }

    const { device, event } = await checkInDevice({
      platform,
      fingerprint,
      deviceId: existing.deviceId,
      version,
      label: existing.label,
      osName: existing.osName,
      osVersion: existing.osVersion,
    })
    const update = await buildUpdatePayload(platform, version, device.id)
    return c.json({ success: true, event, update })
  } catch (error: unknown) {
    console.error('[app-installs] heartbeat failed:', error)
    return c.json({ success: false, error: 'Heartbeat failed' }, 500)
  }
})

// ─── Everything below is ADMIN-ONLY (Public App Settings surfaces) ──────────

async function requireAdminWrap(c: Context) {
  await requireAdmin(c)
}

// ─── GET /app-installs/devices — real device list ───────────────────────────
// Query: platform, activeWithin (days, default all), search (label/id/version)

app.get('/devices', async (c) => {
  try {
    await requireAdminWrap(c)

    const platform = c.req.query('platform')
    const activeWithin = c.req.query('activeWithin')
    const search = c.req.query('search')?.trim()

    const where: any = {}
    if (platform && platform !== 'all') where.platform = platform
    if (activeWithin && activeWithin !== 'all') {
      const days = parseInt(activeWithin, 10)
      if (!Number.isNaN(days) && days > 0) {
        where.lastActiveAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
      }
    }
    if (search) {
      where.OR = [
        { label: { contains: search, mode: 'insensitive' } },
        { deviceId: { contains: search, mode: 'insensitive' } },
        { appVersion: { contains: search, mode: 'insensitive' } },
        { osName: { contains: search, mode: 'insensitive' } },
      ]
    }

    const devices = await db.appDevice.findMany({
      where,
      orderBy: { lastActiveAt: 'desc' },
      take: 500,
    })

    return c.json({ success: true, devices, count: devices.length })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-installs/stats — REAL aggregated analytics ────────────────────
// Every number below is computed from live AppDevice / AppInstallEvent rows.

app.get('/stats', async (c) => {
  try {
    await requireAdminWrap(c)

    const now = Date.now()
    const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000)
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000)

    const [totalDevices, active7d, active30d, installEvents, updateEvents] = await Promise.all([
      db.appDevice.count(),
      db.appDevice.count({ where: { lastActiveAt: { gte: d7 } } }),
      db.appDevice.count({ where: { lastActiveAt: { gte: d30 } } }),
      db.appInstallEvent.count({ where: { eventType: { in: ['INSTALL', 'REINSTALL'] } } }),
      db.appInstallEvent.count({ where: { eventType: 'UPDATE' } }),
    ])

    // Per-platform breakdown
    const devices = await db.appDevice.findMany({
      select: { platform: true, appVersion: true, lastActiveAt: true },
    })
    const byPlatformMap = new Map<string, { platform: string; devices: number; active7d: number }>()
    const byVersionMap = new Map<string, { platform: string; version: string; devices: number; active7d: number }>()
    for (const d of devices) {
      const p = byPlatformMap.get(d.platform) ?? { platform: d.platform, devices: 0, active7d: 0 }
      p.devices += 1
      if (d.lastActiveAt >= d7) p.active7d += 1
      byPlatformMap.set(d.platform, p)

      const vKey = `${d.platform}|${d.appVersion ?? 'unknown'}`
      const v = byVersionMap.get(vKey) ?? { platform: d.platform, version: d.appVersion ?? 'unknown', devices: 0, active7d: 0 }
      v.devices += 1
      if (d.lastActiveAt >= d7) v.active7d += 1
      byVersionMap.set(vKey, v)
    }

    // 30-day install/update timeline (real event log)
    const recentEvents = await db.appInstallEvent.findMany({
      where: { createdAt: { gte: d30 }, eventType: { in: ['INSTALL', 'REINSTALL', 'UPDATE'] } },
      select: { eventType: true, createdAt: true },
    })
    const timeline: Array<{ date: string; installs: number; updates: number }> = []
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(now - i * 24 * 60 * 60 * 1000)
      const key = dayStart.toISOString().slice(0, 10)
      timeline.push({ date: key, installs: 0, updates: 0 })
    }
    const dayIndex = new Map(timeline.map((t) => [t.date, t]))
    for (const e of recentEvents) {
      const entry = dayIndex.get(e.createdAt.toISOString().slice(0, 10))
      if (!entry) continue
      if (e.eventType === 'UPDATE') entry.updates += 1
      else entry.installs += 1
    }

    const recent = await db.appInstallEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { device: { select: { label: true, platform: true } } },
    })

    return c.json({
      success: true,
      totals: {
        devices: totalDevices,
        active7d,
        active30d,
        installsTotal: installEvents,
        updatesTotal: updateEvents,
      },
      byPlatform: [...byPlatformMap.values()].sort((a, b) => b.devices - a.devices),
      byVersion: [...byVersionMap.values()].sort((a, b) => b.devices - a.devices),
      timeline,
      recentEvents: recent.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        platform: e.platform,
        version: e.version,
        label: e.device?.label ?? null,
        createdAt: e.createdAt,
      })),
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-installs/events — event log (filterable) ──────────────────────

app.get('/events', async (c) => {
  try {
    await requireAdminWrap(c)

    const platform = c.req.query('platform')
    const eventType = c.req.query('eventType')
    const limit = Math.min(parseInt(c.req.query('limit') ?? '100', 10) || 100, 500)

    const where: any = {}
    if (platform && platform !== 'all') where.platform = platform
    if (eventType && eventType !== 'all') where.eventType = eventType

    const events = await db.appInstallEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { device: { select: { label: true } } },
    })

    return c.json({
      success: true,
      events: events.map((e) => ({ ...e, label: e.device?.label ?? null })),
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Update Pusher (admin) ───────────────────────────────────────────────────

// GET /app-installs/pushes — list pushes with REAL delivery stats:
//   delivered = distinct devices of the platform that checked in after the
//               push was created (they RECEIVED it in a check-in response)
//   updated   = devices that reported running the pushed target version (ack)

app.get('/pushes', async (c) => {
  try {
    await requireAdminWrap(c)

    const pushes = await db.updatePush.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        appVersion: { select: { id: true, version: true, versionCode: true, isPublished: true, fileName: true } },
        acknowledgements: { select: { deviceId: true } },
      },
      take: 100,
    })

    const devices = await db.appDevice.findMany({
      select: { id: true, platform: true, lastActiveAt: true },
    })

    const enriched = pushes.map((p) => {
      const delivered = devices.filter(
        (d) => d.platform === p.platform && d.lastActiveAt >= p.createdAt
      ).length
      return {
        id: p.id,
        platform: p.platform,
        isMandatory: p.isMandatory,
        message: p.message,
        messageAr: p.messageAr,
        messageFr: p.messageFr,
        status: p.status,
        createdBy: p.createdBy,
        createdAt: p.createdAt,
        appVersion: p.appVersion,
        deliveredCount: delivered,
        updatedCount: p.acknowledgements.length,
      }
    })

    return c.json({ success: true, pushes: enriched })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /app-installs/pushes — create a push campaign

app.post('/pushes', async (c) => {
  try {
    const session = await requireAdminWrap(c)
    const body = await c.req.json().catch(() => null)
    const parsed = createPushSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'Invalid input', details: parsed.error.issues }, 400)
    }
    const data = parsed.data

    const appVersion = await db.appVersion.findUnique({ where: { id: data.appVersionId } })
    if (!appVersion) {
      return c.json({ success: false, error: 'Target version not found' }, 404)
    }
    if (appVersion.platform !== data.platform) {
      return c.json({ success: false, error: 'Version does not belong to the selected platform' }, 400)
    }

    // Pusher can target ANY of the last uploaded installers — drafts included
    // (devices still on old builds must be reachable, and a rebuild of the
    // same version may not have been published yet). A push must DELIVER a
    // downloadable installer, so a DRAFT target is published here. This does
    // NOT shift the platform's active download (public/active picks the
    // HIGHEST published versionCode — an older pushed draft stays passive).
    if (!appVersion.isPublished) {
      await db.appVersion.update({
        where: { id: appVersion.id },
        data: { isPublished: true, publishedAt: appVersion.publishedAt ?? new Date() },
      })
    }

    const push = await db.updatePush.create({
      data: {
        platform: data.platform,
        appVersionId: data.appVersionId,
        isMandatory: data.isMandatory,
        message: data.message,
        messageAr: data.messageAr ?? null,
        messageFr: data.messageFr ?? null,
        createdBy: typeof session === 'object' && session && 'id' in session ? String((session as any).id) : null,
      },
      include: { appVersion: true },
    })

    return c.json({ success: true, push }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /app-installs/pushes/:id/cancel — stop delivering a push

app.post('/pushes/:id/cancel', async (c) => {
  try {
    await requireAdminWrap(c)
    const existing = await db.updatePush.findUnique({ where: { id: c.req.param('id') } })
    if (!existing) return c.json({ success: false, error: 'Push not found' }, 404)
    const push = await db.updatePush.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
    })
    return c.json({ success: true, push })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /app-installs/pushes/:id/reactivate — resume delivering a push

app.post('/pushes/:id/reactivate', async (c) => {
  try {
    await requireAdminWrap(c)
    const existing = await db.updatePush.findUnique({ where: { id: c.req.param('id') } })
    if (!existing) return c.json({ success: false, error: 'Push not found' }, 404)
    const push = await db.updatePush.update({
      where: { id: existing.id },
      data: { status: 'ACTIVE' },
    })
    return c.json({ success: true, push })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /app-installs/pushes/:id — delete a push record

app.delete('/pushes/:id', async (c) => {
  try {
    await requireAdminWrap(c)
    const existing = await db.updatePush.findUnique({ where: { id: c.req.param('id') } })
    if (!existing) return c.json({ success: false, error: 'Push not found' }, 404)
    await db.updatePush.delete({ where: { id: existing.id } })
    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const appInstallRoutes = app
