'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart3, Clock, Heart, CalendarDays } from 'lucide-react';
import { motion } from 'framer-motion';
import type { TranslationKeys } from '@/i18n';

interface QueueStats {
  totalQueues: number;
  thisMonth: number;
  avgWaitTime: number;
  favoriteAgency: { name: string; nameAr?: string; nameFr?: string } | null;
}

interface ProfileStatsProps {
  queueStats: QueueStats | null;
  statsLoading: boolean;
  lang: string;
  t: (key: TranslationKeys) => string;
}

export function ProfileStats({ queueStats, statsLoading, lang, t }: ProfileStatsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 }}
    >
      <Card className="border-0 shadow-sm mb-4 overflow-hidden bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-emerald-600/5 backdrop-blur-xl dark:from-emerald-900/20 dark:via-teal-900/20 dark:to-emerald-800/10 border border-emerald-200/30 dark:border-emerald-700/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-emerald-600" />
            {t('myStats')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {statsLoading ? (
            <div className="grid grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-20 rounded-xl" />
              ))}
            </div>
          ) : queueStats ? (
            <div className="grid grid-cols-2 gap-3">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1 }}
                className="bg-white/60 dark:bg-gray-900/50 backdrop-blur-sm rounded-xl p-3"
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <CalendarDays className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-[10px] text-muted-foreground">{t('totalQueuesJoined')}</span>
                </div>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xl font-bold text-foreground"
                >
                  {queueStats.totalQueues}
                </motion.p>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.15 }}
                className="bg-white/60 dark:bg-gray-900/50 backdrop-blur-sm rounded-xl p-3"
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Clock className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                  <span className="text-[10px] text-muted-foreground">{t('avgWaitTimeExperienced')}</span>
                </div>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xl font-bold text-foreground"
                >
                  ~{queueStats.avgWaitTime ?? 0} {t('min')}
                </motion.p>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.2 }}
                className="bg-white/60 dark:bg-gray-900/50 backdrop-blur-sm rounded-xl p-3"
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Heart className="h-3.5 w-3.5 text-rose-500" />
                  <span className="text-[10px] text-muted-foreground">{t('favoriteAgencyStat')}</span>
                </div>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm font-bold text-foreground truncate"
                >
                  {queueStats.favoriteAgency
                    ? (lang === 'ar' && queueStats.favoriteAgency.nameAr
                        ? queueStats.favoriteAgency.nameAr
                        : lang === 'fr' && queueStats.favoriteAgency.nameFr
                          ? queueStats.favoriteAgency.nameFr
                          : queueStats.favoriteAgency.name)
                    : '—'}
                </motion.p>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.25 }}
                className="bg-white/60 dark:bg-gray-900/50 backdrop-blur-sm rounded-xl p-3"
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <BarChart3 className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-[10px] text-muted-foreground">{t('thisMonth')}</span>
                </div>
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xl font-bold text-foreground"
                >
                  {queueStats.thisMonth}
                </motion.p>
              </motion.div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
