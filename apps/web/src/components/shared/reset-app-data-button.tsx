'use client';

/**
 * 0.6.20 — "Reset app data" (desktop fresh-install) sidebar action.
 *
 * Renders a destructive sidebar row that wipes EVERYTHING the app stored on
 * this device and relaunches it as if freshly installed:
 *   • main-process side (electronAPI.clearAllAppData → app:clear-all-data):
 *     local SQLite workspace DB (blasti-local/), local file store
 *     (blasti-files/), durable auth file (blasti-auth.json), local API
 *     session, diagnostic logs, and the renderer session storage (cookies,
 *     localStorage, sessionStorage, IndexedDB/WatermelonDB, service workers,
 *     HTTP caches) — then app.relaunch() + app.exit().
 *   • the CLOUD account and its data are never touched: after the relaunch
 *     the user signs in again and everything re-syncs from scratch.
 *
 * Desktop-only: renders null outside Electron. A hard confirmation dialog
 * states exactly what is erased (and that unsynced local files are lost)
 * before the irreversible wipe runs.
 */

import { useCallback, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { usePlatform } from '@/hooks/use-platform';
import { useLanguage } from '@/hooks/use-language';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export function ResetAppDataButton({ onDismiss }: { onDismiss?: () => void }) {
  const { platform } = usePlatform();
  const { t } = useLanguage();
  const [resetting, setResetting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const isElectron =
    !!platform?.isNative ||
    (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron'));

  const handleReset = useCallback(async () => {
    const w = typeof window !== 'undefined' ? (window as unknown as { electronAPI?: { clearAllAppData?: () => Promise<{ success: boolean; error?: string }> } }) : null;
    const api = w?.electronAPI;
    if (!api?.clearAllAppData) {
      toast.error(t('resetAppDataFailed' as never));
      return;
    }
    setResetting(true);
    try {
      // Best-effort immediate renderer sanity: kill persisted session state
      // synchronously so nothing keeps writing while the main process wipes.
      try { sessionStorage.clear(); } catch { /* ignore */ }
      const result = await api.clearAllAppData();
      if (!result?.success) {
        setResetting(false);
        toast.error((result?.error ? `${t('resetAppDataFailed' as never)} (${result.error})` : t('resetAppDataFailed' as never)) as never);
      }
      // success → the main process relaunches the app; nothing to render.
    } catch {
      setResetting(false);
      toast.error(t('resetAppDataFailed' as never));
    }
  }, [t]);

  if (!isElectron) return null;

  return (
    <>
      <AlertDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!resetting) setDialogOpen(o);
          if (!o) onDismiss?.();
        }}
      >
        <AlertDialogTrigger asChild>
          <button
            type="button"
            data-testid="reset-app-data-button"
            className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/10 transition-colors"
          >
            <RotateCcw className="h-5 w-5" />
            {t('resetAppData')}
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-orange-600" aria-hidden="true" />
              {t('resetAppDataTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-start">
                <p>{t('resetAppDataDesc')}</p>
                <p className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-emerald-800 dark:text-emerald-300">
                  {t('resetAppDataCloudNote')}
                </p>
                <p className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-amber-800 dark:text-amber-300">
                  {t('resetAppDataUnsyncedNote')}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>{t('cancel')}</AlertDialogCancel>
            <Button
              onClick={() => { void handleReset(); }}
              disabled={resetting}
              className="bg-orange-600 hover:bg-orange-700 text-white"
              data-testid="reset-app-data-confirm"
            >
              {resetting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin me-1" aria-hidden="true" />
                  {t('resetAppDataResetting')}
                </>
              ) : (
                t('resetAppDataConfirm')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
