/**
 * BLASTI Storage Adapter
 *
 * Provides a clean interface for key-value persistence across platforms.
 * All methods are async to support platforms with asynchronous storage APIs.
 *
 * Platform routing:
 *   - Electron → localStorage (Electron renderer has full localStorage support)
 *   - Capacitor → Preferences API plugin (@capacitor/preferences)
 *   - Web → localStorage
 */

import type { Platform } from '@/lib/platform';
import { getPlatformCapabilities } from '@/lib/platform-capabilities';

// ─── Interface ─────────────────────────────────────────────────────────────────

export interface StorageAdapter {
  /** Whether persistent storage is available on this platform */
  isAvailable(): boolean;
  /** Retrieve a value by key. Returns null if not found. */
  getItem(key: string): Promise<string | null>;
  /** Store a value by key. */
  setItem(key: string, value: string): Promise<void>;
  /** Remove a value by key. */
  removeItem(key: string): Promise<void>;
  /** Clear all stored values. */
  clear(): Promise<void>;
  /** Get all stored keys. */
  getAllKeys(): Promise<string[]>;
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

/** Prefix all keys to avoid collision with other apps on the same origin */
const STORAGE_PREFIX = 'blasti:';

function prefixedKey(key: string): string {
  return `${STORAGE_PREFIX}${key}`;
}

function stripPrefix(key: string): string {
  return key.startsWith(STORAGE_PREFIX) ? key.slice(STORAGE_PREFIX.length) : key;
}

// ─── Electron Implementation ───────────────────────────────────────────────────

class ElectronStorageAdapter implements StorageAdapter {
  isAvailable(): boolean {
    return (
      isElectron() &&
      getPlatformCapabilities('electron').canUseOfflineStorage &&
      typeof localStorage !== 'undefined'
    );
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(prefixedKey(key));
    } catch (error) {
      console.error('[StorageAdapter:Electron] getItem failed:', error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(prefixedKey(key), value);
    } catch (error) {
      console.error('[StorageAdapter:Electron] setItem failed:', error);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      localStorage.removeItem(prefixedKey(key));
    } catch (error) {
      console.error('[StorageAdapter:Electron] removeItem failed:', error);
    }
  }

  async clear(): Promise<void> {
    try {
      // Only clear BLASTI-prefixed keys, not all localStorage
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (error) {
      console.error('[StorageAdapter:Electron] clear failed:', error);
    }
  }

  async getAllKeys(): Promise<string[]> {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keys.push(stripPrefix(k));
        }
      }
      return keys;
    } catch (error) {
      console.error('[StorageAdapter:Electron] getAllKeys failed:', error);
      return [];
    }
  }
}

// ─── Capacitor Implementation ──────────────────────────────────────────────────

class CapacitorStorageAdapter implements StorageAdapter {
  isAvailable(): boolean {
    if (!isCapacitorNative()) return false;
    const platform = window.Capacitor?.getPlatform() === 'android' ? 'android' : 'ios';
    return getPlatformCapabilities(platform as 'android' | 'ios').canUseOfflineStorage;
  }

  private getPreferencesPlugin() {
    // Try Preferences plugin first (newer name), then fallback to Storage (older name)
    return getCapacitorPlugin('Preferences') ?? getCapacitorPlugin('Storage');
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const plugin = this.getPreferencesPlugin();
      if (plugin && typeof plugin.get === 'function') {
        const result = await (plugin.get as (opts: { key: string }) => Promise<{ value: string | null }>)({
          key: prefixedKey(key),
        });
        return result.value;
      }

      // Fallback to localStorage
      return localStorage.getItem(prefixedKey(key));
    } catch (error) {
      console.error('[StorageAdapter:Capacitor] getItem failed:', error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      const plugin = this.getPreferencesPlugin();
      if (plugin && typeof plugin.set === 'function') {
        await (plugin.set as (opts: { key: string; value: string }) => Promise<void>)({
          key: prefixedKey(key),
          value,
        });
        return;
      }

      // Fallback to localStorage
      localStorage.setItem(prefixedKey(key), value);
    } catch (error) {
      console.error('[StorageAdapter:Capacitor] setItem failed:', error);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      const plugin = this.getPreferencesPlugin();
      if (plugin && typeof plugin.remove === 'function') {
        await (plugin.remove as (opts: { key: string }) => Promise<void>)({
          key: prefixedKey(key),
        });
        return;
      }

      // Fallback to localStorage
      localStorage.removeItem(prefixedKey(key));
    } catch (error) {
      console.error('[StorageAdapter:Capacitor] removeItem failed:', error);
    }
  }

  async clear(): Promise<void> {
    try {
      const plugin = this.getPreferencesPlugin();
      if (plugin && typeof plugin.clear === 'function') {
        await (plugin.clear as () => Promise<void>)();
        return;
      }

      // Fallback: clear only prefixed localStorage keys
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (error) {
      console.error('[StorageAdapter:Capacitor] clear failed:', error);
    }
  }

  async getAllKeys(): Promise<string[]> {
    try {
      const plugin = this.getPreferencesPlugin();
      if (plugin && typeof plugin.keys === 'function') {
        const result = await (plugin.keys as () => Promise<{ keys: string[] }>)();
        return result.keys
          .filter((k) => k.startsWith(STORAGE_PREFIX))
          .map((k) => stripPrefix(k));
      }

      // Fallback to localStorage
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keys.push(stripPrefix(k));
        }
      }
      return keys;
    } catch (error) {
      console.error('[StorageAdapter:Capacitor] getAllKeys failed:', error);
      return [];
    }
  }
}

// ─── Web Implementation ────────────────────────────────────────────────────────

class WebStorageAdapter implements StorageAdapter {
  isAvailable(): boolean {
    return typeof localStorage !== 'undefined';
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(prefixedKey(key));
    } catch (error) {
      console.error('[StorageAdapter:Web] getItem failed:', error);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(prefixedKey(key), value);
    } catch (error) {
      console.error('[StorageAdapter:Web] setItem failed:', error);
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      localStorage.removeItem(prefixedKey(key));
    } catch (error) {
      console.error('[StorageAdapter:Web] removeItem failed:', error);
    }
  }

  async clear(): Promise<void> {
    try {
      // Only clear BLASTI-prefixed keys, not all localStorage
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (error) {
      console.error('[StorageAdapter:Web] clear failed:', error);
    }
  }

  async getAllKeys(): Promise<string[]> {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_PREFIX)) {
          keys.push(stripPrefix(k));
        }
      }
      return keys;
    } catch (error) {
      console.error('[StorageAdapter:Web] getAllKeys failed:', error);
      return [];
    }
  }
}

// ─── Unavailable Implementation ────────────────────────────────────────────────

class UnavailableStorageAdapter implements StorageAdapter {
  isAvailable(): boolean {
    return false;
  }

  async getItem(): Promise<string | null> {
    return null;
  }

  async setItem(): Promise<void> {
    // No-op
  }

  async removeItem(): Promise<void> {
    // No-op
  }

  async clear(): Promise<void> {
    // No-op
  }

  async getAllKeys(): Promise<string[]> {
    return [];
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the appropriate storage adapter for the given platform.
 */
export function createStorageAdapter(platform: Platform): StorageAdapter {
  switch (platform) {
    case 'electron':
      return new ElectronStorageAdapter();
    case 'android':
    case 'ios':
      return new CapacitorStorageAdapter();
    case 'web':
      return new WebStorageAdapter();
    default:
      return new UnavailableStorageAdapter();
  }
}
