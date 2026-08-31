import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireResourceOwnership, requireAgencyAccess, authErrorResponse } from '../lib/auth'
import { validateBody, createReservationSchema, updateReservationStatusSchema, rateReservationSchema } from '../lib/validations'
import { emitQueueEvent, emitReservationEvent, emitNotificationEvent, emitKioskEvent, emitAgencyEvent } from '../lib/realtime-emit'
import type { QueueEventType } from '../lib/realtime-emit'
import { calculateETA, getEffectiveServiceTime, filterImmediateServiceWindow } from '../lib/eta-calculator'
import type { ETAResult } from '../lib/eta-calculator'
import { z } from 'zod'

const app = new Hono()

// Phase 3c: 30-minute window for filtering ghost tickets (future fixed-time appointments)
const THIRTY_MINUTES = 30 * 60 * 1000

// Helper: validation error response
function validationError(validation: { error: { error: string; details: Array<{ field: string; message: string }> } | null }) {
  if (validation.error) {
    return { success: false as const, error: validation.error.error, details: validation.error.details }
  }
  return null
}

// POST /reservations — Create reservation (customer joins queue)
app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const body = await c.req.json()
    const validation = validateBody(createReservationSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, serviceId, preferredTime, reservedDate, fixedTimeEnabled } = validation.data

    let targetDate: string | null = null
    if (reservedDate) {
      const parsed = new Date(reservedDate)
      if (isNaN(parsed.getTime())) {
        return c.json({ success: false, error: 'Invalid date format' }, 400)
      }
      targetDate = parsed.toISOString().split('T')[0]
      const today = new Date().toISOString().split('T')[0]
      if (targetDate < today) {
        return c.json({ success: false, error: 'Cannot reserve for a past date' }, 400)
      }
    }

    if (user.role !== 'CUSTOMER') {
      return c.json({ success: false, error: 'Only customers can join queues' }, 403)
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      include: { queueSettings: { take: 1, orderBy: { updatedAt: 'desc' } } },
    })
    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    if (agency.subscriptionStatus !== 'ACTIVE') {
      return c.json({ success: false, error: "This agency's queue is currently unavailable. The agency needs an active subscription." }, 403)
    }

    if (!agency.isQueueOpen) {
      return c.json({ success: false, error: 'Queue is currently closed' }, 400)
    }

    if (agency.queueSettings.length > 0 && agency.queueSettings[0].isPaused) {
      return c.json({ success: false, error: 'Queue is currently paused' }, 400)
    }

    let resolvedServiceId = serviceId
    if (!resolvedServiceId) {
      const firstService = await db.service.findFirst({
        where: { agencyId, isActive: true },
        orderBy: { createdAt: 'asc' },
      })
      if (firstService) {
        resolvedServiceId = firstService.id
      } else {
        const defaultService = await db.service.create({
          data: { agencyId, name: 'General', nameAr: 'عام', nameFr: 'Général', prefix: 'A' },
        })
        resolvedServiceId = defaultService.id
      }
    }

    const service = await db.service.findUnique({ where: { id: resolvedServiceId } })
    if (!service || !service.isActive) {
      return c.json({ success: false, error: 'Service not found or inactive' }, 404)
    }

    const duplicateWhere: Record<string, unknown> = {
      userId,
      agencyId,
      serviceId: resolvedServiceId,
      status: { in: ['WAITING', 'CALLED'] },
    }
    if (targetDate) {
      duplicateWhere.reservedDate = targetDate
    } else {
      duplicateWhere.reservedDate = null
    }
    const activeReservation = await db.reservation.findFirst({ where: duplicateWhere })
    if (activeReservation) {
      return c.json({ success: false, error: 'You already have an active reservation for this service' }, 409)
    }

    const countWhere: Record<string, unknown> = {
      agencyId,
      status: { in: ['WAITING', 'CALLED'] },
    }
    if (targetDate) { countWhere.reservedDate = targetDate } else { countWhere.reservedDate = null }
    const activeCount = await db.reservation.count({ where: countWhere })
    if (activeCount >= agency.maxActiveReservations) {
      return c.json({ success: false, error: 'Queue is full. Please try again later' }, 400)
    }

    const lastWhere: Record<string, unknown> = { serviceId: resolvedServiceId }
    if (targetDate) { lastWhere.reservedDate = targetDate } else { lastWhere.reservedDate = null }
    const waitWhere: Record<string, unknown> = { agencyId, status: 'WAITING' }
    if (targetDate) { waitWhere.reservedDate = targetDate } else { waitWhere.reservedDate = null }
    const waitingCount = await db.reservation.count({ where: waitWhere })

    // ── Unified ETA: use the same advanced engine as the mobile app ──
    const sevenDaysAgoForCreate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompletedForCreate = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgoForCreate },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const effectiveForCreate = getEffectiveServiceTime(recentCompletedForCreate, agency.averageServiceTime)
    const fortyFiveForCreate = new Date(Date.now() - 45 * 60 * 1000)
    const activeCountersForCreate = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveForCreate },
      },
    })
    const isPausedForCreate = agency.queueSettings?.isPaused ?? false
    const etaForCreate = calculateETA({
      peopleAhead: waitingCount,
      avgServiceTimeMinutes: effectiveForCreate.avgMinutes,
      activeCounters: activeCountersForCreate || 1,
      historicalVarianceFactor: effectiveForCreate.varianceFactor,
      isPaused: isPausedForCreate,
      historicalSampleSize: effectiveForCreate.sampleSize,
    })
    const estimatedWait = etaForCreate.estimatedMaxMinutes

    const reservation = await db.$transaction(async (tx) => {
      const dupCheck = await tx.reservation.findFirst({ where: duplicateWhere })
      if (dupCheck) throw new Error('DUPLICATE')

      const cnt = await tx.reservation.count({ where: countWhere })
      if (cnt >= agency.maxActiveReservations) throw new Error('FULL')

      const lastReservation = await tx.reservation.findFirst({
        where: lastWhere,
        orderBy: { queueNumber: 'desc' },
      })
      const nextNumber = (lastReservation?.queueNumber || 0) + 1
      const displayNumber = `${service.prefix}-${String(nextNumber).padStart(3, '0')}`

      const res = await tx.reservation.create({
        data: {
          userId,
          agencyId,
          serviceId: resolvedServiceId,
          queueNumber: nextNumber,
          displayNumber,
          status: 'WAITING',
          estimatedWait,
          reservedDate: targetDate,
          preferredTime: preferredTime || null,
          fixedTimeEnabled: fixedTimeEnabled !== undefined ? fixedTimeEnabled : (preferredTime ? true : false),
        },
        include: {
          agency: { select: { id: true, name: true, nameFr: true, nameAr: true, customCode: true } },
          service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        },
      })

      if (agency.queueSettings.length > 0) {
        await tx.queueSettings.update({
          where: { id: agency.queueSettings[0].id },
          data: { lastIssuedNumber: nextNumber },
        })
      }

      const dateLabel = targetDate ? ` (${targetDate})` : ''
      await tx.notification.create({
        data: {
          userId,
          type: 'QUEUE_JOINED',
          title: 'Reservation Confirmed',
          message: `Your ticket ${displayNumber} for ${agency.name} - ${service.name}${dateLabel}. Estimated wait: ${estimatedWait} minutes.`,
        },
      })

      await tx.auditLog.create({
        data: {
          userId,
          action: 'QUEUE_JOIN',
          entityType: 'RESERVATION',
          entityId: res.id,
          details: JSON.stringify({ agencyId, serviceId: resolvedServiceId, displayNumber, estimatedWait, reservedDate: targetDate }),
        },
      })

      return res
    })

    emitQueueEvent('queue:joined', agencyId, { reservationId: reservation.id, displayNumber: reservation.displayNumber, userId, serviceId: resolvedServiceId, estimatedWait })
    emitKioskEvent(agencyId, { action: 'app-join', displayNumber: reservation.displayNumber, serviceId: resolvedServiceId })
    emitReservationEvent('reservation:created', agencyId, userId, { reservationId: reservation.id, displayNumber: reservation.displayNumber, serviceId: resolvedServiceId, estimatedWait })
    emitNotificationEvent('notification:new', userId, { type: 'QUEUE_JOINED', title: 'Reservation Confirmed', message: `Your ticket ${reservation.displayNumber} for ${agency.name} - ${service.name}. Estimated wait: ${estimatedWait} minutes.` })

    return c.json({ success: true, reservation }, 201)
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'DUPLICATE') {
      return c.json({ success: false, error: 'You already have an active reservation for this service' }, 409)
    }
    if (error instanceof Error && error.message === 'FULL') {
      return c.json({ success: false, error: 'Queue is full. Please try again later' }, 400)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reservations/active — Get user's active reservations (with ETA ranges)
app.get('/active', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const reservations = await db.reservation.findMany({
      where: { userId, status: { in: ['WAITING', 'CALLED'] } },
      include: {
        agency: {
          select: { id: true, name: true, nameFr: true, nameAr: true, customCode: true, category: true, address: true, logoUrl: true, averageServiceTime: true },
        },
        service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
      },
      orderBy: { joinedAt: 'desc' },
      take: 50,
    })

    if (reservations.length === 0) {
      return c.json({ success: true, reservations: [] })
    }

    const agencyIds = [...new Set(reservations.map((r) => r.agencyId))]

    // Fetch queue settings for pause state
    const queueSettingsList = await db.queueSettings.findMany({
      where: { agencyId: { in: agencyIds } },
    })
    const pausedByAgency = new Map(queueSettingsList.map((qs) => [qs.agencyId, qs.isPaused]))

    // Fetch active counters per agency for ETA calculation
    // Phantom Counter Protection: only count counters with recent activity (≤45 min)
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const branches = await db.branch.findMany({
      where: { agencyId: { in: agencyIds }, isActive: true },
      include: { counters: { where: { isActive: true, staffId: { not: null }, updatedAt: { gte: fortyFiveMinsAgo } } } },
    })
    const activeCountersByAgency = new Map<string, number>()
    for (const branch of branches) {
      const current = activeCountersByAgency.get(branch.agencyId) || 0
      activeCountersByAgency.set(branch.agencyId, current + branch.counters.length)
    }

    // Fetch recent completed reservations for historical service time calculation
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: {
        agencyId: { in: agencyIds },
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { agencyId: true, calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const completedByAgency = new Map<string, Array<{ calledAt: Date | null; completedAt: Date | null; joinedAt: Date }>>()
    for (const rc of recentCompleted) {
      if (!completedByAgency.has(rc.agencyId)) completedByAgency.set(rc.agencyId, [])
      completedByAgency.get(rc.agencyId)!.push(rc)
    }

    const waitingReservations = await db.reservation.findMany({
      where: { agencyId: { in: agencyIds }, status: 'WAITING' },
      orderBy: { joinedAt: 'asc' },
      select: { id: true, agencyId: true, joinedAt: true, fixedTimeEnabled: true, preferredTime: true },
    })

    const currentServings = await db.reservation.findMany({
      where: { agencyId: { in: agencyIds }, status: { in: ['CALLED', 'SERVED'] }, calledAt: { not: null } },
      orderBy: { calledAt: 'desc' },
      distinct: ['agencyId'],
      select: { agencyId: true, displayNumber: true },
    })

    const servingByAgency = new Map(currentServings.map((s) => [s.agencyId, s.displayNumber]))
    const waitingByAgency = new Map<string, { id: string; agencyId: string; joinedAt: Date; fixedTimeEnabled: boolean; preferredTime: string | null }[]>()
    for (const wr of waitingReservations) {
      if (!waitingByAgency.has(wr.agencyId)) waitingByAgency.set(wr.agencyId, [])
      waitingByAgency.get(wr.agencyId)!.push(wr)
    }

    // Pre-compute effective service times per agency
    const effectiveServiceByAgency = new Map<string, { avgMinutes: number; sampleSize: number; varianceFactor: number }>()
    for (const agencyId of agencyIds) {
      const avgServiceTime = reservations.find((r) => r.agencyId === agencyId)?.agency.averageServiceTime || 10
      const historical = completedByAgency.get(agencyId) || []
      effectiveServiceByAgency.set(agencyId, getEffectiveServiceTime(historical, avgServiceTime))
    }

    const enriched = reservations.map((res) => {
      const agencyWaiting = waitingByAgency.get(res.agencyId) ?? []
      // Phase 3c: Filter out future fixed-time appointments outside the 30-min immediate window (ghost tickets)
      const peopleAhead = filterImmediateServiceWindow(
        agencyWaiting.filter((w) => w.joinedAt < res.joinedAt && w.id !== res.id)
      ).length
      const position = res.status === 'CALLED' ? 1 : peopleAhead + 1
      const currentServingNumber = servingByAgency.get(res.agencyId) ?? '0'
      const avgServiceTime = res.agency.averageServiceTime || 10
      const estimatedWait = res.status === 'CALLED' ? 0 : peopleAhead * avgServiceTime

      // Calculate ETA range using the ETA engine
      const effective = effectiveServiceByAgency.get(res.agencyId)!
      const eta: ETAResult = calculateETA({
        peopleAhead: res.status === 'CALLED' ? 0 : peopleAhead,
        avgServiceTimeMinutes: effective.avgMinutes,
        activeCounters: activeCountersByAgency.get(res.agencyId) || 1,
        historicalVarianceFactor: effective.varianceFactor,
        isPaused: pausedByAgency.get(res.agencyId) || false,
        historicalSampleSize: effective.sampleSize,
      })

      return {
        ...res,
        peopleAhead,
        position,
        currentServingNumber,
        estimatedWait,
        estimatedWaitRange: {
          minMinutes: eta.estimatedMinMinutes,
          maxMinutes: eta.estimatedMaxMinutes,
          confidence: eta.confidence,
          isPaused: eta.isPaused,
        },
        eta,
      }
    })

    return c.json({ success: true, reservations: enriched })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reservations/history — Get user's reservation history
app.get('/history', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10), 1), 100)
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0)

    const completedStatuses = ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'SERVED'] as string[]
    const where = { userId, status: { in: completedStatuses } }

    const [reservations, total] = await Promise.all([
      db.reservation.findMany({
        where,
        include: {
          agency: { select: { id: true, name: true, nameFr: true, nameAr: true, customCode: true, category: true, logoUrl: true } },
          service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        },
        orderBy: { joinedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.reservation.count({ where }),
    ])

    const mappedReservations = reservations.map(r => {
      const rAny = r as Record<string, unknown>
      return {
        id: r.id, userId: r.userId, agencyId: r.agencyId, serviceId: r.serviceId,
        queueNumber: r.queueNumber, displayNumber: r.displayNumber, status: r.status,
        estimatedWait: r.estimatedWait, reservedDate: r.reservedDate, joinedAt: r.joinedAt,
        calledAt: r.calledAt, completedAt: r.completedAt, cancelledAt: r.cancelledAt,
        rating: r.rating, feedback: (rAny.feedback as string) ?? null, ratedAt: (rAny.ratedAt as Date) ?? null,
        agency: r.agency, service: r.service,
      }
    })

    return c.json({ success: true, reservations: mappedReservations, total, limit, offset })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reservations/agency — Get reservations for an agency
app.get('/agency', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    const status = c.req.query('status')
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 100)
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0)

    if (!agencyId) {
      return c.json({ success: false, error: 'agencyId is required' }, 400)
    }

    await requireAgencyAccess(c, agencyId)

    const where: Record<string, unknown> = { agencyId }
    if (status) where.status = status

    const [reservations, total] = await Promise.all([
      db.reservation.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, fullName: true, phoneNumber: true } },
          service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        },
        orderBy: { joinedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.reservation.count({ where }),
    ])

    return c.json({ success: true, reservations, total, limit, offset })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/reclaim — Reclaim a skipped reservation
app.post('/reclaim', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const reclaimSchema = z.object({ reservationId: z.string().min(1, 'Reservation ID is required') })
    const validation = validateBody(reclaimSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { reservationId } = validation.data

    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      include: {
        user: { select: { id: true, language: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
      },
    })

    if (!reservation) {
      return c.json({ error: 'Reservation not found' }, 404)
    }

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    const reservationAny = reservation as Record<string, unknown>
    if (!reservationAny.skippedForNoShow) {
      return c.json({ error: 'Reservation not found or not skipped' }, 404)
    }

    const userLang = reservation.user?.language || 'ar'
    const agencyName = userLang === 'ar' ? reservation.agency.nameAr || reservation.agency.name
      : userLang === 'fr' ? reservation.agency.nameFr || reservation.agency.name
      : reservation.agency.name

    await db.$transaction(async (tx) => {
      const currentQueueNumber = await tx.reservation.findFirst({
        where: { agencyId: reservation.agencyId, status: 'CALLED', id: { not: reservation.id } },
        orderBy: { queueNumber: 'asc' },
        select: { queueNumber: true },
      })
      const newStatus = currentQueueNumber ? 'WAITING' : reservation.status

      try {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: { skippedForNoShow: false, skippedAt: null, reclaimRequestedAt: new Date(), status: newStatus },
        })
      } catch {
        await tx.reservation.update({ where: { id: reservation.id }, data: { status: newStatus } })
      }

      if (reservation.userId) {
        await tx.notification.create({
          data: {
            userId: reservation.userId,
            type: 'RECLAIM_SUCCESS',
            title: 'Position Reclaimed',
            message: `Your ticket ${reservation.displayNumber} at ${agencyName} has been reclaimed. ${newStatus === 'WAITING' ? 'You have been placed back in the queue.' : 'You are now being served. Please proceed to the counter.'}`,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'RECLAIM_POSITION',
          entityType: 'RESERVATION',
          entityId: reservation.id,
          details: JSON.stringify({ displayNumber: reservation.displayNumber, agencyId: reservation.agencyId, newStatus }),
        },
      })
    })

    emitReservationEvent('reservation:updated', reservation.agencyId, reservation.userId ?? undefined, { reservationId: reservation.id, displayNumber: reservation.displayNumber, action: 'reclaimed' })
    emitQueueEvent('queue:updated', reservation.agencyId, { reservationId: reservation.id, displayNumber: reservation.displayNumber, action: 'reclaimed' })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /reservations/cancel-active — Cancel user's active reservation
app.delete('/cancel-active', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const reservation = await db.reservation.findFirst({
      where: { userId, status: { in: ['WAITING', 'CALLED'] } },
      orderBy: { joinedAt: 'desc' },
    })

    if (!reservation) {
      return c.json({ error: 'No active reservation found' }, 404)
    }

    const updated = await db.reservation.update({
      where: { id: reservation.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    })

    await db.notification.create({
      data: { userId, type: 'CANCELLED', title: 'Queue Cancelled', message: `Your reservation ${updated.displayNumber} has been cancelled.` },
    })

    emitReservationEvent('reservation:cancelled', updated.agencyId, userId, { reservationId: updated.id, displayNumber: updated.displayNumber, agencyId: updated.agencyId })
    emitQueueEvent('queue:updated', updated.agencyId, { reservationId: updated.id, displayNumber: updated.displayNumber, action: 'cancelled' })
    emitKioskEvent(updated.agencyId, { action: 'reservation-cancelled', displayNumber: updated.displayNumber })

    return c.json({ success: true, reservation: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/batch-complete — Batch complete reservations
app.post('/batch-complete', async (c) => {
  try {
    const body = await c.req.json()
    const batchCompleteSchema = z.object({
      reservationIds: z.array(z.string()).min(1, 'At least one reservation ID is required').max(100, 'Maximum 100 reservations per batch'),
      agencyId: z.string().optional(),
    })
    const validation = validateBody(batchCompleteSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { reservationIds, agencyId } = validation.data

    let resolvedAgencyId = agencyId
    if (!resolvedAgencyId) {
      const firstRes = await db.reservation.findFirst({ where: { id: { in: reservationIds } }, select: { agencyId: true } })
      if (firstRes) resolvedAgencyId = firstRes.agencyId
    }

    if (resolvedAgencyId) {
      await requireAgencyAccess(c, resolvedAgencyId)
    } else {
      return c.json({ error: 'Could not determine agency for these reservations' }, 400)
    }

    // Phase 3a: Fetch original data before updateMany (updateMany only returns a count)
    const originalReservations = await db.reservation.findMany({
      where: { id: { in: reservationIds }, agencyId: resolvedAgencyId, status: { in: ['WAITING', 'CALLED'] } },
      select: { id: true, displayNumber: true, agencyId: true, serviceId: true, userId: true, status: true },
    })

    const results = await db.reservation.updateMany({
      where: { id: { in: reservationIds }, agencyId: resolvedAgencyId, status: { in: ['WAITING', 'CALLED'] } },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })

    // Phase 3a: Merge original data with the mutation state for complete realtime event data
    const completedNow = new Date()
    const mergedReservations = originalReservations.map(r => ({
      ...r,
      status: 'COMPLETED' as const,
      completedAt: completedNow,
    }))

    emitQueueEvent('queue:completed', resolvedAgencyId, {
      completedCount: results.count,
      reservationIds,
      reservations: mergedReservations.map(r => ({ id: r.id, displayNumber: r.displayNumber, serviceId: r.serviceId })),
    })
    emitQueueEvent('queue:updated', resolvedAgencyId, { action: 'batch-completed', completedCount: results.count })
    // Phase 3a: Emit kiosk events with merged data (original displayNumber + new status)
    for (const merged of mergedReservations) {
      emitKioskEvent(resolvedAgencyId, { action: 'reservation-completed', displayNumber: merged.displayNumber })
    }

    return c.json({ success: true, updatedCount: results.count })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reservations/:id/eta — Get ETA for a specific reservation
app.get('/:id/eta', async (c) => {
  try {
    const id = c.req.param('id')

    const reservation = await db.reservation.findUnique({
      where: { id },
      include: {
        agency: {
          select: { id: true, name: true, averageServiceTime: true },
        },
        service: { select: { id: true, name: true } },
      },
    })

    if (!reservation) {
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    // Only calculate ETA for waiting reservations
    if (reservation.status !== 'WAITING' && reservation.status !== 'CALLED') {
      return c.json({
        success: true,
        eta: {
          estimatedMinMinutes: 0,
          estimatedMaxMinutes: 0,
          confidence: 'high' as const,
          peopleAhead: 0,
          activeCounters: 0,
          avgServiceTimeSeconds: 0,
          lastUpdated: new Date(),
          isPaused: false,
        },
        message: 'Reservation is no longer in queue',
      })
    }

    // If called, ETA is 0
    if (reservation.status === 'CALLED') {
      return c.json({
        success: true,
        eta: {
          estimatedMinMinutes: 0,
          estimatedMaxMinutes: 1,
          confidence: 'high' as const,
          peopleAhead: 0,
          activeCounters: 0,
          avgServiceTimeSeconds: (reservation.agency.averageServiceTime || 10) * 60,
          lastUpdated: new Date(),
          isPaused: false,
        },
      })
    }

    // Get people ahead in queue for this agency
    // Phase 3c: Exclude future fixed-time appointments outside the 30-minute immediate window
    const etaNow = new Date()
    const peopleAheadResult = await db.reservation.count({
      where: {
        agencyId: reservation.agencyId,
        status: 'WAITING',
        joinedAt: { lt: reservation.joinedAt },
        id: { not: reservation.id },
        OR: [
          { fixedTimeEnabled: false },
          {
            fixedTimeEnabled: true,
            preferredTime: { lte: new Date(etaNow.getTime() + THIRTY_MINUTES).toTimeString().slice(0, 5) },
          },
        ],
      },
    })

    // Get queue settings for pause state
    const queueSettings = await db.queueSettings.findFirst({
      where: { agencyId: reservation.agencyId },
    })
    const isPaused = queueSettings?.isPaused || false

    // Get active counters
    const activeCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId: reservation.agencyId, isActive: true },
      },
    })

    // Get recent completed for historical service time
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: {
        agencyId: reservation.agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 100,
    })

    const effective = getEffectiveServiceTime(recentCompleted, reservation.agency.averageServiceTime || 10)

    const eta = calculateETA({
      peopleAhead: peopleAheadResult,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: Math.max(1, activeCounters),
      historicalVarianceFactor: effective.varianceFactor,
      isPaused,
      historicalSampleSize: effective.sampleSize,
    })

    return c.json({ success: true, eta })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/:id/postpone — Postpone a reservation
app.post('/:id/postpone', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const postponeBodySchema = z.object({ positions: z.number().int().min(1).max(10), reason: z.string().optional() })
    const validation = validateBody(postponeBodySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { positions } = validation.data

    if (!positions || positions < 1 || positions > 10) {
      return c.json({ success: false, error: 'Positions must be between 1 and 10' }, 400)
    }

    const reservation = await db.reservation.findUnique({ where: { id } })
    if (!reservation) {
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }
    if (reservation.status !== 'WAITING') {
      return c.json({ success: false, error: 'Can only postpone a waiting reservation' }, 400)
    }

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    const laterReservations = await db.reservation.findMany({
      where: { agencyId: reservation.agencyId, status: 'WAITING', queueNumber: { gt: reservation.queueNumber } },
      orderBy: { queueNumber: 'asc' },
      take: positions,
    })

    if (laterReservations.length === 0) {
      return c.json({ success: false, error: 'No one to postpone behind' }, 400)
    }

    const targetReservation = laterReservations[laterReservations.length - 1]
    const targetQueueNumber = targetReservation.queueNumber

    const updated = await db.$transaction(async (tx) => {
      // Phase 3b: Use $executeRaw for atomic shift to avoid SQLite unique constraint violations
      // Sequential Prisma updates can temporarily create duplicate queueNumber values
      const tempQueueNumber = -reservation.queueNumber
      await tx.reservation.update({ where: { id: reservation.id }, data: { queueNumber: tempQueueNumber } })

      await tx.$executeRaw`
        UPDATE Reservation 
        SET queueNumber = queueNumber - 1 
        WHERE agencyId = ${reservation.agencyId}
        AND status = 'WAITING' 
        AND queueNumber > ${reservation.queueNumber}
        AND queueNumber <= ${targetQueueNumber}
      `

      const newQueueNumber = targetQueueNumber
      const newDisplayNumber = reservation.displayNumber

      const result = await tx.reservation.update({
        where: { id: reservation.id },
        data: { queueNumber: newQueueNumber, postponeCount: reservation.postponeCount + 1 },
      })

      if (reservation.userId) {
        await tx.notification.create({
          data: {
            userId: reservation.userId,
            type: 'QUEUE_POSTPONED',
            title: 'Turn Postponed',
            message: `Your reservation has been postponed by ${positions} position(s). New queue number: ${newDisplayNumber}`,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          userId: reservation.userId || undefined,
          action: 'QUEUE_POSTPONE',
          entityType: 'RESERVATION',
          entityId: id,
          details: JSON.stringify({ positions, previousQueueNumber: reservation.queueNumber, newQueueNumber, postponeCount: result.postponeCount }),
        },
      })

      return result
    })

    emitReservationEvent('reservation:updated', reservation.agencyId, reservation.userId ?? undefined, { reservationId: id, displayNumber: reservation.displayNumber, action: 'postponed', positions, newQueueNumber: updated.queueNumber })
    emitQueueEvent('queue:position-changed', reservation.agencyId, { reservationId: id, displayNumber: reservation.displayNumber, action: 'postponed', positions })

    return c.json({ success: true, reservation: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/:id/rate — Rate a completed reservation
app.post('/:id/rate', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(rateReservationSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { rating, comment } = validation.data

    const reservation = await db.reservation.findUnique({ where: { id } })
    if (!reservation) return c.json({ error: 'Reservation not found' }, 404)
    if (reservation.status !== 'COMPLETED') return c.json({ error: 'Can only rate completed reservations' }, 400)

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    if (reservation.rating) return c.json({ error: 'Reservation already rated' }, 400)

    await db.reservation.update({ where: { id }, data: { rating } })

    const feedbackText = (comment || '').trim()
    try {
      await db.reservation.update({
        where: { id },
        data: { ratedAt: new Date(), ...(feedbackText ? { feedback: feedbackText } : {}) },
      })
    } catch {
      console.warn('[RATE] Could not set feedback/ratedAt, columns may not exist in Prisma Client')
    }

    emitAgencyEvent('agency:updated', reservation.agencyId, { action: 'rating-submitted', reservationId: reservation.id, rating })

    await db.auditLog.create({
      data: {
        userId: reservation.userId ?? undefined,
        action: 'RATING_SUBMITTED',
        entityType: 'Reservation',
        entityId: reservation.id,
        details: JSON.stringify({ rating, feedback: feedbackText || null }),
      },
    })

    return c.json({ success: true, rating, feedback: feedbackText || null, ratedAt: new Date().toISOString() })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reservations/:id/share — Get share info for a reservation
app.get('/:id/share', async (c) => {
  try {
    const id = c.req.param('id')

    const reservation = await db.reservation.findUnique({
      where: { id },
      include: {
        user: { select: { fullName: true } },
        agency: { select: { name: true, nameAr: true, nameFr: true, customCode: true } },
        service: { select: { name: true, nameAr: true, nameFr: true } },
      },
    })

    if (!reservation) return c.json({ error: 'Reservation not found' }, 404)

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    // Phase 3c: Include fixedTimeEnabled/preferredTime to filter ghost tickets
    const allAhead = await db.reservation.findMany({
      where: { agencyId: reservation.agencyId, status: 'WAITING', joinedAt: { lt: reservation.joinedAt } },
      select: { id: true, fixedTimeEnabled: true, preferredTime: true },
    })

    // Phase 3c: Filter out future fixed-time appointments outside 30-min window
    const peopleAhead = filterImmediateServiceWindow(
      allAhead.filter(r => {
        const rAny = r as Record<string, unknown>
        return rAny.skippedForNoShow !== true
      })
    ).length

    const position = peopleAhead + 1
    const agency = await db.agency.findUnique({ where: { id: reservation.agencyId }, select: { averageServiceTime: true } })
    const estimatedWait = Math.round(peopleAhead * (agency?.averageServiceTime ?? 10))

    const displayNumber = `${reservation.service?.name?.substring(0, 1).toUpperCase() || ''}-${String(reservation.queueNumber).padStart(3, '0')}`

    return c.json({
      displayNumber,
      agencyName: reservation.agency.name,
      agencyNameAr: reservation.agency.nameAr,
      agencyNameFr: reservation.agency.nameFr,
      serviceName: reservation.service.name,
      serviceNameAr: reservation.service.nameAr,
      serviceNameFr: reservation.service.nameFr,
      position,
      estimatedWait,
      queueUrl: process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/:id/share — Get share info (POST variant)
app.post('/:id/share', async (c) => {
  try {
    const id = c.req.param('id')

    const reservation = await db.reservation.findUnique({
      where: { id },
      include: {
        user: { select: { fullName: true } },
        agency: { select: { name: true, nameAr: true, nameFr: true, customCode: true } },
        service: { select: { name: true, nameAr: true, nameFr: true } },
      },
    })

    if (!reservation) return c.json({ error: 'Reservation not found' }, 404)

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    // Phase 3c: Include fixedTimeEnabled/preferredTime to filter ghost tickets
    const allAhead = await db.reservation.findMany({
      where: { agencyId: reservation.agencyId, status: 'WAITING', joinedAt: { lt: reservation.joinedAt } },
      select: { id: true, fixedTimeEnabled: true, preferredTime: true },
    })

    // Phase 3c: Filter out future fixed-time appointments outside 30-min window
    const peopleAhead = filterImmediateServiceWindow(
      allAhead.filter(r => {
        const rAny = r as Record<string, unknown>
        return rAny.skippedForNoShow !== true
      })
    ).length

    const position = peopleAhead + 1
    const agency = await db.agency.findUnique({ where: { id: reservation.agencyId }, select: { averageServiceTime: true } })
    const estimatedWait = Math.round(peopleAhead * (agency?.averageServiceTime ?? 10))

    const displayNumber = `${reservation.service?.name?.substring(0, 1).toUpperCase() || ''}-${String(reservation.queueNumber).padStart(3, '0')}`

    return c.json({
      displayNumber,
      agencyName: reservation.agency.name,
      agencyNameAr: reservation.agency.nameAr,
      agencyNameFr: reservation.agency.nameFr,
      serviceName: reservation.service.name,
      serviceNameAr: reservation.service.nameAr,
      serviceNameFr: reservation.service.nameFr,
      position,
      estimatedWait,
      queueUrl: process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/:id/cancel — Cancel a specific reservation
app.post('/:id/cancel', async (c) => {
  try {
    const id = c.req.param('id')

    const reservation = await db.reservation.findUnique({ where: { id } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    if (reservation.status !== 'WAITING') {
      return c.json({ success: false, error: 'Only WAITING reservations can be cancelled' }, 400)
    }

    await db.$transaction(async (tx) => {
      await tx.reservation.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } })

      if (reservation.userId) {
        await tx.notification.create({
          data: { userId: reservation.userId, type: 'RESERVATION_CANCELLED', title: 'Reservation Cancelled', message: `Your reservation ${reservation.displayNumber} has been cancelled.` },
        })
      }

      await tx.auditLog.create({
        data: {
          userId: reservation.userId || undefined,
          action: 'RESERVATION_CANCEL',
          entityType: 'RESERVATION',
          entityId: id,
          details: JSON.stringify({ displayNumber: reservation.displayNumber, agencyId: reservation.agencyId }),
        },
      })
    })

    emitReservationEvent('reservation:cancelled', reservation.agencyId, reservation.userId ?? undefined, { reservationId: id, displayNumber: reservation.displayNumber, agencyId: reservation.agencyId })
    emitQueueEvent('queue:updated', reservation.agencyId, { reservationId: id, displayNumber: reservation.displayNumber, action: 'cancelled' })
    emitKioskEvent(reservation.agencyId, { action: 'reservation-cancelled', displayNumber: reservation.displayNumber })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /reservations/:id/status — Update reservation status
app.put('/:id/status', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(updateReservationStatusSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { status } = validation.data

    const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
      WAITING: ['CALLED', 'CANCELLED'],
      CALLED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
      SERVING: ['COMPLETED'],
    }

    const reservation = await db.reservation.findUnique({
      where: { id },
      include: { agency: { select: { id: true, name: true } }, service: { select: { id: true, name: true } } },
    })

    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    if (!reservation.userId) {
      await requireAgencyAccess(c, reservation.agencyId)
    } else {
      try { await requireResourceOwnership(c, reservation.userId) } catch { await requireAgencyAccess(c, reservation.agencyId) }
    }

    const allowedTransitions = VALID_STATUS_TRANSITIONS[reservation.status] || []
    if (!allowedTransitions.includes(status)) {
      return c.json({ success: false, error: `Cannot transition from ${reservation.status} to ${status}` }, 400)
    }

    const updateData: Record<string, unknown> = { status }
    const now = new Date()
    switch (status) {
      case 'CALLED': updateData.calledAt = now; break
      case 'COMPLETED': updateData.completedAt = now; break
      case 'CANCELLED': updateData.cancelledAt = now; break
      case 'NO_SHOW': updateData.completedAt = now; break
      // SERVING is an intermediate state — no timestamp to set
    }

    const updatedReservation = await db.reservation.update({ where: { id }, data: updateData })

    if (reservation.userId) {
      const notificationType = `QUEUE_${status}` as const
      const titleMap: Record<string, string> = { CALLED: 'Your Turn!', COMPLETED: 'Service Completed', CANCELLED: 'Reservation Cancelled', NO_SHOW: 'Missed Your Turn', SERVING: 'Being Served' }
      const messageMap: Record<string, string> = {
        CALLED: `Please proceed to ${reservation.agency.name} - ${reservation.service.name}. Your ticket: ${reservation.displayNumber}`,
        COMPLETED: `Your visit at ${reservation.agency.name} has been completed.`,
        CANCELLED: `Your reservation ${reservation.displayNumber} at ${reservation.agency.name} has been cancelled.`,
        NO_SHOW: `You missed your turn for ticket ${reservation.displayNumber} at ${reservation.agency.name}.`,
        SERVING: `You are now being served at ${reservation.agency.name} - ${reservation.service.name}.`,
      }

      await db.notification.create({
        data: { userId: reservation.userId, type: notificationType, title: titleMap[status] || 'Reservation Update', message: messageMap[status] || 'Your reservation status has been updated.' },
      })
    }

    await db.auditLog.create({
      data: {
        userId: reservation.userId ?? undefined,
        action: status === 'COMPLETED' ? 'QUEUE_COMPLETE' : status === 'CANCELLED' ? 'QUEUE_CANCEL' : status === 'NO_SHOW' ? 'QUEUE_NOSHOW' : 'QUEUE_CALL',
        entityType: 'RESERVATION',
        entityId: id,
        details: JSON.stringify({ reservationId: id, previousStatus: reservation.status, newStatus: status, displayNumber: reservation.displayNumber }),
      },
    })

    const queueEventTypeMap: Record<string, QueueEventType> = {
      CALLED: 'queue:called', COMPLETED: 'queue:completed', CANCELLED: 'queue:cancelled', NO_SHOW: 'queue:no-show', SERVING: 'queue:updated',
    }
    const queueEventType = queueEventTypeMap[status]
    if (queueEventType) {
      emitQueueEvent(queueEventType, reservation.agencyId, { reservationId: id, displayNumber: reservation.displayNumber, previousStatus: reservation.status, newStatus: status, serviceId: reservation.serviceId })
    }

    const reservationEventType = status === 'CANCELLED' ? 'reservation:cancelled' : 'reservation:updated'
    emitReservationEvent(reservationEventType, reservation.agencyId, reservation.userId ?? undefined, { reservationId: id, displayNumber: reservation.displayNumber, previousStatus: reservation.status, newStatus: status })

    if (reservation.userId && status === 'CALLED') {
      emitNotificationEvent('notification:your-turn', reservation.userId, { ticketNumber: reservation.displayNumber, agencyName: reservation.agency.name })
    } else if (reservation.userId && status === 'NO_SHOW') {
      emitNotificationEvent('notification:new', reservation.userId, { message: `You missed your turn for ticket ${reservation.displayNumber}` })
    }

    if (['CALLED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'].includes(status)) {
      emitKioskEvent(reservation.agencyId, { action: `reservation-${status.toLowerCase()}`, displayNumber: reservation.displayNumber })
    }

    return c.json({ success: true, reservation: updatedReservation })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reservations/:id/toggle-fixed-time — Toggle fixed time for reservation
app.post('/:id/toggle-fixed-time', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const toggleFixedTimeSchema = z.object({ fixedTimeEnabled: z.boolean() })
    const validation = validateBody(toggleFixedTimeSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { fixedTimeEnabled } = validation.data

    const reservation = await db.reservation.findUnique({ where: { id } })
    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)
    if (reservation.status !== 'WAITING') return c.json({ success: false, error: 'Can only toggle fixed time for waiting reservations' }, 400)

    try { await requireResourceOwnership(c, reservation.userId ?? '') } catch { await requireAgencyAccess(c, reservation.agencyId) }

    if (fixedTimeEnabled && !reservation.preferredTime) {
      return c.json({ success: false, error: 'Cannot enable fixed time without a preferred time' }, 400)
    }

    const updated = await db.reservation.update({ where: { id }, data: { fixedTimeEnabled } })

    if (reservation.userId) {
      await db.notification.create({
        data: {
          userId: reservation.userId,
          type: 'QUEUE_TIME_TOGGLE',
          title: fixedTimeEnabled ? 'Fixed Time Enabled' : 'Fixed Time Disabled',
          message: fixedTimeEnabled ? `Your turn will not come before ${reservation.preferredTime}` : 'Your reservation will follow normal queue order',
        },
      })
    }

    await db.auditLog.create({
      data: {
        userId: reservation.userId || undefined,
        action: fixedTimeEnabled ? 'FIXED_TIME_ENABLE' : 'FIXED_TIME_DISABLE',
        entityType: 'RESERVATION',
        entityId: id,
        details: JSON.stringify({ preferredTime: reservation.preferredTime, fixedTimeEnabled }),
      },
    })

    emitReservationEvent('reservation:updated', reservation.agencyId, reservation.userId ?? undefined, { reservationId: id, displayNumber: reservation.displayNumber, action: fixedTimeEnabled ? 'fixed-time-enabled' : 'fixed-time-disabled', fixedTimeEnabled, preferredTime: reservation.preferredTime })

    return c.json({ success: true, reservation: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reservations/:id/position-history — Get position history for reservation
app.get('/:id/position-history', async (c) => {
  try {
    const id = c.req.param('id')

    const reservation = await db.reservation.findUnique({
      where: { id },
      select: { id: true, userId: true, agencyId: true, status: true, queueNumber: true, displayNumber: true, joinedAt: true, calledAt: true, service: { select: { name: true, prefix: true } }, agency: { select: { averageServiceTime: true } } },
    })

    if (!reservation) return c.json({ success: false, error: 'Reservation not found' }, 404)

    try { await requireResourceOwnership(c, reservation.userId ?? '') } catch { await requireAgencyAccess(c, reservation.agencyId) }

    // Phase 3c: Exclude future fixed-time appointments outside the 30-minute immediate window
    const posNow = new Date()
    const peopleAhead = await db.reservation.count({
      where: {
        agencyId: reservation.agencyId,
        status: 'WAITING',
        joinedAt: { lt: reservation.joinedAt },
        id: { not: reservation.id },
        OR: [
          { fixedTimeEnabled: false },
          {
            fixedTimeEnabled: true,
            preferredTime: { lte: new Date(posNow.getTime() + THIRTY_MINUTES).toTimeString().slice(0, 5) },
          },
        ],
      },
    })

    const currentPosition = reservation.status === 'CALLED' ? 1 : peopleAhead + 1

    const avgServiceTime = reservation.agency.averageServiceTime || 10
    const joinedAt = new Date(reservation.joinedAt)
    const now = new Date()

    const initialWaiting = await db.reservation.count({
      where: { agencyId: reservation.agencyId, status: { in: ['WAITING', 'CALLED', 'COMPLETED'] }, joinedAt: { lt: reservation.joinedAt } },
    })

    const initialPosition = initialWaiting + 1

    const timeline = []
    let pos = initialPosition
    let currentTime = new Date(joinedAt)

    timeline.push({ position: initialPosition, timestamp: joinedAt.toISOString(), direction: 'joined' as const, label: 'joined' })

    while (pos > currentPosition) {
      pos--
      const minutesElapsed = (initialPosition - pos) * avgServiceTime
      currentTime = new Date(joinedAt.getTime() + minutesElapsed * 60000)
      if (currentTime > now) currentTime = new Date(now)
      timeline.push({ position: pos, timestamp: currentTime.toISOString(), direction: (pos === currentPosition ? 'current' : 'up') as 'current' | 'up', label: pos === currentPosition ? 'current' : 'movedUp' })
    }

    if (timeline.length === 1 && initialPosition === currentPosition) {
      timeline[0].direction = 'current'
    }

    if (reservation.status === 'CALLED' && reservation.calledAt) {
      const lastEntry = timeline[timeline.length - 1]
      if (lastEntry && lastEntry.position === 1) {
        lastEntry.timestamp = reservation.calledAt.toISOString()
        lastEntry.direction = 'current'
        lastEntry.label = 'called'
      }
    }

    return c.json({ success: true, timeline, currentPosition, initialPosition, totalChanges: Math.max(0, initialPosition - currentPosition) })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /import-walk-in — Customer scans a walk-in QR ticket to import it into their account
app.post('/import-walk-in', async (c) => {
  try {
    const user = await requireAuth(c)
    if (!user) return authErrorResponse(c, 'Authentication required')

    const body = await c.req.json()
    const schema = z.object({
      token: z.string().min(1, 'Token is required'),
    })
    const validation = validateBody(schema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { token } = validation.data

    // Verify the QR token
    const { verifyQRToken } = await import('../lib/qr-token-service')
    const payload = verifyQRToken(token)
    if (!payload) {
      return c.json({ success: false, error: 'Invalid or expired QR token' }, 400)
    }

    // Find the reservation
    const reservation = await db.reservation.findUnique({
      where: { id: payload.reservationId },
      include: {
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
        service: { select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
      },
    })

    if (!reservation) {
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    // Must be a walk-in
    if (!reservation.isWalkIn) {
      return c.json({ success: false, error: 'This QR is not for a walk-in reservation' }, 400)
    }

    // Must already have the import token saved
    if (reservation.importToken !== token) {
      return c.json({ success: false, error: 'Token does not match this reservation' }, 400)
    }

    // Already linked to a user
    if (reservation.userId) {
      return c.json({
        success: false,
        error: 'already_linked',
        message: 'This ticket is already linked to an account',
        reservation: {
          id: reservation.id,
          displayNumber: reservation.displayNumber,
          status: reservation.status,
          queueNumber: reservation.queueNumber,
          agency: reservation.agency,
          service: reservation.service,
        },
      }, 409)
    }

    // Check status is eligible (still waiting)
    if (!['WAITING'].includes(reservation.status)) {
      return c.json({
        success: false,
        error: `Reservation status '${reservation.status}' cannot be imported`,
      }, 400)
    }

    // Fetch the customer's account data to update the reservation
    const customerAccount = await db.user.findUnique({
      where: { id: user.id },
      select: { fullName: true, phoneNumber: true, avatarUrl: true },
    })

    // Link the reservation to the authenticated user and update customer data
    // Keep status as WAITING so it stays visible in both agency queue and customer queue
    await db.reservation.update({
      where: { id: reservation.id },
      data: {
        userId: user.id,
        walkInCustomerName: customerAccount?.fullName || user.fullName,
        qrClaimedAt: new Date(),
      },
    })

    // Emit realtime events
    try {
      await emitReservationEvent('reservation:updated', reservation.agencyId, user.id, {
        reservationId: reservation.id,
        status: reservation.status,
        importedByUser: true,
      })
      await emitQueueEvent('queue:updated', reservation.agencyId, {
        action: 'walk_in_imported',
        reservationId: reservation.id,
        userId: user.id,
        displayNumber: reservation.displayNumber,
      })
    } catch (emitErr) {
      console.warn('[Import-WalkIn] Failed to emit realtime event:', emitErr)
    }

    return c.json({
      success: true,
      message: 'Walk-in reservation imported to your queue',
      reservation: {
        id: reservation.id,
        displayNumber: reservation.displayNumber,
        status: reservation.status,
        queueNumber: reservation.queueNumber,
        agency: reservation.agency,
        service: reservation.service,
        isWalkIn: true,
        walkInCustomerName: customerAccount?.fullName || user.fullName,
        joinedAt: reservation.joinedAt,
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const reservationsRoutes = app
