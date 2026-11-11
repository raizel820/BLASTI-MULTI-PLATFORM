/**
 * apiFetch — Drop-in replacement for fetch() that uses apiClient internally.
 *
 * WHY: 226+ raw fetch('/api/...') calls across the codebase bypass the apiClient's
 * 3-layer failover chain (Cloud API → LAN Server → WatermelonDB Cache). This wrapper
 * gives every fetch() call the same failover, retry, and offline support without
 * requiring callers to rewrite their code.
 *
 * Usage — replace `fetch` with `apiFetch`:
 *   // Before:
 *   const res = await fetch('/api/agency/stats');
 *   if (res.ok) { const data = await res.json(); ... }
 *
 *   // After:
 *   const res = await apiFetch('/api/agency/stats');
 *   if (res.ok) { const data = await res.json(); ... }
 *
 * Supports all standard fetch options:
 *   - JSON body: apiFetch('/api/data', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })
 *   - FormData body: apiFetch('/api/upload', { method: 'POST', body: formData })
 *   - AbortSignal: apiFetch('/api/data', { signal: controller.signal })
 */

import { apiClient, ApiClientError } from './api-client';
import { logWarn } from './remote-logger';

export interface ApiFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<any>;
  text: () => Promise<string>;
  blob: () => Promise<Blob>;
  headers: Headers;
  /**
   * Final response URL, when the underlying client exposes one. apiClient
   * responses generally carry none (failover layers abstract the origin),
   * so callers must treat this as optional — `!res.url` is the norm.
   */
  url?: string;
}

/**
 * Drop-in replacement for fetch() that routes through apiClient.
 * Gives every API call the 3-layer failover: Cloud → LAN → WatermelonDB.
 *
 * Accepts the same arguments as native fetch() for easy migration:
 *   - path: URL string (relative or absolute to API)
 *   - options.method, options.headers, options.body (string | FormData), options.signal
 */
// 0.6.55 — module-level throttle: one rate-limit log entry per 30 s max.
let lastRateLimitLogAt = 0;

export async function apiFetch(
  path: string,
  options?: {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: BodyInit | null;
    signal?: AbortSignal;
    credentials?: RequestCredentials;
    /**
     * Per-request timeout override (ms) — forwarded to apiClient.
     * 0.6.66: the desktop local API's auth proxies (register/verify/resend)
     * wait up to 15s on their own cloud fetch before answering — callers of
     * those endpoints MUST pass ≥ 20000 or the renderer aborts first and the
     * accurate error body never arrives.
     */
    timeout?: number;
  },
): Promise<ApiFetchResponse> {
  const method = (options?.method || 'GET').toUpperCase();

  // Normalize headers to Record<string, string>
  const headers: Record<string, string> = {};
  if (options?.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, options.headers);
    }
  }

  // Handle body — detect FormData vs JSON string
  let body: unknown = undefined;
  if (options?.body != null) {
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      body = options.body; // Pass FormData through as-is
    } else if (typeof options.body === 'string') {
      try {
        body = JSON.parse(options.body);
      } catch {
        body = options.body; // Not JSON — pass as-is
      }
    } else {
      body = options.body;
    }
  }

  const requestOptions = {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.timeout ? { timeout: options.timeout } : {}),
  };

  // 0.6.55 — "too many requests" observability: every 429 that reaches the
  // app lands in the log vault with the rate-limit trigger (throttled to one
  // entry per 30 s so a storm cannot spam the buffer).
  const noteRateLimit = (status: number) => {
    if (status !== 429) return;
    const now = Date.now();
    if (now - lastRateLimitLogAt < 30_000) return;
    lastRateLimitLogAt = now;
    logWarn('api', `rate limited by the server (HTTP 429) — ${method} ${path}`, { path, method }, 'rate-limit');
  };

  try {
    let res;
    switch (method) {
      case 'GET':
        res = await apiClient.get<any>(path, { ...requestOptions, headers });
        break;
      case 'POST':
        res = await apiClient.post<any>(path, body, { ...requestOptions, headers });
        break;
      case 'PUT':
        res = await apiClient.put<any>(path, body, { ...requestOptions, headers });
        break;
      case 'PATCH':
        res = await apiClient.patch<any>(path, body, { ...requestOptions, headers });
        break;
      case 'DELETE':
        // apiClient.delete() hardcodes the body to `undefined`, which silently
        // drops DELETE payloads (admin storage delete, upload remove, …).
        // Route through request() so a JSON body actually reaches the API;
        // with no body this is byte-for-byte what delete() did before.
        res = await apiClient.request<any>('DELETE', path, body, { ...requestOptions, headers });
        break;
      default:
        res = await apiClient.get<any>(path, requestOptions);
    }

    // Success — wrap the apiClient response in a fetch-like interface
    const data = res.data;
    const isJson = typeof data === 'object' || data === null || data === undefined;
    const textData = isJson ? JSON.stringify(data) : String(data);
    noteRateLimit(res.status);

    return {
      ok: true,
      status: res.status,
      statusText: 'OK',
      json: async () => data,
      text: async () => textData,
      blob: async () => new Blob([textData], { type: 'text/plain' }),
      headers: res.headers,
    };
  } catch (error) {
    // Error — return a fetch-like error response instead of throwing
    // This matches the behavior of fetch() which returns a Response with ok: false
    if (error instanceof ApiClientError) {
      const errBody = error.body ?? { error: error.message };
      const errText = typeof errBody === 'string' ? errBody : JSON.stringify(errBody);
      noteRateLimit(error.status || 0);
      return {
        ok: false,
        status: error.status || 500,
        statusText: error.message,
        json: async () => errBody,
        text: async () => errText,
        blob: async () => new Blob([errText], { type: 'text/plain' }),
        headers: new Headers(),
      };
    }

    // Unknown error — return a generic 500
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      status: 500,
      statusText: msg,
      json: async () => ({ error: msg }),
      text: async () => msg,
      blob: async () => new Blob([msg], { type: 'text/plain' }),
      headers: new Headers(),
    };
  }
}
