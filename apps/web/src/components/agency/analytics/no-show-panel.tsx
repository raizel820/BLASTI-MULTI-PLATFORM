'use client';

// ─── Task 42-e: no-show & cancellations panel ───────────────────────────────
// No-show + cancellation rates with the contract's delta (percentage POINTS,
// falling = GOOD) and a mini area chart of the daily no-show rate computed
// from the timeseries (noShow/total per point, gaps where total = 0).

import { useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { UserX, Ban, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ak } from './i18n-keys';
import type { AnalyticsKpis, AnalyticsTimeseriesPoint } from './types';

const NO_SHOW_COLOR = '#f43f5e';   // rose-500
const CANCEL_COLOR = '#ef4444';    // red-500

function DeltaInline({ delta }: { delta: number | null }) {
  if (delta === null || !Number.isFinite(delta)) return null;
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-muted-foreground bg-muted/60 rounded-full px-1.5 py-0.5" dir="ltr">
        <Minus className="h-3 w-3" />0pp
      </span>
    );
  }
  const good = rounded < 0; // falling no-show rate is good
  const Icon = rounded > 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
        good
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
          : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
      }`}
      dir="ltr"
    >
      <Icon className="h-3 w-3" />
      {Math.abs(rounded).toFixed(Math.abs(rounded) % 1 === 0 ? 0 : 1)}pp
    </span>
  );
}

interface RateTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ value?: number | string | null }>;
}

function RateTooltip({ active, label, payload }: RateTooltipProps) {
  const { t } = useLanguage();
  if (!active || !payload || payload.length === 0) return null;
  const v = payload[0]?.value;
  return (
    <div className="rounded-xl border border-border/60 bg-white/95 dark:bg-gray-900/95 px-3 py-1.5 shadow-lg backdrop-blur-sm text-xs" dir="ltr">
      <p className="font-bold text-foreground">{String(label ?? '')}</p>
      <p className="text-muted-foreground">
        {v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`} {t('noShowRate')}
      </p>
    </div>
  );
}

export function NoShowPanel({
  kpis,
  timeseries,
}: {
  kpis: AnalyticsKpis;
  timeseries: AnalyticsTimeseriesPoint[];
}) {
  const { t } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);

  const chartData = useMemo(
    () =>
      (timeseries ?? []).map((p) => {
        const total = safe(p.total);
        return {
          date: p.date,
          rate: total > 0 ? Math.round((safe(p.noShow) / total) * 1000) / 10 : null,
        };
      }),
    [timeseries]
  );

  const hasTrend = chartData.some((d) => d.rate !== null);

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-rose-500 to-red-600 flex items-center justify-center shrink-0">
            <UserX className="h-4 w-4 text-white" />
          </div>
          <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.noShow.title'))}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Rate tiles */}
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-rose-50 dark:bg-rose-900/15 border border-rose-100 dark:border-rose-900/30 p-3">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <UserX className="h-3.5 w-3.5 text-rose-500 shrink-0" />
                <span className="text-[11px] font-medium text-muted-foreground truncate">{t('noShowRate')}</span>
              </div>
              <DeltaInline delta={kpis.deltas?.noShowRate ?? null} />
            </div>
            <p className="mt-1 text-xl font-black text-foreground leading-none" dir="ltr">
              {safe(kpis.noShowRate).toFixed(1)}
              <span className="text-xs font-bold text-muted-foreground ms-0.5">%</span>
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              <span dir="ltr">{safe(kpis.noShow).toLocaleString()}</span> {t(ak('analyticsSection.noShow.noShowCount'))}
            </p>
          </div>
          <div className="rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-100 dark:border-red-900/30 p-3">
            <div className="flex items-center gap-1.5">
              <Ban className="h-3.5 w-3.5 text-red-500 shrink-0" />
              <span className="text-[11px] font-medium text-muted-foreground truncate">{t(ak('analyticsSection.noShow.cancelRate'))}</span>
            </div>
            <p className="mt-1 text-xl font-black text-foreground leading-none" dir="ltr">
              {safe(kpis.cancellationRate).toFixed(1)}
              <span className="text-xs font-bold text-muted-foreground ms-0.5">%</span>
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              <span dir="ltr">{safe(kpis.cancelled).toLocaleString()}</span> {t('cancelled')}
            </p>
          </div>
        </div>

        {/* Daily no-show rate trend */}
        {!hasTrend ? (
          <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
            <UserX className="h-7 w-7 text-rose-400 mb-1.5 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
              {t(ak('analyticsSection.noShow.trendTitle'))}
            </p>
            <div className="h-28" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="blastiNoShowRate" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={NO_SHOW_COLOR} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={NO_SHOW_COLOR} stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="rgba(128,128,128,0.4)" interval="preserveStartEnd" minTickGap={22} />
                  <YAxis tick={{ fontSize: 9 }} stroke="rgba(128,128,128,0.4)" width={28} unit="%" allowDecimals={false} />
                  <Tooltip content={<RateTooltip />} cursor={{ stroke: 'rgba(244,63,94,0.3)', strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="rate"
                    stroke={NO_SHOW_COLOR}
                    strokeWidth={2}
                    fill="url(#blastiNoShowRate)"
                    connectNulls
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
