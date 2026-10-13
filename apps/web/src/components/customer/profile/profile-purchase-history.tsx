'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertOctagon,
  CheckCircle2,
  Clock,
  History,
  MessageSquare,
  XCircle,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import type { TranslationKeys } from '@/i18n';
import type { ProfilePurchaseHistoryProps } from './profile-types';

// Task 2-b — color-coded purchase status chips (same pattern as customer-history.tsx statusChipConfig):
// emerald + check for APPROVED, amber + clock for PENDING, rose + x/octagon for REJECTED/FAILED
const purchaseStatusChipConfig: Record<string, { chip: string; icon: typeof CheckCircle2; labelKey: TranslationKeys }> = {
  APPROVED: { chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-400', icon: CheckCircle2, labelKey: 'purchaseStatusApproved' },
  PENDING: { chip: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-400', icon: Clock, labelKey: 'purchaseStatusPending' },
  REJECTED: { chip: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-400', icon: XCircle, labelKey: 'purchaseStatusRejected' },
  FAILED: { chip: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/20 dark:border-rose-800 dark:text-rose-400', icon: AlertOctagon, labelKey: 'purchaseStatusFailed' },
};

type PurchaseFilter = 'ALL' | 'SUCCESS' | 'PENDING' | 'FAILED';

// Filter tabs — 'Success' = APPROVED; 'Failed' covers FAILED + REJECTED transactions
const purchaseFilters: { key: PurchaseFilter; statuses: string[] | null; labelKey: TranslationKeys }[] = [
  { key: 'ALL', statuses: null, labelKey: 'purchaseFilterAll' },
  { key: 'SUCCESS', statuses: ['APPROVED'], labelKey: 'purchaseFilterSuccess' },
  { key: 'PENDING', statuses: ['PENDING'], labelKey: 'purchaseFilterPending' },
  { key: 'FAILED', statuses: ['FAILED', 'REJECTED'], labelKey: 'purchaseFilterFailed' },
];

export function ProfilePurchaseHistory({
  purchaseHistory,
  purchaseHistoryLoading,
  smsStatsData,
  lang,
  t,
}: ProfilePurchaseHistoryProps) {
  const [filter, setFilter] = useState<PurchaseFilter>('ALL');
  const activeFilter = purchaseFilters.find((f) => f.key === filter) ?? purchaseFilters[0];
  const filteredHistory = activeFilter.statuses
    ? purchaseHistory.filter((item) => activeFilter.statuses!.includes(item.status))
    : purchaseHistory;

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
            <>
              {/* Status filter: All / Success / Pending / Failed */}
              <div className="flex items-center gap-1.5 mb-2">
                {purchaseFilters.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFilter(f.key)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                      filter === f.key
                        ? 'bg-emerald-600 text-white border-emerald-600 dark:bg-emerald-500 dark:border-emerald-500'
                        : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                    }`}
                  >
                    {t(f.labelKey)}
                  </button>
                ))}
              </div>
              {filteredHistory.length > 0 ? (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {filteredHistory.slice(0, 5).map((item) => {
                    const chip = purchaseStatusChipConfig[item.status] ?? purchaseStatusChipConfig.PENDING;
                    const ChipIcon = chip.icon;
                    return (
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
                        <div className="flex flex-col items-end gap-1">
                          <p className="text-sm font-bold text-foreground">{item.price} {t('currency')}</p>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${chip.chip}`}>
                            <ChipIcon className="h-2.5 w-2.5" />
                            {t(chip.labelKey)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-6">{t('purchaseNoResults')}</p>
              )}
            </>
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
              {/* Task 2-b: pending purchases awaiting approval */}
              {smsStatsData.pendingCount > 0 && (
                <div className="mt-2 flex items-center justify-center gap-1.5 p-2 rounded-lg bg-gradient-to-br from-amber-50/80 to-orange-50/80 dark:from-amber-900/10 dark:to-orange-900/10">
                  <Clock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                    {t('purchasePendingCount', { count: String(smsStatsData.pendingCount) })}
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
