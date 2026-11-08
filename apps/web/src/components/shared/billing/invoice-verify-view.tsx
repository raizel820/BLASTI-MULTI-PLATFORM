'use client';

/**
 * InvoiceVerifyView — public, role-agnostic verification landing for the
 * QR code printed on every BLASTI invoice/receipt.
 *
 * Reached via `#/invoice/verify/<token>` (encoded in the QR) or any browser
 * camera scan. Calls GET /api/billing/verify/:token — the server validates
 * authenticity and marks the invoice as "checked" (verification count +
 * audit row). No login required; works from a phone camera scan.
 */

import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldX, Ban, Loader2 } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { verifyInvoiceTokenPublic, type InvoiceVerifyResult } from '@/lib/billing-client';
import { parseInvoiceVerifyToken } from '@/store/use-app-store';

export function InvoiceVerifyView() {
  const { t, lang } = useLanguage();
  const [result, setResult] = useState<InvoiceVerifyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);

  // Read the token reactively: the QR link can land on this view while it is
  // already mounted (hash navigation from a previous scan), so re-derive the
  // token on every hashchange — not just on mount.
  useEffect(() => {
    const readToken = () => {
      const hash = typeof window !== 'undefined' ? window.location.hash : '';
      setToken(parseInvoiceVerifyToken(hash));
    };
    readToken();
    window.addEventListener('hashchange', readToken);
    return () => window.removeEventListener('hashchange', readToken);
  }, []);

  useEffect(() => {
    setResult(null);
    if (!token) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    verifyInvoiceTokenPublic(token)
      .then((res) => { if (alive) setResult(res); })
      .catch(() => { if (alive) setResult({ valid: false, reason: 'NOT_FOUND' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token]);

  const rtl = lang === 'ar';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4" dir={rtl ? 'rtl' : 'ltr'}>
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border rounded-xl shadow-sm p-6 space-y-5">
        <div className="flex items-center justify-center gap-3">
          <img src="/logo.png" alt="BLASTI" className="h-10 w-auto" />
          <span className="font-extrabold text-2xl text-teal-700 dark:text-teal-400 tracking-tight">BLASTI</span>
        </div>

        {loading && (
          <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
            <span className="text-sm">…</span>
          </div>
        )}

        {!loading && !token && (
          <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 p-4 text-center">
            <ShieldX className="h-8 w-8 mx-auto text-red-600" aria-hidden="true" />
            <div className="mt-2 font-semibold text-red-700 dark:text-red-300">{t('billingVerifyInvalid')}</div>
          </div>
        )}

        {!loading && token && result?.valid && result.invoice && (
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 p-4 text-center space-y-1">
              <ShieldCheck className="h-10 w-10 mx-auto text-emerald-600" aria-hidden="true" />
              <div className="font-bold text-emerald-700 dark:text-emerald-300 text-lg">{t('billingVerifyValid')}</div>
              <div className="text-xs text-emerald-700/80 dark:text-emerald-400/80">{t('billingVerifyChecked')}</div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('billingInvoiceNumber')}</dt>
              <dd className="font-bold" dir="ltr">{result.invoice.displayNumber}</dd>
              <dt className="text-muted-foreground">{t('billingInvoiceFor')}</dt>
              <dd className="font-semibold">{result.invoice.recipientName}</dd>
              <dt className="text-muted-foreground">{t('billingType')}</dt>
              <dd>{result.invoice.sourceType === 'SMS' ? t('billingTypeSms') : t('billingTypeSubscription')}</dd>
              <dt className="text-muted-foreground">{t('billingAmount')}</dt>
              <dd className="font-semibold">{result.invoice.amount.toLocaleString()} {result.invoice.currency}</dd>
              <dt className="text-muted-foreground">{t('billingIssuedAt')}</dt>
              <dd>{new Date(result.invoice.issuedAt).toLocaleDateString()}</dd>
              <dt className="text-muted-foreground">{t('billingVerification')}</dt>
              <dd>{t('billingVerifiedTimes', { n: String(result.invoice.verificationCount) })}</dd>
            </dl>
          </div>
        )}

        {!loading && token && result && result.reason === 'CANCELLED' && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-4 text-center">
            <Ban className="h-10 w-10 mx-auto text-amber-600" aria-hidden="true" />
            <div className="mt-2 font-bold text-amber-700 dark:text-amber-300">{t('billingVerifyCancelled')}</div>
          </div>
        )}

        {!loading && token && result && !result.valid && result.reason !== 'CANCELLED' && (
          <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 p-4 text-center">
            <ShieldX className="h-10 w-10 mx-auto text-red-600" aria-hidden="true" />
            <div className="mt-2 font-bold text-red-700 dark:text-red-300">{t('billingVerifyInvalid')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
