/**
 * blasti:// deep-link routing for the Capacitor mobile AND Electron desktop
 * shells (0.6.24 mobile / 0.6.38 desktop).
 *
 * The Android manifest registers a BROWSABLE `blasti://` intent-filter and
 * Electron registers the same scheme via setAsDefaultProtocolClient; the
 * Chargily hosted checkout appends the `blasti://payment/result` deep link
 * to its success/failure return URLs (see computeReturnHints in
 * chargily-checkout.ts + the API's createCheckout deepLink param). The flow
 * after paying (phone or desktop app):
 *
 *   1. the hosted gateway redirects the payer's browser to
 *      `https://<cloud>/#/payment/result?status=success&deep=blasti%3A%2F%2F…`
 *   2. that page (plain browser, NOT the app) immediately bounces into the
 *      app via the deep link (payment-result.tsx bounce effect)
 *   3. the OS opens the app and hands the URL over — HERE:
 *      mobile: `App.addListener('appUrlOpen')` (app already alive) or
 *              `App.getLaunchUrl()` (cold start)
 *      desktop: main.js `open-url` / `second-instance` → preload
 *              `onDeepLink` callback
 *      → route the SPA to the in-app payment-result view so the settlement
 *        poll can run.
 *
 * Uses the same `(window as any).Capacitor` bridge pattern as
 * mobile-back-button.tsx — @capacitor/app is a dependency of the mobile
 * shell only, so the web bundle must never import it statically.
 */

import { useAppStore } from '@/store/use-app-store';

/** Matches the deep links we issue for the payment result view. */
function isPaymentResultDeepLink(url: string): boolean {
  return /^blasti:\/\/payment\/result/i.test(url);
}

/**
 * Route a blasti://payment/result deep link to the in-app payment result.
 * The query part (status / deep / checkout) is stashed under the same
 * sessionStorage key page.tsx uses for the hosted-page return, so
 * PaymentResult.readReturnQuery() picks it up on any mount path.
 *
 * @returns true when the URL was recognized (routed or safely deferred).
 */
export function routePaymentDeepLink(rawUrl: string): boolean {
  if (!rawUrl || !isPaymentResultDeepLink(rawUrl)) return false;
  try {
    const qIndex = rawUrl.indexOf('?');
    const query = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
    if (query) {
      sessionStorage.setItem('blasti:payment-return-query', query);
    }
    const state = useAppStore.getState();
    // Auth may still be booting on a cold-start deep link — the stash above
    // keeps the status and page.tsx's pending-checkout resume (which re-runs
    // once the user lands) completes the routing afterwards.
    if (state.currentView !== 'payment-result' && state.user) {
      state.setView('payment-result');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Register the native + desktop listeners. Safe to call on ANY platform —
 * each branch no-ops outside its shell. Returns an unregister function.
 */
export function initPaymentDeepLinkRouting(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const unsubs: Array<() => void> = [];

  // ── Electron desktop (0.6.38) ──────────────────────────────────────────
  // main.js registers `blasti://` (setAsDefaultProtocolClient) and forwards
  // `open-url` / `second-instance` URLs to the renderer through preload's
  // onDeepLink — wire it to the same payment router. Without this the
  // desktop's only return path after paying was the system browser.
  try {
    const bridge = (window as unknown as {
      electronAPI?: {
        onDeepLink?: (cb: (url: string) => void) => (() => void) | void;
      };
    }).electronAPI;
    if (typeof bridge?.onDeepLink === 'function') {
      bridge.onDeepLink((url: string) => {
        if (url) routePaymentDeepLink(url);
      });
    }
  } catch { /* no electron bridge — ignore */ }

  try {
    const cap = (window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        isPluginAvailable?: (name: string) => boolean;
        Plugins?: Record<string, {
          addListener?: (event: string, cb: (data: { url?: string }) => void) => unknown;
          getLaunchUrl?: () => { url?: string } | undefined;
        }>;
      };
    }).Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    const App = (typeof cap.isPluginAvailable === 'function' ? cap.isPluginAvailable('App') : true)
      ? cap.Plugins?.['App']
      : undefined;

    if (App) {
    // Cold start — the app was opened BY the deep link (activity launchMode
    // is singleTask, so a warm app delivers appUrlOpen instead).
    try {
      const launch = typeof App.getLaunchUrl === 'function' ? App.getLaunchUrl() : undefined;
      if (launch?.url) routePaymentDeepLink(launch.url);
    } catch { /* plugin returned nothing — ignore */ }

    // Warm app — the OS foregrounds the activity with the new intent.
    try {
      const subscription = App.addListener?.('appUrlOpen', (data) => {
        if (data?.url) routePaymentDeepLink(data.url);
      });
      if (subscription && typeof (subscription as Promise<{ remove?: () => void }>).then === 'function') {
        (subscription as Promise<{ remove?: () => void }>)
          .then((sub) => { unsubs.push(() => sub.remove?.()); })
          .catch(() => { /* listener dropped */ });
      } else if (subscription && typeof (subscription as { remove?: () => void }).remove === 'function') {
        const sub = subscription as { remove?: () => void };
        unsubs.push(() => sub.remove?.());
      }
    } catch { /* plugin unavailable — ignore */ }
    }
    }
  } catch { /* not the Capacitor shell — ignore */ }

  return () => {
    for (const u of unsubs) {
      try { u(); } catch { /* ignore */ }
    }
  };
}
