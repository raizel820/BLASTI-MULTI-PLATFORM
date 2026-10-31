'use client';

/**
 * TAB 1 — Installers (live storage tracker).
 *
 * Reads the app-versions bucket DIRECTLY (GET /api/app-versions/storage-files
 * re-walks the disk on every call): every installer file on the server is one
 * row — two uploads with the IDENTICAL original filename stay two distinct
 * rows, distinguished by push time (file mtime) + exact storage key.
 *
 * - Manual Refresh (spin animation) + 30s auto-refresh (interval cleared on unmount)
 * - Platform filter chips with per-platform counts
 * - EXACT active identity: isPublished AND byte-exact fileSize match
 * - Upload dialog: drag&drop, client-side platform/version detection from the
 *   filename (editable), versionCode, EN/AR/FR release notes, mandatory switch,
 *   real XHR upload progress, 409-tolerant version-ensure step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import {
  detectInstallerMeta,
  ensureAppVersionRecord,
  uploadInstallerBinary,
  INSTALLER_PLATFORMS,
  isValidSemver,
  type InstallerPlatform,
} from '@/lib/admin-upload';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  RefreshCw,
  Upload,
  Package,
  PackageOpen,
  CheckCircle2,
  Link2,
  Loader2,
  FileArchive,
  AlertTriangle,
  Inbox,
  Github,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  formatFileSize,
  formatPushedAt,
  isActiveInstaller,
  platformIcon,
  platformLabel,
  type InstallerDiskFile,
} from './shared';
import { NotesInput, type NotesValue } from './notes-input';
import { DeltaManagerCard } from './delta-manager-card';

const AUTO_REFRESH_MS = 30_000;

interface UploadForm {
  platform: InstallerPlatform;
  version: string;
  versionCode: string;
  notes: NotesValue;
  isMandatory: boolean;
}

const EMPTY_FORM: UploadForm = {
  platform: 'android',
  version: '',
  versionCode: '0',
  notes: { en: '', ar: '', fr: '' },
  isMandatory: false,
};

export function InstallersTab() {
  const { t, lang } = useLanguage();

  // ── Listing state ──
  const [files, setFiles] = useState<InstallerDiskFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  // ── Activate state ──
  const [activatingKey, setActivatingKey] = useState<string | null>(null);
  const [confirmFile, setConfirmFile] = useState<InstallerDiskFile | null>(null);

  // ── Upload dialog state ──
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [form, setForm] = useState<UploadForm>(EMPTY_FORM);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Regenerate-installers (GitHub Actions dispatch) state ──
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenSaving, setRegenSaving] = useState(false);
  const [regenStatusLoading, setRegenStatusLoading] = useState(false);
  const [regenConfigured, setRegenConfigured] = useState(false);
  const [regenRepo, setRegenRepo] = useState('raizel820/BLASTI-MULTI-PLATFORM');
  const [regenWorkflow, setRegenWorkflow] = useState('publish-installers.yml');
  const [regenRef, setRegenRef] = useState('master');
  const [regenToken, setRegenToken] = useState('');
  const [regenTargets, setRegenTargets] = useState<'all' | 'desktop-only' | 'mobile-only'>('all');
  const [regenVps, setRegenVps] = useState(false);

  // ── Data ──
  const fetchFiles = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await apiFetch('/api/app-versions/storage-files');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setFiles(data.files || []);
        setError(null);
      } else {
        setError(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
    const interval = setInterval(() => fetchFiles(true), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchFiles]);

  // ── Grouping: one group per platform present, rows sorted push-time desc ──
  // Internal delta-system artifacts (asar/outref diff references + hop
  // patches) are NOT installers — they are excluded from the platform groups
  // (they used to surface as an "unknown platform" installer group) and get
  // their own section below.
  const { groups, deltaFiles } = useMemo(() => {
    const byPlatform = new Map<string, InstallerDiskFile[]>();
    const deltas: InstallerDiskFile[] = [];
    for (const f of files) {
      if (f.internal) {
        deltas.push(f);
        continue;
      }
      const key = f.platform || f.parsed?.platform || '';
      const list = byPlatform.get(key) || [];
      list.push(f);
      byPlatform.set(key, list);
    }
    deltas.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      groups: Array.from(byPlatform.entries())
        .map(([platform, rows]) => ({
          platform,
          rows: rows.sort((a, b) => b.mtimeMs - a.mtimeMs),
        }))
        .sort((a, b) => b.rows.length - a.rows.length),
      deltaFiles: deltas,
    };
  }, [files]);

  const installerCount = files.length - deltaFiles.length;

  const deltaKindLabel = (kind: string | null | undefined) =>
    kind === 'asar-ref' ? t('publicAppDeltaKindAsarRef')
    : kind === 'outref-ref' ? t('publicAppDeltaKindOutref')
    : kind === 'delta-patch' ? t('publicAppDeltaKindPatch')
    : t('publicAppDeltaKindOther');

  const visibleGroups = useMemo(
    () => (filter === 'all' ? groups : groups.filter((g) => g.platform === filter)),
    [groups, filter],
  );

  // Currently active file per platform (EXACT identity) — used to decide
  // whether activating a row needs an overwrite confirmation.
  const activeByPlatform = useMemo(() => {
    const map = new Map<string, InstallerDiskFile>();
    for (const f of files) {
      const key = f.platform || f.parsed?.platform || '';
      if (isActiveInstaller(f) && !map.has(key)) map.set(key, f);
    }
    return map;
  }, [files]);

  // ── Activate ──
  const doActivate = useCallback(
    async (file: InstallerDiskFile) => {
      setActivatingKey(file.storageKey);
      try {
        const res = await apiFetch('/api/app-versions/activate-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storagePath: file.storageKey }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          toast.success(t('publicAppActivateDone'));
          await fetchFiles(true);
        } else {
          toast.error(t('publicAppActivateFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppActivateFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setActivatingKey(null);
        setConfirmFile(null);
      }
    },
    [fetchFiles, t],
  );

  const requestActivate = useCallback(
    (file: InstallerDiskFile) => {
      const key = file.platform || file.parsed?.platform || '';
      const currentActive = activeByPlatform.get(key);
      // Confirm only when OVERWRITING a different active installer.
      if (currentActive && currentActive.storageKey !== file.storageKey) {
        setConfirmFile(file);
      } else {
        void doActivate(file);
      }
    },
    [activeByPlatform, doActivate],
  );

  // ── Upload flow ──
  const openUpload = useCallback(() => {
    setUploadFile(null);
    setForm(EMPTY_FORM);
    setUploadProgress(0);
    setUploading(false);
    setDragOver(false);
    setUploadOpen(true);
  }, []);

  const acceptFile = useCallback((file: File) => {
    setUploadFile(file);
    setUploadProgress(0);
    const detected = detectInstallerMeta(file.name);
    setForm((prev) => ({
      ...prev,
      platform: detected.platform || prev.platform,
      version: detected.version || prev.version,
    }));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) acceptFile(dropped);
    },
    [acceptFile],
  );

  const canUpload =
    !!uploadFile &&
    form.version.trim().length > 0 &&
    isValidSemver(form.version) &&
    INSTALLER_PLATFORMS.includes(form.platform) &&
    !uploading;

  const submitUpload = useCallback(async () => {
    if (!uploadFile || !canUpload) {
      if (uploadFile && !isValidSemver(form.version)) {
        toast.error(t('publicAppUploadMissingFields'));
      }
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      // Step 1 — ensure the AppVersion record exists (409 = already there).
      const ensured = await ensureAppVersionRecord({
        platform: form.platform,
        version: form.version.trim(),
        versionCode: parseInt(form.versionCode, 10) || 0,
        releaseNotes: form.notes.en,
        releaseNotesAr: form.notes.ar,
        releaseNotesFr: form.notes.fr,
        isMandatory: form.isMandatory,
      });
      if (!ensured.ok) {
        toast.error(t('publicAppUploadFailed'), { description: ensured.error });
        setUploading(false);
        return;
      }

      // Step 2 — upload the binary with real progress.
      const uploaded = await uploadInstallerBinary({
        file: uploadFile,
        platform: form.platform,
        version: form.version.trim(),
        versionCode: parseInt(form.versionCode, 10) || 0,
        releaseNotes: form.notes.en,
        isMandatory: form.isMandatory,
        onProgress: (p) => setUploadProgress(p),
      });
      if (!uploaded.ok) {
        toast.error(t('publicAppUploadFailed'), { description: uploaded.error });
        setUploading(false);
        return;
      }

      toast.success(t('publicAppUploadDone'));
      setUploadOpen(false);
      // Auto-switch the filter so the new row is immediately visible.
      setFilter(form.platform);
      await fetchFiles(true);
    } finally {
      setUploading(false);
    }
  }, [uploadFile, canUpload, form, fetchFiles, t]);

  // ── Regenerate-installers handlers ──
  const loadRegenStatus = useCallback(async () => {
    setRegenStatusLoading(true);
    try {
      const res = await apiFetch('/api/app-versions/regenerate-installers/status');
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success && j?.data) {
        setRegenConfigured(!!j.data.configured);
        if (j.data.repo) setRegenRepo(j.data.repo);
        if (j.data.workflow) setRegenWorkflow(j.data.workflow);
        if (j.data.ref) setRegenRef(j.data.ref);
      }
    } catch {
      /* status is best-effort — the dialog still opens with defaults */
    } finally {
      setRegenStatusLoading(false);
    }
  }, []);

  const saveRegenConfig = useCallback(async () => {
    setRegenSaving(true);
    try {
      const res = await apiFetch('/api/app-versions/regenerate-installers/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: regenToken.trim() || undefined,
          repo: regenRepo.trim() || undefined,
          workflow: regenWorkflow.trim() || undefined,
          ref: regenRef.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success) {
        setRegenToken('');
        toast.success(t('publicAppRegenSaved'));
        await loadRegenStatus();
      } else {
        toast.error(j?.error === 'github-repo-invalid' ? t('publicAppRegenErrRepo') : t('publicAppRegenFailed'));
      }
    } catch {
      toast.error(t('publicAppRegenFailed'));
    } finally {
      setRegenSaving(false);
    }
  }, [regenToken, regenRepo, regenWorkflow, regenRef, loadRegenStatus, t]);

  const launchRegen = useCallback(async () => {
    setRegenBusy(true);
    try {
      const res = await apiFetch('/api/app-versions/regenerate-installers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: regenTargets, triggerVpsRebuild: regenVps }),
      });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success && j?.dispatched) {
        toast.success(t('publicAppRegenLaunched'));
        setRegenOpen(false);
      } else {
        const code = j?.error || 'github-dispatch-failed';
        const key =
          code === 'github-token-missing'
            ? 'publicAppRegenErrToken'
            : code === 'github-auth-failed'
              ? 'publicAppRegenErrAuth'
              : code === 'github-not-found'
                ? 'publicAppRegenErrNotFound'
                : code === 'github-ref-invalid'
                  ? 'publicAppRegenErrRef'
                  : code === 'github-repo-invalid'
                    ? 'publicAppRegenErrRepo'
                    : 'publicAppRegenFailed';
        toast.error(t(key) + (j?.detail ? ` — ${j.detail}` : ''));
      }
    } catch {
      toast.error(t('publicAppRegenFailed'));
    } finally {
      setRegenBusy(false);
    }
  }, [regenTargets, regenVps, t]);

  // ── Render ──
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4 text-primary" />
              {t('publicAppInstallersTitle')}
            </CardTitle>
            <CardDescription className="text-xs">{t('publicAppInstallersDesc')}</CardDescription>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              size="sm"
              className="h-9 flex-1 sm:flex-none"
              onClick={() => fetchFiles(true)}
              disabled={refreshing || loading}
              aria-label={t('publicAppRefresh')}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {t('publicAppRefresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 flex-1 sm:flex-none"
              onClick={() => {
                setRegenOpen(true);
                void loadRegenStatus();
              }}
              aria-label={t('publicAppRegenBtn')}
            >
              <Github className="h-4 w-4" />
              {t('publicAppRegenBtn')}
            </Button>
            <Button size="sm" className="h-9 flex-1 sm:flex-none" onClick={openUpload}>
              <Upload className="h-4 w-4" />
              {t('publicAppUploadInstaller')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filter chips — All + every platform present, with counts */}
          {!loading && installerCount > 0 && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('publicAppFilterPlatform')}>
              <Button
                size="sm"
                variant={filter === 'all' ? 'default' : 'outline'}
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => setFilter('all')}
              >
                {t('publicAppFilterAll')}
                <Badge variant="secondary" className="ms-1.5 h-4 px-1.5 text-[10px] rounded-full">
                  {installerCount}
                </Badge>
              </Button>
              {groups.map((g) => {
                const Icon = platformIcon(g.platform);
                return (
                  <Button
                    key={g.platform || 'unknown'}
                    size="sm"
                    variant={filter === g.platform ? 'default' : 'outline'}
                    className="h-8 rounded-full px-3 text-xs"
                    onClick={() => setFilter(g.platform)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {platformLabel(g.platform, lang)}
                    <Badge variant="secondary" className="ms-1.5 h-4 px-1.5 text-[10px] rounded-full">
                      {g.rows.length}
                    </Badge>
                  </Button>
                );
              })}
            </div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          )}

          {/* Error with inline retry */}
          {!loading && error && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <p className="text-sm text-destructive font-medium">{t('publicAppLoadFailed')}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">{error}</p>
              <Button variant="outline" size="sm" onClick={() => fetchFiles(true)}>
                <RefreshCw className="h-4 w-4" />
                {t('publicAppRetry')}
              </Button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && files.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <PackageOpen className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">{t('publicAppNoFiles')}</p>
              <p className="text-xs text-muted-foreground max-w-sm">{t('publicAppNoFilesHint')}</p>
            </div>
          )}

          {/* Grouped tables */}
          {!loading &&
            !error &&
            visibleGroups.map((group) => {
              const Icon = platformIcon(group.platform);
              const activeKey = activeByPlatform.get(group.platform)?.storageKey;

              return (
                <div key={group.platform || 'unknown'} className="rounded-lg border overflow-hidden">
                  <div className="flex items-center justify-between gap-2 bg-muted/50 px-3 py-2 border-b">
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-sm font-medium truncate">
                        {group.platform
                          ? platformLabel(group.platform, lang)
                          : t('publicAppUnknownPlatform')}
                      </span>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5 rounded-full shrink-0">
                        {group.rows.length}
                      </Badge>
                    </div>
                    {activeKey && (
                      <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px] h-4 px-1.5 rounded-full shrink-0">
                        <CheckCircle2 className="h-3 w-3 me-1" />
                        {t('publicAppStatusActive')}
                      </Badge>
                    )}
                  </div>

                  <div className="max-h-[420px] overflow-y-auto custom-scrollbar">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">{t('publicAppColFile')}</TableHead>
                          <TableHead className="text-xs">{t('publicAppColPushedAt')}</TableHead>
                          <TableHead className="text-xs">{t('publicAppColSize')}</TableHead>
                          <TableHead className="text-xs">{t('publicAppColVersion')}</TableHead>
                          <TableHead className="text-xs">{t('publicAppColStatus')}</TableHead>
                          <TableHead className="text-xs text-end">{t('publicAppColActions')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.rows.map((file) => {
                          const active = isActiveInstaller(file);
                          const linked = !!file.version && !active;
                          const busy = activatingKey === file.storageKey;

                          return (
                            <TableRow key={file.storageKey} className={active ? 'bg-emerald-500/5' : undefined}>
                              <TableCell className="max-w-[260px] sm:max-w-[320px]">
                                <div className="flex items-center gap-2 min-w-0">
                                  <FileArchive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                  <span className="text-xs font-mono truncate" dir="ltr" title={file.name}>
                                    {file.name}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="text-xs whitespace-nowrap">
                                {formatPushedAt(file.mtimeMs, lang)}
                              </TableCell>
                              <TableCell className="text-xs whitespace-nowrap font-mono" dir="ltr">
                                {formatFileSize(file.size)}
                              </TableCell>
                              <TableCell className="text-xs font-mono" dir="ltr">
                                {file.parsed?.version || file.version?.version || '—'}
                              </TableCell>
                              <TableCell>
                                {active ? (
                                  <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px] h-5 px-1.5">
                                    <CheckCircle2 className="h-3 w-3 me-1" />
                                    {t('publicAppStatusActive')}
                                  </Badge>
                                ) : linked ? (
                                  <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                                    <Link2 className="h-3 w-3 me-1" />
                                    {t('publicAppStatusLinked')}
                                  </Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="text-end">
                                {!active && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 text-xs"
                                    disabled={busy || !!activatingKey}
                                    onClick={() => requestActivate(file)}
                                  >
                                    {busy ? (
                                      <>
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        {t('publicAppActivating')}
                                      </>
                                    ) : (
                                      t('publicAppActivate')
                                    )}
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              );
            })}

          {/* Delta-system artifacts — internal diff references + hop patches.
              These power differential updates; they are never installable, so
              they live here instead of the platform groups above. */}
          {!loading && !error && deltaFiles.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <div className="flex items-center gap-2 bg-muted/50 px-3 py-2 border-b">
                <FileArchive className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium truncate">{t('publicAppDeltaArtifacts')}</span>
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 rounded-full shrink-0">
                  {deltaFiles.length}
                </Badge>
              </div>
              <p className="px-3 py-2 text-xs text-muted-foreground border-b">
                {t('publicAppDeltaArtifactsHint')}
              </p>
              <div className="max-h-[260px] overflow-y-auto custom-scrollbar">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">{t('publicAppDeltaColKind')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColFile')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppDeltaColServes')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColPushedAt')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColSize')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deltaFiles.map((file) => (
                      <TableRow key={file.storageKey}>
                        <TableCell>
                          <Badge variant="secondary" className="text-[10px] h-5 px-1.5 whitespace-nowrap">
                            {deltaKindLabel(file.internalKind)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[220px] sm:max-w-[280px]">
                          <span className="text-xs font-mono truncate block" dir="ltr" title={file.name}>
                            {file.name}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs font-mono" dir="ltr">
                          {file.owner ? `${file.owner.platform} ${file.owner.version}` : '—'}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatPushedAt(file.mtimeMs, lang)}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap font-mono" dir="ltr">
                          {formatFileSize(file.size)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Delta Update Manager (0.6.33) — per-platform hop generation ─── */}
      <DeltaManagerCard />

      {/* ─── Activate overwrite confirmation ─── */}
      <AlertDialog open={!!confirmFile} onOpenChange={(open) => !open && setConfirmFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('publicAppActivateConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmFile &&
                t('publicAppActivateConfirmBody')
                  .replace('{platform}', platformLabel(confirmFile.platform || confirmFile.parsed?.platform || '', lang))
                  .replace('{time}', formatPushedAt(confirmFile.mtimeMs, lang))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10">{t('publicAppCancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-10"
              disabled={!!activatingKey}
              onClick={(e) => {
                e.preventDefault();
                if (confirmFile) void doActivate(confirmFile);
              }}
            >
              {activatingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : t('publicAppActivate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Upload dialog ─── */}
      <Dialog open={uploadOpen} onOpenChange={(open) => { if (!uploading) setUploadOpen(open); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Upload className="h-4 w-4 text-primary" />
              {t('publicAppUploadInstaller')}
            </DialogTitle>
            <DialogDescription className="text-xs">{t('publicAppUploadDesc')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Drag & drop zone */}
            {!uploadFile && (
              <div
                role="button"
                tabIndex={0}
                aria-label={t('publicAppUploadDropHere')}
                className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors cursor-pointer min-h-[44px] ${
                  dragOver
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-primary/50 hover:bg-muted/40'
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
              >
                <Inbox className={`h-8 w-8 ${dragOver ? 'text-primary' : 'text-muted-foreground'}`} />
                <p className="text-sm font-medium">{t('publicAppUploadDropHere')}</p>
                <p className="text-xs text-muted-foreground">{t('publicAppUploadOrPick')}</p>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) acceptFile(f);
                e.target.value = '';
              }}
            />

            {uploadFile && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-4"
              >
                {/* Selected file summary — size + detection shown BEFORE upload */}
                <div className="flex items-start justify-between gap-2 rounded-lg border bg-muted/40 p-3">
                  <div className="min-w-0">
                    <p className="text-xs font-mono truncate" dir="ltr" title={uploadFile.name}>
                      {uploadFile.name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {t('publicAppUploadSize')}:{' '}
                      <span className="font-mono" dir="ltr">{formatFileSize(uploadFile.size)}</span>
                      {' · '}
                      {t('publicAppUploadDetected')}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs shrink-0"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {t('publicAppUploadChangeFile')}
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('publicAppUploadPlatform')}</Label>
                    <Select
                      value={form.platform}
                      onValueChange={(v) => setForm((p) => ({ ...p, platform: v as InstallerPlatform }))}
                      disabled={uploading}
                    >
                      <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppUploadPlatform')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INSTALLER_PLATFORMS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {platformLabel(p, lang)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t('publicAppUploadVersion')}</Label>
                    <Input
                      value={form.version}
                      onChange={(e) => setForm((p) => ({ ...p, version: e.target.value }))}
                      placeholder="0.3.5"
                      dir="ltr"
                      className="h-10 font-mono text-sm"
                      disabled={uploading}
                      aria-invalid={form.version.length > 0 && !isValidSemver(form.version)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppUploadVersionCode')}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.versionCode}
                    onChange={(e) => setForm((p) => ({ ...p, versionCode: e.target.value }))}
                    dir="ltr"
                    className="h-10 font-mono text-sm"
                    disabled={uploading}
                  />
                </div>

                <NotesInput
                  label={t('publicAppUploadNotes')}
                  value={form.notes}
                  onChange={(notes) => setForm((p) => ({ ...p, notes }))}
                  disabled={uploading}
                />

                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label className="text-xs font-medium">{t('publicAppUploadMandatory')}</Label>
                    <p className="text-[11px] text-muted-foreground">{t('publicAppUploadMandatoryHint')}</p>
                  </div>
                  <Switch
                    checked={form.isMandatory}
                    onCheckedChange={(checked) => setForm((p) => ({ ...p, isMandatory: checked }))}
                    disabled={uploading}
                    aria-label={t('publicAppUploadMandatory')}
                  />
                </div>

                {uploading && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('publicAppUploading')}
                      </span>
                      <span className="font-mono" dir="ltr">{uploadProgress}%</span>
                    </div>
                    <Progress value={uploadProgress} className="h-2" />
                  </div>
                )}
              </motion.div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" className="h-10" onClick={() => setUploadOpen(false)} disabled={uploading}>
              {t('publicAppCancel')}
            </Button>
            <Button className="h-10" onClick={() => void submitUpload()} disabled={!canUpload}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t('publicAppUploadStart')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerate installers — GitHub Actions dispatch dialog */}
      <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Github className="h-4 w-4 text-primary" />
              {t('publicAppRegenTitle')}
            </DialogTitle>
            <DialogDescription>{t('publicAppRegenDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm">{t('publicAppRegenTargets')}</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['all', 'desktop-only', 'mobile-only'] as const).map((v) => (
                  <Button
                    key={v}
                    type="button"
                    variant={regenTargets === v ? 'default' : 'outline'}
                    size="sm"
                    className="h-9"
                    onClick={() => setRegenTargets(v)}
                  >
                    {v === 'all' ? t('publicAppRegenAll') : v === 'desktop-only' ? t('publicAppRegenDesktop') : t('publicAppRegenMobile')}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label htmlFor="regen-vps" className="text-sm font-normal">
                {t('publicAppRegenVps')}
              </Label>
              <Switch id="regen-vps" checked={regenVps} onCheckedChange={setRegenVps} />
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">{t('publicAppRegenConfig')}</Label>
                <Badge variant={regenConfigured ? 'default' : 'destructive'} className="text-[10px]">
                  {regenStatusLoading ? '…' : regenConfigured ? t('publicAppRegenTokenConfigured') : t('publicAppRegenTokenMissing')}
                </Badge>
              </div>
              <Input
                dir="ltr"
                className="h-9 text-xs"
                placeholder="owner/repo"
                value={regenRepo}
                onChange={(e) => setRegenRepo(e.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  dir="ltr"
                  className="h-9 text-xs"
                  placeholder="publish-installers.yml"
                  value={regenWorkflow}
                  onChange={(e) => setRegenWorkflow(e.target.value)}
                />
                <Input
                  dir="ltr"
                  className="h-9 text-xs"
                  placeholder="master"
                  value={regenRef}
                  onChange={(e) => setRegenRef(e.target.value)}
                />
              </div>
              <Input
                dir="ltr"
                type="password"
                className="h-9 text-xs"
                placeholder={t('publicAppRegenToken')}
                value={regenToken}
                onChange={(e) => setRegenToken(e.target.value)}
              />
              <Button
                variant="secondary"
                size="sm"
                className="h-8 w-full text-xs"
                onClick={() => void saveRegenConfig()}
                disabled={regenSaving || (!regenToken.trim() && !regenRepo.trim() && !regenWorkflow.trim() && !regenRef.trim())}
              >
                {regenSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {t('publicAppRegenSave')}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-10" onClick={() => setRegenOpen(false)} disabled={regenBusy}>
              {t('publicAppCancel')}
            </Button>
            <Button className="h-10" onClick={() => void launchRegen()} disabled={regenBusy}>
              {regenBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
              {t('publicAppRegenLaunch')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
