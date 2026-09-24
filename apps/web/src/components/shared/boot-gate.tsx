'use client';

/**
 * BLASTI Boot Gate — branded full-screen splash (Task 41)
 *
 * Shown in place of the authenticated shell whenever a session becomes
 * active (fresh login OR app reload with a persisted session). It waits for:
 *   1. The WatermelonDB offline database to finish initializing, then
 *   2. One REAL sync cycle for the current session token (runSyncAndWait),
 * and only then hands over to the dashboard.
 *
 * WHY: the authenticated shell used to mount immediately after login while
 * the offline DB + first pull were still running, so dashboard screens fired
 * their API calls mid-sync and flashed "Failed to load data" until the user
 * refreshed. Gating the shell on the first completed sync removes that race;
 * the dashboard mounts with data already local.
 *
 * Safety bounds (offline-first — the user must never be trapped):
 *   - DB not ready within DB_WAIT_CAP_MS  → proceed without sync
 *   - Sync not done within MAX_WAIT_MS    → proceed anyway
 *   - Sync error                          → proceed (cached data + the
 *     periodic loop take over from here)
 * A minimum display time keeps the splash from flashing on fast boots.
 */

import { useEffect, useRef, useState } from 'react';
import { syncEngine } from '@/db/sync';
import { useDatabase, useDatabaseReady } from '@/db/provider';
import { useLanguage } from '@/hooks/use-language';

const MIN_DISPLAY_MS = 900;
const DB_WAIT_CAP_MS = 6000;
const MAX_WAIT_MS = 15000;
const SLOW_NOTE_AFTER_MS = 8000;

type BootPhase = 'preparing' | 'syncing' | 'finishing';

export function BootGate({ onDone }: { onDone: () => void }) {
  const { t } = useLanguage();
  const database = useDatabase();
  const dbReady = useDatabaseReady();
  const [phase, setPhase] = useState<BootPhase>('preparing');
  const [showSlowNote, setShowSlowNote] = useState(false);

  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];

    const finish = () => {
      if (cancelled || doneRef.current) return;
      doneRef.current = true;
      setPhase('finishing');
      // Respect the minimum display time so fast boots don't flash.
      const remaining = Math.max(0, MIN_DISPLAY_MS - (Date.now() - startedAt));
      timers.push(setTimeout(() => {
        if (!cancelled) onDoneRef.current();
      }, remaining));
    };

    // Hard overall bound — never trap the user behind the splash.
    timers.push(setTimeout(() => {
      console.warn('[BootGate] Max wait elapsed — proceeding to the dashboard');
      finish();
    }, MAX_WAIT_MS));

    // Slow-network courtesy note (does not release the gate by itself).
    timers.push(setTimeout(() => setShowSlowNote(true), SLOW_NOTE_AFTER_MS));

    if (!dbReady || !database) {
      // WatermelonDB failed to init or is slow — proceed without it; the
      // dashboard still works off the API layer and the periodic loop.
      timers.push(setTimeout(() => {
        console.warn('[BootGate] Offline DB not ready in time — proceeding without initial sync');
        finish();
      }, DB_WAIT_CAP_MS));
    } else {
      setPhase('syncing');
      syncEngine
        .runSyncAndWait(database)
        .catch(() => { /* sync errors already surfaced via sync-error */ })
        .finally(() => {
          if (!cancelled) finish();
        });
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [dbReady, database]);

  const phaseLabel =
    phase === 'syncing'
      ? t('bootSyncing')
      : phase === 'finishing'
        ? t('bootAlmostReady')
        : t('bootPreparing');

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-background px-4"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {/* Big app logo */}
      <div className="relative flex items-center justify-center">
        <div className="absolute inset-0 m-auto h-28 w-28 rounded-full bg-emerald-400/20 blur-2xl animate-pulse" aria-hidden="true" />
        <div className="relative h-24 w-24 rounded-3xl bg-white dark:bg-gray-900 shadow-lg shadow-emerald-500/10 ring-1 ring-border flex items-center justify-center overflow-hidden">
          <img src="/logo.png" alt="BLASTI" width={96} height={96} className="h-16 w-16 object-contain" />
        </div>
      </div>

      {/* App name — same branding as BlastiSkeleton */}
      <div className="mt-6 flex flex-col items-center gap-1">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="bg-gradient-to-r from-emerald-600 to-emerald-400 bg-clip-text text-transparent">
            BLASTI
          </span>
        </h1>
        <p className="text-sm text-muted-foreground">بلاصتي</p>
      </div>

      {/* Pulsing emerald gradient bar */}
      <div className="mt-8 w-52 h-1.5 rounded-full overflow-hidden bg-muted" aria-hidden="true">
        <div className="h-full w-full rounded-full bg-gradient-to-r from-emerald-500 via-emerald-300 to-emerald-500 animate-pulse origin-center" />
      </div>

      {/* Phase label */}
      <p className="mt-4 text-sm font-medium text-foreground/80 animate-pulse">{phaseLabel}</p>

      {/* Courtesy note on slow networks */}
      <div className="mt-2 h-5">
        {showSlowNote && phase !== 'finishing' && (
          <p className="text-xs text-muted-foreground">{t('bootSlowNote')}</p>
        )}
      </div>
    </div>
  );
}
