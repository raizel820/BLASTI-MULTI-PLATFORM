'use client';

/**
 * DownloadAppButton — the landing-page download CTA.
 *
 * A button + dropdown that lists every platform the admin has PUBLISHED an
 * installer for (Admin → Public Apps Settings) and downloads the real file
 * from the VPS:
 *
 *   Desktop : Windows · macOS · Linux        (windows / mac / linux)
 *   Mobile  : Android release + Android debug APK + iOS
 *             (android / android-debug / ios)
 *
 * Platforms without a published installer render disabled with the shared
 * "Coming soon" label — no more fake availability. Used beside the Login
 * buttons in the hero/bottom CTA and in the sticky header.
 */

import { useMemo } from 'react';
import { Check, ChevronDown, Download, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/hooks/use-language';
import {
  AndroidLogo,
  AppleLogo,
  GooglePlayLogo,
  LinuxLogo,
  WindowsLogo,
} from '@/components/platform/brand-logos';
import {
  DESKTOP_PLATFORMS,
  detectDesktopPlatform,
  formatVersionLabel,
  usePublicAppVersions,
} from '@/components/platform/use-public-app-versions';

type Tone = 'solid' | 'outline' | 'onDark';

interface DownloadAppButtonProps {
  /** Visual treatment: solid emerald, outline (hero), or on-dark (bottom CTA). */
  tone?: Tone;
  size?: 'default' | 'sm' | 'lg';
  className?: string;
  /** Hide the text label (icon + chevron only) — used in the sticky header on phones. */
  iconOnly?: boolean;
}

const OS_META: Record<string, { name: string; Logo: (p: { className?: string }) => React.ReactNode }> = {
  windows: { name: 'Windows', Logo: WindowsLogo },
  mac: { name: 'macOS', Logo: AppleLogo },
  linux: { name: 'Linux', Logo: LinuxLogo },
  android: { name: 'Android', Logo: AndroidLogo },
  'android-debug': { name: 'Android', Logo: AndroidLogo },
  ios: { name: 'iOS', Logo: AppleLogo },
};

export function DownloadAppButton({
  tone = 'solid',
  size = 'default',
  className = '',
  iconOnly = false,
}: DownloadAppButtonProps) {
  const { t } = useLanguage();
  const { versions, getVersion, download } = usePublicAppVersions();
  const userDesktop = useMemo(() => detectDesktopPlatform(), []);

  const toneClasses: Record<Tone, string> = {
    solid:
      'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/25 border-0',
    outline:
      'bg-transparent border-2 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:border-emerald-400 dark:hover:border-emerald-600 font-bold',
    onDark:
      'bg-white/10 backdrop-blur-sm text-white border-white/25 hover:bg-white/20 hover:border-white/40 font-bold',
  };

  const renderRow = (platform: string, label: string, sublabel?: string, customIcon?: React.ReactNode) => {
    const v = getVersion(platform);
    const meta = OS_META[platform];
    const Logo = customIcon ? null : meta?.Logo;
    const isCurrent = platform === userDesktop;
    return (
      <DropdownMenuItem
        key={platform}
        disabled={!v?.downloadUrl}
        onSelect={() => {
          if (!download(platform)) return;
        }}
        className="gap-3 py-2.5 cursor-pointer"
      >
        {customIcon ?? (Logo ? <Logo className="h-4 w-4 shrink-0" /> : <Download className="h-4 w-4 shrink-0" />)}
        <span className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-medium leading-tight flex items-center gap-1.5">
            {label}
            {isCurrent && <Check className="h-3 w-3 text-emerald-500" aria-label="detected" />}
            {sublabel && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                {sublabel}
              </span>
            )}
          </span>
          <span className="text-[11px] text-muted-foreground leading-tight truncate">
            {v ? formatVersionLabel(v) : t('comingSoon')}
          </span>
        </span>
        {v?.downloadUrl && <Download className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size={size}
          className={`${toneClasses[tone]} rounded-2xl ${size === 'lg' ? 'px-6 md:px-8 py-6 md:py-7 text-base md:text-lg min-h-12 md:min-h-14' : 'min-h-11'} ${className}`}
          aria-label={iconOnly ? t('download') : undefined}
        >
          <Download className={`${iconOnly ? 'h-5 w-5' : 'h-5 w-5 md:h-4 md:w-4'} ${iconOnly ? '' : 'md:me-1'}`} />
          {!iconOnly && <span>{t('download')}</span>}
          {!iconOnly && <ChevronDown className="h-4 w-4 opacity-70" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-64 p-1">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-medium">
          {t('downloadChoosePlatform')}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Desktop installers */}
        {DESKTOP_PLATFORMS.map((p) => renderRow(p, OS_META[p]?.name ?? p))}
        <DropdownMenuSeparator />
        {/* Mobile packages — Android gets release + debug channel choices */}
        {renderRow('android', 'Android', t('downloadReleaseChannel'))}
        {renderRow('android-debug', 'Android', t('downloadDebugChannel'), <FlaskConical className="h-4 w-4 shrink-0 text-amber-500" />)}
        {renderRow('ios', 'iOS')}
        {/* SEO/a11y hint when nothing is published at all */}
        {!versions['windows'] && !versions['mac'] && !versions['linux'] && !versions['android'] && !versions['android-debug'] && !versions['ios'] && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
            <GooglePlayLogo className="h-3.5 w-3.5 opacity-60" />
            {t('downloadNonePublished')}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
