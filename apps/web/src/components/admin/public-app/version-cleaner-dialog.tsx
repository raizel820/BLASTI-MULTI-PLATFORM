'use client';

/**
 * version-cleaner-dialog.tsx — redesigned "app version cleaner" dialog.
 *
 * OWNS all cleanup state (platform / version / scope / live preview /
 * confirm / busy) and the POST /api/app-versions/cleanup-preview +
 * POST /api/app-versions/cleanup calls (contracts kept byte-identical with
 * the previous inline implementation in versions-tab.tsx). The parent only
 * controls `open` and gets `onRefresh` after a successful run.
 *
 * Layout: fixed chrome (gradient header + sticky footer) around an INTERNAL
 * scroll area with a two-pane body — selection rail (step 1) and live
 * preview (step 2) — sized so Arabic RTL / English / French never clip
 * (logical spacing only, text-xs minimum, no whole-dialog scroll).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowDownUp,
  CheckCircle2,
  Eraser,
  FileText,
  HardDrive,
  Loader2,
  Package,
  PackageX,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatFileSize, platformLabel, type AppVersion, type StorageVersion } from './shared';
import type { TranslationKeys } from '@/i18n';

// ─── API types (identical contracts — DO NOT reshape) ──────────────────────

/** Live response of POST /api/app-versions/cleanup-preview. */
export interface CleanupPreviewPlan {
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

export type CleanupScope = 'this' | 'with-previous';

const CLEANUP_SCOPES: Array<{ value: CleanupScope; labelKey: TranslationKeys; hintKey: TranslationKeys }> = [
  { value: 'this', labelKey: 'publicAppCleanupScopeThis', hintKey: 'publicAppCleanupScopeThisHint' },
  { value: 'with-previous', labelKey: 'publicAppCleanupScopeWithPrev', hintKey: 'publicAppCleanupScopeWithPrevHint' },
];

interface VersionCleanerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Disk truth (GET /api/app-versions/storage-versions) — files-only orphans included. */
  storageVersions: StorageVersion[];
  /** DB rows — fallback pickers when the disk inventory is unavailable. */
  versions: AppVersion[];
  /** Parent tab refetch in flight — pickers disabled while true. */
  loading?: boolean;
  /** Called after a successful cleanup run (parent refetches its lists). */
  onRefresh: () => void;
}

/** Icon tint per summary tile — emerald/teal/cyan accents, amber for orphans. */
const TILE_TONES = {
  emerald: 'text-emerald-600 dark:text-emerald-400',
  teal: 'text-teal-600 dark:text-teal-400',
  cyan: 'text-cyan-600 dark:text-cyan-400',
  amber: 'text-amber-600 dark:text-amber-400',
} as const;

type TileTone = keyof typeof TILE_TONES;

/** One summary tile of the preview chip grid: label + count + formatted bytes. */
function SummaryTile({
  icon: Icon,
  tone,
  label,
  count,
  bytes,
}: {
  icon: LucideIcon;
  tone: TileTone;
  label: string;
  count: number;
  bytes: number;
}) {
  return (
    <div className="rounded-xl border bg-background p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${TILE_TONES[tone]}`} />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1.5 text-lg font-bold leading-none text-foreground" dir="ltr">
        {count}
      </p>
      <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
        {formatFileSize(bytes)}
      </p>
    </div>
  );
}

export function VersionCleanerDialog({
  open,
  onOpenChange,
  storageVersions,
  versions,
  loading = false,
  onRefresh,
}: VersionCleanerDialogProps) {
  const { t, lang } = useLanguage();

  const [platform, setPlatform] = useState('');
  const [version, setVersion] = useState('');
  const [scope, setScope] = useState<CleanupScope>('with-previous');
  const [preview, setPreview] = useState<CleanupPreviewPlan | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped by the retry button to re-run the preview effect.
  const [retryNonce, setRetryNonce] = useState(0);

  const wasOpenRef = useRef(false);

  // ── Pickers — fed from the DISK inventory so versions that exist only as
  // files on disk stay cleanable; DB rows are the fallback when the disk
  // inventory is unavailable (same derivation the old VersionsTab used). ──
  const platforms = useMemo(() => {
    const fromDisk = [...new Set(storageVersions.map((v) => v.platform))];
    if (fromDisk.length > 0) return fromDisk;
    return [...new Set(versions.map((v) => v.platform))];
  }, [storageVersions, versions]);

  const versionsForPlatform = useCallback(
    (p: string): StorageVersion[] => {
      const disk = storageVersions.filter((v) => v.platform === p);
      if (disk.length > 0) return disk;
      return versions
        .filter((v) => v.platform === p)
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
    },
    [storageVersions, versions],
  );

  const versionOptions = useMemo(
    () => versionsForPlatform(platform),
    [versionsForPlatform, platform],
  );

  // Re-seed the selection each time the dialog OPENS (mirrors the old
  // openCleanup): first disk platform + its first version, with-previous
  // scope, clean preview. Ref-guarded transition — props may change while
  // the dialog is open without resetting the admin's in-progress selection.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const firstPlatform = platforms[0] ?? '';
      setPlatform(firstPlatform);
      setVersion(firstPlatform ? (versionsForPlatform(firstPlatform)[0]?.version ?? '') : '');
      setScope('with-previous');
      setPreview(null);
      setPreviewLoading(false);
      setPreviewError(false);
      setConfirmOpen(false);
      setRetryNonce(0);
    }
    wasOpenRef.current = open;
  });

  // Live preview: refetched whenever the selection changes (cancelled on change).
  useEffect(() => {
    if (!open || !platform || !version) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(false);
    apiFetch('/api/app-versions/cleanup-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, version, scope }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && data?.success) {
          setPreview(data.plan as CleanupPreviewPlan);
          setPreviewError(false);
        } else {
          setPreview(null);
          setPreviewError(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, platform, version, scope, retryNonce]);

  const runCleanup = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/app-versions/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          version,
          scope,
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
        setConfirmOpen(false);
        onOpenChange(false);
        onRefresh();
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
      setBusy(false);
    }
  }, [platform, version, scope, onOpenChange, onRefresh, t]);

  const hasSelection = !!(platform && version);
  const previewReady = !!preview && !previewLoading && !previewError && preview.totalFiles > 0;
  const canExecute = previewReady && !busy;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-5xl">
          {/* ── Header: gradient tile + title + danger badge (fixed chrome) ── */}
          <div className="relative shrink-0 border-b bg-gradient-to-r from-emerald-50 via-teal-50/60 to-cyan-50/60 px-5 py-4 sm:px-6 dark:border-emerald-500/20 dark:from-emerald-950/40 dark:via-teal-950/30 dark:to-cyan-950/40">
            <div className="flex items-start gap-3 pe-8">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-sm shadow-emerald-600/30">
                <Eraser className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-base font-bold sm:text-lg">
                    {t('publicAppCleanupTitle')}
                  </DialogTitle>
                  <Badge className="border border-amber-500/40 bg-amber-50 text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-400">
                    <AlertTriangle className="h-3 w-3" />
                    {t('publicAppCleanupDanger')}
                  </Badge>
                </div>
                <DialogDescription className="text-sm leading-relaxed">
                  {t('publicAppCleanupDesc')}
                </DialogDescription>
              </div>
            </div>
          </div>

          {/* ── Body: internal scroll — selection rail (1) + preview (2) ── */}
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
            <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-stretch">
              {/* ── Step 1 — selection rail ── */}
              <section className="flex flex-col gap-4 rounded-2xl border bg-muted/30 p-4 sm:p-5 dark:bg-muted/10">
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white"
                    dir="ltr"
                  >
                    1
                  </span>
                  <h3 className="text-sm font-semibold">{t('publicAppCleanupStepSelect')}</h3>
                </div>

                {/* platform + version — fed from the DISK inventory, so versions
                    that exist only as files (no DB row) stay selectable */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppCleanupPlatform')}</Label>
                  <Select
                    value={platform}
                    onValueChange={(v) => {
                      setPlatform(v);
                      const next = storageVersions.find((x) => x.platform === v);
                      setVersion(next?.version ?? '');
                    }}
                    disabled={loading || busy}
                  >
                    <SelectTrigger className="h-11 w-full text-sm" aria-label={t('publicAppCleanupPlatform')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {platforms.map((p) => (
                        <SelectItem key={p} value={p}>
                          {platformLabel(p, lang)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppCleanupVersion')}</Label>
                  <Select value={version} onValueChange={setVersion} disabled={loading || busy}>
                    <SelectTrigger className="h-11 w-full text-sm" aria-label={t('publicAppCleanupVersion')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {versionOptions.map((v) => (
                        <SelectItem key={`${v.platform}|${v.version}`} value={v.version}>
                          <span className="flex items-center gap-1.5">
                            <span className="font-mono" dir="ltr">{v.version}</span>
                            {v.isPublished ? (
                              <Badge className="h-5 bg-emerald-600 px-1.5 text-[10px] hover:bg-emerald-600">
                                {t('publicAppStatusActive')}
                              </Badge>
                            ) : !v.hasDbRow ? (
                              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                                {t('publicAppCleanupFilesOnly')}
                              </Badge>
                            ) : null}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {version &&
                    (() => {
                      const sel = versionOptions.find((x) => x.version === version);
                      if (!sel) return null;
                      return (
                        <p className="text-xs text-muted-foreground" dir="ltr">
                          {t('publicAppCleanupFiles', {
                            count: String(sel.totalFiles),
                            size: formatFileSize(sel.totalBytes),
                          })}
                        </p>
                      );
                    })()}
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('publicAppCleanupDiskHint')}
                </p>

                {/* scope — radio cards */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t('publicAppCleanupScope')}</Label>
                  <div className="space-y-2" role="radiogroup" aria-label={t('publicAppCleanupScope')}>
                    {CLEANUP_SCOPES.map((opt) => {
                      const selected = scope === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={busy}
                          onClick={() => setScope(opt.value)}
                          className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-start transition-colors disabled:pointer-events-none disabled:opacity-60 ${
                            selected
                              ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-500/50 dark:bg-emerald-900/20'
                              : 'hover:bg-muted/50'
                          }`}
                        >
                          <CheckCircle2
                            className={`mt-0.5 h-4 w-4 shrink-0 ${
                              selected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/40'
                            }`}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">{t(opt.labelKey)}</span>
                            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                              {t(opt.hintKey)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              {/* ── Step 2 — live preview: aggregate + per-version breakdown ── */}
              <section className="flex flex-col gap-4 rounded-2xl border bg-muted/30 p-4 sm:p-5 dark:bg-muted/10">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-600 text-[11px] font-bold text-white"
                    dir="ltr"
                  >
                    2
                  </span>
                  <h3 className="text-sm font-semibold">{t('publicAppCleanupStepPreview')}</h3>
                  <span className="flex items-center gap-1 text-xs font-medium text-rose-600 dark:text-rose-400">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {t('publicAppCleanupPreviewTitle')}
                  </span>
                </div>

                {/* nothing selected yet */}
                {!hasSelection && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center">
                    <Eraser className="h-8 w-8 text-muted-foreground/40" />
                    <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                      {t('publicAppCleanupPreviewEmpty')}
                    </p>
                  </div>
                )}

                {/* loading — skeleton rows */}
                {hasSelection && previewLoading && (
                  <div className="flex flex-1 flex-col gap-3" aria-busy="true">
                    <div className="grid grid-cols-2 gap-2">
                      <Skeleton className="h-20 rounded-xl" />
                      <Skeleton className="h-20 rounded-xl" />
                      <Skeleton className="h-20 rounded-xl" />
                      <Skeleton className="h-20 rounded-xl" />
                    </div>
                    <Skeleton className="h-24 rounded-xl" />
                    <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {t('publicAppCleanupPreviewLoading')}
                    </div>
                  </div>
                )}

                {/* error — destructive alert + retry */}
                {hasSelection && !previewLoading && previewError && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
                    <AlertTriangle className="h-7 w-7 text-destructive" />
                    <p className="text-sm font-medium text-destructive">{t('publicAppCleanupPreviewFailed')}</p>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setRetryNonce((n) => n + 1)}>
                      <RefreshCw className="h-3.5 w-3.5" />
                      {t('publicAppRetry')}
                    </Button>
                  </div>
                )}

                {/* loaded but nothing to delete */}
                {hasSelection && !previewLoading && !previewError && preview && preview.totalFiles === 0 && (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-center">
                    <CheckCircle2 className="h-8 w-8 text-emerald-600/70 dark:text-emerald-400/70" />
                    <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                      {t('publicAppCleanupNothing')}
                    </p>
                  </div>
                )}

                {/* ready — summary tiles + per-version table + reclaim total */}
                {hasSelection && !previewLoading && !previewError && preview && preview.totalFiles > 0 && (
                  <div className="flex flex-1 flex-col gap-3">
                    {/* aggregate summary — every artifact class the run removes */}
                    <div className="grid grid-cols-2 gap-2">
                      <SummaryTile
                        icon={Package}
                        tone="emerald"
                        label={t('publicAppCleanupInstallers')}
                        count={preview.installers.count}
                        bytes={preview.installers.bytes}
                      />
                      <SummaryTile
                        icon={ArrowDownUp}
                        tone="teal"
                        label={t('publicAppCleanupDeltas')}
                        count={preview.deltas.count}
                        bytes={preview.deltas.bytes}
                      />
                      <SummaryTile
                        icon={FileText}
                        tone="cyan"
                        label={t('publicAppCleanupRefs')}
                        count={preview.refArtifacts.count}
                        bytes={preview.refArtifacts.bytes}
                      />
                      <SummaryTile
                        icon={PackageX}
                        tone="amber"
                        label={t('publicAppCleanupOrphans')}
                        count={preview.orphanedBuilds.count}
                        bytes={preview.orphanedBuilds.bytes}
                      />
                    </div>

                    {preview.deltas.pairs?.length > 0 && (
                      <p
                        className="truncate text-xs text-muted-foreground"
                        dir="ltr"
                        title={preview.deltas.pairs.join(', ')}
                      >
                        {preview.deltas.pairs.join(', ')}
                      </p>
                    )}

                    {/* per-version breakdown — exactly what the run will erase */}
                    <div className="rounded-xl border bg-background">
                      <p className="px-3 pb-1 pt-2.5 text-xs font-semibold text-muted-foreground">
                        {t('publicAppCleanupPerVersion')}
                      </p>
                      <div className="custom-scrollbar max-h-44 overflow-y-auto">
                        <Table>
                          <TableHeader className="sticky top-0 z-10 bg-background">
                            <TableRow>
                              <TableHead className="h-9 text-xs">{t('publicAppCleanupColVersion')}</TableHead>
                              <TableHead className="h-9 text-end text-xs">{t('publicAppCleanupColFiles')}</TableHead>
                              <TableHead className="h-9 text-end text-xs">{t('publicAppCleanupColSize')}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(preview.perVersion ?? []).map((row) => (
                              <TableRow key={row.version}>
                                <TableCell className="py-2">
                                  <div className="flex min-w-0 items-center gap-1.5">
                                    <span className="font-mono text-xs" dir="ltr">{row.version}</span>
                                    {row.isPublished ? (
                                      <Badge className="h-5 shrink-0 bg-emerald-600 px-1.5 text-[10px] hover:bg-emerald-600">
                                        {t('publicAppStatusActive')}
                                      </Badge>
                                    ) : !row.hasDbRow ? (
                                      <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
                                        {t('publicAppCleanupFilesOnly')}
                                      </Badge>
                                    ) : null}
                                  </div>
                                </TableCell>
                                <TableCell className="py-2 text-end font-mono text-xs" dir="ltr">
                                  {row.files}
                                </TableCell>
                                <TableCell className="py-2 text-end font-mono text-xs" dir="ltr">
                                  {formatFileSize(row.bytes)}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>

                    {/* total reclaim bar */}
                    <div className="mt-auto flex items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-50 px-4 py-3 dark:border-emerald-500/30 dark:bg-emerald-900/20">
                      <div className="flex min-w-0 items-center gap-2">
                        <HardDrive className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-xs font-semibold sm:text-sm">{t('publicAppCleanupReclaim')}</span>
                      </div>
                      <div className="text-end">
                        <p
                          className="font-mono text-lg font-bold leading-tight text-emerald-700 dark:text-emerald-300"
                          dir="ltr"
                        >
                          {formatFileSize(preview.totalBytes)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('publicAppCleanupFileCount', { count: String(preview.totalFiles) })}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>

          {/* ── Footer: total summary + actions (fixed chrome) ── */}
          <div className="flex shrink-0 flex-col items-center gap-3 border-t bg-muted/30 p-4 sm:flex-row sm:justify-between sm:px-6 dark:bg-muted/10">
            <p className="order-2 text-xs text-muted-foreground sm:order-1 sm:text-start">
              {previewReady && preview ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold text-foreground" dir="ltr">
                    {formatFileSize(preview.totalBytes)}
                  </span>
                  {t('publicAppCleanupFileCount', { count: String(preview.totalFiles) })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {t('publicAppCleanupDanger')}
                </span>
              )}
            </p>
            <div className="order-1 flex w-full flex-col-reverse gap-2 sm:order-2 sm:w-auto sm:flex-row">
              <Button
                variant="outline"
                className="h-10 w-full sm:w-auto"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t('publicAppCancel')}
              </Button>
              <Button
                variant="destructive"
                className="h-10 w-full sm:w-auto"
                disabled={!canExecute}
                onClick={() => setConfirmOpen(true)}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {busy ? t('publicAppCleanupExecuting') : t('publicAppCleanupExecute')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Cleanup confirmation ─── */}
      <AlertDialog open={confirmOpen} onOpenChange={(next) => !next && setConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              {t('publicAppCleanupConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {preview && preview.totalFiles > 0
                ? `${t('publicAppCleanupConfirmBody')}\n\n${t('publicAppCleanupVersionsLabel')}: ${
                    (preview.scopeVersions?.length
                      ? preview.scopeVersions
                      : preview.versions.map((v) => v.version)
                    )
                    .map((ver) => `${platformLabel(platform, lang)} ${ver}`)
                    .join(', ')}`
                : t('publicAppCleanupConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-10" disabled={busy}>
              {t('publicAppCancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-10 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void runCleanup();
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('publicAppCleanupExecute')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
