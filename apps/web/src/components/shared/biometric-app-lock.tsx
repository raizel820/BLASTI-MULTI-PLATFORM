'use client';

/**
 * Task 81 — Biometric App Lock (all accounts, all devices).
 *
 * Implements the "use biometric login every time the app is opened while
 * the account is active" option from Settings → Security (biometricOnAppOpen):
 *
 *  • When the flag is ON, the account is signed in, and this device has an
 *    enrolled biometric credential + available biometrics, a full-screen
 *    lock challenges biometrics on:
 *      - app open (mount after persisted-state rehydration), and
 *      - every return from the background (visibilitychange — this is how
 *        "opening the app" behaves for an app kept in memory on phones).
 *  • Success → unlock. Failure/cancel → the lock stays with a Retry button
 *    and a "sign in with password" escape hatch (logs out — the login screen
 *    then offers biometric quick-unlock automatically when enrolled).
 *  • On web/Electron (no secure-enclave bridge) the gate is inert — the
 *    honest "unavailable" state, exactly like the settings card.
 *
 * Rendered once near the app root (page.tsx) so it covers every view.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { nativeBridge } from '@/lib/native-bridge';
import { Button } from '@/components/ui/button';
import { Fingerprint, Lock, Loader2, KeyRound } from 'lucide-react';

/** Re-lock debounce — avoids double prompts from visibility flicker. */
const UNLOCK_GRACE_MS = 2000;

export function BiometricAppLock() {
  const { t } = useLanguage();
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const biometricOnAppOpen = useAppStore((s) => s.biometricOnAppOpen);
  const biometricUsername = useAppStore((s) => s.biometricUsername);

  const [probing, setProbing] = useState(true);
  const [available, setAvailable] = useState(false);
  const [locked, setLocked] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [failed, setFailed] = useState(false);

  const lastUnlockAtRef = useRef(0);
  const promptedOnceRef = useRef(false);

  // Availability probe (Capacitor only — web/Electron stay false → inert).
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
    return () => { cancelled = true; };
  }, []);

  const gateActive = isAuthenticated && biometricOnAppOpen && available && !!biometricUsername;

  const runBiometricChallenge = useCallback(async () => {
    if (prompting) return;
    setPrompting(true);
    setFailed(false);
    try {
      const ok = await nativeBridge.authenticateWithBiometrics(t('biometricAppUnlockReason'));
      if (ok) {
        lastUnlockAtRef.current = Date.now();
        promptedOnceRef.current = false;
        setLocked(false);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPrompting(false);
    }
  }, [prompting, t]);

  const maybeLock = useCallback(() => {
    if (!gateActive) return;
    if (Date.now() - lastUnlockAtRef.current < UNLOCK_GRACE_MS) return;
    setLocked(true);
  }, [gateActive]);

  // App open — challenge once the availability probe has settled.
  useEffect(() => {
    if (probing || !gateActive || promptedOnceRef.current) return;
    promptedOnceRef.current = true;
    setLocked(true);
  }, [probing, gateActive]);

  // Return from the background = opening the app again (mobile lifecycle).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') maybeLock();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [maybeLock]);

  // Auto-fire the biometric prompt whenever the lock appears.
  useEffect(() => {
    if (locked && !probing && gateActive) void runBiometricChallenge();
     
  }, [locked]);

  // "Use password instead" — end the session; the login screen offers
  // biometric sign-in automatically when enrolled.
  const handleUsePassword = () => {
    setLocked(false);
    promptedOnceRef.current = false;
    useAppStore.getState().logout();
  };

  if (probing || !locked || !gateActive) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background/95 dark:bg-gray-950/95 backdrop-blur-md px-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('biometricAppLockTitle')}
      data-testid="biometric-app-lock"
    >
      <div className="w-full max-w-sm text-center space-y-6">
        <div className="mx-auto h-20 w-20 rounded-3xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shadow-lg shadow-emerald-500/10">
          {prompting ? (
            <Loader2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400 animate-spin" />
          ) : (
            <Lock className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
          )}
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-bold text-foreground">{t('biometricAppLockTitle')}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {failed ? t('biometricAppLockFailed') : t('biometricAppLockDesc')}
          </p>
        </div>

        <div className="space-y-2.5">
          <Button
            onClick={() => void runBiometricChallenge()}
            disabled={prompting}
            className="w-full h-12 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
          >
            {prompting ? (
              <Loader2 className="h-5 w-5 animate-spin me-2" />
            ) : (
              <Fingerprint className="h-5 w-5 me-2" />
            )}
            {t('biometricUnlockRetry')}
          </Button>
          <Button
            variant="outline"
            onClick={handleUsePassword}
            disabled={prompting}
            className="w-full h-12 rounded-2xl border-border text-foreground font-semibold"
          >
            <KeyRound className="h-5 w-5 me-2" />
            {t('biometricUsePassword')}
          </Button>
        </div>
      </div>
    </div>
  );
}
