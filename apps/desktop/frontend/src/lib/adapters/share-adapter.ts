/**
 * BLASTI Share Adapter
 *
 * Provides a clean interface for content sharing across platforms.
 *
 * Platform routing:
 *   - Electron → Copy to clipboard + show notification
 *   - Capacitor → Share plugin (native share sheet)
 *   - Web → navigator.share() if available, fallback to clipboard
 */

import type { Platform } from '@/lib/platform';
import { getPlatformCapabilities } from '@/lib/platform-capabilities';

// ─── Interface ─────────────────────────────────────────────────────────────────

export interface ShareAdapter {
  /** Whether sharing is available on this platform */
  isAvailable(): boolean;
  /** Share content. Throws only on unexpected errors (not user cancellation). */
  share(data: { title?: string; text?: string; url?: string }): Promise<void>;
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

/**
 * Copy text to clipboard with fallback strategies.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    // Modern API
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    // Fallback: execCommand
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const result = document.execCommand('copy');
    document.body.removeChild(textarea);
    return result;
  } catch {
    return false;
  }
}

/**
 * Build a shareable text string from share data.
 */
function buildShareText(data: { title?: string; text?: string; url?: string }): string {
  const parts: string[] = [];
  if (data.title) parts.push(data.title);
  if (data.text) parts.push(data.text);
  if (data.url) parts.push(data.url);
  return parts.join('\n');
}

// ─── Electron Implementation ───────────────────────────────────────────────────

class ElectronShareAdapter implements ShareAdapter {
  isAvailable(): boolean {
    // Electron always has clipboard access
    return isElectron();
  }

  async share(data: { title?: string; text?: string; url?: string }): Promise<void> {
    try {
      const text = buildShareText(data);
      const copied = await copyToClipboard(text);

      if (copied) {
        // Show a notification letting the user know content was copied
        if (window.electronAPI?.sendNotification) {
          window.electronAPI.sendNotification(
            'Content Copied',
            'Share content has been copied to your clipboard.',
          );
        }
      } else {
        console.warn('[ShareAdapter:Electron] Failed to copy content to clipboard');
      }
    } catch (error) {
      console.error('[ShareAdapter:Electron] share failed:', error);
    }
  }
}

// ─── Capacitor Implementation ──────────────────────────────────────────────────

class CapacitorShareAdapter implements ShareAdapter {
  isAvailable(): boolean {
    if (!isCapacitorNative()) return false;
    const platform = window.Capacitor?.getPlatform() === 'android' ? 'android' : 'ios';
    return getPlatformCapabilities(platform as 'android' | 'ios').canUseNativeShare;
  }

  async share(data: { title?: string; text?: string; url?: string }): Promise<void> {
    try {
      const plugin = getCapacitorPlugin('Share');
      if (plugin && typeof plugin.share === 'function') {
        await (plugin.share as (opts: unknown) => Promise<unknown>)({
          title: data.title,
          text: data.text,
          url: data.url,
        });
        return;
      }

      // Fallback to clipboard
      const text = buildShareText(data);
      await copyToClipboard(text);
    } catch (error) {
      // User cancelling the share sheet is not an error
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error('[ShareAdapter:Capacitor] share failed:', error);
    }
  }
}

// ─── Web Implementation ────────────────────────────────────────────────────────

class WebShareAdapter implements ShareAdapter {
  isAvailable(): boolean {
    if (typeof window === 'undefined') return false;
    // Available if either Web Share API or clipboard is accessible
    return typeof navigator.share === 'function' || !!navigator.clipboard;
  }

  async share(data: { title?: string; text?: string; url?: string }): Promise<void> {
    try {
      // Try Web Share API first
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({
            title: data.title,
            text: data.text,
            url: data.url,
          });
          return;
        } catch (error) {
          // User cancelled — not an error
          if (error instanceof Error && error.name === 'AbortError') return;
          // Fall through to clipboard fallback
        }
      }

      // Clipboard fallback
      const text = buildShareText(data);
      const copied = await copyToClipboard(text);
      if (!copied) {
        console.warn('[ShareAdapter:Web] Could not share: neither Web Share API nor clipboard available');
      }
    } catch (error) {
      console.error('[ShareAdapter:Web] share failed:', error);
    }
  }
}

// ─── Unavailable Implementation ────────────────────────────────────────────────

class UnavailableShareAdapter implements ShareAdapter {
  isAvailable(): boolean {
    return false;
  }

  async share(): Promise<void> {
    // No-op
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the appropriate share adapter for the given platform.
 */
export function createShareAdapter(platform: Platform): ShareAdapter {
  switch (platform) {
    case 'electron':
      return new ElectronShareAdapter();
    case 'android':
    case 'ios':
      return new CapacitorShareAdapter();
    case 'web':
      return new WebShareAdapter();
    default:
      return new UnavailableShareAdapter();
  }
}
