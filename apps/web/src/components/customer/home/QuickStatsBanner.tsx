'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { TicketCheck, Clock, CalendarDays, Building2 } from 'lucide-react';
import type { ActiveReservation } from './types';

interface QuickStatsBannerProps {
  firstName: string;
  greeting: string;
  greetingMessage: string;
  openAgencyCount: number;
  totalWaitingCount: number;
  activeReservations: ActiveReservation[];
  onBannerClick: () => void;
  t: (key: import("@/i18n").TranslationKeys) => string;
}

// Animated counter hook
function useAnimatedCounter(target: number, duration: number = 1200, inView: boolean) {
  const [count, setCount] = useState(0);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!inView || target === 0) {
      // Use a micro-task to avoid synchronous setState in effect
      const raf = requestAnimationFrame(() => setCount(target));
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

const statCards = [
  {
    key: 'statsQueuePosition' as const,
    icon: TicketCheck,
    gradient: 'from-emerald-500/90 to-emerald-600/90',
    iconBg: 'bg-white/20',
    getValue: (props: QuickStatsBannerProps) =>
      props.activeReservations.length > 0 ? props.activeReservations[0].position : 0,
    getLabel: (props: QuickStatsBannerProps) => props.t('statsQueuePosition'),
    show: (props: QuickStatsBannerProps) => props.activeReservations.length > 0,
  },
  {
    key: 'statsWaitTime' as const,
    icon: Clock,
    gradient: 'from-teal-500/90 to-teal-600/90',
    iconBg: 'bg-white/20',
    getValue: (props: QuickStatsBannerProps) => props.totalWaitingCount,
    getLabel: (props: QuickStatsBannerProps) => props.t('statsWaitTime'),
    show: () => true,
  },
  {
    key: 'statsTotalVisits' as const,
    icon: CalendarDays,
    gradient: 'from-cyan-500/90 to-cyan-600/90',
    iconBg: 'bg-white/20',
    getValue: (props: QuickStatsBannerProps) => props.activeReservations.length,
    getLabel: (props: QuickStatsBannerProps) => props.t('statsTotalVisits'),
    show: () => true,
  },
  {
    key: 'statsOpenAgencies' as const,
    icon: Building2,
    gradient: 'from-emerald-400/90 to-green-500/90',
    iconBg: 'bg-white/20',
    getValue: (props: QuickStatsBannerProps) => props.openAgencyCount,
    getLabel: (props: QuickStatsBannerProps) => props.t('statsOpenAgencies'),
    show: (props: QuickStatsBannerProps) => props.openAgencyCount > 0,
  },
];

export function QuickStatsBanner({
  firstName,
  greeting,
  greetingMessage,
  openAgencyCount,
  totalWaitingCount,
  activeReservations,
  onBannerClick,
  t,
}: QuickStatsBannerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { once: true, margin: '-50px' });

  if (!firstName) return null;

  const visibleCards = statCards.filter(card => card.show({ firstName, greeting, greetingMessage, openAgencyCount, totalWaitingCount, activeReservations, onBannerClick, t }));

  return (
    <motion.div
      ref={containerRef}
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="mb-4"
    >
      {/* Greeting Banner */}
      <button
        type="button"
        onClick={onBannerClick}
        className="w-full text-start rounded-2xl bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 px-5 py-4 shadow-lg shadow-emerald-500/20 active:scale-[0.98] transition-transform cursor-pointer relative overflow-hidden mb-3"
      >
        {/* Subtle dot pattern */}
        <div className="absolute inset-0 opacity-[0.05]" style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
          backgroundSize: '20px 20px',
        }} />
        <div className="relative">
          <div className="flex items-center justify-between mb-1">
            <p className="text-lg font-bold text-white">
              {greeting}, {firstName}! 👋
            </p>
            <div className="flex items-center gap-2">
              {openAgencyCount > 0 && (
                <span className="text-[10px] bg-white/20 text-white px-2 py-0.5 rounded-full">
                  {openAgencyCount} {t('agenciesNearbyStat')}
                </span>
              )}
            </div>
          </div>
          <p className="text-sm text-emerald-100">{greetingMessage}</p>
          {/* Mini queue status */}
          {activeReservations.length > 0 && (
            <div className="mt-3 bg-white/15 backdrop-blur-sm rounded-xl p-2.5 flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-white/20 flex items-center justify-center flex-shrink-0">
                <TicketCheck className="h-4 w-4 text-white" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-white truncate">
                  {activeReservations[0].agencyName}
                </p>
                <p className="text-[10px] text-emerald-100">
                  #{activeReservations[0].position} · {totalWaitingCount} {t('waitingInQueueStat')}
                </p>
              </div>
              <motion.div
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                className="h-2 w-2 rounded-full bg-emerald-300 pulse-ring"
              />
            </div>
          )}
        </div>
      </button>

      {/* Stats Cards Row — glassmorphic with gradient + backdrop blur */}
      {visibleCards.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {visibleCards.map((card, idx) => {
            const value = card.getValue({ firstName, greeting, greetingMessage, openAgencyCount, totalWaitingCount, activeReservations, onBannerClick, t });
            return (
              <StatCard
                key={card.key}
                card={card}
                value={value}
                idx={idx}
                isInView={isInView}
                t={t}
              />
            );
          })}
        </div>
      )}
    </motion.div>
  );
}

function StatCard({
  card,
  value,
  idx,
  isInView,
  t,
}: {
  card: typeof statCards[number];
  value: number;
  idx: number;
  isInView: boolean;
  t: (key: import("@/i18n").TranslationKeys) => string;
}) {
  const animatedValue = useAnimatedCounter(value, 1000, isInView);
  const Icon = card.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 15, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, delay: idx * 0.08 }}
      className={`relative rounded-2xl overflow-hidden bg-gradient-to-br ${card.gradient} backdrop-blur-xl shadow-sm`}
    >
      {/* Glass overlay */}
      <div className="absolute inset-0 bg-white/10 dark:bg-black/10 backdrop-blur-md" />
      {/* Shimmer line at top */}
      <div className="absolute top-0 start-0 end-0 h-[2px] bg-gradient-to-r from-transparent via-white/40 to-transparent shimmer-slide" />
      <div className="relative p-3.5">
        <div className="flex items-center justify-between mb-2">
          <div className={`h-8 w-8 rounded-xl ${card.iconBg} flex items-center justify-center`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
        </div>
        <p className="text-2xl font-bold text-white tabular-nums">
          {animatedValue}
        </p>
        <p className="text-[10px] text-white/80 font-medium mt-0.5">
          {card.getLabel({ firstName: '', greeting: '', greetingMessage: '', openAgencyCount: 0, totalWaitingCount: 0, activeReservations: [], onBannerClick: () => {}, t })}
        </p>
      </div>
    </motion.div>
  );
}
