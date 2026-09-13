import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, requireResourceOwnership, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import { emitNotificationEvent } from '../lib/realtime-emit'
import { z } from 'zod'

const app = new Hono()

// GET /notifications — List user's notifications
app.get('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id
    const unreadOnly = c.req.query('unreadOnly') === 'true'
    const type = c.req.query('type')

    const where: Record<string, unknown> = { userId }
    if (unreadOnly) where.isRead = false
    if (type) {
      const types = type.split(',').map(t => t.trim()).filter(Boolean)
      if (types.length === 1) where.type = types[0]
      else if (types.length > 1) where.type = { in: types }
    }

    const notifications = await db.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 })
    const unreadCount = await db.notification.count({ where: { userId, isRead: false } })

    return c.json({ success: true, notifications, unreadCount })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// POST /notifications — Create notification
app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const createNotificationSchema = z.object({ type: z.string().max(50).default('SYSTEM'), title: z.string().min(1, 'Title is required').max(200), message: z.string().max(1000).default(''), entityId: z.string().optional() })
    const validation = validateBody(createNotificationSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { type, title, message, entityId } = validation.data

    const notification = await db.notification.create({
      data: { userId: user.id, type, title, message, isRead: false, entityId: entityId || null },
    })

    emitNotificationEvent('notification:new', user.id, { notificationId: notification.id, type: notification.type, title: notification.title })

    return c.json({ success: true, notification }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /notifications — Mark notifications as read (bulk)
app.patch('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()
    const markNotificationsSchema = z.object({ markAll: z.boolean().optional(), notificationIds: z.array(z.string()).min(1).optional() })
    const validation = validateBody(markNotificationsSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { notificationIds, markAll } = validation.data

    if (markAll) {
      const result = await db.notification.updateMany({ where: { userId: user.id, isRead: false }, data: { isRead: true } })
      return c.json({ success: true, markedCount: result.count })
    }

    if (notificationIds && Array.isArray(notificationIds) && notificationIds.length > 0) {
      const result = await db.notification.updateMany({ where: { id: { in: notificationIds }, userId: user.id, isRead: false }, data: { isRead: true } })
      return c.json({ success: true, markedCount: result.count })
    }

    return c.json({ success: false, error: 'Provide either { markAll: true } or { notificationIds: string[] }' }, 400)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /notifications/mark-read — Mark specific notifications as read
app.patch('/mark-read', async (c) => {
  try {
    const user = await requireAuth(c)

    await db.notification.updateMany({ where: { userId: user.id, isRead: false }, data: { isRead: true } })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PUT /notifications/read-all — Mark all notifications as read
app.put('/read-all', async (c) => {
  try {
    const user = await requireAuth(c)

    const result = await db.notification.updateMany({ where: { userId: user.id, isRead: false }, data: { isRead: true } })

    return c.json({ success: true, markedCount: result.count })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// PATCH /notifications/:id — Mark single notification as read
app.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    const notification = await db.notification.findUnique({ where: { id } })
    if (!notification) return c.json({ success: false, error: 'Notification not found' }, 404)

    await requireResourceOwnership(c, notification.userId)

    if (notification.isRead) return c.json({ success: true, notification, message: 'Already read' })

    const updated = await db.notification.update({ where: { id }, data: { isRead: true } })

    return c.json({ success: true, notification: updated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /notifications/:id — Delete a notification
app.delete('/:id', async (c) => {
  try {
    const id = c.req.param('id')

    const notification = await db.notification.findUnique({ where: { id } })
    if (!notification) return c.json({ success: false, error: 'Notification not found' }, 404)

    await requireResourceOwnership(c, notification.userId)

    await db.notification.delete({ where: { id } })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const notificationRoutes = app
