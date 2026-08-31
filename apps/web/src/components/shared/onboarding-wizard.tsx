'use client';

import { useState } from 'react';
import { useAppStore, type UserRole } from '@/store/use-app-store';
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
import { Label } from '@/components/ui/label';
import {
  Globe,
  Bell,
  Smartphone,
  MessageSquare,
  Sparkles,
  Check,
  ArrowRight,
  ArrowLeft,
  LayoutDashboard,
  Users,
  BarChart3,
  ShieldCheck,
  ListOrdered,
  Building2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface OnboardingProps {
  open: boolean;
  user: {
    id: string;
    username: string;
    fullName: string;
    role: UserRole;
    language?: string;
  };
  onComplete: (preferences: { language?: string; reminderMinutes?: number; smsNotificationsEnabled?: boolean }) => void;
  onSkip: () => void;
}

export function OnboardingWizard({ open, user, onComplete, onSkip }: OnboardingProps) {
  const { t } = useLanguage();
  const [step, setStep] = useState(0);
  const [selectedLang, setSelectedLang] = useState(user.language || 'ar');
  const [reminderMinutes, setReminderMinutes] = useState(10);
  const [smsEnabled, setSmsEnabled] = useState(true);

  const totalSteps = user.role === 'SUPER_ADMIN' ? 2 : user.role === 'CUSTOMER' ? 3 : user.role === 'AGENCY_OWNER' ? 4 : 3;

  const handleFinish = () => {
    onComplete({ language: selectedLang, reminderMinutes, smsNotificationsEnabled: smsEnabled });
  };

  const handleNext = () => {
    if (step < totalSteps - 1) {
      setStep(step + 1);
    } else {
      handleFinish();
    }
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const slideVariants = {
    enter: (dir: number) => ({ x: dir > 0 ? 100 : -100, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir: number) => ({ x: dir < 0 ? 100 : -100, opacity: 0 }),
  };

  const [direction, setDirection] = useState(0);

  const goNext = () => { setDirection(1); handleNext(); };
  const goBack = () => { setDirection(-1); handleBack(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onSkip(); }}>
      <DialogContent className="sm:max-w-[480px] p-0 gap-0 overflow-hidden border-0 bg-white dark:bg-gray-950">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('welcomeTo')} BLASTI</DialogTitle>
          <DialogDescription>{t('setupAccountDesc')}</DialogDescription>
        </DialogHeader>
        {/* Step indicator */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400"
                animate={{ width: `${((step + 1) / totalSteps) * 100}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap font-medium">
              {step + 1}/{totalSteps}
            </span>
          </div>

          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.25, ease: 'easeInOut' }}
            >
              {/* Step 0: Welcome */}
              {step === 0 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-16 w-16 rounded-2xl overflow-hidden shadow-lg shadow-emerald-500/20">
                      <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-foreground">{t('welcomeTo')}</h2>
                      <p className="text-xs text-muted-foreground">BLASTI</p>
                    </div>
                  </div>
                  <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4">
                    <p className="text-sm text-emerald-800 dark:text-emerald-300 font-medium">
                      👋 {t('helloUser', { name: user.fullName || user.username })}!
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {t('setupAccountDesc')}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      @{user.username} · {user.role === 'SUPER_ADMIN' ? t('superAdmin') : user.role === 'AGENCY_OWNER' ? t('agencyOwner') : user.role === 'AGENCY_STAFF' ? t('agencyStaff') : t('customer' as any)}
                    </p>
                  </div>
                  {user.role === 'SUPER_ADMIN' && (
                    <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 flex items-start gap-2">
                      <ShieldCheck className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {t('adminOnboardingNote')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Step 1: Language */}
              {step === 1 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-100 to-teal-200 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center">
                      <Globe className="h-5 w-5 text-teal-600 dark:text-teal-400" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-foreground">{t('chooseLanguage')}</h2>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {[
                      { value: 'ar', label: 'العربية', desc: t('languageArabic') },
                      { value: 'fr', label: 'Français', desc: t('languageFrench') },
                      { value: 'en', label: t('languageEnglish'), desc: t('languageEnglish') },
                    ].map((lang) => (
                      <button
                        key={lang.value}
                        onClick={() => setSelectedLang(lang.value)}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all duration-200 text-start ${
                          selectedLang === lang.value
                            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 shadow-sm'
                            : 'border-transparent hover:bg-gray-50 dark:hover:bg-gray-900/50'
                        }`}
                      >
                        <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                          selectedLang === lang.value
                            ? 'bg-emerald-100 dark:bg-emerald-900/40'
                            : 'bg-gray-100 dark:bg-gray-800'
                        }`}>
                          <span className="text-base font-bold">{lang.label.slice(0, 2)}</span>
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-foreground">{lang.label}</p>
                          <p className="text-xs text-muted-foreground">{lang.desc}</p>
                        </div>
                        {selectedLang === lang.value && (
                          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 2: Notifications */}
              {step === 2 && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-200 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center">
                      <Bell className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-foreground">{t('setupNotifications')}</h2>
                    </div>
                  </div>

                  {/* Reminder Time */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium text-foreground">{t('reminderTime')}</Label>
                    <div className="grid grid-cols-3 gap-2">
                      {[5, 10, 15, 20, 30].map((min) => (
                        <button
                          key={min}
                          onClick={() => setReminderMinutes(min)}
                          className={`py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 ${
                            reminderMinutes === min
                              ? 'bg-emerald-600 text-white shadow-sm'
                              : 'bg-gray-100 dark:bg-gray-800 text-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
                          }`}
                        >
                          {min} {t('minutes')}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* SMS Toggle */}
                  <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                        <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">{t('smsNotifications')}</p>
                        <p className="text-[10px] text-muted-foreground">{t('smsNotifToggleDesc')}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => setSmsEnabled(!smsEnabled)}
                      className={`relative h-6 w-11 rounded-full transition-colors duration-200 flex-shrink-0 ${
                        smsEnabled ? 'bg-emerald-600' : 'bg-gray-300 dark:bg-gray-600'
                      }`}
                      role="switch"
                      aria-checked={smsEnabled}
                    >
                      <span
                        className="absolute top-[3px] start-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 pointer-events-none"
                        style={{ transform: smsEnabled ? 'translateX(20px)' : 'translateX(0)' }}
                      />
                    </button>
                  </div>
                </div>
              )}

              {/* Step 3: Create Agency (for AGENCY_OWNER only) */}
              {step === 3 && user.role === 'AGENCY_OWNER' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center">
                      <Building2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-foreground">{t('createYourAgency')}</h2>
                    </div>
                  </div>
                  <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4">
                    <p className="text-sm text-emerald-800 dark:text-emerald-300 font-medium">
                      {t('onboardingCreateAgencyDesc')}
                    </p>
                  </div>
                  <div className="space-y-3">
                    {[
                      { icon: Building2, text: t('onboardingAgencyStep1'), color: 'from-emerald-100 to-emerald-200 dark:from-emerald-900/40 dark:to-emerald-800/40', iconColor: 'text-emerald-600 dark:text-emerald-400' },
                      { icon: ListOrdered, text: t('onboardingAgencyStep2'), color: 'from-teal-100 to-teal-200 dark:from-teal-900/40 dark:to-teal-800/40', iconColor: 'text-teal-600 dark:text-teal-400' },
                      { icon: Users, text: t('onboardingAgencyStep3'), color: 'from-cyan-100 to-cyan-200 dark:from-cyan-900/40 dark:to-cyan-800/40', iconColor: 'text-cyan-600 dark:text-cyan-400' },
                    ].map((tip, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.1 }}
                        className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50"
                      >
                        <div className={`h-9 w-9 rounded-lg bg-gradient-to-br ${tip.color} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                          <tip.icon className={`h-4 w-4 ${tip.iconColor}`} />
                        </div>
                        <p className="text-sm text-foreground leading-relaxed">{tip.text}</p>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 4: Tips (for AGENCY_OWNER) */}
              {step === 4 && user.role === 'AGENCY_OWNER' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-100 to-teal-200 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center">
                      <Sparkles className="h-5 w-5 text-teal-600 dark:text-teal-400" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-foreground">{t('quickTips')}</h2>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {[
                      { icon: LayoutDashboard, text: t('agencyTip1'), color: 'from-emerald-100 to-emerald-200 dark:from-emerald-900/40 dark:to-emerald-800/40', iconColor: 'text-emerald-600 dark:text-emerald-400' },
                      { icon: ListOrdered, text: t('agencyTip2'), color: 'from-teal-100 to-teal-200 dark:from-teal-900/40 dark:to-teal-800/40', iconColor: 'text-teal-600 dark:text-teal-400' },
                      { icon: BarChart3, text: t('agencyTip3'), color: 'from-amber-100 to-amber-200 dark:from-amber-900/40 dark:to-amber-800/40', iconColor: 'text-amber-600 dark:text-amber-400' },
                      { icon: Users, text: t('agencyTip4'), color: 'from-rose-100 to-rose-200 dark:from-rose-900/40 dark:to-rose-800/40', iconColor: 'text-rose-600 dark:text-rose-400' },
                    ].map((tip, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.1 }}
                        className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50"
                      >
                        <div className={`h-9 w-9 rounded-lg bg-gradient-to-br ${tip.color} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                          <tip.icon className={`h-4 w-4 ${tip.iconColor}`} />
                        </div>
                        <p className="text-sm text-foreground leading-relaxed">{tip.text}</p>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 3: Tips (for customer/staff) */}
              {step === 3 && user.role !== 'AGENCY_OWNER' && user.role !== 'SUPER_ADMIN' && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-200 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center">
                      <Smartphone className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-foreground">{t('stayNotified')}</h2>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {[
                      { icon: Bell, text: t('customerTip1'), color: 'from-emerald-100 to-emerald-200 dark:from-emerald-900/40 dark:to-emerald-800/40', iconColor: 'text-emerald-600 dark:text-emerald-400' },
                      { icon: MessageSquare, text: t('customerTip2'), color: 'from-teal-100 to-teal-200 dark:from-teal-900/40 dark:to-teal-800/40', iconColor: 'text-teal-600 dark:text-teal-400' },
                      { icon: Globe, text: t('customerTip3'), color: 'from-amber-100 to-amber-200 dark:from-amber-900/40 dark:to-amber-800/40', iconColor: 'text-amber-600 dark:text-amber-400' },
                    ].map((tip, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: i * 0.1 }}
                        className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50"
                      >
                        <div className={`h-9 w-9 rounded-lg bg-gradient-to-br ${tip.color} flex items-center justify-center flex-shrink-0 shadow-sm`}>
                          <tip.icon className={`h-4 w-4 ${tip.iconColor}`} />
                        </div>
                        <p className="text-sm text-foreground leading-relaxed">{tip.text}</p>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Action Buttons */}
        <div className="px-6 pb-6 pt-2 flex items-center justify-between gap-2 border-t border-gray-100 dark:border-gray-800">
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            className="text-muted-foreground text-xs"
          >
            {t('skip')}
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={goBack}
                className="h-9 gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
                {t('back')}
              </Button>
            )}
            <Button
              size="sm"
              onClick={goNext}
              className="h-9 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white gap-1.5 shadow-sm"
            >
              {step === totalSteps - 1 ? t('getStarted') : t('next')}
              <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
