'use client';

import { useTheme } from 'next-themes';
import { motion, AnimatePresence } from 'framer-motion';
import { Sun, Moon } from 'lucide-react';
import { useSyncExternalStore, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';

// SSR-safe mounting check
function subscribe() { return () => {}; }
function getSnapshot() { return true; }
function getServerSnapshot() { return false; }

export function DarkModeShowcase() {
  const { theme, setTheme } = useTheme();
  const { t, lang } = useLanguage();
  const mounted = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [showTooltip, setShowTooltip] = useState(false);
  const isDark = theme === 'dark';

  // Don't render until mounted to avoid hydration mismatch
  if (!mounted) return null;

  const tooltipText = lang === 'ar' ? 'الوضع الداكن' : 'Dark Mode';
  const currentModeText = isDark
    ? (lang === 'ar' ? 'فاتح' : 'Light')
    : (lang === 'ar' ? 'داكن' : 'Dark');

  return (
    <div className="fixed bottom-6 start-6 z-[9990]">
      <motion.button
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        onHoverStart={() => setShowTooltip(true)}
        onHoverEnd={() => setShowTooltip(false)}
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        className="relative h-12 w-12 rounded-full bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-500 dark:from-emerald-600 dark:via-teal-600 dark:to-cyan-600 flex items-center justify-center text-white shadow-lg shadow-emerald-500/30 dark:shadow-emerald-700/40 transition-shadow duration-300 hover:shadow-xl hover:shadow-emerald-500/40"
        aria-label={tooltipText}
      >
        {/* Glow ring */}
        <motion.div
          className="absolute inset-0 rounded-full bg-gradient-to-br from-emerald-400 via-teal-400 to-cyan-400 opacity-0 hover:opacity-30"
          animate={{ opacity: isDark ? 0.15 : 0 }}
          transition={{ duration: 0.3 }}
        />

        <AnimatePresence mode="wait">
          {isDark ? (
            <motion.div
              key="sun"
              initial={{ rotate: -90, opacity: 0, scale: 0.5 }}
              animate={{ rotate: 0, opacity: 1, scale: 1 }}
              exit={{ rotate: 90, opacity: 0, scale: 0.5 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            >
              <Sun className="h-5 w-5 text-amber-200" />
            </motion.div>
          ) : (
            <motion.div
              key="moon"
              initial={{ rotate: 90, opacity: 0, scale: 0.5 }}
              animate={{ rotate: 0, opacity: 1, scale: 1 }}
              exit={{ rotate: -90, opacity: 0, scale: 0.5 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            >
              <Moon className="h-5 w-5 text-white" />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.button>

      {/* Tooltip */}
      <AnimatePresence>
        {showTooltip && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="absolute bottom-full start-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-medium whitespace-nowrap shadow-lg"
          >
            {tooltipText}
            <div className="absolute top-full start-1/2 -translate-x-1/2 -mt-px">
              <div className="h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-gray-900 dark:border-t-gray-100" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
