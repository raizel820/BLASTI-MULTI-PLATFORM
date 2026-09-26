'use client';

// ─── Task 4: super-admin analytics data hook ────────────────────────────────
//
// Owns { period, scope, selectedAgency } state + the fetch/retry lifecycle:
//   • selectedAgency set → GET /api/admin/analytics/agency/:agencyId?period=…
//   • otherwise          → GET /api/admin/analytics/dashboard?period=…&scope=…
//
// Defensive patterns copied from use-analytics-data.ts (Task 42-e):
//   • request-sequence guard — a stale response never overwrites a newer one
//     (rapid period/scope/agency switching, refresh while in flight);
//   • 404 → 'unavailable' ("update required" state: the connected server does
//     not expose the admin analytics endpoints yet — the backend ships in
//     parallel, so this state is expected until it lands);
//   • accepts BOTH the raw { success, data } envelope AND the apiClient
//     auto-unwrapped payload (Task 45 precedent);
//   • 'error' with retry, and 'empty' when the platform has neither
//     reservations in the period nor any agencies/customers to show.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import type { AnalyticsPeriod } from '@/components/agency/analytics/types';
import type {
  AdminAnalyticsPayload,
  AdminAnalyticsScope,
  AdminSelectedAgency,
} from './types';

export type AdminAnalyticsLoadState = 'loading' | 'ready' | 'error' | 'unavailable' | 'empty';

/**
 * The apiClient inside apiFetch auto-unwraps `{ success, data }` envelopes
 * (bodies with a `data` key and ≤3 total keys) — accept BOTH the unwrapped
 * payload and the raw envelope defensively so the section survives a change
 * in that heuristic.
 */
function extractPayload(body: unknown): AdminAnalyticsPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.kpis) return body as AdminAnalyticsPayload;
  const inner = b.data;
  if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).kpis) {
    return inner as AdminAnalyticsPayload;
  }
  return null;
}

/** True when the payload carries anything worth rendering (reservation
 * activity, agencies or customers — a platform with agencies but a quiet
 * period still shows the dashboard with zeroed KPIs). */
function hasAnyData(data: AdminAnalyticsPayload): boolean {
  if ((data.kpis?.total ?? 0) > 0) return true;
  if ((data.timeseries?.length ?? 0) > 0) return true;
  if (data.statusDistribution?.some((s) => s.count > 0)) return true;
  if (!('platform' in data) || !data.platform) {
    // Per-agency payload — empty when the agency had no reservations at all.
    return false;
  }
  return (
    (data.platform.totalAgencies ?? 0) > 0 ||
    (data.platform.totalCustomers ?? 0) > 0 ||
    (data.platform.totalReservationsAllTime ?? 0) > 0
  );
}

export function useAdminAnalyticsData() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');
  const [scope, setScope] = useState<AdminAnalyticsScope>('global');
  const [selectedAgency, setSelectedAgency] = useState<AdminSelectedAgency | null>(null);
  const [data, setData] = useState<AdminAnalyticsPayload | null>(null);
  const [state, setState] = useState<AdminAnalyticsLoadState>('loading');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  // Guards against a stale response overwriting a newer one.
  const requestSeqRef = useRef(0);

  const selectedAgencyId = selectedAgency?.id ?? null;

  const load = useCallback(
    async (p: AnalyticsPeriod, s: AdminAnalyticsScope, agencyId: string | null) => {
      const seq = ++requestSeqRef.current;
      setState('loading');
      try {
        const path = agencyId
          ? `/api/admin/analytics/agency/${encodeURIComponent(agencyId)}?period=${p}`
          : `/api/admin/analytics/dashboard?period=${p}&scope=${s}`;
        const res = await apiFetch(path, { method: 'GET' });
        if (seq !== requestSeqRef.current) return; // superseded by a newer request
        if (res.status === 404) {
          // Connected server does not provide the admin analytics endpoints yet.
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
    },
    [],
  );

  useEffect(() => {
    load(period, scope, selectedAgencyId);
  }, [period, scope, selectedAgencyId, load]);

  const refresh = useCallback(
    () => load(period, scope, selectedAgencyId),
    [load, period, scope, selectedAgencyId],
  );

  const selectAgency = useCallback((agency: AdminSelectedAgency) => {
    setSelectedAgency(agency);
  }, []);

  const clearAgency = useCallback(() => {
    setSelectedAgency(null);
  }, []);

  return {
    period,
    setPeriod,
    scope,
    setScope,
    selectedAgency,
    selectAgency,
    clearAgency,
    data,
    state,
    lastUpdatedAt,
    refresh,
  };
}
