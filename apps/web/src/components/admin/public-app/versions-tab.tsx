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
  Stethoscope,
  Wrench,
  ShieldAlert,
  CheckCircle2,
  XCircle,
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
import { VersionCleanerDialog } from './version-cleaner-dialog';

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
  /** 0.6.59 — true when the hop was generated via allowFingerprintRisk. */
  overridden?: boolean;
  reason?: string;
}

// ─── 0.6.59 — Delta Health (GET /api/app-versions/delta-health) ────────────

interface DeltaHealthHop {
  from: string;
  fromVersionId: string;
  fromCreatedAt: string;
  guards: {
    verdict: 'ready' | 'refused';
    reason: string | null;
    /** 0.6.59 — fingerprint refusals are consciously overridable. */
    overridable: boolean;
    /** 0.6.59 — fingerprint definition eras of both rows (v1/v2/v3). */
    prevSpec: string;
    targetSpec: string;
    prevRefs: {
      asarKey: string | null;
      outrefKey: string | null;
      apkKey: string | null;
      runtimeKey: string | null;
      nativeFingerprint: string | null;
      legacyNativeFingerprint: string | null;
    };
  };
  deltaRow: { id: string; fileName: string; fileSize: number; fileHash: string; createdAt: string } | null;
  deltaFileOnDisk: boolean | null;
  deltaSizeMatchesDisk: boolean | null;
  clientChain: { reachable: boolean; hopCount: number; reason: string };
}

interface DeltaHealthPlatform {
  platform: string;
  note?: string;
  target: {
    id: string;
    version: string;
    isPublished: boolean;
    publishedAt: string | null;
    runtimeKey: string | null;
    nativeFingerprint: string | null;
    legacyNativeFingerprint: string | null;
    fingerprintSpec: string | null;
    asarKey: string | null;
    asarOnDisk: boolean | null;
    outrefKey: string | null;
    outrefOnDisk: boolean | null;
    apkKey: string | null;
    apkOnDisk: boolean | null;
  } | null;
  hops: DeltaHealthHop[];
  totalDeltaRows: number;
  lastAudit: { at: string; generated: number; refusals: number; results: DeltaGenResult[] } | null;
}

interface DeltaHealthPayload {
  server: { apiVersion: string; now: string };
  platforms: DeltaHealthPlatform[];
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

  // 0.6.59 — Delta Health diagnosis dialog
  const [healthOpen, setHealthOpen] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthData, setHealthData] = useState<DeltaHealthPayload | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthRepairBusy, setHealthRepairBusy] = useState<string | null>(null);

  // Cleanup dialog — all cleanup state + preview/cleanup fetches live in
  // version-cleaner-dialog.tsx; only the open flag stays here.
  const [cleanupOpen, setCleanupOpen] = useState(false);

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

  // ── 0.6.59 — Delta Health: WHY is a platform serving full installers? ──
  const fetchDeltaHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const res = await apiFetch('/api/app-versions/delta-health');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setHealthData({ server: data.server, platforms: data.platforms || [] });
      } else {
        setHealthError(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const openDeltaHealth = useCallback(() => {
    setHealthData(null);
    setHealthOpen(true);
    void fetchDeltaHealth();
  }, [fetchDeltaHealth]);

  /** Repair button inside the health dialog: rebuild hops for a target id. */
  const repairFromHealth = useCallback(
    async (targetId: string, version: string, allowFingerprintRisk = false) => {
      setHealthRepairBusy(targetId);
      try {
        const res = await apiFetch(
          `/api/app-versions/${targetId}/regenerate-deltas${allowFingerprintRisk ? '?allowFingerprintRisk=1' : ''}`,
          { method: 'POST' },
        );
        const data = await res.json().catch(() => null);
        const results: DeltaGenResult[] = Array.isArray(data?.results) ? data.results : [];
        const okCount = results.filter((r) => r.ok).length;
        const overriddenCount = results.filter((r) => r.ok && r.overridden).length;
        if (res.ok && data?.success) {
          if (okCount > 0) {
            toast.success(
              overriddenCount > 0
                ? t('publicAppDeltaHealthOverrideDone').replace('{count}', String(overriddenCount))
                : t('publicAppRegenDeltasDone').replace('{count}', String(okCount)),
            );
          } else {
            toast.warning(t('publicAppRegenDeltasNone'));
          }
          await fetchDeltaHealth();
        } else {
          toast.error(t('publicAppRegenDeltasFailed'), { description: data?.error || `HTTP ${res.status}` });
        }
      } catch (err) {
        toast.error(t('publicAppRegenDeltasFailed'), {
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setHealthRepairBusy(null);
      }
    },
    [fetchDeltaHealth, t],
  );

  // ── Cleanup trigger gate — platforms known to the DISK inventory
  // (storage-versions), DB rows as fallback. The full picker derivation, the
  // preview/cleanup fetches and all dialog state live in
  // version-cleaner-dialog.tsx.
  const cleanupPlatforms = useMemo(() => {
    const fromDisk = [...new Set(storageVersions.map((v) => v.platform))];
    if (fromDisk.length > 0) return fromDisk;
    return [...new Set(versions.map((v) => v.platform))];
  }, [storageVersions, versions]);

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
              onClick={openDeltaHealth}
              disabled={loading}
            >
              {healthLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}
              {t('publicAppDeltaHealth')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 w-full sm:w-auto"
              onClick={() => setCleanupOpen(true)}
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

      {/* ─── 0.6.59 — Delta Health diagnosis ───
          Per-platform hop matrix: guard verdicts + delta row/disk status +
          the client-side chain result — answers "why full installers?". */}
      <Dialog open={healthOpen} onOpenChange={(open) => { if (!open) setHealthOpen(false); }}>
        <DialogContent className="max-w-2xl w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Stethoscope className="h-4 w-4 text-primary" />
              {t('publicAppDeltaHealthTitle')}
            </DialogTitle>
            <DialogDescription className="text-xs">{t('publicAppDeltaHealthDesc')}</DialogDescription>
          </DialogHeader>

          {healthLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('publicAppDeltaHealthChecking')}
            </div>
          )}

          {!healthLoading && healthError && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-sm text-destructive font-medium">{t('publicAppDeltaHealthFailed')}</p>
              <p className="text-xs text-muted-foreground" dir="ltr">{healthError}</p>
              <Button variant="outline" size="sm" onClick={() => void fetchDeltaHealth()}>
                {t('publicAppRetry')}
              </Button>
            </div>
          )}

          {!healthLoading && healthData && healthData.platforms.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('publicAppDeltaHealthEmpty')}</p>
          )}

          {!healthLoading && healthData && (
            <div className="space-y-4">
              <p className="text-[11px] text-muted-foreground" dir="ltr">
                API v{healthData.server.apiVersion} · {new Date(healthData.server.now).toLocaleString()}
              </p>
              {healthData.platforms.map((p) => {
                const ready = p.hops.filter((h) => h.guards.verdict === 'ready').length;
                const served = p.hops.filter((h) => h.clientChain.reachable).length;
                // 0.6.59 — hops refused ONLY by the fingerprint guard can be
                // consciously overridden (allowFingerprintRisk=1).
                const overridable = p.hops.filter((h) => !h.clientChain.reachable && h.guards.verdict === 'refused' && h.guards.overridable).length;
                const Icon = platformIcon(p.platform);
                return (
                  <div key={p.platform} className="rounded-lg border p-3 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className="h-4 w-4 text-primary shrink-0" />
                        <span className="text-sm font-semibold">{platformLabel(p.platform, lang)}</span>
                        {p.target && (
                          <Badge variant="outline" className="text-[10px] font-mono h-5 px-1.5" dir="ltr">
                            v{p.target.version}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant="secondary" className="text-[10px] h-5">{t('publicAppDeltaHealthRows')}: {p.totalDeltaRows}</Badge>
                        <Badge
                          className={`text-[10px] h-5 px-1.5 ${served > 0 ? 'bg-emerald-600 hover:bg-emerald-600' : 'bg-amber-600 hover:bg-amber-600'}`}
                        >
                          {served > 0
                            ? t('publicAppDeltaHealthServed').replace('{count}', String(served))
                            : t('publicAppDeltaHealthNoneServed')}
                        </Badge>
                        {p.target && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            disabled={healthRepairBusy === p.target.id}
                            onClick={() => void repairFromHealth(p.target!.id, p.target!.version)}
                          >
                            {healthRepairBusy === p.target.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                            {t('publicAppDeltaHealthRepair')}
                          </Button>
                        )}
                        {p.target && overridable > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-amber-500/50 text-amber-700 dark:text-amber-400"
                            disabled={healthRepairBusy === p.target.id}
                            onClick={() => {
                              if (window.confirm(t('publicAppDeltaHealthOverrideConfirm').replace('{count}', String(overridable)))) {
                                void repairFromHealth(p.target!.id, p.target!.version, true);
                              }
                            }}
                          >
                            {healthRepairBusy === p.target.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldAlert className="h-3 w-3" />}
                            {t('publicAppDeltaHealthOverride')}
                          </Button>
                        )}
                      </div>
                    </div>

                    {p.note && <p className="text-xs text-muted-foreground">{t('publicAppDeltaHealthNoPublished')}</p>}

                    {p.target && (
                      <div className="flex flex-wrap gap-1.5">
                        {DELTA_DESKTOP_PLATFORMS.has(p.platform) ? (
                          <>
                            <Badge variant={p.target.asarOnDisk ? 'secondary' : 'destructive'} className="text-[10px] h-5 gap-1">
                              {p.target.asarOnDisk ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                              asar {p.target.asarOnDisk ? t('publicAppDeltaHealthOnDisk') : t('publicAppDeltaHealthMissing')}
                            </Badge>
                            <Badge variant={p.target.outrefOnDisk ? 'secondary' : 'destructive'} className="text-[10px] h-5 gap-1">
                              {p.target.outrefOnDisk ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                              outref {p.target.outrefOnDisk ? t('publicAppDeltaHealthOnDisk') : t('publicAppDeltaHealthMissing')}
                            </Badge>
                          </>
                        ) : (
                          <Badge variant={p.target.apkOnDisk ? 'secondary' : 'destructive'} className="text-[10px] h-5 gap-1">
                            {p.target.apkOnDisk ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                            APK {p.target.apkOnDisk ? t('publicAppDeltaHealthOnDisk') : t('publicAppDeltaHealthMissing')}
                          </Badge>
                        )}
                      </div>
                    )}

                    {p.hops.length > 0 && (
                      <div className="rounded-md border overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-[10px] py-1.5">{t('publicAppDeltaHealthHop')}</TableHead>
                              <TableHead className="text-[10px] py-1.5">{t('publicAppDeltaHealthGuards')}</TableHead>
                              <TableHead className="text-[10px] py-1.5">{t('publicAppDeltaHealthPatch')}</TableHead>
                              <TableHead className="text-[10px] py-1.5">{t('publicAppDeltaHealthClient')}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {p.hops.map((h) => (
                              <TableRow key={h.from}>
                                <TableCell className="py-1.5">
                                  <span className="text-[11px] font-mono" dir="ltr">{h.from} → v{p.target?.version}</span>
                                </TableCell>
                                <TableCell className="py-1.5">
                                  <div className="flex items-center gap-1">
                                    {h.guards.verdict === 'ready' ? (
                                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                                    ) : h.guards.overridable ? (
                                      <ShieldAlert className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                                    ) : (
                                      <XCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                                    )}
                                    <span className="text-[10px] font-mono text-muted-foreground truncate" dir="ltr" title={h.guards.reason ?? ''}>
                                      {h.guards.reason ?? 'ready'}
                                    </span>
                                    {h.guards.verdict === 'refused' && h.guards.overridable && (
                                      <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-500/40 text-amber-700 dark:text-amber-400 shrink-0">
                                        {t('publicAppDeltaHealthOverridable')}
                                      </Badge>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="py-1.5">
                                  {h.deltaRow ? (
                                    h.deltaFileOnDisk === false ? (
                                      <Badge variant="destructive" className="text-[10px] h-5 px-1.5">{t('publicAppDeltaHealthMissing')}</Badge>
                                    ) : (
                                      <span className="text-[10px] font-mono text-muted-foreground" dir="ltr">
                                        {formatFileSize(h.deltaRow.fileSize)}
                                      </span>
                                    )
                                  ) : (
                                    <span className="text-[10px] text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                                <TableCell className="py-1.5">
                                  {h.clientChain.reachable ? (
                                    <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[10px] h-5 px-1.5">
                                      {t('publicAppDeltaHealthDelta').replace('{count}', String(h.clientChain.hopCount))}
                                    </Badge>
                                  ) : (
                                    <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono" dir="ltr" title={h.clientChain.reason}>
                                      {t('publicAppDeltaHealthFull')}
                                    </Badge>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    {p.lastAudit && (
                      <p className="text-[10px] text-muted-foreground" dir="ltr">
                        {t('publicAppDeltaHealthAudit')
                          .replace('{at}', new Date(p.lastAudit.at).toLocaleString())
                          .replace('{ok}', String(p.lastAudit.generated))
                          .replace('{refused}', String(p.lastAudit.refusals))}
                      </p>
                    )}

                    {ready === 0 && p.hops.length > 0 && overridable === 0 && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{t('publicAppDeltaHealthHint')}</p>
                    )}
                    {overridable > 0 && (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-relaxed">{t('publicAppDeltaHealthOverrideHint')}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-between">
              <Button variant="outline" className="h-9" onClick={() => void fetchDeltaHealth()} disabled={healthLoading}>
                <RefreshCw className="h-4 w-4" />
                {t('publicAppRefresh')}
              </Button>
              <Button variant="outline" className="h-9" onClick={() => setHealthOpen(false)}>
                {t('publicAppCancel')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Cleanup dialog — redesigned (version-cleaner-dialog.tsx) ───
          All cleanup state + preview/cleanup fetches live inside the dialog;
          the parent only controls `open` and refetches after a success. */}
      <VersionCleanerDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        storageVersions={storageVersions}
        versions={versions}
        loading={loading}
        onRefresh={() => {
          void fetchAll(true);
        }}
      />
    </div>
  );
}
