/**
 * App-update delivery settings (device-local, Public App Settings rebuild).
 *
 * Controls whether the app shell auto-downloads pushed updates so the user
 * can install them later, plus the Wi-Fi-only sub-setting for metered
 * connections (phones on cellular data).
 *
 * Persistence: localStorage (`blasti-app-update-settings-v1`) — these are
 * DEVICE preferences (Wi-Fi state, disk space), not account preferences, so
 * they intentionally stay local like notification-sound-settings.ts.
 * All access is defensive — storage failures must never break the shell.
 */

export interface AppUpdateSettings {
  /** Download an available update in the background as soon as it appears. */
  autoDownload: boolean;
  /** Only auto-download over Wi-Fi / unmetered connections. */
  autoDownloadWifiOnly: boolean;
  /**
   * AUTO-UPDATE (download → install → restart): when the download finishes,
   * install WITHOUT waiting for a tap — desktop quits, runs the silent NSIS
   * installer and relaunches; Android opens the package installer
   * automatically (the OS still shows its own confirm screen — a hard
   * platform limit for non-device-owner apps). Mandatory updates ALWAYS
   * auto-install regardless of this flag.
   */
  autoInstall: boolean;
}

const SETTINGS_KEY = 'blasti-app-update-settings-v1';

const DEFAULT_SETTINGS: AppUpdateSettings = {
  autoDownload: false,
  autoDownloadWifiOnly: true,
  autoInstall: true,
};

export function defaultAppUpdateSettings(): AppUpdateSettings {
  return { ...DEFAULT_SETTINGS };
}

export function loadAppUpdateSettings(): AppUpdateSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppUpdateSettings>;
    return {
      autoDownload: parsed.autoDownload === true,
      autoDownloadWifiOnly: parsed.autoDownloadWifiOnly !== false,
      autoInstall: parsed.autoInstall !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveAppUpdateSettings(patch: Partial<AppUpdateSettings>): AppUpdateSettings {
  const next = { ...loadAppUpdateSettings(), ...patch };
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — settings stay in memory for this session */
  }
  return next;
}

/** localStorage key holding the version the user postponed ("Update later"). */
export const POSTPONED_VERSION_KEY = 'blasti-app-update-postponed-v1';

export function loadPostponedVersion(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(POSTPONED_VERSION_KEY) || null;
  } catch {
    return null;
  }
}

export function savePostponedVersion(version: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (version) window.localStorage.setItem(POSTPONED_VERSION_KEY, version);
    else window.localStorage.removeItem(POSTPONED_VERSION_KEY);
  } catch {
    /* best-effort */
  }
}
