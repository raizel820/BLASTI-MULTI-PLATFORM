'use client';

import { usePlatform } from '@/hooks/use-platform';
import { type Platform, getPlatformIcon, getPlatformLabel, getPlatformColor } from '@/lib/platform';
import {
  Monitor,
  Smartphone,
  Globe,
  ChevronDown,
  Code2,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';

const platforms: { value: Platform | 'auto'; icon: typeof Monitor; label: string; description: string }[] = [
  { value: 'auto', icon: Globe, label: 'Auto Detect', description: 'Use detected platform' },
  { value: 'web', icon: Globe, label: 'Web App', description: 'Browser experience' },
  { value: 'electron', icon: Monitor, label: 'Desktop App', description: 'Electron native shell' },
  { value: 'android', icon: Smartphone, label: 'Android App', description: 'Capacitor mobile' },
  { value: 'ios', icon: Smartphone, label: 'iOS App', description: 'Capacitor mobile' },
];

export function PlatformSwitcher() {
  // Dev-only: this component is hidden in production builds
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  return <PlatformSwitcherInner />;
}

/**
 * Inner component that contains the actual switcher UI.
 * Only rendered in development mode — the parent guard ensures
 * this code is tree-shaken from production bundles.
 */
function PlatformSwitcherInner() {
  const { platform, setOverride, override } = usePlatform();

  const currentLabel = override ? getPlatformLabel(override) : `${getPlatformLabel(platform.platform)} (Auto)`;
  const currentIcon = override ? getPlatformIcon(override) : getPlatformIcon(platform.platform);
  const currentColor = override ? getPlatformColor(override) : getPlatformColor(platform.platform);

  return (
    <Tooltip>
      <Popover>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={`gap-1.5 h-8 px-2.5 rounded-full text-xs font-medium opacity-70 hover:opacity-100 border border-dashed border-muted-foreground/30 ${currentColor}`}
            >
              <Code2 className="h-3 w-3 text-amber-500 dark:text-amber-400" />
              <span className="text-sm">{currentIcon}</span>
              <span className="hidden sm:inline">{currentLabel}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
              <span className="inline-flex items-center rounded-sm bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                DEV
              </span>
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Platform Preview
              </p>
              <span className="inline-flex items-center rounded-sm bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                DEV
              </span>
            </div>
            {platforms.map((p) => {
              const isActive = override
                ? p.value === override
                : p.value === 'auto';
              const Icon = p.icon;
              return (
                <button
                  key={p.value}
                  onClick={() => setOverride(p.value === 'auto' ? null : p.value)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
                      : 'hover:bg-muted text-foreground'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <div className="flex-1 text-start">
                    <div className="font-medium">{p.label}</div>
                    <div className="text-[10px] text-muted-foreground">{p.description}</div>
                  </div>
                  {isActive && (
                    <div className="h-2 w-2 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-2 pt-2 border-t border-border px-2">
            <p className="text-[10px] text-muted-foreground">
              Detected: <span className="font-medium">{getPlatformLabel(platform.platform)}</span> on {platform.os}
            </p>
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
              This tool is for development & QA only. Not visible in production.
            </p>
          </div>
        </PopoverContent>
      </Popover>
      <TooltipContent side="bottom">
        <p>Dev tool: preview platform-specific UI</p>
        <p className="text-[10px] opacity-70">Not visible to production users</p>
      </TooltipContent>
    </Tooltip>
  );
}
