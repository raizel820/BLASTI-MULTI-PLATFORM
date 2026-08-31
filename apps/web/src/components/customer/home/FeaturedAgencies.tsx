'use client';

import { useRef, useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Star,
  ChevronLeft,
  ChevronRight,
  Clock,
  Sparkles,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import type { AgencyListItem } from './types';
import { getAgencyName, getCategoryLabel } from './types';

interface FeaturedAgenciesProps {
  agencies: AgencyListItem[];
  loading: boolean;
  onSelectAgency: (agency: AgencyListItem) => void;
  onQuickJoin: (agencyId: string, serviceId?: string) => void;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function FeaturedAgencies({
  agencies,
  loading,
  onSelectAgency,
  onQuickJoin,
  t,
  lang,
}: FeaturedAgenciesProps) {
  const featuredScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const sponsored = agencies.filter(a => a.isSponsored);

  // Check scroll position to update arrow visibility
  const updateScrollState = () => {
    const el = featuredScrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 5);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 5);
  };

  useEffect(() => {
    const el = featuredScrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    return () => el.removeEventListener('scroll', updateScrollState);
  }, [sponsored.length]);

  if (loading || sponsored.length === 0) return null;

  const scrollBy = (direction: -1 | 1) => {
    featuredScrollRef.current?.scrollBy({ left: direction * 260, behavior: 'smooth' });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className="mb-5"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          {t('featuredAgencies')}
        </h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => scrollBy(-1)}
            disabled={!canScrollLeft}
            className={`h-7 w-7 rounded-full border border-border flex items-center justify-center transition-all duration-200 ${canScrollLeft ? 'hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-foreground' : 'opacity-30 cursor-not-allowed'}`}
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
          </button>
          <button
            onClick={() => scrollBy(1)}
            disabled={!canScrollRight}
            className={`h-7 w-7 rounded-full border border-border flex items-center justify-center transition-all duration-200 ${canScrollRight ? 'hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-foreground' : 'opacity-30 cursor-not-allowed'}`}
            aria-label="Scroll right"
          >
            <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </button>
        </div>
      </div>

      {/* Horizontal scroll carousel with peek preview */}
      <div className="relative">
        <div
          ref={featuredScrollRef}
          className="flex gap-3 overflow-x-auto pb-2 no-scrollbar scroll-smooth snap-x snap-mandatory"
          style={{ WebkitOverflowScrolling: 'touch', paddingRight: '2rem' }}
        >
          {sponsored.map((agency, idx) => {
            const estWait = agency.waitingCount * (agency.avgServiceTime || 10);
            return (
              <motion.button
                key={agency.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.1 }}
                whileHover={{ y: -3, scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => onSelectAgency(agency)}
                className="snap-start flex-shrink-0 w-[240px] rounded-2xl border border-amber-200 dark:border-amber-800/50 bg-gradient-to-b from-amber-50 to-white dark:from-amber-900/20 dark:to-gray-900/80 shadow-sm hover:shadow-lg transition-all duration-300 p-4 text-start relative overflow-hidden"
              >
                {/* Shimmer gradient top border */}
                <div className="absolute top-0 start-0 end-0 h-1 shimmer-gradient-bar" />

                {/* Featured badge with shimmer animation */}
                <div className="flex items-center gap-1.5 mb-2.5">
                  <span className="inline-flex items-center gap-1 shimmer-badge-container">
                    <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-700 text-[10px] px-1.5 relative overflow-hidden">
                      <Star className="h-2.5 w-2.5 me-0.5 fill-amber-500 text-amber-500" />
                      {t('featuredBadge')}
                      {/* Shimmer sweep */}
                      <span className="absolute inset-0 shimmer-sweep" />
                    </Badge>
                  </span>
                  <span className="flex items-center gap-1 text-[10px] font-medium">
                    <span className="relative flex h-1.5 w-1.5">
                      {agency.isQueueOpen && !agency.isPaused && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      )}
                      <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${agency.isQueueOpen && !agency.isPaused ? 'bg-emerald-500' : agency.isPaused ? 'bg-yellow-500' : 'bg-red-500'}`} />
                    </span>
                    <span className={agency.isQueueOpen && !agency.isPaused ? 'text-emerald-600 dark:text-emerald-400' : agency.isPaused ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}>
                      {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
                    </span>
                  </span>
                </div>
                <h3 className="font-semibold text-sm text-foreground mb-1 truncate">{getAgencyName(agency, lang)}</h3>
                <Badge variant="secondary" className="text-[10px] mb-1.5">{getCategoryLabel(agency.category, t)}</Badge>
                {(agency.reviewCount ?? 0) > 0 && (agency.averageRating ?? 0) > 0 && (
                  <div className="mb-1.5">
                    <AgencyRatingDisplay averageRating={agency.averageRating ?? 0} totalCount={agency.reviewCount ?? 0} compact size="sm" />
                  </div>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    ~{estWait} {t('estWaitBadge')}
                  </span>
                  <span
                    onClick={(e) => { e.stopPropagation(); if (agency.subscriptionStatus === 'ACTIVE') onQuickJoin(agency.id); }}
                    className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${agency.subscriptionStatus !== 'ACTIVE' ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
                  >
                    {agency.subscriptionStatus !== 'ACTIVE' ? t('inactiveAgency') : t('joinQueue')}
                  </span>
                </div>
              </motion.button>
            );
          })}

          {/* Peek preview card — "More" hint */}
          {sponsored.length > 2 && (
            <div className="snap-start flex-shrink-0 w-[80px] flex items-center justify-center">
              <div className="text-center">
                <div className="h-10 w-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-1">
                  <ChevronRight className="h-5 w-5 text-amber-600 dark:text-amber-400 rtl:rotate-180" />
                </div>
                <span className="text-[9px] text-muted-foreground font-medium">{t('peekMore')}</span>
              </div>
            </div>
          )}
        </div>

        {/* Fade edge on the right side for peek effect */}
        <div className="absolute end-0 top-0 bottom-2 w-12 bg-gradient-to-l from-background to-transparent pointer-events-none" />
      </div>
    </motion.div>
  );
}
