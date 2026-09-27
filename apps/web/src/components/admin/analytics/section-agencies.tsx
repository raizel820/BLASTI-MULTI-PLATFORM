'use client';

// ─── Task 54-b: Agencies section (contract §1.3) ─────────────────────────────
// GET /api/admin/analytics/agencies — totals KPI tiles, new-agencies trend,
// distributions by category / subscription tier / subscription status,
// platform resource counts (branches / services / counters).

import { useLanguage } from '@/hooks/use-language';
import { Building2, Clock3, DoorOpen, PlusCircle, Store } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { humanizeEnum, translateCategory } from '@/lib/enum-i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  StatTiles,
  SectionStatePanels,
  formatBucket,
  localizedPeriodLabel,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminAgenciesData } from './section-types';

const BAR_COLOR = '#14b8a6'; // teal-500

export function AgenciesSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminAgenciesData>('agencies', query, {
    isEmpty: (d) => (d.totals?.total ?? 0) === 0,
  });
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;
  // Localized period label for the "New agencies — {period}" captions.
  const periodText = localizedPeriodLabel(resolved ? resolved.period : '', t);

  const trendData = (data.newAgenciesTimeseries ?? []).map((p) => ({ bucket: p.bucket, count: safe(p.count) }));
  const hasTrend = trendData.some((p) => p.count > 0);
  const maxCount = trendData.reduce((m, p) => Math.max(m, p.count), 0);

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.agencies.newInPeriod'), { period: periodText })}:{' '}
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
            icon: Building2,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('totalAgencies'),
            value: safe(totals.total),
          },
          {
            icon: Store,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t('activeAgencies'),
            value: safe(totals.active),
          },
          {
            icon: PlusCircle,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.agencies.newInPeriod'), { period: periodText }),
            value: safe(totals.newInPeriod),
          },
          {
            icon: Clock3,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.agencies.pending')),
            value: safe(totals.pendingApprovals),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('adminAnalytics.agencies.newTrend'))}
            icon={PlusCircle}
            iconClass="from-emerald-500 to-teal-600"
            empty={!hasTrend}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
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
                <Tooltip content={<TrendTooltip />} cursor={{ fill: 'rgba(20,184,166,0.08)' }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={26} isAnimationActive={false}>
                  {trendData.map((p, i) => (
                    <Cell key={i} fill={p.count === maxCount ? '#f59e0b' : BAR_COLOR} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <CountListPanel
          title={t(ak('adminAnalytics.agencies.byCategory'))}
          icon={Building2}
          iconClass="from-teal-500 to-cyan-600"
          rows={Object.entries(data.byCategory ?? {})
            .map(([category, count]) => ({ label: translateCategory(category, t), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CountListPanel
          title={t(ak('adminAnalytics.agencies.byTier'))}
          icon={Building2}
          iconClass="from-emerald-500 to-teal-600"
          rows={Object.entries(data.bySubscriptionTier ?? {})
            .map(([tier, count]) => ({ label: humanizeEnum(tier), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('adminAnalytics.agencies.byStatus'))}
          icon={Store}
          iconClass="from-amber-500 to-orange-500"
          rows={Object.entries(data.bySubscriptionStatus ?? {})
            .map(([status, count]) => ({ label: humanizeEnum(status), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('adminAnalytics.agencies.totalBranches')) + ' / ' + t(ak('adminAnalytics.agencies.totalServices'))}
          icon={DoorOpen}
          iconClass="from-cyan-500 to-teal-600"
          subtitle={t('totalAgencies') + ': ' + safe(totals.total).toLocaleString()}
          rows={[
            { label: t(ak('adminAnalytics.agencies.totalBranches')), count: safe(data.platform?.totalBranches) },
            { label: t(ak('adminAnalytics.agencies.totalServices')), count: safe(data.platform?.totalServices) },
            { label: t(ak('adminAnalytics.agencies.totalCounters')), count: safe(data.platform?.totalCounters) },
          ]}
        />
      </div>
    </div>
  );
}
