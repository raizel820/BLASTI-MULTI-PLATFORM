'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * Subscription gating helper (Task 31, bug 5) — the client-side single source
 * of truth for "can this agency use paid/queue features?".
 *
 * Keyed on subscriptionStatus ONLY — never on plan/tier (a FREE plan with an
 * ACTIVE status is fully functional). TRIAL counts as active, mirroring the
 * server-side gates in apps/api/src/routes/agency.ts (hasActiveSubscription)
 * and queue.ts.
 *
 * undefined/null → true so pre-fetch/unknown never falsely locks the UI —
 * the server still enforces the real 403 gate.
 */
export function isSubscriptionActive(status?: string | null): boolean {
  if (status === undefined || status === null) return true;
  return status === 'ACTIVE' || status === 'TRIAL';
}

/** Shape of GET /api/agency/subscription (only the fields we consume). */
interface SubscriptionResponse {
  status?: string;
  currentPlan?: string;
}

export interface UseSubscriptionActiveResult {
  /** Raw subscriptionStatus as reported by the API (null until it arrives). */
  status: string | null;
  /** True (unlocked) until a concrete non-active status arrives. */
  isActive: boolean;
  loading: boolean;
}

/**
 * Fetches GET /api/agency/subscription and exposes the effective status.
 *
 * Offline-first contract: `isActive` defaults to true and stays true when the
 * fetch fails or returns a non-2xx status (apiClient throws on those — caught
 * below) — a transient outage must never lock the queue UI. The server still
 * enforces the authoritative gate.
 */
export function useSubscriptionActive(agencyId?: string | null): UseSubscriptionActiveResult {
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<SubscriptionResponse>('/api/agency/subscription', {
        params: agencyId ? { agencyId } : undefined,
        retries: 1,
        timeout: 8000,
      });
      const next = typeof res.data?.status === 'string' ? res.data.status : null;
      if (next) setStatus(next);
      // Non-2xx throws ApiClientError → keep the previous status (null =
      // unlocked); the server still enforces the authoritative gate.
    } catch {
      // Transport failure → offline-first: never lock on errors.
    } finally {
      setLoading(false);
    }
  }, [agencyId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return { status, isActive: isSubscriptionActive(status), loading };
}
