'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Hash, Printer } from 'lucide-react';

interface TicketConfirmationProps {
  ticketNumber: string;
  customerName: string;
  serviceName: string;
  isVisible: boolean;
  onClose: () => void;
  lang: string;
  t: (key: any) => string;
}

export function TicketConfirmation({
  ticketNumber,
  customerName,
  serviceName,
  isVisible,
  onClose,
  lang,
  t,
}: TicketConfirmationProps) {
  const [printAnimation, setPrintAnimation] = useState(false);

  useEffect(() => {
    if (isVisible) {
      // Use a microtask to avoid calling setState synchronously in effect
      const raf = requestAnimationFrame(() => {
        setPrintAnimation(true);
        const timer = setTimeout(() => {
          setPrintAnimation(false);
        }, 2000);
        return () => clearTimeout(timer);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [isVisible]);

  // Auto-dismiss after 5 seconds
  useEffect(() => {
    if (isVisible) {
      const timer = setTimeout(() => {
        onClose();
      }, 6000);
      return () => clearTimeout(timer);
    }
  }, [isVisible, onClose]);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: -20 }}
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            className="relative bg-white dark:bg-gray-900 rounded-3xl p-8 shadow-2xl max-w-sm w-full mx-4 overflow-hidden"
          >
            {/* Decorative gradient top */}
            <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500" />

            {/* Success icon with animation */}
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200, delay: 0.1 }}
              className="flex justify-center mb-4"
            >
              <div className="h-16 w-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <motion.div
                  initial={{ scale: 0, rotate: -180 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: 'spring', stiffness: 200, delay: 0.2 }}
                >
                  <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
                </motion.div>
              </div>
            </motion.div>

            {/* Title */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="text-center mb-4"
            >
              <h3 className="text-lg font-bold text-foreground">
                {t('ticketCreated' as any) || 'Ticket Created!'}
              </h3>
              <p className="text-xs text-muted-foreground mt-1">
                {t('ticketCreatedDesc' as any) || 'Walk-in customer has been added to the queue'}
              </p>
            </motion.div>

            {/* Ticket display */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
              className="relative bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-2xl p-5 mb-4 border border-emerald-200 dark:border-emerald-800"
            >
              {/* Dashed border effect for ticket look */}
              <div className="absolute inset-2 border-2 border-dashed border-emerald-200 dark:border-emerald-700 rounded-xl pointer-events-none" />

              <div className="relative text-center">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <Hash className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  <motion.p
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 300, delay: 0.5 }}
                    className="text-4xl font-black text-emerald-700 dark:text-emerald-400 ticket-glow"
                  >
                    {ticketNumber}
                  </motion.p>
                </div>
                <p className="text-sm font-medium text-foreground">{customerName}</p>
                {serviceName && (
                  <p className="text-xs text-muted-foreground mt-1">{serviceName}</p>
                )}
              </div>
            </motion.div>

            {/* Print animation */}
            <AnimatePresence>
              {printAnimation && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  className="flex items-center justify-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 mb-4"
                >
                  <motion.div
                    animate={{ rotate: [0, 360] }}
                    transition={{ duration: 1, repeat: 1, ease: 'linear' }}
                  >
                    <Printer className="h-4 w-4" />
                  </motion.div>
                  <span className="font-medium">{t('ticketPrinted' as any) || 'Ticket printed'}</span>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '100%' }}
                    transition={{ duration: 1.5, ease: 'easeOut' }}
                    className="h-0.5 bg-emerald-400 rounded-full max-w-[80px]"
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {!printAnimation && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 mb-4"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-medium">{t('ticketPrinted' as any) || 'Ticket printed'}</span>
              </motion.div>
            )}

            {/* Close button */}
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.6 }}
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-sm font-semibold text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              {t('close' as any) || 'Close'}
            </motion.button>

            {/* Auto-dismiss indicator */}
            <motion.div
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: 6, ease: 'linear' }}
              className="absolute bottom-0 left-0 right-0 h-1 bg-emerald-500 origin-left"
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
