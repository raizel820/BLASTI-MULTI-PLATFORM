'use client';

/**
 * Task 79-a — CustomerHome v2 ("find agency → get reservation" daily flow).
 *
 * Complete visual/structural rebuild per the Task 79 DESIGN SYSTEM v2 spec.
 * 100% of the pre-rebuild behavior is preserved (endpoints, store flows,
 * dialogs, offline handling); only the presentation changed:
 *
 *   1. One-line header strip: greeting + avatar/initials → profile.
 *   2. ACTIVE TICKET STRIP — ONE compact card (was two giant stacked cards).
 *   3. Search bar + inline QR scan + compact agency-code / walk-in row.
 *   4. Category chips (CategoryFilters — built-ins + custom categories).
 *   5. Quick actions: Scan QR · Favorites · History · Notifications.
 *   6. Compact agency grid (2 cols mobile / 3 md / 4 lg).
 *   7. Below the fold: Recently visited + Recent activity feed.
 *
 * Endpoints (unchanged): GET /api/agencies, GET /api/agencies/code/{code},
 * GET /api/favorites?userId, POST /api/favorites, POST /api/reservations,
 * GET /api/reservations/active?userId (with offline backoff),
 * GET /api/reviews?agencyId (reviews preview).
 */

import { apiFetch } from '@/lib/api-fetch';
import { toLocalDateString } from '@/lib/date-utils';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';
// Task 84 — IndexedDB stale-while-revalidate: the home screen paints instantly
// from the last-known payload (even fully offline) and refreshes silently.
import { cacheGet, cacheSet, cacheKeyFor } from '@/lib/local-cache';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { getProxiedUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/shared/error-state';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import { RecentActivityFeed } from '@/components/customer/home/RecentActivityFeed';
import { RecentlyVisited } from '@/components/customer/home/RecentlyVisited';
import {
  Search,
  MapPin,
  QrCode,
  Star,
  ChevronRight,
  Users,
  Loader2,
  TicketCheck,
  Clock,
  Heart,
  CalendarDays,
  ArrowLeft,
  X,
  ScanLine,
  History,
  Bell,
  Building2,
  Zap,
  RefreshCw,
  Navigation,
  MessageCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import type { TranslationKeys } from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Calendar } from '@/components/ui/calendar';
import { CustomerQrScanner } from '@/components/customer/customer-qr-scanner';
import { getAgencyName, getCategoryLabel, type AgencyListItem, type AgencyDetail } from './home/types';
import { CategoryFilters } from './home/CategoryFilters';
import { AgencyCardWide } from './home/AgencyCardWide';
import { BranchCard, type BranchListItem } from './home/BranchCard';
import { CardSwiper } from './home/CardSwiper';
import { useCustomerLocation } from '@/hooks/use-customer-location';
import { useDebounce } from '@/hooks/use-debounce';
import { haversineDistanceKm } from '@/lib/geo';
import { ActiveTicketStrip, type ActiveTicket } from './home/ActiveTicketStrip';

/**
 * Task 84 — shape a raw /api/reservations/active row into an ActiveTicket.
 * Shared by the network refresh AND the cached instant paint (same mapping,
 * so the cached strip looks identical to the live one).
 */
function mapActiveReservations(rows: Array<Record<string, unknown>>): ActiveTicket[] {
  return rows.map((r) => {
    const agency = r.agency as { name?: string; id?: string; nameAr?: string; nameFr?: string } | undefined;
    const service = r.service as { name?: string; nameAr?: string; nameFr?: string } | undefined;
    const eta = r.eta as { estimatedMaxMinutes?: number } | undefined;
    return {
      agencyId: agency?.id || (r.agencyId as string) || '',
      agencyName: agency?.name || '',
      agencyNameAr: agency?.nameAr,
      agencyNameFr: agency?.nameFr,
      serviceName: service?.name,
      serviceNameAr: service?.nameAr,
      serviceNameFr: service?.nameFr,
      queueNumber:
        (r.displayNumber as string) || (r.queueNumber != null ? `${r.queueNumber}` : undefined),
      currentServingNumber: r.currentServingNumber != null ? String(r.currentServingNumber) : undefined,
      estimatedWait: (r.estimatedWait as number | undefined) ?? eta?.estimatedMaxMinutes ?? undefined,
      position: (r.position as number) || (r.queueNumber as number) || 0,
      status: r.status as string | undefined,
    };
  });
}

export function CustomerHome() {
  const setView = useAppStore((s) => s.setView);
  const user = useAppStore((s) => s.user);
  const pendingAgencyCode = useAppStore((s) => s.pendingAgencyCode);
  const setPendingAgencyCode = useAppStore((s) => s.setPendingAgencyCode);
  const { t, lang } = useLanguage();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [agencies, setAgencies] = useState<AgencyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [agencyCode, setAgencyCode] = useState('');
  const [selectedAgency, setSelectedAgency] = useState<AgencyDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [togglingFav, setTogglingFav] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchSectionRef = useRef<HTMLDivElement>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Task 83-c-1 — branch-level search results (GET /api/agencies/branches,
  // Task 83-a). Fetched ONLY while a search query is active; a failed branch
  // fetch degrades SILENTLY (never breaks the agency results — see the
  // failure policy on the effect below).
  const [branchResults, setBranchResults] = useState<BranchListItem[]>([]);
  const [branchTotal, setBranchTotal] = useState(0);
  const [branchesLoading, setBranchesLoading] = useState(false);

  // Task 82 — estimated distance per agency card. Only computed when the
  // device's location permission is ALREADY granted (never prompts); the
  // position is cached module-level (5 min TTL) inside the hook.
  const { position: customerPosition } = useCustomerLocation(true);

  // Task 83-c-1 — debounced search query driving the branch search endpoint.
  // The agency list is preloaded and filtered client-side (unchanged default
  // browse experience); only the branch fetch is network-driven, sharing the
  // same debounce window as the search input.
  const debouncedSearchQuery = useDebounce(searchQuery, 350);
  const activeSearch = debouncedSearchQuery.trim();
  const searchActive = activeSearch.length > 0;

  // Date picker state (join flow)
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [pendingJoin, setPendingJoin] = useState<{ agencyId: string; serviceId?: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [preferredTime, setPreferredTime] = useState('');
  const [fixedTimeEnabled, setFixedTimeEnabled] = useState(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [activeReservations, setActiveReservations] = useState<ActiveTicket[]>([]);
  // Task 84 — the cached instant paint of the active-ticket strip runs once
  // per mount (the polling loop owns the screen afterwards).
  const activeCachePainted = useRef(false);

  useEffect(() => {
    fetchAgencies();
    // Load recent searches from localStorage
    try {
      const stored = localStorage.getItem('blasti-recent-searches');
      if (stored) setRecentSearches(JSON.parse(stored));
    } catch { /* silent */ }
  }, []);

  // Handle pending agency code from QR deep link
  useEffect(() => {
    if (pendingAgencyCode) {
      fetchAgencyDetail(pendingAgencyCode);
      setPendingAgencyCode(null);
    }
  }, [pendingAgencyCode, setPendingAgencyCode]);

  const fetchFavorites = useCallback(async () => {
    if (!user?.id) return;
    const favKey = cacheKeyFor('/api/favorites', { userId: user.id });
    // Instant paint from cache — favorite hearts are correct before the network answers.
    const cachedFav = await cacheGet<{ favorites?: Array<{ agencyId: string }> }>(favKey);
    if (cachedFav?.data?.favorites) {
      setFavoriteIds(new Set(cachedFav.data.favorites.map((f) => f.agencyId)));
    }
    try {
      const res = await apiFetch(`/api/favorites?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        void cacheSet(favKey, data);
        setFavoriteIds(new Set((data.favorites ?? []).map((f: { agencyId: string }) => f.agencyId)));
      } else if (!cachedFav) {
        toast.error(t('error'));
      }
    } catch {
      if (!cachedFav) toast.error(t('error'));
    }
  }, [user?.id, t]);

  useEffect(() => {
    fetchFavorites();
  }, [fetchFavorites]);

  const fetchAgencies = async () => {
    setLoading(true);
    setFetchError(false);
    // Task 84 — instant cache paint: render the last-known agency list right
    // away, then revalidate. A dead/slow API no longer blank the home screen
    // (the old "30s skeleton, sometimes never" bug).
    const agencyKey = cacheKeyFor('/api/agencies');
    const cachedAgencies = await cacheGet<{ agencies?: typeof agencies }>(agencyKey);
    if (cachedAgencies?.data?.agencies?.length) {
      setAgencies(cachedAgencies.data.agencies);
      setLoading(false);
    }
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry('/api/agencies');
      if (res.ok) {
        const data = await res.json();
        void cacheSet(agencyKey, data);
        setAgencies(data.agencies ?? []);
      } else if (!cachedAgencies?.data?.agencies?.length) {
        setFetchError(true);
        toast.error(t('error'));
      }
    } catch {
      if (!cachedAgencies?.data?.agencies?.length) {
        setFetchError(true);
        toast.error(t('error'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Task 83-c-1 / field-fix — branch-level search. Runs in parallel with the
  // (unchanged, client-side filtered) agency flow: independent effect,
  // independent state. Rate-limited endpoint → debounced query + fetch on
  // change.
  //
  // FAILURE POLICY (the "search shows an error" field report): branch search
  // is a SECONDARY enhancement — the primary agency results are client-side
  // and never fail. A branch fetch that fails for ANY reason (429 from a
  // shared-IP rate bucket, 404 on a not-yet-upgraded backend, network error)
  // degrades SILENTLY to "no branch section" — no error chip, no toast. A
  // 429 additionally schedules ONE quiet retry after Retry-After so a momentary
  // throttle never eats the results the user is actively waiting for.
  useEffect(() => {
    const query = activeSearch;
    if (!query) {
      setBranchResults([]);
      setBranchTotal(0);
      setBranchesLoading(false);
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const applyResults = (data: { branches?: unknown; total?: unknown }) => {
      const list: BranchListItem[] = Array.isArray(data.branches) ? (data.branches as BranchListItem[]) : [];
      setBranchResults(list);
      setBranchTotal(typeof data.total === 'number' ? data.total : list.length);
    };

    const fetchBranches = async () => {
      setBranchesLoading(true);
      try {
        const params = new URLSearchParams({ search: query, limit: '20', offset: '0' });
        if (selectedCategory !== 'ALL') params.set('category', selectedCategory);
        const res = await apiFetch(`/api/agencies/branches?${params.toString()}`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          applyResults(data);
          return;
        }
        // Not ok → silent degrade (detail stays in the console for diagnosis).
        console.warn('[CustomerHome] branch search unavailable:', res.status);
        if (res.status === 429) {
          // One quiet retry after Retry-After (bounded to 10s) — only if the
          // user is still on the same query (cancelled/changed queries skip).
          const retryAfterHeader = typeof res.headers?.get === 'function' ? res.headers.get('Retry-After') : null;
          const delayMs = Math.min(Math.max((parseInt(retryAfterHeader ?? '', 10) || 2) * 1000, 2000), 10_000);
          retryTimer = setTimeout(() => {
            if (cancelled) return;
            void fetchBranches();
          }, delayMs);
          return; // keep the previous results visible during the backoff
        }
        setBranchResults([]);
        setBranchTotal(0);
      } catch {
        if (!cancelled) {
          setBranchResults([]);
          setBranchTotal(0);
        }
      } finally {
        if (!cancelled) setBranchesLoading(false);
      }
    };

    void fetchBranches();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeSearch, selectedCategory]);

  const filteredAgencies = useMemo(() => {
    return agencies.filter((a) => {
      const matchCategory = selectedCategory === 'ALL' || a.category.toUpperCase() === selectedCategory;
      const query = searchQuery.toLowerCase().trim();
      const matchSearch =
        !query ||
        a.name.toLowerCase().includes(query) ||
        a.nameAr?.includes(query) ||
        a.nameFr?.toLowerCase().includes(query) ||
        a.address.toLowerCase().includes(query) ||
        a.customCode.toLowerCase().includes(query);
      return matchCategory && matchSearch;
    });
  }, [agencies, selectedCategory, searchQuery]);

  // Autocomplete suggestions
  const searchSuggestions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return [];
    const seen = new Set<string>();
    return agencies
      .filter((a) => {
        const name = getAgencyName(a, lang).toLowerCase();
        if (seen.has(name)) return false;
        if (name.includes(query) || a.name.toLowerCase().includes(query) || a.nameFr?.toLowerCase().includes(query) || a.nameAr?.includes(query)) {
          seen.add(name);
          return true;
        }
        return false;
      })
      .slice(0, 5);
  }, [searchQuery, agencies, lang]);

  const addRecentSearch = (term: string) => {
    if (!term.trim()) return;
    const updated = [term, ...recentSearches.filter((s) => s.toLowerCase() !== term.toLowerCase())].slice(0, 5);
    setRecentSearches(updated);
    try { localStorage.setItem('blasti-recent-searches', JSON.stringify(updated)); } catch { /* silent */ }
  };

  const removeRecentSearch = (term: string) => {
    const updated = recentSearches.filter((s) => s !== term);
    setRecentSearches(updated);
    try { localStorage.setItem('blasti-recent-searches', JSON.stringify(updated)); } catch { /* silent */ }
  };

  const clearAllRecentSearches = () => {
    setRecentSearches([]);
    try { localStorage.removeItem('blasti-recent-searches'); } catch { /* silent */ }
  };

  const handleSearchSelect = (term: string) => {
    setSearchQuery(term);
    addRecentSearch(term);
    setShowSuggestions(false);
    setSearchFocused(false);
    searchInputRef.current?.blur();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      addRecentSearch(searchQuery.trim());
      setShowSuggestions(false);
      setSearchFocused(false);
    }
  };

  const handleSearchBlur = () => {
    // Delay to allow click on suggestion
    setTimeout(() => {
      setSearchFocused(false);
      setShowSuggestions(false);
    }, 200);
  };

  const fetchAgencyDetail = async (code: string) => {
    setLoadingDetail(true);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const res = await fetchWithRetry(`/api/agencies/code/${encodeURIComponent(code)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.agency) {
          setSelectedAgency(data.agency as AgencyDetail);
        } else {
          toast.error(data.error || t('noData'));
        }
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleJoinByCode = async () => {
    if (!agencyCode.trim()) return;
    const code = agencyCode.trim();
    setAgencyCode('');
    // Directly fetch agency detail from API (works even if agency not in loaded list)
    await fetchAgencyDetail(code);
  };

  const handleSelectAgency = async (agency: AgencyListItem) => {
    await fetchAgencyDetail(agency.customCode);
  };

  // Task 83-c-1 — branch profile navigation (store plumbing from Task 83-a,
  // consumed — not modified). Mirrors the AgencyCard.onViewProfile pattern.
  const handleSelectBranch = (branch: BranchListItem) => {
    useAppStore.getState().setBranchProfileId(branch.id);
    setView('customer-branch-profile');
  };

  // Quick join: go straight to date picker without showing agency detail
  const handleQuickJoin = (agencyId: string, serviceId?: string) => {
    if (!user?.id) {
      toast.error(t('error'));
      return;
    }
    setPendingJoin({ agencyId, serviceId });
    setSelectedDate(undefined);
    setDateDialogOpen(true);
  };

  const handleJoinQueue = (agencyId: string, serviceId?: string) => {
    // Auth guard — must be logged in as a customer
    if (!user?.id) {
      toast.error(t('error'));
      return;
    }
    // Open date picker dialog instead of joining directly
    setPendingJoin({ agencyId, serviceId });
    setSelectedDate(undefined); // Reset to default (today)
    setDateDialogOpen(true);
  };

  const confirmJoinQueue = async () => {
    if (!user?.id) {
      toast.error(t('error'));
      setDateDialogOpen(false);
      setPendingJoin(null);
      return;
    }
    if (!pendingJoin) return;
    setJoining(true);
    try {
      const body: Record<string, string | boolean> = { userId: user.id, agencyId: pendingJoin.agencyId };
      if (pendingJoin.serviceId) body.serviceId = pendingJoin.serviceId;
      // Add reserved date if selected (not today)
      if (selectedDate) {
        const today = new Date();
        const isToday = selectedDate.getFullYear() === today.getFullYear()
          && selectedDate.getMonth() === today.getMonth()
          && selectedDate.getDate() === today.getDate();
        if (!isToday) {
          body.reservedDate = toLocalDateString(selectedDate);
        }
      }
      // Add preferred time if set
      if (preferredTime) {
        body.preferredTime = preferredTime;
        body.fixedTimeEnabled = fixedTimeEnabled;
      }

      const res = await apiFetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (res.ok) {
        toast.success(t('joinSuccess'));
        setSelectedAgency(null);
        setDateDialogOpen(false);
        setPendingJoin(null);
        setSelectedDate(undefined);
        setPreferredTime('');
        setFixedTimeEnabled(false);
        setView('customer-queue');
      } else {
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setJoining(false);
    }
  };

  const toggleFavorite = async (e: React.MouseEvent, agencyId: string) => {
    e.stopPropagation();
    if (!user?.id) return;
    setTogglingFav(agencyId);
    try {
      const res = await apiFetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, agencyId }),
      });
      if (res.ok) {
        const data = await res.json();
        setFavoriteIds((prev) => {
          const next = new Set(prev);
          if (data.favorited) next.add(agencyId);
          else next.delete(agencyId);
          return next;
        });
        toast.success(data.favorited ? t('favoriteAgency') : t('unfavoriteAgency'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingFav(null);
    }
  };

  const isOpenNow = (start: string, end: string) => {
    if (!start || !end) return null;
    const now = new Date();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    // Handle overnight hours (e.g. 22:00 - 06:00)
    if (startMin > endMin) {
      return cur >= startMin || cur < endMin;
    }
    return cur >= startMin && cur < endMin;
  };

  // Greeting helpers
  const firstName = user?.fullName?.split(' ')[0] || '';
  const getTimeGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return t('goodMorning');
    if (hour >= 12 && hour < 17) return t('goodAfternoon');
    if (hour >= 17 && hour < 21) return t('goodEvening');
    return t('goodNight');
  };

  // FIX #19 preserved: fetch active reservations with offline backoff.
  // (Extended extraction: service name / display number / serving / ETA /
  // status are now read too, so the compact strip can render them — same
  // endpoint, same cadence.)
  useEffect(() => {
    if (!user?.id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const NORMAL = 30_000;

    const fetchActiveReservations = async () => {
      try {
        const activeKey = cacheKeyFor('/api/reservations/active', { userId: user.id });
        // First tick only: paint the last-known active ticket instantly so the
        // strip is visible offline / on a dead API (the polling loop keeps it fresh).
        if (!activeCachePainted.current) {
          activeCachePainted.current = true;
          const cachedActive = await cacheGet<{ reservations?: Array<Record<string, unknown>> }>(activeKey);
          if (cachedActive?.data?.reservations?.length && !stopped) {
            setActiveReservations(mapActiveReservations(cachedActive.data.reservations));
          }
        }
        const res = await apiFetch(`/api/reservations/active?userId=${user.id}`);
        if (res.ok) {
          const data = await res.json();
          void cacheSet(activeKey, data);
          const reservations = data.reservations ?? [];
          setActiveReservations(mapActiveReservations(reservations));
          failures = 0;
        }
      } catch { /* silent */ }
    };

    const getInterval = () => {
      if (failures >= 3) return 120_000;
      if (failures >= 1) return 60_000;
      return NORMAL;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }
      await fetchActiveReservations();
      if (isApiUnreachable()) failures = Math.min(failures + 1, 10);
      else failures = 0;
      timer = setTimeout(tick, getInterval());
    };

    fetchActiveReservations();
    timer = setTimeout(tick, NORMAL);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [user?.id]);

  // Compute quick stats
  const openAgencyCount = useMemo(() => agencies.filter(a => a.isQueueOpen && !a.isPaused).length, [agencies]);

  // Task 82 — agencyId → straight-line km from the customer's position.
  const distanceByAgencyId = useMemo(() => {
    if (!customerPosition) return null as Record<string, number> | null;
    const map: Record<string, number> = {};
    agencies.forEach((a) => {
      if (typeof a.latitude === 'number' && typeof a.longitude === 'number') {
        map[a.id] = haversineDistanceKm(customerPosition, { lat: a.latitude, lng: a.longitude });
      }
    });
    return map;
  }, [customerPosition, agencies]);

  // Task 83-c-1 — branchId → straight-line km (same pattern as agencies).
  const distanceByBranchId = useMemo(() => {
    if (!customerPosition) return null as Record<string, number> | null;
    const map: Record<string, number> = {};
    branchResults.forEach((b) => {
      if (typeof b.latitude === 'number' && typeof b.longitude === 'number') {
        map[b.id] = haversineDistanceKm(customerPosition, { lat: b.latitude, lng: b.longitude });
      }
    });
    return map;
  }, [customerPosition, branchResults]);

  // Compute category counts for filter badges
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    agencies.forEach(a => {
      const cat = a.category.toUpperCase();
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [agencies]);

  const dateDialogContent = (
    <Dialog open={dateDialogOpen} onOpenChange={(open) => { setDateDialogOpen(open); if (!open) { setPendingJoin(null); setSelectedDate(undefined); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-emerald-600" />
            {t('reserveForDate')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('selectDate')}
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <p className="text-sm text-muted-foreground mb-4">{t('selectDate')}</p>
          <div className="flex justify-center">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={setSelectedDate}
              disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
              className="rounded-xl border w-full max-w-[300px] sm:max-w-none"
            />
          </div>
          {/* Quick date buttons */}
          <div className="flex gap-2 mt-4 justify-center">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9"
              onClick={() => setSelectedDate(undefined)}
            >
              {t('today')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-9"
              onClick={() => {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                setSelectedDate(tomorrow);
              }}
            >
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

          {/* Preferred Time Section */}
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-medium text-foreground">{t('preferredTime')}</p>
                <p className="text-xs text-muted-foreground">{t('preferredTimeDesc')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="time"
                value={preferredTime}
                onChange={(e) => {
                  setPreferredTime(e.target.value);
                  if (e.target.value && !fixedTimeEnabled) setFixedTimeEnabled(true);
                }}
                className="h-10 px-3 rounded-xl border border-border bg-background text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-colors"
                dir="ltr"
              />
              {preferredTime && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={fixedTimeEnabled}
                    onChange={(e) => setFixedTimeEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-xs text-muted-foreground">{t('enableFixedTime')}</span>
                </label>
              )}
              {preferredTime && (
                <button
                  onClick={() => { setPreferredTime(''); setFixedTimeEnabled(false); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => { setDateDialogOpen(false); setPendingJoin(null); setSelectedDate(undefined); }} className="rounded-xl h-10">
            {t('cancel')}
          </Button>
          <Button
            onClick={confirmJoinQueue}
            disabled={joining}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10"
          >
            {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
            {t('joinQueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Agency Detail View — compact restyle of the same in-component page
  if (loadingDetail) {
    return (
      <>
        <div className="px-4 py-4 pb-24 flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
        </div>
        {dateDialogContent}
      </>
    );
  }

  if (selectedAgency) {
    const totalWaiting = selectedAgency.services.reduce((sum, s) => sum + (s.waitingCount || 0), 0);
    const estWait = totalWaiting * (selectedAgency.avgServiceTime || 10);
    const estWaitMin = Math.max(1, Math.round(estWait * 0.75));
    const estWaitMax = Math.round(estWait * 1.3);
    return (
      <>
        <motion.div
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.25 }}
          className="px-4 py-3 pb-24 lg:pb-8 max-w-5xl mx-auto"
        >
          <button
            onClick={() => setSelectedAgency(null)}
            className="text-sm text-emerald-600 dark:text-emerald-400 font-medium mb-3 flex items-center gap-1 hover:underline"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('back')}
          </button>

          <div className="rounded-2xl bg-white dark:bg-gray-900/80 border border-border shadow-sm overflow-hidden">
            {/* Header image band */}
            <div className="h-20 bg-gradient-to-r from-emerald-600 to-teal-600 relative">
              <div className="absolute inset-0 opacity-[0.07]" style={{
                backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
                backgroundSize: '18px 18px',
              }} />
            </div>
            <div className="p-4 -mt-8">
              <div className="h-14 w-14 rounded-2xl bg-white dark:bg-gray-800 shadow-md flex items-center justify-center mb-2.5 border-4 border-white dark:border-gray-800">
                <TicketCheck className="h-6 w-6 text-emerald-600" />
              </div>
              <h2 className="text-lg font-bold text-foreground mb-0.5">
                {getAgencyName(selectedAgency, lang)}
              </h2>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2.5">
                <MapPin className="h-3.5 w-3.5" />
                <span className="truncate">{selectedAgency.address}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                <Badge variant="outline" className="text-[10px]">
                  {getCategoryLabel(selectedAgency.category, t)}
                </Badge>
                {selectedAgency.subscriptionStatus !== 'ACTIVE' && (
                  <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                    {t('inactiveAgency')}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className={
                    selectedAgency.isQueueOpen && !selectedAgency.isPaused
                      ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                      : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                  }
                >
                  {selectedAgency.isPaused ? t('paused') : selectedAgency.isQueueOpen ? t('openNow') : t('closed')}
                </Badge>
                {selectedAgency.workingHoursStart && selectedAgency.workingHoursEnd && (() => {
                  const open = isOpenNow(selectedAgency.workingHoursStart, selectedAgency.workingHoursEnd);
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
                        ? `${t('openUntil')} ${selectedAgency.workingHoursEnd}`
                        : selectedAgency.isPaused
                          ? t('paused')
                          : `${t('closedNow')} · ${t('openFrom')} ${selectedAgency.workingHoursStart}`
                      }
                    </Badge>
                  );
                })()}
              </div>

              {/* 2-stat queue info row */}
              <div className="grid grid-cols-2 gap-2.5 mb-3">
                <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-2.5 text-center">
                  <div className="flex items-center justify-center gap-1 mb-0.5">
                    <Users className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="text-[10px] text-muted-foreground">{t('currentlyWaiting')}</span>
                  </div>
                  <p className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
                    {totalWaiting}
                  </p>
                </div>
                <div className="bg-teal-50 dark:bg-teal-900/20 rounded-xl p-2.5 text-center">
                  <div className="flex items-center justify-center gap-1 mb-0.5">
                    <Clock className="h-3.5 w-3.5 text-teal-600" />
                    <span className="text-[10px] text-muted-foreground">{t('avgWaitTime')}</span>
                  </div>
                  <p className="text-xl font-bold text-teal-700 dark:text-teal-400">
                    {estWaitMin < estWaitMax ? `${estWaitMin}–${estWaitMax}` : `~${estWait}`} {t('min')}
                  </p>
                </div>
              </div>

              {/* Queue Unavailable Message for Inactive Subscriptions */}
              {selectedAgency.subscriptionStatus !== 'ACTIVE' && (
                <div className="mb-3 p-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                  <p className="text-xs text-amber-700 dark:text-amber-300 font-medium">{t('queueUnavailable')}</p>
                </div>
              )}

              {/* Services — same join flow (date dialog) */}
              {selectedAgency.services.length > 0 && (
                <div className="mb-3">
                  <h3 className="text-sm font-semibold text-foreground mb-2">{t('selectService')}</h3>
                  <div className="space-y-1.5">
                    {selectedAgency.services.map((svc) => (
                      <motion.button
                        key={svc.id}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => handleJoinQueue(selectedAgency.id, svc.id)}
                        disabled={selectedAgency.isPaused || !selectedAgency.isQueueOpen || selectedAgency.subscriptionStatus !== 'ACTIVE'}
                        className="w-full flex items-center justify-between p-2.5 rounded-xl border border-border hover:border-emerald-300 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors disabled:opacity-50"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[13px] font-medium truncate">
                            {lang === 'ar' && svc.nameAr ? svc.nameAr : lang === 'fr' && svc.nameFr ? svc.nameFr : svc.name}
                          </span>
                          {svc.waitingCount > 0 && (
                            <Badge variant="secondary" className="text-[9px] flex-shrink-0">
                              {svc.waitingCount} {t('waiting')}
                            </Badge>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180 flex-shrink-0" />
                      </motion.button>
                    ))}
                  </div>
                </div>
              )}

              {/* Join Queue (no services) */}
              {selectedAgency.services.length === 0 && (
                <Button
                  className="w-full h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl"
                  onClick={() => handleJoinQueue(selectedAgency.id)}
                  disabled={selectedAgency.isPaused || !selectedAgency.isQueueOpen || selectedAgency.subscriptionStatus !== 'ACTIVE'}
                >
                  {selectedAgency.subscriptionStatus !== 'ACTIVE' ? t('queueUnavailable') : selectedAgency.isQueueOpen ? t('joinQueue') : t('closed')}
                </Button>
              )}

              {/* Reviews preview (same endpoint + logic) */}
              <AgencyReviewsPreview agencyId={selectedAgency.id} averageRating={selectedAgency.averageRating} reviewCount={selectedAgency.reviewCount} />
            </div>
          </div>
        </motion.div>
        {dateDialogContent}
      </>
    );
  }

  // ─── Home ──────────────────────────────────────────────────────────────
  const quickActions: { key: string; label: string; icon: React.ElementType; onClick: () => void; active?: boolean }[] = [
    { key: 'scan', label: t('scanQrCode'), icon: ScanLine, onClick: () => setQrScannerOpen(true) },
    { key: 'favorites', label: t('favorites'), icon: Heart, onClick: () => setView('customer-favorites') },
    { key: 'history', label: t('history'), icon: History, onClick: () => setView('customer-history') },
    { key: 'notifications', label: t('notifications'), icon: Bell, onClick: () => setView('customer-notifications') },
  ];

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8 max-w-5xl mx-auto">
      {/* ── 1. Compact header strip (one line, ~44px) ── */}
      <div className="flex items-center gap-2.5 mb-3 min-h-[44px]">
        <button
          onClick={() => setView('customer-profile')}
          className="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center overflow-hidden flex-shrink-0 shadow-sm"
          aria-label={t('profile')}
        >
          {user?.avatarUrl ? (
            <img src={getProxiedUrl(user.avatarUrl)} alt={user.fullName ?? ''} width={40} height={40} className="h-full w-full object-cover" />
          ) : (
            <span className="text-sm font-bold text-white">{firstName.charAt(0).toUpperCase() || 'U'}</span>
          )}
        </button>
        <div className="min-w-0">
          <h1 className="text-base font-bold text-foreground leading-tight truncate">
            {getTimeGreeting()}{firstName ? `, ${firstName}` : ''}
          </h1>
        </div>
        {openAgencyCount > 0 && (
          <Badge variant="outline" className="ms-auto text-[10px] flex-shrink-0 border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400">
            {openAgencyCount} {t('openNow')}
          </Badge>
        )}
      </div>

      {/* ── 2. Active ticket strip (ONE compact card) ── */}
      <div className="mb-3">
        <ActiveTicketStrip
          tickets={activeReservations}
          t={t}
          lang={lang}
          onOpenQueue={() => setView('customer-queue')}
          onFindAgency={() => {
            searchSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            searchInputRef.current?.focus();
          }}
        />
      </div>

      {/* ── 3. Search bar + inline QR + code row ── */}
      <div ref={searchSectionRef} className="relative mb-2">
        <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 h-[18px] w-[18px] text-muted-foreground z-10 pointer-events-none" />
        <Input
          ref={searchInputRef}
          placeholder={t('searchGlassmorphic')}
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => {
            setSearchFocused(true);
            setShowSuggestions(true);
          }}
          onBlur={handleSearchBlur}
          onKeyDown={handleSearchKeyDown}
          className={`ps-11 pe-24 h-11 text-sm rounded-2xl border-border bg-white dark:bg-gray-900/80 shadow-sm transition-all ${
            searchFocused ? 'ring-2 ring-emerald-500/20 border-emerald-300' : ''
          }`}
        />
        <div className="absolute end-2 top-1/2 -translate-y-1/2 flex items-center gap-1 z-10">
          {searchQuery.trim() && !showSuggestions && (
            <span className="text-[10px] text-muted-foreground font-medium">
              {filteredAgencies.length} {t('searchResultsCount')}
            </span>
          )}
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchFocused(false); setShowSuggestions(false); }}
              className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label={t('clearSearch')}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
          <button
            onClick={() => setQrScannerOpen(true)}
            className="h-8 w-8 rounded-xl flex items-center justify-center bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
            aria-label={t('scanQrCode')}
          >
            <ScanLine className="h-4 w-4" />
          </button>
        </div>

        {/* Search Suggestions Dropdown */}
        {(searchFocused || showSuggestions) && (searchSuggestions.length > 0 || (searchQuery === '' && recentSearches.length > 0)) && (
          <div className="absolute top-full mt-1 start-0 end-0 z-[60] bg-white dark:bg-gray-900 border border-border rounded-2xl shadow-lg overflow-hidden">
            {searchQuery === '' && recentSearches.length > 0 ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <div className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground">{t('recentSearches')}</span>
                  </div>
                  <button
                    onClick={clearAllRecentSearches}
                    className="text-[10px] text-teal-600 dark:text-teal-400 hover:underline font-medium"
                  >
                    {t('clearAll')}
                  </button>
                </div>
                {recentSearches.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleSearchSelect(term)}
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-start"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm text-foreground truncate">{term}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeRecentSearch(term); }}
                      className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 flex-shrink-0"
                      aria-label={t('clearSearch')}
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </button>
                ))}
              </>
            ) : searchSuggestions.length > 0 ? (
              <>
                <div className="px-3 py-2 border-b border-border">
                  <span className="text-xs font-semibold text-muted-foreground">{t('suggestions')}</span>
                </div>
                {searchSuggestions.map((agency) => (
                  <button
                    key={agency.id}
                    onClick={() => handleSearchSelect(getAgencyName(agency, lang))}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors text-start"
                  >
                    <div className="h-8 w-8 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                      <TicketCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{getAgencyName(agency, lang)}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{agency.address}</p>
                    </div>
                  </button>
                ))}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Agency code + walk-in (compact row) */}
      <div className="flex flex-wrap gap-2 mb-3">
        <Input
          placeholder={t('enterAgencyCode')}
          value={agencyCode}
          onChange={(e) => setAgencyCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
          className="h-10 flex-1 min-w-[150px] text-sm rounded-xl"
          dir="ltr"
        />
        <Button
          variant="outline"
          className="h-10 px-3.5 rounded-xl border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          onClick={handleJoinByCode}
        >
          <QrCode className="h-4 w-4 me-1.5" />
          {t('joinQueue')}
        </Button>
        <Button
          variant="outline"
          className="h-10 px-3.5 rounded-xl border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
          onClick={() => setQrScannerOpen(true)}
        >
          <Zap className="h-4 w-4 me-1.5" />
          {t('walkInQuickAction')}
        </Button>
      </div>

      {/* ── 4. Category chips ── */}
      <div className="mb-3 -mx-4 px-4">
        <CategoryFilters
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
          categoryCounts={categoryCounts}
          t={t}
        />
      </div>

      {/* ── 5. Quick actions row ── */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        {quickActions.map((action, idx) => {
          const Icon = action.icon;
          return (
            <motion.button
              key={action.key}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + idx * 0.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={action.onClick}
              className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-white dark:bg-gray-900/80 py-3 hover:border-emerald-200 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 dark:hover:border-emerald-800/50 transition-colors"
            >
              <span className="h-8 w-8 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </span>
              <span className="text-[10px] font-medium text-foreground leading-tight text-center px-1 truncate w-full">
                {action.label}
              </span>
            </motion.button>
          );
        })}
      </div>

      {/* ── 5.5 Branch search results (Task 83-c-1) — rendered ONLY while a
          search query is active. Empty results AND failed fetches render
          nothing (silent degrade — the agency results below are primary). ── */}
      {searchActive && (branchesLoading || branchResults.length > 0) && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {t('branchResults')}
            </h2>
            {!branchesLoading && branchTotal > 0 && (
              <span className="text-[10px] text-muted-foreground font-medium">
                {branchTotal} {t('searchResultsCount')}
              </span>
            )}
          </div>
          {branchesLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="rounded-2xl border border-border/40 bg-white dark:bg-gray-900/80 p-3.5 space-y-2.5">
                  <div className="flex items-start justify-between">
                    <div className="h-9 w-9 rounded-xl bg-emerald-100/80 dark:bg-emerald-900/30 animate-pulse" />
                    <div className="h-3 w-10 rounded-full bg-emerald-50 dark:bg-emerald-900/20 animate-pulse" />
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-3.5 w-3/4 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
                    <div className="h-2.5 w-1/2 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
                  </div>
                  <div className="h-4 w-20 rounded-full bg-teal-50 dark:bg-teal-900/20 animate-pulse" />
                </div>
              ))}
            </div>
          ) : (
            <CardSwiper
              ariaLabel={t('branchResults')}
              itemClassName="w-[calc(50%-6px)] md:w-[calc(33.333%-8px)] lg:w-[calc(25%-9px)]"
            >
              {branchResults.map((branch, idx) => (
                <BranchCard
                  key={branch.id}
                  branch={branch}
                  index={idx}
                  lang={lang}
                  t={t}
                  onSelectBranch={handleSelectBranch}
                  distanceKm={distanceByBranchId?.[branch.id] ?? null}
                />
              ))}
            </CardSwiper>
          )}
        </div>
      )}

      {/* ── 6. Agency grid ── */}
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Navigation className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          {t('nearbyAgencies')}
        </h2>
        <button
          onClick={fetchAgencies}
          className="h-8 w-8 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
          aria-label={t('refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="rounded-2xl border border-border/40 bg-white dark:bg-gray-900/80 p-3.5 space-y-2.5">
              <div className="flex items-start justify-between">
                <div className="h-9 w-9 rounded-xl bg-emerald-100/80 dark:bg-emerald-900/30 animate-pulse" />
                <div className="h-3 w-10 rounded-full bg-emerald-50 dark:bg-emerald-900/20 animate-pulse" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3.5 w-3/4 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
                <div className="h-2.5 w-1/2 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
              </div>
              <div className="h-4 w-20 rounded-full bg-teal-50 dark:bg-teal-900/20 animate-pulse" />
            </div>
          ))}
        </div>
      ) : fetchError ? (
        <ErrorState onRetry={fetchAgencies} />
      ) : filteredAgencies.length === 0 ? (
        <EmptyAgenciesState
          searchQuery={searchQuery}
          hasCategoryFilter={selectedCategory !== 'ALL'}
          t={t}
          onClear={() => { setSearchQuery(''); setSelectedCategory('ALL'); }}
          onExplore={() => { setSearchQuery(''); setSelectedCategory('ALL'); searchSectionRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
          onRetry={fetchAgencies}
        />
      ) : (
        /* Full-width detail cards in a swipeable rail (nearby + search results
           share this section — the rail covers both, per the field request). */
        <div className="-mx-4 px-4">
          <CardSwiper
            ariaLabel={t('nearbyAgencies')}
            itemClassName="w-full md:w-[calc(50%-6px)] lg:w-[calc(33.333%-8px)]"
          >
            {filteredAgencies.map((agency, idx) => (
              <AgencyCardWide
                key={agency.id}
                agency={agency}
                index={idx}
                lang={lang}
                isFavorite={favoriteIds.has(agency.id)}
                toggling={togglingFav === agency.id}
                t={t}
                onSelect={handleSelectAgency}
                onToggleFavorite={toggleFavorite}
                onQuickJoin={(agencyId) => handleQuickJoin(agencyId)}
                distanceKm={distanceByAgencyId?.[agency.id] ?? null}
                onViewProfile={(agency) => {
                  useAppStore.getState().setAgencyProfileId(agency.id);
                  setView('customer-agency-profile');
                }}
              />
            ))}
          </CardSwiper>
        </div>
      )}

      {/* ── 7. Below the fold: recently visited + recent activity ── */}
      <div className="mt-6">
        <RecentlyVisited
          t={t}
          lang={lang}
          onSelectAgency={handleSelectAgency}
          agencies={agencies}
          favoriteIds={favoriteIds}
          togglingFav={togglingFav}
          onToggleFavorite={toggleFavorite}
          onQuickJoin={(agencyId) => handleQuickJoin(agencyId)}
          distanceByAgencyId={distanceByAgencyId}
          onViewProfile={(agency) => {
            useAppStore.getState().setAgencyProfileId(agency.id);
            setView('customer-agency-profile');
          }}
          onNavigateHistory={() => setView('customer-history')}
        />

        <RecentActivityFeed
          t={t}
          lang={lang}
          onViewHistory={() => setView('customer-history')}
        />
      </div>

      {/* Date Picker Dialog */}
      {dateDialogContent}

      {/* QR Code Scanner Dialog */}
      <CustomerQrScanner
        open={qrScannerOpen}
        onOpenChange={setQrScannerOpen}
        onAgencyFound={(code) => fetchAgencyDetail(code)}
      />
    </div>
  );
}

// ─── Empty agencies state (search / category / no data variants) ────────────
function EmptyAgenciesState({ searchQuery, hasCategoryFilter, t, onClear, onExplore, onRetry }: {
  searchQuery: string;
  hasCategoryFilter: boolean;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  onClear: () => void;
  onExplore: () => void;
  onRetry: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center justify-center py-10 text-center"
    >
      <div className="relative mb-5">
        <motion.div
          animate={{ scale: [1, 1.15, 1], opacity: [0.15, 0.05, 0.15] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-24 w-24 rounded-full bg-emerald-200 dark:bg-emerald-800"
        />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60">
          {searchQuery.trim() ? (
            <Search className="h-7 w-7 text-emerald-500" />
          ) : (
            <TicketCheck className="h-7 w-7 text-emerald-500" />
          )}
        </div>
      </div>
      {searchQuery.trim() ? (
        <>
          <h3 className="text-base font-bold text-foreground mb-1.5">{t('noSearchResultsTitle')}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-[300px] mb-4">
            {t('noSearchResultsDesc')}
          </p>
          <div className="flex flex-col sm:flex-row gap-2.5">
            <Button
              variant="outline"
              className="gap-2 min-h-[44px] rounded-xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
              onClick={onClear}
            >
              <X className="h-4 w-4" />
              {t('clearSearch')}
            </Button>
            <Button
              className="gap-2 min-h-[44px] px-6 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
              onClick={onExplore}
            >
              <Search className="h-4 w-4" />
              {t('emptyNoAgenciesAction')}
            </Button>
          </div>
        </>
      ) : hasCategoryFilter ? (
        <>
          <h3 className="text-base font-bold text-foreground mb-1.5">{t('emptyNoAgenciesTitle')}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-[300px] mb-4">{t('emptyNoAgenciesDesc')}</p>
          <Button
            variant="outline"
            className="gap-2 min-h-[44px] rounded-xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
            onClick={onClear}
          >
            <X className="h-4 w-4" />
            {t('clearSearch')}
          </Button>
        </>
      ) : (
        <>
          <h3 className="text-base font-bold text-foreground mb-1.5">{t('emptyNoAgenciesTitle')}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-[300px] mb-4">{t('emptyNoAgenciesDesc')}</p>
          <Button
            className="gap-2 min-h-[44px] px-6 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
            onClick={onRetry}
          >
            <RefreshCw className="h-4 w-4" />
            {t('emptyNoAgenciesRetry')}
          </Button>
        </>
      )}
    </motion.div>
  );
}

// ─── Agency Reviews Preview (same endpoint + logic, restyled) ────────────────
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
            <div key={i} className="h-16 bg-muted/50 rounded-xl animate-pulse" />
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
          <h3 className="text-sm font-semibold text-foreground">{t('customerReviews')}</h3>
        </div>
        <div className="text-center py-5">
          <div className="h-10 w-10 rounded-full bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center mx-auto mb-2">
            <Star className="h-5 w-5 text-amber-300 dark:text-amber-700" />
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
          <h3 className="text-sm font-semibold text-foreground">{t('customerReviews')}</h3>
        </div>
        <AgencyRatingDisplay
          averageRating={averageRating ?? 0}
          totalCount={reviewCount ?? reviews.length}
          compact
          size="sm"
        />
      </div>

      <div className="space-y-2">
        <AnimatePresence>
          {displayReviews.map((review, idx) => {
            // Fresh-account safety: a review row can arrive with the user
            // relation absent (deleted user / partial sync payload). Guard
            // instead of crashing on null.split.
            const reviewerName: string = review.user?.fullName || 'Customer';
            const initials = reviewerName
              .split(' ')
              .map((n: string) => n[0])
              .filter(Boolean)
              .slice(0, 2)
              .join('')
              .toUpperCase();
            const colors = ['bg-emerald-500', 'bg-teal-500', 'bg-amber-500', 'bg-rose-500', 'bg-violet-500'];
            const colorClass = colors[reviewerName.length % colors.length];

            return (
              <motion.div
                key={review.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="flex items-start gap-2.5 p-2.5 rounded-xl bg-gray-50 dark:bg-gray-800/50"
              >
                <div className={`h-8 w-8 rounded-full ${colorClass} flex items-center justify-center flex-shrink-0`}>
                  <span className="text-[10px] font-bold text-white">{initials || '?'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-foreground">{reviewerName}</span>
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
          {showAll ? t('showLess' as TranslationKeys) : `${t('seeAllReviews')} (${reviews.length})`}
        </Button>
      )}
    </div>
  );
}
