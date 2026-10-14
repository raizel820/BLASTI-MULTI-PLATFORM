'use client'

/**
 * Admin Storage Manager — SUPER_ADMIN on-disk file store console (Task 2).
 *
 * Sidebar section "Database and Storage Management → Storage Manager"
 * (admin-storage view) backed by /api/admin/storage/* (apps/api/src/routes/
 * admin-storage.ts):
 *
 *   Overview     → disk usage at STORAGE_ROOT + totals + per-category
 *                  breakdown (files/bytes/db-tracked/orphans/missing)
 *   Browse L1    → per bucket: year cards + legacy flat files
 *   Browse L2    → per bucket/yyyy: month rows
 *   Browse L3    → per bucket/yyyy/mm: searchable files table with
 *                  inline image thumbnails / preview dialog / copy-path /
 *                  open-URL / delete actions
 *   Preview      → in-app file preview: images, PDF (browser viewer),
 *                  video/audio players and text files (first 256 KB);
 *                  binaries fall back to download/open actions
 *   Delete       → DELETE /file { storagePath } (disk unlink + FileAsset
 *                  tombstone + AppVersion publish-cascade server-side)
 *   Rename       → POST /rename { storagePath, newName } (in-place rename;
 *                  FileAsset + AppVersion rows repoint, active installer
 *                  stays active under its new name)
 *
 * Task 2-c-2 — navigation + download upgrades:
 *   - Per-file DOWNLOAD via the admin streaming endpoint
 *     GET /api/admin/storage/download?path=... (Content-Disposition:
 *     attachment) — works for every file, with or without a public URL.
 *   - Sort dropdown (name/date/size/type, asc/desc) applied to the file
 *     tables (month listing + legacy flat files).
 *   - Name search on BOTH the flat-files listing and the month listing.
 *   - Per-kind Lucide file icons, custom scrollbar on the list viewport,
 *     ≥44px touch targets for row actions (mobile-first).
 *
 * Conventions mirror admin-db-manager.tsx: same page padding (p-4 lg:p-6),
 * apiFetch + res.ok discipline, both unwrapped and {success, data} envelope
 * shapes accepted, sonner toasts, ConfirmDialog for deletes. Every fetched
 * payload is normalized defensively — a 401/403 or malformed body degrades
 * to a toast (storageLoadFailed), never a crash.
 */

import { apiFetch } from '@/lib/api-fetch';
import { buildCloudUrl } from '@/lib/api-client';
import { downloadAdminStorageFile } from '@/lib/admin-download';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  HardDrive,
  RefreshCw,
  Loader2,
  Search,
  Trash2,
  Copy,
  Pencil,
  ExternalLink,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderInput,
  FolderPlus,
  Upload,
  UserCircle,
  Image,
  ReceiptText,
  FileText,
  FileArchive,
  Package,
  PackageCheck,
  MonitorDown,
  AlertTriangle,
  Eye,
  Download,
  Music,
  Video,
  FileQuestion,
  Check,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { isRTL, type TranslationKeys, type Language } from '@/i18n';

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

// ─── Types (mirror apps/api/src/routes/admin-storage.ts payloads) ───────────

interface DiskInfo {
  totalGb: number;
  freeGb: number;
  usedGb: number;
  usagePct: number;
}

interface CategoryInfo {
  bucket: string;
  files: number;
  bytes: number;
  dbCount: number;
  orphans: number;
  missing: number;
  system: boolean;
}

interface TotalsInfo {
  files: number;
  bytes: number;
  dbTracked: number;
  orphans: number;
  missing: number;
  categories: number;
  walkErrors: number;
}

interface Overview {
  storageRoot: string;
  disk: DiskInfo | null;
  totals: TotalsInfo;
  categories: CategoryInfo[];
}

/** Generic folder row — ANY level of the tree (bucket or admin subfolder). */
interface BrowseFolderRow {
  name: string;
  path: string;
  files: number;
  bytes: number;
  folders: number;
}

interface StorageFileRow {
  name: string;
  storagePath: string;
  size: number;
  mtimeMs: number;
  url: string | null;
  tracked: boolean;
}

/**
 * GET /api/admin/storage/browse payload — ONE shape for EVERY level:
 * { path, folders, files, totals }. `path` '' = storage root (buckets).
 */
interface BrowseData {
  path: string;
  folders: BrowseFolderRow[];
  files: StorageFileRow[];
  totals: { files: number; bytes: number };
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

/** B/KB/MB/GB with 1 decimal (spec: local helper, not shared). */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/** Compact count: 1,234 → "1.2K". */
function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

// ─── File-kind detection (drives previews; extension-based — filenames are
// canonical <timestamp>-<rand>.<ext> produced by the storage service) ────────

type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'binary';

const KIND_BY_EXT: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
  svg: 'image', bmp: 'image', avif: 'image', ico: 'image',
  pdf: 'pdf',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio',
  txt: 'text', json: 'text', csv: 'text', tsv: 'text', md: 'text', xml: 'text',
  log: 'text', yml: 'text', yaml: 'text', ini: 'text', conf: 'text', sql: 'text', html: 'text',
};

function fileKind(name: string): FileKind {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return KIND_BY_EXT[ext] ?? 'binary';
}

/** True when the file can be rendered in-app (everything but raw binaries). */
function isPreviewable(name: string): boolean {
  return fileKind(name) !== 'binary';
}

/**
 * Task 2-c-2 — per-kind list icon (Lucide). Drives the file-type column in
 * the storage tables: every row shows the kind of document it holds.
 */
const ICON_BY_KIND: Record<FileKind, LucideIcon> = {
  image: Image,
  pdf: FileText,
  video: Video,
  audio: Music,
  text: FileText,
  binary: FileArchive,
};

function fileKindIcon(name: string): LucideIcon {
  return ICON_BY_KIND[fileKind(name)] ?? FileQuestion;
}

/** Sort fields for the file tables (Task 2-c-2 sort dropdown). */
type SortField = 'date' | 'name' | 'size' | 'type';
type SortDir = 'asc' | 'desc';

/** Non-mutating client-side sort of normalized file rows. */
function sortFileRows(files: StorageFileRow[], field: SortField, dir: SortDir): StorageFileRow[] {
  const mul = dir === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    switch (field) {
      case 'name':
        return a.name.localeCompare(b.name) * mul;
      case 'size':
        return (a.size - b.size) * mul;
      case 'type':
        return (fileKind(a.name).localeCompare(fileKind(b.name)) || a.name.localeCompare(b.name)) * mul;
      case 'date':
      default:
        return (a.mtimeMs - b.mtimeMs) * mul;
    }
  });
}

/**
 * Browser-reachable URL for a stored file. The API returns RELATIVE
 * /api/upload/file/... paths — behind the single-port sandbox gateway those
 * only resolve when XTransformPort=3003 is appended, while on loopback/LAN
 * dev the API lives on :3003 directly. buildCloudUrl handles every topology.
 */
function fileBrowserUrl(url: string): string {
  return url.startsWith('/') ? buildCloudUrl(url) : url;
}

/**
 * Task 2-c-2 — ADMIN download endpoint (apps/api/src/routes/admin-storage.ts
 * GET /download). Streams the file with Content-Disposition: attachment —
 * unlike the public capability URL (inline preview) it forces a real
 * download and works for EVERY managed file, with or without a public URL.
 * The actual fetch runs BINARY-SAFE through lib/admin-download.ts (native
 * fetch + real Blob + per-shell auth) — apiFetch() would text-decode the
 * stream and corrupt binary files.
 */

/** Locale-aware medium date + short time. */
function formatModified(ms: number, lang: Language): string {
  const locale = lang === 'ar' ? 'ar' : lang === 'fr' ? 'fr' : 'en';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString(locale, { dateStyle: 'medium' })} · ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── Defensive payload normalization ────────────────────────────────────────

type JsonRecord = Record<string, unknown>;

function asRecord(v: unknown): JsonRecord | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * apiFetch/apiClient UNWRAPS the {success, data} envelope — accept BOTH the
 * unwrapped payload and the full envelope shape (data wins when present).
 */
function unwrapPayload(body: unknown): JsonRecord | null {
  const b = asRecord(body);
  if (!b) return null;
  const inner = asRecord(b.data);
  return inner ?? b;
}

function normFile(v: unknown): StorageFileRow | null {
  const r = asRecord(v);
  if (!r || typeof r.name !== 'string' || typeof r.storagePath !== 'string') return null;
  return {
    name: r.name,
    storagePath: r.storagePath,
    size: num(r.size),
    mtimeMs: num(r.mtimeMs),
    url: typeof r.url === 'string' ? r.url : null,
    tracked: r.tracked === true,
  };
}

function normFolder(v: unknown): BrowseFolderRow | null {
  const r = asRecord(v);
  if (!r || typeof r.name !== 'string' || typeof r.path !== 'string') return null;
  return { name: r.name, path: r.path, files: num(r.files), bytes: num(r.bytes), folders: num(r.folders) };
}

function normCategory(v: unknown): CategoryInfo | null {
  const r = asRecord(v);
  if (!r || typeof r.bucket !== 'string') return null;
  return {
    bucket: r.bucket,
    files: num(r.files),
    bytes: num(r.bytes),
    dbCount: num(r.dbCount),
    orphans: num(r.orphans),
    missing: num(r.missing),
    system: r.system === true,
  };
}

function normOverview(body: unknown): Overview | null {
  const r = unwrapPayload(body);
  if (!r || typeof r.storageRoot !== 'string') return null;
  const diskR = asRecord(r.disk);
  const disk: DiskInfo | null = diskR
    ? {
        totalGb: num(diskR.totalGb),
        freeGb: num(diskR.freeGb),
        usedGb: num(diskR.usedGb),
        usagePct: num(diskR.usagePct),
      }
    : null;
  const tR = asRecord(r.totals);
  const totals: TotalsInfo = tR
    ? {
        files: num(tR.files),
        bytes: num(tR.bytes),
        dbTracked: num(tR.dbTracked),
        orphans: num(tR.orphans),
        missing: num(tR.missing),
        categories: num(tR.categories),
        walkErrors: num(tR.walkErrors),
      }
    : { files: 0, bytes: 0, dbTracked: 0, orphans: 0, missing: 0, categories: 0, walkErrors: 0 };
  const categories = asArray(r.categories)
    .map(normCategory)
    .filter((c): c is CategoryInfo => c !== null);
  return { storageRoot: r.storageRoot, disk, totals, categories };
}

// ─── Bucket metadata (icon + i18n label per category) ───────────────────────

const BUCKET_LABEL: Record<string, TranslationKeys> = {
  avatar: 'storageBucketAvatar',
  logo: 'storageBucketLogo',
  receipt: 'storageBucketReceipt',
  document: 'storageBucketDocument',
  general: 'storageBucketGeneral',
  'app-binary': 'storageBucketAppBinary',
  'app-versions': 'storageBucketAppVersions',
};

function bucketLabelKey(bucket: string): TranslationKeys {
  return BUCKET_LABEL[bucket] ?? 'storageBucketOther';
}

const BUCKET_ICON: Record<string, LucideIcon> = {
  avatar: UserCircle,
  logo: Image,
  receipt: ReceiptText,
  document: FileText,
  general: Package,
  'app-binary': PackageCheck,
  'app-versions': MonitorDown,
};

function bucketIcon(bucket: string): LucideIcon {
  return BUCKET_ICON[bucket] ?? Folder;
}

// ─── Preview dialog (images / PDF / video / audio / text) ───────────────

interface StoragePreviewDialogProps {
  file: StorageFileRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  lang: Language;
  onCopy: (text: string) => void;
  onDownload: (file: StorageFileRow) => void;
  downloading: boolean;
}

/** Text previews are capped — a multi-MB log must never freeze the tab. */
const TEXT_PREVIEW_LIMIT = 256 * 1024;

function PreviewFallback({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="rounded-xl border bg-muted/30 py-12 flex flex-col items-center justify-center gap-3 text-center px-6">
      <Icon className="h-10 w-10 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground max-w-sm">{text}</p>
    </div>
  );
}

function StoragePreviewDialog({ file, open, onOpenChange, t, lang, onCopy, onDownload, downloading }: StoragePreviewDialogProps) {
  const src = file?.url ? fileBrowserUrl(file.url) : null;
  const kind = file ? fileKind(file.name) : 'binary';

  // Image load failure (404 after disk drift, decode error) → honest fallback.
  const [imgFailed, setImgFailed] = useState(false);
  // Text-kind fetch state.
  const [textBody, setTextBody] = useState<string | null>(null);
  const [textTruncated, setTextTruncated] = useState(false);
  const [textLoading, setTextLoading] = useState(false);
  const [textFailed, setTextFailed] = useState(false);

  // Reset per-file state whenever the dialog opens for a (new) file.
  useEffect(() => {
    setImgFailed(false);
    setTextBody(null);
    setTextTruncated(false);
    setTextFailed(false);
    if (!open || !src || !file || fileKind(file.name) !== 'text') return;
    let cancelled = false;
    setTextLoading(true);
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (cancelled) return;
        const truncated = raw.length > TEXT_PREVIEW_LIMIT;
        setTextBody(truncated ? raw.slice(0, TEXT_PREVIEW_LIMIT) : raw);
        setTextTruncated(truncated);
      } catch {
        if (!cancelled) setTextFailed(true);
      } finally {
        if (!cancelled) setTextLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, src, file]);

  if (!file) return null;

  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toUpperCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0 pe-6 flex-wrap">
            <span className="truncate font-mono text-sm max-w-full" title={file.name}>{file.name}</span>
            <Badge variant="secondary" className="text-[10px] font-mono">{ext}</Badge>
            {file.tracked ? (
              <Badge className="text-[10px] bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300">
                {t('storageTracked')}
              </Badge>
            ) : (
              <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300">
                {t('storageUntracked')}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-[11px] break-all">
            {humanSize(file.size)} · {formatModified(file.mtimeMs, lang)} ·
            <code className="font-mono ms-1" title={file.storagePath}>{file.storagePath}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* ── Body by kind ── */}
          {kind === 'image' && src && !imgFailed && (
            <div className="rounded-xl border bg-muted/30 p-2 flex items-center justify-center min-h-[200px]">
              <img
                src={src}
                alt={file.name}
                loading="lazy"
                onError={() => setImgFailed(true)}
                className="max-h-[60vh] w-auto max-w-full object-contain rounded-lg"
              />
            </div>
          )}
          {kind === 'image' && imgFailed && (
            <PreviewFallback icon={FileQuestion} text={t('storagePreviewLoadFailed')} />
          )}

          {kind === 'pdf' && src && (
            <iframe
              src={src}
              title={file.name}
              className="w-full h-[65vh] rounded-xl border bg-muted/30"
            />
          )}

          {kind === 'video' && src && (
            <video
              controls
              src={src}
              className="max-h-[60vh] w-full rounded-xl border bg-black"
            />
          )}

          {kind === 'audio' && src && (
            <div className="rounded-xl border bg-muted/30 p-6 flex items-center justify-center">
              <audio controls src={src} className="w-full max-w-md" />
            </div>
          )}

          {kind === 'text' && (
            <div className="rounded-xl border bg-muted/30 p-3">
              {textLoading && (
                <div className="flex items-center justify-center py-10 text-muted-foreground text-sm gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('storagePreviewLoading')}
                </div>
              )}
              {!textLoading && textFailed && (
                <PreviewFallback icon={FileQuestion} text={t('storagePreviewLoadFailed')} />
              )}
              {!textLoading && !textFailed && textBody !== null && (
                <>
                  <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-all text-[12px] leading-relaxed font-mono">
                    {textBody}
                  </pre>
                  {textTruncated && (
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      {t('storagePreviewTruncated', { size: humanSize(TEXT_PREVIEW_LIMIT) })}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {kind === 'binary' && (
            <PreviewFallback icon={FileQuestion} text={t('storagePreviewUnavailable')} />
          )}

          {/* ── Footer actions ── */}
          <div className="flex items-center gap-2 flex-wrap justify-end pt-1 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCopy(file.storagePath)}
            >
              <Copy className="h-3.5 w-3.5 me-1" />
              {t('storageCopyPath')}
            </Button>
            {/* Task 2-c-2 — download via the ADMIN streaming endpoint
                (attachment; works for every file, no public URL needed). */}
            <Button
              variant="outline"
              size="sm"
              disabled={downloading}
              onClick={() => onDownload(file)}
            >
              {downloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin me-1" />
              ) : (
                <Download className="h-3.5 w-3.5 me-1" />
              )}
              {t('storageDownload')}
            </Button>
            {src && (
              <a
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-input bg-background text-sm font-medium hover:bg-muted transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('storageOpenFile')}
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Files table (shared by legacy flat files + month listing) ──────────────

interface FilesTableProps {
  files: StorageFileRow[];
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  lang: Language;
  onCopy: (path: string) => void;
  onAskDelete: (file: StorageFileRow) => void;
  onAskRename: (file: StorageFileRow) => void;
  onAskMove: (file: StorageFileRow) => void;
  onPreview: (file: StorageFileRow) => void;
  onDownload: (file: StorageFileRow) => void;
  downloadingPath: string | null;
  // Multi-select (batch delete / move) — leading checkbox column.
  isSelected: (path: string) => boolean;
  onToggleSelect: (storagePath: string) => void;
  allSelected: boolean;
  someSelected: boolean;
  onToggleSelectAll: () => void;
}

function StorageFilesTable({ files, t, lang, onCopy, onAskDelete, onAskRename, onAskMove, onPreview, onDownload, downloadingPath, isSelected, onToggleSelect, allSelected, someSelected, onToggleSelectAll }: FilesTableProps) {
  return (
    <div className="rounded-xl border overflow-hidden">
      {/* Scrolling is owned by the explorer viewport around the table —
          nested scrollbars made navigating feel cramped (user report). */}
      <div>
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead className="w-10 whitespace-nowrap">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={onToggleSelectAll}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t('storageSelectAll')}
                  className="align-middle"
                />
              </TableHead>
              <TableHead className="whitespace-nowrap">{t('storageFileName')}</TableHead>
              <TableHead className="whitespace-nowrap">{t('storageSize')}</TableHead>
              <TableHead className="whitespace-nowrap">{t('storageModified')}</TableHead>
              <TableHead className="whitespace-nowrap">{t('storageStatus')}</TableHead>
              <TableHead className="whitespace-nowrap text-end">{t('storageActions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-10 text-muted-foreground text-sm">
                  {t('noData')}
                </TableCell>
              </TableRow>
            ) : (
              files.map((f, idx) => {
                const previewable = isPreviewable(f.name) && !!f.url;
                const thumb = f.name.toLowerCase().match(/\.(png|jpe?g|webp|gif|svg|bmp|avif|ico)$/)
                  ? (f.url ? fileBrowserUrl(f.url) : null)
                  : null;
                const KindIcon = fileKindIcon(f.name);
                const downloading = downloadingPath === f.storagePath;
                return (
                <TableRow key={f.storagePath || idx} className={isSelected(f.storagePath) ? 'bg-emerald-50/60 dark:bg-emerald-900/10' : undefined}>
                  <TableCell
                    className="w-10 cursor-pointer"
                    onClick={() => onToggleSelect(f.storagePath)}
                  >
                    <div className="flex items-center min-h-[44px] sm:min-h-0">
                      <Checkbox
                        checked={isSelected(f.storagePath)}
                        onCheckedChange={() => onToggleSelect(f.storagePath)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={t('storageSelectAll')}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    <button
                      type="button"
                      onClick={() => { if (previewable) onPreview(f); }}
                      disabled={!previewable}
                      className={`flex items-center gap-2.5 min-w-[44px] min-h-[44px] sm:min-h-0 py-1 max-w-full text-start ${previewable ? 'group cursor-pointer' : 'cursor-default'}`}
                      title={previewable ? t('storagePreview') : undefined}
                    >
                      {thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          loading="lazy"
                          className="h-9 w-9 rounded-md border object-cover shrink-0 bg-muted/40 group-hover:border-emerald-400 dark:group-hover:border-emerald-600 transition-colors"
                        />
                      ) : (
                        <span className="h-9 w-9 rounded-md border bg-muted/40 flex items-center justify-center shrink-0" aria-hidden="true">
                          <KindIcon className="h-4 w-4 text-muted-foreground/70" />
                        </span>
                      )}
                      <span className={`font-mono text-[12px] truncate ${previewable ? 'group-hover:underline decoration-dotted underline-offset-2' : ''}`} title={f.name}>
                        {f.name}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-[12px]">{humanSize(f.size)}</TableCell>
                  <TableCell className="whitespace-nowrap text-[12px] text-muted-foreground">
                    {formatModified(f.mtimeMs, lang)}
                  </TableCell>
                  <TableCell>
                    {f.tracked ? (
                      <Badge className="text-[10px] bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-300">
                        {t('storageTracked')}
                      </Badge>
                    ) : (
                      <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300">
                        {t('storageUntracked')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      {previewable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-11 w-11 sm:h-7 sm:w-7 p-0"
                          title={t('storagePreview')}
                          aria-label={t('storagePreview')}
                          onClick={() => onPreview(f)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-7 sm:w-7 p-0"
                        title={t('storageCopyPath')}
                        aria-label={t('storageCopyPath')}
                        onClick={() => onCopy(f.storagePath)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      {/* Task 2-c-2 — per-file download through the ADMIN
                          streaming endpoint (attachment). No public URL
                          needed — works for every managed file. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-7 sm:w-7 p-0"
                        title={t('storageDownload')}
                        aria-label={t('storageDownload')}
                        disabled={downloadingPath !== null}
                        onClick={() => onDownload(f)}
                      >
                        {downloading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      {f.url && (
                        <a
                          href={fileBrowserUrl(f.url)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('storageOpenFile')}
                          aria-label={t('storageOpenFile')}
                          className="inline-flex items-center justify-center h-11 w-11 sm:h-7 sm:w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {/* Rename in place (same folder) — downstream rows
                          (FileAsset/AppVersion) repoint server-side. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-7 sm:w-7 p-0"
                        title={t('storageRename')}
                        aria-label={t('storageRename')}
                        onClick={() => onAskRename(f)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {/* Move to another folder — cross-folder (and
                          cross-bucket) with FileAsset/AppVersion repointing
                          handled server-side. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-7 sm:w-7 p-0"
                        title={t('storageMove')}
                        aria-label={t('storageMove')}
                        onClick={() => onAskMove(f)}
                      >
                        <FolderInput className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 sm:h-7 sm:w-7 p-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                        title={t('storageDelete')}
                        aria-label={t('storageDelete')}
                        onClick={() => onAskDelete(f)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function AdminStorageManager() {
  const { t, lang } = useLanguage();
  const rtl = isRTL(lang);

  // Overview state
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Generic folder navigation — `navPath` is a POSIX path relative to the
  // storage root ('' = root → the bucket grid). One shape at EVERY level.
  const [navPath, setNavPath] = useState('');
  const [browse, setBrowse] = useState<BrowseData | null>(null);
  const [loadingBrowse, setLoadingBrowse] = useState(false);

  // Per-path cache so Back/breadcrumb navigation never blanks out — ALL
  // fetched levels stay in component state. Invalidated per-folder subtree
  // on delete/rename/move/upload.
  const [cache, setCache] = useState<Record<string, BrowseData>>({});

  // Client-side name filter (applied to files AND folders).
  const [fileSearch, setFileSearch] = useState('');

  // Task 2-c-2 — sort controls (name/date/size/type × asc/desc) + download
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<StorageFileRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Rename-in-place dialog state (mirror of the delete flow).
  const [renameTarget, setRenameTarget] = useState<StorageFileRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  // Preview dialog (image / PDF / video / audio / text)
  const [previewTarget, setPreviewTarget] = useState<StorageFileRow | null>(null);

  // New-folder dialog
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Manual upload (into the CURRENT folder)
  const [uploading, setUploading] = useState(false);

  // Move dialog (→ destination folder picker). `moveTargets` carries ONE
  // file (row button), the current multi-selection (selection bar) or a mix.
  const [moveTargets, setMoveTargets] = useState<{ files: StorageFileRow[]; folders: BrowseFolderRow[]; count: number; label: string } | null>(null);
  const [folderOptions, setFolderOptions] = useState<string[] | null>(null);
  const [moveDestination, setMoveDestination] = useState('');
  const [moving, setMoving] = useState(false);

  // ── Multi-select (batch delete / move) ──
  // ONE Set for files (storage paths) AND folders (folder paths) — cleared
  // whenever the open folder changes and after every batch mutation.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // ── Overview fetch ──
  const fetchOverview = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoadingOverview(true);
    try {
      const res = await apiFetch('/api/admin/storage/overview');
      const body = await res.json().catch(() => null);
      const data = normOverview(body);
      if (res.ok && data) {
        setOverview(data);
      } else {
        // 401/403 and any other failure surface the same honest toast.
        toast.error(t('storageLoadFailed'));
      }
    } catch {
      toast.error(t('storageLoadFailed'));
    } finally {
      setLoadingOverview(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  // Root folder listing — the explorer's first paint (the old level-0 grid
  // came from the overview payload; the generic explorer needs its own fetch).
  useEffect(() => {
    fetchLevel('');
  }, [/* first paint only */]);

  // ── Browse fetch (generic folder level — ONE shape at EVERY depth) ──
  const fetchLevel = useCallback(async (
    path: string,
    opts?: { force?: boolean }
  ) => {
    if (!opts?.force) {
      const cached = cache[path];
      if (cached) {
        setBrowse(cached);
        return;
      }
    }
    setLoadingBrowse(true);
    try {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      const res = await apiFetch(`/api/admin/storage/browse?${params.toString()}`);
      const body = await res.json().catch(() => null);
      const data = unwrapPayload(body);
      if (!res.ok || !data || !Array.isArray(data.folders) || !Array.isArray(data.files)) {
        toast.error(t('storageLoadFailed'));
        return;
      }
      const totalsRec = asRecord(data.totals);
      const next: BrowseData = {
        path,
        folders: asArray(data.folders).map(normFolder).filter((f): f is BrowseFolderRow => f !== null),
        files: asArray(data.files).map(normFile).filter((f): f is StorageFileRow => f !== null),
        totals: { files: num(totalsRec?.files), bytes: num(totalsRec?.bytes) },
      };
      setCache((prev) => ({ ...prev, [path]: next }));
      setBrowse(next);
    } catch {
      toast.error(t('storageLoadFailed'));
    } finally {
      setLoadingBrowse(false);
    }
  }, [cache, t]);

  // ── Navigation ──

  /** POSIX parent of a folder/file path ('a/b' → 'a', 'a' → ''). */
  const parentOf = useCallback((p: string): string => {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '' : p.slice(0, idx);
  }, []);

  const openFolder = (path: string) => {
    setFileSearch('');
    setSelectedPaths(new Set()); // selection never crosses folders
    setNavPath(path);
    setBrowse(null); // skeleton while fetching (cache hit resolves instantly)
    fetchLevel(path);
  };

  const backOneLevel = () => openFolder(parentOf(navPath));

  /** Header refresh — reloads the CURRENT level (overview at root). */
  const refreshCurrent = () => {
    if (!navPath) {
      fetchOverview(true);
      return;
    }
    fetchLevel(navPath, { force: true });
  };

  /**
   * Drop every cached level inside the affected folder SUBTREES — the folder
   * content changed AND every ancestor aggregate above it went stale. The
   * currently open level (when affected) is force re-fetched by the callers.
   */
  const invalidateFolderCache = useCallback((folders: string[]) => {
    setCache((prev) => {
      const next: Record<string, BrowseData> = {};
      for (const [k, v] of Object.entries(prev)) {
        const affected = folders.some((f) => k === f || k.startsWith(`${f}/`));
        if (!affected) next[k] = v;
      }
      return next;
    });
  }, []);

  // ── Create folder (inside the CURRENT folder) ──
  // Client-side guard mirrors the server FOLDER_NAME_RE: starts with a
  // letter/digit, no slashes, no dot-names, ≤64 chars.
  const newFolderNameInvalid = useMemo(() => {
    const v = newFolderName.trim();
    if (!v) return 'empty';
    if (v === '.' || v === '..' || v.includes('..') || /[\\/]/.test(v)) return 'invalid';
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(v)) return 'invalid';
    return null;
  }, [newFolderName]);

  const confirmCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || newFolderNameInvalid || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const res = await apiFetch('/api/admin/storage/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: navPath, name }),
      });
      const body = await res.json().catch(() => null);
      const bodyRec = asRecord(body);
      if (res.ok && bodyRec && bodyRec.success !== false) {
        toast.success(t('storageNewFolderDone'));
        setNewFolderOpen(false);
        setNewFolderName('');
        invalidateFolderCache([navPath]);
        fetchLevel(navPath, { force: true });
        fetchOverview(true);
      } else {
        const serverError = typeof bodyRec?.error === 'string' ? bodyRec.error : '';
        if (res.status === 409 || serverError.includes('already exists')) toast.error(t('storageNewFolderConflict'));
        else if (res.status === 400) toast.error(t('storageNewFolderInvalid'));
        else toast.error(serverError || t('storageNewFolderFailed'));
      }
    } catch {
      toast.error(t('storageNewFolderFailed'));
    } finally {
      setCreatingFolder(false);
    }
  };

  // ── Manual upload (multi-file, into the CURRENT folder) ──
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const handleUploadSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    if (!navPath) {
      // Belt-and-braces — the toolbar button is disabled at the root anyway.
      toast.error(t('storageUploadNoFolder'));
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('path', navPath);
      for (const f of Array.from(fileList)) formData.append('files', f);
      const res = await apiFetch('/api/admin/storage/upload', { method: 'POST', body: formData });
      const body = await res.json().catch(() => null);
      const data = unwrapPayload(body);
      if (res.ok && data && data.success !== false) {
        const count = asArray(data.uploaded).length;
        const skipped = asArray(data.skipped).length;
        if (skipped > 0) {
          toast.warning(`${t('storageUploadDone', { count: String(count) })} — ${skipped} skipped`);
        } else {
          toast.success(t('storageUploadDone', { count: String(count) }));
        }
        invalidateFolderCache([navPath]);
        fetchLevel(navPath, { force: true });
        fetchOverview(true);
      } else {
        const serverError = typeof data?.error === 'string' ? data.error : '';
        toast.error(serverError || t('storageUploadFailed'));
      }
    } catch {
      toast.error(t('storageUploadFailed'));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = '';
    }
  };

  // ── Move (single file via row button, or the whole selection) ──
  // Opens the destination picker: the full folder tree is fetched once per
  // open (GET /folders). Destinations that are no-ops (the items' current
  // folder) or dangerous (inside a selected folder) are disabled; the
  // server still reports per-item skips/conflicts as the final guard.
  const openMoveDialog = (file: StorageFileRow) => {
    setMoveTargets({ files: [file], folders: [], count: 1, label: file.name });
    setMoveDestination('');
    setFolderOptions(null);
    (async () => {
      try {
        const res = await apiFetch('/api/admin/storage/folders');
        const body = await res.json().catch(() => null);
        const data = unwrapPayload(body);
        const list = data && Array.isArray(data.folders)
          ? (data.folders as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : null;
        setFolderOptions(res.ok && list ? list : []);
      } catch {
        setFolderOptions([]);
      }
    })();
  };

  // Batch move — the selection bar entry point.
  const openBatchMove = () => {
    if (selectedFileRows.length + selectedFolderRows.length === 0) return;
    setMoveTargets({
      files: selectedFileRows,
      folders: selectedFolderRows,
      count: selectedFileRows.length + selectedFolderRows.length,
      label: '',
    });
    setMoveDestination('');
    setFolderOptions(null);
    (async () => {
      try {
        const res = await apiFetch('/api/admin/storage/folders');
        const body = await res.json().catch(() => null);
        const data = unwrapPayload(body);
        const list = data && Array.isArray(data.folders)
          ? (data.folders as unknown[]).filter((x): x is string => typeof x === 'string' && x !== '')
          : null;
        setFolderOptions(res.ok && list ? list : []);
      } catch {
        setFolderOptions([]);
      }
    })();
  };

  const confirmMoveFile = async () => {
    if (!moveTargets || !moveDestination || moving) return;
    setMoving(true);
    try {
      const paths = [
        ...moveTargets.files.map((f) => f.storagePath),
        ...moveTargets.folders.map((f) => f.path),
      ];
      const res = await apiFetch('/api/admin/storage/move-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, targetFolder: moveDestination }),
      });
      const body = await res.json().catch(() => null);
      const data = unwrapPayload(body);
      if (res.ok && data && data.success !== false) {
        const processed = num(data.processed);
        const failed = num(data.failed);
        if (processed > 0 && failed === 0) toast.success(t('storageBatchMoveDone', { count: String(processed) }));
        else if (processed > 0) toast.warning(t('storageBatchPartial', { ok: String(processed), total: String(processed + failed) }));
        else toast.error(t('storageMoveFailed'));
        setMoveTargets(null);
        setSelectedPaths(new Set());
        // Both the source (current) folder and the destination aggregates changed.
        invalidateFolderCache([navPath, moveDestination].filter(Boolean));
        fetchLevel(navPath, { force: true });
        fetchOverview(true);
      } else {
        const serverError = typeof data?.error === 'string' ? data.error : '';
        if (res.status === 409 || serverError.includes('already exists')) toast.error(t('storageMoveConflict'));
        else toast.error(serverError || t('storageMoveFailed'));
      }
    } catch {
      toast.error(t('storageMoveFailed'));
    } finally {
      setMoving(false);
    }
  };

  // ── Multi-select: toggles + select-all ──
  const toggleSelectPath = useCallback((p: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedPaths(new Set()), []);

  // ── Delete ──

  const confirmDeleteFile = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await apiFetch('/api/admin/storage/file', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: deleteTarget.storagePath }),
      });
      const body = await res.json().catch(() => null);
      const bodyRec = asRecord(body);
      if (res.ok && bodyRec && bodyRec.success !== false) {
        toast.success(t('storageDeleteDone'));
        const deletedPath = deleteTarget.storagePath;
        setDeleteTarget(null);
        // Drop every cached summary of the affected folder subtree (the
        // forced re-fetch below re-caches the current level) — the parent
        // folder's aggregate counts changed too.
        invalidateFolderCache([parentOf(deletedPath)]);
        if (navPath) fetchLevel(navPath, { force: true });
        fetchOverview(true);
      } else {
        toast.error(bodyRec?.error as string || t('storageDeleteFailed'));
      }
    } catch {
      toast.error(t('storageDeleteFailed'));
    } finally {
      setDeleting(false);
    }
  };

  // ── Batch delete (multi-select) — POST /delete-batch, mixed files+folders ──
  const confirmBatchDelete = async () => {
    const paths = [...selectedPaths];
    if (paths.length === 0 || batchDeleting) return;
    setBatchDeleting(true);
    try {
      const res = await apiFetch('/api/admin/storage/delete-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      const body = await res.json().catch(() => null);
      const data = unwrapPayload(body);
      if (res.ok && data && data.success !== false) {
        const processed = num(data.processed);
        const failed = num(data.failed);
        if (processed > 0 && failed === 0) toast.success(t('storageBatchDeleteDone', { count: String(processed) }));
        else if (processed > 0) toast.warning(t('storageBatchPartial', { ok: String(processed), total: String(processed + failed) }));
        else toast.error(t('storageBatchDeleteFailed'));
        setBatchDeleteOpen(false);
        setSelectedPaths(new Set());
        // Every selected item lives under the current level (selection is
        // cleared on navigation) — its subtree aggregates all changed.
        invalidateFolderCache([navPath]);
        fetchLevel(navPath, { force: true });
        fetchOverview(true);
      } else {
        const serverError = typeof data?.error === 'string' ? data.error : '';
        toast.error(serverError || t('storageBatchDeleteFailed'));
      }
    } catch {
      toast.error(t('storageBatchDeleteFailed'));
    } finally {
      setBatchDeleting(false);
    }
  };

  // ── Rename in place (same folder) ──
  // Client-side guard mirrors the server: bare filename, no separators, no
  // dot-names, must differ from the current name. Server enforces the rest
  // (existence, conflict 409, AppVersion/FileAsset repointing).
  const renameInvalid = useMemo(() => {
    const v = renameValue.trim();
    if (!v) return 'empty';
    if (/[\\/]/.test(v) || v === '.' || v === '..') return 'invalid';
    if (renameTarget && v === renameTarget.name) return 'unchanged';
    return null;
  }, [renameValue, renameTarget]);

  const confirmRenameFile = async () => {
    if (!renameTarget || renameInvalid) return;
    setRenaming(true);
    try {
      const res = await apiFetch('/api/admin/storage/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storagePath: renameTarget.storagePath, newName: renameValue.trim() }),
      });
      const body = await res.json().catch(() => null);
      const bodyRec = asRecord(body);
      if (res.ok && bodyRec && bodyRec.success !== false) {
        toast.success(t('storageRenameDone'));
        const renamedPath = renameTarget.storagePath;
        setRenameTarget(null);
        // Drop every cached summary of the affected folder subtree — the
        // listing shows the OLD name until re-fetched.
        invalidateFolderCache([parentOf(renamedPath)]);
        if (navPath) fetchLevel(navPath, { force: true });
        fetchOverview(true);
      } else {
        const serverError = typeof bodyRec?.error === 'string' ? bodyRec.error : '';
        if (serverError.includes('already exists')) toast.error(t('storageRenameConflict'));
        else toast.error(serverError || t('storageRenameFailed'));
      }
    } catch {
      toast.error(t('storageRenameFailed'));
    } finally {
      setRenaming(false);
    }
  };

  // ── Clipboard ──

  const copyText = async (text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast.success(t('storageCopied'));
    } catch {
      // Clipboard unavailable (permissions/insecure context) — stay silent,
      // the path is also visible/selectable on screen.
    }
  };

  // ── Download (Task 2-c-2) — admin streaming endpoint, BINARY-SAFE ──
  // Routes through lib/admin-download.ts: native fetch + real Blob. The
  // previous apiFetch() path text-decoded the stream and rebuilt a
  // 'text/plain' blob from JSON.stringify — every binary file saved corrupt.

  const downloadFile = useCallback(async (file: StorageFileRow) => {
    if (downloadingPath) return; // one download at a time — clear spinner
    setDownloadingPath(file.storagePath);
    try {
      const result = await downloadAdminStorageFile(file.storagePath, file.name);
      if (!result.ok) {
        toast.error(result.error || t('storageDownloadFailed'));
        return;
      }
      toast.success(t('storageDownloadStarted'));
    } catch {
      toast.error(t('storageDownloadFailed'));
    } finally {
      setDownloadingPath(null);
    }
  }, [downloadingPath, t]);

  // ── Derived ──

  const disk = overview?.disk ?? null;
  const totals = overview?.totals ?? null;
  const categories = overview?.categories ?? [];

  const filteredFiles = useMemo(() => {
    if (!browse) return [];
    const q = fileSearch.trim().toLowerCase();
    const base = q ? browse.files.filter((f) => f.name.toLowerCase().includes(q)) : browse.files;
    return sortFileRows(base, sortField, sortDir);
  }, [browse, fileSearch, sortField, sortDir]);

  // Folders follow the same name filter (files and folders searched together).
  const filteredFolders = useMemo(() => {
    if (!browse) return [];
    const q = fileSearch.trim().toLowerCase();
    return q ? browse.folders.filter((f) => f.name.toLowerCase().includes(q)) : browse.folders;
  }, [browse, fileSearch]);

  // ── Multi-select derived state ──
  // Selected rows known to the CURRENT level (searched-away selections stay
  // in the Set and are still processed — the server resolves by path).
  const selectedFileRows = useMemo(
    () => (browse?.files ?? []).filter((f) => selectedPaths.has(f.storagePath)),
    [browse, selectedPaths],
  );
  const selectedFolderRows = useMemo(
    () => (browse?.folders ?? []).filter((f) => selectedPaths.has(f.path)),
    [browse, selectedPaths],
  );
  const selectionCount = selectedFileRows.length + selectedFolderRows.length;
  const allVisibleFilesSelected = filteredFiles.length > 0 && filteredFiles.every((f) => selectedPaths.has(f.storagePath));
  const someVisibleFilesSelected = !allVisibleFilesSelected && filteredFiles.some((f) => selectedPaths.has(f.storagePath));

  const toggleSelectAllFiles = () => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (allVisibleFilesSelected) filteredFiles.forEach((f) => next.delete(f.storagePath));
      else filteredFiles.forEach((f) => next.add(f.storagePath));
      return next;
    });
  };

  // Full-literal Tailwind classes (JIT-safe) for the usage bar severity.
  const usageBarClass =
    disk && disk.usagePct >= 85
      ? '[&_[data-slot=progress-indicator]]:bg-red-500'
      : disk && disk.usagePct >= 65
        ? '[&_[data-slot=progress-indicator]]:bg-amber-500'
        : '[&_[data-slot=progress-indicator]]:bg-emerald-500';

  const chevronCls = `h-3.5 w-3.5 text-muted-foreground shrink-0 ${rtl ? 'rotate-180' : ''}`;

  // Task 2-c-2 — sort dropdown (field) + direction toggle, shared by the
  // flat-files listing and the month listing.
  const renderSortControls = () => (
    <div className="flex items-center gap-2">
      <Select value={sortField} onValueChange={(v) => setSortField(v as SortField)}>
        <SelectTrigger
          className="h-11 sm:h-9 w-[140px] rounded-xl text-[13px]"
          aria-label={t('storageSortBy')}
        >
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="date" className="min-h-[44px]">{t('storageSortDate')}</SelectItem>
          <SelectItem value="name" className="min-h-[44px]">{t('storageSortName')}</SelectItem>
          <SelectItem value="size" className="min-h-[44px]">{t('storageSortSize')}</SelectItem>
          <SelectItem value="type" className="min-h-[44px]">{t('storageSortType')}</SelectItem>
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        className="h-11 sm:h-9 w-11 sm:w-9 p-0 rounded-xl shrink-0"
        title={sortDir === 'asc' ? t('storageSortAsc') : t('storageSortDesc')}
        aria-label={sortDir === 'asc' ? t('storageSortAsc') : t('storageSortDesc')}
        onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
      >
        {sortDir === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
      </Button>
    </div>
  );

  // Task 2-c-2 — search + sort row shared by both file listings.
  const renderSearchSortRow = () => (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative flex-1 min-w-[180px] max-w-md">
        <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={fileSearch}
          onChange={(e) => setFileSearch(e.target.value)}
          placeholder={t('search')}
          className="ps-8 h-11 sm:h-9"
          aria-label={t('search')}
        />
      </div>
      {renderSortControls()}
    </div>
  );

  // ─── Render ───

  const renderBreadcrumb = () => (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 flex-wrap min-w-0 text-[13px]">
      <button
        type="button"
        onClick={() => openFolder('')}
        className="inline-flex items-center min-h-[44px] px-1 text-muted-foreground hover:text-foreground transition-colors truncate"
      >
        {t('storageAllCategories')}
      </button>
      {navPath.split('/').filter(Boolean).map((seg, i, arr) => {
        const segPath = arr.slice(0, i + 1).join('/');
        const isLast = i === arr.length - 1;
        return (
          <span key={segPath} className="inline-flex items-center gap-1 min-w-0">
            <ChevronRight className={chevronCls} aria-hidden="true" />
            {isLast ? (
              <span aria-current="page" className="font-medium text-foreground truncate">
                {seg}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => openFolder(segPath)}
                className="inline-flex items-center min-h-[44px] px-1 text-muted-foreground hover:text-foreground transition-colors truncate"
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );

  /** Explorer toolbar — New Folder / Upload (into the CURRENT folder). */
  const renderToolbar = () => (
    <div className="flex items-center gap-2 flex-wrap shrink-0">
      <Button
        variant="outline"
        size="sm"
        className="h-11 sm:h-9 rounded-xl"
        onClick={() => { setNewFolderName(''); setNewFolderOpen(true); }}
        disabled={loadingBrowse || creatingFolder}
      >
        <FolderPlus className="h-4 w-4 me-1" />
        {t('storageNewFolder')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-11 sm:h-9 rounded-xl"
        disabled={!navPath || uploading || loadingBrowse}
        title={!navPath ? t('storageUploadNoFolder') : t('storageUpload')}
        onClick={() => uploadInputRef.current?.click()}
      >
        {uploading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <Upload className="h-4 w-4 me-1" />}
        {uploading ? t('storageUploading') : t('storageUpload')}
      </Button>
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => { void handleUploadSelected(e.target.files); }}
      />
    </div>
  );

  const renderExplorerBody = () => {
    if (loadingBrowse && !browse) {
      return (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      );
    }
    if (!browse) return null;

    const atRoot = !navPath;
    if (browse.folders.length === 0 && browse.files.length === 0) {
      return (
        <div className="text-center py-12 text-muted-foreground">
          <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">{atRoot ? t('noData') : t('storageEmptyFolder')}</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Folders first — buckets at the root, admin subfolders deeper. */}
        {browse.folders.length > 0 && (
          <div className="space-y-2">
            <p className="text-[13px] font-medium flex items-center gap-2">
              <FolderOpen className="h-3.5 w-3.5 text-emerald-600" />
              {t('storageFolders')}
              <Badge variant="secondary" className="text-[10px]">{browse.folders.length}</Badge>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {filteredFolders.map((folder) => {
                const Icon = atRoot ? bucketIcon(folder.name) : Folder;
                const label = atRoot && BUCKET_LABEL[folder.name] ? t(bucketLabelKey(folder.name)) : folder.name;
                const folderSelected = selectedPaths.has(folder.path);
                return (
                  <div
                    key={folder.path}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all ${
                      folderSelected
                        ? 'border-emerald-400 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/10'
                        : 'border-border hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10'
                    }`}
                  >
                    <Checkbox
                      checked={folderSelected}
                      onCheckedChange={() => toggleSelectPath(folder.path)}
                      aria-label={`${t('storageSelectAll')}: ${folder.name}`}
                      className="shrink-0"
                    />
                    <button
                      type="button"
                      onClick={() => openFolder(folder.path)}
                      className="group flex items-center gap-3 flex-1 min-w-0 text-start"
                    >
                      <div className="h-9 w-9 rounded-lg bg-muted/60 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30 flex items-center justify-center shrink-0 transition-colors">
                        <Icon className="h-4 w-4 text-muted-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold truncate" title={folder.name}>{label}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {t('storageFilesCount', { count: compactNumber(folder.files) })}
                          {folder.folders > 0 ? ` · ${folder.folders} ↳` : ''} · {humanSize(folder.bytes)}
                        </p>
                      </div>
                      <ChevronRight className={chevronCls} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {browse.files.length > 0 && (
          <div className="space-y-2">
            <p className="text-[13px] font-medium flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-emerald-600" />
              {t('storageFileName')}
              <Badge variant="secondary" className="text-[10px]">{browse.files.length}</Badge>
            </p>
            {renderSearchSortRow()}
            <StorageFilesTable
              files={filteredFiles}
              t={t}
              lang={lang}
              onCopy={copyText}
              onAskDelete={setDeleteTarget}
              onAskRename={(f) => { setRenameTarget(f); setRenameValue(f.name); }}
              onAskMove={openMoveDialog}
              onPreview={setPreviewTarget}
              onDownload={downloadFile}
              downloadingPath={downloadingPath}
              isSelected={(p) => selectedPaths.has(p)}
              onToggleSelect={toggleSelectPath}
              allSelected={allVisibleFilesSelected}
              someSelected={someVisibleFilesSelected}
              onToggleSelectAll={toggleSelectAllFiles}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* Header */}
      <motion.div {...fadeUp}>
        <Card>
          <CardContent className="p-4 lg:p-5">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/40 dark:to-teal-900/30 flex items-center justify-center shrink-0">
                <HardDrive className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="font-bold text-lg text-foreground">{t('storageManagerTitle')}</h1>
                <p className="text-xs text-muted-foreground">{t('storageManagerDesc')}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshCurrent}
                disabled={refreshing || loadingBrowse}
              >
                {refreshing || loadingBrowse ? (
                  <Loader2 className="h-4 w-4 animate-spin me-1" />
                ) : (
                  <RefreshCw className="h-4 w-4 me-1" />
                )}
                {t('storageRefresh')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* EXPLORER — the primary content, FIRST after the header (user report:
          the old browser sat below the stats and its 480px viewport was too
          small). Breadcrumb + New Folder / Upload toolbar + a tall
          file-manager viewport (folders first, files below). */}
      <motion.div {...fadeUp} transition={{ delay: 0.05 }}>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <CardTitle className="text-base flex items-center gap-2 min-w-0 flex-1">
                  {navPath ? (
                    <button
                      type="button"
                      onClick={backOneLevel}
                      disabled={loadingBrowse}
                      className="shrink-0"
                      title={t('storageBack')}
                      aria-label={t('storageBack')}
                    >
                      <ArrowLeft className={`h-4 w-4 text-muted-foreground hover:text-foreground transition-colors ${rtl ? 'rotate-180' : ''}`} />
                    </button>
                  ) : (
                    <Folder className="h-4 w-4 text-emerald-600 shrink-0" />
                  )}
                  <span className="truncate">
                    {!navPath
                      ? t('storageCategories')
                      : navPath.split('/').filter(Boolean).pop()}
                  </span>
                  {loadingBrowse && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
                  {browse && (browse.folders.length > 0 || browse.files.length > 0) && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {t('storageFilesCount', { count: compactNumber(browse.totals.files) })} · {humanSize(browse.totals.bytes)}
                    </Badge>
                  )}
                </CardTitle>
                {navPath && (
                  <Button variant="outline" size="sm" onClick={backOneLevel} disabled={loadingBrowse} className="shrink-0">
                    <ArrowLeft className={`h-4 w-4 me-1 ${rtl ? 'rotate-180' : ''}`} />
                    {t('storageBack')}
                  </Button>
                )}
              </div>
              <div className="flex items-end sm:items-center justify-between gap-2 flex-wrap">
                <CardDescription className="min-w-0 flex-1">{renderBreadcrumb()}</CardDescription>
                {renderToolbar()}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Multi-select action bar — appears when at least one file or
                folder is checked (batch delete / move). */}
            {selectionCount > 0 && (
              <div
                className="mb-3 flex items-center gap-2 flex-wrap rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-900/20 p-2"
                role="toolbar"
                aria-label={t('storageSelectedCount', { count: String(selectionCount) })}
              >
                <Badge className="bg-emerald-600 text-white hover:bg-emerald-600 text-[11px] shrink-0">
                  {t('storageSelectedCount', { count: String(selectionCount) })}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 sm:h-8 rounded-lg"
                  disabled={moving || loadingBrowse}
                  onClick={openBatchMove}
                >
                  <FolderInput className="h-3.5 w-3.5 me-1" />
                  {t('storageBatchMove')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 sm:h-8 rounded-lg text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 border-red-200 dark:border-red-900"
                  disabled={batchDeleting || loadingBrowse}
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5 me-1" />
                  {t('storageBatchDelete')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 sm:h-8 rounded-lg ms-auto"
                  onClick={clearSelection}
                >
                  <X className="h-3.5 w-3.5 me-1" />
                  {t('storageClearSelection')}
                </Button>
              </div>
            )}
            {/* Tall file-manager viewport (user report: the old 480px window
                felt cramped) — folders grid + files table scroll together. */}
            <div className="h-[calc(100vh-330px)] min-h-[420px] overflow-y-auto custom-scrollbar pe-1">
              {renderExplorerBody()}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Disk usage — hidden entirely when the platform exposes no statfs */}
      {disk && (
        <motion.div {...fadeUp} transition={{ delay: 0.1 }}>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-emerald-600" />
                {t('storageDiskUsage')}
                <Badge variant="secondary">{disk.usagePct}%</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Progress value={disk.usagePct} className={`h-2.5 ${usageBarClass}`} aria-label={t('storageDiskUsage')} />
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-muted/40 p-3">
                  <p className="text-[11px] text-muted-foreground mb-1">{t('storageDiskUsed')}</p>
                  <p className="text-sm font-bold">{disk.usedGb.toFixed(1)} GB</p>
                </div>
                <div className="rounded-xl bg-muted/40 p-3">
                  <p className="text-[11px] text-muted-foreground mb-1">{t('storageDiskFree')}</p>
                  <p className="text-sm font-bold">{disk.freeGb.toFixed(1)} GB</p>
                </div>
                <div className="rounded-xl bg-muted/40 p-3">
                  <p className="text-[11px] text-muted-foreground mb-1">{t('storageDiskTotal')}</p>
                  <p className="text-sm font-bold">{disk.totalGb.toFixed(1)} GB</p>
                </div>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('storageStorageRoot')}:</span>
                <code className="font-mono text-[11px] truncate flex-1 min-w-0" title={overview?.storageRoot}>
                  {overview?.storageRoot}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 shrink-0"
                  title={t('storageCopyPath')}
                  aria-label={t('storageCopyPath')}
                  onClick={() => overview && copyText(overview.storageRoot)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Totals row */}
      {totals && (
        <motion.div {...fadeUp} transition={{ delay: 0.15 }} className="space-y-2">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium">{t('storageTotalFiles')}</span>
                </div>
                <p className="text-xl font-bold">{compactNumber(totals.files)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <HardDrive className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium">{t('storageTotalSize')}</span>
                </div>
                <p className="text-xl font-bold">{humanSize(totals.bytes)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {totals.bytes.toLocaleString()} {t('storageBytesUnit')}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Package className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium">{t('storageDbTracked')}</span>
                </div>
                <p className="text-xl font-bold">{compactNumber(totals.dbTracked)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span className="text-[11px] font-medium">{t('storageOrphans')}</span>
                  {totals.orphans > 0 && (
                    <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300">
                      {t('storageOrphans')}: {compactNumber(totals.orphans)}
                    </Badge>
                  )}
                  {totals.missing > 0 && (
                    <Badge className="text-[10px] bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/40 dark:text-red-300">
                      {t('storageMissing')}: {compactNumber(totals.missing)}
                    </Badge>
                  )}
                </div>
                <p className="text-xl font-bold">
                  {compactNumber(totals.orphans)}
                  <span className="text-sm font-medium text-muted-foreground"> / {compactNumber(totals.missing)}</span>
                </p>
                {totals.orphans > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{t('storageOrphanHint')}</p>
                )}
                {totals.missing > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{t('storageMissingHint')}</p>
                )}
              </CardContent>
            </Card>
          </div>
          {totals.walkErrors > 0 && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3 text-amber-600" />
              {t('storageWalkErrors')}: {compactNumber(totals.walkErrors)}
            </p>
          )}
        </motion.div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('storageDelete')}
        description={t('storageDeleteConfirm', { name: deleteTarget?.name ?? '' })}
        confirmLabel={t('storageDelete')}
        cancelLabel={t('cancel')}
        variant="danger"
        loading={deleting}
        onConfirm={confirmDeleteFile}
      />

      {/* MULTI-SELECT batch delete confirmation — folders are recursive. */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={(o) => { if (!o) setBatchDeleteOpen(false); }}
        title={t('storageBatchDelete')}
        description={t('storageBatchDeleteConfirm', { count: String(selectionCount) })}
        confirmLabel={t('storageDelete')}
        cancelLabel={t('cancel')}
        variant="danger"
        loading={batchDeleting}
        onConfirm={confirmBatchDelete}
      />

      {/* Rename in place — dialog with an input (ConfirmDialog is text-only). */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(o) => { if (!o) setRenameTarget(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('storageRename')}</DialogTitle>
            <DialogDescription className="break-all">
              {t('storageRenameDesc', { name: renameTarget?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder={t('storageRenameNewName')}
              dir="ltr"
              autoFocus
              disabled={renaming}
              onKeyDown={(e) => { if (e.key === 'Enter' && !renameInvalid && !renaming) confirmRenameFile(); }}
              aria-invalid={!!renameInvalid}
            />
            {renameInvalid && (
              <p className="text-xs text-muted-foreground">
                {renameInvalid === 'empty'
                  ? t('storageRenameNewName')
                  : renameInvalid === 'invalid'
                    ? t('storageRenameInvalid')
                    : t('storageRenameUnchanged')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)} disabled={renaming}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={confirmRenameFile} disabled={!!renameInvalid || renaming}>
              {renaming ? <Loader2 className="h-4 w-4 animate-spin" /> : t('storageRename')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New folder — created INSIDE the currently open folder. */}
      <Dialog
        open={newFolderOpen}
        onOpenChange={(o) => { if (!o) setNewFolderOpen(false); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('storageNewFolder')}</DialogTitle>
            <DialogDescription className="break-all">
              {t('storageNewFolderName')}
              {navPath ? (
                <code className="font-mono ms-1" title={navPath}>{navPath}</code>
              ) : (
                <span className="ms-1">({t('storageAllCategories')})</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t('storageNewFolderNamePh')}
              autoFocus
              disabled={creatingFolder}
              onKeyDown={(e) => { if (e.key === 'Enter' && !newFolderNameInvalid && !creatingFolder) confirmCreateFolder(); }}
              aria-invalid={!!newFolderNameInvalid}
              aria-label={t('storageNewFolderName')}
            />
            {newFolderNameInvalid && (
              <p className="text-xs text-muted-foreground">
                {newFolderNameInvalid === 'empty'
                  ? t('storageNewFolderName')
                  : t('storageNewFolderInvalid')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setNewFolderOpen(false)} disabled={creatingFolder}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={confirmCreateFolder} disabled={!!newFolderNameInvalid || creatingFolder}>
              {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4 me-1" />}
              {t('storageNewFolder')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Move — destination picker over the WHOLE folder tree (works for a
          single file via the row button AND for the multi-selection). The
          items' current folder is disabled (no-op); destinations INSIDE a
          selected folder are disabled (a folder cannot move into itself);
          the server reports per-item skips/conflicts as the final guard. */}
      <Dialog
        open={!!moveTargets}
        onOpenChange={(o) => { if (!o) setMoveTargets(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {moveTargets && moveTargets.count > 1 ? t('storageBatchMoveTitle') : t('storageMoveTitle')}
            </DialogTitle>
            <DialogDescription className="break-all">
              {moveTargets && moveTargets.count > 1
                ? t('storageBatchMoveDesc', { count: String(moveTargets.count) })
                : t('storageMoveDesc', { name: moveTargets?.label ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="shrink-0">{t('storageMoveCurrentLocation')}:</span>
            <code className="font-mono truncate" title={navPath}>
              {navPath || '/' }
            </code>
          </p>
          <div className="rounded-xl border max-h-[45vh] overflow-y-auto custom-scrollbar" role="radiogroup" aria-label={t('storageMoveTarget')}>
            {folderOptions === null ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('storageLoadingFolders')}
              </div>
            ) : folderOptions.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">{t('noData')}</div>
            ) : (
              <div className="p-1.5 space-y-0.5">
                {folderOptions.map((folderPath) => {
                  // No-op destination: the items' current folder.
                  const isCurrent = folderPath === navPath;
                  // Dangerous: inside any selected folder (would move a
                  // folder into itself / a descendant).
                  const insideSelected = !!moveTargets && moveTargets.folders.some(
                    (sel) => folderPath === sel.path || folderPath.startsWith(`${sel.path}/`),
                  );
                  const disabled = isCurrent || insideSelected;
                  const depth = folderPath ? folderPath.split('/').length - 1 : 0;
                  const selected = moveDestination === folderPath;
                  return (
                    <button
                      key={folderPath}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={disabled}
                      onClick={() => setMoveDestination(folderPath)}
                      className={`w-full flex items-center gap-2 min-h-[44px] px-2.5 rounded-lg text-start transition-colors ${
                        disabled
                          ? 'opacity-50 cursor-not-allowed'
                          : selected
                            ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-300'
                            : 'hover:bg-muted/60'
                      }`}
                      style={{ paddingInlineStart: `${10 + depth * 14}px` }}
                    >
                      <Folder className={`h-4 w-4 shrink-0 ${selected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                      <span className="font-mono text-[12px] truncate flex-1" title={folderPath}>
                        {folderPath}
                      </span>
                      {isCurrent && (
                        <Badge variant="secondary" className="text-[10px] shrink-0">{t('storageMoveCurrentLocation')}</Badge>
                      )}
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setMoveTargets(null)} disabled={moving}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={confirmMoveFile} disabled={!moveDestination || moving}>
              {moving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4 me-1" />}
              {t('storageMoveHere')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* File preview (image / PDF / video / audio / text) */}
      <StoragePreviewDialog
        file={previewTarget}
        open={!!previewTarget}
        onOpenChange={(o) => { if (!o) setPreviewTarget(null); }}
        t={t}
        lang={lang}
        onCopy={copyText}
        onDownload={downloadFile}
        downloading={!!previewTarget && downloadingPath === previewTarget.storagePath}
      />
    </div>
  );
}
