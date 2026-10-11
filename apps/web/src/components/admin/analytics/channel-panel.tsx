'use client';

// ─── Task 4: reservations channel panel (online vs walk-in) ─────────────────
// The channel breakdown the super admin explicitly asked for, rendered
// PROMINENTLY right under the KPI cards:
//   • two big rate tiles — online reservation rate (emerald) and walk-in rate
//     (amber) with absolute counts;
//   • a stacked daily BarChart from channel.daily (online emerald / walk-in
//     amber) — x-axis adapts to daily ('YYYY-MM-DD') or monthly ('YYYY-MM')
//     points;
//   • share Progress bars.
// Chart + numeric zones stay LTR inside RTL layouts; palette matches the
// agency analytics (emerald/teal/cyan + amber), dark-mode safe.

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Globe, Store, Users } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { AnimatedValue } from './animated-value';
import { ak } from './i18n-keys';
import type { AdminChannelStats } from './types';
import type { AnalyticsKpis } from '@/components/agency/analytics/types';

const ONLINE_COLOR = '#10b981';  // emerald-500
const WALKIN_COLOR = '#f59e0b';  // amber-500

function isMonthlyDate(date: string): boolean {
  return /^\d{4}-\d{2}$/.test(date);
}

function formatAxisDate(date: string, lang: string): string {
  try {
    const locale = getLocale(lang);
    if (isMonthlyDate(date)) {
      const d = new Date(`${date}-15T00:00:00Z`);
      return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(d);
    }
    const d = new Date(`${date}T00:00:00Z`);
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
  } catch {
    return date;
  }
}

interface ChannelTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ dataKey?: string | number; value?: number | string }>;
}

function ChannelTooltip({ active, label, payload }: ChannelTooltipProps) {
  const { t, lang } = useLanguage();
  if (!active || !payload || payload.length === 0) return null;
  const rawDate = String(label ?? '');
  const online = Number(payload.find((p) => p.dataKey === 'online')?.value ?? 0);
  const walkIn = Number(payload.find((p) => p.dataKey === 'walkIn')?.value ?? 0);
  const total = online + walkIn;
  let dateLabel = rawDate;
  try {
    if (rawDate && (isMonthlyDate(rawDate) || /^\d{4}-\d{2}-\d{2}$/.test(rawDate))) {
      dateLabel = formatAxisDate(rawDate, lang);
    }
  } catch {
    /* keep raw */
  }
  return (
    <div className="rounded-xl border border-border/60 bg-white/95 dark:bg-gray-900/95 px-3 py-2 shadow-lg backdrop-blur-sm text-xs" dir="ltr">
      <p className="font-bold text-foreground mb-1">{dateLabel}</p>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ONLINE_COLOR }} />
        {t('onlineReservations')}: <span className="font-bold text-foreground">{online.toLocaleString()}</span>
      </p>
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: WALKIN_COLOR }} />
        {t('walkIn')}: <span className="font-bold text-foreground">{walkIn.toLocaleString()}</span>
      </p>
      <p className="mt-1 border-t border-border/60 pt-1 text-muted-foreground">
        {t('total')}: <span className="font-bold text-foreground">{total.toLocaleString()}</span>
      </p>
    </div>
  );
}

function RateTile({
  icon: Icon,
  rate,
  count,
  countLabel,
  label,
  tileClass,
  barClass,
}: {
  icon: typeof Globe;
  rate: number;
  count: number;
  countLabel: string;
  label: string;
  tileClass: string;
  barClass: string;
}) {
  return (
    <div className={`rounded-2xl p-4 ${tileClass}`}>
      <div className="flex items-center justify-between gap-2">
        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="text-2xl sm:text-3xl font-black leading-none" dir="ltr">
          <AnimatedValue value={Number.isFinite(rate) ? rate : 0} />%
        </span>
      </div>
      <p className="mt-2 text-[11px] font-bold truncate">{label}</p>
      <p className="text-[10px] font-medium opacity-80" dir="ltr">
        {count.toLocaleString()} · {countLabel}
      </p>
      <div className="mt-2.5 h-1.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barClass}`}
          style={{ width: `${Math.min(100, Math.max(0, Number.isFinite(rate) ? rate : 0))}%` }}
        />
      </div>
    </div>
  );
}

export function ChannelPanel({
  channel,
  kpis,
}: {
  channel: AdminChannelStats;
  kpis?: AnalyticsKpis | null;
}) {
  const { t, lang } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  // Prefer the channel block; fall back to the KPI extension fields.
  const onlineRate = channel ? safe(channel.onlineRate) : safe(kpis?.onlineRate);
  const walkInRate = channel ? safe(channel.walkInRate) : safe(kpis?.walkInRate);
  const onlineCount = safe(channel?.onlineCount);
  const walkInCount = safe(channel?.walkInCount);
  const total = safe(channel?.total);

  const chartData = (channel?.daily ?? []).map((d) => ({
    date: d.date,
    online: safe(d.online),
    walkIn: safe(d.walkIn),
  }));
  const hasDaily = chartData.some((d) => d.online + d.walkIn > 0);
  const hasAny = total > 0 || hasDaily;

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-emerald-600 flex items-center justify-center shrink-0">
            <Globe className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{t(ak('adminAnalytics.channel.title'))}</CardTitle>
            <p className="text-[11px] text-muted-foreground truncate">{t(ak('adminAnalytics.channel.subtitle'))}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Big rate tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <RateTile
            icon={Globe}
            rate={onlineRate}
            count={onlineCount}
            countLabel={t('onlineReservations')}
            label={t(ak('adminAnalytics.channel.onlineRate'))}
            tileClass="bg-emerald-50 text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-800/40"
            barClass="bg-emerald-500 dark:bg-emerald-400"
          />
          <RateTile
            icon={Store}
            rate={walkInRate}
            count={walkInCount}
            countLabel={t('walkIn')}
            label={t(ak('adminAnalytics.channel.walkInRate'))}
            tileClass="bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/40"
            barClass="bg-amber-500 dark:bg-amber-400"
          />
        </div>

        {!hasAny ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <Users className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            {/* Daily stacked split */}
            {hasDaily && (
              <div dir="ltr" className="h-44 sm:h-52 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 4, left: -22, bottom: 0 }} barCategoryGap="18%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-border" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(v: string) => formatAxisDate(String(v), lang)}
                      tick={{ fontSize: 10 }}
                      stroke="currentColor"
                      className="text-muted-foreground"
                      interval="preserveStartEnd"
                      minTickGap={18}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke="currentColor"
                      className="text-muted-foreground"
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip content={<ChannelTooltip />} cursor={{ fill: 'rgba(16, 185, 129, 0.06)' }} />
                    <Bar dataKey="online" stackId="ch" fill={ONLINE_COLOR} radius={[0, 0, 0, 0]} maxBarSize={26} />
                    <Bar dataKey="walkIn" stackId="ch" fill={WALKIN_COLOR} radius={[3, 3, 0, 0]} maxBarSize={26} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Share progress bars */}
            <div className="space-y-2.5" aria-label={t(ak('adminAnalytics.channel.share'))}>
              <div>
                <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
                  <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    {t('onlineReservations')}
                  </span>
                  <span className="text-muted-foreground" dir="ltr">
                    {onlineCount.toLocaleString()} · {onlineRate.toFixed(1)}%
                  </span>
                </div>
                <Progress
                  value={onlineRate}
                  className="h-2 bg-emerald-100 dark:bg-emerald-900/30 [&>div]:bg-emerald-500"
                  aria-label={t(ak('adminAnalytics.channel.onlineRate'))}
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
                  <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                    <span className="h-2 w-2 rounded-full bg-amber-500" />
                    {t('walkIn')}
                  </span>
                  <span className="text-muted-foreground" dir="ltr">
                    {walkInCount.toLocaleString()} · {walkInRate.toFixed(1)}%
                  </span>
                </div>
                <Progress
                  value={walkInRate}
                  className="h-2 bg-amber-100 dark:bg-amber-900/30 [&>div]:bg-amber-500"
                  aria-label={t(ak('adminAnalytics.channel.walkInRate'))}
                />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
