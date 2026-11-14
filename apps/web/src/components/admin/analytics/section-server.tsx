'use client';

// ─── Task 6-b: Server section (VPS resource-usage analyzer) ──────────────────
// GET /api/admin/analytics/server?period=...&component=... (super-admin only).
// Renders the frozen 6-b contract: period averages (day/week/month/90 days),
// per-hour-of-day averages + peaks, per-weekday patterns, weekday×hour heatmap,
// connection-loss (outage) analysis, per-resource bottleneck verdicts and an
// engine/manager filter. Follows section-data-consumption.tsx patterns.
//
// Body, in render order:
//   1. Component filter row — ALL + the 12 engine/manager chips (an emerald
//      dot marks components that recorded activity in the window);
//   2. KPI row — CPU / RAM / disk space / disk I/O / network / availability /
//      system load (composite "avg / peak" texts + p95 · used/total · samples ·
//      link cap · vCPU count);
//   3. Live snapshot strip (relative time, dir="ltr" numerics);
//   4. Resource timeline — metric switch (cpu/ram/diskSpace/read/write/up/
//      down/load) over the ≤120 zero-filled buckets;
//   5. Hour-of-day ComposedChart (avg bar + dashed peak line) + weekday bars,
//      sharing a cpu/ram/net toggle with…
//   6. …the weekday×hour heatmap (pure CSS grid, busiest cell ringed);
//   7. Peak times + connection losses (scrollable outage list, ongoing badge);
//   8. Bottleneck verdicts (ok / watch / critical) per resource;
//   9. Component activity — ALL: share table; selected: KPI tiles + timeseries
//      chart + methodology note.
//
// Palette: emerald/teal/cyan + amber/rose warnings — no indigo/blue. Numeric
// and chart zones stay LTR inside RTL layouts. Loading → SectionSkeleton;
// 404 → the shared 'unavailable' panel; a collector reporting zero samples AND
// no snapshot gets the dedicated "collection started" panel.

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Cpu,
  Download,
  Filter,
  Flame,
  Gauge,
  HardDrive,
  Info,
  Layers,
  LayoutGrid,
  MemoryStick,
  Repeat,
  Server,
  ServerCrash,
  TrendingUp,
  Upload,
  Wifi,
  type LucideIcon,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { getLocale } from '@/components/agency/dashboard/helpers';
import {
  ChartCard,
  ChartTooltipBox,
  SectionMessagePanel,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminServerData } from './section-types';

// ─── Constants ───────────────────────────────────────────────────────────────

const DC = 'adminAnalytics.server';

/** Fixed engine/manager keys — component='' means ALL (filter not sent). */
const SERVER_COMPONENT_KEYS = [
  'sync-engine',
  'storage-manager',
  'logs-manager',
  'public-app-settings',
  'sales-manager',
  'billing-manager',
  'messaging',
  'reservations',
  'agencies',
  'auth',
  'admin-console',
  'other',
] as const;

type TimelineMetric = 'cpu' | 'ram' | 'diskSpace' | 'diskRead' | 'diskWrite' | 'netUp' | 'netDown' | 'load';
type PatternMetric = 'cpu' | 'ram' | 'net';
type BottleneckResource = AdminServerData['bottlenecks'][number]['resource'];
type BottleneckLevel = AdminServerData['bottlenecks'][number]['level'];
type OutageReason = AdminServerData['outages'][number]['reason'];

/** Metric switch for the timeline chart — one color per metric. */
const TIMELINE_METRICS: Array<{ id: TimelineMetric; color: string }> = [
  { id: 'cpu', color: '#10b981' },       // emerald-500
  { id: 'ram', color: '#14b8a6' },       // teal-500
  { id: 'diskSpace', color: '#06b6d4' }, // cyan-500
  { id: 'diskRead', color: '#f59e0b' },  // amber-500
  { id: 'diskWrite', color: '#f43f5e' }, // rose-500
  { id: 'netUp', color: '#34d399' },     // emerald-400
  { id: 'netDown', color: '#2dd4bf' },   // teal-400
  { id: 'load', color: '#64748b' },      // slate-500
];

/** Toggle shared by the hour-of-day chart and the weekday×hour heatmap. */
const PATTERN_METRICS: Array<{ id: PatternMetric; labelKey: string }> = [
  { id: 'cpu', labelKey: `${DC}.metric.cpu` },
  { id: 'ram', labelKey: `${DC}.metric.ram` },
  { id: 'net', labelKey: `${DC}.kpi.network` },
];

const BOTTLENECK_META: Record<BottleneckResource, { icon: LucideIcon; labelKey: string }> = {
  cpu: { icon: Cpu, labelKey: `${DC}.kpi.cpu` },
  ram: { icon: MemoryStick, labelKey: `${DC}.kpi.ram` },
  diskSpace: { icon: HardDrive, labelKey: `${DC}.kpi.diskSpace` },
  diskIo: { icon: Repeat, labelKey: `${DC}.kpi.diskIo` },
  network: { icon: Wifi, labelKey: `${DC}.kpi.network` },
};

const LEVEL_META: Record<BottleneckLevel, { badgeClass: string; labelKey: string }> = {
  ok: {
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    labelKey: `${DC}.bottleneck.ok`,
  },
  watch: {
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    labelKey: `${DC}.bottleneck.watch`,
  },
  critical: {
    badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    labelKey: `${DC}.bottleneck.critical`,
  },
};

const REASON_KEYS: Record<OutageReason, string> = {
  'api-restart': `${DC}.outages.reason.api-restart`,
  unreachable: `${DC}.outages.reason.unreachable`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
const pad2 = (n: number): string => String(n).padStart(2, '0');
const fmtNum = (v: number, maxFrac = 1): string =>
  safe(v).toLocaleString(undefined, { maximumFractionDigits: maxFrac });

/** Unit suffix for a timeline metric ('' for load). */
function metricUnit(m: TimelineMetric): string {
  if (m === 'cpu' || m === 'ram' || m === 'diskSpace') return '%';
  if (m === 'load') return '';
  return 'KB/s';
}

/** Unit suffix for the hourly/heatmap pattern metric. */
function patternUnit(m: PatternMetric): string {
  return m === 'net' ? 'KB/s' : '%';
}

// Binary-1024 byte formatter (B|KB|MB|GB|TB) for component byte counters.
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

function formatBytesLocal(bytes: number): string {
  const b = Math.max(0, safe(bytes));
  if (b >= TIB) return `${fmtNum(b / TIB, 2)} TB`;
  if (b >= GIB) return `${fmtNum(b / GIB, 2)} GB`;
  if (b >= MIB) return `${fmtNum(b / MIB, 1)} MB`;
  if (b >= KIB) return `${fmtNum(b / KIB, 1)} KB`;
  return `${Math.round(b)} B`;
}

/** Compact axis ticks (k/M — keeps KB/s-scale sums readable). */
function compactAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return abs >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(2);
}

/** Seconds → "2h 05m" | "45m" | "30s" (always rendered dir="ltr"). */
function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(safe(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${pad2(m)}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ─── Main section ────────────────────────────────────────────────────────────

export function ServerSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const [component, setComponent] = useState('');
  const [metric, setMetric] = useState<TimelineMetric>('cpu');
  const [patternMetric, setPatternMetric] = useState<PatternMetric>('cpu');

  // Engine/manager filter — '' (ALL) is dropped by the shared hook.
  const sectionQuery: AdminSectionQuery = { ...query, filters: { component } };

  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminServerData>(
    'server',
    sectionQuery,
    { isEmpty: (d) => (d.window?.sampleCount ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  // Locale-aware weekday labels — 2024-01-07 is a Sunday, so
  // Date.UTC(2024, 0, 7 + wd) lands on weekday wd (0 = Sunday). No i18n keys.
  const weekdayShort = (wd: number): string => {
    try {
      return new Intl.DateTimeFormat(getLocale(lang), { weekday: 'short', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + wd)),
      );
    } catch {
      return String(wd);
    }
  };
  const weekdayLong = (wd: number): string => {
    try {
      return new Intl.DateTimeFormat(getLocale(lang), { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + wd)),
      );
    } catch {
      return String(wd);
    }
  };

  // Component label — t() falls back to the raw key for missing entries, so an
  // unexpected backend component id degrades to its own key tail.
  const compLabel = (key: string): string => {
    const k = ak(`${DC}.component.${key}`);
    const v = t(k);
    return v === k ? key : v;
  };

  const fmtDay = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(getLocale(lang), { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(iso),
      );
    } catch {
      return iso;
    }
  };

  const fmtOutageTime = (iso: string): string => {
    try {
      return new Intl.DateTimeFormat(getLocale(lang), {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  // ── State guards ──
  if (state !== 'ready' && state !== 'empty') {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }
  if (!data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }
  // Collector just started: zero samples AND no live snapshot yet.
  if ((data.window?.sampleCount ?? 0) === 0 && !data.snapshot) {
    return (
      <SectionMessagePanel
        icon={Server}
        iconClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        title={t(ak(`${DC}.empty.title`))}
        body={t(ak(`${DC}.empty.body`))}
      />
    );
  }

  const win = data.window;
  const res = data.resources;
  const busiest = data.busiest;

  // ── Timeline metric ──
  const metricDef = TIMELINE_METRICS.find((m) => m.id === metric) ?? TIMELINE_METRICS[0];
  const metricLabel = t(ak(`${DC}.metric.${metricDef.id}`));
  const unitSuffix = metricUnit(metricDef.id);
  // Backend buckets carry FULL ISO stamps — truncate to 'YYYY-MM-DDTHH'
  // (13 chars) so formatBucket() recognizes and localizes them.
  const timelineData = (data.timeline ?? []).map((p) => ({ t: String(p.t).slice(0, 13), v: safe(p[metricDef.id]) }));
  const hasTimeline = timelineData.length > 0;

  // ── Hourly / weekday / heatmap pattern metric ──
  const patternDef = PATTERN_METRICS.find((m) => m.id === patternMetric) ?? PATTERN_METRICS[0];
  const patternLabel = t(ak(patternDef.labelKey));
  const patternSuffix = patternUnit(patternDef.id);

  const hourlyData = (data.hourly ?? []).map((h) => ({
    hour: `${pad2(safe(h.hour))}:00`,
    avg: patternMetric === 'cpu' ? h.cpuAvg : patternMetric === 'ram' ? h.ramAvg : h.netAvg,
    peak: patternMetric === 'cpu' ? h.cpuPeak : patternMetric === 'ram' ? h.ramPeak : h.netPeak,
    samples: safe(h.samples),
  }));
  const hasHourly = hourlyData.some((d) => d.avg !== null || d.peak !== null);

  const weekdayData = (data.weekday ?? []).map((w) => ({
    label: weekdayShort(w.weekday),
    avg: safe(w.cpuAvg),
    samples: safe(w.samples),
  }));
  const weekdayMax = weekdayData.reduce((m, d) => Math.max(m, d.avg), 0);
  const hasWeekday = weekdayData.some((d) => d.avg > 0);

  // Heatmap matrix for the current pattern metric ([7][24] with null holes).
  const heatMatrix = data.weekdayHour?.[patternMetric] ?? [];
  const heatMax = heatMatrix.reduce<number>((max, row) => {
    (row ?? []).forEach((v) => {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    });
    return max;
  }, 0);
  const heatAlpha = (v: number): number => {
    if (heatMax <= 0 || v <= 0) return 0.08;
    return Math.min(0.95, 0.12 + 0.83 * (v / heatMax));
  };

  const outages = data.outages ?? [];

  // ── Component activity ──
  const componentRows = data.components ?? [];
  const activeComponents = new Set(
    componentRows.filter((c) => safe(c.requests) > 0).map((c) => c.component),
  );
  const compTsData = (data.componentTimeseries ?? []).map((p) => ({ t: String(p.t).slice(0, 13), requests: safe(p.requests) }));
  const hasCompTs = compTsData.some((d) => d.requests > 0);
  const selectedRow = componentRows.find((c) => c.component === component);
  const compTotals = selectedRow
    ? {
        requests: safe(selectedRow.requests),
        errors: safe(selectedRow.errors),
        bytesIn: safe(selectedRow.bytesIn),
        bytesOut: safe(selectedRow.bytesOut),
      }
    : (data.componentTimeseries ?? []).reduce(
        (acc, p) => ({
          requests: acc.requests + safe(p.requests),
          errors: acc.errors + safe(p.errors),
          bytesIn: acc.bytesIn + safe(p.bytesIn),
          bytesOut: acc.bytesOut + safe(p.bytesOut),
        }),
        { requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 },
      );

  // Snapshot relative label (Intl — no i18n keys needed).
  let snapshotRel: string | null = null;
  if (data.snapshot?.at) {
    try {
      const diffMin = Math.round((Date.now() - new Date(data.snapshot.at).getTime()) / 60000);
      const rtf = new Intl.RelativeTimeFormat(getLocale(lang), { numeric: 'auto' });
      if (Math.abs(diffMin) < 1) snapshotRel = rtf.format(0, 'minute');
      else if (Math.abs(diffMin) < 60) snapshotRel = rtf.format(-diffMin, 'minute');
      else snapshotRel = rtf.format(-Math.round(diffMin / 60), 'hour');
    } catch {
      snapshotRel = null;
    }
  }

  // ── Tooltips (same inline pattern as the neighboring sections) ──
  const TimelineTooltip = (props: {
    active?: boolean;
    label?: string | number;
    payload?: Array<{ value?: number | string }>;
  }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="mb-1 font-bold text-foreground">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          <span className="me-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: metricDef.color }} />
          {metricLabel}:{' '}
          <span className="font-bold text-foreground" dir="ltr">
            {fmtNum(Number(props.payload[0]?.value ?? 0))}
            {unitSuffix ? ` ${unitSuffix}` : ''}
          </span>
        </p>
      </ChartTooltipBox>
    );
  };

  const HourlyTooltip = (props: {
    active?: boolean;
    label?: string | number;
    payload?: Array<{ dataKey?: string | number; value?: number | string | null }>;
  }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const fmtV = (v: number | string | null | undefined): string =>
      v === null || v === undefined ? '—' : `${fmtNum(Number(v))}${patternSuffix ? ` ${patternSuffix}` : ''}`;
    const hourlySamples = hourlyData.find((r) => r.hour === String(props.label ?? ''))?.samples ?? 0;
    return (
      <ChartTooltipBox>
        <p className="mb-1 font-bold text-foreground" dir="ltr">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          <span className="me-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />
          {t(ak(`${DC}.hourly.avg`))}:{' '}
          <span className="font-bold text-foreground" dir="ltr">
            {fmtV(props.payload.find((p) => p.dataKey === 'avg')?.value)}
          </span>
        </p>
        <p className="text-muted-foreground">
          <span className="me-1.5 inline-block h-2 w-2 rounded-full bg-amber-500" />
          {t(ak(`${DC}.hourly.peak`))}:{' '}
          <span className="font-bold text-foreground" dir="ltr">
            {fmtV(props.payload.find((p) => p.dataKey === 'peak')?.value)}
          </span>
        </p>
        {hourlySamples > 0 && (
          <p className="text-[10px] text-muted-foreground/80">
            {t(ak(`${DC}.samples`), { count: hourlySamples.toLocaleString() })}
          </p>
        )}
      </ChartTooltipBox>
    );
  };

  const WeekdayTooltip = (props: {
    active?: boolean;
    label?: string | number;
    payload?: Array<{ value?: number | string }>;
  }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const weekdaySamples = weekdayData.find((r) => r.label === String(props.label ?? ''))?.samples ?? 0;
    return (
      <ChartTooltipBox>
        <p className="mb-1 font-bold text-foreground">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak(`${DC}.kpi.cpu`))}:{' '}
          <span className="font-bold text-foreground" dir="ltr">{fmtNum(Number(props.payload[0]?.value ?? 0))}%</span>
        </p>
        {weekdaySamples > 0 && (
          <p className="text-[10px] text-muted-foreground/80">
            {t(ak(`${DC}.samples`), { count: weekdaySamples.toLocaleString() })}
          </p>
        )}
      </ChartTooltipBox>
    );
  };

  const CompTooltip = (props: {
    active?: boolean;
    label?: string | number;
    payload?: Array<{ value?: number | string }>;
  }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="mb-1 font-bold text-foreground">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          <span className="me-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500" />
          {t(ak(`${DC}.component.requests`))}:{' '}
          <span className="font-bold text-foreground" dir="ltr">{fmtNum(Number(props.payload[0]?.value ?? 0), 0)}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}

      {/* ── 1. Engine/manager filter row ── */}
      <Card className="border-0 bg-white shadow-sm dark:bg-gray-900/80">
        <CardContent className="space-y-2.5 p-4">
          <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
            <Filter className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            {t(ak(`${DC}.component.filter`))}
            {component !== '' && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">
                {compLabel(component)}
              </Badge>
            )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant={component === '' ? 'default' : 'outline'}
              size="sm"
              className="h-7 rounded-full text-[11px]"
              onClick={() => setComponent('')}
            >
              {t(ak(`${DC}.component.all`))}
            </Button>
            {SERVER_COMPONENT_KEYS.map((key) => (
              <Button
                key={key}
                variant={component === key ? 'default' : 'outline'}
                size="sm"
                className="h-7 rounded-full text-[11px]"
                onClick={() => setComponent(key)}
              >
                {compLabel(key)}
                {activeComponents.has(key) && (
                  <span className="ms-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                )}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── 2. KPI row ── */}
      <StatTiles
        items={[
          {
            icon: Cpu,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: `${t(ak(`${DC}.kpi.cpu`))} · p95 ${fmtNum(res.cpu.p95)}%`,
            text: `${fmtNum(res.cpu.avg)} / ${fmtNum(res.cpu.peak)}%`,
          },
          {
            icon: MemoryStick,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: `${t(ak(`${DC}.kpi.ram`))} · ${fmtNum(res.ram.avgUsedMb, 0)} / ${fmtNum(res.ram.totalMb, 0)} MB`,
            text: `${fmtNum(res.ram.avgPct)} / ${fmtNum(res.ram.peakPct)}%`,
          },
          {
            icon: HardDrive,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: `${t(ak(`${DC}.kpi.diskSpace`))} · ${fmtNum(res.diskSpace.usedGb)} / ${fmtNum(res.diskSpace.totalGb)} GB`,
            text: `${fmtNum(res.diskSpace.avgPct ?? 0)} / ${fmtNum(res.diskSpace.peakPct ?? 0)}%`,
          },
          {
            icon: Repeat,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: `${t(ak(`${DC}.kpi.diskIo`))} · ${fmtNum(safe(res.diskRead.totalGb) + safe(res.diskWrite.totalGb))} GB`,
            text: `${fmtNum(res.diskRead.avgKbps)} / ${fmtNum(res.diskWrite.avgKbps)} KB/s`,
          },
          {
            icon: Wifi,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: `${t(ak(`${DC}.kpi.network`))}${safe(win.linkMbpsCap) > 0 ? ` · ${fmtNum(win.linkMbpsCap, 0)} Mbps` : ''}`,
            text: `${fmtNum(res.netUp.avgKbps)} / ${fmtNum(res.netDown.avgKbps)} KB/s`,
          },
          {
            icon: Activity,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: `${t(ak(`${DC}.kpi.availability`))} · ${t(ak(`${DC}.samples`), { count: fmtNum(win.sampleCount, 0) })}`,
            value: safe(win.availabilityPct),
            decimals: 1,
            suffix: '%',
          },
          {
            icon: Gauge,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: `${t(ak(`${DC}.kpi.load`))} · ${fmtNum(res.load.cores, 0)} vCPU`,
            text: `${fmtNum(res.load.avg, 2)} / ${fmtNum(res.load.peak, 2)}`,
          },
        ]}
      />

      {/* ── 3. Live snapshot strip ── */}
      {data.snapshot && (
        <Card className="overflow-hidden border-0 bg-white shadow-sm ring-1 ring-teal-200 dark:bg-gray-900/80 dark:ring-teal-900/60">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-cyan-600">
                  <Server className="h-4 w-4 text-white" />
                </div>
                <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.snapshot.title`))}</CardTitle>
              </div>
              {snapshotRel && (
                <span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold text-teal-700 dark:text-teal-400">
                  <Clock3 className="h-3 w-3" />
                  {snapshotRel}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.kpi.cpu`))}</p>
                <p className="mt-0.5 text-sm font-black text-foreground" dir="ltr">
                  {fmtNum(data.snapshot.cpuUsagePct)}%
                </p>
                <p className="text-[10px] text-muted-foreground" dir="ltr">
                  {t(ak(`${DC}.metric.iowait`))} {fmtNum(data.snapshot.cpuIowaitPct)}%
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.kpi.ram`))}</p>
                <p className="mt-0.5 text-sm font-black text-foreground" dir="ltr">
                  {fmtNum(data.snapshot.ramUsedMb, 0)} / {fmtNum(data.snapshot.ramTotalMb, 0)} MB
                </p>
                <p className="text-[10px] text-muted-foreground" dir="ltr">
                  {fmtNum(data.snapshot.ramUsagePct)}%
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.kpi.diskSpace`))}</p>
                <p className="mt-0.5 text-sm font-black text-foreground" dir="ltr">
                  {fmtNum(data.snapshot.diskUsedGb)} / {fmtNum(data.snapshot.diskTotalGb)} GB
                </p>
                <p className="text-[10px] text-muted-foreground" dir="ltr">
                  {fmtNum(data.snapshot.diskUsagePct)}%
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.kpi.network`))}</p>
                <p className="mt-0.5 text-sm font-black text-foreground" dir="ltr">
                  {fmtNum(data.snapshot.netUpKbps, 0)} / {fmtNum(data.snapshot.netDownKbps, 0)} KB/s
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.kpi.diskIo`))}</p>
                <p className="mt-0.5 text-sm font-black text-foreground" dir="ltr">
                  {fmtNum(data.snapshot.diskReadKbps, 0)} / {fmtNum(data.snapshot.diskWriteKbps, 0)} KB/s
                </p>
                <p className="text-[10px] text-muted-foreground" dir="ltr">
                  R / W
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.kpi.load`))}</p>
                <p className="mt-0.5 text-sm font-black text-foreground" dir="ltr">
                  {fmtNum(data.snapshot.loadAvg1, 2)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 4. Resource timeline (metric switch) ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="me-1 text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.chart.metric`))}</span>
          {TIMELINE_METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMetric(m.id)}
              aria-pressed={metric === m.id}
              className={`h-7 rounded-md px-2.5 text-[10px] font-bold transition-colors ${
                metric === m.id
                  ? 'bg-emerald-500 text-white shadow-sm'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t(ak(`${DC}.metric.${m.id}`))}
            </button>
          ))}
        </div>
        <ChartCard
          title={t(ak(`${DC}.chart.timeline`))}
          subtitle={t(ak(`${DC}.chart.timelineHint`))}
          icon={TrendingUp}
          iconClass="from-emerald-500 to-teal-600"
          empty={!hasTimeline}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timelineData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={(v: string) => formatBucket(String(v), lang)}
                tick={{ fontSize: 10 }}
                stroke="rgba(128,128,128,0.4)"
                tickLine={false}
                minTickGap={18}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                stroke="rgba(128,128,128,0.4)"
                width={44}
                allowDecimals={false}
                tickFormatter={(v: number) => compactAxis(v)}
                domain={unitSuffix === '%' ? [0, 100] : undefined}
              />
              <Tooltip content={<TimelineTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
              <Area
                type="monotone"
                dataKey="v"
                stroke={metricDef.color}
                fill={metricDef.color}
                fillOpacity={0.15}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── 5. Hour-of-day + weekday patterns (shared cpu/ram/net toggle) ── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="me-1 text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.chart.metric`))}</span>
          {PATTERN_METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setPatternMetric(m.id)}
              aria-pressed={patternMetric === m.id}
              className={`h-7 rounded-md px-2.5 text-[10px] font-bold transition-colors ${
                patternMetric === m.id
                  ? 'bg-teal-500 text-white shadow-sm'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t(ak(m.labelKey))}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2">
          <ChartCard
            title={t(ak(`${DC}.chart.hourly`))}
            subtitle={t(ak(`${DC}.chart.hourlyHint`))}
            icon={Clock3}
            iconClass="from-emerald-500 to-teal-600"
            empty={!hasHourly}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={hourlyData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                <XAxis dataKey="hour" tick={{ fontSize: 9 }} stroke="rgba(128,128,128,0.4)" tickLine={false} interval={1} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  width={40}
                  allowDecimals={false}
                  domain={patternSuffix === '%' ? [0, 100] : undefined}
                />
                <Tooltip content={<HourlyTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
                <Bar dataKey="avg" fill="#10b981" fillOpacity={0.75} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
                <Line
                  type="monotone"
                  dataKey="peak"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard
            title={t(ak(`${DC}.chart.weekday`))}
            subtitle={t(ak(`${DC}.chart.weekdayHint`))}
            icon={CalendarDays}
            iconClass="from-teal-500 to-cyan-600"
            empty={!hasWeekday}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekdayData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  width={40}
                  allowDecimals={false}
                  domain={[0, 100]}
                />
                <Tooltip content={<WeekdayTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
                <Bar dataKey="avg" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
                  {weekdayData.map((d, i) => (
                    <Cell key={i} fill="#10b981" fillOpacity={weekdayMax > 0 && d.avg === weekdayMax ? 0.95 : 0.6} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>

      {/* ── 6. Weekday × hour heatmap (pure CSS — busiest cell ringed) ── */}
      <ChartCard
        title={t(ak(`${DC}.heatmap.title`))}
        subtitle={t(ak(`${DC}.heatmap.hint`), { metric: patternLabel })}
        icon={LayoutGrid}
        iconClass="from-cyan-500 to-emerald-600"
        heightClass="h-auto"
      >
        <div className="space-y-1 text-[9px] text-muted-foreground">
          <div className="flex items-center gap-[3px]">
            <span className="w-10 shrink-0" />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="flex-1 text-center font-semibold">
                {h % 3 === 0 ? pad2(h) : ''}
              </span>
            ))}
          </div>
          {Array.from({ length: 7 }, (_, wd) => {
            const busiestCell = busiest?.weekdayHour ?? null;
            return (
              <div key={wd} className="flex items-center gap-[3px]">
                <span className="w-10 shrink-0 font-semibold text-foreground/70">{weekdayShort(wd)}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = heatMatrix[wd]?.[h] ?? null;
                  const isBusiest = !!busiestCell && busiestCell.weekday === wd && busiestCell.hour === h;
                  return (
                    <div
                      key={h}
                      title={`${weekdayShort(wd)} ${pad2(h)}:00 — ${
                        v === null ? '—' : `${fmtNum(v)}${patternSuffix ? ` ${patternSuffix}` : ''}`
                      }`}
                      className={`h-6 flex-1 rounded-[4px] ${v === null ? 'bg-muted' : ''} ${
                        isBusiest
                          ? 'ring-2 ring-emerald-600 ring-offset-1 ring-offset-white dark:ring-offset-gray-900'
                          : ''
                      }`}
                      style={v === null ? undefined : { backgroundColor: `rgba(16,185,129,${heatAlpha(v)})` }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </ChartCard>

      {/* ── 7. Peak times + connection losses ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden border-0 bg-white shadow-sm dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-orange-500">
                <Flame className="h-4 w-4 text-white" />
              </div>
              <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.peak.title`))}</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.peak.hour`))}</p>
              <p className="text-lg font-black leading-tight text-foreground" dir="ltr">
                {busiest?.hour != null ? `${pad2(busiest.hour)}:00` : '—'}
              </p>
            </div>
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.peak.weekday`))}</p>
              <p className="text-lg font-black leading-tight text-foreground">
                {busiest?.weekday != null ? weekdayLong(busiest.weekday) : '—'}
              </p>
            </div>
            <div className="rounded-xl bg-muted/40 p-3">
              <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.peak.cell`))}</p>
              <p className="text-lg font-black leading-tight text-foreground">
                {busiest?.weekdayHour ? (
                  <>
                    {weekdayShort(busiest.weekdayHour.weekday)} <span dir="ltr">{pad2(busiest.weekdayHour.hour)}:00</span>
                  </>
                ) : (
                  '—'
                )}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-0 bg-white shadow-sm dark:bg-gray-900/80 lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-orange-500">
                <ServerCrash className="h-4 w-4 text-white" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.outages.title`))}</CardTitle>
                <p className="truncate text-[11px] text-muted-foreground">{t(ak(`${DC}.outages.subtitle`))}</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.outages.count`))}</p>
                <p className="text-base font-black text-foreground" dir="ltr">
                  {fmtNum(safe(win.outageCount), 0)}
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.outages.total`))}</p>
                <p className="text-base font-black text-foreground" dir="ltr">
                  {fmtDuration(win.outageTotalSec)}
                </p>
              </div>
              <div className="rounded-xl bg-muted/40 p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground">{t(ak(`${DC}.outages.longest`))}</p>
                <p className="text-base font-black text-foreground" dir="ltr">
                  {fmtDuration(win.outageLongestSec)}
                </p>
              </div>
            </div>
            {outages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
                <CheckCircle2 className="mb-2 h-7 w-7 text-emerald-400 opacity-80" />
                <p className="text-sm">{t(ak(`${DC}.outages.none`))}</p>
              </div>
            ) : (
              <div className="custom-scrollbar max-h-64 overflow-y-auto pe-1">
                <div className="divide-y divide-border/60">
                  {outages.map((o, i) => (
                    <div key={`${o.startedAt}-${i}`} className="flex items-center justify-between gap-2 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-foreground" dir="ltr">
                          {fmtOutageTime(o.startedAt)} → {o.endedAt ? fmtOutageTime(o.endedAt) : '…'}
                        </p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground">
                          {t(ak(REASON_KEYS[o.reason]))} · <span dir="ltr">{fmtDuration(o.durationSec)}</span>
                        </p>
                      </div>
                      {o.endedAt === null && (
                        <Badge className="h-5 shrink-0 border-transparent bg-rose-100 px-1.5 text-[9px] text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
                          {t(ak(`${DC}.outages.ongoing`))}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── 8. Bottleneck verdicts ── */}
      <Card className="overflow-hidden border-0 bg-white shadow-sm dark:bg-gray-900/80">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-rose-500">
              <AlertTriangle className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-sm font-semibold">{t(ak(`${DC}.bottleneck.title`))}</CardTitle>
              <p className="truncate text-[11px] text-muted-foreground">{t(ak(`${DC}.bottleneck.subtitle`))}</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            {(data.bottlenecks ?? []).map((b, i) => {
              const meta = BOTTLENECK_META[b.resource] ?? BOTTLENECK_META.cpu;
              const level = LEVEL_META[b.level] ?? LEVEL_META.ok;
              const Icon = meta.icon;
              return (
                <div key={`${b.resource}-${i}`} className="flex items-center gap-3 rounded-xl bg-muted/40 px-3 py-2.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white dark:bg-gray-800">
                    <Icon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span className="w-24 shrink-0 truncate text-xs font-bold text-foreground">
                    {t(ak(meta.labelKey))}
                  </span>
                  <Badge className={`h-5 shrink-0 border-transparent px-1.5 text-[9px] ${level.badgeClass}`}>
                    {t(ak(level.labelKey))}
                  </Badge>
                  <span className="min-w-0 flex-1 text-[11px] text-muted-foreground" dir="ltr">
                    {b.reason}
                  </span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* ── 9. Component activity ── */}
      {component === '' ? (
        <SectionTablePanel
          title={t(ak(`${DC}.component.title`))}
          subtitle={t(ak(`${DC}.component.subtitle`))}
          icon={Layers}
          iconClass="from-emerald-500 to-teal-600"
          rows={componentRows}
          getKey={(r) => r.component}
          emptyIcon={Server}
          columns={[
            {
              header: t(ak(`${DC}.component.name`)),
              className: 'flex-1 min-w-0',
              cell: (r) => (
                <span className="block max-w-[200px] truncate font-bold" title={compLabel(r.component)}>
                  {compLabel(r.component)}
                </span>
              ),
            },
            {
              header: t(ak(`${DC}.component.requests`)),
              className: 'w-20 shrink-0 text-end',
              align: 'end',
              cell: (r) => <span dir="ltr">{fmtNum(safe(r.requests), 0)}</span>,
            },
            {
              header: t(ak(`${DC}.component.errors`)),
              className: 'w-16 shrink-0 text-end',
              align: 'end',
              cell: (r) => (
                <span dir="ltr" className={safe(r.errors) > 0 ? 'font-semibold text-rose-600 dark:text-rose-400' : ''}>
                  {fmtNum(safe(r.errors), 0)}
                </span>
              ),
            },
            {
              header: t(ak(`${DC}.component.errorRate`)),
              className: 'w-16 shrink-0 text-end',
              align: 'end',
              cell: (r) => <span dir="ltr">{fmtNum(safe(r.errorRatePct))}%</span>,
            },
            {
              header: t(ak(`${DC}.component.bytes`)),
              className: 'w-24 shrink-0 text-end',
              align: 'end',
              cell: (r) => (
                <span
                  dir="ltr"
                  className="font-semibold"
                  title={`${(safe(r.bytesIn) + safe(r.bytesOut)).toLocaleString()} B`}
                >
                  {formatBytesLocal(safe(r.bytesIn) + safe(r.bytesOut))}
                </span>
              ),
            },
            {
              header: t(ak(`${DC}.component.share`)),
              className: 'w-24 shrink-0',
              cell: (r) => (
                <Progress
                  value={Math.min(100, safe(r.sharePct))}
                  className="h-1.5 bg-emerald-100 dark:bg-emerald-900/30 [&>div]:bg-emerald-500"
                  aria-label={`${compLabel(r.component)}: ${fmtNum(safe(r.sharePct))}%`}
                />
              ),
            },
          ]}
        />
      ) : (
        <div className="space-y-4">
          <StatTiles
            items={[
              {
                icon: Activity,
                iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
                label: t(ak(`${DC}.component.requests`)),
                value: compTotals.requests,
              },
              {
                icon: AlertTriangle,
                iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
                label: t(ak(`${DC}.component.errors`)),
                value: compTotals.errors,
              },
              {
                icon: Download,
                iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
                label: `${t(ak(`${DC}.component.bytes`))} ↓`,
                text: formatBytesLocal(compTotals.bytesIn),
              },
              {
                icon: Upload,
                iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
                label: `${t(ak(`${DC}.component.bytes`))} ↑`,
                text: formatBytesLocal(compTotals.bytesOut),
              },
            ]}
          />
          <ChartCard
            title={t(ak(`${DC}.component.chart`), { component: compLabel(component) })}
            icon={TrendingUp}
            iconClass="from-emerald-500 to-teal-600"
            empty={!hasCompTs}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={compTsData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={(v: string) => formatBucket(String(v), lang)}
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  tickLine={false}
                  minTickGap={18}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  width={44}
                  allowDecimals={false}
                  tickFormatter={(v: number) => compactAxis(v)}
                />
                <Tooltip content={<CompTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
                <Area
                  type="monotone"
                  dataKey="requests"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      )}

      {/* ── Methodology note + recording-since meta ── */}
      <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0 text-teal-500" />
        <span>{t(ak(`${DC}.component.note`))}</span>
      </p>
      {data.meta?.recordedSince && (
        <p className="text-[10px] text-muted-foreground">
          {t(ak('adminAnalytics.dataConsumption.meta.recordedSince'), { date: fmtDay(data.meta.recordedSince) })}
        </p>
      )}
    </div>
  );
}
