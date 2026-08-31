'use client';

import { useCallback, useEffect, useRef } from 'react';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';

/**
 * Returns a stable callback that only invokes `fn` when the API is reachable.
 * - If both cloud and LAN are unreachable, the call is skipped entirely.
 * - If only cloud is unreachable (LAN may work), the call proceeds (LAN handles it).
 *
 * Also returns a `consecutiveFailures` ref that callers can use for backoff.
 */
export function useOfflineAwareFetch() {
  const failuresRef = useRef(0);

  const guardedFetch = useCallback(async (fn: () => Promise<boolean | void>) => {
    // Fully offline — skip entirely
    if (isBothUnreachable()) return false;

    try {
      const result = await fn();
      // Success resets failure counter
      if (result !== false) failuresRef.current = 0;
      return true;
    } catch {
      failuresRef.current++;
      return false;
    }
  }, []);

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
 * Check if we should skip polling entirely because both APIs are unreachable.
 */
export function shouldSkipPoll(): boolean {
  return isBothUnreachable();
}

/**
 * Check if cloud is unreachable (but LAN may still work).
 */
export function isCloudDown(): boolean {
  return isApiUnreachable();
}
