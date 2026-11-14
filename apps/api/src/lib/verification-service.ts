/**
 * @blasti/api — Verification service (Task 22)
 *
 * Email + phone verification at account creation with OTP codes.
 *
 * Channels:  email → Resend (EMAIL), phone → eSMS Africa (SMS) or
 *            Meta WhatsApp Cloud (WHATSAPP) per ProviderConfig extra.otpChannel.
 *
 * Dev bypass: when NODE_ENV !== 'production' (or VERIFICATION_DEV_BYPASS=true),
 * the hardcoded codes  SMS/WhatsApp → 123456   and   Email → 12345678
 * are ALWAYS accepted without matching a stored row, and the send is
 * simulated when the provider is not configured (dev-simulate).
 *
 * Enforcement model:
 *  - Users created BEFORE VERIFICATION_ENFORCEMENT_START are grandfathered:
 *    at first login they are lazily marked verified (no OTP required).
 *  - Users created on/after the start must verify BOTH email and phone before
 *    a session is issued (login returns requiresVerification + a short-lived
 *    verificationToken instead of a session).
 */

import { createHash, randomInt } from 'crypto'
import { SignJWT, jwtVerify } from 'jose'
import { db } from '@blasti/db'
import { deliverTemplate } from './messaging/template-service'
import { getResolvedConfig } from './messaging/provider-config'
import { sendWhatsAppOtp } from './messaging/whatsapp-service'

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Accounts created before this instant are grandfathered (auto-verified at
 * first login). Override with VERIFICATION_ENFORCEMENT_START (ISO string).
 */
export const VERIFICATION_ENFORCEMENT_START = new Date(
  process.env.VERIFICATION_ENFORCEMENT_START || '2026-09-19T00:00:00.000Z',
)

const CODE_TTL_MINUTES = 10
const RESEND_COOLDOWN_SECONDS = 60
const MAX_PER_HOUR = 6
const MAX_ATTEMPTS = 5

/**
 * Hardcoded dev bypass codes (dev mode ONLY).
 * Round 15: the SMS/WhatsApp code is now SIX digits (123456) so it matches the
 * 6-box OTP input in the verification UI — previously it was 4 digits (1234),
 * which looked wrong next to a 6-digit input cap.
 */
export const DEV_BYPASS_CODES = {
  EMAIL: '12345678',
  SMS: '123456',
  WHATSAPP: '123456',
} as const

function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.VERIFICATION_DEV_BYPASS === 'true'
}

function hashCode(code: string): string {
  return createHash('sha256').update(`blasti-otp:${code}`).digest('hex')
}

// ─── Verification mode (super-admin setting, PlatformSetting row) ───────────

export type VerificationMode = 'none' | 'email' | 'phone' | 'both'
const VERIFICATION_MODE_KEY = 'verification.mode'
const VERIFICATION_MODES: VerificationMode[] = ['none', 'email', 'phone', 'both']

/** Read the platform verification mode (default 'both' = the historical gate). */
export async function getVerificationMode(): Promise<VerificationMode> {
  try {
    const row = await db.platformSetting.findUnique({ where: { key: VERIFICATION_MODE_KEY } })
    const value = row?.value as VerificationMode | undefined
    return value && VERIFICATION_MODES.includes(value) ? value : 'both'
  } catch {
    return 'both'
  }
}

/** Persist the platform verification mode. */
export async function setVerificationMode(mode: VerificationMode): Promise<void> {
  if (!VERIFICATION_MODES.includes(mode)) throw new Error(`INVALID_VERIFICATION_MODE:${mode}`)
  await db.platformSetting.upsert({
    where: { key: VERIFICATION_MODE_KEY },
    create: { key: VERIFICATION_MODE_KEY, value: mode },
    update: { value: mode },
  })
}

/** Which contacts does the mode mandate for a user that has both? */
function modeRequires(mode: VerificationMode): { email: boolean; phone: boolean } {
  return {
    email: mode === 'email' || mode === 'both',
    phone: mode === 'phone' || mode === 'both',
  }
}

/**
 * STRICT-RULE helper — the ONLY contacts eligible for password-reset and
 * auth-critical delivery. Unverified contacts are never returned, no matter
 * the verification mode (self-service verification keeps them verifiable).
 */
export async function getVerifiedContacts(user: {
  id: string
  email: string | null
  phoneNumber: string | null
  emailVerified: boolean
  phoneVerified: boolean
}): Promise<{ email: string | null; phone: string | null }> {
  return {
    email: user.email && user.emailVerified ? user.email : null,
    phone: user.phoneNumber && user.phoneVerified ? user.phoneNumber : null,
  }
}

export interface VerificationStatus {
  required: boolean
  emailRequired: boolean
  phoneRequired: boolean
  emailVerified: boolean
  phoneVerified: boolean
}

interface UserLike {
  id: string
  email: string | null
  phoneNumber: string | null
  emailVerified: boolean
  phoneVerified: boolean
  createdAt: Date
  /** Task 31-A: optional so legacy callers without the field still type-check. */
  role?: string
}

/**
 * Lazily grandfather pre-enforcement users (marks them verified in DB) and
 * report whether this user still needs verification.
 */
export async function resolveVerificationStatus(user: UserLike): Promise<VerificationStatus> {
  const status: VerificationStatus = {
    required: false,
    emailRequired: false,
    phoneRequired: false,
    emailVerified: user.emailVerified,
    phoneVerified: user.phoneVerified,
  }

  // ── Task 31-A: SUPER_ADMIN exemption ────────────────────────────────
  // Platform admins are trusted accounts (created pre-verified) and must
  // never be gated behind email/phone OTP — login returns a session
  // directly. Same shape as "not required".
  if (user.role === 'SUPER_ADMIN') {
    return status
  }

  // Grandfathering: user registered before the enforcement date
  if (user.createdAt < VERIFICATION_ENFORCEMENT_START) {
    if (!user.emailVerified || !user.phoneVerified) {
      await db.user.update({
        where: { id: user.id },
        data: {
          emailVerified: user.email ? user.emailVerified || true : user.emailVerified,
          phoneVerified: user.phoneNumber ? user.phoneVerified || true : user.phoneVerified,
        },
      }).catch(() => undefined)
      status.emailVerified = user.email ? true : user.emailVerified
      status.phoneVerified = user.phoneNumber ? true : user.phoneVerified
    }
    return status
  }

  // Mode-aware gate: the super-admin picks which contacts are mandatory
  // (Platform Settings → Notifications & Providers → Verification & Security).
  const mode = await getVerificationMode()
  if (mode === 'none') return status
  const requires = modeRequires(mode)
  status.emailRequired = requires.email && Boolean(user.email) && !user.emailVerified
  status.phoneRequired = requires.phone && Boolean(user.phoneNumber) && !user.phoneVerified
  status.required = status.emailRequired || status.phoneRequired
  return status
}

// ─── Verification token (short-lived, purpose-scoped) ───────────────────────

const VERIFICATION_TOKEN_TTL = '15m'

function getSecretKey(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET || 'blast1-d3v-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly'
  return new TextEncoder().encode(secret)
}

export async function createVerificationToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, purpose: 'account_verification' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(VERIFICATION_TOKEN_TTL)
    .sign(getSecretKey())
}

export async function verifyVerificationToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ['HS256'] })
    if (payload.purpose !== 'account_verification' || typeof payload.sub !== 'string') return null
    return payload.sub
  } catch {
    return null
  }
}

// ─── Issue ───────────────────────────────────────────────────────────────────

export type VerificationPurpose = 'EMAIL_VERIFY' | 'PHONE_VERIFY'

export interface IssueResult {
  success: boolean
  error?: string
  channel?: 'EMAIL' | 'SMS' | 'WHATSAPP'
  target?: string
  devBypass?: boolean
  devCode?: string
  expiresInMinutes: number
  retryAfterSeconds?: number
}

function generateCode(channel: 'EMAIL' | 'SMS' | 'WHATSAPP'): string {
  // Email codes are longer (typable from a mailbox); SMS codes are 6 digits
  return channel === 'EMAIL'
    ? String(randomInt(0, 100_000_000)).padStart(8, '0')
    : String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Generate an OTP, persist it (hashed) and deliver it through the channel's
 * configured provider. Previously issued unconsumed codes for the same
 * purpose are invalidated. Rate limits: 60s resend cooldown, 6/hour.
 */
export async function issueVerification(opts: {
  userId: string
  purpose: VerificationPurpose
  target: string
  language?: string
  ip?: string
}): Promise<IssueResult> {
  const isEmailPurpose = opts.purpose === 'EMAIL_VERIFY'

  // ── Rate limits ──
  const recent = await db.verificationCode.findMany({
    where: { userId: opts.userId, purpose: opts.purpose, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (recent.length >= MAX_PER_HOUR) {
    return {
      success: false, error: 'TOO_MANY_ATTEMPTS', expiresInMinutes: CODE_TTL_MINUTES,
      // Dev bypass codes work regardless of pending rows — keep the hint visible
      ...(isDevMode() ? { devBypass: true, devCode: opts.purpose === 'EMAIL_VERIFY' ? DEV_BYPASS_CODES.EMAIL : DEV_BYPASS_CODES.SMS } : {}),
    }
  }
  if (recent[0]) {
    const elapsed = (Date.now() - recent[0].createdAt.getTime()) / 1000
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return {
        success: false,
        error: 'RESEND_COOLDOWN',
        expiresInMinutes: CODE_TTL_MINUTES,
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed),
        // The previously issued codes are still valid; in dev the bypass
        // codes are ALWAYS accepted, so keep the hint available
        ...(isDevMode() ? { devBypass: true, devCode: opts.purpose === 'EMAIL_VERIFY' ? DEV_BYPASS_CODES.EMAIL : DEV_BYPASS_CODES.SMS } : {}),
      }
    }
  }

  // ── Channel selection ──
  let channel: 'EMAIL' | 'SMS' | 'WHATSAPP'
  if (isEmailPurpose) {
    channel = 'EMAIL'
  } else {
    const smsCfg = await getResolvedConfig('SMS')
    const waCfg = await getResolvedConfig('WHATSAPP')
    const preference = waCfg.extra.otpChannel || 'SMS'
    channel = preference === 'WHATSAPP' ? 'WHATSAPP' : 'SMS'
    // Prefer a channel that is actually configured; WhatsApp OTP needs an approved template
    if (channel === 'WHATSAPP' && !(waCfg.enabled && waCfg.apiKey && waCfg.phoneNumberId && waCfg.extra.otpTemplateName)) {
      channel = 'SMS'
    }
    if (channel === 'SMS' && !(smsCfg.enabled && smsCfg.apiKey) && waCfg.enabled && waCfg.apiKey && waCfg.phoneNumberId && waCfg.extra.otpTemplateName) {
      channel = 'WHATSAPP'
    }
  }

  // ── Invalidate previous codes for this purpose ──
  await db.verificationCode.updateMany({
    where: { userId: opts.userId, purpose: opts.purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  // ── Generate + persist ──
  const code = generateCode(channel)
  await db.verificationCode.create({
    data: {
      userId: opts.userId,
      purpose: opts.purpose,
      channel,
      target: opts.target,
      codeHash: hashCode(code),
      maxAttempts: MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
      requestIp: opts.ip ?? null,
    },
  })

  // ── Deliver ──
  const user = await db.user.findUnique({ where: { id: opts.userId }, select: { fullName: true, language: true } })
  const language = opts.language || user?.language || 'en'
  const vars = {
    fullName: user?.fullName ?? '',
    code,
    expiryMinutes: CODE_TTL_MINUTES,
  }

  let sent = false
  let sendError: string | undefined

  if (channel === 'EMAIL') {
    const r = await deliverTemplate({ key: 'verify_email', channel: 'EMAIL', target: opts.target, language, vars })
    sent = r.success
    sendError = r.error
  } else if (channel === 'WHATSAPP') {
    // Use the approved authentication template when selected (extra.otpTemplateName)
    const waCfg = await getResolvedConfig('WHATSAPP')
    const tpl = waCfg.extra.otpTemplateName
    if (tpl) {
      const r = await sendWhatsAppOtp({ phoneNumber: opts.target, code, templateName: tpl, languageCode: waCfg.extra.otpTemplateLang })
      if (!r.success && r.fallbackToSms) {
        const fb = await deliverTemplate({ key: 'verify_phone', channel: 'SMS', target: opts.target, language, vars })
        channel = 'SMS'
        sent = fb.success
        sendError = fb.error
      } else {
        sent = r.success
        sendError = r.error
      }
    } else {
      const r = await deliverTemplate({ key: 'verify_phone', channel: 'WHATSAPP', target: opts.target, language, vars })
      sent = r.success
      sendError = r.error
    }
  } else {
    const r = await deliverTemplate({ key: 'verify_phone', channel: 'SMS', target: opts.target, language, vars })
    sent = r.success
    sendError = r.error
  }

  if (!sent && !isDevMode()) {
    console.error(`[verification] Failed to deliver ${opts.purpose} to ${opts.target}: ${sendError}`)
    return { success: false, error: sendError || 'DELIVERY_FAILED', channel, expiresInMinutes: CODE_TTL_MINUTES }
  }

  return {
    success: true,
    channel,
    target: opts.target,
    expiresInMinutes: CODE_TTL_MINUTES,
    ...(isDevMode() ? { devBypass: true, devCode: DEV_BYPASS_CODES[channel] } : {}),
  }
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export interface VerifyResult {
  success: boolean
  error?: string
  remainingAttempts?: number
  expired?: boolean
  status?: VerificationStatus
}

/**
 * Check an OTP for a purpose. In dev mode the hardcoded bypass codes are
 * accepted even without a stored row. On success the matching flag
 * (emailVerified / phoneVerified) is set on the user.
 */
export async function verifyCode(opts: {
  userId: string
  purpose: VerificationPurpose
  code: string
}): Promise<VerifyResult> {
  const code = opts.code.trim()
  const isEmailPurpose = opts.purpose === 'EMAIL_VERIFY'
  const user = await db.user.findUnique({
    where: { id: opts.userId },
    select: { id: true, email: true, phoneNumber: true, emailVerified: true, phoneVerified: true, createdAt: true },
  })
  if (!user) return { success: false, error: 'USER_NOT_FOUND' }

  // ── Dev bypass (accepted even with no stored row) ──
  if (isDevMode()) {
    const bypassMatch = isEmailPurpose
      ? code === DEV_BYPASS_CODES.EMAIL
      : code === DEV_BYPASS_CODES.SMS || code === DEV_BYPASS_CODES.WHATSAPP
    if (bypassMatch) {
      const status = await applyVerification(user, opts.purpose)
      return { success: true, status }
    }
  }

  // ── Row lookup ──
  const record = await db.verificationCode.findFirst({
    where: { userId: opts.userId, purpose: opts.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!record) {
    return { success: false, error: 'NO_PENDING_CODE' }
  }
  if (record.expiresAt.getTime() < Date.now()) {
    return { success: false, error: 'CODE_EXPIRED', expired: true }
  }
  if (record.attempts >= record.maxAttempts) {
    return { success: false, error: 'TOO_MANY_ATTEMPTS', remainingAttempts: 0 }
  }

  if (record.codeHash !== hashCode(code)) {
    const updated = await db.verificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true, maxAttempts: true },
    })
    return {
      success: false,
      error: 'INVALID_CODE',
      remainingAttempts: Math.max(0, updated.maxAttempts - updated.attempts),
    }
  }

  await db.verificationCode.update({
    where: { id: record.id },
    data: { consumedAt: new Date() },
  })
  const status = await applyVerification(user, opts.purpose)
  return { success: true, status }
}

async function applyVerification(
  user: UserLike,
  purpose: VerificationPurpose,
): Promise<VerificationStatus> {
  const data = purpose === 'EMAIL_VERIFY' ? { emailVerified: true } : { phoneVerified: true }
  await db.user.update({ where: { id: user.id }, data })
  const updated = { ...user, ...data } as UserLike
  const status = await resolveVerificationStatus(updated).catch(() => ({
    required: false,
    emailRequired: false,
    phoneRequired: false,
    emailVerified: updated.emailVerified,
    phoneVerified: updated.phoneVerified,
  }) as VerificationStatus)
  return status
}

/**
 * After register/login with pending verification: issue OTPs for every
 * unverified channel. Returns per-channel results for the API response.
 */
export async function issueAllPending(opts: {
  userId: string
  email: string | null
  phoneNumber: string | null
  emailVerified: boolean
  phoneVerified: boolean
  language?: string
  ip?: string
}): Promise<{ email?: IssueResult; phone?: IssueResult }> {
  const out: { email?: IssueResult; phone?: IssueResult } = {}

  // Mode-aware: only channels the platform mode MANDATES get OTPs
  // (mode 'none' → nothing; 'email' → email only; 'phone' → phone only).
  const user = await db.user.findUnique({
    where: { id: opts.userId },
    select: { id: true, email: true, phoneNumber: true, emailVerified: true, phoneVerified: true, createdAt: true, role: true },
  })
  const status = user ? await resolveVerificationStatus(user).catch(() => null) : null
  const emailMandated = status ? status.emailRequired : Boolean(opts.email) && !opts.emailVerified
  const phoneMandated = status ? status.phoneRequired : Boolean(opts.phoneNumber) && !opts.phoneVerified

  if (opts.email && !opts.emailVerified && emailMandated) {
    out.email = await issueVerification({
      userId: opts.userId,
      purpose: 'EMAIL_VERIFY',
      target: opts.email,
      language: opts.language,
      ip: opts.ip,
    })
  }
  if (opts.phoneNumber && !opts.phoneVerified && phoneMandated) {
    out.phone = await issueVerification({
      userId: opts.userId,
      purpose: 'PHONE_VERIFY',
      target: opts.phoneNumber,
      language: opts.language,
      ip: opts.ip,
    })
  }
  return out
}

/**
 * Shared phone-OTP channel decision: SMS by default, WhatsApp when the
 * provider config selects an approved template (with the SMS fallback
 * checked by the caller after a failed template send).
 */
export async function resolvePhoneChannel(): Promise<'SMS' | 'WHATSAPP'> {
  const smsCfg = await getResolvedConfig('SMS')
  const waCfg = await getResolvedConfig('WHATSAPP')
  const preference = waCfg.extra.otpChannel || 'SMS'
  let channel: 'SMS' | 'WHATSAPP' = preference === 'WHATSAPP' ? 'WHATSAPP' : 'SMS'
  // Prefer a channel that is actually configured; WhatsApp OTP needs an approved template
  if (channel === 'WHATSAPP' && !(waCfg.enabled && waCfg.apiKey && waCfg.phoneNumberId && waCfg.extra.otpTemplateName)) {
    channel = 'SMS'
  }
  if (channel === 'SMS' && !(smsCfg.enabled && smsCfg.apiKey) && waCfg.enabled && waCfg.apiKey && waCfg.phoneNumberId && waCfg.extra.otpTemplateName) {
    channel = 'WHATSAPP'
  }
  return channel
}

// ─── Pending-registration (0.6.54) ───────────────────────────────────────────
//
// The signup payload is STAGED in PendingRegistration (NO User row) and OTPs
// are issued against that staged row. The User account is created ONLY when
// every mandated channel verifies — so a user can freely go back and fix a
// typo (e.g. a wrong email) at any earlier step without creating orphan
// accounts or locking identifiers. Reuses the same code shape/policy as the
// post-registration VerificationCode flow (hashed codes, TTL, attempts,
// 60s resend cooldown, 6/hour, dev bypass codes).

/**
 * How long a PENDING signup row may keep holding its UNIQUE
 * email/username/phone after its last touch.
 *
 * 0.6.72 — 24h → 2h. The staged-signup token (PENDING_TOKEN_TTL) lives ONE
 * hour: a row untouched for longer can NEVER complete verification (its
 * token is expired; the client must restart the signup, which mints a fresh
 * row). Such a row is dead by construction, and keeping it a full day meant
 * a leaked/abandoned row blocked its identity for 24h — the field incident:
 * a pending row that outlived its account kept answering 'Email already
 * registered' after the account was deleted from the admin. One hour of
 * token life + one hour of margin; nothing that can still verify is purged.
 */
export const PENDING_REGISTRATION_TTL_HOURS = 2

const PENDING_TOKEN_TTL = '1h'

export async function createPendingRegistrationToken(pendingId: string): Promise<string> {
  return new SignJWT({ sub: pendingId, purpose: 'pending_registration' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(PENDING_TOKEN_TTL)
    .sign(getSecretKey())
}

/** Resolves a pending-registration JWT → the PendingRegistration row id. */
export async function verifyPendingRegistrationToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ['HS256'] })
    if (payload.purpose !== 'pending_registration' || typeof payload.sub !== 'string') return null
    return payload.sub
  } catch {
    return null
  }
}

/** Frees usernames/emails/phones held by signups abandoned for over TTL. */
export async function purgeStalePendingRegistrations(): Promise<void> {
  try {
    await db.pendingRegistration.deleteMany({
      where: { updatedAt: { lt: new Date(Date.now() - PENDING_REGISTRATION_TTL_HOURS * 60 * 60 * 1000) } },
    })
  } catch { /* best-effort cleanup — never blocks a registration */ }
}

/** Which channels does the platform mode mandate for a PENDING signup? */
export function pendingModeRequires(
  mode: VerificationMode,
  hasEmail: boolean,
  hasPhone: boolean,
): { email: boolean; phone: boolean } {
  const requires = modeRequires(mode)
  return {
    email: requires.email && hasEmail,
    phone: requires.phone && hasPhone,
  }
}

/**
 * Issue an OTP for a pending registration channel. Same rate limits as the
 * registered-user flow (60s cooldown / 6 per hour — scoped to the pending
 * row + purpose). The cooldown is skipped when the TARGET changed (edited
 * contact) so going back to fix a typo never gets stuck behind a timer.
 */
export async function issuePendingRegistrationOtp(opts: {
  pendingId: string
  purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY'
  target: string
  fullName: string
  language?: string
  ip?: string
  /** When true (target changed since the last issue) the resend cooldown is skipped. */
  targetChanged?: boolean
}): Promise<IssueResult> {
  const isEmailPurpose = opts.purpose === 'EMAIL_VERIFY'
  const since = new Date(Date.now() - 60 * 60 * 1000)
  const recent = await db.pendingRegistrationCode.findMany({
    where: { pendingRegistrationId: opts.pendingId, purpose: opts.purpose, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, target: true },
  })
  if (recent.length >= MAX_PER_HOUR) {
    return {
      success: false, error: 'TOO_MANY_ATTEMPTS', expiresInMinutes: CODE_TTL_MINUTES,
      ...(isDevMode() ? { devBypass: true, devCode: isEmailPurpose ? DEV_BYPASS_CODES.EMAIL : DEV_BYPASS_CODES.SMS } : {}),
    }
  }
  if (!opts.targetChanged && recent[0]) {
    const elapsed = (Date.now() - recent[0].createdAt.getTime()) / 1000
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return {
        success: false,
        error: 'RESEND_COOLDOWN',
        expiresInMinutes: CODE_TTL_MINUTES,
        retryAfterSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed),
        ...(isDevMode() ? { devBypass: true, devCode: isEmailPurpose ? DEV_BYPASS_CODES.EMAIL : DEV_BYPASS_CODES.SMS } : {}),
      }
    }
  }

  // ── Channel selection (shared with the registered-user flow) ──
  const channel = isEmailPurpose ? 'EMAIL' as const : await resolvePhoneChannel()

  // ── Invalidate previous codes for this purpose (old target included) ──
  await db.pendingRegistrationCode.updateMany({
    where: { pendingRegistrationId: opts.pendingId, purpose: opts.purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  const code = generateCode(channel)
  await db.pendingRegistrationCode.create({
    data: {
      pendingRegistrationId: opts.pendingId,
      purpose: opts.purpose,
      channel,
      target: opts.target,
      codeHash: hashCode(code),
      maxAttempts: MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000),
      requestIp: opts.ip ?? null,
    },
  })

  const language = opts.language || 'en'
  const vars = {
    fullName: opts.fullName,
    code,
    expiryMinutes: CODE_TTL_MINUTES,
  }

  let sent = false
  let sendError: string | undefined
  let usedChannel = channel

  if (channel === 'EMAIL') {
    const r = await deliverTemplate({ key: 'verify_email', channel: 'EMAIL', target: opts.target, language, vars })
    sent = r.success
    sendError = r.error
  } else if (channel === 'WHATSAPP') {
    const waCfg = await getResolvedConfig('WHATSAPP')
    const tpl = waCfg.extra.otpTemplateName
    if (tpl) {
      const r = await sendWhatsAppOtp({ phoneNumber: opts.target, code, templateName: tpl, languageCode: waCfg.extra.otpTemplateLang })
      if (!r.success && r.fallbackToSms) {
        const fb = await deliverTemplate({ key: 'verify_phone', channel: 'SMS', target: opts.target, language, vars })
        usedChannel = 'SMS'
        sent = fb.success
        sendError = fb.error
      } else {
        sent = r.success
        sendError = r.error
      }
    } else {
      const r = await deliverTemplate({ key: 'verify_phone', channel: 'WHATSAPP', target: opts.target, language, vars })
      sent = r.success
      sendError = r.error
    }
  } else {
    const r = await deliverTemplate({ key: 'verify_phone', channel: 'SMS', target: opts.target, language, vars })
    sent = r.success
    sendError = r.error
  }

  if (!sent && !isDevMode()) {
    console.error(`[verification] Failed to deliver pending ${opts.purpose} to ${opts.target}: ${sendError}`)
    return { success: false, error: sendError || 'DELIVERY_FAILED', channel: usedChannel, expiresInMinutes: CODE_TTL_MINUTES }
  }

  return {
    success: true,
    channel: usedChannel,
    target: opts.target,
    expiresInMinutes: CODE_TTL_MINUTES,
    ...(isDevMode() ? { devBypass: true, devCode: DEV_BYPASS_CODES[usedChannel] } : {}),
  }
}

/**
 * Check an OTP against the PENDING registration codes (no User row exists
 * yet). Dev bypass codes accepted like the registered flow. On success the
 * pending row's per-channel flag is set.
 */
export async function verifyPendingRegistrationOtp(opts: {
  pendingId: string
  purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY'
  code: string
}): Promise<{ success: boolean; error?: string; remainingAttempts?: number; expired?: boolean }> {
  const code = opts.code.trim()
  const isEmailPurpose = opts.purpose === 'EMAIL_VERIFY'

  // ── Dev bypass (accepted even with no stored row) ──
  if (isDevMode()) {
    const bypassMatch = isEmailPurpose
      ? code === DEV_BYPASS_CODES.EMAIL
      : code === DEV_BYPASS_CODES.SMS || code === DEV_BYPASS_CODES.WHATSAPP
    if (bypassMatch) {
      await db.pendingRegistration.update({
        where: { id: opts.pendingId },
        data: isEmailPurpose ? { emailVerified: true } : { phoneVerified: true },
      }).catch(() => undefined)
      return { success: true }
    }
  }

  const record = await db.pendingRegistrationCode.findFirst({
    where: { pendingRegistrationId: opts.pendingId, purpose: opts.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!record) return { success: false, error: 'NO_PENDING_CODE' }
  if (record.expiresAt.getTime() < Date.now()) return { success: false, error: 'CODE_EXPIRED', expired: true }
  if (record.attempts >= record.maxAttempts) {
    return { success: false, error: 'TOO_MANY_ATTEMPTS', remainingAttempts: 0 }
  }
  if (record.codeHash !== hashCode(code)) {
    const updated = await db.pendingRegistrationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true, maxAttempts: true },
    })
    return {
      success: false,
      error: 'INVALID_CODE',
      remainingAttempts: Math.max(0, updated.maxAttempts - updated.attempts),
    }
  }

  await db.pendingRegistrationCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } })
  await db.pendingRegistration.update({
    where: { id: opts.pendingId },
    data: isEmailPurpose ? { emailVerified: true } : { phoneVerified: true },
  }).catch(() => undefined)
  return { success: true }
}

/**
 * Mask an email/phone for display (a***@d***.com / +213**1234567)
 */
export function maskTarget(target: string): string {
  if (target.includes('@')) {
    const [local, domain] = target.split('@')
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`
  }
  if (target.length > 6) return `${target.slice(0, 5)}${'*'.repeat(target.length - 8)}${target.slice(-3)}`
  return target
}
