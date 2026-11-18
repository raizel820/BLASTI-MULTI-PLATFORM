/**
 * payment-settle-watcher — background settlement confirmation (0.6.89).
 *
 * THE FIX for the "too many steps after paying" report:
 *   1. gateway success page opened in the SYSTEM browser (Chargily
 *      verification / popup detour) while the in-app payment window stayed
 *      open on the gateway page;
 *   2. after the payer closed that window manually, the app flashed the
 *      "waiting for payment" screen before flipping to "paid + back to home".
 *
 * The watcher starts the moment a checkout is created (startChargilyCheckout)
 * and polls GET /api/payment/checkout/:id — the endpoint that ALSO settles
 * the payment server-side (webhook fallback), so confirmation does not
 * depend on the gateway's return redirect reaching the app at all.
 *
 * The moment the checkout settles:
 *   - the pending-checkout marker is cleared (the focus/visibility resume in
 *     page.tsx can no longer resurrect the waiting screen);
 *   - the desktop in-app payment window is CLOSED via the new
 *     app:close-payment-window IPC (no manual closing, whatever route the
 *     gateway's return took);
 *   - every mounted surface refetches via the existing
 *     `blasti:payment-settled` DOM event;
 *   - the SPA navigates STRAIGHT to the view the payment started from
 *     (subscription page → shows the ACTIVE subscription) or the role home —
 *     no result screen, no dialogs (the user's option 2).
 *
 * The blasti:// payment-result deep link is suppressed for a settled payment
 * (shouldSuppressPaymentResultRouting) so the late gateway return can no
 * longer drag the app onto the result screen either.
 *
 * The payment-result view remains the fallback for flows this watcher cannot
 * cover (its own poll budget spans a full hour; the watcher stops at 15).
 */

import { apiFetch } from '@/lib/api-fetch';
import {
  PENDING_CHECKOUT_KEY,
  clearPendingCheckout,
  type CreateCheckoutResponse,
} from '@/lib/chargily-checkout';
import { resolvePaymentReturnView } from '@/lib/payment-return-view';
import { useAppStore } from '@/store/use-app-store';
import { logTx } from '@/lib/remote-logger';

/** Mirrors GET /api/payment/checkout/:id → data (see apps/api payment-checkout). */
interface CheckoutStatusData {
  checkoutId?: string;
  transactionId?: string;
  smsPurchaseId?: string;
  status?: string;
  normalizedStatus?: string;
  type?: string;
  amount?: number;
}

function extractPaymentData<T extends object>(body: unknown): T | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.data && typeof b.data === 'object') return b.data as T;
  if (typeof b.checkoutId === 'string' && b.checkoutId) return b as T;
  return null;
}

// ─── Polling budget ─────────────────────────────────────────────────────────
// Fast window mirrors the result view (3s × 40 ≈ 2 min), then a relaxed
// 12s cadence up to ~15 minutes total. Beyond that the payment-result view
// (one-hour budget) and the 30-minute cloud sweeper remain the safety nets.
const FAST_INTERVAL_MS = 3_000;
const FAST_ATTEMPTS = 40;
const SLOW_INTERVAL_MS = 12_000;
const SLOW_ATTEMPTS = 55;
const TOTAL_ATTEMPTS = FAST_ATTEMPTS + SLOW_ATTEMPTS;

/** How long a locally-settled payment keeps suppressing result routing. */
const SETTLED_TTL_MS = 15 * 60 * 1000;

interface ActiveWatcher {
  checkoutId: string;
  cancel: () => void;
}

let activeWatcher: ActiveWatcher | null = null;
let lastSettled: { at: number; ok: boolean; ids: Set<string> } | null = null;

/** True when THIS checkout was already confirmed by the local watcher. */
export function isCheckoutLocallySettled(checkoutId?: string | null): boolean {
  if (!checkoutId || !lastSettled) return false;
  if (Date.now() - lastSettled.at > SETTLED_TTL_MS) return false;
  return lastSettled.ids.has(checkoutId);
}

/**
 * Should the blasti://payment/result deep link (and the pending-checkout
 * focus resume) be suppressed? True when the watcher already settled THIS
 * payment — the gateway's late return must not resurrect the result screen.
 *
 * `query` is the raw deep-link query (`status=…&checkout=…&ref=…`); matching
 * is best-effort: when the query names ids that do NOT match the settled
 * payment (a genuinely NEW checkout's return), routing stays enabled.
 */
export function shouldSuppressPaymentResultRouting(query: string): boolean {
  if (!lastSettled || Date.now() - lastSettled.at > SETTLED_TTL_MS) return false;
  try {
    const params = new URLSearchParams(query || '');
    const checkout = params.get('checkout');
    const ref = params.get('ref');
    if (!checkout && !ref) {
      // No ids to match against — suppress only when the app has no pending
      // checkout left (i.e. THIS app instance's payment already settled).
      try { return !localStorage.getItem(PENDING_CHECKOUT_KEY); } catch { return false; }
    }
    return (!!checkout && lastSettled.ids.has(checkout)) || (!!ref && lastSettled.ids.has(ref));
  } catch {
    return false;
  }
}

/**
 * Start (or replace) the background settlement watcher for a checkout.
 * Safe on every platform: the desktop close call no-ops outside Electron.
 */
export function startSettleWatcher(
  checkout: CreateCheckoutResponse,
  opts?: { returnView?: string },
): void {
  const checkoutId = checkout?.checkoutId;
  if (!checkoutId) return;

  // One payment at a time — a new checkout replaces the previous watcher.
  activeWatcher?.cancel();

  const ids = new Set<string>(
    [checkoutId, checkout.transactionId, checkout.smsPurchaseId, checkout.orderId].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    ),
  );

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const stop = () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Identity check — a REPLACED watcher's late stop() must not clear the
    // new one (activeWatcher.cancel is the REPLACING watcher's stop then).
    if (activeWatcher && activeWatcher.cancel === cancelRef) {
      activeWatcher = null;
    }
  };
  const cancelRef = stop;

  const markSettled = (ok: boolean, d: CheckoutStatusData | null) => {
    for (const v of [d?.checkoutId, d?.transactionId, d?.smsPurchaseId]) {
      if (typeof v === 'string' && v) ids.add(v);
    }
    lastSettled = { at: Date.now(), ok, ids };
  };

  const settle = (ok: boolean, d: CheckoutStatusData | null) => {
    stop();
    markSettled(ok, d);
    try {
      clearPendingCheckout();
    } catch { /* ignore */ }

    // 0.6.89 — the funnel's client-side end, logged for the Transactions tab.
    logTx('result_final', `Background watcher settled the checkout: ${ok ? 'PAID' : 'FAILED'}`, {
      checkoutId,
      ref: d?.transactionId || d?.smsPurchaseId || checkout.transactionId || checkout.smsPurchaseId,
      txType: d?.type || checkout.type,
      status: ok ? 'paid' : 'failed',
      ...(d?.amount != null ? { amount: d.amount } : {}),
      source: 'watcher',
    }, ok ? 'info' : 'warn');

    // Mounted surfaces (subscription page, dashboards, profile) refetch —
    // idempotent with the realtime socket push.
    try {
      window.dispatchEvent(
        new CustomEvent('blasti:payment-settled', {
          detail: {
            ok,
            event: {
              checkoutId,
              data: { transactionId: d?.transactionId, smsPurchaseId: d?.smsPurchaseId },
            },
          },
        }),
      );
    } catch { /* ignore */ }

    // Desktop — close the in-app payment window NOW (covers every return
    // route, including the gateway diverting its success page into the
    // system browser). No-op outside the Electron shell.
    try {
      const bridge = (window as unknown as {
        electronAPI?: { closePaymentWindow?: () => Promise<{ ok?: boolean }> };
      }).electronAPI;
      void bridge?.closePaymentWindow?.();
    } catch { /* ignore */ }

    // Straight navigation — no result screen, no dialogs. The subscription
    // page (or SMS wallet) the payment started from shows the ACTIVE state;
    // when the start view is unknown, land on the role's home.
    try {
      const state = useAppStore.getState();
      if (!state.user) return;
      const type = d?.type || checkout.type;
      const target = resolvePaymentReturnView(opts?.returnView, state.user.role, type);
      if (state.currentView !== target) state.setView(target);
    } catch { /* store not ready — surfaces stay where they are */ }
  };

  const poll = async () => {
    if (disposed) return;
    attempt += 1;
    try {
      const res = await apiFetch(`/api/payment/checkout/${encodeURIComponent(checkoutId)}`);
      if (disposed) return;
      const body = await res.json().catch(() => null);
      if (res.ok) {
        const d = extractPaymentData<CheckoutStatusData>(body);
        if (d?.normalizedStatus === 'paid') return settle(true, d);
        if (d?.normalizedStatus === 'failed') return settle(false, d);
      } else if (res.status === 404) {
        // Unknown checkout — nothing to watch; the result view owns the UX.
        return stop();
      }
    } catch { /* network hiccup — keep polling while budget remains */ }
    if (attempt >= TOTAL_ATTEMPTS) {
      // Budget exhausted WITHOUT a settlement — clear this watcher but do
      // NOT mark settled (no suppression): the result view stays available.
      stop();
      return;
    }
    timer = setTimeout(() => void poll(), attempt >= FAST_ATTEMPTS ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS);
  };

  activeWatcher = { checkoutId, cancel: stop };

  // First check right away (the webhook often settles within seconds), then
  // the self-adjusting cadence.
  timer = setTimeout(() => void poll(), FAST_INTERVAL_MS);
  void poll();
}
