'use client';

/**
 * PaymentResult — full-screen Chargily (EDAHABIA / CIB) payment result view.
 *
 * The hosted Chargily checkout page sends the customer back to
 * `/#/payment/result?status=success|failed`; the checkout id itself is
 * recovered from (in order) the hash query, the localStorage pending
 * checkout (set by startChargilyCheckout), or GET /api/payment/pending.
 *
 * The view then polls GET /api/payment/checkout/:id — that endpoint ALSO
 * settles the payment server-side (webhook fallback), so the status can
 * flip pending → paid while we poll. Works for every role and self-handles
 * the logged-out case (generic result + login CTA, no polling).
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, XCircle, Clock, Loader2, CreditCard, LogIn, HelpCircle, History, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/store/use-app-store';
import type { ViewName, UserRole } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import {
  getPendingCheckout,
  clearPendingCheckout,
  openCheckoutUrl,
  type PendingCheckout,
} from '@/lib/chargily-checkout';
import { PAYMENT_SUCCESS_EVENT } from '@/lib/payment-settle-watcher';
import { viewToUrl } from '@/lib/route-map';
import { logTx } from '@/lib/remote-logger';
import {
  isValidPaymentReturnView,
  resolvePaymentReturnView,
} from '@/lib/payment-return-view';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// ─── Polling budget ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 40;
// 0.6.76 — after the fast 2-minute budget the loop no longer dead-stops: it
// stretches to a slow background window (bank OTP flows and hosted-page
// retries easily outlive 2 minutes). A settlement during the slow window
// still flips the screen to paid/failed automatically — and the realtime
// push (blasti:payment-settled) short-circuits the wait entirely.
// 0.6.82 — the slow window stretched from 10 min to a FULL HOUR. The cloud
// sweeper settles gateway-unverified payments at the 30-minute mark, so a
// 10-minute budget used to dead-stop BEFORE that settle and the payer saw
// "still pending" forever while the app only showed the truth after a
// restart. 15s × 240 ≈ 60 min keeps the screen live across the whole sweep
// cycle at a negligible request rate.
const SLOW_POLL_INTERVAL_MS = 15_000;
const SLOW_POLL_ATTEMPTS = 240;

/** Mirrors GET /api/payment/checkout/:id → data (see apps/api payment-checkout). */
interface CheckoutStatusData {
  checkoutId: string;
  // 0.6.76 — local ledger row ids (the push listener matches settlements
  // against them; the API returns them on every poll response).
  transactionId?: string;
  smsPurchaseId?: string;
  status?: string;
  normalizedStatus?: string;
  amount?: number;
  currency?: string;
  type?: string;
  plan?: string | null;
  planName?: string | null;
  smsQuantity?: number | null;
  checkoutUrl?: string | null;
  source?: string;
}

/** Mirrors GET /api/payment/pending → data. */
interface PendingCheckoutData {
  checkoutId: string;
  type?: string;
  amount?: number;
}

/**
 * Normalize a payment-API response body to its `data` payload.
 *
 * apiFetch routes through apiClient, whose parseResponse UNWRAPS the
 * `{success, data}` envelope (any JSON object with a `data` key and ≤3
 * top-level keys becomes just the inner data). Both payment endpoints use
 * exactly that envelope, so `res.json()` is either the full envelope (raw
 * fetch / shells without the unwrap) or the already-unwrapped data object —
 * accept either shape.
 */
function extractPaymentData<T extends { checkoutId?: string }>(body: unknown): T | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.data && typeof b.data === 'object') return b.data as T;
  if (typeof b.checkoutId === 'string' && b.checkoutId) return b as T;
  return null;
}

type Phase =
  | 'confirming' // resolving / polling — not settled yet
  | 'paid'
  | 'failed'
  | 'still-pending' // budget exhausted while Chargily still reports pending
  | 'no-checkout' // authenticated but no checkout id could be recovered
  | 'unauthenticated'; // no user in the store — generic result, no polling

/**
 * Parse the payment return query (`status=success&checkout=…`).
 *
 * The live hash (`#/payment/result?status=…`) only carries the query on a
 * cold full load — the store's setView normalizes the hash (dropping the
 * query) before this view mounts on any in-app navigation path. page.tsx
 * therefore stashes the raw params at module evaluation; consume that stash
 * (read-once) when the live hash has no query.
 *
 * The result is memoized per page load: reactStrictMode double-invokes the
 * mount effect in dev, and a naive one-shot sessionStorage consume would
 * return null on the second pass — wiping the status the generic (logged-out
 * / no-checkout) states derive their styling from.
 */
let _returnQueryMemo: { status: string | null; checkout: string | null; ref: string | null; deep: string | null } | null = null;

function readReturnQuery(): { status: string | null; checkout: string | null; ref: string | null; deep: string | null } {
  if (_returnQueryMemo) return _returnQueryMemo;
  try {
    const hash = window.location.hash || '';
    let query = '';
    const qIndex = hash.indexOf('?');
    if (hash.startsWith('#/payment/result') && qIndex >= 0) {
      query = hash.slice(qIndex + 1);
    } else {
      try {
        query = sessionStorage.getItem('blasti:payment-return-query') || '';
        if (query) sessionStorage.removeItem('blasti:payment-return-query');
      } catch {
        /* private mode — no stash to consume */
      }
    }
    if (!query) return { status: null, checkout: null, ref: null, deep: null };
    const params = new URLSearchParams(query);
    _returnQueryMemo = {
      status: params.get('status'),
      checkout: params.get('checkout'),
      // 0.6.76 — `ref` is the LOCAL ledger row id the API bakes into the
      // success/failure URLs (the paying browser has no localStorage).
      ref: params.get('ref'),
      deep: params.get('deep'),
    };
    return _returnQueryMemo;
  } catch {
    return { status: null, checkout: null, ref: null, deep: null };
  }
}

/**
 * A pending checkout may carry a `returnView` — the primary CTA honors it
 * only when it is a real view this role is allowed to open (and not a loop
 * back onto the result page itself). Resolution itself lives in
 * payment-return-view.ts — shared with the 0.6.88 settlement watcher.
 */

export function PaymentResult() {
  const user = useAppStore((s) => s.user);
  const setView = useAppStore((s) => s.setView);
  const { t } = useLanguage();

  const [phase, setPhase] = useState<Phase>('confirming');
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [data, setData] = useState<CheckoutStatusData | null>(null);
  const [statusParam, setStatusParam] = useState<string | null>(null);
  // Captured ONCE at mount — clearPendingCheckout() wipes the localStorage
  // entry on resolution, but the amount + returnView must survive for the UI.
  const [pending, setPending] = useState<PendingCheckout | null>(null);
  // Bumped by the "refresh status" button to restart the polling budget.
  const [pollSession, setPollSession] = useState(0);
  // 0.6.82 — deep-link return target captured ONCE at mount (readReturnQuery
  // is memoized; the fallback button must survive the poll lifecycle).
  const [deepLinkTarget, setDeepLinkTarget] = useState<string | null>(null);

  const attemptsRef = useRef(0);
  const pollingActiveRef = useRef(false);
  /** verify_error fires ONCE per poll session (reset when the budget restarts). */
  const pollErrorLoggedRef = useRef(false);
  /** Latest poll payload (kept in a ref so the push listener can match ids). */
  const dataRef = useRef<CheckoutStatusData | null>(null);
  /** Immediate one-shot check — used by the realtime settlement push. */
  const pollNowRef = useRef<(() => Promise<void>) | null>(null);
  // PRODUCTION FIX (verify_poll fields): the ledger ref from the return URL is
  // resolved in the mount effect but only lived in local variables — verify_poll
  // went out with NO ref and NO amount (empty fields in the Transactions tab).
  const returnRefRef = useRef<string | null>(null);
  // Track the phase so the unmount handler can detect an abandoned checkout.
  const phaseRef = useRef<Phase>(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Deep-link bounce (Capacitor mobile + Electron desktop) ───────────────
  // On phones AND in the desktop shell the hosted checkout opens in the
  // SYSTEM browser (Electron intercepts window.open → shell.openExternal),
  // so after paying, the gateway lands THIS page inside that browser (not
  // the app). When the return URL carries a `deep` blasti:// link (Capacitor
  // AND Electron callers send one — see computeReturnHints) and we are NOT
  // already inside a native shell, bounce back into the app.
  //
  // 0.6.82 — the bounce used to fire ONCE, 1.2s after mount, with NO retry
  // and NO visible fallback: if the OS protocol handler was missing (or the
  // user dismissed the "Open BLASTI?" dialog), the custom-scheme navigation
  // silently no-oped and the payer stayed on the web result page forever
  // while the desktop app sat on its waiting screen. Now the bounce is
  // retried (1.2s / 3.5s / 8s — a delayed first attempt loses nothing) and
  // an "open the app" button is ALWAYS rendered alongside (deepLinkTarget),
  // so the return path has a manual escape hatch on every platform.
  useEffect(() => {
    const deep = readReturnQuery().deep;
    setDeepLinkTarget(deep);
    if (!deep) return;
    try {
      const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
      if (cap?.isNativePlatform?.()) return; // already in the app
    } catch { /* ignore */ }
    const attempt = (n: number) => {
      // 0.6.81 — the final redirection leg: gateway browser → app.
      logTx('redirect_back', `blasti:// deep-link bounce attempt ${n} fired`, { redirectTarget: 'blasti://payment/result', attempt: n });
      try { window.location.href = deep; } catch { /* invalid scheme — stay put */ }
    };
    const timers = [
      setTimeout(() => attempt(1), 1200),
      setTimeout(() => attempt(2), 3500),
      setTimeout(() => attempt(3), 8000),
    ];
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  // ── Resolve the checkout id (hash query → localStorage → API) ────────────
  useEffect(() => {
    let cancelled = false;

    // Logged out → generic result from the `status` query param, no polling.
    if (!useAppStore.getState().user) {
      setStatusParam(readReturnQuery().status);
      setPhase('unauthenticated');
      // 0.6.81 — the funnel ends here for logged-out returns.
      logTx('result_final', 'Payment result final: unauthenticated (generic result, no verification)', {
        gatewayStatusParam: readReturnQuery().status,
        status: 'unauthenticated',
      }, 'warn');
      return;
    }

    const run = async () => {
      const { status, checkout, ref } = readReturnQuery();
      if (!cancelled) setStatusParam(status);
      returnRefRef.current = ref || null;

      const pendingCheckout = getPendingCheckout();
      setPending(pendingCheckout);

      // 0.6.81 — the payer is BACK from the hosted gateway page. This closes
      // the redirect_gateway → return_received leg of the funnel.
      logTx('return_received', `Payer returned to the payment result view (status=${status ?? 'unknown'})`, {
        txType: pendingCheckout?.type,
        checkoutId: checkout || pendingCheckout?.checkoutId || undefined,
        ref,
        gatewayStatusParam: status,
        ...(pendingCheckout?.amount ? { amount: pendingCheckout.amount } : {}),
      });

      // 0.6.76 — `ref` (the ledger row id carried by the return URL) wins over
      // the localStorage pending checkout: GET /payment/checkout/:id accepts a
      // record id too, so the browser result page — which has NO localStorage
      // — polls the exact payment instead of the ambiguous /pending fallback.
      let id: string | null = checkout || ref || pendingCheckout?.checkoutId || null;
      if (!id) {
        // Last resort — the payment may have been started in another browser.
        try {
          const res = await apiFetch('/api/payment/pending');
          if (cancelled) return;
          const body = await res.json().catch(() => null);
          const pendingData = extractPaymentData<PendingCheckoutData>(body);
          if (res.ok && pendingData?.checkoutId) {
            id = pendingData.checkoutId;
          }
        } catch {
          /* offline — fall through to the no-checkout state */
        }
      }

      if (cancelled) return;
      if (id) {
        setCheckoutId(id);
        setPhase('confirming');
      } else {
        setPhase('no-checkout');
        // 0.6.81 — the funnel ended without anything to verify.
        logTx('result_final', 'Payment result final: no checkout could be recovered', {
          gatewayStatusParam: status,
          status: 'no-checkout',
        }, 'warn');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Poll GET /api/payment/checkout/:id until settled ─────────────────────
  // Fast 3s window → slow 15s background window (0.6.76) — the screen flips
  // to paid/failed the moment either window sees a settlement, and the
  // realtime push below short-circuits the wait entirely.
  useEffect(() => {
    if (!checkoutId) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    pollingActiveRef.current = true;
    attemptsRef.current = 0;
    pollErrorLoggedRef.current = false;

    const stopPolling = () => {
      pollingActiveRef.current = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const TOTAL_BUDGET = MAX_POLL_ATTEMPTS + SLOW_POLL_ATTEMPTS;

    const poll = async (force = false) => {
      // `force` — the realtime push checking AFTER the budgeted loop stopped.
      if (disposed || (!pollingActiveRef.current && !force)) return;
      attemptsRef.current += 1;
      if (attemptsRef.current === 1) {
        // 0.6.81 — first verification tick of this poll session.
        // PRODUCTION FIX: also carry amount + ref so verify_poll rows are
        // self-contained in the Transactions tab (they used to be empty).
        logTx('verify_poll', `Settlement verification poll started for ${checkoutId}`, {
          checkoutId,
          ...(returnRefRef.current ? { ref: returnRefRef.current } : {}),
          ...(dataRef.current?.type ? { txType: dataRef.current.type } : {}),
          ...(dataRef.current?.amount != null ? { amount: dataRef.current.amount } : pending?.amount != null ? { amount: pending!.amount } : {}),
        });
      }
      try {
        const res = await apiFetch(`/api/payment/checkout/${encodeURIComponent(checkoutId)}`);
        if (disposed) return;
        const body = await res.json().catch(() => null);

        if (!res.ok && res.status === 404) {
          stopPolling();
          setPhase('no-checkout');
          logTx('result_final', 'Payment result final: checkout not found on the server', {
            checkoutId,
            status: 'no-checkout',
          }, 'warn');
          return;
        }
        const d = extractPaymentData<CheckoutStatusData>(body);
        if (!res.ok || !d) {
          // PRODUCTION FIX (error-path coverage): poll/API failures used to be
          // silent until the budget ran out — the payer saw an eternal spinner
          // and the Transactions tab showed nothing. Emit verify_error ONCE
          // per poll session (the first failure) with the HTTP status.
          if (!pollErrorLoggedRef.current) {
            pollErrorLoggedRef.current = true;
            logTx('verify_error', `Settlement verification failed (HTTP ${res.status}) — continuing to poll`, {
              checkoutId,
              ...(returnRefRef.current ? { ref: returnRefRef.current } : {}),
              ...(dataRef.current?.type ? { txType: dataRef.current.type } : {}),
              httpStatus: res.status,
            }, 'warn');
          }
          // Transient API/network hiccup — keep polling while budget remains.
          if (attemptsRef.current >= TOTAL_BUDGET) {
            stopPolling();
            setPhase('still-pending');
            logTx('result_final', 'Payment result final: still pending (budget exhausted on API errors)', {
              checkoutId,
              status: 'still-pending',
            }, 'warn');
          }
          return;
        }

        dataRef.current = d;
        setData(d);
        if (d.normalizedStatus === 'paid' || d.normalizedStatus === 'failed') {
          // Settled — the localStorage marker has served its purpose.
          clearPendingCheckout();
          stopPolling();
          setPhase(d.normalizedStatus);
          // 0.6.81 — CONFIRMATION COMPLETE: the funnel's final client state
          // (the server logs settle_paid/settle_failed authoritatively).
          logTx('result_final', `Payment result final: ${d.normalizedStatus.toUpperCase()}`, {
            checkoutId: d.checkoutId || checkoutId,
            ref: d.transactionId || d.smsPurchaseId,
            txType: d.type,
            status: d.normalizedStatus === 'paid' ? 'paid' : 'failed',
            ...(d.amount != null ? { amount: d.amount } : {}),
            source: d.source,
          }, d.normalizedStatus === 'paid' ? 'info' : 'warn');
          return;
        }
        if (attemptsRef.current >= TOTAL_BUDGET) {
          stopPolling();
          setPhase('still-pending');
          logTx('result_final', 'Payment result final: still pending (poll budget exhausted)', {
            checkoutId: d.checkoutId || checkoutId,
            ref: d.transactionId || d.smsPurchaseId,
            txType: d.type,
            status: 'still-pending',
            ...(d.amount != null ? { amount: d.amount } : {}),
          }, 'warn');
        }
      } catch {
        // PRODUCTION FIX (error-path coverage): network failures during
        // verification were silent too — emit verify_error once per session.
        if (!pollErrorLoggedRef.current) {
          pollErrorLoggedRef.current = true;
          logTx('verify_error', 'Settlement verification network failure — continuing to poll', {
            checkoutId,
            ...(returnRefRef.current ? { ref: returnRefRef.current } : {}),
            ...(dataRef.current?.type ? { txType: dataRef.current.type } : {}),
            httpStatus: 0,
          }, 'warn');
        }
        if (attemptsRef.current >= TOTAL_BUDGET) {
          stopPolling();
          setPhase('still-pending');
          logTx('result_final', 'Payment result final: still pending (network unreachable)', {
            checkoutId,
            status: 'still-pending',
          }, 'warn');
        }
      }
    };

    pollNowRef.current = async () => {
      if (!disposed) await poll(true);
    };

    const loop = async () => {
      // Immediate first check, then a self-adjusting cadence: every 3s during
      // the fast window, every 15s afterwards. Keeps the UI phase honest
      // ("still pending" once the fast window is out) while never giving up
      // on the payment within the combined budget.
      while (!disposed && pollingActiveRef.current) {
        await poll();
        if (disposed || !pollingActiveRef.current) return;
        if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
          setPhase((p) => (p === 'confirming' ? 'still-pending' : p));
        }
        const delay = attemptsRef.current >= MAX_POLL_ATTEMPTS ? SLOW_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
      }
    };
    void loop();

    // Returning from the hosted payment tab — check right away instead of
    // waiting for the next interval tick. `force` also covers the post-budget
    // return: the user paid, came back, the screen settles without a click.
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      void poll(true);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);

    return () => {
      disposed = true;
      stopPolling();
      pollNowRef.current = null;
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [checkoutId, pollSession]);

  // ── Push confirmation (0.6.76) — the server announces settlement over the
  // realtime socket the moment a checkout settles (webhook, poll fallback or
  // the 5-min sweeper). The toast bridge re-dispatches it as
  // `blasti:payment-settled`; when the event is about THIS checkout (or
  // carries no ids to rule it out), run an immediate check — the screen
  // updates without waiting for the next poll tick, even after the budget
  // ran out. This is what lets the desktop/mobile app auto-confirm the
  // subscription while the payer is still closing the gateway tab.
  useEffect(() => {
    if (!checkoutId) return;
    const onSettled = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { ok?: boolean; event?: { checkoutId?: string; data?: { transactionId?: string; smsPurchaseId?: string } } }
        | undefined;
      const ev = detail?.event ?? {};
      const evData = ev.data ?? {};
      const d = dataRef.current;
      // Skip only when the payload POSITIVELY names a different checkout —
      // matching is best-effort: the payload checkoutId is the Chargily id,
      // while our checkoutId state may be the local record id (`ref` path).
      let foreign = false;
      if (ev.checkoutId && d?.checkoutId && ev.checkoutId !== d.checkoutId && ev.checkoutId !== checkoutId) foreign = true;
      if (evData.transactionId && d?.transactionId && evData.transactionId !== d.transactionId) foreign = true;
      if (evData.smsPurchaseId && d?.smsPurchaseId && evData.smsPurchaseId !== d.smsPurchaseId) foreign = true;
      if (foreign) return;
      // 0.6.81 — realtime settlement push received while waiting.
      logTx('settle_push', `Realtime settlement push received${detail?.ok === true ? ' (paid)' : detail?.ok === false ? ' (failed)' : ''}`, {
        checkoutId,
        ...(d?.type ? { txType: d.type } : {}),
        pushOk: detail?.ok,
      });
      void pollNowRef.current?.();
    };
    window.addEventListener('blasti:payment-settled', onSettled);
    return () => window.removeEventListener('blasti:payment-settled', onSettled);
  }, [checkoutId]);

  // ── PRODUCTION FIX: abandonment detection ──────────────────────────────────
  // The funnel had NO stage for "the payer left before confirmation finished"
  // — a crash, app kill or navigation away during the confirming window was
  // simply invisible in the Transactions tab. Emit checkout_abandoned when
  // this view unmounts while the checkout has NOT reached a final state.
  useEffect(() => {
    return () => {
      if (
        checkoutId &&
        (phaseRef.current === 'confirming' || phaseRef.current === 'still-pending')
      ) {
        logTx('checkout_abandoned', 'Payment result view closed before the checkout reached a final state', {
          checkoutId,
          ...(returnRefRef.current ? { ref: returnRefRef.current } : {}),
          ...(dataRef.current?.type ? { txType: dataRef.current.type } : {}),
          status: 'abandoned',
        }, 'warn');
      }
    };
  }, [checkoutId]);

  const restartPolling = () => {
    attemptsRef.current = 0;
    setPhase('confirming');
    setPollSession((s) => s + 1);
  };

  // ── CTA resolution (shared by every settled state) ───────────────────────
  const role = user?.role;
  const type = data?.type || pending?.type;
  const primaryLabelForType =
    type === 'sms' ? t('backToSmsWallet') : t('backToSubscription');

  // 0.6.89 — the view/label rules live in payment-return-view.ts (ONE source
  // of truth, also used by the background settlement watcher's navigation).
  const pendingReturnView = pending?.returnView;
  const primaryView = resolvePaymentReturnView(pendingReturnView, role, type);
  const primaryCta: { label: string; view: ViewName } = {
    // Label mirrors the original resolution exactly: a valid pending return
    // view keeps the type-aware label; the fallbacks name where they head.
    label: isValidPaymentReturnView(pendingReturnView, role)
      ? primaryLabelForType
      : type === 'subscription' || type === 'hardware'
        ? t('backToSubscription')
        : type === 'sms'
          ? t('backToSmsWallet')
          : t('backToHome'),
    view: primaryView,
  };

  // ── 0.6.89 — AUTOMATIC RETURN ON SUCCESS (no extra steps) ────────────
  // The full-screen result card with a manual "back" button was exactly the
  // extra step the payer reported. When the poll (or the realtime push)
  // confirms the payment: every mounted surface flips to the settled state,
  // the success card shows for a brief beat, then the app navigates STRAIGHT
  // to the view the payment started from (subscription page → ACTIVE
  // subscription) or the role home. 0.6.90 — the settle ALSO fires
  // blasti:payment-success so the global success dialog (optional Chargily
  // verification + home) appears over the activated view. Failed /
  // unverified states keep their manual CTAs — the payer must read those.
  const autoReturnedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'paid' || autoReturnedRef.current) return;
    autoReturnedRef.current = true;
    // Mounted surfaces refetch (idempotent with the realtime socket push).
    try {
      window.dispatchEvent(
        new CustomEvent('blasti:payment-settled', {
          detail: {
            ok: true,
            event: {
              checkoutId: dataRef.current?.checkoutId || checkoutId,
              data: {
                transactionId: dataRef.current?.transactionId,
                smsPurchaseId: dataRef.current?.smsPurchaseId,
              },
            },
          },
        }),
      );
    } catch { /* ignore */ }
    // 0.6.90 — success dialog (optional "verify on the Chargily platform" in
    // the system browser + return home). verifyUrl rides on the persisted
    // pending checkout; older markers (pre-0.6.90) simply omit the button.
    try {
      window.dispatchEvent(
        new CustomEvent(PAYMENT_SUCCESS_EVENT, {
          detail: {
            checkoutId: dataRef.current?.checkoutId || checkoutId,
            type: dataRef.current?.type || pending?.type,
            amount: dataRef.current?.amount ?? pending?.amount,
            currency: undefined,
            verifyUrl: pending?.checkoutUrl,
          },
        }),
      );
    } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try { setView(primaryCta.view); } catch { /* store not ready */ }
    }, 1600);
    return () => clearTimeout(timer);
  }, [phase, primaryCta.view, setView, checkoutId]);

  // Secondary home CTA — customers only, and never a duplicate of the primary.
  const showSecondaryHome =
    role === 'CUSTOMER' && primaryCta.view !== 'customer-home';

  // Task 2-e: history view for the unverified fallback — agencies check their
  // subscription page, customers their profile (purchase history).
  const unverifiedHistoryView: ViewName =
    role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF' ? 'agency-subscription' : 'customer-profile';

  const knownAmount = data?.amount ?? pending?.amount ?? null;

  // 0.6.82 — the manual bounce button only makes sense OUTSIDE the app shells
  // (it rescues the payer stuck in the browser when the auto-bounce failed —
  // missing OS protocol registration, dismissed "Open BLASTI?" dialog, etc.).
  const showReturnToAppButton =
    !!deepLinkTarget &&
    !(() => {
      try {
        const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
        if (cap?.isNativePlatform?.()) return true;
        return !!(window as unknown as { electronAPI?: unknown }).electronAPI;
      } catch { return false; }
    })();

  // ── Effective visual state ────────────────────────────────────────────────
  // no-checkout / unauthenticated fall back to the generic result derived
  // from the `status` query param (success / failed / neutral).
  const genericStatus =
    statusParam === 'success' ? 'success' : statusParam === 'failed' ? 'failed' : 'neutral';

  // Task 2-e — unverified-success guard: `?status=success` comes from the
  // STATIC Chargily return URL and proves nothing on its own (the charge may
  // not even exist). When we have no checkout id to verify against (logged
  // out, or authenticated but nothing recoverable), a green "paid" screen
  // would invite the user to mistake an unconfirmed/failed payment as done.
  // Those cases render an AMBER "unverified" state instead. The authenticated
  // polling path (real checkout id → confirming → paid/failed) is untouched.
  const unverifiedGeneric =
    (phase === 'unauthenticated' || phase === 'no-checkout') && genericStatus === 'success';

  type Visual = 'confirming' | 'success' | 'failed' | 'pending' | 'unverified' | 'neutral';
  const visual: Visual =
    phase === 'confirming'
      ? 'confirming'
      : phase === 'paid'
        ? 'success'
        : phase === 'failed'
          ? 'failed'
          : phase === 'still-pending'
            ? 'pending'
            : unverifiedGeneric
              ? 'unverified'
              : genericStatus === 'success'
                ? 'success'
                : genericStatus === 'failed'
                  ? 'failed'
                  : 'neutral';

  const renderIcon = () => {
    if (visual === 'confirming') {
      return (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.3 }}
          className="relative"
        >
          <motion.div
            animate={{ scale: [1, 1.12, 1], opacity: [0.15, 0.05, 0.15] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-24 w-24 rounded-full bg-emerald-300 dark:bg-emerald-800"
          />
          <div className="relative h-20 w-20 rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 flex items-center justify-center">
            <Loader2 className="h-10 w-10 animate-spin text-emerald-600 dark:text-emerald-400" />
          </div>
        </motion.div>
      );
    }
    if (visual === 'success') {
      return (
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14 }}
          className="relative"
        >
          <motion.div
            animate={{ scale: [1, 1.2, 1], opacity: [0.18, 0.04, 0.18] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-28 w-28 rounded-full bg-emerald-300 dark:bg-emerald-800"
          />
          <CheckCircle2 className="relative h-20 w-20 text-emerald-500 dark:text-emerald-400" />
        </motion.div>
      );
    }
    if (visual === 'failed') {
      return (
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14 }}
        >
          <XCircle className="h-20 w-20 text-red-500 dark:text-red-400" />
        </motion.div>
      );
    }
    if (visual === 'pending') {
      return (
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14 }}
        >
          <Clock className="h-20 w-20 text-amber-500 dark:text-amber-400" />
        </motion.div>
      );
    }
    if (visual === 'unverified') {
      return (
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 220, damping: 14 }}
          className="relative"
        >
          <motion.div
            animate={{ scale: [1, 1.15, 1], opacity: [0.16, 0.05, 0.16] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-28 w-28 rounded-full bg-amber-300 dark:bg-amber-700"
          />
          <HelpCircle className="relative h-20 w-20 text-amber-500 dark:text-amber-400" />
        </motion.div>
      );
    }
    // Neutral — no status hint available
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="h-20 w-20 rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 flex items-center justify-center">
          <CreditCard className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
        </div>
      </motion.div>
    );
  };

  const renderTitle = () => {
    if (phase === 'confirming') return t('paymentConfirmingTitle');
    if (phase === 'paid') return t('paymentSuccessTitle');
    if (phase === 'failed') return t('paymentFailedTitle');
    if (phase === 'still-pending') return t('paymentStillPendingTitle');
    // Task 2-e: unverifiable `?status=success` — never claim success.
    if (visual === 'unverified') return t('paymentUnverifiedTitle');
    if (genericStatus === 'success') return t('paymentSuccessTitle');
    if (genericStatus === 'failed') return t('paymentFailedTitle');
    // Neutral: authenticated without a checkout says so; logged-out (or
    // anything else) keeps the plain page title.
    return phase === 'no-checkout' ? t('paymentNoCheckoutFound') : t('paymentResultTitle');
  };

  const renderDescription = () => {
    if (phase === 'confirming') return t('paymentConfirmingDesc');
    if (phase === 'paid') return t('paymentSuccessDesc');
    if (phase === 'failed') return t('paymentFailedDesc');
    if (phase === 'still-pending') return t('paymentStillPendingDesc');
    // Task 2-e: unverifiable `?status=success` — never claim success.
    if (visual === 'unverified') return t('paymentUnverifiedDesc');
    if (genericStatus === 'success') return t('paymentSuccessDesc');
    if (genericStatus === 'failed') return t('paymentFailedDesc');
    return null;
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-gradient-to-b from-emerald-50/70 via-background to-background dark:from-emerald-950/20 px-4 py-10 sm:py-14">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="w-full max-w-md"
      >
        <Card className="border-emerald-100 dark:border-emerald-900/40 shadow-xl shadow-emerald-900/5">
          <CardContent className="flex flex-col items-center text-center gap-4">
            {renderIcon()}

            <div className="space-y-1.5">
              <h1 className="text-xl sm:text-2xl font-bold text-foreground">
                {renderTitle()}
              </h1>
              {renderDescription() && (
                <p className="text-sm text-muted-foreground leading-relaxed max-w-xs mx-auto">
                  {renderDescription()}
                </p>
              )}
            </div>

            {/* Amount — shown while confirming (when known) and when paid */}
            {(phase === 'confirming' || phase === 'paid') && knownAmount != null && (
              <div className="w-full rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/40 px-4 py-3 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{t('amountPaidLabel')}</span>
                <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400" dir="ltr">
                  {knownAmount.toLocaleString()} {t('currency')}
                </span>
              </div>
            )}

            {/* Type-specific success chip */}
            {phase === 'paid' && type && (
              <Badge className="bg-emerald-100 text-emerald-700 border-transparent dark:bg-emerald-900/40 dark:text-emerald-400">
                {type === 'subscription' && t('subscriptionActivatedMsg')}
                {type === 'sms' && t('smsCreditsAddedMsg')}
                {type === 'hardware' && t('hardwareOrderConfirmedMsg')}
                {type === 'sms' && data?.smsQuantity ? ` +${data.smsQuantity}` : ''}
              </Badge>
            )}

            {/* 0.6.89 — the manual back button stays as a fallback, but the
                app now returns to the subscription/home view on its own. */}
            {phase === 'paid' && (
              <p className="text-xs text-muted-foreground/70 animate-pulse">
                {t('paymentAutoReturnHint')}
              </p>
            )}

            {/* No-checkout hint (authenticated but nothing to track) */}
            {phase === 'no-checkout' && genericStatus !== 'neutral' && (
              <p className="text-xs text-muted-foreground/80">{t('paymentNoCheckoutFound')}</p>
            )}

            {/* 0.6.82 — manual return-to-app fallback. The auto-bounce into
                the app fires up to 3 times; when the OS protocol handler is
                missing (or the browser dialog was dismissed) this button is
                the payer's visible escape hatch — WITHOUT it the desktop/mobile
                app stayed on its waiting screen forever. */}
            {showReturnToAppButton && (
              <div className="w-full space-y-2">
                <p className="text-xs text-muted-foreground leading-relaxed">{t('paymentOpenAppHint')}</p>
                <Button
                  onClick={() => {
                    logTx('redirect_back', 'blasti:// deep-link manual bounce (fallback button)', { redirectTarget: 'blasti://payment/result', manual: true });
                    try { window.location.href = deepLinkTarget as string; } catch { /* invalid scheme */ }
                  }}
                  variant="outline"
                  className="w-full min-h-[44px] px-6 rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 gap-2"
                >
                  <ExternalLink className="h-4 w-4" />
                  {t('paymentOpenAppCta')}
                </Button>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col sm:flex-row items-center gap-3 w-full mt-1">
              {phase === 'unauthenticated' ? (
                <Button
                  onClick={() => setView('login')}
                  className="w-full sm:w-auto min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg hover:shadow-xl transition-all gap-2"
                >
                  <LogIn className="h-4 w-4" />
                  {t('login')}
                </Button>
              ) : visual === 'unverified' ? (
                // Task 2-e: unverifiable success — steer to the history view
                // instead of celebrating. (Logged-out users keep the login CTA
                // above: signing in IS their path to their history.)
                <Button
                  onClick={() => setView(unverifiedHistoryView)}
                  variant="outline"
                  className="w-full sm:w-auto min-h-[44px] px-6 rounded-2xl border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 gap-2"
                >
                  <History className="h-4 w-4" />
                  {t('paymentUnverifiedCta')}
                </Button>
              ) : phase === 'still-pending' ? (
                <>
                  <Button
                    onClick={restartPolling}
                    className="w-full sm:w-auto min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg hover:shadow-xl transition-all gap-2"
                  >
                    <Loader2 className="h-4 w-4" />
                    {t('refreshStatus')}
                  </Button>
                  {data?.checkoutUrl && (
                    <Button
                      variant="outline"
                      onClick={() => openCheckoutUrl(data.checkoutUrl as string)}
                      className="w-full sm:w-auto min-h-[44px] px-6 rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 gap-2"
                    >
                      {t('openCheckoutPage')}
                    </Button>
                  )}
                </>
              ) : phase !== 'confirming' ? (
                <>
                  {primaryCta && (
                    <Button
                      onClick={() => setView(primaryCta.view)}
                      className="w-full sm:w-auto min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg hover:shadow-xl transition-all"
                    >
                      {primaryCta.label}
                    </Button>
                  )}
                  {showSecondaryHome && (
                    <Button
                      variant="outline"
                      onClick={() => setView('customer-home')}
                      className="w-full sm:w-auto min-h-[44px] px-6 rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                    >
                      {t('backToHome')}
                    </Button>
                  )}
                </>
              ) : null}
            </div>

            {/* Gateway credit — subtle footer inside the card */}
            <p className="mt-2 text-[11px] text-muted-foreground/60 select-none">
              Powered by Chargily · EDAHABIA / CIB
            </p>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

export default PaymentResult;
