'use client';

/**
 * InvoicesPanel — shared invoice list with filters, KPI summary and
 * document actions (preview / print / PDF / copy verify link).
 *
 * Used by:
 *  - the admin Billing Manager ("Invoices & receipts" tab) — all invoices,
 *    admin controls (cancel) enabled,
 *  - the agency subscription/billing surface — API auto-scopes to the agency,
 *  - the customer profile — API auto-scopes to the customer's own purchases.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ChevronLeft, ChevronRight, Eye, FileText, Loader2, ShieldCheck, Search, ReceiptText, Ban, History } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import {
  cancelInvoice,
  fetchInvoiceQr,
  fetchInvoiceVerifications,
  fetchInvoices,
  type InvoiceRecord,
  type InvoiceTotals,
  type InvoiceVerificationEvent,
} from '@/lib/billing-client';
import { InvoicePreviewDialog } from './invoice-preview-dialog';

interface InvoicesPanelProps {
  /** Card chrome (title/subtitle). Set title="" to render bare. */
  title?: string;
  subtitle?: string;
  /** Admin mode: shows cancel + richer verification column. */
  adminMode?: boolean;
  /** Limit raised for admin tables. */
  pageSize?: number;
}

export function InvoicesPanel({ title = '', subtitle = '', adminMode = false, pageSize = 25 }: InvoicesPanelProps) {
  const { t, lang } = useLanguage();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<InvoiceTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState<string>('ALL');
  const [sourceType, setSourceType] = useState<string>('ALL');
  const [status, setStatus] = useState<string>('ALL');
  const [q, setQ] = useState('');
  // 0.6.55 — real server pagination (the panel used to fetch 50 rows and
  // stop; everything past the first page was invisible).
  const [page, setPage] = useState(0);
  const [previewInvoice, setPreviewInvoice] = useState<InvoiceRecord | null>(null);
  const [cancelTarget, setCancelTarget] = useState<InvoiceRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // 0.6.55 — QR verification audit trail (endpoint existed, no UI did).
  const [verifInvoice, setVerifInvoice] = useState<InvoiceRecord | null>(null);
  const [verifEvents, setVerifEvents] = useState<InvoiceVerificationEvent[] | null>(null);
  const [verifLoading, setVerifLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { invoices: rows, total: count, totals: serverTotals } = await fetchInvoices({
        year: year !== 'ALL' ? parseInt(year, 10) : undefined,
        sourceType: sourceType !== 'ALL' ? sourceType : undefined,
        status: status !== 'ALL' ? status : undefined,
        q: q.trim() || undefined,
        limit: pageSize,
        offset: page * pageSize,
      });
      setInvoices(rows);
      setTotal(count);
      setTotals(serverTotals ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [year, sourceType, status, q, pageSize, page]);

  useEffect(() => {
    load();
  }, [load]);

  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: 6 }, (_, i) => String(now - i));
  }, []);

  // 0.6.55 — server totals first (whole filtered set); the client-side
  // page computation stays as the fallback for older servers.
  const kpis = useMemo(() => {
    if (totals) {
      return { issuedCount: totals.issuedCount, invoiced: totals.invoicedAmount, verifications: totals.verifications };
    }
    const issued = invoices.filter((i) => i.status === 'ISSUED');
    const invoiced = issued.reduce((sum, i) => sum + i.amount, 0);
    const verifications = invoices.reduce((sum, i) => sum + i.verificationCount, 0);
    return { issuedCount: issued.length, invoiced, verifications };
  }, [totals, invoices]);

  const handleCancel = async () => {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await cancelInvoice(cancelTarget.id);
      toast.success(t('billingInvoiceCancelled'));
      setCancelTarget(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const typeLabel = (s: string) => (s === 'SMS' ? t('billingTypeSms') : s === 'SUBSCRIPTION' ? t('billingTypeSubscription') : s === 'HARDWARE' ? t('txHardwarePayment') : s);
  const money = (n: number, currency: string) => `${n.toLocaleString()} ${currency === 'DZD' && lang === 'ar' ? 'دج' : currency}`;

  /** 0.6.55 — open the QR verification audit trail for one invoice. */
  const openVerifications = async (inv: InvoiceRecord) => {
    setVerifInvoice(inv);
    setVerifEvents(null);
    setVerifLoading(true);
    try {
      const events = await fetchInvoiceVerifications(inv.id);
      setVerifEvents(events);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setVerifInvoice(null);
    } finally {
      setVerifLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {title !== '' && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
              <ReceiptText className="h-5 w-5 text-teal-600" aria-hidden="true" />
              {title}
            </CardTitle>
            {subtitle && <CardDescription className="text-xs sm:text-sm">{subtitle}</CardDescription>}
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3 pt-0">
            <div className="rounded-lg border p-3 text-center">
              <div className="text-xl sm:text-2xl font-bold text-teal-700 dark:text-teal-400">{kpis.issuedCount}</div>
              <div className="text-[10px] sm:text-xs text-muted-foreground mt-0.5">{t('billingStatsIssued')}</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-xl sm:text-2xl font-bold text-teal-700 dark:text-teal-400">
                {money(kpis.invoiced, invoices[0]?.currency ?? 'DZD')}
              </div>
              <div className="text-[10px] sm:text-xs text-muted-foreground mt-0.5">{t('billingStatsInvoiced')}</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-xl sm:text-2xl font-bold text-teal-700 dark:text-teal-400">{kpis.verifications}</div>
              <div className="text-[10px] sm:text-xs text-muted-foreground mt-0.5">{t('billingStatsVerified')}</div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('billingSearchPlaceholder')}
            className="ps-9 min-h-[44px]"
            aria-label={t('billingSearchPlaceholder')}
          />
        </div>
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger className="w-[130px] min-h-[44px]" aria-label={t('billingYear')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('billingAllYears')}</SelectItem>
            {years.map((y) => (
              <SelectItem key={y} value={y}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sourceType} onValueChange={(v) => { setSourceType(v); setPage(0); }}>
          <SelectTrigger className="w-[140px] min-h-[44px]" aria-label={t('billingType')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('billingAllTypes')}</SelectItem>
            <SelectItem value="SUBSCRIPTION">{t('billingTypeSubscription')}</SelectItem>
            <SelectItem value="SMS">{t('billingTypeSms')}</SelectItem>
            {/* 0.6.55 — HARDWARE invoices are issued since the fulfilment
                wiring; the filter was advertising-only before. */}
            <SelectItem value="HARDWARE">{t('txHardwarePayment')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
          <SelectTrigger className="w-[130px] min-h-[44px]" aria-label={t('billingStatus')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">—</SelectItem>
            <SelectItem value="ISSUED">{t('billingStatusIssued')}</SelectItem>
            <SelectItem value="CANCELLED">{t('billingStatusCancelled')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
          <FileText className="h-8 w-8 mx-auto mb-2 opacity-40" aria-hidden="true" />
          {t('billingNoInvoices')}
        </div>
      ) : (
        <div className="rounded-lg border max-h-[600px] overflow-y-auto billing-invoices-scroll">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                <TableHead className="min-w-[110px]">{t('billingInvoiceNumber')}</TableHead>
                <TableHead className="min-w-[90px]">{t('billingType')}</TableHead>
                <TableHead className="min-w-[140px]">{t('billingInvoiceFor')}</TableHead>
                <TableHead className="min-w-[100px] text-end">{t('billingAmount')}</TableHead>
                <TableHead className="min-w-[110px]">{t('billingIssuedAt')}</TableHead>
                <TableHead className="min-w-[90px]">{t('billingStatus')}</TableHead>
                <TableHead className="min-w-[90px]">{t('billingVerification')}</TableHead>
                <TableHead className="text-end">{t('billingActions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id} className={inv.status === 'CANCELLED' ? 'opacity-60' : ''}>
                  <TableCell className="font-bold" dir="ltr">{inv.displayNumber}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[11px]">
                      {typeLabel(inv.sourceType)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate" title={inv.recipientName}>{inv.recipientName}</TableCell>
                  <TableCell className="text-end font-semibold whitespace-nowrap">{money(inv.amount, inv.currency)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {new Date(inv.issuedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    {inv.status === 'CANCELLED' ? (
                      <Badge variant="destructive" className="text-[11px]">{t('billingStatusCancelled')}</Badge>
                    ) : (
                      <Badge className="bg-emerald-100 text-emerald-800 text-[11px]">{t('billingStatusIssued')}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {inv.verificationCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => adminMode && void openVerifications(inv)}
                        className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"
                        title={adminMode ? t('billingVerificationsTitle') || 'Verification audit trail' : undefined}
                      >
                        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        {inv.verificationCount}
                        {adminMode && <History className="h-3 w-3 opacity-60" aria-hidden="true" />}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-[36px] h-9"
                        onClick={() => setPreviewInvoice(inv)}
                        aria-label={`${t('billingViewInvoice')} ${inv.displayNumber}`}
                      >
                        <Eye className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      {adminMode && inv.status === 'ISSUED' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="min-h-[36px] h-9 text-red-600 hover:text-red-700"
                          onClick={() => setCancelTarget(inv)}
                          aria-label={`${t('billingCancelInvoice')} ${inv.displayNumber}`}
                        >
                          <Ban className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="px-3 py-2 flex items-center justify-between gap-2 text-xs text-muted-foreground border-t">
            <span dir="ltr">
              {total > invoices.length ? `${page * pageSize + 1}–${page * pageSize + invoices.length} / ${total}` : `${total}`}
            </span>
            {/* 0.6.55 — real pagination controls. */}
            {total > pageSize && (
              <span className="inline-flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  aria-label="previous"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <span dir="ltr">{page + 1}/{Math.max(1, Math.ceil(total / pageSize))}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5"
                  disabled={(page + 1) * pageSize >= total || loading}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="next"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </span>
            )}
          </div>
        </div>
      )}

      <InvoicePreviewDialog
        invoice={previewInvoice}
        open={previewInvoice !== null}
        onOpenChange={(open) => { if (!open) setPreviewInvoice(null); }}
      />

      {/* ── 0.6.55 — QR verification audit trail (admin) ── */}
      <Dialog open={verifLoading || verifInvoice !== null} onOpenChange={(open) => { if (!open) setVerifInvoice(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 text-emerald-600" aria-hidden="true" />
              {t('billingVerificationsTitle') || 'Verification audit trail'}
              {verifInvoice && <span className="font-mono text-xs text-muted-foreground" dir="ltr">{verifInvoice.displayNumber}</span>}
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              {t('billingVerificationsDesc') || 'Every QR verification of this document, newest first (last 100).'}
            </DialogDescription>
          </DialogHeader>
          {verifLoading || verifEvents === null ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            </div>
          ) : verifEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t('billingNoVerifications') || 'This invoice has never been verified.'}</p>
          ) : (
            <div className="rounded-lg border max-h-[50vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('billingVerifRole') || 'Verifier'}</TableHead>
                    <TableHead>{t('billingVerifIp') || 'IP'}</TableHead>
                    <TableHead>{t('billingVerifAt') || 'When'}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {verifEvents.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell><Badge variant="outline" className="text-[10px]" dir="ltr">{v.verifierRole}</Badge></TableCell>
                      <TableCell className="font-mono text-[11px]" dir="ltr">{v.ip || '—'}</TableCell>
                      <TableCell className="text-[11px] whitespace-nowrap" dir="ltr">{new Date(v.verifiedAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={cancelTarget !== null} onOpenChange={(open) => { if (!open) setCancelTarget(null); }}>
        <AlertDialogContent dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('billingCancelInvoice')}</AlertDialogTitle>
            <AlertDialogDescription>{t('billingCancelInvoiceConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>{lang === 'ar' ? 'تراجع' : lang === 'fr' ? 'Annuler' : 'Back'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleCancel(); }}
              disabled={cancelling}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {cancelling ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : t('billingCancelInvoice')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
