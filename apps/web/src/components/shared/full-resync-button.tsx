'use client';

/**
 * FullResyncButton — Task 2-c-2, sub-task 1: MANUAL FULL DATA RESYNC.
 *
 * ONE shared component serving AGENCY and CUSTOMER account settings in the
 * web bundle. Because apps/web is the shared bundle for web (Next.js),
 * mobile (Capacitor WebView) and desktop (Electron renderer), all three
 * surfaces get this button without any per-shell code.
 *
 * USER FLOW (exactly what was requested):
 *   button → AlertDialog ("Deletes all locally cached data except your
 *   login session, then re-downloads everything. The app restarts
 *   automatically.") → on confirm:
 *
 *   (a) Push pending offline work first (best-effort, 4s cap) so queued
 *       offline mutations are not lost with the queue store.
 *   (b) localStorage/sessionStorage: remove ALL keys EXCEPT the preserved
 *       list below. 'blasti-app' (the zustand persist) is special-cased:
 *       it is REWRITTEN keeping only its auth/session fields.
 *   (c) Service Worker: unregister every registration + delete EVERY
 *       CacheStorage bucket (caches.keys() → caches.delete()).
 *   (d) IndexedDB (best-effort, 1.5s race): delete every `blasti-*`
 *       database (offline caches + offline queue) EXCEPT the device-local
 *       notification-sound preferences. The ACTIVE WatermelonDB (LokiJS)
 *       databases are attempted too — an open connection blocks the delete
 *       (spec behavior) and the request is simply left pending; either way
 *       the full re-pull below converges the local database.
 *   (e) Set the action flag localStorage 'blasti-full-resync' = Date.now()
 *       (survives — it is on the preserved list) → location.reload().
 *
 * ON BOOT: the module top-level runs consumeFullResyncFlag() — a tiny
 * boot hook wired from THIS module (deliberately NOT auth-provider, per
 * task constraints). It clears the flag and, for AGENCY accounts,
 * best-effort triggers one extra cycle of the EXISTING sync engine
 * (syncEngine.sync via /api/sync/pull). The real full pull happens
 * naturally at boot: the wipe removes localStorage 'blasti-sync-cursor'
 * (the protocol-v2 pull cursor) and 'blasti-wdb-last-sync', so the
 * BootGate's runSyncAndWait pulls from sequence 0 = FULL re-download for
 * BOTH roles. For CUSTOMER accounts the fresh API fetches after the cache
 * wipe ARE the sync (customers are not WatermelonDB-synced).
 *
 * PRESERVED-KEY LIST (never cleared — auth/session only, plus three
 * documented pragmatic exceptions):
 *   localStorage:
 *     blasti-app              → zustand persist — REWRITTEN keeping ONLY
 *                               user, isAuthenticated, sessionToken,
 *                               rememberSession, sessionStartedAt,
 *                               lastSessionRefreshAt (the exact auth fields
 *                               lib/auth-storage.ts defines)
 *     blasti-local-api-token  → AUTH — api-client buildAuthHeaders contract
 *     blasti-session-token    → AUTH — native session key (durable mirror)
 *     blasti-remember-me      → AUTH POLICY — remember-me marker
 *     next-auth.session-token → AUTH — NextAuth-compatible mirror (defensive)
 *     blasti-lang             → UI preference (keeps the chosen language
 *                               across the reload; not user data)
 *     blasti-device-id        → DEVICE identity (offline-sync + push
 *                               registration identity; wiping would spawn a
 *                               duplicate device registration)
 *     blasti-full-resync      → THIS action flag (must survive to boot)
 *   sessionStorage:
 *     blasti-session-token    → AUTH — ephemeral session mirror (remember-me
 *                               OFF keeps the token HERE — wiping it would
 *                               force a re-login; preserved for real)
 *     blasti-local-api-token  → AUTH (defensive — normally localStorage only)
 *     next-auth.session-token → AUTH (defensive mirror)
 *     blasti-remember-me      → AUTH POLICY (defensive mirror)
 *     blasti-full-resync      → action flag (defensive: checked there too)
 *   IndexedDB:
 *     blasti-sounds           → device-local notification sound preferences
 *
 * NOTE (TanStack Query): the app does NOT use @tanstack/react-query
 * (verified — no QueryClient anywhere in apps/web/src), so there is no
 * queryClient.clear() step. In-memory zustand state dies with the reload.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import type { TranslationKeys } from '@/i18n';
import { Button } from '@/components/ui/button';
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
import { CloudDownload, Loader2 } from 'lucide-react';
import { useAppStore } from '@/store/use-app-store';

// ─── Keys ────────────────────────────────────────────────────────────────────

/** Action flag — written right before reload, consumed at boot. */
export const FULL_RESYNC_FLAG_KEY = 'blasti-full-resync';

/**
 * Auth/session keys that must NEVER be wiped. Mirrors lib/auth-storage.ts
 * (that file is read-only for this task — the names were read, not changed).
 */
export const AUTH_PRESERVED_LOCAL_KEYS: readonly string[] = [
  'blasti-local-api-token',
  'blasti-session-token',
  'blasti-remember-me',
  'next-auth.session-token',
];

/**
 * Pragmatic exceptions (NOT user data — wiped would only cause side
 * effects): language preference, device identity, this action flag,
 * and the NATIVE CLOUD RESOLVER keys — on phones a full sync used to wipe
 * `blasti-cloud-url-last-good` / `blasti-cloud-url-override`, so the app
 * could no longer find its server after the reload (LAN rescan on a network
 * that has no BLASTI server → dead 10.0.2.2 fallback → "can not load this
 * page"). Connectivity config, not user data — preserved.
 */
export const UI_PRESERVED_LOCAL_KEYS: readonly string[] = [
  'blasti-lang',
  'blasti-device-id',
  FULL_RESYNC_FLAG_KEY,
  'blasti-cloud-url-last-good',
  'blasti-cloud-url-override',
];

const PRESERVED_SESSION_KEYS: readonly string[] = [
  // AUTH mirrors live in sessionStorage too: an EPHEMERAL (remember-me OFF)
  // session keeps its token in sessionStorage 'blasti-session-token'
  // (lib/auth-storage.ts storeSessionToken). Wiping it would LOG THE USER
  // OUT — exactly what this button must never do. All auth keys are kept
  // here defensively (same list as localStorage), plus the action flag.
  ...AUTH_PRESERVED_LOCAL_KEYS,
  FULL_RESYNC_FLAG_KEY,
  // Mobile INTRO animation marker (app-intro-animation.tsx INTRO_KEY).
  // Wiping it made EVERY full resync replay the animated landing/intro on
  // reload instead of returning straight to the login/dashboard — the
  // "after full manual sync the app starts with the landing page" report.
  'blasti-intro-played',
];

/**
 * Auth fields kept inside the persisted zustand store ('blasti-app') —
 * the exact list lib/auth-storage.ts strips/preserves.
 */
const AUTH_STORE_FIELDS: readonly string[] = [
  'user',
  'isAuthenticated',
  'sessionToken',
  'rememberSession',
  'sessionStartedAt',
  'lastSessionRefreshAt',
];

/** Device-local IndexedDB stores that survive the resync. */
const PRESERVED_IDB_DATABASES: readonly string[] = ['blasti-sounds'];

// ─── Boot hook ───────────────────────────────────────────────────────────────

/**
 * Consume the resync flag (call once at boot). Returns true when a resync
 * had just happened. Clears the flag FIRST so a crash mid-hook cannot loop.
 */
export function consumeFullResyncFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const flagged =
      window.localStorage?.getItem(FULL_RESYNC_FLAG_KEY) ??
      window.sessionStorage?.getItem(FULL_RESYNC_FLAG_KEY);
    if (!flagged) return false;
    try { window.localStorage?.removeItem(FULL_RESYNC_FLAG_KEY); } catch { /* ignore */ }
    try { window.sessionStorage?.removeItem(FULL_RESYNC_FLAG_KEY); } catch { /* ignore */ }
    console.log('[FullResync] Boot after manual full resync — fresh pull happens via the wiped sync cursor (BootGate / fresh fetches)');

    // AGENCY accounts: best-effort extra pull through the EXISTING sync
    // engine (cloud /api/sync/pull). The DB may not be initialized yet this
    // early — BootGate's runSyncAndWait is the primary full-pull path (the
    // wiped cursor makes it a pull-from-zero), this only accelerates it.
    (async () => {
      try {
        // The zustand persist may not have rehydrated yet this early in the
        // boot — give it one bounded grace window before reading the role.
        let role = useAppStore.getState()?.user?.role;
        if (!role) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          role = useAppStore.getState()?.user?.role;
        }
        if (role !== 'AGENCY_OWNER' && role !== 'AGENCY_STAFF') return; // agency accounts only
        const [{ syncEngine }, { getDatabase }] = await Promise.all([
          import('@/db/sync'),
          import('@/db/client-database'),
        ]);
        const database = getDatabase();
        if (database) {
          void syncEngine.sync(database).catch(() => { /* best-effort */ });
          console.log('[FullResync] Triggered an extra sync cycle for the agency account');
        }
      } catch { /* best-effort — boot hook must never throw */ }
    })();

    return true;
  } catch {
    return false;
  }
}

// Module top-level boot check — runs once when this module first loads
// (settings sections import it). SSR-guarded, fire-and-forget.
if (typeof window !== 'undefined') {
  consumeFullResyncFlag();
}

// ─── The purge ───────────────────────────────────────────────────────────────

function listKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k) keys.push(k);
  }
  return keys;
}

/** Rewrite 'blasti-app' keeping ONLY the auth/session fields. */
function preserveAuthFieldsInPersistedStore(): void {
  try {
    const raw = window.localStorage.getItem('blasti-app');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; version?: unknown };
    if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state !== 'object') {
      // Malformed store — dropping it is safe (zustand rehydrates defaults;
      // the token mirrors below keep the session alive regardless).
      window.localStorage.removeItem('blasti-app');
      return;
    }
    const kept: Record<string, unknown> = {};
    for (const field of AUTH_STORE_FIELDS) {
      if (field in parsed.state) kept[field] = parsed.state[field];
    }
    window.localStorage.setItem(
      'blasti-app',
      JSON.stringify({ state: kept, ...(parsed.version !== undefined ? { version: parsed.version } : {}) }),
    );
  } catch {
    try { window.localStorage.removeItem('blasti-app'); } catch { /* ignore */ }
  }
}

/** Best-effort IndexedDB wipe (1.5s cap — a blocked delete must not stall). */
async function wipeIndexedDB(): Promise<void> {
  if (typeof window === 'undefined' || !window.indexedDB || !window.indexedDB.databases) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  const wipe = (async () => {
    try {
      const databases = await window.indexedDB.databases();
      await Promise.all(
        databases.map((d) => {
          const name = d.name;
          if (!name || !name.startsWith('blasti-')) return Promise.resolve();
          if (PRESERVED_IDB_DATABASES.includes(name)) return Promise.resolve();
          return new Promise<void>((resolve) => {
            try {
              const req = window.indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve(); // open connection — converges via re-pull
            } catch {
              resolve();
            }
          });
        }),
      );
    } catch { /* best-effort */ }
  })();
  await Promise.race([wipe, timeout]);
}

/**
 * Do the wipe and reload. Auth/session keys survive; everything else goes.
 * The reload rehydrates zustand, BootGate runs a REAL sync (wiped pull
 * cursor → full re-download), and all API fetches start cache-cold.
 */
export async function performFullResync(): Promise<void> {
  if (typeof window === 'undefined') return;

  // (a) Push pending offline mutations first (4s cap) so wiping the offline
  //     queue cannot lose created-offline work. Offline → the cap fires.
  try {
    const [{ syncEngine }, { getDatabase }] = await Promise.all([
      import('@/db/sync'),
      import('@/db/client-database'),
    ]);
    const database = getDatabase();
    if (database) {
      await Promise.race([
        syncEngine.sync(database).catch(() => { /* offline/blocked — proceed */ }),
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
    }
  } catch { /* best-effort */ }

  // (b) localStorage — preserved list only.
  try {
    const ls = window.localStorage;
    preserveAuthFieldsInPersistedStore();
    for (const key of listKeys(ls)) {
      if (key === 'blasti-app') continue; // rewritten above
      if (AUTH_PRESERVED_LOCAL_KEYS.includes(key)) continue;
      if (UI_PRESERVED_LOCAL_KEYS.includes(key)) continue;
      ls.removeItem(key);
    }
  } catch { /* storage unavailable — nothing to purge */ }

  // sessionStorage — only the ephemeral auth mirror + the flag survive.
  try {
    const ss = window.sessionStorage;
    for (const key of listKeys(ss)) {
      if (PRESERVED_SESSION_KEYS.includes(key)) continue;
      ss.removeItem(key);
    }
  } catch { /* ignore */ }

  // (c) Service workers + EVERY CacheStorage bucket.
  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister().catch(() => { /* ignore */ })));
    }
  } catch { /* ignore */ }
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((n) => caches.delete(n).catch(() => { /* ignore */ })));
    }
  } catch { /* ignore */ }

  // (d) IndexedDB data caches (bounded, best-effort).
  await wipeIndexedDB();

  // (e) Action flag (survives — on the preserved list) + reload.
  try {
    window.localStorage.setItem(FULL_RESYNC_FLAG_KEY, String(Date.now()));
  } catch { /* reload proceeds regardless */ }

  window.location.reload();
}

// ─── UI ──────────────────────────────────────────────────────────────────────

interface FullResyncButtonProps {
  className?: string;
}

/**
 * Account-level "Request full sync" action. Rendered in the account
 * settings of BOTH roles (agency + customer) — the settings sections are
 * part of the shared web bundle, so mobile (Capacitor) and desktop
 * (Electron) pick it up automatically.
 */
export function FullResyncButton({ className }: FullResyncButtonProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await performFullResync();
      // performFullResync reloads the page — if it somehow failed, unblock.
      setBusy(false);
      setOpen(false);
    } catch {
      setBusy(false);
    }
  }, [busy]);

  // Consume a leftover flag on mount too (belt-and-braces for the
  // module-level check — e.g. HMR edge cases).
  useEffect(() => {
    consumeFullResyncFlag();
  }, []);

  return (
    <div
      className={
        className ??
        'rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm p-4 space-y-3'
      }
    >
      <div className="flex items-start gap-2">
        <CloudDownload className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{t('fullSyncTitle' as TranslationKeys)}</p>
          <p className="text-xs text-muted-foreground">{t('fullSyncDesc' as TranslationKeys)}</p>
        </div>
      </div>
      <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full h-11 min-h-[44px] rounded-xl border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:border-emerald-800/60 dark:text-emerald-300 dark:hover:bg-emerald-900/20 font-semibold"
          >
            <CloudDownload className="h-4 w-4 me-2" aria-hidden="true" />
            {t('fullSyncButton' as TranslationKeys)}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <CloudDownload className="h-5 w-5" aria-hidden="true" />
              {t('fullSyncConfirmTitle' as TranslationKeys)}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="block">{t('fullSyncConfirmBody' as TranslationKeys)}</span>
              <span className="block rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 p-3 text-xs text-emerald-700 dark:text-emerald-300 font-medium">
                ✓ {t('fullSyncKeepSession' as TranslationKeys)}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className="min-h-[44px]">
              {t('cancel' as TranslationKeys)}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open while wiping
                void handleConfirm();
              }}
              className="min-h-[44px] bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin me-2" aria-hidden="true" />
              ) : (
                <CloudDownload className="h-4 w-4 me-2" aria-hidden="true" />
              )}
              {busy ? t('fullSyncSyncing' as TranslationKeys) : t('fullSyncConfirm' as TranslationKeys)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default FullResyncButton;
