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
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
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

interface YearRow {
  yyyy: string;
  folders: number;
  files: number;
  bytes: number;
}

interface MonthRow {
  mm: string;
  files: number;
  bytes: number;
}

/** Group folder inside a system bucket (e.g. app-versions/desktop + /mobile). */
interface GroupRow {
  group: string;
  files: number;
  bytes: number;
}

interface StorageFileRow {
  name: string;
  storagePath: string;
  size: number;
  mtimeMs: number;
  url: string | null;
  tracked: boolean;
}

type BrowseData =
  | { level: 1; bucket: string; years: YearRow[]; groups: GroupRow[]; flatFiles: StorageFileRow[] }
  | { level: 2; bucket: string; yyyy: string; months: MonthRow[] }
  | { level: 3; bucket: string; yyyy: string; mm: string; files: StorageFileRow[] };

interface NavState {
  bucket: string | null;
  yyyy: string | null;
  mm: string | null;
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

function normYear(v: unknown): YearRow | null {
  const r = asRecord(v);
  if (!r || typeof r.yyyy !== 'string') return null;
  return { yyyy: r.yyyy, folders: num(r.folders), files: num(r.files), bytes: num(r.bytes) };
}

function normGroup(v: unknown): GroupRow | null {
  const r = asRecord(v);
  if (!r || typeof r.group !== 'string') return null;
  return { group: r.group, files: num(r.files), bytes: num(r.bytes) };
}

function normMonth(v: unknown): MonthRow | null {
  const r = asRecord(v);
  if (!r || typeof r.mm !== 'string') return null;
  return { mm: r.mm, files: num(r.files), bytes: num(r.bytes) };
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

function pathKey(bucket: string, yyyy: string | null, mm: string | null): string {
  return mm && yyyy ? `${bucket}/${yyyy}/${mm}` : yyyy ? `${bucket}/${yyyy}` : bucket;
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
  onPreview: (file: StorageFileRow) => void;
  onDownload: (file: StorageFileRow) => void;
  downloadingPath: string | null;
}

function StorageFilesTable({ files, t, lang, onCopy, onAskDelete, onAskRename, onPreview, onDownload, downloadingPath }: FilesTableProps) {
  return (
    <div className="rounded-xl border overflow-hidden">
      {/* Long lists scroll inside a bounded viewport — custom scrollbar
          styling per the 2-c-2 navigation upgrades. */}
      <div className="max-h-[480px] overflow-y-auto custom-scrollbar">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
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
                <TableCell colSpan={5} className="text-center py-10 text-muted-foreground text-sm">
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
                <TableRow key={f.storagePath || idx}>
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

  // Drill-down navigation (level is derived: null bucket = categories grid)
  const [nav, setNav] = useState<NavState>({ bucket: null, yyyy: null, mm: null });
  const [browse, setBrowse] = useState<BrowseData | null>(null);
  const [loadingBrowse, setLoadingBrowse] = useState(false);

  // Per-path cache so Back/breadcrumb navigation never blanks out — ALL
  // fetched levels stay in component state. Invalidated per-bucket on delete.
  const [cache, setCache] = useState<Record<string, BrowseData>>({});

  // Level-3 client-side name filter (Task 2-c-2: also applied to the
  // legacy flat-files listing at level 1).
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

  // ── Browse fetch (level 1/2/3) ──
  const fetchLevel = useCallback(async (
    bucket: string,
    yyyy: string | null,
    mm: string | null,
    opts?: { force?: boolean }
  ) => {
    const key = pathKey(bucket, yyyy, mm);
    if (!opts?.force) {
      const cached = cache[key];
      if (cached) {
        setBrowse(cached);
        return;
      }
    }
    setLoadingBrowse(true);
    try {
      const params = new URLSearchParams({ bucket });
      if (yyyy) params.set('yyyy', yyyy);
      if (mm) params.set('mm', mm);
      const res = await apiFetch(`/api/admin/storage/browse?${params.toString()}`);
      const body = await res.json().catch(() => null);
      const data = unwrapPayload(body);
      if (!res.ok || !data) {
        toast.error(t('storageLoadFailed'));
        return;
      }
      let next: BrowseData | null = null;
      if (mm && yyyy) {
        const files = asArray(data.files).map(normFile).filter((f): f is StorageFileRow => f !== null);
        if (Array.isArray(data.files)) next = { level: 3, bucket, yyyy, mm, files };
      } else if (yyyy) {
        const months = asArray(data.months).map(normMonth).filter((m): m is MonthRow => m !== null);
        if (Array.isArray(data.months)) {
          next = { level: 2, bucket, yyyy, months };
        } else if (Array.isArray(data.files)) {
          // Group folder (system bucket, e.g. app-versions/desktop): the API
          // answers with a files listing directly (mm stays '').
          const files = asArray(data.files).map(normFile).filter((f): f is StorageFileRow => f !== null);
          next = { level: 3, bucket, yyyy, mm: '', files };
        }
      } else {
        const years = asArray(data.years).map(normYear).filter((y): y is YearRow => y !== null);
        const groups = asArray(data.groups).map(normGroup).filter((g): g is GroupRow => g !== null);
        const flatFiles = asArray(data.flatFiles).map(normFile).filter((f): f is StorageFileRow => f !== null);
        if (Array.isArray(data.years)) next = { level: 1, bucket, years, groups, flatFiles };
      }
      if (!next) {
        toast.error(t('storageLoadFailed'));
        return;
      }
      setCache((prev) => ({ ...prev, [key]: next as BrowseData }));
      setBrowse(next);
    } catch {
      toast.error(t('storageLoadFailed'));
    } finally {
      setLoadingBrowse(false);
    }
  }, [cache, t]);

  // ── Navigation handlers ──

  const openBucket = (bucket: string) => {
    setFileSearch('');
    setNav({ bucket, yyyy: null, mm: null });
    setBrowse(null); // skeleton while fetching (cache hit resolves instantly)
    fetchLevel(bucket, null, null);
  };

  const openYear = (yyyy: string) => {
    if (!nav.bucket) return;
    setFileSearch('');
    setNav({ bucket: nav.bucket, yyyy, mm: null });
    setBrowse(null);
    fetchLevel(nav.bucket, yyyy, null);
  };

  const openMonth = (mm: string) => {
    if (!nav.bucket || !nav.yyyy) return;
    setFileSearch('');
    setNav({ bucket: nav.bucket, yyyy: nav.yyyy, mm });
    setBrowse(null);
    fetchLevel(nav.bucket, nav.yyyy, mm);
  };

  /** Breadcrumb/back navigation — restores cached data instantly when hit. */
  const backTo = (target: NavState) => {
    setFileSearch('');
    if (!target.bucket) {
      setNav({ bucket: null, yyyy: null, mm: null });
      setBrowse(null);
      return;
    }
    setNav(target);
    setBrowse(null);
    fetchLevel(target.bucket, target.yyyy, target.mm);
  };

  const backOneLevel = () => {
    if (nav.mm) backTo({ bucket: nav.bucket, yyyy: nav.yyyy, mm: null });
    else if (nav.yyyy) backTo({ bucket: nav.bucket, yyyy: null, mm: null });
    else backTo({ bucket: null, yyyy: null, mm: null });
  };

  /** Header refresh — reloads the CURRENT level (overview at level 0). */
  const refreshCurrent = () => {
    if (!nav.bucket) {
      fetchOverview(true);
      return;
    }
    fetchLevel(nav.bucket, nav.yyyy, nav.mm, { force: true });
  };

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
        // Drop every cached summary of the affected bucket subtree (the
        // forced re-fetch below re-caches the current level).
        const bucket = deletedPath.split('/')[0] || nav.bucket || '';
        setCache((prev) => {
          const next: Record<string, BrowseData> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (k !== bucket && !k.startsWith(`${bucket}/`)) next[k] = v;
          }
          return next;
        });
        if (nav.bucket) fetchLevel(nav.bucket, nav.yyyy, nav.mm, { force: true });
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
        // Drop every cached summary of the affected bucket subtree — the
        // listing shows the OLD name until re-fetched.
        const bucket = renamedPath.split('/')[0] || nav.bucket || '';
        setCache((prev) => {
          const next: Record<string, BrowseData> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (k !== bucket && !k.startsWith(`${bucket}/`)) next[k] = v;
          }
          return next;
        });
        if (nav.bucket) fetchLevel(nav.bucket, nav.yyyy, nav.mm, { force: true });
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
    if (!browse || browse.level !== 3) return [];
    const q = fileSearch.trim().toLowerCase();
    const base = q ? browse.files.filter((f) => f.name.toLowerCase().includes(q)) : browse.files;
    return sortFileRows(base, sortField, sortDir);
  }, [browse, fileSearch, sortField, sortDir]);

  // Level-1 legacy flat files — same search + sort treatment.
  const levelOneFlatFiles = browse && browse.level === 1 ? browse.flatFiles : [];
  const filteredFlatFiles = useMemo(() => {
    const q = fileSearch.trim().toLowerCase();
    const base = q ? levelOneFlatFiles.filter((f) => f.name.toLowerCase().includes(q)) : levelOneFlatFiles;
    return sortFileRows(base, sortField, sortDir);
  }, [levelOneFlatFiles, fileSearch, sortField, sortDir]);

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
        onClick={() => backTo({ bucket: null, yyyy: null, mm: null })}
        className="inline-flex items-center min-h-[44px] px-1 text-muted-foreground hover:text-foreground transition-colors truncate"
      >
        {t('storageAllCategories')}
      </button>
      {nav.bucket && (
        <>
          <ChevronRight className={chevronCls} aria-hidden="true" />
          {nav.yyyy || nav.mm ? (
            <button
              type="button"
              onClick={() => backTo({ bucket: nav.bucket, yyyy: null, mm: null })}
              className="inline-flex items-center min-h-[44px] px-1 text-muted-foreground hover:text-foreground transition-colors truncate"
            >
              {t(bucketLabelKey(nav.bucket))}
            </button>
          ) : (
            <span aria-current="page" className="font-medium text-foreground truncate">
              {t(bucketLabelKey(nav.bucket))}
            </span>
          )}
        </>
      )}
      {nav.bucket && nav.yyyy && (
        <>
          <ChevronRight className={chevronCls} aria-hidden="true" />
          {nav.mm ? (
            <button
              type="button"
              onClick={() => backTo({ bucket: nav.bucket, yyyy: nav.yyyy, mm: null })}
              className="inline-flex items-center min-h-[44px] px-1 font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              {nav.yyyy}
            </button>
          ) : (
            <span aria-current="page" className="font-mono font-medium text-foreground">
              {nav.yyyy}
            </span>
          )}
        </>
      )}
      {nav.bucket && nav.yyyy && nav.mm && (
        <>
          <ChevronRight className={chevronCls} aria-hidden="true" />
          <span aria-current="page" className="font-mono font-medium text-foreground">
            {nav.mm}
          </span>
        </>
      )}
    </nav>
  );

  const renderBrowserContent = () => {
    // Level 0 — categories grid (no fetch: straight from the overview).
    if (!nav.bucket) {
      if (loadingOverview && !overview) {
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        );
      }
      if (categories.length === 0) {
        return (
          <div className="text-center py-12 text-muted-foreground">
            <Folder className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">{t('noData')}</p>
          </div>
        );
      }
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {categories.map((cat) => {
            const Icon = bucketIcon(cat.bucket);
            return (
              <button
                key={cat.bucket}
                type="button"
                onClick={() => openBucket(cat.bucket)}
                className="group flex flex-col gap-2.5 p-4 rounded-xl border border-border text-start hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-all"
              >
                <div className="flex items-center gap-3 w-full">
                  <div className="h-10 w-10 rounded-lg bg-muted/60 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30 flex items-center justify-center shrink-0 transition-colors">
                    <Icon className="h-5 w-5 text-muted-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{t(bucketLabelKey(cat.bucket))}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {humanSize(cat.bytes)} · {t('storageFilesCount', { count: compactNumber(cat.files) })}
                    </p>
                  </div>
                  <ChevronRight className={chevronCls} aria-hidden="true" />
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant="secondary" className="text-[10px]">
                    {t('storageDbTracked')}: {compactNumber(cat.dbCount)}
                  </Badge>
                  {cat.system && (
                    <Badge className="text-[10px] bg-muted text-muted-foreground hover:bg-muted">
                      {t('storageSystem')}
                    </Badge>
                  )}
                  {cat.orphans > 0 && (
                    <Badge className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300">
                      {t('storageOrphans')}: {compactNumber(cat.orphans)}
                    </Badge>
                  )}
                  {cat.missing > 0 && (
                    <Badge className="text-[10px] bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/40 dark:text-red-300">
                      {t('storageMissing')}: {compactNumber(cat.missing)}
                    </Badge>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      );
    }

    // Loading a deeper level with nothing to show yet → skeletons.
    if (!browse) {
      return loadingBrowse ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null;
    }

    // Level 1 — bucket: group folders (installers) + year rows + legacy flat files.
    if (browse.level === 1) {
      return (
        <div className="space-y-4">
          {browse.years.length === 0 && browse.groups.length === 0 && browse.flatFiles.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Folder className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t('noData')}</p>
            </div>
          ) : (
            <>
              {browse.years.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                  {browse.years.map((y) => (
                    <button
                      key={y.yyyy}
                      type="button"
                      onClick={() => openYear(y.yyyy)}
                      className="group flex items-center gap-3 p-3 rounded-xl border border-border text-start hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-all"
                    >
                      <div className="h-9 w-9 rounded-lg bg-muted/60 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30 flex items-center justify-center shrink-0 transition-colors">
                        <Folder className="h-4 w-4 text-muted-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-[13px] font-semibold">{y.yyyy}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {t('storageMonths')}: {y.folders} · {t('storageFilesCount', { count: compactNumber(y.files) })} · {humanSize(y.bytes)}
                        </p>
                      </div>
                      <ChevronRight className={chevronCls} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              {browse.groups.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[13px] font-medium flex items-center gap-2">
                    <FolderOpen className="h-3.5 w-3.5 text-emerald-600" />
                    {t('storageFolders')}
                    <Badge variant="secondary" className="text-[10px]">{browse.groups.length}</Badge>
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
                    {browse.groups.map((g) => (
                      <button
                        key={g.group}
                        type="button"
                        onClick={() => openYear(g.group)}
                        className="group flex items-center gap-3 p-3 rounded-xl border border-border text-start hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-all"
                      >
                        <div className="h-9 w-9 rounded-lg bg-emerald-100/60 dark:bg-emerald-900/20 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30 flex items-center justify-center shrink-0 transition-colors">
                          <Folder className="h-4 w-4 text-emerald-600 dark:text-emerald-400 transition-colors" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-mono text-[13px] font-semibold">{g.group}</p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {t('storageFilesCount', { count: compactNumber(g.files) })} · {humanSize(g.bytes)}
                          </p>
                        </div>
                        <ChevronRight className={chevronCls} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {browse.flatFiles.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[13px] font-medium flex items-center gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    {t('storageFlatFiles')}
                    <Badge variant="secondary" className="text-[10px]">{browse.flatFiles.length}</Badge>
                  </p>
                  {/* Task 2-c-2 — search + sort for the legacy flat files too */}
                  {renderSearchSortRow()}
                  <StorageFilesTable
                    files={filteredFlatFiles}
                    t={t}
                    lang={lang}
                    onCopy={copyText}
                    onAskDelete={setDeleteTarget}
                    onAskRename={(f) => { setRenameTarget(f); setRenameValue(f.name); }}
                    onPreview={setPreviewTarget}
                    onDownload={downloadFile}
                    downloadingPath={downloadingPath}
                  />
                </div>
              )}
            </>
          )}
        </div>
      );
    }

    // Level 2 — bucket/yyyy: month rows.
    if (browse.level === 2) {
      if (browse.months.length === 0) {
        return (
          <div className="text-center py-12 text-muted-foreground">
            <Folder className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">{t('noData')}</p>
          </div>
        );
      }
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
          {browse.months.map((m) => (
            <button
              key={m.mm}
              type="button"
              onClick={() => openMonth(m.mm)}
              className="group flex items-center gap-3 p-3 rounded-xl border border-border text-start hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-all"
            >
              <div className="h-9 w-9 rounded-lg bg-muted/60 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/30 flex items-center justify-center shrink-0 transition-colors">
                <Folder className="h-4 w-4 text-muted-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[13px] font-semibold">{m.mm}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {t('storageFilesCount', { count: compactNumber(m.files) })} · {humanSize(m.bytes)}
                </p>
              </div>
              <ChevronRight className={chevronCls} aria-hidden="true" />
            </button>
          ))}
        </div>
      );
    }

    // Level 3 — bucket/yyyy/mm: searchable files table.
    return (
      <div className="space-y-3">
        {/* Task 2-c-2 — search + sort (field × direction) controls */}
        {renderSearchSortRow()}
        <StorageFilesTable
          files={filteredFiles}
          t={t}
          lang={lang}
          onCopy={copyText}
          onAskDelete={setDeleteTarget}
          onAskRename={(f) => { setRenameTarget(f); setRenameValue(f.name); }}
          onPreview={setPreviewTarget}
          onDownload={downloadFile}
          downloadingPath={downloadingPath}
        />
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

      {/* Disk usage — hidden entirely when the platform exposes no statfs */}
      {disk && (
        <motion.div {...fadeUp} transition={{ delay: 0.05 }}>
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
        <motion.div {...fadeUp} transition={{ delay: 0.1 }} className="space-y-2">
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

      {/* Browser */}
      <motion.div {...fadeUp} transition={{ delay: 0.15 }}>
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <CardTitle className="text-base flex items-center gap-2 min-w-0">
                  {nav.bucket ? (
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
                    {!nav.bucket
                      ? t('storageCategories')
                      : browse?.level === 2
                        ? nav.yyyy
                        : browse?.level === 3
                          ? nav.mm
                            ? `${nav.yyyy}/${nav.mm}`
                            : nav.yyyy
                          : t(bucketLabelKey(nav.bucket))}
                  </span>
                  {loadingBrowse && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
                </CardTitle>
              </div>
              {nav.bucket && (
                <Button variant="outline" size="sm" onClick={backOneLevel} disabled={loadingBrowse} className="shrink-0 self-start sm:self-auto">
                  <ArrowLeft className={`h-4 w-4 me-1 ${rtl ? 'rotate-180' : ''}`} />
                  {t('storageBack')}
                </Button>
              )}
            </div>
            <CardDescription className="mt-1">{renderBreadcrumb()}</CardDescription>
          </CardHeader>
          <CardContent>{renderBrowserContent()}</CardContent>
        </Card>
      </motion.div>

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
