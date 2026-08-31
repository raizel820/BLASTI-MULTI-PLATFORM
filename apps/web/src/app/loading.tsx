import { BlastiSkeleton } from '@/components/shared/blasti-skeleton';

/**
 * Route-level loading state for the root page.
 * Next.js displays this automatically during navigation/routing transitions.
 */
export default function Loading() {
  return <BlastiSkeleton />;
}
