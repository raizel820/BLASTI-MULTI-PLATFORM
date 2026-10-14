'use client';

/**
 * admin-upload — Installer binary upload for the rebuilt Public App Settings
 * screen (components/admin/public-app/*).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A RAW XHR HELPER
 *
 * The screen needs REAL upload progress. apiFetch/apiClient buffer the whole
 * response and expose no upload progress events, so the multipart binary POST
 * goes through XMLHttpRequest (upload.onprogress) — the same escape hatch the
 * admin-download.ts helper uses for binary downloads.
 *
 * It mirrors (never imports-private) api-client.ts's per-shell auth contract:
 *
 *   Electron  → Bearer 'blasti-local-api-token' (fallback: blasti-app
 *               persisted state.sessionToken) — cookies don't work across
 *               the renderer(:3000)→cloud(:3003) port split.
 *   Capacitor → Bearer 'blasti-session-token' (native session key).
 *   Web       → Bearer from the persisted store (primary) +
 *               withCredentials so the session cookie rides along as
 *               fallback (the cloud API echoes Origin, credentials enabled).
 *
 * URL: buildCloudUrl() (shared with admin-download.ts) — appends
 * XTransformPort=3003 behind the sandbox gateway, absolute cloud URL on
 * loopback/native shells.
 *
 * FLOW (mirrors the admin API contract):
 *   1. ensureAppVersionRecord() — POST /api/app-versions creates the version
 *      row first (isPublished:false). HTTP 409 "already exists" is SUCCESS for
 *      the flow: the row is there, we just attach the binary to it.
 *   2. uploadInstallerBinary()  — POST /api/app-versions/upload with the file;
 *      `create=1` rides along as belt-and-braces so the server can auto-create
 *      a missing record exactly like CI uploads do.
 */

import { buildCloudUrl } from './api-client';
import { apiFetch } from './api-fetch';

export type InstallerPlatform =
  | 'android'
  | 'android-debug'
  | 'ios'
  | 'electron'
  | 'windows'
  | 'mac'
  | 'linux';

export const INSTALLER_PLATFORMS: InstallerPlatform[] = [
  'android',
  'android-debug',
  'ios',
  'electron',
  'windows',
  'mac',
  'linux',
];

/** Valid installer extensions per platform (used by the picker hint + detection). */
const EXT_PLATFORM_MAP: Record<string, InstallerPlatform> = {
  apk: 'android',
  ipa: 'ios',
  exe: 'windows',
  msi: 'windows',
  dmg: 'mac',
  pkg: 'mac',
  appimage: 'linux',
  deb: 'linux',
  rpm: 'linux',
  snap: 'linux',
};

export interface DetectedInstallerMeta {
  platform: InstallerPlatform | null;
  version: string | null;
}

/**
 * Client-side platform+version detection from the ORIGINAL installer filename.
 * Pre-fills the (editable) upload dialog inputs.
 *
 * Precedence:
 *   1. explicit platform prefix — "windows-0.3.4-…", "electron-…", "android-…"
 *   2. "debug" in the name + .apk → android-debug channel
 *   3. "electron" anywhere in the name (electron builds ship as .exe too)
 *   4. extension mapping (.apk/.ipa/.exe/.msi/.dmg/.pkg/.appimage/.deb/.rpm)
 * Version = first strict semver-looking token in the name (0.3.4 style).
 */
export function detectInstallerMeta(fileName: string): DetectedInstallerMeta {
  const lower = fileName.toLowerCase();
  const ext = lower.includes('.') ? lower.split('.').pop() || '' : '';

  let platform: InstallerPlatform | null = null;

  const prefixMatch = /^(windows|electron|android|ios|mac|macos|linux|win|darwin)[-_]/.exec(lower);
  if (prefixMatch) {
    const p = prefixMatch[1];
    platform =
      p === 'windows' || p === 'win'
        ? 'windows'
        : p === 'electron'
          ? 'electron'
          : p === 'android'
            ? 'android'
            : p === 'ios'
              ? 'ios'
              : p === 'linux'
                ? 'linux'
                : 'mac';
  }

  if (!platform && ext === 'apk' && lower.includes('debug')) platform = 'android-debug';
  if (!platform && lower.includes('electron')) platform = 'electron';
  if (!platform && ext && EXT_PLATFORM_MAP[ext]) platform = EXT_PLATFORM_MAP[ext];

  // First semver token anywhere in the filename ("BLASTI-Setup-0.3.4.exe" → 0.3.4).
  const versionMatch = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(fileName);
  const version = versionMatch ? versionMatch[1] : null;

  return { platform, version };
}

/** True when the string is a semver the API accepts (^\d+\.\d+\.\d+ prefix). */
export function isValidSemver(value: string): boolean {
  return /^\d+\.\d+\.\d+/.test(value.trim());
}

// ─── Per-shell auth mirror (same contract as admin-download.ts) ────────────

function directAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};

  const readLocal = (key: string): string | null => {
    try {
      return window.localStorage?.getItem(key);
    } catch {
      return null;
    }
  };
  const tokenFromStore = (): string | null => {
    try {
      const raw = window.localStorage?.getItem('blasti-app');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { state?: { sessionToken?: unknown }; sessionToken?: unknown };
      const t = parsed?.state?.sessionToken ?? parsed?.sessionToken;
      return typeof t === 'string' && t ? t : null;
    } catch {
      return null;
    }
  };

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isElectron =
    !!(window as unknown as { electronAPI?: unknown }).electronAPI || ua.includes('Electron');
  const isCapacitor =
    !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
      ?.isNativePlatform?.() || ua.includes('Capacitor');

  if (isElectron) {
    const localToken = readLocal('blasti-local-api-token');
    if (localToken) return { Authorization: `Bearer ${localToken}` };
    const cloudToken = tokenFromStore();
    return cloudToken ? { Authorization: `Bearer ${cloudToken}` } : {};
  }

  if (isCapacitor) {
    const token = readLocal('blasti-session-token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  const cloudToken = tokenFromStore();
  return cloudToken ? { Authorization: `Bearer ${cloudToken}` } : {};
}

// ─── Step 1: ensure the AppVersion record exists ───────────────────────────

export interface EnsureVersionPayload {
  platform: InstallerPlatform;
  version: string;
  versionCode: number;
  releaseNotes: string;
  releaseNotesAr?: string;
  releaseNotesFr?: string;
  isMandatory: boolean;
}

export interface ApiStepResult {
  ok: boolean;
  status: number;
  /** Server error message for toasts (validation, auth, …). */
  error?: string;
}

/**
 * POST /api/app-versions with isPublished:false. A 409 "Version already
 * exists for this platform" is treated as SUCCESS — the record is there,
 * the binary just needs attaching. Everything else is an honest failure.
 */
export async function ensureAppVersionRecord(
  payload: EnsureVersionPayload,
): Promise<ApiStepResult> {
  try {
    const res = await apiFetch('/api/app-versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: payload.platform,
        version: payload.version.trim(),
        versionCode: Number.isFinite(payload.versionCode) ? Math.max(0, Math.floor(payload.versionCode)) : 0,
        releaseNotes: payload.releaseNotes ?? '',
        releaseNotesAr: payload.releaseNotesAr || undefined,
        releaseNotesFr: payload.releaseNotesFr || undefined,
        isMandatory: !!payload.isMandatory,
        isPublished: false,
        isPatch: false,
        downloadUrl: '',
      }),
    });
    if (res.ok) return { ok: true, status: res.status };
    if (res.status === 409) return { ok: true, status: 409 };

    let error = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) error = body.error;
    } catch {
      /* non-JSON error body — keep the HTTP status text */
    }
    return { ok: false, status: res.status, error };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
}

// ─── Step 2: upload the binary with REAL progress ──────────────────────────

export interface UploadInstallerOptions {
  file: File;
  platform: InstallerPlatform;
  version: string;
  versionCode?: number;
  releaseNotes?: string;
  isMandatory?: boolean;
  /** Upload progress percent 0-100 (XHR upload.onprogress). */
  onProgress?: (percent: number) => void;
}

/**
 * POST /api/app-versions/upload — multipart FormData:
 * file, platform, version, versionCode, releaseNotes, isMandatory, create=1.
 * Resolves an honest result; never throws for HTTP/network failures.
 */
export function uploadInstallerBinary(
  opts: UploadInstallerOptions,
): Promise<ApiStepResult> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof XMLHttpRequest === 'undefined') {
      resolve({ ok: false, status: 0, error: 'Client-only' });
      return;
    }

    try {
      const form = new FormData();
      form.append('file', opts.file);
      form.append('platform', opts.platform);
      form.append('version', opts.version.trim());
      if (opts.versionCode != null && Number.isFinite(opts.versionCode)) {
        form.append('versionCode', String(Math.max(0, Math.floor(opts.versionCode))));
      }
      if (opts.releaseNotes) form.append('releaseNotes', opts.releaseNotes);
      form.append('isMandatory', opts.isMandatory ? 'true' : 'false');
      // CI convenience field — the server auto-creates a missing version row
      // when this is set, so a dropped record can never wedge the upload.
      form.append('create', '1');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', buildCloudUrl('/api/app-versions/upload'));
      const auth = directAuthHeaders();
      for (const [k, v] of Object.entries(auth)) xhr.setRequestHeader(k, v);
      xhr.withCredentials = true;
      xhr.timeout = 30 * 60 * 1000; // installers are large — 30 min cap

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && opts.onProgress) {
          opts.onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ ok: true, status: xhr.status });
          return;
        }
        let error = `HTTP ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof body?.error === 'string' && body.error) error = body.error;
        } catch {
          /* non-JSON error body — keep the HTTP status text */
        }
        resolve({ ok: false, status: xhr.status, error });
      };
      xhr.onerror = () => resolve({ ok: false, status: 0, error: 'Network error' });
      xhr.ontimeout = () => resolve({ ok: false, status: 0, error: 'Upload timed out' });

      xhr.send(form);
    } catch (err) {
      resolve({
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : 'Network error',
      });
    }
  });
}
