'use client';

// ─── Task 54-d: My Performance section (doc-2 §33) ───────────────────────────
// GET /api/staff/analytics/my-performance — period-scoped view of the staff
// member's OWN authorized activity (server-locked to their agency + branch +
// counters; unrelated staff rows are never exposed). Accepts the shared period
// selector (default 30d).

import { useLanguage } from '@/hooks/use-language';
import { BadgeCheck, ClipboardList, Clock, Timer, TrendingUp, UserCog, Users } from 'lucide-react';
import {
  AreaChart,
  Area,
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
  SectionTablePanel,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
} from '@/components/admin/analytics/section-ui';
import { humanizeEnum } from '@/lib/enum-i18n';
import { ANALYTICS_STATUS_META } from './types';
import { ak } from './i18n-keys';
import type { StaffPerformanceData } from './staff-types';
import { useStaffSectionData, type StaffSectionQuery } from './use-staff-section-data';
import { StaffForbiddenPanel } from './staff-forbidden';

export function StaffPerformanceSection({ query }: { query: StaffSectionQuery }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useStaffSectionData<StaffPerformanceData>(
    'my-performance',
    query,
    {
      // Zero-safe: a quiet period is all-zero counters + null averages.
      isEmpty: (d) =>
        (d.kpis?.ticketsCalled ?? 0) === 0 &&
        (d.kpis?.ticketsServed ?? 0) === 0 &&
        (d.kpis?.cancelled ?? 0) === 0 &&
        (d.kpis?.noShow ?? 0) === 0 &&
        !(d.timeseries ?? []).some((p) => p.total > 0),
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <StaffForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const kpis = data.kpis;

  const trendData = (data.timeseries ?? []).map((p) => ({
    bucket: p.bucket,
    total: safe(p.total),
    completed: safe(p.completed),
  }));
  const hasTrend = trendData.length > 0 && trendData.some((p) => p.total > 0);

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{formatBucket(String(props.label ?? ''), lang)}</p>
        {props.payload.map((p) => (
          <p key={String(p.dataKey)} className="text-muted-foreground">
            {p.dataKey === 'completed' ? t('completed') : t('totalReservations')}:{' '}
            <span className="font-bold text-foreground">{Number(p.value ?? 0).toLocaleString()}</span>
          </p>
        ))}
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      {resolvedLabel && (
        <p className="text-[11px] text-muted-foreground -mt-1" dir="ltr">{resolvedLabel}</p>
      )}

      <StatTiles
        items={[
          {
            icon: ClipboardList,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('staffAnalytics.perf.called')),
            value: safe(kpis.ticketsCalled),
          },
          {
            icon: BadgeCheck,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('staffAnalytics.perf.served')),
            value: safe(kpis.ticketsServed),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t('completionRate'),
            value: safe(kpis.completionRate),
            decimals: 1,
            suffix: '%',
          },
          {
            icon: Timer,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('staffAnalytics.perf.avgHandling')),
            value: kpis.avgHandlingTimeMinutes === null ? 0 : safe(kpis.avgHandlingTimeMinutes),
            text: kpis.avgHandlingTimeMinutes === null ? '—' : undefined,
            decimals: kpis.avgHandlingTimeMinutes === null ? undefined : 1,
            suffix: kpis.avgHandlingTimeMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: Timer,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('staffAnalytics.overview.avgService')),
            value: kpis.avgServiceDurationMinutes === null ? 0 : safe(kpis.avgServiceDurationMinutes),
            text: kpis.avgServiceDurationMinutes === null ? '—' : undefined,
            decimals: kpis.avgServiceDurationMinutes === null ? undefined : 1,
            suffix: kpis.avgServiceDurationMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: Timer,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('avgWaitTime'),
            value: kpis.avgWaitingTimeMinutes === null ? 0 : safe(kpis.avgWaitingTimeMinutes),
            text: kpis.avgWaitingTimeMinutes === null ? '—' : undefined,
            decimals: kpis.avgWaitingTimeMinutes === null ? undefined : 1,
            suffix: kpis.avgWaitingTimeMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: UserCog,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('cancelled'),
            value: safe(kpis.cancelled),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('staffAnalytics.perf.customersPerHour')),
            value: kpis.customersPerHour === null ? 0 : safe(kpis.customersPerHour),
            text: kpis.customersPerHour === null ? '—' : undefined,
            decimals: kpis.customersPerHour === null ? undefined : 1,
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('staffAnalytics.perf.trend'))}
            subtitle={resolvedLabel ?? undefined}
            icon={TrendingUp}
            iconClass="from-emerald-500 to-teal-600"
            empty={!hasTrend}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(v: string) => formatBucket(String(v), lang)}
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  tickLine={false}
                  minTickGap={18}
                />
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
                <Area type="monotone" dataKey="total" stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
                <Area type="monotone" dataKey="completed" stroke="#14b8a6" fill="#14b8a6" fillOpacity={0.1} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <CountListPanel
          title={t(ak('staffAnalytics.overview.statusTitle'))}
          icon={Users}
          iconClass="from-amber-500 to-orange-500"
          rows={(data.statusDistribution ?? [])
            .map((s) => ({
              label: ANALYTICS_STATUS_META[s.status]
                ? t(ANALYTICS_STATUS_META[s.status].labelKey as TranslationKeys)
                : humanizeEnum(s.status),
              count: safe(s.count),
            }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Counter activity (§33) — own counters only ── */}
        <SectionTablePanel
          title={t(ak('staffAnalytics.perf.byCounter'))}
          icon={Clock}
          iconClass="from-teal-500 to-cyan-600"
          rows={data.byCounter ?? []}
          getKey={(r) => r.counterId}
          columns={[
            {
              header: t(ak('adminAnalytics.table.name')),
              className: 'flex-1 min-w-0',
              cell: (r) => (
                <span className="font-bold truncate block" title={r.name}>
                  {r.name}
                </span>
              ),
            },
            {
              header: t(ak('staffAnalytics.perf.servedCol')),
              className: 'w-16 text-center shrink-0',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.served).toLocaleString()}</span>,
            },
            {
              header: t(ak('staffAnalytics.overview.avgService')),
              className: 'w-20 text-center shrink-0',
              align: 'center',
              cell: (r) => (
                <span dir="ltr">
                  {r.avgServiceMinutes === null ? '—' : `${safe(r.avgServiceMinutes).toFixed(0)} ${t('min')}`}
                </span>
              ),
            },
          ]}
        />

        {/* ── Per-service activity (§33) ── */}
        <SectionTablePanel
          title={t(ak('staffAnalytics.perf.byService'))}
          icon={UserCog}
          iconClass="from-emerald-500 to-teal-600"
          rows={data.byService ?? []}
          getKey={(r) => r.serviceId}
          columns={[
            {
              header: t(ak('adminAnalytics.table.name')),
              className: 'flex-1 min-w-0',
              cell: (r) => (
                <span className="font-bold truncate block" title={r.name}>
                  {r.name}
                </span>
              ),
            },
            {
              header: t('totalReservations'),
              className: 'w-16 text-center shrink-0',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
            },
            {
              header: t('completed'),
              className: 'w-16 text-center shrink-0 hidden sm:block',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.completed).toLocaleString()}</span>,
            },
            {
              header: t(ak('staffAnalytics.overview.avgService')),
              className: 'w-20 text-center shrink-0',
              align: 'center',
              cell: (r) => (
                <span dir="ltr">
                  {r.avgServiceMinutes === null ? '—' : `${safe(r.avgServiceMinutes).toFixed(0)} ${t('min')}`}
                </span>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
