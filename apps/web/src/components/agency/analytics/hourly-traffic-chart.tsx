'use client';

// ─── Task 42-e: hourly traffic bar chart ────────────────────────────────────
// BarChart of reservations per hour (0..23) with the busiest hour highlighted
// in amber and a caption underneath. 24h axes stay LTR inside RTL layouts.

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Flame, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { ak } from './i18n-keys';
import type { AnalyticsHourlyTrafficPoint, AnalyticsPeak } from './types';

const BAR_COLOR = '#10b981';      // emerald-500
const BUSIEST_COLOR = '#f59e0b';  // amber-500

function formatHour(h: number, lang: string): string {
  if (lang === 'ar') return `${h}:00`;
  if (h === 0) return '12AM';
  if (h < 12) return `${h}AM`;
  if (h === 12) return '12PM';
  return `${h - 12}PM`;
}

interface HourlyTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string }>;
}

function HourlyTooltip({ active, label, payload }: HourlyTooltipProps) {
  const { t, lang } = useLanguage();
  if (!active || !payload || payload.length === 0) return null;
  const hour = Number(label ?? 0);
  return (
    <div className="rounded-xl border border-border/60 bg-white/95 dark:bg-gray-900/95 px-3 py-1.5 shadow-lg backdrop-blur-sm text-xs" dir="ltr">
      <p className="font-bold text-foreground">{formatHour(hour, lang)}</p>
      <p className="text-muted-foreground">
        {Number(payload[0]?.value ?? 0).toLocaleString()} {t('reservationsCount')}
      </p>
    </div>
  );
}

export function HourlyTrafficChart({
  hourlyTraffic,
  peak,
}: {
  hourlyTraffic: AnalyticsHourlyTrafficPoint[];
  peak: AnalyticsPeak | null;
}) {
  const { t, lang } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const chartData = Array.from({ length: 24 }, (_, hour) => {
    const found = (hourlyTraffic ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });

  const hasData = chartData.some((d) => d.count > 0);
  const maxEntry = chartData.reduce((best, d) => (d.count > best.count ? d : best), { hour: -1, count: 0 });
  // Prefer the contract's peak.busiestHour when present; otherwise compute.
  const busiestHour = peak?.busiestHour ?? (maxEntry.count > 0 ? maxEntry.hour : null);
  const busiestCount = busiestHour !== null ? (chartData[busiestHour]?.count ?? 0) : 0;

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shrink-0">
            <Clock className="h-4 w-4 text-white" />
          </div>
          <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.hourly.title'))}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <Clock className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            <div className="h-56 sm:h-64" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                  <XAxis
                    dataKey="hour"
                    tickFormatter={(h: number) => (h % 3 === 0 ? String(h) : '')}
                    tick={{ fontSize: 9 }}
                    stroke="rgba(128,128,128,0.4)"
                    interval={0}
                  />
                  <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
                  <Tooltip content={<HourlyTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    {chartData.map((d) => (
                      <Cell key={d.hour} fill={d.hour === busiestHour ? BUSIEST_COLOR : BAR_COLOR} fillOpacity={d.hour === busiestHour ? 0.95 : 0.75} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {busiestHour !== null && (
              <p className="mt-2 flex items-center justify-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Flame className="h-3.5 w-3.5 text-amber-500" />
                {t(ak('analyticsSection.hourly.busiestHour'), { hour: formatHour(busiestHour, lang) })}
                <span className="font-bold text-foreground" dir="ltr">
                  · {busiestCount.toLocaleString()} {t('reservationsCount')}
                </span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
