'use client';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Branded BLASTI loading skeleton — shown during lazy-loading and hydration.
 *
 * Displays:
 *  - The BLASTI logo text with an emerald accent
 *  - A pulsing emerald gradient bar
 *  - A few skeleton placeholder lines
 *
 * This replaces the basic <Loader2> spinner for a more polished feel.
 */
export function BlastiSkeleton() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-6 px-4">
      {/* Logo text */}
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-3xl font-bold tracking-tight">
          <span className="bg-gradient-to-r from-emerald-600 to-emerald-400 bg-clip-text text-transparent">
            BLASTI
          </span>
        </h1>
        <p className="text-sm text-muted-foreground">بلاصتي</p>
      </div>

      {/* Pulsing emerald gradient bar */}
      <div className="w-48 h-1.5 rounded-full overflow-hidden bg-muted">
        <div className="h-full w-full rounded-full bg-gradient-to-r from-emerald-500 via-emerald-300 to-emerald-500 animate-pulse origin-center" />
      </div>

      {/* Skeleton placeholder lines */}
      <div className="w-full max-w-xs space-y-3">
        <Skeleton className="h-4 w-3/4 mx-auto rounded" />
        <Skeleton className="h-3 w-1/2 mx-auto rounded" />
        <Skeleton className="h-3 w-2/3 mx-auto rounded" />
      </div>
    </div>
  );
}

/**
 * Compact variant for inline Suspense fallbacks (e.g. inside cards/panels).
 */
export function BlastiSkeletonCompact() {
  return (
    <div className="flex items-center justify-center py-8 gap-3">
      <div className="h-2 w-2 rounded-full bg-emerald-500 animate-bounce [animation-delay:0ms]" />
      <div className="h-2 w-2 rounded-full bg-emerald-400 animate-bounce [animation-delay:150ms]" />
      <div className="h-2 w-2 rounded-full bg-emerald-300 animate-bounce [animation-delay:300ms]" />
    </div>
  );
}
