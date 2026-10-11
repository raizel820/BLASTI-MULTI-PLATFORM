'use client';

// ─── Task 54-c: Customers section (doc-2 §22) ────────────────────────────────
// GET /api/agency/analytics/customers — ONLY customers who interacted with
// this agency (rows carry id + name; no contact details — §22 forbids using
// analytics to discover unrelated customers). Unique / new / returning
// customers, repeat visits, per-customer reservations, cancellation and
// no-show rates, most requested services, top customers.

import { useLanguage } from '@/hooks/use-language';
import { ClipboardList, TrendingUp, UserRound, Users } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerCustomersData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

export function OwnerCustomersSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerCustomersData>(
    'customers',
    query,
    // Zero-safe: totals are 0 + lists empty when no online customer visited.
    { isEmpty: (d) => (d.totals?.uniqueCustomers ?? 0) === 0 && (d.topCustomers?.length ?? 0) === 0 },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;

  const chartData = (data.mostRequestedServices ?? []).slice(0, 8).map((s) => ({ name: s.name, count: safe(s.count) }));
  const hasChart = chartData.some((p) => p.count > 0);

  const ServicesTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t('reservationsCount')}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      <StatTiles
        items={[
          {
            icon: Users,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.customers.unique')),
            value: safe(totals.uniqueCustomers),
          },
          {
            icon: UserRound,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.customers.new')),
            value: safe(totals.newCustomers),
          },
          {
            icon: UserRound,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('ownerAnalytics.customers.returning')),
            value: safe(totals.returningCustomers),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('ownerAnalytics.customers.repeatVisits')),
            value: safe(totals.repeatVisits),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.customers.perCustomer')),
            value: safe(totals.reservationsPerCustomer),
            decimals: 1,
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('analyticsSection.noShow.cancelRate'),
            value: safe(totals.cancellationRate),
            decimals: 1,
            suffix: '%',
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('noShowRate'),
            value: safe(totals.noShowRate),
            decimals: 1,
            suffix: '%',
          },
        ]}
      />

      <ChartCard
        title={t(ak('ownerAnalytics.customers.mostRequested'))}
        icon={TrendingUp}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasChart}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={110} tickLine={false} />
            <Tooltip content={<ServicesTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="count" fill="#10b981" radius={[0, 3, 3, 0]} maxBarSize={20} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel
        title={t(ak('ownerAnalytics.customers.top'))}
        icon={Users}
        iconClass="from-teal-500 to-cyan-600"
        rows={data.topCustomers ?? []}
        getKey={(r) => r.userId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => <span className="font-bold truncate block" title={r.name}>{r.name}</span>,
          },
          {
            header: t('totalReservations'),
            className: 'w-24 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.reservations).toLocaleString()}</span>,
          },
        ]}
      />
    </div>
  );
}
