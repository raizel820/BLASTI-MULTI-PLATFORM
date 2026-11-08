'use client';

/**
 * InvoicePreviewDialog — A4 invoice document preview + print/download actions.
 *
 * Renders the standalone invoice HTML (from buildInvoiceHtml) inside an
 * isolated iframe, so the preview is pixel-identical to the printed/PDF
 * output. Works in the browser, Electron desktop and Capacitor mobile shells:
 *  - Print: hidden iframe + window.print (OS dialog → printer or Save as PDF)
 *  - Download PDF (Electron): native main-process printToPDF + save dialog
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Printer, Download, Link2, Loader2, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/use-language';
import {
  fetchInvoiceQr,
  fetchLogoDataUrl,
  type InvoiceRecord,
} from '@/lib/billing-client';
import {
  buildInvoiceHtml,
  printOrDownloadInvoice,
  type InvoiceDocumentAssets,
} from '@/lib/invoice-html';

interface InvoicePreviewDialogProps {
  invoice: InvoiceRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InvoicePreviewDialog({ invoice, open, onOpenChange }: InvoicePreviewDialogProps) {
  const { t, lang } = useLanguage();
  const [assets, setAssets] = useState<InvoiceDocumentAssets | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<'print' | 'download' | null>(null);

  useEffect(() => {
    if (!open || !invoice) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      fetchLogoDataUrl(),
      fetchInvoiceQr(invoice.id).catch(() => null),
    ])
      .then(([logo, qr]) => {
        if (!alive) return;
        setAssets({
          logoDataUrl: logo,
          qrDataUrl: qr?.dataUrl,
          verifyUrl: qr?.verifyUrl,
        });
      })
      .catch(() => {
        if (alive) setAssets({ logoDataUrl: '/logo.png' });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, invoice]);

  const srcDoc = useMemo(() => {
    if (!invoice || !assets) return '';
    return buildInvoiceHtml(invoice, { lang, assets });
  }, [invoice, assets, lang]);

  const handlePrint = async () => {
    if (!invoice || !assets) return;
    setActionBusy('print');
    try {
      const result = await printOrDownloadInvoice(invoice, assets, lang, 'print');
      if (!result.ok && result.message) toast.error(result.message);
    } catch {
      toast.error(t('billingPrint'));
    } finally {
      setActionBusy(null);
    }
  };

  const handleDownload = async () => {
    if (!invoice || !assets) return;
    setActionBusy('download');
    try {
      const result = await printOrDownloadInvoice(invoice, assets, lang, 'download');
      if (result.ok) {
        if (result.message) toast.success(t('billingPdfSaved', { path: result.message }));
        else toast.success(t('billingDownloadPdf'));
      } else if (result.message === 'canceled') {
        toast.info(t('billingPdfCanceled'));
      } else if (result.message) {
        toast.error(result.message);
      }
    } finally {
      setActionBusy(null);
    }
  };

  const handleCopyLink = async () => {
    if (!assets?.verifyUrl) return;
    try {
      await navigator.clipboard.writeText(assets.verifyUrl);
      toast.success(t('billingVerifyUrlCopied'));
    } catch {
      // Clipboard API may be unavailable over plain HTTP LAN — fall back.
      toast.info(assets.verifyUrl);
    }
  };

  if (!invoice) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[92vh] flex flex-col p-0 gap-0" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-6 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Eye className="h-4 w-4 sm:h-5 sm:w-5 text-teal-600" aria-hidden="true" />
            {t('billingPreview')} — <span dir="ltr">{invoice.displayNumber}</span>
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            {invoice.recipientName} · {invoice.amount.toLocaleString()} {invoice.currency}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 bg-slate-100 dark:bg-slate-900 p-3 sm:p-4">
          {loading || !srcDoc ? (
            <div className="h-full min-h-[280px] flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            </div>
          ) : (
            <iframe
              title={`${t('billingPreview')} ${invoice.displayNumber}`}
              srcDoc={srcDoc}
              className="w-full h-[calc(92vh-13rem)] min-h-[420px] bg-white border rounded-md shadow-sm"
              sandbox="allow-same-origin"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 py-3 border-t bg-background">
          <Button
            onClick={handleDownload}
            disabled={loading || actionBusy !== null}
            size="sm"
            className="min-h-[44px] bg-teal-600 hover:bg-teal-700 text-white"
          >
            {actionBusy === 'download' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            {t('billingDownloadPdf')}
          </Button>
          <Button
            onClick={handlePrint}
            disabled={loading || actionBusy !== null}
            size="sm"
            variant="outline"
            className="min-h-[44px]"
          >
            {actionBusy === 'print' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Printer className="h-4 w-4" aria-hidden="true" />}
            {t('billingPrint')}
          </Button>
          {assets?.verifyUrl && (
            <Button onClick={handleCopyLink} disabled={loading} size="sm" variant="outline" className="min-h-[44px]">
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {t('billingCopyVerifyLink')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
