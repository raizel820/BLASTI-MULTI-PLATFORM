'use client';
/**
 * Customer Favorites — Task 79-b rebuild (Design System v2).
 *
 * Logic preserved 1:1 from the previous implementation:
 *  - GET /api/favorites?userId=… (fetchWithRetry)
 *  - POST /api/favorites toggle (unfavorite with heart-break animation delay)
 *  - Sort options (recent / name / rating)
 *  - Join-queue flow with Calendar date dialog → POST /api/reservations → setView('customer-queue')
 *  - isOpenNow computed from working hours
 *  - Loading / error / empty states
 * Visual: compact card grid (2-col mobile / 3-col desktop) with remove-heart,
 * open/closed badge, working hours, sponsored star.
 */
import { apiFetch } from '@/lib/api-fetch';
import { toLocalDateString } from '@/lib/date-utils';
// Task 84 — IndexedDB stale-while-revalidate: favorites render instantly from
// the last-known list (shared key with customer-home) and refresh silently.
import { cacheGet, cacheSet, cacheKeyFor } from '@/lib/local-cache';

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Calendar } from '@/components/ui/calendar';
import {
  Heart,
  Clock,
  MapPin,
  TicketCheck,
  ChevronRight,
  Info,
  Loader2,
  Star,
  CalendarDays,
  ArrowUpDown,
  Search,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

type SortOption = 'name' | 'rating' | 'recent';

interface FavoriteAgency {
  id: string;
  agencyId: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  address: string;
  customCode: string;
  isQueueOpen: boolean;
  isSponsored: boolean;
  workingHoursStart: string;
  workingHoursEnd: string;
  services: { id: string; name: string }[];
  favoritedAt: string;
}

export function CustomerFavorites() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const [favorites, setFavorites] = useState<FavoriteAgency[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [unfavoriting, setUnfavoriting] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortOption>('recent');
  const [heartBreakingId, setHeartBreakingId] = useState<string | null>(null);

  useEffect(() => {
    fetchFavorites();
  }, []);

  const fetchFavorites = async () => {
    if (!user?.id) return;
    setLoading(true);
    setFetchError(false);
    // Task 84 — instant cache paint (same key as customer-home's favorites fetch).
    const favKey = cacheKeyFor('/api/favorites', { userId: user.id });
    const cachedFav = await cacheGet<{ favorites?: FavoriteAgency[] }>(favKey);
    if (cachedFav?.data?.favorites?.length) {
      setFavorites(cachedFav.data.favorites);
      setLoading(false);
    }
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/favorites?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        void cacheSet(favKey, data);
        setFavorites(data.favorites ?? []);
      } else if (!cachedFav?.data?.favorites?.length) {
        setFetchError(true);
        toast.error(t('error'));
      }
    } catch {
      if (!cachedFav?.data?.favorites?.length) {
        setFetchError(true);
        toast.error(t('error'));
      }
    } finally {
      setLoading(false);
    }
  };

  const toggleFavorite = async (agencyId: string) => {
    if (!user?.id) return;
    setUnfavoriting(agencyId);
    setHeartBreakingId(agencyId);
    try {
      const res = await apiFetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, agencyId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.favorited) {
          // Wait for heart break animation to complete
          setTimeout(() => {
            setFavorites((prev) => prev.filter((f) => f.agencyId !== agencyId));
            setHeartBreakingId(null);
          }, 400);
          toast.success(t('unfavoriteAgency'));
        }
      }
    } catch {
      toast.error(t('error'));
      setHeartBreakingId(null);
    } finally {
      setUnfavoriting(null);
    }
  };

  // Date picker state for joining queue
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [pendingAgencyId, setPendingAgencyId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const handleJoinQueue = (agencyId: string) => {
    setPendingAgencyId(agencyId);
    setSelectedDate(undefined);
    setDateDialogOpen(true);
  };

  const confirmJoinQueue = async () => {
    if (!user?.id || !pendingAgencyId) return;
    setJoining(true);
    try {
      const body: Record<string, string> = { userId: user.id, agencyId: pendingAgencyId };
      if (selectedDate) {
        const today = new Date();
        const isToday = selectedDate.getFullYear() === today.getFullYear()
          && selectedDate.getMonth() === today.getMonth()
          && selectedDate.getDate() === today.getDate();
        if (!isToday) {
          body.reservedDate = toLocalDateString(selectedDate);
        }
      }
      const res = await apiFetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast.success(t('joinSuccess'));
        setDateDialogOpen(false);
        setPendingAgencyId(null);
        setView('customer-queue');
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setJoining(false);
    }
  };

  const getAgencyName = (a: FavoriteAgency) => {
    if (lang === 'ar' && a.nameAr) return a.nameAr;
    if (lang === 'fr' && a.nameFr) return a.nameFr;
    return a.name;
  };

  const isOpenNow = (start: string, end: string) => {
    if (!start || !end) return null;
    const now = new Date();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  };

  // Sorted favorites
  const sortedFavorites = useMemo(() => {
    const sorted = [...favorites];
    switch (sortBy) {
      case 'name':
        return sorted.sort((a, b) => {
          const nameA = getAgencyName(a).toLowerCase();
          const nameB = getAgencyName(b).toLowerCase();
          return nameA.localeCompare(nameB);
        });
      case 'rating':
        return sorted.sort((a, b) => (b.isSponsored ? 1 : 0) - (a.isSponsored ? 1 : 0));
      case 'recent':
      default:
        return sorted.sort((a, b) => new Date(b.favoritedAt).getTime() - new Date(a.favoritedAt).getTime());
    }
  }, [favorites, sortBy, lang]);

  // Date Picker Dialog (preserved flow)
  const dateDialog = (
    <Dialog open={dateDialogOpen} onOpenChange={(open) => { setDateDialogOpen(open); if (!open) { setPendingAgencyId(null); setSelectedDate(undefined); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-emerald-600" />
            {t('reserveForDate')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('selectDate')}</DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <p className="text-sm text-muted-foreground mb-4">{t('selectDate')}</p>
          <div className="flex justify-center">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              className="rounded-xl border"
            />
          </div>
          <div className="flex gap-2 mt-4 justify-center">
            <Button variant="outline" size="sm" className="rounded-xl h-9" onClick={() => setSelectedDate(undefined)}>
              {t('today')}
            </Button>
            <Button variant="outline" size="sm" className="rounded-xl h-9" onClick={() => {
              const tomorrow = new Date();
              tomorrow.setDate(tomorrow.getDate() + 1);
              setSelectedDate(tomorrow);
            }}>
              {t('tomorrow')}
            </Button>
          </div>
          {selectedDate && (
            <div className="mt-3 text-center">
              <p className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
                {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </p>
            </div>
          )}
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => { setDateDialogOpen(false); setPendingAgencyId(null); setSelectedDate(undefined); }} className="rounded-xl h-10">
            {t('cancel')}
          </Button>
          <Button onClick={confirmJoinQueue} disabled={joining} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10">
            {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
            {t('joinQueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (loading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8">
        <div className="max-w-5xl mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-8 w-32 rounded-xl" />
            <Skeleton className="h-8 w-24 rounded-xl" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="rounded-2xl border border-border p-3 space-y-2">
                <Skeleton className="h-9 w-9 rounded-xl" />
                <Skeleton className="h-4 w-4/5 rounded" />
                <Skeleton className="h-3 w-3/5 rounded" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-8 w-full rounded-xl" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* Compact header + sort */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
              <Heart className="h-4 w-4 text-white fill-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-foreground leading-tight">{t('favorites')}</h1>
              {favorites.length > 0 && (
                <p className="text-xs text-muted-foreground">{favorites.length}</p>
              )}
            </div>
          </div>
          {favorites.length > 1 && (
            <div className="flex items-center gap-1.5 shrink-0">
              <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                aria-label={t('sortByName')}
                className="h-9 px-2.5 text-xs rounded-xl border border-border bg-white dark:bg-gray-900/80 text-foreground focus:ring-emerald-500/20 outline-none cursor-pointer"
              >
                <option value="recent">{t('recentlyAdded')}</option>
                <option value="name">{t('sortByName')}</option>
                <option value="rating">{t('sortByRating')}</option>
              </select>
            </div>
          )}
        </motion.div>

        {fetchError ? (
          <ErrorState onRetry={fetchFavorites} />
        ) : favorites.length === 0 ? (
          <EmptyState
            iconComponent={Heart}
            title={t('emptyNoFavoritesTitle') || t('noFavoritesYet')}
            description={t('emptyNoFavoritesDesc') || t('noFavoritesDesc')}
            actionLabel={t('emptyNoFavoritesAction') || t('browseAgencies')}
            onAction={() => setView('customer-home')}
            actionIcon={<Search className="h-4 w-4" />}
          />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <AnimatePresence>
              {sortedFavorites.map((fav, idx) => {
                const open = isOpenNow(fav.workingHoursStart, fav.workingHoursEnd);
                const isBreaking = heartBreakingId === fav.agencyId;
                return (
                  <motion.div
                    key={fav.agencyId}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.25, delay: Math.min(idx * 0.03, 0.15) }}
                    className="min-w-0"
                  >
                    <div className="relative h-full rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-3 flex flex-col gap-2">
                      {/* Remove heart (top-end corner) */}
                      <button
                        onClick={() => toggleFavorite(fav.agencyId)}
                        disabled={unfavoriting === fav.agencyId}
                        aria-label={t('unfavoriteAgency')}
                        className={`absolute top-2 end-2 h-9 w-9 rounded-full flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors ${isBreaking ? 'heart-break-animation' : ''}`}
                      >
                        {unfavoriting === fav.agencyId ? (
                          <Loader2 className="h-4 w-4 text-red-500 animate-spin" />
                        ) : (
                          <Heart className="h-4 w-4 text-red-500 fill-red-500" />
                        )}
                      </button>

                      {/* Identity */}
                      <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
                        <TicketCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div className="min-w-0 pe-8">
                        <div className="flex items-center gap-1">
                          <h3 className="font-semibold text-sm text-foreground truncate" title={getAgencyName(fav)}>
                            {getAgencyName(fav)}
                          </h3>
                          {fav.isSponsored && (
                            <Star className="h-3 w-3 text-amber-500 fill-amber-500 shrink-0" />
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate flex items-center gap-0.5" title={fav.address}>
                          <MapPin className="h-3 w-3 shrink-0" />
                          {fav.address}
                        </p>
                      </div>

                      {/* Status badge + hours */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 ${
                            open
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                              : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800'
                          }`}
                        >
                          {fav.isQueueOpen && open ? (
                            <span className="flex items-center gap-1">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 status-dot-blink" />
                              {t('openNow')}
                            </span>
                          ) : t('closed')}
                        </Badge>
                        {fav.workingHoursStart && fav.workingHoursEnd && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5" dir="ltr">
                            <Clock className="h-2.5 w-2.5" />
                            {fav.workingHoursStart}-{fav.workingHoursEnd}
                          </span>
                        )}
                      </div>

                      {/* Services count */}
                      {fav.services.length > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          {fav.services.length} {t('servicesCount')}
                        </p>
                      )}

                      {/* Join action pinned to bottom + Task 81-b profile entry */}
                      <div className="mt-auto pt-1 flex items-center gap-1.5">
                        <button
                          onClick={() => { useAppStore.getState().setAgencyProfileId(fav.agencyId); setView('customer-agency-profile'); }}
                          aria-label={t('viewProfile')}
                          className="h-9 w-9 rounded-xl border border-border flex items-center justify-center hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors shrink-0"
                        >
                          <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        </button>
                        <Button
                          size="sm"
                          className="flex-1 h-9 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs"
                          onClick={() => handleJoinQueue(fav.agencyId)}
                          disabled={!fav.isQueueOpen}
                        >
                          {t('joinFromFavorites')}
                          <ChevronRight className="h-3.5 w-3.5 ms-1 rtl:rotate-180" />
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}

        {dateDialog}
      </div>
    </div>
  );
}
