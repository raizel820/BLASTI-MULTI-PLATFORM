import { Hono } from 'hono'
import { db, dbRaw } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { validateBody, updateProfileSchema, updatePreferencesSchema, changePasswordSchema } from '../lib/validations'
import { hashPassword, verifyPassword } from '../lib/password'
import { checkRateLimit, RateLimitError, PASSWORD_RESET_RATE_LIMIT } from '../lib/rate-limit'

const app = new Hono()

// GET /user/profile — Fetch user profile
app.get('/profile', async (c) => {
  try {
    const user = await requireAuth(c)

    const profile = await db.user.findUnique({
      where: { id: user.id },
      select: {
        id: true, username: true, fullName: true, email: true, phoneNumber: true,
        role: true, language: true, avatarUrl: true, freeSmsCount: true,
        notificationPreferences: true, reminderMinutes: true, smsNotificationsEnabled: true,
        notificationPref: true, isActive: true, createdAt: true,
      },
    })

    if (!profile) return c.json({ error: 'User not found' }, 404)

    return c.json({ success: true, ...profile })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /user/profile — Update user profile
app.patch('/profile', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = validateBody(updateProfileSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { phoneNumber, language, avatarUrl, fullName, notificationPreferences, reminderMinutes, smsNotificationsEnabled, notificationPref } = validation.data

    const updateData: Record<string, unknown> = {}
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber
    if (notificationPreferences !== undefined) {
      updateData.notificationPreferences = typeof notificationPreferences === 'string' ? notificationPreferences : JSON.stringify(notificationPreferences)
    }
    if (reminderMinutes !== undefined) updateData.reminderMinutes = Number(reminderMinutes)
    if (smsNotificationsEnabled !== undefined) updateData.smsNotificationsEnabled = Boolean(smsNotificationsEnabled)
    if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl
    if (fullName !== undefined) updateData.fullName = fullName
    if (notificationPref !== undefined) updateData.notificationPref = notificationPref
    if (language !== undefined) updateData.language = language

    if (Object.keys(updateData).length === 0) return c.json({ error: 'No fields to update' }, 400)

    const updated = await db.user.update({
      where: { id: user.id },
      data: updateData,
      select: {
        id: true, username: true, fullName: true, email: true, phoneNumber: true,
        role: true, language: true, avatarUrl: true, freeSmsCount: true,
        notificationPreferences: true, reminderMinutes: true, smsNotificationsEnabled: true, isActive: true,
      },
    })

    return c.json({ success: true, ...updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /user/preferences — Get user preferences
app.get('/preferences', async (c) => {
  try {
    const user = await requireAuth(c)

    const dbUser = await db.user.findUnique({
      where: { id: user.id },
      select: { id: true, notificationPreferences: true, language: true, smsNotificationsEnabled: true },
    })

    if (!dbUser) return c.json({ error: 'User not found' }, 404)

    let parsedPreferences = {}
    try {
      parsedPreferences = dbUser.notificationPreferences ? JSON.parse(dbUser.notificationPreferences) : {}
    } catch { parsedPreferences = {} }

    return c.json({ notificationPreferences: parsedPreferences, language: dbUser.language, smsNotificationsEnabled: dbUser.smsNotificationsEnabled })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /user/preferences — Update user preferences
app.patch('/preferences', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const { preferences } = body

    if (!preferences || typeof preferences !== 'object') return c.json({ error: 'preferences object is required' }, 400)

    const validation = validateBody(updatePreferencesSchema, preferences)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const prefsStr = JSON.stringify(preferences)

    const updated = await db.user.update({
      where: { id: user.id },
      data: { notificationPreferences: prefsStr },
      select: { id: true, notificationPreferences: true },
    })

    return c.json({ notificationPreferences: JSON.parse(updated.notificationPreferences) })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /user/change-password — Change password
app.patch('/change-password', async (c) => {
  try {
    const user = await requireAuth(c)

    checkRateLimit(user.id, PASSWORD_RESET_RATE_LIMIT)

    const body = await c.req.json()
    const validation = validateBody(changePasswordSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { currentPassword, newPassword } = validation.data

    const dbUser = await db.user.findUnique({ where: { id: user.id }, select: { id: true, passwordHash: true } })
    if (!dbUser) return c.json({ error: 'User not found' }, 404)

    const isCorrect = verifyPassword(currentPassword, dbUser.passwordHash)
    if (!isCorrect) return c.json({ error: 'Current password is incorrect' }, 401)

    const newHash = hashPassword(newPassword)
    await db.user.update({ where: { id: user.id }, data: { passwordHash: newHash } })

    return c.json({ success: true })
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      return c.json({ success: false, error: error.message, retryAfter: error.retryAfter }, 429)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /user/delete-account — Delete user account
app.delete('/delete-account', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    if (user.role === 'SUPER_ADMIN') return c.json({ success: false, error: 'Admin accounts cannot be deleted' }, 403)

    const dbUser = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } })
    if (!dbUser) return c.json({ success: false, error: 'User not found' }, 404)

    // Uses dbRaw to bypass the ghost-delete extension (deleteMany crashes
    // inside $transaction in Prisma 6.x).
    await dbRaw.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { userId } })
      await tx.notification.deleteMany({ where: { userId } })
      await tx.smsPurchase.deleteMany({ where: { userId } })
      await tx.favorite.deleteMany({ where: { userId } })
      await tx.review.deleteMany({ where: { userId } })
      await tx.delayedJob.deleteMany({ where: { userId } })
      await tx.deviceRegistration.deleteMany({ where: { userId } })
      await tx.transaction.updateMany({ where: { reviewedBy: userId }, data: { reviewedBy: null } })
      await tx.reservation.deleteMany({ where: { userId } })

      if (dbUser.role === 'AGENCY_OWNER') {
        const ownedAgency = await tx.agency.findFirst({ where: { ownerId: userId }, select: { id: true } })
        if (ownedAgency) {
          const agencyId = ownedAgency.id
          // Complete cascade for the owned agency
          await tx.review.deleteMany({ where: { agencyId } })
          await tx.favorite.deleteMany({ where: { agencyId } })
          await tx.hardwareOrderItem.deleteMany({ where: { order: { agencyId } } })
          await tx.hardwareOrder.deleteMany({ where: { agencyId } })
          await tx.enterpriseContractRequest.deleteMany({ where: { agencyId } })
          await tx.agencyDevice.deleteMany({ where: { agencyId } })
          await tx.agencyStaff.deleteMany({ where: { agencyId } })
          await tx.reservation.deleteMany({ where: { agencyId } })
          await tx.service.deleteMany({ where: { agencyId } })
          await tx.queueSettings.deleteMany({ where: { agencyId } })
          await tx.announcement.deleteMany({ where: { agencyId } })
          await tx.transaction.deleteMany({ where: { agencyId } })
          await tx.branch.deleteMany({ where: { agencyId } })
          await tx.agency.delete({ where: { id: agencyId } })
        }
      }

      if (dbUser.role === 'AGENCY_STAFF') {
        await tx.agencyStaff.deleteMany({ where: { userId } })
      }

      await tx.user.delete({ where: { id: userId } })
    })

    return c.json({ success: true, message: 'Account deleted successfully' })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /user/stats — Get user stats
app.get('/stats', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)

    const totalQueues = await db.reservation.count({ where: { userId } })
    const thisMonthCount = await db.reservation.count({ where: { userId, joinedAt: { gte: monthStart } } })

    const completedReservations = await db.reservation.findMany({
      where: { userId, status: 'COMPLETED' },
      include: { agency: { select: { id: true, name: true, nameAr: true, nameFr: true } } },
      orderBy: { completedAt: 'desc' },
    })

    let totalWaitMinutes = 0
    let waitCount = 0
    completedReservations.forEach((r) => {
      const start = r.joinedAt
      const end = r.completedAt || r.calledAt
      if (start && end) {
        const diffMs = end.getTime() - start.getTime()
        totalWaitMinutes += Math.round(diffMs / 60000)
        waitCount++
      }
    })
    const avgWaitTime = waitCount > 0 ? Math.round(totalWaitMinutes / waitCount) : 0

    const agencyVisits = new Map<string, { count: number; name: string; nameAr?: string; nameFr?: string }>()
    completedReservations.forEach((r) => {
      const existing = agencyVisits.get(r.agency.id)
      if (existing) existing.count++
      else agencyVisits.set(r.agency.id, { count: 1, name: r.agency.name, nameAr: r.agency.nameAr || undefined, nameFr: r.agency.nameFr || undefined })
    })

    let favoriteAgency: { name: string; nameAr?: string; nameFr?: string } | null = null
    let maxVisits = 0
    for (const [, data] of agencyVisits) {
      if (data.count > maxVisits) { maxVisits = data.count; favoriteAgency = data }
    }

    return c.json({ totalQueues, thisMonth: thisMonthCount, avgWaitTime, favoriteAgency })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /user/customer/service-stats — Customer service duration stats
app.get('/customer/service-stats', async (c) => {
  try {
    const user = await requireAuth(c)
    const agencyId = c.req.query('agencyId')
    if (!agencyId) return c.json({ success: false, error: 'agencyId is required' }, 400)

    const now = new Date()

    // Find currently CALLED reservation for this customer at this agency
    const currentServing = await db.reservation.findFirst({
      where: { userId: user.id, agencyId, status: 'CALLED' },
      include: { service: { select: { name: true, nameAr: true, nameFr: true } } },
    })

    let currentServingResult: Record<string, unknown> | null = null
    if (currentServing && currentServing.calledAt) {
      const calledAt = new Date(currentServing.calledAt)
      const liveDurationMinutes = (now.getTime() - calledAt.getTime()) / 60000
      const startedSecondsAgo = Math.floor((now.getTime() - calledAt.getTime()) / 1000)
      currentServingResult = {
        reservationId: currentServing.id,
        queueNumber: currentServing.displayNumber,
        serviceName: currentServing.service.name,
        calledAt: currentServing.calledAt.toISOString(),
        liveDurationMinutes: Math.round(liveDurationMinutes * 100) / 100,
        startedSecondsAgo,
      }
    }

    // Find last 10 completed reservations for this customer at this agency
    const completedReservations = await db.reservation.findMany({
      where: {
        userId: user.id,
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { not: null },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        calledAt: true,
        completedAt: true,
      },
    })

    const durations = completedReservations.map((r) => {
      const diffMs = new Date(r.completedAt!).getTime() - new Date(r.calledAt!).getTime()
      return Math.round((diffMs / 60000) * 100) / 100
    })

    const recentDurations: Record<string, unknown> = {
      last1: durations.length >= 1 ? durations[0] : null,
      last2: durations.length >= 2 ? durations.slice(0, 2) : null,
      last3: durations.length >= 3 ? durations.slice(0, 3) : null,
      last5: durations.length >= 5 ? durations.slice(0, 5) : null,
      last10: durations.length >= 1 ? durations : null,
    }

    // Average of ALL completed reservations for this customer at this agency
    const totalCompleted = await db.reservation.count({
      where: {
        userId: user.id,
        agencyId,
        status: 'COMPLETED',
        calledAt: { not: null },
        completedAt: { not: null },
      },
    })

    let averageAll: number | null = null
    if (totalCompleted > 0 && durations.length > 0) {
      // If we have all completed records (10 or fewer), use the exact average
      // Otherwise, query all to compute the true average
      if (totalCompleted <= 10) {
        averageAll = Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 100) / 100
      } else {
        const allCompleted = await db.reservation.findMany({
          where: {
            userId: user.id,
            agencyId,
            status: 'COMPLETED',
            calledAt: { not: null },
            completedAt: { not: null },
          },
          select: { calledAt: true, completedAt: true },
        })
        const allDurations = allCompleted.map((r) => {
          const diffMs = new Date(r.completedAt!).getTime() - new Date(r.calledAt!).getTime()
          return diffMs / 60000
        })
        averageAll = Math.round((allDurations.reduce((a, b) => a + b, 0) / allDurations.length) * 100) / 100
      }
    }

    return c.json({
      currentServing: currentServingResult,
      recentDurations,
      totalCompleted,
      averageAll,
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const userRoutes = app
