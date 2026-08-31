'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import type { Reservation } from './types';

interface QueueFiltersProps {
  isFastPolling: boolean;
  activeRes: Reservation | undefined;
}

export function QueueFilters({ isFastPolling, activeRes }: QueueFiltersProps) {
  const { t } = useLanguage();

  return (
    <AnimatePresence>
      {isFastPolling && activeRes?.status === 'WAITING' && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30"
        >
          <motion.div
            animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
            className="h-2.5 w-2.5 rounded-full bg-amber-500"
          />
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {t('smartPollingActive')}
          </span>
          <span className="text-[10px] text-amber-600/70 dark:text-amber-400/70">
            · {t('smartPollingDesc')}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
