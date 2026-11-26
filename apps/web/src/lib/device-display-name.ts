/**
 * device-display-name — the REAL device name behind every discovery card.
 *
 * USER REQUIREMENT (0.6.126): "installed app the device should be able to get
 * the device name and announce it in discovery". Through 0.6.125 the phone
 * announced the literal string 'BLASTI App' on the UDP beacon and registered
 * orphan rows named 'BLASTI App (Phone)' — the manager's discovery cards
 * could never tell WHICH physical phone or kiosk was which (and multi-device
 * branches saw identical cards).
 *
 * Resolution chain:
 *   1. NATIVE (Android plugin getDeviceName): Settings "device_name"
 *      (owner-renamed) → Bluetooth adapter name → Build.MANUFACTURER +
 *      Build.MODEL (brand default name, title-cased).
 *   2. A stored pairing name (the manager-assigned AgencyDevice.name) —
 *      callers pass it via `preferredName` once the device is paired.
 *   3. UA-string model guess (browser / WebView without the plugin).
 *   4. 'BLASTI App' / 'BLASTI Kiosk' — the old fallbacks.
 *
 * All names are DISPLAY data — the helper never touches tokens or ids.
 * Results are cached per app run (the name cannot change mid-session).
 */

import { getNativePlugin } from './native-plugin';

let cachedName: string | null = null;

function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!(window as any).Capacitor;
}

/** Best-effort model guess from the UA string ("2311DRK48G" Android builds). */
function uaModelGuess(): string {
  if (typeof navigator === 'undefined') return '';
  try {
    const ua = navigator.userAgent || '';
    // Android build segment: "; Android 16; 2311DRK48G Build/BP2A…"
    const m = ua.match(/Android[^;]*;\s*([^;)]+?)\s+(?:Build\/|wv\))/i);
    if (m && m[1] && !/^android$/i.test(m[1].trim())) return m[1].trim().slice(0, 60);
  } catch { /* UA parse is best-effort */ }
  return '';
}

/**
 * Resolve the device's display name. NEVER throws; resolves at minimum the
 * `fallback` (default 'BLASTI App').
 */
export async function getNativeDeviceName(fallback = 'BLASTI App'): Promise<string> {
  if (cachedName) return cachedName;
  // 1 — native plugin (Android).
  if (isNativeShell()) {
    try {
      const p = getNativePlugin('BlastiNativeStatus') as {
        getDeviceName?: (opts?: unknown) => Promise<{ name?: string }>;
      } | null;
      if (p && typeof p.getDeviceName === 'function') {
        const res = await p.getDeviceName({});
        const name = res && typeof res.name === 'string' ? res.name.trim() : '';
        if (name) {
          cachedName = name.slice(0, 100);
          return cachedName;
        }
      }
    } catch { /* plugin absent / older build — keep resolving */ }
  }
  // 3 — UA model guess (also correct inside a WebView whose plugin is old).
  const guessed = uaModelGuess();
  if (guessed) {
    cachedName = guessed;
    return cachedName;
  }
  cachedName = fallback;
  return cachedName;
}

/** Test/diagnostic hook — clears the per-run cache. */
export function resetDeviceNameCache(): void {
  cachedName = null;
}
