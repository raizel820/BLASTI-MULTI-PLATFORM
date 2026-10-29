'use client';

/**
 * AdminCategoryManager — Agency Categories Manager (Task 5-a).
 *
 * SUPER_ADMIN CRUD over the AgencyCategory dictionary + its specialties:
 *   GET    /api/agency-categories?all=1            — list (built-ins + custom, with specialties)
 *   POST   /api/agency-categories                  — create custom category (slug = name)
 *   PATCH  /api/agency-categories/:id              — edit (slug only for custom rows)
 *   DELETE /api/agency-categories/:id              — delete (409 AGENCY_CATEGORY_IN_USE)
 *   POST   /api/agency-categories/:id/specialties  — add specialty
 *   PATCH  /api/agency-categories/specialties/:specId / DELETE …
 *
 * Self-contained page component: owns the section header via
 * AdminAgenciesManagementSectionPage (same pattern as the Task 5
 * AdminPaymentGatewaySettings page). RTL-first, emerald palette.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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
  LayoutGrid,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  RefreshCw,
  ChevronDown,
  Tags,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { AdminAgenciesManagementSectionPage } from '@/components/admin/admin-agencies-management-section-page';

// ─── Types ──────────────────────────────────────────────────────────

interface CategorySpecialty {
  id: string;
  nameEn: string;
  nameAr: string | null;
  nameFr: string | null;
  isActive: boolean;
}

interface AgencyCategory {
  id: string;
  slug: string;
  name: string;
  nameAr: string | null;
  nameFr: string | null;
  icon: string | null;
  isCustom: boolean;
  isActive: boolean;
  sortOrder: number;
  specialties: CategorySpecialty[];
}

interface CategoryForm {
  name: string;
  nameAr: string;
  nameFr: string;
  icon: string;
  slug: string;
  sortOrder: string;
}

interface SpecialtyForm {
  nameEn: string;
  nameAr: string;
  nameFr: string;
}

const EMPTY_CATEGORY_FORM: CategoryForm = { name: '', nameAr: '', nameFr: '', icon: '', slug: '', sortOrder: '100' };
const EMPTY_SPECIALTY_FORM: SpecialtyForm = { nameEn: '', nameAr: '', nameFr: '' };

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * apiClient auto-unwraps `{ success, data }` envelopes (Task 45 precedent) —
 * accept BOTH the raw envelope and the unwrapped payload.
 */
function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in (payload as Record<string, unknown>)) {
    return ((payload as { data?: unknown }).data ?? payload) as T;
  }
  return payload as T;
}

async function readError(res: { json: () => Promise<unknown> }): Promise<{ error?: string; agencyCount?: number }> {
  try {
    return (await res.json()) as { error?: string; agencyCount?: number };
  } catch {
    return {};
  }
}

// ─── Component ──────────────────────────────────────────────────────

export function AdminCategoryManager() {
  const { t } = useLanguage();

  const [categories, setCategories] = useState<AgencyCategory[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CategoryForm>(EMPTY_CATEGORY_FORM);
  const [creating, setCreating] = useState(false);

  // Edit dialog
  const [editTarget, setEditTarget] = useState<AgencyCategory | null>(null);
  const [editForm, setEditForm] = useState<CategoryForm>(EMPTY_CATEGORY_FORM);
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete category confirm
  const [deleteTarget, setDeleteTarget] = useState<AgencyCategory | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Specialties
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addSpecFor, setAddSpecFor] = useState<AgencyCategory | null>(null);
  const [specForm, setSpecForm] = useState<SpecialtyForm>(EMPTY_SPECIALTY_FORM);
  const [savingSpec, setSavingSpec] = useState(false);
  const [editSpec, setEditSpec] = useState<{ category: AgencyCategory; spec: CategorySpecialty } | null>(null);
  const [editSpecForm, setEditSpecForm] = useState<SpecialtyForm>(EMPTY_SPECIALTY_FORM);
  const [deleteSpec, setDeleteSpec] = useState<{ category: AgencyCategory; spec: CategorySpecialty } | null>(null);
  const [togglingSpecId, setTogglingSpecId] = useState<string | null>(null);

  // ── Data ──

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/agency-categories?all=1');
      if (!res.ok) throw new Error('fetch failed');
      const payload = await res.json();
      const rows = unwrapPayload<AgencyCategory[]>(payload);
      setCategories(Array.isArray(rows) ? rows : []);
    } catch {
      toast.error(t('error'));
      setCategories([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const patchCategory = async (id: string, body: Record<string, unknown>): Promise<boolean> => {
    const res = await apiFetch(`/api/agency-categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await readError(res);
      toast.error(t('error'));
      return false;
    }
    return true;
  };

  // ── Category actions ──

  const toggleActive = async (cat: AgencyCategory, value: boolean) => {
    setTogglingId(cat.id);
    const ok = await patchCategory(cat.id, { isActive: value });
    if (ok) {
      setCategories((prev) => prev ? prev.map((c) => (c.id === cat.id ? { ...c, isActive: value } : c)) : prev);
    }
    setTogglingId(null);
  };

  const handleCreate = async () => {
    const name = createForm.name.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await apiFetch('/api/agency-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          ...(createForm.nameAr.trim() ? { nameAr: createForm.nameAr.trim() } : {}),
          ...(createForm.nameFr.trim() ? { nameFr: createForm.nameFr.trim() } : {}),
          ...(createForm.icon.trim() ? { icon: createForm.icon.trim() } : {}),
        }),
      });
      if (!res.ok) {
        // CATEGORY_EXISTS / INVALID_NAME → generic error key (dictionaries frozen).
        await readError(res);
        toast.error(t('error'));
        return;
      }
      toast.success(t('success'));
      setCreateOpen(false);
      setCreateForm(EMPTY_CATEGORY_FORM);
      await load();
    } catch {
      toast.error(t('error'));
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (cat: AgencyCategory) => {
    setEditForm({
      name: cat.name,
      nameAr: cat.nameAr ?? '',
      nameFr: cat.nameFr ?? '',
      icon: cat.icon ?? '',
      slug: cat.slug,
      sortOrder: String(cat.sortOrder ?? 100),
    });
    setEditTarget(cat);
  };

  const handleEditSave = async () => {
    if (!editTarget || savingEdit) return;
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = {};
      if (editForm.name.trim() && editForm.name.trim() !== editTarget.name) body.name = editForm.name.trim();
      if (editForm.nameAr.trim() !== (editTarget.nameAr ?? '')) body.nameAr = editForm.nameAr.trim();
      if (editForm.nameFr.trim() !== (editTarget.nameFr ?? '')) body.nameFr = editForm.nameFr.trim();
      if (editForm.icon.trim() !== (editTarget.icon ?? '')) body.icon = editForm.icon.trim();
      const nextOrder = parseInt(editForm.sortOrder, 10);
      if (Number.isFinite(nextOrder) && nextOrder !== editTarget.sortOrder) body.sortOrder = nextOrder;
      // slug only for custom rows — the API rejects BUILT_IN_SLUG_IMMUTABLE.
      if (editTarget.isCustom && editForm.slug.trim() && editForm.slug.trim() !== editTarget.slug) {
        body.slug = editForm.slug.trim();
      }

      if (Object.keys(body).length === 0) {
        setEditTarget(null);
        return;
      }
      if (await patchCategory(editTarget.id, body)) {
        toast.success(t('success'));
        setEditTarget(null);
        await load();
      }
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/agency-categories/${deleteTarget.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('success'));
        setDeleteTarget(null);
        await load();
      } else {
        const err = await readError(res);
        if (res.status === 409 && err.error === 'AGENCY_CATEGORY_IN_USE') {
          toast.error(t('catMgrInUseError', { count: String(err.agencyCount ?? 0) }));
        } else {
          toast.error(t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleting(false);
    }
  };

  // ── Specialty actions ──

  const toggleExpanded = (categoryId: string) => {
    setExpanded((prev) => ({ ...prev, [categoryId]: !prev[categoryId] }));
  };

  const patchSpecialty = async (specId: string, body: Record<string, unknown>): Promise<boolean> => {
    const res = await apiFetch(`/api/agency-categories/specialties/${specId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      await readError(res);
      toast.error(t('error'));
      return false;
    }
    return true;
  };

  const updateSpecialtyLocal = (categoryId: string, specId: string, patch: Partial<CategorySpecialty>) => {
    setCategories((prev) =>
      prev
        ? prev.map((c) =>
            c.id === categoryId
              ? { ...c, specialties: c.specialties.map((s) => (s.id === specId ? { ...s, ...patch } : s)) }
              : c,
          )
        : prev,
    );
  };

  const toggleSpecActive = async (cat: AgencyCategory, spec: CategorySpecialty, value: boolean) => {
    setTogglingSpecId(spec.id);
    const ok = await patchSpecialty(spec.id, { isActive: value });
    if (ok) updateSpecialtyLocal(cat.id, spec.id, { isActive: value });
    setTogglingSpecId(null);
  };

  const handleAddSpecialty = async () => {
    if (!addSpecFor || savingSpec) return;
    const nameEn = specForm.nameEn.trim();
    if (!nameEn) return;
    setSavingSpec(true);
    try {
      const res = await apiFetch(`/api/agency-categories/${addSpecFor.id}/specialties`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nameEn,
          nameAr: specForm.nameAr.trim() || nameEn,
          nameFr: specForm.nameFr.trim() || nameEn,
        }),
      });
      if (!res.ok) {
        await readError(res); // SPECIALTY_EXISTS → generic error key
        toast.error(t('error'));
        return;
      }
      toast.success(t('success'));
      setAddSpecFor(null);
      setSpecForm(EMPTY_SPECIALTY_FORM);
      await load();
      setExpanded((prev) => ({ ...prev, [addSpecFor.id]: true }));
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingSpec(false);
    }
  };

  const openEditSpecialty = (category: AgencyCategory, spec: CategorySpecialty) => {
    setEditSpecForm({ nameEn: spec.nameEn, nameAr: spec.nameAr ?? '', nameFr: spec.nameFr ?? '' });
    setEditSpec({ category, spec });
  };

  const handleEditSpecialty = async () => {
    if (!editSpec || savingSpec) return;
    setSavingSpec(true);
    try {
      const body: Record<string, unknown> = {};
      if (editSpecForm.nameEn.trim() && editSpecForm.nameEn.trim() !== editSpec.spec.nameEn) body.nameEn = editSpecForm.nameEn.trim();
      if (editSpecForm.nameAr.trim() !== (editSpec.spec.nameAr ?? '')) body.nameAr = editSpecForm.nameAr.trim();
      if (editSpecForm.nameFr.trim() !== (editSpec.spec.nameFr ?? '')) body.nameFr = editSpecForm.nameFr.trim();
      if (Object.keys(body).length === 0) {
        setEditSpec(null);
        return;
      }
      if (await patchSpecialty(editSpec.spec.id, body)) {
        toast.success(t('success'));
        setEditSpec(null);
        await load();
      }
    } finally {
      setSavingSpec(false);
    }
  };

  const handleDeleteSpecialty = async () => {
    if (!deleteSpec || savingSpec) return;
    setSavingSpec(true);
    try {
      const res = await apiFetch(`/api/agency-categories/specialties/${deleteSpec.spec.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('success'));
        setDeleteSpec(null);
        await load();
      } else {
        await readError(res);
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingSpec(false);
    }
  };

  // ── Render ──

  return (
    <AdminAgenciesManagementSectionPage
      icon={LayoutGrid}
      titleKey="agenciesMgmtCategories"
      descKey="agenciesMgmtCategoriesDesc"
    >
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-muted-foreground">
            {categories && (
              <span>
                {t('catMgrSpecialtiesCount', { count: String(categories.reduce((acc, c) => acc + c.specialties.length, 0)) })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('refresh')}
            </Button>
            <Button
              size="sm"
              onClick={() => { setCreateForm(EMPTY_CATEGORY_FORM); setCreateOpen(true); }}
              className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <Plus className="h-4 w-4" />
              {t('catMgrAddCategory')}
            </Button>
          </div>
        </div>

        {/* Category cards */}
        {loading && categories === null ? (
          <div className="space-y-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
          </div>
        ) : !categories || categories.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {t('catMgrEmpty')}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {categories.map((cat) => {
              const isOpen = !!expanded[cat.id];
              return (
                <Card
                  key={cat.id}
                  className={cn(
                    'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm',
                    !cat.isActive && 'opacity-70',
                  )}
                >
                  <CardContent className="p-4 space-y-3">
                    {/* Main row */}
                    <div className="flex items-start gap-3 flex-wrap">
                      <span className="text-2xl leading-none shrink-0" aria-hidden>
                        {cat.icon || '🏢'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold text-foreground truncate">{cat.name}</h3>
                          <Badge
                            variant="outline"
                            className="font-mono text-[11px] text-muted-foreground shrink-0"
                          >
                            {cat.slug}
                          </Badge>
                          {cat.isCustom ? (
                            <Badge className="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800 shrink-0">
                              {t('catMgrCustom')}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground shrink-0">
                              {t('catMgrBuiltIn')}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate" dir="auto">
                          {[cat.nameAr, cat.nameFr].filter(Boolean).join(' · ') || cat.slug}
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-2 shrink-0 flex-wrap">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                          <Switch
                            checked={cat.isActive}
                            onCheckedChange={(v) => toggleActive(cat, v)}
                            disabled={togglingId === cat.id}
                            aria-label={t('catMgrActive')}
                          />
                          {t('catMgrActive')}
                        </label>
                        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => openEdit(cat)} aria-label={t('catMgrEditCategory')}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                          onClick={() => setDeleteTarget(cat)}
                          aria-label={t('catMgrDeleteCategory')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Specialties expander */}
                    <div className="border-t border-border/60 pt-2">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(cat.id)}
                        aria-expanded={isOpen}
                        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      >
                        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-180')} />
                        <Tags className="h-3.5 w-3.5" />
                        {t('catMgrSpecialties')} ({cat.specialties.length})
                      </button>

                      {isOpen && (
                        <div className="mt-3 space-y-2">
                          {cat.specialties.length === 0 ? (
                            <p className="text-xs text-muted-foreground px-1">{t('noData')}</p>
                          ) : (
                            <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-2">
                              {cat.specialties.map((spec) => (
                                <div
                                  key={spec.id}
                                  className={cn(
                                    'flex items-center gap-3 rounded-xl border border-border/60 p-2.5 flex-wrap',
                                    !spec.isActive && 'opacity-60',
                                  )}
                                >
                                  <div className="min-w-0 flex-1" dir="auto">
                                    <p className="text-xs font-medium text-foreground truncate">{spec.nameEn}</p>
                                    <p className="text-[11px] text-muted-foreground truncate">
                                      {[spec.nameAr, spec.nameFr].filter(Boolean).join(' · ') || '—'}
                                    </p>
                                  </div>
                                  <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
                                    <Switch
                                      checked={spec.isActive}
                                      onCheckedChange={(v) => toggleSpecActive(cat, spec, v)}
                                      disabled={togglingSpecId === spec.id}
                                      aria-label={t('catMgrActive')}
                                    />
                                    {t('catMgrActive')}
                                  </label>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => openEditSpecialty(cat, spec)}
                                    aria-label={t('catMgrEditSpecialty')}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                                    onClick={() => setDeleteSpec({ category: cat, spec })}
                                    aria-label={t('catMgrDeleteCategory')}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                            onClick={() => { setSpecForm(EMPTY_SPECIALTY_FORM); setAddSpecFor(cat); }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {t('catMgrAddSpecialty')}
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── Create Category Dialog ─── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {t('catMgrAddCategory')}
            </DialogTitle>
            <DialogDescription>
              {t('catMgrSlugHint')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cat-create-name">{t('catMgrName')}</Label>
              <Input
                id="cat-create-name"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                dir="ltr"
                maxLength={40}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cat-create-name-ar">{t('catMgrNameAr')}</Label>
                <Input
                  id="cat-create-name-ar"
                  value={createForm.nameAr}
                  onChange={(e) => setCreateForm((f) => ({ ...f, nameAr: e.target.value }))}
                  dir="rtl"
                  maxLength={40}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cat-create-name-fr">{t('catMgrNameFr')}</Label>
                <Input
                  id="cat-create-name-fr"
                  value={createForm.nameFr}
                  onChange={(e) => setCreateForm((f) => ({ ...f, nameFr: e.target.value }))}
                  dir="ltr"
                  maxLength={40}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-create-icon">{t('catMgrIcon')}</Label>
              <Input
                id="cat-create-icon"
                value={createForm.icon}
                onChange={(e) => setCreateForm((f) => ({ ...f, icon: e.target.value }))}
                maxLength={8}
                className="w-24"
              />
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto rounded-xl h-10" onClick={() => setCreateOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !createForm.name.trim()}
              className="w-full sm:w-auto rounded-xl h-10 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Category Dialog ─── */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {t('catMgrEditCategory')}
            </DialogTitle>
            <DialogDescription>
              {editTarget?.isCustom ? t('catMgrSlugHint') : t('catMgrSlugImmutable')}
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cat-edit-name">{t('catMgrName')}</Label>
                <Input
                  id="cat-edit-name"
                  value={editForm.name}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                  dir="ltr"
                  maxLength={40}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cat-edit-name-ar">{t('catMgrNameAr')}</Label>
                  <Input
                    id="cat-edit-name-ar"
                    value={editForm.nameAr}
                    onChange={(e) => setEditForm((f) => ({ ...f, nameAr: e.target.value }))}
                    dir="rtl"
                    maxLength={40}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cat-edit-name-fr">{t('catMgrNameFr')}</Label>
                  <Input
                    id="cat-edit-name-fr"
                    value={editForm.nameFr}
                    onChange={(e) => setEditForm((f) => ({ ...f, nameFr: e.target.value }))}
                    dir="ltr"
                    maxLength={40}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cat-edit-icon">{t('catMgrIcon')}</Label>
                  <Input
                    id="cat-edit-icon"
                    value={editForm.icon}
                    onChange={(e) => setEditForm((f) => ({ ...f, icon: e.target.value }))}
                    maxLength={8}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cat-edit-order">{t('catMgrSortOrder')}</Label>
                  <Input
                    id="cat-edit-order"
                    type="number"
                    value={editForm.sortOrder}
                    onChange={(e) => setEditForm((f) => ({ ...f, sortOrder: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cat-edit-slug">{t('catMgrSlug')}</Label>
                <Input
                  id="cat-edit-slug"
                  value={editForm.slug}
                  onChange={(e) => setEditForm((f) => ({ ...f, slug: e.target.value }))}
                  dir="ltr"
                  maxLength={40}
                  readOnly={!editTarget.isCustom}
                  disabled={!editTarget.isCustom}
                  className={cn(!editTarget.isCustom && 'opacity-60 cursor-not-allowed font-mono')}
                />
                <p className="text-[11px] text-muted-foreground">
                  {editTarget.isCustom ? t('catMgrSlugHint') : t('catMgrSlugImmutable')}
                </p>
              </div>
            </div>
          )}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto rounded-xl h-10" onClick={() => setEditTarget(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={savingEdit || !editForm.name.trim()}
              className="w-full sm:w-auto rounded-xl h-10 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {savingEdit && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Category Confirm ─── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('catMgrDeleteCategory')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && t('catMgrDeleteConfirm', { name: deleteTarget.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full rounded-xl h-10">
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin me-1" />}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Add Specialty Dialog ─── */}
      <Dialog open={!!addSpecFor} onOpenChange={(open) => { if (!open) setAddSpecFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {t('catMgrAddSpecialty')}
            </DialogTitle>
            <DialogDescription>
              {addSpecFor?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="spec-add-en">{t('catMgrSpecialtyNameEn')}</Label>
              <Input
                id="spec-add-en"
                value={specForm.nameEn}
                onChange={(e) => setSpecForm((f) => ({ ...f, nameEn: e.target.value }))}
                dir="ltr"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="spec-add-ar">{t('catMgrSpecialtyNameAr')}</Label>
              <Input
                id="spec-add-ar"
                value={specForm.nameAr}
                onChange={(e) => setSpecForm((f) => ({ ...f, nameAr: e.target.value }))}
                dir="rtl"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="spec-add-fr">{t('catMgrSpecialtyNameFr')}</Label>
              <Input
                id="spec-add-fr"
                value={specForm.nameFr}
                onChange={(e) => setSpecForm((f) => ({ ...f, nameFr: e.target.value }))}
                dir="ltr"
                maxLength={60}
              />
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto rounded-xl h-10" onClick={() => setAddSpecFor(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleAddSpecialty}
              disabled={savingSpec || !specForm.nameEn.trim()}
              className="w-full sm:w-auto rounded-xl h-10 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {savingSpec && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Specialty Dialog ─── */}
      <Dialog open={!!editSpec} onOpenChange={(open) => { if (!open) setEditSpec(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              {t('catMgrEditSpecialty')}
            </DialogTitle>
            <DialogDescription>
              {editSpec?.category.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="spec-edit-en">{t('catMgrSpecialtyNameEn')}</Label>
              <Input
                id="spec-edit-en"
                value={editSpecForm.nameEn}
                onChange={(e) => setEditSpecForm((f) => ({ ...f, nameEn: e.target.value }))}
                dir="ltr"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="spec-edit-ar">{t('catMgrSpecialtyNameAr')}</Label>
              <Input
                id="spec-edit-ar"
                value={editSpecForm.nameAr}
                onChange={(e) => setEditSpecForm((f) => ({ ...f, nameAr: e.target.value }))}
                dir="rtl"
                maxLength={60}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="spec-edit-fr">{t('catMgrSpecialtyNameFr')}</Label>
              <Input
                id="spec-edit-fr"
                value={editSpecForm.nameFr}
                onChange={(e) => setEditSpecForm((f) => ({ ...f, nameFr: e.target.value }))}
                dir="ltr"
                maxLength={60}
              />
            </div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="w-full sm:w-auto rounded-xl h-10" onClick={() => setEditSpec(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={handleEditSpecialty}
              disabled={savingSpec || !editSpecForm.nameEn.trim()}
              className="w-full sm:w-auto rounded-xl h-10 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              {savingSpec && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Specialty Confirm (generic — stripping also removes the
           specialty from every agency referencing it) ─── */}
      <AlertDialog open={!!deleteSpec} onOpenChange={(open) => { if (!open) setDeleteSpec(null); }}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('delete')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteSpec && `${deleteSpec.spec.nameEn} — ${t('confirm')}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel className="w-full rounded-xl h-10">
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteSpecialty}
              disabled={savingSpec}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
            >
              {savingSpec && <Loader2 className="h-4 w-4 animate-spin me-1" />}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminAgenciesManagementSectionPage>
  );
}
