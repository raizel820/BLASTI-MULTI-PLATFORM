'use client';

/**
 * BLASTI Lazy View loader — resilient dynamic imports (Task 84).
 *
 * WHY: every view in the SPA is lazy-loaded. The default `lazy(() => import())`
 * has two failure modes that produced the "black screen for 30s, sometimes
 * never" navigation bug on slow/flaky networks (mobile data, droplet under
 * load, platform gateway hiccups):
 *
 *   1. The chunk request can hang far longer than any acceptable wait, and
 *      React's <Suspense> then shows the skeleton indefinitely.
 *   2. A single failed chunk request rejects the import — and React caches
 *      that rejection FOREVER, so the view can never load again without a
 *      full page reload.
 *
 * This module fixes both:
 *   - `importWithRetry` races every attempt against a timeout and retries
 *     (with a small backoff) INSIDE the lazy thunk, so React only ever sees
 *     a final result and the "failed lazy is failed forever" trap is gone.
 *   - `warmViews` preloads the chunks for the views the current role is most
 *     likely to open next, scheduled during idle time after the home screen
 *     has painted — the first tap on Settings/Profile/… then renders from
 *     the already-loaded chunk instantly.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** Per-attempt cap. Chunks are small; if one is not here in 12s the network is effectively down. */
const IMPORT_TIMEOUT_MS = 12_000;
/** Total attempts (1 real try + 2 retries). */
const MAX_ATTEMPTS = 3;
/** Backoff between attempts — gives flaky radios/gateways a beat to recover. */
const RETRY_DELAY_MS = 700;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `importer` with a timeout + retry. All retries happen inside the
 * promise — the caller (React lazy) sees only the final outcome, so a
 * transient chunk failure can never permanently poison a lazy component.
 */
export function importWithRetry<M>(importer: () => Promise<M>): Promise<M> {
  let attempt = 0;
  const run = async (): Promise<M> => {
    attempt += 1;
    try {
      return await new Promise<M>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`[lazy-view] chunk load timed out after ${IMPORT_TIMEOUT_MS}ms`)),
          IMPORT_TIMEOUT_MS,
        );
        importer().then(
          (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          (err) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await delay(RETRY_DELAY_MS * attempt);
      return run();
    }
  };
  return run();
}

/**
 * Drop-in replacement for the page.tsx lazy-import pattern:
 *   lazy(() => import('…').then(m => ({ default: m.View })))
 * becomes
 *   lazyNamed(() => import('…'), 'View')
 * with timeout+retry baked in AND the exact same prop typing semantics
 * (the lazy component's props come from the module's real export type).
 */
export function lazyNamed<M, K extends keyof M & string>(
  importer: () => Promise<M>,
  exportName: K,
): LazyExoticComponent<Extract<M[K], ComponentType<any>>> {
  return lazy(async () => {
    const m = await importWithRetry(importer);
    const Cmp = m[exportName] as ComponentType<any> | undefined;
    if (!Cmp) throw new Error(`[lazy-view] export "${exportName}" not found`);
    return { default: Cmp } as { default: Extract<M[K], ComponentType<any>> };
  });
}

/** Schedule a task during browser idle time (falls back to a short timeout). */
export function onIdle(fn: () => void, timeoutMs = 4000): void {
  if (typeof window === 'undefined') return;
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(fn, { timeout: timeoutMs });
  } else {
    setTimeout(fn, 600);
  }
}

/**
 * Preload view chunks. Sequential + idle-scheduled by the caller — imports
 * happen one at a time so the home screen's own network traffic is never
 * starved, and a failure just stops the warming (the view keeps its
 * timeout+retry path for the real navigation).
 */
export function warmViews(importers: Array<() => Promise<unknown>>): void {
  let index = 0;
  const next = () => {
    if (index >= importers.length) return;
    const importer = importers[index++];
    onIdle(() => {
      Promise.resolve()
        .then(importer)
        .catch(() => {
          /* warming is best-effort */
        })
        .finally(() => {
          // Small gap between chunks keeps idle warming invisible to the user.
          setTimeout(next, 120);
        });
    });
  };
  void next();
}
