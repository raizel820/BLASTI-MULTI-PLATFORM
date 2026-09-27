// ─── customer-analytics.ts (Task 54-a — CUSTOMER analytics, doc-2 §38-44) ───
//
// Mounted at /api/customer/analytics (registered in index.ts as
//   app.route('/api/customer/analytics', customerAnalyticsRoutes)
// so the routes below resolve to /api/customer/analytics/<section>).
//
// AUTHORIZATION (spec §38, §47, §55):
//   1. requireAuth — anonymous → 401.
//   2. role MUST be CUSTOMER — any other role (SUPER_ADMIN / AGENCY_OWNER /
//      AGENCY_STAFF) gets 403 FORBIDDEN. Owner/staff have their own analytics
//      modules; customer analytics are strictly personal.
//   3. DATA SCOPE (§4, §57): every query filters by the CALLER's own userId
//      BEFORE aggregation. A customer cannot see platform analytics, agency
//      analytics, other customers' statistics, or financial data — those
//      endpoints simply do not exist here and the role gate rejects the
//      admin/owner/staff modules.
//
// Sections (§39): my-overview, my-reservations, my-queue-history,
// my-activity, my-ratings.

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import {
  aggregateReservations,
  aggregateRatings,
  groupReservationStats,
  resolvePeriodFromQuery,
  resolvedWindowPayload,
} from '../lib/analytics-engine'
import { round1 } from '../lib/analytics-dashboard'

const app = new Hono()

/** requireAuth + strict CUSTOMER role (§38 — personal scope only). */
async function requireCustomer(c: Parameters<typeof requireAuth>[0]): Promise<{ ok: true; userId: string } | { ok: false; status: number; message: string }> {
  const user = await requireAuth(c)
  if (user.role !== 'CUSTOMER') {
    return { ok: false, status: 403, message: 'FORBIDDEN' }
  }
  return { ok: true, userId: user.id }
}

/** The caller's own reservation rows (ALL-TIME by default; window when given). */
async function fetchMyReservations(userId: string, rangeStart?: Date, rangeEnd?: Date) {
  const joinedAt: Record<string, Date> = {}
  if (rangeStart) joinedAt.gte = rangeStart
  if (rangeEnd) joinedAt.lte = rangeEnd
  return db.reservation.findMany({
    where: {
      userId,
      ...(rangeStart || rangeEnd ? { joinedAt } : {}),
    },
    select: {
      id: true,
      status: true,
      joinedAt: true,
      calledAt: true,
      completedAt: true,
      cancelledAt: true,
      rating: true,
      isWalkIn: true,
      fixedTimeEnabled: true,
      serviceId: true,
      agencyId: true,
      reservedDate: true,
      displayNumber: true,
    },
    orderBy: { joinedAt: 'desc' },
  })
}

// GET /api/customer/analytics/my-overview — §40 My Overview.
app.get('/my-overview', async (c) => {
  try {
    const me = await requireCustomer(c)
    if (!me.ok) return c.json({ success: false, error: me.message }, me.status as any)
    const userId = me.userId

    const pq = resolvePeriodFromQuery(c, '30d')
    if (!pq.ok) return c.json({ success: false, error: pq.message }, 400)

    const [rows, favoriteCount, agenciesUsed, servicesUsed] = await Promise.all([
      fetchMyReservations(userId),
      db.favorite.count({ where: { userId } }),
      db.reservation.findMany({ where: { userId }, select: { agencyId: true }, distinct: ['agencyId'] }),
      db.reservation.findMany({ where: { userId }, select: { serviceId: true }, distinct: ['serviceId'] }),
    ])

    // Upcoming = still active OR future-dated (fixed/preferred-time bookings).
    const now = new Date()
    const upcoming = rows.filter((r) =>
      ['WAITING', 'CALLED', 'SERVING'].includes(r.status) ||
      (r.reservedDate !== null && new Date(`${r.reservedDate}T23:59:59.999Z`) >= now),
    ).length

    const windowRows = rows.filter((r) => r.joinedAt >= pq.range.start && r.joinedAt <= pq.range.end)
    const agg = aggregateReservations(windowRows, pq.range)

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        totals: {
          totalReservations: rows.length,
          completed: rows.filter((r) => r.status === 'COMPLETED').length,
          cancelled: rows.filter((r) => r.status === 'CANCELLED').length,
          noShow: rows.filter((r) => r.status === 'NO_SHOW').length,
          upcoming,
          favoriteAgencies: favoriteCount,
          agenciesUsed: agenciesUsed.length,
          servicesUsed: servicesUsed.length,
        },
        period: {
          reservations: agg.kpis.total,
          avgWaitingTimeMinutes: agg.kpis.avgWaitMinutes,
          avgServiceDurationMinutes: agg.kpis.avgServiceMinutes,
          timeseries: agg.timeseries,
        },
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /api/customer/analytics/my-reservations — §41 My Reservation Analytics.
app.get('/my-reservations', async (c) => {
  try {
    const me = await requireCustomer(c)
    if (!me.ok) return c.json({ success: false, error: me.message }, me.status as any)
    const userId = me.userId

    const pq = resolvePeriodFromQuery(c, '12m')
    if (!pq.ok) return c.json({ success: false, error: pq.message }, 400)

    const rows = await fetchMyReservations(userId, pq.range.start, pq.range.end)
    const agg = aggregateReservations(rows, pq.range)

    const [agencyRows, serviceRows] = await Promise.all([
      db.agency.findMany({ where: { id: { in: Array.from(new Set(rows.map((r) => r.agencyId))) } }, select: { id: true, name: true, category: true } }),
      db.service.findMany({ where: { id: { in: Array.from(new Set(rows.map((r) => r.serviceId))) } }, select: { id: true, name: true } }),
    ])
    const agencyName = new Map(agencyRows.map((a) => [a.id, a]))
    const serviceName = new Map(serviceRows.map((s) => [s.id, s.name]))

    const byAgency = groupReservationStats(rows, (r) => r.agencyId)
      .map((s) => {
        const a = agencyName.get(s.key)
        return { agencyId: s.key, name: a?.name ?? 'Unknown', category: a?.category ?? null, ...s }
      })
      .sort((x, y) => y.count - x.count)
    const byService = groupReservationStats(rows, (r) => r.serviceId)
      .map((s) => ({ serviceId: s.key, name: serviceName.get(s.key) ?? 'Unknown', ...s }))
      .sort((x, y) => y.count - x.count)

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        statusDistribution: agg.statusDistribution,
        timeseries: agg.timeseries,
        byType: {
          online: agg.kpis.onlineCount,
          walkIn: agg.kpis.walkInCount,
          fixedTime: rows.filter((r) => r.fixedTimeEnabled === true).length,
        },
        completedCancelledNoShow: {
          completed: agg.kpis.completed,
          cancelled: agg.kpis.cancelled,
          noShow: agg.kpis.noShow,
        },
        avgWaitingTimeMinutes: agg.kpis.avgWaitMinutes,
        avgServiceTimeMinutes: agg.kpis.avgServiceMinutes,
        mostUsedAgencies: byAgency.slice(0, 8),
        mostUsedServices: byService.slice(0, 8),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /api/customer/analytics/my-queue-history — §42 My Queue History.
app.get('/my-queue-history', async (c) => {
  try {
    const me = await requireCustomer(c)
    if (!me.ok) return c.json({ success: false, error: me.message }, me.status as any)
    const userId = me.userId

    const pq = resolvePeriodFromQuery(c, '12m')
    if (!pq.ok) return c.json({ success: false, error: pq.message }, 400)

    const rows = await fetchMyReservations(userId, pq.range.start, pq.range.end)

    const waits: number[] = []
    const services: number[] = []
    let completed = 0
    let noShow = 0
    let cancelled = 0
    for (const r of rows) {
      if (r.calledAt) waits.push((r.calledAt.getTime() - r.joinedAt.getTime()) / 60000)
      if (r.calledAt && r.completedAt) services.push((r.completedAt.getTime() - r.calledAt.getTime()) / 60000)
      if (r.status === 'COMPLETED') completed++
      if (r.status === 'NO_SHOW') noShow++
      if (r.status === 'CANCELLED') cancelled++
    }

    const sortedWaits = [...waits].sort((a, b) => a - b)

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        totals: {
          timesJoinedQueue: rows.length,
          completedVisits: completed,
          noShows: noShow,
          cancelledVisits: cancelled,
        },
        wait: {
          averageMinutes: waits.length > 0 ? round1(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
          longestMinutes: sortedWaits.length > 0 ? round1(sortedWaits[sortedWaits.length - 1]) : null,
          shortestMinutes: sortedWaits.length > 0 ? round1(sortedWaits[0]) : null,
        },
        service: {
          averageMinutes: services.length > 0 ? round1(services.reduce((a, b) => a + b, 0) / services.length) : null,
        },
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /api/customer/analytics/my-activity — §43 My Activity.
app.get('/my-activity', async (c) => {
  try {
    const me = await requireCustomer(c)
    if (!me.ok) return c.json({ success: false, error: me.message }, me.status as any)
    const userId = me.userId

    const pq = resolvePeriodFromQuery(c, '30d')
    if (!pq.ok) return c.json({ success: false, error: pq.message }, 400)

    const [favorites, favoriteAgencies, notificationsInPeriod, notificationsUnread, notificationsTotal, reviewsCount, reservationsInPeriod] = await Promise.all([
      db.favorite.findMany({ where: { userId }, select: { id: true, createdAt: true } }),
      db.favorite.findMany({ where: { userId }, select: { agency: { select: { id: true, name: true, category: true } } } }),
      db.notification.count({ where: { userId, createdAt: { gte: pq.range.start, lte: pq.range.end } } }),
      db.notification.count({ where: { userId, isRead: false } }),
      db.notification.count({ where: { userId } }),
      db.review.count({ where: { userId } }),
      db.reservation.count({ where: { userId, joinedAt: { gte: pq.range.start, lte: pq.range.end } } }),
    ])

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        favorites: {
          count: favorites.length,
          agencies: favoriteAgencies.map((f) => ({ agencyId: f.agency.id, name: f.agency.name, category: f.agency.category })),
          newInPeriod: favorites.filter((f) => f.createdAt >= pq.range.start && f.createdAt <= pq.range.end).length,
        },
        notifications: {
          receivedInPeriod: notificationsInPeriod,
          unread: notificationsUnread,
          total: notificationsTotal,
        },
        reviews: {
          count: reviewsCount,
        },
        reservations: {
          inPeriod: reservationsInPeriod,
        },
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /api/customer/analytics/my-ratings — §44 My Ratings & Feedback.
app.get('/my-ratings', async (c) => {
  try {
    const me = await requireCustomer(c)
    if (!me.ok) return c.json({ success: false, error: me.message }, me.status as any)
    const userId = me.userId

    const pq = resolvePeriodFromQuery(c, '12m')
    if (!pq.ok) return c.json({ success: false, error: pq.message }, 400)

    const reviews = await db.review.findMany({
      where: { userId, createdAt: { gte: pq.range.start, lte: pq.range.end } },
      select: { id: true, rating: true, comment: true, createdAt: true, agencyId: true, agency: { select: { name: true } }, reservation: { select: { serviceId: true } } },
      orderBy: { createdAt: 'desc' },
    })

    const agg = aggregateRatings(reviews)
    const agenciesReviewed = new Set(reviews.map((r) => r.agencyId)).size
    const servicesReviewed = new Set(reviews.map((r) => r.reservation?.serviceId).filter((v): v is string => Boolean(v))).size

    return c.json({
      success: true,
      data: {
        resolved: resolvedWindowPayload(pq.range),
        summary: {
          reviewsSubmitted: agg.count,
          averageRatingGiven: agg.average,
          distribution: agg.distribution,
          agenciesReviewed,
          servicesReviewed,
        },
        history: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.createdAt.toISOString(),
          agencyId: r.agencyId,
          agencyName: r.agency.name,
          serviceId: r.reservation?.serviceId ?? null,
        })),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const customerAnalyticsRoutes = app
