'use client';

// ─── Task 54-c: Working Hours section (doc-2 §24 — OWNER-ONLY server-side) ───
// GET /api/agency/analytics/working-hours — agency-level operational report:
// reservations & customers served by hour, avg wait by hour, weekday traffic,
// peak hour/day + the agency's configured operating hours. The shell hides
// this tab from non-owner viewers (staff → 403 server-side per §37).

import { useLanguage } from '@/hooks/use-language';
import { Clock, TrendingUp, Users } from 'lucide-react';
import { getLocale } from '@/components/agency/dashboard/helpers';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerWorkingHoursData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

// 2023-01-01 was a Sunday — stable anchor for weekday labels (0 = Sunday),
// same technique as heatmap-panel (locale-native, no i18n keys needed).
const SUNDAY_ANCHOR = Date.UTC(2023, 0, 1);

function weekdayLabel(weekday: number, lang: string): string {
  try {
    const fmt = new Intl.DateTimeFormat(getLocale(lang), { weekday: 'short', timeZone: 'UTC' });
    return fmt.format(new Date(SUNDAY_ANCHOR + weekday * 86_400_000));
  } catch {
    return String(weekday);
  }
}

export function OwnerWorkingHoursSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerWorkingHoursData>(
    'working-hours',
    query,
    // Zero-safe: no reservations in the period → all counts 0.
    { isEmpty: (d) => !(d.reservationsByHour ?? []).some((p) => p.count > 0) && !(d.weekdayTraffic ?? []).some((p) => p.count > 0) },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const hourLabel = (hour: number): string =>
    lang === 'ar' ? `${hour}:00` : hour < 12 ? `${hour === 0 ? 12 : hour}AM` : hour === 12 ? '12PM' : `${hour - 12}PM`;

  const reservationsByHour = Array.from({ length: 24 }, (_, hour) => {
    const found = (data.reservationsByHour ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const servedByHour = Array.from({ length: 24 }, (_, hour) => {
    const found = (data.servedByHour ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const combined = reservationsByHour.map((r) => ({
    hour: r.hour,
    reservations: r.count,
    served: servedByHour.find((s) => s.hour === r.hour)?.count ?? 0,
  }));
  const hasHourly = combined.some((p) => p.reservations > 0 || p.served > 0);

  const weekdayData = (data.weekdayTraffic ?? [])
    .map((p) => ({
      weekday: p.weekday,
      label: weekdayLabel(p.weekday, lang),
      count: safe(p.count),
    }))
    .sort((a, b) => a.weekday - b.weekday);
  const hasWeekday = weekdayData.some((p) => p.count > 0);

  const HourTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{hourLabel(Number(props.label ?? 0))}</p>
        {props.payload.map((p) => (
          <p key={String(p.dataKey)} className="text-muted-foreground">
            {p.dataKey === 'reservations' ? t('totalReservations') : t('ownerAnalytics.workingHours.served')}:{' '}
            <span className="font-bold text-foreground">{Number(p.value ?? 0).toLocaleString()}</span>
          </p>
        ))}
      </ChartTooltipBox>
    );
  };

  const WeekdayTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t('totalReservations')}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const workingDays = data.operatingHours.workingDays
    ? data.operatingHours.workingDays
        .split(',')
        .map((d) => weekdayLabel(Number(d.trim()), lang))
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <div className="space-y-4">
      {/* ── Configured operating hours ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
        <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
              <Clock className="h-4.5 w-4.5 text-white" />
            </div>
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                {t(ak('ownerAnalytics.workingHours.operating'))}
              </p>
              <p className="text-sm font-black text-foreground leading-tight" dir="ltr">
                {data.operatingHours.start && data.operatingHours.end
                  ? `${data.operatingHours.start} – ${data.operatingHours.end}`
                  : '—'}
              </p>
            </div>
          </div>
          {workingDays && (
            <div className="min-w-0">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                {t(ak('ownerAnalytics.workingHours.days'))}
              </p>
              <p className="text-xs font-bold text-foreground truncate max-w-xs" title={workingDays}>
                {workingDays}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <StatTiles
        items={[
          {
            icon: TrendingUp,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('ownerAnalytics.workingHours.busiestHour')),
            value: data.peak.busiestHour === null ? 0 : data.peak.busiestHour,
            text: data.peak.busiestHour === null ? '—' : hourLabel(data.peak.busiestHour),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.workingHours.busiestWeekday')),
            value: 0,
            text:
              data.peak.busiestWeekday === null
                ? '—'
                : weekdayLabel(data.peak.busiestWeekday, lang),
          },
          {
            icon: Users,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('ownerAnalytics.workingHours.served'),
            value: servedByHour.reduce((sum, p) => sum + p.count, 0),
          },
          {
            icon: Users,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('totalReservations'),
            value: reservationsByHour.reduce((sum, p) => sum + p.count, 0),
          },
        ]}
      />

      <ChartCard
        title={t(ak('ownerAnalytics.workingHours.byHour'))}
        icon={TrendingUp}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasHourly}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={combined} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
            <XAxis
              dataKey="hour"
              tickFormatter={(h: number) => (h % 3 === 0 ? String(h) : '')}
              tick={{ fontSize: 9 }}
              stroke="rgba(128,128,128,0.4)"
              interval={0}
            />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
            <Tooltip content={<HourTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="reservations" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            <Bar dataKey="served" fill="#14b8a6" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title={t(ak('ownerAnalytics.workingHours.weekday'))}
          icon={TrendingUp}
          iconClass="from-amber-500 to-orange-500"
          empty={!hasWeekday}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekdayData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="rgba(128,128,128,0.4)" tickLine={false} interval={0} />
              <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
              <Tooltip content={<WeekdayTooltip />} cursor={{ fill: 'rgba(245,158,11,0.08)' }} />
              <Bar dataKey="count" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={34} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <SectionTablePanel
          title={t(ak('ownerAnalytics.workingHours.waitByHour'))}
          icon={Clock}
          iconClass="from-cyan-500 to-teal-600"
          rows={data.avgWaitByHour ?? []}
          getKey={(r) => `hour-${r.hour}`}
          columns={[
            {
              header: t(ak('ownerAnalytics.workingHours.hour')),
              className: 'flex-1 min-w-0',
              cell: (r) => <span className="font-bold">{hourLabel(r.hour)}</span>,
            },
            {
              header: t('avgWaitTime'),
              className: 'w-24 text-center shrink-0',
              align: 'center',
              cell: (r) => (
                <span dir="ltr">
                  {r.avgWaitMinutes === null ? '—' : `${safe(r.avgWaitMinutes).toFixed(1)} ${t('min')}`}
                </span>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
