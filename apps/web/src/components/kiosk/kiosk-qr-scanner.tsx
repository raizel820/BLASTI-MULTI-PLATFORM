'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Camera,
  CameraOff,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RotateCcw,
  ScanLine,
  TicketCheck,
} from 'lucide-react';
import jsQR from 'jsqr';

type ClaimState = 'idle' | 'scanning' | 'detected' | 'claiming' | 'success' | 'already_claimed' | 'error' | 'expired' | 'invalid';

interface ClaimResult {
  reservation: {
    id: string;
    displayNumber: string;
    status: string;
    agency: { id: string; name: string; nameAr?: string; nameFr?: string };
    service: { id: string; name: string; nameAr?: string; nameFr?: string };
    customerName?: string | null;
    qrClaimedAt?: string;
  };
}

interface KioskQrScannerProps {
  agencyId?: string;
  deviceId?: string;
  onClaimed?: (result: ClaimResult) => void;
  onBack?: () => void;
}

export function KioskQrScanner({ deviceId = 'kiosk-default', onClaimed, onBack }: KioskQrScannerProps) {
  const { t, lang } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claimStateRef = useRef<ClaimState>('idle');

  const [claimState, setClaimState] = useState<ClaimState>('idle');
  const [scanLineY, setScanLineY] = useState(0);
  const [claimResult, setClaimResult] = useState<ClaimResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [countdown, setCountdown] = useState(0);

  // Keep ref in sync
  useEffect(() => {
    claimStateRef.current = claimState;
  }, [claimState]);

  // Animated scan line
  useEffect(() => {
    if (claimState !== 'scanning') return;
    let frame = 0;
    const interval = setInterval(() => {
      frame = (frame + 1) % 100;
      setScanLineY(frame);
    }, 20);
    return () => clearInterval(interval);
  }, [claimState]);

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

  const handleReset = useCallback(() => {
    stopCamera();
    setClaimState('idle');
    setClaimResult(null);
    setErrorMessage('');
    setCountdown(0);
  }, [stopCamera]);

  const handleClaim = useCallback(async (token: string) => {
    setClaimState('claiming');
    setErrorMessage('');

    try {
      const res = await apiFetch('/api/qr-claim/claim?XTransformPort=3003', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, deviceId }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setClaimResult(data);
        setClaimState('success');
        onClaimed?.(data);
      } else if (res.status === 409 || data.error === 'already_claimed') {
        setClaimState('already_claimed');
        setErrorMessage(data.message || t('qrAlreadyClaimed') || 'This QR code has already been claimed');
      } else if (data.error && data.error.includes('expired')) {
        setClaimState('expired');
        setErrorMessage(t('qrExpired') || 'QR code has expired');
      } else {
        setClaimState('invalid');
        setErrorMessage(t('qrInvalid') || 'Invalid QR code');
      }
    } catch {
      setClaimState('error');
      setErrorMessage(t('error') || 'Network error. Please try again.');
    }
  }, [deviceId, onClaimed, t]);

  const scanFrameRef = useRef<() => void>(() => {});

  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      animationFrameRef.current = requestAnimationFrame(() => scanFrameRef.current());
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
      // QR code detected - extract token from URL if needed
      stopCamera();
      if (navigator.vibrate) navigator.vibrate(100);
      let token = code.data;
      const claimMatch = token.match(/[?&]claim=([A-Za-z0-9_.-]+)/);
      if (claimMatch) token = claimMatch[1];
      handleClaim(token);
      return;
    }

    animationFrameRef.current = requestAnimationFrame(() => scanFrameRef.current());
  }, [stopCamera, handleClaim]);

  // Keep ref in sync
  useEffect(() => {
    scanFrameRef.current = scanFrame;
  }, [scanFrame]);

  const startCamera = useCallback(async () => {
    setClaimState('scanning');
    setClaimResult(null);
    setErrorMessage('');

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErrorMessage(t('noCameraAvailable') || 'No camera available');
        setClaimState('error');
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
        scanFrameRef.current();
      }
    } catch (err) {
      stopCamera();
      const error = err as DOMException;
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        setErrorMessage(t('cameraPermissionDenied') || 'Camera permission denied');
      } else {
        setErrorMessage(t('cameraError') || 'Camera error');
      }
      setClaimState('error');
    }
  }, [stopCamera, scanFrame, t]);

  // Auto-reset timer after success/error
  useEffect(() => {
    if (claimState === 'success' || claimState === 'already_claimed' || claimState === 'error' || claimState === 'expired' || claimState === 'invalid') {
      // Schedule outside effect to avoid cascading renders
      setTimeout(() => setCountdown(5), 0);
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            setTimeout(() => handleReset(), 0);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [claimState, handleReset]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [stopCamera]);

  const getAgencyName = (a: { name: string; nameAr?: string; nameFr?: string }) => {
    if (lang === 'ar' && a.nameAr) return a.nameAr;
    if (lang === 'fr' && a.nameFr) return a.nameFr;
    return a.name;
  };

  const getServiceName = (s: { name: string; nameAr?: string; nameFr?: string }) => {
    if (lang === 'ar' && s.nameAr) return s.nameAr;
    if (lang === 'fr' && s.nameFr) return s.nameFr;
    return s.name;
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[600px] w-full max-w-2xl mx-auto p-6">
      {/* Hidden canvas for QR scanning */}
      <canvas ref={canvasRef} className="hidden" />

      <AnimatePresence mode="wait">
        {/* ─── Idle State ─── */}
        {claimState === 'idle' && (
          <motion.div
            key="idle"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center text-center"
          >
            <div className="h-32 w-32 rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center mb-8 shadow-xl shadow-emerald-500/30">
              <ScanLine className="h-16 w-16 text-white" />
            </div>
            <h2 className="text-3xl font-bold text-foreground mb-3">
              {t('qrScanTitle') || 'Scan QR Code'}
            </h2>
            <p className="text-lg text-muted-foreground mb-10 max-w-md">
              {t('qrScanAtKiosk') || 'Scan your QR code to check in and skip the queue'}
            </p>
            <div className="flex gap-4">
              <button
                onClick={startCamera}
                className="h-16 px-12 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xl font-semibold shadow-lg shadow-emerald-500/25 flex items-center gap-3 transition-all duration-200 hover:shadow-xl"
              >
                <Camera className="h-7 w-7" />
                {t('qrScan') || 'Scan'}
              </button>
              {onBack && (
                <button
                  onClick={onBack}
                  className="h-16 px-8 rounded-2xl border-2 border-gray-200 dark:border-gray-700 text-foreground text-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  {t('back') || 'Back'}
                </button>
              )}
            </div>
          </motion.div>
        )}

        {/* ─── Scanning State ─── */}
        {claimState === 'scanning' && (
          <motion.div
            key="scanning"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="w-full flex flex-col items-center"
          >
            <h2 className="text-2xl font-bold text-foreground mb-4">
              {t('qrScanning') || 'Scanning...'}
            </h2>
            <div className="relative w-full max-w-lg bg-black rounded-3xl overflow-hidden" style={{ aspectRatio: '4/3' }}>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
              {/* Scanning overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="absolute inset-0 bg-black/40" />
                <div className="relative w-64 h-64">
                  <div className="absolute -top-1 -start-1 w-12 h-12 border-t-4 border-s-4 border-emerald-400 rounded-tl-3xl" />
                  <div className="absolute -top-1 -end-1 w-12 h-12 border-t-4 border-e-4 border-emerald-400 rounded-tr-3xl" />
                  <div className="absolute -bottom-1 -start-1 w-12 h-12 border-b-4 border-s-4 border-emerald-400 rounded-bl-3xl" />
                  <div className="absolute -bottom-1 -end-1 w-12 h-12 border-b-4 border-e-4 border-emerald-400 rounded-br-3xl" />
                  <motion.div
                    className="absolute start-3 end-3 h-1 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_16px_rgba(52,211,153,0.7)]"
                    animate={{ top: `${scanLineY}%` }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                  />
                </div>
              </div>
              {/* Cancel button */}
              <button
                onClick={handleReset}
                className="absolute top-4 end-4 h-12 w-12 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center hover:bg-black/70 transition-colors z-10"
              >
                <XCircle className="h-7 w-7 text-white" />
              </button>
            </div>
            <p className="text-base text-muted-foreground mt-4">
              {t('pointCameraAtQr') || 'Point your camera at a QR code'}
            </p>
          </motion.div>
        )}

        {/* ─── Claiming State ─── */}
        {claimState === 'claiming' && (
          <motion.div
            key="claiming"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center text-center"
          >
            <Loader2 className="h-20 w-20 text-emerald-600 animate-spin mb-6" />
            <h2 className="text-2xl font-bold text-foreground mb-2">
              {t('qrClaiming') || 'Checking in...'}
            </h2>
            <p className="text-lg text-muted-foreground">
              {t('pleaseWait') || 'Please wait'}
            </p>
          </motion.div>
        )}

        {/* ─── Success State ─── */}
        {claimState === 'success' && claimResult && (
          <motion.div
            key="success"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex flex-col items-center text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, damping: 15 }}
              className="h-28 w-28 rounded-3xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center mb-6"
            >
              <CheckCircle2 className="h-16 w-16 text-emerald-600" />
            </motion.div>
            <h2 className="text-3xl font-bold text-emerald-700 dark:text-emerald-400 mb-2">
              {t('qrSuccess') || 'Check-in Successful!'}
            </h2>
            <p className="text-lg text-muted-foreground mb-6">
              {t('qrClaimConfirmed') || 'Your reservation has been confirmed'}
            </p>

            {/* Reservation details */}
            <div className="w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl border border-emerald-200 dark:border-emerald-800 p-6 mb-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-12 w-12 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                  <TicketCheck className="h-6 w-6 text-emerald-600" />
                </div>
                <div className="text-start">
                  <p className="text-2xl font-bold text-foreground">
                    {claimResult.reservation.displayNumber}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {getServiceName(claimResult.reservation.service)}
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('agency') || 'Agency'}</span>
                  <span className="font-medium">{getAgencyName(claimResult.reservation.agency)}</span>
                </div>
                {claimResult.reservation.customerName && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{t('customer') || 'Customer'}</span>
                    <span className="font-medium">{claimResult.reservation.customerName}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{t('status') || 'Status'}</span>
                  <span className="font-medium text-emerald-600">{t('confirmed') || 'Confirmed'}</span>
                </div>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              {t('autoResetIn') || 'Auto-reset in'} {countdown}s
            </p>
          </motion.div>
        )}

        {/* ─── Already Claimed State ─── */}
        {claimState === 'already_claimed' && (
          <motion.div
            key="already_claimed"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center text-center"
          >
            <div className="h-28 w-28 rounded-3xl bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center mb-6">
              <AlertTriangle className="h-16 w-16 text-amber-600" />
            </div>
            <h2 className="text-3xl font-bold text-amber-700 dark:text-amber-400 mb-2">
              {t('qrAlreadyClaimed') || 'Already Claimed'}
            </h2>
            <p className="text-lg text-muted-foreground mb-8">
              {errorMessage}
            </p>
            <button
              onClick={handleReset}
              className="h-14 px-10 rounded-2xl bg-gradient-to-r from-amber-600 to-orange-600 text-white text-lg font-semibold shadow-lg flex items-center gap-2"
            >
              <RotateCcw className="h-5 w-5" />
              {t('qrScan') || 'Scan Again'}
            </button>
            <p className="text-sm text-muted-foreground mt-4">
              {t('autoResetIn') || 'Auto-reset in'} {countdown}s
            </p>
          </motion.div>
        )}

        {/* ─── Expired / Invalid / Error States ─── */}
        {(claimState === 'expired' || claimState === 'invalid' || claimState === 'error') && (
          <motion.div
            key={claimState}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="flex flex-col items-center text-center"
          >
            <div className="h-28 w-28 rounded-3xl bg-red-100 dark:bg-red-900/40 flex items-center justify-center mb-6">
              <XCircle className="h-16 w-16 text-red-600" />
            </div>
            <h2 className="text-3xl font-bold text-red-700 dark:text-red-400 mb-2">
              {claimState === 'expired'
                ? (t('qrExpired') || 'QR Code Expired')
                : claimState === 'invalid'
                  ? (t('qrInvalid') || 'Invalid QR Code')
                  : (t('error') || 'Error')}
            </h2>
            <p className="text-lg text-muted-foreground mb-8">
              {errorMessage || (claimState === 'expired'
                ? 'This QR code has expired. Please generate a new one.'
                : claimState === 'invalid'
                  ? 'This QR code is not valid for check-in.'
                  : 'Something went wrong. Please try again.')}
            </p>
            <button
              onClick={handleReset}
              className="h-14 px-10 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-lg font-semibold shadow-lg flex items-center gap-2"
            >
              <RotateCcw className="h-5 w-5" />
              {t('qrScan') || 'Scan Again'}
            </button>
            <p className="text-sm text-muted-foreground mt-4">
              {t('autoResetIn') || 'Auto-reset in'} {countdown}s
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
