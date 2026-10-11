'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshCw, ChevronDown, TicketCheck } from 'lucide-react';
import { motion } from 'framer-motion';
import type { Reservation } from './types';

interface QueueHeaderProps {
  activeRes: Reservation | undefined;
  isFastPolling: boolean;
  refreshInterval: number;
  lastUpdated: Date;
  pulseKey: number;
  onRefresh: () => void;
  onIntervalChange: (interval: number) => void;
}

export function QueueHeader({
  activeRes,
  isFastPolling,
  refreshInterval,
  lastUpdated,
  pulseKey,
  onRefresh,
  onIntervalChange,
}: QueueHeaderProps) {
  const { t, lang } = useLanguage();

  // Dynamic font sizing for queue numbers based on string length
  const getQueueHeaderClass = (qNum: string) => {
    const len = qNum.length;
    if (len > 8) return 'text-base font-black tracking-tight';
    if (len > 5) return 'text-lg font-black tracking-tight';
    return 'text-2xl font-black tracking-tight';
  };

  // Time ago helper
  const getTimeAgo = useCallback(() => {
    const diff = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
    if (diff < 5) return t('justNow');
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    return `${Math.floor(diff / 3600)}h`;
  }, [lastUpdated, t]);
  const [timeAgo, setTimeAgo] = useState(getTimeAgo);
  useEffect(() => {
    const update = () => setTimeAgo(getTimeAgo());
    update();
    const interval = setInterval(update, 5000);
    return () => clearInterval(interval);
  }, [getTimeAgo]);

  return (
    <>
      {/* Gradient header bar with ticket number */}
      {activeRes && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative -mx-4 -mt-4 mb-5 rounded-b-2xl bg-gradient-to-r from-emerald-600 via-teal-500 to-emerald-600 p-4 text-white shadow-lg shadow-emerald-500/25 overflow-hidden"
        >
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-4 -end-4 w-24 h-24 rounded-full bg-white/10" />
            <div className="absolute bottom-0 -start-4 w-16 h-16 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <TicketCheck className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs font-medium text-emerald-100">{t('yourQueueNumber')}</p>
                <p className={`${getQueueHeaderClass(activeRes.queueNumber)} truncate max-w-[160px] sm:max-w-none`}>{activeRes.queueNumber}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {isFastPolling && activeRes?.status === 'WAITING' && (
                <motion.div
                  animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                  className="h-2.5 w-2.5 rounded-full bg-amber-300"
                />
              )}
              <span className="text-xs font-medium bg-white/20 px-2.5 py-1 rounded-full backdrop-blur-sm">
                {activeRes.status === 'CALLED' ? t('statusCalled') : t('statusWaiting')}
              </span>
            </div>
          </div>
        </motion.div>
      )}

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">{t('myQueue')}</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          className="h-9 px-3 rounded-lg gap-1.5 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors duration-200"
        >
          <RefreshCw className="h-4 w-4" />
          <span className="text-xs font-medium">{t('refresh')}</span>
        </Button>
      </div>
      {/* Refresh interval selector + last updated */}
      <div className="flex items-center justify-between mb-5">
        <span className="text-[11px] text-muted-foreground">
          {t('updatedAgo')}: <span className="font-medium text-foreground">{timeAgo}</span>
        </span>
        <motion.div
          key={pulseKey}
          initial={{ opacity: [0.3, 1] }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
          className="flex items-center gap-1.5"
        >
          <span className="text-[11px] text-muted-foreground">{t('refreshEvery')}:</span>
          <Select value={String(refreshInterval)} onValueChange={(v) => onIntervalChange(Number(v))}>
            <SelectTrigger className="h-8 w-auto px-2.5 py-0 text-[11px] rounded-xl border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/20 focus:ring-emerald-500/20">
              <SelectValue />
              <ChevronDown className="h-3 w-3 ms-1 opacity-50" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5000">{t('seconds5')}</SelectItem>
              <SelectItem value="10000">{t('seconds10')}</SelectItem>
              <SelectItem value="30000">{t('seconds30')}</SelectItem>
              <SelectItem value="0">{t('off')}</SelectItem>
            </SelectContent>
          </Select>
        </motion.div>
      </div>
    </>
  );
}
