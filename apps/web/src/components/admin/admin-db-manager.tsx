'use client'

/**
 * Admin Database Manager — SUPER_ADMIN PostgreSQL console.
 *
 * Sidebar section "Database Manager" (admin-db view) backed by
 * /api/admin/db/* (apps/api/src/routes/admin-db.ts):
 *
 *   Overview    → database stats (size, version, connections, cache) +
 *                 every table with live row counts + sizes
 *   Table view  → paginated row browser with search, sortable columns,
 *                 JSON row inspector and single-row delete
 *   Maintenance → VACUUM ANALYZE + offline-sync tombstone purge
 *
 * All management actions ask for confirmation (row deletes require typing
 * the table name — a wrong delete on User/SystemSetting is unrecoverable).
 */

import { apiFetch } from '@/lib/api-fetch';
import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
} from '@/components/ui/dialog';
import {
  Database,
  Table2,
  RefreshCw,
  Loader2,
  Search,
  Trash2,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  HardDrive,
  Activity,
  Zap,
  Server,
  ShieldCheck,
  Eye,
  KeyRound,
  Wrench,
  Eraser,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { isRTL, type TranslationKeys } from '@/i18n';

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

// ─── Types ──────────────────────────────────────────────────────────────────

interface TableInfo {
  name: string;
  rowCount: number;
  sizeBytes: number;
  size: string;
}

interface ColumnInfo {
  name: string;
  dataType: string;
}

interface TableData {
  table: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  orderBy: string;
  orderDir: string;
}

interface DbStats {
  version: string;
  fullVersion?: string;
  databaseSize: string;
  databaseSizeBytes: number;
  tableCount: number;
  activeConnections: number;
  transactionsCommitted: number;
  blocksFetched: number;
  cacheHitRatio: number | null;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

/** Compact number: 1,234 → "1.2K", 5,600,000 → "5.6M". */
function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** Render a cell value as short display text. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** True when the column plausibly holds a secret (masked in the table view). */
const SECRET_KEY_RE = /(password|secret|token|apikey|api_key|credential)/i;
function isSecretColumn(name: string): boolean {
  return SECRET_KEY_RE.test(name);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AdminDbManager() {
  const { t, lang } = useLanguage();
  const rtl = isRTL(lang);

  // Overview state
  const [stats, setStats] = useState<DbStats | null>(null);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tableSearch, setTableSearch] = useState('');

  // Table browser state
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [loadingTable, setLoadingTable] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [orderBy, setOrderBy] = useState('createdAt');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('desc');

  // Row inspector
  const [inspectRow, setInspectRow] = useState<Record<string, unknown> | null>(null);

  // Row delete
  const [deleteTarget, setDeleteTarget] = useState<Record<string, unknown> | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Maintenance
  const [vacuuming, setVacuuming] = useState(false);
  const [purging, setPurging] = useState(false);

  // ── Overview fetch ──
  const fetchOverview = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoadingOverview(true);
    try {
      const [statsRes, tablesRes] = await Promise.all([
        apiFetch('/api/admin/db/stats'),
        apiFetch('/api/admin/db/tables'),
      ]);
      const statsBody = await statsRes.json();
      const tablesBody = await tablesRes.json();
      // apiFetch/apiClient UNWRAPS the {success, data} envelope — accept BOTH
      // the unwrapped payload and the full envelope shape.
      const statsData: DbStats | undefined =
        statsBody && typeof statsBody === 'object' && 'databaseSize' in statsBody
          ? statsBody
          : (statsBody as { data?: DbStats })?.data;
      const tablesData: TableInfo[] = Array.isArray(tablesBody)
        ? tablesBody
        : Array.isArray((tablesBody as { data?: unknown[] })?.data)
          ? ((tablesBody as { data: TableInfo[] }).data)
          : [];
      if (statsRes.ok && statsData) setStats(statsData);
      if (tablesRes.ok && tablesData.length > 0) setTables(tablesData);
      if (!statsRes.ok || !tablesRes.ok) {
        toast.error(statsBody?.error || tablesBody?.error || t('dbLoadFailed'));
      }
    } catch {
      toast.error(t('dbLoadFailed'));
    } finally {
      setLoadingOverview(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  // ── Table browser fetch ──
  const fetchTable = useCallback(async (
    table: string,
    opts?: { page?: number; search?: string; orderBy?: string; orderDir?: string }
  ) => {
    setLoadingTable(true);
    try {
      const params = new URLSearchParams({
        page: String(opts?.page ?? page),
        pageSize: String(pageSize),
        search: opts?.search ?? search,
        orderBy: opts?.orderBy ?? orderBy,
        orderDir: opts?.orderDir ?? orderDir,
      });
      const res = await apiFetch(`/api/admin/db/table/${encodeURIComponent(table)}?${params}`);
      const body = await res.json();
      // apiFetch/apiClient UNWRAPS the {success, data} envelope — accept BOTH
      // shapes (unwrapped payload first, envelope second).
      const data: TableData | undefined =
        body && typeof body === 'object' && 'columns' in body
          ? body
          : (body as { data?: TableData })?.data;
      if (res.ok && data) {
        setTableData(data);
      } else {
        toast.error(body?.error || t('dbLoadFailed'));
      }
    } catch {
      toast.error(t('dbLoadFailed'));
    } finally {
      setLoadingTable(false);
    }
  }, [page, pageSize, search, orderBy, orderDir, t]);

  // Fetch only when a DIFFERENT table is opened. Deliberately [activeTable]:
  // fetchTable's identity changes with page/search/sort state, and re-running
  // this effect then would reset every browse to page 1 (the explicit
  // page/search/sort changes below call fetchTable themselves).
  useEffect(() => {
    if (activeTable) {
      fetchTable(activeTable, { page: 1 });
    }
  }, [activeTable]);

  // ── Handlers ──

  const openTable = (name: string) => {
    setActiveTable(name);
    setPage(1);
    setSearch('');
    setSearchInput('');
    setOrderBy('createdAt');
    setOrderDir('desc');
    setTableData(null);
  };

  const closeTable = () => {
    setActiveTable(null);
    setTableData(null);
  };

  const applySearch = () => {
    setSearch(searchInput);
    setPage(1);
    if (activeTable) fetchTable(activeTable, { page: 1, search: searchInput });
  };

  const changePage = (newPage: number) => {
    setPage(newPage);
    if (activeTable) fetchTable(activeTable, { page: newPage });
  };

  const toggleSort = (column: string) => {
    const newDir: 'asc' | 'desc' = orderBy === column && orderDir === 'desc' ? 'asc' : 'desc';
    setOrderBy(column);
    setOrderDir(newDir);
    if (activeTable) fetchTable(activeTable, { orderBy: column, orderDir: newDir });
  };

  const confirmDeleteRow = async () => {
    if (!activeTable || !deleteTarget) return;
    setDeleting(true);
    try {
      const rowId = String(deleteTarget.id ?? '');
      const res = await apiFetch(
        `/api/admin/db/table/${encodeURIComponent(activeTable)}/row/${encodeURIComponent(rowId)}`,
        { method: 'DELETE' }
      );
      const body = await res.json();
      // apiFetch unwraps the {success, data} envelope — res.ok is the source
      // of truth; body.success only exists in the envelope shape.
      if (res.ok && (body?.success !== false)) {
        toast.success(body?.message || t('dbRowDeleted'));
        setDeleteTarget(null);
        // Refresh both the rows and the overview counts
        fetchTable(activeTable, { page: Math.min(page, Math.max(1, Math.ceil((tableData?.pagination.total ?? 2) - 1) / pageSize)) });
        fetchOverview(true);
      } else {
        toast.error(body?.error || t('dbDeleteFailed'));
      }
    } catch {
      toast.error(t('dbDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  const exportTable = async () => {
    if (!activeTable) return;
    try {
      const res = await apiFetch(`/api/admin/db/table/${encodeURIComponent(activeTable)}/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error || t('dbExportFailed'));
        return;
      }
      const csv = await res.text();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `blasti-${activeTable}-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('dbExportStarted'));
    } catch {
      toast.error(t('dbExportFailed'));
    }
  };

  const runVacuum = async () => {
    setVacuuming(true);
    try {
      const res = await apiFetch('/api/admin/db/maintenance/vacuum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      // apiFetch unwraps the envelope — res.ok is the source of truth.
      if (res.ok && (body?.success !== false)) {
        const duration = (body?.data?.durationMs ?? body?.durationMs ?? 0) as number;
        toast.success(`${t('dbVacuumDone')} (${(duration / 1000).toFixed(1)}s)`);
        fetchOverview(true);
      } else {
        toast.error(body?.error || t('dbMaintenanceFailed'));
      }
    } catch {
      toast.error(t('dbMaintenanceFailed'));
    } finally {
      setVacuuming(false);
    }
  };

  const purgeTombstones = async () => {
    setPurging(true);
    try {
      const res = await apiFetch('/api/admin/db/maintenance/tombstones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      });
      const body = await res.json();
      // apiFetch unwraps the envelope — res.ok is the source of truth.
      if (res.ok && (body?.success !== false)) {
        toast.success(body?.message || t('dbPurgeDone'));
        fetchOverview(true);
      } else {
        toast.error(body?.error || t('dbMaintenanceFailed'));
      }
    } catch {
      toast.error(t('dbMaintenanceFailed'));
    } finally {
      setPurging(false);
    }
  };

  // ── Derived ──

  const filteredTables = tables.filter(
    (tb) => !tableSearch || tb.name.toLowerCase().includes(tableSearch.toLowerCase())
  );
  const totalRows = tables.reduce((sum, tb) => sum + tb.rowCount, 0);

  // ─── Render ───

  // ============ TABLE BROWSER VIEW ============
  if (activeTable) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <motion.div {...fadeUp}>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                    <Table2 className="h-4 w-4 text-amber-600 shrink-0" />
                    <span className="font-mono">{activeTable}</span>
                    {tableData && (
                      <Badge variant="secondary" className="text-[10px]">
                        {compactNumber(tableData.pagination.total)} {t('dbRows')}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {t('dbTableBrowserDesc')}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={exportTable}>
                    <Download className="h-4 w-4 me-1" />
                    CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => activeTable && fetchTable(activeTable)}
                    disabled={loadingTable}
                  >
                    {loadingTable ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={closeTable}>
                    <ArrowLeft className={`h-4 w-4 ${rtl ? 'rotate-180' : ''} me-1`} />
                    {t('dbBackToTables')}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Search */}
              <div className="flex gap-2 max-w-md">
                <div className="relative flex-1">
                  <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
                    placeholder={t('dbSearchRows')}
                    className="ps-8"
                  />
                </div>
                <Button size="sm" onClick={applySearch} disabled={loadingTable}>
                  {t('dbSearch')}
                </Button>
              </div>

              {/* Rows table */}
              {loadingTable ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : !tableData || tableData.rows.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Database className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  <p className="text-sm">{t('dbNoRows')}</p>
                </div>
              ) : (
                <>
                  <div className="rounded-xl border overflow-hidden">
                    <div className="max-h-[65vh] overflow-auto">
                      <Table>
                        <TableHeader className="sticky top-0 z-10 bg-background">
                          <TableRow>
                            {tableData.columns.map((col) => (
                              <TableHead key={col.name} className="whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => toggleSort(col.name)}
                                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                                  title={col.dataType}
                                >
                                  <span className="font-mono text-[11px]">{col.name}</span>
                                  {orderBy === col.name && (
                                    <span className="text-amber-600">{orderDir === 'desc' ? '↓' : '↑'}</span>
                                  )}
                                </button>
                              </TableHead>
                            ))}
                            <TableHead className="sticky end-0 bg-background w-20">
                              <span className="sr-only">{t('dbActions')}</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {tableData.rows.map((row, idx) => (
                            <TableRow key={String(row.id ?? idx)}>
                              {tableData.columns.map((col) => (
                                <TableCell key={col.name} className="whitespace-nowrap max-w-[240px] truncate text-[12px]">
                                  {isSecretColumn(col.name) && row[col.name] ? (
                                    <span className="inline-flex items-center gap-1 text-muted-foreground" title={t('dbSecretMasked')}>
                                      <KeyRound className="h-3 w-3" />
                                      ••••••
                                    </span>
                                  ) : (
                                    cellText(row[col.name])
                                  )}
                                </TableCell>
                              ))}
                              <TableCell className="sticky end-0 bg-background">
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    onClick={() => setInspectRow(row)}
                                    title={t('dbInspectRow')}
                                  >
                                    <Eye className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                                    onClick={() => setDeleteTarget(row)}
                                    title={t('dbDeleteRow')}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Pagination */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-xs text-muted-foreground">
                      {t('dbPage')} {tableData.pagination.page} / {tableData.pagination.totalPages}
                      {' · '}{compactNumber(tableData.pagination.total)} {t('dbRows')}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => changePage(tableData.pagination.page - 1)}
                        disabled={tableData.pagination.page <= 1 || loadingTable}
                      >
                        <ChevronLeft className={`h-4 w-4 ${rtl ? 'rotate-180' : ''}`} />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => changePage(tableData.pagination.page + 1)}
                        disabled={tableData.pagination.page >= tableData.pagination.totalPages || loadingTable}
                      >
                        <ChevronRight className={`h-4 w-4 ${rtl ? 'rotate-180' : ''}`} />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Row inspector dialog */}
        <Dialog open={!!inspectRow} onOpenChange={(o) => { if (!o) setInspectRow(null); }}>
          <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Eye className="h-4 w-4 text-amber-600" />
                {t('dbRowInspectTitle')}
              </DialogTitle>
              <DialogDescription>
                <span className="font-mono text-xs">{activeTable}</span>
                {' · '}{t('dbRowInspectDesc')}
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto max-h-[60vh] space-y-1.5 py-2">
              {inspectRow &&
                Object.entries(inspectRow).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2 text-[12px] rounded-lg bg-muted/40 px-3 py-2">
                    <span className="font-mono font-medium text-muted-foreground shrink-0 w-40 truncate" title={key}>
                      {key}
                    </span>
                    <span className="font-mono break-all">
                      {isSecretColumn(key) && value
                        ? '••••••••'
                        : typeof value === 'object' && value !== null
                          ? JSON.stringify(value, null, 2)
                          : String(value ?? '—')}
                    </span>
                  </div>
                ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* Row delete confirmation — typing the table name required */}
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
          title={t('dbDeleteRowConfirmTitle')}
          description={`${t('dbDeleteRowConfirmDesc')} (${activeTable}) — ${t('dbDeleteRowIrreversible')}`}
          confirmLabel={t('dbDeleteRow')}
          cancelLabel={t('cancel')}
          variant="danger"
          loading={deleting}
          confirmText={activeTable ?? undefined}
          onConfirm={confirmDeleteRow}
        />
      </div>
    );
  }

  // ============ OVERVIEW + MAINTENANCE VIEW ============
  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <motion.div {...fadeUp}>
        <Card>
          <CardContent className="p-4 lg:p-5">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center shrink-0">
                <Database className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="font-bold text-lg text-foreground">{t('dbManagerTitle')}</h1>
                <p className="text-xs text-muted-foreground">{t('dbManagerDesc')}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchOverview(true)}
                disabled={refreshing}
              >
                {refreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin me-1" />
                ) : (
                  <RefreshCw className="h-4 w-4 me-1" />
                )}
                {t('refresh')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Tabs */}
      <motion.div {...fadeUp} transition={{ delay: 0.05 }}>
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="overview" className="gap-2">
              <HardDrive className="h-4 w-4" />
              {t('dbOverviewTab')}
            </TabsTrigger>
            <TabsTrigger value="maintenance" className="gap-2">
              <Wrench className="h-4 w-4" />
              {t('dbMaintenanceTab')}
            </TabsTrigger>
          </TabsList>

          {/* ── Overview tab ── */}
          <TabsContent value="overview" className="mt-4 space-y-4">
            {/* Stats cards */}
            {loadingOverview ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24" />
                ))}
              </div>
            ) : stats ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                      <HardDrive className="h-3.5 w-3.5" />
                      <span className="text-[11px] font-medium">{t('dbSize')}</span>
                    </div>
                    <p className="text-xl font-bold">{stats.databaseSize}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                      <Table2 className="h-3.5 w-3.5" />
                      <span className="text-[11px] font-medium">{t('dbTablesCount')}</span>
                    </div>
                    <p className="text-xl font-bold">{stats.tableCount}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                      <Activity className="h-3.5 w-3.5" />
                      <span className="text-[11px] font-medium">{t('dbConnections')}</span>
                    </div>
                    <p className="text-xl font-bold">{stats.activeConnections}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-muted-foreground mb-1">
                      <Server className="h-3.5 w-3.5" />
                      <span className="text-[11px] font-medium">{t('dbVersion')}</span>
                    </div>
                    <p className="text-xl font-bold truncate" title={stats.fullVersion || stats.version}>
                      {stats.version || 'PostgreSQL'}
                    </p>
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {/* Tables list */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Table2 className="h-4 w-4 text-amber-600" />
                      {t('dbAllTables')}
                    </CardTitle>
                    <CardDescription>
                      {t('dbAllTablesDesc', {
                        tables: String(tables.length),
                        rows: compactNumber(totalRows),
                      })}
                    </CardDescription>
                  </div>
                  <div className="relative w-full sm:w-64">
                    <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={tableSearch}
                      onChange={(e) => setTableSearch(e.target.value)}
                      placeholder={t('dbSearchTable')}
                      className="ps-8"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {loadingOverview ? (
                  <div className="space-y-2">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : filteredTables.length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Database className="h-10 w-10 mx-auto mb-3 opacity-40" />
                    <p className="text-sm">{t('dbNoTables')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 max-h-[60vh] overflow-y-auto pe-1">
                    {filteredTables.map((tb) => (
                      <button
                        key={tb.name}
                        onClick={() => openTable(tb.name)}
                        className="group flex items-center gap-3 p-3 rounded-xl border border-border hover:border-amber-300 dark:hover:border-amber-700 hover:bg-amber-50/50 dark:hover:bg-amber-900/10 transition-all text-start"
                      >
                        <div className="h-9 w-9 rounded-lg bg-muted/60 group-hover:bg-amber-100 dark:group-hover:bg-amber-900/30 flex items-center justify-center shrink-0 transition-colors">
                          <Table2 className="h-4 w-4 text-muted-foreground group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-mono text-[13px] font-medium truncate">{tb.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {compactNumber(tb.rowCount)} {t('dbRows')} · {tb.size}
                          </p>
                        </div>
                        <ChevronRight className={`h-4 w-4 text-muted-foreground shrink-0 ${rtl ? 'rotate-180' : ''}`} />
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Maintenance tab ── */}
          <TabsContent value="maintenance" className="mt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* VACUUM */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-600" />
                    {t('dbVacuumTitle')}
                  </CardTitle>
                  <CardDescription>{t('dbVacuumDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={runVacuum}
                    disabled={vacuuming}
                    className="bg-amber-600 hover:bg-amber-700 w-full sm:w-auto"
                  >
                    {vacuuming ? (
                      <Loader2 className="h-4 w-4 animate-spin me-2" />
                    ) : (
                      <Wrench className="h-4 w-4 me-2" />
                    )}
                    {t('dbVacuumRun')}
                  </Button>
                </CardContent>
              </Card>

              {/* Tombstone purge */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Eraser className="h-4 w-4 text-teal-600" />
                    {t('dbTombstonesTitle')}
                  </CardTitle>
                  <CardDescription>{t('dbTombstonesDesc')}</CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={purgeTombstones}
                    disabled={purging}
                    variant="outline"
                    className="border-teal-300 dark:border-teal-800 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 w-full sm:w-auto"
                  >
                    {purging ? (
                      <Loader2 className="h-4 w-4 animate-spin me-2" />
                    ) : (
                      <Eraser className="h-4 w-4 me-2" />
                    )}
                    {t('dbTombstonesRun')}
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Safety notice */}
            <Card className="border-amber-200 dark:border-amber-900/50">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="space-y-1.5 text-[13px] text-muted-foreground">
                    <p className="font-medium text-foreground">{t('dbSafetyTitle')}</p>
                    <p>{t('dbSafetyDesc')}</p>
                    <ul className="space-y-1 ms-4 list-disc">
                      <li>{t('dbSafetyItem1')}</li>
                      <li>{t('dbSafetyItem2')}</li>
                      <li>{t('dbSafetyItem3')}</li>
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Extra stats */}
            {stats && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    {t('dbEngineStats')}
                  </CardTitle>
                  <CardDescription>{t('dbEngineStatsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="rounded-xl bg-muted/40 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">{t('dbTransactions')}</p>
                    <p className="text-lg font-bold">{compactNumber(stats.transactionsCommitted)}</p>
                  </div>
                  <div className="rounded-xl bg-muted/40 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">{t('dbBlocksFetched')}</p>
                    <p className="text-lg font-bold">{compactNumber(stats.blocksFetched)}</p>
                  </div>
                  <div className="rounded-xl bg-muted/40 p-3">
                    <p className="text-[11px] text-muted-foreground mb-1">{t('dbCacheHitRatio')}</p>
                    <p className="text-lg font-bold">
                      {stats.cacheHitRatio != null ? `${(stats.cacheHitRatio * 100).toFixed(1)}%` : '—'}
                      {stats.cacheHitRatio != null && stats.cacheHitRatio > 0.9 && (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 inline ms-1.5" />
                      )}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </motion.div>
    </div>
  );
}
