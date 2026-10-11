/**
 * Task 82 — geo helpers for customer-facing distance estimates.
 *
 * `haversineDistanceKm` is a straight-line (great-circle) estimate, NOT a
 * driving distance — always shown as "~X km" in the UI. Good enough for the
 * user requirement ("estimated distance … when location access is available").
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** Great-circle distance between two coordinates, in km (2 decimals). */
export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const d = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(d * 100) / 100;
}

/** Human-friendly distance label value: <1 km → meters, else km with 1 decimal. */
export function formatDistance(
  km: number,
): { value: string; unit: 'm' | 'km' } {
  if (km < 1) {
    return { value: String(Math.max(1, Math.round(km * 1000))), unit: 'm' };
  }
  return { value: (Math.round(km * 10) / 10).toFixed(1), unit: 'km' };
}
