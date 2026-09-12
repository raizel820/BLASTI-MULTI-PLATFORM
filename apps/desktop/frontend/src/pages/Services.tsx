import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { apiFetch } from '@/lib/api-fetch';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

// ─── shadcn/ui components ────────────────────────────────────────────────────
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
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

// ─── Icons ───────────────────────────────────────────────────────────────────
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Search,
  Briefcase,
  Clock,
  Users,
  GripVertical,
  ArrowUp,
  ArrowDown,
  ToggleLeft,
  ToggleRight,
  Settings2,
  Zap,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────
interface Service {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  prefix?: string;
  estimatedWaitMinutes?: number;
  isActive?: boolean;
  capacity?: number;
  order?: number;
  description?: string;
  allowWalkIn?: boolean;
  autoComplete?: boolean;
  branchId?: string;
}

interface ServiceForm {
  name: string;
  nameAr: string;
  nameFr: string;
  prefix: string;
  estimatedWaitMinutes: number;
  isActive: boolean;
  capacity: number;
  description: string;
  allowWalkIn: boolean;
  autoComplete: boolean;
}

const DEFAULT_FORM: ServiceForm = {
  name: '',
  nameAr: '',
  nameFr: '',
  prefix: '',
  estimatedWaitMinutes: 15,
  isActive: true,
  capacity: 50,
  description: '',
  allowWalkIn: true,
  autoComplete: false,
};

// ─── Validation ──────────────────────────────────────────────────────────────
function validateServiceForm(form: ServiceForm, t: (k: string) => string): string | null {
  if (!form.name.trim()) return t('serviceNameRequired') || 'Service name is required';
  if (form.name.trim().length < 2) return t('serviceNameMinLength') || 'Service name must be at least 2 characters';
  if (!form.prefix.trim()) return t('servicePrefixRequired') || 'Service prefix is required';
  if (form.estimatedWaitMinutes < 1 || form.estimatedWaitMinutes > 999)
    return t('serviceDurationRange') || 'Duration must be between 1 and 999 minutes';
  if (form.capacity < 1 || form.capacity > 500)
    return t('serviceCapacityRange') || 'Capacity must be between 1 and 500';
  return null;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function ServicesPage() {
  const { t } = useLanguage();
  const { agencyId } = useAppStore();

  // ── State ──────────────────────────────────────────────────────────────────
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [form, setForm] = useState<ServiceForm>(DEFAULT_FORM);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Fetch services ─────────────────────────────────────────────────────────
  const fetchServices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/agency/services?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        const list = (data.services ?? data.data ?? []) as Service[];
        setServices(list.sort((a, b) => (a.order ?? 999) - (b.order ?? 999)));
      } else {
        toast.error(t('error') || 'Failed to load services');
      }
    } catch {
      toast.error(t('error') || 'Failed to load services');
    } finally {
      setLoading(false);
    }
  }, [agencyId, t]);

  useEffect(() => {
    fetchServices();
  }, [fetchServices]);

  // ── Filtered services ──────────────────────────────────────────────────────
  const filteredServices = useMemo(() => {
    if (!searchQuery.trim()) return services;
    const q = searchQuery.toLowerCase();
    return services.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.nameAr && s.nameAr.includes(q)) ||
        (s.nameFr && s.nameFr.toLowerCase().includes(q)) ||
        (s.prefix && s.prefix.toLowerCase().includes(q))
    );
  }, [services, searchQuery]);

  // ── Active / Inactive counts ───────────────────────────────────────────────
  const activeCount = services.filter((s) => s.isActive !== false).length;
  const inactiveCount = services.filter((s) => s.isActive === false).length;

  // ── Dialog helpers ─────────────────────────────────────────────────────────
  const openCreate = () => {
    setEditingService(null);
    setForm(DEFAULT_FORM);
    setDialogOpen(true);
  };

  const openEdit = (s: Service) => {
    setEditingService(s);
    setForm({
      name: s.name,
      nameAr: s.nameAr || '',
      nameFr: s.nameFr || '',
      prefix: s.prefix || '',
      estimatedWaitMinutes: s.estimatedWaitMinutes || 15,
      isActive: s.isActive !== false,
      capacity: s.capacity || 50,
      description: s.description || '',
      allowWalkIn: s.allowWalkIn !== false,
      autoComplete: s.autoComplete ?? false,
    });
    setDialogOpen(true);
  };

  // ── Save service ───────────────────────────────────────────────────────────
  const handleSave = async () => {
    const validationError = validateServiceForm(form, t);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSaving(true);
    try {
      const url = editingService
        ? `/api/agency/services/${editingService.id}`
        : '/api/agency/services';
      const method = editingService ? 'PATCH' : 'POST';

      const body: Record<string, unknown> = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || undefined,
        nameFr: form.nameFr.trim() || undefined,
        prefix: form.prefix.trim().toUpperCase(),
        estimatedWaitMinutes: form.estimatedWaitMinutes,
        isActive: form.isActive,
        capacity: form.capacity,
        description: form.description.trim() || undefined,
        allowWalkIn: form.allowWalkIn,
        autoComplete: form.autoComplete,
      };

      if (agencyId) body.agencyId = agencyId;

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(t('success') || 'Saved successfully');
        setDialogOpen(false);
        fetchServices();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error') || 'Failed to save service');
      }
    } catch {
      toast.error(t('error') || 'Failed to save service');
    } finally {
      setSaving(false);
    }
  };

  // ── Toggle active ──────────────────────────────────────────────────────────
  const handleToggleActive = async (s: Service) => {
    const newActive = !s.isActive;
    try {
      const res = await apiFetch(`/api/agency/services/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: newActive }),
      });
      if (res.ok) {
        toast.success(newActive ? (t('serviceActivated') || 'Service activated') : (t('serviceDeactivated') || 'Service deactivated'));
        fetchServices();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error') || 'Failed to update service');
      }
    } catch {
      toast.error(t('error') || 'Failed to update service');
    }
  };

  // ── Delete service ─────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch(`/api/agency/services/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('success') || 'Service deleted');
        setDeleteTarget(null);
        fetchServices();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || t('error') || 'Failed to delete service');
      }
    } catch {
      toast.error(t('error') || 'Failed to delete service');
    } finally {
      setDeleting(false);
    }
  };

  // ── Reorder services ───────────────────────────────────────────────────────
  const handleMoveUp = async (index: number) => {
    if (index === 0) return;
    const updated = [...services];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    // Assign new order values
    const reordered = updated.map((s, i) => ({ ...s, order: i }));
    setServices(reordered);
    try {
      await apiFetch('/api/agency/services/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyId,
          order: reordered.map((s) => ({ id: s.id, order: s.order })),
        }),
      });
    } catch {
      toast.error(t('error') || 'Failed to reorder services');
      fetchServices(); // Revert on error
    }
  };

  const handleMoveDown = async (index: number) => {
    if (index === services.length - 1) return;
    const updated = [...services];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    const reordered = updated.map((s, i) => ({ ...s, order: i }));
    setServices(reordered);
    try {
      await apiFetch('/api/agency/services/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyId,
          order: reordered.map((s) => ({ id: s.id, order: s.order })),
        }),
      });
    } catch {
      toast.error(t('error') || 'Failed to reorder services');
      fetchServices();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Briefcase className="w-6 h-6 text-primary" />
            {t('manageServices') || 'Manage Services'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('servicesDesc') || 'Manage the services your agency offers'}
          </p>
        </div>
        <Button
          onClick={openCreate}
          className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg"
        >
          <Plus className="w-4 h-4 me-1.5" />
          {t('addService') || 'Add Service'}
        </Button>
      </motion.div>

      {/* Stats row */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="grid grid-cols-3 gap-4"
      >
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Briefcase className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{services.length}</p>
              <p className="text-xs text-muted-foreground">{t('totalServices') || 'Total Services'}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <ToggleRight className="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{activeCount}</p>
              <p className="text-xs text-muted-foreground">{t('active') || 'Active'}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
              <ToggleLeft className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-2xl font-bold text-foreground">{inactiveCount}</p>
              <p className="text-xs text-muted-foreground">{t('inactive') || 'Inactive'}</p>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Search */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.15 }}
        className="relative"
      >
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('searchServices') || 'Search services...'}
          className="ps-9"
        />
      </motion.div>

      {/* Services list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-medium flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            {t('services') || 'Services'}
            <Badge variant="secondary" className="text-xs">
              {filteredServices.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : filteredServices.length === 0 ? (
            <div className="py-12 text-center">
              <Briefcase className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? (t('noSearchResults') || 'No services match your search')
                  : (t('noServicesYet') || 'No services configured yet')}
              </p>
              {!searchQuery && (
                <Button
                  variant="link"
                  onClick={openCreate}
                  className="text-emerald-600 hover:text-emerald-700 mt-2"
                >
                  {t('addFirstService') || 'Add your first service'}
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border">
              <AnimatePresence mode="popLayout">
                {filteredServices.map((s, idx) => {
                  const globalIdx = services.findIndex((gs) => gs.id === s.id);
                  return (
                    <motion.div
                      key={s.id}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.2, delay: idx * 0.03 }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition-colors group"
                    >
                      {/* Drag handle / Order indicator */}
                      <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 p-0"
                          disabled={globalIdx === 0}
                          onClick={() => handleMoveUp(globalIdx)}
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <GripVertical className="h-3 w-3 text-muted-foreground" />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 p-0"
                          disabled={globalIdx === services.length - 1}
                          onClick={() => handleMoveDown(globalIdx)}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                      </div>

                      {/* Prefix avatar */}
                      <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0">
                        {s.prefix || s.name.charAt(0)}
                      </div>

                      {/* Name & details */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground truncate">
                            {s.name}
                          </p>
                          {s.nameAr && (
                            <span className="text-xs text-muted-foreground truncate" dir="rtl">
                              {s.nameAr}
                            </span>
                          )}
                          {s.nameFr && (
                            <span className="text-xs text-muted-foreground truncate">
                              {s.nameFr}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          {s.prefix && (
                            <span className="text-xs text-muted-foreground">
                              {t('servicePrefix') || 'Prefix'}: {s.prefix}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            <Clock className="inline h-3 w-3 me-0.5" />
                            {s.estimatedWaitMinutes || 15} {t('min') || 'min'}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            <Users className="inline h-3 w-3 me-0.5" />
                            {s.capacity || 50}
                          </span>
                          {s.allowWalkIn !== false && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                              {t('walkIn') || 'Walk-in'}
                            </Badge>
                          )}
                          {s.autoComplete && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                              <Zap className="h-2.5 w-2.5 me-0.5" />
                              {t('autoComplete') || 'Auto'}
                            </Badge>
                          )}
                        </div>
                        {s.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                            {s.description}
                          </p>
                        )}
                      </div>

                      {/* Active toggle */}
                      <Switch
                        checked={s.isActive !== false}
                        onCheckedChange={() => handleToggleActive(s)}
                        aria-label={s.isActive !== false ? 'Deactivate service' : 'Activate service'}
                      />

                      {/* Status badge */}
                      <Badge
                        variant={s.isActive !== false ? 'default' : 'secondary'}
                        className={
                          s.isActive !== false
                            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-200 dark:border-emerald-800'
                            : ''
                        }
                      >
                        {s.isActive !== false ? (t('active') || 'Active') : (t('inactive') || 'Inactive')}
                      </Badge>

                      {/* Actions */}
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(s)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-500 hover:text-red-600"
                          onClick={() => setDeleteTarget(s)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Add/Edit Service Dialog ──────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingService ? (t('edit') || 'Edit Service') : (t('addService') || 'Add Service')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingService ? (t('edit') || 'Edit Service') : (t('addService') || 'Add Service')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Service name (English) */}
            <div className="space-y-2">
              <Label>
                {t('serviceName') || 'Service Name'} ({t('inEnglish') || 'English'}) <span className="text-red-500">*</span>
              </Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('serviceNamePlaceholder') || 'General Consultation'}
                className="h-11"
              />
            </div>

            {/* Service name (Arabic) */}
            <div className="space-y-2">
              <Label>{t('serviceName') || 'Service Name'} (العربية)</Label>
              <Input
                value={form.nameAr}
                onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                placeholder="استشارة عامة"
                className="h-11"
                dir="rtl"
              />
            </div>

            {/* Service name (French) */}
            <div className="space-y-2">
              <Label>{t('serviceName') || 'Service Name'} (Français)</Label>
              <Input
                value={form.nameFr}
                onChange={(e) => setForm({ ...form, nameFr: e.target.value })}
                placeholder="Consultation générale"
                className="h-11"
              />
            </div>

            {/* Prefix + Duration row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>
                  {t('servicePrefix') || 'Queue Number Prefix'} <span className="text-red-500">*</span>
                </Label>
                <Input
                  value={form.prefix}
                  onChange={(e) => setForm({ ...form, prefix: e.target.value.toUpperCase() })}
                  placeholder="A"
                  className="h-11"
                  maxLength={3}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('estServiceTime') || 'Est. Service Time (min)'}</Label>
                <Input
                  type="number"
                  min={1}
                  max={999}
                  value={form.estimatedWaitMinutes}
                  onChange={(e) =>
                    setForm({ ...form, estimatedWaitMinutes: parseInt(e.target.value) || 15 })
                  }
                  className="h-11"
                />
              </div>
            </div>

            {/* Capacity */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                {t('serviceCapacity') || 'Service Capacity'}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('serviceCapacityDesc') || 'Maximum concurrent reservations for this service'}
              </p>
              <Input
                type="number"
                min={1}
                max={500}
                value={form.capacity}
                onChange={(e) =>
                  setForm({ ...form, capacity: parseInt(e.target.value) || 50 })
                }
                className="h-11 w-32"
              />
            </div>

            <Separator />

            {/* Description */}
            <div className="space-y-2">
              <Label>{t('description') || 'Description'}</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={t('serviceDescriptionPlaceholder') || 'Brief description of this service...'}
                rows={3}
                className="resize-none"
              />
            </div>

            <Separator />

            {/* Settings toggles */}
            <div className="space-y-4">
              <Label className="text-sm font-medium flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                {t('serviceSettings') || 'Service Settings'}
              </Label>

              {/* Active toggle */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('active') || 'Active'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('serviceActiveDesc') || 'Enable or disable this service for queuing'}
                  </p>
                </div>
                <Switch
                  checked={form.isActive}
                  onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                />
              </div>

              {/* Allow walk-in */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('allowWalkIn') || 'Allow Walk-in'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('allowWalkInDesc') || 'Allow customers to join without a reservation'}
                  </p>
                </div>
                <Switch
                  checked={form.allowWalkIn}
                  onCheckedChange={(v) => setForm({ ...form, allowWalkIn: v })}
                />
              </div>

              {/* Auto-complete */}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('autoCompleteService') || 'Auto-complete'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('autoCompleteDesc') || 'Automatically mark service as completed after estimated duration'}
                  </p>
                </div>
                <Switch
                  checked={form.autoComplete}
                  onCheckedChange={(v) => setForm({ ...form, autoComplete: v })}
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('cancel') || 'Cancel'}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin me-1.5" />}
              {t('save') || 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Confirmation AlertDialog ──────────────────────────────── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('confirmDeleteService') || 'Delete Service?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('confirmDeleteServiceDesc') || 'Are you sure you want to delete'}
              {deleteTarget && (
                <strong className="text-foreground"> "{deleteTarget.name}" </strong>
              )}
              {t('confirmDeleteServiceEnd') || '? This action cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t('cancel') || 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin me-1.5" />}
              {t('delete') || 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
