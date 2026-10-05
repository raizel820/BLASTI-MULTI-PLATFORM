'use client';

/**
 * Task 81 — Session Keeper (remember-me sliding window).
 *
 * Policy implemented (user requirement):
 *   "when remember me is checked, the account stays open with a token
 *    refreshed while the customer uses the app, for a maximum of 3 days,
 *    before being asked to re-login with username/password — or biometric
 *    login when enabled."
 *
 * Mechanics:
 *  • Login with "Remember me" checked → the API issues a 3-day token and
 *    the store records `sessionStartedAt` (beginRememberSession()).
 *  • While the app is open/used, this keeper refreshes the token through
 *    POST /api/auth/refresh every REFRESH_INTERVAL_MS so an active customer
 *    is never killed mid-use by token expiry.
 *  • HARD WALL: 3 days after login the session is force-closed — regardless
 *    of freshness — and the customer lands back on the login screen, where
 *    biometric quick-unlock is offered automatically when enrolled.
 *
 * React-free by design: toasts + logout run in page.tsx which listens for
 * the `blasti:session-expired` window event (keeps i18n strings in React
 * land). A 401 from the refresh endpoint dispatches the same event (the
 * server already invalidated the session).
 */

import { useAppStore } from '@/store/use-app-store';
import { apiClient, setNativeSessionToken, ApiClientError } from '@/lib/api-client';

/** Hard wall — maximum total remember-me session lifetime. */
export const REMEMBER_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
/** While actively used, the token is refreshed this often. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** How often the keeper evaluates the policy while the app is open. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
/** Window event fired when the session must end (wall reached or 401). */
export const SESSION_EXPIRED_EVENT = 'blasti:session-expired';

let _intervalId: ReturnType<typeof setInterval> | null = null;
let _refreshInFlight = false;
let _visibilityHooked = false;

function dispatchSessionExpired(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

/**
 * Push a freshly-issued token into every runtime sink WITHOUT the heavy
 * setSessionToken() ceremony (that one drops the sync pull cursor and
 * refetches agency authority — wrong for a routine 6h refresh).
 */
function applyRefreshedToken(token: string): void {
  useAppStore.setState({ sessionToken: token });
  useAppStore.getState().markSessionRefreshed();

  // Capacitor: every apiClient request sends this as Bearer.
  try { setNativeSessionToken(token); } catch { /* non-native runtime */ }

  // Electron: keep the cloud-sync + local-API bridges on the new token.
  try {
    const w = window as unknown as {
      electronAPI?: {
        setCloudSyncAuth?: (p: { token: string; user: unknown }) => void;
        setLocalApiSession?: (p: { token: string; user: unknown }) => void;
      };
    };
    const user = useAppStore.getState().user;
    if (w.electronAPI?.setCloudSyncAuth && user) {
      w.electronAPI.setCloudSyncAuth({ token, user });
    }
    if (w.electronAPI?.setLocalApiSession && user) {
      w.electronAPI.setLocalApiSession({ token, user });
      try { localStorage.setItem('blasti-local-api-token', token); } catch { /* ignore */ }
    }
  } catch { /* non-electron runtime */ }
}

/** Evaluate the remember-me policy once. Safe to call at any frequency. */
async function tick(): Promise<void> {
  const state = useAppStore.getState();
  if (!state.isAuthenticated || !state.rememberSession || !state.sessionStartedAt) return;

  const now = Date.now();

  // ── Hard wall: 3 days after login the session dies, no exceptions. ──
  if (now - state.sessionStartedAt >= REMEMBER_MAX_AGE_MS) {
    state.clearRememberSession();
    dispatchSessionExpired();
    return;
  }

  // ── Sliding refresh: keep the token fresh while the app is used. ──
  if (now - (state.lastSessionRefreshAt || 0) < REFRESH_INTERVAL_MS) return;
  if (_refreshInFlight) return;

  _refreshInFlight = true;
  try {
    const res = await apiClient.post<{ token: string }>('/api/auth/refresh', {
      rememberMe: true,
    });
    if (res.data?.token) {
      applyRefreshedToken(res.data.token);
    }
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401) {
      // The server rejected the session — wall/invalidity reached.
      useAppStore.getState().clearRememberSession();
      dispatchSessionExpired();
    }
    // Network/offline failures are ignored — retried on the next tick.
  } finally {
    _refreshInFlight = false;
  }
}

/**
 * Start the keeper exactly once per page lifetime. Evaluates immediately
 * (covers app open), then on every CHECK_INTERVAL_MS and every time the
 * app becomes visible again (returning from the background on mobile).
 */
export function startSessionKeeper(): void {
  if (typeof window === 'undefined') return;

  void tick();

  if (_intervalId === null) {
    _intervalId = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  }

  if (!_visibilityHooked) {
    _visibilityHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void tick();
    });
  }
}
