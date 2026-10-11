'use client';

// ─── Task 42-e: reservations trend chart ────────────────────────────────────
// Composed Area/Line over the contract's timeseries: total (emerald area) +
// completed (teal area) + cancelled (red dashed line). The x-axis adapts to
// the period automatically: daily points ('YYYY-MM-DD') for 7d/30d/90d,
// monthly points ('YYYY-MM') for 12m — inferred from the payload itself.

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp } from 'lucide-react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { ak } from './i18n-keys';
import type { AnalyticsTimeseriesPoint } from './types';

const TOTAL_COLOR = '#10b981';   // emerald-500
const COMPLETED_COLOR = '#0d9488'; // teal-600
const CANCELLED_COLOR = '#ef4444'; // red-500

function isMonthlyPoint(date: string): boolean {
  return /^\d{4}-\d{2}$/.test(date);
}

function formatAxisDate(date: string, lang: string, monthly: boolean): string {
  try {
    const locale = getLocale(lang);
    if (monthly) {
      // 'YYYY-MM' — anchor mid-month so UTC parsing is unambiguous.
      const d = new Date(`${date}-15T00:00:00Z`);
      return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(d);
    }
    const d = new Date(`${date}T00:00:00Z`);
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  } catch {
    return date;
  }
}

interface TrendTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ dataKey?: string | number; value?: number | string }>;
}

function TrendTooltip({ active, label, payload }: TrendTooltipProps) {
  const { t, lang } = useLanguage();
  if (!active || !payload || payload.length === 0) return null;
  const monthly = typeof label === 'string' && isMonthlyPoint(label);
  const rows = [
    { key: 'total', color: TOTAL_COLOR, label: t('total') },
    { key: 'completed', color: COMPLETED_COLOR, label: t('completed') },
    { key: 'cancelled', color: CANCELLED_COLOR, label: t('cancelled') },
  ];
  return (
    <div className="rounded-xl border border-border/60 bg-white/95 dark:bg-gray-900/95 px-3 py-2 shadow-lg backdrop-blur-sm text-xs" dir="ltr">
      <p className="font-bold text-foreground mb-1">{formatAxisDate(String(label ?? ''), lang, monthly)}</p>
      {rows.map((r) => {
        const item = payload.find((p) => p.dataKey === r.key);
        if (!item) return null;
        return (
          <div key={String(r.key)} className="flex items-center gap-1.5 py-0.5">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
            <span className="text-muted-foreground">{r.label}:</span>
            <span className="font-bold text-foreground">{Number(item.value ?? 0).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ReservationsTrendChart({ timeseries }: { timeseries: AnalyticsTimeseriesPoint[] }) {
  const { t, lang } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const chartData = (timeseries ?? []).map((p) => ({
    date: p.date,
    total: safe(p.total),
    completed: safe(p.completed),
    cancelled: safe(p.cancelled),
  }));

  const monthly = chartData.length > 0 && isMonthlyPoint(chartData[0].date);
  const hasData = chartData.some((d) => d.total > 0 || d.completed > 0 || d.cancelled > 0);

  const legend = [
    { color: TOTAL_COLOR, label: t('total') },
    { color: COMPLETED_COLOR, label: t('completed') },
    { color: CANCELLED_COLOR, label: t('cancelled') },
  ];

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
            <TrendingUp className="h-4 w-4 text-white" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.trend.title'))}</CardTitle>
            <p className="text-[10px] text-muted-foreground">
              {monthly ? t(ak('analyticsSection.trend.monthlyAxis')) : t(ak('analyticsSection.trend.dailyAxis'))}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <TrendingUp className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            {/* Custom legend (Recharts' default legend fights RTL layouts) */}
            <div className="flex items-center gap-4 mb-2" dir="ltr">
              {legend.map((l) => (
                <span key={l.label} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                  {l.label}
                </span>
              ))}
            </div>
            <div className="h-60 sm:h-72" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="blastiTrendTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={TOTAL_COLOR} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={TOTAL_COLOR} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="blastiTrendCompleted" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={COMPLETED_COLOR} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={COMPLETED_COLOR} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(v: string) => formatAxisDate(v, lang, monthly)}
                    tick={{ fontSize: 9 }}
                    stroke="rgba(128,128,128,0.4)"
                    interval="preserveStartEnd"
                    minTickGap={18}
                  />
                  <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
                  <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.3)', strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="total"
                    stroke={TOTAL_COLOR}
                    strokeWidth={2}
                    fill="url(#blastiTrendTotal)"
                    isAnimationActive={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="completed"
                    stroke={COMPLETED_COLOR}
                    strokeWidth={2}
                    fill="url(#blastiTrendCompleted)"
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="cancelled"
                    stroke={CANCELLED_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
