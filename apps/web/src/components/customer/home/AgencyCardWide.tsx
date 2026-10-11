'use client';

/**
 * AgencyCardWide — full-width detail card rendered inside the home section
 * swipers (nearby agencies, past visits, search results).
 *
 * Field request: the compact 2-col cards hid too much — the customer asked
 * for "all its details" with cards allowed to be full phone width, swapped
 * via a swiper. Every affordance of AgencyCard is preserved (favorite heart,
 * quick-join, inactive-subscription badge, sponsored ring/badge, status dot,
 * view profile) and the hidden details are now visible: category label,
 * working hours, agency code, two-line address, distance, waiting count,
 * estimated wait and rating.
 */
import { motion } from 'framer-motion';
import { Building2, Clock, Heart, Info, Loader2, MapPin, Navigation, Star, Users, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import { formatDistance } from '@/lib/geo';
import type { TranslationKeys } from '@/i18n';
import { categoryKeys, getCategoryLabel, getAgencyName, isOpenNow, type AgencyListItem } from './types';

interface AgencyCardWideProps {
  agency: AgencyListItem;
  index: number;
  lang: string;
  isFavorite: boolean;
  toggling: boolean;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  onSelect: (agency: AgencyListItem) => void;
  onToggleFavorite: (e: React.MouseEvent, agencyId: string) => void;
  onQuickJoin: (agencyId: string) => void;
  /** Task 81-b — optional “view agency profile” entry (Info icon, does not select the card). */
  onViewProfile?: (agency: AgencyListItem) => void;
  /** Task 82 — estimated straight-line distance in km (null → chip not rendered). */
  distanceKm?: number | null;
}

export function AgencyCardWide({
  agency,
  index,
  lang,
  isFavorite,
  toggling,
  t,
  onSelect,
  onToggleFavorite,
  onQuickJoin,
  onViewProfile,
  distanceKm,
}: AgencyCardWideProps) {
  const queueStatus = agency.isQueueOpen && !agency.isPaused ? 'open' : agency.isPaused ? 'paused' : 'closed';
  const CatIcon = categoryKeys.find((c) => c.value === agency.category.toUpperCase())?.icon ?? Building2;
  const estWaitMin = Math.max(1, Math.round(agency.waitingCount * (agency.avgServiceTime || 10) * 0.75));
  const estWaitMax = Math.round(agency.waitingCount * (agency.avgServiceTime || 10) * 1.3);
  const isActiveSub = agency.subscriptionStatus === 'ACTIVE';
  const showRating = (agency.reviewCount ?? 0) > 0 && (agency.averageRating ?? 0) > 0;

  // Working hours live status: real "open now" check when hours exist, the
  // queue flag otherwise (isOpenNow returns null when hours are absent).
  const hoursOpen = agency.workingHoursStart && agency.workingHoursEnd
    ? isOpenNow(agency.workingHoursStart, agency.workingHoursEnd)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.05, 0.3) }}
      whileTap={{ scale: 0.985 }}
      className={`relative h-full rounded-2xl bg-white dark:bg-gray-900/80 border border-border shadow-sm hover:shadow-md hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-all cursor-pointer overflow-hidden ${
        agency.isSponsored ? 'ring-1 ring-amber-200 dark:ring-amber-800/50' : ''
      }`}
      onClick={() => onSelect(agency)}
    >
      {/* Sponsored shimmer top border */}
      {agency.isSponsored && (
        <div className="absolute top-0 start-0 end-0 h-0.5 bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400" />
      )}

      <div className="p-4">
        {/* Row 1: icon + name + category/status */}
        <div className="flex items-start gap-3">
          <span className="h-11 w-11 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
            <CatIcon className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[15px] font-bold text-foreground truncate leading-tight">
                {getAgencyName(agency, lang)}
              </h3>
              {agency.isSponsored && (
                <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 flex-shrink-0" />
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                {getCategoryLabel(agency.category, t)}
              </span>
              {agency.isSponsored && (
                <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-full px-1.5 py-0.5">
                  {t('sponsored')}
                </span>
              )}
              {!isActiveSub && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                  {t('inactiveAgency')}
                </Badge>
              )}
            </div>
          </div>
          {/* Status column: dot + label + optional hours-open check */}
          <span className="flex flex-col items-end gap-1 flex-shrink-0">
            <span className="flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
                queueStatus === 'open' ? 'bg-emerald-500' : queueStatus === 'paused' ? 'bg-yellow-500' : 'bg-red-500'
              }`} />
              <span className={`text-[11px] font-semibold leading-none ${
                queueStatus === 'open'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : queueStatus === 'paused'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-red-600 dark:text-red-400'
              }`}>
                {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
              </span>
            </span>
            {typeof hoursOpen === 'boolean' && hoursOpen && !agency.isPaused && (
              <span className="text-[9px] text-emerald-600/80 dark:text-emerald-400/80 flex items-center gap-0.5">
                <Clock className="h-2.5 w-2.5" />
                {agency.workingHoursStart}–{agency.workingHoursEnd}
              </span>
            )}
          </span>
        </div>

        {/* Row 2: address (two lines) */}
        <p className="mt-2.5 text-xs text-muted-foreground leading-relaxed flex items-start gap-1.5 min-h-[2rem]">
          <MapPin className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span className="line-clamp-2">{agency.address || '—'}</span>
        </p>

        {/* Row 3: full detail chips */}
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          {typeof distanceKm === 'number' && Number.isFinite(distanceKm) && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-1"
              title={t('estimatedDistance')}
            >
              <Navigation className="h-3 w-3 flex-shrink-0 rtl:rotate-180" />
              <span dir="ltr">
                ~{(() => {
                  const d = formatDistance(distanceKm);
                  return d.unit === 'km' ? `${d.value} km` : `${d.value} m`;
                })()}
              </span>
            </span>
          )}
          {queueStatus === 'open' && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded-full px-2 py-1">
              <Users className="h-3 w-3" />
              {agency.waitingCount} {t('waiting')}
            </span>
          )}
          {queueStatus === 'open' && (
            <span className="flex items-center gap-1 text-[10px] text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20 rounded-full px-2 py-1">
              <Clock className="h-3 w-3" />
              {estWaitMin < estWaitMax
                ? t('estWaitRange').replace('{min}', String(estWaitMin)).replace('{max}', String(estWaitMax))
                : `~${estWaitMin} ${t('min')}`}
            </span>
          )}
          {showRating && (
            <AgencyRatingDisplay averageRating={agency.averageRating ?? 0} totalCount={agency.reviewCount ?? 0} compact size="sm" />
          )}
          {agency.customCode && (
            <span className="text-[10px] text-muted-foreground bg-muted/60 rounded-full px-2 py-1 font-mono" dir="ltr">
              {agency.customCode}
            </span>
          )}
        </div>

        {/* Row 4: actions */}
        <div className="mt-3 pt-3 border-t border-border/70 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 min-w-0">
            {onViewProfile && (
              <button
                onClick={(e) => { e.stopPropagation(); onViewProfile(agency); }}
                className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                aria-label={t('viewProfile')}
              >
                <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </button>
            )}
            <button
              onClick={(e) => onToggleFavorite(e, agency.id)}
              disabled={toggling}
              className="h-8 w-8 rounded-full flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
              aria-label={t('favorites')}
            >
              {toggling ? (
                <Loader2 className="h-4 w-4 text-red-500 animate-spin" />
              ) : isFavorite ? (
                <Heart className="h-4 w-4 text-red-500 fill-red-500" />
              ) : (
                <Heart className="h-4 w-4 text-gray-300 dark:text-gray-600" />
              )}
            </button>
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); if (isActiveSub && agency.isQueueOpen && !agency.isPaused) onQuickJoin(agency.id); }}
            disabled={!isActiveSub || !agency.isQueueOpen || agency.isPaused}
            className={`h-8 px-3.5 rounded-full flex items-center gap-1.5 text-[11px] font-semibold transition-colors ${
              !isActiveSub || !agency.isQueueOpen || agency.isPaused
                ? 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm'
            }`}
          >
            <Zap className="h-3 w-3" />
            {!isActiveSub ? t('inactiveAgency') : queueStatus === 'open' ? t('joinQueue') : t('closed')}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
