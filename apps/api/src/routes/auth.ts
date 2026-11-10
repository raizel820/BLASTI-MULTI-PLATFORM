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
import { createSessionToken, getSessionUser, requireAuth, AuthError, REMEMBER_ME_MAX_AGE, resolveClientPlatform, assertPlatformLoginAllowed, type ClientPlatform, type SessionUser } from '../lib/auth'
import { verifyPassword, hashPassword } from '../lib/password'
import crypto from 'crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import { validateBody, loginSchema, registerSchema, forgotPasswordSchema, resetPasswordSchema } from '../lib/validations'
// UID-0.6.14 — immutable per-user identifier ({TYPE}-{WILAYA}-{SEQ}).
import { assignUidToUser } from '../lib/uid-generator'
import { normalizeRecordFileUrls } from '../lib/file-url'
import {
  resolveVerificationStatus,
  issueAllPending,
  issueVerification,
  verifyCode,
  createVerificationToken,
  verifyVerificationToken,
  maskTarget,
  getVerifiedContacts,
  getVerificationMode,
  createPendingRegistrationToken,
  verifyPendingRegistrationToken,
  issuePendingRegistrationOtp,
  verifyPendingRegistrationOtp,
  pendingModeRequires,
  purgeStalePendingRegistrations,
  type VerificationPurpose,
  type IssueResult,
} from '../lib/verification-service'
// 0.6.54 — one phone number must never alias two unrelated identities
// (user↔agency rule lives here; the unique-constraint checks stay inline).
import { assertUserPhoneNotAgencyConflicting } from '../lib/phone-contacts'
import { deliverTemplate } from '../lib/messaging/template-service'
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
 * Security-0.6.13 — `platform` (the minting client's platform) is baked into
 * the token so requireAdmin can deny admin-API access to app-minted sessions.
 */
async function setSessionCookie(
  c: import('hono').Context,
  user: SessionUser,
  platform: ClientPlatform = 'web',
): Promise<void> {
  const token = await createSessionToken(user, SESSION_MAX_AGE, platform)
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

    const { username, password, rememberMe } = validation.data
    // Secrecy-0.6.48 — `expectedRole` (still accepted in the schema for
    // backward-compatible clients) is deliberately IGNORED: the server
    // auto-detects the account type from the credentials themselves. Role
    // tabs are gone from every login screen.
    void validation.data.expectedRole

    // Secrecy-0.6.48 — TIMING EQUALIZER. An unknown username currently skips
    // the (~50-100ms) scrypt password check, so response latency would leak
    // which usernames exist. On a miss we burn one scrypt verification
    // against a fixed dummy hash so both paths cost the same.
    let timingHash: string | null = null
    const equalizeTiming = () => {
      if (timingHash === null) timingHash = hashPassword('blasti-timing-equalizer-0.6.48')
      verifyPassword('blasti-timing-probe', timingHash)
    }

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
        // UID-0.6.14 — the immutable account identifier rides the login
        // response (native shells store it with the session).
        uid: true,
        createdAt: true,
      },
    })

    if (!user) {
      // Same generic body/status as a wrong password — and now the same cost.
      equalizeTiming()
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

    // ── Secrecy-0.6.48: role×platform login matrix (AUTO-DETECT) ────────
    // The server recognizes the account type from the credentials and only
    // compares them against the roles this platform allows:
    //   mobile (apk)  → CUSTOMER + AGENCY sessions (no admin, ever)
    //   desktop (exe) → AGENCY sessions only
    //   web (ANY browser — phone browsers included) → every role
    // A correct-but-unsupported account answers EXACTLY like a wrong
    // password (generic 401) — no message ever mentions the account type,
    // its existence, or which platforms support it. Enforced BEFORE any
    // session is minted (and again on the admin-API side via the token's
    // platform claim).
    const clientPlatform = resolveClientPlatform(c)
    assertPlatformLoginAllowed(clientPlatform, user.role)

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
          // Task 43: deterministic pick (oldest owned agency) — must match
          // getUserAgencyId/verifyAgencyOwnership/resolveUserAgencyId so the
          // login-bound agency, the ownership checks and the sync importer
          // all agree even when an owner somehow owns multiple agencies.
          orderBy: { createdAt: 'asc' },
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
    // Task 81 — remember-me policy: a checked "Remember me" box issues a
    // 3-DAY token/cookie instead of the 30-day default. The client may then
    // keep the session alive while the app is actively used via
    // POST /auth/refresh (which re-issues 3-day tokens), but the total
    // lifetime never exceeds 3 days from login.
    const sessionMaxAge = rememberMe ? REMEMBER_ME_MAX_AGE : SESSION_MAX_AGE
    const token = await createSessionToken(sessionUser, sessionMaxAge, clientPlatform)
    await setCookie(c, getCookieName(), token, {
      httpOnly: true,
      secure: isSecureCookie(),
      sameSite: 'Lax',
      path: '/',
      maxAge: sessionMaxAge,
    })

    // Return token in response body for native clients (Electron/Capacitor)
    // that can't rely on httpOnly cookies due to cross-origin restrictions.
    // Web clients should use the cookie; native clients should store the token
    // and send it via Authorization: Bearer header.
    return c.json({ success: true, user: { ...userData, agencyId }, token, sessionMaxAge })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    // Security-0.6.13 — AuthError carries its own status/message. Since
    // Secrecy-0.6.48 the platform-matrix rejection IS the generic
    // wrong-credentials answer (401) — surfaced faithfully so no client
    // can ever distinguish it from a real password failure.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
    if (error instanceof RateLimitError || error instanceof IpBlockedError) {
      return rateLimitResponse(error)(c)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/refresh — Task 81 sliding-window session refresh.
 *
 * Remember-me sessions live AT MOST 3 days from login (client-enforced hard
 * wall), but a token issued at login must not die mid-use while the customer
 * is actively using the app. The client calls this endpoint periodically
 * (session-keeper): it verifies the caller's CURRENT session (Bearer header
 * or cookie) and issues a fresh token + cookie.
 *
 * Body { rememberMe: true } → the new token keeps the 3-day remember-me
 * policy. Without it a default-policy token is issued.
 *
 * Auth failures bubble up as 401 — the client treats that as "session gone,
 * re-login required (password or biometric)".
 */
app.post('/refresh', async (c) => {
  try {
    const ip = requireValidIp(c)
    checkIpBlocked(ip)
    checkRateLimit(ip, AUTH_RATE_LIMIT)

    const user = await requireAuth(c)

    let body: { rememberMe?: boolean } = {}
    try {
      body = await c.req.json()
    } catch {
      // Empty/absent body is fine — defaults apply.
    }

    const maxAge = body.rememberMe ? REMEMBER_ME_MAX_AGE : SESSION_MAX_AGE
    // Security-0.6.13 — re-assert the platform policy on refresh: a session
    // being kept alive from an app whose platform forbids its role dies here.
    const refreshPlatform = resolveClientPlatform(c)
    assertPlatformLoginAllowed(refreshPlatform, user.role)
    const token = await createSessionToken(user, maxAge, refreshPlatform)

    await setCookie(c, getCookieName(), token, {
      httpOnly: true,
      secure: isSecureCookie(),
      sameSite: 'Lax',
      path: '/',
      maxAge,
    })

    return c.json({ success: true, token, user, sessionMaxAge: maxAge })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'INVALID_IP') {
      return c.json({ success: false, error: 'Unable to identify client' }, 400)
    }
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
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
    // 0.6.60 — the strict AUTH bucket (5/15min) is consumed AFTER validation
    // passes, not here: validation failures (a phone typo) must never burn
    // the user's 15-minute registration allowance — that lockout, stacked on
    // the global register bucket, was the "too many requests" field incident
    // (3 typo-retries → 429 with a UI that never showed the actual 400).
    const ip = requireValidIp(c)
    checkIpBlocked(ip)

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

    // Validation passed — NOW the request is a real signup attempt: charge
    // the strict auth bucket before any DB write / OTP dispatch.
    checkRateLimit(ip, AUTH_RATE_LIMIT)

    const { username, fullName, password, email, phoneNumber, role, agencyCode } = validation.data
    // Task 5 — optional Algeria address (register form location selectors).
    // wilaya arrives as the canonical two-digit code (schema regex enforced);
    // padStart is defense in depth for unpadded '1'..'9' style clients. An
    // invalid/empty commune is dropped rather than stored.
    const registerWilaya = validation.data.wilaya
      ? (validation.data.wilaya.padStart(2, '0').match(/^(0[1-9]|[1-5][0-8])$/) ? validation.data.wilaya.padStart(2, '0') : undefined)
      : undefined
    const registerCommune = validation.data.commune?.trim() || undefined
    // Task 2-c — normalize on write: the avatar is stored as the canonical
    // RELATIVE /api/upload/file/... path (desktop-local absolute URLs and
    // request-origin absolute URLs are stripped to their path), so it stays
    // reachable from every device once the file-sync push delivers the blob.
    const avatarUrl = normalizeRecordFileUrls({ avatarUrl: validation.data.avatarUrl }).avatarUrl

    // 0.6.54 — resolve the staged-registration continuation token FIRST: a
    // user who went BACK from the OTP step to fix a typo (wrong email/phone)
    // re-submits the SAME signup — their own pending row must be UPDATED, not
    // collide with the uniqueness checks below.
    const normalizedUsername = username.trim()
    let ownPendingId: string | null = null
    if (validation.data.pendingToken) {
      const pendingId = await verifyPendingRegistrationToken(validation.data.pendingToken)
      if (pendingId) {
        const ownPending = await db.pendingRegistration.findUnique({
          where: { id: pendingId },
          select: { id: true },
        })
        if (ownPending) ownPendingId = ownPending.id
      }
    }
    // Free identifiers held by signups abandoned for over 24h (best-effort).
    if (!ownPendingId) await purgeStalePendingRegistrations()

    const notOwnPending = ownPendingId ? { id: { not: ownPendingId } } : {}

    // Check for duplicate username — live accounts AND in-flight signups.
    const existingUser = await db.user.findUnique({
      where: { username: normalizedUsername },
    })
    if (existingUser) {
      return c.json(
        { success: false, error: 'Username already taken' },
        409,
      )
    }
    const pendingUsername = await db.pendingRegistration.findFirst({
      where: { username: normalizedUsername, ...notOwnPending },
      select: { id: true },
    })
    if (pendingUsername) {
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
    const pendingEmail = await db.pendingRegistration.findFirst({
      where: { email: normalizedEmail, ...notOwnPending },
      select: { id: true },
    })
    if (pendingEmail) {
      return c.json(
        { success: false, error: 'Email already registered' },
        409,
      )
    }

    // Check for duplicate phone number — live accounts AND in-flight signups.
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
      const pendingPhone = await db.pendingRegistration.findFirst({
        where: { phoneNumber, ...notOwnPending },
        select: { id: true },
      })
      if (pendingPhone) {
        return c.json(
          { success: false, error: 'Phone number already registered' },
          409,
        )
      }
      // 0.6.54 — a user's phone may match an AGENCY phone only when they are
      // (or are about to become) that agency's owner/staff. A registrant
      // carrying an agencyCode is allowed against THAT agency (they become
      // its owner the moment the account is created).
      const phoneRule = await assertUserPhoneNotAgencyConflicting(null, phoneNumber, {
        allowOwnerOfAgencyCodes: agencyCode ? [agencyCode] : [],
      })
      if (!phoneRule.ok) {
        return c.json(
          { success: false, error: 'This phone number is already used by an agency account' },
          409,
        )
      }
    }

    // Hash password
    const passwordHash = hashPassword(password)

    // Task 31-A: SUPER_ADMIN accounts are created pre-verified — they skip
    // the email/phone OTP flow entirely (see the early return below).
    const isSuperAdmin = role === 'SUPER_ADMIN'
    // 0.6.54 — platform verification mode 'none' mandates NO OTP: the account
    // is created immediately. (Previously this mode returned
    // requiresVerification with zero codes issued — an unsignable dead end.)
    const verificationMode = await getVerificationMode()
    const immediateCreation = isSuperAdmin || verificationMode === 'none'

    // ── Immediate creation (SUPER_ADMIN, or platform mode 'none') ────────
    // 0.6.54 — the account row is created ONLY inside this branch. The
    // staged path below NEVER touches db.user: every mandated OTP channel
    // must verify first (that is the whole point of the staged flow).
    if (immediateCreation) {
      const user = await db.user.create({
        data: {
          username: normalizedUsername,
          fullName,
          passwordHash,
          email: normalizedEmail,
          phoneNumber,
          role: role || 'CUSTOMER',
          avatarUrl: avatarUrl || undefined,
          emailVerified: true,
          phoneVerified: true,
          // Task 5 — optional Algeria address (absent → NULL columns).
          wilaya: registerWilaya,
          commune: registerCommune,
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
          // Task 5 — included so the desktop register proxy can mirror the
          // address onto the local operational User row.
          wilaya: true,
          commune: true,
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

      // UID-0.6.14 — the immutable UID is assigned ONCE, at account creation.
      // SUPER_ADMIN never gets one; owners get their agency's wilaya as the
      // fallback when their own profile wilaya is unset.
      const assignedUid = isSuperAdmin
        ? ''
        : await assignUidToUser(user.id, role === 'AGENCY_OWNER' ? (agencyId ? (await db.agency.findUnique({ where: { id: agencyId }, select: { wilaya: true } }))?.wilaya ?? null : null) : null)

      // ── Task 31-A: SUPER_ADMIN registers WITHOUT verification ──────────
      // Platform admins must not wait for email/phone OTP: no issueAllPending
      // and no createVerificationToken are called (zero OTP rows), and a full
      // session is issued immediately — mirroring the verify-flow session
      // issuance below. requiresVerification is intentionally NOT returned:
      // the register UI would render an empty verification step.
      // 0.6.54 — the SAME immediate path serves platform mode 'none'.
      {
        const sessionUser: SessionUser = {
          id: user.id,
          username: user.username,
          fullName: user.fullName,
          role: user.role,
          language: user.language,
          avatarUrl: user.avatarUrl,
          agencyId: agencyId ?? null,
        }
        // Security-0.6.13 — an admin session can only be minted for the web
        // console; the mobile/desktop apps never receive one.
        const registerPlatform = resolveClientPlatform(c)
        assertPlatformLoginAllowed(registerPlatform, sessionUser.role)
        const token = await createSessionToken(sessionUser, SESSION_MAX_AGE, registerPlatform)
        await setSessionCookie(c, sessionUser, registerPlatform)

        await db.auditLog.create({
          data: { userId: user.id, action: 'REGISTERED', entityType: 'USER', entityId: user.id },
        })

        return c.json(
          {
            success: true,
            user: {
              ...user,
              uid: assignedUid || undefined,
              agencyId,
              agencyName,
              agencyNameAr,
              agencyNameFr,
            },
            token,
            isNewUser: true,
          },
          201,
        )
      }
    }

    // ── 0.6.54: STAGED registration — NO User row exists yet ────────────
    // The signup payload lands in PendingRegistration and the OTPs are issued
    // against it. POST /auth/verify creates the real account ONLY once every
    // mandated channel confirms — going back to fix a typo never creates an
    // orphan account and never locks an identifier.
    const requires = pendingModeRequires(verificationMode, true, Boolean(phoneNumber))

    const PENDING_SELECT = {
      id: true, username: true, fullName: true, email: true, phoneNumber: true,
      role: true, agencyCode: true, avatarUrl: true, wilaya: true, commune: true,
      language: true, emailVerified: true, phoneVerified: true, createdAt: true,
    } as const

    let pendingRow = ownPendingId
      ? await db.pendingRegistration.findUnique({ where: { id: ownPendingId }, select: PENDING_SELECT })
      : null
    let emailChanged = false
    let phoneChanged = false
    if (pendingRow) {
      // Same signup, edited details → update the staged row in place.
      emailChanged = pendingRow.email !== normalizedEmail
      phoneChanged = (pendingRow.phoneNumber ?? null) !== (phoneNumber ?? null)
      pendingRow = await db.pendingRegistration.update({
        where: { id: pendingRow.id },
        data: {
          username: normalizedUsername,
          fullName,
          passwordHash,
          email: normalizedEmail,
          phoneNumber: phoneNumber || null,
          role: role || 'CUSTOMER',
          agencyCode,
          avatarUrl: avatarUrl || undefined,
          wilaya: registerWilaya,
          commune: registerCommune,
          requestIp: ip,
          // Editing a contact resets THAT channel's verification progress —
          // a new address must be re-proven by a new code.
          ...(emailChanged ? { emailVerified: false } : {}),
          ...(phoneChanged ? { phoneVerified: false } : {}),
        },
        select: PENDING_SELECT,
      })
    } else {
      pendingRow = await db.pendingRegistration.create({
        data: {
          username: normalizedUsername,
          fullName,
          passwordHash,
          email: normalizedEmail,
          phoneNumber: phoneNumber || null,
          role: role || 'CUSTOMER',
          agencyCode,
          avatarUrl: avatarUrl || undefined,
          wilaya: registerWilaya,
          commune: registerCommune,
          requestIp: ip,
        },
        select: PENDING_SELECT,
      })
    }

    // Issue OTPs ONLY for still-unverified mandated channels: an unchanged
    // re-submit keeps the codes already in flight (no cooldown penalty for
    // toggling back and forth); an EDITED contact gets fresh codes
    // immediately (targetChanged skips the resend cooldown).
    const issued: { email?: IssueResult; phone?: IssueResult } = {}
    if (requires.email && !pendingRow.emailVerified) {
      issued.email = await issuePendingRegistrationOtp({
        pendingId: pendingRow.id,
        purpose: 'EMAIL_VERIFY',
        target: pendingRow.email,
        fullName: pendingRow.fullName,
        language: pendingRow.language || 'ar',
        ip,
        targetChanged: emailChanged,
      })
    }
    if (requires.phone && pendingRow.phoneNumber && !pendingRow.phoneVerified) {
      issued.phone = await issuePendingRegistrationOtp({
        pendingId: pendingRow.id,
        purpose: 'PHONE_VERIFY',
        target: pendingRow.phoneNumber,
        fullName: pendingRow.fullName,
        language: pendingRow.language || 'ar',
        ip,
        targetChanged: phoneChanged,
      })
    }
    const verificationToken = await createPendingRegistrationToken(pendingRow.id)

    return c.json(
      {
        success: true,
        requiresVerification: true,
        // 0.6.54 marker — the payload is STAGED, not a created account.
        // Desktop proxies use it to skip the local profile upsert.
        stagedRegistration: true,
        verificationToken,
        // Staged-payload mirror for legacy consumers (desktop logging/UI).
        // NOT a real account — it disappears if the signup is abandoned.
        user: {
          id: pendingRow.id,
          username: pendingRow.username,
          fullName: pendingRow.fullName,
          role: pendingRow.role,
          language: pendingRow.language,
          avatarUrl: pendingRow.avatarUrl,
          freeSmsCount: 10,
          isActive: true,
          email: pendingRow.email,
          phoneNumber: pendingRow.phoneNumber,
          wilaya: pendingRow.wilaya,
          commune: pendingRow.commune,
          createdAt: pendingRow.createdAt,
        },
        pending: {
          email: requires.email,
          phone: requires.phone,
        },
        targets: {
          email: maskTarget(pendingRow.email),
          phone: pendingRow.phoneNumber ? maskTarget(pendingRow.phoneNumber) : null,
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
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

    // ── 0.6.54: pending-registration branch ──────────────────────────────
    // The token may belong to a STAGED signup (PendingRegistration — no User
    // row yet). Codes are checked against the staged row; the USER ACCOUNT is
    // created HERE, only once every mandated channel has verified.
    const pendingId = await verifyPendingRegistrationToken(verificationToken)
    if (pendingId) {
      const pending = await db.pendingRegistration.findUnique({ where: { id: pendingId } })
      if (!pending) {
        return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
      }
      if (!emailCode && !phoneCode) {
        return c.json({ success: false, error: 'Provide at least one code' }, 400)
      }

      const results: Record<string, unknown> = {}

      if (emailCode) {
        const r = await verifyPendingRegistrationOtp({ pendingId: pending.id, purpose: 'EMAIL_VERIFY' as VerificationPurpose, code: emailCode })
        results.email = r
        if (!r.success) {
          return c.json({ success: false, channel: 'email', error: r.error, remainingAttempts: r.remainingAttempts, results }, 400)
        }
      }
      if (phoneCode) {
        const r = await verifyPendingRegistrationOtp({ pendingId: pending.id, purpose: 'PHONE_VERIFY' as VerificationPurpose, code: phoneCode })
        results.phone = r
        if (!r.success) {
          return c.json({ success: false, channel: 'phone', error: r.error, remainingAttempts: r.remainingAttempts, results }, 400)
        }
      }

      const refreshed = await db.pendingRegistration.findUnique({ where: { id: pending.id } })
      if (!refreshed) {
        return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
      }

      const pendingMode = await getVerificationMode()
      const pendingRequires = pendingModeRequires(pendingMode, Boolean(refreshed.email), Boolean(refreshed.phoneNumber))
      const stillPending = (pendingRequires.email && !refreshed.emailVerified) || (pendingRequires.phone && !refreshed.phoneVerified)

      if (stillPending) {
        return c.json({
          success: true,
          verified: false,
          status: { emailVerified: refreshed.emailVerified, phoneVerified: refreshed.phoneVerified },
          message: 'Partial verification — the other channel is still pending',
          results,
        })
      }

      // ── ALL mandated channels verified → create the account NOW ────────
      // Uniqueness re-check: another signup may have claimed an identifier
      // while this one was in flight. On conflict the pending row SURVIVES so
      // the user can go back, edit the colliding field, and re-verify —
      // nothing was created yet, so nothing has to be cleaned up.
      const conflicts: string[] = []
      if (await db.user.findUnique({ where: { username: refreshed.username }, select: { id: true } })) {
        conflicts.push('USERNAME_CONFLICT_ON_CREATE')
      }
      if (await db.user.findUnique({ where: { email: refreshed.email }, select: { id: true } })) {
        conflicts.push('EMAIL_CONFLICT_ON_CREATE')
      }
      if (refreshed.phoneNumber) {
        if (await db.user.findUnique({ where: { phoneNumber: refreshed.phoneNumber }, select: { id: true } })) {
          conflicts.push('PHONE_CONFLICT_ON_CREATE')
        }
        const agencyRule = await assertUserPhoneNotAgencyConflicting(null, refreshed.phoneNumber, {
          allowOwnerOfAgencyCodes: refreshed.agencyCode ? [refreshed.agencyCode] : [],
        })
        if (!agencyRule.ok) conflicts.push('PHONE_CONFLICT_ON_CREATE')
      }
      if (conflicts.length > 0) {
        return c.json({ success: false, error: conflicts[0], conflicts, results }, 409)
      }

      // Agency link (AGENCY_OWNER + code) — resolves the owner's UID fallback.
      let pendingAgencyId: string | null = null
      let pendingAgencyWilaya: string | null = null
      if (refreshed.agencyCode && refreshed.role === 'AGENCY_OWNER') {
        const agency = await db.agency.findUnique({
          where: { customCode: refreshed.agencyCode.toUpperCase() },
          select: { id: true, wilaya: true },
        })
        if (agency) {
          pendingAgencyId = agency.id
          pendingAgencyWilaya = agency.wilaya
        }
      }

      const user = await db.user.create({
        data: {
          username: refreshed.username,
          fullName: refreshed.fullName,
          passwordHash: refreshed.passwordHash,
          email: refreshed.email,
          phoneNumber: refreshed.phoneNumber,
          role: refreshed.role,
          avatarUrl: refreshed.avatarUrl || undefined,
          emailVerified: refreshed.emailVerified,
          phoneVerified: refreshed.phoneVerified,
          wilaya: refreshed.wilaya ?? undefined,
          commune: refreshed.commune ?? undefined,
        },
        select: {
          id: true, username: true, fullName: true, role: true, language: true,
          avatarUrl: true, freeSmsCount: true, isActive: true, email: true,
          phoneNumber: true, wilaya: true, commune: true, createdAt: true,
        },
      })

      if (pendingAgencyId) {
        await db.agencyStaff.create({
          data: { userId: user.id, agencyId: pendingAgencyId, role: 'OWNER' },
        })
      }

      // UID-0.6.14 — assigned ONCE at creation (owners inherit the agency
      // wilaya as the fallback segment).
      const assignedUid = await assignUidToUser(user.id, refreshed.role === 'AGENCY_OWNER' ? pendingAgencyWilaya : null)

      // ── Welcome email (fire-and-forget, never blocks the session) ──
      // Sent once when the account becomes FULLY verified.
      if (refreshed.email && refreshed.emailVerified) {
        deliverTemplate({
          key: 'welcome', channel: 'EMAIL', target: refreshed.email,
          language: refreshed.language || 'en', vars: { fullName: refreshed.fullName },
        }).catch(() => undefined)
      }

      await db.auditLog.create({
        data: { userId: user.id, action: 'REGISTERED', entityType: 'USER', entityId: user.id },
      }).catch(() => undefined)
      await db.auditLog.create({
        data: { userId: user.id, action: 'ACCOUNT_VERIFIED', entityType: 'USER', entityId: user.id },
      }).catch(() => undefined)

      // The staged payload is consumed — its OTP codes cascade with it.
      await db.pendingRegistration.delete({ where: { id: refreshed.id } }).catch(() => undefined)

      // Fully verified → issue the real session (cookie for web, token for native)
      const sessionUser: SessionUser = {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        language: user.language,
        avatarUrl: user.avatarUrl,
        agencyId: pendingAgencyId,
      }
      // Security-0.6.13 — platform policy applies at verification too: the
      // freshly-verified session respects the role×platform matrix.
      const verifyPlatform = resolveClientPlatform(c)
      assertPlatformLoginAllowed(verifyPlatform, sessionUser.role)
      const token = await createSessionToken(sessionUser, SESSION_MAX_AGE, verifyPlatform)
      await setSessionCookie(c, sessionUser, verifyPlatform)

      return c.json({
        success: true,
        verified: true,
        status: { emailVerified: refreshed.emailVerified, phoneVerified: refreshed.phoneVerified },
        user: {
          ...sessionUser,
          uid: assignedUid,
          email: refreshed.email,
          phoneNumber: refreshed.phoneNumber,
          freeSmsCount: user.freeSmsCount,
          isActive: user.isActive,
          wilaya: user.wilaya,
          commune: user.commune,
          createdAt: user.createdAt,
        },
        token,
        results,
      })
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
        // UID-0.6.14 — assigned at register; rides the session response.
        uid: true,
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

    // ── Welcome email (fire-and-forget, never blocks the session) ──
    // Sent once when the account becomes FULLY verified — this endpoint is
    // only reachable while verification is pending, so it naturally runs once.
    if (refreshed?.email && emailVerified) {
      deliverTemplate({
        key: 'welcome', channel: 'EMAIL', target: refreshed.email,
        language: user.language || 'en', vars: { fullName: user.fullName },
      }).catch(() => undefined)
    }

    const sessionUser: SessionUser = {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      language: user.language,
      avatarUrl: user.avatarUrl,
      agencyId: agencyId ?? null,
    }
    // Security-0.6.13 — platform policy applies at verification too: the
    // freshly-verified session respects the role×platform matrix.
    const verifyPlatform = resolveClientPlatform(c)
    assertPlatformLoginAllowed(verifyPlatform, sessionUser.role)
    const token = await createSessionToken(sessionUser, SESSION_MAX_AGE, verifyPlatform)
    await setSessionCookie(c, sessionUser, verifyPlatform)

    await db.auditLog.create({
      data: { userId: user.id, action: 'ACCOUNT_VERIFIED', entityType: 'USER', entityId: user.id },
    })

    return c.json({
      success: true,
      verified: true,
      status: { emailVerified, phoneVerified },
      user: { ...sessionUser, uid: user.uid, email: refreshed?.email, phoneNumber: refreshed?.phoneNumber },
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
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

    // ── 0.6.54: pending-registration branch (staged signup, no User row) ──
    const pendingId = await verifyPendingRegistrationToken(verificationToken)
    if (pendingId) {
      const pending = await db.pendingRegistration.findUnique({ where: { id: pendingId } })
      if (!pending) {
        return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
      }
      const result: IssueResult | { success: false; error: string; expiresInMinutes: number } =
        channel === 'email'
          ? pending.email && !pending.emailVerified
            ? await issuePendingRegistrationOtp({
                pendingId: pending.id,
                purpose: 'EMAIL_VERIFY',
                target: pending.email,
                fullName: pending.fullName,
                language: pending.language || 'ar',
                ip,
              })
            : { success: false, error: 'ALREADY_VERIFIED', expiresInMinutes: 0 }
          : pending.phoneNumber && !pending.phoneVerified
            ? await issuePendingRegistrationOtp({
                pendingId: pending.id,
                purpose: 'PHONE_VERIFY',
                target: pending.phoneNumber,
                fullName: pending.fullName,
                language: pending.language || 'ar',
                ip,
              })
            : { success: false, error: 'ALREADY_VERIFIED', expiresInMinutes: 0 }

      return c.json({
        success: result.success,
        error: result.error,
        channel,
        target: 'target' in result && result.target ? maskTarget(result.target) : undefined,
        devBypass: 'devBypass' in result ? result.devBypass : undefined,
        devCode: 'devCode' in result ? result.devCode : undefined,
        retryAfterSeconds: 'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined,
        expiresInMinutes: result.expiresInMinutes,
      })
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
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

    // ── 0.6.54: staged signups resume through the same endpoint ──
    const pendingId = await verifyPendingRegistrationToken(verificationToken)
    if (pendingId) {
      const pending = await db.pendingRegistration.findUnique({ where: { id: pendingId } })
      if (!pending) {
        return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
      }
      const pendingMode = await getVerificationMode()
      const pendingRequires = pendingModeRequires(pendingMode, Boolean(pending.email), Boolean(pending.phoneNumber))
      return c.json({
        success: true,
        stagedRegistration: true,
        pending: {
          email: pendingRequires.email && !pending.emailVerified,
          phone: pendingRequires.phone && !pending.phoneVerified,
        },
        targets: {
          email: pending.email ? maskTarget(pending.email) : null,
          phone: pending.phoneNumber ? maskTarget(pending.phoneNumber) : null,
        },
      })
    }

    const userId = await verifyVerificationToken(verificationToken)
    if (!userId) {
      return c.json({ success: false, error: 'VERIFICATION_TOKEN_INVALID' }, 401)
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phoneNumber: true, emailVerified: true, phoneVerified: true, createdAt: true, role: true },
    })
    if (!user) {
      return c.json({ success: false, error: 'USER_NOT_FOUND' }, 404)
    }
    // Mode-aware: the UI must show ONLY the channels the current platform
    // verification mode actually mandates (none/email/phone/both).
    const status = await resolveVerificationStatus(user).catch(() => null)
    return c.json({
      success: true,
      pending: status
        ? { email: status.emailRequired, phone: status.phoneRequired }
        : {
            email: Boolean(user.email) && !user.emailVerified,
            phone: Boolean(user.phoneNumber) && !user.phoneVerified,
          },
      targets: {
        email: user.email ? maskTarget(user.email) : null,
        phone: user.phoneNumber ? maskTarget(user.phoneNumber) : null,
      },
    })
  } catch (error: unknown) {
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/account/verification/issue — SESSION required.
 *
 * Self-service verification from the user's own account settings: (re)send
 * the OTP for their email and/or phone regardless of the platform mode, so
 * an unverified contact can ALWAYS become verified (strict reset rule then
 * accepts it). Rate limits + cooldown live inside issueVerification().
 */
app.post('/account/verification/issue', async (c) => {
  try {
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) return c.json({ success: false, error: 'UNAUTHORIZED' }, 401)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { channel } = body as { channel?: string }
    if (channel !== 'email' && channel !== 'phone') {
      return c.json({ success: false, error: "channel must be 'email' or 'phone'" }, 400)
    }

    const user = await db.user.findUnique({
      where: { id: sessionUser.id },
      select: { id: true, email: true, phoneNumber: true, language: true },
    })
    if (!user) return c.json({ success: false, error: 'USER_NOT_FOUND' }, 404)

    const target = channel === 'email' ? user.email : user.phoneNumber
    if (!target) {
      return c.json({ success: false, error: 'NO_CONTACT_ON_FILE' }, 400)
    }

    const ip = getConnInfo(c)?.remote?.address
    const purpose: VerificationPurpose = channel === 'email' ? 'EMAIL_VERIFY' : 'PHONE_VERIFY'
    const r = await issueVerification({
      userId: user.id,
      purpose,
      target,
      language: user.language || 'en',
      ip,
    })
    return c.json({
      success: r.success,
      error: r.error,
      channel: r.channel,
      target: maskTarget(target),
      expiresInMinutes: r.expiresInMinutes,
      retryAfterSeconds: r.retryAfterSeconds,
      ...(r.devBypass ? { devBypass: true, devCode: r.devCode } : {}),
    }, r.success ? 200 : 429)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * POST /auth/account/verification/confirm — SESSION required.
 *
 * Confirm a self-service OTP ({ channel, code }). On success the matching
 * verified flag is set; the response carries the fresh verification status.
 */
app.post('/account/verification/confirm', async (c) => {
  try {
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) return c.json({ success: false, error: 'UNAUTHORIZED' }, 401)

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { channel, code } = body as { channel?: string; code?: string }
    if ((channel !== 'email' && channel !== 'phone') || !code) {
      return c.json({ success: false, error: "channel ('email'|'phone') and code are required" }, 400)
    }

    const purpose: VerificationPurpose = channel === 'email' ? 'EMAIL_VERIFY' : 'PHONE_VERIFY'
    const r = await verifyCode({ userId: sessionUser.id, purpose, code })
    return c.json({
      success: r.success,
      error: r.error,
      remainingAttempts: r.remainingAttempts,
      expired: r.expired,
      status: r.status,
    }, r.success ? 200 : 400)
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
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
 * POST /auth/refresh-session
 *
 * Re-issues the session token from the DATABASE's current view of the user.
 * Round 16 (field deadlock): a session token is a SNAPSHOT — an AGENCY_OWNER
 * that registered (or logged in) BEFORE creating their agency carries
 * agencyId: '' until the token is re-issued. Agency creation used to leave
 * every issued token stale, so the desktop sync engine kept seeing "no
 * agency" and the workspace never initialized. This endpoint resolves the
 * CURRENT role + agency ownership from the DB and returns a fresh token and
 * user so clients can upgrade their session in place (also heals role
 * changes, staff assignments and agencies created on another device).
 */
app.post('/refresh-session', async (c) => {
  try {
    const sessionUser = await getSessionUser(c)
    if (!sessionUser) {
      return c.json({ success: false, error: 'Authentication required' }, 401)
    }

    const dbUser = await db.user.findUnique({ where: { id: sessionUser.id } })
    if (!dbUser) {
      // A stateless JWT for an account that no longer exists (e.g. an
      // offline-issued desktop token after a cloud DB reset) — force a
      // clean re-login instead of perpetuating a ghost session.
      return c.json({ success: false, error: 'Account not found — please sign in again' }, 401)
    }

    // Resolve the CURRENT agency: OWNED agency first (deterministic oldest
    // pick), then active staff membership — Task 44: ALIGNED with the
    // business surface (verifyAgencyOwnership / getUserAgencyId /
    // resolveUserAgencyId all own-first + createdAt-asc). The previous
    // staff-first order could bind a DIFFERENT agency than every business
    // route for an owner who also has a staff row.
    let agencyId: string | null = null
    const ownedAgency = await db.agency.findFirst({
      where: { ownerId: dbUser.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    agencyId = ownedAgency?.id ?? null
    if (!agencyId) {
      const staffRecord = await db.agencyStaff.findFirst({
        where: { userId: dbUser.id, isActive: true },
        select: { agencyId: true },
      })
      agencyId = staffRecord?.agencyId ?? null
    }

    const freshUser: SessionUser = {
      id: dbUser.id,
      username: dbUser.username,
      fullName: dbUser.fullName,
      role: dbUser.role,
      language: dbUser.language || 'ar',
      avatarUrl: dbUser.avatarUrl ?? null,
      agencyId,
    }
    // Security-0.6.13 — the cookie-heal re-mint re-asserts the platform
    // policy (a customer session healing inside the desktop app dies here).
    const healPlatform = resolveClientPlatform(c)
    assertPlatformLoginAllowed(healPlatform, freshUser.role)
    const token = await createSessionToken(freshUser, SESSION_MAX_AGE, healPlatform)
    // UID-0.6.14 — the immutable identifier rides every session (re)issue so
    // a healed session never drops it.
    return c.json({ success: true, token, user: { ...freshUser, uid: dbUser.uid ?? null } })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error'
    console.error('[AUTH] refresh-session error:', error)
    return c.json({ success: false, error: message }, 500)
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
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
      select: { id: true, username: true, fullName: true, email: true, phoneNumber: true, language: true, emailVerified: true, phoneVerified: true },
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

      // ── Deliver the reset code — STRICT RULE (verified contacts ONLY) ──
      // Auth-critical codes are sent exclusively to VERIFIED channels:
      // verified email first, else the verified phone via SMS. Unverified
      // contacts are NEVER used, no matter the verification mode — users
      // verify them self-service from their account settings.
      const verified = await getVerifiedContacts(user)
      const vars = { fullName: user.fullName ?? user.username, code: resetToken, expiryMinutes: 15 }
      let delivered = false
      if (verified.email) {
        const r = await deliverTemplate({
          key: 'password_reset', channel: 'EMAIL', target: verified.email,
          language: user.language || 'en', vars,
        }).catch(() => null)
        delivered = Boolean(r?.success)
      } else if (verified.phone) {
        // SMS legibility: a compact 8-char code instead of the 64-hex token
        const smsCode = crypto.randomBytes(4).toString('hex').toUpperCase()
        resetTokenStore.set(smsCode, {
          userId: user.id,
          username: user.username,
          expiresAt,
        })
        const r = await deliverTemplate({
          key: 'password_reset', channel: 'SMS', target: verified.phone,
          language: user.language || 'en',
          vars: { ...vars, code: smsCode },
        }).catch(() => null)
        delivered = Boolean(r?.success)
      }
      if (!delivered) {
        if (process.env.NODE_ENV === 'production') {
          // STRICT: no verified channel → the code is NEVER emitted (the
          // generic response below prevents account enumeration either way).
          console.warn(`[Forgot Password] "${user.username}" has NO verified contact — reset code withheld (strict rule)`)
        } else {
          // Dev fallback: console log so dev environments never lose the token
          console.log(`[Forgot Password] Reset token for user "${user.username}": ${resetToken} (expires in 15 min)`)
        }
      }
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
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
    // Security-0.6.13 — AuthError carries its own status/message (platform
    // login-matrix rejections, expired sessions): surface it faithfully
    // instead of masking it behind a generic 500.
    if (error instanceof AuthError) {
      return c.json({ success: false, error: error.message }, error.statusCode as any)
    }
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

    // 0.6.54 — in-flight signups hold usernames too. The registrant's OWN
    // pending row (identified by the optional pendingToken) never blocks
    // their own re-checks while they edit the rest of the form.
    const ownPendingId = await verifyPendingRegistrationToken(c.req.query('pendingToken') || '')
    const pendingUser = await db.pendingRegistration.findFirst({
      where: { username, ...(ownPendingId ? { id: { not: ownPendingId } } : {}) },
      select: { id: true },
    })

    return c.json({ available: !existingUser && !pendingUser })
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
