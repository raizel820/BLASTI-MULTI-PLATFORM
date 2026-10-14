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

/** Memoized probe — shared by all consumers for the whole session. */
let versionPromise: Promise<string | null> | null = null;

const PROBE_RETRIES = 5;
const PROBE_RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function probeOnce(): Promise<string | null> {
  try {
    // Real Capacitor 3–8 surface: window.Capacitor.Plugins.Device.getInfo()
    // (native Promise via nativePromise — verified JSExport.getPluginJS).
    const device = getNativePlugin('Device');
    const getInfo = device?.getInfo as (() => Promise<{ appVersion?: string }>) | undefined;
    const res = await getInfo?.();
    return res?.appVersion?.trim() || null;
  } catch {
    // Older shell / bridge threw — treat as not-ready, callers fall back.
    return null;
  }
}

/**
 * Probe with a bounded retry: on a REAL phone the native bridge is injected
 * before any web code runs, so the first attempt hits. The retries cover
 * shells/timings where the bridge global lands slightly AFTER the first
 * consumer mounts (slow WebView init, SPA hot paths) — without them the
 * null result was memoized for the whole session and the settings row kept
 * its static fallback forever.
 */
async function probeAppVersion(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  for (let attempt = 0; attempt < PROBE_RETRIES; attempt++) {
    const version = await probeOnce();
    if (version) return version;
    if (attempt + 1 < PROBE_RETRIES) await sleep(PROBE_RETRY_DELAY_MS);
  }
  return null; // plain browser / bridgeless shell — memoized fallback
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
