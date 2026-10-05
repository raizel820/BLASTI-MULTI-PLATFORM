'use client';
/**
 * Task 80 — Biometric login settings card (SHARED, all account types).
 *
 * One card, dropped into every settings surface (customer / agency / admin),
 * that manages biometric quick-unlock FOR THIS DEVICE:
 *
 *  • Visibility: rendered ONLY on devices with active biometric support
 *    (phones/tablets with fingerprint/face sensors via the Capacitor
 *    keystore bridge). The availability probe
 *    (nativeBridge.isBiometricsAvailable → @capgo/capacitor-native-biometric
 *    on Capacitor) decides:
 *      - Capacitor phone/tablet with enrolled biometrics → fully functional.
 *      - Web browser / Electron desktop / phones without enrolled sensors →
 *        the whole card is HIDDEN (user requirement: biometric settings must
 *        only appear on devices that can actually use them). The card stays
 *        visible in the rare case biometrics vanished while a credential is
 *        still enrolled, so the user can switch it off.
 *  • Enable flow: fingerprint prompt → password confirm dialog → credentials
 *    verified against POST /api/auth/login (no expectedRole — this is the
 *    ALREADY-logged-in user re-proving identity) → secret stored in the
 *    device keystore (setBiometricCredentials) → store flag persisted
 *    (biometricLoginEnabled + biometricUsername).
 *  • Disable flow: keystore credential deleted + flag cleared.
 *
 * The stored secret NEVER touches JS state beyond the enable dialog and is
 * never sent anywhere except the login endpoint during verification.
 */

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { nativeBridge } from '@/lib/native-bridge';
import { apiFetch } from '@/lib/api-fetch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Fingerprint,
  ShieldCheck,
  Loader2,
  Info,
  Eye,
  EyeOff,
  Smartphone,
} from 'lucide-react';
import { toast } from 'sonner';

export function BiometricSettingsCard() {
  const { t } = useLanguage();
  const user = useAppStore((s) => s.user);
  const biometricLoginEnabled = useAppStore((s) => s.biometricLoginEnabled);
  const biometricUsername = useAppStore((s) => s.biometricUsername);
  const biometricOnAppOpen = useAppStore((s) => s.biometricOnAppOpen);
  const setBiometricLogin = useAppStore((s) => s.setBiometricLogin);
  const setBiometricOnAppOpen = useAppStore((s) => s.setBiometricOnAppOpen);

  const [probing, setProbing] = useState(true);
  const [available, setAvailable] = useState(false);

  // Enable dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmUsername, setConfirmUsername] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Disable flow
  const [disabling, setDisabling] = useState(false);

  // Refs rule: mirror availability so the enable handler never reads stale state.
  const availableRef = useRef(false);
  useEffect(() => {
    availableRef.current = available;
  }, [available]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = await nativeBridge.isBiometricsAvailable();
        if (!cancelled) setAvailable(ok);
      } catch {
        if (!cancelled) setAvailable(false);
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openEnableDialog = () => {
    setConfirmUsername(user?.username ?? biometricUsername ?? '');
    setConfirmPassword('');
    setShowPassword(false);
    setDialogOpen(true);
  };

  const handleEnabledToggle = (checked: boolean) => {
    if (verifying || disabling) return;
    if (checked) {
      if (!availableRef.current) return;
      openEnableDialog();
    } else {
      void handleDisable();
    }
  };

  const handleDisable = async () => {
    setDisabling(true);
    try {
      const owner = biometricUsername ?? user?.username ?? '';
      if (owner) {
        await nativeBridge.deleteBiometricCredentials(owner);
      }
      setBiometricLogin(false, null);
      toast.success(t('biometricDisabled'));
    } finally {
      setDisabling(false);
    }
  };

  /** Verify the typed credentials, then enrol the secret in the keystore. */
  const handleConfirmEnable = async () => {
    if (!confirmUsername.trim() || !confirmPassword) {
      toast.error(t('requiredField'));
      return;
    }
    setVerifying(true);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: confirmUsername.trim(),
          password: confirmPassword,
        }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.user) {
        toast.error(data?.error || t('invalidCredentials'));
        return;
      }
      if (data.requiresVerification) {
        // Account uses OTP verification — cannot enrol silently.
        toast.error(t('biometricVerifyFailed'));
        return;
      }

      // Credential proven — biometric-prompt once as the final consent, then
      // store the secret in the device keystore.
      const biometricOk = await nativeBridge.authenticateWithBiometrics(
        t('biometricEnableReason'),
      );
      if (!biometricOk) {
        toast.error(t('biometricVerifyFailed'));
        return;
      }

      await nativeBridge.setBiometricCredentials(
        confirmUsername.trim(),
        confirmPassword,
      );
      setBiometricLogin(true, confirmUsername.trim());
      setDialogOpen(false);
      setConfirmPassword('');
      toast.success(t('biometricEnabled'));
    } catch {
      toast.error(t('biometricVerifyFailed'));
    } finally {
      setVerifying(false);
    }
  };

  const functional = available && !probing;

  // Hide entirely on devices without active biometric support — unless a
  // credential is still enrolled (probe regressed), in which case the user
  // needs the card to be able to turn it off.
  if (!probing && !available && !biometricLoginEnabled) return null;

  return (
    <div
      className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 p-4"
      data-testid="biometric-settings-card"
    >
      <div className="flex items-start gap-3">
        <div
          className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
            functional
              ? biometricLoginEnabled
                ? 'bg-emerald-100 dark:bg-emerald-900/40'
                : 'bg-muted'
              : 'bg-muted'
          }`}
        >
          <Fingerprint
            className={`h-5 w-5 ${
              functional
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
            }`}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-foreground">
              {t('biometricLogin')}
            </p>
            {biometricLoginEnabled && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-0 text-[10px]">
                <ShieldCheck className="h-3 w-3 me-1" />
                {t('biometricOn')}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {probing
              ? t('biometricChecking')
              : functional
                ? t('biometricDesc')
                : t('biometricUnavailableDesc')}
          </p>
          {biometricLoginEnabled && biometricUsername && (
            <p className="text-[11px] text-muted-foreground mt-1">
              {t('biometricEnrolledAs')}{' '}
              <span className="font-medium text-foreground">@{biometricUsername}</span>
            </p>
          )}
        </div>

        <Switch
          checked={biometricLoginEnabled}
          disabled={!functional || verifying || disabling}
          onCheckedChange={handleEnabledToggle}
          aria-label={t('biometricLogin')}
        />
      </div>

      {/* Task 81 — ask for biometrics on EVERY app open while the account is
          active (lock screen on launch / return from background). Depends on
          the enrolled credential above, hence disabled until it is on. */}
      <div
        className="mt-3 pt-3 border-t border-border flex items-start gap-3"
        data-testid="biometric-app-open-row"
      >
        <div
          className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
            functional && biometricLoginEnabled
              ? 'bg-emerald-50 dark:bg-emerald-900/20'
              : 'bg-muted'
          }`}
        >
          <Smartphone
            className={`h-5 w-5 ${
              functional && biometricLoginEnabled
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-muted-foreground'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{t('biometricEveryOpen')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {!functional
              ? t('biometricUnavailableDesc')
              : !biometricLoginEnabled
                ? t('biometricEveryOpenNeedsEnable')
                : t('biometricEveryOpenDesc')}
          </p>
        </div>
        <Switch
          checked={functional && biometricLoginEnabled && biometricOnAppOpen}
          disabled={!functional || !biometricLoginEnabled || verifying || disabling}
          onCheckedChange={(checked) => setBiometricOnAppOpen(checked)}
          aria-label={t('biometricEveryOpen')}
        />
      </div>

      {/* Enable flow — confirm identity once before storing the secret */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!verifying) setDialogOpen(open); }}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Fingerprint className="h-5 w-5 text-emerald-600" />
              {t('biometricEnableTitle')}
            </DialogTitle>
            <DialogDescription>{t('biometricEnableDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="biometric-username">{t('username')}</Label>
              <Input
                id="biometric-username"
                value={confirmUsername}
                onChange={(e) => setConfirmUsername(e.target.value)}
                autoComplete="username"
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="biometric-password">{t('password')}</Label>
              <div className="relative">
                <Input
                  id="biometric-password"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="current-password"
                  dir="ltr"
                  className="pe-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-xl bg-muted/60 dark:bg-gray-800/60 p-3">
              <Info className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">{t('biometricStorageNote')}</p>
            </div>
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={verifying}
              className="rounded-xl h-10"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleConfirmEnable}
              disabled={verifying}
              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10"
            >
              {verifying ? (
                <Loader2 className="h-4 w-4 animate-spin me-2" />
              ) : (
                <Fingerprint className="h-4 w-4 me-2" />
              )}
              {t('biometricEnableConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
