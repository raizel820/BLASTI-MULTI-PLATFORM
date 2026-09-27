'use client';

// ─── Task 54-b: Customers section (doc-2 §22 scope, platform view) ───────────
// GET /api/admin/analytics/customers — display-safe totals + top customers.

import { useLanguage } from '@/hooks/use-language';
import { ClipboardList, UserCheck, UserPlus, Users } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
  localizedPeriodLabel,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminCustomersData } from './section-types';

export function CustomersSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminCustomersData>(
    'customers',
    query,
    { isEmpty: (d) => (d.totals?.totalCustomers ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);
  // Localized period label for the "New customers — {period}" caption.
  const periodText = localizedPeriodLabel(resolved ? resolved.period : '', t);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;

  const chartData = (data.topCustomers ?? []).slice(0, 8).map((c) => ({ name: c.name, reservations: safe(c.reservations) }));
  const hasChart = chartData.some((d) => d.reservations > 0);
  const maxVal = chartData.reduce((m, d) => Math.max(m, d.reservations), 0);

  const TopTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground max-w-48 truncate">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t('totalReservations')}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}
      <StatTiles
        items={[
          {
            icon: Users,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('totalCustomers'),
            value: safe(totals.totalCustomers),
          },
          {
            icon: UserPlus,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('adminAnalytics.newCustomersInPeriod', { period: periodText }),
            value: safe(totals.newCustomersInPeriod),
          },
          {
            icon: UserCheck,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.customers.withReservations')),
            value: safe(totals.customersWithReservationInPeriod),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.customers.perCustomer')),
            value: safe(totals.reservationsPerCustomer),
            decimals: 1,
          },
        ]}
      />

      <ChartCard
        title={t(ak('adminAnalytics.customers.top'))}
        icon={Users}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasChart}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 10 }}
              stroke="rgba(128,128,128,0.4)"
              width={130}
              tickLine={false}
            />
            <Tooltip content={<TopTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
            <Bar dataKey="reservations" radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false}>
              {chartData.map((d, i) => (
                <Cell
                  key={i}
                  fill={['#10b981', '#14b8a6', '#06b6d4', '#f59e0b'][i % 4]}
                  fillOpacity={d.reservations === maxVal ? 0.95 : 0.7}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel
        title={t(ak('adminAnalytics.customers.top'))}
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
