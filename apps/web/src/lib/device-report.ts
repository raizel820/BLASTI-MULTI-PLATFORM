/**
 * BLASTI Device Install Reporting (Public App Settings rebuild)
 *
 * WHAT
 *   Registers/heartbeats the RUNNING APP INSTALL with the cloud so the admin
 *   "Public App Settings → Devices" tab shows REAL device counts:
 *     POST <cloud>/api/app-installs/register | /heartbeat (public endpoints)
 *
 * SCOPE
 *   • Capacitor (Android/iOS) ONLY — inside the mobile shell the web app IS
 *     the app, so it reports the phone install itself.
 *   • Electron: handled natively by apps/desktop/device-telemetry.js (more
 *     reliable, works even when the web layer fails to boot).
 *   • Plain browsers: NOT reported — a browser tab is not an installed app.
 *
 * REINSTALL-ACCURATE DEDUPE (the core requirement)
 *   fingerprint = sha256(platform + stableDeviceId) where stableDeviceId is
 *   the Widevine MediaDrm device id (native plugin getStableDeviceId) — an
 *   OS-level identity that survives uninstall→reinstall, so one phone never
 *   counts twice. Older shells without the plugin fall back to the
 *   @capacitor/device identifier (ANDROID_ID, regenerated on reinstall —
 *   dedupe degrades to per-install, never to per-launch).
 *   deviceId   = a UUID persisted in localStorage: wiped on uninstall, so a
 *   fresh install generates a new one → the cloud records a REINSTALL event
 *   (installCount += 1) instead of a second device.
 *
 * SCHEDULING
 *   One check-in per app start + on every native 'resume', throttled to at
 *   most one call per 30 minutes. All failures are silent — telemetry must
 *   never disturb the user.
 */

import { getNativeCloudUrl } from './native-cloud-resolver';
import { getNativePlugin } from './native-plugin';

// Zero @capacitor imports (they are not installed in apps/web) — the
// Capacitor global injected by the native shell is probed via
// lib/native-plugin.ts (the REAL `Capacitor.Plugins[name]` surface —
// Capacitor 8 injects NO getPlugins() function, which silently broke
// telemetry registration on every physical phone).

const THROTTLE_KEY = 'blasti-device-report-last';
const DEVICE_UUID_KEY = 'blasti-device-install-uuid';
const THROTTLE_MS = 30 * 60 * 1000;

interface StableIdResult {
  deviceId?: string;
  source?: string;
  appVersion?: string;
}

async function sha256Hex(input: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    // crypto.subtle unavailable (insecure context) — non-crypto fallback
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (h * 31 + input.charCodeAt(i)) | 0;
    }
    return `fb${(h >>> 0).toString(16)}${input.length}`;
  }
}

/** Stable OS-level id via the native plugin (Widevine), else Device plugin. */
async function getStableDeviceId(): Promise<{ id: string; appVersion?: string }> {
  const native = getNativePlugin('BlastiNativeStatus');
  try {
    const getStableDeviceId = native?.getStableDeviceId as
      | ((opts?: unknown) => Promise<StableIdResult>)
      | undefined;
    if (getStableDeviceId) {
      const res = await getStableDeviceId();
      if (res && typeof res.deviceId === 'string' && res.deviceId.length >= 8) {
        return { id: res.deviceId, appVersion: res.appVersion };
      }
    }
  } catch { /* older shell without the method */ }

  // Fallback: @capacitor/device runtime plugin (injected by the shell)
  const device = getNativePlugin('Device');
  try {
    const getId = device?.getId as (() => Promise<{ identifier?: string }>) | undefined;
    const getInfo = device?.getInfo as
      | (() => Promise<{ name?: string; model?: string }>)
      | undefined;
    if (getId) {
      const [{ identifier }, info] = await Promise.all([
        getId(),
        getInfo ? getInfo() : Promise.resolve({} as { name?: string; model?: string }),
      ]);
      const id = identifier || info?.model || '';
      if (id) return { id };
    }
  } catch { /* plugin unavailable */ }
  return { id: '' };
}

function getOrCreateInstallUuid(): string {
  try {
    const existing = localStorage.getItem(DEVICE_UUID_KEY);
    if (existing && existing.length >= 8) return existing;
  } catch { /* storage blocked */ }
  const uuid =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    localStorage.setItem(DEVICE_UUID_KEY, uuid);
  } catch { /* storage blocked — per-session id */ }
  return uuid;
}

async function postJson(base: string, path: string, body: unknown): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(base.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Minimal shape of the injected Capacitor global this module needs. */
function capacitorGlobal(): {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
} | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor ?? null;
}

/** One check-in. Silent on every failure. */
export async function reportDeviceInstall(kind: 'register' | 'heartbeat' = 'register'): Promise<void> {
  try {
    if (!capacitorGlobal()?.isNativePlatform?.()) return;

    // Throttle: at most one report per 30 min (covers start + resume spam).
    try {
      const last = parseInt(localStorage.getItem(THROTTLE_KEY) ?? '0', 10);
      if (Date.now() - last < THROTTLE_MS) return;
      localStorage.setItem(THROTTLE_KEY, String(Date.now()));
    } catch { /* no storage → report anyway */ }

    const platform = capacitorGlobal()?.getPlatform?.() ?? '';
    if (platform !== 'android' && platform !== 'ios') return;

    const base = await getNativeCloudUrl();
    if (!base) return;

    const [{ id: stableId, appVersion }, uuid] = await Promise.all([getStableDeviceId(), Promise.resolve(getOrCreateInstallUuid())]);
    if (!stableId) return;

    const fingerprint = await sha256Hex(`${platform}:${stableId}`);

    await postJson(base, '/api/app-installs/register', {
      platform,
      fingerprint,
      deviceId: uuid,
      version: appVersion || 'unknown',
      label: `BLASTI ${platform === 'android' ? 'Android' : 'iOS'}`,
    });
  } catch {
    // telemetry must never break the app
  }
}

/** Wire start + native resume check-ins. Returns a cleanup function. */
export function startDeviceReporting(): () => void {
  void reportDeviceInstall('register');

  const App = getNativePlugin('App');
  let removeResume: (() => void) | null = null;
  const addListener = App?.addListener as
    | ((evt: string, cb: (state: { isActive?: boolean }) => void) => Promise<{ remove?: () => void }>)
    | undefined;
  if (addListener) {
    addListener('appStateChange', (state: { isActive?: boolean }) => {
      if (state?.isActive) void reportDeviceInstall('heartbeat');
    })
      .then((handle) => {
        removeResume = () => handle.remove?.();
      })
      .catch(() => undefined);
  }

  return () => {
    if (removeResume) removeResume();
  };
}
