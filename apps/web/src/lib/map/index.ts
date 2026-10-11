/**
 * Map provider factory (Task 51-b, spec §4/§9/§33).
 *
 * `createMapProvider` builds the provider instance the Super Admin selected;
 * `isProviderAvailable` reports whether the CURRENT config can actually
 * render (GOOGLE chosen but no JS key → not available — spec §10).
 *
 * Fallback behavior (spec §33): when the selected provider is not available
 * and a different fallbackProvider is configured and available, the factory
 * falls through to it so the UI keeps working after provider switching.
 */
import { createGoogleMapsProvider } from './google-provider';
import { createOpenFreeMapProvider } from './openfreemap-provider';
import {
  COUNTRY_ZOOM,
  DEFAULT_MAP_CENTER,
  MARKER_ZOOM,
} from './types';
import type {
  LatLng,
  MapConfig,
  MapInitOptions,
  MapProviderId,
  MapProviderInstance,
  MapsProviderSettings,
} from './types';

// Re-export the surface other modules consume, so callers can import from
// '@/lib/map' only.
export type {
  LatLng,
  MapConfig,
  MapInitOptions,
  MapProviderId,
  MapProviderInstance,
  MapsProviderSettings,
} from './types';
export { DEFAULT_MAP_CENTER, COUNTRY_ZOOM, MARKER_ZOOM, isValidLatLng } from './types';
export { createGoogleMapsProvider, loadGoogleMaps } from './google-provider';
export { createOpenFreeMapProvider, loadMaplibre } from './openfreemap-provider';
export { reverseGeocode, type GeocodeComponents, type ReverseGeocodeResult } from './geocoding';
export { buildDirectionsUrl, openDirections, type DirectionsSettings } from './directions';

/**
 * Can the given provider render with the current config?
 * - GOOGLE needs a JS API key (a script without a key renders a grey map +
 *   console spam, which reads as "BLASTI is broken");
 * - OPENFREEMAP needs a style URL (falls back to the public Liberty style
 *   inside the provider, so it is available whenever maplibre can load).
 */
export function isProviderAvailable(config: MapConfig, provider: MapProviderId = config.provider): boolean {
  if (provider === 'GOOGLE') {
    return typeof config.google?.jsApiKey === 'string' && config.google.jsApiKey.length > 0;
  }
  if (provider === 'OPENFREEMAP') {
    return typeof config.openfreemap?.styleUrl === 'string' && config.openfreemap.styleUrl.length > 0;
  }
  return false;
}

/**
 * Create the map provider for `config`, honoring a resilience chain:
 *
 *   1. the Super-Admin SELECTED provider (when it can render),
 *   2. the configured fallbackProvider (spec §33),
 *   3. the OTHER provider as a last resort (field-fix: a broken Google key
 *      — or an unreachable tiles.openfreemap.org — must not leave owners a
 *      dead grey map; whichever provider CAN render takes over).
 *
 * The returned instance tries each candidate's `init()` in order on the SAME
 * container until one genuinely renders; every method call is delegated to
 * the candidate that won. `provider` reflects the active candidate, so the
 * location-source recorded by the picker is the one that actually rendered.
 */
export function createMapProvider(config: MapConfig): MapProviderInstance | null {
  const candidates: MapProviderInstance[] = [];
  const push = (id: MapProviderId) => {
    if (candidates.some((c) => c.provider === id)) return;
    if (!isProviderAvailable(config, id)) return;
    candidates.push(
      id === 'GOOGLE'
        ? createGoogleMapsProvider({ apiKey: config.google.jsApiKey ?? null })
        : createOpenFreeMapProvider({ styleUrl: config.openfreemap.styleUrl }),
    );
  };

  push(config.provider);
  if (config.fallbackProvider !== 'NONE') push(config.fallbackProvider);
  // Resilience tier — the other provider, even when NOT configured as the
  // fallback. Order matters: selected → configured fallback → other.
  push(config.provider === 'GOOGLE' ? 'OPENFREEMAP' : 'GOOGLE');

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  return createFallbackChainProvider(candidates);
}

/**
 * Wrap N provider instances so `init()` falls through to the next candidate
 * whenever one fails (bad key, unreachable tiles, WebGL missing, timeout).
 * Interaction callbacks registered BEFORE init are replayed onto whichever
 * candidate wins — components register handlers before calling init.
 */
function createFallbackChainProvider(candidates: MapProviderInstance[]): MapProviderInstance {
  let active: MapProviderInstance | null = null;
  let clickCb: ((ll: LatLng) => void) | null = null;
  let moveCb: ((ll: LatLng) => void) | null = null;

  const applyCallbacks = () => {
    if (!active) return;
    if (clickCb) active.onMapClick(clickCb);
    if (moveCb) active.onMarkerMove(moveCb);
  };

  return {
    get provider(): MapProviderId {
      return (active ?? candidates[0]).provider;
    },

    async init(container: HTMLElement, opts?: MapInitOptions): Promise<void> {
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          await candidate.init(container, opts);
          active = candidate;
          applyCallbacks();
          return;
        } catch (err) {
          lastError = err;
          try { candidate.destroy(); } catch { /* already dead */ }
          // Scrub any half-constructed provider DOM (grey Google shell,
          // dead maplibre canvas) so the next candidate starts clean.
          try { container.innerHTML = ''; } catch { /* non-critical */ }
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error('MAP_PROVIDER_CHAIN_FAILED: every provider failed');
    },

    setCenter(ll: LatLng): void { active?.setCenter(ll); },
    setZoom(zoom: number): void { active?.setZoom(zoom); },
    placeMarker(ll: LatLng): void { active?.placeMarker(ll); },
    moveMarker(ll: LatLng): void { active?.moveMarker(ll); },
    onMapClick(cb: (ll: LatLng) => void): void { clickCb = cb; active?.onMapClick(cb); },
    onMarkerMove(cb: (ll: LatLng) => void): void { moveCb = cb; active?.onMarkerMove(cb); },
    getCoordinates(): LatLng | null { return active ? active.getCoordinates() : null; },
    showMarkerInfo(title: string, description?: string): void {
      active?.showMarkerInfo?.(title, description);
    },
    resize(): void { active?.resize?.(); },

    destroy(): void {
      clickCb = null;
      moveCb = null;
      for (const candidate of candidates) {
        try { candidate.destroy(); } catch { /* ignore */ }
      }
      active = null;
    },
  };
}

/** Convenience: default init options for a coordinate-aware view. */
export function mapInitOptionsFor(center: LatLng | null): MapInitOptions {
  return center
    ? { center, zoom: MARKER_ZOOM }
    : { center: DEFAULT_MAP_CENTER, zoom: COUNTRY_ZOOM };
}

/** Settings-provider settings type re-exported for hook consumers. */
export type { MapsProviderSettings as MapsConfig };
