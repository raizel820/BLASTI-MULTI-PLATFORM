'use client';

/**
 * Task 86 — dedicated customer Search view (#/customer/search).
 *
 * The home screen keeps its compact inline search; this page is the
 * full-screen discovery surface reachable from the navigation More menu
 * (and directly via the #/customer/search deep link):
 *
 *   1. Auto-focused search input (clear button, live result count).
 *   2. Recent searches — the SHARED 'blasti-recent-searches' localStorage
 *      key used by the home search, so both surfaces stay in sync.
 *      Tap → runs the search, per-row X removes, header link clears all.
 *   3. Category chips (CategoryFilters, same counts source as home).
 *   4. BRANCH results while a query is active — GET /api/agencies/branches
 *      (Task 83-a, branch-level independent search entities), rendered with
 *      BranchCard. FAILURE POLICY inherited from home (Task 83-c-1 field
 *      fix): a branch fetch that fails for ANY reason (429 rate bucket,
 *      404 on a not-yet-upgraded backend, network error) degrades SILENTLY
 *      to "no branch section" — never an error chip, never a toast; a 429
 *      schedules ONE quiet retry after Retry-After.
 *   5. AGENCY results — the preloaded active-agency list (GET /api/agencies,
 *      IndexedDB SWR cache SHARED with home via the same cache key) filtered
 *      client-side over name/nameFr/nameAr/address/customCode — the primary
 *      result set, identical matching to the home search.
 *   6. Task 82 distance chips via useCustomerLocation (only when permission
 *      is ALREADY granted — never prompts).
 *
 * Navigation handoffs (zero duplicated join-flow code):
 *   - Agency card tap / Quick-join → setPendingAgencyCode(customCode) +
 *     setView('customer-home'): home auto-opens its proven detail+date
 *     dialog (the pendingAgencyCode effect, page.tsx forces the hop home).
 *   - Info button → customer-agency-profile (Task 81-b).
 *   - Branch tap → customer-branch-profile (Task 83-c).
 */

import { apiFetch } from '@/lib/api-fetch';
import { fetchWithRetry } from '@/lib/fetch-with-retry';
// Task 84 — IndexedDB stale-while-revalidate (cache keys SHARED with home:
// the list painted here is the last-known home payload and vice versa).
import { cacheGet, cacheSet, cacheKeyFor } from '@/lib/local-cache';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import {
  Search,
  Building2,
  Navigation,
  Loader2,
  History,
  X,
  ArrowLeft,
  RefreshCw,
  TicketCheck,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { getAgencyName, type AgencyListItem } from './home/types';
import { CategoryFilters } from './home/CategoryFilters';
import { AgencyCardWide } from './home/AgencyCardWide';
import { BranchCard, type BranchListItem } from './home/BranchCard';
import { CardSwiper } from './home/CardSwiper';
import { useCustomerLocation } from '@/hooks/use-customer-location';
import { useDebounce } from '@/hooks/use-debounce';
import { haversineDistanceKm } from '@/lib/geo';

export function CustomerSearch() {
  const setView = useAppStore((s) => s.setView);
  const user = useAppStore((s) => s.user);
  const { t, lang } = useLanguage();

  // ── Search state ────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearchQuery = useDebounce(searchQuery, 350);
  const activeSearch = debouncedSearchQuery.trim();
  const searchActive = activeSearch.length > 0;
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Recent searches (SHARED localStorage key with the home search) ──────
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  useEffect(() => {
    try {
      const stored = localStorage.getItem('blasti-recent-searches');
      if (stored) setRecentSearches(JSON.parse(stored));
    } catch { /* silent */ }
    // Dedicated search page → the input should be ready to type in.
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(focusTimer);
  }, []);

  const addRecentSearch = useCallback((term: string) => {
    if (!term.trim()) return;
    setRecentSearches((prev) => {
      const updated = [term, ...prev.filter((s) => s.toLowerCase() !== term.toLowerCase())].slice(0, 5);
      try { localStorage.setItem('blasti-recent-searches', JSON.stringify(updated)); } catch { /* silent */ }
      return updated;
    });
  }, []);

  const removeRecentSearch = (term: string) => {
    setRecentSearches((prev) => {
      const updated = prev.filter((s) => s !== term);
      try { localStorage.setItem('blasti-recent-searches', JSON.stringify(updated)); } catch { /* silent */ }
      return updated;
    });
  };

  const clearAllRecentSearches = () => {
    setRecentSearches([]);
    try { localStorage.removeItem('blasti-recent-searches'); } catch { /* silent */ }
  };

  // ── Agencies (preloaded list + SWR cache shared with home) ──────────────
  const [agencies, setAgencies] = useState<AgencyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  const fetchAgencies = useCallback(async () => {
    setLoading(true);
    setFetchError(false);
    const agencyKey = cacheKeyFor('/api/agencies');
    const cachedAgencies = await cacheGet<{ agencies?: AgencyListItem[] }>(agencyKey);
    if (cachedAgencies?.data?.agencies?.length) {
      setAgencies(cachedAgencies.data.agencies);
      setLoading(false);
    }
    try {
      const res = await fetchWithRetry('/api/agencies');
      if (res.ok) {
        const data = await res.json();
        void cacheSet(agencyKey, data);
        setAgencies(data.agencies ?? []);
      } else if (!cachedAgencies?.data?.agencies?.length) {
        setFetchError(true);
      }
    } catch {
      if (!cachedAgencies?.data?.agencies?.length) {
        setFetchError(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchAgencies(); }, [fetchAgencies]);

  // ── Favorites (SWR cache shared with home) ──────────────────────────────
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [togglingFav, setTogglingFav] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const fetchFavorites = async () => {
      const favKey = cacheKeyFor('/api/favorites', { userId: user.id });
      const cachedFav = await cacheGet<{ favorites?: Array<{ agencyId: string }> }>(favKey);
      if (!cancelled && cachedFav?.data?.favorites) {
        setFavoriteIds(new Set(cachedFav.data.favorites.map((f) => f.agencyId)));
      }
      try {
        const res = await apiFetch(`/api/favorites?userId=${user.id}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          void cacheSet(favKey, data);
          setFavoriteIds(new Set((data.favorites ?? []).map((f: { agencyId: string }) => f.agencyId)));
        }
      } catch { /* silent — cached hearts stay on screen */ }
    };
    void fetchFavorites();
    return () => { cancelled = true; };
  }, [user?.id]);

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

  // ── Category filter (same chip row as home) ─────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    agencies.forEach((a) => {
      const cat = a.category.toUpperCase();
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [agencies]);

  // ── Branch search — server-driven, silent-degrade (inherited policy) ────
  const [branchResults, setBranchResults] = useState<BranchListItem[]>([]);
  const [branchTotal, setBranchTotal] = useState(0);
  const [branchesLoading, setBranchesLoading] = useState(false);

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

    const fetchBranches = async () => {
      setBranchesLoading(true);
      try {
        const params = new URLSearchParams({ search: query, limit: '20', offset: '0' });
        if (selectedCategory !== 'ALL') params.set('category', selectedCategory);
        const res = await apiFetch(`/api/agencies/branches?${params.toString()}`);
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          const list: BranchListItem[] = Array.isArray(data.branches) ? (data.branches as BranchListItem[]) : [];
          setBranchResults(list);
          setBranchTotal(typeof data.total === 'number' ? data.total : list.length);
          return;
        }
        // Not ok → silent degrade (detail stays in the console for diagnosis).
        console.warn('[CustomerSearch] branch search unavailable:', res.status);
        if (res.status === 429) {
          // ONE quiet retry after Retry-After (bounded 2-10s), only while the
          // user is still on the same query.
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

  // ── Agency results — client-side, IDENTICAL matching to home search ─────
  const filteredAgencies = useMemo(() => {
    return agencies.filter((a) => {
      const matchCategory = selectedCategory === 'ALL' || a.category.toUpperCase() === selectedCategory;
      const query = activeSearch.toLowerCase().trim();
      // Null-safe: address (and the localized names) are nullable columns —
      // a null-address agency (e.g. freshly seeded) must not crash the filter.
      const matchSearch =
        !query ||
        a.name.toLowerCase().includes(query) ||
        a.nameAr?.includes(query) ||
        a.nameFr?.toLowerCase().includes(query) ||
        a.address?.toLowerCase().includes(query) ||
        a.customCode.toLowerCase().includes(query);
      return matchCategory && matchSearch;
    });
  }, [agencies, selectedCategory, activeSearch]);

  // ── Task 82 distance chips (only when permission already granted) ───────
  const { position: customerPosition } = useCustomerLocation(true);
  const distanceByAgencyId = useMemo(() => {
    if (!customerPosition) return null as Record<string, number> | null;
    const map: Record<string, number> = {};
    filteredAgencies.forEach((a) => {
      if (typeof a.latitude === 'number' && typeof a.longitude === 'number') {
        map[a.id] = haversineDistanceKm(customerPosition, { lat: a.latitude, lng: a.longitude });
      }
    });
    return map;
  }, [customerPosition, filteredAgencies]);
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

  // ── Navigation handoffs ─────────────────────────────────────────────────
  // Agency tap / quick-join → home opens its proven detail+date dialog via
  // the pendingAgencyCode effect (page.tsx also forces the hop home).
  const openAgencyJoinFlow = (agency: AgencyListItem) => {
    useAppStore.getState().setPendingAgencyCode(agency.customCode);
    setView('customer-home');
  };
  const openAgencyProfile = (agency: AgencyListItem) => {
    useAppStore.getState().setAgencyProfileId(agency.id);
    setView('customer-agency-profile');
  };
  // Branch tap → branch profile (Task 83-c).
  const openBranchProfile = (branch: BranchListItem) => {
    useAppStore.getState().setBranchProfileId(branch.id);
    setView('customer-branch-profile');
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      addRecentSearch(searchQuery.trim());
      inputRef.current?.blur();
    }
  };

  const totalCount = filteredAgencies.length + (searchActive ? branchTotal : 0);

  return (
    <div className="px-4 py-3 pb-24 lg:pb-8">
      <div className="max-w-5xl mx-auto space-y-4">
        {/* ── Header: back + title ── */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('customer-home')}
            className="h-9 w-9 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors flex-shrink-0"
            aria-label={t('back')}
          >
            <ArrowLeft className="h-[18px] w-[18px] rtl:rotate-180" />
          </button>
          <div className="h-9 w-9 rounded-xl bg-emerald-600 flex items-center justify-center shrink-0">
            <Search className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-foreground leading-tight">{t('search')}</h1>
            {searchActive && (
              <p className="text-xs text-muted-foreground">{totalCount} {t('searchResultsCount')}</p>
            )}
          </div>
        </div>

        {/* ── Search input (auto-focused) ── */}
        <div className="relative">
          <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 h-[18px] w-[18px] text-muted-foreground z-10 pointer-events-none" />
          <Input
            ref={inputRef}
            type="search"
            autoFocus
            placeholder={t('searchGlassmorphic')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="ps-11 pe-10 h-12 text-sm rounded-2xl border-border bg-white dark:bg-gray-900/80 shadow-sm focus-visible:ring-2 focus-visible:ring-emerald-500/20 focus-visible:border-emerald-300"
            aria-label={t('search')}
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); inputRef.current?.focus(); }}
              className="absolute end-3 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label={t('clearSearch')}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* ── Recent searches (query empty only) ── */}
        {!searchActive && recentSearches.length > 0 && (
          <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 overflow-hidden">
            <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
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
            <div className="p-1.5">
              {recentSearches.map((term) => (
                <div key={term} className="flex items-center">
                  <button
                    onClick={() => setSearchQuery(term)}
                    className="flex-1 flex items-center gap-2 px-2.5 py-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-start min-w-0"
                  >
                    <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-foreground truncate">{term}</span>
                  </button>
                  <button
                    onClick={() => removeRecentSearch(term)}
                    className="h-7 w-7 rounded-full flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 flex-shrink-0 me-1"
                    aria-label={t('clearSearch')}
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Category chips ── */}
        <div className="-mx-4 px-4">
          <CategoryFilters
            selectedCategory={selectedCategory}
            onCategoryChange={setSelectedCategory}
            categoryCounts={categoryCounts}
            t={t}
          />
        </div>

        {/* ── Branch results (query active; silent-degrade policy) ── */}
        {searchActive && (branchesLoading || branchResults.length > 0) && (
          <div>
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
              <div className="-mx-4 px-4">
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
                      onSelectBranch={openBranchProfile}
                      distanceKm={distanceByBranchId?.[branch.id] ?? null}
                    />
                  ))}
                </CardSwiper>
              </div>
            )}
          </div>
        )}

        {/* ── Agency results (primary set) ── */}
        <div>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Navigation className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {searchActive ? t('search') : t('nearbyAgencies')}
            </h2>
            <button
              onClick={() => void fetchAgencies()}
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
            <ErrorState onRetry={() => void fetchAgencies()} />
          ) : filteredAgencies.length === 0 ? (
            <EmptyState
              iconComponent={searchActive ? Search : TicketCheck}
              title={searchActive ? t('noSearchResultsTitle') : t('emptyNoAgenciesTitle')}
              description={searchActive ? t('noSearchResultsDesc') : t('emptyNoAgenciesDesc')}
              actionLabel={searchActive ? t('clearSearch') : t('emptyNoAgenciesRetry')}
              onAction={() => {
                if (searchActive) { setSearchQuery(''); setSelectedCategory('ALL'); inputRef.current?.focus(); }
                else void fetchAgencies();
              }}
            />
          ) : (
            <div className="-mx-4 px-4">
              <CardSwiper
                ariaLabel={searchActive ? t('search') : t('nearbyAgencies')}
                itemClassName="w-full md:w-[calc(50%-6px)] lg:w-[calc(33.333%-8px)]"
              >
                {filteredAgencies.map((agency, idx) => (
                  <motion.div
                    key={agency.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.03, 0.3), duration: 0.22 }}
                  >
                    <AgencyCardWide
                      agency={agency}
                      index={idx}
                      lang={lang}
                      isFavorite={favoriteIds.has(agency.id)}
                      toggling={togglingFav === agency.id}
                      t={t}
                      onSelect={openAgencyJoinFlow}
                      onToggleFavorite={toggleFavorite}
                      onQuickJoin={(agencyId) => {
                        const target = filteredAgencies.find((a) => a.id === agencyId);
                        if (target) openAgencyJoinFlow(target);
                      }}
                      distanceKm={distanceByAgencyId?.[agency.id] ?? null}
                      onViewProfile={openAgencyProfile}
                    />
                  </motion.div>
                ))}
              </CardSwiper>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
