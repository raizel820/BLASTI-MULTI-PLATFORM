'use client';

import { useState, useEffect } from 'react';
import { usePlatform } from '@/hooks/use-platform';
import { Minus, Square, X } from 'lucide-react';

// ─── Electron Title Bar ───────────────────────────────────────────────────────

function ElectronTitleBar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    // Check initial maximize state
    if (window.electronAPI?.isMaximized) {
      window.electronAPI.isMaximized().then(setIsMaximized).catch(() => {});
    }
    // Listen for maximize changes
    if (window.electronAPI?.onMaximizeChange) {
      window.electronAPI.onMaximizeChange((maximized: boolean) => {
        setIsMaximized(maximized);
      });
    }
  }, []);

  const handleMinimize = () => {
    window.electronAPI?.minimize?.();
  };

  const handleMaximize = () => {
    window.electronAPI?.maximize?.();
  };

  const handleClose = () => {
    window.electronAPI?.close?.();
  };

  return (
    <div
      className="flex items-center h-9 bg-white/95 dark:bg-gray-950/95 border-b border-border select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Traffic lights (macOS-style) on the left */}
      <div
        className="flex items-center gap-2 px-4 h-full"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={handleClose}
          className="group relative h-3.5 w-3.5 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center transition-colors"
          aria-label="Close"
        >
          <X className="h-2 w-2 text-red-500 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <button
          onClick={handleMinimize}
          className="group relative h-3.5 w-3.5 rounded-full bg-amber-500 hover:bg-amber-600 flex items-center justify-center transition-colors"
          aria-label="Minimize"
        >
          <Minus className="h-2 w-2 text-amber-500 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <button
          onClick={handleMaximize}
          className="group relative h-3.5 w-3.5 rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center transition-colors"
          aria-label="Maximize"
        >
          {isMaximized ? (
            <div className="h-1.5 w-1.5 border border-green-500 group-hover:border-white opacity-0 group-hover:opacity-100 transition-opacity" />
          ) : (
            <Square className="h-1.5 w-1.5 text-green-500 group-hover:text-white opacity-0 group-hover:opacity-100 transition-opacity" />
          )}
        </button>
      </div>

      {/* App name centered */}
      <div className="flex-1 text-center">
        <span className="text-xs font-semibold text-muted-foreground tracking-wide">BLASTI</span>
      </div>

      {/* Spacer to balance the traffic lights */}
      <div className="w-20" />
    </div>
  );
}

// ─── Platform Frame ───────────────────────────────────────────────────────────

export function PlatformFrame({ children }: { children: React.ReactNode }) {
  const { platform, capabilities } = usePlatform();

  // Electron: Add custom title bar with traffic lights
  if (platform.isElectron) {
    return (
      <div className="flex flex-col h-screen">
        <ElectronTitleBar />
        {/* overflow-y-auto so the page scrolls inside the Electron window.
            overflow-hidden here was clipping all content and preventing scroll. */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    );
  }

  // Mobile (Capacitor): Add safe area insets padding (notch handling)
  if (platform.isMobile) {
    return (
      <div
        className="flex flex-col h-screen"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        {children}
        <div style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
      </div>
    );
  }

  // Web: No extra chrome
  return <>{children}</>;
}
