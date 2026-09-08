/**
 * Fetch with automatic retry for transient errors.
 *
 * Routes through `apiFetch` which provides the full apiClient retry chain:
 *   Cloud API → retry on 5xx/429
 *
 * Retries are only applied on 5xx/429 responses since apiFetch already
 * handles network-level failures through its own retry.
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
let authExpiredHandled = false;
let authExpiredTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Handle a 401/403 response by clearing the session and redirecting to login.
 */
function handleAuthExpired(): void {
  if (authExpiredHandled) {
    return;
  }
  authExpiredHandled = true;

  if (authExpiredTimer) clearTimeout(authExpiredTimer);
  authExpiredTimer = setTimeout(() => {
    authExpiredHandled = false;
  }, 5000);

  import('@/store/use-app-store').then(({ useAppStore }) => {
    const store = useAppStore.getState();
    if (!store.isAuthenticated) {
      return;
    }
    store.logout();
  });
}

/**
 * Fetch a URL with automatic retry for transient errors.
 * Returns an apiFetch-compatible response object (has .ok, .status, .json(), etc.)
 * On 401/403 responses, triggers centralized auth expiry handling.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<ReturnType<typeof apiFetch>> {
  const { maxRetries = 2, baseDelay = 1000, skipAuthCheck, ...fetchOptions } = options;

  let lastResponse: Awaited<ReturnType<typeof apiFetch>> | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

      // Handle auth errors centrally
      if (!skipAuthCheck && (res.status === 401 || res.status === 403)) {
        const isSessionCheck = url.includes('/api/auth/session');
        if (!isSessionCheck) {
          handleAuthExpired();
        }
        return res;
      }

      // Don't retry other client errors (4xx) except 429
      if (res.status < 500 && res.status !== 429) {
        return res;
      }

      // If this is the last attempt, return as-is
      if (attempt >= maxRetries) {
        return res;
      }

      // Calculate backoff delay
      let delay = baseDelay * Math.pow(2, attempt);

      // For 429, emit rate-limited event and respect Retry-After header
      if (res.status === 429) {
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
      lastResponse = {
        ok: false,
        status: 500,
        statusText: error instanceof Error ? error.message : 'Unknown error',
        json: async () => ({ error: error instanceof Error ? error.message : 'Unknown error' }),
        text: async () => error instanceof Error ? error.message : 'Unknown error',
        blob: async () => new Blob(['Unknown error'], { type: 'text/plain' }),
        headers: new Headers(),
      };

      if (attempt >= maxRetries) {
        return lastResponse;
      }

      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }

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
