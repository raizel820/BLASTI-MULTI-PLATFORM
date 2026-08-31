import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { z } from 'zod'

const app = new Hono()

const favoriteBodySchema = z.object({
  agencyId: z.string().min(1, 'Agency ID is required'),
})

// POST /favorites — Toggle favorite
app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const validation = validateBody(favoriteBodySchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { agencyId } = validation.data
    const userId = user.id

    const existing = await db.favorite.findUnique({
      where: { userId_agencyId: { userId, agencyId } },
    })

    if (existing) {
      await db.favorite.delete({ where: { id: existing.id } })
      return c.json({ favorited: false })
    } else {
      await db.favorite.create({ data: { userId, agencyId } })
      return c.json({ favorited: true }, 201)
    }
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /favorites — List user's favorites
app.get('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const favorites = await db.favorite.findMany({
      where: { userId },
      include: {
        agency: {
          select: {
            id: true, name: true, nameAr: true, nameFr: true, category: true, address: true,
            customCode: true, isQueueOpen: true, isSponsored: true, workingHoursStart: true,
            workingHoursEnd: true,
            services: { where: { isActive: true }, select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return c.json({
      favorites: favorites.map((f) => ({
        favoriteId: f.id,
        agencyId: f.agencyId,
        favoritedAt: f.createdAt,
        ...f.agency,
      })),
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const favoriteRoutes = app
