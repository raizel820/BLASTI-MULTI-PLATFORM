/**
 * BLASTI API Client
 *
 * A unified HTTP client for the BLASTI web application.
 * Automatically resolves the correct base URL based on the runtime environment
 * and handles auth headers, retries, timeouts, and error normalization.
 *
 * Platform-specific behavior:
 * - **Web**: Uses relative URLs (same-origin) so cookies are sent automatically.
 * - **Capacitor**: Uses `NEXT_PUBLIC_API_URL` (falls back to `https://blasti.vercel.app`)
 *   because the native shell needs an absolute URL to the cloud backend.
 * - **SSR (server-side)**: Uses `INTERNAL_API_URL` (falls back to `http://localhost:3000`).
 *
 * Usage:
 * ```ts
 * import { apiClient } from '@/lib/api-client';
 *
 * // GET request
 * const res = await apiClient.get<User[]>('/api/users');
 * console.log(res.data);
 *
 * // POST request
 * const created = await apiClient.post<User>('/api/users', { name: 'Ahmed' });
 *
 * // With query params
 * const res = await apiClient.get('/api/agencies', { params: { city: 'Algiers' } });
 *
 * // With custom timeout / retries
 * const res = await apiClient.get('/api/slow', { timeout: 60_000, retries: 5 });
 * ```
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Configuration for the ApiClient instance. */
export interface ApiClientConfig {
  /** Base URL prepended to every request path. */
  baseUrl: string;
  /** Default request timeout in milliseconds. */
  timeout: number;
  /** Maximum number of retry attempts for transient failures. */
  retries: number;
  /** Base delay in ms for exponential backoff between retries. */
  retryDelay: number;
}

/** Options that can be passed to individual HTTP method calls. */
export interface RequestOptions {
  /** Additional HTTP headers to include. */
  headers?: Record<string, string>;
  /** Override the default timeout for this request (ms). */
  timeout?: number;
  /** Override the default retry count for this request. */
  retries?: number;
  /** URL search params to append. */
  params?: Record<string, string>;
  /** An AbortSignal to cancel the request. */
  signal?: AbortSignal;
}

/** Normalized API response wrapper. */
export interface ApiResponse<T> {
  /** The parsed response body. */
  data: T;
  /** The HTTP status code. */
  status: number;
  /** The response headers. */
  headers: Headers;
}

// ─── Error Class ──────────────────────────────────────────────────────────────

/**
 * Custom error thrown by the API client.
 *
 * Distinguishes between:
 * - **Network errors** (`status === 0`) — the request never reached the server
 * - **API errors** (`status >= 400`) — the server responded with an error
 */
export class ApiClientError extends Error {
  /** HTTP status code. `0` for network-level failures. */
  public readonly status: number;
  /** The parsed error body from the server, if available. */
  public readonly body: unknown;
  /** Whether this is a network-level error (no server response). */
  public readonly isNetworkError: boolean;

  constructor(message: string, status: number = 0, body?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
    this.isNetworkError = status === 0;
  }
}

// ─── Platform Detection Helpers ───────────────────────────────────────────────

/**
 * Detect if we are running on the server side (Node.js / SSR).
 */
function isServerSide(): boolean {
  return typeof window === 'undefined';
}

/**
 * Detect if we are running inside a Capacitor native shell.
 * SSR-safe: returns false on the server.
 */
function isCapacitorRuntime(): boolean {
  if (isServerSide()) return false;
  return !!(window as unknown as Record<string, unknown>).Capacitor;
}

// ─── Base URL Resolution ──────────────────────────────────────────────────────

const DEFAULT_VERCEL_URL = 'https://blasti.vercel.app';
const DEFAULT_INTERNAL_URL = 'http://localhost:3000';

/**
 * Resolve the API base URL for the current runtime environment.
 *
 * Priority:
 * 1. **SSR**: `INTERNAL_API_URL` env var → `http://localhost:3000`
 * 2. **Capacitor**: `NEXT_PUBLIC_API_URL` env var → `https://blasti.vercel.app`
 * 3. **Web (browser)**: `NEXT_PUBLIC_API_URL` → relative URL
 */
export function getApiBaseUrl(): string {
  // Server-side: use internal URL
  if (isServerSide()) {
    return process.env.INTERNAL_API_URL || DEFAULT_INTERNAL_URL;
  }

  // Native shell (Capacitor): need absolute URL to Vercel backend
  if (isCapacitorRuntime()) {
    return process.env.NEXT_PUBLIC_API_URL || DEFAULT_VERCEL_URL;
  }

  // Web browser: use explicit API URL if set (e.g. for staging environments)
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }

  // Web browser (development/production): use relative URL '' so requests go
  // through the gateway on the same origin. The buildUrl() function injects
  // XTransformPort=3003 to route API requests to the cloud API on port 3003.
  return '';
}

// ─── Auth Token Helpers ───────────────────────────────────────────────────────

/**
 * The key used to store the JWT session token in localStorage
 * for native (non-web) clients.
 */
const NATIVE_SESSION_TOKEN_KEY = 'blasti-session-token';

/**
 * Retrieve the stored session token for native clients.
 * Returns null on web (cookies are used instead) or if no token is stored.
 */
function getNativeSessionToken(): string | null {
  if (isServerSide() || !isCapacitorRuntime()) return null;
  try {
    return localStorage.getItem(NATIVE_SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Store the session token for native clients.
 * This should be called after a successful login when running in Capacitor.
 */
export function setNativeSessionToken(token: string): void {
  if (isServerSide() || !isCapacitorRuntime()) return;
  try {
    localStorage.setItem(NATIVE_SESSION_TOKEN_KEY, token);
  } catch {
    console.warn('[ApiClient] Could not persist session token to localStorage');
  }
}

/**
 * Remove the stored session token (used during logout).
 */
export function clearNativeSessionToken(): void {
  if (isServerSide()) return;
  try {
    localStorage.removeItem(NATIVE_SESSION_TOKEN_KEY);
  } catch {
    // ignore
  }
}

/**
 * Build auth-related headers for the request.
 *
 * - Web: no explicit header needed; cookies are sent automatically with `credentials: 'include'`.
 * - Capacitor: reads the session token from localStorage and adds `Authorization: Bearer <token>`.
 */
function buildAuthHeaders(): Record<string, string> {
  if (isServerSide()) {
    return {};
  }

  // ── Capacitor: Use native session token (cloud JWT) ─────────────────────
  if (isCapacitorRuntime()) {
    const token = getNativeSessionToken();
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
  }

  return {};
}

// ─── URL Builder ──────────────────────────────────────────────────────────────

/**
 * Build the full request URL from a base URL, path, and optional query params.
 */
function buildUrl(baseUrl: string, path: string, params?: Record<string, string>): string {
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  let url = `${baseUrl}${normalizedPath}`;

  // Build query params — merge caller's params with platform-specific routing
  const queryParams: Record<string, string> = { ...(params || {}) };

  // For web browser (not Capacitor/SSR): when using a relative base URL
  // (empty string), inject XTransformPort=3003 so the gateway routes API requests
  // to the cloud API on port 3003.
  if (!baseUrl && !isServerSide() && !isCapacitorRuntime()) {
    queryParams.XTransformPort = '3003';
  }

  if (Object.keys(queryParams).length > 0) {
    const searchParams = new URLSearchParams(queryParams);
    url += `?${searchParams.toString()}`;
  }

  return url;
}

// ─── Sleep Utility ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── API Unreachable Tracking ────────────────────────────────────────────────
//
// When the cloud API fails with a network error or 5xx,
// we mark it as temporarily unreachable for 30 seconds.

let _apiUnreachableUntil = 0;

// ─── HMR-Persistent Unreachable Flags ──────────────────────────────────
// Persist the flag in sessionStorage so it survives HMR cycles.

const UNREACHABLE_SESSION_KEY = 'blasti-api-unreachable-until';

/** Restore unreachable flags from sessionStorage (survives HMR). */
function restoreUnreachableFlags(): void {
  try {
    if (typeof window === 'undefined') return;
    const apiUntil = sessionStorage.getItem(UNREACHABLE_SESSION_KEY);
    if (apiUntil) {
      const val = parseInt(apiUntil, 10);
      if (!isNaN(val) && val > Date.now()) {
        _apiUnreachableUntil = val;
      } else {
        sessionStorage.removeItem(UNREACHABLE_SESSION_KEY);
      }
    }
  } catch {
    // sessionStorage not available
  }
}

/** Persist unreachable flags to sessionStorage (called on every flag update). */
function persistUnreachableFlags(): void {
  try {
    if (typeof window === 'undefined') return;
    if (_apiUnreachableUntil > Date.now()) {
      sessionStorage.setItem(UNREACHABLE_SESSION_KEY, String(_apiUnreachableUntil));
    } else {
      sessionStorage.removeItem(UNREACHABLE_SESSION_KEY);
    }
  } catch { /* ignore */ }
}

// Restore flags immediately on module load (handles HMR re-initialization)
restoreUnreachableFlags();

// Module init banner
{
  const platform = isCapacitorRuntime() ? 'Capacitor' : isServerSide() ? 'SSR' : 'Web';
  const baseUrl = getApiBaseUrl();
  const apiRem = Math.max(0, _apiUnreachableUntil - Date.now());
  const restored = _apiUnreachableUntil > 0;
  const flags = restored
    ? ` apiUnreach=${_apiUnreachableUntil > 0 ? `YES (~${apiRem}ms)` : 'no'}`
    : '';
  console.log(`%c[ApiClient:INIT] platform=${platform} baseUrl=${baseUrl || '(relative)'}${flags}${restored ? ' (restored from sessionStorage)' : ''}`,
    restored ? 'color: #f59e0b' : 'color: #22c55e');
}

/**
 * True when the cloud API is unreachable.
 * Set as soon as cloud fails, cleared when cloud responds successfully.
 */
export function isApiUnreachable(): boolean {
  return Date.now() < _apiUnreachableUntil;
}

/**
 * True when both the cloud API AND the realtime connection are unreachable.
 * For the webapp this is equivalent to isApiUnreachable() since realtime
 * depends on the cloud API. Desktop overrides this to also check the local API.
 */
export function isBothUnreachable(): boolean {
  return isApiUnreachable();
}

/**
 * Clear unreachable flags. Called when cloud responds successfully.
 */
function markApiReachable(): void {
  _apiUnreachableUntil = 0;
  persistUnreachableFlags();
}

function markApiUnreachable(): void {
  _apiUnreachableUntil = Date.now() + 30_000; // 30s cooldown
  persistUnreachableFlags();
}

// ─── ApiClient Class ─────────────────────────────────────────────────────────

/**
 * HTTP API client for the BLASTI application.
 *
 * Features:
 * - Automatic base URL resolution based on runtime platform
 * - Auth header injection (cookies for web, Bearer token for native)
 * - Configurable timeout with AbortController
 * - Exponential backoff retry on network errors and 5xx responses
 * - Query params support
 * - SSR-safe
 */
export class ApiClient {
  private config: ApiClientConfig;

  constructor(config?: Partial<ApiClientConfig>) {
    this.config = {
      baseUrl: config?.baseUrl ?? getApiBaseUrl(),
      timeout: config?.timeout ?? 30_000,
      retries: config?.retries ?? 3,
      retryDelay: config?.retryDelay ?? 1_000,
    };
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /** Get the current base URL. */
  getBaseUrl(): string {
    return this.config.baseUrl;
  }

  /** Update the base URL at runtime (e.g. after detecting a platform change). */
  setBaseUrl(url: string): void {
    this.config.baseUrl = url;
  }

  // ── HTTP Methods ───────────────────────────────────────────────────────────

  /** Perform a GET request. */
  async get<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  /** Perform a POST request. */
  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  /** Perform a PUT request. */
  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, body, options);
  }

  /** Perform a PATCH request. */
  async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, body, options);
  }

  /** Perform a DELETE request. */
  async delete<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  // ── Core Request Logic ─────────────────────────────────────────────────────

  /**
   * Execute an HTTP request with retry, timeout, and error handling.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>> {
    const maxRetries = options?.retries ?? this.config.retries;
    const timeoutMs = options?.timeout ?? this.config.timeout;
    const url = buildUrl(this.config.baseUrl, path, options?.params);

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = {
      ...buildAuthHeaders(),
      // Don't set Content-Type for FormData — browser sets it with correct boundary
      ...(body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    };

    let lastError: ApiClientError | null = null;

    console.log(`[ApiClient] ${method} ${path} → ${url} (retries=${maxRetries}, timeout=${timeoutMs}ms)`);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Create a new AbortController for each attempt
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const attemptStart = performance.now();

      // If the caller provided a signal, also listen to it
      const onCallerAbort = () => controller.abort();
      options?.signal?.addEventListener('abort', onCallerAbort);

      try {
        // Determine credentials mode:
        // - Same-origin requests (relative URL / empty base): use 'include' for cookie auth
        // - Cross-origin requests (absolute URL to different port/host): use 'omit'
        const isCrossOrigin = url.startsWith('http://') || url.startsWith('https://');
        const credentialsMode: RequestCredentials = isServerSide()
          ? 'same-origin'
          : isCrossOrigin
            ? 'omit'
            : 'include';

        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? (isFormData ? body as BodyInit : JSON.stringify(body)) : undefined,
          credentials: credentialsMode,
          signal: controller.signal,
        });

        // Successful response
        if (response.ok) {
          markApiReachable();
          const elapsed = (performance.now() - attemptStart).toFixed(0);
          console.log(`[ApiClient] ${method} ${path} → OK ${response.status} (${elapsed}ms, attempt ${attempt}/${maxRetries})`);
          return await this.parseResponse<T>(response);
        }

        // Client errors (4xx) — do NOT retry, throw immediately
        if (response.status >= 400 && response.status < 500) {
          const errorBody = await this.safeParseBody(response);
          const elapsed = (performance.now() - attemptStart).toFixed(0);
          console.log(`[ApiClient] ${method} ${path} → 4xx (${response.status}, ${elapsed}ms), no retry`);
          throw new ApiClientError(
            this.buildErrorMessage(response.status, errorBody),
            response.status,
            errorBody,
          );
        }

        // Server errors (5xx) or other non-ok responses — retry if attempts remain
        if (attempt < maxRetries) {
          // Respect Retry-After header for 429
          let delay = this.config.retryDelay * Math.pow(2, attempt);
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            if (retryAfter) {
              const retryAfterMs = parseInt(retryAfter, 10) * 1000;
              if (!isNaN(retryAfterMs)) {
                delay = Math.min(retryAfterMs, 10_000);
              }
            }
          }

          const errBody = await this.safeParseBody(response);
          lastError = new ApiClientError(
            this.buildErrorMessage(response.status, errBody),
            response.status,
            errBody,
          );

          await sleep(delay);
          continue;
        }

        // Final attempt failed
        const finalBody = await this.safeParseBody(response);
        lastError = new ApiClientError(
          this.buildErrorMessage(response.status, finalBody),
          response.status,
          finalBody,
        );
        break;
      } catch (error) {
        // If it's already our error, and it's a 4xx, re-throw immediately
        if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
          throw error;
        }

        // Network error or abort
        if (error instanceof DOMException && error.name === 'AbortError') {
          const elapsed = (performance.now() - attemptStart).toFixed(0);
          // Distinguish timeout from caller-initiated abort
          if (options?.signal?.aborted) {
            console.log(`[ApiClient] ${method} ${path} → cancelled by caller (${elapsed}ms)`);
            throw new ApiClientError('Request was cancelled', 0, null);
          }
          console.log(`[ApiClient] ${method} ${path} → timed out after ${timeoutMs}ms (${elapsed}ms actual, attempt ${attempt}/${maxRetries})`);
          if (attempt < maxRetries) {
            lastError = new ApiClientError(`Request timed out after ${timeoutMs}ms`, 0, null);
            const delay = this.config.retryDelay * Math.pow(2, attempt);
            await sleep(delay);
            continue;
          }
          lastError = new ApiClientError(`Request timed out after ${timeoutMs}ms`, 0, null);
          break;
        }
        const errMsg = error instanceof Error ? error.message : 'Unknown';
        const elapsed = (performance.now() - attemptStart).toFixed(0);
        console.log(`[ApiClient] ${method} ${path} → network error: ${errMsg} (${elapsed}ms, attempt ${attempt}/${maxRetries})`);

        // Network error — retry if attempts remain
        if (attempt < maxRetries) {
          lastError = new ApiClientError(
            error instanceof Error ? error.message : 'Network error',
            0,
            null,
          );
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        // Final attempt
        lastError = new ApiClientError(
          error instanceof Error ? error.message : 'Network error',
          0,
          null,
        );
        break;
      } finally {
        clearTimeout(timeoutId);
        options?.signal?.removeEventListener('abort', onCallerAbort);
      }
    }

    // Mark API as unreachable on final failure
    if (lastError && (lastError.status === 0 || lastError.status >= 500)) {
      markApiUnreachable();
    }

    throw lastError ?? new ApiClientError('Request failed after all retries', 0, null);
  }

  // ── Response Parsing ───────────────────────────────────────────────────────

  /**
   * Parse the response body. Tries JSON first, falls back to text.
   */
  private async parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
    const contentType = response.headers.get('content-type') ?? '';

    const contentLength = response.headers.get('content-length');
    if (response.status === 204 || contentLength === '0') {
      return {
        data: null as unknown as T,
        status: response.status,
        headers: response.headers,
      };
    }

    let data: T;

    if (contentType.includes('application/json')) {
      const text = await response.text();
      if (!text || text.trim() === '') {
        data = null as unknown as T;
      } else {
        try {
          const raw = JSON.parse(text);
          if (raw && typeof raw === 'object' && 'data' in raw && Object.keys(raw).length <= 3) {
            data = raw.data as T;
          } else {
            data = raw as T;
          }
        } catch {
          data = null as unknown as T;
        }
      }
    } else {
      data = (await response.text()) as unknown as T;
    }

    return {
      data,
      status: response.status,
      headers: response.headers,
    };
  }

  /**
   * Safely parse a response body for error reporting.
   * Returns null if parsing fails.
   */
  private async safeParseBody(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  /**
   * Build a human-readable error message from the HTTP status and parsed body.
   */
  private buildErrorMessage(status: number, body: unknown): string {
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.error === 'string') return obj.error;
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.msg === 'string') return obj.msg;
    }

    const statusMessages: Record<number, string> = {
      400: 'Bad Request',
      401: 'Authentication required',
      403: 'Access denied',
      404: 'Not found',
      409: 'Conflict',
      422: 'Validation error',
      429: 'Too many requests',
      500: 'Internal server error',
      502: 'Bad gateway',
      503: 'Service unavailable',
      504: 'Gateway timeout',
    };

    return statusMessages[status] ?? `HTTP error ${status}`;
  }
}

// ─── Singleton Export ─────────────────────────────────────────────────────────

/**
 * Default API client singleton.
 *
 * - On the web: uses relative URLs (same-origin requests)
 * - On Capacitor: uses `NEXT_PUBLIC_API_URL` or `https://blasti.vercel.app`
 * - On the server: uses `INTERNAL_API_URL` or `http://localhost:3000`
 */
export const apiClient = new ApiClient();
