'use client';

// ─── Task 54-b: Payments & Revenue section (doc-2 §13) ───────────────────────
// GET /api/admin/analytics/payments — revenue KPIs, revenue trend area chart,
// transactions by status and by payment method.

import { useLanguage } from '@/hooks/use-language';
import { Banknote, CircleCheckBig, Clock3, CreditCard, Receipt, TrendingUp, XCircle } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { humanizeEnum, translatePaymentMethod } from '@/lib/enum-i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminPaymentsData } from './section-types';

export function PaymentsSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminPaymentsData>(
    'payments',
    query,
    { isEmpty: (d) => (d.totals?.transactionsInPeriod ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;
  const currency = totals.currency || 'DZD';

  const trendData = (data.revenueTimeseries ?? []).map((p) => ({ bucket: p.bucket, revenue: safe(p.revenue) }));
  const hasTrend = trendData.some((p) => p.revenue > 0);

  const RevenueTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.pay.revenue'))}:{' '}
          <span className="font-bold text-foreground" dir="ltr">
            {Number(props.payload[0]?.value ?? 0).toLocaleString()} {currency}
          </span>
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
            icon: Banknote,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: `${t(ak('adminAnalytics.pay.revenue'))} (${currency})`,
            value: safe(totals.totalRevenue),
          },
          {
            icon: Receipt,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.pay.transactions')),
            value: safe(totals.transactionsInPeriod),
          },
          {
            icon: CircleCheckBig,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.pay.successful')),
            value: safe(totals.successfulPayments),
          },
          {
            icon: Clock3,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.pay.pending')),
            value: safe(totals.pendingPayments),
          },
          {
            icon: XCircle,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.pay.rejected')),
            value: safe(totals.rejectedPayments),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.pay.avgValue')),
            value: safe(totals.avgTransactionValue),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('adminAnalytics.pay.trend'))}
            icon={TrendingUp}
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
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  width={48}
                  allowDecimals={false}
                  tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : String(v))}
                />
                <Tooltip content={<RevenueTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.18}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <CountListPanel
          title={t(ak('adminAnalytics.pay.byStatus'))}
          icon={Receipt}
          iconClass="from-amber-500 to-orange-500"
          rows={Object.entries(data.byStatus ?? {})
            .map(([status, block]) => ({
              label: humanizeEnum(status),
              count: safe(block?.count),
              extra: `${safe(block?.value).toLocaleString()} ${currency}`,
            }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      <CountListPanel
        title={t(ak('adminAnalytics.pay.byMethod'))}
        icon={CreditCard}
        iconClass="from-teal-500 to-cyan-600"
        rows={Object.entries(data.byPaymentMethod ?? {})
          .map(([method, block]) => {
            const value = typeof block === 'object' && block !== null ? safe((block as { value?: number }).value) : safe(block as number);
            const count = typeof block === 'object' && block !== null ? safe((block as { count?: number }).count) : 0;
            return { label: translatePaymentMethod(method, t), count, extra: `${value.toLocaleString()} ${currency}` };
          })
          .sort((a, b) => b.count - a.count)}
      />
    </div>
  );
}
