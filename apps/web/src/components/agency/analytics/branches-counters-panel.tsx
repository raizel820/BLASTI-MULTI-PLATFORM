'use client';

// ─── Task 42-e: branches comparison + counters table (tabs) ─────────────────
// Tabs: 'branches' — per-branch volume bars with no-show rate + avg wait;
//       'counters' — table of the top 12 counters (served, avg service, branch).

import { useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Building2, MonitorSpeaker } from 'lucide-react';
import { ak } from './i18n-keys';
import type { AnalyticsBranchRow, AnalyticsCounterRow } from './types';

function rateChipClass(rate: number): string {
  if (rate < 5) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
  if (rate < 15) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400';
}

export function BranchesCountersPanel({
  branches,
  counters,
}: {
  branches: AnalyticsBranchRow[];
  counters: AnalyticsCounterRow[];
}) {
  const { t } = useLanguage();
  const [tab, setTab] = useState('branches');

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const branchRows = [...(branches ?? [])].sort((a, b) => safe(b.count) - safe(a.count));
  const maxBranchCount = branchRows.reduce((m, b) => Math.max(m, safe(b.count)), 0);
  const counterRows = [...(counters ?? [])].sort((a, b) => safe(b.served) - safe(a.served));

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <Tabs value={tab} onValueChange={setTab}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0">
                <Building2 className="h-4 w-4 text-white" />
              </div>
              <CardTitle className="text-sm font-semibold">
                {tab === 'branches' ? t(ak('analyticsSection.branches.title')) : t(ak('analyticsSection.counters.title'))}
              </CardTitle>
            </div>
            <TabsList className="h-8">
              <TabsTrigger value="branches" className="text-xs px-2.5 h-7">{t('branches')}</TabsTrigger>
              <TabsTrigger value="counters" className="text-xs px-2.5 h-7">{t('counters')}</TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {/* Branch comparison */}
          <TabsContent value="branches" className="mt-0">
            {branchRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                <Building2 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                <p className="text-sm">{t('noDataYet')}</p>
              </div>
            ) : (
              <ScrollArea className="h-72 custom-scrollbar">
                <div className="space-y-2.5 pe-2">
                  {branchRows.map((b) => {
                    const count = safe(b.count);
                    const width = maxBranchCount > 0 ? Math.max((count / maxBranchCount) * 100, 4) : 0;
                    return (
                      <div key={b.branchId} className="rounded-xl border border-border/60 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-foreground truncate" title={b.name}>
                            {b.name}
                          </span>
                          <span className="text-[11px] font-bold text-foreground shrink-0 tabular-nums" dir="ltr">
                            {count.toLocaleString()}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 rounded-full bg-muted/60 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500"
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${rateChipClass(safe(b.noShowRate))}`}>
                            {t('noShowRate')} · <span dir="ltr">{safe(b.noShowRate).toFixed(1)}%</span>
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {t('avgWaitTime')}:{' '}
                            <span className="font-bold text-foreground" dir="ltr">
                              {b.avgWaitMinutes === null ? '—' : `${Math.round(safe(b.avgWaitMinutes))} ${t('min')}`}
                            </span>
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {t('completed')}: <span className="font-bold text-foreground" dir="ltr">{safe(b.completed).toLocaleString()}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          {/* Counters table */}
          <TabsContent value="counters" className="mt-0">
            {counterRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
                <MonitorSpeaker className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
                <p className="text-sm">{t('noDataYet')}</p>
              </div>
            ) : (
              <ScrollArea className="h-72 custom-scrollbar">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-start h-8 text-[11px]">{t('name')}</TableHead>
                      <TableHead className="text-start h-8 text-[11px]">{t('branches')}</TableHead>
                      <TableHead className="text-center h-8 text-[11px]">{t('served')}</TableHead>
                      <TableHead className="text-end h-8 text-[11px]">{t('avgServiceTime')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {counterRows.map((c) => (
                      <TableRow key={c.counterId}>
                        <TableCell className="py-2 text-xs font-semibold text-foreground max-w-[120px] truncate">{c.name}</TableCell>
                        <TableCell className="py-2 text-xs text-muted-foreground max-w-[110px] truncate">{c.branchName}</TableCell>
                        <TableCell className="py-2 text-center text-xs font-bold text-foreground tabular-nums" dir="ltr">
                          {safe(c.served).toLocaleString()}
                        </TableCell>
                        <TableCell className="py-2 text-end text-xs text-muted-foreground tabular-nums" dir="ltr">
                          {c.avgServiceMinutes === null ? '—' : `${Math.round(safe(c.avgServiceMinutes))} ${t('min')}`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            )}
          </TabsContent>
        </CardContent>
      </Tabs>
    </Card>
  );
}
