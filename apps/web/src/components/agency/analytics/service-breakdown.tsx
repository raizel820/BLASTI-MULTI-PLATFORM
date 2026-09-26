'use client';

// ─── Task 42-e: per-service breakdown ───────────────────────────────────────
// Sorted desc by reservation count; each row shows the count, a completion
// rate Progress bar and the average wait. ScrollArea caps the height with the
// app's emerald custom scrollbar.

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Layers } from 'lucide-react';
import { ak } from './i18n-keys';
import type { AnalyticsServiceRow } from './types';

export function ServiceBreakdown({ services }: { services: AnalyticsServiceRow[] }) {
  const { t } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const rows = [...(services ?? [])].sort((a, b) => safe(b.count) - safe(a.count));

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shrink-0">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.services.title'))}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <Layers className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            {/* Column captions */}
            <div className="flex items-center gap-2 px-0.5 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              <span className="flex-1 truncate">{t('name')}</span>
              <span className="w-12 text-center">{t('total')}</span>
              <span className="w-28 text-center hidden sm:block">{t('completionRate')}</span>
              <span className="w-16 text-end">{t('avgWaitTime')}</span>
            </div>
            <ScrollArea className="h-72 custom-scrollbar">
              <div className="divide-y divide-border/60 pe-2">
                {rows.map((s) => {
                  const count = safe(s.count);
                  const rate = safe(s.completionRate);
                  const wait = s.avgWaitMinutes;
                  return (
                    <div key={s.serviceId} className="py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 text-xs font-semibold text-foreground truncate" title={s.name}>
                          {s.name}
                        </span>
                        <Badge variant="secondary" className="w-12 justify-center text-[10px] px-1 h-5 shrink-0" title={t('totalReservations')}>
                          {count.toLocaleString()}
                        </Badge>
                        <div className="w-28 hidden sm:flex items-center gap-1.5 shrink-0">
                          <Progress value={rate} className="h-1.5 flex-1" aria-label={t('completionRate')} />
                          <span className="text-[10px] font-bold text-muted-foreground w-8 text-end tabular-nums" dir="ltr">
                            {Math.round(rate)}%
                          </span>
                        </div>
                        <span className="w-16 text-end text-[10px] font-medium text-muted-foreground tabular-nums shrink-0" dir="ltr">
                          {wait === null ? '—' : `${Math.round(wait)} ${t('min')}`}
                        </span>
                      </div>
                      {/* Completion progress inline for narrow screens */}
                      <div className="sm:hidden mt-1.5 flex items-center gap-1.5">
                        <Progress value={rate} className="h-1 flex-1" aria-label={t('completionRate')} />
                        <span className="text-[10px] font-bold text-muted-foreground w-8 text-end tabular-nums" dir="ltr">
                          {Math.round(rate)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </CardContent>
    </Card>
  );
}
