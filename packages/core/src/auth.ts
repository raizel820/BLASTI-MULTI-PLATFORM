/**
 * @blasti/core — Shared Authentication Utilities
 *
 * Portable JWT creation/verification for both cloud (jose) and local mode.
 * Works in Node.js (cloud API) and Electron (local embedded API).
 */

import * as jose from 'jose'
import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────

export interface SessionUser {
  id: string
  username: string
  fullName: string
  role: string
  language: string
  avatarUrl: string | null
  agencyId: string | null
}

export interface AuthConfig {
  /** HS256 secret for JWT signing (cloud mode) */
  jwtSecret: string
  /** Session expiry in seconds (default: 30 days) */
  sessionMaxAge?: number
  /** App name for JWT issuer claim */
  issuer?: string
}

// ─── JWT Session Token (Cloud Mode) ──────────────────────────────────────

/**
 * Create a JWT session token compatible with the cloud API's auth middleware.
 * Uses HS256 with the provided secret.
 */
export async function createSessionToken(
  user: SessionUser,
  config: AuthConfig,
): Promise<string> {
  const secret = new TextEncoder().encode(config.jwtSecret)
  const maxAge = config.sessionMaxAge ?? 30 * 24 * 60 * 60 // 30 days

  const payload: Record<string, unknown> = {
    sub: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    language: user.language,
    avatarUrl: user.avatarUrl,
    agencyId: user.agencyId,
    'https://blasti.app/role': user.role,
    'https://blasti.app/agencyId': user.agencyId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + maxAge,
    iss: config.issuer || 'blasti',
  }

  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAge)
    .sign(secret)
}

/**
 * Verify and decode a JWT session token.
 * Returns null if the token is invalid, expired, or malformed.
 */
export async function verifySessionToken(
  token: string,
  config: AuthConfig,
): Promise<SessionUser | null> {
  try {
    const secret = new TextEncoder().encode(config.jwtSecret)
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
      issuer: config.issuer || 'blasti',
    })

    if (!payload.sub || typeof payload.sub !== 'string') return null

    return {
      id: payload.sub,
      username: (payload.username as string) || '',
      fullName: (payload.fullName as string) || '',
      role: (payload.role as string) || 'CUSTOMER',
      language: (payload.language as string) || 'ar',
      avatarUrl: (payload.avatarUrl as string) || null,
      agencyId: (payload.agencyId as string) || (payload['https://blasti.app/agencyId'] as string) || null,
    }
  } catch {
    return null
  }
}

// ─── Local Session Token (Desktop Mode) ────────────────────────────────────
//
// For the desktop's embedded API, we use a simpler token scheme:
// A random hex string stored in memory + compared with timing-safe comparison.
// This avoids JWT complexity for localhost-only access.

let _localSessionToken: string | null = null
let _localSessionUser: SessionUser | null = null
let _localSessionCreatedAt: number = 0

/**
 * Generate a cryptographically secure random local session token.
 * Stores the associated user in memory for fast verification.
 */
export function createLocalSessionToken(user: SessionUser): string {
  _localSessionToken = crypto.randomBytes(32).toString('hex')
  _localSessionUser = user
  _localSessionCreatedAt = Date.now()
  return _localSessionToken
}

/**
 * Verify a local session token using timing-safe comparison.
 * Returns the associated SessionUser or null.
 */
export function verifyLocalSessionToken(token: string): SessionUser | null {
  if (!_localSessionToken || !_localSessionUser) return null

  try {
    const expectedBuf = Buffer.from(_localSessionToken, 'utf-8')
    const providedBuf = Buffer.from(token, 'utf-8')
    if (expectedBuf.length !== providedBuf.length) return null
    if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null

    // Token valid — return cached user
    return _localSessionUser
  } catch {
    return null
  }
}

/**
 * Get the current local session (for desktop startup when user auto-logs in).
 */
export function getLocalSession(): { token: string; user: SessionUser } | null {
  if (!_localSessionToken || !_localSessionUser) return null
  return { token: _localSessionToken, user: _localSessionUser }
}

/**
 * Clear the local session (logout).
 */
export function clearLocalSession(): void {
  _localSessionToken = null
  _localSessionUser = null
  _localSessionCreatedAt = 0
}

/**
 * Check if a local session is active.
 */
export function hasLocalSession(): boolean {
  return !!_localSessionToken && !!_localSessionUser
}
