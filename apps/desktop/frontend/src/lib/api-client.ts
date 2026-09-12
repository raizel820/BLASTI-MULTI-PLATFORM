/**
 * BLASTI API Client — Desktop Re-export
 *
 * This module re-exports the Desktop's existing API client
 * so that imports from `@/lib/api-client` work consistently
 * across the codebase (matching the Web app's import paths).
 *
 * The actual API client implementation lives in the Desktop's
 * own networking layer. This file provides a compatible interface
 * so that shared modules (like fetch-with-retry) can import from
 * a single path.
 */

import { fetchWithRetry, getApiBaseUrl } from './fetch-with-retry';

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

// ─── Singleton Export ─────────────────────────────────────────────────────────

/**
 * Minimal API client singleton for the Desktop app.
 * Uses fetchWithRetry from the local fetch-with-retry module,
 * which routes all requests to http://127.0.0.1:3080.
 */
export const apiClient = {
  getBaseUrl: getApiBaseUrl,

  async get<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    const res = await fetchWithRetry(path, { ...options, method: 'GET' });
    const data = res.ok ? await res.json() : null;
    return { data: data as T, status: res.status, headers: res.headers };
  },

  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    const res = await fetchWithRetry(path, {
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : null,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
    const data = res.ok ? await res.json() : null;
    return { data: data as T, status: res.status, headers: res.headers };
  },

  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    const res = await fetchWithRetry(path, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : null,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
    const data = res.ok ? await res.json() : null;
    return { data: data as T, status: res.status, headers: res.headers };
  },

  async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse<T>> {
    const res = await fetchWithRetry(path, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : null,
      headers: { 'Content-Type': 'application/json', ...options?.headers },
    });
    const data = res.ok ? await res.json() : null;
    return { data: data as T, status: res.status, headers: res.headers };
  },

  async delete<T>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    const res = await fetchWithRetry(path, { ...options, method: 'DELETE' });
    const data = res.ok ? await res.json() : null;
    return { data: data as T, status: res.status, headers: res.headers };
  },
};

/**
 * True when the local API is unreachable.
 */
export function isApiUnreachable(): boolean {
  // In Desktop, this could check connectivity to 127.0.0.1:3080
  // For now, always returns false (local API assumed reachable)
  return false;
}

/**
 * True when both the API AND the realtime connection are unreachable.
 */
export function isBothUnreachable(): boolean {
  return isApiUnreachable();
}
