'use client';

// ─── Task 54-c: Customer Satisfaction section (doc-2 §23) ────────────────────
// GET /api/agency/analytics/satisfaction — review aggregates only: average
// rating, star distribution, response rate, ratings by service / branch and
// the monthly rating trend.

import { useLanguage } from '@/hooks/use-language';
import { MessageSquareHeart, Star, TrendingUp } from 'lucide-react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
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
  formatBucket,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerSatisfactionData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

export function OwnerSatisfactionSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerSatisfactionData>(
    'satisfaction',
    query,
    // Zero-safe: no reviews in the period → summary.count === 0.
    { isEmpty: (d) => (d.summary?.count ?? 0) === 0 },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const summary = data.summary;

  const distData = Array.from({ length: 5 }, (_, i) => {
    const found = (summary.distribution ?? []).find((d) => d.stars === 5 - i);
    return { stars: `${5 - i}★`, count: safe(found?.count) };
  });
  const hasDist = distData.some((p) => p.count > 0);

  const trendData = (data.ratingTrend ?? []).map((p) => ({ bucket: p.bucket, avgRating: p.avgRating === null ? 0 : safe(p.avgRating), count: safe(p.count) }));
  const hasTrend = trendData.length > 0 && trendData.some((p) => p.count > 0);

  const DistTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('ownerAnalytics.satisfaction.reviews'))}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          {t(ak('ownerAnalytics.satisfaction.avgRating'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload.find((p) => p.dataKey === 'avgRating')?.value ?? 0).toFixed(1)}</span>
        </p>
        <p className="text-muted-foreground">
          {t(ak('ownerAnalytics.satisfaction.reviews'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload.find((p) => p.dataKey === 'count')?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const ratingColumns = [
    {
      header: t(ak('adminAnalytics.table.name')),
      className: 'flex-1 min-w-0',
      cell: (r: { name: string }) => <span className="font-bold truncate block" title={r.name}>{r.name}</span>,
    },
    {
      header: t(ak('ownerAnalytics.satisfaction.reviews')),
      className: 'w-16 text-center shrink-0',
      align: 'center' as const,
      cell: (r: { count: number }) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
    },
    {
      header: t(ak('ownerAnalytics.satisfaction.avgRating')),
      className: 'w-20 text-center shrink-0',
      align: 'center' as const,
      cell: (r: { avgRating: number | null }) => (
        <span dir="ltr" className="inline-flex items-center gap-1">
          <Star className="h-3 w-3 text-amber-500 fill-amber-500" aria-hidden="true" />
          {r.avgRating === null ? '—' : safe(r.avgRating).toFixed(1)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <StatTiles
        items={[
          {
            icon: Star,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('ownerAnalytics.satisfaction.avgRating')),
            value: summary.average === null ? 0 : safe(summary.average),
            text: summary.average === null ? '—' : undefined,
            decimals: summary.average === null ? undefined : 1,
            suffix: summary.average === null ? undefined : ' / 5',
          },
          {
            icon: MessageSquareHeart,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.satisfaction.reviews')),
            value: safe(summary.count),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.satisfaction.responseRate')),
            value: safe(summary.responseRate),
            decimals: 1,
            suffix: '%',
          },
          {
            icon: MessageSquareHeart,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('ownerAnalytics.satisfaction.responded')),
            value: safe(summary.responded),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title={t(ak('ownerAnalytics.satisfaction.distribution'))}
          icon={Star}
          iconClass="from-amber-500 to-orange-500"
          empty={!hasDist}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={distData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis dataKey="stars" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
              <Tooltip content={<DistTooltip />} cursor={{ fill: 'rgba(245,158,11,0.08)' }} />
              <Bar dataKey="count" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={34} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard
          title={t(ak('ownerAnalytics.satisfaction.trend'))}
          icon={TrendingUp}
          iconClass="from-emerald-500 to-teal-600"
          empty={!hasTrend}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={(v: string) => formatBucket(String(v), lang)}
                tick={{ fontSize: 10 }}
                stroke="rgba(128,128,128,0.4)"
                tickLine={false}
                minTickGap={18}
              />
              <YAxis domain={[0, 5]} tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
              <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
              <Line type="monotone" dataKey="avgRating" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionTablePanel
          title={t(ak('ownerAnalytics.satisfaction.byService'))}
          icon={MessageSquareHeart}
          iconClass="from-emerald-500 to-teal-600"
          rows={data.byService ?? []}
          getKey={(r) => r.serviceId}
          columns={ratingColumns}
        />
        <SectionTablePanel
          title={t(ak('ownerAnalytics.satisfaction.byBranch'))}
          icon={MessageSquareHeart}
          iconClass="from-teal-500 to-cyan-600"
          rows={data.byBranch ?? []}
          getKey={(r) => r.branchId}
          columns={ratingColumns}
        />
      </div>
    </div>
  );
}
