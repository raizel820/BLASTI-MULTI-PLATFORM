'use client';

/**
 * PaymentSuccessDialog — the user-requested post-payment OPTIONS dialog
 * (0.6.90).
 *
 * THE REPORT (0.6.89 deployed): "as soon as payment completes the
 * confirmation page opens automatically in the browser, without the options
 * dialog I asked for."
 *
 * What the payer wants at the END of a payment:
 *   1. the app confirms the payment LOCALLY (the background settle watcher
 *      polls GET /api/payment/checkout/:id, which settles server-side) and
 *      the activated subscription is visible immediately — no waiting flash;
 *   2. NO confirmation page pops up in the system browser on its own
 *      (desktop main.js 0.6.90 intercepts the gateway's popup detour);
 *   3. a small OPTIONS dialog instead: "verify on the Chargily platform"
 *      (opens the gateway confirmation page in the system browser ONLY when
 *      the user chooses it) or "return to the home page".
 *
 * This component is mounted ONCE at the page root and listens for the
 * `blasti:payment-success` DOM event dispatched by:
 *   - lib/payment-settle-watcher.ts (background settlement — the normal path)
 *   - components/shared/payment-result.tsx (result-view fallback path)
 *
 * The dialog overlays whatever view the app navigated to (the subscription
 * page already shows the ACTIVE status behind it). Dismissing it (Escape /
 * overlay) changes nothing — confirmation is already complete.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { resolvePaymentReturnView } from '@/lib/payment-return-view';
import { PAYMENT_SUCCESS_EVENT } from '@/lib/payment-settle-watcher';
import type { TranslationKeys } from '@/i18n';

interface PaymentSuccessDetail {
  checkoutId?: string;
  /** 'subscription' | 'sms' | 'hardware' | … */
  type?: string;
  amount?: number;
  currency?: string;
  /** Hosted gateway checkout URL — the "verify on Chargily" target. */
  verifyUrl?: string;
}

/** Outcome line per transaction type (keys already exist in i18n). */
const outcomeKeyForType = (type?: string): TranslationKeys => {
  if (type === 'sms') return 'smsCreditsAddedMsg';
  if (type === 'hardware') return 'hardwareOrderConfirmedMsg';
  return 'subscriptionActivatedMsg';
};

export default function PaymentSuccessDialog() {
  const { t } = useLanguage();
  const [detail, setDetail] = useState<PaymentSuccessDetail | null>(null);
  const [isNativeShell, setIsNativeShell] = useState(false);

  useEffect(() => {
    const onSuccess = (e: Event) => {
      const d = ((e as CustomEvent).detail || {}) as PaymentSuccessDetail;
      setDetail(d);
    };
    window.addEventListener(PAYMENT_SUCCESS_EVENT, onSuccess);
    return () => window.removeEventListener(PAYMENT_SUCCESS_EVENT, onSuccess);
  }, []);

  // Electron main window: window.open is intercepted by the main-process
  // handler and routed to the system browser (user-initiated external opens
  // are exactly what it was built for). Capacitor/mobile shells open the
  // system browser via the OS handler too; plain web gets a new tab.
  useEffect(() => {
    try {
      setIsNativeShell(
        !!(window as unknown as { electronAPI?: unknown }).electronAPI ||
        !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.(),
      );
    } catch { /* plain web */ }
  }, []);

  const close = useCallback(() => setDetail(null), []);

  const openVerifyPage = useCallback(() => {
    const url = detail?.verifyUrl;
    close();
    if (!url || !/^https?:\/\//i.test(url)) return;
    const win = isNativeShell
      ? window.open(url, '_blank') // shell handler → system browser
      : window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) window.location.href = url; // popup blocked — same-tab fallback
  }, [detail?.verifyUrl, close, isNativeShell]);

  const goHome = useCallback(() => {
    close();
    try {
      const state = useAppStore.getState();
      const target = resolvePaymentReturnView(undefined, state.user?.role, undefined);
      state.setView(target);
    } catch { /* store not ready — the dialog simply closes */ }
  }, [close]);

  const openDialog = !!detail;
  const hasVerify = !!(detail?.verifyUrl && /^https?:\/\//i.test(detail.verifyUrl));

  return (
    <Dialog open={openDialog} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="sm:max-w-md" role="dialog" aria-label={t('paymentSuccessTitle')}>
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
            <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          </div>
          <DialogTitle className="text-center">{t('paymentSuccessTitle')}</DialogTitle>
          <DialogDescription className="text-center">
            {t('paymentSuccessDesc')}
            <span className="mt-1 block font-medium text-foreground">
              {t(outcomeKeyForType(detail?.type))}
              {typeof detail?.amount === 'number' && detail.amount > 0 ? (
                <span className="text-muted-foreground">
                  {' '}— {t('amountPaidLabel')} {detail.amount.toLocaleString()} {detail?.currency || 'DA'}
                </span>
              ) : null}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col">
          {hasVerify ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={openVerifyPage}
            >
              <ExternalLink className="me-2 h-4 w-4" aria-hidden="true" />
              {t('paymentVerifyGateway')}
            </Button>
          ) : null}
          <Button
            type="button"
            className="w-full"
            onClick={goHome}
          >
            {t('paymentBackHome')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
