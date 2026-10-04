'use client';

/**
 * BLASTI — Dedicated MOBILE login (Task 78)
 *
 * The Capacitor app previously rendered the AGENCY console login
 * (DesktopAgencyLogin) because the view router branched on
 * `platform.isNative` — mobile customers could not even sign in with their
 * own accounts from the phone shell. This component is the mobile-first
 * replacement, shown when `platform.isCapacitor || platform.isMobile`.
 *
 * Design goals:
 *   - Customer-first: the role segmented control defaults to CUSTOMER.
 *   - Touch-first: 44px+ targets, h-12 inputs, big primary button, no
 *     two-panel layouts, no heavy animated borders (mobile GPUs).
 *   - Safe-area aware: auth screens render OUTSIDE PlatformFrame, so top
 *     and bottom insets are handled here.
 *   - Same auth contract as LoginForm: POST /api/auth/login → session or
 *     requiresVerification (shared VerificationStep) → setUser +
 *     setSessionToken + setNativeSessionToken (the Capacitor Bearer token —
 *     called UNCONDITIONALLY here, unlike the desktop login where it sits
 *     inside the Electron block).
 *   - Forgot/reset password flows included.
 *   - Local ar/en copy for mobile-specific strings (fr falls back to EN) —
 *     same pattern as VerificationStep / DesktopAgencyLogin.
 */

import { useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { apiClient, setNativeSessionToken } from '@/lib/api-client';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { ArrowLeft, ArrowRight, Loader2, Eye, EyeOff, CheckCircle2, UserRound, Building2 } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { UserRole } from '@/store/use-app-store';
import {
  VerificationStep,
  type VerificationPending,
  type VerificationTargets,
  type VerificationDev,
  type VerificationSuccess,
} from './verification-step';

// ─── Local bilingual copy (fr falls back to EN — global dicts untouched) ────

const MOBILE_LOGIN_COPY = {
  ar: {
    welcomeSub: 'سجّل دخولك للمتابعة إلى حسابك',
    accountType: 'نوع الحساب',
    iAmCustomer: 'عميل',
    iAmAgency: 'وكالة',
    forgotQuestion: 'نسيت كلمة المرور؟',
    sendResetCode: 'إرسال رابط الاستعادة',
    resetSentTitle: 'تم الإرسال',
    resetSentBody: 'إذا كان الحساب موجودًا فستصلك رسالة تحتوي رمز الاستعادة.',
    backToLogin: 'العودة لتسجيل الدخول',
    resetCodeLabel: 'رمز الاستعادة',
    resetTokenPlaceholder: 'الصق الرمز الذي استلمته',
    newPasswordLabel: 'كلمة المرور الجديدة',
    resetConfirm: 'تغيير كلمة المرور',
    resetDoneTitle: 'تم تغيير كلمة المرور',
    resetDoneBody: 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',
    newHere: 'جديد على بلاستي؟',
    createAccount: 'إنشاء حساب',
    signingIn: 'جارٍ تسجيل الدخول…',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
    verifyHeading: 'تأكيد الحساب',
  },
  en: {
    welcomeSub: 'Sign in to continue to your account',
    accountType: 'Account type',
    iAmCustomer: 'Customer',
    iAmAgency: 'Agency',
    forgotQuestion: 'Forgot password?',
    sendResetCode: 'Send reset link',
    resetSentTitle: 'Sent',
    resetSentBody: 'If the account exists, a message with a reset code is on its way.',
    backToLogin: 'Back to sign in',
    resetCodeLabel: 'Reset code',
    resetTokenPlaceholder: 'Paste the code you received',
    newPasswordLabel: 'New password',
    resetConfirm: 'Change password',
    resetDoneTitle: 'Password changed',
    resetDoneBody: 'You can now sign in with your new password.',
    newHere: 'New to BLASTI?',
    createAccount: 'Create an account',
    signingIn: 'Signing in…',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    verifyHeading: 'Verify your account',
  },
} as const;

type MobileAuthView = 'login' | 'forgot-password' | 'reset-password' | 'verify';

export function MobileLoginForm() {
  const { setUser, setView, setSessionToken } = useAppStore();
  const { t, lang } = useLanguage();
  const copy = MOBILE_LOGIN_COPY[lang === 'ar' ? 'ar' : 'en'];

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roleTab, setRoleTab] = useState<'customer' | 'agency'>('customer');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [authView, setAuthView] = useState<MobileAuthView>('login');

  // Pending OTP verification (Task 22-b contract — identical to LoginForm).
  const [verificationData, setVerificationData] = useState<{
    verificationToken: string;
    pending: VerificationPending;
    targets?: VerificationTargets | null;
    dev?: VerificationDev | null;
  } | null>(null);

  // Forgot / reset password state
  const [forgotUsername, setForgotUsername] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const getRoleFromTab = (tab: 'customer' | 'agency'): UserRole =>
    tab === 'agency' ? 'AGENCY_OWNER' : 'CUSTOMER';

  // ── Session bootstrap (mobile) ─────────────────────────────────────────
  // setUser flips isAuthenticated and routes by role (customer → customer
  // home, agency → dashboard). setSessionToken persists + resumes the sync
  // engine. setNativeSessionToken stores the cloud JWT under
  // blasti-session-token — on Capacitor EVERY apiClient request sends it as
  // Bearer, so it is called unconditionally (no-op on plain web).
  const bootstrapSession = useCallback(
    (user: unknown, token: string | undefined, successMsg: string) => {
      setLoginSuccess(true);
      setTimeout(() => {
        setUser(user as never);
        if (token) {
          setSessionToken(token);
          try { setNativeSessionToken(token); } catch { /* non-native runtime */ }
        }
        toast.success(successMsg);
        setLoginSuccess(false);
      }, 500);
    },
    [setUser, setSessionToken],
  );

  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      toast.error(t('requiredField'));
      return;
    }

    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: username.trim(),
          password,
          expectedRole: getRoleFromTab(roleTab),
          ...(rememberMe ? { rememberMe: true } : {}),
        }),
      });

      const data = await res.json();

      // ── Unverified account → OTP verification instead of a session ──
      if (res.ok && data.requiresVerification && data.verificationToken) {
        setVerificationData({
          verificationToken: data.verificationToken,
          pending: (data.pending ?? { email: true, phone: true }) as VerificationPending,
          targets: data.targets ?? null,
          dev: data.dev ?? null,
        });
        setAuthView('verify');
        return;
      }

      if (res.ok && data.user) {
        bootstrapSession(data.user, data.token, t('loginSuccess'));
      } else {
        if (data.error === 'wrongRoleError') {
          toast.error(t('wrongRoleError'), { description: t('wrongRoleHint') || t('selectRole') || '' });
        } else {
          toast.error(data.error || t('invalidCredentials'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  // OTP verified → issue the session (same contract as the direct login).
  const handleVerificationSuccess = (result: VerificationSuccess) => {
    setVerificationData(null);
    setAuthView('login');
    bootstrapSession(result.user, result.token, t('loginSuccess'));
  };

  const handleVerificationTokenInvalid = () => {
    setVerificationData(null);
    setAuthView('login');
  };

  const handleForgotPassword = async () => {
    if (!forgotUsername.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    setForgotLoading(true);
    try {
      await apiClient.post('/api/auth/forgot-password', { username: forgotUsername.trim() });
      setForgotSent(true);
      toast.success(t('forgotPasswordSuccess'));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('error'));
    } finally {
      setForgotLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!resetToken.trim() || !newPassword.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    if (newPassword.length < 6) {
      toast.error(t('passwordMinLength'));
      return;
    }
    setResetLoading(true);
    try {
      await apiClient.post('/api/auth/reset-password', { token: resetToken.trim(), newPassword });
      setResetDone(true);
      toast.success(t('resetPasswordSuccess'));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('error'));
    } finally {
      setResetLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (authView === 'login') handleLogin();
      else if (authView === 'forgot-password') handleForgotPassword();
      else if (authView === 'reset-password') handleResetPassword();
    }
  };

  const showSubBack = authView === 'forgot-password' || authView === 'reset-password';

  return (
    <div className="min-h-dvh flex flex-col bg-gradient-to-b from-emerald-50/70 via-background to-background dark:from-emerald-950/20">
      {/* Safe-area top inset (auth screens render outside PlatformFrame) */}
      <div aria-hidden className="w-full" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }} />

      {/* Header */}
      <header className="px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl overflow-hidden ring-1 ring-emerald-500/20">
            <img src="/logo.png" alt="BLASTI" width={36} height={36} className="h-full w-full object-contain" />
          </div>
          <span className="font-extrabold bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">
            BLASTI
          </span>
        </div>
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 px-5 pb-6 pt-2" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <AnimatePresence mode="wait">
          {authView === 'verify' && verificationData ? (
            <motion.div
              key="verify"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25 }}
            >
              <div className="mb-5 text-center">
                <h1 className="text-xl font-bold text-foreground">{copy.verifyHeading}</h1>
                <p className="text-sm text-muted-foreground mt-1">{copy.welcomeSub}</p>
              </div>
              <VerificationStep
                verificationToken={verificationData.verificationToken}
                pending={verificationData.pending}
                targets={verificationData.targets}
                dev={verificationData.dev}
                lang={lang}
                onVerified={handleVerificationSuccess}
                onTokenInvalid={handleVerificationTokenInvalid}
                onBack={() => {
                  setVerificationData(null);
                  setAuthView('login');
                }}
              />
            </motion.div>
          ) : authView === 'forgot-password' ? (
            <motion.div
              key="forgot"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25 }}
              className="max-w-md mx-auto w-full"
            >
              {showSubBack && (
                <button
                  type="button"
                  onClick={() => { setAuthView('login'); setForgotSent(false); }}
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground mb-4 min-h-[44px] active:text-foreground"
                >
                  <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
                  {copy.backToLogin}
                </button>
              )}

              {resetDone || forgotSent ? (
                <div className="text-center py-8 space-y-4">
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                    className="mx-auto h-16 w-16 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center"
                  >
                    <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                  </motion.div>
                  <div className="space-y-1.5">
                    <h2 className="text-lg font-bold text-foreground">
                      {forgotSent ? copy.resetSentTitle : copy.resetDoneTitle}
                    </h2>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {forgotSent ? copy.resetSentBody : copy.resetDoneBody}
                    </p>
                  </div>
                  <Button
                    onClick={() => {
                      setAuthView('login');
                      setForgotSent(false);
                      setResetDone(false);
                      setResetToken('');
                      setNewPassword('');
                    }}
                    className="h-12 px-6 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-semibold"
                  >
                    {copy.backToLogin}
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <h1 className="text-2xl font-extrabold text-foreground">{t('forgotPasswordTitle')}</h1>
                    <p className="text-sm text-muted-foreground mt-1">{t('forgotPassword') }</p>
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="m-forgot-username" className="text-xs font-semibold text-muted-foreground">
                      {t('username')}
                    </label>
                    <Input
                      id="m-forgot-username"
                      value={forgotUsername}
                      onChange={(e) => setForgotUsername(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t('username')}
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="h-12 rounded-xl text-base"
                    />
                  </div>

                  <Button
                    onClick={handleForgotPassword}
                    disabled={forgotLoading}
                    className="w-full h-12 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-semibold text-base"
                  >
                    {forgotLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : t('forgotPassword')}
                  </Button>

                  {/* Direct reset-code entry (users often already have the code) */}
                  <button
                    type="button"
                    onClick={() => { setAuthView('reset-password'); setForgotSent(false); }}
                    className="w-full text-center text-sm text-emerald-600 dark:text-emerald-400 font-medium min-h-[44px]"
                  >
                    {copy.resetCodeLabel} →
                  </button>
                </div>
              )}
            </motion.div>
          ) : authView === 'reset-password' ? (
            <motion.div
              key="reset"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25 }}
              className="max-w-md mx-auto w-full"
            >
              <button
                type="button"
                onClick={() => { setAuthView('login'); setResetDone(false); }}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground mb-4 min-h-[44px] active:text-foreground"
              >
                <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
                {copy.backToLogin}
              </button>

              {resetDone ? (
                <div className="text-center py-8 space-y-4">
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                    className="mx-auto h-16 w-16 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center"
                  >
                    <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                  </motion.div>
                  <h2 className="text-lg font-bold text-foreground">{copy.resetDoneTitle}</h2>
                  <p className="text-sm text-muted-foreground">{copy.resetDoneBody}</p>
                  <Button
                    onClick={() => { setAuthView('login'); setResetDone(false); }}
                    className="h-12 px-6 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold"
                  >
                    {copy.backToLogin}
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <h1 className="text-2xl font-extrabold text-foreground">{t('resetPasswordTitle')}</h1>

                  <div className="space-y-1.5">
                    <label htmlFor="m-reset-token" className="text-xs font-semibold text-muted-foreground">{copy.resetCodeLabel}</label>
                    <Input
                      id="m-reset-token"
                      value={resetToken}
                      onChange={(e) => setResetToken(e.target.value)}
                      placeholder={copy.resetTokenPlaceholder}
                      className="h-12 rounded-xl text-base"
                      dir="ltr"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label htmlFor="m-reset-password" className="text-xs font-semibold text-muted-foreground">{copy.newPasswordLabel}</label>
                    <div className="relative">
                      <Input
                        id="m-reset-password"
                        type={showPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={copy.newPasswordLabel}
                        className="h-12 rounded-xl text-base pe-11"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? copy.hidePassword : copy.showPassword}
                        className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground p-1"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <Button
                    onClick={handleResetPassword}
                    disabled={resetLoading}
                    className="w-full h-12 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-semibold text-base"
                  >
                    {resetLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : copy.resetConfirm}
                  </Button>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="login"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.25 }}
              className="max-w-md mx-auto w-full"
            >
              {/* Welcome hero */}
              <div className="text-center mb-6 pt-2">
                <motion.div
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                  className="mx-auto mb-3 h-16 w-16 rounded-2xl overflow-hidden shadow-lg shadow-emerald-500/20 ring-1 ring-emerald-500/20"
                >
                  <img src="/logo.png" alt="BLASTI" width={64} height={64} className="h-full w-full object-contain" />
                </motion.div>
                <h1 className="text-2xl font-extrabold text-foreground">{t('welcomeBack')}</h1>
                <p className="text-sm text-muted-foreground mt-1">{copy.welcomeSub}</p>
              </div>

              {/* Role segmented control — customer-first */}
              <div className="mb-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 px-1">{copy.accountType}</p>
                <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-muted/70 dark:bg-muted/30" role="tablist" aria-label={copy.accountType}>
                  {([
                    { key: 'customer' as const, label: copy.iAmCustomer, icon: UserRound },
                    { key: 'agency' as const, label: copy.iAmAgency, icon: Building2 },
                  ]).map((opt) => {
                    const active = roleTab === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setRoleTab(opt.key)}
                        className={`relative h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition-all duration-200 min-h-[44px] ${
                          active
                            ? 'bg-white dark:bg-gray-800 shadow-md text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground active:bg-black/5 dark:active:bg-white/5'
                        }`}
                      >
                        <opt.icon className="h-4 w-4" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Fields */}
              <div className="space-y-3.5" onKeyDown={handleKeyDown}>
                <div className="space-y-1.5">
                  <label htmlFor="m-login-username" className="text-xs font-semibold text-muted-foreground px-1">{t('username')}</label>
                  <Input
                    id="m-login-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('username')}
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="username"
                    enterKeyHint="next"
                    className="h-12 rounded-xl text-base bg-white/80 dark:bg-gray-900/60"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="m-login-password" className="text-xs font-semibold text-muted-foreground px-1">{t('password')}</label>
                  <div className="relative">
                    <Input
                      id="m-login-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      enterKeyHint="go"
                      className="h-12 rounded-xl text-base bg-white/80 dark:bg-gray-900/60 pe-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? copy.hidePassword : copy.showPassword}
                      className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground p-1.5"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {/* Remember me + forgot */}
                <div className="flex items-center justify-between py-1">
                  {/* label (not <button>) — the Radix Checkbox renders its own
                      <button> and nested buttons are invalid HTML (hydration
                      warning surfaced in the mobile login smoke test). */}
                  <label
                    htmlFor="m-remember"
                    className="flex items-center gap-2.5 min-h-[44px] pe-2 cursor-pointer"
                  >
                    <Checkbox id="m-remember" checked={rememberMe} onCheckedChange={(c) => setRememberMe(c === true)} />
                    <span className="text-sm text-muted-foreground">{t('rememberMe')}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setAuthView('forgot-password')}
                    className="text-sm font-medium text-emerald-600 dark:text-emerald-400 min-h-[44px]"
                  >
                    {copy.forgotQuestion}
                  </button>
                </div>

                {/* Primary action */}
                <Button
                  onClick={handleLogin}
                  disabled={loading || loginSuccess}
                  className="w-full h-13 min-h-[52px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 active:scale-[0.99] transition-transform text-white font-bold text-base shadow-lg shadow-emerald-500/25"
                >
                  {loading ? (<><Loader2 className="h-5 w-5 animate-spin" /> {copy.signingIn}</>) : (<>{t('login')} <ArrowRight className="h-4 w-4 rtl:rotate-180" /></>)}
                </Button>
              </div>

              {/* Register link */}
              <p className="text-center text-sm text-muted-foreground mt-6">
                {copy.newHere}{' '}
                <button
                  type="button"
                  onClick={() => setView('register')}
                  className="font-bold text-emerald-600 dark:text-emerald-400 min-h-[44px] inline-flex items-center"
                >
                  {copy.createAccount}
                </button>
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Success overlay */}
      <AnimatePresence>
        {loginSuccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center"
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 260, damping: 18 }}
              className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shadow-2xl shadow-emerald-500/40"
            >
              <CheckCircle2 className="h-10 w-10 text-white" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Safe-area bottom inset */}
      <div aria-hidden className="w-full safe-area-bottom" style={{ minHeight: 'env(safe-area-inset-bottom, 0px)' }} />
    </div>
  );
}
