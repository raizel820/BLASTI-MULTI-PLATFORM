'use client';

import { motion } from 'framer-motion';
import { CheckCircle, ArrowRight, ArrowLeft } from 'lucide-react';
import type { KioskStep } from './kiosk-types';
import { STEP_ORDER } from './kiosk-types';

interface KioskStepIndicatorProps {
  currentStep: KioskStep;
  stepLabels: Record<string, string>;
  rtl: boolean;
  /** 0.6.104 — compact variant for xs/sm viewports (saves vertical space). */
  compact?: boolean;
}

export function KioskStepIndicator({ currentStep, stepLabels, rtl, compact = false }: KioskStepIndicatorProps) {
  if (currentStep === 'discovery' || currentStep === 'qr-scan') return null;

  const currentIdx = STEP_ORDER.indexOf(currentStep);
  const ArrowIcon = rtl ? ArrowLeft : ArrowRight;

  return (
    <div className={`flex items-center justify-center gap-0 print:hidden ${compact ? 'mb-1' : 'mb-3'}`}>
      {STEP_ORDER.map((s, idx) => {
        const isCompleted = idx < currentIdx;
        const isCurrent = idx === currentIdx;
        const label = stepLabels[s] || s;
        return (
          <div key={s} className="flex items-center">
            <div className="flex flex-col items-center">
              <motion.div
                animate={{
                  scale: isCurrent ? 1.1 : 1,
                  backgroundColor: isCompleted ? '#059669' : isCurrent ? '#059669' : '#e5e7eb',
                }}
                className={`rounded-full flex items-center justify-center font-bold transition-colors ${
                  compact ? 'w-6 h-6 text-[11px]' : 'w-9 h-9 text-sm'
                } ${
                  isCompleted || isCurrent ? 'text-white' : 'text-gray-400'
                }`}
              >
                {isCompleted ? (
                  <CheckCircle className={compact ? 'w-3.5 h-3.5' : 'w-5 h-5'} />
                ) : (
                  idx + 1
                )}
              </motion.div>
              <span className={`font-medium ${compact ? 'text-[9px] mt-0.5' : 'text-[10px] mt-1'} ${isCurrent ? 'text-white' : 'text-white/50'}`}>
                {label}
              </span>
            </div>
            {idx < STEP_ORDER.length - 1 && (
              <div className={compact ? 'mx-1.5 mt-[-14px]' : 'mx-2 mt-[-16px]'}>
                <ArrowIcon className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} ${idx < currentIdx ? 'text-emerald-300' : 'text-white/20'}`} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}