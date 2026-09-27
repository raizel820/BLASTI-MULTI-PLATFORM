'use client';

// ─── Task 54-d: STAFF analytics view (doc-2 §29-37) ──────────────────────────
//
// Rendered by the agency analytics shell (analytics-dashboard.tsx) whenever
// the viewer's session role is AGENCY_STAFF — the staff member does NOT
// automatically receive the owner analytics (§29); they get their own scoped
// module backed by GET /api/staff/analytics/<section> (frozen 54-a contract,
// agent-ctx/54-a-analytics-contract.md §3).
//
// Layout mirrors the owner section shell: a horizontal sub-nav strip
// (My Overview / Today's Queue / My Performance / My Services) above a shared
// toolbar. my-overview + today-queue are fixed-TODAY views — no period
// selector. my-performance + my-services accept the §3.1 period selector
// (incl. custom range; default 30d).
//
// §29/§37 permission model: the backend live-checks canViewAnalytics on every
// request (403 PERMISSION_DENIED:canViewAnalytics) — each section renders a
// friendly "no permission" panel via StaffForbiddenPanel when that happens.
//
// States per section: loading skeletons · 404 → "update required" · 403 →
// no-permission panel · error + retry · empty. Palette: emerald/teal/cyan
// primary, amber warning, rose negative — no indigo/blue. RTL-aware with
// LTR-wrapped numeric/chart zones.

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BarChart3, RefreshCw } from 'lucide-react';
import {
  STAFF_SECTION_COMPONENTS,
  STAFF_SECTION_NAV,
  STAFF_SECTION_TITLE_KEYS,
  STAFF_FIXED_TODAY_SECTIONS,
} from './staff-registry';
import { STAFF_SECTION_PERIODS, type StaffSectionId, type StaffSectionPeriod } from './staff-types';
import type { StaffSectionQuery } from './use-staff-section-data';
import { ak } from './i18n-keys';

function sectionPeriodLabelKey(period: StaffSectionPeriod): string {
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

// ─── Sub-navigation strip — horizontal scroll on mobile, wrap on lg ──────────
function StaffSectionNav({
  active,
  onChange,
}: {
  active: StaffSectionId;
  onChange: (id: StaffSectionId) => void;
}) {
  const { t } = useLanguage();
  return (
    <nav
      className="flex gap-1.5 overflow-x-auto pb-1.5 -mx-1 px-1 lg:flex-wrap lg:overflow-x-visible lg:mx-0 lg:px-0 custom-scrollbar"
      role="tablist"
      aria-label={t(ak('staffAnalytics.navAria'))}
    >
      {STAFF_SECTION_NAV.map((item) => {
        const Icon = item.icon;
        const selected = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`staff-analytics-tab-${item.id}`}
            aria-selected={selected}
            aria-controls="staff-analytics-section-panel"
            onClick={() => onChange(item.id)}
            className={`shrink-0 lg:shrink inline-flex items-center gap-1.5 h-9 px-3 rounded-xl text-xs font-bold transition-colors border ${
              selected
                ? 'bg-teal-600 text-white border-transparent shadow-sm shadow-teal-600/30'
                : 'bg-white dark:bg-gray-900/80 text-muted-foreground hover:text-teal-700 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 border-border'
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

// ─── STAFF section shell ─────────────────────────────────────────────────────
export function StaffAnalyticsView() {
  const { t } = useLanguage();
  const [activeSection, setActiveSection] = useState<StaffSectionId>('my-overview');
  const [period, setPeriod] = useState<StaffSectionPeriod>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const isFixedToday = STAFF_FIXED_TODAY_SECTIONS.has(activeSection);
  const isCustom = period === 'custom';
  const customReady = Boolean(customFrom) && Boolean(customTo);

  const handlePeriodChange = (p: StaffSectionPeriod) => {
    setPeriod(p);
    // Pre-fill the custom range (last 30 days incl. today) so the first
    // selection is immediately valid — the backend 400s on missing dates.
    if (p === 'custom') {
      setCustomFrom((prev) => prev || isoDaysAgo(29));
      setCustomTo((prev) => prev || isoDaysAgo(0));
    }
  };

  const SectionBody = STAFF_SECTION_COMPONENTS[activeSection];
  // Fixed-TODAY sections always query period=today (the backend ignores the
  // param for them — sending it keeps the request unambiguous).
  const query: StaffSectionQuery = isFixedToday
    ? { period: 'today', reloadToken }
    : { period, from: customFrom || undefined, to: customTo || undefined, reloadToken };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <StaffSectionNav active={activeSection} onChange={setActiveSection} />

      {/* ── Section toolbar: title + (period selector) + refresh ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-black text-foreground leading-tight truncate">
              {t(ak(STAFF_SECTION_TITLE_KEYS[activeSection]))}
            </h1>
            {isFixedToday && (
              <p className="text-xs text-muted-foreground">{t(ak('staffAnalytics.todayCaption'))}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {!isFixedToday && (
            <Select value={period} onValueChange={(v) => handlePeriodChange(v as StaffSectionPeriod)}>
              <SelectTrigger className="h-9 w-[150px] text-xs" aria-label={t(ak('staffAnalytics.navAria'))}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAFF_SECTION_PERIODS.map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {t(ak(sectionPeriodLabelKey(p)))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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

      {/* ── Custom range row (period === custom, period sections only) ── */}
      {!isFixedToday && isCustom && (
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
      <div id="staff-analytics-section-panel" role="tabpanel" aria-labelledby={`staff-analytics-tab-${activeSection}`}>
        <SectionBody query={query} />
      </div>
    </div>
  );
}
