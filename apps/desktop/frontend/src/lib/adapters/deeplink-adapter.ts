/**
 * BLASTI Deep Link Adapter
 *
 * Provides a clean interface for deep link handling across platforms.
 *
 * Platform routing:
 *   - Electron → window.electronAPI.onDeepLink() for incoming links
 *   - Capacitor → App plugin for URL handling (universal links / app links)
 *   - Web → Not supported (returns unavailable)
 */

import type { Platform } from '@/lib/platform';
import { getPlatformCapabilities } from '@/lib/platform-capabilities';

// ─── Interface ─────────────────────────────────────────────────────────────────

export interface DeepLinkAdapter {
  /** Whether deep linking is available on this platform */
  isAvailable(): boolean;
  /**
   * Register a handler for incoming deep link URLs.
   * Returns an unsubscribe function.
   */
  registerHandler(handler: (url: string) => void): () => void;
  /** Open a deep link URL */
  open(url: string): Promise<void>;
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

class ElectronDeepLinkAdapter implements DeepLinkAdapter {
  isAvailable(): boolean {
    return (
      isElectron() &&
      getPlatformCapabilities('electron').canUseDeepLinks &&
      !!window.electronAPI?.onDeepLink
    );
  }

  registerHandler(handler: (url: string) => void): () => void {
    if (!this.isAvailable() || !window.electronAPI?.onDeepLink) {
      return () => {};
    }

    try {
      // Register the IPC listener for deep links
      window.electronAPI.onDeepLink(handler);

      // The Electron preload doesn't support removing listeners via IPC,
      // so we return a no-op unsubscribe. In production, the preload could
      // be extended with an `offDeepLink` method.
      return () => {
        // No-op: Electron IPC listeners persist for the app lifetime.
        // This is acceptable because deep link handlers are typically
        // registered once and never removed.
      };
    } catch (error) {
      console.error('[DeepLinkAdapter:Electron] registerHandler failed:', error);
      return () => {};
    }
  }

  async open(url: string): Promise<void> {
    try {
      // In Electron, deep links are typically opened by the OS and
      // routed to the app via IPC. To open a URL from the renderer,
      // we can use shell.openExternal via IPC (not currently exposed
      // in preload) or navigate with window.location.
      // For custom protocol URLs (blasti://), navigation is the simplest.
      if (typeof window !== 'undefined') {
        window.location.href = url;
      }
    } catch (error) {
      console.error('[DeepLinkAdapter:Electron] open failed:', error);
    }
  }
}

// ─── Capacitor Implementation ──────────────────────────────────────────────────

class CapacitorDeepLinkAdapter implements DeepLinkAdapter {
  isAvailable(): boolean {
    if (!isCapacitorNative()) return false;
    const platform = window.Capacitor?.getPlatform() === 'android' ? 'android' : 'ios';
    return getPlatformCapabilities(platform as 'android' | 'ios').canUseDeepLinks;
  }

  registerHandler(handler: (url: string) => void): () => void {
    if (!this.isAvailable()) {
      return () => {};
    }

    try {
      const plugin = getCapacitorPlugin('App');
      if (plugin && typeof plugin.addListener === 'function') {
        const listener = plugin.addListener(
          'appUrlOpen',
          (data: Record<string, string>) => {
            if (data.url) {
              handler(data.url);
            }
          },
        );

        return () => {
          if (listener && typeof (listener as { remove: () => void }).remove === 'function') {
            (listener as { remove: () => void }).remove();
          }
        };
      }
    } catch (error) {
      console.error('[DeepLinkAdapter:Capacitor] registerHandler failed:', error);
    }

    return () => {};
  }

  async open(url: string): Promise<void> {
    try {
      const plugin = getCapacitorPlugin('App');
      if (plugin && typeof plugin.openUrl === 'function') {
        await (plugin.openUrl as (opts: { url: string }) => Promise<void>)({ url });
        return;
      }

      // Fallback: try Browser plugin
      const browserPlugin = getCapacitorPlugin('Browser');
      if (browserPlugin && typeof browserPlugin.open === 'function') {
        await (browserPlugin.open as (opts: { url: string }) => Promise<void>)({ url });
        return;
      }

      console.warn('[DeepLinkAdapter:Capacitor] No available plugin to open URL');
    } catch (error) {
      console.error('[DeepLinkAdapter:Capacitor] open failed:', error);
    }
  }
}

// ─── Web Implementation ────────────────────────────────────────────────────────

class WebDeepLinkAdapter implements DeepLinkAdapter {
  isAvailable(): boolean {
    // Web doesn't support custom protocol deep links
    return false;
  }

  registerHandler(): () => void {
    // Deep links are not supported on web
    return () => {};
  }

  async open(url: string): Promise<void> {
    // On web, we can only navigate to standard URLs
    // Custom protocol URLs (blasti://) won't work in browsers
    if (typeof window !== 'undefined' && url.startsWith('http')) {
      window.location.href = url;
    } else {
      console.info('[DeepLinkAdapter:Web] Deep links not supported on web platform');
    }
  }
}

// ─── Unavailable Implementation ────────────────────────────────────────────────

class UnavailableDeepLinkAdapter implements DeepLinkAdapter {
  isAvailable(): boolean {
    return false;
  }

  registerHandler(): () => void {
    return () => {};
  }

  async open(): Promise<void> {
    // No-op
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the appropriate deep link adapter for the given platform.
 */
export function createDeepLinkAdapter(platform: Platform): DeepLinkAdapter {
  switch (platform) {
    case 'electron':
      return new ElectronDeepLinkAdapter();
    case 'android':
    case 'ios':
      return new CapacitorDeepLinkAdapter();
    case 'web':
      return new WebDeepLinkAdapter();
    default:
      return new UnavailableDeepLinkAdapter();
  }
}
