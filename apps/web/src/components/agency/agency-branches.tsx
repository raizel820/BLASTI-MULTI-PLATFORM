'use client';

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useAppStore } from '@/store/use-app-store';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  MapPin,
  Plus,
  Monitor,
  Edit3,
  Trash2,
  ChevronDown,
  UserCheck,
  Loader2,
  Building2,
  Star,
  Phone,
  UserX,
  Users,
  Power,
  Crown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';

// Types
interface Branch {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  address?: string | null;
  phone?: string | null;
  isActive: boolean;
  isMain: boolean;
  agencyId: string;
  createdAt: string;
  _count?: { counters: number; staff: number };
}

interface CounterWithStaff {
  id: string;
  number: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  isActive: boolean;
  branchId: string;
  staffId?: string | null;
  staff?: { id: string; user: { fullName: string; username: string } } | null;
  currentReservation?: { id: string; displayNumber: string; status: string } | null;
  currentReservationId?: string | null;
}

interface StaffMember {
  id: string;
  role: string;
  user: { fullName: string; username: string; isActive: boolean };
  branchId?: string | null;
}

export function AgencyBranches() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const agencyId = user?.agencyId;

  // State
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [counters, setCounters] = useState<CounterWithStaff[]>([]);
  const [countersLoading, setCountersLoading] = useState(false);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);

  // Branch dialog
  const [branchDialogOpen, setBranchDialogOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [branchName, setBranchName] = useState('');
  const [branchNameAr, setBranchNameAr] = useState('');
  const [branchNameFr, setBranchNameFr] = useState('');
  const [branchAddress, setBranchAddress] = useState('');
  const [branchPhone, setBranchPhone] = useState('');
  const [branchIsMain, setBranchIsMain] = useState(false);
  const [branchSaving, setBranchSaving] = useState(false);

  // Counter dialog
  const [counterDialogOpen, setCounterDialogOpen] = useState(false);
  const [editingCounter, setEditingCounter] = useState<CounterWithStaff | null>(null);
  const [counterNumber, setCounterNumber] = useState(1);
  const [counterName, setCounterName] = useState('');
  const [counterNameAr, setCounterNameAr] = useState('');
  const [counterNameFr, setCounterNameFr] = useState('');
  const [counterSaving, setCounterSaving] = useState(false);

  // Delete dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingItem, setDeletingItem] = useState<{ type: 'branch' | 'counter'; id: string; name: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Staff assignment
  const [assigningCounterId, setAssigningCounterId] = useState<string | null>(null);

  // Toggle loading states
  const [togglingBranchId, setTogglingBranchId] = useState<string | null>(null);
  const [togglingCounterId, setTogglingCounterId] = useState<string | null>(null);

  const fetchBranches = useCallback(async () => {
    if (!agencyId) return;
    setLoading(true);
    try {
      const res = await apiFetch(`/api/agency/branches?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        setBranches(data.branches || []);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [agencyId, t]);

  const fetchStaff = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/staff?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        setStaffList(data.staff || []);
      }
    } catch {
      // silent
    }
  }, [agencyId]);

  useEffect(() => {
    fetchBranches();
    fetchStaff();
  }, [fetchBranches, fetchStaff]);

  const fetchCounters = useCallback(async (branchId: string) => {
    setCountersLoading(true);
    try {
      const res = await apiFetch(`/api/agency/branches/${branchId}/counters`);
      if (res.ok) {
        const data = await res.json();
        setCounters(data.counters || []);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCountersLoading(false);
    }
  }, [t]);

  const toggleBranchExpand = (branchId: string) => {
    if (expandedBranch === branchId) {
      setExpandedBranch(null);
      setCounters([]);
    } else {
      setExpandedBranch(branchId);
      fetchCounters(branchId);
    }
  };

  // Branch CRUD
  const openCreateBranchDialog = () => {
    setEditingBranch(null);
    setBranchName('');
    setBranchNameAr('');
    setBranchNameFr('');
    setBranchAddress('');
    setBranchPhone('');
    setBranchIsMain(false);
    setBranchDialogOpen(true);
  };

  const openEditBranchDialog = (branch: Branch) => {
    setEditingBranch(branch);
    setBranchName(branch.name);
    setBranchNameAr(branch.nameAr || '');
    setBranchNameFr(branch.nameFr || '');
    setBranchAddress(branch.address || '');
    setBranchPhone(branch.phone || '');
    setBranchIsMain(branch.isMain);
    setBranchDialogOpen(true);
  };

  const handleSaveBranch = async () => {
    if (!agencyId || !branchName.trim()) return;
    setBranchSaving(true);
    try {
      if (editingBranch) {
        const res = await apiFetch(`/api/agency/branches/${editingBranch.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: branchName.trim(),
            nameAr: branchNameAr.trim() || undefined,
            nameFr: branchNameFr.trim() || undefined,
            address: branchAddress.trim() || undefined,
            phone: branchPhone.trim() || undefined,
            isMain: branchIsMain,
          }),
        });
        if (res.ok) {
          toast.success(t('branchUpdated'));
          setBranchDialogOpen(false);
          fetchBranches();
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      } else {
        const res = await apiFetch('/api/agency/branches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agencyId,
            name: branchName.trim(),
            nameAr: branchNameAr.trim() || undefined,
            nameFr: branchNameFr.trim() || undefined,
            address: branchAddress.trim() || undefined,
            phone: branchPhone.trim() || undefined,
            isMain: branchIsMain,
          }),
        });
        if (res.ok) {
          toast.success(t('branchCreated'));
          setBranchDialogOpen(false);
          fetchBranches();
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setBranchSaving(false);
    }
  };

  // Toggle branch active/inactive
  const handleToggleBranchActive = async (branch: Branch) => {
    setTogglingBranchId(branch.id);
    try {
      const res = await apiFetch(`/api/agency/branches/${branch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !branch.isActive }),
      });
      if (res.ok) {
        toast.success(branch.isActive ? t('inactive') : t('active'));
        fetchBranches();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingBranchId(null);
    }
  };

  // Set branch as main
  const handleSetAsMain = async (branch: Branch) => {
    setTogglingBranchId(branch.id);
    try {
      const res = await apiFetch(`/api/agency/branches/${branch.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isMain: true }),
      });
      if (res.ok) {
        toast.success(t('mainBranch'));
        fetchBranches();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingBranchId(null);
    }
  };

  // Toggle counter active/inactive
  const handleToggleCounterActive = async (counter: CounterWithStaff) => {
    setTogglingCounterId(counter.id);
    try {
      const res = await apiFetch(`/api/agency/branches/${counter.branchId}/counters/${counter.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !counter.isActive }),
      });
      if (res.ok) {
        toast.success(counter.isActive ? t('inactive') : t('active'));
        fetchCounters(counter.branchId);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setTogglingCounterId(null);
    }
  };

  // Counter CRUD
  const openCreateCounterDialog = (_branchId: string) => {
    setEditingCounter(null);
    setCounterNumber(counters.length + 1);
    setCounterName('');
    setCounterNameAr('');
    setCounterNameFr('');
    setCounterDialogOpen(true);
  };

  const openEditCounterDialog = (counter: CounterWithStaff) => {
    setEditingCounter(counter);
    setCounterNumber(counter.number);
    setCounterName(counter.name);
    setCounterNameAr(counter.nameAr || '');
    setCounterNameFr(counter.nameFr || '');
    setCounterDialogOpen(true);
  };

  const handleSaveCounter = async () => {
    if (!expandedBranch || !counterName.trim()) return;
    setCounterSaving(true);
    try {
      if (editingCounter) {
        const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters/${editingCounter.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: counterName.trim(),
            nameAr: counterNameAr.trim() || undefined,
            nameFr: counterNameFr.trim() || undefined,
          }),
        });
        if (res.ok) {
          toast.success(t('counterUpdated'));
          setCounterDialogOpen(false);
          fetchCounters(expandedBranch);
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      } else {
        const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            number: counterNumber,
            name: counterName.trim(),
            nameAr: counterNameAr.trim() || undefined,
            nameFr: counterNameFr.trim() || undefined,
          }),
        });
        if (res.ok) {
          toast.success(t('counterCreated'));
          setCounterDialogOpen(false);
          fetchCounters(expandedBranch);
          fetchBranches(); // Refresh counter counts
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCounterSaving(false);
    }
  };

  // Delete
  const openDeleteDialog = (type: 'branch' | 'counter', id: string, name: string) => {
    setDeletingItem({ type, id, name });
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    setDeleteLoading(true);
    try {
      if (deletingItem.type === 'branch') {
        const res = await apiFetch(`/api/agency/branches/${deletingItem.id}`, { method: 'DELETE' });
        if (res.ok) {
          toast.success(t('branchDeleted'));
          fetchBranches();
          if (expandedBranch === deletingItem.id) {
            setExpandedBranch(null);
            setCounters([]);
          }
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      } else {
        const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters/${deletingItem.id}`, { method: 'DELETE' });
        if (res.ok) {
          toast.success(t('counterDeleted'));
          fetchCounters(expandedBranch!);
          fetchBranches();
        } else {
          const data = await res.json();
          toast.error(data.error || t('error'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setDeleteLoading(false);
      setDeleteDialogOpen(false);
      setDeletingItem(null);
    }
  };

  // Staff assignment
  const handleAssignStaff = async (counterId: string, staffId: string | null) => {
    if (!expandedBranch) return;
    setAssigningCounterId(counterId);
    try {
      const res = await apiFetch(`/api/agency/branches/${expandedBranch}/counters/${counterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffId }),
      });
      if (res.ok) {
        toast.success(staffId ? t('assignStaff') : t('unassignStaff'));
        fetchCounters(expandedBranch);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setAssigningCounterId(null);
    }
  };

  // Get localized name
  const getBranchDisplayName = (branch: Branch) => {
    if (lang === 'ar' && branch.nameAr) return branch.nameAr;
    if (lang === 'fr' && branch.nameFr) return branch.nameFr;
    return branch.name;
  };

  const getCounterDisplayName = (counter: CounterWithStaff) => {
    if (lang === 'ar' && counter.nameAr) return counter.nameAr;
    if (lang === 'fr' && counter.nameFr) return counter.nameFr;
    return counter.name;
  };

  // Loading state
  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-36 rounded-lg" />
        </div>
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-24 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4 pb-28">
      {/* Gradient top border */}
      <div className="absolute top-0 start-0 end-0 h-[3px] bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 rounded-full" />

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between gap-4"
      >
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Building2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            {t('branches')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{t('branchesDesc')}</p>
        </div>
        <Button
          className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl shadow-lg shadow-emerald-500/20 gap-2 h-10 px-4"
          onClick={openCreateBranchDialog}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">{t('addBranch')}</span>
          <span className="sm:hidden">{t('addBranch')}</span>
        </Button>
      </motion.div>

      {/* Summary stats */}
      {branches.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="grid grid-cols-3 gap-3"
        >
          <div className="rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 p-3 text-white shadow-lg shadow-emerald-500/15">
            <div className="flex items-center gap-1.5 mb-1">
              <Building2 className="h-3.5 w-3.5 text-emerald-200" />
              <span className="text-[10px] text-emerald-200 font-medium">{t('branches')}</span>
            </div>
            <p className="text-2xl font-black">{branches.length}</p>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-teal-500 to-teal-700 p-3 text-white shadow-lg shadow-teal-500/15">
            <div className="flex items-center gap-1.5 mb-1">
              <Monitor className="h-3.5 w-3.5 text-teal-200" />
              <span className="text-[10px] text-teal-200 font-medium">{t('counters')}</span>
            </div>
            <p className="text-2xl font-black">
              {branches.reduce((sum, b) => sum + (b._count?.counters || 0), 0)}
            </p>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-amber-500 to-amber-700 p-3 text-white shadow-lg shadow-amber-500/15">
            <div className="flex items-center gap-1.5 mb-1">
              <Star className="h-3.5 w-3.5 text-amber-200" />
              <span className="text-[10px] text-amber-200 font-medium">{t('mainBranch')}</span>
            </div>
            <p className="text-2xl font-black">
              {branches.filter(b => b.isMain).length}
            </p>
          </div>
        </motion.div>
      )}

      {/* Branches List */}
      {branches.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-16 text-center"
        >
          <div className="h-20 w-20 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
            <MapPin className="h-10 w-10 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="text-lg font-semibold text-foreground">{t('noBranches')}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm">{t('noBranchesDesc')}</p>
          <Button
            className="mt-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl gap-2"
            onClick={openCreateBranchDialog}
          >
            <Plus className="h-4 w-4" />
            {t('addBranch')}
          </Button>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {branches.map((branch, idx) => {
            const isExpanded = expandedBranch === branch.id;
            return (
              <motion.div
                key={branch.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
              >
                <Card className={`border-0 shadow-sm overflow-hidden transition-all duration-300 ${
                  !branch.isActive
                    ? 'bg-gray-50 dark:bg-gray-900/40 opacity-80 ring-1 ring-gray-200 dark:ring-gray-800'
                    : 'bg-white dark:bg-gray-900/80'
                }`}>
                  {/* Branch Header */}
                  <button
                    onClick={() => toggleBranchExpand(branch.id)}
                    className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors text-start"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        branch.isMain
                          ? 'bg-amber-100 dark:bg-amber-900/30'
                          : branch.isActive
                          ? 'bg-emerald-100 dark:bg-emerald-900/30'
                          : 'bg-gray-100 dark:bg-gray-800/50'
                      }`}>
                        {branch.isMain ? (
                          <Crown className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                        ) : (
                          <Building2 className={`h-5 w-5 ${branch.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-400 dark:text-gray-500'}`} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-foreground truncate">{getBranchDisplayName(branch)}</p>
                          {branch.isMain && (
                            <Badge className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-0 text-[10px] px-1.5 py-0.5 gap-0.5">
                              <Star className="h-3 w-3" />
                              {t('mainBranch')}
                            </Badge>
                          )}
                          {!branch.isActive && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                              <Power className="h-3 w-3 me-0.5" />
                              {t('inactive')}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          {branch.address && (
                            <span className="text-xs text-muted-foreground truncate max-w-48 flex items-center gap-1">
                              <MapPin className="h-3 w-3 flex-shrink-0" />
                              {branch.address}
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {branch._count?.counters || 0} {t('counters')}
                          </span>
                          {branch.phone && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Phone className="h-3 w-3" />
                              {branch.phone}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <motion.div
                      animate={{ rotate: isExpanded ? 180 : 0 }}
                      transition={{ duration: 0.25 }}
                      className="flex-shrink-0"
                    >
                      <ChevronDown className="h-5 w-5 text-muted-foreground" />
                    </motion.div>
                  </button>

                  {/* Expanded Content */}
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

                          {/* Branch Actions Row */}
                          <div className="flex items-center gap-2 mb-4 flex-wrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs rounded-lg gap-1.5"
                              onClick={(e) => { e.stopPropagation(); openEditBranchDialog(branch); }}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                              {t('editBranch')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs text-red-600 hover:text-red-700 border-red-200 dark:border-red-800 rounded-lg gap-1.5"
                              onClick={(e) => { e.stopPropagation(); openDeleteDialog('branch', branch.id, branch.name); }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('deleteBranch')}
                            </Button>
                            {!branch.isMain && branch.isActive && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-xs text-amber-700 hover:text-amber-800 border-amber-200 dark:border-amber-800 rounded-lg gap-1.5"
                                onClick={(e) => { e.stopPropagation(); handleSetAsMain(branch); }}
                                disabled={togglingBranchId === branch.id}
                              >
                                {togglingBranchId === branch.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Crown className="h-3.5 w-3.5" />
                                )}
                                {t('setAsMain')}
                              </Button>
                            )}
                            <div className="flex-1" />

                            {/* Active/Inactive Toggle */}
                            <div className="flex items-center gap-2 me-2">
                              <Label className="text-xs text-muted-foreground">{t('active')}</Label>
                              <Switch
                                checked={branch.isActive}
                                onCheckedChange={() => handleToggleBranchActive(branch)}
                                disabled={togglingBranchId === branch.id}
                                className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
                              />
                              {togglingBranchId === branch.id && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                              )}
                            </div>

                            <Button
                              size="sm"
                              className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg h-8 text-xs gap-1.5"
                              onClick={() => openCreateCounterDialog(branch.id)}
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('addCounter')}
                            </Button>
                          </div>

                          {/* Branch Info Grid */}
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                            {branch.phone && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Phone className="h-3.5 w-3.5" />
                                {branch.phone}
                              </div>
                            )}
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Monitor className="h-3.5 w-3.5" />
                              {branch._count?.counters || 0} {t('counters')}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Users className="h-3.5 w-3.5" />
                              {branch._count?.staff || 0} {t('staffCount')}
                            </div>
                          </div>

                          {/* Counters */}
                          {countersLoading ? (
                            <div className="space-y-2">
                              {[...Array(2)].map((_, i) => (
                                <Skeleton key={i} className="h-14 rounded-xl" />
                              ))}
                            </div>
                          ) : counters.length === 0 ? (
                            <div className="flex flex-col items-center py-8 text-center">
                              <Monitor className="h-8 w-8 text-muted-foreground/50 mb-2" />
                              <p className="text-sm text-muted-foreground">{t('noCounters')}</p>
                              <p className="text-xs text-muted-foreground/70 mt-0.5">{t('noCountersDesc')}</p>
                            </div>
                          ) : (
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                              {counters.map((counter) => (
                                <motion.div
                                  key={counter.id}
                                  layout
                                  initial={{ opacity: 0.95 }}
                                  animate={{ opacity: 1 }}
                                  className={`flex items-center justify-between p-3 rounded-xl transition-colors gap-2 ${
                                    !counter.isActive
                                      ? 'bg-gray-50/50 dark:bg-gray-900/30 opacity-70 ring-1 ring-gray-100 dark:ring-gray-800/50'
                                      : 'bg-gray-50 dark:bg-gray-900/50'
                                  }`}
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                                      counter.isActive
                                        ? 'bg-teal-100 dark:bg-teal-900/30'
                                        : 'bg-gray-100 dark:bg-gray-800/50'
                                    }`}>
                                      <span className={`text-xs font-bold ${
                                        counter.isActive
                                          ? 'text-teal-700 dark:text-teal-400'
                                          : 'text-gray-400 dark:text-gray-500'
                                      }`}>
                                        #{counter.number}
                                      </span>
                                    </div>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium text-foreground truncate">{getCounterDisplayName(counter)}</p>
                                        {!counter.isActive && (
                                          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                                            {t('inactive')}
                                          </Badge>
                                        )}
                                      </div>
                                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                        {counter.staff ? (
                                          <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                                            <UserCheck className="h-3 w-3" />
                                            {counter.staff.user.fullName}
                                          </span>
                                        ) : (
                                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                                            <UserX className="h-3 w-3" />
                                            {t('noStaffAssigned')}
                                          </span>
                                        )}
                                        {counter.currentReservation && (
                                          <span className="text-xs text-amber-600 dark:text-amber-400">
                                            · {t('currentlyServing')}: {counter.currentReservation.displayNumber}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                    {/* Active/Inactive Toggle for Counter */}
                                    <div className="flex items-center gap-1.5">
                                      <Switch
                                        checked={counter.isActive}
                                        onCheckedChange={() => handleToggleCounterActive(counter)}
                                        disabled={togglingCounterId === counter.id}
                                        className="data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600 scale-75 origin-center"
                                      />
                                      {togglingCounterId === counter.id && (
                                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                      )}
                                    </div>
                                    {/* Staff assignment */}
                                    <Select
                                      value={counter.staffId || '__none__'}
                                      onValueChange={(val) => handleAssignStaff(counter.id, val === '__none__' ? null : val)}
                                      disabled={assigningCounterId === counter.id}
                                    >
                                      <SelectTrigger className="h-8 w-8 p-0 border-0 bg-transparent">
                                        <SelectValue>
                                          <UserCheck className="h-4 w-4 text-muted-foreground" />
                                        </SelectValue>
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">{t('unassignStaff')}</SelectItem>
                                        {staffList.filter(s => s.user.isActive).map((s) => (
                                          <SelectItem key={s.id} value={s.id}>
                                            {s.user.fullName}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                      onClick={() => openEditCounterDialog(counter)}
                                    >
                                      <Edit3 className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 p-0 text-red-500 hover:text-red-600"
                                      onClick={() => openDeleteDialog('counter', counter.id, counter.name)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </motion.div>
                              ))}
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
        </div>
      )}

      {/* Create/Edit Branch Dialog */}
      <Dialog open={branchDialogOpen} onOpenChange={setBranchDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-emerald-500" />
              {editingBranch ? t('editBranch') : t('addBranch')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingBranch ? t('editBranch') : t('addBranch')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('branchName')}</Label>
              <Input
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder={t('branchName')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('branchNameAr')}</Label>
              <Input
                value={branchNameAr}
                onChange={(e) => setBranchNameAr(e.target.value)}
                placeholder={t('branchNameAr')}
                className="h-11"
                dir="rtl"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('branchNameFr')}</Label>
              <Input
                value={branchNameFr}
                onChange={(e) => setBranchNameFr(e.target.value)}
                placeholder={t('branchNameFr')}
                className="h-11"
                dir="ltr"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('branchAddress')}</Label>
              <Input
                value={branchAddress}
                onChange={(e) => setBranchAddress(e.target.value)}
                placeholder={t('branchAddress')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('branchPhone')}</Label>
              <Input
                value={branchPhone}
                onChange={(e) => setBranchPhone(e.target.value)}
                placeholder={t('branchPhone')}
                className="h-11"
                dir="ltr"
              />
            </div>
            <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
              <div className="flex items-center gap-2">
                <Crown className="h-4 w-4 text-amber-500" />
                <Label className="cursor-pointer">{t('setAsMain')}</Label>
              </div>
              <Switch
                checked={branchIsMain}
                onCheckedChange={setBranchIsMain}
                className="data-[state=checked]:bg-amber-500 data-[state=unchecked]:bg-gray-300 dark:data-[state=unchecked]:bg-gray-600"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleSaveBranch}
              disabled={branchSaving || !branchName.trim()}
            >
              {branchSaving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Counter Dialog */}
      <Dialog open={counterDialogOpen} onOpenChange={setCounterDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5 text-teal-500" />
              {editingCounter ? t('editCounter') : t('addCounter')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {editingCounter ? t('editCounter') : t('addCounter')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('counterNumber')}</Label>
              <Input
                type="number"
                min={1}
                value={counterNumber}
                onChange={(e) => setCounterNumber(parseInt(e.target.value) || 1)}
                className="h-11 w-28"
                dir="ltr"
                disabled={!!editingCounter}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('counterName')}</Label>
              <Input
                value={counterName}
                onChange={(e) => setCounterName(e.target.value)}
                placeholder={t('counterName')}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('counterNameAr')}</Label>
              <Input
                value={counterNameAr}
                onChange={(e) => setCounterNameAr(e.target.value)}
                placeholder={t('counterNameAr')}
                className="h-11"
                dir="rtl"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('counterNameFr')}</Label>
              <Input
                value={counterNameFr}
                onChange={(e) => setCounterNameFr(e.target.value)}
                placeholder={t('counterNameFr')}
                className="h-11"
                dir="ltr"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCounterDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleSaveCounter}
              disabled={counterSaving || !counterName.trim()}
            >
              {counterSaving ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletingItem?.type === 'branch' ? t('deleteBranch') : t('deleteCounter')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingItem?.type === 'branch'
                ? t('confirmDeleteBranch')
                : t('confirmDeleteCounter')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeletingItem(null)}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700 text-white"
              disabled={deleteLoading}
            >
              {deleteLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
