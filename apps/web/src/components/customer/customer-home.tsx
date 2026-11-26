'use client';

/**
 * CustomerHome — SIMPLIFIED (customer UX simplification round).
 *
 * The old home was a design-system showcase stacked five rails deep:
 * active-ticket gradient hero, quick-actions grid, a horizontal CardSwiper
 * of wide agency cards, plus below-the-fold "recently visited" and
 * "recent activity" sections. All removed.
 *
 * What the screen is now, top to bottom:
 *   1. Compact header strip: greeting + avatar → profile.
 *   2. Active ticket strip (one plain card, tap → queue).
 *   3. Search bar (suggestions + recent searches kept) with inline QR scan.
 *   4. Agency-code join row.
 *   5. Category filter chips.
 *   6. Branch search results (when searching) — plain rows.
 *   7. Agency list — one simple bordered card per agency in a plain grid.
 *   8. In-page agency detail (join flow) — plain card.
 *
 * Endpoints and flows are UNCHANGED: GET /api/agencies,
 * GET /api/agencies/code/{code}, GET /api/agencies/branches,
 * GET /api/favorites?userId, POST /api/favorites, POST /api/reservations,
 * GET /api/reservations/active?userId (offline backoff), GET /api/reviews.
 * IndexedDB cache-first paint (Task 84) and resume revalidation (0.6.16)
 * are kept as-is.
 */

import { apiFetch } from '@/lib/api-fetch';
import { toLocalDateString } from '@/lib/date-utils';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';
import { logQueue } from '@/lib/remote-logger';
// Task 84 — IndexedDB stale-while-revalidate: the home screen paints instantly
// from the last-known payload (even fully offline) and refreshes silently.
import { cacheGet, cacheSet, cacheKeyFor } from '@/lib/local-cache';
// 0.6.16 — revalidate view data when the app resumes to the foreground
// (close-and-reopen on phones/Electron resumes the WebView WITHOUT a reload
// — no remount, no refetch, silently-dead socket → stale screens until a
// manual refresh; see lib/resume-refresh.ts for the full root cause).
import { useResumeRefresh } from '@/lib/resume-refresh';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
// Agencies Management — per-category terminology scope for the in-page agency
// detail view ("Patient Reviews" instead of "Customer Reviews" for clinics).
import { useCategoryTermScope } from '@/hooks/use-category-terms';
import { UserAvatar } from '@/components/shared/user-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/shared/error-state';
import { AgencyRatingDisplay } from '@/components/shared/agency-rating-display';
import {
  Search,
  MapPin,
  QrCode,
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
  Building2,
  RefreshCw,
  Briefcase,
  CheckCircle2,
  MessageCircle,
  Star,
} from 'lucide-react';
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
import { getAgencyName, getCategoryLabel, isOpenNow, type AgencyListItem, type AgencyDetail } from './home/types';
import { CategoryFilters } from './home/CategoryFilters';
import type { BranchListItem } from './home/BranchCard';
import { useCustomerLocation } from '@/hooks/use-customer-location';
import { useDebounce } from '@/hooks/use-debounce';
import { haversineDistanceKm, formatDistance } from '@/lib/geo';
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
    // r21-8 — counter pointer when the payload carries one.
    const counter = r.counter as { name?: string; number?: number } | null | undefined;
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
      counterName: counter?.name || (counter?.number != null ? `#${counter.number}` : undefined),
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
  // Agencies Management — per-category terminology for the detail view. Called
  // unconditionally in the body: null slug (list view) clears the scope, an
  // open detail activates that agency's category words; the hook's internal
  // version bump re-renders THIS component so every t() re-evaluates.
  useCategoryTermScope(selectedAgency?.category);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [togglingFav, setTogglingFav] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  // r23 — explicit service selection: when the join dialog opens without a
  // preset service, the agency's active services are fetched so the dialog
  // can REQUIRE a pick whenever it serves more than one.
  const [pendingServices, setPendingServices] = useState<
    Array<{ id: string; name: string; nameAr?: string | null; nameFr?: string | null; prefix?: string }>
  >([]);
  const [pendingServiceId, setPendingServiceId] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [preferredTime, setPreferredTime] = useState('');
  const [fixedTimeEnabled, setFixedTimeEnabled] = useState(false);
  const [qrScannerOpen, setQrScannerOpen] = useState(false);
  const [activeReservations, setActiveReservations] = useState<ActiveTicket[]>([]);
  // Task 84 — the cached instant paint of the active-ticket strip runs once
  // per mount (the polling loop owns the screen afterwards).
  const activeCachePainted = useRef(false);

  // 0.6.16 — resume revalidation: bumps a nonce that the fetch effects below
  // depend on, so coming back to the foreground refetches agencies,
  // favorites and the active-ticket strip with the view's own fetch paths
  // (cache-first paint + network revalidate).
  const [resumeNonce, setResumeNonce] = useState(0);
  useResumeRefresh(() => setResumeNonce((n) => n + 1));

  useEffect(() => {
    fetchAgencies();
    // Load recent searches from localStorage
    try {
      const stored = localStorage.getItem('blasti-recent-searches');
      if (stored) setRecentSearches(JSON.parse(stored));
    } catch { /* silent */ }
  }, [resumeNonce]);

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
  }, [fetchFavorites, resumeNonce]);

  const fetchAgencies = async () => {
    setLoading(true);
    setFetchError(false);
    // Task 84 — instant cache paint: render the last-known agency list right
    // away, then revalidate. A dead/slow API no longer blank the home screen
    // (the old "30s skeleton, sometimes never" bug).
    const agencyKey = cacheKeyFor('/api/agencies');
    const cachedAgencies = await cacheGet<{ agencies?: AgencyListItem[] }>(agencyKey);
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
      // Null-safe (Task 86 field-fix): address is a nullable column — a
      // null-address agency crashed the whole home with "cannot read
      // properties of null (reading 'toLowerCase')" the moment a query
      // was typed (mirrored fix in customer-search.tsx).
      const matchSearch =
        !query ||
        a.name.toLowerCase().includes(query) ||
        a.nameAr?.includes(query) ||
        a.nameFr?.toLowerCase().includes(query) ||
        a.address?.toLowerCase().includes(query) ||
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
  // consumed — not modified).
  const handleSelectBranch = (branch: BranchListItem) => {
    useAppStore.getState().setBranchProfileId(branch.id);
    setView('customer-branch-profile');
  };

  const handleJoinQueue = (agencyId: string, serviceId?: string) => {
    // Auth guard — must be logged in as a customer
    if (!user?.id) {
      toast.error(t('error'));
      return;
    }
    // Open date picker dialog instead of joining directly
    setPendingJoin({ agencyId, serviceId });
    setPendingServices([]);
    setPendingServiceId(null);
    setSelectedDate(undefined); // Reset to default (today)
    setDateDialogOpen(true);
  };

  // r23 — fetch the pending agency's active services while the join dialog
  // is open and no service was preselected (quick-join from the cards).
  useEffect(() => {
    if (!dateDialogOpen || !pendingJoin || pendingJoin.serviceId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/agencies/${encodeURIComponent(pendingJoin.agencyId)}`);
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => null);
        const detail = (data?.agency ?? data) as {
          services?: Array<{ id: string; name: string; nameAr?: string | null; nameFr?: string | null; prefix?: string }>;
        } | null;
        if (!cancelled) setPendingServices(Array.isArray(detail?.services) ? detail.services : []);
      } catch {
        /* silent — the API's single-service rule still guards the join */
      }
    })();
    return () => { cancelled = true; };
  }, [dateDialogOpen, pendingJoin]);

  const confirmJoinQueue = async () => {
    if (!user?.id) {
      toast.error(t('error'));
      setDateDialogOpen(false);
      setPendingJoin(null);
      return;
    }
    if (!pendingJoin) return;
    // r23 — explicit service choice required whenever the agency serves
    // several services (mirrors the API's SERVICE_SELECTION_REQUIRED gate).
    const chosenServiceId = pendingJoin.serviceId || pendingServiceId;
    if (!chosenServiceId && pendingServices.length > 1) {
      toast.error(t('selectServiceRequired'));
      return;
    }
    setJoining(true);
    try {
      const body: Record<string, string | boolean> = { userId: user.id, agencyId: pendingJoin.agencyId };
      if (chosenServiceId) body.serviceId = chosenServiceId;
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
        // Queue event log — online ticket created from the home join flow.
        try {
          const r = data?.reservation;
          logQueue('ticket_created_online', `Online ticket created (${r?.displayNumber || r?.queueNumber || 'ticket'})`, {
            agencyId: pendingJoin.agencyId,
            serviceId: chosenServiceId || undefined,
            ticketId: r?.id,
            ticketNumber: r?.displayNumber || r?.queueNumber,
            source: 'online',
          });
        } catch { /* never block */ }
        toast.success(t('joinSuccess'));
        setSelectedAgency(null);
        setDateDialogOpen(false);
        setPendingJoin(null);
        setSelectedDate(undefined);
        setPreferredTime('');
        setFixedTimeEnabled(false);
        setView('customer-queue');
      } else {
        // Queue event log — online join failed (endpoint error included).
        try { logQueue('ticket_created_online', `Online join failed: ${data?.error || 'rejected'}`, { agencyId: pendingJoin.agencyId, serviceId: chosenServiceId || undefined, source: 'online' }, 'error'); } catch { /* never block */ }
        if (data.error === 'SERVICE_SELECTION_REQUIRED') {
          toast.error(t('selectServiceRequired'));
        } else {
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      // Queue event log — online join network failure.
      try { logQueue('ticket_created_online', 'Online join failed — network error', { agencyId: pendingJoin?.agencyId, serviceId: pendingJoin?.serviceId || undefined, source: 'online' }, 'error'); } catch { /* never block */ }
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
        // 0.6.126 — cacheTtl 0: the active-ticket strip is a live surface
        // (called/next moves it) — never serve the 30s cached snapshot.
        const res = await apiFetch(`/api/reservations/active?userId=${user.id}`, { cacheTtl: 0 });
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
    // resumeNonce — 0.6.16: a resume bumps the nonce → the poller remounts
    // and immediately fetches fresh active tickets (no 30s wait).
  }, [user?.id, resumeNonce]);

  // Compute category counts for filter badges
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    agencies.forEach(a => {
      const cat = a.category.toUpperCase();
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [agencies]);

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

  const dateDialogContent = (
    <Dialog open={dateDialogOpen} onOpenChange={(open) => { setDateDialogOpen(open); if (!open) { setPendingJoin(null); setSelectedDate(undefined); setPendingServiceId(null); } }}>
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
          {/* r23 — REQUIRED service picker whenever the agency serves several
              services (the API rejects service-less joins in that case). */}
          {pendingServices.length > 1 && (
            <div className="mb-4 pb-4 border-b border-border">
              <div className="flex items-center gap-2 mb-1">
                <Briefcase className="h-4 w-4 text-emerald-600" />
                <p className="text-sm font-medium text-foreground">{t('chooseServiceTitle')}</p>
              </div>
              <p className="text-xs text-muted-foreground mb-2.5">{t('chooseServiceDesc')}</p>
              <div className="space-y-1.5 max-h-44 overflow-y-auto custom-scrollbar">
                {pendingServices.map((svc) => {
                  const selected = pendingServiceId === svc.id;
                  return (
                    <button
                      key={svc.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setPendingServiceId(svc.id)}
                      className={`w-full flex items-center gap-2.5 p-2.5 rounded-xl border-2 text-start transition-colors ${
                        selected
                          ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-900/20'
                          : 'border-border hover:border-emerald-300 dark:hover:border-emerald-700'
                      }`}
                    >
                      {svc.prefix && (
                        <span className="h-7 w-7 rounded-lg bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-300 text-xs font-black flex items-center justify-center flex-shrink-0">
                          {svc.prefix}
                        </span>
                      )}
                      <span className="text-sm font-medium flex-1 min-w-0 truncate">
                        {lang === 'ar' && svc.nameAr ? svc.nameAr : lang === 'fr' && svc.nameFr ? svc.nameFr : svc.name}
                      </span>
                      {selected && <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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
                {t('reservedFor')} {selectedDate.toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
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
                    className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-xs text-muted-foreground">{t('enableFixedTime')}</span>
                </label>
              )}
              {preferredTime && (
                <button
                  onClick={() => { setPreferredTime(''); setFixedTimeEnabled(false); }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={t('clearSearch')}
                >
                  <X className="h-3.5 w-3.5" />
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
            disabled={joining || (pendingServices.length > 1 && !pendingServiceId && !pendingJoin?.serviceId)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10"
          >
            {joining ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <TicketCheck className="h-4 w-4 me-2" />}
            {t('joinQueue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Agency Detail View — simplified plain card
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
      <div className="px-4 py-3 pb-24 lg:pb-8 max-w-2xl mx-auto">
        <button
          onClick={() => setSelectedAgency(null)}
          className="text-sm text-emerald-600 dark:text-emerald-400 font-medium mb-3 flex items-center gap-1 hover:underline"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t('back')}
        </button>

        <div className="rounded-xl border border-border bg-card p-4">
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
            <div className="bg-muted/60 rounded-xl p-2.5 text-center">
              <div className="flex items-center justify-center gap-1 mb-0.5">
                <Users className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                <span className="text-[10px] text-muted-foreground">{t('currentlyWaiting')}</span>
              </div>
              <p className="text-xl font-bold text-foreground">
                {totalWaiting}
              </p>
            </div>
            <div className="bg-muted/60 rounded-xl p-2.5 text-center">
              <div className="flex items-center justify-center gap-1 mb-0.5">
                <Clock className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                <span className="text-[10px] text-muted-foreground">{t('avgWaitTime')}</span>
              </div>
              <p className="text-xl font-bold text-foreground">
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
                  <button
                    key={svc.id}
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
                  </button>
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
        {dateDialogContent}
      </div>
    );
  }

  // ─── Home ──────────────────────────────────────────────────────────────
  return (
    <div className="px-4 py-3 pb-24 lg:pb-8 max-w-3xl mx-auto">
      {/* ── 1. Compact header strip ── */}
      <div className="flex items-center gap-2.5 mb-3 min-h-[44px]">
        <button
          onClick={() => setView('customer-profile')}
          className="h-10 w-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center overflow-hidden flex-shrink-0"
          aria-label={t('profile')}
        >
          {user?.avatarUrl ? (
            // UserAvatar (NOT a raw <img>): the home header is the FIRST thing
            // a mobile customer sees — a raw src here had NO error recovery,
            // so the freshly-uploaded avatar went placeholder for good the
            // moment its one network request failed. UserAvatar brings the
            // retry + native-fallback pipeline AND the session upload
            // override, so the new picture shows instantly and can't regress.
            <UserAvatar avatarUrl={user.avatarUrl} fullName={user.fullName} />
          ) : (
            <span className="text-sm font-bold text-white">{firstName.charAt(0).toUpperCase() || 'U'}</span>
          )}
        </button>
        <div className="min-w-0">
          <h1 className="text-base font-bold text-foreground leading-tight truncate">
            {getTimeGreeting()}{firstName ? `, ${firstName}` : ''}
          </h1>
        </div>
      </div>

      {/* ── 2. Active ticket strip (ONE plain card) ── */}
      <div className="mb-3">
        <ActiveTicketStrip
          tickets={activeReservations}
          t={t}
          lang={lang}
          onOpenQueue={() => setView('customer-queue')}
          onFindAgency={() => {
            searchInputRef.current?.focus();
          }}
        />
      </div>

      {/* ── 3. Search bar + inline QR ── */}
      <div className="relative mb-2">
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
          className="ps-11 pe-24 h-11 text-sm rounded-xl border-border bg-card transition-all"
        />
        <div className="absolute end-2 top-1/2 -translate-y-1/2 flex items-center gap-1 z-10">
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
            className="h-8 w-8 rounded-lg flex items-center justify-center bg-emerald-600 hover:bg-emerald-700 text-white transition-colors"
            aria-label={t('scanQrCode')}
          >
            <ScanLine className="h-4 w-4" />
          </button>
        </div>

        {/* Search Suggestions Dropdown */}
        {(searchFocused || showSuggestions) && (searchSuggestions.length > 0 || (searchQuery === '' && recentSearches.length > 0)) && (
          <div className="absolute top-full mt-1 start-0 end-0 z-[60] bg-card border border-border rounded-xl shadow-lg overflow-hidden">
            {searchQuery === '' && recentSearches.length > 0 ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <div className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground">{t('recentSearches')}</span>
                  </div>
                  <button
                    onClick={clearAllRecentSearches}
                    className="text-[10px] text-emerald-600 dark:text-emerald-400 hover:underline font-medium"
                  >
                    {t('clearAll')}
                  </button>
                </div>
                {recentSearches.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleSearchSelect(term)}
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/50 transition-colors text-start"
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
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-muted/50 transition-colors text-start"
                  >
                    <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
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

      {/* Agency code join row */}
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

      {/* ── 5. Branch search results (Task 83-c-1) — rendered ONLY while a
          search query is active. Empty results AND failed fetches render
          nothing (silent degrade — the agency results below are primary). ── */}
      {searchActive && (branchesLoading || branchResults.length > 0) && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
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
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="rounded-xl border border-border/40 bg-card p-3 space-y-2">
                  <div className="h-3.5 w-3/4 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
                  <div className="h-2.5 w-1/2 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {branchResults.map((branch) => {
                const branchName =
                  (lang === 'ar' && branch.nameAr) || branch.specialName || (lang === 'fr' && branch.nameFr) || branch.name;
                const parentName =
                  (lang === 'ar' && branch.agency?.nameAr) || (lang === 'fr' && branch.agency?.nameFr) || branch.agency?.name || '';
                const loc = branch.address || branch.city || branch.wilaya || '';
                const km = distanceByBranchId?.[branch.id];
                return (
                  <button
                    key={branch.id}
                    onClick={() => handleSelectBranch(branch)}
                    className="w-full flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-start hover:bg-muted/40 transition-colors"
                  >
                    <span className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                      <Building2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold text-foreground truncate">{branchName}</span>
                      <span className="block text-[10px] text-muted-foreground truncate">
                        {parentName}{loc ? ` · ${loc}` : ''}
                      </span>
                    </span>
                    {km != null && (
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">
                        {formatDistance(km).value} {formatDistance(km).unit}
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180 flex-shrink-0" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── 6. Agency list — one simple card per agency ── */}
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <MapPin className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          {t('nearbyAgencies')}
        </h2>
        <button
          onClick={fetchAgencies}
          className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
          aria-label={t('refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="rounded-xl border border-border/40 bg-card p-3.5 space-y-2.5">
              <div className="h-3.5 w-3/4 rounded-full bg-gray-100 dark:bg-gray-800 animate-pulse" />
              <div className="h-2.5 w-1/2 rounded-full bg-gray-50 dark:bg-gray-800/50 animate-pulse" />
              <div className="h-4 w-24 rounded-full bg-muted animate-pulse" />
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
          onExplore={() => { setSearchQuery(''); setSelectedCategory('ALL'); searchInputRef.current?.focus(); }}
          onRetry={fetchAgencies}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {filteredAgencies.map((agency) => {
            const open = agency.workingHoursStart && agency.workingHoursEnd
              ? isOpenNow(agency.workingHoursStart, agency.workingHoursEnd)
              : null;
            const km = distanceByAgencyId?.[agency.id];
            return (
              <div
                key={agency.id}
                className="rounded-xl border border-border bg-card p-3.5 flex items-start gap-2.5 hover:bg-muted/40 transition-colors"
              >
                <button
                  onClick={() => handleSelectAgency(agency)}
                  className="flex-1 min-w-0 text-start"
                  aria-label={getAgencyName(agency, lang)}
                >
                  <p className="text-sm font-semibold text-foreground truncate">
                    {getAgencyName(agency, lang)}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {agency.address}
                  </p>
                  <div className="flex items-center gap-1.5 flex-wrap mt-2">
                    <Badge variant="outline" className="text-[10px]">
                      {getCategoryLabel(agency.category, t)}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={
                        agency.isQueueOpen && !agency.isPaused
                          ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                          : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                      }
                    >
                      {agency.isPaused ? t('paused') : agency.isQueueOpen ? t('openNow') : t('closed')}
                    </Badge>
                    {agency.waitingCount > 0 && (
                      <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Users className="h-3 w-3" />
                        {agency.waitingCount} {t('waiting')}
                      </span>
                    )}
                    {km != null && (
                      <span className="text-[10px] text-muted-foreground">
                        {formatDistance(km).value} {formatDistance(km).unit}
                      </span>
                    )}
                    {open === false && agency.workingHoursStart && (
                      <span className="text-[10px] text-muted-foreground">
                        {t('openFrom')} {agency.workingHoursStart}
                      </span>
                    )}
                  </div>
                </button>
                <button
                  onClick={(e) => toggleFavorite(e, agency.id)}
                  className="h-8 w-8 rounded-lg flex items-center justify-center flex-shrink-0 hover:bg-muted transition-colors"
                  aria-label={t('favorites')}
                  disabled={togglingFav === agency.id}
                >
                  <Heart
                    className={`h-4 w-4 ${
                      favoriteIds.has(agency.id)
                        ? 'fill-red-500 text-red-500'
                        : 'text-muted-foreground'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      )}

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
    <div className="flex flex-col items-center justify-center py-10 text-center px-4">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-50 dark:bg-emerald-900/20 mb-4">
        {searchQuery.trim() ? (
          <Search className="h-6 w-6 text-emerald-500" />
        ) : (
          <TicketCheck className="h-6 w-6 text-emerald-500" />
        )}
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
    </div>
  );
}

// ─── Agency Reviews Preview (same endpoint + logic, simplified) ──────────────
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
        {displayReviews.map((review) => {
          // Fresh-account safety: a review row can arrive with the user
          // relation absent (deleted user / partial sync payload). Guard
          // instead of crashing on null.split.
          const reviewerName: string = review.user?.fullName || 'Customer';
          return (
            <div
              key={review.id}
              className="flex items-start gap-2.5 p-2.5 rounded-xl bg-muted/40"
            >
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
            </div>
          );
        })}
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
