// ─── staff-analytics.ts (Task 54-a — AGENCY STAFF analytics, doc-2 §29-37) ──
//
// Mounted at /api/staff/analytics (registered in index.ts as
//   app.route('/api/staff/analytics', staffAnalyticsRoutes)
// so the routes below resolve to /api/staff/analytics/<section>).
//
// AUTHORIZATION (spec §29, §47, §55 — server-side enforcement, hiding nav is
// NOT sufficient):
//   1. requireAuth — anonymous → 401.
//   2. The caller MUST hold an ACTIVE AgencyStaff row (userId + isActive) —
//      owners have NO AgencyStaff row and SUPER_ADMINs have none either, so
//      both get 403 FORBIDDEN here. This is deliberate: staff analytics are
//      the operational subset, not a reduced copy of owner analytics.
//   3. The AgencyStaff row must carry canViewAnalytics (default true, live DB
//      check on every request — prevents stale-JWT privilege escalation) →
//      otherwise 403 PERMISSION_DENIED:canViewAnalytics.
//   4. DATA SCOPE (spec §4 — scope BEFORE aggregation): every reservation
//      query is scoped to the staff member's agency, restricted to their
//      assigned branch (AgencyStaff.branchId → Counter.branchId) and their
//      assigned counters (Counter.staffId → AgencyStaff.id) where the data
//      model allows attribution. Uncalled tickets carry NO branch/counter in
//      the schema (Reservation has no branchId), so live-queue lists are
//      agency-wide and the payload says so via `scope.note`.
//
// Sections (§30): my-overview, today-queue, my-performance, my-services.
// Restricted analytics (§37 — financial/subscription/platform) simply have NO
// endpoint here: a staff member cannot GET /api/admin/analytics/payments or
// /api/agency/analytics/payments because requireAdmin / the owner scope check
// reject them.

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import {
  aggregateReservations,
  groupReservationStats,
  resolvePeriodFromQuery,
  resolvedWindowPayload,
} from '../lib/analytics-engine'
import { round1, utcHourKey } from '../lib/analytics-dashboard'

const app = new Hono()

interface StaffScope {
  staffId: string
  agencyId: string
  branchId: string | null
  role: string
}

/**
 * Resolve the caller's staff scope. Returns ok:false with a ready-to-send
 * status/message when the caller is not analytics-authorized staff.
 */
async function resolveStaffScope(c: Parameters<typeof requireAuth>[0]): Promise<{ ok: true; scope: StaffScope } | { ok: false; status: number; message: string }> {
  const user = await requireAuth(c)

  const staffRow = await db.agencyStaff.findFirst({
    where: { userId: user.id, isActive: true },
    select: { id: true, agencyId: true, branchId: true, role: true, canViewAnalytics: true },
  })

  if (!staffRow) {
    // No active staff row → not a staff member (owners/admins/customers all
    // land here). Distinct error string so the UI can tell it apart.
    return { ok: false, status: 403, message: 'FORBIDDEN' }
  }
  if (!staffRow.canViewAnalytics) {
    return { ok: false, status: 403, message: 'PERMISSION_DENIED:canViewAnalytics' }
  }

  return {
    ok: true,
    scope: {
      staffId: staffRow.id,
      agencyId: staffRow.agencyId,
      branchId: staffRow.branchId,
      role: staffRow.role,
    },
  }
}

/**
 * Fetch reservations for the staff member's operational scope:
 *   - agency must match the staff row's agency,
 *   - assigned branch → only reservations served at counters OF THAT branch,
 *   - assigned counters (Counter.staffId = this staff row) narrow further when
 *     branch attribution is not requested.
 * joinedAt inside the resolved window (spec §4 — scope BEFORE aggregation).
 */
async function fetchStaffScopedRows(c: Parameters<typeof requireAuth>[0], scope: StaffScope, rangeStart: Date, rangeEnd: Date, liveOnly = false) {
  const counterWhere: Record<string, unknown> = { branch: { agencyId: scope.agencyId } }
  if (scope.branchId) counterWhere.branchId = scope.branchId

  const myCounters = await db.counter.findMany({
    where: { staffId: scope.staffId, isActive: true },
    select: { id: true, branchId: true },
  })
  const myCounterIds = myCounters.map((ct) => ct.id)

  const where: Record<string, unknown> = {
    agencyId: scope.agencyId,
    joinedAt: { gte: rangeStart, lte: rangeEnd },
    OR: [
      { counter: counterWhere },
      ...(myCounterIds.length > 0 ? [{ counterId: { in: myCounterIds } }] : []),
    ],
  }
  if (liveOnly) where.status = { in: ['WAITING', 'CALLED', 'SERVING'] }
  const status = c.req.query('status')
  if (status && !liveOnly) where.status = status

  return db.reservation.findMany({
    where,
    select: {
      id: true,
      status: true,
      joinedAt: true,
      calledAt: true,
      completedAt: true,
      cancelledAt: true,
      isWalkIn: true,
      userId: true,
      serviceId: true,
      counterId: true,
      agencyId: true,
      displayNumber: true,
    },
  })
}

function staffPeriodError(c: Parameters<typeof requireAuth>[0], message: string) {
  return c.json({ success: false, error: message }, 400)
}

// GET /api/staff/analytics/my-overview — §31 My Overview (TODAY).
app.get('/my-overview', async (c) => {
  try {
    const resolved = await resolveStaffScope(c)
    if (!resolved.ok) return c.json({ success: false, error: resolved.message }, resolved.status as any)
    const scope = resolved.scope

    const now = new Date()
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))

    const [todayRows, liveRows] = await Promise.all([
      fetchStaffScopedRows(c, scope, todayStart, todayEnd),
      db.reservation.findMany({
        where: { agencyId: scope.agencyId, status: { in: ['WAITING', 'CALLED', 'SERVING'] } },
        select: { id: true, status: true, joinedAt: true, displayNumber: true },
      }),
    ])

    const agg = aggregateReservations(todayRows, resolvePeriodRangeForToday(todayStart, todayEnd))
    const live = { WAITING: 0, CALLED: 0, SERVING: 0 }
    for (const r of liveRows) {
      if (r.status === 'WAITING') live.WAITING++
      if (r.status === 'CALLED') live.CALLED++
      if (r.status === 'SERVING') live.SERVING++
    }

    // Completion rate over finished tickets only (completed vs cancelled/no-show).
    const finished = agg.kpis.completed + agg.kpis.cancelled + agg.kpis.noShow

    return c.json({
      success: true,
      data: {
        scope: { branchId: scope.branchId, role: scope.role, note: 'live queue counts are agency-wide (uncalled tickets carry no branch in the data model)' },
        today: {
          ticketsServed: agg.kpis.completed,
          reservationsHandled: agg.kpis.total,
          completed: agg.kpis.completed,
          cancelled: agg.kpis.cancelled,
          noShow: agg.kpis.noShow,
          completionRate: finished > 0 ? round1((agg.kpis.completed / finished) * 100) : 0,
          avgWaitingTimeMinutes: agg.kpis.avgWaitMinutes,
          avgServiceDurationMinutes: agg.kpis.avgServiceMinutes,
          currentlyServing: live.SERVING,
          waitingCount: live.WAITING,
          calledCount: live.CALLED,
          statusDistribution: agg.statusDistribution,
        },
        hourlyTraffic: agg.hourlyTraffic,
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

/** Synthetic today-range for aggregateReservations (hourly granularity). */
function resolvePeriodRangeForToday(todayStart: Date, todayEnd: Date) {
  const bucketKeys: string[] = []
  const cursor = new Date(todayStart)
  while (cursor.getTime() <= todayEnd.getTime()) {
    bucketKeys.push(utcHourKey(cursor))
    cursor.setUTCHours(cursor.getUTCHours() + 1)
  }
  return {
    period: 'today' as const,
    start: todayStart,
    end: todayEnd,
    previousStart: new Date(todayStart.getTime() - 24 * 3600e3),
    previousEnd: todayStart,
    granularity: 'hourly' as const,
    bucketKeys,
    from: todayStart.toISOString(),
    to: todayEnd.toISOString(),
  }
}

// GET /api/staff/analytics/today-queue — §32 Today's Queue (operational).
app.get('/today-queue', async (c) => {
  try {
    const resolved = await resolveStaffScope(c)
    if (!resolved.ok) return c.json({ success: false, error: resolved.message }, resolved.status as any)
    const scope = resolved.scope

    const now = new Date()
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))

    const [agency, queueSettings, waitingRows, todayRows] = await Promise.all([
      db.agency.findUnique({ where: { id: scope.agencyId }, select: { isQueueOpen: true } }),
      db.queueSettings.findFirst({ where: { agencyId: scope.agencyId }, select: { isPaused: true, pausedAt: true, currentServingNumber: true, lastIssuedNumber: true } }),
      db.reservation.findMany({
        where: { agencyId: scope.agencyId, status: { in: ['WAITING', 'CALLED', 'SERVING'] } },
        select: { id: true, displayNumber: true, status: true, joinedAt: true, calledAt: true },
        orderBy: { joinedAt: 'asc' },
      }),
      fetchStaffScopedRows(c, scope, todayStart, todayEnd),
    ])

    const counts = { WAITING: 0, CALLED: 0, SERVING: 0 }
    let waitSumMs = 0
    for (const r of waitingRows) {
      if (r.status === 'WAITING') {
        counts.WAITING++
        waitSumMs += now.getTime() - r.joinedAt.getTime()
      }
      if (r.status === 'CALLED') counts.CALLED++
      if (r.status === 'SERVING') counts.SERVING++
    }
    const nextTicket = waitingRows.find((r) => r.status === 'WAITING') ?? null
    const serving = waitingRows.find((r) => r.status === 'SERVING') ?? null
    const called = waitingRows.filter((r) => r.status === 'CALLED')

    const completedToday = todayRows.filter((r) => r.status === 'COMPLETED').length
    const noShowsToday = todayRows.filter((r) => r.status === 'NO_SHOW').length

    return c.json({
      success: true,
      data: {
        scope: { branchId: scope.branchId, note: 'waiting/called lists are agency-wide; served counts respect your branch/counter scope' },
        queueStatus: {
          isQueueOpen: agency?.isQueueOpen ?? false,
          isPaused: queueSettings?.isPaused ?? false,
          pausedAt: queueSettings?.pausedAt?.toISOString() ?? null,
          currentServingNumber: queueSettings?.currentServingNumber ?? 0,
          lastIssuedNumber: queueSettings?.lastIssuedNumber ?? 0,
        },
        live: {
          queueLength: counts.WAITING,
          currentlyWaiting: counts.WAITING,
          currentlyCalled: counts.CALLED,
          servingCustomer: serving ? { id: serving.id, displayNumber: serving.displayNumber, joinedAt: serving.joinedAt.toISOString() } : null,
          nextTicket: nextTicket ? { id: nextTicket.id, displayNumber: nextTicket.displayNumber, joinedAt: nextTicket.joinedAt.toISOString() } : null,
          calledTickets: called.map((r) => ({ id: r.id, displayNumber: r.displayNumber, calledAt: r.calledAt?.toISOString() ?? null })),
          avgCurrentWaitMinutes: counts.WAITING > 0 ? round1(waitSumMs / counts.WAITING / 60000) : null,
        },
        today: {
          ticketsCompleted: completedToday,
          noShows: noShowsToday,
        },
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /api/staff/analytics/my-performance — §33 My Performance (period).
app.get('/my-performance', async (c) => {
  try {
    const resolved = await resolveStaffScope(c)
    if (!resolved.ok) return c.json({ success: false, error: resolved.message }, resolved.status as any)
    const scope = resolved.scope

    const pq = resolvePeriodFromQuery(c, '30d')
    if (!pq.ok) return staffPeriodError(c, pq.message)

    const rows = await fetchStaffScopedRows(c, scope, pq.range.start, pq.range.end)
    const agg = aggregateReservations(rows, pq.range)

    const myCounters = await db.counter.findMany({ where: { staffId: scope.staffId }, select: { id: true, name: true, branchId: true } })
    const myCounterIds = new Set(myCounters.map((ct) => ct.id))

    const byCounter = groupReservationStats(rows, (r) => r.counterId)
      .filter((s) => myCounterIds.has(s.key))
      .map((s) => ({
        counterId: s.key,
        name: myCounters.find((ct) => ct.id === s.key)?.name ?? 'Unknown counter',
        served: s.completed,
        avgServiceMinutes: s.avgServiceMinutes,
      }))

    const serviceNameRows = await db.service.findMany({ where: { agencyId: scope.agencyId }, select: { id: true, name: true } })
    const serviceName = new Map(serviceNameRows.map((s) => [s.id, s.name]))
    const byService = groupReservationStats(rows, (r) => r.serviceId)
      .map((s) => ({ serviceId: s.key, name: serviceName.get(s.key) ?? 'Unknown', ...s }))
      .sort((a, b) => b.count - a.count)

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        scope: { branchId: scope.branchId, role: scope.role },
        kpis: {
          ticketsCalled: rows.filter((r) => r.calledAt !== null).length,
          ticketsServed: agg.kpis.completed,
          completed: agg.kpis.completed,
          cancelled: agg.kpis.cancelled,
          noShow: agg.kpis.noShow,
          completionRate: agg.kpis.completionRate,
          avgHandlingTimeMinutes: agg.kpis.avgServiceMinutes,
          avgServiceDurationMinutes: agg.kpis.avgServiceMinutes,
          medianServiceDurationMinutes: agg.kpis.medianServiceMinutes,
          avgWaitingTimeMinutes: agg.kpis.avgWaitMinutes,
          customersPerHour: agg.kpis.customersPerHour,
        },
        statusDistribution: agg.statusDistribution,
        timeseries: agg.timeseries,
        byCounter,
        byService,
        peak: agg.peak,
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /api/staff/analytics/my-services — §34 My Services (assigned scope).
app.get('/my-services', async (c) => {
  try {
    const resolved = await resolveStaffScope(c)
    if (!resolved.ok) return c.json({ success: false, error: resolved.message }, resolved.status as any)
    const scope = resolved.scope

    const pq = resolvePeriodFromQuery(c, '30d')
    if (!pq.ok) return staffPeriodError(c, pq.message)

    const [rows, serviceRows] = await Promise.all([
      fetchStaffScopedRows(c, scope, pq.range.start, pq.range.end),
      db.service.findMany({ where: { agencyId: scope.agencyId, isActive: true }, select: { id: true, name: true, prefix: true } }),
    ])

    const stats = groupReservationStats(rows, (r) => r.serviceId)
    const statsByService = new Map(stats.map((s) => [s.key, s]))

    const services = serviceRows.map((s) => {
      const st = statsByService.get(s.id)
      return {
        serviceId: s.id,
        name: s.name,
        prefix: s.prefix,
        reservations: st?.count ?? 0,
        completed: st?.completed ?? 0,
        cancelled: st?.cancelled ?? 0,
        noShow: st?.noShow ?? 0,
        avgWaitMinutes: st?.avgWaitMinutes ?? null,
        avgServiceMinutes: st?.avgServiceMinutes ?? null,
        demand: st?.count ?? 0,
      }
    }).sort((a, b) => b.reservations - a.reservations || a.name.localeCompare(b.name))

    const agg = aggregateReservations(rows, pq.range)

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        scope: { branchId: scope.branchId },
        totals: { services: serviceRows.length, reservationsInScope: agg.kpis.total },
        services,
        peakHours: agg.hourlyTraffic,
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const staffAnalyticsRoutes = app
