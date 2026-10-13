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
} from './shared';
import { NotesInput, type NotesValue } from './notes-input';
import { INSTALLER_PLATFORMS, isValidSemver, type InstallerPlatform } from '@/lib/admin-upload';

interface VersionForm {
  platform: InstallerPlatform;
  version: string;
  versionCode: string;
  notes: NotesValue;
  isMandatory: boolean;
  isPublished: boolean;
  minAppVersion: string;
}

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

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const [versionsRes, statsRes] = await Promise.all([
        apiFetch('/api/app-versions'),
        apiFetch('/api/app-installs/stats'),
      ]);
      const versionsData = await versionsRes.json().catch(() => null);
      const statsData = await statsRes.json().catch(() => null);

      if (versionsRes.ok && versionsData?.success) {
        setVersions(versionsData.versions || []);
        setError(null);
      } else {
        setError(versionsData?.error || `HTTP ${versionsRes.status}`);
      }
      if (statsRes.ok && statsData?.success) setStats(statsData);
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
          <Button size="sm" className="h-9 w-full sm:w-auto" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            {t('publicAppNewVersion')}
          </Button>
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
    </div>
  );
}
