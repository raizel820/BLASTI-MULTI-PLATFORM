/**
 * BLASTI Native Bridge — Desktop (Electron)
 *
 * A unified API for native features in the Electron Desktop app.
 * All methods route exclusively through `window.electronAPI` (IPC via preload).
 * No Capacitor branches are included in the Desktop build.
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

/** Extend Window to include Electron API */
declare global {
  interface Window {
    electronAPI?: ElectronAPI;
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
 */
export function safeJsonParse<T = unknown>(
  text: string | null | undefined,
  fallback: T | null = null,
): T | null {
  if (text == null || text.trim() === '') {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Get the current platform and capabilities.
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

// ─── Native Bridge API ────────────────────────────────────────────────────────

export const nativeBridge = {
  // ── Notifications ─────────────────────────────────────────────────────────

  /**
   * Send a notification to the user.
   * - Electron: via IPC → OS notification
   * - Web fallback: Notification API (requires permission)
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
   * Not supported on Electron desktop — returns null.
   */
  async scanQR(): Promise<string | null> {
    if (!hasCapability('canUseQRScanner')) {
      console.warn('[nativeBridge] scanQR: capability not available on this platform');
      return null;
    }
    return null;
  },

  // ── Camera / Take Photo ───────────────────────────────────────────────────

  /**
   * Take a photo and return it as a base64 data URI.
   * Electron: Uses MediaStream + canvas capture (same as web).
   */
  async takePhoto(): Promise<string | null> {
    if (!hasCapability('canUseCamera')) {
      console.warn('[nativeBridge] takePhoto: capability not available on this platform');
      return null;
    }

    try {
      // Web/Electron: open camera via MediaStream and capture a frame
      if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });

        return new Promise<string | null>((resolve) => {
          const video = document.createElement('video');
          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          video.play();

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
   * Share content using the Web Share API.
   * Not natively supported on Electron — uses clipboard fallback.
   */
  async shareContent(data: ShareData): Promise<void> {
    if (!hasCapability('canUseNativeShare')) {
      // Electron doesn't have native share — copy to clipboard as fallback
      try {
        const text = [data.title, data.text, data.url].filter(Boolean).join('\n');
        if (text && typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(text);
          console.log('[nativeBridge] shareContent: copied to clipboard (no native share on Electron)');
        }
      } catch {
        console.warn('[nativeBridge] shareContent: clipboard fallback failed');
      }
      return;
    }

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({
          title: data.title,
          text: data.text,
          url: data.url,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('[nativeBridge] shareContent failed:', error);
      }
    }
  },

  // ── Badge Count ───────────────────────────────────────────────────────────

  /**
   * Set the app badge count (dock badge on macOS).
   * - Electron: app.dock.setBadge via IPC
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
    } catch (error) {
      console.error('[nativeBridge] setBadgeCount failed:', error);
    }
  },

  // ── File System ───────────────────────────────────────────────────────────

  /**
   * Write a file — Electron uses IPC to main process.
   * Falls back to blob download if IPC not available.
   */
  async writeFile(fileName: string, content: string | Blob, mimeType?: string): Promise<string | null> {
    const blob = content instanceof Blob
      ? content
      : new Blob([content], { type: mimeType || 'text/plain' });

    // Electron: write via IPC (if available)
    if (isElectron() && window.electronAPI) {
      // TODO: Add writeFile IPC handler in preload
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
   */
  async readFile(_fileName: string): Promise<string | null> {
    if (!hasCapability('canUseFileSystem')) {
      console.warn('[nativeBridge] readFile: capability not available on this platform');
      return null;
    }

    try {
      if (isElectron() && window.electronAPI) {
        // TODO: Add readFile IPC handler in preload
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
   * - Electron: deep links come in via IPC, but we can navigate from renderer
   */
  async openDeepLink(url: string): Promise<void> {
    if (!hasCapability('canUseDeepLinks')) {
      console.warn('[nativeBridge] openDeepLink: capability not available on this platform');
      return;
    }

    try {
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
   * Not supported on Electron desktop.
   */
  async vibrate(_pattern: number | number[]): Promise<void> {
    if (!hasCapability('canUseVibration')) {
      // Vibration not supported on desktop — silently skip
      return;
    }

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(_pattern);
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
      // Web/Electron: use Permissions API
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
          if (status.state === 'granted') return true;
          if (status.state === 'prompt') {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: true });
              stream.getTracks().forEach((t) => t.stop());
              return true;
            } catch {
              return false;
            }
          }
        } catch {
          return false;
        }
      }
      return false;
    }

    case 'notifications': {
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
      if (typeof navigator !== 'undefined' && navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
          if (status.state === 'granted') return true;
          if (status.state === 'prompt') {
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
      // Not available on Electron desktop
      return false;
    }

    default:
      return false;
  }
}
