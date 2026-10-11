'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  Crown,
  Check,
  X,
  Loader2,
  RefreshCw,
  Building2,
  Users,
  CreditCard,
  Package,
  Monitor,
  BarChart3,
  Star,
  Palette,
  Code,
  MessageSquare,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

interface PlanFeature {
  id: string;
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
  isActive: boolean;
  sortOrder: number;
  quarterlyDiscount: number;
  semiAnnualDiscount: number;
  annualDiscount: number;
  biennialDiscount: number;
  createdAt: string;
  updatedAt: string;
  features: PlanFeature[];
  _count: { agencies: number };
}

interface PlanFormData {
  name: string;
  displayName: string;
  displayNameAr: string;
  displayNameFr: string;
  description: string;
  descriptionAr: string;
  descriptionFr: string;
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
  isActive: boolean;
  sortOrder: number;
  quarterlyDiscount: number;
  semiAnnualDiscount: number;
  annualDiscount: number;
  biennialDiscount: number;
}

const defaultFormData: PlanFormData = {
  name: '',
  displayName: '',
  displayNameAr: '',
  displayNameFr: '',
  description: '',
  descriptionAr: '',
  descriptionFr: '',
  price: 0,
  currency: 'DZD',
  billingCycle: 'MONTHLY',
  maxServices: 5,
  maxBranches: 1,
  maxStaff: 3,
  maxActiveReservations: 50,
  maxSmsPerMonth: 50,
  kioskModeEnabled: false,
  analyticsEnabled: false,
  priorityListing: false,
  customBranding: false,
  apiAccess: false,
  isActive: true,
  sortOrder: 0,
  quarterlyDiscount: 0,
  semiAnnualDiscount: 0,
  annualDiscount: 0,
  biennialDiscount: 0,
};

function getPlanAccentColor(plan: SubscriptionPlan): { gradient: string; border: string; badge: string; icon: string; bg: string } {
  const name = plan.name.toLowerCase();
  if (name.includes('free') || name.includes('basic') && plan.price === 0) {
    return {
      gradient: 'from-gray-50 to-slate-50 dark:from-gray-900/30 dark:to-slate-900/30',
      border: 'border-gray-200 dark:border-gray-700',
      badge: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
      icon: 'text-gray-500 dark:text-gray-400',
      bg: 'bg-gray-100 dark:bg-gray-800',
    };
  }
  if (name.includes('premium') || name.includes('gold') || name.includes('pro')) {
    return {
      gradient: 'from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20',
      border: 'border-amber-200 dark:border-amber-800',
      badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      icon: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-100 dark:bg-amber-900/30',
    };
  }
  // Basic / Standard / Default
  return {
    gradient: 'from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20',
    border: 'border-emerald-200 dark:border-emerald-800',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    icon: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-100 dark:bg-emerald-900/30',
  };
}

function getPlanIcon(plan: SubscriptionPlan) {
  const name = plan.name.toLowerCase();
  if (name.includes('free') || (name.includes('basic') && plan.price === 0)) return Package;
  if (name.includes('premium') || name.includes('gold') || name.includes('pro')) return Crown;
  return Star;
}

export function AdminSubscriptionPlans() {
  const { setView } = useAppStore();
  const { t, lang } = useLanguage();

  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [deletingPlan, setDeletingPlan] = useState<SubscriptionPlan | null>(null);
  const [formData, setFormData] = useState<PlanFormData>({ ...defaultFormData });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchPlans = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/subscription-plans');
      if (res.ok) {
        const data = await res.json();
        setPlans(data.plans ?? []);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchPlans();
  }, [fetchPlans]);

  const openCreateDialog = () => {
    setEditingPlan(null);
    setFormData({ ...defaultFormData });
    setDialogOpen(true);
  };

  const openEditDialog = (plan: SubscriptionPlan) => {
    setEditingPlan(plan);
    setFormData({
      name: plan.name,
      displayName: plan.displayName,
      displayNameAr: plan.displayNameAr || '',
      displayNameFr: plan.displayNameFr || '',
      description: plan.description || '',
      descriptionAr: plan.descriptionAr || '',
      descriptionFr: plan.descriptionFr || '',
      price: plan.price,
      currency: plan.currency,
      billingCycle: plan.billingCycle,
      maxServices: plan.maxServices,
      maxBranches: plan.maxBranches,
      maxStaff: plan.maxStaff,
      maxActiveReservations: plan.maxActiveReservations,
      maxSmsPerMonth: plan.maxSmsPerMonth,
      kioskModeEnabled: plan.kioskModeEnabled,
      analyticsEnabled: plan.analyticsEnabled,
      priorityListing: plan.priorityListing,
      customBranding: plan.customBranding,
      apiAccess: plan.apiAccess,
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      quarterlyDiscount: plan.quarterlyDiscount ?? 0,
      semiAnnualDiscount: plan.semiAnnualDiscount ?? 0,
      annualDiscount: plan.annualDiscount ?? 0,
      biennialDiscount: plan.biennialDiscount ?? 0,
    });
    setDialogOpen(true);
  };

  const openDeleteDialog = (plan: SubscriptionPlan) => {
    setDeletingPlan(plan);
    setDeleteDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.displayName.trim()) {
      toast.error(t('requiredField'));
      return;
    }

    setSaving(true);
    try {
      const url = editingPlan
        ? `/api/admin/subscription-plans/${editingPlan.id}`
        : '/api/admin/subscription-plans';
      const method = editingPlan ? 'PATCH' : 'POST';

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (res.ok) {
        toast.success(editingPlan ? t('planUpdated') : t('planCreated'));
        setDialogOpen(false);
        fetchPlans();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingPlan) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/admin/subscription-plans/${deletingPlan.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('planDeleted'));
        setDeleteDialogOpen(false);
        setDeletingPlan(null);
        fetchPlans();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleting(false);
    }
  };

  const getBillingCycleLabel = (cycle: string) => {
    switch (cycle) {
      case 'MONTHLY': return t('monthly');
      case 'YEARLY': return t('yearly');
      case 'ONE_TIME': return t('oneTime');
      default: return cycle;
    }
  };

  const getLocalizedDisplayName = (plan: SubscriptionPlan) => {
    if (lang === 'ar' && plan.displayNameAr) return plan.displayNameAr;
    if (lang === 'fr' && plan.displayNameFr) return plan.displayNameFr;
    return plan.displayName;
  };

  const getLocalizedDescription = (plan: SubscriptionPlan) => {
    if (lang === 'ar' && plan.descriptionAr) return plan.descriptionAr;
    if (lang === 'fr' && plan.descriptionFr) return plan.descriptionFr;
    return plan.description;
  };

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
                  <Crown className="h-6 w-6" />
                  {t('subscriptionPlans')}
                </h1>
                <p className="text-sm text-emerald-100 mt-0.5">{t('subscriptionPlansDesc')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-xl bg-white/20 hover:bg-white/30 text-white"
                onClick={fetchPlans}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                className="bg-white/20 hover:bg-white/30 text-white border-white/30 backdrop-blur-sm gap-2 rounded-xl"
                onClick={openCreateDialog}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('createPlan')}</span>
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Plan Cards Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-72 rounded-2xl" />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <div className="h-16 w-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
                <Package className="h-8 w-8 text-gray-400" />
              </div>
              <p className="text-sm font-medium text-foreground">{t('noSubscriptionPlans')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('createFirstPlan')}</p>
              <Button className="mt-4 gap-2 rounded-xl" onClick={openCreateDialog}>
                <Plus className="h-4 w-4" />
                {t('createPlan')}
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout">
            {plans.map((plan, idx) => {
              const accent = getPlanAccentColor(plan);
              const PlanIcon = getPlanIcon(plan);
              return (
                <motion.div
                  key={plan.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: idx * 0.07, duration: 0.35 }}
                >
                  <Card className={`border-2 shadow-sm overflow-hidden hover:shadow-lg transition-shadow duration-300 ${accent.border} bg-gradient-to-br ${accent.gradient}`}>
                    {/* Card Header */}
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`h-11 w-11 rounded-xl flex items-center justify-center ${accent.bg}`}>
                            <PlanIcon className={`h-5 w-5 ${accent.icon}`} />
                          </div>
                          <div>
                            <CardTitle className="text-base font-bold">{getLocalizedDisplayName(plan)}</CardTitle>
                            <div className="flex items-center gap-2 mt-0.5">
                              <Badge className={`text-[9px] px-1.5 py-0 ${accent.badge}`}>
                                {plan.name}
                              </Badge>
                              {!plan.isActive && (
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">
                                  {t('inactive')}
                                </Badge>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-lg"
                            onClick={() => openEditDialog(plan)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 rounded-lg text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                            onClick={() => openDeleteDialog(plan)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {/* Price */}
                      <div className="mt-3 flex items-baseline gap-1">
                        <span className="text-2xl font-bold text-foreground">
                          {plan.price === 0 ? t('free') : plan.price.toLocaleString()}
                        </span>
                        {plan.price > 0 && (
                          <span className="text-sm text-muted-foreground">
                            {plan.currency} / {getBillingCycleLabel(plan.billingCycle).toLowerCase()}
                          </span>
                        )}
                      </div>
                      {getLocalizedDescription(plan) && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{getLocalizedDescription(plan)}</p>
                      )}
                      {/* Period discounts summary (only when at least one is set) */}
                      {(plan.quarterlyDiscount > 0 || plan.semiAnnualDiscount > 0 || plan.annualDiscount > 0 || plan.biennialDiscount > 0) && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {plan.quarterlyDiscount > 0 && (
                            <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                              3{t('months')}: -{plan.quarterlyDiscount}%
                            </Badge>
                          )}
                          {plan.semiAnnualDiscount > 0 && (
                            <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                              6{t('months')}: -{plan.semiAnnualDiscount}%
                            </Badge>
                          )}
                          {plan.annualDiscount > 0 && (
                            <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                              12{t('months')}: -{plan.annualDiscount}%
                            </Badge>
                          )}
                          {plan.biennialDiscount > 0 && (
                            <Badge className="text-[9px] px-1.5 py-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                              24{t('months')}: -{plan.biennialDiscount}%
                            </Badge>
                          )}
                        </div>
                      )}
                    </CardHeader>

                    {/* Card Content - Limits & Features */}
                    <CardContent className="pt-0 space-y-3">
                      {/* Limits */}
                      <div className="grid grid-cols-2 gap-2">
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white/60 dark:bg-gray-800/40">
                          <Package className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-foreground">{plan.maxServices} {t('maxServicesShort')}</span>
                        </div>
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white/60 dark:bg-gray-800/40">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-foreground">{plan.maxBranches} {t('maxBranchesShort')}</span>
                        </div>
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white/60 dark:bg-gray-800/40">
                          <Users className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-foreground">{plan.maxStaff} {t('maxStaffShort')}</span>
                        </div>
                        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-white/60 dark:bg-gray-800/40">
                          <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-foreground">{plan.maxActiveReservations} {t('maxReservationsShort')}</span>
                        </div>
                        <div className="col-span-2 flex items-center gap-1.5 p-2 rounded-lg bg-white/60 dark:bg-gray-800/40">
                          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs text-foreground">{plan.maxSmsPerMonth} {t('maxSmsPerMonthShort')}</span>
                        </div>
                      </div>

                      {/* Feature Toggles */}
                      <div className="space-y-1.5">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{t('features')}</p>
                        <div className="flex flex-wrap gap-1.5">
                          <FeatureBadge enabled={plan.kioskModeEnabled} icon={Monitor} label={t('kioskModeEnabled')} />
                          <FeatureBadge enabled={plan.analyticsEnabled} icon={BarChart3} label={t('analyticsEnabled')} />
                          <FeatureBadge enabled={plan.priorityListing} icon={Star} label={t('priorityListing')} />
                          <FeatureBadge enabled={plan.customBranding} icon={Palette} label={t('customBranding')} />
                          <FeatureBadge enabled={plan.apiAccess} icon={Code} label={t('apiAccess')} />
                        </div>
                      </div>

                      {/* Subscriber count */}
                      <div className="flex items-center justify-between pt-2 border-t border-gray-200/50 dark:border-gray-700/50">
                        <span className="text-[10px] text-muted-foreground">{t('subscribedAgencies')}</span>
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                          {plan._count.agencies} {t('agencies')}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingPlan ? (
                <>
                  <Pencil className="h-5 w-5 text-amber-600" />
                  {t('editPlan')}
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5 text-emerald-600" />
                  {t('createPlan')}
                </>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Basic Info */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                {t('planBasicInfo')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('planName')} *</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="FREE, BASIC, PREMIUM..."
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('displayName')} *</Label>
                  <Input
                    value={formData.displayName}
                    onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                    placeholder={t('displayName')}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('displayNameAr')}</Label>
                  <Input
                    value={formData.displayNameAr}
                    onChange={(e) => setFormData({ ...formData, displayNameAr: e.target.value })}
                    placeholder="الاسم بالعربية"
                    dir="rtl"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('displayNameFr')}</Label>
                  <Input
                    value={formData.displayNameFr}
                    onChange={(e) => setFormData({ ...formData, displayNameFr: e.target.value })}
                    placeholder="Nom en français"
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('description')}</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('description')}
                  className="h-9 text-sm"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('descriptionAr')}</Label>
                  <Input
                    value={formData.descriptionAr}
                    onChange={(e) => setFormData({ ...formData, descriptionAr: e.target.value })}
                    placeholder="الوصف بالعربية"
                    dir="rtl"
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('descriptionFr')}</Label>
                  <Input
                    value={formData.descriptionFr}
                    onChange={(e) => setFormData({ ...formData, descriptionFr: e.target.value })}
                    placeholder="Description en français"
                    className="h-9 text-sm"
                  />
                </div>
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
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: parseInt(e.target.value) || 0 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('billingCycle')}</Label>
                  <select
                    value={formData.billingCycle}
                    onChange={(e) => setFormData({ ...formData, billingCycle: e.target.value })}
                    className="h-9 w-full px-3 rounded-lg border border-border bg-background text-sm"
                  >
                    <option value="MONTHLY">{t('monthly')}</option>
                    <option value="YEARLY">{t('yearly')}</option>
                    <option value="ONE_TIME">{t('oneTime')}</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('sortOrder')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={formData.sortOrder}
                    onChange={(e) => setFormData({ ...formData, sortOrder: parseInt(e.target.value) || 0 })}
                    className="h-9 text-sm"
                  />
                </div>
              </div>

              {/* Period Discounts — admins configure the % off when an agency
                  pays for 3/6/12/24 months upfront. 0 = no discount. */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
                  {t('periodDiscounts')}
                </Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('quarterlyDiscount')}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={formData.quarterlyDiscount}
                      onChange={(e) => setFormData({ ...formData, quarterlyDiscount: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('semiAnnualDiscount')}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={formData.semiAnnualDiscount}
                      onChange={(e) => setFormData({ ...formData, semiAnnualDiscount: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('annualDiscount')}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={formData.annualDiscount}
                      onChange={(e) => setFormData({ ...formData, annualDiscount: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })}
                      className="h-9 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('biennialDiscount')}</Label>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={formData.biennialDiscount}
                      onChange={(e) => setFormData({ ...formData, biennialDiscount: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })}
                      className="h-9 text-sm"
                    />
                  </div>
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
                    value={formData.maxServices}
                    onChange={(e) => setFormData({ ...formData, maxServices: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxBranches')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={formData.maxBranches}
                    onChange={(e) => setFormData({ ...formData, maxBranches: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxStaff')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={formData.maxStaff}
                    onChange={(e) => setFormData({ ...formData, maxStaff: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxReservations')}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={formData.maxActiveReservations}
                    onChange={(e) => setFormData({ ...formData, maxActiveReservations: parseInt(e.target.value) || 1 })}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">{t('maxSmsPerMonth')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={formData.maxSmsPerMonth}
                    onChange={(e) => setFormData({ ...formData, maxSmsPerMonth: parseInt(e.target.value) || 0 })}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
            </div>

            {/* Feature Toggles */}
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
                  checked={formData.kioskModeEnabled}
                  onChange={(v) => setFormData({ ...formData, kioskModeEnabled: v })}
                />
                <FeatureToggle
                  icon={BarChart3}
                  label={t('analyticsEnabled')}
                  description={t('analyticsEnabledDesc')}
                  checked={formData.analyticsEnabled}
                  onChange={(v) => setFormData({ ...formData, analyticsEnabled: v })}
                />
                <FeatureToggle
                  icon={Star}
                  label={t('priorityListing')}
                  description={t('priorityListingDesc')}
                  checked={formData.priorityListing}
                  onChange={(v) => setFormData({ ...formData, priorityListing: v })}
                />
                <FeatureToggle
                  icon={Palette}
                  label={t('customBranding')}
                  description={t('customBrandingDesc')}
                  checked={formData.customBranding}
                  onChange={(v) => setFormData({ ...formData, customBranding: v })}
                />
                <FeatureToggle
                  icon={Code}
                  label={t('apiAccess')}
                  description={t('apiAccessDesc')}
                  checked={formData.apiAccess}
                  onChange={(v) => setFormData({ ...formData, apiAccess: v })}
                />
                <FeatureToggle
                  icon={Check}
                  label={t('active')}
                  description={t('planActiveDesc')}
                  checked={formData.isActive}
                  onChange={(v) => setFormData({ ...formData, isActive: v })}
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="rounded-xl">
              {t('cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="rounded-xl gap-2"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {editingPlan ? t('save') : t('createPlan')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              {t('deletePlan')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t('confirmDeletePlan')}
            {deletingPlan && (
              <span className="font-semibold text-foreground"> {getLocalizedDisplayName(deletingPlan)}</span>
            )}
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} className="rounded-xl">
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-xl gap-2"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function FeatureBadge({ enabled, icon: Icon, label }: { enabled: boolean; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
      enabled
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
        : 'bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500 line-through'
    }`}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

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
