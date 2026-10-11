'use client';

// ─── Task 54-c: Reservations section (doc-2 §18) ─────────────────────────────
// GET /api/agency/analytics/reservations — the §3.2 org-filter subset the
// backend accepts for owners exposed as compact selects:
//   branch · counter · service · staff · status · channel
// (NO agencyId — every owner query is locked to the caller's own agency
// server-side; a foreign agencyId would 403 anyway.)
// Option lists come from two owner-accessible endpoints:
//   • GET /api/agency/analytics/dashboard?period=30d — branches/counters/
//     services arrays (legacy payload, owner + staff);
//   • GET /api/agency/analytics/staff?period=30d — staff rows (contract §2.5).
//
// Body: §3.2 filter card · KPI tiles (volumes + rates + wait/service stats) ·
// trend chart · channel split · status distribution · hourly traffic ·
// by-service / by-branch / by-counter tables.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { ClipboardList, Filter, Globe, Globe2, Store, TrendingUp, X } from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { humanizeEnum } from '@/lib/enum-i18n';
import type { TranslationKeys } from '@/i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
  type SectionColumn,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import { ANALYTICS_STATUS_META } from './types';
import {
  EMPTY_OWNER_RESERVATION_FILTERS,
  type OwnerGroupStats,
  type OwnerReservationFilters,
  type OwnerReservationsData,
} from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

const RESERVATION_STATUSES = ['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;

interface OptionRow {
  id: string;
  name: string;
}

/** Compact labeled select used by the filter card. */
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
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="min-w-0">
      <label className="block text-[10px] font-semibold text-muted-foreground mb-1">{label}</label>
      <Select value={value || undefined} onValueChange={(v) => onChange(v === value ? '' : v)}>
        <SelectTrigger className="h-8 text-xs w-full" aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function OwnerReservationsSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const [filters, setFilters] = useState<OwnerReservationFilters>(EMPTY_OWNER_RESERVATION_FILTERS);
  const [branchOptions, setBranchOptions] = useState<OptionRow[]>([]);
  const [counterOptions, setCounterOptions] = useState<OptionRow[]>([]);
  const [serviceOptions, setServiceOptions] = useState<OptionRow[]>([]);
  const [staffOptions, setStaffOptions] = useState<OptionRow[]>([]);
  // Guards stale option-list responses after rapid remounts.
  const optionsSeqRef = useRef(0);

  // Owner-accessible option lists: legacy dashboard payload (branches /
  // counters / services) + the §2.5 staff section. Fetched ONCE on mount —
  // the scope is always the caller's own agency.
  useEffect(() => {
    const seq = ++optionsSeqRef.current;
    const alive = () => seq === optionsSeqRef.current;
    (async () => {
      try {
        const [legacyRes, staffRes] = await Promise.all([
          apiFetch('/api/agency/analytics/dashboard?period=30d', { method: 'GET' }),
          apiFetch('/api/agency/analytics/staff?period=30d', { method: 'GET' }),
        ]);
        if (!alive()) return;
        const mapOpts = (rows: unknown, idKey: string): OptionRow[] =>
          Array.isArray(rows)
            ? (rows as Record<string, unknown>[])
                .filter((r) => typeof r === 'object' && r !== null)
                .map((r) => ({ id: String(r[idKey] ?? ''), name: String(r.name ?? '—') }))
                .filter((r) => r.id)
            : [];
        if (legacyRes.ok) {
          const body: unknown = await legacyRes.json();
          if (alive() && body && typeof body === 'object') {
            const inner = (body as Record<string, unknown>).data ?? body;
            const b = inner as Record<string, unknown>;
            setBranchOptions(mapOpts(b.branches, 'branchId'));
            setCounterOptions(mapOpts(b.counters, 'counterId'));
            setServiceOptions(mapOpts(b.services, 'serviceId'));
          }
        }
        if (staffRes.ok) {
          const body: unknown = await staffRes.json();
          if (alive() && body && typeof body === 'object') {
            const inner = (body as Record<string, unknown>).data ?? body;
            const rows = (inner as Record<string, unknown>).staff;
            if (Array.isArray(rows)) {
              setStaffOptions(
                (rows as Record<string, unknown>[])
                  .filter((r) => typeof r.staffId === 'string' && r.staffId)
                  .map((r) => ({ id: String(r.staffId), name: String(r.name ?? '—') })),
              );
            }
          }
        }
      } catch {
        if (alive()) {
          setBranchOptions([]);
          setCounterOptions([]);
          setServiceOptions([]);
          setStaffOptions([]);
        }
      }
    })();
  }, []);

  const activeFilters = Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>;
  const sectionQuery: OwnerSectionQuery = {
    ...query,
    filters: Object.fromEntries(activeFilters),
  };

  const { data, resolved, state, refresh, isQueryReady } = useOwnerSectionData<OwnerReservationsData>(
    'reservations',
    sectionQuery,
    { isEmpty: (d) => (d.kpis?.total ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  const setFilter = useCallback((key: keyof OwnerReservationFilters, value: string) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      // A branch change invalidates its dependent counter scope.
      if (key === 'branchId' && value !== prev.branchId) {
        next.counterId = '';
      }
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => setFilters(EMPTY_OWNER_RESERVATION_FILTERS), []);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const kpis = data.kpis;

  const trendData = (data.timeseries ?? []).map((p) => ({
    bucket: p.bucket,
    total: safe(p.total),
    completed: safe(p.completed),
  }));
  const hasTrend = trendData.some((p) => p.total > 0);

  const channelData = (data.channel?.daily ?? []).map((p) => ({
    bucket: p.bucket,
    online: safe(p.online),
    walkIn: safe(p.walkIn),
  }));
  const hasChannel = channelData.some((p) => p.online + p.walkIn > 0);

  const hourlyData = Array.from({ length: 24 }, (_, hour) => {
    const found = (data.hourlyTraffic ?? []).find((p) => p.hour === hour);
    return { hour, count: safe(found?.count) };
  });
  const hasHourly = hourlyData.some((p) => p.count > 0);

  const TrendTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{formatBucket(String(props.label ?? ''), lang)}</p>
        {props.payload.map((p) => (
          <p key={String(p.dataKey)} className="text-muted-foreground">
            {p.dataKey === 'total' ? t('totalReservations') : t('completed')}:{' '}
            <span className="font-bold text-foreground">{Number(p.value ?? 0).toLocaleString()}</span>
          </p>
        ))}
      </ChartTooltipBox>
    );
  };

  const ChannelTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ dataKey?: string | number; value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const online = Number(props.payload.find((p) => p.dataKey === 'online')?.value ?? 0);
    const walkIn = Number(props.payload.find((p) => p.dataKey === 'walkIn')?.value ?? 0);
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground mb-1">{formatBucket(String(props.label ?? ''), lang)}</p>
        <p className="text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block me-1.5" />
          {t('onlineReservations')}: <span className="font-bold text-foreground">{online.toLocaleString()}</span>
        </p>
        <p className="text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-amber-500 inline-block me-1.5" />
          {t('walkIn')}: <span className="font-bold text-foreground">{walkIn.toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const HourlyTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const hour = Number(props.label ?? 0);
    const hourLabel = lang === 'ar' ? `${hour}:00` : hour < 12 ? `${hour === 0 ? 12 : hour}AM` : hour === 12 ? '12PM' : `${hour - 12}PM`;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{hourLabel}</p>
        <p className="text-muted-foreground">
          {Number(props.payload[0]?.value ?? 0).toLocaleString()} {t('reservationsCount')}
        </p>
      </ChartTooltipBox>
    );
  };

  const waitTile = (label: TranslationKeys, value: number | null, icon: typeof TrendingUp, iconClass: string) => ({
    icon,
    iconClass,
    label: t(label),
    value: value === null ? 0 : safe(value),
    text: value === null ? '—' : undefined,
    decimals: value === null ? undefined : 1,
    suffix: value === null ? undefined : ` ${t('min')}`,
  });

  const statColumns: Array<SectionColumn<OwnerGroupStats>> = [
    {
      header: t('total'),
      className: 'w-12 text-center shrink-0',
      align: 'center',
      cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
    },
    {
      header: t('completed'),
      className: 'w-12 text-center shrink-0 hidden sm:block',
      align: 'center',
      cell: (r) => <span dir="ltr">{safe(r.completed).toLocaleString()}</span>,
    },
    {
      header: t('completionRate'),
      className: 'w-16 text-center shrink-0 hidden md:block',
      align: 'center',
      cell: (r) => <span dir="ltr">{safe(r.completionRate).toFixed(0)}%</span>,
    },
    {
      header: t('avgWaitTime'),
      className: 'w-16 text-center shrink-0 hidden md:block',
      align: 'center',
      cell: (r) => (
        <span dir="ltr">{r.avgWaitMinutes === null ? '—' : `${safe(r.avgWaitMinutes).toFixed(0)} ${t('min')}`}</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}

      {/* ── §3.2 org filters (owner subset) ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs font-bold text-foreground">
              <Filter className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              {t(ak('ownerAnalytics.res.filters'))}
              {activeFilters.length > 0 && (
                <Badge className="text-[10px] h-5 px-1.5 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                  {activeFilters.length}
                </Badge>
              )}
            </p>
            {activeFilters.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 text-[11px] text-muted-foreground" onClick={clearFilters}>
                <X className="h-3 w-3 me-1" />
                {t(ak('adminAnalytics.res.clearFilters'))}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterBranch'))}
              placeholder={t(ak('adminAnalytics.res.allBranches'))}
              value={filters.branchId}
              onChange={(v) => setFilter('branchId', v)}
              options={branchOptions.map((o) => ({ value: o.id, label: o.name }))}
            />
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterCounter'))}
              placeholder={t(ak('adminAnalytics.res.allCounters'))}
              value={filters.counterId}
              onChange={(v) => setFilter('counterId', v)}
              options={counterOptions.map((o) => ({ value: o.id, label: o.name }))}
            />
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterService'))}
              placeholder={t(ak('adminAnalytics.res.allServices'))}
              value={filters.serviceId}
              onChange={(v) => setFilter('serviceId', v)}
              options={serviceOptions.map((o) => ({ value: o.id, label: o.name }))}
            />
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterStaff'))}
              placeholder={t(ak('adminAnalytics.res.allStaff'))}
              value={filters.staffId}
              onChange={(v) => setFilter('staffId', v)}
              options={staffOptions.map((o) => ({ value: o.id, label: o.name }))}
            />
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterStatus'))}
              placeholder={t(ak('adminAnalytics.res.allStatuses'))}
              value={filters.status}
              onChange={(v) => setFilter('status', v)}
              options={RESERVATION_STATUSES.map((s) => ({
                value: s,
                label: ANALYTICS_STATUS_META[s] ? t(ANALYTICS_STATUS_META[s].labelKey as TranslationKeys) : humanizeEnum(s),
              }))}
            />
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterChannel'))}
              placeholder={t(ak('adminAnalytics.res.allChannels'))}
              value={filters.channel}
              onChange={(v) => setFilter('channel', v)}
              options={[
                { value: 'online', label: t('onlineReservations') },
                { value: 'walkIn', label: t('walkIn') },
              ]}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── KPIs ── */}
      <StatTiles
        items={[
          {
            icon: ClipboardList,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('totalReservations'),
            value: safe(kpis.total),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t('completed'),
            value: safe(kpis.completed),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusCancelled'),
            value: safe(kpis.cancelled),
          },
          {
            icon: ClipboardList,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('statusNoShow'),
            value: safe(kpis.noShow),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('completionRate'),
            value: safe(kpis.completionRate),
            decimals: 1,
            suffix: '%',
          },
          waitTile('avgWaitTime', kpis.avgWaitMinutes, TrendingUp, 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400'),
          waitTile('ownerAnalytics.res.medianWait', kpis.medianWaitMinutes, TrendingUp, 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400'),
          waitTile('ownerAnalytics.res.avgService', kpis.avgServiceMinutes, TrendingUp, 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'),
        ]}
      />

      {/* ── Trend + status ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t('analyticsSection.trend.title')}
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
                <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
                <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'rgba(16,185,129,0.4)' }} />
                <Area type="monotone" dataKey="total" stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={2} />
                <Area type="monotone" dataKey="completed" stroke="#14b8a6" fill="#14b8a6" fillOpacity={0.1} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <CountListPanel
          title={t('analyticsSection.status.title')}
          icon={ClipboardList}
          iconClass="from-amber-500 to-orange-500"
          rows={(data.statusDistribution ?? [])
            .map((s) => ({
              label: ANALYTICS_STATUS_META[s.status]
                ? t(ANALYTICS_STATUS_META[s.status].labelKey as TranslationKeys)
                : humanizeEnum(s.status),
              count: safe(s.count),
            }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      {/* ── Channel + hourly ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={t(ak('adminAnalytics.channel.title'))} icon={Globe2} iconClass="from-cyan-500 to-emerald-600" empty={!hasChannel}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={channelData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="18%">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={(v: string) => formatBucket(String(v), lang)}
                tick={{ fontSize: 10 }}
                stroke="rgba(128,128,128,0.4)"
                tickLine={false}
                minTickGap={18}
              />
              <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
              <Tooltip content={<ChannelTooltip />} cursor={{ fill: 'rgba(16,185,129,0.06)' }} />
              <Bar dataKey="online" stackId="ch" fill="#10b981" maxBarSize={26} isAnimationActive={false} />
              <Bar dataKey="walkIn" stackId="ch" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={26} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title={t('analyticsSection.hourly.title')} icon={TrendingUp} iconClass="from-amber-500 to-orange-500" empty={!hasHourly}>
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
              <Tooltip content={<HourlyTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
              <Bar dataKey="count" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── By service / branch / counter tables ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionTablePanel<OwnerGroupStats & { serviceId: string; name: string }>
          title={t(ak('ownerAnalytics.res.byService'))}
          icon={ClipboardList}
          iconClass="from-emerald-500 to-teal-600"
          rows={data.byService ?? []}
          getKey={(r) => r.serviceId}
          columns={statColumns}
        />
        <SectionTablePanel<OwnerGroupStats & { branchId: string; name: string }>
          title={t(ak('adminAnalytics.res.topBranches'))}
          icon={ClipboardList}
          iconClass="from-teal-500 to-cyan-600"
          rows={data.byBranch ?? []}
          getKey={(r) => r.branchId}
          columns={statColumns}
        />
      </div>
      <SectionTablePanel<OwnerGroupStats & { counterId: string; name: string; branchName: string }>
        title={t(ak('ownerAnalytics.res.byCounter'))}
        icon={ClipboardList}
        iconClass="from-cyan-500 to-teal-600"
        rows={data.byCounter ?? []}
        getKey={(r) => r.counterId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                <span className="font-normal text-muted-foreground text-[10px] ms-1.5">{r.branchName}</span>
              </span>
            ),
          },
          ...statColumns,
        ]}
      />
    </div>
  );
}
