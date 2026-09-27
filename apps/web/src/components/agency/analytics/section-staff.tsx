'use client';

// ─── Task 54-c: Staff section (doc-2 §21) ────────────────────────────────────
// GET /api/agency/analytics/staff — only the owner's own staff. Attribution
// uses the counter → staff link (Reservation.counterId → Counter.staffId at
// serve time). Individual performance rows respect the agency's permission
// model (server-side; rows carry aggregates only).

import { useLanguage } from '@/hooks/use-language';
import { BadgeCheck, ClipboardList, TrendingUp, UserCog } from 'lucide-react';
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
import type { OwnerStaffData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

export function OwnerStaffSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerStaffData>(
    'staff',
    query,
    // No staff rows at all → empty state.
    { isEmpty: (d) => (d.totals?.staff ?? 0) === 0 && (d.staff?.length ?? 0) === 0 },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const staff = data.staff ?? [];
  const totalHandled = staff.reduce((sum, s) => sum + safe(s.reservationsHandled), 0);
  const totalCompleted = staff.reduce((sum, s) => sum + safe(s.completed), 0);

  const chartData = staff
    .filter((s) => s.reservationsHandled > 0)
    .slice(0, 8)
    .map((s) => ({ name: s.name, reservationsHandled: safe(s.reservationsHandled), completed: safe(s.completed) }));
  const hasChart = chartData.length > 0;

  const StaffTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{String(props.label ?? '')}</p>
        {props.payload.map((p) => (
          <p key={String(p.dataKey)} className="text-muted-foreground">
            {p.dataKey === 'reservationsHandled' ? t('ownerAnalytics.staff.handled') : t('completed')}:{' '}
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
            icon: UserCog,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.staff.total')),
            value: safe(data.totals.staff),
          },
          {
            icon: BadgeCheck,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.staff.active')),
            value: safe(data.totals.active),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('ownerAnalytics.staff.handled')),
            value: totalHandled,
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('completed'),
            value: totalCompleted,
          },
        ]}
      />

      <ChartCard
        title={t(ak('ownerAnalytics.staff.byStaff'))}
        icon={TrendingUp}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasChart}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} interval={0} height={40} angle={-18} textAnchor="end" />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
            <Tooltip content={<StaffTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="reservationsHandled" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="completed" fill="#14b8a6" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel
        title={t(ak('ownerAnalytics.staff.table'))}
        icon={UserCog}
        iconClass="from-teal-500 to-cyan-600"
        rows={staff}
        getKey={(r) => r.staffId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                {r.role === 'MANAGER' ? (
                  <Badge className="text-[9px] h-4 px-1 ms-1.5 align-middle bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300">
                    {t(ak('ownerAnalytics.staff.manager'))}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 ms-1.5 align-middle">
                    {t(ak('ownerAnalytics.staff.staff'))}
                  </Badge>
                )}
                {!r.isActive && (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 ms-1.5 align-middle">
                    {t(ak('ownerAnalytics.staff.inactive'))}
                  </Badge>
                )}
              </span>
            ),
          },
          {
            header: t(ak('ownerAnalytics.staff.counters')),
            className: 'w-14 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.countersAssigned)}</span>,
          },
          {
            header: t(ak('ownerAnalytics.staff.handled')),
            className: 'w-14 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.reservationsHandled).toLocaleString()}</span>,
          },
          {
            header: t('completed'),
            className: 'w-14 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.completed).toLocaleString()}</span>,
          },
          {
            header: t('completionRate'),
            className: 'w-16 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.completionRate).toFixed(0)}%</span>,
          },
          {
            header: t(ak('ownerAnalytics.res.avgService')),
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
  );
}
