'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/shared/empty-state';
import {
  Star,
  MessageSquareReply,
  Flag,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Send,
  Loader2,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface ReviewUser {
  id: string;
  fullName: string;
  avatarUrl?: string;
}

interface Review {
  id: string;
  rating: number;
  comment: string | null;
  replyText: string | null;
  repliedAt: string | null;
  createdAt: string;
  userId: string;
  agencyId: string;
  user: ReviewUser;
}

type SortOption = 'newest' | 'highest' | 'lowest';
type FilterRating = 0 | 1 | 2 | 3 | 4 | 5;

// Color palette for user avatars
const avatarColors = [
  'bg-emerald-500',
  'bg-teal-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-cyan-500',
  'bg-pink-500',
  'bg-orange-500',
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function formatDate(dateStr: string, lang: string) {
  try {
    return new Date(dateStr).toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { year: 'numeric', month: 'short', day: 'numeric' }
    );
  } catch {
    return '';
  }
}

function formatRelativeTime(dateStr: string, lang: string) {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (lang === 'ar') {
    if (diffMins < 1) return 'الآن';
    if (diffMins < 60) return `منذ ${diffMins} دقيقة`;
    if (diffHours < 24) return `منذ ${diffHours} ساعة`;
    if (diffDays < 7) return `منذ ${diffDays} يوم`;
    return formatDate(dateStr, lang);
  }
  if (lang === 'fr') {
    if (diffMins < 1) return "à l'instant";
    if (diffMins < 60) return `il y a ${diffMins} min`;
    if (diffHours < 24) return `il y a ${diffHours}h`;
    if (diffDays < 7) return `il y a ${diffDays}j`;
    return formatDate(dateStr, lang);
  }
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateStr, lang);
}

// ─── Star Rating Display ─────────────
function StarRating({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' }) {
  const starClass = size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`${starClass} ${
            star <= rating
              ? 'fill-amber-400 text-amber-400'
              : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'
          }`}
        />
      ))}
    </div>
  );
}

// ─── Rating Distribution Chart ─────────────
function RatingDistChart({ reviews }: { reviews: Review[] }) {
  const { t } = useLanguage();
  const distribution = useMemo(() => {
    const counts = [0, 0, 0, 0, 0]; // index 0=1star, 4=5star
    reviews.forEach((r) => {
      if (r.rating >= 1 && r.rating <= 5) counts[r.rating - 1]++;
    });
    return counts;
  }, [reviews]);

  const maxCount = Math.max(...distribution, 1);
  const total = reviews.length;

  const starColors = [
    'from-rose-400/40 to-orange-400/40',
    'from-orange-400/50 to-amber-400/50',
    'from-yellow-400/60 to-amber-400/60',
    'from-amber-400/80 to-yellow-500/80',
    'from-amber-400 to-yellow-500',
  ];

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
          {t('ratingDistribution')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-2">
          {[5, 4, 3, 2, 1].map((star, idx) => {
            const count = distribution[star - 1];
            const pct = total > 0 ? (count / total) * 100 : 0;
            const barPct = (count / maxCount) * 100;
            return (
              <div key={star} className="flex items-center gap-2">
                <div className="flex items-center gap-1 w-10 flex-shrink-0">
                  <span className="text-xs font-semibold text-foreground">{star}</span>
                  <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                </div>
                <div className="flex-1 h-3 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.max(barPct, 2)}%` }}
                    transition={{ duration: 0.6, delay: idx * 0.08, ease: 'easeOut' }}
                    className={`h-full rounded-full bg-gradient-to-r ${starColors[star - 1]}`}
                  />
                </div>
                <div className="flex items-center gap-1 w-16 justify-end flex-shrink-0">
                  <span className="text-xs font-medium text-muted-foreground">{count}</span>
                  <span className="text-[10px] text-muted-foreground">({pct.toFixed(0)}%)</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Review Card ─────────────
function ReviewCard({
  review,
  lang,
  onReply,
  onReport,
  replyingId,
  replyText,
  onReplyTextChange,
  onReplySubmit,
  replyLoading,
}: {
  review: Review;
  lang: string;
  onReply: (id: string) => void;
  onReport: (id: string) => void;
  replyingId: string | null;
  replyText: string;
  onReplyTextChange: (text: string) => void;
  onReplySubmit: (id: string) => void;
  replyLoading: boolean;
}) {
  const { t } = useLanguage();
  const isReplying = replyingId === review.id;
  const avatarColor = getAvatarColor(review.user.fullName);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
    >
      <Card className="border border-border/50 bg-white dark:bg-gray-900/80 hover:shadow-md transition-shadow">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            {/* Avatar */}
            <div className={`h-10 w-10 rounded-full ${avatarColor} flex items-center justify-center flex-shrink-0`}>
              <span className="text-sm font-bold text-white">
                {getInitials(review.user.fullName) || '?'}
              </span>
            </div>

            <div className="flex-1 min-w-0">
              {/* Header */}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-sm text-foreground">{review.user.fullName}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <StarRating rating={review.rating} />
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(review.createdAt, lang)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!review.replyText && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-emerald-600"
                      onClick={() => onReply(review.id)}
                    >
                      <MessageSquareReply className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">{t('replyToReview')}</span>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-red-500"
                    onClick={() => onReport(review.id)}
                  >
                    <Flag className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Comment */}
              {review.comment && (
                <p className="text-sm text-foreground/80 mt-2 leading-relaxed">
                  {review.comment}
                </p>
              )}

              {/* Agency Reply */}
              {review.replyText && (
                <div className="mt-3 ms-4 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/30">
                  <div className="flex items-center gap-1.5 mb-1">
                    <div className="h-5 w-5 rounded-full bg-emerald-500 flex items-center justify-center">
                      <MessageSquareReply className="h-3 w-3 text-white" />
                    </div>
                    <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      {t('replyToReview')}
                    </span>
                    {review.repliedAt && (
                      <span className="text-[10px] text-muted-foreground">
                        · {formatRelativeTime(review.repliedAt, lang)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-emerald-800 dark:text-emerald-300 leading-relaxed">
                    {review.replyText}
                  </p>
                </div>
              )}

              {/* Reply Input */}
              <AnimatePresence>
                {isReplying && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="mt-3"
                  >
                    <Textarea
                      placeholder={t('writeReply')}
                      value={replyText}
                      onChange={(e) => onReplyTextChange(e.target.value)}
                      className="min-h-[60px] resize-none rounded-xl text-sm"
                      maxLength={500}
                    />
                    <div className="flex items-center gap-2 mt-2 justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-3 text-xs"
                        onClick={() => onReply('')}
                      >
                        {t('cancel')}
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 px-3 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg gap-1"
                        disabled={!replyText.trim() || replyLoading}
                        onClick={() => onReplySubmit(review.id)}
                      >
                        {replyLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        {t('submit')}
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Main Agency Reviews Component ─────────────
export function AgencyReviews() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const agencyId = user?.agencyId || '';

  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [averageRating, setAverageRating] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [filterRating, setFilterRating] = useState<FilterRating>(0);
  const [sortOption, setSortOption] = useState<SortOption>('newest');
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replyLoading, setReplyLoading] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);

  const fetchReviews = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/reviews?agencyId=${encodeURIComponent(agencyId)}&limit=100`);
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews ?? []);
        setAverageRating(data.averageRating ?? 0);
        setTotalCount(data.totalCount ?? 0);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [agencyId, t]);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const filteredAndSorted = useMemo(() => {
    let filtered = filterRating > 0
      ? reviews.filter((r) => r.rating === filterRating)
      : reviews;

    switch (sortOption) {
      case 'newest':
        return [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      case 'highest':
        return [...filtered].sort((a, b) => b.rating - a.rating);
      case 'lowest':
        return [...filtered].sort((a, b) => a.rating - b.rating);
      default:
        return filtered;
    }
  }, [reviews, filterRating, sortOption]);

  const displayedReviews = useMemo(() => {
    if (showAllReviews) return filteredAndSorted;
    return filteredAndSorted.slice(0, 10);
  }, [filteredAndSorted, showAllReviews]);

  const handleReply = (id: string) => {
    setReplyingId(id === replyingId ? null : id);
    setReplyText('');
  };

  const handleReplySubmit = async (reviewId: string) => {
    if (!replyText.trim() || !agencyId) return;
    setReplyLoading(true);
    try {
      const res = await apiFetch(`/api/reviews/${reviewId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId, text: replyText.trim() }),
      });
      if (res.ok) {
        toast.success(t('replySubmitted'));
        setReplyingId(null);
        setReplyText('');
        fetchReviews();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setReplyLoading(false);
    }
  };

  const handleReport = (reviewId: string) => {
    // For now, just show a toast. Could be expanded to a report API.
    toast.success(t('reportReview') + ' ✓');
  };

  const filterButtons: { value: FilterRating; label: string }[] = [
    { value: 0, label: t('all') },
    { value: 5, label: '5 ★' },
    { value: 4, label: '4 ★' },
    { value: 3, label: '3 ★' },
    { value: 2, label: '2 ★' },
    { value: 1, label: '1 ★' },
  ];

  const sortButtons: { value: SortOption; label: string }[] = [
    { value: 'newest', label: t('newest') },
    { value: 'highest', label: t('highestRated') },
    { value: 'lowest', label: t('lowestRated') },
  ];

  if (loading) {
    return (
      <div className="p-4 lg:p-5 space-y-3">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <Skeleton className="h-40 rounded-2xl" />
          <div className="lg:col-span-2 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-4 w-8 rounded" />
                <Skeleton className="h-3.5 w-3.5 rounded shrink-0" />
                <Skeleton className="h-3 flex-1 rounded-full" />
                <Skeleton className="h-3 w-12 rounded" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-16 rounded-lg" />
          <Skeleton className="h-7 w-12 rounded-lg" />
          <Skeleton className="h-7 w-12 rounded-lg" />
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-border/50 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <Skeleton className="h-10 w-10 rounded-full shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32 rounded" />
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Skeleton key={s} className="h-3.5 w-3.5 rounded" />
                  ))}
                </div>
                <Skeleton className="h-3 w-full rounded" />
                <Skeleton className="h-3 w-4/5 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-5 space-y-4 relative">
      {/* Gradient top border */}
      <div className="absolute top-0 start-0 end-0 h-[3px] bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-500 rounded-full" />

      {/* Title */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl lg:text-2xl font-bold text-foreground flex items-center gap-2">
            <Star className="h-6 w-6 text-amber-500 fill-amber-500" />
            {t('customerReviews')}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('reviewsPage')}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchReviews}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Average Rating Card + Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Average Rating */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <Card className="border-0 shadow-sm bg-gradient-to-br from-amber-50 to-white dark:from-amber-900/20 dark:to-gray-900/80 overflow-hidden">
            <CardContent className="p-6 text-center">
              <div className="flex flex-col items-center gap-2">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.2 }}
                  className="text-5xl font-black text-amber-600 dark:text-amber-400"
                >
                  {averageRating.toFixed(1)}
                </motion.div>
                <StarRating rating={Math.round(averageRating)} size="md" />
                <p className="text-sm text-muted-foreground mt-1">
                  {totalCount} {t('reviews')}
                </p>
                {totalCount > 0 && (
                  <Badge variant="secondary" className="mt-2 text-xs">
                    <Star className="h-3 w-3 me-1 fill-amber-400 text-amber-400" />
                    {averageRating.toFixed(1)} / 5
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Distribution Chart */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="lg:col-span-2"
        >
          <RatingDistChart reviews={reviews} />
        </motion.div>
      </div>

      {/* Filter & Sort */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="flex flex-col sm:flex-row gap-3"
      >
        {/* Filter by Rating */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-muted-foreground">{t('filterByRating')}:</span>
          <div className="flex flex-wrap gap-1">
            {filterButtons.map((btn) => (
              <Button
                key={btn.value}
                variant={filterRating === btn.value ? 'default' : 'outline'}
                size="sm"
                className={`h-7 px-2.5 text-xs rounded-lg ${
                  filterRating === btn.value
                    ? 'bg-amber-500 hover:bg-amber-600 text-white border-amber-500'
                    : 'hover:border-amber-300'
                }`}
                onClick={() => setFilterRating(btn.value)}
              >
                {btn.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-muted-foreground">{t('sortBy')}:</span>
          <div className="flex gap-1">
            {sortButtons.map((btn) => (
              <Button
                key={btn.value}
                variant={sortOption === btn.value ? 'default' : 'outline'}
                size="sm"
                className={`h-7 px-2.5 text-xs rounded-lg ${
                  sortOption === btn.value
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600'
                    : 'hover:border-emerald-300'
                }`}
                onClick={() => setSortOption(btn.value)}
              >
                {btn.label}
              </Button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* Reviews List */}
      {filteredAndSorted.length === 0 ? (
        <EmptyState
          iconComponent={MessageCircle}
          title={t('noReviewsYet')}
          description={t('beFirstToReview')}
        />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {filteredAndSorted.length} {filteredAndSorted.length === 1 ? t('reviews') : t('allReviews')}
            </p>
          </div>

          <AnimatePresence mode="popLayout">
            {displayedReviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                lang={lang}
                onReply={handleReply}
                onReport={handleReport}
                replyingId={replyingId}
                replyText={replyText}
                onReplyTextChange={setReplyText}
                onReplySubmit={handleReplySubmit}
                replyLoading={replyLoading}
              />
            ))}
          </AnimatePresence>

          {/* Show more/less */}
          {filteredAndSorted.length > 10 && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-xl gap-1 text-xs"
                onClick={() => setShowAllReviews(!showAllReviews)}
              >
                {showAllReviews ? (
                  <>
                    <ChevronUp className="h-3.5 w-3.5" />
                    {t('showLess' as any) || 'Show less'}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3.5 w-3.5" />
                    {t('seeAllReviews')} ({filteredAndSorted.length})
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
