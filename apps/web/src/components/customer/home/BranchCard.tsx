'use client';

/**
 * Task 83-c-1 — compact BranchCard (Design System v2).
 *
 * Branch-level sibling of home/AgencyCard.tsx: rendered while the customer is
 * actively searching and the branch search endpoint (GET /api/agencies/branches,
 * Task 83-a) returns independent branch matches. Every branch is its own
 * search entity — special display name, sub-code, main-branch flag and
 * branch-scoped rating — always anchored to its parent agency (logo, name,
 * category, sponsored ring).
 *
 * Mirrors AgencyCard's patterns exactly: motion whileTap scale 0.98,
 * emerald/teal theme (no indigo/blue), full dark: coverage, logical RTL
 * utilities, amber rating stars (AgencyRatingDisplay), Task 82 distance chip,
 * sponsored shimmer + amber ring.
 */

import { motion } from 'framer-motion';
import { Building2, ChevronRight, MapPin, Navigation, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import { formatDistance } from '@/lib/geo';
import { getProxiedUrl } from '@/lib/utils';
import type { TranslationKeys } from '@/i18n';
import { categoryKeys, getCategoryLabel } from './types';

/** One row of the GET /api/agencies/branches payload (Task 83-a). */
export interface BranchListItem {
  id: string;
  name: string;
  nameFr?: string | null;
  nameAr?: string | null;
  specialName?: string | null;
  subCode?: string | null;
  isMain?: boolean;
  address?: string | null;
  city?: string | null;
  wilaya?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationVerified?: boolean | null;
  phone?: string | null;
  counterCount?: number;
  branchAverageRating?: number | null;
  branchReviewCount?: number | null;
  agency: {
    id: string;
    name: string;
    nameFr?: string | null;
    nameAr?: string | null;
    customCode: string;
    category: string;
    logoUrl?: string | null;
    coverUrl?: string | null;
    isSponsored: boolean;
    isQueueOpen: boolean;
    phone?: string | null;
    workingHoursStart?: string | null;
    workingHoursEnd?: string | null;
    workingDays?: string | null;
    subscriptionStatus?: string | null;
    // Not part of the current Task 83-a select, but the spec's address
    // fallback (branch address ?? agency address) stays future-proof.
    address?: string | null;
  };
}

interface BranchCardProps {
  branch: BranchListItem;
  index: number;
  lang: string;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  onSelectBranch: (branch: BranchListItem) => void;
  /** Task 82 pattern — straight-line km from the customer, null when the
   *  location permission is not already granted (chip not rendered). */
  distanceKm?: number | null;
}

export function BranchCard({ branch, index, lang, t, onSelectBranch, distanceKm }: BranchCardProps) {
  const { agency } = branch;

  const localeName = (name: string, nameFr?: string | null, nameAr?: string | null): string => {
    if (lang === 'ar' && nameAr) return nameAr;
    if (lang === 'fr' && nameFr) return nameFr;
    return name;
  };

  const agencyName = localeName(agency.name, agency.nameFr, agency.nameAr);
  const branchTitle = branch.specialName || localeName(branch.name, branch.nameFr, branch.nameAr);
  const CatIcon = categoryKeys.find((c) => c.value === agency.category.toUpperCase())?.icon ?? Building2;
  const showRating = (branch.branchReviewCount ?? 0) > 0 && (branch.branchAverageRating ?? 0) > 0;
  const addressLine = [branch.address ?? agency.address ?? '', branch.city].filter(Boolean).join(' · ');

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.4) }}
      whileTap={{ scale: 0.98 }}
      className={`relative rounded-2xl bg-white dark:bg-gray-900/80 border border-border shadow-sm hover:shadow-md hover:border-emerald-200 dark:hover:border-emerald-800/60 transition-all cursor-pointer overflow-hidden ${
        agency.isSponsored ? 'ring-1 ring-amber-200 dark:ring-amber-800/50' : ''
      }`}
      onClick={() => onSelectBranch(branch)}
    >
      {/* Sponsored shimmer top border */}
      {agency.isSponsored && (
        <div className="absolute top-0 start-0 end-0 h-0.5 bg-gradient-to-r from-amber-400 via-yellow-300 to-amber-400" />
      )}

      <div className="p-3.5">
        {/* Row 1: agency logo + branch title + open/closed */}
        <div className="flex items-start gap-2.5">
          {agency.logoUrl ? (
            <img
              src={getProxiedUrl(agency.logoUrl)}
              alt={agencyName}
              className="h-9 w-9 rounded-xl object-cover border border-border flex-shrink-0"
            />
          ) : (
            <span className="h-9 w-9 rounded-xl bg-emerald-600 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-white">{agencyName.charAt(0).toUpperCase() || '·'}</span>
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[13px] font-semibold text-foreground truncate leading-tight" title={branchTitle}>
                {branchTitle}
              </h3>
              {agency.isSponsored && (
                <Star className="h-3 w-3 text-amber-500 fill-amber-500 flex-shrink-0" />
              )}
            </div>
            {/* "Part of {agency}" + sub-code mono badge + main-branch badge */}
            <div className="flex flex-wrap items-center gap-1 mt-0.5">
              <span className="text-[11px] text-muted-foreground truncate max-w-full" title={agencyName}>
                {t('branchOfAgency').replace('{agency}', agencyName)}
              </span>
              {branch.subCode && (
                <span
                  className="font-mono text-[9px] text-muted-foreground bg-muted dark:bg-gray-800 rounded px-1 py-0.5 flex-shrink-0"
                  dir="ltr"
                >
                  {branch.subCode}
                </span>
              )}
              {branch.isMain && (
                <Badge
                  variant="outline"
                  className="text-[8px] px-1 py-0 h-3.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800 flex-shrink-0"
                >
                  {t('mainBranchBadge')}
                </Badge>
              )}
            </div>
          </div>
          {/* Status dot + label (parent agency queue state) */}
          <span className="flex flex-col items-end gap-1 flex-shrink-0">
            <span className="flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                agency.isQueueOpen ? 'bg-emerald-500' : 'bg-red-500'
              }`} />
              <span className={`text-[9px] font-medium leading-none ${
                agency.isQueueOpen ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
              }`}>
                {agency.isQueueOpen ? t('openNow') : t('closed')}
              </span>
            </span>
          </span>
        </div>

        {/* Address / city */}
        {addressLine && (
          <p className="text-[11px] text-muted-foreground truncate mt-1.5 flex items-center gap-1">
            <MapPin className="h-2.5 w-2.5 flex-shrink-0" />
            <span className="truncate">{addressLine}</span>
          </p>
        )}

        {/* Row 2: stats */}
        <div className="mt-2 flex items-center gap-2 flex-wrap">
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
          {showRating && (
            <span title={t('averageRating')}>
              <AgencyRatingDisplay
                averageRating={branch.branchAverageRating ?? 0}
                totalCount={branch.branchReviewCount ?? 0}
                compact
                size="sm"
              />
            </span>
          )}
          <span className="flex items-center gap-1 text-[10px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-full px-1.5 py-0.5">
            <CatIcon className="h-2.5 w-2.5 flex-shrink-0" />
            {getCategoryLabel(agency.category, t)}
          </span>
        </div>

        {/* Row 3: actions */}
        <div className="mt-2.5 pt-2.5 border-t border-border/70 flex items-center justify-between">
          <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400 truncate">
            {agency.isSponsored ? t('sponsored') : ''}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); onSelectBranch(branch); }}
            className="h-8 px-2.5 rounded-full flex items-center gap-1 text-[10px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors flex-shrink-0"
            aria-label={t('viewBranchProfile')}
          >
            {t('viewBranchProfile')}
            <ChevronRight className="h-3 w-3 rtl:rotate-180" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
