'use client';

import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Search,
  X,
  Clock,
  User,
  Phone,
  Eye,
  ChevronLeft,
  ChevronRight,
  Filter,
  History,
  Loader2,
  Star,
  MonitorCheck,
  CalendarDays,
  Timer,
} from 'lucide-react';
import type { TranslationKeys } from '@/i18n';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HistoryReservation {
  id: string;
  queueNumber: string;
  displayNumber: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  isWalkIn: boolean;
  walkInCustomerName: string | null;
  serviceId: string;
  serviceName: string;
  serviceNameAr: string | null;
  serviceNameFr: string | null;
  joinedAt: string;
  calledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  estimatedWait: number | null;
  serviceDuration: number | null;
  waitDuration: number | null;
  rating: number | null;
  counterId: string | null;
  counterName: string | null;
}

interface ServiceItem {
  id: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
}

interface HistoryResponse {
  reservations: HistoryReservation[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── Status Config ────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  'WAITING',
  'CALLED',
  'SERVING',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

const STATUS_MAP: Record<string, { label: TranslationKeys; className: string }> = {
  WAITING: {
    label: 'statusWaiting',
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  },
  CALLED: {
    label: 'statusCalled',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  },
  SERVING: {
    label: 'statusServed',
    className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800',
  },
  COMPLETED: {
    label: 'statusCompleted',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  },
  CANCELLED: {
    label: 'statusCancelled',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800',
  },
  NO_SHOW: {
    label: 'statusNoShow',
    className: 'bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400 border-gray-200 dark:border-gray-700',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(isoString: string | null): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getLocalizedName(
  obj: { name: string; nameAr?: string | null; nameFr?: string | null },
  lang: string,
): string {
  if (lang === 'ar' && obj.nameAr) return obj.nameAr;
  if (lang === 'fr' && obj.nameFr) return obj.nameFr;
  return obj.name;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AgencyHistorySheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLanguage();
  const { user } = useAppStore();
  const lang = user?.language ?? 'ar';

  // State
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [serviceFilter, setServiceFilter] = useState('ALL');
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [reservations, setReservations] = useState<HistoryReservation[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [detailReservation, setDetailReservation] = useState<HistoryReservation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch services
  const fetchServices = useCallback(async () => {
    try {
      const res = await apiFetch('/api/agency/services');
      if (res.ok) {
        const data = await res.json().catch(() => undefined);
        setServices(data?.services ?? []);
      }
    } catch {
      // silent
    }
  }, []);

  // Fetch history
  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '20',
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (serviceFilter !== 'ALL') params.set('serviceId', serviceFilter);

      const res = await apiFetch(`/api/agency/history?${params}`);
      if (!res.ok) {
        toast.error(t('error'));
        return;
      }
      const data: HistoryResponse | undefined = await res.json().catch(() => undefined);
      setReservations(data?.reservations ?? []);
      setTotalPages(data?.totalPages ?? 1);
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, statusFilter, serviceFilter, t]);

  // Load data when sheet opens
  useEffect(() => {
    if (open) {
      fetchServices();
      fetchHistory();
    } else {
      // Reset when closed
      setSearch('');
      setDebouncedSearch('');
      setStatusFilter('ALL');
      setServiceFilter('ALL');
      setPage(1);
      setReservations([]);
    }
  }, [open, fetchHistory, fetchServices]);

  // Re-fetch when page/filters change
  useEffect(() => {
    if (open) fetchHistory();
  }, [page, debouncedSearch, statusFilter, serviceFilter, open, fetchHistory]);

  // Fetch detail
  const handleViewDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await apiFetch(`/api/agency/history/${id}`);
      if (res.ok) {
        const data = await res.json();
        setDetailReservation(data);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDetailLoading(false);
    }
  };

  const statusConfig = (status: string) =>
    STATUS_MAP[status] ?? {
      label: 'status' as TranslationKeys,
      className: 'bg-gray-100 text-gray-700 dark:bg-gray-800/30 dark:text-gray-400',
    };

  // ── Status pill row ──
  const statusPills = (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
      <button
        onClick={() => { setStatusFilter('ALL'); setPage(1); }}
        className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
          statusFilter === 'ALL'
            ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/20'
            : 'bg-muted text-muted-foreground hover:bg-muted/80'
        }`}
      >
        {t('all')}
      </button>
      {STATUS_OPTIONS.map((s) => {
        const active = statusFilter === s;
        return (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1); }}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
              active
                ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/20'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {t(statusConfig(s).label)}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full max-w-2xl p-0 flex flex-col gap-0 overflow-hidden">
          {/* Header */}
          <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
            <div className="flex items-center justify-between">
              <SheetTitle className="flex items-center gap-2.5 text-lg">
                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <History className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                {t('reservationHistory')}
              </SheetTitle>
            </div>
          </SheetHeader>

          {/* Search */}
          <div className="px-6 pt-4 shrink-0">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('searchHistoryPlaceholder')}
                className="h-10 ps-9 pe-9"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="px-6 pt-3 space-y-3 shrink-0">
            {statusPills}
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Select value={serviceFilter} onValueChange={(v) => { setServiceFilter(v === 'ALL' ? 'ALL' : v); setPage(1); }}>
                <SelectTrigger size="sm" className="w-full max-w-[200px]">
                  <SelectValue placeholder={t('filterByService')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t('allServices')}</SelectItem>
                  {services.map((svc) => (
                    <SelectItem key={svc.id} value={svc.id}>
                      {getLocalizedName(svc, lang)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Scrollable list */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
              </div>
            ) : reservations.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center py-16 text-center"
              >
                <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                  <History className="h-7 w-7 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium text-foreground">{t('noReservationHistory')}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">{t('noReservationHistoryDesc')}</p>
              </motion.div>
            ) : (
              <AnimatePresence mode="popLayout">
                {reservations.map((r, index) => {
                  const sc = statusConfig(r.status);
                  return (
                    <motion.div
                      key={r.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ delay: index * 0.02 }}
                      className="group relative rounded-xl border border-border bg-card hover:bg-accent/40 transition-all duration-200 p-4"
                    >
                      <div className="flex items-start gap-3">
                        {/* Queue Number */}
                        <div className="shrink-0 flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 ring-1 ring-emerald-200/50 dark:ring-emerald-800/30">
                          <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400 leading-tight text-center">
                            {r.displayNumber}
                          </span>
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-foreground truncate">
                              {r.customerName || r.walkInCustomerName || '—'}
                            </span>
                            {r.isWalkIn && (
                              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                                {t('walkIn')}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            {r.customerPhone && (
                              <span className="flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {r.customerPhone}
                              </span>
                            )}
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatTime(r.joinedAt)}
                            </span>
                          </div>

                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={sc.className}>
                              {t(sc.label)}
                            </Badge>
                            <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                              {getLocalizedName({ name: r.serviceName, nameAr: r.serviceNameAr, nameFr: r.serviceNameFr }, lang)}
                            </span>
                            {r.serviceDuration != null && (
                              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                                <Timer className="h-3 w-3" />
                                {r.serviceDuration} {t('min')}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Eye button */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity"
                          onClick={() => handleViewDetail(r.id)}
                          disabled={detailLoading}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="shrink-0 px-6 py-3 border-t border-border flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t('page')} {page} {t('of')} {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="h-4 w-4 me-1 rtl:rotate-180" />
                  {t('prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-3"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('next')}
                  <ChevronRight className="h-4 w-4 ms-1 rtl:rotate-180" />
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Detail Dialog */}
      <Dialog open={!!detailReservation} onOpenChange={(open) => { if (!open) setDetailReservation(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-emerald-500" />
              {t('reservationDetail')}
            </DialogTitle>
            <DialogDescription>
              {detailReservation?.displayNumber}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
            </div>
          ) : detailReservation ? (
            <div className="space-y-4 pt-2">
              {/* Status badge + walk-in */}
              <div className="flex items-center gap-2 flex-wrap">
                <Badge className={statusConfig(detailReservation.status).className}>
                  {t(statusConfig(detailReservation.status).label)}
                </Badge>
                {detailReservation.isWalkIn && (
                  <Badge variant="outline" className="bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800">
                    {t('walkIn')}
                  </Badge>
                )}
              </div>

              {/* Customer Info */}
              <div className="rounded-xl border border-border p-4 space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  {t('customerInfo')}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('fullName') || 'Name'}</p>
                    <p className="text-sm font-medium text-foreground">
                      {detailReservation.customerName || detailReservation.walkInCustomerName || t('na')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('phoneNumber')}</p>
                    <p className="text-sm font-medium text-foreground">
                      {detailReservation.customerPhone || t('na')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('queueNumber')}</p>
                    <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
                      {detailReservation.displayNumber}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Type</p>
                    <p className="text-sm font-medium text-foreground">
                      {detailReservation.isWalkIn ? t('walkIn') : t('registered')}
                    </p>
                  </div>
                </div>
              </div>

              {/* Service Info */}
              <div className="rounded-xl border border-border p-4 space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <MonitorCheck className="h-3.5 w-3.5" />
                  {t('serviceInfo')}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('serviceName')}</p>
                    <p className="text-sm font-medium text-foreground">
                      {getLocalizedName({ name: detailReservation.serviceName, nameAr: detailReservation.serviceNameAr, nameFr: detailReservation.serviceNameFr }, lang)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('counter')}</p>
                    <p className="text-sm font-medium text-foreground">
                      {detailReservation.counterName || t('na')}
                    </p>
                  </div>
                  {detailReservation.rating != null && (
                    <div>
                      <p className="text-[11px] text-muted-foreground">{t('rating')}</p>
                      <p className="text-sm font-medium text-foreground flex items-center gap-1">
                        <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                        {detailReservation.rating}/5
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Timing Info */}
              <div className="rounded-xl border border-border p-4 space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {t('timingInfo')}
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('joinedTime')}</p>
                    <p className="text-sm font-medium text-foreground">{formatTime(detailReservation.joinedAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('calledTime')}</p>
                    <p className="text-sm font-medium text-foreground">{formatTime(detailReservation.calledAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('completedTime')}</p>
                    <p className="text-sm font-medium text-foreground">{formatTime(detailReservation.completedAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('cancelledTime')}</p>
                    <p className="text-sm font-medium text-foreground">{formatTime(detailReservation.cancelledAt)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('waitDuration')}</p>
                    <p className="text-sm font-medium text-foreground">
                      {detailReservation.waitDuration != null ? `${detailReservation.waitDuration} ${t('min')}` : t('na')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">{t('serviceDuration')}</p>
                    <p className="text-sm font-medium text-foreground">
                      {detailReservation.serviceDuration != null ? `${detailReservation.serviceDuration} ${t('min')}` : t('na')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}