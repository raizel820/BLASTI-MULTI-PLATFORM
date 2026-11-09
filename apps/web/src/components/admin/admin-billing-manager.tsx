'use client'

/**
 * Admin Billing Manager (0.6.53) — merged "Managing Sales and Operations"
 * billing surface that replaces the old standalone transactions page:
 *
 *   • Transactions — the existing AdminTransactions console (approve / reject
 *     manual receipts, reconcile gateway payments, receipt preview).
 *   • Invoices — the shared InvoicesPanel (official invoices + receipts with
 *     filters, KPIs, preview dialog and admin cancel), in admin mode.
 *   • Legal — BLASTI legal identity editor (issuer block printed on every
 *     invoice / receipt the system issues).
 *
 * All user-facing strings go through the i18n t() helper. RTL-safe: the root
 * wrapper carries dir and only logical (start/end) utility classes are used.
 */

import { useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  CreditCard,
  ReceiptText,
  Landmark,
  Hash,
  Phone,
  Save,
  Loader2,
  AlertTriangle,
  History,
} from 'lucide-react';
import { AdminTransactions } from './admin-transactions';
import { InvoicesPanel } from '@/components/shared/billing/invoices-panel';
import {
  fetchBlastiLegalInfo,
  saveBlastiLegalInfo,
  fetchBackfillStatus,
  runBackfillAll,
  type BackfillStatus,
  type BlastiLegalInfo,
} from '@/lib/billing-client';

/** Empty form used before the server answer arrives (and as save fallback). */
const EMPTY_LEGAL_INFO: BlastiLegalInfo = {
  name: '',
  address: '',
  nif: '',
  nis: '',
  rib: '',
  rc: '',
  rcType: 'RC',
  servicePhone: '',
};

export function AdminBillingManager() {
  const { t, lang } = useLanguage();

  // ── Legal info editor state ────────────────────────────────────────────────
  const [legal, setLegal] = useState<BlastiLegalInfo>(EMPTY_LEGAL_INFO);
  const [loadingLegal, setLoadingLegal] = useState(true);
  const [savingLegal, setSavingLegal] = useState(false);

  // ── 0.6.55 — legacy backfill banner state ──────────────────────────────
  // Settled payments from BEFORE the 0.6.53 billing upgrade carry no invoice;
  // the banner surfaces how many and issues them in idempotent batches.
  const [backfill, setBackfill] = useState<BackfillStatus | null>(null);
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillRefreshKey, setBackfillRefreshKey] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchBackfillStatus()
      .then((s) => { if (alive) setBackfill(s); })
      .catch(() => { /* server older than 0.6.55 — no banner */ });
    return () => { alive = false; };
  }, [backfillRefreshKey]);

  const handleBackfillRun = async () => {
    setBackfillRunning(true);
    try {
      let last = { created: 0, remaining: 0, failed: 0 };
      // Up to 5 rounds × 100 — most ledgers converge in one round.
      for (let round = 0; round < 5; round += 1) {
        last = await runBackfillAll(100);
        if (last.remaining === 0 || (last.created === 0 && last.failed === 0)) break;
      }
      if (last.created > 0) {
        toast.success(`${t('billingBackfillDone') || 'Backfill complete'}: ${last.created}`);
      } else if (last.failed > 0) {
        toast.error(t('billingBackfillFailed') || 'Some invoices could not be issued');
      } else {
        toast.info(t('billingBackfillNone') || 'Nothing to backfill');
      }
      setBackfillRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBackfillRunning(false);
    }
  };

  // Load the issuer block once on mount. Failure keeps the empty form so the
  // admin can still fill it in — the first save will create the record.
  useEffect(() => {
    let alive = true;
    setLoadingLegal(true);
    fetchBlastiLegalInfo()
      .then((info) => {
        if (alive) setLegal({ ...EMPTY_LEGAL_INFO, ...info });
      })
      .catch(() => {
        // Silent — the empty form stays editable; the save surfaces errors.
      })
      .finally(() => {
        if (alive) setLoadingLegal(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const updateLegalField = (key: keyof BlastiLegalInfo, value: string) => {
    setLegal((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveLegal = async () => {
    setSavingLegal(true);
    try {
      const saved = await saveBlastiLegalInfo(legal);
      setLegal({ ...EMPTY_LEGAL_INFO, ...saved });
      toast.success(t('legalInfoSaved'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLegal(false);
    }
  };

  return (
    <div
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      // 0.6.54 — page-shell padding (p-4 / lg:p-6): the manager previously
      // rendered flush against the screen corners. Same convention as the
      // other admin pages that own their own padding.
      className="w-full p-4 lg:p-6 space-y-5"
    >
      {/* Page header — mirrors the admin section-page pattern */}
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/20">
          <CreditCard className="h-5 w-5 text-white" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">
            {t('billingManager')}
          </h1>
          <p className="mt-0.5 text-xs sm:text-sm text-muted-foreground">
            {t('billingManagerSubtitle')}
          </p>
        </div>
      </div>

      <Tabs defaultValue="transactions" className="w-full gap-4">
        {/* Mobile-friendly tab bar: scrollable on narrow screens, min 44px triggers.
            0.6.54 — segmented rounded bar with an active state that actually
            reads as active (data-[state=active] styling on the triggers). */}
        <div className="-mx-1 overflow-x-auto pb-1">
          <TabsList className="inline-flex min-w-max h-auto items-center gap-1 rounded-2xl border border-border/70 bg-muted/50 p-1.5 shadow-sm">
            <TabsTrigger
              value="transactions"
              className="gap-2 min-h-[44px] rounded-xl px-4 text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <CreditCard className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t('billingTabTransactions')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="invoices"
              className="gap-2 min-h-[44px] rounded-xl px-4 text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <ReceiptText className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t('billingTabInvoices')}</span>
            </TabsTrigger>
            <TabsTrigger
              value="legal"
              className="gap-2 min-h-[44px] rounded-xl px-4 text-sm font-medium data-[state=active]:bg-background data-[state=active]:shadow-sm"
            >
              <Landmark className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t('billingTabLegal')}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ── Tab 1: Transactions (legacy console, unchanged) ──────────────── */}
        <TabsContent value="transactions" className="mt-0">
          <AdminTransactions />
        </TabsContent>

        {/* ── Tab 2: Invoices & Receipts (shared panel, admin mode) ───── */}
        <TabsContent value="invoices" className="mt-0 space-y-4">
          {/* 0.6.55 — LEGACY BACKFILL banner: old-system payments without an
              invoice. Zero-missing stays silent — the ledger is complete. */}
          {backfill && backfill.missing > 0 && (
            <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20">
              <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="h-10 w-10 rounded-xl shrink-0 flex items-center justify-center bg-amber-100 dark:bg-amber-900/40">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {t('billingBackfillTitle') || 'Legacy payments without an invoice'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('billingBackfillDesc') || 'Settled payments from before the billing upgrade still lack an official invoice.'}
                    {' '}
                    <span dir="ltr" className="font-semibold">
                      {backfill.missing} ({backfill.byType.transaction} TX · {backfill.byType.sms} SMS)
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-10 shrink-0 bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={() => void handleBackfillRun()}
                  disabled={backfillRunning}
                >
                  {backfillRunning ? <Loader2 className="h-4 w-4 animate-spin me-1.5" aria-hidden="true" /> : <History className="h-4 w-4 me-1.5" aria-hidden="true" />}
                  {t('billingBackfillRun') || 'Backfill now'}
                </Button>
              </CardContent>
            </Card>
          )}
          <InvoicesPanel
            title={t('billingInvoicesTitle')}
            subtitle={t('billingInvoicesSubtitle')}
            adminMode
          />
        </TabsContent>

        {/* ── Tab 3: BLASTI legal identity (issuer block on every document) ── */}
        <TabsContent value="legal" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <Landmark className="h-5 w-5 text-emerald-600 shrink-0" aria-hidden="true" />
                {t('billingLegalTitle')}
              </CardTitle>
              <CardDescription className="text-start">
                {t('billingLegalSubtitle')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingLegal ? (
                // Centered spinner while the server record is loading
                <div className="flex items-center justify-center py-12" role="status" aria-live="polite">
                  <Loader2 className="h-6 w-6 animate-spin text-emerald-600" aria-hidden="true" />
                </div>
              ) : (
                <form
                  className="grid grid-cols-1 md:grid-cols-2 gap-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSaveLegal();
                  }}
                >
                  {/* Legal name + service phone */}
                  <div className="space-y-2">
                    <Label htmlFor="legal-name" className="flex items-center gap-2">
                      <Landmark className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t('legalName')}
                    </Label>
                    <Input
                      id="legal-name"
                      value={legal.name}
                      onChange={(e) => updateLegalField('name', e.target.value)}
                      placeholder={t('legalName')}
                      className="min-h-[44px] text-start"
                      autoComplete="organization"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="legal-service-phone" className="flex items-center gap-2">
                      <Phone className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t('legalServicePhone')}
                    </Label>
                    <Input
                      id="legal-service-phone"
                      value={legal.servicePhone}
                      onChange={(e) => updateLegalField('servicePhone', e.target.value)}
                      placeholder={t('legalServicePhone')}
                      className="min-h-[44px] text-start"
                      inputMode="tel"
                      autoComplete="tel"
                    />
                  </div>

                  {/* Legal address — full width (long value) */}
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="legal-address" className="flex items-center gap-2">
                      <Landmark className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t('legalAddress')}
                    </Label>
                    <Input
                      id="legal-address"
                      value={legal.address}
                      onChange={(e) => updateLegalField('address', e.target.value)}
                      placeholder={t('legalAddress')}
                      className="min-h-[44px] text-start"
                      autoComplete="street-address"
                    />
                  </div>

                  {/* Tax identifiers */}
                  <div className="space-y-2">
                    <Label htmlFor="legal-nif" className="flex items-center gap-2">
                      <Hash className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t('legalNif')}
                    </Label>
                    <Input
                      id="legal-nif"
                      value={legal.nif}
                      onChange={(e) => updateLegalField('nif', e.target.value)}
                      placeholder={t('legalNif')}
                      className="min-h-[44px] text-start"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="legal-nis" className="flex items-center gap-2">
                      <Hash className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t('legalNis')}
                    </Label>
                    <Input
                      id="legal-nis"
                      value={legal.nis}
                      onChange={(e) => updateLegalField('nis', e.target.value)}
                      placeholder={t('legalNis')}
                      className="min-h-[44px] text-start"
                    />
                  </div>

                  {/* Bank / postal account — full width (long RIB value) */}
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="legal-rib" className="flex items-center gap-2">
                      <Landmark className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {t('legalRib')}
                    </Label>
                    <Input
                      id="legal-rib"
                      value={legal.rib}
                      onChange={(e) => updateLegalField('rib', e.target.value)}
                      placeholder={t('legalRib')}
                      className="min-h-[44px] text-start"
                    />
                  </div>

                  {/* Registration: type + number stay together on one row */}
                  <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="legal-rc-type">{t('legalRcType')}</Label>
                      <Select
                        value={legal.rcType === 'AUTO_ENTREPRENEUR' ? 'AUTO_ENTREPRENEUR' : 'RC'}
                        onValueChange={(value) => updateLegalField('rcType', value)}
                      >
                        <SelectTrigger id="legal-rc-type" className="w-full min-h-[44px]">
                          <SelectValue placeholder={t('legalRcType')} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="RC">{t('legalRcTypeRc')}</SelectItem>
                          <SelectItem value="AUTO_ENTREPRENEUR">{t('legalRcTypeAuto')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="legal-rc" className="flex items-center gap-2">
                        <Hash className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        {t('legalRc')}
                      </Label>
                      <Input
                        id="legal-rc"
                        value={legal.rc}
                        onChange={(e) => updateLegalField('rc', e.target.value)}
                        placeholder={t('legalRc')}
                        className="min-h-[44px] text-start"
                      />
                    </div>
                  </div>

                  {/* Save — full width on mobile, end-aligned on larger screens */}
                  <div className="md:col-span-2 flex justify-stretch md:justify-end">
                    <Button
                      type="submit"
                      disabled={savingLegal}
                      className="min-h-[44px] w-full md:w-auto gap-2"
                    >
                      {savingLegal ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Save className="h-4 w-4" aria-hidden="true" />
                      )}
                      {t('save')}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
