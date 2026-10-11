'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { translateCategory } from '@/lib/enum-i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  Save,
  Check,
  X,
  Loader2,
  RefreshCw,
  Monitor,
  Cpu,
  Tablet,
  Printer,
  Settings,
  Crown,
  CalendarClock,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ──────────────────────────────────────────────────────────────────
// Mirrors the HardwareProduct / HardwareSettings / HardwareCommitmentTier
// models in packages/db/prisma/schema.prisma. The admin page consumes them
// from GET /api/admin/hardware and GET /api/admin/hardware/settings.

interface HardwareProduct {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  descriptionFr?: string | null;
  category: string; // "TV", "PC", "KIOSK", "PRINTER"
  basePrice: number; // DZD
  isActive: boolean;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

interface HardwareSettingsData {
  id: string;
  hardwareEnabled: boolean;
  upfrontDiscount: number;
}

interface CommitmentTier {
  id: string;
  months: number; // 12/24/36/48/60
  label: string;
  labelAr?: string | null;
  labelFr?: string | null;
  extraPercentage: number;
  isActive: boolean;
  sortOrder: number;
}

interface ProductFormData {
  name: string;
  nameAr: string;
  nameFr: string;
  description: string;
  descriptionAr: string;
  descriptionFr: string;
  category: string;
  basePrice: number;
  isActive: boolean;
  sortOrder: number;
}

const defaultProductFormData: ProductFormData = {
  name: '',
  nameAr: '',
  nameFr: '',
  description: '',
  descriptionAr: '',
  descriptionFr: '',
  category: 'TV',
  basePrice: 0,
  isActive: true,
  sortOrder: 0,
};

const categoryOptions = [
  { value: 'TV', label: 'TV' },
  { value: 'PC', label: 'PC' },
  { value: 'KIOSK', label: 'Kiosk' },
  { value: 'PRINTER', label: 'Printer' },
  { value: 'OTHER', label: 'Other' },
];

function categoryIcon(category: string): typeof Monitor {
  switch (category.toUpperCase()) {
    case 'TV':
      return Monitor;
    case 'PC':
      return Monitor;
    case 'KIOSK':
      return Tablet;
    case 'PRINTER':
      return Printer;
    default:
      return Cpu;
  }
}

function getLocalizedProductName(p: HardwareProduct, lang: string): string {
  if (lang === 'ar' && p.nameAr) return p.nameAr;
  if (lang === 'fr' && p.nameFr) return p.nameFr;
  return p.name;
}

function getLocalizedTierLabel(t: CommitmentTier, lang: string): string {
  if (lang === 'ar' && t.labelAr) return t.labelAr;
  if (lang === 'fr' && t.labelFr) return t.labelFr;
  return t.label;
}

export function AdminHardware() {
  const { setView } = useAppStore();
  const { t, lang } = useLanguage();

  // Products state
  const [products, setProducts] = useState<HardwareProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  // Settings + tiers state
  const [settings, setSettings] = useState<HardwareSettingsData | null>(null);
  const [tiers, setTiers] = useState<CommitmentTier[]>([]);
  const [loadingSettings, setLoadingSettings] = useState(true);

  // Settings form (kept separate so the toggle/discount can be edited before saving)
  const [settingsDraft, setSettingsDraft] = useState<{ hardwareEnabled: boolean; upfrontDiscount: number }>({
    hardwareEnabled: true,
    upfrontDiscount: 0,
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Product dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<HardwareProduct | null>(null);
  const [formData, setFormData] = useState<ProductFormData>({ ...defaultProductFormData });
  const [savingProduct, setSavingProduct] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<HardwareProduct | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Inline tier extra-percentage editing
  const [tierEditId, setTierEditId] = useState<string | null>(null);
  const [tierEditValue, setTierEditValue] = useState<number>(0);
  const [savingTierId, setSavingTierId] = useState<string | null>(null);

  // ─── Data fetching ────────────────────────────────────────────────────────

  const fetchProducts = useCallback(async () => {
    setLoadingProducts(true);
    try {
      const res = await apiFetch('/api/admin/hardware');
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products ?? []);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoadingProducts(false);
    }
  }, [t]);

  const fetchSettings = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const res = await apiFetch('/api/admin/hardware/settings');
      if (res.ok) {
        const data = await res.json();
        const s: HardwareSettingsData = data.settings ?? {
          id: 'singleton',
          hardwareEnabled: true,
          upfrontDiscount: 0,
        };
        setSettings(s);
        setSettingsDraft({ hardwareEnabled: s.hardwareEnabled, upfrontDiscount: s.upfrontDiscount });
        setTiers(data.commitmentTiers ?? []);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoadingSettings(false);
    }
  }, [t]);

  useEffect(() => {
    fetchProducts();
    fetchSettings();
  }, [fetchProducts, fetchSettings]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const openCreateDialog = () => {
    setEditingProduct(null);
    setFormData({ ...defaultProductFormData });
    setDialogOpen(true);
  };

  const openEditDialog = (p: HardwareProduct) => {
    setEditingProduct(p);
    setFormData({
      name: p.name,
      nameAr: p.nameAr ?? '',
      nameFr: p.nameFr ?? '',
      description: p.description ?? '',
      descriptionAr: p.descriptionAr ?? '',
      descriptionFr: p.descriptionFr ?? '',
      category: p.category,
      basePrice: p.basePrice,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
    });
    setDialogOpen(true);
  };

  const openDeleteDialog = (p: HardwareProduct) => {
    setDeleteTarget(p);
  };

  const handleSaveProduct = async () => {
    if (!formData.name.trim() || !formData.category.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    setSavingProduct(true);
    try {
      const payload = {
        name: formData.name.trim(),
        nameAr: formData.nameAr.trim() || null,
        nameFr: formData.nameFr.trim() || null,
        description: formData.description.trim() || null,
        descriptionAr: formData.descriptionAr.trim() || null,
        descriptionFr: formData.descriptionFr.trim() || null,
        category: formData.category,
        basePrice: Number(formData.basePrice) || 0,
        isActive: formData.isActive,
        sortOrder: Number(formData.sortOrder) || 0,
      };

      const url = editingProduct
        ? `/api/admin/hardware/${editingProduct.id}`
        : '/api/admin/hardware';
      const method = editingProduct ? 'PATCH' : 'POST';

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success(editingProduct ? t('hardwareProductUpdated') : t('hardwareProductCreated'));
        setDialogOpen(false);
        fetchProducts();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingProduct(false);
    }
  };

  const handleDeleteProduct = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/admin/hardware/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('hardwareProductDeleted'));
        setDeleteTarget(null);
        fetchProducts();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleProductActive = async (p: HardwareProduct, next: boolean) => {
    // Optimistic UI update — revert on failure
    const prev = products;
    setProducts((list) => list.map((x) => (x.id === p.id ? { ...x, isActive: next } : x)));
    try {
      const res = await apiFetch(`/api/admin/hardware/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
        setProducts(prev);
      }
    } catch {
      toast.error(t('error'));
      setProducts(prev);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/admin/hardware/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hardwareEnabled: settingsDraft.hardwareEnabled,
          upfrontDiscount: Number(settingsDraft.upfrontDiscount) || 0,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setSettings(data.settings);
          setSettingsDraft({
            hardwareEnabled: data.settings.hardwareEnabled,
            upfrontDiscount: data.settings.upfrontDiscount,
          });
        }
        toast.success(t('hardwareSettingsSaved'));
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleToggleTierActive = async (tier: CommitmentTier, next: boolean) => {
    // Optimistic UI update
    const prev = tiers;
    setTiers((list) => list.map((x) => (x.id === tier.id ? { ...x, isActive: next } : x)));
    try {
      const res = await apiFetch(`/api/admin/hardware/commitment-tiers/${tier.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
        setTiers(prev);
      }
    } catch {
      toast.error(t('error'));
      setTiers(prev);
    }
  };

  const startEditTier = (tier: CommitmentTier) => {
    setTierEditId(tier.id);
    setTierEditValue(tier.extraPercentage);
  };

  const cancelEditTier = () => {
    setTierEditId(null);
    setTierEditValue(0);
  };

  const saveEditTier = async (tier: CommitmentTier) => {
    setSavingTierId(tier.id);
    try {
      const res = await apiFetch(`/api/admin/hardware/commitment-tiers/${tier.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraPercentage: Number(tierEditValue) || 0 }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.tier) {
          setTiers((list) => list.map((x) => (x.id === tier.id ? { ...x, extraPercentage: data.tier.extraPercentage } : x)));
        }
        toast.success(t('commitmentTierUpdated'));
        cancelEditTier();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingTierId(null);
    }
  };

  const settingsDirty =
    settings &&
    (settingsDraft.hardwareEnabled !== settings.hardwareEnabled ||
      Number(settingsDraft.upfrontDiscount) !== settings.upfrontDiscount);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl bg-white/20 hover:bg-white/30 text-white"
                onClick={() => setView('admin-dashboard')}
              >
                <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
              </Button>
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  <Monitor className="h-6 w-6" />
                  {t('hardwareManagement')}
                </h1>
                <p className="text-sm text-emerald-100 mt-0.5">{t('hardwareSettings')}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-xl bg-white/20 hover:bg-white/30 text-white"
                onClick={() => {
                  fetchProducts();
                  fetchSettings();
                }}
                disabled={loadingProducts || loadingSettings}
              >
                <RefreshCw className={`h-4 w-4 ${loadingProducts || loadingSettings ? 'animate-spin' : ''}`} />
              </Button>
              <Button
                className="bg-white/20 hover:bg-white/30 text-white border-white/30 backdrop-blur-sm gap-2 rounded-xl"
                onClick={openCreateDialog}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('addProduct')}</span>
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ─── Section A: Hardware Settings ──────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <Settings className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <CardTitle className="text-base">{t('hardwareSettings')}</CardTitle>
                <CardDescription className="text-xs">{t('hardwareEnabled')}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingSettings || !settings ? (
              <Skeleton className="h-24 rounded-xl" />
            ) : (
              <>
                <div className="flex items-center justify-between gap-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center">
                      <Monitor className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('hardwareEnabled')}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {settingsDraft.hardwareEnabled ? t('active') : t('inactive')}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={settingsDraft.hardwareEnabled}
                    onCheckedChange={(v) => setSettingsDraft((d) => ({ ...d, hardwareEnabled: v }))}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 p-4 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40 flex items-center justify-center">
                      <Crown className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('upfrontDiscount')}</p>
                      <p className="text-[11px] text-muted-foreground">%</p>
                    </div>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={settingsDraft.upfrontDiscount}
                    onChange={(e) => setSettingsDraft((d) => ({ ...d, upfrontDiscount: parseInt(e.target.value) || 0 }))}
                    className="w-28 text-end"
                  />
                </div>

                <div className="flex justify-end">
                  <Button
                    onClick={handleSaveSettings}
                    disabled={savingSettings || !settingsDirty}
                    className="gap-2 rounded-xl"
                  >
                    {savingSettings ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {t('save')}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Section B: Hardware Products ──────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <Cpu className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div>
                  <CardTitle className="text-base">{t('hardwareProducts')}</CardTitle>
                  <CardDescription className="text-xs">
                    {products.length} {t('hardwareProducts').toLowerCase()}
                  </CardDescription>
                </div>
              </div>
              <Button size="sm" onClick={openCreateDialog} className="gap-2 rounded-xl">
                <Plus className="h-4 w-4" />
                <span className="hidden sm:inline">{t('addProduct')}</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {loadingProducts ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-xl" />
                ))}
              </div>
            ) : products.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <div className="h-14 w-14 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-3">
                  <Cpu className="h-7 w-7 text-gray-400" />
                </div>
                <p className="text-sm font-medium text-foreground">{t('noHardwareProducts')}</p>
                <Button className="mt-3 gap-2 rounded-xl" onClick={openCreateDialog}>
                  <Plus className="h-4 w-4" />
                  {t('addProduct')}
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto -mx-2">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[180px]">{t('productName')}</TableHead>
                      <TableHead className="min-w-[100px]">{t('category')}</TableHead>
                      <TableHead className="min-w-[110px]">{t('basePrice')}</TableHead>
                      <TableHead className="min-w-[90px]">{t('active')}</TableHead>
                      <TableHead className="min-w-[110px] text-end">{t('actions')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <AnimatePresence mode="popLayout">
                      {products.map((p) => {
                        const Icon = categoryIcon(p.category);
                        return (
                          <motion.tr
                            key={p.id}
                            layout
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="hover:bg-muted/40"
                          >
                            <TableCell>
                              <div className="flex items-center gap-2.5">
                                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                                  <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground truncate">
                                    {getLocalizedProductName(p, lang)}
                                  </p>
                                  {p.description && (
                                    <p className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                                      {p.description}
                                    </p>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-[10px]">
                                {translateCategory(p.category, t)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm font-medium text-foreground">
                                {p.basePrice.toLocaleString()} DZD
                              </span>
                            </TableCell>
                            <TableCell>
                              <Switch
                                checked={p.isActive}
                                onCheckedChange={(v) => handleToggleProductActive(p, v)}
                                aria-label={t('active')}
                              />
                            </TableCell>
                            <TableCell className="text-end">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 rounded-lg"
                                  onClick={() => openEditDialog(p)}
                                  aria-label={t('editProduct')}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 rounded-lg text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  onClick={() => openDeleteDialog(p)}
                                  aria-label={t('deleteProduct')}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </motion.tr>
                        );
                      })}
                    </AnimatePresence>
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Section C: Commitment Tiers ──────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.15 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                <CalendarClock className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <CardTitle className="text-base">{t('commitmentTiers')}</CardTitle>
                <CardDescription className="text-xs">{t('extraPercentage')}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loadingSettings ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-xl" />
                ))}
              </div>
            ) : tiers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <CalendarClock className="h-10 w-10 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">{t('noDataYet')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {tiers.map((tier) => {
                  const isEditing = tierEditId === tier.id;
                  const isSaving = savingTierId === tier.id;
                  return (
                    <div
                      key={tier.id}
                      className="rounded-xl border border-border/60 bg-white dark:bg-gray-900/40 p-4 transition-all hover:shadow-sm"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                            <CalendarClock className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-foreground">
                              {getLocalizedTierLabel(tier, lang)}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {tier.months} {t('months')}
                            </p>
                          </div>
                        </div>
                        <Switch
                          checked={tier.isActive}
                          onCheckedChange={(v) => handleToggleTierActive(tier, v)}
                          aria-label={t('active')}
                        />
                      </div>

                      <Separator className="my-2" />

                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {t('extraPercentage')}
                          </p>
                          {isEditing ? (
                            <div className="flex items-center gap-1.5 mt-1">
                              <Input
                                type="number"
                                min={0}
                                max={100}
                                value={tierEditValue}
                                onChange={(e) => setTierEditValue(parseInt(e.target.value) || 0)}
                                className="h-8 w-20 text-sm"
                                disabled={isSaving}
                              />
                              <span className="text-xs text-muted-foreground">%</span>
                            </div>
                          ) : (
                            <p className="text-sm font-bold text-foreground mt-0.5">
                              {tier.extraPercentage}%
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {isEditing ? (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-lg"
                                onClick={() => saveEditTier(tier)}
                                disabled={isSaving}
                                aria-label={t('save')}
                              >
                                {isSaving ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 rounded-lg"
                                onClick={cancelEditTier}
                                disabled={isSaving}
                                aria-label={t('cancel')}
                              >
                                <X className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 gap-1.5 rounded-lg"
                              onClick={() => startEditTier(tier)}
                            >
                              <Pencil className="h-3 w-3" />
                              {t('edit')}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Create / Edit Product Dialog ─────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {editingProduct ? (
                <>
                  <Pencil className="h-5 w-5 text-amber-600" />
                  {t('editProduct')}
                </>
              ) : (
                <>
                  <Plus className="h-5 w-5 text-emerald-600" />
                  {t('addProduct')}
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {editingProduct ? t('editProduct') : t('addProduct')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Basic info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('productName')} *</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="TV 32-inch, Kiosk Stand..."
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('category')} *</Label>
                <Select
                  value={formData.category}
                  onValueChange={(v) => setFormData({ ...formData, category: v })}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder={t('category')} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('productNameAr')}</Label>
                <Input
                  value={formData.nameAr}
                  onChange={(e) => setFormData({ ...formData, nameAr: e.target.value })}
                  placeholder="الاسم بالعربية"
                  dir="rtl"
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('productNameFr')}</Label>
                <Input
                  value={formData.nameFr}
                  onChange={(e) => setFormData({ ...formData, nameFr: e.target.value })}
                  placeholder="Nom en français"
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Description */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('description')}</Label>
                <Input
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('description')}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('descriptionFr')}</Label>
                <Input
                  value={formData.descriptionFr}
                  onChange={(e) => setFormData({ ...formData, descriptionFr: e.target.value })}
                  placeholder="Description en français"
                  className="h-9 text-sm"
                />
              </div>
            </div>

            {/* Pricing & meta */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('basePrice')} (DZD)</Label>
                <Input
                  type="number"
                  min={0}
                  value={formData.basePrice}
                  onChange={(e) => setFormData({ ...formData, basePrice: parseInt(e.target.value) || 0 })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('sortOrder')}</Label>
                <Input
                  type="number"
                  min={0}
                  value={formData.sortOrder}
                  onChange={(e) => setFormData({ ...formData, sortOrder: parseInt(e.target.value) || 0 })}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t('active')}</Label>
                <div className="flex items-center h-9">
                  <Switch
                    checked={formData.isActive}
                    onCheckedChange={(v) => setFormData({ ...formData, isActive: v })}
                  />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="rounded-xl">
              {t('cancel')}
            </Button>
            <Button
              onClick={handleSaveProduct}
              disabled={savingProduct}
              className="rounded-xl gap-2"
            >
              {savingProduct ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {editingProduct ? t('save') : t('addProduct')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation Dialog ───────────────────────────────────── */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              {t('deleteProduct')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmDeleteProduct')}
              {deleteTarget && (
                <span className="font-semibold text-foreground">
                  {' '}
                  {getLocalizedProductName(deleteTarget, lang)}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="rounded-xl">{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProduct}
              disabled={deleting}
              className="rounded-xl gap-2 bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
