/**
 * auth-storage — Task 2-b: SINGLE SOURCE OF TRUTH for desktop auth/session
 * persistence (remember-me policy) and every renderer token surface.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Before this module the session material was scattered across FOUR surfaces
 * with no shared policy:
 *
 *   1. localStorage 'blasti-app'             — zustand persist (user +
 *                                              sessionToken + isAuthenticated,
 *                                              ALWAYS written by partialize)
 *   2. localStorage 'blasti-local-api-token' — buildAuthHeaders() fallback
 *                                              (api-client.ts — read-only there)
 *   3. localStorage 'blasti-session-token'   — native session key
 *                                              (api-client.ts setNativeSessionToken)
 *   4. Electron userData blasti-auth.json    — main-process copy (cloud sync +
 *                                              loading-screen boot restore)
 *
 * The desktop requirement (Task 2-b sub-task 3): when the user logs in WITHOUT
 * "Remember me", closing and re-opening the app MUST require a fresh login —
 * no silent continuation of the old session. That means the persistence mode
 * has to be a first-class concept every login path consults, and every token
 * surface must be purgeable from one place (boot crash-cleanup AND quit).
 *
 * DATA-PATH MAP (desktop, for the uninstaller + this module):
 *   localStorage  blasti-app                 — DATA CACHE + durable session
 *   localStorage  blasti-local-api-token     — AUTH (token mirror for api-client)
 *   localStorage  blasti-session-token       — AUTH (native session key)
 *   localStorage  blasti-remember-me         — AUTH POLICY marker ('1' = remember)
 *   localStorage  blasti-remember-me-last   — UI HINT (last checkbox choice,
 *                                              '1'/'0'; NOT auth material —
 *                                              survives logout so the login
 *                                              form can pre-show the choice)
 *   sessionStorage blasti-session-token      — AUTH (ephemeral mirror; dies with
 *                                              the renderer process)
 *   userData      blasti-auth.json           — AUTH (durable; main process —
 *                                              written ONLY for remember-me
 *                                              logins, see main.js)
 */

const PERSISTED_STORE_KEY = 'blasti-app';
const LOCAL_API_TOKEN_KEY = 'blasti-local-api-token';
const NATIVE_SESSION_TOKEN_KEY = 'blasti-session-token';
const REMEMBER_MARKER_KEY = 'blasti-remember-me';
/**
 * Task 2-b-2 (sub-task 1) — pure UI hint: the LAST remember-me checkbox
 * choice, kept across logouts so the login form can pre-show it. Deliberately
 * separate from REMEMBER_MARKER_KEY (the AUTH POLICY marker) and deliberately
 * NOT removed by purgeAuthState()/logout — it contains no token material.
 */
const REMEMBER_LAST_CHOICE_KEY = 'blasti-remember-me-last';

/** Which persist fields are AUTH state (stripped for ephemeral sessions). */
const AUTH_STORE_FIELDS = [
  'sessionToken',
  'user',
  'isAuthenticated',
  'rememberSession',
  'sessionStartedAt',
  'lastSessionRefreshAt',
] as const;

export type SessionPersistenceMode = 'remember' | 'ephemeral';

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// ─── Persistence mode (the remember-me decision) ─────────────────────────────

/**
 * Record the persistence mode chosen at login. Called by the login forms
 * BEFORE the session token is stored anywhere.
 *  - 'remember'  → a durable marker is written; tokens may live in localStorage
 *                  and the main process persists blasti-auth.json.
 *  - 'ephemeral' → NO durable marker; tokens must be purged at quit and any
 *                  leftover is purged at the next boot (crash recovery).
 */
export function setSessionPersistenceMode(mode: SessionPersistenceMode): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    if (mode === 'remember') {
      ls.setItem(REMEMBER_MARKER_KEY, '1');
    } else {
      ls.removeItem(REMEMBER_MARKER_KEY);
    }
    // Task 2-b-2 (sub-task 1) — remember the CHOICE itself (not just the
    // policy): every login form funnels its checkbox value through here, so
    // recording it in one place keeps the pre-show hint in sync everywhere.
    ls.setItem(REMEMBER_LAST_CHOICE_KEY, mode === 'remember' ? '1' : '0');
  } catch { /* storage unavailable — boot purge still protects */ }
}

/**
 * Task 2-b-2 (sub-task 1) — the last remember-me checkbox choice, for the
 * login forms' pre-show. Defaults to false (unchecked) when never recorded.
 */
export function getLastRememberChoice(): boolean {
  const ls = safeLocalStorage();
  try {
    return ls?.getItem(REMEMBER_LAST_CHOICE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 'remember' only when the marker is present (default: ephemeral-safe). */
export function getSessionPersistenceMode(): SessionPersistenceMode {
  const ls = safeLocalStorage();
  try {
    return ls && ls.getItem(REMEMBER_MARKER_KEY) === '1' ? 'remember' : 'ephemeral';
  } catch {
    return 'ephemeral';
  }
}

/** True when the current login opted OUT of being remembered. */
export function isSessionEphemeral(): boolean {
  return getSessionPersistenceMode() === 'ephemeral';
}

// ─── Token surfaces ──────────────────────────────────────────────────────────

/**
 * Store the session token on every renderer surface the rest of the app
 * reads. BOTH storages are written so a durable session survives and an
 * ephemeral one is still readable mid-run (api-client's buildAuthHeaders()
 * only reads localStorage — that file is off-limits, so the ephemeral token
 * intentionally lives there DURING the run and is removed at quit/boot).
 *
 * PLATFORM POLICY (Task 2-b-2 audit fix — mobile/web must NOT change):
 *  - Plain web       → local-API mirror only; NO native-key mirror anywhere
 *                      (api-client.setNativeSessionToken is a no-op outside
 *                      native runtimes — pre-2-b web never had one).
 *  - Capacitor       → native key ALWAYS in localStorage: that is where
 *                      api-client.getNativeSessionToken() reads the Capacitor
 *                      Bearer token. The remember-me split below is desktop
 *                      policy and must never divert the mobile token to
 *                      sessionStorage.
 *  - Electron        → remember-me split (durable localStorage vs ephemeral
 *                      sessionStorage + quit/boot purge).
 *
 *  - localStorage blasti-local-api-token  (always — api-client contract)
 *  - Electron remember:  localStorage blasti-session-token  (survives restart)
 *  - Electron ephemeral: sessionStorage blasti-session-token (dies with window)
 */
export function storeSessionToken(token: string, mode?: SessionPersistenceMode): void {
  const ls = safeLocalStorage();
  const ss = safeSessionStorage();
  try {
    if (ls) ls.setItem(LOCAL_API_TOKEN_KEY, token);
  } catch { /* ignore */ }

  let isElectron = false;
  let isNative = false;
  if (typeof window !== 'undefined') {
    try {
      isElectron = !!(window as unknown as { electronAPI?: unknown }).electronAPI ||
        navigator.userAgent.includes('Electron');
      isNative = isElectron ||
        !!(window as unknown as { Capacitor?: unknown }).Capacitor;
    } catch { /* treat as plain web */ }
  }

  if (!isNative) {
    // Plain web — historic behavior: no native-key mirror at all.
    try { ls?.removeItem(NATIVE_SESSION_TOKEN_KEY); } catch { /* ignore */ }
    try { ss?.removeItem(NATIVE_SESSION_TOKEN_KEY); } catch { /* ignore */ }
    return;
  }

  // Outside Electron the remember-me policy does not exist: Capacitor keeps
  // the historic always-localStorage native key (its Bearer source).
  const effective: SessionPersistenceMode = isElectron
    ? (mode ?? getSessionPersistenceMode())
    : 'remember';
  if (effective === 'remember') {
    try { ss?.removeItem(NATIVE_SESSION_TOKEN_KEY); } catch { /* ignore */ }
    try { ls?.setItem(NATIVE_SESSION_TOKEN_KEY, token); } catch { /* ignore */ }
  } else {
    try { ls?.removeItem(NATIVE_SESSION_TOKEN_KEY); } catch { /* ignore */ }
    try { ss?.setItem(NATIVE_SESSION_TOKEN_KEY, token); } catch { /* ignore */ }
  }
}

/**
 * Read the session token from any surface (localStorage first, then the
 * ephemeral sessionStorage mirror). Used at boot and by session utilities.
 */
export function readSessionToken(): string | null {
  const ls = safeLocalStorage();
  const ss = safeSessionStorage();
  try {
    const local = ls?.getItem(LOCAL_API_TOKEN_KEY) || ls?.getItem(NATIVE_SESSION_TOKEN_KEY);
    if (local) return local;
  } catch { /* ignore */ }
  try {
    return ss?.getItem(NATIVE_SESSION_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

/** Remove every token mirror from both storages (never touches blasti-app). */
export function clearTokenMirrors(): void {
  const ls = safeLocalStorage();
  const ss = safeSessionStorage();
  try { ls?.removeItem(LOCAL_API_TOKEN_KEY); } catch { /* ignore */ }
  try { ls?.removeItem(NATIVE_SESSION_TOKEN_KEY); } catch { /* ignore */ }
  try { ss?.removeItem(NATIVE_SESSION_TOKEN_KEY); } catch { /* ignore */ }
}

// ─── Persisted-store auth stripping ─────────────────────────────────────────

/**
 * Rewrite the persisted zustand JSON ('blasti-app') WITHOUT auth fields.
 * The in-memory store keeps its state — this only changes what survives a
 * restart. Used by the ephemeral policy (partialize gate + quit purge).
 */
export function stripAuthFieldsFromPersistedStore(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    const raw = ls.getItem(PERSISTED_STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return;
    let changed = false;
    for (const field of AUTH_STORE_FIELDS) {
      if (field in parsed.state) {
        delete parsed.state[field];
        changed = true;
      }
    }
    if (changed) ls.setItem(PERSISTED_STORE_KEY, JSON.stringify(parsed));
  } catch { /* malformed store — nothing to strip */ }
}

/**
 * FULL logout-grade wipe of the renderer's AUTH surfaces (tokens + persisted
 * auth fields). DATA caches (blasti-app non-auth fields, language, UI prefs)
 * are deliberately preserved.
 */
export function purgeAuthState(): void {
  clearTokenMirrors();
  stripAuthFieldsFromPersistedStore();
  const ls = safeLocalStorage();
  try { ls?.removeItem(REMEMBER_MARKER_KEY); } catch { /* ignore */ }
}

/**
 * BOOT CRASH-CLEANUP (Task 2-b / 2-b-2: no revival of stale offline sessions).
 *
 * Called once at boot by the AuthProvider AFTER persist rehydration:
 *   - remember-me session → keep everything (the user opted in).
 *   - ephemeral session (marker absent — the common case after a crash, a
 *     force-kill, or a plain non-remember login) → remove every leftover
 *     token mirror and strip the persisted auth fields so a restart can
 *     NEVER silently continue the old session. The fresh login re-issues
 *     everything it needs.
 *
 * SCOPE GUARD (Task 2-b-2 audit fix): ELECTRON-ONLY. The remember marker is
 * written by the desktop login forms only, so on web/Capacitor this would
 * otherwise purge the persisted session + native Bearer mirror on EVERY boot
 * — destroying the historic "session survives a restart" behavior the
 * requirement explicitly protects ("Mobile (Capacitor) and plain web behavior
 * must NOT change"). Browsers/phones keep their own settle/heal machinery.
 */
export function enforcePersistencePolicyAtBoot(): void {
  if (typeof window === 'undefined') return;
  try {
    const isElectron = !!(window as unknown as { electronAPI?: unknown }).electronAPI ||
      navigator.userAgent.includes('Electron');
    if (!isElectron) return; // web / Capacitor — policy does not apply
  } catch {
    return; // runtime undetectable — never purge on a guess
  }
  const ls = safeLocalStorage();
  try {
    const remembered = ls?.getItem(REMEMBER_MARKER_KEY) === '1';
    if (remembered) return;
    purgeAuthState();
    console.log('[AuthStorage] Ephemeral session policy enforced at boot — leftover token surfaces purged (fresh login required)');
  } catch { /* storage unavailable — nothing to enforce */ }
}
