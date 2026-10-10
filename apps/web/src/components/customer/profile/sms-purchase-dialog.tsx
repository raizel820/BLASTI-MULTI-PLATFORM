'use client';

/**
 * SMS Purchase Dialog — payment-method chooser (Chargily integration).
 *
 * Opened when the customer taps a pack card in the SMS wallet. Offers:
 *  - Instant payment via Chargily (EDAHABIA / CIB) when the super admin
 *    has configured the keys → hosted checkout page in a new tab, SMS
 *    credits are added automatically once the payment is confirmed.
 *  - Manual payment (legacy flow): POST /api/sms/purchase creates a
 *    PENDING request that an admin approves later.
 *
 * Chargily availability comes from GET /api/payment-settings and is cached
 * at module level (5-min TTL) so reopening the dialog is instant.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CreditCard,
  Landmark,
  Loader2,
  MessageSquare,
  Wallet,
} from 'lucide-react';
import type { Language } from '@/i18n';
import type { ProfileTranslate } from './profile-types';
import {
  fetchPaymentSettings,
  startChargilyCheckout,
  type PublicPaymentSettings,
} from '@/lib/chargily-checkout';

export type SmsPackId = '20' | '50' | '100' | '200';

export interface SmsPurchaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packId: SmsPackId | null;
  onManualPurchase: (packId: string) => void;
  lang: Language;
  t: ProfileTranslate;
}

// Pack prices in DZD (mirrors SMS_PACKS in the API + profile-sms-wallet).
const SMS_PACK_PRICES: Record<SmsPackId, number> = {
  '20': 200,
  '50': 400,
  '100': 700,
  '200': 1200,
};

// ─── Payment-settings cache (module level, 5-min TTL) ────────────────────
let paymentSettingsCache: { data: PublicPaymentSettings; fetchedAt: number } | null = null;
const PAYMENT_SETTINGS_TTL_MS = 5 * 60 * 1000;

async function getCachedPaymentSettings(): Promise<PublicPaymentSettings | null> {
  if (paymentSettingsCache && Date.now() - paymentSettingsCache.fetchedAt < PAYMENT_SETTINGS_TTL_MS) {
    return paymentSettingsCache.data;
  }
  // Only successful responses are cached — a transient network failure must
  // not hide the instant option for the next 5 minutes.
  const data = await fetchPaymentSettings();
  if (data) {
    paymentSettingsCache = { data, fetchedAt: Date.now() };
  }
  return data;
}

export function SmsPurchaseDialog({
  open,
  onOpenChange,
  packId,
  onManualPurchase,
  lang,
  t,
}: SmsPurchaseDialogProps) {
  // null = still checking availability
  const [chargilyEnabled, setChargilyEnabled] = useState<boolean | null>(null);
  const [instantExpanded, setInstantExpanded] = useState(false);
  const [startingMethod, setStartingMethod] = useState<'edahabia' | 'cib' | null>(null);

  // Fetch Chargily availability when the dialog opens (cached 5 min).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getCachedPaymentSettings().then((settings) => {
      if (!cancelled) setChargilyEnabled(!!settings?.chargilyEnabled);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset the transient state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setInstantExpanded(false);
      setStartingMethod(null);
    }
  }, [open]);

  const handleChargily = useCallback(
    async (method: 'edahabia' | 'cib') => {
      if (!packId || startingMethod) return;
      setStartingMethod(method);
      try {
        toast.info(t('redirectingToPayment'));
        await startChargilyCheckout(
          { type: 'sms', packId, paymentMethod: method, locale: lang },
          { returnView: 'customer-profile' },
        );
        // The hosted payment page opened in a new tab — close the dialog so
        // the customer lands back on the profile (the payment-result view
        // takes over via the pending checkout in localStorage).
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : t('chargilyUnavailable'));
      } finally {
        setStartingMethod(null);
      }
    },
    [packId, startingMethod, lang, t, onOpenChange],
  );

  const handleManual = () => {
    if (!packId) return;
    onOpenChange(false);
    onManualPurchase(packId);
  };

  const price = packId ? SMS_PACK_PRICES[packId] : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0">
              <MessageSquare className="h-4 w-4 text-emerald-600" />
            </div>
            {t('smsBuyTitle')}
          </DialogTitle>
          <DialogDescription>
            {packId ? `${packId} ${t('messages')} — ${price} ${t('currency')}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5 py-1">
          <p className="text-xs font-medium text-muted-foreground">{t('choosePaymentMethod')}</p>

          {/* Chargily availability check */}
          {chargilyEnabled === null && <Skeleton className="h-20 w-full rounded-xl" />}

          {/* ─── Instant Chargily option ─── */}
          {chargilyEnabled === true && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <button
                type="button"
                onClick={() => setInstantExpanded((prev) => !prev)}
                aria-expanded={instantExpanded}
                className="w-full text-start p-4 rounded-xl border border-emerald-300 dark:border-emerald-700 bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/20 dark:to-teal-900/20 hover:shadow-lg transition-all duration-200"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                    <CreditCard className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-emerald-800 dark:text-emerald-300">
                      {t('smsChargilyOption')}
                    </p>
                    <p className="text-[11px] text-emerald-700/80 dark:text-emerald-400/80">
                      {t('smsChargilyOptionDesc')}
                    </p>
                  </div>
                </div>
              </button>

              {/* Gateway choice revealed under the instant card */}
              <AnimatePresence initial={false}>
                {instantExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      <Button
                        onClick={() => handleChargily('edahabia')}
                        disabled={!!startingMethod}
                        className="h-auto py-3 flex-col gap-1.5 bg-emerald-600 hover:bg-emerald-700 rounded-xl"
                      >
                        {startingMethod === 'edahabia' ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <Landmark className="h-5 w-5" />
                        )}
                        <span className="text-[11px] leading-tight font-semibold">{t('payEdahabiaFull')}</span>
                      </Button>
                      <Button
                        onClick={() => handleChargily('cib')}
                        disabled={!!startingMethod}
                        className="h-auto py-3 flex-col gap-1.5 bg-teal-600 hover:bg-teal-700 rounded-xl"
                      >
                        {startingMethod === 'cib' ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <CreditCard className="h-5 w-5" />
                        )}
                        <span className="text-[11px] leading-tight font-semibold">{t('payCibFull')}</span>
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* ─── Manual option (always available) ─── */}
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            onClick={handleManual}
            className="w-full text-start p-4 rounded-xl border border-border bg-white dark:bg-gray-900 hover:border-emerald-300 dark:hover:border-emerald-700 hover:shadow-lg transition-all duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                <Wallet className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-foreground">{t('smsManualOption')}</p>
                <p className="text-[11px] text-muted-foreground">{t('smsManualOptionDesc')}</p>
              </div>
            </div>
          </motion.button>

          {/* Online payment unavailable note */}
          {chargilyEnabled === false && (
            <p className="text-[11px] text-muted-foreground text-center pt-1">
              {t('chargilyUnavailable')}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
