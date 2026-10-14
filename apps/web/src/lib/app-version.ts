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
 * (lib/native-plugin.ts — shared with device-report.ts). In a plain browser
 * there is no bridge, so the promise simply resolves null and callers fall
 * back to their static label.
 *
 * Contract:
 * - SSR-safe (`typeof window === 'undefined'` → null).
 * - NEVER rejects: a missing or throwing bridge resolves null.
 * - Runs at most once per session: the module-level promise is memoized, so
 *   every consumer (launch intro badge, customer settings About row) shares
 *   one Device.getInfo() round-trip.
 */

import { getNativePlugin } from './native-plugin';
import { getNativeDiagnostics } from './native-diagnostics';

/** Memoized probe — shared by all consumers for the whole session. */
let versionPromise: Promise<string | null> | null = null;
/** Timestamp of the last FAILED probe cycle — null results are retryable. */
let lastNullAt = 0;

const PROBE_RETRIES = 5;
const PROBE_RETRY_DELAY_MS = 500;
/** After a failed cycle, wait this long before burning another full cycle
 * (a consumer rendering on every state change must not re-probe in a loop). */
const NULL_RETRY_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function probeOnce(): Promise<string | null> {
  // 1. The @capacitor/device plugin — Device.getInfo().appVersion is the
  //    Android versionName on a healthy bridge.
  try {
    const device = getNativePlugin('Device');
    const getInfo = device?.getInfo as (() => Promise<{ appVersion?: string }>) | undefined;
    const res = await getInfo?.();
    const v = res?.appVersion?.trim();
    if (v) return v;
  } catch {
    // Older shell / bridge threw — fall through to the native status plugin.
  }
  // 2. Fallback: the BlastiNativeStatus shell plugin reports versionName
  //    straight from PackageManager. Field devices were seen where the Device
  //    probe returned an empty appVersion ("1.0.0" fallback shown forever,
  //    recovery cards said "الإصدار: غير معروف") while this plugin answers —
  //    it is registered directly in MainActivity of every build.
  try {
    const diag = await getNativeDiagnostics();
    return diag.versionName?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Probe with a bounded retry: on a REAL phone the native bridge is injected
 * before any web code runs, so the first attempt hits. The retries cover
 * shells/timings where the bridge global lands slightly AFTER the first
 * consumer mounts (slow WebView init, SPA hot paths).
 */
async function probeAppVersion(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  for (let attempt = 0; attempt < PROBE_RETRIES; attempt++) {
    const version = await probeOnce();
    if (version) return version;
    if (attempt + 1 < PROBE_RETRIES) await sleep(PROBE_RETRY_DELAY_MS);
  }
  return null;
}

/**
 * Resolve the native app version (Android versionName inside the shell,
 * null in plain browsers / Electron). Never rejects.
 *
 * A null result is NOT memoized for the whole session any more — the first
 * consumer (launch intro) can easily probe before the bridge is ready, and
 * a permanently-cached null kept the settings row on its static fallback
 * forever. Failed cycles may re-run after NULL_RETRY_MS (throttled so a
 * re-rendering consumer cannot loop probes).
 */
export function getAppVersion(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!versionPromise) {
    if (Date.now() - lastNullAt < NULL_RETRY_MS) return Promise.resolve(null);
    versionPromise = probeAppVersion().then((v) => {
      if (v) {
        lastNullAt = 0;
        return v;
      }
      lastNullAt = Date.now();
      versionPromise = null; // allow a later re-probe
      return null;
    });
  }
  return versionPromise;
}
