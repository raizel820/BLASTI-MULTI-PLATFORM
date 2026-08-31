'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Users,
  Search,
  ShieldCheck,
  UserCircle,
  Loader2,
  Ban,
  CheckCircle2,
  Eye,
  Phone,
  Building2,
  Mail,
  KeyRound,
  Trash2,
  RefreshCw,
} from 'lucide-react';
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
import { motion } from 'framer-motion';
import { humanizeEnum } from '@/lib/enum-i18n';
import { toast } from 'sonner';
import { useDebounce } from '@/hooks/use-debounce';

interface UserItem {
  id: string;
  username: string;
  fullName: string;
  email?: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  phoneNumber?: string;
  agencyName?: string;
}

const roleFilters = [
  { value: '', labelKey: 'all' as const },
  { value: 'CUSTOMER', labelKey: 'customerRole' as const },
  { value: 'AGENCY_OWNER', labelKey: 'agencyOwnerRole' as const },
  { value: 'AGENCY_STAFF', labelKey: 'agencyStaffRole' as const },
  { value: 'SUPER_ADMIN', labelKey: 'adminRole' as const },
];

export function AdminUsers() {
  const { t, lang } = useLanguage();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 400);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const fetchUsers = useCallback(async (targetPage: number, loadMore: boolean) => {
    if (loadMore) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setLoadError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (roleFilter) params.set('role', roleFilter);
      if (statusFilter) params.set('status', statusFilter);
      params.set('page', String(targetPage));
      params.set('limit', String(PAGE_SIZE));

      const res = await fetchWithRetry(`/api/admin/users?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (loadMore) {
          setUsers((prev) => [...prev, ...(data.users ?? [])]);
        } else {
          setUsers(data.users ?? []);
        }
        setTotal(data.total ?? 0);
        setPage(targetPage);
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
      toast.error(t('errorLoadingData'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch, roleFilter, statusFilter, t]);

  useEffect(() => {
    fetchUsers(1, false);
  }, [fetchUsers]);

  const handleLoadMore = () => {
    fetchUsers(page + 1, true);
  };

  const handleToggleStatus = async (userId: string, currentActive: boolean) => {
    setActionLoading(userId);
    try {
      const action = currentActive ? 'suspend' : 'activate';
      const res = await apiFetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action }),
      });
      if (res.ok) {
        toast.success(
          currentActive ? t('suspendUser') : t('activateUser')
        );
        fetchUsers(1, false);
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'SUPER_ADMIN':
        return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200';
      case 'AGENCY_OWNER':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200';
      case 'AGENCY_STAFF':
        return 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400 border-teal-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400 border-gray-200';
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'SUPER_ADMIN': return t('adminRole');
      case 'AGENCY_OWNER': return t('agencyOwnerRole');
      case 'AGENCY_STAFF': return t('agencyStaffRole');
      case 'CUSTOMER': return t('customerRole');
      default: return humanizeEnum(role);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    setActionLoading(userId);
    try {
      const res = await apiFetch('/api/admin/users', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.ok) {
        setDeleteDialogOpen(false);
        setDeleteUserId(null);
        setDeleteConfirmText('');
        toast.success(t('accountDeleted') || 'Account deleted successfully');
        fetchUsers(1, false);
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetPassword = async (userId: string) => {
    setActionLoading(userId);
    try {
      const res = await apiFetch(`/api/admin/users/${userId}/reset-password`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        setResetDialogOpen(false);
        toast.success(`${t('newPasswordIs')}: ${data.newPassword}`, {
          duration: 8000,
        });
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('userManagement')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('totalUsers')}: {total}
          </p>
        </div>
      </div>

      {/* Search & Filters */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
        <CardContent className="p-4 space-y-3">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ps-10 h-11"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {roleFilters.map((f) => (
              <button
                key={f.value}
                onClick={() => setRoleFilter(f.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  roleFilter === f.value
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
                }`}
              >
                {t(f.labelKey)}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStatusFilter('')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === ''
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {t('all')}
            </button>
            <button
              onClick={() => setStatusFilter('active')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === 'active'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {t('active')}
            </button>
            <button
              onClick={() => setStatusFilter('suspended')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === 'suspended'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {t('suspended')}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Users List */}
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : loadError ? (
        <Card className="border-0 shadow-sm">
          <CardContent className="py-16">
            <div className="flex flex-col items-center justify-center text-center text-muted-foreground">
              <div className="relative mb-6">
                <div className="absolute inset-0 rounded-full bg-red-400/20 blur-xl" />
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200/60 dark:ring-red-800/60">
                  <Users className="h-9 w-9 text-red-500 dark:text-red-400" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{t('errorLoadingData')}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px]">{t('errorRetryHint')}</p>
              <Button
                variant="outline"
                className="mt-4 gap-2"
                onClick={() => fetchUsers(1, false)}
              >
                <RefreshCw className="h-4 w-4" />
                {t('tryAgain')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : users.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
          <div className="relative mb-6">
            <div className="absolute inset-0 rounded-full bg-emerald-400/20 blur-xl" />
            <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60">
              <Users className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
            </div>
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">{t('emptyNoUsersTitle')}</h3>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px]">{t('emptyNoUsersDesc')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((user, idx) => (
            <motion.div
              key={user.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: idx * 0.02 }}
            >
              <Card className={`border-0 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 ${
                idx % 2 === 0
                  ? 'bg-white dark:bg-gray-900/80'
                  : 'bg-gray-50/50 dark:bg-gray-900/50'
              } dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={`h-11 w-11 rounded-full flex items-center justify-center shadow-sm ${
                        user.isActive
                          ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40'
                          : 'bg-gradient-to-br from-red-200 to-red-300 dark:from-red-900/40 dark:to-red-800/40'
                      }`}>
                        <UserCircle className={`h-6 w-6 ${
                          user.isActive
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                        }`} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {user.fullName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          @{user.username}
                          {user.email && ` · ${user.email}`}
                        </p>
                        {user.agencyName && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <Building2 className="h-3 w-3 text-emerald-500 flex-shrink-0" />
                            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 truncate">{user.agencyName}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${getRoleBadgeColor(user.role)}`}
                      >
                        {getRoleLabel(user.role)}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={
                          user.isActive
                            ? 'text-[10px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                            : 'text-[10px] bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                        }
                      >
                        {user.isActive ? t('active') : t('suspended')}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                    <span className="text-xs text-muted-foreground">
                      {t('date')}: {formatDate(user.createdAt)}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 rounded-lg text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setExpandedUserId(expandedUserId === user.id ? null : user.id)}
                      >
                        <Eye className="h-3 w-3 me-1" />
                        {expandedUserId === user.id ? t('close') : t('viewProfile')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-lg text-xs border-amber-200 text-amber-600 dark:border-amber-800 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                        onClick={() => {
                          setResetUserId(user.id);
                          setResetDialogOpen(true);
                        }}
                        disabled={actionLoading === user.id || user.role === 'SUPER_ADMIN'}
                      >
                        {actionLoading === user.id ? (
                          <Loader2 className="h-3 w-3 animate-spin me-1" />
                        ) : (
                          <KeyRound className="h-3 w-3 me-1" />
                        )}
                        {t('resetPassword')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className={`h-8 rounded-lg text-xs ${
                          user.isActive
                            ? 'border-red-200 text-red-600 dark:border-red-800 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                            : 'border-emerald-200 text-emerald-600 dark:border-emerald-800 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20'
                        }`}
                        onClick={() => handleToggleStatus(user.id, user.isActive)}
                        disabled={actionLoading === user.id || user.role === 'SUPER_ADMIN'}
                      >
                        {actionLoading === user.id ? (
                          <Loader2 className="h-3 w-3 animate-spin me-1" />
                        ) : user.isActive ? (
                          <Ban className="h-3 w-3 me-1" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3 me-1" />
                        )}
                        {user.isActive ? t('suspendUserFull') : t('reactivateUserFull')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-lg text-xs border-red-300 text-red-600 dark:border-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
                        onClick={() => {
                          setDeleteUserId(user.id);
                          setDeleteConfirmText('');
                          setDeleteDialogOpen(true);
                        }}
                        disabled={actionLoading === user.id || user.role === 'SUPER_ADMIN'}
                      >
                        <Trash2 className="h-3 w-3 me-1" />
                        {t('deleteAccount') || 'Delete'}
                      </Button>
                    </div>
                  </div>

                  {/* Expanded Profile Panel */}
                  {expandedUserId === user.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-3 pt-3 border-t border-border"
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="flex items-center gap-2">
                          <UserCircle className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('username')}</p>
                            <p className="text-sm font-medium text-foreground">@{user.username}</p>
                          </div>
                        </div>
                        {user.fullName && (
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('fullName')}</p>
                              <p className="text-sm font-medium text-foreground">{user.fullName}</p>
                            </div>
                          </div>
                        )}
                        {user.email && (
                          <div className="flex items-center gap-2">
                            <Mail className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('email')}</p>
                              <p className="text-sm font-medium text-foreground">{user.email}</p>
                            </div>
                          </div>
                        )}
                        {user.phoneNumber && (
                          <div className="flex items-center gap-2">
                            <Phone className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('phoneNumber')}</p>
                              <p className="text-sm font-medium text-foreground" dir="ltr">{user.phoneNumber}</p>
                            </div>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('agencyCol')}</p>
                            <p className="text-sm font-medium text-foreground">{user.agencyName || t('noAgency')}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{t('status')}</p>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                user.isActive
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200'
                                  : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200'
                              }`}
                            >
                              {user.isActive ? t('active') : t('suspended')}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}

          {/* Load More Button */}
          {users.length < total && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="rounded-full px-8 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
              >
                {loadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin me-2" />
                ) : null}
                {t('loadMore') || 'Load More'}
                <span className="ms-2 text-xs opacity-70">
                  ({total - users.length} {t('moreUsersRemaining') || 'more users remaining'})
                </span>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Reset Password Confirmation Dialog */}
      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('resetPassword')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('resetPasswordConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => resetUserId && handleResetPassword(resetUserId)}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete User Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={(open) => { setDeleteDialogOpen(open); if (!open) { setDeleteUserId(null); setDeleteConfirmText(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="h-5 w-5" />
              {t('deleteAccount')}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>{t('deleteUserWarning') || 'This action is permanent and cannot be undone. All associated data including reservations, favorites, and notifications will be deleted.'}</p>
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                  ⚠️ {t('irreversibleAction') || 'This is an irreversible action'}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('typeDeleteToConfirm')}</p>
                <Input
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="delete"
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
              onClick={() => deleteUserId && handleDeleteUser(deleteUserId)}
              disabled={actionLoading === deleteUserId || deleteConfirmText !== 'delete'}
              className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl h-10"
            >
              {actionLoading === deleteUserId ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Trash2 className="h-4 w-4 me-2" />}
              {t('deleteAccount')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
