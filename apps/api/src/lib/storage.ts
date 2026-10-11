import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'

/**
 * Round 15 — central FILE STORAGE service for the cloud API.
 *
 * One module owns every decision about WHERE files live, HOW they are named,
 * and HOW URLs are built, so the filing system is uniform across:
 *   - POST /api/upload            (avatars, logos, receipts, general)
 *   - POST /api/files/sync/push   (desktop file-sync push)
 *   - app binaries               (GET /api/app-versions/:id/download)
 *
 * FILING SYSTEM (organized layout):
 *
 *   <STORAGE_ROOT>/
 *     avatar/<yyyy>/<mm>/<timestamp>-<rand8>.<ext>
 *     logo/<yyyy>/<mm>/...
 *     receipt/<yyyy>/<mm>/...
 *     document/<yyyy>/<mm>/...
 *     general/<yyyy>/<mm>/...
 *     app-versions/<platform>-<version>-<ts>-<name>.<ext>
 *
 * Legacy files uploaded before Round 15 sit FLAT in <bucket>/<name>; every
 * read path checks the organized layout first and falls back to the legacy
 * flat location, so nothing that was stored before breaks.
 *
 * STORAGE_ROOT resolution (VPS-friendly):
 *   1. BLASTI_STORAGE_DIR env (recommended on a VPS, e.g. /var/lib/blasti/uploads)
 *   2. <cwd>/uploads (development default)
 */

// ─── Configuration ──────────────────────────────────────────────────────────

export const STORAGE_ROOT = process.env.BLASTI_STORAGE_DIR
  ? path.resolve(process.env.BLASTI_STORAGE_DIR)
  : path.join(process.cwd(), 'uploads')

/** Absolute public base for built file URLs (set on the VPS behind a proxy). */
export const PUBLIC_BASE_URL = (process.env.BLASTI_PUBLIC_BASE_URL || '').replace(/\/+$/, '')

/** Buckets accepted in the upload `type` field (also URL path segments). */
export const STORAGE_TYPES = new Set(['general', 'avatar', 'logo', 'receipt', 'document'])

/** Buckets the DESKTOP FILE-SYNC may push into (superset of STORAGE_TYPES). */
export const SYNC_BUCKETS = new Set([...STORAGE_TYPES, 'app-binary'])

export const SAFE_TYPE_RE = /^[a-z][a-z0-9-]{0,23}$/

/** Safe filename shape produced everywhere: <timestamp13>-<uuid8>.<ext> */
export const SAFE_FILENAME_RE = /^\d{13}-[a-f0-9]{8}\.[a-z0-9]{2,5}$/

/** App-binary filenames are client-named (sanitized) — a looser shape. */
export const SAFE_BINARY_RE = /^[a-zA-Z0-9._-]{1,120}$/

const YEAR_RE = /^\d{4}$/
const MONTH_RE = /^(0[1-9]|1[0-2])$/

// ─── Path resolution (traversal-hardened) ───────────────────────────────────

function insideRoot(resolved: string): boolean {
  return resolved === path.resolve(STORAGE_ROOT) || resolved.startsWith(path.resolve(STORAGE_ROOT) + path.sep)
}

/**
 * Resolve a stored file to an absolute path.
 * Checks the organized <bucket>/<yyyy>/<mm>/<name> layout first, then the
 * legacy flat <bucket>/<name> layout. Returns null for anything unsafe.
 */
export function resolveStoredPath(bucket: string, name: string): string | null {
  if (!SAFE_TYPE_RE.test(bucket)) return null
  const resolvedRoot = path.resolve(STORAGE_ROOT)
  // Organized layout segments: bucket/yyyy/mm/name
  const parts = name.split('/').filter(Boolean)
  if (parts.length === 3) {
    const [yyyy, mm, file] = parts
    if (!YEAR_RE.test(yyyy) || !MONTH_RE.test(mm) || !SAFE_FILENAME_RE.test(file)) return null
    const resolved = path.resolve(resolvedRoot, bucket, yyyy, mm, file)
    return insideRoot(resolved) ? resolved : null
  }
  if (parts.length === 1) {
    const file = parts[0]
    const isFlatFile = SAFE_FILENAME_RE.test(file)
    const isBinary = bucket === 'app-binary' && SAFE_BINARY_RE.test(file)
    if (!isFlatFile && !isBinary) return null
    const resolved = path.resolve(resolvedRoot, bucket, file)
    return insideRoot(resolved) ? resolved : null
  }
  return null
}

/**
 * Resolve a RELATIVE storage path as written into FileAsset.storagePath
 * ("bucket/yyyy/mm/name" or legacy "bucket/name").
 */
export function resolveRelativeStoragePath(storagePath: string): string | null {
  const normalized = storagePath.replace(/\\/g, '/')
  const cut = normalized.indexOf('/')
  if (cut <= 0) return null
  return resolveStoredPath(normalized.slice(0, cut), normalized.slice(cut + 1))
}

// ─── Save / read / delete ───────────────────────────────────────────────────

export interface SavedFile {
  filename: string
  /** Relative path inside the storage root: bucket/yyyy/mm/filename */
  storagePath: string
  absPath: string
  yyyy: string
  mm: string
}

/** Generate the canonical unguessable filename for a new upload. */
export function makeFilename(ext: string): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
}

/** Store bytes under bucket/yyyy/mm/ with the given filename. */
export async function saveUpload(bucket: string, buffer: Buffer, filename: string): Promise<SavedFile> {
  if (!SAFE_TYPE_RE.test(bucket)) throw new Error(`Invalid storage bucket "${bucket}"`)
  if (!SAFE_FILENAME_RE.test(filename)) throw new Error(`Invalid storage filename "${filename}"`)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dir = path.join(STORAGE_ROOT, bucket, yyyy, mm)
  await fs.promises.mkdir(dir, { recursive: true })
  const absPath = path.join(dir, filename)
  await fs.promises.writeFile(absPath, buffer)
  return { filename, storagePath: `${bucket}/${yyyy}/${mm}/${filename}`, absPath, yyyy, mm }
}

export async function readStored(bucket: string, name: string): Promise<Buffer | null> {
  const p = resolveStoredPath(bucket, name)
  if (!p) return null
  try {
    return await fs.promises.readFile(p)
  } catch {
    return null
  }
}

export async function readByStoragePath(storagePath: string): Promise<Buffer | null> {
  const p = resolveRelativeStoragePath(storagePath)
  if (!p) return null
  try {
    return await fs.promises.readFile(p)
  } catch {
    return null
  }
}

export async function deleteByStoragePath(storagePath: string): Promise<boolean> {
  const p = resolveRelativeStoragePath(storagePath)
  if (!p) return false
  try {
    await fs.promises.unlink(p)
    return true
  } catch {
    return false
  }
}

// ─── URL building ───────────────────────────────────────────────────────────

/**
 * The public URL path for a stored file:
 *   /api/upload/file/<bucket>/<yyyy>/<mm>/<filename>
 */
export function publicFilePath(bucket: string, yyyy: string, mm: string, filename: string): string {
  return `/api/upload/file/${bucket}/${yyyy}/${mm}/${filename}`
}

/** The URL path for a relative storagePath (round-trips resolveRelativeStoragePath). */
export function publicFilePathForStoragePath(storagePath: string): string | null {
  const normalized = storagePath.replace(/\\/g, '/')
  const cut = normalized.indexOf('/')
  if (cut <= 0) return null
  return `/api/upload/file/${normalized}`
}

/**
 * Build the ABSOLUTE public URL clients should render. Prefers the
 * BLASTI_PUBLIC_BASE_URL env (stable behind reverse proxies / docker port
 * mappings), and falls back to the API's own request origin.
 */
export function absoluteFileUrl(requestOrigin: string, bucket: string, yyyy: string, mm: string, filename: string): string {
  const base = PUBLIC_BASE_URL || requestOrigin.replace(/\/+$/, '')
  return `${base}${publicFilePath(bucket, yyyy, mm, filename)}`
}

// ─── Parsing stored URLs back into storage paths ────────────────────────────

/**
 * Extract the storage-relative path from ANY file URL shape the system has
 * ever produced:
 *   .../api/upload/file/<bucket>/<yyyy>/<mm>/<name>   (organized)
 *   .../api/upload/file/<bucket>/<name>               (legacy flat)
 * Returns null when the URL is not a file URL.
 */
export function storagePathFromUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null
  const match = url.match(/\/api\/upload\/file\/([a-z0-9-]+\/(?:\d{4}\/(?:0[1-9]|1[0-2])\/)?[a-zA-Z0-9._-]+)$/)
  return match ? match[1] : null
}

/** True when the value is a file URL that points at a DESKTOP local API or is relative. */
export function isLocalOrRelativeFileUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.includes('/api/upload/file/')) return false
  if (value.startsWith('/api/upload/file/')) return true
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(value)
}
