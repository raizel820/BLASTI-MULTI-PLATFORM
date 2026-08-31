/**
 * BLASTI Mobile — Capacitor Plugin Bridge
 *
 * This module defines a Capacitor plugin interface that bridges native mobile
 * features to the BLASTI web app running inside the Capacitor WebView.
 *
 * The web app's `native-bridge.ts` and adapter layer detect the Capacitor
 * runtime via `window.Capacitor` and route calls through Capacitor plugin APIs.
 * This module serves as the native-side registration and documentation of
 * those bridges, plus a JavaScript-accessible helper object that can be
 * injected into the WebView for additional native integration.
 *
 * Plugin methods mirror the native-bridge.ts API:
 *   - getPlatform()   → Returns the native platform info
 *   - vibrate()       → Triggers haptic feedback via Haptics plugin
 *   - showNotification() → Schedules a local notification
 *   - share()         → Opens the native share sheet
 *   - openUrl()       → Opens a URL in the system browser / deep link handler
 *
 * Integration with the web app:
 *   The web app's `platform.ts` detects Capacitor via `window.Capacitor`,
 *   and the adapter layer (`apps/web/src/lib/adapters/`) uses the same
 *   Capacitor plugin APIs directly. This plugin module provides:
 *
 *   1. A typed reference of all plugin capabilities for documentation
 *   2. A `BlastiNativePlugin` object that can be exposed on `window` for
 *      the web app to call if it needs a simpler API than the raw plugins
 *   3. Event bridging setup (see setup.ts)
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';
import { PushNotifications } from '@capacitor/push-notifications';
import { Camera } from '@capacitor/camera';
import { Preferences } from '@capacitor/preferences';

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface BlastiPlatformInfo {
  platform: 'android' | 'ios' | 'web';
  isNative: boolean;
  appVersion: string;
  osVersion: string;
  deviceModel: string;
}

export interface BlastiNotificationOptions {
  title: string;
  body: string;
  id?: number;
  data?: Record<string, unknown>;
}

export interface BlastiShareOptions {
  title?: string;
  text?: string;
  url?: string;
}

export interface BlastiLanServer {
  service: string;
  version: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
  apiPort: number;
  webPort: number;
  platform: string;
}

export interface BlastiNativePlugin {
  /** Get native platform information */
  getPlatform(): Promise<BlastiPlatformInfo>;
  /** Trigger haptic vibration feedback */
  vibrate(style?: 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error'): Promise<void>;
  /** Show a local notification */
  showNotification(options: BlastiNotificationOptions): Promise<void>;
  /** Open the native share sheet */
  share(options: BlastiShareOptions): Promise<void>;
  /** Open a URL in the system browser or handle as deep link */
  openUrl(url: string): Promise<void>;
  /** Request notification permissions */
  requestNotificationPermission(): Promise<boolean>;
  /** Get a stored preference value */
  getPreference(key: string): Promise<string | null>;
  /** Set a preference value */
  setPreference(key: string, value: string): Promise<void>;
  /** Get the app info */
  getAppInfo(): Promise<{ version: string; build: string; id: string }>;
  /**
   * Discover BLASTI LAN servers on the local network.
   * Uses HTTP scanning on port 3080 /api/discover endpoint.
   * Scans common subnets (192.168.x.x, 10.0.x.x) for servers.
   * Returns a list of discovered servers, or empty array if none found.
   */
  discoverLanServers(options?: { timeout?: number; subnet?: string }): Promise<BlastiLanServer[]>;
  /**
   * Quick discover a single BLASTI LAN server.
   * Only checks localhost and the most common subnet (192.168.1.x).
   * Much faster than full discovery — ideal for auto-connect.
   */
  quickDiscoverLan(): Promise<BlastiLanServer | null>;
}

// ─── Plugin Implementation ──────────────────────────────────────────────────────

/**
 * The BLASTI native plugin implementation.
 * This object bridges Capacitor plugin APIs into a unified interface
 * that can be consumed by the web app.
 */
export const blastiNativePlugin: BlastiNativePlugin = {
  async getPlatform(): Promise<BlastiPlatformInfo> {
    const platform = Capacitor.getPlatform() as 'android' | 'ios' | 'web';
    const appInfo = await App.getInfo();

    return {
      platform,
      isNative: Capacitor.isNativePlatform(),
      appVersion: appInfo.version,
      osVersion: '', // Filled by Device plugin if available; left empty as fallback
      deviceModel: '', // Filled by Device plugin if available
    };
  },

  async vibrate(
    style: 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error' = 'medium',
  ): Promise<void> {
    try {
      switch (style) {
        case 'light':
          await Haptics.impact({ style: ImpactStyle.Light });
          break;
        case 'medium':
          await Haptics.impact({ style: ImpactStyle.Medium });
          break;
        case 'heavy':
          await Haptics.impact({ style: ImpactStyle.Heavy });
          break;
        case 'selection':
          await Haptics.selectionStart();
          await Haptics.selectionChanged();
          await Haptics.selectionEnd();
          break;
        case 'success':
          await Haptics.notification({ type: NotificationType.Success });
          break;
        case 'warning':
          await Haptics.notification({ type: NotificationType.Warning });
          break;
        case 'error':
          await Haptics.notification({ type: NotificationType.Error });
          break;
        default:
          await Haptics.impact({ style: ImpactStyle.Medium });
      }
    } catch (error) {
      console.error('[BlastiNativePlugin] vibrate failed:', error);
    }
  },

  async showNotification(options: BlastiNotificationOptions): Promise<void> {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: options.title,
            body: options.body,
            id: options.id ?? Date.now(),
            schedule: { at: new Date(Date.now()) },
            extra: options.data ?? {},
            sound: undefined,
            smallIcon: 'ic_stat_blasti',
            iconColor: '#10b981',
          },
        ],
      });
    } catch (error) {
      console.error('[BlastiNativePlugin] showNotification failed:', error);
    }
  },

  async share(options: BlastiShareOptions): Promise<void> {
    try {
      await Share.share({
        title: options.title,
        text: options.text,
        url: options.url,
      });
    } catch (error) {
      // User cancelling share sheet is not an error
      if (error instanceof Error && error.name !== 'AbortError') {
        console.error('[BlastiNativePlugin] share failed:', error);
      }
    }
  },

  async openUrl(url: string): Promise<void> {
    try {
      // The App plugin can open URLs using the system's URL handler.
      // For deep links (blasti://), this routes back to the app.
      // For http(s) URLs, this opens in the system browser.
      await App.openUrl({ url });
    } catch (error) {
      console.error('[BlastiNativePlugin] openUrl failed:', error);
    }
  },

  async requestNotificationPermission(): Promise<boolean> {
    try {
      // Try push notification permissions first (required for remote push)
      const pushResult = await PushNotifications.requestPermissions();
      if (pushResult.receive === 'granted') return true;

      // Fallback: try local notification permissions
      const localResult = await LocalNotifications.requestPermissions();
      return localResult.display === 'granted';
    } catch (error) {
      console.error('[BlastiNativePlugin] requestNotificationPermission failed:', error);
      return false;
    }
  },

  async getPreference(key: string): Promise<string | null> {
    try {
      const result = await Preferences.get({ key });
      return result.value;
    } catch (error) {
      console.error('[BlastiNativePlugin] getPreference failed:', error);
      return null;
    }
  },

  async setPreference(key: string, value: string): Promise<void> {
    try {
      await Preferences.set({ key, value });
    } catch (error) {
      console.error('[BlastiNativePlugin] setPreference failed:', error);
    }
  },

  async getAppInfo(): Promise<{ version: string; build: string; id: string }> {
    try {
      const info = await App.getInfo();
      return {
        version: info.version,
        build: info.build,
        id: info.id,
      };
    } catch (error) {
      console.error('[BlastiNativePlugin] getAppInfo failed:', error);
      return { version: '0.0.0', build: '0', id: 'com.blasti.mobile' };
    }
  },

  async discoverLanServers(options?: { timeout?: number; subnet?: string }): Promise<BlastiLanServer[]> {
    const timeout = options?.timeout ?? 1500;
    const found: BlastiLanServer[] = [];
    const subnets = options?.subnet
      ? [options.subnet]
      : ['192.168.1', '192.168.0', '192.168.2', '10.0.0', '10.0.1', '192.168.4'];

    const scanIP = async (ip: string): Promise<BlastiLanServer | null> => {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(`http://${ip}:3080/api/discover`, {
          signal: controller.signal,
          mode: 'cors',
        });
        clearTimeout(tid);
        if (!res.ok) return null;
        const data = await res.json();
        if (data.service === 'blasti-lan') return data as BlastiLanServer;
        return null;
      } catch {
        clearTimeout(tid);
        return null;
      }
    };

    // Scan subnets in batches of 10
    for (const subnet of subnets) {
      const batch: Promise<BlastiLanServer | null>[] = [];
      for (let i = 1; i <= 254; i++) {
        batch.push(scanIP(`${subnet}.${i}`));
        if (batch.length >= 10) {
          const results = await Promise.all(batch);
          results.forEach((r) => { if (r) found.push(r); });
          batch.length = 0;
          if (found.length > 0) return found; // Early exit on first found
        }
      }
      if (batch.length > 0) {
        const results = await Promise.all(batch);
        results.forEach((r) => { if (r) found.push(r); });
      }
      if (found.length > 0) return found;
    }

    return found;
  },

  async quickDiscoverLan(): Promise<BlastiLanServer | null> {
    // Quick scan: only check localhost + most common subnet
    const quickSubnets = ['192.168.1', '192.168.0'];

    for (const subnet of quickSubnets) {
      const batch: Promise<BlastiLanServer | null>[] = [];
      for (let i = 1; i <= 254; i++) {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 1000); // shorter timeout for quick scan
        batch.push(
          fetch(`http://${subnet}.${i}:3080/api/discover`, {
            signal: controller.signal,
            mode: 'cors',
          })
            .then(async (res) => {
              clearTimeout(tid);
              if (!res.ok) return null;
              const data = await res.json();
              return data.service === 'blasti-lan' ? (data as BlastiLanServer) : null;
            })
            .catch(() => {
              clearTimeout(tid);
              return null;
            }),
        );
        if (batch.length >= 20) { // Higher concurrency for quick scan
          const results = await Promise.all(batch);
          const found = results.find((r) => r !== null);
          if (found) return found;
          batch.length = 0;
        }
      }
      if (batch.length > 0) {
        const results = await Promise.all(batch);
        const found = results.find((r) => r !== null);
        if (found) return found;
      }
    }

    return null;
  },
};

// ─── Plugin Exports for Web Bridge ──────────────────────────────────────────────

/**
 * Exported plugin references that the setup.ts module uses to register
 * event listeners and bridge Capacitor events to the web app.
 */
export const plugins = {
  App,
  Haptics,
  LocalNotifications,
  PushNotifications,
  Camera,
  Preferences,
  Share,
} as const;

/**
 * Expose the BLASTI native plugin on the window object so the web app's
 * JavaScript code can access it directly as `window.__BLASTI_NATIVE__`.
 *
 * The web app's native-bridge.ts primarily uses `window.Capacitor.Plugins`
 * directly, but `window.__BLASTI_NATIVE__` provides a simplified,
 * high-level API that can be used for:
 *   - Quick feature checks during app initialization
 *   - Simplified calls that don't need the full Capacitor plugin API
 *   - Debugging and logging from the WebView inspector
 */
export function exposeOnWindow(): void {
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__BLASTI_NATIVE__ = blastiNativePlugin;
  }
}
