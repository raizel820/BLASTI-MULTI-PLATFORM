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

// ─── Enforcement gate ────────────────────────────────────────────────────────

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

  status.emailRequired = Boolean(user.email) && !user.emailVerified
  status.phoneRequired = Boolean(user.phoneNumber) && !user.phoneVerified
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

  if (opts.email && !opts.emailVerified) {
    out.email = await issueVerification({
      userId: opts.userId,
      purpose: 'EMAIL_VERIFY',
      target: opts.email,
      language: opts.language,
      ip: opts.ip,
    })
  }
  if (opts.phoneNumber && !opts.phoneVerified) {
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
