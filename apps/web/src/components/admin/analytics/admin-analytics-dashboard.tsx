'use client';

// ─── Task 4: Super-Admin Analytics & Statistics — section root ──────────────
// Replaces the previous admin-analytics behind the existing 'admin-analytics'
// view (same `AdminAnalytics` export, same lazy import in src/app/page.tsx).
//
// Task 54-b: the export is now the SECTION SHELL — a horizontal sub-nav strip
// (doc-2 §5.1: Overview/Users/Agencies/Categories/Reservations/Queues/Services/
// Customers/Subscriptions/Payments/SMS/Notifications/Devices/Security & Audit)
// with 'overview' rendering the ORIGINAL dashboard one-to-one below it (its
// header, scope tabs, agency search, period select and RefreshObserver-protected
// charts are untouched) and every other section rendering a shared toolbar
// (period selector incl. custom range + refresh) above its own body.
//
// Original overview layout: header (title + period + refresh) → scope tabs
// (Global | Average per agency) + agency search → platform stats row → KPI
// cards → CHANNEL panel → trend + status donut → hourly traffic + no-show →
// heatmap → services (+ branches/counters / top agencies) → ratings.
//
// Agency panel components are REUSED as-is (pure presentational). States:
// loading skeletons · 404 → "update required" · error + retry · empty.
// Palette: emerald/teal/cyan primary, amber warning, rose negative — no
// indigo/blue. RTL-aware with LTR-wrapped numeric/chart zones.

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertTriangle, BarChart3, Building2, Globe, Inbox, MapPin, RefreshCw, ServerCrash, Sigma, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { translateCategory } from '@/lib/enum-i18n';
import { ak } from './i18n-keys';
import { useAdminAnalyticsData } from './use-admin-analytics-data';
import { ADMIN_SECTION_PERIODS, type AdminSectionId, type AdminSectionPeriod } from './section-types';
import {
  ADMIN_SECTION_COMPONENTS,
  ADMIN_SECTION_NAV,
  ADMIN_SECTION_TITLE_KEYS,
} from './section-registry';
import {
  isAgencyScopedPayload,
  type AdminAgencyInfo,
  type AdminAnalyticsPayload,
  type AdminAnalyticsScope,
  type AdminSelectedAgency,
} from './types';
import type { AnalyticsPeriod } from '@/components/agency/analytics/types';
import { ANALYTICS_PERIODS } from '@/components/agency/analytics/types';
import { KpiCards } from '@/components/agency/analytics/kpi-cards';
import { ReservationsTrendChart } from '@/components/agency/analytics/reservations-trend-chart';
import { StatusDistributionChart } from '@/components/agency/analytics/status-distribution-chart';
import { HourlyTrafficChart } from '@/components/agency/analytics/hourly-traffic-chart';
import { HeatmapPanel } from '@/components/agency/analytics/heatmap-panel';
import { ServiceBreakdown } from '@/components/agency/analytics/service-breakdown';
import { BranchesCountersPanel } from '@/components/agency/analytics/branches-counters-panel';
import { RatingsPanel } from '@/components/agency/analytics/ratings-panel';
import { NoShowPanel } from '@/components/agency/analytics/no-show-panel';
import { ChannelPanel } from './channel-panel';
import { PlatformStatsRow } from './platform-stats-row';
import { AgencySearch } from './agency-search';
import { TopAgenciesPanel } from './top-agencies-panel';

// ─── Task 54-b: sub-navigation period labels ────────────────────────────────
function sectionPeriodLabelKey(period: AdminSectionPeriod): string {
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

// ─── Task 54-b: sub-navigation strip ─────────────────────────────────────────
// Horizontal scrollable strip on mobile (with the app's custom scrollbar),
// fully wrapped layout on desktop. role=tablist/tab with aria-selected.

function periodLabelKey(period: AnalyticsPeriod): string {
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
function AdminAnalyticsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-2xl" />
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

// ─── Per-agency context strip (per-agency mode) ─────────────────────────────
function AgencyInfoStrip({
  info,
  fallback,
}: {
  info: AdminAgencyInfo | null;
  fallback: AdminSelectedAgency | null;
}) {
  const { t } = useLanguage();
  const name = info?.name ?? fallback?.name ?? '—';
  const code = info?.customCode ?? fallback?.customCode ?? '';
  const category = info?.category ?? fallback?.category ?? '';
  const city = info?.city ?? fallback?.city ?? null;
  const wilaya = info?.wilaya ?? null;
  const isActive = info ? info.isActive : (fallback?.isActive ?? true);
  const tier = info?.subscriptionTier ?? null;
  const location = [city, wilaya].filter((v) => v && String(v).trim().length > 0).join(' · ');

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
            <Building2 className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-black text-foreground truncate">{name}</p>
              {code && (
                <Badge variant="secondary" className="text-[10px] font-mono h-5 shrink-0" dir="ltr">
                  {code}
                </Badge>
              )}
              {category && (
                <Badge variant="secondary" className="text-[10px] h-5 max-w-40 shrink-0">
                  <span className="truncate">{translateCategory(category, t)}</span>
                </Badge>
              )}
              {tier && (
                <Badge className="text-[10px] h-5 bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300 shrink-0">
                  <span className="truncate">{tier}</span>
                </Badge>
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
              {location && (
                <span className="inline-flex items-center gap-0.5">
                  <MapPin className="h-3 w-3" />
                  {location}
                </span>
              )}
              <span
                className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold ${
                  isActive
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                {isActive ? t(ak('adminAnalytics.agencyInfo.active')) : t(ak('adminAnalytics.agencyInfo.inactive'))}
              </span>
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Task 54-b: sub-navigation strip — horizontal scroll on mobile, wrap on lg. */
function SectionNav({
  active,
  onChange,
}: {
  active: AdminSectionId;
  onChange: (id: AdminSectionId) => void;
}) {
  const { t } = useLanguage();
  return (
    <nav
      className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-1 px-1 lg:flex-wrap lg:overflow-x-visible lg:mx-0 lg:px-0 custom-scrollbar"
      role="tablist"
      aria-label={t('analyticsSection.title')}
    >
      {ADMIN_SECTION_NAV.map((item) => {
        const Icon = item.icon;
        const selected = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`admin-analytics-tab-${item.id}`}
            aria-selected={selected}
            aria-controls="admin-analytics-section-panel"
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

// ─── Task 54-b: shell — sub-nav + (overview dashboard | section page) ────────
export function AdminAnalytics() {
  const { t } = useLanguage();
  const [activeSection, setActiveSection] = useState<AdminSectionId>('overview');
  const [period, setPeriod] = useState<AdminSectionPeriod>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const isCustom = period === 'custom';
  const customReady = Boolean(customFrom) && Boolean(customTo);

  const handlePeriodChange = (p: AdminSectionPeriod) => {
    setPeriod(p);
    // Pre-fill the custom range (last 30 days incl. today) so the first
    // selection is immediately valid — the backend 400s on missing dates.
    if (p === 'custom') {
      setCustomFrom((prev) => prev || isoDaysAgo(29));
      setCustomTo((prev) => prev || isoDaysAgo(0));
    }
  };

  const query = { period, from: customFrom || undefined, to: customTo || undefined, reloadToken };

  // Overview: the pre-existing dashboard, rendering exactly as before —
  // only re-homed under the sub-navigation strip.
  if (activeSection === 'overview') {
    return (
      <>
        <div className="p-4 sm:p-6 pb-0 sm:pb-0 max-w-6xl mx-auto">
          <SectionNav active={activeSection} onChange={setActiveSection} />
        </div>
        <OverviewDashboard />
      </>
    );
  }

  const SectionBody = ADMIN_SECTION_COMPONENTS[activeSection];
  const customHint = t(ak('adminAnalytics.period.customHint'));

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <SectionNav active={activeSection} onChange={setActiveSection} />

      {/* ── Section toolbar: title + period selector + refresh ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-lg font-black text-foreground leading-tight truncate">
            {t(ak(ADMIN_SECTION_TITLE_KEYS[activeSection]))}
          </h1>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={period} onValueChange={(v) => handlePeriodChange(v as AdminSectionPeriod)}>
            <SelectTrigger className="h-9 w-[150px] text-xs" aria-label={t('analyticsSection.title')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADMIN_SECTION_PERIODS.map((p) => (
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
      <div id="admin-analytics-section-panel" role="tabpanel" aria-labelledby={`admin-analytics-tab-${activeSection}`}>
        <SectionBody query={query} customHint={customHint} />
      </div>
    </div>
  );
}

// ─── Original overview dashboard (Task 4) — behavior unchanged ───────────────
function OverviewDashboard() {
  const { t, lang } = useLanguage();
  const {
    period,
    setPeriod,
    scope,
    setScope,
    selectedAgency,
    selectAgency,
    clearAgency,
    data,
    state,
    lastUpdatedAt,
    refresh,
  } = useAdminAnalyticsData();

  const agencyMode = selectedAgency !== null;
  const agencyData = data && isAgencyScopedPayload(data) ? data : null;
  const dashData = data && !isAgencyScopedPayload(data) ? data : null;
  const activeData: AdminAnalyticsPayload | null = agencyMode ? agencyData : dashData;

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
            <p className="text-xs text-muted-foreground">{t(ak('adminAnalytics.subtitle'))}</p>
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
                  {t(ak(periodLabelKey(p)))}
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

      {/* ── Scope tabs + agency search ──
          A selected agency OVERRIDES the scope tabs: the chip shows the
          current agency and ✕ returns to the global/average view while the
          search stays available to switch agencies directly. */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        {agencyMode ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50 dark:bg-emerald-900/20 ps-3 pe-1.5 py-1.5 max-w-full self-start">
            <Building2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300 truncate max-w-48 sm:max-w-64">
              {t(ak('adminAnalytics.selectedAgency'))}: {selectedAgency.name}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-full shrink-0 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
              onClick={clearAgency}
              aria-label={t(ak('adminAnalytics.clearAgencyFilter'))}
              title={t(ak('adminAnalytics.clearAgencyFilter'))}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Tabs value={scope} onValueChange={(v) => setScope(v as AdminAnalyticsScope)} className="self-start">
            <TabsList className="h-10 p-1 rounded-xl">
              <TabsTrigger value="global" className="text-xs px-3 h-8 rounded-lg gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                {t(ak('adminAnalytics.scopeGlobal'))}
              </TabsTrigger>
              <TabsTrigger value="average" className="text-xs px-3 h-8 rounded-lg gap-1.5">
                <Sigma className="h-3.5 w-3.5" />
                {t(ak('adminAnalytics.scopeAverage'))}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        <AgencySearch selected={selectedAgency} onSelect={selectAgency} onClear={clearAgency} />
      </div>

      {refreshedAtCaption && state !== 'loading' && (
        <p className="text-[10px] text-muted-foreground -mt-2">{refreshedAtCaption}</p>
      )}

      {/* ── States ── */}
      {state === 'loading' && <AdminAnalyticsSkeleton />}

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
          title={
            agencyMode
              ? `${selectedAgency.name} — ${t(ak('analyticsSection.noData'))}`
              : t(ak('analyticsSection.noData'))
          }
          body={t('noDataYet')}
        />
      )}

      {/* ── Ready ── */}
      {state === 'ready' && activeData && (
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="space-y-4"
        >
          {/* Platform stats (global + average scope) OR agency context strip */}
          {!agencyMode && dashData && (
            <PlatformStatsRow platform={dashData.platform} period={period} />
          )}
          {agencyMode && (
            <AgencyInfoStrip
              info={agencyData?.agency ?? null}
              fallback={selectedAgency}
            />
          )}

          {/* KPI cards (+ caption in average scope) */}
          <div>
            <KpiCards kpis={activeData.kpis} />
            {!agencyMode && scope === 'average' && (
              <p className="mt-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
                <Sigma className="h-3 w-3 shrink-0" />
                {t(ak('adminAnalytics.scopeAverageCaption'))}
              </p>
            )}
          </div>

          {/* Channel panel — online vs walk-in (prominent, right under KPIs) */}
          {activeData.channel && <ChannelPanel channel={activeData.channel} kpis={activeData.kpis} />}

          {/* Trend + status donut */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 min-w-0">
              <ReservationsTrendChart timeseries={activeData.timeseries} />
            </div>
            <div className="min-w-0">
              <StatusDistributionChart statusDistribution={activeData.statusDistribution} />
            </div>
          </div>

          {/* Hourly traffic + no-show */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="min-w-0">
              <HourlyTrafficChart hourlyTraffic={activeData.hourlyTraffic} peak={activeData.peak ?? null} />
            </div>
            <div className="min-w-0">
              <NoShowPanel kpis={activeData.kpis} timeseries={activeData.timeseries} />
            </div>
          </div>

          {/* Weekday × hour heatmap */}
          <HeatmapPanel weekdayHourMatrix={activeData.weekdayHourMatrix} />

          {/* Services + (branches/counters | top agencies) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="min-w-0">
              <ServiceBreakdown services={activeData.services} />
            </div>
            <div className="min-w-0">
              {agencyMode ? (
                <BranchesCountersPanel branches={activeData.branches} counters={activeData.counters} />
              ) : (
                dashData && (
                  <TopAgenciesPanel rows={dashData.topAgencies} scope={scope} />
                )
              )}
            </div>
          </div>

          {/* Ratings */}
          <RatingsPanel ratings={activeData.ratings} />
        </motion.div>
      )}
    </div>
  );
}
