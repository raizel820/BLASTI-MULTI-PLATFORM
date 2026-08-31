'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Smartphone,
  Clock,
  BellRing,
  MessageSquare,
  CreditCard,
  Check,
  Loader2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { ProfileSmsSettingsProps } from './profile-types';

export function ProfileSmsSettings({
  reminderMinutesVal,
  smsNotifEnabled,
  smsSettingsSaving,
  smsCount,
  purchasedSms,
  onReminderChange,
  onSmsNotifToggle,
  onSave,
  t,
}: ProfileSmsSettingsProps) {
  return (
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
              onValueChange={(val) => onReminderChange(Number(val))}
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
              onClick={onSmsNotifToggle}
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
            onClick={onSave}
            disabled={smsSettingsSaving}
          >
            {smsSettingsSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
            {t('save')}
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}
