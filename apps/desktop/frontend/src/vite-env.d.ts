/// <reference types="vite/client" />

/**
 * Global type augmentations for the BLASTI Desktop frontend.
 *
 * Note: Window.electronAPI is already declared in @/lib/native-bridge.ts
 * with the full ElectronAPI interface. Do not re-declare it here.
 */

// Extend Window to include Capacitor global (referenced by adapter code
// that is shared with Web/Mobile — even though Desktop never uses it).
declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform(): boolean;
      getPlatform(): string;
      isPluginAvailable(name: string): boolean;
      Plugins: Record<string, any>;
    };
  }
}

export {};
