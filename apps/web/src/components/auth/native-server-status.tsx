'use client';

/**
 * NativeServerStatus — Capacitor-only server connection indicator + fix dialog.
 *
 * THE PROBLEM THIS SOLVES: the mobile APK ships with a build-time API URL that
 * defaults to the Android EMULATOR alias (10.0.2.2:3003). On a physical phone
 * that address is unreachable and login silently fails. The runtime resolver
 * (lib/native-cloud-resolver.ts) finds the PC's LAN address automatically; this
 * component makes that process VISIBLE and gives the user a manual escape hatch
 * (enter the PC's IP) when auto-discovery can't run (e.g. AP-isolated Wi-Fi).
 *
 * Shown on the login screen only when running inside the Capacitor shell.
 */

import { useEffect, useState, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { usePlatform } from '@/hooks/use-platform';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Server, ServerCrash, Settings2, Wifi } from 'lucide-react';
import { toast } from 'sonner';
import {
  ensureNativeCloudUrl,
  getNativeCloudState,
  getNormalizedManualCloudUrl,
  onNativeCloudStateChange,
  setManualCloudUrl,
  type NativeCloudState,
} from '@/lib/native-cloud-resolver';

// ⚠️ NativeServerStatus is instantiated on BOTH login screens (customer
// login-form and desktop-agency-login) — keep them in sync.

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function NativeServerStatus() {
  const { t } = useLanguage();
  const { platform } = usePlatform();
  const [state, setState] = useState<NativeCloudState>(() => getNativeCloudState());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addressInput, setAddressInput] = useState('');
  const [saving, setSaving] = useState(false);

  const isNativeShell = platform.isCapacitor;

  useEffect(() => {
    if (!isNativeShell) return;
    // Kick a scan on mount too (in case api-client's boot run already finished
    // before this component mounted — the subscription below keeps us current).
    void ensureNativeCloudUrl().catch(() => null);
    const unsub = onNativeCloudStateChange(setState);
    return () => { unsub(); };
  }, [isNativeShell]);

  // Pre-fill the input with the current address whenever the dialog opens.
  const openDialog = useCallback(() => {
    setAddressInput(getNormalizedManualCloudUrl() || state.url || '');
    setDialogOpen(true);
  }, [state.url]);

  if (!isNativeShell) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      // setManualCloudUrl returns null when the input can't be parsed as a URL.
      const normalized = setManualCloudUrl(addressInput.trim() || null);
      if (addressInput.trim() && !normalized) {
        toast.error(t('serverInvalidAddress'));
        return;
      }
      // Force a re-run: the resolver validates the override first and adopts
      // it only when the server actually answers /api/discover.
      const resolved = await ensureNativeCloudUrl({ manualOnly: true });
      if (resolved) {
        toast.success(t('serverSavedConnected'), {
          description: hostOf(resolved),
        });
        setDialogOpen(false);
      } else {
        toast.error(t('serverStillNotFound'), {
          description: t('serverHelpFirewall'),
          duration: 8000,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRescan = async () => {
    setSaving(true);
    try {
      await ensureNativeCloudUrl({ force: true });
    } finally {
      setSaving(false);
    }
  };

  // ── Pill states ────────────────────────────────────────────────────────────
  const scanning = state.status === 'scanning' && !state.url;
  const connected = state.status === 'found' && !!state.url;
  const failed = (state.status === 'failed' || (!state.url && state.status === 'idle')) && !scanning;

  const pillLabel = scanning
    ? t('serverLookingForPc')
    : connected
      ? t('serverConnectedTo', { host: hostOf(state.url) })
      : t('serverNotFoundTap');

  const pillClasses = connected
    ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/80 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
    : failed
      ? 'border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
      : 'border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-900/60 text-muted-foreground';

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        data-testid="native-server-status"
        className={`w-full flex items-center gap-2 rounded-xl border px-3 py-2 text-xs sm:text-sm transition-colors hover:brightness-[0.98] ${pillClasses}`}
        aria-live="polite"
      >
        {scanning ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        ) : connected ? (
          <Wifi className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <ServerCrash className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="flex-1 text-start truncate" data-testid="native-server-status-text">
          {pillLabel}
        </span>
        <Settings2 className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
      </button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="h-5 w-5 text-emerald-600" aria-hidden="true" />
              {t('serverDialogTitle')}
            </DialogTitle>
            <DialogDescription>{t('serverDialogDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="native-server-address">{t('serverAddressLabel')}</Label>
            <Input
              id="native-server-address"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              placeholder={t('serverAddressPlaceholder')}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            />
            <p className="text-xs text-muted-foreground">{t('serverHelpFirewall')}</p>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={handleRescan} disabled={saving} className="gap-2">
              {saving
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <Wifi className="h-4 w-4" aria-hidden="true" />}
              {t('serverRescan')}
            </Button>
            <Button onClick={handleSave} disabled={saving} className="gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
