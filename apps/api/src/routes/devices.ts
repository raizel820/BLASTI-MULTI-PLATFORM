import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { validateBody, deviceRegistrationSchema } from '../lib/validations'
import { emitDeviceEvent } from '../lib/realtime-emit'

const app = new Hono()

// POST /devices — Register (or update) a device
app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const body = await c.req.json()
    const validation = validateBody(deviceRegistrationSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }

    const { platform, deviceToken, deviceId, appVersion, deviceFingerprint } = validation.data

    const device = await db.deviceRegistration.upsert({
      where: { userId_deviceId: { userId, deviceId } },
      update: {
        platform,
        deviceToken: deviceToken ?? undefined,
        appVersion: appVersion ?? undefined,
        deviceFingerprint: deviceFingerprint ?? undefined,
        lastActiveAt: new Date(),
      },
      create: {
        userId,
        platform,
        deviceToken: deviceToken ?? null,
        deviceId,
        appVersion: appVersion ?? null,
        deviceFingerprint: deviceFingerprint ?? null,
        lastActiveAt: new Date(),
      },
    })

    emitDeviceEvent('device:registered', userId, { deviceId: device.deviceId, platform: device.platform })

    return c.json({ success: true, device })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// GET /devices — List devices for the authenticated user
app.get('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const queryUserId = c.req.query('userId')
    if (queryUserId && queryUserId !== userId) {
      return c.json({ success: false, error: 'Cannot access devices for another user' }, 403)
    }

    const devices = await db.deviceRegistration.findMany({
      where: { userId },
      orderBy: { lastActiveAt: 'desc' },
    })

    return c.json({ success: true, devices })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /devices — Unregister a device
app.delete('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const userId = user.id

    const body = await c.req.json()
    const { deviceId } = body as { deviceId?: string }

    if (!deviceId) return c.json({ success: false, error: 'deviceId is required' }, 400)

    const device = await db.deviceRegistration.findUnique({
      where: { userId_deviceId: { userId, deviceId } },
    })

    if (!device) return c.json({ success: false, error: 'Device not found or does not belong to you' }, 404)

    await db.deviceRegistration.delete({ where: { id: device.id } })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const deviceRoutes = app
