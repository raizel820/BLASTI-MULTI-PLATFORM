'use client';

/**
 * admin-download — Task 2-c-2: BINARY-SAFE download for the SUPER_ADMIN
 * storage manager (apps/web/src/components/admin/admin-storage-manager.tsx).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The first implementation routed GET /api/admin/storage/download through
 * apiFetch(). That CANNOT carry binary payloads: api-client.parseResponse()
 * decodes every non-JSON body with response.text() (UTF-8 — lossy for
 * images/PDFs/installers) and apiFetch.blob() then rebuilds the "blob" from
 * JSON.stringify(text) with type 'text/plain'. The saved file was garbage for
 * ANY binary content (and re-encoded even for text).
 *
 * This module fetches the streaming endpoint DIRECTLY with native fetch —
 * the raw bytes land in a real Blob untouched — and triggers the browser
 * download via an object-URL anchor click. It mirrors (never imports-private)
 * api-client.ts's per-shell auth contract:
 *
 *   Electron  → Bearer  'blasti-local-api-token' (fallback: blasti-app
 *               persisted state.sessionToken) — cookies don't work across
 *               the renderer(:3000)→cloud(:3003) port split.
 *   Capacitor → Bearer  'blasti-session-token' (native session key).
 *   Web       → Bearer from the persisted store when present (primary, per
 *               api-client's web branch) + credentials:'include' so the
 *               session cookie still rides along as fallback. The cloud API
 *               echoes Origin with credentials enabled, so both work.
 *
 * URL: buildCloudUrl() (shared with the manager's preview URLs) — appends
 * XTransformPort=3003 behind the sandbox gateway, absolute cloud URL on
 * loopback/native shells.
 *
 * The endpoint itself (apps/api/src/routes/admin-storage.ts GET /download)
 * streams via fs.createReadStream → Readable.toWeb with Content-Length,
 * Accept-Ranges/206, weak ETag/304 and Content-Disposition: attachment
 * (RFC 6266/5987 filename*) — nothing is buffered whole server-side.
 */

import { buildCloudUrl } from './api-client';

const DOWNLOAD_PATH = '/api/admin/storage/download';

export interface AdminDownloadResult {
  ok: boolean;
  status: number;
  /** Server-provided (RFC 5987) filename when parseable, else the fallback. */
  filename?: string;
  /** Server error message for toasts (401/403/404/400 …). */
  error?: string;
}

/**
 * Mirror of api-client.ts buildAuthHeaders() for DIRECT fetches (that file is
 * outside this task's writable scope — the contract was read, not modified).
 * Returns the Authorization header for native shells and the web Bearer
 * primary; SSR returns {} (no download UI runs server-side).
 */
function directAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};

  const readLocal = (key: string): string | null => {
    try { return window.localStorage?.getItem(key); } catch { return null; }
  };
  const tokenFromStore = (): string | null => {
    try {
      const raw = window.localStorage?.getItem('blasti-app');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { state?: { sessionToken?: unknown }; sessionToken?: unknown };
      const t = parsed?.state?.sessionToken ?? parsed?.sessionToken;
      return typeof t === 'string' && t ? t : null;
    } catch { return null; }
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

  // Web browser: persisted-store Bearer is the PRIMARY credential (works even
  // when cross-site cookie policies block cookies); credentials:'include' on
  // the fetch below keeps the cookie fallback alive.
  const cloudToken = tokenFromStore();
  return cloudToken ? { Authorization: `Bearer ${cloudToken}` } : {};
}

/** RFC 6266/5987 Content-Disposition filename (filename* wins, then quoted). */
function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  try {
    const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (star?.[1]) return decodeURIComponent(star[1].trim());
    const plain = /filename="?([^";]+)"?/.exec(header);
    if (plain?.[1]) return plain[1].trim();
  } catch { /* fall through to the caller's fallback name */ }
  return null;
}

/**
 * Stream one admin-storage file to the user's disk. Resolves with an honest
 * result (ok/status/error) — callers decide the toast. Never throws for HTTP
 * failures; a network-level failure resolves ok:false too.
 */
export async function downloadAdminStorageFile(
  storagePath: string,
  fallbackName: string,
): Promise<AdminDownloadResult> {
  if (typeof window === 'undefined') {
    return { ok: false, status: 0, error: 'Client-only' };
  }
  try {
    const url = buildCloudUrl(DOWNLOAD_PATH, { path: storagePath });
    const res = await fetch(url, {
      method: 'GET',
      headers: directAuthHeaders(),
      credentials: 'include',
    });

    if (!res.ok) {
      let error = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (body && typeof body.error === 'string' && body.error) error = body.error;
      } catch { /* non-JSON error body — keep the HTTP status text */ }
      return { ok: false, status: res.status, error };
    }

    // REAL binary read — no text round-trip anywhere.
    const blob = await res.blob();
    const filename = filenameFromDisposition(res.headers.get('content-disposition')) || fallbackName;

    const objUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      a.rel = 'noopener';
      a.style.position = 'fixed';
      a.style.opacity = '0';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // Revoke on the next tick — Safari cancels in-flight writes otherwise.
      setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
    }
    return { ok: true, status: res.status, filename };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}
