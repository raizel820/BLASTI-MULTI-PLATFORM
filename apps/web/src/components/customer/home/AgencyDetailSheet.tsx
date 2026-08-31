'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  MapPin,
  ChevronRight,
  Users,
  TicketCheck,
  Clock,
  ArrowLeft,
  Star,
  MessageCircle,
  Calendar,
  Building2,
  Stethoscope,
  Globe,
  Scale,
  FlaskConical,
  Landmark,
  Navigation,
  Briefcase,
  UserRound,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import type { AgencyDetail } from './types';
import { getAgencyName, getCategoryLabel, isOpenNow } from './types';

// Category icon mapping
const categoryIcons: Record<string, React.ElementType> = {
  CLINIC: Stethoscope,
  AGENCY: Globe,
  LAW_FIRM: Scale,
  LABORATORY: FlaskConical,
  GOVERNMENT: Landmark,
  OTHER: Building2,
};

interface AgencyDetailSheetProps {
  agency: AgencyDetail;
  onBack: () => void;
  onJoinQueue: (agencyId: string, serviceId?: string) => void;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function AgencyDetailSheet({
  agency,
  onBack,
  onJoinQueue,
  t,
  lang,
}: AgencyDetailSheetProps) {
  const totalWaiting = agency.services.reduce((sum, s) => sum + (s.waitingCount || 0), 0);
  const estWait = totalWaiting * (agency.avgServiceTime || 10);
  const CatIcon = categoryIcons[agency.category.toUpperCase()] || Building2;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      className="px-4 py-4 pb-24"
    >
      <button
        onClick={onBack}
        className="text-sm text-emerald-600 dark:text-emerald-400 font-medium mb-4 flex items-center gap-1 hover:underline"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('back')}
      </button>

      <Card className="shadow-lg border-0 mb-4 overflow-hidden bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        {/* Gradient header with category icon */}
        <div className="h-36 bg-gradient-to-r from-emerald-500 via-teal-600 to-emerald-600 relative overflow-hidden">
          <div className="absolute inset-0 opacity-[0.06]" style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
            backgroundSize: '20px 20px',
          }} />
          <div className="absolute top-4 end-4 h-12 w-12 rounded-xl bg-white/15 backdrop-blur-sm flex items-center justify-center">
            <CatIcon className="h-6 w-6 text-white" />
          </div>
        </div>
        <CardContent className="p-4 -mt-10">
          <div className="h-16 w-16 rounded-2xl bg-white dark:bg-gray-800 shadow-lg flex items-center justify-center mb-3 border-4 border-white dark:border-gray-800">
            <TicketCheck className="h-7 w-7 text-emerald-600" />
          </div>
          <h2 className="text-xl font-bold text-foreground mb-1">
            {getAgencyName(agency, lang)}
          </h2>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
            <MapPin className="h-4 w-4" />
            <span>{agency.address}</span>
          </div>
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <Badge variant="outline" className="text-xs">
              <CatIcon className="h-3 w-3 me-1" />
              {getCategoryLabel(agency.category, t)}
            </Badge>
            {agency.subscriptionStatus !== 'ACTIVE' && (
              <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                {t('inactiveAgency')}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={
                agency.isQueueOpen && !agency.isPaused
                  ? 'text-xs bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                  : 'text-xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
              }
            >
              {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
            </Badge>
            {/* Working Hours */}
            {agency.workingHoursStart && agency.workingHoursEnd && (() => {
              const open = isOpenNow(agency.workingHoursStart, agency.workingHoursEnd);
              return (
                <Badge
                  variant="outline"
                  className={
                    open
                      ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                      : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                  }
                >
                  <Clock className="h-2.5 w-2.5 me-1" />
                  {open
                    ? `${t('openUntil')} ${agency.workingHoursEnd}`
                    : agency.isPaused
                      ? t('paused')
                      : `${t('closedNow')} · ${t('openFrom')} ${agency.workingHoursStart}`
                  }
                </Badge>
              );
            })()}
          </div>

          {/* Working Hours Section */}
          {agency.workingHoursStart && agency.workingHoursEnd && (
            <div className="mb-4 p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-border">
              <div className="flex items-center gap-2 mb-1.5">
                <Calendar className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <span className="text-xs font-semibold text-foreground">{t('workingHoursLabel')}</span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span>{agency.workingHoursStart} — {agency.workingHoursEnd}</span>
                {isOpenNow(agency.workingHoursStart, agency.workingHoursEnd) ? (
                  <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-1.5 py-0.5 rounded-full">
                    {t('openNow')}
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-1.5 py-0.5 rounded-full">
                    {t('closed')}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Queue Info */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Users className="h-4 w-4 text-emerald-600" />
                <span className="text-xs text-muted-foreground">{t('currentlyWaiting')}</span>
              </div>
              <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
                {totalWaiting}
              </p>
            </div>
            <div className="bg-teal-50 dark:bg-teal-900/20 rounded-xl p-3 text-center">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Clock className="h-4 w-4 text-teal-600" />
                <span className="text-xs text-muted-foreground">{t('avgWaitTime')}</span>
              </div>
              <p className="text-2xl font-bold text-teal-700 dark:text-teal-400">
                ~{estWait} {t('min')}
              </p>
            </div>
          </div>

          {/* Queue Unavailable Message for Inactive Subscriptions */}
          {agency.subscriptionStatus !== 'ACTIVE' && (
            <div className="mb-4 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
              <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">{t('queueUnavailable')}</p>
            </div>
          )}

          {/* Services Available Section */}
          {agency.services.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-3">
                <Briefcase className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="font-semibold text-sm text-foreground">{t('servicesAvailable')}</h3>
                <Badge variant="secondary" className="text-[10px]">{agency.services.length}</Badge>
              </div>
              <div className="space-y-2">
                {agency.services.map((svc) => (
                  <motion.button
                    key={svc.id}
                    whileHover={{ x: 4 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => onJoinQueue(agency.id, svc.id)}
                    disabled={agency.isPaused || !agency.isQueueOpen || agency.subscriptionStatus !== 'ACTIVE'}
                    className="w-full flex items-center justify-between p-3 rounded-xl border border-border hover:border-emerald-300 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors disabled:opacity-50"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-8 w-8 rounded-lg bg-teal-50 dark:bg-teal-900/20 flex items-center justify-center flex-shrink-0">
                        <Navigation className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-medium block">
                          {lang === 'ar' && svc.nameAr ? svc.nameAr : lang === 'fr' && svc.nameFr ? svc.nameFr : svc.name}
                        </span>
                        {svc.waitingCount > 0 && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                            <UserRound className="h-3 w-3" />
                            {svc.waitingCount} {t('waiting')}
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180" />
                  </motion.button>
                ))}
              </div>
            </div>
          )}

          {/* Join Queue (no services) */}
          {agency.services.length === 0 && (
            <Button
              className="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold rounded-xl"
              onClick={() => onJoinQueue(agency.id)}
              disabled={agency.isPaused || !agency.isQueueOpen || agency.subscriptionStatus !== 'ACTIVE'}
            >
              {agency.subscriptionStatus !== 'ACTIVE' ? t('queueUnavailable') : agency.isQueueOpen ? t('joinQueue') : t('closed')}
            </Button>
          )}

          {/* Reviews Section */}
          <AgencyReviewsPreview agencyId={agency.id} averageRating={agency.averageRating} reviewCount={agency.reviewCount} />
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Agency Reviews Preview (for customer agency detail dialog) ────
function AgencyReviewsPreview({ agencyId, averageRating, reviewCount }: { agencyId: string; averageRating?: number; reviewCount?: number }) {
  const { t, lang } = useLanguage();
  const [reviews, setReviews] = useState<Array<{
    id: string;
    rating: number;
    comment: string | null;
    createdAt: string;
    user: { fullName: string; avatarUrl?: string };
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const fetchReviews = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/reviews?agencyId=${encodeURIComponent(agencyId)}&limit=5`);
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews ?? []);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [agencyId]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  if (loading) {
    return (
      <div className="mt-4 pt-4 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-4 w-4 bg-muted rounded animate-pulse" />
          <div className="h-4 w-24 bg-muted rounded animate-pulse" />
        </div>
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 bg-muted/50 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="mt-4 pt-4 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <MessageCircle className="h-4 w-4 text-amber-500" />
          <h3 className="font-semibold text-sm text-foreground">{t('customerReviews')}</h3>
        </div>
        <div className="text-center py-6">
          <div className="h-12 w-12 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mx-auto mb-2">
            <Star className="h-6 w-6 text-amber-300 dark:text-amber-700" />
          </div>
          <p className="text-sm text-muted-foreground">{t('noReviewsYet')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{t('beFirstToReview')}</p>
        </div>
      </div>
    );
  }

  const displayReviews = showAll ? reviews : reviews.slice(0, 3);

  return (
    <div className="mt-4 pt-4 border-t border-border">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-amber-500" />
          <h3 className="font-semibold text-sm text-foreground">{t('customerReviews')}</h3>
        </div>
        <div className="flex items-center gap-1.5">
          <AgencyRatingDisplay
            averageRating={averageRating ?? 0}
            totalCount={reviewCount ?? reviews.length}
            compact
            size="sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <AnimatePresence>
          {displayReviews.map((review, idx) => {
            const initials = review.user.fullName
              .split(' ')
              .map((n: string) => n[0])
              .filter(Boolean)
              .slice(0, 2)
              .join('')
              .toUpperCase();
            const colors = ['bg-emerald-500', 'bg-teal-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500'];
            const colorClass = colors[review.user.fullName.length % colors.length];

            return (
              <motion.div
                key={review.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="flex items-start gap-2.5 p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/50"
              >
                <div className={`h-8 w-8 rounded-full ${colorClass} flex items-center justify-center flex-shrink-0`}>
                  <span className="text-[10px] font-bold text-white">{initials || '?'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground">{review.user.fullName}</span>
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={`h-2.5 w-2.5 ${
                            star <= review.rating
                              ? 'fill-amber-400 text-amber-400'
                              : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  {review.comment && (
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{review.comment}</p>
                  )}
                  <span className="text-[10px] text-muted-foreground/70">
                    {new Date(review.createdAt).toLocaleDateString(
                      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
                      { month: 'short', day: 'numeric' }
                    )}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {reviews.length > 3 && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-xs text-emerald-600 dark:text-emerald-400 hover:text-emerald-700"
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? t('showLess' as any) || 'Show less' : `${t('seeAllReviews')} (${reviews.length})`}
        </Button>
      )}
    </div>
  );
}
