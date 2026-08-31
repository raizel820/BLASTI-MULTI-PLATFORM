'use client';

import { Users, Clock, CheckCircle2, AlertTriangle, TrendingUp, Timer, BarChart3, UserPlus, Layers, Zap } from 'lucide-react';
import { motion } from 'framer-motion';
import type { TranslationKeys } from '@/i18n';
import type { DashboardStats } from './types';
import { AnimatedCounter, MiniSparkline } from './helpers';

interface TodaysSummaryProps {
  stats: DashboardStats | null;
  safeCompletionRate: number;
  sparkData1: number[];
  sparkData2: number[];
  sparkData3: number[];
  t: (key: TranslationKeys) => string;
}

export function TodaysSummary({ stats, safeCompletionRate, sparkData1, sparkData2, sparkData3, t }: TodaysSummaryProps) {
  // Format peak hour for display
  const formatPeakHour = (peakHour?: string) => {
    if (!peakHour) return '—';
    return peakHour;
  };

  // Calculate no-show rate if not provided
  const noShowRate = stats?.noShowRate ?? (
    stats && stats.todayReservations > 0
      ? Math.round(((stats.noShowCount ?? 0) / stats.todayReservations) * 100)
      : 0
  );

  // Avg wait time display
  const avgWait = stats?.avgWaitTime ?? 0;
  const avgWaitDisplay = avgWait >= 60
    ? `${Math.floor(avgWait / 60)}h ${avgWait % 60}m`
    : `${avgWait}`;

  // Generate sparkline data for additional cards
  const sparkData4 = stats?.avgWaitTime ? [Math.round(stats.avgWaitTime * 0.7), Math.round(stats.avgWaitTime * 0.6), stats.avgWaitTime, Math.round(stats.avgWaitTime * 0.8), stats.avgWaitTime, Math.round(stats.avgWaitTime * 0.9), Math.round(stats.avgWaitTime * 0.7)] : [5, 4, 8, 6, 10, 8, 6];

  // Summary card configurations
  const summaryCards = [
    {
      key: 'total',
      icon: Users,
      label: t('totalToday'),
      value: stats?.todayReservations ?? 0,
      gradient: 'from-emerald-500 to-emerald-700',
      glowColor: 'bg-emerald-400/30',
      shadowColor: 'shadow-emerald-500/15',
      sparkData: sparkData1,
      sparkColor: 'bg-emerald-300',
      iconBg: 'bg-white/20',
      iconColor: 'text-emerald-100',
      labelColor: 'text-emerald-200',
      delay: 0.05,
    },
    {
      key: 'waiting',
      icon: Clock,
      label: t('queueLengthShort'),
      value: stats?.currentlyWaiting ?? 0,
      gradient: 'from-amber-500 to-amber-700',
      glowColor: 'bg-amber-400/30',
      shadowColor: 'shadow-amber-500/15',
      sparkData: sparkData2,
      sparkColor: 'bg-amber-300',
      iconBg: 'bg-white/20',
      iconColor: 'text-amber-100',
      labelColor: 'text-amber-200',
      delay: 0.08,
    },
    {
      key: 'served',
      icon: CheckCircle2,
      label: t('customersServed'),
      value: stats?.servedToday ?? 0,
      gradient: 'from-teal-500 to-teal-700',
      glowColor: 'bg-teal-400/30',
      shadowColor: 'shadow-teal-500/15',
      sparkData: sparkData3,
      sparkColor: 'bg-teal-300',
      iconBg: 'bg-white/20',
      iconColor: 'text-teal-100',
      labelColor: 'text-teal-200',
      delay: 0.11,
    },
    {
      key: 'noshow',
      icon: AlertTriangle,
      label: t('noShowRateStat'),
      value: noShowRate,
      suffix: '%',
      gradient: 'from-rose-500 to-rose-700',
      glowColor: 'bg-rose-400/30',
      shadowColor: 'shadow-rose-500/15',
      sparkData: sparkData4,
      sparkColor: 'bg-rose-300',
      iconBg: 'bg-white/20',
      iconColor: 'text-rose-100',
      labelColor: 'text-rose-200',
      delay: 0.14,
    },
    {
      key: 'walkin',
      icon: UserPlus,
      label: t('walkInCount' as any) || 'Walk-ins',
      value: stats?.walkInCount ?? 0,
      gradient: 'from-emerald-600 to-teal-600',
      glowColor: 'bg-teal-400/30',
      shadowColor: 'shadow-teal-500/15',
      iconBg: 'bg-white/20',
      iconColor: 'text-teal-100',
      labelColor: 'text-teal-200',
      delay: 0.17,
    },
    {
      key: 'counters',
      icon: Layers,
      label: t('activeCounters' as any) || 'Active Counters',
      value: stats?.activeCounters ?? 1,
      gradient: 'from-amber-600 to-rose-600',
      glowColor: 'bg-amber-400/30',
      shadowColor: 'shadow-amber-500/15',
      iconBg: 'bg-white/20',
      iconColor: 'text-amber-100',
      labelColor: 'text-amber-200',
      delay: 0.2,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      {summaryCards.map((card) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.key}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: card.delay, duration: 0.4, ease: 'easeOut' }}
          >
            <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${card.gradient} p-3 text-white shadow-lg ${card.shadowColor}`}>
              {/* Decorative glow */}
              <div className={`absolute -top-3 -start-3 h-14 w-14 rounded-full ${card.glowColor} blur-xl`} />
              {/* Decorative corner circle */}
              <div className="absolute -top-4 -end-4 h-10 w-10 rounded-full bg-white/5" />

              <div className="relative flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className={`h-6 w-6 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                      <Icon className={`h-3 w-3 ${card.iconColor}`} />
                    </div>
                    <span className={`text-[9px] ${card.labelColor} font-medium`}>{card.label}</span>
                  </div>
                  <div className="flex items-baseline gap-0.5">
                    <p className="text-xl sm:text-2xl font-black leading-none">
                      <AnimatedCounter value={card.value} />
                    </p>
                    {card.suffix && <span className="text-sm font-semibold">{card.suffix}</span>}
                  </div>
                </div>
                {card.sparkData && (
                  <MiniSparkline data={card.sparkData} color={card.sparkColor!} />
                )}
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
