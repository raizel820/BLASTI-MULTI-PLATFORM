'use client'

/**
 * Shared email+phone OTP verification step (Task 22-b).
 *
 * Rendered by `register-form.tsx`, `login-form.tsx` and
 * `desktop-agency-login.tsx` whenever the auth API responds with
 * `requiresVerification: true` + a short-lived `verificationToken`
 * (Task 22 backend contract).
 *
 * Responsibilities (frontend-only):
 *  - Two OTP blocks built on the shadcn input-otp component
 *    (email = 8 digits, phone = 6 digits — Round 15 made the dev bypass
 *    SMS code SIX digits, 123456, so the input cap and the code match).
 *  - A single "Verify" button submits both codes at once; the failing
 *    channel from the API response gets the inline error + shake.
 *  - Partial success (one channel verified) is tracked locally so the
 *    verified code is never re-submitted (a consumed code would return
 *    NO_PENDING_CODE) and the block collapses into a green chip.
 *  - Per-channel resend buttons with a countdown that respects the
 *    server's `retryAfterSeconds` (RESEND_COOLDOWN).
 *  - Dev hint chip with the hardcoded bypass codes when present.
 *  - VERIFICATION_TOKEN_INVALID → onTokenInvalid() (host returns to its
 *    own login/register view with a clear message).
 *
 * Session bootstrap is NOT done here — the host form owns it through the
 * `onVerified` callback so each form reuses its exact existing
 * login/register success path (Electron parity, navigation, toasts).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from '@/components/ui/input-otp'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { Button } from '@/components/ui/button'
import {
  ShieldCheck, Mail, Smartphone, RefreshCw, Loader2, AlertCircle,
  Info, CheckCircle2, ArrowLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'

// ─── Types (mirrors the Task 22 API contracts) ──────────────────────────────

export interface VerificationPending {
  email: boolean
  phone: boolean
}

export interface VerificationTargets {
  email?: string | null
  phone?: string | null
}

export interface VerificationDevChannel {
  devCode?: string
  error?: string
}

export interface VerificationDev {
  email?: VerificationDevChannel | null
  phone?: VerificationDevChannel | null
}

export interface VerificationSuccessUser {
  id: string
  username: string
  fullName: string
  role: string
  language?: string
  avatarUrl?: string | null
  agencyId?: string | null
  email?: string | null
  phoneNumber?: string | null
}

export interface VerificationSuccess {
  token: string
  user: VerificationSuccessUser
  status?: { emailVerified: boolean; phoneVerified: boolean }
}

export type VerificationChannel = 'email' | 'phone'

interface VerificationStepProps {
  verificationToken: string
  pending: VerificationPending
  targets?: VerificationTargets | null
  dev?: VerificationDev | null
  /** Host language — 'fr' falls back to the EN copy. */
  lang: 'ar' | 'fr' | 'en'
  onVerified: (result: VerificationSuccess) => void
  /** Called when the API answers VERIFICATION_TOKEN_INVALID (token expired). */
  onTokenInvalid?: () => void
  /** Optional manual back (host decides what "back" means). */
  onBack?: () => void
}

// ─── Local bilingual copy (i18n dictionaries are intentionally untouched) ───

const COPY = {
  ar: {
    title: 'تأكيد حسابك',
    subtitle: 'أدخل رمز التحقق المرسل إلى بريدك الإلكتروني وهاتفك',
    emailLabel: 'رمز البريد الإلكتروني',
    phoneLabel: 'رمز الهاتف',
    sentTo: 'أُرسل إلى',
    verifyButton: 'تأكيد الحساب',
    verifying: 'جارٍ التحقق...',
    resend: 'إعادة إرسال الرمز',
    resending: 'جارٍ الإرسال...',
    resendIn: 'إعادة الإرسال بعد {seconds} ث',
    resent: 'تم إرسال رمز جديد',
    resendFailed: 'تعذّر إعادة إرسال الرمز',
    verifiedChip: 'تم التحقق',
    partialDone: 'تم التحقق من {channel} — بقي رمز آخر',
    channelEmail: 'البريد الإلكتروني',
    channelPhone: 'الهاتف',
    devChipPrefix: 'وضع التطوير',
    devChipEmail: 'رمز البريد',
    devChipPhone: 'رمز الهاتف',
    back: 'رجوع',
    errors: {
      INVALID_CODE: 'الرمز غير صحيح{attempts}',
      CODE_EXPIRED: 'انتهت صلاحية الرمز — أعد إرسال رمز جديد',
      TOO_MANY_ATTEMPTS: 'تجاوزت عدد المحاولات — أعد إرسال رمز جديد',
      NO_PENDING_CODE: 'لا يوجد رمز فعّال — أعد إرسال رمز جديد',
      RESEND_COOLDOWN: 'انتظر {seconds} ثانية قبل إعادة الإرسال',
      ALREADY_VERIFIED: 'تم التحقق من هذا الحساب مسبقاً',
      INCOMPLETE: 'أدخل الرمز كاملاً',
      GENERIC: 'حدث خطأ — حاول مجدداً',
    },
    remainingAttempts: ' · محاولات متبقية: {n}',
    tokenInvalid: 'انتهت صلاحية جلسة التحقق. نرجو إعادة المحاولة.',
  },
  en: {
    title: 'Verify your account',
    subtitle: 'Enter the codes we sent to your email address and phone',
    emailLabel: 'Email code',
    phoneLabel: 'SMS code',
    sentTo: 'Sent to',
    verifyButton: 'Verify account',
    verifying: 'Verifying...',
    resend: 'Resend code',
    resending: 'Sending...',
    resendIn: 'Resend in {seconds}s',
    resent: 'A new code has been sent',
    resendFailed: 'Could not resend the code',
    verifiedChip: 'Verified',
    partialDone: '{channel} verified — one code remaining',
    channelEmail: 'Email',
    channelPhone: 'Phone',
    devChipPrefix: 'Dev mode',
    devChipEmail: 'Email code',
    devChipPhone: 'SMS code',
    back: 'Back',
    errors: {
      INVALID_CODE: 'Invalid code{attempts}',
      CODE_EXPIRED: 'This code has expired — please resend a new one',
      TOO_MANY_ATTEMPTS: 'Too many attempts — please resend a new code',
      NO_PENDING_CODE: 'No active code — please resend a new one',
      RESEND_COOLDOWN: 'Wait {seconds}s before resending',
      ALREADY_VERIFIED: 'This account is already verified',
      INCOMPLETE: 'Enter the full code',
      GENERIC: 'Something went wrong — please try again',
    },
    remainingAttempts: ' · {n} attempts left',
    tokenInvalid: 'Your verification session has expired. Please try again.',
  },
} as const

type Copy = (typeof COPY)['en']

function getCopy(lang: 'ar' | 'fr' | 'en'): Copy {
  return lang === 'ar' ? (COPY.ar as unknown as Copy) : (COPY.en as Copy)
}

/** Tiny {placeholder} interpolation for the local copy strings. */
function fmt(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : '',
  )
}

function verificationErrorMessage(
  c: Copy,
  code: string | undefined,
  params: { attempts?: number; seconds?: number } = {},
): string {
  const map = c.errors as Record<string, string>
  const template = (code && map[code]) || map.GENERIC
  return fmt(template, {
    attempts: params.attempts !== undefined ? fmt(c.remainingAttempts, { n: params.attempts }) : '',
    seconds: params.seconds ?? '',
  })
}

// ─── Component ──────────────────────────────────────────────────────────────

const EMAIL_CODE_LENGTH = 8
const PHONE_CODE_LENGTH = 6
// Round 15: the dev bypass SMS code is now 6 digits (123456) — it fills the
// six input boxes exactly like a real code, so no 4-digit exception exists
// anymore.
const RESEND_DEFAULT_COOLDOWN = 60

export function VerificationStep({
  verificationToken,
  pending,
  targets,
  dev,
  lang,
  onVerified,
  onTokenInvalid,
  onBack,
}: VerificationStepProps) {
  const c = getCopy(lang)
  const dir = lang === 'ar' ? 'rtl' : 'ltr'

  const isEmailPending = !!pending.email
  const isPhonePending = !!pending.phone

  // Code inputs
  const [emailCode, setEmailCode] = useState('')
  const [phoneCode, setPhoneCode] = useState('')

  // Channels already verified (locally tracked after partial success so the
  // consumed code is never re-submitted)
  const [verifiedChannels, setVerifiedChannels] = useState<{ email: boolean; phone: boolean }>({
    email: false,
    phone: false,
  })

  // Error shown inline under a channel block (+ shake animation on that block)
  const [channelError, setChannelError] = useState<{ channel: VerificationChannel; message: string } | null>(null)
  const [shakeChannel, setShakeChannel] = useState<VerificationChannel | null>(null)

  const [verifying, setVerifying] = useState(false)
  const [resendingChannel, setResendingChannel] = useState<VerificationChannel | null>(null)

  // Resend cooldown countdown per channel (ticks once per second)
  const [countdown, setCountdown] = useState<{ email: number; phone: number }>({ email: 0, phone: 0 })
  useEffect(() => {
    const id = setInterval(() => {
      setCountdown((prev) =>
        prev.email > 0 || prev.phone > 0
          ? { email: Math.max(0, prev.email - 1), phone: Math.max(0, prev.phone - 1) }
          : prev,
      )
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Dev bypass codes (initial from the auth response, updated on resend)
  const [devCodes, setDevCodes] = useState<{ email?: string; phone?: string }>(() => ({
    email: dev?.email?.devCode || undefined,
    phone: dev?.phone?.devCode || undefined,
  }))

  const timersRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timersRef.current) clearTimeout(timersRef.current) }, [])

  const triggerShake = useCallback((channel: VerificationChannel) => {
    setShakeChannel(channel)
    if (timersRef.current) clearTimeout(timersRef.current)
    timersRef.current = setTimeout(() => setShakeChannel(null), 600)
  }, [])

  const markVerified = useCallback((channel: VerificationChannel) => {
    setVerifiedChannels((prev) => ({ ...prev, [channel]: true }))
    if (channel === 'email') setEmailCode('')
    else setPhoneCode('')
  }, [])

  const clearChannelError = useCallback((channel: VerificationChannel) => {
    setChannelError((prev) => (prev && prev.channel === channel ? null : prev))
  }, [])

  // ── Verify (single button submits both codes) ────────────────────────────
  const handleVerify = async () => {
    if (verifying) return

    const submitEmail = isEmailPending && !verifiedChannels.email
    const submitPhone = isPhonePending && !verifiedChannels.phone

    // Client-side completeness validation (email = 8 digits, phone = 6)
    if (submitEmail && emailCode.length !== EMAIL_CODE_LENGTH) {
      setChannelError({ channel: 'email', message: verificationErrorMessage(c, 'INCOMPLETE') })
      triggerShake('email')
      return
    }
    if (submitPhone && phoneCode.length !== PHONE_CODE_LENGTH) {
      setChannelError({ channel: 'phone', message: verificationErrorMessage(c, 'INCOMPLETE') })
      triggerShake('phone')
      return
    }
    if (!submitEmail && !submitPhone) return

    setVerifying(true)
    setChannelError(null)
    try {
      const res = await apiFetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          verificationToken,
          ...(submitEmail ? { emailCode } : {}),
          ...(submitPhone ? { phoneCode } : {}),
        }),
      })
      const data = await res.json()

      if (res.ok && data.verified && data.token) {
        // Full success — the host form runs its own session bootstrap.
        onVerified({ token: data.token, user: data.user, status: data.status })
        return
      }

      if (res.ok) {
        // Partial success (verified:false) — one channel done, one pending.
        const status = data.status as { emailVerified?: boolean; phoneVerified?: boolean } | undefined
        let partialChannel: VerificationChannel | null = null
        if (status?.emailVerified && isEmailPending) { markVerified('email'); partialChannel = 'email' }
        if (status?.phoneVerified && isPhonePending) { markVerified('phone'); partialChannel = 'phone' }
        if (partialChannel) {
          toast.success(
            fmt(c.partialDone, {
              channel: partialChannel === 'email' ? c.channelEmail : c.channelPhone,
            }),
          )
        } else {
          toast.error(verificationErrorMessage(c, data.error))
        }
        return
      }

      // ── Error response ──
      if (data.error === 'VERIFICATION_TOKEN_INVALID') {
        toast.error(c.tokenInvalid)
        onTokenInvalid?.()
        return
      }

      // Another channel may have succeeded before the failing one —
      // the verify route echoes per-channel results on 400.
      const results = (data.results ?? {}) as Record<string, { success?: boolean } | undefined>
      if (results.email?.success) markVerified('email')
      if (results.phone?.success) markVerified('phone')

      const channel: VerificationChannel = data.channel === 'phone' ? 'phone' : 'email'
      const message = verificationErrorMessage(c, data.error, { attempts: data.remainingAttempts })
      setChannelError({ channel, message })
      triggerShake(channel)
      toast.error(message)

      // Expired / exhausted codes must be resent — clear the stale input.
      if (data.error === 'CODE_EXPIRED' || data.error === 'TOO_MANY_ATTEMPTS' || data.error === 'NO_PENDING_CODE') {
        if (channel === 'email') setEmailCode('')
        else setPhoneCode('')
      }
    } catch {
      toast.error(verificationErrorMessage(c, 'GENERIC'))
    } finally {
      setVerifying(false)
    }
  }

  // ── Resend one channel ───────────────────────────────────────────────────
  const handleResend = async (channel: VerificationChannel) => {
    if (resendingChannel || countdown[channel] > 0) return
    setResendingChannel(channel)
    setChannelError((prev) => (prev && prev.channel === channel ? null : prev))
    try {
      const res = await apiFetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ verificationToken, channel }),
      })
      const data = await res.json()

      if (res.ok && data.success) {
        setCountdown((prev) => ({ ...prev, [channel]: data.retryAfterSeconds ?? RESEND_DEFAULT_COOLDOWN }))
        if (data.devBypass && data.devCode) {
          setDevCodes((prev) => ({ ...prev, [channel]: data.devCode }))
        }
        toast.success(c.resent)
        return
      }

      if (data.error === 'RESEND_COOLDOWN') {
        const seconds = data.retryAfterSeconds ?? RESEND_DEFAULT_COOLDOWN
        setCountdown((prev) => ({ ...prev, [channel]: seconds }))
        setChannelError({ channel, message: verificationErrorMessage(c, 'RESEND_COOLDOWN', { seconds }) })
        return
      }
      if (data.error === 'ALREADY_VERIFIED') {
        markVerified(channel)
        toast.info(verificationErrorMessage(c, 'ALREADY_VERIFIED'))
        return
      }
      if (data.error === 'VERIFICATION_TOKEN_INVALID') {
        toast.error(c.tokenInvalid)
        onTokenInvalid?.()
        return
      }
      // TOO_MANY_ATTEMPTS or delivery failure
      setChannelError({ channel, message: verificationErrorMessage(c, data.error) })
      triggerShake(channel)
      toast.error(verificationErrorMessage(c, data.error))
    } catch {
      toast.error(c.resendFailed)
    } finally {
      setResendingChannel(null)
    }
  }

  const canVerify =
    !verifying &&
    (isEmailPending && !verifiedChannels.email
      ? emailCode.length === EMAIL_CODE_LENGTH
      : true) &&
    (isPhonePending && !verifiedChannels.phone
      ? phoneCode.length === PHONE_CODE_LENGTH
      : true) &&
    ((isEmailPending && !verifiedChannels.email) || (isPhonePending && !verifiedChannels.phone))

  // ── Building blocks ──────────────────────────────────────────────────────

  const devChipItems: string[] = []
  if (isEmailPending && !verifiedChannels.email && devCodes.email) {
    devChipItems.push(`${c.devChipEmail}: ${devCodes.email}`)
  }
  if (isPhonePending && !verifiedChannels.phone && devCodes.phone) {
    devChipItems.push(`${c.devChipPhone}: ${devCodes.phone}`)
  }

  const renderChannelBlock = (channel: VerificationChannel) => {
    const isEmail = channel === 'email'
    const done = verifiedChannels[channel]
    const label = isEmail ? c.emailLabel : c.phoneLabel
    const target = isEmail ? targets?.email : targets?.phone
    const Icon = isEmail ? Mail : Smartphone
    const code = isEmail ? emailCode : phoneCode
    const setCode = isEmail ? setEmailCode : setPhoneCode
    const maxLength = isEmail ? EMAIL_CODE_LENGTH : PHONE_CODE_LENGTH
    const error = channelError?.channel === channel ? channelError.message : null
    const shake = shakeChannel === channel
    const countdownValue = countdown[channel]
    const resending = resendingChannel === channel

    return (
      <div
        key={channel}
        className={`rounded-2xl border p-4 transition-colors duration-300 ${
          done
            ? 'border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/20'
            : error
              ? 'border-red-300 dark:border-red-800/70 bg-red-50/50 dark:bg-red-950/20'
              : 'border-gray-200 dark:border-gray-700/70 bg-gray-50/60 dark:bg-gray-800/40'
        } ${shake ? 'animate-[vshake_0.5s_ease-in-out]' : ''}`}
      >
        {/* Block header: icon + label + masked target */}
        <div className="mb-3 flex items-center gap-2">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
              done
                ? 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/30'
                : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {done ? <CheckCircle2 className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p className={`text-sm font-semibold leading-tight ${done ? 'text-emerald-700 dark:text-emerald-300' : 'text-foreground'}`}>
              {label}
            </p>
            {target && !done && (
              <p className="truncate text-[11px] text-muted-foreground" dir="ltr">
                {c.sentTo} {target}
              </p>
            )}
          </div>
        </div>

        {done ? (
          <div className="flex items-center gap-2 py-1">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{c.verifiedChip}</span>
          </div>
        ) : (
          <div dir="ltr" className="flex justify-center">
            <InputOTP
              maxLength={maxLength}
              pattern={REGEXP_ONLY_DIGITS}
              value={code}
              onChange={(value) => { setCode(value); clearChannelError(channel) }}
              disabled={verifying || resending}
              containerClassName="justify-center"
            >
              <InputOTPGroup className={shake ? 'animate-[vshake_0.5s_ease-in-out]' : ''}>
                {Array.from({ length: Math.ceil(maxLength / 2) }).map((_, i) => (
                  <InputOTPSlot
                    key={i}
                    index={i}
                    className="h-10 w-8 rounded-lg border-2 border-gray-200 dark:border-gray-700 font-semibold data-[active=true]:border-emerald-500 data-[active=true]:ring-emerald-500/20"
                  />
                ))}
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup className={shake ? 'animate-[vshake_0.5s_ease-in-out]' : ''}>
                {Array.from({ length: Math.floor(maxLength / 2) }).map((_, i) => (
                  <InputOTPSlot
                    key={i + Math.ceil(maxLength / 2)}
                    index={i + Math.ceil(maxLength / 2)}
                    className="h-10 w-8 rounded-lg border-2 border-gray-200 dark:border-gray-700 font-semibold data-[active=true]:border-emerald-500 data-[active=true]:ring-emerald-500/20"
                  />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>
        )}

        {/* Inline error */}
        {error && !done && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-2.5 flex items-center gap-1.5"
            role="alert"
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
            <span className="text-xs text-red-600 dark:text-red-400 leading-tight">{error}</span>
          </motion.div>
        )}

        {/* Resend (only while the channel still needs verification) */}
        {!done && (
          <div className="mt-3 flex justify-center">
            {countdownValue > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <RefreshCw className="h-3 w-3" />
                {fmt(c.resendIn, { seconds: countdownValue })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleResend(channel)}
                disabled={resending || verifying}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950/40 disabled:opacity-50"
              >
                {resending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                {resending ? c.resending : c.resend}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div dir={dir} className="w-full max-w-sm mx-auto" role="region" aria-label={c.title}>
      {/* Inline shake keyframes (no utility class exists for this) */}
      <style>{`@keyframes vshake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }`}</style>

      {/* Header */}
      <div className="mb-5 text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/25"
        >
          <ShieldCheck className="h-7 w-7 text-white" />
        </motion.div>
        <h3 className="text-xl font-bold text-foreground">{c.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{c.subtitle}</p>
      </div>

      {/* Dev bypass hint (dev mode only — chip omitted otherwise) */}
      {devChipItems.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800/70 dark:bg-amber-950/30">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300" dir={dir}>
            <span className="font-semibold">{c.devChipPrefix}</span>
            {' — '}
            {devChipItems.join(' · ')}
          </p>
        </div>
      )}

      {/* OTP blocks (stack vertically; both fit a ~480px window) */}
      <div className="space-y-4">
        {isEmailPending && renderChannelBlock('email')}
        {isPhonePending && renderChannelBlock('phone')}
      </div>

      {/* Verify button */}
      <Button
        onClick={handleVerify}
        disabled={!canVerify}
        className="mt-5 h-12 w-full rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 font-semibold text-base text-white shadow-lg shadow-emerald-600/25 transition-all duration-300 hover:from-emerald-700 hover:to-teal-700 hover:shadow-xl hover:shadow-emerald-600/30 disabled:opacity-60"
      >
        {verifying ? (
          <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} className="flex items-center gap-2">
            <Loader2 className="h-4 w-4" />
            <span>{c.verifying}</span>
          </motion.span>
        ) : (
          <ShieldCheck className="me-1 h-4 w-4" />
        )}
        {!verifying && c.verifyButton}
      </Button>

      {/* Back */}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mt-4 flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
          {c.back}
        </button>
      )}
    </div>
  )
}
