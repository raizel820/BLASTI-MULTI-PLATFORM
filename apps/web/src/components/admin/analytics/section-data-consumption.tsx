'use client';

// ─── Task 55-c: Data Consumption section (doc-2 §14 + 55 contract §3.2) ─────
// GET /api/admin/analytics/data-consumption (super-admin only) — the byte
// ledger for the future sponsored-data contract. Backend contract:
// agent-ctx/55-data-consumption-contract.md §2.4 (built in parallel by 55-b;
// until it lands the shared hook renders its 'unavailable' state on 404).
//
// Body, in contract order:
//   1. COST ESTIMATOR card (headline) — unit selector B|KB|MB|GB|TB (binary
//      1024, display-only; the API always speaks raw bytes) + price-per-GB
//      input (DZD, ≥ 0, empty → instructional hint) + computed cost reading
//      the FILTERED totals (filters automatically affect the estimate);
//      "(≈ / month)" hint on month-ish periods, else the resolved window.
//   2. KPI row — total/upload/download/events + avg per agency/branch/
//      customer, all in the selected unit (raw bytes kept in the label
//      tooltip that StatTile provides via title).
//   3. Filters — category select (values from loaded byAgency rows), wilaya
//      text input, agency select (from byAgency rows), network segmented
//      ALL/WIFI/MOBILE, trafficType select. Active-count badge + clear-all
//      (same pattern as section-reservations). Period stays in the toolbar.
//   4. Network split + traffic-type split (unit-aware progress bars).
//   5. Per-agency table (9 columns → real <table> in overflow-x-auto,
//      max-h-96 overflow-y-auto custom-scrollbar, sticky header).
//   6. Top-customers table.
//   7. Consumption timeseries (same ChartCard/recharts pattern as payments).
//   8. Peaks card + "Recording since …" meta line.
//
// No isEmpty predicate: a zeroed window still renders (0 GB + estimator +
// empty states) — the estimator must stay usable before traffic accrues.

import { useCallback, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import {
  Activity,
  Building2,
  Calculator,
  Database,
  Download,
  Filter,
  Flame,
  Layers,
  Store,
  TrendingUp,
  Upload,
  UsersRound,
  Wifi,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { humanizeEnum, translateCategory } from '@/lib/enum-i18n';
import {
  ChartCard,
  ChartTooltipBox,
  SectionStatePanels,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import {
  EMPTY_DATA_CONSUMPTION_FILTERS,
  type AdminDataConsumptionData,
  type AdminDataConsumptionFilters,
  type AdminDataUsageAgencyRow,
  type AdminDataUsageCustomerRow,
} from './section-types';

// ─── Unit system (binary 1024 — display-only, API speaks bytes) ─────────────

type DataUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB';

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const TIB = 1024 * 1024 * 1024 * 1024;

const DATA_UNITS: Array<{ id: DataUnit; factor: number; decimals: number }> = [
  { id: 'B', factor: 1, decimals: 0 },
  { id: 'KB', factor: KIB, decimals: 1 },
  { id: 'MB', factor: MIB, decimals: 2 },
  { id: 'GB', factor: GIB, decimals: 2 },
  { id: 'TB', factor: TIB, decimals: 3 },
];

function unitDef(unit: DataUnit): { id: DataUnit; factor: number; decimals: number } {
  return DATA_UNITS.find((u) => u.id === unit) ?? DATA_UNITS[3]; // default GB
}

/** Bytes → selected unit, sensible decimals (sub-1 values get one extra). */
function formatBytes(bytes: number, unit: DataUnit): string {
  const u = unitDef(unit);
  const v = (Number.isFinite(bytes) ? bytes : 0) / u.factor;
  const decimals = v !== 0 && Math.abs(v) < 1 ? Math.min(u.decimals + 1, 4) : u.decimals;
  return v.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

/** Compact Y-axis ticks for unit-converted values (k/M — never 'B', which
 *  collides with the bytes unit letter). */
function compactAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return abs >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2);
}

const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);

const pad2 = (n: number): string => String(n % 24).padStart(2, '0');

/** Calendar-month-ish periods get the "(≈ / month)" cost hint (§3.2.1). */
const MONTH_LIKE_PERIODS = new Set(['this-month', 'last-month', '30d']);

const NETWORK_SEGMENTS: Array<{ value: string; key: 'f.allNetworks' | 'net.wifi' | 'net.mobile' }> = [
  { value: '', key: 'f.allNetworks' },
  { value: 'WIFI', key: 'net.wifi' },
  { value: 'MOBILE', key: 'net.mobile' },
];

const TRAFFIC_TYPES = ['API', 'SYNC', 'REALTIME', 'NOTIFICATIONS', 'FILES', 'UPDATES'] as const;

const DC = 'adminAnalytics.dataConsumption';

// ─── Unit-aware split bars (network / traffic-type cards) ───────────────────

function UnitSplitBars({
  rows,
  unit,
  unitLabel,
}: {
  rows: Array<{ label: string; bytes: number; barClass: string }>;
  unit: DataUnit;
  unitLabel: string;
}) {
  const total = rows.reduce((sum, r) => sum + Math.max(0, safe(r.bytes)), 0);
  return (
    <div className="space-y-2.5">
      {rows.map((row) => {
        const bytes = Math.max(0, safe(row.bytes));
        const share = total > 0 ? Math.min(100, (bytes / total) * 100) : 0;
        return (
          <div key={row.label}>
            <div className="flex items-center justify-between gap-2 text-[11px] font-semibold mb-1">
              <span className="text-foreground truncate min-w-0" title={row.label}>
                {row.label}
              </span>
              <span
                className="text-muted-foreground shrink-0"
                dir="ltr"
                title={`${bytes.toLocaleString()} B`}
              >
                {formatBytes(bytes, unit)} {unitLabel} · {share.toFixed(0)}%
              </span>
            </div>
            <Progress
              value={share}
              className={`h-1.5 bg-emerald-100 dark:bg-emerald-900/30 ${row.barClass}`}
              aria-label={`${row.label}: ${formatBytes(bytes, unit)} ${unitLabel}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Generic scrollable table (9-column per-agency + top-customers) ─────────

interface WideTableColumn<T> {
  header: string;
  cell: (row: T) => React.ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
}

function WideTable<T>({
  rows,
  columns,
  getKey,
  minWidthClass,
  emptyText,
}: {
  rows: T[];
  columns: Array<WideTableColumn<T>>;
  getKey: (row: T, index: number) => string;
  minWidthClass: string;
  emptyText: string;
}) {
  const alignClass = (a?: 'start' | 'center' | 'end') =>
    a === 'center' ? 'text-center' : a === 'end' ? 'text-end' : 'text-start';

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
        <Database className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
        <p className="text-sm">{emptyText}</p>
      </div>
    );
  }

  return (
    <div className="max-h-96 overflow-y-auto overflow-x-auto custom-scrollbar">
      <table className={`w-full ${minWidthClass} text-xs border-separate border-spacing-0`}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                scope="col"
                className={`${col.className ?? ''} ${alignClass(col.align)} sticky top-0 z-10 bg-white dark:bg-gray-900 border-b border-border/60 px-2 py-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={getKey(row, index)} className="border-b border-border/40 last:border-b-0">
              {columns.map((col, i) => (
                <td
                  key={i}
                  className={`${col.className ?? ''} ${alignClass(col.align)} px-2 py-2.5 text-foreground align-middle`}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main section ────────────────────────────────────────────────────────────

export function DataConsumptionSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const [filters, setFilters] = useState<AdminDataConsumptionFilters>(EMPTY_DATA_CONSUMPTION_FILTERS);
  const [unit, setUnit] = useState<DataUnit>('GB');
  const [priceRaw, setPriceRaw] = useState('');

  const activeFilters = (Object.entries(filters) as Array<[string, string]>).filter(([, v]) => v);
  const sectionQuery: AdminSectionQuery = {
    ...query,
    filters: Object.fromEntries(activeFilters),
  };

  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminDataConsumptionData>(
    'data-consumption',
    sectionQuery,
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  const setFilter = useCallback((key: keyof AdminDataConsumptionFilters, value: string) => {
    setFilters((prev) => {
      // Wilaya is free text: strip '&'/'=' — the shared hook serializes
      // filters as k=v pairs and would split on them (documented quirk).
      const clean = key === 'wilaya' ? value.replace(/[&=]/g, '').trim() : value;
      return { ...prev, [key]: clean };
    });
  }, []);

  const clearFilters = useCallback(() => setFilters(EMPTY_DATA_CONSUMPTION_FILTERS), []);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const u = unitDef(unit);
  const unitLabel = u.id;

  const totals = data.totals;
  const totalBytes = safe(totals.totalBytes);
  const averages = data.averages;
  const meta = data.meta;

  // ── Cost estimator math (reads the FILTERED totals) ──
  const priceTrim = priceRaw.trim();
  const parsedPrice = priceTrim === '' ? NaN : Number(priceTrim);
  const priceInvalid = priceTrim !== '' && (!Number.isFinite(parsedPrice) || parsedPrice < 0);
  const pricePerGB: number | null =
    priceTrim === '' || priceInvalid || !Number.isFinite(parsedPrice) ? null : parsedPrice;
  const estimatedCost = pricePerGB !== null ? (totalBytes / GIB) * pricePerGB : null;
  const isMonthPeriod = MONTH_LIKE_PERIODS.has(query.period);

  // DZD formatting — the same helper pattern the payments sections use.
  const fmtMoney = (v: number): string => {
    try {
      return new Intl.NumberFormat(getLocale(lang), { style: 'currency', currency: 'DZD', maximumFractionDigits: 2 }).format(v);
    } catch {
      return `${v.toLocaleString()} DZD`;
    }
  };

  const fmtDateTime = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(getLocale(lang), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  // ── Filter option lists (from loaded byAgency rows) ──
  const agencyRows = data.byAgency ?? [];
  const categoryOptions = Array.from(new Set(agencyRows.map((r) => r.category).filter(Boolean)));
  const trafficLabel = (key: string): string => t(ak(`${DC}.traffic.${key.toLowerCase()}`));

  // ── Chart data (converted to the selected unit for display) ──
  const trendData = (data.timeseries ?? []).map((p) => ({
    bucket: p.date,
    download: Number((safe(p.downloadBytes) / u.factor).toFixed(3)),
    upload: Number((safe(p.uploadBytes) / u.factor).toFixed(3)),
  }));
  const hasTrend = (data.timeseries ?? []).some((p) => safe(p.totalBytes) > 0);

  const networkRows = [
    { label: t(ak(`${DC}.net.wifi`)), bytes: safe(data.byNetwork?.WIFI), barClass: '[&>div]:bg-emerald-500' },
    { label: t(ak(`${DC}.net.mobile`)), bytes: safe(data.byNetwork?.MOBILE), barClass: '[&>div]:bg-amber-500' },
    { label: t(ak(`${DC}.net.unknown`)), bytes: safe(data.byNetwork?.UNKNOWN), barClass: '[&>div]:bg-gray-400 dark:[&>div]:bg-gray-500' },
  ];

  const trafficRows = TRAFFIC_TYPES.map((k, i) => ({
    label: trafficLabel(k),
    bytes: safe((data.byTrafficType as Record<string, number> | undefined)?.[k]),
    barClass: ['[&>div]:bg-emerald-500', '[&>div]:bg-teal-500', '[&>div]:bg-cyan-500', '[&>div]:bg-amber-500', '[&>div]:bg-orange-500', '[&>div]:bg-rose-500'][i],
  }));

  const hasEvents = totalBytes > 0 || safe(totals.events) > 0;
  const peaks = data.peaks;
  const excludedUnknown = safe(meta?.excludedUnknownNetworkBytes);
  const showExcludedNote = filters.network !== '' && excludedUnknown > 0;

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const fmtVal = (v: number | string | undefined) => `${Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unitLabel}`;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-amber-500 inline-block me-1.5" />
          {t(ak(`${DC}.kpi.upload`))}: <span className="font-bold text-foreground" dir="ltr">{fmtVal(props.payload.find((p) => p.dataKey === 'upload')?.value)}</span>
        </p>
        <p className="text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block me-1.5" />
          {t(ak(`${DC}.kpi.download`))}: <span className="font-bold text-foreground" dir="ltr">{fmtVal(props.payload.find((p) => p.dataKey === 'download')?.value)}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const kpiIcon = (Icon: LucideIcon, cls: string) => ({ icon: Icon, iconClass: cls });

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}

      {/* ── 1. Cost estimator (headline) ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden ring-1 ring-emerald-200 dark:ring-emerald-900/60">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
              <Calculator className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.est.title`))}</CardTitle>
              <p className="text-[11px] text-muted-foreground truncate">{t(ak(`${DC}.est.subtitle`))}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Unit selector — binary 1024, display-only */}
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">{t(ak(`${DC}.est.unit`))}</p>
              <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 gap-0.5" role="group" aria-label={t(ak(`${DC}.est.unit`))}>
                {DATA_UNITS.map((u2) => (
                  <button
                    key={u2.id}
                    type="button"
                    onClick={() => setUnit(u2.id)}
                    aria-pressed={unit === u2.id}
                    className={`min-h-[44px] min-w-[46px] px-2.5 text-xs font-bold rounded-md transition-colors ${
                      unit === u2.id
                        ? 'bg-emerald-500 text-white shadow-sm'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`}
                  >
                    {u2.id}
                  </button>
                ))}
              </div>
            </div>
            {/* Price per GB */}
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground mb-1.5">{t(ak(`${DC}.est.priceLabel`))}</p>
              <div className="relative">
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  dir="ltr"
                  value={priceRaw}
                  onChange={(e) => setPriceRaw(e.target.value)}
                  placeholder="0"
                  aria-label={t(ak(`${DC}.est.priceLabel`))}
                  aria-invalid={priceInvalid}
                  className="h-11 pe-24 text-sm font-semibold"
                />
                <span className="absolute end-3 top-1/2 -translate-y-1/2 text-[11px] font-bold text-muted-foreground pointer-events-none" dir="ltr">
                  {t(ak(`${DC}.est.priceSuffix`))}
                </span>
              </div>
            </div>
          </div>

          {/* Computed cost — FILTERED totals × price */}
          <div className="rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 p-4">
            <p className="text-[11px] font-semibold text-muted-foreground">{t(ak(`${DC}.est.cost`))}</p>
            {estimatedCost === null ? (
              <p className="mt-1 text-sm text-muted-foreground">{t(ak(`${DC}.est.costHint`))}</p>
            ) : (
              <>
                <p className="mt-1 text-2xl sm:text-3xl font-black text-emerald-700 dark:text-emerald-400 leading-tight" dir="ltr">
                  {fmtMoney(estimatedCost)}
                  {isMonthPeriod && (
                    <span className="ms-2 text-xs font-bold text-emerald-600/80 dark:text-emerald-400/80">
                      {t(ak(`${DC}.est.approxPerMonth`))}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground" dir="ltr">
                  {t(ak(`${DC}.est.rawBytes`), { bytes: totalBytes.toLocaleString() })}
                  {' · '}
                  {formatBytes(totalBytes, unit)} {unitLabel}
                </p>
              </>
            )}
            {!isMonthPeriod && windowLabel && (
              <p className={estimatedCost === null ? 'mt-1 text-[11px] text-muted-foreground' : 'text-[11px] text-muted-foreground'}>
                {windowLabel}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── 2. KPI row ── */}
      <StatTiles
        items={[
          {
            ...kpiIcon(Database, 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'),
            label: `${t(ak(`${DC}.kpi.total`))} · ${totalBytes.toLocaleString()} B`,
            text: `${formatBytes(totalBytes, unit)} ${unitLabel}`,
          },
          {
            ...kpiIcon(Upload, 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'),
            label: `${t(ak(`${DC}.kpi.upload`))} · ${safe(totals.uploadBytes).toLocaleString()} B`,
            text: `${formatBytes(safe(totals.uploadBytes), unit)} ${unitLabel}`,
          },
          {
            ...kpiIcon(Download, 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'),
            label: `${t(ak(`${DC}.kpi.download`))} · ${safe(totals.downloadBytes).toLocaleString()} B`,
            text: `${formatBytes(safe(totals.downloadBytes), unit)} ${unitLabel}`,
          },
          {
            ...kpiIcon(Activity, 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'),
            label: t(ak(`${DC}.kpi.events`)),
            text: safe(totals.events).toLocaleString(),
          },
          {
            ...kpiIcon(Building2, 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'),
            label: `${t(ak(`${DC}.kpi.avgAgency`))} · ${safe(averages?.perAgency).toLocaleString()} B`,
            text: `${formatBytes(safe(averages?.perAgency), unit)} ${unitLabel}`,
          },
          {
            ...kpiIcon(Store, 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'),
            label: `${t(ak(`${DC}.kpi.avgBranch`))} · ${safe(averages?.perBranch).toLocaleString()} B`,
            text: `${formatBytes(safe(averages?.perBranch), unit)} ${unitLabel}`,
          },
          {
            ...kpiIcon(UsersRound, 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'),
            label: `${t(ak(`${DC}.kpi.avgCustomer`))} · ${safe(averages?.perCustomer).toLocaleString()} B`,
            text: `${formatBytes(safe(averages?.perCustomer), unit)} ${unitLabel}`,
          },
        ]}
      />

      {/* ── 3. Filters (period stays in the shared toolbar) ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
              <Filter className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {t(ak('adminAnalytics.res.filters'))}
              {activeFilters.length > 0 && (
                <Badge className="text-[10px] h-5 px-1.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                  {activeFilters.length}
                </Badge>
              )}
            </p>
            {activeFilters.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11px] text-muted-foreground"
                onClick={clearFilters}
              >
                <X className="h-3 w-3 me-1" />
                {t(ak('adminAnalytics.res.clearFilters'))}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {/* Agency — select from loaded byAgency rows */}
            <div className="col-span-2 sm:col-span-3 lg:col-span-1">
              <FilterSelect
                label={t(ak('adminAnalytics.res.filterAgency'))}
                placeholder={t(ak('adminAnalytics.res.allAgencies'))}
                value={filters.agencyId}
                onChange={(v) => setFilter('agencyId', v)}
                options={agencyRows.map((r) => ({ value: r.agencyId, label: `${r.agencyName} (${r.agencyCode})` }))}
              />
            </div>

            {/* Category — from loaded byAgency rows */}
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterCategory'))}
              placeholder={t(ak('adminAnalytics.res.allCategories'))}
              value={filters.category}
              onChange={(v) => setFilter('category', v)}
              options={categoryOptions.map((c) => ({ value: c, label: translateCategory(c, t) || humanizeEnum(c) }))}
            />

            {/* Wilaya — free text (e.g. 28) */}
            <div className="min-w-0">
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1 truncate" title={t(ak('adminAnalytics.res.filterWilaya'))}>
                {t(ak('adminAnalytics.res.filterWilaya'))}
              </label>
              <Input
                type="text"
                inputMode="numeric"
                value={filters.wilaya}
                onChange={(e) => setFilter('wilaya', e.target.value)}
                placeholder={t(ak(`${DC}.f.wilayaPlaceholder`))}
                aria-label={t(ak('adminAnalytics.res.filterWilaya'))}
                className="h-9 text-xs"
              />
            </div>

            {/* Network — segmented ALL / WIFI / MOBILE ('' = ALL = not sent) */}
            <div className="min-w-0">
              <label className="block text-[10px] font-semibold text-muted-foreground mb-1 truncate" title={t(ak(`${DC}.f.network`))}>
                {t(ak(`${DC}.f.network`))}
              </label>
              <div className="flex rounded-md border border-input overflow-hidden h-9" role="group" aria-label={t(ak(`${DC}.f.network`))}>
                {NETWORK_SEGMENTS.map((seg) => {
                  const active = filters.network === seg.value;
                  return (
                    <button
                      key={seg.value || 'all'}
                      type="button"
                      onClick={() => setFilter('network', seg.value)}
                      aria-pressed={active}
                      className={`flex-1 min-w-[44px] px-1 text-[10px] font-bold transition-colors ${
                        active
                          ? 'bg-emerald-500 text-white'
                          : 'text-muted-foreground hover:bg-muted/60'
                      }`}
                    >
                      {t(ak(`${DC}.${seg.key}`))}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Traffic type */}
            <FilterSelect
              label={t(ak(`${DC}.f.trafficType`))}
              placeholder={t(ak(`${DC}.f.allTraffic`))}
              value={filters.trafficType}
              onChange={(v) => setFilter('trafficType', v)}
              options={TRAFFIC_TYPES.map((k) => ({ value: k, label: trafficLabel(k) }))}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── 4. Network + traffic-type splits ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
                <Wifi className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.networkSplit.title`))}</CardTitle>
                <p className="text-[11px] text-muted-foreground truncate">{t(ak(`${DC}.networkSplit.subtitle`))}</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <UnitSplitBars rows={networkRows} unit={unit} unitLabel={unitLabel} />
            {showExcludedNote && (
              <p className="mt-3 text-[10px] text-amber-600 dark:text-amber-400">
                {t(ak(`${DC}.meta.excludedUnknown`), { bytes: `${formatBytes(excludedUnknown, unit)} ${unitLabel}` })}
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shrink-0">
                <Layers className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.trafficSplit.title`))}</CardTitle>
                <p className="text-[11px] text-muted-foreground truncate">{t(ak(`${DC}.trafficSplit.subtitle`))}</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <UnitSplitBars rows={trafficRows} unit={unit} unitLabel={unitLabel} />
          </CardContent>
        </Card>
      </div>

      {/* ── 5. Per-agency table (sorted desc by the backend) ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
              <Building2 className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.agencyTable.title`))}</CardTitle>
              <p className="text-[11px] text-muted-foreground truncate">{t(ak(`${DC}.agencyTable.subtitle`))}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <WideTable<AdminDataUsageAgencyRow>
            rows={agencyRows}
            getKey={(r) => r.agencyId}
            minWidthClass="min-w-[760px]"
            emptyText={t('noDataYet')}
            columns={[
              {
                header: t(ak(`${DC}.agencyTable.agency`)),
                className: 'min-w-[140px]',
                cell: (r) => (
                  <span className="font-bold truncate block max-w-[220px]" title={r.agencyName}>
                    {r.agencyName}
                  </span>
                ),
              },
              {
                header: t(ak(`${DC}.agencyTable.code`)),
                className: 'w-16',
                cell: (r) => (
                  <span className="text-[10px] font-mono text-muted-foreground" dir="ltr">
                    {r.agencyCode || '—'}
                  </span>
                ),
              },
              {
                header: t(ak(`${DC}.agencyTable.wilaya`)),
                className: 'w-16',
                cell: (r) => <span dir="ltr">{r.wilaya || '—'}</span>,
              },
              {
                header: t(ak(`${DC}.agencyTable.category`)),
                className: 'w-24',
                cell: (r) => (
                  <Badge variant="secondary" className="text-[9px] px-1.5 h-4 font-medium max-w-24">
                    <span className="truncate">{r.category ? translateCategory(r.category, t) || humanizeEnum(r.category) : '—'}</span>
                  </Badge>
                ),
              },
              {
                header: t(ak(`${DC}.agencyTable.upload`)),
                className: 'w-20 text-end',
                align: 'end',
                cell: (r) => (
                  <span dir="ltr" title={`${safe(r.uploadBytes).toLocaleString()} B`}>
                    {formatBytes(safe(r.uploadBytes), unit)}
                  </span>
                ),
              },
              {
                header: t(ak(`${DC}.agencyTable.download`)),
                className: 'w-20 text-end',
                align: 'end',
                cell: (r) => (
                  <span dir="ltr" title={`${safe(r.downloadBytes).toLocaleString()} B`}>
                    {formatBytes(safe(r.downloadBytes), unit)}
                  </span>
                ),
              },
              {
                header: `${t(ak(`${DC}.agencyTable.total`))} (${unitLabel})`,
                className: 'w-24 text-end',
                align: 'end',
                cell: (r) => (
                  <span dir="ltr" className="font-bold" title={`${safe(r.totalBytes).toLocaleString()} B`}>
                    {formatBytes(safe(r.totalBytes), unit)}
                  </span>
                ),
              },
              {
                header: t(ak(`${DC}.agencyTable.share`)),
                className: 'w-16 text-end',
                align: 'end',
                cell: (r) => <span dir="ltr">{safe(r.sharePercent).toFixed(1)}%</span>,
              },
              {
                header: t(ak(`${DC}.agencyTable.estCost`)),
                className: 'w-28 text-end',
                align: 'end',
                cell: (r) =>
                  pricePerGB === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span dir="ltr" className="font-semibold text-emerald-700 dark:text-emerald-400">
                      {fmtMoney((safe(r.totalBytes) / GIB) * pricePerGB)}
                    </span>
                  ),
              },
            ]}
          />
        </CardContent>
      </Card>

      {/* ── 6. Top customers ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-emerald-600 flex items-center justify-center shrink-0">
              <UsersRound className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.customersTable.title`))}</CardTitle>
              <p className="text-[11px] text-muted-foreground truncate">{t(ak(`${DC}.customersTable.subtitle`))}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <WideTable<AdminDataUsageCustomerRow>
            rows={data.topCustomers ?? []}
            getKey={(r) => r.userId}
            minWidthClass="min-w-[520px]"
            emptyText={t('noDataYet')}
            columns={[
              {
                header: t(ak(`${DC}.customersTable.customer`)),
                className: 'min-w-[140px]',
                cell: (r) => (
                  <span className="font-bold truncate block max-w-[220px]" title={r.customerName}>
                    {r.customerName || '—'}
                  </span>
                ),
              },
              {
                header: t(ak(`${DC}.customersTable.username`)),
                className: 'w-32',
                cell: (r) => (
                  <span className="text-[10px] font-mono text-muted-foreground truncate block max-w-[120px]" dir="ltr" title={r.username}>
                    {r.username || '—'}
                  </span>
                ),
              },
              {
                header: `${t(ak(`${DC}.customersTable.total`))} (${unitLabel})`,
                className: 'w-24 text-end',
                align: 'end',
                cell: (r) => (
                  <span dir="ltr" className="font-bold" title={`${safe(r.totalBytes).toLocaleString()} B`}>
                    {formatBytes(safe(r.totalBytes), unit)}
                  </span>
                ),
              },
              {
                header: t(ak(`${DC}.customersTable.events`)),
                className: 'w-16 text-center',
                align: 'center',
                cell: (r) => <span dir="ltr">{safe(r.events).toLocaleString()}</span>,
              },
              {
                header: t(ak(`${DC}.customersTable.lastActivity`)),
                className: 'w-36 text-end',
                align: 'end',
                cell: (r) => <span dir="ltr" className="text-muted-foreground">{r.lastActivityAt ? fmtDateTime(r.lastActivityAt) : '—'}</span>,
              },
            ]}
          />
        </CardContent>
      </Card>

      {/* ── 7. Timeseries + 8. Peaks ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak(`${DC}.trend.title`))}
            subtitle={t(ak(`${DC}.trend.subtitle`))}
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
                  tickFormatter={(v: number) => compactAxis(v)}
                />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
                <Area
                  type="monotone"
                  dataKey="download"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="upload"
                  stroke="#f59e0b"
                  fill="#f59e0b"
                  fillOpacity={0.12}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shrink-0">
                <Flame className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.peaks.title`))}</CardTitle>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.peaks.peakHour`))}</p>
              {hasEvents && peaks ? (
                <>
                  <p className="text-lg font-black text-foreground leading-tight" dir="ltr">
                    {pad2(safe(peaks.hour))}:00–{pad2(safe(peaks.hour) + 1)}:00
                  </p>
                  <p className="text-[11px] text-muted-foreground" dir="ltr">
                    {formatBytes(safe(peaks.hourBytes), unit)} {unitLabel} ({safe(peaks.hourBytes).toLocaleString()} B)
                  </p>
                </>
              ) : (
                <p className="text-lg font-black text-muted-foreground">—</p>
              )}
            </div>
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.peaks.peakDay`))}</p>
              {hasEvents && peaks?.day ? (
                <>
                  <p className="text-lg font-black text-foreground leading-tight">{formatBucket(String(peaks.day), lang)}</p>
                  <p className="text-[11px] text-muted-foreground" dir="ltr">
                    {formatBytes(safe(peaks.dayBytes), unit)} {unitLabel} ({safe(peaks.dayBytes).toLocaleString()} B)
                  </p>
                </>
              ) : (
                <p className="text-lg font-black text-muted-foreground">—</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Meta line ── */}
      {meta?.recordedSince && (
        <p className="text-[10px] text-muted-foreground">
          {t(ak(`${DC}.meta.recordedSince`), { date: fmtDateTime(meta.recordedSince) })}
        </p>
      )}
    </div>
  );
}

// ─── Compact filter select (same pattern as section-reservations) ───────────

function FilterSelect({
  label,
  placeholder,
  value,
  onChange,
  options,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="min-w-0">
      <label className="block text-[10px] font-semibold text-muted-foreground mb-1 truncate" title={label}>
        {label}
      </label>
      <Select
        value={value || undefined}
        onValueChange={(v) => {
          // Radix cannot render an empty SelectItem — the placeholder row is
          // value="__all__" and maps back to ''.
          onChange(v === '__all__' ? '' : v);
        }}
      >
        <SelectTrigger className="h-9 text-xs w-full" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72 custom-scrollbar">
          <SelectItem value="__all__" className="text-xs">
            {placeholder}
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label || humanizeEnum(o.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
