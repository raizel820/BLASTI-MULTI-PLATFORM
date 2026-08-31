'use client';

import { Badge } from '@/components/ui/badge';
import { ShieldCheck, TrendingUp } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { motion } from 'framer-motion';

interface DashboardHeaderProps {
  dailyActivity: number;
}

export function DashboardHeader({ dailyActivity }: DashboardHeaderProps) {
  const { t } = useLanguage();

  return (
    <>
      {/* Premium header gradient banner with branding */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden mb-2"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <div className="h-12 w-12 rounded-xl overflow-hidden">
                  <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                </div>
                {t('adminDashboard')}
              </h1>
              <p className="text-sm text-emerald-100 mt-1 ms-[52px]">BLASTI Platform Management</p>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-3 py-1">
                <TrendingUp className="h-3 w-3 me-1" />
                {dailyActivity} {t('todayLabel')}
              </Badge>
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-2 py-1">
                <ShieldCheck className="h-3 w-3 me-1" />
                {t('superAdmin')}
              </Badge>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Mobile badges */}
      <div className="flex sm:hidden items-center gap-2 mb-1">
        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-xs font-medium px-2 py-0.5">
          <TrendingUp className="h-3 w-3 me-1" />
          {dailyActivity} {t('todayLabel')}
        </Badge>
        <Badge variant="outline" className="bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
          <ShieldCheck className="h-3 w-3 me-1" />
          {t('superAdmin')}
        </Badge>
      </div>
    </>
  );
}
