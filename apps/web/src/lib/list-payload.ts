/**
 * list-payload — normalize list endpoints that pass through apiClient's
 * envelope auto-unwrap (Task 45 root cause).
 *
 * ROOT CAUSE (apps/web/src/lib/api-client.ts parseResponse): any JSON body
 * that is an object containing a `data` key with ≤3 total keys is UNWRAPPED
 * to `raw.data` before the caller ever sees it. The desktop local API answers
 * list endpoints with the dual envelope { success, branches, data } (exactly
 * 3 keys, has `data`) → apiClient collapses it to the RAW ARRAY. Every UI
 * reader shaped `data.branches ?? data.data ?? []` then evaluates BOTH keys
 * against an ARRAY → undefined → [] — the desktop list rendered "no branches
 * yet" no matter what the local server actually held, while the webapp (cloud
 * shape { branches } — no `data` key, never unwrapped) showed the same rows
 * fine. This is the exact "created a branch on the desktop, the desktop keeps
 * showing no branches yet, the webapp shows them normally" report.
 *
 * The cloud shape { branches: [...] } (1 key, no `data`) is NOT unwrapped and
 * arrives as-is; a legacy local shape { success, data } IS unwrapped to the
 * array as well.
 *
 * unwrapListPayload() therefore accepts ALL observable outcomes:
 *   1. T[]                      — apiClient already unwrapped the envelope
 *   2. { <key>: T[] }           — cloud shape (e.g. { branches }, { staff })
 *   3. { <key>: T[], data: T[] }— dual envelope that escaped the unwrap
 *   4. { data: T[] }            — legacy local envelope, unwrapped or not
 * and always returns a plain array. `keys` are checked in order after the
 * array case; `data` is the final fallback.
 */
export function unwrapListPayload<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value as T[];
  }
  if (Array.isArray(obj.data)) return obj.data as T[];
  return [];
}
