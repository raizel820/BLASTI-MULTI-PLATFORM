/**
 * @blasti/api — JWT Authentication Module
 *
 * Replaces next-auth with custom JWT verification using jose.
 * Session tokens are created at login and verified on every authenticated request.
 * The token format is compatible with the existing NextAuth session cookie.
 */

import { jwtVerify, SignJWT } from 'jose'
import type { Context } from 'hono'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SessionUser {
  id: string
  username: string
  fullName: string
  role: string
  language: string
  avatarUrl: string | null
  agencyId: string | null
}

export interface SessionToken {
  id: string
  username: string
  fullName: string
  role: string
  language: string
  avatarUrl: string | null
  agencyId: string
  iat?: number  // Phase 2b: issued-at claim for stale JWT detection
}

// ─── Configuration ─────────────────────────────────────────────────────────

const FALLBACK_SECRET = 'blast1-d3v-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly'
const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 days

function getAuthSecret(): string {
  return process.env.NEXTAUTH_SECRET || FALLBACK_SECRET
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(getAuthSecret())
}

// ─── Token Creation ────────────────────────────────────────────────────────

/**
 * Create a signed JWT session token for a user.
 * This replaces the NextAuth `encode()` function.
 */
export async function createSessionToken(user: SessionUser): Promise<string> {
  const secret = getSecretKey()
  const token = await new SignJWT({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    language: user.language,
    avatarUrl: user.avatarUrl ?? null,
    agencyId: user.agencyId ?? '',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secret)
  return token
}

// ─── Token Verification ────────────────────────────────────────────────────

/**
 * Verify a JWT session token and return the decoded payload.
 * Returns null if the token is invalid or expired.
 *
 * Phase 2b: Optionally checks the `iat` (issued-at) claim against the user's
 * `lastRoleChangeAt` timestamp from the database. If the JWT was issued BEFORE
 * a role change, the token's role claim is stale — reject it and force
 * re-authentication.
 */
export async function verifySessionToken(token: string, options?: { checkStaleRole?: boolean }): Promise<SessionToken | null> {
  try {
    const secret = getSecretKey()
    // Phase 2d: Enforce HS256 algorithm to prevent algorithm confusion attacks.
    // Without this, an attacker could craft a token with alg: 'none' (bypassing
    // signature verification) or alg: 'RS256' (using the HS256 secret as an
    // RSA public key) to forge valid tokens.
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    const sessionToken = payload as unknown as SessionToken

    // ── Task 36: database-reset invalidation ─────────────────────────────────
    // scripts/reset-all.ts stamps .db-generation.json with the reset epoch.
    // EVERY session JWT issued before that moment is dead — even when its
    // signature still verifies and (while the API is still serving the deleted
    // pre-reset database file through its old handle) the account behind it
    // still "exists". Without this, a desktop or browser session survives a
    // full cloud reset and keeps loading the deleted account. The 1s grace
    // absorbs the JWT `iat` second-flooring: a token legitimately created in
    // the same wall-second as the epoch write must stay valid.
    const invalidationEpoch = getInvalidationEpochMs()
    if (invalidationEpoch !== null) {
      const issuedAt = sessionToken.iat
      if (!issuedAt || issuedAt * 1000 < invalidationEpoch - 1000) {
        console.warn(
          `[AUTH] Pre-reset session rejected: user=${sessionToken.id} (${sessionToken.username ?? 'unknown'}) ` +
          `iat=${issuedAt ?? 'none'} is older than resetEpoch=${invalidationEpoch} — forcing re-authentication`,
        )
        return null
      }
    }

    // Phase 2b: Stale JWT escalation check
    if (options?.checkStaleRole && sessionToken.id) {
      const user = await db.user.findUnique({
        where: { id: sessionToken.id },
        select: { lastRoleChangeAt: true, passwordHash: true },
      })
      if (!user) {
        // Ghost session guard: the JWT signature is valid, but the account it
        // refers to no longer exists in the cloud database (e.g. the DB was
        // reset/re-seeded while a desktop or browser session survived).
        // Without this check the ghost token passed EVERY route and the first
        // write blew up with a raw Prisma P2003 FK violation (500) — e.g.
        // POST /api/agencies with ownerId pointing at a non-existent User.
        // A session for a non-existent account is not a session: force
        // re-authentication so the client can show the login screen with a
        // clear message instead of an "Internal server error".
        console.warn(
          `[AUTH] Ghost JWT rejected: user=${sessionToken.id} (${sessionToken.username ?? 'unknown'}) does not exist in the database — forcing re-authentication`,
        )
        return null
      }
      if (user) {
        const iat = sessionToken.iat // seconds since epoch
        if (iat && user.lastRoleChangeAt) {
          // Round 15 FIX: compare in SECONDS on both sides. The JWT `iat`
          // claim has second resolution (floored), while lastRoleChangeAt
          // carries milliseconds — a token issued in the SAME second as the
          // role change compared iatMs (= second * 1000) < lastRoleChangeAt
          // (e.g. .500s) by up to 999ms and was rejected as "stale". That is
          // exactly the register → verify flow: the fresh session token was
          // 401'd ("Authentication required") whenever OTP verification
          // completed within the same second as account creation (always in
          // dev, often in production with fast OTP entry).
          const lastChangeSec = Math.floor(user.lastRoleChangeAt.getTime() / 1000)
          if (iat < lastChangeSec) {
            console.warn(
              `[AUTH] Stale JWT rejected: token iat=${new Date(iat * 1000).toISOString()} ` +
              `< lastRoleChangeAt=${user.lastRoleChangeAt.toISOString()} for user=${sessionToken.id}`,
            )
            return null
          }
        }
      }
    }
    return sessionToken
  } catch {
    return null
  }
}

// ─── Session Extraction from Hono Context ──────────────────────────────────

const SESSION_COOKIE_NAME = 'next-auth.session-token'
const SECURE_COOKIE_NAME = '__Secure-next-auth.session-token'

/**
 * Extract the session token from the request (cookie or Authorization header).
 */
function extractTokenFromRequest(c: Context): string | null {
  // Try Authorization header first (for native clients)
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  // Try session cookie
  const cookieHeader = c.req.header('Cookie') || ''
  const isSecure = process.env.NODE_ENV === 'production'
  const cookieName = isSecure ? SECURE_COOKIE_NAME : SESSION_COOKIE_NAME

  const cookies = cookieHeader.split(';').map(c => c.trim())
  for (const cookie of cookies) {
    if (cookie.startsWith(`${cookieName}=`)) {
      return cookie.slice(cookieName.length + 1)
    }
  }

  return null
}

/**
 * Extract and verify the session from a Hono context.
 * Returns the user object or null if not authenticated.
 *
 * Phase 2b: Now checks for stale JWTs by comparing the token's `iat` claim
 * against the user's `lastRoleChangeAt` timestamp. If the JWT was issued
 * before a role change, it is rejected to prevent privilege escalation.
 */
export async function getSessionUser(c?: Context): Promise<SessionUser | null> {
  if (!c) return null
  try {
    const token = extractTokenFromRequest(c)
    if (!token) return null

    const payload = await verifySessionToken(token, { checkStaleRole: true })
    if (!payload?.id) return null

    return {
      id: payload.id,
      username: payload.username,
      fullName: payload.fullName,
      role: payload.role,
      language: payload.language,
      avatarUrl: payload.avatarUrl ?? null,
      agencyId: payload.agencyId ?? null,
    }
  } catch {
    return null
  }
}

// ─── Error Class ───────────────────────────────────────────────────────────

export class AuthError extends Error {
  public statusCode: number

  constructor(message: string, statusCode: number = 401) {
    super(message)
    this.name = 'AuthError'
    this.statusCode = statusCode
  }
}

// ─── Auth Requirements (same API as original auth-guard.ts) ────────────────

import { db, getInvalidationEpochMs } from '@blasti/db'

/**
 * Requires authentication. Throws AuthError if not logged in.
 */
export async function requireAuth(c: Context): Promise<SessionUser> {
  const user = await getSessionUser(c)
  if (!user) {
    throw new AuthError('Authentication required', 401)
  }
  return user
}

/**
 * Requires SUPER_ADMIN role. Throws AuthError if not admin.
 */
export async function requireAdmin(c: Context): Promise<SessionUser> {
  const user = await requireAuth(c)
  if (user.role !== 'SUPER_ADMIN') {
    throw new AuthError('Admin access required', 403)
  }
  return user
}

/**
 * Requires auth + specific role(s). Throws AuthError if wrong role.
 */
export async function requireRole(c: Context, ...roles: string[]): Promise<SessionUser> {
  const user = await requireAuth(c)
  if (!roles.includes(user.role)) {
    throw new AuthError('Insufficient permissions', 403)
  }
  return user
}

/**
 * Requires auth + verifies the user has access to the specified agency.
 */
export async function requireAgencyAccess(c: Context, agencyId: string): Promise<SessionUser> {
  const user = await requireAuth(c)
  if (user.role === 'SUPER_ADMIN') return user
  if (user.role === 'CUSTOMER') {
    throw new AuthError('Customers cannot access agency resources', 403)
  }
  const ownership = await verifyAgencyOwnership(user.id, agencyId)
  if (!ownership) {
    throw new AuthError('You do not have access to this agency', 403)
  }
  return user
}

/**
 * Requires auth + verifies the authenticated user owns the resource (or is SUPER_ADMIN).
 */
export async function requireResourceOwnership(c: Context, resourceUserId: string): Promise<SessionUser> {
  const user = await requireAuth(c)
  if (user.role === 'SUPER_ADMIN') return user
  if (user.id !== resourceUserId) {
    throw new AuthError('You do not have access to this resource', 403)
  }
  return user
}

// ─── Staff Permission Verification (Phase 2b) ───────────────────────────────

/**
 * Staff permission field names on the AgencyStaff model.
 * These correspond to the boolean columns added in Phase 2 (+ Task 37-c).
 */
export type StaffPermission =
  | 'canManageQueue'
  | 'canManageServices'
  | 'canManageStaff'
  | 'canViewAnalytics'
  | 'canManageBranches'
  | 'canManageWorkingHours'
  | 'canExportData'
  | 'canManageProfile'
  // Task 37-c: 2-tier staff authority — manager-only grants the owner can
  // limit per staff member. canManageQueue/canViewAnalytics stay ALWAYS-SHARED.
  | 'canCreateBranches'
  | 'canDeleteBranches'
  | 'canPurchaseSubscription'
  | 'canManageSubscription'

/** Every StaffPermission key, used to build full-true maps for owners. */
export const STAFF_PERMISSION_KEYS: StaffPermission[] = [
  'canManageQueue',
  'canManageServices',
  'canManageStaff',
  'canViewAnalytics',
  'canManageBranches',
  'canManageWorkingHours',
  'canExportData',
  'canManageProfile',
  'canCreateBranches',
  'canDeleteBranches',
  'canPurchaseSubscription',
  'canManageSubscription',
]

/** Role of the caller inside an agency (Task 37-c authority model). */
export type AgencyRole = 'OWNER' | 'MANAGER' | 'STAFF'

export interface AgencyAuthority {
  isOwner: boolean
  role: AgencyRole | null
  staffId: string | null
  permissions: Record<StaffPermission, boolean>
}

function allPermissionsTrue(): Record<StaffPermission, boolean> {
  const map = {} as Record<StaffPermission, boolean>
  for (const key of STAFF_PERMISSION_KEYS) map[key] = true
  return map
}

/**
 * Task 37-c: resolve the caller's authority inside an agency.
 *
 * - OWNER: resolved via Agency.ownerId — isOwner=true, ALL permissions true,
 *   staffId=null (owners have no AgencyStaff row).
 * - MANAGER/STAFF: resolved via the ACTIVE AgencyStaff row — role + the
 *   normalized boolean columns.
 * - Nobody: nulls + all-false (the record itself is still returned so callers
 *   can render a consistent shape).
 *
 * SUPER_ADMIN is intentionally NOT handled here — callers decide how the
 * platform admin bypasses (usually by treating them as owner upstream).
 */
export async function getAgencyAuthority(userId: string, agencyId: string): Promise<AgencyAuthority> {
  const ownership = await db.agency.findFirst({
    where: { id: agencyId, ownerId: userId },
    select: { id: true },
  })
  if (ownership) {
    return { isOwner: true, role: 'OWNER', staffId: null, permissions: allPermissionsTrue() }
  }

  const staffRow = await db.agencyStaff.findFirst({
    where: { userId, agencyId, isActive: true },
  })
  if (staffRow) {
    const role: AgencyRole = staffRow.role === 'OWNER' ? 'OWNER' : staffRow.role === 'MANAGER' ? 'MANAGER' : 'STAFF'
    const permissions = {} as Record<StaffPermission, boolean>
    for (const key of STAFF_PERMISSION_KEYS) {
      permissions[key] = Boolean((staffRow as Record<string, unknown>)[key])
    }
    return { isOwner: role === 'OWNER', role, staffId: staffRow.id, permissions }
  }

  const none = {} as Record<StaffPermission, boolean>
  for (const key of STAFF_PERMISSION_KEYS) none[key] = false
  return { isOwner: false, role: null, staffId: null, permissions: none }
}

/**
 * Task 37-c: require the caller to hold EVERY listed permission inside an
 * agency. Resolution order:
 *   1. requireAuth (401 when anonymous)
 *   2. SUPER_ADMIN passes (platform admin bypass)
 *   3. Agency owner passes (Agency.ownerId)
 *   4. ACTIVE AgencyStaff row must carry ALL listed permissions
 * On failure: AuthError 403 with a single detectable string:
 *   'PERMISSION_DENIED:<permission>' (first missing permission wins).
 */
export async function requireAgencyAuthority(
  c: Context,
  agencyId: string,
  permission: StaffPermission | StaffPermission[],
): Promise<SessionUser> {
  const user = await requireAuth(c)

  if (user.role === 'SUPER_ADMIN') return user

  const required = Array.isArray(permission) ? permission : [permission]
  const authority = await getAgencyAuthority(user.id, agencyId)

  if (authority.isOwner) return user

  for (const perm of required) {
    if (!authority.permissions[perm]) {
      throw new AuthError(`PERMISSION_DENIED:${perm}`, 403)
    }
  }
  return user
}

/**
 * Requires the authenticated user to have a specific staff permission.
 * Performs a LIVE database lookup to prevent stale JWT privilege escalation.
 *
 * Problem: The JWT payload doesn't include granular boolean permissions.
 * If an admin changes a staff member's permissions, the old JWT would still
 * grant the old permissions. This function queries the DB every time to get
 * the current state of the staff record.
 *
 * Bypasses:
 * - SUPER_ADMIN always passes (no staff record needed)
 * - Agency owners always pass (isOwner check)
 */
export async function requireStaffPermission(
  c: Context,
  agencyId: string,
  permission: StaffPermission
): Promise<SessionUser> {
  const user = await requireAuth(c)

  // Super admins bypass permission checks
  if (user.role === 'SUPER_ADMIN') return user

  // Agency owners bypass permission checks
  const ownership = await verifyAgencyOwnership(user.id, agencyId)
  if (ownership?.isOwner) return user

  // Live DB lookup for staff permissions — prevents stale JWT privilege escalation
  const staffRecord = await db.agencyStaff.findFirst({
    where: { userId: user.id, agencyId, isActive: true },
    select: { [permission]: true },
  })

  if (!staffRecord || !staffRecord[permission]) {
    throw new AuthError(`You do not have the ${permission} permission`, 403)
  }

  return user
}

// ─── Agency Ownership Verification ────────────────────────────────────────

export async function getUserAgencyId(userId: string): Promise<string | null> {
  const ownedAgency = await db.agency.findFirst({
    where: { ownerId: userId },
    // Task 43: WITHOUT an explicit order, SQLite's pick among multiple owned
    // agencies is undefined — login/ownership/sync could each bind a DIFFERENT
    // agency (split-brain: branches visible in webapp, empty on desktop).
    // Deterministic: the OLDEST owned agency wins everywhere.
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (ownedAgency) return ownedAgency.id

  const staffRecord = await db.agencyStaff.findFirst({
    where: { userId, isActive: true },
    select: { agencyId: true },
  })
  return staffRecord?.agencyId ?? null
}

export async function verifyAgencyOwnership(
  userId: string,
  requestedAgencyId?: string | null
): Promise<{ agencyId: string; isOwner: boolean } | null> {
  const ownedAgency = await db.agency.findFirst({
    where: { ownerId: userId },
    // Task 43: same deterministic pick as getUserAgencyId/resolveUserAgencyId.
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (ownedAgency) {
    if (requestedAgencyId && requestedAgencyId !== ownedAgency.id) return null
    return { agencyId: ownedAgency.id, isOwner: true }
  }

  const staffRecord = await db.agencyStaff.findFirst({
    where: { userId, isActive: true },
    select: { agencyId: true },
  })
  if (staffRecord) {
    if (requestedAgencyId && requestedAgencyId !== staffRecord.agencyId) return null
    return { agencyId: staffRecord.agencyId, isOwner: false }
  }

  return null
}

export async function resolveUserAgencyId(user: SessionUser): Promise<string | null> {
  if (user.agencyId) return user.agencyId
  if (user.role === 'SUPER_ADMIN') return null
  const ownedAgency = await db.agency.findFirst({
    where: { ownerId: user.id },
    // Task 43: same deterministic pick as getUserAgencyId/verifyAgencyOwnership.
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (ownedAgency) return ownedAgency.id
  const staffRecord = await db.agencyStaff.findFirst({
    where: { userId: user.id, isActive: true },
    select: { agencyId: true },
  })
  return staffRecord?.agencyId ?? null
}

/**
 * Converts an AuthError (or any error) into a Hono JSON response.
 */
export function authErrorResponse(error: unknown): { success: boolean; error: string; status: number } {
  if (error instanceof AuthError) {
    return { success: false, error: error.message, status: error.statusCode }
  }
  console.error('[AUTH] Unexpected error:', error)
  return { success: false, error: 'Internal server error', status: 500 }
}
