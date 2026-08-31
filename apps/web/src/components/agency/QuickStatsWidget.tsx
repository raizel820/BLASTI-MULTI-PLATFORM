'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { TicketCheck, Clock, CheckCircle2, Smile } from 'lucide-react';

interface QuickStatsWidgetProps {
  /** Number of currently active/waiting tickets */
  activeTickets?: number;
  /** Average wait time in minutes */
  averageWaitMinutes?: number;
  /** Number of completed tickets today */
  completedToday?: number;
  /** Customer satisfaction percentage (0-100) */
  satisfactionPercent?: number;
  /** Override stat values dynamically */
  stats?: Partial<QuickStatsData>;
}

interface QuickStatsData {
  activeTickets: number;
  averageWaitMinutes: number;
  completedToday: number;
  satisfactionPercent: number;
}

// Animated count-up hook
function useCountUp(target: number, duration: number = 1200, inView: boolean) {
  const [count, setCount] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!inView) {
      const raf = requestAnimationFrame(() => setCount(0));
      return () => cancelAnimationFrame(raf);
    }
    if (target === 0) {
      const raf = requestAnimationFrame(() => setCount(0));
      return () => cancelAnimationFrame(raf);
    }
    const startTime = performance.now();
    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(eased * target);
      setCount(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, inView]);

  return count;
}

const statDefinitions = [
  {
    key: 'activeTickets',
    icon: TicketCheck,
    label: 'تذاكر نشطة',
    gradient: 'from-emerald-500 to-emerald-600',
    iconBg: 'bg-white/20',
    iconColor: 'text-white',
    format: (v: number) => String(v),
  },
  {
    key: 'averageWait',
    icon: Clock,
    label: 'متوسط الانتظار',
    gradient: 'from-teal-500 to-teal-600',
    iconBg: 'bg-white/20',
    iconColor: 'text-white',
    format: (v: number) => `${v} د`,
  },
  {
    key: 'completedToday',
    icon: CheckCircle2,
    label: 'مكتمل اليوم',
    gradient: 'from-emerald-400 to-teal-500',
    iconBg: 'bg-white/20',
    iconColor: 'text-white',
    format: (v: number) => String(v),
  },
  {
    key: 'satisfaction',
    icon: Smile,
    label: 'رضا العملاء',
    gradient: 'from-teal-400 to-cyan-500',
    iconBg: 'bg-white/20',
    iconColor: 'text-white',
    format: (v: number) => `${v}%`,
  },
];

function StatMiniCard({
  statDef,
  value,
  idx,
  isInView,
}: {
  statDef: typeof statDefinitions[number];
  value: number;
  idx: number;
  isInView: boolean;
}) {
  const animatedValue = useCountUp(value, 1000, isInView);
  const Icon = statDef.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, delay: idx * 0.08 }}
      className={`relative rounded-2xl overflow-hidden bg-gradient-to-br ${statDef.gradient} shadow-sm`}
    >
      {/* Glass overlay for dark mode */}
      <div className="absolute inset-0 bg-white/5 dark:bg-black/15" />
      {/* Shimmer accent line */}
      <div className="absolute top-0 start-0 end-0 h-[2px] bg-gradient-to-r from-transparent via-white/40 to-transparent shimmer-slide" />
      <div className="relative p-3 sm:p-4">
        <div className={`h-7 w-7 sm:h-8 sm:w-8 rounded-lg ${statDef.iconBg} flex items-center justify-center mb-2`}>
          <Icon className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${statDef.iconColor}`} />
        </div>
        <p className="text-xl sm:text-2xl font-bold text-white tabular-nums leading-tight">
          {statDef.format(animatedValue)}
        </p>
        <p className="text-[10px] sm:text-xs text-white/80 font-medium mt-0.5">
          {statDef.label}
        </p>
      </div>
    </motion.div>
  );
}

export function QuickStatsWidget({
  activeTickets = 0,
  averageWaitMinutes = 0,
  completedToday = 0,
  satisfactionPercent = 0,
  stats,
}: QuickStatsWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: '-30px' });

  // Merge props with stats override
  const mergedStats: QuickStatsData = {
    activeTickets: stats?.activeTickets ?? activeTickets,
    averageWaitMinutes: stats?.averageWaitMinutes ?? averageWaitMinutes,
    completedToday: stats?.completedToday ?? completedToday,
    satisfactionPercent: stats?.satisfactionPercent ?? satisfactionPercent,
  };

  const values = [
    mergedStats.activeTickets,
    mergedStats.averageWaitMinutes,
    mergedStats.completedToday,
    mergedStats.satisfactionPercent,
  ];

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3"
    >
      {statDefinitions.map((statDef, idx) => (
        <StatMiniCard
          key={statDef.key}
          statDef={statDef}
          value={values[idx]}
          idx={idx}
          isInView={isInView}
        />
      ))}
    </motion.div>
  );
}
