/**
 * Counter CONTROL (live operator claim) — Feature C.
 *
 * Model: exactly ONE agency account controls a counter at a time.
 *  - Claim   (POST /counters/:id/occupy)          — atomic; stale claims (no
 *    heartbeat within CONTROL_TTL_MS) are automatically takeable.
 *  - Release (POST /counters/:id/release)         — controller themself, or a
 *    force-release by the agency owner / branch MANAGER / SUPER_ADMIN.
 *  - Heartbeat (POST /counters/:id/heartbeat)     — controller pings every
 *    CONTROL_HEARTBEAT_INTERVAL_MS; the sweeper frees counters whose
 *    heartbeat went stale (logout / app close / crash).
 *  - Request  (POST /counters/:id/request-control) — when another account
 *    controls the counter the claimant files a CounterControlRequest; the
 *    controller APPROVES/REJECTS it (owner / branch MANAGER bypass approval
 *    via transfer-control).
 *
 * Every mutation fires a recordSyncChangeNow (desktop sync) + an
 * emitAgencyEvent (realtime) so every workstation sees the state change.
 */
import { db } from '@blasti/db'
import { recordSyncChangeNow } from './sync-helpers'

/** How often a controlling client must heartbeat (ms). */
export const CONTROL_HEARTBEAT_INTERVAL_MS = 60_000
/** Controls without a heartbeat for longer than this are freed by the sweeper. */
export const CONTROL_TTL_MS = 3 * 60_000

/** Field set written when a counter loses control. `occupiedAt` is the legacy Task 37-c stamp. */
export const CONTROL_FREE_DATA = {
  controlledByUserId: null,
  controlledByStaffId: null,
  controlClaimedAt: null,
  controlHeartbeatAt: null,
  occupiedAt: null,
} as const

/** Counter fields selected for control decisions. */
const CONTROL_SELECT = {
  id: true,
  number: true,
  name: true,
  isActive: true,
  branchId: true,
  serviceIds: true,
  controlledByUserId: true,
  controlledByStaffId: true,
  controlClaimedAt: true,
  controlHeartbeatAt: true,
} as const

export type ControlledCounter = {
  id: string
  number: number
  name: string
  isActive: boolean
  branchId: string
  serviceIds: string | null
  controlledByUserId: string | null
  controlledByStaffId: string | null
  controlClaimedAt: Date | null
  controlHeartbeatAt: Date | null
}

/** Parse the counter→service assignment JSON (null/invalid/empty = all services). */
export function parseCounterServiceIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Stale cutoff for takeover eligibility. */
function staleCutoff(): Date {
  return new Date(Date.now() - CONTROL_TTL_MS)
}

/** Who currently controls the counter (for 409 bodies + UI display). */
export async function getControlledByInfo(
  counter: Pick<ControlledCounter, 'controlledByUserId' | 'controlledByStaffId'>,
): Promise<{ userId: string | null; name: string | null; staffId: string | null }> {
  if (!counter.controlledByUserId) {
    return { userId: null, name: null, staffId: counter.controlledByStaffId ?? null }
  }
  const user = await db.user.findUnique({
    where: { id: counter.controlledByUserId },
    select: { fullName: true, username: true },
  })
  return {
    userId: counter.controlledByUserId,
    name: user?.fullName || user?.username || null,
    staffId: counter.controlledByStaffId ?? null,
  }
}

/**
 * Is `userId` still a valid agency member (owner or active staff)? Used to
 * auto-free counters controlled by accounts that lost membership.
 */
async function isStillMember(userId: string, agencyId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isActive: true, role: true } })
  if (!user || !user.isActive) return false
  if (user.role === 'SUPER_ADMIN') return true
  const authority = await db.agency.findFirst({ where: { id: agencyId, ownerId: userId }, select: { id: true } })
  if (authority) return true
  const staff = await db.agencyStaff.findFirst({
    where: { userId, agencyId, isActive: true },
    select: { id: true },
  })
  return !!staff
}

export type ClaimControlResult =
  | { ok: true; counter: ControlledCounter; refreshed: boolean }
  | {
      ok: false
      status: 409 | 404 | 403
      error: string
      controlledBy?: { userId: string | null; name: string | null }
    }

/**
 * ATOMIC claim of counter control.
 *  - Free counter (or stale/invalid control) → claimed.
 *  - Already mine → heartbeat refresh (refreshed: true).
 *  - Held by another live member → 409 COUNTER_CONTROLLED (+ who).
 */
export async function claimCounterControl(params: {
  counterId: string
  agencyId: string
  userId: string
  staffId?: string | null
}): Promise<ClaimControlResult> {
  const { counterId, agencyId, userId, staffId } = params

  const counter = (await db.counter.findFirst({
    where: { id: counterId, branch: { agencyId } },
    select: CONTROL_SELECT,
  }))
  if (!counter) return { ok: false, status: 404, error: 'Counter not found' }
  if (!counter.isActive) return { ok: false, status: 403, error: 'Counter is inactive' }

  const now = new Date()
  const mine = counter.controlledByUserId === userId
  const free = !counter.controlledByUserId
  const stale =
    !!counter.controlledByUserId &&
    (!counter.controlHeartbeatAt || counter.controlHeartbeatAt < staleCutoff())

  // Controlled by someone else whose membership ended → treat as free.
  let invalidController = false
  if (counter.controlledByUserId && !mine && !stale) {
    invalidController = !(await isStillMember(counter.controlledByUserId, agencyId))
  }

  if (!mine && !free && !stale && !invalidController) {
    const controlledBy = await getControlledByInfo(counter)
    return { ok: false, status: 409, error: 'COUNTER_CONTROLLED', controlledBy }
  }

  // Auto-free an invalid controller record before claiming (edge case).
  if (invalidController) {
    await db.counter.updateMany({ where: { id: counter.id }, data: { ...CONTROL_FREE_DATA } })
  }

  const claimed = await db.counter.updateMany({
    where: {
      id: counter.id,
      OR: [{ controlledByUserId: null }, { controlledByUserId: userId }, { controlHeartbeatAt: { lt: staleCutoff() } }],
    },
    data: {
      controlledByUserId: userId,
      controlledByStaffId: staffId ?? null,
      controlClaimedAt: now,
      controlHeartbeatAt: now,
      // legacy mirror so older clients still render an occupied state
      occupiedAt: now,
    },
  })
  if (claimed.count === 0) {
    // Lost a race against another claimant — re-read for the 409 body.
    const fresh = (await db.counter.findUnique({ where: { id: counter.id }, select: CONTROL_SELECT }))!
    const controlledBy = await getControlledByInfo(fresh)
    return { ok: false, status: 409, error: 'COUNTER_CONTROLLED', controlledBy }
  }

  const updated = (await db.counter.findUnique({
    where: { id: counter.id },
    select: CONTROL_SELECT,
  })) as ControlledCounter

  await recordSyncChangeNow({ agencyId, model: 'Counter', recordId: counter.id, operation: 'update' })
  return { ok: true, counter: updated, refreshed: mine }
}

/** Atomic release. `force` bypasses the ownership check (owner/manager/admin paths pre-authorize). */
export async function releaseCounterControl(params: {
  counterId: string
  agencyId: string
  userId: string
  force?: boolean
}): Promise<{ ok: true; counterId: string } | { ok: false; status: 403 | 404; error: string }> {
  const { counterId, agencyId, userId, force } = params
  const counter = await db.counter.findFirst({
    where: { id: counterId, branch: { agencyId } },
    select: { id: true, controlledByUserId: true },
  })
  if (!counter) return { ok: false, status: 404, error: 'Counter not found' }
  if (counter.controlledByUserId && counter.controlledByUserId !== userId && !force) {
    return { ok: false, status: 403, error: 'NOT_COUNTER_CONTROLLER' }
  }
  await db.counter.updateMany({ where: { id: counter.id }, data: { ...CONTROL_FREE_DATA } })
  await recordSyncChangeNow({ agencyId, model: 'Counter', recordId: counter.id, operation: 'update' })
  return { ok: true, counterId: counter.id }
}

/** Heartbeat — refreshes control liveness. 409 when control was lost. */
export async function counterControlHeartbeat(params: {
  counterId: string
  agencyId: string
  userId: string
}): Promise<{ ok: true; counterId: string } | { ok: false; status: 403 | 404; error: string }> {
  const { counterId, agencyId, userId } = params
  const counter = await db.counter.findFirst({
    where: { id: counterId, branch: { agencyId } },
    select: { id: true, controlledByUserId: true },
  })
  if (!counter) return { ok: false, status: 404, error: 'Counter not found' }
  if (counter.controlledByUserId !== userId) {
    return { ok: false, status: 403, error: 'COUNTER_CONTROL_LOST' }
  }
  const updated = await db.counter.updateMany({
    where: { id: counter.id, controlledByUserId: userId },
    data: { controlHeartbeatAt: new Date() },
  })
  if (updated.count === 0) return { ok: false, status: 403, error: 'COUNTER_CONTROL_LOST' }
  return { ok: true, counterId: counter.id }
}

export type CounterControlGate =
  | { ok: true; controlledCounter: { id: string; serviceIds: string[] } | null }
  | { ok: false; status: 403; error: string }

/**
 * THE queue gate (Feature C): nobody performs the queue without controlling a
 * counter, and nothing can be performed at all until a counter is set up.
 *  - COUNTER_SETUP_REQUIRED    — the agency has no ACTIVE counter configured.
 *  - PERMISSION_DENIED:canManageQueue — staff without the queue authority.
 *  - COUNTER_CONTROL_REQUIRED  — counters exist but the caller controls none.
 *  - When counterId is passed it MUST be the caller's controlled counter.
 * Returns the caller's controlled counter (id + assigned services) so the
 * queue routes can scope the claim — and use it when the request omitted one.
 * SUPER_ADMIN keeps the historic bypass.
 */
export async function enforceCounterControlGate(
  user: { id: string; role: string },
  agencyId: string,
  counterId?: string | null,
  canManageQueue = true,
): Promise<CounterControlGate> {
  if (user.role === 'SUPER_ADMIN') {
    if (!counterId) return { ok: true, controlledCounter: null }
    const c = await db.counter.findFirst({
      where: { id: counterId, branch: { agencyId } },
      select: { id: true, serviceIds: true },
    })
    return c
      ? { ok: true, controlledCounter: { id: c.id, serviceIds: parseCounterServiceIds(c.serviceIds) } }
      : { ok: true, controlledCounter: null }
  }

  if (!canManageQueue) return { ok: false, status: 403, error: 'PERMISSION_DENIED:canManageQueue' }

  const activeCounters = await db.counter.count({
    where: { branch: { agencyId }, isActive: true },
  })
  if (activeCounters === 0) return { ok: false, status: 403, error: 'COUNTER_SETUP_REQUIRED' }

  const controlled = await db.counter.findFirst({
    where: { controlledByUserId: user.id, branch: { agencyId }, isActive: true },
    select: { id: true, serviceIds: true },
  })
  if (!controlled) return { ok: false, status: 403, error: 'COUNTER_CONTROL_REQUIRED' }
  if (counterId && counterId !== controlled.id) {
    return { ok: false, status: 403, error: 'COUNTER_CONTROL_REQUIRED' }
  }
  return { ok: true, controlledCounter: { id: controlled.id, serviceIds: parseCounterServiceIds(controlled.serviceIds) } }
}

/** Can this user bypass the approval flow for counters in this agency/branch? Owner, branch MANAGER or SUPER_ADMIN. */
export async function canBypassCounterApproval(
  user: { id: string; role: string },
  agencyId: string,
  branchId?: string | null,
): Promise<boolean> {
  if (user.role === 'SUPER_ADMIN') return true
  const owned = await db.agency.findFirst({ where: { id: agencyId, ownerId: user.id }, select: { id: true } })
  if (owned) return true
  const manager = await db.agencyStaff.findFirst({
    where: {
      userId: user.id,
      agencyId,
      isActive: true,
      role: 'MANAGER',
      ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
    },
    select: { id: true },
  })
  return !!manager
}

/** Is this user an active member of the agency (owner, active staff, or SUPER_ADMIN)? */
export async function isUserActiveMember(userId: string, agencyId: string): Promise<boolean> {
  return isStillMember(userId, agencyId)
}

/**
 * Atomic control transfer (approval path + owner/manager manual grant).
 * `expectFromUserId` guards the approval path — the transfer only lands if
 * control is still held by the account that approved. Emits sync + audit.
 */
export async function transferCounterControl(params: {
  counterId: string
  agencyId: string
  toUserId: string
  toStaffId?: string | null
  actorUserId?: string | null
  expectFromUserId?: string | null
}): Promise<{ ok: true; counter: ControlledCounter } | { ok: false; status: 409 | 404; error: string }> {
  const { counterId, agencyId, toUserId, toStaffId, actorUserId, expectFromUserId } = params
  const counter = await db.counter.findFirst({
    where: { id: counterId, branch: { agencyId } },
    select: { id: true, controlledByUserId: true },
  })
  if (!counter) return { ok: false, status: 404, error: 'Counter not found' }
  if (expectFromUserId && counter.controlledByUserId !== expectFromUserId) {
    return { ok: false, status: 409, error: 'COUNTER_CONTROL_CHANGED' }
  }

  const now = new Date()
  const updated = await db.counter.updateMany({
    where: {
      id: counter.id,
      ...(counter.controlledByUserId
        ? { controlledByUserId: counter.controlledByUserId }
        : { controlledByUserId: null }),
    },
    data: {
      controlledByUserId: toUserId,
      controlledByStaffId: toStaffId ?? null,
      controlClaimedAt: now,
      controlHeartbeatAt: now,
      occupiedAt: now,
    },
  })
  if (updated.count === 0) return { ok: false, status: 409, error: 'COUNTER_CONTROL_CHANGED' }

  const fresh = (await db.counter.findUnique({
    where: { id: counter.id },
    select: CONTROL_SELECT,
  })) as ControlledCounter
  await recordSyncChangeNow({ agencyId, model: 'Counter', recordId: counter.id, operation: 'update' })
  if (actorUserId) {
    try {
      await db.auditLog.create({
        data: {
          action: 'COUNTER_CONTROL_TRANSFER',
          entityType: 'COUNTER',
          entityId: counter.id,
          details: JSON.stringify({ agencyId, toUserId, actorUserId }),
        },
      })
    } catch {
      // audit is best-effort — never block the transfer
    }
  }
  return { ok: true, counter: fresh }
}

/** Release EVERY counter controlled by the user (logout / app close). Returns affected agency ids. */
export async function releaseAllUserControl(userId: string): Promise<string[]> {
  const held = await db.counter.findMany({
    where: { controlledByUserId: userId },
    select: { id: true, branch: { select: { agencyId: true } } },
  })
  for (const counter of held) {
    await db.counter.updateMany({ where: { id: counter.id }, data: { ...CONTROL_FREE_DATA } })
    await recordSyncChangeNow({
      agencyId: counter.branch.agencyId,
      model: 'Counter',
      recordId: counter.id,
      operation: 'update',
    })
  }
  return [...new Set(held.map((c) => c.branch.agencyId))]
}

/** Sweeper pass — free counters whose control heartbeat went stale. Returns freed count. */
export async function sweepStaleCounterControl(): Promise<number> {
  const stale = await db.counter.findMany({
    where: {
      controlledByUserId: { not: null },
      OR: [
        { controlHeartbeatAt: { lt: staleCutoff() } },
        { controlHeartbeatAt: null, controlClaimedAt: { lt: staleCutoff() } },
      ],
    },
    select: { id: true, number: true, controlledByUserId: true, branch: { select: { agencyId: true } } },
  })
  for (const counter of stale) {
    await db.counter.updateMany({ where: { id: counter.id }, data: { ...CONTROL_FREE_DATA } })
    await recordSyncChangeNow({
      agencyId: counter.branch.agencyId,
      model: 'Counter',
      recordId: counter.id,
      operation: 'update',
    })
  }
  return stale.length
}
