'use client';

import { useEffect, useRef, useState } from 'react';

interface AnimatedCounterProps {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

/**
 * Animates a number from 0 (or previous value) to the target value
 * using requestAnimationFrame for smooth 60fps animation.
 *
 * @example
 * <AnimatedCounter value={142} prefix="$" suffix=" users" />
 */
export function AnimatedCounter({
  value,
  duration = 1000,
  prefix = '',
  suffix = '',
  className,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const rafRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const startValueRef = useRef(value);
  const previousValueRef = useRef(value);

  useEffect(() => {
    // If value hasn't changed, do nothing
    if (value === previousValueRef.current) return;

    const startValue = startValueRef.current;
    const endValue = value;
    const diff = endValue - startValue;

    // If the difference is 0, just set it immediately (avoid setState in effect warning)
    if (diff === 0) {
      previousValueRef.current = endValue;
      return;
    }

    // Cancel any existing animation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic for a natural deceleration feel
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const currentValue = startValue + diff * easedProgress;

      setDisplayValue(currentValue);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        // Snap to exact value at the end
        setDisplayValue(endValue);
        startValueRef.current = endValue;
        previousValueRef.current = endValue;
        startTimeRef.current = null;
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [value, duration]);

  // Format the number with locale-aware formatting
  const formattedValue = Math.round(displayValue).toLocaleString();

  return (
    <span className={className}>
      {prefix}
      {formattedValue}
      {suffix}
    </span>
  );
}
