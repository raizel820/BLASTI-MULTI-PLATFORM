'use client';

import { useEffect } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL, type Language } from '@/i18n';
import { motion } from 'framer-motion';
import { CheckCircle, Clock, Hash } from 'lucide-react';

interface KioskTicketDisplayProps {
  ticketNumber: string;
  position: number;
  estimatedWaitMinutes: number;
  onReturn: () => void;
  currentLang: Language;
}

export function KioskTicketDisplay({
  ticketNumber,
  position,
  estimatedWaitMinutes,
  onReturn,
  currentLang,
}: KioskTicketDisplayProps) {
  const { t } = useLanguage();
  const rtl = isRTL(currentLang);

  // Auto-return after 10 seconds
  useEffect(() => {
    const timer = setTimeout(onReturn, 10000);
    return () => clearTimeout(timer);
  }, [onReturn]);

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-emerald-600 via-emerald-700 to-teal-800 flex flex-col items-center justify-center p-6 text-white select-none"
      dir={rtl ? 'rtl' : 'ltr'}
    >
      {/* Success Icon */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
      >
        <CheckCircle className="h-20 w-20 text-emerald-200 mb-6" />
      </motion.div>

      {/* Thank You */}
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="text-2xl font-medium text-emerald-100 mb-8"
      >
        {t('kioskThankYou')}
      </motion.p>

      {/* Ticket Number - BIG */}
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 150, damping: 12, delay: 0.2 }}
        className="bg-white rounded-3xl p-8 shadow-2xl mb-8 w-full max-w-sm"
      >
        <p className="text-sm font-semibold text-emerald-600 mb-2 uppercase tracking-wider">
          {t('kioskYourTicket')}
        </p>
        <motion.p
          initial={{ scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.5 }}
          className="text-[80px] leading-none font-bold text-gray-900 text-center"
        >
          {ticketNumber}
        </motion.p>
      </motion.div>

      {/* Position & Wait */}
      <div className="grid grid-cols-2 gap-4 w-full max-w-sm mb-8">
        <motion.div
          initial={{ opacity: 0, x: rtl ? 20 : -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.6 }}
          className="bg-white/15 backdrop-blur-sm rounded-2xl p-5 text-center"
        >
          <Hash className="h-6 w-6 text-emerald-200 mx-auto mb-2" />
          <p className="text-3xl font-bold">{position}</p>
          <p className="text-sm text-emerald-200">{t('kioskQueuePosition')}</p>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: rtl ? -20 : 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.7 }}
          className="bg-white/15 backdrop-blur-sm rounded-2xl p-5 text-center"
        >
          <Clock className="h-6 w-6 text-emerald-200 mx-auto mb-2" />
          <p className="text-3xl font-bold">{estimatedWaitMinutes}</p>
          <p className="text-sm text-emerald-200">{t('kioskMinutes')}</p>
        </motion.div>
      </div>

      {/* Return Home */}
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8 }}
        onClick={onReturn}
        className="min-h-[60px] px-8 rounded-2xl bg-white/20 backdrop-blur-sm text-white font-semibold text-lg hover:bg-white/30 transition-colors"
      >
        {t('kioskReturnHome')}
      </motion.button>
    </div>
  );
}
