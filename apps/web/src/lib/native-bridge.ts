/**
 * BLASTI Native Bridge
 *
 * A unified API for native features across web, Electron, and Capacitor.
 * Each method checks the platform's capabilities before executing and
 * routes to the correct implementation:
 *
 *   - Electron → window.electronAPI.*  (IPC via preload)
 *   - Capacitor → window.Capacitor + plugin APIs
 *   - Web → standard browser Web APIs
 *
 * All methods return gracefully (null / void) when the capability is
 * unavailable instead of throwing.
 */

import { detectPlatform, type Platform } from '@/lib/platform';
import { getPlatformCapabilities, type PlatformCapabilities, type CapabilityKey } from '@/lib/platform-capabilities';

// ─── Type Declarations for Global Window Extensions ───────────────────────────

/** Shape of the Electron API exposed via preload contextBridge */
interface ElectronAPI {
  sendNotification: (title: string, body: string) => void;
  setBadge: (count: number) => void;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onDeepLink: (callback: (url: string) => void) => void;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => void;
  onUpdateAvailable: (callback: (info: unknown) => void) => void;
  onUpdateDownloaded: (callback: () => void) => void;
  installUpdate: () => void;
  getAppVersion: () => Promise<string>;
  getPlatform: () => Promise<{ platform: string; arch: string; electronVersion: string; chromeVersion: string; nodeVersion: string }>;
}

/** Minimal shape of window.Capacitor for plugin access */
interface CapacitorGlobal {
  isNativePlatform: () => boolean;
  getPlatform: () => string;
  Plugins: Record<string, CapacitorPlugin>;
  isPluginAvailable: (name: string) => boolean;
}

interface CapacitorPlugin {
  [method: string]: (...args: unknown[]) => unknown;
}

/** Extend Window to include platform-specific globals */
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    Capacitor?: CapacitorGlobal;
  }
}

// ─── Permission Types ─────────────────────────────────────────────────────────

export type NativePermission =
  | 'camera'
  | 'notifications'
  | 'geolocation'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'biometrics';

// ─── Share Data ───────────────────────────────────────────────────────────────

export interface ShareData {
  title?: string;
  text?: string;
  url?: string;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Safe JSON parse wrapper that handles empty / null / malformed bodies.
 *
 * The Capacitor HTTP plugin can crash when the server returns an empty body
 * (e.g. 204 No Content) because `JSON.parse('')` throws a SyntaxError.
 * This wrapper catches that case and returns `fallback` instead.
 *
 * @param text   The raw response text (may be empty, null, or undefined)
 * @param fallback  Value to return when the body is empty or unparseable (default: null)
 * @returns Parsed JSON object, or `fallback` if the body was empty/malformed
 */
export function safeJsonParse<T = unknown>(
  text: string | null | undefined,
  fallback: T | null = null,
): T | null {
  // Guard against null/undefined/empty bodies (e.g. 204 No Content)
  if (text == null || text.trim() === '') {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Malformed JSON — return fallback instead of crashing
    return fallback;
  }
}

/**
 * Get the current platform and capabilities.
 * Safe to call at runtime (not during SSR).
 */
function getRuntimeInfo(): { platform: Platform; capabilities: PlatformCapabilities } {
  const info = detectPlatform();
  return {
    platform: info.platform,
    capabilities: getPlatformCapabilities(info.platform),
  };
}

/**
 * Check if a capability is available. Returns false during SSR.
 */
function hasCapability(key: CapabilityKey): boolean {
  if (typeof window === 'undefined') return false;
  const { capabilities } = getRuntimeInfo();
  return capabilities[key];
}

/**
 * Check if running inside Electron.
 */
function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

/**
 * Check if running inside Capacitor native.
 */
function isCapacitorNative(): boolean {
  return typeof window !== 'undefined' && !!window.Capacitor && window.Capacitor.isNativePlatform();
}

/**
 * Get a Capacitor plugin by name, or null if not available.
 */
function getCapacitorPlugin(name: string): CapacitorPlugin | null {
  if (!window.Capacitor) return null;
  if (!window.Capacitor.isPluginAvailable(name)) return null;
  return window.Capacitor.Plugins[name] ?? null;
}

/**
 * Check if the Web Share API is available.
 */
function isWebShareAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

// ─── Native Bridge API ────────────────────────────────────────────────────────

export const nativeBridge = {
  // ── Notifications ─────────────────────────────────────────────────────────

  /**
   * Send a notification to the user.
   * - Electron: via IPC → OS notification
   * - Web: Notification API (requires permission)
   * - Capacitor: LocalNotifications plugin
   */
  async sendNotification(title: string, body: string): Promise<void> {
    if (!hasCapability('canUsePushNotifications')) {
      console.warn('[nativeBridge] sendNotification: capability not available on this platform');
      return;
    }

    try {
      if (isElectron() && window.electronAPI) {
        window.electronAPI.sendNotification(title, body);
        return;
      }

      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('LocalNotifications');
        if (plugin && typeof plugin.schedule === 'function') {
          await (plugin.schedule as (opts: unknown) => Promise<unknown>)({
            notifications: [
              {
                title,
                body,
                id: Date.now(),
                schedule: { at: new Date(Date.now()) },
              },
            ],
          });
          return;
        }
      }

      // Web fallback: Notification API
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') {
          new Notification(title, { body });
        } else if (Notification.permission !== 'denied') {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            new Notification(title, { body });
          }
        }
      }
    } catch (error) {
      console.error('[nativeBridge] sendNotification failed:', error);
    }
  },

  // ── QR Scanner ────────────────────────────────────────────────────────────

  /**
   * Open a QR code scanner and return the scanned value.
   * - Capacitor: BarcodeScanner plugin
   * - Web: Not supported (returns null)
   */
  async scanQR(): Promise<string | null> {
    if (!hasCapability('canUseQRScanner')) {
      console.warn('[nativeBridge] scanQR: capability not available on this platform');
      return null;
    }

    try {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('BarcodeScanner');
        if (plugin && typeof plugin.start === 'function') {
          const result = await (plugin.start as (opts?: unknown) => Promise<{ hasContent: boolean; content?: string }>)(
            { targetedFormats: ['QR_CODE'] },
          );
          return result.hasContent ? (result.content ?? null) : null;
        }
      }
    } catch (error) {
      console.error('[nativeBridge] scanQR failed:', error);
    }

    return null;
  },

  // ── Camera / Take Photo ───────────────────────────────────────────────────

  /**
   * Take a photo and return it as a base64 data URI.
   * - Capacitor: Camera plugin
   * - Web: MediaStream + canvas capture (simplified)
   */
  async takePhoto(): Promise<string | null> {
    if (!hasCapability('canUseCamera')) {
      console.warn('[nativeBridge] takePhoto: capability not available on this platform');
      return null;
    }

    try {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('Camera');
        if (plugin && typeof plugin.getPhoto === 'function') {
          const photo = await (plugin.getPhoto as (opts: unknown) => Promise<{ base64String?: string; dataUrl?: string }>)({
            quality: 80,
            allowEditing: false,
            resultType: 'DataUrl',
            source: 'Camera',
          });
          return photo.dataUrl ?? (photo.base64String ? `data:image/jpeg;base64,${photo.base64String}` : null);
        }
      }

      // Web fallback: open camera via MediaStream and capture a frame
      if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });

        return new Promise<string | null>((resolve) => {
          const video = document.createElement('video');
          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          video.play();

          // Wait a moment for the camera to stabilize, then capture
          setTimeout(() => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(video, 0, 0);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                resolve(dataUrl);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            } finally {
              // Stop all tracks
              stream.getTracks().forEach((track) => track.stop());
            }
          }, 1500);
        });
      }
    } catch (error) {
      console.error('[nativeBridge] takePhoto failed:', error);
    }

    return null;
  },

  // ── Share ─────────────────────────────────────────────────────────────────

  /**
   * Share content using the native share sheet.
   * - Capacitor: Share plugin
   * - Web: Web Share API
   */
  async shareContent(data: ShareData): Promise<void> {
    if (!hasCapability('canUseNativeShare')) {
      console.warn('[nativeBridge] shareContent: capability not available on this platform');
      return;
    }

    try {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('Share');
        if (plugin && typeof plugin.share === 'function') {
          await (plugin.share as (opts: unknown) => Promise<unknown>)({
            title: data.title,
            text: data.text,
            url: data.url,
          });
          return;
        }
      }

      // Web fallback: Web Share API
      if (isWebShareAvailable()) {
        await navigator.share({
          title: data.title,
          text: data.text,
          url: data.url,
        });
      }
    } catch (error) {
      // User cancelling the share sheet is not an error
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('[nativeBridge] shareContent failed:', error);
      }
    }
  },

  // ── Badge Count ───────────────────────────────────────────────────────────

  /**
   * Set the app badge count (dock badge on macOS, notification count on mobile).
   * - Electron: app.dock.setBadge via IPC
   * - Capacitor: Badge plugin
   * - Web: Badge API (experimental)
   */
  async setBadgeCount(count: number): Promise<void> {
    if (!hasCapability('canUseBadge')) {
      console.warn('[nativeBridge] setBadgeCount: capability not available on this platform');
      return;
    }

    try {
      if (isElectron() && window.electronAPI) {
        window.electronAPI.setBadge(count);
        return;
      }

      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('Badge');
        if (plugin && typeof plugin.set === 'function') {
          await (plugin.set as (opts: unknown) => Promise<unknown>)({ count });
          return;
        }
      }

      // Web fallback: Badge API (experimental, Chrome only)
      if ('setAppBadge' in navigator) {
        try {
          if (count > 0) {
            await navigator.setAppBadge(count);
          } else {
            await navigator.clearAppBadge();
          }
        } catch {
          // Badge API may not be available in this browser context
        }
      }
    } catch (error) {
      console.error('[nativeBridge] setBadgeCount failed:', error);
    }
  },

  // ── File System ───────────────────────────────────────────────────────────

  /**
   * Write a file to the local file system.
   * - Capacitor: Filesystem + Share plugins for mobile blob downloads
   * - Electron: write via IPC (main process has fs access)
   * - Web: Download as a file blob
   */
  async writeFile(fileName: string, content: string | Blob, mimeType?: string): Promise<string | null> {
    const blob = content instanceof Blob
      ? content
      : new Blob([content], { type: mimeType || 'text/plain' });

    // Phase 6d: Explicit Capacitor branch for file downloads
    if (isCapacitorNative()) {
      try {
        // Use Capacitor Filesystem + Share plugins for mobile blob downloads
        const { Filesystem, Directory, Encoding } = (window as any).Capacitor?.Plugins || {};

        if (Filesystem) {
          // Convert blob to base64 for Capacitor Filesystem
          const base64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const dataUrl = reader.result as string;
              resolve(dataUrl.split(',')[1] || '');
            };
            reader.readAsDataURL(blob);
          });

          const result = await Filesystem.writeFile({
            path: fileName,
            data: base64,
            directory: Directory.Documents,
          });

          // Share the file using Capacitor Share plugin
          const { Share } = (window as any).Capacitor?.Plugins || {};
          if (Share) {
            await Share.share({
              title: fileName,
              url: result.uri,
            });
          }

          return result.uri;
        }
      } catch (error) {
        console.error('[nativeBridge] Capacitor file write failed:', error);
        return null;
      }
    }

    // Electron: write via IPC (if available)
    if (isElectron() && window.electronAPI) {
      // Electron would need an IPC handler for file write
      console.warn('[nativeBridge] writeFile: Electron file IPC not yet implemented in preload');
      return null;
    }

    // Web fallback: trigger a download as a file blob
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return null;
    } catch (error) {
      console.error('[nativeBridge] writeFile fallback download failed:', error);
      return null;
    }
  },

  /**
   * Read a file from the local file system.
   * - Electron: read via IPC (main process has fs access)
   * - Web: Not supported (returns null)
   */
  async readFile(_fileName: string): Promise<string | null> {
    if (!hasCapability('canUseFileSystem')) {
      console.warn('[nativeBridge] readFile: capability not available on this platform');
      return null;
    }

    try {
      if (isElectron() && window.electronAPI) {
        // Electron would need an IPC handler for file read; for now log a warning
        // since the current preload doesn't expose readFile.
        console.warn('[nativeBridge] readFile: Electron file IPC not yet implemented in preload');
        return null;
      }
    } catch (error) {
      console.error('[nativeBridge] readFile failed:', error);
    }

    return null;
  },

  // ── Deep Links ────────────────────────────────────────────────────────────

  /**
   * Open a deep link URL (blasti://...).
   * - Electron: Not typically needed from renderer (deep links come in via IPC)
   * - Capacitor: App.openUrl plugin
   * - Web: window.location.href
   */
  async openDeepLink(url: string): Promise<void> {
    if (!hasCapability('canUseDeepLinks')) {
      console.warn('[nativeBridge] openDeepLink: capability not available on this platform');
      return;
    }

    try {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('App');
        if (plugin && typeof plugin.openUrl === 'function') {
          await (plugin.openUrl as (opts: unknown) => Promise<unknown>)({ url });
          return;
        }
      }

      // Web / Electron fallback: just navigate
      if (typeof window !== 'undefined') {
        window.location.href = url;
      }
    } catch (error) {
      console.error('[nativeBridge] openDeepLink failed:', error);
    }
  },

  // ── Vibration ─────────────────────────────────────────────────────────────

  /**
   * Trigger haptic vibration feedback.
   * - Capacitor: Haptics plugin
   * - Web: navigator.vibrate
   */
  async vibrate(pattern: number | number[]): Promise<void> {
    if (!hasCapability('canUseVibration')) {
      console.warn('[nativeBridge] vibrate: capability not available on this platform');
      return;
    }

    try {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('Haptics');
        if (plugin) {
          if (typeof plugin.vibrate === 'function') {
            await (plugin.vibrate as (opts?: unknown) => Promise<unknown>)({
              duration: Array.isArray(pattern) ? pattern[0] : pattern,
            });
            return;
          }
          // Some haptics plugins use impactMedium instead
          if (typeof plugin.impactMedium === 'function') {
            await (plugin.impactMedium as () => Promise<unknown>)();
            return;
          }
        }
      }

      // Web fallback: Vibration API
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch (error) {
      console.error('[nativeBridge] vibrate failed:', error);
    }
  },

  // ── Permissions ───────────────────────────────────────────────────────────

  /**
   * Request permissions for native features.
   * Returns a map of permission name → granted boolean.
   */
  async requestPermissions(
    ...permissions: NativePermission[]
  ): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};

    for (const permission of permissions) {
      try {
        result[permission] = await requestSinglePermission(permission);
      } catch (error) {
        console.error(`[nativeBridge] requestPermission(${permission}) failed:`, error);
        result[permission] = false;
      }
    }

    return result;
  },
};

// ─── Permission Request Implementation ────────────────────────────────────────

async function requestSinglePermission(permission: NativePermission): Promise<boolean> {
  switch (permission) {
    case 'camera': {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('Camera');
        if (plugin && typeof plugin.requestPermissions === 'function') {
          const status = await (plugin.requestPermissions as (opts?: unknown) => Promise<{ camera: string }>)({
            permissions: ['camera'],
          });
          return status.camera === 'granted';
        }
      }
      // Web: use Permissions API
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
          if (status.state === 'granted') return true;
          if (status.state === 'prompt') {
            // Attempting getUserMedia will trigger the permission prompt
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: true });
              stream.getTracks().forEach((t) => t.stop());
              return true;
            } catch {
              return false;
            }
          }
        } catch {
          // Permissions API might not support 'camera'
          return false;
        }
      }
      return false;
    }

    case 'notifications': {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('PushNotifications');
        if (plugin && typeof plugin.requestPermissions === 'function') {
          const status = await (plugin.requestPermissions as () => Promise<{ receive: string }>)();
          return status.receive === 'granted';
        }
      }
      // Web / Electron: use Notification API
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        const result = await Notification.requestPermission();
        return result === 'granted';
      }
      return false;
    }

    case 'geolocation': {
      // Geolocation doesn't have a formal permissions API on all platforms;
      // try Capacitor first, then web
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('Geolocation');
        if (plugin && typeof plugin.requestPermissions === 'function') {
          const status = await (plugin.requestPermissions as () => Promise<{ location: string }>)();
          return status.location === 'granted';
        }
      }
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
          if (status.state === 'granted') return true;
          if (status.state === 'prompt') {
            // Attempting getCurrentPosition triggers the prompt
            return new Promise((resolve) => {
              navigator.geolocation.getCurrentPosition(
                () => resolve(true),
                () => resolve(false),
                { timeout: 10000 },
              );
            });
          }
        } catch {
          return false;
        }
      }
      return false;
    }

    case 'clipboard-read': {
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        try {
          const status = await navigator.permissions.query({
            name: 'clipboard-read' as PermissionName,
          });
          return status.state === 'granted';
        } catch {
          return false;
        }
      }
      return false;
    }

    case 'clipboard-write': {
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        try {
          const status = await navigator.permissions.query({
            name: 'clipboard-write' as PermissionName,
          });
          return status.state === 'granted';
        } catch {
          // Fallback: try to write to clipboard
          try {
            await navigator.clipboard.writeText('');
            return true;
          } catch {
            return false;
          }
        }
      }
      return false;
    }

    case 'biometrics': {
      if (isCapacitorNative()) {
        const plugin = getCapacitorPlugin('BiometricAuth');
        if (plugin && typeof plugin.checkBiometrics === 'function') {
          const status = await (plugin.checkBiometrics as () => Promise<{ isAvailable: boolean }>)();
          return status.isAvailable;
        }
      }
      return false;
    }

    default:
      return false;
  }
}
