'use client';

// ─── Task 4: decimal-aware count-up value ───────────────────────────────────
// Same easing as AnimatedCounter (agency dashboard helpers) but renders a
// fixed number of decimals — used for the channel rate tiles. Kept local to
// the admin analytics folder so the agency originals stay untouched.

import { useEffect, useRef, useState } from 'react';

export function AnimatedValue({
  value,
  decimals = 1,
  duration = 800,
}: {
  value: number;
  decimals?: number;
  duration?: number;
}) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const start = prevRef.current;
    const end = value;
    if (start === end) return;
    const startTime = performance.now();
    let rafId = 0;
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(start + (end - start) * eased);
      if (progress < 1) rafId = requestAnimationFrame(animate);
      else prevRef.current = end;
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [value, duration]);

  return <>{display.toFixed(decimals)}</>;
}
