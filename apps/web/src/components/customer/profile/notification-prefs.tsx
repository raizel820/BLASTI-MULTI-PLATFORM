'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Bell,
  BellRing,
  CheckCircle2,
  Check,
  Loader2,
  Clock,
  Smartphone,
  MessageSquare,
  CreditCard,
  Star,
  History,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';

interface NotifPrefs {
  queue_called: boolean;
  turn_approaching: boolean;
  completed: boolean;
}

interface PurchaseItem {
  id: string;
  quantity: number;
  price: number;
  createdAt: string;
}

interface NotificationPrefsProps {
  userId: string;
  initialNotifPrefs: NotifPrefs;
  notifLoading: boolean;
  initialReminderMinutes: number;
  initialSmsNotifEnabled: boolean;
  initialSmsCount: number;
  initialPurchasedSms: number;
  initialPurchaseHistory: PurchaseItem[];
  initialPurchaseHistoryLoading: boolean;
  initialSmsStatsData: { totalPurchased: number; totalSpent: number };
  onSaveNotifPrefs: (prefs: NotifPrefs) => Promise<void>;
  onSaveSmsSettings: (reminderMinutes: number, smsNotifEnabled: boolean) => Promise<void>;
  onPurchaseSms: (packId: string) => Promise<{ newBalance: number } | null>;
  onRefreshProfile: () => Promise<void>;
  lang: string;
  t: (key: TranslationKeys) => string;
}

const smsPacks = [
  { count: 20, price: 200 },
  { count: 50, price: 400 },
  { count: 100, price: 700 },
  { count: 200, price: 1200 },
];

export function NotificationPrefs({
  userId,
  initialNotifPrefs,
  notifLoading,
  initialReminderMinutes,
  initialSmsNotifEnabled,
  initialSmsCount,
  initialPurchasedSms,
  initialPurchaseHistory,
  initialPurchaseHistoryLoading,
  initialSmsStatsData,
  onSaveNotifPrefs,
  onSaveSmsSettings,
  onPurchaseSms,
  onRefreshProfile,
  lang,
  t,
}: NotificationPrefsProps) {
  const [notifPrefs, setNotifPrefs] = useState<NotifPrefs>(initialNotifPrefs);
  const [notifSaving, setNotifSaving] = useState(false);

  const [reminderMinutesVal, setReminderMinutesVal] = useState(initialReminderMinutes);
  const [smsNotifEnabled, setSmsNotifEnabled] = useState(initialSmsNotifEnabled);
  const [smsSettingsSaving, setSmsSettingsSaving] = useState(false);

  const [smsCount, setSmsCount] = useState(initialSmsCount);
  const [purchasedSms, setPurchasedSms] = useState(initialPurchasedSms);
  const [smsPurchasing, setSmsPurchasing] = useState(false);
  const [smsPurchasingPackId, setSmsPurchasingPackId] = useState<string | null>(null);

  const [purchaseHistory, setPurchaseHistory] = useState<PurchaseItem[]>(initialPurchaseHistory);
  const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(initialPurchaseHistoryLoading);
  const [smsStatsData, setSmsStatsData] = useState(initialSmsStatsData);

  // Computed SMS values
  const smsRemaining = smsCount;
  const totalAvailable = smsCount + purchasedSms;
  const totalPercent = totalAvailable > 0 ? Math.min(100, (smsRemaining / totalAvailable) * 100) : 0;

  // Notification card data
  const notifCards = [
    {
      key: 'queue_called' as const,
      label: t('queueCalledNotif'),
      icon: BellRing,
      color: 'emerald' as const,
      description: t('queueCalledNotifDesc') || 'Get notified when your turn is called',
    },
    {
      key: 'turn_approaching' as const,
      label: t('turnApproachingNotif'),
      icon: Clock,
      color: 'amber' as const,
      description: t('turnApproachingNotifDesc') || 'Alert when your turn is approaching',
    },
    {
      key: 'completed' as const,
      label: t('completedNotif'),
      icon: CheckCircle2,
      color: 'teal' as const,
      description: t('completedNotifDesc') || 'Notify when service is completed',
    },
  ];

  const handleSaveNotifPrefs = async () => {
    setNotifSaving(true);
    try {
      await onSaveNotifPrefs(notifPrefs);
    } finally {
      setNotifSaving(false);
    }
  };

  const handleSaveSmsSettings = async () => {
    setSmsSettingsSaving(true);
    try {
      await onSaveSmsSettings(reminderMinutesVal, smsNotifEnabled);
    } finally {
      setSmsSettingsSaving(false);
    }
  };

  const handlePurchaseSms = async (packId: string) => {
    if (smsPurchasing) {
      toast.error(t('smsAlreadyPurchasing'));
      return;
    }
    setSmsPurchasing(true);
    setSmsPurchasingPackId(packId);
    try {
      const result = await onPurchaseSms(packId);
      if (result) {
        toast.success(`${t('smsPurchaseSuccess')} — ${t('newBalance')}: ${result.newBalance}`);
        setPurchasedSms((prev) => prev + parseInt(packId, 10));
        await onRefreshProfile();
      }
    } finally {
      setSmsPurchasing(false);
      setSmsPurchasingPackId(null);
    }
  };

  return (
    <>
      {/* Notification Preferences - Visual Toggle Cards */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="border-0 shadow-sm mb-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-emerald-600" />
              {t('notifPrefs')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground mb-4">{t('notifPrefsDesc')}</p>
            <div className="space-y-3">
              {notifCards.map((item) => {
                const isEnabled = notifPrefs[item.key];
                const Icon = item.icon;
                const colorStyles = {
                  emerald: {
                    active: 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/80 dark:bg-emerald-900/20',
                    iconBg: 'bg-emerald-100 dark:bg-emerald-800/40',
                    iconColor: 'text-emerald-600 dark:text-emerald-400',
                  },
                  amber: {
                    active: 'border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-900/20',
                    iconBg: 'bg-amber-100 dark:bg-amber-800/40',
                    iconColor: 'text-amber-600 dark:text-amber-400',
                  },
                  teal: {
                    active: 'border-teal-300 dark:border-teal-700 bg-teal-50/80 dark:bg-teal-900/20',
                    iconBg: 'bg-teal-100 dark:bg-teal-800/40',
                    iconColor: 'text-teal-600 dark:text-teal-400',
                  },
                };
                const styles = colorStyles[item.color];
                return (
                  <motion.button
                    key={item.key}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    onClick={() => setNotifPrefs((prev) => ({ ...prev, [item.key]: !isEnabled }))}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all duration-300 text-start toggle-item-hover ${
                      isEnabled
                        ? styles.active
                        : 'border-transparent bg-gray-50 dark:bg-gray-800/30 opacity-70'
                    }`}
                  >
                    <div className={`h-10 w-10 rounded-xl ${styles.iconBg} flex items-center justify-center flex-shrink-0 transition-colors`}>
                      <Icon className={`h-5 w-5 ${styles.iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-semibold ${isEnabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {item.label}
                        </p>
                        {isEnabled && (
                          <motion.span
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            className="text-[9px] font-bold text-white px-1.5 py-0.5 rounded-full"
                          >
                            ON
                          </motion.span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">{item.description}</p>
                    </div>
                    {/* Toggle indicator */}
                    <motion.div
                      animate={{ backgroundColor: isEnabled ? '#10b981' : '#d1d5db' }}
                      transition={{ duration: 0.2 }}
                      className="relative h-6 w-11 rounded-full flex-shrink-0"
                    >
                      <motion.span
                        layout
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        className="absolute top-0.5 h-5 w-5 bg-white rounded-full shadow-md"
                        style={{
                          left: isEnabled ? '22px' : '2px',
                        }}
                      />
                    </motion.div>
                  </motion.button>
                );
              })}
            </div>
            <Button
              size="sm"
              className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-10"
              onClick={handleSaveNotifPrefs}
              disabled={notifSaving || notifLoading}
            >
              {notifSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
              {t('save')}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Notification & SMS Settings */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.125 }}
      >
        <Card className="border-0 shadow-sm mb-4 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-emerald-600" />
              {t('smsSettings')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            {/* Reminder Minutes Selector */}
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {t('reminderMinutes')}
              </Label>
              <Select
                value={String(reminderMinutesVal)}
                onValueChange={(val) => setReminderMinutesVal(Number(val))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">{t('reminder5min')}</SelectItem>
                  <SelectItem value="10">{t('reminder10min')}</SelectItem>
                  <SelectItem value="15">{t('reminder15min')}</SelectItem>
                  <SelectItem value="20">{t('reminder20min')}</SelectItem>
                  <SelectItem value="30">{t('reminder30min')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">{t('reminderMinutesDesc')}</p>
            </div>

            {/* SMS Notifications Toggle */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-gray-50 dark:bg-gray-800/30">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                  <BellRing className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{t('smsNotifToggle')}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{t('smsNotifToggleDesc')}</p>
                </div>
              </div>
              <motion.button
                role="switch"
                aria-checked={smsNotifEnabled}
                onClick={() => setSmsNotifEnabled((prev) => !prev)}
                className="relative h-7 w-12 rounded-full flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
              >
                <motion.div
                  animate={{ backgroundColor: smsNotifEnabled ? '#10b981' : '#d1d5db' }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 rounded-full"
                />
                <motion.span
                  layout
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className="absolute top-0.5 h-6 w-6 bg-white rounded-full shadow-md pointer-events-none"
                  style={{ left: smsNotifEnabled ? '23px' : '2px' }}
                />
              </motion.button>
            </div>

            {/* SMS Balance Display */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20">
                <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-800/40 flex items-center justify-center flex-shrink-0">
                  <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('freeSmsCount')}</p>
                  <p className="text-base font-bold text-emerald-700 dark:text-emerald-400">{smsCount}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5 p-3 rounded-xl bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20">
                <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-800/40 flex items-center justify-center flex-shrink-0">
                  <CreditCard className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">{t('purchasedSmsCount')}</p>
                  <p className="text-base font-bold text-amber-700 dark:text-amber-400">{purchasedSms}</p>
                </div>
              </div>
            </div>

            <Button
              size="sm"
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-10"
              onClick={handleSaveSmsSettings}
              disabled={smsSettingsSaving}
            >
              {smsSettingsSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
              {t('save')}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* SMS Wallet with visual progress indicator */}
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
            {/* SMS Usage Breakdown */}
            <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{totalAvailable}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('totalSmsAvailable')}</p>
                </div>
                {/* Circular progress indicator */}
                <div className="relative h-14 w-14 flex-shrink-0">
                  <svg className="h-14 w-14 -rotate-90" viewBox="0 0 56 56">
                    <circle cx="28" cy="28" r="24" className="fill-none stroke-emerald-100 dark:stroke-emerald-900/30" strokeWidth="4" />
                    <circle
                      cx="28" cy="28" r="24"
                      className="fill-none stroke-emerald-500 stroke-linecap:round"
                      strokeWidth="4"
                      strokeDasharray={`${2 * Math.PI * 24}`}
                      strokeDashoffset={`${2 * Math.PI * 24 * (1 - totalPercent / 100)}`}
                      style={{ transition: 'stroke-dashoffset 1s ease-out' }}
                    />
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">{totalPercent}%</span>
                  </div>
                </div>
              </div>
              {/* Usage breakdown rows */}
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                  <p className="text-[10px] text-muted-foreground">{t('freeSmsCount')}</p>
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{smsCount}</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                  <p className="text-[10px] text-muted-foreground">{t('smsPurchased')}</p>
                  <p className="text-sm font-bold text-amber-700 dark:text-amber-400">{purchasedSms}</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-white/50 dark:bg-gray-900/30">
                  <p className="text-[10px] text-muted-foreground">{t('noAnalyticsData') || 'Used'}</p>
                  <p className="text-sm font-bold text-rose-600 dark:text-rose-400">{Math.max(0, (smsCount + purchasedSms) - totalAvailable)}</p>
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
                    onClick={() => handlePurchaseSms(packId)}
                    disabled={smsPurchasing}
                    className={`relative p-4 rounded-xl border text-center transition-all duration-200 hover:shadow-lg ${
                      isBestValue
                        ? 'border-emerald-300 dark:border-emerald-700 bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/20 dark:to-teal-900/20'
                        : 'border-border hover:border-emerald-300 dark:hover:border-emerald-700 bg-gradient-to-br from-emerald-50/50 to-teal-50/50 dark:from-emerald-900/10 dark:to-teal-900/10'
                    }`}
                  >
                    {isBestValue && (
                      <span className="absolute -top-2.5 start-1/2 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-bold shadow-lg z-10 whitespace-nowrap">
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

      {/* Purchase History */}
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
    </>
  );
}
