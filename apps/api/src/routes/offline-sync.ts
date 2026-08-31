/**
 * @blasti/api — Offline Sync Routes
 *
 * REST API for syncing offline reservations created while the device
 * had no internet connectivity.
 *
 * Endpoints:
 *   POST /api/offline-sync          — Sync a single offline reservation
 *   POST /api/offline-sync/batch    — Sync multiple offline reservations
 *   GET  /api/offline-sync/status   — Get sync status for a device
 *
 * All require authentication.
 */

import { Hono } from 'hono'
import { requireAuth, authErrorResponse } from '../lib/auth'
import {
  syncOfflineReservation,
  syncOfflineBatch,
  getDeviceSyncStatus,
  SyncConflict,
} from '../lib/offline-sync'
import type { OfflineReservation } from '../lib/offline-sync'

const app = new Hono()

// ─── POST /api/offline-sync — Sync single offline reservation ───────────────

app.post('/', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()

    // Validate required fields
    const { agencyId, serviceId, offlineCreatedAt, syncDeviceId } = body
    if (!agencyId || !serviceId || !offlineCreatedAt || !syncDeviceId) {
      return c.json(
        {
          success: false,
          error: 'Missing required fields: agencyId, serviceId, offlineCreatedAt, syncDeviceId',
        },
        400
      )
    }

    // Validate offlineCreatedAt is a valid date
    const parsedDate = new Date(offlineCreatedAt)
    if (isNaN(parsedDate.getTime())) {
      return c.json(
        { success: false, error: 'Invalid offlineCreatedAt date' },
        400
      )
    }

    // Validate offlineCreatedAt is not in the future
    if (parsedDate > new Date()) {
      return c.json(
        { success: false, error: 'offlineCreatedAt cannot be in the future' },
        400
      )
    }

    // Validate offlineCreatedAt is not older than 48 hours
    const maxAge = 48 * 60 * 60 * 1000 // 48 hours
    if (Date.now() - parsedDate.getTime() > maxAge) {
      return c.json(
        { success: false, error: 'Offline reservation is too old (max 48 hours)' },
        400
      )
    }

    const offlineReservation: OfflineReservation = {
      agencyId,
      serviceId,
      offlineCreatedAt,
      syncDeviceId,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
      notes: body.notes,
      fixedTimeEnabled: body.fixedTimeEnabled,
      fixedTime: body.fixedTime,
      reservedDate: body.reservedDate,
      preferredTime: body.preferredTime,
    }

    const result = await syncOfflineReservation(offlineReservation, user.id)

    if (!result.success) {
      // Map conflict types to HTTP status codes and user-friendly messages
      const conflictMap: Record<string, { status: number; message: string }> = {
        [SyncConflict.AGENCY_NOT_FOUND]: { status: 404, message: 'Agency not found' },
        [SyncConflict.SERVICE_NOT_FOUND]: { status: 404, message: 'Service not found' },
        [SyncConflict.SERVICE_INACTIVE]: { status: 400, message: 'Service is no longer active' },
        [SyncConflict.AGENCY_INACTIVE]: { status: 400, message: 'Agency is no longer active' },
        [SyncConflict.QUEUE_PAUSED]: { status: 400, message: 'Queue is currently paused' },
        [SyncConflict.DUPLICATE]: { status: 409, message: 'This reservation was already synced' },
        [SyncConflict.QUEUE_FULL]: { status: 400, message: 'Queue is full. Please try again later' },
      }

      const mapped = conflictMap[result.conflict!] || { status: 400, message: result.conflict }
      return c.json(
        { success: false, error: mapped.message, conflict: result.conflict },
        mapped.status
      )
    }

    return c.json({ success: true, reservation: result.reservation }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /api/offline-sync/batch — Sync multiple offline reservations ──────

app.post('/batch', async (c) => {
  try {
    const user = await requireAuth(c)
    const body = await c.req.json()

    const { reservations } = body
    if (!Array.isArray(reservations) || reservations.length === 0) {
      return c.json(
        { success: false, error: 'reservations must be a non-empty array' },
        400
      )
    }

    // Limit batch size to prevent abuse
    if (reservations.length > 50) {
      return c.json(
        { success: false, error: 'Batch size cannot exceed 50 reservations' },
        400
      )
    }

    // Validate each reservation has required fields
    for (let i = 0; i < reservations.length; i++) {
      const r = reservations[i]
      if (!r.agencyId || !r.serviceId || !r.offlineCreatedAt || !r.syncDeviceId) {
        return c.json(
          {
            success: false,
            error: `Reservation at index ${i} missing required fields: agencyId, serviceId, offlineCreatedAt, syncDeviceId`,
          },
          400
        )
      }
    }

    const result = await syncOfflineBatch(reservations, user.id)

    return c.json({
      success: true,
      synced: result.synced,
      conflicts: result.conflicts,
      errors: result.errors.length > 0 ? result.errors : undefined,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /api/offline-sync/status — Get sync status for a device ────────────

app.get('/status', async (c) => {
  try {
    const user = await requireAuth(c)
    const deviceId = c.req.query('deviceId')

    if (!deviceId) {
      return c.json(
        { success: false, error: 'deviceId query parameter is required' },
        400
      )
    }

    const status = await getDeviceSyncStatus(deviceId, user.id)

    return c.json({ success: true, ...status })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const offlineSyncRoutes = app
