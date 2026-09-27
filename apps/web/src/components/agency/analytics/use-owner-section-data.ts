'use client';

// ─── Task 54-c: parameterized agency OWNER analytics section hook ───────────
//
// ONE hook for all 9 new sections (GET /api/agency/analytics/<section>),
// modeled on use-admin-section-data.ts (Task 54-b) with the SAME defensive
// patterns:
//   • request-sequence guard — a stale response never overwrites a newer one
//     (rapid period/tab/filter switching, refresh while in flight);
//   • 404 → 'unavailable' ("update required": the connected server — e.g. an
//     older local desktop build — does not expose the 54-a section endpoints);
//   • accepts BOTH the raw { success, data } envelope AND the apiClient
//     auto-unwrapped payload (Task 45 precedent);
//   • 'error' with retry, 'idle' while a custom range is incomplete, and
//     'empty' when the section predicate says the agency has nothing to show
//     for the period (zeroed counters).
//
// Contract notes (agent-ctx/54-a-analytics-contract.md):
//   • Every owner query is locked to the caller's own agency SERVER-SIDE —
//     no agencyId parameter is ever sent (a foreign agencyId → 403 anyway).
//   • `period` accepts today|7d|30d|this-month|this-year|custom; `custom`
//     REQUIRES from+to (ISO date) else 400 — the hook refuses to fire until
//     both dates are set (state 'idle' + isQueryReady).
//   • Rate limit is 100 req/min/IP globally — callers change one section at a
//     time and the hook fires exactly one GET per query change.
//   • working-hours + payments are owner/admin-only server-side (staff 403);
//     the shell hides those tabs for non-owner viewers.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import type {
  OwnerResolvedWindow,
  OwnerSectionPayload,
} from './section-types';

export type OwnerSectionLoadState = 'loading' | 'ready' | 'error' | 'unavailable' | 'empty' | 'idle';

export interface OwnerSectionQuery {
  period: string;
  /** ISO date (YYYY-MM-DD) — required when period === 'custom'. */
  from?: string;
  /** ISO date (YYYY-MM-DD) — required when period === 'custom'. */
  to?: string;
  /** §3.2 org filters — entries with empty values are skipped. */
  filters?: Record<string, string>;
  /** Bump to force a refetch (shared toolbar refresh button). Not sent. */
  reloadToken?: number;
}

/**
 * The apiClient inside apiFetch auto-unwraps `{ success, data }` envelopes
 * (bodies with a `data` key and ≤3 total keys) — accept BOTH the unwrapped
 * payload and the raw envelope defensively so the section survives a change
 * in that heuristic.
 */
function extractPayload<T extends OwnerSectionPayload>(body: unknown): T | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.resolved) return body as T;
  const inner = b.data;
  if (inner && typeof inner === 'object' && (inner as Record<string, unknown>).resolved) {
    return inner as T;
  }
  return null;
}

export function useOwnerSectionData<T extends OwnerSectionPayload>(
  section: string,
  query: OwnerSectionQuery,
  options?: {
    /** Return true when the payload carries nothing worth rendering. */
    isEmpty?: (data: T) => boolean;
  },
) {
  const [data, setData] = useState<T | null>(null);
  const [resolved, setResolved] = useState<OwnerResolvedWindow | null>(null);
  const [state, setState] = useState<OwnerSectionLoadState>('loading');
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

  // Serialize the filters so buildPath (and thus the fetch effect) only
  // re-fires when the filter SET actually changes, not on every render.
  const filterEntries = Object.entries(query.filters ?? {}).filter(([, v]) => v && String(v).trim());
  const filterKey = filterEntries.map(([k, v]) => `${k}=${v}`).join('&');
  const { period, from, to, reloadToken } = query;
  const isCustom = period === 'custom';
  const isQueryReady = !isCustom || (Boolean(from) && Boolean(to));

  const buildPath = useCallback((): string => {
    const parts: string[] = [`period=${encodeURIComponent(period)}`];
    if (isCustom && from && to) {
      parts.push(`from=${encodeURIComponent(from)}`);
      parts.push(`to=${encodeURIComponent(to)}`);
    }
    filterKey
      .split('&')
      .filter(Boolean)
      .forEach((pair) => parts.push(encodeURIComponent(pair.split('=')[0]) + '=' + encodeURIComponent(pair.slice(pair.indexOf('=') + 1))));
    return `/api/agency/analytics/${section}?${parts.join('&')}`;
  }, [section, period, isCustom, from, to, filterKey, reloadToken]);

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
      if (!res.ok) {
        // 401/403/400/5xx — generic retryable failure panel (the shell hides
        // owner-only tabs from non-owner viewers; a 403 here is thus rare).
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
