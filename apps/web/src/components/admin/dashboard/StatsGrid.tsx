'use client';

import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/hooks/use-language';
import {
  Building2,
  Users,
  Calendar,
  CreditCard,
  Clock,
  UserPlus,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { AnimatedCounter } from './animated-counter';
import type { AdminStats } from './types';

interface StatsGridProps {
  stats: AdminStats | null;
}

export function StatsGrid({ stats }: StatsGridProps) {
  const { t } = useLanguage();

  // Mini sparkline data for "Last 7 Days" (7 data points)
  const sparklines7d = [
    [3, 5, 4, 7, 6, 8, 9],
    [2, 4, 3, 5, 6, 4, 7],
    [1, 3, 5, 4, 7, 6, 8],
    [4, 3, 5, 6, 5, 7, 8],
    [2, 1, 3, 2, 4, 3, 2],
    [3, 4, 5, 6, 5, 7, 9],
  ];

  // Trend data (percentage change from "last period")
  const trends = [
    { change: 12, positive: true },   // Total Agencies
    { change: 8, positive: true },    // Active Queues
    { change: -3, positive: false },  // Daily Reservations
    { change: 15, positive: true },   // Total Revenue
    { change: -5, positive: false },  // Pending Transactions
    { change: 20, positive: true },   // Total Users
  ];

  const statCards = [
    {
      label: t('totalAgencies'),
      numericValue: stats?.totalAgencies ?? 0,
      prefix: '',
      suffix: '',
      icon: Building2,
      gradient: 'from-emerald-500/10 to-emerald-600/5',
      iconGradient: 'from-emerald-400 to-emerald-600',
      sparkColor: '#10b981',
      isPending: false,
    },
    {
      label: t('activeQueues'),
      numericValue: stats?.activeQueues ?? 0,
      prefix: '',
      suffix: '',
      icon: Users,
      gradient: 'from-teal-500/10 to-teal-600/5',
      iconGradient: 'from-teal-400 to-teal-600',
      sparkColor: '#14b8a6',
      isPending: false,
    },
    {
      label: t('dailyReservations'),
      numericValue: stats?.dailyReservations ?? 0,
      prefix: '',
      suffix: '',
      icon: Calendar,
      gradient: 'from-emerald-500/10 to-teal-600/5',
      iconGradient: 'from-emerald-400 to-teal-500',
      sparkColor: '#10b981',
      isPending: false,
    },
    {
      label: t('totalRevenue'),
      numericValue: stats?.totalRevenue ?? 0,
      prefix: '',
      suffix: ` ${t('currency')}`,
      icon: CreditCard,
      gradient: 'from-amber-500/10 to-amber-600/5',
      iconGradient: 'from-amber-400 to-amber-600',
      sparkColor: '#f59e0b',
      isPending: false,
    },
    {
      label: t('pendingTransactions'),
      numericValue: stats?.pendingTransactions ?? 0,
      prefix: '',
      suffix: '',
      icon: Clock,
      gradient: 'from-amber-500/10 to-amber-600/5',
      iconGradient: 'from-amber-400 to-amber-600',
      sparkColor: '#f59e0b',
      isPending: true,
    },
    {
      label: t('totalUsers'),
      numericValue: stats?.totalUsers ?? 0,
      prefix: '',
      suffix: '',
      icon: UserPlus,
      gradient: 'from-emerald-500/10 to-teal-600/5',
      iconGradient: 'from-emerald-400 to-teal-500',
      sparkColor: '#10b981',
      isPending: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3 lg:gap-4">
      {statCards.map((stat, idx) => {
        const Icon = stat.icon;
        const spark = sparklines7d[idx] ?? sparklines7d[0];
        const trend = trends[idx];
        const minVal = Math.min(...spark);
        const maxVal = Math.max(...spark);
        const range = maxVal - minVal || 1;
        // SVG sparkline for header area
        const headerPoints = spark.map((v, i) => `${(i / (spark.length - 1)) * 60},${20 - ((v - minVal) / range) * 16}`).join(' ');
        // Full "Last 7 Days" sparkline below card
        const fullSparkW = 120;
        const fullSparkH = 32;
        const fullPoints = spark.map((v, i) => {
          const x = (i / (spark.length - 1)) * fullSparkW;
          const y = fullSparkH - 4 - ((v - minVal) / range) * (fullSparkH - 8);
          return `${x},${y}`;
        }).join(' ');
        const areaPoints = `${fullPoints} ${fullSparkW},${fullSparkH} 0,${fullSparkH}`;
        // Day labels
        const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

        return (
          <motion.div
            key={idx}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.08 }}
            whileHover={{ scale: 1.03, y: -4 }}
            className="cursor-default"
          >
            <div className="rounded-2xl p-[1px] bg-gradient-to-br from-emerald-200/40 via-transparent to-teal-200/40 dark:from-emerald-700/20 dark:via-transparent dark:to-teal-700/20 group">
              <Card className="border-0 shadow-sm hover:shadow-xl hover:shadow-emerald-500/8 transition-all duration-300 hover:-translate-y-1.5 bg-white dark:bg-gray-900/90 rounded-[14px] overflow-hidden">
                {/* Gradient top accent */}
                <div className={`h-1 bg-gradient-to-r ${stat.isPending ? 'from-amber-400 to-amber-500' : 'from-emerald-400 to-teal-500'}`} />
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${stat.iconGradient} flex items-center justify-center shadow-sm transition-transform duration-300 group-hover:scale-110`}>
                      <Icon className="h-5 w-5 text-white" />
                    </div>
                    {/* Header sparkline + trend arrow */}
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 60 20" className="w-14 h-5 opacity-60" fill="none">
                        <polyline points={headerPoints} stroke={stat.sparkColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <div className={`flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        trend.positive
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      }`}>
                        {trend.positive ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {trend.positive ? '+' : ''}{trend.change}%
                      </div>
                    </div>
                  </div>
                  <p className="text-2xl font-bold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent number-animate mb-0.5">
                    <AnimatedCounter value={stat.numericValue} prefix={stat.prefix} suffix={stat.suffix} />
                  </p>
                  <p className="text-xs text-muted-foreground mb-2">{stat.label}</p>
                  {/* Last 7 Days sparkline */}
                  <div className="border-t border-border/50 pt-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[9px] text-muted-foreground font-medium">{t('last7Days')}</span>
                    </div>
                    <svg viewBox={`0 0 ${fullSparkW} ${fullSparkH}`} className="w-full h-7" fill="none">
                      <polyline points={areaPoints} fill={stat.sparkColor} fillOpacity="0.1" />
                      <polyline points={fullPoints} stroke={stat.sparkColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      {/* End dot */}
                      <circle
                        cx={fullSparkW}
                        cy={fullSparkH - 4 - ((spark[spark.length - 1] - minVal) / range) * (fullSparkH - 8)}
                        r="2.5"
                        fill={stat.sparkColor}
                      />
                    </svg>
                    <div className="flex justify-between mt-0.5">
                      {dayLabels.map((d, i) => (
                        <span key={i} className={`text-[7px] ${i === spark.length - 1 ? 'font-bold text-foreground' : 'text-muted-foreground/50'}`}>{d}</span>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
