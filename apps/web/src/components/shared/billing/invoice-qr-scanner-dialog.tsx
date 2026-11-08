'use client';

/**
 * InvoiceQrScannerDialog — in-app invoice verification scanner.
 *
 * Agency / customer / admin accounts point the camera at the QR code printed
 * on any BLASTI invoice/receipt; the app decodes it (jsQR), extracts the
 * verification token and calls POST /api/billing/invoices/verify — the server
 * checks authenticity AND marks the invoice as "checked" (verification count
 * + audit trail). A manual paste input covers denied-camera environments
 * (desktop builds, LAN shells, kiosks).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScanLine, CameraOff, Loader2, ShieldCheck, ShieldX, Ban } from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import {
  extractVerificationToken,
  verifyInvoiceToken,
  type InvoiceVerifyResult,
} from '@/lib/billing-client';

interface InvoiceQrScannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ScannerState = 'idle' | 'requesting' | 'scanning' | 'error';

export function InvoiceQrScannerDialog({ open, onOpenChange }: InvoiceQrScannerDialogProps) {
  const { t, lang } = useLanguage();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const verifyBusyRef = useRef(false);

  const [state, setState] = useState<ScannerState>('idle');
  const [manualValue, setManualValue] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<InvoiceVerifyResult | null>(null);
  const [errorKind, setErrorKind] = useState<'denied' | 'none'>('none');

  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setState('idle');
  }, []);

  const handleVerified = useCallback((payload: string) => {
    const token = extractVerificationToken(payload);
    if (!token || verifyBusyRef.current) return;
    verifyBusyRef.current = true;
    setVerifying(true);
    verifyInvoiceToken(token)
      .then((res) => setResult(res))
      .catch(() => setResult({ valid: false, reason: 'NOT_FOUND' }))
      .finally(() => {
        verifyBusyRef.current = false;
        setVerifying(false);
      });
  }, []);

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(scanFrame);
      return;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code?.data) {
      stopCamera();
      handleVerified(code.data);
      return;
    }
    rafRef.current = requestAnimationFrame(scanFrame);
  }, [handleVerified, stopCamera]);

  const startCamera = useCallback(async () => {
    setResult(null);
    setErrorKind('none');
    setState('requesting');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('no mediaDevices');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setState('scanning');
        rafRef.current = requestAnimationFrame(scanFrame);
      }
    } catch {
      stopCamera();
      setErrorKind('denied');
      setState('error');
    }
  }, [scanFrame, stopCamera]);

  // Stop the camera whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      stopCamera();
      setResult(null);
      setManualValue('');
      setErrorKind('none');
      setState('idle');
    }
  }, [open, stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const submitManual = () => {
    if (manualValue.trim()) handleVerified(manualValue.trim());
  };

  const renderResult = () => {
    if (verifying) {
      return (
        <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          <span className="text-sm">…</span>
        </div>
      );
    }
    if (!result) return null;

    if (result.valid && result.invoice) {
      const inv = result.invoice;
      return (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 p-4 space-y-3">
          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-semibold">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            {t('billingVerifyValid')}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
            <span className="text-muted-foreground">{t('billingInvoiceNumber')}</span>
            <span className="font-bold" dir="ltr">{inv.displayNumber}</span>
            <span className="text-muted-foreground">{t('billingInvoiceFor')}</span>
            <span className="font-semibold">{inv.recipientName}</span>
            <span className="text-muted-foreground">{t('billingType')}</span>
            <span>{inv.sourceType === 'SMS' ? t('billingTypeSms') : t('billingTypeSubscription')}</span>
            <span className="text-muted-foreground">{t('billingAmount')}</span>
            <span className="font-semibold">{inv.amount.toLocaleString()} {inv.currency}</span>
            <span className="text-muted-foreground">{t('billingIssuedAt')}</span>
            <span>{new Date(inv.issuedAt).toLocaleDateString()}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="bg-emerald-100 text-emerald-800">
              <ShieldCheck className="h-3 w-3 me-1" aria-hidden="true" />
              {t('billingVerifiedTimes', { n: String(inv.verificationCount) })}
            </Badge>
            <span className="text-xs text-muted-foreground">{t('billingVerifyChecked')}</span>
          </div>
        </div>
      );
    }

    if (result.reason === 'CANCELLED') {
      return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-4">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 font-semibold">
            <Ban className="h-5 w-5" aria-hidden="true" />
            {t('billingVerifyCancelled')}
          </div>
          {result.invoice && (
            <div className="mt-2 text-sm">
              <span dir="ltr" className="font-bold">{result.invoice.displayNumber}</span> — {result.invoice.recipientName}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 p-4">
        <div className="flex items-center gap-2 text-red-700 dark:text-red-300 font-semibold">
          <ShieldX className="h-5 w-5" aria-hidden="true" />
          {t('billingVerifyInvalid')}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[95vw]" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-teal-600" aria-hidden="true" />
            {t('billingScannerTitle')}
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">{t('billingScannerHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {(state === 'scanning' || state === 'requesting') && (
            <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted aria-label={t('billingScannerTitle')} />
              <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
              <div className="absolute inset-0 border-[3px] border-white/40 rounded-lg pointer-events-none" aria-hidden="true" />
              {state === 'requesting' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <Loader2 className="h-6 w-6 animate-spin text-white" aria-hidden="true" />
                </div>
              )}
            </div>
          )}

          {state === 'idle' && (
            <Button onClick={startCamera} className="w-full min-h-[44px] bg-teal-600 hover:bg-teal-700 text-white">
              <ScanLine className="h-4 w-4 me-2" aria-hidden="true" />
              {t('billingStartCamera')}
            </Button>
          )}
          {state === 'scanning' && (
            <Button onClick={stopCamera} variant="outline" className="w-full min-h-[44px]">
              <CameraOff className="h-4 w-4 me-2" aria-hidden="true" />
              {t('billingStopCamera')}
            </Button>
          )}
          {state === 'error' && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
              {t('billingCameraDenied')}
            </div>
          )}

          {renderResult()}

          {!result && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="invoice-manual-token">
                {t('billingScanManual')}
              </label>
              <div className="flex gap-2">
                <Input
                  id="invoice-manual-token"
                  value={manualValue}
                  onChange={(e) => setManualValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitManual(); }}
                  placeholder="https://…/#/invoice/verify/…"
                  dir="ltr"
                  className="min-h-[44px]"
                />
                <Button onClick={submitManual} variant="outline" className="min-h-[44px]">
                  {t('billingScanManual')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
