'use client';

// ─── Task 42-e: ratings panel ───────────────────────────────────────────────
// Average rating + 1-5 star distribution bars + total count (contract shape:
// ratings.distribution[{stars,count}], ratings.average, ratings.count).

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Star, MessagesSquare } from 'lucide-react';
import { ak } from './i18n-keys';
import type { AnalyticsRatings } from './types';

const STAR_BAR_COLORS: Record<number, string> = {
  5: 'from-amber-400 to-yellow-500',
  4: 'from-amber-400/85 to-yellow-500/85',
  3: 'from-yellow-400/70 to-amber-400/70',
  2: 'from-orange-400/60 to-amber-400/60',
  1: 'from-rose-400/60 to-orange-400/60',
};

export function RatingsPanel({ ratings }: { ratings: AnalyticsRatings | null }) {
  const { t } = useLanguage();

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const distribution = ratings?.distribution ?? [];
  const average = ratings?.average ?? null;
  const count = safe(ratings?.count ?? distribution.reduce((s, r) => s + safe(r.count), 0));

  const hasData = count > 0 && distribution.some((r) => safe(r.count) > 0);
  const maxCount = distribution.reduce((m, r) => Math.max(m, safe(r.count)), 0) || 1;

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center shrink-0">
            <Star className="h-4 w-4 text-white fill-white" />
          </div>
          <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.ratings.title'))}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <MessagesSquare className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            {/* Average + count */}
            <div className="flex items-center gap-3 mb-3">
              <div className="text-center">
                <p className="text-2xl font-extrabold text-foreground leading-none" dir="ltr">
                  {average === null ? '—' : average.toFixed(1)}
                </p>
                <div className="flex gap-0.5 mt-1 justify-center" dir="ltr">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`h-3 w-3 ${
                        average !== null && star <= Math.round(average)
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-gray-200 dark:text-gray-700'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <div className="h-10 w-px bg-gray-200 dark:bg-gray-700" />
              <div>
                <p className="text-xl font-bold text-foreground leading-none" dir="ltr">{count.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('totalRatings')}</p>
              </div>
            </div>

            {/* 5 → 1 distribution bars */}
            <div className="space-y-1.5">
              {[5, 4, 3, 2, 1].map((star) => {
                const item = distribution.find((r) => r.stars === star);
                const starCount = safe(item?.count);
                const pct = starCount > 0 ? (starCount / maxCount) * 100 : 0;
                const share = count > 0 ? Math.round((starCount / count) * 100) : 0;
                return (
                  <div key={star} className="flex items-center gap-2">
                    <div className="flex items-center gap-0.5 w-8 shrink-0" dir="ltr">
                      <span className="text-xs font-semibold text-foreground">{star}</span>
                      <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                    </div>
                    <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full bg-gradient-to-r ${STAR_BAR_COLORS[star]}`}
                        style={{ width: `${Math.max(pct, starCount > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-medium text-muted-foreground w-14 text-end tabular-nums shrink-0" dir="ltr">
                      {starCount.toLocaleString()} · {share}%
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
