'use client';

import { useState, useEffect, useRef } from 'react';
import { UserPlus, Volume2, CircleCheckBig, Ban, Activity } from 'lucide-react';
import { motion } from 'framer-motion';
import type { QueueEntry, ServiceStat } from './types';

// ─── Animated Counter ────────────────────────────
export function AnimatedCounter({ value, duration = 800 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0);
  const prevValue = useRef(0);
  useEffect(() => {
    const start = prevValue.current;
    const end = value;
    if (start === end) return;
    const startTime = performance.now();
    let rafId: number;
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(start + (end - start) * eased));
      if (progress < 1) rafId = requestAnimationFrame(animate);
      else prevValue.current = end;
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [value, duration]);
  return <>{display}</>;
}

// ─── Mini Sparkline ──────────────────────────────
export function MiniSparkline({ data, color = 'bg-emerald-400' }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-0.5 h-7">
      {data.map((val, i) => (
        <motion.div
          key={i}
          initial={{ height: 0 }}
          animate={{ height: `${(val / max) * 100}%` }}
          transition={{ duration: 0.4, delay: i * 0.05 }}
          className={`flex-1 rounded-sm ${color} min-h-[2px]`}
        />
      ))}
    </div>
  );
}

// ─── Service Name Helpers ────────────────────────
export function getServiceName(entry: QueueEntry, lang: string) {
  if (lang === 'ar' && entry.serviceNameAr) return entry.serviceNameAr;
  if (lang === 'fr' && entry.serviceNameFr) return entry.serviceNameFr;
  return entry.serviceName;
}

export function getServiceDisplayName(s: ServiceStat, lang: string) {
  if (lang === 'ar' && s.nameAr) return s.nameAr;
  if (lang === 'fr' && s.nameFr) return s.nameFr;
  return s.name;
}

export function getAnalyticsServiceName(s: { serviceName: string; serviceNameAr?: string; serviceNameFr?: string }, lang: string) {
  if (lang === 'ar' && s.serviceNameAr) return s.serviceNameAr;
  if (lang === 'fr' && s.serviceNameFr) return s.serviceNameFr;
  return s.serviceName;
}

export function formatTime(dateStr: string, lang: string) {
  try {
    return new Date(dateStr).toLocaleTimeString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { hour: '2-digit', minute: '2-digit' }
    );
  } catch {
    return '';
  }
}

export function getLocale(lang: string) {
  return lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';
}

// ─── Event Config Helper ────────────────────────
export function getEventConfig(eventType: string) {
  switch (eventType) {
    case 'joined':
      return { icon: UserPlus, color: 'bg-emerald-500', dotColor: 'bg-emerald-500', badgeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400', label: 'Joined' };
    case 'called':
      return { icon: Volume2, color: 'bg-sky-500', dotColor: 'bg-sky-500', badgeClass: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400', label: 'Called' };
    case 'completed':
      return { icon: CircleCheckBig, color: 'bg-gray-400', dotColor: 'bg-gray-400', badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', label: 'Done' };
    case 'cancelled':
      return { icon: Ban, color: 'bg-red-500', dotColor: 'bg-red-500', badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', label: 'Cancelled' };
    default:
      return { icon: Activity, color: 'bg-gray-400', dotColor: 'bg-gray-400', badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', label: 'Action' };
  }
}
