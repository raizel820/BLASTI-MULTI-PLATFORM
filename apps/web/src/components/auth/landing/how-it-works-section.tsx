'use client';

import { useLanguage } from '@/hooks/use-language';
import { motion, useInView } from 'framer-motion';
import {
  Search,
  TicketCheck,
  BellRing,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ─── Steps Data ──────────── */
interface StepItem {
  icon: LucideIcon;
  titleKey: 'step1' | 'step2' | 'step3';
  descKey: 'step1Desc' | 'step2Desc' | 'step3Desc';
}

const steps: StepItem[] = [
  { icon: Search, titleKey: 'step1', descKey: 'step1Desc' },
  { icon: TicketCheck, titleKey: 'step2', descKey: 'step2Desc' },
  { icon: BellRing, titleKey: 'step3', descKey: 'step3Desc' },
];

/* ─── Animated Dot for Connectors ──────────── */
function AnimatedDot({ delay }: { delay: number }) {
  return (
    <motion.div
      className="absolute"
      initial={{ scale: 0, opacity: 0 }}
      whileInView={{ scale: 1, opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.3, delay }}
    >
      <div className="h-2.5 w-2.5 rounded-full bg-teal-400 dark:bg-teal-500 shadow-sm shadow-teal-400/50" />
    </motion.div>
  );
}

export function HowItWorksSection() {
  const { t } = useLanguage();

  return (
    <section className="w-full px-4 py-20 md:py-24 relative z-10">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-50px' }}
        transition={{ duration: 0.6 }}
        className="max-w-3xl mx-auto"
      >
        <h2 className="text-2xl md:text-3xl font-bold text-center mb-3 shimmer-text">
          {t('howItWorks')}
        </h2>
        <p className="text-sm text-muted-foreground text-center mb-14 max-w-md mx-auto">{t('howItWorksDesc') || ''}</p>

        <div className="flex flex-col md:flex-row items-center md:items-start gap-10 md:gap-0">
          {steps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-30px' }}
                transition={{ duration: 0.6, delay: idx * 0.25 }}
                className="flex-1 flex flex-col items-center text-center relative group cursor-default"
              >
                {/* SVG animated dashed connector with flowing dots (desktop) */}
                {idx < steps.length - 1 && (
                  <div className="hidden md:block absolute top-10 start-[calc(50%+3rem)] end-[calc(-50%+3rem)] z-0">
                    <svg className="w-full h-4 overflow-visible" preserveAspectRatio="none">
                      <motion.line
                        x1="0" y1="8" x2="100%" y2="8"
                        stroke="url(#stepGradientEnhanced)"
                        strokeWidth="2"
                        strokeDasharray="6 4"
                        initial={{ pathLength: 0, opacity: 0.3 }}
                        whileInView={{ pathLength: 1, opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 1.5, delay: 0.5 + idx * 0.3 }}
                      />
                      <defs>
                        <linearGradient id="stepGradientEnhanced" x1="0%" y1="0%" x2="100%" y2="0%">
                          <stop offset="0%" stopColor="#10b981" stopOpacity="0.8" />
                          <stop offset="50%" stopColor="#14b8a6" stopOpacity="0.4" />
                          <stop offset="100%" stopColor="#10b981" stopOpacity="0.8" />
                        </linearGradient>
                      </defs>
                    </svg>
                    {/* Animated flowing dots along the line */}
                    <motion.div
                      className="absolute top-1/2 -translate-y-1/2"
                      initial={{ left: '0%' }}
                      whileInView={{ left: '100%' }}
                      viewport={{ once: false }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'linear', delay: 1 + idx * 0.3 }}
                    >
                      <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/60" />
                    </motion.div>
                    {/* Arrow dot at end */}
                    <motion.div
                      className="absolute end-0 top-1/2 -translate-y-1/2"
                      initial={{ scale: 0 }}
                      whileInView={{ scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: 1.5 + idx * 0.3 }}
                    >
                      <div className="h-2.5 w-2.5 rounded-full bg-teal-400 dark:bg-teal-500 shadow-sm shadow-teal-400/50 rtl:rotate-180" />
                    </motion.div>
                  </div>
                )}
                {/* Vertical connector with flowing dot (mobile) */}
                {idx < steps.length - 1 && (
                  <div className="md:hidden flex flex-col items-center mt-4 mb-2 relative">
                    <svg width="2" height="32" className="overflow-visible">
                      <motion.line
                        x1="1" y1="0" x2="1" y2="32"
                        stroke="#10b981"
                        strokeWidth="2"
                        strokeDasharray="4 3"
                        initial={{ pathLength: 0 }}
                        whileInView={{ pathLength: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.8, delay: 0.5 + idx * 0.2 }}
                      />
                    </svg>
                    {/* Flowing dot */}
                    <motion.div
                      className="absolute"
                      initial={{ top: '0%' }}
                      animate={{ top: ['0%', '100%'] }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'linear', delay: 1 + idx * 0.2 }}
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    </motion.div>
                    <motion.div
                      className="h-2 w-2 rounded-full bg-teal-400 dark:bg-teal-500 -mt-1 shadow-sm shadow-teal-400/50"
                      initial={{ scale: 0 }}
                      whileInView={{ scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ delay: 1 + idx * 0.2 }}
                    />
                  </div>
                )}

                {/* Step icon with gradient circle + enhanced bounce */}
                <motion.div
                  className="relative group-hover:scale-110 transition-all duration-300"
                  whileInView={{ scale: [0.5, 1.2, 0.9, 1] }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: 0.3 + idx * 0.25 }}
                >
                  {/* Outer pulse ring */}
                  <motion.div
                    className="absolute inset-0 rounded-2xl bg-emerald-400/20 dark:bg-emerald-500/10"
                    animate={{ scale: [1, 1.3, 1], opacity: [0.3, 0, 0.3] }}
                    transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.5 }}
                  />
                  {/* Second pulse ring (staggered) */}
                  <motion.div
                    className="absolute inset-0 rounded-2xl bg-teal-400/15 dark:bg-teal-500/8"
                    animate={{ scale: [1, 1.4, 1], opacity: [0.2, 0, 0.2] }}
                    transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.5 + 1.25 }}
                  />
                  <div className="relative h-16 w-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25 group-hover:shadow-xl group-hover:shadow-emerald-500/35 transition-shadow duration-300">
                    <Icon className="h-7 w-7 text-white" />
                  </div>
                  {/* Step number with enhanced gradient badge */}
                  <motion.div
                    className="absolute -top-2.5 -end-2.5 h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shadow-lg step-number-badge"
                    initial={{ scale: 0, rotate: -180 }}
                    whileInView={{ scale: [0, 1.3, 1], rotate: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.5 + idx * 0.25 }}
                  >
                    {idx + 1}
                  </motion.div>
                </motion.div>

                {/* Step text card with enhanced glassmorphism */}
                <motion.div
                  className="mt-5 p-4 rounded-2xl glass-feature-card max-w-[220px] group-hover:shadow-lg group-hover:shadow-emerald-500/5 transition-shadow duration-300"
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: 0.6 + idx * 0.25 }}
                >
                  <h3 className="font-semibold text-sm text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors duration-300">
                    {t(step.titleKey)}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {t(step.descKey)}
                  </p>
                </motion.div>
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    </section>
  );
}
