'use client';

import { motion } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { AlertTriangle, RefreshCw, LogIn, ShieldX } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** If true, shows a "session expired" message with login redirect */
  isAuthError?: boolean;
  /** Called when user clicks "Go to Login" on auth error */
  onLogin?: () => void;
}

/**
 * Reusable error state component with retry button.
 * Shown when data fetching fails, allowing the user to try again.
 * Supports auth errors with a dedicated "Go to Login" action.
 */
export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel,
  isAuthError,
  onLogin,
}: ErrorStateProps) {
  const { t } = useLanguage();

  const displayTitle = title || (isAuthError ? t('sessionExpired') : t('errorLoadingData'));
  const displayDescription = description || (isAuthError
    ? t('sessionExpiredDescription')
    : t('errorLoadingData'));
  const displayRetryLabel = retryLabel || t('tryAgain');

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center py-12 px-4 text-center"
    >
      {/* Error icon */}
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
        className={`h-20 w-20 rounded-3xl flex items-center justify-center mb-6 shadow-inner ${
          isAuthError
            ? 'bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-900/30 dark:to-amber-900/10'
            : 'bg-gradient-to-br from-rose-100 to-rose-50 dark:from-rose-900/30 dark:to-rose-900/10'
        }`}
      >
        {isAuthError ? (
          <ShieldX className="h-10 w-10 text-amber-500 dark:text-amber-400" />
        ) : (
          <AlertTriangle className="h-10 w-10 text-rose-500 dark:text-rose-400" />
        )}
      </motion.div>

      {/* Title */}
      <motion.h3
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="text-lg font-bold text-foreground mb-2"
      >
        {displayTitle}
      </motion.h3>

      {/* Description */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-muted-foreground max-w-sm mb-6 text-sm leading-relaxed"
      >
        {displayDescription}
      </motion.p>

      {/* Action buttons */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
        className="flex gap-3"
      >
        {isAuthError && onLogin && (
          <Button
            onClick={onLogin}
            className="min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg hover:shadow-xl transition-all gap-2"
          >
            <LogIn className="h-4 w-4" />
            {t('login') || 'تسجيل الدخول'}
          </Button>
        )}
        {onRetry && (
          <Button
            onClick={onRetry}
            variant={isAuthError ? 'outline' : 'default'}
            className={`min-h-[44px] px-6 rounded-2xl font-semibold transition-all gap-2 ${
              isAuthError
                ? 'border-border hover:bg-muted'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white shadow-lg hover:shadow-xl'
            }`}
          >
            <RefreshCw className="h-4 w-4" />
            {displayRetryLabel}
          </Button>
        )}
      </motion.div>
    </motion.div>
  );
}
