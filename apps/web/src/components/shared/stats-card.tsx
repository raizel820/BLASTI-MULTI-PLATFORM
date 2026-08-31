'use client';

import { motion } from 'framer-motion';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

type TrendDirection = 'up' | 'down' | 'neutral';
type ColorScheme = 'emerald' | 'teal' | 'amber' | 'rose';

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: TrendDirection;
  trendValue?: string;
  color?: ColorScheme;
  className?: string;
}

const colorConfig: Record<
  ColorScheme,
  {
    iconBg: string;
    iconText: string;
    trendUp: string;
    trendDown: string;
  }
> = {
  emerald: {
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/30',
    iconText: 'text-emerald-600 dark:text-emerald-400',
    trendUp: 'text-emerald-600 dark:text-emerald-400',
    trendDown: 'text-rose-600 dark:text-rose-400',
  },
  teal: {
    iconBg: 'bg-teal-100 dark:bg-teal-900/30',
    iconText: 'text-teal-600 dark:text-teal-400',
    trendUp: 'text-teal-600 dark:text-teal-400',
    trendDown: 'text-rose-600 dark:text-rose-400',
  },
  amber: {
    iconBg: 'bg-amber-100 dark:bg-amber-900/30',
    iconText: 'text-amber-600 dark:text-amber-400',
    trendUp: 'text-emerald-600 dark:text-emerald-400',
    trendDown: 'text-rose-600 dark:text-rose-400',
  },
  rose: {
    iconBg: 'bg-rose-100 dark:bg-rose-900/30',
    iconText: 'text-rose-600 dark:text-rose-400',
    trendUp: 'text-emerald-600 dark:text-emerald-400',
    trendDown: 'text-rose-600 dark:text-rose-400',
  },
};

const trendIcons: Record<TrendDirection, typeof TrendingUp> = {
  up: TrendingUp,
  down: TrendingDown,
  neutral: Minus,
};

export function StatsCard({
  title,
  value,
  icon: Icon,
  trend,
  trendValue,
  color = 'emerald',
  className,
}: StatsCardProps) {
  const colors = colorConfig[color];
  const TrendIcon = trend ? trendIcons[trend] : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-white/80 dark:bg-gray-900/50 backdrop-blur-sm p-5',
        'transition-all duration-300',
        'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/[0.04] dark:hover:shadow-black/[0.2]',
        'dark:border-gray-800',
        className
      )}
    >
      {/* Subtle glass highlight */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/10" />

      <div className="flex items-start justify-between">
        <div className="space-y-2 min-w-0">
          <p className="text-sm font-medium text-muted-foreground truncate">
            {title}
          </p>
          <p className="text-3xl font-bold tracking-tight text-foreground tabular-nums">
            {value}
          </p>
        </div>

        {/* Icon */}
        <div
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-110',
            colors.iconBg
          )}
        >
          <Icon className={cn('h-5 w-5', colors.iconText)} />
        </div>
      </div>

      {/* Trend indicator */}
      {trend && trendValue && (
        <div className="mt-3 flex items-center gap-1.5">
          {TrendIcon && (
            <TrendIcon
              className={cn(
                'h-4 w-4',
                trend === 'up'
                  ? colors.trendUp
                  : trend === 'down'
                    ? colors.trendDown
                    : 'text-muted-foreground'
              )}
            />
          )}
          <span
            className={cn(
              'text-sm font-medium',
              trend === 'up'
                ? colors.trendUp
                : trend === 'down'
                  ? colors.trendDown
                  : 'text-muted-foreground'
            )}
          >
            {trendValue}
          </span>
        </div>
      )}
    </motion.div>
  );
}
