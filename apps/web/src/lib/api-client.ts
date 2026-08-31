/**
 * BLASTI Cross-Platform API Client
 *
 * A unified HTTP client that works across Web, Electron, and Capacitor platforms.
 * Automatically resolves the correct base URL based on the runtime environment
 * and handles auth headers, retries, timeouts, and error normalization.
 *
 * Platform-specific behavior:
 * - **Web**: Uses relative URLs (same-origin) so cookies are sent automatically.
 * - **Electron**: Uses `NEXT_PUBLIC_API_URL` (falls back to `https://blasti.vercel.app`)
 *   because the renderer process is served from `file://` and needs an absolute URL.
 * - **Capacitor**: Same as Electron — native shells point to the Vercel-hosted backend.
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
 *
 * Related modules:
 * - `platform.ts` — Platform detection utilities
 * - `api-client-ssr.ts` — Pre-configured server-side singleton
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
 * Detect if we are running inside an Electron shell.
 * SSR-safe: returns false on the server.
 */
function isElectronRuntime(): boolean {
  if (isServerSide()) return false;
  const ua = navigator.userAgent;
  return !!(window as unknown as Record<string, unknown>).electronAPI || ua.includes('Electron');
}

/**
 * Detect if we are running inside a Capacitor native shell.
 * SSR-safe: returns false on the server.
 */
function isCapacitorRuntime(): boolean {
  if (isServerSide()) return false;
  return !!(window as unknown as Record<string, unknown>).Capacitor;
}

/**
 * Detect if we are running as a native app (Electron or Capacitor).
 * SSR-safe: returns false on the server.
 */
function isNativeRuntime(): boolean {
  return isElectronRuntime() || isCapacitorRuntime();
}

// ─── Base URL Resolution ──────────────────────────────────────────────────────

const DEFAULT_VERCEL_URL = 'https://blasti.vercel.app';
const DEFAULT_INTERNAL_URL = 'http://localhost:3000';
const DEFAULT_CLOUD_API_URL = 'http://localhost:3003';

/**
 * Resolve the API base URL for the current runtime environment.
 *
 * Priority:
 * 1. **SSR**: `INTERNAL_API_URL` env var → `http://localhost:3000`
 * 2. **Electron**: Cloud API directly → LAN failover to localhost:3080 on failure
 * 3. **Capacitor**: `NEXT_PUBLIC_API_URL` env var → `https://blasti.vercel.app`
 * 4. **Web (browser)**: `NEXT_PUBLIC_API_URL` → cloud API → fallback to localhost:3003
 *
 * NOTE: We removed the Next.js rewrite proxy (/api/* → localhost:3003) because
 * it crashes the dev server when the destination is unreachable (Next.js 16 bug).
 * All API routing is now handled client-side by this function + LAN failover.
 */
export function getApiBaseUrl(): string {
  // Server-side: use internal URL
  if (isServerSide()) {
    return process.env.INTERNAL_API_URL || DEFAULT_INTERNAL_URL;
  }

  // ── Electron: Connect to cloud API directly ─────────────────────────
  // When online, requests go straight to the cloud API (no proxy middleman).
  // When the cloud API is down, the LAN failover chain (requestViaLan) kicks in
  // and redirects to localhost:3080 (the embedded local API server).
  // This avoids the Next.js rewrite proxy which crashes the dev server when
  // the cloud API is unreachable.
  if (isElectronRuntime()) {
    return process.env.BLASTI_CLOUD_URL || DEFAULT_CLOUD_API_URL;
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
  // This is necessary because the sandbox gateway only exposes one port (3000)
  // externally, and direct fetch to localhost:3003 from the browser would fail.
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
  if (isServerSide() || !isNativeRuntime()) return null;
  try {
    return localStorage.getItem(NATIVE_SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Store the session token for native clients.
 * This should be called after a successful login when running in Electron or Capacitor.
 */
export function setNativeSessionToken(token: string): void {
  if (isServerSide() || !isNativeRuntime()) return;
  try {
    localStorage.setItem(NATIVE_SESSION_TOKEN_KEY, token);
  } catch {
    // localStorage may be unavailable (e.g. in private browsing)
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
 * - Electron: uses the local API session token from `localStorage` (set after login).
 * - Capacitor: reads the session token from localStorage and adds `Authorization: Bearer <token>`.
 */
function buildAuthHeaders(): Record<string, string> {
  if (isServerSide()) {
    // On the server, the session cookie is available in the request context.
    // Server-side calls go through internal URLs and should rely on the
    // cookie forwarding provided by the calling API route / server component.
    return {};
  }

  // ── Electron: Use Bearer token from Zustand store ───────────────────
  // In Electron, the cloud API is on a different port (3003) than the
  // renderer (3000), so cookies don't work reliably for cross-origin requests.
  // Instead, we send the JWT as a Bearer token. The token is stored in the
  // Zustand store (persisted to localStorage under 'blasti-app').
  if (isElectronRuntime()) {
    try {
      // Try local API token first (for port 3080 requests)
      const localToken = localStorage.getItem('blasti-local-api-token');
      if (localToken) {
        return { Authorization: `Bearer ${localToken}` };
      }
      // Fall back to cloud session token from Zustand store
      const storeData = localStorage.getItem('blasti-app');
      if (storeData) {
        try {
          const parsed = JSON.parse(storeData);
          const cloudToken = parsed?.state?.sessionToken || parsed?.sessionToken;
          if (cloudToken) {
            return { Authorization: `Bearer ${cloudToken}` };
          }
        } catch {
          // Invalid JSON — ignore
        }
      }
    } catch {
      // localStorage unavailable
    }
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

  // For web browser (not Electron/Capacitor/SSR): when using a relative base URL
  // (empty string), inject XTransformPort=3003 so the gateway routes API requests
  // to the cloud API on port 3003. The sandbox gateway only exposes port 3000
  // externally, so direct fetch to localhost:3003 from the browser would fail.
  if (!baseUrl && !isServerSide() && !isNativeRuntime()) {
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
// When the cloud API (port 3003 or Vercel) fails with a network error or 5xx,
// we mark it as temporarily unreachable for 30 seconds. During that window,
// requests on native platforms (Electron/Capacitor) try the LAN server
// (port 3080) FIRST, bypassing the slow cloud-retry cycle. This makes the
// desktop app feel instant when the API server is shut down.

let _apiUnreachableUntil = 0;
let _bothUnreachableUntil = 0;

// ─── HMR-Persistent Unreachable Flags ──────────────────────────────────
// Fast Refresh (HMR) resets all module-level variables, causing _apiUnreachableUntil
// to go back to 0. This makes the fast LAN bypass not trigger on the first batch
// of post-HMR requests, producing a burst of ERR_CONNECTION_REFUSED errors.
// We persist the flag in sessionStorage so it survives HMR cycles.
// sessionStorage is used (not localStorage) because the flag is only relevant
// for the current browser session — on a fresh page load, we want to start clean.

const UNREACHABLE_SESSION_KEY = 'blasti-api-unreachable-until';
const BOTH_UNREACHABLE_SESSION_KEY = 'blasti-both-unreachable-until';

/** Restore unreachable flags from sessionStorage (survives HMR). */
function restoreUnreachableFlags(): void {
  try {
    if (typeof window === 'undefined') return;
    const apiUntil = sessionStorage.getItem(UNREACHABLE_SESSION_KEY);
    if (apiUntil) {
      const val = parseInt(apiUntil, 10);
      // Only restore if the timestamp is still in the future
      if (!isNaN(val) && val > Date.now()) {
        _apiUnreachableUntil = val;
      } else {
        sessionStorage.removeItem(UNREACHABLE_SESSION_KEY);
      }
    }
    const bothUntil = sessionStorage.getItem(BOTH_UNREACHABLE_SESSION_KEY);
    if (bothUntil) {
      const val = parseInt(bothUntil, 10);
      if (!isNaN(val) && val > Date.now()) {
        _bothUnreachableUntil = val;
      } else {
        sessionStorage.removeItem(BOTH_UNREACHABLE_SESSION_KEY);
      }
    }
  } catch {
    // sessionStorage not available (e.g. private browsing in some contexts)
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
    if (_bothUnreachableUntil > Date.now()) {
      sessionStorage.setItem(BOTH_UNREACHABLE_SESSION_KEY, String(_bothUnreachableUntil));
    } else {
      sessionStorage.removeItem(BOTH_UNREACHABLE_SESSION_KEY);
    }
  } catch { /* ignore */ }
}

// Restore flags immediately on module load (handles HMR re-initialization)
restoreUnreachableFlags();
// Module init banner — shows platform, URLs, and flag state on every load (including HMR)
{
  const platform = isElectronRuntime() ? 'Electron' : isCapacitorRuntime() ? 'Capacitor' : isServerSide() ? 'SSR' : 'Web';
  const baseUrl = getApiBaseUrl();
  const apiRem = Math.max(0, _apiUnreachableUntil - Date.now());
  const bothRem = Math.max(0, _bothUnreachableUntil - Date.now());
  const restored = _apiUnreachableUntil > 0 || _bothUnreachableUntil > 0;
  const flags = restored
    ? ` apiUnreach=${_apiUnreachableUntil > 0 ? `YES (~${apiRem}ms)` : 'no'} | bothUnreach=${_bothUnreachableUntil > 0 ? `YES (~${bothRem}ms)` : 'no'}`
    : '';
  console.log(`%c[ApiClient:INIT] platform=${platform} baseUrl=${baseUrl || '(relative)'}${flags}${restored ? ' (restored from sessionStorage)' : ''}`,
    restored ? 'color: #f59e0b' : 'color: #22c55e');
}

/**
 * True when the CLOUD API is unreachable (fast LAN bypass).
 * Set as soon as cloud fails, cleared when cloud responds successfully.
 * Used at line ~496 to skip cloud and try LAN first (optimization).
 * The flag is HMR-persistent via sessionStorage.
 */
export function isApiUnreachable(): boolean {
  return Date.now() < _apiUnreachableUntil;
}

/**
 * True when BOTH cloud AND LAN have failed.
 * Only set after the full cloud→LAN chain has been tried and both returned errors.
 * Used by isEffectivelyOffline() to decide whether to use WatermelonDB.
 *
 * CRITICAL: This is SEPARATE from _apiUnreachableUntil (which is set when only
 * cloud fails, to enable the fast LAN bypass optimization). Without this
 * separation, isEffectivelyOffline() would return true when only cloud is
 * down but LAN is working — causing all requests (including mutations) to
 * be incorrectly routed to WatermelonDB instead of the live LAN server.
 *
 * Exported for use by polling consumers to back off when truly offline.
 * The flag is HMR-persistent via sessionStorage.
 */
export function isBothUnreachable(): boolean {
  return Date.now() < _bothUnreachableUntil;
}

function markBothUnreachable(): void {
  _bothUnreachableUntil = Date.now() + 30_000; // 30s cooldown
  persistUnreachableFlags();
  console.log(`[ApiClient:FLAGS] markBothUnreachable → both unreachable for 30s`);
}

/**
 * Clear ALL unreachable flags. Called when cloud responds successfully,
 * proving that internet is back.
 */
function markApiReachable(): void {
  _apiUnreachableUntil = 0;
  _bothUnreachableUntil = 0;
  persistUnreachableFlags();
  console.log(`[ApiClient:FLAGS] markApiReachable → all flags cleared`);
}

function markApiUnreachable(): void {
  _apiUnreachableUntil = Date.now() + 30_000; // 30s cooldown
  persistUnreachableFlags();
  console.log(`[ApiClient:FLAGS] markApiUnreachable → cloud unreachable for 30s`);
}

// ─── Online-Only Path Detection ──────────────────────────────────────────
//
// Certain API paths MUST always try the cloud API directly — they have no
// local implementation or require cloud-side processing (auth, admin, sync).
// Without this, a single transient cloud failure would block these endpoints
// for 30 seconds.
//
// The `includeAuth` parameter controls whether /api/auth/* is treated as
// online-only. In Electron, the local API (port 3080) has its own auth
// endpoints, so auth is NOT online-only for LAN failover. But for the
// WatermelonDB offline cache (monkey-patched request), auth IS online-only
// because we don't want to serve cached auth data.

/**
 * Check if a path must always reach the cloud API (never use offline fallback).
 *
 * @param path - The API path (e.g., '/api/admin/users', '/api/auth/login')
 * @param includeAuth - If true, /api/auth/* is also treated as online-only.
 *   Use false for LAN failover (Electron local API handles auth),
 *   true for WatermelonDB offline cache (never serve cached auth data).
 */
function isOnlineOnlyPath(path: string, includeAuth: boolean = true): boolean {
  if (!path.startsWith('/api/')) return false;
  if (path.startsWith('/api/admin/')) return true;
  if (path.includes('/register')) return true;
  if (path.includes('/password')) return true;
  if (path.includes('/sync/')) return true;
  if (path.includes('/offline-sync')) return true;
  // Only exclude global/settings paths that have no local implementation.
  // /api/agency/settings IS available on the local API (port 3080).
  if (path.match(/^\/api\/(user\/)?settings(\/|$)/)) return true;
  // NOTE: /no-show-analytics and /peak-hours are NOT excluded because the local API
  // (port 3080) has real SQLite-backed implementations for these endpoints.
  if (includeAuth && path.startsWith('/api/auth/')) return true;
  return false;
}

// ─── Electron LAN Pre-Discovery ─────────────────────────────────────────────
// In Electron, the desktop app IS the LAN server. Pre-discover it on first
// request so the failover chain works immediately — no 7s delay on first failure.

let _electronLanPreDiscovered = false;

async function preDiscoverElectronLan(): Promise<void> {
  if (_electronLanPreDiscovered || !isElectronRuntime()) return;
  _electronLanPreDiscovered = true;

  try {
    // Quick health check: can we reach localhost:3080?
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch('http://127.0.0.1:3080/api/discover', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const { setGlobalLanServer } = await import('@/hooks/use-lan-mode');
      setGlobalLanServer({ ip: '127.0.0.1', port: 3080 });
      console.log('[ApiClient] Pre-discovered Electron LAN server at localhost:3080');
    }
  } catch {
    // LAN server not ready yet — will be discovered on next failover attempt
  }
}

// ─── ApiClient Class ─────────────────────────────────────────────────────────

/**
 * Cross-platform API client for the BLASTI application.
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
    // In Electron, don't retry cloud — fail fast and let LAN failover kick in immediately.
    // The desktop app's LAN server (localhost:3080) has the same data, so there's no need
    // to wait through 7 seconds of cloud retries when the API server is down.
    const maxRetries = options?.retries ?? (isElectronRuntime() ? 0 : this.config.retries);
    // In Electron, use a shorter timeout (5s) so cloud failures are detected quickly
    // and LAN failover kicks in without a long wait.
    const timeoutMs = options?.timeout ?? (isElectronRuntime() ? 5_000 : this.config.timeout);
    const url = buildUrl(this.config.baseUrl, path, options?.params);

    // ── Electron: Pre-discover LAN server on first request ─────────────────────
    // Fire-and-forget: pre-populates getGlobalLanServer() for instant failover
    if (isElectronRuntime()) {
      preDiscoverElectronLan(); // async, non-blocking
    }

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = {
      ...buildAuthHeaders(),
      // Don't set Content-Type for FormData — browser sets it with correct boundary
      ...(body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    };

    // ── Fast LAN bypass: if the cloud API was recently marked unreachable
    // (5xx or network error in the last 30s) and we're on a native platform,
    // try the LAN server (port 3080) FIRST. This avoids waiting through the
    // full cloud-retry cycle on every button click when the API is down.
    // Use includeAuth=false: Electron local API (port 3080) has its own auth endpoints.
    const _fastBypassEligible = isApiUnreachable() && isNativeRuntime() && !isOnlineOnlyPath(path, false);
    if (_fastBypassEligible) {
      console.log(`[ApiClient:FAST_LAN] ${method} ${path} → skipping cloud (isApiUnreachable=true, ~${Math.max(0, _apiUnreachableUntil - Date.now())}ms remaining)`);
      try {
        const result = await this.requestViaLan<T>(method, path, body, options);
        console.log(`[ApiClient:FAST_LAN] ${method} ${path} → LAN OK (${result.status})`);
        return result;
      } catch (lanErr) {
        const lanStatus = lanErr instanceof ApiClientError ? lanErr.status : 0;
        // If LAN returned a 4xx, the server IS up — the route just doesn't
        // exist or the request is invalid. Retrying cloud won't help.
        // Throw the LAN error immediately so the caller can handle it.
        if (lanErr instanceof ApiClientError && lanErr.status >= 400 && lanErr.status < 500) {
          console.log(`[ApiClient:FAST_LAN] ${method} ${path} → LAN 4xx (${lanStatus}), throwing (server is up)`);
          throw lanErr;
        }
        // Network error or 5xx from LAN — fall through to normal cloud retry
        console.log(`[ApiClient:FAST_LAN] ${method} ${path} → LAN failed (status=${lanStatus}), falling through to cloud`);
      }
    } else if (isNativeRuntime()) {
      // Log WHY fast bypass was skipped (for debugging)
      const reasons: string[] = [];
      if (!isApiUnreachable()) reasons.push('apiReachable');
      if (!isNativeRuntime()) reasons.push('notNative');
      if (isOnlineOnlyPath(path, false)) reasons.push('onlineOnlyPath');
      // Only log occasionally to avoid spam — first request and when flags change
      if (!isApiUnreachable() && isOnlineOnlyPath(path, false)) {
        console.log(`[ApiClient:CLOUD] ${method} ${path} → cloud (onlineOnlyPath, skipping LAN)`);
      }
    }

    let lastError: ApiClientError | null = null;

    console.log(`[ApiClient:CLOUD] ${method} ${path} → ${url} (retries=${maxRetries}, timeout=${timeoutMs}ms, isApiUnreachable=${isApiUnreachable()})`);
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
        //   In Electron/Capacitor, auth is via Bearer token, not cookies.
        //   Using 'include' on cross-origin causes CORS failure when the server
        //   responds with Access-Control-Allow-Origin: *.
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
          markApiReachable(); // Cloud is back — clear the unreachable flag
          const elapsed = (performance.now() - attemptStart).toFixed(0);
          console.log(`[ApiClient:CLOUD] ${method} ${path} → OK ${response.status} (${elapsed}ms, attempt ${attempt}/${maxRetries})`);
          return await this.parseResponse<T>(response);
        }

        // Client errors (4xx) — do NOT retry, throw immediately
        if (response.status >= 400 && response.status < 500) {
          const errorBody = await this.safeParseBody(response);
          const elapsed = (performance.now() - attemptStart).toFixed(0);
          console.log(`[ApiClient:CLOUD] ${method} ${path} → 4xx (${response.status}, ${elapsed}ms), no retry`);
          throw new ApiClientError(
            this.buildErrorMessage(response.status, errorBody),
            response.status,
            errorBody,
          );
        }

        // 503 from our middleware — cloud API is down, skip retries and
        // go straight to LAN failover. This avoids wasting time retrying
        // a known-down server.
        if (response.status === 503) {
          const errorBody = await this.safeParseBody(response);
          const elapsed = (performance.now() - attemptStart).toFixed(0);
          lastError = new ApiClientError(
            this.buildErrorMessage(response.status, errorBody),
            response.status,
            errorBody,
          );
          markApiUnreachable(); // Mark as unreachable for the 30s cache
          console.log(`[ApiClient:CLOUD] ${method} ${path} → 503 (${elapsed}ms), skipping retries → LAN failover`);
          break; // Skip remaining retries — go straight to LAN failover
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

        // Final attempt failed — set lastError and break so LAN failover can run
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
            console.log(`[ApiClient:CLOUD] ${method} ${path} → cancelled by caller (${elapsed}ms)`);
            throw new ApiClientError('Request was cancelled', 0, null);
          }
          console.log(`[ApiClient:CLOUD] ${method} ${path} → timed out after ${timeoutMs}ms (${elapsed}ms actual, attempt ${attempt}/${maxRetries})`);
          // CRITICAL FIX: Use `break` instead of `throw` so LAN failover at line 818 runs.
          // Previously, `throw` here exited the retry loop entirely, skipping the
          // LAN failover code. On native platforms, a cloud timeout should fall
          // through to the local API (port 3080), not immediately fail.
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
        console.log(`[ApiClient:CLOUD] ${method} ${path} → network error: ${errMsg} (${elapsed}ms, attempt ${attempt}/${maxRetries})`);

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

        // Final attempt — set lastError and break so LAN failover can run
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

    // LAN failover: on native platforms, if all cloud retries failed with a network error
    // OR a server error (5xx — which happens when the Next.js proxy can't reach the backend),
    // try the LAN desktop server (port 3080) before giving up.
    // Use includeAuth=false: auth routes are allowed to fall through to LAN in Electron.
    const _lanEligible = lastError && isNativeRuntime() && !isOnlineOnlyPath(path, false) && (lastError.status === 0 || (lastError.status >= 500 && lastError.status < 600));
    if (_lanEligible) {
      markApiUnreachable(); // Mark cloud as unreachable so future requests try LAN first
      console.log(`[ApiClient:LAN] ${method} ${path} → cloud failed (status=${lastError.status}), trying LAN failover`);
      try {
        const result = await this.requestViaLan<T>(method, path, body, options);
        console.log(`[ApiClient:LAN] ${method} ${path} → LAN OK (${result.status})`);
        return result;
      } catch (lanErr) {
        // CRITICAL: Only mark as fully offline (both unreachable) when the LAN
        // error is a network error (status 0) or server error (5xx).
        // A 4xx from LAN means the server IS up but the route doesn't exist
        // or the data is missing. We must NOT treat this as "offline" —
        // other routes that LAN DOES support should continue working.
        // (See Issue #16 in the offline analysis: "A 404 from local API is
        // not a network failure.")
        if (lanErr instanceof ApiClientError && (lanErr.status === 0 || lanErr.status >= 500)) {
          markBothUnreachable();
          console.log(`[ApiClient:LAN] ${method} ${path} → LAN also failed (status=${lanErr.status}), marking BOTH unreachable for 30s`);
          // LAN returned a network/server error — throw the cloud error
        } else if (lanErr instanceof ApiClientError && lanErr.status >= 400 && lanErr.status < 500) {
          // LAN returned 4xx (e.g., 404 route not implemented, 403 permission).
          // The LAN server is UP. Throw the LAN error (not cloud error)
          // so the caller gets accurate info. Do NOT mark as offline.
          console.log(`[ApiClient:LAN] ${method} ${path} → LAN 4xx (${lanErr.status}), server is UP (not marking offline)`);
          throw lanErr;
        }
        // Other error types — fall through and throw cloud error
      }
    }

    if (!_lanEligible && lastError) {
      console.log(`[ApiClient:FAIL] ${method} ${path} → no LAN failover (native=${isNativeRuntime()}, onlineOnly=${isOnlineOnlyPath(path, false)}, status=${lastError.status})`);
    }
    // Should not reach here, but just in case
    throw lastError ?? new ApiClientError('Request failed after all retries', 0, null);
  }

  // ── LAN Server Fallback ──────────────────────────────────────────────────────

  /**
   * Retry a failed request against the LAN desktop server (port 3080).
   * Only called when cloud is unreachable and we're on a native platform.
   *
   * In Electron: always tries localhost:3080 because the desktop app IS the LAN server.
   * In Capacitor: uses getGlobalLanServer() from discovery results.
   * If neither is available, throws immediately.
   *
   * Session auto-restore: If the local API returns 401, it may be because the
   * renderer rehydrated (Fast Refresh / reload) but the IPC setLocalApiSession
   * hasn't fired yet. We re-import the session from localStorage and retry once.
   */
  private async requestViaLan<T>(
    method: string,
    path: string,
    body?: any,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>> {
    let lanUrl: string | null = null;

    // In Electron, the desktop app IS the LAN server — always on localhost:3080
    if (isElectronRuntime()) {
      lanUrl = `http://127.0.0.1:3080${path}`;

      // Also eagerly register the LAN server so subsequent calls don't re-discover
      try {
        const { setGlobalLanServer } = await import('@/hooks/use-lan-mode');
        const current = await import('@/hooks/use-lan-mode').then(m => m.getGlobalLanServer());
        if (!current) {
          setGlobalLanServer({ ip: '127.0.0.1', port: 3080 });
        }
      } catch {
        // Non-critical — continue with the request
      }
    } else {
      // Capacitor / other native: use discovered server
      const { getGlobalLanServer } = await import('@/hooks/use-lan-mode');
      const server = getGlobalLanServer();
      if (!server) {
        console.log(`[ApiClient:LAN] ${method} ${path} → no LAN server discovered, throwing`);
        throw new ApiClientError('No LAN server available', 0, null);
      }
      lanUrl = `http://${server.ip}:${server.port}${path}`;
    }

    console.log(`[ApiClient:LAN] ${method} ${path} → ${lanUrl}`);

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = {
      // Don't set Content-Type for FormData — browser sets it with correct boundary
      ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
      ...buildAuthHeaders(),
      ...options?.headers,
    };

    // Use a short timeout for LAN requests (3s) — the server is local
    const lanController = new AbortController();
    const lanTimeout = setTimeout(() => lanController.abort(), 3000);
    const lanStart = performance.now();

    // Combine with caller's signal if provided
    if (options?.signal?.aborted) {
      clearTimeout(lanTimeout);
      throw new ApiClientError('Request was cancelled', 0, null);
    }
    const onCallerAbort = () => lanController.abort();
    options?.signal?.addEventListener('abort', onCallerAbort);

    try {
      const response = await fetch(lanUrl, {
        method,
        headers,
        body: body !== undefined ? (isFormData ? body as BodyInit : JSON.stringify(body)) : undefined,
        credentials: 'omit', // LAN server uses Bearer token auth, not cookies
        signal: lanController.signal,
      });

      clearTimeout(lanTimeout);
      options?.signal?.removeEventListener('abort', onCallerAbort);

      // ── Session auto-restore on 401 / 503 ────────────────────────
      // After a Fast Refresh or page reload, the local API's sessionUser is
      // null → authMiddleware returns 401. Or db is null → returns 503.
      // In either case, re-importing the session via IPC may also trigger
      // the local API to re-initialize. We re-import from localStorage and retry.
      if ((response.status === 401 || response.status === 503) && isElectronRuntime()) {
        const elapsed = (performance.now() - lanStart).toFixed(0);
        console.log(`[ApiClient:LAN] ${method} ${path} → ${response.status} (${elapsed}ms), attempting session restore...`);
        // For 503, only retry once to avoid infinite loops if db is permanently broken
        const restored = await this.tryRestoreLocalSession();
        if (restored) {
          console.log(`[ApiClient:LAN] ${method} ${path} → session restored, retrying...`);
          // Retry with fresh headers (token is the same, but the session is now valid)
          const retryController = new AbortController();
          const retryTimeout = setTimeout(() => retryController.abort(), 3000);
          const onRetryAbort = () => retryController.abort();
          options?.signal?.addEventListener('abort', onRetryAbort);

          try {
            const retryResponse = await fetch(lanUrl, {
              method,
              headers,
              body: body !== undefined ? (isFormData ? body as BodyInit : JSON.stringify(body)) : undefined,
              credentials: 'omit',
              signal: retryController.signal,
            });

            clearTimeout(retryTimeout);
            options?.signal?.removeEventListener('abort', onRetryAbort);

            if (retryResponse.ok) {
              const retryElapsed = (performance.now() - lanStart).toFixed(0);
              console.log(`[ApiClient:LAN] ${method} ${path} → retry after restore OK ${retryResponse.status} (${retryElapsed}ms total)`);
              return await this.parseResponse<T>(retryResponse);
            }
            // Still not OK — fall through to error below
            const retryElapsed = (performance.now() - lanStart).toFixed(0);
            const errorText = await retryResponse.text().catch(() => '');
            console.log(`[ApiClient:LAN] ${method} ${path} → retry after restore still ${retryResponse.status} (${retryElapsed}ms total)`);
            throw new ApiClientError(
              `LAN request failed after session restore: ${retryResponse.status}`,
              retryResponse.status,
              errorText,
            );
          } catch (error) {
            clearTimeout(retryTimeout);
            options?.signal?.removeEventListener('abort', onRetryAbort);
            if (error instanceof ApiClientError) throw error;
            throw new ApiClientError(
              error instanceof Error ? error.message : 'LAN retry failed',
              0,
              null,
            );
          }
        } else {
          console.log(`[ApiClient:LAN] ${method} ${path} → session restore FAILED (no token/user in localStorage)`);
        }
      }

      if (!response.ok) {
        const elapsed = (performance.now() - lanStart).toFixed(0);
        const errorText = await response.text().catch(() => '');
        // Structured logging for LAN errors (Issue #17 from offline analysis)
        if (response.status === 404) {
          console.warn(`[LAN 404 ROUTE_NOT_IMPLEMENTED] ${method} ${path} (${elapsed}ms) — local API does not implement this route. If this is needed offline, add it to local-api/index.js.`);
        } else if (response.status >= 500) {
          try {
            const errJson = JSON.parse(errorText);
            const detail = errJson?.detail || errJson?.error || errorText;
            console.warn(`[LAN ${response.status} SERVER_ERROR] ${method} ${path} (${elapsed}ms):`, detail);
          } catch {
            console.warn(`[LAN ${response.status} SERVER_ERROR] ${method} ${path} (${elapsed}ms):`, errorText);
          }
        } else {
          console.warn(`[LAN ${response.status}] ${method} ${path} (${elapsed}ms):`, errorText);
        }
        throw new ApiClientError(
          `LAN request failed: ${response.status}`,
          response.status,
          errorText,
        );
      }

      return await this.parseResponse<T>(response);
    } catch (error) {
      const elapsed = (performance.now() - lanStart).toFixed(0);
      clearTimeout(lanTimeout);
      options?.signal?.removeEventListener('abort', onCallerAbort);
      if (error instanceof ApiClientError) {
        console.log(`[ApiClient:LAN] ${method} ${path} → error (${error.status}, ${elapsed}ms): ${error.message}`);
        throw error;
      }
      console.log(`[ApiClient:LAN] ${method} ${path} → network error (${elapsed}ms): ${error instanceof Error ? error.message : 'unknown'}`);
      throw new ApiClientError(
        error instanceof Error ? error.message : 'LAN request failed',
        0,
        null,
      );
    }
  }

  /**
   * Attempt to restore the local API session from localStorage.
   * Called when the local API returns 401, indicating sessionUser is null
   * (e.g. after a Fast Refresh where IPC hasn't fired yet).
   *
   * @returns true if session was successfully restored, false otherwise
   */
  private async tryRestoreLocalSession(): Promise<boolean> {
    try {
      const w = window as any;
      if (!w.electronAPI?.setLocalApiSession) {
        console.log(`[ApiClient:SESSION_RESTORE] electronAPI.setLocalApiSession not available`);
        return false;
      }

      const token = localStorage.getItem('blasti-local-api-token');
      if (!token) {
        console.log(`[ApiClient:SESSION_RESTORE] no blasti-local-api-token in localStorage`);
        return false;
      }

      // Read user from Zustand persisted state
      let user = null;
      const storeData = localStorage.getItem('blasti-app');
      if (storeData) {
        try {
          const parsed = JSON.parse(storeData);
          user = parsed?.state?.user || null;
        } catch { /* invalid JSON */ }
      }

      if (!user || !user.id) {
        console.log(`[ApiClient:SESSION_RESTORE] no valid user in Zustand store (user=${user ? 'exists, no id' : 'null'})`);
        return false;
      }

      console.log(`[ApiClient:SESSION_RESTORE] importing session for user=${user.id}...`);
      // Import session into local API via IPC (synchronous from renderer's perspective)
      await w.electronAPI.setLocalApiSession({ token, user });
      console.log(`[ApiClient:SESSION_RESTORE] success for user=${user.id}`);
      return true;
    } catch (err) {
      console.log(`[ApiClient:SESSION_RESTORE] failed:`, err);
      return false;
    }
  }

  // ── Response Parsing ───────────────────────────────────────────────────────

  /**
   * Parse the response body. Tries JSON first, falls back to text.
   * Phase 4: Fixed 204 Empty Response Bug — don't try to JSON-parse empty bodies.
   * Phase 6a: Fix Capacitor Empty Body Crash — safely handle empty responses
   * by fetching text first, applying fallback {} if empty, and only parsing JSON if text exists.
   */
  private async parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
    const contentType = response.headers.get('content-type') ?? '';

    // Phase 6a: Fix Capacitor Empty Body Crash — safely handle empty responses
    // Fetch text first, fallback to empty object, only parse JSON if text exists
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
      // Fetch text first to handle empty bodies that Capacitor WebView may return
      const text = await response.text();
      if (!text || text.trim() === '') {
        // Empty body — return null instead of crashing on JSON.parse('')
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
          // Malformed JSON — return null instead of crashing
          data = null as unknown as T;
        }
      }
    } else {
      // For non-JSON responses (e.g. CSV export), return the text
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
    // Try to extract an error message from the body
    if (body && typeof body === 'object') {
      const obj = body as Record<string, unknown>;
      if (typeof obj.error === 'string') return obj.error;
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.msg === 'string') return obj.msg;
    }

    // Fallback to status text
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

// ─── Offline-Aware Request Wrappers ──────────────────────────────────────

/**
 * Check if the client should be treated as offline.
 *
 * On web: uses `navigator.onLine` + both-unreachable flag.
 *
 * On native (Electron/Capacitor): ONLY considers offline after the cloud→LAN
 * failover chain has been tried and BOTH failed (`isBothUnreachable()`).
 * This is critical because `navigator.onLine` reports the OS network state,
 * not whether our LAN server (port 3080) is reachable — and the LAN server
 * needs zero internet. If we short-circuit here, the monkey-patched request()
 * throws "offline, no cached data" BEFORE the cloud→LAN failover runs.
 *
 * IMPORTANT: We use `isBothUnreachable()` (not `isApiUnreachable()`) here.
 * `isApiUnreachable()` is set when only the CLOUD fails (for the fast LAN
 * bypass optimization). If we used it here, ALL requests would be routed
 * to WatermelonDB for 30s after any cloud failure — even when LAN is
 * working perfectly. `isBothUnreachable()` is only set when BOTH cloud
 * AND LAN have failed, which is the correct condition for true offline.
 */
function isEffectivelyOffline(): boolean {
  if (isServerSide()) return false;

  // CRITICAL: On native platforms, only treat as offline when BOTH
  // cloud and LAN have been tried and failed. Use `isBothUnreachable()`
  // (NOT `isApiUnreachable()` which is set when only cloud fails).
  // See the JSDoc above for the full explanation of why this matters.
  if (isNativeRuntime()) {
    const result = isBothUnreachable();
    // Only log on transitions (not every poll) — log when it changes
    return result;
  }

  // Web: use navigator.onLine as a fast signal (no LAN server available)
  if (!navigator.onLine) return true;
  if (isBothUnreachable()) return true;
  return false;
}

/** Legacy alias — kept for backward compat */
const isOffline = isEffectivelyOffline;

// ─── Enhanced ApiClient with Offline Support (WatermelonDB-backed) ──────────────
//
// Replaces the legacy IndexedDB-based offline-queue.ts and offline-cache.ts.
// WatermelonDB now provides both the offline write path (local records that
// sync via /api/sync/push) and the offline read path (reactive queries
// against the local SQLite/LokiJS database).

// ─── API Path → Local Table Mapping ──────────────────────────────────────
// Maps web app API paths to local SQLite table names for Electron local DB fallback.
function mapApiPathToTable(path: string): string | null {
  if (path.includes('/reservations')) return 'reservations';
  if (path.includes('/agencies')) return 'agencies';
  if (path.includes('/services')) return 'services';
  if (path.includes('/branches')) return 'branches';
  if (path.includes('/counters')) return 'counters';
  if (path.includes('/notifications')) return 'notifications';
  if (path.includes('/queue_settings') || path.includes('/queue-settings')) return 'queue_settings';
  if (path.includes('/reviews')) return 'reviews';
  return null;
}

// We extend the existing class to avoid breaking the API
const _originalRequest = ApiClient.prototype.request;

ApiClient.prototype.request = async function<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<ApiResponse<T>> {
  const isGet = method === 'GET';
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const isApiCall = path.startsWith('/api/');

  // ── Paths that MUST always reach the server (never use offline fallback) ───────
  // Auth endpoints, account management, and anything that can't be queued offline.
  // Without this, a single transient network blip marks the API as "unreachable"
  // for 30 seconds, blocking login even when the cloud API is running.
  // Uses includeAuth=true: WatermelonDB cache must never serve cached auth data.
  const _offlineExcluded = isOnlineOnlyPath(path, true);
  const _isOffline = isOffline();
  const _isBothDown = isBothUnreachable();
  const _isApiDown = isApiUnreachable();

  // Decision matrix — one log line per request showing the full routing decision
  // Only log when the path is non-trivial (offline, excluded, mutation, or online-only)
  // to avoid spamming on every polling GET that goes through the normal LAN path.
  if (_isOffline || _offlineExcluded || isMutation || (isApiUnreachable() && isOnlineOnlyPath(path, false))) {
    const decisionParts: string[] = [];
    decisionParts.push(`offline=${_isOffline}`);
    decisionParts.push(`bothDown=${_isBothDown}`);
    decisionParts.push(`apiDown=${_isApiDown}`);
    if (_offlineExcluded) decisionParts.push('excluded=true');
    if (!isApiCall) decisionParts.push('nonApi');
    if (isGet) decisionParts.push('GET');
    if (isMutation) decisionParts.push(`MUT(${method})`);
    console.log(`[ApiClient:ROUTE] ${method} ${path} → ${decisionParts.join(' ')}`);
  }

  // ── Offline GET: Query WatermelonDB for cached records ───────────────────────
  if (isGet && isApiCall && _isOffline && !_offlineExcluded) {
    console.log(`[ApiClient:OFFLINE_GET] ${method} ${path} → WatermelonDB (bothUnreachable=${_isBothDown})`);
    try {
      const { getOfflineReservations, getOfflineAgencies, getOfflineServices } =
        await import('./offline-layer');

      let result: { data: any[] | null; found: boolean } = { data: null, found: false };

      if (path.includes('/reservations')) {
        const agencyId = options?.params?.agencyId as string | undefined;
        result = await getOfflineReservations({ agencyId });
      } else if (path.includes('/agencies')) {
        result = await getOfflineAgencies();
      } else if (path.includes('/services')) {
        const agencyId = options?.params?.agencyId as string | undefined;
        result = await getOfflineServices(agencyId);
      }

      if (result.found && result.data) {
        console.log(`[ApiClient:OFFLINE_GET] ${method} ${path} → WatermelonDB HIT (${result.data.length} rows)`);
        return {
          data: result.data as unknown as T,
          status: 200,
          headers: new Headers(),
        };
      }
    } catch {
      // WDB not available
      console.log(`[ApiClient:OFFLINE_GET] ${method} ${path} → WatermelonDB unavailable/error`);
    }
    // No local data — return offline error
    console.log(`[ApiClient:OFFLINE_GET] ${method} ${path} → no cached data, throwing`);
    throw new ApiClientError('You are offline and no cached data is available', 0, null);
  }

  // ── Offline Mutation: Store in WatermelonDB ─────────────────────
  if (isMutation && isApiCall && _isOffline && !_offlineExcluded) {
    console.log(`[ApiClient:OFFLINE_MUT] ${method} ${path} → WatermelonDB queue (bothUnreachable=${_isBothDown})`);
    try {
      const { createOfflineReservation, updateOfflineReservationStatus } =
        await import('./offline-layer');

      // Reservation creation
      if (path.includes('/reservations') && method === 'POST' && body) {
        const payload = body as any;
        const result = await createOfflineReservation({
          agencyId: payload.agencyId,
          serviceId: payload.serviceId,
          userId: payload.userId,
          customerName: payload.customerName || payload.walkInCustomerName,
          customerPhone: payload.customerPhone,
          notes: payload.notes,
          fixedTimeEnabled: payload.fixedTimeEnabled,
          preferredTime: payload.preferredTime,
        });

        if (result.success) {
          console.log(`[ApiClient] Stored offline reservation in WatermelonDB: ${path}`);
          return {
            data: { success: true, offline: true, id: result.recordId, message: result.message } as unknown as T,
            status: 202,
            headers: new Headers(),
          };
        }
      }

      // Reservation status update
      if (path.match(/\/reservations\/[^/]+\/?(call|complete|cancel|postpone)?/) && (method === 'PATCH' || method === 'PUT')) {
        const parts = path.split('/').filter(Boolean);
        const reservationId = parts[1];
        const action = parts[2];
        const payload = (body as any) || {};

        const statusMap: Record<string, string> = {
          call: 'CALLED',
          complete: 'COMPLETED',
          cancel: 'CANCELLED',
          postpone: 'POSTPONED',
        };
        const newStatus = statusMap[action] || payload.status || 'WAITING';

        const result = await updateOfflineReservationStatus(reservationId, newStatus, {
          counterId: payload.counterId,
          calledAt: action === 'call' ? new Date() : undefined,
          completedAt: action === 'complete' ? new Date() : undefined,
          cancelledAt: action === 'cancel' ? new Date() : undefined,
        });

        if (result.success) {
          console.log(`[ApiClient] Updated offline reservation in WatermelonDB: ${path}`);
          return {
            data: { success: true, offline: true, message: result.message } as unknown as T,
            status: 202,
            headers: new Headers(),
          };
        }
      }
    } catch (err) {
      console.warn('[ApiClient] WatermelonDB offline mutation failed:', err);
    }

    // Generic offline mutation — can't be queued in WDB, return error
    throw new ApiClientError('You are offline and this operation cannot be queued', 0, null);
  }

  // ── Online-only path + cloud known-down → fail fast ─────────────────────
  // When the cloud API is unreachable and the path has no offline/LAN
  // implementation, don't waste 2+ seconds on a guaranteed cloud failure.
  // The caller should handle this gracefully (e.g., hide analytics charts).
  if (isNativeRuntime() && isApiUnreachable() && isOnlineOnlyPath(path, false)) {
    const rem = Math.max(0, _apiUnreachableUntil - Date.now());
    console.log(`[ApiClient:SKIP] ${method} ${path} → cloud down & online-only, failing fast (~${rem}ms until retry)`);
    throw new ApiClientError('Cloud API unreachable and this endpoint has no offline fallback', 0, null);
  }

  // ── Online: Normal request flow ─────────────────────────────────────
  try {
    const result = await _originalRequest.call(this, method, path, body, options);
    return result;
  } catch (error) {
    const errStatus = error instanceof ApiClientError ? error.status : -1;
    const errNet = error instanceof ApiClientError ? error.isNetworkError : false;
    const errMsg = error instanceof ApiClientError ? error.message : String(error);
    console.log(`[ApiClient:ERROR] ${method} ${path} → failed (status=${errStatus}, netErr=${errNet}, bothUnreachable=${isBothUnreachable()}, offlineExcluded=${_offlineExcluded}, msg="${errMsg}")`);
    // ── Network error on mutation: Try WatermelonDB queue ──────────────────────────────
    // Trigger on network errors (status 0), server errors (5xx), OR when BOTH
    // cloud and LAN are unreachable. Use isBothUnreachable() (not isApiUnreachable)
    // because isApiUnreachable is set when only cloud fails — LAN may still work.
    const wdbMutEligible = isMutation && isApiCall && !_offlineExcluded && error instanceof ApiClientError && (error.isNetworkError || error.status >= 500 || isBothUnreachable());
    if (wdbMutEligible) {
      console.log(`[ApiClient:WDB_MUT] ${method} ${path} → trying offline queue (status=${errStatus}, netErr=${errNet}, bothDown=${isBothUnreachable()})`);
      try {
        const { createOfflineReservation, updateOfflineReservationStatus } =
          await import('./offline-layer');

        // Reservation creation
        if (path.includes('/reservations') && method === 'POST' && body) {
          const payload = body as any;
          const result = await createOfflineReservation({
            agencyId: payload.agencyId,
            serviceId: payload.serviceId,
            userId: payload.userId,
            customerName: payload.customerName || payload.walkInCustomerName,
            customerPhone: payload.customerPhone,
            notes: payload.notes,
            fixedTimeEnabled: payload.fixedTimeEnabled,
            preferredTime: payload.preferredTime,
          });

          if (result.success) {
            console.log(`[ApiClient:WDB_MUT] ${method} ${path} → queued in WatermelonDB`);
            return {
              data: { success: true, offline: true, id: result.recordId, message: 'Queued for sync when online' } as unknown as T,
              status: 202,
              headers: new Headers(),
            };
          }
        }

        // Reservation status update (call, complete, cancel, postpone)
        // Matches: /reservations/:id, /reservations/:id/call, /reservations/:id/complete, etc.
        const statusMatch = path.match(/\/reservations\/([^/]+)\/?(?:(call|complete|cancel|postpone))?$/);
        if (statusMatch && (method === 'PATCH' || method === 'PUT')) {
          const reservationId = statusMatch[1];
          const action = statusMatch[2];
          const payload = (body as any) || {};

          const statusMap: Record<string, string> = {
            call: 'CALLED',
            complete: 'COMPLETED',
            cancel: 'CANCELLED',
            postpone: 'POSTPONED',
          };
          const newStatus = statusMap[action || ''] || payload.status || 'WAITING';

          const result = await updateOfflineReservationStatus(reservationId, newStatus, {
            counterId: payload.counterId,
            calledAt: action === 'call' ? new Date() : undefined,
            completedAt: action === 'complete' ? new Date() : undefined,
            cancelledAt: action === 'cancel' ? new Date() : undefined,
          });

          if (result.success) {
            console.log(`[ApiClient:WDB_MUT] ${method} ${path} → status queued in WatermelonDB (${statusMap[action || ''] || payload.status || 'WAITING'})`);
            return {
              data: { success: true, offline: true, message: result.message } as unknown as T,
              status: 202,
              headers: new Headers(),
            };
          }
        }
      } catch {
        // WDB not available
      }
    }

    // ── Network error on GET: Try WatermelonDB cache ──────────────────────────────
    const wdbGetEligible = isGet && isApiCall && !_offlineExcluded && error instanceof ApiClientError && (error.isNetworkError || error.status >= 500 || isBothUnreachable());
    if (wdbGetEligible) {
      console.log(`[ApiClient:WDB_GET] ${method} ${path} → trying WatermelonDB cache (status=${errStatus}, netErr=${errNet}, bothDown=${isBothUnreachable()})`);
      try {
        const { getOfflineReservations, getOfflineAgencies, getOfflineServices, getOfflineBranches, getOfflineNotifications } =
          await import('./offline-layer');

        let result: { data: any[] | null; found: boolean } = { data: null, found: false };

        if (path.includes('/reservations')) {
          const agencyId = options?.params?.agencyId as string | undefined;
          result = await getOfflineReservations({ agencyId });
        } else if (path.includes('/agencies')) {
          result = await getOfflineAgencies();
        } else if (path.includes('/services')) {
          const agencyId = options?.params?.agencyId as string | undefined;
          result = await getOfflineServices(agencyId);
        } else if (path.includes('/branches')) {
          const agencyId = options?.params?.agencyId as string | undefined;
          if (agencyId) {
            const data = await getOfflineBranches(agencyId);
            if (data) result = { data, found: true };
          }
        } else if (path.includes('/notifications')) {
          result = await getOfflineNotifications();
        }

        if (result.found && result.data) {
          console.log(`[ApiClient:WDB_GET] ${method} ${path} → WatermelonDB HIT (${result.data.length} rows)`);
          return {
            data: result.data as unknown as T,
            status: 200,
            headers: new Headers(),
          };
        }
      } catch {
        // WDB not available
      }

      // ── Electron local API proxy fallback ──────────────────────────────
      // When WatermelonDB cache misses (e.g. aggregate routes like
      // /api/agency/stats that WDB can't serve), try fetching directly
      // from the local API (port 3080) via IPC or fetch. This catches the
      // case where the cloud failed AND the LAN failover was skipped
      // (e.g. AbortError that was already fixed, or both-unreachable flag).
      console.log(`[ApiClient:WDB_GET] ${method} ${path} → WatermelonDB miss, trying local API proxy`);
      if (isElectronRuntime()) {
        try {
          const lanProxyUrl = `http://127.0.0.1:3080${path}`;
          const headers = { ...buildAuthHeaders(), 'Content-Type': 'application/json' };
          const proxyController = new AbortController();
          const proxyTimeout = setTimeout(() => proxyController.abort(), 3000);
          try {
            const proxyRes = await fetch(lanProxyUrl, {
              method,
              headers,
              credentials: 'omit',
              signal: proxyController.signal,
            });
            clearTimeout(proxyTimeout);
            if (proxyRes.ok) {
              const proxyData = await proxyRes.json().catch(() => null);
              console.log(`[ApiClient:LAN_PROXY] ${method} ${path} → OK (${proxyRes.status})`);
              return {
                data: proxyData as unknown as T,
                status: proxyRes.status,
                headers: proxyRes.headers,
              };
            }
            console.log(`[ApiClient:LAN_PROXY] ${method} ${path} → ${proxyRes.status}`);
            // 401 from proxy — try session restore once
            if (proxyRes.status === 401) {
              const restored = await (this as any).tryRestoreLocalSession();
              if (restored) {
                const retryRes = await fetch(lanProxyUrl, { method, headers, credentials: 'omit', signal: AbortSignal.timeout(3000) });
                if (retryRes.ok) {
                  const retryData = await retryRes.json().catch(() => null);
                  console.log(`[ApiClient:LAN_PROXY] ${method} ${path} → OK after session restore`);
                  return { data: retryData as unknown as T, status: retryRes.status, headers: retryRes.headers };
                }
              }
            }
          } catch (proxyErr) {
            clearTimeout(proxyTimeout);
            console.log(`[ApiClient:LAN_PROXY] ${method} ${path} → failed: ${proxyErr instanceof Error ? proxyErr.message : 'unknown'}`);
          }
        } catch (err) {
          console.warn('[ApiClient] LAN proxy fallback error:', err);
        }

        // ── Electron local DB direct query fallback via IPC ──────────────────
        // For simple table routes that don't need aggregation
        try {
          const wAPI = (window as unknown as Record<string, unknown>).electronAPI as any;
          if (wAPI?.queryLocalDb) {
            const pathToTable = mapApiPathToTable(path);
            if (pathToTable) {
              const agencyId = options?.params?.agencyId;
              const dbResult = await wAPI.queryLocalDb({
                table: pathToTable,
                options: agencyId ? { agencyId } : {},
              });
              if (dbResult?.success && dbResult?.data?.length > 0) {
                console.log(`[ApiClient] Electron local DB fallback: ${path} → ${pathToTable} (${dbResult.data.length} rows)`);
                return {
                  data: dbResult.data as unknown as T,
                  status: 200,
                  headers: new Headers(),
                };
              }
            }
          }
        } catch (err) {
          console.warn('[ApiClient] Electron local DB fallback failed:', err);
        }
      }
    }

    // Re-throw original error — with a comprehensive summary of WHY no fallback worked
    const skipReasons: string[] = [];
    if (!isGet && !isMutation) skipReasons.push('non-GET/MUT');
    if (!isApiCall) skipReasons.push('nonApi');
    if (_offlineExcluded) skipReasons.push('excluded');
    if (!(error instanceof ApiClientError)) skipReasons.push('non-ApiClientError');
    if (error instanceof ApiClientError && !error.isNetworkError && error.status < 500) skipReasons.push(`4xx(${errStatus})`);
    if (isGet) {
      if (!wdbGetEligible) skipReasons.push('wdbGet_ineligible');
    } else if (isMutation) {
      if (!wdbMutEligible) skipReasons.push('wdbMut_ineligible');
    }
    console.log(`[ApiClient:THROW] ${method} ${path} → all fallbacks exhausted [${skipReasons.join(', ')}] status=${errStatus} msg="${errMsg}"`);
    throw error;
  }
};


// ─── Singleton Export ─────────────────────────────────────────────────────────────────

/**
 * Default API client singleton.
 *
 * - On the web: uses relative URLs (same-origin requests)
 * - On Electron / Capacitor: uses `NEXT_PUBLIC_API_URL` or `https://blasti.vercel.app`
 * - On the server: uses `INTERNAL_API_URL` or `http://localhost:3000`
 *
 * Import this in client components:
 * ```ts
 * import { apiClient } from '@/lib/api-client';
 * ```
 */
export const apiClient = new ApiClient();
