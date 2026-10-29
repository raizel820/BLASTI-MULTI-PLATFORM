'use client';

/**
 * useCachedResource — stale-while-revalidate hook for view data (Task 85).
 *
 * WHY: BLASTI is a hash-based SPA — switching tabs UNMOUNTS the previous
 * view, so every dashboard/profile view refetched its data from scratch on
 * mount and users stared at skeletons/spinners for pages they had open
 * seconds earlier. TanStack Query is intentionally not used in this app
 * (deliberate dependency policy), so this hook implements the missing
 * stale-while-revalidate layer on top of lib/local-cache (memory → IndexedDB
 * → localStorage):
 *
 *   1. FIRST RENDER — the hook's `cached` value is read synchronously from
 *      the memory layer, so a view that was open seconds ago paints its last
 *      known data immediately (no skeleton flash at all).
 *   2. MOUNT EFFECT — if the memory layer missed (fresh app boot) the
 *      IndexedDB cache is consulted once; then, when the newest entry is
 *      older than `ttlMs` (or the fetcher never ran for it), the network
 *      revalidation runs via `fetcher` and updates BOTH the cache and the
 *      returned `data`.
 *   3. In-flight revalidations are deduped per cache key, so several
 *      components mounted at once trigger exactly one network request.
 *
 * The fetcher must return the PARSED payload (or null) — it is called only
 * for actual network loads. `refresh()` forces a network revalidation (used
 * after mutations) and returns the fresh data so callers can react to it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cacheGet,
  cacheSet,
  cacheRemove,
  cacheKeyFor,
  cachePeek,
  isCacheFresh,
} from '@/lib/local-cache';

export interface CachedResource<T> {
  /** Synchronously-cached value from this session (null on first-ever load). */
  cached: T | null;
  /** Latest known value (cache or network). */
  data: T | null;
  /** True until the first network revalidation attempt settles. */
  loading: boolean;
  /** True when `data` came from the cache (may be stale). */
  fromCache: boolean;
  /** Force a network refresh (also called automatically when cache is stale). */
  refresh: () => Promise<T | null>;
  /** Drop the cached entry (call after mutations that invalidate the data). */
  invalidate: () => Promise<void>;
}

// Module-level in-flight dedupe per cache key.
const inflight = new Map<string, Promise<unknown>>();

export function useCachedResource<T>(opts: {
  /** Stable cache key — typically cacheKeyFor(path, params). */
  key: string | null;
  /** Network fetcher returning the parsed payload or null. */
  fetcher: () => Promise<T | null>;
  /** Revalidate when the cached entry is older than this (default 15s). */
  ttlMs?: number;
  /** Skip everything when false (e.g. no user yet). */
  enabled?: boolean;
}): CachedResource<T> {
  const { key, ttlMs = 15_000, enabled = true } = opts;
  // Keep the latest fetcher without re-subscribing the effect.
  const fetcherRef = useRef(opts.fetcher);
  useEffect(() => {
    fetcherRef.current = opts.fetcher;
  }, [opts.fetcher]);

  // Synchronous memory read during FIRST render — the instant-paint layer.
  const [cached] = useState<{ data: T; cachedAt: number } | null>(() =>
    key ? cachePeek<T>(key) : null,
  );

  const [data, setData] = useState<T | null>(cached?.data ?? null);
  const [loading, setLoading] = useState<boolean>(!cached);
  const [fromCache, setFromCache] = useState<boolean>(!!cached);
  const appliedKeyRef = useRef<string | null>(key);

  const runRevalidation = useCallback(async (): Promise<T | null> => {
    if (!key) return null;
    const existing = inflight.get(key) as Promise<T | null> | undefined;
    if (existing) return existing;
    const promise = (async () => {
      try {
        const fresh = await fetcherRef.current();
        if (fresh !== null) await cacheSet(key, fresh);
        return fresh;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }, [key]);

  useEffect(() => {
    if (!key || !enabled) return;
    let alive = true;

    // Key changed (different user/params) → adopt the new identity cleanly.
    if (appliedKeyRef.current !== key) {
      appliedKeyRef.current = key;
      const mem = cachePeek<T>(key);
      if (mem) {
        setData(mem.data);
        setFromCache(true);
        setLoading(false);
      } else {
        setData(null);
        setFromCache(false);
        setLoading(true);
      }
    }

    (async () => {
      // Memory miss → consult the persistent layer (fresh app boot).
      let entry = cachePeek<T>(key);
      if (!entry) entry = await cacheGet<T>(key);
      if (!alive) return;
      if (entry && !data) {
        setData(entry.data);
        setFromCache(true);
      }
      const haveFreshData = entry ?? (data ? { data, cachedAt: Date.now() } : null);
      const needsNetwork = !haveFreshData || !isCacheFresh(haveFreshData.cachedAt, ttlMs);
      if (!needsNetwork) {
        setLoading(false);
        return;
      }
      const fresh = await runRevalidation();
      if (!alive) return;
      if (fresh !== null) {
        setData(fresh);
        setFromCache(false);
      }
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [key, enabled, ttlMs, runRevalidation]);

  const refresh = useCallback(async (): Promise<T | null> => {
    const fresh = await runRevalidation();
    if (fresh !== null) {
      setData(fresh);
      setFromCache(false);
    }
    return fresh;
  }, [runRevalidation]);

  const invalidate = useCallback(async (): Promise<void> => {
    if (!key) return;
    await cacheRemove(key);
  }, [key]);

  return { cached: cached?.data ?? null, data, loading, fromCache, refresh, invalidate };
}

/** Convenience: build the standard cache key for an API path + params. */
export function resourceKey(path: string, params?: Record<string, unknown>): string {
  return cacheKeyFor(path, params);
}
