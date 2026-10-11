'use client';

/**
 * useAgencyCategories — shared source of truth for agency category selection.
 *
 * Built-ins: the 25 hardcoded keys from lib/enums.ts exposed as
 * BUILT_IN_CATEGORY_OPTIONS ({ value, labelKey, icon }) — value is what is
 * stored in Agency.category (e.g. 'CLINIC'), labelKey is the i18n key
 * (e.g. 'catClinic') translated by the consumer.
 *
 * Custom: user-created rows from GET/POST /api/agency-categories (the synced
 * AgencyCategory model). They are referenced by their unique `name` —
 * Agency.category stores the name as entered, and every consumer displays it
 * as-is (user-entered content, no i18n key).
 *
 * The custom list is fetched ONCE per app session through a module-level
 * singleton (dedup + cache) shared by every mounted consumer (creation
 * wizard, profile settings, customer home filters) so a category created in
 * one place is instantly visible in the others.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from '@/lib/api-fetch';

// ─── Types ────────────────────────────────────────────────────────────

export interface BuiltInCategoryOption {
  /** Value persisted in Agency.category (e.g. 'CLINIC'). */
  value: string;
  /** i18n key translated with t(labelKey) by the consumer. */
  labelKey: string;
  /** Emoji shown on the picker card / next to the label. */
  icon: string;
}

/** Row shape of GET/POST /api/agency-categories (synced AgencyCategory). */
export interface AgencyCategoryRow {
  id: string;
  name: string;
  nameFr?: string | null;
  nameAr?: string | null;
  icon?: string | null;
  isCustom: boolean;
  createdBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Typed error flags surfaced by createCategory so the UI shows the right message. */
export type CreateCategoryError = 'INVALID_NAME' | 'CATEGORY_EXISTS' | 'FETCH_FAILED';

export type CreateCategoryResult =
  | { ok: true; category: AgencyCategoryRow }
  | { ok: false; error: CreateCategoryError };

// ─── The 25 built-in options (single shared list) ─────────────────────

export const BUILT_IN_CATEGORY_OPTIONS: BuiltInCategoryOption[] = [
  { value: 'CLINIC', labelKey: 'catClinic', icon: '🏥' },
  { value: 'HOSPITAL', labelKey: 'catHospital', icon: '🏥' },
  { value: 'DENTAL_CLINIC', labelKey: 'catDentalClinic', icon: '🦷' },
  { value: 'LABORATORY', labelKey: 'catLaboratory', icon: '🔬' },
  { value: 'PHARMACY', labelKey: 'catPharmacy', icon: '💊' },
  { value: 'VETERINARY', labelKey: 'catVeterinary', icon: '🐾' },
  { value: 'BANK', labelKey: 'catBank', icon: '🏦' },
  { value: 'POST_OFFICE', labelKey: 'catPostOffice', icon: '📮' },
  { value: 'TELECOM', labelKey: 'catTelecom', icon: '📱' },
  { value: 'INSURANCE', labelKey: 'catInsurance', icon: '🛡️' },
  { value: 'LAW_FIRM', labelKey: 'catLawFirm', icon: '⚖️' },
  { value: 'NOTARY', labelKey: 'catNotary', icon: '📜' },
  { value: 'GOVERNMENT', labelKey: 'catGovernment', icon: '🏛️' },
  { value: 'EDUCATION', labelKey: 'catEducation', icon: '🎓' },
  { value: 'AGENCY', labelKey: 'catAgency', icon: '🏢' },
  { value: 'TRAVEL', labelKey: 'catTravel', icon: '✈️' },
  { value: 'REAL_ESTATE', labelKey: 'catRealEstate', icon: '🏠' },
  { value: 'CAR_SERVICE', labelKey: 'catCarService', icon: '🚗' },
  { value: 'BARBER', labelKey: 'catBarber', icon: '💈' },
  { value: 'BEAUTY_SALON', labelKey: 'catBeautySalon', icon: '💅' },
  { value: 'RESTAURANT', labelKey: 'catRestaurant', icon: '🍽️' },
  { value: 'CAFE', labelKey: 'catCafe', icon: '☕' },
  { value: 'RETAIL', labelKey: 'catRetail', icon: '🛍️' },
  { value: 'HOTEL', labelKey: 'catHotel', icon: '🏨' },
  { value: 'OTHER', labelKey: 'catOther', icon: '📋' },
];

// ─── Module-level shared store (one fetch for the whole app) ──────────

interface CategoryStoreState {
  rows: AgencyCategoryRow[] | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: CategoryStoreState = { rows: null, loading: false, error: null };

let state: CategoryStoreState = INITIAL_STATE;
let inflight: Promise<AgencyCategoryRow[]> | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<CategoryStoreState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CategoryStoreState {
  return state;
}

// SSR/hydration snapshot — never fetches on the server.
function getServerSnapshot(): CategoryStoreState {
  return INITIAL_STATE;
}

function normalizeRow(raw: unknown): AgencyCategoryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  return {
    id: typeof r.id === 'string' ? r.id : String(r.id ?? r.name),
    name: r.name,
    nameFr: typeof r.nameFr === 'string' ? r.nameFr : null,
    nameAr: typeof r.nameAr === 'string' ? r.nameAr : null,
    icon: typeof r.icon === 'string' ? r.icon : null,
    isCustom: r.isCustom !== false,
    createdBy: typeof r.createdBy === 'string' ? r.createdBy : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : undefined,
  };
}

/**
 * Fetches the custom categories once per session. Concurrent callers share
 * the same in-flight promise; a resolved snapshot short-circuits subsequent
 * calls. `force` re-fetches (used by refresh()).
 */
export function fetchAgencyCategoriesOnce(force = false): Promise<AgencyCategoryRow[]> {
  if (!force && state.rows) return Promise.resolve(state.rows);
  if (!force && inflight) return inflight;

  setState({ loading: true, error: null });
  const promise: Promise<AgencyCategoryRow[]> = (async () => {
    try {
      // apiFetch gives the call the standard cloud→LAN failover (web + desktop).
      const res = await apiFetch('/api/agency-categories');
      const payload = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) throw new Error('FETCH_FAILED');
      // apiClient's parseResponse AUTO-UNWRAPS `{ success, data }` envelopes
      // (Task 45 precedent) — accept BOTH the raw envelope and the unwrapped
      // array so the hook never depends on the unwrap heuristic.
      const list = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { data?: unknown })?.data)
          ? ((payload as { data: unknown[] }).data)
          : [];
      const rows = list
        .map(normalizeRow)
        .filter((r): r is AgencyCategoryRow => r !== null);
      setState({ rows, loading: false, error: null });
      return rows;
    } catch {
      setState({ loading: false, error: 'FETCH_FAILED' });
      throw new Error('FETCH_FAILED');
    }
  })();
  inflight = promise;
  // Clear the singleton once settled so failures can be retried and the next
  // force refresh isn't blocked by a stale promise.
  void promise
    .finally(() => {
      if (inflight === promise) inflight = null;
    })
    .catch(() => {
      /* rejection already surfaced to callers + the store's `error` flag */
    });
  return promise;
}

// ─── Hook ─────────────────────────────────────────────────────────────

export interface UseAgencyCategoriesResult {
  /** Custom (user-created) categories; empty array until fetched. */
  customCategories: AgencyCategoryRow[];
  /** True while the (first) fetch is in flight and nothing is cached yet. */
  loading: boolean;
  /** 'FETCH_FAILED' when the initial fetch failed (offline, 401, …). */
  error: string | null;
  /**
   * POSTs a new custom category. On success the row is appended to the
   * shared cache and returned. Typed errors: 'CATEGORY_EXISTS',
   * 'INVALID_NAME', 'FETCH_FAILED'.
   */
  createCategory: (
    name: string,
    extras?: { nameFr?: string; nameAr?: string; icon?: string },
  ) => Promise<CreateCategoryResult>;
  /** Re-fetches the custom categories (bypasses the cache). */
  refresh: () => void;
}

export function useAgencyCategories(): UseAgencyCategoriesResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Kick off the one-time fetch on first mount of any consumer.
  useEffect(() => {
    fetchAgencyCategoriesOnce().catch(() => {
      /* surfaced through `error`; consumers render gracefully without customs */
    });
  }, []);

  const createCategory = useCallback(
    async (
      name: string,
      extras?: { nameFr?: string; nameAr?: string; icon?: string },
    ): Promise<CreateCategoryResult> => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length < 2) return { ok: false, error: 'INVALID_NAME' };

      try {
        const res = await apiFetch('/api/agency-categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: trimmed,
            ...(extras?.nameFr ? { nameFr: extras.nameFr.trim() } : {}),
            ...(extras?.nameAr ? { nameAr: extras.nameAr.trim() } : {}),
            ...(extras?.icon ? { icon: extras.icon } : {}),
          }),
        });
        // apiClient may auto-unwrap `{ success, data }` → accept both shapes
        // (unwrapped row OR envelope). Error envelopes `{ success, error }`
        // (no `data` key) always pass through untouched.
        const payload = (await res.json().catch(() => null)) as
          | { success?: boolean; data?: unknown; error?: string }
          | null;

        const rawRow =
          payload && typeof payload === 'object' && 'data' in payload
            ? (payload as { data?: unknown }).data
            : payload;

        if (res.ok && rawRow) {
          const row = normalizeRow(rawRow);
          if (!row) return { ok: false, error: 'FETCH_FAILED' };
          const current = state.rows ?? [];
          // De-dup defensively (server is authoritative on unique names).
          const exists = current.some(
            (r) => r.name.toLowerCase() === row.name.toLowerCase(),
          );
          setState({
            rows: exists ? current : [...current, row],
            error: null,
          });
          return { ok: true, category: row };
        }

        const code = payload?.error;
        if (res.status === 409 || code === 'CATEGORY_EXISTS') {
          return { ok: false, error: 'CATEGORY_EXISTS' };
        }
        if (res.status === 400 || code === 'INVALID_NAME') {
          return { ok: false, error: 'INVALID_NAME' };
        }
        return { ok: false, error: 'FETCH_FAILED' };
      } catch {
        return { ok: false, error: 'FETCH_FAILED' };
      }
    },
    [],
  );

  const refresh = useCallback(() => {
    fetchAgencyCategoriesOnce(true).catch(() => {
      /* keep previous rows; error flag updated by the store */
    });
  }, []);

  return {
    customCategories: snapshot.rows ?? [],
    loading: snapshot.loading && snapshot.rows === null,
    error: snapshot.error,
    createCategory,
    refresh,
  };
}
