'use client';

// ─── Task 54-b: Reservations section (doc-2 §8) ──────────────────────────────
// GET /api/admin/analytics/reservations — the full §3.2 org-filter set exposed
// as compact selects:
//   agency (search combobox, reuse of the Overview AgencySearch) · category ·
//   wilaya · branch · counter · service · staff · status · channel.
// Branch/counter/service options come from the legacy per-agency payload
// (GET /api/admin/analytics/agency/:agencyId) once an agency is chosen; staff
// options come from GET /api/agency/analytics/staff?agencyId=… (contract §2.5 —
// SUPER_ADMIN may inspect any agency). Unset filters are simply not sent — the
// backend then returns the unfiltered section.
//
// Body: KPI tiles (volumes + rates + durations) · trend chart · channel split ·
// status distribution · top services/branches/agencies tables.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Building2, ClipboardList, Filter, Globe, Globe2, Store, TrendingUp, X } from 'lucide-react';
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
import { BUILT_IN_CATEGORY_OPTIONS } from '@/hooks/use-agency-categories';
import { ALGERIA_WILAYAS, wilayaLabel } from '@/lib/algeria-locations';
import { humanizeEnum, translateCategory } from '@/lib/enum-i18n';
import type { TranslationKeys } from '@/i18n';
import { AgencySearch } from './agency-search';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
  formatBucket,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import {
  ANALYTICS_STATUS_META,
} from '@/components/agency/analytics/types';
import {
  EMPTY_RESERVATION_FILTERS,
  type AdminReservationsData,
  type AdminReservationFilters,
  type AdminTopAgencyStatRow,
  type AdminTopBranchRow,
  type AdminTopServiceRow,
} from './section-types';
import type { AdminSelectedAgency } from './types';

const RESERVATION_STATUSES = ['WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;

interface OptionRow {
  id: string;
  name: string;
}

export function ReservationsSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const [filters, setFilters] = useState<AdminReservationFilters>(EMPTY_RESERVATION_FILTERS);
  const [selectedAgency, setSelectedAgency] = useState<AdminSelectedAgency | null>(null);
  const [branchOptions, setBranchOptions] = useState<OptionRow[]>([]);
  const [counterOptions, setCounterOptions] = useState<OptionRow[]>([]);
  const [serviceOptions, setServiceOptions] = useState<OptionRow[]>([]);
  const [staffOptions, setStaffOptions] = useState<OptionRow[]>([]);
  // Guards stale option-list responses after rapid agency switching.
  const optionsSeqRef = useRef(0);

  const agencyId = filters.agencyId;

  // Load per-agency option lists when (and only when) an agency is selected.
  useEffect(() => {
    if (!agencyId) {
      optionsSeqRef.current += 1;
      setBranchOptions([]);
      setCounterOptions([]);
      setServiceOptions([]);
      setStaffOptions([]);
      return;
    }
    const seq = ++optionsSeqRef.current;
    const alive = () => seq === optionsSeqRef.current;
    (async () => {
      try {
        const [legacyRes, staffRes] = await Promise.all([
          apiFetch(`/api/admin/analytics/agency/${encodeURIComponent(agencyId)}?period=30d`, { method: 'GET' }),
          apiFetch(`/api/agency/analytics/staff?agencyId=${encodeURIComponent(agencyId)}&period=30d`, { method: 'GET' }),
        ]);
        if (!alive()) return;
        const opts: { branches: OptionRow[]; counters: OptionRow[]; services: OptionRow[]; staff: OptionRow[] } = {
          branches: [],
          counters: [],
          services: [],
          staff: [],
        };
        if (legacyRes.ok) {
          const body: unknown = await legacyRes.json();
          if (alive() && body && typeof body === 'object') {
            const inner = (body as Record<string, unknown>).data ?? body;
            const b = inner as Record<string, unknown>;
            const mapOpts = (rows: unknown): OptionRow[] =>
              Array.isArray(rows)
                ? (rows as Record<string, unknown>[])
                    .filter((r) => typeof r === 'object' && r !== null)
                    .map((r) => ({
                      id: String(r.branchId ?? r.counterId ?? r.serviceId ?? ''),
                      name: String(r.name ?? '—'),
                    }))
                    .filter((r) => r.id)
                : [];
            opts.branches = mapOpts(b.branches);
            opts.counters = mapOpts(b.counters);
            opts.services = mapOpts(b.services);
          }
        }
        if (staffRes.ok) {
          const body: unknown = await staffRes.json();
          if (alive() && body && typeof body === 'object') {
            const inner = (body as Record<string, unknown>).data ?? body;
            const rows = (inner as Record<string, unknown>).staff;
            if (Array.isArray(rows)) {
              opts.staff = (rows as Record<string, unknown>[])
                .filter((r) => typeof r.staffId === 'string' && r.staffId)
                .map((r) => ({ id: String(r.staffId), name: String(r.name ?? '—') }));
            }
          }
        }
        if (!alive()) return;
        setBranchOptions(opts.branches);
        setCounterOptions(opts.counters);
        setServiceOptions(opts.services);
        setStaffOptions(opts.staff);
      } catch {
        if (alive()) {
          setBranchOptions([]);
          setCounterOptions([]);
          setServiceOptions([]);
          setStaffOptions([]);
        }
      }
    })();
  }, [agencyId]);

  const activeFilters = Object.entries(filters).filter(([, v]) => v) as Array<[string, string]>;
  const sectionQuery: AdminSectionQuery = {
    ...query,
    filters: Object.fromEntries(activeFilters),
  };

  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminReservationsData>(
    'reservations',
    sectionQuery,
    { isEmpty: (d) => (d.kpis?.total ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  const setFilter = useCallback((key: keyof AdminReservationFilters, value: string) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      // Changing agency invalidates its dependent scopes.
      if (key === 'agencyId' && value !== prev.agencyId) {
        next.branchId = '';
        next.counterId = '';
        next.serviceId = '';
        next.staffId = '';
      }
      return next;
    });
  }, []);

  const pickAgency = useCallback((agency: AdminSelectedAgency) => {
    setSelectedAgency(agency);
    setFilters((prev) => ({
      ...prev,
      agencyId: agency.id,
      branchId: '',
      counterId: '',
      serviceId: '',
      staffId: '',
    }));
  }, []);

  const clearAgency = useCallback(() => {
    setSelectedAgency(null);
    setFilters((prev) => ({
      ...prev,
      agencyId: '',
      branchId: '',
      counterId: '',
      serviceId: '',
      staffId: '',
    }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(EMPTY_RESERVATION_FILTERS);
    setSelectedAgency(null);
  }, []);

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

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}

      {/* ── §3.2 org filters ── */}
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

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {/* Agency — search combobox */}
            <div className="col-span-2 sm:col-span-3 lg:col-span-2">
              <AgencySearch selected={selectedAgency} onSelect={pickAgency} onClear={clearAgency} />
            </div>

            <FilterSelect
              label={t(ak('adminAnalytics.res.filterCategory'))}
              placeholder={t(ak('adminAnalytics.res.allCategories'))}
              value={filters.category}
              onChange={(v) => setFilter('category', v)}
              options={BUILT_IN_CATEGORY_OPTIONS.map((c) => ({ value: c.value, label: t(c.labelKey as TranslationKeys) }))}
            />
            <FilterSelect
              label={t(ak('adminAnalytics.res.filterWilaya'))}
              placeholder={t(ak('adminAnalytics.res.allWilayas'))}
              value={filters.wilaya}
              onChange={(v) => setFilter('wilaya', v)}
              options={ALGERIA_WILAYAS.map((w) => ({ value: w.code, label: wilayaLabel(w, lang) }))}
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

            {/* Agency-scoped selects — appear once an agency is chosen */}
            {agencyId && (
              <>
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
              </>
            )}
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
            icon: Globe,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t('onlineReservations'),
            value: safe(kpis.onlineCount),
          },
          {
            icon: Store,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('walkIn'),
            value: safe(kpis.walkInCount),
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t('completionRate'),
            value: safe(kpis.completionRate),
            decimals: 1,
            suffix: '%',
          },
          {
            icon: TrendingUp,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t('avgWaitTime'),
            value: kpis.avgWaitMinutes === null ? 0 : safe(kpis.avgWaitMinutes),
            text: kpis.avgWaitMinutes === null ? '—' : undefined,
            decimals: kpis.avgWaitMinutes === null ? undefined : 1,
            suffix: kpis.avgWaitMinutes === null ? undefined : ` ${t('min')}`,
          },
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
        <ChartCard
          title={t(ak('adminAnalytics.channel.title'))}
          icon={Globe2}
          iconClass="from-cyan-500 to-emerald-600"
          empty={!hasChannel}
        >
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
        <ChartCard
          title={t('analyticsSection.hourly.title')}
          icon={TrendingUp}
          iconClass="from-amber-500 to-orange-500"
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
              <Tooltip content={<HourlyTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
              <Bar dataKey="count" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Top services / branches / agencies tables ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionTablePanel<AdminTopServiceRow>
          title={t(ak('adminAnalytics.res.topServices'))}
          icon={ClipboardList}
          iconClass="from-emerald-500 to-teal-600"
          rows={data.topServices ?? []}
          getKey={(r) => r.serviceId}
          columns={[
            {
              header: t(ak('adminAnalytics.table.name')),
              className: 'flex-1 min-w-0',
              cell: (r) => <span className="font-bold truncate block" title={r.name}>{r.name}</span>,
            },
            {
              header: t('total'),
              className: 'w-14 text-center shrink-0',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
            },
            {
              header: t('completed'),
              className: 'w-14 text-center shrink-0 hidden sm:block',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.completed).toLocaleString()}</span>,
            },
            {
              header: t('completionRate'),
              className: 'w-16 text-center shrink-0',
              align: 'center',
              cell: (r) => (
                <span dir="ltr" className="text-emerald-700 dark:text-emerald-400 font-semibold">
                  {safe(r.completionRate).toFixed(0)}%
                </span>
              ),
            },
          ]}
        />
        <SectionTablePanel<AdminTopBranchRow>
          title={t(ak('adminAnalytics.res.topBranches'))}
          icon={Building2}
          iconClass="from-teal-500 to-cyan-600"
          rows={data.topBranches ?? []}
          getKey={(r) => r.branchId}
          columns={[
            {
              header: t(ak('adminAnalytics.table.name')),
              className: 'flex-1 min-w-0',
              cell: (r) => <span className="font-bold truncate block" title={r.name}>{r.name}</span>,
            },
            {
              header: t('total'),
              className: 'w-14 text-center shrink-0',
              align: 'center',
              cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
            },
            {
              header: t('completionRate'),
              className: 'w-16 text-center shrink-0',
              align: 'center',
              cell: (r) => (
                <span dir="ltr" className="text-emerald-700 dark:text-emerald-400 font-semibold">
                  {safe(r.completionRate).toFixed(0)}%
                </span>
              ),
            },
            {
              header: t('avgWaitTime'),
              className: 'w-16 text-center shrink-0 hidden sm:block',
              align: 'center',
              cell: (r) => <span dir="ltr">{r.avgWaitMinutes === null ? '—' : safe(r.avgWaitMinutes).toFixed(1)}</span>,
            },
          ]}
        />
      </div>
      <SectionTablePanel<AdminTopAgencyStatRow>
        title={t('topAgencies')}
        icon={Building2}
        iconClass="from-amber-500 to-orange-500"
        rows={data.topAgencies ?? []}
        getKey={(r) => r.agencyId}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                {r.customCode && (
                  <span className="ms-1.5 text-[9px] font-mono text-muted-foreground" dir="ltr">
                    {r.customCode}
                  </span>
                )}
              </span>
            ),
          },
          {
            header: t(ak('adminAnalytics.nav.categories')),
            className: 'w-24 shrink-0 hidden md:block',
            cell: (r) => (
              <Badge variant="secondary" className="text-[9px] px-1.5 h-4 font-medium max-w-24">
                <span className="truncate">{r.category ? translateCategory(r.category, t) : '—'}</span>
              </Badge>
            ),
          },
          {
            header: t('total'),
            className: 'w-14 text-center shrink-0',
            align: 'center',
            cell: (r) => <span dir="ltr">{safe(r.count).toLocaleString()}</span>,
          },
          {
            header: t('completionRate'),
            className: 'w-16 text-center shrink-0',
            align: 'center',
            cell: (r) => (
              <span dir="ltr" className="text-emerald-700 dark:text-emerald-400 font-semibold">
                {safe(r.completionRate).toFixed(0)}%
              </span>
            ),
          },
          {
            header: t('avgWaitTime'),
            className: 'w-16 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <span dir="ltr">{r.avgWaitMinutes === null ? '—' : safe(r.avgWaitMinutes).toFixed(1)}</span>,
          },
        ]}
      />
    </div>
  );
}

// ─── Compact filter select ───────────────────────────────────────────────────

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
  const { t } = useLanguage();
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
        <SelectTrigger
          className="h-9 text-xs w-full"
          aria-label={label}
        >
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
