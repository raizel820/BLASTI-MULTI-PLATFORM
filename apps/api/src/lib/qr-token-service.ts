/**
 * Module 4: O2O QR Bridge — QR Token Service
 *
 * Generates and validates HMAC-based QR tokens for reservations.
 * These tokens allow customers to generate a QR code from the web/mobile app
 * and scan it at a kiosk to claim their reservation (skip queue entry).
 */

import { createHmac } from 'crypto'

const QR_SECRET_KEY = process.env.NEXTAUTH_SECRET || 'blast1-qr-dev-key'

export interface QRTokenPayload {
  reservationId: string
  agencyId: string
  customerId: string
  exp: number  // Unix timestamp expiration
}

/**
 * Generate an HMAC-signed QR token for a reservation.
 * Token format: base64url(payload).signature
 * Expires in 30 minutes.
 */
export function generateQRToken(reservationId: string, agencyId: string, customerId: string): string {
  const exp = Math.floor(Date.now() / 1000) + (30 * 60) // 30 minutes expiry
  const payload = JSON.stringify({ reservationId, agencyId, customerId, exp })
  const signature = createHmac('sha256', QR_SECRET_KEY)
    .update(payload)
    .digest('hex')

  // Format: base64(payload).signature
  const encodedPayload = Buffer.from(payload).toString('base64url')
  return `${encodedPayload}.${signature}`
}

/**
 * Verify an HMAC-signed QR token.
 * Returns the parsed payload if valid, or null if invalid/expired.
 */
export function verifyQRToken(token: string): QRTokenPayload | null {
  try {
    const [encodedPayload, signature] = token.split('.')
    if (!encodedPayload || !signature) return null

    const payload = Buffer.from(encodedPayload, 'base64url').toString('utf8')

    // Verify signature with constant-time comparison
    const expectedSignature = createHmac('sha256', QR_SECRET_KEY)
      .update(payload)
      .digest('hex')

    if (signature.length !== expectedSignature.length) return null
    let result = 0
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i)
    }
    if (result !== 0) return null

    const parsed = JSON.parse(payload) as QRTokenPayload

    // Check expiration
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null

    return parsed
  } catch {
    return null
  }
}

/**
 * Convenience wrapper: generate an import token for O2O QR bridge.
 */
export function generateImportToken(reservationId: string, agencyId: string, customerId: string): string {
  return generateQRToken(reservationId, agencyId, customerId)
}
