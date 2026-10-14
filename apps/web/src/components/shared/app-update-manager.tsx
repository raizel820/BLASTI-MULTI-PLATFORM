'use client';

/**
 * BLASTI App Update Manager — delivers pushed/checked updates inside BOTH
 * native shells (Public App Settings rebuild).
 *
 *   • OPTIONAL update → dismissable dialog: "Update now" starts the in-app
 *     download (desktop streams the NSIS installer with progress; Android
 *     uses the system DownloadManager) and "Update later" postpones — every
 *     manual-check button (sidebar / More sheet / settings) then reads
 *     "Update now" until the version ships or a newer one arrives.
 *   • MANDATORY update → FULL-SCREEN blocking gate: the app cannot be used
 *     until the update is downloaded AND installed. No close button, no
 *     backdrop escape.
 *
 * Also feeds pushed `update:available` IPC payloads (device-telemetry
 * check-ins) into the shared update store, re-checks when the app returns
 * to the foreground (a completed Android install lands this way), and runs
 * one update check per app opening.
 */

import { useEffect } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { t } from '@/i18n';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Download, Loader2, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import {
  manualUpdateCheck,
  useAppUpdateStore,
} from '@/store/use-app-update-store';

interface CapacitorAppPlugin {
  addListener?: (event: string, cb: (state: { isActive: boolean }) => void) => Promise<{ remove: () => void }> | { remove: () => void };
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AppUpdateManager() {
  const { t, lang } = useLanguage();
  const status = useAppUpdateStore((s) => s.status);
  const info = useAppUpdateStore((s) => s.info);
  const progress = useAppUpdateStore((s) => s.progress);
  const error = useAppUpdateStore((s) => s.error);
  const needsInstallPermission = useAppUpdateStore((s) => s.needsInstallPermission);
  const postponedVersion = useAppUpdateStore((s) => s.postponedVersion);
  const dialogRequested = useAppUpdateStore((s) => s.dialogRequested);
  const startDownload = useAppUpdateStore((s) => s.startDownload);
  const install = useAppUpdateStore((s) => s.install);
  const postpone = useAppUpdateStore((s) => s.postpone);
  const closeDialog = useAppUpdateStore((s) => s.closeDialog);
  const applyProgress = useAppUpdateStore((s) => s.applyProgress);
  const ingestPushPayload = useAppUpdateStore((s) => s.ingestPushPayload);
  const check = useAppUpdateStore((s) => s.check);
  const resetNeedsPermission = useAppUpdateStore((s) => s.resetNeedsPermission);

  // ── Wiring: IPC events + startup check + Capacitor resume listener ────────
  useEffect(() => {
    const w = window as unknown as {
      electronAPI?: {
        onUpdateAvailable?: (cb: (raw: unknown) => void) => void;
        onUpdateProgress?: (cb: (raw: unknown) => void) => () => void;
        sendNotification?: (title: string, body: string) => void;
      };
      Capacitor?: { Plugins?: Record<string, CapacitorAppPlugin | undefined> };
    };

    // Pushed updates from device-telemetry check-ins (desktop).
    const unsubProgress = w.electronAPI?.onUpdateProgress?.((raw) => applyProgress(raw as Parameters<typeof applyProgress>[0]));
    if (w.electronAPI?.onUpdateAvailable) {
      w.electronAPI.onUpdateAvailable((raw) => {
        void ingestPushPayload((raw ?? {}) as Parameters<typeof ingestPushPayload>[0]);
        try {
          w.electronAPI?.sendNotification?.(
            lang === 'ar' ? 'تحديث جديد متوفر' : lang === 'fr' ? 'Nouvelle mise à jour' : 'New update available',
            '',
          );
        } catch { /* best-effort */ }
      });
    }

    // Android: re-check when the app comes back to the foreground — this is
    // how a COMPLETED package install is detected (new version → no update).
    // The honesty gate runs FIRST: if the user just came back from the
    // package installer, compare the native version against the one recorded
    // at install() time and TELL the truth — "updated to X" on success, or
    // "the update did not install (signature mismatch) — uninstall and
    // reinstall once" when Android silently refused it (the old app must
    // never claim an update happened when the OS kept the old version).
    let unsubResume: (() => void) | undefined;
    const appPlugin = w.Capacitor?.Plugins?.App as CapacitorAppPlugin | undefined;
    if (appPlugin?.addListener) {
      try {
        const handle = appPlugin.addListener('appStateChange', (state) => {
          if (!state.isActive) return;
          void (async () => {
            const outcome = await useAppUpdateStore.getState().resolvePendingInstall();
            if (outcome === 'updated') {
              toast.success(
                lang === 'ar'
                  ? 'تم تحديث التطبيق بنجاح ✅'
                  : lang === 'fr'
                    ? 'Application mise à jour avec succès ✅'
                    : 'App updated successfully ✅',
              );
            } else if (outcome === 'not-installed') {
              toast.error(
                lang === 'ar'
                  ? 'لم يتم تثبيت التحديث — غالبًا بسبب توقيع مختلف. أزل التطبيق ثم ثبّته مرة واحدة من صفحة التحميل، وستعمل التحديثات المقبلة تلقائيًا.'
                  : lang === 'fr'
                    ? "La mise à jour n'a pas été installée — signature différente. Désinstallez puis réinstallez une fois ; les mises à jour suivantes seront automatiques."
                    : 'The update was not installed — signature mismatch. Uninstall the app and reinstall once from the download page; future updates will then install automatically.',
                { duration: 12000 },
              );
            }
            void check('resume');
          })();
        });
        if (handle && typeof (handle as { remove?: () => void }).remove === 'function') {
          unsubResume = () => (handle as { remove: () => void }).remove();
        }
      } catch { /* older bridge shapes */ }
    }

    // One check per app opening — delay so boot/login work is not competing.
    const timer = setTimeout(() => {
      void check('startup');
    }, 6000);

    return () => {
      unsubProgress?.();
      unsubResume?.();
      clearTimeout(timer);
    };
  }, [lang]);

  if (!info) return null;

  const mandatory = info.isMandatory === true;
  const busy = status === 'checking' || status === 'downloading' || status === 'installing';

  function pickMessage(): string {
    if (info?.pushMessage) {
      const ar = info.pushMessageAr, fr = info.pushMessageFr;
      if (lang === 'ar' && ar) return ar;
      if (lang === 'fr' && fr) return fr;
      return info.pushMessage;
    }
    if (!info) return '';
    if (lang === 'ar' && info.releaseNotesAr) return info.releaseNotesAr;
    if (lang === 'fr' && info.releaseNotesFr) return info.releaseNotesFr;
    return info.releaseNotes || '';
  }

  const message = pickMessage();
  const size = formatSize(info.fileSize);

  // ─── MANDATORY UPDATE — full-screen blocking gate ─────────────────────────
  if (mandatory) {
    return (
      <div
        className="fixed inset-0 z-[200] bg-background flex flex-col items-center justify-center px-6 text-center"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('updateNoticeMandatoryTitle')}
      >
        <div className="h-16 w-16 rounded-2xl bg-destructive/10 flex items-center justify-center mb-5">
          <ShieldAlert className="h-8 w-8 text-destructive" />
        </div>
        <h1 className="text-xl font-bold text-foreground">{t('updateNoticeMandatoryTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-sm">
          {t('updateMandatoryMessage')}
        </p>
        <p className="mt-1 text-sm font-medium text-foreground" dir="ltr">
          {t('updateNoticeVersionLine')
            .replace('{from}', info.currentVersion ?? '')
            .replace('{to}', info.version ?? '')}
        </p>
        {message ? (
          <p className="mt-3 text-sm text-muted-foreground whitespace-pre-line max-h-32 max-w-sm overflow-y-auto">{message}</p>
        ) : null}

        {status === 'downloading' && (
          <div className="mt-6 w-full max-w-xs">
            <div className="h-2 rounded-full bg-muted overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('updateDownloading')} {progress?.percent ? `${progress.percent}%` : ''}
            </p>
          </div>
        )}

        {needsInstallPermission && (
          <p className="mt-4 text-xs text-amber-600 dark:text-amber-400 max-w-xs">{t('updateAllowInstallPermission')}</p>
        )}

        <div className="mt-6 flex flex-col items-center gap-2 w-full max-w-xs">
          {(status === 'available' || status === 'error') && (
            <Button className="w-full h-11 gap-2" onClick={() => void startDownload()}>
              {status === 'error' ? <RefreshCw className="h-4 w-4" /> : <Download className="h-4 w-4" />}
              {status === 'error' ? t('updateRetry') : t('updateNoticeInstall')}
            </Button>
          )}
          {status === 'downloaded' && (
            <Button className="w-full h-11 gap-2" onClick={() => void install()}>
              <Download className="h-4 w-4" />
              {t('updateInstallNow')}
            </Button>
          )}
          {status === 'installing' && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('updateInstalling')}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ─── OPTIONAL UPDATE — dialog ──────────────────────────────────────────────
  const dialogOpen = (status === 'available' || status === 'downloading' || status === 'downloaded')
    && (dialogRequested || (postponedVersion !== info.version));

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) {
          // Only "Update later" closes it once an update is known — keep the
          // version marked postponed so the manual button becomes Update now.
          if (!busy && status === 'available') postpone();
          closeDialog();
        }
      }}
    >
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-5 w-5 text-emerald-500" />
            {t('updateNoticeTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('updateNoticeVersionLine')
              .replace('{from}', info.currentVersion ?? '')
              .replace('{to}', info.version ?? '')}
          </DialogDescription>
        </DialogHeader>
        {message ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line max-h-40 overflow-y-auto">{message}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('updateOptionalMessage')}</p>
        )}
        {size ? <p className="text-xs text-muted-foreground" dir="ltr">{t('updateFileSize').replace('{size}', size)}</p> : null}

        {status === 'downloading' && (
          <div>
            <div className="h-2 rounded-full bg-muted overflow-hidden" aria-hidden="true">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('updateDownloading')} {progress?.percent ? `${progress.percent}%` : ''}
            </p>
          </div>
        )}
        {status === 'downloaded' && (
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{t('updateDownloaded')}</p>
        )}
        {status === 'error' && (
          <p className="text-sm text-destructive">{t('updateFailedDownload')}</p>
        )}
        {needsInstallPermission && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('updateAllowInstallPermission')}</p>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {(status === 'available' || status === 'checking') && (
            <Button variant="ghost" onClick={() => { postpone(); closeDialog(); }}>
              {t('updateNoticeLater')}
            </Button>
          )}
          {status === 'available' && (
            <Button onClick={() => void startDownload()} className="gap-2">
              <Download className="h-4 w-4" />
              {t('updateNoticeInstall')}
            </Button>
          )}
          {status === 'error' && (
            <Button variant="outline" onClick={() => void startDownload()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              {t('updateRetry')}
            </Button>
          )}
          {status === 'downloaded' && (
            <Button onClick={() => void install()} className="gap-2">
              <Download className="h-4 w-4" />
              {t('updateInstallNow')}
            </Button>
          )}
          {status === 'installing' && (
            <Button disabled className="gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('updateInstalling')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shared manual-check handler for the sidebar button, the mobile More sheet
 * and the settings cards — runs the check and toasts the outcome. When the
 * user previously postponed THIS version the button reads "Update now" and
 * simply re-opens the dialog instead of re-checking.
 */
export async function runManualUpdateCheck(lang: 'ar' | 'en' | 'fr'): Promise<void> {
  const store = useAppUpdateStore.getState();
  const postponed = !!store.postponedVersion && store.postponedVersion === store.info?.version && store.status === 'available';
  if (postponed) {
    store.requestDialog();
    return;
  }
  const result = await manualUpdateCheck();
  if (result === 'available') {
    useAppUpdateStore.getState().requestDialog();
  } else if (result === 'failed') {
    toast.error(t('updateCheckFailedToast', lang));
  } else {
    toast.success(t('updateUpToDate', lang));
  }
}
