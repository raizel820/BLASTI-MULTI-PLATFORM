/**
 * BLASTI Platform Detection & Configuration — Desktop (Electron)
 *
 * In the Desktop app, we always know we're running as Electron.
 * This module provides a simplified detectPlatform() that always returns
 * the electron platform, plus the same PlatformInfo interface used by
 * the Web app for compatibility.
 *
 * Related modules:
 * - `platform-capabilities.ts` — Capability matrix derived from the detected Platform
 * - `native-bridge.ts` — Unified native API that checks capabilities before executing
 */

// ─── Platform Type ────────────────────────────────────────────────────────────

/**
 * The platforms BLASTI supports.
 * This type is the source of truth — other modules (platform-capabilities, native-bridge)
 * import it from here to stay consistent.
 */
export type Platform = 'web' | 'electron' | 'android' | 'ios' | 'unknown';

export type PlatformCategory = 'web' | 'desktop' | 'mobile';

// ─── Platform Info ────────────────────────────────────────────────────────────

export interface PlatformInfo {
  platform: Platform;
  category: PlatformCategory;
  isNative: boolean;
  isElectron: boolean;
  isCapacitor: boolean;
  isWeb: boolean;
  isMobile: boolean;
  isDesktop: boolean;
  isAndroid: boolean;
  isIOS: boolean;
  os: string;
  appVersion: string;
  deviceName: string;
}

const APP_VERSION = '2.0.0';

// ─── Platform Detection (Electron-only) ──────────────────────────────────────

/**
 * Detect the current platform at runtime.
 * In the Desktop app, this ALWAYS returns electron with the correct OS info.
 */
export function detectPlatform(): PlatformInfo {
  if (typeof window === 'undefined') {
    return {
      platform: 'electron',
      category: 'desktop',
      isNative: true,
      isElectron: true,
      isCapacitor: false,
      isWeb: false,
      isMobile: false,
      isDesktop: true,
      isAndroid: false,
      isIOS: false,
      os: 'server',
      appVersion: APP_VERSION,
      deviceName: 'Desktop App',
    };
  }

  const ua = navigator.userAgent;
  const os = ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'macos' : ua.includes('Linux') ? 'linux' : 'unknown';

  return {
    platform: 'electron',
    category: 'desktop',
    isNative: true,
    isElectron: true,
    isCapacitor: false,
    isWeb: false,
    isMobile: false,
    isDesktop: true,
    isAndroid: false,
    isIOS: false,
    os,
    appVersion: APP_VERSION,
    deviceName: getDeviceName(os),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDeviceName(os: string): string {
  return os === 'macos' ? 'Mac' : os === 'windows' ? 'Windows PC' : 'Linux Desktop';
}

export function getPlatformIcon(platform: Platform): string {
  switch (platform) {
    case 'electron': return '🖥️';
    case 'android': return '🤖';
    case 'ios': return '🍎';
    case 'web': return '🌐';
    default: return '📱';
  }
}

export function getPlatformLabel(platform: Platform): string {
  switch (platform) {
    case 'electron': return 'Desktop App';
    case 'android': return 'Android App';
    case 'ios': return 'iOS App';
    case 'web': return 'Web App';
    default: return 'App';
  }
}

export function getPlatformColor(platform: Platform): string {
  switch (platform) {
    case 'electron': return 'text-violet-600 bg-violet-100 dark:bg-violet-900/30';
    case 'android': return 'text-green-600 bg-green-100 dark:bg-green-900/30';
    case 'ios': return 'text-blue-600 bg-blue-100 dark:bg-blue-900/30';
    case 'web': return 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30';
    default: return 'text-gray-600 bg-gray-100 dark:bg-gray-900/30';
  }
}

/**
 * Check if a specific platform value is a valid, known platform
 * (not 'unknown').
 */
export function isKnownPlatform(platform: Platform): platform is 'web' | 'electron' | 'android' | 'ios' {
  return platform !== 'unknown';
}
