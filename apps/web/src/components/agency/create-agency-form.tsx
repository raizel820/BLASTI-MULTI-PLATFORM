'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Building2,
  ArrowRight,
  ArrowLeft,
  Loader2,
  CheckCircle2,
  Check,
  MapPin,
  Phone,
  Globe,
  Hash,
  Sparkles,
  Store,
  Briefcase,
  FileText,
  Clock,
  Eye,
  Pencil,
  QrCode,
  CircleDot,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

const categoryOptions = [
  { value: 'CLINIC', labelKey: 'catClinic', icon: '🏥' },
  { value: 'AGENCY', labelKey: 'catAgency', icon: '🏢' },
  { value: 'LAW_FIRM', labelKey: 'catLawFirm', icon: '⚖️' },
  { value: 'LABORATORY', labelKey: 'catLaboratory', icon: '🔬' },
  { value: 'GOVERNMENT', labelKey: 'catGovernment', icon: '🏛️' },
  { value: 'OTHER', labelKey: 'catOther', icon: '📋' },
] as const;

// ─── Floating Label Input ─────────────────────────────
function FloatingInput({
  id,
  value,
  onChange,
  label,
  placeholder,
  error,
  dir,
  maxLength,
  type = 'text',
  icon: Icon,
  required,
  uppercase,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  error?: string;
  dir?: string;
  maxLength?: number;
  type?: string;
  icon?: React.ElementType;
  required?: boolean;
  uppercase?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        {label}
        {required && <span className="text-red-500">*</span>}
      </Label>
      <div className="relative group">
        {/* Gradient left border on focus */}
        <div
          className={`absolute start-0 top-0 bottom-0 w-1 rounded-s-xl transition-all duration-300 ${
            focused
              ? 'bg-gradient-to-b from-emerald-500 via-teal-500 to-cyan-500'
              : 'bg-transparent'
          }`}
        />
        <Input
          ref={inputRef}
          id={id}
          value={value}
          onChange={(e) => {
            const v = uppercase ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') : e.target.value;
            onChange(v);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          dir={dir}
          maxLength={maxLength}
          type={type}
          className={`h-11 rounded-xl ps-3 transition-all duration-300 ${
            error
              ? 'border-red-400 focus-visible:ring-red-400'
              : focused
                ? 'border-emerald-300 dark:border-emerald-700 shadow-sm shadow-emerald-500/10'
                : ''
          } ${uppercase ? 'uppercase' : ''}`}
        />
      </div>
      {error && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xs text-red-500"
        >
          {error}
        </motion.p>
      )}
    </div>
  );
}

// ─── Step Circle Indicator ────────────────────────────
function StepIndicator({
  currentStep,
  totalSteps,
  stepLabels,
}: {
  currentStep: number;
  totalSteps: number;
  stepLabels: string[];
}) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8 px-4">
      {Array.from({ length: totalSteps }, (_, i) => {
        const isCompleted = i < currentStep;
        const isActive = i === currentStep;
        const isFuture = i > currentStep;

        return (
          <div key={i} className="flex items-center">
            {/* Step circle + label */}
            <div className="flex flex-col items-center">
              <motion.div
                initial={false}
                animate={{
                  scale: isActive ? 1.1 : 1,
                }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className={`relative flex items-center justify-center w-10 h-10 rounded-full transition-all duration-500 ${
                  isActive
                    ? 'bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg shadow-emerald-500/30 ring-4 ring-emerald-100 dark:ring-emerald-900/30'
                    : isCompleted
                      ? 'bg-gradient-to-br from-emerald-500 to-teal-500 shadow-md shadow-emerald-500/20'
                      : 'bg-gray-100 dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700'
                }`}
              >
                {isCompleted ? (
                  <motion.div
                    initial={{ scale: 0, rotate: -90 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                  >
                    <Check className="h-5 w-5 text-white" strokeWidth={3} />
                  </motion.div>
                ) : isActive ? (
                  <span className="text-sm font-bold text-white">{i + 1}</span>
                ) : (
                  <span className="text-sm font-semibold text-gray-400 dark:text-gray-500">{i + 1}</span>
                )}
              </motion.div>
              {/* Step label */}
              <span
                className={`mt-2 text-[10px] sm:text-xs font-medium text-center max-w-[60px] leading-tight transition-colors duration-300 ${
                  isActive
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : isCompleted
                      ? 'text-emerald-600/70 dark:text-emerald-400/70'
                      : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {stepLabels[i]}
              </span>
            </div>

            {/* Connector line */}
            {i < totalSteps - 1 && (
              <div className="relative w-6 sm:w-12 h-0.5 mx-1 mb-5">
                <div className="absolute inset-0 bg-gray-200 dark:bg-gray-700 rounded-full" />
                <motion.div
                  className="absolute inset-y-0 start-0 bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full"
                  initial={{ width: '0%' }}
                  animate={{ width: isCompleted ? '100%' : '0%' }}
                  transition={{ duration: 0.5, ease: 'easeInOut' }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Category Selection Card ──────────────────────────
function CategoryCard({
  option,
  isSelected,
  onClick,
  label,
}: {
  option: typeof categoryOptions[number];
  isSelected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.97 }}
      className={`relative flex flex-col items-center justify-center gap-1.5 p-3 sm:p-4 rounded-xl border-2 transition-all duration-300 cursor-pointer group ${
        isSelected
          ? 'border-emerald-500 dark:border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 shadow-md shadow-emerald-500/10'
          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10'
      }`}
    >
      {/* Checkmark badge */}
      <AnimatePresence>
        {isSelected && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="absolute -top-1.5 -end-1.5 w-5 h-5 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-full flex items-center justify-center shadow-sm"
          >
            <Check className="h-3 w-3 text-white" strokeWidth={3} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Emoji icon */}
      <span className="text-2xl sm:text-3xl select-none">{option.icon}</span>

      {/* Category name */}
      <span
        className={`text-xs sm:text-sm font-medium text-center leading-tight transition-colors duration-200 ${
          isSelected
            ? 'text-emerald-700 dark:text-emerald-300'
            : 'text-gray-600 dark:text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400'
        }`}
      >
        {label}
      </span>
    </motion.button>
  );
}

// ─── Confetti Circle ──────────────────────────────────
function ConfettiCircle({ delay, x, size, color, duration }: { delay: number; x: string; size: number; color: string; duration: number }) {
  return (
    <motion.div
      className="absolute rounded-full pointer-events-none"
      style={{ width: size, height: size, backgroundColor: color }}
      initial={{ opacity: 0, y: 0, x: 0, scale: 0 }}
      animate={{
        opacity: [0, 1, 1, 0],
        y: [-20, -60, -120],
        x: [0, parseFloat(x) * 20, parseFloat(x) * 40],
        scale: [0, 1.2, 0.8],
        rotate: [0, 180, 360],
      }}
      transition={{
        duration,
        delay,
        ease: 'easeOut',
      }}
    />
  );
}

// ─── Preview Summary Section ──────────────────────────
function PreviewSection({
  title,
  icon: Icon,
  onEdit,
  children,
}: {
  title: string;
  icon: React.ElementType;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="h-7 px-2 text-xs gap-1 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
        >
          <Pencil className="h-3 w-3" />
          {title === 'Preview' ? '' : ''}
        </Button>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function PreviewRow({ label, value, dir }: { label: string; value: string; dir?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-2 text-sm">
      <span className="text-muted-foreground text-xs shrink-0">{label}</span>
      <span className="text-foreground font-medium text-end" dir={dir}>
        {value}
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────
interface CreateAgencyFormProps {
  onAgencyCreated?: (agencyId: string, agencyName: string) => void;
}

export function CreateAgencyForm({ onAgencyCreated }: CreateAgencyFormProps) {
  const { t } = useLanguage();
  const { user, setUser } = useAppStore();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [createdAgencyName, setCreatedAgencyName] = useState('');
  const [createdAgencyCode, setCreatedAgencyCode] = useState('');

  // Step 0: Basic info
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameFr, setNameFr] = useState('');
  const [category, setCategory] = useState('CLINIC');

  // Step 1: Contact Details
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [description, setDescription] = useState('');
  const [customCode, setCustomCode] = useState('');

  // Step 2: Working Hours
  const [workingHoursStart, setWorkingHoursStart] = useState('08:00');
  const [workingHoursEnd, setWorkingHoursEnd] = useState('17:00');

  // Errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  const totalSteps = 4; // Basic Info, Contact, Working Hours, Preview

  const stepLabels = [
    t('basicInfo' as any),
    t('contactDetails' as any),
    t('workingHours' as any),
    t('preview' as any),
  ];

  const goToStep = (targetStep: number) => {
    setDirection(targetStep > step ? 1 : -1);
    setStep(targetStep);
  };

  const validateStep0 = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = t('agencyNameRequired' as any);
    if (!category) errs.category = t('agencyCategoryRequired' as any);
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const validateStep1 = () => {
    const errs: Record<string, string> = {};
    if (customCode && customCode.length < 2) errs.customCode = t('agencyCodeMinLength' as any);
    if (customCode && customCode.length > 10) errs.customCode = t('agencyCodeMaxLength' as any);
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const validateStep2 = () => {
    // Working hours are optional with defaults, no validation needed
    setErrors({});
    return true;
  };

  const handleNext = () => {
    if (step === 0 && validateStep0()) {
      goToStep(1);
    } else if (step === 1 && validateStep1()) {
      goToStep(2);
    } else if (step === 2 && validateStep2()) {
      goToStep(3);
    }
  };

  const handleBack = () => {
    if (step > 0) goToStep(step - 1);
  };

  const handleCreate = async () => {
    if (!validateStep0() || !validateStep1()) return;

    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        category,
      };
      if (nameAr.trim()) body.nameAr = nameAr.trim();
      if (nameFr.trim()) body.nameFr = nameFr.trim();
      if (address.trim()) body.address = address.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (email.trim()) body.email = email.trim();
      if (description.trim()) body.description = description.trim();
      if (customCode.trim()) body.customCode = customCode.trim().toUpperCase();
      if (workingHoursStart) body.workingHoursStart = workingHoursStart;
      if (workingHoursEnd) body.workingHoursEnd = workingHoursEnd;

      const res = await apiFetch('/api/agencies?XTransformPort=3003', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'Agency code already taken') {
          setErrors({ customCode: t('agencyCodeTaken' as any) });
          toast.error(t('agencyCodeTaken' as any));
          goToStep(1);
        } else {
          toast.error(data.error || t('createAgencyFailed' as any));
        }
        return;
      }

      // Success! Update the Zustand store with the new agency info
      if (data.agency && user) {
        setUser({
          ...user,
          agencyId: data.agency.id,
          agencyName: data.agency.name,
          agencyNameAr: data.agency.nameAr || data.agency.name,
          agencyNameFr: data.agency.nameFr || data.agency.name,
        });
      }

      setCreatedAgencyName(data.agency?.name || name);
      setCreatedAgencyCode(data.agency?.customCode || customCode || name.slice(0, 3).toUpperCase());
      setCreated(true);
      toast.success(t('agencyCreatedSuccess' as any));

      // Notify parent component
      if (onAgencyCreated && data.agency) {
        onAgencyCreated(data.agency.id, data.agency.name);
      }
    } catch (err) {
      console.error('[CreateAgencyForm] Error:', err);
      toast.error(t('createAgencyFailed' as any));
    } finally {
      setCreating(false);
    }
  };

  const slideVariants = {
    enter: (dir: number) => ({ x: dir > 0 ? 60 : -60, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({ x: dir < 0 ? 60 : -60, opacity: 0 }),
  };

  // ─── Get selected category label ─────────────────
  const getSelectedCategoryLabel = () => {
    const found = categoryOptions.find((o) => o.value === category);
    return found ? t(found.labelKey as any) : category;
  };

  // ─── Confetti colors ────────────────────────────
  const confettiColors = [
    'rgba(16, 185, 129, 0.6)',
    'rgba(20, 184, 166, 0.5)',
    'rgba(6, 182, 212, 0.5)',
    'rgba(52, 211, 153, 0.5)',
    'rgba(94, 234, 212, 0.4)',
    'rgba(110, 231, 183, 0.5)',
  ];

  // ─── Success State ──────────────────────────────
  if (created) {
    return (
      <div className="relative flex flex-col items-center justify-center py-10 text-center overflow-hidden">
        {/* Confetti decorative circles */}
        {confettiColors.map((color, i) => (
          <ConfettiCircle
            key={i}
            delay={i * 0.15}
            x={((i % 3) - 1).toString()}
            size={8 + i * 3}
            color={color}
            duration={2 + i * 0.3}
          />
        ))}

        {/* Floating background decorations */}
        <motion.div
          className="absolute top-8 start-6 w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/20 opacity-40"
          animate={{ y: [0, -15, 0], rotate: [0, 10, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute top-20 end-8 w-12 h-12 rounded-full bg-teal-100 dark:bg-teal-900/20 opacity-40"
          animate={{ y: [0, -10, 0], rotate: [0, -15, 0] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut', delay: 0.5 }}
        />
        <motion.div
          className="absolute bottom-24 start-10 w-10 h-10 rounded-full bg-cyan-100 dark:bg-cyan-900/20 opacity-40"
          animate={{ y: [0, -12, 0], rotate: [0, 8, 0] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
        />
        <motion.div
          className="absolute bottom-32 end-6 w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/20 opacity-30"
          animate={{ y: [0, -8, 0], rotate: [0, -12, 0] }}
          transition={{ duration: 3.8, repeat: Infinity, ease: 'easeInOut', delay: 0.8 }}
        />

        {/* Main success icon */}
        <motion.div
          initial={{ scale: 0, rotate: -180 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 200, damping: 12 }}
          className="h-28 w-28 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center mb-6 shadow-xl shadow-emerald-500/20 relative z-10"
        >
          <CheckCircle2 className="h-14 w-14 text-emerald-600 dark:text-emerald-400" />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="relative z-10"
        >
          <h3 className="text-xl font-bold text-foreground mb-2">
            {t('agencyCreatedTitle' as any)}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-1">
            {t('agencyCreatedDesc' as any)}
          </p>
          <p className="text-base font-semibold text-emerald-600 dark:text-emerald-400 mb-4">
            {createdAgencyName}
          </p>

          {/* Agency Code Display */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.6 }}
            className="inline-flex flex-col items-center gap-3 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 rounded-2xl p-5 mb-6 border border-gray-200/50 dark:border-gray-700/50 shadow-lg"
          >
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('agencyCodePreview' as any)}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-3xl font-mono font-bold tracking-widest text-emerald-600 dark:text-emerald-400 bg-white dark:bg-gray-950 px-5 py-2 rounded-xl border border-emerald-200 dark:border-emerald-800 shadow-inner">
                {createdAgencyCode}
              </span>
            </div>

            {/* QR Code Placeholder */}
            <div className="mt-2 flex flex-col items-center gap-1.5">
              <div className="w-24 h-24 rounded-xl bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-700 flex items-center justify-center shadow-sm">
                <div className="grid grid-cols-5 grid-rows-5 gap-0.5 w-16 h-16">
                  {Array.from({ length: 25 }, (_, i) => (
                    <div
                      key={i}
                      className={`rounded-sm ${
                        Math.random() > 0.4
                          ? 'bg-gray-800 dark:bg-gray-200'
                          : 'bg-transparent'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <QrCode className="h-3 w-3" />
                {t('qrCodeAgency' as any)}
              </span>
            </div>
          </motion.div>

          <p className="text-xs text-muted-foreground max-w-xs mb-6">
            {t('agencyCreatedNextSteps' as any)}
          </p>
          <Button
            onClick={() => window.location.reload()}
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white gap-2 shadow-lg shadow-emerald-500/20 rounded-xl h-11 px-6"
          >
            <Sparkles className="h-4 w-4" />
            {t('goToDashboard' as any)}
          </Button>
        </motion.div>
      </div>
    );
  }

  // ─── Form Steps ─────────────────────────────────
  return (
    <div className="max-w-lg mx-auto">
      {/* Header */}
      <div className="text-center mb-6">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/10"
        >
          <Building2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
        </motion.div>
        <h3 className="text-lg font-bold text-foreground">
          {t('createYourAgency' as any)}
        </h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t('createYourAgencyDesc' as any)}
        </p>
      </div>

      {/* Step indicator */}
      <StepIndicator
        currentStep={step}
        totalSteps={totalSteps}
        stepLabels={stepLabels}
      />

      {/* Step Content */}
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.25, ease: 'easeInOut' }}
        >
          {/* Step 0: Basic Info */}
          {step === 0 && (
            <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
              <CardContent className="p-5 space-y-5">
                <div className="flex items-center gap-2 mb-2">
                  <Store className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-sm font-semibold text-foreground">{t('basicInfo' as any)}</span>
                </div>

                {/* Agency Name (required) */}
                <FloatingInput
                  id="agency-name"
                  value={name}
                  onChange={(v) => { setName(v); setErrors((p) => ({ ...p, name: '' })); }}
                  label={t('agencyName' as any)}
                  placeholder={t('agencyNamePlaceholder' as any)}
                  error={errors.name}
                  icon={Building2}
                  required
                />

                {/* Arabic Name */}
                <FloatingInput
                  id="agency-name-ar"
                  value={nameAr}
                  onChange={setNameAr}
                  label={`${t('agencyNameAr' as any)} (${t('optional' as any)})`}
                  placeholder={t('agencyNameArPlaceholder' as any)}
                  dir="rtl"
                />

                {/* French Name */}
                <FloatingInput
                  id="agency-name-fr"
                  value={nameFr}
                  onChange={setNameFr}
                  label={`${t('agencyNameFr' as any)} (${t('optional' as any)})`}
                  placeholder={t('agencyNameFrPlaceholder' as any)}
                  dir="ltr"
                />

                {/* Category Selection Grid */}
                <div className="space-y-2.5">
                  <Label className="text-sm font-medium">
                    {t('agencyCategory' as any)} <span className="text-red-500">*</span>
                  </Label>
                  <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    {categoryOptions.map((opt) => (
                      <CategoryCard
                        key={opt.value}
                        option={opt}
                        isSelected={category === opt.value}
                        onClick={() => { setCategory(opt.value); setErrors((p) => ({ ...p, category: '' })); }}
                        label={t(opt.labelKey as any)}
                      />
                    ))}
                  </div>
                  {errors.category && (
                    <motion.p
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-xs text-red-500"
                    >
                      {errors.category}
                    </motion.p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 1: Contact Details */}
          {step === 1 && (
            <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
              <CardContent className="p-5 space-y-5">
                <div className="flex items-center gap-2 mb-2">
                  <Briefcase className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                  <span className="text-sm font-semibold text-foreground">{t('contactDetails' as any)}</span>
                </div>

                {/* Address */}
                <FloatingInput
                  id="agency-address"
                  value={address}
                  onChange={setAddress}
                  label={`${t('agencyAddress' as any)} (${t('optional' as any)})`}
                  placeholder={t('agencyAddressPlaceholder' as any)}
                  icon={MapPin}
                />

                {/* Phone */}
                <FloatingInput
                  id="agency-phone"
                  value={phone}
                  onChange={setPhone}
                  label={`${t('phoneNumber' as any)} (${t('optional' as any)})`}
                  placeholder={t('agencyPhonePlaceholder' as any)}
                  dir="ltr"
                  icon={Phone}
                />

                {/* Email */}
                <FloatingInput
                  id="agency-email"
                  value={email}
                  onChange={setEmail}
                  label={`${t('email' as any)} (${t('optional' as any)})`}
                  placeholder={t('agencyEmailPlaceholder' as any)}
                  type="email"
                  dir="ltr"
                  icon={Globe}
                />

                {/* Description */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    {t('description' as any)} <span className="text-xs text-muted-foreground">({t('optional' as any)})</span>
                  </Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('agencyDescriptionPlaceholder' as any)}
                    className="rounded-xl min-h-[80px] resize-none"
                    maxLength={500}
                  />
                  <p className="text-[10px] text-muted-foreground text-end">{description.length}/500</p>
                </div>

                {/* Custom Code */}
                <FloatingInput
                  id="agency-code"
                  value={customCode}
                  onChange={(v) => { setCustomCode(v); setErrors((p) => ({ ...p, customCode: '' })); }}
                  label={`${t('agencyCodeField' as any)} (${t('optional' as any)})`}
                  placeholder={t('agencyCodePlaceholder' as any)}
                  dir="ltr"
                  maxLength={10}
                  icon={Hash}
                  error={errors.customCode}
                  uppercase
                />
                {!errors.customCode && (
                  <p className="text-[10px] text-muted-foreground -mt-3">{t('agencyCodeAutoGenerated' as any)}</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Step 2: Working Hours */}
          {step === 2 && (
            <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
              <CardContent className="p-5 space-y-5">
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                  <span className="text-sm font-semibold text-foreground">{t('workingHours' as any)}</span>
                </div>

                <p className="text-xs text-muted-foreground -mt-2">
                  {t('workingHoursDesc' as any)}
                </p>

                {/* Visual time range indicator */}
                <div className="flex items-center gap-3 justify-center py-4">
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 }}
                    className="flex flex-col items-center gap-1.5"
                  >
                    <div className="h-12 w-12 rounded-full bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center shadow-sm">
                      <span className="text-lg">🌅</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('workingHoursStart' as any)}</span>
                  </motion.div>

                  <motion.div
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ delay: 0.3, duration: 0.5 }}
                    className="flex-1 h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 rounded-full max-w-[100px]"
                  />

                  <motion.div
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 }}
                    className="flex flex-col items-center gap-1.5"
                  >
                    <div className="h-12 w-12 rounded-full bg-gradient-to-br from-cyan-100 to-teal-100 dark:from-cyan-900/30 dark:to-teal-900/30 flex items-center justify-center shadow-sm">
                      <span className="text-lg">🌆</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('workingHoursEnd' as any)}</span>
                  </motion.div>
                </div>

                {/* Time inputs */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="wh-start" className="text-sm font-medium flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-emerald-500" />
                      {t('workingHoursStart' as any)}
                    </Label>
                    <div className="relative group">
                      <div className="absolute start-0 top-0 bottom-0 w-1 rounded-s-xl bg-gradient-to-b from-emerald-400 to-teal-400 opacity-0 group-focus-within:opacity-100 transition-opacity duration-300" />
                      <Input
                        id="wh-start"
                        type="time"
                        value={workingHoursStart}
                        onChange={(e) => setWorkingHoursStart(e.target.value)}
                        className="h-11 rounded-xl ps-3"
                        dir="ltr"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="wh-end" className="text-sm font-medium flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-cyan-500" />
                      {t('workingHoursEnd' as any)}
                    </Label>
                    <div className="relative group">
                      <div className="absolute start-0 top-0 bottom-0 w-1 rounded-s-xl bg-gradient-to-b from-teal-400 to-cyan-400 opacity-0 group-focus-within:opacity-100 transition-opacity duration-300" />
                      <Input
                        id="wh-end"
                        type="time"
                        value={workingHoursEnd}
                        onChange={(e) => setWorkingHoursEnd(e.target.value)}
                        className="h-11 rounded-xl ps-3"
                        dir="ltr"
                      />
                    </div>
                  </div>
                </div>

                {/* Quick presets */}
                <div className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground">{t('quickPresets' as any)}</span>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { start: '08:00', end: '17:00', label: '8AM - 5PM' },
                      { start: '08:00', end: '16:00', label: '8AM - 4PM' },
                      { start: '09:00', end: '18:00', label: '9AM - 6PM' },
                      { start: '07:00', end: '15:00', label: '7AM - 3PM' },
                    ].map((preset) => (
                      <Button
                        key={preset.label}
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setWorkingHoursStart(preset.start);
                          setWorkingHoursEnd(preset.end);
                        }}
                        className={`h-7 text-[10px] rounded-lg gap-1 ${
                          workingHoursStart === preset.start && workingHoursEnd === preset.end
                            ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground'
                        }`}
                      >
                        <Clock className="h-2.5 w-2.5" />
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3: Preview */}
          {step === 3 && (
            <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <Eye className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-sm font-semibold text-foreground">{t('preview' as any)}</span>
                </div>

                <p className="text-xs text-muted-foreground -mt-1">
                  {t('previewDescription' as any)}
                </p>

                {/* Basic Info Preview */}
                <PreviewSection
                  title={t('basicInfo' as any)}
                  icon={Store}
                  onEdit={() => goToStep(0)}
                >
                  <PreviewRow label={t('agencyName' as any)} value={name} />
                  {nameAr && <PreviewRow label={t('agencyNameAr' as any)} value={nameAr} dir="rtl" />}
                  {nameFr && <PreviewRow label={t('agencyNameFr' as any)} value={nameFr} dir="ltr" />}
                  <PreviewRow label={t('agencyCategory' as any)} value={`${categoryOptions.find(o => o.value === category)?.icon} ${getSelectedCategoryLabel()}`} />
                </PreviewSection>

                {/* Contact Details Preview */}
                <PreviewSection
                  title={t('contactDetails' as any)}
                  icon={Briefcase}
                  onEdit={() => goToStep(1)}
                >
                  {address && <PreviewRow label={t('agencyAddress' as any)} value={address} />}
                  {phone && <PreviewRow label={t('phoneNumber' as any)} value={phone} dir="ltr" />}
                  {email && <PreviewRow label={t('email' as any)} value={email} dir="ltr" />}
                  {description && <PreviewRow label={t('description' as any)} value={description.length > 80 ? `${description.slice(0, 80)}...` : description} />}
                  {customCode && <PreviewRow label={t('agencyCodeField' as any)} value={customCode} dir="ltr" />}
                  {!address && !phone && !email && !description && !customCode && (
                    <span className="text-xs text-muted-foreground italic">{t('noData' as any)}</span>
                  )}
                </PreviewSection>

                {/* Working Hours Preview */}
                <PreviewSection
                  title={t('workingHours' as any)}
                  icon={Clock}
                  onEdit={() => goToStep(2)}
                >
                  <PreviewRow label={t('workingHoursStart' as any)} value={workingHoursStart} dir="ltr" />
                  <PreviewRow label={t('workingHoursEnd' as any)} value={workingHoursEnd} dir="ltr" />
                </PreviewSection>

                {/* Confirmation notice */}
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="flex items-start gap-2 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200/50 dark:border-emerald-800/30"
                >
                  <CircleDot className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-emerald-700 dark:text-emerald-300 leading-relaxed">
                    {t('previewConfirmation' as any)}
                  </p>
                </motion.div>
              </CardContent>
            </Card>
          )}
        </motion.div>
      </AnimatePresence>

      {/* Navigation Buttons */}
      <div className="flex items-center justify-between mt-5 gap-3">
        {step > 0 ? (
          <Button
            variant="outline"
            onClick={handleBack}
            className="gap-1.5 rounded-xl h-10"
          >
            <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
            {t('back' as any)}
          </Button>
        ) : (
          <div />
        )}

        {step < totalSteps - 1 ? (
          <Button
            onClick={handleNext}
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white gap-1.5 shadow-sm rounded-xl h-10 px-5"
          >
            {t('next' as any)}
            <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </Button>
        ) : (
          <Button
            onClick={handleCreate}
            disabled={creating}
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white gap-1.5 shadow-lg shadow-emerald-500/20 rounded-xl h-10 px-5"
          >
            {creating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('creating' as any)}
              </>
            ) : (
              <>
                <Building2 className="h-4 w-4" />
                {t('createAgency' as any)}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
