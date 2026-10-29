'use client';

/**
 * BLASTI Update Notice — delivers pushed updates INSIDE the desktop app.
 *
 * The desktop shell (apps/desktop/device-telemetry.js) registers this machine
 * with the cloud and heartbeats every 6h. When the admin's Public App Settings
 * update-pusher targets a version newer than the installed one, the cloud
 * check-in response carries the push and the shell forwards it to the renderer
 * as the 'update:available' IPC event. This component renders it:
 *   • OPTIONAL push → dismissable dialog: message, target version, and a
 *     "Download update" button that opens the exact installer (update:install
 *     IPC → shell.openExternal of the pushed downloadUrl).
 *   • MANDATORY push → non-dismissable dialog: the app stays blocked until
 *     the user installs the new version.
 *
 * No-op on plain browsers and Capacitor (mobile updates are store APKs).
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Download, ShieldAlert, Sparkles } from 'lucide-react';

interface PushedUpdateInfo {
  version?: string;
  currentVersion?: string;
  isMandatory?: boolean;
  releaseNotes?: string;
  releaseNotesAr?: string;
  releaseNotesFr?: string;
  downloadUrl?: string;
  push?: { message?: string; messageAr?: string; messageFr?: string; isMandatory?: boolean } | null;
}

export function UpdateNotice() {
  const { t, lang } = useLanguage();
  const [info, setInfo] = useState<PushedUpdateInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: {
        onUpdateAvailable?: (cb: (raw: unknown) => void) => void;
        installUpdate?: () => void;
      };
    }).electronAPI;
    if (!electronAPI?.onUpdateAvailable) return;

    electronAPI.onUpdateAvailable((raw: unknown) => {
      const payload = (raw ?? {}) as PushedUpdateInfo;
      setInfo(payload);
      setOpen(true);
      // Also surface an OS notification so the push is noticed even when the
      // window is not focused (the shell's notification IPC shows a toast).
      try {
        const message = pickMessage(payload, lang);
        (window as unknown as { electronAPI?: { sendNotification?: (t: string, b: string) => void } }).electronAPI?.sendNotification?.(
          lang === 'ar' ? 'تحديث جديد متوفر' : lang === 'fr' ? 'Nouvelle mise à jour' : 'New update available',
          message,
        );
      } catch { /* best-effort */ }
    });
    // Subscribe once per mount; the preload listener replaces nothing.
  }, [lang]);

  if (!info) return null;
  const mandatory = info.isMandatory === true || info.push?.isMandatory === true;

  function pickMessage(payload: PushedUpdateInfo, currentLang: string): string {
    const push = payload.push;
    if (push) {
      if (currentLang === 'ar' && push.messageAr) return push.messageAr;
      if (currentLang === 'fr' && push.messageFr) return push.messageFr;
      if (push.message) return push.message;
    }
    const notes =
      currentLang === 'ar' ? payload.releaseNotesAr : currentLang === 'fr' ? payload.releaseNotesFr : payload.releaseNotes;
    return notes || '';
  }

  function handleInstall() {
    try {
      (window as unknown as { electronAPI?: { installUpdate?: () => void } }).electronAPI?.installUpdate?.();
    } catch { /* best-effort */ }
  }

  const message = pickMessage(info, lang);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Mandatory pushes cannot be dismissed — the app stays blocked until
        // the user installs the pushed version.
        if (!mandatory) setOpen(next);
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        aria-describedby={undefined}
        // hide the X entirely for mandatory pushes
        showCloseButton={!mandatory}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {mandatory ? (
              <ShieldAlert className="h-5 w-5 text-destructive" />
            ) : (
              <Sparkles className="h-5 w-5 text-primary" />
            )}
            {mandatory ? t('updateNoticeMandatoryTitle') : t('updateNoticeTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('updateNoticeVersionLine')
              .replace('{from}', info.currentVersion ?? '')
              .replace('{to}', info.version ?? '')}
          </DialogDescription>
        </DialogHeader>
        {message ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line max-h-40 overflow-y-auto">
            {message}
          </p>
        ) : null}
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          {!mandatory && (
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('updateNoticeLater')}
            </Button>
          )}
          <Button onClick={handleInstall} className="gap-2">
            <Download className="h-4 w-4" />
            {t('updateNoticeInstall')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
