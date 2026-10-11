'use client';

// ─── Task 54-b: SMS + Notifications sections (doc-2 §5.1) ────────────────────
// GET /api/admin/analytics/sms        — messages, purchases, provider state.
// GET /api/admin/analytics/notifications — sent/unread totals + by-type chart.

import { useLanguage } from '@/hooks/use-language';
import { Bell, BellRing, MessageSquare, Send, ShoppingCart, Smartphone, ToggleLeft, ToggleRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { humanizeEnum, translateStatus } from '@/lib/enum-i18n';
import {
  ChartCard,
  ChartTooltipBox,
  CountListPanel,
  SectionStatePanels,
  StatTiles,
  useResolvedWindowLabel,
} from './section-ui';
import { useAdminSectionData, type AdminSectionQuery } from './use-admin-section-data';
import { ak } from './i18n-keys';
import type { AdminNotificationsData, AdminSmsData } from './section-types';

// ─── SMS ─────────────────────────────────────────────────────────────────────

export function SmsSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminSmsData>('sms', query, {
    isEmpty: (d) => (d.messages?.sentInPeriod ?? 0) === 0 && (d.purchases?.count ?? 0) === 0,
  });
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const messages = data.messages;
  const purchases = data.purchases;

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}
      <StatTiles
        items={[
          {
            icon: Send,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.sms.sent')),
            value: safe(messages.sentInPeriod),
          },
          {
            icon: MessageSquare,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t('statusDelivered'),
            value: safe(messages.delivered),
          },
          {
            icon: MessageSquare,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusFailed'),
            value: safe(messages.failed),
          },
          {
            icon: ShoppingCart,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('adminAnalytics.sms.units')),
            value: safe(purchases.units),
          },
          {
            icon: Smartphone,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.sms.purchaseValue')),
            value: safe(purchases.value),
          },
        ]}
      />

      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-foreground">{t(ak('adminAnalytics.sms.provider'))}:</span>
        {data.provider?.enabled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 px-2 py-0.5 text-[11px] font-semibold">
            <ToggleRight className="h-3.5 w-3.5" />
            {t(ak('adminAnalytics.sms.providerEnabled'))}
            {data.provider.provider ? ` · ${data.provider.provider}` : ''}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 text-muted-foreground px-2 py-0.5 text-[11px] font-semibold">
            <ToggleLeft className="h-3.5 w-3.5" />
            {t(ak('adminAnalytics.sms.providerDisabled'))}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CountListPanel
          title={t(ak('adminAnalytics.sms.byStatus'))}
          icon={Send}
          iconClass="from-emerald-500 to-teal-600"
          rows={Object.entries(messages.byStatus ?? {})
            .map(([status, count]) => ({ label: translateStatus(status, t), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
        <CountListPanel
          title={t(ak('adminAnalytics.sms.purchaseStatus'))}
          icon={ShoppingCart}
          iconClass="from-amber-500 to-orange-500"
          rows={Object.entries(purchases.byStatus ?? {})
            .map(([status, count]) => ({ label: humanizeEnum(status), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>
    </div>
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

export function NotificationsSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminNotificationsData>(
    'notifications',
    query,
    { isEmpty: (d) => (d.totals?.countInPeriod ?? 0) === 0 && (d.totals?.totalAllTime ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;

  const typeData = Object.entries(data.byType ?? {})
    .map(([type, count]) => ({ type: humanizeEnum(type), count: safe(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const hasTypes = typeData.some((d) => d.count > 0);
  const maxVal = typeData.reduce((m, d) => Math.max(m, d.count), 0);

  const TypeTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground max-w-48 truncate">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.table.count'))}:{' '}
          <span className="font-bold text-foreground">{Number(props.payload[0]?.value ?? 0).toLocaleString()}</span>
        </p>
      </ChartTooltipBox>
    );
  };

  return (
    <div className="space-y-4">
      {windowLabel && <p className="text-[10px] text-muted-foreground">{windowLabel}</p>}
      <StatTiles
        items={[
          {
            icon: Bell,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.notif.inPeriod')),
            value: safe(totals.countInPeriod),
          },
          {
            icon: BellRing,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('adminAnalytics.notif.unread')),
            value: safe(totals.unreadInPeriod),
          },
          {
            icon: Bell,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.notif.allTime')),
            value: safe(totals.totalAllTime),
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title={t(ak('adminAnalytics.notif.byType'))}
          icon={Bell}
          iconClass="from-emerald-500 to-teal-600"
          heightClass="h-64 sm:h-72"
          empty={!hasTypes}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={typeData} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="type"
                tick={{ fontSize: 10 }}
                stroke="rgba(128,128,128,0.4)"
                width={120}
                tickLine={false}
              />
              <Tooltip content={<TypeTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
              <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={20} isAnimationActive={false}>
                {typeData.map((d, i) => (
                  <Cell
                    key={i}
                    fill={['#10b981', '#14b8a6', '#06b6d4', '#f59e0b'][i % 4]}
                    fillOpacity={d.count === maxVal ? 0.95 : 0.7}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <CountListPanel
          title={t(ak('adminAnalytics.notif.byType'))}
          icon={BellRing}
          iconClass="from-teal-500 to-cyan-600"
          rows={typeData.map((d) => ({ label: d.type, count: d.count }))}
        />
      </div>
    </div>
  );
}
