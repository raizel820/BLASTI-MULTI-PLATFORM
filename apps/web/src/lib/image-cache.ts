'use client';

/**
 * BLASTI Image Cache — persistent LRU cache for remote images (Task 85).
 *
 * WHY: the app is a hash-based SPA — every view switch unmounts/remounts the
 * avatar components, so each <img> re-requests its URL. The upload endpoints
 * send `Cache-Control: immutable, max-age=1y`, but on Capacitor WebViews and
 * Electron windows the HTTP cache is frequently bypassed (origin changes,
 * mixed-content re-fetches, native fallbacks) — users saw the avatar flash
 * back to a placeholder for seconds on EVERY page navigation.
 *
 * This module gives every remote image a synchronous in-memory layer plus a
 * persistent IndexedDB layer:
 *   1. Memory Map  — instant data-URL paint on remount (no network at all).
 *   2. IndexedDB   — survives full app restarts; LRU-capped to bound storage.
 *
 * Design rules:
 *  - Never throws: every accessor resolves null on any failure.
 *  - Keys are the CANONICAL url (cache-busters like ?r=N stripped) so retry
 *    variants share one cache slot.
 *  - Entries are data: URLs — they render even fully offline.
 *  - Only small images (<= MAX_ENTRY_BYTES) are cached; oversized ones are
 *    skipped silently and simply stay on the normal network path.
 */

const DB_NAME = 'blasti-image-cache';
const DB_VERSION = 1;
const STORE_NAME = 'images';

/** Cache at most this many images (LRU-evicted). */
const MAX_ENTRIES = 150;
/** Never cache images bigger than this (keeps IndexedDB lean). */
export const MAX_ENTRY_BYTES = 1_500_000;

interface ImageEntry {
  dataUrl: string;
  bytes: number;
  cachedAt: number;
  lastHitAt: number;
}

// ─── Memory layer (synchronous, survives view switches) ──────────────────────

const memory = new Map<string, ImageEntry>();

function memTouch(key: string, entry: ImageEntry): void {
  // Re-insert to keep Map iteration order = recency order (LRU).
  memory.delete(key);
  entry.lastHitAt = Date.now();
  memory.set(key, entry);
  while (memory.size > MAX_ENTRIES) {
    const oldestKey = memory.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    memory.delete(oldestKey);
  }
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

function idbGet(key: string): Promise<ImageEntry | null> {
  return openDb().then(
    (db) =>
      new Promise<ImageEntry | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).get(key);
          req.onsuccess = () => resolve((req.result as ImageEntry) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function idbSet(key: string, entry: ImageEntry): Promise<void> {
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

function idbKeys(): Promise<string[]> {
  return openDb().then(
    (db) =>
      new Promise<string[]>((resolve) => {
        if (!db) return resolve([]);
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).getAllKeys();
          req.onsuccess = () => resolve((req.result as string[]) ?? []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      }),
  );
}

function idbDelete(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        } catch {
          resolve();
        }
      }),
  );
}

// ─── Keys ─────────────────────────────────────────────────────────────────────

/**
 * Canonical cache key for an image URL: strips cache-busters (?r=N) and the
 * hash fragment so retry variants share one cache slot.
 */
export function canonicalImageUrl(url: string): string {
  try {
    const withoutHash = url.split('#')[0];
    if (!withoutHash.includes('?')) return withoutHash;
    const [base, query] = withoutHash.split('?');
    if (!query) return base;
    const params = new URLSearchParams(query);
    params.delete('r');
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  } catch {
    return url.split('#')[0];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Synchronous memory read — returns the cached data: URL when the image was
 * already seen this session. Safe during render (pure Map lookup).
 */
export function peekImage(url: string): string | null {
  if (!url || typeof window === 'undefined') return null;
  const key = canonicalImageUrl(url);
  const entry = memory.get(key);
  if (!entry) return null;
  memTouch(key, entry);
  return entry.dataUrl;
}

/** Async read: memory first, then IndexedDB (which re-hydrates the memory layer). */
export async function getImage(url: string): Promise<string | null> {
  if (!url || typeof window === 'undefined') return null;
  const key = canonicalImageUrl(url);
  const mem = memory.get(key);
  if (mem) {
    memTouch(key, mem);
    return mem.dataUrl;
  }
  const entry = await idbGet(key);
  if (!entry?.dataUrl) return null;
  memTouch(key, entry);
  return entry.dataUrl;
}

/** Persist an image (data: URL). Never throws. */
export async function putImage(url: string, dataUrl: string): Promise<void> {
  if (!url || !dataUrl || typeof window === 'undefined') return;
  if (!dataUrl.startsWith('data:')) return; // only data URLs are storable
  if (dataUrl.length > MAX_ENTRY_BYTES) return; // oversized — skip silently
  const key = canonicalImageUrl(url);
  const bytes = Math.round((dataUrl.length * 3) / 4);
  const entry: ImageEntry = { dataUrl, bytes, cachedAt: Date.now(), lastHitAt: Date.now() };
  memTouch(key, entry);
  await idbSet(key, entry);
  void pruneImages();
}

/** True when the canonical URL is already cached (memory OR IndexedDB). */
export async function hasImage(url: string): Promise<boolean> {
  if (!url) return false;
  if (peekImage(url)) return true;
  const key = canonicalImageUrl(url);
  const entry = await idbGet(key);
  return !!entry?.dataUrl;
}

/**
 * Download an image over the network and persist it. Used by <img onLoad>
 * handlers — the download usually hits the browser HTTP cache (immutable
 * upload URLs), so it costs nothing after the first view.
 */
export async function captureImage(url: string): Promise<void> {
  if (!url || typeof window === 'undefined') return;
  if (!/^https?:/i.test(url)) return; // data:/blob: are already local
  if (peekImage(url)) return;
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!res.ok) return;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_ENTRY_BYTES) return;
    const dataUrl = await new Promise<string | null>((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      } catch {
        resolve(null);
      }
    });
    if (dataUrl) await putImage(url, dataUrl);
  } catch {
    // CORS/network failure — the <img> itself may still render normally.
  }
}

/** LRU-evict the persistent store down to MAX_ENTRIES. */
export async function pruneImages(): Promise<void> {
  try {
    const keys = await idbKeys();
    if (keys.length <= MAX_ENTRIES) return;
    // Read all entries (small data URLs — acceptable once per put).
    const entries: Array<{ key: string; lastHitAt: number }> = [];
    for (const key of keys) {
      const entry = await idbGet(key);
      if (!entry) {
        await idbDelete(key); // drop corrupt rows
        continue;
      }
      entries.push({ key, lastHitAt: entry.lastHitAt ?? 0 });
    }
    entries.sort((a, b) => a.lastHitAt - b.lastHitAt);
    const excess = entries.length - MAX_ENTRIES;
    for (let i = 0; i < excess; i++) await idbDelete(entries[i].key);
  } catch {
    // non-fatal
  }
}

/** Clear the whole image cache (logout, storage pressure, debugging). */
export async function clearImageCache(): Promise<void> {
  memory.clear();
  try {
    const keys = await idbKeys();
    for (const key of keys) await idbDelete(key);
  } catch {
    // non-fatal
  }
}
