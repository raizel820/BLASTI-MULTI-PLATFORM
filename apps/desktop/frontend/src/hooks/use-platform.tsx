import { useState, createContext, useContext, useMemo, type ReactNode } from 'react';
import { detectPlatform, type PlatformInfo, type Platform } from '@/lib/platform';
import { getPlatformCapabilities, type PlatformCapabilities } from '@/lib/platform-capabilities';

/**
 * usePlatform — Desktop adapter with Web-compatible interface.
 *
 * In the Desktop app, the platform is always 'electron', but we provide
 * the same context-based API as the Web app so shared components
 * (PlatformSwitcher, PlatformBadge) work unmodified.
 *
 * The PlatformSwitcher is dev-only and allows QA to preview how the UI
 * looks on different platforms.
 */

interface PlatformContextValue {
  platform: PlatformInfo;
  capabilities: PlatformCapabilities;
  setOverride: (platform: Platform | null) => void;
  override: Platform | null;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export function PlatformProvider({ children }: { children: ReactNode }) {
  const detected = detectPlatform();
  const [override, setOverride] = useState<Platform | null>(null);

  const platform = useMemo<PlatformInfo>(() => {
    if (!override) return detected;

    const base = { ...detected };
    switch (override) {
      case 'electron':
        return { ...base, platform: 'electron' as Platform, category: 'desktop' as const, isElectron: true, isDesktop: true, isWeb: false, isMobile: false };
      case 'web':
        return { ...base, platform: 'web' as Platform, category: 'web' as const, isElectron: false, isDesktop: false, isWeb: true, isMobile: false };
      case 'android':
        return { ...base, platform: 'android' as Platform, category: 'mobile' as const, isElectron: false, isDesktop: false, isWeb: false, isMobile: true };
      case 'ios':
        return { ...base, platform: 'ios' as Platform, category: 'mobile' as const, isElectron: false, isDesktop: false, isWeb: false, isMobile: true };
      default:
        return detected;
    }
  }, [override, detected]);

  const capabilities = useMemo(
    () => getPlatformCapabilities(platform.platform),
    [platform.platform]
  );

  const contextValue = useMemo<PlatformContextValue>(() => ({
    platform,
    capabilities,
    setOverride,
    override,
  }), [platform, capabilities, override]);

  return (
    <PlatformContext.Provider value={contextValue}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    return {
      platform: detectPlatform(),
      capabilities: getPlatformCapabilities('electron'),
      setOverride: () => {},
      override: null,
    };
  }
  return ctx;
}
