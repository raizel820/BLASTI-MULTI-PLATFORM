/**
 * token-refresh — Task 2-b sub-task 1: SINGLE-FLIGHT cloud session refresh.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY: on the desktop, several pollers (dashboard, notifications, connection
 * banner, sync engine) can ALL hit a 401 in the same second — e.g. right
 * after the cloud rotated the session token. Without coordination each of
 * them used to run its own recovery (adopt → IPC re-import → cloud refresh),
 * producing a refresh storm: parallel POSTs to /api/auth/refresh-session,
 * and the local API's import-session racing itself (the historic "token
 * tug-of-war").
 *
 * This module is the ONE place that refreshes the cloud session with the
 * Bearer token (Electron — the cookie heal in session-heal.ts is
 * intentionally web-only). Every 401 handler awaits the SAME in-flight
 * promise instead of starting its own, plus a cooldown keeps a flapping
 * server from being hammered.
 *
 * Contract:
 *   - One refresh in flight at a time; concurrent callers JOIN it.
 *   - Success → the fresh token is written to every renderer surface via
 *     auth-storage.storeSessionToken (respecting the remember-me mode) and
 *     returned to the caller.
 *   - 401/403 from the refresh itself → { ok:false, rejected:true } — the
 *     caller may then run its destructive logout path.
 *   - Network failure → { ok:false, rejected:false } — transient; the
 *     existing offline-tolerant flows continue.
 */

import { storeSessionToken, readSessionToken } from '@/lib/auth-storage';

export interface RefreshResult {
  ok: boolean;
  token?: string;
  /** true → the cloud explicitly rejected the session (401/403). */
  rejected: boolean;
}

let _inFlight: Promise<RefreshResult> | null = null;
let _lastAttemptAt = 0;
/** Minimum gap between COMPLETED refresh attempts (storm brake). */
const REFRESH_COOLDOWN_MS = 4_000;

async function doRefresh(): Promise<RefreshResult> {
  if (typeof window === 'undefined') return { ok: false, rejected: false };
  const token = readSessionToken();
  if (!token) return { ok: false, rejected: false };

  let cloudBase = '';
  try {
    const { buildCloudUrl } = await import('@/lib/api-client');
    cloudBase = buildCloudUrl('/api/auth/refresh-session');
  } catch {
    cloudBase = '/api/auth/refresh-session';
  }

  try {
    const res = await fetch(cloudBase, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      credentials: 'omit',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(8000)
        : undefined,
    });

    if (res.status === 401 || res.status === 403) {
      console.log('[TokenRefresh] Cloud rejected the session (HTTP ' + res.status + ') — refresh refused');
      return { ok: false, rejected: true };
    }
    if (!res.ok) {
      console.log('[TokenRefresh] Refresh unavailable (HTTP ' + res.status + ') — treated as transient');
      return { ok: false, rejected: false };
    }

    const data = await res.json().catch(() => null);
    if (!data?.success || !data?.token || !data?.user?.id) {
      return { ok: false, rejected: false };
    }

    // Adopt the refreshed token on EVERY renderer surface. The in-memory
    // zustand token is refreshed by the CALLER (it knows whether to keep the
    // gentle pattern — a rotation must not reset cursors/revocation state).
    storeSessionToken(data.token);
    try {
      const { useAppStore } = await import('@/store/use-app-store');
      const state = useAppStore.getState();
      if (state.isAuthenticated && state.sessionToken && state.sessionToken !== data.token) {
        useAppStore.setState({ sessionToken: data.token });
      }
    } catch { /* store unavailable — surfaces already updated */ }

    console.log('[TokenRefresh] Cloud session refreshed — fresh token adopted');
    return { ok: true, token: data.token, rejected: false };
  } catch (err) {
    console.log('[TokenRefresh] Refresh failed (network) — transient:', err instanceof Error ? err.message : err);
    return { ok: false, rejected: false };
  }
}

/**
 * Refresh the cloud session (single-flight). Concurrent callers share the
 * same in-flight attempt; attempts inside the cooldown window return the
 * last completed result without touching the network.
 */
export function refreshCloudSessionSingleFlight(force = false): Promise<RefreshResult> {
  if (_inFlight) {
    return _inFlight;
  }
  const now = Date.now();
  if (!force && now - _lastAttemptAt < REFRESH_COOLDOWN_MS) {
    return Promise.resolve({ ok: false, rejected: false });
  }
  _lastAttemptAt = now;
  _inFlight = doRefresh().finally(() => {
    _inFlight = null;
  });
  return _inFlight;
}

/** Test/teardown hook — resets the single-flight + cooldown state. */
export function resetTokenRefreshState(): void {
  _inFlight = null;
  _lastAttemptAt = 0;
}
