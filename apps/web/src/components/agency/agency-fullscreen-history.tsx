'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useIsMobile } from '@/hooks/use-mobile';
import { isRTL } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Clock,
  User,
  Phone,
  Hash,
  Ticket,
  Calendar,
  Timer,
  Star,
  Filter,
  ArrowLeft,
  Shrink,
  Loader2,
  AlertCircle,
  Briefcase,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { QueueStatusBadge } from '@/components/shared/queue-status-badge';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ────────────────────────────────────────────────────────────────

interface HistoryReservation {
  id: string;
  queueNumber: string;
  displayNumber: string;
  status: string;
  customerName: string;
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

interface HistoryResponse {
  reservations: HistoryReservation[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface ServiceOption {
  id: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function formatTime(dateStr: string | null, locale: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString(locale === 'ar' ? 'ar-DZ' : locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function formatDate(dateStr: string | null, locale: string): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(locale === 'ar' ? 'ar-DZ' : locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

function getServiceName(svc: { serviceName: string; serviceNameAr: string | null; serviceNameFr: string | null }, lang: string): string {
  if (lang === 'ar' && svc.serviceNameAr) return svc.serviceNameAr;
  if (lang === 'fr' && svc.serviceNameFr) return svc.serviceNameFr;
  return svc.serviceName;
}

const statusColorMap: Record<string, string> = {
  COMPLETED: 'border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20',
  CALLED: 'border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20',
  WAITING: 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20',
  CANCELLED: 'border-red-500/30 bg-red-500/10 hover:bg-red-500/20',
  NO_SHOW: 'border-gray-500/30 bg-gray-500/10 hover:bg-gray-500/20',
};

const ALL_STATUSES = ['WAITING', 'CALLED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

// ─── Component ───────────────────────────────────────────────────────────

export function AgencyFullscreenHistory() {
  const { user, setView } = useAppStore();
  const { lang, t } = useLanguage();
  const isMobile = useIsMobile();
  const rtl = isRTL(lang);

  const locale = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';

  // ─── State ────────────────────────────────────────────────────────────

  const [reservations, setReservations] = useState<HistoryReservation[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [serviceFilter, setServiceFilter] = useState<string>('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Detail
  const [selected, setSelected] = useState<HistoryReservation | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Refs
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  const limit = 20;

  // ─── Debounced Search ────────────────────────────────────────────────

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [searchQuery]);

  // ─── Fetch Services ──────────────────────────────────────────────────

  useEffect(() => {
    const fetchServices = async () => {
      try {
        const res = await apiFetch('/api/agency/services');
        if (res.ok) {
          const data = await res.json();
          setServices(data.services || []);
        }
      } catch {
        // non-critical — filters will just show no services
      }
    };
    fetchServices();
  }, []);

  // ─── Fetch History ───────────────────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    // Abort previous request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', String(limit));

      if (debouncedSearch) params.set('search', debouncedSearch);
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (serviceFilter !== 'ALL') params.set('serviceId', serviceFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);

      const res = await apiFetch(`/api/agency/history?${params.toString()}`, {
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data: HistoryResponse = await res.json();
      setReservations(data.reservations || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 0);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, statusFilter, serviceFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // ─── Handlers ─────────────────────────────────────────────────────────

  const handleExit = () => {
    setView('agency-fullscreen');
  };

  const handleSelectReservation = (res: HistoryReservation) => {
    setSelected(res);
    if (isMobile) {
      setDetailOpen(true);
    }
  };

  const handleClearFilters = () => {
    setSearchQuery('');
    setStatusFilter('ALL');
    setServiceFilter('ALL');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  };

  const hasActiveFilters =
    debouncedSearch !== '' ||
    statusFilter !== 'ALL' ||
    serviceFilter !== 'ALL' ||
    dateFrom !== '' ||
    dateTo !== '';

  // ─── Star Rating ─────────────────────────────────────────────────────

  const StarRating = ({ rating }: { rating: number | null }) => {
    if (rating == null) return <span className="text-gray-500">—</span>;
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`h-4 w-4 ${
              star <= rating
                ? 'fill-amber-400 text-amber-400'
                : 'fill-gray-700 text-gray-600'
            }`}
          />
        ))}
      </div>
    );
  };

  // ─── Detail Card ──────────────────────────────────────────────────────

  const DetailCard = ({ res }: { res: HistoryReservation }) => {
    const name = res.isWalkIn
      ? res.walkInCustomerName || res.customerName
      : res.customerName;

    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-800 text-white text-lg font-bold">
              {res.displayNumber?.slice(-2) || '??'}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">{name}</h3>
              <p className="text-sm text-gray-400">
                #{res.queueNumber}
                {res.isWalkIn && (
                  <Badge variant="outline" className="ml-2 border-amber-600/30 bg-amber-600/10 text-amber-400 text-[10px]">
                    Walk-in
                  </Badge>
                )}
              </p>
            </div>
          </div>
          <QueueStatusBadge status={res.status} />
        </div>

        <div className="h-px bg-gray-800" />

        {/* Info Grid */}
        <div className="grid grid-cols-1 gap-3">
          {/* Customer Name */}
          <DetailRow
            icon={<User className="h-4 w-4" />}
            label={t('name')}
            value={name}
          />
          {/* Phone */}
          <DetailRow
            icon={<Phone className="h-4 w-4" />}
            label={t('phoneNumber')}
            value={res.customerPhone}
          />
          {/* Service */}
          <DetailRow
            icon={<Briefcase className="h-4 w-4" />}
            label={t('service')}
            value={getServiceName(res, lang)}
          />
          {/* Counter */}
          {res.counterName && (
            <DetailRow
              icon={<Hash className="h-4 w-4" />}
              label="Counter"
              value={res.counterName}
            />
          )}
        </div>

        <div className="h-px bg-gray-800" />

        {/* Timeline */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">
            Timeline
          </h4>
          <DetailRow
            icon={<Ticket className="h-4 w-4" />}
            label="Joined"
            value={`${formatDate(res.joinedAt, locale)} · ${formatTime(res.joinedAt, locale)}`}
          />
          <DetailRow
            icon={<Clock className="h-4 w-4" />}
            label="Called"
            value={formatTime(res.calledAt, locale)}
          />
          <DetailRow
            icon={<Clock className="h-4 w-4" />}
            label={t('completed')}
            value={formatTime(res.completedAt, locale)}
          />
          <DetailRow
            icon={<Clock className="h-4 w-4" />}
            label={t('cancelled')}
            value={formatTime(res.cancelledAt, locale)}
          />
        </div>

        <div className="h-px bg-gray-800" />

        {/* Durations */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-gray-400 text-xs mb-1">
              <Timer className="h-3 w-3" />
              Wait Duration
            </div>
            <div className="text-lg font-semibold text-white">
              {formatDuration(res.waitDuration)}
            </div>
          </div>
          <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-gray-400 text-xs mb-1">
              <Timer className="h-3 w-3" />
              Service Duration
            </div>
            <div className="text-lg font-semibold text-white">
              {formatDuration(res.serviceDuration)}
            </div>
          </div>
        </div>

        {/* Rating */}
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">{t('yourRating')}</span>
            <StarRating rating={res.rating} />
          </div>
        </div>
      </div>
    );
  };

  // ─── Loading Skeleton ────────────────────────────────────────────────

  const ListSkeleton = () => (
    <div className="space-y-2 p-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/50 p-3"
        >
          <Skeleton className="h-10 w-10 rounded-lg bg-gray-800" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4 bg-gray-800" />
            <Skeleton className="h-3 w-1/2 bg-gray-800" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full bg-gray-800" />
        </div>
      ))}
    </div>
  );

  const DetailSkeleton = () => (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-12 w-12 rounded-xl bg-gray-800" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-5 w-48 bg-gray-800" />
          <Skeleton className="h-3 w-24 bg-gray-800" />
        </div>
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded bg-gray-800" />
          <Skeleton className="h-4 w-24 bg-gray-800" />
          <Skeleton className="h-4 w-40 bg-gray-800" />
        </div>
      ))}
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      className="h-screen w-screen flex flex-col overflow-hidden bg-gray-950 text-white"
    >
      {/* ─── Header ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExit}
            className="h-8 gap-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-sm"
          >
            {rtl ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">{t('exitFullscreen')}</span>
          </Button>
          <div className="h-4 w-px bg-gray-800" />
          <h1 className="text-base font-semibold text-white flex items-center gap-2">
            <Clock className="h-4 w-4 text-gray-400" />
            {t('history')}
          </h1>
          {total > 0 && (
            <Badge variant="outline" className="border-gray-700 bg-gray-800 text-gray-300 text-xs px-2 py-0.5">
              {total}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="text-[11px] text-gray-500 hidden sm:inline">Live</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExit}
            className="h-8 px-2 gap-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-[11px]"
          >
            <Shrink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('exitFullscreen')}</span>
          </Button>
        </div>
      </header>

      {/* ─── Content ────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* ─── Left Panel (List) ──────────────────────────────────────── */}
        <div className={`${isMobile ? 'w-full' : 'w-[55%]'} flex flex-col min-h-0 border-r-0 lg:border-r border-gray-800`}>
          {/* Search + Filters */}
          <div className="shrink-0 border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm">
            {/* Search */}
            <div className="p-3 pb-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                <Input
                  placeholder={`${t('search')}...`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-9 w-full pl-9 pr-9 rounded-lg border-gray-800 bg-gray-900 text-white placeholder:text-gray-500 text-sm focus-visible:ring-gray-700"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Filter Row */}
            <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
              {/* Status Filter */}
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
                <SelectTrigger className="h-8 w-auto min-w-[110px] border-gray-800 bg-gray-900 text-gray-300 text-xs rounded-lg">
                  <SelectValue placeholder={t('status')} />
                </SelectTrigger>
                <SelectContent className="bg-gray-900 border-gray-800">
                  <SelectItem value="ALL" className="text-gray-300 focus:bg-gray-800 focus:text-white">{t('all')}</SelectItem>
                  {ALL_STATUSES.map((s) => (
                    <SelectItem key={s} value={s} className="text-gray-300 focus:bg-gray-800 focus:text-white">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Service Filter */}
              <Select value={serviceFilter} onValueChange={(v) => { setServiceFilter(v); setPage(1); }}>
                <SelectTrigger className="h-8 w-auto min-w-[120px] border-gray-800 bg-gray-900 text-gray-300 text-xs rounded-lg">
                  <SelectValue placeholder={t('service')} />
                </SelectTrigger>
                <SelectContent className="bg-gray-900 border-gray-800">
                  <SelectItem value="ALL" className="text-gray-300 focus:bg-gray-800 focus:text-white">{t('all')}</SelectItem>
                  {services.map((svc) => (
                    <SelectItem key={svc.id} value={svc.id} className="text-gray-300 focus:bg-gray-800 focus:text-white">
                      {getServiceName(svc, lang)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Date From */}
              <div className="relative">
                <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500 pointer-events-none" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                  className="h-8 w-auto min-w-[130px] pl-7 pr-2 border-gray-800 bg-gray-900 text-gray-300 text-xs rounded-lg [color-scheme:dark]"
                />
              </div>

              {/* Date To */}
              <div className="relative">
                <Calendar className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500 pointer-events-none" />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                  className="h-8 w-auto min-w-[130px] pl-7 pr-2 border-gray-800 bg-gray-900 text-gray-300 text-xs rounded-lg [color-scheme:dark]"
                />
              </div>

              {/* Clear Filters */}
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearFilters}
                  className="h-8 px-2 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg text-xs gap-1"
                >
                  <X className="h-3 w-3" />
                  {t('clearFilters')}
                </Button>
              )}
            </div>
          </div>

          {/* List */}
          <div ref={listContainerRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            {loading ? (
              <ListSkeleton />
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                <AlertCircle className="h-10 w-10 text-red-400/60" />
                <p className="text-sm text-gray-400">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={fetchHistory}
                  className="border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-xs gap-1"
                >
                  {t('refresh')}
                </Button>
              </div>
            ) : reservations.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                <div className="h-16 w-16 rounded-2xl bg-gray-900 flex items-center justify-center">
                  <Ticket className="h-8 w-8 text-gray-600" />
                </div>
                <p className="text-sm text-gray-500">
                  {hasActiveFilters ? t('noResults') : t('noHistoryYet')}
                </p>
                {hasActiveFilters && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearFilters}
                    className="border-gray-800 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-xs"
                  >
                    {t('clearFilters')}
                  </Button>
                )}
              </div>
            ) : (
              <AnimatePresence mode="popLayout">
                <div className="p-3 space-y-1.5">
                  {reservations.map((res, idx) => {
                    const isSelected = selected?.id === res.id;
                    const name = res.isWalkIn
                      ? res.walkInCustomerName || res.customerName
                      : res.customerName;
                    const borderColor =
                      statusColorMap[res.status] || 'border-gray-800';

                    return (
                      <motion.div
                        key={res.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.15, delay: idx * 0.02 }}
                        onClick={() => handleSelectReservation(res)}
                        className={`
                          flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-all duration-150
                          ${borderColor}
                          ${isSelected
                            ? 'ring-1 ring-white/20 bg-gray-900'
                            : 'hover:bg-gray-900/80'
                          }
                        `}
                      >
                        {/* Queue Number Circle */}
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-800 text-sm font-bold text-white">
                          {res.displayNumber?.slice(-2) || '??'}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white truncate">
                              {name}
                            </span>
                            {res.isWalkIn && (
                              <Badge variant="outline" className="shrink-0 border-amber-600/30 bg-amber-600/10 text-amber-400 text-[9px] px-1 py-0">
                                W
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
                            <span className="truncate">
                              {getServiceName(res, lang)}
                            </span>
                            <span className="text-gray-700">·</span>
                            <span className="shrink-0">
                              {formatTime(res.joinedAt, locale)}
                            </span>
                          </div>
                        </div>

                        {/* Duration + Status */}
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <QueueStatusBadge status={res.status} compact />
                          {res.serviceDuration != null && (
                            <span className="text-[11px] text-gray-500 flex items-center gap-0.5">
                              <Timer className="h-3 w-3" />
                              {formatDuration(res.serviceDuration)}
                            </span>
                          )}
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </AnimatePresence>
            )}
          </div>

          {/* Pagination */}
          {!loading && totalPages > 1 && (
            <div className="shrink-0 flex items-center justify-between border-t border-gray-800 bg-gray-950 px-4 py-2">
              <span className="text-xs text-gray-500">
                {t('page')} {page} / {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="h-7 px-2 border-gray-800 bg-gray-900 text-gray-400 hover:text-white hover:bg-gray-800 rounded-md text-xs disabled:opacity-30"
                >
                  {rtl ? (
                    <ChevronRight className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronLeft className="h-3.5 w-3.5" />
                  )}
                </Button>
                {/* Page numbers */}
                <div className="hidden sm:flex items-center gap-0.5">
                  {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
                    let pageNum: number;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (page <= 3) {
                      pageNum = i + 1;
                    } else if (page >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = page - 2 + i;
                    }
                    return (
                      <Button
                        key={pageNum}
                        variant={page === pageNum ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setPage(pageNum)}
                        className={`h-7 w-7 p-0 rounded-md text-xs ${
                          page === pageNum
                            ? 'bg-white text-gray-950 hover:bg-white/90'
                            : 'border-gray-800 bg-gray-900 text-gray-400 hover:text-white hover:bg-gray-800'
                        }`}
                      >
                        {pageNum}
                      </Button>
                    );
                  })}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="h-7 px-2 border-gray-800 bg-gray-900 text-gray-400 hover:text-white hover:bg-gray-800 rounded-md text-xs disabled:opacity-30"
                >
                  {rtl ? (
                    <ChevronLeft className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ─── Right Panel (Detail) ─────────────────────────────────── */}
        {!isMobile && (
          <div className="w-[45%] flex flex-col min-h-0 overflow-y-auto custom-scrollbar">
            {loading && reservations.length === 0 ? (
              <DetailSkeleton />
            ) : selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, x: rtl ? -12 : 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
                className="p-6"
              >
                <DetailCard res={selected} />
              </motion.div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
                <div className="h-20 w-20 rounded-2xl bg-gray-900/80 flex items-center justify-center">
                  <Ticket className="h-10 w-10 text-gray-700" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-400">
                    Select a reservation
                  </p>
                  <p className="text-xs text-gray-600 mt-1">
                    Click on any entry in the list to view full details
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Mobile Detail Dialog ────────────────────────────────────── */}
      {isMobile && (
        <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
          <DialogContent className="bg-gray-950 border-gray-800 text-white max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-white">Reservation Details</DialogTitle>
              <DialogDescription className="text-gray-500">
                Full details for the selected reservation
              </DialogDescription>
            </DialogHeader>
            {selected && <DetailCard res={selected} />}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function DetailRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-gray-800 text-gray-400 shrink-0">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</p>
        <p className="text-sm text-gray-200 truncate">{value || '—'}</p>
      </div>
    </div>
  );
}
