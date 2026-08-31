'use client';

import { useState, useEffect, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarChart3,
  CalendarDays,
  Clock,
  TrendingUp,
  TrendingDown,
  Building2,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Download,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, useInView } from 'framer-motion';
import { translateCategory } from '@/lib/enum-i18n';

interface QuickStats {
  totalReservations: number;
  avgWaitTime: number;
  busiestDay: string;
  peakHour: string;
}

interface AnalyticsData {
  quickStats: QuickStats;
  registrationsTrend: { date: string; count: number }[];
  topAgencies: {
    agencyId: string;
    name: string;
    nameAr?: string;
    nameFr?: string;
    category: string;
    reservationCount: number;
  }[];
  peakHours: { hour: number; count: number }[];
  customerGrowth?: { date: string; total: number }[];
}

// Animated counter hook
function useAnimatedCounter(target: number, duration: number = 1200, inView: boolean = true) {
  const [count, setCount] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!inView) return;
    startRef.current = null;
    const animate = (timestamp: number) => {
      if (!startRef.current) startRef.current = timestamp;
      const progress = Math.min((timestamp - startRef.current) / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }, [target, duration, inView]);

  return count;
}

// Chart tooltip component
function ChartTooltip({ show, x, y, value, label }: { show: boolean; x: number; y: number; value: number | string; label?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: 4 }}
      animate={{ opacity: show ? 1 : 0, scale: show ? 1 : 0.8, y: show ? 0 : 4 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-none absolute z-50"
      style={{ left: x, top: y }}
    >
      {show && (
        <div className="bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap">
          <div className="font-semibold">{value}</div>
          {label && <div className="text-gray-300 dark:text-gray-600 mt-0.5">{label}</div>}
        </div>
      )}
    </motion.div>
  );
}

export function AdminAnalytics() {
  const { t, lang } = useLanguage();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState('14d');
  const [tooltip, setTooltip] = useState<{ show: boolean; x: number; y: number; value: string; label?: string }>({ show: false, x: 0, y: 0, value: '' });
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: '-50px' });

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry('/api/admin/analytics');
      if (res.ok) {
        const json = await res.json();
        setData(json);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
      toast.error(t('errorLoadingData'));
    } finally {
      setLoading(false);
    }
  };

  const getAgencyName = (a: { name: string; nameAr?: string; nameFr?: string }) => {
    if (lang === 'ar' && a.nameAr) return a.nameAr;
    if (lang === 'fr' && a.nameFr) return a.nameFr;
    return a.name;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const periods = [
    { id: 'today', label: t('today') },
    { id: 'week', label: t('thisWeek') || 'This Week' },
    { id: 'month', label: t('thisMonth') || 'This Month' },
    { id: 'year', label: t('thisYear') || 'This Year' },
  ];

  // Ensure we always have 14 days
  const allRegistrations = data?.registrationsTrend ?? [];
  const last14Days = allRegistrations.slice(-14);

  // Pad with empty days if needed
  const now = new Date();
  const paddedLast14Days: { date: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().split('T')[0];
    const found = last14Days.find((r) => r.date === key);
    paddedLast14Days.push({ date: key, count: found?.count ?? 0 });
  }

  const maxRegistrations = Math.max(...paddedLast14Days.map((d) => d.count), 1);

  // Ensure all 24 hours are present
  const allHours = Array.from({ length: 24 }, (_, i) => i);
  const peakHoursData = data?.peakHours ?? [];
  const fullPeakHours = allHours.map((hour) => {
    const found = peakHoursData.find((h) => h.hour === hour);
    return { hour, count: found?.count ?? 0 };
  });
  const maxPeakHour = Math.max(...fullPeakHours.map((h) => h.count), 1);

  // Weekly summary: compare this week (last 7 days) vs last week (7-14 days ago)
  const thisWeekTotal = paddedLast14Days.slice(-7).reduce((sum, d) => sum + d.count, 0);
  const lastWeekTotal = paddedLast14Days.slice(0, 7).reduce((sum, d) => sum + d.count, 0);
  const weeklyChange = lastWeekTotal > 0 ? ((thisWeekTotal - lastWeekTotal) / lastWeekTotal) * 100 : 0;
  const weeklyChangePositive = weeklyChange >= 0;

  // Medal emojis for top 3 agencies
  const medalEmojis = ['🥇', '🥈', '🥉'];

  // Animated counters
  const animTotalReservations = useAnimatedCounter(data?.quickStats.totalReservations ?? 0, 1500, isInView);
  const animAvgWait = useAnimatedCounter(data?.quickStats.avgWaitTime ?? 0, 1200, isInView);
  const animThisWeek = useAnimatedCounter(thisWeekTotal, 1000, isInView);
  const animLastWeek = useAnimatedCounter(lastWeekTotal, 1000, isInView);

  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-5">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!data || loadError) {
    return (
      <div className="p-4 lg:p-6">
        <h1 className="text-2xl font-bold text-foreground mb-5">{t('analytics')}</h1>
        <Card className="border-0 shadow-sm">
          <CardContent className="py-16">
            <div className="flex flex-col items-center justify-center text-center text-muted-foreground">
              <div className="relative mb-6">
                <div className="absolute inset-0 rounded-full bg-emerald-400/20 blur-xl" />
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60">
                  <BarChart3 className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{loadError ? t('errorLoadingData') : t('emptyNoAnalyticsTitle')}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px]">{loadError ? t('errorRetryHint') : t('emptyNoAnalyticsDesc')}</p>
              <Button
                variant="outline"
                className="mt-4 gap-2 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
                onClick={fetchAnalytics}
              >
                <RefreshCw className="h-4 w-4" />
                {t('tryAgain')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="p-4 lg:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-foreground">{t('analytics')}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t('analyticsDesc') || 'Platform performance insights and trends'}</p>
        <Button
          variant="outline"
          className="h-9 rounded-lg gap-2 text-sm"
          onClick={() => toast.info(t('comingSoon') || 'Coming Soon')}
        >
          <Download className="h-4 w-4" />
          {t('downloadReport') || 'Download Report'}
          <span className="text-[9px] font-semibold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full ms-1">
            {t('comingSoon')}
          </span>
        </Button>
      </div>

      {/* Period Selector Tabs */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-1.5 p-1 bg-gray-100 dark:bg-gray-800/50 rounded-xl w-fit"
      >
        {periods.map((period) => (
          <motion.button
            key={period.id}
            whileTap={{ scale: 0.97 }}
            onClick={() => setSelectedPeriod(period.id)}
            className={`relative px-4 py-2 text-xs font-semibold rounded-lg transition-colors duration-200 ${
              selectedPeriod === period.id
                ? 'text-white'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {selectedPeriod === period.id && (
              <motion.div
                layoutId="period-tab"
                className="absolute inset-0 bg-gradient-to-r from-emerald-600 to-teal-600 rounded-lg shadow-md"
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              />
            )}
            <span className="relative z-10">{period.label}</span>
          </motion.button>
        ))}
      </motion.div>

      {/* Quick Stats with Gradient + Comparison */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon: Activity, label: t('totalReservationsAll'), value: animTotalReservations, color: 'emerald', rawValue: data.quickStats.totalReservations, comp: '+12%' },
          { icon: Clock, label: t('avgWaitTimeStat'), value: `${animAvgWait} ${t('min')}`, color: 'teal', rawValue: null, comp: '-5%' },
          { icon: CalendarDays, label: t('busiestDay'), value: data.quickStats.busiestDay, color: 'amber', rawValue: null, comp: null },
          { icon: TrendingUp, label: t('peakHour'), value: data.quickStats.peakHour, color: 'rose', rawValue: null, comp: null },
        ].map((stat, idx) => {
          const Icon = stat.icon;
          const gradientMap: Record<string, string> = {
            emerald: 'from-emerald-500 to-emerald-600 shadow-emerald-500/20',
            teal: 'from-teal-500 to-teal-600 shadow-teal-500/20',
            amber: 'from-amber-500 to-amber-600 shadow-amber-500/20',
            rose: 'from-rose-500 to-rose-600 shadow-rose-500/20',
          };
          return (
            <motion.div
              key={stat.label}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              whileHover={{ y: -4 }}
              className="cursor-default"
            >
              <div className={`relative overflow-hidden rounded-2xl p-3 sm:p-4 text-white shadow-lg bg-gradient-to-br ${gradientMap[stat.color]}`}>
                <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center mb-3 shadow-inner">
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <motion.p
                  className="text-xl font-bold"
                  key={String(stat.value)}
                  initial={{ y: 5, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  {stat.value}
                </motion.p>
                <div className="flex items-center justify-between mt-1">
                  <p className="text-xs text-white/70">{stat.label}</p>
                  {stat.comp && (
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${stat.comp.startsWith('+') ? 'bg-emerald-400/30 text-emerald-100' : 'bg-rose-400/30 text-rose-100'}`}>
                      {stat.comp}
                    </span>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Weekly Summary */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-emerald-600" />
              {t('weeklySummary')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-2 gap-4">
              {/* This Week */}
              <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-900/10">
                <p className="text-xs text-muted-foreground mb-1">{t('thisWeek')}</p>
                <motion.p
                  initial={{ y: 5, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                  className="text-2xl font-bold text-emerald-700 dark:text-emerald-400"
                >
                  {animThisWeek}
                </motion.p>
                <p className="text-xs text-muted-foreground">{t('registrations')}</p>
              </div>
              {/* Last Week */}
              <div className="p-4 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                <p className="text-xs text-muted-foreground mb-1">{t('lastWeek')}</p>
                <motion.p
                  initial={{ y: 5, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.25 }}
                  className="text-2xl font-bold text-foreground"
                >
                  {animLastWeek}
                </motion.p>
                <p className="text-xs text-muted-foreground">{t('registrations')}</p>
              </div>
            </div>
            {/* Change indicator */}
            <div className="mt-3 flex items-center justify-center gap-1.5">
              {weeklyChangePositive ? (
                <ArrowUpRight className="h-4 w-4 text-emerald-600" />
              ) : (
                <ArrowDownRight className="h-4 w-4 text-red-500" />
              )}
              <span className={`text-sm font-semibold ${weeklyChangePositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                {weeklyChangePositive ? '+' : ''}{weeklyChange.toFixed(1)}%
              </span>
              <span className="text-xs text-muted-foreground">{t('weeklyGrowth')}</span>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Registrations Trend - Area Chart with Gradient Fill */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              {t('registrationsTrend')}
              <span className="text-xs text-muted-foreground font-normal">({t('last14Days')})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <div className="flex items-end gap-1 h-52" onMouseLeave={() => setTooltip({ show: false, x: 0, y: 0, value: '' })}>
                {paddedLast14Days.map((d, i) => {
                  const height = maxRegistrations > 0 ? (d.count / maxRegistrations) * 100 : 0;
                  return (
                    <div
                      key={d.date}
                      className="flex-1 flex flex-col items-center justify-end h-full relative"
                      onMouseEnter={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const parentRect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
                        setTooltip({
                          show: true,
                          x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2 - 30,
                          y: e.currentTarget.offsetTop - 36,
                          value: `${d.count} ${t('registrations')}`,
                          label: formatDate(d.date),
                        });
                      }}
                    >
                      <div className="text-[10px] text-muted-foreground mb-1 font-medium">
                        {d.count > 0 ? d.count : ''}
                      </div>
                      {/* Area fill behind bar */}
                      <div
                        className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-emerald-500/10 to-emerald-500/5 dark:from-emerald-400/10 dark:to-emerald-400/5"
                        style={{ height: `${Math.max(height, 2)}%` }}
                      />
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${Math.max(height, 2)}%` }}
                        transition={{ duration: 0.5, delay: i * 0.03, ease: 'easeOut' }}
                        className="w-full rounded-t-md bg-gradient-to-t from-emerald-600 to-emerald-400 dark:from-emerald-700 dark:to-emerald-500 min-h-[2px] relative z-10"
                      />
                      <div className="text-[9px] text-muted-foreground mt-1.5">
                        {formatDate(d.date)}
                      </div>
                    </div>
                  );
                })}
              </div>
              <ChartTooltip
                show={tooltip.show}
                x={tooltip.x}
                y={tooltip.y}
                value={tooltip.value}
                label={tooltip.label}
              />
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top Agencies - Leaderboard */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="h-4 w-4 text-emerald-600" />
                {t('topAgencies')}
                <span className="text-[9px] font-semibold bg-gradient-to-r from-amber-100 to-amber-200 dark:from-amber-900/30 dark:to-amber-800/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full ms-auto">
                  🏆 {t('leaderboard') || 'Leaderboard'}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.topAgencies.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <Building2 className="h-8 w-8 text-emerald-400 mb-2" />
                  <p className="text-sm font-medium text-muted-foreground">{t('noData')}</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">{t('emptyNoTopAgenciesDesc')}</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {data.topAgencies.map((agency, idx) => {
                    const maxCount = data.topAgencies[0]?.reservationCount || 1;
                    const barWidth = (agency.reservationCount / maxCount) * 100;
                    const isTop3 = idx < 3;
                    return (
                      <motion.div
                        key={agency.agencyId}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className={`relative overflow-hidden rounded-xl p-3 transition-all duration-300 ${
                          isTop3
                            ? idx === 0
                              ? 'bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-900/10 dark:to-yellow-900/10 border border-amber-200/50 dark:border-amber-800/30'
                              : idx === 1
                                ? 'bg-gradient-to-r from-gray-50 to-slate-50 dark:from-gray-800/30 dark:to-slate-800/30 border border-gray-200/50 dark:border-gray-700/30'
                                : 'bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-900/10 dark:to-amber-900/10 border border-orange-200/50 dark:border-orange-800/30'
                            : 'bg-gray-50 dark:bg-gray-900/50'
                        }`}
                      >
                        <div className="flex items-center justify-between text-sm mb-1.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            {/* Rank badge */}
                            <div className={`h-7 w-7 rounded-full flex items-center justify-center text-sm flex-shrink-0 ${
                              idx === 0
                                ? 'bg-gradient-to-br from-amber-400 to-yellow-500 shadow-md shadow-amber-500/20'
                                : idx === 1
                                  ? 'bg-gradient-to-br from-gray-300 to-gray-400 shadow-md shadow-gray-400/20'
                                  : idx === 2
                                    ? 'bg-gradient-to-br from-orange-400 to-amber-500 shadow-md shadow-orange-500/20'
                                    : 'bg-gray-200 dark:bg-gray-700'
                            }`}>
                              {isTop3 ? (
                                <span className="text-base">{medalEmojis[idx]}</span>
                              ) : (
                                <span className="text-[10px] font-bold text-gray-600 dark:text-gray-300">{idx + 1}</span>
                              )}
                            </div>
                            <div className="min-w-0">
                              <span className="font-medium text-foreground truncate block text-sm">
                                {getAgencyName(agency)}
                              </span>
                              <span className="text-[10px] text-muted-foreground">{translateCategory(agency.category, t)}</span>
                            </div>
                          </div>
                          <motion.span
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: idx * 0.05 + 0.2 }}
                            className="text-xs font-bold text-emerald-600 dark:text-emerald-400 flex-shrink-0 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded-full"
                          >
                            {agency.reservationCount} {t('reservationsCount')}
                          </motion.span>
                        </div>
                        {/* Progress bar */}
                        <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800/80 overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${barWidth}%` }}
                            transition={{ duration: 0.8, delay: idx * 0.1, ease: 'easeOut' }}
                            className={`h-full rounded-full ${
                              idx === 0
                                ? 'bg-gradient-to-r from-amber-400 to-yellow-400'
                                : idx === 1
                                  ? 'bg-gradient-to-r from-gray-300 to-gray-400'
                                  : idx === 2
                                    ? 'bg-gradient-to-r from-orange-400 to-amber-400'
                                    : 'bg-gradient-to-r from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-500'
                            }`}
                          />
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Peak Hours - Area Chart with Gradient */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-emerald-600" />
                {t('peakHours')}
                <span className="text-xs text-muted-foreground font-normal">({t('hourly')})</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="relative">
                <div className="flex items-end gap-[3px] h-48" onMouseLeave={() => setTooltip({ show: false, x: 0, y: 0, value: '' })}>
                  {fullPeakHours.map((h, i) => {
                    const height = maxPeakHour > 0 ? (h.count / maxPeakHour) * 100 : 0;
                    const isCurrentHour = new Date().getHours() === h.hour;
                    return (
                      <div
                        key={h.hour}
                        className="flex-1 flex flex-col items-center justify-end h-full relative"
                        onMouseEnter={(e) => {
                          setTooltip({
                            show: true,
                            x: e.currentTarget.offsetLeft + e.currentTarget.offsetWidth / 2 - 30,
                            y: e.currentTarget.offsetTop - 30,
                            value: `${h.count} ${t('registrations')}`,
                            label: `${String(h.hour).padStart(2, '0')}:00`,
                          });
                        }}
                      >
                        <div className="text-[9px] text-muted-foreground mb-1">
                          {h.count > 0 ? h.count : ''}
                        </div>
                        {/* Area gradient fill */}
                        <div
                          className={`absolute bottom-0 left-0 right-0 ${
                            isCurrentHour
                              ? 'bg-gradient-to-t from-emerald-500/15 to-emerald-400/5'
                              : 'bg-gradient-to-t from-teal-500/8 to-teal-400/3'
                          }`}
                          style={{ height: `${Math.max(height, 1)}%` }}
                        />
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: `${Math.max(height, 1)}%` }}
                          transition={{ duration: 0.5, delay: i * 0.02, ease: 'easeOut' }}
                          className={`w-full rounded-t-sm min-h-[1px] relative z-10 ${
                            isCurrentHour
                              ? 'bg-gradient-to-t from-emerald-700 to-emerald-400 dark:from-emerald-600 dark:to-emerald-300 ring-1 ring-emerald-400/50'
                              : 'bg-gradient-to-t from-teal-600/60 to-teal-400/60 dark:from-teal-700/60 dark:to-teal-500/60'
                          }`}
                        />
                        <div className={`text-[8px] mt-1 ${isCurrentHour ? 'text-emerald-600 dark:text-emerald-400 font-bold' : 'text-muted-foreground'}`}>
                          {String(h.hour).padStart(2, '0')}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <ChartTooltip
                  show={tooltip.show}
                  x={tooltip.x}
                  y={tooltip.y}
                  value={tooltip.value}
                  label={tooltip.label}
                />
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
