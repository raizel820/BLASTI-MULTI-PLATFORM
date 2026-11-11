'use client';

/**
 * ConnectivityGate — 0.6.68 hard gate for internet-dependent views.
 *
 * Requested behavior: the account-creation page must NOT open without a
 * working server connection. Registration is a cloud-native flow end to end
 * (verification codes → account confirmation → agency creation — all proxied
 * to the cloud), so letting the user into the wizard offline only guarantees
 * a mid-wizard "requires an internet connection" failure after they filled
 * everything in. The gate verifies reachability FIRST and mounts the form
 * ONLY once the server answered.
 *
 * Platform-aware probe (the two runtimes differ in where /api/health points):
 *  - Electron: the renderer's base URL is the EMBEDDED LOCAL API, which
 *    always answers even fully offline — so the probe targets the local
 *    /api/cloud-status route, whose `reachable` field is the local API's own
 *    live view of the cloud (sync-engine fast verdict + real fallback probe).
 *  - Web / Capacitor: /api/health IS the server (same-origin via the VPS
 *    gateway, or the resolved native cloud URL) — a direct probe decides.
 *    navigator.onLine === false short-circuits without a network round trip.
 *
 * While blocked: a branded card explains WHY the page is locked, auto
 * re-probes every 12 s and instantly on the browser's `online` event, and
 * offers a manual retry. No state is written; the gate is purely presentational
 * around `children`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { apiClient, isElectronRuntime } from '@/lib/api-client';
import { diag } from '@/lib/diag-log';

type GateStatus = 'checking' | 'blocked' | 'ready';

/** One reachability decision. Cheap, cache-free, never throws. */
async function probeServerConnection(): Promise<boolean> {
  if (isElectronRuntime()) {
    // The local API is the only thing the renderer can reliably ask; it
    // reports whether the CLOUD behind it is currently reachable.
    try {
      const res = await apiClient
        .get<{ reachable?: boolean }>('/api/cloud-status', { cacheTtl: 0, timeout: 9_000 })
        .catch(() => null);
      return res?.data?.reachable === true;
    } catch {
      return false;
    }
  }
  // Web / Capacitor — the OS may already know we are offline (wifi off,
  // airplane mode): skip the round trip.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const res = await apiClient.get('/api/health', { cacheTtl: 0, timeout: 8_000 }).catch(() => null);
    // Any HTTP answer proves the server path is alive (reachability probe —
    // NOT a business-health check, so non-200 still unlocks the page).
    return !!res && res.status > 0;
  } catch {
    return false;
  }
}

export function ConnectivityGate({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<GateStatus>('checking');
  const [attempt, setAttempt] = useState(0); // manual/auto retry trigger
  const mountedRef = useRef(true);
  // 'loud' probes show the spinner (first check + manual retries); silent
  // probes (the 12 s auto-retry / `online` event) keep the blocked card on
  // screen so the user never watches the UI flicker between states.
  const loudRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const runProbe = useCallback(async () => {
    if (loudRef.current) setStatus((s) => (s === 'ready' ? s : 'checking'));
    const ok = await probeServerConnection();
    if (!mountedRef.current) return;
    loudRef.current = false; // auto-retries stay silent behind the blocked card
    diag(ok ? 'register-gate-open' : 'register-gate-blocked', {});
    setStatus(ok ? 'ready' : 'blocked');
  }, []);

  // Initial probe + every retry trigger (attempt counter).
  useEffect(() => {
    void runProbe();
  }, [runProbe, attempt]);

  // While blocked: auto re-probe every 12 s and INSTANTLY on the browser's
  // `online` event (wifi reconnected / airplane mode off).
  useEffect(() => {
    if (status !== 'blocked') return;
    const interval = setInterval(() => setAttempt((n) => n + 1), 12_000);
    const onOnline = () => setAttempt((n) => n + 1);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
    };
  }, [status]);

  const manualRetry = useCallback(() => {
    loudRef.current = true; // a deliberate tap deserves visible feedback
    setAttempt((n) => n + 1);
  }, []);

  if (status === 'ready') return <>{children}</>;

  if (status === 'checking') {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-4" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="h-14 w-14 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center">
            <Loader2 className="h-7 w-7 text-emerald-600 dark:text-emerald-400 animate-spin" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">{t('registerGateChecking' as never)}</p>
        </div>
      </div>
    );
  }

  // blocked
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4" aria-live="assertive">
      <div className="w-full max-w-md rounded-2xl border border-amber-200/70 dark:border-amber-900/40 bg-card p-6 sm:p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 dark:bg-amber-900/30">
          <WifiOff className="h-8 w-8 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        </div>
        <h2 className="text-lg sm:text-xl font-bold text-foreground mb-2">
          {t('registerGateTitle' as never)}
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          {t('registerGateDesc' as never)}
        </p>
        <p className="text-xs text-muted-foreground/80 leading-relaxed mb-6">
          {t('registerGateHint' as never)}
        </p>
        <button
          type="button"
          onClick={manualRetry}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t('registerGateRetry' as never)}
        </button>
      </div>
    </div>
  );
}
