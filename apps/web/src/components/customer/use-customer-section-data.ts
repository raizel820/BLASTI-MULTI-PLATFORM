'use client';

// ─── Task 54-d: parameterized CUSTOMER analytics section hook ────────────────
//
// ONE hook for all 5 sections (GET /api/customer/analytics/<section>), adapted
// from use-owner-section-data.ts (Task 54-c) with the SAME defensive patterns:
//   • request-sequence guard — a stale response never overwrites a newer one;
//   • 404 → 'unavailable' ("update required": the connected server — e.g. an
//     older local desktop build — does not expose the 54-a section endpoints);
//   • 403 → 'forbidden' — the customer module is role-CUSTOMER only
//     (contract §4); sections render a friendly panel for that case;
//   • accepts BOTH the raw { success, data } envelope AND the apiClient
//     auto-unwrapped payload (Task 45 precedent);
//   • 'error' with retry, 'idle' while a custom range is incomplete, and
//     'empty' when the section predicate says there is nothing to show
//     (zeroed counters are zero-safe, never an error).
//
// Contract notes (agent-ctx/54-a-analytics-contract.md §4):
//   • Every query filters userId = caller SERVER-SIDE (§38 personal scope) —
//     no userId parameter is ever sent.
//   • `period` accepts today|7d|30d|this-month|12m|this-year|custom; `custom`
//     REQUIRES from+to (ISO date) else 400 — the hook refuses to fire until
//     both dates are set (state 'idle' + isQueryReady). Backend defaults:
//     my-overview + my-activity 30d, the rest 12m.
//   • Rate limit is 100 req/min/IP globally — callers change one section at a
//     time and the hook fires exactly one GET per query change.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import type { CustomerResolvedWindow, CustomerSectionPayload } from './customer-analytics-types';

export type CustomerSectionLoadState =
  | 'loading'
  | 'ready'
  | 'error'
  | 'unavailable'
  | 'forbidden'
  | 'empty'
  | 'idle';

export interface CustomerSectionQuery {
  period: string;
  /** ISO date (YYYY-MM-DD) — required when period === 'custom'. */
  from?: string;
  /** ISO date (YYYY-MM-DD) — required when period === 'custom'. */
  to?: string;
  /** Bump to force a refetch (shared toolbar refresh button). Not sent. */
  reloadToken?: number;
}

/**
 * The apiClient inside apiFetch auto-unwraps `{ success, data }` envelopes
 * (bodies with a `data` key and ≤3 total keys) — accept BOTH the unwrapped
 * payload and the raw envelope defensively so the section survives a change
 * in that heuristic.
 */
function extractPayload<T extends CustomerSectionPayload>(body: unknown): T | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.resolved) return body as T;
  const inner = b.data;
  if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).resolved) {
    return inner as T;
  }
  return null;
}

export function useCustomerSectionData<T extends CustomerSectionPayload>(
  section: string,
  query: CustomerSectionQuery,
  options?: {
    /** Return true when the payload carries nothing worth rendering. */
    isEmpty?: (data: T) => boolean;
  },
) {
  const [data, setData] = useState<T | null>(null);
  const [resolved, setResolved] = useState<CustomerResolvedWindow | null>(null);
  const [state, setState] = useState<CustomerSectionLoadState>('loading');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  // Guards against a stale response overwriting a newer one.
  const requestSeqRef = useRef(0);
  // The isEmpty predicate arrives as an inline arrow (new identity every
  // render) — keep it in a ref so it can NEVER retrigger the fetch effect
  // below. Written inside an effect (never during render) per the
  // react-hooks refs rule; the initial value covers the mount-time fetch.
  const isEmptyRef = useRef<((data: T) => boolean) | undefined>(options?.isEmpty);
  useEffect(() => {
    isEmptyRef.current = options?.isEmpty;
  });

  const { period, from, to, reloadToken } = query;
  const isCustom = period === 'custom';
  const isQueryReady = !isCustom || (Boolean(from) && Boolean(to));

  const buildPath = useCallback((): string => {
    const parts: string[] = [`period=${encodeURIComponent(period)}`];
    if (isCustom && from && to) {
      parts.push(`from=${encodeURIComponent(from)}`);
      parts.push(`to=${encodeURIComponent(to)}`);
    }
    return `/api/customer/analytics/${section}?${parts.join('&')}`;
    // reloadToken is intentionally in the deps: bumping it forces a rebuild
    // (and thus a refetch) even when period/dates are unchanged.
  }, [section, period, isCustom, from, to, reloadToken]);

  const load = useCallback(async () => {
    if (!isQueryReady) {
      // custom period without both dates — nothing to fetch yet.
      setState('idle');
      return;
    }
    const seq = ++requestSeqRef.current;
    setState('loading');
    try {
      const res = await apiFetch(buildPath(), { method: 'GET' });
      if (seq !== requestSeqRef.current) return; // superseded by a newer request
      if (res.status === 404) {
        // Older local build without the 54-a section endpoints.
        setState('unavailable');
        return;
      }
      if (res.status === 403) {
        // Non-customer session or revoked access — the module is personal.
        setState('forbidden');
        return;
      }
      if (!res.ok) {
        // 401/400/5xx — generic retryable failure panel.
        setState('error');
        return;
      }
      const body: unknown = await res.json();
      if (seq !== requestSeqRef.current) return;
      const payload = extractPayload<T>(body);
      if (!payload) {
        setState('error');
        return;
      }
      setData(payload);
      setResolved(payload.resolved ?? null);
      setLastUpdatedAt(new Date());
      const isEmptyNow = isEmptyRef.current;
      setState(isEmptyNow && isEmptyNow(payload) ? 'empty' : 'ready');
    } catch {
      // apiFetch resolves errors into !ok responses — this is a safety net.
      if (seq === requestSeqRef.current) setState('error');
    }
  }, [buildPath, isQueryReady]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  return { data, resolved, state, lastUpdatedAt, refresh, isQueryReady };
}
