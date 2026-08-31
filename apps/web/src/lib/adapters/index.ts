/**
 * BLASTI Native Adapters — Unified Factory
 *
 * Exports all adapter interfaces and implementations, plus a unified
 * factory function that creates the correct adapter set for a given platform.
 *
 * Usage:
 *   import { getNativeAdapters } from '@/lib/adapters';
 *   import { detectPlatform } from '@/lib/platform';
 *
 *   const { platform } = detectPlatform();
 *   const adapters = getNativeAdapters(platform);
 *
 *   if (adapters.notification.isAvailable()) {
 *     await adapters.notification.send('Hello', 'World');
 *   }
 */

import type { Platform } from '@/lib/platform';
import { createNotificationAdapter } from './notification-adapter';
import { createQRAdapter } from './qr-adapter';
import { createStorageAdapter } from './storage-adapter';
import { createShareAdapter } from './share-adapter';
import { createDeepLinkAdapter } from './deeplink-adapter';

// Re-export adapter interfaces
export type { NotificationAdapter } from './notification-adapter';
export type { QRAdapter } from './qr-adapter';
export type { StorageAdapter } from './storage-adapter';
export type { ShareAdapter } from './share-adapter';
export type { DeepLinkAdapter } from './deeplink-adapter';

// Re-export factory functions
export { createNotificationAdapter } from './notification-adapter';
export { createQRAdapter } from './qr-adapter';
export { createStorageAdapter } from './storage-adapter';
export { createShareAdapter } from './share-adapter';
export { createDeepLinkAdapter } from './deeplink-adapter';

// ─── Unified Adapter Bundle ────────────────────────────────────────────────────

/**
 * A bundle of all native feature adapters for a specific platform.
 * Use `getNativeAdapters()` to obtain an instance.
 */
export interface NativeAdapters {
  /** Push/local notifications */
  notification: import('./notification-adapter').NotificationAdapter;
  /** QR code scanning and generation */
  qr: import('./qr-adapter').QRAdapter;
  /** Key-value persistent storage */
  storage: import('./storage-adapter').StorageAdapter;
  /** Content sharing (share sheet / clipboard) */
  share: import('./share-adapter').ShareAdapter;
  /** Deep link handling (custom protocol URLs) */
  deepLink: import('./deeplink-adapter').DeepLinkAdapter;
}

// ─── Singleton Cache ───────────────────────────────────────────────────────────

let adaptersInstance: NativeAdapters | null = null;
let cachedPlatform: Platform | null = null;

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Get the native adapter bundle for the given platform.
 *
 * The result is cached — calling again with the same platform returns
 * the same instance. If the platform changes, a new bundle is created.
 *
 * @param platform - The target platform (from detectPlatform())
 * @returns A NativeAdapters bundle with platform-specific implementations
 */
export function getNativeAdapters(platform: Platform): NativeAdapters {
  // Return cached instance if platform hasn't changed
  if (adaptersInstance && cachedPlatform === platform) {
    return adaptersInstance;
  }

  adaptersInstance = {
    notification: createNotificationAdapter(platform),
    qr: createQRAdapter(platform),
    storage: createStorageAdapter(platform),
    share: createShareAdapter(platform),
    deepLink: createDeepLinkAdapter(platform),
  };

  cachedPlatform = platform;

  return adaptersInstance;
}

/**
 * Reset the cached adapter instance. Useful for testing or when the
 * platform detection changes at runtime (e.g., platform switcher).
 */
export function resetNativeAdapters(): void {
  adaptersInstance = null;
  cachedPlatform = null;
}

/**
 * Get a summary of which adapters are available on the current platform.
 * Useful for debugging and UI feature flags.
 */
export function getAdapterAvailability(adapters: NativeAdapters): Record<string, boolean> {
  return {
    notification: adapters.notification.isAvailable(),
    qr: adapters.qr.isAvailable(),
    storage: adapters.storage.isAvailable(),
    share: adapters.share.isAvailable(),
    deepLink: adapters.deepLink.isAvailable(),
  };
}
