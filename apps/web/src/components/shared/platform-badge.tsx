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
  ios: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  web: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800',
};

/**
 * Production colors — more subtle/muted so the badge is non-intrusive
 * for end-users who happen to be on a native platform.
 */
const productionColorMap: Record<Platform, string> = {
  electron: 'bg-violet-50 text-violet-600/80 dark:bg-violet-900/20 dark:text-violet-400/70 border-violet-200/50 dark:border-violet-800/40',
  android: 'bg-green-50 text-green-600/80 dark:bg-green-900/20 dark:text-green-400/70 border-green-200/50 dark:border-green-800/40',
  ios: 'bg-blue-50 text-blue-600/80 dark:bg-blue-900/20 dark:text-blue-400/70 border-blue-200/50 dark:border-blue-800/40',
  web: 'bg-emerald-50 text-emerald-600/80 dark:bg-emerald-900/20 dark:text-emerald-400/70 border-emerald-200/50 dark:border-emerald-800/40',
  unknown: 'bg-gray-50 text-gray-600/80 dark:bg-gray-900/20 dark:text-gray-400/70 border-gray-200/50 dark:border-gray-800/40',
};

const isNativePlatform = (p: Platform): boolean =>
  p === 'electron' || p === 'android' || p === 'ios';

export function PlatformBadge() {
  const { platform } = usePlatform();
  const currentPlatform = platform.platform;

  const isDev = process.env.NODE_ENV === 'development';

  // In production: only show for native platforms (electron/android/ios)
  // In development: always show
  if (!isDev && !isNativePlatform(currentPlatform)) {
    return null;
  }

  const Icon = iconMap[currentPlatform] || Globe;
  const colors = isDev ? colorMap[currentPlatform] : productionColorMap[currentPlatform];

  // In production, make the badge smaller and more subtle
  const sizeClass = isDev
    ? 'text-[10px] font-medium px-2 py-0.5'
    : 'text-[9px] font-normal px-1.5 py-0';

  return (
    <Badge
      variant="outline"
      className={`gap-1 ${sizeClass} ${colors}`}
    >
      <span className="text-xs">{getPlatformIcon(currentPlatform)}</span>
      {getPlatformLabel(currentPlatform)}
    </Badge>
  );
}
