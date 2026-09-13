import { Hono } from 'hono'
import { db, dbRaw } from '@blasti/db'
import { requireAuth, requireAdmin, authErrorResponse } from '../lib/auth'
import { validateBody, adminCreateAgencySchema, adminUserActionSchema, faqSchema, paymentSettingsSchema, smsSettingsSchema, createSubscriptionPlanSchema, updateSubscriptionPlanSchema, createHardwareProductSchema, updateHardwareProductSchema, updateHardwareSettingsSchema, updateHardwareCommitmentTierSchema, updateEnterpriseRequestStatusSchema, createEnterprisePlanFromRequestSchema } from '../lib/validations'
import { getTodayStart, getTodayEnd } from '../lib/date-utils'
import {
  getSmsSettings,
  maskApiKey,
  getSmsUsageStats,
  getRecentSmsLogs,
  sendSms,
  validateGatewayConnection,
  ALGERIAN_PROVIDERS,
  normalizeDzPhone,
} from '../lib/sms-service'
import { z } from 'zod'
import { scryptSync } from 'crypto'
import path from 'path'
import fs from 'fs'
import os from 'os'

const app = new Hono()

// ─── Agencies ────────────────────────────────────────────────────────────────

// POST /admin/agencies — Create a new agency
app.post('/agencies', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(adminCreateAgencySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { name, nameAr, nameFr, description, address, phone, category, ownerId, customCode } = validation.data

    // SECURITY: ownerId must always be provided — derive from admin session if missing
    const resolvedOwnerId = ownerId || admin.id

    const agency = await db.agency.create({
      data: {
        name,
        nameAr: nameAr || name,
        nameFr: nameFr || name,
        description,
        address,
        phone,
        category,
        ownerId: resolvedOwnerId,
        customCode: customCode || `AG${Date.now().toString(36).toUpperCase()}`,
      },
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'AGENCY_CREATE',
        entityType: 'AGENCY',
        entityId: agency.id,
        details: JSON.stringify({ agencyName: name, category }),
      },
    })

    return c.json({ success: true, agency }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// GET /admin/agencies — List all agencies
app.get('/agencies', async (c) => {
  try {
    await requireAdmin(c)

    const limit = parseInt(c.req.query('limit') || '20', 10)
    const offset = parseInt(c.req.query('offset') || '0', 10)
    const status = c.req.query('status')

    const where: Record<string, unknown> = {}
    if (status) {
      where.subscriptionStatus = status
    }

    const [agencies, total] = await Promise.all([
      db.agency.findMany({
        where,
        include: {
          owner: {
            select: {
              id: true,
              fullName: true,
              username: true,
              email: true,
              phoneNumber: true,
            },
          },
          _count: {
            select: {
              reservations: true,
              services: true,
              transactions: true,
            },
          },
          transactions: {
            where: { status: 'PENDING' },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.agency.count({ where }),
    ])

    const formattedAgencies = agencies.map((agency) => ({
      id: agency.id,
      name: agency.name,
      customCode: agency.customCode,
      category: agency.category,
      city: agency.city,
      phone: agency.phone,
      email: agency.email,
      logoUrl: agency.logoUrl,
      isActive: agency.isActive,
      isQueueOpen: agency.isQueueOpen,
      subscriptionTier: agency.subscriptionTier,
      subscriptionStatus: agency.subscriptionStatus,
      subscriptionStartsAt: agency.subscriptionStartsAt,
      subscriptionExpiresAt: agency.subscriptionExpiresAt,
      isSponsored: agency.isSponsored,
      createdAt: agency.createdAt,
      owner: agency.owner,
      reservationCount: agency._count.reservations,
      serviceCount: agency._count.services,
      transactionCount: agency._count.transactions,
      hasPendingTransaction: agency.transactions.length > 0,
      pendingTransaction: agency.transactions[0] || null,
    }))

    return c.json({
      success: true,
      agencies: formattedAgencies,
      total,
      limit,
      offset,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Agency by ID ───────────────────────────────────────────────────────────

// PATCH /admin/agencies/:id — Suspend, activate, or delete an agency
app.patch('/agencies/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()

    const agencyActionSchema = z.object({
      action: z.enum(['suspend', 'activate', 'delete']),
    })
    const validation = validateBody(agencyActionSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { action } = validation.data

    const agency = await db.agency.findUnique({ where: { id } })
    if (!agency) return c.json({ error: 'Agency not found' }, 404)

    if (action === 'suspend') {
      await db.agency.update({ where: { id }, data: { isActive: false } })
    } else if (action === 'activate') {
      await db.agency.update({ where: { id }, data: { isActive: true } })
    } else if (action === 'delete') {
      // Cascade delete all related records (complete cascade — includes
      // reviews, favorites, hardware orders, enterprise requests, devices,
      // branches which have required FKs with Restrict/default onDelete).
      // Uses dbRaw (base Prisma client) to bypass the ghost-delete extension
      // whose deleteMany hook crashes inside $transaction in Prisma 6.x.
      await dbRaw.$transaction(async (tx) => {
        await tx.review.deleteMany({ where: { agencyId: id } })
        await tx.favorite.deleteMany({ where: { agencyId: id } })
        await tx.hardwareOrderItem.deleteMany({ where: { order: { agencyId: id } } })
        await tx.hardwareOrder.deleteMany({ where: { agencyId: id } })
        await tx.enterpriseContractRequest.deleteMany({ where: { agencyId: id } })
        await tx.agencyDevice.deleteMany({ where: { agencyId: id } })
        await tx.agencyStaff.deleteMany({ where: { agencyId: id } })
        await tx.queueSettings.deleteMany({ where: { agencyId: id } })
        await tx.reservation.deleteMany({ where: { agencyId: id } })
        await tx.service.deleteMany({ where: { agencyId: id } })
        await tx.announcement.deleteMany({ where: { agencyId: id } })
        await tx.transaction.deleteMany({ where: { agencyId: id } })
        await tx.branch.deleteMany({ where: { agencyId: id } })
        await tx.agency.delete({ where: { id } })
      })
    } else {
      return c.json({ error: 'Invalid action. Use suspend, activate, or delete.' }, 400)
    }

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: `AGENCY_${action.toUpperCase()}`,
        entityType: 'AGENCY',
        entityId: id,
        details: JSON.stringify({ agencyName: agency.name, action }),
      },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/agencies/:id — Delete an agency (cascade)
app.delete('/agencies/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    // Cascade delete all related records (complete cascade)
    await dbRaw.$transaction(async (tx) => {
      await tx.review.deleteMany({ where: { agencyId: id } })
      await tx.favorite.deleteMany({ where: { agencyId: id } })
      await tx.hardwareOrderItem.deleteMany({ where: { order: { agencyId: id } } })
      await tx.hardwareOrder.deleteMany({ where: { agencyId: id } })
      await tx.enterpriseContractRequest.deleteMany({ where: { agencyId: id } })
      await tx.agencyDevice.deleteMany({ where: { agencyId: id } })
      await tx.agencyStaff.deleteMany({ where: { agencyId: id } })
      await tx.queueSettings.deleteMany({ where: { agencyId: id } })
      await tx.reservation.deleteMany({ where: { agencyId: id } })
      await tx.service.deleteMany({ where: { agencyId: id } })
      await tx.announcement.deleteMany({ where: { agencyId: id } })
      await tx.transaction.deleteMany({ where: { agencyId: id } })
      await tx.branch.deleteMany({ where: { agencyId: id } })
      await tx.agency.delete({ where: { id } })
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'AGENCY_DELETE',
        entityType: 'AGENCY',
        entityId: id,
        details: JSON.stringify({ action: 'delete' }),
      },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/agencies/:id/extend-subscription — Extend an agency's subscription
// by N days. Extends from the current expiry date if still active, otherwise
// starts the clock from now. Logs the action to AuditLog.
app.post('/agencies/:id/extend-subscription', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const agencyId = c.req.param('id')
    const body = await c.req.json()
    const days = parseInt(body?.days, 10)

    if (isNaN(days) || days <= 0) {
      return c.json({ error: 'days must be a positive number' }, 400)
    }

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ error: 'Agency not found' }, 404)

    const now = new Date()
    // Extend from current expiry if still in the future, otherwise start fresh from now
    const baseDate =
      agency.subscriptionExpiresAt && agency.subscriptionExpiresAt > now
        ? agency.subscriptionExpiresAt
        : now

    const newExpiry = new Date(baseDate)
    newExpiry.setDate(newExpiry.getDate() + days)

    await db.agency.update({
      where: { id: agencyId },
      data: {
        subscriptionStatus: 'ACTIVE',
        subscriptionExpiresAt: newExpiry,
        // Stamp the start date if there isn't one already (e.g.legacy agency
        // that was active before the expiry feature shipped)
        ...(agency.subscriptionStartsAt ? {} : { subscriptionStartsAt: now }),
      },
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SUBSCRIPTION_EXTEND',
        entityType: 'AGENCY',
        entityId: agencyId,
        details: JSON.stringify({
          days,
          newExpiry: newExpiry.toISOString(),
          previousExpiry: agency.subscriptionExpiresAt?.toISOString() ?? null,
        }),
      },
    })

    // Compute days remaining from now for convenience
    const daysRemaining = Math.max(
      0,
      Math.ceil((newExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
    )

    return c.json({
      success: true,
      subscriptionExpiresAt: newExpiry.toISOString(),
      daysRemaining,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── Analytics ───────────────────────────────────────────────────────────────

// GET /admin/analytics
app.get('/analytics', async (c) => {
  try {
    await requireAdmin(c)

    const now = new Date()
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // Total reservations (all-time)
    const totalReservations = await db.reservation.count()

    // Registrations trend: daily count for last 30 days
    const registrations = await db.user.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    })

    const dailyRegistrations: Record<string, number> = {}
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().split('T')[0]
      dailyRegistrations[key] = 0
    }
    for (const r of registrations) {
      const key = r.createdAt.toISOString().split('T')[0]
      if (key in dailyRegistrations) {
        dailyRegistrations[key]++
      }
    }

    // Top performing agencies: most reservations in last 30 days
    const topAgencies = await db.reservation.groupBy({
      by: ['agencyId'],
      where: { joinedAt: { gte: thirtyDaysAgo } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    })

    const agencyDetails = await Promise.all(
      topAgencies.map(async (a) => {
        const agency = await db.agency.findUnique({
          where: { id: a.agencyId },
          select: { id: true, name: true, nameAr: true, nameFr: true, category: true },
        })
        return {
          agencyId: a.agencyId,
          name: agency?.name || 'Unknown',
          nameAr: agency?.nameAr,
          nameFr: agency?.nameFr,
          category: agency?.category,
          reservationCount: a._count.id,
        }
      })
    )

    // Average wait times per agency
    const completedReservations = await db.reservation.findMany({
      where: {
        joinedAt: { gte: thirtyDaysAgo },
        calledAt: { not: null },
      },
      select: {
        agencyId: true,
        joinedAt: true,
        calledAt: true,
      },
    })

    const agencyWaitTimes: Record<string, number[]> = {}
    for (const r of completedReservations) {
      if (r.calledAt) {
        const waitMinutes = (r.calledAt.getTime() - r.joinedAt.getTime()) / (1000 * 60)
        if (!agencyWaitTimes[r.agencyId]) agencyWaitTimes[r.agencyId] = []
        agencyWaitTimes[r.agencyId].push(waitMinutes)
      }
    }

    const avgWaitPerAgency = await Promise.all(
      Object.entries(agencyWaitTimes).map(async ([agencyId, times]) => {
        const agency = await db.agency.findUnique({
          where: { id: agencyId },
          select: { name: true },
        })
        return {
          agencyId,
          name: agency?.name || 'Unknown',
          avgWaitTime: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
        }
      })
    )

    // Busiest time slots (hour of day distribution)
    const reservationsWithHour = await db.reservation.findMany({
      where: { joinedAt: { gte: thirtyDaysAgo } },
      select: { joinedAt: true },
    })

    const hourlyDistribution: number[] = new Array(24).fill(0)
    for (const r of reservationsWithHour) {
      const hour = r.joinedAt.getHours()
      hourlyDistribution[hour]++
    }

    // Customer growth trend
    const customerGrowth = await db.user.findMany({
      where: {
        role: 'CUSTOMER',
        createdAt: { gte: thirtyDaysAgo },
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    })

    const dailyCustomerGrowth: Record<string, number> = {}
    let cumulative = 0
    // Get total customers before 30 days ago for cumulative count
    const customersBefore = await db.user.count({
      where: {
        role: 'CUSTOMER',
        createdAt: { lt: thirtyDaysAgo },
      },
    })
    cumulative = customersBefore

    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().split('T')[0]
      const dayCount = customerGrowth.filter(
        (cu) => cu.createdAt.toISOString().split('T')[0] === key
      ).length
      cumulative += dayCount
      dailyCustomerGrowth[key] = cumulative
    }

    // Busiest day of week
    const dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0]
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    for (const r of reservationsWithHour) {
      dayOfWeekCounts[r.joinedAt.getDay()]++
    }
    const busiestDayIndex = dayOfWeekCounts.indexOf(Math.max(...dayOfWeekCounts))

    // Peak hour
    const peakHourIndex = hourlyDistribution.indexOf(Math.max(...hourlyDistribution))

    // Overall average wait time
    const allWaitTimes = Object.values(agencyWaitTimes).flat()
    const overallAvgWait = allWaitTimes.length > 0
      ? Math.round(allWaitTimes.reduce((a, b) => a + b, 0) / allWaitTimes.length)
      : 0

    return c.json({
      quickStats: {
        totalReservations,
        avgWaitTime: overallAvgWait,
        busiestDay: dayNames[busiestDayIndex],
        peakHour: `${peakHourIndex}:00`,
      },
      registrationsTrend: Object.entries(dailyRegistrations).map(([date, count]) => ({ date, count })),
      topAgencies: agencyDetails,
      avgWaitPerAgency,
      peakHours: hourlyDistribution.map((count, hour) => ({ hour, count })),
      customerGrowth: Object.entries(dailyCustomerGrowth).map(([date, total]) => ({ date, total })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Announcements ──────────────────────────────────────────────────────────

const announcementSchema = z.object({
  message: z.string().min(1, 'Message is required').max(500),
  type: z.enum(['INFO', 'WARNING', 'URGENT']).optional().default('INFO'),
})

// GET /admin/announcements — List global announcements
app.get('/announcements', async (c) => {
  try {
    await requireAuth(c)

    const announcements = await db.globalAnnouncement.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
    })

    return c.json({ announcements })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/announcements — Create a global announcement (admin only)
app.post('/announcements', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(announcementSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { message, type } = validation.data

    const announcement = await db.globalAnnouncement.create({
      data: {
        message: message.trim(),
        type,
        createdBy: admin.id,
      },
    })

    return c.json({ announcement }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/announcements — Delete a global announcement
app.delete('/announcements', async (c) => {
  try {
    await requireAdmin(c)

    const id = c.req.query('id')
    if (!id) {
      return c.json({ error: 'id required' }, 400)
    }

    await db.globalAnnouncement.delete({
      where: { id },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Audit Logs ─────────────────────────────────────────────────────────────

// GET /admin/audit-logs
app.get('/audit-logs', async (c) => {
  try {
    await requireAdmin(c)

    const limit = parseInt(c.req.query('limit') || '20', 10)
    const offset = parseInt(c.req.query('offset') || '0', 10)
    const action = c.req.query('action')
    const entityType = c.req.query('entityType')
    const userId = c.req.query('userId')
    const search = c.req.query('search')
    const startDate = c.req.query('startDate')
    const endDate = c.req.query('endDate')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {}

    if (action && action !== 'ALL') {
      where.action = action
    }

    if (entityType && entityType !== 'ALL') {
      where.entityType = entityType
    }

    if (userId && userId !== 'ALL') {
      where.userId = userId
    }

    // Date range filter
    if (startDate || endDate) {
      where.createdAt = {}
      if (startDate) {
        where.createdAt.gte = new Date(startDate)
      }
      if (endDate) {
        where.createdAt.lte = new Date(endDate)
      }
    }

    // Search filter: search in action, details, entityType
    if (search && search.trim()) {
      const q = search.trim()
      where.OR = [
        { action: { contains: q, mode: 'insensitive' } },
        { details: { contains: q, mode: 'insensitive' } },
        { entityType: { contains: q, mode: 'insensitive' } },
        { entityId: { contains: q, mode: 'insensitive' } },
        { user: { fullName: { contains: q, mode: 'insensitive' } } },
        { user: { username: { contains: q, mode: 'insensitive' } } },
      ]
    }

    const [auditLogs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              fullName: true,
              role: true,
              avatarUrl: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.auditLog.count({ where }),
    ])

    // Get unique actions and entity types for filter dropdowns
    const [uniqueActions, uniqueEntityTypes, uniqueUsers] = await Promise.all([
      db.auditLog.findMany({
        select: { action: true },
        distinct: ['action'],
        orderBy: { action: 'asc' },
      }),
      db.auditLog.findMany({
        select: { entityType: true },
        distinct: ['entityType'],
        orderBy: { entityType: 'asc' },
      }),
      db.auditLog.findMany({
        where: { userId: { not: null } },
        select: { userId: true, user: { select: { id: true, username: true, fullName: true } } },
        distinct: ['userId'],
      }),
    ])

    return c.json({
      success: true,
      auditLogs,
      total,
      limit,
      offset,
      filters: {
        actions: uniqueActions.map(a => a.action),
        entityTypes: uniqueEntityTypes.map(e => e.entityType).filter(Boolean),
        users: uniqueUsers.map(u => u.user).filter(Boolean),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Dashboard ──────────────────────────────────────────────────────────────

// GET /admin/dashboard
app.get('/dashboard', async (c) => {
  try {
    await requireAdmin(c)

    const todayStart = getTodayStart()
    const todayEnd = getTodayEnd()

    const [
      totalAgencies,
      activeQueues,
      dailyReservations,
      pendingTransactions,
      completedTransactions,
      totalUsers,
      expiredSubscriptions,
      expiringSoonSubscriptions,
    ] = await Promise.all([
      db.agency.count({ where: { isActive: true } }),
      db.agency.count({ where: { isActive: true, isQueueOpen: true } }),
      db.reservation.count({
        where: { joinedAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.transaction.count({ where: { status: 'PENDING' } }),
      db.transaction.aggregate({
        where: { status: 'APPROVED' },
        _sum: { amount: true },
      }),
      db.user.count({ where: { isActive: true } }),
      // Agencies whose subscription has already expired (expiry date in the past)
      db.agency.count({
        where: {
          subscriptionExpiresAt: { lt: new Date(), not: null },
        },
      }),
      // Agencies whose subscription will expire within the next 7 days
      db.agency.count({
        where: {
          subscriptionExpiresAt: {
            gte: new Date(),
            lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        },
      }),
    ])

    // Get recent activity
    const recentActivity = await db.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { fullName: true, username: true } },
      },
    })

    const totalRevenue = completedTransactions._sum.amount ?? 0

    return c.json({
      stats: {
        totalAgencies,
        activeQueues,
        dailyReservations,
        totalRevenue,
        pendingTransactions,
        totalUsers,
        expiredSubscriptions,
        expiringSoonSubscriptions,
      },
      recentActivity: recentActivity.map(log => ({
        id: log.id,
        action: log.action,
        entity: log.entityType || '',
        details: log.details || log.action,
        createdAt: log.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Export Agencies ─────────────────────────────────────────────────────────

// GET /admin/export/agencies
app.get('/export/agencies', async (c) => {
  try {
    await requireAdmin(c)

    const agencies = await db.agency.findMany({
      include: {
        owner: { select: { fullName: true, username: true, email: true, phoneNumber: true } },
        services: { select: { name: true, isActive: true } },
        _count: {
          select: { reservations: true, staff: true, transactions: true, favorites: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Convert to CSV
    const headers = [
      'Name', 'Name (AR)', 'Code', 'Category', 'City', 'Wilaya',
      'Phone', 'Email', 'Website', 'Owner', 'Owner Email', 'Owner Phone',
      'Services Count', 'Active Services', 'Total Reservations',
      'Staff Count', 'Transactions', 'Favorites',
      'Subscription', 'Status', 'Is Active',
      'Working Hours', 'Created At',
    ]

    const rows = agencies.map((a) => [
      a.name,
      a.nameAr || '',
      a.customCode,
      a.category,
      a.city,
      a.wilaya,
      a.phone || '',
      a.email || '',
      a.website || '',
      a.owner.fullName,
      a.owner.email || '',
      a.owner.phoneNumber || '',
      a.services.length.toString(),
      a.services.filter((s) => s.isActive).length.toString(),
      a._count.reservations.toString(),
      a._count.staff.toString(),
      a._count.transactions.toString(),
      a._count.favorites.toString(),
      a.subscriptionTier,
      a.subscriptionStatus,
      a.isActive ? 'Yes' : 'No',
      `${a.workingHoursStart}-${a.workingHoursEnd}`,
      a.createdAt.toISOString().split('T')[0],
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')
      ),
    ].join('\n')

    return c.body(csvContent, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="agencies-export.csv"',
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Export Users ────────────────────────────────────────────────────────────

// GET /admin/export/users
app.get('/export/users', async (c) => {
  try {
    await requireAdmin(c)

    const users = await db.user.findMany({
      include: {
        _count: {
          select: { reservations: true, favorites: true, auditLogs: true, notifications: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Convert to CSV
    const headers = [
      'Username', 'Full Name', 'Email', 'Phone', 'Role', 'Language',
      'Is Active', 'Free SMS', 'Reservations', 'Favorites',
      'Audit Logs', 'Notifications', 'Created At',
    ]

    const rows = users.map((u) => [
      u.username,
      u.fullName,
      u.email || '',
      u.phoneNumber || '',
      u.role,
      u.language,
      u.isActive ? 'Yes' : 'No',
      u.freeSmsCount.toString(),
      u._count.reservations.toString(),
      u._count.favorites.toString(),
      u._count.auditLogs.toString(),
      u._count.notifications.toString(),
      u.createdAt.toISOString().split('T')[0],
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map((row) =>
        row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')
      ),
    ].join('\n')

    return c.body(csvContent, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="users-export.csv"',
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── FAQ (singular path) ────────────────────────────────────────────────────

const faqUpdateSchema = faqSchema.extend({
  id: z.string().min(1, 'FAQ ID is required'),
})

// GET /admin/faq
app.get('/faq', async (c) => {
  try {
    await requireAdmin(c)

    const faqs = await db.fAQ.findMany({
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
    })
    return c.json({ faqs })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/faq
app.post('/faq', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(faqSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { question, answer, questionAr, answerAr, questionFr, answerFr, category, order, isActive } = validation.data

    const faq = await db.fAQ.create({
      data: {
        question,
        answer,
        questionAr: questionAr || null,
        answerAr: answerAr || null,
        questionFr: questionFr || null,
        answerFr: answerFr || null,
        category: category || 'GENERAL',
        order: order ?? 0,
        isActive: isActive ?? true,
      },
    })

    return c.json({ faq }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PUT /admin/faq
app.put('/faq', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(faqUpdateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { id, question, answer, questionAr, answerAr, questionFr, answerFr, category, order, isActive } = validation.data

    const faq = await db.fAQ.update({
      where: { id },
      data: {
        ...(question !== undefined && { question }),
        ...(answer !== undefined && { answer }),
        ...(questionAr !== undefined && { questionAr }),
        ...(answerAr !== undefined && { answerAr }),
        ...(questionFr !== undefined && { questionFr }),
        ...(answerFr !== undefined && { answerFr }),
        ...(category !== undefined && { category }),
        ...(order !== undefined && { order }),
        ...(isActive !== undefined && { isActive }),
      },
    })

    return c.json({ faq })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/faq
app.delete('/faq', async (c) => {
  try {
    await requireAdmin(c)

    const id = c.req.query('id')

    if (!id) {
      return c.json({ error: 'FAQ ID is required' }, 400)
    }

    await db.fAQ.delete({ where: { id } })
    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── FAQs (plural path) ─────────────────────────────────────────────────────

const faqsUpdateSchema = faqSchema.extend({
  id: z.string().min(1, 'FAQ ID is required'),
})

// GET /admin/faqs — Get all FAQs (including inactive)
app.get('/faqs', async (c) => {
  try {
    await requireAdmin(c)

    const faqs = await db.fAQ.findMany({
      orderBy: { order: 'asc' },
    })
    return c.json({ faqs })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/faqs — Create new FAQ
app.post('/faqs', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(faqSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { question, questionFr, questionAr, answer, answerFr, answerAr, category, order, isActive } = validation.data

    const faq = await db.fAQ.create({
      data: {
        question,
        questionFr: questionFr || null,
        questionAr: questionAr || null,
        answer,
        answerFr: answerFr || null,
        answerAr: answerAr || null,
        category: category || 'GENERAL',
        order: order ?? 0,
        isActive: isActive !== undefined ? isActive : true,
      },
    })

    return c.json({ faq }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PUT /admin/faqs — Update FAQ
app.put('/faqs', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(faqsUpdateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { id, question, questionFr, questionAr, answer, answerFr, answerAr, category, order, isActive } = validation.data

    const existing = await db.fAQ.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ error: 'FAQ not found' }, 404)
    }

    const faq = await db.fAQ.update({
      where: { id },
      data: {
        ...(question !== undefined && { question }),
        ...(questionFr !== undefined && { questionFr: questionFr || null }),
        ...(questionAr !== undefined && { questionAr: questionAr || null }),
        ...(answer !== undefined && { answer }),
        ...(answerFr !== undefined && { answerFr: answerFr || null }),
        ...(answerAr !== undefined && { answerAr: answerAr || null }),
        ...(category !== undefined && { category }),
        ...(order !== undefined && { order }),
        ...(isActive !== undefined && { isActive }),
      },
    })

    return c.json({ faq })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/faqs — Delete FAQ
app.delete('/faqs', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const { id } = body

    if (!id || typeof id !== 'string') {
      return c.json({ error: 'FAQ ID is required' }, 400)
    }

    const existing = await db.fAQ.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ error: 'FAQ not found' }, 404)
    }

    await db.fAQ.delete({ where: { id } })
    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── FAQs Seed ──────────────────────────────────────────────────────────────

const SEED_FAQS = [
  {
    question: 'How long does activation take?',
    questionFr: "Combien de temps prend l'activation ?",
    questionAr: 'كم يستغرق التفعيل؟',
    answer: 'Your account is typically activated within 1-2 business days after payment verification.',
    answerFr: 'Votre compte est généralement activé sous 1-2 jours ouvrables après vérification du paiement.',
    answerAr: 'يتم تفعيل حسابك عادة خلال 1-2 يوم عمل بعد التحقق من الدفع.',
    category: 'SUBSCRIPTION',
    order: 0,
  },
  {
    question: 'Can I change plans?',
    questionFr: 'Puis-je changer de forfait ?',
    questionAr: 'هل يمكنني تغيير الباقة؟',
    answer: 'Yes, you can upgrade at any time. The price difference will be prorated.',
    answerFr: 'Oui, vous pouvez passer à un forfait supérieur à tout moment. La différence sera calculée au prorata.',
    answerAr: 'نعم، يمكنك الترقية في أي وقت. سيتم احتساب فرق السعر بشكل نسبي.',
    category: 'SUBSCRIPTION',
    order: 1,
  },
  {
    question: 'What happens when my subscription expires?',
    questionFr: "Que se passe-t-il quand l'abonnement expire ?",
    questionAr: 'ماذا يحدث عند انتهاء الاشتراك؟',
    answer: 'Your account reverts to the free tier. All data is preserved for 30 days.',
    answerFr: 'Votre compte revient au forfait gratuit. Toutes les données sont conservées pendant 30 jours.',
    answerAr: 'يعود حسابك إلى الباقة المجانية. يتم الاحتفاظ بجميع البيانات لمدة 30 يوماً.',
    category: 'SUBSCRIPTION',
    order: 2,
  },
  {
    question: 'Is there a free trial?',
    questionFr: 'Y a-t-il un essai gratuit ?',
    questionAr: 'هل توجد فترة تجريبية مجانية؟',
    answer: 'Yes! All new accounts get a 14-day free trial of the Premium plan.',
    answerFr: "Oui ! Tous les nouveaux comptes bénéficient d'un essai gratuit de 14 jours du forfait Premium.",
    answerAr: 'نعم! جميع الحسابات الجديدة تحصل على تجربة مجانية لمدة 14 يوماً من باقة بريميوم.',
    category: 'SUBSCRIPTION',
    order: 3,
  },
  {
    question: 'Can I get a refund?',
    questionFr: 'Puis-je obtenir un remboursement ?',
    questionAr: 'هل يمكنني استرداد المبلغ؟',
    answer: "Refunds are available within 7 days of purchase if the service hasn't been used.",
    answerFr: "Le remboursement est disponible sous 7 jours après l'achat si le service n'a pas été utilisé.",
    answerAr: 'الاسترداد متاح خلال 7 أيام من الشراء إذا لم يتم استخدام الخدمة.',
    category: 'SUBSCRIPTION',
    order: 4,
  },
]

// POST /admin/faqs/seed
app.post('/faqs/seed', async (c) => {
  try {
    await requireAdmin(c)

    // Check if FAQs already exist
    const existingCount = await db.fAQ.count()
    if (existingCount > 0) {
      return c.json({ message: 'FAQs already seeded', count: existingCount })
    }

    const created = await db.$transaction(
      SEED_FAQS.map((faq) => db.fAQ.create({ data: faq }))
    )

    return c.json({ message: 'FAQs seeded successfully', count: created.length })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Loadtest Results ───────────────────────────────────────────────────────

// GET /admin/loadtest-results
app.get('/loadtest-results', async (c) => {
  try {
    await requireAdmin(c)

    const testsDir = path.join(process.cwd(), 'tests')

    let summaryText: string | null = null
    let reportJson: Record<string, unknown> | null = null

    // Read summary text file
    const summaryPath = path.join(testsDir, 'loadtest-summary-10k.txt')
    if (fs.existsSync(summaryPath)) {
      summaryText = fs.readFileSync(summaryPath, 'utf-8')
    }

    // Read JSON report
    const reportPath = path.join(testsDir, 'loadtest-report-10k.json')
    if (fs.existsSync(reportPath)) {
      try {
        const raw = fs.readFileSync(reportPath, 'utf-8')
        reportJson = JSON.parse(raw)
      } catch {
        // ignore parse errors
      }
    }

    // Also check for the basic loadtest results
    const basicSummaryPath = path.join(testsDir, 'loadtest-summary.txt')
    if (!summaryText && fs.existsSync(basicSummaryPath)) {
      summaryText = fs.readFileSync(basicSummaryPath, 'utf-8')
    }

    const basicReportPath = path.join(testsDir, 'loadtest-report.json')
    if (!reportJson && fs.existsSync(basicReportPath)) {
      try {
        const raw = fs.readFileSync(basicReportPath, 'utf-8')
        reportJson = JSON.parse(raw)
      } catch {
        // ignore parse errors
      }
    }

    const hasResults = !!(summaryText || reportJson)

    return c.json({
      success: true,
      hasResults,
      summary: summaryText,
      report: reportJson,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Payment Settings ───────────────────────────────────────────────────────

// GET /admin/payment-settings
app.get('/payment-settings', async (c) => {
  try {
    await requireAdmin(c)

    let settings = await db.paymentSettings.findFirst()
    if (!settings) {
      // Create default settings if none exist
      settings = await db.paymentSettings.create({ data: {} })
    }
    return c.json({ settings })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PUT /admin/payment-settings
app.put('/payment-settings', async (c) => {
  try {
    await requireAdmin(c)

    let settings = await db.paymentSettings.findFirst()
    if (!settings) {
      settings = await db.paymentSettings.create({ data: {} })
    }

    const body = await c.req.json()
    const validation = validateBody(paymentSettingsSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const validatedData = validation.data

    const updated = await db.paymentSettings.update({
      where: { id: settings.id },
      data: {
        ...(validatedData.ccpEnabled !== undefined && { ccpEnabled: validatedData.ccpEnabled }),
        ...(validatedData.bankEnabled !== undefined && { bankEnabled: validatedData.bankEnabled }),
        ...(validatedData.electronicEnabled !== undefined && { electronicEnabled: validatedData.electronicEnabled }),
        ...(validatedData.ccpAccount !== undefined && { ccpAccount: validatedData.ccpAccount }),
        ...(validatedData.ccpKey !== undefined && { ccpKey: validatedData.ccpKey }),
        ...(validatedData.bankAccount !== undefined && { bankAccount: validatedData.bankAccount }),
        ...(validatedData.bankRib !== undefined && { bankRib: validatedData.bankRib }),
        ...(validatedData.bankName !== undefined && { bankName: validatedData.bankName }),
        ...(validatedData.ewalletNumber !== undefined && { ewalletNumber: validatedData.ewalletNumber }),
      },
    })

    return c.json({ settings: updated })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Performance ────────────────────────────────────────────────────────────

// GET /admin/performance
app.get('/performance', async (c) => {
  try {
    await requireAdmin(c)

    const todayStart = getTodayStart()
    const todayEnd = getTodayEnd()

    // ── Database stats (parallel queries) ──
    const [
      totalUsers,
      totalAgencies,
      totalReservations,
      activeReservations,
      totalNotifications,
      totalAuditLogs,
    ] = await Promise.all([
      db.user.count(),
      db.agency.count(),
      db.reservation.count(),
      db.reservation.count({ where: { status: { in: ['WAITING', 'CALLED'] } } }),
      db.notification.count(),
      db.auditLog.count(),
    ])

    // ── Queue stats ──
    const [totalOpenQueues, totalWaitingCustomers, totalCalledCustomers] = await Promise.all([
      db.agency.count({ where: { isQueueOpen: true, isActive: true } }),
      db.reservation.count({ where: { status: 'WAITING' } }),
      db.reservation.count({ where: { status: 'CALLED' } }),
    ])

    // Queue sizes per open agency
    const queueSizes = await db.reservation.groupBy({
      by: ['agencyId'],
      where: { status: { in: ['WAITING', 'CALLED'] } },
      _count: { id: true },
    })
    const queueSizeValues = queueSizes.map((q) => q._count.id)
    const avgQueueSize = queueSizeValues.length > 0
      ? queueSizeValues.reduce((a, b) => a + b, 0) / queueSizeValues.length
      : 0
    const maxQueueSize = queueSizeValues.length > 0 ? Math.max(...queueSizeValues) : 0

    // Queues by category
    const agenciesByCategory = await db.agency.findMany({
      where: { isQueueOpen: true, isActive: true },
      select: { id: true, category: true },
    })
    const categoryMap = new Map<string, { open: number; waiting: number }>()
    for (const agency of agenciesByCategory) {
      const cat = agency.category || 'Other'
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, { open: 0, waiting: 0 })
      }
      categoryMap.get(cat)!.open += 1
    }
    // Count waiting per category
    const waitingByCategory = await db.reservation.groupBy({
      by: ['agencyId'],
      where: { status: 'WAITING' },
      _count: { id: true },
    })
    const agencyIdToCategory = new Map(agenciesByCategory.map((a) => [a.id, a.category || 'Other']))
    for (const wbc of waitingByCategory) {
      const cat = agencyIdToCategory.get(wbc.agencyId) || 'Other'
      if (categoryMap.has(cat)) {
        categoryMap.get(cat)!.waiting += wbc._count.id
      }
    }
    const queuesByCategory: Record<string, { open: number; waiting: number }> = {}
    for (const [cat, data] of categoryMap) {
      queuesByCategory[cat] = data
    }

    // ── Today's activity ──
    const [todayJoins, todayCompletions, todayCancellations] = await Promise.all([
      db.reservation.count({
        where: { joinedAt: { gte: todayStart, lte: todayEnd } },
      }),
      db.reservation.count({
        where: { completedAt: { gte: todayStart, lte: todayEnd }, status: 'COMPLETED' },
      }),
      db.reservation.count({
        where: { cancelledAt: { gte: todayStart, lte: todayEnd }, status: 'CANCELLED' },
      }),
    ])

    // Estimate avg wait time from completed reservations today
    const completedToday = await db.reservation.findMany({
      where: {
        completedAt: { gte: todayStart, lte: todayEnd },
        status: 'COMPLETED',
        calledAt: { not: null },
      },
      select: { joinedAt: true, calledAt: true },
      take: 100,
    })
    let avgWaitTime = 0
    if (completedToday.length > 0) {
      const totalWaitMs = completedToday.reduce((acc, r) => {
        if (r.calledAt) {
          return acc + (new Date(r.calledAt).getTime() - new Date(r.joinedAt).getTime())
        }
        return acc
      }, 0)
      avgWaitTime = Math.max(0, Math.round(totalWaitMs / completedToday.length / 1000 / 60)) // minutes
    }

    // ── Database file size (SQLite) ──
    let dbSizeBytes = 0
    try {
      const dbUrl = process.env.DATABASE_URL || ''
      const dbPathMatch = dbUrl.match(/file:(.+)/)
      const dbPath = dbPathMatch ? dbPathMatch[1] : path.join(process.cwd(), 'db', 'dev.db')
      if (fs.existsSync(dbPath)) {
        const stats = fs.statSync(dbPath)
        dbSizeBytes = stats.size
      }
    } catch {
      // ignore
    }

    // ── System info ──
    const memoryUsage = process.memoryUsage()

    return c.json({
      success: true,
      performance: {
        database: {
          totalUsers,
          totalAgencies,
          totalReservations,
          activeReservations,
          totalNotifications,
          totalAuditLogs,
          dbSizeBytes,
        },
        queues: {
          totalOpenQueues,
          totalWaitingCustomers,
          totalCalledCustomers,
          avgQueueSize: Math.round(avgQueueSize * 10) / 10,
          maxQueueSize,
          queuesByCategory,
        },
        today: {
          joins: todayJoins,
          completions: todayCompletions,
          cancellations: todayCancellations,
          avgWaitTime,
        },
        system: {
          uptime: process.uptime(),
          memoryUsage: {
            rss: memoryUsage.rss,
            heapTotal: memoryUsage.heapTotal,
            heapUsed: memoryUsage.heapUsed,
            external: memoryUsage.external,
            arrayBuffers: memoryUsage.arrayBuffers,
          },
          nodeVersion: process.version,
          platform: process.platform,
          cpus: os.cpus().length,
        },
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── SMS Settings ───────────────────────────────────────────────────────────

const smsTestSchema = z.object({
  action: z.enum(['validate', 'test']).optional(),
  phoneNumber: z.string().optional(),
})

// GET /admin/sms-settings — Return SMS settings + usage stats + providers
app.get('/sms-settings', async (c) => {
  try {
    await requireAdmin(c)

    const [settings, stats, recentLogs] = await Promise.all([
      getSmsSettings(),
      getSmsUsageStats(),
      getRecentSmsLogs(10),
    ])

    return c.json({
      settings: {
        ...settings,
        apiKey: maskApiKey(settings.apiKey),
      },
      stats,
      recentLogs,
      providers: Object.entries(ALGERIAN_PROVIDERS).map(([id, p]) => ({
        id,
        name: p.name,
        description: p.description,
        defaultApiUrl: p.defaultApiUrl,
        senderIdSupport: p.senderIdSupport,
        docsUrl: p.docsUrl,
      })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PUT /admin/sms-settings — Update SMS settings
app.put('/sms-settings', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(smsSettingsSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const {
      provider,
      apiUrl,
      apiKey,
      senderName,
      enabled,
      templateTurnApproaching,
      templateYourTurn,
      templateNoShow,
      templateCustom,
    } = validation.data
    const { smsPerReminder, maxSmsPerDay, testPhoneNumber } = body

    // Validate provider
    if (provider && !ALGERIAN_PROVIDERS[provider]) {
      return c.json(
        { error: `Invalid provider. Supported: ${Object.keys(ALGERIAN_PROVIDERS).join(', ')}` },
        400
      )
    }

    // Validate sender name for providers that require numeric sender
    if (senderName && provider) {
      const providerInfo = ALGERIAN_PROVIDERS[provider as keyof typeof ALGERIAN_PROVIDERS]
      if (providerInfo && !providerInfo.senderIdSupport) {
        if (!senderName.match(/^\+?\d{10,15}$/)) {
          return c.json(
            { error: `${providerInfo.name} requires a phone number as sender (not alphanumeric).` },
            400
          )
        }
      }
      // Sender name length check (max 11 chars for alphanumeric)
      if (senderName.length > 11) {
        return c.json(
          { error: 'Sender name must be 11 characters or less' },
          400
        )
      }
    }

    // Validate test phone format
    if (testPhoneNumber) {
      const normalized = normalizeDzPhone(testPhoneNumber)
      if (!normalized && provider !== 'twilio' && provider !== 'vonage') {
        return c.json(
          { error: 'Invalid Algerian phone number. Expected format: +213XXXXXXXXX or 0XXXXXXXXX (e.g., 0555123456)' },
          400
        )
      }
    }

    const settings = await getSmsSettings()

    const updateData: Record<string, unknown> = {}
    if (provider !== undefined) updateData.provider = provider
    if (apiUrl !== undefined) updateData.apiUrl = apiUrl
    if (apiKey !== undefined) updateData.apiKey = apiKey
    if (senderName !== undefined) updateData.senderName = senderName
    if (enabled !== undefined) updateData.enabled = enabled
    if (smsPerReminder !== undefined) updateData.smsPerReminder = smsPerReminder
    if (maxSmsPerDay !== undefined) updateData.maxSmsPerDay = maxSmsPerDay
    if (testPhoneNumber !== undefined) updateData.testPhoneNumber = testPhoneNumber
    if (templateTurnApproaching !== undefined) updateData.templateTurnApproaching = templateTurnApproaching
    if (templateYourTurn !== undefined) updateData.templateYourTurn = templateYourTurn
    if (templateNoShow !== undefined) updateData.templateNoShow = templateNoShow
    if (templateCustom !== undefined) updateData.templateCustom = templateCustom

    const updated = await db.smsSettings.update({
      where: { id: settings.id },
      data: updateData,
    })

    // If provider changed, auto-fill the default API URL
    if (provider && !apiUrl && ALGERIAN_PROVIDERS[provider as keyof typeof ALGERIAN_PROVIDERS]) {
      const defaultUrl = ALGERIAN_PROVIDERS[provider as keyof typeof ALGERIAN_PROVIDERS].defaultApiUrl
      if (defaultUrl && updated.apiUrl !== defaultUrl) {
        await db.smsSettings.update({
          where: { id: settings.id },
          data: { apiUrl: defaultUrl },
        })
        updated.apiUrl = defaultUrl
      }
    }

    return c.json({
      settings: {
        ...updated,
        apiKey: maskApiKey(updated.apiKey),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/sms-settings — Send test SMS
app.post('/sms-settings', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(smsTestSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { action, phoneNumber } = validation.data

    // Support both old format (just phoneNumber) and new format (action + phoneNumber)
    if (action === 'validate') {
      // Validate gateway connectivity
      const result = await validateGatewayConnection()
      return c.json(result)
    }

    const phone = phoneNumber
    if (!phone || !phone.trim()) {
      return c.json({ error: 'Phone number is required' }, 400)
    }

    const result = await sendSms(phone.trim(), '[BLASTI] Test SMS - SMS gateway is working correctly.')

    if (result.success) {
      return c.json({ success: true, logId: result.logId })
    }

    return c.json(
      { success: false, error: result.error, responseRaw: result.responseRaw },
      400
    )
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Stats ──────────────────────────────────────────────────────────────────

// GET /admin/stats
app.get('/stats', async (c) => {
  try {
    await requireAdmin(c)

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // Run all queries in parallel for performance
    const [
      totalAgencies,
      activeQueues,
      todayReservations,
      totalRevenue,
      pendingTransactions,
      totalUsers,
      totalReservations,
    ] = await Promise.all([
      // Total agencies
      db.agency.count({
        where: { isActive: true },
      }),

      // Active queues (agencies with isQueueOpen and not paused)
      db.queueSettings.count({
        where: { isPaused: false },
      }),

      // Today's reservations
      db.reservation.count({
        where: {
          joinedAt: { gte: today },
        },
      }),

      // Total revenue (approved transactions)
      db.transaction.aggregate({
        where: { status: 'APPROVED' },
        _sum: { amount: true },
      }),

      // Pending transactions count
      db.transaction.count({
        where: { status: 'PENDING' },
      }),

      // Total users
      db.user.count(),

      // Total reservations
      db.reservation.count(),
    ])

    // Get recent reservations for today
    const recentReservations = await db.reservation.findMany({
      where: {
        joinedAt: { gte: today },
      },
      orderBy: { joinedAt: 'desc' },
      take: 5,
      include: {
        agency: {
          select: { name: true },
        },
        service: {
          select: { name: true },
        },
      },
    })

    return c.json({
      success: true,
      stats: {
        totalAgencies,
        activeQueues,
        todayReservations,
        totalRevenue: totalRevenue._sum.amount || 0,
        pendingTransactions,
        totalUsers,
        totalReservations,
        recentReservations,
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Transactions ───────────────────────────────────────────────────────────

const reviewTransactionSchema = z.object({
  action: z.enum(['approve', 'reject'], { message: 'Action must be "approve" or "reject"' }),
  reason: z.string().max(500).optional(),
})

// POST /admin/transactions/:id — Review (approve/reject) a transaction
app.post('/transactions/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(reviewTransactionSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { action, reason } = validation.data

    const transaction = await db.transaction.findUnique({ where: { id } })
    if (!transaction) return c.json({ error: 'Transaction not found' }, 404)

    if (transaction.status !== 'PENDING') {
      return c.json(
        { error: `Transaction already ${transaction.status.toLowerCase()}` },
        400
      )
    }

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED'

    const updated = await db.transaction.update({
      where: { id },
      data: {
        status: newStatus,
        reviewedBy: admin.id,
        reviewedAt: new Date(),
        rejectionReason: action === 'reject' ? reason : null,
      },
      include: {
        agency: {
          select: {
            id: true,
            name: true,
            customCode: true,
            subscriptionTier: true,
            subscriptionStatus: true,
          },
        },
      },
    })

    if (action === 'approve') {
      // ─── Phase: Subscription expiry ───────────────────────────────────
      // Look up the plan to get the billing cycle, then compute the expiry
      // date. ONE_TIME plans never expire (null), MONTHLY = +30 days,
      // YEARLY = +365 days. Also stamps the start of the new period.
      //
      // Period-discount extension: when the agency paid for an extended
      // billing period (3/6/12/24 months via /subscription/pay), the period
      // is encoded in transaction.planName as a `(${period}m)` suffix.
      // We recover it here and use it to compute the exact expiry
      // (now + period months) — overriding the plan's default billingCycle.
      const planRecord = await db.subscriptionPlan.findFirst({
        where: { name: transaction.plan, isActive: true },
      })

      // Parse period from the planName snapshot (e.g. "PREMIUM (3m)" → 3).
      // Falls back to 1 (monthly) when no suffix is present.
      const periodMatch = transaction.planName?.match(/\((\d+)m\)$/)
      const period = periodMatch ? parseInt(periodMatch[1], 10) : 1

      const now = new Date()
      let subscriptionExpiresAt: Date | null = null

      if (period > 1) {
        // Extended billing period — add `period` months to today.
        subscriptionExpiresAt = new Date(now)
        subscriptionExpiresAt.setMonth(subscriptionExpiresAt.getMonth() + period)
      } else if (planRecord) {
        // Default monthly/yearly/one-time behaviour (backward compatible).
        switch (planRecord.billingCycle) {
          case 'MONTHLY':
            subscriptionExpiresAt = new Date(now)
            subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 30)
            break
          case 'YEARLY':
            subscriptionExpiresAt = new Date(now)
            subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 365)
            break
          case 'ONE_TIME':
            subscriptionExpiresAt = null // No expiry
            break
          default:
            subscriptionExpiresAt = new Date(now)
            subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 30) // Default to monthly
        }
      }

      await db.agency.update({
        where: { id: transaction.agencyId },
        data: {
          subscriptionStatus: 'ACTIVE',
          subscriptionTier: transaction.plan,
          subscriptionPlanId: planRecord?.id || undefined,
          subscriptionStartsAt: now,
          subscriptionExpiresAt,
        },
      })
    } else {
      // Rejected - reset agency subscription status
      await db.agency.update({
        where: { id: transaction.agencyId },
        data: {
          subscriptionStatus: 'INACTIVE',
        },
      })
    }

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: action === 'approve' ? 'PAYMENT_APPROVE' : 'PAYMENT_REJECT',
        entityType: 'TRANSACTION',
        entityId: id,
        details: JSON.stringify({ plan: transaction.plan, amount: transaction.amount, reason }),
      },
    })

    return c.json({ success: true, transaction: updated })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Users ──────────────────────────────────────────────────────────────────

// GET /admin/users
app.get('/users', async (c) => {
  try {
    await requireAdmin(c)

    const search = c.req.query('search') || ''
    const role = c.req.query('role') || ''
    const status = c.req.query('status') || ''
    const page = parseInt(c.req.query('page') || '1')
    const rawLimit = parseInt(c.req.query('limit') || '20')
    const limit = Math.min(Math.max(rawLimit, 1), 100)

    const where: Record<string, unknown> = {}

    if (search) {
      where.OR = [
        { username: { contains: search } },
        { fullName: { contains: search } },
        { email: { contains: search } },
      ]
    }

    if (role) {
      where.role = role
    }

    if (status === 'active') {
      where.isActive = true
    } else if (status === 'suspended') {
      where.isActive = false
    }

    const [users, total] = await Promise.all([
      db.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          role: true,
          language: true,
          isActive: true,
          createdAt: true,
          avatarUrl: true,
          phoneNumber: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.user.count({ where }),
    ])

    // Fetch agency names for agency owners
    const userIds = users.map((u) => u.id)
    const agencies = await db.agency.findMany({
      where: { ownerId: { in: userIds } },
      select: { ownerId: true, name: true, nameAr: true, nameFr: true },
    })
    const agencyMap = Object.fromEntries(agencies.map((a) => [a.ownerId, a]))

    const enrichedUsers = users.map((u) => ({
      ...u,
      agencyName: agencyMap[u.id]?.name || null,
    }))

    return c.json({
      success: true,
      users: enrichedUsers,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/users — Suspend/activate a user (body-based)
app.patch('/users', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(adminUserActionSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { userId, action } = validation.data

    const targetUser = await db.user.findUnique({ where: { id: userId } })
    if (!targetUser) {
      return c.json(
        { success: false, error: 'User not found' },
        404
      )
    }

    // Prevent modifying super admin accounts
    if (targetUser.role === 'SUPER_ADMIN') {
      return c.json(
        { success: false, error: 'Cannot modify super admin accounts' },
        403
      )
    }

    if (action === 'suspend') {
      const user = await db.user.update({
        where: { id: userId },
        data: { isActive: false },
        select: { id: true, fullName: true, isActive: true },
      })

      // Also deactivate associated agency if user is an agency owner
      if (targetUser.role === 'AGENCY_OWNER') {
        await db.agency.updateMany({
          where: { ownerId: userId },
          data: { isActive: false },
        })
      }

      await db.auditLog.create({
        data: {
          userId: admin.id,
          action: 'USER_SUSPEND',
          entityType: 'USER',
          entityId: userId,
          details: JSON.stringify({ fullName: targetUser.fullName, role: targetUser.role }),
        },
      })

      return c.json({ success: true, user })
    }

    if (action === 'activate') {
      const user = await db.user.update({
        where: { id: userId },
        data: { isActive: true },
        select: { id: true, fullName: true, isActive: true },
      })

      // Also reactivate associated agency if user is an agency owner
      if (targetUser.role === 'AGENCY_OWNER') {
        await db.agency.updateMany({
          where: { ownerId: userId },
          data: { isActive: true },
        })
      }

      await db.auditLog.create({
        data: {
          userId: admin.id,
          action: 'USER_ACTIVATE',
          entityType: 'USER',
          entityId: userId,
          details: JSON.stringify({ fullName: targetUser.fullName, role: targetUser.role }),
        },
      })

      return c.json({ success: true, user })
    }

    return c.json(
      { success: false, error: 'Invalid action. Use "suspend" or "activate".' },
      400
    )
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/users — Delete a user
app.delete('/users', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const userIdSchema = z.object({ userId: z.string().min(1, 'User ID is required') })
    const validation = validateBody(userIdSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { userId } = validation.data

    // Prevent deleting super admin accounts
    const targetUser = await db.user.findUnique({ where: { id: userId } })
    if (!targetUser) {
      return c.json(
        { success: false, error: 'User not found' },
        404
      )
    }

    if (targetUser.role === 'SUPER_ADMIN') {
      return c.json(
        { success: false, error: 'Cannot delete super admin accounts' },
        403
      )
    }

    // Get agencyId before deleting (for agency cleanup)
    const agency = await db.agency.findFirst({ where: { ownerId: userId } })

    // Use transaction for atomic deletion.
    // Uses dbRaw to bypass the ghost-delete extension (deleteMany crashes
    // inside $transaction in Prisma 6.x).
    await dbRaw.$transaction(async (tx) => {
      // Delete agency-related records first (complete cascade)
      if (agency) {
        await tx.review.deleteMany({ where: { agencyId: agency.id } })
        await tx.favorite.deleteMany({ where: { agencyId: agency.id } })
        await tx.hardwareOrderItem.deleteMany({ where: { order: { agencyId: agency.id } } })
        await tx.hardwareOrder.deleteMany({ where: { agencyId: agency.id } })
        await tx.enterpriseContractRequest.deleteMany({ where: { agencyId: agency.id } })
        await tx.agencyDevice.deleteMany({ where: { agencyId: agency.id } })
        await tx.agencyStaff.deleteMany({ where: { agencyId: agency.id } })
        await tx.queueSettings.deleteMany({ where: { agencyId: agency.id } })
        await tx.reservation.deleteMany({ where: { agencyId: agency.id } })
        await tx.service.deleteMany({ where: { agencyId: agency.id } })
        await tx.announcement.deleteMany({ where: { agencyId: agency.id } })
        await tx.transaction.deleteMany({ where: { agencyId: agency.id } })
        await tx.branch.deleteMany({ where: { agencyId: agency.id } })
        await tx.agency.delete({ where: { id: agency.id } })
      }

      // Delete user's reservations (as customer)
      await tx.reservation.deleteMany({ where: { userId } })
      // Delete user's favorites
      await tx.favorite.deleteMany({ where: { userId } })
      // Delete user's notifications
      await tx.notification.deleteMany({ where: { userId } })
      // Delete user's audit logs
      await tx.auditLog.deleteMany({ where: { userId } })
      // Delete user's staff memberships
      await tx.agencyStaff.deleteMany({ where: { userId } })
      // Delete user's reviews (as customer)
      await tx.review.deleteMany({ where: { userId } })
      // Delete user's SMS purchases
      await tx.smsPurchase.deleteMany({ where: { userId } })
      // Delete user's delayed jobs
      await tx.delayedJob.deleteMany({ where: { userId } })
      // Delete user's device registrations
      await tx.deviceRegistration.deleteMany({ where: { userId } })
      // Clear transaction reviews
      await tx.transaction.updateMany({
        where: { reviewedBy: userId },
        data: { reviewedBy: null },
      })

      // Finally delete the user
      await tx.user.delete({ where: { id: userId } })
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'USER_DELETE',
        entityType: 'USER',
        entityId: userId,
        details: JSON.stringify({ fullName: targetUser.fullName, role: targetUser.role, username: targetUser.username }),
      },
    })

    return c.json({ success: true, message: 'User deleted successfully' })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Users by ID ────────────────────────────────────────────────────────────

const userActionSchema = z.object({
  action: z.enum(['suspend', 'activate']),
})

// PATCH /admin/users/:id — Suspend/activate a user by ID
app.patch('/users/:id', async (c) => {
  try {
    await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(userActionSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { action } = validation.data

    let updateData: { isActive: boolean }

    if (action === 'suspend') {
      updateData = { isActive: false }
    } else if (action === 'activate') {
      updateData = { isActive: true }
    } else {
      return c.json(
        { success: false, error: 'Invalid action. Use "suspend" or "activate".' },
        400
      )
    }

    const user = await db.user.update({
      where: { id },
      data: updateData,
      select: { id: true, fullName: true, isActive: true },
    })

    return c.json({ success: true, user })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Users Reset Password ──────────────────────────────────────────────────

// POST /admin/users/:id/reset-password
app.post('/users/:id/reset-password', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const newPassword = 'password123'

    // Verify user exists
    const user = await db.user.findUnique({
      where: { id },
    })

    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }

    // Hash the new password (same method as register)
    const salt = process.env.PASSWORD_SALT || 'blasti-salt-2024'
    const passwordHash = scryptSync(newPassword, salt, 64).toString('hex')

    // Update password
    await db.user.update({
      where: { id },
      data: { passwordHash },
    })

    // Create audit log
    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SETTINGS_UPDATE',
        entityType: 'USER',
        entityId: user.id,
        details: JSON.stringify({ action: 'password_reset', targetUser: user.username }),
      },
    })

    return c.json({
      success: true,
      newPassword,
      username: user.username,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Subscription Plans ─────────────────────────────────────────────────────

// GET /admin/subscription-plans — List all plans with their features
app.get('/subscription-plans', async (c) => {
  try {
    await requireAdmin(c)

    const plans = await db.subscriptionPlan.findMany({
      include: {
        features: true,
        _count: {
          select: { agencies: true },
        },
      },
      orderBy: { sortOrder: 'asc' },
    })

    return c.json({ success: true, plans })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/subscription-plans — Create a new plan
app.post('/subscription-plans', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(createSubscriptionPlanSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data

    // Check for duplicate name
    const existing = await db.subscriptionPlan.findUnique({ where: { name: data.name } })
    if (existing) {
      return c.json({ success: false, error: 'A plan with this name already exists' }, 409)
    }

    const plan = await db.subscriptionPlan.create({ data })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SUBSCRIPTION_PLAN_CREATE',
        entityType: 'SUBSCRIPTION_PLAN',
        entityId: plan.id,
        details: JSON.stringify({ planName: plan.name, displayName: plan.displayName }),
      },
    })

    return c.json({ success: true, plan }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/subscription-plans/:id — Update a plan
app.patch('/subscription-plans/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(updateSubscriptionPlanSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data

    // Check plan exists
    const existing = await db.subscriptionPlan.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Plan not found' }, 404)
    }

    // Check for duplicate name if name is being changed
    if (data.name && data.name !== existing.name) {
      const nameConflict = await db.subscriptionPlan.findUnique({ where: { name: data.name } })
      if (nameConflict) {
        return c.json({ success: false, error: 'A plan with this name already exists' }, 409)
      }
    }

    const plan = await db.subscriptionPlan.update({
      where: { id },
      data,
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SUBSCRIPTION_PLAN_UPDATE',
        entityType: 'SUBSCRIPTION_PLAN',
        entityId: plan.id,
        details: JSON.stringify({ planName: plan.name, updatedFields: Object.keys(data) }),
      },
    })

    return c.json({ success: true, plan })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/subscription-plans/:id — Delete a plan (only if no agencies subscribed)
app.delete('/subscription-plans/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')

    // Check plan exists
    const existing = await db.subscriptionPlan.findUnique({
      where: { id },
      include: { _count: { select: { agencies: true } } },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Plan not found' }, 404)
    }

    // Check if any agencies are subscribed
    if (existing._count.agencies > 0) {
      return c.json({
        success: false,
        error: `Cannot delete plan: ${existing._count.agencies} agency(ies) are currently subscribed to this plan. Please migrate them first.`,
      }, 409)
    }

    await db.subscriptionPlan.delete({ where: { id } })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'SUBSCRIPTION_PLAN_DELETE',
        entityType: 'SUBSCRIPTION_PLAN',
        entityId: id,
        details: JSON.stringify({ planName: existing.name }),
      },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Hardware Products ──────────────────────────────────────────────────────

// GET /admin/hardware — List all hardware products (including inactive ones)
app.get('/hardware', async (c) => {
  try {
    await requireAdmin(c)

    const products = await db.hardwareProduct.findMany({
      orderBy: { sortOrder: 'asc' },
    })

    return c.json({ products })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/hardware — Create a new hardware product
app.post('/hardware', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(createHardwareProductSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data

    // Check for duplicate name
    const existing = await db.hardwareProduct.findUnique({ where: { name: data.name } })
    if (existing) {
      return c.json({ success: false, error: 'A hardware product with this name already exists' }, 409)
    }

    const product = await db.hardwareProduct.create({ data })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'HARDWARE_PRODUCT_CREATE',
        entityType: 'HARDWARE_PRODUCT',
        entityId: product.id,
        details: JSON.stringify({ name: product.name, category: product.category, basePrice: product.basePrice }),
      },
    })

    return c.json({ success: true, product }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Hardware Settings + Commitment Tiers ───────────────────────────────────
//
// NOTE: These literal-path routes MUST be registered before the
// `PATCH /hardware/:id` and `DELETE /hardware/:id` routes below, otherwise
// Hono's first-match-wins routing would treat `settings` as a product id.

// GET /admin/hardware/settings — Get hardware settings + commitment tiers
app.get('/hardware/settings', async (c) => {
  try {
    await requireAdmin(c)

    // Ensure the singleton settings row exists (defensive — the seed script
    // creates it, but if the DB was reset we want to lazily create it here).
    let settings = await db.hardwareSettings.findUnique({ where: { id: 'singleton' } })
    if (!settings) {
      settings = await db.hardwareSettings.create({ data: { id: 'singleton' } })
    }

    const commitmentTiers = await db.hardwareCommitmentTier.findMany({
      orderBy: { sortOrder: 'asc' },
    })

    return c.json({ settings, commitmentTiers })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/hardware/settings — Update hardware settings (toggle + discount)
app.patch('/hardware/settings', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const body = await c.req.json()
    const validation = validateBody(updateHardwareSettingsSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data
    if (Object.keys(data).length === 0) {
      return c.json({ success: false, error: 'No fields provided to update' }, 400)
    }

    // Upsert so admins can update settings even before the seed row exists
    const settings = await db.hardwareSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'HARDWARE_SETTINGS_UPDATE',
        entityType: 'HARDWARE_SETTINGS',
        entityId: 'singleton',
        details: JSON.stringify(data),
      },
    })

    return c.json({ success: true, settings })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/hardware/commitment-tiers/:id — Update a commitment tier
app.patch('/hardware/commitment-tiers/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(updateHardwareCommitmentTierSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data
    if (Object.keys(data).length === 0) {
      return c.json({ success: false, error: 'No fields provided to update' }, 400)
    }

    const existing = await db.hardwareCommitmentTier.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Commitment tier not found' }, 404)
    }

    const tier = await db.hardwareCommitmentTier.update({
      where: { id },
      data,
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'HARDWARE_TIER_UPDATE',
        entityType: 'HARDWARE_COMMITMENT_TIER',
        entityId: tier.id,
        details: JSON.stringify({ months: tier.months, updatedFields: Object.keys(data) }),
      },
    })

    return c.json({ success: true, tier })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/hardware/:id — Update a hardware product
app.patch('/hardware/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(updateHardwareProductSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data

    const existing = await db.hardwareProduct.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Hardware product not found' }, 404)
    }

    if (data.name && data.name !== existing.name) {
      const nameConflict = await db.hardwareProduct.findUnique({ where: { name: data.name } })
      if (nameConflict) {
        return c.json({ success: false, error: 'A hardware product with this name already exists' }, 409)
      }
    }

    const product = await db.hardwareProduct.update({
      where: { id },
      data,
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'HARDWARE_PRODUCT_UPDATE',
        entityType: 'HARDWARE_PRODUCT',
        entityId: product.id,
        details: JSON.stringify({ name: product.name, updatedFields: Object.keys(data) }),
      },
    })

    return c.json({ success: true, product })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/hardware/:id — Delete a hardware product
app.delete('/hardware/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')

    const existing = await db.hardwareProduct.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Hardware product not found' }, 404)
    }

    // Block deletion if any order items reference this product — preserving
    // historical order integrity. Admins should set `isActive: false` instead
    // to remove it from the catalog without breaking old orders.
    const referencedBy = await db.hardwareOrderItem.count({ where: { productId: id } })
    if (referencedBy > 0) {
      return c.json({
        success: false,
        error: `Cannot delete: ${referencedBy} order item(s) reference this product. Set isActive=false instead to hide it from the catalog.`,
      }, 409)
    }

    // Delete inside a transaction — the Prisma Client extension's `delete`
    // hook (ghost-delete trap) is invoked correctly when called via the
    // transaction client `tx`, but `db.hardwareProduct.delete()` directly
    // triggers a known issue where the `query` callback isn't passed to the
    // extension. This matches the pattern used by `DELETE /admin/agencies/:id`.
    await db.$transaction(async (tx) => {
      await tx.hardwareProduct.delete({ where: { id } })
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: 'HARDWARE_PRODUCT_DELETE',
        entityType: 'HARDWARE_PRODUCT',
        entityId: id,
        details: JSON.stringify({ name: existing.name }),
      },
    })

    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ─── Enterprise Contract Requests ───────────────────────────────────────────

// GET /admin/enterprise-requests — List all enterprise contract requests
app.get('/enterprise-requests', async (c) => {
  try {
    await requireAdmin(c)

    const statusFilter = c.req.query('status')
    const where = statusFilter ? { status: statusFilter } : {}

    const requests = await db.enterpriseContractRequest.findMany({
      where,
      include: {
        agency: {
          select: {
            id: true,
            name: true,
            nameAr: true,
            nameFr: true,
            customCode: true,
            subscriptionTier: true,
            subscriptionStatus: true,
            email: true,
            phone: true,
          },
        },
        customPlan: {
          select: {
            id: true,
            name: true,
            displayName: true,
            price: true,
            billingCycle: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return c.json({ requests })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/enterprise-requests/:id — Update request status (approve/reject/reviewing)
app.post('/enterprise-requests/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(updateEnterpriseRequestStatusSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { status, adminNotes } = validation.data

    const existing = await db.enterpriseContractRequest.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Enterprise request not found' }, 404)
    }

    const request = await db.enterpriseContractRequest.update({
      where: { id },
      data: {
        status,
        ...(adminNotes !== undefined && { adminNotes }),
      },
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: `ENTERPRISE_REQUEST_${status}`,
        entityType: 'ENTERPRISE_REQUEST',
        entityId: id,
        details: JSON.stringify({
          agencyId: existing.agencyId,
          agencyName: existing.agencyName,
          previousStatus: existing.status,
          newStatus: status,
          adminNotes: adminNotes ?? null,
        }),
      },
    })

    return c.json({ success: true, request })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/enterprise-requests/:id/create-plan — Create a custom SubscriptionPlan
//
// Workflow: admin reviews an enterprise contract request → designs a custom
// plan (limits + feature flags) → calls this endpoint with the full plan body.
// We then:
//   1. Create the SubscriptionPlan
//   2. Link it to the request via `customPlanId` + mark request APPROVED
//   3. Assign the plan to the requesting agency (subscriptionPlanId + tier +
//      ACTIVE status + start/expiry dates based on the plan's billingCycle)
app.post('/enterprise-requests/:id/create-plan', async (c) => {
  try {
    const admin = await requireAdmin(c)

    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(createEnterprisePlanFromRequestSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const data = validation.data

    const request = await db.enterpriseContractRequest.findUnique({ where: { id } })
    if (!request) {
      return c.json({ success: false, error: 'Enterprise request not found' }, 404)
    }

    if (request.status === 'APPROVED' && request.customPlanId) {
      return c.json({
        success: false,
        error: 'This request already has an approved custom plan. Update the plan directly instead.',
      }, 409)
    }

    // Reject duplicate plan names — SubscriptionPlan.name is @unique
    const nameConflict = await db.subscriptionPlan.findUnique({ where: { name: data.name } })
    if (nameConflict) {
      return c.json({ success: false, error: 'A plan with this name already exists' }, 409)
    }

    // Compute the subscription window based on the plan's billing cycle
    const now = new Date()
    let subscriptionExpiresAt: Date | null = null
    switch (data.billingCycle) {
      case 'MONTHLY':
        subscriptionExpiresAt = new Date(now)
        subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 30)
        break
      case 'YEARLY':
        subscriptionExpiresAt = new Date(now)
        subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 365)
        break
      case 'ONE_TIME':
        subscriptionExpiresAt = null
        break
      default:
        subscriptionExpiresAt = new Date(now)
        subscriptionExpiresAt.setDate(subscriptionExpiresAt.getDate() + 30)
    }

    // Single transaction: create plan, link to request, assign to agency.
    // The plan is marked as an enterprise custom plan owned by the requesting
    // agency so it does NOT leak into the public subscription catalog.
    const { plan, updatedRequest } = await db.$transaction(async (tx) => {
      const createdPlan = await tx.subscriptionPlan.create({
        data: {
          ...data,
          isEnterprise: true,
          ownerAgencyId: request.agencyId,
        },
      })

      const updated = await tx.enterpriseContractRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          customPlanId: createdPlan.id,
          adminNotes: request.adminNotes
            ? `${request.adminNotes}\n[Auto] Custom plan "${createdPlan.name}" created by admin ${admin.id} on ${now.toISOString()}`
            : `[Auto] Custom plan "${createdPlan.name}" created by admin ${admin.id} on ${now.toISOString()}`,
        },
      })

      await tx.agency.update({
        where: { id: request.agencyId },
        data: {
          subscriptionPlanId: createdPlan.id,
          subscriptionTier: createdPlan.name,
          subscriptionStatus: 'ACTIVE',
          subscriptionStartsAt: now,
          subscriptionExpiresAt,
        },
      })

      await tx.auditLog.create({
        data: {
          userId: admin.id,
          action: 'ENTERPRISE_PLAN_CREATE',
          entityType: 'SUBSCRIPTION_PLAN',
          entityId: createdPlan.id,
          details: JSON.stringify({
            planName: createdPlan.name,
            requestId: id,
            agencyId: request.agencyId,
            agencyName: request.agencyName,
            price: createdPlan.price,
            billingCycle: createdPlan.billingCycle,
            subscriptionExpiresAt: subscriptionExpiresAt?.toISOString() ?? null,
          }),
        },
      })

      return { plan: createdPlan, updatedRequest: updated }
    })

    return c.json({ success: true, plan, request: updatedRequest })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// HARDWARE MANAGEMENT ENDPOINTS (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/hardware — list all products (including inactive)
app.get('/hardware', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const products = await db.hardwareProduct.findMany({ orderBy: { sortOrder: 'asc' } })
    return c.json({ products })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/hardware — create product
app.post('/hardware', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const body = await c.req.json()
    const { name, nameAr, nameFr, description, category, basePrice, sortOrder } = body
    if (!name?.trim() || !category?.trim()) {
      return c.json({ error: 'Name and category are required' }, 400)
    }
    const product = await db.hardwareProduct.create({
      data: { name, nameAr, nameFr, description, category, basePrice: basePrice || 0, sortOrder: sortOrder || 0 },
    })
    await db.auditLog.create({ data: { userId: admin.id, action: 'HARDWARE_CREATE', entityType: 'HARDWARE_PRODUCT', entityId: product.id, details: JSON.stringify({ name }) } })
    return c.json({ success: true, product })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/hardware/:id — update product
app.patch('/hardware/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const product = await db.hardwareProduct.update({ where: { id }, data: body })
    return c.json({ success: true, product })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// DELETE /admin/hardware/:id — delete product
app.delete('/hardware/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    await db.hardwareProduct.delete({ where: { id } })
    await db.auditLog.create({ data: { userId: admin.id, action: 'HARDWARE_DELETE', entityType: 'HARDWARE_PRODUCT', entityId: id, details: '{}' } })
    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// GET /admin/hardware/settings — get settings + tiers
app.get('/hardware/settings', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const settings = await db.hardwareSettings.findUnique({ where: { id: 'singleton' } })
    const commitmentTiers = await db.hardwareCommitmentTier.findMany({ orderBy: { sortOrder: 'asc' } })
    return c.json({ settings, commitmentTiers })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/hardware/settings — update settings
app.patch('/hardware/settings', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const body = await c.req.json()
    const { hardwareEnabled, upfrontDiscount } = body
    const settings = await db.hardwareSettings.upsert({
      where: { id: 'singleton' },
      update: { ...(hardwareEnabled !== undefined ? { hardwareEnabled } : {}), ...(upfrontDiscount !== undefined ? { upfrontDiscount } : {}) },
      create: { id: 'singleton', hardwareEnabled: hardwareEnabled ?? true, upfrontDiscount: upfrontDiscount ?? 0 },
    })
    await db.auditLog.create({ data: { userId: admin.id, action: 'HARDWARE_SETTINGS_UPDATE', entityType: 'SETTINGS', entityId: 'singleton', details: JSON.stringify({ hardwareEnabled, upfrontDiscount }) } })
    return c.json({ success: true, settings })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// PATCH /admin/hardware/commitment-tiers/:id — update tier
app.patch('/hardware/commitment-tiers/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const { extraPercentage, isActive } = body
    const tier = await db.hardwareCommitmentTier.update({
      where: { id },
      data: { ...(extraPercentage !== undefined ? { extraPercentage } : {}), ...(isActive !== undefined ? { isActive } : {}) },
    })
    return c.json({ success: true, tier })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CONTRACT REQUEST ENDPOINTS (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /admin/enterprise-requests — list all requests
app.get('/enterprise-requests', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const status = c.req.query('status')
    const where = status ? { status } : {}
    const requests = await db.enterpriseContractRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ requests })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/enterprise-requests/:id — update request status
app.post('/enterprise-requests/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const { status, adminNotes } = body
    if (!['PENDING', 'REVIEWING', 'APPROVED', 'REJECTED'].includes(status)) {
      return c.json({ error: 'Invalid status' }, 400)
    }
    const request = await db.enterpriseContractRequest.update({
      where: { id },
      data: { status, adminNotes: adminNotes || undefined },
    })
    await db.auditLog.create({ data: { userId: admin.id, action: 'ENTERPRISE_REQUEST_UPDATE', entityType: 'ENTERPRISE_REQUEST', entityId: id, details: JSON.stringify({ status }) } })
    return c.json({ success: true, request })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/enterprise-requests/:id/create-plan — create custom plan from request
app.post('/enterprise-requests/:id/create-plan', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const { name, displayName, displayNameAr, displayNameFr, description, price, currency, billingCycle, maxServices, maxBranches, maxStaff, maxActiveReservations, maxSmsPerMonth, kioskModeEnabled, analyticsEnabled, priorityListing, customBranding, apiAccess } = body

    const request = await db.enterpriseContractRequest.findUnique({ where: { id } })
    if (!request) return c.json({ error: 'Request not found' }, 404)

    // Create the custom plan — marked as enterprise & owned by the requesting
    // agency so it is isolated from the public subscription catalog.
    const plan = await db.subscriptionPlan.create({
      data: {
        name, displayName: displayName || name, displayNameAr, displayNameFr, description,
        price: price || 0, currency: currency || 'DZD', billingCycle: billingCycle || 'MONTHLY',
        maxServices: maxServices || 99, maxBranches: maxBranches || 99, maxStaff: maxStaff || 99,
        maxActiveReservations: maxActiveReservations || 999, maxSmsPerMonth: maxSmsPerMonth || 999,
        kioskModeEnabled: kioskModeEnabled ?? true, analyticsEnabled: analyticsEnabled ?? true,
        priorityListing: priorityListing ?? true, customBranding: customBranding ?? true, apiAccess: apiAccess ?? true,
        isActive: true, sortOrder: 999,
        isEnterprise: true,
        ownerAgencyId: request.agencyId,
      },
    })

    // Link plan to request and set agency subscription
    await db.enterpriseContractRequest.update({ where: { id }, data: { status: 'APPROVED', customPlanId: plan.id } })
    const now = new Date()
    const expiry = new Date(now); expiry.setDate(expiry.getDate() + 365)
    await db.agency.update({
      where: { id: request.agencyId },
      data: { subscriptionPlanId: plan.id, subscriptionTier: name, subscriptionStatus: 'ACTIVE', subscriptionStartsAt: now, subscriptionExpiresAt: expiry },
    })

    await db.auditLog.create({ data: { userId: admin.id, action: 'ENTERPRISE_PLAN_CREATE', entityType: 'SUBSCRIPTION_PLAN', entityId: plan.id, details: JSON.stringify({ requestId: id, agencyId: request.agencyId }) } })
    return c.json({ success: true, plan, request: await db.enterpriseContractRequest.findUnique({ where: { id } }) })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// HARDWARE ORDER (REQUEST) MANAGEMENT ENDPOINTS (ADMIN)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Agencies submit hardware orders via POST /agency/hardware/orders. These
// endpoints let admins review, approve, reject, and fulfill those requests.

// GET /admin/hardware/orders — list all hardware orders (with optional status filter)
app.get('/hardware/orders', async (c) => {
  try {
    await requireAdmin(c)
    const status = c.req.query('status')
    const where = status ? { status } : {}
    const orders = await db.hardwareOrder.findMany({
      where,
      include: {
        agency: { select: { id: true, name: true, nameAr: true, customCode: true, city: true } },
        items: { include: { product: { select: { id: true, name: true, nameAr: true, category: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })
    return c.json({ orders })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// GET /admin/hardware/orders/stats — dashboard stats for hardware requests
// NOTE: Must be defined BEFORE /hardware/orders/:id, otherwise "stats" matches :id.
app.get('/hardware/orders/stats', async (c) => {
  try {
    await requireAdmin(c)
    const [pending, approved, rejected, fulfilled, total] = await Promise.all([
      db.hardwareOrder.count({ where: { status: 'PENDING' } }),
      db.hardwareOrder.count({ where: { status: 'APPROVED' } }),
      db.hardwareOrder.count({ where: { status: 'REJECTED' } }),
      db.hardwareOrder.count({ where: { status: 'FULFILLED' } }),
      db.hardwareOrder.count(),
    ])
    return c.json({ pending, approved, rejected, fulfilled, total })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// GET /admin/hardware/orders/:id — get a single hardware order with full details
app.get('/hardware/orders/:id', async (c) => {
  try {
    await requireAdmin(c)
    const id = c.req.param('id')
    const order = await db.hardwareOrder.findUnique({
      where: { id },
      include: {
        agency: { select: { id: true, name: true, nameAr: true, customCode: true, city: true, phone: true, email: true, ownerId: true } },
        items: { include: { product: { select: { id: true, name: true, nameAr: true, nameFr: true, category: true, basePrice: true } } } },
      },
    })
    if (!order) return c.json({ success: false, error: 'Order not found' }, 404)
    return c.json({ order })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

// POST /admin/hardware/orders/:id — update order status (approve / reject / fulfill)
//
// Body: { status: 'APPROVED' | 'REJECTED' | 'FULFILLED', adminNotes?: string }
app.post('/hardware/orders/:id', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const { status, adminNotes } = body

    if (!['PENDING', 'APPROVED', 'REJECTED', 'FULFILLED'].includes(status)) {
      return c.json({ success: false, error: 'Invalid status. Use PENDING, APPROVED, REJECTED, or FULFILLED.' }, 400)
    }

    const existing = await db.hardwareOrder.findUnique({ where: { id } })
    if (!existing) return c.json({ success: false, error: 'Order not found' }, 404)

    const order = await db.hardwareOrder.update({
      where: { id },
      data: { status },
      include: {
        agency: { select: { id: true, name: true, customCode: true } },
        items: { include: { product: { select: { name: true, category: true } } } },
      },
    })

    await db.auditLog.create({
      data: {
        userId: admin.id,
        action: `HARDWARE_ORDER_${status}`,
        entityType: 'HARDWARE_ORDER',
        entityId: id,
        details: JSON.stringify({
          agencyId: existing.agencyId,
          previousStatus: existing.status,
          newStatus: status,
          adminNotes: adminNotes ?? null,
        }),
      },
    })

    return c.json({ success: true, order })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status)
  }
})

export const adminRoutes = app
