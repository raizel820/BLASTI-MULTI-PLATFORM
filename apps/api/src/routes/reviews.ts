import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireResourceOwnership, requireAgencyAccess, requireAdmin, authErrorResponse } from '../lib/auth'
import { validateBody, createReviewSchema, replyToReviewSchema } from '../lib/validations'
import { emitNotificationEvent } from '../lib/realtime-emit'
import { z } from 'zod'

const app = new Hono()

const createReviewBodySchema = createReviewSchema.extend({
  agencyId: z.string().min(1, 'Agency ID is required'),
  reservationId: z.string().optional(),
})

// POST /reviews — Create a new review
app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = validateBody(createReviewBodySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, rating, comment, reservationId } = validation.data
    const userId = user.id

    if (user.role !== 'CUSTOMER') return c.json({ error: 'Only customers can submit reviews' }, 403)

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ error: 'Agency not found' }, 404)

    if (reservationId) {
      const reservation = await db.reservation.findUnique({ where: { id: reservationId } })
      if (!reservation) return c.json({ error: 'Reservation not found' }, 404)
      if (reservation.userId !== userId) return c.json({ error: 'You can only review your own reservations' }, 403)
      if (reservation.agencyId !== agencyId) return c.json({ error: 'Reservation does not belong to this agency' }, 400)

      const existingReview = await db.review.findUnique({ where: { reservationId } })
      if (existingReview) return c.json({ error: 'This reservation has already been reviewed' }, 400)
    }

    const review = await db.review.create({
      data: { rating, comment: comment?.trim() || null, userId, agencyId, reservationId: reservationId || null },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
    })

    if (reservationId) {
      await db.reservation.update({ where: { id: reservationId }, data: { rating } })
      try {
        await db.$executeRaw`UPDATE Reservation SET ratedAt = datetime('now') WHERE id = ${reservationId}`
        if (comment?.trim()) {
          await db.$executeRaw`UPDATE Reservation SET feedback = ${comment.trim()} WHERE id = ${reservationId}`
        }
      } catch {
        console.warn('[REVIEWS POST] Could not set feedback/ratedAt, columns may not exist')
      }
    }

    return c.json({ success: true, review }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /reviews — Get reviews for an agency (public endpoint)
app.get('/', async (c) => {
  try {
    const agencyId = c.req.query('agencyId')
    if (!agencyId) return c.json({ error: 'agencyId query parameter is required' }, 400)

    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)))
    const skip = (page - 1) * limit

    const agency = await db.agency.findUnique({ where: { id: agencyId } })
    if (!agency) return c.json({ error: 'Agency not found' }, 404)

    const [reviews, total] = await Promise.all([
      db.review.findMany({
        where: { agencyId },
        include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.review.count({ where: { agencyId } }),
    ])

    const ratingStats = await db.review.aggregate({ where: { agencyId }, _avg: { rating: true }, _count: { rating: true } })
    const averageRating = ratingStats._avg.rating ? Math.round(ratingStats._avg.rating * 10) / 10 : 0

    return c.json({ success: true, reviews, averageRating, totalCount: total, page, limit, totalPages: Math.ceil(total / limit) })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Get reviews error:', message)
    return c.json({ error: 'Failed to fetch reviews' }, 500)
  }
})

// PATCH /reviews/:id — Update a review
app.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(createReviewSchema.partial(), body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { rating, comment } = validation.data

    const review = await db.review.findUnique({ where: { id } })
    if (!review) return c.json({ error: 'Review not found' }, 404)

    await requireResourceOwnership(c, review.userId)

    const updateData: Record<string, unknown> = {}
    if (rating !== undefined) updateData.rating = rating
    if (comment !== undefined) updateData.comment = comment?.trim() || null

    const updated = await db.review.update({
      where: { id },
      data: updateData,
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
    })

    if (review.reservationId) {
      if (rating !== undefined) {
        await db.reservation.update({ where: { id: review.reservationId }, data: { rating } })
      }
      if (comment !== undefined) {
        try {
          await db.$executeRaw`UPDATE Reservation SET feedback = ${comment?.trim() || null} WHERE id = ${review.reservationId}`
        } catch {
          console.warn('[REVIEWS PATCH] Could not set feedback, column may not exist')
        }
      }
    }

    return c.json({ success: true, review: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /reviews/:id — Delete a review
app.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    const review = await db.review.findUnique({ where: { id } })
    if (!review) return c.json({ error: 'Review not found' }, 404)

    try { await requireResourceOwnership(c, review.userId) } catch { await requireAdmin(c) }

    await db.review.delete({ where: { id } })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /reviews/:id/reply — Reply to a review
app.post('/:id/reply', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json()
    const replyBodySchema = replyToReviewSchema.extend({ agencyId: z.string().min(1, 'Agency ID is required') })
    const validation = validateBody(replyBodySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId, reply } = validation.data

    await requireAgencyAccess(c, agencyId)

    const review = await db.review.findUnique({ where: { id } })
    if (!review) return c.json({ error: 'Review not found' }, 404)

    if (review.agencyId !== agencyId) return c.json({ error: 'Only the reviewed agency can reply' }, 403)

    const updated = await db.review.update({
      where: { id },
      data: { replyText: reply.trim(), repliedAt: new Date() },
      include: { user: { select: { id: true, fullName: true, avatarUrl: true } } },
    })

    if (updated.user?.id) {
      emitNotificationEvent('notification:new', updated.user.id, { type: 'REVIEW_REPLY', title: 'Review Reply', message: 'The agency has replied to your review.', reviewId: id })
    }

    return c.json({ success: true, review: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const reviewRoutes = app
