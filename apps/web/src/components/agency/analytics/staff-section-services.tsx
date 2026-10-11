'use client';

// ─── Task 54-d: My Services section (doc-2 §34) ──────────────────────────────
// GET /api/staff/analytics/my-services — only services assigned/authorized to
// the staff member (server-locked to the staff row's branch/counter scope).
// Accepts the shared period selector (default 30d). Demand = share of the
// period's in-scope reservations handled by this staff member.

import { useLanguage } from '@/hooks/use-language';
import { ClipboardList, Tags, TrendingUp } from 'lucide-react';
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
  useResolvedWindowLabel,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { StaffServicesData } from './staff-types';
import { useStaffSectionData, type StaffSectionQuery } from './use-staff-section-data';
import { StaffForbiddenPanel } from './staff-forbidden';

export function StaffServicesSection({ query }: { query: StaffSectionQuery }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useStaffSectionData<StaffServicesData>(
    'my-services',
    query,
    {
      // Zero-safe: no authorized services (or none used in the period).
      isEmpty: (d) => (d.services?.length ?? 0) === 0,
    },
  );
  const resolvedLabel = useResolvedWindowLabel()(data?.resolved ?? null);

  if (state === 'forbidden') return <StaffForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const services = data.services ?? [];

  const chartData = services
    .filter((s) => s.reservations > 0)
    .slice(0, 8)
    .map((s) => ({ name: s.name, reservations: safe(s.reservations), completed: safe(s.completed) }));
  const hasChart = chartData.length > 0;

  const peakData = Array.from({ length: 24 }, (_, hour) => {
    const found = (data.peakHours ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const hasPeak = peakData.some((p) => p.count > 0);

  const ServicesTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{String(props.label ?? '')}</p>
        {props.payload.map((p) => (
          <p key={String(p.dataKey)} className="text-muted-foreground">
            {p.dataKey === 'completed' ? t('completed') : t('totalReservations')}:{' '}
            <span className="font-bold text-foreground">{Number(p.value ?? 0).toLocaleString()}</span>
          </p>
        ))}
      </ChartTooltipBox>
    );
  };

  const PeakTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const hour = Number(props.label ?? 0);
    const hourLabel = lang === 'ar' ? `${hour}:00` : hour < 12 ? `${hour === 0 ? 12 : hour}AM` : hour === 12 ? '12PM' : `${hour - 12}PM`;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{hourLabel}</p>
        <p className="text-muted-foreground">
          {t('totalReservations')}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
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
            icon: Tags,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('staffAnalytics.services.total')),
            value: safe(data.totals.services),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('staffAnalytics.services.inScope')),
            value: safe(data.totals.reservationsInScope),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('completed'),
            value: services.reduce((sum, s) => sum + safe(s.completed), 0),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusNoShow'),
            value: services.reduce((sum, s) => sum + safe(s.noShow), 0),
          },
        ]}
      />

      <ChartCard
        title={t(ak('staffAnalytics.services.byService'))}
        icon={TrendingUp}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasChart}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} interval={0} height={40} angle={-18} textAnchor="end" />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
            <Tooltip content={<ServicesTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
            <Bar dataKey="reservations" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            <Bar dataKey="completed" fill="#14b8a6" radius={[3, 3, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard
        title={t(ak('staffAnalytics.services.peakHours'))}
        icon={TrendingUp}
        iconClass="from-cyan-500 to-teal-600"
        empty={!hasPeak}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={peakData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
            <XAxis
              dataKey="hour"
              tickFormatter={(h: number) => (h % 3 === 0 ? String(h) : '')}
              tick={{ fontSize: 9 }}
              stroke="rgba(128,128,128,0.4)"
              interval={0}
            />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
            <Tooltip content={<PeakTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
            <Bar dataKey="count" fill="#06b6d4" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <SectionTablePanel
        title={t(ak('staffAnalytics.services.table'))}
        icon={Tags}
        iconClass="from-teal-500 to-cyan-600"
        rows={services}
        getKey={(r) => r.serviceId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                {r.prefix ? (
                  <span className="ms-1.5 text-[10px] font-bold text-muted-foreground align-middle" dir="ltr">
                    {r.prefix}
                  </span>
                ) : null}
              </span>
            ),
          },
          {
            header: t('totalReservations'),
            className: 'w-16 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.reservations).toLocaleString()}</span>,
          },
          {
            header: t('completed'),
            className: 'w-16 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.completed).toLocaleString()}</span>,
          },
          {
            header: t('cancelled'),
            className: 'w-16 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.cancelled).toLocaleString()}</span>,
          },
          {
            header: t(ak('staffAnalytics.services.demand')),
            className: 'w-16 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.demand).toFixed(0)}%</span>,
          },
          {
            header: t(ak('staffAnalytics.services.avgWait')),
            className: 'w-20 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => (
              <span dir="ltr">
                {r.avgWaitMinutes === null ? '—' : `${safe(r.avgWaitMinutes).toFixed(0)} ${t('min')}`}
              </span>
            ),
          },
          {
            header: t(ak('staffAnalytics.overview.avgService')),
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
