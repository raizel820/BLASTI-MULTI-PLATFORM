/**
 * BLASTI Platform Capabilities System — Desktop (Electron)
 *
 * In the Desktop app, we always use Electron capabilities.
 * The full capability matrix is preserved for type compatibility with the Web app,
 * but the lookup always returns the Electron capability set.
 */

import type { Platform } from '@/lib/platform';

// ─── Capability Interface ─────────────────────────────────────────────────────

/**
 * All capabilities the BLASTI app might use.
 * Each flag indicates whether the feature is available on the current platform.
 */
export interface PlatformCapabilities {
  /** Camera access (MediaStream on web, native on mobile) */
  canUseCamera: boolean;
  /** Push notifications (OS notifications on Electron) */
  canUsePushNotifications: boolean;
  /** Local file system read/write (Electron fs) */
  canUseFileSystem: boolean;
  /** Deep linking (blasti:// URLs) */
  canUseDeepLinks: boolean;
  /** Native share sheet */
  canUseNativeShare: boolean;
  /** Offline storage (IndexedDB, localStorage, or native SQLite) */
  canUseOfflineStorage: boolean;
  /** QR code scanning via camera */
  canUseQRScanner: boolean;
  /** App badge count (dock badge on macOS) */
  canUseBadge: boolean;
  /** Auto-update mechanism (Electron auto-updater) */
  canUseAutoUpdate: boolean;
  /** Custom window controls (Electron titleBarOverlay) */
  canUseWindowControls: boolean;
  /** Biometric authentication */
  canUseBiometrics: boolean;
  /** Clipboard read/write */
  canUseClipboard: boolean;
  /** Haptic vibration feedback */
  canUseVibration: boolean;
  /** Geolocation services */
  canUseGeolocation: boolean;
}

// ─── Capability Matrices ──────────────────────────────────────────────────────

/**
 * Electron desktop capabilities.
 * Everything web has PLUS file system, deep links, badge, auto-update,
 * window controls, and OS-level notifications.
 */
const ELECTRON_CAPABILITIES: PlatformCapabilities = {
  canUseCamera: true,
  canUsePushNotifications: true,
  canUseFileSystem: true,
  canUseDeepLinks: true,
  canUseNativeShare: false,
  canUseOfflineStorage: true,
  canUseQRScanner: false,
  canUseBadge: true,
  canUseAutoUpdate: true,
  canUseWindowControls: true,
  canUseBiometrics: false,
  canUseClipboard: true,
  canUseVibration: false,
  canUseGeolocation: true,
};

/**
 * Web browser capabilities (kept for type compatibility).
 */
const WEB_CAPABILITIES: PlatformCapabilities = {
  canUseCamera: true,
  canUsePushNotifications: false,
  canUseFileSystem: false,
  canUseDeepLinks: false,
  canUseNativeShare: false,
  canUseOfflineStorage: true,
  canUseQRScanner: false,
  canUseBadge: false,
  canUseAutoUpdate: false,
  canUseWindowControls: false,
  canUseBiometrics: false,
  canUseClipboard: true,
  canUseVibration: false,
  canUseGeolocation: true,
};

/**
 * Unknown platform capabilities — all features disabled.
 */
const UNKNOWN_CAPABILITIES: PlatformCapabilities = {
  canUseCamera: false,
  canUsePushNotifications: false,
  canUseFileSystem: false,
  canUseDeepLinks: false,
  canUseNativeShare: false,
  canUseOfflineStorage: false,
  canUseQRScanner: false,
  canUseBadge: false,
  canUseAutoUpdate: false,
  canUseWindowControls: false,
  canUseBiometrics: false,
  canUseClipboard: false,
  canUseVibration: false,
  canUseGeolocation: false,
};

// ─── Capability Lookup ────────────────────────────────────────────────────────

const CAPABILITY_MAP: Record<Platform, PlatformCapabilities> = {
  web: WEB_CAPABILITIES,
  electron: ELECTRON_CAPABILITIES,
  android: UNKNOWN_CAPABILITIES,
  ios: UNKNOWN_CAPABILITIES,
  unknown: UNKNOWN_CAPABILITIES,
};

/**
 * Get the capability set for a given platform.
 * In Desktop, this always returns ELECTRON_CAPABILITIES.
 *
 * @param platform - The detected or overridden platform
 * @returns A frozen PlatformCapabilities object for the platform
 */
export function getPlatformCapabilities(platform: Platform): PlatformCapabilities {
  const caps = CAPABILITY_MAP[platform] ?? ELECTRON_CAPABILITIES;
  return { ...caps };
}

// ─── Capability Key Helpers ───────────────────────────────────────────────────

/** All capability keys as a const tuple — useful for iteration */
export const CAPABILITY_KEYS = [
  'canUseCamera',
  'canUsePushNotifications',
  'canUseFileSystem',
  'canUseDeepLinks',
  'canUseNativeShare',
  'canUseOfflineStorage',
  'canUseQRScanner',
  'canUseBadge',
  'canUseAutoUpdate',
  'canUseWindowControls',
  'canUseBiometrics',
  'canUseClipboard',
  'canUseVibration',
  'canUseGeolocation',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * Human-readable label for each capability key.
 */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  canUseCamera: 'Camera',
  canUsePushNotifications: 'Push Notifications',
  canUseFileSystem: 'File System',
  canUseDeepLinks: 'Deep Links',
  canUseNativeShare: 'Native Share',
  canUseOfflineStorage: 'Offline Storage',
  canUseQRScanner: 'QR Scanner',
  canUseBadge: 'App Badge',
  canUseAutoUpdate: 'Auto Update',
  canUseWindowControls: 'Window Controls',
  canUseBiometrics: 'Biometrics',
  canUseClipboard: 'Clipboard',
  canUseVibration: 'Vibration',
  canUseGeolocation: 'Geolocation',
};

/**
 * Count how many capabilities are enabled for a given platform.
 */
export function countCapabilities(platform: Platform): number {
  const caps = getPlatformCapabilities(platform);
  return CAPABILITY_KEYS.filter((key) => caps[key]).length;
}

/**
 * Get a list of capability keys that differ between two platforms.
 */
export function diffCapabilities(
  a: Platform,
  b: Platform,
): Array<{ key: CapabilityKey; label: string; a: boolean; b: boolean }> {
  const capsA = getPlatformCapabilities(a);
  const capsB = getPlatformCapabilities(b);
  return CAPABILITY_KEYS.filter((key) => capsA[key] !== capsB[key]).map((key) => ({
    key,
    label: CAPABILITY_LABELS[key],
    a: capsA[key],
    b: capsB[key],
  }));
}
