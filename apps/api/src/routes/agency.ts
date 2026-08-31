import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireAgencyAccess, requireResourceOwnership, resolveUserAgencyId, authErrorResponse, verifyAgencyOwnership, AuthError } from '../lib/auth'
import { validateBody, createAnnouncementSchema, createBranchSchema, updateBranchSchema, createCounterSchema, updateCounterSchema, updateAgencyProfileSchema, updateAgencySettingsSchema, createServiceSchema, updateServiceSchema, updateStaffSchema, createStaffSchema, createReviewSchema, subscriptionPaySchema, subscriptionUnsubscribeSchema, updateWorkingHoursSchema, createHardwareOrderSchema, createEnterpriseRequestSchema } from '../lib/validations'
import { emitQueueEvent, emitNotificationEvent, emitKioskEvent, emitReservationEvent, emitAgencyEvent, emitStaffEvent } from '../lib/realtime-emit'
import { getNextCustomerToCall } from '../lib/queue-scheduler'
import { checkRateLimit, RateLimitError, QUEUE_RATE_LIMIT } from '../lib/rate-limit'
import { getTodayStart, getTodayEnd } from '../lib/date-utils'
import { hashPassword } from '../lib/password'
import { calculateETA, getEffectiveServiceTime } from '../lib/eta-calculator'
import { z } from 'zod'
import QRCode from 'qrcode'

const app = new Hono()

// ─── Subscription expiry helper ──────────────────────────────────────────────
//
// Checks if an agency's subscription has expired and, if so, lazily flips the
// subscriptionStatus to 'EXPIRED' in the DB (so the rest of the app — agency
// dashboard, queue routes, kiosk — sees a consistent state without needing a
// cron job). Also returns human-friendly fields (daysRemaining, isExpiringSoon)
// that the subscription page renders directly.

async function checkSubscriptionExpiry(agencyId: string) {
  const agency = await db.agency.findUnique({
    where: { id: agencyId },
    select: {
      subscriptionStatus: true,
      subscriptionStartsAt: true,
      subscriptionExpiresAt: true,
      subscriptionTier: true,
      subscriptionPlanId: true,
    },
  })

  if (!agency) return null

  const now = new Date()
  const isExpired = agency.subscriptionExpiresAt
    ? agency.subscriptionExpiresAt < now
    : false

  // Auto-update status to EXPIRED if the expiry date has passed
  if (isExpired && agency.subscriptionStatus === 'ACTIVE') {
    await db.agency.update({
      where: { id: agencyId },
      data: { subscriptionStatus: 'EXPIRED' },
    })
    agency.subscriptionStatus = 'EXPIRED'
  }

  // Calculate days remaining (null = no expiry / ONE_TIME plan)
  let daysRemaining: number | null = null
  let isExpiringSoon = false
  if (agency.subscriptionExpiresAt) {
    const diffMs = agency.subscriptionExpiresAt.getTime() - now.getTime()
    daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)))
    isExpiringSoon = daysRemaining <= 7 && daysRemaining > 0
  }

  return {
    status: agency.subscriptionStatus,
    isExpired,
    isExpiringSoon,
    daysRemaining,
    subscriptionStartsAt: agency.subscriptionStartsAt?.toISOString() ?? null,
    subscriptionExpiresAt: agency.subscriptionExpiresAt?.toISOString() ?? null,
    subscriptionTier: agency.subscriptionTier,
  }
}

// ─── Phase 2c: Cross-tenant agencyId ownership verification ─────────────────
//
// Prevents a staff member of Agency A from accessing/modifying Agency B's data
// by sending a different agencyId in the request body/params.
//
// While `requireAgencyAccess` already performs a DB-level ownership check via
// `verifyAgencyOwnership`, this helper provides an explicit, clearly documented
// second layer of defense-in-depth. It is called in every agency route that
// accepts an agencyId from the request.
//
async function ensureAgencyIdOwnership(
  c: import('hono').Context,
  requestedAgencyId: string,
): Promise<void> {
  const user = await requireAuth(c)
  // SUPER_ADMIN may access any agency — no ownership restriction
  if (user.role === 'SUPER_ADMIN') return
  // Customers should never reach agency routes (requireAgencyAccess blocks them)
  if (user.role === 'CUSTOMER') return
  // DB-level ownership check: verifies the user actually belongs to this agency
  const ownership = await verifyAgencyOwnership(user.id, requestedAgencyId)
  if (!ownership) {
    console.warn(
      `[SECURITY] Cross-tenant attempt: user=${user.id} role=${user.role} ` +
      `tried to access agencyId=${requestedAgencyId}`,
    )
    throw new AuthError('You do not have access to this agency', 403)
  }
}

// ─── agency/activity ──────────────────────────────────────────────────────────

app.get('/activity', async (c) => {
  try {
    let agencyId = c.req.query('agencyId')

    // Fall back to session user's agencyId if not provided
    if (!agencyId) {
      const user = await requireAuth(c)
      agencyId = await resolveUserAgencyId(user)
      if (!agencyId) {
        return c.json({ success: false, error: 'agencyId is required' }, 400)
      }
    } else {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyId)
    }

    await requireAgencyAccess(c, agencyId)

    // Fetch recent reservations with user info, limited to last 10
    const reservations = await db.reservation.findMany({
      where: { agencyId },
      include: {
        user: {
          select: { id: true, fullName: true, username: true },
        },
        service: {
          select: { name: true, nameAr: true, nameFr: true },
        },
      },
      orderBy: { joinedAt: 'desc' },
      take: 10,
    })

    // Transform into activity events
    const events = reservations.map((r) => {
      let eventType: string
      let eventKey: string

      switch (r.status) {
        case 'WAITING':
          eventType = 'joined'
          eventKey = 'customerJoinedQueue'
          break
        case 'CALLED':
          eventType = 'called'
          eventKey = 'customerWasCalled'
          break
        case 'COMPLETED':
          eventType = 'completed'
          eventKey = 'customerCompletedService'
          break
        case 'CANCELLED':
          eventType = 'cancelled'
          eventKey = 'customerCancelledRes'
          break
        case 'NO_SHOW':
          eventType = 'cancelled'
          eventKey = 'customerCancelledRes'
          break
        default:
          eventType = 'joined'
          eventKey = 'customerJoinedQueue'
      }

      return {
        id: r.id,
        eventType,
        eventKey,
        customerName: r.user?.fullName || r.user?.username || 'Unknown',
        queueNumber: r.displayNumber || r.queueNumber,
        timestamp: r.joinedAt,
        serviceName: r.service?.name,
      }
    })

    return c.json({ success: true, events })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/analytics ─────────────────────────────────────────────────────────

app.get('/analytics', async (c) => {
  try {
    let agencyId = c.req.query('agencyId')
    // Fall back to session user's agencyId if not provided
    if (!agencyId) {
      const user = await requireAuth(c)
      agencyId = await resolveUserAgencyId(user)
      if (!agencyId) {
        return c.json({ error: 'agencyId required' }, 400)
      }
    } else {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyId)
    }

    await requireAgencyAccess(c, agencyId)

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) {
      return c.json({ error: 'Agency not found' }, 404)
    }

    // Last 7 days range
    const now = new Date()
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

    // Get completed reservations from last 7 days with calledAt
    const completedReservations = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo, lte: now },
      },
      include: {
        service: {
          select: { id: true, name: true, nameAr: true, nameFr: true },
        },
      },
    })

    // Group by serviceId
    const serviceMap = new Map<string, {
      serviceId: string
      serviceName: string
      serviceNameAr?: string
      serviceNameFr?: string
      totalWaitMs: number
      totalServed: number
      totalRating: number
      ratedCount: number
    }>()

    for (const r of completedReservations) {
      const existing = serviceMap.get(r.serviceId)
      const waitMs = r.calledAt ? r.completedAt!.getTime() - r.joinedAt.getTime() : 0
      const rating = r.rating ?? 0

      if (existing) {
        existing.totalWaitMs += waitMs
        existing.totalServed += 1
        if (rating > 0) {
          existing.totalRating += rating
          existing.ratedCount += 1
        }
      } else {
        serviceMap.set(r.serviceId, {
          serviceId: r.serviceId,
          serviceName: r.service.name,
          serviceNameAr: r.service.nameAr ?? undefined,
          serviceNameFr: r.service.nameFr ?? undefined,
          totalWaitMs: waitMs,
          totalServed: 1,
          totalRating: rating > 0 ? rating : 0,
          ratedCount: rating > 0 ? 1 : 0,
        })
      }
    }

    const services = Array.from(serviceMap.values()).map((s) => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      serviceNameAr: s.serviceNameAr,
      serviceNameFr: s.serviceNameFr,
      avgWaitTime: s.totalServed > 0 ? Math.round(s.totalWaitMs / s.totalServed / 60000) : 0, // in minutes
      totalServed: s.totalServed,
      avgRating: s.ratedCount > 0 ? Math.round((s.totalRating / s.ratedCount) * 10) / 10 : 0,
    }))

    // Sort by total served descending
    services.sort((a, b) => b.totalServed - a.totalServed)

    return c.json({ services })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/announcements ─────────────────────────────────────────────────────

// GET: List active announcements for an agency
app.get('/announcements', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')

    if (!agencyId) {
      return c.json({ error: 'Agency ID required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const announcements = await db.announcement.findMany({
      where: {
        agencyId,
        isActive: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })

    return c.json({ announcements })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST: Create a new announcement
app.post('/announcements', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateBody(createAnnouncementSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, message, type, expiresAt } = validation.data

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const announcement = await db.announcement.create({
      data: {
        agencyId,
        message,
        type: type || 'INFO',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    })

    return c.json({ success: true, announcement })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE: Delete an announcement
app.delete('/announcements', async (c) => {
  try {
    const id = c.req.query('id')

    if (!id) {
      return c.json({ error: 'Announcement ID required' }, 400)
    }

    // Verify the announcement belongs to the user's agency
    const announcement = await db.announcement.findUnique({ where: { id } })
    if (!announcement) {
      return c.json({ error: 'Announcement not found' }, 404)
    }

    await requireAgencyAccess(c, announcement.agencyId)

    await db.announcement.delete({
      where: { id },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/branches ──────────────────────────────────────────────────────────

// GET /agency/branches?agencyId=xxx
app.get('/branches', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      return c.json({ success: false, error: 'agencyId is required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const branches = await db.branch.findMany({
      where: { agencyId },
      include: {
        _count: { select: { counters: true, staff: true } },
      },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    })

    return c.json({ success: true, branches })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /agency/branches
app.post('/branches', async (c) => {
  try {
    const body = await c.req.json()
    const agencyId = body.agencyId as string | undefined
    if (!agencyId) {
      return c.json({ success: false, error: 'agencyId is required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const { data, error } = validateBody(createBranchSchema, body)
    if (error) {
      return c.json({ success: false, error: error.error, details: error.details }, 400)
    }

    // If this branch is set as main, unset other main branches
    if (data.isMain) {
      await db.branch.updateMany({
        where: { agencyId, isMain: true },
        data: { isMain: false },
      })
    }

    const branch = await db.branch.create({
      data: {
        name: data.name,
        nameAr: data.nameAr || null,
        nameFr: data.nameFr || null,
        address: data.address || null,
        phone: data.phone || null,
        isMain: data.isMain,
        agencyId,
      },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', agencyId, {
      action: 'branch-created',
      branchId: branch.id,
    })

    return c.json({ success: true, branch }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/branches/:id ──────────────────────────────────────────────────────

// GET /agency/branches/:id
app.get('/branches/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const branch = await db.branch.findUnique({
      where: { id },
      include: {
        counters: {
          include: {
            staff: { include: { user: { select: { fullName: true, username: true } } } },
            currentReservation: { select: { id: true, displayNumber: true, status: true } },
          },
          orderBy: { number: 'asc' },
        },
        _count: { select: { staff: true } },
      },
    })

    if (!branch) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    await requireAgencyAccess(c, branch.agencyId)

    return c.json({ success: true, branch })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /agency/branches/:id
app.patch('/branches/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    await requireAgencyAccess(c, branch.agencyId)

    const body = await c.req.json()
    const { data, error } = validateBody(updateBranchSchema, body)
    if (error) {
      return c.json({ success: false, error: error.error, details: error.details }, 400)
    }

    // If setting as main, unset other main branches
    if (data.isMain) {
      await db.branch.updateMany({
        where: { agencyId: branch.agencyId, isMain: true },
        data: { isMain: false },
      })
    }

    const updated = await db.branch.update({
      where: { id },
      data,
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', branch.agencyId, {
      action: 'branch-updated',
      branchId: id,
    })

    return c.json({ success: true, branch: updated })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /agency/branches/:id (soft delete)
app.delete('/branches/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const branch = await db.branch.findUnique({ where: { id } })
    if (!branch) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    await requireAgencyAccess(c, branch.agencyId)

    const updated = await db.branch.update({
      where: { id },
      data: { isActive: false },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', branch.agencyId, {
      action: 'branch-deleted',
      branchId: id,
    })

    return c.json({ success: true, branch: updated })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/branches/:id/counters ─────────────────────────────────────────────

// GET /agency/branches/:id/counters
app.get('/branches/:id/counters', async (c) => {
  try {
    const branchId = c.req.param('id')
    const branch = await db.branch.findUnique({ where: { id: branchId } })
    if (!branch) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    await requireAgencyAccess(c, branch.agencyId)

    const counters = await db.counter.findMany({
      where: { branchId },
      include: {
        staff: { include: { user: { select: { fullName: true, username: true } } } },
        currentReservation: { select: { id: true, displayNumber: true, status: true } },
      },
      orderBy: { number: 'asc' },
    })

    return c.json({ success: true, counters })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /agency/branches/:id/counters
app.post('/branches/:id/counters', async (c) => {
  try {
    const branchId = c.req.param('id')
    const branch = await db.branch.findUnique({ where: { id: branchId } })
    if (!branch) {
      return c.json({ success: false, error: 'Branch not found' }, 404)
    }

    await requireAgencyAccess(c, branch.agencyId)

    const body = await c.req.json()
    const { data, error } = validateBody(createCounterSchema, body)
    if (error) {
      return c.json({ success: false, error: error.error, details: error.details }, 400)
    }

    // Check if counter number already exists in this branch
    const existing = await db.counter.findFirst({
      where: { branchId, number: data.number },
    })
    if (existing) {
      return c.json(
        { success: false, error: 'Counter number already exists in this branch' },
        409
      )
    }

    const counter = await db.counter.create({
      data: {
        number: data.number,
        name: data.name,
        nameAr: data.nameAr || null,
        nameFr: data.nameFr || null,
        branchId,
      },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', branch.agencyId, {
      action: 'counter-created',
      counterId: counter.id,
      branchId,
    })

    return c.json({ success: true, counter }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/branches/:id/counters/:counterId ──────────────────────────────────

// PATCH /agency/branches/:id/counters/:counterId
app.patch('/branches/:id/counters/:counterId', async (c) => {
  try {
    const branchId = c.req.param('id')
    const counterId = c.req.param('counterId')
    const counter = await db.counter.findUnique({ where: { id: counterId }, include: { branch: true } })
    if (!counter || counter.branchId !== branchId) {
      return c.json({ success: false, error: 'Counter not found' }, 404)
    }

    await requireAgencyAccess(c, counter.branch.agencyId)

    const body = await c.req.json()
    const { data, error } = validateBody(updateCounterSchema, body)
    if (error) {
      return c.json({ success: false, error: error.error, details: error.details }, 400)
    }

    // If staffId is provided, verify the staff belongs to the same agency
    if (data.staffId) {
      const staff = await db.agencyStaff.findUnique({ where: { id: data.staffId } })
      if (!staff || staff.agencyId !== counter.branch.agencyId) {
        return c.json(
          { success: false, error: 'Staff member not found in this agency' },
          400
        )
      }
    }

    const updated = await db.counter.update({
      where: { id: counterId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.nameAr !== undefined && { nameAr: data.nameAr || null }),
        ...(data.nameFr !== undefined && { nameFr: data.nameFr || null }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
        ...(data.staffId !== undefined && { staffId: data.staffId }),
      },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', counter.branch.agencyId, {
      action: 'counter-updated',
      counterId,
      branchId,
    })

    return c.json({ success: true, counter: updated })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /agency/branches/:id/counters/:counterId (soft delete)
app.delete('/branches/:id/counters/:counterId', async (c) => {
  try {
    const branchId = c.req.param('id')
    const counterId = c.req.param('counterId')
    const counter = await db.counter.findUnique({ where: { id: counterId }, include: { branch: true } })
    if (!counter || counter.branchId !== branchId) {
      return c.json({ success: false, error: 'Counter not found' }, 404)
    }

    await requireAgencyAccess(c, counter.branch.agencyId)

    const updated = await db.counter.update({
      where: { id: counterId },
      data: { isActive: false },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', counter.branch.agencyId, {
      action: 'counter-deleted',
      counterId,
      branchId,
    })

    return c.json({ success: true, counter: updated })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/daily-chart ───────────────────────────────────────────────────────

app.get('/daily-chart', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ success: true, data: [] })
    }

    // Get today's start
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Get all reservations for today for this agency
    const reservations = await db.reservation.findMany({
      where: {
        agencyId,
        joinedAt: { gte: today },
      },
      select: {
        joinedAt: true,
        status: true,
      },
    })

    // Group by hour
    const hourlyData: { hour: number; count: number; completed: number }[] = []

    for (let h = 7; h <= 22; h++) {
      const hourReservations = reservations.filter((r) => {
        const hour = new Date(r.joinedAt).getHours()
        return hour === h
      })
      const completed = hourReservations.filter(
        (r) => r.status === 'COMPLETED'
      ).length

      hourlyData.push({
        hour: h,
        count: hourReservations.length,
        completed,
      })
    }

    return c.json({ success: true, data: hourlyData })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/export-csv ────────────────────────────────────────────────────────

app.get('/export-csv', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')

    if (!agencyId) {
      return c.json({ error: 'Agency ID required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const reservations = await db.reservation.findMany({
      where: { agencyId },
      include: {
        user: { select: { username: true, fullName: true, phoneNumber: true } },
        service: { select: { name: true } },
      },
      orderBy: { joinedAt: 'desc' },
      take: 1000,
    })

    if (reservations.length === 0) {
      return c.json({ error: 'No reservations found' }, 404)
    }

    const header = [
      'Queue Number',
      'Display Number',
      'Status',
      'User',
      'Phone',
      'Service',
      'Estimated Wait (min)',
      'Joined At',
      'Reserved Date',
      'Rating',
    ]

    const rows = reservations.map((r) => [
      String(r.queueNumber),
      r.displayNumber || '',
      r.status,
      r.user?.fullName || r.user?.username || 'Unknown',
      r.user?.phoneNumber || '',
      r.service?.name || 'Unknown',
      String(r.estimatedWait || 0),
      new Date(r.joinedAt).toLocaleString(),
      r.reservedDate || '',
      String(r.rating || ''),
    ])

    const csvContent = [
      header.join(','),
      ...rows.map((row) =>
        row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')
      ),
    ].join('\n')

    return c.body(csvContent, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="blasti-reservations-${new Date().toISOString().split('T')[0]}.csv"`,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/no-show-analytics ─────────────────────────────────────────────────

/**
 * GET /agency/no-show-analytics?agencyId=XXX&period=30
 * Returns no-show statistics and trends for the agency
 * Query params: agencyId (required), period (optional, default 30 days)
 */
app.get('/no-show-analytics', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      return c.json({ error: 'agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const periodDays = parseInt(c.req.query('period') || '30', 10)
    const periodAgo = new Date()
    periodAgo.setDate(periodAgo.getDate() - periodDays)

    const [totalReservations, noShows, cancelled] = await Promise.all([
      db.reservation.count({
        where: { agencyId, joinedAt: { gte: periodAgo } },
      }),
      db.reservation.count({
        where: { agencyId, status: 'NO_SHOW', joinedAt: { gte: periodAgo } },
      }),
      db.reservation.count({
        where: { agencyId, status: 'CANCELLED', joinedAt: { gte: periodAgo } },
      }),
    ])

    const noShowRate = totalReservations > 0 ? Math.round((noShows / totalReservations) * 100) : 0
    const cancelRate = totalReservations > 0 ? Math.round((cancelled / totalReservations) * 100) : 0

    const dailyStats = await db.$queryRaw<Array<{ date: string; total: number; noShows: number }>>`
      SELECT 
        DATE(joinedAt) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows
      FROM Reservation
      WHERE agencyId = ${agencyId}
        AND joinedAt >= ${periodAgo}
      GROUP BY DATE(joinedAt)
      ORDER BY date ASC
    `

    const serviceStats = await db.$queryRaw<
      Array<{ serviceId: string; serviceName: string; total: number; noShows: number }>
    >`
      SELECT 
        r.serviceId,
        s.name as serviceName,
        COUNT(*) as total,
        SUM(CASE WHEN r.status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows
      FROM Reservation r
      JOIN Service s ON r.serviceId = s.id
      WHERE r.agencyId = ${agencyId}
        AND r.joinedAt >= ${periodAgo}
      GROUP BY r.serviceId, s.name
      ORDER BY noShows DESC
      LIMIT 10
    `

    const hourlyStats = await db.$queryRaw<Array<{ hour: number; total: number; noShows: number }>>`
      SELECT 
        CAST(strftime('%H', joinedAt) AS INTEGER) as hour,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'NO_SHOW' THEN 1 ELSE 0 END) as noShows
      FROM Reservation
      WHERE agencyId = ${agencyId}
        AND joinedAt >= ${periodAgo}
      GROUP BY hour
      ORDER BY hour ASC
    `

    const reclaimedNoShows = await db.reservation.count({
      where: {
        agencyId,
        status: 'NO_SHOW',
        skippedForNoShow: true,
        reclaimRequestedAt: { not: null },
        joinedAt: { gte: periodAgo },
      },
    })

    return c.json({
      success: true,
      analytics: {
        summary: {
          totalReservations,
          noShows,
          cancelled,
          noShowRate,
          cancelRate,
          reclaimedNoShows,
          reclaimRate: noShows > 0 ? Math.round((reclaimedNoShows / noShows) * 100) : 0,
        },
        dailyTrend: dailyStats.map((d) => ({
          date: d.date,
          total: Number(d.total),
          noShows: Number(d.noShows),
          rate: Number(d.total) > 0 ? Math.round((Number(d.noShows) / Number(d.total)) * 100) : 0,
        })),
        byService: serviceStats.map((s) => ({
          serviceId: s.serviceId,
          serviceName: s.serviceName,
          total: Number(s.total),
          noShows: Number(s.noShows),
          rate: Number(s.total) > 0 ? Math.round((Number(s.noShows) / Number(s.total)) * 100) : 0,
        })),
        byHour: hourlyStats.map((h) => ({
          hour: Number(h.hour),
          total: Number(h.total),
          noShows: Number(h.noShows),
          rate: Number(h.total) > 0 ? Math.round((Number(h.noShows) / Number(h.total)) * 100) : 0,
        })),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/peak-hours ────────────────────────────────────────────────────────

/**
 * GET /agency/peak-hours?agencyId=XXX
 * Returns peak-hour analysis and demand patterns for the agency
 */
app.get('/peak-hours', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      return c.json({ error: 'agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    // Hourly demand distribution
    const hourlyDemand = await db.$queryRaw<Array<{ hour: number; count: number; avgWait: number }>>`
      SELECT 
        CAST(strftime('%H', joinedAt) AS INTEGER) as hour,
        COUNT(*) as count,
        COALESCE(AVG(estimatedWait), 0) as avgWait
      FROM Reservation
      WHERE agencyId = ${agencyId}
        AND joinedAt >= ${thirtyDaysAgo}
      GROUP BY hour
      ORDER BY hour ASC
    `

    // Day of week demand
    const weekdayDemand = await db.$queryRaw<Array<{ weekday: number; count: number; avgWait: number }>>`
      SELECT 
        CAST(strftime('%w', joinedAt) AS INTEGER) as weekday,
        COUNT(*) as count,
        COALESCE(AVG(estimatedWait), 0) as avgWait
      FROM Reservation
      WHERE agencyId = ${agencyId}
        AND joinedAt >= ${thirtyDaysAgo}
      GROUP BY weekday
      ORDER BY weekday ASC
    `

    // Peak hours by service
    const servicePeakHours = await db.$queryRaw<
      Array<{ serviceId: string; serviceName: string; peakHour: number; count: number }>
    >`
      SELECT 
        r.serviceId,
        s.name as serviceName,
        CAST(strftime('%H', r.joinedAt) AS INTEGER) as peakHour,
        COUNT(*) as count
      FROM Reservation r
      JOIN Service s ON r.serviceId = s.id
      WHERE r.agencyId = ${agencyId}
        AND r.joinedAt >= ${thirtyDaysAgo}
      GROUP BY r.serviceId, s.name, peakHour
      ORDER BY r.serviceId, count DESC
    `

    // Find top 3 peak hours
    const peakHours = hourlyDemand
      .map((h) => ({ hour: Number(h.hour), count: Number(h.count), avgWait: Number(h.avgWait) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)

    // Busiest weekday
    const busiestDay =
      weekdayDemand.length > 0
        ? weekdayDemand
            .map((d) => ({
              weekday: Number(d.weekday),
              count: Number(d.count),
              avgWait: Number(d.avgWait),
            }))
            .sort((a, b) => b.count - a.count)[0]
        : null

    // Daily average wait time trend (past 30 days)
    const dailyWaitTrend = await db.$queryRaw<Array<{ date: string; avgWait: number; count: number }>>`
      SELECT 
        DATE(joinedAt) as date,
        COALESCE(AVG(estimatedWait), 0) as avgWait,
        COUNT(*) as count
      FROM Reservation
      WHERE agencyId = ${agencyId}
        AND joinedAt >= ${thirtyDaysAgo}
      GROUP BY DATE(joinedAt)
      ORDER BY date ASC
    `

    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

    return c.json({
      success: true,
      analytics: {
        peakHours,
        busiestDay: busiestDay
          ? { ...busiestDay, name: weekdayNames[busiestDay.weekday] }
          : null,
        hourlyDemand: hourlyDemand.map((h) => ({
          hour: Number(h.hour),
          count: Number(h.count),
          avgWait: Math.round(Number(h.avgWait)),
        })),
        weekdayDemand: weekdayDemand.map((d) => ({
          weekday: Number(d.weekday),
          name: weekdayNames[Number(d.weekday)],
          count: Number(d.count),
          avgWait: Math.round(Number(d.avgWait)),
        })),
        servicePeakHours: servicePeakHours.map((s) => ({
          serviceId: s.serviceId,
          serviceName: s.serviceName,
          peakHour: Number(s.peakHour),
          count: Number(s.count),
        })),
        dailyWaitTrend: dailyWaitTrend.map((d) => ({
          date: d.date,
          avgWait: Math.round(Number(d.avgWait)),
          count: Number(d.count),
        })),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/profile ───────────────────────────────────────────────────────────

app.get('/profile', async (c) => {
  try {
    const agencyIdParam = c.req.query('agencyId')

    let agencyId: string | null
    if (agencyIdParam) {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyIdParam)
      await requireAgencyAccess(c, agencyIdParam)
      agencyId = agencyIdParam
    } else {
      const user = await requireAuth(c)
      agencyId = user.agencyId || await resolveUserAgencyId(user)
    }

    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 404)
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      include: { queueSettings: { take: 1 } },
    })

    if (!agency) {
      return c.json({ error: 'No agency found' }, 404)
    }

    return c.json({
      id: agency.id,
      name: agency.name,
      nameAr: agency.nameAr,
      nameFr: agency.nameFr,
      address: agency.address,
      category: agency.category,
      phone: agency.phone,
      email: agency.email,
      code: agency.customCode,
      logoUrl: agency.logoUrl,
      workingHoursStart: agency.workingHoursStart,
      workingHoursEnd: agency.workingHoursEnd,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.patch('/profile', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateBody(updateAgencyProfileSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId: agencyIdParam } = body
    const validatedData = validation.data

    let agencyId: string | null
    if (agencyIdParam) {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyIdParam)
      await requireAgencyAccess(c, agencyIdParam)
      agencyId = agencyIdParam
    } else {
      const user = await requireAuth(c)
      agencyId = user.agencyId || await resolveUserAgencyId(user)
    }

    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 404)
    }

    const targetAgency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!targetAgency) return c.json({ error: 'No agency found' }, 404)

    await db.agency.update({
      where: { id: targetAgency.id },
      data: {
        ...(validatedData.name !== undefined && { name: validatedData.name }),
        ...(validatedData.nameAr !== undefined && { nameAr: validatedData.nameAr }),
        ...(validatedData.nameFr !== undefined && { nameFr: validatedData.nameFr }),
        ...(validatedData.description !== undefined && { description: validatedData.description }),
        ...(validatedData.descriptionAr !== undefined && { descriptionAr: validatedData.descriptionAr }),
        ...(validatedData.descriptionFr !== undefined && { descriptionFr: validatedData.descriptionFr }),
        ...(validatedData.address !== undefined && { address: validatedData.address }),
        ...(validatedData.phone !== undefined && { phone: validatedData.phone }),
        ...(validatedData.category !== undefined && { category: validatedData.category }),
        ...(validatedData.website !== undefined && { website: validatedData.website }),
      },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', targetAgency.id, {
      action: 'profile-updated',
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/qr-code ───────────────────────────────────────────────────────────

app.get('/qr-code', async (c) => {
  try {
    // Require authentication to generate QR code
    await requireAuth(c)

    const code = c.req.query('code')

    if (!code) {
      return c.json(
        { success: false, error: 'code query param is required' },
        400
      )
    }

    // Encode as a URL so phone scanners can open it as a clickable link
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz'
    const qrData = `${baseUrl}/?code=${code}`

    const svgString = await QRCode.toString(qrData, {
      type: 'svg',
      width: 256,
      margin: 2,
      color: {
        dark: '#047857',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    })

    return c.body(svgString, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/queue ─────────────────────────────────────────────────────────────

app.get('/queue', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    const statusParam = c.req.query('status') || 'WAITING,CALLED'
    const statuses = statusParam.split(',').filter(Boolean)

    if (!agencyId) {
      return c.json({ error: 'agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const reservations = await db.reservation.findMany({
      where: {
        agencyId,
        status: { in: statuses },
      },
      include: {
        user: { select: { id: true, fullName: true, username: true, phoneNumber: true, avatarUrl: true } },
        service: { select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
      },
      orderBy: { queueNumber: 'asc' },
    })

    // Calculate position for each reservation
    const waitingReservations = reservations.filter(r => r.status === 'WAITING')
    const entries = reservations.map((res) => ({
      id: res.id,
      queueNumber: res.displayNumber,
      customerName: res.isWalkIn ? (res.walkInCustomerName || 'Walk-in') : (res.user?.fullName || res.user?.username || 'Unknown'),
      customerPhone: res.user?.phoneNumber || null,
      customerAvatar: res.user?.avatarUrl || null,
      serviceName: res.service.name,
      serviceNameAr: res.service.nameAr,
      serviceNameFr: res.service.nameFr,
      joinedAt: res.joinedAt.toISOString(),
      status: res.status,
      position: res.status === 'WAITING' ? waitingReservations.indexOf(res) + 1 : 0,
      isWalkIn: res.isWalkIn,
      walkInCustomerName: res.walkInCustomerName,
      importToken: res.isWalkIn ? (res.importToken || null) : null,
      preferredTime: res.preferredTime,
      fixedTimeEnabled: res.fixedTimeEnabled,
      postponeCount: res.postponeCount,
    }))

    return c.json({ entries })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/queue/call-next (MUST be before /agency/queue/:id) ────────────────

app.post('/queue/call-next', async (c) => {
  try {
    const { agencyId, serviceId, counterId } = await c.req.json()

    if (!agencyId) {
      return c.json({ error: 'agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    const user = await requireAgencyAccess(c, agencyId)

    // Rate limit by user ID
    checkRateLimit(user.id, QUEUE_RATE_LIMIT)

    // Check agency has an active subscription
    const agencyCheck = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agencyCheck) {
      return c.json({ error: 'Agency not found' }, 404)
    }
    if (agencyCheck.subscriptionStatus !== 'ACTIVE') {
      return c.json(
        { error: 'An active subscription is required to use queue features' },
        403
      )
    }

    // Check if queue is paused
    const queueSettings = await db.queueSettings.findFirst({ where: { agencyId } })
    if (queueSettings?.isPaused) {
      return c.json({ error: 'Queue is paused' }, 400)
    }

    // Validate counterId if provided — must belong to the agency's branch
    let targetCounter: { id: string; currentReservationId: string | null } | null = null
    if (counterId) {
      targetCounter = await db.counter.findFirst({
        where: {
          id: counterId,
          branch: { agencyId },
          isActive: true,
        },
        select: { id: true, currentReservationId: true },
      })
      if (!targetCounter) {
        return c.json({ error: 'Counter not found or inactive' }, 404)
      }
    }

    // Use transaction to prevent double-calling
    // Returns both the next reservation and any auto-completed entries
    const { nextReservation: next, autoCompleted } = await db.$transaction(async (tx) => {
      // ─── Auto-complete the PREVIOUS customer for THIS counter only ───
      // Scoping to counterId ensures multiple receptions can serve simultaneously
      const completedEntries: { id: string; displayNumber: string }[] = []

      if (counterId) {
        // Per-counter auto-complete: find CALLED reservations for this specific counter
        const counterCalled = await tx.reservation.findMany({
          where: { counterId, status: 'CALLED' },
          select: { id: true, displayNumber: true },
        })
        for (const called of counterCalled) {
          await tx.reservation.update({
            where: { id: called.id },
            data: { status: 'COMPLETED', completedAt: new Date() },
          })
          await tx.auditLog.create({
            data: {
              action: 'QUEUE_AUTO_COMPLETE',
              entityType: 'RESERVATION',
              entityId: called.id,
              details: JSON.stringify({
                displayNumber: called.displayNumber,
                agencyId,
                counterId,
                reason: 'Auto-completed when counter called next customer',
              }),
            },
          })
          completedEntries.push({ id: called.id, displayNumber: called.displayNumber })
        }
      }

      // Get all WAITING reservations for this agency, ordered by queueNumber
      const waitingReservations = await tx.reservation.findMany({
        where: {
          agencyId,
          status: 'WAITING',
          ...(serviceId ? { serviceId } : {}),
        },
        orderBy: { queueNumber: 'asc' },
        select: {
          id: true,
          queueNumber: true,
          preferredTime: true,
          fixedTimeEnabled: true,
        },
      })

      // Use queue scheduler to find next customer (respects preferred times)
      const nextId = getNextCustomerToCall(waitingReservations)
      if (!nextId) return { nextReservation: null, autoCompleted: completedEntries }

      const candidate = await tx.reservation.findUnique({
        where: { id: nextId },
        include: {
          service: true,
          user: { select: { id: true, fullName: true } },
        },
      })
      if (!candidate) return { nextReservation: null, autoCompleted: completedEntries }

      // Re-check status inside transaction
      const recheck = await tx.reservation.findUnique({ where: { id: candidate.id } })
      if (!recheck || recheck.status !== 'WAITING') return { nextReservation: null, autoCompleted: completedEntries }

      await processCandidate(tx, candidate, queueSettings, agencyId, counterId ?? undefined)
      return { nextReservation: candidate, autoCompleted: completedEntries }
    })

    const nextReservation = next

    if (!nextReservation) {
      return c.json({ error: 'No customers waiting' }, 404)
    }

    // Emit auto-completed events for previous serving customer
    for (const completed of autoCompleted) {
      emitQueueEvent('queue:completed', agencyId, {
        reservationId: completed.id,
        displayNumber: completed.displayNumber,
        autoCompleted: true,
      })
    }

    // Emit realtime events (non-blocking — fire and forget)
    emitQueueEvent('queue:called', agencyId, {
      reservationId: nextReservation.id,
      displayNumber: nextReservation.displayNumber,
      customerName: (nextReservation as any).walkInCustomerName || (nextReservation as any).user?.fullName || '',
      isWalkIn: !!(nextReservation as any).isWalkIn,
      serviceId: nextReservation.serviceId,
    })
    if (nextReservation.userId) {
      emitNotificationEvent('notification:your-turn', nextReservation.userId, {
        ticketNumber: nextReservation.displayNumber,
        agencyId,
      })
    }
    emitKioskEvent(agencyId, {
      nowServing: nextReservation.displayNumber,
      action: 'called',
    })

    return c.json({
      success: true,
      autoCompleted: autoCompleted.length > 0 ? autoCompleted.map(c => ({ id: c.id, displayNumber: c.displayNumber })) : undefined,
      reservation: {
        id: nextReservation.id,
        displayNumber: nextReservation.displayNumber,
        customerName: (nextReservation as any).walkInCustomerName || (nextReservation as any).user?.fullName || '',
        isWalkIn: !!(nextReservation as any).isWalkIn,
      },
    })
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      return c.json(
        { success: false, error: error.message, retryAfter: error.retryAfter },
        429
      )
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/queue/toggle-pause (MUST be before /agency/queue/:id) ─────────────

app.post('/queue/toggle-pause', async (c) => {
  try {
    const body = await c.req.json()
    const agencyIdSchema = z.object({
      agencyId: z.string().min(1, 'Agency ID is required'),
    })
    const validation = validateBody(agencyIdSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId } = validation.data

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    // Check agency has an active subscription
    const agencyCheck = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agencyCheck) {
      return c.json({ error: 'Agency not found' }, 404)
    }
    if (agencyCheck.subscriptionStatus !== 'ACTIVE') {
      return c.json(
        { error: 'An active subscription is required to use queue features' },
        403
      )
    }

    const queueSettings = await db.queueSettings.findFirst({ where: { agencyId } })
    if (!queueSettings) {
      return c.json({ error: 'Queue settings not found' }, 404)
    }

    const newPausedState = !queueSettings.isPaused

    await db.queueSettings.update({
      where: { id: queueSettings.id },
      data: {
        isPaused: newPausedState,
        pausedAt: newPausedState ? new Date() : null,
        updatedAt: new Date(),
      },
    })

    await db.auditLog.create({
      data: {
        action: newPausedState ? 'QUEUE_PAUSE' : 'QUEUE_RESUME',
        entityType: 'AGENCY',
        entityId: agencyId,
        details: JSON.stringify({ paused: newPausedState }),
      },
    })

    // Emit realtime events (non-blocking — fire and forget)
    emitQueueEvent(newPausedState ? 'queue:paused' : 'queue:resumed', agencyId, {
      isPaused: newPausedState,
    })
    emitKioskEvent(agencyId, {
      isPaused: newPausedState,
      action: newPausedState ? 'paused' : 'resumed',
    })

    return c.json({ success: true, isPaused: newPausedState })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/queue/walk-in (MUST be before /agency/queue/:id) ──────────────────

app.post('/queue/walk-in', async (c) => {
  try {
    const body = await c.req.json()
    const walkInSchema = z.object({
      agencyId: z.string().min(1, 'Agency ID is required'),
      serviceId: z.string().optional(),
      customerName: z.string().min(1, 'Customer name is required').max(100),
    })
    const validation = validateBody(walkInSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, serviceId, customerName } = validation.data

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    // Check agency exists and queue is open
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      include: { queueSettings: { take: 1, orderBy: { updatedAt: 'desc' } } },
    })

    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    if (!agency.isQueueOpen) {
      return c.json({ success: false, error: 'Queue is currently closed' }, 400)
    }

    if (agency.queueSettings.length > 0 && agency.queueSettings[0].isPaused) {
      return c.json({ success: false, error: 'Queue is currently paused' }, 400)
    }

    // Resolve service
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

    // Check capacity
    const activeCount = await db.reservation.count({
      where: { agencyId, status: { in: ['WAITING', 'CALLED'] } },
    })

    if (activeCount >= agency.maxActiveReservations) {
      return c.json({ success: false, error: 'Queue is full' }, 400)
    }

    // ── Unified ETA: use the same advanced engine as the mobile app ──
    const waitingCount = await db.reservation.count({
      where: { agencyId, status: 'WAITING' },
    })
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
    const fortyFiveMinsAgo = new Date(Date.now() - 45 * 60 * 1000)
    const activeCounters = await db.counter.count({
      where: {
        isActive: true,
        staffId: { not: null },
        branch: { agencyId, isActive: true },
        updatedAt: { gte: fortyFiveMinsAgo },
      },
    })
    const isPausedWalkIn = agency.queueSettings.length > 0 ? agency.queueSettings[0].isPaused : false
    const eta = calculateETA({
      peopleAhead: waitingCount,
      avgServiceTimeMinutes: effective.avgMinutes,
      activeCounters: activeCounters || 1,
      historicalVarianceFactor: effective.varianceFactor,
      isPaused: isPausedWalkIn,
      historicalSampleSize: effective.sampleSize,
    })
    const estimatedWait = eta.estimatedMaxMinutes

    // Create walk-in reservation atomically
    const reservation = await db.$transaction(async (tx) => {
      // Re-check capacity
      const cnt = await tx.reservation.count({
        where: { agencyId, status: { in: ['WAITING', 'CALLED'] } },
      })
      if (cnt >= agency.maxActiveReservations) throw new Error('FULL')

      const lastReservation = await tx.reservation.findFirst({
        where: { serviceId: resolvedServiceId },
        orderBy: { queueNumber: 'desc' },
      })
      const nextNumber = (lastReservation?.queueNumber || 0) + 1
      const displayNumber = `${service.prefix}-${String(nextNumber).padStart(3, '0')}`

      const res = await tx.reservation.create({
        data: {
          agencyId,
          serviceId: resolvedServiceId,
          queueNumber: nextNumber,
          displayNumber,
          status: 'WAITING',
          estimatedWait,
          isWalkIn: true,
          walkInCustomerName: customerName.trim(),
          userId: null,
        },
        include: {
          agency: { select: { id: true, name: true, nameFr: true, nameAr: true } },
          service: { select: { id: true, name: true, nameFr: true, nameAr: true, prefix: true } },
        },
      })

      // Update queue settings
      if (agency.queueSettings.length > 0) {
        await tx.queueSettings.update({
          where: { id: agency.queueSettings[0].id },
          data: { lastIssuedNumber: nextNumber },
        })
      }

      // Create audit log
      await tx.auditLog.create({
        data: {
          action: 'WALK_IN_ADDED',
          entityType: 'RESERVATION',
          entityId: res.id,
          details: JSON.stringify({
            agencyId,
            serviceId: resolvedServiceId,
            displayNumber,
            customerName: customerName.trim(),
            estimatedWait,
          }),
        },
      })

      return res
    })

    // Generate import token OUTSIDE the transaction (inline to avoid dynamic import issues)
    let importToken = ''
    try {
      const crypto = require('crypto')
      const QR_SECRET = process.env.NEXTAUTH_SECRET || 'blast1-qr-dev-key'
      const exp = Math.floor(Date.now() / 1000) + (30 * 60)
      const payload = JSON.stringify({ reservationId: reservation.id, agencyId, customerId: customerName.trim(), exp })
      const sig = crypto.createHmac('sha256', QR_SECRET).update(payload).digest('hex')
      importToken = Buffer.from(payload).toString('base64url') + '.' + sig
      await db.reservation.update({ where: { id: reservation.id }, data: { importToken } })
    } catch (tokenErr) { console.warn('[Walk-in] Failed to generate import token:', tokenErr) }

    // Emit realtime events (non-blocking — fire and forget)
    emitQueueEvent('queue:walk-in', agencyId, {
      reservationId: reservation.id,
      displayNumber: reservation.displayNumber,
      customerName: customerName.trim(),
      serviceId: resolvedServiceId,
      estimatedWait,
    })
    emitReservationEvent('reservation:created', agencyId, undefined, {
      reservationId: reservation.id,
      displayNumber: reservation.displayNumber,
      isWalkIn: true,
      customerName: customerName.trim(),
      serviceId: resolvedServiceId,
    })
    emitKioskEvent(agencyId, {
      action: 'walk-in',
      displayNumber: reservation.displayNumber,
    })

    return c.json({ success: true, reservation: { ...reservation, importToken }, importToken }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/queue/walk-in-token (Generate import token for walk-in) ────────────
app.post('/queue/walk-in-token', async (c) => {
  try {
    const body = await c.req.json()
    const schema = z.object({
      reservationId: z.string().min(1, 'Reservation ID is required'),
    })
    const validation = validateBody(schema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error }, 400)
    }

    const { reservationId } = validation.data
    const user = await requireAuth(c)
    if (!user) return authErrorResponse(c, 'Authentication required')

    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      include: { agency: { select: { id: true } } },
    })

    if (!reservation) {
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    // Must be a walk-in reservation
    if (!reservation.isWalkIn) {
      return c.json({ success: false, error: 'This endpoint is only for walk-in reservations' }, 400)
    }

    // Agency ownership check
    await ensureAgencyIdOwnership(c, reservation.agencyId)
    await requireAgencyAccess(c, reservation.agencyId)

    // Generate import token (customerId = walk-in name for identification)
    const crypto = require('crypto')
    const QR_SECRET = process.env.NEXTAUTH_SECRET || 'blast1-qr-dev-key'
    const exp2 = Math.floor(Date.now() / 1000) + (30 * 60)
    const payload2 = JSON.stringify({ reservationId: reservation.id, agencyId: reservation.agencyId, customerId: reservation.walkInCustomerName || '', exp: exp2 })
    const sig2 = crypto.createHmac('sha256', QR_SECRET).update(payload2).digest('hex')
    const token = Buffer.from(payload2).toString('base64url') + '.' + sig2

    // Save token to reservation
    await db.reservation.update({
      where: { id: reservationId },
      data: { importToken: token },
    })

    return c.json({ success: true, token })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/queue/:id ─────────────────────────────────────────────────────────

app.patch('/queue/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const queueActionSchema = z.object({
      action: z.enum(['complete', 'no_show', 'cancel']),
    })
    const validation = validateBody(queueActionSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { action } = validation.data

    const reservation = await db.reservation.findUnique({
      where: { id },
      select: {
        id: true,
        agencyId: true,
        status: true,
        displayNumber: true,
        userId: true,
        counterId: true,
        agency: { select: { id: true, name: true, nameFr: true, nameAr: true } },
      },
    })
    if (!reservation) {
      return c.json({ error: 'Reservation not found' }, 404)
    }

    // Verify the authenticated user has access to this reservation's agency
    await requireAgencyAccess(c, reservation.agencyId)

    const statusMap: Record<string, string> = {
      complete: 'COMPLETED',
      no_show: 'NO_SHOW',
      cancel: 'CANCELLED',
    }

    const status = statusMap[action]
    const updateData: Record<string, unknown> = {
      status,
      completedAt: action === 'complete' ? new Date() : undefined,
      cancelledAt: action === 'cancel' ? new Date() : undefined,
    }

    await db.reservation.update({
      where: { id },
      data: updateData,
    })

    // Clear the counter's currentReservationId when this reservation is completed/cancelled/no-show
    if (reservation.counterId) {
      await db.counter.updateMany({
        where: { currentReservationId: id },
        data: { currentReservationId: null },
      })
    }

    // Create notification (only for registered users)
    if (reservation.userId) {
      const agencyName = reservation.agency?.name || 'the agency'
      const number = reservation.displayNumber

      const notificationData: { type: string; title: string; message: string } =
        action === 'cancel'
          ? { type: 'CANCELLED', title: 'Reservation Cancelled by Agency', message: `Your reservation #${number} at ${agencyName} has been cancelled by the agency.` }
          : action === 'complete'
          ? { type: 'COMPLETED', title: 'Service Completed', message: `Your reservation #${number} at ${agencyName} has been marked as completed. Thank you for your visit!` }
          : { type: 'NO_SHOW', title: 'Marked as No-Show', message: `Your reservation #${number} at ${agencyName} has been marked as no-show. Please contact the agency if this is an error.` }

      await db.notification.create({
        data: {
          userId: reservation.userId,
          type: notificationData.type,
          title: notificationData.title,
          message: notificationData.message,
        },
      })
    }

    // Create audit log
    await db.auditLog.create({
      data: {
        userId: reservation.userId ?? undefined,
        action: `QUEUE_${action.toUpperCase()}`,
        entityType: 'RESERVATION',
        entityId: id,
        details: JSON.stringify({ displayNumber: reservation.displayNumber, status }),
      },
    })

    // Emit realtime events (non-blocking — fire and forget)
    const eventType = action === 'complete' ? 'queue:completed'
      : action === 'no_show' ? 'queue:no-show'
      : 'queue:cancelled'

    emitQueueEvent(eventType, reservation.agencyId, {
      reservationId: id,
      displayNumber: reservation.displayNumber,
      action,
      status,
    })
    if (reservation.userId) {
      const agencyName = reservation.agency?.name || 'the agency'
      const notifMessages: Record<string, string> = {
        complete: `Your reservation #${reservation.displayNumber} at ${agencyName} has been completed.`,
        no_show: `Your reservation #${reservation.displayNumber} at ${agencyName} was marked as no-show.`,
        cancel: `Your reservation #${reservation.displayNumber} at ${agencyName} has been cancelled by the agency.`,
      }
      emitNotificationEvent('notification:new', reservation.userId, {
        type: eventType,
        ticketNumber: reservation.displayNumber,
        message: notifMessages[action] || `Your reservation #${reservation.displayNumber} has been updated.`,
      })
    }
    emitKioskEvent(reservation.agencyId, {
      action,
      displayNumber: reservation.displayNumber,
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/reviews ───────────────────────────────────────────────────────────

// GET: List reviews for an agency
app.get('/reviews', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    const page = parseInt(c.req.query('page') || '1', 10)
    const limit = parseInt(c.req.query('limit') || '10', 10)

    if (!agencyId) {
      return c.json({ error: 'agencyId is required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const skip = (page - 1) * limit

    const [reviews, totalReviews] = await Promise.all([
      db.review.findMany({
        where: { agencyId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
            },
          },
        },
      }),
      db.review.count({ where: { agencyId } }),
    ])

    // Calculate average rating
    const ratingAggregation = await db.review.aggregate({
      where: { agencyId },
      _avg: { rating: true },
      _count: { rating: true },
    })

    // Get rating distribution
    const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    const allRatings = await db.review.findMany({
      where: { agencyId },
      select: { rating: true },
    })
    for (const r of allRatings) {
      if (r.rating >= 1 && r.rating <= 5) {
        ratingDistribution[r.rating]++
      }
    }

    const avgRating = ratingAggregation._avg.rating
      ? Math.round(ratingAggregation._avg.rating * 10) / 10
      : 0

    return c.json({
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        replyText: r.replyText,
        repliedAt: r.repliedAt,
        createdAt: r.createdAt,
        user: {
          id: r.user.id,
          fullName: r.user.fullName,
          avatarUrl: r.user.avatarUrl,
        },
      })),
      avgRating,
      totalReviews,
      ratingDistribution,
      hasMore: skip + limit < totalReviews,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST: Create or update a review
app.post('/reviews', async (c) => {
  try {
    const body = await c.req.json()
    const createAgencyReviewSchema = createReviewSchema.extend({
      agencyId: z.string().min(1, 'Agency ID is required'),
    })
    const validation = validateBody(createAgencyReviewSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, rating, comment } = validation.data

    // Derive userId from session, never trust client-provided userId
    const user = await requireAuth(c)
    const userId = user.id

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    // Verify agency access for this review
    await requireAgencyAccess(c, agencyId)

    // Check if user already reviewed this agency
    const existing = await db.review.findUnique({
      where: { userId_agencyId: { userId, agencyId } },
    })

    let review
    if (existing) {
      // Update existing review
      review = await db.review.update({
        where: { id: existing.id },
        data: {
          rating,
          comment: comment || null,
        },
        include: {
          user: {
            select: { id: true, fullName: true, avatarUrl: true },
          },
        },
      })
    } else {
      // Create new review
      review = await db.review.create({
        data: {
          userId,
          agencyId,
          rating,
          comment: comment || null,
        },
        include: {
          user: {
            select: { id: true, fullName: true, avatarUrl: true },
          },
        },
      })
    }

    return c.json({
      review: {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        user: {
          id: review.user.id,
          fullName: review.user.fullName,
          avatarUrl: review.user.avatarUrl,
        },
      },
      updated: !!existing,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE: Delete a review
app.delete('/reviews', async (c) => {
  try {
    const body = await c.req.json()
    const { reviewId } = body

    if (!reviewId) {
      return c.json({ error: 'reviewId is required' }, 400)
    }

    const review = await db.review.findUnique({ where: { id: reviewId } })
    if (!review) {
      return c.json({ error: 'Review not found' }, 404)
    }

    // Use session-derived user to verify ownership instead of trusting client userId
    await requireResourceOwnership(c, review.userId)

    await db.review.delete({ where: { id: reviewId } })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/services ──────────────────────────────────────────────────────────

app.get('/services', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ services: [] })
    }

    const services = await db.service.findMany({
      where: { agencyId, isActive: true },
      orderBy: { createdAt: 'asc' },
    })

    return c.json({ services })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.post('/services', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ error: 'No active agency found' }, 404)
    }

    const body = await c.req.json()
    const validation = validateBody(createServiceSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { name, nameAr, nameFr, description, isActive } = validation.data
    const { prefix } = body

    if (!prefix) {
      return c.json({ error: 'Prefix required' }, 400)
    }

    const service = await db.service.create({
      data: {
        agencyId,
        name,
        nameAr: nameAr || null,
        nameFr: nameFr || null,
        prefix: prefix.toUpperCase(),
        description: description || null,
        isActive: isActive ?? true,
      },
    })

    // Emit realtime events (fire-and-forget)
    emitQueueEvent('queue:settings-updated', agencyId, {
      action: 'service-created',
      serviceId: service.id,
      serviceName: name,
    })
    emitAgencyEvent('agency:updated', agencyId, {
      action: 'service-created',
      serviceId: service.id,
    })

    return c.json({ service, success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/services/:id ──────────────────────────────────────────────────────

app.patch('/services/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 403)
    }

    // Verify the service belongs to the user's agency
    const existingService = await db.service.findUnique({ where: { id } })
    if (!existingService || existingService.agencyId !== agencyId) {
      return c.json({ error: 'Service not found or access denied' }, 404)
    }

    const body = await c.req.json()
    const validation = validateBody(updateServiceSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { name, nameAr, nameFr, description, isActive } = validation.data
    const { prefix } = body

    const service = await db.service.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(nameAr !== undefined && { nameAr }),
        ...(nameFr !== undefined && { nameFr }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
        ...(prefix && { prefix: prefix.toUpperCase() }),
      },
    })

    // Emit realtime events (fire-and-forget)
    emitQueueEvent('queue:settings-updated', agencyId, {
      action: 'service-updated',
      serviceId: id,
    })
    emitAgencyEvent('agency:updated', agencyId, {
      action: 'service-updated',
      serviceId: id,
    })

    return c.json({ service, success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.delete('/services/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 403)
    }

    // Verify the service belongs to the user's agency
    const existingService = await db.service.findUnique({ where: { id } })
    if (!existingService || existingService.agencyId !== agencyId) {
      return c.json({ error: 'Service not found or access denied' }, 404)
    }

    await db.service.update({
      where: { id },
      data: { isActive: false },
    })

    // Emit realtime events (fire-and-forget)
    emitQueueEvent('queue:settings-updated', agencyId, {
      action: 'service-deleted',
      serviceId: id,
    })
    emitAgencyEvent('agency:updated', agencyId, {
      action: 'service-deleted',
      serviceId: id,
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/settings ──────────────────────────────────────────────────────────

app.get('/settings', async (c) => {
  try {
    const agencyIdParam = c.req.query('agencyId')

    let agencyId: string | null
    if (agencyIdParam) {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyIdParam)
      await requireAgencyAccess(c, agencyIdParam)
      agencyId = agencyIdParam
    } else {
      const user = await requireAuth(c)
      agencyId = user.agencyId || await resolveUserAgencyId(user)
    }

    let agency
    if (agencyId) {
      agency = await db.agency.findUnique({
        where: { id: agencyId },
        include: {
          services: {
            where: { isActive: true },
            select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true },
          },
          queueSettings: true,
        },
      })
    } else {
      return c.json({
        avgServiceTime: 10,
        maxReservations: 50,
        isQueueOpen: true,
        services: [],
        workingHoursStart: '08:00',
        workingHoursEnd: '17:00',
      })
    }

    if (!agency) {
      return c.json({
        avgServiceTime: 10,
        maxReservations: 50,
        isQueueOpen: true,
        services: [],
        workingHoursStart: '08:00',
        workingHoursEnd: '17:00',
      })
    }

    return c.json({
      avgServiceTime: agency.averageServiceTime,
      maxReservations: agency.maxActiveReservations,
      isQueueOpen: agency.isQueueOpen,
      services: agency.services,
      workingHoursStart: agency.workingHoursStart,
      workingHoursEnd: agency.workingHoursEnd,
      autoPauseWhenFull: agency.autoPauseWhenFull ?? false,
      kioskModeEnabled: agency.kioskModeEnabled ?? false,
      sponsorSms: agency.sponsorSms ?? false,
      smsBalance: agency.smsBalance ?? 0,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

app.patch('/settings', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateBody(updateAgencySettingsSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId: agencyIdParam, isQueueOpen, workingHoursStart, workingHoursEnd, autoPauseWhenFull, kioskModeEnabled, sponsorSms, smsBalance } = body
    const { maxQueueSize, avgServiceTime } = validation.data

    let agencyId: string | null
    if (agencyIdParam) {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyIdParam)
      await requireAgencyAccess(c, agencyIdParam)
      agencyId = agencyIdParam
    } else {
      const user = await requireAuth(c)
      agencyId = user.agencyId || await resolveUserAgencyId(user)
    }

    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 404)
    }

    const targetAgency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!targetAgency) {
      return c.json({ error: 'No agency found' }, 404)
    }

    await db.agency.update({
      where: { id: targetAgency.id },
      data: {
        ...(avgServiceTime !== undefined && { averageServiceTime: avgServiceTime }),
        ...(maxQueueSize !== undefined && { maxActiveReservations: maxQueueSize }),
        ...(isQueueOpen !== undefined && { isQueueOpen }),
        ...(workingHoursStart !== undefined && { workingHoursStart }),
        ...(workingHoursEnd !== undefined && { workingHoursEnd }),
        ...(autoPauseWhenFull !== undefined && { autoPauseWhenFull }),
        ...(kioskModeEnabled !== undefined && { kioskModeEnabled }),
        ...(sponsorSms !== undefined && { sponsorSms }),
        ...(smsBalance !== undefined && { smsBalance }),
      },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', targetAgency.id, {
      action: 'settings-updated',
      isQueueOpen,
      autoPauseWhenFull,
      kioskModeEnabled,
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/staff ─────────────────────────────────────────────────────────────

// GET - List staff members for an agency
app.get('/staff', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      return c.json({ error: 'agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const staff = await db.agencyStaff.findMany({
      where: { agencyId },
      include: {
        user: {
          select: { id: true, username: true, fullName: true, role: true, isActive: true },
        },
      },
      orderBy: { joinedAt: 'desc' },
    })

    // Parse permissions JSON for each staff member
    const staffWithPermissions = staff.map((s) => ({
      ...s,
      permissions: s.permissions ? JSON.parse(s.permissions as string) : {},
    }))

    return c.json({ staff: staffWithPermissions })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST - Add a staff member to an agency
app.post('/staff', async (c) => {
  try {
    const { agencyId, username } = await c.req.json()
    if (!agencyId || !username) {
      return c.json({ error: 'agencyId and username required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    // Find user by username
    const user = await db.user.findUnique({
      where: { username: username.trim() },
    })

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Check if user is already a staff member
    const existing = await db.agencyStaff.findUnique({
      where: {
        userId_agencyId: {
          userId: user.id,
          agencyId,
        },
      },
    })

    if (existing) {
      return c.json({ error: 'Staff already exists in this agency' }, 409)
    }

    // Create staff link
    const staff = await db.agencyStaff.create({
      data: {
        userId: user.id,
        agencyId,
        role: user.role === 'AGENCY_OWNER' ? 'OWNER' : 'STAFF',
      },
      include: {
        user: {
          select: { id: true, username: true, fullName: true, role: true },
        },
      },
    })

    // Emit realtime event (fire-and-forget)
    emitStaffEvent('staff:updated', agencyId, {
      action: 'staff-added',
      staffId: staff.id,
      userId: user.id,
      username: user.username,
    })

    return c.json({ staff }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE - Remove a staff member from an agency
app.delete('/staff', async (c) => {
  try {
    const staffId = c.req.query('staffId')
    const agencyId = c.req.query('agencyId')

    if (!staffId || !agencyId) {
      return c.json({ error: 'staffId and agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    // Verify it's not an owner
    const staffMember = await db.agencyStaff.findUnique({
      where: { id: staffId },
    })

    if (!staffMember) {
      return c.json({ error: 'Staff member not found' }, 404)
    }

    // Verify the staff member belongs to the specified agency
    if (staffMember.agencyId !== agencyId) {
      return c.json({ error: 'Staff member does not belong to this agency' }, 403)
    }

    if (staffMember.role === 'OWNER') {
      return c.json({ error: 'Cannot remove agency owner' }, 403)
    }

    await db.agencyStaff.delete({
      where: { id: staffId },
    })

    // Emit realtime event (fire-and-forget)
    emitStaffEvent('staff:updated', agencyId, {
      action: 'staff-removed',
      staffId,
      userId: staffMember.userId,
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/staff/create (MUST be before /agency/staff/:id) ───────────────────

app.post('/staff/create', async (c) => {
  try {
    const body = await c.req.json()
    const createStaffBodySchema = createStaffSchema.extend({
      agencyId: z.string().min(1, 'Agency ID is required'),
      staffRole: z.enum(['STAFF', 'MANAGER', 'AGENCY_STAFF', 'AGENCY_OWNER']).optional().default('STAFF'),
    })
    const validation = validateBody(createStaffBodySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, username, fullName, password, phoneNumber, staffRole } = validation.data

    // Phase 2c: Verify the requesting user actually belongs to the target agency.
    // Prevents cross-tenant exploit where a staff member from Agency A could
    // create staff in Agency B by supplying a different agencyId in the body.
    const user = await requireAuth(c)
    const ownership = await verifyAgencyOwnership(user.id, agencyId)
    if (!ownership) {
      return c.json({ success: false, error: 'You do not have access to this agency' }, 403)
    }

    await requireAgencyAccess(c, agencyId)

    // Map AGENCY_STAFF -> AGENCY_STAFF user role, AGENCY_OWNER -> AGENCY_OWNER user role
    const userRole = staffRole === 'AGENCY_OWNER' ? 'AGENCY_OWNER' : 'AGENCY_STAFF'
    // Map to AgencyStaff role
    const agencyStaffRole = staffRole === 'AGENCY_OWNER' ? 'OWNER' : staffRole === 'MANAGER' ? 'MANAGER' : 'STAFF'

    // Verify agency exists
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
    })

    if (!agency) {
      return c.json({ error: 'Agency not found' }, 404)
    }

    // Check username uniqueness
    const existingUser = await db.user.findUnique({
      where: { username: username.trim() },
    })

    if (existingUser) {
      return c.json({ error: 'This username is already taken' }, 409)
    }

    // Hash the password
    const passwordHash = hashPassword(password)

    // Create User with appropriate role
    const newUser = await db.user.create({
      data: {
        username: username.trim(),
        fullName: fullName.trim(),
        passwordHash,
        phoneNumber,
        role: userRole,
        language: 'ar',
        isActive: true,
      },
    })

    // Create AgencyStaff link
    const staffLink = await db.agencyStaff.create({
      data: {
        userId: newUser.id,
        agencyId,
        role: agencyStaffRole,
      },
      include: {
        user: {
          select: { id: true, username: true, fullName: true, role: true, isActive: true },
        },
      },
    })

    // Return the created staff with initial password so owner can share it
    // Emit realtime event (fire-and-forget)
    emitStaffEvent('staff:updated', agencyId, {
      action: 'staff-created',
      staffId: staffLink.id,
      userId: newUser.id,
      username: newUser.username,
    })

    return c.json({
      staff: staffLink,
      initialPassword: password,
    }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/staff/:id ─────────────────────────────────────────────────────────

// PATCH - Update a staff member (fullName, isActive, role)
app.patch('/staff/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 403)
    }

    const body = await c.req.json()

    // Permissions schema for fine-grained staff access control
    const staffPermissionsSchema = z.object({
      canManageQueue: z.boolean().optional(),
      canManageServices: z.boolean().optional(),
      canManageStaff: z.boolean().optional(),
      canViewAnalytics: z.boolean().optional(),
      canManageBranches: z.boolean().optional(),
      canManageWorkingHours: z.boolean().optional(),
      canExportData: z.boolean().optional(),
      canManageProfile: z.boolean().optional(),
    })

    const patchStaffSchema = updateStaffSchema.extend({
      permissions: staffPermissionsSchema.optional(),
    })

    const validation = validateBody(patchStaffSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { fullName, role, isActive, permissions } = validation.data

    // Find the staff member
    const staffMember = await db.agencyStaff.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, username: true, fullName: true, role: true, isActive: true },
        },
      },
    })

    if (!staffMember) {
      return c.json({ error: 'Staff member not found' }, 404)
    }

    // Verify the staff member belongs to the user's agency
    if (staffMember.agencyId !== agencyId) {
      return c.json({ error: 'Staff member does not belong to your agency' }, 403)
    }

    // Cannot modify the owner
    if (staffMember.role === 'OWNER') {
      return c.json({ error: 'Cannot modify agency owner' }, 403)
    }

    // Update user fullName if provided
    if (fullName !== undefined && fullName.trim()) {
      await db.user.update({
        where: { id: staffMember.userId },
        data: { fullName: fullName.trim() },
      })
    }

    // Update staff role if provided
    if (role !== undefined && ['STAFF', 'MANAGER'].includes(role)) {
      await db.agencyStaff.update({
        where: { id },
        data: { role },
      })
    }

    // Update user isActive if provided
    if (isActive !== undefined) {
      await db.user.update({
        where: { id: staffMember.userId },
        data: { isActive },
      })
      // Also update the AgencyStaff isActive
      await db.agencyStaff.update({
        where: { id },
        data: { isActive },
      })
    }

    // Update permissions if provided
    if (permissions !== undefined) {
      // Merge with existing permissions
      const currentPerms = staffMember.permissions
        ? JSON.parse(staffMember.permissions as string)
        : {}
      const mergedPerms = { ...currentPerms, ...permissions }
      await db.agencyStaff.update({
        where: { id },
        data: { permissions: JSON.stringify(mergedPerms) },
      })
    }

    // Fetch updated staff member
    const updated = await db.agencyStaff.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, username: true, fullName: true, role: true, isActive: true },
        },
      },
    })

    // Emit realtime event (fire-and-forget)
    emitStaffEvent('staff:updated', agencyId, {
      action: 'staff-updated',
      staffId: id,
      fullName,
      role,
      isActive,
    })

    return c.json({ staff: updated, success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE - Remove/deactivate a staff member
app.delete('/staff/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 403)
    }

    // Find the staff member
    const staffMember = await db.agencyStaff.findUnique({
      where: { id },
    })

    if (!staffMember) {
      return c.json({ error: 'Staff member not found' }, 404)
    }

    // Verify the staff member belongs to the user's agency
    if (staffMember.agencyId !== agencyId) {
      return c.json({ error: 'Staff member does not belong to your agency' }, 403)
    }

    // Cannot remove the owner
    if (staffMember.role === 'OWNER') {
      return c.json({ error: 'Cannot remove agency owner' }, 403)
    }

    // Delete the staff link
    await db.agencyStaff.delete({
      where: { id },
    })

    // Deactivate the user account if they are AGENCY_STAFF
    const staffUser = await db.user.findUnique({
      where: { id: staffMember.userId },
    })

    if (staffUser && staffUser.role === 'AGENCY_STAFF') {
      // Check if this user has any other staff links
      const otherLinks = await db.agencyStaff.count({
        where: {
          userId: staffUser.id,
          id: { not: id },
        },
      })

      if (otherLinks === 0) {
        // No other agencies, deactivate the user
        await db.user.update({
          where: { id: staffUser.id },
          data: { isActive: false },
        })
      }
    }

    // Emit realtime event (fire-and-forget)
    emitStaffEvent('staff:updated', agencyId, {
      action: 'staff-removed',
      staffId: id,
      userId: staffMember.userId,
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/stats ─────────────────────────────────────────────────────────────

app.get('/stats', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) {
      return c.json({ error: 'agencyId required' }, 400)
    }

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) {
      return c.json({ error: 'Agency not found' }, 404)
    }

    const todayStart = getTodayStart()
    const todayEnd = getTodayEnd()

    const [
      todayReservations,
      waitingCount,
      servedToday,
      noShowCount,
      cancelledCount,
      queueSettings,
      ratingAgg,
      totalAllTime,
      completedAllTime,
      noShowAllTime,
      walkInCount,
      onlineReservationCount,
      activeCounters,
    ] = await Promise.all([
      db.reservation.count({
        where: { agencyId, joinedAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.reservation.count({
        where: { agencyId, status: { in: ['WAITING', 'CALLED'] } },
      }),
      db.reservation.count({
        where: { agencyId, status: { in: ['COMPLETED'] }, completedAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.reservation.count({
        where: { agencyId, status: { in: ['NO_SHOW'] }, cancelledAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.reservation.count({
        where: { agencyId, status: { in: ['CANCELLED'] }, cancelledAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.queueSettings.findFirst({ where: { agencyId } }),
      db.reservation.aggregate({
        where: { agencyId, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      // all-time totals
      db.reservation.count({ where: { agencyId } }),
      db.reservation.count({ where: { agencyId, status: 'COMPLETED' } }),
      db.reservation.count({ where: { agencyId, status: 'NO_SHOW' } }),
      // walk-in count for today
      db.reservation.count({
        where: { agencyId, isWalkIn: true, joinedAt: { gte: todayStart, lte: todayEnd } },
      }),
      // online reservation count for today (non-walk-in with userId)
      db.reservation.count({
        where: { agencyId, isWalkIn: false, userId: { not: null }, joinedAt: { gte: todayStart, lte: todayEnd } },
      }),
      // active counters (with staff assigned)
      db.counter.count({
        where: {
          isActive: true,
          staffId: { not: null },
          branch: { agencyId, isActive: true },
        },
      }),
    ])

    // Calculate peak hour today
    const todayReservationsList = await db.reservation.findMany({
      where: { agencyId, joinedAt: { gte: todayStart, lte: todayEnd } },
      select: { joinedAt: true },
    })

    let peakHour = '—'
    if (todayReservationsList.length > 0) {
      const hourCounts: Record<number, number> = {}
      todayReservationsList.forEach((r) => {
        const h = r.joinedAt.getHours()
        hourCounts[h] = (hourCounts[h] || 0) + 1
      })
      let maxCount = 0
      let peakH = 0
      for (const [hour, count] of Object.entries(hourCounts)) {
        if (count > maxCount) {
          maxCount = count
          peakH = parseInt(hour)
        }
      }
      peakHour = `${String(peakH).padStart(2, '0')}:00`
    }

    const currentQueueNumber = queueSettings
      ? `${queueSettings.currentServingNumber}`
      : '—'

    // Performance metrics
    const avgRating = ratingAgg._avg.rating ? Math.round(ratingAgg._avg.rating * 10) / 10 : 0
    const totalRatings = ratingAgg._count.rating
    const completionRate = totalAllTime > 0 ? Math.round((completedAllTime / totalAllTime) * 100) : 0
    const noShowRate = totalAllTime > 0 ? Math.round((noShowAllTime / totalAllTime) * 100) : 0

    // Hourly wait time data (today)
    const todayCompleted = await db.reservation.findMany({
      where: { agencyId, status: 'COMPLETED', completedAt: { gte: todayStart, lte: todayEnd } },
      select: { joinedAt: true, completedAt: true, calledAt: true },
    })
    const hourlyWaitTime: number[] = new Array(24).fill(0)
    const hourlyCount: number[] = new Array(24).fill(0)
    todayCompleted.forEach((r) => {
      if (r.calledAt && r.completedAt) {
        const waitMinutes = Math.round((r.completedAt.getTime() - r.joinedAt.getTime()) / 60000)
        const h = r.joinedAt.getHours()
        hourlyWaitTime[h] += waitMinutes
        hourlyCount[h]++
      }
    })
    const avgHourlyWait = hourlyWaitTime.map((total, i) => hourlyCount[i] > 0 ? Math.round(total / hourlyCount[i]) : 0)

    // Rating distribution
    const ratingDist = [0, 0, 0, 0, 0] // 1-5 stars
    const allRated = await db.reservation.findMany({
      where: { agencyId, rating: { not: null } },
      select: { rating: true },
    })
    allRated.forEach((r) => {
      if (r.rating && r.rating >= 1 && r.rating <= 5) ratingDist[r.rating - 1]++
    })

    // Calculate ETA range for overall queue
    const isPaused = queueSettings?.isPaused || false
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const recentCompletedForEta = await db.reservation.findMany({
      where: {
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { gte: sevenDaysAgo },
      },
      select: { calledAt: true, completedAt: true, joinedAt: true },
      take: 200,
    })
    const effectiveService = getEffectiveServiceTime(recentCompletedForEta, agency.averageServiceTime)
    const overallEta = calculateETA({
      peopleAhead: waitingCount,
      avgServiceTimeMinutes: effectiveService.avgMinutes,
      activeCounters: Math.max(1, activeCounters),
      historicalVarianceFactor: effectiveService.varianceFactor,
      isPaused,
      historicalSampleSize: effectiveService.sampleSize,
    })

    return c.json({
      todayReservations,
      currentlyWaiting: waitingCount,
      servedToday,
      noShowCount,
      cancelledCount,
      avgWaitTime: agency.averageServiceTime,
      currentQueueNumber,
      isPaused,
      peakHour,
      // Performance metrics
      avgRating,
      totalRatings,
      completionRate,
      noShowRate,
      // Chart data
      hourlyWaitTime: avgHourlyWait,
      ratingDistribution: ratingDist,
      // Subscription info
      subscriptionStatus: agency.subscriptionStatus,
      // Enhanced metrics
      estimatedWaitRange: {
        minMinutes: overallEta.estimatedMinMinutes,
        maxMinutes: overallEta.estimatedMaxMinutes,
        confidence: overallEta.confidence,
      },
      activeCounters,
      walkInCount,
      onlineReservationCount,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/history ────────────────────────────────────────────────────────
// Paginated reservation history for the agency dashboard.
// Supports search by customer name / queue number, status filter, service filter,
// and date-range filtering.

app.get('/history', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || (await resolveUserAgencyId(user))
    if (!agencyId) {
      return c.json({ error: 'No agency associated with this account' }, 403)
    }

    // Parse & clamp query params
    const rawPage = parseInt(c.req.query('page') || '1', 10)
    const rawLimit = parseInt(c.req.query('limit') || '20', 10)
    const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage)
    const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit))
    const search = c.req.query('search')?.trim() || ''
    const status = c.req.query('status') || ''
    const serviceId = c.req.query('serviceId') || ''
    const dateFrom = c.req.query('dateFrom') || ''
    const dateTo = c.req.query('dateTo') || ''

    // Build where clause
    const where: any = { agencyId }

    // Status filter
    if (status) {
      where.status = status
    }

    // Service filter
    if (serviceId) {
      where.serviceId = serviceId
    }

    // Date range filters
    if (dateFrom) {
      where.joinedAt = { ...(where.joinedAt || {}), gte: new Date(dateFrom) }
    }
    if (dateTo) {
      where.joinedAt = { ...(where.joinedAt || {}), lte: new Date(dateTo) }
    }

    // Search by customer name or queue number
    if (search) {
      where.OR = [
        { displayNumber: { contains: search } },
        { walkInCustomerName: { contains: search } },
        { user: { fullName: { contains: search } } },
      ]
    }

    // Count total matching records (for pagination)
    const total = await db.reservation.count({ where })

    // Fetch paginated results with relations
    const reservations = await db.reservation.findMany({
      where,
      include: {
        service: { select: { id: true, name: true, nameAr: true, nameFr: true } },
        counter: { select: { id: true, name: true } },
        user: { select: { id: true, fullName: true, phoneNumber: true } },
      },
      orderBy: { joinedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    })

    // Map results with computed duration fields
    const mapped = reservations.map((r) => ({
      id: r.id,
      queueNumber: String(r.queueNumber),
      displayNumber: r.displayNumber,
      status: r.status,
      customerName: r.isWalkIn ? r.walkInCustomerName : r.user?.fullName || null,
      customerPhone: r.isWalkIn ? null : r.user?.phoneNumber || null,
      isWalkIn: r.isWalkIn,
      walkInCustomerName: r.walkInCustomerName,
      serviceId: r.serviceId,
      serviceName: r.service.name,
      serviceNameAr: r.service.nameAr,
      serviceNameFr: r.service.nameFr,
      joinedAt: r.joinedAt.toISOString(),
      calledAt: r.calledAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      estimatedWait: r.estimatedWait,
      serviceDuration: r.completedAt && r.calledAt
        ? Math.round((r.completedAt.getTime() - r.calledAt.getTime()) / 60000)
        : null,
      waitDuration: r.calledAt && r.joinedAt
        ? Math.round((r.calledAt.getTime() - r.joinedAt.getTime()) / 60000)
        : null,
      rating: r.rating,
      counterId: r.counterId,
      counterName: r.counter?.name ?? null,
    }))

    return c.json({
      reservations: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/history/:id ─────────────────────────────────────────────────────
// Single reservation detail for the agency dashboard.

app.get('/history/:id', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || (await resolveUserAgencyId(user))
    if (!agencyId) {
      return c.json({ error: 'No agency associated with this account' }, 403)
    }

    const id = c.req.param('id')

    const r = await db.reservation.findFirst({
      where: { id, agencyId },
      include: {
        service: { select: { id: true, name: true, nameAr: true, nameFr: true } },
        counter: { select: { id: true, name: true } },
        user: { select: { id: true, fullName: true, phoneNumber: true } },
      },
    })

    if (!r) {
      return c.json({ error: 'Reservation not found' }, 404)
    }

    return c.json({
      id: r.id,
      queueNumber: String(r.queueNumber),
      displayNumber: r.displayNumber,
      status: r.status,
      customerName: r.isWalkIn ? r.walkInCustomerName : r.user?.fullName || null,
      customerPhone: r.isWalkIn ? null : r.user?.phoneNumber || null,
      isWalkIn: r.isWalkIn,
      walkInCustomerName: r.walkInCustomerName,
      serviceId: r.serviceId,
      serviceName: r.service.name,
      serviceNameAr: r.service.nameAr,
      serviceNameFr: r.service.nameFr,
      joinedAt: r.joinedAt.toISOString(),
      calledAt: r.calledAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      estimatedWait: r.estimatedWait,
      serviceDuration: r.completedAt && r.calledAt
        ? Math.round((r.completedAt.getTime() - r.calledAt.getTime()) / 60000)
        : null,
      waitDuration: r.calledAt && r.joinedAt
        ? Math.round((r.calledAt.getTime() - r.joinedAt.getTime()) / 60000)
        : null,
      rating: r.rating,
      counterId: r.counterId,
      counterName: r.counter?.name ?? null,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/subscription-plans (public listing — requireAuth only) ───────────
//
// Any logged-in user (agency owner, staff, or even a customer browsing) can
// fetch the list of active SubscriptionPlan records. This decouples the agency
// subscription page from the admin-gated `/api/admin/subscription-plans` route
// and lets the page render dynamic plans managed by the admin.
//
// Returns active plans with their `features` (PlanFeature records), ordered by
// `sortOrder` ascending — matching the order the admin configured.

app.get('/subscription-plans', async (c) => {
  try {
    // Any authenticated user may list available plans — no agency access needed
    const user = await requireAuth(c)
    const agencyId = user.agencyId || (await resolveUserAgencyId(user))

    // Exclude enterprise custom plans unless they belong to the requesting
    // agency. Public catalog only shows non-enterprise plans.
    const plans = await db.subscriptionPlan.findMany({
      where: {
        isActive: true,
        OR: [
          { isEnterprise: false },
          ...(agencyId ? [{ isEnterprise: true, ownerAgencyId: agencyId }] : []),
        ],
      },
      include: { features: true },
      orderBy: { sortOrder: 'asc' },
    })

    return c.json({ plans })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/subscription ──────────────────────────────────────────────────────

app.get('/subscription', async (c) => {
  try {
    const agencyIdParam = c.req.query('agencyId')

    let agencyId: string | null
    if (agencyIdParam) {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyIdParam)
      await requireAgencyAccess(c, agencyIdParam)
      agencyId = agencyIdParam
    } else {
      const user = await requireAuth(c)
      agencyId = user.agencyId || await resolveUserAgencyId(user)
    }

    // Always include the catalog of active plans so the agency page can render
    // dynamic plan cards in the same response as the current subscription.
    // Enterprise custom plans are excluded from the public catalog — they only
    // appear for the specific agency they were built for (ownerAgencyId match).
    const effectiveAgencyId = agencyIdParam || agencyId || undefined
    const availablePlans = await db.subscriptionPlan.findMany({
      where: {
        isActive: true,
        OR: [
          { isEnterprise: false },
          ...(effectiveAgencyId ? [{ isEnterprise: true, ownerAgencyId: effectiveAgencyId }] : []),
        ],
      },
      include: { features: true },
      orderBy: { sortOrder: 'asc' },
    })

    if (!agencyId) {
      return c.json({
        currentPlan: 'BASIC',
        status: 'INACTIVE',
        subscriptionStartsAt: null,
        subscriptionExpiresAt: null,
        daysRemaining: null,
        isExpired: false,
        isExpiringSoon: false,
        availablePlans,
        recentTransactions: [],
      })
    }

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) {
      return c.json({
        currentPlan: 'BASIC',
        status: 'INACTIVE',
        subscriptionStartsAt: null,
        subscriptionExpiresAt: null,
        daysRemaining: null,
        isExpired: false,
        isExpiringSoon: false,
        availablePlans,
        recentTransactions: [],
      })
    }

    // Lazily flip subscriptionStatus → EXPIRED when the expiry date has passed
    // and surface the daysRemaining / isExpiringSoon flags for the UI banners.
    const expiry = await checkSubscriptionExpiry(agencyId)

    const transactions = await db.transaction.findMany({
      where: { agencyId: agency.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })

    return c.json({
      currentPlan: agency.subscriptionTier,
      // Use the (possibly updated) status from the expiry check so the client
      // sees EXPIRED immediately after the date passes — without a refetch.
      status: expiry?.status ?? agency.subscriptionStatus,
      subscriptionStartsAt: expiry?.subscriptionStartsAt ?? null,
      subscriptionExpiresAt: expiry?.subscriptionExpiresAt ?? null,
      daysRemaining: expiry?.daysRemaining ?? null,
      isExpired: expiry?.isExpired ?? false,
      isExpiringSoon: expiry?.isExpiringSoon ?? false,
      availablePlans,
      recentTransactions: transactions.map(tx => ({
        id: tx.id,
        amount: tx.amount,
        // Surface the snapshot fields so the page can show what was actually
        // paid / which plan name was selected at transaction time, even if the
        // admin later renames or reprices the plan.
        amountPaid: tx.amountPaid,
        planName: tx.planName,
        plan: tx.plan,
        method: tx.paymentMethod,
        status: tx.status,
        rejectionReason: tx.rejectionReason,
        reviewedAt: tx.reviewedAt?.toISOString() ?? null,
        createdAt: tx.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/subscription/pay ──────────────────────────────────────────────────

app.post('/subscription/pay', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 404)
    }

    const formData = await c.req.formData()
    const plan = formData.get('plan') as string
    const method = formData.get('method') as string
    const receiptUrl = formData.get('receiptUrl') as string | null
    // Optional billing period (1=monthly, 3=quarterly, 6=semi-annual,
    // 12=annual, 24=biennial). Falls back to 1 (no discount) when absent.
    const periodRaw = formData.get('period') as string | null
    const period = periodRaw ? Number(periodRaw) : 1

    // Validate with Zod
    const validation = validateBody(subscriptionPaySchema, { plan, method, receiptUrl, period: Number.isFinite(period) ? period : undefined })
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ error: 'No agency found' }, 404)

    // Phase 2: Look up the actual SubscriptionPlan record the user wants to
    // subscribe to. This replaces the old hardcoded
    // `amount = plan === 'PREMIUM' ? 3000 : 2000` with the real admin-managed
    // price. It also validates that the requested plan exists and is active.
    const planRecord = await db.subscriptionPlan.findFirst({
      where: { name: validation.data.plan, isActive: true },
    })
    if (!planRecord) {
      return c.json({ error: 'Invalid or inactive plan' }, 400)
    }

    // Enterprise plan ownership guard: a custom enterprise plan may only be
    // subscribed to by the agency it was created for. This prevents any other
    // agency from subscribing to a bespoke plan built for a different enterprise.
    if (planRecord.isEnterprise && planRecord.ownerAgencyId && planRecord.ownerAgencyId !== agencyId) {
      return c.json({ error: 'This enterprise plan is not available for your agency' }, 403)
    }

    // ─── Period discount ──────────────────────────────────────────────────
    // Map the chosen billing period (months) to the plan's discount field.
    // Defaults to period = 1 (monthly, no discount) when not provided.
    const effectivePeriod = validation.data.period ?? 1
    let discountPercent = 0
    if (effectivePeriod === 3) discountPercent = planRecord.quarterlyDiscount
    else if (effectivePeriod === 6) discountPercent = planRecord.semiAnnualDiscount
    else if (effectivePeriod === 12) discountPercent = planRecord.annualDiscount
    else if (effectivePeriod === 24) discountPercent = planRecord.biennialDiscount

    // Total amount for the full period: base price × period × (1 − discount%).
    // Rounded to the nearest DZD.
    const amount = Math.round(planRecord.price * effectivePeriod * (1 - discountPercent / 100))

    // Encode the period in the planName snapshot so the admin approval handler
    // can recover it later and set subscriptionExpiresAt = now + period months.
    // Format: "PREMIUM (3m)" for period > 1, otherwise just the plan name.
    const planNameSnapshot = effectivePeriod > 1
      ? `${validation.data.plan} (${effectivePeriod}m)`
      : validation.data.plan

    const transaction = await db.transaction.create({
      data: {
        agencyId: agency.id,
        amount,
        plan: validation.data.plan,
        paymentMethod: validation.data.method,
        receiptUrl: validation.data.receiptUrl || null,
        status: 'PENDING',
        // Phase 1d snapshot fields — freeze the plan price/currency/name at
        // transaction time so future admin edits don't rewrite history.
        amountPaid: amount,
        planName: planNameSnapshot,
        priceSnapshot: planRecord.price,
        currencySnapshot: planRecord.currency,
      },
    })

    // Phase 2: Link the agency to the SubscriptionPlan record (in addition to
    // the legacy subscriptionTier/subscriptionStatus fields) and mark the
    // subscription as PENDING until an admin approves the receipt.
    await db.agency.update({
      where: { id: agency.id },
      data: {
        subscriptionStatus: 'PENDING',
        subscriptionTier: validation.data.plan,
        subscriptionPlanId: planRecord.id,
      },
    })

    return c.json({ success: true, transaction })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/subscription/unsubscribe ──────────────────────────────────────────

app.post('/subscription/unsubscribe', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateBody(subscriptionUnsubscribeSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId: agencyIdParam } = validation.data

    let agencyId: string | null
    let userId: string | null = null
    if (agencyIdParam) {
      // Phase 2c: Explicit ownership check when agencyId comes from the request
      await ensureAgencyIdOwnership(c, agencyIdParam)
      const authUser = await requireAgencyAccess(c, agencyIdParam)
      agencyId = agencyIdParam
      userId = authUser?.id ?? null
    } else {
      const user = await requireAuth(c)
      userId = user.id
      agencyId = user.agencyId || await resolveUserAgencyId(user)
    }

    if (!agencyId) {
      return c.json({ error: 'No agency found' }, 404)
    }

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ error: 'No agency found' }, 404)

    const previousTier = agency.subscriptionTier

    await db.agency.update({
      where: { id: agency.id },
      data: {
        subscriptionStatus: 'INACTIVE',
        subscriptionTier: 'BASIC',
      },
    })

    // Phase 5d: If this is a downgrade (not just unsubscribing from BASIC), handle excess resources
    if (previousTier !== 'BASIC') {
      const downgradeSummary = await handleDowngrade(agency.id, 'BASIC')

      // Audit log for downgrade
      await db.auditLog.create({
        data: {
          userId,
          action: 'SUBSCRIPTION_DOWNGRADE',
          entityType: 'AGENCY',
          entityId: agency.id,
          details: JSON.stringify({
            from: previousTier,
            to: 'BASIC',
            countersDeactivated: downgradeSummary.countersDeactivated,
            gracePeriodEndsAt: downgradeSummary.gracePeriodEndsAt?.toISOString(),
          }),
        },
      })
    }

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/working-hours ─────────────────────────────────────────────────────

app.patch('/working-hours', async (c) => {
  try {
    const body = await c.req.json()
    const validation = validateBody(updateWorkingHoursSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, workingHoursStart, workingHoursEnd } = validation.data

    // Phase 2c: Explicit ownership check
    await ensureAgencyIdOwnership(c, agencyId)
    await requireAgencyAccess(c, agencyId)

    const agency = await db.agency.update({
      where: { id: agencyId },
      data: {
        ...(workingHoursStart !== undefined && { workingHoursStart }),
        ...(workingHoursEnd !== undefined && { workingHoursEnd }),
      },
      select: {
        id: true,
        workingHoursStart: true,
        workingHoursEnd: true,
      },
    })

    // Emit realtime event (fire-and-forget)
    emitAgencyEvent('agency:updated', agencyId, {
      action: 'working-hours-updated',
      workingHoursStart,
      workingHoursEnd,
    })

    return c.json(agency)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Helper: processCandidate for call-next ───────────────────────────────────

async function processCandidate(tx: any, candidate: any, queueSettings: any, agencyId: string, counterId?: string) {
  const reservationData: Record<string, unknown> = { status: 'CALLED', calledAt: new Date() }
  if (counterId) reservationData.counterId = counterId

  await tx.reservation.update({
    where: { id: candidate.id },
    data: reservationData,
  })

  // Link reservation to counter as the active serving ticket
  if (counterId) {
    await tx.counter.update({
      where: { id: counterId },
      data: { currentReservationId: candidate.id },
    })
  }

  if (queueSettings) {
    await tx.queueSettings.update({
      where: { id: queueSettings.id },
      data: { currentServingNumber: candidate.queueNumber },
    })
  }

  // Only create notification if user exists (not walk-in)
  if (candidate.userId) {
    await tx.notification.create({
      data: {
        userId: candidate.userId,
        type: 'QUEUE_CALLED',
        title: 'Queue Called',
        message: `Your number ${candidate.displayNumber} has been called. Please proceed.`,
      },
    })
  }

  const auditUser = candidate.userId
    ? await tx.user.findUnique({ where: { id: candidate.userId } })
    : null

  await tx.auditLog.create({
    data: {
      userId: auditUser ? candidate.userId : null,
      action: 'QUEUE_CALL',
      entityType: 'RESERVATION',
      entityId: candidate.id,
      details: JSON.stringify({
        displayNumber: candidate.displayNumber,
        agencyId,
        serviceId: candidate.serviceId,
        isWalkIn: candidate.isWalkIn || false,
        walkInCustomerName: candidate.walkInCustomerName || null,
        counterId: counterId || null,
      }),
    },
  })
}

// ─── Phase 5d: handleDowngrade ────────────────────────────────────────────────
//
// When an agency's subscription is downgraded (e.g. PREMIUM → BASIC), some
// features may exceed the new plan's limits. This function:
//   1. Looks up the target plan's limits (maxServices, maxStaff, etc.)
//   2. Marks excess counters as inactive (does NOT delete them)
//   3. Does NOT immediately revoke existing reservations — they complete naturally
//   4. Sets gracePeriodEndsAt on the agency so the downgrade takes full effect later
//
// Callers should pass the new plan name (e.g. 'BASIC') and the agency record.
// Returns a summary of actions taken for audit/logging purposes.

interface DowngradeSummary {
  countersDeactivated: number;
  gracePeriodEndsAt: Date | null;
}

export async function handleDowngrade(
  agencyId: string,
  newTier: string,
): Promise<DowngradeSummary> {
  // 1. Look up the target plan's limits
  const targetPlan = await db.subscriptionPlan.findFirst({
    where: { name: newTier, isActive: true },
  });

  // Default limits if no plan record exists
  const maxStaff = targetPlan?.maxStaff ?? 3;

  let countersDeactivated = 0;

  // 2. Check if active counters exceed the new plan's limit
  //    We look across all branches of this agency. Since SubscriptionPlan doesn't
  //    have an explicit maxCounters field, we use maxStaff as a proxy (one counter
  //    per staff member is a reasonable default). If a dedicated maxCounters is
  //    added to SubscriptionPlan in the future, swap this out.
  const maxCounters = (targetPlan as Record<string, unknown>)?.maxCounters as number | undefined ?? maxStaff;

  // Count currently active counters for this agency
  const activeCounters = await db.counter.findMany({
    where: {
      branch: { agencyId },
      isActive: true,
    },
    orderBy: { createdAt: 'desc' }, // deactivate newest first, keep oldest
  });

  if (activeCounters.length > maxCounters) {
    const excess = activeCounters.length - maxCounters;
    const countersToDeactivate = activeCounters.slice(0, excess); // newest first
    const idsToDeactivate = countersToDeactivate.map((c) => c.id);

    await db.counter.updateMany({
      where: { id: { in: idsToDeactivate } },
      data: { isActive: false },
    });

    countersDeactivated = idsToDeactivate.length;
  }

  // 3. Do NOT revoke existing reservations — they complete naturally.
  //    No action needed here; grace period communicates intent.

  // 4. Set gracePeriodEndsAt (7 days from now by default)
  const gracePeriodDays = 7;
  const gracePeriodEndsAt = new Date();
  gracePeriodEndsAt.setDate(gracePeriodEndsAt.getDate() + gracePeriodDays);

  await db.agency.update({
    where: { id: agencyId },
    data: { gracePeriodEndsAt },
  });

  return { countersDeactivated, gracePeriodEndsAt };
}

// ─── agency/hardware ────────────────────────────────────────────────────────
//
// Catalog endpoint for the agency-side hardware ordering UI. Returns the
// active products (admin can disable individual SKUs), commitment tiers
// (12/24/36/48/60 months with admin-set extra %), and the global hardware
// settings (the master on/off toggle + upfront discount %).
//
// If the admin has disabled hardware globally (`hardwareEnabled === false`),
// returns empty arrays + `{ hardwareEnabled: false }` so the UI can hide
// the entire ordering section.

app.get('/hardware', async (c) => {
  try {
    await requireAuth(c)

    const settings = await db.hardwareSettings.findUnique({
      where: { id: 'singleton' },
    })

    if (!settings || !settings.hardwareEnabled) {
      return c.json({
        products: [],
        commitmentTiers: [],
        settings: { hardwareEnabled: false },
      })
    }

    const [products, commitmentTiers] = await Promise.all([
      db.hardwareProduct.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      db.hardwareCommitmentTier.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ])

    return c.json({ products, commitmentTiers, settings })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/hardware/orders ─────────────────────────────────────────────────

app.get('/hardware/orders', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ orders: [] })
    }

    const orders = await db.hardwareOrder.findMany({
      where: { agencyId },
      include: {
        items: { include: { product: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return c.json({ orders })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/hardware/orders (POST) ──────────────────────────────────────────
//
// Create a hardware order. Snapshots each product's current `basePrice` as
// the line-item `unitPrice` (so historical orders aren't affected by future
// admin price edits), then computes:
//   - totalBasePrice = Σ(unitPrice × quantity)
//   - If UPFRONT:  upfrontTotal = totalBasePrice × (1 - upfrontDiscount/100),
//                  monthlyExtra = 0
//   - If MONTHLY:  look up the commitment tier's `extraPercentage`, then
//                  monthlyExtra = round(totalBasePrice × (1 + extraPercentage/100) / commitmentMonths),
//                  upfrontTotal = 0

app.post('/hardware/orders', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ success: false, error: 'No agency found for this user' }, 404)
    }

    const body = await c.req.json()
    const validation = validateBody(createHardwareOrderSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { items, paymentModel, commitmentMonths } = validation.data

    // 1. Make sure hardware is enabled globally
    const settings = await db.hardwareSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings || !settings.hardwareEnabled) {
      return c.json({ success: false, error: 'Hardware ordering is currently disabled' }, 403)
    }

    // 2. Snapshot current product prices (only active products can be ordered)
    const productIds = items.map((i) => i.productId)
    const products = await db.hardwareProduct.findMany({
      where: { id: { in: productIds }, isActive: true },
    })

    const productMap = new Map(products.map((p) => [p.id, p]))
    for (const item of items) {
      if (!productMap.has(item.productId)) {
        return c.json({ success: false, error: `Product ${item.productId} is not available` }, 400)
      }
    }

    // 3. Compute totals
    const orderItems = items.map((i) => {
      const product = productMap.get(i.productId)!
      return {
        productId: i.productId,
        quantity: i.quantity,
        unitPrice: product.basePrice,
      }
    })

    const totalBasePrice = orderItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)

    let upfrontTotal = 0
    let monthlyExtra = 0
    let extraPercentage = 0
    let commitmentMonthsDb: number | null = null

    if (paymentModel === 'UPFRONT') {
      const discount = settings.upfrontDiscount || 0
      upfrontTotal = Math.round(totalBasePrice * (1 - discount / 100))
      monthlyExtra = 0
    } else {
      // MONTHLY — look up the commitment tier
      const tier = await db.hardwareCommitmentTier.findFirst({
        where: { months: commitmentMonths!, isActive: true },
      })
      if (!tier) {
        return c.json({ success: false, error: `Invalid commitment tier: ${commitmentMonths} months` }, 400)
      }
      extraPercentage = tier.extraPercentage
      commitmentMonthsDb = tier.months
      monthlyExtra = Math.round((totalBasePrice * (1 + extraPercentage / 100)) / tier.months)
      upfrontTotal = 0
    }

    // 4. Create the order + items in a single transaction
    const order = await db.$transaction(async (tx) => {
      const created = await tx.hardwareOrder.create({
        data: {
          agencyId,
          paymentModel,
          commitmentMonths: commitmentMonthsDb,
          totalBasePrice,
          extraPercentage,
          monthlyExtra,
          upfrontTotal,
          status: 'PENDING',
          items: {
            create: orderItems,
          },
        },
        include: {
          items: { include: { product: true } },
        },
      })

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'HARDWARE_ORDER_CREATE',
          entityType: 'HARDWARE_ORDER',
          entityId: created.id,
          details: JSON.stringify({
            agencyId,
            paymentModel,
            commitmentMonths: commitmentMonthsDb,
            totalBasePrice,
            upfrontTotal,
            monthlyExtra,
            itemCount: orderItems.length,
          }),
        },
      })

      return created
    })

    return c.json({ success: true, order })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/enterprise-request (POST) ───────────────────────────────────────
//
// Agency submits an enterprise contract request — admin reviews it and can
// create a custom SubscriptionPlan from the request via the
// /admin/enterprise-requests/:id/create-plan endpoint.

app.post('/enterprise-request', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ success: false, error: 'No agency found for this user' }, 404)
    }

    const body = await c.req.json()
    const validation = validateBody(createEnterpriseRequestSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const {
      message,
      contactEmail,
      contactPhone,
      branchesNeeded,
      countersNeeded,
      hardwareNeeded,
      requestedFeatures,
    } = validation.data

    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { id: true, name: true },
    })
    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    const request = await db.enterpriseContractRequest.create({
      data: {
        agencyId,
        agencyName: agency.name,
        contactEmail,
        contactPhone: contactPhone ?? null,
        message,
        requestedFeatures: JSON.stringify(requestedFeatures ?? []),
        branchesNeeded: branchesNeeded ?? 1,
        countersNeeded: countersNeeded ?? 1,
        hardwareNeeded: hardwareNeeded ?? true,
        status: 'PENDING',
      },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'ENTERPRISE_REQUEST_CREATE',
        entityType: 'ENTERPRISE_REQUEST',
        entityId: request.id,
        details: JSON.stringify({
          agencyId,
          agencyName: agency.name,
          contactEmail,
          branchesNeeded: branchesNeeded ?? 1,
          countersNeeded: countersNeeded ?? 1,
          hardwareNeeded: hardwareNeeded ?? true,
        }),
      },
    })

    return c.json({ success: true, request })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/enterprise-request (GET) ────────────────────────────────────────

app.get('/enterprise-request', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ requests: [] })
    }

    const requests = await db.enterpriseContractRequest.findMany({
      where: { agencyId },
      orderBy: { createdAt: 'desc' },
    })

    return c.json({ requests })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── agency/subscription/cancel ─────────────────────────────────────────────
//
// Cancel the agency's active subscription. Unlike /subscription/unsubscribe
// (which also downgrades the tier to BASIC and triggers a downgrade cleanup),
// this endpoint only flips the status to INACTIVE and clears the start/expiry
// dates — the subscriptionTier is preserved for historical reference.

app.post('/subscription/cancel', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) {
      return c.json({ success: false, error: 'No agency found for this user' }, 404)
    }

    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: { id: true, subscriptionTier: true, subscriptionStatus: true },
    })
    if (!agency) {
      return c.json({ success: false, error: 'Agency not found' }, 404)
    }

    await db.agency.update({
      where: { id: agencyId },
      data: {
        subscriptionStatus: 'INACTIVE',
        subscriptionStartsAt: null,
        subscriptionExpiresAt: null,
        // NOTE: subscriptionTier is intentionally NOT cleared — kept for
        // historical reference so admins can see what the agency was on.
      },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'SUBSCRIPTION_CANCEL',
        entityType: 'AGENCY',
        entityId: agencyId,
        details: JSON.stringify({
          agencyId,
          previousTier: agency.subscriptionTier,
          previousStatus: agency.subscriptionStatus,
        }),
      },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// HARDWARE ORDERING ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /agency/hardware — list active products + tiers + settings
app.get('/hardware', async (c) => {
  try {
    const user = await requireAuth(c)
    const settings = await db.hardwareSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings?.hardwareEnabled) {
      return c.json({ products: [], commitmentTiers: [], settings: { hardwareEnabled: false, upfrontDiscount: 0 } })
    }
    const [products, commitmentTiers] = await Promise.all([
      db.hardwareProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      db.hardwareCommitmentTier.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    ])
    return c.json({ products, commitmentTiers, settings })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /agency/hardware/orders — list agency's hardware orders
app.get('/hardware/orders', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) return c.json({ orders: [] })
    const orders = await db.hardwareOrder.findMany({
      where: { agencyId },
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ orders })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /agency/hardware/orders — create a hardware order
app.post('/hardware/orders', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) return c.json({ error: 'No agency found' }, 404)

    const body = await c.req.json()
    const { items, paymentModel, commitmentMonths } = body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return c.json({ error: 'At least one item is required' }, 400)
    }
    if (paymentModel !== 'UPFRONT' && paymentModel !== 'MONTHLY') {
      return c.json({ error: 'Invalid payment model' }, 400)
    }
    if (paymentModel === 'MONTHLY' && ![12, 24, 36, 48, 60].includes(commitmentMonths)) {
      return c.json({ error: 'Invalid commitment period' }, 400)
    }

    const settings = await db.hardwareSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings?.hardwareEnabled) {
      return c.json({ error: 'Hardware ordering is currently disabled' }, 403)
    }

    // Look up products and calculate prices
    let totalBasePrice = 0
    const orderItems = []
    for (const item of items) {
      const product = await db.hardwareProduct.findUnique({ where: { id: item.productId } })
      if (!product || !product.isActive) {
        return c.json({ error: `Product not found or inactive: ${item.productId}` }, 400)
      }
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1)
      totalBasePrice += product.basePrice * qty
      orderItems.push({ productId: product.id, quantity: qty, unitPrice: product.basePrice })
    }

    let upfrontTotal = 0
    let monthlyExtra = 0
    let extraPercentage = 0

    if (paymentModel === 'UPFRONT') {
      const discount = settings.upfrontDiscount || 0
      upfrontTotal = Math.round(totalBasePrice * (1 - discount / 100))
    } else {
      const tier = await db.hardwareCommitmentTier.findUnique({ where: { months: commitmentMonths } })
      if (!tier || !tier.isActive) {
        return c.json({ error: 'Invalid commitment tier' }, 400)
      }
      extraPercentage = tier.extraPercentage
      monthlyExtra = Math.round((totalBasePrice * (1 + extraPercentage / 100)) / commitmentMonths)
    }

    const order = await db.hardwareOrder.create({
      data: {
        agencyId,
        paymentModel,
        commitmentMonths: paymentModel === 'MONTHLY' ? commitmentMonths : null,
        totalBasePrice,
        extraPercentage,
        monthlyExtra,
        upfrontTotal,
        status: 'PENDING',
        items: { create: orderItems },
      },
      include: { items: { include: { product: true } } },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'HARDWARE_ORDER_CREATE',
        entityType: 'HARDWARE_ORDER',
        entityId: order.id,
        details: JSON.stringify({ paymentModel, totalBasePrice, monthlyExtra, upfrontTotal }),
      },
    })

    return c.json({ success: true, order })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CONTRACT REQUEST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /agency/enterprise-request — agency views their requests
app.get('/enterprise-request', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) return c.json({ requests: [] })
    const requests = await db.enterpriseContractRequest.findMany({
      where: { agencyId },
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ requests })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /agency/enterprise-request — agency creates a request
app.post('/enterprise-request', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) return c.json({ error: 'No agency found' }, 404)

    const agency = await db.agency.findUnique({ where: { id: agencyId }, select: { name: true } })
    if (!agency) return c.json({ error: 'Agency not found' }, 404)

    const body = await c.req.json()
    const { message, contactEmail, contactPhone, branchesNeeded, countersNeeded, hardwareNeeded, requestedFeatures } = body

    if (!message?.trim() || !contactEmail?.trim()) {
      return c.json({ error: 'Message and contact email are required' }, 400)
    }

    const request = await db.enterpriseContractRequest.create({
      data: {
        agencyId,
        agencyName: agency.name,
        contactEmail,
        contactPhone: contactPhone || null,
        message,
        requestedFeatures: JSON.stringify(requestedFeatures || []),
        branchesNeeded: branchesNeeded || 1,
        countersNeeded: countersNeeded || 1,
        hardwareNeeded: hardwareNeeded !== false,
        status: 'PENDING',
      },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'ENTERPRISE_REQUEST_CREATE',
        entityType: 'ENTERPRISE_REQUEST',
        entityId: request.id,
        details: JSON.stringify({ agencyName: agency.name }),
      },
    })

    return c.json({ success: true, request })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION CANCEL ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

// POST /agency/subscription/cancel — cancel subscription
app.post('/subscription/cancel', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = user.agencyId || await resolveUserAgencyId(user)
    if (!agencyId) return c.json({ error: 'No agency found' }, 404)

    await db.agency.update({
      where: { id: agencyId },
      data: {
        subscriptionStatus: 'INACTIVE',
        subscriptionStartsAt: null,
        subscriptionExpiresAt: null,
      },
    })

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'SUBSCRIPTION_CANCEL',
        entityType: 'AGENCY',
        entityId: agencyId,
        details: JSON.stringify({}),
      },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const agencyRoutes = app
