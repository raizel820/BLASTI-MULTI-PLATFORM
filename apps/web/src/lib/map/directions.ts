/**
 * Google Maps Directions service (Task 51-b, spec §20-26).
 *
 * ONE centralized URL builder — spec §25 forbids generating Google Maps URLs
 * independently in UI components. Every "Get Directions" button goes through
 * `buildDirectionsUrl` / `openDirections` here.
 *
 * The destination ALWAYS uses the canonical BLASTI agency coordinates
 * (spec §21 — no dependence on Google Place IDs).
 */
import type { MapsProviderSettings } from './types';
import { isValidLatLng } from './types';

/** Subset of the maps config the directions service consumes. */
export type DirectionsSettings = MapsProviderSettings['directions'];

/** The canonical Google Maps Directions base (Universal Cross-Platform URL). */
const DIRECTIONS_BASE = 'https://www.google.com/maps/dir/?api=1';

/** @deprecated internal — kept named so tests/logs reference one constant. */
export const GOOGLE_DIRECTIONS_BASE = DIRECTIONS_BASE;

/**
 * Build the Google Maps Directions URL for a destination.
 *
 * - `lat`/`lng` must be valid coordinates → returns null otherwise
 *   (callers surface `maps.invalidLocation` instead of an open attempt).
 * - `addressText` is only appended when the configured destinationMode is
 *   COORDINATES_AND_ADDRESS (as `destination_address`, per the 51-a contract;
 *   the plain-text destination form would REPLACE the canonical coordinates,
 *   which spec §21 forbids).
 * - `origin`: omitted for BOTH settings — with origin=CURRENT_LOCATION the
 *   device/browser resolves the customer's position (spec §22 recommended
 *   default); with origin=NONE no starting point is specified either.
 *
 * @returns the final URL, or null for invalid/missing coordinates.
 */
export function buildDirectionsUrl(
  lat: number | null | undefined,
  lng: number | null | undefined,
  addressText: string | null | undefined,
  settings: DirectionsSettings,
): string | null {
  if (lat == null || lng == null) return null;
  if (!isValidLatLng({ lat, lng })) return null;

  const params = new URLSearchParams();
  // Coordinates stay canonical; 6 decimals ≈ 11cm precision.
  params.set('destination', `${lat.toFixed(6)},${lng.toFixed(6)}`);

  if (settings?.destinationMode === 'COORDINATES_AND_ADDRESS') {
    const text = (addressText ?? '').trim();
    if (text) params.set('destination_address', text);
  }

  return `${DIRECTIONS_BASE}&${params.toString()}`;
}

/**
 * Open the Directions URL (spec §23 — safest behavior per platform).
 *
 * `window.open` with the universal https URL:
 * - Web desktop / Electron → opens (or asks to open) the browser tab;
 * - Mobile browsers (Capacitor WebView fallback / PWA) → the universal link
 *   lets Android/iOS resolve the Google Maps app automatically, with the web
 *   fallback the OS provides. We deliberately never guess custom `maps://`
 *   schemes (spec §23 — "Do not assume the Google Maps application is
 *   installed").
 *
 * @returns true when a new context was opened, false when the popup was
 *   blocked or the URL could not be built.
 */
export function openDirections(
  lat: number | null | undefined,
  lng: number | null | undefined,
  addressText: string | null | undefined,
  settings: DirectionsSettings,
): boolean {
  if (typeof window === 'undefined') return false;
  const url = buildDirectionsUrl(lat, lng, addressText, settings);
  if (!url) return false;
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  return win != null;
}
