import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  UserX,
  Zap,
  BarChart3,
  Loader2,
  CalendarDays,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ─── Shared analytics components ────────────────────────────────────────────
import { NoShowAnalytics } from '@/components/agency/no-show-analytics';
import { PeakHoursAnalytics } from '@/components/agency/peak-hours-analytics';
import { WaitTimeChart } from '@/components/agency/wait-time-chart';
import { RatingDistribution } from '@/components/agency/rating-distribution';
import { ServiceBreakdown } from '@/components/agency/dashboard/service-breakdown';
import type { ServiceStat } from '@/components/agency/dashboard/types';

// ─── Types ───────────────────────────────────────────────────────────────────
interface DailyItem {
  date: string;
  count: number;
}

interface StatsData {
  hourlyWaitTime?: { hour: number; avgWaitTime: number; servedCount: number }[] | number[];
  ratingDistribution?: { rating: number; count: number }[] | number[];
  avgRating?: number;
  totalRatings?: number;
  serviceStats?: ServiceStat[];
}

// ─── Daily Visitors Chart ────────────────────────────────────────────────────
function DailyVisitorsChart({ data, loading }: { data: DailyItem[]; loading: boolean }) {
  const { t, lang } = useLanguage();

  if (loading) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-teal-500" />
            <CardTitle className="text-sm font-semibold">{t('dailyVisitors') || 'Daily Visitors'}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const chartData = data.slice(-14).map((d) => ({
    date: d.date,
    count: d.count,
    label: (() => {
      try {
        return new Date(d.date).toLocaleDateString(
          lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
          { month: 'short', day: 'numeric' }
        );
      } catch {
        return d.date;
      }
    })(),
  }));

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-teal-500" />
          <CardTitle className="text-sm font-semibold">{t('dailyVisitors') || 'Daily Visitors'}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-56 sm:h-64" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 9 }}
                stroke="rgba(128,128,128,0.4)"
                interval={Math.max(0, Math.floor(chartData.length / 7))}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                stroke="rgba(128,128,128,0.4)"
                width={30}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'rgba(255,255,255,0.95)',
                  border: '1px solid rgba(0,0,0,0.08)',
                  borderRadius: '12px',
                  fontSize: '12px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                }}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="#14b8a6" fillOpacity={0.8} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Analytics Page ─────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const agencyId = user?.agencyId || '';

  // ─── Stats data (for WaitTimeChart + RatingDistribution) ────────────────
  const [stats, setStats] = useState<StatsData | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // ─── Services data (for ServiceBreakdown) ───────────────────────────────
  const [serviceStats, setServiceStats] = useState<ServiceStat[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);

  // ─── Daily chart data ───────────────────────────────────────────────────
  const [dailyData, setDailyData] = useState<DailyItem[]>([]);
  const [dailyLoading, setDailyLoading] = useState(true);

  // ─── Fetch stats ────────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    if (!agencyId) return;
    setStatsLoading(true);
    try {
      const res = await apiFetch(
        `/api/agency/stats?agencyId=${encodeURIComponent(agencyId)}`
      );
      if (res.ok) {
        const json = await res.json();
        setStats(json.stats ?? json ?? null);
      }
    } catch {
      /* silent */
    } finally {
      setStatsLoading(false);
    }
  }, [agencyId]);

  // ─── Fetch services (for ServiceBreakdown) ──────────────────────────────
  const fetchServices = useCallback(async () => {
    if (!agencyId) return;
    setServicesLoading(true);
    try {
      const res = await apiFetch(
        `/api/agency/services?agencyId=${encodeURIComponent(agencyId)}`
      );
      if (res.ok) {
        const json = await res.json();
        const svcs: ServiceStat[] = (json.services ?? json ?? []).map(
          (s: Record<string, unknown>) => ({
            id: String(s.id ?? ''),
            name: String(s.name ?? ''),
            nameAr: s.nameAr ? String(s.nameAr) : undefined,
            nameFr: s.nameFr ? String(s.nameFr) : undefined,
            waitingCount: Number(s.waitingCount ?? s._count?.waiting ?? 0),
            completedCount: Number(s.completedCount ?? s._count?.completed ?? 0),
          })
        );
        setServiceStats(svcs);
      }
    } catch {
      /* silent */
    } finally {
      setServicesLoading(false);
    }
  }, [agencyId]);

  // ─── Fetch daily chart ──────────────────────────────────────────────────
  const fetchDaily = useCallback(async () => {
    if (!agencyId) return;
    setDailyLoading(true);
    try {
      const res = await apiFetch(
        `/api/agency/daily-chart?agencyId=${encodeURIComponent(agencyId)}`
      );
      if (res.ok) {
        const json = await res.json();
        setDailyData(json.daily ?? json.chart ?? json.data ?? json ?? []);
      }
    } catch {
      /* silent */
    } finally {
      setDailyLoading(false);
    }
  }, [agencyId]);

  // ─── Load all data on mount ─────────────────────────────────────────────
  useEffect(() => {
    fetchStats();
    fetchServices();
    fetchDaily();
  }, [fetchStats, fetchServices, fetchDaily]);

  // ─── Derived data for presentation components ───────────────────────────
  const hourlyWaitTime = (stats?.hourlyWaitTime ?? []).map(
    (val: unknown, hour: number) => ({
      hour,
      avgWaitTime:
        typeof val === 'number'
          ? val
          : (val as Record<string, unknown>)?.avgWaitTime ?? 0,
      servedCount:
        typeof val === 'number'
          ? 0
          : (val as Record<string, unknown>)?.servedCount ?? 0,
    })
  );

  const ratingDistribution = (stats?.ratingDistribution ?? []).map(
    (val: unknown, i: number) => ({
      rating: i + 1,
      count:
        typeof val === 'number'
          ? val
          : (val as Record<string, unknown>)?.count ?? 0,
    })
  );

  const maxWaiting = Math.max(
    ...serviceStats.map((s) => s.waitingCount),
    1
  );

  // ─── Render ─────────────────────────────────────────────────────────────
  if (!agencyId) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {t('advancedAnalytics') || 'Analytics'}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t('peakHoursDesc') || 'Performance insights and queue analytics'}
        </p>
      </div>

      {/* ═══ No-Show Analytics ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <UserX className="h-4 w-4 text-rose-500" />
              {t('noShowAnalytics')}
              <Badge variant="secondary" className="text-[10px] px-1.5">
                {t('last30Days')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <NoShowAnalytics agencyId={agencyId} />
          </CardContent>
        </Card>
      </motion.div>

      {/* ═══ Peak Hours Analytics ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-orange-500" />
              {t('peakHours')}
              <Badge variant="secondary" className="text-[10px] px-1.5">
                {t('last30Days')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <PeakHoursAnalytics agencyId={agencyId} />
          </CardContent>
        </Card>
      </motion.div>

      {/* ═══ Wait Time Chart + Rating Distribution ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          {statsLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : (
            <WaitTimeChart
              data={hourlyWaitTime}
              currentHour={new Date().getHours()}
            />
          )}
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          {statsLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : (
            <RatingDistribution
              ratings={ratingDistribution}
              averageRating={stats?.avgRating}
              totalRatings={stats?.totalRatings}
            />
          )}
        </motion.div>
      </div>

      {/* ═══ Service Breakdown + Daily Visitors ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
        >
          {servicesLoading ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : (
            <ServiceBreakdown
              serviceStats={serviceStats}
              maxWaiting={maxWaiting}
              lang={lang}
              t={t}
            />
          )}
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <DailyVisitorsChart data={dailyData} loading={dailyLoading} />
        </motion.div>
      </div>
    </div>
  );
}
