/**
 * BLASTI Notification Adapter
 *
 * Provides a clean interface for sending notifications across platforms.
 * Each platform implementation is isolated behind the NotificationAdapter interface.
 *
 * Platform routing:
 *   - Electron → window.electronAPI.sendNotification() (IPC → OS notification)
 *   - Capacitor → LocalNotifications / PushNotifications plugin
 *   - Web → Notification Web API
 */

import type { Platform } from '@/lib/platform';
import { getPlatformCapabilities } from '@/lib/platform-capabilities';

// ─── Interface ─────────────────────────────────────────────────────────────────

export interface NotificationAdapter {
  /** Whether notifications are available on this platform */
  isAvailable(): boolean;
  /** Request notification permission from the user. Returns true if granted. */
  requestPermission(): Promise<boolean>;
  /** Send a notification with optional data payload */
  send(title: string, body: string, data?: Record<string, unknown>): Promise<void>;
  /**
   * Register a handler for when the user clicks a notification.
   * Returns an unsubscribe function.
   */
  onNotificationClick(handler: (data: Record<string, unknown>) => void): () => void;
}

// ─── Internal Helpers ──────────────────────────────────────────────────────────

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

function isCapacitorNative(): boolean {
  return typeof window !== 'undefined' && !!window.Capacitor && window.Capacitor.isNativePlatform();
}

function getCapacitorPlugin(name: string) {
  if (!window.Capacitor) return null;
  if (!window.Capacitor.isPluginAvailable(name)) return null;
  return window.Capacitor.Plugins[name] ?? null;
}

// ─── Electron Implementation ───────────────────────────────────────────────────

class ElectronNotificationAdapter implements NotificationAdapter {
  isAvailable(): boolean {
    return isElectron() && getPlatformCapabilities('electron').canUsePushNotifications;
  }

  async requestPermission(): Promise<boolean> {
    // Electron notifications are granted via OS — the Notification API in Electron
    // is always available as long as the app is running
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      const result = await Notification.requestPermission();
      return result === 'granted';
    }
    // If Notification API is somehow unavailable in Electron, assume granted
    return this.isAvailable();
  }

  async send(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    try {
      if (window.electronAPI?.sendNotification) {
        window.electronAPI.sendNotification(title, body);
      } else {
        // Fallback to Web Notification API inside Electron
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          const notification = new Notification(title, { body, data });
          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        }
      }
    } catch (error) {
      console.error('[NotificationAdapter:Electron] send failed:', error);
    }
  }

  onNotificationClick(handler: (data: Record<string, unknown>) => void): () => void {
    // Electron doesn't expose a global notification click listener through the
    // preload API. The click is handled per-notification in send().
    // We can listen for deep links as a proxy for notification clicks.
    if (window.electronAPI?.onDeepLink) {
      const callback = (url: string) => {
        handler({ url, source: 'deep-link' });
      };
      window.electronAPI.onDeepLink(callback);
      return () => {
        // IPC listeners can't be removed with the current preload API,
        // but we return a no-op for interface consistency
      };
    }
    return () => {};
  }
}

// ─── Capacitor Implementation ──────────────────────────────────────────────────

class CapacitorNotificationAdapter implements NotificationAdapter {
  isAvailable(): boolean {
    if (!isCapacitorNative()) return false;
    const caps = getPlatformCapabilities(
      window.Capacitor?.getPlatform() === 'android' ? 'android' : 'ios',
    );
    return caps.canUsePushNotifications;
  }

  async requestPermission(): Promise<boolean> {
    try {
      // Try PushNotifications plugin first
      const pushPlugin = getCapacitorPlugin('PushNotifications');
      if (pushPlugin && typeof pushPlugin.requestPermissions === 'function') {
        const status = await (pushPlugin.requestPermissions as () => Promise<{ receive: string }>)();
        return status.receive === 'granted';
      }

      // Fallback to LocalNotifications
      const localPlugin = getCapacitorPlugin('LocalNotifications');
      if (localPlugin && typeof localPlugin.requestPermissions === 'function') {
        const status = await (localPlugin.requestPermissions as () => Promise<{ display: string }>)();
        return status.display === 'granted';
      }

      // Last resort: Web Notification API
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        const result = await Notification.requestPermission();
        return result === 'granted';
      }

      return false;
    } catch (error) {
      console.error('[NotificationAdapter:Capacitor] requestPermission failed:', error);
      return false;
    }
  }

  async send(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    try {
      // Try LocalNotifications plugin
      const localPlugin = getCapacitorPlugin('LocalNotifications');
      if (localPlugin && typeof localPlugin.schedule === 'function') {
        await (localPlugin.schedule as (opts: unknown) => Promise<unknown>)({
          notifications: [
            {
              title,
              body,
              id: Date.now(),
              schedule: { at: new Date(Date.now()) },
              extra: data ?? {},
            },
          ],
        });
        return;
      }

      // Fallback to Web Notification API
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body, data });
      }
    } catch (error) {
      console.error('[NotificationAdapter:Capacitor] send failed:', error);
    }
  }

  onNotificationClick(handler: (data: Record<string, unknown>) => void): () => void {
    try {
      const pushPlugin = getCapacitorPlugin('PushNotifications');
      if (pushPlugin && typeof pushPlugin.addListener === 'function') {
        const listener = pushPlugin.addListener(
          'pushNotificationActionPerformed',
          (notificationData: Record<string, unknown>) => {
            handler(notificationData);
          },
        );
        // Return unsubscribe
        return () => {
          if (listener && typeof (listener as { remove: () => void }).remove === 'function') {
            (listener as { remove: () => void }).remove();
          }
        };
      }

      const localPlugin = getCapacitorPlugin('LocalNotifications');
      if (localPlugin && typeof localPlugin.addListener === 'function') {
        const listener = localPlugin.addListener(
          'localNotificationActionPerformed',
          (notificationData: Record<string, unknown>) => {
            handler(notificationData);
          },
        );
        return () => {
          if (listener && typeof (listener as { remove: () => void }).remove === 'function') {
            (listener as { remove: () => void }).remove();
          }
        };
      }
    } catch (error) {
      console.error('[NotificationAdapter:Capacitor] onNotificationClick failed:', error);
    }
    return () => {};
  }
}

// ─── Web Implementation ────────────────────────────────────────────────────────

class WebNotificationAdapter implements NotificationAdapter {
  isAvailable(): boolean {
    return typeof window !== 'undefined' && typeof Notification !== 'undefined';
  }

  async requestPermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  }

  async send(title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') {
        const granted = await this.requestPermission();
        if (!granted) return;
      }
      const notification = new Notification(title, { body, data, icon: '/favicon.ico' });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch (error) {
      console.error('[NotificationAdapter:Web] send failed:', error);
    }
  }

  onNotificationClick(_handler: (data: Record<string, unknown>) => void): () => void {
    // Web Notification API doesn't have a global click listener.
    // Clicks are handled per-notification in send().
    return () => {};
  }
}

// ─── Unavailable Implementation ────────────────────────────────────────────────

class UnavailableNotificationAdapter implements NotificationAdapter {
  isAvailable(): boolean {
    return false;
  }

  async requestPermission(): Promise<boolean> {
    return false;
  }

  async send(): Promise<void> {
    // No-op
  }

  onNotificationClick(): () => void {
    return () => {};
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the appropriate notification adapter for the given platform.
 */
export function createNotificationAdapter(platform: Platform): NotificationAdapter {
  switch (platform) {
    case 'electron':
      return new ElectronNotificationAdapter();
    case 'android':
    case 'ios':
      return new CapacitorNotificationAdapter();
    case 'web':
      return new WebNotificationAdapter();
    default:
      return new UnavailableNotificationAdapter();
  }
}
