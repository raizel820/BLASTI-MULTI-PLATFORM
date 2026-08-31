'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { ArrowLeft, Loader2, Eye, EyeOff, CheckCircle2, KeyRound, Mail, Ticket, Tablet } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { UserRole } from '@/store/use-app-store';
import { usePlatform } from '@/hooks/use-platform';

export function LoginForm() {
  const { setUser, setView, goBack, setSessionToken } = useAppStore();
  const { t } = useLanguage();
  const { platform } = usePlatform();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roleTab, setRoleTab] = useState<string>('customer');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [shakeError, setShakeError] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [authView, setAuthView] = useState<'login' | 'forgot-password' | 'reset-password'>('login');
  const [forgotUsername, setForgotUsername] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const triggerShake = useCallback(() => {
    setShakeError(true);
    setTimeout(() => setShakeError(false), 600);
  }, []);

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
        body: JSON.stringify({ username: username.trim(), password, expectedRole: getRoleFromTab(roleTab), ...(rememberMe ? { rememberMe: true } : {}) }),
      });

      const data = await res.json();

      if (res.ok && data.user) {
        setLoginSuccess(true);
        setTimeout(() => {
          setUser(data.user);
          if (data.token) {
            setSessionToken(data.token);
            // ── Electron: Establish local API session for LAN failover ──
            // When cloud goes down, requests fall back to localhost:3080 (local API).
            // The local API needs its own session token to authorize requests.
            // We use import-session (not local login) because the local SQLite
            // database may be empty (no synced user data).
            try {
              const w = window as any;
              const isElectron = navigator.userAgent.includes('Electron') || w.electronAPI;
              if (isElectron) {
                // 1. Store the token so buildAuthHeaders() sends it with LAN requests
                localStorage.setItem('blasti-local-api-token', data.token);

                // 2. Import session directly into the local API via IPC bridge
                //    This sets sessionToken + sessionUser in the main process module
                if (w.electronAPI?.setLocalApiSession) {
                  w.electronAPI.setLocalApiSession({ token: data.token, user: data.user });
                }

                // 3. Also call the HTTP import-session endpoint as a backup
                //    (in case IPC bridge isn't wired up correctly)
                if (!res.url || !res.url.includes('localhost:3080')) {
                  fetch('http://127.0.0.1:3080/api/auth/import-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'omit',
                    body: JSON.stringify({ token: data.token, user: data.user }),
                  }).catch(() => { /* non-critical */ });
                }

                // 4. Trigger initial cloud→local sync to pull agency data
                //    This downloads all agency tables (Services, Branches, Counters,
                //    Reservations, etc.) into the local SQLite for offline use.
                if (w.electronAPI?.initialCloudSync) {
                  w.electronAPI.initialCloudSync().then((syncResult: any) => {
                    if (syncResult?.success) {
                      console.log('[Login] Initial sync complete:', syncResult.pulled, 'records pulled');
                    }
                  }).catch(() => { /* non-critical — periodic sync will handle it */ });
                }
              }
            } catch { /* ignore */ }
          }
          toast.success(t('loginSuccess'));
          setLoginSuccess(false);
        }, 600);
      } else {
        triggerShake();
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (authView === 'login') handleLogin();
      else if (authView === 'forgot-password') handleForgotPassword();
      else if (authView === 'reset-password') handleResetPassword();
    }
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
      const message = err instanceof Error ? err.message : t('error');
      toast.error(message);
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
      const message = err instanceof Error ? err.message : t('error');
      toast.error(message);
    } finally {
      setResetLoading(false);
    }
  };

  const getRoleFromTab = (tab: string): UserRole => {
    switch (tab) {
      case 'agency': return 'AGENCY_OWNER';
      default: return 'CUSTOMER';
    }
  };

  const isFocused = focusedField !== null;

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Animated background gradient + dot-grid pattern */}
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
        <motion.div
          animate={{ y: [0, -20, 0], x: [0, 10, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-[40%] end-[20%] w-32 h-32 bg-emerald-300/10 dark:bg-emerald-700/5 rounded-full blur-2xl"
        />
      </div>

      {/* Top Bar */}
      <header className="w-full px-4 py-3 flex items-center justify-between relative z-10">
        {!platform.isNative ? (
          <Button variant="ghost" size="icon" onClick={goBack} className="h-10 w-10">
            <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
          </Button>
        ) : (
          <div className="w-10" />
        )}
        <div className="flex items-center gap-2">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="h-12 w-12 rounded-xl overflow-hidden"
          >
            <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
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

      {/* Login Form */}
      <div className="flex-1 flex items-center justify-center px-4 py-8 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="w-full max-w-md"
        >
          <div className={`relative transition-transform duration-300 ${isFocused ? 'scale-[1.01]' : ''} ${shakeError ? 'animate-[shake_0.5s_ease-in-out]' : ''}`}>
            <div className="absolute -inset-[2px] rounded-2xl overflow-hidden">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                className="absolute inset-0 bg-[conic-gradient(from_0deg,transparent,theme(colors.emerald.400),theme(colors.teal.400),theme(colors.cyan.400),transparent)] opacity-60"
              />
              <div className="absolute inset-[2px] rounded-2xl bg-white dark:bg-gray-900" />
            </div>
            <div
              className={`absolute -inset-1 rounded-2xl bg-gradient-to-br from-emerald-400/20 to-teal-400/20 dark:from-emerald-500/10 dark:to-teal-500/10 blur-xl transition-opacity duration-700 ${isFocused ? 'opacity-100' : 'opacity-0'}`}
            />
            <div
              className={`absolute -inset-1 rounded-2xl bg-gradient-to-br from-red-400/25 to-rose-400/15 blur-xl transition-opacity duration-500 ${shakeError ? 'opacity-100' : 'opacity-0'}`}
            />
            <style>{`
              @keyframes shake {
                0%, 100% { transform: translateX(0); }
                10%, 50%, 90% { transform: translateX(-6px); }
                30%, 70% { transform: translateX(6px); }
              }
            `}</style>
            <Card className="relative shadow-xl border-0 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md z-10">
              <CardHeader className="text-center pb-2">
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
                  className="mx-auto mb-3 h-24 w-24 rounded-2xl overflow-hidden shadow-lg shadow-emerald-500/25"
                >
                  <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                </motion.div>
                <CardTitle className="text-2xl font-bold text-foreground">
                  {authView === 'login' && t('login')}
                  {authView === 'forgot-password' && t('forgotPasswordTitle')}
                  {authView === 'reset-password' && t('resetPasswordTitle')}
                </CardTitle>
              </CardHeader>
              <AnimatePresence mode="wait">
                {authView === 'login' && (
                  <motion.div
                    key="login"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.25 }}
                  >
                    <CardContent className="space-y-5 pt-4">
                      {/* Role Tabs */}
                      <Tabs value={roleTab} onValueChange={setRoleTab} className="w-full">
                        <div className="text-center mb-2">
                          <p className="text-xs text-muted-foreground">{t('selectRole')}</p>
                        </div>
                        <TabsList className="w-full grid grid-cols-2 h-12 relative bg-gray-100 dark:bg-gray-800 rounded-xl p-1 overflow-hidden">
                          {[
                            { value: 'customer', label: t('loginAsCustomer') },
                            { value: 'agency', label: t('loginAsAgency') },
                          ].map((tab) => (
                            <TabsTrigger
                              key={tab.value}
                              value={tab.value}
                              className="text-xs sm:text-sm rounded-lg relative z-10 transition-all duration-300 data-[state=active]:bg-gradient-to-r data-[state=active]:from-emerald-500 data-[state=active]:to-teal-500 data-[state=active]:text-white data-[state=active]:shadow-lg data-[state=active]:shadow-emerald-500/25 data-[state=active]:scale-[1.02]"
                            >
                              {tab.label}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                      </Tabs>

                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <Label htmlFor="username" className={`transition-all duration-300 text-sm ${focusedField === 'username' ? 'text-emerald-600 dark:text-emerald-400 font-semibold scale-[1.02] origin-left rtl:origin-right' : ''}`}>{t('username')}</Label>
                          <div className="relative">
                            <Input
                              id="username"
                              placeholder={t('username')}
                              value={username}
                              onChange={(e) => setUsername(e.target.value)}
                              onKeyDown={handleKeyDown}
                              onFocus={() => setFocusedField('username')}
                              onBlur={() => setFocusedField(null)}
                              className={`h-12 text-base transition-all duration-300 border-2 ${focusedField === 'username' ? 'border-emerald-400 dark:border-emerald-600 ring-4 ring-emerald-500/10 shadow-[0_0_0_3px_rgba(16,185,129,0.1)]' : 'border-border'}`}
                              autoComplete="username"
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="password" className={`transition-all duration-300 text-sm ${focusedField === 'password' ? 'text-emerald-600 dark:text-emerald-400 font-semibold scale-[1.02] origin-left rtl:origin-right' : ''}`}>{t('password')}</Label>
                          <div className="relative">
                            <Input
                              id="password"
                              type={showPassword ? 'text' : 'password'}
                              placeholder={t('password')}
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              onKeyDown={handleKeyDown}
                              onFocus={() => setFocusedField('password')}
                              onBlur={() => setFocusedField(null)}
                              className={`h-12 text-base pe-12 transition-all duration-300 border-2 ${focusedField === 'password' ? 'border-emerald-400 dark:border-emerald-600 ring-4 ring-emerald-500/10 shadow-[0_0_0_3px_rgba(16,185,129,0.1)]' : 'border-border'}`}
                              autoComplete="current-password"
                            />
                            <button
                              type="button"
                              onClick={() => setShowPassword(!showPassword)}
                              className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                              tabIndex={-1}
                            >
                              {showPassword ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                    <CardFooter className="flex-col gap-4 pt-2 pb-6">
                      <div className="flex items-center gap-2 w-full">
                        <button
                          type="button"
                          onClick={() => setRememberMe(!rememberMe)}
                          className="flex items-center gap-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors group"
                        >
                          <div className={`h-5 w-5 rounded-md border-2 flex items-center justify-center transition-all duration-300 ${rememberMe ? 'border-emerald-400 dark:border-emerald-500 bg-gradient-to-br from-emerald-500 to-teal-500 shadow-md shadow-emerald-500/20 scale-110' : 'border-muted-foreground/40 dark:border-muted-foreground/30 bg-transparent group-hover:border-emerald-300 dark:group-hover:border-emerald-700 group-hover:scale-105'}`}>
                            {rememberMe && (
                              <motion.div
                                initial={{ scale: 0, rotate: -45 }}
                                animate={{ scale: 1, rotate: 0 }}
                                transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                              >
                                <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                              </motion.div>
                            )}
                          </div>
                          {t('rememberMe')}
                        </button>
                      </div>
                      <AnimatePresence mode="wait">
                        {loginSuccess ? (
                          <motion.div
                            key="success"
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            className="w-full h-12 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold text-base flex items-center justify-center gap-2 relative overflow-hidden"
                          >
                            <motion.div
                              animate={{ opacity: [0.3, 0.6, 0.3], scale: [1, 1.2, 1] }}
                              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                              className="absolute inset-0 bg-gradient-to-r from-emerald-400/30 to-teal-400/30 blur-sm"
                            />
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: [0, 1.3, 1] }}
                              transition={{ duration: 0.6, ease: 'easeOut' }}
                              className="relative z-10"
                            >
                              <CheckCircle2 className="h-5 w-5" />
                            </motion.div>
                            <span className="relative z-10">{t('loginSuccess')}</span>
                          </motion.div>
                        ) : (
                          <motion.div key="button" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="w-full relative">
                            <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-emerald-500/40 via-teal-500/30 to-cyan-500/40 blur-lg opacity-0 hover:opacity-100 transition-opacity duration-500 group" />
                            <Button
                              className="relative w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold text-base rounded-xl shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/40 transition-all duration-300 hover:scale-[1.02] z-10"
                              onClick={handleLogin}
                              disabled={loading}
                            >
                              {loading ? (
                                <motion.div animate={{ rotate: 360 }} transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }} className="flex items-center gap-2">
                                  <Ticket className="h-4 w-4" />
                                  <span className="text-sm opacity-80">{t('loading')}</span>
                                </motion.div>
                              ) : t('login')}
                            </Button>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <button
                        type="button"
                        onClick={() => { setAuthView('forgot-password'); setForgotSent(false); }}
                        className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors duration-200 hover:underline underline-offset-2 text-center"
                      >
                        {t('forgotPasswordHelp')}
                      </button>

                      {/* Divider + social / kiosk login options */}
                      <div className="w-full space-y-2.5 pt-2">
                        <div className="relative">
                          <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-border" />
                          </div>
                          <div className="relative flex justify-center text-xs">
                            <span className="bg-white/95 dark:bg-gray-900/95 px-3 text-muted-foreground">{t('orContinueWith')}</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2.5">
                          <div className="relative group/social1">
                            <motion.button
                              type="button"
                              disabled
                              whileHover={{ scale: 1.03, y: -2 }}
                              whileTap={{ scale: 0.97 }}
                              className="w-full h-11 rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground cursor-not-allowed opacity-60 transition-all duration-300 group-hover/social1:border-emerald-300 dark:group-hover/social1:border-emerald-700 group-hover/social1:shadow-lg group-hover/social1:shadow-emerald-500/10 group-hover/social1:opacity-80"
                            >
                              <svg className="h-4 w-4" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                              </svg>
                              Google
                            </motion.button>
                            <span className="absolute -top-2 -end-2 px-2 py-0.5 text-[10px] font-bold bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 rounded-full shadow-sm">
                              {t('comingSoon') || 'Coming Soon'}
                            </span>
                          </div>
                          {/* Kiosk Mode Button — redirects to real kiosk page */}
                          <a
                            href="/?mode=device&type=KIOSK"
                            className="w-full h-11 rounded-xl border-2 border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300 cursor-pointer transition-all duration-300 hover:border-amber-400 dark:hover:border-amber-500 hover:shadow-lg hover:shadow-amber-500/10"
                          >
                            <Tablet className="h-4 w-4" />
                            {t('kioskMode')}
                          </a>
                        </div>
                      </div>

                      <p className="text-sm text-muted-foreground">
                        {t('noAccount')}{' '}
                        <button
                          className="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline underline-offset-2 transition-all"
                          onClick={() => setView('register')}
                        >
                          {t('register')}
                        </button>
                      </p>
                    </CardFooter>
                  </motion.div>
                )}

                {authView === 'forgot-password' && (
                  <motion.div
                    key="forgot"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ duration: 0.25 }}
                  >
                    <CardContent className="space-y-5 pt-4">
                      <p className="text-sm text-muted-foreground text-center">
                        {t('forgotPasswordDesc')}
                      </p>

                      <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 p-3">
                        <p className="text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
                          <KeyRound className="h-4 w-4 mt-0.5 shrink-0" />
                          {t('devTokenHint')}
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="forgot-username" className="text-sm">{t('username')}</Label>
                        <div className="relative">
                          <Input
                            id="forgot-username"
                            placeholder={t('username')}
                            value={forgotUsername}
                            onChange={(e) => setForgotUsername(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onFocus={() => setFocusedField('forgot-username')}
                            onBlur={() => setFocusedField(null)}
                            className={`h-12 text-base transition-all duration-300 border-2 ps-12 ${focusedField === 'forgot-username' ? 'border-emerald-400 dark:border-emerald-600 ring-4 ring-emerald-500/10' : 'border-border'}`}
                            autoComplete="username"
                          />
                          <Mail className="absolute start-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>

                      {forgotSent && (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-3"
                        >
                          <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
                            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                            {t('forgotPasswordSuccess')}
                          </p>
                        </motion.div>
                      )}
                    </CardContent>
                    <CardFooter className="flex-col gap-4 pt-2 pb-6">
                      <Button
                        className="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold text-base rounded-xl shadow-lg shadow-emerald-500/20 hover:shadow-xl hover:shadow-emerald-500/30 transition-all duration-300 hover:scale-[1.01]"
                        onClick={handleForgotPassword}
                        disabled={forgotLoading}
                      >
                        {forgotLoading ? (
                          <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} className="flex items-center gap-2">
                            <Loader2 className="h-4 w-4" />
                            <span className="text-sm opacity-80">{t('loading')}</span>
                          </motion.div>
                        ) : t('forgotPasswordRequest')}
                      </Button>

                      {forgotSent && (
                        <Button
                          variant="outline"
                          className="w-full h-12 rounded-xl border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                          onClick={() => { setAuthView('reset-password'); setResetDone(false); }}
                        >
                          <KeyRound className="h-4 w-4 me-2" />
                          {t('resetPasswordTitle')}
                        </Button>
                      )}

                      <button
                        type="button"
                        onClick={() => setAuthView('login')}
                        className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors duration-200 hover:underline underline-offset-2 text-center"
                      >
                        {t('backToLogin')}
                      </button>
                    </CardFooter>
                  </motion.div>
                )}

                {authView === 'reset-password' && (
                  <motion.div
                    key="reset"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    transition={{ duration: 0.25 }}
                  >
                    <CardContent className="space-y-5 pt-4">
                      <p className="text-sm text-muted-foreground text-center">
                        {t('resetPasswordDesc')}
                      </p>

                      {resetDone ? (
                        <motion.div
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-4 flex flex-col items-center gap-3"
                        >
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: 'spring', stiffness: 300 }}
                          >
                            <CheckCircle2 className="h-10 w-10 text-emerald-600" />
                          </motion.div>
                          <p className="text-sm text-emerald-700 dark:text-emerald-300 font-medium text-center">
                            {t('resetPasswordSuccess')}
                          </p>
                        </motion.div>
                      ) : (
                        <>
                          <div className="space-y-1.5">
                            <Label htmlFor="reset-token" className="text-sm">{t('resetTokenLabel')}</Label>
                            <div className="relative">
                              <Input
                                id="reset-token"
                                placeholder={t('resetTokenPlaceholder')}
                                value={resetToken}
                                onChange={(e) => setResetToken(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onFocus={() => setFocusedField('reset-token')}
                                onBlur={() => setFocusedField(null)}
                                className={`h-12 text-base font-mono text-xs transition-all duration-300 border-2 ps-12 ${focusedField === 'reset-token' ? 'border-emerald-400 dark:border-emerald-600 ring-4 ring-emerald-500/10' : 'border-border'}`}
                              />
                              <KeyRound className="absolute start-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="new-password" className="text-sm">{t('newPassword')}</Label>
                            <div className="relative">
                              <Input
                                id="new-password"
                                type={showPassword ? 'text' : 'password'}
                                placeholder={t('newPassword')}
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onFocus={() => setFocusedField('new-password')}
                                onBlur={() => setFocusedField(null)}
                                className={`h-12 text-base pe-12 transition-all duration-300 border-2 ${focusedField === 'new-password' ? 'border-emerald-400 dark:border-emerald-600 ring-4 ring-emerald-500/10' : 'border-border'}`}
                                autoComplete="new-password"
                              />
                              <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                                tabIndex={-1}
                              >
                                {showPassword ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </CardContent>
                    <CardFooter className="flex-col gap-4 pt-2 pb-6">
                      {!resetDone ? (
                        <Button
                          className="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold text-base rounded-xl shadow-lg shadow-emerald-500/20 hover:shadow-xl hover:shadow-emerald-500/30 transition-all duration-300 hover:scale-[1.01]"
                          onClick={handleResetPassword}
                          disabled={resetLoading}
                        >
                          {resetLoading ? (
                            <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }} className="flex items-center gap-2">
                              <Loader2 className="h-4 w-4" />
                              <span className="text-sm opacity-80">{t('loading')}</span>
                            </motion.div>
                          ) : t('resetPasswordSubmit')}
                        </Button>
                      ) : (
                        <Button
                          className="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold text-base rounded-xl shadow-lg shadow-emerald-500/20"
                          onClick={() => { setAuthView('login'); setResetDone(false); }}
                        >
                          {t('login')}
                        </Button>
                      )}

                      <button
                        type="button"
                        onClick={() => setAuthView('forgot-password')}
                        className="text-xs text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors duration-200 hover:underline underline-offset-2 text-center"
                      >
                        {t('backToLogin')}
                      </button>
                    </CardFooter>
                  </motion.div>
                )}
              </AnimatePresence>
            </Card>
          </div>

          {/* Branded Footer */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="mt-6 flex flex-col items-center gap-2"
          >
            <div className="flex items-center gap-2">
              <div className="h-10 w-10 rounded-lg overflow-hidden shadow-sm">
                <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
              </div>
              <span className="text-xs font-semibold bg-gradient-to-r from-emerald-700 to-teal-600 dark:from-emerald-400 dark:to-teal-300 bg-clip-text text-transparent">
                BLASTI
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground/50">{t('rightsReserved')} · {t('version')}</p>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
