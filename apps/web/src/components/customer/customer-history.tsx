'use client';
/**
 * Customer History — Task 79-b rebuild (Design System v2).
 *
 * Logic preserved 1:1 from the previous 992-line implementation:
 *  - GET /api/reservations/history?userId=… (fetchWithRetry)
 *  - GET /api/user/customer/service-stats?agencyId=… (+ live serving timer)
 *  - Status filter tabs (ALL / COMPLETED / CANCELLED / NO_SHOW) + date-range chips
 *  - Date grouping (today / yesterday / this week / earlier)
 *  - Rejoin flow with Calendar date dialog → POST /api/reservations → setView('customer-queue')
 *  - Rating flow via shared RatingDialog (Rate action on un-rated COMPLETED rows)
 *  - Loading / error / empty states
 * Visual: compact header + chips, single compact card per reservation with
 * inline expansion for details (no two-card stack, no heavy animations).
 */
import { apiFetch } from "@/lib/api-fetch";
// Task 84 — IndexedDB stale-while-revalidate: history renders instantly from
// the last-known list and refreshes silently.
import { cacheGet, cacheSet, cacheKeyFor } from '@/lib/local-cache';
import { toLocalDateString } from '@/lib/date-utils';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Calendar } from '@/components/ui/calendar';
import { QueueStatusBadge } from '@/components/shared/queue-status-badge';
import {
  TicketCheck,
  CalendarDays,
  RotateCcw,
  Loader2,
  Calendar as CalendarIcon,
  Star,
  Clock,
  CheckCircle2,
  XCircle,
  History as HistoryIcon,
  MessageSquare,
  Timer,
  ChevronDown,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';
import { RatingDialog } from '@/components/shared/rating-dialog';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';

interface HistoryItem {
  id: string;
  queueNumber: string;
  status: string;
  agencyId: string;
  serviceId: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  joinedAt: string;
  completedAt?: string;
  calledAt?: string;
  estimatedWait?: number | null;
  rating?: number | null;
  feedback?: string | null;
  ratedAt?: string | null;
}

type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

const statusFilters: { key: TranslationKeys; value: string }[] = [
  { key: 'all', value: 'ALL' },
  { key: 'completed', value: 'COMPLETED' },
  { key: 'cancelled', value: 'CANCELLED' },
  { key: 'statusNoShow', value: 'NO_SHOW' },
];

// Color-coded status chips: emerald for served, rose for cancelled, amber for no-show
const statusChipConfig: Record<string, { chip: string; icon: typeof CheckCircle2; labelKey: TranslationKeys }> = {
  WAITING: { chip: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400', icon: Clock, labelKey: 'statusNoShow' },
  CALLED: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400', icon: CheckCircle2, labelKey: 'completed' },
  COMPLETED: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400', icon: CheckCircle2, labelKey: 'statusServed' },
  SERVED: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400', icon: CheckCircle2, labelKey: 'statusServed' },
  CANCELLED: { chip: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-400', icon: XCircle, labelKey: 'statusCancelled' },
  NO_SHOW: { chip: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400', icon: XCircle, labelKey: 'statusNoShow' },
};

export function CustomerHistory() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [dateRangeFilter, setDateRangeFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Rating dialog state
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);
  const [ratingItem, setRatingItem] = useState<HistoryItem | null>(null);

  // Date picker state for rejoin
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [pendingRejoinItem, setPendingRejoinItem] = useState<HistoryItem | null>(null);
  const [joining, setJoining] = useState(false);

  // Service duration stats state
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [serviceStats, setServiceStats] = useState<any>(null);
  const [serviceStatsLoading, setServiceStatsLoading] = useState(false);
  const [selectedStatsAgencyId, setSelectedStatsAgencyId] = useState<string>('');
  const [liveDurationSec, setLiveDurationSec] = useState(0);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    if (!user?.id) return;
    setLoading(true);
    setFetchError(false);
    // Task 84 — shared row mapper for the network payload AND the cached paint.
    // Rows are loosely typed (any-fielded) exactly like the original network
    // path (res.json() → any) — the shape contract lives in HistoryItem.
    const mapHistoryRows = (data: { reservations?: any[] }): HistoryItem[] =>
      (data.reservations ?? []).map((r: Record<string, any>) => {
        const agency = r.agency as Record<string, string> | undefined;
        const service = r.service as Record<string, string> | undefined;
        return {
          id: r.id,
          queueNumber: r.displayNumber || `${r.queueNumber}`,
          status: r.status,
          agencyId: r.agencyId || agency?.id || '',
          serviceId: r.serviceId || service?.id || '',
          agencyName: agency?.name || t('defaultAgency'),
          agencyNameAr: agency?.nameAr,
          agencyNameFr: agency?.nameFr,
          serviceName: service?.name || t('defaultService'),
          serviceNameAr: service?.nameAr,
          serviceNameFr: service?.nameFr,
          joinedAt: r.joinedAt,
          completedAt: r.completedAt,
          calledAt: r.calledAt,
          estimatedWait: (r.estimatedWait as number | null | undefined) ?? null,
          rating: (r.rating as number | null | undefined) ?? null,
          feedback: (r.feedback as string | null | undefined) ?? null,
          ratedAt: (r.ratedAt as string | null | undefined) ?? null,
        };
      });
    const historyKey = cacheKeyFor('/api/reservations/history', { userId: user.id });
    const cachedHistory = await cacheGet<{ reservations?: Array<Record<string, unknown>> }>(historyKey);
    if (cachedHistory?.data?.reservations?.length) {
      setHistory(mapHistoryRows(cachedHistory.data));
      setLoading(false);
    }
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/reservations/history?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        void cacheSet(historyKey, data);
        setHistory(mapHistoryRows(data));
      } else if (!cachedHistory?.data?.reservations?.length) {
        setFetchError(true);
        toast.error(t('error'));
      }
    } catch {
      if (!cachedHistory?.data?.reservations?.length) {
        setFetchError(true);
        toast.error(t('error'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Get unique agencies from history for stats dropdown
  const agencyList = useMemo(() => {
    const map = new Map<string, { id: string; name: string; nameAr?: string; nameFr?: string }>();
    history.forEach((h) => {
      if (!map.has(h.agencyId)) {
        map.set(h.agencyId, { id: h.agencyId, name: h.agencyName, nameAr: h.agencyNameAr, nameFr: h.agencyNameFr });
      }
    });
    return Array.from(map.values());
  }, [history]);

  // Auto-select first agency for stats
  useEffect(() => {
    if (agencyList.length > 0 && !selectedStatsAgencyId) {
      setSelectedStatsAgencyId(agencyList[0].id);
    }
  }, [agencyList, selectedStatsAgencyId]);

  // Fetch service duration stats for selected agency
  useEffect(() => {
    if (!selectedStatsAgencyId) return;
    const fetchStats = async () => {
      setServiceStatsLoading(true);
      try {
        const res = await apiFetch(`/api/user/customer/service-stats?agencyId=${encodeURIComponent(selectedStatsAgencyId)}`);
        if (res.ok) {
          const data = await res.json();
          setServiceStats(data);
          // Start live timer if currently serving
          if (data.currentServing?.calledAt) {
            const calledTime = new Date(data.currentServing.calledAt).getTime();
            const update = () => setLiveDurationSec(Math.floor((Date.now() - calledTime) / 1000));
            update();
            if (liveTimerRef.current) clearInterval(liveTimerRef.current);
            liveTimerRef.current = setInterval(update, 1000);
          } else {
            setLiveDurationSec(0);
            if (liveTimerRef.current) clearInterval(liveTimerRef.current);
          }
        }
      } catch { /* silent */ }
      finally { setServiceStatsLoading(false); }
    };
    fetchStats();
    return () => { if (liveTimerRef.current) clearInterval(liveTimerRef.current); };
  }, [selectedStatsAgencyId]);

  const formatDuration = (mins: number) => {
    const m = Math.floor(mins);
    const s = Math.round((mins - m) * 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  };

  const liveDurationDisplay = useMemo(() => {
    const m = Math.floor(liveDurationSec / 60);
    const s = liveDurationSec % 60;
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }, [liveDurationSec]);

  const handleRejoin = (item: HistoryItem) => {
    setPendingRejoinItem(item);
    setSelectedDate(undefined);
    setDateDialogOpen(true);
  };

  const confirmRejoin = async () => {
    if (!user?.id || !pendingRejoinItem) return;
    setJoining(true);
    try {
      const body: Record<string, string> = {
        userId: user.id,
        agencyId: pendingRejoinItem.agencyId,
        serviceId: pendingRejoinItem.serviceId,
      };
      if (selectedDate) {
        const today = new Date();
        const isToday = selectedDate.getFullYear() === today.getFullYear()
          && selectedDate.getMonth() === today.getMonth()
          && selectedDate.getDate() === today.getDate();
        if (!isToday) {
          body.reservedDate = toLocalDateString(selectedDate);
        }
      }
      const res = await apiFetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('joinSuccess'));
        setDateDialogOpen(false);
        setPendingRejoinItem(null);
        setView('customer-queue');
      } else {
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setJoining(false);
    }
  };

  // Filter history based on selected tab + date range
  const filtered = useMemo(
    () => {
      let result = filter === 'ALL' ? history : history.filter((h) => h.status === filter);
      if (dateRangeFilter !== 'all') {
        const now = new Date();
        let cutoff: Date;
        switch (dateRangeFilter) {
          case '7days': cutoff = new Date(now.getTime() - 7 * 86400000); break;
          case '30days': cutoff = new Date(now.getTime() - 30 * 86400000); break;
          case '3months': cutoff = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); break;
          default: cutoff = new Date(0);
        }
        result = result.filter((h) => new Date(h.joinedAt) >= cutoff);
      }
      return result;
    },
    [filter, history, dateRangeFilter]
  );

  // Calculate stats
  const stats = useMemo(() => {
    const totalVisits = history.length;
    const completedCount = history.filter((h) => h.status === 'COMPLETED' || h.status === 'SERVED').length;
    const cancelledCount = history.filter((h) => h.status === 'CANCELLED').length;
    const waitTimes = history
      .filter((h) => h.estimatedWait != null)
      .map((h) => h.estimatedWait as number);
    const avgWait = waitTimes.length > 0
      ? Math.round(waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length)
      : 0;
    return { totalVisits, completedCount, cancelledCount, avgWait };
  }, [history]);

  const getAgencyName = (item: HistoryItem) => {
    if (lang === 'ar' && item.agencyNameAr) return item.agencyNameAr;
    if (lang === 'fr' && item.agencyNameFr) return item.agencyNameFr;
    return item.agencyName;
  };

  const getServiceName = (item: HistoryItem) => {
    if (lang === 'ar' && item.serviceNameAr) return item.serviceNameAr;
    if (lang === 'fr' && item.serviceNameFr) return item.serviceNameFr;
    return item.serviceName;
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  const formatTime = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const canRejoin = (status: string) => {
    return ['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(status);
  };

  const handleRateItem = (item: HistoryItem) => {
    setRatingItem(item);
    setRatingDialogOpen(true);
  };

  const handleRatingSubmitted = () => {
    fetchHistory();
  };

  // Date grouping logic
  const getDateGroup = (dateStr: string): DateGroup => {
    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);

    const itemDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (itemDate.getTime() === today.getTime()) return 'today';
    if (itemDate.getTime() === yesterday.getTime()) return 'yesterday';
    if (itemDate >= weekStart) return 'thisWeek';
    return 'earlier';
  };

  const getDateGroupLabel = (group: DateGroup): string => {
    switch (group) {
      case 'today': return t('today');
      case 'yesterday': return t('historyYesterday');
      case 'thisWeek': return t('thisWeek');
      case 'earlier': return t('historyEarlier');
    }
  };

  // Group filtered items by date
  const groupedItems = useMemo(() => {
    const groups: Record<DateGroup, HistoryItem[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      earlier: [],
    };

    filtered.forEach((item) => {
      const group = getDateGroup(item.joinedAt);
      groups[group].push(item);
    });

    return groups;
  }, [filtered, lang]);

  const dateGroupOrder: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier'];

  // Star rating display
  const StarRating = ({ rating }: { rating: number }) => (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`h-3 w-3 ${
            star <= rating
              ? 'fill-amber-400 text-amber-400'
              : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'
          }`}
        />
      ))}
    </div>
  );

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Compact header + stat chips */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex flex-wrap items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
              <HistoryIcon className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-foreground leading-tight">{t('history')}</h1>
              <p className="text-xs text-muted-foreground">{t('reservations')}</p>
            </div>
          </div>
          {!loading && history.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] font-semibold text-foreground">
                <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                {stats.completedCount}/{stats.totalVisits}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] font-semibold text-foreground">
                <Clock className="h-3 w-3 text-teal-600 dark:text-teal-400" />
                {stats.avgWait > 0 ? `~${stats.avgWait}${t('min')}` : '—'}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-[11px] font-semibold text-foreground">
                <XCircle className="h-3 w-3 text-rose-500" />
                {stats.cancelledCount}
              </span>
            </div>
          )}
        </motion.div>

        {/* Filter chips: status tabs + date range */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: 0.05 }}
          className="space-y-2"
        >
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {statusFilters.map((f) => {
              const active = filter === f.value;
              return (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/25'
                      : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(f.key)}
                </button>
              );
            })}
          </div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {[
              { key: 'all', label: t('allTime') },
              { key: '7days', label: t('last7Days') },
              { key: '30days', label: t('last30Days') },
              { key: '3months', label: t('last3Months') },
            ].map((opt) => {
              const active = dateRangeFilter === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => setDateRangeFilter(opt.key)}
                  className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                    active
                      ? 'border-teal-500/50 bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-400'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <CalendarIcon className="h-3 w-3" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </motion.div>

        {/* ─── Service Duration Stats (collapsible, preserved) ─── */}
        {agencyList.length > 0 && (
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden">
            <button
              onClick={() => setStatsExpanded(!statsExpanded)}
              className="w-full flex items-center justify-between p-3 hover:bg-muted/40 transition-colors"
              aria-expanded={statsExpanded}
            >
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-teal-500 flex items-center justify-center shrink-0">
                  <Timer className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="text-sm font-semibold text-foreground">{t('serviceDurationStats')}</span>
              </div>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${statsExpanded ? 'rotate-180' : ''}`} />
            </button>
            {statsExpanded && (
              <div className="px-3 pb-3 space-y-3 border-t border-border/60 pt-3">
                {agencyList.length > 1 && (
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                    {agencyList.map((agency) => (
                      <button
                        key={agency.id}
                        onClick={() => setSelectedStatsAgencyId(agency.id)}
                        className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                          selectedStatsAgencyId === agency.id
                            ? 'bg-emerald-600 text-white'
                            : 'bg-muted/60 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {lang === 'ar' && agency.nameAr ? agency.nameAr : lang === 'fr' && agency.nameFr ? agency.nameFr : agency.name}
                      </button>
                    ))}
                  </div>
                )}

                {serviceStatsLoading ? (
                  <div className="grid grid-cols-3 gap-2">
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-16 rounded-xl" />
                    ))}
                  </div>
                ) : serviceStats ? (
                  <div className="space-y-3">
                    {/* Live serving indicator */}
                    {serviceStats.currentServing && (
                      <div className="rounded-xl bg-emerald-600 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[10px] text-emerald-100 font-semibold uppercase">{t('currentlyServing')}</p>
                            <p className="text-white font-bold text-sm truncate">{serviceStats.currentServing.queueNumber} · {serviceStats.currentServing.serviceName}</p>
                          </div>
                          <div className="text-end shrink-0">
                            <div className="flex items-center gap-1 justify-end">
                              <Timer className="h-4 w-4 text-white/80" />
                              <span className="text-lg font-bold text-white tabular-nums" dir="ltr">{liveDurationDisplay}</span>
                            </div>
                            <p className="text-[10px] text-emerald-100">{t('liveServiceTime')}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Duration grid */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 p-2.5 text-center">
                        <p className="text-[9px] text-muted-foreground font-medium">Last 1</p>
                        <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400" dir="ltr">
                          {serviceStats.recentDurations?.last1 ? formatDuration(serviceStats.recentDurations.last1[0]) : '—'}
                        </p>
                      </div>
                      <div className="rounded-xl bg-teal-50 dark:bg-teal-900/20 p-2.5 text-center">
                        <p className="text-[9px] text-muted-foreground font-medium">Last 3</p>
                        <p className="text-sm font-bold text-teal-700 dark:text-teal-400" dir="ltr">
                          {serviceStats.recentDurations?.last3
                            ? formatDuration(serviceStats.recentDurations.last3.reduce((a: number, b: number) => a + b, 0) / serviceStats.recentDurations.last3.length)
                            : '—'}
                        </p>
                      </div>
                      <div className="rounded-xl bg-cyan-50 dark:bg-cyan-900/20 p-2.5 text-center">
                        <p className="text-[9px] text-muted-foreground font-medium">Last 5</p>
                        <p className="text-sm font-bold text-cyan-700 dark:text-cyan-400" dir="ltr">
                          {serviceStats.recentDurations?.last5
                            ? formatDuration(serviceStats.recentDurations.last5.reduce((a: number, b: number) => a + b, 0) / serviceStats.recentDurations.last5.length)
                            : '—'}
                        </p>
                      </div>
                      <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 p-2.5 text-center">
                        <p className="text-[9px] text-muted-foreground font-medium">Last 10</p>
                        <p className="text-sm font-bold text-amber-700 dark:text-amber-400" dir="ltr">
                          {serviceStats.recentDurations?.last10
                            ? formatDuration(serviceStats.recentDurations.last10.reduce((a: number, b: number) => a + b, 0) / serviceStats.recentDurations.last10.length)
                            : '—'}
                        </p>
                      </div>
                      <div className="rounded-xl bg-rose-50 dark:bg-rose-900/20 p-2.5 text-center">
                        <p className="text-[9px] text-muted-foreground font-medium">Average</p>
                        <p className="text-sm font-bold text-rose-700 dark:text-rose-400" dir="ltr">
                          {serviceStats.recentDurations?.averageAll ? formatDuration(serviceStats.recentDurations.averageAll) : '—'}
                        </p>
                      </div>
                      <div className="rounded-xl bg-muted/50 p-2.5 text-center">
                        <p className="text-[9px] text-muted-foreground font-medium">Total</p>
                        <p className="text-sm font-bold text-foreground">{serviceStats.totalCompleted ?? 0}</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-3">{t('noStatsAvailable')}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* History list */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-3 flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-xl shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/5 rounded" />
                  <Skeleton className="h-3 w-3/5 rounded" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : fetchError ? (
          <ErrorState onRetry={fetchHistory} />
        ) : filtered.length === 0 ? (
          <EmptyState
            iconComponent={HistoryIcon}
            title={t('emptyNoHistoryTitle')}
            description={t('emptyNoHistoryDesc')}
            actionLabel={t('emptyNoHistoryAction') || t('browseAgencies')}
            onAction={() => setView('customer-home')}
            actionIcon={<TicketCheck className="h-4 w-4" />}
          />
        ) : (
          <div key={filter} className="space-y-5">
            {dateGroupOrder.map((group) => {
              const items = groupedItems[group];
              if (items.length === 0) return null;

              return (
                <div key={group}>
                  {/* Date group header */}
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-semibold text-foreground">{getDateGroupLabel(group)}</h3>
                    <span className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-full">{items.length}</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  {/* Compact single-card rows */}
                  <div className="space-y-2">
                    {items.map((item) => {
                      const chip = statusChipConfig[item.status] ?? statusChipConfig.CANCELLED;
                      const ChipIcon = chip.icon;
                      const expanded = expandedId === item.id;

                      return (
                        <motion.div
                          key={item.id}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.25 }}
                          className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden"
                        >
                          {/* Row header (tap to expand) */}
                          <button
                            className="w-full text-start p-3 flex items-center gap-3 hover:bg-muted/40 transition-colors"
                            onClick={() => setExpandedId(expanded ? null : item.id)}
                            aria-expanded={expanded}
                          >
                            <div className="h-9 min-w-9 px-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 whitespace-nowrap" dir="ltr">
                                {item.queueNumber}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <p className="text-sm font-semibold text-foreground truncate">{getAgencyName(item)}</p>
                              </div>
                              <p className="text-xs text-muted-foreground truncate">{getServiceName(item)}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <QueueStatusBadge status={item.status} compact />
                              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                            </div>
                          </button>

                          {/* Expanded details */}
                          {expanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="px-3 pb-3 pt-0 space-y-3 border-t border-border/60">
                                {/* Color-coded status chip + date/time */}
                                <div className="flex flex-wrap items-center gap-2 pt-2.5">
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${chip.chip}`}>
                                    <ChipIcon className="h-2.5 w-2.5" />
                                    {t(chip.labelKey)}
                                  </span>
                                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                    <CalendarIcon className="h-3 w-3" />
                                    {formatDate(item.joinedAt)}
                                  </span>
                                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                    <Clock className="h-3 w-3" />
                                    {formatTime(item.joinedAt)}
                                  </span>
                                  {item.estimatedWait != null && item.estimatedWait > 0 && (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                      <Timer className="h-3 w-3" />
                                      ~{item.estimatedWait}{t('min')}
                                    </span>
                                  )}
                                </div>

                                {/* Receipt-style details */}
                                <div className="rounded-xl bg-muted/50 dark:bg-gray-800/50 p-2.5 space-y-1.5 text-xs">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-muted-foreground">{t('joinedAt')}</span>
                                    <span className="font-medium text-foreground" dir="ltr">{formatDate(item.joinedAt)}</span>
                                  </div>
                                  {item.completedAt && (
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="text-muted-foreground">{t('completedAt')}</span>
                                      <span className="font-medium text-foreground" dir="ltr">{formatDate(item.completedAt)}</span>
                                    </div>
                                  )}
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-muted-foreground">{t('service')}</span>
                                    <span className="font-medium text-foreground truncate">{getServiceName(item)}</span>
                                  </div>
                                </div>

                                {/* Rating display / Rate action */}
                                {item.status === 'COMPLETED' && item.rating && (
                                  <div className="flex items-center gap-2">
                                    <StarRating rating={item.rating} />
                                    <span className="text-xs text-muted-foreground" dir="ltr">{item.rating}/5</span>
                                  </div>
                                )}
                                {item.status === 'COMPLETED' && item.feedback && (
                                  <p className="text-xs text-muted-foreground italic line-clamp-3">“{item.feedback}”</p>
                                )}
                                {item.status === 'COMPLETED' && !item.rating && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 rounded-xl text-[11px] border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 px-3"
                                    onClick={() => handleRateItem(item)}
                                  >
                                    <MessageSquare className="h-3 w-3 me-1" />
                                    {t('rateNow')}
                                  </Button>
                                )}

                                {/* Rejoin action */}
                                {canRejoin(item.status) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 rounded-xl text-[11px] border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 px-3"
                                    onClick={() => handleRejoin(item)}
                                    disabled={!!joining}
                                  >
                                    {joining && pendingRejoinItem?.id === item.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin me-1" />
                                    ) : (
                                      <RotateCcw className="h-3 w-3 me-1" />
                                    )}
                                    {t('bookAgain')}
                                  </Button>
                                )}
                              </div>
                            </motion.div>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Rating Dialog (preserved flow) */}
        {ratingItem && (
          <RatingDialog
            open={ratingDialogOpen}
            onOpenChange={setRatingDialogOpen}
            agencyName={getAgencyName(ratingItem)}
            serviceName={getServiceName(ratingItem)}
            agencyId={ratingItem.agencyId}
            userId={user?.id || ''}
            reservationId={ratingItem.id}
            onSubmitted={handleRatingSubmitted}
          />
        )}

        {/* Date Picker Dialog for Rejoin (preserved flow) */}
        <Dialog open={dateDialogOpen} onOpenChange={(open) => { setDateDialogOpen(open); if (!open) { setPendingRejoinItem(null); setSelectedDate(undefined); } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-emerald-600" />
                {t('reserveForDate')}
              </DialogTitle>
              <DialogDescription className="sr-only">{t('selectDate')}</DialogDescription>
            </DialogHeader>
            <div className="py-2">
              <p className="text-sm text-muted-foreground mb-4">{t('selectDate')}</p>
              <div className="flex justify-center">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={setSelectedDate}
                  disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
                  className="rounded-xl border"
                />
              </div>
              <div className="flex gap-2 mt-4 justify-center">
                <Button variant="outline" size="sm" className="rounded-xl h-9" onClick={() => setSelectedDate(undefined)}>
                  {t('today')}
                </Button>
                <Button variant="outline" size="sm" className="rounded-xl h-9" onClick={() => {
                  const tomorrow = new Date();
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  setSelectedDate(tomorrow);
                }}>
                  {t('tomorrow')}
                </Button>
              </div>
              {selectedDate && (
                <div className="mt-3 text-center">
                  <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                    {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                  </p>
                </div>
              )}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={() => { setDateDialogOpen(false); setPendingRejoinItem(null); setSelectedDate(undefined); }} className="rounded-xl h-10">
                {t('cancel')}
              </Button>
              <Button onClick={confirmRejoin} disabled={joining} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10">
                {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
                {t('joinQueue')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
