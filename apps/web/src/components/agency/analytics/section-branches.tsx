'use client';

// ─── Task 54-c: Branches section (doc-2 §20) ─────────────────────────────────
// GET /api/agency/analytics/branches — only the owner's own branches: per-
// branch reservations / customers served / completed / cancelled / no-show /
// completion rate / avg wait & service + branch capacity (counters, staff,
// devices).

import { useLanguage } from '@/hooks/use-language';
import { Building2, ClipboardList, TrendingUp } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerBranchesData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

export function OwnerBranchesSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerBranchesData>(
    'branches',
    query,
    // An agency without branches yet → empty state (totals.branches === 0).
    { isEmpty: (d) => (d.totals?.branches ?? 0) === 0 },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const branches = data.branches ?? [];
  const activeBranches = branches.filter((b) => b.isActive).length;

  const chartData = branches
    .slice(0, 8)
    .map((b) => ({ name: b.name, reservations: safe(b.reservations), customersServed: safe(b.customersServed) }));
  const hasChart = chartData.some((p) => p.reservations > 0 || p.customersServed > 0);

  const BranchTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{String(props.label ?? '')}</p>
        {props.payload.map((p) => (
          <p key={String(p.dataKey)} className="text-muted-foreground">
            {p.dataKey === 'reservations' ? t('totalReservations') : t('ownerAnalytics.branches.served')}:{' '}
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
            icon: Building2,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.branches.total')),
            value: safe(data.totals.branches),
          },
          {
            icon: Building2,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.branches.active')),
            value: activeBranches,
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('totalReservations'),
            value: safe(data.totals.reservationsInPeriod),
          },
        ]}
      />

      <ChartCard
        title={t(ak('ownerAnalytics.branches.byBranch'))}
        icon={TrendingUp}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasChart}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} interval={0} height={40} angle={-18} textAnchor="end" />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
            <Tooltip content={<BranchTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="reservations" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="customersServed" fill="#14b8a6" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel
        title={t(ak('ownerAnalytics.branches.table'))}
        icon={Building2}
        iconClass="from-teal-500 to-cyan-600"
        rows={branches}
        getKey={(r) => r.branchId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                {r.isMain && (
                  <Badge className="text-[9px] h-4 px-1 ms-1.5 align-middle bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                    {t(ak('ownerAnalytics.branches.main'))}
                  </Badge>
                )}
                {!r.isActive && (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 ms-1.5 align-middle">
                    {t(ak('ownerAnalytics.branches.inactive'))}
                  </Badge>
                )}
              </span>
            ),
          },
          {
            header: t('totalReservations'),
            className: 'w-14 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.reservations).toLocaleString()}</span>,
          },
          {
            header: t('ownerAnalytics.branches.served'),
            className: 'w-14 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.customersServed).toLocaleString()}</span>,
          },
          {
            header: t('completionRate'),
            className: 'w-16 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.completionRate).toFixed(0)}%</span>,
          },
          {
            header: t('avgWaitTime'),
            className: 'w-16 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => (
              <span dir="ltr">{r.avgWaitMinutes === null ? '—' : `${safe(r.avgWaitMinutes).toFixed(0)} ${t('min')}`}</span>
            ),
          },
          {
            header: t(ak('ownerAnalytics.branches.capacity')),
            className: 'w-28 text-center shrink-0 hidden lg:block',
            align: 'center',
            cell: (r) => (
              <span className="text-[10px] text-muted-foreground" dir="ltr">
                {safe(r.countersActive)}/{safe(r.countersTotal)} C · {safe(r.staffActive)} S · {safe(r.devicesOnline)}/{safe(r.devicesTotal)} D
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
