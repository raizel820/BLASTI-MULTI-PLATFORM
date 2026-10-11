'use client';

// ─── Task 54-c: Payments section (doc-2 §26 — OWNER-ONLY server-side) ────────
// GET /api/agency/analytics/payments — ONLY this agency's transactions: paid /
// pending / rejected counts + values, payment methods, revenue trend and the
// current subscription block (plan / status / renewal — §26 "upcoming
// renewal/payment"). The shell hides this tab from non-owner viewers
// (staff → 403 server-side per §37).

import { useLanguage } from '@/hooks/use-language';
import { BadgeDollarSign, CheckCircle2, Clock3, CreditCard, Receipt, TrendingUp, XCircle } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getLocale } from '@/components/agency/dashboard/helpers';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  StatTiles,
  formatBucket,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerPaymentsData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

const STATUS_COLORS: Record<string, string> = {
  APPROVED: '#10b981',
  PENDING: '#f59e0b',
  REJECTED: '#ef4444',
  CANCELLED: '#94a3b8',
};

export function OwnerPaymentsSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerPaymentsData>(
    'payments',
    query,
    // Zero-safe: no transactions in the period → totals are 0 + zero-filled
    // timeseries. Keep rendering (the subscription strip may still matter).
    { isEmpty: (d) => (d.totals?.transactionsInPeriod ?? 0) === 0 && !d.subscription },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;
  const currency = totals.currency || 'DZD';

  const fmtMoney = (v: number): string => {
    try {
      return new Intl.NumberFormat(getLocale(lang), { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
    } catch {
      return `${v.toLocaleString()} ${currency}`;
    }
  };

  const trendData = (data.paymentTimeseries ?? []).map((p) => ({ bucket: p.bucket, value: safe(p.value) }));
  const hasTrend = trendData.some((p) => p.value > 0);

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          {t(ak('ownerAnalytics.pay.paidValue'))}:{' '}
          <span className="font-bold text-foreground">{fmtMoney(Number(props.payload[0]?.value ?? 0))}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const sub = data.subscription;
  const subExpires = sub?.expiresAt
    ? (() => {
        try {
          return new Intl.DateTimeFormat(getLocale(lang), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(sub.expiresAt));
        } catch {
          return sub.expiresAt.slice(0, 10);
        }
      })()
    : null;

  return (
    <div className="space-y-4">
      {/* ── Subscription strip (§26 upcoming renewal) ── */}
      {sub && (
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
                <CreditCard className="h-5 w-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-black text-foreground truncate">
                    {sub.plan?.displayName || sub.plan?.name || sub.tier}
                  </p>
                  <Badge className="text-[10px] h-5 bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300 shrink-0">
                    {sub.tier}
                  </Badge>
                  <Badge
                    className={`text-[10px] h-5 shrink-0 ${
                      sub.status === 'ACTIVE'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                    }`}
                  >
                    {sub.status}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground truncate">
                  {subExpires
                    ? t(ak('ownerAnalytics.pay.renewsOn'), { date: subExpires })
                    : t(ak('ownerAnalytics.pay.noRenewal'))}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <StatTiles
        items={[
          {
            icon: Receipt,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.pay.transactions')),
            value: safe(totals.transactionsInPeriod),
          },
          {
            icon: CheckCircle2,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.pay.paidCount')),
            value: safe(totals.paid),
          },
          {
            icon: Clock3,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('ownerAnalytics.pay.pending')),
            value: safe(totals.pending),
          },
          {
            icon: XCircle,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('ownerAnalytics.pay.rejected')),
            value: safe(totals.rejected),
          },
          {
            icon: BadgeDollarSign,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.pay.totalPaid')),
            value: safe(totals.totalPaid),
            text: fmtMoney(safe(totals.totalPaid)),
          },
        ]}
      />

      <ChartCard
        title={t(ak('ownerAnalytics.pay.trend'))}
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
              width={64}
              allowDecimals={false}
              tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
            />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
            <Area type="monotone" dataKey="value" stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CountListPanel
          title={t(ak('ownerAnalytics.pay.byStatus'))}
          icon={Receipt}
          iconClass="from-emerald-500 to-teal-600"
          rows={Object.entries(data.byStatus ?? {})
            .map(([status, agg]) => ({
              label: status,
              count: safe(agg?.count),
              extra: fmtMoney(safe(agg?.value)),
            }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('ownerAnalytics.pay.byMethod'))}
          icon={CreditCard}
          iconClass="from-cyan-500 to-teal-600"
          rows={Object.entries(data.byPaymentMethod ?? {})
            .map(([method, count]) => ({ label: method, count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>
    </div>
  );
}
