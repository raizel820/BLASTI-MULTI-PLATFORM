'use client';

/**
 * useCategoryTermScope — Agencies Management, per-category terminology scope.
 *
 * Activates a category's terminology overrides (Task: per-category words like
 * "Patient" instead of "Customer") for the CURRENT component tree: every
 * t()/translate() call resolves activeCategoryTerms[key] BEFORE the static
 * dictionaries (see i18n/index.ts), so existing components pick up the
 * category vocabulary with zero text changes.
 *
 * Contract:
 *   - falsy slug      → terms are cleared (setActiveCategoryTerms(null)).
 *   - set slug        → GET /api/agency-categories/terms?category=<slug>
 *                       (module-level memo cache keyed by slug, so remounts
 *                       do NOT refetch) → activate the map.
 *   - unmount / slug→null → clear, but ONLY if this scope is still the
 *                       active one (module-level current-scope token — the
 *                       LAST mounted scope wins; a background scope's
 *                       unmount must never kill the foreground scope).
 *
 * FAILURE POLICY (same as the rest of the customer app): a failed terms
 * fetch degrades SILENTLY — the page keeps the standard dictionary words.
 * It must NEVER break the page, never toast, never set error UI.
 *
 * Also exports fetchCategoriesWithSpecialties() — the module-cached
 * GET /api/agency-categories fetch WITH the specialties arrays (the shared
 * use-agency-categories hook normalizes them away) — plus a tiny
 * localizeSpecialtyName() helper. Consumers: customer search specialty rail,
 * customer profile specialty chips, owner profile specialty picker.
 */

import { useEffect, useRef, useState } from 'react';
import { setActiveCategoryTerms } from '@/i18n';
import { fetchWithRetry } from '@/lib/fetch-with-retry';
import type { Language } from '@/i18n';

// ─── Types ─────────────────────────────────────────────────────────────

type TermTriple = { ar: string; en: string; fr: string };

export interface AgencySpecialty {
  id: string;
  nameEn: string;
  nameAr?: string | null;
  nameFr?: string | null;
  isActive?: boolean;
}

export interface AgencyCategoryWithSpecialties {
  id: string;
  slug: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  icon?: string | null;
  isActive?: boolean;
  sortOrder?: number;
  specialties: AgencySpecialty[];
}

// ─── Module-level memo caches (survive remounts, shared per session) ───

const termsCache = new Map<string, Record<string, TermTriple>>();
const termsInflight = new Map<string, Promise<Record<string, TermTriple> | null>>();

/**
 * Loads (and caches) one category's term map. Resolves null on ANY failure —
 * callers treat null as "no overrides", never as an error.
 */
function loadCategoryTerms(slug: string): Promise<Record<string, TermTriple> | null> {
  const cached = termsCache.get(slug);
  if (cached) return Promise.resolve(cached);
  const inflight = termsInflight.get(slug);
  if (inflight) return inflight;

  const promise: Promise<Record<string, TermTriple> | null> = (async () => {
    try {
      const res = await fetchWithRetry(
        `/api/agency-categories/terms?category=${encodeURIComponent(slug)}`,
      );
      if (!res.ok) return null;
      const payload = (await res.json().catch(() => null)) as unknown;
      // apiClient's parseResponse auto-unwraps `{ success, data }` envelopes
      // (Task 45 precedent) — accept BOTH the raw envelope and the unwrapped
      // object so the hook never depends on the unwrap heuristic.
      const data =
        payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)
          ? (payload as { data?: unknown }).data
          : payload;
      const terms = Array.isArray((data as { terms?: unknown })?.terms)
        ? ((data as { terms: unknown[] }).terms)
        : [];
      const map: Record<string, TermTriple> = {};
      for (const raw of terms) {
        if (!raw || typeof raw !== 'object') continue;
        const term = raw as Record<string, unknown>;
        if (typeof term.key !== 'string' || !term.key) continue;
        map[term.key] = {
          ar: typeof term.valueAr === 'string' ? term.valueAr : '',
          en: typeof term.valueEn === 'string' ? term.valueEn : '',
          fr: typeof term.valueFr === 'string' ? term.valueFr : '',
        };
      }
      termsCache.set(slug, map);
      return map;
    } catch {
      // Silent-degrade: standard dictionary words stay active.
      return null;
    }
  })();

  termsInflight.set(slug, promise);
  void promise
    .finally(() => {
      if (termsInflight.get(slug) === promise) termsInflight.delete(slug);
    })
    .catch(() => {
      /* rejection already handled — the hook never throws */
    });
  return promise;
}

// ─── The scope hook ────────────────────────────────────────────────────

let scopeSeq = 0;
/** Token of the scope that most recently took over (LAST mounted wins). */
let activeScopeId = 0;

export function useCategoryTermScope(categorySlug: string | null | undefined): void {
  const slug = categorySlug ?? '';
  // Bumped whenever the active terms change, so the consuming component (and
  // its whole tree) re-renders and every t() call re-evaluates the overrides.
  const [, setTermsVersion] = useState(0);
  const scopeRef = useRef(0);

  useEffect(() => {
    const scopeId = ++scopeSeq;
    scopeRef.current = scopeId;
    activeScopeId = scopeId;

    if (!slug) {
      // No category known yet → make sure no stale overrides leak through.
      setActiveCategoryTerms(null);
      return;
    }

    let cancelled = false;
    void loadCategoryTerms(slug).then((map) => {
      // Apply only if this scope still owns the token (slug changed again,
      // unmounted, or a later scope took over while the fetch was in flight).
      if (!cancelled && scopeRef.current === scopeId && activeScopeId === scopeId && map) {
        setActiveCategoryTerms(map);
        setTermsVersion((v) => v + 1);
      }
    });

    return () => {
      cancelled = true;
      if (activeScopeId === scopeId) {
        activeScopeId = 0;
        setActiveCategoryTerms(null);
      }
    };
  }, [slug]);
}

// ─── Categories WITH specialties (module-cached, one fetch per session) ─

let categoriesCache: AgencyCategoryWithSpecialties[] | null = null;
let categoriesInflight: Promise<AgencyCategoryWithSpecialties[]> | null = null;

function normalizeCategoryRow(raw: unknown): AgencyCategoryWithSpecialties | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.slug !== 'string' || !r.slug) return null;
  const rawSpecialties = Array.isArray(r.specialties) ? r.specialties : [];
  const specialties = rawSpecialties
    .map((s: unknown): AgencySpecialty | null => {
      if (!s || typeof s !== 'object') return null;
      const spec = s as Record<string, unknown>;
      if (typeof spec.id !== 'string' || typeof spec.nameEn !== 'string') return null;
      return {
        id: spec.id,
        nameEn: spec.nameEn,
        nameAr: typeof spec.nameAr === 'string' ? spec.nameAr : null,
        nameFr: typeof spec.nameFr === 'string' ? spec.nameFr : null,
        isActive: spec.isActive !== false,
      };
    })
    .filter((s): s is AgencySpecialty => s !== null);
  return {
    id: typeof r.id === 'string' ? r.id : r.slug,
    slug: r.slug,
    name: typeof r.name === 'string' ? r.name : r.slug,
    nameAr: typeof r.nameAr === 'string' ? r.nameAr : null,
    nameFr: typeof r.nameFr === 'string' ? r.nameFr : null,
    icon: typeof r.icon === 'string' ? r.icon : null,
    isActive: r.isActive !== false,
    sortOrder: typeof r.sortOrder === 'number' ? r.sortOrder : 0,
    specialties,
  };
}

/**
 * GET /api/agency-categories (active rows + their specialties) with a
 * module-level cache: concurrent callers share the in-flight promise, resolved
 * callers get the cached list. `force` re-fetches. Failures REJECT (callers
 * catch and degrade silently — same policy as the rest of the app).
 */
export function fetchCategoriesWithSpecialties(
  force = false,
): Promise<AgencyCategoryWithSpecialties[]> {
  if (!force && categoriesCache) return Promise.resolve(categoriesCache);
  if (!force && categoriesInflight) return categoriesInflight;

  const promise: Promise<AgencyCategoryWithSpecialties[]> = (async () => {
    const res = await fetchWithRetry('/api/agency-categories');
    if (!res.ok) throw new Error('FETCH_FAILED');
    const payload = (await res.json().catch(() => null)) as unknown;
    // Accept the auto-unwrapped array OR the raw { success, data } envelope.
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { data?: unknown })?.data)
        ? ((payload as { data: unknown[] }).data)
        : [];
    const rows = list
      .map(normalizeCategoryRow)
      .filter((r): r is AgencyCategoryWithSpecialties => r !== null);
    categoriesCache = rows;
    return rows;
  })();

  categoriesInflight = promise;
  void promise
    .finally(() => {
      if (categoriesInflight === promise) categoriesInflight = null;
    })
    .catch(() => {
      /* surfaced to callers via rejection; next call retries */
    });
  return promise;
}

/**
 * Finds a category row by slug (case-insensitive — customer chips carry the
 * UPPERCASED value while the dictionary stores the slug verbatim).
 */
export function findCategoryBySlug(
  rows: AgencyCategoryWithSpecialties[],
  slug: string | null | undefined,
): AgencyCategoryWithSpecialties | null {
  if (!slug) return null;
  const upper = slug.toUpperCase();
  return rows.find((c) => c.slug.toUpperCase() === upper) ?? null;
}

/** UI-language name for a specialty (ar → nameAr, fr → nameFr, else nameEn). */
export function localizeSpecialtyName(spec: AgencySpecialty, lang: Language): string {
  if (lang === 'ar' && spec.nameAr) return spec.nameAr;
  if (lang === 'fr' && spec.nameFr) return spec.nameFr;
  return spec.nameEn;
}

/**
 * Tolerant Agency.specialtyIds parser. The LIST endpoints return it already
 * parsed (string[]); the DETAIL endpoints spread the raw Prisma column (a
 * JSON string). Accepts both shapes, plus null/absent → [].
 */
export function parseAgencySpecialtyIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      /* not JSON — treat as no selection */
    }
  }
  return [];
}
