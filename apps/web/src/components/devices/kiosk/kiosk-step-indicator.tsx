'use client';

import { motion } from 'framer-motion';
import { CheckCircle, ArrowRight, ArrowLeft } from 'lucide-react';
import type { KioskStep } from './kiosk-types';
import { STEP_ORDER } from './kiosk-types';

interface KioskStepIndicatorProps {
  currentStep: KioskStep;
  stepLabels: Record<string, string>;
  rtl: boolean;
}

export function KioskStepIndicator({ currentStep, stepLabels, rtl }: KioskStepIndicatorProps) {
  if (currentStep === 'discovery' || currentStep === 'qr-scan') return null;

  const currentIdx = STEP_ORDER.indexOf(currentStep);
  const ArrowIcon = rtl ? ArrowLeft : ArrowRight;

  return (
    <div className="flex items-center justify-center gap-0 mb-6 print:hidden">
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
                className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                  isCompleted || isCurrent ? 'text-white' : 'text-gray-400'
                }`}
              >
                {isCompleted ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  idx + 1
                )}
              </motion.div>
              <span className={`text-[10px] mt-1 font-medium ${isCurrent ? 'text-white' : 'text-white/50'}`}>
                {label}
              </span>
            </div>
            {idx < STEP_ORDER.length - 1 && (
              <div className="mx-2 mt-[-16px]">
                <ArrowIcon className={`w-4 h-4 ${idx < currentIdx ? 'text-emerald-300' : 'text-white/20'}`} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}