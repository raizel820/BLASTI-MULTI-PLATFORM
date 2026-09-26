'use client';

// ─── Task 4: platform stats row (global + average scope only) ───────────────
// 4 platform cards fed by the dashboard payload's `platform` block:
// Total Agencies · Active Agencies · Total Customers · New Customers (period).

import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent } from '@/components/ui/card';
import { Activity, Building2, UserPlus, Users, type LucideIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { AnimatedCounter } from '@/components/agency/dashboard/helpers';
import { ak } from './i18n-keys';
import type { AdminPlatformStats } from './types';
import type { AnalyticsPeriod } from '@/components/agency/analytics/types';

function periodLabelKey(period: AnalyticsPeriod): string {
  switch (period) {
    case '7d':
      return 'analyticsSection.period7d';
    case '30d':
      return 'analyticsSection.period30d';
    case '90d':
      return 'analyticsSection.period90d';
    case '12m':
      return 'analyticsSection.period12m';
  }
}

interface PlatformCardProps {
  icon: LucideIcon;
  iconClass: string;
  label: string;
  value: number;
  delay: number;
}

function PlatformCard({ icon: Icon, iconClass, label, value, delay }: PlatformCardProps) {
  const safe = Number.isFinite(value) ? value : 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: 'easeOut' }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden h-full">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${iconClass}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xl sm:text-2xl font-black text-foreground leading-none" dir="ltr">
                <AnimatedCounter value={safe} />
              </p>
              <p className="mt-1 text-[11px] font-medium text-muted-foreground truncate" title={label}>
                {label}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function PlatformStatsRow({
  platform,
  period,
}: {
  platform: AdminPlatformStats;
  period: AnalyticsPeriod;
}) {
  const { t } = useLanguage();

  const safeNum = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const newCustomersLabel = t(ak('adminAnalytics.newCustomersInPeriod'), {
    period: t(ak(periodLabelKey(period))),
  });

  const cards: PlatformCardProps[] = [
    {
      icon: Building2,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      label: t('totalAgencies'),
      value: safeNum(platform.totalAgencies),
      delay: 0,
    },
    {
      icon: Activity,
      iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
      label: t('activeAgencies'),
      value: safeNum(platform.activeAgencies),
      delay: 0.05,
    },
    {
      icon: Users,
      iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
      label: t('totalCustomers'),
      value: safeNum(platform.totalCustomers),
      delay: 0.1,
    },
    {
      icon: UserPlus,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      label: newCustomersLabel,
      value: safeNum(platform.newCustomersInPeriod),
      delay: 0.15,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" role="list" aria-label={t('totalAgencies')}>
      {cards.map((c, i) => (
        <div key={i} role="listitem">
          <PlatformCard {...c} />
        </div>
      ))}
    </div>
  );
}
