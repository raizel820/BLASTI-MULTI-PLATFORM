import { Hono } from 'hono'
import { randomBytes } from 'crypto'
import { db } from '@blasti/db'
import { validateBody, kioskJoinSchema } from '../lib/validations'
import { emitQueueEvent, emitKioskEvent } from '../lib/realtime-emit'
import { enforceRateLimit, KIOSK_RATE_LIMIT, KIOSK_READ_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'
import { calculateETA, getEffectiveServiceTime, filterGhostTickets } from '../lib/eta-calculator'

const app = new Hono()

// POST /kiosk/join — Kiosk join queue (public, unauthenticated)
app.post('/join', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, KIOSK_RATE_LIMIT)

    const body = await c.req.json()
    const validation = validateBody(kioskJoinSchema, body)
    if (validation.error) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, serviceId, customerName } = validation.data

    const agency = await db.agency.findUnique({
      where: { id: agencyId, isActive: true },
      include: { queueSettings: { take: 1, orderBy: { updatedAt: 'desc' } } },
    })

    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)
    if (!agency.isQueueOpen) return c.json({ success: false, error: 'Queue is currently closed' }, 400)
    if (agency.queueSettings.length > 0 && agency.queueSettings[0].isPaused) return c.json({ success: false, error: 'Queue is currently paused' }, 400)

    const service = await db.service.findUnique({ where: { id: serviceId, agencyId } })
    if (!service || !service.isActive) return c.json({ success: false, error: 'Service not found or inactive' }, 404)

    const activeCount = await db.reservation.count({ where: { agencyId, status: { in: ['WAITING', 'CALLED'] } } })
    if (activeCount >= agency.maxActiveReservations) return c.json({ success: false, error: 'Queue is full' }, 400)

    const waitingCount = await db.reservation.count({ where: { agencyId, serviceId, status: 'WAITING' } })

    // ── Unified ETA: use the same advanced engine as the mobile app ──
    // Fetch historical data for accurate service time estimation
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const effective = getEffectiveServiceTime(recentCompleted, agency.averageServiceTime)

    // Count active non-stale counters (phantom counter protection)
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const activeCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
    })

    const isPaused = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false
    const eta = calculateETA({
      peopleAhead: waitingCount,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: activeCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused,
      historicalSampleSize: effective.sampleSize,
    })
    // Use the max of the range as the single persisted estimate (matches mobile display)
    const estimatedWait = eta.estimatedMaxMinutes

    const reservation = await db.$transaction(async (tx) => {
      const cnt = await tx.reservation.count({ where: { agencyId, status: { in: ['WAITING', 'CALLED'] } } })
      if (cnt >= agency.maxActiveReservations) throw new Error('FULL')

      const lastReservation = await tx.reservation.findFirst({ where: { serviceId }, orderBy: { queueNumber: 'desc' } })
      const nextNumber = (lastReservation?.queueNumber || 0) + 1
      const displayNumber = `${service.prefix}-${String(nextNumber).padStart(3, '0')}`

      const res = await tx.reservation.create({
        data: { agencyId, serviceId, queueNumber: nextNumber, displayNumber, status: 'WAITING', estimatedWait, isWalkIn: true, walkInCustomerName: customerName?.trim() || 'Anonymous', userId: null },
      })

      if (agency.queueSettings.length > 0) {
        await tx.queueSettings.update({ where: { id: agency.queueSettings[0].id }, data: { lastIssuedNumber: nextNumber } })
      }

      const importToken = randomBytes(24).toString('hex')
      await tx.reservation.update({
        where: { id: res.id },
        data: { importToken },
      })

      return res
    })

    const position = await db.reservation.count({
      where: { agencyId, serviceId, status: 'WAITING', joinedAt: { lte: reservation.joinedAt } },
    })

    emitQueueEvent('queue:walk-in', agencyId, { reservationId: reservation.id, displayNumber: reservation.displayNumber, customerName: customerName || 'Anonymous', serviceId, estimatedWait })
    emitKioskEvent(agencyId, { action: 'kiosk-join', displayNumber: reservation.displayNumber })

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({ success: true, reservation: { id: reservation.id, ticketNumber: reservation.displayNumber, position, estimatedWaitMinutes: estimatedWait, importToken: reservation.importToken } }, 201)
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    if (clientIp) recordFailedRequest(clientIp)
    if (error instanceof Error && error.message === 'FULL') {
      return c.json({ success: false, error: 'Queue is full' }, 400)
    }
    const message = 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /kiosk/status — Get kiosk status for an agency
app.get('/status', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, KIOSK_READ_RATE_LIMIT)

    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency ID is required' }, 400)
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId, isActive: true },
      include: {
        services: { where: { isActive: true }, select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
        queueSettings: { select: { isPaused: true, currentServingNumber: true }, take: 1, orderBy: { updatedAt: 'desc' } },
      },
    })

    if (!agency) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    const isPaused = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false

    // ── Unified ETA: historical data + phantom counter protection ──
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompletedForAgency = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true, serviceId: true },
      take: 200,
    })
    const effective = getEffectiveServiceTime(recentCompletedForAgency, agency.averageServiceTime)

    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const totalActiveCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
    })

    const servingReservations = await db.reservation.findMany({
      where: { agencyId, status: { in: ['CALLED', 'SERVING'] } },
      select: { id: true, displayNumber: true, status: true, serviceId: true, calledAt: true, service: { select: { id: true, name: true, prefix: true } }, counter: { select: { id: true, name: true, number: true } } },
      orderBy: { calledAt: 'desc' },
    })

    const serviceStats = await Promise.all(
      agency.services.map(async (service) => {
        const waiting = await db.reservation.count({ where: { agencyId, serviceId: service.id, status: 'WAITING' } })
        // Unified ETA per service
        const svcCompleted = recentCompletedForAgency.filter(r => r.serviceId === service.id)
        const svcEffective = getEffectiveServiceTime(svcCompleted, agency.averageServiceTime)
        const svcEta = calculateETA({
          peopleAhead: waiting,
          avgServiceTimeMinutes: svcEffective.avgMinutes,
          activeCounters: totalActiveCounters || 1,
          historicalVarianceFactor: svcEffective.varianceFactor,
          isPaused,
          historicalSampleSize: svcEffective.sampleSize,
        })
        return { serviceId: service.id, serviceName: service.name, serviceNameAr: service.nameAr, serviceNameFr: service.nameFr, prefix: service.prefix, waiting, estimatedWait: svcEta.estimatedMaxMinutes }
      })
    )

    const recentCalls = await db.reservation.findMany({
      where: { agencyId, status: { in: ['CALLED', 'SERVING', 'COMPLETED'] }, calledAt: { not: null } },
      select: { id: true, displayNumber: true, status: true, calledAt: true, service: { select: { prefix: true, name: true } } },
      orderBy: { calledAt: 'desc' },
      take: 5,
    })

    const totalWaiting = serviceStats.reduce((sum, s) => sum + s.waiting, 0)

    // Count total served today (COMPLETED reservations with completedAt today)
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const totalServedToday = await db.reservation.count({
      where: {
        agencyId,
        status: 'COMPLETED',
        completedAt: { gte: startOfDay },
      },
    })
    // Overall ETA from advanced engine
    const overallEta = calculateETA({
      peopleAhead: totalWaiting,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: totalActiveCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused,
      historicalSampleSize: effective.sampleSize,
    })
    const totalEstimatedWait = overallEta.estimatedMaxMinutes

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      agency: { id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr, isQueueOpen: agency.isQueueOpen, isPaused },
      currentlyServing: servingReservations.map((r) => ({ id: r.id, ticketNumber: r.displayNumber, serviceId: r.serviceId, serviceName: r.service.name, status: r.status, calledAt: r.calledAt, counterName: r.counter?.name ?? null })),
      serviceStats,
      totalWaiting,
      totalServedToday,
      totalEstimatedWait,
      activeCounters: totalActiveCounters,
      recentCalls: recentCalls.map((r) => ({ id: r.id, ticketNumber: r.displayNumber, status: r.status, calledAt: r.calledAt })),
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    if (clientIp) recordFailedRequest(clientIp)
    const message = 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /kiosk/agency — Get kiosk agency info by code
app.get('/agency', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, KIOSK_READ_RATE_LIMIT)

    const code = c.req.query('code')
    if (!code) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency code is required' }, 400)
    }

    const agency = await db.agency.findUnique({
      where: { customCode: code, isActive: true },
      include: {
        services: { where: { isActive: true }, select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        queueSettings: { select: { id: true, currentServingNumber: true, lastIssuedNumber: true, isPaused: true }, take: 1, orderBy: { updatedAt: 'desc' } },
      },
    })

    if (!agency) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    const waiting = await db.reservation.count({ where: { agencyId: agency.id, status: 'WAITING' } })

    const currentServing = await db.reservation.findFirst({
      where: { agencyId: agency.id, status: { in: ['CALLED', 'SERVING'] } },
      select: { displayNumber: true, service: { select: { prefix: true } } },
      orderBy: { calledAt: 'desc' },
    })

    // Unified ETA from advanced engine
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: {
        agencyId: agency.id,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const effective = getEffectiveServiceTime(recentCompleted, agency.averageServiceTime)
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const activeCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId: agency.id, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
    })
    const isPausedAgency = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false
    const eta = calculateETA({
      peopleAhead: waiting,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: activeCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused: isPausedAgency,
      historicalSampleSize: effective.sampleSize,
    })
    const estimatedWait = eta.estimatedMaxMinutes
    const services = agency.services.map((s) => ({ ...s, avgTime: agency.averageServiceTime }))

    if (clientIp) recordSuccessfulRequest(clientIp)
    return c.json({
      success: true,
      agency: {
        id: agency.id, name: agency.name, nameAr: agency.nameAr, nameFr: agency.nameFr, category: agency.category, logoUrl: agency.logoUrl,
        workingHoursStart: agency.workingHoursStart, workingHoursEnd: agency.workingHoursEnd, isQueueOpen: agency.isQueueOpen,
        isPaused: agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false,
      },
      services,
      queueStats: { waiting, currentServing: currentServing?.displayNumber || null, estimatedWait },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      return c.json(rateLimitErrorResponse(error).data, 429)
    }
    if (clientIp) recordFailedRequest(clientIp)
    const message = 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

export const kioskRoutes = app
