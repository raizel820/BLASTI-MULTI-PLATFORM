'use client';

import { useEffect, useState } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import { Clock, TrendingDown, Users, Zap } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';

interface WaitTimePredictorProps {
  currentPosition: number;
  estimatedWaitMinutes: number;
  avgServiceTime: number;
  totalWaiting: number;
  agencyName?: string;
}

export function WaitTimePredictor({
  currentPosition,
  estimatedWaitMinutes,
  avgServiceTime,
  totalWaiting,
  agencyName,
}: WaitTimePredictorProps) {
  const { t, lang } = useLanguage();
  const [animatedMinutes, setAnimatedMinutes] = useState(0);

  // Gauge config: 0-60 min range, 180-degree semi-circle
  const maxMinutes = 60;
  const clampedMinutes = Math.min(estimatedWaitMinutes, maxMinutes);
  const needleAngle = (clampedMinutes / maxMinutes) * 180 - 90; // -90 to 90 degrees

  // Spring animation for the needle
  const springAngle = useSpring(-90, { stiffness: 80, damping: 20 });
  const needleRotate = useTransform(springAngle, (v: number) => v);

  useEffect(() => {
    const targetAngle = (clampedMinutes / maxMinutes) * 180 - 90;
    springAngle.set(targetAngle);
  }, [clampedMinutes, maxMinutes, springAngle]);

  // Animated counter for estimated minutes
  useEffect(() => {
    const duration = 1500;
    const startTime = Date.now();
    const startVal = animatedMinutes;
    const endVal = estimatedWaitMinutes;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      setAnimatedMinutes(Math.round(startVal + (endVal - startVal) * eased));
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [estimatedWaitMinutes]);

  // Color zone determination
  const getColorZone = () => {
    if (estimatedWaitMinutes <= 10) return { color: 'emerald', label: lang === 'ar' ? 'قصير' : 'Short', gradient: 'from-emerald-500 to-teal-500' };
    if (estimatedWaitMinutes <= 25) return { color: 'amber', label: lang === 'ar' ? 'متوسط' : 'Medium', gradient: 'from-amber-500 to-orange-500' };
    return { color: 'red', label: lang === 'ar' ? 'طويل' : 'Long', gradient: 'from-red-500 to-rose-500' };
  };

  const colorZone = getColorZone();

  // Best time recommendation based on peak hours
  const getBestTime = () => {
    const hour = new Date().getHours();
    if (hour >= 8 && hour < 10) return lang === 'ar' ? 'بعد 10 صباحاً' : 'After 10 AM';
    if (hour >= 11 && hour < 14) return lang === 'ar' ? 'بعد 2 ظهراً' : 'After 2 PM';
    if (hour >= 16 && hour < 19) return lang === 'ar' ? 'بعد 7 مساءً' : 'After 7 PM';
    return lang === 'ar' ? 'في الصباح الباكر' : 'Early morning';
  };

  // Gauge arc segments
  const gaugeSegments = [
    { start: -90, end: -60, color: '#10b981' }, // 0-10 min: emerald
    { start: -60, end: -15, color: '#f59e0b' }, // 10-25 min: amber
    { start: -15, end: 90, color: '#ef4444' },  // 25+ min: red
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="relative p-[1.5px] rounded-2xl bg-gradient-to-br from-emerald-300/80 via-teal-300/80 to-cyan-300/80 dark:from-emerald-600/50 dark:via-teal-600/50 dark:to-cyan-600/50"
    >
      <div className="bg-white dark:bg-gray-900 rounded-[14px] p-5 relative overflow-hidden">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.02] dark:opacity-[0.04]" style={{
          backgroundImage: 'radial-gradient(circle at 30% 30%, #10b981 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }} />

        <div className="relative">
          {/* Agency name */}
          {agencyName && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.1 }}
              className="text-sm font-semibold text-muted-foreground mb-3 text-center"
            >
              {agencyName}
            </motion.p>
          )}

          {/* Semi-circular Gauge Meter */}
          <div className="relative w-full max-w-[280px] mx-auto mb-4">
            <svg viewBox="0 0 200 120" className="w-full overflow-visible">
              {/* Background track */}
              <path
                d="M 20 100 A 80 80 0 0 1 180 100"
                fill="none"
                className="stroke-gray-200 dark:stroke-gray-700"
                strokeWidth="16"
                strokeLinecap="round"
              />

              {/* Colored segments */}
              {gaugeSegments.map((seg, i) => {
                const startRad = (seg.start * Math.PI) / 180;
                const endRad = (seg.end * Math.PI) / 180;
                const cx = 100, cy = 100, r = 80;
                const x1 = cx + r * Math.cos(startRad);
                const y1 = cy + r * Math.sin(startRad);
                const x2 = cx + r * Math.cos(endRad);
                const y2 = cy + r * Math.sin(endRad);
                const largeArc = seg.end - seg.start > 180 ? 1 : 0;
                return (
                  <path
                    key={i}
                    d={`M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`}
                    fill="none"
                    stroke={seg.color}
                    strokeWidth="16"
                    strokeLinecap="round"
                    opacity="0.3"
                  />
                );
              })}

              {/* Active arc up to current value */}
              <motion.path
                d="M 20 100 A 80 80 0 0 1 180 100"
                fill="none"
                className="stroke-emerald-500 dark:stroke-emerald-400"
                strokeWidth="16"
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: clampedMinutes / maxMinutes }}
                transition={{ duration: 1.5, ease: 'easeOut' }}
                style={{
                  filter: `drop-shadow(0 0 6px ${colorZone.color === 'emerald' ? '#10b981' : colorZone.color === 'amber' ? '#f59e0b' : '#ef4444'})`,
                }}
              />

              {/* Tick marks */}
              {Array.from({ length: 7 }).map((_, i) => {
                const angle = -90 + (i / 6) * 180;
                const rad = (angle * Math.PI) / 180;
                const cx = 100, cy = 100, r1 = 62, r2 = 67;
                return (
                  <line
                    key={i}
                    x1={cx + r1 * Math.cos(rad)}
                    y1={cy + r1 * Math.sin(rad)}
                    x2={cx + r2 * Math.cos(rad)}
                    y2={cy + r2 * Math.sin(rad)}
                    className="stroke-gray-400 dark:stroke-gray-500"
                    strokeWidth="1.5"
                  />
                );
              })}

              {/* Needle */}
              <g style={{ transformOrigin: '100px 100px' }}>
                <motion.line
                  x1="100"
                  y1="100"
                  x2="100"
                  y2="35"
                  className="stroke-gray-800 dark:stroke-gray-200"
                  strokeWidth="3"
                  strokeLinecap="round"
                  style={{ rotate: needleRotate }}
                  initial={{ rotate: -90 }}
                />
                {/* Needle center circle */}
                <circle
                  cx="100"
                  cy="100"
                  r="6"
                  className="fill-gray-800 dark:fill-gray-200"
                />
                <circle
                  cx="100"
                  cy="100"
                  r="3"
                  className="fill-white dark:fill-gray-900"
                />
              </g>

              {/* Zone labels */}
              <text x="30" y="115" className="fill-emerald-500 text-[10px] font-bold" textAnchor="middle">0</text>
              <text x="100" y="20" className="fill-amber-500 text-[10px] font-bold" textAnchor="middle">30</text>
              <text x="170" y="115" className="fill-red-500 text-[10px] font-bold" textAnchor="middle">60</text>
            </svg>

            {/* Current time display below gauge */}
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-center">
              <motion.div
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5, type: 'spring', stiffness: 200 }}
                className={`inline-flex items-baseline gap-1 px-4 py-1.5 rounded-full bg-gradient-to-r ${colorZone.gradient} text-white shadow-lg`}
              >
                <span className="text-2xl font-bold">{animatedMinutes}</span>
                <span className="text-xs font-medium">{t('min') || 'min'}</span>
              </motion.div>
            </div>
          </div>

          {/* Queue Position */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="flex items-center justify-center gap-4 mb-4"
          >
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-100/50 dark:border-emerald-800/30">
              <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <div>
                <p className="text-[10px] text-muted-foreground">{t('yourPosition') || 'Your position'}</p>
                <p className="text-sm font-bold text-foreground">#{currentPosition}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-br from-teal-50 to-cyan-50 dark:from-teal-900/20 dark:to-cyan-900/20 border border-teal-100/50 dark:border-teal-800/30">
              <Clock className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              <div>
                <p className="text-[10px] text-muted-foreground">{t('avgServiceTime') || 'Avg. service'}</p>
                <p className="text-sm font-bold text-foreground">{avgServiceTime} {t('min') || 'min'}</p>
              </div>
            </div>
          </motion.div>

          {/* Wait Zone Status */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="flex items-center justify-center gap-2 mb-4"
          >
            <div className={`h-2.5 w-2.5 rounded-full bg-gradient-to-r ${colorZone.gradient} ${colorZone.color === 'emerald' ? 'animate-pulse' : ''}`} />
            <span className="text-sm font-semibold text-foreground">
              {lang === 'ar' ? 'وقت الانتظار:' : 'Wait time:'}{' '}
              <span className={`bg-gradient-to-r ${colorZone.gradient} bg-clip-text text-transparent`}>
                {colorZone.label}
              </span>
            </span>
          </motion.div>

          {/* Best Time Recommendation */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.8 }}
            className="p-3 rounded-xl bg-gradient-to-br from-emerald-50/80 via-teal-50/80 to-cyan-50/80 dark:from-emerald-900/15 dark:via-teal-900/15 dark:to-cyan-900/15 border border-emerald-200/30 dark:border-emerald-700/20"
          >
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center flex-shrink-0 shadow-sm">
                <Zap className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  {lang === 'ar' ? 'أفضل وقت للزيارة' : 'Best time to visit'}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                  <TrendingDown className="h-3 w-3 text-emerald-500" />
                  {getBestTime()} — {lang === 'ar' ? 'انتظار أقل' : 'shorter wait'}
                </p>
              </div>
            </div>
          </motion.div>

          {/* People waiting indicator */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="mt-3 text-center"
          >
            <p className="text-[11px] text-muted-foreground">
              {totalWaiting} {lang === 'ar' ? 'شخص في الانتظار' : 'people waiting'}
            </p>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
