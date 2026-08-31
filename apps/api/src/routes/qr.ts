import { Hono } from 'hono'
import QRCode from 'qrcode'
import { createHmac, timingSafeEqual } from 'crypto'
import { db } from '@blasti/db'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { generateImportToken, verifyQRToken } from '../lib/qr-token-service'
import { enforceRateLimit, PUBLIC_RATE_LIMIT, GENERAL_RATE_LIMIT, isRateLimitError, rateLimitErrorResponse, recordSuccessfulRequest, recordFailedRequest } from '../lib/rate-limit'

const app = new Hono()

// Phase 1f: HMAC secret for signing QR payloads
const QR_HMAC_SECRET = process.env.QR_HMAC_SECRET || 'blast1-qr-hm4c-s3cr3t-f0r-t1ck3t5'

/**
 * Sign a QR code payload with HMAC-SHA256 to prevent ticket forgery.
 * Includes serviceDate and absolute expiry to prevent replay attacks across days.
 * The signature is appended as a query parameter `sig`.
 * Verification endpoint checks the signature before accepting the code.
 */
function signQrPayload(code: string, timestamp: number, serviceDate?: string): string {
  // Include service date to prevent screenshot forgery on subsequent days
  const dateStr = serviceDate || new Date().toISOString().split('T')[0]
  // Absolute expiry: 24 hours from signing
  const exp = timestamp + 86400 // 24 hours in seconds
  const payload = `${code}:${timestamp}:${dateStr}:${exp}`
  const hmac = createHmac('sha256', QR_HMAC_SECRET)
  hmac.update(payload)
  return hmac.digest('hex').substring(0, 16) // Use first 16 chars for compact QR
}

/**
 * Verify a QR code signature using timing-safe comparison.
 * Returns true if the signature matches the code, timestamp, and serviceDate.
 */
export function verifyQrSignature(code: string, timestamp: number, signature: string, serviceDate?: string): boolean {
  const expected = signQrPayload(code, timestamp, serviceDate)
  // Use timing-safe comparison to prevent timing attacks
  try {
    const providedBuf = Buffer.from(signature, 'utf-8')
    const expectedBuf = Buffer.from(expected, 'utf-8')
    if (providedBuf.length !== expectedBuf.length) return false
    return timingSafeEqual(providedBuf, expectedBuf)
  } catch {
    return false
  }
}

// GET /qr — Generate HMAC-signed QR code for an agency code
app.get('/', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, PUBLIC_RATE_LIMIT)

    const code = c.req.query('code')
    if (!code) return c.json({ success: false, error: 'code query param is required' }, 400)

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz'

    // Phase 1f: Sign the QR payload with HMAC (includes serviceDate & expiry)
    const timestamp = Math.floor(Date.now() / 1000)
    const serviceDate = new Date().toISOString().split('T')[0]
    const signature = signQrPayload(code, timestamp, serviceDate)
    const qrData = `${baseUrl}/?code=${code}&t=${timestamp}&d=${serviceDate}&sig=${signature}`

    const svgString = await QRCode.toString(qrData, {
      type: 'svg',
      width: 200,
      margin: 2,
      color: { dark: '#047857', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.body(svgString, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// GET /qr/verify — Verify a QR code signature
app.get('/verify', async (c) => {
  try {
    const code = c.req.query('code')
    const timestamp = c.req.query('t')
    const signature = c.req.query('sig')

    if (!code || !timestamp || !signature) {
      return c.json({ success: false, error: 'Missing code, t (timestamp), or sig (signature) parameters' }, 400)
    }

    const ts = parseInt(timestamp, 10)
    if (isNaN(ts)) {
      return c.json({ success: false, error: 'Invalid timestamp' }, 400)
    }

    // Check absolute expiry using the exp embedded in the signed payload
    const exp = ts + 86400
    const now = Math.floor(Date.now() / 1000)
    if (now > exp) {
      return c.json({ success: false, error: 'QR code has expired', valid: false }, 200)
    }

    const serviceDate = c.req.query('d')
    const valid = verifyQrSignature(code, ts, signature, serviceDate)

    const age = now - ts
    return c.json({
      success: true,
      valid,
      code: valid ? code : undefined,
      age,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── Module 4: O2O QR Bridge — Import Token QR Code Generation ──────────────

// GET /qr/import/:reservationId — Generate a QR code SVG with the importToken for a reservation
app.get('/import/:reservationId', async (c) => {
  let clientIp: string | undefined
  try {
    clientIp = enforceRateLimit(c, GENERAL_RATE_LIMIT)

    const user = await requireAuth(c)
    if (!user) return authErrorResponse(c, 'Authentication required')

    const reservationId = c.req.param('reservationId')
    if (!reservationId) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'reservationId is required' }, 400)
    }

    // Find the reservation
    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      include: {
        agency: { select: { id: true, name: true } },
        service: { select: { id: true, name: true, prefix: true } },
      },
    })

    if (!reservation) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'Reservation not found' }, 404)
    }

    // Verify ownership
    if (reservation.userId !== user.id) {
      if (clientIp) recordFailedRequest(clientIp)
      return c.json({ success: false, error: 'You do not own this reservation' }, 403)
    }

    // Generate or reuse the import token
    let token = reservation.importToken
    if (!token) {
      const customerId = reservation.userId || reservation.walkInCustomerName || ''
      token = generateImportToken(reservation.id, reservation.agencyId, customerId)
      await db.reservation.update({
        where: { id: reservationId },
        data: { importToken: token },
      })
    } else {
      // Check if the existing token is still valid
      const payload = verifyQRToken(token)
      if (!payload) {
        // Token expired, regenerate
        const customerId = reservation.userId || reservation.walkInCustomerName || ''
        token = generateImportToken(reservation.id, reservation.agencyId, customerId)
        await db.reservation.update({
          where: { id: reservationId },
          data: { importToken: token },
        })
      }
    }

    // Generate QR code SVG with the import token
    const svgString = await QRCode.toString(token, {
      type: 'svg',
      width: 256,
      margin: 2,
      color: { dark: '#047857', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })

    if (clientIp) recordSuccessfulRequest(clientIp)

    return c.body(svgString, 200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

export const qrRoutes = app
