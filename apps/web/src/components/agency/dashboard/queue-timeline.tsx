'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  TrendingUp,
  Clock,
  BarChart3,
} from 'lucide-react';
import type { TranslationKeys } from '@/i18n';

interface QueueTimelineProps {
  hourlyWaitTime?: number[];
  avgWaitTime: number;
  todayReservations: number;
  servedToday: number;
  peakHour?: string;
  lang: string;
  t: (key: TranslationKeys) => string;
}

export function QueueTimeline({
  hourlyWaitTime,
  avgWaitTime,
  todayReservations,
  servedToday,
  peakHour,
  lang,
  t,
}: QueueTimelineProps) {
  // Generate hourly data for the timeline
  const timelineData = useMemo(() => {
    const hours = Array.from({ length: 10 }, (_, i) => i + 8); // 8 AM to 5 PM
    const currentHour = new Date().getHours();

    // Use real hourly data if available, otherwise show zeros (no fake data)
    const data = hours.map((hour, idx) => {
      let value: number;
      if (hourlyWaitTime && hourlyWaitTime.length > idx) {
        value = hourlyWaitTime[idx] ?? 0;
      } else {
        value = 0;
      }

      const isPeak = (hour >= 9 && hour <= 11) || (hour >= 14 && hour <= 15);
      const isCurrent = hour === currentHour;
      const isPast = hour < currentHour;
      const isFuture = hour > currentHour;

      return {
        hour,
        label: `${hour}`,
        value,
        isPeak,
        isCurrent,
        isPast,
        isFuture,
      };
    });

    return data;
  }, [hourlyWaitTime]);

  const maxValue = Math.max(...timelineData.map(d => d.value), 1);
  const currentHourIdx = timelineData.findIndex(d => d.isCurrent);

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.28 }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-emerald-600" />
              {t('queueTimeline' as any) || 'Queue Timeline'}
            </CardTitle>
            <div className="flex items-center gap-2">
              {peakHour && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-5 border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                  <TrendingUp className="h-2.5 w-2.5 me-1" />
                  {t('peakHour')}: {peakHour}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {/* Timeline Bar Chart */}
          <div className="relative">
            {/* Peak zone indicators */}
            <div className="absolute top-0 bottom-6 left-[10%] w-[20%] bg-amber-50/50 dark:bg-amber-900/10 rounded-lg" />
            <div className="absolute top-0 bottom-6 left-[60%] w-[10%] bg-amber-50/50 dark:bg-amber-900/10 rounded-lg" />

            <div className="flex items-end gap-1 h-28 relative z-10">
              {timelineData.map((entry, idx) => {
                const height = (entry.value / maxValue) * 100;
                return (
                  <TooltipProvider key={entry.hour}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex-1 flex flex-col items-center justify-end h-full group cursor-pointer">
                          <motion.div
                            initial={{ height: 0 }}
                            animate={{ height: `${Math.max(height, 4)}%` }}
                            transition={{ duration: 0.5, delay: idx * 0.04, ease: 'easeOut' }}
                            className={`w-full rounded-t-md min-h-[3px] transition-all duration-200 ${
                              entry.isCurrent
                                ? 'bg-gradient-to-t from-emerald-600 to-emerald-400 ring-2 ring-emerald-400/50 shadow-md shadow-emerald-500/20'
                                : entry.isPeak && entry.isPast
                                  ? 'bg-gradient-to-t from-amber-500 to-amber-400 dark:from-amber-600 dark:to-amber-500'
                                  : entry.isPast
                                    ? 'bg-gradient-to-t from-teal-500/70 to-teal-400/70 dark:from-teal-600/60 dark:to-teal-500/60'
                                    : 'bg-gray-200 dark:bg-gray-700/40'
                            }`}
                          />
                          <span className={`text-[8px] mt-1 ${
                            entry.isCurrent
                              ? 'text-emerald-600 dark:text-emerald-400 font-bold'
                              : entry.isPeak
                                ? 'text-amber-600 dark:text-amber-400 font-medium'
                                : 'text-muted-foreground'
                          }`}>
                            {entry.label}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <div className="flex items-center gap-1.5">
                          <Clock className="h-3 w-3" />
                          <span>{entry.label}:00 — {entry.value} {t('min')}</span>
                          {entry.isPeak && <Badge className="bg-amber-100 text-amber-700 text-[8px] px-1 py-0 h-4 border-0">{t('peak' as any) || 'Peak'}</Badge>}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-4 mt-3">
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-sm bg-gradient-to-t from-emerald-600 to-emerald-400" />
              <span className="text-[10px] text-muted-foreground">{t('current' as any) || 'Current'}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-sm bg-gradient-to-t from-amber-500 to-amber-400" />
              <span className="text-[10px] text-muted-foreground">{t('peak' as any) || 'Peak'}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-2.5 w-2.5 rounded-sm bg-teal-400/70" />
              <span className="text-[10px] text-muted-foreground">{t('past' as any) || 'Past'}</span>
            </div>
          </div>

          {/* Progress indicator */}
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <TrendingUp className="h-3 w-3 text-amber-500" />
                <span>{t('peakHoursDesc' as any) || 'Peak hours: 9-11 AM, 2-3 PM'}</span>
              </div>
              <span className="font-medium text-foreground">{todayReservations - servedToday} {t('remaining' as any) || 'remaining'}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
