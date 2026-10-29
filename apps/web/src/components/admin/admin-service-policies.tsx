'use client';

/**
 * AdminServicePolicies — Services Management console (AUD-1 roadmap).
 *
 * Lets the SUPER_ADMIN decide, PER AGENCY TYPE (doctor, clinic, law office,
 * barber), whether service conditions/terms fields are OPTIONAL or MANDATORY.
 * Current governed field: service PRICE (DZD).
 *
 * - Data: GET  /api/service-policies  (categories catalog + policy matrix)
 * - Save: PUT  /api/service-policies  { category, field, isRequired }
 *   (optimistic toggle, auto-revert + toast on failure)
 *
 * Enforcement is server-side: with a mandatory price, agencies of that
 * category cannot save a service without a price (API returns
 * SERVICE_PRICE_REQUIRED) — the switch here only flips the policy.
 *
 * RTL-safe: logical spacing utilities only (ms/me/ps/pe/start/end).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Banknote,
  Building2,
  Info,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import type { TranslationKeys } from '@/i18n';
import type { Language } from '@/i18n';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CategoryEntry {
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  icon: string | null;
  isCustom: boolean;
  agencyCount: number;
}

interface PolicyRow {
  id: string;
  category: string;
  field: string;
  isRequired: boolean;
  updatedAt: string;
}

interface PoliciesPayload {
  success: boolean;
  fields: string[];
  categories: CategoryEntry[];
  policies: PolicyRow[];
  error?: string;
}

/** isRequired state per (category, field) — what the UI renders/edits. */
type PolicyMatrix = Record<string, boolean>; // `${category}::${field}` → isRequired

// ─── Built-in category display names (server stores stable keys) ────────────
// R-6c: the platform ships EXACTLY 4 built-ins. Unknown/legacy values still
// render via the cat.nameAr / cat.nameFr / cat.name fallback below.

const CATEGORY_LABELS: Record<string, Record<Language, string>> = {
  DOCTOR: { ar: 'طبيب', fr: 'Médecin', en: 'Doctor' },
  CLINIC: { ar: 'عيادة', fr: 'Clinique', en: 'Clinic' },
  LAW_OFFICE: { ar: 'مكتب محاماة', fr: "Cabinet d'avocat", en: 'Law Office' },
  BARBER: { ar: 'صالون حلاقة', fr: 'Salon de coiffure', en: 'Barber' },
};

function categoryDisplayName(cat: CategoryEntry, lang: Language): string {
  const labels = CATEGORY_LABELS[cat.name];
  if (labels) return labels[lang] ?? labels.en;
  if (lang === 'ar' && cat.nameAr) return cat.nameAr;
  if (lang === 'fr' && cat.nameFr) return cat.nameFr;
  return cat.name;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AdminServicePolicies() {
  const { t, lang } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [categories, setCategories] = useState<CategoryEntry[]>([]);
  const [fields, setFields] = useState<string[]>(['PRICE']);
  const [matrix, setMatrix] = useState<PolicyMatrix>({});
  const [updatedAt, setUpdatedAt] = useState<Record<string, string>>({});
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  // Latest-request guard: a slow PUT must never clobber a newer toggle.
  const latestPutSeq = useRef(0);

  const keyOf = (category: string, field: string) => `${category}::${field}`;

  const fetchPolicies = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setRefreshing(true);
    try {
      const res = await apiFetch('/api/service-policies');
      const data: PoliciesPayload = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || t('error'));
        return;
      }
      const nextMatrix: PolicyMatrix = {};
      const nextUpdatedAt: Record<string, string> = {};
      for (const p of data.policies) {
        nextMatrix[keyOf(p.category, p.field)] = p.isRequired;
        nextUpdatedAt[keyOf(p.category, p.field)] = p.updatedAt;
      }
      setCategories(data.categories ?? []);
      setFields(data.fields?.length ? data.fields : ['PRICE']);
      setMatrix(nextMatrix);
      setUpdatedAt(nextUpdatedAt);
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies(false);
  }, [fetchPolicies]);

  const togglePolicy = async (category: string, field: string, isRequired: boolean) => {
    const key = keyOf(category, field);
    const seq = ++latestPutSeq.current;

    // Optimistic update
    setMatrix((prev) => ({ ...prev, [key]: isRequired }));
    setSavingKeys((prev) => new Set(prev).add(key));

    try {
      const res = await apiFetch('/api/service-policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, field, isRequired }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        // Revert on failure (ignore if a newer toggle superseded this one)
        setMatrix((prev) => ({ ...prev, [key]: !isRequired }));
        toast.error(data.error || t('servicePolicySaveFailed'));
        return;
      }
      setUpdatedAt((prev) => ({ ...prev, [key]: data.policy?.updatedAt ?? new Date().toISOString() }));
      if (latestPutSeq.current === seq) {
        toast.success(t('servicePolicySaved'));
      }
    } catch {
      setMatrix((prev) => ({ ...prev, [key]: !isRequired }));
      toast.error(t('servicePolicySaveFailed'));
    } finally {
      setSavingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const filteredCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((cat) => {
      const display = categoryDisplayName(cat, lang).toLowerCase();
      return cat.name.toLowerCase().includes(q) || display.includes(q);
    });
  }, [categories, search, lang]);

  const mandatoryCount = useMemo(
    () => Object.values(matrix).filter(Boolean).length,
    [matrix]
  );

  const fieldLabel = (field: string): string => {
    if (field === 'PRICE') return t('servicePolicyFieldPrice');
    return field;
  };

  const fieldDescription = (field: string): string => {
    if (field === 'PRICE') return t('servicePolicyFieldPriceDesc');
    return '';
  };

  // ─── Loading skeleton ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-14 rounded-2xl" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-64 rounded-xl" />
          <Skeleton className="h-10 w-24 rounded-xl" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  // ─── Main render ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Enforcement explainer banner */}
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-200/70 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-950/30 p-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-900/50">
          <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            {t('servicePolicyBannerTitle')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-emerald-700 dark:text-emerald-300">
            {t('servicePolicyBannerBody')}
          </p>
        </div>
      </div>

      {/* Toolbar: search + stats + refresh */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('servicePolicySearchPlaceholder')}
            className="ps-9 h-10"
            aria-label={t('servicePolicySearchPlaceholder')}
          />
        </div>
        <Badge variant="outline" className="h-10 px-3 text-xs gap-1.5">
          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('servicePolicyCategoriesCount', { count: String(filteredCategories.length) })}
        </Badge>
        {mandatoryCount > 0 && (
          <Badge className="h-10 px-3 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-600 text-white">
            <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
            {t('servicePolicyMandatoryCount', { count: String(mandatoryCount) })}
          </Badge>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-10 gap-1.5"
          onClick={() => fetchPolicies(true)}
          disabled={refreshing}
          aria-label={t('refresh')}
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span className="hidden sm:inline">{t('refresh')}</span>
        </Button>
      </div>

      {/* Category policy cards */}
      {filteredCategories.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 p-10 text-center">
          <p className="text-sm text-muted-foreground">{t('servicePolicyNoResults')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredCategories.map((cat, index) => {
            const display = categoryDisplayName(cat, lang);
            return (
              <motion.div
                key={cat.name}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.03, 0.3) }}
                className="rounded-2xl border border-border/60 bg-white dark:bg-gray-900/80 dark:border-gray-800/50 shadow-sm p-5 flex flex-col gap-4"
              >
                {/* Card header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-bold text-foreground truncate" title={display}>
                      {display}
                    </h3>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground truncate" dir="ltr">
                      {cat.name}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="shrink-0 text-[10px] px-2 py-0.5 gap-1"
                    title={t('servicePolicyAgenciesCount', { count: String(cat.agencyCount) })}
                  >
                    <Building2 className="h-3 w-3" aria-hidden="true" />
                    {cat.agencyCount}
                  </Badge>
                </div>

                {/* Field policy rows */}
                <div className="space-y-3">
                  {fields.map((field) => {
                    const key = keyOf(cat.name, field);
                    const required = matrix[key] ?? false;
                    const saving = savingKeys.has(key);
                    return (
                      <div
                        key={field}
                        className="rounded-xl border border-border/50 bg-muted/30 dark:bg-gray-950/40 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                              <Banknote className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                              {fieldLabel(field)}
                            </p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                              {fieldDescription(field)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {saving && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
                            )}
                            <Switch
                              checked={required}
                              disabled={saving}
                              onCheckedChange={(v) => togglePolicy(cat.name, field, v)}
                              aria-label={`${fieldLabel(field)} — ${display}: ${required ? t('servicePolicyMandatory') : t('servicePolicyOptional')}`}
                            />
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span
                            className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${
                              required
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {required ? t('servicePolicyMandatory') : t('servicePolicyOptional')}
                          </span>
                          {updatedAt[key] && (
                            <span className="text-[10px] text-muted-foreground/70" dir="ltr">
                              {new Date(updatedAt[key]).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-GB')}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Footer note */}
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {t('servicePolicyFooterNote')}
      </p>
    </div>
  );
}
