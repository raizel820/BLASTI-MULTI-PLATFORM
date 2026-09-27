'use client';

// ─── Task 54-d: CUSTOMER "My Analytics" module (doc-2 §38-44) ────────────────
//
// Personal-scope analytics for CUSTOMER sessions, backed by
// GET /api/customer/analytics/<section> (frozen 54-a contract, §4). Five tabs
// (§39): My Overview (default) / My Reservations / My Queue History /
// My Activity / My Ratings.
//
// Periods: every section accepts the §3.1 period system. Switching sections
// resets the selector to that section's backend default (my-overview +
// my-activity 30d, my-reservations / my-queue-history / my-ratings 12m) —
// mirroring what the server would do without an explicit period. `custom`
// requires from+to (ISO dates) — the hook idles until both are set.
//
// §38 SCOPE: everything is personal (userId filtered SERVER-SIDE); the module
// renders a friendly panel if the server ever answers 403.
//
// States per section: loading skeletons · 404 → "update required" · 403 →
// no-permission panel · error + retry · empty. Palette: emerald/teal/cyan
// primary, amber warning, rose negative — no indigo/blue. RTL-aware with
// LTR-wrapped numeric/chart zones. Mobile-first: the tab strip scrolls
// horizontally at 375px.

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  CUSTOMER_SECTION_DEFAULT_PERIOD,
  type CustomerSectionId,
  type CustomerSectionPeriod,
  CUSTOMER_SECTION_PERIODS,
} from './customer-analytics-types';
import type { CustomerSectionQuery } from './use-customer-section-data';
import {
  CustomerMyActivitySection,
  CustomerMyOverviewSection,
  CustomerMyQueueHistorySection,
  CustomerMyRatingsSection,
  CustomerMyReservationsSection,
} from './customer-analytics-sections';
import { ak } from '@/components/agency/analytics/i18n-keys';

const CUSTOMER_SECTION_COMPONENTS: Record<
  CustomerSectionId,
  React.ComponentType<{ query: CustomerSectionQuery }>
> = {
  'my-overview': CustomerMyOverviewSection,
  'my-reservations': CustomerMyReservationsSection,
  'my-queue-history': CustomerMyQueueHistorySection,
  'my-activity': CustomerMyActivitySection,
  'my-ratings': CustomerMyRatingsSection,
};

const CUSTOMER_SECTION_TITLE_KEYS: Record<CustomerSectionId, string> = {
  'my-overview': 'myAnalytics.overview.title',
  'my-reservations': 'myAnalytics.res.title',
  'my-queue-history': 'myAnalytics.queue.title',
  'my-activity': 'myAnalytics.activity.title',
  'my-ratings': 'myAnalytics.ratings.title',
};

const CUSTOMER_SECTION_NAV: Array<{ id: CustomerSectionId; labelKey: string }> = [
  { id: 'my-overview', labelKey: 'myAnalytics.nav.overview' },
  { id: 'my-reservations', labelKey: 'myAnalytics.nav.reservations' },
  { id: 'my-queue-history', labelKey: 'myAnalytics.nav.queueHistory' },
  { id: 'my-activity', labelKey: 'myAnalytics.nav.activity' },
  { id: 'my-ratings', labelKey: 'myAnalytics.nav.ratings' },
];

function sectionPeriodLabelKey(period: CustomerSectionPeriod): string {
  switch (period) {
    case '7d':
      return 'analyticsSection.period7d';
    case '30d':
      return 'analyticsSection.period30d';
    case '12m':
      return 'analyticsSection.period12m';
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

export function CustomerAnalytics() {
  const { t } = useLanguage();
  const [activeSection, setActiveSection] = useState<CustomerSectionId>('my-overview');
  // Period follows the active section's backend default (reset on switch).
  const [period, setPeriod] = useState<CustomerSectionPeriod>(
    CUSTOMER_SECTION_DEFAULT_PERIOD['my-overview'],
  );
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const isCustom = period === 'custom';
  const customReady = Boolean(customFrom) && Boolean(customTo);

  const handleSectionChange = (id: CustomerSectionId) => {
    setActiveSection(id);
    // Each section carries its backend default period (contract §4) — reset
    // the selector so the first view of a section matches the server default.
    setPeriod(CUSTOMER_SECTION_DEFAULT_PERIOD[id]);
  };

  const handlePeriodChange = (p: CustomerSectionPeriod) => {
    setPeriod(p);
    // Pre-fill the custom range (last 30 days incl. today) so the first
    // selection is immediately valid — the backend 400s on missing dates.
    if (p === 'custom') {
      setCustomFrom((prev) => prev || isoDaysAgo(29));
      setCustomTo((prev) => prev || isoDaysAgo(0));
    }
  };

  const SectionBody = CUSTOMER_SECTION_COMPONENTS[activeSection];
  const query: CustomerSectionQuery = {
    period,
    from: customFrom || undefined,
    to: customTo || undefined,
    reloadToken,
  };

  return (
    <div className="p-4 sm:p-6 pb-24 max-w-6xl mx-auto space-y-4">
      {/* ── Sub-navigation strip: horizontal scroll on mobile, wrap on lg ── */}
      <nav
        className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-1 px-1 lg:flex-wrap lg:overflow-x-visible lg:mx-0 lg:px-0 custom-scrollbar"
        role="tablist"
        aria-label={t(ak('myAnalytics.navAria'))}
      >
        {CUSTOMER_SECTION_NAV.map((item) => {
          const selected = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`customer-analytics-tab-${item.id}`}
              aria-selected={selected}
              aria-controls="customer-analytics-section-panel"
              onClick={() => handleSectionChange(item.id)}
              className={`shrink-0 lg:shrink inline-flex items-center gap-1.5 h-9 px-3 rounded-xl text-xs font-bold transition-colors border ${
                selected
                  ? 'bg-emerald-600 text-white border-transparent shadow-sm shadow-emerald-600/30'
                  : 'bg-white dark:bg-gray-900/80 text-muted-foreground hover:text-emerald-700 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border-border'
              }`}
            >
              {t(ak(item.labelKey))}
            </button>
          );
        })}
      </nav>

      {/* ── Section toolbar: title + period selector + refresh ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <h1 className="text-lg font-black text-foreground leading-tight truncate">
            {t(ak(CUSTOMER_SECTION_TITLE_KEYS[activeSection]))}
          </h1>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Select value={period} onValueChange={(v) => handlePeriodChange(v as CustomerSectionPeriod)}>
            <SelectTrigger className="h-9 w-[150px] text-xs" aria-label={t(ak('myAnalytics.navAria'))}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOMER_SECTION_PERIODS.map((p) => (
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
      <div id="customer-analytics-section-panel" role="tabpanel" aria-labelledby={`customer-analytics-tab-${activeSection}`}>
        <SectionBody query={query} />
      </div>
    </div>
  );
}
