'use client';

// ─── Task 54-c: Hardware & Devices section (doc-2 §27) ───────────────────────
// GET /api/agency/analytics/devices — ONLY this agency's devices: online /
// offline split, status / type / connection distributions, per-device
// heartbeat + hardware orders placed in the period.

import { useLanguage } from '@/hooks/use-language';
import { Monitor, MonitorSmartphone, Radio, Wifi, WifiOff } from 'lucide-react';
import { getLocale } from '@/components/agency/dashboard/helpers';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  SectionTablePanel,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { OwnerDevicesData } from './section-types';
import { useOwnerSectionData, type OwnerSectionQuery } from './use-owner-section-data';

export function OwnerDevicesSection({ query, customHint }: { query: OwnerSectionQuery; customHint: string }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useOwnerSectionData<OwnerDevicesData>(
    'devices',
    query,
    // No devices at all → empty state (the hardware-orders block alone is not
    // worth a full page render).
    { isEmpty: (d) => (d.totals?.devices ?? 0) === 0 && (d.devices?.length ?? 0) === 0 },
  );

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;

  const typeData = Object.entries(data.byType ?? {}).map(([type, count]) => ({ type, count: safe(count) }));
  const hasTypeChart = typeData.some((p) => p.count > 0);

  const TypeTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('ownerAnalytics.devices.count'))}: <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  const uptimeHours = safe(totals.totalUptimeSec) / 3600;

  const heartbeatLabel = (iso: string | null): string => {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat(getLocale(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch {
      return iso.slice(0, 16).replace('T', ' ');
    }
  };

  return (
    <div className="space-y-4">
      <StatTiles
        items={[
          {
            icon: MonitorSmartphone,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('ownerAnalytics.devices.total')),
            value: safe(totals.devices),
          },
          {
            icon: Wifi,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.devices.online')),
            value: safe(totals.online),
          },
          {
            icon: WifiOff,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.devices.offline')),
            value: safe(totals.offline),
          },
          {
            icon: Radio,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.devices.uptime')),
            value: uptimeHours,
            decimals: 1,
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title={t(ak('adminAnalytics.devices.byType'))}
          icon={Monitor}
          iconClass="from-emerald-500 to-teal-600"
          empty={!hasTypeChart}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={typeData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis dataKey="type" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" tickLine={false} />
              <YAxis tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" width={30} allowDecimals={false} />
              <Tooltip content={<TypeTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
              <Bar dataKey="count" fill="#10b981" radius={[3, 3, 0, 0]} maxBarSize={34} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <CountListPanel
          title={t(ak('adminAnalytics.devices.byStatus'))}
          icon={MonitorSmartphone}
          iconClass="from-teal-500 to-cyan-600"
          rows={Object.entries(data.byStatus ?? {})
            .map(([status, count]) => ({ label: status, count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      <SectionTablePanel
        title={t(ak('ownerAnalytics.devices.list'))}
        icon={MonitorSmartphone}
        iconClass="from-cyan-500 to-teal-600"
        rows={data.devices ?? []}
        getKey={(r) => r.id}
        columns={[
          {
            header: t(ak('adminAnalytics.table.name')),
            className: 'flex-1 min-w-0',
            cell: (r) => (
              <span className="font-bold truncate block" title={r.name}>
                {r.name}
                {r.offlineCapable && (
                  <Badge variant="secondary" className="text-[9px] h-4 px-1 ms-1.5 align-middle">
                    {t(ak('ownerAnalytics.devices.offlineCapable'))}
                  </Badge>
                )}
              </span>
            ),
          },
          {
            header: t(ak('ownerAnalytics.devices.type')),
            className: 'w-16 text-center shrink-0 hidden sm:block',
            align: 'center',
            cell: (r) => <Badge variant="secondary" className="text-[10px] h-5">{r.type}</Badge>,
          },
          {
            header: t(ak('ownerAnalytics.devices.status')),
            className: 'w-24 text-center shrink-0',
            align: 'center',
            cell: (r) => (
              <Badge
                className={`text-[10px] h-5 ${
                  r.status === 'ONLINE'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                }`}
              >
                {r.status}
              </Badge>
            ),
          },
          {
            header: t(ak('ownerAnalytics.devices.lastHeartbeat')),
            className: 'w-32 text-center shrink-0 hidden md:block',
            align: 'center',
            cell: (r) => <span dir="ltr" className="text-muted-foreground">{heartbeatLabel(r.lastHeartbeatAt)}</span>,
          },
        ]}
      />
    </div>
  );
}
