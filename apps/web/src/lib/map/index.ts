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
 * Create the map provider for `config`, honoring the fallback chain:
 * selected provider → configured fallback → nothing (null).
 */
export function createMapProvider(config: MapConfig): MapProviderInstance | null {
  if (isProviderAvailable(config, config.provider)) {
    if (config.provider === 'GOOGLE') {
      return createGoogleMapsProvider({ apiKey: config.google.jsApiKey ?? null });
    }
    return createOpenFreeMapProvider({ styleUrl: config.openfreemap.styleUrl });
  }

  // Spec §33 — fall through to the configured fallback provider.
  if (config.fallbackProvider !== 'NONE' && isProviderAvailable(config, config.fallbackProvider)) {
    if (config.fallbackProvider === 'GOOGLE') {
      return createGoogleMapsProvider({ apiKey: config.google.jsApiKey ?? null });
    }
    return createOpenFreeMapProvider({ styleUrl: config.openfreemap.styleUrl });
  }

  return null;
}

/** Convenience: default init options for a coordinate-aware view. */
export function mapInitOptionsFor(center: LatLng | null): MapInitOptions {
  return center
    ? { center, zoom: MARKER_ZOOM }
    : { center: DEFAULT_MAP_CENTER, zoom: COUNTRY_ZOOM };
}

/** Settings-provider settings type re-exported for hook consumers. */
export type { MapsProviderSettings as MapsConfig };
