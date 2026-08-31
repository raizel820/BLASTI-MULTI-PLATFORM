'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Users,
  UserPlus,
  Search,
  Pencil,
  Trash2,
  Copy,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  RefreshCw,
  Loader2,
  Shield,
  UserCheck,
  UserX,
  Dices,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Lock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { StaffPermissionsEditor, parsePermissions, DEFAULT_PERMISSIONS } from '@/components/shared/staff-permissions-editor';
import { apiFetch } from '@/lib/api-fetch';

type StaffPermissions = {
  canManageQueue: boolean;
  canManageServices: boolean;
  canManageStaff: boolean;
  canViewAnalytics: boolean;
  canManageBranches: boolean;
  canManageWorkingHours: boolean;
  canExportData: boolean;
  canManageProfile: boolean;
};

interface Employee {
  id: string;
  userId: string;
  username: string;
  fullName: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  permissions?: Record<string, boolean>;
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

export function AgencyEmployees() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const agencyId = user?.agencyId || '';

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('STAFF');
  const [showPassword, setShowPassword] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);

  // Credentials dialog
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState({ username: '', password: '' });

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editRole, setEditRole] = useState('STAFF');
  const [editLoading, setEditLoading] = useState(false);

  // Remove dialog
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeEmployee, setRemoveEmployee] = useState<Employee | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);

  // Permissions dialog
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionsEmployee, setPermissionsEmployee] = useState<Employee | null>(null);
  const [editPermissions, setEditPermissions] = useState<StaffPermissions>({ ...DEFAULT_PERMISSIONS });
  const [permissionsLoading, setPermissionsLoading] = useState(false);

  const fetchEmployees = useCallback(async () => {
    if (!agencyId) {
      setEmployees([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        // Map nested user object to flat fields — backend returns { staff: [{ user: {...}, ... }] }
        setEmployees((data.staff ?? []).map((s: any) => ({
          id: s.id,
          userId: s.userId,
          username: s.user?.username ?? '',
          fullName: s.user?.fullName ?? '',
          role: s.role === 'OWNER' ? 'AGENCY_OWNER' : s.role === 'MANAGER' ? 'AGENCY_MANAGER' : s.role,
          isActive: s.isActive ?? s.user?.isActive ?? true,
          createdAt: s.joinedAt ?? s.user?.createdAt ?? new Date().toISOString(),
          permissions: s.permissions ?? {},
        })));
      } else {
        setEmployees([]);
      }
    } catch {
      toast.error(t('error'));
      setEmployees([]);
    } finally {
      setLoading(false);
    }
  }, [agencyId, t]);

  useEffect(() => {
    fetchEmployees();
  }, [fetchEmployees]);

  // Stats
  const totalEmployees = employees.length;
  const activeEmployees = employees.filter(e => e.isActive).length;
  const inactiveEmployees = totalEmployees - activeEmployees;
  const managerCount = employees.filter(e => e.role === 'AGENCY_MANAGER' || e.role === 'MANAGER').length;

  // Filter
  const filtered = employees.filter(e => {
    const matchSearch = !searchQuery ||
      e.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      e.username.toLowerCase().includes(searchQuery.toLowerCase());
    const matchRole = roleFilter === 'ALL' || e.role === roleFilter;
    return matchSearch && matchRole;
  });

  const handleCreate = async () => {
    if (!newUsername.trim() || !newFullName.trim() || !newPassword.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    if (newPassword.length < 6) {
      toast.error(t('passwordMinLength'));
      return;
    }
    setCreateLoading(true);
    try {
      const res = await apiFetch('/api/agency/staff/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyId,
          username: newUsername.trim(),
          fullName: newFullName.trim(),
          password: newPassword,
          role: newRole,
        }),
      });
      if (res.ok) {
        toast.success(t('staffAdded'));
        setCreatedCredentials({ username: newUsername.trim(), password: newPassword });
        setCreateOpen(false);
        setNewUsername('');
        setNewFullName('');
        setNewPassword('');
        setNewRole('STAFF');
        setCredentialsOpen(true);
        fetchEmployees();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCreateLoading(false);
    }
  };

  const handleEdit = async () => {
    if (!editEmployee || !editFullName.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    setEditLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff/${editEmployee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: editFullName.trim(),
          role: editRole,
        }),
      });
      if (res.ok) {
        toast.success(t('staffUpdated'));
        setEditOpen(false);
        setEditEmployee(null);
        fetchEmployees();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setEditLoading(false);
    }
  };

  const handleToggleActive = async (emp: Employee) => {
    try {
      const res = await apiFetch(`/api/agency/staff/${emp.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !emp.isActive }),
      });
      if (res.ok) {
        toast.success(emp.isActive ? t('staffDeactivated') : t('staffActivated'));
        fetchEmployees();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const handleRemove = async () => {
    if (!removeEmployee) return;
    setRemoveLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff/${removeEmployee.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('staffRemoved'));
        setRemoveOpen(false);
        setRemoveEmployee(null);
        fetchEmployees();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setRemoveLoading(false);
    }
  };

  const openEdit = (emp: Employee) => {
    setEditEmployee(emp);
    setEditFullName(emp.fullName || '');
    // Backend expects 'STAFF' or 'MANAGER' — convert from normalized role
    setEditRole(emp.role === 'AGENCY_OWNER' ? 'OWNER' : emp.role === 'AGENCY_MANAGER' ? 'MANAGER' : 'STAFF');
    setEditOpen(true);
  };

  const openPermissions = (emp: Employee) => {
    setPermissionsEmployee(emp);
    const permStr = emp.permissions ? JSON.stringify(emp.permissions) : null;
    setEditPermissions(parsePermissions(permStr));
    setPermissionsOpen(true);
  };

  const handleSavePermissions = async () => {
    if (!permissionsEmployee) return;
    setPermissionsLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff/${permissionsEmployee.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: editPermissions }),
      });
      if (res.ok) {
        toast.success(t('permissionsUpdated'));
        setPermissionsOpen(false);
        setPermissionsEmployee(null);
        fetchEmployees();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setPermissionsLoading(false);
    }
  };

  const copyCredentials = () => {
    const text = `${t('username')}: ${createdCredentials.username}\n${t('password')}: ${createdCredentials.password}`;
    navigator.clipboard.writeText(text);
    toast.success(t('copied'));
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '—';
      return d.toLocaleDateString(
        lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
        { year: 'numeric', month: 'short', day: 'numeric' }
      );
    } catch {
      return '—';
    }
  };

  const getRoleBadge = (role: string) => {
    if (role === 'AGENCY_OWNER') {
      return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-[10px]">{t('agencyOwner')}</Badge>;
    }
    if (role === 'MANAGER' || role === 'AGENCY_MANAGER') {
      return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 text-[10px]">{t('staffRoleManager')}</Badge>;
    }
    return <Badge className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-0 text-[10px]">{t('staffRoleStaff')}</Badge>;
  };

  const stats = [
    { label: t('employeeTotal' as any), value: totalEmployees, icon: Users, color: 'from-emerald-500 to-emerald-700', shadow: 'shadow-emerald-500/15' },
    { label: t('employeeActive' as any), value: activeEmployees, icon: UserCheck, color: 'from-teal-500 to-teal-700', shadow: 'shadow-teal-500/15' },
    { label: t('employeeInactive' as any), value: inactiveEmployees, icon: UserX, color: 'from-gray-400 to-gray-600', shadow: 'shadow-gray-500/15' },
    { label: t('employeeManagers' as any), value: managerCount, icon: Shield, color: 'from-amber-500 to-amber-700', shadow: 'shadow-amber-500/15' },
  ];

  if (loading) {
    return (
      <div className="p-4 lg:p-5 space-y-4">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
        <Skeleton className="h-12 rounded-xl" />
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl lg:text-2xl font-bold text-foreground flex items-center gap-2">
            <Users className="h-6 w-6 text-emerald-600" />
            {t('employeeManagement')}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('employeeManagementDesc' as any)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchEmployees}
            className="h-9 w-9"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => setCreateOpen(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 rounded-xl h-10"
          >
            <UserPlus className="h-4 w-4" />
            <span className="hidden sm:inline">{t('createStaffAccount')}</span>
            <span className="sm:hidden">{t('addStaff')}</span>
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((stat, idx) => {
          const Icon = stat.icon;
          return (
            <motion.div
              key={idx}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
            >
              <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${stat.color} p-4 text-white shadow-lg ${stat.shadow}`}>
                <div className="absolute -top-2 -start-2 h-12 w-12 rounded-full bg-white/10 blur-lg" />
                <div className="relative flex items-center justify-between">
                  <div>
                    <div className="h-7 w-7 rounded-lg bg-white/20 flex items-center justify-center mb-2">
                      <Icon className="h-3.5 w-3.5 text-white" />
                    </div>
                    <p className="text-2xl font-black">{stat.value}</p>
                    <p className="text-[10px] text-white/70 font-medium mt-0.5">{stat.label}</p>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Search & Filter */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('searchEmployees' as any)}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="ps-9 h-10"
              />
            </div>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-full sm:w-40 h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t('all')}</SelectItem>
                <SelectItem value="AGENCY_OWNER">{t('agencyOwner')}</SelectItem>
                <SelectItem value="AGENCY_MANAGER">{t('staffRoleManager')}</SelectItem>
                <SelectItem value="STAFF">{t('staffRoleStaff')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Employee List */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardContent className="p-8 text-center">
              <Users className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">{t('noEmployeesFound' as any)}</p>
            </CardContent>
          </Card>
        ) : (
          <AnimatePresence mode="popLayout">
            {filtered.map((emp, idx) => (
              <motion.div
                key={emp.userId}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -200 }}
                transition={{ delay: idx * 0.03 }}
                layout
              >
                <Card className={`border-0 shadow-sm transition-all duration-200 hover:shadow-md ${!emp.isActive ? 'opacity-60' : 'bg-white dark:bg-gray-900/80'}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div className={`h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        emp.isActive
                          ? 'bg-gradient-to-br from-emerald-400 to-teal-500'
                          : 'bg-gradient-to-br from-gray-400 to-gray-500'
                      }`}>
                        <span className="text-sm font-bold text-white">
                          {(emp.fullName || '').split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'}
                        </span>
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm text-foreground truncate">{emp.fullName || '?'}</p>
                          {getRoleBadge(emp.role)}
                          {!emp.isActive && (
                            <Badge variant="outline" className="text-[10px] text-gray-500 border-gray-300">{t('inactive')}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>@{emp.username || '—'}</span>
                          <span className="hidden sm:inline">•</span>
                          <span className="hidden sm:inline">{formatDate(emp.createdAt)}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {/* Toggle Active */}
                        {emp.role !== 'AGENCY_OWNER' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleToggleActive(emp)}
                            title={emp.isActive ? t('staffDeactivated') : t('staffActivated')}
                          >
                            {emp.isActive ? (
                              <UserCheck className="h-4 w-4 text-emerald-600" />
                            ) : (
                              <UserX className="h-4 w-4 text-gray-400" />
                            )}
                          </Button>
                        )}

                        {/* Edit */}
                        {emp.role !== 'AGENCY_OWNER' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => openEdit(emp)}
                            title={t('editStaffMember')}
                          >
                            <Pencil className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}

                        {/* Permissions */}
                        {emp.role !== 'AGENCY_OWNER' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => openPermissions(emp)}
                            title={t('staffPermissions')}
                          >
                            <Lock className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}

                        {/* Remove */}
                        {emp.role !== 'AGENCY_OWNER' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 hover:text-red-500"
                            onClick={() => { setRemoveEmployee(emp); setRemoveOpen(true); }}
                            title={t('removeStaff')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Create Employee Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setNewUsername(''); setNewFullName(''); setNewPassword(''); setNewRole('STAFF'); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-emerald-600" />
              {t('createStaffAccount')}
            </DialogTitle>
            <DialogDescription>{t('createStaffAccountDesc' as any)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-xs">{t('staffUsername')}</Label>
              <Input
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder={t('enterUsername')}
                className="h-11"
                dir="ltr"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('staffFullName')}</Label>
              <Input
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
                placeholder={t('fullName')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('staffInitialPassword')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className="h-11 pe-10"
                    dir="ltr"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute end-1 top-1/2 -translate-y-1/2 h-8 w-8"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
                <Button
                  variant="outline"
                  onClick={() => { setNewPassword(generatePassword()); setShowPassword(true); }}
                  className="h-11 gap-1.5 text-xs"
                  title={t('generatePassword')}
                >
                  <Dices className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('staffRoleSelect')}</Label>
              <Select value={newRole} onValueChange={setNewRole}>
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
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('cancel')}</Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
              onClick={handleCreate}
              disabled={createLoading || !newUsername.trim() || !newFullName.trim() || !newPassword.trim()}
            >
              {createLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              {t('submit')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Credentials Dialog */}
      <Dialog open={credentialsOpen} onOpenChange={setCredentialsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-emerald-600" />
              {t('employeeCredentials' as any)}
            </DialogTitle>
            <DialogDescription>{t('employeeCredentialsDesc' as any)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="p-4 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-200/50 dark:border-emerald-700/30">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-muted-foreground">{t('staffUsername')}</p>
                    <p className="font-mono font-bold text-foreground">{createdCredentials.username}</p>
                  </div>
                </div>
                <div className="h-px bg-emerald-200/50 dark:bg-emerald-700/30" />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] text-muted-foreground">{t('password')}</p>
                    <p className="font-mono font-bold text-foreground">{createdCredentials.password}</p>
                  </div>
                </div>
              </div>
            </div>
            <Button
              onClick={copyCredentials}
              className="w-full bg-emerald-600 hover:bg-emerald-700 text-white gap-2 rounded-xl h-11"
            >
              <Copy className="h-4 w-4" />
              {t('copyCredentials')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Employee Dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => { setEditOpen(open); if (!open) setEditEmployee(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-emerald-600" />
              {t('editStaffMember')}
            </DialogTitle>
            <DialogDescription>{t('editStaffMember')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-xs">{t('staffFullName')}</Label>
              <Input
                value={editFullName}
                onChange={(e) => setEditFullName(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">{t('staffRoleSelect')}</Label>
              <Select value={editRole} onValueChange={setEditRole}>
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
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setEditOpen(false)}>{t('cancel')}</Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
              onClick={handleEdit}
              disabled={editLoading || !editFullName.trim()}
            >
              {editLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {t('save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Remove Employee Dialog */}
      <Dialog open={removeOpen} onOpenChange={(open) => { setRemoveOpen(open); if (!open) setRemoveEmployee(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('removeStaff')}
            </DialogTitle>
            <DialogDescription>{t('removeStaffConfirm')}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            {removeEmployee && (
              <div className="flex items-center gap-3 p-3 rounded-xl bg-red-50 dark:bg-red-900/10">
                <div className="h-10 w-10 rounded-full bg-red-200 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-red-700 dark:text-red-400">
                    {removeEmployee.fullName.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <p className="font-semibold text-sm text-foreground">{removeEmployee.fullName}</p>
                  <p className="text-xs text-muted-foreground">@{removeEmployee.username}</p>
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>{t('cancel')}</Button>
            <Button
              variant="destructive"
              className="gap-1.5"
              onClick={handleRemove}
              disabled={removeLoading}
            >
              {removeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {t('confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Permissions Dialog */}
      <Dialog open={permissionsOpen} onOpenChange={(open) => { setPermissionsOpen(open); if (!open) setPermissionsEmployee(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-emerald-600" />
              {t('staffPermissions')}
            </DialogTitle>
            <DialogDescription>
              {permissionsEmployee ? `${t('managePermissionsFor')} ${permissionsEmployee.fullName}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 max-h-[70vh] overflow-y-auto custom-scrollbar">
            <StaffPermissionsEditor
              permissions={editPermissions}
              onChange={setEditPermissions}
              staffRole={permissionsEmployee?.role}
            />
          </div>
          <div className="flex gap-2 justify-end pt-2 border-t">
            <Button
              variant="outline"
              onClick={() => setPermissionsOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
              onClick={handleSavePermissions}
              disabled={permissionsLoading}
            >
              {permissionsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              {t('savePermissions')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
