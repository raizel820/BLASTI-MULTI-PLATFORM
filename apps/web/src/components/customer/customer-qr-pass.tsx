'use client';
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
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
  RefreshCw,
  Clock,
  MapPin,
  Maximize2,
  Minimize2,
  Loader2,
  Timer,
  ScanLine,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface CustomerQrPassProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservationId: string;
  displayNumber: string;
  agencyName: string;
  agencyNameAr?: string | null;
  agencyNameFr?: string | null;
  serviceName: string;
  serviceNameAr?: string | null;
  serviceNameFr?: string | null;
  position: number;
  status: string;
}

interface QrTokenData {
  token: string;
  exp: number; // Unix timestamp
}

export function CustomerQrPass({
  open,
  onOpenChange,
  reservationId,
  displayNumber,
  agencyName,
  agencyNameAr,
  agencyNameFr,
  serviceName,
  serviceNameAr,
  serviceNameFr,
  position,
  status,
}: CustomerQrPassProps) {
  const { t, lang } = useLanguage();
  const { session } = useAppStore();
  const [tokenData, setTokenData] = useState<QrTokenData | null>(null);
  const [qrSvgUrl, setQrSvgUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevOpenRef = useRef(false);

  const getAgencyName = () => {
    if (lang === 'ar' && agencyNameAr) return agencyNameAr;
    if (lang === 'fr' && agencyNameFr) return agencyNameFr;
    return agencyName;
  };

  const getServiceName = () => {
    if (lang === 'ar' && serviceNameAr) return serviceNameAr;
    if (lang === 'fr' && serviceNameFr) return serviceNameFr;
    return serviceName;
  };

  // Generate token when dialog opens
  useEffect(() => {
    if (open && !prevOpenRef.current && reservationId && session?.token) {
      setLoading(true);
      const doGenerate = async () => {
        try {
          const res = await apiFetch('/api/qr-claim/generate?XTransformPort=3003', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.token}`,
            },
            body: JSON.stringify({ reservationId }),
          });
          const data = await res.json();
          if (res.ok && data.success) {
            const exp = Math.floor(Date.now() / 1000) + 30 * 60;
            setTokenData({ token: data.token, exp });
          } else {
            toast.error(data.error || t('error'));
          }
        } catch {
          toast.error(t('error'));
        } finally {
          setLoading(false);
        }
      };
      doGenerate();
    }
    if (!open) {
      // Reset state when dialog closes — schedule outside effect to avoid cascading renders
      setTimeout(() => {
        setTokenData(null);
        setQrSvgUrl(null);
        setIsFullscreen(false);
      }, 0);
    }
    prevOpenRef.current = open;
  }, [open, reservationId, session?.token, t]);

  // Fetch QR code SVG when token is available
  useEffect(() => {
    if (!tokenData?.token || !session?.token) return;

    let revoked = false;
    const fetchQr = async () => {
      try {
        const res = await apiFetch(`/api/qr/import/${reservationId}?XTransformPort=3003`, {
          headers: { 'Authorization': `Bearer ${session.token}` },
        });
        if (res.ok && !revoked) {
          const svg = await res.text();
          const blob = new Blob([svg], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          setQrSvgUrl(url);
        }
      } catch {
        // Silently fail — we still have the token text
      }
    };
    fetchQr();

    return () => {
      revoked = true;
      if (qrSvgUrl) URL.revokeObjectURL(qrSvgUrl);
    };
  }, [tokenData, reservationId, session?.token]);

  // Countdown timer
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (!tokenData) return;

    const updateCountdown = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = tokenData.exp - now;
      setRemainingSeconds(Math.max(0, remaining));
      if (remaining <= 0) {
        if (countdownRef.current) clearInterval(countdownRef.current);
      }
    };

    updateCountdown();
    countdownRef.current = setInterval(updateCountdown, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [tokenData]);

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleRefresh = async () => {
    if (!session?.token || !reservationId) return;
    setLoading(true);
    try {
      const res = await apiFetch('/api/qr-claim/generate?XTransformPort=3003', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.token}`,
        },
        body: JSON.stringify({ reservationId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const exp = Math.floor(Date.now() / 1000) + 30 * 60;
        setTokenData({ token: data.token, exp });
        toast.success(t('qrRefreshToken') || 'QR code refreshed');
      } else {
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const toggleFullscreen = () => setIsFullscreen(!isFullscreen);

  const isExpired = remainingSeconds <= 0 && tokenData !== null;

  if (isFullscreen) {
    return (
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-white dark:bg-gray-950 flex flex-col items-center justify-center p-6"
          >
            <button
              onClick={toggleFullscreen}
              className="absolute top-6 end-6 h-12 w-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Minimize2 className="h-6 w-6" />
            </button>

            <div className="text-center mb-6">
              <p className="text-4xl font-bold text-foreground mb-1">{displayNumber}</p>
              <p className="text-xl text-muted-foreground">{getAgencyName()}</p>
            </div>

            <div className="relative p-6 bg-white rounded-3xl border-2 border-dashed border-emerald-300 dark:border-emerald-700 mb-6">
              {qrSvgUrl ? (
                <img src={qrSvgUrl} alt="QR Code" className="h-64 w-64" />
              ) : (
                <div className="h-64 w-64 flex items-center justify-center">
                  <Loader2 className="h-12 w-12 text-emerald-600 animate-spin" />
                </div>
              )}
            </div>

            {tokenData && (
              <div className="flex items-center gap-3 mb-4">
                <Badge
                  variant="outline"
                  className={
                    isExpired
                      ? 'text-sm bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 px-4 py-1'
                      : remainingSeconds < 300
                        ? 'text-sm bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 px-4 py-1'
                        : 'text-sm bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 px-4 py-1'
                  }
                >
                  <Clock className="h-4 w-4 me-1.5" />
                  {isExpired
                    ? (t('qrExpired') || 'Expired')
                    : `${t('qrExpiresIn') || 'Expires in'} ${formatCountdown(remainingSeconds)}`}
                </Badge>
              </div>
            )}

            <p className="text-lg text-muted-foreground mb-6">
              <ScanLine className="h-5 w-5 inline me-1.5" />
              {t('qrScanAtKiosk') || 'Scan this at the kiosk to check in'}
            </p>

            {isExpired && (
              <Button
                onClick={handleRefresh}
                className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-12 px-8"
              >
                <RefreshCw className="h-5 w-5 me-2" />
                {t('qrRefreshToken') || 'Refresh QR Code'}
              </Button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                <QrCode className="h-4 w-4 text-emerald-600" />
              </div>
              <span>{t('qrShowPass') || 'QR Pass'}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t('qrScanAtKiosk') || 'Scan this at the kiosk to check in'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="px-5 pb-5 pt-3">
          {loading && !tokenData ? (
            <div className="flex flex-col items-center justify-center py-10">
              <Loader2 className="h-10 w-10 text-emerald-600 animate-spin mb-4" />
              <p className="text-sm text-muted-foreground">{t('loading')}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              {/* QR Code */}
              <div className="relative p-4 bg-white dark:bg-gray-900 rounded-2xl border-2 border-dashed border-emerald-300 dark:border-emerald-700">
                {qrSvgUrl ? (
                  <img src={qrSvgUrl} alt="QR Code" className="h-48 w-48" />
                ) : tokenData?.token ? (
                  <div className="h-48 w-48 flex items-center justify-center">
                    <Loader2 className="h-8 w-8 text-emerald-600 animate-spin" />
                  </div>
                ) : (
                  <div className="h-48 w-48 flex items-center justify-center text-muted-foreground">
                    <QrCode className="h-16 w-16 opacity-30" />
                  </div>
                )}
                {isExpired && (
                  <div className="absolute inset-0 bg-white/80 dark:bg-gray-900/80 rounded-2xl flex items-center justify-center">
                    <div className="text-center">
                      <Timer className="h-10 w-10 text-red-500 mx-auto mb-2" />
                      <p className="text-sm font-semibold text-red-600">{t('qrExpired') || 'Expired'}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Reservation info */}
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                  <span className="text-xs text-muted-foreground">{t('ticket') || 'Ticket'}</span>
                  <span className="text-lg font-bold text-emerald-600">{displayNumber}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {t('agency') || 'Agency'}
                  </span>
                  <span className="text-sm font-medium text-foreground truncate ms-2">{getAgencyName()}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                  <span className="text-xs text-muted-foreground">{t('service') || 'Service'}</span>
                  <span className="text-sm font-medium text-foreground truncate ms-2">{getServiceName()}</span>
                </div>
              </div>

              {/* Countdown */}
              {tokenData && (
                <Badge
                  variant="outline"
                  className={
                    isExpired
                      ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                      : remainingSeconds < 300
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200'
                        : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                  }
                >
                  <Clock className="h-3.5 w-3.5 me-1.5" />
                  {isExpired
                    ? (t('qrExpired') || 'Expired')
                    : `${t('qrExpiresIn') || 'Expires in'} ${formatCountdown(remainingSeconds)}`}
                </Badge>
              )}

              {/* Actions */}
              <div className="flex gap-2 w-full">
                <Button
                  variant="outline"
                  onClick={handleRefresh}
                  disabled={loading}
                  className="flex-1 rounded-xl h-11 gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  {t('qrRefreshToken') || 'Refresh'}
                </Button>
                <Button
                  onClick={toggleFullscreen}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl h-11 gap-2"
                >
                  <Maximize2 className="h-4 w-4" />
                  {t('fullscreen') || 'Full Screen'}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center flex items-center gap-1.5">
                <ScanLine className="h-3.5 w-3.5" />
                {t('qrScanAtKiosk') || 'Scan this at the kiosk to check in'}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
