import { useCallback, useEffect, useRef } from 'react';
import { useSync } from '@/stores/sync';

/**
 * Returns a stable callback that only invokes `fn` when the local API is reachable.
 * On Desktop, we check the sync store's `isOnline` flag instead of the Web's
 * apiClient offline tracking.
 *
 * Also returns a `consecutiveFailures` ref that callers can use for backoff.
 */
export function useOfflineAwareFetch() {
  const failuresRef = useRef(0);
  const isOnline = useSync((s) => s.isOnline);

  const guardedFetch = useCallback(async (fn: () => Promise<boolean | void>) => {
    // Fully offline — skip entirely
    if (!isOnline) return false;

    try {
      const result = await fn();
      // Success resets failure counter
      if (result !== false) failuresRef.current = 0;
      return true;
    } catch {
      failuresRef.current++;
      return false;
    }
  }, [isOnline]);

  return { guardedFetch, failuresRef };
}

/**
 * Get the current backoff interval based on failure count.
 * 0 failures → normalInterval
 * 1-2 failures → 2x
 * 3-4 failures → 4x
 * 5+ failures → 6x (capped)
 */
export function getBackoffInterval(normalIntervalMs: number, failures: number): number {
  if (failures <= 0) return normalIntervalMs;
  if (failures <= 2) return normalIntervalMs * 2;
  if (failures <= 4) return normalIntervalMs * 4;
  return Math.min(normalIntervalMs * 6, 300_000); // Cap at 5 minutes
}

/**
 * Check if we should skip polling entirely because the local API is unreachable.
 * On Desktop, this checks the sync store's `isOnline` flag.
 */
export function shouldSkipPoll(): boolean {
  return !useSync.getState().isOnline;
}

/**
 * Check if the cloud is unreachable (via sync store).
 * On Desktop, the local API handles cloud sync, so "cloud down" means
 * the sync service reports errors or is not syncing.
 */
export function isCloudDown(): boolean {
  const state = useSync.getState();
  return !state.isOnline || !!state.lastError;
}
