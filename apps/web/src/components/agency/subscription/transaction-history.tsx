'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/hooks/use-language';
import {
  CheckCircle2,
  Clock,
  X,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { Transaction } from './types';

interface TransactionHistoryProps {
  transactions: Transaction[];
  formatDate: (dateStr: string) => string;
  getPlanName: (plan: string) => string;
  getPaymentMethodLabel: (method: string) => string;
}

export function TransactionHistory({
  transactions,
  formatDate,
  getPlanName,
  getPaymentMethodLabel,
}: TransactionHistoryProps) {
  const { t } = useLanguage();

  if (!transactions || transactions.length === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-emerald-600" />
            {t('transactions')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {transactions.map((tx) => {
              const isApproved = tx.status === 'APPROVED';
              const isPending = tx.status === 'PENDING';

              return (
                <motion.div
                  key={tx.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-3 p-3.5 rounded-xl bg-gray-50 dark:bg-gray-900/50 border border-border/30"
                >
                  {/* Status icon */}
                  <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    isApproved
                      ? 'bg-emerald-100 dark:bg-emerald-900/30'
                      : isPending
                        ? 'bg-amber-100 dark:bg-amber-900/30'
                        : 'bg-red-100 dark:bg-red-900/30'
                  }`}>
                    {isApproved ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    ) : isPending ? (
                      <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                    ) : (
                      <X className="h-5 w-5 text-red-600 dark:text-red-400" />
                    )}
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{getPlanName(tx.plan)}</p>
                      <Badge
                        variant="outline"
                        className={
                          isApproved
                            ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                            : isPending
                              ? 'text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200'
                              : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                        }
                      >
                        {isApproved ? t('approved') : isPending ? t('pending') : t('rejected')}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(tx.createdAt)} &middot; {getPaymentMethodLabel(tx.method)}
                    </p>
                  </div>

                  {/* Amount */}
                  <div className="text-end flex-shrink-0">
                    <p className="text-sm font-bold text-foreground">{tx.amount} {t('currency')}</p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
