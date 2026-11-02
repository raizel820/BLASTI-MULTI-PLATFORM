'use client'

/**
 * Unified Login (0.6.48) — ONE sign-in surface for every BLASTI app and
 * account type. Replaces the three platform-split forms:
 *   login-form.tsx (web) · desktop-agency-login.tsx (Electron) ·
 *   mobile-login.tsx (Capacitor APK)
 *
 * CONTRACT (user requirements, 0.6.48):
 *  ─ UPDATE + UNIFY + REDESIGN: one component, one code path, three adaptive
 *    layouts — everything below is shared: state, submit handler, session
 *    bootstrap (previously duplicated 5×), forgot/reset flows, OTP
 *    verification, biometric quick-unlock, remember-me.
 *
 *  ─ SERVER AUTO-DETECTS THE ACCOUNT TYPE: there are NO role tabs anymore.
 *    The request carries ONLY { username, password, rememberMe? } — the
 *    server recognizes the account from the credentials and routes the
 *    session by its real role.
 *
 *  ─ ACCOUNT-TYPE SECRECY: when the credentials are correct but the account
 *    type is not supported on this platform (e.g. a customer username on the
 *    agency-only desktop app, or an admin username in the apk), the server
 *    answers EXACTLY like a wrong password (generic 401). The client shows
 *    the same "invalid credentials" error — nothing in the UI can leak what
 *    kind of account exists behind a username.
 *
 *  ─ PLATFORM DIFFERENTIATION IS APP-LEVEL: the layout mode comes from the
 *    REAL shell probes (window.electronAPI / window.Capacitor) — NEVER from
 *    the screen size. A phone BROWSER renders the responsive web card and
 *    keeps full web powers (including the admin console); only the native
 *    binaries render the desktop split-screen / mobile layouts.
 *
 *  ─ SIGNED CLIENT ATTESTATION: every API request from a native shell
 *    carries `x-blasti-attest` (HMAC computed in the Electron main process
 *    / inside the APK — see lib/client-attestation.ts) so the server can
 *    prove the login really comes from the desktop or phone app.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/api-fetch'
import { apiClient, setNativeSessionToken } from '@/lib/api-client'
import { setSessionPersistenceMode, getLastRememberChoice } from '@/lib/auth-storage'
import { adoptLocalLanguagePreference } from '@/hooks/use-language'
import { useAppStore } from '@/store/use-app-store'
import { adoptImportedLocalSessionUser } from '@/lib/session-heal'
import { useLanguage } from '@/hooks/use-language'
import { usePlatform } from '@/hooks/use-platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { LanguageSwitcher } from '@/components/shared/language-switcher'
import { ThemeToggle } from '@/components/shared/theme-toggle'
import { nativeBridge } from '@/lib/native-bridge'
import {
  VerificationStep,
  type VerificationPending,
  type VerificationTargets,
  type VerificationDev,
  type VerificationSuccess,
} from './verification-step'
import { NativeServerStatus } from './native-server-status'
import { MobileDiagnosticsSheet } from '@/components/shared/mobile-diagnostics-sheet'
import {
  ArrowLeft, ArrowRight, Loader2, Eye, EyeOff, CheckCircle2, KeyRound,
  Users, CloudOff, MonitorPlay, ShieldCheck, Fingerprint, LifeBuoy, Building2,
} from 'lucide-react'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'

// ─── Local bilingual copy (fr falls back to EN — global dicts untouched) ────

const DESKTOP_COPY = {
  ar: {
    consoleTitle: 'بوابة الوكالات',
    consoleSubtitle: 'لوحة تحكم وكالتك في بلاصتي',
    headline: 'أدر طوابير وكالتك باحترافية',
    bullets: [
      { icon: Users, text: 'إدارة الطوابير والخدمات والموظفين' },
      { icon: CloudOff, text: 'يعمل بدون إنترنت — مزامنة تلقائية عند العودة' },
      { icon: MonitorPlay, text: 'شاشات عرض مباشرة وتذاكر فورية' },
    ],
    signInTitle: 'تسجيل الدخول',
    signInSubtitle: 'يتعرف السيرفر تلقائيًا على نوع حسابك من بياناتك',
    signInButton: 'دخول',
    signingIn: 'جارٍ تسجيل الدخول...',
    noAccount: 'ليس لديك حساب؟',
    createAccount: 'إنشاء حساب',
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
    signInTitle: 'Sign in',
    signInSubtitle: 'The server detects your account type automatically',
    signInButton: 'Sign in',
    signingIn: 'Signing in...',
    noAccount: "Don't have an account?",
    createAccount: 'Create account',
    desktopBadge: 'Desktop app',
  },
} as const

const MOBILE_COPY = {
  ar: {
    welcomeSub: 'سجّل دخولك للمتابعة إلى حسابك',
    forgotQuestion: 'نسيت كلمة المرور؟',
    sendResetCode: 'إرسال رمز الاستعادة',
    backToLogin: 'العودة لتسجيل الدخول',
    resetCodeLabel: 'رمز الاستعادة',
    resetTokenPlaceholder: 'الصق الرمز الذي استلمته',
    newPasswordLabel: 'كلمة المرور الجديدة',
    resetConfirm: 'تغيير كلمة المرور',
    newHere: 'جديد على بلاستي؟',
    createAccount: 'إنشاء حساب',
    signingIn: 'جارٍ تسجيل الدخول…',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
  },
  en: {
    welcomeSub: 'Sign in to continue to your account',
    forgotQuestion: 'Forgot password?',
    sendResetCode: 'Send reset code',
    backToLogin: 'Back to sign in',
    resetCodeLabel: 'Reset code',
    resetTokenPlaceholder: 'Paste the code you received',
    newPasswordLabel: 'New password',
    resetConfirm: 'Change password',
    newHere: 'New to BLASTI?',
    createAccount: 'Create an account',
    signingIn: 'Signing in…',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
  },
} as const

// ─── Component ───────────────────────────────────────────────────────────────

type LoginMode = 'desktop' | 'native' | 'web'
type AuthView = 'login' | 'forgot-password' | 'reset-password' | 'verify'

export function UnifiedLoginForm() {
  const { setUser, setView, goBack, setSessionToken } = useAppStore()
  const { t, lang } = useLanguage()
  const { platform } = usePlatform()
  const router = useRouter()

  // Layout mode — the REAL app shell only (never the screen size). A phone
  // browser stays 'web'; only window.electronAPI / window.Capacitor flip it.
  const mode: LoginMode = platform.isElectron ? 'desktop' : platform.isCapacitor ? 'native' : 'web'
  const c = DESKTOP_COPY[lang === 'en' ? 'en' : 'ar']
  const m = MOBILE_COPY[lang === 'en' ? 'en' : 'ar']

  // Task 24 (desktop) — when mounted on the STANDALONE /agency/login route
  // (the Electron boot path), the Home ViewRouter is not mounted: after a
  // successful login we must navigate back to the SPA root so the dashboard
  // actually renders.
  const navigateToConsole = useCallback(() => {
    try {
      if (typeof window !== 'undefined' && window.location.pathname !== '/') {
        router.replace('/')
      }
    } catch { /* router unavailable — the periodic views still recover */ }
  }, [router])

  const openRegisterView = useCallback(() => {
    setView('register')
    navigateToConsole()
  }, [setView, navigateToConsole])

  // ── Shared form state ──
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [loginSuccess, setLoginSuccess] = useState(false)
  const [shakeError, setShakeError] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [rememberMe, setRememberMe] = useState(false)
  // Task 2-b-2 — pre-show the last "Remember me" choice (read AFTER mount so
  // the SSR/hydration pass is never mismatched).
  useEffect(() => {
    try { setRememberMe(getLastRememberChoice()) } catch { /* storage unavailable */ }
  }, [])
  const [authView, setAuthView] = useState<AuthView>('login')
  // Shell diagnostics (native shells only) — one tap from the login screen.
  const [diagOpen, setDiagOpen] = useState(false)
  // Task 2-b (sub-task 4) — desktop full-sync consent dialog.
  const [showSyncConsent, setShowSyncConsent] = useState(false)

  // Forgot / reset subviews
  const [forgotUsername, setForgotUsername] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotSent, setForgotSent] = useState(false)
  const [resetToken, setResetToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [resetLoading, setResetLoading] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  // Task 22-b: pending OTP verification — no session until BOTH codes pass.
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

  // ── Task 80: biometric quick-unlock (shared verbatim with the old forms) ──
  const biometricLoginEnabled = useAppStore((s) => s.biometricLoginEnabled)
  const biometricUsername = useAppStore((s) => s.biometricUsername)
  const [biometricPassword, setBiometricPassword] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!biometricLoginEnabled || !biometricUsername) return
      try {
        const available = await nativeBridge.isBiometricsAvailable()
        if (!available || cancelled) return
        const stored = await nativeBridge.getBiometricCredentials(biometricUsername)
        if (!cancelled && stored) setBiometricPassword(stored)
      } catch { /* biometric unlock simply not offered */ }
    })()
    return () => { cancelled = true }
  }, [biometricLoginEnabled, biometricUsername])

  const guardBiometricOwnership = useCallback((loggedInUsername: string) => {
    const st = useAppStore.getState()
    if (
      st.biometricLoginEnabled &&
      st.biometricUsername &&
      st.biometricUsername.toLowerCase() !== loggedInUsername.toLowerCase()
    ) {
      void nativeBridge.deleteBiometricCredentials(st.biometricUsername)
      st.setBiometricLogin(false, null)
    }
  }, [])

  // ── Session bootstrap (the former 5 duplicated blocks, unified) ────────────
  const bootstrapSession = useCallback((userData: Record<string, unknown> | null, token?: string, remember?: boolean) => {
    const isDesktopShell = mode === 'desktop'
    if (isDesktopShell) {
      // Task 2-b (sub-task 3) — record the persistence mode BEFORE the token
      // touches any surface, so the desktop honors "remember me" exactly.
      try { setSessionPersistenceMode(remember ? 'remember' : 'ephemeral') } catch { /* ignore */ }
    }
    setUser(adoptLocalLanguagePreference(userData as never) as never)
    // cache-1 — prefetch this role's core endpoints so the first navigation
    // after login paints instantly.
    import('@/lib/boot-prefetch').then((mm) => mm.warmCoreCaches()).catch(() => { /* silent */ })
    guardBiometricOwnership(String(userData?.username ?? username.trim()))
    if (remember) {
      useAppStore.getState().beginRememberSession()
    } else {
      useAppStore.getState().clearRememberSession()
    }
    if (token) {
      setSessionToken(token, isDesktopShell ? { rememberMe: !!remember } : undefined)
      if (isDesktopShell) {
        // ── Electron: establish the local API session for LAN failover ──
        try {
          const w = window as unknown as { electronAPI?: Record<string, ((...a: unknown[]) => unknown) | undefined> }
          setNativeSessionToken(token)
          try { localStorage.setItem('blasti-local-api-token', token) } catch { /* ignore */ }
          if (typeof w.electronAPI?.setLocalApiSession === 'function') {
            w.electronAPI.setLocalApiSession({ token, user: userData })
          }
          // Security-0.6.13 — the desktop app must have NOTHING to do with
          // the admin API: an admin session is never imported into the local
          // API and never triggers the workspace sync.
          const isAdminSession = (userData as { role?: string } | null)?.role === 'SUPER_ADMIN'
          if (!isAdminSession) {
            fetch('http://127.0.0.1:3080/api/auth/import-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'omit',
              body: JSON.stringify({ token, user: userData }),
            })
              .then((importRes) => (importRes.ok ? importRes.json().catch(() => null) : null))
              .then((importData) => adoptImportedLocalSessionUser(importData))
              .catch(() => { /* non-critical */ })
            if (typeof w.electronAPI?.initialCloudSync === 'function') {
              (w.electronAPI.initialCloudSync() as Promise<{ success?: boolean; pulled?: number }>)
                .then((syncResult) => {
                  if (syncResult?.success) {
                    console.log('[Login] Initial sync complete:', syncResult.pulled, 'records pulled')
                  }
                })
                .catch(() => { /* non-critical — periodic sync will handle it */ })
            }
          }
        } catch { /* ignore */ }
      } else if (mode === 'native') {
        // Capacitor Bearer-token consumers (db/sync.ts, offline-queue.ts…).
        setNativeSessionToken(token)
      }
    }
    toast.success(t('loginSuccess'))
  }, [mode, setUser, setSessionToken, guardBiometricOwnership, t, username])

  // ── Login submit — NO role/expectedRole anywhere (server auto-detects) ─────
  const handleLogin = async (biometricUser?: string, biometricPass?: string) => {
    const effUsername = biometricUser ?? username
    const effPassword = biometricPass ?? password
    if (!effUsername.trim() || !effPassword.trim()) {
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
          username: effUsername.trim(),
          password: effPassword,
          ...(rememberMe && !biometricUser ? { rememberMe: true } : {}),
          // NOTE: deliberately NO expectedRole — the server recognizes the
          // account type from the credentials themselves (Secrecy-0.6.48).
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
        setLoginSuccess(true)
        setTimeout(() => {
          bootstrapSession(data.user, data.token, rememberMe && !biometricUser)
          setLoginSuccess(false)
          if (mode === 'desktop') {
            // Task 2-b (sub-task 4) — after a REAL login the desktop offers
            // the full data sync (consent dialog) BEFORE entering the console.
            if (data.token) {
              setShowSyncConsent(true)
              return
            }
          }
          navigateToConsole()
        }, 600)
      } else {
        triggerShake()
        // Network-level failure (apiFetch maps network ApiClientErrors to a
        // 5xx whose statusText is the raw fetch message). Give an actionable
        // message instead of a generic "Error".
        // Secrecy-0.6.48 — the platform-matrix rejection IS the generic
        // wrong-credentials answer now: whatever the server says, the UI
        // never mentions account types or platform support. The generic
        // server string is mapped to the LOCALIZED invalid-credentials text
        // so the user always reads it in their language.
        const networkFailure = res.status >= 500 && /fetch|network|timed out|load failed/i.test(res.statusText || '')
        const genericInvalid = data.error === 'Invalid username or password'
        const msg = networkFailure
          ? t('loginNetworkError')
          : genericInvalid
            ? t('invalidCredentials')
            : (data.error || t('invalidCredentials'))
        setFormError(msg)
        if (networkFailure) {
          toast.error(t('loginNetworkError'), {
            description: t('loginNetworkErrorDesc'),
            duration: 8000,
          })
        } else {
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

  // ── Task 81: biometrics ARE the relogin (auto-prompt, shared) ──────────────
  const handleBiometricLogin = async () => {
    if (!biometricUsername || !biometricPassword) return
    const ok = await nativeBridge.authenticateWithBiometrics(t('biometricLoginReason'))
    if (!ok) {
      toast.error(t('biometricVerifyFailed'))
      return
    }
    await handleLogin(biometricUsername, biometricPassword)
  }
  const autoPromptedRef = useRef(false)
  useEffect(() => {
    if (autoPromptedRef.current || !biometricPassword) return
    if (authView !== 'login' || loading || loginSuccess) return
    autoPromptedRef.current = true
    const timer = setTimeout(() => { void handleBiometricLogin() }, 600)
    return () => clearTimeout(timer)
  }, [biometricPassword, authView, loading, loginSuccess])

  // ── Task 22-b: OTP verification finished → session bootstrap ──
  const finalizeVerificationLogin = (result: VerificationSuccess) => {
    setLoginSuccess(true)
    setTimeout(() => {
      // The OTP-verified session inherits the form's remember-me decision.
      bootstrapSession(result.user as unknown as Record<string, unknown>, result.token, rememberMe)
      setVerificationData(null)
      setLoginSuccess(false)
      navigateToConsole()
    }, 600)
  }

  const handleVerificationTokenInvalid = () => {
    setVerificationData(null)
    setAuthView('login')
  }

  // ── Forgot / reset ──
  const handleForgotPassword = async () => {
    if (!forgotUsername.trim()) {
      toast.error(t('requiredField'))
      return
    }
    setForgotLoading(true)
    try {
      await apiClient.post('/api/auth/forgot-password', { username: forgotUsername.trim() })
      setForgotSent(true)
      toast.success(t('forgotPasswordSuccess'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('error')
      toast.error(message)
    } finally {
      setForgotLoading(false)
    }
  }

  const handleResetPassword = async () => {
    if (!resetToken.trim() || !newPassword.trim()) {
      toast.error(t('requiredField'))
      return
    }
    if (newPassword.length < 6) {
      toast.error(t('passwordMinLength'))
      return
    }
    setResetLoading(true)
    try {
      await apiClient.post('/api/auth/reset-password', { token: resetToken.trim(), newPassword })
      setResetDone(true)
      toast.success(t('resetPasswordSuccess'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('error')
      toast.error(message)
    } finally {
      setResetLoading(false)
    }
  }

  const backToLogin = () => {
    setAuthView('login')
    setForgotSent(false)
    setResetDone(false)
    setFormError(null)
  }

  // ─── Shared field blocks ────────────────────────────────────────────────────

  const passwordInput = (size: 'web' | 'touch') => (
    <div className="space-y-2">
      <Label htmlFor="unified-login-password" className="text-sm font-medium">
        {t('password')}
      </Label>
      <div className="relative">
        <Input
          id="unified-login-password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
          disabled={loading}
          className={size === 'touch'
            ? 'h-12 rounded-xl bg-background/80 pe-11'
            : 'h-11 rounded-xl bg-background/80 pe-10'}
        />
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          aria-label={showPassword ? m.hidePassword : m.showPassword}
          className={`absolute end-2 top-1/2 -translate-y-1/2 ${size === 'touch' ? 'min-h-[44px] min-w-[44px]' : 'h-8 w-8'} grid place-items-center rounded-lg text-muted-foreground hover:text-foreground transition-colors`}
        >
          {showPassword ? <EyeOff className={size === 'touch' ? 'h-5 w-5' : 'h-4 w-4'} /> : <Eye className={size === 'touch' ? 'h-5 w-5' : 'h-4 w-4'} />}
        </button>
      </div>
    </div>
  )

  const usernameInput = (size: 'web' | 'touch') => (
    <div className="space-y-2">
      <Label htmlFor="unified-login-username" className="text-sm font-medium">
        {t('username')}
      </Label>
      <Input
        id="unified-login-username"
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={t('username')}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        enterKeyHint="next"
        disabled={loading}
        className={size === 'touch' ? 'h-12 rounded-xl bg-background/80' : 'h-11 rounded-xl bg-background/80'}
      />
    </div>
  )

  const errorAlert = formError ? (
    <div className="rounded-xl border border-red-200/70 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/40 px-3.5 py-2.5 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
      <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 opacity-70" aria-hidden />
      <span className="break-words">{formError}</span>
    </div>
  ) : null

  const rememberControl = (
    <label className="flex items-center gap-2.5 cursor-pointer select-none group">
      <Checkbox
        checked={rememberMe}
        onCheckedChange={(v) => setRememberMe(v === true)}
        className="h-[18px] w-[18px] border-emerald-600/60 data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600"
      />
      <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
        {t('rememberMe')}
      </span>
    </label>
  )

  const biometricButton = (size: 'web' | 'touch') => biometricUsername && biometricPassword ? (
    <Button
      type="button"
      variant="outline"
      onClick={() => void handleBiometricLogin()}
      disabled={loading}
      className={size === 'touch'
        ? 'w-full min-h-[52px] rounded-2xl border-emerald-200 dark:border-emerald-800/60'
        : 'w-full h-11 rounded-xl border-emerald-200 dark:border-emerald-800/60'}
    >
      <Fingerprint className="h-5 w-5 text-emerald-600" />
      {t('biometricSignIn')}
    </Button>
  ) : null

  const submitButton = (variant: 'web' | 'touch' | 'desktop') => (
    <Button
      type="submit"
      disabled={loading || loginSuccess}
      className={
        variant === 'touch'
          ? 'w-full min-h-[52px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white text-base font-semibold shadow-lg shadow-emerald-500/25 hover:from-emerald-600 hover:to-teal-600'
          : 'w-full h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold shadow-md shadow-emerald-600/20 hover:from-emerald-700 hover:to-teal-700'
      }
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {mode === 'native' ? m.signingIn : c.signingIn}
        </>
      ) : loginSuccess ? (
        <>
          <CheckCircle2 className="h-4 w-4" />
          {t('loginSuccess')}
        </>
      ) : (
        <>
          {mode === 'native' ? t('login') : c.signInButton}
          {mode === 'native' ? <ArrowRight className="h-5 w-5 rtl:rotate-180" /> : null}
        </>
      )}
    </Button>
  )

  const forgotLink = (touch: boolean) => (
    <button
      type="button"
      onClick={() => { setFormError(null); setAuthView('forgot-password') }}
      className={`text-sm text-emerald-700 dark:text-emerald-400 hover:underline font-medium ${touch ? 'min-h-[44px] px-1' : ''}`}
    >
      {mode === 'native' ? m.forgotQuestion : t('forgotPassword')}
    </button>
  )

  const registerLink = (touch: boolean) => (
    <button
      type="button"
      onClick={openRegisterView}
      className={`text-sm text-muted-foreground ${touch ? 'min-h-[44px]' : ''}`}
    >
      {mode === 'native' ? m.newHere : c.noAccount}{' '}
      <span className="text-emerald-700 dark:text-emerald-400 font-semibold hover:underline">
        {mode === 'native' ? m.createAccount : c.createAccount}
      </span>
    </button>
  )

  // The whole login form (fields + remember + submit + links), reused by all
  // three layouts with size variants.
  const loginFormBody = (size: 'web' | 'touch') => (
    <form
      onSubmit={(e) => { e.preventDefault(); void handleLogin() }}
      className="space-y-5"
    >
      <NativeServerStatus />
      {usernameInput(size)}
      {passwordInput(size)}
      {errorAlert}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {rememberControl}
        {forgotLink(size === 'touch')}
      </div>
      {submitButton(size)}
      {biometricButton(size)}
      <div className="text-center">{registerLink(size === 'touch')}</div>
    </form>
  )

  const forgotBody = (size: 'web' | 'touch') => (
    <form
      onSubmit={(e) => { e.preventDefault(); void handleForgotPassword() }}
      className="space-y-5"
    >
      <button type="button" onClick={backToLogin} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground min-h-[44px]">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
        {mode === 'native' ? m.backToLogin : t('backToLogin')}
      </button>
      <p className="text-sm text-muted-foreground">{t('forgotPasswordDesc')}</p>
      <div className="rounded-xl border border-amber-200/70 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/30 px-3.5 py-2.5 text-xs text-amber-700 dark:text-amber-300">
        {t('devTokenHint')}
      </div>
      <div className="space-y-2">
        <Label htmlFor="unified-forgot-username" className="text-sm font-medium">{t('username')}</Label>
        <Input
          id="unified-forgot-username"
          type="text"
          value={forgotUsername}
          onChange={(e) => setForgotUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          className={size === 'touch' ? 'h-12 rounded-xl bg-background/80' : 'h-11 rounded-xl bg-background/80'}
        />
      </div>
      <Button
        type="submit"
        disabled={forgotLoading}
        className={size === 'touch'
          ? 'w-full min-h-[52px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold'
          : 'w-full h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold'}
      >
        {forgotLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        {mode === 'native' ? m.sendResetCode : t('forgotPasswordRequest')}
      </Button>
      {forgotSent && (
        <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/80 dark:border-emerald-900/50 dark:bg-emerald-950/40 px-3.5 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
          {t('forgotPasswordSuccess')}
        </div>
      )}
    </form>
  )

  const resetBody = (size: 'web' | 'touch') => (
    <form
      onSubmit={(e) => { e.preventDefault(); void handleResetPassword() }}
      className="space-y-5"
    >
      <button type="button" onClick={backToLogin} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground min-h-[44px]">
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
        {mode === 'native' ? m.backToLogin : t('backToLogin')}
      </button>
      <p className="text-sm text-muted-foreground">{t('resetPasswordDesc')}</p>
      <div className="space-y-2">
        <Label htmlFor="unified-reset-token" className="text-sm font-medium">
          {mode === 'native' ? m.resetCodeLabel : t('resetTokenLabel')}
        </Label>
        <Input
          id="unified-reset-token"
          type="text"
          value={resetToken}
          onChange={(e) => setResetToken(e.target.value)}
          placeholder={mode === 'native' ? m.resetTokenPlaceholder : t('resetTokenPlaceholder')}
          autoCapitalize="none"
          className={size === 'touch' ? 'h-12 rounded-xl bg-background/80' : 'h-11 rounded-xl bg-background/80'}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="unified-reset-password" className="text-sm font-medium">
          {mode === 'native' ? m.newPasswordLabel : t('newPassword')}
        </Label>
        <Input
          id="unified-reset-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          className={size === 'touch' ? 'h-12 rounded-xl bg-background/80' : 'h-11 rounded-xl bg-background/80'}
        />
      </div>
      <Button
        type="submit"
        disabled={resetLoading}
        className={size === 'touch'
          ? 'w-full min-h-[52px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold'
          : 'w-full h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold'}
      >
        {resetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
        {mode === 'native' ? m.resetConfirm : t('resetPasswordSubmit')}
      </Button>
      {resetDone && (
        <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/80 dark:border-emerald-900/50 dark:bg-emerald-950/40 px-3.5 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
          {t('resetPasswordSuccess')}
        </div>
      )}
    </form>
  )

  const verifyBody = verificationData ? (
    <VerificationStep
      verificationToken={verificationData.verificationToken}
      pending={verificationData.pending}
      targets={verificationData.targets}
      dev={verificationData.dev}
      lang={lang}
      onVerified={finalizeVerificationLogin}
      onTokenInvalid={handleVerificationTokenInvalid}
      onBack={backToLogin}
    />
  ) : null

  // ─── Layout: DESKTOP (Electron exe) — agency console split-screen ──────────
  if (mode === 'desktop') {
    return (
      <div dir={lang === 'en' ? 'ltr' : 'rtl'} className="min-h-screen flex bg-background" data-login-mode="desktop">
        {/* Brand aside */}
        <aside className="hidden lg:flex w-[44%] xl:w-[46%] flex-col justify-between p-10 xl:p-14 bg-gradient-to-br from-emerald-950 via-teal-950 to-emerald-900 text-white relative overflow-hidden">
          <div className="absolute -top-24 -end-24 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl" />
          <div className="absolute bottom-10 -start-16 h-64 w-64 rounded-full bg-teal-500/10 blur-3xl" />
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-white/10 backdrop-blur grid place-items-center overflow-hidden">
              <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-wide">BLASTI</span>
              <span className="ms-2 text-[11px] px-2 py-0.5 rounded-full bg-white/10 border border-white/15">{c.desktopBadge}</span>
            </div>
          </div>
          <div className="relative">
            <h1 className="text-3xl xl:text-4xl font-bold leading-tight">{c.headline}</h1>
            <p className="mt-3 text-emerald-200/80">{c.consoleSubtitle}</p>
            <ul className="mt-8 space-y-4">
              {c.bullets.map((b, i) => (
                <li key={i} className="flex items-center gap-3 text-emerald-100/90">
                  <span className="h-10 w-10 rounded-xl bg-white/10 grid place-items-center shrink-0">
                    <b.icon className="h-5 w-5 text-emerald-300" />
                  </span>
                  <span className="text-sm">{b.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-200/60">
            <ShieldCheck className="h-4 w-4" />
            BLASTI · {c.consoleTitle} · {new Date().getFullYear()}
          </div>
        </aside>

        {/* Form panel */}
        <main className="flex-1 flex flex-col min-w-0">
          <header className="flex items-center justify-end gap-1 px-5 py-3">
            <LanguageSwitcher />
            <ThemeToggle />
          </header>
          <div className="flex-1 flex items-center justify-center px-5 py-8">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: 'easeOut' }}
              className="w-full max-w-md"
            >
              <div className={`relative rounded-2xl border border-emerald-100/80 dark:border-emerald-900/40 bg-white/85 dark:bg-gray-900/85 backdrop-blur-xl shadow-xl shadow-emerald-900/5 p-7 sm:p-9 ${shakeError ? 'animate-[shake_0.5s_ease-in-out]' : ''}`}>
                <style>{`
                  @keyframes shake {
                    0%, 100% { transform: translateX(0); }
                    10%, 50%, 90% { transform: translateX(-6px); }
                    30%, 70% { transform: translateX(6px); }
                  }
                `}</style>
                <div className="lg:hidden flex items-center gap-2.5 mb-6">
                  <img src="/logo.png" alt="BLASTI" width={40} height={40} className="h-10 w-10 object-contain rounded-lg" />
                  <span className="font-bold bg-gradient-to-r from-emerald-700 to-teal-600 bg-clip-text text-transparent">BLASTI</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300">{c.desktopBadge}</span>
                </div>
                <AnimatePresence mode="wait">
                  {authView === 'login' && (
                    <motion.div key="login" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      <div className="flex items-center gap-3 mb-1.5">
                        <span className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 grid place-items-center text-white shadow-md shadow-emerald-600/25">
                          <Building2 className="h-5 w-5" />
                        </span>
                        <div>
                          <h2 className="text-xl font-bold text-foreground">{c.signInTitle}</h2>
                          <p className="text-xs text-muted-foreground">{c.signInSubtitle}</p>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground mb-5 flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                        {t('loginAutoDetectHint')}
                      </p>
                      {loginFormBody('web')}
                    </motion.div>
                  )}
                  {authView === 'forgot-password' && (
                    <motion.div key="forgot" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      <h2 className="text-xl font-bold text-foreground mb-1">{t('forgotPasswordTitle')}</h2>
                      {forgotBody('web')}
                    </motion.div>
                  )}
                  {authView === 'reset-password' && (
                    <motion.div key="reset" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      <h2 className="text-xl font-bold text-foreground mb-1">{t('resetPasswordTitle')}</h2>
                      {resetBody('web')}
                    </motion.div>
                  )}
                  {authView === 'verify' && (
                    <motion.div key="verify" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      {verifyBody}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>
          <footer className="px-5 py-3 text-center text-[11px] text-muted-foreground">
            {t('rightsReserved')} · {t('version')}
          </footer>
        </main>

        {/* Task 2-b (sub-task 4) — full-sync consent dialog */}
        <AlertDialog open={showSyncConsent} onOpenChange={setShowSyncConsent}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('desktopSyncConsentTitle')}</AlertDialogTitle>
              <AlertDialogDescription>{t('desktopSyncConsentBody')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => { setShowSyncConsent(false); navigateToConsole() }}>
                {t('desktopSyncConsentNotNow')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={async () => {
                  setShowSyncConsent(false)
                  toast.info(t('desktopSyncConsentStarted'))
                  try {
                    const w = window as unknown as { electronAPI?: { fullSyncNow?: () => Promise<unknown>; initialCloudSync?: () => Promise<unknown> } }
                    if (typeof w.electronAPI?.fullSyncNow === 'function') {
                      await w.electronAPI.fullSyncNow()
                    } else if (typeof w.electronAPI?.initialCloudSync === 'function') {
                      await w.electronAPI.initialCloudSync()
                    }
                  } catch { /* non-critical — periodic sync handles it */ }
                  navigateToConsole()
                }}
              >
                {t('desktopSyncConsentNow')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    )
  }

  // ─── Layout: NATIVE (Capacitor apk) — touch-first full screen ──────────────
  if (mode === 'native') {
    return (
      <div
        className="min-h-dvh flex flex-col bg-gradient-to-b from-emerald-50/70 via-background to-background dark:from-emerald-950/30"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        data-login-mode="native"
      >
        <header className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="BLASTI" width={36} height={36} className="h-9 w-9 object-contain rounded-lg" />
            <span className="font-bold bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">BLASTI</span>
          </div>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-5 py-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
            className="w-full max-w-sm"
          >
            <div className={`relative ${shakeError ? 'animate-[shake_0.5s_ease-in-out]' : ''}`}>
              <style>{`
                @keyframes shake {
                  0%, 100% { transform: translateX(0); }
                  10%, 50%, 90% { transform: translateX(-6px); }
                  30%, 70% { transform: translateX(6px); }
                }
              `}</style>
              <div className="rounded-3xl border border-emerald-100/70 dark:border-emerald-900/40 bg-white/85 dark:bg-gray-900/85 backdrop-blur-xl shadow-xl shadow-emerald-900/5 p-6">
                <AnimatePresence mode="wait">
                  {authView === 'login' && (
                    <motion.div key="login" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      <div className="flex flex-col items-center text-center mb-6">
                        <div className="h-20 w-20 rounded-2xl overflow-hidden shadow-lg shadow-emerald-500/25 mb-3">
                          <img src="/logo.png" alt="BLASTI" width={80} height={80} className="h-full w-full object-contain" />
                        </div>
                        <h1 className="text-2xl font-bold text-foreground">{t('welcomeBack')}</h1>
                        <p className="text-sm text-muted-foreground mt-1">{m.welcomeSub}</p>
                        <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1.5">
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                          {t('loginAutoDetectHint')}
                        </p>
                      </div>
                      {loginFormBody('touch')}
                    </motion.div>
                  )}
                  {authView === 'forgot-password' && (
                    <motion.div key="forgot" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      <h2 className="text-xl font-bold text-foreground mb-4">{t('forgotPasswordTitle')}</h2>
                      {forgotBody('touch')}
                    </motion.div>
                  )}
                  {authView === 'reset-password' && (
                    <motion.div key="reset" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      <h2 className="text-xl font-bold text-foreground mb-4">{t('resetPasswordTitle')}</h2>
                      {resetBody('touch')}
                    </motion.div>
                  )}
                  {authView === 'verify' && (
                    <motion.div key="verify" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22 }}>
                      {verifyBody}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </main>

        <footer className="px-5 pb-4 text-center text-[11px] text-muted-foreground flex items-center justify-center gap-3">
          <span>{t('rightsReserved')} · {t('version')}</span>
          <button
            type="button"
            onClick={() => setDiagOpen(true)}
            aria-label={t('diagOpenButton')}
            className="h-8 w-8 grid place-items-center rounded-lg text-muted-foreground hover:text-foreground"
          >
            <LifeBuoy className="h-4 w-4" />
          </button>
        </footer>

        {/* Full-screen success overlay */}
        <AnimatePresence>
          {loginSuccess && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-md"
            >
              <motion.div
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                className="h-24 w-24 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 grid place-items-center shadow-2xl shadow-emerald-500/40"
              >
                <CheckCircle2 className="h-12 w-12 text-white" />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <MobileDiagnosticsSheet open={diagOpen} onOpenChange={setDiagOpen} />
      </div>
    )
  }

  // ─── Layout: WEB (any browser — desktop AND phone browsers) ────────────────
  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden" data-login-mode="web">
      {/* Animated background gradient + dot-grid pattern (brand identity) */}
      <div className="absolute inset-0 -z-10">
        <motion.div
          animate={{ backgroundPosition: ['0% 0%', '100% 100%', '0% 0%'] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 bg-[length:400%_400%] bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100/80 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/25"
        />
        <div className="absolute inset-0 dot-grid-pattern" />
        <motion.div
          animate={{ x: [0, 20, 0], y: [0, -15, 0] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-1/4 start-0 w-72 h-72 bg-emerald-200/30 dark:bg-emerald-800/15 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -15, 0], y: [0, 20, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
          className="absolute bottom-0 end-0 w-80 h-80 bg-teal-200/30 dark:bg-teal-800/15 rounded-full blur-3xl"
        />
      </div>

      {/* Top bar */}
      <header className="w-full px-4 py-3 flex items-center justify-between relative z-10">
        <Button variant="ghost" size="icon" onClick={goBack} className="h-10 w-10" aria-label={t('back')}>
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="h-10 w-10 rounded-xl overflow-hidden"
          >
            <img src="/logo.png" alt="BLASTI" width={40} height={40} className="h-full w-full object-contain" />
          </motion.div>
          <span className="font-bold bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">
            BLASTI
          </span>
        </div>
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      {/* Card */}
      <div className="flex-1 flex items-center justify-center px-4 py-8 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="w-full max-w-md"
        >
          <div className={`relative transition-transform duration-300 ${shakeError ? 'animate-[shake_0.5s_ease-in-out]' : ''}`}>
            <style>{`
              @keyframes shake {
                0%, 100% { transform: translateX(0); }
                10%, 50%, 90% { transform: translateX(-6px); }
                30%, 70% { transform: translateX(6px); }
              }
            `}</style>
            <div
              className={`absolute -inset-1 rounded-3xl bg-gradient-to-br from-emerald-400/20 to-teal-400/20 dark:from-emerald-500/10 dark:to-teal-500/10 blur-xl transition-opacity duration-700 ${loading ? 'opacity-100' : 'opacity-60'}`}
            />
            <div
              className={`absolute -inset-1 rounded-3xl bg-gradient-to-br from-red-400/25 to-rose-400/15 blur-xl transition-opacity duration-500 ${shakeError ? 'opacity-100' : 'opacity-0'}`}
            />
            <div className="relative rounded-3xl border border-emerald-100/70 dark:border-emerald-900/40 bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl shadow-xl shadow-emerald-900/5 p-7 sm:p-9 z-10">
              <AnimatePresence mode="wait">
                {authView === 'login' && (
                  <motion.div key="login" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                    <div className="flex flex-col items-center text-center mb-6">
                      <motion.div
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
                        className="h-20 w-20 rounded-2xl overflow-hidden shadow-lg shadow-emerald-500/25 mb-4"
                      >
                        <img src="/logo.png" alt="BLASTI" width={80} height={80} className="h-full w-full object-contain" />
                      </motion.div>
                      <h1 className="text-2xl font-bold text-foreground">{t('welcomeBack')}</h1>
                      <p className="text-sm text-muted-foreground mt-1.5 flex items-center gap-1.5">
                        <ShieldCheck className="h-4 w-4 text-emerald-600" />
                        {t('loginAutoDetectHint')}
                      </p>
                    </div>
                    {loginFormBody('web')}
                  </motion.div>
                )}
                {authView === 'forgot-password' && (
                  <motion.div key="forgot" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                    <h2 className="text-xl font-bold text-foreground mb-4">{t('forgotPasswordTitle')}</h2>
                    {forgotBody('web')}
                  </motion.div>
                )}
                {authView === 'reset-password' && (
                  <motion.div key="reset" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                    <h2 className="text-xl font-bold text-foreground mb-4">{t('resetPasswordTitle')}</h2>
                    {resetBody('web')}
                  </motion.div>
                )}
                {authView === 'verify' && (
                  <motion.div key="verify" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.25 }}>
                    {verifyBody}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Kiosk entry + footer */}
      <div className="relative z-10 pb-2 flex justify-center">
        <a
          href="/?mode=device&type=KIOSK"
          className="text-xs text-muted-foreground hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
        >
          {t('kioskMode')}
        </a>
      </div>
      <footer className="relative z-10 pb-5 text-center text-[11px] text-muted-foreground">
        {t('rightsReserved')} · {t('version')}
      </footer>

      <MobileDiagnosticsSheet open={diagOpen} onOpenChange={setDiagOpen} />
    </div>
  )
}

export default UnifiedLoginForm
