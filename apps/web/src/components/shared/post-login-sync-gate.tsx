'use client';

/**
 * Task 46 — Post-Login Initial-Sync Loading Gate (desktop)
 *
 * The user-visible gap: after logging into the desktop app there was NO
 * loading screen until the initial workspace sync finished — the app jumped
 * straight to the dashboard while the local SQLite database was still being
 * imported in the background, so every list (branches, services, counters)
 * rendered empty and looked broken.
 *
 * This gate closes that gap:
 *   • Activates ONLY inside Electron (platform.isNative) and ONLY when the
 *     local API reports the workspace is not READY yet (fresh login / first
 *     import / resume / failure) — an already-synced workspace never sees it.
 *   • Polls GET http://127.0.0.1:3080/api/sync/initial-sync/status every
 *     800ms and renders the live stage (Agency → Users → Branches → …),
 *     step counter, imported-record count and a data checklist.
 *   • READY → brief success flash → auto-dismiss.
 *   • FAILED / 75s timeout → actionable card: Retry sync (re-runs the
 *     initial-sync endpoint) or "Continue anyway" (background sync keeps
 *     running — the app is local-first and usable).
 *   • Local API unreachable for >15s → dismiss silently (never hold the
 *     user hostage when there is nothing to wait for).
 *
 * Read-only + idempotent: it triggers nothing on its own — the login flow's
 * existing initialCloudSync() IPC remains the single sync trigger; the gate
 * only OBSERVES the engine through the status endpoint and gives the user
 * a manual retry handle when the run failed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { usePlatform } from '@/hooks/use-platform';
import { useLanguage } from '@/hooks/use-language';
import type { TranslationKeys } from '@/i18n';
import { Loader2, CheckCircle2, AlertTriangle, Database, RefreshCw, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { motion, AnimatePresence } from 'framer-motion';

const LOCAL_API_BASE = 'http://127.0.0.1:3080';
const POLL_INTERVAL_MS = 800;
const FAILED_AFTER_MS = 75_000;
const UNREACHABLE_GIVEUP_MS = 15_000;

interface SyncStatusPayload {
  success: boolean;
  state?: string;
  needsInitialSync?: boolean | null;
  lastError?: string | null;
  active?: boolean;
  lastProgress?: {
    type?: string;
    stage?: string;
    stageIndex?: number;
    totalStages?: number;
    count?: number;
    error?: string;
    at?: string;
  } | null;
  counts?: Record<string, number>;
  deferred?: { pending: number; quarantined: number };
}

const STAGE_LABEL_KEYS: Record<string, TranslationKeys> = {
  agency: 'syncStageAgency',
  users: 'syncStageUsers',
  branches: 'syncStageBranches',
  services: 'syncStageServices',
  counters: 'syncStageCounters',
  agencyStaff: 'syncStageStaff',
  queueSettings: 'syncStageQueueSettings',
  reservations: 'syncStageReservations',
  transactions: 'syncStageTransactions',
  notifications: 'syncStageNotifications',
  announcements: 'syncStageAnnouncements',
  reviews: 'syncStageReviews',
  favorites: 'syncStageFavorites',
  faqs: 'syncStageFaqs',
  'snapshot-bridge': 'syncStageSnapshotBridge',
  'deferred-retry': 'syncStageDeferredRetry',
  'reconciliation-branches': 'syncStageReconciliation',
  'reconciliation-services': 'syncStageReconciliation',
  'reconciliation-counters': 'syncStageReconciliation',
};

const CHECKLIST_MODELS = ['Agency', 'User', 'Branch', 'Service', 'Counter', 'AgencyStaff', 'Reservation'] as const;

type Phase = 'preparing' | 'syncing' | 'success' | 'failed';

export function PostLoginSyncGate() {
  const user = useAppStore((s) => s.user);
  const { platform } = usePlatform();
  const { t, lang } = useLanguage();

  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [status, setStatus] = useState<SyncStatusPayload | null>(null);
  const [retrying, setRetrying] = useState(false);

  const everShownRef = useRef(false);
  const dismissedRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isElectron = !!platform?.isNative || (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron'));

  const stageLabel = useCallback((stage?: string | null): string => {
    if (!stage) return t('syncImportingData');
    const key = STAGE_LABEL_KEYS[stage];
    return key ? t(key) : t('syncImportingData');
  }, [t]);

  useEffect(() => {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    // Reset per-session state when the logged-in user changes.
    everShownRef.current = false;
    dismissedRef.current = false;
    setVisible(false);
    setStatus(null);
    setPhase('preparing');

    if (!isElectron || !user) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const stop = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const handleStatus = (data: SyncStatusPayload): 'continue' | 'stop' => {
      if (cancelled) return 'stop';
      setStatus(data);

      const st = (data.state || 'UNKNOWN').toUpperCase();
      const active = !!data.active;
      const elapsed = Date.now() - startedAt;

      // Terminal success: workspace READY and no run in flight.
      if (st === 'READY' && !active) {
        if (everShownRef.current && !dismissedRef.current) {
          // The gate WAS shown (import ran during this session) → brief
          // success flash, then auto-dismiss.
          setPhase('success');
          setVisible(true);
          successTimerRef.current = setTimeout(() => {
            if (!cancelled) setVisible(false);
          }, 1400);
        } else {
          // Already-synced workspace → never flash anything.
          setVisible(false);
        }
        return 'stop';
      }

      if (dismissedRef.current) return 'stop';

      // Failure (state machine FAILED with no live run retrying).
      if (st === 'FAILED' && !active) {
        everShownRef.current = true;
        setVisible(true);
        setPhase('failed');
        return 'continue'; // keep polling — a retry from here re-runs the import
      }

      // Timeout: after FAILED_AFTER_MS treat "still not ready" as failed
      // UNLESS a run is genuinely active (long imports are legitimate).
      if (elapsed > FAILED_AFTER_MS && !active && st !== 'READY') {
        everShownRef.current = true;
        setVisible(true);
        setPhase('failed');
        return 'continue';
      }

      // In-flight or pending → show the gate (preparing until the run starts).
      if (st === 'INITIALIZING' || active || st === 'NOT_INITIALIZED' || st === 'UPGRADING' || st === 'UNKNOWN') {
        if (!everShownRef.current) {
          everShownRef.current = true;
        }
        setVisible(true);
        setPhase(active || st === 'INITIALIZING' ? 'syncing' : 'preparing');
        return 'continue';
      }

      return 'continue';
    };

    const poll = async () => {
      try {
        const res = await fetch(`${LOCAL_API_BASE}/api/sync/initial-sync/status`, { cache: 'no-store' });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as SyncStatusPayload;
          if (handleStatus(data) === 'stop') return;
        } else if (Date.now() - startedAt > UNREACHABLE_GIVEUP_MS) {
          // Local API answered but errored repeatedly — don't hold the user.
          if (!everShownRef.current) { setVisible(false); return; }
        }
      } catch {
        // Local API unreachable (e.g. non-desktop-like environment or the
        // shell is still booting) — give it a grace window, then let the
        // user through; the background engine will sync when it appears.
        if (Date.now() - startedAt > UNREACHABLE_GIVEUP_MS) {
          if (!everShownRef.current) { setVisible(false); return; }
          // Gate was shown (import was running) but the API vanished —
          // keep waiting a bit longer; the FAILED timeout still applies.
        }
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();

    return () => {
      cancelled = true;
      stop();
    };
  }, [isElectron, user?.id]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setPhase('syncing');
    dismissedRef.current = false;
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('blasti-local-api-token') : null;
      await fetch(`${LOCAL_API_BASE}/api/sync/initial-sync/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'omit',
      });
    } catch { /* the poll loop reflects the outcome */ }
    setRetrying(false);
  }, []);

  const handleContinueAnyway = useCallback(() => {
    dismissedRef.current = true;
    setVisible(false);
  }, []);

  if (!visible) return null;

  const progress = status?.lastProgress;
  const totalStages = progress?.totalStages ?? null;
  const stageIndex = progress?.stageIndex ?? null;
  const pct = totalStages && stageIndex != null
    ? Math.min(100, Math.round(((stageIndex + 1) / totalStages) * 100))
    : phase === 'success' ? 100 : null;
  const importedCount = progress?.count;
  const counts = status?.counts || {};
  const isFailed = phase === 'failed';
  const isTimedOut = isFailed && !status?.lastError;

  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  return (
    <AnimatePresence>
      <motion.div
        key="post-login-sync-gate"
        data-testid="post-login-sync-gate"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-background/98 backdrop-blur-sm"
        dir={dir}
        role="dialog"
        aria-modal="true"
        aria-label={t('syncPreparingWorkspace')}
      >
        <div className="w-full max-w-md mx-4 sm:mx-6">
          <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-xl text-center">
            {/* Spinner / success / failure icon */}
            <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              {phase === 'success' ? (
                <CheckCircle2 className="h-9 w-9 text-emerald-600" aria-hidden="true" />
              ) : isFailed ? (
                <AlertTriangle className="h-9 w-9 text-amber-600" aria-hidden="true" />
              ) : (
                <Loader2 className="h-9 w-9 text-primary animate-spin" aria-hidden="true" />
              )}
            </div>

            <h2 className="text-lg font-semibold text-foreground">
              {phase === 'success'
                ? t('syncWorkspaceReady')
                : isFailed
                  ? t('syncWorkspaceFailed')
                  : t('syncPreparingWorkspace')}
            </h2>

            {!isFailed && phase !== 'success' && (
              <p className="mt-2 text-sm text-muted-foreground">
                {t('syncImportingData')}
              </p>
            )}

            {/* Live stage + step counter */}
            {(phase === 'syncing' || phase === 'preparing') && (
              <div className="mt-5 space-y-3" aria-live="polite">
                <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
                  <Database className="h-4 w-4 text-primary" aria-hidden="true" />
                  <span data-testid="sync-stage-label">{stageLabel(progress?.stage)}</span>
                </div>
                {totalStages != null && stageIndex != null && (
                  <p className="text-xs text-muted-foreground">
                    {t('syncStep', { current: String(stageIndex + 1), total: String(totalStages) })}
                  </p>
                )}
                {typeof importedCount === 'number' && importedCount > 0 && (
                  <p className="text-xs text-muted-foreground" data-testid="sync-records-imported">
                    {t('syncRecordsImported', { count: String(importedCount) })}
                  </p>
                )}
                {pct != null && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}

                {/* Data checklist — what actually arrived */}
                <div className="pt-2">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{t('syncDataChecklist')}</p>
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    {CHECKLIST_MODELS.map((model) => {
                      const n = counts[model];
                      const arrived = typeof n === 'number' && n > 0;
                      return (
                        <span
                          key={model}
                          data-testid={`sync-count-${model}`}
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${
                            arrived
                              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {typeof n === 'number' && n > 0 ? `${model} · ${n}` : model}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Failure / timeout card */}
            {isFailed && (
              <div className="mt-5 space-y-4 text-start">
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-800 dark:text-amber-300">
                  <p className="font-medium">{isTimedOut ? t('syncTimeout') : t('syncWorkspaceFailed')}</p>
                  {status?.lastError && (
                    <p className="mt-1 break-words font-mono text-[11px] opacity-80">{status.lastError}</p>
                  )}
                  <p className="mt-2">{t('syncDataIncomplete')}</p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={handleRetry}
                    disabled={retrying}
                    className="flex-1"
                    data-testid="sync-retry-button"
                  >
                    <RefreshCw className={`h-4 w-4 ${lang === 'ar' ? 'me-2' : 'me-2'} ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" />
                    {t('syncRetry')}
                  </Button>
                  <Button
                    onClick={handleContinueAnyway}
                    variant="outline"
                    className="flex-1"
                    data-testid="sync-continue-button"
                  >
                    {t('syncContinueAnyway')}
                    <ArrowRight className={`h-4 w-4 ${lang === 'ar' ? 'me-2 rotate-180' : 'ms-2'}`} aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )}

            {/* Dismiss hint for slow-but-alive syncs */}
            {!isFailed && phase === 'syncing' && (
              <button
                onClick={handleContinueAnyway}
                className="mt-6 text-xs text-muted-foreground underline-offset-4 hover:underline"
                data-testid="sync-skip-link"
              >
                {t('syncContinueAnyway')}
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
