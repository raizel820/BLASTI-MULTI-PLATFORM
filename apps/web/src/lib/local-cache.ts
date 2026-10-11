/**
 * BLASTI Local Cache — persistent stale-while-revalidate data cache (Task 84).
 *
 * WHY: on slow/absent networks (mobile data, stopped API, stale build-time
 * API URL) every view previously waited on the network before rendering —
 * the "30s black screen, sometimes never" experience. This module persists
 * API GET responses in IndexedDB (localStorage fallback) so any view can
 * render INSTANTLY from the last known data and refresh silently.
 *
 * Design:
 *  - Dependency-free: raw IndexedDB with a localStorage fallback, SSR-safe.
 *  - Keys are namespaced per API path+query so different views never collide.
 *  - `cachedFetch` implements stale-while-revalidate:
 *      1. resolve immediately with cached data (if any)
 *      2. refresh from the network in the background
 *      3. update the cache with fresh data on success
 *    The caller always gets a synchronous-feeling first paint.
 *  - Cache is READ-ONLY safe offline: network failure with a cached value
 *    still returns the cached data (flagged `stale`) instead of an error.
 */

const DB_NAME = 'blasti-local-cache';
const DB_VERSION = 1;
const STORE_NAME = 'responses';

interface CacheEntry {
  data: unknown;
  cachedAt: number;
}

// ─── IndexedDB plumbing ───────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idbGet(key: string): Promise<CacheEntry | null> {
  return openDb().then(
    (db) =>
      new Promise<CacheEntry | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(key);
          req.onsuccess = () => resolve((req.result as CacheEntry) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function idbSet(key: string, entry: CacheEntry): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(entry, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}

// ─── localStorage fallback (private browsing / IDB unavailable) ───────────────

function lsKey(key: string): string {
  return `blasti-cache:${key}`;
}

function lsGet(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(lsKey(key));
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, entry: CacheEntry): void {
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(entry));
  } catch {
    // quota exceeded / private mode — non-fatal
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Read a cached payload. Returns null when absent or unreadable. */
export async function cacheGet<T>(key: string): Promise<{ data: T; cachedAt: number } | null> {
  if (typeof window === 'undefined') return null;
  const entry = (await idbGet(key)) ?? lsGet(key);
  if (!entry) return null;
  return { data: entry.data as T, cachedAt: entry.cachedAt };
}

/** Persist a payload. Never throws. */
export async function cacheSet(key: string, data: unknown): Promise<void> {
  if (typeof window === 'undefined') return;
  const entry: CacheEntry = { data, cachedAt: Date.now() };
  await idbSet(key, entry);
  lsSet(key, entry); // belt & suspenders: cheap mirror for tiny payloads
}

/** Drop one cache entry (used after mutations that invalidate a list). */
export async function cacheRemove(key: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const db = await openDb();
    if (db) {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
    }
  } catch {
    // non-fatal
  }
  try {
    localStorage.removeItem(lsKey(key));
  } catch {
    // non-fatal
  }
}

/** Build a stable cache key from an API path + optional params object. */
export function cacheKeyFor(path: string, params?: Record<string, unknown>): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!params || Object.keys(params).length === 0) return normalized;
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&');
  return `${normalized}?${sorted}`;
}

// ─── Stale-While-Revalidate fetch ─────────────────────────────────────────────

export interface CachedFetchResult<T> {
  /** Fresh-or-cached payload (cached served first, then replaced). */
  data: T | null;
  /** True when the payload came from cache (may be stale). */
  fromCache: boolean;
  /** True when the network refresh failed (data may be stale or null). */
  stale: boolean;
}

/**
 * Stale-while-revalidate GET:
 *  1. If a cached value exists → return it immediately (fromCache=true).
 *  2. Refresh from the network (apiFetch GET) in the background.
 *  3. On success → cache + return fresh; on failure → return cached (stale)
 *     or a miss.
 *
 * Import of apiFetch is lazy to avoid cycles — callers all live above it.
 */
export async function cachedFetch<T>(
  path: string,
  opts?: {
    params?: Record<string, string>;
    ttlMs?: number;
    apiFetch?: typeof import('./api-fetch').apiFetch;
  },
): Promise<CachedFetchResult<T>> {
  const key = cacheKeyFor(path, opts?.params);
  const cached = await cacheGet<T>(key);

  // Dynamic import keeps this module importable from anywhere without cycles.
  const { apiFetch } = opts?.apiFetch
    ? { apiFetch: opts.apiFetch }
    : await import('./api-fetch');

  try {
    const query = opts?.params
      ? `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(opts.params).toString()}`
      : path;
    const res = await apiFetch(query);
    if (res.ok) {
      const data = (await res.json()) as T;
      await cacheSet(key, data);
      return { data, fromCache: false, stale: false };
    }
    // Non-OK response: fall back to cache if we have one.
    if (cached) return { data: cached.data, fromCache: true, stale: true };
    return { data: null, fromCache: false, stale: true };
  } catch {
    if (cached) return { data: cached.data, fromCache: true, stale: true };
    return { data: null, fromCache: false, stale: true };
  }
}
