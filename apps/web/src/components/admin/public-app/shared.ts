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
  /** AppVersion row pointing at this exact file (if any). */
  version?: {
    id: string;
    platform: string;
    version: string;
    isPublished: boolean;
    fileName: string | null;
    fileSize: number | null;
  } | null;
  /** DELTA-SYSTEM artifact (asar/outref diff reference or hop patch) — never an installer. */
  internal?: boolean;
  internalKind?: 'asar-ref' | 'outref-ref' | 'delta-patch' | 'delta-artifact' | string | null;
  /** For internal files: the owning version (refs) or the hop range (patches). */
  owner?: { platform: string; version: string; isPublished: boolean | null } | null;
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
