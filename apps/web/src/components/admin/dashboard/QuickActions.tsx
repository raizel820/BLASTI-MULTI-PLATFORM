'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import {
  Activity,
  BarChart3,
  ClipboardList,
  CreditCard,
  Plus,
} from 'lucide-react';
import { motion } from 'framer-motion';

export function QuickActions() {
  const { t } = useLanguage();
  const { setView } = useAppStore();

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600" />
            {t('quickActions')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-2 gap-3">
            <motion.button
              whileHover={{ y: -4, scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => setView('admin-agencies')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border-0 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 hover:from-emerald-100 hover:to-teal-100 dark:hover:from-emerald-900/30 dark:hover:to-teal-900/30 shadow-sm hover:shadow-lg hover:shadow-emerald-500/5 transition-all duration-300 quick-action-card"
            >
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-800/40 dark:to-emerald-700/40 flex items-center justify-center shadow-sm">
                <Plus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span className="text-xs font-semibold text-foreground">{t('addNewAgency')}</span>
            </motion.button>
            <motion.button
              whileHover={{ y: -4, scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => setView('admin-analytics')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border-0 bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/20 hover:from-teal-100 hover:to-cyan-100 dark:hover:from-teal-900/30 dark:hover:to-cyan-900/30 shadow-sm hover:shadow-lg hover:shadow-teal-500/5 transition-all duration-300 quick-action-card"
            >
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-800/40 dark:to-teal-700/40 flex items-center justify-center shadow-sm">
                <BarChart3 className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              </div>
              <span className="text-xs font-semibold text-foreground">{t('viewAnalytics')}</span>
            </motion.button>
            <motion.button
              whileHover={{ y: -4, scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => setView('admin-users')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border-0 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 hover:from-amber-100 hover:to-orange-100 dark:hover:from-amber-900/30 dark:hover:to-orange-900/30 shadow-sm hover:shadow-lg hover:shadow-amber-500/5 transition-all duration-300 quick-action-card"
            >
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-800/40 dark:to-amber-700/40 flex items-center justify-center shadow-sm">
                <ClipboardList className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <span className="text-xs font-semibold text-foreground">{t('manageUsers')}</span>
            </motion.button>
            <motion.button
              whileHover={{ y: -4, scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => setView('admin-transactions')}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border-0 bg-gradient-to-br from-rose-50 to-pink-50 dark:from-rose-900/20 dark:to-pink-900/20 hover:from-rose-100 hover:to-pink-100 dark:hover:from-rose-900/30 dark:hover:to-pink-900/30 shadow-sm hover:shadow-lg hover:shadow-rose-500/5 transition-all duration-300 quick-action-card"
            >
              <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-rose-200 to-rose-300 dark:from-rose-800/40 dark:to-rose-700/40 flex items-center justify-center shadow-sm">
                <CreditCard className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              <span className="text-xs font-semibold text-foreground">{t('viewTransactions')}</span>
            </motion.button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
