import { Hono } from 'hono'
import { db } from '@blasti/db'
import { normalizeDzPhone, getSmsTemplate, sendSms } from '../lib/sms-service'

const app = new Hono()

const NO_SHOW_SKIP_MINUTES = 3
const SMS_FALLBACK_MINUTES = 10

// Helper: verify cron secret
function verifyCronSecret(c: import('hono').Context): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const authHeader = c.req.header('Authorization')
    if (authHeader !== `Bearer ${cronSecret}`) return false
  }
  return true
}

// GET /cron/auto-skip — Auto-skip no-show reservations
app.get('/auto-skip', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const cutoffTime = new Date(Date.now() - NO_SHOW_SKIP_MINUTES * 60 * 1000)

    const candidates = await db.reservation.findMany({
      where: {
        status: 'CALLED',
        calledAt: { not: null, lte: cutoffTime },
      },
      include: {
        user: { select: { id: true, fullName: true, language: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
      },
    })

    const unskippedCandidates = candidates.filter(r => {
      const rAny = r as Record<string, unknown>
      return rAny.skippedForNoShow !== true && !rAny.reclaimRequestedAt
    })

    let skipped = 0

    for (const reservation of unskippedCandidates) {
      if (!reservation.user) continue

      const agencyName =
        reservation.user.language === 'ar' ? reservation.agency.nameAr || reservation.agency.name
          : reservation.user.language === 'fr' ? reservation.agency.nameFr || reservation.agency.name
          : reservation.agency.name

      await db.$transaction(async (tx) => {
        try {
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { skippedForNoShow: true, skippedAt: new Date() },
          })
        } catch {
          console.warn('[cron/auto-skip] Could not set skippedForNoShow, column may not exist')
        }

        if (reservation.userId) {
          await tx.notification.create({
            data: {
              userId: reservation.userId,
              type: 'NO_SHOW_WARNING',
              title: 'You Were Skipped',
              message: `Your ticket ${reservation.displayNumber} at ${agencyName} was skipped because you did not respond within ${NO_SHOW_SKIP_MINUTES} minutes. You can still reclaim your position if you arrive soon.`,
            },
          })
        }

        await tx.auditLog.create({
          data: {
            userId: reservation.userId || undefined,
            action: 'AUTO_SKIP_NO_SHOW',
            entityType: 'RESERVATION',
            entityId: reservation.id,
            details: JSON.stringify({ displayNumber: reservation.displayNumber, agencyId: reservation.agencyId, calledAt: reservation.calledAt }),
          },
        })
      })

      skipped++
    }

    return c.json({ checked: unskippedCandidates.length, skipped })
  } catch (error) {
    console.error('[cron/auto-skip] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /cron/check-reminders — Check and send queue reminders
app.get('/check-reminders', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const today = new Date().toISOString().split('T')[0]

    const allCandidates = await db.reservation.findMany({
      where: {
        status: 'WAITING',
        reminderSent: false,
        OR: [{ reservedDate: today }, { reservedDate: null }],
        user: { reminderMinutes: { gt: 0 } },
      },
      include: {
        user: { select: { id: true, reminderMinutes: true, fullName: true, language: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true, averageServiceTime: true } },
      },
      orderBy: { queueNumber: 'asc' },
    })

    const candidates = allCandidates.filter(r => {
      const rAny = r as Record<string, unknown>
      return rAny.skippedForNoShow !== true
    })

    let remindersSent = 0

    for (const reservation of candidates) {
      if (!reservation.user) continue

      const peopleAhead = await db.reservation.count({
        where: { agencyId: reservation.agencyId, status: 'WAITING', joinedAt: { lt: reservation.joinedAt }, id: { not: reservation.id } },
      })

      const avgServiceTime = reservation.agency.averageServiceTime || 10
      const userReminderMinutes = reservation.user.reminderMinutes || 10

      const estimatedMinutesUntilTurn = peopleAhead * avgServiceTime
      if (estimatedMinutesUntilTurn <= userReminderMinutes) {
        const agencyName =
          reservation.user.language === 'ar' ? reservation.agency.nameAr || reservation.agency.name
            : reservation.user.language === 'fr' ? reservation.agency.nameFr || reservation.agency.name
            : reservation.agency.name

        await db.$transaction(async (tx) => {
          await tx.reservation.update({
            where: { id: reservation.id },
            data: { reminderSent: true, reminderSentAt: new Date() },
          })

          if (reservation.userId) {
            await tx.notification.create({
              data: {
                userId: reservation.userId,
                type: 'TURN_APPROACHING',
                title: 'Your Turn is Approaching',
                message: `Your ticket ${reservation.displayNumber} at ${agencyName} is coming up soon. ${peopleAhead === 0 ? 'You are next!' : `Approximately ${peopleAhead} ahead of you.`}`,
              },
            })
          }
        })

        remindersSent++
      }
    }

    return c.json({ checked: candidates.length, remindersSent })
  } catch (error) {
    console.error('[cron/check-reminders] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /cron/check-sms-fallback — Check and send SMS fallback reminders
app.get('/check-sms-fallback', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const cutoffTime = new Date(Date.now() - SMS_FALLBACK_MINUTES * 60 * 1000)

    const allCandidates = await db.reservation.findMany({
      where: {
        status: { in: ['WAITING', 'CALLED'] },
        user: { smsNotificationsEnabled: true, phoneNumber: { not: null }, isActive: true },
      },
      include: {
        user: {
          select: { id: true, fullName: true, phoneNumber: true, freeSmsCount: true, language: true, smsPurchases: { select: { id: true, quantity: true, price: true }, orderBy: { createdAt: 'asc' } } },
        },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true, averageServiceTime: true } },
      },
    })

    const candidates = allCandidates.filter(r => {
      const rAny = r as Record<string, unknown>
      if (rAny.reminderSent !== true) return false
      const reminderSentAt = rAny.reminderSentAt as Date | null
      if (!reminderSentAt || reminderSentAt > cutoffTime) return false
      if (rAny.smsReminderSent === true) return false
      if (rAny.skippedForNoShow === true) return false
      return true
    })

    let smsSent = 0
    let noCredit = 0

    for (const reservation of candidates) {
      const user = reservation.user
      if (!user) continue

      const totalFreeCredits = user.freeSmsCount || 0
      const totalPurchasedCredits = user.smsPurchases.reduce((sum, p) => sum + p.quantity, 0)

      if (totalFreeCredits + totalPurchasedCredits <= 0) { noCredit++; continue }

      const normalizedPhone = normalizeDzPhone(user.phoneNumber!)
      if (!normalizedPhone) {
        await db.smsLog.create({
          data: { userId: user.id, phoneNumber: user.phoneNumber!, message: 'SMS fallback - invalid phone', status: 'FAILED', provider: 'system', errorMessage: `Invalid phone number format: ${user.phoneNumber}` },
        })
        continue
      }

      const lang = user.language || 'ar'
      const agencyName = lang === 'ar' ? reservation.agency.nameAr || reservation.agency.name
        : lang === 'fr' ? reservation.agency.nameFr || reservation.agency.name
        : reservation.agency.name

      const position = reservation.queueNumber
      const estimatedMinutes = Math.max(1, Math.round(reservation.agency.averageServiceTime || 10))

      const smsMessage = await getSmsTemplate('turnApproaching', lang, {
        customerName: user.fullName,
        ticketNumber: reservation.displayNumber,
        agencyName,
        position,
        estimatedMinutes,
      })

      const result = await sendSms(normalizedPhone, smsMessage, user.id)

      if (result.success) {
        try {
          await db.reservation.update({
            where: { id: reservation.id },
            data: { smsReminderSent: true, smsReminderSentAt: new Date() },
          })
        } catch {
          console.warn('[cron/check-sms-fallback] Could not set smsReminderSent, column may not exist')
        }
        smsSent++
      } else {
        console.error(`[cron/check-sms-fallback] Failed to send SMS to ${normalizedPhone}: ${result.error}`)
      }
    }

    return c.json({ checked: candidates.length, smsSent, noCredit })
  } catch (error) {
    console.error('[cron/check-sms-fallback] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// GET /cron/handle-downgrades — Soft-lock excess services/staff when agency downgrades
app.get('/handle-downgrades', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    // Find all agencies with active subscriptions
    const agencies = await db.agency.findMany({
      where: { subscriptionStatus: 'ACTIVE' },
      include: {
        subscriptionPlan: true,
        services: { where: { isActive: true }, orderBy: { createdAt: 'desc' } },
        staff: { where: { isActive: true }, orderBy: { joinedAt: 'desc' } },
      },
    })

    let lockedServices = 0
    let lockedStaff = 0

    for (const agency of agencies) {
      const plan = agency.subscriptionPlan
      if (!plan) continue

      // Check if agency has more active services than the plan allows
      if (agency.services.length > plan.maxServices) {
        const excess = agency.services.length - plan.maxServices
        // Soft-lock the MOST RECENTLY created excess services
        const toLock = agency.services.slice(0, excess)
        for (const service of toLock) {
          await db.service.update({
            where: { id: service.id },
            data: { isActive: false },
          })
          lockedServices++
        }
      }

      // Check if agency has more active staff than the plan allows
      if (agency.staff.length > plan.maxStaff) {
        const excess = agency.staff.length - plan.maxStaff
        const toLock = agency.staff.slice(0, excess)
        for (const staff of toLock) {
          await db.agencyStaff.update({
            where: { id: staff.id },
            data: { isActive: false },
          })
          lockedStaff++
        }
      }
    }

    return c.json({ checked: agencies.length, lockedServices, lockedStaff })
  } catch (error) {
    console.error('[cron/handle-downgrades] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

// POST /cron/sweep-offline — Sweep stale DEFERRED_OFFLINE reservations older than 24 hours
app.post('/sweep-offline', async (c) => {
  if (!verifyCronSecret(c)) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago

    // Find all DEFERRED_OFFLINE reservations older than 24h
    const staleReservations = await db.reservation.findMany({
      where: {
        status: 'DEFERRED_OFFLINE',
        offlineCreatedAt: { not: null, lte: staleThreshold },
      },
      include: {
        user: { select: { id: true, fullName: true, language: true } },
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
      },
    })

    let expired = 0
    let cancelled = 0
    let notified = 0

    for (const reservation of staleReservations) {
      // Mark as CANCELLED and set sync conflict flag
      await db.$transaction(async (tx) => {
        await tx.reservation.update({
          where: { id: reservation.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            syncConflict: true,
          },
        })

        // Notify the customer if they have a user account
        if (reservation.userId) {
          const lang = (reservation.user as any)?.language || 'ar'
          const agencyName =
            lang === 'ar' ? (reservation.agency as any)?.nameAr || (reservation.agency as any)?.name
              : lang === 'fr' ? (reservation.agency as any)?.nameFr || (reservation.agency as any)?.name
              : (reservation.agency as any)?.name

          await tx.notification.create({
            data: {
              userId: reservation.userId,
              type: 'RESERVATION_CANCELLED',
              title: 'Offline Reservation Expired',
              message: `Your offline reservation at ${agencyName} could not be synced within 24 hours and has been cancelled. Please try booking again when you have internet access.`,
            },
          })
          notified++
        }

        // Create audit log
        await tx.auditLog.create({
          data: {
            userId: reservation.userId || undefined,
            action: 'RESERVATION_CANCEL',
            entityType: 'RESERVATION',
            entityId: reservation.id,
            details: JSON.stringify({
              reason: 'stale_offline_reservation',
              offlineCreatedAt: (reservation as any).offlineCreatedAt,
              displayNumber: reservation.displayNumber,
              agencyId: reservation.agencyId,
            }),
          },
        })
      })

      cancelled++
    }

    // Also handle DEFERRED_OFFLINE reservations without offlineCreatedAt (orphaned)
    const orphanedReservations = await db.reservation.findMany({
      where: {
        status: 'DEFERRED_OFFLINE',
        offlineCreatedAt: null,
        joinedAt: { lte: staleThreshold },
      },
    })

    for (const reservation of orphanedReservations) {
      await db.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          syncConflict: true,
        },
      })
      expired++
    }

    return c.json({
      success: true,
      staleChecked: staleReservations.length,
      cancelled,
      expired,
      notified,
    })
  } catch (error) {
    console.error('[cron/sweep-offline] Error:', error)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

export const cronRoutes = app
