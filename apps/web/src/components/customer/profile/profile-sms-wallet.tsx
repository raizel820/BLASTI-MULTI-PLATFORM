'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  MessageSquare,
  CreditCard,
  Star,
  Loader2,
  Clock,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfileSmsWalletProps } from './profile-types';

const smsPacks = [
  { count: 20, price: 200 },
  { count: 50, price: 400 },
  { count: 100, price: 700 },
  { count: 200, price: 1200 },
];

export function ProfileSmsWallet({
  totalAvailable,
  purchasedSms,
  pendingCount,
  smsPurchasing,
  smsPurchasingPackId,
  onPurchaseSms,
  t,
}: ProfileSmsWalletProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
    >
      <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-emerald-600" />
            {t('smsWallet')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {/* SMS balance — the server balance IS the total spendable amount
              (purchased credits are merged into it on approval). */}
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{totalAvailable}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('totalSmsAvailable')}</p>
              </div>
              <div className="h-12 w-12 rounded-2xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
                <MessageSquare className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
            </div>
            {/* Breakdown: lifetime purchased + pending approvals */}
            <div className="grid grid-cols-2 gap-2">
              <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                <p className="text-[10px] text-muted-foreground">{t('smsPurchased')}</p>
                <p className="text-sm font-bold text-amber-700 dark:text-amber-400">{purchasedSms}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                <p className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {t('purchaseStatusPending')}
                </p>
                <p className={`text-sm font-bold ${pendingCount > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}>{pendingCount}</p>
              </div>
            </div>
          </div>
          <p className="text-sm font-medium text-foreground mb-3">{t('smsPacksTitle')}</p>
          <div className="grid grid-cols-2 gap-2">
            {smsPacks.map((pack) => {
              const packId = String(pack.count);
              const isPurchasingThisPack = smsPurchasing && smsPurchasingPackId === packId;
              const isBestValue = pack.count === 200;
              return (
                <motion.button
                  key={pack.count}
                  whileHover={{ scale: 1.04, y: -2 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => onPurchaseSms(packId)}
                  disabled={smsPurchasing}
                  className={`relative p-4 rounded-xl border text-center transition-all duration-200 hover:shadow-lg ${
                    isBestValue
                      ? 'border-emerald-300 dark:border-emerald-700 bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/20 dark:to-teal-900/20'
                      : 'border-border hover:border-emerald-300 dark:hover:border-emerald-700 bg-gradient-to-br from-emerald-50/50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10'
                  }`}
                >
                  {isBestValue && (
                    // Physical centering only (left-1/2 + -translate-x-1/2) —
                    // the previous start-1/2 + left-1/2 combo over-constrained
                    // the box in RTL and pushed the badge off the card.
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-bold shadow-lg z-10 whitespace-nowrap">
                      <Star className="h-3 w-3 fill-white inline me-0.5" />
                      {t('bestValue')}
                    </span>
                  )}
                  <div className="flex items-center justify-center mb-1.5">
                    {isPurchasingThisPack ? (
                      <Loader2 className="h-5 w-5 text-emerald-600 animate-spin" />
                    ) : (
                      <CreditCard className="h-5 w-5 text-emerald-600" />
                    )}
                  </div>
                  <p className={`font-bold text-foreground ${isBestValue ? 'text-base' : 'text-sm'}`}>{pack.count}</p>
                  <p className="text-[10px] text-muted-foreground">{pack.price} {t('currency')}</p>
                  <p className="text-[9px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('smsPackIncludes')}</p>
                </motion.button>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
