'use client';

// ─── Task 42-e: status distribution donut ───────────────────────────────────
// Donut (PieChart) of the 6 reservation statuses. Colors mirror the app's
// status conventions (WAITING amber · COMPLETED emerald · CANCELLED red) with
// the blue/indigo slots remapped into the teal/cyan secondary accents —
// see ANALYTICS_STATUS_META in types.ts. The contract guarantees all 6
// statuses are always present.

import { useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PieChart } from 'lucide-react';
import { PieChart as RePieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { ak } from './i18n-keys';
import { ANALYTICS_STATUS_META, type AnalyticsStatusDistributionItem } from './types';

interface StatusDonutDatum {
  status: string;
  count: number;
  label: string;
  color: string;
}

interface StatusTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: StatusDonutDatum }>;
}

function StatusTooltip({ active, payload }: StatusTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="rounded-xl border border-border/60 bg-white/95 dark:bg-gray-900/95 px-3 py-1.5 shadow-lg backdrop-blur-sm text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
        <span className="text-muted-foreground">{d.label}:</span>
        <span className="font-bold text-foreground">{d.count.toLocaleString()}</span>
      </span>
    </div>
  );
}

export function StatusDistributionChart({ statusDistribution }: { statusDistribution: AnalyticsStatusDistributionItem[] }) {
  const { t } = useLanguage();

  const data = useMemo<StatusDonutDatum[]>(
    () =>
      (statusDistribution ?? [])
        .map((s) => {
          const meta = ANALYTICS_STATUS_META[s.status] ?? { color: '#94a3b8', labelKey: 'statusWaiting' };
          return {
            status: s.status,
            count: Number.isFinite(s.count) ? s.count : 0,
            label: t(ak(meta.labelKey)),
            color: meta.color,
          };
        })
        .filter((d) => d.count > 0),
    [statusDistribution, t]
  );

  const hasData = data.some((d) => d.count > 0);
  const sum = data.reduce((acc, d) => acc + d.count, 0);

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-400 to-rose-500 flex items-center justify-center shrink-0">
            <PieChart className="h-4 w-4 text-white" />
          </div>
          <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.status.title'))}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <PieChart className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="relative w-full max-w-[240px] aspect-square">
              <div className="h-full" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <RePieChart>
                    <Tooltip content={<StatusTooltip />} />
                    <Pie
                      data={data}
                      dataKey="count"
                      nameKey="status"
                      innerRadius="62%"
                      outerRadius="92%"
                      paddingAngle={2}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {data.map((d) => (
                        <Cell key={d.status} fill={d.color} />
                      ))}
                    </Pie>
                  </RePieChart>
                </ResponsiveContainer>
              </div>
              {/* Center total */}
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <p className="text-2xl font-black text-foreground leading-none">{sum.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{t('total')}</p>
              </div>
            </div>

            {/* Legend with counts + share */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 w-full">
              {data.map((d) => (
                <div key={d.status} className="flex items-center gap-1.5 min-w-0">
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: d.color }} />
                  <span className="text-[11px] text-muted-foreground truncate flex-1">{d.label}</span>
                  <span className="text-[11px] font-bold text-foreground shrink-0" dir="ltr">
                    {d.count.toLocaleString()}
                    <span className="text-muted-foreground font-medium"> · {sum > 0 ? Math.round((d.count / sum) * 100) : 0}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
