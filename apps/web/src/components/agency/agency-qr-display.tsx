'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Printer, Download, QrCode, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

export function AgencyQrDisplay() {
  const { user, goBack } = useAppStore();
  const { t, lang } = useLanguage();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [agencyData, setAgencyData] = useState<{ name: string; code: string; nameAr?: string; nameFr?: string } | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchQrCode();
  }, []);

  const fetchQrCode = async () => {
    setLoading(true);
    try {
      // Fetch QR code
      const qrRes = await apiFetch('/api/agency/qr-code');
      if (qrRes.ok) {
        const data = await qrRes.json();
        setQrDataUrl(data.qrCodeDataUrl);
        setAgencyData({
          name: data.agencyName || data.agency?.name || '',
          code: data.agencyCode || data.agency?.code || '',
          nameAr: data.agency?.nameAr,
          nameFr: data.agency?.nameFr,
        });
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    if (!qrDataUrl) return;
    const link = document.createElement('a');
    link.download = `${agencyData?.name || 'blasti-qr'}.png`;
    link.href = qrDataUrl;
    link.click();
    toast.success(t('downloaded'));
  };

  const displayName = lang === 'ar' && agencyData?.nameAr ? agencyData.nameAr
    : lang === 'fr' && agencyData?.nameFr ? agencyData.nameFr
    : agencyData?.name || '';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/25">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-emerald-50 via-teal-50 to-emerald-100 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/25">
      {/* Top bar - hidden in print */}
      <header className="w-full px-4 py-3 flex items-center justify-between print:hidden">
        <Button variant="ghost" size="icon" onClick={goBack} className="h-10 w-10">
          <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="h-12 w-12 rounded-xl overflow-hidden">
            <img src="/blasti-icon.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
          </div>
          <span className="font-bold" style={{ color: '#059669' }}>BLASTI</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handlePrint} className="gap-1.5">
            <Printer className="h-4 w-4" />
            <span className="hidden sm:inline">{t('printQr' as any)}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload} className="gap-1.5">
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">{t('downloadQr')}</span>
          </Button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center p-4" ref={printRef}>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="w-full max-w-lg"
        >
          <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl shadow-emerald-500/10 border border-emerald-100 dark:border-gray-800 overflow-hidden">
            {/* Header gradient */}
            <div className="premium-header-gradient p-6 text-center text-white">
              <div className="h-12 w-12 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center mx-auto mb-3">
                <QrCode className="h-6 w-6 text-white" />
              </div>
              <h1 className="text-xl font-bold">{t('qrDisplayTitle' as any)}</h1>
              <p className="text-sm text-emerald-100 mt-1">{t('qrPrintInstructions' as any)}</p>
            </div>

            {/* QR Code */}
            <div className="p-8 flex flex-col items-center">
              {qrDataUrl ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2, duration: 0.4 }}
                  className="relative"
                >
                  {/* Glow effect behind QR */}
                  <div className="absolute -inset-4 bg-gradient-to-br from-emerald-200/30 to-teal-200/30 dark:from-emerald-800/20 dark:to-teal-800/20 rounded-2xl blur-xl" />
                  <div className="relative bg-white p-4 rounded-2xl shadow-lg border border-gray-100">
                    <img
                      src={qrDataUrl}
                      alt="QR Code"
                      className="w-64 h-64 sm:w-72 sm:h-72"
                    />
                  </div>
                </motion.div>
              ) : (
                <div className="w-64 h-64 sm:w-72 sm:h-72 bg-gray-100 dark:bg-gray-800 rounded-2xl flex items-center justify-center">
                  <QrCode className="h-16 w-16 text-muted-foreground" />
                </div>
              )}

              {/* Agency info */}
              <div className="mt-6 text-center space-y-2">
                {displayName && (
                  <h2 className="text-2xl font-bold text-foreground">{displayName}</h2>
                )}
                {agencyData?.code && (
                  <div className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-50 dark:bg-emerald-900/20 rounded-xl border border-emerald-200 dark:border-emerald-800">
                    <span className="text-sm text-muted-foreground">{t('agencyCode')}:</span>
                    <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 tracking-wider">{agencyData.code}</span>
                  </div>
                )}
                <p className="text-sm text-muted-foreground mt-3">{t('qrScanToJoin' as any)}</p>
              </div>

              {/* Instructions */}
              <div className="mt-8 w-full space-y-3">
                <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
                  <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-emerald-600">1</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{lang === 'ar' ? 'امسح الرمز بكاميرا هاتفك' : 'Scan the QR code with your phone camera'}</p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
                  <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-emerald-600">2</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{lang === 'ar' ? 'اختر الخدمة المطلوبة' : 'Select the service you need'}</p>
                </div>
                <div className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl">
                  <div className="h-6 w-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-emerald-600">3</span>
                  </div>
                  <p className="text-sm text-muted-foreground">{lang === 'ar' ? 'احصل على رقمك وتابع دورك عن بُعد' : 'Get your number and track your turn remotely'}</p>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-8 pb-6 text-center">
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <div className="h-10 w-10 rounded-lg overflow-hidden">
                  <img src="/blasti-icon.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                </div>
                <span className="text-xs font-semibold" style={{ color: '#059669' }}>BLASTI</span>
                <span className="text-[10px] text-muted-foreground/50">· {t('rightsReserved')}</span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Print-specific styles */}
      <style>{`
        @media print {
          header, .print\\:hidden { display: none !important; }
          body { background: white !important; }
          .shadow-2xl, .shadow-lg { box-shadow: none !important; }
          .rounded-3xl { border-radius: 0 !important; }
        }
      `}</style>
    </div>
  );
}
