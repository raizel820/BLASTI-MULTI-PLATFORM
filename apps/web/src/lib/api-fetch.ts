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

export interface ApiFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<any>;
  text: () => Promise<string>;
  blob: () => Promise<Blob>;
  headers: Headers;
}

/**
 * Drop-in replacement for fetch() that routes through apiClient.
 * Gives every API call the 3-layer failover: Cloud → LAN → WatermelonDB.
 *
 * Accepts the same arguments as native fetch() for easy migration:
 *   - path: URL string (relative or absolute to API)
 *   - options.method, options.headers, options.body (string | FormData), options.signal
 */
export async function apiFetch(
  path: string,
  options?: {
    method?: string;
    headers?: Record<string, string> | Headers;
    body?: BodyInit | null;
    signal?: AbortSignal;
    credentials?: RequestCredentials;
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

  const requestOptions = options?.signal ? { signal: options.signal } : undefined;

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
        res = await apiClient.delete<any>(path, { ...requestOptions, headers });
        break;
      default:
        res = await apiClient.get<any>(path, requestOptions);
    }

    // Success — wrap the apiClient response in a fetch-like interface
    const data = res.data;
    const isJson = typeof data === 'object' || data === null || data === undefined;
    const textData = isJson ? JSON.stringify(data) : String(data);

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
