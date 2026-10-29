'use client';

/**
 * BLASTI Persistent Image Cache (cache-1).
 *
 * WHY: uploaded avatars/logos are content-addressed capability URLs that the
 * API serves with `Cache-Control: immutable` — but WebViews (Capacitor
 * Android, Electron) evict HTTP-cache entries aggressively on navigation,
 * so every view remount re-downloaded the image and the UI flashed the
 * initials/placeholder for a second. This module keeps the IMAGE BYTES in
 * CacheStorage (persistent across app restarts) and hands components a
 * stable blob: object-URL, so a remount paints instantly from memory.
 *
 * Strategy — stale-while-revalidate:
 *   1. cache HIT  → resolve the object-URL immediately (zero network),
 *                    revalidate in the background with If-None-Match;
 *                    a 304 keeps the copy, a 200 swaps the bytes and
 *                    notifies subscribers (components update in place).
 *   2. cache MISS → fetch once, store, notify; callers may render the
 *                    direct URL meanwhile (browser HTTP cache + immutable).
 *
 * Safety: uploads are PUBLIC capability URLs (no Authorization header), so
 * plain fetch works everywhere; blob: URLs are module-memoized per key so
 * unmount/remount cycles reuse the SAME handle (no re-decode flicker).
 * The cache is capped with an LRU (oldest entries evicted beyond MAX_ENTRIES)
 * and every failure degrades silently to the previous direct-URL behavior.
 */

const CACHE_NAME = 'blasti-images-v1';
const INDEX_KEY = 'blasti-img-lru';
export const MAX_ENTRIES = 400;

interface MemoryEntry {
  objectUrl: string;
  bytes: Blob;
  mime: string;
}

/**
 * Canonical cache key: origin-agnostic. `/api/upload/file/x` and
 * `http://<any-host>:3003/api/upload/file/x` MUST map to the same entry,
 * because the same image is subscribed under a rebased URL in one runtime
 * and a relative path in another (uploads hand out relative URLs; avatars
 * render through getProxiedUrl). data:/blob: → '' (never cached here).
 */
function toKey(path: string): string {
  const raw = (path || '').split('#')[0];
  if (!raw) return '';
  if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('file:')) return '';
  let pathPart = raw;
  const m = /^https?:\/\/[^/]+(\/[^?#]*)(\?[^#]*)?/i.exec(raw);
  if (m) {
    pathPart = m[1] + (m[2] || '');
  } else if (!raw.startsWith('/')) {
    return ''; // not a fetchable API path
  }
  // Strip any cache-buster / volatile query — the canonical path is the key.
  return pathPart.replace(/[?&]r=\d+/g, '').replace(/\?$/, '');
}

function normalizeKey(path: string): string {
  return toKey(path);
}

// Session-wide handle reuse: key → object URL handed to <img> elements.
const memoryHandles = new Map<string, string>();

// Fallback store when CacheStorage is unavailable (older WebViews / SSR edge).
const memoryStore = new Map<string, MemoryEntry>();

// CacheStorage availability (computed once).
let cacheStorageOk: boolean | null = null;

function hasCacheStorage(): boolean {
  if (typeof window === 'undefined' || typeof caches === 'undefined') return false;
  if (cacheStorageOk === null) {
    try {
      cacheStorageOk = typeof caches.open === 'function';
    } catch {
      cacheStorageOk = false;
    }
  }
  return cacheStorageOk;
}

// ─── LRU index (localStorage; best-effort) ───────────────────────────────────

function readIndex(): Record<string, number> {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeIndex(idx: Record<string, number>): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch {
    // quota — non-fatal
  }
}

function touchKey(key: string): void {
  const idx = readIndex();
  idx[key] = Date.now();
  const keys = Object.keys(idx);
  if (keys.length <= MAX_ENTRIES) {
    writeIndex(idx);
    return;
  }
  // Evict oldest beyond the cap (both stores).
  keys.sort((a, b) => idx[a] - idx[b]);
  const evict = keys.slice(0, keys.length - MAX_ENTRIES);
  const next: Record<string, number> = {};
  for (const k of keys) if (!evict.includes(k)) next[k] = idx[k];
  writeIndex(next);
  for (const k of evict) {
    memoryHandles.delete(k);
    memoryStore.delete(k);
    if (hasCacheStorage()) {
      void caches.open(CACHE_NAME).then((c) => c.delete(k)).catch(() => undefined);
    }
  }
}

// ─── Core operations ─────────────────────────────────────────────────────────

async function readBlob(key: string): Promise<{ bytes: Blob; mime: string; etag: string | null } | null> {
  if (hasCacheStorage()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(key);
      if (hit) {
        const mime = hit.headers.get('Content-Type') || 'image/jpeg';
        return { bytes: await hit.blob(), mime, etag: hit.headers.get('ETag') };
      }
    } catch {
      // fall through to memory store
    }
  }
  const mem = memoryStore.get(key);
  return mem ? { bytes: mem.bytes, mime: mem.mime, etag: null } : null;
}

async function writeBlob(key: string, res: Response): Promise<void> {
  const mime = res.headers.get('Content-Type') || 'image/jpeg';
  const etag = res.headers.get('ETag');
  const bytes = await res.blob();
  if (bytes.size === 0) return;
  const headers: Record<string, string> = { 'Content-Type': mime, 'Content-Length': String(bytes.size) };
  if (etag) headers.ETag = etag;
  if (hasCacheStorage()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(key, new Response(bytes.slice(0), { status: 200, headers }));
    } catch {
      // CacheStorage put can fail on quota/private mode — keep memory copy.
      memoryStore.set(key, { objectUrl: '', bytes, mime });
    }
  } else {
    memoryStore.set(key, { objectUrl: '', bytes, mime });
  }
  touchKey(key);
}

function handleFor(key: string, bytes: Blob, mime: string): string {
  const existing = memoryHandles.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(bytes.slice(0, bytes.size, mime || 'image/jpeg'));
  memoryHandles.set(key, url);
  return url;
}

// ─── Subscriber fan-out (components re-render when bytes change) ─────────────

type Listener = (objectUrl: string | null) => void;
const listeners = new Map<string, Set<Listener>>();

function notify(key: string, objectUrl: string | null): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(objectUrl);
    } catch {
      // a broken subscriber must never break the pipeline
    }
  }
}

/**
 * SYNCHRONOUS handle lookup — session-remembered images paint on the very
 * FIRST render (no async gap, no placeholder flash on remount). Returns the
 * blob: object-URL when the bytes are already decoded in this session, null
 * otherwise (the async subscribeImage path then fills/revalidates).
 */
export function peekImageHandle(path: string): string | null {
  const key = normalizeKey(path);
  if (!key) return null;
  return memoryHandles.get(key) ?? null;
}

/**
 * Subscribe to an image key. The listener fires IMMEDIATELY with the cached
 * object-URL (or null) and again whenever background revalidation swaps the
 * bytes. Returns an unsubscribe fn. SSR-safe (no-op subscription).
 */
export function subscribeImage(path: string, listener: Listener): () => void {
  const key = normalizeKey(path);
  if (!key || typeof window === 'undefined') return () => undefined;
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  // Synchronous first paint from the session handle map — covers the remount
  // case BEFORE the async readBlob below resolves (flash fix, logs-1 round).
  const memo = memoryHandles.get(key);
  if (memo) listener(memo);
  // Immediate paint from whatever the stores already have.
  void (async () => {
    try {
      const blob = await readBlob(key);
      listener(blob ? handleFor(key, blob.bytes, blob.mime) : null);
    } catch {
      listener(null);
    }
  })();
  // Kick a background fill/revalidation so a MISS becomes a HIT shortly.
  void fetchAndCacheImage(key);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(key);
  };
}

/** Single-flight revalidation guards (per key). */
const revalidating = new Set<string>();

/**
 * Fetch the image bytes and store them. Safe to call repeatedly —
 * concurrent calls coalesce. Sends If-None-Match when we hold a validator;
 * a 304 keeps the cached copy (zero payload), a 200 replaces it.
 */
export async function fetchAndCacheImage(path: string, baseHeaders?: Record<string, string>): Promise<string | null> {
  const key = normalizeKey(path);
  if (!key || typeof window === 'undefined') return null;
  if (revalidating.has(key)) return null;
  revalidating.add(key);
  try {
    // Fetch the URL AS THE CALLER PASSED IT (rebased for this runtime), but
    // store under the canonical key so every environment shares one entry.
    const fetchUrl = path.split('#')[0].replace(/[?&]r=\d+/g, '');
    // Best-effort validator from the stored response (CacheStorage keeps headers).
    let etag: string | null = null;
    if (hasCacheStorage()) {
      try {
        const cache = await caches.open(CACHE_NAME);
        etag = (await cache.match(key))?.headers.get('ETag') ?? null;
      } catch {
        etag = null;
      }
    }
    const res = await fetch(fetchUrl, {
      method: 'GET',
      credentials: 'omit', // public capability URL — keeps wildcard CORS valid
      cache: etag ? 'no-cache' : 'default', // we do our own validation via CacheStorage
      headers: { Accept: 'image/*', ...(etag ? { 'If-None-Match': etag } : {}), ...(baseHeaders || {}) },
    });
    if (res.status === 304) {
      // Unchanged — keep the cached copy, just refresh LRU + notify.
      touchKey(key);
      const blob = await readBlob(key);
      const url = blob ? handleFor(key, blob.bytes, blob.mime) : null;
      notify(key, url);
      return url;
    }
    if (res.ok && res.status === 200) {
      await writeBlob(key, res);
      const blob = await readBlob(key);
      const url = blob ? handleFor(key, blob.bytes, blob.mime) : null;
      notify(key, url);
      return url;
    }
    return null;
  } catch {
    return null; // offline / CORS — direct-URL path still works
  } finally {
    revalidating.delete(key);
  }
}

/**
 * Warm the cache without any UI attached (login prefetch, boot warm-up).
 * Never throws; skipped when the bytes are already cached.
 */
export async function preloadImage(path: string): Promise<void> {
  const key = normalizeKey(path);
  if (!key) return;
  const existing = await readBlob(key);
  if (existing) {
    touchKey(key);
    return;
  }
  await fetchAndCacheImage(key);
}

/**
 * After an upload: inject the FRESH bytes directly (no network round-trip)
 * so every mounted avatar updates instantly and the copy persists.
 */
export async function putImageBytes(path: string, blobOrBuf: Blob | ArrayBuffer | Uint8Array, mime = 'image/jpeg'): Promise<void> {
  const key = normalizeKey(path);
  if (!key) return;
  const bytes = blobOrBuf instanceof Blob ? blobOrBuf : new Blob([blobOrBuf as BlobPart], { type: mime });
  const res = new Response(bytes, { status: 200, headers: { 'Content-Type': mime } });
  await writeBlob(key, res);
  const blob = await readBlob(key);
  const url = blob ? handleFor(key, blob.bytes, blob.mime) : null;
  notify(key, url);
}

/** Drop one image (e.g. after the underlying file was deleted). */
export async function evictImage(path: string): Promise<void> {
  const key = normalizeKey(path);
  if (!key) return;
  const old = memoryHandles.get(key);
  memoryHandles.delete(key);
  memoryStore.delete(key);
  if (hasCacheStorage()) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(key);
    } catch {
      // non-fatal
    }
  }
  const idx = readIndex();
  delete idx[key];
  writeIndex(idx);
  notify(key, null);
  if (old) {
    // Revoke after a tick so in-flight paints keep working.
    setTimeout(() => {
      try {
        URL.revokeObjectURL(old);
      } catch {
        // non-fatal
      }
    }, 5000);
  }
}

/** Diagnostics + tests. */
export function imageCacheStats(): { entries: number; memoryHandles: number } {
  const idx = readIndex();
  return { entries: Object.keys(idx).length, memoryHandles: memoryHandles.size };
}
