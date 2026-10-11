'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { translateAuditAction, translateEntityType } from '@/lib/enum-i18n';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Shield,
  Search,
  RefreshCw,
  FileText,
  Download,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Filter,
  Clock,
  User,
  Globe,
  Hash,
  Activity,
  Loader2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: string | null;
  ipAddress: string | null;
  createdAt: string;
  user?: {
    id: string;
    username: string;
    fullName: string;
    role: string;
    avatarUrl: string | null;
  } | null;
}

interface AuditFilters {
  actions: string[];
  entityTypes: string[];
  users: { id: string; username: string; fullName: string }[];
}

/** Color-coded action types: CREATE=green, UPDATE=blue, DELETE=red, LOGIN=purple */
function getActionBadgeColor(action: string): string {
  const a = action.toUpperCase();
  if (a.includes('LOGIN')) return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800';
  if (a.includes('CREATE') || a.includes('REGISTER')) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
  if (a.includes('UPDATE') || a.includes('EDIT')) return 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400 border-sky-200 dark:border-sky-800';
  if (a.includes('DELETE') || a.includes('REMOVE') || a.includes('REJECT') || a.includes('CANCEL')) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800';
  if (a.includes('APPROVE') || a.includes('COMPLETE') || a.includes('SUCCESS')) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800';
  if (a.includes('PAYMENT')) return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800';
  if (a.includes('QUEUE')) return 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 border-teal-200 dark:border-teal-800';
  return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700';
}

function getActionDotColor(action: string): string {
  const a = action.toUpperCase();
  if (a.includes('LOGIN')) return 'bg-purple-500';
  if (a.includes('CREATE') || a.includes('REGISTER')) return 'bg-emerald-500';
  if (a.includes('UPDATE') || a.includes('EDIT')) return 'bg-sky-500';
  if (a.includes('DELETE') || a.includes('REMOVE') || a.includes('REJECT') || a.includes('CANCEL')) return 'bg-red-500';
  if (a.includes('APPROVE') || a.includes('COMPLETE') || a.includes('SUCCESS')) return 'bg-emerald-500';
  if (a.includes('PAYMENT')) return 'bg-amber-500';
  if (a.includes('QUEUE')) return 'bg-teal-500';
  return 'bg-gray-400';
}

export function AdminAuditLogs() {
  const { t, lang } = useLanguage();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [filters, setFilters] = useState<AuditFilters>({ actions: [], entityTypes: [], users: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [actionFilter, setActionFilter] = useState('ALL');
  const [entityFilter, setEntityFilter] = useState('ALL');
  const [userFilter, setUserFilter] = useState('ALL');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [totalLogs, setTotalLogs] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const PAGE_SIZE = 20;

  // Debounced search
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setSearchDebounced(search);
      setPage(1);
    }, 400);
    return () => { if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current); };
  }, [search]);

  // Auto-refresh polling every 30s
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async (isPoll = false) => {
    if (!isPoll) setLoading(true);
    setLoadError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const params = new URLSearchParams();
      if (actionFilter !== 'ALL') params.set('action', actionFilter);
      if (entityFilter !== 'ALL') params.set('entityType', entityFilter);
      if (userFilter !== 'ALL') params.set('userId', userFilter);
      if (searchDebounced.trim()) params.set('search', searchDebounced.trim());
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String((page - 1) * PAGE_SIZE));

      const res = await fetchWithRetry(`/api/admin/audit-logs?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.auditLogs ?? []);
        setTotalLogs(data.total ?? 0);
        if (data.filters) {
          setFilters(data.filters);
        }
      } else {
        setLoadError(true);
        toast.error(t('errorLoadingData'));
      }
    } catch {
      setLoadError(true);
      toast.error(t('errorLoadingData'));
    } finally {
      setLoading(false);
    }
  }, [actionFilter, entityFilter, userFilter, searchDebounced, startDate, endDate, page, t]);

  // Initial fetch + refetch on filter changes
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Auto-refresh polling
  useEffect(() => {
    pollIntervalRef.current = setInterval(() => {
      fetchLogs(true);
    }, 30000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [fetchLogs]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [actionFilter, entityFilter, userFilter, searchDebounced, startDate, endDate]);

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (actionFilter !== 'ALL') params.set('action', actionFilter);
      if (entityFilter !== 'ALL') params.set('entityType', entityFilter);
      if (userFilter !== 'ALL') params.set('userId', userFilter);
      if (searchDebounced.trim()) params.set('search', searchDebounced.trim());
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('limit', '10000');
      params.set('offset', '0');

      const res = await apiFetch(`/api/admin/audit-logs?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const allLogs: AuditEntry[] = data.auditLogs ?? [];

        // Generate CSV
        const headers = ['Timestamp', 'User', 'Action', 'Entity Type', 'Entity ID', 'Details', 'IP Address'];
        const rows = allLogs.map(log => [
          new Date(log.createdAt).toISOString(),
          log.user?.fullName || log.user?.username || 'System',
          log.action,
          log.entityType || '',
          log.entityId || '',
          (log.details || '').replace(/"/g, '""'),
          log.ipAddress || '',
        ]);

        const csvContent = [
          headers.join(','),
          ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `blasti-audit-logs-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t('exportSuccess'));
      } else {
        toast.error(t('exportFailed'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setExporting(false);
    }
  };

  const formatTime = (dateStr: string) => {
    const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';
    return new Date(dateStr).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const totalPages = Math.ceil(totalLogs / PAGE_SIZE);

  // Loading state
  if (loading && logs.length === 0) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 rounded-2xl" />
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (loadError && logs.length === 0) {
    return (
      <div className="p-4 lg:p-6">
        <h1 className="text-2xl font-bold text-foreground mb-5">{t('auditLogsPage')}</h1>
        <Card className="border-0 shadow-sm">
          <CardContent className="py-16">
            <div className="flex flex-col items-center justify-center text-center text-muted-foreground">
              <div className="relative mb-6">
                <div className="absolute inset-0 rounded-full bg-red-400/20 blur-xl" />
                <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-red-50 dark:bg-red-900/20 ring-1 ring-red-200/60 dark:ring-red-800/60">
                  <Shield className="h-9 w-9 text-red-500 dark:text-red-400" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">{t('errorLoadingData')}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px]">{t('errorRetryHint')}</p>
              <Button variant="outline" className="mt-4 gap-2" onClick={() => fetchLogs()}>
                <RefreshCw className="h-4 w-4" />
                {t('tryAgain')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
      >
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Activity className="h-6 w-6 text-emerald-600" />
            {t('auditLogsPage')}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('auditLogsDesc')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={exporting}
            className="h-9 gap-1.5 text-xs rounded-lg"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('exportCsv')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fetchLogs()}
            className="h-9 w-9"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </motion.div>

      {/* Search and Filters */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardContent className="p-4 space-y-3">
            {/* Search bar */}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('searchActions')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="ps-10 h-10"
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                className="h-10 w-10 flex-shrink-0"
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4" />
              </Button>
            </div>

            {/* Expandable filters */}
            <AnimatePresence>
              {showFilters && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                    {/* Action filter */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">{t('filterByAction')}</label>
                      <Select value={actionFilter} onValueChange={setActionFilter}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">{t('allLogs')}</SelectItem>
                          {filters.actions.map((action) => (
                            <SelectItem key={action} value={action}>
                              {action}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Entity type filter */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">{t('filterByEntity')}</label>
                      <Select value={entityFilter} onValueChange={setEntityFilter}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">{t('allLogs')}</SelectItem>
                          {filters.entityTypes.map((entity) => (
                            <SelectItem key={entity} value={entity}>
                              {entity}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* User filter */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">{t('filterByUser')}</label>
                      <Select value={userFilter} onValueChange={setUserFilter}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ALL">{t('allLogs')}</SelectItem>
                          {filters.users.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.fullName || u.username}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Date range */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">{t('filterByDate')}</label>
                      <div className="flex gap-1.5">
                        <Input
                          type="date"
                          value={startDate}
                          onChange={(e) => setStartDate(e.target.value)}
                          className="h-9 text-xs"
                        />
                        <Input
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="h-9 text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Clear filters button */}
                  {(actionFilter !== 'ALL' || entityFilter !== 'ALL' || userFilter !== 'ALL' || startDate || endDate || search) && (
                    <div className="flex items-center justify-end mt-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={() => {
                          setActionFilter('ALL');
                          setEntityFilter('ALL');
                          setUserFilter('ALL');
                          setStartDate('');
                          setEndDate('');
                          setSearch('');
                        }}
                      >
                        <X className="h-3 w-3 me-1" />
                        {t('clearFilters') || 'Clear filters'}
                      </Button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </motion.div>

      {/* Results count */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-medium text-foreground">
            {totalLogs} {t('auditLogs')}
          </span>
          {totalLogs > PAGE_SIZE && (
            <span className="text-[10px] text-muted-foreground">
              ({t('showing') || 'showing'} {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalLogs)} {t('of') || 'of'} {totalLogs})
            </span>
          )}
        </div>
        {/* Auto-refresh indicator */}
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="text-[10px] text-muted-foreground">30s</span>
        </div>
      </div>

      {/* Logs Table / List */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardContent className="p-0">
            {logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <div className="relative mb-6">
                  <div className="absolute inset-0 rounded-full bg-emerald-400/20 blur-xl" />
                  <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/20 ring-1 ring-emerald-200/60 dark:ring-emerald-800/60">
                    <FileText className="h-9 w-9 text-emerald-600 dark:text-emerald-400" />
                  </div>
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">{t('noLogsFound')}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px]">{t('emptyNoAuditLogsDesc')}</p>
              </div>
            ) : (
              <>
                {/* Desktop Table */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 dark:border-gray-800">
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">
                          <div className="flex items-center gap-1"><Clock className="h-3 w-3" />{t('timestamp')}</div>
                        </th>
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">
                          <div className="flex items-center gap-1"><User className="h-3 w-3" />{t('user')}</div>
                        </th>
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">
                          <div className="flex items-center gap-1"><Activity className="h-3 w-3" />{t('action')}</div>
                        </th>
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">
                          <div className="flex items-center gap-1"><Filter className="h-3 w-3" />{t('entity')}</div>
                        </th>
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">
                          <div className="flex items-center gap-1"><Hash className="h-3 w-3" />ID</div>
                        </th>
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">{t('details')}</th>
                        <th className="text-start px-4 py-3 text-xs font-medium text-muted-foreground">
                          <div className="flex items-center gap-1"><Globe className="h-3 w-3" />{t('ipAddress')}</div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log, idx) => (
                        <motion.tr
                          key={log.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: idx * 0.015 }}
                          className="border-b border-gray-50 dark:border-gray-800/50 hover:bg-gray-50/50 dark:hover:bg-gray-800/20 transition-colors"
                        >
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {formatTime(log.createdAt)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="h-7 w-7 rounded-full bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center flex-shrink-0">
                                <span className="text-[9px] font-bold text-emerald-700 dark:text-emerald-400">
                                  {(log.user?.fullName || t('systemLabel')).split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'S'}
                                </span>
                              </div>
                              <span className="text-xs font-medium text-foreground truncate max-w-[120px]">
                                {log.user?.fullName || log.user?.username || t('systemLabel')}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className={`text-[10px] px-2 font-mono ${getActionBadgeColor(log.action)}`}>
                              <span className={`h-1.5 w-1.5 rounded-full me-1.5 ${getActionDotColor(log.action)}`} />
                              {translateAuditAction(log.action, t)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {translateEntityType(log.entityType, t) || '—'}
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-[100px] truncate">
                            {log.entityId || '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-foreground max-w-[200px] truncate">
                            {log.details || '—'}
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-muted-foreground">
                            {log.ipAddress || '—'}
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile List */}
                <div className="lg:hidden space-y-1 p-2 max-h-[500px] overflow-y-auto custom-scrollbar">
                  {logs.map((log, idx) => (
                    <motion.div
                      key={log.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: idx * 0.02 }}
                      className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition-all duration-200"
                    >
                      {/* User avatar */}
                      <div className="h-9 w-9 rounded-full bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center flex-shrink-0 shadow-sm mt-0.5">
                        <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-400">
                          {(log.user?.fullName || t('systemLabel')).split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'S'}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className={`text-[9px] px-1.5 font-mono ${getActionBadgeColor(log.action)}`}>
                            <span className={`h-1.5 w-1.5 rounded-full me-1 ${getActionDotColor(log.action)}`} />
                            {translateAuditAction(log.action, t)}
                          </Badge>
                          {translateEntityType(log.entityType, t) && (
                            <span className="text-[10px] text-muted-foreground bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                              {log.entityType}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-foreground truncate">{log.details || '—'}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                            {log.user?.fullName || log.user?.username || t('systemLabel')}
                          </span>
                          {log.ipAddress && (
                            <>
                              <span className="text-[10px] text-muted-foreground">·</span>
                              <span className="text-[10px] text-muted-foreground font-mono">{log.ipAddress}</span>
                            </>
                          )}
                          <span className="text-[10px] text-muted-foreground">·</span>
                          <span className="text-[10px] text-muted-foreground">{formatTime(log.createdAt)}</span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Pagination */}
      {totalPages > 1 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.15 }}
          className="flex items-center justify-center gap-3 pt-1"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            className="rounded-xl border-emerald-200 dark:border-emerald-800 gap-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t('previous')}
          </Button>
          <div className="flex items-center gap-1">
            {(() => {
              const pages: number[] = [];
              const start = Math.max(1, page - 2);
              const end = Math.min(totalPages, page + 2);
              for (let i = start; i <= end; i++) pages.push(i);
              return pages.map(p => (
                <Button
                  key={p}
                  variant={p === page ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setPage(p)}
                  className={`h-8 w-8 p-0 text-xs rounded-lg ${
                    p === page ? 'bg-emerald-600 text-white hover:bg-emerald-700' : ''
                  }`}
                >
                  {p}
                </Button>
              ));
            })()}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="rounded-xl border-emerald-200 dark:border-emerald-800 gap-1"
          >
            {t('next')}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </motion.div>
      )}

      {/* Date filter card (mobile) */}
      {showFilters && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="lg:hidden"
        >
          <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-medium">{t('filterByDate')}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground">Start</label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">End</label>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="h-9 text-xs"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
