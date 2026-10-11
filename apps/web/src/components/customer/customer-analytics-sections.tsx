'use client';

// ─── Task 54-d: CUSTOMER analytics sections (doc-2 §40-44) ───────────────────
//
// Five personal-scope sections (§38: the customer cannot see platform, agency
// or other-customer statistics — everything here is filtered to their own
// account SERVER-SIDE) over the frozen 54-a contract §4.1-4.5:
//   • My Overview (§40)      — totals + period trend + avg wait/service
//   • My Reservations (§41)  — trend, status/type distributions, most-used
//   • My Queue History (§42) — joins, wait stats (avg/longest/shortest)
//   • My Activity (§43)      — reservations, favorites, notifications, reviews
//   • My Ratings (§44)       — reviews submitted, distribution, history
//
// Shared presentational primitives from admin/analytics/section-ui (role-
// agnostic). Palette: emerald/teal/cyan primary, amber warning, rose negative
// — no indigo/blue. RTL-safe (numeric + chart zones LTR-wrapped).

import { useLanguage } from '@/hooks/use-language';
import {
  Bell,
  Building2,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Clock,
  Heart,
  History,
  ListOrdered,
  MessageSquareHeart,
  Star,
  Timer,
  TrendingUp,
  ShieldAlert,
  Tags,
  XCircle,
  UserX,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import type { TranslationKeys } from '@/i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionMessagePanel,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
} from '@/components/admin/analytics/section-ui';
import { humanizeEnum } from '@/lib/enum-i18n';
import { ANALYTICS_STATUS_META } from '@/components/agency/analytics/types';
import { ak } from '@/components/agency/analytics/i18n-keys';
import type {
  CustomerMyActivityData,
  CustomerMyOverviewData,
  CustomerMyQueueHistoryData,
  CustomerMyRatingsData,
  CustomerMyReservationsData,
  CustomerSectionId,
} from './customer-analytics-types';
import { useCustomerSectionData, type CustomerSectionQuery } from './use-customer-section-data';

// ─── Shared friendly no-permission panel (§38 personal scope) ────────────────
function CustomerForbiddenPanel() {
  const { t } = useLanguage();
  return (
    <SectionMessagePanel
      icon={ShieldAlert}
      iconClass="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      title={t(ak('myAnalytics.forbidden.title'))}
      body={t(ak('myAnalytics.forbidden.body'))}
    />
  );
}

/** Maps a statusDistribution row to a localized label. */
function statusLabel(status: string, t: (k: TranslationKeys) => string): string {
  return ANALYTICS_STATUS_META[status]
    ? t(ANALYTICS_STATUS_META[status].labelKey as TranslationKeys)
    : humanizeEnum(status);
}

const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);

// ═══ §4.1 My Overview (§40) ═══════════════════════════════════════════════════

export function CustomerMyOverviewSection({ query }: { query: CustomerSectionQuery }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useCustomerSectionData<CustomerMyOverviewData>(
    'my-overview',
    query,
    {
      // Zero-safe: totals can legitimately be all-zero (new customer).
      isEmpty: (d) =>
        (d.totals?.totalReservations ?? 0) === 0 &&
        (d.totals?.favoriteAgencies ?? 0) === 0 &&
        !(d.period?.timeseries ?? []).some((p) => p.total > 0),
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <CustomerForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const totals = data.totals;

  const trendData = (data.period.timeseries ?? []).map((p) => ({
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
      <StatTiles
        items={[
          {
            icon: ClipboardList,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('totalReservations'),
            value: safe(totals.totalReservations),
          },
          {
            icon: CheckCircle2,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t('completed'),
            value: safe(totals.completed),
          },
          {
            icon: XCircle,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('cancelled'),
            value: safe(totals.cancelled),
          },
          {
            icon: UserX,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusNoShow'),
            value: safe(totals.noShow),
          },
          {
            icon: CalendarCheck,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('upcoming'),
            value: safe(totals.upcoming),
          },
          {
            icon: Heart,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('myAnalytics.overview.favorites')),
            value: safe(totals.favoriteAgencies),
          },
          {
            icon: Building2,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('myAnalytics.overview.agenciesUsed')),
            value: safe(totals.agenciesUsed),
          },
          {
            icon: Tags,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('myAnalytics.overview.servicesUsed')),
            value: safe(totals.servicesUsed),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('myAnalytics.overview.trend'))}
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

        <div className="grid grid-cols-1 gap-4 content-start">
          <StatTile inline={data.period.avgWaitingTimeMinutes} label={t('avgWaitTime')} iconClass="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" Icon={Timer} />
          <StatTile inline={data.period.avgServiceDurationMinutes} label={t(ak('myAnalytics.avgService'))} iconClass="bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400" Icon={Timer} />
        </div>
      </div>
    </div>
  );
}

/** Compact avg-duration tile used inline (null → em dash). */
function StatTile({
  inline,
  label,
  iconClass,
  Icon,
}: {
  inline: number | null;
  label: string;
  iconClass: string;
  Icon: typeof Timer;
}) {
  return (
    <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 flex items-center gap-3">
      <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${iconClass}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-black text-foreground leading-none" dir="ltr">
          {inline === null ? '—' : `${safe(inline).toFixed(1)} min`}
        </p>
        <p className="mt-1 text-[11px] font-medium text-muted-foreground truncate">{label}</p>
      </div>
    </div>
  );
}

// ═══ §4.2 My Reservations (§41) ═══════════════════════════════════════════════

export function CustomerMyReservationsSection({ query }: { query: CustomerSectionQuery }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useCustomerSectionData<CustomerMyReservationsData>(
    'my-reservations',
    query,
    {
      // Zero-safe: a period with no reservations still renders distributions.
      isEmpty: (d) =>
        !(d.timeseries ?? []).some((p) => p.total > 0) &&
        (d.mostUsedAgencies?.length ?? 0) === 0 &&
        (d.mostUsedServices?.length ?? 0) === 0,
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <CustomerForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const ccn = data.completedCancelledNoShow;

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

  const typeRows = [
    { key: 'online', label: t(ak('myAnalytics.res.online')), count: safe(data.byType.online) },
    { key: 'walkIn', label: t('walkIn'), count: safe(data.byType.walkIn) },
    { key: 'fixedTime', label: t(ak('myAnalytics.res.fixedTime')), count: safe(data.byType.fixedTime) },
  ];

  return (
    <div className="space-y-4">
      {resolvedLabel && (
        <p className="text-[11px] text-muted-foreground -mt-1" dir="ltr">{resolvedLabel}</p>
      )}

      <StatTiles
        items={[
          {
            icon: CheckCircle2,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('completed'),
            value: safe(ccn.completed),
          },
          {
            icon: XCircle,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('cancelled'),
            value: safe(ccn.cancelled),
          },
          {
            icon: UserX,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusNoShow'),
            value: safe(ccn.noShow),
          },
          {
            icon: Timer,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('avgWaitTime'),
            value: data.avgWaitingTimeMinutes === null ? 0 : safe(data.avgWaitingTimeMinutes),
            text: data.avgWaitingTimeMinutes === null ? '—' : undefined,
            decimals: data.avgWaitingTimeMinutes === null ? undefined : 1,
            suffix: data.avgWaitingTimeMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: Timer,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('myAnalytics.avgService')),
            value: data.avgServiceTimeMinutes === null ? 0 : safe(data.avgServiceTimeMinutes),
            text: data.avgServiceTimeMinutes === null ? '—' : undefined,
            decimals: data.avgServiceTimeMinutes === null ? undefined : 1,
            suffix: data.avgServiceTimeMinutes === null ? undefined : ` ${t('min')}`,
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('myAnalytics.res.trend'))}
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

        <div className="grid grid-cols-1 gap-4 content-start">
          <CountListPanel
            title={t(ak('myAnalytics.res.statusTitle'))}
            icon={ListOrdered}
            iconClass="from-amber-500 to-orange-500"
            rows={(data.statusDistribution ?? [])
              .map((s) => ({ label: statusLabel(s.status, t), count: safe(s.count) }))
              .sort((a, b) => b.count - a.count)}
          />
          <CountListPanel
            title={t(ak('myAnalytics.res.byType'))}
            icon={Tags}
            iconClass="from-teal-500 to-cyan-600"
            rows={typeRows}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionTablePanel
          title={t(ak('myAnalytics.res.mostUsedAgencies'))}
          icon={Building2}
          iconClass="from-emerald-500 to-teal-600"
          rows={data.mostUsedAgencies ?? []}
          getKey={(r) => r.agencyId}
          columns={[
            {
              header: t(ak('adminAnalytics.table.name')),
              className: 'flex-1 min-w-0',
              cell: (r) => <span className="font-bold truncate block" title={r.name}>{r.name}</span>,
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
              header: t('completionRate'),
              className: 'w-16 text-center shrink-0 hidden md:block',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.completionRate).toFixed(0)}%</span>,
            },
          ]}
        />

        <SectionTablePanel
          title={t(ak('myAnalytics.res.mostUsedServices'))}
          icon={Tags}
          iconClass="from-teal-500 to-cyan-600"
          rows={data.mostUsedServices ?? []}
          getKey={(r) => r.serviceId}
          columns={[
            {
              header: t(ak('adminAnalytics.table.name')),
              className: 'flex-1 min-w-0',
              cell: (r) => <span className="font-bold truncate block" title={r.name}>{r.name}</span>,
            },
            {
              header: t('totalReservations'),
              className: 'w-16 text-center shrink-0',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
            },
            {
              header: t('avgWaitTime'),
              className: 'w-20 text-center shrink-0 hidden sm:block',
              align: 'center',
              cell: (r) => (
                <span dir="ltr">
                  {r.avgWaitMinutes === null ? '—' : `${safe(r.avgWaitMinutes).toFixed(0)} ${t('min')}`}
                </span>
              ),
            },
            {
              header: t(ak('myAnalytics.avgService')),
              className: 'w-20 text-center shrink-0 hidden md:block',
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

// ═══ §4.3 My Queue History (§42) ══════════════════════════════════════════════

export function CustomerMyQueueHistorySection({ query }: { query: CustomerSectionQuery }) {
  const { t } = useLanguage();
  const { data, state, refresh, isQueryReady } = useCustomerSectionData<CustomerMyQueueHistoryData>(
    'my-queue-history',
    query,
    {
      // Zero-safe: no queue visits → all-zero totals + null wait stats.
      isEmpty: (d) => (d.totals?.timesJoinedQueue ?? 0) === 0,
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <CustomerForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const durationBar = [
    {
      name: t('avgWaitTime'),
      minutes: data.wait.averageMinutes === null ? 0 : safe(data.wait.averageMinutes),
      fill: '#f59e0b',
    },
    {
      name: t(ak('myAnalytics.queue.longestWait')),
      minutes: data.wait.longestMinutes === null ? 0 : safe(data.wait.longestMinutes),
      fill: '#ef4444',
    },
    {
      name: t(ak('myAnalytics.queue.shortestWait')),
      minutes: data.wait.shortestMinutes === null ? 0 : safe(data.wait.shortestMinutes),
      fill: '#14b8a6',
    },
    {
      name: t(ak('myAnalytics.avgService')),
      minutes: data.service.averageMinutes === null ? 0 : safe(data.service.averageMinutes),
      fill: '#10b981',
    },
  ];
  const hasDurations = durationBar.some((d) => d.minutes > 0);

  const DurationTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('myAnalytics.queue.minutes'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
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
            icon: History,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('myAnalytics.queue.joined')),
            value: safe(data.totals.timesJoinedQueue),
          },
          {
            icon: CheckCircle2,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('myAnalytics.queue.completedVisits')),
            value: safe(data.totals.completedVisits),
          },
          {
            icon: XCircle,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('cancelled'),
            value: safe(data.totals.cancelledVisits),
          },
          {
            icon: UserX,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusNoShow'),
            value: safe(data.totals.noShows),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StatTileInlineGroup
          items={[
            {
              label: t('avgWaitTime'),
              minutes: data.wait.averageMinutes,
              iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
              Icon: Timer,
            },
            {
              label: t(ak('myAnalytics.queue.longestWait')),
              minutes: data.wait.longestMinutes,
              iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
              Icon: Clock,
            },
            {
              label: t(ak('myAnalytics.queue.shortestWait')),
              minutes: data.wait.shortestMinutes,
              iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
              Icon: Clock,
            },
            {
              label: t(ak('myAnalytics.avgService')),
              minutes: data.service.averageMinutes,
              iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
              Icon: Timer,
            },
          ]}
        />

        <ChartCard
          title={t(ak('myAnalytics.queue.durations'))}
          subtitle={resolvedLabel ?? undefined}
          icon={Timer}
          iconClass="from-amber-500 to-orange-500"
          empty={!hasDurations}
          heightClass="h-56 sm:h-64"
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={durationBar} layout="vertical" margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={90} tickLine={false} />
              <Tooltip content={<DurationTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
              <Bar dataKey="minutes" radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false}>
                {durationBar.map((d) => (
                  <Cell key={d.name} fill={d.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

/** Row group of duration tiles (null → em dash). */
function StatTileInlineGroup({
  items,
}: {
  items: Array<{
    label: string;
    minutes: number | null;
    iconClass: string;
    Icon: typeof Timer;
  }>;
}) {
  const { t } = useLanguage();
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardContent className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3">
            <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${item.iconClass}`}>
              <item.Icon className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <p className="text-lg font-black text-foreground leading-none" dir="ltr">
                {item.minutes === null ? '—' : `${safe(item.minutes).toFixed(1)} ${t('min')}`}
              </p>
              <p className="mt-0.5 text-[11px] font-medium text-muted-foreground truncate">{item.label}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ═══ §4.4 My Activity (§43) ═══════════════════════════════════════════════════

export function CustomerMyActivitySection({ query }: { query: CustomerSectionQuery }) {
  const { t } = useLanguage();
  const { data, state, refresh, isQueryReady } = useCustomerSectionData<CustomerMyActivityData>(
    'my-activity',
    query,
    {
      // Zero-safe: an inactive period shows zeros, not an error.
      isEmpty: (d) =>
        (d.reservations?.inPeriod ?? 0) === 0 &&
        (d.favorites?.count ?? 0) === 0 &&
        (d.notifications?.receivedInPeriod ?? 0) === 0 &&
        (d.reviews?.count ?? 0) === 0,
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <CustomerForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  return (
    <div className="space-y-4">
      {resolvedLabel && (
        <p className="text-[11px] text-muted-foreground -mt-1" dir="ltr">{resolvedLabel}</p>
      )}

      <StatTiles
        items={[
          {
            icon: ClipboardList,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('myAnalytics.activity.reservations')),
            value: safe(data.reservations.inPeriod),
          },
          {
            icon: Heart,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('myAnalytics.activity.favorites')),
            value: safe(data.favorites.count),
          },
          {
            icon: Bell,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('myAnalytics.activity.notifications')),
            value: safe(data.notifications.receivedInPeriod),
          },
          {
            icon: MessageSquareHeart,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('myAnalytics.activity.reviews')),
            value: safe(data.reviews.count),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Favorite agencies (personal list) ── */}
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0">
                <Heart className="h-4 w-4 text-white" />
              </div>
              <p className="text-sm font-semibold">{t(ak('myAnalytics.activity.agenciesList'))}</p>
              {safe(data.favorites.newInPeriod) > 0 && (
                <span
                  className="ms-auto text-[11px] font-semibold text-rose-600 dark:text-rose-400 shrink-0"
                  title={t(ak('myAnalytics.activity.newFavorites'), { count: String(safe(data.favorites.newInPeriod)) })}
                >
                  +{safe(data.favorites.newInPeriod).toLocaleString()}
                </span>
              )}
            </div>
            {(data.favorites.agencies ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{t('noDataYet')}</p>
            ) : (
              <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto custom-scrollbar" role="list">
                {(data.favorites.agencies ?? []).map((a) => (
                  <div
                    key={a.agencyId}
                    role="listitem"
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-rose-50 dark:bg-rose-900/20 px-3 py-1.5"
                  >
                    <Heart className="h-3 w-3 text-rose-500 fill-rose-500" aria-hidden="true" />
                    <span className="text-xs font-bold text-foreground truncate max-w-[160px]" title={a.name}>
                      {a.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Notifications breakdown ── */}
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shrink-0">
                <Bell className="h-4 w-4 text-white" />
              </div>
              <p className="text-sm font-semibold">{t(ak('myAnalytics.activity.notifBreakdown'))}</p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: t(ak('myAnalytics.activity.received')), value: safe(data.notifications.receivedInPeriod), tone: 'text-foreground' },
                { label: t(ak('myAnalytics.activity.unread')), value: safe(data.notifications.unread), tone: 'text-amber-600 dark:text-amber-400' },
                { label: t(ak('myAnalytics.activity.totalAllTime')), value: safe(data.notifications.total), tone: 'text-muted-foreground' },
              ].map((item) => (
                <div key={item.label} className="rounded-xl bg-muted/40 dark:bg-gray-800/40 p-3 text-center">
                  <p className={`text-xl font-black leading-none ${item.tone}`} dir="ltr">
                    {item.value.toLocaleString()}
                  </p>
                  <p className="mt-1.5 text-[10px] font-medium text-muted-foreground">{item.label}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ═══ §4.5 My Ratings (§44) ════════════════════════════════════════════════════

export function CustomerMyRatingsSection({ query }: { query: CustomerSectionQuery }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useCustomerSectionData<CustomerMyRatingsData>(
    'my-ratings',
    query,
    {
      // Zero-safe: no reviews yet → summary zeros + empty history.
      isEmpty: (d) => (d.summary?.reviewsSubmitted ?? 0) === 0 && (d.history?.length ?? 0) === 0,
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <CustomerForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const summary = data.summary;

  const distData = Array.from({ length: 5 }, (_, i) => {
    const found = (summary.distribution ?? []).find((d) => d.stars === 5 - i);
    return { stars: `${5 - i}★`, count: safe(found?.count) };
  });
  const hasDist = distData.some((p) => p.count > 0);

  const DistTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('myAnalytics.activity.reviews'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const dateLabel = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-US', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-4">
      {resolvedLabel && (
        <p className="text-[11px] text-muted-foreground -mt-1" dir="ltr">{resolvedLabel}</p>
      )}

      <StatTiles
        items={[
          {
            icon: MessageSquareHeart,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('myAnalytics.ratings.submitted')),
            value: safe(summary.reviewsSubmitted),
          },
          {
            icon: Star,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('myAnalytics.ratings.avgGiven')),
            value: summary.averageRatingGiven === null ? 0 : safe(summary.averageRatingGiven),
            text: summary.averageRatingGiven === null ? '—' : undefined,
            decimals: summary.averageRatingGiven === null ? undefined : 1,
            suffix: summary.averageRatingGiven === null ? undefined : ' / 5',
          },
          {
            icon: Building2,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('myAnalytics.ratings.agenciesReviewed')),
            value: safe(summary.agenciesReviewed),
          },
          {
            icon: Tags,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('myAnalytics.ratings.servicesReviewed')),
            value: safe(summary.servicesReviewed),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <SectionTablePanel
            title={t(ak('myAnalytics.ratings.history'))}
            subtitle={resolvedLabel ?? undefined}
            icon={History}
            iconClass="from-emerald-500 to-teal-600"
            rows={data.history ?? []}
            getKey={(r) => r.id}
            columns={[
              {
                header: t(ak('myAnalytics.ratings.agency')),
                className: 'flex-1 min-w-0',
                cell: (r) => (
                  <span className="font-bold truncate block" title={r.agencyName}>
                    {r.agencyName}
                  </span>
                ),
              },
              {
                header: t(ak('myAnalytics.ratings.rating')),
                className: 'w-16 text-center shrink-0',
                align: 'center',
                cell: (r) => (
                  <span dir="ltr" className="inline-flex items-center gap-1">
                    <Star className="h-3 w-3 text-amber-500 fill-amber-500" aria-hidden="true" />
                    {safe(r.rating).toFixed(0)}
                  </span>
                ),
              },
              {
                header: t(ak('myAnalytics.ratings.comment')),
                className: 'flex-1 min-w-0 hidden md:block',
                cell: (r) => (
                  <span className="truncate block text-muted-foreground" title={r.comment ?? ''}>
                    {r.comment ?? '—'}
                  </span>
                ),
              },
              {
                header: t(ak('myAnalytics.ratings.date')),
                className: 'w-20 text-center shrink-0 hidden sm:block',
                align: 'center',
                cell: (r) => <span dir="ltr" className="text-[11px] text-muted-foreground">{dateLabel(r.createdAt)}</span>,
              },
            ]}
          />
        </div>

        <ChartCard
          title={t(ak('myAnalytics.ratings.distribution'))}
          icon={Star}
          iconClass="from-amber-500 to-orange-500"
          empty={!hasDist}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={distData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis dataKey="stars" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
              <Tooltip content={<DistTooltip />} cursor={{ fill: 'rgba(245,158,11,0.08)' }} />
              <Bar dataKey="count" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={34} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}
