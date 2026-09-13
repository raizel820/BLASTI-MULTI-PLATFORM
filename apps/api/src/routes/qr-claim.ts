/**
 * Module 4: O2O QR Bridge — QR Claim API Routes
 *
 * POST /api/qr-claim/claim     — Claim a reservation by scanning QR code (kiosk/agency)
 * POST /api/qr-claim/generate  — Generate a QR token for a reservation (customer)
 * GET  /api/qr-claim/verify/:token — Verify a QR token without claiming (preview)
 */

import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { generateImportToken, verifyQRToken } from '../lib/qr-token-service'
import { emitQueueEvent, emitReservationEvent, emitKioskEvent } from '../lib/realtime-emit'
import { enforceRateLimit, KIOSK_RATE_LIMIT, GENERAL_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// POST /qr-claim/generate — Generate a QR token for a reservation
app.post('/generate', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    const user = await requireAuth(c)
    if (!user) return authErrorResponse(c, 'Authentication required')

    const body = await c.req.json()
    const { reservationId } = body as { reservationId?: string }

    if (!reservationId) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'reservationId is required' }, 400)
    }

    // Find the reservation and verify ownership
    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      include: {
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
        service: { select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
      },
    })

    if (!reservation) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    // Verify the authenticated user owns this reservation
    if (reservation.userId !== user.id) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'You do not own this reservation' }, 403)
    }

    // Only allow QR generation for eligible statuses
    const eligibleStatuses = ['WAITING', 'DEFERRED_OFFLINE']
    if (!eligibleStatuses.includes(reservation.status)) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({
        success: false,
        error: `Cannot generate QR for reservation with status: ${reservation.status}`,
      }, 400)
    }

    // Generate the import token
    const customerId = reservation.userId || reservation.walkInCustomerName || ''
    const token = generateImportToken(reservation.id, reservation.agencyId, customerId)

    // Save the token to the reservation
    await db.reservation.update({
      where: { id: reservationId },
      data: { importToken: token },
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      token,
      reservation: {
        id: reservation.id,
        displayNumber: reservation.displayNumber,
        status: reservation.status,
        queueNumber: reservation.queueNumber,
        agency: reservation.agency,
        service: reservation.service,
        joinedAt: reservation.joinedAt,
      },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as 429)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[QR-Generate Error]', message)
    return c.json({ success: false, error: message }, 500)
  }
})

// POST /qr-claim/claim — Claim a reservation by scanning a QR code (kiosk/agency endpoint)
app.post('/claim', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, KIOSK_RATE_LIMIT)

    const body = await c.req.json()
    const { token, deviceId } = body as { token?: string; deviceId?: string }

    if (!token) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'token is required' }, 400)
    }

    if (!deviceId) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'deviceId is required' }, 400)
    }

    // Verify the QR token
    const payload = verifyQRToken(token)
    if (!payload) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Invalid or expired QR token' }, 400)
    }

    // Find the reservation
    const reservation = await db.reservation.findUnique({
      where: { id: payload.reservationId },
      include: {
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true } },
        service: { select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
        user: { select: { id: true, fullName: true } },
      },
    })

    if (!reservation) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    // Verify the token matches the stored importToken
    if (reservation.importToken !== token) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Token does not match reservation' }, 400)
    }

    // Check if already claimed
    if (reservation.qrClaimedAt) {
      if (clientIp) recordSuccessfulRequest(clientIp)
      return c.json({
        success: false,
        error: 'already_claimed',
        message: 'This QR code has already been claimed',
        claimedAt: reservation.qrClaimedAt,
        claimedByDevice: reservation.qrClaimDeviceId,
      }, 409)
    }

    // Check status is eligible for claiming
    const claimableStatuses = ['WAITING', 'DEFERRED_OFFLINE']
    if (!claimableStatuses.includes(reservation.status)) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({
        success: false,
        error: `Reservation status '${reservation.status}' is not claimable`,
      }, 400)
    }

    // Mark the reservation as claimed and checked-in
    const now = new Date()
    await db.reservation.update({
      where: { id: reservation.id },
      data: {
        qrClaimedAt: now,
        qrClaimDeviceId: deviceId,
        status: 'CONFIRMED',
      },
    })

    // Emit real-time events to agency room
    try {
      await emitQueueEvent('queue:updated', reservation.agencyId, {
        action: 'qr_claimed',
        reservationId: reservation.id,
        ticketNumber: reservation.displayNumber,
        deviceId,
      })
      await emitReservationEvent('reservation:updated', reservation.agencyId, reservation.userId || undefined, {
        reservationId: reservation.id,
        status: 'CONFIRMED',
        qrClaimedAt: now.toISOString(),
      })
      await emitKioskEvent('kiosk:update', reservation.agencyId, {
        action: 'qr_claimed',
        reservationId: reservation.id,
        ticketNumber: reservation.displayNumber,
      })
    } catch (emitErr) {
      console.warn('[QR-Claim] Failed to emit realtime event:', emitErr)
    }

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      message: 'Reservation claimed successfully',
      reservation: {
        id: reservation.id,
        displayNumber: reservation.displayNumber,
        status: 'CONFIRMED',
        queueNumber: reservation.queueNumber,
        agency: reservation.agency,
        service: reservation.service,
        user: reservation.user,
        joinedAt: reservation.joinedAt,
        qrClaimedAt: now.toISOString(),
        qrClaimDeviceId: deviceId,
      },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as 429)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[QR-Claim Error]', message)
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /qr-claim/verify/:token — Verify a QR token without claiming (preview)
app.get('/verify/:token', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    const token = c.req.param('token')
    if (!token) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Token is required' }, 400)
    }

    // Verify the QR token
    const payload = verifyQRToken(token)
    if (!payload) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Invalid or expired QR token', valid: false }, 200)
    }

    // Find the reservation for preview
    const reservation = await db.reservation.findUnique({
      where: { id: payload.reservationId },
      include: {
        agency: { select: { id: true, name: true, nameAr: true, nameFr: true, category: true } },
        service: { select: { id: true, name: true, nameAr: true, nameFr: true, prefix: true } },
        user: { select: { id: true, fullName: true } },
      },
    })

    if (!reservation) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Reservation not found', valid: false }, 200)
    }

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.json({
      success: true,
      valid: true,
      alreadyClaimed: !!reservation.qrClaimedAt,
      preview: {
        id: reservation.id,
        displayNumber: reservation.displayNumber,
        status: reservation.status,
        queueNumber: reservation.queueNumber,
        agency: reservation.agency,
        service: reservation.service,
        customerName: reservation.user?.fullName || reservation.walkInCustomerName || null,
        joinedAt: reservation.joinedAt,
        claimedAt: reservation.qrClaimedAt,
      },
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as 429)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[QR-Verify Error]', message)
    return c.json({ success: false, error: message }, 500)
  }
})

export const qrClaimRoutes = app
