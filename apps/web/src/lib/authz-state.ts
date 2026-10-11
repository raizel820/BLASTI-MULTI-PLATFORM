/**
 * authz-state — Shared "session revoked" flag (Task 33-E).
 *
 * Single source of truth for renderer-side revocation awareness:
 *
 *   - When the CLOUD explicitly rejects an account (401/403 after a failed
 *     refresh attempt), the DESKTOP locks the local API (requireAuth → 423
 *     AUTHORIZATION_REVOKED), revokes device credentials, stops sync, and
 *     pushes `electronAPI.onAuthRevoked(cb)` to the renderer. In the BROWSER
 *     the sync engine itself reaches the same conclusion when the cloud
 *     rejects both the Bearer token AND the cookie heal.
 *
 *   - Every renderer path that blindly re-imports a stale session after a 401
 *     (fetch-with-retry handleAuthExpired, api-client LAN restores,
 *     auth-provider boot import-session) must consult this flag FIRST so a
 *     REVOKED session is never re-imported or resurrected.
 *
 * Persistence: localStorage key 'blasti-authz-revoked' (JSON {reason, at}) +
 * an in-memory mirror (fast reads, works even when localStorage throws).
 *
 * Recovery: clearRevoked() MUST be called from the successful-auth paths —
 * use-app-store.setSessionToken (fresh login) and auth-provider boot when a
 * session validates — so a legitimate re-login re-enables sync and restores.
 *
 * SSR-safe: every accessor guards `typeof window === 'undefined'`.
 */

const REVOKED_KEY = 'blasti-authz-revoked';

export interface AuthzRevokedState {
  reason: string;
  at: number;
}

const isBrowser = (): boolean =>
  typeof window !== 'undefined' && typeof localStorage !== 'undefined';

// In-memory mirror — authoritative once written; hydrated from localStorage
// lazily on first read (survives module reloads in dev/Fast Refresh).
let memoryState: AuthzRevokedState | null = null;
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  if (!isBrowser()) return;
  try {
    const raw = localStorage.getItem(REVOKED_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string') {
      memoryState = {
        reason: parsed.reason,
        at: typeof parsed.at === 'number' ? parsed.at : 0,
      };
    }
  } catch {
    // Malformed JSON — treat as not revoked
  }
}

/**
 * Mark the current session as explicitly rejected by the auth authority.
 * Idempotent — keeps the FIRST reason (the original rejection cause).
 */
export function setRevoked(reason: string = 'token-rejected'): void {
  if (memoryState) return; // first rejection wins
  memoryState = { reason, at: Date.now() };
  if (isBrowser()) {
    try {
      localStorage.setItem(REVOKED_KEY, JSON.stringify(memoryState));
    } catch {
      // localStorage unavailable — in-memory mirror still guards this session
    }
  }
}

/** True when the cloud/local API has explicitly revoked this session. */
export function isRevoked(): boolean {
  hydrate();
  return memoryState !== null;
}

/** Read the revocation details (or null when not revoked). */
export function getRevocation(): AuthzRevokedState | null {
  hydrate();
  return memoryState;
}

/**
 * Clear the revoked flag — ONLY from a successful-auth path
 * (fresh login via setSessionToken, or a validated session at boot).
 * Resets the "first reason wins" latch.
 */
export function clearRevoked(): void {
  memoryState = null;
  hydrated = true;
  if (isBrowser()) {
    try {
      localStorage.removeItem(REVOKED_KEY);
    } catch {
      // ignore
    }
  }
}

/**
 * True when an HTTP status/body denotes the desktop local API's
 * revocation lock (Task 33-C: requireAuth → 423 AUTHORIZATION_REVOKED).
 * Tolerates 401/403 responses that carry the same code in the body.
 */
export function isRevocationStatus(status: number, bodyCode?: string | null): boolean {
  return (
    status === 423 ||
    bodyCode === 'AUTHORIZATION_REVOKED' ||
    bodyCode === '423'
  );
}
