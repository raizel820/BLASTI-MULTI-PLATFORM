'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL, type Language } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { Ticket, Monitor, Globe, Clock, Users, Sparkles } from 'lucide-react';

interface KioskLandingProps {
  agency?: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    logoUrl?: string | null;
    workingHoursStart: string;
    workingHoursEnd: string;
    isQueueOpen: boolean;
    isPaused: boolean;
  };
  queueStats?: {
    waiting: number;
    currentServing: string | null;
    estimatedWait: number;
  };
  onTakeTicket?: () => void;
  onViewBoard?: () => void;
  onLanguageChange?: (lang: Language) => void;
  currentLang?: Language;
}

// Floating particle component
function FloatingParticles() {
  const particles = Array.from({ length: 12 }).map((_, i) => ({
    id: i,
    size: Math.random() * 6 + 2,
    x: Math.random() * 100,
    y: Math.random() * 100,
    duration: Math.random() * 8 + 6,
    delay: Math.random() * 5,
  }));

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full bg-emerald-400/20 dark:bg-emerald-300/10"
          style={{
            width: p.size,
            height: p.size,
            left: `${p.x}%`,
            top: `${p.y}%`,
          }}
          animate={{
            y: [0, -30, 0],
            x: [0, p.id % 2 === 0 ? 15 : -15, 0],
            opacity: [0.2, 0.6, 0.2],
            scale: [1, 1.3, 1],
          }}
          transition={{
            duration: p.duration,
            delay: p.delay,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}
    </div>
  );
}

export function KioskLanding({
  agency = { id: '', name: '', workingHoursStart: '08:00', workingHoursEnd: '17:00', isQueueOpen: true, isPaused: false },
  queueStats = { waiting: 0, currentServing: null, estimatedWait: 0 },
  onTakeTicket = () => {},
  onViewBoard = () => {},
  onLanguageChange = () => {},
  currentLang = 'en',
}: KioskLandingProps) {
  const { t } = useLanguage();
  const rtl = isRTL(currentLang);

  const getAgencyName = () => {
    if (currentLang === 'ar' && agency.nameAr) return agency.nameAr;
    if (currentLang === 'fr' && agency.nameFr) return agency.nameFr;
    return agency.name;
  };

  const languages: { code: Language; label: string }[] = [
    { code: 'en', label: 'EN' },
    { code: 'ar', label: 'عربي' },
    { code: 'fr', label: 'FR' },
  ];

  // Idle timeout - auto-reset after 30 seconds of no interaction
  const [idleTimer, setIdleTimer] = useState(0);

  const resetIdle = useCallback(() => {
    setIdleTimer(0);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setIdleTimer((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Listen for any interaction
  useEffect(() => {
    const events = ['touchstart', 'click', 'keydown'] as const;
    const handler = () => resetIdle();
    events.forEach((e) => window.addEventListener(e, handler));
    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
    };
  }, [resetIdle]);

  const isClosed = !agency.isQueueOpen;
  const isPaused = agency.isPaused;

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950 flex flex-col items-center justify-center p-6 select-none relative overflow-hidden"
      dir={rtl ? 'rtl' : 'ltr'}
    >
      {/* Animated background pattern */}
      <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{
        backgroundImage: 'radial-gradient(circle at 25% 25%, #10b981 1px, transparent 1px), radial-gradient(circle at 75% 75%, #14b8a6 1px, transparent 1px)',
        backgroundSize: '50px 50px',
      }} />

      {/* Floating decorative particles */}
      <FloatingParticles />

      {/* Decorative gradient orbs */}
      <div className="absolute top-0 left-0 w-96 h-96 bg-emerald-400/10 dark:bg-emerald-500/5 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-0 right-0 w-96 h-96 bg-teal-400/10 dark:bg-teal-500/5 rounded-full blur-3xl translate-x-1/2 translate-y-1/2" />
      <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-cyan-400/5 dark:bg-cyan-500/3 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />

      {/* Language selector */}
      <div className="absolute top-4 end-4 flex gap-2 z-10">
        {languages.map((lang) => (
          <motion.button
            key={lang.code}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => onLanguageChange(lang.code)}
            className={`min-h-[48px] min-w-[48px] px-4 rounded-xl text-sm font-semibold transition-all ${
              currentLang === lang.code
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-500/25'
                : 'bg-white/80 dark:bg-gray-800/80 text-gray-600 dark:text-gray-300 hover:bg-emerald-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-600 backdrop-blur-sm'
            }`}
          >
            {lang.label}
          </motion.button>
        ))}
      </div>

      {/* Main Content */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="flex flex-col items-center text-center max-w-lg w-full relative z-10"
      >
        {/* BLASTI Logo & Branding with glow */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1, duration: 0.6, type: 'spring', stiffness: 200, damping: 20 }}
          className="mb-6"
        >
          {/* BLASTI brand text with glow */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="mb-4"
          >
            <h2 className="text-2xl font-black bg-gradient-to-r from-emerald-600 via-teal-500 to-cyan-500 dark:from-emerald-400 dark:via-teal-400 dark:to-cyan-400 bg-clip-text text-transparent">
              بلاصتي
            </h2>
            <p className="text-xs text-muted-foreground tracking-widest mt-0.5">BLASTI</p>
          </motion.div>

          {/* Agency Logo */}
          {agency.logoUrl ? (
            <div className="w-24 h-24 mx-auto rounded-2xl overflow-hidden bg-white shadow-xl shadow-emerald-500/10 mb-4 ring-2 ring-emerald-200/50 dark:ring-emerald-700/30">
              <img
                src={agency.logoUrl}
                alt={agency.name}
                className="w-full h-full object-contain"
              />
            </div>
          ) : (
            <div className="w-24 h-24 mx-auto rounded-2xl bg-gradient-to-br from-emerald-600 via-teal-600 to-emerald-500 flex items-center justify-center shadow-xl shadow-emerald-500/20 mb-4 ring-2 ring-emerald-300/30 dark:ring-emerald-600/30">
              <span className="text-3xl font-bold text-white drop-shadow-lg">
                {agency.name.charAt(0)}
              </span>
            </div>
          )}
          <motion.h1
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-3xl font-bold text-gray-900 dark:text-gray-100"
          >
            {getAgencyName()}
          </motion.h1>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
            className="flex items-center justify-center gap-2 mt-2"
          >
            <Clock className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            <p className="text-gray-500 dark:text-gray-400 text-lg">
              {agency.workingHoursStart} — {agency.workingHoursEnd}
            </p>
          </motion.div>
        </motion.div>

        {/* Queue Status Grid */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="grid grid-cols-3 gap-3 w-full mb-8"
        >
          <motion.div
            whileHover={{ scale: 1.05, y: -2 }}
            className="bg-white/90 dark:bg-gray-800/80 backdrop-blur-sm rounded-2xl p-4 shadow-md border border-emerald-100/50 dark:border-emerald-800/30 hover:shadow-lg transition-shadow"
          >
            <div className="h-9 w-9 mx-auto mb-2 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/40 flex items-center justify-center">
              <Users className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{queueStats.waiting}</p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">{t('kioskWaiting')}</p>
          </motion.div>
          <motion.div
            whileHover={{ scale: 1.05, y: -2 }}
            className="bg-white/90 dark:bg-gray-800/80 backdrop-blur-sm rounded-2xl p-4 shadow-md border border-teal-100/50 dark:border-teal-800/30 hover:shadow-lg transition-shadow"
          >
            <div className="h-9 w-9 mx-auto mb-2 rounded-xl bg-gradient-to-br from-teal-100 to-cyan-100 dark:from-teal-900/40 dark:to-cyan-900/40 flex items-center justify-center">
              <Ticket className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {queueStats.currentServing || '—'}
            </p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">{t('kioskNowServing')}</p>
          </motion.div>
          <motion.div
            whileHover={{ scale: 1.05, y: -2 }}
            className="bg-white/90 dark:bg-gray-800/80 backdrop-blur-sm rounded-2xl p-4 shadow-md border border-amber-100/50 dark:border-amber-800/30 hover:shadow-lg transition-shadow"
          >
            <div className="h-9 w-9 mx-auto mb-2 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/40 flex items-center justify-center">
              <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {queueStats.estimatedWait}
            </p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 font-medium">{t('kioskMinutes')}</p>
          </motion.div>
        </motion.div>

        {/* Status Messages */}
        <AnimatePresence>
          {isClosed && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="w-full mb-6 p-4 rounded-2xl bg-gradient-to-r from-red-50 to-rose-50 dark:from-red-900/20 dark:to-rose-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-center text-lg font-semibold"
            >
              {t('kioskQueueClosed')}
            </motion.div>
          )}
          {isPaused && !isClosed && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="w-full mb-6 p-4 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-center text-lg font-semibold"
            >
              {t('kioskQueuePaused')}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Take Ticket Button - with pulsing effect */}
        <motion.button
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onTakeTicket}
          disabled={isClosed || isPaused}
          className={`w-full min-h-[80px] rounded-2xl text-xl font-bold shadow-lg transition-all mb-4 flex items-center justify-center gap-3 relative overflow-hidden ${
            isClosed || isPaused
              ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed shadow-none'
              : 'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 text-white hover:shadow-2xl hover:shadow-emerald-500/30'
          }`}
        >
          {/* Pulsing shimmer effect for active button */}
          {!isClosed && !isPaused && (
            <motion.div
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
              animate={{ x: ['-100%', '200%'] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
          <Ticket className="h-8 w-8 relative z-10" />
          <span className="relative z-10">{t('kioskTakeTicket')}</span>
          {/* Pulse ring effect */}
          {!isClosed && !isPaused && (
            <motion.div
              className="absolute inset-0 rounded-2xl border-2 border-emerald-400/50"
              animate={{ scale: [1, 1.02, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </motion.button>

        {/* Queue Board Button */}
        <motion.button
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.5 }}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onViewBoard}
          className="w-full min-h-[64px] rounded-2xl text-lg font-semibold bg-white/90 dark:bg-gray-800/80 backdrop-blur-sm border-2 border-emerald-200 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-gray-700 hover:shadow-lg hover:border-emerald-300 dark:hover:border-emerald-600 transition-all flex items-center justify-center gap-3"
        >
          <Monitor className="h-6 w-6" />
          {t('kioskQueueBoard')}
        </motion.button>
      </motion.div>

      {/* Footer */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1, duration: 0.5 }}
        className="absolute bottom-4 flex items-center gap-2"
      >
        <Sparkles className="h-3 w-3 text-emerald-500" />
        <p className="text-gray-400 dark:text-gray-500 text-sm">
          BLASTI — {t('kioskTitle')}
        </p>
      </motion.div>
    </div>
  );
}
