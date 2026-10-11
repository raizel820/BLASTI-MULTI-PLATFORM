'use client';

import { motion } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { type LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  /** The illustration/icon — can be a Lucide icon component, emoji, or custom JSX */
  icon?: React.ReactNode;
  /** LucideIcon component (alternative to icon — renders with default styling) */
  iconComponent?: LucideIcon;
  /** Title of the empty state — will be shown prominently */
  title: string;
  /** Description text - secondary information */
  description?: string;
  /** Label for the CTA button */
  actionLabel?: string;
  /** Handler for CTA button click */
  onAction?: () => void;
  /** Optional icon for the CTA button */
  actionIcon?: React.ReactNode;
  /** Optional secondary action label */
  secondaryActionLabel?: string;
  /** Optional secondary action handler */
  onSecondaryAction?: () => void;
  /** Optional secondary action icon */
  secondaryActionIcon?: React.ReactNode;
}

/**
 * Reusable empty state component with consistent styling.
 * Shows a friendly illustration, clear message, and optional CTA buttons.
 * Uses the emerald/teal brand color scheme.
 *
 * Supports two icon patterns:
 * - `icon`: any React.ReactNode (emoji, custom JSX, etc.)
 * - `iconComponent`: a LucideIcon component, rendered with default emerald styling
 */
export function EmptyState({
  icon,
  iconComponent: IconComponent,
  title,
  description,
  actionLabel,
  onAction,
  actionIcon,
  secondaryActionLabel,
  onSecondaryAction,
  secondaryActionIcon,
}: EmptyStateProps) {
  const { t } = useLanguage();

  // Determine the icon to render
  const iconContent = icon ? icon : IconComponent ? (
    <IconComponent className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
  ) : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="flex flex-col items-center justify-center py-12 px-4 text-center"
    >
      {/* Icon / Illustration area */}
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
        className="relative mb-6"
      >
        {/* Pulsing background ring */}
        <motion.div
          animate={{ scale: [1, 1.15, 1], opacity: [0.12, 0.04, 0.12] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-28 w-28 rounded-full bg-emerald-200 dark:bg-emerald-800"
        />
        {/* Decorative dashed circle */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
          className="absolute top-1/2 start-1/2 -translate-x-1/2 -translate-y-1/2 h-24 w-24 rounded-full border-2 border-dashed border-emerald-200/60 dark:border-emerald-700/40"
        />
        <div className="relative h-20 w-20 rounded-3xl bg-gradient-to-br from-emerald-100 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/20 flex items-center justify-center shadow-inner">
          {iconContent}
        </div>
      </motion.div>

      {/* Title */}
      <motion.h3
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="text-lg font-bold text-foreground mb-2"
      >
        {title}
      </motion.h3>

      {/* Description */}
      {description && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-muted-foreground max-w-sm mb-6 text-sm leading-relaxed"
        >
          {description}
        </motion.p>
      )}

      {/* CTA Buttons */}
      {(actionLabel || secondaryActionLabel) && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="flex flex-col sm:flex-row items-center gap-3"
        >
          {actionLabel && onAction && (
            <Button
              onClick={onAction}
              className="min-h-[44px] px-6 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold shadow-lg hover:shadow-xl transition-all gap-2"
            >
              {actionIcon}
              {actionLabel}
            </Button>
          )}
          {secondaryActionLabel && onSecondaryAction && (
            <Button
              variant="outline"
              onClick={onSecondaryAction}
              className="min-h-[44px] px-6 rounded-2xl border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 gap-2"
            >
              {secondaryActionIcon}
              {secondaryActionLabel}
            </Button>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
