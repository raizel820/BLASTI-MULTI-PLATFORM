'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/hooks/use-language';
import { CreditCard } from 'lucide-react';
import { motion } from 'framer-motion';
import type { AdminStats } from './types';

interface SubscriptionBreakdownProps {
  stats: AdminStats | null;
}

export function SubscriptionBreakdown({ stats }: SubscriptionBreakdownProps) {
  const { t } = useLanguage();

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.19 }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-emerald-600" />
            {t('subscriptionBreakdown' as any)}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: t('active'), count: stats?.activeQueues ?? 0, color: 'bg-emerald-500', bgLight: 'bg-emerald-50 dark:bg-emerald-900/20' },
              { label: t('pending'), count: stats?.pendingTransactions ?? 0, color: 'bg-amber-500', bgLight: 'bg-amber-50 dark:bg-amber-900/20' },
              { label: t('inactive'), count: Math.max((stats?.totalAgencies ?? 0) - (stats?.activeQueues ?? 0) - (stats?.pendingTransactions ?? 0), 0), color: 'bg-gray-400', bgLight: 'bg-gray-50 dark:bg-gray-800/30' },
            ].map((item, idx) => (
              <div key={idx} className={`p-3 rounded-xl ${item.bgLight} text-center`}>
                <div className="flex justify-center mb-2">
                  <div className={`h-3 w-3 rounded-full ${item.color}`} />
                </div>
                <p className="text-xl font-bold text-foreground">{item.count}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{item.label}</p>
              </div>
            ))}
          </div>
          {/* Visual bar */}
          <div className="mt-3 h-3 w-full rounded-full overflow-hidden flex bg-gray-100 dark:bg-gray-800">
            {(() => {
              const total = Math.max(stats?.totalAgencies ?? 1, 1);
              const active = ((stats?.activeQueues ?? 0) / total) * 100;
              const pending = ((stats?.pendingTransactions ?? 0) / total) * 100;
              const inactive = Math.max(100 - active - pending, 0);
              return (
                <>
                  <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${active}%` }} />
                  <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: `${pending}%` }} />
                  <div className="h-full bg-gray-300 dark:bg-gray-600 transition-all duration-500" style={{ width: `${inactive}%` }} />
                </>
              );
            })()}
          </div>
          <div className="flex items-center justify-center gap-4 mt-2">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> {t('active')}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-amber-500" /> {t('pending')}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" /> {t('inactive')}
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
