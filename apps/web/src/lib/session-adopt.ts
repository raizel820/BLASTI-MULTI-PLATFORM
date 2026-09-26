/**
 * session-adopt — Task 41 renderer token catch-up.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY: the cloud re-issues the session token whenever the DESKTOP MAIN process
 * validates the stored session (POST /api/auth/import-session → cloud
 * /api/auth/refresh-session adopts a refreshed token). The RENDERER keeps
 * presenting the previous token from localStorage until it re-imports.
 * Historically the local API hard-compared ONLY the current token, so every
 * renderer request in that window 401'd — the direct cause of the
 * intermittent "data loading failed" (فشل تحميل البيانات) agency-dashboard
 * popup after login (fresh or resumed session).
 *
 * The local API now (a) accepts the rotation-grace predecessor token and
 * (b) exposes POST /api/auth/adopt-session so a stale renderer can CATCH UP
 * to the current token instead of overwriting the fresh session with its
 * stale one (the old tug-of-war in handleAuthExpired/tryRestoreLocalSession).
 *
 * This helper is intentionally dependency-light (plain fetch + localStorage +
 * a dynamic store import) so it can be used from both fetch-with-retry and
 * api-client without import cycles.
 */

const LOCAL_API_BASE = 'http://127.0.0.1:3080';
const LOCAL_TOKEN_KEY = 'blasti-local-api-token';
const STORE_KEY = 'blasti-app';

export interface AdoptSessionResult {
  adopted: boolean;
  /** true → the local API is reachable but rejected our token (foreign session) */
  rejected: boolean;
  token?: string;
}

function readRendererToken(): string | null {
  try {
    const localToken = localStorage.getItem(LOCAL_TOKEN_KEY);
    if (localToken) return localToken;
    const storeData = localStorage.getItem(STORE_KEY);
    if (storeData) {
      const parsed = JSON.parse(storeData);
      return parsed?.state?.sessionToken || parsed?.sessionToken || null;
    }
  } catch { /* ignore */ }
  return null;
}

/** Update every renderer token surface after a successful adopt. */
function applyAdoptedToken(token: string): void {
  try {
    localStorage.setItem(LOCAL_TOKEN_KEY, token);
  } catch { /* ignore */ }

  // Update the persisted Zustand state in place (setState re-persists).
  // NOTE: we deliberately do NOT call setSessionToken() here — it would push
  // the token through IPC (fine) but also reset sync cursors/revocation state
  // that a mere rotation must not touch.
  try {
    const storeData = localStorage.getItem(STORE_KEY);
    if (storeData) {
      const parsed = JSON.parse(storeData);
      if (parsed?.state) {
        parsed.state.sessionToken = token;
        localStorage.setItem(STORE_KEY, JSON.stringify(parsed));
      }
    }
  } catch { /* ignore */ }

  // Update the in-memory store WITHOUT side effects (direct setState, not
  // setSessionToken — see the note above).
  import('@/store/use-app-store')
    .then(({ useAppStore }) => {
      const current = useAppStore.getState();
      if (current.isAuthenticated && current.sessionToken && current.sessionToken !== token) {
        useAppStore.setState({ sessionToken: token });
      }
    })
    .catch(() => { /* store unavailable — localStorage already updated */ });
}

/**
 * Ask the local API to hand us the CURRENT session token for the session
 * chain our token belongs to. Safe to call speculatively — every failure
 * path simply returns { adopted: false }.
 */
export async function adoptLocalSession(): Promise<AdoptSessionResult> {
  if (typeof window === 'undefined') return { adopted: false, rejected: false };
  const isElectron = !!(window as any).electronAPI || navigator.userAgent.includes('Electron');
  if (!isElectron) return { adopted: false, rejected: false };

  const token = readRendererToken();
  if (!token) return { adopted: false, rejected: false };

  try {
    const res = await fetch(`${LOCAL_API_BASE}/api/auth/adopt-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'omit',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
        ? AbortSignal.timeout(3000)
        : undefined,
    });

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.success && data.token) {
        const changed = data.token !== token;
        applyAdoptedToken(data.token);
        if (changed) {
          console.log(`[SessionAdopt] renderer token caught up to the local session's current token (rotated=${!!data.adopted})`);
        }
        return { adopted: true, rejected: false, token: data.token };
      }
      return { adopted: false, rejected: false };
    }

    if (res.status === 401 || res.status === 403 || res.status === 423) {
      // The local API has a DIFFERENT session (or a lock). Let the caller run
      // its existing revocation/restore logic — do not mark adopted.
      console.log(`[SessionAdopt] adopt-session → ${res.status} (not our session / lock)`);
      return { adopted: false, rejected: true };
    }

    return { adopted: false, rejected: false };
  } catch {
    // Local API unreachable — not an adopt failure per se.
    return { adopted: false, rejected: false };
  }
}
