/**
 * blasti:// deep-link routing for the Capacitor mobile shell (0.6.24).
 *
 * The Android manifest registers a BROWSABLE `blasti://` intent-filter and
 * the Chargily hosted checkout appends the `blasti://payment/result` deep
 * link to its success/failure return URLs (see computeReturnHints in
 * chargily-checkout.ts + the API's createCheckout deepLink param). The flow
 * after paying on the phone:
 *
 *   1. the hosted gateway redirects the phone's browser to
 *      `https://<cloud>/#/payment/result?status=success&deep=blasti%3A%2F%2F…`
 *   2. that page (plain browser, NOT the app) immediately bounces into the
 *      app via the deep link (payment-result.tsx bounce effect)
 *   3. Android opens BLASTI and hands the URL over — HERE:
 *      `App.addListener('appUrlOpen')` (app already alive) or
 *      `App.getLaunchUrl()` (cold start) → route the SPA to the in-app
 *      payment-result view so the settlement poll can run.
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
 * Register the native listeners. Safe to call on ANY platform — it no-ops
 * outside the Capacitor shell. Returns an unregister function.
 */
export function initPaymentDeepLinkRouting(): () => void {
  if (typeof window === 'undefined') return () => undefined;
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
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) {
      return () => undefined;
    }
    const App = (typeof cap.isPluginAvailable === 'function' ? cap.isPluginAvailable('App') : true)
      ? cap.Plugins?.['App']
      : undefined;
    if (!App) return () => undefined;

    // Cold start — the app was opened BY the deep link (activity launchMode
    // is singleTask, so a warm app delivers appUrlOpen instead).
    try {
      const launch = typeof App.getLaunchUrl === 'function' ? App.getLaunchUrl() : undefined;
      if (launch?.url) routePaymentDeepLink(launch.url);
    } catch { /* plugin returned nothing — ignore */ }

    // Warm app — the OS foregrounds the activity with the new intent.
    let unsubscribe: (() => void) | null = null;
    try {
      const subscription = App.addListener?.('appUrlOpen', (data) => {
        if (data?.url) routePaymentDeepLink(data.url);
      });
      if (subscription && typeof (subscription as Promise<{ remove?: () => void }>).then === 'function') {
        (subscription as Promise<{ remove?: () => void }>)
          .then((sub) => { unsubscribe = () => sub.remove?.(); })
          .catch(() => { /* listener dropped */ });
      } else if (subscription && typeof (subscription as { remove?: () => void }).remove === 'function') {
        unsubscribe = () => (subscription as { remove?: () => void }).remove?.();
      }
    } catch { /* plugin unavailable — ignore */ }

    return () => {
      try { unsubscribe?.(); } catch { /* ignore */ }
    };
  } catch {
    return () => undefined;
  }
}
