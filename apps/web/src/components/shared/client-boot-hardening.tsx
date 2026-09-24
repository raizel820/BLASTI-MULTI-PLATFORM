'use client';

/**
 * BLASTI Client Boot Hardening (Task 41)
 *
 * Two independent heals that run once per page load:
 *
 * 1. LEGACY SERVICE-WORKER CLEANUP
 *    Older builds of the app shipped public/sw.js (cache-first static caching
 *    with a 30-day TTL) and registered it. The current source no longer
 *    registers any service worker — but a SW already installed on a device
 *    keeps controlling the origin forever until it is explicitly
 *    unregistered. On phones this stale SW served DEV HTML that referenced
 *    Turbopack chunk URLs from a previous build → the chunks 404'd →
 *    ChunkLoadError → error-boundary/Suspense swap loop → the UI kept
 *    flickering and lazy sections appeared/disappeared.
 *    Fix: unregister every SW on this origin and purge the blasti-* Cache
 *    Storage buckets it left behind. Cheap no-op on clean devices.
 *
 * 2. CHUNK-LOAD-ERROR AUTO-RECOVERY
 *    In dev, Turbopack invalidates old chunk URLs on every recompile; a
 *    long-lived tab (or an SW-cached HTML page on a phone) can then request
 *    chunks that no longer exist. React 18 surfaces those as unhandled
 *    rejections (ChunkLoadError) and the nearest error boundary/Suspense
 *    swaps content in and out — the "components appear and disappear"
 *    flicker. A single bounded reload picks up the fresh HTML+chunk manifest
 *    and heals the session. The sessionStorage cooldown guarantees at most
 *    ONE automatic reload per 15 s so a persistent failure shows the error
 *    UI instead of reload-looping.
 */

import { useEffect } from 'react';

const CHUNK_RELOAD_KEY = 'blasti-chunk-reload-at';
const CHUNK_RELOAD_COOLDOWN_MS = 15000;

function isChunkLoadErrorMessage(message: string): boolean {
  return /ChunkLoadError|Failed to load chunk|Loading chunk \d+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(message);
}

export function ClientBootHardening() {
  useEffect(() => {
    // ── 1. Legacy service worker cleanup ──────────────────────────────────
    (async () => {
      try {
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (const reg of registrations) {
            try {
              await reg.unregister();
            } catch { /* best-effort */ }
          }
          if (registrations.length > 0) {
            console.log('[BootHardening] Unregistered', registrations.length, 'legacy service worker(s)');
          }
        }
        // Purge the cache buckets the legacy sw.js owned (blasti-static-v1,
        // blasti-api-v1, ...). Only blasti-prefixed caches are touched.
        if (typeof caches !== 'undefined') {
          const keys = await caches.keys();
          const stale = keys.filter((k) => k.startsWith('blasti-'));
          await Promise.all(stale.map((k) => caches.delete(k).catch(() => {})));
          if (stale.length > 0) {
            console.log('[BootHardening] Purged legacy caches:', stale.join(', '));
          }
        }
      } catch { /* hardened boot must never throw */ }
    })();

    // ── 2. Chunk-load-error auto-recovery (one bounded reload) ────────────
    const maybeReload = (rawMessage: string) => {
      if (!rawMessage || !isChunkLoadErrorMessage(rawMessage)) return;
      try {
        const last = parseInt(sessionStorage.getItem(CHUNK_RELOAD_KEY) || '0', 10);
        if (Number.isFinite(last) && Date.now() - last < CHUNK_RELOAD_COOLDOWN_MS) {
          console.warn('[BootHardening] Chunk load failed again — leaving recovery to the error UI');
          return;
        }
        sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
      } catch {
        // Storage blocked — still allow the single recovery reload
      }
      console.warn('[BootHardening] Chunk failed to load — auto-reloading once:', rawMessage);
      window.location.reload();
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event?.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? '');
      maybeReload(message);
    };
    const onErrorEvent = (event: ErrorEvent) => {
      const fromErrorObj = event?.error instanceof Error ? event.error.message : '';
      maybeReload(fromErrorObj || event?.message || '');
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('error', onErrorEvent);
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('error', onErrorEvent);
    };
  }, []);

  return null;
}
