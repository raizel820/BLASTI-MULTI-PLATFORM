'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useUpload } from '@/hooks/use-upload';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Crown,
  Check,
  Star,
  Upload,
  CreditCard,
  Loader2,
  X,
  FileText,
  ImageIcon,
  Info,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Building2,
  Shield,
  MessageSquare,
  Landmark,
  Wallet,
  ArrowRight,
  Sparkles,
  ClipboardCheck,
  Clock,
  Receipt,
  Monitor,
  Printer,
  Tablet,
  Cpu,
  ShoppingCart,
  Package,
  Mail,
  Phone,
  Hash,
  Building,
  BarChart3,
  Flame,
  Palette,
  Code2,
  AlertCircle,
  Ban,
  Send,
  Settings2,
  Layers,
  ArrowUpCircle,
  ArrowDownCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

// ─── Types ──────────────────────────────────────────────────────────────────
// These mirror the Phase-2 SubscriptionPlan / PlanFeature models in
// packages/db/prisma/schema.prisma. The agency page consumes them directly
// from GET /api/agency/subscription (which now returns `availablePlans[]`).

interface PlanFeature {
  id: string;
  planId: string;
  featureKey: string;
  featureName: string;
  featureNameAr: string | null;
  featureNameFr: string | null;
  enabled: boolean;
  limitValue: number | null;
}

interface SubscriptionPlan {
  id: string;
  name: string;
  displayName: string;
  displayNameAr: string | null;
  displayNameFr: string | null;
  description: string | null;
  descriptionAr: string | null;
  descriptionFr: string | null;
  price: number;
  currency: string;
  billingCycle: string; // 'MONTHLY' | 'YEARLY' | 'ONE_TIME'
  maxServices: number;
  maxBranches: number;
  maxStaff: number;
  maxActiveReservations: number;
  maxSmsPerMonth: number;
  kioskModeEnabled: boolean;
  analyticsEnabled: boolean;
  priorityListing: boolean;
  customBranding: boolean;
  apiAccess: boolean;
  isActive: boolean;
  sortOrder: number;
  // Period-discount fields (mirrors the SubscriptionPlan DB columns). When > 0,
  // the agency can pay for that many months upfront at the discounted rate.
  quarterlyDiscount: number;
  semiAnnualDiscount: number;
  annualDiscount: number;
  biennialDiscount: number;
  // Enterprise custom-plan flags. `isEnterprise` marks a bespoke plan created
  // from an admin-approved EnterpriseContractRequest; `ownerAgencyId` is the
  // agency the plan was built for (null for regular public catalog plans).
  // The backend only returns enterprise plans to their owning agency, so when
  // either of these is set on a plan in `availablePlans`, it belongs to the
  // current agency.
  isEnterprise?: boolean;
  ownerAgencyId?: string | null;
  features: PlanFeature[];
}

interface Transaction {
  id: string;
  amount: number;
  amountPaid?: number | null;
  plan: string;
  planName?: string | null;
  method: string;
  status: string;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
}

interface SubscriptionData {
  currentPlan: string;
  status: string;
  expiresAt?: string;
  subscriptionStartsAt?: string | null;
  subscriptionExpiresAt?: string | null;
  daysRemaining?: number | null;
  isExpired?: boolean;
  isExpiringSoon?: boolean;
  availablePlans: SubscriptionPlan[];
  recentTransactions: Transaction[];
}

interface FaqItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
}

// ─── Hardware / Enterprise types ────────────────────────────────────────────
// Mirrors the HardwareProduct / HardwareCommitmentTier / HardwareOrder /
// HardwareSettings / EnterpriseContractRequest models in
// packages/db/prisma/schema.prisma. The agency page consumes them directly
// from GET /api/agency/hardware and GET /api/agency/enterprise-request.

interface HardwareProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  descriptionFr?: string | null;
  category: string; // "TV", "PC", "KIOSK", "PRINTER"
  basePrice: number; // DZD
  isActive: boolean;
  sortOrder: number;
}

interface CommitmentTier {
  id: string;
  months: number; // 12/24/36/48/60
  label: string;
  labelAr?: string | null;
  labelFr?: string | null;
  extraPercentage: number;
  isActive: boolean;
  sortOrder: number;
}

interface HardwareSettings {
  hardwareEnabled: boolean;
  upfrontDiscount?: number;
}

interface HardwareOrderItem {
  id: string;
  productId: string;
  quantity: number;
  unitPrice: number;
  product: HardwareProduct;
}

interface HardwareOrder {
  id: string;
  paymentModel: string; // "UPFRONT" | "MONTHLY"
  commitmentMonths: number | null;
  totalBasePrice: number;
  extraPercentage: number;
  monthlyExtra: number;
  upfrontTotal: number;
  status: string; // PENDING / APPROVED / REJECTED / FULFILLED
  items: HardwareOrderItem[];
  createdAt: string;
}

interface EnterpriseRequest {
  id: string;
  agencyName: string;
  contactEmail: string;
  contactPhone?: string | null;
  message: string;
  requestedFeatures: string | string[];
  branchesNeeded: number;
  countersNeeded: number;
  hardwareNeeded: boolean;
  status: string; // PENDING / REVIEWING / APPROVED / REJECTED
  adminNotes?: string | null;
  customPlanId?: string | null;
  createdAt: string;
}

// ─── Plan accent-color helper ───────────────────────────────────────────────
// Derives a Tailwind gradient + ring palette from the plan name so each card
// has a distinct visual identity (mirrors the admin plan page logic).

interface PlanAccent {
  gradientFrom: string;
  gradientTo: string;
  ringActive: string;
  badgeBg: string;
  icon: typeof Building2;
}

function getPlanAccent(plan: SubscriptionPlan): PlanAccent {
  const name = plan.name.toUpperCase();
  if (name === 'FREE') {
    return {
      gradientFrom: 'from-slate-400',
      gradientTo: 'to-slate-500',
      ringActive: 'border-slate-500',
      badgeBg: 'from-slate-400 to-slate-500',
      icon: Sparkles,
    };
  }
  if (name === 'PREMIUM' || name === 'GOLD') {
    return {
      gradientFrom: 'from-amber-400',
      gradientTo: 'to-amber-500',
      ringActive: 'border-amber-500',
      badgeBg: 'from-amber-400 to-amber-500',
      icon: Crown,
    };
  }
  if (name === 'PRO' || name === 'ENTERPRISE') {
    return {
      gradientFrom: 'from-purple-500',
      gradientTo: 'to-fuchsia-600',
      ringActive: 'border-purple-500',
      badgeBg: 'from-purple-500 to-fuchsia-600',
      icon: Star,
    };
  }
  // BASIC and any custom plan → default emerald/teal
  return {
    gradientFrom: 'from-emerald-500',
    gradientTo: 'to-teal-600',
    ringActive: 'border-emerald-500',
    badgeBg: 'from-emerald-500 to-teal-600',
    icon: Building2,
  };
}

// ─── Billing-cycle label helper ──────────────────────────────────────────────

function getBillingCycleLabel(cycle: string, lang: 'ar' | 'fr' | 'en'): string {
  if (cycle === 'YEARLY') {
    return lang === 'ar' ? '/ سنة' : lang === 'fr' ? '/ an' : '/ year';
  }
  if (cycle === 'ONE_TIME') {
    return lang === 'ar' ? 'دفعة واحدة' : lang === 'fr' ? 'paiement unique' : 'one-time';
  }
  // MONTHLY (default)
  return lang === 'ar' ? '/ شهر' : lang === 'fr' ? '/ mois' : '/ month';
}

// ─── Period-discount helpers ─────────────────────────────────────────────────
// A plan can offer optional discounts when an agency pays for multiple months
// upfront. These helpers compute the discount %, the available periods for a
// plan, and the discounted total for a given period.

function getDiscountForPeriod(plan: SubscriptionPlan, period: number): number {
  switch (period) {
    case 3: return plan.quarterlyDiscount ?? 0;
    case 6: return plan.semiAnnualDiscount ?? 0;
    case 12: return plan.annualDiscount ?? 0;
    case 24: return plan.biennialDiscount ?? 0;
    default: return 0;
  }
}

// Returns the list of billing periods available for the given plan. Always
// includes period = 1 (monthly); longer periods are only included when the
// admin configured a discount > 0 for them.
function getAvailablePeriods(plan: SubscriptionPlan): number[] {
  const periods = [1];
  if ((plan.quarterlyDiscount ?? 0) > 0) periods.push(3);
  if ((plan.semiAnnualDiscount ?? 0) > 0) periods.push(6);
  if ((plan.annualDiscount ?? 0) > 0) periods.push(12);
  if ((plan.biennialDiscount ?? 0) > 0) periods.push(24);
  return periods;
}

function getPeriodLabel(period: number, lang: 'ar' | 'fr' | 'en'): string {
  switch (period) {
    case 3: return lang === 'ar' ? '3 أشهر' : lang === 'fr' ? '3 mois' : '3 Months';
    case 6: return lang === 'ar' ? '6 أشهر' : lang === 'fr' ? '6 mois' : '6 Months';
    case 12: return lang === 'ar' ? '12 شهر' : lang === 'fr' ? '12 mois' : '12 Months';
    case 24: return lang === 'ar' ? '24 شهر' : lang === 'fr' ? '24 mois' : '24 Months';
    default: return lang === 'ar' ? 'شهري' : lang === 'fr' ? 'Mensuel' : 'Monthly';
  }
}

// Compute the total amount for a given plan + period: base × period × (1 − discount%).
function getTotalForPeriod(plan: SubscriptionPlan, period: number): number {
  const discount = getDiscountForPeriod(plan, period);
  return Math.round(plan.price * period * (1 - discount / 100));
}

// ─── Payment Dialog Component ───
//
// 3-step payment flow: 1) method, 2) receipt upload, 3) review & submit.
// When `hardware` is provided and hardwareEnabled is true, the review step
// also shows an optional "Add hardware to your subscription" picker — the
// selected items are submitted as a separate POST /api/agency/hardware/orders
// after the subscription payment succeeds (best-effort, never blocks the
// subscription success path).
function PaymentDialog({
  open,
  onOpenChange,
  selectedPlan,
  onSuccess,
  hardware,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPlan: SubscriptionPlan | null;
  onSuccess: () => void;
  hardware?: {
    products: HardwareProduct[];
    commitmentTiers: CommitmentTier[];
    settings: HardwareSettings;
  } | null;
}) {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [paymentMethod, setPaymentMethod] = useState('CCP');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [expandedInstructions, setExpandedInstructions] = useState<string | null>(null);
  const [paymentStep, setPaymentStep] = useState(1); // 1=method, 2=receipt, 3=review
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Billing period (months). 1 = monthly (default), 3/6/12/24 = extended
  // periods that unlock the admin-configured discount for the chosen plan.
  const [period, setPeriod] = useState<number>(1);
  // Available periods for the currently selected plan (depends on which
  // discounts the admin configured). Falls back to [1] when no plan selected.
  const availablePeriods = selectedPlan ? getAvailablePeriods(selectedPlan) : [1];

  // Hardware picker state — only used when `hardware` prop is provided and
  // hardwareEnabled is true. Lives inside the dialog so the user can add
  // hardware to their order during the subscribe flow without leaving.
  const [hwQuantities, setHwQuantities] = useState<Record<string, number>>({});
  const [hwPaymentModel, setHwPaymentModel] = useState<'UPFRONT' | 'MONTHLY'>('UPFRONT');
  const [hwCommitmentMonths, setHwCommitmentMonths] = useState<number>(
    hardware?.commitmentTiers?.[0]?.months ?? 12,
  );
  const [hwExpanded, setHwExpanded] = useState(false);

  const hasHardware = !!(
    hardware &&
    hardware.settings.hardwareEnabled &&
    hardware.products.length > 0
  );

  const receiptUpload = useUpload({
    type: 'receipt',
    maxSize: 5 * 1024 * 1024,
    onError: (error) => {
      toast.error(error);
    },
  });

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setPaymentStep(1);
      setPaymentMethod('CCP');
      setReceiptFile(null);
      setReceiptPreview(null);
      setExpandedInstructions(null);
      setShowSuccessAnimation(false);
      setHwQuantities({});
      setHwPaymentModel('UPFRONT');
      setHwCommitmentMonths(hardware?.commitmentTiers?.[0]?.months ?? 12);
      setHwExpanded(false);
      // Reset the billing period to the default (1 = monthly) — the user
      // re-picks an extended period each time they open the dialog.
      setPeriod(1);
    }
  }, [open, hardware]);

  const getLocalizedPlanName = (plan: SubscriptionPlan | null) => {
    if (!plan) return '';
    if (lang === 'ar' && plan.displayNameAr) return plan.displayNameAr;
    if (lang === 'fr' && plan.displayNameFr) return plan.displayNameFr;
    return plan.displayName || plan.name;
  };

  const getPaymentMethodLabel = (method: string) => {
    if (method === 'CCP') return t('ccpTransfer');
    if (method === 'BANK_TRANSFER' || method === 'BANK') return t('bankTransfer');
    return t('electronicPayment');
  };

  const paymentMethods = [
    {
      id: 'CCP',
      label: t('ccpTransfer'),
      instructions: t('ccpInstructions'),
      icon: Landmark,
      description: lang === 'ar' ? 'تحويل عبر بريد الجزائر' : lang === 'fr' ? 'Virement via Poste Algérienne' : 'Transfer via Algerian Post',
    },
    {
      id: 'BANK_TRANSFER',
      label: t('bankTransfer'),
      instructions: t('bankInstructions'),
      icon: Building2,
      description: lang === 'ar' ? 'تحويل مصرفي مباشر' : lang === 'fr' ? 'Virement bancaire direct' : 'Direct bank transfer',
    },
    {
      id: 'ELECTRONIC',
      label: t('electronicPayment'),
      instructions: t('eWalletInstructions'),
      icon: Wallet,
      description: lang === 'ar' ? 'باريدي موب أو محفظة إلكترونية' : lang === 'fr' ? 'BaridiMob ou e-wallet' : 'BaridiMob or e-wallet',
    },
  ];

  const dialogSteps = [
    { step: 1, label: t('stepPaymentMethod'), icon: CreditCard },
    { step: 2, label: t('stepReceipt'), icon: Upload },
    { step: 3, label: t('stepReview'), icon: CheckCircle2 },
  ];

  const getFileSize = () => {
    if (!receiptFile) return '';
    const size = receiptFile.size;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('fileTooLarge'));
      return;
    }
    setReceiptFile(file);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => setReceiptPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setReceiptPreview(null);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('fileTooLarge'));
      return;
    }
    const validTypes = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!validTypes.some((type) => file.type.startsWith(type))) {
      toast.error(t('receiptNote'));
      return;
    }
    setReceiptFile(file);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => setReceiptPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setReceiptPreview(null);
    }
  }, [t]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleRemoveFile = () => {
    setReceiptFile(null);
    setReceiptPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmitPayment = async () => {
    if (!selectedPlan) return;
    if (!receiptFile) {
      toast.error(t('uploadReceipt'));
      return;
    }
    setSubmitting(true);
    try {
      const uploadResult = await receiptUpload.upload(receiptFile, {
        agencyId: user?.agencyId || '',
      });
      if (!uploadResult.url) {
        toast.error(uploadResult.error || t('error'));
        return;
      }
      const receiptUrl = uploadResult.url;
      const payForm = new FormData();
      // Send the plan NAME (e.g. 'BASIC' / 'PREMIUM' / 'FREE') — backend looks
      // it up against SubscriptionPlan.name in the DB to compute the real price.
      payForm.append('plan', selectedPlan.name);
      payForm.append('method', paymentMethod);
      payForm.append('receiptUrl', receiptUrl);
      if (user?.agencyId) payForm.append('agencyId', user.agencyId);
      // Include the billing period so the backend can apply the plan's
      // period discount and compute the discounted total.
      payForm.append('period', String(period));

      const res = await apiFetch('/api/agency/subscription/pay', {
        method: 'POST',
        body: payForm,
      });

      if (res.ok) {
        // Best-effort: also place a hardware order if the user selected any
        // items in the optional hardware picker. Never blocks the success
        // path — if the hardware POST fails, the subscription still succeeded.
        if (hasHardware) {
          const items = (hardware?.products ?? [])
            .map((p) => ({ productId: p.id, quantity: hwQuantities[p.id] ?? 0 }))
            .filter((i) => i.quantity > 0);
          if (items.length > 0) {
            try {
              await apiFetch('/api/agency/hardware/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  items,
                  paymentModel: hwPaymentModel,
                  ...(hwPaymentModel === 'MONTHLY'
                    ? { commitmentMonths: hwCommitmentMonths }
                    : {}),
                }),
              });
            } catch {
              // Swallow — subscription already succeeded; hardware order can be retried from the catalog.
            }
          }
        }
        setShowSuccessAnimation(true);
        toast.success(t('submitPayment'));
        handleRemoveFile();
        receiptUpload.reset();
        // Auto close after success animation
        setTimeout(() => {
          setShowSuccessAnimation(false);
          onOpenChange(false);
          onSuccess();
        }, 3000);
      } else {
        const d = await res.json();
        toast.error(d.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  const canGoNext = () => {
    if (paymentStep === 1) return !!paymentMethod;
    if (paymentStep === 2) return !!receiptFile;
    return true;
  };

  const handleNext = () => {
    if (paymentStep < 3 && canGoNext()) {
      setPaymentStep(paymentStep + 1);
    } else if (paymentStep === 3) {
      handleSubmitPayment();
    }
  };

  const handleBack = () => {
    if (paymentStep > 1) setPaymentStep(paymentStep - 1);
  };

  // Plan info for header
  const accent = selectedPlan ? getPlanAccent(selectedPlan) : null;
  const PlanIcon = accent?.icon ?? Building2;

  // Live price for the currently selected period — includes the period
  // discount when the agency picked an extended billing cycle (3/6/12/24m).
  const totalPrice = selectedPlan ? getTotalForPeriod(selectedPlan, period) : 0;
  const monthlyEquivalent = selectedPlan && period > 0
    ? Math.round(totalPrice / period)
    : 0;
  const savingsAmount = selectedPlan
    ? (selectedPlan.price * period) - totalPrice
    : 0;
  const currentDiscount = selectedPlan ? getDiscountForPeriod(selectedPlan, period) : 0;

  const priceLabel = selectedPlan
    ? `${totalPrice.toLocaleString()} ${selectedPlan.currency}`
    : '';
  // Cycle label reflects the chosen billing period (e.g. "3 Months" instead of
  // the plan's static billingCycle when an extended period is selected).
  const cycleLabel = selectedPlan
    ? period > 1
      ? getPeriodLabel(period, lang)
      : getBillingCycleLabel(selectedPlan.billingCycle, lang)
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden" showCloseButton={!submitting}>
        {/* ─── Dialog Header with Plan Info ─── */}
        <div className="relative overflow-hidden bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-500 p-5 text-white">
          <div className="absolute -top-6 -right-6 h-24 w-24 rounded-full bg-white/10" />
          <div className="absolute bottom-2 -left-4 h-16 w-16 rounded-full bg-white/5" />

          {!showSuccessAnimation ? (
            <div className="relative z-10">
              <DialogHeader>
                <DialogTitle className="text-white flex items-center gap-2 text-lg">
                  <CreditCard className="h-5 w-5" />
                  {t('paymentDialogTitle')}
                </DialogTitle>
                <DialogDescription className="text-emerald-100 text-sm">
                  {t('paymentDialogDesc')}
                </DialogDescription>
              </DialogHeader>
              {/* Selected plan badge */}
              <div className="mt-3 flex items-center gap-3 bg-white/15 backdrop-blur-sm rounded-xl p-3">
                <div className="h-10 w-10 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
                  <PlanIcon className="h-5 w-5 text-white" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">{getLocalizedPlanName(selectedPlan)}</p>
                  <p className="text-xs text-emerald-100">
                    {selectedPlan ? selectedPlan.name : ''}
                    {selectedPlan && selectedPlan.billingCycle ? ` · ${selectedPlan.billingCycle}` : ''}
                  </p>
                </div>
                <div className="text-end">
                  <p className="text-xl font-extrabold text-white">{priceLabel}</p>
                  <p className="text-[10px] text-emerald-100">{cycleLabel}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="relative z-10 flex flex-col items-center py-4">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', bounce: 0.5, duration: 0.8 }}
                className="h-16 w-16 rounded-full bg-white/20 flex items-center justify-center mb-3"
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.3, type: 'spring', bounce: 0.5 }}
                >
                  <Check className="h-8 w-8 text-white" strokeWidth={3} />
                </motion.div>
              </motion.div>
              <motion.h3
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="text-lg font-bold text-white mb-1"
              >
                {t('success')}!
              </motion.h3>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
                className="text-sm text-emerald-100 text-center"
              >
                {t('paymentReviewInfo')}
              </motion.p>
            </div>
          )}
        </div>

        {/* ─── Step Indicator ─── */}
        {!showSuccessAnimation && (
          <div className="px-5 pt-4 pb-2">
            <div className="flex items-center gap-2">
              {dialogSteps.map((item, idx) => {
                const StepIcon = item.icon;
                const isActive = paymentStep >= item.step;
                const isCurrent = paymentStep === item.step;
                const isCompleted = paymentStep > item.step;
                return (
                  <div key={item.step} className="flex items-center flex-1">
                    <div className="flex items-center gap-2 flex-1">
                      <motion.div
                        animate={isCurrent ? { scale: [1, 1.05, 1] } : {}}
                        transition={{ duration: 0.3 , ease: 'easeInOut' }}
                        className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-300 ${
                          isActive
                            ? 'bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/20'
                            : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground'
                        }`}
                      >
                        {isCompleted ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <StepIcon className="h-3.5 w-3.5" />
                        )}
                      </motion.div>
                      <span className={`text-[11px] font-medium transition-colors duration-300 hidden sm:block ${
                        isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                      }`}>
                        {item.label}
                      </span>
                    </div>
                    {idx < dialogSteps.length - 1 && (
                      <div className="relative h-0.5 flex-1 mx-1 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: isCompleted ? '100%' : isCurrent ? '50%' : '0%' }}
                          transition={{ duration: 0.4 }}
                          className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Step Content ─── */}
        {!showSuccessAnimation && (
          <div className="px-5 py-4 min-h-[320px]">
            <AnimatePresence mode="wait">
              {/* Step 1: Payment Method */}
              {paymentStep === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  {/* Billing-period selector — shown only when the plan has at
                      least one extended-period discount configured. The default
                      "Monthly" option is always available. */}
                  {selectedPlan && availablePeriods.length > 1 && (
                    <div className="space-y-2">
                      <Label className="text-sm font-semibold flex items-center gap-2">
                        <Clock className="h-4 w-4 text-emerald-600" />
                        {t('billingPeriod')}
                      </Label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {availablePeriods.map((p) => {
                          const discount = getDiscountForPeriod(selectedPlan, p);
                          const total = getTotalForPeriod(selectedPlan, p);
                          const isSel = period === p;
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setPeriod(p)}
                              className={`relative text-start rounded-xl border-2 p-2.5 transition-all ${
                                isSel
                                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-sm'
                                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50 hover:border-emerald-300'
                              }`}
                            >
                              {isSel && (
                                <span className="absolute top-1.5 end-1.5 h-4 w-4 rounded-full bg-emerald-500 flex items-center justify-center">
                                  <Check className="h-2.5 w-2.5 text-white" />
                                </span>
                              )}
                              <p className="text-xs font-semibold text-foreground">
                                {p === 1 ? t('monthly') : getPeriodLabel(p, lang)}
                              </p>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {total.toLocaleString()} {selectedPlan.currency}
                              </p>
                              {discount > 0 && (
                                <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mt-0.5">
                                  {t('savings')} {discount}%
                                </p>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      {period > 1 && savingsAmount > 0 && (
                        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40">
                          <Sparkles className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                          <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                            {t('savings')} {savingsAmount.toLocaleString()} {selectedPlan.currency}
                            {' · '}
                            {lang === 'ar' ? 'ما يعادل' : lang === 'fr' ? 'équivalent' : 'equiv.'}
                            {' '}
                            {Math.round(monthlyEquivalent).toLocaleString()} {selectedPlan.currency}
                            {t('perMonth')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-3">
                    <Label className="text-sm font-semibold flex items-center gap-2">
                      <CreditCard className="h-4 w-4 text-emerald-600" />
                      {lang === 'ar' ? 'اختر طريقة الدفع' : lang === 'fr' ? 'Choisir la méthode de paiement' : 'Choose Payment Method'}
                    </Label>
                    <div className="space-y-2.5">
                      {paymentMethods.map((method) => {
                        const MethodIcon = method.icon;
                        const isSelected = paymentMethod === method.id;
                        const isExpanded = expandedInstructions === method.id;

                        return (
                          <div key={method.id} className="space-y-1.5">
                            <motion.div
                              whileHover={{ scale: 1.01 }}
                              whileTap={{ scale: 0.99 }}
                              onClick={() => setPaymentMethod(method.id)}
                              className={`relative cursor-pointer rounded-xl border-2 p-3.5 transition-all duration-300 ${
                                isSelected
                                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-md'
                                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50 hover:border-emerald-300 dark:hover:border-emerald-700'
                              }`}
                            >
                              {isSelected && (
                                <motion.div
                                  initial={{ scale: 0 }}
                                  animate={{ scale: 1 }}
                                  className="absolute top-2 end-2 h-5 w-5 rounded-full bg-emerald-500 flex items-center justify-center"
                                >
                                  <Check className="h-3 w-3 text-white" />
                                </motion.div>
                              )}
                              <div className="flex items-center gap-3">
                                <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                                  isSelected
                                    ? 'bg-emerald-500 text-white'
                                    : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                                }`}>
                                  <MethodIcon className="h-5 w-5" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-foreground">{method.label}</p>
                                  <p className="text-[11px] text-muted-foreground mt-0.5">{method.description}</p>
                                </div>
                              </div>
                            </motion.div>

                            {/* Expand/Collapse instructions */}
                            <button
                              type="button"
                              onClick={() => setExpandedInstructions(isExpanded ? null : method.id)}
                              className={`w-full text-xs flex items-center justify-center gap-1 py-1 rounded-lg transition-colors ${
                                isSelected
                                  ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                                  : 'text-muted-foreground hover:text-foreground hover:bg-gray-50 dark:hover:bg-gray-800/30'
                              }`}
                            >
                              {t('paymentInstructions')}
                              <motion.span animate={{ rotate: isExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                                <ChevronDown className="h-3 w-3" />
                              </motion.span>
                            </button>

                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                                    <div className="flex items-start gap-2 mb-2">
                                      <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                                      <div>
                                        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">{t('paymentInstructions')}</p>
                                        <p className="text-[11px] text-amber-600 dark:text-amber-300 mt-0.5">{t('paymentInstructionsDesc')}</p>
                                      </div>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground leading-relaxed">{method.instructions}</p>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Step 2: Receipt Upload */}
              {paymentStep === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <Label className="text-sm font-semibold flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-emerald-600" />
                    {t('uploadReceipt')}
                  </Label>

                  {receiptFile && receiptPreview ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="relative rounded-xl border border-border overflow-hidden"
                    >
                      <img
                        src={receiptPreview}
                        alt="Receipt preview"
                        className="max-h-48 w-full object-contain bg-gray-50 dark:bg-gray-900"
                      />
                      <button
                        onClick={handleRemoveFile}
                        className="absolute top-2 end-2 h-7 w-7 rounded-full bg-black/50 hover:bg-black/70 text-white flex items-center justify-center transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </motion.div>
                  ) : receiptFile ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="flex items-center gap-3 p-4 rounded-xl border border-border bg-gray-50 dark:bg-gray-900"
                    >
                      <div className="h-10 w-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                        {receiptFile.type === 'application/pdf' ? (
                          <FileText className="h-5 w-5 text-red-500" />
                        ) : (
                          <ImageIcon className="h-5 w-5 text-emerald-600" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{receiptFile.name}</p>
                        <p className="text-xs text-muted-foreground">{getFileSize()}</p>
                      </div>
                      <button
                        onClick={handleRemoveFile}
                        className="h-7 w-7 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 flex items-center justify-center transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </motion.div>
                  ) : (
                    <div
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      className={`relative rounded-xl border-2 border-dashed transition-all duration-300 ${
                        isDragOver
                          ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 scale-[1.01]'
                          : 'border-gray-300 dark:border-gray-700 hover:border-emerald-400 dark:hover:border-emerald-600 hover:bg-emerald-50/30 dark:hover:bg-emerald-900/10'
                      }`}
                    >
                      <label className="flex flex-col items-center justify-center gap-3 p-8 cursor-pointer">
                        <motion.div
                          animate={isDragOver ? { scale: 1.1, rotate: 5 } : { scale: 1, rotate: 0 }}
                          className={`h-14 w-14 rounded-2xl flex items-center justify-center transition-colors ${
                            isDragOver
                              ? 'bg-emerald-200 dark:bg-emerald-800/50'
                              : 'bg-emerald-100 dark:bg-emerald-900/30'
                          }`}
                        >
                          <Upload className={`h-7 w-7 transition-colors ${
                            isDragOver ? 'text-emerald-700 dark:text-emerald-300' : 'text-emerald-600 dark:text-emerald-400'
                          }`} />
                        </motion.div>
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">
                            {isDragOver
                              ? (lang === 'ar' ? 'أفلت الملف هنا' : lang === 'fr' ? 'Déposez le fichier ici' : 'Drop file here')
                              : t('uploadReceipt')
                            }
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">{t('receiptNote')}</p>
                          <div className="flex items-center justify-center gap-3 mt-2">
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <ImageIcon className="h-3 w-3" /> JPG, PNG
                            </span>
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <FileText className="h-3 w-3" /> PDF
                            </span>
                          </div>
                        </div>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".jpg,.jpeg,.png,.pdf"
                          onChange={handleFileChange}
                          className="hidden"
                        />
                      </label>
                    </div>
                  )}

                  {/* Upload Progress */}
                  {receiptUpload.uploading && (
                    <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">
                          {lang === 'ar' ? 'جاري الرفع...' : lang === 'fr' ? 'Téléchargement...' : 'Uploading...'}
                        </span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">{receiptUpload.progress}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${receiptUpload.progress}%` }}
                          className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                          transition={{ duration: 0.3 }}
                        />
                      </div>
                    </motion.div>
                  )}

                  {/* Receipt Upload Success Indicator */}
                  {receiptFile && !receiptUpload.uploading && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800"
                    >
                      <div className="h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-800/40 flex items-center justify-center flex-shrink-0">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{t('receiptUploadedSuccess')}</p>
                        <p className="text-xs text-muted-foreground truncate">{receiptFile.name} &middot; {getFileSize()}</p>
                      </div>
                    </motion.div>
                  )}

                  {/* Info box */}
                  <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                    <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                      {t('receiptNote')}
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Step 3: Review & Submit */}
              {paymentStep === 3 && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.2 }}
                  className="space-y-4"
                >
                  <div className="space-y-2.5">
                    {/* Order Summary Card */}
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-gradient-to-b from-emerald-50/50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10 p-4">
                      <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
                        <ClipboardCheck className="h-4 w-4 text-emerald-600" />
                        {lang === 'ar' ? 'ملخص الطلب' : lang === 'fr' ? 'Résumé de la commande' : 'Order Summary'}
                      </h4>
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">{t('selectPlan')}</span>
                          <span className="text-sm font-medium text-foreground">{getLocalizedPlanName(selectedPlan)}</span>
                        </div>
                        {/* Billing period — only shown when an extended period
                            (3/6/12/24 months) is selected. */}
                        {period > 1 && selectedPlan && (
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">{t('billingPeriod')}</span>
                            <span className="text-sm font-medium text-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3 text-emerald-600" />
                              {getPeriodLabel(period, lang)}
                              {currentDiscount > 0 && (
                                <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                                  ({t('savings')} {currentDiscount}%)
                                </span>
                              )}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">
                            {lang === 'ar' ? 'طريقة الدفع' : lang === 'fr' ? 'Mode de paiement' : 'Payment Method'}
                          </span>
                          <span className="text-sm font-medium text-foreground">{getPaymentMethodLabel(paymentMethod)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">{t('uploadReceipt')}</span>
                          <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {t('receiptUploadedSuccess')}
                          </span>
                        </div>
                        {/* Savings breakdown — show base price × period crossed out
                            and the discounted total when an extended period applies. */}
                        {period > 1 && selectedPlan && savingsAmount > 0 && (
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">{t('totalAmount')}</span>
                            <span className="text-xs text-muted-foreground line-through">
                              {(selectedPlan.price * period).toLocaleString()} {selectedPlan.currency}
                            </span>
                          </div>
                        )}
                        <Separator className="bg-emerald-200/50 dark:bg-emerald-800/30" />
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-foreground">
                            {lang === 'ar' ? 'المجموع' : 'Total'}
                          </span>
                          <span className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400">
                            {priceLabel}
                            <span className="text-[11px] text-muted-foreground font-medium ms-1">{cycleLabel}</span>
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Optional hardware picker — only when hardwareEnabled */}
                    {hasHardware && (
                      <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-800/40 bg-white dark:bg-gray-900/40 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setHwExpanded((v) => !v)}
                          className="w-full flex items-center justify-between gap-3 p-3.5 text-start hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                              <Monitor className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-foreground truncate">
                                {t('orderHardware')}
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {t('hardwareCatalogDesc')}
                              </p>
                            </div>
                          </div>
                          <motion.span animate={{ rotate: hwExpanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          </motion.span>
                        </button>
                        <AnimatePresence>
                          {hwExpanded && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden border-t border-emerald-100 dark:border-emerald-900/30"
                            >
                              <div className="p-3.5 space-y-3">
                                {/* Compact product grid */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {hardware!.products.map((p) => {
                                    const qty = hwQuantities[p.id] ?? 0;
                                    const prodName =
                                      lang === 'ar' && p.nameAr ? p.nameAr
                                      : lang === 'fr' && p.nameFr ? p.nameFr
                                      : p.name;
                                    return (
                                      <div
                                        key={p.id}
                                        className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-gray-50 dark:bg-gray-900/40 p-2.5"
                                      >
                                        <div className="min-w-0">
                                          <p className="text-xs font-semibold text-foreground truncate">{prodName}</p>
                                          <p className="text-[10px] text-muted-foreground">{p.basePrice.toLocaleString()} DZD</p>
                                        </div>
                                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                          <Button
                                            type="button"
                                            size="icon"
                                            variant="outline"
                                            className="h-6 w-6"
                                            onClick={() =>
                                              setHwQuantities((prev) => ({
                                                ...prev,
                                                [p.id]: Math.max(0, (prev[p.id] ?? 0) - 1),
                                              }))
                                            }
                                            disabled={qty === 0}
                                          >
                                            <ChevronDown className="h-3 w-3" />
                                          </Button>
                                          <span className="text-xs font-semibold w-5 text-center">{qty}</span>
                                          <Button
                                            type="button"
                                            size="icon"
                                            variant="outline"
                                            className="h-6 w-6"
                                            onClick={() =>
                                              setHwQuantities((prev) => ({
                                                ...prev,
                                                [p.id]: (prev[p.id] ?? 0) + 1,
                                              }))
                                            }
                                          >
                                            <ChevronUp className="h-3 w-3" />
                                          </Button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                {/* Payment model toggle */}
                                <div className="grid grid-cols-2 gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setHwPaymentModel('UPFRONT')}
                                    className={`rounded-lg border-2 p-2.5 text-start transition-all ${
                                      hwPaymentModel === 'UPFRONT'
                                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                                        : 'border-border hover:border-emerald-300'
                                    }`}
                                  >
                                    <p className="text-xs font-semibold">{t('payUpfront')}</p>
                                    <p className="text-[10px] text-muted-foreground line-clamp-1">{t('payUpfrontDesc')}</p>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setHwPaymentModel('MONTHLY')}
                                    className={`rounded-lg border-2 p-2.5 text-start transition-all ${
                                      hwPaymentModel === 'MONTHLY'
                                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                                        : 'border-border hover:border-emerald-300'
                                    }`}
                                  >
                                    <p className="text-xs font-semibold">{t('payMonthly')}</p>
                                    <p className="text-[10px] text-muted-foreground line-clamp-1">{t('payMonthlyDesc')}</p>
                                  </button>
                                </div>

                                {/* Commitment period for monthly */}
                                {hwPaymentModel === 'MONTHLY' && (
                                  <div className="space-y-1.5">
                                    <Label className="text-[11px] text-muted-foreground">{t('commitmentPeriod')}</Label>
                                    <Select
                                      value={String(hwCommitmentMonths)}
                                      onValueChange={(v) => setHwCommitmentMonths(Number(v))}
                                    >
                                      <SelectTrigger className="w-full h-8 text-xs">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {hardware!.commitmentTiers.map((tier) => (
                                          <SelectItem key={tier.id} value={String(tier.months)}>
                                            {tier.months} {t('months')} (+{tier.extraPercentage}%)
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  </div>
                                )}

                                {/* Live totals */}
                                {(() => {
                                  const totalBase = hardware!.products.reduce(
                                    (sum, p) => sum + p.basePrice * (hwQuantities[p.id] ?? 0),
                                    0,
                                  );
                                  const upfrontDiscount = hardware!.settings.upfrontDiscount ?? 0;
                                  const upfrontTotal = Math.round(totalBase * (1 - upfrontDiscount / 100));
                                  const tier = hardware!.commitmentTiers.find((tt) => tt.months === hwCommitmentMonths);
                                  const extraPct = tier?.extraPercentage ?? 0;
                                  const monthlyExtra =
                                    hwCommitmentMonths > 0
                                      ? Math.round((totalBase * (1 + extraPct / 100)) / hwCommitmentMonths)
                                      : 0;
                                  if (totalBase === 0) {
                                    return (
                                      <p className="text-[11px] text-muted-foreground text-center py-1">
                                        {t('noHardwareSelected')}
                                      </p>
                                    );
                                  }
                                  return (
                                    <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 p-2.5 space-y-1">
                                      <div className="flex justify-between text-[11px]">
                                        <span className="text-muted-foreground">{t('totalBasePrice')}</span>
                                        <span className="font-medium">{totalBase.toLocaleString()} DZD</span>
                                      </div>
                                      {hwPaymentModel === 'UPFRONT' ? (
                                        <div className="flex justify-between text-xs">
                                          <span className="font-semibold">{t('totalPrice')}</span>
                                          <span className="font-extrabold text-emerald-600 dark:text-emerald-400">
                                            {upfrontTotal.toLocaleString()} DZD
                                          </span>
                                        </div>
                                      ) : (
                                        <div className="flex justify-between text-xs">
                                          <span className="font-semibold">{t('monthlyExtra')}</span>
                                          <span className="font-extrabold text-emerald-600 dark:text-emerald-400">
                                            {monthlyExtra.toLocaleString()} DZD {t('perMonth')}
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    )}

                    {/* Payment review info */}
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                      <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                        {t('paymentReviewInfo')}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ─── Dialog Footer with Navigation ─── */}
        {!showSuccessAnimation && (
          <DialogFooter className="px-5 pb-5 pt-2 gap-2 sm:gap-0 border-t border-border/50">
            <div className="flex items-center gap-2 w-full">
              {paymentStep > 1 && (
                <Button
                  variant="outline"
                  onClick={handleBack}
                  disabled={submitting}
                  className="flex-1 sm:flex-none"
                >
                  <ChevronLeft className={`h-4 w-4 ${lang === 'ar' ? 'rotate-180' : ''} me-1`} />
                  {t('back')}
                </Button>
              )}
              <Button
                className={`bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold ${
                  paymentStep === 1 ? 'w-full' : 'flex-1'
                }`}
                onClick={handleNext}
                disabled={submitting || !canGoNext()}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin me-2" />
                ) : paymentStep === 3 ? (
                  <Check className="h-4 w-4 me-2" />
                ) : (
                  <ChevronRight className={`h-4 w-4 ${lang === 'ar' ? 'rotate-180' : ''} me-1`} />
                )}
                {paymentStep === 3 ? t('confirm') : t('next')}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Hardware Catalog Sub-component ─────────────────────────────────────────
// Standalone hardware ordering section shown on the subscription page (both
// for active and inactive subscribers). Manages its own quantity / payment
// model / commitment state and POSTs to /api/agency/hardware/orders on submit.
function HardwareCatalog({
  products,
  commitmentTiers,
  settings,
  onOrderPlaced,
}: {
  products: HardwareProduct[];
  commitmentTiers: CommitmentTier[];
  settings: HardwareSettings;
  onOrderPlaced?: () => void;
}) {
  const { t, lang } = useLanguage();
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [paymentModel, setPaymentModel] = useState<'UPFRONT' | 'MONTHLY'>('UPFRONT');
  const [commitmentMonths, setCommitmentMonths] = useState<number>(
    commitmentTiers[0]?.months ?? 12,
  );
  const [submitting, setSubmitting] = useState(false);

  const totalBase = useMemo(
    () => products.reduce((sum, p) => sum + p.basePrice * (quantities[p.id] ?? 0), 0),
    [products, quantities],
  );

  const upfrontDiscount = settings.upfrontDiscount ?? 0;
  const upfrontTotal = Math.round(totalBase * (1 - upfrontDiscount / 100));
  const selectedTier = commitmentTiers.find((tier) => tier.months === commitmentMonths);
  const extraPercentage = selectedTier?.extraPercentage ?? 0;
  const monthlyExtra =
    commitmentMonths > 0
      ? Math.round((totalBase * (1 + extraPercentage / 100)) / commitmentMonths)
      : 0;
  const monthlyGrandTotal = Math.round(totalBase * (1 + extraPercentage / 100));

  const getProductName = (p: HardwareProduct) => {
    if (lang === 'ar' && p.nameAr) return p.nameAr;
    if (lang === 'fr' && p.nameFr) return p.nameFr;
    return p.name;
  };

  const categoryIcon = (category: string): typeof Monitor => {
    switch (category.toUpperCase()) {
      case 'TV':
        return Monitor;
      case 'PC':
        return Monitor;
      case 'KIOSK':
        return Tablet;
      case 'PRINTER':
        return Printer;
      default:
        return Cpu;
    }
  };

  const handleSubmit = async () => {
    const items = products
      .filter((p) => (quantities[p.id] ?? 0) > 0)
      .map((p) => ({ productId: p.id, quantity: quantities[p.id] }));
    if (items.length === 0) {
      toast.error(t('noHardwareSelected'));
      return;
    }
    if (paymentModel === 'MONTHLY' && !commitmentMonths) {
      toast.error(t('selectCommitmentTier'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/agency/hardware/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          paymentModel,
          ...(paymentModel === 'MONTHLY' ? { commitmentMonths } : {}),
        }),
      });
      if (res.ok) {
        toast.success(t('hardwareOrderPlaced'));
        setQuantities({});
        onOrderPlaced?.();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Products grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {products.map((p) => {
          const Icon = categoryIcon(p.category);
          const qty = quantities[p.id] ?? 0;
          return (
            <div
              key={p.id}
              className="rounded-xl border border-border/60 bg-white dark:bg-gray-900/40 p-4 transition-all hover:shadow-sm"
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="h-10 w-10 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                  <Icon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">{getProductName(p)}</p>
                  <p className="text-[11px] text-muted-foreground">{p.category}</p>
                </div>
                <Badge variant="outline" className="text-[10px] flex-shrink-0">
                  {p.basePrice.toLocaleString()} DZD
                </Badge>
              </div>
              {/* Quantity selector */}
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">{t('quantity')}</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    onClick={() =>
                      setQuantities((prev) => ({
                        ...prev,
                        [p.id]: Math.max(0, (prev[p.id] ?? 0) - 1),
                      }))
                    }
                    disabled={qty === 0}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-sm font-semibold w-6 text-center">{qty}</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    onClick={() =>
                      setQuantities((prev) => ({
                        ...prev,
                        [p.id]: (prev[p.id] ?? 0) + 1,
                      }))
                    }
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Payment model + commitment + totals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Payment model + commitment */}
        <div className="rounded-xl border border-border/60 bg-white dark:bg-gray-900/40 p-4 space-y-3">
          <Label className="text-sm font-semibold flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-emerald-600" />
            {lang === 'ar' ? 'نموذج الدفع' : lang === 'fr' ? 'Modèle de paiement' : 'Payment Model'}
          </Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPaymentModel('UPFRONT')}
              className={`rounded-xl border-2 p-3 text-start transition-all ${
                paymentModel === 'UPFRONT'
                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                  : 'border-border hover:border-emerald-300'
              }`}
            >
              <p className="text-sm font-semibold">{t('payUpfront')}</p>
              <p className="text-[11px] text-muted-foreground line-clamp-2">{t('payUpfrontDesc')}</p>
              {upfrontDiscount > 0 && (
                <Badge className="mt-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 text-[10px]">
                  -{upfrontDiscount}% {t('discountApplied')}
                </Badge>
              )}
            </button>
            <button
              type="button"
              onClick={() => setPaymentModel('MONTHLY')}
              className={`rounded-xl border-2 p-3 text-start transition-all ${
                paymentModel === 'MONTHLY'
                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20'
                  : 'border-border hover:border-emerald-300'
              }`}
            >
              <p className="text-sm font-semibold">{t('payMonthly')}</p>
              <p className="text-[11px] text-muted-foreground line-clamp-2">{t('payMonthlyDesc')}</p>
            </button>
          </div>
          {paymentModel === 'MONTHLY' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t('commitmentPeriod')}</Label>
              <Select
                value={String(commitmentMonths)}
                onValueChange={(v) => setCommitmentMonths(Number(v))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {commitmentTiers.map((tier) => (
                    <SelectItem key={tier.id} value={String(tier.months)}>
                      {tier.months} {t('months')} (+{tier.extraPercentage}%)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Totals + Place Order */}
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-gradient-to-b from-emerald-50/50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10 p-4 flex flex-col">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
            <ClipboardCheck className="h-4 w-4 text-emerald-600" />
            {t('totalPrice')}
          </h4>
          <div className="space-y-2 text-sm flex-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('totalBasePrice')}</span>
              <span className="font-medium">{totalBase.toLocaleString()} DZD</span>
            </div>
            {paymentModel === 'UPFRONT' ? (
              <>
                {upfrontDiscount > 0 && (
                  <div className="flex justify-between text-emerald-600 dark:text-emerald-400">
                    <span>{t('upfrontDiscount')}</span>
                    <span>-{Math.round((totalBase * upfrontDiscount) / 100).toLocaleString()} DZD</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between">
                  <span className="font-semibold">{t('totalPrice')}</span>
                  <span className="font-extrabold text-emerald-600 dark:text-emerald-400">
                    {upfrontTotal.toLocaleString()} DZD
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t('extraPercentage')}</span>
                  <span>+{extraPercentage}%</span>
                </div>
                <Separator />
                <div className="flex justify-between">
                  <span className="font-semibold">{t('monthlyExtra')}</span>
                  <span className="font-extrabold text-emerald-600 dark:text-emerald-400">
                    {monthlyExtra.toLocaleString()} DZD {t('perMonth')}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {commitmentMonths} {t('months')} · {t('totalPrice')}: {monthlyGrandTotal.toLocaleString()} DZD
                </p>
              </>
            )}
          </div>
          <Button
            type="button"
            className="w-full mt-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold"
            onClick={handleSubmit}
            disabled={submitting || totalBase === 0}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin me-2" />
            ) : (
              <ShoppingCart className="h-4 w-4 me-2" />
            )}
            {t('placeOrder')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Enterprise Request Dialog Sub-component ────────────────────────────────
function EnterpriseRequestDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const { t } = useLanguage();
  const [message, setMessage] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [branchesNeeded, setBranchesNeeded] = useState(1);
  const [countersNeeded, setCountersNeeded] = useState(1);
  const [hardwareNeeded, setHardwareNeeded] = useState(true);
  const [requestedFeatures, setRequestedFeatures] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the dialog opens
  useEffect(() => {
    if (open) {
      setMessage('');
      setContactEmail('');
      setContactPhone('');
      setBranchesNeeded(1);
      setCountersNeeded(1);
      setHardwareNeeded(true);
      setRequestedFeatures([]);
    }
  }, [open]);

  const featureOptions = [
    { key: 'kiosk', label: t('featureKiosk') },
    { key: 'analytics', label: t('featureAnalytics') },
    { key: 'priority', label: t('featurePriority') },
    { key: 'branding', label: t('featureBranding') },
    { key: 'api', label: t('featureApi') },
  ];

  const toggleFeature = (key: string) => {
    setRequestedFeatures((prev) =>
      prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key],
    );
  };

  const handleSubmit = async () => {
    if (!message.trim()) {
      toast.error(t('enterpriseMessage'));
      return;
    }
    if (!contactEmail.trim()) {
      toast.error(t('contactEmailLabel'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/agency/enterprise-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim(),
          contactEmail: contactEmail.trim(),
          contactPhone: contactPhone.trim() || undefined,
          branchesNeeded,
          countersNeeded,
          hardwareNeeded,
          requestedFeatures,
        }),
      });
      if (res.ok) {
        toast.success(t('enterpriseRequestSubmitted'));
        onOpenChange(false);
        onSuccess();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <div className="relative overflow-hidden bg-gradient-to-br from-purple-600 via-fuchsia-600 to-pink-500 p-5 text-white">
          <div className="absolute -top-6 -right-6 h-24 w-24 rounded-full bg-white/10" />
          <div className="absolute bottom-2 -left-4 h-16 w-16 rounded-full bg-white/5" />
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2 text-lg">
              <Sparkles className="h-5 w-5" />
              {t('requestEnterprise')}
            </DialogTitle>
            <DialogDescription className="text-purple-100 text-sm">
              {t('enterprisePlanDesc')}
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Message */}
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-purple-600" />
              {t('enterpriseMessage')} <span className="text-red-500">*</span>
            </Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('enterpriseMessagePlaceholder')}
              rows={4}
              maxLength={2000}
              className="resize-none"
            />
            <p className="text-[10px] text-muted-foreground text-end">{message.length}/2000</p>
          </div>

          {/* Contact email */}
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold flex items-center gap-2" htmlFor="ent-email">
              <Mail className="h-4 w-4 text-purple-600" />
              {t('contactEmailLabel')} <span className="text-red-500">*</span>
            </Label>
            <Input
              id="ent-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="you@agency.com"
            />
          </div>

          {/* Contact phone */}
          <div className="space-y-1.5">
            <Label className="text-sm font-semibold flex items-center gap-2" htmlFor="ent-phone">
              <Phone className="h-4 w-4 text-purple-600" />
              {t('contactPhoneLabel')}
            </Label>
            <Input
              id="ent-phone"
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+213 ..."
            />
          </div>

          {/* Branches + counters */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5" htmlFor="ent-branches">
                <Building className="h-3.5 w-3.5" />
                {t('branchesNeeded')}
              </Label>
              <Input
                id="ent-branches"
                type="number"
                min={1}
                max={1000}
                value={branchesNeeded}
                onChange={(e) => setBranchesNeeded(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5" htmlFor="ent-counters">
                <Hash className="h-3.5 w-3.5" />
                {t('countersNeeded')}
              </Label>
              <Input
                id="ent-counters"
                type="number"
                min={1}
                max={1000}
                value={countersNeeded}
                onChange={(e) => setCountersNeeded(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          </div>

          {/* Hardware needed */}
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-gray-50 dark:bg-gray-900/40 p-3">
            <Checkbox
              id="ent-hardware"
              checked={hardwareNeeded}
              onCheckedChange={(v) => setHardwareNeeded(v === true)}
            />
            <Label htmlFor="ent-hardware" className="text-sm cursor-pointer flex-1">
              {t('hardwareNeededLabel')}
            </Label>
          </div>

          {/* Requested features */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">{t('requestedFeatures')}</Label>
            <div className="grid grid-cols-2 gap-2">
              {featureOptions.map((f) => {
                const checked = requestedFeatures.includes(f.key);
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => toggleFeature(f.key)}
                    className={`flex items-center gap-2 rounded-lg border-2 p-2.5 text-start transition-all ${
                      checked
                        ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20'
                        : 'border-border hover:border-purple-300'
                    }`}
                  >
                    <Checkbox checked={checked} className="pointer-events-none" />
                    <span className="text-xs font-medium text-foreground">{f.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter className="px-5 pb-5 pt-2 gap-2 sm:gap-0 border-t border-border/50">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} className="flex-1 sm:flex-none">
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-700 hover:to-fuchsia-700 text-white font-semibold"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Send className="h-4 w-4 me-2" />}
            {t('submitRequest')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── FilterTab (small pill-style tab for the plans grid header) ───
// Replaces the previous "filter label + cancel filter X button" row.
// Clicking a tab sets the active filter; clicking the active tab again is
// a no-op (the "All Plans" tab acts as the cleared state).
function FilterTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
        active
          ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
          : 'bg-white dark:bg-gray-900/60 text-muted-foreground border-border hover:border-emerald-300 hover:text-emerald-700 dark:hover:text-emerald-400'
      }`}
    >
      {icon}
      <span className="truncate max-w-[160px]">{label}</span>
    </button>
  );
}

// ─── Main Subscription Component ───
export function AgencySubscription() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan | null>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);

  // ─── New state for the rewrite ────────────────────────────────────────────
  // `showPlansList` toggles the plans grid open when an ACTIVE subscriber
  // clicks Upgrade / Downgrade (or the "View Plans" affordance).
  const [showPlansList, setShowPlansList] = useState(false);
  // `plansFilter` controls which slice of the catalog is shown when the list
  // is open: 'upgrade' = higher sortOrder than current, 'downgrade' = lower.
  // `null` = show all (used when subscription is INACTIVE / EXPIRED).
  const [plansFilter, setPlansFilter] = useState<'upgrade' | 'downgrade' | null>(null);

  // Cancel-subscription confirmation dialog
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);

  // Hardware catalog (fetched from /api/agency/hardware)
  const [hardwareProducts, setHardwareProducts] = useState<HardwareProduct[]>([]);
  const [commitmentTiers, setCommitmentTiers] = useState<CommitmentTier[]>([]);
  const [hardwareSettings, setHardwareSettings] = useState<HardwareSettings>({
    hardwareEnabled: false,
    upfrontDiscount: 0,
  });
  const [hardwareOrders, setHardwareOrders] = useState<HardwareOrder[]>([]);

  // Enterprise plan requests
  const [enterpriseDialogOpen, setEnterpriseDialogOpen] = useState(false);
  const [enterpriseRequests, setEnterpriseRequests] = useState<EnterpriseRequest[]>([]);

  // Ref to the plan-cards grid so the "Renew Now" button can scroll the
  // user straight to the renewal options when their subscription is expired.
  const planCardsRef = useRef<HTMLDivElement>(null);

  const scrollToPlans = () => {
    planCardsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // FAQ expand state
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);
  const [faqs, setFaqs] = useState<FaqItem[]>([]);

  useEffect(() => {
    fetchSubscription();
    fetchFaqs();
    fetchHardware();
    fetchHardwareOrders();
    fetchEnterpriseRequests();
  }, []);

  const fetchFaqs = async () => {
    try {
      const res = await apiFetch(`/api/faqs?category=SUBSCRIPTION&lang=${lang}`);
      if (res.ok) {
        const data = await res.json();
        setFaqs(data.faqs || []);
      }
    } catch {
      // silently fail, FAQs are not critical
    }
  };

  const fetchSubscription = async () => {
    setLoading(true);
    try {
      const params = user?.agencyId ? `?agencyId=${user.agencyId}` : '';
      const res = await apiFetch(`/api/agency/subscription${params}`);
      if (res.ok) {
        const result = await res.json();
        setData(result);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  // ─── Hardware + Enterprise fetchers ────────────────────────────────────────
  const fetchHardware = async () => {
    try {
      const res = await apiFetch('/api/agency/hardware');
      if (res.ok) {
        const result = await res.json();
        setHardwareProducts(result.products ?? []);
        setCommitmentTiers(result.commitmentTiers ?? []);
        setHardwareSettings(
          result.settings ?? { hardwareEnabled: false, upfrontDiscount: 0 },
        );
      }
    } catch {
      // Hardware catalog is optional — silently fail.
    }
  };

  const fetchHardwareOrders = async () => {
    try {
      const res = await apiFetch('/api/agency/hardware/orders');
      if (res.ok) {
        const result = await res.json();
        setHardwareOrders(result.orders ?? []);
      }
    } catch {
      // silently fail
    }
  };

  const fetchEnterpriseRequests = async () => {
    try {
      const res = await apiFetch('/api/agency/enterprise-request');
      if (res.ok) {
        const result = await res.json();
        setEnterpriseRequests(result.requests ?? []);
      }
    } catch {
      // silently fail
    }
  };

  // Cancel subscription — POST /api/agency/subscription/cancel. Flips the
  // agency's status to INACTIVE and clears the start/expiry dates. After
  // success we refetch the subscription so the UI flips to the plans list.
  const handleCancelSubscription = async () => {
    setCancelLoading(true);
    try {
      const res = await apiFetch('/api/agency/subscription/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        // Use the enterprise-specific copy when the agency was on a bespoke
        // plan — the backend cancel endpoint works identically either way
        // (sets status INACTIVE, keeps the tier for billing history).
        toast.success(
          currentPlanObj?.isEnterprise
            ? t('enterprisePlanCancelled')
            : t('subscriptionCancelled'),
        );
        setCancelDialogOpen(false);
        setShowPlansList(true);
        setPlansFilter(null);
        await fetchSubscription();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCancelLoading(false);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';
      return new Date(dateStr).toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  // ─── Localization helpers ─────────────────────────────────────────────────
  // Pick the right display name/description based on the active language. Falls
  // back to the default English field, then to the plan `name`.

  const getLocalizedPlanName = (plan: SubscriptionPlan | null | undefined): string => {
    if (!plan) return '';
    if (lang === 'ar' && plan.displayNameAr) return plan.displayNameAr;
    if (lang === 'fr' && plan.displayNameFr) return plan.displayNameFr;
    return plan.displayName || plan.name;
  };

  const getLocalizedPlanDesc = (plan: SubscriptionPlan | null | undefined): string => {
    if (!plan) return '';
    if (lang === 'ar' && plan.descriptionAr) return plan.descriptionAr;
    if (lang === 'fr' && plan.descriptionFr) return plan.descriptionFr;
    return plan.description || '';
  };

  // Resolve a plan `name` (e.g. "PREMIUM") to its localized display name from
  // the fetched catalog. Falls back to the raw name if not found.
  const resolvePlanName = (planName: string | null | undefined): string => {
    if (!planName) return '';
    const match = data?.availablePlans?.find((p) => p.name === planName);
    if (match) return getLocalizedPlanName(match);
    return planName;
  };

  const getPaymentMethodLabel = (method: string) => {
    if (method === 'CCP') return t('ccpTransfer');
    if (method === 'BANK_TRANSFER' || method === 'BANK') return t('bankTransfer');
    return t('electronicPayment');
  };

  // ─── Feature badge config ─────────────────────────────────────────────────
  // Maps the 5 boolean feature flags on SubscriptionPlan to a localized label
  // + icon for display as a small badge on each plan card.

  const featureBadges = (plan: SubscriptionPlan) => {
    const items: { key: string; label: string; icon: typeof Building2; enabled: boolean }[] = [
      {
        key: 'kiosk',
        label: lang === 'ar' ? 'كشك' : lang === 'fr' ? 'Kiosque' : 'Kiosk',
        icon: Monitor,
        enabled: plan.kioskModeEnabled,
      },
      {
        key: 'analytics',
        label: lang === 'ar' ? 'تحليلات' : lang === 'fr' ? 'Analytics' : 'Analytics',
        icon: BarChart3,
        enabled: plan.analyticsEnabled,
      },
      {
        key: 'priority',
        label: lang === 'ar' ? 'أولوية' : lang === 'fr' ? 'Priorité' : 'Priority',
        icon: Flame,
        enabled: plan.priorityListing,
      },
      {
        key: 'branding',
        label: lang === 'ar' ? 'علامة' : lang === 'fr' ? 'Branding' : 'Branding',
        icon: Palette,
        enabled: plan.customBranding,
      },
      {
        key: 'api',
        label: lang === 'ar' ? 'API' : 'API',
        icon: Code2,
        enabled: plan.apiAccess,
      },
    ];
    return items;
  };

  // ─── Limit grid config ────────────────────────────────────────────────────
  const limitItems = (plan: SubscriptionPlan) => [
    { label: lang === 'ar' ? 'خدمات' : lang === 'fr' ? 'Services' : 'Services', value: plan.maxServices },
    { label: lang === 'ar' ? 'فروع' : lang === 'fr' ? 'Branches' : 'Branches', value: plan.maxBranches },
    { label: lang === 'ar' ? 'موظفين' : lang === 'fr' ? 'Personnel' : 'Staff', value: plan.maxStaff },
    { label: lang === 'ar' ? 'حجوزات نشطة' : lang === 'fr' ? 'Réservations' : 'Active Res.', value: plan.maxActiveReservations },
    { label: lang === 'ar' ? 'رسائل/شهر' : lang === 'fr' ? 'SMS/mois' : 'SMS/mo', value: plan.maxSmsPerMonth },
  ];

  const availablePlans = data?.availablePlans ?? [];

  // ─── Derived values for the new UX ────────────────────────────────────────
  // ACTIVE = status is ACTIVE AND the subscription is not flagged as expired
  // (the backend lazily flips the status to EXPIRED once the date passes, but
  // we double-check via `isExpired` to be defensive).
  const isActive = data?.status === 'ACTIVE' && !data?.isExpired;

  // The current plan object (matched by name) — used for upgrade/downgrade
  // comparisons via sortOrder. Falls back to `null` when the agency has no
  // active plan or the plan name isn't in the catalog. Enterprise plans owned
  // by this agency ARE included in `availablePlans` (the backend includes
  // them for the owner), so this lookup works for bespoke plans too.
  const currentPlanObj = useMemo(() => {
    if (!data?.currentPlan) return null;
    return availablePlans.find((p) => p.name === data.currentPlan) ?? null;
  }, [data?.currentPlan, availablePlans]);

  // Whether the agency's active subscription is an enterprise (bespoke) plan.
  const isCurrentEnterprise = !!currentPlanObj?.isEnterprise;

  // A "regular plan" = a public catalog plan that is NOT an enterprise plan.
  // The backend already excludes other agencies' enterprise plans, but we use
  // this helper to keep the upgrade/downgrade lists clean of bespoke plans.
  const isRegularPlan = (p: SubscriptionPlan) => !p.isEnterprise;

  // Upgrade targets:
  // - If current plan is enterprise: only regular plans with strictly higher
  //   sortOrder (enterprise plans usually have sortOrder 999, so this list is
  //   typically empty — the UI then shows the "no upgrades available" message).
  // - If current plan is regular: regular plans with strictly higher sortOrder
  //   (or strictly higher price when sortOrder ties); enterprise plans excluded.
  // - If no current plan (INACTIVE/EXPIRED): all regular plans.
  const upgradablePlans = useMemo(() => {
    if (!currentPlanObj) return availablePlans.filter(isRegularPlan);
    if (currentPlanObj.isEnterprise) {
      return availablePlans.filter(
        (p) =>
          isRegularPlan(p) &&
          p.name !== currentPlanObj.name &&
          p.sortOrder > currentPlanObj.sortOrder,
      );
    }
    return availablePlans.filter((p) => {
      if (!isRegularPlan(p)) return false;
      if (p.name === currentPlanObj.name) return false;
      if (p.sortOrder !== currentPlanObj.sortOrder) {
        return p.sortOrder > currentPlanObj.sortOrder;
      }
      return p.price > currentPlanObj.price;
    });
  }, [availablePlans, currentPlanObj]);

  // Downgrade targets:
  // - If current plan is enterprise: ALL regular public plans (excluding FREE)
  //   are valid downgrades — i.e. switching back to the standard catalog.
  // - If current plan is regular: regular plans with strictly lower sortOrder
  //   (or strictly lower price when sortOrder ties), excluding FREE and any
  //   enterprise plans.
  // - If no current plan: empty.
  const downgradablePlans = useMemo(() => {
    if (!currentPlanObj) return [];
    if (currentPlanObj.isEnterprise) {
      return availablePlans.filter(
        (p) =>
          isRegularPlan(p) &&
          p.name !== currentPlanObj.name &&
          p.name.toUpperCase() !== 'FREE',
      );
    }
    return availablePlans.filter((p) => {
      if (!isRegularPlan(p)) return false;
      if (p.name === currentPlanObj.name) return false;
      // Skip FREE — agencies can't self-subscribe to it
      if (p.name.toUpperCase() === 'FREE') return false;
      if (p.sortOrder !== currentPlanObj.sortOrder) {
        return p.sortOrder < currentPlanObj.sortOrder;
      }
      return p.price < currentPlanObj.price;
    });
  }, [availablePlans, currentPlanObj]);

  // Defensive frontend filter — drops any enterprise plan owned by a DIFFERENT
  // agency. The backend already excludes these, but this guarantees a stale
  // cached response can never leak another agency's bespoke plan into the grid.
  // The owning agency's own enterprise plan passes through (so they can see it
  // in the catalog with the ENTERPRISE badge / "Current Plan" marker).
  const currentAgencyId = user?.agencyId ?? null;
  const ownsPlan = (p: SubscriptionPlan) =>
    !p.isEnterprise || !p.ownerAgencyId || p.ownerAgencyId === currentAgencyId;

  // Visible plans = the slice of the catalog shown in the plans grid.
  // - ACTIVE & showPlansList=false  → empty (cards hidden by default)
  // - ACTIVE & plansFilter=upgrade  → upgradablePlans (already filtered)
  // - ACTIVE & plansFilter=downgrade→ downgradablePlans (already filtered)
  // - ACTIVE & plansFilter=null & showPlansList=true → all non-FREE, owned plans
  // - INACTIVE/EXPIRED              → all non-FREE, owned plans
  const visiblePlans = useMemo(() => {
    const catalogFilter = (p: SubscriptionPlan) =>
      p.name.toUpperCase() !== 'FREE' && ownsPlan(p);
    if (isActive) {
      if (!showPlansList) return [];
      if (plansFilter === 'upgrade') return upgradablePlans;
      if (plansFilter === 'downgrade') return downgradablePlans;
      return availablePlans.filter(catalogFilter);
    }
    return availablePlans.filter(catalogFilter);
  }, [isActive, showPlansList, plansFilter, upgradablePlans, downgradablePlans, availablePlans, currentAgencyId]);

  // Pass the hardware catalog into the PaymentDialog so the subscribe flow
  // can optionally include a hardware order.
  const hardwareProp = useMemo(
    () =>
      hardwareSettings.hardwareEnabled
        ? {
            products: hardwareProducts,
            commitmentTiers,
            settings: hardwareSettings,
          }
        : null,
    [hardwareSettings, hardwareProducts, commitmentTiers],
  );

  // Helper: status badge color for hardware orders
  const hwOrderStatusBadge = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'APPROVED' || s === 'FULFILLED') {
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
    }
    if (s === 'PENDING') {
      return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800';
    }
    return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800';
  };

  const hwOrderStatusLabel = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'FULFILLED') return t('fulfilled');
    if (s === 'APPROVED') return t('approved');
    if (s === 'REJECTED') return t('rejected');
    if (s === 'PENDING') return t('pending');
    return status;
  };

  // Helper: status badge for enterprise requests
  const entStatusBadge = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'APPROVED') {
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
    }
    if (s === 'REVIEWING') {
      return 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400 border-sky-200 dark:border-sky-800';
    }
    if (s === 'REJECTED') {
      return 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800';
    }
    return 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800';
  };

  const entStatusLabel = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'APPROVED') return t('approved');
    if (s === 'REVIEWING') return t('reviewing');
    if (s === 'REJECTED') return t('rejected');
    return t('pending');
  };

  // Helper: localize hardware product name (used in the orders list)
  const getHardwareProductName = (p: { name: string; nameAr?: string | null; nameFr?: string | null }) => {
    if (lang === 'ar' && p.nameAr) return p.nameAr;
    if (lang === 'fr' && p.nameFr) return p.nameFr;
    return p.name;
  };

  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <Skeleton className="h-32 rounded-2xl" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* ─── Compact Hero (merged: title + status + progress + expiry) ─── */}
      {/* Previously the page had THREE separate blocks showing the same
          status/days/expiry info (header, status banner, active plan card).
          Now there's just one compact hero that adapts its color theme to
          the subscription state and shows a single progress bar + expiry
          line. The active plan card below now focuses on plan details. */}
      {(() => {
        const startsAt = data?.subscriptionStartsAt;
        const expiresAt = data?.subscriptionExpiresAt ?? data?.expiresAt;
        // Progress = elapsed time inside the [startsAt, expiresAt] window.
        // 0% = just started, 100% = fully consumed / expired.
        const progress =
          startsAt && expiresAt
            ? Math.min(
                100,
                Math.max(
                  0,
                  ((Date.now() - new Date(startsAt).getTime()) /
                    (new Date(expiresAt).getTime() - new Date(startsAt).getTime())) *
                    100,
                ),
              )
            : data?.isExpired
              ? 100
              : 0;

        // Resolve the visual theme + copy from the subscription state.
        // EXPIRED → red, EXPIRING SOON → amber, ACTIVE → emerald/teal,
        // PENDING → sky/cyan, INACTIVE/other → slate.
        const isExpired = !!data?.isExpired;
        const isExpiringSoon = !!data?.isExpiringSoon && !isExpired;
        const isActiveStatus = data?.status === 'ACTIVE' && !isExpired && !isExpiringSoon;
        const isPending = data?.status === 'PENDING';

        let theme = 'from-slate-500 to-slate-600';
        let HeroIcon: typeof Crown = Info;
        let titleText = lang === 'ar' ? 'لا يوجد اشتراك نشط' : lang === 'fr' ? 'Aucun abonnement actif' : 'No Active Subscription';
        let descText = lang === 'ar'
          ? 'يرجى اختيار أحد الخطط أدناه للبدء'
          : lang === 'fr'
            ? 'Veuillez choisir un plan ci-dessous pour commencer'
            : 'Please choose a plan below to get started';
        let showProgress = false;
        let ctaLabel: string | null = t('selectPlan');
        let ctaTheme = 'bg-white text-slate-700 hover:bg-slate-100';

        if (isExpired) {
          theme = 'from-red-500 to-rose-600';
          HeroIcon = AlertCircle;
          titleText = t('subscriptionExpired');
          descText = t('subscriptionExpiredDesc');
          showProgress = true;
          ctaLabel = t('renewNow');
          ctaTheme = 'bg-white text-red-600 hover:bg-red-50';
        } else if (isExpiringSoon) {
          theme = 'from-amber-500 to-orange-500';
          HeroIcon = Clock;
          titleText = t('subscriptionExpiringSoon');
          descText = `${data?.daysRemaining ?? 0} ${t('daysRemaining')}`;
          showProgress = true;
          ctaLabel = t('renewNow');
          ctaTheme = 'bg-white text-amber-600 hover:bg-amber-50';
        } else if (isActiveStatus) {
          theme = 'from-emerald-600 via-emerald-500 to-teal-500';
          HeroIcon = CheckCircle2;
          titleText = t('subscriptionActive');
          descText = data?.daysRemaining != null
            ? `${data.daysRemaining} ${t('daysRemaining')}`
            : (lang === 'ar' ? 'اشتراكك الحالي نشط' : lang === 'fr' ? 'Votre abonnement est actif' : 'Your subscription is active');
          showProgress = true;
          ctaLabel = null; // No CTA — the active plan card has the actions.
        } else if (isPending) {
          theme = 'from-sky-500 to-cyan-500';
          HeroIcon = Clock;
          titleText = lang === 'ar' ? 'الاشتراك قيد الانتظار' : lang === 'fr' ? 'Abonnement en attente' : 'Subscription Pending';
          descText = lang === 'ar'
            ? 'في انتظار موافقة المسؤول على الدفع'
            : lang === 'fr'
              ? 'En attente de l\'approbation de l\'administrateur'
              : 'Waiting for admin approval of your payment';
          showProgress = false;
          ctaLabel = null;
        }

        const statusBadgeLabel = isExpired
          ? t('expired')
          : isActiveStatus
            ? t('active')
            : isPending
              ? t('pending')
              : (lang === 'ar' ? 'غير نشط' : lang === 'fr' ? 'Inactif' : 'Inactive');
        const StatusBadgeIcon = isExpired ? AlertCircle : isActiveStatus ? CheckCircle2 : Clock;
        const planName = resolvePlanName(data?.currentPlan) || '—';

        return (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${theme} p-5 sm:p-6 text-white shadow-lg`}
            role={isExpired ? 'alert' : 'status'}
            aria-live={isExpired ? 'assertive' : 'polite'}
          >
            {/* Decorative circles */}
            <div className="absolute -top-8 -right-8 h-32 w-32 rounded-full bg-white/10" />
            <div className="absolute bottom-4 -left-6 h-24 w-24 rounded-full bg-white/5" />
            <div className="absolute top-1/2 right-1/4 h-16 w-16 rounded-full bg-white/5" />

            <div className="relative z-10 flex items-start justify-between gap-4 flex-wrap">
              {/* Left: title + current plan name */}
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-inner flex-shrink-0">
                  <Crown className="h-6 w-6 sm:h-7 sm:w-7 text-white" />
                </div>
                <div className="min-w-0">
                  <h1 className="text-xl sm:text-2xl font-bold leading-tight">{t('subscription')}</h1>
                  <p className="text-white/85 text-xs sm:text-sm mt-0.5 truncate">
                    {t('currentPlan')}: <span className="font-semibold text-white">{planName}</span>
                  </p>
                </div>
              </div>

              {/* Right: status badge + expiry + days remaining (shown ONCE) */}
              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <Badge className="bg-white/20 text-white border-white/30 hover:bg-white/30 backdrop-blur-sm">
                  <span className="flex items-center gap-1.5">
                    <StatusBadgeIcon className="h-3 w-3" />
                    {statusBadgeLabel}
                  </span>
                </Badge>
                {expiresAt && (
                  <span className="text-[11px] text-white/85 flex items-center gap-1" dir="ltr">
                    <Clock className="h-3 w-3" />
                    {formatDate(expiresAt)}
                  </span>
                )}
                {data?.daysRemaining != null && data.daysRemaining > 0 && !isExpired && (
                  <span className="text-[10px] text-white/75">
                    {data.daysRemaining} {t('daysRemaining')}
                  </span>
                )}
              </div>
            </div>

            {/* Single source-of-truth progress bar (active / expiring / expired only) */}
            {showProgress && (
              <div className="relative z-10 mt-4">
                <div className="flex items-center justify-between text-[11px] text-white/85 mb-1">
                  <span className="flex items-center gap-1">
                    <HeroIcon className="h-3 w-3" />
                    <span className="font-medium">{titleText}</span>
                  </span>
                  <span className="text-white/75">{descText}</span>
                </div>
                <div className="h-2 rounded-full bg-white/30 overflow-hidden" aria-hidden="true">
                  <div
                    className="h-full rounded-full bg-white transition-[width] duration-500"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* For states without a progress bar (PENDING / INACTIVE), still
                show the title + description so the user knows what's going on. */}
            {!showProgress && (
              <div className="relative z-10 mt-4 flex items-center gap-2 text-sm">
                <HeroIcon className="h-4 w-4 flex-shrink-0" />
                <span className="font-medium">{titleText}</span>
                <span className="text-white/80">· {descText}</span>
              </div>
            )}

            {/* Inline CTA (Renew Now / Select Plan) — only shown when relevant */}
            {ctaLabel && (
              <div className="relative z-10 mt-4 flex justify-end">
                <Button
                  onClick={scrollToPlans}
                  className={`${ctaTheme} font-semibold flex-shrink-0 h-9 px-4`}
                >
                  {ctaLabel}
                </Button>
              </div>
            )}
          </motion.div>
        );
      })()}

      {/* ─── Active Subscription Card (only when ACTIVE) ─── */}
      {/* Clean, modern card focused on PLAN DETAILS (name, price, limits,
          features) + a SINGLE "Manage Subscription" dropdown action that
          consolidates the previous 4 redundant buttons (Cancel / Upgrade /
          Downgrade / View Plans) into one menu. The duplicate progress bar
          + days-remaining block has been removed — that info now lives in
          the merged hero above. */}
      {isActive && currentPlanObj && (() => {
        const accent = getPlanAccent(currentPlanObj);
        const PlanIcon = accent.icon;
        const priceDisplay = currentPlanObj.price === 0
          ? (lang === 'ar' ? 'مجاناً' : lang === 'fr' ? 'Gratuit' : 'Free')
          : `${currentPlanObj.price.toLocaleString()} ${currentPlanObj.currency}`;
        const cycleLabel = currentPlanObj.price === 0
          ? ''
          : getBillingCycleLabel(currentPlanObj.billingCycle, lang);
        const billingNote = currentPlanObj.billingCycle === 'YEARLY'
          ? (lang === 'ar' ? 'يُحاسب سنوياً' : lang === 'fr' ? 'Facturé annuellement' : 'Billed yearly')
          : currentPlanObj.billingCycle === 'ONE_TIME'
            ? (lang === 'ar' ? 'دفعة واحدة' : lang === 'fr' ? 'Paiement unique' : 'One-time payment')
            : (lang === 'ar' ? 'يُحاسب شهرياً' : lang === 'fr' ? 'Facturé mensuellement' : 'Billed monthly');

        // Localized labels for the dropdown menu items.
        const manageLabel = lang === 'ar' ? 'إدارة الاشتراك' : lang === 'fr' ? 'Gérer l\'abonnement' : 'Manage Subscription';
        const browsePlansLabel = lang === 'ar' ? 'تصفح الخطط' : lang === 'fr' ? 'Parcourir les plans' : 'Browse Plans';
        const cancelLabel = isCurrentEnterprise ? t('cancelEnterprisePlan') : t('cancelSubscription');

        // Helper that opens the plans grid with the given filter and scrolls
        // to it. Reused by every dropdown menu item.
        const openPlans = (filter: 'upgrade' | 'downgrade' | null) => {
          setPlansFilter(filter);
          setShowPlansList(true);
          setTimeout(scrollToPlans, 100);
        };

        return (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Card className={`relative overflow-hidden border-2 ${accent.ringActive} shadow-lg bg-white dark:bg-gray-900/80`}>
              <div className={`h-1.5 bg-gradient-to-r ${accent.gradientFrom} ${accent.gradientTo}`} />
              <CardContent className="p-5 sm:p-6">
                {/* ── Header: plan identity + price ── */}
                <div className="flex items-start gap-3">
                  <div className={`h-12 w-12 sm:h-14 sm:w-14 rounded-2xl bg-gradient-to-br ${accent.gradientFrom} ${accent.gradientTo} flex items-center justify-center shadow-md flex-shrink-0`}>
                    <PlanIcon className="h-6 w-6 sm:h-7 sm:w-7 text-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg sm:text-xl font-bold text-foreground">{getLocalizedPlanName(currentPlanObj)}</h3>
                      {isCurrentEnterprise && (
                        <Badge
                          className="text-[10px] font-extrabold uppercase tracking-wide bg-gradient-to-r from-amber-500 to-purple-600 text-white border-transparent shadow-sm"
                          title={t('yourEnterprisePlan')}
                        >
                          <Sparkles className="h-3 w-3 me-1" />
                          {t('enterprisePlanBadge')}
                        </Badge>
                      )}
                      <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                        <CheckCircle2 className="h-3 w-3 me-1" />
                        {t('activeSubscription')}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{currentPlanObj.name}</p>
                    {isCurrentEnterprise ? (
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 flex items-start gap-1">
                        <Sparkles className="h-3 w-3 mt-0.5 flex-shrink-0" />
                        <span>{t('enterprisePlanDesc')}</span>
                      </p>
                    ) : getLocalizedPlanDesc(currentPlanObj) ? (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{getLocalizedPlanDesc(currentPlanObj)}</p>
                    ) : null}
                  </div>
                  {/* Price block — right-aligned on sm+, full-width row on mobile */}
                  <div className="text-end flex-shrink-0">
                    <div className="flex items-baseline justify-end gap-1">
                      <span className="text-2xl sm:text-3xl font-extrabold text-foreground">{priceDisplay}</span>
                      {cycleLabel && <span className="text-xs text-muted-foreground">{cycleLabel}</span>}
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{billingNote}</p>
                  </div>
                </div>

                {/* ── Limits grid ── */}
                <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                  {limitItems(currentPlanObj).map((l) => (
                    <div key={l.label} className="rounded-xl bg-gray-50 dark:bg-gray-800/40 px-3 py-2 border border-border/40">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{l.label}</p>
                      <p className="text-sm font-bold text-foreground mt-0.5">{l.value.toLocaleString()}</p>
                    </div>
                  ))}
                </div>

                {/* ── Feature badges ── */}
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {featureBadges(currentPlanObj).map((f) => {
                    const FIcon = f.icon;
                    return (
                      <span
                        key={f.key}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                          f.enabled
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                            : 'bg-gray-50 text-muted-foreground dark:bg-gray-800/40 dark:text-gray-500 border-gray-200 dark:border-gray-700'
                        }`}
                      >
                        <FIcon className="h-3 w-3" />
                        {f.label}
                        {f.enabled ? (
                          <Check className="h-2.5 w-2.5" />
                        ) : (
                          <X className="h-2.5 w-2.5 opacity-50" />
                        )}
                      </span>
                    );
                  })}
                </div>

                {/* ── Action area: single "Manage Subscription" dropdown ── */}
                {/* Replaces the previous 4-button row (Cancel / Upgrade /
                    Downgrade / View Plans) with one consolidated menu.
                    Filter tabs at the top of the plans grid let users
                    switch filters without coming back to this card. */}
                <div className="mt-5 flex items-center justify-between gap-3 flex-wrap">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-sm h-10 px-4">
                        <Settings2 className="h-4 w-4 me-2" />
                        {manageLabel}
                        <ChevronDown className="h-4 w-4 ms-2 opacity-80" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuItem
                        onSelect={() => openPlans(null)}
                        className="cursor-pointer"
                      >
                        <Layers className="h-4 w-4 me-2 text-muted-foreground" />
                        {browsePlansLabel}
                      </DropdownMenuItem>
                      {upgradablePlans.length > 0 && (
                        <DropdownMenuItem
                          onSelect={() => openPlans('upgrade')}
                          className="cursor-pointer"
                        >
                          <ArrowUpCircle className="h-4 w-4 me-2 text-emerald-600 dark:text-emerald-400" />
                          {isCurrentEnterprise ? t('upgradeEnterprisePlan') : t('upgrade')}
                        </DropdownMenuItem>
                      )}
                      {downgradablePlans.length > 0 && (
                        <DropdownMenuItem
                          onSelect={() => openPlans('downgrade')}
                          className="cursor-pointer"
                        >
                          <ArrowDownCircle className="h-4 w-4 me-2 text-sky-600 dark:text-sky-400" />
                          {isCurrentEnterprise ? t('downgradeEnterprisePlan') : t('downgrade')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setCancelDialogOpen(true)}
                        className="cursor-pointer text-red-600 dark:text-red-400 focus:bg-red-50 dark:focus:bg-red-900/20"
                      >
                        <Ban className="h-4 w-4 me-2" />
                        {cancelLabel}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Hint when no upgrade/downgrade is available.
                      For enterprise plans we surface a bespoke message + the
                      "contact admin" guidance, since bespoke plans can't be
                      tweaked from the catalog UI. */}
                  {(() => {
                    if (isCurrentEnterprise) {
                      if (upgradablePlans.length === 0) {
                        return (
                          <div className="space-y-0.5 text-end">
                            <p className="text-[11px] text-muted-foreground">
                              {t('noUpgradesAvailable')}
                            </p>
                            <p className="text-[11px] text-amber-700 dark:text-amber-400">
                              {t('contactAdminForChanges')}
                            </p>
                          </div>
                        );
                      }
                      return null;
                    }
                    if (upgradablePlans.length === 0 && downgradablePlans.length === 0) {
                      return (
                        <p className="text-[11px] text-muted-foreground text-end">
                          {t('noUpgradeAvailable')}
                        </p>
                      );
                    }
                    return null;
                  })()}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        );
      })()}

      {/* ─── Plans grid header with filter tabs (only when ACTIVE) ─── */}
      {/* Replaces the old "filter label + cancel filter X button" header
          with a pill-style tab bar (All / Upgrade / Downgrade) plus a
          small "Hide" link on the right to collapse the grid. The tabs
          are the single filter mechanism — no more separate Upgrade /
          Downgrade buttons scattered around. */}
      <AnimatePresence>
        {isActive && showPlansList && (
          <motion.div
            key="plans-grid-header"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              {/* Filter tabs */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <FilterTab
                  active={plansFilter === null}
                  onClick={() => setPlansFilter(null)}
                  icon={<Layers className="h-3.5 w-3.5" />}
                  label={lang === 'ar' ? 'كل الخطط' : lang === 'fr' ? 'Tous les plans' : 'All Plans'}
                />
                {upgradablePlans.length > 0 && (
                  <FilterTab
                    active={plansFilter === 'upgrade'}
                    onClick={() => setPlansFilter('upgrade')}
                    icon={<ArrowUpCircle className="h-3.5 w-3.5" />}
                    label={isCurrentEnterprise ? t('availableUpgrades') : t('upgradePlan')}
                  />
                )}
                {downgradablePlans.length > 0 && (
                  <FilterTab
                    active={plansFilter === 'downgrade'}
                    onClick={() => setPlansFilter('downgrade')}
                    icon={<ArrowDownCircle className="h-3.5 w-3.5" />}
                    label={isCurrentEnterprise ? t('availableDowngrades') : t('downgradePlan')}
                  />
                )}
              </div>

              {/* Hide button — collapses the plans grid */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowPlansList(false);
                  setPlansFilter(null);
                }}
                className="text-muted-foreground hover:text-foreground h-8"
              >
                <ChevronUp className="h-3.5 w-3.5 me-1" />
                {t('hidePlans')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">{t('paymentDialogDesc')}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Plan Cards (responsive grid — uses visiblePlans) ─── */}
      {visiblePlans.length === 0 && !isActive && availablePlans.length === 0 ? (
        <Card className="border-dashed bg-white dark:bg-gray-900/80">
          <CardContent className="p-8 text-center">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
              <Info className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {lang === 'ar' ? 'لا توجد خطط متاحة حالياً' : lang === 'fr' ? 'Aucun plan disponible' : 'No plans available right now'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {lang === 'ar' ? 'يرجى الاتصال بالمسؤول' : lang === 'fr' ? 'Veuillez contacter l\'administrateur' : 'Please contact the administrator'}
            </p>
          </CardContent>
        </Card>
      ) : visiblePlans.length > 0 ? (
        <div ref={planCardsRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
          {visiblePlans.map((plan, idx) => {
            const accent = getPlanAccent(plan);
            const PlanIcon = accent.icon;
            const isCurrent = data?.currentPlan === plan.name;
            const isFree = plan.price === 0;
            const isEnterprisePlan = !!plan.isEnterprise;
            const isPremiumLike = plan.name.toUpperCase() === 'PREMIUM' || plan.name.toUpperCase() === 'PRO';

            // Display price: free plans show "Free" label, otherwise the price + currency
            const priceDisplay = isFree
              ? (lang === 'ar' ? 'مجاناً' : lang === 'fr' ? 'Gratuit' : 'Free')
              : `${plan.price.toLocaleString()} ${plan.currency}`;
            const cycleLabel = isFree ? '' : getBillingCycleLabel(plan.billingCycle, lang);

            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + idx * 0.07 }}
                whileHover={{ y: -4, transition: { duration: 0.2 } }}
                className="h-full"
              >
                <Card
                  className={`relative h-full transition-all duration-300 overflow-hidden border-2 flex flex-col ${
                    isCurrent
                      ? `${accent.ringActive} shadow-lg`
                      : 'border-transparent shadow-sm hover:shadow-md bg-white dark:bg-gray-900/80'
                  }`}
                >
                  {/* Gradient header stripe */}
                  <div className={`h-2 bg-gradient-to-r ${accent.gradientFrom} ${accent.gradientTo}`} />

                  {/* ENTERPRISE corner badge — bespoke plans only ever appear
                      here for the owning agency (filtered by visiblePlans), so
                      we always show it, even when this is the current plan. */}
                  {isEnterprisePlan && (
                    <div className="absolute top-4 end-4">
                      <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-500 to-purple-600 shadow-sm">
                        <Sparkles className="h-3 w-3 text-white" />
                        <span className="text-[10px] font-bold text-white uppercase tracking-wide">{t('enterprisePlanBadge')}</span>
                      </div>
                    </div>
                  )}

                  {/* Popular / Premium badge — only for non-enterprise, non-current plans */}
                  {isPremiumLike && !isCurrent && !isEnterprisePlan && (
                    <div className="absolute top-4 end-4">
                      <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full bg-gradient-to-r ${accent.badgeBg} shadow-sm`}>
                        <Sparkles className="h-3 w-3 text-white" />
                        <span className="text-[10px] font-bold text-white uppercase tracking-wide">{t('popular')}</span>
                      </div>
                    </div>
                  )}

                  <CardContent className="p-5 flex-1 flex flex-col">
                    {/* Plan icon & name */}
                    <div className="flex items-start gap-3 mb-4">
                      <div className={`h-11 w-11 rounded-xl bg-gradient-to-br ${accent.gradientFrom} ${accent.gradientTo} flex items-center justify-center shadow-md flex-shrink-0`}>
                        <PlanIcon className="h-5 w-5 text-white" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-bold text-lg text-foreground">{getLocalizedPlanName(plan)}</h3>
                          {isCurrent && (
                            <Badge className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                              <CheckCircle2 className="h-3 w-3 me-1" />
                              {t('currentPlan')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">{plan.name}</p>
                        {isEnterprisePlan ? (
                          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 line-clamp-2">
                            {t('enterprisePlanDesc')}
                          </p>
                        ) : getLocalizedPlanDesc(plan) ? (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{getLocalizedPlanDesc(plan)}</p>
                        ) : null}
                      </div>
                    </div>

                    {/* Price */}
                    <div className="mb-4 pb-4 border-b border-border/50">
                      <p className="text-3xl font-extrabold text-foreground">
                        {priceDisplay}
                        {cycleLabel && <span className="text-sm font-medium text-muted-foreground ms-1">{cycleLabel}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {plan.billingCycle === 'YEARLY'
                          ? (lang === 'ar' ? 'يُحاسب سنوياً' : lang === 'fr' ? 'Facturé annuellement' : 'Billed yearly')
                          : plan.billingCycle === 'ONE_TIME'
                            ? (lang === 'ar' ? 'دفعة واحدة' : lang === 'fr' ? 'Paiement unique' : 'One-time payment')
                            : (lang === 'ar' ? 'يُحاسب شهرياً' : lang === 'fr' ? 'Facturé mensuellement' : 'Billed monthly')}
                      </p>
                      {/* Period discounts — show available savings as a small badge row. */}
                      {(plan.quarterlyDiscount > 0 || plan.semiAnnualDiscount > 0 || plan.annualDiscount > 0 || plan.biennialDiscount > 0) && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {plan.quarterlyDiscount > 0 && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                              <Sparkles className="h-2.5 w-2.5" />
                              {t('savings')} {plan.quarterlyDiscount}% · 3 {t('months')}
                            </span>
                          )}
                          {plan.semiAnnualDiscount > 0 && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                              <Sparkles className="h-2.5 w-2.5" />
                              {t('savings')} {plan.semiAnnualDiscount}% · 6 {t('months')}
                            </span>
                          )}
                          {plan.annualDiscount > 0 && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                              <Sparkles className="h-2.5 w-2.5" />
                              {t('savings')} {plan.annualDiscount}% · 12 {t('months')}
                            </span>
                          )}
                          {plan.biennialDiscount > 0 && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                              <Sparkles className="h-2.5 w-2.5" />
                              {t('savings')} {plan.biennialDiscount}% · 24 {t('months')}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Limits grid */}
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      {limitItems(plan).map((l) => (
                        <div key={l.label} className="rounded-lg bg-gray-50 dark:bg-gray-800/40 px-2.5 py-2">
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{l.label}</p>
                          <p className="text-sm font-bold text-foreground">{l.value.toLocaleString()}</p>
                        </div>
                      ))}
                    </div>

                    {/* Feature badges */}
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {featureBadges(plan).map((f) => {
                        const FIcon = f.icon;
                        return (
                          <span
                            key={f.key}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                              f.enabled
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                                : 'bg-gray-50 text-muted-foreground dark:bg-gray-800/40 dark:text-gray-500 border-gray-200 dark:border-gray-700'
                            }`}
                          >
                            <FIcon className="h-3 w-3" />
                            {f.label}
                            {f.enabled ? (
                              <Check className="h-2.5 w-2.5" />
                            ) : (
                              <X className="h-2.5 w-2.5 opacity-50" />
                            )}
                          </span>
                        );
                      })}
                    </div>

                    {/* Subscribe Button / Current Plan badge */}
                    <div className="mt-auto pt-2">
                      {isCurrent ? (
                        <Button
                          className="w-full h-11 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-default rounded-xl"
                          disabled
                        >
                          <CheckCircle2 className="h-4 w-4 me-2" />
                          {t('currentPlan')}
                        </Button>
                      ) : isFree ? (
                        // Free plans don't require payment — show a disabled hint
                        <div className="w-full h-11 rounded-xl bg-gray-50 dark:bg-gray-800/40 border border-dashed border-gray-300 dark:border-gray-700 flex items-center justify-center text-xs text-muted-foreground">
                          {lang === 'ar' ? 'تواصل مع المسؤول للتفعيل' : lang === 'fr' ? 'Contactez l\'admin pour activer' : 'Contact admin to activate'}
                        </div>
                      ) : (
                        <Button
                          className="w-full h-11 font-semibold rounded-xl shadow-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-emerald-500/20 transition-all duration-300"
                          onClick={() => {
                            setSelectedPlan(plan);
                            setShowPaymentDialog(true);
                          }}
                        >
                          <ArrowRight className="h-4 w-4 me-2 rtl:rotate-180" />
                          {t('goToPayment')}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      ) : null}

      {/* ─── Enterprise / Custom Plan card ─── */}
      {/* Always shown (whether active or inactive) so agencies can request a
          tailored plan. Visible after the plans grid. */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <Card className="border-0 shadow-sm overflow-hidden bg-gradient-to-br from-purple-50 to-fuchsia-50 dark:from-purple-900/20 dark:to-fuchsia-900/20 border-purple-200 dark:border-purple-800/40">
          <CardContent className="p-5 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-purple-600 to-fuchsia-600 flex items-center justify-center shadow-md flex-shrink-0">
                <Sparkles className="h-6 w-6 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-foreground">{t('enterprisePlan')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t('enterprisePlanDesc')}</p>
              </div>
              <Button
                onClick={() => setEnterpriseDialogOpen(true)}
                className="bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-700 hover:to-fuchsia-700 text-white flex-shrink-0"
              >
                <Sparkles className="h-4 w-4 me-2" />
                {t('requestEnterprise')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Dynamic Plan Comparison Table ─── */}
      {/* Only render when there are visible plans to compare. Hidden for
          ACTIVE subscribers unless they opened the plans list. */}
      {visiblePlans.length > 1 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50 overflow-hidden">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-4 w-4 text-emerald-600" />
                {t('planComparison')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-emerald-50 dark:bg-emerald-900/20">
                      <th className="text-start py-3 px-4 text-xs font-semibold text-emerald-700 dark:text-emerald-400 min-w-[130px]">
                        {lang === 'ar' ? 'الميزة' : lang === 'fr' ? 'Fonctionnalité' : 'Feature'}
                      </th>
                      {visiblePlans.map((plan) => {
                        const accent = getPlanAccent(plan);
                        const PIcon = accent.icon;
                        return (
                          <th key={plan.id} className="text-center py-3 px-4 text-xs font-semibold text-emerald-700 dark:text-emerald-400 min-w-[110px]">
                            <div className="flex flex-col items-center gap-0.5">
                              <PIcon className="h-3.5 w-3.5" />
                              <span className="truncate max-w-[100px]">{getLocalizedPlanName(plan)}</span>
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Price row */}
                    <tr className="border-b border-border/30 bg-gray-50/50 dark:bg-gray-800/20">
                      <td className="py-2.5 px-4 text-xs text-muted-foreground font-medium">
                        {lang === 'ar' ? 'السعر' : lang === 'fr' ? 'Prix' : 'Price'}
                      </td>
                      {visiblePlans.map((plan) => {
                        const isFree = plan.price === 0;
                        return (
                          <td key={plan.id} className="text-center py-2.5 px-4">
                            <span className="text-xs font-bold text-foreground">
                              {isFree
                                ? (lang === 'ar' ? 'مجاناً' : lang === 'fr' ? 'Gratuit' : 'Free')
                                : `${plan.price.toLocaleString()} ${plan.currency}`}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                    {/* Limit rows */}
                    {[
                      { key: 'maxServices', label: t('maxServices') },
                      { key: 'maxBranches', label: t('maxBranches') },
                      { key: 'maxStaff', label: t('maxStaff') },
                      { key: 'maxActiveReservations', label: t('maxActiveReservations') },
                      { key: 'maxSmsPerMonth', label: t('maxSmsPerMonth') },
                    ].map((row, i) => (
                      <tr key={row.key} className={`border-b border-border/30 ${i % 2 === 0 ? 'bg-gray-50/50 dark:bg-gray-800/20' : ''}`}>
                        <td className="py-2.5 px-4 text-xs text-muted-foreground font-medium">{row.label}</td>
                        {visiblePlans.map((plan) => (
                          <td key={plan.id} className="text-center py-2.5 px-4">
                            <span className="text-xs font-medium text-foreground">
                              {(plan as any)[row.key] as number}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                    {/* Boolean feature rows */}
                    {[
                      { key: 'kioskModeEnabled', label: t('kioskModeEnabled') },
                      { key: 'analyticsEnabled', label: t('analyticsEnabled') },
                      { key: 'priorityListing', label: t('priorityListing') },
                      { key: 'customBranding', label: t('customBranding') },
                      { key: 'apiAccess', label: t('apiAccess') },
                    ].map((row, i) => (
                      <tr key={row.key} className={`border-b border-border/30 ${i % 2 === 0 ? 'bg-gray-50/50 dark:bg-gray-800/20' : ''}`}>
                        <td className="py-2.5 px-4 text-xs text-muted-foreground font-medium">{row.label}</td>
                        {visiblePlans.map((plan) => {
                          const val = (plan as any)[row.key] as boolean;
                          return (
                            <td key={plan.id} className="text-center py-2.5 px-4">
                              {val ? (
                                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/40">
                                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-gray-100 dark:bg-gray-800">
                                  <X className="h-3.5 w-3.5 text-gray-400" />
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ─── Hardware Catalog (standalone section) ─── */}
      {/* Visible whenever the admin has enabled hardware globally, regardless
          of subscription status. Active subscribers can order additional
          hardware here without going through the payment dialog. */}
      {hardwareSettings.hardwareEnabled && hardwareProducts.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-emerald-600" />
                {t('hardwareCatalog')}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">{t('hardwareCatalogDesc')}</p>
            </CardHeader>
            <CardContent className="pt-0">
              <HardwareCatalog
                products={hardwareProducts}
                commitmentTiers={commitmentTiers}
                settings={hardwareSettings}
                onOrderPlaced={fetchHardwareOrders}
              />
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ─── Hardware Orders list ─── */}
      {hardwareOrders.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4 text-emerald-600" />
                {t('hardwareOrders')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {hardwareOrders.map((order) => {
                  const isApproved = order.status === 'APPROVED' || order.status === 'FULFILLED';
                  const isPending = order.status === 'PENDING';
                  const totalDisplay =
                    order.paymentModel === 'UPFRONT'
                      ? order.upfrontTotal
                      : order.monthlyExtra;
                  return (
                    <div
                      key={order.id}
                      className="flex items-start gap-3 p-3.5 rounded-xl bg-gray-50 dark:bg-gray-900/50 border border-border/30"
                    >
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        isApproved
                          ? 'bg-emerald-100 dark:bg-emerald-900/30'
                          : isPending
                            ? 'bg-amber-100 dark:bg-amber-900/30'
                            : 'bg-red-100 dark:bg-red-900/30'
                      }`}>
                        <Package className={`h-5 w-5 ${
                          isApproved
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : isPending
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-red-600 dark:text-red-400'
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-foreground">
                            {order.items.map((it) =>
                              `${it.quantity}× ${getHardwareProductName(it.product)}`,
                            ).join(' · ')}
                          </p>
                          <Badge variant="outline" className={`text-[10px] ${hwOrderStatusBadge(order.status)}`}>
                            {hwOrderStatusLabel(order.status)}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDate(order.createdAt)} ·{' '}
                          {order.paymentModel === 'UPFRONT'
                            ? t('payUpfront')
                            : `${t('payMonthly')} · ${order.commitmentMonths ?? '—'} ${t('months')}`}
                        </p>
                      </div>
                      <div className="text-end flex-shrink-0">
                        <p className="text-sm font-bold text-foreground">
                          {totalDisplay.toLocaleString()} {t('currency')}
                        </p>
                        {order.paymentModel === 'MONTHLY' && (
                          <p className="text-[10px] text-muted-foreground">{t('perMonth')}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ─── Enterprise Requests list ─── */}
      {enterpriseRequests.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.24 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-purple-600" />
                {t('enterpriseRequests')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {enterpriseRequests.map((req) => (
                  <div
                    key={req.id}
                    className="p-3.5 rounded-xl bg-gray-50 dark:bg-gray-900/50 border border-border/30"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={`text-[10px] ${entStatusBadge(req.status)}`}>
                          {entStatusLabel(req.status)}
                        </Badge>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Building className="h-3 w-3" />
                          {req.branchesNeeded} {t('branchesNeeded')}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Hash className="h-3 w-3" />
                          {req.countersNeeded} {t('countersNeeded')}
                        </span>
                      </div>
                      <span className="text-[11px] text-muted-foreground">{formatDate(req.createdAt)}</span>
                    </div>
                    <p className="text-sm text-foreground line-clamp-3">{req.message}</p>
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        {req.contactEmail}
                      </span>
                      {req.contactPhone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {req.contactPhone}
                        </span>
                      )}
                    </div>
                    {req.adminNotes && (
                      <div className="mt-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/30">
                        <p className="text-[11px] text-amber-700 dark:text-amber-400">
                          <span className="font-semibold">
                            {lang === 'ar' ? 'ملاحظات المسؤول' : lang === 'fr' ? 'Notes de l\'admin' : 'Admin notes'}:
                          </span>{' '}
                          {req.adminNotes}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ─── FAQ Section ─── */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-emerald-600" />
              {t('faq')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {faqs.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-sm text-muted-foreground">{t('faqNoItems') || 'No FAQs available.'}</p>
              </div>
            ) : (
            <div className="space-y-2">
              {faqs.map((item, i) => (
                <div key={item.id}>
                  <button
                    onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors text-start"
                  >
                    <span className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                      {i + 1}
                    </span>
                    <span className="text-sm font-medium text-foreground flex-1">{item.question}</span>
                    <motion.span
                      animate={{ rotate: expandedFaq === i ? 180 : 0 }}
                      transition={{ duration: 0.2 }}
                      className="flex-shrink-0"
                    >
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </motion.span>
                  </button>
                  <AnimatePresence>
                    {expandedFaq === i && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <p className="text-sm text-muted-foreground ps-12 pe-3 pb-3 leading-relaxed">{item.answer}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              ))}
            </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Transaction History ─── */}
      {data?.recentTransactions && data.recentTransactions.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-emerald-600" />
                {t('transactions')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {data.recentTransactions.map((tx) => {
                  const isApproved = tx.status === 'APPROVED';
                  const isPending = tx.status === 'PENDING';
                  // Prefer the snapshot planName (frozen at transaction time)
                  // then fall back to resolving the legacy `plan` string against
                  // the catalog, then the raw value.
                  const displayName =
                    tx.planName ||
                    resolvePlanName(tx.plan) ||
                    tx.plan ||
                    '—';
                  // Prefer amountPaid snapshot when present, else the legacy amount
                  const displayAmount =
                    tx.amountPaid != null ? tx.amountPaid : tx.amount;

                  return (
                    <motion.div
                      key={tx.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-3 p-3.5 rounded-xl bg-gray-50 dark:bg-gray-900/50 border border-border/30"
                    >
                      {/* Status icon */}
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        isApproved
                          ? 'bg-emerald-100 dark:bg-emerald-900/30'
                          : isPending
                            ? 'bg-amber-100 dark:bg-amber-900/30'
                            : 'bg-red-100 dark:bg-red-900/30'
                      }`}>
                        {isApproved ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                        ) : isPending ? (
                          <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                        ) : (
                          <X className="h-5 w-5 text-red-600 dark:text-red-400" />
                        )}
                      </div>

                      {/* Details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-foreground">{displayName}</p>
                          <Badge
                            variant="outline"
                            className={
                              isApproved
                                ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                                : isPending
                                  ? 'text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200'
                                  : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                            }
                          >
                            {isApproved ? t('approved') : isPending ? t('pending') : t('rejected')}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {formatDate(tx.createdAt)} &middot; {getPaymentMethodLabel(tx.method)}
                        </p>
                        {tx.rejectionReason && !isApproved && !isPending && (
                          <p className="text-[11px] text-red-600 dark:text-red-400 mt-0.5 line-clamp-1">
                            {tx.rejectionReason}
                          </p>
                        )}
                      </div>

                      {/* Amount */}
                      <div className="text-end flex-shrink-0">
                        <p className="text-sm font-bold text-foreground">{displayAmount.toLocaleString()} {t('currency')}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* ─── Payment Dialog (with optional hardware picker) ─── */}
      <PaymentDialog
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        selectedPlan={selectedPlan}
        onSuccess={fetchSubscription}
        hardware={hardwareProp}
      />

      {/* ─── Cancel Subscription AlertDialog ─── */}
      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Ban className="h-5 w-5 text-red-600" />
              {isCurrentEnterprise ? t('cancelEnterprisePlan') : t('cancelSubscription')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isCurrentEnterprise ? t('enterprisePlanDesc') : t('cancelSubscriptionDesc')}
              <span className="block mt-2 text-red-600 dark:text-red-400 font-medium">
                {t('cancelSubscriptionWarning')}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelLoading}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleCancelSubscription();
              }}
              disabled={cancelLoading}
              className="bg-red-600 hover:bg-red-700 text-white focus:ring-red-600"
            >
              {cancelLoading ? (
                <Loader2 className="h-4 w-4 animate-spin me-2" />
              ) : (
                <Ban className="h-4 w-4 me-2" />
              )}
              {t('cancelSubscriptionConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Enterprise Request Dialog ─── */}
      <EnterpriseRequestDialog
        open={enterpriseDialogOpen}
        onOpenChange={setEnterpriseDialogOpen}
        onSuccess={fetchEnterpriseRequests}
      />
    </div>
  );
}
