'use client'

/**
 * Dedicated DESKTOP login page (agency console).
 *
 * The desktop app serves ONLY agencies, so it gets its own login page —
 * distinct from the consumer web login (`login-form.tsx`):
 *  - No customer/agency role tabs: the request always carries
 *    `expectedRole: 'AGENCY_OWNER'` (the cloud accepts AGENCY_OWNER,
 *    AGENCY_STAFF and SUPER_ADMIN for it and rejects CUSTOMER with 403).
 *  - A client-side guard double-checks the role: a CUSTOMER account is
 *    refused with an explicit "desktop is agency-only" message even if a
 *    local/offline path ever returned one.
 *  - Agency-branded split layout sized for a desktop window, with the real
 *    BLASTI logo and bilingual (AR/EN) copy.
 *  - Identical Electron session bootstrap to the shared LoginForm:
 *    store setSessionToken (→ electronAPI.setCloudSyncAuth +
 *    setLocalApiSession), native session token key, local-API token key,
 *    HTTP import-session backup and the initial workspace sync trigger.
 *  - Task 22: an unverified account (login answers requiresVerification)
 *    gets the shared OTP verification step; the session is only established
 *    once BOTH email+phone codes pass. Account creation links to the
 *    register view, which shows the same verification step and is
 *    agency-only on desktop.
 */

import { useState, useCallback } from 'react'
import { apiFetch } from '@/lib/api-fetch'
import { apiClient, setNativeSessionToken } from '@/lib/api-client'
import { useAppStore } from '@/store/use-app-store'
import { useLanguage } from '@/hooks/use-language'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { LanguageSwitcher } from '@/components/shared/language-switcher'
import { ThemeToggle } from '@/components/shared/theme-toggle'
import {
  Eye, EyeOff, Loader2, Building2, Users, MonitorPlay, CloudOff,
  ShieldCheck, ArrowLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  VerificationStep,
  type VerificationPending,
  type VerificationTargets,
  type VerificationDev,
  type VerificationSuccess,
} from './verification-step'

/** Agency-console copy that is intentionally not part of the global i18n dict. */
const COPY = {
  ar: {
    consoleTitle: 'بوابة الوكالات',
    consoleSubtitle: 'لوحة تحكم وكالتك في بلاصتي',
    headline: 'أدر طوابير وكالتك باحترافية',
    bullets: [
      { icon: Users, text: 'إدارة الطوابير والخدمات والموظفين' },
      { icon: CloudOff, text: 'يعمل بدون إنترنت — مزامنة تلقائية عند العودة' },
      { icon: MonitorPlay, text: 'شاشات عرض مباشرة وتذاكر فورية' },
    ],
    signInTitle: 'تسجيل دخول الوكالة',
    signInSubtitle: 'أدخل بيانات حساب الوكالة للمتابعة',
    signInButton: 'دخول',
    signingIn: 'جارٍ تسجيل الدخول...',
    onlyAgencies: 'تطبيق سطح المكتب مخصص للوكالات المسجّلة فقط.',
    customerRefused: 'تطبيق سطح المكتب مخصص للوكالات فقط. نرجو استخدام تطبيق الزبائن أو الموقع.',
    noAccount: 'ليس لديك حساب وكالة؟',
    createAccount: 'إنشاء حساب',
    backToLogin: 'العودة لتسجيل الدخول',
    resetTitle: 'استعادة كلمة المرور',
    resetSubtitle: 'أدخل اسم المستخدم لإرسال رمز الاستعادة',
    sendReset: 'إرسال رمز الاستعادة',
    resetSent: 'تم إرسال رمز الاستعادة بنجاح',
    desktopBadge: 'تطبيق سطح المكتب',
  },
  en: {
    consoleTitle: 'Agency Console',
    consoleSubtitle: 'Your BLASTI agency control panel',
    headline: 'Run your agency queues like a pro',
    bullets: [
      { icon: Users, text: 'Queues, services & staff management' },
      { icon: CloudOff, text: 'Works offline — automatic sync on reconnect' },
      { icon: MonitorPlay, text: 'Live display screens & instant tickets' },
    ],
    signInTitle: 'Agency sign in',
    signInSubtitle: 'Enter your agency account credentials to continue',
    signInButton: 'Sign in',
    signingIn: 'Signing in...',
    onlyAgencies: 'The desktop app is for registered agencies only.',
    customerRefused: 'The desktop app is for agencies only. Please use the customer mobile app or website.',
    noAccount: "Don't have an agency account?",
    createAccount: 'Create account',
    backToLogin: 'Back to sign in',
    resetTitle: 'Reset password',
    resetSubtitle: 'Enter your username to receive a reset token',
    sendReset: 'Send reset token',
    resetSent: 'Reset token sent successfully',
    desktopBadge: 'Desktop app',
  },
} as const

export function DesktopAgencyLogin() {
  const { setUser, setView, setSessionToken } = useAppStore()
  const { t, lang } = useLanguage()
  const c = COPY[lang === 'en' ? 'en' : 'ar']

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [shakeError, setShakeError] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [loginSuccess, setLoginSuccess] = useState(false)

  // Forgot-password subview state (same endpoints as the shared form)
  const [authView, setAuthView] = useState<'login' | 'forgot-password' | 'verify'>('login')
  const [forgotUsername, setForgotUsername] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)

  // Task 22-b: pending OTP verification — when the login API answers
  // requiresVerification, the panel shows the shared VerificationStep and the
  // session is only established once BOTH codes pass.
  const [verificationData, setVerificationData] = useState<{
    verificationToken: string
    pending: VerificationPending
    targets?: VerificationTargets | null
    dev?: VerificationDev | null
  } | null>(null)

  const triggerShake = useCallback(() => {
    setShakeError(true)
    setTimeout(() => setShakeError(false), 600)
  }, [])

  /** Desktop role guard: the console is for agency accounts (+ SUPER_ADMIN). */
  const isAllowedDesktopRole = (role?: string | null) =>
    role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF' || role === 'SUPER_ADMIN'

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      toast.error(t('requiredField'))
      return
    }

    setLoading(true)
    setFormError(null)
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: username.trim(),
          password,
          expectedRole: 'AGENCY_OWNER',
          ...(rememberMe ? { rememberMe: true } : {}),
        }),
      })

      const data = await res.json()

      // ── Task 22-b: unverified account → OTP verification instead of a session ──
      if (res.ok && data.requiresVerification && data.verificationToken) {
        setVerificationData({
          verificationToken: data.verificationToken,
          pending: (data.pending ?? { email: true, phone: true }) as VerificationPending,
          targets: data.targets ?? null,
          dev: data.dev ?? null,
        })
        setAuthView('verify')
        return
      }

      if (res.ok && data.user) {
        if (!isAllowedDesktopRole(data.user.role)) {
          triggerShake()
          setFormError(c.customerRefused)
          toast.error(c.customerRefused)
          return
        }
        setLoginSuccess(true)
        setTimeout(() => {
          setUser(data.user)
          if (data.token) {
            setSessionToken(data.token)
            // ── Electron: establish the local API session for LAN failover ──
            try {
              const w = window as any
              const isElectron = navigator.userAgent.includes('Electron') || !!w.electronAPI
              if (isElectron) {
                // Native session key so EVERY token consumer reads it deterministically
                setNativeSessionToken(data.token)
                // buildAuthHeaders() fallback for local API requests
                try { localStorage.setItem('blasti-local-api-token', data.token) } catch { /* ignore */ }
                // HTTP import-session backup (IPC bridge may not be enough)
                const servedUrl = (res as unknown as { url?: string }).url
                if (!servedUrl || !servedUrl.includes('localhost:3080')) {
                  fetch('http://127.0.0.1:3080/api/auth/import-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'omit',
                    body: JSON.stringify({ token: data.token, user: data.user }),
                  }).catch(() => { /* non-critical */ })
                }
                // Trigger the initial workspace sync (cloud → local SQLite).
                if (w.electronAPI?.initialCloudSync) {
                  w.electronAPI.initialCloudSync().then((syncResult: any) => {
                    if (syncResult?.success) {
                      console.log('[DesktopLogin] Initial sync complete:', syncResult.pulled, 'records pulled')
                    }
                  }).catch(() => { /* non-critical — periodic sync will handle it */ })
                }
              }
            } catch { /* ignore */ }
          }
          toast.success(t('loginSuccess'))
          setLoginSuccess(false)
        }, 600)
      } else {
        triggerShake()
        if (data.error === 'wrongRoleError') {
          // No role tabs here — the account simply is not an agency account.
          setFormError(c.customerRefused)
          toast.error(c.customerRefused)
        } else {
          const msg = data.error || t('invalidCredentials')
          setFormError(msg)
          toast.error(msg)
        }
      }
    } catch {
      triggerShake()
      setFormError(t('error'))
      toast.error(t('error'))
    } finally {
      setLoading(false)
    }
  }

  // ── Task 22-b: OTP verification finished → session bootstrap ──
  // Same Electron session bootstrap parity as the login success path above:
  // store setSessionToken (→ electronAPI.setCloudSyncAuth +
  // setLocalApiSession), native session token key, local-API token key,
  // HTTP import-session backup and the initial workspace sync trigger.
  const finalizeVerificationLogin = (result: VerificationSuccess) => {
    // Desktop role guard — same policy as a direct login.
    if (!isAllowedDesktopRole(result.user?.role)) {
      triggerShake()
      setFormError(c.customerRefused)
      toast.error(c.customerRefused)
      return
    }
    setLoginSuccess(true)
    setTimeout(() => {
      setUser(result.user as any)
      setSessionToken(result.token)
      // ── Electron: establish the local API session for LAN failover ──
      try {
        const w = window as any
        const isElectron = navigator.userAgent.includes('Electron') || !!w.electronAPI
        if (isElectron) {
          // Native session key so EVERY token consumer reads it deterministically
          setNativeSessionToken(result.token)
          // buildAuthHeaders() fallback for local API requests
          try { localStorage.setItem('blasti-local-api-token', result.token) } catch { /* ignore */ }
          // HTTP import-session backup (IPC bridge may not be enough).
          // apiFetch responses carry no url — same behavior as the login path.
          fetch('http://127.0.0.1:3080/api/auth/import-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify({ token: result.token, user: result.user }),
          }).catch(() => { /* non-critical */ })
          // Trigger the initial workspace sync (cloud → local SQLite).
          if (w.electronAPI?.initialCloudSync) {
            w.electronAPI.initialCloudSync().then((syncResult: any) => {
              if (syncResult?.success) {
                console.log('[DesktopLogin] Initial sync complete:', syncResult.pulled, 'records pulled')
              }
            }).catch(() => { /* non-critical — periodic sync will handle it */ })
          }
        }
      } catch { /* ignore */ }
      toast.success(t('loginSuccess'))
      setVerificationData(null)
      setLoginSuccess(false)
    }, 600)
  }

  // Verification token expired/invalid → back to the sign-in view (a fresh
  // login re-issues the OTPs and a new verification token).
  const handleVerificationTokenInvalid = () => {
    setVerificationData(null)
    setAuthView('login')
  }

  const handleForgotPassword = async () => {
    if (!forgotUsername.trim()) {
      toast.error(t('requiredField'))
      return
    }
    setForgotLoading(true)
    try {
      await apiClient.post('/api/auth/forgot-password', { username: forgotUsername.trim() })
      setForgotSent(true)
      toast.success(c.resetSent)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('error')
      toast.error(message)
    } finally {
      setForgotLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (authView === 'login') handleLogin()
      else handleForgotPassword()
    }
  }

  const BulletIcon = ({ icon: Icon }: { icon: typeof Users }) => (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
      <Icon className="h-4.5 w-4.5 text-emerald-300" />
    </span>
  )

  return (
    <div className="min-h-screen flex bg-background" dir={lang === 'en' ? 'ltr' : 'rtl'}>
      <style>{`@keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }`}</style>
      {/* ── Branding panel (desktop-width only) ── */}
      <aside className="hidden lg:flex w-[44%] xl:w-[46%] relative overflow-hidden bg-gradient-to-br from-emerald-950 via-teal-950 to-emerald-900 text-white flex-col justify-between p-10">
        {/* Ambient shapes */}
        <div className="absolute inset-0 dot-grid-pattern opacity-40" aria-hidden="true" />
        <motion.div
          animate={{ x: [0, 18, 0], y: [0, -14, 0] }}
          transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute -top-24 -end-24 h-80 w-80 rounded-full bg-emerald-500/10 blur-3xl"
          aria-hidden="true"
        />
        <motion.div
          animate={{ x: [0, -12, 0], y: [0, 16, 0] }}
          transition={{ duration: 17, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="absolute -bottom-28 -start-20 h-96 w-96 rounded-full bg-teal-500/10 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative z-10 flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl overflow-hidden bg-white/95 p-1 shadow-lg">
            <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
          </div>
          <div>
            <p className="text-lg font-extrabold tracking-tight">BLASTI</p>
            <p className="text-xs text-emerald-200/80">{c.consoleTitle}</p>
          </div>
          <span className="ms-auto rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold text-emerald-200">
            {c.desktopBadge}
          </span>
        </div>

        <div className="relative z-10 space-y-8">
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-3xl xl:text-4xl font-extrabold leading-snug"
          >
            {c.headline}
            <span className="mt-2 block text-base xl:text-lg font-medium text-emerald-200/85">{c.consoleSubtitle}</span>
          </motion.h1>

          <ul className="space-y-4">
            {c.bullets.map((b, i) => (
              <motion.li
                key={b.text}
                initial={{ opacity: 0, x: lang === 'en' ? -14 : 14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.45, delay: 0.15 + i * 0.12 }}
                className="flex items-center gap-3"
              >
                <BulletIcon icon={b.icon} />
                <span className="text-sm text-emerald-50/90">{b.text}</span>
              </motion.li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 flex items-center gap-2 text-xs text-emerald-200/70">
          <ShieldCheck className="h-4 w-4" />
          <span>{c.onlyAgencies}</span>
        </div>
      </aside>

      {/* ── Form panel ── */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        <div className="absolute inset-0 -z-10" aria-hidden="true">
          <div className="absolute inset-0 dot-grid-pattern" />
          <div className="absolute top-1/3 start-1/4 h-64 w-64 rounded-full bg-emerald-200/25 dark:bg-emerald-800/10 blur-3xl" />
        </div>

        {/* Top bar */}
        <header className="flex items-center justify-end gap-2 px-5 py-4 relative z-10">
          <LanguageSwitcher />
          <ThemeToggle />
        </header>

        <div className="flex-1 flex items-center justify-center px-5 pb-10 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className={`w-full max-w-md ${shakeError ? 'animate-[shake_0.5s_ease-in-out]' : ''}`}
          >
            {/* Compact logo header (always visible; primary branding on small screens) */}
            <div className="lg:hidden flex items-center justify-center gap-3 mb-8">
              <div className="h-12 w-12 rounded-xl overflow-hidden shadow-sm">
                <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
              </div>
              <div>
                <p className="text-lg font-extrabold bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">BLASTI</p>
                <p className="text-xs text-muted-foreground">{c.consoleTitle}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-emerald-100/80 dark:border-emerald-900/40 bg-white/80 dark:bg-gray-900/70 backdrop-blur p-6 sm:p-8 shadow-xl shadow-emerald-900/5">
              {/* Task 22-b: OTP verification view (unverified account) */}
              {authView === 'verify' && verificationData ? (
                <VerificationStep
                  verificationToken={verificationData.verificationToken}
                  pending={verificationData.pending}
                  targets={verificationData.targets}
                  dev={verificationData.dev}
                  lang={lang}
                  onVerified={finalizeVerificationLogin}
                  onTokenInvalid={handleVerificationTokenInvalid}
                  onBack={() => { setVerificationData(null); setAuthView('login') }}
                />
              ) : authView === 'login' ? (
                <>
                  <div className="mb-6">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-md">
                        <Building2 className="h-4 w-4" />
                      </span>
                      <h2 className="text-xl font-bold text-foreground">{c.signInTitle}</h2>
                    </div>
                    <p className="text-sm text-muted-foreground">{c.signInSubtitle}</p>
                  </div>

                  <div className="space-y-4" onKeyDown={handleKeyDown}>
                    <div className="space-y-2">
                      <Label htmlFor="desktop-username" className="text-sm font-medium">{t('username')}</Label>
                      <Input
                        id="desktop-username"
                        value={username}
                        onChange={(e) => { setUsername(e.target.value); setFormError(null) }}
                        placeholder={t('username')}
                        autoComplete="username"
                        autoFocus
                        className="h-11"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="desktop-password" className="text-sm font-medium">{t('password')}</Label>
                      <div className="relative">
                        <Input
                          id="desktop-password"
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => { setPassword(e.target.value); setFormError(null) }}
                          placeholder={t('password')}
                          autoComplete="current-password"
                          className="h-11 pe-11"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((s) => !s)}
                          className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    </div>

                    <label className="flex cursor-pointer items-center gap-2 select-none">
                      <Checkbox
                        id="desktop-remember"
                        checked={rememberMe}
                        onCheckedChange={(v) => setRememberMe(v === true)}
                      />
                      <span className="text-sm text-muted-foreground">{t('rememberMe')}</span>
                    </label>

                    {formError && (
                      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                        {formError}
                      </div>
                    )}

                    <Button
                      onClick={handleLogin}
                      disabled={loading || loginSuccess}
                      className="w-full h-11 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg shadow-emerald-600/20"
                    >
                      {loginSuccess ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> {t('loginSuccess')}</>
                      ) : loading ? (
                        <><Loader2 className="h-4 w-4 animate-spin" /> {c.signingIn}</>
                      ) : (
                        c.signInButton
                      )}
                    </Button>
                  </div>

                  <div className="mt-5 flex items-center justify-between text-sm">
                    <button
                      type="button"
                      onClick={() => { setAuthView('forgot-password'); setForgotSent(false); setFormError(null) }}
                      className="text-emerald-700 dark:text-emerald-400 hover:underline font-medium"
                    >
                      {t('forgotPassword')}
                    </button>
                  </div>

                  <div className="mt-6 border-t border-border/60 pt-4 text-center text-sm">
                    <span className="text-muted-foreground">{c.noAccount} </span>
                    <button
                      type="button"
                      onClick={() => setView('register')}
                      className="font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                    >
                      {c.createAccount}
                    </button>
                  </div>

                  <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground/80 lg:hidden">
                    {c.onlyAgencies}
                  </p>
                </>
              ) : (
                <>
                  <div className="mb-6">
                    <Button variant="ghost" size="icon" className="mb-2 h-9 w-9" onClick={() => setAuthView('login')} aria-label={c.backToLogin}>
                      <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
                    </Button>
                    <h2 className="text-xl font-bold text-foreground">{c.resetTitle}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{c.resetSubtitle}</p>
                  </div>

                  {forgotSent ? (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/40 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
                      {c.resetSent}
                    </div>
                  ) : (
                    <div className="space-y-4" onKeyDown={handleKeyDown}>
                      <div className="space-y-2">
                        <Label htmlFor="desktop-forgot-username" className="text-sm font-medium">{t('username')}</Label>
                        <Input
                          id="desktop-forgot-username"
                          value={forgotUsername}
                          onChange={(e) => setForgotUsername(e.target.value)}
                          placeholder={t('username')}
                          autoFocus
                          className="h-11"
                        />
                      </div>
                      <Button
                        onClick={handleForgotPassword}
                        disabled={forgotLoading}
                        className="w-full h-11 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold"
                      >
                        {forgotLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : c.sendReset}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </div>

        <footer className="relative z-10 px-5 py-4 text-center text-[11px] text-muted-foreground/70">
          BLASTI · {c.consoleTitle} · {new Date().getFullYear()}
        </footer>
      </main>
    </div>
  )
}
