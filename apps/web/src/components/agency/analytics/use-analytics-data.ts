'use client';

// ─── Task 42-e: analytics data hook ─────────────────────────────────────────
//
// Owns the period state + fetch/retry lifecycle for the Analytics section.
// GET /api/agency/analytics/dashboard?period=7d|30d|90d|12m — identical shape
// on cloud and desktop local API. Uses apiFetch (cloud → LAN failover works
// on both platforms for free).
//
// Failure states (the section renders a friendly panel for each — never a
// crash):
//   'unavailable' — HTTP 404: the endpoint does not exist on the connected
//                   server (older local desktop build). The UI shows an
//                   "update required" empty state.
//   'error'       — any other non-OK response / network failure / malformed
//                   payload. The UI shows a retry panel.
//   'empty'       — 200 but no reservations in the period at all.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import type { AnalyticsDashboardData, AnalyticsPeriod } from './types';

export type AnalyticsLoadState = 'loading' | 'ready' | 'error' | 'unavailable' | 'empty';

/**
 * The apiClient inside apiFetch auto-unwraps `{ success, data }` envelopes
 * (bodies with a `data` key and ≤3 total keys) — accept BOTH the unwrapped
 * payload and the raw envelope defensively so the section survives a change
 * in that heuristic (Task 45 precedent).
 */
function extractPayload(body: unknown): AnalyticsDashboardData | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.kpis) return body as AnalyticsDashboardData;
  const inner = b.data;
  if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).kpis) {
    return inner as AnalyticsDashboardData;
  }
  return null;
}

/** True when the payload carries at least one reservation worth showing. */
function hasAnyData(data: AnalyticsDashboardData): boolean {
  return (
    (data.kpis?.total ?? 0) > 0 ||
    (data.timeseries?.length ?? 0) > 0 ||
    (data.statusDistribution?.some((s) => s.count > 0) ?? false)
  );
}

export function useAnalyticsData() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');
  const [data, setData] = useState<AnalyticsDashboardData | null>(null);
  const [state, setState] = useState<AnalyticsLoadState>('loading');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  // Guards against a stale response overwriting a newer one (rapid period
  // switching / refresh while a request is in flight).
  const requestSeqRef = useRef(0);

  const load = useCallback(async (p: AnalyticsPeriod) => {
    const seq = ++requestSeqRef.current;
    setState('loading');
    try {
      const res = await apiFetch(`/api/agency/analytics/dashboard?period=${p}`, { method: 'GET' });
      if (seq !== requestSeqRef.current) return; // superseded by a newer request
      if (res.status === 404) {
        // Older local build without the analytics endpoint.
        setState('unavailable');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      const body: unknown = await res.json();
      if (seq !== requestSeqRef.current) return;
      const payload = extractPayload(body);
      if (!payload) {
        setState('error');
        return;
      }
      setData(payload);
      setLastUpdatedAt(new Date());
      setState(hasAnyData(payload) ? 'ready' : 'empty');
    } catch {
      // apiFetch resolves errors into !ok responses — this is a safety net.
      if (seq === requestSeqRef.current) setState('error');
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const refresh = useCallback(() => load(period), [load, period]);

  return { period, setPeriod, data, state, lastUpdatedAt, refresh };
}
