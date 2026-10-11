'use client';

// ─── Task 42-e: Agency Analytics & Statistics — section root ────────────────
//
// Task 54-c: the export is now the SECTION SHELL — a horizontal sub-nav strip
// (doc-2 §16: Overview/Reservations/Queue/Branches/Staff/Customers/Satisfaction/
// Working Hours/Payments/Devices) with 'overview' rendering the ORIGINAL
// dashboard one-to-one below it (its header, period select, refresh and all
// legacy panels are untouched) and every other section rendering a shared
// toolbar (period selector incl. custom range + refresh) above its own body,
// backed by GET /api/agency/analytics/<section> (frozen 54-a contract,
// agent-ctx/54-a-analytics-contract.md §2).
//
// §37 RESTRICTED SECTIONS: working-hours + payments answer 403 for
// AGENCY_STAFF callers server-side — the shell hides those tabs for non-owner
// viewers using the SAME authority state the agency shell already has
// (session role + useAgencyAuthority; fail-open while the authority fetch is
// in flight, matching the sidebar convention).
//
// Original overview layout: header (title + period + refresh) → KPI cards →
// channel panel → trend + status donut → hourly traffic + no-show → heatmap →
// services + branches/counters → ratings.
//
// States: loading skeletons · 404 → "update required" · error + retry · empty.
// Palette: emerald/teal/cyan primary, amber warning, rose negative — no
// indigo/blue. RTL-aware with LTR-wrapped numeric/chart zones.

import { useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { useAgencyAuthority } from '@/hooks/use-agency-authority';
import { Input } from '@/components/ui/input';
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
// Task 54-c — owner sub-nav sections (frozen 54-a contract §2).
import {
  OWNER_SECTION_COMPONENTS,
  OWNER_SECTION_NAV,
  OWNER_SECTION_TITLE_KEYS,
} from './section-registry';
// Task 54-d — STAFF variant (frozen 54-a contract §3): session role
// AGENCY_STAFF renders the scoped staff module (§29-37) instead of the owner
// sub-nav. Owners/admins keep the owner nav unchanged.
import { StaffAnalyticsView } from './staff-dashboard';
import { OWNER_SECTION_PERIODS, type OwnerSectionId, type OwnerSectionPeriod } from './section-types';
import type { OwnerSectionQuery } from './use-owner-section-data';

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

// ─── Task 54-c: shell period labels + custom range helpers ──────────────
function sectionPeriodLabelKey(period: OwnerSectionPeriod): string {
  switch (period) {
    case '7d':
      return 'analyticsSection.period7d';
    case '30d':
      return 'analyticsSection.period30d';
    case 'today':
      return 'adminAnalytics.period.today';
    case 'this-month':
      return 'adminAnalytics.period.thisMonth';
    case 'this-year':
      return 'adminAnalytics.period.thisYear';
    case 'custom':
      return 'adminAnalytics.period.custom';
  }
}

/** ISO date (yyyy-mm-dd) for `days` days before today (UTC — matches backend). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── Task 54-c: sub-navigation strip — horizontal scroll on mobile, wrap on lg.
function OwnerSectionNav({
  active,
  items,
  onChange,
}: {
  active: OwnerSectionId;
  items: typeof OWNER_SECTION_NAV;
  onChange: (id: OwnerSectionId) => void;
}) {
  const { t } = useLanguage();
  return (
    <nav
      className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-1 px-1 lg:flex-wrap lg:overflow-x-visible lg:mx-0 lg:px-0 custom-scrollbar"
      role="tablist"
      aria-label={t('analyticsSection.title')}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const selected = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`agency-analytics-tab-${item.id}`}
            aria-selected={selected}
            aria-controls="agency-analytics-section-panel"
            onClick={() => onChange(item.id)}
            className={`shrink-0 lg:shrink inline-flex items-center gap-1.5 h-9 px-3 rounded-xl text-xs font-bold transition-colors border ${
              selected
                ? 'bg-emerald-600 text-white border-transparent shadow-sm shadow-emerald-600/30'
                : 'bg-white dark:bg-gray-900/80 text-muted-foreground hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border-border'
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {t(ak(item.labelKey))}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Task 54-c: SECTION SHELL (sub-nav + overview dashboard | section page) ──
// Task 54-d dispatcher: NO hooks after the role read, so the staff/owner
// branch can never change this component's hook order across renders.
export function AgencyAnalytics() {
  const user = useAppStore((s) => s.user);
  // STAFF viewers get their own doc-2 §30 module (My Overview / Today's Queue
  // / My Performance / My Services) scoped by branch/counter and
  // permission-checked server-side (403 → friendly panel inside the view).
  // Owners/admins fall through to the owner shell unchanged (54-c regression
  // guard) — do NOT regress: the owner sub-nav below is byte-stable.
  if (user?.role === 'AGENCY_STAFF') {
    return <StaffAnalyticsView />;
  }
  return <OwnerAnalyticsSectionShell />;
}

function OwnerAnalyticsSectionShell() {
  const { t } = useLanguage();
  const user = useAppStore((s) => s.user);
  const { authority } = useAgencyAuthority();
  const [activeSection, setActiveSection] = useState<OwnerSectionId>('overview');
  const [period, setPeriod] = useState<OwnerSectionPeriod>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // §37 — hide the restricted sections (working-hours + payments) from
  // non-owner viewers. Owners/admins always pass; AGENCY_STAFF sessions only
  // once their my-authority payload confirms ownership (fail-open while the
  // fetch is in flight — the same convention the agency sidebar uses).
  const isOwnerViewer =
    user?.role === 'SUPER_ADMIN' ||
    user?.role === 'AGENCY_OWNER' ||
    authority === null ||
    authority.isOwner === true ||
    authority.role === 'OWNER';
  const visibleNav = OWNER_SECTION_NAV.filter((item) => !item.ownerOnly || isOwnerViewer);

  // If the active section becomes hidden (late authority landing / demotion),
  // fall back to the overview instead of rendering a server-403 page body.
  useEffect(() => {
    setActiveSection((prev) =>
      prev !== 'overview' && !OWNER_SECTION_NAV.some((i) => i.id === prev && (!i.ownerOnly || isOwnerViewer))
        ? 'overview'
        : prev,
    );
  }, [isOwnerViewer]);

  const isCustom = period === 'custom';
  const customReady = Boolean(customFrom) && Boolean(customTo);

  const handlePeriodChange = (p: OwnerSectionPeriod) => {
    setPeriod(p);
    // Pre-fill the custom range (last 30 days incl. today) so the first
    // selection is immediately valid — the backend 400s on missing dates.
    if (p === 'custom') {
      setCustomFrom((prev) => prev || isoDaysAgo(29));
      setCustomTo((prev) => prev || isoDaysAgo(0));
    }
  };

  // Overview: the pre-existing dashboard, rendering exactly as before —
  // only re-homed under the sub-navigation strip.
  if (activeSection === 'overview') {
    return (
      <>
        <div className="p-4 sm:p-6 pb-0 sm:pb-0 max-w-6xl mx-auto">
          <OwnerSectionNav active={activeSection} items={visibleNav} onChange={setActiveSection} />
        </div>
        <OverviewDashboard />
      </>
    );
  }

  const SectionBody = OWNER_SECTION_COMPONENTS[activeSection];
  const customHint = t(ak('adminAnalytics.period.customHint'));
  const query: OwnerSectionQuery = { period, from: customFrom || undefined, to: customTo || undefined, reloadToken };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <OwnerSectionNav active={activeSection} items={visibleNav} onChange={setActiveSection} />

      {/* ── Section toolbar: title + period selector + refresh ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-lg font-black text-foreground leading-tight truncate">
            {t(ak(OWNER_SECTION_TITLE_KEYS[activeSection]))}
          </h1>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={period} onValueChange={(v) => handlePeriodChange(v as OwnerSectionPeriod)}>
            <SelectTrigger className="h-9 w-[150px] text-xs" aria-label={t('analyticsSection.title')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OWNER_SECTION_PERIODS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {t(ak(sectionPeriodLabelKey(p)))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => setReloadToken((n) => n + 1)}
            aria-label={t('refresh')}
            title={t('refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Custom range row (period === custom) ── */}
      {isCustom && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-border bg-white dark:bg-gray-900/80 p-3">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            {t(ak('adminAnalytics.period.from'))}
            <Input
              type="date"
              value={customFrom}
              max={customTo || undefined}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 w-40 text-xs"
              dir="ltr"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            {t(ak('adminAnalytics.period.to'))}
            <Input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 w-40 text-xs"
              dir="ltr"
            />
          </label>
          {!customReady && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
              {t(ak('adminAnalytics.period.customHint'))}
            </p>
          )}
        </div>
      )}

      {/* ── Section body ── */}
      <div id="agency-analytics-section-panel" role="tabpanel" aria-labelledby={`agency-analytics-tab-${activeSection}`}>
        <SectionBody query={query} customHint={customHint} />
      </div>
    </div>
  );
}

// ─── Original overview dashboard (Task 42-e) — behavior unchanged ────────
function OverviewDashboard() {
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
