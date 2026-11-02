'use client';

import { usePlatform } from '@/hooks/use-platform';
import { getPlatformIcon, getPlatformLabel, type Platform } from '@/lib/platform';
import { Badge } from '@/components/ui/badge';
import { Monitor, Smartphone, Globe } from 'lucide-react';

const iconMap: Record<Platform, typeof Globe> = {
  electron: Monitor,
  android: Smartphone,
  ios: Smartphone,
  web: Globe,
  unknown: Globe,
};

const colorMap: Record<Platform, string> = {
  electron: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 border-violet-200 dark:border-violet-800',
  android: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800',
  ios: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800',
  web: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800',
};

/**
 * Platform detector chip — DEV-ONLY.
 *
 * 0.6.47 (field report): production installs kept showing the
 * 'Web App / Android App' detector chip in the top bar, so end users read it
 * as a bug ("platform detector in production"). The badge now renders in
 * development builds only; every production surface — web, apk and exe alike —
 * shows nothing. (It previously stayed visible for native platforms.)
 */
export function PlatformBadge() {
  // Tree-shaken from production bundles alongside PlatformSwitcher.
  // The guard lives in the outer component so the hook rules stay happy
  // (usePlatform must not sit behind an early return).
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }
  return <PlatformBadgeInner />;
}

function PlatformBadgeInner() {
  const { platform } = usePlatform();
  const currentPlatform = platform.platform;
  const Icon = iconMap[currentPlatform] || Globe;

  return (
    <Badge
      variant="outline"
      className={`gap-1 text-[10px] font-medium px-2 py-0.5 ${colorMap[currentPlatform]}`}
    >
      <span className="text-xs">{getPlatformIcon(currentPlatform)}</span>
      {getPlatformLabel(currentPlatform)}
    </Badge>
  );
}
