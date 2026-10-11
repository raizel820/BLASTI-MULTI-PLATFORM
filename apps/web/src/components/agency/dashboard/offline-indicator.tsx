'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Wifi, WifiOff, RefreshCw, CloudOff, Check, Clock, ArrowRightLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import type { TranslationKeys } from '@/i18n';

interface OfflineIndicatorProps {
  isConnected: boolean;
  onReconnect: () => void;
  t: (key: TranslationKeys) => string;
}

export function OfflineIndicator({ isConnected, onReconnect, t }: OfflineIndicatorProps) {
  const [lastSyncTime, setLastSyncTime] = useState<Date>(new Date());
  const [syncing, setSyncing] = useState(false);

  // Update last sync time when connection is restored
  useEffect(() => {
    if (isConnected) {
      setLastSyncTime(new Date());
      setSyncing(false);
    }
  }, [isConnected]);

  const handleReconnect = async () => {
    setSyncing(true);
    try {
      await onReconnect();
    } finally {
      setTimeout(() => setSyncing(false), 2000);
    }
  };

  const timeSinceLastSync = () => {
    const diff = Math.floor((Date.now() - lastSyncTime.getTime()) / 1000);
    if (diff < 10) return t('justNow') || 'Just now';
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    return `${Math.floor(diff / 3600)}h`;
  };

  return (
    <AnimatePresence mode="wait">
      {!isConnected ? (
        <motion.div
          key="offline"
          initial={{ opacity: 0, y: -20, height: 0 }}
          animate={{ opacity: 1, y: 0, height: 'auto' }}
          exit={{ opacity: 0, y: -20, height: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="overflow-hidden"
        >
          <div className="rounded-2xl bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 p-[2px] shadow-lg shadow-amber-500/20">
            <div className="rounded-[14px] bg-gradient-to-r from-amber-50 to-amber-50 dark:from-amber-950/80 dark:to-amber-950/80 px-4 py-3 flex items-center gap-3">
              <motion.div
                animate={{ scale: [1, 1.1, 1], opacity: [0.8, 1, 0.8] }}
                transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
                className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center flex-shrink-0"
              >
                <WifiOff className="h-4 w-4 text-white" />
              </motion.div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-amber-800 dark:text-amber-200 text-sm">
                  {t('offlineModeActive' as any) || 'Operating in offline mode'}
                </p>
                <p className="text-xs text-amber-700/70 dark:text-amber-300/70 mt-0.5">
                  {t('offlineModeDesc' as any) || 'Changes will sync when connection returns'}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <div className="flex items-center gap-1 text-[10px] text-amber-600/60 dark:text-amber-400/60">
                    <ArrowRightLeft className="h-2.5 w-2.5" />
                    <span>{t('syncLastSync' as any) || 'Last sync'}: {timeSinceLastSync()}</span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-amber-600/60 dark:text-amber-400/60">
                    <Clock className="h-2.5 w-2.5" />
                    <span>{t('pendingSyncEvents' as any) || 'Pending sync'}</span>
                  </div>
                </div>
              </div>
              <Button
                onClick={handleReconnect}
                disabled={syncing}
                variant="outline"
                size="sm"
                className="h-8 px-3 rounded-lg border-2 border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 text-xs font-semibold gap-1.5 flex-shrink-0"
              >
                {syncing ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                {syncing ? (t('syncSyncing' as any) || 'Syncing...') : (t('reconnect' as any) || 'Retry')}
              </Button>
            </div>
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="online"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800">
            <motion.div
              animate={{ scale: [1, 1.2, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]"
            />
            <Wifi className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
              {t('onlineModeActive' as any) || 'Connected to Server'}
            </span>
            <span className="text-[10px] text-emerald-600/60 dark:text-emerald-400/60 ms-1">
              · {t('syncLastSync' as any) || 'Sync'}: {timeSinceLastSync()}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
