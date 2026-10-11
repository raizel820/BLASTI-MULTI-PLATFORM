'use client';

// ─── Task 54-b: Queues section (doc-2 §9) ────────────────────────────────────
// GET /api/admin/analytics/queues — live platform queue counters (open/paused/
// waiting/called/serving), today's served tickets, period KPIs (wait stats,
// call rates, no-show/abandonment) and the calls-by-hour chart.

import { useLanguage } from '@/hooks/use-language';
import { Activity, ListOrdered, PauseCircle, PhoneCall, UserX, Users } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import {
  ChartCard,
  ChartTooltipBox,
  StatTiles,
  SectionStatePanels,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminQueuesData } from './section-types';

const CALLS_COLOR = '#0891b2'; // cyan-600

export function QueuesSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminQueuesData>('queues', query, {
    isEmpty: (d) =>
      (d.live?.currentlyWaiting ?? 0) === 0 &&
      (d.live?.currentlyServing ?? 0) === 0 &&
      (d.today?.ticketsServedToday ?? 0) === 0 &&
      (d.period?.ticketsInPeriod ?? 0) === 0,
  });
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const live = data.live;
  const period = data.period;

  const hourlyData = Array.from({ length: 24 }, (_, hour) => {
    const found = (period.hourlyCalls ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const hasHourly = hourlyData.some((p) => p.count > 0);

  const HourlyTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const hour = Number(props.label ?? 0);
    const hourLabel = lang === 'ar' ? `${hour}:00` : hour < 12 ? `${hour === 0 ? 12 : hour}AM` : hour === 12 ? '12PM' : `${hour - 12}PM`;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{hourLabel}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.queues.calls'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}

      {/* Live counters */}
      <StatTiles
        items={[
          {
            icon: ListOrdered,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.queues.openQueues')),
            value: safe(live.agenciesWithOpenQueue),
          },
          {
            icon: Users,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.queues.waitingNow')),
            value: safe(live.currentlyWaiting),
          },
          {
            icon: PhoneCall,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.queues.calledNow')),
            value: safe(live.currentlyCalled),
          },
          {
            icon: Activity,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.queues.servingNow')),
            value: safe(live.currentlyServing),
          },
        ]}
      />

      {/* Today + period KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <PeriodStat
          label={t(ak('adminAnalytics.queues.servedToday'))}
          value={safe(data.today?.ticketsServedToday)}
        />
        <PeriodStat label={t(ak('adminAnalytics.queues.ticketsInPeriod'))} value={safe(period.ticketsInPeriod)} />
        <PeriodStat label={t(ak('adminAnalytics.queues.servedInPeriod'))} value={safe(period.ticketsServedInPeriod)} />
        <PeriodStat label={t(ak('adminAnalytics.queues.calls'))} value={safe(period.callsInPeriod)} />
        <PeriodStat
          label={t('avgWaitTime')}
          value={period.avgWaitingTimeMinutes === null ? 0 : safe(period.avgWaitingTimeMinutes)}
          text={period.avgWaitingTimeMinutes === null ? '—' : `${safe(period.avgWaitingTimeMinutes).toFixed(1)} ${t('min')}`}
        />
        <PeriodStat
          label={t('avgServiceTime')}
          value={period.avgServiceDurationMinutes === null ? 0 : safe(period.avgServiceDurationMinutes)}
          text={period.avgServiceDurationMinutes === null ? '—' : `${safe(period.avgServiceDurationMinutes).toFixed(1)} ${t('min')}`}
        />
        <PeriodStat
          label={t('noShowRate')}
          value={safe(period.noShowRate)}
          text={`${safe(period.noShowRate).toFixed(1)}%`}
          tone="rose"
        />
        <PeriodStat
          label={t(ak('adminAnalytics.queues.abandonment'))}
          value={safe(period.abandonmentRate)}
          text={`${safe(period.abandonmentRate).toFixed(1)}%`}
          tone="amber"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('adminAnalytics.queues.hourlyCalls'))}
            icon={PhoneCall}
            iconClass="from-cyan-500 to-teal-600"
            empty={!hasHourly}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h: number) => (h % 3 === 0 ? String(h) : '')}
                  tick={{ fontSize: 9 }}
                  stroke="rgba(128,128,128,0.4)"
                  interval={0}
                />
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
                <Tooltip content={<HourlyTooltip />} cursor={{ fill: 'rgba(8,145,178,0.08)' }} />
                <Bar dataKey="count" fill={CALLS_COLOR} radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <StatTiles
          items={[
            {
              icon: PauseCircle,
              iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
              label: t(ak('adminAnalytics.queues.paused')),
              value: safe(live.agenciesPaused),
            },
            {
              icon: UserX,
              iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
              label: t(ak('adminAnalytics.queues.callsPerHour')),
              value: safe(period.callsPerHour),
              decimals: 1,
            },
            {
              icon: Users,
              iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
              label: t(ak('adminAnalytics.queues.servedPerHour')),
              value: safe(period.customersServedPerHour),
              decimals: 1,
            },
            {
              icon: Activity,
              iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
              label: t(ak('adminAnalytics.res.medianWait')),
              value: period.medianWaitingTimeMinutes === null ? 0 : safe(period.medianWaitingTimeMinutes),
              text: period.medianWaitingTimeMinutes === null ? '—' : `${safe(period.medianWaitingTimeMinutes).toFixed(1)}`,
            },
          ]}
        />
      </div>
    </div>
  );
}

function PeriodStat({
  label,
  value,
  text,
  tone = 'emerald',
}: {
  label: string;
  value: number;
  text?: string;
  tone?: 'emerald' | 'rose' | 'amber';
}) {
  const toneClass =
    tone === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : tone === 'amber'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-foreground';
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
      <CardContent className="p-3 sm:p-4">
        <p className={`text-lg sm:text-xl font-black leading-none ${toneClass}`} dir="ltr">
          {text ?? value.toLocaleString()}
        </p>
        <p className="mt-1.5 text-[11px] font-medium text-muted-foreground truncate" title={label}>
          {label}
        </p>
      </CardContent>
    </Card>
  );
}
