/**
 * BLASTI Platform Detection & Configuration
 *
 * Detects whether the app is running as:
 * - Web (browser, deployed on Vercel)
 * - Electron (desktop app)
 * - Capacitor (mobile app - Android/iOS)
 *
 * Each platform gets a tailored UI shell and feature set.
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

// ─── Platform Detection (SSR-safe) ───────────────────────────────────────────

/**
 * Detect the current platform at runtime.
 * Returns a safe default during SSR (platform: 'unknown', os: 'server').
 */
export function detectPlatform(): PlatformInfo {
  if (typeof window === 'undefined') {
    return {
      platform: 'unknown',
      category: 'web',
      isNative: false,
      isElectron: false,
      isCapacitor: false,
      isWeb: true,
      isMobile: false,
      isDesktop: false,
      isAndroid: false,
      isIOS: false,
      os: 'server',
      appVersion: APP_VERSION,
      deviceName: 'Server',
    };
  }

  const ua = navigator.userAgent;
  const isElectron = !!(window as unknown as Record<string, unknown>).electronAPI || ua.includes('Electron');
  const isCapacitor = !!(window as unknown as Record<string, unknown>).Capacitor;

  let platform: Platform = 'web';
  let category: PlatformCategory = 'web';
  let isAndroid = false;
  let isIOS = false;
  let os = 'unknown';

  if (isElectron) {
    platform = 'electron';
    category = 'desktop';
    os = ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'macos' : ua.includes('Linux') ? 'linux' : 'unknown';
  } else if (isCapacitor) {
    const capacitorPlatform = (window as unknown as Record<string, unknown>).Capacitor
      ? ((window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() ?? 'web')
      : 'web';

    if (capacitorPlatform === 'android' || ua.includes('Android')) {
      platform = 'android';
      category = 'mobile';
      isAndroid = true;
      os = 'android';
    } else if (capacitorPlatform === 'ios' || /iPhone|iPad|iPod/.test(ua)) {
      platform = 'ios';
      category = 'mobile';
      isIOS = true;
      os = 'ios';
    } else {
      platform = 'web';
      category = 'web';
      os = 'mobile-web';
    }
  } else {
    // Regular web browser
    platform = 'web';
    category = /Mobi|Android/i.test(ua) ? 'mobile' : 'web';
    os = ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'macos' : ua.includes('Linux') ? 'linux' : 'unknown';
  }

  const isMobile = category === 'mobile' || platform === 'android' || platform === 'ios';
  const isDesktop = category === 'desktop';

  return {
    platform,
    category,
    isNative: isElectron || isCapacitor,
    isElectron,
    isCapacitor,
    isWeb: !isElectron && !isCapacitor,
    isMobile,
    isDesktop,
    isAndroid,
    isIOS,
    os,
    appVersion: APP_VERSION,
    deviceName: getDeviceName(platform, os),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDeviceName(platform: Platform, os: string): string {
  switch (platform) {
    case 'electron':
      return os === 'macos' ? 'Mac' : os === 'windows' ? 'Windows PC' : 'Linux Desktop';
    case 'android':
      return 'Android Device';
    case 'ios':
      return 'iOS Device';
    default:
      return 'Web Browser';
  }
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
 * (not 'unknown'). Useful for capability checks.
 */
export function isKnownPlatform(platform: Platform): platform is 'web' | 'electron' | 'android' | 'ios' {
  return platform !== 'unknown';
}
