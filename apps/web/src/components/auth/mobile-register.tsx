'use client';

/**
 * BLASTI — Dedicated MOBILE registration (Task 78)
 *
 * The Capacitor shell previously mounted the desktop RegisterForm, whose
 * role default came from `platform.isNative` — on a phone that meant the
 * form defaulted to AGENCY_OWNER and HID the customer option entirely
 * ("the desktop app serves agencies only"). Mobile is customer-first, so
 * this component:
 *   - defaults to CUSTOMER and keeps the agency option reachable,
 *   - picks the avatar through the NATIVE camera/gallery (Capacitor Camera
 *     plugin via nativeBridge) or the file input, with the 12 preset icons,
 *   - uses one-column touch-first layouts (h-12 inputs, 44px+ targets,
 *     document scroll — never a nested vh scroller, see Task 31-A),
 *   - handles safe-area insets (auth screens render outside PlatformFrame),
 *   - keeps the exact register API contract of the desktop form
 *     (POST /api/auth/register → requiresVerification → shared
 *     VerificationStep → setUser + setSessionToken +
 *     setNativeSessionToken — unconditional, Capacitor Bearer token).
 *
 * Local ar/en copy for mobile-specific strings (fr falls back to EN).
 */

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useUpload } from '@/hooks/use-upload';
import { getProxiedUrl } from '@/lib/utils';
import { setNativeSessionToken } from '@/lib/api-client';
import { usePlatform } from '@/hooks/use-platform';
import { nativeBridge } from '@/lib/native-bridge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { LanguageSwitcher } from '@/components/shared/language-switcher';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import {
  ArrowLeft, ArrowRight, Loader2, Eye, EyeOff, Check, X, Camera, ImageIcon,
  UserRound, Building2, AlertCircle, CheckCircle2, UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import type { UserRole } from '@/store/use-app-store';
import { PRESET_AVATARS } from './preset-avatars';
import {
  VerificationStep,
  type VerificationPending,
  type VerificationTargets,
  type VerificationDev,
  type VerificationSuccess,
} from './verification-step';
import {
  WilayaSelect,
  CommuneSelect,
  composeLocationLabel,
} from '@/components/shared/algeria-location-selects';

// ─── Local bilingual copy (fr falls back to EN — global dicts untouched) ────

const MOBILE_REGISTER_COPY = {
  ar: {
    tagline: 'طابورك في جيبك',
    stepOf: (n: number) => `الخطوة ${n} من 3`,
    stepAccount: 'الحساب',
    stepProfile: 'الملف الشخصي',
    stepConfirm: 'تأكيد',
    profilePhoto: 'الصورة الشخصية',
    optional: 'اختياري',
    takePhoto: 'الكاميرا',
    fromGallery: 'المعرض',
    chooseFile: 'ملف',
    orPickIcon: 'أو اختر صورة جاهزة:',
    pickIconAria: 'اختيار الصورة الشخصية',
    sizeHint: 'حتى 2 ميغابايت · JPG · PNG',
    cameraUnavailable: 'تعذر فتح الكاميرا — جرّب المعرض أو ملفًا',
    uploadInProgress: 'جارٍ رفع الصورة — انتظر لحظة ثم أكمل',
    reviewInfo: 'راجع معلوماتك',
    locationLabel: 'الولاية / البلدية',
    termsLead: 'أوافق على',
    creating: 'جارٍ إنشاء الحساب…',
    accountReady: 'تم إنشاء الحساب',
    verifyTitle: 'تأكيد الحساب',
    verifySub: 'أدخل الرمزين المرسلين إليك',
    agencyNote: 'بعد التسجيل ستنشئ وكالتك وتعبّئ عنوانها في معالج الإعداد.',
    showPassword: 'إظهار كلمة المرور',
    hidePassword: 'إخفاء كلمة المرور',
  },
  en: {
    tagline: 'Your queue, in your pocket',
    stepOf: (n: number) => `Step ${n} of 3`,
    stepAccount: 'Account',
    stepProfile: 'Profile',
    stepConfirm: 'Confirm',
    profilePhoto: 'Profile photo',
    optional: 'Optional',
    takePhoto: 'Camera',
    fromGallery: 'Gallery',
    chooseFile: 'File',
    orPickIcon: 'Or pick a ready-made avatar:',
    pickIconAria: 'Pick avatar',
    sizeHint: 'Up to 2MB · JPG · PNG',
    cameraUnavailable: 'Could not open the camera — try the gallery or a file',
    uploadInProgress: 'Still uploading the photo — one moment',
    reviewInfo: 'Review your information',
    locationLabel: 'Wilaya / Commune',
    termsLead: 'I agree to the',
    creating: 'Creating your account…',
    accountReady: 'Account created',
    verifyTitle: 'Verify your account',
    verifySub: 'Enter the two codes we sent you',
    agencyNote: 'After registering you will create your agency and fill its address in the setup wizard.',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
  },
} as const;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_FIELD_COPY = {
  ar: { required: 'البريد الإلكتروني مطلوب', invalid: 'صيغة البريد الإلكتروني غير صحيحة' },
  en: { required: 'Email is required', invalid: 'Invalid email address format' },
} as const;

function getPasswordStrength(password: string) {
  let score = 0;
  if (password.length >= 6) score++;
  if (password.length >= 10) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (score <= 1) return { score: 20, labelKey: 'weak', textColor: 'text-red-500' };
  if (score <= 2) return { score: 40, labelKey: 'fair', textColor: 'text-orange-500' };
  if (score <= 3) return { score: 60, labelKey: 'good', textColor: 'text-yellow-500' };
  if (score <= 4) return { score: 80, labelKey: 'strong', textColor: 'text-emerald-500' };
  return { score: 100, labelKey: 'veryStrong', textColor: 'text-emerald-600' };
}

// Username availability (debounced, same contract as the desktop form).
function useUsernameAvailability(username: string) {
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkUsername = useCallback(async (name: string) => {
    if (abortRef.current) abortRef.current.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!name || name.trim().length < 3) {
      setStatus('idle');
      return;
    }
    setStatus('checking');
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await apiFetch(`/api/auth/check-username?username=${encodeURIComponent(name.trim())}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        let data: { available?: boolean } | null = null;
        try { data = await res.json(); } catch { data = null; }
        if (res.ok && data && typeof data.available === 'boolean') {
          setStatus(data.available ? 'available' : 'taken');
        } else {
          setStatus('error');
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setStatus('error');
      }
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { status, checkUsername };
}

export function MobileRegisterForm() {
  const { setUser, setView, setSessionToken } = useAppStore();
  const { t, lang } = useLanguage();
  const { platform } = usePlatform();
  const copy = MOBILE_REGISTER_COPY[lang === 'ar' ? 'ar' : 'en'];
  const emailCopy = EMAIL_FIELD_COPY[lang === 'ar' ? 'ar' : 'en'];

  // ── Form state (identical contract to the desktop RegisterForm) ──
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [role, setRole] = useState<UserRole>('CUSTOMER');
  const [wilayaCode, setWilayaCode] = useState('');
  const [communeName, setCommuneName] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [registrationSuccess, setRegistrationSuccess] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  // Task 78 — the upload result is captured here the moment the request
  // settles (upload() resolves with the final state, before React state
  // propagates). Without it a user who taps “Create account” while the
  // avatar is still uploading would silently submit WITHOUT avatarUrl —
  // the account was then created with no photo and the profile showed the
  // placeholder avatar forever (the reported mobile bug).
  const uploadedAvatarUrlRef = useRef<string | null>(null);

  const [verificationData, setVerificationData] = useState<{
    verificationToken: string;
    pending: VerificationPending;
    targets?: VerificationTargets | null;
    dev?: VerificationDev | null;
  } | null>(null);

  const { status: usernameStatus, checkUsername } = useUsernameAvailability(username);

  const avatarUpload = useUpload({
    type: 'avatar',
    maxSize: 2 * 1024 * 1024,
    accept: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    onSuccess: (result) => {
      uploadedAvatarUrlRef.current = result.url;
      setSelectedPreset(null);
      setAvatarPreview(getProxiedUrl(result.url));
      toast.success(t('avatarUpdated' as any));
    },
    onError: (error) => {
      // Keep the local preview when an upload fails (Round 15) — the user
      // still sees their pick; the toast explains the failure.
      if (error !== 'Upload cancelled') toast.error(error);
    },
  });

  // The avatar that gets sent to the API: an uploaded file URL wins over a
  // picked preset icon. Computed INSIDE handleRegister (Task 78 — react-hooks
  // refs rule: ref.current must not be read during render); the ref captures
  // the settled upload result immediately, so a fast “Create account” tap
  // while the photo is still uploading never silently drops the avatar.

  // ── Avatar picking ────────────────────────────────────────────────────────
  // Native (Capacitor): Camera plugin returns a base64 data URL which we
  // convert to a File and push through the normal upload pipeline (the
  // Task 78 filename synthesis covers the extension-less blob name).
  const handleNativePhoto = async (source: 'Camera' | 'Photos') => {
    try {
      const dataUrl = await nativeBridge.takePhoto(source);
      if (!dataUrl) {
        toast.error(copy.cameraUnavailable);
        return;
      }
      setSelectedPreset(null);
      uploadedAvatarUrlRef.current = null;
      setAvatarPreview(dataUrl);
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `avatar-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
      const result = await avatarUpload.upload(file);
      if (result?.url) uploadedAvatarUrlRef.current = result.url;
    } catch {
      toast.error(copy.cameraUnavailable);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedPreset(null);
    uploadedAvatarUrlRef.current = null;
    setAvatarPreview(URL.createObjectURL(file));
    const result = await avatarUpload.upload(file);
    if (result?.url) uploadedAvatarUrlRef.current = result.url;
    // Allow re-picking the same file
    e.target.value = '';
  };

  const handlePresetSelect = (uri: string) => {
    avatarUpload.reset();
    uploadedAvatarUrlRef.current = null;
    setSelectedPreset(uri);
    setAvatarPreview(uri);
  };

  const handleAvatarRemove = () => {
    avatarUpload.reset();
    uploadedAvatarUrlRef.current = null;
    setSelectedPreset(null);
    setAvatarPreview(null);
  };

  const passwordStrength = useMemo(() => getPasswordStrength(password), [password]);

  const clearFieldError = useCallback((field: string) => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  // ── Validation ────────────────────────────────────────────────────────────
  const validateStep1 = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = t('fieldRequired' as any);
    else if (username.trim().length < 3) errors.username = t('usernameMinLength');
    else if (usernameStatus === 'taken') errors.username = t('usernameTaken');

    const trimmedEmail = email.trim();
    if (!trimmedEmail) errors.email = emailCopy.required;
    else if (!EMAIL_REGEX.test(trimmedEmail)) errors.email = emailCopy.invalid;

    if (!password) errors.password = t('fieldRequired' as any);
    else if (password.length < 6) errors.password = t('passwordMinLength');

    if (!confirmPassword) errors.confirmPassword = t('fieldRequired' as any);
    else if (password !== confirmPassword) errors.confirmPassword = t('passwordMismatch');

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [username, email, password, confirmPassword, usernameStatus, emailCopy, t]);

  const validateStep2 = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!fullName.trim()) errors.fullName = t('fieldRequired' as any);
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [fullName, t]);

  const goToNext = () => {
    if (step === 1 && !validateStep1()) return;
    if (step === 2 && !validateStep2()) return;
    setFieldErrors({});
    if (step < 3) setStep((step + 1) as 1 | 2 | 3);
  };

  const goToPrev = () => {
    setFieldErrors({});
    if (step > 1) setStep((step - 1) as 1 | 2 | 3);
  };

  // ── Submit (same API contract as the desktop register form) ───────────────
  const handleRegister = async () => {
    // Task 78 — never submit while the avatar upload is still in flight:
    // the account would be created without the photo (placeholder avatar).
    if (avatarUpload.uploading) {
      toast.error(copy.uploadInProgress);
      return;
    }

    const errors: Record<string, string> = {};
    if (!username.trim() || username.trim().length < 3) errors.username = t('usernameMinLength');
    else if (usernameStatus === 'taken') errors.username = t('usernameTaken');

    const trimmedEmail = email.trim();
    if (!trimmedEmail) errors.email = emailCopy.required;
    else if (!EMAIL_REGEX.test(trimmedEmail)) errors.email = emailCopy.invalid;

    if (!fullName.trim()) errors.fullName = t('fieldRequired' as any);
    if (!password || password.length < 6) errors.password = t('passwordMinLength');
    if (password !== confirmPassword) errors.confirmPassword = t('passwordMismatch');

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
        email: trimmedEmail,
      };
      if (phoneNumber.trim()) body.phoneNumber = phoneNumber.trim();
      // Uploaded photo URL OR the picked preset icon (data URI).
      // Computed here so the ref read stays outside render (Task 78).
      const avatarValue = avatarUpload.url || uploadedAvatarUrlRef.current || selectedPreset;
      if (avatarValue) body.avatarUrl = avatarValue;

      // Algeria location: handed to the create-agency wizard for agency
      // accounts; persisted on the User row for customers.
      if (wilayaCode && communeName) {
        try {
          localStorage.setItem('blasti:reg-location', JSON.stringify({ wilaya: wilayaCode, commune: communeName }));
        } catch { /* storage unavailable — wizard prefill simply skipped */ }
      }
      if (role === 'CUSTOMER') {
        if (wilayaCode) body.wilaya = wilayaCode;
        if (communeName) body.commune = communeName;
      }

      const res = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      // ── Requires OTP verification → shared VerificationStep ──
      if (res.ok && data.requiresVerification && data.verificationToken) {
        setVerificationData({
          verificationToken: data.verificationToken,
          pending: (data.pending ?? { email: true, phone: true }) as VerificationPending,
          targets: data.targets ?? null,
          dev: data.dev ?? null,
        });
        return;
      }

      if (res.ok && data.user) {
        bootstrapSession(data.user, data.token, t('registerSuccess'));
      } else {
        if (data.error?.includes('Username')) {
          setFieldErrors((prev) => ({ ...prev, username: data.error }));
        } else if (data.error?.includes('Email')) {
          setFieldErrors((prev) => ({ ...prev, email: data.error }));
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

  // ── Session bootstrap (mobile) ─────────────────────────────────────────
  // setUser routes by role; setSessionToken persists + resumes sync;
  // setNativeSessionToken stores the cloud JWT for Capacitor Bearer auth
  // (unconditional — no-op on plain web).
  const bootstrapSession = (user: unknown, token: string | undefined, msg: string) => {
    setRegistrationSuccess(true);
    setTimeout(() => {
      setUser(user as never);
      if (token) {
        setSessionToken(token);
        try { setNativeSessionToken(token); } catch { /* non-native runtime */ }
      }
      toast.success(msg);
      setRegistrationSuccess(false);
    }, 700);
  };

  const handleVerificationSuccess = (result: VerificationSuccess) => {
    setVerificationData(null);
    bootstrapSession(result.user, result.token, t('registerSuccess'));
  };

  const handleVerificationTokenInvalid = () => {
    setVerificationData(null);
    setView('login');
  };

  const handleVerificationBack = () => {
    setVerificationData(null);
    setStep(3);
  };

  const usernameSuffix = useMemo(() => {
    if (usernameStatus === 'checking') return <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />;
    if (usernameStatus === 'available' && username.trim().length >= 3) {
      return <Check className="h-4 w-4 text-emerald-500" />;
    }
    if (usernameStatus === 'taken') return <X className="h-4 w-4 text-red-500" />;
    return null;
  }, [usernameStatus, username]);

  const stepMeta = [
    { n: 1 as const, label: copy.stepAccount },
    { n: 2 as const, label: copy.stepProfile },
    { n: 3 as const, label: copy.stepConfirm },
  ];

  return (
    <div className="min-h-dvh flex flex-col bg-gradient-to-b from-emerald-50/70 via-background to-background dark:from-emerald-950/20">
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

      <main className="flex-1 px-5 pb-6 pt-1" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <AnimatePresence mode="wait">
          {verificationData ? (
            <motion.div
              key="verify"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.25 }}
              className="max-w-md mx-auto w-full"
            >
              <div className="mb-5 text-center">
                <h1 className="text-xl font-bold text-foreground">{copy.verifyTitle}</h1>
                <p className="text-sm text-muted-foreground mt-1">{copy.verifySub}</p>
              </div>
              <VerificationStep
                verificationToken={verificationData.verificationToken}
                pending={verificationData.pending}
                targets={verificationData.targets}
                dev={verificationData.dev}
                lang={lang}
                onVerified={handleVerificationSuccess}
                onTokenInvalid={handleVerificationTokenInvalid}
                onBack={handleVerificationBack}
              />
            </motion.div>
          ) : (
            <motion.div
              key="wizard"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.25 }}
              className="max-w-md mx-auto w-full"
            >
              {/* Hero */}
              <div className="text-center mb-4 pt-1">
                <div className="mx-auto mb-2.5 h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
                  <UserPlus className="h-7 w-7 text-white" />
                </div>
                <h1 className="text-2xl font-extrabold text-foreground">{t('register')}</h1>
                <p className="text-sm text-muted-foreground mt-0.5">{copy.tagline}</p>
              </div>

              {/* Step progress: thin bar + labels */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  {stepMeta.map((s, idx) => (
                    <div key={s.n} className="flex items-center flex-1 last:flex-none">
                      <span
                        className={`text-[10px] font-bold whitespace-nowrap ${
                          step >= s.n ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/60'
                        }`}
                      >
                        {s.label}
                      </span>
                      {idx < stepMeta.length - 1 && (
                        <div className="flex-1 mx-2 h-[3px] rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <motion.div
                            initial={false}
                            animate={{ width: step > s.n ? '100%' : '0%' }}
                            transition={{ duration: 0.4, ease: 'easeOut' }}
                            className="h-full bg-gradient-to-r from-emerald-500 to-teal-500"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground/70 px-0.5">{copy.stepOf(step)}</p>
              </div>

              {/* ── Step 1: Account ── */}
              {step === 1 && (
                <motion.div
                  initial={{ opacity: 0, x: 32 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -32 }}
                  transition={{ duration: 0.22 }}
                  className="space-y-4"
                >
                  {/* Avatar picker */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-0.5">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{copy.profilePhoto}</p>
                      <span className="text-[10px] text-muted-foreground/60">({copy.optional})</span>
                    </div>
                    <div className="flex items-center gap-3.5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-900/50 p-3.5">
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp,image/*"
                        className="hidden"
                        onChange={handleAvatarChange}
                      />
                      <div className="relative flex-shrink-0">
                        {avatarPreview ? (
                          <div className="relative">
                            <img
                              src={avatarPreview}
                              alt="Avatar"
                              className="h-20 w-20 rounded-full object-cover border-2 border-emerald-300 dark:border-emerald-700 shadow-md"
                            />
                            {avatarUpload.uploading && (
                              <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center">
                                <Loader2 className="h-5 w-5 text-white animate-spin" />
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={handleAvatarRemove}
                              aria-label="Remove photo"
                              className="absolute -top-1 -end-1 h-7 w-7 rounded-full bg-red-500 flex items-center justify-center shadow-md active:bg-red-600 min-h-[28px] min-w-[28px]"
                            >
                              <X className="h-3.5 w-3.5 text-white" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => avatarInputRef.current?.click()}
                            aria-label={copy.chooseFile}
                            className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center border-2 border-dashed border-emerald-300 dark:border-emerald-700 active:scale-95 transition-transform"
                          >
                            <Camera className="h-7 w-7 text-emerald-500" />
                          </button>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <div className="flex flex-wrap gap-1.5">
                          {platform.isCapacitor && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleNativePhoto('Camera')}
                                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold active:bg-emerald-500/20"
                              >
                                <Camera className="h-3.5 w-3.5" /> {copy.takePhoto}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleNativePhoto('Photos')}
                                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold active:bg-emerald-500/20"
                              >
                                <ImageIcon className="h-3.5 w-3.5" /> {copy.fromGallery}
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            onClick={() => avatarInputRef.current?.click()}
                            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-semibold active:bg-emerald-500/20"
                          >
                            <ImageIcon className="h-3.5 w-3.5" /> {copy.chooseFile}
                          </button>
                        </div>
                        <p className="text-[10px] text-muted-foreground/70">{copy.sizeHint}</p>
                      </div>
                    </div>

                    {/* Preset icons */}
                    <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-900/50 p-3 space-y-2">
                      <p className="text-[11px] text-muted-foreground">{copy.orPickIcon}</p>
                      <div className="flex flex-wrap gap-2">
                        {PRESET_AVATARS.map((uri, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => handlePresetSelect(uri)}
                            aria-label={`${copy.pickIconAria} ${i + 1}`}
                            className={`h-9 w-9 rounded-full overflow-hidden flex-shrink-0 transition-shadow min-h-[36px] min-w-[36px] ${
                              selectedPreset === uri
                                ? 'ring-2 ring-emerald-500 ring-offset-2 dark:ring-offset-gray-900 shadow-md'
                                : 'active:scale-90 transition-transform'
                            }`}
                          >
                            <img src={uri} alt="" className="h-full w-full" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Role selector — customer-first, both roles reachable */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-0.5">{t('selectRole')}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        { value: 'CUSTOMER' as UserRole, label: t('loginAsCustomer'), icon: UserRound },
                        { value: 'AGENCY_OWNER' as UserRole, label: t('loginAsAgency'), icon: Building2 },
                      ]).map((opt) => {
                        const active = role === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setRole(opt.value)}
                            aria-pressed={active}
                            className={`relative h-16 rounded-2xl border-2 flex flex-col items-center justify-center gap-1 transition-all duration-200 ${
                              active
                                ? 'border-emerald-400 dark:border-emerald-500 bg-emerald-500/10 shadow-lg shadow-emerald-500/15'
                                : 'border-gray-200 dark:border-gray-700 active:border-emerald-200'
                            }`}
                          >
                            <opt.icon className={`h-5 w-5 ${active ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                            <span className={`text-xs font-bold ${active ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                              {opt.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {role === 'AGENCY_OWNER' && (
                      <p className="text-[11px] text-muted-foreground/80 px-1 flex items-start gap-1.5 pt-0.5">
                        <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                        {copy.agencyNote}
                      </p>
                    )}
                  </div>

                  {/* Fields */}
                  <div className="space-y-3.5">
                    <div className="space-y-1.5">
                      <label htmlFor="m-reg-username" className="text-xs font-semibold text-muted-foreground px-0.5">{t('username')}</label>
                      <div className="relative">
                        <Input
                          id="m-reg-username"
                          value={username}
                          onChange={(e) => { setUsername(e.target.value); clearFieldError('username'); checkUsername(e.target.value); }}
                          placeholder={t('username')}
                          autoCapitalize="none"
                          autoCorrect="off"
                          autoComplete="username"
                          enterKeyHint="next"
                          className="h-12 rounded-xl text-base bg-white/80 dark:bg-gray-900/60 pe-11"
                        />
                        {usernameSuffix && (
                          <div className="absolute end-3 top-1/2 -translate-y-1/2">{usernameSuffix}</div>
                        )}
                      </div>
                      {usernameStatus === 'available' && username.trim().length >= 3 && !fieldErrors.username && (
                        <p className="text-[11px] text-emerald-500 font-medium px-1 flex items-center gap-1">
                          <Check className="h-3 w-3" /> {t('usernameAvailable' as any)}
                        </p>
                      )}
                      {usernameStatus === 'taken' && !fieldErrors.username && (
                        <p className="text-[11px] text-red-500 font-medium px-1 flex items-center gap-1">
                          <X className="h-3 w-3" /> {t('usernameTaken')}
                        </p>
                      )}
                      {fieldErrors.username && (
                        <p className="text-[11px] text-red-500 px-1">{fieldErrors.username}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="m-reg-email" className="text-xs font-semibold text-muted-foreground px-0.5">{t('email')}</label>
                      <Input
                        id="m-reg-email"
                        type="email"
                        value={email}
                        onChange={(e) => { setEmail(e.target.value); clearFieldError('email'); }}
                        placeholder="name@example.com"
                        autoComplete="email"
                        enterKeyHint="next"
                        dir="ltr"
                        className="h-12 rounded-xl text-base bg-white/80 dark:bg-gray-900/60"
                      />
                      {fieldErrors.email && <p className="text-[11px] text-red-500 px-1">{fieldErrors.email}</p>}
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="m-reg-password" className="text-xs font-semibold text-muted-foreground px-0.5">{t('password')}</label>
                      <div className="relative">
                        <Input
                          id="m-reg-password"
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => { setPassword(e.target.value); clearFieldError('password'); }}
                          placeholder="••••••••"
                          autoComplete="new-password"
                          enterKeyHint="next"
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
                      {password.length > 0 && (
                        <div className="flex items-center gap-2 pt-0.5">
                          <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                            <motion.div
                              initial={false}
                              animate={{ width: `${passwordStrength.score}%` }}
                              transition={{ duration: 0.3 }}
                              className={`h-full rounded-full ${
                                passwordStrength.score <= 40
                                  ? 'bg-gradient-to-r from-red-500 to-orange-500'
                                  : passwordStrength.score <= 60
                                    ? 'bg-gradient-to-r from-amber-400 to-yellow-500'
                                    : 'bg-gradient-to-r from-emerald-500 to-teal-500'
                              }`}
                            />
                          </div>
                          <span className={`text-[10px] font-semibold ${passwordStrength.textColor}`}>
                            {t(passwordStrength.labelKey as any)}
                          </span>
                        </div>
                      )}
                      {fieldErrors.password && <p className="text-[11px] text-red-500 px-1">{fieldErrors.password}</p>}
                    </div>

                    <div className="space-y-1.5">
                      <label htmlFor="m-reg-confirm" className="text-xs font-semibold text-muted-foreground px-0.5">{t('confirmPassword')}</label>
                      <div className="relative">
                        <Input
                          id="m-reg-confirm"
                          type={showConfirm ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(e) => { setConfirmPassword(e.target.value); clearFieldError('confirmPassword'); }}
                          placeholder="••••••••"
                          autoComplete="new-password"
                          enterKeyHint="done"
                          className="h-12 rounded-xl text-base bg-white/80 dark:bg-gray-900/60 pe-11"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirm(!showConfirm)}
                          aria-label={showConfirm ? copy.hidePassword : copy.showPassword}
                          className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground p-1.5"
                        >
                          {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {confirmPassword.length > 0 && password.length > 0 && !fieldErrors.confirmPassword && (
                        <p className={`text-[11px] font-medium px-1 flex items-center gap-1 ${password === confirmPassword ? 'text-emerald-500' : 'text-red-500'}`}>
                          {password === confirmPassword ? (<><Check className="h-3 w-3" /> {t('passwordsMatch' as any)}</>) : (<><X className="h-3 w-3" /> {t('passwordMismatch')}</>)}
                        </p>
                      )}
                      {fieldErrors.confirmPassword && <p className="text-[11px] text-red-500 px-1">{fieldErrors.confirmPassword}</p>}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* ── Step 2: Profile ── */}
              {step === 2 && (
                <motion.div
                  initial={{ opacity: 0, x: 32 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -32 }}
                  transition={{ duration: 0.22 }}
                  className="space-y-3.5"
                >
                  <div className="space-y-1.5">
                    <label htmlFor="m-reg-fullname" className="text-xs font-semibold text-muted-foreground px-0.5">{t('fullName')}</label>
                    <Input
                      id="m-reg-fullname"
                      value={fullName}
                      onChange={(e) => { setFullName(e.target.value); clearFieldError('fullName'); }}
                      placeholder={t('fullName')}
                      autoComplete="name"
                      enterKeyHint="next"
                      className="h-12 rounded-xl text-base bg-white/80 dark:bg-gray-900/60"
                    />
                    {fieldErrors.fullName && <p className="text-[11px] text-red-500 px-1">{fieldErrors.fullName}</p>}
                  </div>

                  {/* Phone with Algeria prefix chip */}
                  <div className="space-y-1.5">
                    <label htmlFor="m-reg-phone" className="text-xs font-semibold text-muted-foreground px-0.5">{t('phoneNumber')}</label>
                    <div className={`flex items-center rounded-xl border bg-white/80 dark:bg-gray-900/60 transition-colors ${
                      fieldErrors.phoneNumber ? 'border-red-400 ring-2 ring-red-500/20' : 'border-gray-200 dark:border-gray-700 focus-within:border-emerald-400 focus-within:ring-2 focus-within:ring-emerald-500/20'
                    }`}>
                      <div className="ps-3 flex-shrink-0">
                        <div className="flex items-center h-9 px-2.5 rounded-lg bg-gray-100 dark:bg-gray-800 text-xs text-muted-foreground font-medium" dir="ltr">
                          {t('algeriaPrefix')}
                        </div>
                      </div>
                      <Input
                        id="m-reg-phone"
                        type="tel"
                        value={phoneNumber}
                        onChange={(e) => { setPhoneNumber(e.target.value); clearFieldError('phoneNumber'); }}
                        placeholder={t('phonePlaceholder')}
                        autoComplete="tel"
                        enterKeyHint="next"
                        dir="ltr"
                        className="h-12 border-0 bg-transparent rounded-xl text-base focus-visible:ring-0 shadow-none"
                      />
                    </div>
                    {fieldErrors.phoneNumber && <p className="text-[11px] text-red-500 px-1">{fieldErrors.phoneNumber}</p>}
                  </div>

                  {/* Algeria location (optional) */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-muted-foreground px-0.5">
                      {copy.locationLabel} <span className="font-normal text-muted-foreground/60">({copy.optional})</span>
                    </p>
                    <WilayaSelect
                      value={wilayaCode}
                      onValueChange={(code) => { setWilayaCode(code); setCommuneName(''); }}
                      lang={lang}
                      placeholder={t('location.wilaya' as any) || 'Wilaya'}
                      triggerClassName="h-12 rounded-xl bg-white/80 dark:bg-gray-900/60"
                    />
                    <CommuneSelect
                      wilayaCode={wilayaCode}
                      value={communeName}
                      onValueChange={setCommuneName}
                      lang={lang}
                      placeholder={t('location.commune' as any) || 'Commune'}
                      disabled={!wilayaCode}
                      triggerClassName="h-12 rounded-xl bg-white/80 dark:bg-gray-900/60"
                    />
                  </div>
                </motion.div>
              )}

              {/* ── Step 3: Confirm ── */}
              {step === 3 && (
                <motion.div
                  initial={{ opacity: 0, x: 32 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -32 }}
                  transition={{ duration: 0.22 }}
                  className="space-y-4"
                >
                  <div className="flex justify-center">
                    <motion.div
                      animate={{ boxShadow: ['0 0 0 0 rgba(16,185,129,0.3)', '0 0 0 14px rgba(16,185,129,0)', '0 0 0 0 rgba(16,185,129,0)'] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      className="h-16 w-16 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg"
                    >
                      {avatarPreview ? (
                        <img src={avatarPreview} alt="Avatar" className="h-full w-full rounded-full object-cover" />
                      ) : (
                        <UserRound className="h-8 w-8 text-white" />
                      )}
                    </motion.div>
                  </div>

                  {/* Review card */}
                  <div className="space-y-2.5 p-4 rounded-2xl bg-gradient-to-br from-emerald-50/80 to-teal-50/80 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100 dark:border-emerald-800/30">
                    <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">{copy.reviewInfo}</p>
                    {([
                      [t('username'), username],
                      [t('fullName'), fullName],
                      [t('email'), email.trim()],
                      ...(phoneNumber ? [[t('phoneNumber'), phoneNumber] as const] : []),
                      ...(role === 'CUSTOMER' && (wilayaCode || communeName) ? [[copy.locationLabel, composeLocationLabel(wilayaCode, communeName, lang) || communeName] as const] : []),
                      [t('selectRole'), role === 'CUSTOMER' ? t('loginAsCustomer') : t('loginAsAgency')],
                    ] as [string, string][]).map(([label, value]) => (
                      <div key={label} className="flex items-center justify-between text-sm gap-3">
                        <span className="text-muted-foreground flex-shrink-0">{label}</span>
                        <span className="font-semibold text-foreground truncate" dir={label === t('email') || label === t('phoneNumber') ? 'ltr' : undefined}>{value}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{t('password')}</span>
                      <span className="font-semibold text-foreground tracking-widest">{'•'.repeat(Math.min(password.length, 10))}</span>
                    </div>
                  </div>

                  {/* Terms */}
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="m-reg-terms"
                      checked={agreeTerms}
                      onCheckedChange={(checked) => setAgreeTerms(checked === true)}
                      className="mt-1"
                    />
                    <label htmlFor="m-reg-terms" className="text-xs text-muted-foreground leading-relaxed cursor-pointer">
                      {copy.termsLead}{' '}
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t('termsOfService')}</span>{' '}
                      {t('andStr')}{' '}
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t('privacyPolicy')}</span>
                    </label>
                  </div>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Sticky bottom actions (wizard only) */}
      {!verificationData && (
        <div className="sticky bottom-0 px-5 pb-4 pt-2 bg-gradient-to-t from-background via-background/95 to-background/60 safe-area-bottom" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          <div className="max-w-md mx-auto flex gap-2.5">
            {step > 1 && (
              <Button
                variant="outline"
                onClick={goToPrev}
                disabled={loading}
                className="h-13 min-h-[52px] px-5 rounded-2xl font-semibold text-base border-2"
              >
                <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
              </Button>
            )}
            {step < 3 ? (
              <Button
                onClick={goToNext}
                className="flex-1 h-13 min-h-[52px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 active:scale-[0.99] transition-transform text-white font-bold text-base shadow-lg shadow-emerald-500/25"
              >
                {t('next') || 'Next'} <ArrowRight className="h-4 w-4 rtl:rotate-180" />
              </Button>
            ) : (
              <Button
                onClick={handleRegister}
                disabled={loading || registrationSuccess || avatarUpload.uploading}
                className="flex-1 h-13 min-h-[52px] rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 active:scale-[0.99] transition-transform text-white font-bold text-base shadow-lg shadow-emerald-500/25"
              >
                {loading ? (<><Loader2 className="h-5 w-5 animate-spin" /> {copy.creating}</>) : avatarUpload.uploading ? (<><Loader2 className="h-5 w-5 animate-spin" /> {copy.uploadInProgress}</>) : (<><UserPlus className="h-4 w-4" /> {t('register')}</>)}
              </Button>
            )}
          </div>
          {/* Login link — always reachable */}
          <p className="text-center text-xs text-muted-foreground mt-2.5">
            {t('hasAccount')}{' '}
            <button
              type="button"
              onClick={() => setView('login')}
              className="font-bold text-emerald-600 dark:text-emerald-400 min-h-[44px] inline-flex items-center"
            >
              {t('login')}
            </button>
          </p>
        </div>
      )}

      {/* Success overlay */}
      <AnimatePresence>
        {registrationSuccess && (
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
              className="flex flex-col items-center gap-3"
            >
              <div className="h-20 w-20 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center shadow-2xl shadow-emerald-500/40">
                <CheckCircle2 className="h-10 w-10 text-white" />
              </div>
              <p className="font-bold text-foreground">{copy.accountReady}</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div aria-hidden className="w-full" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
    </div>
  );
}
