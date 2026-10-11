'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ArrowLeft,
  RefreshCw,
  Loader2,
  Eye,
  XCircle,
  Plus,
  Check,
  Building2,
  Mail,
  Phone,
  MessageSquare,
  Hash,
  Monitor,
  Calendar,
  Briefcase,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Package,
  Users,
  CreditCard,
  Star,
  Palette,
  Code,
  BarChart3,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { translateStatus } from '@/lib/enum-i18n';

// ─── Types ──────────────────────────────────────────────────────────────────

interface EnterpriseRequest {
  id: string;
  agencyId: string;
  agencyName: string;
  contactEmail: string;
  contactPhone?: string | null;
  message: string;
  requestedFeatures: string | string[];
  branchesNeeded: number;
  countersNeeded: number;
  hardwareNeeded: boolean;
  status: string; // PENDING | REVIEWING | APPROVED | REJECTED
  adminNotes?: string | null;
  customPlanId?: string | null;
  createdAt: string;
  updatedAt?: string;
  agency?: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    customCode?: string;
    subscriptionTier?: string;
    subscriptionStatus?: string;
    email?: string;
    phone?: string;
  } | null;
  customPlan?: {
    id: string;
    name: string;
    displayName: string;
    price: number;
    billingCycle: string;
  } | null;
}

type StatusFilter = 'ALL' | 'PENDING' | 'REVIEWING' | 'APPROVED' | 'REJECTED';

interface PlanForm {
  name: string;
  displayName: string;
  displayNameAr: string;
  displayNameFr: string;
  description: string;
  price: number;
  currency: string;
  billingCycle: string;
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
}

const defaultPlanForm: PlanForm = {
  name: '',
  displayName: '',
  displayNameAr: '',
  displayNameFr: '',
  description: '',
  price: 0,
  currency: 'DZD',
  billingCycle: 'MONTHLY',
  maxServices: 99,
  maxBranches: 5,
  maxStaff: 20,
  maxActiveReservations: 999,
  maxSmsPerMonth: 500,
  kioskModeEnabled: true,
  analyticsEnabled: true,
  priorityListing: true,
  customBranding: true,
  apiAccess: true,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseFeatures(features: string | string[]): string[] {
  if (Array.isArray(features)) return features;
  if (!features) return [];
  try {
    const parsed = JSON.parse(features);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return features.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    case 'REVIEWING':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400';
    case 'APPROVED':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
    case 'REJECTED':
      return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'bg-amber-500';
    case 'REVIEWING':
      return 'bg-sky-500';
    case 'APPROVED':
      return 'bg-emerald-500';
    case 'REJECTED':
      return 'bg-red-500';
    default:
      return 'bg-gray-500';
  }
}

function formatDate(iso: string, lang: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AdminEnterpriseRequests() {
  const { setView } = useAppStore();
  const { t, lang } = useLanguage();

  const [requests, setRequests] = useState<EnterpriseRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  // Reject dialog state
  const [rejectTarget, setRejectTarget] = useState<EnterpriseRequest | null>(null);
  const [rejectNotes, setRejectNotes] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Create plan dialog state
  const [planTarget, setPlanTarget] = useState<EnterpriseRequest | null>(null);
  const [planForm, setPlanForm] = useState<PlanForm>({ ...defaultPlanForm });
  const [creatingPlan, setCreatingPlan] = useState(false);

  // Action loading (for the "Review" button which is fire-and-forget)
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    try {
      const url =
        statusFilter === 'ALL'
          ? '/api/admin/enterprise-requests'
          : `/api/admin/enterprise-requests?status=${statusFilter}`;
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        setRequests(data.requests ?? []);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, t]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleReview = async (req: EnterpriseRequest) => {
    setReviewingId(req.id);
    try {
      const res = await apiFetch(`/api/admin/enterprise-requests/${req.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REVIEWING' }),
      });
      if (res.ok) {
        toast.success(t('requestReviewed'));
        // Update local state to reflect the change immediately
        setRequests((list) =>
          list.map((r) => (r.id === req.id ? { ...r, status: 'REVIEWING' } : r)),
        );
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setReviewingId(null);
    }
  };

  const openRejectDialog = (req: EnterpriseRequest) => {
    setRejectTarget(req);
    setRejectNotes(req.adminNotes ?? '');
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    if (!rejectNotes.trim()) {
      toast.error(t('rejectRequestDesc'));
      return;
    }
    setRejecting(true);
    try {
      const res = await apiFetch(`/api/admin/enterprise-requests/${rejectTarget.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REJECTED', adminNotes: rejectNotes.trim() }),
      });
      if (res.ok) {
        toast.success(t('requestRejected'));
        setRequests((list) =>
          list.map((r) =>
            r.id === rejectTarget.id
              ? { ...r, status: 'REJECTED', adminNotes: rejectNotes.trim() }
              : r,
          ),
        );
        setRejectTarget(null);
        setRejectNotes('');
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setRejecting(false);
    }
  };

  const openCreatePlanDialog = (req: EnterpriseRequest) => {
    setPlanTarget(req);
    // Pre-fill the form with sensible defaults derived from the request
    const sanitizedName = (req.agencyName || 'ENTERPRISE')
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 24);
    const features = parseFeatures(req.requestedFeatures);
    setPlanForm({
      ...defaultPlanForm,
      name: `ENTERPRISE_${sanitizedName}`.slice(0, 40),
      displayName: `${req.agencyName} — Enterprise`,
      maxBranches: Math.max(req.branchesNeeded || 1, defaultPlanForm.maxBranches),
      maxStaff: Math.max((req.countersNeeded || 1) * 4, defaultPlanForm.maxStaff),
      kioskModeEnabled: features.includes('KIOSK') || defaultPlanForm.kioskModeEnabled,
      analyticsEnabled: features.includes('ANALYTICS') || defaultPlanForm.analyticsEnabled,
      priorityListing: features.includes('PRIORITY') || defaultPlanForm.priorityListing,
      customBranding: features.includes('BRANDING') || defaultPlanForm.customBranding,
      apiAccess: features.includes('API') || defaultPlanForm.apiAccess,
    });
  };

  const handleCreatePlan = async () => {
    if (!planTarget) return;
    if (!planForm.name.trim() || !planForm.displayName.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    setCreatingPlan(true);
    try {
      const payload = {
        name: planForm.name.trim(),
        displayName: planForm.displayName.trim(),
        displayNameAr: planForm.displayNameAr.trim() || null,
        displayNameFr: planForm.displayNameFr.trim() || null,
        description: planForm.description.trim() || null,
        price: Number(planForm.price) || 0,
        currency: planForm.currency || 'DZD',
        billingCycle: planForm.billingCycle || 'MONTHLY',
        maxServices: Number(planForm.maxServices) || 99,
        maxBranches: Number(planForm.maxBranches) || 1,
        maxStaff: Number(planForm.maxStaff) || 1,
        maxActiveReservations: Number(planForm.maxActiveReservations) || 999,
        maxSmsPerMonth: Number(planForm.maxSmsPerMonth) || 0,
        kioskModeEnabled: !!planForm.kioskModeEnabled,
        analyticsEnabled: !!planForm.analyticsEnabled,
        priorityListing: !!planForm.priorityListing,
        customBranding: !!planForm.customBranding,
        apiAccess: !!planForm.apiAccess,
      };

      const res = await apiFetch(`/api/admin/enterprise-requests/${planTarget.id}/create-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('planCreatedSuccess'));
        // Update local state to reflect the APPROVED status + linked plan
        setRequests((list) =>
          list.map((r) =>
            r.id === planTarget.id
              ? {
                  ...r,
                  status: 'APPROVED',
                  customPlanId: data.plan?.id ?? r.customPlanId,
                  customPlan: data.plan ?? r.customPlan,
                }
              : r,
          ),
        );
        setPlanTarget(null);
        // Reset form
        setPlanForm({ ...defaultPlanForm });
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCreatingPlan(false);
    }
  };

  const filterButtons: { value: StatusFilter; label: string; count: number }[] = [
    { value: 'ALL', label: t('filterAll'), count: requests.length },
    { value: 'PENDING', label: t('pending'), count: requests.filter((r) => r.status === 'PENDING').length },
    { value: 'REVIEWING', label: t('reviewing'), count: requests.filter((r) => r.status === 'REVIEWING').length },
    { value: 'APPROVED', label: t('approved'), count: requests.filter((r) => r.status === 'APPROVED').length },
    { value: 'REJECTED', label: t('rejected'), count: requests.filter((r) => r.status === 'REJECTED').length },
  ];

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl bg-white/20 hover:bg-white/30 text-white"
                onClick={() => setView('admin-dashboard')}
              >
                <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  <Briefcase className="h-6 w-6" />
                  {t('enterpriseRequests')}
                </h1>
                <p className="text-sm text-emerald-100 mt-0.5">{t('createCustomPlan')}</p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-xl bg-white/20 hover:bg-white/30 text-white"
              onClick={fetchRequests}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Filter buttons */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="flex flex-wrap gap-2"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground me-1">
          <Filter className="h-3.5 w-3.5" />
        </div>
        {filterButtons.map((btn) => {
          const active = statusFilter === btn.value;
          return (
            <Button
              key={btn.value}
              variant={active ? 'default' : 'outline'}
              size="sm"
              className={`rounded-xl gap-2 h-8 ${active ? '' : 'text-muted-foreground'}`}
              onClick={() => setStatusFilter(btn.value)}
            >
              {btn.label}
              <Badge
                variant="outline"
                className={`text-[9px] px-1.5 py-0 ${
                  active
                    ? 'bg-white/20 text-white border-white/30'
                    : 'bg-muted/50 text-muted-foreground'
                }`}
              >
                {btn.count}
              </Badge>
            </Button>
          );
        })}
      </motion.div>

      {/* Request cards */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-72 rounded-2xl" />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="h-16 w-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
                <Briefcase className="h-8 w-8 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-foreground">{t('noEnterpriseRequestsAdmin')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('noDataYet')}</p>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AnimatePresence mode="popLayout">
            {requests.map((req, idx) => {
              const features = parseFeatures(req.requestedFeatures);
              const isPending = req.status === 'PENDING';
              const isReviewing = req.status === 'REVIEWING';
              const isApproved = req.status === 'APPROVED';
              const isRejected = req.status === 'REJECTED';
              return (
                <motion.div
                  key={req.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: idx * 0.05, duration: 0.35 }}
                >
                  <Card className="border shadow-sm overflow-hidden hover:shadow-md transition-shadow bg-white dark:bg-gray-900/80">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center flex-shrink-0">
                            <Building2 className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="text-base font-bold truncate">
                              {req.agencyName}
                            </CardTitle>
                            <div className="flex items-center gap-2 mt-1">
                              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-medium ${statusBadgeClass(req.status)}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(req.status)}`} />
                                {translateStatus(req.status, t)}
                              </span>
                              <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                                <Calendar className="h-3 w-3" />
                                {formatDate(req.createdAt, lang)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      {/* Contact info */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                          <Mail className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="text-xs text-foreground truncate">{req.contactEmail}</span>
                        </div>
                        {req.contactPhone && (
                          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                            <Phone className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-xs text-foreground truncate" dir="ltr">
                              {req.contactPhone}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Branches / Counters / Hardware */}
                      <div className="grid grid-cols-3 gap-2">
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/30">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <p className="text-[9px] text-muted-foreground uppercase">{t('branchesNeeded')}</p>
                            <p className="text-xs font-semibold text-foreground">{req.branchesNeeded}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/30">
                          <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <p className="text-[9px] text-muted-foreground uppercase">{t('countersNeeded')}</p>
                            <p className="text-xs font-semibold text-foreground">{req.countersNeeded}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-muted/30">
                          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                          <div>
                            <p className="text-[9px] text-muted-foreground uppercase">{t('hardwareNeededLabel')}</p>
                            <p className="text-xs font-semibold text-foreground">
                              {req.hardwareNeeded ? t('yes') : t('no')}
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Message */}
                      {req.message && (
                        <div className="p-3 rounded-lg bg-muted/40 border border-border/40">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                            <MessageSquare className="h-3 w-3" />
                            {t('enterpriseMessage')}
                          </p>
                          <p className="text-xs text-foreground whitespace-pre-wrap line-clamp-4">
                            {req.message}
                          </p>
                        </div>
                      )}

                      {/* Requested features */}
                      {features.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                            {t('requestedFeaturesHint')}
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {features.map((f) => (
                              <Badge
                                key={f}
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800"
                              >
                                {f}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Admin notes (if rejected/approved) */}
                      {req.adminNotes && (isRejected || isApproved) && (
                        <div className={`p-3 rounded-lg border ${
                          isRejected
                            ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/40'
                            : 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-900/40'
                        }`}>
                          <p
                            className={`text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1 ${
                              isRejected ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {t('adminNotes')}
                          </p>
                          <p className="text-xs text-foreground whitespace-pre-wrap">{req.adminNotes}</p>
                        </div>
                      )}

                      {/* Custom plan linked */}
                      {isApproved && req.customPlan && (
                        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-900/40">
                          <p className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            {t('customPlanCreated')}
                          </p>
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-semibold text-foreground">{req.customPlan.displayName}</p>
                            <span className="text-xs text-muted-foreground">
                              {req.customPlan.price.toLocaleString()} {req.customPlan.billingCycle === 'MONTHLY' ? t('perMonth') : ''}
                            </span>
                          </div>
                        </div>
                      )}

                      <Separator />

                      {/* Actions */}
                      <div className="flex flex-wrap gap-2">
                        {(isPending || isReviewing) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 rounded-lg h-8"
                            onClick={() => handleReview(req)}
                            disabled={reviewingId === req.id || isReviewing}
                          >
                            {reviewingId === req.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                            {t('reviewRequest')}
                          </Button>
                        )}
                        {(isPending || isReviewing) && (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5 rounded-lg h-8 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 border-red-200 dark:border-red-900/40"
                              onClick={() => openRejectDialog(req)}
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              {t('rejectRequest')}
                            </Button>
                            <Button
                              size="sm"
                              className="gap-1.5 rounded-lg h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
                              onClick={() => openCreatePlanDialog(req)}
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('createCustomPlan')}
                            </Button>
                          </>
                        )}
                        {isApproved && !req.customPlan && (
                          <Button
                            size="sm"
                            className="gap-1.5 rounded-lg h-8 bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={() => openCreatePlanDialog(req)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {t('createCustomPlan')}
                          </Button>
                        )}
                        {isRejected && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 rounded-lg h-8"
                            onClick={() => openCreatePlanDialog(req)}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {t('createCustomPlan')}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* ─── Reject Dialog ────────────────────────────────────────────────── */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(o) => {
          if (!o) {
            setRejectTarget(null);
            setRejectNotes('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <XCircle className="h-5 w-5" />
              {t('rejectRequest')}
            </DialogTitle>
            <DialogDescription>{t('rejectRequestDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {rejectTarget && (
              <div className="p-3 rounded-lg bg-muted/40">
                <p className="text-sm font-semibold text-foreground">{rejectTarget.agencyName}</p>
                <p className="text-xs text-muted-foreground">{rejectTarget.contactEmail}</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t('adminNotes')}</Label>
              <Textarea
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                placeholder={t('rejectRequestDesc')}
                rows={4}
                className="text-sm"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setRejectNotes('');
              }}
              className="rounded-xl"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={rejecting || !rejectNotes.trim()}
              className="rounded-xl gap-2"
            >
              {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              {t('rejectRequest')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Create Custom Plan Dialog ────────────────────────────────────── */}
      <Dialog
        open={!!planTarget}
        onOpenChange={(o) => {
          if (!o) {
            setPlanTarget(null);
            setPlanForm({ ...defaultPlanForm });
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-emerald-600" />
              {t('createCustomPlan')}
            </DialogTitle>
            <DialogDescription>
              {planTarget ? `${planTarget.agencyName} — ${planTarget.contactEmail}` : t('createCustomPlan')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Basic info */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                {t('planBasicInfo')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('planName')} *</Label>
                  <Input
                    value={planForm.name}
                    onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
                    placeholder="ENTERPRISE_CUSTOM..."
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('displayName')} *</Label>
                  <Input
                    value={planForm.displayName}
                    onChange={(e) => setPlanForm({ ...planForm, displayName: e.target.value })}
                    placeholder={t('displayName')}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('displayNameAr')}</Label>
                  <Input
                    value={planForm.displayNameAr}
                    onChange={(e) => setPlanForm({ ...planForm, displayNameAr: e.target.value })}
                    placeholder="الاسم بالعربية"
                    dir="rtl"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('displayNameFr')}</Label>
                  <Input
                    value={planForm.displayNameFr}
                    onChange={(e) => setPlanForm({ ...planForm, displayNameFr: e.target.value })}
                    placeholder="Nom en français"
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('description')}</Label>
                <Input
                  value={planForm.description}
                  onChange={(e) => setPlanForm({ ...planForm, description: e.target.value })}
                  placeholder={t('description')}
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Pricing */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                {t('pricing')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('planPrice')} (DZD)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={planForm.price}
                    onChange={(e) => setPlanForm({ ...planForm, price: parseInt(e.target.value) || 0 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('billingCycle')}</Label>
                  <Select
                    value={planForm.billingCycle}
                    onValueChange={(v) => setPlanForm({ ...planForm, billingCycle: v })}
                  >
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder={t('billingCycle')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MONTHLY">{t('monthly')}</SelectItem>
                      <SelectItem value="YEARLY">{t('yearly')}</SelectItem>
                      <SelectItem value="ONE_TIME">{t('oneTime')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('currency')}</Label>
                  <Input
                    value={planForm.currency}
                    onChange={(e) => setPlanForm({ ...planForm, currency: e.target.value })}
                    className="h-9 text-sm"
                    disabled
                  />
                </div>
              </div>
            </div>

            {/* Limits */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                {t('planLimits')}
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxServices')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={planForm.maxServices}
                    onChange={(e) => setPlanForm({ ...planForm, maxServices: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxBranches')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={planForm.maxBranches}
                    onChange={(e) => setPlanForm({ ...planForm, maxBranches: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxStaff')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={planForm.maxStaff}
                    onChange={(e) => setPlanForm({ ...planForm, maxStaff: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxReservations')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={planForm.maxActiveReservations}
                    onChange={(e) => setPlanForm({ ...planForm, maxActiveReservations: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxSmsPerMonth')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={planForm.maxSmsPerMonth}
                    onChange={(e) => setPlanForm({ ...planForm, maxSmsPerMonth: parseInt(e.target.value) || 0 })}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Features */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Star className="h-4 w-4 text-muted-foreground" />
                {t('features')}
              </h3>
              <div className="space-y-2">
                <FeatureToggle
                  icon={Monitor}
                  label={t('kioskModeEnabled')}
                  description={t('kioskModeEnabledDesc')}
                  checked={planForm.kioskModeEnabled}
                  onChange={(v) => setPlanForm({ ...planForm, kioskModeEnabled: v })}
                />
                <FeatureToggle
                  icon={BarChart3}
                  label={t('analyticsEnabled')}
                  description={t('analyticsEnabledDesc')}
                  checked={planForm.analyticsEnabled}
                  onChange={(v) => setPlanForm({ ...planForm, analyticsEnabled: v })}
                />
                <FeatureToggle
                  icon={Star}
                  label={t('priorityListing')}
                  description={t('priorityListingDesc')}
                  checked={planForm.priorityListing}
                  onChange={(v) => setPlanForm({ ...planForm, priorityListing: v })}
                />
                <FeatureToggle
                  icon={Palette}
                  label={t('customBranding')}
                  description={t('customBrandingDesc')}
                  checked={planForm.customBranding}
                  onChange={(v) => setPlanForm({ ...planForm, customBranding: v })}
                />
                <FeatureToggle
                  icon={Code}
                  label={t('apiAccess')}
                  description={t('apiAccessDesc')}
                  checked={planForm.apiAccess}
                  onChange={(v) => setPlanForm({ ...planForm, apiAccess: v })}
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPlanTarget(null);
                setPlanForm({ ...defaultPlanForm });
              }}
              className="rounded-xl"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreatePlan}
              disabled={creatingPlan}
              className="rounded-xl gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {creatingPlan ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {t('createCustomPlan')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function FeatureToggle({ icon: Icon, label, description, checked, onChange }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
          <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-[10px] text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
