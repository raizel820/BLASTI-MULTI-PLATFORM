import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireAgencyAccess, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { emitQueueEvent, emitNotificationEvent, emitKioskEvent } from '../lib/realtime-emit'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'
import { calculateETA, getEffectiveServiceTime, filterImmediateServiceWindow, filterGhostTickets } from '../lib/eta-calculator'
import { shouldSkipForPreferredTime, getNextCustomerToCall } from '../lib/queue-scheduler'
import { cancelPendingCustomerAlerts } from '../lib/cancel-pending-alerts'
import { z } from 'zod'

const app = new Hono()

// ── Phase 3b: Transaction retry with exponential backoff for SQLite BUSY/DEADLOCK ──
// Under concurrent load, two desks calling the next ticket simultaneously can
// cause SQLite BUSY/DEADLOCK errors. This wrapper retries the transaction up
// to 3 times with exponential backoff (50ms, 150ms, 450ms).

const MAX_TX_RETRIES = 3
const TX_RETRY_DELAYS = [50, 150, 450]

function isSQLiteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message || ''
  return (
    /SQLITE_BUSY|busy_timeout|database is locked/i.test(msg) ||
    (error as any).code === 'P2034' // Prisma: Transaction failed due to a write conflict
  )
}

async function withTxRetry<R>(
  fn: (...args: any[]) => Promise<R>,
): Promise<R> {
  for (let attempt = 0; attempt < MAX_TX_RETRIES; attempt++) {
    try {
      return await db.$transaction(fn)
    } catch (error: unknown) {
      if (!isSQLiteBusyError(error) || attempt === MAX_TX_RETRIES - 1) throw error
      const delay = TX_RETRY_DELAYS[attempt]
      console.warn(`[queue] SQLITE_BUSY on attempt ${attempt + 1}/${MAX_TX_RETRIES}, retrying in ${delay}ms…`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Transaction retry exhausted') // unreachable
}

// POST /queue/call-next — Call the next customer
// Phase 3: Uses queueNumber-based sorting + optimistic concurrency + preferred time logic
app.post('/call-next', async (c) => {
  try {
    const body = await c.req.json()
    const callNextSchema = z.object({
      agencyId: z.string().min(1, 'Agency ID is required'),
      serviceId: z.string().min(1, 'Service ID is required'),
      counterId: z.string().optional(), // Phase 2: Multi-desk tracking
    })
    const validation = validateBody(callNextSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, serviceId, counterId } = validation.data
    const user = await requireAgencyAccess(c, agencyId)

    const agencyCheck = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agencyCheck) return c.json({ success: false, error: 'Agency not found' }, 404)
    if (agencyCheck.subscriptionStatus !== 'ACTIVE' && agencyCheck.subscriptionStatus !== 'TRIAL') {
      return c.json({ success: false, error: 'An active subscription is required to use queue features' }, 403)
    }

    // Phase 3: Sort by queueNumber ASC (not joinedAt) to fix the Postpone Paradox
    // When a reservation is postponed, its queueNumber stays the same but joinedAt changes
    // Sorting by joinedAt would put postponed tickets at the back of the queue,
    // but sorting by queueNumber preserves their original position
    const waitingReservations = await db.reservation.findMany({
      where: { agencyId, serviceId, status: 'WAITING' },
      orderBy: { queueNumber: 'asc' },
      include: {
        agency: { select: { id: true, name: true, nameFr: true, nameAr: true } },
        service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        user: { select: { id: true, username: true, fullName: true, language: true, phoneNumber: true } },
      },
    })

    if (!waitingReservations.length) {
      return c.json({ success: false, error: 'No waiting reservations for this service' }, 404)
    }

    // Phase 3: Enforce preferred time logic using getNextCustomerToCall
    const nextId = getNextCustomerToCall(
      waitingReservations.map(r => ({
        id: r.id,
        queueNumber: r.queueNumber,
        preferredTime: r.preferredTime,
        fixedTimeEnabled: r.fixedTimeEnabled,
      }))
    )

    if (!nextId) {
      return c.json({
        success: false,
        error: 'All waiting reservations have preferred times in the future. No one to call yet.',
        hasPreferredTimeOnly: true,
      }, 200)
    }

    const nextReservation = waitingReservations.find(r => r.id === nextId)!

    // Phase 3b: Wrap all writes in a transaction with retry logic to prevent
    // SQLite BUSY/DEADLOCK errors under concurrent load (two desks calling next simultaneously)
    const { updateResult, updatedReservation } = await withTxRetry(async (tx) => {
      // Phase 3: Optimistic Concurrency — use updateMany with a status check
      // This prevents two desks from calling the exact same ticket simultaneously
      const result = await tx.reservation.updateMany({
        where: {
          id: nextReservation.id,
          status: 'WAITING', // Only update if still WAITING (not already called by another desk)
        },
        data: {
          status: 'CALLED',
          calledAt: new Date(),
          counterId: counterId || null, // Phase 2: Track which desk called this ticket
        },
      })

      // If no rows were updated, another desk already called this ticket
      if (result.count === 0) {
        return { updateResult: result, updatedReservation: null }
      }

      // Get the updated reservation with relations
      const updated = await tx.reservation.findUnique({
        where: { id: nextReservation.id },
        include: {
          agency: { select: { id: true, name: true, nameFr: true, nameAr: true } },
          service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
          user: { select: { id: true, username: true, fullName: true, language: true, phoneNumber: true } },
          counter: { select: { id: true, name: true, number: true } },
        },
      })

      const queueSettings = await tx.queueSettings.findFirst({ where: { agencyId }, orderBy: { updatedAt: 'desc' } })
      if (queueSettings) {
        await tx.queueSettings.update({ where: { id: queueSettings.id }, data: { currentServingNumber: nextReservation.queueNumber } })
      }

      if (nextReservation.userId) {
        await tx.notification.create({
          data: { userId: nextReservation.userId, type: 'QUEUE_CALLED', title: 'Your Turn!', message: `Please proceed to ${nextReservation.agency.name} - ${nextReservation.service.name}. Your ticket: ${nextReservation.displayNumber}` },
        })
      }

      await tx.auditLog.create({
        data: { userId: user.id, action: 'QUEUE_CALL', entityType: 'RESERVATION', entityId: nextReservation.id, details: JSON.stringify({ agencyId, serviceId, displayNumber: nextReservation.displayNumber, userId: nextReservation.userId, counterId }) },
      })

      return { updateResult: result, updatedReservation: updated }
    })

    // If no rows were updated, another desk already called this ticket — return 409
    if (updateResult.count === 0) {
      const remainingReservations = waitingReservations.filter(r => r.id !== nextId && r.status === 'WAITING')
      if (remainingReservations.length > 0) {
        const retryNextId = getNextCustomerToCall(
          remainingReservations.map(r => ({
            id: r.id,
            queueNumber: r.queueNumber,
            preferredTime: r.preferredTime,
            fixedTimeEnabled: r.fixedTimeEnabled,
          }))
        )
        if (retryNextId) {
          return c.json({
            success: false,
            error: 'Concurrent call detected. Please try again.',
            shouldRetry: true,
          }, 409)
        }
      }
      return c.json({ success: false, error: 'No available waiting reservations' }, 404)
    }

    // Phase 3a: Merge original data with the mutation state for complete realtime event data
    const calledNow = new Date()
    const mergedCallData = {
      ...nextReservation,
      status: 'CALLED' as const,
      calledAt: calledNow,
      counterId: counterId || null,
    }

    emitQueueEvent('queue:called', agencyId, {
      reservationId: mergedCallData.id,
      displayNumber: mergedCallData.displayNumber,
      serviceId,
      customerName: mergedCallData.user?.fullName || '',
      counterId,
      counterName: updatedReservation?.counter?.name,
    })
    if (mergedCallData.userId) {
      emitNotificationEvent('notification:your-turn', mergedCallData.userId, { ticketNumber: mergedCallData.displayNumber, agencyName: mergedCallData.agency.name, serviceName: mergedCallData.service.name })
    }
    emitKioskEvent(agencyId, { action: 'call-next', displayNumber: mergedCallData.displayNumber, counterId })

    return c.json({ success: true, reservation: updatedReservation })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /queue/pause — Pause the queue
app.put('/pause', async (c) => {
  try {
    const body = await c.req.json()
    const agencyIdSchema = z.object({ agencyId: z.string().min(1, 'Agency ID is required') })
    const validation = validateBody(agencyIdSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId } = validation.data
    const user = await requireAgencyAccess(c, agencyId)

    const queueSettings = await db.queueSettings.findFirst({ where: { agencyId }, orderBy: { updatedAt: 'desc' } })
    if (!queueSettings) return c.json({ success: false, error: 'No queue settings found for this agency' }, 404)

    const updatedSettings = await db.queueSettings.update({
      where: { id: queueSettings.id },
      data: { isPaused: true, pausedAt: new Date() },
    })

    await db.auditLog.create({
      data: { userId: user.id, action: 'SETTINGS_UPDATE', entityType: 'AGENCY', entityId: agencyId, details: JSON.stringify({ action: 'PAUSE_QUEUE' }) },
    })

    emitQueueEvent('queue:paused', agencyId, { action: 'pause' })
    emitKioskEvent(agencyId, { action: 'queue-paused' })

    return c.json({ success: true, queueSettings: updatedSettings })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /queue/resume — Resume the queue
app.put('/resume', async (c) => {
  try {
    const body = await c.req.json()
    const agencyIdSchema = z.object({ agencyId: z.string().min(1, 'Agency ID is required') })
    const validation = validateBody(agencyIdSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId } = validation.data
    const user = await requireAgencyAccess(c, agencyId)

    const queueSettings = await db.queueSettings.findFirst({ where: { agencyId }, orderBy: { updatedAt: 'desc' } })
    if (!queueSettings) return c.json({ success: false, error: 'No queue settings found for this agency' }, 404)

    const updatedSettings = await db.queueSettings.update({
      where: { id: queueSettings.id },
      data: { isPaused: false, pausedAt: null },
    })

    await db.auditLog.create({
      data: { userId: user.id, action: 'SETTINGS_UPDATE', entityType: 'AGENCY', entityId: agencyId, details: JSON.stringify({ action: 'RESUME_QUEUE' }) },
    })

    emitQueueEvent('queue:resumed', agencyId, { action: 'resume' })
    emitKioskEvent(agencyId, { action: 'queue-resumed' })

    return c.json({ success: true, queueSettings: updatedSettings })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /queue/settings — Update queue settings
app.put('/settings', async (c) => {
  try {
    const body = await c.req.json()
    const queueSettingsBodySchema = z.object({
      agencyId: z.string().min(1, 'Agency ID is required'),
      averageServiceTime: z.number().int().min(1).max(480).optional(),
      maxActiveReservations: z.number().int().min(1).max(1000).optional(),
      isQueueOpen: z.boolean().optional(),
    })
    const validation = validateBody(queueSettingsBodySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, averageServiceTime, maxActiveReservations, isQueueOpen } = validation.data
    const user = await requireAgencyAccess(c, agencyId)

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

    const updateData: Record<string, unknown> = {}
    if (averageServiceTime !== undefined) updateData.averageServiceTime = averageServiceTime
    if (maxActiveReservations !== undefined) updateData.maxActiveReservations = maxActiveReservations
    if (isQueueOpen !== undefined) updateData.isQueueOpen = isQueueOpen

    const updatedAgency = await db.agency.update({ where: { id: agencyId }, data: updateData })

    await db.auditLog.create({
      data: { userId: user.id, action: 'SETTINGS_UPDATE', entityType: 'AGENCY', entityId: agencyId, details: JSON.stringify({ averageServiceTime, maxActiveReservations, isQueueOpen }) },
    })

    emitQueueEvent('queue:settings-updated', agencyId, { action: 'settings-updated', averageServiceTime, maxActiveReservations, isQueueOpen })

    return c.json({ success: true, agency: updatedAgency })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /queue/status — Public queue status (with ETA ranges per service)
// Phase 3: Fixed global ETA math — groups active counters by serviceId
app.get('/status', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const agencyId = c.req.query('agencyId')
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)

    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { id: true, name: true, isQueueOpen: true, averageServiceTime: true, maxActiveReservations: true },
    })

    if (!agency) return c.json({ success: false, error: 'Agency not found' }, 404)

    const queueSettings = await db.queueSettings.findFirst({ where: { agencyId }, orderBy: { updatedAt: 'desc' } })
    const isPaused = queueSettings?.isPaused || false

    // Get ALL active counters for the agency (across all branches)
    // Phantom Counter Protection: only count counters with recent activity (≤45 min)
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const allActiveCounters = await db.counter.findMany({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
      select: { id: true, branch: { select: { agencyId: true } } },
    })

    // Phase 3: Group active counters by service
    // Counters serving a specific service are determined by the currentReservation's serviceId
    // For now, we use the total active counters divided across services as a rough estimate
    const totalActiveCounters = allActiveCounters.length

    // Get recent completed reservations for historical service time
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompleted = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true, serviceId: true },
      take: 200,
    })

    // Calculate effective service time for the whole agency
    const effectiveService = getEffectiveServiceTime(recentCompleted, agency.averageServiceTime)

    // Per-service historical data
    const completedByService = new Map<string, Array<{ calledAt: Date | null; completedAt: Date | null; joinedAt: Date }>>()
    for (const rc of recentCompleted) {
      if (!completedByService.has(rc.serviceId)) completedByService.set(rc.serviceId, [])
      completedByService.get(rc.serviceId)!.push(rc)
    }

    // Phase 3: Get active counters per service (counters currently serving each service)
    const countersPerService = new Map<string, number>()
    const activeServiceReservations = await db.reservation.findMany({
      where: {
        agencyId,
        status: { in: ['CALLED', 'SERVING'] },
      },
      select: { serviceId: true, counterId: true },
    })
    for (const ar of activeServiceReservations) {
      const current = countersPerService.get(ar.serviceId) || 0
      countersPerService.set(ar.serviceId, current + 1)
    }

    // Phase 3c: Get waiting reservations with fixedTimeEnabled/preferredTime/createdAt for ghost ticket filtering
    const allWaitingReservations = await db.reservation.findMany({
      where: { agencyId, status: 'WAITING' },
      select: { id: true, serviceId: true, fixedTimeEnabled: true, preferredTime: true, createdAt: true },
    })

    // Phase 3c: Filter out ghost tickets (WAITING > 2 hours — likely no-shows)
    const activeWaitingReservations = filterGhostTickets(allWaitingReservations)

    // Phase 3c: Filter out future fixed-time appointments outside 30-min immediate window
    const immediateWaitingReservations = filterImmediateServiceWindow(activeWaitingReservations)

    // Group by serviceId after filtering ghost tickets
    const waitingByService = new Map<string, number>()
    for (const r of immediateWaitingReservations) {
      const current = waitingByService.get(r.serviceId) || 0
      waitingByService.set(r.serviceId, current + 1)
    }

    const serviceIds = [...waitingByService.keys()]
    const services = serviceIds.length > 0
      ? await db.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } })
      : []

    const serviceMap = new Map(services.map((s) => [s.id, s]))

    // Phase 3: Fix Global ETA Math — divide wait times by service-specific counter counts
    const serviceWaitCounts = [...waitingByService.entries()].map(([serviceId, waitingCount]) => {
      const serviceEffective = getEffectiveServiceTime(
        completedByService.get(serviceId) || [],
        agency.averageServiceTime,
      )

      // Phase 3: Use service-specific counter count instead of total agency counters
      const serviceCounters = countersPerService.get(serviceId) || Math.max(1, Math.ceil(totalActiveCounters / Math.max(1, waitingByService.size)))

      const eta = calculateETA({
        peopleAhead: waitingCount,
        avgServiceTimeMinutes: serviceEffective.avgMinutes,
        activeCounters: Math.max(1, serviceCounters),
        historicalVarianceFactor: serviceEffective.varianceFactor,
        isPaused,
        historicalSampleSize: serviceEffective.sampleSize,
      })
      return {
        serviceId,
        serviceName: serviceMap.get(serviceId)?.name || 'Unknown',
        servicePrefix: serviceMap.get(serviceId)?.prefix || '?',
        waitingCount,
        activeCounters: serviceCounters,
        estimatedWaitRange: {
          minMinutes: eta.estimatedMinMinutes,
          maxMinutes: eta.estimatedMaxMinutes,
          confidence: eta.confidence,
        },
      }
    })

    const totalWaiting = await db.reservation.count({ where: { agencyId, status: 'WAITING' } })
    const totalActive = await db.reservation.count({ where: { agencyId, status: { in: ['WAITING', 'CALLED'] } } })

    // Phase 3c: Active waiting count (excluding ghost tickets) for ETA calculation
    const activeWaitingTotal = serviceWaitCounts.reduce((sum, s) => sum + s.waitingCount, 0)

    // Calculate overall ETA range for the queue (using ghost-filtered count)
    const overallEta = calculateETA({
      peopleAhead: activeWaitingTotal,
      avgServiceTimeMinutes: effectiveService.avgMinutes,
      activeCounters: Math.max(1, totalActiveCounters),
      historicalVarianceFactor: effectiveService.varianceFactor,
      isPaused,
      historicalSampleSize: effectiveService.sampleSize,
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      status: {
        agencyId: agency.id,
        agencyName: agency.name,
        isQueueOpen: agency.isQueueOpen,
        isPaused,
        currentServingNumber: queueSettings?.currentServingNumber || 0,
        lastIssuedNumber: queueSettings?.lastIssuedNumber || 0,
        averageServiceTime: agency.averageServiceTime,
        maxActiveReservations: agency.maxActiveReservations,
        totalWaiting,
        totalActive,
        activeCounters: totalActiveCounters,
        estimatedWaitRange: {
          minMinutes: overallEta.estimatedMinMinutes,
          maxMinutes: overallEta.estimatedMaxMinutes,
          confidence: overallEta.confidence,
        },
        serviceWaitCounts,
      },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /queue/track — Customer queue tracking (authenticated)
// When a customer loads their queue tracking page, this endpoint:
// 1. Returns the customer's position and ETA for a specific reservation
// 2. Cancels any pending carrier (SMS/WhatsApp) alerts since they're actively viewing the app
app.get('/track', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const reservationId = c.req.query('reservationId')
    if (!reservationId) {
      return c.json({ success: false, error: 'reservationId is required' }, 400)
    }

    // Look up the reservation
    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      include: {
        agency: {
          select: { id: true, name: true, nameFr: true, nameAr: true, averageServiceTime: true, isQueueOpen: true },
        },
        service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
      },
    })

    if (!reservation) {
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    // Verify the reservation belongs to the authenticated user
    if (reservation.userId !== userId) {
      return c.json({ success: false, error: 'Not authorized to view this reservation' }, 403)
    }

    // Cancel any pending carrier alerts since the customer is actively tracking
    await cancelPendingCustomerAlerts(userId, reservationId)

    // Calculate queue position
    const agencyId = reservation.agencyId
    const queueSettings = await db.queueSettings.findFirst({ where: { agencyId }, orderBy: { updatedAt: 'desc' } })
    const isPaused = queueSettings?.isPaused || false

    // Get active counters for the agency
    // Phantom Counter Protection: only count counters with recent activity (≤45 min)
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const allActiveCounters = await db.counter.findMany({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
      select: { id: true },
    })
    const totalActiveCounters = allActiveCounters.length

    // Count people ahead in the queue
    const waitingReservations = await db.reservation.findMany({
      where: { agencyId, serviceId: reservation.serviceId, status: 'WAITING' },
      orderBy: { queueNumber: 'asc' },
      select: { id: true, queueNumber: true, joinedAt: true, fixedTimeEnabled: true, preferredTime: true, createdAt: true },
    })

    const activeWaiting = filterGhostTickets(waitingReservations)
    const immediateWaiting = filterImmediateServiceWindow(activeWaiting)
    const peopleAhead = immediateWaiting.filter(r => r.queueNumber < reservation.queueNumber).length

    // Calculate ETA
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
    const effective = getEffectiveServiceTime(recentCompleted, reservation.agency.averageServiceTime || 10)

    const eta = calculateETA({
      peopleAhead: reservation.status === 'CALLED' ? 0 : peopleAhead,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: Math.max(1, totalActiveCounters),
      historicalVarianceFactor: effective.varianceFactor,
      isPaused,
      historicalSampleSize: effective.sampleSize,
    })

    // Currently serving number
    const currentServing = await db.reservation.findFirst({
      where: { agencyId, status: { in: ['CALLED', 'SERVED'] }, calledAt: { not: null } },
      orderBy: { calledAt: 'desc' },
      select: { displayNumber: true },
    })

    return c.json({
      success: true,
      tracking: {
        reservationId: reservation.id,
        displayNumber: reservation.displayNumber,
        status: reservation.status,
        position: reservation.status === 'CALLED' ? 1 : peopleAhead + 1,
        peopleAhead: reservation.status === 'CALLED' ? 0 : peopleAhead,
        currentServingNumber: currentServing?.displayNumber || '0',
        estimatedWaitRange: {
          minMinutes: eta.estimatedMinMinutes,
          maxMinutes: eta.estimatedMaxMinutes,
          confidence: eta.confidence,
        },
        agency: reservation.agency,
        service: reservation.service,
        isPaused,
        joinedAt: reservation.joinedAt,
        calledAt: reservation.calledAt,
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const queueRoutes = app
