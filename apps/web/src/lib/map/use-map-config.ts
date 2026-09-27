'use client';

/**
 * useMapConfig — fetches GET /api/config/maps (Task 51-a contract) through
 * the shared api-client (NEVER raw fetch) with a module-level cache and a
 * 60s TTL so many map surfaces on one page share a single request.
 *
 * Envelope tolerance: api-client's parseResponse auto-unwraps
 * `{ success, data }` bodies, but readers must tolerate ALL observable
 * outcomes —
 *   1. MapsProviderSettings            (already unwrapped by api-client)
 *   2. { success, data: settings }     (dual envelope that escaped unwrapping)
 *   3. { data: settings }              (bare envelope)
 *   4. { success: false, error }       (API responded with a logical error)
 * plus the ApiClientError thrown for 4xx/5xx/network (status 0 = offline).
 * Any failure resolves to `config: null` — every consumer renders the
 * graceful "map unavailable" state (spec §40) instead of crashing.
 */
import { useEffect, useState } from 'react';
import { apiClient, ApiClientError } from '@/lib/api-client';
import type { MapsProviderSettings } from './types';

const CONFIG_TTL_MS = 60_000;

interface MapConfigCache {
  config: MapsProviderSettings | null;
  fetchedAt: number;
}

let cache: MapConfigCache | null = null;
let inflight: Promise<MapsProviderSettings | null> | null = null;

/**
 * Accepts every envelope outcome documented above and returns the settings
 * object, or null when the payload is not a recognizable maps config.
 * Exported for the settings-UI agent to reuse the same tolerance.
 */
export function normalizeMapsConfigPayload(raw: unknown): MapsProviderSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const looksLikeConfig = (v: unknown): v is MapsProviderSettings => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const c = v as Record<string, unknown>;
    return (
      (c.provider === 'GOOGLE' || c.provider === 'OPENFREEMAP') &&
      typeof c.mapsEnabled === 'boolean' &&
      typeof c.directionsEnabled === 'boolean'
    );
  };

  // Outcomes 1: direct settings object.
  if (looksLikeConfig(obj)) return obj;

  // Outcomes 2/3: settings nested under `data` (envelope escaped the
  // api-client auto-unwrap, e.g. >3 top-level keys).
  if ('data' in obj && looksLikeConfig(obj.data)) return obj.data as MapsProviderSettings;

  // Outcome 4 handled implicitly: { success: false } has no recognizable
  // settings → null.
  return null;
}

async function fetchMapsConfig(): Promise<MapsProviderSettings | null> {
  if (!inflight) {
    inflight = (async () => {
      try {
        // Short timeout + no retries: the config must never block the UI —
        // map surfaces degrade to the offline/address-only state instead.
        const res = await apiClient.get<unknown>('/api/config/maps', {
          timeout: 6000,
          retries: 0,
        });
        const config = normalizeMapsConfigPayload(res.data);
        cache = { config, fetchedAt: Date.now() };
        return config;
      } catch (err) {
        // 404 (backend not upgraded yet), 401, offline (status 0), …
        if (!(err instanceof ApiClientError)) {
          console.warn('[useMapConfig] unexpected error', err);
        }
        // Negative cache for half the TTL so offline users don't refetch
        // on every mount.
        cache = { config: null, fetchedAt: Date.now() - CONFIG_TTL_MS / 2 };
        return null;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

export interface UseMapConfigResult {
  /** Maps settings, or null while loading / when unavailable. */
  config: MapsProviderSettings | null;
  loading: boolean;
  /** Human-readable failure (never shown directly — use i18n keys). */
  error: string | null;
}

/**
 * Subscribe to the shared maps config with a 60s TTL.
 * Mount-safe: multiple components share one request and one cache.
 */
export function useMapConfig(): UseMapConfigResult {
  const [state, setState] = useState<UseMapConfigResult>(() => ({
    config: cache?.config ?? null,
    loading: !cache || Date.now() - cache.fetchedAt >= CONFIG_TTL_MS,
    error: null,
  }));

  useEffect(() => {
    let cancelled = false;

    const fresh = cache && Date.now() - cache.fetchedAt < CONFIG_TTL_MS;
    if (fresh && cache) {
      setState({ config: cache.config, loading: false, error: null });
      return;
    }

    setState((prev) => ({ ...prev, loading: true }));
    fetchMapsConfig().then((config) => {
      if (cancelled) return;
      setState({
        config,
        loading: false,
        error: config ? null : 'MAPS_CONFIG_UNAVAILABLE',
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
