'use client';

// ─── Task 54-b: Security & Audit section (doc-2 §5.1, aggregates only) ───────
// GET /api/admin/analytics/security-audit — event/actor totals, top actions,
// events by entity type. NO raw log rows (backend contract §1.14) — the raw
// entries stay in the existing Audit Logs page.

import { useLanguage } from '@/hooks/use-language';
import { Fingerprint, Info, ScrollText, ShieldCheck, UserCheck } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { translateAuditAction, translateEntityType } from '@/lib/enum-i18n';
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
import type { AdminSecurityAuditData } from './section-types';

export function SecurityAuditSection({ query, customHint }: { query: AdminSectionQuery; customHint: string }) {
  const { t } = useLanguage();
  const { data, resolved, state, refresh, isQueryReady } = useAdminSectionData<AdminSecurityAuditData>(
    'security-audit',
    query,
    { isEmpty: (d) => (d.totals?.eventsInPeriod ?? 0) === 0 },
  );
  const windowLabel = useResolvedWindowLabel()(resolved);

  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint={customHint} />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const totals = data.totals;

  const actionData = (data.topActions ?? []).slice(0, 10).map((a) => ({
    action: translateAuditAction(a.action, t),
    count: safe(a.count),
  }));
  const hasActions = actionData.some((d) => d.count > 0);
  const maxVal = actionData.reduce((m, d) => Math.max(m, d.count), 0);

  const ActionTooltip = (props: { active?: boolean; label?: string | number; payload?: Array<{ value?: number | string }> }) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    return (
      <ChartTooltipBox>
        <p className="font-bold text-foreground max-w-56 truncate">{String(props.label ?? '')}</p>
        <p className="text-muted-foreground">
          {t(ak('adminAnalytics.audit.events'))}:{' '}
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
            icon: ShieldCheck,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('adminAnalytics.audit.events')),
            value: safe(totals.eventsInPeriod),
          },
          {
            icon: UserCheck,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('adminAnalytics.audit.actors')),
            value: safe(totals.distinctActors),
          },
        ]}
      />

      <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground leading-relaxed">
        <Info className="h-3 w-3 mt-0.5 shrink-0" />
        {t(ak('adminAnalytics.audit.note'))}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 min-w-0">
          <ChartCard
            title={t(ak('adminAnalytics.audit.topActions'))}
            icon={Fingerprint}
            iconClass="from-emerald-500 to-teal-600"
            heightClass="h-64 sm:h-72"
            empty={!hasActions}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={actionData} layout="vertical" margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} stroke="rgba(128,128,128,0.4)" allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="action"
                  tick={{ fontSize: 10 }}
                  stroke="rgba(128,128,128,0.4)"
                  width={130}
                  tickLine={false}
                />
                <Tooltip content={<ActionTooltip />} cursor={{ fill: 'rgba(16,185,129,0.08)' }} />
                <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={20} isAnimationActive={false}>
                  {actionData.map((d, i) => (
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
        </div>
        <CountListPanel
          title={t(ak('adminAnalytics.audit.byEntity'))}
          icon={ScrollText}
          iconClass="from-teal-500 to-cyan-600"
          rows={Object.entries(data.byEntityType ?? {})
            .map(([entity, count]) => ({ label: translateEntityType(entity, t), count: safe(count) }))
            .sort((a, b) => b.count - a.count)}
        />
      </div>
    </div>
  );
}
