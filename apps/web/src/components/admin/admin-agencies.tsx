'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
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
  Building2,
  Plus,
  Search,
  Ban,
  CheckCircle2,
  Trash2,
  Loader2,
  Filter,
  Clock,
  CalendarClock,
  AlertTriangle,
  Infinity as InfinityIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import type { TranslationKeys } from '@/i18n';
import { translateCategory } from '@/lib/enum-i18n';

interface Agency {
  id: string;
  name: string;
  category: string;
  plan: string;
  status: string;
  // Real fields returned by /api/admin/agencies. The legacy `plan` / `status`
  // aliases above are kept for backward-compat with code that hasn't migrated.
  subscriptionTier?: string;
  subscriptionStatus?: string;
  subscriptionStartsAt?: string | null;
  subscriptionExpiresAt?: string | null;
  createdAt: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
}

const statusOptions = [
  { value: 'ALL', key: 'all' as TranslationKeys },
  { value: 'ACTIVE', key: 'active' as TranslationKeys },
  { value: 'SUSPENDED', key: 'inactive' as TranslationKeys },
];

const categoryOptions: { value: string; key: TranslationKeys }[] = [
  { value: 'CLINIC', key: 'catClinic' },
  { value: 'AGENCY', key: 'catAgency' },
  { value: 'LAW_FIRM', key: 'catLawFirm' },
  { value: 'LABORATORY', key: 'catLaboratory' },
  { value: 'GOVERNMENT', key: 'catGovernment' },
  { value: 'OTHER', key: 'catOther' },
];

export function AdminAgencies() {
  const { t, lang } = useLanguage();
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  // Delete confirmation state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState('CLINIC');
  const [creating, setCreating] = useState(false);

  // Extend subscription dialog state
  const [extendTarget, setExtendTarget] = useState<Agency | null>(null);
  const [extendDays, setExtendDays] = useState(30);
  const [extending, setExtending] = useState(false);

  useEffect(() => {
    fetchAgencies();
  }, []);

  const fetchAgencies = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/agencies');
      if (res.ok) {
        const data = await res.json();
        setAgencies(data.agencies ?? []);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteClick = (id: string) => {
    setDeleteConfirmId(id);
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirmId) return;
    await handleAction(deleteConfirmId, 'delete');
    setDeleteConfirmId(null);
  };

  const handleAction = async (id: string, action: 'suspend' | 'activate' | 'delete') => {
    setActionLoading(`${id}-${action}`);
    try {
      const res = await apiFetch(`/api/admin/agencies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(t('success'));
        fetchAgencies();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    setCreating(true);
    try {
      const res = await apiFetch('/api/admin/agencies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), category: newCategory }),
      });
      if (res.ok) {
        toast.success(t('success'));
        setCreateOpen(false);
        setNewName('');
        fetchAgencies();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCreating(false);
    }
  };

  // ─── Extend subscription ────────────────────────────────────────────────
  // Opens the extend dialog with default 30 days. Quick presets let the admin
  // pick 7 / 30 / 90 / 365 days without typing. The dialog posts to
  // /api/admin/agencies/:id/extend-subscription which extends from the
  // current expiry date (or from now if already expired).
  const openExtendDialog = (agency: Agency) => {
    setExtendTarget(agency);
    setExtendDays(30);
    setExtendOpen(true);
  };

  const [extendOpen, setExtendOpen] = useState(false);

  const handleExtend = async () => {
    if (!extendTarget) return;
    if (isNaN(extendDays) || extendDays <= 0) {
      toast.error(t('requiredField'));
      return;
    }
    setExtending(true);
    try {
      const res = await apiFetch(
        `/api/admin/agencies/${extendTarget.id}/extend-subscription`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days: extendDays }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        toast.success(t('subscriptionExtended'));
        setExtendOpen(false);
        setExtendTarget(null);
        fetchAgencies();
        // Surface the new expiry date for confirmation
        if (data?.subscriptionExpiresAt) {
          try {
            const d = new Date(data.subscriptionExpiresAt).toLocaleDateString(
              lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
              { year: 'numeric', month: 'short', day: 'numeric' },
            );
            toast.info(`${t('currentExpiry')}: ${d}`);
          } catch {
            /* ignore */
          }
        }
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setExtending(false);
    }
  };

  // ─── Expiry helpers ─────────────────────────────────────────────────────
  const getDaysRemaining = (agency: Agency): number | null => {
    if (!agency.subscriptionExpiresAt) return null;
    const diffMs = new Date(agency.subscriptionExpiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  };

  const isExpired = (agency: Agency): boolean => {
    if (!agency.subscriptionExpiresAt) return false;
    return new Date(agency.subscriptionExpiresAt) < new Date();
  };

  const formatExpiryDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return '';
    try {
      return new Date(dateStr).toLocaleDateString(
        lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
        { year: 'numeric', month: 'short', day: 'numeric' },
      );
    } catch {
      return dateStr;
    }
  };

  const filteredAgencies = agencies.filter((a) => {
    const matchStatus = statusFilter === 'ALL' || a.status === statusFilter;
    const matchCategory = categoryFilter === 'ALL' || a.category.toUpperCase() === categoryFilter;
    const query = searchQuery.toLowerCase().trim();
    const matchSearch = !query || a.name.toLowerCase().includes(query);
    return matchStatus && matchCategory && matchSearch;
  });

  const getCategoryLabel = (cat: string) => translateCategory(cat, t);

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('agencyManagement')}</h1>
        <Button
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-9"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4 me-1.5" />
          {t('createAgency')}
        </Button>
      </div>

      {/* Search & Filter */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardContent className="p-4 space-y-3">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ps-10 h-10 rounded-xl"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Category Filters */}
            <button
              onClick={() => setCategoryFilter('ALL')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                categoryFilter === 'ALL'
                  ? 'filter-chip-active'
                  : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {t('all')}
            </button>
            {categoryOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setCategoryFilter(opt.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                  categoryFilter === opt.value
                    ? 'filter-chip-active'
                    : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {t(opt.key)}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            {statusOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={`px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 min-h-10 ${
                  statusFilter === opt.value
                    ? 'bg-emerald-600 text-white shadow-md shadow-emerald-500/20'
                    : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {t(opt.key)}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Agencies List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : filteredAgencies.length === 0 ? (
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardContent className="py-16 text-center">
            <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">{t('noData')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filteredAgencies.map((agency, idx) => (
            <motion.div
              key={agency.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex items-center gap-3 flex-1">
                      <div className={`h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        (agency.subscriptionStatus || agency.status) === 'ACTIVE'
                          ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 shadow-sm'
                          : (agency.subscriptionStatus || agency.status) === 'EXPIRED'
                            ? 'bg-gradient-to-br from-red-200 to-rose-300 dark:from-red-900/40 dark:to-rose-800/40 shadow-sm'
                            : 'bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40 shadow-sm'
                      }`}>
                        <Building2 className={`h-5 w-5 ${
                          (agency.subscriptionStatus || agency.status) === 'ACTIVE'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : (agency.subscriptionStatus || agency.status) === 'EXPIRED'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-600 dark:text-amber-400'
                        }`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {agency.name}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          <Badge variant="secondary" className="text-[10px]">
                            {getCategoryLabel(agency.category)}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {(agency.subscriptionTier || agency.plan || 'BASIC') === 'PREMIUM' ? t('premiumPlan') : t('basicPlan')}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={
                              (agency.subscriptionStatus || agency.status) === 'ACTIVE'
                                ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                                : (agency.subscriptionStatus || agency.status) === 'EXPIRED'
                                  ? 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                                  : (agency.subscriptionStatus || agency.status) === 'PENDING'
                                    ? 'text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200'
                                    : 'text-[10px] bg-gray-50 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200'
                            }
                          >
                            {(agency.subscriptionStatus || agency.status) === 'ACTIVE'
                              ? t('active')
                              : (agency.subscriptionStatus || agency.status) === 'EXPIRED'
                                ? t('expired')
                                : (agency.subscriptionStatus || agency.status) === 'PENDING'
                                  ? t('pending')
                                  : t('inactive')}
                          </Badge>
                          {/* Expiry badge */}
                          {(() => {
                            const expired = isExpired(agency);
                            const days = getDaysRemaining(agency);
                            if (expired) {
                              return (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200"
                                >
                                  <AlertTriangle className="h-2.5 w-2.5 me-0.5" />
                                  {t('expired')}
                                </Badge>
                              );
                            }
                            if (days === null) {
                              // No expiry date set (e.g. ONE_TIME plan, or never activated)
                              if (agency.subscriptionExpiresAt === null) {
                                return (
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400 border-sky-200"
                                  >
                                    <InfinityIcon className="h-2.5 w-2.5 me-0.5" />
                                    {lang === 'ar' ? 'بلا انتهاء' : lang === 'fr' ? 'Illimité' : 'No expiry'}
                                  </Badge>
                                );
                              }
                              return null;
                            }
                            if (days <= 7) {
                              return (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200"
                                >
                                  <Clock className="h-2.5 w-2.5 me-0.5" />
                                  {days} {t('daysRemaining')}
                                </Badge>
                              );
                            }
                            return (
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200"
                              >
                                <Clock className="h-2.5 w-2.5 me-0.5" />
                                {days} {t('daysRemaining')}
                              </Badge>
                            );
                          })()}
                          {agency.subscriptionExpiresAt && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5" dir="ltr">
                              <CalendarClock className="h-2.5 w-2.5" />
                              {formatExpiryDate(agency.subscriptionExpiresAt)}
                            </span>
                          )}
                          {agency.workingHoursStart && agency.workingHoursEnd && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5" dir="ltr">
                              <Clock className="h-2.5 w-2.5" />
                              {agency.workingHoursStart}-{agency.workingHoursEnd}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 sm:ms-auto flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-3 border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800 dark:hover:bg-emerald-900/20"
                        onClick={() => openExtendDialog(agency)}
                        disabled={!!actionLoading || extending}
                        title={t('extendSubscription')}
                      >
                        <CalendarClock className="h-3.5 w-3.5 me-1" />
                        <span className="hidden sm:inline">{t('extendSubscription')}</span>
                      </Button>
                      {(agency.subscriptionStatus || agency.status) === 'ACTIVE' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 border-amber-200 text-amber-600 hover:bg-amber-50 dark:border-amber-800 dark:hover:bg-amber-900/20"
                          onClick={() => handleAction(agency.id, 'suspend')}
                          disabled={!!actionLoading}
                        >
                          <Ban className="h-3.5 w-3.5 me-1" />
                          {t('suspendAgency')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-3 border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800 dark:hover:bg-emerald-900/20"
                          onClick={() => handleAction(agency.id, 'activate')}
                          disabled={!!actionLoading}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 me-1" />
                          {t('active')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 p-0 border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20"
                        onClick={() => handleDeleteClick(agency.id)}
                        disabled={!!actionLoading}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('deleteAgency')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmDeleteAgency')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full rounded-xl h-10">
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create Agency Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('createAgency')}</DialogTitle>
            <DialogDescription className="sr-only">{t('createAgency')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('agencyName')}</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('agencyName')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('agencyCategory')}</Label>
              <Select value={newCategory} onValueChange={setNewCategory}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categoryOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {t(opt.key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 me-1.5" />}
              {t('createAgency')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extend Subscription Dialog */}
      <Dialog
        open={extendOpen}
        onOpenChange={(open) => {
          setExtendOpen(open);
          if (!open) setExtendTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-emerald-600" />
              {t('extendSubscription')}
            </DialogTitle>
            <DialogDescription>{t('extendSubscriptionDesc')}</DialogDescription>
          </DialogHeader>

          {extendTarget && (
            <div className="space-y-4 py-2">
              {/* Agency summary */}
              <div className="rounded-xl border border-border/50 bg-muted/30 p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <p className="text-sm font-semibold text-foreground truncate">{extendTarget.name}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Badge variant="outline" className="text-[10px]">
                    {(extendTarget.subscriptionTier || extendTarget.plan || 'BASIC') === 'PREMIUM'
                      ? t('premiumPlan')
                      : t('basicPlan')}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      (extendTarget.subscriptionStatus || extendTarget.status) === 'ACTIVE'
                        ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                        : (extendTarget.subscriptionStatus || extendTarget.status) === 'EXPIRED'
                          ? 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                          : 'text-[10px] bg-gray-50 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200'
                    }
                  >
                    {(extendTarget.subscriptionStatus || extendTarget.status) === 'ACTIVE'
                      ? t('active')
                      : (extendTarget.subscriptionStatus || extendTarget.status) === 'EXPIRED'
                        ? t('expired')
                        : t('inactive')}
                  </Badge>
                </div>
                <div className="flex items-center justify-between pt-1.5 border-t border-border/30">
                  <span className="text-xs text-muted-foreground">{t('currentExpiry')}</span>
                  <span className="text-xs font-medium text-foreground" dir="ltr">
                    {extendTarget.subscriptionExpiresAt
                      ? formatExpiryDate(extendTarget.subscriptionExpiresAt)
                      : t('noExpirySet')}
                  </span>
                </div>
              </div>

              {/* Days input */}
              <div className="space-y-2">
                <Label>{t('daysToExtend')}</Label>
                <Input
                  type="number"
                  min={1}
                  value={extendDays}
                  onChange={(e) => setExtendDays(parseInt(e.target.value, 10) || 0)}
                  className="h-11"
                />
              </div>

              {/* Quick preset buttons */}
              <div className="grid grid-cols-4 gap-2">
                {[7, 30, 90, 365].map((d) => (
                  <Button
                    key={d}
                    type="button"
                    variant={extendDays === d ? 'default' : 'outline'}
                    size="sm"
                    className={`h-9 ${
                      extendDays === d
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                        : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800 dark:hover:bg-emerald-900/20'
                    }`}
                    onClick={() => setExtendDays(d)}
                  >
                    {d}
                    <span className="text-[10px] ms-0.5 opacity-70">
                      {d === 365
                        ? lang === 'ar'
                          ? 'سنة'
                          : lang === 'fr'
                            ? 'an'
                            : 'y'
                        : lang === 'ar'
                          ? 'ي'
                          : lang === 'fr'
                            ? 'j'
                            : 'd'}
                    </span>
                  </Button>
                ))}
              </div>

              {/* New expiry preview */}
              {extendDays > 0 && (
                <div className="flex items-center justify-between text-xs p-2.5 rounded-lg bg-emerald-50/50 dark:bg-emerald-900/10">
                  <span className="text-muted-foreground">
                    {lang === 'ar' ? 'تاريخ الانتهاء الجديد' : lang === 'fr' ? 'Nouvelle expiration' : 'New expiry'}
                  </span>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400" dir="ltr">
                    {(() => {
                      const base =
                        extendTarget.subscriptionExpiresAt &&
                        new Date(extendTarget.subscriptionExpiresAt) > new Date()
                          ? new Date(extendTarget.subscriptionExpiresAt)
                          : new Date();
                      base.setDate(base.getDate() + extendDays);
                      return formatExpiryDate(base.toISOString());
                    })()}
                  </span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendOpen(false)} disabled={extending}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleExtend}
              disabled={extending || extendDays <= 0}
            >
              {extending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CalendarClock className="h-4 w-4 me-1.5" />
              )}
              {t('extendSubscription')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
