'use client';
/**
 * Task 82 — customer location hook for estimated distances.
 *
 * Deliberately CONSERVATIVE about privacy/prompting: the user asked for
 * distance estimates only "when location access is available". So:
 *   • Web: the position is fetched ONLY when the Permissions API reports
 *     'granted'. 'prompt' → we never nag with a system dialog; 'denied' →
 *     status 'denied', no distance shown.
 *   • Capacitor (mobile app): the Geolocation plugin's checkPermissions is
 *     consulted the same way — granted → fetch, otherwise stay silent.
 *   • The position is cached module-level for 5 minutes so navigating
 *     between home / profile / favorites never re-triggers the GPS.
 */
import { useEffect, useState } from 'react';
import { nativeBridge } from '@/lib/native-bridge';
import type { LatLng } from '@/lib/geo';

export type CustomerLocationStatus =
  | 'idle' // no permission decision — nothing requested, no distance
  | 'pending' // fetching
  | 'ready' // position available
  | 'denied' // permission denied
  | 'unavailable'; // no geolocation capability / failed

interface CustomerLocationState {
  position: LatLng | null;
  status: CustomerLocationStatus;
}

// ─── Module cache (shared across all hook consumers) ────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedPosition: LatLng | null = null;
let cachedAt = 0;
let inflight: Promise<CustomerLocationState> | null = null;

function isCapacitorNative(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

/** Ask the platform whether location permission is ALREADY granted. */
async function isLocationPermissionGranted(): Promise<boolean | null> {
  // null = cannot determine (old browsers) — treat as not granted, no prompt.
  try {
    if (isCapacitorNative()) {
      const cap = (window as unknown as {
        Capacitor?: {
          Plugins?: Record<string, { checkPermissions?: () => Promise<{ location?: string }> }>;
        };
      }).Capacitor;
      const geo = cap?.Plugins?.Geolocation;
      if (geo?.checkPermissions) {
        const res = await geo.checkPermissions();
        return res?.location === 'granted';
      }
      // Plugin API unavailable → let the OS decide on fetch; conservatively false.
      return false;
    }
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      const res = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
      return res.state === 'granted';
    }
  } catch {
    /* permission API failed — treat as not granted */
  }
  return false;
}

async function fetchLocationState(force = false): Promise<CustomerLocationState> {
  if (!force && cachedPosition && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { position: cachedPosition, status: 'ready' };
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<CustomerLocationState> => {
    const granted = await isLocationPermissionGranted();
    if (!granted) {
      return { position: null, status: 'idle' };
    }
    try {
      const pos = await nativeBridge.getCurrentPosition();
      if (pos) {
        cachedPosition = { lat: pos.lat, lng: pos.lng };
        cachedAt = Date.now();
        return { position: cachedPosition, status: 'ready' };
      }
      return { position: null, status: 'unavailable' };
    } catch {
      return { position: null, status: 'unavailable' };
    }
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * One-shot customer location with permission gating + shared cache.
 * Re-runs only when `enabled` toggles false→true (new fetch attempt).
 */
export function useCustomerLocation(enabled = true): CustomerLocationState {
  const [state, setState] = useState<CustomerLocationState>(() =>
    cachedPosition ? { position: cachedPosition, status: 'ready' } : { position: null, status: 'idle' },
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    if (cachedPosition && Date.now() - cachedAt < CACHE_TTL_MS) {
      setState({ position: cachedPosition, status: 'ready' });
      return;
    }
    setState((prev) => (prev.status === 'ready' ? prev : { position: null, status: 'pending' }));
    fetchLocationState().then((res) => {
      if (!cancelled) setState(res);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
