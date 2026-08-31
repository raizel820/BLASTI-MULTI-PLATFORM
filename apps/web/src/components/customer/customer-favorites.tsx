'use client';
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/favorites?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        setFavorites(data.favorites ?? []);
      } else {
        setFetchError(true);
        toast.error(t('error'));
      }
    } catch {
      setFetchError(true);
      toast.error(t('error'));
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
          body.reservedDate = selectedDate.toISOString().split('T')[0];
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

  // Date Picker Dialog
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
            <Button variant="outline" size="sm" className="rounded-lg h-9" onClick={() => setSelectedDate(undefined)}>
              {t('today')}
            </Button>
            <Button variant="outline" size="sm" className="rounded-lg h-9" onClick={() => {
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
                📅 {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
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
      <div className="px-4 py-4 pb-24 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-2xl overflow-hidden border border-border/50">
            <div className="p-4 space-y-3">
              <div className="flex items-start gap-3">
                <Skeleton className="h-11 w-11 rounded-xl shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/5 rounded" />
                  <Skeleton className="h-3 w-4/5 rounded" />
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-20 rounded-full" />
                  </div>
                </div>
                <Skeleton className="h-9 w-9 rounded-full shrink-0" />
              </div>
              <div className="flex justify-end">
                <Skeleton className="h-8 w-28 rounded-lg" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="px-4 py-4 pb-24">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">{t('favorites')}</h1>
        {favorites.length > 1 && (
          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="h-8 px-2.5 py-0 text-[11px] rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-900/20 text-foreground focus:ring-emerald-500/20 outline-none cursor-pointer"
            >
              <option value="recent">{t('recentlyAdded') || 'Recent'}</option>
              <option value="name">{t('sortByName') || 'Name'}</option>
              <option value="rating">{t('sortByRating') || 'Rating'}</option>
            </select>
          </div>
        )}
      </div>

      {fetchError ? (
        <ErrorState onRetry={fetchFavorites} />
      ) : favorites.length === 0 ? (
        <EmptyState
          icon={<span className="text-3xl">💜</span>}
          title={t('emptyNoFavoritesTitle') || t('noFavoritesYet')}
          description={t('emptyNoFavoritesDesc') || t('noFavoritesDesc')}
          actionLabel={t('emptyNoFavoritesAction') || t('browseAgencies') || 'Browse Agencies'}
          onAction={() => setView('customer-home')}
          actionIcon={<Search className="h-4 w-4" />}
        />
      ) : (
        <div className="space-y-3">
          <AnimatePresence>
            {sortedFavorites.map((fav, idx) => {
              const open = isOpenNow(fav.workingHoursStart, fav.workingHoursEnd);
              const isBreaking = heartBreakingId === fav.agencyId;
              return (
                <motion.div
                  key={fav.agencyId}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -200, scale: 0.8 }}
                  transition={{ duration: 0.4, delay: idx * 0.05 }}
                  className="group"
                >
                  <Card className="border-0 shadow-sm hover:shadow-md transition-all duration-200 card-hover-scale relative overflow-hidden">
                    {/* Subtle gradient top border */}
                    <div className="absolute top-0 start-0 end-0 h-[2px] bg-gradient-to-r from-transparent via-emerald-400 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="h-11 w-11 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0 group-hover:bg-emerald-200 dark:group-hover:bg-emerald-800/50 transition-colors duration-300">
                          <TicketCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-sm text-foreground truncate">
                              {getAgencyName(fav)}
                            </h3>
                            {fav.isSponsored && (
                              <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 text-[9px] px-1.5">
                                <Star className="h-2 w-2 me-0.5" />
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                            <MapPin className="h-3 w-3 flex-shrink-0" />
                            {fav.address}
                          </p>
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={
                                open
                                  ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                                  : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                              }
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
                                {fav.workingHoursStart} - {fav.workingHoursEnd}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-center gap-1">
                          <button
                            onClick={() => toggleFavorite(fav.agencyId)}
                            disabled={unfavoriting === fav.agencyId}
                            className={`min-h-[44px] min-w-[44px] h-11 w-11 rounded-full flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors ${isBreaking ? 'heart-break-animation' : ''}`}
                          >
                            {unfavoriting === fav.agencyId ? (
                              <Loader2 className="h-4 w-4 text-red-500 animate-spin" />
                            ) : (
                              <motion.div
                                whileHover={{ scale: 1.2 }}
                                whileTap={{ scale: 0.8 }}
                              >
                                <Heart className="h-[18px] w-[18px] text-red-500 fill-red-500" />
                              </motion.div>
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="mt-3 flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          className="h-8 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs shadow-sm hover:shadow-md transition-all duration-200"
                          onClick={() => handleJoinQueue(fav.agencyId)}
                          disabled={!fav.isQueueOpen}
                        >
                          {t('joinFromFavorites')}
                          <ChevronRight className="h-3.5 w-3.5 ms-1" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {dateDialog}
    </div>
  );
}
