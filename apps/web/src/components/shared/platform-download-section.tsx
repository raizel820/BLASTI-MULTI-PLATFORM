'use client';

import { motion } from 'framer-motion';
import { Monitor, Smartphone, Globe, Download, Apple, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const platforms = [
  {
    id: 'web',
    name: 'Web App',
    nameAr: 'تطبيق الويب',
    icon: Globe,
    description: 'Access from any browser. No installation needed.',
    descriptionAr: 'الوصول من أي متصفح. لا حاجة للتثبيت.',
    color: 'from-emerald-500 to-teal-600',
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderColor: 'border-emerald-200 dark:border-emerald-800',
    badgeColor: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    action: 'Open in Browser',
    actionAr: 'افتح في المتصفح',
    available: true,
    features: ['No installation', 'Works everywhere', 'Always up-to-date'],
    featuresAr: ['بدون تثبيت', 'يعمل في كل مكان', 'دائماً محدث'],
  },
  {
    id: 'desktop',
    name: 'Desktop App',
    nameAr: 'تطبيق الحاسوب',
    icon: Monitor,
    description: 'Native desktop experience with system notifications.',
    descriptionAr: 'تجربة سطح مكتب أصلية مع إشعارات النظام.',
    color: 'from-violet-500 to-purple-600',
    bgColor: 'bg-violet-50 dark:bg-violet-950/30',
    borderColor: 'border-violet-200 dark:border-violet-800',
    badgeColor: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
    action: 'Download for Desktop',
    actionAr: 'حمّل للحاسوب',
    available: true,
    features: ['System notifications', 'Keyboard shortcuts', 'Offline mode'],
    featuresAr: ['إشعارات النظام', 'اختصارات لوحة المفاتيح', 'وضع عدم الاتصال'],
  },
  {
    id: 'mobile',
    name: 'Mobile App',
    nameAr: 'تطبيق الهاتف',
    icon: Smartphone,
    description: 'Take BLASTI with you. Push notifications & QR scanner.',
    descriptionAr: 'خذ بلاصتي معك. إشعارات فورية وماسح QR.',
    color: 'from-orange-500 to-red-600',
    bgColor: 'bg-orange-50 dark:bg-orange-950/30',
    borderColor: 'border-orange-200 dark:border-orange-800',
    badgeColor: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    action: 'Download for Mobile',
    actionAr: 'حمّل للهاتف',
    available: true,
    features: ['Push notifications', 'QR scanner', 'Background updates'],
    featuresAr: ['إشعارات فورية', 'ماسح QR', 'تحديثات في الخلفية'],
  },
];

export function PlatformDownloadSection() {
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
            متعدد المنصات • Multi-Platform
          </Badge>
          <h2 className="text-3xl md:text-4xl font-bold text-foreground mb-4">
            BLASTI على كل الأجهزة
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            استخدم بلاصتي على الويب أو الحاسوب أو الهاتف — نفس الحساب، نفس البيانات
          </p>
        </motion.div>

        {/* Platform Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {platforms.map((platform, index) => {
            const Icon = platform.icon;
            return (
              <motion.div
                key={platform.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.15 }}
              >
                <Card className={`relative overflow-hidden border-2 ${platform.borderColor} ${platform.bgColor} hover:shadow-xl transition-all duration-300 group h-full`}>
                  {/* Gradient top accent */}
                  <div className={`absolute top-0 inset-x-0 h-1 bg-gradient-to-r ${platform.color}`} />

                  <CardContent className="pt-8 pb-6 px-6 flex flex-col h-full">
                    {/* Icon */}
                    <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${platform.color} flex items-center justify-center mb-4 shadow-lg group-hover:scale-110 transition-transform duration-300`}>
                      <Icon className="h-7 w-7 text-white" />
                    </div>

                    {/* Title & Badge */}
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-xl font-bold text-foreground">{platform.nameAr}</h3>
                      <Badge variant="secondary" className={`text-[10px] ${platform.badgeColor}`}>
                        {platform.available ? 'متاح' : 'قريباً'}
                      </Badge>
                    </div>

                    <p className="text-sm text-muted-foreground mb-4">{platform.descriptionAr}</p>

                    {/* Features */}
                    <ul className="space-y-2 mb-6 flex-1">
                      {platform.featuresAr.map((feature, i) => (
                        <li key={i} className="flex items-center gap-2 text-sm text-foreground/80">
                          <ChevronRight className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                          {feature}
                        </li>
                      ))}
                    </ul>

                    {/* Action Button */}
                    <Button
                      className={`w-full bg-gradient-to-r ${platform.color} hover:opacity-90 text-white shadow-md`}
                      size="lg"
                      disabled={!platform.available}
                    >
                      <Download className="h-4 w-4 me-2" />
                      {platform.actionAr}
                    </Button>

                    {/* Sub-actions for mobile */}
                    {platform.id === 'mobile' && (
                      <div className="flex gap-2 mt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 text-xs gap-1.5"
                          disabled={!platform.available}
                        >
                          <Apple className="h-3.5 w-3.5" />
                          iOS
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 text-xs gap-1.5"
                          disabled={!platform.available}
                        >
                          <Smartphone className="h-3.5 w-3.5" />
                          Android
                        </Button>
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
                  <h4 className="font-semibold text-foreground mb-1">Unified API Backend</h4>
                  <p className="text-sm text-muted-foreground">
                    All platforms share the same API deployed on Vercel. The web, desktop (Electron), and mobile (Capacitor) apps
                    all connect to the same backend — one codebase, every platform.
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
