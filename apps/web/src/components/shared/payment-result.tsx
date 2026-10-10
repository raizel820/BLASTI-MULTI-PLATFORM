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
import { CheckCircle2, XCircle, Clock, Loader2, CreditCard, LogIn } from 'lucide-react';
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
import { viewToUrl, getAllowedRolesForView } from '@/lib/route-map';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// ─── Polling budget ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_ATTEMPTS = 40;

/** Mirrors GET /api/payment/checkout/:id → data (see apps/api payment-checkout). */
interface CheckoutStatusData {
  checkoutId: string;
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
let _returnQueryMemo: { status: string | null; checkout: string | null } | null = null;

function readReturnQuery(): { status: string | null; checkout: string | null } {
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
    if (!query) return { status: null, checkout: null };
    const params = new URLSearchParams(query);
    _returnQueryMemo = { status: params.get('status'), checkout: params.get('checkout') };
    return _returnQueryMemo;
  } catch {
    return { status: null, checkout: null };
  }
}

/**
 * A pending checkout may carry a `returnView` — honor it for the primary CTA
 * only when it is a real view this role is allowed to open (and not a loop
 * back onto the result page itself).
 */
function isValidReturnView(view: string | undefined, role: UserRole | undefined): view is ViewName {
  if (!view || !(view in viewToUrl) || view === 'payment-result') return false;
  const allowed = getAllowedRolesForView(view as ViewName);
  return !role || allowed.length === 0 || allowed.includes(role);
}

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

  const attemptsRef = useRef(0);
  const pollingActiveRef = useRef(false);

  // ── Resolve the checkout id (hash query → localStorage → API) ────────────
  useEffect(() => {
    let cancelled = false;

    // Logged out → generic result from the `status` query param, no polling.
    if (!useAppStore.getState().user) {
      setStatusParam(readReturnQuery().status);
      setPhase('unauthenticated');
      return;
    }

    const run = async () => {
      const { status, checkout } = readReturnQuery();
      if (!cancelled) setStatusParam(status);

      const pendingCheckout = getPendingCheckout();
      setPending(pendingCheckout);

      let id: string | null = checkout || pendingCheckout?.checkoutId || null;
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
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Poll GET /api/payment/checkout/:id until settled (or budget out) ─────
  useEffect(() => {
    if (!checkoutId) return;

    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    pollingActiveRef.current = true;
    attemptsRef.current = 0;

    const stopPolling = () => {
      pollingActiveRef.current = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const poll = async () => {
      if (disposed || !pollingActiveRef.current) return;
      attemptsRef.current += 1;
      try {
        const res = await apiFetch(`/api/payment/checkout/${encodeURIComponent(checkoutId)}`);
        if (disposed || !pollingActiveRef.current) return;
        const body = await res.json().catch(() => null);

        if (!res.ok && res.status === 404) {
          stopPolling();
          setPhase('no-checkout');
          return;
        }
        const d = extractPaymentData<CheckoutStatusData>(body);
        if (!res.ok || !d) {
          // Transient API/network hiccup — keep polling while budget remains.
          if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
            stopPolling();
            setPhase('still-pending');
          }
          return;
        }

        setData(d);
        if (d.normalizedStatus === 'paid' || d.normalizedStatus === 'failed') {
          // Settled — the localStorage marker has served its purpose.
          clearPendingCheckout();
          stopPolling();
          setPhase(d.normalizedStatus);
          return;
        }
        if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
          stopPolling();
          setPhase('still-pending');
        }
      } catch {
        if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
          stopPolling();
          setPhase('still-pending');
        }
      }
    };

    // Immediate first check, then every 3s.
    void poll();
    timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    // Returning from the hosted payment tab — check right away instead of
    // waiting for the next interval tick.
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return;
      void poll();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);

    return () => {
      disposed = true;
      stopPolling();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [checkoutId, pollSession]);

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

  let primaryCta: { label: string; view: ViewName } | null = null;
  const pendingReturnView = pending?.returnView;
  if (isValidReturnView(pendingReturnView, role)) {
    primaryCta = { label: primaryLabelForType, view: pendingReturnView };
  } else if (type === 'subscription' || type === 'hardware') {
    primaryCta = { label: t('backToSubscription'), view: 'agency-subscription' };
  } else if (type === 'sms') {
    primaryCta = { label: t('backToSmsWallet'), view: 'customer-profile' };
  } else if (role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF') {
    primaryCta = { label: t('backToHome'), view: 'agency-dashboard' };
  } else if (role === 'SUPER_ADMIN') {
    primaryCta = { label: t('backToHome'), view: 'admin-dashboard' };
  } else if (role === 'CUSTOMER') {
    primaryCta = { label: t('backToHome'), view: 'customer-home' };
  } else {
    primaryCta = { label: t('backToHome'), view: 'landing' };
  }

  // Secondary home CTA — customers only, and never a duplicate of the primary.
  const showSecondaryHome =
    role === 'CUSTOMER' && primaryCta.view !== 'customer-home';

  const knownAmount = data?.amount ?? pending?.amount ?? null;

  // ── Effective visual state ────────────────────────────────────────────────
  // no-checkout / unauthenticated fall back to the generic result derived
  // from the `status` query param (success / failed / neutral).
  const genericStatus =
    statusParam === 'success' ? 'success' : statusParam === 'failed' ? 'failed' : 'neutral';

  type Visual = 'confirming' | 'success' | 'failed' | 'pending' | 'neutral';
  const visual: Visual =
    phase === 'confirming'
      ? 'confirming'
      : phase === 'paid'
        ? 'success'
        : phase === 'failed'
          ? 'failed'
          : phase === 'still-pending'
            ? 'pending'
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
            className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-24 w-24 rounded-full bg-emerald-300 dark:bg-emerald-800"
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
            className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-28 w-28 rounded-full bg-emerald-300 dark:bg-emerald-800"
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

            {/* No-checkout hint (authenticated but nothing to track) */}
            {phase === 'no-checkout' && genericStatus !== 'neutral' && (
              <p className="text-xs text-muted-foreground/80">{t('paymentNoCheckoutFound')}</p>
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
