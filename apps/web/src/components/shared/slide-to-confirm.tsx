'use client';

import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { ChevronRight, Check, Lock } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';

interface SlideToConfirmProps {
  onConfirm: () => void;
  label?: string;
}

export function SlideToConfirm({ onConfirm, label }: SlideToConfirmProps) {
  const { t } = useLanguage();
  const [isSliding, setIsSliding] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [sliderX, setSliderX] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef<number>(0);

  const progress = containerWidth > 0
    ? (sliderX / (containerWidth - 60)) * 100
    : 0;

  const handleStart = useCallback((clientX: number) => {
    if (isConfirmed) return;
    setIsSliding(true);
    startXRef.current = clientX;
    if (containerRef.current) {
      const w = containerRef.current.offsetWidth;
      setContainerWidth(w);
    }
  }, [isConfirmed]);

  const handleMove = useCallback((clientX: number) => {
    if (!isSliding || isConfirmed) return;
    const diff = clientX - startXRef.current;
    const maxSlide = containerWidth > 0 ? containerWidth - 60 : 0;
    const clampedX = Math.max(0, Math.min(diff, maxSlide));
    setSliderX(clampedX);
  }, [isSliding, isConfirmed, containerWidth]);

  const triggerConfirm = useCallback(() => {
    setIsConfirmed(true);
    setSliderX(containerWidth > 0 ? containerWidth - 60 : 0);
    setTimeout(() => {
      onConfirm();
    }, 300);
  }, [containerWidth, onConfirm]);

  const handleEnd = useCallback(() => {
    if (!isSliding || isConfirmed) return;
    setIsSliding(false);

    const threshold = containerWidth > 0 ? containerWidth - 70 : 0;
    if (sliderX >= threshold) {
      triggerConfirm();
    } else {
      setSliderX(0);
    }
  }, [isSliding, isConfirmed, sliderX, containerWidth, triggerConfirm]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isConfirmed) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (containerRef.current && containerWidth === 0) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
      const maxSlide = containerWidth > 0 ? containerWidth - 60 : 0;
      const increment = maxSlide * 0.2;
      const newX = Math.min(sliderX + increment, maxSlide);
      setSliderX(newX);

      const threshold = containerWidth > 0 ? containerWidth - 70 : 0;
      if (newX >= threshold) {
        triggerConfirm();
      }
    }

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (progress > 50) {
        triggerConfirm();
      }
    }
  }, [isConfirmed, containerWidth, sliderX, progress, triggerConfirm]);

  return (
    <div>
      <div
        ref={containerRef}
        tabIndex={0}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        aria-label={label || t('slideToConfirm') || 'Slide to confirm'}
        className="relative h-12 sm:h-14 rounded-2xl bg-white/15 backdrop-blur-sm overflow-hidden select-none touch-none outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        onMouseDown={(e) => handleStart(e.clientX)}
        onMouseMove={(e) => handleMove(e.clientX)}
        onMouseUp={handleEnd}
        onMouseLeave={() => { if (isSliding) handleEnd(); }}
        onTouchStart={(e) => handleStart(e.touches[0].clientX)}
        onTouchMove={(e) => handleMove(e.touches[0].clientX)}
        onTouchEnd={handleEnd}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
      >
        {/* Background text / track */}
        <div className="absolute inset-0 flex items-center justify-center">
          {!isConfirmed ? (
            <div className="flex items-center gap-2">
              <motion.div
                animate={{ x: [-2, 2, -2] }}
                transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              >
                <ChevronRight className="h-5 w-5 text-white/60" />
              </motion.div>
              <span className="text-sm font-semibold text-white/70">
                {label || t('slideToConfirm') || 'Slide to confirm'}
              </span>
              <ChevronRight className="h-5 w-5 text-white/60" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Check className="h-5 w-5 text-white" />
              <span className="text-sm font-semibold text-white">
                {t('confirmed') || 'Confirmed'}
              </span>
            </div>
          )}
        </div>

        {/* Progress fill */}
        {!isConfirmed && sliderX > 5 && progress > 0 && (
          <motion.div
            className="absolute inset-y-0 start-0 bg-white/15 rounded-2xl"
            style={{ width: `${progress}%` }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          />
        )}

        {/* Slider thumb */}
        <motion.div
          className="absolute top-1 start-1 h-10 w-10 sm:h-12 sm:w-12 rounded-xl bg-white shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing z-10"
          animate={{ x: sliderX }}
          transition={isSliding ? { type: 'tween', duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
          style={{ touchAction: 'none' }}
        >
          {isConfirmed ? (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 300, damping: 15 }}
            >
              <Check className="h-5 w-5 text-emerald-600" />
            </motion.div>
          ) : (
            <Lock className="h-5 w-5 text-emerald-600" />
          )}
        </motion.div>
      </div>
      {/* Keyboard fallback — visible on focus */}
      {!isConfirmed && (
        <p className={`text-center text-xs text-white/50 mt-1.5 transition-opacity duration-200 ${isFocused ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          {t('pressEnterToConfirm') || 'Press Enter to confirm'}
        </p>
      )}
    </div>
  );
}
