'use client';

/**
 * BLASTI Service Worker Registration Helper
 *
 * Provides utilities to register, manage, and communicate with the
 * BLASTI service worker (`/sw.js`).  All functions are SSR-safe and
 * silently no-op when running outside the browser.
 */

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

/** Callback signature for SW lifecycle events. */
type SWEventCallback = (registration: ServiceWorkerRegistration) => void;

// ────────────────────────────────────────────────────────────────────────
// Internal state
// ────────────────────────────────────────────────────────────────────────

const SW_URL = '/sw.js';

/** Resolve when the very first registration succeeds (or rejects). */
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Callbacks queued before the SW is ready. */
const updateCallbacks: SWEventCallback[] = [];
const offlineReadyCallbacks: SWEventCallback[] = [];

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const isBrowser = typeof window !== 'undefined';

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Register the BLASTI service worker.
 *
 * - If registration is already in-flight or completed, reuses the cached
 *   promise so we never double-register.
 * - Attaches update & controller-change listeners that flush the
 *   `onUpdate` / `onOfflineReady` callback queues.
 *
 * @returns The `ServiceWorkerRegistration`, or `null` when unavailable.
 */
export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!isBrowser || !('serviceWorker' in navigator)) return null;

  // Return the in-flight or cached registration if available.
  if (registrationPromise) return registrationPromise;

  registrationPromise = navigator.serviceWorker
    .register(SW_URL, { scope: '/' })
    .then((registration) => {
      // ── Listen for a waiting worker (update available) ──
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // A new version is waiting — notify subscribers.
            updateCallbacks.forEach((cb) => cb(registration));
          }
        });
      });

      // ── Listen for controller change (new SW activated) ──
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        // Notify offline-ready subscribers.
        offlineReadyCallbacks.forEach((cb) => cb(registration));
      });

      // If there's already a waiting worker on first load, fire onUpdate.
      if (registration.waiting) {
        updateCallbacks.forEach((cb) => cb(registration));
      }

      // If there's already an active controller, the app is offline-ready.
      if (navigator.serviceWorker.controller) {
        offlineReadyCallbacks.forEach((cb) => cb(registration));
      }

      return registration;
    })
    .catch((error) => {
      console.warn('[BLASTI SW] Registration failed:', error);
      return null;
    });

  return registrationPromise;
}

/**
 * Return the current service worker registration (if any) without
 * triggering a new registration.
 */
export async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isBrowser || !('serviceWorker' in navigator)) return null;

  // Reuse the cached promise if we already registered.
  if (registrationPromise) return registrationPromise;

  return navigator.serviceWorker.getRegistration(SW_URL);
}

/**
 * Tell the waiting service worker to skip the waiting queue and
 * activate immediately.
 *
 * The page will reload automatically once the new worker takes over
 * (handled by the `controllerchange` listener in `registerSW`).
 */
export async function skipWaiting(): Promise<void> {
  const registration = await getRegistration();
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

/**
 * Subscribe to service worker update events.
 *
 * The callback fires whenever a new version of the service worker
 * is downloaded and enters the `installed` (waiting) state.
 *
 * If an update is already waiting when the listener is attached,
 * the callback fires immediately.
 */
export function onUpdate(callback: SWEventCallback): () => void {
  updateCallbacks.push(callback);

  // If we already have a waiting worker, fire right away.
  if (registrationPromise) {
    registrationPromise.then((reg) => {
      if (reg?.waiting) callback(reg);
    });
  }

  // Return an unsubscribe function.
  return () => {
    const idx = updateCallbacks.indexOf(callback);
    if (idx !== -1) updateCallbacks.splice(idx, 1);
  };
}

/**
 * Subscribe to the "offline ready" event.
 *
 * Fires when a service worker controller is first available or
 * when a newly activated worker takes control (after `skipWaiting`).
 *
 * If the app is already controlled by a service worker at subscription
 * time, the callback fires immediately.
 */
export function onOfflineReady(callback: SWEventCallback): () => void {
  offlineReadyCallbacks.push(callback);

  // If we already have a controller, fire right away.
  if (isBrowser && navigator.serviceWorker?.controller) {
    getRegistration().then((reg) => {
      if (reg) callback(reg);
    });
  }

  // Return an unsubscribe function.
  return () => {
    const idx = offlineReadyCallbacks.indexOf(callback);
    if (idx !== -1) offlineReadyCallbacks.splice(idx, 1);
  };
}

/**
 * Request a background sync via the service worker.
 *
 * Sends a `SYNC` message to the active service worker which should
 * handle replaying the offline mutation queue.
 */
export async function requestSync(tag: string = 'blasti-offline-sync'): Promise<void> {
  if (!isBrowser || !navigator.serviceWorker?.controller) return;

  try {
    // Try the native Background Sync API first (if available).
    const registration = await getRegistration();
    if (registration && 'sync' in registration) {
      await (registration as any).sync.register(tag);
      return;
    }

    // Fallback: post a message to the SW.
    navigator.serviceWorker.controller.postMessage({ type: 'SYNC', tag });
  } catch (error) {
    console.warn('[BLASTI SW] Background sync request failed:', error);
  }
}

/**
 * One-shot initialiser that registers the service worker.
 *
 * Designed to be called from a `useEffect` or top-level async IIFE.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initSW(): Promise<ServiceWorkerRegistration | null> {
  return registerSW();
}

// ────────────────────────────────────────────────────────────────────────
// Auto-register (safe for client-side ESM imports)
// ────────────────────────────────────────────────────────────────────────

// We intentionally do NOT call registerSW() at module-scope because
// Next.js may evaluate this module on the server during SSR / build.
// Instead, the consumer should call `initSW()` inside a `useEffect`.
// The function is idempotent so multiple calls are harmless.
