'use client';

// ─── Task 54-b: Users section (doc-2 §11) ────────────────────────────────────
// GET /api/admin/analytics/users — totals KPI tiles, DAU/WAU/MAU, new-users
// trend chart, users/new users by role lists.

import { useLanguage } from '@/hooks/use-language';
import { UserCheck, UserMinus, UserPlus, Users, UsersRound } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { humanizeEnum } from '@/lib/enum-i18n';
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
import type { AdminUsersData } from './section-types';

export function UsersSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminUsersData>('users', query, {
    isEmpty: (d) => (d.totals?.totalUsers ?? 0) === 0,
  });
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;
  // Localized period label for the "New users — {period}" captions.
  const periodText = localizedPeriodLabel(resolved ? resolved.period : '', t);

  const trendData = (data.newUsersTimeseries ?? []).map((p) => ({ bucket: p.bucket, count: safe(p.count) }));
  const hasTrend = trendData.some((p) => p.count > 0);

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.users.newInPeriod'), { period: periodText })}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const kpis = [
    {
      icon: Users,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      label: t(ak('adminAnalytics.users.total')),
      value: safe(totals.totalUsers),
    },
    {
      icon: UserCheck,
      iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
      label: t(ak('adminAnalytics.users.active')),
      value: safe(totals.activeUsers),
    },
    {
      icon: UserPlus,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      label: t(ak('adminAnalytics.users.newInPeriod'), { period: periodText }),
      value: safe(totals.newUsersInPeriod),
    },
    {
      icon: UsersRound,
      iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
      label: t(ak('adminAnalytics.users.verified')),
      value: safe(totals.verifiedUsers),
    },
    {
      icon: UserMinus,
      iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
      label: t(ak('adminAnalytics.users.suspended')),
      value: safe(totals.suspendedUsers),
    },
  ];

  const activityTiles = [
    { key: 'adminAnalytics.users.dau' as const, value: safe(data.activity?.dau) },
    { key: 'adminAnalytics.users.wau' as const, value: safe(data.activity?.wau) },
    { key: 'adminAnalytics.users.mau' as const, value: safe(data.activity?.mau) },
  ];

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}
      <StatTiles items={kpis} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('adminAnalytics.users.newTrend'))}
            icon={UserPlus}
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
                <Area
                  type="monotone"
                  dataKey="count"
                  name={t(ak('adminAnalytics.users.newInPeriod'), { period: periodText })}
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.18}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <div className="min-w-0">
          <StatTiles
            items={activityTiles.map((a) => ({
              icon: UserCheck,
              iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
              label: t(a.key),
              value: a.value,
            }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CountListPanel
          title={t(ak('adminAnalytics.users.byRole'))}
          icon={Users}
          iconClass="from-emerald-500 to-teal-600"
          rows={Object.entries(data.byRole ?? {})
            .map(([role, count]) => ({ label: humanizeEnum(role), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('adminAnalytics.users.newByRole'))}
          icon={UserPlus}
          iconClass="from-amber-500 to-orange-500"
          rows={Object.entries(data.newByRole ?? {})
            .map(([role, count]) => ({ label: humanizeEnum(role), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>
    </div>
  );
}
