'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Monitor, Smartphone, Globe, Download, Apple, ChevronRight, QrCode, Laptop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { usePlatform } from '@/hooks/use-platform';
import { getPlatformIcon, getPlatformLabel, type Platform } from '@/lib/platform';
import { useLanguage } from '@/hooks/use-language';
import { type TranslationKeys } from '@/i18n';

// ─── OS Detection ─────────────────────────────────────────────────────────────

function detectUserOS(): 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mac OS X/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'unknown';
}

function getOSLabel(os: string, t: (key: TranslationKeys, params?: Record<string, string>) => string): string {
  switch (os) {
    case 'macos': return 'macOS';
    case 'windows': return 'Windows';
    case 'linux': return 'Linux';
    case 'android': return 'Android';
    case 'ios': return 'iOS';
    default: return t('platformDesktop');
  }
}

// ─── QR Code Placeholder ──────────────────────────────────────────────────────

function QRCodePlaceholder() {
  return (
    <div className="w-28 h-28 bg-white rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 flex flex-col items-center justify-center gap-1">
      <QrCode className="h-8 w-8 text-gray-400 dark:text-gray-500" />
      <span className="text-[8px] text-gray-400 dark:text-gray-500 text-center leading-tight px-1">
        Scan to<br />download
      </span>
    </div>
  );
}

// ─── Platform Card ────────────────────────────────────────────────────────────

interface PlatformCardConfig {
  id: string;
  nameEn: string;
  nameAr: string;
  icon: typeof Globe;
  descriptionEn: string;
  descriptionAr: string;
  color: string;
  bgColor: string;
  borderColor: string;
  badgeColor: string;
  actionEn: string;
  actionAr: string;
  available: boolean;
  featuresEn: string[];
  featuresAr: string[];
  highlight?: boolean;
}

const platformCards: PlatformCardConfig[] = [
  {
    id: 'web',
    nameEn: 'Web App',
    nameAr: 'تطبيق الويب',
    icon: Globe,
    descriptionEn: 'Access from any browser. No installation needed.',
    descriptionAr: 'الوصول من أي متصفح. لا حاجة للتثبيت.',
    color: 'from-emerald-500 to-teal-600',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderColor: 'border-emerald-200 dark:border-emerald-800',
    badgeColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    actionEn: 'Open Web App',
    actionAr: 'افتح تطبيق الويب',
    available: true,
    featuresEn: ['No installation', 'Works everywhere', 'Always up-to-date'],
    featuresAr: ['بدون تثبيت', 'يعمل في كل مكان', 'دائماً محدث'],
  },
  {
    id: 'desktop',
    nameEn: 'Desktop App',
    nameAr: 'تطبيق الحاسوب',
    icon: Monitor,
    descriptionEn: 'Native desktop experience with system notifications and offline support.',
    descriptionAr: 'تجربة سطح مكتب أصلية مع إشعارات النظام ودعم عدم الاتصال.',
    color: 'from-violet-500 to-purple-600',
    bgColor: 'bg-violet-50 dark:bg-violet-950/30',
    borderColor: 'border-violet-200 dark:border-violet-800',
    badgeColor: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    actionEn: 'Download for Desktop',
    actionAr: 'حمّل للحاسوب',
    available: true,
    featuresEn: ['System notifications', 'Keyboard shortcuts', 'Offline mode'],
    featuresAr: ['إشعارات النظام', 'اختصارات لوحة المفاتيح', 'وضع عدم الاتصال'],
  },
  {
    id: 'mobile',
    nameEn: 'Mobile App',
    nameAr: 'تطبيق الهاتف',
    icon: Smartphone,
    descriptionEn: 'Take BLASTI with you. Push notifications & QR scanner.',
    descriptionAr: 'خذ بلاصتي معك. إشعارات فورية وماسح QR.',
    color: 'from-orange-500 to-red-600',
    bgColor: 'bg-orange-50 dark:bg-orange-950/30',
    borderColor: 'border-orange-200 dark:border-orange-800',
    badgeColor: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    actionEn: 'Download for Mobile',
    actionAr: 'حمّل للهاتف',
    available: true,
    featuresEn: ['Push notifications', 'QR scanner', 'Background updates'],
    featuresAr: ['إشعارات فورية', 'ماسح QR', 'تحديثات في الخلفية'],
  },
];

// ─── Main Component ───────────────────────────────────────────────────────────

export function DownloadSection() {
  const { platform } = usePlatform();
  const { t, lang } = useLanguage();
  const isArabic = lang === 'ar';
  const userOS = useMemo(() => detectUserOS(), []);

  // Determine which card to highlight based on current platform
  const highlightedId = useMemo(() => {
    if (platform.isElectron) return 'desktop';
    if (platform.isMobile) return 'mobile';
    return 'web';
  }, [platform]);

  // Determine the recommended desktop download
  const desktopDownloadLabel = useMemo(() => {
    switch (userOS) {
      case 'macos': return isArabic ? 'حمّل لنظام Mac' : 'Download for Mac';
      case 'windows': return isArabic ? 'حمّل لنظام Windows' : 'Download for Windows';
      case 'linux': return isArabic ? 'حمّل لنظام Linux' : 'Download for Linux';
      default: return isArabic ? 'حمّل للحاسوب' : 'Download for Desktop';
    }
  }, [userOS, isArabic]);

  const handleWebApp = () => {
    // Already on the web app — just scroll to top or show a toast
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDesktopDownload = () => {
    // Placeholder: would link to actual Electron installer
    const urls: Record<string, string> = {
      macos: '#download-mac',
      windows: '#download-windows',
      linux: '#download-linux',
    };
    const url = urls[userOS] || '#download-desktop';
    // For now, just show an alert (app not published yet)
    alert(isArabic ? 'سيكون التحميل متاحاً قريباً!' : 'Download coming soon!');
  };

  const handleMobileDownload = (os: 'ios' | 'android') => {
    // Placeholder: would link to App Store / Play Store
    alert(isArabic ? 'سيكون التحميل متاحاً قريباً!' : 'Coming soon to app stores!');
  };

  return (
    <section className="py-20 px-4 bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-950">
      <div className="max-w-6xl mx-auto">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <Badge variant="outline" className="mb-4 text-emerald-600 border-emerald-300 dark:border-emerald-700">
            {isArabic ? 'متعدد المنصات' : 'Multi-Platform'}
          </Badge>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            {isArabic ? 'BLASTI على كل الأجهزة' : 'BLASTI on Every Device'}
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {isArabic
              ? 'استخدم بلاصتي على الويب أو الحاسوب أو الهاتف — نفس الحساب، نفس البيانات'
              : 'Use BLASTI on the web, desktop, or mobile — same account, same data'}
          </p>

          {/* Current platform indicator */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.3, duration: 0.4 }}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800"
          >
            <span className="text-sm">{getPlatformIcon(platform.platform)}</span>
            <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              {isArabic ? 'منصتك الحالية:' : 'Your platform:'} {getPlatformLabel(platform.platform)}
            </span>
            {platform.isElectron && (
              <Badge variant="secondary" className="text-[9px] bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
                {getOSLabel(platform.os, t)}
              </Badge>
            )}
          </motion.div>
        </motion.div>

        {/* Platform Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {platformCards.map((card, index) => {
            const Icon = card.icon;
            const isHighlighted = card.id === highlightedId;
            return (
              <motion.div
                key={card.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.15 }}
              >
                <Card className={`relative overflow-hidden border-2 ${card.borderColor} ${card.bgColor} hover:shadow-xl transition-all duration-300 group h-full ${isHighlighted ? 'ring-2 ring-emerald-400 dark:ring-emerald-600 ring-offset-2 ring-offset-white dark:ring-offset-gray-950' : ''}`}>
                  {/* Highlight badge */}
                  {isHighlighted && (
                    <div className="absolute top-3 end-3 z-10">
                      <Badge className="bg-emerald-500 text-white text-[9px] font-bold shadow-md">
                        {isArabic ? 'منصتك' : 'Your Platform'}
                      </Badge>
                    </div>
                  )}

                  {/* Gradient top accent */}
                  <div className={`absolute top-0 inset-x-0 h-1 bg-gradient-to-r ${card.color}`} />

                  <CardContent className="pt-8 pb-6 px-6 flex flex-col h-full">
                    {/* Icon */}
                    <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${card.color} flex items-center justify-center mb-4 shadow-lg group-hover:scale-110 transition-transform duration-300`}>
                      <Icon className="h-7 w-7 text-white" />
                    </div>

                    {/* Title & Badge */}
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-xl font-bold text-foreground">
                        {isArabic ? card.nameAr : card.nameEn}
                      </h3>
                      <Badge variant="secondary" className={`text-[10px] ${card.badgeColor}`}>
                        {card.available ? (isArabic ? 'متاح' : 'Available') : (isArabic ? 'قريباً' : 'Coming Soon')}
                      </Badge>
                    </div>

                    <p className="text-sm text-muted-foreground mb-4">
                      {isArabic ? card.descriptionAr : card.descriptionEn}
                    </p>

                    {/* Features */}
                    <ul className="space-y-2 mb-6 flex-1">
                      {(isArabic ? card.featuresAr : card.featuresEn).map((feature, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm text-foreground/80">
                          <ChevronRight className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                          {feature}
                        </li>
                      ))}
                    </ul>

                    {/* Web App CTA */}
                    {card.id === 'web' && (
                      <Button
                        className={`w-full bg-gradient-to-r ${card.color} hover:opacity-90 text-white shadow-md`}
                        size="lg"
                        onClick={handleWebApp}
                      >
                        <Globe className="h-4 w-4 me-2" />
                        {isArabic ? card.actionAr : card.actionEn}
                      </Button>
                    )}

                    {/* Desktop CTA with OS detection */}
                    {card.id === 'desktop' && (
                      <div className="space-y-2">
                        <Button
                          className={`w-full bg-gradient-to-r ${card.color} hover:opacity-90 text-white shadow-md`}
                          size="lg"
                          onClick={handleDesktopDownload}
                        >
                          <Download className="h-4 w-4 me-2" />
                          {desktopDownloadLabel}
                        </Button>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1.5"
                            onClick={() => { if (userOS === 'macos') handleDesktopDownload(); }}
                          >
                            <Apple className="h-3.5 w-3.5" />
                            Mac
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1.5"
                            onClick={() => { if (userOS === 'windows') handleDesktopDownload(); }}
                          >
                            <Laptop className="h-3.5 w-3.5" />
                            Windows
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1.5"
                            onClick={() => { if (userOS === 'linux') handleDesktopDownload(); }}
                          >
                            <Monitor className="h-3.5 w-3.5" />
                            Linux
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Mobile CTA with store badges */}
                    {card.id === 'mobile' && (
                      <div className="space-y-3">
                        <Button
                          className={`w-full bg-gradient-to-r ${card.color} hover:opacity-90 text-white shadow-md`}
                          size="lg"
                          onClick={() => handleMobileDownload(userOS === 'ios' ? 'ios' : 'android')}
                        >
                          <Download className="h-4 w-4 me-2" />
                          {isArabic ? card.actionAr : card.actionEn}
                        </Button>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1.5"
                            onClick={() => handleMobileDownload('ios')}
                          >
                            <Apple className="h-3.5 w-3.5" />
                            App Store
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-xs gap-1.5"
                            onClick={() => handleMobileDownload('android')}
                          >
                            <Smartphone className="h-3.5 w-3.5" />
                            Play Store
                          </Button>
                        </div>
                        {/* QR code for mobile download */}
                        <div className="flex justify-center pt-2">
                          <QRCodePlaceholder />
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>

        {/* API Info Banner */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-10"
        >
          <Card className="border-2 border-dashed border-gray-300 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
            <CardContent className="py-6 px-6">
              <div className="flex flex-col md:flex-row items-center gap-4 text-center md:text-start">
                <div className="w-12 h-12 rounded-xl bg-gray-200 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
                  <span className="text-xl">🔗</span>
                </div>
                <div className="flex-1">
                  <h4 className="font-semibold text-foreground mb-1">
                    {isArabic ? 'واجهة برمجة موحدة' : 'Unified API Backend'}
                  </h4>
                  <p className="text-sm text-muted-foreground">
                    {isArabic
                      ? 'جميع المنصات تتشارك نفس واجهة البرمجة. تطبيقات الويب والحاسوب والهاتف تتصل بنفس الخادم — كود واحد، كل المنصات.'
                      : 'All platforms share the same API. The web, desktop (Electron), and mobile (Capacitor) apps all connect to the same backend — one codebase, every platform.'}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <Badge variant="outline" className="gap-1">🌐 Web</Badge>
                  <Badge variant="outline" className="gap-1">🖥️ Electron</Badge>
                  <Badge variant="outline" className="gap-1">📱 Capacitor</Badge>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </section>
  );
}
