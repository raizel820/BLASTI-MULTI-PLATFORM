'use client';

// ─── Task 54-b: Categories section (doc-2 §7) ────────────────────────────────
// GET /api/admin/analytics/categories — per-category agency counts, reservation
// outcomes, rates and avg wait. Horizontal bar of reservations by category +
// a rich table (height-capped, custom scrollbar).

import { useLanguage } from '@/hooks/use-language';
import { LayoutGrid } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { translateCategory } from '@/lib/enum-i18n';
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
import type { AdminCategoriesData, AdminCategoryRow } from './section-types';

const CAT_COLORS = ['#10b981', '#14b8a6', '#06b6d4', '#f59e0b', '#84cc16'];

export function CategoriesSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminCategoriesData>(
    'categories',
    query,
    { isEmpty: (d) => (d.categories?.length ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const rows = [...(data.categories ?? [])].sort((a, b) => safe(b.reservations) - safe(a.reservations));

  const totalAgencies = rows.reduce((s, r) => s + safe(r.agencies), 0);
  const totalReservations = rows.reduce((s, r) => s + safe(r.reservations), 0);
  const totalStaff = rows.reduce((s, r) => s + safe(r.staff), 0);
  const totalBranches = rows.reduce((s, r) => s + safe(r.branches), 0);

  const chartData = rows.map((r) => ({
    name: translateCategory(r.category, t),
    reservations: safe(r.reservations),
  }));
  const hasChart = chartData.some((d) => d.reservations > 0);
  const maxVal = chartData.reduce((m, d) => Math.max(m, d.reservations), 0);

  const CatTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.categories.reservations'))}:{' '}
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
            icon: LayoutGrid,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.nav.categories')),
            value: rows.length,
          },
          {
            icon: LayoutGrid,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.categories.agencies')),
            value: totalAgencies,
          },
          {
            icon: LayoutGrid,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.categories.reservations')),
            value: totalReservations,
          },
          {
            icon: LayoutGrid,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.categories.branches')),
            value: totalBranches,
          },
          {
            icon: LayoutGrid,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.categories.staff')),
            value: totalStaff,
          },
        ]}
      />

      <ChartCard
        title={t(ak('adminAnalytics.categories.reservationsByCategory'))}
        icon={LayoutGrid}
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
              width={110}
              tickLine={false}
            />
            <Tooltip content={<CatTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
            <Bar dataKey="reservations" radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false}>
              {chartData.map((d, i) => (
                <Cell
                  key={i}
                  fill={CAT_COLORS[i % CAT_COLORS.length]}
                  fillOpacity={d.reservations === maxVal ? 0.95 : 0.7}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel<AdminCategoryRow>
        title={t(ak('adminAnalytics.nav.categories'))}
        icon={LayoutGrid}
        iconClass="from-teal-500 to-cyan-600"
        rows={rows}
        getKey={(r) => r.category}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => <span className="font-bold truncate block">{translateCategory(r.category, t)}</span>,
          },
          {
            header: t(ak('adminAnalytics.categories.agencies')),
            className: 'w-16 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.agencies).toLocaleString()}</span>,
          },
          {
            header: t(ak('adminAnalytics.categories.reservations')),
            className: 'w-20 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.reservations).toLocaleString()}</span>,
          },
          {
            header: t(ak('adminAnalytics.categories.completionShort')),
            className: 'w-16 text-center shrink-0',
            align: 'center',
            cell: (r) => (
              <span dir="ltr" className="text-emerald-700 dark:text-emerald-400 font-semibold">
                {safe(r.completionRate).toFixed(0)}%
              </span>
            ),
          },
          {
            header: t(ak('adminAnalytics.categories.avgWait')),
            className: 'w-20 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{r.avgWaitMinutes === null ? '—' : safe(r.avgWaitMinutes).toFixed(1)}</span>,
          },
          {
            header: t('noShowRate'),
            className: 'w-16 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => (
              <span dir="ltr" className="text-rose-600 dark:text-rose-400 font-semibold">
                {safe(r.noShowRate).toFixed(0)}%
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
