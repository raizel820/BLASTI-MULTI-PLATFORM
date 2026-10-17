'use client';

// ─── Feature C: fire-and-forget counter release ─────────────────────────────
// One shared implementation of POST /counters/release-mine so the logout hook
// (use-app-store.logout) and the pagehide/beforeunload listener
// (auth-provider) fire the SAME keepalive request without double-firing.
//
// keepalive:true lets the request survive navigation / tab close (the exact
// moment this must fire). The module-level timestamp guards the overlap where
// BOTH triggers run for the same session (logout → pagehide): anything
// released <5s ago is skipped.

let lastReleaseMineAt = 0;

/** True when a release-mine went out less than `windowMs` ago. */
export function wasRecentlyReleased(windowMs = 5000): boolean {
  return lastReleaseMineAt > 0 && Date.now() - lastReleaseMineAt < windowMs;
}

/**
 * Fire POST /api/agency/counters/release-mine with keepalive. Fire-and-forget
 * — never awaited, never throws (every failure is swallowed; the server-side
 * control sweeper expires stale claims anyway).
 *
 * @param sessionToken the Bearer token captured from the store BEFORE any
 *        state clearing — after logout() the token is gone.
 */
export function fireReleaseMine(sessionToken: string | null | undefined): void {
  if (wasRecentlyReleased()) return;
  if (!sessionToken) return;
  lastReleaseMineAt = Date.now();
  try {
    // getApiBaseUrl(): '' on web (relative — the Next proxy hits the cloud API,
    // exactly the '/api/agency/...' contract), the embedded local API on
    // desktop — the same origin every counter control call already uses.
    void fetch(`${getApiBaseUrlSafe()}/api/agency/counters/release-mine`, {
      method: 'POST',
      keepalive: true,
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        'Content-Type': 'application/json',
      },
    }).catch(() => { /* fire-and-forget */ });
  } catch {
    // never let a release attempt break logout/unload
  }
}

/** Dependency-free base URL (avoids importing the whole api-client here —
 * unload handlers must stay cheap and cannot risk import cycles). */
function getApiBaseUrlSafe(): string {
  try {
    const electron = (globalThis as { electronAPI?: unknown }).electronAPI;
    if (electron || navigator.userAgent.includes('Electron')) {
      return 'http://127.0.0.1:3080';
    }
  } catch { /* fall through to relative */ }
  return '';
}

/** Read the session token out of the persisted surfaces: the zustand persist
 * JSON ('blasti-app') first, then the token mirrors ('blasti-local-api-token'
 * / 'blasti-session-token' native key). */
export function readPersistedSessionToken(): string | null {
  const keys = ['blasti-app', 'blasti-local-api-token', 'blasti-session-token'] as const;
  try {
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      if (key === 'blasti-app') {
        const parsed = JSON.parse(raw) as { state?: { sessionToken?: string } };
        const token = parsed?.state?.sessionToken;
        if (typeof token === 'string' && token) return token;
      } else if (raw && raw !== '') {
        // token mirrors store the raw token string
        return raw;
      }
    }
  } catch {
    // malformed persist JSON etc. — nothing we can do here
  }
  return null;
}
