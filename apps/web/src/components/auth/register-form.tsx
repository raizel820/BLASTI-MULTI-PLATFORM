'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useUpload } from '@/hooks/use-upload';
import { getProxiedUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
// Select removed - using custom role selector cards
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { ArrowLeft, ArrowRight, Loader2, Eye, EyeOff, UserPlus, Shield, Camera, Check, CircleDot, X, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { UserRole } from '@/store/use-app-store';

// FloatingInput component defined OUTSIDE RegisterForm to prevent remounting on state changes
function FloatingInput({ id, label, type = 'text', value, onChange, onFocus, onBlur, placeholder, dir, prefix, suffix, children, hasToggle, toggleVisible, onToggle, focusedField, error }: {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  placeholder?: string;
  dir?: string;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  children?: React.ReactNode;
  hasToggle?: boolean;
  toggleVisible?: boolean;
  onToggle?: () => void;
  focusedField: string | null;
  error?: string | null;
}) {
  const isActive = focusedField === id || value.length > 0;
  const hasError = !!error;
  return (
    <div className="relative space-y-1">
      <div className={`relative flex items-center rounded-xl border transition-colors duration-200 ${
        hasError
          ? 'border-red-400 ring-2 ring-red-500/20 bg-white dark:bg-gray-900 shadow-sm'
          : focusedField === id
            ? 'border-emerald-400 ring-2 ring-emerald-500/20 dark:ring-emerald-400/20 bg-white dark:bg-gray-900 shadow-sm'
            : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50'
      }`}>
        {prefix && <div className="ps-3.5 flex-shrink-0">{prefix}</div>}
        <div className="relative flex-1">
          <input
            id={id}
            type={type}
            value={value}
            onChange={onChange}
            onFocus={onFocus}
            onBlur={onBlur}
            placeholder={isActive ? placeholder : ' '}
            dir={dir}
            className={`peer h-12 w-full bg-transparent px-3.5 text-base text-foreground outline-none placeholder:text-muted-foreground/60 ${prefix ? 'ps-0' : ''} ${hasToggle ? 'pe-10' : ''}`}
            autoComplete={type === 'password' ? 'new-password' : id === 'reg-username' ? 'username' : undefined}
          />
          <label
            htmlFor={id}
            className={`pointer-events-none absolute transition-all duration-200 ease-out ${
              isActive
                ? `top-1.5 text-[10px] font-semibold ${hasError ? 'text-red-500 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`
                : 'top-1/2 -translate-y-1/2 text-sm text-muted-foreground'
            } ${prefix ? 'start-3.5' : 'start-3.5'}`}
          >
            {label}
          </label>
        </div>
        {hasToggle && toggleVisible !== undefined && onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
            tabIndex={-1}
          >
            {toggleVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
        {suffix && <div className="pe-3.5 flex-shrink-0">{suffix}</div>}
      </div>
      {/* Inline error message */}
      <AnimatePresence>
        {hasError && (
          <motion.div
            initial={{ opacity: 0, height: 0, y: -4 }}
            animate={{ opacity: 1, height: 'auto', y: 0 }}
            exit={{ opacity: 0, height: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-1.5 px-1 pt-0.5">
              <AlertCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
              <span className="text-[11px] text-red-500 dark:text-red-400 leading-tight">{error}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const STEPS = [
  { id: 1, label: 'account', labelKey: 'account' as const },
  { id: 2, label: 'profile', labelKey: 'fullName' as const },
  { id: 3, label: 'confirm', labelKey: 'confirm' as const },
];

function getPasswordStrength(password: string): { score: number; label: string; labelKey: string; color: string; bgColor: string; textColor: string } {
  let score = 0;
  if (password.length >= 6) score++;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score: 20, label: 'Weak', labelKey: 'weak', color: 'bg-red-500', bgColor: 'bg-red-100 dark:bg-red-900/30', textColor: 'text-red-500' };
  if (score <= 2) return { score: 40, label: 'Fair', labelKey: 'fair', color: 'bg-orange-500', bgColor: 'bg-orange-100 dark:bg-orange-900/30', textColor: 'text-orange-500' };
  if (score <= 3) return { score: 60, label: 'Good', labelKey: 'good', color: 'bg-yellow-500', bgColor: 'bg-yellow-100 dark:bg-yellow-900/30', textColor: 'text-yellow-500' };
  if (score <= 4) return { score: 80, label: 'Strong', labelKey: 'strong', color: 'bg-emerald-500', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30', textColor: 'text-emerald-500' };
  return { score: 100, label: 'Very Strong', labelKey: 'veryStrong', color: 'bg-emerald-600', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30', textColor: 'text-emerald-600' };
}

// Username availability check with debounce
function useUsernameAvailability(username: string) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkUsername = useCallback(async (name: string) => {
    // Cancel any pending request
    if (abortRef.current) abortRef.current.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!name || name.trim().length < 3) {
      setStatus('idle');
      return;
    }

    // Debounce: 500ms
    setStatus('checking');
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await apiFetch(`/api/auth/check-username?username=${encodeURIComponent(name.trim())}`, {
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        const data = await res.json();
        if (data.available) {
          setStatus('available');
        } else {
          setStatus('taken');
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      }
    }, 500);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { status, checkUsername };
}

export function RegisterForm() {
  const { setUser, setView, goBack, onboarded, setOnboarded } = useAppStore();
  const { t } = useLanguage();
  const [step, setStep] = useState(1);
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [role, setRole] = useState<UserRole>('CUSTOMER');
  const [agencyCode, setAgencyCode] = useState('');
  const [adminCode, setAdminCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Inline field errors
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Username availability
  const { status: usernameStatus, checkUsername } = useUsernameAvailability(username);

  const avatarUpload = useUpload({
    type: 'avatar',
    maxSize: 2 * 1024 * 1024,
    accept: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    onSuccess: (result) => {
      setAvatarPreview(getProxiedUrl(result.url));
      toast.success(t('avatarUpdated' as any));
    },
    onError: (error) => {
      toast.error(error);
      setAvatarPreview(null);
    },
  });

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarPreview(URL.createObjectURL(file));
    await avatarUpload.upload(file);
  };

  const passwordStrength = useMemo(() => getPasswordStrength(password), [password]);

  // Validate step 1 fields
  const validateStep1 = useCallback((): boolean => {
    const errors: Record<string, string> = {};

    if (!username.trim()) {
      errors.username = t('fieldRequired' as any);
    } else if (username.trim().length < 3) {
      errors.username = t('usernameMinLength');
    } else if (usernameStatus === 'taken') {
      errors.username = t('usernameTaken');
    }

    if (!password) {
      errors.password = t('fieldRequired' as any);
    } else if (password.length < 6) {
      errors.password = t('passwordMinLength');
    }

    if (!confirmPassword) {
      errors.confirmPassword = t('fieldRequired' as any);
    } else if (password !== confirmPassword) {
      errors.confirmPassword = t('passwordMismatch');
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [username, password, confirmPassword, usernameStatus, t]);

  // Validate step 2 fields
  const validateStep2 = useCallback((): boolean => {
    const errors: Record<string, string> = {};

    if (!fullName.trim()) {
      errors.fullName = t('fieldRequired' as any);
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [fullName, t]);

  // Clear field error when user types
  const clearFieldError = useCallback((field: string) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const handleRegister = async () => {
    // Full validation
    const errors: Record<string, string> = {};

    if (!username.trim() || username.trim().length < 3) {
      errors.username = t('usernameMinLength');
    } else if (usernameStatus === 'taken') {
      errors.username = t('usernameTaken');
    }

    if (!fullName.trim()) {
      errors.fullName = t('fieldRequired' as any);
    }

    if (!password || password.length < 6) {
      errors.password = t('passwordMinLength');
    }

    if (password !== confirmPassword) {
      errors.confirmPassword = t('passwordMismatch');
    }

    if (!agreeTerms) {
      toast.error(t('mustAgreeTerms'));
      return;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      toast.error(t('pleaseFixErrors' as any));
      return;
    }

    setLoading(true);
    try {
      const body: Record<string, string> = {
        username: username.trim(),
        fullName: fullName.trim(),
        password,
        role,
      };

      if (phoneNumber.trim()) {
        body.phoneNumber = phoneNumber.trim();
      }
      if (agencyCode.trim() && role === 'AGENCY_OWNER') {
        body.agencyCode = agencyCode.trim().toUpperCase();
      }
      if (avatarUpload.url) { body.avatarUrl = avatarUpload.url; }

      const res = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (res.ok && data.user) {
        setUser(data.user);
        setRegistrationSuccess(true);
        toast.success(t('registerSuccess'));
        if (data.isNewUser && !onboarded) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('blasti:show-onboarding', { detail: data.user }));
          }, 300);
        }
      } else {
        // Map API errors to field errors
        if (data.error?.includes('Username')) {
          setFieldErrors((prev) => ({ ...prev, username: data.error }));
        } else if (data.error?.includes('Phone')) {
          setFieldErrors((prev) => ({ ...prev, phoneNumber: data.error }));
        } else {
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const goToNext = () => {
    if (step === 1) {
      if (!validateStep1()) return;
    }
    if (step === 2) {
      if (!validateStep2()) return;
    }
    setFieldErrors({});
    if (step < 3) setStep(step + 1);
  };

  const goToPrev = () => {
    setFieldErrors({});
    if (step > 1) setStep(step - 1);
  };

  const isFocused = focusedField !== null;

  const slideVariants = {
    enter: (direction: number) => ({
      x: direction > 0 ? 200 : -200,
      opacity: 0,
      scale: 0.96,
      rotateY: direction > 0 ? 5 : -5,
    }),
    center: { x: 0, opacity: 1, scale: 1, rotateY: 0 },
    exit: (direction: number) => ({
      x: direction > 0 ? -200 : 200,
      opacity: 0,
      scale: 0.96,
      rotateY: direction > 0 ? -5 : 5,
    }),
  };

  const [direction, setDirection] = useState(0);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);

  // Username availability suffix component
  const usernameSuffix = useMemo(() => {
    if (usernameStatus === 'checking') {
      return <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />;
    }
    if (usernameStatus === 'available' && username.trim().length >= 3) {
      return (
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }}>
          <Check className="h-4 w-4 text-emerald-500" />
        </motion.div>
      );
    }
    if (usernameStatus === 'taken') {
      return (
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }}>
          <X className="h-4 w-4 text-red-500" />
        </motion.div>
      );
    }
    return null;
  }, [usernameStatus, username]);

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Animated background gradient + dot-grid pattern */}
      <div className="absolute inset-0 -z-10">
        <motion.div
          animate={{ backgroundPosition: ['0% 0%', '100% 100%', '0% 0%'] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 bg-[length:400%_400%] bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100/80 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/25"
        />
        {/* Subtle dot-grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.025] dark:opacity-[0.04]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
            backgroundSize: '28px 28px',
          }}
        />
        {/* Animated gradient orbs */}
        <motion.div
          animate={{ x: [0, 20, 0], y: [0, -15, 0] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute bottom-1/4 start-1/3 w-72 h-72 bg-emerald-200/30 dark:bg-emerald-800/15 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -15, 0], y: [0, 20, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
          className="absolute top-0 end-1/4 w-64 h-64 bg-teal-200/30 dark:bg-teal-800/15 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ y: [0, -20, 0], x: [0, 10, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-[40%] end-[20%] w-32 h-32 bg-cyan-200/20 dark:bg-cyan-800/10 rounded-full blur-2xl"
        />
      </div>

      {/* Top Bar */}
      <header className="w-full px-4 py-3 flex items-center justify-between relative z-10">
        <Button variant="ghost" size="icon" onClick={step === 1 ? goBack : goToPrev} className="h-10 w-10">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </Button>
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

      {/* Register Form */}
      <div className="flex-1 flex items-center justify-center px-4 py-4 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="w-full max-w-md"
        >
          <div className={`relative transition-transform duration-300 ${isFocused ? 'scale-[1.01]' : ''}`}>
            {/* Animated gradient border - matching login form style */}
            <div className="absolute -inset-[2px] rounded-2xl overflow-hidden">
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                className="absolute inset-0 bg-[conic-gradient(from_0deg,transparent,theme(colors.emerald.400),theme(colors.teal.400),theme(colors.cyan.400),transparent)] opacity-60"
              />
              <div className="absolute inset-[2px] rounded-2xl bg-white dark:bg-gray-900" />
            </div>
            {/* Gradient glow behind card */}
            <div
              className={`absolute -inset-1 rounded-2xl bg-gradient-to-br from-emerald-400/20 to-teal-400/20 dark:from-emerald-500/10 dark:to-teal-500/10 blur-xl transition-opacity duration-700 ${isFocused ? 'opacity-100' : 'opacity-0'}`}
            />
            <Card className="relative shadow-xl border-0 bg-white/95 dark:bg-gray-900/95 backdrop-blur-md z-10">
              <CardHeader className="text-center pb-2">
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
                  className="mx-auto mb-3 h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25"
                >
                  <UserPlus className="h-7 w-7 text-white" />
                </motion.div>
                <CardTitle className="text-2xl font-bold text-foreground">
                  {t('register')}
                </CardTitle>
              </CardHeader>

              {/* Step Progress Indicator with gradient active state */}
              <div className="px-6 pb-2">
                <div className="flex items-center justify-between">
                  {STEPS.map((s, idx) => {
                    const stepState = s.id < step ? 'completed' : s.id === step ? 'active' : 'pending';
                    return (
                      <div key={s.id} className="flex items-center flex-1 last:flex-none">
                        <div className="flex flex-col items-center">
                          <motion.div
                            animate={{
                              scale: stepState === 'active' ? [1, 1.08, 1] : 1,
                            }}
                            transition={stepState === 'active' ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.3 }}
                            className={`relative h-9 w-9 rounded-full flex items-center justify-center transition-all duration-300 border-2 ${
                              stepState === 'completed'
                                ? 'bg-gradient-to-br from-emerald-500 to-teal-500 border-emerald-500 text-white shadow-md shadow-emerald-500/25'
                                : stepState === 'active'
                                  ? 'border-emerald-400 dark:border-emerald-500 text-emerald-600 dark:text-emerald-400 shadow-lg shadow-emerald-500/15'
                                  : 'border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-500'
                            }`}
                          >
                            {/* Gradient glow behind active step */}
                            {stepState === 'active' && (
                              <motion.div
                                animate={{ opacity: [0.3, 0.6, 0.3], scale: [1, 1.3, 1] }}
                                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                                className="absolute inset-0 rounded-full bg-gradient-to-br from-emerald-400/40 to-teal-400/40 blur-md"
                              />
                            )}
                            {stepState === 'completed' ? (
                              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }} className="relative z-10">
                                <Check className="h-4 w-4" />
                              </motion.div>
                            ) : (
                              <span className={`text-xs font-bold relative z-10 ${stepState === 'active' ? 'bg-gradient-to-r from-emerald-600 to-teal-600 dark:from-emerald-400 dark:to-teal-400 bg-clip-text text-transparent' : ''}`}>{s.id}</span>
                            )}
                          </motion.div>
                          <span className={`text-[10px] mt-1.5 font-semibold transition-colors duration-300 ${
                            stepState === 'active' ? 'text-emerald-600 dark:text-emerald-400' : stepState === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                          }`}>
                            {s.id === 1 ? t('account') || 'Account' :
                             s.id === 2 ? t('fullName') || 'Profile' :
                             t('confirm') || 'Confirm'}
                          </span>
                        </div>
                        {idx < STEPS.length - 1 && (
                          <div className="flex-1 mx-2 mb-5">
                            <div className="h-[3px] rounded-full transition-all duration-500 overflow-hidden bg-gray-200 dark:bg-gray-700">
                              <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: s.id < step ? '100%' : '0%' }}
                                transition={{ duration: 0.5, ease: 'easeOut' }}
                                className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <CardContent className="space-y-4 pt-2 max-h-[55vh] overflow-y-auto custom-scrollbar relative overflow-hidden">
                <AnimatePresence mode="wait" custom={direction}>
                  <motion.div
                    key={step}
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                    className="space-y-4"
                  >
                    {/* Step 1: Account */}
                    {step === 1 && (
                      <>
                        {/* Avatar Upload */}
                        <div className="flex flex-col items-center">
                          <div className="relative">
                            <input
                              ref={avatarInputRef}
                              type="file"
                              accept="image/jpeg,image/png,image/gif,image/webp"
                              className="hidden"
                              onChange={handleAvatarChange}
                            />
                            {avatarPreview ? (
                              <div className="relative">
                                <img
                                  src={avatarPreview}
                                  alt="Avatar"
                                  className="h-20 w-20 rounded-full object-contain border-2 border-emerald-300 dark:border-emerald-700 shadow-md"
                                />
                                {avatarUpload.uploading && (
                                  <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center">
                                    <Loader2 className="h-5 w-5 text-white animate-spin" />
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => { setAvatarPreview(null); avatarUpload.reset(); }}
                                  className="absolute -top-1 -end-1 h-6 w-6 rounded-full bg-red-500 flex items-center justify-center shadow-md hover:bg-red-600 transition-colors"
                                >
                                  <X className="h-3 w-3 text-white" />
                                </button>
                              </div>
                            ) : (
                              <motion.button
                                type="button"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => avatarInputRef.current?.click()}
                                className="relative h-20 w-20 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center border-2 border-dashed border-emerald-300 dark:border-emerald-700 group cursor-pointer"
                              >
                                <Camera className="h-6 w-6 text-emerald-500 group-hover:text-emerald-600 transition-colors" />
                                <div className="absolute -bottom-1 -end-1 h-7 w-7 rounded-full bg-emerald-500 flex items-center justify-center shadow-md">
                                  <span className="text-[10px] text-white font-bold">+</span>
                                </div>
                              </motion.button>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-1.5">{t('uploadAvatar' as any)} · {t('avatarMaxSize' as any)}</p>
                        </div>

                        {/* Role Selector with gradient active state */}
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('selectRole')}</Label>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { value: 'CUSTOMER' as UserRole, label: t('loginAsCustomer'), icon: '👤' },
                              { value: 'AGENCY_OWNER' as UserRole, label: t('loginAsAgency'), sublabel: t('ownerRole'), icon: '🏢' },
                            ].map((roleOption) => (
                              <motion.button
                                key={roleOption.value}
                                type="button"
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => setRole(roleOption.value)}
                                className={`relative h-14 rounded-xl border-2 transition-all duration-300 flex flex-col items-center justify-center gap-0.5 overflow-hidden ${
                                  role === roleOption.value
                                    ? 'border-emerald-400 dark:border-emerald-500 shadow-lg shadow-emerald-500/20'
                                    : 'border-gray-200 dark:border-gray-700 hover:border-emerald-200 dark:hover:border-emerald-800'
                                }`}
                              >
                                {/* Gradient background for active state */}
                                {role === roleOption.value && (
                                  <motion.div
                                    layoutId="roleGradientBg"
                                    className="absolute inset-0 bg-gradient-to-br from-emerald-500 to-teal-500 opacity-10 dark:opacity-20"
                                    transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                                  />
                                )}
                                <span className="text-base relative z-10">{roleOption.icon}</span>
                                <span className={`text-[10px] sm:text-xs font-semibold relative z-10 leading-tight ${
                                  role === roleOption.value
                                    ? 'bg-gradient-to-r from-emerald-600 to-teal-600 dark:from-emerald-400 dark:to-teal-400 bg-clip-text text-transparent'
                                    : 'text-muted-foreground'
                                }`}>{roleOption.label}</span>
                                {roleOption.sublabel && (
                                  <span className={`text-[8px] relative z-10 ${
                                    role === roleOption.value ? 'text-emerald-500/70 dark:text-emerald-400/70' : 'text-muted-foreground/60'
                                  }`}>({roleOption.sublabel})</span>
                                )}
                              </motion.button>
                            ))}
                          </div>
                        </div>

                        {/* Username with availability check */}
                        <div className="space-y-1">
                          <FloatingInput
                            id="reg-username"
                            label={t('username')}
                            value={username}
                            onChange={(e) => {
                              setUsername(e.target.value);
                              clearFieldError('username');
                              checkUsername(e.target.value);
                            }}
                            onFocus={() => setFocusedField('username')}
                            onBlur={() => setFocusedField(null)}
                            placeholder={t('username')}
                            suffix={usernameSuffix}
                            focusedField={focusedField}
                            error={fieldErrors.username}
                          />
                          {/* Username availability status below field */}
                          <AnimatePresence>
                            {usernameStatus === 'available' && username.trim().length >= 3 && !fieldErrors.username && (
                              <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                className="flex items-center gap-1.5 px-1"
                              >
                                <Check className="h-3 w-3 text-emerald-500" />
                                <span className="text-[11px] text-emerald-500 font-medium">{t('usernameAvailable' as any)}</span>
                              </motion.div>
                            )}
                            {usernameStatus === 'taken' && !fieldErrors.username && (
                              <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                className="flex items-center gap-1.5 px-1"
                              >
                                <X className="h-3 w-3 text-red-500" />
                                <span className="text-[11px] text-red-500 font-medium">{t('usernameTaken')}</span>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        <div className="space-y-1.5">
                          <FloatingInput
                            id="reg-password"
                            label={t('password')}
                            type={showPassword ? 'text' : 'password'}
                            value={password}
                            onChange={(e) => {
                              setPassword(e.target.value);
                              clearFieldError('password');
                            }}
                            onFocus={() => setFocusedField('password')}
                            onBlur={() => setFocusedField(null)}
                            placeholder={t('password')}
                            hasToggle
                            toggleVisible={showPassword}
                            onToggle={() => setShowPassword(!showPassword)}
                            focusedField={focusedField}
                            error={fieldErrors.password}
                          />
                          {/* Password Strength Indicator with gradient colors */}
                          <AnimatePresence>
                            {password.length > 0 && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                className="space-y-1.5 pt-1"
                              >
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                                    <motion.div
                                      initial={{ width: 0 }}
                                      animate={{ width: `${passwordStrength.score}%` }}
                                      transition={{ duration: 0.4, ease: 'easeOut' }}
                                      className={`h-full rounded-full ${
                                        passwordStrength.score <= 40
                                          ? 'bg-gradient-to-r from-red-500 to-orange-500'
                                          : passwordStrength.score <= 60
                                            ? 'bg-gradient-to-r from-amber-400 to-yellow-500'
                                            : 'bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500'
                                      }`}
                                    />
                                  </div>
                                  <span className={`text-[10px] font-semibold min-w-[70px] text-end ${passwordStrength.textColor}`}>
                                    {t(passwordStrength.labelKey as any)}
                                  </span>
                                </div>
                                {/* Strength criteria indicators with gradient */}
                                <div className="flex gap-1.5 flex-wrap">
                                  {[
                                    { test: password.length >= 6, key: 'minChars' },
                                    { test: /[A-Z]/.test(password), key: 'uppercase' },
                                    { test: /[0-9]/.test(password), key: 'number' },
                                    { test: /[^A-Za-z0-9]/.test(password), key: 'specialChar' },
                                  ].map((criteria) => (
                                    <motion.div
                                      key={criteria.key}
                                      initial={false}
                                      animate={{
                                        scale: criteria.test ? 1.05 : 1,
                                      }}
                                      transition={{ duration: 0.2, type: 'spring', stiffness: 300 }}
                                      className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full transition-colors duration-300 ${
                                        criteria.test
                                          ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-sm shadow-emerald-500/25'
                                          : 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500'
                                      }`}
                                    >
                                      {criteria.test ? (
                                        <motion.div
                                          initial={{ scale: 0 }}
                                          animate={{ scale: 1 }}
                                          transition={{ type: 'spring', stiffness: 400, damping: 15 }}
                                        >
                                          <Check className="h-2.5 w-2.5" />
                                        </motion.div>
                                      ) : (
                                        <span className="h-2.5 w-2.5" />
                                      )}
                                      <span className="text-[9px] font-medium">
                                        {t(criteria.key as any)}
                                      </span>
                                    </motion.div>
                                  ))}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        <FloatingInput
                          id="reg-confirm"
                          label={t('confirmPassword')}
                          type={showConfirm ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(e) => {
                            setConfirmPassword(e.target.value);
                            clearFieldError('confirmPassword');
                          }}
                          onFocus={() => setFocusedField('confirm')}
                          onBlur={() => setFocusedField(null)}
                          placeholder={t('confirmPassword')}
                          hasToggle
                          toggleVisible={showConfirm}
                          onToggle={() => setShowConfirm(!showConfirm)}
                          focusedField={focusedField}
                          error={fieldErrors.confirmPassword}
                        />
                        {/* Password match indicator */}
                        <AnimatePresence>
                          {confirmPassword.length > 0 && password.length > 0 && !fieldErrors.confirmPassword && (
                            <motion.div
                              initial={{ opacity: 0, y: -4 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -4 }}
                              className="flex items-center gap-1.5 px-1"
                            >
                              {password === confirmPassword ? (
                                <>
                                  <Check className="h-3 w-3 text-emerald-500" />
                                  <span className="text-[11px] text-emerald-500 font-medium">{t('passwordsMatch' as any)}</span>
                                </>
                              ) : (
                                <>
                                  <X className="h-3 w-3 text-red-500" />
                                  <span className="text-[11px] text-red-500 font-medium">{t('passwordMismatch')}</span>
                                </>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </>
                    )}

                    {/* Step 2: Profile */}
                    {step === 2 && (
                      <>
                        <FloatingInput
                          id="reg-fullname"
                          label={t('fullName')}
                          value={fullName}
                          onChange={(e) => {
                            setFullName(e.target.value);
                            clearFieldError('fullName');
                          }}
                          onFocus={() => setFocusedField('fullname')}
                          onBlur={() => setFocusedField(null)}
                          placeholder={t('fullName')}
                          focusedField={focusedField}
                          error={fieldErrors.fullName}
                        />

                        {/* Phone with Algeria prefix */}
                        <div className="space-y-1.5">
                          <div className={`relative flex items-center rounded-xl border transition-all duration-300 ${
                            fieldErrors.phoneNumber
                              ? 'border-red-400 ring-2 ring-red-500/20'
                              : focusedField === 'phone'
                                ? 'border-emerald-400 ring-2 ring-emerald-500/20 dark:ring-emerald-400/20 bg-white dark:bg-gray-900'
                                : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/50'
                          }`}>
                            <div className="ps-3.5 flex-shrink-0">
                              <div className="flex items-center h-12 px-2.5 rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200/50 dark:border-gray-700/50 text-xs text-muted-foreground font-medium" dir="ltr">
                                {t('algeriaPrefix')}
                              </div>
                            </div>
                            <div className="relative flex-1">
                              <input
                                id="reg-phone"
                                type="tel"
                                value={phoneNumber}
                                onChange={(e) => {
                                  setPhoneNumber(e.target.value);
                                  clearFieldError('phoneNumber');
                                }}
                                onFocus={() => setFocusedField('phone')}
                                onBlur={() => setFocusedField(null)}
                                placeholder={focusedField === 'phone' || phoneNumber ? t('phonePlaceholder') : ' '}
                                dir="ltr"
                                className="peer h-12 w-full bg-transparent px-3.5 text-base text-foreground outline-none placeholder:text-muted-foreground/60"
                              />
                              <label
                                htmlFor="reg-phone"
                                className={`pointer-events-none absolute transition-all duration-200 ease-out ${
                                  focusedField === 'phone' || phoneNumber.length > 0
                                    ? `top-1.5 text-[10px] font-semibold ${fieldErrors.phoneNumber ? 'text-red-500 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`
                                    : 'top-1/2 -translate-y-1/2 text-sm text-muted-foreground'
                                } start-0`}
                              >
                                {t('phoneWithPrefix')}
                              </label>
                            </div>
                          </div>
                          <AnimatePresence>
                            {fieldErrors.phoneNumber && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                className="overflow-hidden"
                              >
                                <div className="flex items-center gap-1.5 px-1 pt-0.5">
                                  <AlertCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
                                  <span className="text-[11px] text-red-500 dark:text-red-400">{fieldErrors.phoneNumber}</span>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>

                        {/* Agency code (for owner only) */}
                        {role === 'AGENCY_OWNER' && (
                          <FloatingInput
                            id="reg-agency-code"
                            label={t('agencyCodeField')}
                            value={agencyCode}
                            onChange={(e) => setAgencyCode(e.target.value)}
                            onFocus={() => setFocusedField('agency-code')}
                            onBlur={() => setFocusedField(null)}
                            placeholder={t('agencyCodePlaceholder')}
                            dir="ltr"
                            focusedField={focusedField}
                          />
                        )}
                      </>
                    )}

                    {/* Step 3: Confirm */}
                    {step === 3 && (
                      <>
                        {/* Success Checkmark Animation */}
                        <motion.div
                          initial={{ scale: 0, rotate: -180 }}
                          animate={{ scale: 1, rotate: 0 }}
                          transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                          className="flex justify-center mb-4"
                        >
                          <div className="relative">
                            <motion.div
                              animate={{ boxShadow: ['0 0 0 0 rgba(16,185,129,0.3)', '0 0 0 16px rgba(16,185,129,0)', '0 0 0 0 rgba(16,185,129,0)'] }}
                              transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
                              className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg"
                            >
                              <CircleDot className="h-9 w-9 text-white" />
                            </motion.div>
                          </div>
                        </motion.div>

                        {/* Review Card */}
                        <div className="space-y-3 p-4 rounded-xl bg-gradient-to-br from-emerald-50/80 to-teal-50/80 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100 dark:border-emerald-800/30">
                          <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">{t('reviewInfo') || 'Review Your Information'}</p>

                          <div className="space-y-2.5">
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">{t('username')}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-foreground">{username}</span>
                                {usernameStatus === 'available' && (
                                  <Check className="h-3 w-3 text-emerald-500" />
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">{t('fullName')}</span>
                              <span className="font-semibold text-foreground">{fullName}</span>
                            </div>
                            {phoneNumber && (
                              <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">{t('phoneNumber')}</span>
                                <span className="font-semibold text-foreground" dir="ltr">{phoneNumber}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">{t('selectRole')}</span>
                              <span className="font-semibold text-foreground">
                                {role === 'CUSTOMER' ? t('loginAsCustomer') : t('loginAsAgency')}
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-muted-foreground">{t('password')}</span>
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-foreground">{'•'.repeat(Math.min(password.length, 10))}</span>
                                <span className={`text-[10px] font-medium ${passwordStrength.textColor}`}>{t(passwordStrength.labelKey as any)}</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Terms checkbox */}
                        <div className="flex items-start gap-3 pt-1">
                          <Checkbox
                            id="reg-terms"
                            checked={agreeTerms}
                            onCheckedChange={(checked) => setAgreeTerms(checked === true)}
                            className="mt-0.5"
                          />
                          <label htmlFor="reg-terms" className="text-xs text-muted-foreground leading-relaxed cursor-pointer">
                            {t('agreeTerms')}{' '}
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t('termsOfService')}</span>{' '}
                            {t('andStr')}{' '}
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t('privacyPolicy')}</span>
                          </label>
                        </div>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </CardContent>

              <CardFooter className="flex-col gap-3 pt-2 pb-6">
                {/* Navigation Buttons */}
                <div className="flex gap-3 w-full">
                  {step > 1 && (
                    <Button
                      variant="outline"
                      className="flex-1 h-12 rounded-xl font-semibold text-base"
                      onClick={() => { setDirection(-1); goToPrev(); }}
                    >
                      <ArrowLeft className="h-4 w-4 me-2 rtl:rotate-180" />
                      {t('back') || 'Back'}
                    </Button>
                  )}
                  <AnimatePresence mode="wait">
                    {registrationSuccess ? (
                      <motion.div
                        key="success"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className="flex-1 h-12 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold text-base flex items-center justify-center gap-2 relative overflow-hidden"
                      >
                        {/* Pulsing glow effect */}
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
                          <Check className="h-5 w-5" />
                        </motion.div>
                        <span className="relative z-10">{t('registerSuccess')}</span>
                      </motion.div>
                    ) : step < 3 ? (
                      <motion.div key="next" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 relative">
                        {/* Gradient glow behind Next button */}
                        <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-emerald-500/40 via-teal-500/30 to-cyan-500/40 blur-lg opacity-0 hover:opacity-100 transition-opacity duration-500" />
                        <Button
                          className="relative w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold text-base rounded-xl shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/40 transition-all duration-300 hover:scale-[1.02] z-10"
                          onClick={() => { setDirection(1); goToNext(); }}
                        >
                          {t('next') || 'Next'}
                          <ArrowRight className="h-4 w-4 ms-2 rtl:rotate-180" />
                        </Button>
                      </motion.div>
                    ) : (
                      <motion.div key="register" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 relative">
                        {/* Gradient glow behind Register button */}
                        <div className="absolute -inset-1 rounded-xl bg-gradient-to-r from-emerald-500/40 via-teal-500/30 to-cyan-500/40 blur-lg opacity-0 hover:opacity-100 transition-opacity duration-500" />
                        <Button
                          className="relative w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold text-base rounded-xl shadow-lg shadow-emerald-500/25 hover:shadow-xl hover:shadow-emerald-500/40 transition-all duration-300 hover:scale-[1.02] z-10"
                          onClick={handleRegister}
                          disabled={loading}
                        >
                          {loading ? (
                            <motion.div
                              animate={{ rotate: 360 }}
                              transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                              className="flex items-center gap-2"
                            >
                              <Loader2 className="h-5 w-5" />
                              <span className="text-sm opacity-80">{t('loading')}</span>
                            </motion.div>
                          ) : (
                            <>
                              <Check className="h-5 w-5 me-2" />
                              {t('register')}
                            </>
                          )}
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('hasAccount')}{' '}
                  <button
                    className="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline underline-offset-2 transition-all"
                    onClick={() => setView('login')}
                  >
                    {t('login')}
                  </button>
                </p>
              </CardFooter>
            </Card>

            {/* Success Animation Overlay */}
            <AnimatePresence>
              {registrationSuccess && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="absolute inset-0 z-50 flex items-center justify-center bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm rounded-2xl"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                    className="flex flex-col items-center gap-4"
                  >
                    <motion.div
                      animate={{
                        boxShadow: [
                          '0 0 0 0 rgba(16, 185, 129, 0.4)',
                          '0 0 0 20px rgba(16, 185, 129, 0)',
                          '0 0 0 0 rgba(16, 185, 129, 0)',
                        ],
                      }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                      className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-2xl"
                    >
                      <motion.div
                        initial={{ scale: 0, rotate: -180 }}
                        animate={{ scale: 1, rotate: 0 }}
                        transition={{ delay: 0.2, type: 'spring', stiffness: 200, damping: 15 }}
                      >
                        <Check className="h-10 w-10 text-white" />
                      </motion.div>
                    </motion.div>
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.4 }}
                      className="text-center"
                    >
                      <p className="text-lg font-bold text-foreground">{t('registerSuccess')}</p>
                      <p className="text-sm text-muted-foreground mt-1">{t('welcomeToBlasti')}</p>
                    </motion.div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
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
