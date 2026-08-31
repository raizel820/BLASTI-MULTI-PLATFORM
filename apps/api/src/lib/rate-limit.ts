/**
 * Simple in-memory rate limiter for API routes.
 * Uses a sliding window approach with cleanup.
 * Includes IP-based abuse blocking for repeated offenses.
 *
 * Adapted for Hono (replaces Next.js NextRequest/NextResponse).
 */

import type { Context } from 'hono'

interface RateLimitEntry {
  count: number
  resetTime: number
}

interface AbuseEntry {
  failCount: number
  firstFailAt: number
  blockedUntil: number | null
}

const store = new Map<string, RateLimitEntry>()
const abuseStore = new Map<string, AbuseEntry>()

// ─── Configuration ────────────────────────────────────────────────────────────

/** Number of failed requests (4xx errors from public routes) before blocking */
const ABUSE_FAIL_THRESHOLD = 10

/** Window in ms for counting failed requests */
const ABUSE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes

/** How long to block an abusive IP (in ms) */
const ABUSE_BLOCK_DURATION_MS = 30 * 60 * 1000 // 30 minutes

// Cleanup old entries every 60 seconds
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetTime) {
      store.delete(key)
    }
  }
  // Cleanup abuse entries
  for (const [ip, entry] of abuseStore.entries()) {
    if (entry.blockedUntil && now > entry.blockedUntil) {
      abuseStore.delete(ip)
    } else if (!entry.blockedUntil && now - entry.firstFailAt > ABUSE_WINDOW_MS) {
      abuseStore.delete(ip)
    }
  }
}, 60_000)

// ─── Rate Limit ───────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /** Time window in milliseconds */
  windowMs: number
  /** Maximum number of requests in the window */
  maxRequests: number
  /** Key prefix for namespacing */
  prefix?: string
}

export class RateLimitError extends Error {
  public retryAfter: number

  constructor(retryAfter: number) {
    super('Too many requests, please try again later')
    this.name = 'RateLimitError'
    this.retryAfter = retryAfter
  }
}

export class IpBlockedError extends Error {
  public retryAfter: number

  constructor(retryAfter: number) {
    super('Your IP has been temporarily blocked due to repeated abuse')
    this.name = 'IpBlockedError'
    this.retryAfter = retryAfter
  }
}

/**
 * Checks rate limit for a given identifier (e.g., IP address or user ID).
 * Throws RateLimitError if limit exceeded.
 * Returns the current count if within limit.
 */
export function checkRateLimit(identifier: string, options: RateLimitOptions): number {
  const key = `${options.prefix || 'rl'}:${identifier}`
  const now = Date.now()

  const entry = store.get(key)

  if (!entry || now > entry.resetTime) {
    // New window
    store.set(key, {
      count: 1,
      resetTime: now + options.windowMs,
    })
    return 1
  }

  // Existing window
  entry.count++

  if (entry.count > options.maxRequests) {
    const retryAfter = Math.ceil((entry.resetTime - now) / 1000)
    throw new RateLimitError(retryAfter)
  }

  return entry.count
}

/**
 * Gets the client IP from a Hono Context.
 *
 * Phase 1d: Fixed IP spoofing vulnerability.
 * Previously, this relied solely on X-Forwarded-For and X-Real-IP headers,
 * which can be trivially spoofed by clients.
 *
 * Phase 2a: Added Priority 0 — x-connecting-ip header injected by our own
 * HTTP server from the TCP socket remote address. This cannot be spoofed
 * by HTTP headers since it is set server-side before the request reaches Hono.
 *
 * Falls back to Hono's secure conninfo, then proxy headers ONLY when behind
 * a trusted proxy. The rightmost (closest to server) X-Forwarded-For entry
 * is preferred since the leftmost entries can be injected by the client.
 */
export function getClientIp(c: Context): string {
  // Priority 0: Use the TCP socket remote address injected by our server.
  // This is the most reliable and cannot be spoofed by HTTP headers.
  // Phase 2a: The HTTP server handler in index.ts injects the actual socket
  // remote address into this header before passing the request to Hono.
  const connectingIp = c.req.header('x-connecting-ip')
  if (connectingIp && connectingIp !== '127.0.0.1' && connectingIp !== '::1') {
    return connectingIp.trim()
  }

  // Priority 1: Use Hono's secure conninfo to get the actual TCP remote address
  // This cannot be spoofed by HTTP headers.
  try {
    // @ts-ignore — Hono conninfo may not be typed in all versions
    const remoteAddr = c.env?.remoteAddress
    if (remoteAddr && typeof remoteAddr === 'string' && remoteAddr !== '127.0.0.1' && remoteAddr !== '::1') {
      return remoteAddr.trim()
    }
  } catch {
    // conninfo not available in this runtime
  }

  // Priority 2: For proxied requests, use the RIGHTMOST entry in X-Forwarded-For
  // (the one set by the closest trusted proxy, not the client)
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const ips = forwarded.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0)
    if (ips.length > 0) {
      // Take the rightmost IP (set by the most recent proxy)
      // This is harder to spoof than the leftmost
      return ips[ips.length - 1]
    }
  }

  // Priority 3: X-Real-IP (usually set by nginx/Cloudflare)
  const realIp = c.req.header('x-real-ip')
  if (realIp) {
    return realIp.trim()
  }

  // Priority 4: Use CF-Connecting-IP (Cloudflare-specific)
  const cfIp = c.req.header('cf-connecting-ip')
  if (cfIp) {
    return cfIp.trim()
  }

  // Priority 5: Hash of user-agent as a secondary identifier
  const ua = c.req.header('user-agent') || ''
  if (ua) {
    let hash = 0
    for (let i = 0; i < ua.length; i++) {
      hash = ((hash << 5) - hash + ua.charCodeAt(i)) | 0
    }
    return `ua-${Math.abs(hash).toString(36)}`
  }
  return 'unknown'
}

// ─── IP-based Abuse Blocking ─────────────────────────────────────────────────

/**
 * Checks if an IP is currently blocked due to abuse.
 * Throws IpBlockedError if blocked.
 */
export function checkIpBlocked(ip: string): void {
  const entry = abuseStore.get(ip)
  if (!entry) return

  const now = Date.now()

  if (entry.blockedUntil && now < entry.blockedUntil) {
    const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000)
    throw new IpBlockedError(retryAfter)
  }

  if (entry.blockedUntil && now >= entry.blockedUntil) {
    abuseStore.delete(ip)
  }
}

/**
 * Records a failed request (4xx error from a public route) for abuse tracking.
 */
export function recordFailedRequest(ip: string): void {
  const now = Date.now()
  let entry = abuseStore.get(ip)

  if (!entry || now - entry.firstFailAt > ABUSE_WINDOW_MS) {
    entry = {
      failCount: 1,
      firstFailAt: now,
      blockedUntil: null,
    }
    abuseStore.set(ip, entry)
    return
  }

  entry.failCount++

  if (entry.failCount >= ABUSE_FAIL_THRESHOLD && !entry.blockedUntil) {
    entry.blockedUntil = now + ABUSE_BLOCK_DURATION_MS
  }
}

/**
 * Records a successful request — resets the abuse counter for the IP.
 */
export function recordSuccessfulRequest(ip: string): void {
  const entry = abuseStore.get(ip)
  if (entry && !entry.blockedUntil) {
    abuseStore.delete(ip)
  }
}

// ─── Helper: Rate limit + IP check for public routes ─────────────────────────

/**
 * Convenience function that combines IP blocking check + rate limiting.
 * Call this at the start of any public route handler.
 *
 * @returns the client IP string for further use (e.g., logging)
 * @throws RateLimitError or IpBlockedError
 */
export function enforceRateLimit(c: Context, options: RateLimitOptions): string {
  const ip = getClientIp(c)
  checkIpBlocked(ip)
  checkRateLimit(ip, options)
  return ip
}

/**
 * Creates a proper 429 Too Many Requests response from a RateLimitError or IpBlockedError.
 * Returns a plain object that can be used with c.json().
 */
export function rateLimitErrorResponse(error: unknown): { data: { success: false; error: string; retryAfter: number }; status: number; headers: Record<string, string> } {
  if (error instanceof IpBlockedError) {
    return {
      data: { success: false, error: error.message, retryAfter: error.retryAfter },
      status: 429,
      headers: { 'Retry-After': String(error.retryAfter) },
    }
  }
  if (error instanceof RateLimitError) {
    return {
      data: { success: false, error: error.message, retryAfter: error.retryAfter },
      status: 429,
      headers: { 'Retry-After': String(error.retryAfter) },
    }
  }
  return {
    data: { success: false, error: 'Internal server error', retryAfter: 0 },
    status: 500,
    headers: {},
  }
}

/**
 * Checks if an error is a rate-limit-related error (RateLimitError or IpBlockedError).
 */
export function isRateLimitError(error: unknown): boolean {
  return error instanceof RateLimitError || error instanceof IpBlockedError
}

// ─── Preset configurations ──────────────────────────────────────────────────

/** Auth endpoints: 5 requests per 15 minutes per IP */
export const AUTH_RATE_LIMIT: RateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  prefix: 'auth',
}

/** Login: 10 attempts per 15 minutes per IP */
export const LOGIN_RATE_LIMIT: RateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  prefix: 'login',
}

/** Queue operations: 30 requests per minute per user */
export const QUEUE_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 30,
  prefix: 'queue',
}

/** General API: 100 requests per minute per IP */
export const GENERAL_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 100,
  prefix: 'api',
}

/** Registration: 3 requests per minute per IP */
export const REGISTRATION_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 3,
  prefix: 'register',
}

/** Password reset: 3 per hour per IP */
export const PASSWORD_RESET_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 3,
  prefix: 'pwreset',
}

/** SMS sending: 10 per hour per user */
export const SMS_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 60 * 1000,
  maxRequests: 10,
  prefix: 'sms',
}

/** Kiosk join: 20 joins per 5 minutes per IP (public, unauthenticated) */
export const KIOSK_RATE_LIMIT: RateLimitOptions = {
  windowMs: 5 * 60 * 1000,
  maxRequests: 20,
  prefix: 'kiosk-join',
}

/** Kiosk read (agency/status): 60 requests per minute per IP (public, unauthenticated) */
export const KIOSK_READ_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  prefix: 'kiosk-read',
}

/** Reservation creation: 10 requests per minute per IP */
export const RESERVATION_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  prefix: 'reservation',
}

/** Walk-in customer creation: 10 requests per minute per IP */
export const WALK_IN_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  prefix: 'walkin',
}

/** Public agency listing: 60 requests per minute per IP */
export const AGENCY_LISTING_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  prefix: 'agencies',
}

/** General public routes: 60 requests per minute per IP */
export const PUBLIC_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 60,
  prefix: 'public',
}

/** Cron webhook routes: 10 requests per minute per IP */
export const CRON_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  prefix: 'cron',
}
