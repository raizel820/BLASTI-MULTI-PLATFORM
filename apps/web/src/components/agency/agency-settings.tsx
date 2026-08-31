'use client';

import { useState, useEffect, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import type { TranslationKeys } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Settings,
  Plus,
  Trash2,
  Edit3,
  Loader2,
  Save,
  Clock,
  Users,
  ChevronDown,
  AlertTriangle,
  LogOut,
  Shield,
  Gauge,
  Info,
  Briefcase,
  Copy,
  RefreshCw,
  CheckCircle2,
  Key,
  MapPin,
  MessageSquare,
  ArrowRight,
  Building2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useAppStore } from '@/store/use-app-store';
import { StaffPermissionsEditor, parsePermissions } from '@/components/shared/staff-permissions-editor';
import { apiFetch } from '@/lib/api-fetch';

interface AgencyService {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  prefix: string;
}

interface AgencySettingsData {
  avgServiceTime: number;
  maxReservations: number;
  isQueueOpen: boolean;
  services: AgencyService[];
  workingHoursStart: string;
  workingHoursEnd: string;
  autoPauseWhenFull: boolean;
  kioskModeEnabled: boolean;
  sponsorSms: boolean;
  smsBalance: number;
}

interface SettingsSection {
  id: string;
  icon: React.ElementType;
  titleKey: string;
  danger?: boolean;
}

const SECTIONS: SettingsSection[] = [
  { id: 'general', icon: Info, titleKey: 'settings' },
  { id: 'hours', icon: Clock, titleKey: 'workingHours' },
  { id: 'services', icon: Settings, titleKey: 'manageServices' },
  { id: 'capacity', icon: Gauge, titleKey: 'queueCapacity' },
  { id: 'staff', icon: Users, titleKey: 'staffManagement' },
  { id: 'branches', icon: MapPin, titleKey: 'branchManagement' },
  { id: 'sms', icon: MessageSquare, titleKey: 'smsBalanceConfig' },
  { id: 'danger', icon: AlertTriangle, titleKey: 'deleteAccount', danger: true },
];

export function AgencySettings() {
  const { user, logout } = useAppStore();
  const { t, lang } = useLanguage();
  const [settings, setSettings] = useState<AgencySettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    general: true,
    hours: true,
    services: true,
    capacity: true,
    staff: false,
    sms: false,
    danger: false,
  });
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const originalSettingsRef = useRef<AgencySettingsData | null>(null);

  // Staff state
  const [staffList, setStaffList] = useState<Array<{ id: string; role: string; joinedAt: string; isActive: boolean; permissions?: string | Record<string, boolean> | null; user: { username: string; fullName: string; role: string; isActive: boolean } }>>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [addStaffLoading, setAddStaffLoading] = useState(false);
  // Create staff form state
  const [newStaffUsername, setNewStaffUsername] = useState('');
  const [newStaffFullName, setNewStaffFullName] = useState('');
  const [newStaffPassword, setNewStaffPassword] = useState('');
  const [newStaffRole, setNewStaffRole] = useState<'STAFF' | 'MANAGER'>('STAFF');

  // Staff credentials dialog state
  const [credentialsDialogOpen, setCredentialsDialogOpen] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{ username: string; password: string } | null>(null);
  const [credentialsCopied, setCredentialsCopied] = useState(false);

  // Edit staff state
  const [editStaffOpen, setEditStaffOpen] = useState(false);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editRole, setEditRole] = useState<'STAFF' | 'MANAGER'>('STAFF');
  const [editStaffLoading, setEditStaffLoading] = useState(false);
  const [editPermissions, setEditPermissions] = useState<ReturnType<typeof parsePermissions> | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState<AgencyService | null>(null);
  const [svcName, setSvcName] = useState('');
  const [svcNameAr, setSvcNameAr] = useState('');
  const [svcNameFr, setSvcNameFr] = useState('');
  const [svcPrefix, setSvcPrefix] = useState('');

  useEffect(() => {
    fetchSettings();
    fetchStaff();
  }, []);

  const fetchStaff = async () => {
    if (!user?.agencyId) return;
    setStaffLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff?agencyId=${user.agencyId}`);
      if (res.ok) {
        const data = await res.json();
        setStaffList(data.staff ?? []);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setStaffLoading(false);
    }
  };

  const resetStaffForm = () => {
    setNewStaffUsername('');
    setNewStaffFullName('');
    setNewStaffPassword('');
    setNewStaffRole('STAFF');
  };

  const openEditStaffDialog = (staff: { id: string; role: string; user: { fullName: string; isActive: boolean }; permissions?: string | Record<string, boolean> | null }) => {
    setEditingStaffId(staff.id);
    setEditFullName(staff.user.fullName);
    setEditIsActive(staff.user.isActive);
    setEditRole(staff.role === 'MANAGER' ? 'MANAGER' : 'STAFF');
    // Parse permissions from string or object
    const permStr = typeof staff.permissions === 'string' ? staff.permissions : staff.permissions ? JSON.stringify(staff.permissions) : null;
    setEditPermissions(parsePermissions(permStr));
    setEditStaffOpen(true);
  };

  const handleUpdateStaff = async () => {
    if (!editingStaffId || !editFullName.trim()) return;
    setEditStaffLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff/${editingStaffId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: editFullName.trim(),
          isActive: editIsActive,
          role: editRole,
          permissions: editPermissions ?? undefined,
        }),
      });
      if (res.ok) {
        toast.success(t('success'));
        setEditStaffOpen(false);
        setEditingStaffId(null);
        fetchStaff();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setEditStaffLoading(false);
    }
  };

  const handleToggleStaffActive = async (staffId: string, currentActive: boolean) => {
    try {
      const res = await apiFetch(`/api/agency/staff/${staffId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentActive }),
      });
      if (res.ok) {
        toast.success(t('success'));
        fetchStaff();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const handleCreateStaff = async () => {
    if (!newStaffUsername.trim() || !newStaffFullName.trim() || !newStaffPassword || !user?.agencyId) return;
    setAddStaffLoading(true);
    try {
      const res = await apiFetch('/api/agency/staff/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyId: user.agencyId,
          username: newStaffUsername.trim(),
          fullName: newStaffFullName.trim(),
          password: newStaffPassword,
          staffRole: newStaffRole,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        // Show credentials dialog instead of just toast
        setCreatedCredentials({
          username: data.staff.user.username,
          password: data.initialPassword,
        });
        setCredentialsCopied(false);
        setCredentialsDialogOpen(true);
        toast.success(t('success'));
        resetStaffForm();
        setAddStaffOpen(false);
        fetchStaff();
      } else {
        const data = await res.json();
        if (res.status === 409) {
          toast.error(t('usernameTaken'));
        } else {
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setAddStaffLoading(false);
    }
  };

  const handleRemoveStaff = async (staffId: string) => {
    if (!user?.agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/staff/${staffId}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('staffRemoved'));
        fetchStaff();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const params = user?.agencyId ? `?agencyId=${user.agencyId}` : '';
      const res = await apiFetch(`/api/agency/settings${params}`);
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        originalSettingsRef.current = JSON.parse(JSON.stringify(data));
        setHasUnsavedChanges(false);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  // Detect unsaved changes
  useEffect(() => {
    if (!settings || !originalSettingsRef.current) return;
    const changed = JSON.stringify(settings) !== JSON.stringify(originalSettingsRef.current);
    setHasUnsavedChanges(changed);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await apiFetch('/api/agency/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, agencyId: user?.agencyId }),
      });
      if (res.ok) {
        toast.success(t('success'));
        originalSettingsRef.current = JSON.parse(JSON.stringify(settings));
        setHasUnsavedChanges(false);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const updateSetting = <K extends keyof AgencySettingsData>(key: K, value: AgencySettingsData[K]) => {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const openAddServiceDialog = () => {
    setEditingService(null);
    setSvcName('');
    setSvcNameAr('');
    setSvcNameFr('');
    setSvcPrefix('');
    setDialogOpen(true);
  };

  const openEditServiceDialog = (svc: AgencyService) => {
    setEditingService(svc);
    setSvcName(svc.name);
    setSvcNameAr(svc.nameAr || '');
    setSvcNameFr(svc.nameFr || '');
    setSvcPrefix(svc.prefix);
    setDialogOpen(true);
  };

  const handleSaveService = async () => {
    if (!svcName.trim() || !svcPrefix.trim()) {
      toast.error(t('requiredField'));
      return;
    }

    try {
      const url = editingService
        ? `/api/agency/services/${editingService.id}`
        : '/api/agency/services';
      const method = editingService ? 'PATCH' : 'POST';

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: svcName.trim(),
          nameAr: svcNameAr.trim() || undefined,
          nameFr: svcNameFr.trim() || undefined,
          prefix: svcPrefix.trim().toUpperCase(),
        }),
      });

      if (res.ok) {
        toast.success(t('success'));
        setDialogOpen(false);
        fetchSettings();
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const handleDeleteService = async (id: string) => {
    try {
      const res = await apiFetch(`/api/agency/services/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('success'));
        fetchSettings();
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const handleDeleteAccount = async () => {
    if (!user?.id) return;
    setDeleteLoading(true);
    try {
      const res = await apiFetch('/api/user/delete-account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      });
      if (res.ok) {
        toast.success(t('accountDeleted'));
        setDeleteDialogOpen(false);
        logout();
      } else {
        const data = await res.json();
        toast.error(data.error || t('deleteAccountError'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleteLoading(false);
      setDeleteConfirmText('');
    }
  };

  // Custom toggle switch component
  const CustomToggle = ({ checked, onCheckedChange, label, description }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; description?: string }) => (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
        className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors duration-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:ring-offset-2 dark:focus:ring-offset-gray-900 cursor-pointer ${
          checked
            ? 'bg-emerald-500 shadow-inner shadow-emerald-600/30'
            : 'bg-gray-300 dark:bg-gray-600 shadow-inner shadow-gray-400/30'
        }`}
      >
        <span
          className={`pointer-events-none absolute top-[3px] h-5 w-5 rounded-full shadow-md bg-white transition-all duration-300 ease-in-out ${
            checked
              ? 'start-[25px]'
              : 'start-[3px]'
          }`}
        />
      </button>
    </div>
  );

  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4 pb-28">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4 pb-28">
      <h1 className="text-2xl font-bold text-foreground">{t('settings')}</h1>

      {/* Collapsible Settings Sections */}
      {SECTIONS.map((section, sectionIdx) => {
        const Icon = section.icon;
        const isExpanded = expandedSections[section.id] ?? true;
        const isDanger = section.danger;

        return (
          <motion.div
            key={section.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: sectionIdx * 0.04 }}
          >
            <Card className={`border-0 shadow-sm overflow-hidden bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 ${
              isDanger ? 'ring-1 ring-red-200 dark:ring-red-800/50 danger-zone-card' : ''
            }`}>
              {/* Collapsible Header */}
              <button
                onClick={() => toggleSection(section.id)}
                className={`w-full flex items-center justify-between p-4 transition-colors duration-200 text-start ${
                  isDanger
                    ? 'bg-gradient-to-r from-red-50 to-orange-50 dark:from-red-900/10 dark:to-orange-900/10 hover:from-red-100/50 dark:hover:from-red-900/20'
                    : 'hover:bg-gray-50 dark:hover:bg-gray-800/30'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`h-9 w-9 rounded-xl flex items-center justify-center ${
                    isDanger
                      ? 'bg-red-100 dark:bg-red-900/30'
                      : 'bg-emerald-100 dark:bg-emerald-900/30'
                  }`}>
                    <Icon className={`h-4.5 w-4.5 ${
                      isDanger ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                    }`} />
                  </div>
                  <div>
                    <p className={`text-sm font-semibold ${isDanger ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}>
                      {t(section.titleKey as TranslationKeys)}
                    </p>
                    {isDanger && (
                      <p className="text-[10px] text-red-500/70 dark:text-red-400/60">{t('irreversibleActions') || 'Irreversible actions'}</p>
                    )}
                  </div>
                </div>
                <motion.div
                  animate={{ rotate: isExpanded ? 180 : 0 }}
                  transition={{ duration: 0.25, ease: 'easeInOut' }}
                >
                  <ChevronDown className={`h-5 w-5 ${isDanger ? 'text-red-400' : 'text-muted-foreground'}`} />
                </motion.div>
              </button>

              {/* Collapsible Content */}
              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: 'easeInOut' }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4">
                      <Separator className="mb-4" />

                      {/* General Info Section */}
                      {section.id === 'general' && (
                        <div className="space-y-4">
                          <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('generalSettingsDesc') || 'Control your queue availability and basic settings'}</p>
                          <CustomToggle
                            checked={settings?.isQueueOpen ?? false}
                            onCheckedChange={(v) => updateSetting('isQueueOpen', v)}
                            label={settings?.isQueueOpen ? t('queueOpen') : t('queueClosedStatus')}
                            description={settings?.isQueueOpen ? t('openNow') : t('closed')}
                          />
                          <Separator />
                          <CustomToggle
                            checked={settings?.kioskModeEnabled ?? false}
                            onCheckedChange={(v) => updateSetting('kioskModeEnabled', v)}
                            label={t('kioskModeEnabled')}
                            description={t('kioskModeDesc')}
                          />
                        </div>
                      )}

                      {/* Working Hours Section */}
                      {section.id === 'hours' && (
                        <div className="space-y-4">
                          <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('workingHoursDesc' as any) || 'Set your business operating hours'}</p>
                          <Label className="text-sm flex items-center gap-2">
                            <Clock className="h-4 w-4 text-muted-foreground" />
                            {t('workingHours')}
                          </Label>
                          <div className="flex items-center gap-3">
                            <Input
                              type="time"
                              value={settings?.workingHoursStart ?? '08:00'}
                              onChange={(e) => updateSetting('workingHoursStart', e.target.value)}
                              className="h-11 w-32"
                              dir="ltr"
                            />
                            <span className="text-sm text-muted-foreground">—</span>
                            <Input
                              type="time"
                              value={settings?.workingHoursEnd ?? '17:00'}
                              onChange={(e) => updateSetting('workingHoursEnd', e.target.value)}
                              className="h-11 w-32"
                              dir="ltr"
                            />
                          </div>
                        </div>
                      )}

                      {/* Services Section */}
                      {section.id === 'services' && (
                        <div className="space-y-3">
                          <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('servicesDesc') || 'Manage the services your agency offers'}</p>
                          <div className="flex items-center justify-between">
                            <Label className="text-sm flex items-center gap-2">
                              <Briefcase className="h-4 w-4 text-muted-foreground" />
                              {t('services')}
                            </Label>
                            <Button
                              size="sm"
                              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-8 text-xs"
                              onClick={openAddServiceDialog}
                            >
                              <Plus className="h-3.5 w-3.5 me-1" />
                              {t('addService')}
                            </Button>
                          </div>
                          {(settings?.services ?? []).length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
                          ) : (
                            <div className="space-y-2 max-h-72 overflow-y-auto">
                              {settings?.services.map((svc) => (
                                <div
                                  key={svc.id}
                                  className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800/50"
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                                        {svc.prefix}
                                      </span>
                                    </div>
                                    <div>
                                      <p className="text-sm font-medium text-foreground">{svc.name}</p>
                                      {svc.nameAr && (
                                        <p className="text-xs text-muted-foreground">{svc.nameAr}</p>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                      onClick={() => openEditServiceDialog(svc)}
                                    >
                                      <Edit3 className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                                      onClick={() => handleDeleteService(svc.id)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Queue Capacity Section */}
                      {section.id === 'capacity' && (
                        <div className="space-y-5">
                          <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('capacityDesc') || 'Configure queue limits and service timing'}</p>
                          {/* Max Active Reservations */}
                          <div className="space-y-2">
                            <Label className="text-sm flex items-center gap-2">
                              <Users className="h-4 w-4 text-muted-foreground" />
                              {t('maxActiveReservations')}
                            </Label>
                            <p className="text-[11px] text-muted-foreground">{t('maxReservations')}</p>
                            <Input
                              type="number"
                              min={1}
                              max={500}
                              value={settings?.maxReservations ?? 50}
                              onChange={(e) =>
                                updateSetting('maxReservations', parseInt(e.target.value) || 50)
                              }
                              className="h-11 w-40"
                            />
                          </div>

                          <Separator />

                          {/* Auto-Pause Toggle */}
                          <CustomToggle
                            checked={settings?.autoPauseWhenFull ?? false}
                            onCheckedChange={(v) => updateSetting('autoPauseWhenFull', v)}
                            label={t('autoPause')}
                            description={t('autoPauseDesc')}
                          />

                          <Separator />

                          {/* Average Service Time */}
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <Label className="text-sm flex items-center gap-2">
                                <Clock className="h-4 w-4 text-muted-foreground" />
                                {t('avgServiceTime')}
                              </Label>
                              <span className="text-sm font-semibold text-emerald-600">
                                {settings?.avgServiceTime ?? 10} {t('min')}
                              </span>
                            </div>
                            <Slider
                              value={[settings?.avgServiceTime ?? 10]}
                              onValueChange={([v]) => updateSetting('avgServiceTime', v)}
                              min={1}
                              max={60}
                              step={1}
                              className="w-full"
                            />
                          </div>
                        </div>
                      )}

                      {/* Staff Management Section */}
                      {section.id === 'staff' && (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <Label className="text-sm flex items-center gap-2">
                              <Users className="h-4 w-4 text-muted-foreground" />
                              {t('staffList')}
                            </Label>
                            <Dialog open={addStaffOpen} onOpenChange={(open) => { setAddStaffOpen(open); if (!open) resetStaffForm(); }}>
                              <DialogTrigger asChild>
                                <Button
                                  size="sm"
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-8 text-xs"
                                >
                                  <Plus className="h-3.5 w-3.5 me-1" />
                                  {t('createStaffAccount')}
                                </Button>
                              </DialogTrigger>
                              <DialogContent className="sm:max-w-md">
                                <DialogHeader>
                                  <DialogTitle>{t('createStaffAccount')}</DialogTitle>
                                  <DialogDescription className="sr-only">{t('createStaffAccount')}</DialogDescription>
                                </DialogHeader>
                                <div className="space-y-4 py-2">
                                  <div className="space-y-2">
                                    <Label>{t('staffUsername')}</Label>
                                    <Input
                                      value={newStaffUsername}
                                      onChange={(e) => setNewStaffUsername(e.target.value)}
                                      placeholder={t('enterUsername')}
                                      className="h-11"
                                      dir="ltr"
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>{t('staffFullName')}</Label>
                                    <Input
                                      value={newStaffFullName}
                                      onChange={(e) => setNewStaffFullName(e.target.value)}
                                      placeholder={t('staffFullName')}
                                      className="h-11"
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                      <Label>{t('staffInitialPassword')}</Label>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 text-xs text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                                        onClick={() => {
                                          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
                                          let pwd = '';
                                          for (let i = 0; i < 8; i++) {
                                            pwd += chars.charAt(Math.floor(Math.random() * chars.length));
                                          }
                                          setNewStaffPassword(pwd);
                                        }}
                                      >
                                        <RefreshCw className="h-3 w-3 me-1" />
                                        {t('generatePassword')}
                                      </Button>
                                    </div>
                                    <Input
                                      type="text"
                                      value={newStaffPassword}
                                      onChange={(e) => setNewStaffPassword(e.target.value)}
                                      placeholder={t('passwordMinLength')}
                                      className="h-11"
                                      dir="ltr"
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>{t('staffRoleSelect')}</Label>
                                    <Select value={newStaffRole} onValueChange={(v) => setNewStaffRole(v as 'STAFF' | 'MANAGER')}>
                                      <SelectTrigger className="h-11">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="STAFF">{t('staffRoleStaff')}</SelectItem>
                                        <SelectItem value="MANAGER">{t('staffRoleManager')}</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                </div>
                                <DialogFooter>
                                  <Button variant="outline" onClick={() => { setAddStaffOpen(false); resetStaffForm(); }}>
                                    {t('cancel')}
                                  </Button>
                                  <Button
                                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                    onClick={handleCreateStaff}
                                    disabled={addStaffLoading || !newStaffUsername.trim() || !newStaffFullName.trim() || !newStaffPassword}
                                  >
                                    {addStaffLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
                                    {t('submit')}
                                  </Button>
                                </DialogFooter>
                              </DialogContent>
                            </Dialog>
                          </div>
                          {staffLoading ? (
                            <div className="space-y-2">
                              {[...Array(2)].map((_, i) => (
                                <Skeleton key={i} className="h-14 rounded-xl" />
                              ))}
                            </div>
                          ) : staffList.length === 0 ? (
                            <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
                          ) : (
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                              {staffList.map((staff) => {
                                const isOwner = staff.role === 'OWNER';
                                const isUserActive = staff.user.isActive;
                                return (
                                  <motion.div
                                    key={staff.id}
                                    initial={{ opacity: 0.95 }}
                                    animate={{ opacity: 1 }}
                                    className={`flex items-center justify-between p-3 rounded-xl transition-colors hover:bg-gray-100 dark:hover:bg-gray-800/50 ${
                                      !isUserActive ? 'bg-gray-50/50 dark:bg-gray-900/30 opacity-70' : 'bg-gray-50 dark:bg-gray-900/50'
                                    }`}
                                  >
                                    <div className="flex items-center gap-3 min-w-0">
                                      <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                                        isOwner
                                          ? 'bg-amber-100 dark:bg-amber-900/30'
                                          : staff.role === 'MANAGER'
                                            ? 'bg-purple-100 dark:bg-purple-900/30'
                                            : 'bg-emerald-100 dark:bg-emerald-900/30'
                                      }`}>
                                        <Shield className={`h-4.5 w-4.5 ${
                                          isOwner
                                            ? 'text-amber-700 dark:text-amber-400'
                                            : staff.role === 'MANAGER'
                                              ? 'text-purple-700 dark:text-purple-400'
                                              : 'text-emerald-700 dark:text-emerald-400'
                                        }`} />
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                          <p className="text-sm font-medium text-foreground truncate">{staff.user.fullName}</p>
                                          {isOwner && (
                                            <span className="text-[9px] font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full flex-shrink-0">{t('ownerRole')}</span>
                                          )}
                                          {!isOwner && staff.role === 'MANAGER' && (
                                            <span className="text-[9px] font-bold bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400 px-1.5 py-0.5 rounded-full flex-shrink-0">{t('staffRoleManager')}</span>
                                          )}
                                          {!isOwner && staff.role === 'STAFF' && (
                                            <span className="text-[9px] font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded-full flex-shrink-0">{t('staffRoleStaff')}</span>
                                          )}
                                          {!isUserActive && (
                                            <span className="text-[9px] font-bold bg-gray-200 dark:bg-gray-700/60 text-gray-500 dark:text-gray-400 px-1.5 py-0.5 rounded-full flex-shrink-0">{t('inactive')}</span>
                                          )}
                                        </div>
                                        <p className="text-xs text-muted-foreground">@{staff.user.username}</p>
                                        {staff.user.role === 'AGENCY_STAFF' && !isOwner && (
                                          <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-0.5">{t('initialAccountCreated')}</p>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                      <span className="text-[10px] text-muted-foreground hidden sm:inline me-1">
                                        {new Date(staff.joinedAt).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US')}
                                      </span>
                                      {/* Active/Inactive toggle */}
                                      {!isOwner && (
                                        <button
                                          type="button"
                                          role="switch"
                                          aria-checked={isUserActive}
                                          aria-label={isUserActive ? t('active') : t('inactive')}
                                          onClick={() => handleToggleStaffActive(staff.id, isUserActive)}
                                          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:ring-offset-2 dark:focus:ring-offset-gray-900 cursor-pointer ${
                                            isUserActive
                                              ? 'bg-emerald-500 shadow-inner shadow-emerald-600/30'
                                              : 'bg-gray-300 dark:bg-gray-600 shadow-inner shadow-gray-400/30'
                                          }`}
                                        >
                                          <span
                                            className={`pointer-events-none absolute top-[2px] h-5 w-5 rounded-full shadow-md bg-white transition-all duration-300 ease-in-out ${
                                              isUserActive ? 'start-[22px]' : 'start-[2px]'
                                            }`}
                                          />
                                        </button>
                                      )}
                                      {/* Edit button */}
                                      {!isOwner && (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                          onClick={() => openEditStaffDialog(staff)}
                                        >
                                          <Edit3 className="h-3.5 w-3.5" />
                                        </Button>
                                      )}
                                      {/* Delete button */}
                                      {!isOwner && (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                                          onClick={() => handleRemoveStaff(staff.id)}
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                      )}
                                    </div>
                                  </motion.div>
                                );
                              })}
                            </div>
                          )}

                          {/* Staff Credentials Success Dialog */}
                          <Dialog open={credentialsDialogOpen} onOpenChange={(open) => { setCredentialsDialogOpen(open); if (!open) setCreatedCredentials(null); }}>
                            <DialogContent className="sm:max-w-md">
                              <DialogHeader>
                                <DialogTitle className="flex items-center gap-2">
                                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                                  {t('staffAccountCreated')}
                                </DialogTitle>
                                <DialogDescription>{t('credentialsShareHint')}</DialogDescription>
                              </DialogHeader>
                              {createdCredentials && (
                                <div className="space-y-4 py-2">
                                  <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-200 dark:border-emerald-800/30">
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-xs text-muted-foreground">{t('username')}</p>
                                          <p className="text-sm font-semibold text-foreground" dir="ltr">{createdCredentials.username}</p>
                                        </div>
                                      </div>
                                      <div className="h-px bg-emerald-200 dark:bg-emerald-800/30" />
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-xs text-muted-foreground">{t('password')}</p>
                                          <p className="text-sm font-semibold text-foreground" dir="ltr">{createdCredentials.password}</p>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex gap-2">
                                    <Button
                                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                                      onClick={async () => {
                                        const text = `${t('username')}: ${createdCredentials.username}\n${t('password')}: ${createdCredentials.password}`;
                                        try {
                                          await navigator.clipboard.writeText(text);
                                          setCredentialsCopied(true);
                                          toast.success(t('credentialsCopied'));
                                          setTimeout(() => setCredentialsCopied(false), 2000);
                                        } catch {
                                          toast.error(t('error'));
                                        }
                                      }}
                                    >
                                      {credentialsCopied ? (
                                        <>
                                          <CheckCircle2 className="h-4 w-4 me-1" />
                                          {t('copied')}
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="h-4 w-4 me-1" />
                                          {t('copyCredentials')}
                                        </>
                                      )}
                                    </Button>
                                  </div>
                                  <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
                                    {t('credentialsWarning')}
                                  </p>
                                </div>
                              )}
                            </DialogContent>
                          </Dialog>

                          {/* Edit Staff Dialog */}
                          <Dialog open={editStaffOpen} onOpenChange={(open) => { setEditStaffOpen(open); if (!open) setEditingStaffId(null); }}>
                            <DialogContent className="sm:max-w-md">
                              <DialogHeader>
                                <DialogTitle>{t('editStaffMember')}</DialogTitle>
                                <DialogDescription className="sr-only">{t('editStaffMember')}</DialogDescription>
                              </DialogHeader>
                              <div className="space-y-4 py-2">
                                <div className="space-y-2">
                                  <Label>{t('staffFullName')}</Label>
                                  <Input
                                    value={editFullName}
                                    onChange={(e) => setEditFullName(e.target.value)}
                                    placeholder={t('staffFullName')}
                                    className="h-11"
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>{t('staffRoleSelect')}</Label>
                                  <Select value={editRole} onValueChange={(v) => setEditRole(v as 'STAFF' | 'MANAGER')}>
                                    <SelectTrigger className="h-11">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="STAFF">{t('staffRoleStaff')}</SelectItem>
                                      <SelectItem value="MANAGER">{t('staffRoleManager')}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-foreground">{t('status')}</p>
                                    <p className="text-xs text-muted-foreground mt-0.5">{editIsActive ? t('active') : t('inactive')}</p>
                                  </div>
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={editIsActive}
                                    onClick={() => setEditIsActive(!editIsActive)}
                                    className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors duration-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:ring-offset-2 dark:focus:ring-offset-gray-900 cursor-pointer ${
                                      editIsActive
                                        ? 'bg-emerald-500 shadow-inner shadow-emerald-600/30'
                                        : 'bg-gray-300 dark:bg-gray-600 shadow-inner shadow-gray-400/30'
                                    }`}
                                  >
                                    <span
                                      className={`pointer-events-none absolute top-[3px] h-5 w-5 rounded-full shadow-md bg-white transition-all duration-300 ease-in-out ${
                                        editIsActive ? 'start-[25px]' : 'start-[3px]'
                                      }`}
                                    />
                                  </button>
                                </div>
                                {/* Permissions Editor */}
                                {editPermissions && (
                                  <div className="mt-2">
                                    <Separator className="mb-3" />
                                    <p className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
                                      <Shield className="h-4 w-4 text-emerald-600" />
                                      {t('permissions') || 'Permissions'}
                                    </p>
                                    <div className="max-h-64 overflow-y-auto">
                                      <StaffPermissionsEditor
                                        permissions={editPermissions}
                                        onChange={setEditPermissions}
                                        staffRole={editRole}
                                      />
                                    </div>
                                  </div>
                                )}
                              </div>
                              <DialogFooter>
                                <Button variant="outline" onClick={() => { setEditStaffOpen(false); setEditingStaffId(null); }}>
                                  {t('cancel')}
                                </Button>
                                <Button
                                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                                  onClick={handleUpdateStaff}
                                  disabled={editStaffLoading || !editFullName.trim()}
                                >
                                  {editStaffLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
                                  {t('save')}
                                </Button>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                        </div>
                      )}

                      {/* Branches Section */}
                      {section.id === 'branches' && (
                        <div className="space-y-4">
                          <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('branchManagementDesc') || 'Manage your branches, counters, and staff assignments'}</p>
                          <div className="flex flex-col items-center justify-center py-6 text-center">
                            <div className="h-16 w-16 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
                              <Building2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <p className="text-sm font-medium text-foreground mb-1">{t('manageBranchesCounters') || 'Manage Branches & Counters'}</p>
                            <p className="text-xs text-muted-foreground max-w-sm mb-4">{t('branchesFullManageDesc') || 'Create branches, assign counters, and manage staff assignments from the dedicated Branches page.'}</p>
                            <Button
                              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2"
                              onClick={() => {
                                const { setView } = useAppStore.getState();
                                setView('agency-branches');
                              }}
                            >
                              <Building2 className="h-4 w-4" />
                              {t('goToBranches') || 'Go to Branches'}
                              <ArrowRight className="h-4 w-4 rtl:rotate-180" />
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* SMS Configuration Section */}
                      {section.id === 'sms' && (
                        <div className="space-y-4">
                          <p className="text-xs text-muted-foreground -mt-1 mb-2">{t('smsBalanceConfigDesc') || 'Configure SMS settings and balance for your agency'}</p>

                          {/* Sponsor SMS Toggle */}
                          <CustomToggle
                            checked={settings?.sponsorSms ?? false}
                            onCheckedChange={(v) => updateSetting('sponsorSms', v)}
                            label={t('sponsorSms') || 'Sponsor SMS'}
                            description={t('sponsorSmsDesc') || 'Enable SMS sponsorship for customers'}
                          />

                          <Separator />

                          {/* SMS Balance */}
                          <div className="space-y-2">
                            <Label className="text-sm font-medium flex items-center gap-2">
                              <MessageSquare className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                              {t('smsBalanceConfig') || 'SMS Balance'}
                            </Label>
                            <p className="text-[11px] text-muted-foreground">{t('smsBalanceConfigDesc') || 'Number of SMS messages available for the agency'}</p>
                            <div className="flex items-center gap-3">
                              <Input
                                type="number"
                                min={0}
                                value={settings?.smsBalance ?? 0}
                                onChange={(e) => updateSetting('smsBalance', parseInt(e.target.value) || 0)}
                                className="h-11 w-32"
                                dir="ltr"
                              />
                              <span className="text-xs text-muted-foreground">{t('messages')}</span>
                            </div>
                          </div>

                          {/* SMS Balance visual display */}
                          <div className="p-3 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2.5">
                                <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-800/40 flex items-center justify-center flex-shrink-0">
                                  <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                                </div>
                                <div>
                                  <p className="text-sm font-semibold text-foreground">{t('smsBalanceConfig') || 'SMS Balance'}</p>
                                  <p className="text-[11px] text-muted-foreground">{t('availableMessages') || 'Available Messages'}</p>
                                </div>
                              </div>
                              <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                                {settings?.smsBalance ?? 0}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Danger Zone */}
                      {section.id === 'danger' && (
                        <div className="space-y-3">
                          <p className="text-sm text-muted-foreground">{t('deleteAccountDesc')}</p>
                          <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { setDeleteDialogOpen(open); if (!open) setDeleteConfirmText(''); }}>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="outline"
                                className="border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20 rounded-xl h-10"
                              >
                                <Trash2 className="h-4 w-4 me-2" />
                                {t('deleteAccount')}
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="sm:max-w-md">
                              <AlertDialogHeader>
                                <AlertDialogTitle className="flex items-center gap-2 text-red-600">
                                  <AlertTriangle className="h-5 w-5" />
                                  {t('deleteAccount')}
                                </AlertDialogTitle>
                                <AlertDialogDescription className="space-y-3">
                                  <p>{t('deleteAccountDesc')}</p>
                                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                                    <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                                      ⚠️ {t('deleteAccountWarning')}
                                    </p>
                                  </div>
                                  <div className="space-y-2">
                                    <p className="text-sm text-muted-foreground">{t('typeDeleteToConfirm')}</p>
                                    <Input
                                      value={deleteConfirmText}
                                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                                      placeholder={lang === 'ar' ? 'حذف' : lang === 'fr' ? 'supprimer' : 'delete'}
                                      className="h-10"
                                      dir="ltr"
                                    />
                                  </div>
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
                                <AlertDialogCancel className="w-full rounded-xl h-10">
                                  {t('cancel')}
                                </AlertDialogCancel>
                                <Button
                                  onClick={handleDeleteAccount}
                                  disabled={deleteLoading || deleteConfirmText !== (lang === 'ar' ? 'حذف' : lang === 'fr' ? 'supprimer' : 'delete')}
                                  className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
                                >
                                  {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Trash2 className="h-4 w-4 me-2" />}
                                  {t('deleteAccount')}
                                </Button>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </Card>
          </motion.div>
        );
      })}

      {/* Add/Edit Service Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingService ? t('edit') : t('addService')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingService ? t('edit') : t('addService')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('serviceName')} {t('inEnglish')}</Label>
              <Input
                value={svcName}
                onChange={(e) => setSvcName(e.target.value)}
                placeholder={t('serviceNamePlaceholder')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('serviceName')} (العربية)</Label>
              <Input
                value={svcNameAr}
                onChange={(e) => setSvcNameAr(e.target.value)}
                placeholder="استشارة عامة"
                className="h-11"
                dir="rtl"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('serviceName')} (Français)</Label>
              <Input
                value={svcNameFr}
                onChange={(e) => setSvcNameFr(e.target.value)}
                placeholder="Consultation générale"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('servicePrefix')}</Label>
              <Input
                value={svcPrefix}
                onChange={(e) => setSvcPrefix(e.target.value.toUpperCase())}
                placeholder="A"
                className="h-11 w-24"
                maxLength={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleSaveService}
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating Save Button */}
      <AnimatePresence>
        {hasUnsavedChanges && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="fixed bottom-20 inset-x-4 z-40 lg:inset-x-auto lg:start-auto lg:end-6"
          >
            <div className="flex items-center justify-center gap-2">
              {/* Unsaved changes toast */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-medium px-3 py-2 rounded-lg shadow-xl flex items-center gap-2"
              >
                <motion.div
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity , ease: 'easeInOut' }}
                  className="h-2 w-2 rounded-full bg-amber-400"
                />
                {t('unsavedChanges') || 'You have unsaved changes'}
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Save Button - always visible at bottom */}
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="fixed bottom-6 inset-x-4 z-50 lg:inset-x-auto lg:start-auto lg:end-6"
      >
        <div className="max-w-lg mx-auto lg:max-w-none">
          <Button
            onClick={handleSave}
            disabled={saving || !hasUnsavedChanges}
            className={`w-full h-13 font-semibold text-base rounded-2xl shadow-xl transition-all duration-300 flex items-center justify-center gap-2 ${
              hasUnsavedChanges
                ? 'bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 hover:from-emerald-700 hover:via-teal-700 hover:to-emerald-700 text-white shadow-emerald-500/30 hover:shadow-emerald-500/40 hover:scale-[1.01]'
                : 'bg-gray-200 dark:bg-gray-800 text-muted-foreground'
            }`}
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Save className="h-5 w-5" />
            )}
            {t('save')}
            {hasUnsavedChanges && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="h-3 w-3 rounded-full bg-amber-400 inline-block"
              />
            )}
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
