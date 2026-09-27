/**
 * Map provider abstraction — shared types (Task 51-b, spec §4).
 *
 * The map layer is provider-independent: BLASTI renders either Google Maps or
 * OpenFreeMap (MapLibre) through the same `MapProviderInstance` interface, so
 * agency-location code never branches on the provider (spec §4 — "Do not
 * duplicate Agency business logic for Google and OpenFreeMap").
 *
 * Reverse geocoding is deliberately NOT part of this interface — OpenFreeMap
 * is a map provider, not a geocoding service (spec §6). See `geocoding.ts`.
 */

/** Canonical geographic coordinate (WGS84 decimal degrees). */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Options accepted by `MapProviderInstance.init`. */
export interface MapInitOptions {
  /** Initial map center. Defaults to a country-level view of Algeria. */
  center?: LatLng;
  /** Initial zoom. Providers clamp to their supported ranges. */
  zoom?: number;
}

/** Which visual map provider an instance/config refers to. */
export type MapProviderId = 'GOOGLE' | 'OPENFREEMAP';

/** Shape of GET /api/config/maps → data (Task 51-a contract). */
export interface MapsProviderSettings {
  provider: MapProviderId;
  fallbackProvider: 'NONE' | MapProviderId;
  mapsEnabled: boolean;
  directionsEnabled: boolean;
  openfreemap: { styleUrl: string };
  google: { configured: boolean; geocodingEnabled: boolean; jsApiKey: string | null };
  geocoding: { provider: 'GOOGLE' | 'OSM' };
  directions: {
    destinationMode: 'COORDINATES' | 'COORDINATES_AND_ADDRESS';
    origin: 'CURRENT_LOCATION' | 'NONE';
    openBehavior: 'AUTO' | 'APP' | 'WEB';
    buttonLabel: string | null;
  };
}

/** Alias matching the settings-UI naming (`MapConfig`). */
export type MapConfig = MapsProviderSettings;

/**
 * Provider-independent map handle.
 *
 * Lifecycle: `init()` once per container, then any order of the interaction
 * methods, then `destroy()` on unmount. All methods are no-op-safe before
 * `init()` resolves; `init()` rejects when the provider cannot load (offline,
 * missing key, tiles unreachable) so callers can fall back to the
 * address-only UI (spec §40).
 */
export interface MapProviderInstance {
  /** The provider that created this instance. */
  readonly provider: MapProviderId;

  /** Mount the map into `container` and resolve when tiles/marker are ready. */
  init(container: HTMLElement, opts?: MapInitOptions): Promise<void>;

  /** Pan the map so `ll` is centered. */
  setCenter(ll: LatLng): void;

  /** Set the map zoom level. */
  setZoom(zoom: number): void;

  /** Place the (single) agency marker at `ll` if not present yet. */
  placeMarker(ll: LatLng): void;

  /** Move the existing marker to `ll` (creates it if missing). */
  moveMarker(ll: LatLng): void;

  /** Register a callback for clicks on the map surface. */
  onMapClick(cb: (ll: LatLng) => void): void;

  /** Register a callback fired when the marker drag settles. */
  onMarkerMove(cb: (ll: LatLng) => void): void;

  /** Current marker coordinates, or null when no marker was placed. */
  getCoordinates(): LatLng | null;

  /** Optional: provider-native popup anchored to the marker (read-only views). */
  showMarkerInfo?(title: string, description?: string): void;

  /** Tear down listeners, marker and map instance. Safe to call twice. */
  destroy(): void;
}

/** Algeria country centroid — used when no agency coordinates exist yet. */
export const DEFAULT_MAP_CENTER: LatLng = { lat: 28.0339, lng: 1.6596 };

/** Zoom used when a concrete coordinate is known (street-level pick). */
export const MARKER_ZOOM = 15;

/** Zoom used for the country overview. */
export const COUNTRY_ZOOM = 5;

/** Coordinate sanity check used by the directions service and form payloads. */
export function isValidLatLng(ll: LatLng | null | undefined): ll is LatLng {
  if (!ll) return false;
  const { lat, lng } = ll;
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}
