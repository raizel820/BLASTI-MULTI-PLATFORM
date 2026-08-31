'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Bell,
  BellRing,
  Check,
  CheckCircle2,
  Clock,
  Loader2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { NotifPrefs, ProfileNotificationsProps } from './profile-types';

const notifCardDefs = [
  {
    key: 'queue_called' as const,
    icon: BellRing,
    color: 'emerald' as const,
  },
  {
    key: 'turn_approaching' as const,
    icon: Clock,
    color: 'amber' as const,
  },
  {
    key: 'completed' as const,
    icon: CheckCircle2,
    color: 'teal' as const,
  },
];

const colorStyles = {
  emerald: {
    active: 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/80 dark:bg-emerald-900/20',
    iconBg: 'bg-emerald-100 dark:bg-emerald-800/40',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    badge: 'bg-emerald-500',
  },
  amber: {
    active: 'border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-900/20',
    iconBg: 'bg-amber-100 dark:bg-amber-800/40',
    iconColor: 'text-amber-600 dark:text-amber-400',
    badge: 'bg-amber-500',
  },
  teal: {
    active: 'border-teal-300 dark:border-teal-700 bg-teal-50/80 dark:bg-teal-900/20',
    iconBg: 'bg-teal-100 dark:bg-teal-800/40',
    iconColor: 'text-teal-600 dark:text-teal-400',
    badge: 'bg-teal-500',
  },
};

const notifLabels: Record<keyof NotifPrefs, { label: string; description: string }> = {
  queue_called: { label: 'queueCalledNotif', description: 'queueCalledNotifDesc' },
  turn_approaching: { label: 'turnApproachingNotif', description: 'turnApproachingNotifDesc' },
  completed: { label: 'completedNotif', description: 'completedNotifDesc' },
};

export function ProfileNotifications({ notifPrefs, notifSaving, notifLoading, onTogglePref, onSave, t }: ProfileNotificationsProps) {
  return (
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
            {notifCardDefs.map((item) => {
              const isEnabled = notifPrefs[item.key];
              const Icon = item.icon;
              const styles = colorStyles[item.color];
              const labels = notifLabels[item.key];
              return (
                <motion.button
                  key={item.key}
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => onTogglePref(item.key)}
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
                        {t(labels.label)}
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
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {t(labels.description) || (item.key === 'queue_called' ? 'Get notified when your turn is called' : item.key === 'turn_approaching' ? 'Alert when your turn is approaching' : 'Notify when service is completed')}
                    </p>
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
            onClick={onSave}
            disabled={notifSaving || notifLoading}
          >
            {notifSaving ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Check className="h-4 w-4 me-2" />}
            {t('save')}
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}
