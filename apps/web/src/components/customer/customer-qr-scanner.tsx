'use client';
import { apiFetch } from '@/lib/api-fetch';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  QrCode,
  Camera,
  CameraOff,
  Loader2,
  CheckCircle2,
  XCircle,
  TicketCheck,
  MapPin,
  Clock,
  Users,
  ChevronRight,
  ScanLine,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import jsQR from 'jsqr';

interface CustomerQrScannerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAgencyFound?: (agencyCode: string) => void;
}

interface AgencyInfo {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  address: string;
  customCode: string;
  isQueueOpen: boolean;
  isPaused: boolean;
  currentServingNumber: number;
  lastIssuedNumber: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  avgServiceTime?: number;
  services: { id: string; name: string; nameAr?: string; nameFr?: string; waitingCount: number }[];
}

type ScannerState = 'idle' | 'requesting' | 'scanning' | 'detected' | 'error' | 'result';

export function CustomerQrScanner({ open, onOpenChange, onAgencyFound }: CustomerQrScannerProps) {
  const { t, lang } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const [scannerState, setScannerState] = useState<ScannerState>('idle');
  const [errorType, setErrorType] = useState<'permission' | 'noCamera' | 'general'>('general');
  const [detectedCode, setDetectedCode] = useState<string | null>(null);
  const [agencyInfo, setAgencyInfo] = useState<AgencyInfo | null>(null);
  const [loadingAgency, setLoadingAgency] = useState(false);
  const [scanLineY, setScanLineY] = useState(0);
  const [walkInImportLoading, setWalkInImportLoading] = useState(false);
  const [walkInImportResult, setWalkInImportResult] = useState<{
    displayNumber: string;
    agencyName: string;
    serviceName: string;
    status: string;
  } | null>(null);
  const [walkInImportError, setWalkInImportError] = useState<string | null>(null);

  // Animated scan line
  useEffect(() => {
    if (scannerState !== 'scanning') return;
    let frame = 0;
    const interval = setInterval(() => {
      frame = (frame + 1) % 100;
      setScanLineY(frame);
    }, 20);
    return () => clearInterval(interval);
  }, [scannerState]);

  const stopCamera = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    setScannerState('requesting');
    setErrorType('general');
    setDetectedCode(null);
    setAgencyInfo(null);

    try {
      // Check if mediaDevices API is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErrorType('noCamera');
        setScannerState('error');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setScannerState('scanning');
        scanFrame();
      }
    } catch (err) {
      stopCamera();
      const error = err as DOMException;
      if (
        error.name === 'NotAllowedError' ||
        error.name === 'PermissionDeniedError'
      ) {
        setErrorType('permission');
      } else if (
        error.name === 'NotFoundError' ||
        error.name === 'DevicesNotFoundError'
      ) {
        setErrorType('noCamera');
      } else {
        setErrorType('general');
      }
      setScannerState('error');
    }
  }, [stopCamera]);

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animationFrameRef.current = requestAnimationFrame(scanFrame);
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

    if (code && code.data) {
      const rawQrData = code.data.trim();

      // ─── Check for walk-in import token (Format: URL?claim=TOKEN) ───
      const claimMatch = rawQrData.match(/[?&]claim=([A-Za-z0-9_.-]+)/);
      if (claimMatch) {
        const token = claimMatch[1];
        setDetectedCode(token);
        setScannerState('detected');
        stopCamera();
        if (navigator.vibrate) navigator.vibrate(100);
        importWalkInTicket(token);
        return;
      }

      // ─── Parse QR code data - extract agency code ───
      // Supports URLs like: https://blasti.dz/?code=CLINIC01
      // Supports legacy: "QW:CLINIC01", or plain "CLINIC01"
      let agencyCode = rawQrData;
      
      // Try URL with ?code= parameter
      const codeParamMatch = agencyCode.match(/[?&]code=([A-Za-z0-9_-]+)/);
      if (codeParamMatch) {
        agencyCode = codeParamMatch[1];
      }
      // Try /join/{code} path format
      else {
        const urlMatch = agencyCode.match(/\/join\/([A-Za-z0-9_-]+)(?:\?|$)/);
        if (urlMatch) {
          agencyCode = urlMatch[1];
        }
      }
      // Handle legacy QW: prefix
      if (agencyCode.startsWith('QW:')) {
        agencyCode = agencyCode.slice(3).trim();
      }
      
      if (!agencyCode) {
        setScannerState('error');
        setErrorType('general');
        toast.error(t('agencyNotFound'));
        return;
      }

      // QR code detected
      setDetectedCode(agencyCode);
      setScannerState('detected');
      stopCamera();
      // Vibrate on detection
      if (navigator.vibrate) {
        navigator.vibrate(100);
      }
      // Fetch agency info
      fetchAgencyByCode(agencyCode);
      return;
    }

    animationFrameRef.current = requestAnimationFrame(scanFrame);
  }, [stopCamera]);

  const fetchAgencyByCode = async (code: string) => {
    setLoadingAgency(true);
    try {
      const res = await apiFetch(`/api/agencies/code/${encodeURIComponent(code)}`);
      const data = await res.json();
      if (res.ok && data.success && data.agency) {
        setAgencyInfo(data.agency as AgencyInfo);
        toast.success(t('agencyFound'));
        onAgencyFound?.(code);
      } else {
        setScannerState('error');
        setErrorType('general');
        toast.error(t('agencyNotFound'));
      }
    } catch {
      setScannerState('error');
      setErrorType('general');
      toast.error(t('error'));
    } finally {
      setLoadingAgency(false);
    }
  };

  // ─── Import Walk-in Ticket ──────────────────────────────────────────────
  const importWalkInTicket = async (token: string) => {
    setWalkInImportLoading(true);
    setWalkInImportResult(null);
    setWalkInImportError(null);
    try {
      const res = await apiFetch('/api/reservations/import-walk-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const r = data.reservation;
        setWalkInImportResult({
          displayNumber: r.displayNumber,
          agencyName: r.agency?.name || r.agency?.nameAr || '',
          serviceName: r.service?.name || '',
          status: r.status,
        });
        toast.success(t('walkInImported') || 'Walk-in ticket imported to your queue!');
        setScannerState('result');
      } else if (data.error === 'already_linked') {
        setWalkInImportError(t('ticketAlreadyLinked') || 'This ticket is already linked to an account');
        setScannerState('result');
      } else {
        setWalkInImportError(data.error || t('invalidTicket'));
        setScannerState('error');
      }
    } catch {
      setWalkInImportError(t('error'));
      setScannerState('error');
    } finally {
      setWalkInImportLoading(false);
    }
  };

  // Cleanup on close
  useEffect(() => {
    if (!open) {
      stopCamera();
      setScannerState('idle');
      setDetectedCode(null);
      setAgencyInfo(null);
      setLoadingAgency(false);
      setWalkInImportLoading(false);
      setWalkInImportResult(null);
      setWalkInImportError(null);
    }
  }, [open, stopCamera]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const getAgencyName = (a: AgencyInfo) => {
    if (lang === 'ar' && a.nameAr) return a.nameAr;
    if (lang === 'fr' && a.nameFr) return a.nameFr;
    return a.name;
  };

  const getCategoryLabel = (cat: string) => {
    const catMap: Record<string, string> = {
      CLINIC: t('catClinic'),
      AGENCY: t('catAgency'),
      LAW_FIRM: t('catLawFirm'),
      LABORATORY: t('catLaboratory'),
      GOVERNMENT: t('catGovernment'),
      OTHER: t('catOther'),
    };
    return catMap[cat.toUpperCase()] || cat;
  };

  const isOpenNow = (start: string, end: string) => {
    if (!start || !end) return null;
    const now = new Date();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const cur = now.getHours() * 60 + now.getMinutes();
    return cur >= sh * 60 + sm && cur < eh * 60 + em;
  };

  const handleRescan = () => {
    setDetectedCode(null);
    setAgencyInfo(null);
    setLoadingAgency(false);
    startCamera();
  };

  const handleClose = () => {
    stopCamera();
    onOpenChange(false);
  };

  const renderScanningOverlay = () => (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      {/* Dark overlay with transparent center */}
      <div className="absolute inset-0 bg-black/50" />
      {/* Scanning area */}
      <div className="relative w-56 h-56 sm:w-64 sm:h-64">
        {/* Corner decorations */}
        <div className="absolute -top-1 -start-1 w-8 h-8 border-t-4 border-s-4 border-emerald-400 rounded-tl-2xl" />
        <div className="absolute -top-1 -end-1 w-8 h-8 border-t-4 border-e-4 border-emerald-400 rounded-tr-2xl" />
        <div className="absolute -bottom-1 -start-1 w-8 h-8 border-b-4 border-s-4 border-emerald-400 rounded-bl-2xl" />
        <div className="absolute -bottom-1 -end-1 w-8 h-8 border-b-4 border-e-4 border-emerald-400 rounded-br-2xl" />
        {/* Animated scan line */}
        <motion.div
          className="absolute start-2 end-2 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_rgba(52,211,153,0.6)]"
          animate={{ top: `${scanLineY}%` }}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
        />
      </div>
    </div>
  );

  const renderErrorView = () => {
    const icon = errorType === 'permission' ? CameraOff : Camera;
    const IconComponent = icon;
    const message =
      errorType === 'permission'
        ? t('cameraPermissionDenied')
        : errorType === 'noCamera'
          ? t('noCameraAvailable')
          : t('cameraError');

    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
        <div className="h-16 w-16 rounded-2xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
          <IconComponent className="h-8 w-8 text-red-500" />
        </div>
        <h3 className="text-sm font-semibold text-foreground mb-2">{t('cameraError')}</h3>
        <p className="text-xs text-muted-foreground mb-6 max-w-xs">{message}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleClose}
            className="rounded-xl h-10"
          >
            {t('closeScanner')}
          </Button>
          <Button
            onClick={startCamera}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10"
          >
            <Camera className="h-4 w-4 me-2" />
            {t('scanQrCode')}
          </Button>
        </div>
      </div>
    );
  };

  const renderLoadingView = () => (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Loader2 className="h-10 w-10 text-emerald-600 animate-spin mb-4" />
      <p className="text-sm text-muted-foreground">{t('loading')}</p>
    </div>
  );

  const renderAgencyResult = () => {
    if (!agencyInfo) return null;
    const totalWaiting = agencyInfo.services.reduce((sum, s) => sum + (s.waitingCount || 0), 0);
    const estWait = totalWaiting * (agencyInfo.avgServiceTime || 10);
    const open = agencyInfo.workingHoursStart && agencyInfo.workingHoursEnd
      ? isOpenNow(agencyInfo.workingHoursStart, agencyInfo.workingHoursEnd)
      : null;

    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="px-1"
      >
        {/* Success indicator */}
        <div className="flex items-center justify-center gap-2 mb-4">
          <div className="h-8 w-8 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          </div>
          <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            {t('qrCodeDetected')}
          </span>
        </div>

        {/* Agency Card */}
        <div className="rounded-2xl border border-border bg-white dark:bg-gray-900/80 overflow-hidden">
          <div className="h-20 bg-gradient-to-r from-emerald-500 to-teal-600" />
          <div className="px-4 pb-4 -mt-8">
            <div className="h-14 w-14 rounded-xl bg-white dark:bg-gray-800 shadow-lg flex items-center justify-center mb-2 border-3 border-white dark:border-gray-800">
              <TicketCheck className="h-6 w-6 text-emerald-600" />
            </div>
            <h3 className="text-base font-bold text-foreground mb-1">
              {getAgencyName(agencyInfo)}
            </h3>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
              <MapPin className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">{agencyInfo.address}</span>
            </div>

            {/* Status badges */}
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <Badge variant="outline" className="text-[10px]">
                {getCategoryLabel(agencyInfo.category)}
              </Badge>
              <Badge
                variant="outline"
                className={
                  agencyInfo.isQueueOpen && !agencyInfo.isPaused
                    ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                    : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                }
              >
                {agencyInfo.isPaused ? t('paused') : agencyInfo.isQueueOpen ? t('openNow') : t('closed')}
              </Badge>
              {open !== null && (
                <Badge
                  variant="outline"
                  className={
                    open
                      ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                      : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                  }
                >
                  <Clock className="h-2.5 w-2.5 me-1" />
                  {open
                    ? `${t('openUntil')} ${agencyInfo.workingHoursEnd}`
                    : `${t('closedNow')} · ${t('openFrom')} ${agencyInfo.workingHoursStart}`}
                </Badge>
              )}
            </div>

            {/* Queue Stats */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-2.5 text-center">
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  <Users className="h-3 w-3 text-emerald-600" />
                  <span className="text-[10px] text-muted-foreground">{t('currentlyWaiting')}</span>
                </div>
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{totalWaiting}</p>
              </div>
              <div className="bg-teal-50 dark:bg-teal-900/20 rounded-xl p-2.5 text-center">
                <div className="flex items-center justify-center gap-1 mb-0.5">
                  <Clock className="h-3 w-3 text-teal-600" />
                  <span className="text-[10px] text-muted-foreground">{t('avgWaitTime')}</span>
                </div>
                <p className="text-lg font-bold text-teal-700 dark:text-teal-400">~{estWait} {t('min')}</p>
              </div>
            </div>

            {/* Services preview */}
            {agencyInfo.services.length > 0 && (
              <div className="mb-3">
                <p className="text-[10px] text-muted-foreground mb-1.5">{t('selectService')}</p>
                <div className="space-y-1 max-h-32 overflow-y-auto no-scrollbar">
                  {agencyInfo.services.slice(0, 4).map((svc) => (
                    <div
                      key={svc.id}
                      className="flex items-center justify-between p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50"
                    >
                      <span className="text-xs font-medium truncate">
                        {lang === 'ar' && svc.nameAr ? svc.nameAr : lang === 'fr' && svc.nameFr ? svc.nameFr : svc.name}
                      </span>
                      {svc.waitingCount > 0 && (
                        <Badge variant="secondary" className="text-[9px]">
                          {svc.waitingCount} {t('waiting')}
                        </Badge>
                      )}
                    </div>
                  ))}
                  {agencyInfo.services.length > 4 && (
                    <p className="text-[10px] text-muted-foreground text-center">
                      +{agencyInfo.services.length - 4} {t('services')}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 mt-4">
          <Button
            variant="outline"
            onClick={handleRescan}
            className="flex-1 rounded-xl h-11"
          >
            <ScanLine className="h-4 w-4 me-2" />
            {t('scanQR')}
          </Button>
          <Button
            onClick={handleClose}
            className="flex-1 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-11 font-semibold"
          >
            {t('goToAgency')}
            <ChevronRight className="h-4 w-4 ms-1 rtl:rotate-180" />
          </Button>
        </div>
      </motion.div>
    );
  };

  const renderIdleView = () => (
    <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
      <div className="h-20 w-20 rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mb-5 shadow-lg shadow-emerald-500/25">
        <QrCode className="h-10 w-10 text-white" />
      </div>
      <h3 className="text-base font-semibold text-foreground mb-2">{t('scanQrCode')}</h3>
      <p className="text-xs text-muted-foreground mb-6 max-w-xs">
        {t('pointCameraAtQr')}
      </p>
      <Button
        onClick={startCamera}
        className="bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl h-12 px-8 font-semibold shadow-lg shadow-emerald-500/25"
      >
        <Camera className="h-5 w-5 me-2" />
        {t('scanQrCode')}
      </Button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                <QrCode className="h-4 w-4 text-emerald-600" />
              </div>
              <span>{t('scanQrCode')}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">{t('pointCameraAtQr')}</DialogDescription>
            {scannerState === 'scanning' && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 text-[10px] animate-pulse">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 me-1.5 inline-block" />
                {t('scanningStatus')}
              </Badge>
            )}
            {scannerState === 'detected' && (
              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 text-[10px]">
                <CheckCircle2 className="h-3 w-3 me-1" />
                {t('qrCodeDetected')}
              </Badge>
            )}
          </div>
        </DialogHeader>

        {/* Content */}
        <div className="relative">
          <AnimatePresence mode="wait">
            {/* Camera view */}
            {(scannerState === 'scanning' || scannerState === 'requesting' || scannerState === 'detected') && (
              <motion.div
                key="camera"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="relative bg-black rounded-b-2xl overflow-hidden"
                style={{ aspectRatio: '4/3' }}
              >
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover"
                  playsInline
                  muted
                />
                <canvas
                  ref={canvasRef}
                  className="hidden"
                />

                {scannerState === 'scanning' && renderScanningOverlay()}

                {scannerState === 'requesting' && (
                  <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center">
                    <Loader2 className="h-8 w-8 text-emerald-400 animate-spin mb-3" />
                    <p className="text-xs text-white/80">{t('loading')}</p>
                  </div>
                )}

                {scannerState === 'detected' && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                      className="h-20 w-20 rounded-2xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/50"
                    >
                      <CheckCircle2 className="h-10 w-10 text-white" />
                    </motion.div>
                  </div>
                )}

                {/* Close button overlay */}
                <button
                  onClick={handleClose}
                  className="absolute top-3 end-3 h-8 w-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center hover:bg-black/60 transition-colors z-10"
                >
                  <XCircle className="h-5 w-5 text-white" />
                </button>
              </motion.div>
            )}

            {/* Error view */}
            {scannerState === 'error' && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                {renderErrorView()}
              </motion.div>
            )}

            {/* Idle / start view */}
            {scannerState === 'idle' && (
              <motion.div
                key="idle"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                {renderIdleView()}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Loading agency */}
          {loadingAgency && renderLoadingView()}

          {/* Walk-in import loading */}
          {walkInImportLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center py-8 text-center"
            >
              <Loader2 className="h-8 w-8 text-emerald-600 animate-spin mb-3" />
              <p className="text-sm text-muted-foreground">{t('importingTicket') || 'Importing walk-in ticket...'}</p>
            </motion.div>
          )}

          {/* Walk-in import result */}
          {walkInImportResult && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center py-6 text-center"
            >
              <div className="h-14 w-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-3">
                <TicketCheck className="h-7 w-7 text-emerald-600" />
              </div>
              <p className="text-base font-bold text-foreground mb-1">
                {t('walkInImported') || 'Ticket Imported!'}
              </p>
              <p className="text-2xl font-black text-emerald-600 mb-1">{walkInImportResult.displayNumber}</p>
              <p className="text-xs text-muted-foreground mb-0.5">{walkInImportResult.agencyName}</p>
              <p className="text-xs text-muted-foreground mb-4">{walkInImportResult.serviceName}</p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleClose} className="rounded-xl h-10">
                  {t('closeScanner') || 'Close'}
                </Button>
                <Button onClick={handleRescan} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10">
                  <ScanLine className="h-4 w-4 me-2" />
                  {t('scanAnother') || 'Scan Another'}
                </Button>
              </div>
            </motion.div>
          )}

          {/* Walk-in import error */}
          {walkInImportError && !walkInImportLoading && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center py-6 text-center"
            >
              <div className="h-14 w-14 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
                <XCircle className="h-7 w-7 text-amber-600" />
              </div>
              <p className="text-sm font-semibold text-foreground mb-1">{walkInImportError}</p>
              <div className="flex gap-2 mt-3">
                <Button variant="outline" onClick={handleClose} className="rounded-xl h-10">
                  {t('closeScanner') || 'Close'}
                </Button>
                <Button onClick={handleRescan} className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-10">
                  <ScanLine className="h-4 w-4 me-2" />
                  {t('scanAnother') || 'Scan Another'}
                </Button>
              </div>
            </motion.div>
          )}

          {/* Agency result */}
          {agencyInfo && !loadingAgency && !walkInImportLoading && !walkInImportResult && renderAgencyResult()}
        </div>
      </DialogContent>
    </Dialog>
  );
}
