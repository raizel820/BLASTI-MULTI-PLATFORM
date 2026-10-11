'use client';

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Star, BarChart3 } from 'lucide-react';
import { motion } from 'framer-motion';

interface RatingData {
  rating: number;
  count: number;
}

interface RatingDistributionProps {
  ratings: RatingData[];
  averageRating?: number;
  totalRatings?: number;
}

export function RatingDistribution({ ratings, averageRating, totalRatings }: RatingDistributionProps) {
  const { t } = useLanguage();

  // No fake fallback — if ratings is empty or all-zero, we render an empty state.
  const ratingData: RatingData[] = ratings;

  const total =
    totalRatings ??
    ratingData.reduce((s, r) => s + (r.count ?? 0), 0);

  const hasRealData =
    ratingData.length > 0 && ratingData.some((r) => (r.count ?? 0) > 0);

  // If we have real ratings, compute the average from them; otherwise fall back to the prop.
  const computedAvg =
    ratingData.length > 0
      ? ratingData.reduce((s, r) => s + (r.rating ?? 0) * (r.count ?? 0), 0) /
        (ratingData.reduce((s, r) => s + (r.count ?? 0), 0) || 1)
      : 0;
  const avg = hasRealData ? computedAvg : (averageRating ?? 0);
  const maxCount = hasRealData
    ? Math.max(...ratingData.map((r) => r.count), 1)
    : 1;

  const starColors: Record<number, string> = {
    5: 'from-amber-400 to-yellow-500',
    4: 'from-amber-400/80 to-yellow-500/80',
    3: 'from-yellow-400/60 to-amber-400/60',
    2: 'from-orange-400/50 to-amber-400/50',
    1: 'from-rose-400/40 to-orange-400/40',
  };

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center">
            <Star className="h-4 w-4 text-white fill-white" />
          </div>
          <CardTitle className="text-sm font-semibold">{t('customerSatisfaction')}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasRealData ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
            <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">
              {t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}
            </p>
          </div>
        ) : (
          <>
            {/* Big average + total */}
            <div className="flex items-center gap-3 mb-3">
              <div className="text-center">
                <p className="text-2xl font-extrabold text-foreground">{avg.toFixed(1)}</p>
                <div className="flex gap-0.5 mt-0.5">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`h-3 w-3 ${
                        star <= Math.round(avg)
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-gray-200 dark:text-gray-700'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <div className="h-10 w-px bg-gray-200 dark:bg-gray-700" />
              <div>
                <p className="text-xl font-bold text-foreground">{total}</p>
                <p className="text-xs text-muted-foreground">{t('totalRatings')}</p>
              </div>
            </div>

            {/* Distribution bars */}
            <div className="space-y-1.5">
              {[5, 4, 3, 2, 1].map((star, idx) => {
                const item = ratingData.find((r) => r.rating === star);
                const count = item?.count ?? 0;
                const pct = (count / maxCount) * 100;

                return (
                  <div key={star} className="flex items-center gap-2">
                    <div className="flex items-center gap-1 w-10">
                      <span className="text-xs font-semibold text-foreground">{star}</span>
                      <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                    </div>
                    <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.max(pct, 2)}%` }}
                        transition={{ duration: 0.6, delay: idx * 0.08, ease: 'easeOut' }}
                        className={`h-full rounded-full bg-gradient-to-r ${starColors[star] ?? starColors[3]}`}
                      />
                    </div>
                    <span className="text-xs font-medium text-muted-foreground w-8 text-end">{count}</span>
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
