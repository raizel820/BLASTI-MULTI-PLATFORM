'use client';

/**
 * AdminServicesManagement — Task C (R-6).
 *
 * Per-agency-type service conditions. The admin decides, for EACH agency
 * category (the 4 built-ins PLUS every user-created category):
 *   - Service price policy: OPTIONAL | MANDATORY
 *   - enforce: whether the API actually rejects service writes without a price
 *
 * 0.6.98 — ALL AGENCY CATEGORIES: the card matrix is no longer the hardcoded
 * 4 built-ins. It is driven by the BACKEND policy rows (GET /api/admin/
 * service-policies ensures one row per dictionary category, custom ones
 * included) enriched with the category dictionary (localized name + icon,
 * GET /api/agency-categories). A custom category created anywhere appears
 * here automatically — with its own policy card.
 *
 * API: GET/PUT /api/admin/service-policies (see apps/api routes/admin-service-policies.ts).
 * Design: RTL-first, semantic dark-mode tokens, emerald/teal palette only.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, RefreshCw, Save, Tags, Info } from 'lucide-react';
import { toast } from 'sonner';
import { BUILT_IN_CATEGORY_OPTIONS, fetchAgencyCategoriesOnce, type AgencyCategoryRow } from '@/hooks/use-agency-categories';
import { cn } from '@/lib/utils';
import type { TranslationKeys } from '@/i18n';

interface ServicePolicy {
  id: string;
  agencyCategory: string;
  servicePriceMode: 'OPTIONAL' | 'MANDATORY';
  enforce: boolean;
  updatedAt: string;
}

/** One card in the matrix: a policy row enriched with dictionary metadata. */
interface CategoryCard {
  value: string;
  /** UI label: built-ins use the i18n key; customs use the localized name. */
  labelKey: string | null;
  fallbackName: string;
  icon: string;
  isCustom: boolean;
}

export function AdminServicesManagement() {
  const { t, lang } = useLanguage();

  const [policies, setPolicies] = useState<ServicePolicy[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState<string | null>(null);
  // 0.6.98 — the category dictionary (built-ins + customs) for names/icons.
  const [categoryRows, setCategoryRows] = useState<AgencyCategoryRow[] | null>(null);
  // Local draft state per category (value shown in the card until saved)
  const [drafts, setDrafts] = useState<Record<string, { servicePriceMode: 'OPTIONAL' | 'MANDATORY'; enforce: boolean }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/service-policies');
      if (!res.ok) throw new Error('fetch failed');
      const data = await res.json();
      const rows: ServicePolicy[] = data.policies ?? [];
      setPolicies(rows);
      const next: Record<string, { servicePriceMode: 'OPTIONAL' | 'MANDATORY'; enforce: boolean }> = {};
      for (const p of rows) {
        next[p.agencyCategory] = { servicePriceMode: p.servicePriceMode, enforce: p.enforce };
      }
      setDrafts(next);
    } catch {
      toast.error(t('error'));
      setPolicies([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 0.6.98 — the category dictionary is the same module-cached store every
  // other consumer uses (one fetch per session; a new category is visible
  // everywhere instantly).
  useEffect(() => {
    fetchAgencyCategoriesOnce()
      .then((rows) => setCategoryRows(rows))
      .catch(() => { /* silent-degrade: cards still render from policy rows */ });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 0.6.98 — build the card matrix from the policy rows (backend-ensured for
   * EVERY dictionary category) enriched with dictionary metadata. Built-ins
   * keep their i18n label; customs show the localized row name.
   */
  const buildCards = useCallback((): CategoryCard[] => {
    if (!policies) return [];
    return policies.map((p) => {
      const slug = p.agencyCategory;
      const builtIn = BUILT_IN_CATEGORY_OPTIONS.find((o) => o.value === slug.toUpperCase());
      const dictRow = categoryRows?.find(
        (r) => r.name === slug || r.name.toUpperCase() === slug.toUpperCase(),
      );
      const localizedCustomName = dictRow
        ? (lang === 'ar' && dictRow.nameAr ? dictRow.nameAr : lang === 'fr' && dictRow.nameFr ? dictRow.nameFr : dictRow.name)
        : slug;
      return {
        value: slug,
        labelKey: builtIn?.labelKey ?? null,
        fallbackName: builtIn ? '' : localizedCustomName,
        icon: builtIn?.icon ?? dictRow?.icon ?? '🏷️',
        isCustom: !builtIn,
      };
    });
  }, [policies, categoryRows, lang]);

  const save = async (category: string) => {
    const draft = drafts[category];
    if (!draft) return;
    setSavingCategory(category);
    try {
      const res = await apiFetch(`/api/admin/service-policies/${category}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || 'save failed');
      }
      const data = await res.json();
      setPolicies((prev) =>
        prev ? prev.map((p) => (p.agencyCategory === category ? data.policy : p)) : prev,
      );
      toast.success(t('policySaved' as TranslationKeys));
    } catch {
      toast.error(t('policySaveError' as TranslationKeys));
    } finally {
      setSavingCategory(null);
    }
  };

  const updateDraft = (category: string, patch: Partial<{ servicePriceMode: 'OPTIONAL' | 'MANDATORY'; enforce: boolean }>) => {
    setDrafts((prev) => ({
      ...prev,
      [category]: { ...(prev[category] ?? { servicePriceMode: 'OPTIONAL', enforce: false }), ...patch },
    }));
  };

  const isDirty = (p: ServicePolicy) => {
    const d = drafts[p.agencyCategory];
    return !d || d.servicePriceMode !== p.servicePriceMode || d.enforce !== p.enforce;
  };

  return (
    <div className="p-4 lg:p-6 space-y-5 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Tags className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            {t('servicesManagement' as TranslationKeys)}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('servicesManagementDesc' as TranslationKeys)}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('refresh')}
        </Button>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-2 rounded-xl border border-teal-200 dark:border-teal-800/50 bg-teal-50/60 dark:bg-teal-950/20 p-3 text-sm text-teal-800 dark:text-teal-300">
        <Info className="h-4 w-4 mt-0.5 shrink-0" />
        <span>{t('servicesManagementHint' as TranslationKeys)}</span>
      </div>

      {/* Policy cards — one per agency category (ALL dictionary categories) */}
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-56 rounded-2xl" />)}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {buildCards().map((card) => {
            const opt = card;
            const policy = policies?.find((p) => p.agencyCategory === opt.value);
            const draft = drafts[opt.value] ?? { servicePriceMode: 'OPTIONAL' as const, enforce: false };
            const saving = savingCategory === opt.value;
            const dirty = policy ? isDirty(policy) : false;
            return (
              <Card key={opt.value} className="border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2.5 min-w-0">
                      <span className="text-2xl leading-none" aria-hidden>{opt.icon}</span>
                      <span className="truncate">{opt.labelKey ? t(opt.labelKey as TranslationKeys) : opt.fallbackName}</span>
                      {/* 0.6.98 — mark user-created categories so the matrix reads clearly. */}
                      {opt.isCustom && (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground shrink-0">
                          {t('catCustomBadge' as TranslationKeys)}
                        </Badge>
                      )}
                    </span>
                    {policy?.enforce && draft.enforce ? (
                      <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 shrink-0">
                        {t('enforceOn' as TranslationKeys)}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground shrink-0">
                        {t('enforceOff' as TranslationKeys)}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Price mode segmented control */}
                  <div>
                    <p className="text-sm font-medium text-foreground mb-2">
                      {t('servicePricePolicy' as TranslationKeys)}
                    </p>
                    <div
                      role="radiogroup"
                      aria-label={t('servicePricePolicy' as TranslationKeys)}
                      className="grid grid-cols-2 gap-2"
                    >
                      {(['OPTIONAL', 'MANDATORY'] as const).map((mode) => {
                        const selected = draft.servicePriceMode === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={saving}
                            onClick={() => updateDraft(opt.value, { servicePriceMode: mode })}
                            className={cn(
                              'rounded-xl border-2 px-3 py-2.5 text-sm font-medium transition-all cursor-pointer',
                              selected
                                ? 'border-emerald-500 dark:border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                                : 'border-gray-200 dark:border-gray-700 text-muted-foreground hover:border-emerald-300 dark:hover:border-emerald-700',
                            )}
                          >
                            {t(mode === 'OPTIONAL' ? 'priceOptional' : 'priceMandatory' as TranslationKeys)}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Enforce switch */}
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-700 p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{t('enforcePolicy' as TranslationKeys)}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('enforcePolicyDesc' as TranslationKeys)}
                      </p>
                    </div>
                    <Switch
                      checked={draft.enforce}
                      onCheckedChange={(v) => updateDraft(opt.value, { enforce: v })}
                      disabled={saving}
                      aria-label={t('enforcePolicy' as TranslationKeys)}
                    />
                  </div>

                  {/* Save */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground truncate">
                      {t('policyPerTypeHint' as TranslationKeys)}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => save(opt.value)}
                      disabled={saving || !dirty}
                      className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      {t('save')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}