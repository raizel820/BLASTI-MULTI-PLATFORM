'use client';

/**
 * cache-1: boot/login cache warm-up.
 *
 * "Shouldn't all data sync and cache when launching?" — on desktop that has
 * always been true (the local API's staged 21-model initial import). The web
 * + mobile bundle now gets the same treatment at the REQUEST level: right
 * after boot/login we prefetch the role's core endpoints through the ApiClient,
 * so they land in the completed-GET cache and every first navigation paints
 * instantly instead of waiting on the network. Fire-and-forget: a failed
 * warm-up must never block or break the session (the regular fetch paths
 * still work).
 */

import { apiClient } from './api-client';
import { preloadImage } from './image-cache';

/** One warm-up per N ms — login + boot + focus events can stack. */
let lastWarmAt = 0;
const WARM_THROTTLE_MS = 60_000;

/**
 * Prefetch the current user's core dataset + avatar into the caches.
 * Reads the session straight from localStorage-ish sources via the auth
 * header builder — safe to call before/after hydration.
 */
export function warmCoreCaches(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastWarmAt < WARM_THROTTLE_MS) return;
  lastWarmAt = now;

  void (async () => {
    try {
      // Resolve the session user lazily — importing the store statically here
      // would widen this module's dependency graph into every chunk.
      const { useAppStore } = await import('../store/use-app-store');
      const user = useAppStore.getState().user;
      if (!user) return;

      const role = user.role;
      const paths: string[] = [];

      if (role === 'CUSTOMER') {
        paths.push(
          '/api/agencies',
          '/api/user/notifications?take=20',
          '/api/reservations',
        );
      } else if (role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF') {
        paths.push(
          '/api/agency/stats',
          '/api/agency/services',
          '/api/agency/queue',
          '/api/agency/branches',
          '/api/user/notifications?take=20',
        );
      } else if (role === 'SUPER_ADMIN') {
        paths.push(
          '/api/stats',
          '/api/user/notifications?take=20',
        );
      }

      apiClient.warmCache(paths);

      // Warm the avatar bytes too — kills the last "placeholder flash" on the
      // very first navigation after login.
      const avatar = user.avatarUrl;
      if (avatar && (avatar.startsWith('/') || /^https?:/i.test(avatar))) {
        void preloadImage(avatar);
      }
    } catch {
      // best-effort warm-up — never surfaces
    }
  })();
}
