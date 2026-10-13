'use client';

/**
 * App-update settings card (SHARED — customer + agency settings pages,
 * Public App Settings rebuild).
 *
 * Lets the user control HOW the app delivers pushed updates on THIS device:
 *   • auto-download an available update in the background so installing it
 *     later is one tap ("Install now") instead of a full download wait;
 *   • auto-download ONLY over Wi-Fi (phones on cellular data).
 *
 * The card also carries the manual "Check for updates" row with live
 * feedback. Persisted device-locally via lib/app-update-settings.ts.
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Switch } from '@/components/ui/switch';
import { Loader2, RefreshCw, Wifi, DownloadCloud } from 'lucide-react';
import {
  loadAppUpdateSettings,
  saveAppUpdateSettings,
  type AppUpdateSettings,
} from '@/lib/app-update-settings';
import { runManualUpdateCheck } from '@/components/shared/app-update-manager';
import { useAppUpdateStore } from '@/store/use-app-update-store';
import { cn } from '@/lib/utils';

export function AppUpdateSettingsCard() {
  const { t, lang } = useLanguage();
  const [settings, setSettings] = useState<AppUpdateSettings>({
    autoDownload: false,
    autoDownloadWifiOnly: true,
  });
  const checking = useAppUpdateStore((s) => s.checking);

  useEffect(() => {
    setSettings(loadAppUpdateSettings());
  }, []);

  const update = (patch: Partial<AppUpdateSettings>) => {
    setSettings(saveAppUpdateSettings(patch));
  };

  const handleManualCheck = async () => {
    await runManualUpdateCheck(lang);
  };

  return (
    <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm overflow-hidden">
      {/* Section header */}
      <div className="p-3.5 flex items-center gap-3 border-b border-border/60">
        <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
          <DownloadCloud className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{t('updateSettingsSection')}</p>
          <p className="text-[11px] text-muted-foreground">{t('updateAutoDownloadDesc')}</p>
        </div>
      </div>

      {/* Auto-download toggle */}
      <div className="p-3.5 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{t('updateAutoDownload')}</p>
        </div>
        <Switch
          checked={settings.autoDownload}
          onCheckedChange={(checked) => update({ autoDownload: checked })}
          aria-label={t('updateAutoDownload')}
        />
      </div>

      {/* Wi-Fi-only sub-setting (only meaningful when auto-download is on) */}
      <div
        className={cn(
          'p-3.5 flex items-center gap-3 border-t border-border/40',
          !settings.autoDownload && 'opacity-50',
        )}
      >
        <div className="h-8 w-8 rounded-lg bg-teal-50 dark:bg-teal-900/20 flex items-center justify-center shrink-0">
          <Wifi className="h-4 w-4 text-teal-600 dark:text-teal-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">{t('updateWifiOnly')}</p>
          <p className="text-[11px] text-muted-foreground">{t('updateWifiOnlyDesc')}</p>
        </div>
        <Switch
          checked={settings.autoDownloadWifiOnly}
          onCheckedChange={(checked) => update({ autoDownloadWifiOnly: checked })}
          disabled={!settings.autoDownload}
          aria-label={t('updateWifiOnly')}
        />
      </div>

      {/* Manual check row */}
      <button
        onClick={() => void handleManualCheck()}
        disabled={checking}
        className="w-full p-3.5 flex items-center gap-3 border-t border-border/60 hover:bg-muted/50 dark:hover:bg-gray-800/50 transition-colors text-start disabled:opacity-60"
      >
        {checking ? (
          <Loader2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="text-sm font-medium text-foreground">
          {checking ? t('updateChecking') : t('updateCheckForUpdates')}
        </span>
      </button>
    </div>
  );
}
