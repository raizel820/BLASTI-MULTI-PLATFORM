'use client';

// ─── Task 4: top agencies panel (global + average scope only) ───────────────
// Ranked agency leaderboard (top 8, sorted by reservation volume): rank badge,
// name + customCode + category badge, total with completion-rate Progress and
// an online/walk-in split chip + average rating. In 'average' scope the values
// are still each agency's global figures — a note explains that. List is
// height-capped with the app's custom scrollbar.

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Award, Globe, Info, Star, Store, Trophy } from 'lucide-react';
import { AnimatedCounter } from '@/components/agency/dashboard/helpers';
import { translateCategory } from '@/lib/enum-i18n';
import { ak } from './i18n-keys';
import type { AdminAnalyticsScope, AdminTopAgencyRow } from './types';

const MEDAL_CLASSES = [
  'bg-gradient-to-br from-amber-400 to-yellow-500 text-white shadow-sm shadow-amber-500/30',
  'bg-gradient-to-br from-teal-400 to-emerald-500 text-white shadow-sm shadow-emerald-500/30',
  'bg-gradient-to-br from-cyan-400 to-teal-500 text-white shadow-sm shadow-teal-500/30',
];

function rankClass(rank: number): string {
  if (rank <= 3) return MEDAL_CLASSES[rank - 1];
  return 'bg-muted/70 text-muted-foreground';
}

export function TopAgenciesPanel({
  rows,
  scope,
}: {
  rows: AdminTopAgencyRow[];
  scope: AdminAnalyticsScope;
}) {
  const { t } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const ranked = [...(rows ?? [])]
    .sort((a, b) => safe(b.total) - safe(a.total))
    .slice(0, 8);

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shrink-0">
            <Trophy className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{t('topAgencies')}</CardTitle>
            <p className="text-[11px] text-muted-foreground truncate">
              {t(ak('adminAnalytics.topAgencies.byReservations'))}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {scope === 'average' && ranked.length > 0 && (
          <p className="mb-2.5 flex items-start gap-1.5 text-[10px] text-muted-foreground leading-relaxed">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            {t(ak('adminAnalytics.topAgencies.averageNote'))}
          </p>
        )}

        {ranked.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <Award className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            {/* Column captions */}
            <div className="flex items-center gap-2 px-0.5 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              <span className="w-6 text-center">#</span>
              <span className="flex-1 truncate">{t(ak('adminAnalytics.topAgencies.agency'))}</span>
              <span className="w-12 text-center">{t('total')}</span>
              <span className="w-20 sm:w-28 text-center">{t(ak('adminAnalytics.topAgencies.completion'))}</span>
            </div>

            <ScrollArea className="h-[22rem] custom-scrollbar">
              <div className="divide-y divide-border/60 pe-2">
                {ranked.map((row, index) => {
                  const rank = index + 1;
                  const total = safe(row.total);
                  const completion = Math.min(100, Math.max(0, safe(row.completionRate)));
                  const onlineRate = Math.min(100, Math.max(0, safe(row.onlineRate)));
                  const walkInRate = Math.min(100, Math.max(0, safe(row.walkInRate)));
                  const rating = row.avgRating;
                  return (
                    <div key={row.agencyId} className="py-2.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 ${rankClass(rank)}`}
                          aria-label={t(ak('adminAnalytics.topAgencies.rank')) + ' ' + rank}
                        >
                          {rank}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-foreground truncate" title={row.name}>
                            {row.name}
                            {row.customCode && (
                              <span className="ms-1.5 text-[9px] font-mono text-muted-foreground" dir="ltr">
                                {row.customCode}
                              </span>
                            )}
                          </p>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {row.category && (
                              <Badge variant="secondary" className="text-[9px] px-1.5 h-4 font-medium max-w-32">
                                <span className="truncate">{translateCategory(row.category, t)}</span>
                              </Badge>
                            )}
                            {/* Online / walk-in split chip */}
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[9px] font-semibold"
                              title={t(ak('adminAnalytics.topAgencies.split'))}
                            >
                              <Globe className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" />
                              <span className="text-emerald-700 dark:text-emerald-400" dir="ltr">
                                {onlineRate.toFixed(0)}%
                              </span>
                              <span className="text-muted-foreground/60">/</span>
                              <Store className="h-2.5 w-2.5 text-amber-600 dark:text-amber-400" />
                              <span className="text-amber-700 dark:text-amber-400" dir="ltr">
                                {walkInRate.toFixed(0)}%
                              </span>
                            </span>
                            {/* Average rating */}
                            <span
                              className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                                rating !== null
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                  : 'bg-muted/60 text-muted-foreground'
                              }`}
                              title={t(ak('adminAnalytics.topAgencies.rating'))}
                            >
                              <Star className="h-2.5 w-2.5" />
                              {rating === null ? '—' : rating.toFixed(1)}
                            </span>
                          </div>
                        </div>
                        <span className="w-12 text-center text-xs font-black text-foreground shrink-0" dir="ltr" title={t('totalReservations')}>
                          <AnimatedCounter value={total} />
                        </span>
                        <div className="w-20 sm:w-28 shrink-0" title={`${t('completionRate')}: ${completion.toFixed(1)}%`}>
                          <Progress
                            value={completion}
                            className="h-1.5"
                            aria-label={`${row.name} — ${t('completionRate')}`}
                          />
                          <p className="mt-0.5 text-[9px] text-muted-foreground text-center" dir="ltr">
                            {completion.toFixed(0)}%
                          </p>
                        </div>
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
