'use client';

/**
 * useGpsAddressFill — r26: one-shot "fill the address fields from the device
 * GPS" primitive shared by the agency create/profile/settings forms and the
 * branch form (user request: a button next to the address input that
 * auto-fills it from GPS data).
 *
 * Flow: nativeBridge.getCurrentPosition() (Capacitor Geolocation on the
 * mobile shell, W3C navigator.geolocation in the browser) → honest-GPS
 * accuracy gate (r21-5 policy: a COARSE network/IP-grade fix — accuracy
 * > 2km — is NEVER allowed to fill textual address fields; that was the
 * Setif-vs-M'Sila bug) → reverseGeocode() through the Super-Admin-configured
 * provider (Google Geocoder or Nominatim OSM).
 *
 * The hook owns NO form state — the caller maps GeocodeComponents onto its
 * own field setters via the returned value, so the same primitive serves
 * four different form shapes.
 */
import { useCallback, useRef, useState } from 'react';
import { reverseGeocode, type GeocodeComponents, type MapsProviderSettings } from '@/lib/map';
import { useMapConfig } from '@/lib/map/use-map-config';
import { nativeBridge } from '@/lib/native-bridge';
import { useLanguage } from '@/hooks/use-language';

/** r21-5 — a device fix less accurate than this is a NETWORK/IP-grade
 * answer (desktop browsers silently fall back to those), not true GPS. */
export const GPS_COARSE_ACCURACY_METERS = 2000;

export type GpsFillOutcome =
  | { kind: 'OK'; coords: { lat: number; lng: number }; components: GeocodeComponents }
  | { kind: 'COARSE'; coords: { lat: number; lng: number }; accuracy: number }
  | { kind: 'ERROR'; reason: 'DENIED' | 'UNAVAILABLE' | 'GEOCODE_FAILED' };

/** Minimal OSM-fallback settings for the rare case the user presses the
 * button before the maps config loaded — reverseGeocode() falls through to
 * the keyless Nominatim provider with this shape (never invents Google). */
const FALLBACK_MAPS_SETTINGS: MapsProviderSettings = {
  provider: 'OPENFREEMAP',
  fallbackProvider: 'NONE',
  mapsEnabled: true,
  directionsEnabled: false,
  openfreemap: { styleUrl: '' },
  google: { configured: false, geocodingEnabled: false, jsApiKey: null },
  geocoding: { provider: 'OSM' },
  directions: {
    destinationMode: 'COORDINATES',
    origin: 'CURRENT_LOCATION',
    openBehavior: 'AUTO',
    buttonLabel: null,
  },
};

export function useGpsAddressFill() {
  const { config } = useMapConfig();
  const { lang } = useLanguage();
  const [locating, setLocating] = useState(false);
  const seqRef = useRef(0);

  const fill = useCallback(async (): Promise<GpsFillOutcome> => {
    const seq = ++seqRef.current;
    setLocating(true);
    try {
      const fix = await nativeBridge.getCurrentPosition();
      if (seq !== seqRef.current) return { kind: 'ERROR', reason: 'UNAVAILABLE' };
      if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number') {
        return { kind: 'ERROR', reason: 'UNAVAILABLE' };
      }
      const coords = { lat: fix.lat, lng: fix.lng };
      const accuracy = typeof fix.accuracy === 'number' ? fix.accuracy : null;

      // Honest-GPS gate — a coarse (network/IP) fix may move the map pin but
      // must never auto-fill wilaya/commune/address text (Setif-vs-M'Sila).
      if (accuracy != null && accuracy > GPS_COARSE_ACCURACY_METERS) {
        return { kind: 'COARSE', coords, accuracy };
      }

      try {
        const result = await reverseGeocode(coords, config ?? FALLBACK_MAPS_SETTINGS, lang);
        if (seq !== seqRef.current) return { kind: 'ERROR', reason: 'UNAVAILABLE' };
        // ReverseGeocodeResult EXTENDS GeocodeComponents (adds `provider`) —
        // it IS the components object the caller fills fields from.
        return { kind: 'OK', coords, components: result };
      } catch {
        return { kind: 'ERROR', reason: 'GEOCODE_FAILED' };
      }
    } catch {
      return { kind: 'ERROR', reason: 'DENIED' };
    } finally {
      if (seq === seqRef.current) setLocating(false);
    }
  }, [config, lang]);

  return { fill, locating };
}
