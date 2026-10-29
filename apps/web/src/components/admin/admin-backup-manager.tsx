'use client';

/**
 * Admin Backup Manager — SUPER_ADMIN backup console.
 *
 * Sidebar section "Database and Storage Management → Backup Manager"
 * (view admin-backups) backed by /api/admin/backups/* (apps/api/src/routes/
 * admin-backups.ts + lib/backup-engine.ts + lib/backup-targets.ts):
 *
 *   Overview    → stat cards (backups, storage used, last backup, auto status)
 *   Create      → manual backup with optional label + uploaded-files archive
 *   Auto backup → schedule (interval / retention / include-files / auto-push)
 *   Backups     → table with download (data + files), restore (confirm dialog,
 *                 auto safety snapshot), delete
 *   Targets     → external destinations: S3-compatible (R2/B2/Minio), Azure
 *                 Blob, Cloudflare D1, external PostgreSQL (Neon/Supabase —
 *                 full live migration). Test / push / delete per target.
 *
 * Long jobs (create / restore / push) run detached behind the API's global
 * mutex; the UI polls the overview while a runningJob is present.
 */

import { apiFetch } from '@/lib/api-fetch';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DatabaseBackup,
  RefreshCw,
  Loader2,
  Download,
  RotateCcw,
  Trash2,
  HardDrive,
  History,
  CalendarClock,
  Plus,
  CloudUpload,
  Plug,
  ShieldCheck,
  Database,
  FileArchive,
  CircleCheck,
  CircleX,
  ExternalLink,
  AlertTriangle,
  Eraser,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { type TranslationKeys } from '@/i18n';

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

// ─── System Reset config (POST /api/admin/reset) ───────────────────────────

/** Selective-reset sections — MUST match apps/api/src/routes/admin-reset.ts. */
const RESET_SECTION_ITEMS: Array<{ id: string; labelKey: TranslationKeys }> = [
  { id: 'customers', labelKey: 'resetSectionCustomers' },
  { id: 'agencies', labelKey: 'resetSectionAgencies' },
  { id: 'analytics', labelKey: 'resetSectionAnalytics' },
  { id: 'transactions', labelKey: 'resetSectionTransactions' },
  { id: 'logs', labelKey: 'resetSectionLogs' },
  { id: 'support', labelKey: 'resetSectionSupport' },
  { id: 'notifications', labelKey: 'resetSectionNotifications' },
  { id: 'reviews', labelKey: 'resetSectionReviews' },
  { id: 'favorites', labelKey: 'resetSectionFavorites' },
  { id: 'reservations', labelKey: 'resetSectionReservations' },
  { id: 'queue', labelKey: 'resetSectionQueue' },
  { id: 'devices', labelKey: 'resetSectionDevices' },
  { id: 'sessions', labelKey: 'resetSectionSessions' },
];

interface ResetResult {
  mode: 'full' | 'sections';
  sections: string[];
  summary: Record<string, number>;
  wipedLogFiles: number;
  at: string;
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface TableMeta {
  name: string;
  rows: number;
}

interface BackupEntry {
  id: string;
  label: string;
  type: 'manual' | 'auto' | 'pre-restore';
  createdAt: string;
  includeFiles: boolean;
  appVersion: string;
  pgVersion: string;
  dbSizeBytes: number;
  tables: TableMeta[];
  rowCount: number;
  dataBytes: number;
  filesBytes: number;
  filesCount: number;
  durationMs: number;
}

interface BackupSettings {
  enabled: boolean;
  intervalHours: number | null;
  dailyAt: string | null;
  keepLastN: number;
  includeFiles: boolean;
  autoPush: boolean;
  nextRunAt?: string | null;
}

type TargetType = 's3' | 'azure-blob' | 'd1' | 'postgres';

interface Target {
  id: string;
  name: string;
  type: TargetType;
  autoPush: boolean;
  createdAt: string;
  lastPushAt: string | null;
  lastPushResult: 'success' | 'error' | null;
  lastPushError: string | null;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  prefix?: string;
  account?: string;
  container?: string;
  accountId?: string;
  databaseId?: string;
  url?: string;
}

interface RunningJob {
  kind: 'backup' | 'restore' | 'push';
  label: string;
  startedAt: string;
  backupId?: string;
  targetName?: string;
}

interface Overview {
  settings: BackupSettings;
  targets: Target[];
  backups: BackupEntry[];
  busy: boolean;
  runningJob: RunningJob | null;
  storage: { dir: string; usedBytes: number };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(iso: string, lang: string): string {
  try {
    return new Date(iso).toLocaleString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AdminBackupManager() {
  const { t, language } = useLanguage();
  const tr = (k: TranslationKeys, params?: Record<string, string | number>) => {
    let s: string = t(k) as string;
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        s = s.replaceAll(`{${key}}`, String(val));
      }
    }
    return s;
  };

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [createBusy, setCreateBusy] = useState(false);
  const [createLabel, setCreateLabel] = useState('');
  const [createIncludeFiles, setCreateIncludeFiles] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<BackupSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [restoreWithFiles, setRestoreWithFiles] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [deleteTargetEntry, setDeleteTargetEntry] = useState<BackupEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newTargetType, setNewTargetType] = useState<TargetType>('s3');
  const [newTarget, setNewTarget] = useState<Record<string, string>>({});
  const [addingTarget, setAddingTarget] = useState(false);
  const [testingTargetId, setTestingTargetId] = useState<string | null>(null);
  const [pushingTargetId, setPushingTargetId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  // ── system reset state ──
  const [resetMode, setResetMode] = useState<'full' | 'selective'>('selective');
  const [resetSections, setResetSections] = useState<string[]>([]);
  const [resetVersions, setResetVersions] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState<ResetResult | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOverview = useCallback(
    async (silent = false) => {
      try {
        // cache-buster: the api layer's conditional-GET cache answers 304 with
        // an EMPTY body — an overview of `{}` must never clobber real state
        const res = await apiFetch(`/api/admin/backups?_=${Date.now()}`);
        const json = await res.json().catch(() => null);
        const data = json?.success ? json.data : json;
        if (data && Array.isArray(data.backups) && data.settings) {
          setOverview(data);
          setSettingsDraft((prev) => prev ?? data.settings);
        }
      } catch {
        if (!silent) toast.error('Failed to load backups');
      } finally {
        if (!silent) setLoading(false);
      }
    },
  );

  // initial load + poll while busy
  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useEffect(() => {
    if (overview?.busy && !pollRef.current) {
      pollRef.current = setInterval(() => fetchOverview(true), 2500);
    } else if (!overview?.busy && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      // job finished — one final authoritative refresh + feedback
      fetchOverview(true);
    }
    return () => {
      if (pollRef.current && !overview?.busy) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [overview?.busy, fetchOverview]);

  const prevBusy = useRef(false);
  useEffect(() => {
    if (prevBusy.current && !overview?.busy) {
      toast.success(tr('backupCreateDone', { rows: overview?.backups?.[0]?.rowCount ?? 0 }));
    }
    prevBusy.current = !!overview?.busy;
  }, [overview?.busy]);

  // ─── actions ────────────────────────────────────────────────────────────

  const createBackup = async () => {
    setCreateBusy(true);
    try {
      const res = await apiFetch('/api/admin/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: createLabel.trim() || undefined, includeFiles: createIncludeFiles }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Backup failed');
      } else {
        toast.success(tr('backupCreating'));
        setCreateLabel('');
        await fetchOverview(true);
      }
    } catch {
      toast.error('Backup failed');
    } finally {
      setCreateBusy(false);
    }
  };

  const saveSettings = async () => {
    if (!settingsDraft) return;
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/admin/backups/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: settingsDraft.enabled,
          intervalHours: settingsDraft.dailyAt ? null : settingsDraft.intervalHours,
          dailyAt: settingsDraft.dailyAt,
          keepLastN: settingsDraft.keepLastN,
          includeFiles: settingsDraft.includeFiles,
          autoPush: settingsDraft.autoPush,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Save failed');
      } else {
        toast.success(tr('backupSaved'));
        await fetchOverview(true);
      }
    } catch {
      toast.error('Save failed');
    } finally {
      setSavingSettings(false);
    }
  };

  const downloadBackup = async (entry: BackupEntry, part: 'data' | 'files') => {
    setDownloadingId(entry.id + part);
    try {
      const res = await apiFetch(`/api/admin/backups/${entry.id}/download?part=${part}`);
      if (!res.ok) {
        toast.error(`Download failed (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `blasti-${entry.id}-${part}.json.gz`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Download failed');
    } finally {
      setDownloadingId(null);
    }
  };

  const startRestore = async () => {
    if (!restoreTarget) return;
    setRestoreBusy(true);
    try {
      const res = await apiFetch(`/api/admin/backups/${restoreTarget.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restoreFiles: restoreWithFiles }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Restore failed');
      } else {
        toast.success(tr('backupRestoring'));
        setRestoreTarget(null);
        await fetchOverview(true);
      }
    } catch {
      toast.error('Restore failed');
    } finally {
      setRestoreBusy(false);
    }
  };

  const deleteBackup = async () => {
    if (!deleteTargetEntry) return;
    setDeleteBusy(true);
    try {
      const res = await apiFetch(`/api/admin/backups/${deleteTargetEntry.id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Delete failed');
      } else {
        toast.success(tr('backupDeleted'));
        setDeleteTargetEntry(null);
        await fetchOverview(true);
      }
    } catch {
      toast.error('Delete failed');
    } finally {
      setDeleteBusy(false);
    }
  };

  const addTarget = async () => {
    setAddingTarget(true);
    try {
      const payload: Record<string, unknown> = { type: newTargetType, name: newTarget.name || undefined, prefix: newTarget.prefix || undefined };
      if (newTargetType === 's3') {
        Object.assign(payload, {
          endpoint: newTarget.endpoint,
          region: newTarget.region || undefined,
          bucket: newTarget.bucket,
          accessKeyId: newTarget.accessKeyId,
          secretAccessKey: newTarget.secretAccessKey,
        });
      } else if (newTargetType === 'azure-blob') {
        Object.assign(payload, {
          account: newTarget.account,
          container: newTarget.container,
          accountKey: newTarget.accountKey || undefined,
          sasToken: newTarget.sasToken || undefined,
        });
      } else if (newTargetType === 'd1') {
        Object.assign(payload, {
          accountId: newTarget.accountId,
          databaseId: newTarget.databaseId,
          apiToken: newTarget.apiToken,
        });
      } else {
        Object.assign(payload, { url: newTarget.url });
      }
      const res = await apiFetch('/api/admin/backups/targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Add target failed');
      } else {
        toast.success(tr('backupTargetAdded'));
        setAddDialogOpen(false);
        setNewTarget({});
        setNewTargetType('s3');
        await fetchOverview(true);
      }
    } catch {
      toast.error('Add target failed');
    } finally {
      setAddingTarget(false);
    }
  };

  const testTarget = async (target: Target) => {
    setTestingTargetId(target.id);
    try {
      const res = await apiFetch(`/api/admin/backups/targets/${target.id}/test`, { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Test failed');
      } else {
        toast.success(tr('backupTargetTested'));
      }
    } catch {
      toast.error('Test failed');
    } finally {
      setTestingTargetId(null);
    }
  };

  const pushTarget = async (target: Target) => {
    setPushingTargetId(target.id);
    try {
      const res = await apiFetch(`/api/admin/backups/targets/${target.id}/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Push failed');
      } else {
        toast.success(tr('backupPushStarted'));
        await fetchOverview(true);
      }
    } catch {
      toast.error('Push failed');
    } finally {
      setPushingTargetId(null);
    }
  };

  const deleteTarget = async (target: Target) => {
    try {
      const res = await apiFetch(`/api/admin/backups/targets/${target.id}`, { method: 'DELETE' });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Delete failed');
      } else {
        toast.success(tr('backupTargetDeleted'));
        await fetchOverview(true);
      }
    } catch {
      toast.error('Delete failed');
    }
  };

  const toggleResetSection = (id: string, checked: boolean) => {
    setResetSections((prev) => (checked ? [...prev, id] : prev.filter((s) => s !== id)));
  };

  const executeReset = async () => {
    setResetBusy(true);
    try {
      const payload =
        resetMode === 'full'
          ? { mode: 'full', confirm: 'RESET', preserveVersions: resetVersions }
          : { sections: resetSections, confirm: 'RESET' };
      const res = await apiFetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        toast.error(json?.error || 'Reset failed');
      } else {
        setResetDialogOpen(false);
        setResetConfirmText('');
        setResetResult({
          mode: json.mode === 'full' ? 'full' : 'sections',
          sections: Array.isArray(json.sections) ? json.sections : [],
          summary: json.summary && typeof json.summary === 'object' ? json.summary : {},
          wipedLogFiles: typeof json.wipedLogFiles === 'number' ? json.wipedLogFiles : 0,
          at: typeof json.at === 'string' ? json.at : new Date().toISOString(),
        });
        // refresh every count the manager shows (storage usage, backups…)
        await fetchOverview(true);
      }
    } catch {
      toast.error('Reset failed');
    } finally {
      setResetBusy(false);
    }
  };

  // ─── render helpers ─────────────────────────────────────────────────────

  const typeBadge = (type: BackupEntry['type']) => {
    const map = {
      manual: { label: tr('backupTypeManual'), cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300' },
      auto: { label: tr('backupTypeAuto'), cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' },
      'pre-restore': { label: tr('backupTypePreRestore'), cls: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
    } as const;
    const v = map[type];
    return <Badge className={`text-xs ${v.cls}`}>{v.label}</Badge>;
  };

  const lastBackup = overview?.backups?.[0];

  const targetSummary = (tg: Target): string => {
    switch (tg.type) {
      case 's3':
        return `${tg.bucket} · ${tg.endpoint}`;
      case 'azure-blob':
        return `${tg.container} · ${tg.account}`;
      case 'd1':
        return `${tg.databaseId?.slice(0, 8)}…`;
      case 'postgres':
        return tg.url?.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:••••@') ?? '';
    }
  };

  const providerIcon = (type: TargetType) => {
    switch (type) {
      case 'postgres':
        return <Database className="h-4 w-4" />;
      default:
        return <CloudUpload className="h-4 w-4" />;
    }
  };

  // ─── render ─────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 space-y-6" dir="auto">
      {/* header */}
      <motion.div variants={fadeUp} initial="initial" animate="animate" className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DatabaseBackup className="h-6 w-6 text-emerald-600" />
            {tr('backupManagerTitle')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{tr('backupManagerSubtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchOverview()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">{tr('backupRefresh')}</span>
        </Button>
      </motion.div>

      {/* running job banner */}
      {overview?.busy && overview.runningJob && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800 px-4 py-3 flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
          <span className="text-sm font-medium">
            {tr('backupBusyBanner', { label: overview.runningJob.label })}
          </span>
        </div>
      )}

      {/* stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loading || !overview ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/40 p-2.5">
                  <FileArchive className="h-5 w-5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{tr('backupStatBackups')}</p>
                  <p className="text-xl font-bold">{overview.backups.length}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/40 p-2.5">
                  <HardDrive className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{tr('backupStatStorage')}</p>
                  <p className="text-xl font-bold">{formatBytes(overview.storage.usedBytes)}</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/40 p-2.5">
                  <History className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{tr('backupStatLast')}</p>
                  <p className="text-sm font-semibold truncate">
                    {lastBackup ? formatDateTime(lastBackup.createdAt, language) : tr('backupNever')}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-4 flex items-center gap-3">
                <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/40 p-2.5">
                  <CalendarClock className="h-5 w-5 text-emerald-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{tr('backupStatAuto')}</p>
                  {overview.settings.enabled ? (
                    <>
                      <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs mt-0.5">
                        {tr('backupAutoOn')}
                      </Badge>
                      {overview.settings.nextRunAt && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {tr('backupNextRun')}: {formatDateTime(overview.settings.nextRunAt, language)}
                        </p>
                      )}
                    </>
                  ) : (
                    <Badge variant="secondary" className="text-xs mt-0.5">{tr('backupAutoOff')}</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* create + auto settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              {tr('backupCreateTitle')}
            </CardTitle>
            <CardDescription>{tr('backupCreateDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="backup-label">{tr('backupLabel')}</Label>
              <Input
                id="backup-label"
                value={createLabel}
                onChange={(e) => setCreateLabel(e.target.value)}
                placeholder={tr('backupLabelPlaceholder')}
                maxLength={120}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <Label htmlFor="include-files" className="cursor-pointer text-sm font-normal">
                {tr('backupIncludeFiles')}
              </Label>
              <Switch id="include-files" checked={createIncludeFiles} onCheckedChange={setCreateIncludeFiles} />
            </div>
            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-700"
              onClick={createBackup}
              disabled={createBusy || overview?.busy}
            >
              {createBusy || overview?.busy ? (
                <Loader2 className="h-4 w-4 animate-spin ml-2" />
              ) : (
                <Plus className="h-4 w-4 ml-2" />
              )}
              {createBusy || overview?.busy ? tr('backupCreating') : tr('backupCreateBtn')}
            </Button>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              {tr('backupSafetyNote')}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CalendarClock className="h-5 w-5 text-emerald-600" />
              {tr('backupAutoTitle')}
            </CardTitle>
            <CardDescription>{tr('backupAutoDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settingsDraft ? (
              <>
                <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <Label htmlFor="auto-enable" className="cursor-pointer text-sm font-normal">
                    {tr('backupAutoEnable')}
                  </Label>
                  <Switch
                    id="auto-enable"
                    checked={settingsDraft.enabled}
                    onCheckedChange={(v) => setSettingsDraft({ ...settingsDraft, enabled: v })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{tr('backupAutoInterval')}</Label>
                    <Select
                      value={
                        settingsDraft.dailyAt
                          ? 'daily-at'
                          : String(settingsDraft.intervalHours ?? 24)
                      }
                      onValueChange={(v) =>
                        setSettingsDraft(
                          v === 'daily-at'
                            ? { ...settingsDraft, dailyAt: '03:00', intervalHours: null }
                            : { ...settingsDraft, dailyAt: null, intervalHours: Number(v) },
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="6">{tr('backupInterval6')}</SelectItem>
                        <SelectItem value="12">{tr('backupInterval12')}</SelectItem>
                        <SelectItem value="24">{tr('backupInterval24')}</SelectItem>
                        <SelectItem value="168">{tr('backupInterval168')}</SelectItem>
                        <SelectItem value="daily-at">{tr('backupNextRun')} (HH:mm)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {settingsDraft.dailyAt ? (
                    <div className="space-y-1.5">
                      <Label>HH:mm</Label>
                      <Input
                        type="time"
                        value={settingsDraft.dailyAt}
                        onChange={(e) =>
                          setSettingsDraft({ ...settingsDraft, dailyAt: e.target.value || null })
                        }
                      />
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <Label>{tr('backupKeepLast')} ({tr('backupKeepLastUnit')})</Label>
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        value={settingsDraft.keepLastN}
                        onChange={(e) =>
                          setSettingsDraft({ ...settingsDraft, keepLastN: Math.max(1, Number(e.target.value) || 1) })
                        }
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <Label htmlFor="auto-files" className="cursor-pointer text-sm font-normal">
                    {tr('backupIncludeFiles')}
                  </Label>
                  <Switch
                    id="auto-files"
                    checked={settingsDraft.includeFiles}
                    onCheckedChange={(v) => setSettingsDraft({ ...settingsDraft, includeFiles: v })}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                  <Label htmlFor="auto-push" className="cursor-pointer text-sm font-normal">
                    {tr('backupAutoPush')}
                  </Label>
                  <Switch
                    id="auto-push"
                    checked={settingsDraft.autoPush}
                    onCheckedChange={(v) => setSettingsDraft({ ...settingsDraft, autoPush: v })}
                  />
                </div>
                <Button variant="outline" className="w-full" onClick={saveSettings} disabled={savingSettings}>
                  {savingSettings && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
                  {tr('backupSaveSettings')}
                </Button>
              </>
            ) : (
              <Skeleton className="h-48" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* backups table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{tr('backupListTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading || !overview ? (
            <Skeleton className="h-40" />
          ) : overview.backups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">{tr('backupListEmpty')}</p>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>{tr('backupColBackup')}</TableHead>
                    <TableHead>{tr('backupColType')}</TableHead>
                    <TableHead>{tr('backupColCreated')}</TableHead>
                    <TableHead>{tr('backupColContents')}</TableHead>
                    <TableHead>{tr('backupColSize')}</TableHead>
                    <TableHead className="text-end">{tr('backupColActions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.backups.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="max-w-48">
                        <p className="font-medium truncate" title={entry.label}>{entry.label}</p>
                        <p className="text-xs text-muted-foreground font-mono">{entry.id}</p>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1">
                          {typeBadge(entry.type)}
                          {entry.includeFiles && (
                            <Badge variant="outline" className="text-xs">{tr('backupFilesIncluded')}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatDateTime(entry.createdAt, language)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {tr('backupTablesRows', { tables: entry.tables.length, rows: entry.rowCount })}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {formatBytes(entry.dataBytes)}
                        {entry.includeFiles && entry.filesBytes > 0 && (
                          <span className="text-muted-foreground"> + {formatBytes(entry.filesBytes)}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-end">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadBackup(entry, 'data')}
                            disabled={downloadingId === entry.id + 'data'}
                            title={tr('backupDownload')}
                          >
                            {downloadingId === entry.id + 'data' ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                            <span className="hidden lg:inline text-xs">{tr('backupPartData')}</span>
                          </Button>
                          {entry.includeFiles && entry.filesBytes > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => downloadBackup(entry, 'files')}
                              disabled={downloadingId === entry.id + 'files'}
                              title={tr('backupDownloadFiles')}
                            >
                              {downloadingId === entry.id + 'files' ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                              <span className="hidden lg:inline text-xs">{tr('backupPartFiles')}</span>
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:hover:bg-emerald-950"
                            onClick={() => {
                              setRestoreTarget(entry);
                              setRestoreWithFiles(false);
                            }}
                            disabled={overview.busy}
                            title={tr('backupRestore')}
                          >
                            <RotateCcw className="h-4 w-4" />
                            <span className="hidden lg:inline text-xs">{tr('backupRestore')}</span>
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-950"
                            onClick={() => setDeleteTargetEntry(entry)}
                            title={tr('backupDelete')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* external targets */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <ExternalLink className="h-5 w-5 text-emerald-600" />
                {tr('backupTargetsTitle')}
              </CardTitle>
              <CardDescription>{tr('backupTargetsDesc')}</CardDescription>
            </div>
            <Button className="bg-emerald-600 hover:bg-emerald-700" size="sm" onClick={() => setAddDialogOpen(true)}>
              <Plus className="h-4 w-4 ml-1" />
              {tr('backupAddTarget')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!overview || overview.targets.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{tr('backupTargetsEmpty')}</p>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {overview.targets.map((tg) => (
                <div
                  key={tg.id}
                  className="rounded-lg border px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="rounded-full bg-emerald-100 dark:bg-emerald-900/40 p-2">
                      {providerIcon(tg.type)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm">{tg.name}</p>
                        <Badge variant="secondary" className="text-xs">{tg.type}</Badge>
                        {tg.autoPush && (
                          <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300 text-xs">
                            {tr('backupAutoPushTarget')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate font-mono" dir="ltr">
                        {targetSummary(tg)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {tr('backupLastPush')}:{' '}
                        {tg.lastPushAt ? (
                          <span className="inline-flex items-center gap-1">
                            {tg.lastPushResult === 'success' ? (
                              <CircleCheck className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <CircleX className="h-3.5 w-3.5 text-red-600" />
                            )}
                            {formatDateTime(tg.lastPushAt, language)}
                            {tg.lastPushError && (
                              <span className="text-red-600" title={tg.lastPushError}> — {tg.lastPushError.slice(0, 60)}</span>
                            )}
                          </span>
                        ) : (
                          tr('backupNever')
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => testTarget(tg)} disabled={testingTargetId === tg.id}>
                      {testingTargetId === tg.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                      <span className="text-xs">{tr('backupTest')}</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-emerald-700 border-emerald-300 hover:bg-emerald-50 dark:text-emerald-400 dark:border-emerald-800 dark:hover:bg-emerald-950"
                      onClick={() => pushTarget(tg)}
                      disabled={pushingTargetId === tg.id || overview.busy}
                    >
                      {pushingTargetId === tg.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CloudUpload className="h-4 w-4" />
                      )}
                      <span className="text-xs">{tg.type === 'postgres' ? tr('backupMigrate') : tr('backupPushNow')}</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-950"
                      onClick={() => deleteTarget(tg)}
                      title={tr('backupDeleteTarget')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── system reset (danger zone) ─── */}
      <Card className="border-red-200 dark:border-red-900">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2 text-red-600 dark:text-red-400">
            <Eraser className="h-5 w-5" />
            {tr('resetTitle')}
          </CardTitle>
          <CardDescription>{tr('resetDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* mode toggle */}
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20 p-1.5">
            <button
              type="button"
              onClick={() => setResetMode('full')}
              className={`h-9 rounded-lg text-sm font-semibold transition-all ${
                resetMode === 'full'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40'
              }`}
            >
              {tr('resetModeFull')}
            </button>
            <button
              type="button"
              onClick={() => setResetMode('selective')}
              className={`h-9 rounded-lg text-sm font-semibold transition-all ${
                resetMode === 'selective'
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40'
              }`}
            >
              {tr('resetModeSelective')}
            </button>
          </div>

          {/* warning */}
          <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 space-y-2">
            <p className="text-sm font-medium text-red-700 dark:text-red-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {tr('resetWarning')}
            </p>
            <p className="text-xs text-red-600/90 dark:text-red-400/90 ps-6">{tr('resetPreservedNote')}</p>
          </div>

          {/* selective: per-section checkboxes */}
          {resetMode === 'selective' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2.5 rounded-lg border px-4 py-3">
              {RESET_SECTION_ITEMS.map((s) => (
                <label key={s.id} className="flex items-center gap-2.5 text-sm cursor-pointer py-1">
                  <Checkbox
                    checked={resetSections.includes(s.id)}
                    onCheckedChange={(v) => toggleResetSection(s.id, v === true)}
                    className="accent-red-600 data-[state=checked]:bg-red-600 data-[state=checked]:border-red-600"
                  />
                  {tr(s.labelKey)}
                </label>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3">
                <p className="text-xs text-red-700 dark:text-red-300 font-medium">{tr('resetFullScopeNote')}</p>
              </div>
              <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
                <Label htmlFor="reset-versions" className="cursor-pointer text-sm font-normal">
                  {tr('resetPreserveVersions')}
                </Label>
                <Switch id="reset-versions" checked={resetVersions} onCheckedChange={setResetVersions} />
              </div>
            </div>
          )}

          {/* execute */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {resetMode === 'selective'
                ? resetSections.length > 0
                  ? tr('resetSectionsSelected', { count: resetSections.length })
                  : tr('resetSelectAtLeastOne')
                : tr('resetBadgeFull')}
            </p>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white w-full sm:w-auto"
              onClick={() => {
                setResetConfirmText('');
                setResetDialogOpen(true);
              }}
              disabled={resetBusy || overview?.busy || (resetMode === 'selective' && resetSections.length === 0)}
            >
              {resetBusy ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Eraser className="h-4 w-4 me-2" />}
              {tr('resetExecute')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* add target dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tr('backupAddTarget')}</DialogTitle>
            <DialogDescription>{tr('backupTargetsDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{tr('backupTargetType')}</Label>
              <Select
                value={newTargetType}
                onValueChange={(v) => {
                  setNewTargetType(v as TargetType);
                  setNewTarget({});
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="s3">{tr('backupTargetS3')}</SelectItem>
                  <SelectItem value="azure-blob">{tr('backupTargetAzure')}</SelectItem>
                  <SelectItem value="d1">{tr('backupTargetD1')}</SelectItem>
                  <SelectItem value="postgres">{tr('backupTargetPostgres')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{tr('backupTargetName')}</Label>
              <Input
                value={newTarget.name ?? ''}
                onChange={(e) => setNewTarget({ ...newTarget, name: e.target.value })}
                placeholder="My R2 bucket / Neon prod …"
              />
            </div>

            {newTargetType === 's3' && (
              <>
                <div className="space-y-1.5">
                  <Label>{tr('backupEndpoint')}</Label>
                  <Input
                    dir="ltr"
                    value={newTarget.endpoint ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, endpoint: e.target.value })}
                    placeholder="https://<account>.r2.cloudflarestorage.com"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{tr('backupBucket')}</Label>
                    <Input
                      dir="ltr"
                      value={newTarget.bucket ?? ''}
                      onChange={(e) => setNewTarget({ ...newTarget, bucket: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{tr('backupRegion')}</Label>
                    <Input
                      dir="ltr"
                      value={newTarget.region ?? ''}
                      onChange={(e) => setNewTarget({ ...newTarget, region: e.target.value })}
                      placeholder="auto"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{tr('backupAccessKey')}</Label>
                    <Input
                      dir="ltr"
                      value={newTarget.accessKeyId ?? ''}
                      onChange={(e) => setNewTarget({ ...newTarget, accessKeyId: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{tr('backupSecretKey')}</Label>
                    <Input
                      dir="ltr"
                      type="password"
                      value={newTarget.secretAccessKey ?? ''}
                      onChange={(e) => setNewTarget({ ...newTarget, secretAccessKey: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{tr('backupPrefix')}</Label>
                  <Input
                    dir="ltr"
                    value={newTarget.prefix ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, prefix: e.target.value })}
                    placeholder="blasti/backups"
                  />
                </div>
              </>
            )}

            {newTargetType === 'azure-blob' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{tr('backupAccount')}</Label>
                    <Input
                      dir="ltr"
                      value={newTarget.account ?? ''}
                      onChange={(e) => setNewTarget({ ...newTarget, account: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{tr('backupContainer')}</Label>
                    <Input
                      dir="ltr"
                      value={newTarget.container ?? ''}
                      onChange={(e) => setNewTarget({ ...newTarget, container: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>{tr('backupAccountKey')}</Label>
                  <Input
                    dir="ltr"
                    type="password"
                    value={newTarget.accountKey ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, accountKey: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{tr('backupSasToken')}</Label>
                  <Input
                    dir="ltr"
                    type="password"
                    value={newTarget.sasToken ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, sasToken: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{tr('backupPrefix')}</Label>
                  <Input
                    dir="ltr"
                    value={newTarget.prefix ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, prefix: e.target.value })}
                  />
                </div>
              </>
            )}

            {newTargetType === 'd1' && (
              <>
                <div className="space-y-1.5">
                  <Label>{tr('backupCloudAccountId')}</Label>
                  <Input
                    dir="ltr"
                    value={newTarget.accountId ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, accountId: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{tr('backupDatabaseId')}</Label>
                  <Input
                    dir="ltr"
                    value={newTarget.databaseId ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, databaseId: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{tr('backupApiToken')}</Label>
                  <Input
                    dir="ltr"
                    type="password"
                    value={newTarget.apiToken ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, apiToken: e.target.value })}
                  />
                </div>
                <p className="text-xs text-muted-foreground">{tr('backupD1Note')}</p>
              </>
            )}

            {newTargetType === 'postgres' && (
              <>
                <div className="space-y-1.5">
                  <Label>{tr('backupUrl')}</Label>
                  <Input
                    dir="ltr"
                    type="password"
                    value={newTarget.url ?? ''}
                    onChange={(e) => setNewTarget({ ...newTarget, url: e.target.value })}
                    placeholder="postgres://user:pass@host/db"
                  />
                  <p className="text-xs text-muted-foreground">{tr('backupUrlHint')}</p>
                </div>
                <p className="text-xs text-muted-foreground">{tr('backupPgNote')}</p>
              </>
            )}

            <Button
              className="w-full bg-emerald-600 hover:bg-emerald-700"
              onClick={addTarget}
              disabled={addingTarget}
            >
              {addingTarget && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
              {tr('backupAddTarget')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* restore confirm (custom dialog — needs the files checkbox) */}
      <Dialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {tr('backupRestoreConfirmTitle')}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              {restoreTarget
                ? tr('backupRestoreConfirmDesc', { label: restoreTarget.label })
                : ''}
            </DialogDescription>
          </DialogHeader>
          {restoreTarget?.includeFiles && restoreTarget.filesBytes > 0 && (
            <label className="flex items-center gap-2 text-sm py-1 cursor-pointer">
              <input
                type="checkbox"
                checked={restoreWithFiles}
                onChange={(e) => setRestoreWithFiles(e.target.checked)}
                className="h-4 w-4 accent-emerald-600"
              />
              {tr('backupRestoreWithFiles')}
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setRestoreTarget(null)} disabled={restoreBusy}>
              {t('cancel' as TranslationKeys)}
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              onClick={startRestore}
              disabled={restoreBusy}
            >
              {restoreBusy && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
              {restoreBusy ? tr('backupRestoring') : tr('backupRestore')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <ConfirmDialog
        open={!!deleteTargetEntry}
        onOpenChange={(open) => !open && setDeleteTargetEntry(null)}
        title={tr('backupDeleteConfirmTitle')}
        description={
          deleteTargetEntry
            ? tr('backupDeleteConfirmDesc', { label: deleteTargetEntry.label })
            : ''
        }
        confirmLabel={tr('backupDelete')}
        onConfirm={deleteBackup}
        variant="danger"
        loading={deleteBusy}
      />

      {/* system reset confirm — typed RESET (irreversible) */}
      <Dialog
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setResetDialogOpen(false);
            setResetConfirmText('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertTriangle className="h-5 w-5" />
              {tr('resetConfirmTitle')}
            </DialogTitle>
            <DialogDescription className="space-y-3">
              <p>
                {resetMode === 'full' ? tr('resetConfirmDescFull') : tr('resetConfirmDescSelective')}
              </p>
              {resetMode === 'selective' && resetSections.length > 0 && (
                <p className="text-xs font-medium text-foreground" dir="auto">
                  {resetSections
                    .map((id) => RESET_SECTION_ITEMS.find((s) => s.id === id))
                    .filter(Boolean)
                    .map((s) => tr(s!.labelKey))
                    .join(' · ')}
                </p>
              )}
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                  ⚠️ {tr('resetWarning')}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{tr('resetTypeToConfirm')}</p>
                <Input
                  value={resetConfirmText}
                  onChange={(e) => setResetConfirmText(e.target.value)}
                  placeholder="RESET"
                  className="h-10 font-mono"
                  dir="ltr"
                  autoFocus
                />
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={() => {
                setResetDialogOpen(false);
                setResetConfirmText('');
              }}
              disabled={resetBusy}
            >
              {t('cancel' as TranslationKeys)}
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={executeReset}
              disabled={resetBusy || resetConfirmText !== 'RESET'}
            >
              {resetBusy ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Eraser className="h-4 w-4 me-2" />}
              {resetBusy ? tr('resetRunning') : tr('resetExecute')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* system reset summary (per-model deleted counts) */}
      <Dialog open={!!resetResult} onOpenChange={(open) => !open && setResetResult(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleCheck className="h-5 w-5 text-emerald-600" />
              {tr('resetDone')}
            </DialogTitle>
            <DialogDescription>
              {resetResult?.mode === 'full' ? tr('resetBadgeFull') : tr('resetBadgeSelective')}
              {' · '}
              {formatDateTime(resetResult?.at ?? new Date().toISOString(), language)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr('resetSummaryModel')}</TableHead>
                    <TableHead className="text-end">{tr('resetSummaryDeleted')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {resetResult &&
                    Object.entries(resetResult.summary).length > 0 &&
                    Object.entries(resetResult.summary)
                      .sort((a, b) => b[1] - a[1])
                      .map(([model, count]) => (
                        <TableRow key={model}>
                          <TableCell className="font-mono text-xs">{model}</TableCell>
                          <TableCell className="text-end font-semibold">{count}</TableCell>
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
            </div>
            {resetResult && resetResult.wipedLogFiles > 0 && (
              <p className="text-xs text-muted-foreground">
                {tr('resetLogFilesWiped', { count: resetResult.wipedLogFiles })}
              </p>
            )}
            <Button variant="outline" className="w-full" onClick={() => setResetResult(null)}>
              {t('cancel' as TranslationKeys)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AdminBackupManager;
