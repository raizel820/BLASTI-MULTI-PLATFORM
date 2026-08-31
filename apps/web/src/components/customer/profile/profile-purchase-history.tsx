'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  History,
  MessageSquare,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfilePurchaseHistoryProps } from './profile-types';

export function ProfilePurchaseHistory({
  purchaseHistory,
  purchaseHistoryLoading,
  smsStatsData,
  lang,
  t,
}: ProfilePurchaseHistoryProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.22 }}
    >
      <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4 text-emerald-600" />
            {t('purchaseHistory')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {purchaseHistoryLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : purchaseHistory.length > 0 ? (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {purchaseHistory.slice(0, 5).map((item) => (
                <div
                  key={item.id}
                  className="relative flex items-center justify-between p-3 rounded-xl border border-gradient-to-r from-emerald-100/50 to-teal-100/50 dark:from-emerald-900/10 dark:to-teal-900/10 bg-white/50 dark:bg-gray-900/30"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-400 flex items-center justify-center flex-shrink-0">
                      <MessageSquare className="h-4 w-4 text-white" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{item.quantity} {t('smsPurchased')}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {(() => {
                          try {
                            const d = new Date(item.createdAt);
                            const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';
                            return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
                          } catch { return item.createdAt; }
                        })()}
                      </p>
                    </div>
                  </div>
                  <div className="text-end">
                    <p className="text-sm font-bold text-foreground">{item.price} {t('currency')}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6">{t('noPurchases')}</p>
          )}
          {smsStatsData.totalPurchased > 0 && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-lg bg-gradient-to-br from-emerald-50/80 to-teal-50/80 dark:from-emerald-900/10 dark:to-teal-900/10">
                  <p className="text-[10px] text-muted-foreground">{t('totalPurchased')}</p>
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{smsStatsData.totalPurchased}</p>
                </div>
                <div className="p-2.5 rounded-lg bg-gradient-to-br from-amber-50/80 to-orange-50/80 dark:from-amber-900/10 dark:to-orange-900/10">
                  <p className="text-[10px] text-muted-foreground">{t('totalSpent')}</p>
                  <p className="text-sm font-bold text-amber-700 dark:text-amber-400">{smsStatsData.totalSpent} {t('currency')}</p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
