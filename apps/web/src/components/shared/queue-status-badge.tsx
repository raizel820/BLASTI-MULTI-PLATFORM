'use client';

import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';
import type { TranslationKeys } from '@/i18n';
import { motion } from 'framer-motion';
import { Check, X, AlertTriangle, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

type StatusType =
  | 'WAITING'
  | 'CALLED'
  | 'SERVED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'COMPLETED'
  | 'DEFERRED_OFFLINE';

interface StatusConfig {
  color: string;
  translationKey: TranslationKeys;
  animate?: 'pulse' | 'glow';
  icon?: 'check' | 'x' | 'warning' | 'wifioff';
}

const statusConfig: Record<string, StatusConfig> = {
  WAITING: {
    color:
      'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800',
    translationKey: 'statusWaiting',
    animate: 'pulse',
  },
  CALLED: {
    color:
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 shadow-emerald-500/20',
    translationKey: 'statusCalled',
    animate: 'glow',
  },
  SERVED: {
    color:
      'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400 border-teal-200 dark:border-teal-800',
    translationKey: 'statusServed',
    icon: 'check',
  },
  COMPLETED: {
    color:
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
    translationKey: 'statusCompleted',
    icon: 'check',
  },
  CANCELLED: {
    color:
      'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800',
    translationKey: 'statusCancelled',
    icon: 'x',
  },
  NO_SHOW: {
    color:
      'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800',
    translationKey: 'statusNoShow',
    icon: 'warning',
  },
  DEFERRED_OFFLINE: {
    color:
      'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800',
    translationKey: 'statusDeferredOffline',
    animate: 'pulse',
    icon: 'wifioff',
  },
};

const statusIconMap = {
  check: Check,
  x: X,
  warning: AlertTriangle,
  wifioff: WifiOff,
} as const;

interface QueueStatusBadgeProps {
  status: string;
  compact?: boolean;
}

export function QueueStatusBadge({ status, compact = false }: QueueStatusBadgeProps) {
  const { lang, t } = useLanguage();
  const rtl = isRTL(lang);
  const config = statusConfig[status] ?? {
    color:
      'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800',
    translationKey: 'status' as TranslationKeys,
  };

  const StatusIcon = config.icon ? statusIconMap[config.icon] : null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
    >
      <Badge
        variant="outline"
        dir={rtl ? 'rtl' : 'ltr'}
        className={cn(
          config.color,
          compact ? 'px-1.5 py-0 text-[10px]' : 'px-2.5 py-0.5 text-xs',
          'font-semibold gap-1',
          config.animate === 'pulse' && 'animate-pulse',
          config.animate === 'glow' && 'animate-[badge-glow_2s_ease-in-out_infinite]'
        )}
      >
        {/* Pulsing dot for WAITING / DEFERRED_OFFLINE */}
        {config.animate === 'pulse' && status !== 'DEFERRED_OFFLINE' && (
          <motion.span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
            animate={{ scale: [1, 1.4, 1], opacity: [1, 0.6, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* Glowing dot for CALLED */}
        {config.animate === 'glow' && (
          <motion.span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
            animate={{ scale: [1, 1.3, 1] }}
            transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

        {/* Checkmark for SERVED / COMPLETED */}
        {StatusIcon === Check && (
          <Check
            className={cn(
              'shrink-0',
              compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
            )}
          />
        )}

        {/* X mark for CANCELLED */}
        {StatusIcon === X && (
          <X
            className={cn(
              'shrink-0',
              compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
            )}
          />
        )}

        {/* Warning for NO_SHOW */}
        {StatusIcon === AlertTriangle && (
          <AlertTriangle
            className={cn(
              'shrink-0',
              compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
            )}
          />
        )}

        {/* WifiOff for DEFERRED_OFFLINE */}
        {StatusIcon === WifiOff && (
          <WifiOff
            className={cn(
              'shrink-0',
              compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
            )}
          />
        )}

        {t(config.translationKey)}
      </Badge>
    </motion.div>
  );
}
