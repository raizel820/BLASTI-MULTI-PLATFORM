'use client';

// ─── Task 54-b: Devices section (doc-2 §5.1 hardware subset) ─────────────────
// GET /api/admin/analytics/devices — agency devices (status/type/connection,
// uptime) + customer devices (platform split).

import { useLanguage } from '@/hooks/use-language';
import { Monitor, MonitorSmartphone, Power, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { humanizeEnum } from '@/lib/enum-i18n';
import {
  CountListPanel,
  SectionStatePanels,
  StatTiles,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminDevicesData } from './section-types';

export function DevicesSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminDevicesData>('devices', query, {
    isEmpty: (d) => (d.agencyDevices?.total ?? 0) === 0 && (d.customerDevices?.total ?? 0) === 0,
  });
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const agency = data.agencyDevices;
  const customer = data.customerDevices;
  const uptimeHours = safe(agency.totalUptimeSec) / 3600;

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}
      <StatTiles
        items={[
          {
            icon: MonitorSmartphone,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.devices.agencyTotal')),
            value: safe(agency.total),
          },
          {
            icon: Wifi,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.devices.online')),
            value: safe(agency.online),
          },
          {
            icon: WifiOff,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t(ak('adminAnalytics.devices.offline')),
            value: safe(agency.offline),
          },
          {
            icon: Smartphone,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.devices.customerTotal')),
            value: safe(customer.total),
          },
          {
            icon: Smartphone,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.devices.customerNew')),
            value: safe(customer.newInPeriod),
          },
          {
            icon: Power,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.devices.uptime')),
            value: uptimeHours,
            decimals: 1,
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CountListPanel
          title={t(ak('adminAnalytics.devices.byType'))}
          icon={Monitor}
          iconClass="from-emerald-500 to-teal-600"
          rows={Object.entries(agency.byType ?? {})
            .map(([type, count]) => ({ label: humanizeEnum(type), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('adminAnalytics.devices.byStatus'))}
          icon={Power}
          iconClass="from-teal-500 to-cyan-600"
          rows={Object.entries(agency.byStatus ?? {})
            .map(([status, count]) => ({ label: humanizeEnum(status), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('adminAnalytics.devices.byConnection'))}
          icon={Wifi}
          iconClass="from-amber-500 to-orange-500"
          rows={Object.entries(agency.byConnection ?? {})
            .map(([connection, count]) => ({ label: humanizeEnum(connection), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CountListPanel
          title={t(ak('adminAnalytics.devices.byPlatform'))}
          icon={Smartphone}
          iconClass="from-cyan-500 to-teal-600"
          rows={Object.entries(customer.byPlatform ?? {})
            .map(([platform, count]) => ({ label: humanizeEnum(platform), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <StatTiles
          items={[
            {
              icon: Power,
              iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
              label: t(ak('adminAnalytics.devices.activeInPeriod')),
              value: safe(agency.activeInPeriod),
            },
            {
              icon: Wifi,
              iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
              label: t(ak('adminAnalytics.devices.heartbeat')),
              value: safe(agency.onlineByHeartbeat15m),
            },
            {
              icon: Smartphone,
              iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
              label: t(ak('adminAnalytics.devices.activeLast7d')),
              value: safe(customer.activeLast7d),
            },
          ]}
        />
      </div>
    </div>
  );
}
