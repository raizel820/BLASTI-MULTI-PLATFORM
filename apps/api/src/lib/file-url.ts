import { isLocalOrRelativeFileUrl } from './storage'

/**
 * Round 15 — FILE URL NORMALIZATION for cloud intake.
 *
 * The desktop local API now stores files LOCALLY first (offline-first) and
 * returns URLs like `http://127.0.0.1:3080/api/upload/file/avatar/2025/06/x.png`.
 * Those URLs are meaningless to every OTHER device, so whenever a file URL
 * enters the cloud — via REST payloads (register avatar, profile update,
 * agency profile) or via the sync push intake — any desktop-local or relative
 * file URL is rewritten to the cloud's own public URL. The path SUFFIX is
 * preserved byte-exact ("avatar/2025/06/x.png"), and the desktop file-sync
 * push preserves that exact storage path, so the normalized URL becomes
 * valid the moment the blob lands on the cloud.
 */

/** Suffix keys whose string values may carry file URLs. */
const URL_FIELD_RE = /^(.*Url|url|fileUrl|imageUrl)$/i

function normalizeValue(value: string, base: string): string {
  if (!isLocalOrRelativeFileUrl(value)) return value
  const cut = value.indexOf('/api/upload/file/')
  if (cut < 0) return value
  const suffix = value.slice(cut + '/api/upload/file/'.length)
  return `${base.replace(/\/+$/, '')}/api/upload/file/${suffix}`
}

/**
 * Return a shallow copy of `record` with every URL-shaped string field
 * rewritten from desktop-local/relative file URLs to absolute cloud URLs.
 * Non-string fields and unknown URL schemes (data:, http(s) to other hosts)
 * pass through untouched.
 */
export function normalizeRecordFileUrls<T extends Record<string, unknown>>(record: T, base: string): T {
  if (!record || typeof record !== 'object' || !base) return record
  const out: Record<string, unknown> = { ...record }
  for (const [key, value] of Object.entries(out)) {
    if (!URL_FIELD_RE.test(key)) continue
    if (typeof value === 'string') out[key] = normalizeValue(value, base)
  }
  return out as T
}
