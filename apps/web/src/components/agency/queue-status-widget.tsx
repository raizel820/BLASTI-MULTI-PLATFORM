'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent } from '@/components/ui/card';
import { Users, CheckCircle2, Clock, Activity } from 'lucide-react';
import { motion } from 'framer-motion';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';

interface QueueStatusData {
  waiting: number;
  beingServed: number;
  completedToday: number;
  maxCapacity: number;
  avgWaitTime: number;
}

interface QueueStatusWidgetProps {
  agencyId: string;
}

export function QueueStatusWidget({ agencyId }: QueueStatusWidgetProps) {
  const { t, lang } = useLanguage();
  const [data, setData] = useState<QueueStatusData | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchStatus = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/stats?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const json = await res.json();
        setData({
          waiting: json.currentlyWaiting ?? 0,
          beingServed: json.beingServed ?? 0,
          completedToday: json.servedToday ?? 0,
          maxCapacity: json.maxReservations ?? 50,
          avgWaitTime: json.avgWaitTime ?? 0,
        });
        setLastRefresh(new Date());
      }
    } catch {
      // Silently fail - widget is non-critical
    }
  }, [agencyId]);

  // FIX #16: Offline-aware polling with backoff
  useEffect(() => {
    if (!agencyId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const NORMAL = 15_000;

    const getInterval = () => {
      if (failures >= 5) return 300_000;
      if (failures >= 3) return 120_000;
      if (failures >= 1) return 60_000;
      return NORMAL;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }
      await fetchStatus();
      if (isApiUnreachable()) {
        failures = Math.min(failures + 1, 10);
      } else {
        failures = 0;
      }
      timer = setTimeout(tick, getInterval());
    };

    // Initial fetch
    fetchStatus();
    timer = setTimeout(tick, NORMAL);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [fetchStatus, agencyId]);

  if (!data) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
            <div className="grid grid-cols-3 gap-3">
              <div className="h-16 bg-gray-200 dark:bg-gray-700 rounded-xl" />
              <div className="h-16 bg-gray-200 dark:bg-gray-700 rounded-xl" />
              <div className="h-16 bg-gray-200 dark:bg-gray-700 rounded-xl" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const capacityPercent = data.maxCapacity > 0 ? (data.waiting / data.maxCapacity) * 100 : 0;
  const waitLevel = data.avgWaitTime <= 10 ? 'low' : data.avgWaitTime <= 25 ? 'medium' : 'high';

  const levelConfig = {
    low: {
      color: 'text-emerald-600 dark:text-emerald-400',
      bg: 'bg-emerald-50 dark:bg-emerald-900/20',
      barColor: 'from-emerald-400 to-emerald-500',
      dotColor: 'bg-emerald-500',
      label: t('lowWait'),
    },
    medium: {
      color: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      barColor: 'from-amber-400 to-amber-500',
      dotColor: 'bg-amber-500',
      label: t('mediumWait'),
    },
    high: {
      color: 'text-rose-600 dark:text-rose-400',
      bg: 'bg-rose-50 dark:bg-rose-900/20',
      barColor: 'from-rose-400 to-rose-500',
      dotColor: 'bg-rose-500',
      label: t('highWait'),
    },
  };

  const config = levelConfig[waitLevel];

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:shadow-gray-900/50">
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600" />
            <span className="text-sm font-semibold text-foreground">{t('queueStatus')}</span>
          </div>
          <motion.div
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
            className="flex items-center gap-1"
          >
            <span className={`h-2 w-2 rounded-full ${config.dotColor}`} />
            <span className="text-[10px] text-muted-foreground">{config.label}</span>
          </motion.div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="text-center p-2.5 rounded-xl bg-teal-50 dark:bg-teal-900/20">
            <Users className="h-4 w-4 text-teal-600 dark:text-teal-400 mx-auto mb-1" />
            <motion.p
              key={data.waiting}
              initial={{ scale: 1.2 }}
              animate={{ scale: 1 }}
              className="text-lg font-bold text-teal-700 dark:text-teal-400"
            >
              {data.waiting}
            </motion.p>
            <p className="text-[9px] text-muted-foreground">{t('currentlyWaiting')}</p>
          </div>
          <div className="text-center p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
            <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{data.completedToday}</p>
            <p className="text-[9px] text-muted-foreground">{t('servedToday')}</p>
          </div>
          <div className="text-center p-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20">
            <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
            <p className="text-lg font-bold text-amber-700 dark:text-amber-400">{data.avgWaitTime ?? 0}</p>
            <p className="text-[9px] text-muted-foreground">{t('min')}</p>
          </div>
        </div>

        {/* Queue Capacity Progress Bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">{t('queueCapacity')}</span>
            <span className="text-[10px] font-medium text-muted-foreground">
              {data.waiting}/{data.maxCapacity}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
            <motion.div
              className={`h-full rounded-full bg-gradient-to-r ${config.barColor}`}
              initial={{ width: '0%' }}
              animate={{ width: `${Math.min(capacityPercent, 100)}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
