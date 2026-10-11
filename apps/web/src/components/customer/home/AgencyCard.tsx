'use client';

/**
 * Task 79-a — compact AgencyCard (Design System v2).
 *
 * 2-col mobile / 3-col md / 4-col lg grid density. Keeps every affordance of
 * the pre-rebuild card: favorite heart toggle, quick-join chip for
 * single-service open agencies, inactive-subscription badge, sponsored ring +
 * badge, status dot (open/paused/closed), waiting count, rating preview.
 */

import { motion } from 'framer-motion';
import { Building2, Clock, Heart, Info, Loader2, MapPin, Navigation, Star, Users, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import { formatDistance } from '@/lib/geo';
import type { TranslationKeys } from '@/i18n';
import { categoryKeys, getAgencyName, type AgencyListItem } from './types';

interface AgencyCardProps {
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
  /** Task 82 — estimated straight-line distance in km (null when location
   *  access is unavailable → the chip is simply not rendered). */
  distanceKm?: number | null;
}

export function AgencyCard({
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
}: AgencyCardProps) {
  const queueStatus = agency.isQueueOpen && !agency.isPaused ? 'open' : agency.isPaused ? 'paused' : 'closed';
  const CatIcon = categoryKeys.find((c) => c.value === agency.category.toUpperCase())?.icon ?? Building2;
  const estWaitMin = Math.max(1, Math.round(agency.waitingCount * (agency.avgServiceTime || 10) * 0.75));
  const estWaitMax = Math.round(agency.waitingCount * (agency.avgServiceTime || 10) * 1.3);
  const isActiveSub = agency.subscriptionStatus === 'ACTIVE';
  const showRating = (agency.reviewCount ?? 0) > 0 && (agency.averageRating ?? 0) > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.4) }}
      whileTap={{ scale: 0.98 }}
      className={`relative rounded-2xl bg-white dark:bg-gray-900/80 border border-border shadow-sm hover:shadow-md hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-all cursor-pointer overflow-hidden ${
        agency.isSponsored ? 'ring-1 ring-amber-200 dark:ring-amber-800/50' : ''
      }`}
      onClick={() => onSelect(agency)}
    >
      {/* Sponsored shimmer top border */}
      {agency.isSponsored && (
        <div className="absolute top-0 start-0 end-0 h-0.5 bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400" />
      )}

      <div className="p-3.5">
        {/* Row 1: icon chip + name + status */}
        <div className="flex items-start gap-2.5">
          <span className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
            <CatIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[13px] font-semibold text-foreground truncate leading-tight">
                {getAgencyName(agency, lang)}
              </h3>
              {agency.isSponsored && (
                <Star className="h-3 w-3 text-amber-500 fill-amber-500 flex-shrink-0" />
              )}
            </div>
            {/* Address */}
            <p className="text-[11px] text-muted-foreground truncate mt-0.5 flex items-center gap-1">
              <MapPin className="h-2.5 w-2.5 flex-shrink-0" />
              <span className="truncate">{agency.address}</span>
            </p>
          </div>
          {/* Status dot + label */}
          <span className="flex flex-col items-end gap-1 flex-shrink-0">
            <span className="flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                queueStatus === 'open' ? 'bg-emerald-500' : queueStatus === 'paused' ? 'bg-yellow-500' : 'bg-red-500'
              }`} />
              <span className={`text-[9px] font-medium leading-none ${
                queueStatus === 'open'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : queueStatus === 'paused'
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-red-600 dark:text-red-400'
              }`}>
                {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
              </span>
            </span>
            {!isActiveSub && (
              <Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                {t('inactiveAgency')}
              </Badge>
            )}
          </span>
        </div>

        {/* Row 2: stats */}
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          {typeof distanceKm === 'number' && Number.isFinite(distanceKm) && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-full px-1.5 py-0.5"
              title={t('estimatedDistance')}
            >
              <Navigation className="h-2.5 w-2.5 flex-shrink-0 rtl:rotate-180" />
              <span dir="ltr">
                ~{(() => {
                  const d = formatDistance(distanceKm);
                  return d.unit === 'km' ? `${d.value} km` : `${d.value} m`;
                })()}
              </span>
            </span>
          )}
          {queueStatus === 'open' && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded-full px-1.5 py-0.5">
              <Users className="h-2.5 w-2.5" />
              {agency.waitingCount} {t('waiting')}
            </span>
          )}
          {queueStatus === 'open' && (
            <span className="flex items-center gap-1 text-[10px] text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20 rounded-full px-1.5 py-0.5">
              <Clock className="h-2.5 w-2.5" />
              {estWaitMin < estWaitMax
                ? t('estWaitRange').replace('{min}', String(estWaitMin)).replace('{max}', String(estWaitMax))
                : `~${estWaitMin} ${t('min')}`}
            </span>
          )}
          {showRating && (
            <AgencyRatingDisplay averageRating={agency.averageRating ?? 0} totalCount={agency.reviewCount ?? 0} compact size="sm" />
          )}
        </div>

        {/* Row 3: actions */}
        <div className="mt-2.5 pt-2.5 border-t border-border/70 flex items-center justify-between">
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 truncate">
            {agency.isSponsored ? t('sponsored') : ''}
          </span>
          <span className="flex items-center gap-1.5">
            {onViewProfile && (
              <button
                onClick={(e) => { e.stopPropagation(); onViewProfile(agency); }}
                className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                aria-label={t('viewProfile')}
              >
                <Info className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              </button>
            )}
            <button
              onClick={(e) => onToggleFavorite(e, agency.id)}
              disabled={toggling}
              className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
              aria-label={t('favorites')}
            >
              {toggling ? (
                <Loader2 className="h-3.5 w-3.5 text-red-500 animate-spin" />
              ) : isFavorite ? (
                <Heart className="h-3.5 w-3.5 text-red-500 fill-red-500" />
              ) : (
                <Heart className="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" />
              )}
            </button>
            {agency.isQueueOpen && !agency.isPaused && agency.serviceCount === 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); if (isActiveSub) onQuickJoin(agency.id); }}
                disabled={!isActiveSub}
                className={`h-7 px-2.5 rounded-full flex items-center gap-1 text-[10px] font-medium transition-colors ${
                  !isActiveSub
                    ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                }`}
              >
                <Zap className="h-2.5 w-2.5" />
                {!isActiveSub ? t('inactiveAgency') : t('joinQueue')}
              </button>
            )}
          </span>
        </div>
      </div>
    </motion.div>
  );
}
