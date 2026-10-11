'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Zap,
  Clock,
  Calendar,
  TrendingUp,
  BarChart3,
  Flame,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface PeakHourItem {
  hour: number;
  count: number;
  avgWait: number;
}

interface WeekdayItem {
  weekday: number;
  name: string;
  count: number;
  avgWait: number;
}

interface ServicePeakHour {
  serviceId: string;
  serviceName: string;
  peakHour: number;
  count: number;
}

interface DailyWaitTrendItem {
  date: string;
  avgWait: number;
  count: number;
}

interface BusiestDay {
  weekday: number;
  name: string;
  count: number;
  avgWait: number;
}

interface PeakHoursData {
  peakHours: PeakHourItem[];
  busiestDay: BusiestDay | null;
  hourlyDemand: PeakHourItem[];
  weekdayDemand: WeekdayItem[];
  servicePeakHours: ServicePeakHour[];
  dailyWaitTrend: DailyWaitTrendItem[];
}

interface PeakHoursAnalyticsProps {
  agencyId: string;
}

// Day names in different languages
const dayNamesMap: Record<string, string[]> = {
  ar: ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  fr: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'],
};

const dayNamesFullMap: Record<string, string[]> = {
  ar: ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  fr: ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'],
};

export function PeakHoursAnalytics({ agencyId }: PeakHoursAnalyticsProps) {
  const { t, lang } = useLanguage();
  const [data, setData] = useState<PeakHoursData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!agencyId) return;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/agency/peak-hours?agencyId=${encodeURIComponent(agencyId)}`
      );
      if (res.ok) {
        const json = await res.json();
        setData(json.analytics ?? null);
      }
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, [agencyId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const formatHour = (h: number) => {
    if (lang === 'ar') return `${h}:00`;
    if (h === 0) return '12AM';
    if (h < 12) return `${h}AM`;
    if (h === 12) return '12PM';
    return `${h - 12}PM`;
  };

  const dayNames = dayNamesMap[lang] || dayNamesMap.en;
  const dayNamesFull = dayNamesFullMap[lang] || dayNamesFullMap.en;

  // Build heatmap data: 7 days × 24 hours grid
  // We only have weekdayDemand separately,
  // so we'll create a combined view
  const heatmapData = (() => {
    if (!data?.weekdayDemand) return [];
    // For the heatmap, show weekday demand as the primary visual
    return data.weekdayDemand.map((d) => ({
      day: d.weekday,
      dayName: dayNames[d.weekday] || dayNamesFull[d.weekday],
      count: d.count,
      avgWait: d.avgWait,
    }));
  })();

  // Color intensity for demand level
  const maxCount = Math.max(...(data?.weekdayDemand?.map((d) => d.count) || [1]), 1);

  const demandColor = (count: number, max: number) => {
    const ratio = count / max;
    if (ratio > 0.75) return 'bg-rose-500 text-white';
    if (ratio > 0.5) return 'bg-orange-400 text-white';
    if (ratio > 0.25) return 'bg-amber-300 text-amber-900';
    if (ratio > 0) return 'bg-emerald-200 text-emerald-800';
    return 'bg-gray-100 dark:bg-gray-800 text-gray-400';
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
        <Zap className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
        <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
      </div>
    );
  }

  // Compute "has meaningful data" flags for each section.
  // Use ?? [] to handle partial API responses where array fields may be undefined.
  const peakHours = data.peakHours ?? [];
  const weekdayDemand = data.weekdayDemand ?? [];
  const hourlyDemand = data.hourlyDemand ?? [];
  const servicePeakHours = data.servicePeakHours ?? [];
  const dailyWaitTrend = data.dailyWaitTrend ?? [];

  const hasPeakHoursData =
    peakHours.length > 0 && peakHours.some((p) => (p.count ?? 0) > 0);
  const hasWeekdayData =
    weekdayDemand.length > 0 &&
    weekdayDemand.some((d) => (d.count ?? 0) > 0 || (d.avgWait ?? 0) > 0);
  const hasHourlyData =
    hourlyDemand.length > 0 &&
    hourlyDemand.some((d) => (d.count ?? 0) > 0 || (d.avgWait ?? 0) > 0);
  // "Limited data" = only one distinct hour bucket has any activity.
  const limitedPeakHoursNote =
    hasPeakHoursData &&
    peakHours.filter((p) => (p.count ?? 0) > 0).length <= 1;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center">
          <Zap className="h-5 w-5 text-white" />
        </div>
        <div>
          <h3 className="text-base font-bold text-foreground">{t('peakHours')}</h3>
          <p className="text-xs text-muted-foreground">{t('peakHoursDesc')}</p>
        </div>
      </div>

      {/* Busiest Hours Cards */}
      <div className="grid grid-cols-3 gap-3">
        {hasPeakHoursData ? (
          <>
            {peakHours.map((ph, idx) => (
              <motion.div
                key={`peak-${idx}`}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + idx * 0.05 }}
              >
                <Card className="border-0 shadow-sm overflow-hidden">
                  <CardContent className="p-3 sm:p-4 text-center">
                    <div className="flex items-center justify-center gap-1.5 mb-2">
                      <Flame className={`h-4 w-4 ${idx === 0 ? 'text-rose-500' : idx === 1 ? 'text-orange-500' : 'text-amber-500'}`} />
                      <span className="text-[10px] font-bold text-muted-foreground">
                        #{idx + 1}
                      </span>
                    </div>
                    <p className="text-xl sm:text-2xl font-black text-foreground">{formatHour(ph.hour)}</p>
                    <div className="mt-1.5 flex items-center justify-center gap-1">
                      <Badge variant="secondary" className="text-[10px] px-1.5 h-5">
                        {ph.count} {t('reservationsCount')}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {ph.avgWait} {t('minutes')} {t('avgWaitTime')}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
            {limitedPeakHoursNote && (
              <div className="col-span-3 text-center py-1 text-[11px] text-amber-600 dark:text-amber-400">
                {t('noDataYet') || 'Limited data — more insights will appear as you serve more customers.'}
              </div>
            )}
          </>
        ) : (
          <div className="col-span-3 flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
          </div>
        )}
      </div>

      {/* Busiest Day + Weekday Heatmap */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Busiest Day card + Weekday demand bar chart */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-amber-500" />
                <CardTitle className="text-sm font-semibold">{t('weekdayDemand')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-3">
              {/* Busiest Day highlight */}
              {data.busiestDay && (
                <div className="p-3 rounded-xl bg-gradient-to-r from-rose-50 to-orange-50 dark:from-rose-900/20 dark:to-orange-900/20 border border-rose-100 dark:border-rose-900/30">
                  <div className="flex items-center gap-2">
                    <Flame className="h-4 w-4 text-rose-500" />
                    <span className="text-xs font-semibold text-rose-700 dark:text-rose-400">{t('busiestDay')}</span>
                  </div>
                  <p className="text-lg font-bold text-foreground mt-1">
                    {dayNamesFull[data.busiestDay.weekday] || data.busiestDay.name}
                  </p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-muted-foreground">
                      {data.busiestDay.count} {t('reservationsCount')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      ~{data.busiestDay.avgWait} {t('minutes')}
                    </span>
                  </div>
                </div>
              )}

              {/* Weekday bar grid */}
              {!hasWeekdayData ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                  <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-1.5">
                  {heatmapData.map((d) => (
                    <div key={d.day} className="flex flex-col items-center gap-1">
                      <span className="text-[9px] font-medium text-muted-foreground">{d.dayName}</span>
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${Math.max((d.count / maxCount) * 100, 8)}%` }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        className={`w-full rounded-md min-h-[8px] ${demandColor(d.count, maxCount)}`}
                        style={{ maxHeight: '100%' }}
                        title={`${d.dayName}: ${d.count} ${t('reservationsCount')}`}
                      />
                      <span className="text-[8px] font-semibold text-foreground">{d.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Hourly Demand Heatmap Grid */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-orange-500" />
                <CardTitle className="text-sm font-semibold">{t('busiestHours')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {!hasHourlyData ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                  <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
                </div>
              ) : (
                <div className="h-64 sm:h-72" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={hourlyDemand} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                      <XAxis
                        dataKey="hour"
                        tickFormatter={formatHour}
                        tick={{ fontSize: 9 }}
                        stroke="rgba(128,128,128,0.4)"
                        interval={1}
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
                        formatter={(value: number, name: string) => {
                          if (name === 'count') return [value, t('reservationsCount')];
                          if (name === 'avgWait') return [`${value} ${t('minutes')}`, t('avgWaitTime')];
                          return [value, name];
                        }}
                        labelFormatter={(label: number) => formatHour(label)}
                      />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="#f97316" fillOpacity={0.8} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Avg Wait By Hour - Line Chart */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-teal-500" />
              <CardTitle className="text-sm font-semibold">{t('avgWaitByHour')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {!hasHourlyData ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <Clock className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
              </div>
            ) : (
              <div className="h-48 sm:h-56" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={hourlyDemand} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                    <XAxis
                      dataKey="hour"
                      tickFormatter={formatHour}
                      tick={{ fontSize: 10 }}
                      stroke="rgba(128,128,128,0.4)"
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke="rgba(128,128,128,0.4)"
                      unit={t('min')}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'rgba(255,255,255,0.95)',
                        border: '1px solid rgba(0,0,0,0.08)',
                        borderRadius: '12px',
                        fontSize: '12px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                      }}
                      formatter={(value: number) => [`${value} ${t('minutes')}`, t('avgWaitTime')]}
                      labelFormatter={(label: number) => formatHour(label)}
                    />
                    <Line
                      type="monotone"
                      dataKey="avgWait"
                      stroke="#14b8a6"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: '#14b8a6' }}
                      activeDot={{ r: 5, fill: '#14b8a6' }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Service Peak Hours Table */}
      {servicePeakHours.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-500" />
                <CardTitle className="text-sm font-semibold">
                  {t('peakHours')} — {t('noShowByService')}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="max-h-48 overflow-y-auto custom-scrollbar">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-start py-2 px-3 font-semibold text-muted-foreground">{t('name')}</th>
                      <th className="text-center py-2 px-3 font-semibold text-muted-foreground">{t('peakHours')}</th>
                      <th className="text-center py-2 px-3 font-semibold text-muted-foreground">{t('reservationsCount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servicePeakHours
                      .reduce((acc: ServicePeakHour[], curr) => {
                        // Keep only the top peak hour per service
                        if (!acc.find((s) => s.serviceId === curr.serviceId)) {
                          acc.push(curr);
                        }
                        return acc;
                      }, [])
                      .map((s, idx) => (
                        <tr key={s.serviceId} className={idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-gray-800/20' : ''}>
                          <td className="py-2 px-3 font-medium text-foreground truncate max-w-[150px]">{s.serviceName}</td>
                          <td className="py-2 px-3 text-center">
                            <Badge variant="secondary" className="text-[10px] px-1.5 h-5 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                              {formatHour(s.peakHour)}
                            </Badge>
                          </td>
                          <td className="py-2 px-3 text-center font-semibold">{s.count}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Average Wait Time Trend Over Time */}
      {dailyWaitTrend.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-teal-500" />
                <CardTitle className="text-sm font-semibold">{t('avgWaitTrend') || 'Average Wait Time Trend'}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="h-56 sm:h-64" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={dailyWaitTrend} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(dateStr: string) => {
                        try {
                          const d = new Date(dateStr);
                          return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { month: 'short', day: 'numeric' });
                        } catch { return dateStr; }
                      }}
                      tick={{ fontSize: 9 }}
                      stroke="rgba(128,128,128,0.4)"
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke="rgba(128,128,128,0.4)"
                      unit={t('min')}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'rgba(255,255,255,0.95)',
                        border: '1px solid rgba(0,0,0,0.08)',
                        borderRadius: '12px',
                        fontSize: '12px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                      }}
                      formatter={(value: number, name: string) => {
                        if (name === 'avgWait') return [`${value} ${t('minutes')}`, t('avgWaitTime')];
                        if (name === 'count') return [value, t('reservationsCount')];
                        return [value, name];
                      }}
                      labelFormatter={(label: string) => {
                        try {
                          const d = new Date(label);
                          return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { month: 'short', day: 'numeric', weekday: 'short' });
                        } catch { return label; }
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="avgWait"
                      stroke="#14b8a6"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: '#14b8a6' }}
                      activeDot={{ r: 5, fill: '#14b8a6' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke="#f97316"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
