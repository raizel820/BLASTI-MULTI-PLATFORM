'use client';

/**
 * CardSwiper — horizontal snap carousel used by the customer home sections
 * (nearby agencies, past visits, search results, branch results).
 *
 * WHY a scroll-snap rail instead of the swiper package: RTL-safe (the swiper
 * package fights RTL scroll coordinates in an Arabic-first app), zero bundle
 * cost, native touch momentum, and the chevron affordance covers desktop
 * where there is no swipe gesture. Full-bleed edge peek comes from the
 * parent's -mx-4/px-4 wrapper, matching CategoryFilters.
 */
import { useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';

interface CardSwiperProps {
  children: React.ReactNode;
  /**
   * Width classes applied to EVERY item wrapper — controls how many cards
   * are visible per breakpoint, e.g. 'w-full md:w-[calc(50%-6px)]'.
   */
  itemClassName?: string;
  /** Accessible label for the rail + arrow buttons. */
  ariaLabel: string;
}

export function CardSwiper({ children, itemClassName = 'w-full', ariaLabel }: CardSwiperProps) {
  const { lang } = useLanguage();
  const rtl = lang === 'ar';
  const railRef = useRef<HTMLDivElement | null>(null);

  const items = Array.isArray(children) ? children : [children];

  const scrollByCard = useCallback(
    (dirNext: boolean) => {
      const rail = railRef.current;
      if (!rail) return;
      const first = rail.querySelector<HTMLElement>('[data-swiper-item]');
      if (!first) return;
      const gap = 12; // gap-3 — keep in sync with the rail class
      const amount = first.offsetWidth + gap;
      // In RTL, visual "next" (towards the start side… actually towards the
      // left edge) corresponds to NEGATIVE scrollLeft deltas; in LTR positive.
      const delta = dirNext !== rtl ? amount : -amount;
      rail.scrollBy({ left: delta, behavior: 'smooth' });
    },
    [rtl],
  );

  const arrowBase =
    'hidden md:flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white/95 dark:bg-gray-900/95 shadow-sm text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-200 dark:hover:border-emerald-800 transition-colors';

  return (
    <div className="relative" role="group" aria-label={ariaLabel}>
      {/* Prev / Next — desktop affordance; mobile swipes natively. */}
      <button
        type="button"
        className={`${arrowBase} absolute -start-3 top-1/2 -translate-y-1/2 z-10`}
        onClick={() => scrollByCard(false)}
        aria-label={rtl ? 'التالي' : 'Previous'}
      >
        {rtl ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>
      <button
        type="button"
        className={`${arrowBase} absolute -end-3 top-1/2 -translate-y-1/2 z-10`}
        onClick={() => scrollByCard(true)}
        aria-label={rtl ? 'السابق' : 'Next'}
      >
        {rtl ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>

      <div
        ref={railRef}
        className="flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar scroll-smooth py-0.5"
      >
        {items.map((child, i) => (
          <div
            key={i}
            data-swiper-item
            className={`snap-start shrink-0 ${itemClassName}`}
          >
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
