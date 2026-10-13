/**
 * session-boot — Task 2-b-2 (sub-task 2): ONE boot-time session sanity check.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY: a desktop restart must never resurrect a HALF-VALID session. Before
 * this module the AuthProvider restore path re-imported whatever token the
 * persisted store still held without ever looking at its expiry, so a stale
 * offline session (crash, old install, expired remember-me window) could boot
 * straight into the dashboard and only die mid-request with scattered 401s.
 *
 * Contract (called ONCE from AuthProvider after persist rehydration):
 *   1. No authenticated session in the store → sweep any leftover token
 *      mirrors so public requests cannot be poisoned by a stale Bearer
 *      (the cloud reads the Authorization header FIRST) → 'no-session'.
 *   2. Authenticated but NO token anywhere → half-valid state → purge ALL
 *      auth surfaces → 'purged'.
 *   3. Remember-me 3-day wall passed (session-keeper's REMEMBER_MAX_AGE_MS —
 *      the keeper only enforces it while the app stays open; boot must
 *      enforce it too) → purge → 'purged'.
 *   4. Token expired (JWT `exp` in the past) → attempt exactly ONE refresh
 *      through token-refresh.refreshCloudSessionSingleFlight (REUSED, not
 *      duplicated — concurrent callers always share the same in-flight
 *      promise):
 *        - refreshed → the fresh token is already on every surface →
 *          'refreshed' (boot continues with working credentials).
 *        - rejected (401/403) OR refresh unavailable (offline) → the session
 *          cannot be proven valid → purge EVERYTHING → 'purged'. The user
 *          lands on the login screen; the local API's offline password login
 *          keeps the desktop usable without the cloud.
 *   5. Token valid / no `exp` (opaque local unlock token — its lifetime is
 *      the local API's business) → 'valid'.
 *
 * SCOPE GUARD: Electron-only. Browsers ALWAYS return 'skipped' — the web
 * settle in AuthProvider (/api/auth/session + cookie heal + logout) remains
 * the only boot authority there, and this module must never destructively
 * act on a cookie-based session it cannot see.
 */

import { readSessionToken } from '@/lib/auth-storage';

export type SessionBootVerdict =
  | 'skipped'     // non-Electron runtime — web settle owns the boot check
  | 'no-session'  // nothing to validate (optionally swept leftover mirrors)
  | 'valid'       // token present and usable — boot continues as before
  | 'refreshed'   // expired token was refreshed single-flight — boot continues
  | 'purged';     // session could not be proven valid — clean slate, login

/** Same Electron detection every desktop branch in these files uses. */
function isElectronRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return (
      !!(window as unknown as { electronAPI?: unknown }).electronAPI ||
      navigator.userAgent.includes('Electron')
    );
  } catch {
    return false;
  }
}

/**
 * Extract the `exp` claim (epoch SECONDS) from a JWT without verifying it —
 * boot only needs the expiry hint; the cloud/local API still verify the
 * signature. Returns null for anything that is not a well-formed JWT with a
 * numeric exp (e.g. the local API's opaque offline-unlock tokens, whose
 * lifetime is enforced by the local API itself).
 */
function decodeJwtExp(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Logout-grade wipe of every renderer AUTH surface (token mirrors + persisted
 * zustand auth fields). DATA caches and the remember-me UI hint are preserved
 * (purgeAuthState deliberately never touches them). Mirrors the Task 33-E
 * revoked-path state clear — NOT store.logout(), which navigates and must not
 * run while the boot gate is deciding what to render.
 */
async function purgeSessionState(reason: string): Promise<void> {
  console.log('[SessionBoot] Purging session state —', reason);
  try {
    const { purgeAuthState } = await import('@/lib/auth-storage');
    purgeAuthState();
  } catch { /* storage unavailable — nothing more to strip */ }
  try {
    const { useAppStore } = await import('@/store/use-app-store');
    useAppStore.setState({
      user: null,
      isAuthenticated: false,
      sessionToken: '',
      rememberSession: false,
      sessionStartedAt: null,
      lastSessionRefreshAt: 0,
      agencyAuthority: null,
    });
  } catch { /* store unavailable — the persisted copy was already stripped */ }
}

/**
 * The single boot-time session sanity check. See the module header for the
 * decision table. Never throws — every failure degrades to "let the boot
 * continue the way it worked before".
 */
export async function validateSessionOnBoot(): Promise<SessionBootVerdict> {
  // ── Scope guard: desktop intelligence, web untouched ─────────────────────
  // The browser settle (AuthProvider → /api/auth/session + session-heal)
  // already validates/heals/destroys cookie-backed sessions; a Bearer-expiry
  // purge here would fight it (a valid cookie must keep healing the session).
  if (!isElectronRuntime()) return 'skipped';

  let state: {
    isAuthenticated: boolean;
    user: unknown;
    sessionToken: string;
    rememberSession: boolean;
    sessionStartedAt: number | null;
  } | null = null;
  try {
    const { useAppStore } = await import('@/store/use-app-store');
    const s = useAppStore.getState();
    state = {
      isAuthenticated: s.isAuthenticated,
      user: s.user,
      sessionToken: s.sessionToken,
      rememberSession: s.rememberSession,
      sessionStartedAt: s.sessionStartedAt,
    };
  } catch {
    return 'skipped'; // store unavailable — existing boot machinery proceeds
  }

  // ── 1. No session → sweep leftover token mirrors, nothing else to do ─────
  // A stale mirror without a session would still be attached by
  // buildAuthHeaders() to PUBLIC requests (Authorization wins over cookies in
  // the cloud) — exactly the poisoning this task exists to prevent.
  if (!state.isAuthenticated || !state.user) {
    if (readSessionToken()) {
      await purgeSessionState('no live session but token mirrors exist — sweeping stale material');
      return 'no-session';
    }
    return 'no-session';
  }

  // ── 2. Session without any token material → half-valid → purge ──────────
  const token = state.sessionToken || readSessionToken();
  if (!token) {
    await purgeSessionState('authenticated store state without any token — half-valid session');
    return 'purged';
  }

  // ── 3. Remember-me 3-day wall (boot-side enforcement of Task 81) ─────────
  // The session-keeper enforces the wall with timers while the app is open;
  // after a restart only this check guarantees "3 days maximum, then re-login".
  if (state.rememberSession && state.sessionStartedAt) {
    try {
      const { REMEMBER_MAX_AGE_MS } = await import('@/lib/session-keeper');
      if (Date.now() - state.sessionStartedAt >= REMEMBER_MAX_AGE_MS) {
        await purgeSessionState('remember-me 3-day wall reached — re-login required');
        return 'purged';
      }
    } catch { /* keeper unavailable — expiry check below still applies */ }
  }

  // ── 4. Expiry check + exactly ONE single-flight refresh when expired ─────
  const exp = decodeJwtExp(token);
  if (exp === null) return 'valid'; // opaque/local token — local API governs it
  if (Date.now() < exp * 1000) return 'valid'; // still fresh — nothing to do

  try {
    const { refreshCloudSessionSingleFlight } = await import('@/lib/token-refresh');
    // force=true: boot is a legitimate first attempt (the 4s cooldown exists
    // for 401-storm brakes, not for boot). Concurrent callers would still JOIN
    // the same in-flight promise — single-flight is preserved.
    const result = await refreshCloudSessionSingleFlight(true);
    if (result.ok && result.token) {
      // token-refresh already adopted the fresh token on every renderer
      // surface (mirrors + in-memory store) — boot continues with it.
      console.log('[SessionBoot] Expired token refreshed at boot — session continues');
      return 'refreshed';
    }
    await purgeSessionState(
      result.rejected
        ? 'cloud explicitly rejected the expired session (401/403)'
        : 'expired session and refresh unavailable (offline) — no stale offline session may continue',
    );
    return 'purged';
  } catch (err) {
    // Refresh module itself failed — treat like an unavailable refresh.
    console.warn('[SessionBoot] Refresh attempt failed at boot:', err);
    await purgeSessionState('expired session and refresh attempt errored');
    return 'purged';
  }
}
