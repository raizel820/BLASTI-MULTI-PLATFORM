'use client';

// ─── Task 54-c: Queue section (doc-2 §19) ────────────────────────────────────
// GET /api/agency/analytics/queue — live queue state (open/paused badge,
// waiting/called/serving counters, next ticket) + period aggregates (wait /
// service durations, calls per hour, no-show & abandonment rates, queue size
// by hour, counter utilization).

import { useLanguage } from '@/hooks/use-language';
import { ListOrdered, Radio, Timer, TrendingUp, Users } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TranslationKeys } from '@/i18n';
import { getLocale } from '@/components/agency/dashboard/helpers';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerQueueData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

export function OwnerQueueSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, resolved: _resolved, state, refresh, isQueryReady } = useOwnerSectionData<OwnerQueueData>(
    'queue',
    query,
    {
      // Zero-safe: the live block exists even for an idle agency — only mark
      // empty when literally nothing is live AND the period had no tickets.
      isEmpty: (d) =>
        (d.live?.queueLength ?? 0) === 0 &&
        (d.live?.currentlyServing ?? 0) === 0 &&
        (d.period?.avgWaitingTimeMinutes ?? null) === null &&
        (d.period?.maxWaitingTimeMinutes ?? null) === null,
    },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const { live, period } = data;

  const hourData = Array.from({ length: 24 }, (_, hour) => {
    const found = (period.queueSizeByHour ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const hasHourData = hourData.some((p) => p.count > 0);

  const HourTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const hour = Number(props.label ?? 0);
    const hourLabel = lang === 'ar' ? `${hour}:00` : hour < 12 ? `${hour === 0 ? 12 : hour}AM` : hour === 12 ? '12PM' : `${hour - 12}PM`;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{hourLabel}</p>
        <p className="text-muted-foreground">
          {t(ak('ownerAnalytics.queue.queueSize'))}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const openedAtLabel = (() => {
    if (!data.queueStatus.openedAt) return null;
    try {
      return new Date(data.queueStatus.openedAt).toLocaleTimeString(getLocale(lang), { hour: '2-digit', minute: '2-digit' });
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-4">
      {/* ── Live queue status strip ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
              <Radio className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-black text-foreground">{t(ak('ownerAnalytics.queue.liveTitle'))}</p>
                <Badge
                  className={`text-[10px] h-5 shrink-0 ${
                    data.queueStatus.isPaused
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      : data.queueStatus.isQueueOpen
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
                  }`}
                >
                  {data.queueStatus.isPaused
                    ? t(ak('ownerAnalytics.queue.paused'))
                    : data.queueStatus.isQueueOpen
                      ? t(ak('ownerAnalytics.queue.open'))
                      : t(ak('ownerAnalytics.queue.closed'))}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground truncate">
                {openedAtLabel
                  ? t(ak('ownerAnalytics.queue.openedAt'), { time: openedAtLabel })
                  : t(ak('ownerAnalytics.queue.notOpened'))}
              </p>
            </div>
          </div>
          <div className="sm:ms-auto flex items-center gap-2 shrink-0">
            {live.nextTicket ? (
              <div className="text-end">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t(ak('ownerAnalytics.queue.nextTicket'))}
                </p>
                <p className="text-lg font-black text-foreground leading-none" dir="ltr">
                  {live.nextTicket.displayNumber}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t(ak('ownerAnalytics.queue.noNextTicket'))}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Live counters + period KPIs ── */}
      <StatTiles
        items={[
          {
            icon: Users,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('ownerAnalytics.queue.waitingNow')),
            value: safe(live.currentlyWaiting),
          },
          {
            icon: Users,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('ownerAnalytics.queue.calledNow')),
            value: safe(live.currentlyCalled),
          },
          {
            icon: Users,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.queue.servingNow')),
            value: safe(live.currentlyServing),
          },
          {
            icon: Timer,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.queue.avgCurrentWait')),
            value: live.avgCurrentWaitMinutes === null ? 0 : safe(live.avgCurrentWaitMinutes),
            text: live.avgCurrentWaitMinutes === null ? '—' : undefined,
            decimals: live.avgCurrentWaitMinutes === null ? undefined : 0,
            suffix: live.avgCurrentWaitMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: Timer,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('avgWaitTime'),
            value: period.avgWaitingTimeMinutes === null ? 0 : safe(period.avgWaitingTimeMinutes),
            text: period.avgWaitingTimeMinutes === null ? '—' : undefined,
            decimals: period.avgWaitingTimeMinutes === null ? undefined : 1,
            suffix: period.avgWaitingTimeMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: Timer,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('ownerAnalytics.res.avgService')),
            value: period.avgServiceDurationMinutes === null ? 0 : safe(period.avgServiceDurationMinutes),
            text: period.avgServiceDurationMinutes === null ? '—' : undefined,
            decimals: period.avgServiceDurationMinutes === null ? undefined : 1,
            suffix: period.avgServiceDurationMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.queues.callsPerHour')),
            value: safe(period.callsPerHour),
            decimals: 1,
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.queues.abandonment')),
            value: safe(period.abandonmentRate),
            decimals: 1,
            suffix: '%',
          },
        ]}
      />

      {/* ── Queue size by hour ── */}
      <ChartCard
        title={t(ak('ownerAnalytics.queue.queueSizeByHour'))}
        icon={ListOrdered}
        iconClass="from-emerald-500 to-teal-600"
        empty={!hasHourData}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={hourData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
            <XAxis
              dataKey="hour"
              tickFormatter={(h: number) => (h % 3 === 0 ? String(h) : '')}
              tick={{ fontSize: 9 }}
              stroke="rgba(128,128,128,0.4)"
              interval={0}
            />
            <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
            <Tooltip content={<HourTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
            <Bar dataKey="count" fill="#14b8a6" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Counter utilization ── */}
      <SectionTablePanel
        title={t(ak('ownerAnalytics.queue.counterUtilization'))}
        icon={ListOrdered}
        iconClass="from-cyan-500 to-teal-600"
        rows={period.counterUtilization ?? []}
        getKey={(r) => r.counterId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                {!r.isActive && (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 ms-1.5 align-middle">
                    {t(ak('ownerAnalytics.queue.counterInactive'))}
                  </Badge>
                )}
              </span>
            ),
          },
          {
            header: t('completed'),
            className: 'w-14 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.served).toLocaleString()}</span>,
          },
          {
            header: t(ak('ownerAnalytics.queue.utilization')),
            className: 'w-20 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.utilizationPct).toFixed(0)}%</span>,
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
