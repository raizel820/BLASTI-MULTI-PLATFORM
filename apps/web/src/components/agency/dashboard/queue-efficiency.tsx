'use client';

import { CheckCircle2, TrendingUp, Users, Clock, Activity } from 'lucide-react';
import { motion } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TranslationKeys } from '@/i18n';
import { AnimatedCounter } from './helpers';

interface QueueEfficiencyProps {
  completionRate: number;
  servedToday: number;
  currentlyWaiting: number;
  avgWaitTime: number;
  t: (key: TranslationKeys) => string;
}

export function QueueEfficiency({ completionRate, servedToday, currentlyWaiting, avgWaitTime, t }: QueueEfficiencyProps) {
  const safeRate = isNaN(completionRate) ? 0 : Math.min(Math.max(completionRate, 0), 100);
  const circumference = 2 * Math.PI * 52;
  const strokeDashoffset = circumference - (safeRate / 100) * circumference;

  const ringColor = safeRate >= 80 ? 'text-emerald-500' : safeRate >= 50 ? 'text-amber-500' : 'text-rose-500';
  const ringStroke = safeRate >= 80 ? '#10b981' : safeRate >= 50 ? '#f59e0b' : '#f43f5e';
  const ringStrokeEnd = safeRate >= 80 ? '#059669' : safeRate >= 50 ? '#d97706' : '#e11d48';
  const bgColor = safeRate >= 80 ? 'bg-emerald-50 dark:bg-emerald-900/20' : safeRate >= 50 ? 'bg-amber-50 dark:bg-amber-900/20' : 'bg-rose-50 dark:bg-rose-900/20';

  const efficiencyLabel = safeRate >= 80 ? t('excellent') : safeRate >= 50 ? (t('good') || 'Good') : t('needsAttention');
  const efficiencyIcon = safeRate >= 80 ? '🟢' : safeRate >= 50 ? '🟡' : '🔴';

  // Side stats
  const sideStats = [
    {
      icon: CheckCircle2,
      label: t('servedToday'),
      value: servedToday,
      bg: bgColor,
      iconColor: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      icon: Users,
      label: t('queueLengthShort'),
      value: currentlyWaiting,
      bg: 'bg-teal-50 dark:bg-teal-900/20',
      iconColor: 'text-teal-600 dark:text-teal-400',
    },
    {
      icon: Clock,
      label: t('avgWaitTime'),
      value: avgWaitTime,
      suffix: t('min'),
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      iconColor: 'text-amber-600 dark:text-amber-400',
    },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <TrendingUp className="h-3.5 w-3.5 text-white" />
            </div>
            {t('queueEfficiency') || 'Queue Efficiency'}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex items-center gap-5">
            {/* Circular Progress Ring — Enhanced */}
            <div className="relative flex-shrink-0">
              {/* Outer decorative ring */}
              <div className="absolute inset-[-4px] rounded-full border border-dashed border-gray-200 dark:border-gray-700" />

              <svg width="120" height="120" viewBox="0 0 120 120" className="transform -rotate-90">
                <defs>
                  <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor={ringStroke} />
                    <stop offset="100%" stopColor={ringStrokeEnd} />
                  </linearGradient>
                </defs>
                {/* Background circle */}
                <circle
                  cx="60" cy="60" r="52"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-gray-100 dark:text-gray-800"
                />
                {/* Progress circle with gradient */}
                <motion.circle
                  cx="60" cy="60" r="52"
                  fill="none"
                  stroke="url(#progressGradient)"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  initial={{ strokeDashoffset: circumference }}
                  animate={{ strokeDashoffset }}
                  transition={{ duration: 1.4, ease: 'easeOut' }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <motion.span
                  key={Math.round(safeRate)}
                  initial={{ scale: 1.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className={`text-3xl font-black ${ringColor}`}
                >
                  <AnimatedCounter value={Math.round(safeRate)} />
                </motion.span>
                <span className="text-[10px] text-muted-foreground font-medium">%</span>
              </div>
            </div>

            {/* Stats alongside the ring */}
            <div className="flex-1 space-y-2.5">
              {sideStats.map((stat, idx) => {
                const Icon = stat.icon;
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.4 + idx * 0.1 }}
                    className={`flex items-center gap-2.5 p-2.5 rounded-xl ${stat.bg}`}
                  >
                    <Icon className={`h-4 w-4 ${stat.iconColor} flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[9px] text-muted-foreground">{stat.label}</p>
                      <p className="text-sm font-bold text-foreground">
                        <AnimatedCounter value={stat.value} />
                        {stat.suffix && <span className="text-[10px] font-normal text-muted-foreground ms-0.5">{stat.suffix}</span>}
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* Efficiency label — enhanced */}
          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t('completionRateStat')}</p>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-gray-50 dark:bg-gray-800">
              <span className="text-xs">{efficiencyIcon}</span>
              <span className={`text-xs font-semibold ${ringColor}`}>{efficiencyLabel}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
