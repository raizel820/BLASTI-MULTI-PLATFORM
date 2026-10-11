/**
 * Geocoding abstraction (Task 51-b, spec §6/§29).
 *
 * Reverse geocoding is decoupled from the visual map provider:
 * - GOOGLE → the Google Maps JS API `Geocoder` (the sanctioned BROWSER path;
 *   the plain `maps/api/geocode/json` REST endpoint sends no CORS headers, so
 *   a browser fetch to it would always fail silently). The JS API script is
 *   shared with the map provider via `loadGoogleMaps`, and
 *   `google.geocodingEnabled` gates it;
 * - OSM → Nominatim (https://nominatim.openstreetmap.org/reverse), which
 *   allows browser CORS calls without a key.
 *
 * HARD RULE (spec §29): never invent missing address components. Any part
 * the geocoder did not return stays `null` and the UI leaves that field
 * untouched.
 */
import type { LatLng, MapProviderId, MapsProviderSettings } from './types';
import { loadGoogleMaps } from './google-provider';

/** Reverse-geocoded address components (absent parts stay null). */
export interface GeocodeComponents {
  /** Human-readable single-line address, e.g. "Cité 151, M'Sila, 28019, DZ". */
  formatted: string | null;
  /** Street incl. house number when the geocoder returns one. */
  street: string | null;
  /** City / town / commune. */
  city: string | null;
  /** Wilaya (first-level division). */
  wilaya: string | null;
  /** Postal code. */
  postalCode: string | null;
  /** ISO 3166-1 alpha-2 country code, e.g. "DZ". */
  countryCode: string | null;
}

/** The geocoder actually used for a call (surfaced for debugging/audit). */
export type GeocodingProviderId = MapProviderId | 'OSM';

export interface ReverseGeocodeResult extends GeocodeComponents {
  provider: GeocodingProviderId | 'UNKNOWN';
}

const GEOCODE_TIMEOUT_MS = 6000;

/** fetch() with a hard 6s timeout (spec §29 — both providers). */
async function fetchWithTimeout(url: string, timeoutMs = GEOCODE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** All-null result — the contract for "geocoder gave us nothing". */
const emptyResult = (provider: 'GOOGLE' | 'OSM'): ReverseGeocodeResult => ({
  formatted: null, street: null, city: null, wilaya: null, postalCode: null, countryCode: null,
  provider,
});

/** ── Google Geocoding (Maps JS API Geocoder — browser-only) ───────────── */

/** Minimal structural types for the slice of google.maps.Geocoder we use. */
interface GoogleGeocoderComponentLike {
  long_name?: string;
  short_name?: string;
  types?: string[];
}
interface GoogleGeocoderResultLike {
  formatted_address?: string;
  address_components?: GoogleGeocoderComponentLike[];
}
interface GoogleMapsNamespaceForGeocode {
  maps?: {
    Geocoder?: new () => {
      geocode(
        request: { location: LatLng; language?: string },
        callback: (results: GoogleGeocoderResultLike[] | null, status: string) => void,
      ): void;
    };
  };
}

/**
 * Parse a GeocoderResult into GeocodeComponents. Missing components stay
 * null — never invented (spec §29). administrative_area_level_2 is used for
 * the city ONLY when no real locality was returned.
 */
function parseGoogleComponents(first: GoogleGeocoderResultLike): ReverseGeocodeResult {
  const out: ReverseGeocodeResult = { ...emptyResult('GOOGLE'), formatted: first.formatted_address ?? null };
  for (const comp of first.address_components ?? []) {
    const types = comp.types ?? [];
    const long = comp.long_name ?? null;
    const short = comp.short_name ?? null;
    if (types.includes('street_number') || types.includes('route')) {
      // Compose "route + street_number" style streets without inventing data.
      out.street = out.street ? `${out.street} ${long ?? ''}`.trim() : long;
    } else if (types.includes('locality') || types.includes('postal_town')) {
      out.city = out.city ?? long;
    } else if (types.includes('administrative_area_level_2') && !out.city) {
      out.city = long; // fallback only when no real locality was returned
    } else if (types.includes('administrative_area_level_1')) {
      out.wilaya = long;
    } else if (types.includes('postal_code')) {
      out.postalCode = long;
    } else if (types.includes('country')) {
      out.countryCode = short; // ISO alpha-2
    }
  }
  return out;
}

function reverseGeocodeGoogle(ll: LatLng, apiKey: string, language: string): Promise<ReverseGeocodeResult> {
  if (typeof window === 'undefined') return Promise.resolve(emptyResult('GOOGLE'));
  // Any failure (script blocked/offline, Geocoder missing, REQUEST_DENIED,
  // timeout, empty results) resolves all-null — never throws (spec §29).
  return loadGoogleMaps(apiKey)
    .then((googleNs) => {
      const maps = (googleNs as GoogleMapsNamespaceForGeocode).maps;
      const GeocoderCtor = maps?.Geocoder;
      if (!GeocoderCtor) return emptyResult('GOOGLE');
      return new Promise<ReverseGeocodeResult>((resolve) => {
        const geocoder = new GeocoderCtor();
        let settled = false;
        const finish = (result: ReverseGeocodeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => finish(emptyResult('GOOGLE')), GEOCODE_TIMEOUT_MS);
        try {
          geocoder.geocode(
            { location: { lat: ll.lat, lng: ll.lng }, language: language || 'en' },
            (results, status) => {
              if (status !== 'OK' || !results?.length) {
                finish(emptyResult('GOOGLE')); // ZERO_RESULTS / REQUEST_DENIED / OVER_QUERY_LIMIT
                return;
              }
              finish(parseGoogleComponents(results[0]));
            },
          );
        } catch {
          finish(emptyResult('GOOGLE'));
        }
      });
    })
    .catch(() => emptyResult('GOOGLE'));
}

/** ── OSM / Nominatim ───────────────────────────────────────────────────── */

interface NominatimResponse {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    pedestrian?: string;
    footway?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    state?: string;
    postcode?: string;
    country_code?: string;
  };
}

function reverseGeocodeNominatim(ll: LatLng, language: string): Promise<ReverseGeocodeResult> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(ll.lat))}` +
    `&lon=${encodeURIComponent(String(ll.lng))}&addressdetails=1` +
    `&accept-language=${encodeURIComponent(language || 'en')}`;
  return fetchWithTimeout(url)
    .then((res) => (res.ok ? (res.json() as Promise<NominatimResponse>) : ({} as NominatimResponse)))
    .then((data): ReverseGeocodeResult => {
      const a = data.address ?? {};
      const streetParts = [a.house_number, a.road ?? a.pedestrian ?? a.footway]
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      return {
        formatted: data.display_name ?? null,
        street: streetParts.length ? streetParts.join(' ') : null,
        city: a.city ?? a.town ?? a.village ?? a.municipality ?? null,
        wilaya: a.state ?? null,
        postalCode: a.postcode ?? null,
        countryCode: a.country_code ? a.country_code.toUpperCase() : null,
        provider: 'OSM',
      };
    })
    .catch(() => emptyResult('OSM'));
}

/** ── Public API ────────────────────────────────────────────────────────── */

/**
 * Reverse geocode `ll` through the CONFIGURED geocoding provider.
 *
 * - GOOGLE provider requires `config.google.geocodingEnabled` AND a key;
 *   otherwise the configured OSM fallback (or OSM when geocoding.provider
 *   is OSM) is used.
 * - Resolves to an all-null result (never throws) when the geocoder is
 *   unreachable, offline, rate-limited or returns no data.
 */
export async function reverseGeocode(
  ll: LatLng,
  config: MapsProviderSettings,
  language: string = 'en',
): Promise<ReverseGeocodeResult> {
  const geocodingProvider = config.geocoding?.provider === 'GOOGLE' ? 'GOOGLE' : 'OSM';
  const googleUsable =
    geocodingProvider === 'GOOGLE' &&
    config.google?.geocodingEnabled === true &&
    typeof config.google?.jsApiKey === 'string' &&
    config.google.jsApiKey.length > 0;

  if (googleUsable && config.google?.jsApiKey) {
    return reverseGeocodeGoogle(ll, config.google.jsApiKey, language);
  }
  return reverseGeocodeNominatim(ll, language);
}
