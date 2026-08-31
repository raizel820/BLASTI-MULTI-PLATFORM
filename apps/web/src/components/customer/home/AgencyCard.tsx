'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Star,
  ChevronRight,
  Loader2,
  TicketCheck,
  Clock,
  Heart,
  MapPin,
  UserRound,
  Zap,
  Briefcase,
  Stethoscope,
  Globe,
  Scale,
  FlaskConical,
  Landmark,
  Building2,
  Navigation,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import type { AgencyListItem } from './types';
import { getAgencyName, getCategoryLabel } from './types';

// Category color mapping for visual differentiation
const categoryColors: Record<string, { bg: string; text: string; darkBg: string; darkText: string; icon: React.ElementType }> = {
  CLINIC: { bg: 'bg-rose-100', text: 'text-rose-700', darkBg: 'dark:bg-rose-900/30', darkText: 'dark:text-rose-400', icon: Stethoscope },
  AGENCY: { bg: 'bg-sky-100', text: 'text-sky-700', darkBg: 'dark:bg-sky-900/30', darkText: 'dark:text-sky-400', icon: Globe },
  LAW_FIRM: { bg: 'bg-violet-100', text: 'text-violet-700', darkBg: 'dark:bg-violet-900/30', darkText: 'dark:text-violet-400', icon: Scale },
  LABORATORY: { bg: 'bg-amber-100', text: 'text-amber-700', darkBg: 'dark:bg-amber-900/30', darkText: 'dark:text-amber-400', icon: FlaskConical },
  GOVERNMENT: { bg: 'bg-slate-100', text: 'text-slate-700', darkBg: 'dark:bg-slate-800/50', darkText: 'dark:text-slate-400', icon: Landmark },
  OTHER: { bg: 'bg-gray-100', text: 'text-gray-700', darkBg: 'dark:bg-gray-800/50', darkText: 'dark:text-gray-400', icon: Building2 },
};

function getCategoryStyle(category: string) {
  return categoryColors[category.toUpperCase()] || categoryColors.OTHER;
}

interface AgencyCardProps {
  agency: AgencyListItem;
  idx: number;
  onSelectAgency: (agency: AgencyListItem) => void;
  onQuickJoin: (agencyId: string, serviceId?: string) => void;
  onToggleFavorite: (e: React.MouseEvent, agencyId: string) => void;
  isFavorite: boolean;
  isTogglingFav: boolean;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function AgencyCard({
  agency,
  idx,
  onSelectAgency,
  onQuickJoin,
  onToggleFavorite,
  isFavorite,
  isTogglingFav,
  t,
  lang,
}: AgencyCardProps) {
  const estWait = agency.waitingCount * (agency.avgServiceTime || 10);
  const queueStatus = agency.isQueueOpen && !agency.isPaused ? 'open' : agency.isPaused ? 'paused' : 'closed';
  const distKm = ((idx + 1) * 0.5 + (idx * 0.3)).toFixed(1);
  const catStyle = getCategoryStyle(agency.category);
  const CatIcon = catStyle.icon;

  return (
    <motion.div
      key={agency.id}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: idx * 0.07 }}
      whileHover={{ y: -6, scale: 1.02 }}
      className="group"
    >
      <Card
        className={`h-full cursor-pointer border-0 shadow-sm hover:shadow-xl hover:shadow-emerald-500/10 transition-all duration-300 hover:-translate-y-1 group-hover:border-emerald-200 dark:group-hover:border-emerald-800 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 relative overflow-hidden ${agency.isSponsored ? 'ring-1 ring-amber-200 dark:ring-amber-800/50' : ''}`}
        onClick={() => onSelectAgency(agency)}
      >
        {/* Gradient overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-br from-emerald-50/90 to-teal-50/60 dark:from-emerald-900/10 dark:to-teal-900/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />

        {/* Gradient top border for sponsored agencies */}
        {agency.isSponsored && (
          <div className="absolute top-0 start-0 end-0 h-1 bg-gradient-to-r from-amber-400 via-emerald-400 to-amber-400 shimmer-gradient z-10" />
        )}
        <CardContent className="p-4 relative">
          <div className="flex items-start justify-between mb-2.5">
            {/* Category-colored icon */}
            <div className={`h-10 w-10 rounded-xl ${catStyle.bg} ${catStyle.darkBg} flex items-center justify-center flex-shrink-0 group-hover:scale-110 transition-transform duration-300`}>
              <CatIcon className={`h-5 w-5 ${catStyle.text} ${catStyle.darkText}`} />
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              {agency.isSponsored && (
                <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 text-[10px] px-1.5 shimmer-badge">
                  <Star className="h-2.5 w-2.5 me-0.5 fill-amber-500 text-amber-500" />
                  {t('sponsored')}
                </Badge>
              )}
              {/* Inactive subscription badge */}
              {agency.subscriptionStatus !== 'ACTIVE' && (
                <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                  {t('inactiveAgency')}
                </Badge>
              )}
              {/* Live queue status indicator with pulsing dot */}
              <span className="flex items-center gap-1">
                <span className="relative flex h-2 w-2">
                  {queueStatus === 'open' && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  )}
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${queueStatus === 'open' ? 'bg-emerald-500' : queueStatus === 'paused' ? 'bg-yellow-500' : 'bg-red-500'}`} />
                </span>
                <Badge
                  variant="outline"
                  className={
                    queueStatus === 'open'
                      ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                      : queueStatus === 'paused'
                        ? 'text-[10px] bg-yellow-50 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200'
                        : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                  }
                >
                  {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
                </Badge>
              </span>
            </div>
          </div>

          <h3 className="font-semibold text-sm text-foreground mb-1 group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors">
            {getAgencyName(agency, lang)}
          </h3>

          <p className="text-xs text-muted-foreground mb-2 line-clamp-1 flex items-center gap-1">
            <MapPin className="h-3 w-3 flex-shrink-0" />
            {agency.address}
            <span className="ms-auto text-emerald-600 dark:text-emerald-400 font-medium">{distKm} km</span>
          </p>

          {/* Average wait time badge + service count */}
          {agency.isQueueOpen && !agency.isPaused && (
            <div className="flex items-center gap-1.5 mb-2">
              <Badge variant="outline" className="text-[10px] bg-teal-50 text-teal-700 dark:bg-teal-900/20 dark:text-teal-400 border-teal-200">
                <Clock className="h-2.5 w-2.5 me-1" />
                ~{estWait} {t('estWaitBadge')}
              </Badge>
              {agency.serviceCount > 1 && (
                <Badge variant="outline" className="text-[10px] bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200">
                  <Briefcase className="h-2.5 w-2.5 me-1" />
                  {agency.serviceCount} {t('services')}
                </Badge>
              )}
            </div>
          )}

          {/* Rating display */}
          {(agency.reviewCount ?? 0) > 0 && (agency.averageRating ?? 0) > 0 && (
            <div className="mb-2">
              <AgencyRatingDisplay
                averageRating={agency.averageRating ?? 0}
                totalCount={agency.reviewCount ?? 0}
                compact
                size="sm"
              />
            </div>
          )}

          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
            <div className="flex items-center gap-2">
              {/* Category tag with color coding */}
              <Badge variant="secondary" className={`text-[10px] ${catStyle.bg} ${catStyle.text} ${catStyle.darkBg} ${catStyle.darkText} border-0`}>
                <CatIcon className="h-2.5 w-2.5 me-1" />
                {getCategoryLabel(agency.category, t)}
              </Badge>
              {/* Live queue count with animated dot */}
              <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                <motion.div
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                />
                <UserRound className="h-3 w-3" />
                {agency.waitingCount} {t('waiting')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {/* Heart favorite button */}
              <button
                onClick={(e) => onToggleFavorite(e, agency.id)}
                disabled={isTogglingFav}
                className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors"
              >
                {isTogglingFav ? (
                  <Loader2 className="h-3.5 w-3.5 text-red-500 animate-spin" />
                ) : isFavorite ? (
                  <Heart className="h-3.5 w-3.5 text-red-500 fill-red-500" />
                ) : (
                  <Heart className="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" />
                )}
              </button>
              {/* Quick Join button for single-service agencies */}
              {agency.isQueueOpen && !agency.isPaused && agency.serviceCount === 1 && (
                <button
                  onClick={(e) => { e.stopPropagation(); if (agency.subscriptionStatus === 'ACTIVE') onQuickJoin(agency.id); }}
                  disabled={agency.subscriptionStatus !== 'ACTIVE'}
                  className={`h-7 px-2.5 rounded-full flex items-center gap-1 text-[10px] font-medium transition-colors ${agency.subscriptionStatus !== 'ACTIVE' ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
                >
                  <Zap className="h-3 w-3" />
                  {agency.subscriptionStatus !== 'ACTIVE' ? t('inactiveAgency') : t('agencyCardJoinNow')}
                </button>
              )}
              {/* Mini waiting count badge */}
              {agency.isQueueOpen && agency.serviceCount > 1 && (
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: idx * 0.05 + 0.3 }}
                  className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"
                >
                  <motion.div
                    animate={{ scale: [1, 1.3, 1] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                  />
                  {agency.serviceCount} {t('services')}
                </motion.div>
              )}
              <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180 group-hover:text-emerald-500 transition-colors" />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
