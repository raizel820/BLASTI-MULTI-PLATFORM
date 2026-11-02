'use client';

import { useState, useEffect, createContext, useContext, useMemo, type ReactNode } from 'react';
import { detectPlatform, type PlatformInfo, type Platform } from '@/lib/platform';
import { getPlatformCapabilities, type PlatformCapabilities } from '@/lib/platform-capabilities';

interface PlatformContextValue {
  platform: PlatformInfo;
  capabilities: PlatformCapabilities;
  setOverride: (platform: Platform | null) => void;
  override: Platform | null;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [detected] = useState<PlatformInfo>(() => detectPlatform());
  const [override, setOverride] = useState<Platform | null>(null);

  // Persist override in localStorage — DEV BUILDS ONLY.
  // 0.6.47: a QA override (e.g. 'android') stored on the same origin used to
  // leak into production builds on that device — the app then behaved as the
  // faked platform AND the detector chip showed again. Production ignores
  // (and clears) any stored override.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') {
      try { localStorage.removeItem('blasti-platform-override'); } catch { /* silent */ }
      return;
    }
    try {
      const stored = localStorage.getItem('blasti-platform-override');
      if (stored) {
        // Use functional update to avoid lint warning about setState in effect
        queueMicrotask(() => setOverride(stored as Platform));
      }
    } catch { /* silent */ }
  }, []);

  const handleSetOverride = (p: Platform | null) => {
    // Dev-only guard mirrors the reader above — production never fakes a shell.
    if (process.env.NODE_ENV !== 'development') return;
    setOverride(p);
    try {
      if (p) localStorage.setItem('blasti-platform-override', p);
      else localStorage.removeItem('blasti-platform-override');
    } catch { /* silent */ }
  };

  const platform = useMemo<PlatformInfo>(() => {
    if (!override) return detected;

    // Create a modified platform info based on the override
    const base = { ...detected };
    switch (override) {
      case 'electron':
        return {
          ...base,
          platform: 'electron',
          category: 'desktop',
          isElectron: true,
          isWeb: false,
          isDesktop: true,
          isMobile: false,
          isNative: true,
          deviceName: 'Desktop App (Preview)',
          os: 'desktop',
        };
      case 'android':
        return {
          ...base,
          platform: 'android',
          category: 'mobile',
          isCapacitor: true,
          isWeb: false,
          isDesktop: false,
          isMobile: true,
          isNative: true,
          isAndroid: true,
          deviceName: 'Android (Preview)',
          os: 'android',
        };
      case 'ios':
        return {
          ...base,
          platform: 'ios',
          category: 'mobile',
          isCapacitor: true,
          isWeb: false,
          isDesktop: false,
          isMobile: true,
          isNative: true,
          isIOS: true,
          deviceName: 'iOS (Preview)',
          os: 'ios',
        };
      case 'web':
      default:
        return detected;
    }
  }, [detected, override]);

  // Derive capabilities from the current (possibly overridden) platform
  const capabilities = useMemo<PlatformCapabilities>(
    () => getPlatformCapabilities(platform.platform),
    [platform.platform],
  );

  return (
    <PlatformContext.Provider value={{ platform, capabilities, setOverride: handleSetOverride, override }}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    throw new Error('usePlatform must be used within a PlatformProvider');
  }
  return ctx;
}
