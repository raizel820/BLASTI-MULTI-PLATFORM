'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useRef, useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { motion, useInView } from 'framer-motion';
import {
  Building2,
  Users,
  TicketCheck,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ─── Animated Counter with dramatic bounce + sparkle ──────────── */
function AnimatedCounter({ target, suffix = '' }: { target: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });
  const [display, setDisplay] = useState(0);
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    if (!isInView) return;
    const duration = 2000;
    const startTime = performance.now();

    const ease = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = ease(progress);
      const current = Math.round(eased * target);
      setDisplay(current);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        setIsComplete(true);
      }
    };
    requestAnimationFrame(step);
  }, [isInView, target]);

  return (
    <span ref={ref} className="relative inline-flex items-center">
      <motion.span
        className="tabular-nums"
        initial={{ scale: 0.5, opacity: 0 }}
        animate={isInView ? { scale: [0.5, 1.15, 0.95, 1], opacity: 1 } : { scale: 0.5, opacity: 0 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      >
        {display.toLocaleString()}{suffix}
      </motion.span>
      {/* Sparkle burst when counter finishes */}
      {isComplete && (
        <motion.span
          initial={{ scale: 0, opacity: 1 }}
          animate={{ scale: [0, 1.5, 0], opacity: [1, 0.8, 0] }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
          className="absolute -top-2 -end-4"
        >
          <Sparkles className="h-4 w-4 text-amber-300" />
        </motion.span>
      )}
    </span>
  );
}

/* ─── Stats Data ──────────── */
interface StatItem {
  icon: LucideIcon;
  value: number;
  suffix: string;
  labelKey: 'landingStatAgencies' | 'landingStatUsers' | 'landingStatReservations';
}

export function StatsSection() {
  const { t } = useLanguage();
  const statsRef = useRef<HTMLDivElement>(null);
  const [landingStats, setLandingStats] = useState<{
    totalAgencies: number;
    totalCustomers: number;
    totalReservations: number;
    activeQueues: number;
  } | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await apiFetch('/api/stats');
        if (res.ok) {
          const data = await res.json();
          setLandingStats({
            totalAgencies: data.totalAgencies ?? 0,
            totalCustomers: data.totalCustomers ?? 0,
            totalReservations: data.totalReservations ?? 0,
            activeQueues: data.activeQueues ?? 0,
          });
        }
      } catch {
        // keep fallback values
      }
    };
    fetchStats();
  }, []);

  const stats: StatItem[] = [
    { icon: Building2, value: landingStats?.totalAgencies ?? 500, suffix: '+', labelKey: 'landingStatAgencies' },
    { icon: Users, value: landingStats?.totalCustomers ?? 10000, suffix: '+', labelKey: 'landingStatUsers' },
    { icon: TicketCheck, value: landingStats?.totalReservations ?? 0, suffix: '+', labelKey: 'landingStatReservations' },
  ];

  return (
    <motion.section
      ref={statsRef}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-50px' }}
      transition={{ duration: 0.5 }}
      className="w-full px-4 py-10 relative z-10"
    >
      <div className="max-w-3xl mx-auto">
        <div className="relative rounded-3xl overflow-hidden landing-stats-bg p-1">
          {/* Animated shine overlay */}
          <motion.div
            animate={{ backgroundPosition: ['0% 0%', '200% 0%'] }}
            transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
            className="absolute inset-0 bg-[length:200%_100%] bg-gradient-to-r from-emerald-300 via-teal-300 to-amber-300 opacity-20 rounded-3xl"
          />
          {/* Decorative mesh blobs inside stats card */}
          <motion.div
            animate={{ x: [0, 20, 0], y: [0, -10, 0] }}
            transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-0 start-0 w-40 h-40 bg-white/5 rounded-full blur-2xl"
          />
          <motion.div
            animate={{ x: [0, -15, 0], y: [0, 15, 0] }}
            transition={{ duration: 12, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
            className="absolute bottom-0 end-0 w-52 h-52 bg-teal-400/10 rounded-full blur-2xl"
          />
          <div className="relative rounded-[22px] bg-gradient-to-r from-emerald-600/90 to-teal-600/90 backdrop-blur-sm p-8 md:p-10 overflow-hidden">
            {/* Grid pattern overlay */}
            <div
              className="absolute inset-0 opacity-[0.03]"
              style={{
                backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
                backgroundSize: '24px 24px',
              }}
            />
            <div className="grid grid-cols-3 gap-6 text-center relative z-10">
              {stats.map((stat, idx) => {
                const Icon = stat.icon;
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, scale: 0.5, y: 20 }}
                    whileInView={{ opacity: 1, scale: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: idx * 0.15, type: 'spring', stiffness: 200 }}
                    className="flex flex-col items-center gap-3 group"
                  >
                    <motion.div
                      className="h-14 w-14 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center border border-white/10 relative"
                      whileHover={{ scale: 1.1, rotate: [0, -5, 5, 0] }}
                      transition={{ duration: 0.3 }}
                    >
                      {/* Pulse ring behind icon */}
                      <motion.div
                        className="absolute inset-0 rounded-2xl bg-white/10"
                        animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0, 0.3] }}
                        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.7 }}
                      />
                      <Icon className="h-6 w-6 text-white relative z-10" />
                    </motion.div>
                    <p className="text-3xl md:text-4xl font-black text-white">
                      <AnimatedCounter target={stat.value} suffix={stat.suffix} />
                    </p>
                    <p className="text-xs text-emerald-100 font-medium uppercase tracking-wider">{t(stat.labelKey)}</p>
                  </motion.div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </motion.section>
  );
}
