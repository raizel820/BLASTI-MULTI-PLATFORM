'use client';

/**
 * Task 83-c-2 — Customer-facing BRANCH PROFILE view (Design System v2).
 *
 * Branch-level sibling of customer-agency-profile.tsx (Task 81-b): mirrors its
 * architecture (apiFetch, layout-matching skeleton, friendly not-found,
 * shared ErrorState retry, paged reviews with Load More, per-card
 * framer-motion, back button) adapted to the branch payload.
 *
 * Public, no-auth data sources (keyed by the session-scoped store field
 * `branchProfileId` set by the entry point):
 *  - GET /api/agencies/branches/:branchId → { success, branch, agency, rating }
 *    • branch: id, name/nameFr/nameAr, specialName, subCode, isMain, address,
 *      city, wilaya, postalCode, latitude/longitude, locationVerified,
 *      locationSource, locationUpdatedAt, phone, counterCount.
 *    • agency: parent agency public profile — name/nameFr/nameAr, category,
 *      contacts, logoUrl/coverUrl, description×3, isQueueOpen, isPaused,
 *      isSponsored, workingHoursStart/End, workingDays CSV (0=Sunday..6),
 *      services[] (active only: { id, name, nameFr, nameAr, prefix }).
 *    • rating: { averageRating, reviewCount } — THIS branch's aggregate.
 *  - GET /api/reviews?agencyId=&branchId=&page=&limit= → branch-scoped
 *    reviews (id, rating, comment, replyText, repliedAt, createdAt,
 *    user { id, fullName, avatarUrl }) + averageRating/totalCount/totalPages.
 *
 * NOTE: reviews are keyed by agencyId + branchId and the agencyId only becomes
 * known once the branch payload resolves — so (unlike the agency profile page,
 * whose id is known up-front) the reviews fetch follows the branch fetch
 * instead of running in parallel.
 *
 * Read-only: reviews are displayed but never submitted here, and no
 * join/queue flows are started from this view.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  BadgeCheck,
  Building2,
  Clock,
  Globe,
  Hash,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Navigation,
  Phone,
  Star,
  Users,
} from 'lucide-react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import { getProxiedUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import { UserAvatar } from '@/components/shared/user-avatar';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import { AgencyLocationMap } from '@/components/shared/map/agency-location-map';
import { useCustomerLocation } from '@/hooks/use-customer-location';
import { formatDistance, haversineDistanceKm } from '@/lib/geo';
import { categoryKeys, getCategoryLabel, isOpenNow } from '@/components/customer/home/types';

/** Shape of GET /api/agencies/branches/:branchId → branch (rendered fields). */
interface BranchProfileBranch {
  id: string;
  name: string;
  nameFr: string | null;
  nameAr: string | null;
  specialName: string | null;
  subCode: string;
  isMain: boolean;
  address: string | null;
  city: string;
  wilaya: string;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  counterCount: number;
}

/** Parent agency payload of the same endpoint (rendered fields). */
interface BranchProfileAgency {
  id: string;
  name: string;
  nameFr: string | null;
  nameAr: string | null;
  category: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoUrl: string | null;
  coverUrl: string | null;
  description: string | null;
  descriptionFr: string | null;
  descriptionAr: string | null;
  isQueueOpen: boolean;
  isSponsored: boolean;
  workingHoursStart: string;
  workingHoursEnd: string;
  workingDays: string;
  services: { id: string; name: string; nameFr: string | null; nameAr: string | null; prefix: string }[];
}

/** Shape of GET /api/reviews → reviews[] (same contract as the agency page). */
interface ReviewItem {
  id: string;
  rating: number;
  comment: string | null;
  replyText: string | null;
  repliedAt: string | null;
  createdAt: string;
  user: { id: string; fullName: string; avatarUrl: string | null };
}

const REVIEWS_PAGE_SIZE = 20;
/** Oct 6 2024 is a Sunday — base + N lands on weekday N (0=Sunday..6=Saturday). */
const WEEKDAY_BASE = new Date(2024, 9, 6);

export function CustomerBranchProfile() {
  const setView = useAppStore((s) => s.setView);
  const branchProfileId = useAppStore((s) => s.branchProfileId);
  const { t, lang } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [branch, setBranch] = useState<BranchProfileBranch | null>(null);
  const [agency, setAgency] = useState<BranchProfileAgency | null>(null);
  const [rating, setRating] = useState({ averageRating: 0, reviewCount: 0 });

  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [reviewsError, setReviewsError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchReviews = useCallback(async (targetAgencyId: string, targetBranchId: string, page: number, append: boolean) => {
    try {
      const res = await apiFetch(
        `/api/reviews?agencyId=${encodeURIComponent(targetAgencyId)}&branchId=${encodeURIComponent(targetBranchId)}&page=${page}&limit=${REVIEWS_PAGE_SIZE}`,
      );
      if (!res.ok) {
        if (!append) setReviewsError(true);
        return;
      }
      const data = await res.json();
      const incoming: ReviewItem[] = Array.isArray(data.reviews) ? data.reviews : [];
      setReviews((prev) => (append ? [...prev, ...incoming] : incoming));
      setTotalCount(typeof data.totalCount === 'number' ? data.totalCount : 0);
      setTotalPages(typeof data.totalPages === 'number' ? Math.max(1, data.totalPages) : 1);
      setCurrentPage(page);
      setReviewsError(false);
    } catch {
      if (!append) setReviewsError(true);
    }
  }, []);

  const fetchData = useCallback(async () => {
    if (!branchProfileId) {
      // View opened without an id → immediate friendly not-found state.
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFetchError(false);
    setNotFound(false);
    setReviewsError(false);
    try {
      const res = await apiFetch(`/api/agencies/branches/${encodeURIComponent(branchProfileId)}`);
      if (res.status === 404) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setFetchError(true);
        setLoading(false);
        return;
      }
      const data = await res.json();
      const nextBranch = data?.branch ?? null;
      const nextAgency = data?.agency ?? null;
      if (!nextBranch || !nextAgency) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setBranch(nextBranch);
      setAgency(nextAgency);
      setRating({
        averageRating: typeof data.rating?.averageRating === 'number' ? data.rating.averageRating : 0,
        reviewCount: typeof data.rating?.reviewCount === 'number' ? data.rating.reviewCount : 0,
      });
      // Reviews need the agencyId carried by this payload → fetched here,
      // not in parallel (see file header note).
      await fetchReviews(nextAgency.id, nextBranch.id, 1, false);
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [branchProfileId, fetchReviews]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const loadMoreReviews = async () => {
    if (!agency || !branch || loadingMore || currentPage >= totalPages) return;
    setLoadingMore(true);
    try {
      await fetchReviews(agency.id, branch.id, currentPage + 1, true);
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Locale-aware helpers (pattern copied from customer-agency-profile) ──
  const localized = (base: string, fr: string | null | undefined, ar: string | null | undefined) =>
    (lang === 'ar' && ar ? ar : lang === 'fr' && fr ? fr : base);

  const branchName = branch ? localized(branch.name, branch.nameFr, branch.nameAr) : '';
  // Branch display title: the customer-facing specialName wins over the
  // locale-aware name fallback chain (nameAr→fr→name) used by the agency page.
  const branchTitle = (branch?.specialName ?? '').trim() || branchName;
  const agencyName = agency ? localized(agency.name, agency.nameFr, agency.nameAr) : '';
  const localizedDescription = agency
    ? localized(agency.description ?? '', agency.descriptionFr, agency.descriptionAr).trim() || null
    : null;
  const localizedServiceName = (s: { name: string; nameFr: string | null; nameAr: string | null }) =>
    localized(s.name, s.nameFr, s.nameAr);

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  // Open/closed badge: queue flag + working-days CSV + hours vs now
  // (same computation as the agency profile page — the branch has no hours
  // of its own; the parent agency's schedule governs).
  const isOpen = useMemo<'open' | 'closed'>(() => {
    if (!agency) return 'closed';
    if (!agency.isQueueOpen) return 'closed';
    const days = (agency.workingDays ?? '').split(',').map((d) => d.trim()).filter(Boolean);
    if (days.length > 0 && !days.includes(String(new Date().getDay()))) return 'closed';
    const hours = isOpenNow(agency.workingHoursStart, agency.workingHoursEnd);
    if (hours === null) return 'open'; // no usable hours → fall back to the queue flag
    return hours ? 'open' : 'closed';
  }, [agency]);

  const hasCoords = !!(branch && typeof branch.latitude === 'number' && typeof branch.longitude === 'number');

  // Task 82 — estimated distance to this branch (only when location access
  // is already granted — the hook never triggers a permission prompt).
  const { position: customerPosition } = useCustomerLocation(true);
  const distanceKm = useMemo(() => {
    if (!customerPosition || !hasCoords || !branch) return null;
    return haversineDistanceKm(customerPosition, { lat: branch.latitude as number, lng: branch.longitude as number });
  }, [customerPosition, hasCoords, branch]);

  // Short localized weekday names, Sunday..Saturday (same base-date trick as
  // lib/enum-i18n.formatWorkingDaysList so the app language always wins).
  const weekdayLabels = useMemo(() => {
    const locale = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';
    try {
      const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' });
      return Array.from({ length: 7 }, (_, d) => formatter.format(new Date(WEEKDAY_BASE.getFullYear(), WEEKDAY_BASE.getMonth(), WEEKDAY_BASE.getDate() + d)));
    } catch {
      return Array.from({ length: 7 }, (_, d) => String(d));
    }
  }, [lang]);

  const activeDays = useMemo(
    () => new Set((agency?.workingDays ?? '').split(',').map((d) => d.trim()).filter(Boolean)),
    [agency],
  );

  const branchAddressText = branch
    ? [branch.address, branch.city, branch.wilaya].map((v) => (v ?? '').trim()).filter(Boolean).join(', ')
    : '';
  const mapsSearchUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(branchAddressText)}`;
  const websiteHref = agency?.website
    ? (agency.website.startsWith('http://') || agency.website.startsWith('https://') ? agency.website : `https://${agency.website}`)
    : null;

  const CatIcon = agency ? (categoryKeys.find((c) => c.value === agency.category.toUpperCase())?.icon ?? Building2) : Building2;

  const backToHome = (
    <button
      onClick={() => setView('customer-home')}
      aria-label={t('back')}
      className="h-9 w-9 rounded-xl border border-border bg-white dark:bg-gray-900/80 flex items-center justify-center hover:bg-muted dark:hover:bg-gray-800 transition-colors shrink-0"
    >
      <ArrowLeft className="h-4 w-4 text-foreground rtl:rotate-180" />
    </button>
  );

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-9 rounded-xl" />
            <Skeleton className="h-6 w-40 rounded-lg" />
          </div>
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 space-y-3">
            <Skeleton className="h-28 md:h-40 w-full rounded-2xl" />
            <div className="flex items-center gap-3">
              <Skeleton className="h-14 w-14 rounded-2xl" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-5 w-2/3 rounded" />
                <Skeleton className="h-4 w-1/3 rounded" />
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 space-y-3">
            <Skeleton className="h-4 w-24 rounded" />
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-1/3 rounded" />
                  <Skeleton className="h-3 w-2/3 rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Fetch error on the branch endpoint → shared ErrorState with Retry ──
  if (fetchError) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-2 mb-3">
            {backToHome}
            <h1 className="text-lg font-bold text-foreground">{t('branchProfile')}</h1>
          </div>
          <ErrorState onRetry={fetchData} retryLabel={t('tryAgain')} />
        </div>
      </div>
    );
  }

  // ── Friendly not-found (404, or view opened without an id) ──
  if (notFound || !branch || !agency) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-2 mb-3">
            {backToHome}
            <h1 className="text-lg font-bold text-foreground">{t('branchProfile')}</h1>
          </div>
          <div className="flex flex-col items-center justify-center py-14 px-4 text-center">
            <div className="h-16 w-16 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
              <Building2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="text-lg font-bold text-foreground mb-1">{t('branchProfileNotFound')}</h2>
            <p className="text-sm text-muted-foreground max-w-sm mb-5">{t('branchProfileNotFoundDesc')}</p>
            <Button
              onClick={() => setView('customer-home')}
              className="h-10 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
            >
              {t('back')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Subtle Design System v2 motion, shared by every card below
  const motionProps = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.25 },
  } as const;

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Header: back + page title */}
        <div className="flex items-center gap-2">
          {backToHome}
          <h1 className="text-lg font-bold text-foreground">{t('branchProfile')}</h1>
        </div>

        {/* ── 1. Compact identity card ── */}
        <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
          {agency.coverUrl && (
            <img
              src={getProxiedUrl(agency.coverUrl)}
              alt={agencyName}
              className="h-28 md:h-40 w-full object-cover rounded-2xl mb-3"
            />
          )}
          <div className="flex items-start gap-3">
            {agency.logoUrl ? (
              <img
                src={getProxiedUrl(agency.logoUrl)}
                alt={agencyName}
                className="h-14 w-14 rounded-2xl object-cover border border-border shrink-0"
              />
            ) : (
              <span className="h-14 w-14 rounded-2xl bg-emerald-600 flex items-center justify-center text-white text-xl font-bold shrink-0">
                {agencyName.charAt(0).toUpperCase() || '·'}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-foreground leading-tight" title={branchTitle}>{branchTitle}</h2>
              <p className="text-xs text-muted-foreground mt-0.5 truncate" title={agencyName}>
                {t('branchOfAgency', { agency: agencyName })}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <Badge variant="outline" className="gap-1 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                  <CatIcon className="h-3 w-3" />
                  {getCategoryLabel(agency.category, t)}
                </Badge>
                {agency.isSponsored && (
                  <Badge variant="outline" className="gap-1 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800">
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                    {t('sponsored')}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={
                    isOpen === 'open'
                      ? 'gap-1 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                      : 'gap-1 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800'
                  }
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${isOpen === 'open' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                  {isOpen === 'open' ? t('openNow') : t('closed')}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                <Badge variant="outline" className="gap-1.5 bg-muted/50 dark:bg-gray-800/50 text-muted-foreground dark:text-gray-400 border-border">
                  <Hash className="h-3 w-3" />
                  {t('branchSubCode')}
                  <span className="font-mono text-[11px] text-foreground dark:text-gray-200" dir="ltr">{branch.subCode}</span>
                </Badge>
                {branch.isMain && (
                  <Badge variant="outline" className="gap-1 bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 border-teal-200 dark:border-teal-800">
                    <BadgeCheck className="h-3 w-3" />
                    {t('mainBranchBadge')}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </motion.section>

        {/* ── 2. Rating card (this branch's own aggregate) ── */}
        <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
              <Star className="h-4 w-4 text-amber-400 fill-amber-400" />
              {t('averageRating')}
            </h2>
            <AgencyRatingDisplay averageRating={rating.averageRating} totalCount={rating.reviewCount} size="md" />
          </div>
          <p className="text-xs text-muted-foreground mt-1">{t('agencyProfileReviewsCount', { count: String(rating.reviewCount) })}</p>
        </motion.section>

        {/* ── 3. Comments (branch-scoped reviews, read-only) ── */}
        <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-3">
            <MessageCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {t('reviews')}
            {totalCount > 0 && <span className="text-muted-foreground font-normal">({totalCount})</span>}
          </h2>

          {reviewsError ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm text-muted-foreground">{t('error')}</p>
              <Button
                variant="outline"
                size="sm"
                className="h-9 rounded-xl"
                onClick={() => fetchReviews(agency.id, branch.id, 1, false)}
              >
                {t('tryAgain')}
              </Button>
            </div>
          ) : totalCount === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t('noReviewsYet')}</p>
          ) : (
            <div className="space-y-2.5">
              {reviews.map((review) => (
                <div key={review.id} className="rounded-xl bg-muted/50 dark:bg-gray-800/50 p-3">
                  <div className="flex items-center gap-2.5">
                    <span className="h-9 w-9 rounded-full overflow-hidden bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center text-xs font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                      <UserAvatar avatarUrl={review.user?.avatarUrl} fullName={review.user?.fullName} size={36} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{review.user?.fullName || '—'}</p>
                      <span className="flex items-center gap-0.5 mt-0.5" aria-label={`${review.rating}/5`}>
                        {[1, 2, 3, 4, 5].map((i) => (
                          <Star
                            key={i}
                            className={`h-3 w-3 ${i <= review.rating ? 'fill-amber-400 text-amber-400' : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'}`}
                          />
                        ))}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">{formatDate(review.createdAt)}</span>
                  </div>
                  {review.comment && (
                    <p className="text-sm text-foreground/90 mt-2 whitespace-pre-line break-words">{review.comment}</p>
                  )}
                  {review.replyText && (
                    <div className="mt-2 ps-3 border-s-2 border-emerald-300 dark:border-emerald-700">
                      <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                        <MessageCircle className="h-3 w-3" />
                        {t('reviewReply')}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-line break-words">{review.replyText}</p>
                    </div>
                  )}
                </div>
              ))}

              {currentPage < totalPages && (
                <Button
                  variant="outline"
                  className="w-full h-10 rounded-xl border-border hover:bg-muted dark:hover:bg-gray-800"
                  onClick={loadMoreReviews}
                  disabled={loadingMore}
                >
                  {loadingMore && <Loader2 className="h-4 w-4 animate-spin me-2" />}
                  {t('loadMore')}
                </Button>
              )}
            </div>
          )}
        </motion.section>

        {/* ── 4. Branch location card ── */}
        {(hasCoords || branchAddressText) && (
          <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-3">
              <Navigation className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {t('branchProfileLocation')}
              {typeof distanceKm === 'number' && (
                <span className="ms-auto flex items-center gap-1 text-[11px] font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 rounded-full px-2 py-0.5" title={t('estimatedDistance')}>
                  <Navigation className="h-3 w-3 rtl:rotate-180" />
                  <span dir="ltr">
                    ~{(() => {
                      const d = formatDistance(distanceKm);
                      return d.unit === 'km' ? `${d.value} km` : `${d.value} m`;
                    })()}
                  </span>
                </span>
              )}
            </h2>
            {hasCoords ? (
              <AgencyLocationMap
                agency={{
                  latitude: branch.latitude,
                  longitude: branch.longitude,
                  name: branchTitle,
                  address: branch.address,
                  city: branch.city,
                }}
                showDirections
                // Task 82 — customers always get directions, regardless of the
                // super-admin maps config; the button deep-links to the
                // canonical google.com/maps/dir builder inside the shared map.
                alwaysAllowDirections
                height={220}
              />
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 dark:bg-gray-800/50 p-3">
                <p className="text-sm text-muted-foreground min-w-0 break-words">{branchAddressText}</p>
                <Button
                  size="sm"
                  className="h-9 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
                  onClick={() => window.open(mapsSearchUrl, '_blank', 'noopener,noreferrer')}
                >
                  <Navigation className="h-4 w-4 me-1.5" />
                  {t('maps.getDirections')}
                </Button>
              </div>
            )}
          </motion.section>
        )}

        {/* ── 5. Branch details card ── */}
        <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-3">
            <MapPin className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {t('agencyAddress')}
          </h2>
          <div className="space-y-1">
            {branchAddressText && (
              <div className="flex items-center gap-3 p-2 rounded-xl">
                <span className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                  <MapPin className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="block text-xs text-muted-foreground">{t('agencyAddress')}</span>
                  <span className="block text-sm font-medium text-foreground">{branchAddressText}</span>
                </div>
              </div>
            )}
            {branch.phone && (
              <a
                href={`tel:${branch.phone}`}
                className="flex items-center gap-3 p-2 rounded-xl hover:bg-muted/50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <span className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                  <Phone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="block text-xs text-muted-foreground">{t('phone')}</span>
                  <span className="block text-sm font-medium text-foreground truncate" dir="ltr">{branch.phone}</span>
                </div>
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 shrink-0">{t('agencyProfileCall')}</span>
              </a>
            )}
            <div className="flex items-center gap-3 p-2 rounded-xl">
              <span className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </span>
              <span className="flex-1 min-w-0 text-sm font-medium text-foreground">
                {t('branchCounters', { n: String(branch.counterCount) })}
              </span>
            </div>
          </div>
        </motion.section>

        {/* ── 6. Agency section: about + contacts + link to agency profile ── */}
        <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Building2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="truncate" title={agencyName}>{agencyName}</span>
          </h2>
          {localizedDescription && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-foreground mb-1">{t('about')}</p>
              <p className="text-sm text-muted-foreground whitespace-pre-line break-words">{localizedDescription}</p>
            </div>
          )}
          {(agency.phone || agency.email || websiteHref) && (
            <div className="mt-3 space-y-1">
              {agency.phone && (
                <a
                  href={`tel:${agency.phone}`}
                  className="flex items-center gap-3 p-2 rounded-xl hover:bg-muted/50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <span className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                    <Phone className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="block text-xs text-muted-foreground">{t('phone')}</span>
                    <span className="block text-sm font-medium text-foreground truncate" dir="ltr">{agency.phone}</span>
                  </div>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 shrink-0">{t('agencyProfileCall')}</span>
                </a>
              )}
              {agency.email && (
                <a
                  href={`mailto:${agency.email}`}
                  className="flex items-center gap-3 p-2 rounded-xl hover:bg-muted/50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <span className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                    <Mail className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="block text-xs text-muted-foreground">{t('email')}</span>
                    <span className="block text-sm font-medium text-foreground truncate" dir="ltr">{agency.email}</span>
                  </div>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 shrink-0">{t('email')}</span>
                </a>
              )}
              {websiteHref && (
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-2 rounded-xl hover:bg-muted/50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <span className="h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
                    <Globe className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="block text-xs text-muted-foreground">{t('agencyProfileWebsite')}</span>
                    <span className="block text-sm font-medium text-foreground truncate" dir="ltr">{agency.website}</span>
                  </div>
                  <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 shrink-0">{t('agencyProfileWebsite')}</span>
                </a>
              )}
            </div>
          )}
          <Button
            onClick={() => {
              useAppStore.getState().setAgencyProfileId(agency.id);
              setView('customer-agency-profile');
            }}
            className="w-full h-10 mt-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
          >
            <Building2 className="h-4 w-4 me-2" />
            {t('viewAgencyProfile')}
          </Button>
        </motion.section>

        {/* ── 7. Services card (agency-level services) ── */}
        {agency.services.length > 0 && (
          <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-3">
              <Building2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {t('services')}
            </h2>
            <ul className="flex flex-wrap gap-1.5">
              {agency.services.map((service) => (
                <li
                  key={service.id}
                  className="flex items-center gap-1.5 rounded-lg bg-muted/50 dark:bg-gray-800/50 px-2 py-1"
                >
                  <span className="h-4 min-w-4 px-1 rounded bg-emerald-600 text-white text-[9px] font-bold font-mono flex items-center justify-center" dir="ltr">
                    {service.prefix}
                  </span>
                  <span className="text-xs text-foreground">{localizedServiceName(service)}</span>
                </li>
              ))}
            </ul>
          </motion.section>
        )}

        {/* ── 8. Working hours card (parent agency schedule) ── */}
        <motion.section {...motionProps} className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-3">
            <Clock className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {t('workingHours')}
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {weekdayLabels.map((label, day) => {
              const active = activeDays.has(String(day));
              return (
                <span
                  key={day}
                  className={`px-2 py-1 rounded-lg text-[11px] font-medium ${
                    active
                      ? 'bg-emerald-600 text-white'
                      : 'bg-muted text-muted-foreground dark:bg-gray-800'
                  }`}
                >
                  {label}
                </span>
              );
            })}
          </div>
          {agency.workingHoursStart && agency.workingHoursEnd && (
            <div className="mt-3 flex items-center gap-2 text-sm text-foreground">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium" dir="ltr">{agency.workingHoursStart} – {agency.workingHoursEnd}</span>
            </div>
          )}
        </motion.section>

        {/* ── 9. Muted queue status line (informational only — NO join flow).
             The branch endpoint carries no live waiting count (no
             activeQueueCount on this payload), so the open state shows the
             openNow label instead of fabricating a "{count} waiting" figure;
             the closed state keeps the queueClosed key, as on the agency page. ── */}
        <p className="text-xs text-muted-foreground flex items-center justify-center gap-1.5 pt-1">
          <Users className="h-3.5 w-3.5" />
          {agency.isQueueOpen ? t('openNow') : t('queueClosed')}
        </p>
      </div>
    </div>
  );
}
