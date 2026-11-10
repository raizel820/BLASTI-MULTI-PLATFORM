'use client';

/**
 * TAB 2 — Versions (AppVersion records CRUD).
 *
 * Table of GET /api/app-versions joined with GET /api/app-installs/stats
 * (byVersion) so the admin sees the REAL device count running each version.
 * Actions: Edit (notes EN/AR/FR, mandatory, publish, minAppVersion,
 * versionCode), Activate (publishes this + unpublishes siblings of the same
 * platform server-side), Delete (AlertDialog — deletes the DB row AND the
 * disk binary).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import {
  Plus,
  Pencil,
  Trash2,
  Rocket,
  Loader2,
  AlertTriangle,
  PackageX,
  ShieldCheck,
  Eraser,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
  PLATFORM_META,
  formatDate,
  formatFileSize,
  platformIcon,
  platformLabel,
  type AppVersion,
  type InstallStats,
  type StorageVersion,
} from './shared';
import { NotesInput, type NotesValue } from './notes-input';
import { INSTALLER_PLATFORMS, isValidSemver, type InstallerPlatform } from '@/lib/admin-upload';
import type { TranslationKeys } from '@/i18n';

interface VersionForm {
  platform: InstallerPlatform;
  version: string;
  versionCode: string;
  notes: NotesValue;
  isMandatory: boolean;
  isPublished: boolean;
  minAppVersion: string;
}

/** One hop of POST /api/app-versions/:id/regenerate-deltas. */
interface DeltaGenResult {
  from: string;
  to: string;
  size: number;
  ok: boolean;
  reason?: string;
}

/** Platforms the desktop release-patch pipeline covers (asar + tree patch). */
const DELTA_DESKTOP_PLATFORMS = new Set(['windows', 'mac', 'linux', 'electron']);

const EMPTY_FORM: VersionForm = {
  platform: 'android',
  version: '',
  versionCode: '0',
  notes: { en: '', ar: '', fr: '' },
  isMandatory: false,
  isPublished: false,
  minAppVersion: '',
};

/** Live response of POST /api/app-versions/cleanup-preview. */
interface CleanupPreviewPlan {
  versions: Array<{
    id: string;
    platform: string;
    version: string;
    isPublished: boolean;
    fileName: string | null;
    createdAt: string;
  }>;
  /** Every version string in scope — DB rows ∪ disk-only files (orphan). */
  scopeVersions: string[];
  installers: { count: number; bytes: number };
  refArtifacts: { count: number; bytes: number };
  deltas: { count: number; bytes: number; pairs: string[] };
  orphanedBuilds: { count: number; bytes: number };
  /** Per-version breakdown — one row per version the cleanup will touch. */
  perVersion: Array<{
    version: string;
    files: number;
    bytes: number;
    installers: number;
    refs: number;
    deltas: number;
    orphans: number;
    hasDbRow: boolean;
    isPublished: boolean;
  }>;
  totalFiles: number;
  totalBytes: number;
}

type CleanupScope = 'this' | 'with-previous';

const CLEANUP_SCOPES: Array<{ value: CleanupScope; labelKey: TranslationKeys; hintKey: TranslationKeys }> = [
  { value: 'this', labelKey: 'publicAppCleanupScopeThis', hintKey: 'publicAppCleanupScopeThisHint' },
  { value: 'with-previous', labelKey: 'publicAppCleanupScopeWithPrev', hintKey: 'publicAppCleanupScopeWithPrevHint' },
];

/** One preview line: label on the start side, value (files · size) on the end. */
function CleanupPreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 min-w-0">
      <span className="text-xs text-muted-foreground truncate">{label}</span>
      <span className="text-xs font-medium font-mono text-end truncate" dir="ltr">{value}</span>
    </div>
  );
}

export function VersionsTab() {
  const { t, lang } = useLanguage();

  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [stats, setStats] = useState<InstallStats | null>(null);
  // Disk truth: every (platform, version) the ACTUAL bucket files cover —
  // including versions whose DB rows are gone but installers/delta patches
  // remain. Feeds the Cleanup picker so old releases stay cleanable.
  const [storageVersions, setStorageVersions] = useState<StorageVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Dialog state
  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | null>(null);
  const [editing, setEditing] = useState<AppVersion | null>(null);
  const [form, setForm] = useState<VersionForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Action state
  const [activating, setActivating] = useState<AppVersion | null>(null);
  const [deleting, setDeleting] = useState<AppVersion | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 0.6.58 — delta self-heal state (admin repair of the hop patches)
  const [regenBusyId, setRegenBusyId] = useState<string | null>(null);
  const [regenDialog, setRegenDialog] = useState<{
    version: AppVersion;
    results: DeltaGenResult[];
  } | null>(null);

  // Cleanup state
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupPlatform, setCleanupPlatform] = useState<string>('');
  const [cleanupVersion, setCleanupVersion] = useState<string>('');
  const [cleanupScope, setCleanupScope] = useState<CleanupScope>('with-previous');
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreviewPlan | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [cleanupConfirm, setCleanupConfirm] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const [versionsRes, statsRes, storageRes] = await Promise.all([
        apiFetch('/api/app-versions'),
        apiFetch('/api/app-installs/stats'),
        apiFetch('/api/app-versions/storage-versions'),
      ]);
      const versionsData = await versionsRes.json().catch(() => null);
      const statsData = await statsRes.json().catch(() => null);
      const storageData = await storageRes.json().catch(() => null);

      if (versionsRes.ok && versionsData?.success) {
        setVersions(versionsData.versions || []);
        setError(null);
      } else {
        setError(versionsData?.error || `HTTP ${versionsRes.status}`);
      }
      if (statsRes.ok && statsData?.success) setStats(statsData);
      // Non-fatal: the picker falls back to the DB rows when unavailable.
      if (storageRes.ok && storageData?.success) setStorageVersions(storageData.versions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  /** Real device count per platform+version (stats.byVersion join). */
  const devicesByVersion = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of stats?.byVersion || []) {
      map.set(`${row.platform}|${row.version}`, row.devices);
    }
    return map;
  }, [stats]);

  // ── Dialog helpers ──
  const openCreate = useCallback(() => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogMode('create');
  }, []);

  const openEdit = useCallback((v: AppVersion) => {
    setEditing(v);
    setForm({
      platform: (PLATFORM_META.find((p) => p.key === v.platform)?.key || 'android') as InstallerPlatform,
      version: v.version,
      versionCode: String(v.versionCode ?? 0),
      notes: {
        en: v.releaseNotes || '',
        ar: v.releaseNotesAr || '',
        fr: v.releaseNotesFr || '',
      },
      isMandatory: !!v.isMandatory,
      isPublished: !!v.isPublished,
      minAppVersion: v.minAppVersion || '',
    });
    setDialogMode('edit');
  }, []);

  const canSave =
    dialogMode === 'edit'
      ? isValidSemver(form.version) // version editable in edit mode too (PATCH allows it)
      : INSTALLER_PLATFORMS.includes(form.platform) && isValidSemver(form.version);

  const saveVersion = useCallback(async () => {
    if (!canSave) {
      toast.error(t('publicAppVersionInvalidVersion'));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        version: form.version.trim(),
        versionCode: parseInt(form.versionCode, 10) || 0,
        releaseNotes: form.notes.en,
        releaseNotesAr: form.notes.ar || null,
        releaseNotesFr: form.notes.fr || null,
        isMandatory: form.isMandatory,
        isPublished: form.isPublished,
        minAppVersion: form.minAppVersion.trim() || null,
      };

      const res =
        dialogMode === 'edit' && editing
          ? await apiFetch(`/api/app-versions/${editing.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            })
          : await apiFetch('/api/app-versions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ platform: form.platform, ...payload }),
            });

      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(dialogMode === 'edit' ? t('publicAppVersionSaved') : t('publicAppVersionCreated'));
        setDialogMode(null);
        await fetchAll(true);
      } else {
        toast.error(t('publicAppVersionSaveFailed'), {
          description: data?.error || `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(t('publicAppVersionSaveFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }, [canSave, form, dialogMode, editing, fetchAll, t]);

  // ── Activate (publish this + server unpublishes siblings) ──
  const activateVersion = useCallback(
    async (v: AppVersion) => {
      setBusyId(v.id);
      try {
        const res = await apiFetch(`/api/app-versions/${v.id}/activate`, { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          toast.success(t('publicAppActivateVersionDone'));
          await fetchAll(true);
        } else {
          toast.error(t('publicAppActivateVersionFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppActivateVersionFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBusyId(null);
        setActivating(null);
      }
    },
    [fetchAll, t],
  );

  // ── Delete (deletes the record AND its disk file) ──
  const deleteVersion = useCallback(
    async (v: AppVersion) => {
      setBusyId(v.id);
      try {
        const res = await apiFetch(`/api/app-versions/${v.id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          toast.success(t('publicAppDeleteDone'));
          await fetchAll(true);
        } else {
          toast.error(t('publicAppDeleteFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppDeleteFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setBusyId(null);
        setDeleting(null);
      }
    },
    [fetchAll, t],
  );

  // ── 0.6.58 — Regenerate delta patches (self-heal) ──
  // Rebuilds every hop (previous releases → this version) from the stored
  // release refs. This is the ONE-CLICK repair for "delta: null
  // (no-deltas-published)" — previously only reachable via a CLI script that
  // needed the VPS deploy token.
  const regenerateDeltas = useCallback(
    async (v: AppVersion) => {
      setRegenBusyId(v.id);
      try {
        const res = await apiFetch(`/api/app-versions/${v.id}/regenerate-deltas`, { method: 'POST' });
        const data = await res.json().catch(() => null);
        const results: DeltaGenResult[] = Array.isArray(data?.results) ? data.results : [];
        if (res.ok && data?.success) {
          const okCount = results.filter((r) => r.ok).length;
          if (results.length > 0) {
            setRegenDialog({ version: v, results });
            if (okCount > 0) toast.success(t('publicAppRegenDeltasDone').replace('{count}', String(okCount)));
            else toast.warning(t('publicAppRegenDeltasNone'));
          } else {
            toast.info(t('publicAppRegenDeltasEmpty'));
          }
        } else {
          toast.error(t('publicAppRegenDeltasFailed'), {
            description: data?.error || `HTTP ${res.status}`,
          });
        }
      } catch (err) {
        toast.error(t('publicAppRegenDeltasFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setRegenBusyId(null);
      }
    },
    [t],
  );

  // ── Cleanup (installers + delta patches of the selected scope) ──
  // Pickers are fed from the DISK inventory (storage-versions) so versions
  // that exist only as files on disk stay cleanable; the DB rows are the
  // fallback when the disk inventory is unavailable.
  const cleanupPlatforms = useMemo(() => {
    const fromDisk = [...new Set(storageVersions.map((v) => v.platform))];
    if (fromDisk.length > 0) return fromDisk;
    return [...new Set(versions.map((v) => v.platform))];
  }, [storageVersions, versions]);
  const cleanupVersionsForPlatform = useMemo(() => {
    const disk = storageVersions.filter((v) => v.platform === cleanupPlatform);
    if (disk.length > 0) return disk;
    return versions
      .filter((v) => v.platform === cleanupPlatform)
      .map((v) => ({
        platform: v.platform,
        version: v.version,
        installers: { count: v.fileStorageKey ? 1 : 0, bytes: v.fileSize ?? 0 },
        deltas: { count: 0, bytes: 0 },
        refs: { count: 0, bytes: 0 },
        dbDeltaRows: 0,
        totalFiles: v.fileStorageKey ? 1 : 0,
        totalBytes: v.fileSize ?? 0,
        latestMtimeMs: 0,
        hasDbRow: true,
        isPublished: !!v.isPublished,
        dbId: v.id,
        dbFileName: v.fileName ?? null,
      }));
  }, [storageVersions, versions, cleanupPlatform]);

  const openCleanup = useCallback(() => {
    const firstPlatform = cleanupPlatforms[0] ?? '';
    const firstVersion = cleanupVersionsForPlatform.find((v) => v.platform === firstPlatform)?.version ?? '';
    setCleanupPlatform(firstPlatform);
    setCleanupVersion(firstVersion);
    setCleanupScope('with-previous');
    setCleanupPreview(null);
    setPreviewError(false);
    setCleanupConfirm(false);
    setCleanupOpen(true);
  }, [cleanupPlatforms, cleanupVersionsForPlatform]);

  // Live preview: refetched whenever the selection changes (cancelled on change).
  useEffect(() => {
    if (!cleanupOpen || !cleanupPlatform || !cleanupVersion) {
      setCleanupPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(false);
    apiFetch('/api/app-versions/cleanup-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: cleanupPlatform, version: cleanupVersion, scope: cleanupScope }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && data?.success) {
          setCleanupPreview(data.plan as CleanupPreviewPlan);
          setPreviewError(false);
        } else {
          setCleanupPreview(null);
          setPreviewError(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCleanupPreview(null);
          setPreviewError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cleanupOpen, cleanupPlatform, cleanupVersion, cleanupScope]);

  const runCleanup = useCallback(async () => {
    setCleanupBusy(true);
    try {
      const res = await apiFetch('/api/app-versions/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: cleanupPlatform,
          version: cleanupVersion,
          scope: cleanupScope,
          confirm: 'CLEANUP',
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(t('publicAppCleanupDone'), {
          description: t('publicAppCleanupDoneDesc', {
            versions: String(data.deletedVersions ?? 0),
            deltas: String(data.deletedDeltas ?? 0),
            files: String(data.deletedFiles ?? 0),
          }),
        });
        setCleanupConfirm(false);
        setCleanupOpen(false);
        await fetchAll(true);
      } else {
        toast.error(t('publicAppCleanupFailed'), {
          description: data?.error || `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(t('publicAppCleanupFailed'), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCleanupBusy(false);
    }
  }, [cleanupPlatform, cleanupVersion, cleanupScope, fetchAll, t]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Rocket className="h-4 w-4 text-primary" />
              {t('publicAppVersionsTitle')}
            </CardTitle>
            <CardDescription className="text-xs">{t('publicAppVersionsDesc')}</CardDescription>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              size="sm"
              variant="outline"
              className="h-9 w-full sm:w-auto"
              onClick={openCleanup}
              disabled={loading || cleanupPlatforms.length === 0}
            >
              <Eraser className="h-4 w-4" />
              {t('publicAppCleanup')}
            </Button>
            <Button size="sm" className="h-9 w-full sm:w-auto" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              {t('publicAppNewVersion')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-3/4" />
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <p className="text-sm text-destructive font-medium">{t('publicAppLoadFailed')}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">{error}</p>
              <Button variant="outline" size="sm" onClick={() => fetchAll(true)}>
                {t('publicAppRetry')}
              </Button>
            </div>
          )}

          {!loading && !error && versions.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <PackageX className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">{t('publicAppNoVersions')}</p>
              <p className="text-xs text-muted-foreground max-w-sm">{t('publicAppNoVersionsHint')}</p>
            </div>
          )}

          {!loading && !error && versions.length > 0 && (
            <div className="max-h-[480px] overflow-y-auto custom-scrollbar rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="text-xs">{t('publicAppColPlatform')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppColVersion')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppColStatus')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppColPublished')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppColDownloads')}</TableHead>
                    <TableHead className="text-xs">{t('publicAppColDevices')}</TableHead>
                    <TableHead className="text-xs text-end">{t('publicAppColActions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => {
                    const Icon = platformIcon(v.platform);
                    const devices = devicesByVersion.get(`${v.platform}|${v.version}`) ?? 0;
                    const busy = busyId === v.id;

                    return (
                      <TableRow key={v.id}>
                        <TableCell>
                          <div className="flex items-center gap-2 min-w-0">
                            <Icon className="h-4 w-4 text-primary shrink-0" />
                            <span className="text-xs font-medium truncate">
                              {platformLabel(v.platform, lang)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-xs font-mono font-medium" dir="ltr">{v.version}</span>
                            <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                              #{v.versionCode ?? 0}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            {v.isPublished ? (
                              <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px] h-5 px-1.5">
                                <ShieldCheck className="h-3 w-3 me-1" />
                                {t('publicAppStatusActive')}
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                                {t('publicAppStatusDraft')}
                              </Badge>
                            )}
                            {v.isMandatory && (
                              <Badge variant="destructive" className="text-[10px] h-5 px-1.5">
                                {t('publicAppBadgeMandatory')}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {formatDate(v.publishedAt, lang)}
                        </TableCell>
                        <TableCell className="text-xs font-mono" dir="ltr">
                          {v.downloadCount ?? 0}
                        </TableCell>
                        <TableCell className="text-xs font-mono" dir="ltr">
                          {devices}
                        </TableCell>
                        <TableCell className="text-end">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              aria-label={t('publicAppEditVersion')}
                              disabled={busy}
                              onClick={() => openEdit(v)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {/* 0.6.58 — one-click delta self-heal (desktop pipeline
                                only; android hops rebuild at activation). */}
                            {DELTA_DESKTOP_PLATFORMS.has(v.platform) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                aria-label={t('publicAppRegenDeltas')}
                                title={t('publicAppRegenDeltas')}
                                disabled={busy || !!regenBusyId}
                                onClick={() => void regenerateDeltas(v)}
                              >
                                {regenBusyId === v.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            )}
                            {!v.isPublished && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                disabled={busy || !!busyId}
                                onClick={() => setActivating(v)}
                              >
                                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('publicAppActivate')}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                              aria-label={t('publicAppDeleteVersion')}
                              disabled={busy || !!busyId}
                              onClick={() => setDeleting(v)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Create / Edit dialog ─── */}
      <Dialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) setDialogMode(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="text-base">
              {dialogMode === 'edit' ? t('publicAppEditVersion') : t('publicAppNewVersion')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {dialogMode === 'edit'
                ? t('publicAppEditDesc')
                : t('publicAppCreateDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {dialogMode === 'create' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppUploadPlatform')}</Label>
                  <Select
                    value={form.platform}
                    onValueChange={(v) => setForm((p) => ({ ...p, platform: v as InstallerPlatform }))}
                    disabled={saving}
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
                    placeholder="0.3.6"
                    dir="ltr"
                    className="h-10 font-mono text-sm"
                    disabled={saving}
                    aria-invalid={form.version.length > 0 && !isValidSemver(form.version)}
                  />
                </div>
              </div>
            )}

            {dialogMode === 'edit' && editing && (
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 p-3">
                <div className="flex items-center gap-2 min-w-0">
                  {(() => {
                    const Icon = platformIcon(editing.platform);
                    return <Icon className="h-4 w-4 text-primary shrink-0" />;
                  })()}
                  <span className="text-sm font-medium">{platformLabel(editing.platform, lang)}</span>
                  <span className="text-xs font-mono text-muted-foreground" dir="ltr">{editing.version}</span>
                </div>
                {editing.fileSize != null && (
                  <span className="text-xs text-muted-foreground font-mono" dir="ltr">
                    {formatFileSize(editing.fileSize)}
                  </span>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppUploadVersionCode')}</Label>
              <Input
                type="number"
                min={0}
                value={form.versionCode}
                onChange={(e) => setForm((p) => ({ ...p, versionCode: e.target.value }))}
                dir="ltr"
                className="h-10 font-mono text-sm"
                disabled={saving}
              />
            </div>

            <NotesInput
              label={t('publicAppUploadNotes')}
              value={form.notes}
              onChange={(notes) => setForm((p) => ({ ...p, notes }))}
              disabled={saving}
            />

            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppMinAppVersion')}</Label>
              <Input
                value={form.minAppVersion}
                onChange={(e) => setForm((p) => ({ ...p, minAppVersion: e.target.value }))}
                placeholder="0.3.0"
                dir="ltr"
                className="h-10 font-mono text-sm"
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <Label className="text-xs font-medium">{t('publicAppBadgeMandatory')}</Label>
              <Switch
                checked={form.isMandatory}
                onCheckedChange={(checked) => setForm((p) => ({ ...p, isMandatory: checked }))}
                disabled={saving}
                aria-label={t('publicAppBadgeMandatory')}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label className="text-xs font-medium">{t('publicAppPublishSwitch')}</Label>
                <p className="text-[11px] text-muted-foreground">{t('publicAppPublishSwitchHint')}</p>
              </div>
              <Switch
                checked={form.isPublished}
                onCheckedChange={(checked) => setForm((p) => ({ ...p, isPublished: checked }))}
                disabled={saving}
                aria-label={t('publicAppPublishSwitch')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" className="h-10" onClick={() => setDialogMode(null)} disabled={saving}>
              {t('publicAppCancel')}
            </Button>
            <Button className="h-10" onClick={() => void saveVersion()} disabled={saving || !canSave}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('publicAppSave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Activate confirmation (unpublishes other versions) ─── */}
      <AlertDialog open={!!activating} onOpenChange={(open) => !open && setActivating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('publicAppActivateVersionConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {activating
                ? t('publicAppActivateVersionConfirmBody')
                    .replace('{platform}', platformLabel(activating.platform, lang))
                    .replace('{version}', activating.version)
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10">{t('publicAppCancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-10"
              disabled={!!busyId}
              onClick={(e) => {
                e.preventDefault();
                if (activating) void activateVersion(activating);
              }}
            >
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : t('publicAppActivate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete confirmation (disk binary deleted too) ─── */}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('publicAppDeleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? t('publicAppDeleteConfirmBody')
                    .replace('{platform}', platformLabel(deleting.platform, lang))
                    .replace('{version}', deleting.version)
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10">{t('publicAppCancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="h-10 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!!busyId}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) void deleteVersion(deleting);
              }}
            >
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : t('publicAppDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── 0.6.58 — Delta regeneration results ─── */}
      <Dialog open={!!regenDialog} onOpenChange={(open) => { if (!open) setRegenDialog(null); }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <RefreshCw className="h-4 w-4 text-primary" />
              {t('publicAppRegenDeltasTitle')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {regenDialog
                ? t('publicAppRegenDeltasDesc')
                    .replace('{platform}', platformLabel(regenDialog.version.platform, lang))
                    .replace('{version}', regenDialog.version.version)
                : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {regenDialog?.results.map((r) => (
              <div
                key={`${r.from}->${r.to}`}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Badge
                    className={
                      r.ok
                        ? 'bg-emerald-600 hover:bg-emerald-600 text-[10px] h-5 px-1.5'
                        : 'bg-amber-600 hover:bg-amber-600 text-[10px] h-5 px-1.5'
                    }
                  >
                    {r.ok ? t('publicAppRegenDeltasGenerated') : t('publicAppRegenDeltasRefused')}
                  </Badge>
                  <span className="text-sm font-mono" dir="ltr">
                    {r.from} → {r.to}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground shrink-0" dir="ltr">
                  {r.ok
                    ? formatFileSize(r.size)
                    : r.reason || '—'}
                </div>
              </div>
            ))}
            {regenDialog && regenDialog.results.some((r) => !r.ok) && (
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t('publicAppRegenDeltasHint')}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" className="h-10" onClick={() => setRegenDialog(null)}>
              {t('publicAppCancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Cleanup dialog (installers + delta patches of the selected scope) ───
          Wide two-column layout: selection on the start side, live preview
          (aggregate + per-version breakdown table) on the end side. */}
      <Dialog open={cleanupOpen} onOpenChange={(open) => { if (!open) setCleanupOpen(false); }}>
        <DialogContent className="max-w-4xl w-[calc(100vw-2rem)] max-h-[92vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Eraser className="h-4 w-4 text-primary" />
              {t('publicAppCleanupTitle')}
            </DialogTitle>
            <DialogDescription className="text-xs">{t('publicAppCleanupDesc')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
            {/* ── column 1 (start): platform / version / scope selection ── */}
            <div className="space-y-4">
              {/* platform + version — fed from the DISK inventory, so versions
                  that exist only as files (no DB row) stay selectable */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppCleanupPlatform')}</Label>
                  <Select
                    value={cleanupPlatform}
                    onValueChange={(v) => {
                      setCleanupPlatform(v);
                      const next = storageVersions.find((x) => x.platform === v);
                      setCleanupVersion(next?.version ?? '');
                    }}
                  >
                    <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppCleanupPlatform')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {cleanupPlatforms.map((p) => (
                        <SelectItem key={p} value={p}>
                          {platformLabel(p, lang)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppCleanupVersion')}</Label>
                  <Select value={cleanupVersion} onValueChange={setCleanupVersion}>
                    <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppCleanupVersion')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {cleanupVersionsForPlatform.map((v) => (
                        <SelectItem key={`${v.platform}|${v.version}`} value={v.version}>
                          <span className="flex items-center gap-1.5">
                            <span className="font-mono" dir="ltr">{v.version}</span>
                            {v.isPublished ? (
                              <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[9px] h-4 px-1 rounded-full">
                                {t('publicAppStatusActive')}
                              </Badge>
                            ) : !v.hasDbRow ? (
                              <Badge variant="secondary" className="text-[9px] h-4 px-1 rounded-full">
                                {t('publicAppCleanupFilesOnly')}
                              </Badge>
                            ) : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {cleanupVersion && (
                    <p className="text-[11px] text-muted-foreground" dir="ltr">
                      {(() => {
                        const sel = cleanupVersionsForPlatform.find((x) => x.version === cleanupVersion);
                        if (!sel) return null;
                        return t('publicAppCleanupFiles', {
                          count: String(sel.totalFiles),
                          size: formatFileSize(sel.totalBytes),
                        });
                      })()}
                    </p>
                  )}
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">{t('publicAppCleanupDiskHint')}</p>

              {/* scope */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t('publicAppCleanupScope')}</Label>
                <div className="space-y-2" role="radiogroup" aria-label={t('publicAppCleanupScope')}>
                  {CLEANUP_SCOPES.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={cleanupScope === opt.value}
                      onClick={() => setCleanupScope(opt.value)}
                      className={`w-full rounded-lg border p-3 text-start transition-all ${
                        cleanupScope === opt.value
                          ? 'border-destructive/60 bg-destructive/5'
                          : 'hover:bg-muted/50'
                      }`}
                    >
                      <span className="block text-xs font-semibold">{t(opt.labelKey)}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{t(opt.hintKey)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ── column 2 (end): live preview — aggregate + per-version table ── */}
            <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                {t('publicAppCleanupPreviewTitle')}
              </p>
              {previewLoading && (
                <div className="flex items-center gap-2 py-1.5 text-xs text-muted-foreground" aria-busy="true">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              )}
              {!previewLoading && previewError && (
                <p className="text-xs text-destructive">{t('publicAppCleanupPreviewFailed')}</p>
              )}
              {!previewLoading && !previewError && cleanupPreview && cleanupPreview.totalFiles === 0 && (
                <p className="text-xs text-muted-foreground">{t('publicAppCleanupNothing')}</p>
              )}
              {!previewLoading && !previewError && cleanupPreview && cleanupPreview.totalFiles > 0 && (
                <div className="space-y-3">
                  {/* aggregate summary — every artifact class the run removes */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                    <CleanupPreviewRow
                      label={t('publicAppCleanupInstallers')}
                      value={t('publicAppCleanupFiles', {
                        count: String(cleanupPreview.installers.count),
                        size: formatFileSize(cleanupPreview.installers.bytes),
                      })}
                    />
                    {cleanupPreview.deltas.count > 0 && (
                      <CleanupPreviewRow
                        label={t('publicAppCleanupDeltas')}
                        value={t('publicAppCleanupFiles', {
                          count: String(cleanupPreview.deltas.count),
                          size: formatFileSize(cleanupPreview.deltas.bytes),
                        })}
                      />
                    )}
                    {cleanupPreview.refArtifacts.count > 0 && (
                      <CleanupPreviewRow
                        label={t('publicAppCleanupRefs')}
                        value={t('publicAppCleanupFiles', {
                          count: String(cleanupPreview.refArtifacts.count),
                          size: formatFileSize(cleanupPreview.refArtifacts.bytes),
                        })}
                      />
                    )}
                    {cleanupPreview.orphanedBuilds.count > 0 && (
                      <CleanupPreviewRow
                        label={t('publicAppCleanupOrphans')}
                        value={t('publicAppCleanupFiles', {
                          count: String(cleanupPreview.orphanedBuilds.count),
                          size: formatFileSize(cleanupPreview.orphanedBuilds.bytes),
                        })}
                      />
                    )}
                  </div>

                  {cleanupPreview.deltas.pairs?.length > 0 && (
                    <p className="text-[11px] text-muted-foreground truncate" dir="ltr" title={cleanupPreview.deltas.pairs.join(', ')}>
                      {cleanupPreview.deltas.pairs.join(', ')}
                    </p>
                  )}

                  {/* per-version breakdown — exactly what the run will erase */}
                  <div className="rounded-md border bg-background">
                    <p className="px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">
                      {t('publicAppCleanupPerVersion')}
                    </p>
                    <div className="max-h-52 overflow-y-auto custom-scrollbar">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-[11px] h-8">{t('publicAppCleanupColVersion')}</TableHead>
                            <TableHead className="text-[11px] h-8 text-end">{t('publicAppCleanupColFiles')}</TableHead>
                            <TableHead className="text-[11px] h-8 text-end">{t('publicAppCleanupColSize')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(cleanupPreview.perVersion ?? []).map((row) => (
                            <TableRow key={row.version}>
                              <TableCell className="py-1.5">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="text-xs font-mono" dir="ltr">{row.version}</span>
                                  {row.isPublished ? (
                                    <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[9px] h-4 px-1 rounded-full shrink-0">
                                      {t('publicAppStatusActive')}
                                    </Badge>
                                  ) : !row.hasDbRow ? (
                                    <Badge variant="secondary" className="text-[9px] h-4 px-1 rounded-full shrink-0">
                                      {t('publicAppCleanupFilesOnly')}
                                    </Badge>
                                  ) : null}
                                </div>
                              </TableCell>
                              <TableCell className="py-1.5 text-end text-xs font-mono" dir="ltr">
                                {row.files}
                              </TableCell>
                              <TableCell className="py-1.5 text-end text-xs font-mono" dir="ltr">
                                {formatFileSize(row.bytes)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t pt-2">
                    <span className="text-xs font-semibold">{t('publicAppCleanupTotal')}</span>
                    <span className="text-xs font-bold font-mono text-destructive" dir="ltr">
                      {formatFileSize(cleanupPreview.totalBytes)}
                      <span className="ms-2 font-sans font-normal text-muted-foreground">
                        {t('publicAppCleanupFileCount', { count: String(cleanupPreview.totalFiles) })}
                      </span>
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" className="h-10" onClick={() => setCleanupOpen(false)} disabled={cleanupBusy}>
              {t('publicAppCancel')}
            </Button>
            <Button
              className="h-10 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={previewLoading || previewError || !cleanupPreview || cleanupPreview.totalFiles === 0}
              onClick={() => setCleanupConfirm(true)}
            >
              <Eraser className="h-4 w-4" />
              {t('publicAppCleanupExecute')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Cleanup confirmation ─── */}
      <AlertDialog open={cleanupConfirm} onOpenChange={(open) => !open && setCleanupConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('publicAppCleanupConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cleanupPreview && cleanupPreview.totalFiles > 0
                ? `${t('publicAppCleanupConfirmBody')}\n\n${t('publicAppCleanupVersionsLabel')}: ${
                    (cleanupPreview.scopeVersions?.length
                      ? cleanupPreview.scopeVersions
                      : cleanupPreview.versions.map((v) => v.version)
                    )
                    .map((version) => `${platformLabel(cleanupPlatform, lang)} ${version}`)
                    .join(', ')}`
                : t('publicAppCleanupConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10" disabled={cleanupBusy}>
              {t('publicAppCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-10 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={cleanupBusy}
              onClick={(e) => {
                e.preventDefault();
                void runCleanup();
              }}
            >
              {cleanupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('publicAppCleanupExecute')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
