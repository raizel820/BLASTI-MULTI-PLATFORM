'use client';

// ─── Task 54-d: My Overview section (doc-2 §31) ──────────────────────────────
// GET /api/staff/analytics/my-overview — FIXED-TODAY operational view (no
// period selector; the payload has a `today` block and no `resolved`). Metrics
// are scoped SERVER-SIDE to the staff row's agency + branch + counters; the
// live queue counts are agency-wide and the payload says so via `scope.note`.

import { useLanguage } from '@/hooks/use-language';
import { BadgeCheck, ClipboardList, Radio, Timer, TrendingUp, UserX, Users } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { TranslationKeys } from '@/i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { humanizeEnum } from '@/lib/enum-i18n';
import { ANALYTICS_STATUS_META } from './types';
import { ak } from './i18n-keys';
import type { StaffMyOverviewData } from './staff-types';
import { useStaffSectionData, type StaffSectionQuery } from './use-staff-section-data';
import { StaffForbiddenPanel } from './staff-forbidden';

export function StaffMyOverviewSection({ query }: { query: StaffSectionQuery }) {
  const { t } = useLanguage();
  const { data, state, refresh, isQueryReady } = useStaffSectionData<StaffMyOverviewData>(
    'my-overview',
    query,
    {
      // Zero-safe: an idle day still carries live queue counters — only mark
      // empty when literally nothing happened today AND nothing is live.
      isEmpty: (d) =>
        (d.today?.ticketsServed ?? 0) === 0 &&
        (d.today?.reservationsHandled ?? 0) === 0 &&
        (d.today?.currentlyServing ?? 0) === 0 &&
        (d.today?.waitingCount ?? 0) === 0 &&
        (d.today?.calledCount ?? 0) === 0 &&
        !(d.hourlyTraffic ?? []).some((p) => p.count > 0),
    },
  );

  if (state === 'forbidden') return <StaffForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const today = data.today;

  const hourData = Array.from({ length: 24 }, (_, hour) => {
    const found = (data.hourlyTraffic ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const hasHourData = hourData.some((p) => p.count > 0);

  const HourTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const hour = Number(props.label ?? 0);
    const hourLabel = hour < 12 ? `${hour === 0 ? 12 : hour}AM` : hour === 12 ? '12PM' : `${hour - 12}PM`;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{hourLabel}</p>
        <p className="text-muted-foreground">
          {t(ak('staffAnalytics.overview.reservations'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      <StatTiles
        items={[
          {
            icon: BadgeCheck,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('staffAnalytics.overview.servedToday')),
            value: safe(today.ticketsServed),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('staffAnalytics.overview.reservations')),
            value: safe(today.reservationsHandled),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('completionRate'),
            value: safe(today.completionRate),
            decimals: 1,
            suffix: '%',
          },
          {
            icon: Timer,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('avgWaitTime'),
            value: today.avgWaitingTimeMinutes === null ? 0 : safe(today.avgWaitingTimeMinutes),
            text: today.avgWaitingTimeMinutes === null ? '—' : undefined,
            decimals: today.avgWaitingTimeMinutes === null ? undefined : 1,
            suffix: today.avgWaitingTimeMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: Timer,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('staffAnalytics.overview.avgService')),
            value: today.avgServiceDurationMinutes === null ? 0 : safe(today.avgServiceDurationMinutes),
            text: today.avgServiceDurationMinutes === null ? '—' : undefined,
            decimals: today.avgServiceDurationMinutes === null ? undefined : 1,
            suffix: today.avgServiceDurationMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: UserX,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusNoShow'),
            value: safe(today.noShow),
          },
          {
            icon: UserX,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('cancelled'),
            value: safe(today.cancelled),
          },
          {
            icon: BadgeCheck,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('completed'),
            value: safe(today.completed),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Live now strip (agency-wide per scope.note) ── */}
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('staffAnalytics.overview.hourly'))}
            subtitle={t(ak('staffAnalytics.todayCaption'))}
            icon={TrendingUp}
            iconClass="from-emerald-500 to-teal-600"
            empty={!hasHourData}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h: number) => (h % 3 === 0 ? String(h) : '')}
                  tick={{ fontSize: 9 }}
                  stroke="rgba(128,128,128,0.4)"
                  interval={0}
                />
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
                <Tooltip content={<HourTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
                <Bar dataKey="count" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <CountListPanel
          title={t(ak('staffAnalytics.overview.statusTitle'))}
          icon={Radio}
          iconClass="from-amber-500 to-orange-500"
          rows={(today.statusDistribution ?? [])
            .map((s) => ({
              label: ANALYTICS_STATUS_META[s.status]
                ? t(ANALYTICS_STATUS_META[s.status].labelKey as TranslationKeys)
                : humanizeEnum(s.status),
              count: safe(s.count),
            }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      {/* ── Live-now counters (serving / waiting / called) ── */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t(ak('staffAnalytics.overview.servingNow')), value: safe(today.currentlyServing), tone: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400' },
          { label: t('waiting'), value: safe(today.waitingCount), tone: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
          { label: t('called'), value: safe(today.calledCount), tone: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400' },
        ].map((item) => (
          <div key={item.label} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 flex items-center gap-3">
            <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${item.tone}`}>
              <Users className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <p className="text-xl font-black text-foreground leading-none" dir="ltr">
                {item.value.toLocaleString()}
              </p>
              <p className="mt-1 text-[11px] font-medium text-muted-foreground truncate">{item.label}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
