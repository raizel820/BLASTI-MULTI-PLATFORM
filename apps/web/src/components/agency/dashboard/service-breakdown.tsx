'use client';

import { Layers } from 'lucide-react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TranslationKeys } from '@/i18n';
import type { ServiceStat } from './types';
import { getServiceDisplayName } from './helpers';

interface ServiceBreakdownProps {
  serviceStats: ServiceStat[];
  maxWaiting: number;
  lang: string;
  t: (key: TranslationKeys) => string;
}

export function ServiceBreakdown({ serviceStats, maxWaiting, lang, t }: ServiceBreakdownProps) {
  return (
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="h-4 w-4 text-emerald-600" />{t('serviceBreakdown')}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {serviceStats.length === 0 ? (
            <div className="text-center py-4"><Layers className="h-6 w-6 text-muted-foreground mx-auto mb-2" /><p className="text-sm text-muted-foreground">{t('noServiceData')}</p></div>
          ) : (
            <div className="space-y-2.5">
              {serviceStats.map((service, idx) => {
                const barWidth = maxWaiting > 0 ? (service.waitingCount / maxWaiting) * 100 : 0;
                const completionPct = (service.waitingCount + service.completedCount) > 0 ? (service.completedCount / (service.waitingCount + service.completedCount)) * 100 : 0;
                return (
                  <div key={service.id} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-foreground truncate max-w-[60%]">{getServiceDisplayName(service, lang)}</span>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{service.waitingCount} {t('waiting')}</span>
                        <span className="text-xs opacity-60">{Math.round(completionPct)}%</span>
                      </div>
                    </div>
                    <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(barWidth, 2)}%` }} transition={{ duration: 0.6, delay: idx * 0.08, ease: 'easeOut' }} className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
