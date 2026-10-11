'use client';

import { motion } from 'framer-motion';
import { Skeleton } from '@/components/ui/skeleton';

interface LoadingStateProps {
  rows?: number;
  type?: 'card' | 'list' | 'table' | 'dashboard';
}

/**
 * Reusable loading skeleton component with animated shimmer placeholders.
 * Renders different layouts based on the type prop:
 * - Card: rectangular cards with shimmer
 * - List: horizontal rows with shimmer
 * - Table: header + rows with shimmer
 * - Dashboard: stat cards + chart placeholder
 */
export function LoadingState({ rows = 3, type = 'card' }: LoadingStateProps) {
  const shimmerClass = 'skeleton-shimmer';

  if (type === 'dashboard') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="p-4 lg:p-5 space-y-4"
      >
        {/* Title skeleton */}
        <div className="flex items-center justify-between">
          <Skeleton className={`h-7 w-40 rounded-lg ${shimmerClass}`} />
          <div className="flex gap-2">
            <Skeleton className={`h-8 w-20 rounded-lg ${shimmerClass}`} />
            <Skeleton className={`h-8 w-8 rounded-lg ${shimmerClass}`} />
          </div>
        </div>

        {/* Quick actions row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className={`h-14 rounded-2xl ${shimmerClass}`} />
          ))}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className={`h-28 rounded-xl ${shimmerClass}`} />
          ))}
        </div>

        {/* Now serving card */}
        <Skeleton className={`h-40 rounded-2xl ${shimmerClass}`} />

        {/* Waiting list + chart */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Skeleton className={`h-48 rounded-2xl ${shimmerClass}`} />
          <Skeleton className={`h-48 rounded-2xl ${shimmerClass}`} />
        </div>
      </motion.div>
    );
  }

  if (type === 'table') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        {/* Table header */}
        <div className="flex gap-4 px-4 py-2">
          <Skeleton className={`h-4 w-8 rounded ${shimmerClass}`} />
          <Skeleton className={`h-4 flex-1 rounded ${shimmerClass}`} />
          <Skeleton className={`h-4 w-24 rounded ${shimmerClass}`} />
          <Skeleton className={`h-4 w-20 rounded ${shimmerClass}`} />
          <Skeleton className={`h-4 w-16 rounded ${shimmerClass}`} />
        </div>
        {/* Table rows */}
        {[...Array(rows)].map((_, i) => (
          <div key={i} className="flex gap-4 px-4 py-3 rounded-lg">
            <Skeleton className={`h-4 w-8 rounded ${shimmerClass}`} />
            <Skeleton className={`h-4 flex-1 rounded ${shimmerClass}`} />
            <Skeleton className={`h-4 w-24 rounded ${shimmerClass}`} />
            <Skeleton className={`h-4 w-20 rounded ${shimmerClass}`} />
            <Skeleton className={`h-4 w-16 rounded ${shimmerClass}`} />
          </div>
        ))}
      </motion.div>
    );
  }

  if (type === 'list') {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="space-y-3"
      >
        {[...Array(rows)].map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-3 rounded-xl">
            <Skeleton className={`h-10 w-10 rounded-xl shrink-0 ${shimmerClass}`} />
            <div className="flex-1 space-y-2">
              <Skeleton className={`h-4 w-3/5 rounded ${shimmerClass}`} />
              <Skeleton className={`h-3 w-4/5 rounded ${shimmerClass}`} />
            </div>
            <Skeleton className={`h-8 w-20 rounded-lg shrink-0 ${shimmerClass}`} />
          </div>
        ))}
      </motion.div>
    );
  }

  // Default: card type
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-3"
    >
      {[...Array(rows)].map((_, i) => (
        <div key={i} className="rounded-2xl overflow-hidden border border-border/50">
          <div className="p-4 space-y-3">
            <div className="flex items-start gap-3">
              <Skeleton className={`h-11 w-11 rounded-xl shrink-0 ${shimmerClass}`} />
              <div className="flex-1 space-y-2">
                <Skeleton className={`h-4 w-3/5 rounded ${shimmerClass}`} />
                <Skeleton className={`h-3 w-4/5 rounded ${shimmerClass}`} />
                <div className="flex gap-2">
                  <Skeleton className={`h-5 w-16 rounded-full ${shimmerClass}`} />
                  <Skeleton className={`h-5 w-20 rounded-full ${shimmerClass}`} />
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <Skeleton className={`h-8 w-28 rounded-lg ${shimmerClass}`} />
            </div>
          </div>
        </div>
      ))}
    </motion.div>
  );
}
