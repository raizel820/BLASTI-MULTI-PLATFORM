'use client';

import { motion } from 'framer-motion';
import { Clock } from 'lucide-react';

interface ETABadgeProps {
  minutes: number;
  lang: string;
  minLabel: string;
}

export function ETABadge({ minutes, lang, minLabel }: ETABadgeProps) {
  // Color code: green (<10min), yellow (10-25min), red (>25min)
  const config = minutes <= 10
    ? { bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500' }
    : minutes <= 25
      ? { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' }
      : { bg: 'bg-rose-100 dark:bg-rose-900/30', text: 'text-rose-700 dark:text-rose-400', dot: 'bg-rose-500' };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${config.bg} ${config.text} text-[10px] font-semibold`}
    >
      <Clock className="h-2.5 w-2.5" />
      <span>~{minutes} {minLabel}</span>
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
    </motion.div>
  );
}
