'use client';

import { useLanguage } from '@/hooks/use-language';
import { motion } from 'framer-motion';
import {
  Clock,
  Wifi,
  Bell,
  Smartphone,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface FeatureItem {
  icon: LucideIcon;
  titleKey: 'feature1Title' | 'feature2Title' | 'feature3Title' | 'feature4Title';
  descKey: 'feature1Desc' | 'feature2Desc' | 'feature3Desc' | 'feature4Desc';
}

const features: FeatureItem[] = [
  { icon: Clock, titleKey: 'feature1Title', descKey: 'feature1Desc' },
  { icon: Wifi, titleKey: 'feature2Title', descKey: 'feature2Desc' },
  { icon: Bell, titleKey: 'feature3Title', descKey: 'feature3Desc' },
  { icon: Smartphone, titleKey: 'feature4Title', descKey: 'feature4Desc' },
];

export function FeaturesSection() {
  const { t } = useLanguage();

  return (
    <section className="w-full px-4 py-20 md:py-24 relative z-10">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.6 }}
        className="max-w-3xl mx-auto"
      >
        <motion.h2
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-2xl md:text-3xl font-bold text-center mb-3 shimmer-text"
        >
          {t('learnMore')}
        </motion.h2>
        <div className="h-1 w-16 mx-auto rounded-full gradient-flow-bar mb-12" />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {features.map((feature, idx) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 30, scale: 0.95 }}
                whileInView={{ opacity: 1, y: 0, scale: 1 }}
                viewport={{ once: true, margin: '-30px' }}
                transition={{ duration: 0.5, delay: idx * 0.15 }}
                whileHover={{ y: -10, scale: 1.04 }}
                className="cursor-default group relative"
              >
                {/* Gradient border wrapper - visible on hover */}
                <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-br from-emerald-400/0 via-teal-400/0 to-emerald-400/0 group-hover:from-emerald-400/60 group-hover:via-teal-400/40 group-hover:to-emerald-400/60 transition-all duration-500 blur-[1px]" />
                
                <div className="glass-feature-card rounded-2xl p-5 h-full relative overflow-hidden group/card">
                  {/* Glow effect on hover */}
                  <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/0 via-teal-500/0 to-emerald-500/0 group-hover/card:from-emerald-500/5 group-hover/card:via-teal-500/5 group-hover/card:to-emerald-500/5 transition-all duration-500 rounded-2xl" />
                  {/* Top accent line */}
                  <div className="absolute top-0 start-0 w-full h-[2px] bg-gradient-to-r from-transparent via-emerald-400/0 to-transparent group-hover/card:via-emerald-400/60 transition-all duration-500" />
                  {/* Bottom accent line */}
                  <div className="absolute bottom-0 start-0 w-full h-[2px] bg-gradient-to-r from-transparent via-teal-400/0 to-transparent group-hover/card:via-teal-400/40 transition-all duration-500 delay-100" />
                  
                  <div className="flex items-start gap-4 relative z-10">
                    <motion.div
                      className="flex-shrink-0 h-12 w-12 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/40 flex items-center justify-center group-hover/card:from-emerald-200 group-hover/card:to-teal-200 dark:group-hover/card:from-emerald-800/50 dark:group-hover/card:to-teal-800/50 group-hover/card:shadow-lg group-hover/card:shadow-emerald-500/15 transition-all duration-300 relative"
                      whileInView={{ scale: [0.8, 1.1, 1] }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.4, delay: 0.2 + idx * 0.1 }}
                    >
                      {/* Continuous floating animation */}
                      <motion.div
                        animate={{ y: [0, -3, 0] }}
                        transition={{ duration: 2.5 + idx * 0.3, repeat: Infinity, ease: 'easeInOut', delay: idx * 0.5 }}
                        className="flex items-center justify-center"
                      >
                        <Icon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                      </motion.div>
                      {/* Pulse ring around icon */}
                      <motion.div
                        className="absolute inset-0 rounded-xl border-2 border-emerald-400/0 group-hover/card:border-emerald-400/40"
                        animate={{
                          scale: [1, 1.3, 1],
                          opacity: [0, 0.5, 0],
                        }}
                        transition={{
                          duration: 2,
                          repeat: Infinity,
                          ease: 'easeInOut',
                          delay: idx * 0.4,
                        }}
                      />
                    </motion.div>
                    <div>
                      <h3 className="font-semibold text-sm text-foreground mb-1 group-hover/card:text-emerald-600 dark:group-hover/card:text-emerald-400 transition-colors">
                        {t(feature.titleKey)}
                      </h3>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t(feature.descKey)}
                      </p>
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </motion.div>
    </section>
  );
}
