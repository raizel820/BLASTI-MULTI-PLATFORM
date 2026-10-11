'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useLanguage } from '@/hooks/use-language';
import {
  Check,
  CheckCircle2,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { PlanInfo } from './types';

interface PlanCardProps {
  plan: PlanInfo;
  index: number;
  isSelected: boolean;
  isCurrent: boolean;
  isCurrentActive: boolean;
  onSelect: (planId: string) => void;
}

export function PlanCard({
  plan,
  index,
  isSelected,
  isCurrent,
  isCurrentActive,
  onSelect,
}: PlanCardProps) {
  const { t } = useLanguage();
  const PlanIcon = plan.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + index * 0.1 }}
      whileHover={{ y: -4, transition: { duration: 0.2 } }}
      className="h-full"
    >
      <Card
        className={`relative h-full transition-all duration-300 overflow-hidden border-2 flex flex-col ${
          isSelected
            ? 'border-emerald-500 shadow-xl shadow-emerald-500/10 bg-white dark:bg-gray-900/90'
            : isCurrent
              ? 'border-emerald-300 dark:border-emerald-700 shadow-sm bg-white dark:bg-gray-900/80'
              : 'border-transparent shadow-sm hover:shadow-md bg-white dark:bg-gray-900/80'
        }`}
      >
        {/* Glow effect when selected */}
        {isSelected && (
          <motion.div
            layoutId="plan-glow"
            className="absolute inset-0 rounded-xl bg-gradient-to-b from-emerald-500/5 to-teal-500/5 pointer-events-none"
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
        )}

        {/* Gradient header stripe */}
        <div className={`h-2 bg-gradient-to-r ${plan.gradientFrom} ${plan.gradientTo}`} />

        {/* Popular badge */}
        {plan.badge && (
          <div className="absolute top-4 end-4">
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-400 to-amber-500 shadow-sm">
              <Sparkles className="h-3 w-3 text-white" />
              <span className="text-[10px] font-bold text-white uppercase tracking-wide">{plan.badge}</span>
            </div>
          </div>
        )}

        <CardContent className="p-5 flex-1 flex flex-col">
          {/* Plan icon & name */}
          <div className="flex items-start gap-3 mb-4">
            <div className={`h-11 w-11 rounded-xl bg-gradient-to-br ${plan.gradientFrom} ${plan.gradientTo} flex items-center justify-center shadow-md flex-shrink-0`}>
              <PlanIcon className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-lg text-foreground">{plan.name}</h3>
                {isSelected && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="h-5 w-5 rounded-full bg-emerald-500 flex items-center justify-center"
                  >
                    <Check className="h-3 w-3 text-white" />
                  </motion.div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{plan.description}</p>
            </div>
          </div>

          {/* Price */}
          <div className="mb-4 pb-4 border-b border-border/50">
            <p className="text-3xl font-extrabold text-foreground">
              {plan.priceShort}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('perMonth')}</p>
          </div>

          {/* Current plan indicator */}
          {isCurrent && !isSelected && (
            <div className="mb-3 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {t('currentPlan')}
            </div>
          )}

          {/* Features */}
          <ul className="space-y-2.5 flex-1">
            {plan.features.map((f, i) => (
              <li key={i} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <div className="h-5 w-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                </div>
                {f}
              </li>
            ))}
          </ul>

          {/* Subscribe Button */}
          <div className="mt-5">
            {isCurrent && isCurrentActive ? (
              <Button
                className="w-full h-11 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-default rounded-xl"
                disabled
              >
                <CheckCircle2 className="h-4 w-4 me-2" />
                {t('currentPlan')}
              </Button>
            ) : (
              <Button
                className={`w-full h-11 font-semibold rounded-xl shadow-lg transition-all duration-300 ${
                  isSelected
                    ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-emerald-500/20'
                    : 'bg-white dark:bg-gray-800 border-2 border-emerald-500 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                }`}
                onClick={() => onSelect(plan.id)}
              >
                <ArrowRight className="h-4 w-4 me-2 rtl:rotate-180" />
                {t('goToPayment')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
