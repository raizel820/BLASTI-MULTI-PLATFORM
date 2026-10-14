import { normalizeUploadUrlPath } from './storage'

/**
 * Round 15 — FILE URL NORMALIZATION for cloud intake.
 *
 * History: the desktop local API stores files LOCALLY first (offline-first)
 * and returns URLs like `http://127.0.0.1:3080/api/upload/file/avatar/2025/06/x.png`,
 * and the cloud upload route used to bake the request-time origin into every
 * stored URL (http://localhost:3003/... behind proxies/phones). Both shapes
 * are meaningless to every OTHER device — the root cause of "profile images,
 * logos and all user-uploaded images show a placeholder everywhere".
 *
 * Task 2-c — intake now NORMALIZES ON WRITE to the CANONICAL RELATIVE path:
 * any value whose path matches /api/upload/file/<bucket>[/<yyyy>/<mm>]/<name>
 * (desktop-local absolute, request-origin absolute, or already relative) is
 * stripped to `/api/upload/file/...` before it reaches the database. Relative
 * paths are origin-agnostic: each client rebases them onto the API origin it
 * can actually reach (web getProxiedUrl, Electron local API proxy, gateway
 * XTransformPort). The storage SUFFIX is preserved byte-exact, so the desktop
 * file-sync push keeps landing the blob at the exact path the row points to.
 *
 * Values that are NOT upload-file URLs (external CDNs, data:, …) pass
 * through untouched. The `base` parameter is obsolete and kept optional for
 * call-site compatibility.
 */

/** Suffix keys whose string values may carry file URLs. */
const URL_FIELD_RE = /^(.*Url|url|fileUrl|imageUrl)$/i

function normalizeValue(value: string): string {
  return normalizeUploadUrlPath(value) ?? value
}

/**
 * Return a shallow copy of `record` with every URL-shaped string field
 * rewritten from any upload-file URL shape to the canonical RELATIVE
 * /api/upload/file/... path. Non-string fields and non-upload URLs
 * (external hosts, data:, …) pass through untouched.
 */
export function normalizeRecordFileUrls<T extends Record<string, unknown>>(record: T, base?: string): T {
  if (!record || typeof record !== 'object') return record
  void base // obsolete since Task 2-c — relative paths need no origin
  const out: Record<string, unknown> = { ...record }
  for (const [key, value] of Object.entries(out)) {
    if (!URL_FIELD_RE.test(key)) continue
    if (typeof value === 'string') out[key] = normalizeValue(value)
  }
  return out as T
}
