'use client';
import { apiFetch } from "@/lib/api-fetch";
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  TrendingUp,
  History as HistoryIcon,
  MessageSquare,
  Sparkles,
  Timer,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
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

// Status dot colors for timeline — color-coded: emerald for served, rose for cancelled, amber for no-show
const statusDotConfig: Record<string, { bg: string; ring: string; icon: typeof CheckCircle2; badgeBg: string; badgeText: string; labelKey: TranslationKeys }> = {
  WAITING: { bg: 'bg-amber-500', ring: 'ring-amber-200 dark:ring-amber-800', icon: Clock, badgeBg: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800', badgeText: 'text-amber-700 dark:text-amber-400', labelKey: 'statusNoShow' },
  CALLED: { bg: 'bg-emerald-500', ring: 'ring-emerald-200 dark:ring-emerald-800', icon: CheckCircle2, badgeBg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800', badgeText: 'text-emerald-700 dark:text-emerald-400', labelKey: 'completed' },
  COMPLETED: { bg: 'bg-emerald-500', ring: 'ring-emerald-200 dark:ring-emerald-800', icon: CheckCircle2, badgeBg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800', badgeText: 'text-emerald-700 dark:text-emerald-400', labelKey: 'statusServed' },
  SERVED: { bg: 'bg-emerald-500', ring: 'ring-emerald-200 dark:ring-emerald-800', icon: CheckCircle2, badgeBg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800', badgeText: 'text-emerald-700 dark:text-emerald-400', labelKey: 'statusServed' },
  CANCELLED: { bg: 'bg-rose-500', ring: 'ring-rose-200 dark:ring-rose-800', icon: XCircle, badgeBg: 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800', badgeText: 'text-rose-700 dark:text-rose-400', labelKey: 'statusCancelled' },
  NO_SHOW: { bg: 'bg-amber-500', ring: 'ring-amber-200 dark:ring-amber-800', icon: XCircle, badgeBg: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800', badgeText: 'text-amber-700 dark:text-amber-400', labelKey: 'statusNoShow' },
};

export function CustomerHistory() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [dateRangeFilter, setDateRangeFilter] = useState<string>('all');

  // Rating dialog state
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);
  const [ratingItem, setRatingItem] = useState<HistoryItem | null>(null);

  // Date picker state for rejoin
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [pendingRejoinItem, setPendingRejoinItem] = useState<HistoryItem | null>(null);
  const [joining, setJoining] = useState(false);

  // Service duration stats state
  const [statsExpanded, setStatsExpanded] = useState(true);
  const [serviceStats, setServiceStats] = useState<any>(null);
  const [serviceStatsLoading, setServiceStatsLoading] = useState(false);
  const [selectedStatsAgencyId, setSelectedStatsAgencyId] = useState<string>('');
  const [liveDurationSec, setLiveDurationSec] = useState(0);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    if (!user?.id) return;
    setLoading(true);
    setFetchError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/reservations/history?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        const list = (data.reservations ?? []).map((r: Record<string, unknown>) => {
          const agency = r.agency as Record<string, string> | undefined;
          const service = r.service as Record<string, string> | undefined;
          return {
            id: r.id,
            queueNumber: r.displayNumber || `${r.queueNumber}`,
            status: r.status,
            agencyId: (r as Record<string, unknown>).agencyId || agency?.id || '',
            serviceId: (r as Record<string, unknown>).serviceId || service?.id || '',
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
        setHistory(list);
      } else {
        setFetchError(true);
        toast.error(t('error'));
      }
    } catch {
      setFetchError(true);
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

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
          body.reservedDate = selectedDate.toISOString().split('T')[0];
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

  // Filter history based on selected tab
  const filtered = useMemo(
    () => {
      let result = filter === 'ALL' ? history : history.filter((h) => h.status === filter);
      // Apply date range filter
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

  const getDateGroupIcon = (group: DateGroup) => {
    switch (group) {
      case 'today': return '📅';
      case 'yesterday': return '📆';
      case 'thisWeek': return '📊';
      case 'earlier': return '🗂️';
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
  }, [filtered]);

  const dateGroupOrder: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier'];

  // Stagger animation variants
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.06,
        delayChildren: 0.1,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 15, scale: 0.97 },
    visible: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: { duration: 0.3, ease: 'easeOut' },
    },
  };

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
    <div className="px-4 py-4 pb-24">
      {/* Gradient Header Section */}
      <div className="relative mb-6 overflow-hidden rounded-2xl">
        {/* Gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-600 via-teal-600 to-emerald-700 dark:from-emerald-900 dark:via-teal-900 dark:to-emerald-950" />
        {/* Decorative pattern */}
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.3) 1px, transparent 0)`,
          backgroundSize: '20px 20px',
        }} />
        {/* Animated gradient orb */}
        <motion.div
          animate={{ x: [0, 30, 0], y: [0, -15, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-0 end-0 w-32 h-32 bg-white/10 rounded-full blur-2xl"
        />
        <motion.div
          animate={{ x: [0, -20, 0], y: [0, 20, 0] }}
          transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
          className="absolute bottom-0 start-0 w-40 h-40 bg-teal-400/10 rounded-full blur-2xl"
        />

        <div className="relative p-5">
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="flex items-center gap-3 mb-4"
          >
            <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <HistoryIcon className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">{t('history')}</h1>
              <p className="text-xs text-emerald-100/80">{t('reservations')}</p>
            </div>
            <motion.div
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="ms-auto"
            >
              <Sparkles className="h-5 w-5 text-emerald-200/60" />
            </motion.div>
          </motion.div>

          {/* Stats summary in header */}
          {!loading && history.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15 }}
              className="grid grid-cols-4 gap-2"
            >
              <div className="bg-white/15 backdrop-blur-sm rounded-xl p-2.5 text-center border border-white/10">
                <HistoryIcon className="h-3.5 w-3.5 mx-auto mb-1 text-emerald-200" />
                <p className="text-lg sm:text-xl font-bold text-white">{stats.totalVisits}</p>
                <p className="text-[9px] sm:text-[10px] text-emerald-100/70 font-medium leading-tight">{t('historyTotalVisits')}</p>
              </div>
              <div className="bg-white/15 backdrop-blur-sm rounded-xl p-2.5 text-center border border-white/10">
                <CheckCircle2 className="h-3.5 w-3.5 mx-auto mb-1 text-emerald-200" />
                <p className="text-lg sm:text-xl font-bold text-white">{stats.completedCount}</p>
                <p className="text-[9px] sm:text-[10px] text-emerald-100/70 font-medium leading-tight">{t('historyCompletedCount')}</p>
              </div>
              <div className="bg-white/15 backdrop-blur-sm rounded-xl p-2.5 text-center border border-white/10">
                <Clock className="h-3.5 w-3.5 mx-auto mb-1 text-teal-200" />
                <p className="text-lg sm:text-xl font-bold text-white">{stats.avgWait > 0 ? `${stats.avgWait}` : '—'}</p>
                <p className="text-[9px] sm:text-[10px] text-emerald-100/70 font-medium leading-tight">{t('historyAvgWait')}</p>
              </div>
              <div className="bg-white/15 backdrop-blur-sm rounded-xl p-2.5 text-center border border-white/10">
                <XCircle className="h-3.5 w-3.5 mx-auto mb-1 text-rose-200" />
                <p className="text-lg sm:text-xl font-bold text-white">{stats.cancelledCount}</p>
                <p className="text-[9px] sm:text-[10px] text-emerald-100/70 font-medium leading-tight">{t('historyCancelledCount')}</p>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* ─── Service Duration Stats ─── */}
      {agencyList.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.35 }}
          className="mb-5"
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 overflow-hidden">
            <button
              onClick={() => setStatsExpanded(!statsExpanded)}
              className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
            >
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                  <Timer className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="text-sm font-bold text-foreground">{t('serviceDurationStats') || 'Service Duration Stats'}</span>
              </div>
              {statsExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>

            <AnimatePresence>
              {statsExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="overflow-hidden"
                >
                  <div className="px-3 pb-3 space-y-3">
                    {/* Agency selector */}
                    {agencyList.length > 1 && (
                      <div className="flex items-center gap-2 overflow-x-auto pb-1">
                        {agencyList.map((agency) => (
                          <button
                            key={agency.id}
                            onClick={() => setSelectedStatsAgencyId(agency.id)}
                            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
                              selectedStatsAgencyId === agency.id
                                ? 'bg-emerald-500 text-white shadow-sm'
                                : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
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
                          <motion.div
                            animate={{ opacity: [0.8, 1, 0.8] }}
                            transition={{ duration: 2, repeat: Infinity }}
                            className="rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 p-3"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-[10px] text-emerald-100 font-semibold uppercase">{t('currentlyServing') || 'Currently Serving'}</p>
                                <p className="text-white font-bold text-sm">{serviceStats.currentServing.queueNumber} · {serviceStats.currentServing.serviceName}</p>
                              </div>
                              <div className="text-end">
                                <div className="flex items-center gap-1">
                                  <Timer className="h-4 w-4 text-white/80" />
                                  <span className="text-xl font-black text-white tabular-nums">{liveDurationDisplay}</span>
                                </div>
                                <p className="text-[10px] text-emerald-100">{t('liveServiceTime') || 'Live Service Time'}</p>
                              </div>
                            </div>
                          </motion.div>
                        )}

                        {/* Duration grid */}
                        <div className="grid grid-cols-3 gap-2">
                          <div className="rounded-xl bg-emerald-50 dark:bg-emerald-900/20 p-2.5 text-center">
                            <p className="text-[9px] text-muted-foreground font-medium">Last 1</p>
                            <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">
                              {serviceStats.recentDurations?.last1 ? formatDuration(serviceStats.recentDurations.last1[0]) : '—'}
                            </p>
                          </div>
                          <div className="rounded-xl bg-teal-50 dark:bg-teal-900/20 p-2.5 text-center">
                            <p className="text-[9px] text-muted-foreground font-medium">Last 3</p>
                            <p className="text-base font-bold text-teal-600 dark:text-teal-400">
                              {serviceStats.recentDurations?.last3
                                ? formatDuration(serviceStats.recentDurations.last3.reduce((a: number, b: number) => a + b, 0) / serviceStats.recentDurations.last3.length)
                                : '—'}
                            </p>
                          </div>
                          <div className="rounded-xl bg-cyan-50 dark:bg-cyan-900/20 p-2.5 text-center">
                            <p className="text-[9px] text-muted-foreground font-medium">Last 5</p>
                            <p className="text-base font-bold text-cyan-600 dark:text-cyan-400">
                              {serviceStats.recentDurations?.last5
                                ? formatDuration(serviceStats.recentDurations.last5.reduce((a: number, b: number) => a + b, 0) / serviceStats.recentDurations.last5.length)
                                : '—'}
                            </p>
                          </div>
                          <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 p-2.5 text-center">
                            <p className="text-[9px] text-muted-foreground font-medium">Last 10</p>
                            <p className="text-base font-bold text-amber-600 dark:text-amber-400">
                              {serviceStats.recentDurations?.last10
                                ? formatDuration(serviceStats.recentDurations.last10.reduce((a: number, b: number) => a + b, 0) / serviceStats.recentDurations.last10.length)
                                : '—'}
                            </p>
                          </div>
                          <div className="rounded-xl bg-rose-50 dark:bg-rose-900/20 p-2.5 text-center">
                            <p className="text-[9px] text-muted-foreground font-medium">Average</p>
                            <p className="text-base font-bold text-rose-600 dark:text-rose-400">
                              {serviceStats.recentDurations?.averageAll ? formatDuration(serviceStats.recentDurations.averageAll) : '—'}
                            </p>
                          </div>
                          <div className="rounded-xl bg-gray-50 dark:bg-gray-900/20 p-2.5 text-center">
                            <p className="text-[9px] text-muted-foreground font-medium">Total</p>
                            <p className="text-base font-bold text-gray-600 dark:text-gray-400">
                              {serviceStats.totalCompleted ?? 0}
                            </p>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground text-center py-3">{t('noStatsAvailable') || 'No stats available'}</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>
        </motion.div>
      )}

      {/* Filter Tabs with gradient active state */}
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
        className="mb-3"
      >
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList className="w-full h-auto bg-gray-100 dark:bg-gray-800/50 p-1 rounded-xl">
            {statusFilters.map((f) => (
              <TabsTrigger
                key={f.value}
                value={f.value}
                className="flex-1 rounded-lg text-xs font-medium data-[state=active]:bg-gradient-to-r data-[state=active]:from-emerald-500 data-[state=active]:to-teal-500 data-[state=active]:text-white data-[state=active]:shadow-lg data-[state=active]:shadow-emerald-500/25 data-[state=active]:scale-[1.02] py-2 px-2 transition-all duration-300"
              >
                {t(f.key)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </motion.div>

      {/* Date Range Filter */}
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.25 }}
        className="mb-5"
      >
        <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
          <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span className="text-xs text-muted-foreground flex-shrink-0">{t('dateRange')}:</span>
          {[
            { key: 'all', label: t('allTime') },
            { key: '7days', label: t('last7Days') },
            { key: '30days', label: t('last30Days') },
            { key: '3months', label: t('last3Months') },
          ].map((opt) => (
            <button
              key={opt.key}
              onClick={() => setDateRangeFilter(opt.key)}
              className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[10px] font-medium transition-all duration-300 ${
                dateRangeFilter === opt.key
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-sm shadow-emerald-500/25'
                  : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </motion.div>

      {/* History Timeline */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex gap-3">
              <div className="flex flex-col items-center">
                <Skeleton className="h-5 w-5 rounded-full shrink-0" />
                <Skeleton className="w-0.5 flex-1 min-h-[60px]" />
              </div>
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-3/5 rounded-lg" />
                <Skeleton className="h-4 w-4/5 rounded-lg" />
                <div className="flex gap-3">
                  <Skeleton className="h-4 w-16 rounded-lg" />
                  <Skeleton className="h-4 w-16 rounded-lg" />
                </div>
                <Skeleton className="h-16 rounded-2xl" />
              </div>
            </div>
          ))}
        </div>
      ) : fetchError ? (
        <ErrorState onRetry={fetchHistory} />
      ) : filtered.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
        >
          <EmptyState
            icon={<span className="text-3xl">📋</span>}
            title={t('emptyNoHistoryTitle')}
            description={t('emptyNoHistoryDesc')}
            actionLabel={t('emptyNoHistoryAction') || t('browseAgencies') || 'Browse Agencies'}
            onAction={() => setView('customer-home')}
            actionIcon={<TicketCheck className="h-4 w-4" />}
          />
        </motion.div>
      ) : (
        <AnimatePresence mode="wait">
          <div key={filter} className="space-y-6">
            {dateGroupOrder.map((group) => {
              const items = groupedItems[group];
              if (items.length === 0) return null;

              return (
                <div key={group}>
                  {/* Date Group Header */}
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3 }}
                    className="flex items-center gap-2 mb-3"
                  >
                    <span className="text-sm">{getDateGroupIcon(group)}</span>
                    <h3 className="text-sm font-semibold text-foreground/80">{getDateGroupLabel(group)}</h3>
                    <span className="text-xs text-muted-foreground bg-gradient-to-r from-emerald-500/10 to-teal-500/10 px-2 py-0.5 rounded-full border border-emerald-200/30 dark:border-emerald-800/30">
                      {items.length}
                    </span>
                    <div className="flex-1 h-px bg-gradient-to-r from-border to-transparent" />
                  </motion.div>

                  {/* Timeline for this group */}
                  <motion.div
                    className="relative ps-7"
                    variants={containerVariants}
                    initial="hidden"
                    animate="visible"
                  >
                    {/* Vertical timeline line with gradient */}
                    <div className="absolute start-[11px] top-2 bottom-2 w-0.5">
                      <div className="absolute inset-0 bg-gradient-to-b from-emerald-400 via-teal-400 to-cyan-400/30 dark:from-emerald-600 dark:via-teal-600 dark:to-cyan-600/20 opacity-40" />
                      {/* Animated pulse along the line */}
                      <motion.div
                        animate={{ top: ['0%', '100%'] }}
                        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                        className="absolute w-1 h-6 -start-[1px] rounded-full bg-gradient-to-b from-emerald-400 to-teal-400 blur-[1px]"
                      />
                    </div>

                    {items.map((item, idx) => {
                      const dotConfig = statusDotConfig[item.status] ?? statusDotConfig.CANCELLED;
                      const StatusIcon = dotConfig.icon;

                      return (
                        <motion.div
                          key={item.id}
                          variants={itemVariants}
                          className="relative pb-4"
                        >
                          {/* Timeline dot with animated pulse */}
                          <div className="absolute start-[-22px] top-5">
                            <motion.div
                              animate={{ scale: [1, 1.2, 1] }}
                              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.2 }}
                              className={`h-5 w-5 rounded-full ${dotConfig.bg} ring-[3px] ${dotConfig.ring} ring-background shadow-sm flex items-center justify-center`}
                            >
                              <StatusIcon className="h-2.5 w-2.5 text-white" />
                            </motion.div>
                            {/* Glow ring around dot */}
                            <motion.div
                              animate={{ opacity: [0, 0.3, 0], scale: [1, 1.8, 1] }}
                              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.3 }}
                              className={`absolute inset-0 rounded-full ${dotConfig.bg} opacity-0 blur-sm`}
                            />
                          </div>

                          {/* Card with gradient border on hover */}
                          <div className="group relative">
                            {/* Gradient border on hover */}
                            <div className="absolute -inset-[1px] rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r from-emerald-400/40 via-teal-400/40 to-cyan-400/40 dark:from-emerald-500/30 dark:via-teal-500/30 dark:to-cyan-500/30" />
                            <Card className="relative border-0 shadow-sm hover:shadow-md transition-all duration-300 hover:-translate-y-0.5 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 overflow-hidden rounded-xl">
                              <CardContent className="p-3 sm:p-4">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                                    <div className="min-h-10 min-w-10 px-2.5 py-1 sm:min-h-11 sm:px-3 sm:py-1.5 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center flex-shrink-0">
                                      <span className="text-xs sm:text-sm font-bold bg-gradient-to-r from-emerald-700 to-teal-700 dark:from-emerald-400 dark:to-teal-400 bg-clip-text text-transparent whitespace-nowrap">
                                        {item.queueNumber}
                                      </span>
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-foreground truncate">
                                        {getAgencyName(item)}
                                      </p>
                                      <p className="text-xs text-muted-foreground truncate">
                                        {getServiceName(item)}
                                      </p>
                                    </div>
                                  </div>
                                  <QueueStatusBadge status={item.status} compact />
                                </div>

                                {/* Color-coded status badge */}
                                {dotConfig.badgeBg && (
                                  <span className={`inline-flex items-center gap-1 mt-2 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${dotConfig.badgeBg} ${dotConfig.badgeText}`}>
                                    <StatusIcon className="h-2.5 w-2.5" />
                                    {t(dotConfig.labelKey)}
                                  </span>
                                )}

                                {/* Rating display for completed items */}
                                {item.status === 'COMPLETED' && item.rating && (
                                  <div className="mt-2 flex items-center gap-2">
                                    <StarRating rating={item.rating} />
                                    <span className="text-xs text-muted-foreground">
                                      {item.rating}/5
                                    </span>
                                  </div>
                                )}
                                {/* Rate button for completed items without rating */}
                                {item.status === 'COMPLETED' && !item.rating && (
                                  <div className="mt-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 rounded-lg text-[11px] border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 px-2.5"
                                      onClick={() => handleRateItem(item)}
                                    >
                                      <MessageSquare className="h-3 w-3 me-1" />
                                      {t('rateNow')}
                                    </Button>
                                  </div>
                                )}

                                {/* Time info and action row */}
                                <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/50">
                                  <div className="flex items-center gap-2">
                                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                      <CalendarIcon className="h-3 w-3" />
                                      <span>{formatTime(item.joinedAt)}</span>
                                    </div>
                                    {item.estimatedWait != null && item.estimatedWait > 0 && (
                                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                        <Clock className="h-3 w-3" />
                                        <span>~{item.estimatedWait}{t('min')}</span>
                                      </div>
                                    )}
                                  </div>
                                  {canRejoin(item.status) && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 rounded-lg text-[11px] border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 px-2.5"
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
                              </CardContent>
                            </Card>
                          </div>
                        </motion.div>
                      );
                    })}
                  </motion.div>
                </div>
              );
            })}
          </div>
        </AnimatePresence>
      )}

      {/* Rating Dialog */}
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

      {/* Date Picker Dialog for Rejoin */}
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
              <Button variant="outline" size="sm" className="rounded-lg h-9" onClick={() => setSelectedDate(undefined)}>
                {t('today')}
              </Button>
              <Button variant="outline" size="sm" className="rounded-lg h-9" onClick={() => {
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
                  📅 {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => { setDateDialogOpen(false); setPendingRejoinItem(null); setSelectedDate(undefined); }} className="rounded-xl h-10">
              {t('cancel')}
            </Button>
            <Button onClick={confirmRejoin} disabled={joining} className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-10 shadow-lg shadow-emerald-500/25">
              {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
              {t('joinQueue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
