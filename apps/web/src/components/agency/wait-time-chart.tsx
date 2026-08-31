'use client';

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock, TrendingUp, TrendingDown, Minus, Activity } from 'lucide-react';
import { motion } from 'framer-motion';

interface HourlyData {
  hour: number;
  avgWaitTime: number;
  servedCount: number;
}

interface WaitTimeChartProps {
  data: HourlyData[];
  currentHour?: number;
}

export function WaitTimeChart({ data, currentHour }: WaitTimeChartProps) {
  const { t } = useLanguage();

  // Generate 24h data if not provided (synthetic fallback)
  // Use deterministic values to avoid hydration mismatch (no Math.random)
  const fallbackData = Array.from({ length: 12 }, (_, i) => ({
    hour: (i + 7), // 7 AM to 6 PM
    avgWaitTime: Math.floor(Math.sin(i * 0.5) * 15 + 20 + Math.sin(i * 1.7 + 3) * 5),
    servedCount: Math.floor(Math.cos(i * 0.3) * 5 + 8 + Math.cos(i * 2.3 + 1) * 2.5),
  }));

  // Sanitize API data: coerce null/undefined/NaN/Infinity to 0 to prevent NaN in calculations
  // Note: `?? 0` does NOT catch NaN — must use Number.isFinite()
  const safeNum = (v: unknown): number => Number.isFinite(v as number) ? (v as number) : 0;

  const chartData: HourlyData[] = (data?.length ?? 0) > 0
    ? data.map((d) => ({
        hour: safeNum(d.hour),
        avgWaitTime: safeNum(d.avgWaitTime),
        servedCount: safeNum(d.servedCount),
      }))
    : fallbackData;

  const maxWait = Math.max(...chartData.map(d => d.avgWaitTime), 1);
  const maxServed = Math.max(...chartData.map(d => d.servedCount), 1);
  const hasData = chartData.some(d => d.avgWaitTime > 0 || d.servedCount > 0);

  // Calculate trend (compare first half vs second half average)
  const firstHalf = chartData.slice(0, Math.floor(chartData.length / 2));
  const secondHalf = chartData.slice(Math.floor(chartData.length / 2));
  const avgFirst = firstHalf.reduce((s, d) => s + d.avgWaitTime, 0) / (firstHalf.length || 1);
  const avgSecond = secondHalf.reduce((s, d) => s + d.avgWaitTime, 0) / (secondHalf.length || 1);
  const trendDiff = avgSecond - avgFirst;
  const trend = Math.abs(trendDiff) < 2 ? 'stable' : trendDiff > 0 ? 'worsening' : 'improving';

  const trendConfig = {
    improving: { icon: TrendingUp, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/20', label: t('improving') },
    worsening: { icon: TrendingDown, color: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-900/20', label: t('worsening') },
    stable: { icon: Minus, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', label: t('stable') },
  };

  const TrendIcon = trendConfig[trend].icon;

  const formatHour = (h: number) => {
    if (h === 0) return '12AM';
    if (h < 12) return `${h}AM`;
    if (h === 12) return '12PM';
    return `${h - 12}PM`;
  };

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <Clock className="h-4 w-4 text-white" />
            </div>
            <CardTitle className="text-sm font-semibold">{t('waitTimeChart')}</CardTitle>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${trendConfig[trend].bg} ${trendConfig[trend].color}`}>
            <TrendIcon className="h-3 w-3" />
            {trendConfig[trend].label}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <Clock className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet') || t('noWaitTimeData') || 'No wait time data yet — data will appear once customers are served.'}</p>
          </div>
        ) : (
          <>
            {/* Chart area */}
            <div className="relative h-28 flex items-end gap-[3px] sm:gap-1">
              {/* Grid lines */}
              <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="border-t border-dashed border-gray-100 dark:border-gray-800" />
                ))}
              </div>

              {chartData.map((d, idx) => {
                const waitHeight = (d.avgWaitTime / maxWait) * 100;
                const isNow = currentHour !== undefined && d.hour === currentHour;

                return (
                  <div key={`wait-${idx}-${d.hour}`} className="flex-1 flex flex-col items-center gap-0.5 relative group">
                    {/* Tooltip on hover */}
                    <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-[10px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                      {formatHour(d.hour)}: {d.avgWaitTime}{t('min')}
                    </div>

                    {/* Bar */}
                    <div className="w-full flex flex-col items-center justify-end" style={{ height: '100%' }}>
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: `${Math.max(waitHeight, 4)}%` }}
                        transition={{ duration: 0.6, delay: idx * 0.04, ease: 'easeOut' }}
                        className={`w-full rounded-t-sm transition-colors duration-200 ${
                          isNow
                            ? 'bg-gradient-to-t from-emerald-600 to-emerald-400 shadow-sm shadow-emerald-500/30'
                            : 'bg-gradient-to-t from-blue-500/80 to-blue-400/60 dark:from-blue-400/70 dark:to-blue-300/50 group-hover:from-blue-500 group-hover:to-blue-400 dark:group-hover:from-blue-400 dark:group-hover:to-blue-300'
                        }`}
                        style={{ minHeight: '4px' }}
                      />
                    </div>

                    {/* Hour label */}
                    <span className={`text-[9px] text-muted-foreground mt-1 ${isNow ? 'font-bold text-emerald-600 dark:text-emerald-400' : ''}`}>
                      {idx % 2 === 0 ? formatHour(d.hour).replace('AM', '').replace('PM', '') : ''}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Throughput row */}
            <div className="mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800">
              <div className="flex items-center gap-2 mb-2">
                <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">{t('throughputLabel')}</span>
              </div>
              <div className="flex items-end gap-[3px] sm:gap-1 h-8">
                {chartData.map((d, idx) => {
                  const servedHeight = (d.servedCount / maxServed) * 100;
                  return (
                    <motion.div
                      key={`throughput-${idx}-${d.hour}`}
                      initial={{ height: 0 }}
                      animate={{ height: `${Math.max(servedHeight, 8)}%` }}
                      transition={{ duration: 0.5, delay: idx * 0.04 + 0.3, ease: 'easeOut' }}
                      className="flex-1 rounded-sm bg-gradient-to-t from-teal-500/40 to-teal-400/20 dark:from-teal-400/30 dark:to-teal-300/15"
                      style={{ minHeight: '3px' }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Summary stats */}
            <div className="grid grid-cols-3 gap-2 mt-2">
              <div className="text-center p-1.5 rounded-lg bg-blue-50/50 dark:bg-blue-900/10">
                <p className="text-base font-bold text-blue-600 dark:text-blue-400">
                  {Math.round(chartData.reduce((s, d) => s + d.avgWaitTime, 0) / (chartData.length || 1))}
                  <span className="text-xs font-normal ms-0.5">{t('min')}</span>
                </p>
                <p className="text-[10px] text-muted-foreground">{t('avgWaitTime')}</p>
              </div>
              <div className="text-center p-1.5 rounded-lg bg-teal-50/50 dark:bg-teal-900/10">
                <p className="text-base font-bold text-teal-600 dark:text-teal-400">
                  {chartData.reduce((s, d) => s + d.servedCount, 0)}
                </p>
                <p className="text-[10px] text-muted-foreground">{t('servedToday')}</p>
              </div>
              <div className="text-center p-1.5 rounded-lg bg-purple-50/50 dark:bg-purple-900/10">
                <p className="text-base font-bold text-purple-600 dark:text-purple-400">
                  {Math.round(chartData.reduce((s, d) => s + d.servedCount, 0) / (chartData.length || 1) * 60 / 30)}
                </p>
                <p className="text-[10px] text-muted-foreground">{t('customersPerHour')}</p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
