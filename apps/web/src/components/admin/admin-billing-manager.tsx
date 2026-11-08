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
} from 'lucide-react';
import { AdminTransactions } from './admin-transactions';
import { InvoicesPanel } from '@/components/shared/billing/invoices-panel';
import {
  fetchBlastiLegalInfo,
  saveBlastiLegalInfo,
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
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} className="w-full">
      <Tabs defaultValue="transactions" className="w-full gap-4">
        {/* Mobile-friendly tab bar: scrollable on narrow screens, min 44px triggers */}
        <div className="overflow-x-auto pb-1">
          <TabsList className="inline-flex min-w-max h-auto p-1">
            <TabsTrigger value="transactions" className="gap-2 min-h-[44px] px-4 text-sm">
              <CreditCard className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t('billingTabTransactions')}</span>
            </TabsTrigger>
            <TabsTrigger value="invoices" className="gap-2 min-h-[44px] px-4 text-sm">
              <ReceiptText className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t('billingTabInvoices')}</span>
            </TabsTrigger>
            <TabsTrigger value="legal" className="gap-2 min-h-[44px] px-4 text-sm">
              <Landmark className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="whitespace-nowrap">{t('billingTabLegal')}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ── Tab 1: Transactions (legacy console, unchanged) ──────────────── */}
        <TabsContent value="transactions" className="mt-0">
          <AdminTransactions />
        </TabsContent>

        {/* ── Tab 2: Invoices & Receipts (shared panel, admin mode) ───────── */}
        <TabsContent value="invoices" className="mt-0">
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
