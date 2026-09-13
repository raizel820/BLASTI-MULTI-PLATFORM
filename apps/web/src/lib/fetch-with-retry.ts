/**
 * Fetch with automatic retry for transient errors.
 *
 * Routes through `apiFetch` which provides the full apiClient failover chain:
 *   Cloud API → LAN Server (port 3080) → WatermelonDB Cache → Electron IPC
 *
 * This means EVERY call through fetchWithRetry automatically gets:
 *   - Offline failover to the local LAN server (Electron desktop only)
 *   - Auth headers injected automatically
 *   - Request timeouts
 *
 * Retries are only applied on 5xx/429 responses since apiFetch already
 * handles network-level failures through its own retry + LAN failover.
 *
 * On 401/403, automatically triggers session expiry handling.
 */

import { apiFetch } from './api-fetch';

export interface FetchWithRetryOptions {
  /** HTTP method (default: 'GET') */
  method?: string;
  /** Request body (string, FormData, or null) */
  body?: BodyInit | null;
  /** Custom headers */
  headers?: Record<string, string> | Headers;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Maximum number of retries for 5xx/429 (default: 2) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number;
  /** If true, skip auth error handling (default: false) */
  skipAuthCheck?: boolean;
  /** Credentials mode — passed to underlying fetch */
  credentials?: RequestCredentials;
}

// Track whether we've already triggered a session-expired redirect
// to avoid multiple simultaneous redirects/toasts
let authExpiredHandled = false;
let authExpiredTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Handle a 401/403 response by clearing the session and redirecting to login.
 * This is centralized so every component doesn't need its own auth error logic.
 *
 * IMPORTANT (Electron offline safety): In Electron, a 401 from the local API
 * during startup is often a TRANSIENT race condition — the renderer rehydrates
 * from localStorage before the IPC setLocalApiSession has fired, so the local
 * API's module-level sessionUser is null. We must NOT destroy the persisted
 * session in this case. Instead, we do a soft state-only reset and attempt
 * to re-import the session via IPC.
 */
function handleAuthExpired(): void {
  if (authExpiredHandled) {
    console.log(`[Auth] 401/403 received but authExpiredHandled=true, skipping (debounce active)`);
    return;
  }
  authExpiredHandled = true;

  // Reset the flag after 5 seconds so a future auth failure can trigger again
  if (authExpiredTimer) clearTimeout(authExpiredTimer);
  authExpiredTimer = setTimeout(() => {
    authExpiredHandled = false;
  }, 5000);

  // Dynamically import to avoid circular dependencies
  const isElectron = typeof window !== 'undefined' && (
    navigator.userAgent.includes('Electron') || !!(window as any).electronAPI
  );
  console.log(`[Auth] 401/403 → handleAuthExpired (electron=${isElectron})`);

  import('@/store/use-app-store').then(({ useAppStore }) => {
    const store = useAppStore.getState();
    if (!store.isAuthenticated) {
      console.log(`[Auth] 401/403 but store.isAuthenticated=false, ignoring`);
      return;
    }

    if (isElectron) {
      // Electron: the 401 is likely a TRANSIENT race condition — the renderer
      // rehydrated from localStorage before IPC setLocalApiSession fired, so the
      // local API's module-level sessionUser is null.
      // Save the current user BEFORE clearing state (for re-import).
      const currentUser = store.user;
      console.log(`[Auth] Electron 401 → attempting session restore (user=${currentUser?.id || 'null'})`);

      // Try to re-import the session from persisted storage into the local API FIRST.
      // If successful, the next request will succeed without any UI disruption.
      const w = window as any;
      let sessionRestored = false;
      try {
        // Try local API token first (used for port 3080 requests)
        const localToken = localStorage.getItem('blasti-local-api-token');
        // Fallback: extract cloud session token from Zustand persisted state
        const storeData = localStorage.getItem('blasti-app');
        const cloudToken = storeData
          ? (() => { try { return JSON.parse(storeData).state?.sessionToken; } catch { return null; } })()
          : null;
        const token = localToken || cloudToken;

        console.log(`[Auth] tokens: local=${!!localToken}, cloud=${!!cloudToken}`);

        if (token && w.electronAPI?.setLocalApiSession) {
          w.electronAPI.setLocalApiSession({ token, user: currentUser });
          sessionRestored = true;
          console.log(`[Auth] session restored via IPC (source=${localToken ? 'local' : 'cloud'})`);
        } else {
          console.log(`[Auth] session restore FAILED: no token (${!token}) or no IPC (${!w.electronAPI?.setLocalApiSession})`);
        }
      } catch (err) {
        console.warn(`[Auth] session restore error:`, err);
      }

      // Only clear Zustand state if session restore FAILED — this means the
      // 401 is a genuine auth expiry, not a transient race condition.
      if (!sessionRestored) {
        console.log(`[Auth] session restore failed → clearing Zustand state (genuine auth expiry)`);
        store.setState({
          user: null,
          isAuthenticated: false,
          sessionToken: '',
        });
      }
    } else {
      // Web/Capacitor: safe to do full logout (no local API race condition)
      console.log(`[Auth] Web 401/403 → full logout`);
      store.logout();
    }
  });
}

/**
 * Fetch a URL with automatic retry for transient errors.
 * Returns an apiFetch-compatible response object (has .ok, .status, .json(), etc.)
 * On 401/403 responses, triggers centralized auth expiry handling.
 *
 * All requests are routed through apiFetch → apiClient, which provides:
 *   - Cloud API with retry + timeout
 *   - LAN server failover (Electron/Capacitor native platforms)
 *   - WatermelonDB offline cache (native platforms)
 *   - Electron IPC fallback (Electron only)
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<ReturnType<typeof apiFetch>> {
  // In Electron/Capacitor, apiClient already has its own retry + LAN failover chain.
  // Double-retrying would compound delays (5s cloud timeout × 2 retries = 10s+ per request).
  const isNative = typeof window !== 'undefined' && (
    navigator.userAgent.includes('Electron') || !!(window as any).electronAPI || !!(window as any).Capacitor
  );
  const { maxRetries = isNative ? 0 : 2, baseDelay = 1000, skipAuthCheck, ...fetchOptions } = options;

  let lastResponse: Awaited<ReturnType<typeof apiFetch>> | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Build the fetch options for this attempt
    const attemptOpts: Parameters<typeof apiFetch>[1] = {
      method: fetchOptions.method,
      headers: fetchOptions.headers as Record<string, string> | undefined,
      body: fetchOptions.body ?? null,
      signal: fetchOptions.signal,
      credentials: fetchOptions.credentials,
    };

    try {
      const res = await apiFetch(url, attemptOpts);

      if (res.ok) {
        return res;
      }

      // Handle auth errors centrally — 401 Unauthorized or 403 Forbidden
      // means the session has expired. Clear the session and redirect to login.
      if (!skipAuthCheck && (res.status === 401 || res.status === 403)) {
        // Don't trigger auth expiry for the session check endpoint itself
        // (that's handled by AuthProvider)
        const isSessionCheck = url.includes('/api/auth/session');
        if (!isSessionCheck) {
          handleAuthExpired();
        }
        return res; // Return as-is so caller can still handle if needed
      }

      // Don't retry other client errors (4xx) except 429
      if (res.status < 500 && res.status !== 429) {
        return res; // Return as-is so caller can handle
      }

      // If this is the last attempt, return as-is
      if (attempt >= maxRetries) {
        return res;
      }

      // Calculate backoff delay
      let delay = baseDelay * Math.pow(2, attempt);

      // For 429, emit rate-limited event and respect Retry-After header
      if (res.status === 429) {
        // Notify dashboard components to back off polling
        try { window.dispatchEvent(new Event('blasti:rate-limited')); } catch { /* ignore */ }
        const retryAfter = res.headers.get('Retry-After');
        if (retryAfter) {
          const retryAfterMs = parseInt(retryAfter, 10) * 1000;
          if (!isNaN(retryAfterMs)) {
            delay = Math.min(retryAfterMs, 10000);
          }
        }
      }

      lastResponse = res;
      await new Promise(r => setTimeout(r, delay));
      continue;
    } catch (error) {
      // apiFetch should never throw (it returns error responses), but handle it
      lastResponse = {
        ok: false,
        status: 500,
        statusText: error instanceof Error ? error.message : 'Unknown error',
        json: async () => ({ error: error instanceof Error ? error.message : 'Unknown error' }),
        text: async () => error instanceof Error ? error.message : 'Unknown error',
        blob: async () => new Blob(['Unknown error'], { type: 'text/plain' }),
        headers: new Headers(),
      };

      // If this is the last attempt, return the error response
      if (attempt >= maxRetries) {
        return lastResponse;
      }

      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }

  // Should not reach here, but return last known response
  return lastResponse ?? {
    ok: false,
    status: 500,
    statusText: 'Request failed after all retries',
    json: async () => ({ error: 'Request failed after all retries' }),
    text: async () => 'Request failed after all retries',
    blob: async () => new Blob(['Request failed after all retries'], { type: 'text/plain' }),
    headers: new Headers(),
  };
}
