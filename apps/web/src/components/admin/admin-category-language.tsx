'use client';

/**
 * AdminCategoryLanguage — Agency Categories Language (Task 5-a).
 *
 * Per-category terminology overrides (ar/en/fr) — the words agencies of a
 * given category see in the customer UI instead of the standard dictionary
 * strings:
 *   GET    /api/agency-categories?all=1               — category picker source
 *   GET    /api/agency-categories/terms?category=SLUG — terms for one category
 *   POST   /api/agency-categories/:id/terms           — add override (409 TERM_EXISTS)
 *   PATCH  /api/agency-categories/terms/:termId       — edit override
 *   DELETE /api/agency-categories/terms/:termId       — remove override
 *
 * Self-contained page component (section shell inside, same pattern as
 * AdminPaymentGatewaySettings). The "Default:" hint shows the standard
 * dictionary string for the CURRENT UI language via t().
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Languages,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { AdminAgenciesManagementSectionPage } from '@/components/admin/admin-agencies-management-section-page';
import type { TranslationKeys } from '@/i18n';

// ─── Types ──────────────────────────────────────────────────────────

interface PickerCategory {
  id: string;
  slug: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  icon: string | null;
  isActive: boolean;
}

interface CategoryTerm {
  id: string;
  key: string;
  valueAr: string | null;
  valueEn: string | null;
  valueFr: string | null;
}

interface TermForm {
  key: string;
  valueAr: string;
  valueEn: string;
  valueFr: string;
}

const EMPTY_TERM_FORM: TermForm = { key: '', valueAr: '', valueEn: '', valueFr: '' };

// Quick-pick dictionary keys the admin most likely wants to override.
const SUGGESTED_KEYS: string[] = [
  'customer',
  'totalCustomers',
  'customersServed',
  'waitingCustomers',
  'customerReviews',
  'customersPerHour',
];

// ─── Helpers ────────────────────────────────────────────────────────

/** apiClient auto-unwraps `{ success, data }` envelopes — accept both shapes. */
function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in (payload as Record<string, unknown>)) {
    return ((payload as { data?: unknown }).data ?? payload) as T;
  }
  return payload as T;
}

async function readError(res: { json: () => Promise<unknown> }): Promise<{ error?: string }> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return {};
  }
}

// ─── Component ──────────────────────────────────────────────────────

export function AdminCategoryLanguage() {
  const { t } = useLanguage();

  const [categories, setCategories] = useState<PickerCategory[] | null>(null);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [selectedSlug, setSelectedSlug] = useState<string>('');

  const [terms, setTerms] = useState<CategoryTerm[] | null>(null);
  const [loadingTerms, setLoadingTerms] = useState(false);

  // Add dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<TermForm>(EMPTY_TERM_FORM);
  const [saving, setSaving] = useState(false);

  // Edit dialog
  const [editTarget, setEditTarget] = useState<CategoryTerm | null>(null);
  const [editForm, setEditForm] = useState<TermForm>(EMPTY_TERM_FORM);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<CategoryTerm | null>(null);

  const selectedCategory = categories?.find((c) => c.slug === selectedSlug) ?? null;

  // ── Categories (picker source) ──

  const loadCategories = useCallback(async () => {
    setLoadingCategories(true);
    try {
      const res = await apiFetch('/api/agency-categories?all=1');
      if (!res.ok) throw new Error('fetch failed');
      const payload = await res.json();
      const rows = unwrapPayload<PickerCategory[]>(payload);
      const list = Array.isArray(rows) ? rows : [];
      setCategories(list);
      // Auto-select the first category so the table is never dead on arrival.
      setSelectedSlug((prev) => (prev && list.some((c) => c.slug === prev) ? prev : list[0]?.slug ?? ''));
    } catch {
      toast.error(t('error'));
      setCategories([]);
    } finally {
      setLoadingCategories(false);
    }
  }, [t]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  // ── Terms for the selected category ──

  const loadTerms = useCallback(async (slug: string) => {
    if (!slug) {
      setTerms(null);
      return;
    }
    setLoadingTerms(true);
    try {
      const res = await apiFetch(`/api/agency-categories/terms?category=${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('fetch failed');
      const payload = await res.json();
      const data = unwrapPayload<{ terms?: CategoryTerm[] }>(payload);
      setTerms(Array.isArray(data?.terms) ? data.terms : []);
    } catch {
      toast.error(t('error'));
      setTerms([]);
    } finally {
      setLoadingTerms(false);
    }
  }, [t]);

  useEffect(() => {
    loadTerms(selectedSlug);
  }, [selectedSlug, loadTerms]);

  // ── Add term ──

  const openAdd = () => {
    setAddForm(EMPTY_TERM_FORM);
    setAddOpen(true);
  };

  const handleAdd = async () => {
    if (!selectedCategory || saving) return;
    const key = addForm.key.trim();
    if (!key) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/agency-categories/${selectedCategory.id}/terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          valueAr: addForm.valueAr.trim(),
          valueEn: addForm.valueEn.trim(),
          valueFr: addForm.valueFr.trim(),
        }),
      });
      if (!res.ok) {
        const err = await readError(res);
        if (res.status === 409 && err.error === 'TERM_EXISTS') {
          toast.error(t('catLangTermExists'));
        } else {
          toast.error(t('error'));
        }
        return;
      }
      toast.success(t('success'));
      setAddOpen(false);
      setAddForm(EMPTY_TERM_FORM);
      await loadTerms(selectedSlug);
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  // ── Edit term ──

  const openEdit = (term: CategoryTerm) => {
    setEditForm({
      key: term.key,
      valueAr: term.valueAr ?? '',
      valueEn: term.valueEn ?? '',
      valueFr: term.valueFr ?? '',
    });
    setEditTarget(term);
  };

  const handleEdit = async () => {
    if (!editTarget || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/agency-categories/terms/${editTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editForm.key.trim() && editForm.key.trim() !== editTarget.key ? { key: editForm.key.trim() } : {}),
          valueAr: editForm.valueAr.trim(),
          valueEn: editForm.valueEn.trim(),
          valueFr: editForm.valueFr.trim(),
        }),
      });
      if (!res.ok) {
        const err = await readError(res);
        if (res.status === 409 && err.error === 'TERM_EXISTS') {
          toast.error(t('catLangTermExists'));
        } else {
          toast.error(t('error'));
        }
        return;
      }
      toast.success(t('success'));
      setEditTarget(null);
      await loadTerms(selectedSlug);
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  // ── Delete term ──

  const handleDelete = async () => {
    if (!deleteTarget || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/agency-categories/terms/${deleteTarget.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('success'));
        setDeleteTarget(null);
        await loadTerms(selectedSlug);
      } else {
        await readError(res);
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  // ── Render helpers ──

  // Dictionary default for the CURRENT UI language — shown under a picked key.
  const dictionaryDefault = (key: string): string | null => {
    if (!key || !SUGGESTED_KEYS.includes(key)) return null;
    try {
      return t(key as TranslationKeys);
    } catch {
      return null;
    }
  };

  const keyPattern = /^[A-Za-z][A-Za-z0-9_.]{1,59}$/;

  const renderTermDialogFields = (
    form: TermForm,
    setForm: (f: TermForm) => void,
    idPrefix: string,
  ) => (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-key`}>{t('catLangKey')}</Label>
        <Input
          id={`${idPrefix}-key`}
          value={form.key}
          onChange={(e) => setForm({ ...form, key: e.target.value })}
          dir="ltr"
          className="font-mono"
          maxLength={60}
        />
        <p className="text-[11px] text-muted-foreground">{t('catLangKeyHint')}</p>
        {/* Suggested keys — quick-pick chips + the standard dictionary string */}
        <div className="space-y-1.5 pt-1">
          <p className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
            <Sparkles className="h-3 w-3" />
            {t('catLangSuggested')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setForm({ ...form, key })}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] font-mono transition-colors cursor-pointer',
                  form.key === key
                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                    : 'border-border text-muted-foreground hover:border-emerald-300 hover:text-foreground',
                )}
              >
                {key}
              </button>
            ))}
          </div>
          {dictionaryDefault(form.key.trim()) && (
            <p className="text-[11px] text-muted-foreground" dir="auto">
              {t('catLangDefault', { value: dictionaryDefault(form.key.trim()) as string })}
            </p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-ar`}>{t('catLangValueAr')}</Label>
        <Input
          id={`${idPrefix}-ar`}
          value={form.valueAr}
          onChange={(e) => setForm({ ...form, valueAr: e.target.value })}
          dir="rtl"
          maxLength={120}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-en`}>{t('catLangValueEn')}</Label>
        <Input
          id={`${idPrefix}-en`}
          value={form.valueEn}
          onChange={(e) => setForm({ ...form, valueEn: e.target.value })}
          dir="ltr"
          maxLength={120}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-fr`}>{t('catLangValueFr')}</Label>
        <Input
          id={`${idPrefix}-fr`}
          value={form.valueFr}
          onChange={(e) => setForm({ ...form, valueFr: e.target.value })}
          dir="ltr"
          maxLength={120}
        />
      </div>
    </div>
  );

  const termFormValid = (form: TermForm) =>
    keyPattern.test(form.key.trim()) &&
    form.valueAr.trim().length > 0 &&
    form.valueEn.trim().length > 0 &&
    form.valueFr.trim().length > 0;

  // ── Render ──

  return (
    <AdminAgenciesManagementSectionPage
      icon={Languages}
      titleKey="agenciesMgmtCategoryLanguage"
      descKey="agenciesMgmtCategoryLanguageDesc"
    >
      <div className="space-y-4">
        {/* Category picker + actions */}
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={selectedSlug} onValueChange={setSelectedSlug}>
            <SelectTrigger className="w-full sm:w-64" aria-label={t('catLangPickCategory')}>
              <SelectValue placeholder={t('catLangPickCategory')} />
            </SelectTrigger>
            <SelectContent>
              {(categories ?? []).map((cat) => (
                <SelectItem key={cat.id} value={cat.slug}>
                  <span className="flex items-center gap-2">
                    <span aria-hidden>{cat.icon || '🏢'}</span>
                    <span className="truncate">{cat.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 ms-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadTerms(selectedSlug)}
              disabled={loadingTerms || !selectedSlug}
              className="gap-2"
            >
              {loadingTerms ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('refresh')}
            </Button>
            <Button
              size="sm"
              onClick={openAdd}
              disabled={!selectedCategory}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-4 w-4" />
              {t('catLangAddTerm')}
            </Button>
          </div>
        </div>

        {/* Terms table */}
        {!selectedSlug ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {loadingCategories ? t('loading') : t('catLangPickCategory')}
            </CardContent>
          </Card>
        ) : loadingTerms && terms === null ? (
          <Skeleton className="h-48 rounded-2xl" />
        ) : !terms || terms.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {t('catLangEmpty')}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm">
            <CardContent className="p-0">
              <div className="overflow-x-auto custom-scrollbar">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[22%]">{t('catLangKey')}</TableHead>
                      <TableHead className="w-[22%]">{t('catLangValueAr')}</TableHead>
                      <TableHead className="w-[22%]">{t('catLangValueEn')}</TableHead>
                      <TableHead className="w-[22%]">{t('catLangValueFr')}</TableHead>
                      <TableHead className="w-[12%] text-end">{t('actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {terms.map((term) => (
                      <TableRow key={term.id}>
                        <TableCell className="font-mono text-xs" dir="ltr">{term.key}</TableCell>
                        <TableCell className="text-sm" dir="rtl">{term.valueAr || '—'}</TableCell>
                        <TableCell className="text-sm" dir="ltr">{term.valueEn || '—'}</TableCell>
                        <TableCell className="text-sm" dir="ltr">{term.valueFr || '—'}</TableCell>
                        <TableCell className="text-end">
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => openEdit(term)}
                              aria-label={t('catLangEditTerm')}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                              onClick={() => setDeleteTarget(term)}
                              aria-label={t('catLangDeleteTerm')}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ─── Add Term Dialog ─── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {t('catLangAddTerm')}
            </DialogTitle>
            <DialogDescription>
              {selectedCategory && (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>{selectedCategory.icon || '🏢'}</span>
                  {selectedCategory.name}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {renderTermDialogFields(addForm, setAddForm, 'term-add')}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto rounded-xl h-10" onClick={() => setAddOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={saving || !termFormValid(addForm)}
              className="w-full sm:w-auto rounded-xl h-10 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Term Dialog ─── */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {t('catLangEditTerm')}
            </DialogTitle>
            <DialogDescription>
              {selectedCategory && (
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>{selectedCategory.icon || '🏢'}</span>
                  {selectedCategory.name}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {renderTermDialogFields(editForm, setEditForm, 'term-edit')}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto rounded-xl h-10" onClick={() => setEditTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleEdit}
              disabled={saving || !termFormValid(editForm)}
              className="w-full sm:w-auto rounded-xl h-10 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Term Confirm ─── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('catLangDeleteTerm')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono" dir="ltr">{deleteTarget?.key}</span>
              {' — '}
              {t('confirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full rounded-xl h-10">
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={saving}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin me-1" />}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminAgenciesManagementSectionPage>
  );
}
