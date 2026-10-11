'use client';

import { motion } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { Button } from '@/components/ui/button';
import { TicketCheck, Clock, Users, Search } from 'lucide-react';

export function QueueEmptyState() {
  const { t } = useLanguage();
  const { setView } = useAppStore();

  return (
    <div className="px-4 py-4 pb-24 relative">
      {/* Subtle background pattern for empty state */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.02] dark:opacity-[0.03]" style={{
        backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
        backgroundSize: '24px 24px',
      }} />
      <h1 className="text-2xl font-bold mb-1 relative bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">{t('myQueue')}</h1>
      <div className="flex flex-col items-center justify-center py-16 relative">
        <div className="relative mb-8">
          {/* Pulsing background ring */}
          <motion.div
            animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-32 w-32 rounded-full bg-emerald-200 dark:bg-emerald-800"
          />
          {/* Decorative dashed circle */}
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
            className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-28 w-28 rounded-full border-2 border-dashed border-emerald-200/60 dark:border-emerald-700/40"
          />
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
            className="relative h-20 w-20 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center"
          >
            <TicketCheck className="h-10 w-10 text-emerald-500" />
          </motion.div>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.2 }}
            className="h-14 w-14 rounded-full bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center absolute -top-3 end-2"
          >
            <Clock className="h-7 w-7 text-teal-500" />
          </motion.div>
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.3 }}
            className="h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center absolute bottom-0 start-6"
          >
            <Users className="h-6 w-6 text-amber-500" />
          </motion.div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="text-center max-w-xs"
        >
          <h2 className="text-lg font-semibold text-foreground mb-2">
            {t('noActiveReservations')}
          </h2>
          <p className="text-sm text-muted-foreground mb-2">
            {t('welcomeSubtitle')}
          </p>
          <p className="text-xs text-muted-foreground/70 mb-6">
            {t('joinQueueHint') || 'Find an agency nearby and join their queue to save time'}
          </p>
          <Button
            className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold px-6 rounded-xl h-11 shadow-lg shadow-emerald-500/20 hover:shadow-xl hover:shadow-emerald-500/30 transition-all duration-300"
            onClick={() => setView('customer-home')}
          >
            <Search className="h-4 w-4 me-2" />
            {t('joinQueue')}
          </Button>
        </motion.div>
      </div>
    </div>
  );
}
