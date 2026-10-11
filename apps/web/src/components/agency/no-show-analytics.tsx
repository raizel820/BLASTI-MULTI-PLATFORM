'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  UserX,
  TrendingUp,
  AlertTriangle,
  RotateCcw,
  BarChart3,
  Lightbulb,
  Clock,
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
  Cell,
} from 'recharts';

interface NoShowSummary {
  totalReservations: number;
  noShows: number;
  cancelled: number;
  noShowRate: number;
  cancelRate: number;
  reclaimedNoShows: number;
  reclaimRate: number;
}

interface DailyTrendItem {
  date: string;
  total: number;
  noShows: number;
  rate: number;
}

interface ByServiceItem {
  serviceId: string;
  serviceName: string;
  total: number;
  noShows: number;
  rate: number;
}

interface ByHourItem {
  hour: number;
  total: number;
  noShows: number;
  rate: number;
}

interface NoShowData {
  summary: NoShowSummary;
  dailyTrend: DailyTrendItem[];
  byService: ByServiceItem[];
  byHour: ByHourItem[];
}

interface NoShowAnalyticsProps {
  agencyId: string;
}

const PERIOD_OPTIONS = [
  { value: '7', labelKey: 'last7Days' },
  { value: '30', labelKey: 'last30Days' },
  { value: '90', labelKey: 'last90Days' },
] as const;

export function NoShowAnalytics({ agencyId }: NoShowAnalyticsProps) {
  const { t, lang } = useLanguage();
  const [period, setPeriod] = useState('30');
  const [data, setData] = useState<NoShowData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!agencyId) return;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/agency/no-show-analytics?agencyId=${encodeURIComponent(agencyId)}&period=${period}`
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
  }, [agencyId, period]);

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

  const formatDate = (dateStr: string | null | undefined) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '—';
    }
  };

  const noShowColor = (rate: number) => {
    if (rate <= 10) return '#10b981'; // emerald
    if (rate <= 25) return '#f59e0b'; // amber
    return '#ef4444'; // red
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-64 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
        <UserX className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
        <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
      </div>
    );
  }

  const summary = data.summary;

  // Destructure with fallbacks to handle partial API responses
  const dailyTrend = data.dailyTrend ?? [];
  const byService = data.byService ?? [];
  const byHour = data.byHour ?? [];

  // Filter out items with null/undefined dates from the daily trend
  const validDailyTrend = dailyTrend.filter(
    (d) => d && d.date && !Number.isNaN(new Date(d.date).getTime())
  );
  // Daily trend is "meaningful" when there is at least one non-null date
  // AND there is some variation in the rate values (otherwise the line is flat at 0).
  const hasDailyTrendData =
    validDailyTrend.length > 0 &&
    validDailyTrend.some((d) => (d.rate ?? 0) > 0 || (d.total ?? 0) > 0);

  // By service is meaningful when at least one service has at least one no-show
  const hasByServiceData =
    byService.length > 0 && byService.some((s) => (s.noShows ?? 0) > 0);

  // By hour is meaningful when at least one hour has a no-show
  const hasByHourData =
    byHour.length > 0 && byHour.some((h) => (h.noShows ?? 0) > 0 || (h.rate ?? 0) > 0);

  return (
    <div className="space-y-4">
      {/* Header with period selector */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center">
            <UserX className="h-5 w-5 text-white" />
          </div>
          <div>
            <h3 className="text-base font-bold text-foreground">{t('noShowAnalytics')}</h3>
            <p className="text-xs text-muted-foreground">{t('noShowTrendDesc')}</p>
          </div>
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-[140px] h-9 text-xs rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIOD_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                {t(opt.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* No-Show Rate */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                  <UserX className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
                </div>
                <span className="text-[11px] font-medium text-muted-foreground">{t('noShowRate')}</span>
              </div>
              <p className="text-2xl font-black" style={{ color: noShowColor(summary.noShowRate) }}>
                {summary.noShowRate}%
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">
                {summary.noShows} / {summary.totalReservations}
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Total Reservations */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <BarChart3 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <span className="text-[11px] font-medium text-muted-foreground">{t('totalReservations')}</span>
              </div>
              <p className="text-2xl font-black text-foreground">{summary.totalReservations}</p>
              <p className="text-[10px] text-muted-foreground mt-1">{t('reservationsCount')}</p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Cancel Rate */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                </div>
                <span className="text-[11px] font-medium text-muted-foreground">{t('cancelRate')}</span>
              </div>
              <p className="text-2xl font-black text-amber-600 dark:text-amber-400">{summary.cancelRate}%</p>
              <p className="text-[10px] text-muted-foreground mt-1">{summary.cancelled} {t('cancelled')}</p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Reclaim Rate */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-0 shadow-sm overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-7 w-7 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center">
                  <RotateCcw className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                </div>
                <span className="text-[11px] font-medium text-muted-foreground">{t('reclaimRate')}</span>
              </div>
              <p className="text-2xl font-black text-teal-600 dark:text-teal-400">{summary.reclaimRate}%</p>
              <p className="text-[10px] text-muted-foreground mt-1">{summary.reclaimedNoShows} {t('reclaimedNoShows')}</p>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* No-Show Trend Line Chart */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-rose-500" />
              <CardTitle className="text-sm font-semibold">{t('noShowTrend')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {!hasDailyTrendData ? (
              <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
              </div>
            ) : (
              <div className="h-56 sm:h-64" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={validDailyTrend} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatDate}
                      tick={{ fontSize: 10 }}
                      stroke="rgba(128,128,128,0.4)"
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke="rgba(128,128,128,0.4)"
                      unit="%"
                      width={35}
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
                        if (name === 'rate') return [`${value}%`, t('noShowRate')];
                        if (name === 'total') return [value, t('reservationsCount')];
                        return [value, name];
                      }}
                      labelFormatter={(label: string) => formatDate(label)}
                    />
                    <Line
                      type="monotone"
                      dataKey="rate"
                      stroke="#ef4444"
                      isAnimationActive={false}
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: '#ef4444' }}
                      activeDot={{ r: 5, fill: '#ef4444' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="total"
                      stroke="#10b981"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* By Service + By Hour Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* No-Show By Service - Bar Chart */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-amber-500" />
                <CardTitle className="text-sm font-semibold">{t('noShowByService')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {!hasByServiceData ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                  <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
                </div>
              ) : (
                <>
                  <div className="h-48 sm:h-56" dir="ltr">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={byService.slice(0, 7)} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                        <XAxis
                          dataKey="serviceName"
                          tick={{ fontSize: 9 }}
                          stroke="rgba(128,128,128,0.4)"
                          interval={0}
                          angle={-20}
                          textAnchor="end"
                          height={50}
                        />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          stroke="rgba(128,128,128,0.4)"
                          unit="%"
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
                            if (name === 'rate') return [`${value}%`, t('noShowRate')];
                            return [value, name];
                          }}
                        />
                        <Bar dataKey="rate" radius={[6, 6, 0, 0]}>
                          {byService.slice(0, 7).map((entry, index) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={noShowColor(entry.rate)}
                              fillOpacity={0.85}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Top services table */}
                  <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                    <div className="max-h-40 overflow-y-auto custom-scrollbar">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-start py-1.5 px-2 font-semibold text-muted-foreground">{t('name')}</th>
                            <th className="text-center py-1.5 px-2 font-semibold text-muted-foreground">{t('reservationsCount')}</th>
                            <th className="text-center py-1.5 px-2 font-semibold text-muted-foreground">{t('noShowCount')}</th>
                            <th className="text-center py-1.5 px-2 font-semibold text-muted-foreground">{t('rate')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {byService.map((s, idx) => (
                            <tr key={s.serviceId} className={idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-gray-800/20' : ''}>
                              <td className="py-1.5 px-2 font-medium text-foreground truncate max-w-[120px]">{s.serviceName}</td>
                              <td className="py-1.5 px-2 text-center">{s.total}</td>
                              <td className="py-1.5 px-2 text-center text-rose-600 dark:text-rose-400">{s.noShows}</td>
                              <td className="py-1.5 px-2 text-center">
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 h-5"
                                  style={{
                                    backgroundColor: noShowColor(s.rate) + '20',
                                    color: noShowColor(s.rate),
                                  }}
                                >
                                  {s.rate}%
                                </Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* No-Show By Hour - Bar Chart */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-orange-500" />
                <CardTitle className="text-sm font-semibold">{t('noShowByHour')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {!hasByHourData ? (
                <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                  <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                  <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
                </div>
              ) : (
                <div className="h-72 sm:h-80" dir="ltr">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byHour} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
                      <XAxis
                        dataKey="hour"
                        tickFormatter={formatHour}
                        tick={{ fontSize: 9 }}
                        stroke="rgba(128,128,128,0.4)"
                      />
                      <YAxis
                        tick={{ fontSize: 10 }}
                        stroke="rgba(128,128,128,0.4)"
                        unit="%"
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
                          if (name === 'rate') return [`${value}%`, t('noShowRate')];
                          if (name === 'total') return [value, t('reservationsCount')];
                          if (name === 'noShows') return [value, t('noShowCount')];
                          return [value, name];
                        }}
                        labelFormatter={(label: number) => formatHour(label)}
                      />
                      <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                        {byHour.map((entry, index) => (
                          <Cell
                            key={`cell-hour-${index}`}
                            fill={noShowColor(entry.rate)}
                            fillOpacity={0.8}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Suggestions for Reducing No-Shows */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-sm font-semibold">{t('noShowSuggestions') || 'Suggestions for Reducing No-Shows'}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-3">
              {/* Dynamic suggestions based on data */}
              {data.summary.noShowRate > 20 && (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/20">
                  <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-red-700 dark:text-red-400">{t('highNoShowAlert') || 'High No-Show Rate Alert'}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t('highNoShowAlertDesc') || 'Your no-show rate is above 20%. Consider implementing SMS reminders and reducing wait times.'}</p>
                  </div>
                </div>
              )}

              {/* Peak no-show hours suggestion */}
              {byHour.filter(h => h.rate > 15).length > 0 && (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/20">
                  <Clock className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">{t('peakNoShowHours') || 'Peak No-Show Hours Detected'}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('peakNoShowHoursDesc') || 'High no-show rates occur at'} {' '}
                      {byHour.filter(h => h.rate > 15).map(h => formatHour(h.hour)).join(', ')}
                      {'. '}{t('peakNoShowHoursTip') || 'Consider sending extra reminders during these hours or offering walk-in priority slots.'}
                    </p>
                  </div>
                </div>
              )}

              {/* Service-specific suggestion */}
              {byService.filter(s => s.rate > 20).length > 0 && (
                <div className="flex items-start gap-3 p-3 rounded-xl bg-purple-50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-900/20">
                  <BarChart3 className="h-4 w-4 text-purple-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-semibold text-purple-700 dark:text-purple-400">{t('highNoShowServices') || 'Services with High No-Show Rates'}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {byService.filter(s => s.rate > 20).map(s => s.serviceName).join(', ')}
                      {' '}{t('highNoShowServicesTip') || 'have no-show rates above 20%. Consider requiring confirmation or deposit for these services.'}
                    </p>
                  </div>
                </div>
              )}

              {/* General suggestions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/10">
                  <span className="text-emerald-600 text-sm mt-0.5">💡</span>
                  <p className="text-xs text-muted-foreground">{t('suggestionSmsReminder') || 'Send SMS reminders 30 minutes before the scheduled time.'}</p>
                </div>
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/10">
                  <span className="text-emerald-600 text-sm mt-0.5">💡</span>
                  <p className="text-xs text-muted-foreground">{t('suggestionReclaim') || 'Allow no-show customers to reclaim their spot within a grace period.'}</p>
                </div>
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/10">
                  <span className="text-emerald-600 text-sm mt-0.5">💡</span>
                  <p className="text-xs text-muted-foreground">{t('suggestionWaitTime') || 'Reduce estimated wait times to keep customers engaged.'}</p>
                </div>
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/10">
                  <span className="text-emerald-600 text-sm mt-0.5">💡</span>
                  <p className="text-xs text-muted-foreground">{t('suggestionConfirmation') || 'Require customers to confirm their attendance when their turn is approaching.'}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
