'use client';

/**
 * AgencyEmployees — Employee management (0.6.77 full rebuild).
 *
 * Design contract (fixes the "icons too big for the buttons / cramped rows"
 * report):
 *   • Responsive member-card GRID (md:2 / xl:3 columns) instead of a single
 *     cramped list row where 4 unlabeled h-8 w-8 icon buttons squeezed the
 *     name column to nothing.
 *   • Actions live in ONE labelled overflow menu (DropdownMenu) + a full-size
 *     labelled active Switch — every control has an aria-label and a ≥36px
 *     hit area; nothing is icon-only-without-a-name anymore.
 *   • Light stat cards with proper proportions; toolbar search/filter inline.
 *
 * All API interactions (staff CRUD, branch binding, plan cap meter, cache
 * paint) and every dialog are preserved verbatim from the previous
 * implementation (Tasks 31/37-e/45, 0.6.49/0.6.51).
 */

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/store/use-app-store';
// 0.6.16 — revalidate view data when the app resumes to the foreground
import { useResumeRefresh } from '@/lib/resume-refresh';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  Eye,
  EyeOff,
  RefreshCw,
  Loader2,
  Shield,
  UserCheck,
  UserX,
  Dices,
  KeyRound,
  Lock,
  MoreVertical,
  Building2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  StaffPermissionsEditor,
  parsePermissions,
  DEFAULT_PERMISSIONS,
  type StaffPermissions,
} from '@/components/shared/staff-permissions-editor';
import { useAgencyAuthority, MANAGER_TIER_DEFAULTS } from '@/hooks/use-agency-authority';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch } from '@/lib/api-fetch';
import { unwrapListPayload } from '@/lib/list-payload';
import { apiClient } from '@/lib/api-client';

interface Employee {
  id: string;
  userId: string;
  username: string;
  fullName: string;
  // 0.6.98 — agent-transliterated display names (empty until filled).
  fullNameAr?: string | null;
  fullNameFr?: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
  permissions?: Record<string, boolean>;
  /** UID-0.6.14 — immutable account identifier. */
  uid?: string | null;
}

interface BranchOption {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
}

/**
 * 0.6.49 — shared row mapper for the network payload AND the cache paint:
 * both sources go through the exact same transform, so the instant cache
 * paint renders objects identical in shape to the ones the revalidation
 * will land (no remount/flicker when fresh data replaces painted data).
 */
function mapStaffRows(rows: unknown[]): Employee[] {
  return (rows as Record<string, any>[]).map((s) => ({
    id: s.id,
    userId: s.userId,
    username: s.user?.username ?? '',
    fullName: s.user?.fullName ?? '',
    // 0.6.98 — localized display names ride along (GET /agency/staff).
    fullNameAr: s.user?.fullNameAr ?? null,
    fullNameFr: s.user?.fullNameFr ?? null,
    role: s.role === 'OWNER' ? 'AGENCY_OWNER' : s.role === 'MANAGER' ? 'AGENCY_MANAGER' : s.role,
    isActive: s.isActive ?? s.user?.isActive ?? true,
    createdAt: s.joinedAt ?? s.user?.createdAt ?? new Date().toISOString(),
    permissions: s.permissions ?? {},
    uid: s.user?.uid ?? null,
  }));
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
  let pwd = '';
  for (let i = 0; i < 10; i++) {
    pwd += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pwd;
}

// Task 37-e: the 5 manager-tier authorities the owner can grant in the
// create/edit dialogs — mirrored by the checkboxes of the shared
// StaffPermissionsEditor. Keys match the backend's normalized columns.
const MANAGER_AUTHORITIES: { key: keyof StaffPermissions; labelKey: string }[] = [
  { key: 'canCreateBranches', labelKey: 'authorityCreateBranches' },
  { key: 'canDeleteBranches', labelKey: 'authorityDeleteBranches' },
  { key: 'canPurchaseSubscription', labelKey: 'authorityMakePurchase' },
  { key: 'canManageSubscription', labelKey: 'authorityManageSubscription' },
  { key: 'canManageProfile', labelKey: 'authorityProfileSettings' },
];

export function AgencyEmployees() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const agencyId = user?.agencyId || '';
  // 0.6.16 — resume revalidation nonce (see lib/resume-refresh.ts).
  const [resumeNonce, setResumeNonce] = useState(0);
  useResumeRefresh(() => setResumeNonce((n) => n + 1));
  // Task 37-e: the employees page is OWNER territory — staff/manager sessions
  // get an owner-only empty state (the ViewRouter gate already redirects, this
  // is the direct-navigation belt-and-braces).
  const { authority } = useAgencyAuthority();

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
  // Task 37-e: manager authority grants — ALL CHECKED (tier defaults) so the
  // owner can simply untick what they don't want to grant.
  const [newPermissions, setNewPermissions] = useState<StaffPermissions>({ ...MANAGER_TIER_DEFAULTS });
  // Task 31 bug 8: a staff account must be associated with a branch
  const [newBranchId, setNewBranchId] = useState('');
  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchError, setBranchError] = useState(false);
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
  // Task 37-e: the existing editPermissions state (shared with the per-worker
  // permissions dialog below) doubles as the edit dialog's authority editor —
  // seeded by openEdit() from the member's stored grants.
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

  // 0.6.77 — per-row busy flags for the switch (the old code had none, so a
  // slow toggle left the Switch free to double-fire).
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);

  const fetchEmployees = useCallback(async () => {
    if (!agencyId) {
      setEmployees([]);
      setLoading(false);
      return;
    }
    // 0.6.49 — instant paint from the ApiClient GET-cache: navigating back
    // to Employees repaints the last known staff list immediately; the
    // network below (ETag revalidate via cache-1) silently corrects it.
    // Nothing cached → previous skeleton behavior.
    let paintedFromCache = false;
    const cachedStaff = apiClient.peekCache(`/api/agency/staff?agencyId=${encodeURIComponent(agencyId)}`);
    if (cachedStaff) {
      const cachedRows = unwrapListPayload(cachedStaff.data, ['staff']);
      if (Array.isArray(cachedRows)) {
        setEmployees(mapStaffRows(cachedRows));
        setLoading(false);
        paintedFromCache = true;
      }
    }
    if (!paintedFromCache) setLoading(true);
    try {
      const res = await apiFetch(`/api/agency/staff?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        // Map nested user object to flat fields — backend returns { staff: [{ user: {...}, ... }] }
        // Task 45 root cause: apiClient's parseResponse auto-unwrap collapses
        // the local dual envelope { success, staff, data } to the RAW ARRAY —
        // `data.staff` on an array was always undefined (empty staff list on
        // desktop). Accept every envelope outcome.
        setEmployees(mapStaffRows(unwrapListPayload(data, ['staff'])));
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
    // resumeNonce — 0.6.16: refetch when the app resumes to the foreground.
  }, [fetchEmployees, resumeNonce]);

  // Task 31 bug 8: load the agency's branches when the create dialog opens so
  // the staff member can be associated with one at creation time.
  const fetchBranchOptions = useCallback(async () => {
    if (!agencyId) return;
    setBranchesLoading(true);
    try {
      const res = await apiFetch(`/api/agency/branches?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        // Cloud returns { branches }, local API historically { data } — accept both.
        // Task 45 root cause: the local dual envelope arrives UNWRAPPED as a
        // raw array (see list-payload.ts) — accept every outcome.
        const list: any[] = unwrapListPayload(data, ['branches', 'data']);
        setBranchOptions(
          list.map((b) => ({ id: b.id, name: b.name, nameAr: b.nameAr, nameFr: b.nameFr }))
        );
      }
    } catch {
      // silent — empty list renders an empty select and submit validation guards
    } finally {
      setBranchesLoading(false);
    }
  }, [agencyId]);

  useEffect(() => {
    if (createOpen) {
      fetchBranchOptions();
    }
  }, [createOpen, fetchBranchOptions]);

  // Task 37-e: staff count meter — resolve the current plan's maxStaff from
  // GET /api/agency/subscription (availablePlans + currentPlan, same pattern
  // as agency-settings' capacity cap). null = unknown → no meter; -1 = unlimited.
  const [planMaxStaff, setPlanMaxStaff] = useState<number | null>(null);
  const fetchPlanStaffCap = useCallback(async () => {
    try {
      const params = agencyId ? `?agencyId=${encodeURIComponent(agencyId)}` : '';
      const res = await apiFetch(`/api/agency/subscription${params}`);
      if (res.ok) {
        const data = await res.json();
        const plans: Array<{ name?: string; maxStaff?: number }> = data.availablePlans ?? [];
        const current = String(data.currentPlan ?? '').toUpperCase();
        const match = plans.find((p) => (p.name ?? '').toUpperCase() === current);
        setPlanMaxStaff(typeof match?.maxStaff === 'number' ? match.maxStaff : null);
      }
    } catch {
      // silent — the meter simply doesn't render; the server still gates create
    }
  }, [agencyId]);

  useEffect(() => {
    fetchPlanStaffCap();
  }, [fetchPlanStaffCap]);

  // Stats
  const totalEmployees = employees.length;
  const activeEmployees = employees.filter((e) => e.isActive).length;
  const inactiveEmployees = totalEmployees - activeEmployees;
  const managerCount = employees.filter((e) => e.role === 'AGENCY_MANAGER' || e.role === 'MANAGER').length;

  // Filter
  const filtered = employees.filter((e) => {
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
    // Task 31 bug 8: a staff account must belong to a branch — block submit.
    if (!newBranchId) {
      setBranchError(true);
      toast.error(t('staffBranchRequired'));
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
          branchId: newBranchId,
          // Task 37-e: manager authority grants overlay the tier defaults
          // server-side; STAFF needs no authority payload (queue + analytics
          // are automatic).
          ...(newRole === 'MANAGER' ? { permissions: newPermissions } : {}),
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
        setNewPermissions({ ...MANAGER_TIER_DEFAULTS });
        setNewBranchId('');
        setBranchError(false);
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
          // Task 37-e: MANAGER members carry the authority editor's state —
          // the server overlays it on the (possibly re-applied) tier defaults.
          ...(editRole === 'MANAGER' ? { permissions: editPermissions } : {}),
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
    setTogglingUserId(emp.userId);
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
    } finally {
      setTogglingUserId(null);
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
    // Task 37-e: seed the authority editor from the member's stored grants.
    const permStr = emp.permissions ? JSON.stringify(emp.permissions) : null;
    setEditPermissions(parsePermissions(permStr));
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

  // Task 37-e: plan staff-cap — when the active roster reaches the plan's
  // maxStaff the Add button locks (the server's 403 PLAN_LIMIT_REACHED stays
  // the authoritative gate).
  const staffCapReached =
    planMaxStaff !== null && planMaxStaff !== -1 && activeEmployees >= planMaxStaff;

  // Task 37-e: OWNER-only content guard — a staff/manager that reaches this
  // view directly (deep link / stale view) gets an explicit empty state.
  if (user?.role === 'AGENCY_STAFF' && authority && !authority.isOwner) {
    return (
      <div className="p-4 md:p-6 max-w-7xl mx-auto pb-28 lg:pb-10">
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardContent className="p-10 text-center">
            <Shield className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-foreground">{t('ownerOnlySection')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('employeeManagementDesc' as any)}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5 pb-28 lg:pb-10">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="space-y-2 min-w-0">
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
        <Skeleton className="h-12 rounded-xl" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const stats = [
    { label: t('employeeTotal' as any), value: totalEmployees, icon: Users, tint: 'bg-emerald-500' },
    { label: t('employeeActive' as any), value: activeEmployees, icon: UserCheck, tint: 'bg-teal-500' },
    { label: t('employeeInactive' as any), value: inactiveEmployees, icon: UserX, tint: 'bg-gray-400' },
    { label: t('employeeManagers' as any), value: managerCount, icon: Shield, tint: 'bg-amber-500' },
  ];

  return (
    <div className="relative p-4 md:p-6 max-w-7xl mx-auto space-y-5 pb-28 lg:pb-10">
      {/* Gradient top border */}
      <div className="absolute top-0 start-0 end-0 h-[3px] bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 rounded-full" />

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20 flex-shrink-0">
            <Users className="h-6 w-6 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('employeeManagement')}</h1>
            <p className="text-sm text-muted-foreground mt-0.5 truncate">{t('employeeManagementDesc' as any)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Task 37-e: staff count meter — "X / N staff" (or unlimited) */}
          {planMaxStaff !== null && (
            <div
              className={`hidden sm:flex items-center gap-1.5 px-3 h-10 rounded-xl border text-xs font-medium ${
                staffCapReached
                  ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-400'
                  : 'border-border bg-muted/40 text-muted-foreground'
              }`}
              title={staffCapReached ? t('staffLimitReached') : undefined}
            >
              <Users className="h-3.5 w-3.5" />
              {planMaxStaff === -1
                ? t('staffUnlimited', { x: String(activeEmployees) })
                : t('staffMeter', { x: String(activeEmployees), n: String(planMaxStaff) })}
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                onClick={fetchEmployees}
                className="h-10 w-10 rounded-xl"
                aria-label={t('refresh')}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('refresh')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className={staffCapReached ? 'cursor-not-allowed' : ''}>
                <Button
                  onClick={() => setCreateOpen(true)}
                  disabled={staffCapReached}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 rounded-xl h-10 shadow-lg shadow-emerald-500/20"
                >
                  <UserPlus className="h-4 w-4" />
                  <span className="hidden sm:inline">{t('createStaffAccount')}</span>
                  <span className="sm:hidden">{t('addStaff')}</span>
                </Button>
              </div>
            </TooltipTrigger>
            {staffCapReached && (
              <TooltipContent className="max-w-[240px]">{t('staffLimitReached')}</TooltipContent>
            )}
          </Tooltip>
        </div>
      </div>

      {/* ── Stats — light cards with room to breathe ── */}
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
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 h-full">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`h-11 w-11 rounded-xl ${stat.tint} bg-opacity-10 flex items-center justify-center flex-shrink-0`}>
                    <Icon className={`h-5 w-5 ${stat.tint.replace('bg-', 'text-')}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-2xl font-black text-foreground leading-none">{stat.value}</p>
                    <p className="text-[11px] text-muted-foreground font-medium mt-1 truncate">{stat.label}</p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* ── Search & filter toolbar ── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('searchEmployees' as any)}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9 h-11 rounded-xl"
            aria-label={t('searchEmployees' as any)}
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-full sm:w-44 h-11 rounded-xl" aria-label={t('staffRoleSelect')}>
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

      {/* ── Employee card grid ── */}
      {filtered.length === 0 ? (
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
          <CardContent className="p-10 text-center">
            <Users className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">{t('noEmployeesFound' as any)}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((emp, idx) => {
            const isOwner = emp.role === 'AGENCY_OWNER';
            return (
              <motion.div
                key={emp.userId}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.03, 0.25) }}
                layout
              >
                <Card className={`border-0 shadow-sm transition-all duration-200 hover:shadow-md h-full ${
                  !emp.isActive ? 'opacity-70 bg-gray-50 dark:bg-gray-900/50' : 'bg-white dark:bg-gray-900/80'
                }`}>
                  <CardContent className="p-4 flex flex-col gap-3">
                    {/* Identity row */}
                    <div className="flex items-start gap-3 min-w-0">
                      <div className={`h-11 w-11 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        emp.isActive
                          ? 'bg-gradient-to-br from-emerald-400 to-teal-500'
                          : 'bg-gradient-to-br from-gray-400 to-gray-500'
                      }`}>
                        <span className="text-sm font-bold text-white">
                          {(emp.fullName || '').split(' ').map((n) => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-sm text-foreground truncate min-w-0" title={emp.fullName || '?'}>
                            {/* 0.6.98 — localized display name (agent-transliterated) with base fallback. */}
                            {(lang === 'ar' && emp.fullNameAr ? emp.fullNameAr : lang === 'fr' && emp.fullNameFr ? emp.fullNameFr : emp.fullName) || '?'}
                          </p>
                          {getRoleBadge(emp.role)}
                          {!emp.isActive && (
                            <Badge variant="outline" className="text-[10px] text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-600">{t('inactive')}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap min-w-0">
                          <span className="truncate" dir="ltr">@{emp.username || '—'}</span>
                          {emp.uid && (
                            <span className="font-mono truncate" dir="ltr">{emp.uid}</span>
                          )}
                          <span className="hidden sm:inline">•</span>
                          <span className="hidden sm:inline">{formatDate(emp.createdAt)}</span>
                        </div>
                      </div>

                      {/* 0.6.77 — ONE labelled overflow menu instead of four
                          unlabeled h-8 icon buttons. */}
                      {!isOwner && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 flex-shrink-0"
                              aria-label={`${t('editStaffMember')} — ${emp.fullName}`}
                            >
                              <MoreVertical className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => openEdit(emp)} className="gap-2">
                              <Pencil className="h-4 w-4 text-muted-foreground" />
                              {t('editStaffMember')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => openPermissions(emp)} className="gap-2">
                              <Lock className="h-4 w-4 text-muted-foreground" />
                              {t('staffPermissions')}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => { setRemoveEmployee(emp); setRemoveOpen(true); }}
                              className="gap-2 text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950/30"
                            >
                              <Trash2 className="h-4 w-4" />
                              {t('removeStaff')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>

                    {/* Footer row — labelled active switch, full size */}
                    {!isOwner && (
                      <div className="pt-2 border-t border-gray-100 dark:border-gray-800/60 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {emp.isActive ? (
                            <UserCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                          ) : (
                            <UserX className="h-4 w-4 text-gray-400 flex-shrink-0" />
                          )}
                          <Label className="text-xs text-muted-foreground whitespace-nowrap">
                            {emp.isActive ? t('active') : t('inactive')}
                          </Label>
                        </div>
                        <div className="flex items-center gap-2">
                          {togglingUserId === emp.userId && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <Switch
                            checked={emp.isActive}
                            onCheckedChange={() => handleToggleActive(emp)}
                            disabled={togglingUserId === emp.userId}
                            aria-label={`${emp.isActive ? t('active') : t('inactive')} — ${emp.fullName}`}
                            className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
                          />
                        </div>
                      </div>
                    )}
                    {isOwner && (
                      <div className="pt-2 border-t border-gray-100 dark:border-gray-800/60 flex items-center gap-2">
                        <Shield className="h-4 w-4 text-amber-500 flex-shrink-0" />
                        <span className="text-xs text-muted-foreground">{t('agencyOwner')}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Create Employee Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setNewUsername(''); setNewFullName(''); setNewPassword(''); setNewRole('STAFF'); setNewPermissions({ ...MANAGER_TIER_DEFAULTS }); setNewBranchId(''); setBranchError(false); } }}>
        <DialogContent className="sm:max-w-lg max-h-[88vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-emerald-600" />
              {t('createStaffAccount')}
            </DialogTitle>
            <DialogDescription>{t('createStaffAccountDesc' as any)}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    aria-label={showPassword ? t('hidePassword') : t('showPassword')}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label className="text-xs">{t('staffBranchLabel')}</Label>
                <Select
                  value={newBranchId || undefined}
                  onValueChange={(v) => { setNewBranchId(v); setBranchError(false); }}
                >
                  <SelectTrigger className="h-11" aria-invalid={branchError}>
                    <SelectValue placeholder={t('staffBranchPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {branchOptions.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        <span className="flex items-center gap-1.5">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          {lang === 'ar' && b.nameAr ? b.nameAr : lang === 'fr' && b.nameFr ? b.nameFr : b.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {branchesLoading && <p className="text-[10px] text-muted-foreground">{t('loading' as any) || '...'}</p>}
                {branchError && (
                  <p className="text-xs text-red-600 dark:text-red-400">{t('staffBranchRequired')}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{t('staffRoleSelect')}</Label>
                <Select value={newRole} onValueChange={(v) => { setNewRole(v); if (v === 'MANAGER') setNewPermissions({ ...MANAGER_TIER_DEFAULTS }); }}>
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
            {/* Task 37-e: manager authorities — defaults to ALL CHECKED (tier
                defaults); the owner unticks what they don't want to grant.
                Plain STAFF get queue + analytics automatically, no editor. */}
            {newRole === 'MANAGER' && (
              <div className="space-y-2">
                <Label className="text-xs">{t('authorities')}</Label>
                <div className="rounded-xl border border-border p-3 space-y-2.5">
                  {MANAGER_AUTHORITIES.map(({ key, labelKey }) => (
                    <label
                      key={key}
                      className="flex items-center gap-3 cursor-pointer select-none"
                    >
                      <Checkbox
                        checked={newPermissions[key]}
                        onCheckedChange={(v) =>
                          setNewPermissions((prev) => ({ ...prev, [key]: v === true }))
                        }
                      />
                      <span className="text-sm text-foreground">{t(labelKey as any)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
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
              <Select value={editRole} onValueChange={(v) => { setEditRole(v); if (v === 'MANAGER' && editEmployee?.role !== 'MANAGER' && editEmployee?.role !== 'AGENCY_MANAGER') setEditPermissions({ ...MANAGER_TIER_DEFAULTS }); }}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="STAFF">{t('staffRoleStaff')}</SelectItem>
                  <SelectItem value="MANAGER">{t('staffRoleManager')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Task 37-e: same authority editor as the create dialog, shown
                when the member's role is (or is being switched to) MANAGER. */}
            {editRole === 'MANAGER' && (
              <div className="pt-1">
                <Label className="text-xs">{t('authorities')}</Label>
                <div className="mt-2 rounded-xl border border-border p-3 space-y-2.5">
                  {MANAGER_AUTHORITIES.map(({ key, labelKey }) => (
                    <label
                      key={key}
                      className="flex items-center gap-3 cursor-pointer select-none"
                    >
                      <Checkbox
                        checked={editPermissions[key]}
                        onCheckedChange={(v) =>
                          setEditPermissions((prev) => ({ ...prev, [key]: v === true }))
                        }
                      />
                      <span className="text-sm text-foreground">{t(labelKey as any)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
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
                  {/* 0.6.77 — guarded initial: an empty fullName used to crash
                      on .charAt(0).toUpperCase() of undefined. */}
                  <span className="text-sm font-bold text-red-700 dark:text-red-400">
                    {(removeEmployee.fullName || '?').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <p className="font-semibold text-sm text-foreground">{removeEmployee.fullName || '?'}</p>
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
