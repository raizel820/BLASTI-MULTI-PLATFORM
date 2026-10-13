/**
 * BLASTI app version (Task 2-a) — the REAL versionName, straight from the
 * native shell.
 *
 * The Capacitor shell injects the @capacitor/device plugin into the WebView;
 * Device.getInfo().appVersion is the Android `versionName` — the SAME value
 * the APK file name and the update system use (apps/mobile/android/app/
 * build.gradle, kept in sync from apps/mobile/package.json by
 * scripts/gradle.js).
 *
 * ZERO @capacitor imports: @capacitor/* is NOT installed in apps/web. The
 * global Capacitor object injected by the native shell is probed defensively
 * (established pattern: app-intro-animation.tsx / device-report.ts). In a
 * plain browser there is no bridge, so the promise simply resolves null and
 * callers fall back to their static label.
 *
 * Contract:
 * - SSR-safe (`typeof window === 'undefined'` → null).
 * - NEVER rejects: a missing or throwing bridge resolves null.
 * - Runs at most once per session: the module-level promise is memoized, so
 *   every consumer (launch intro badge, customer settings About row) shares
 *   one Device.getInfo() round-trip.
 */

interface DevicePluginShape {
  getInfo?: () => Promise<{ appVersion?: string }>;
}

interface CapacitorGlobalShape {
  /** Runtime returns the plugin object for `name` (Device → .getInfo()). */
  getPlugins?: (name: string) => DevicePluginShape | undefined;
}

/** Memoized probe — shared by all consumers for the whole session. */
let versionPromise: Promise<string | null> | null = null;

async function probeAppVersion(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  try {
    const cap = (
      window as unknown as { Capacitor?: CapacitorGlobalShape }
    ).Capacitor;
    const device = cap?.getPlugins?.('Device');
    const res = await device?.getInfo?.();
    return res?.appVersion?.trim() || null;
  } catch {
    // Older shell / no bridge — callers keep their fallback label.
    return null;
  }
}

/**
 * Resolve the native app version (Android versionName inside the shell,
 * null in plain browsers / Electron). Never rejects.
 */
export function getAppVersion(): Promise<string | null> {
  if (!versionPromise) {
    versionPromise = probeAppVersion();
  }
  return versionPromise;
}
