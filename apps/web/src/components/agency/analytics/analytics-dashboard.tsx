'use client';

// ─── Task 42-e: Agency Analytics & Statistics — section root ────────────────
// Dedicated sidebar section (replaces the fragmented deep-analytics widgets
// that used to live inside the agency dashboard). Fetches
// GET /api/agency/analytics/dashboard?period=… (identical shape on cloud +
// desktop local API) and lays out the KPI cards, trend, status donut, hourly
// traffic, heatmap, service/branch/counter breakdowns, ratings and no-show
// panels. Self-handles loading / error / endpoint-unavailable (404 → update
// required) / empty states — mounted WITHOUT an AuthorityGate wrapper (like
// admin-analytics); authority filtering happens in the sidebar + server.

import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, BarChart3, Inbox, RefreshCw, ServerCrash } from 'lucide-react';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { ak } from './i18n-keys';
import { useAnalyticsData } from './use-analytics-data';
import { ANALYTICS_PERIODS, type AnalyticsPeriod } from './types';
import { KpiCards } from './kpi-cards';
import { ReservationsTrendChart } from './reservations-trend-chart';
import { StatusDistributionChart } from './status-distribution-chart';
import { HourlyTrafficChart } from './hourly-traffic-chart';
import { HeatmapPanel } from './heatmap-panel';
import { ServiceBreakdown } from './service-breakdown';
import { BranchesCountersPanel } from './branches-counters-panel';
import { RatingsPanel } from './ratings-panel';
import { NoShowPanel } from './no-show-panel';
// Task 46 — online vs walk-in channel analytics (shared with the admin
// section; the dashboard payload now carries a `channel` block).
import { ChannelPanel } from '@/components/admin/analytics/channel-panel';

function periodLabel(period: AnalyticsPeriod): string {
  switch (period) {
    case '7d':
      return 'analyticsSection.period7d';
    case '30d':
      return 'analyticsSection.period30d';
    case '90d':
      return 'analyticsSection.period90d';
    case '12m':
      return 'analyticsSection.period12m';
  }
}

// ─── Loading skeleton ────────────────────────────
function AnalyticsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Skeleton className="h-80 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-80 rounded-2xl" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-72 rounded-2xl" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}

// ─── Full-panel message state (error / unavailable / empty) ─────────────────
function MessagePanel({
  icon: Icon,
  iconClass,
  title,
  body,
  action,
}: {
  icon: typeof BarChart3;
  iconClass: string;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
      <CardContent className="py-14 px-6 flex flex-col items-center justify-center text-center">
        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center mb-3 ${iconClass}`}>
          <Icon className="h-6 w-6" />
        </div>
        <p className="text-sm font-bold text-foreground">{title}</p>
        <p className="mt-1.5 text-xs text-muted-foreground max-w-sm leading-relaxed">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </CardContent>
    </Card>
  );
}

export function AgencyAnalytics() {
  const { t, lang } = useLanguage();
  const { period, setPeriod, data, state, lastUpdatedAt, refresh } = useAnalyticsData();

  const refreshedAtCaption = (() => {
    if (!lastUpdatedAt) return null;
    try {
      const time = lastUpdatedAt.toLocaleTimeString(getLocale(lang), { hour: '2-digit', minute: '2-digit' });
      return t(ak('analyticsSection.refreshedAt'), { time });
    } catch {
      return null;
    }
  })();

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      {/* ── Header: title + period select + refresh ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-black text-foreground leading-tight">{t(ak('analyticsSection.title'))}</h1>
            <p className="text-xs text-muted-foreground">{t(ak('analyticsSection.subtitle'))}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={period} onValueChange={(v) => setPeriod(v as AnalyticsPeriod)}>
            <SelectTrigger className="h-9 w-[150px] text-xs" aria-label={t(ak('analyticsSection.title'))}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ANALYTICS_PERIODS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {t(ak(periodLabel(p)))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={refresh}
            disabled={state === 'loading'}
            aria-label={t('refresh')}
            title={t('refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${state === 'loading' ? 'animate-spin text-emerald-600 dark:text-emerald-400' : ''}`} />
          </Button>
        </div>
      </div>

      {refreshedAtCaption && state !== 'loading' && (
        <p className="text-[10px] text-muted-foreground -mt-2">{refreshedAtCaption}</p>
      )}

      {/* ── States ── */}
      {state === 'loading' && <AnalyticsSkeleton />}

      {state === 'unavailable' && (
        <MessagePanel
          icon={ServerCrash}
          iconClass="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
          title={t(ak('analyticsSection.updateRequiredTitle'))}
          body={t(ak('analyticsSection.updateRequiredBody'))}
          action={
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5 me-1.5" />
              {t('retry')}
            </Button>
          }
        />
      )}

      {state === 'error' && (
        <MessagePanel
          icon={AlertTriangle}
          iconClass="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
          title={t(ak('analyticsSection.loadFailed'))}
          body={t(ak('analyticsSection.loadFailedBody'))}
          action={
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5 me-1.5" />
              {t('retry')}
            </Button>
          }
        />
      )}

      {state === 'empty' && (
        <MessagePanel
          icon={Inbox}
          iconClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          title={t(ak('analyticsSection.noData'))}
          body={t('noDataYet')}
        />
      )}

      {state === 'ready' && data && (
        <div className="space-y-4">
          {/* KPI cards */}
          <KpiCards kpis={data.kpis} />

          {/* Online vs walk-in channel (Task 46) — hidden when the payload
              predates the channel block (older local builds). */}
          {data.channel && (
            <ChannelPanel channel={data.channel} kpis={data.kpis} />
          )}

          {/* Trend + status donut */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 min-w-0">
              <ReservationsTrendChart timeseries={data.timeseries} />
            </div>
            <div className="min-w-0">
              <StatusDistributionChart statusDistribution={data.statusDistribution} />
            </div>
          </div>

          {/* Hourly traffic + no-show */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="min-w-0">
              <HourlyTrafficChart hourlyTraffic={data.hourlyTraffic} peak={data.peak ?? null} />
            </div>
            <div className="min-w-0">
              <NoShowPanel kpis={data.kpis} timeseries={data.timeseries} />
            </div>
          </div>

          {/* Weekday × hour heatmap */}
          <HeatmapPanel weekdayHourMatrix={data.weekdayHourMatrix} />

          {/* Services + branches/counters */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="min-w-0">
              <ServiceBreakdown services={data.services} />
            </div>
            <div className="min-w-0">
              <BranchesCountersPanel branches={data.branches} counters={data.counters} />
            </div>
          </div>

          {/* Ratings */}
          <RatingsPanel ratings={data.ratings} />
        </div>
      )}
    </div>
  );
}
