'use client';

/**
 * BLASTI Offline Cache — IndexedDB-backed cache for API GET responses.
 *
 * Stores API responses locally so the app can serve data when the user
 * goes offline.  Every entry carries a TTL; expired entries are silently
 * treated as missing.
 *
 * The module is SSR-safe — every method returns a no-op value when
 * `typeof window === 'undefined'`.
 */

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/** Shape of a single cached API response. */
export interface CachedResponse {
  /** Auto-incremented primary key. */
  id?: number;
  /** The request URL (unique per entry). */
  url: string;
  /** Serialised response body (any JSON-serialisable value). */
  data: unknown;
  /** HTTP status code captured at cache time. */
  status: number;
  /** ISO-8601 timestamp when the entry was created. */
  timestamp: string;
  /** ISO-8601 timestamp when the entry expires. */
  expiry: string;
}

/** Stats returned by {@link OfflineCache.getStats}. */
export interface CacheStats {
  /** Total number of entries (including expired). */
  count: number;
  /** ISO-8601 timestamp of the oldest entry, or null if empty. */
  oldest: string | null;
  /** ISO-8601 timestamp of the newest entry, or null if empty. */
  newest: string | null;
}

/** Return type for {@link OfflineCache.get} — null when missing / expired. */
export interface CachedResult {
  data: unknown;
  status: number;
  timestamp: string;
}

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const DB_NAME = 'blasti-cache';
const DB_VERSION = 1;
const STORE_NAME = 'api-responses';

/** Default TTL: 5 minutes in milliseconds. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const isBrowser = typeof window !== 'undefined';

/** Returns `true` when an ISO date string is in the past. */
function isExpired(expiry: string): boolean {
  return new Date(expiry).getTime() < Date.now();
}

/**
 * Open (or create) the IndexedDB database and return a handle to it.
 * Resolves to `null` outside the browser.
 */
function openDB(): Promise<IDBDatabase | null> {
  if (!isBrowser) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('url', 'url', { unique: true });
        store.createIndex('expiry', 'expiry', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ────────────────────────────────────────────────────────────────────────
// OfflineCache class
// ────────────────────────────────────────────────────────────────────────

class OfflineCache {
  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Retrieve a cached response by URL.
   *
   * Returns the cached payload when the entry exists **and** has not
   * expired.  Returns `null` otherwise (missing or stale).
   */
  async get(url: string): Promise<CachedResult | null> {
    if (!isBrowser) return null;

    try {
      const db = await openDB();
      if (!db) return null;

      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('url');
      const request = index.get(url);

      const entry: CachedResponse | undefined = await new Promise<
        CachedResponse | undefined
      >((resolve, reject) => {
        request.onsuccess = () =>
          resolve(request.result as CachedResponse | undefined);
        request.onerror = () => reject(request.error);
      });

      db.close();

      if (!entry) return null;
      if (isExpired(entry.expiry)) return null;

      return {
        data: entry.data,
        status: entry.status,
        timestamp: entry.timestamp,
      };
    } catch {
      // Silently swallow errors — cache is best-effort.
      return null;
    }
  }

  /**
   * Store an API response in the cache.
   *
   * @param url    - The request URL used as the lookup key.
   * @param data   - JSON-serialisable response body.
   * @param ttlMs  - Time-to-live in ms (default 5 min).
   * @param status - HTTP status code (default 200).
   */
  async set(
    url: string,
    data: unknown,
    ttlMs: number = DEFAULT_TTL_MS,
    status: number = 200,
  ): Promise<void> {
    if (!isBrowser) return;

    try {
      const db = await openDB();
      if (!db) return;

      const now = new Date();
      const entry: CachedResponse = {
        url,
        data,
        status,
        timestamp: now.toISOString(),
        expiry: new Date(now.getTime() + ttlMs).toISOString(),
      };

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // Upsert: delete any existing entry with the same url first,
      // then add the new one.
      const urlIndex = store.index('url');
      const getReq = urlIndex.getKey(url);

      await new Promise<void>((resolve, reject) => {
        getReq.onsuccess = () => {
          const existingId = getReq.result as number | undefined;
          if (existingId !== undefined) {
            store.delete(existingId);
          }
          store.add(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });

      db.close();
    } catch {
      // Best-effort — silently ignore.
    }
  }

  /**
   * Remove entries whose URL matches the given glob-like pattern.
   *
   * Supported wildcards:
   * - `*`  matches any sequence of characters within a path segment.
   *
   * Example: `invalidate('/api/reservations/*')` removes every cached
   * URL that starts with `/api/reservations/`.
   *
   * @returns The number of entries removed.
   */
  async invalidate(pattern: string): Promise<number> {
    if (!isBrowser) return 0;

    try {
      const db = await openDB();
      if (!db) return 0;

      // Convert simple glob pattern to a RegExp.
      // `*` → `[^/]*` (match within a single segment)
      const regexStr = pattern
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex specials
        .replace(/\*/g, '[^/]*');
      const regex = new RegExp(`^${regexStr}$`);

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getAll = store.getAll();

      const entries: CachedResponse[] = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });

      let removed = 0;
      for (const entry of entries) {
        if (regex.test(entry.url)) {
          store.delete(entry.id!);
          removed++;
        }
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
      return removed;
    } catch {
      return 0;
    }
  }

  /**
   * Remove **all** entries from the cache.
   */
  async invalidateAll(): Promise<void> {
    if (!isBrowser) return;

    try {
      const db = await openDB();
      if (!db) return;

      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
    } catch {
      // Best-effort.
    }
  }

  /**
   * Return aggregate statistics about the cache contents.
   *
   * Includes both valid and expired entries so the caller can see
   * how much stale data is lingering.
   */
  async getStats(): Promise<CacheStats> {
    const empty: CacheStats = { count: 0, oldest: null, newest: null };
    if (!isBrowser) return empty;

    try {
      const db = await openDB();
      if (!db) return empty;

      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getAll = store.getAll();

      const entries: CachedResponse[] = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });

      db.close();

      if (entries.length === 0) return empty;

      const timestamps = entries
        .map((e) => new Date(e.timestamp).getTime())
        .sort((a, b) => a - b);

      return {
        count: entries.length,
        oldest: new Date(timestamps[0]).toISOString(),
        newest: new Date(timestamps[timestamps.length - 1]).toISOString(),
      };
    } catch {
      return empty;
    }
  }

  /**
   * Remove all expired entries from the cache.
   *
   * @returns The number of entries that were removed.
   */
  async cleanup(): Promise<number> {
    if (!isBrowser) return 0;

    try {
      const db = await openDB();
      if (!db) return 0;

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const expiryIndex = store.index('expiry');
      const now = new Date().toISOString();

      // IDB key ranges are lexicographic on strings, so ISO dates work.
      const range = IDBKeyRange.upperBound(now, true);
      const cursorReq = expiryIndex.openCursor(range);

      let removed = 0;

      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            removed++;
            cursor.continue();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      db.close();
      return removed;
    } catch {
      return 0;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Singleton export
// ────────────────────────────────────────────────────────────────────────

/** Singleton instance of the offline cache. */
export const offlineCache = new OfflineCache();
