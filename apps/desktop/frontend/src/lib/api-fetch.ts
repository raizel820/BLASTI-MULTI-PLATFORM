/**
 * apiFetch — Desktop shim for Web agency components.
 *
 * The Web components call `apiFetch(path, options)` which is a `fetch()`-like
 * function. This Desktop shim delegates ALL requests to the local API server
 * at `http://127.0.0.1:3080${path}`, injects the auth token from localStorage,
 * and returns a standard `Response` object so the Web components work unmodified.
 *
 * Key differences from the Web's apiFetch:
 *  - Web routes through an apiClient with retry/timeout; Desktop talks directly
 *    to the local Hono API on port 3080.
 *  - Auth token comes from `blasti-local-api-token` (Desktop pattern), not from
 *    the Zustand store.
 *  - 401 handling dispatches `blasti:offline-expired` for OFFLINE_SESSION_EXPIRED,
 *    matching the Desktop API client's behaviour.
 *  - Network errors (local API unreachable) return a synthetic 503 Response
 *    instead of throwing, so callers that check `res.ok` continue to work.
 */

// ─── Local API base URL ──────────────────────────────────────────────────────
// When served by the local API (production), same-origin requests are used.
// When running on the Vite dev server (port 5173), relative URLs are used
// so the Vite proxy can forward requests to the local API on port 3080.

const isDevServer =
  typeof window !== 'undefined' &&
  (window.location.port === '5173' || window.location.port === '3000');

const LOCAL_API_BASE = isDevServer ? '' : 'http://127.0.0.1:3080';

// ─── Auth token helper ───────────────────────────────────────────────────────

function getAuthToken(): string | null {
  try {
    return localStorage.getItem('blasti-local-api-token');
  } catch {
    return null;
  }
}

// ─── 401 handler ─────────────────────────────────────────────────────────────

/**
 * Inspect a 401 response for OFFLINE_SESSION_EXPIRED and dispatch the
 * appropriate custom event. Returns `true` if the offline-expired path was
 * taken (caller should NOT redirect to /login), `false` for a standard 401.
 */
async function handle401(response: Response): Promise<boolean> {
  try {
    const errorBody = await response.clone().json();
    if (errorBody.code === 'OFFLINE_SESSION_EXPIRED') {
      // Clear token so subsequent requests don't retry with a stale token
      try {
        localStorage.removeItem('blasti-local-api-token');
      } catch {}
      // Dispatch the same custom event the Desktop API client uses
      window.dispatchEvent(
        new CustomEvent('blasti:offline-expired', {
          detail: {
            offlineDays: errorBody.offlineDays,
            message: errorBody.error,
          },
        })
      );
      return true;
    }
  } catch {
    // Body wasn't JSON — fall through to standard 401 handling
  }

  // Standard auth failure — clear token and redirect to login
  try {
    localStorage.removeItem('blasti-local-api-token');
  } catch {}
  window.location.href = '/login';
  return false;
}

// ─── Network-error synthetic Response ────────────────────────────────────────

function networkErrorResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'Local API unreachable', code: 'NETWORK_ERROR' }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// ─── apiFetch ────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for `fetch()` that routes requests to the local Desktop
 * API server and injects the auth token.
 *
 * Accepts the same arguments as the native `fetch()` for easy migration:
 *   - path: URL path string (e.g. `/api/agency`)
 *   - options: standard RequestInit (method, headers, body, signal, etc.)
 *
 * Returns a standard `Response` object — callers can use `res.ok`, `res.json()`,
 * `res.status`, etc. just like they would with `fetch()`.
 */
export async function apiFetch(
  path: string,
  options?: RequestInit
): Promise<Response> {
  // Build the full URL
  const url = `${LOCAL_API_BASE}${path}`;

  // Clone the caller's headers so we don't mutate the original object
  const headers = new Headers(options?.headers);

  // Inject the auth token as Bearer header (only if not already provided)
  if (!headers.has('Authorization')) {
    const token = getAuthToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  // Set Content-Type to application/json if the caller didn't specify one
  // and the body isn't FormData (which sets its own Content-Type with boundary)
  if (
    !headers.has('Content-Type') &&
    options?.body != null &&
    !(typeof FormData !== 'undefined' && options.body instanceof FormData)
  ) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    // ── 401 handling ──
    if (response.status === 401) {
      await handle401(response);
      // Note: we still return the original 401 Response so callers can
      // inspect `res.status` / `res.json()` if they need to.
    }

    return response;
  } catch (error) {
    // Network error — local API is unreachable
    // Return a synthetic 503 Response instead of throwing, so callers
    // that check `res.ok` (rather than try/catch) continue to work.
    if (
      error instanceof TypeError &&
      (error.message.includes('Failed to fetch') ||
        error.message.includes('NetworkError') ||
        error.message.includes('fetch failed') ||
        error.message.includes('Load failed'))
    ) {
      return networkErrorResponse();
    }

    // AbortError should be re-thrown so callers know the request was cancelled
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }

    // Any other unexpected error — return a synthetic 500 Response
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : 'Unknown fetch error',
      }),
      {
        status: 500,
        statusText: 'Internal Fetch Error',
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

export default apiFetch;
