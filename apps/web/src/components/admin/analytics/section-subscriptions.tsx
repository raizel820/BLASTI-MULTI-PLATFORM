'use client';

// ─── Task 54-b: Subscriptions section (doc-2 §12) ────────────────────────────
// GET /api/admin/analytics/subscriptions — subscription totals + plan/tier/
// status distributions.

import { useLanguage } from '@/hooks/use-language';
import { BadgeCheck, CalendarClock, Crown, FileStack, PackageX, PlusCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { humanizeEnum } from '@/lib/enum-i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  StatTiles,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminSubscriptionsData } from './section-types';

export function SubscriptionsSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminSubscriptionsData>(
    'subscriptions',
    query,
    {
      isEmpty: (d) =>
        (d.totals?.plansInCatalog ?? 0) === 0 &&
        (d.totals?.activeSubscriptions ?? 0) === 0 &&
        (d.totals?.agenciesWithoutPlan ?? 0) === 0 &&
        Object.keys(d.byTier ?? {}).length === 0,
    },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;

  const planRows = (data.planDistribution ?? []).map((p) => ({
    label: p.planName || p.planId,
    count: safe(p.agencies),
  }));
  const hasPlanChart = planRows.some((r) => r.count > 0);

  const chartData = planRows;

  const PlanTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground max-w-48 truncate">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t('totalAgencies')}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
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
            icon: BadgeCheck,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.subs.active')),
            value: safe(totals.activeSubscriptions),
          },
          {
            icon: PlusCircle,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.subs.newInPeriod')),
            value: safe(totals.newSubscriptionsInPeriod),
          },
          {
            icon: CalendarClock,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.subs.expiring')),
            value: safe(totals.expiringWithin30Days),
          },
          {
            icon: PackageX,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.subs.withoutPlan')),
            value: safe(totals.agenciesWithoutPlan),
          },
          {
            icon: FileStack,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.subs.catalog')),
            value: safe(totals.plansInCatalog),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('adminAnalytics.subs.distribution'))}
            icon={Crown}
            iconClass="from-emerald-500 to-teal-600"
            empty={!hasPlanChart}
            heightClass="h-56"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  width={140}
                  tickLine={false}
                />
                <Tooltip content={<PlanTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
                <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={22} isAnimationActive={false} fill="#10b981" fillOpacity={0.85} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <div className="grid grid-cols-1 gap-4 content-start">
          <CountListPanel
            title={t(ak('adminAnalytics.subs.byTier'))}
            icon={Crown}
            iconClass="from-amber-500 to-orange-500"
            rows={Object.entries(data.byTier ?? {})
              .map(([tier, count]) => ({ label: humanizeEnum(tier), count: safe(count) }))
              .sort((a, b) => b.count - a.count)}
          />
          <CountListPanel
            title={t(ak('adminAnalytics.agencies.byStatus'))}
            icon={BadgeCheck}
            iconClass="from-teal-500 to-cyan-600"
            rows={Object.entries(data.byStatus ?? {})
              .map(([status, count]) => ({ label: humanizeEnum(status), count: safe(count) }))
              .sort((a, b) => b.count - a.count)}
          />
        </div>
      </div>
    </div>
  );
}
