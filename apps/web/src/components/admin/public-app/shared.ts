'use client';

/**
 * shared.ts — Types + platform metadata + formatting helpers for the rebuilt
 * Public App Settings screen (components/admin/public-app/*).
 *
 * Every interface here was verified against the LIVE admin API responses
 * (field names/casing) — see the endpoint contract in worklog Task 4-a.
 */

import {
  Smartphone,
  Monitor,
  Apple,
  Laptop,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import type { InstallerPlatform } from '@/lib/admin-upload';

// ─── API types (live-verified) ─────────────────────────────────────────────

export type Platform = InstallerPlatform;

export interface AppVersion {
  id: string;
  platform: string;
  version: string;
  versionCode: number;
  releaseNotes: string;
  releaseNotesAr?: string | null;
  releaseNotesFr?: string | null;
  isMandatory: boolean;
  isPublished: boolean;
  isPatch: boolean;
  downloadUrl: string;
  fileStorageKey?: string | null;
  fileStorageProvider?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  fileHash?: string | null;
  minAppVersion?: string | null;
  publishedAt?: string | null;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

/** What kind of artifact a bucket file is (server-parsed from the name). */
export type InstallerFileKind = 'installer' | 'ref' | 'delta' | 'unknown';

/** One entry PER FILE on disk — same-name rebuilds stay distinct rows. */
export interface InstallerDiskFile {
  /** Bucket-relative path "<group>/<name>" — the EXACT disk reference. */
  storageKey: string;
  name: string;
  /** 'desktop' | 'mobile' | '' (legacy root). */
  group: string;
  size: number;
  mtimeMs: number;
  platform?: string | null;
  parsed?: { platform: string; version: string } | null;
  /** Artifact kind — delta patches + release refs are NOT installable. */
  kind?: InstallerFileKind | null;
  /** Delta patches only: the version the patch updates TO. */
  versionTo?: string | null;
  /** AppVersion row pointing at this exact file (if any). */
  version?: {
    id: string;
    platform: string;
    version: string;
    isPublished: boolean;
    fileName: string | null;
    fileSize: number | null;
  } | null;
}

/**
 * One entry per (platform, version) the server can touch — aggregated from
 * the ACTUAL bucket files (GET /api/app-versions/storage-versions) and merged
 * with the DB rows. Versions whose rows were deleted but whose installers /
 * delta patches remain on disk appear here with hasDbRow=false ("orphan").
 */
export interface StorageVersion {
  platform: string;
  version: string;
  installers: { count: number; bytes: number };
  deltas: { count: number; bytes: number };
  refs: { count: number; bytes: number };
  dbDeltaRows: number;
  totalFiles: number;
  totalBytes: number;
  latestMtimeMs: number;
  hasDbRow: boolean;
  isPublished: boolean;
  dbId: string | null;
  dbFileName: string | null;
}

export interface InstallTotals {
  devices: number;
  active7d: number;
  active30d: number;
  installsTotal: number;
  updatesTotal: number;
}

export interface PlatformStat {
  platform: string;
  devices: number;
  active7d: number;
}

export interface VersionStat {
  platform: string;
  version: string;
  devices: number;
  active7d: number;
}

export interface TimelinePoint {
  date: string;
  installs: number;
  updates: number;
}

export type InstallEventType = 'INSTALL' | 'UPDATE' | 'REINSTALL' | 'HEARTBEAT';

export interface InstallEvent {
  id: string;
  deviceId?: string;
  eventType: InstallEventType | string;
  platform: string;
  version: string;
  label: string;
  createdAt: string;
}

export interface InstallStats {
  totals: InstallTotals;
  byPlatform: PlatformStat[];
  byVersion: VersionStat[];
  timeline: TimelinePoint[];
  recentEvents: InstallEvent[];
}

export interface DeviceRow {
  id: string;
  platform: string;
  fingerprint: string;
  deviceId: string;
  label: string | null;
  osName: string | null;
  osVersion: string | null;
  appVersion: string | null;
  installCount: number;
  firstSeenAt: string;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PushRow {
  id: string;
  platform: string;
  isMandatory: boolean;
  message: string;
  messageAr?: string | null;
  messageFr?: string | null;
  status: 'ACTIVE' | 'CANCELLED' | string;
  createdBy?: string | null;
  createdAt: string;
  appVersion: {
    id: string;
    version: string;
    versionCode: number;
    isPublished: boolean;
    fileName: string | null;
  } | null;
  deliveredCount: number;
  updatedCount: number;
}

// ─── Platform metadata ─────────────────────────────────────────────────────

export const PLATFORM_META: {
  key: Platform;
  labelAr: string;
  labelEn: string;
  icon: LucideIcon;
}[] = [
  { key: 'android', labelAr: 'أندرويد', labelEn: 'Android', icon: Smartphone },
  // Debug-APK channel: debug-keystore build, installable on any device without
  // signing secrets. Kept OUT of public update checks — tester distribution only.
  { key: 'android-debug', labelAr: 'أندرويد (تجريبي)', labelEn: 'Android Debug', icon: Smartphone },
  { key: 'ios', labelAr: 'آيفون', labelEn: 'iOS', icon: Apple },
  { key: 'electron', labelAr: 'إلكترون', labelEn: 'Electron', icon: Monitor },
  { key: 'windows', labelAr: 'ويندوز', labelEn: 'Windows', icon: Monitor },
  { key: 'mac', labelAr: 'ماك', labelEn: 'macOS', icon: Laptop },
  { key: 'linux', labelAr: 'لينكس', labelEn: 'Linux', icon: Globe },
];

export function platformLabel(platform: string | null | undefined, lang: string): string {
  if (!platform) return lang === 'ar' ? 'منصة غير معروفة' : lang === 'fr' ? 'Plateforme inconnue' : 'Unknown platform';
  const meta = PLATFORM_META.find((p) => p.key === platform);
  if (!meta) return platform;
  return lang === 'ar' ? meta.labelAr : meta.labelEn;
}

export function platformIcon(platform: string | null | undefined): LucideIcon {
  return PLATFORM_META.find((p) => p.key === platform)?.icon ?? Monitor;
}

// ─── Formatting helpers ────────────────────────────────────────────────────

export function localeOf(lang: string): string {
  return lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(dateStr: string | number | null | undefined, lang: string): string {
  if (dateStr == null) return '—';
  try {
    return new Date(dateStr).toLocaleDateString(localeOf(lang), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(dateStr);
  }
}

/** Push time of a disk build = file mtime — DATE + TIME so same-name rebuilds stay distinct. */
export function formatPushedAt(mtimeMs: number, lang: string): string {
  try {
    return new Date(mtimeMs).toLocaleString(localeOf(lang), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(mtimeMs).toISOString();
  }
}

export function formatDateTime(dateStr: string | null | undefined, lang: string): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleString(localeOf(lang), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

type RelativeT = (
  key:
    | 'publicAppJustNow'
    | 'publicAppMinutesAgo'
    | 'publicAppHoursAgo'
    | 'publicAppDaysAgo',
  params?: Record<string, string>,
) => string;

/** "2h ago"-style relative time (locale-neutral — uses translated units). */
export function relativeTime(dateStr: string | null | undefined, t: RelativeT): string {
  if (!dateStr) return '—';
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('publicAppJustNow');
  if (minutes < 60) return t('publicAppMinutesAgo', { count: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('publicAppHoursAgo', { count: String(hours) });
  const days = Math.floor(hours / 24);
  return t('publicAppDaysAgo', { count: String(days) });
}

// ─── Active-installer identity (EXACT) ─────────────────────────────────────

/**
 * The ACTIVE installer for a platform is the row whose linked AppVersion is
 * published AND whose linked fileSize matches the disk file's EXACT byte size
 * (name + push time + byte identity — same-name/same-size rebuilds with a
 * different mtime can never display as active).
 */
export function isActiveInstaller(file: InstallerDiskFile): boolean {
  const v = file.version;
  if (!v || !v.isPublished) return false;
  if (v.fileSize != null && file.size != null && v.fileSize !== file.size) return false;
  return true;
}

// ─── 0.6.50 — Installers-tab view helpers (delta filter + sorting) ─────────

/**
 * Delta-update SUPPORT artifacts: delta patches (`kind: 'delta'`) plus the
 * differential-download companions classified as release references
 * (`kind: 'ref'` — *.blockmap, asar/outref snapshots). These power the
 * updater's delta chain; they are never installable and the admin usually
 * wants them out of the installers view.
 */
export function isDeltaRelated(file: InstallerDiskFile): boolean {
  return file.kind === 'delta' || file.kind === 'ref';
}

/** The artifact's own version (server-parsed or the linked AppVersion row). */
export function fileVersionOf(file: InstallerDiskFile): string {
  return file.parsed?.version || file.version?.version || '';
}

// ─── 0.6.59 — Artifact-category filter (android/desktop × installer/delta/ref) ──

/**
 * The six update-artifact categories the admin filters by (user request):
 * each combines the DEVICE GROUP (android vs desktop) with the artifact KIND
 * (installable installer vs delta patch vs delta-reference file). iOS joins
 * the mobile group; every other platform is desktop.
 */
export type ArtifactCategory =
  | 'android-installer'
  | 'android-delta'
  | 'android-ref'
  | 'desktop-installer'
  | 'desktop-delta'
  | 'desktop-ref';

export const ARTIFACT_CATEGORIES: ArtifactCategory[] = [
  'android-installer',
  'android-delta',
  'android-ref',
  'desktop-installer',
  'desktop-delta',
  'desktop-ref',
];

const MOBILE_GROUP_PLATFORMS = new Set(['android', 'android-debug', 'ios']);

/** Device group of a bucket file — 'mobile' | 'desktop' | null (unknown platform). */
export function artifactGroupOf(file: InstallerDiskFile): 'desktop' | 'mobile' | null {
  const platform = file.platform || file.parsed?.platform || '';
  if (!platform) return null;
  return MOBILE_GROUP_PLATFORMS.has(platform) ? 'mobile' : 'desktop';
}

/** Does the file belong to the requested update-artifact category? */
export function matchesArtifactCategory(file: InstallerDiskFile, category: ArtifactCategory): boolean {
  const group = artifactGroupOf(file);
  const kind = file.kind ?? 'unknown';
  switch (category) {
    case 'android-installer':
      return group === 'mobile' && kind === 'installer';
    case 'android-delta':
      return group === 'mobile' && kind === 'delta';
    case 'android-ref':
      return group === 'mobile' && kind === 'ref';
    case 'desktop-installer':
      return group === 'desktop' && kind === 'installer';
    case 'desktop-delta':
      return group === 'desktop' && kind === 'delta';
    case 'desktop-ref':
      return group === 'desktop' && kind === 'ref';
  }
}

/** Numeric semver compare of "X.Y.Z" strings (missing parts count as 0). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export type InstallerSortKey = 'time' | 'name' | 'size' | 'version';
export type InstallerSortDir = 'asc' | 'desc';

/**
 * Row comparator for the Installers tab (0.6.50 sort control). Ties and
 * version-less files fall back to push time so the order stays stable and
 * meaningful; version-less rows always sort AFTER versioned ones regardless
 * of direction.
 */
export function compareDiskFiles(
  key: InstallerSortKey,
  dir: InstallerSortDir,
): (a: InstallerDiskFile, b: InstallerDiskFile) => number {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    switch (key) {
      case 'name':
        return sign * a.name.localeCompare(b.name, undefined, { numeric: true });
      case 'size':
        return sign * ((a.size || 0) - (b.size || 0));
      case 'version': {
        const va = fileVersionOf(a);
        const vb = fileVersionOf(b);
        if (!va && !vb) return sign * (a.mtimeMs - b.mtimeMs);
        if (!va) return 1; // version-less rows last in BOTH directions
        if (!vb) return -1;
        const d = compareSemver(va, vb);
        return d !== 0 ? sign * d : sign * (a.mtimeMs - b.mtimeMs);
      }
      case 'time':
      default:
        return sign * (a.mtimeMs - b.mtimeMs);
    }
  };
}
