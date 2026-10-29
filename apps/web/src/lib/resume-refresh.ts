'use client';

/**
 * BLASTI Resume Refresh — revalidate view data when the app comes back.
 * (0.6.16 field-fix: "the app is caching data but not updating it in the
 * background … when I close the app and reopen it shows old data unless I
 * manually refresh the page")
 *
 * ROOT CAUSE
 * ──────────
 * Every customer view (home/search/favorites/history/notifications) and most
 * agency views fetch ONCE on mount. On a phone, "closing and reopening" the
 * app usually RESUMES the WebView process instead of reloading it:
 *   - no remount → none of the mount effects re-run → no refetch;
 *   - the realtime socket may have silently died while the OS suspended the
 *     app → no push updates either.
 * The screen therefore shows the last painted (stale) data until the user
 * manually reloads. A full app restart (process killed) DID revalidate —
 * which is exactly the inconsistency the field report describes.
 *
 * FIX
 * ───
 * One shared resume bus. It fires a debounced "resume" signal when the app
 * transitions back to the foreground after a REAL absence (≥3s hidden):
 *   - Web/Electron: document.visibilitychange (hidden→visible) + window
 *     focus (covers Electron restore paths where visibility is unchanged);
 *   - Capacitor native (Android/iOS): App plugin `appStateChange` isActive
 *     via the standard native-plugin probe (zero @capacitor imports — not a
 *     dependency of apps/web).
 * Views subscribe with `useResumeRefresh(fn)` and simply re-run their
 * EXISTING fetch functions — cache-first screens repaint instantly from
 * cache and then revalidate, so a dead/slow network never blanks them.
 *
 * SAFETY
 *   - Signals are debounced (≥2s apart) so visibilitychange + focus +
 *     appStateChange arriving together cause ONE refresh.
 *   - Quick tab flips (<3s hidden) don't fire — that's not "coming back".
 *   - Subscriber errors are isolated — the bus can never break a view.
 *   - The bus is passive: it never fetches by itself, it only notifies
 *     mounted views. Boot-time data still comes from the views' own mounts.
 */

import { useEffect, useRef } from 'react';

type ResumeListener = () => void;

const listeners = new Set<ResumeListener>();

/** Ignore "returns" shorter than this — a quick tab flip is not a resume. */
const MIN_HIDDEN_MS = 3_000;
/** Debounce: at most one dispatch in this window (multi-source dedupe). */
const MIN_DISPATCH_MS = 2_000;

let hiddenAt = 0;
let lastDispatchAt = 0;
let webWired = false;
let nativeWired = false;

function dispatch(reason: string): void {
  const now = Date.now();
  if (now - lastDispatchAt < MIN_DISPATCH_MS) return;
  lastDispatchAt = now;
  if (listeners.size > 0) {
    console.log(`[ResumeRefresh] resume (${reason}) → refreshing ${listeners.size} view(s)`);
  }
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* one broken subscriber must never starve the others */
    }
  }
}

function wireWeb(): void {
  if (webWired || typeof window === 'undefined' || typeof document === 'undefined') return;
  webWired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    if (hiddenFor >= MIN_HIDDEN_MS) {
      dispatch(`visible after ${Math.round(hiddenFor / 1000)}s`);
    }
  });
  // Electron / desktop restore: the window can regain focus with the
  // document already "visible" (no visibilitychange fires) — cover it.
  window.addEventListener('focus', () => {
    if (document.visibilityState !== 'visible') return;
    if (hiddenAt && Date.now() - hiddenAt >= MIN_HIDDEN_MS) {
      dispatch('focus');
    }
  });
}

async function wireNative(): Promise<void> {
  if (nativeWired || typeof window === 'undefined') return;
  try {
    const { getNativePlugin } = await import('./native-plugin');
    const appPlugin = getNativePlugin('App');
    if (!appPlugin || typeof appPlugin.addListener !== 'function') return;
    nativeWired = true;
    appPlugin.addListener('appStateChange', (state: unknown) => {
      const isActive = (state as { isActive?: boolean } | null)?.isActive === true;
      if (isActive) dispatch('capacitor-active');
    });
  } catch {
    /* not a native shell — web listeners above are enough */
  }
}

/**
 * Re-run `callback` every time the app resumes to the foreground.
 *
 * Pass the view's existing fetch function — it must already be
 * cache-first/revalidate-safe (all BLASTI views are). `enabled` lets callers
 * skip while a prerequisite (e.g. user id) is missing without changing the
 * subscription.
 */
export function useResumeRefresh(callback: () => void, enabled = true): void {
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!enabled) return;
    wireWeb();
    void wireNative();
    const fn = () => {
      cbRef.current();
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [enabled]);
}
