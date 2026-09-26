'use client';

// ─── Task 42-e: KPI card grid for the Analytics section ─────────────────────
//
// 8 KPIs from the dashboard contract. Delta chips: ▲/▼ + value, emerald when
// the change is GOOD for the agency, rose when bad. Falling no-show rate and
// falling wait time are GOOD (invert=true); the noShowRate delta is in
// percentage POINTS, every other delta is a PERCENT change (contract).
// Null deltas (no previous-period data) render no chip at all.

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent } from '@/components/ui/card';
import {
  ClipboardList,
  CircleCheckBig,
  Percent,
  UserX,
  Clock,
  Timer,
  Star,
  Users,
  TrendingUp,
  TrendingDown,
  Minus,
  type LucideIcon,
} from 'lucide-react';
import { AnimatedCounter } from '@/components/agency/dashboard/helpers';
import { ak } from './i18n-keys';
import type { AnalyticsKpis } from './types';

// ─── Decimal-aware count-up (AnimatedCounter in dashboard/helpers.tsx only
// renders integers — rates and averages need 1 decimal). Same easing. ───────
function AnimatedValue({ value, decimals = 1, duration = 800 }: { value: number; decimals?: number; duration?: number }) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const start = prevRef.current;
    const end = value;
    if (start === end) return;
    const startTime = performance.now();
    let rafId = 0;
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(start + (end - start) * eased);
      if (progress < 1) rafId = requestAnimationFrame(animate);
      else prevRef.current = end;
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [value, duration]);

  return <>{display.toFixed(decimals)}</>;
}

type DeltaGoodness = 'good' | 'bad' | 'neutral';

function deltaClass(goodness: DeltaGoodness): string {
  switch (goodness) {
    case 'good':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
    case 'bad':
      return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400';
    default:
      return 'bg-muted/60 text-muted-foreground';
  }
}

/** Delta chip — `invert` marks metrics where FALLING is good (no-show, wait). */
function DeltaChip({ delta, unit, invert }: { delta: number | null; unit: '%' | 'pp'; invert: boolean }) {
  const { t } = useLanguage();
  if (delta === null || !Number.isFinite(delta)) return null;
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold bg-muted/60 text-muted-foreground" title={t(ak('analyticsSection.deltaVsPrev'))}>
        <Minus className="h-3 w-3" />
        0{unit === 'pp' ? 'pp' : '%'}
      </span>
    );
  }
  const up = rounded > 0;
  const good = invert ? rounded < 0 : rounded > 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${deltaClass(good ? 'good' : 'bad')}`}
      title={t(ak('analyticsSection.deltaVsPrev'))}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(rounded).toFixed(Math.abs(rounded) % 1 === 0 ? 0 : 1)}
      {unit === 'pp' ? 'pp' : '%'}
    </span>
  );
}

interface KpiCardProps {
  icon: LucideIcon;
  iconClass: string;      // chip bg + icon color (semantic palette)
  label: string;
  valueNode: React.ReactNode;
  delta?: { value: number | null; unit: '%' | 'pp'; invert: boolean };
}

function KpiCard({ icon: Icon, iconClass, label, valueNode, delta }: KpiCardProps) {
  const { t } = useLanguage();
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${iconClass}`}>
            <Icon className="h-4 w-4" />
          </div>
          {delta && <DeltaChip delta={delta.value} unit={delta.unit} invert={delta.invert} />}
        </div>
        <p className="mt-2 text-xl sm:text-2xl font-black text-foreground leading-none" dir="ltr">
          {valueNode}
        </p>
        <p className="mt-1.5 text-[11px] font-medium text-muted-foreground truncate">{label}</p>
      </CardContent>
    </Card>
  );
}

export function KpiCards({ kpis }: { kpis: AnalyticsKpis }) {
  const { t } = useLanguage();

  const safeNum = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const minSuffix = <span className="text-xs font-bold text-muted-foreground ms-0.5">{t('min')}</span>;
  const pctSuffix = <span className="text-xs font-bold text-muted-foreground ms-0.5">%</span>;

  const cards: KpiCardProps[] = [
    {
      icon: ClipboardList,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      label: t('totalReservations'),
      valueNode: <AnimatedCounter value={safeNum(kpis.total)} />,
      delta: { value: kpis.deltas?.total ?? null, unit: '%', invert: false },
    },
    {
      icon: CircleCheckBig,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      label: t('completed'),
      valueNode: <AnimatedCounter value={safeNum(kpis.completed)} />,
      delta: { value: kpis.deltas?.completed ?? null, unit: '%', invert: false },
    },
    {
      icon: Percent,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      label: t('completionRate'),
      valueNode: (
        <>
          <AnimatedValue value={safeNum(kpis.completionRate)} />
          {pctSuffix}
        </>
      ),
    },
    {
      icon: UserX,
      iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
      label: t('noShowRate'),
      valueNode: (
        <>
          <AnimatedValue value={safeNum(kpis.noShowRate)} />
          {pctSuffix}
        </>
      ),
      delta: { value: kpis.deltas?.noShowRate ?? null, unit: 'pp', invert: true },
    },
    {
      icon: Clock,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      label: t('avgWaitTime'),
      valueNode: (
        <>
          {kpis.avgWaitMinutes === null ? '—' : <AnimatedValue value={safeNum(kpis.avgWaitMinutes)} />}
          {kpis.avgWaitMinutes !== null && minSuffix}
        </>
      ),
      delta: { value: kpis.deltas?.avgWaitMinutes ?? null, unit: '%', invert: true },
    },
    {
      icon: Timer,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      label: t('avgServiceTime'),
      valueNode: (
        <>
          {kpis.avgServiceMinutes === null ? '—' : <AnimatedValue value={safeNum(kpis.avgServiceMinutes)} />}
          {kpis.avgServiceMinutes !== null && minSuffix}
        </>
      ),
    },
    {
      icon: Star,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      label: t('averageRating'),
      valueNode: kpis.avgRating === null ? '—' : <AnimatedValue value={safeNum(kpis.avgRating)} />,
      delta: { value: kpis.deltas?.avgRating ?? null, unit: '%', invert: false },
    },
    {
      icon: Users,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
      label: t(ak('analyticsSection.kpi.uniqueCustomers')),
      valueNode: <AnimatedCounter value={safeNum(kpis.uniqueCustomers)} />,
      delta: { value: kpis.deltas?.uniqueCustomers ?? null, unit: '%', invert: false },
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <KpiCard key={i} {...c} />
      ))}
    </div>
  );
}
