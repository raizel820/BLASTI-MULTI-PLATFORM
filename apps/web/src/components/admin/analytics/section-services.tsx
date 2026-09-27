'use client';

// ─── Task 54-b: Services section (doc-2 §10) ─────────────────────────────────
// GET /api/admin/analytics/services — platform service totals + top services
// table (volumes, channel split, rates, durations).

import { useLanguage } from '@/hooks/use-language';
import { Briefcase, Building2, ClipboardList } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminServicesData, AdminTopServiceRow } from './section-types';

export function ServicesSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminServicesData>(
    'services',
    query,
    { isEmpty: (d) => (d.totals?.totalServices ?? 0) === 0 && (d.topServices?.length ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const rows = [...(data.topServices ?? [])].sort((a, b) => safe(b.count) - safe(a.count));

  const chartData = rows.slice(0, 8).map((r) => ({ name: r.name, count: safe(r.count) }));
  const hasChart = chartData.some((d) => d.count > 0);
  const maxVal = chartData.reduce((m, d) => Math.max(m, d.count), 0);

  const CountTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
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
            icon: Briefcase,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.services.total')),
            value: safe(data.totals.totalServices),
          },
          {
            icon: Briefcase,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.services.active')),
            value: safe(data.totals.activeServices),
          },
          {
            icon: Building2,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.services.perAgency')),
            value: safe(data.totals.servicesPerAgencyAvg),
            decimals: 1,
          },
        ]}
      />

      <ChartCard
        title={t(ak('adminAnalytics.services.top'))}
        icon={ClipboardList}
        iconClass="from-emerald-500 to-teal-600"
        heightClass="h-64 sm:h-72"
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
            <Tooltip content={<CountTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
            <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false}>
              {chartData.map((d, i) => (
                <Cell
                  key={i}
                  fill={['#10b981', '#14b8a6', '#06b6d4', '#f59e0b'][i % 4]}
                  fillOpacity={d.count === maxVal ? 0.95 : 0.7}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel<AdminTopServiceRow>
        title={t(ak('adminAnalytics.res.topServices'))}
        icon={ClipboardList}
        iconClass="from-teal-500 to-cyan-600"
        rows={rows}
        getKey={(r) => r.serviceId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <div className="min-w-0">
                <span className="font-bold truncate block" title={r.name}>
                  {r.name}
                </span>
                <span className="text-[9px] font-mono text-muted-foreground" dir="ltr">
                  {r.key ?? ''}
                </span>
              </div>
            ),
          },
          {
            header: t('total'),
            className: 'w-14 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
          },
          {
            header: t('onlineReservations'),
            className: 'w-16 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.online).toLocaleString()}</span>,
          },
          {
            header: t('walkIn'),
            className: 'w-16 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.walkIn).toLocaleString()}</span>,
          },
          {
            header: t('completionRate'),
            className: 'w-16 text-center shrink-0',
            align: 'center',
            cell: (r) => (
              <span dir="ltr" className="text-emerald-700 dark:text-emerald-400 font-semibold">
                {safe(r.completionRate).toFixed(0)}%
              </span>
            ),
          },
          {
            header: t('avgWaitTime'),
            className: 'w-16 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{r.avgWaitMinutes === null ? '—' : safe(r.avgWaitMinutes).toFixed(1)}</span>,
          },
        ]}
      />
    </div>
  );
}
