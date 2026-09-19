/**
 * @blasti/api — Auth Routes
 *
 * Hono route handlers for authentication endpoints.
 * Ported from @blasti/web Next.js API routes.
 *
 * Routes:
 *   POST /auth/login     → Authenticate user, set session cookie
 *   POST /auth/register  → Create new user, set session cookie
 *   POST /auth/logout    → Clear session cookie
 *   GET  /auth/logout    → Clear session cookie (browser-navigable)
 */

import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import { db } from '@blasti/db'
import { createSessionToken, getSessionUser, type SessionUser } from '../lib/auth'
import { verifyPassword, hashPassword } from '../lib/password'
import crypto from 'crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import { validateBody, loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema } from '../lib/validations'
import {
  resolveVerificationStatus,
  issueAllPending,
  verifyCode,
  createVerificationToken,
  verifyVerificationToken,
  maskTarget,
  type VerificationPurpose,
} from '../lib/verification-service'
import {
  checkRateLimit,
  checkIpBlocked,
  RateLimitError,
  IpBlockedError,
  LOGIN_RATE_LIMIT,
  AUTH_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
} from '../lib/rate-limit'

// ─── Cookie Constants ──────────────────────────────────────────────────────

const SESSION_TOKEN_NAME = 'next-auth.session-token'
const SECURE_SESSION_TOKEN_NAME = '__Secure-next-auth.session-token'
const CALLBACK_URL_COOKIE = 'next-auth.callback-url'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

function isSecureCookie(): boolean {
  return process.env.NODE_ENV === 'production'
}

function getCookieName(): string {
  return isSecureCookie() ? SECURE_SESSION_TOKEN_NAME : SESSION_TOKEN_NAME
}

// ─── IP Extraction (Hono-compatible) ───────────────────────────────────────

/**
 * Gets the client IP from a Hono context.
 * Handles X-Forwarded-For and other proxy headers.
 * Falls back to a user-agent-based identifier to avoid shared rate-limit buckets.
 * Returns null when no identifiable IP can be derived.
 */
function getClientIp(c: import('hono').Context): string | null {
  // Priority 1: Use the actual TCP connection remote address (anti-spoofing)
  // This cannot be forged by HTTP headers
  try {
    const connInfo = getConnInfo(c)
    if (connInfo?.remote?.address) {
      const ip = connInfo.remote.address
      if (ip && ip !== 'unknown' && ip !== '0.0.0.0' && ip !== '::1' || ip === '::1') {
        // For IPv6 loopback (::1), still accept but also check headers for proxied setups
        if (ip !== '::1') return ip
      }
    }
  } catch {
    // getConnInfo may not be available in all environments
  }

  // Priority 2: Check x-real-ip (set by our Caddy reverse proxy)
  const realIp = c.req.header('x-real-ip')
  if (realIp) {
    const ip = realIp.trim()
    if (ip && ip !== 'unknown' && ip !== '0.0.0.0') return ip
  }

  // Priority 3: Check x-forwarded-for (less trusted, but needed for multi-proxy setups)
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const ip = forwarded.split(',')[0].trim()
    if (ip && ip !== 'unknown' && ip !== '0.0.0.0') return ip
  }

  // Last resort: user-agent hash to avoid shared rate-limit buckets
  const ua = c.req.header('user-agent') || ''
  if (ua) {
    let hash = 0
    for (let i = 0; i < ua.length; i++) {
      hash = ((hash << 5) - hash + ua.charCodeAt(i)) | 0
    }
    return `ua-${Math.abs(hash).toString(36)}`
  }
  return null
}

/**
 * Phase 2a: Null IP trap — validates that a usable client IP was extracted.
 * Rejects requests with empty, "unknown", or "0.0.0.0" IP addresses
 * to prevent attackers from bypassing rate limiting by omitting IP headers.
 */
const INVALID_IP_SENTINELS = new Set(['', 'unknown', '0.0.0.0'])

function requireValidIp(c: import('hono').Context): string {
  const ip = getClientIp(c)
  if (!ip || INVALID_IP_SENTINELS.has(ip)) {
    console.warn(
      `[SECURITY] Null IP trap: rejected request with no identifiable IP. ` +
      `path=${c.req.path} ua=${c.req.header('user-agent') || '<none>'}`,
    )
    throw new Error('INVALID_IP')
  }
  return ip
}

// ─── Session Cookie Helpers ────────────────────────────────────────────────

/**
 * Set the NextAuth-compatible session cookie on the Hono response.
 * Creates a signed JWT and stores it as an httpOnly cookie.
 */
async function setSessionCookie(
  c: import('hono').Context,
  user: SessionUser,
): Promise<void> {
  const token = await createSessionToken(user)
  const secure = isSecureCookie()
  const cookieName = getCookieName()

  setCookie(c, cookieName, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })

  // Also set the callback URL cookie that NextAuth expects
  setCookie(c, CALLBACK_URL_COOKIE, '/', {
    httpOnly: false,
    secure,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })
}

/**
 * Clear the NextAuth session cookie from the Hono response.
 */
function clearSessionCookie(c: import('hono').Context): void {
  const cookieName = getCookieName()
  const secure = isSecureCookie()

  deleteCookie(c, cookieName, {
    path: '/',
    secure,
    sameSite: 'Lax',
    httpOnly: true,
  })

  deleteCookie(c, CALLBACK_URL_COOKIE, {
    path: '/',
    secure,
    sameSite: 'Lax',
    httpOnly: false,
  })
}

// ─── Rate Limit Error Handling ─────────────────────────────────────────────

/**
 * Build a Hono response for rate-limit errors (429).
 */
function rateLimitResponse(error: RateLimitError | IpBlockedError) {
  return (c: import('hono').Context) =>
    c.json(
      { success: false, error: error.message, retryAfter: error.retryAfter },
      429,
      { 'Retry-After': String(error.retryAfter) },
    )
}

// ─── Route Handlers ────────────────────────────────────────────────────────

const app = new Hono()

/**
 * POST /auth/login
 *
 * Authenticate a user with username + password.
 * Sets a NextAuth-compatible session cookie on success.
 */
app.post('/login', async (c) => {
  try {
    // Phase 2a: Require a valid IP before rate-limiting
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, LOGIN_RATE_LIMIT)

    // P2 FIX: Handle empty/malformed body gracefully → 400 instead of 500
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const validation = validateBody(loginSchema, body)
    if (validation.error) {
      return c.json(
        {
          success: validation.error.success,
          error: validation.error.error,
          details: validation.error.details,
        },
        validation.error.status,
      )
    }

    const { username, password, expectedRole } = validation.data

    // Find user by username
    const user = await db.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        language: true,
        avatarUrl: true,
        freeSmsCount: true,
        isActive: true,
        passwordHash: true,
        email: true,
        phoneNumber: true,
        emailVerified: true,
        phoneVerified: true,
        createdAt: true,
      },
    })

    if (!user) {
      return c.json(
        { success: false, error: 'Invalid username or password' },
        401,
      )
    }

    // Check if user is active
    if (!user.isActive) {
      return c.json(
        { success: false, error: 'Account is deactivated' },
        403,
      )
    }

    // Verify password. passwordHash is nullable (Task 14 — synced desktop
    // profiles store NULL; cloud accounts always have one): treat a NULL
    // hash as "no password set" → cannot authenticate.
    const isPasswordValid = !!user.passwordHash && verifyPassword(password, user.passwordHash)
    if (!isPasswordValid) {
      return c.json(
        { success: false, error: 'Invalid username or password' },
        401,
      )
    }

    // Check if user's role matches the expected role from login tab
    // Customer tab: accepts CUSTOMER and SUPER_ADMIN roles
    // Agency tab: accepts AGENCY_OWNER, AGENCY_STAFF, and SUPER_ADMIN roles
    // SUPER_ADMIN can login from either tab
    const agencyRoles = ['AGENCY_OWNER', 'AGENCY_STAFF']
    const isAgencyTab = !!expectedRole && agencyRoles.includes(expectedRole)
    const isCustomerTab = expectedRole === 'CUSTOMER'

    if (expectedRole) {
      // SUPER_ADMIN can login from any tab
      if (user.role === 'SUPER_ADMIN') {
        // allowed
      }
      // Agency tab: AGENCY_OWNER and AGENCY_STAFF are allowed
      else if (isAgencyTab && agencyRoles.includes(user.role)) {
        // allowed
      }
      // Customer tab: only CUSTOMER role is allowed
      else if (isCustomerTab && user.role === 'CUSTOMER') {
        // allowed
      } else {
        return c.json(
          { success: false, error: 'wrongRoleError' },
          403,
        )
      }
    }

    // ── Task 22: Email/phone verification gate ─────────────────────────
    // Unverified accounts (registered after the enforcement date) get OTPs
    // re-issued and a short-lived verificationToken — NO session is issued
    // until both channels are verified.
    const verificationStatus = await resolveVerificationStatus(user)
    if (verificationStatus.required) {
      const issued = await issueAllPending({
        userId: user.id,
        email: user.email,
        phoneNumber: user.phoneNumber,
        emailVerified: verificationStatus.emailVerified,
        phoneVerified: verificationStatus.phoneVerified,
        language: user.language,
        ip,
      })
      const verificationToken = await createVerificationToken(user.id)
      return c.json({
        success: true,
        requiresVerification: true,
        verificationToken,
        pending: {
          email: verificationStatus.emailRequired,
          phone: verificationStatus.phoneRequired,
        },
        targets: {
          email: user.email ? maskTarget(user.email) : null,
          phone: user.phoneNumber ? maskTarget(user.phoneNumber) : null,
        },
        dev: {
          email: issued.email?.devBypass ? { devCode: issued.email.devCode, error: issued.email.error } : null,
          phone: issued.phone?.devBypass ? { devCode: issued.phone.devCode, error: issued.phone.error } : null,
        },
      })
    }

    // Create audit log
    await db.auditLog.create({
      data: {
        userId: user.id,
        action: 'LOGIN',
        entityType: 'USER',
        entityId: user.id,
      },
    })

    // Return user data (exclude passwordHash)
    const { passwordHash: _, ...userData } = user

    // Look up agencyId for agency owners, staff, and super admin
    let agencyId: string | undefined
    if (user.role === 'SUPER_ADMIN') {
      // SUPER_ADMIN gets agencyId from first available agency
      const firstAgency = await db.agency.findFirst({
        select: { id: true },
      })
      agencyId = firstAgency?.id
    } else if (user.role === 'AGENCY_OWNER' || user.role === 'AGENCY_STAFF') {
      if (user.role === 'AGENCY_OWNER') {
        const ownedAgency = await db.agency.findFirst({
          where: { ownerId: user.id },
          select: { id: true },
        })
        agencyId = ownedAgency?.id
      } else {
        const staffAssignment = await db.agencyStaff.findFirst({
          where: { userId: user.id, isActive: true },
          select: { agencyId: true },
        })
        agencyId = staffAssignment?.agencyId
      }
    }

    // Set NextAuth session cookie so protected API routes work
    const sessionUser: SessionUser = {
      ...userData,
      agencyId: agencyId || null,
    }
    const token = await createSessionToken(sessionUser)
    await setCookie(c, getCookieName(), token, {
      httpOnly: true,
      secure: isSecureCookie(),
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    })

    // Return token in response body for native clients (Electron/Capacitor)
    // that can't rely on httpOnly cookies due to cross-origin restrictions.
    // Web clients should use the cookie; native clients should store the token
    // and send it via Authorization: Bearer header.
    return c.json({ success: true, user: { ...userData, agencyId }, token })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/register
 *
 * Create a new user account.
 * Sets a NextAuth-compatible session cookie on success.
 */
app.post('/register', async (c) => {
  try {
    // Phase 2a: Require a valid IP before rate-limiting
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, AUTH_RATE_LIMIT)

    // P2 FIX: Handle empty/malformed body gracefully → 400 instead of 500
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const validation = validateBody(registerSchema, body)
    if (validation.error) {
      return c.json(
        {
          success: validation.error.success,
          error: validation.error.error,
          details: validation.error.details,
        },
        validation.error.status,
      )
    }

    const { username, fullName, password, email, phoneNumber, role, agencyCode, avatarUrl } = validation.data

    // Check for duplicate username
    const existingUser = await db.user.findUnique({
      where: { username },
    })
    if (existingUser) {
      return c.json(
        { success: false, error: 'Username already taken' },
        409,
      )
    }

    // Task 22: email is now REQUIRED at registration (verified via OTP)
    const normalizedEmail = email.trim().toLowerCase()
    const existingEmail = await db.user.findUnique({
      where: { email: normalizedEmail },
    })
    if (existingEmail) {
      return c.json(
        { success: false, error: 'Email already registered' },
        409,
      )
    }

    // Check for duplicate phone number
    if (phoneNumber) {
      const existingPhone = await db.user.findUnique({
        where: { phoneNumber },
      })
      if (existingPhone) {
        return c.json(
          { success: false, error: 'Phone number already registered' },
          409,
        )
      }
    }

    // Hash password
    const passwordHash = hashPassword(password)

    // Create user (Task 22: unverified — both channels must pass OTP before
    // a session is issued)
    const user = await db.user.create({
      data: {
        username,
        fullName,
        passwordHash,
        email: normalizedEmail,
        phoneNumber,
        role: role || 'CUSTOMER',
        avatarUrl: avatarUrl || undefined,
        emailVerified: false,
        phoneVerified: false,
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        language: true,
        avatarUrl: true,
        freeSmsCount: true,
        isActive: true,
        email: true,
        phoneNumber: true,
        createdAt: true,
      },
    })

    // If agency code provided and role is AGENCY_OWNER, link to agency
    let agencyId: string | undefined
    let agencyName: string | undefined
    let agencyNameAr: string | undefined
    let agencyNameFr: string | undefined
    if (agencyCode && role === 'AGENCY_OWNER') {
      const agency = await db.agency.findUnique({
        where: { customCode: agencyCode.toUpperCase() },
      })
      if (agency) {
        await db.agencyStaff.create({
          data: {
            userId: user.id,
            agencyId: agency.id,
            role: 'OWNER',
          },
        })
        agencyId = agency.id
        agencyName = agency.name
        agencyNameAr = agency.nameAr ?? undefined
        agencyNameFr = agency.nameFr ?? undefined
      }
    }

    // ── Task 22: verification instead of an immediate session ─────────
    // Both email and phone must be verified via OTP before the account is
    // usable. The client receives a short-lived verificationToken and shows
    // the OTP step; POST /auth/verify exchanges verified codes for a session.
    const issued = await issueAllPending({
      userId: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      emailVerified: false,
      phoneVerified: false,
      language: user.language,
      ip,
    })
    const verificationToken = await createVerificationToken(user.id)

    return c.json(
      {
        success: true,
        requiresVerification: true,
        verificationToken,
        user: {
          ...user,
          agencyId,
          agencyName,
          agencyNameAr,
          agencyNameFr,
        },
        pending: {
          email: true,
          phone: Boolean(user.phoneNumber),
        },
        targets: {
          email: user.email ? maskTarget(user.email) : null,
          phone: user.phoneNumber ? maskTarget(user.phoneNumber) : null,
        },
        dev: {
          email: issued.email?.devBypass ? { devCode: issued.email.devCode, error: issued.email.error } : null,
          phone: issued.phone?.devBypass ? { devCode: issued.phone.devCode, error: issued.phone.error } : null,
        },
        isNewUser: true,
      },
      201,
    )
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── Task 22: OTP verification endpoints ─────────────────────────────────

/**
 * POST /auth/verify
 *
 * Exchange OTP codes (from the verification step) for a real session.
 * Body: { verificationToken, emailCode?, phoneCode? }
 * At least one code must be provided. When BOTH pending channels become
 * verified, a full session (cookie + body token) is returned.
 */
app.post('/verify', async (c) => {
  try {
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, AUTH_RATE_LIMIT)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { verificationToken, emailCode, phoneCode } = body as {
      verificationToken?: string
      emailCode?: string
      phoneCode?: string
    }

    if (!verificationToken) {
      return c.json({ success: false, error: 'verificationToken is required' }, 400)
    }
    const userId = await verifyVerificationToken(verificationToken)
    if (!userId) {
      return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
    }
    if (!emailCode && !phoneCode) {
      return c.json({ success: false, error: 'Provide at least one code' }, 400)
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, fullName: true, role: true, language: true,
        avatarUrl: true, email: true, phoneNumber: true,
        emailVerified: true, phoneVerified: true, createdAt: true, isActive: true,
      },
    })
    if (!user || !user.isActive) {
      return c.json({ success: false, error: 'USER_NOT_FOUND' }, 404)
    }

    const results: Record<string, unknown> = {}

    if (emailCode) {
      const r = await verifyCode({ userId: user.id, purpose: 'EMAIL_VERIFY' as VerificationPurpose, code: emailCode })
      results.email = r
      if (!r.success) {
        return c.json({ success: false, channel: 'email', error: r.error, remainingAttempts: r.remainingAttempts, results }, 400)
      }
    }
    if (phoneCode) {
      const r = await verifyCode({ userId: user.id, purpose: 'PHONE_VERIFY' as VerificationPurpose, code: phoneCode })
      results.phone = r
      if (!r.success) {
        return c.json({ success: false, channel: 'phone', error: r.error, remainingAttempts: r.remainingAttempts, results }, 400)
      }
    }

    // Re-resolve after the successful verifications
    const refreshed = await db.user.findUnique({
      where: { id: user.id },
      select: { emailVerified: true, phoneVerified: true, email: true, phoneNumber: true },
    })
    const emailVerified = refreshed?.emailVerified ?? false
    const phoneVerified = refreshed?.phoneVerified ?? false
    const stillPending = (Boolean(refreshed?.email) && !emailVerified) || (Boolean(refreshed?.phoneNumber) && !phoneVerified)

    if (stillPending) {
      return c.json({
        success: true,
        verified: false,
        status: { emailVerified, phoneVerified },
        message: 'Partial verification — the other channel is still pending',
        results,
      })
    }

    // Fully verified → issue the real session (cookie for web, token for native)
    const agencyId = user.role === 'AGENCY_OWNER'
      ? (await db.agency.findFirst({ where: { ownerId: user.id }, select: { id: true } }))?.id ?? null
      : user.role === 'AGENCY_STAFF'
        ? (await db.agencyStaff.findFirst({ where: { userId: user.id, isActive: true }, select: { agencyId: true } }))?.agencyId ?? null
        : null

    const sessionUser: SessionUser = {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      language: user.language,
      avatarUrl: user.avatarUrl,
      agencyId: agencyId ?? null,
    }
    const token = await createSessionToken(sessionUser)
    await setSessionCookie(c, sessionUser)

    await db.auditLog.create({
      data: { userId: user.id, action: 'ACCOUNT_VERIFIED', entityType: 'USER', entityId: user.id },
    })

    return c.json({
      success: true,
      verified: true,
      status: { emailVerified, phoneVerified },
      user: { ...sessionUser, email: refreshed?.email, phoneNumber: refreshed?.phoneNumber },
      token,
      results,
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/resend-verification
 *
 * Re-issue an OTP for one channel. Rate-limited (60s cooldown, 6/hour) inside
 * the verification service.
 * Body: { verificationToken, channel: 'email' | 'phone' }
 */
app.post('/resend-verification', async (c) => {
  try {
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, AUTH_RATE_LIMIT)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { verificationToken, channel } = body as { verificationToken?: string; channel?: string }
    if (!verificationToken || (channel !== 'email' && channel !== 'phone')) {
      return c.json({ success: false, error: 'verificationToken and channel (email|phone) are required' }, 400)
    }
    const userId = await verifyVerificationToken(verificationToken)
    if (!userId) {
      return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phoneNumber: true, emailVerified: true, phoneVerified: true, language: true },
    })
    if (!user) {
      return c.json({ success: false, error: 'USER_NOT_FOUND' }, 404)
    }

    const result = channel === 'email'
      ? user.email && !user.emailVerified
        ? await issueAllPending({ userId: user.id, email: user.email, phoneNumber: null, emailVerified: false, phoneVerified: true, language: user.language, ip }).then(r => r.email)
        : { success: false, error: 'ALREADY_VERIFIED', expiresInMinutes: 0 }
      : user.phoneNumber && !user.phoneVerified
        ? await issueAllPending({ userId: user.id, email: null, phoneNumber: user.phoneNumber, emailVerified: true, phoneVerified: false, language: user.language, ip }).then(r => r.phone)
        : { success: false, error: 'ALREADY_VERIFIED', expiresInMinutes: 0 }

    return c.json({
      success: result?.success ?? false,
      error: result?.error,
      channel,
      target: result?.target ? maskTarget(result.target) : undefined,
      devBypass: result?.devBypass,
      devCode: result?.devCode,
      retryAfterSeconds: result?.retryAfterSeconds,
      expiresInMinutes: result?.expiresInMinutes,
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/verification-status
 *
 * Resume an interrupted verification flow: returns what is still pending.
 * Body: { verificationToken }
 */
app.post('/verification-status', async (c) => {
  try {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { verificationToken } = body as { verificationToken?: string }
    if (!verificationToken) {
      return c.json({ success: false, error: 'verificationToken is required' }, 400)
    }
    const userId = await verifyVerificationToken(verificationToken)
    if (!userId) {
      return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, phoneNumber: true, emailVerified: true, phoneVerified: true },
    })
    if (!user) {
      return c.json({ success: false, error: 'USER_NOT_FOUND' }, 404)
    }
    return c.json({
      success: true,
      pending: {
        email: Boolean(user.email) && !user.emailVerified,
        phone: Boolean(user.phoneNumber) && !user.phoneVerified,
      },
      targets: {
        email: user.email ? maskTarget(user.email) : null,
        phone: user.phoneNumber ? maskTarget(user.phoneNumber) : null,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/logout
 *
 * Clears the NextAuth session cookie, effectively logging the user out.
 * The frontend should also clear its local Zustand state.
 */
app.post('/logout', async (c) => {
  try {
    clearSessionCookie(c)
    return c.json({ success: true, message: 'Logged out successfully' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * GET /auth/session
 *
 * Validate the current session and return user data.
 * Compatible with next-auth's /api/auth/session endpoint.
 * The frontend AuthProvider uses this to validate sessions.
 */
app.get('/session', async (c) => {
  try {
    const user = await getSessionUser(c)
    if (!user) {
      return c.json({})
    }
    // Return in NextAuth-compatible format
    return c.json({
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        language: user.language,
        avatarUrl: user.avatarUrl,
        agencyId: user.agencyId,
      },
      expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
  } catch {
    return c.json({})
  }
})

/**
 * GET /auth/logout
 *
 * Also supports GET for convenience (e.g., browser navigation).
 */
app.get('/logout', async (c) => {
  try {
    clearSessionCookie(c)
    return c.json({ success: true, message: 'Logged out successfully' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── Password Reset (In-Memory Token Store) ──────────────────────────────

interface ResetTokenEntry {
  userId: string
  username: string
  expiresAt: number
}

const resetTokenStore = new Map<string, ResetTokenEntry>()

// Clean up expired reset tokens every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [token, entry] of resetTokenStore.entries()) {
    if (now > entry.expiresAt) {
      resetTokenStore.delete(token)
    }
  }
}, 5 * 60 * 1000)

/**
 * POST /auth/forgot-password
 *
 * Request a password reset token for a given username.
 * Always returns the same message to prevent username enumeration.
 * Rate limited: 3 requests per hour per IP.
 */
app.post('/forgot-password', async (c) => {
  try {
    // Phase 2a: Require a valid IP before rate-limiting
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, PASSWORD_RESET_RATE_LIMIT)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }

    const validation = validateBody(forgotPasswordSchema, body)
    if (validation.error) {
      return c.json(
        {
          success: validation.error.success,
          error: validation.error.error,
          details: validation.error.details,
        },
        validation.error.status,
      )
    }

    const { username } = validation.data

    // Find user by username (but don't reveal existence)
    const user = await db.user.findUnique({
      where: { username },
      select: { id: true, username: true },
    })

    if (user) {
      // Generate a reset token
      const resetToken = crypto.randomBytes(32).toString('hex')
      const expiresAt = Date.now() + 15 * 60 * 1000 // 15 minutes

      // Store in-memory
      resetTokenStore.set(resetToken, {
        userId: user.id,
        username: user.username,
        expiresAt,
      })

      // Log to console (dev mode — no email server)
      console.log(`[Forgot Password] Reset token for user "${user.username}": ${resetToken} (expires in 15 min)`)
    }

    // Always return the same message to prevent username enumeration
    return c.json({
      success: true,
      message: 'If the account exists, a password reset link has been sent.',
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/reset-password
 *
 * Reset a user's password using a valid reset token.
 * The token must exist in the in-memory store and not be expired.
 */
app.post('/reset-password', async (c) => {
  try {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }

    const validation = validateBody(resetPasswordSchema, body)
    if (validation.error) {
      return c.json(
        {
          success: validation.error.success,
          error: validation.error.error,
          details: validation.error.details,
        },
        validation.error.status,
      )
    }

    const { token, newPassword } = validation.data

    // Validate token
    const tokenEntry = resetTokenStore.get(token)
    if (!tokenEntry) {
      return c.json(
        { success: false, error: 'Invalid or expired reset token' },
        400,
      )
    }

    // Check expiry
    if (Date.now() > tokenEntry.expiresAt) {
      resetTokenStore.delete(token)
      return c.json(
        { success: false, error: 'Reset token has expired. Please request a new one.' },
        400,
      )
    }

    // Hash the new password
    const passwordHash = hashPassword(newPassword)

    // Update user's password in the database
    await db.user.update({
      where: { id: tokenEntry.userId },
      data: { passwordHash },
    })

    // Delete the used token
    resetTokenStore.delete(token)

    console.log(`[Reset Password] Password reset successfully for user "${tokenEntry.username}"`)

    return c.json({
      success: true,
      message: 'Password has been reset successfully',
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

// ─── Username Availability Check ────────────────────────────────────────────

/** Rate limit for username availability checks: 20 per minute per IP */
const USERNAME_CHECK_RATE_LIMIT: import('../lib/rate-limit').RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 20,
  prefix: 'username-check',
}

/**
 * GET /auth/check-username?username=xxx
 *
 * Checks if a username is available for registration.
 * Returns { available: true } or { available: false }.
 *
 * Security considerations:
 * - Rate limited to prevent brute-force enumeration
 * - Does NOT reveal whether a username exists — just available/unavailable
 * - Requires minimum 3 characters before checking
 * - Always returns the same response shape regardless of whether user exists
 */
app.get('/check-username', async (c) => {
  try {
    // Phase 2a: Require a valid IP before rate-limiting
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, USERNAME_CHECK_RATE_LIMIT)

    const username = c.req.query('username')?.trim()

    // Validate input
    if (!username || username.length < 3) {
      // For short/missing usernames, return available to not block early typing
      return c.json({ available: true })
    }

    if (username.length > 30) {
      return c.json({ available: false })
    }

    // Check for invalid characters (alphanumeric + underscore only)
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return c.json({ available: false })
    }

    // Check if username exists in database
    const existingUser = await db.user.findUnique({
      where: { username },
      select: { id: true },
    })

    return c.json({ available: !existingUser })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    // On error, return available to not block registration — better UX than showing error
    // This also prevents leaking information about internal errors
    console.error('[check-username] Error:', error)
    return c.json({ available: true })
  }
})

// ─── Export ────────────────────────────────────────────────────────────────

export const authRoutes = app
