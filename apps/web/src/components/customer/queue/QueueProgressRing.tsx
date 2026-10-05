'use client';

import { motion } from 'framer-motion';
import { Radio } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import type { Reservation } from './types';

interface QueueProgressRingProps {
  reservation: Reservation;
  isCalled: boolean;
  ringCircumference: number;
  ringRadius: number;
  ringDashOffset: number;
  /** Task 79-a compact variant (hero card side-by-side layout) */
  compact?: boolean;
}

// Dynamic font sizing for queue numbers based on string length
const getQueueRingClass = (qNum: string, compact: boolean) => {
  const len = qNum.length;
  if (compact) {
    if (len > 7) return 'text-[10px] font-black';
    if (len > 4) return 'text-sm font-black';
    return 'text-xl font-black';
  }
  if (len > 7) return 'text-xs sm:text-sm font-black';
  if (len > 4) return 'text-base sm:text-lg font-black';
  return 'text-2xl sm:text-3xl font-black';
};

export function QueueProgressRing({
  reservation,
  isCalled,
  ringCircumference,
  ringRadius,
  ringDashOffset,
  compact = false,
}: QueueProgressRingProps) {
  const { t } = useLanguage();

  return (
    <div className={compact ? 'flex justify-center flex-shrink-0' : 'flex justify-center mb-4'}>
      <div className="relative">
        <svg className={compact ? 'h-28 w-28' : 'h-32 w-32 sm:h-36 sm:w-36'} viewBox="0 0 120 120">
          <defs>
            <linearGradient
              id={`ring-grad-${reservation.id}`}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="0%"
            >
              <stop offset="0%" stopColor="#10b981" />
              <stop offset="50%" stopColor="#14b8a6" />
              <stop offset="100%" stopColor="#0d9488" />
            </linearGradient>
            {isCalled && (
              <filter id={`glow-${reservation.id}`}>
                <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            )}
          </defs>
          {/* Background track */}
          <circle
            cx="60"
            cy="60"
            r={ringRadius}
            fill="none"
            strokeWidth={compact ? '9' : '8'}
            className="stroke-gray-200 dark:stroke-gray-700"
          />
          {/* Progress arc */}
          <circle
            cx="60"
            cy="60"
            r={ringRadius}
            fill="none"
            stroke={`url(#ring-grad-${reservation.id})`}
            strokeWidth={compact ? '9' : '8'}
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            transform="rotate(-90, 60, 60)"
            style={{
              strokeDashoffset: ringDashOffset,
              transition: 'stroke-dashoffset 1s ease-out',
            }}
            filter={isCalled ? `url(#glow-${reservation.id})` : undefined}
          />
        </svg>
        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {isCalled && (
            <motion.div
              animate={{ scale: [1, 1.3, 1] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute -top-1 -end-1 z-10"
            >
              <div className="h-3 w-3 rounded-full bg-red-500 flex items-center justify-center">
                <div className="h-1.5 w-1.5 rounded-full bg-white" />
              </div>
            </motion.div>
          )}
          <span className={`${getQueueRingClass(reservation.queueNumber, compact)} text-foreground tracking-tight leading-tight`}>
            {reservation.queueNumber}
          </span>
          <span className={`text-muted-foreground uppercase tracking-wider ${compact ? 'text-[8px]' : 'text-[9px] sm:text-[10px]'} mt-0.5`}>
            {t('yourQueueNumber')}
          </span>
          {/* Live indicator */}
          <div className="flex items-center gap-1 mt-1">
            <Radio className={`text-emerald-600 dark:text-emerald-400 ${compact ? 'h-2 w-2' : 'h-2.5 w-2.5'}`} />
            <span className={`font-medium text-emerald-600 dark:text-emerald-400 uppercase ${compact ? 'text-[8px]' : 'text-[9px]'}`}>
              {t('live')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
