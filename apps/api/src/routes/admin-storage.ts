/**
 * @blasti/api — Storage Manager Routes (SUPER_ADMIN only)
 *
 * Backs the admin sidebar "Database and Storage Management → Storage Manager"
 * page. The cloud API's central file store lives under STORAGE_ROOT
 * (apps/api/src/lib/storage.ts): one folder per category ("bucket"),
 * month-split inside each bucket, PLUS arbitrary admin-created folders at any
 * level (generalized folder model — see FOLDER MODEL below):
 *
 *   <STORAGE_ROOT>/
 *     avatar/<yyyy>/<mm>/<ts>-<rand8>.<ext>     → user profile pictures
 *     logo/<yyyy>/<mm>/...                      → agency logos & covers
 *     receipt/<yyyy>/<mm>/...                   → payment receipts / invoices
 *     document/<yyyy>/<mm>/...                  → documents (pdf, docs, ...)
 *     general/<yyyy>/<mm>/...                   → general uploads
 *     app-binary/<name>                         → desktop-synced app binaries
 *     app-versions/<group>/<name>               → app version downloads
 *     <any folder>/...                          → admin-managed folders
 *
 * Endpoints (every route requires SUPER_ADMIN):
 *
 *   GET    /overview              → disk usage at STORAGE_ROOT + totals +
 *                                   per-category breakdown + integrity counts
 *   GET    /browse?path=...       → GENERIC folder listing — `path` is a
 *                                   folder path relative to STORAGE_ROOT
 *                                   ('' = root; legacy `?bucket=<name>` alias
 *                                   kept): subfolders with recursive
 *                                   file/byte/subfolder aggregates + the
 *                                   folder's own files
 *   GET    /folders               → every FOLDER path in the tree (sorted,
 *                                   root '' included) — move/upload target
 *                                   pickers
 *   POST   /folder {path,name}    → create a subfolder of `path` ('' = new
 *                                   top-level bucket); 409 when it exists
 *   POST   /upload                → multipart/form-data: `path` (target
 *                                   folder, must exist) + 1..n `files`;
 *                                   filename sanitized, auto-suffix
 *                                   name-1.ext on conflict (never
 *                                   overwrites); FileAsset rows created for
 *                                   non-system buckets; 413 over 512MB/file
 *   POST   /move {storagePath,targetFolder}
 *                                 → move a file to another EXISTING folder
 *                                   (cross-bucket allowed, no overwrite);
 *                                   FileAsset + AppVersion rows repointed —
 *                                   moving an installer OUT of the
 *                                   app-versions bucket deactivates it
 *   GET    /file?path=...         → single file detail (disk stat + FileAsset
 *                                   DB record + public URL)
 *   GET    /download?path=...     → per-file ADMIN download (Task 2-c-2):
 *                                   streamed attachment (createReadStream,
 *                                   Content-Length from stat, Accept-Ranges +
 *                                   single-range 206, 416 on bad range, weak
 *                                   ETag + 304, Content-Disposition:
 *                                   attachment with RFC 5987 filename*)
 *   GET    /flat?bucket=...       → recursive flat listing of one bucket
 *   DELETE /file                  → delete a file by storagePath (disk unlink +
 *                                   FileAsset tombstone, mirrors upload.ts;
 *                                   invalidates the 'app-versions' cache tag)
 *   POST   /rename {storagePath,newName}
 *                                 → in-place rename (FileAsset + AppVersion
 *                                   rows repointed)
 *
 * FOLDER MODEL (generalized — arbitrary depth within limits)
 *   - FOLDER_NAME_RE /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/ validates every
 *     FOLDER segment ('..' anywhere and the exact names '.' / '..' are
 *     rejected). It is a strict SUPERSET of SAFE_TYPE_RE (legacy buckets),
 *     YEAR_RE (4 digits), MONTH_RE (2 digits) and GROUP_NAME_RE
 *     (lowercase+dash), so every legacy layout keeps validating unchanged —
 *     while arbitrary folder names ("general-test", "sub folder", "2025")
 *     are accepted too.
 *   - FILE paths: 2..6 segments (bucket + up to 4 folder levels + filename).
 *     FOLDER paths: up to 5 segments (bucket + up to 4 levels). The tree
 *     walk covers the same depth. Files always live inside a bucket — the
 *     STORAGE_ROOT itself holds folders only.
 *
 * SAFETY MODEL
 *   - Every route requires SUPER_ADMIN (requireAdmin) + authErrorResponse.
 *   - Every path is resolved through resolveManagerPath (files) /
 *     resolveManagerFolderPath (folders) below — traversal-hardened
 *     (segments validated, result must stay inside STORAGE_ROOT) but WITHOUT
 *     the strict canonical-filename guard of lib/storage.ts, so the manager
 *     can also inspect/delete stray or legacy files that were written to
 *     disk outside the upload pipeline.
 *   - Deletes ONLY touch files inside STORAGE_ROOT and tombstone (never
 *     hard-delete) the FileAsset row, so desktop sync converges cleanly.
 */

import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { invalidateResponseCacheTag } from '../lib/response-cache'
import {
  STORAGE_ROOT,
  publicFilePathForStoragePath,
} from '../lib/storage'

const app = new Hono()

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Filesystem entries of STORAGE_ROOT (top-level categories). Cached 30s. */
let dirCache: { at: number; dirs: string[] } | null = null
const DIR_CACHE_MS = 30_000

async function listStorageDirs(): Promise<string[]> {
  if (dirCache && Date.now() - dirCache.at < DIR_CACHE_MS) return dirCache.dirs
  let dirs: string[] = []
  try {
    const entries = await fs.promises.readdir(STORAGE_ROOT, { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    dirs = []
  }
  dirCache = { at: Date.now(), dirs }
  return dirs
}

/** Categories that belong to the SYSTEM, not user buckets (no FileAsset rows). */
const SYSTEM_DIRS = new Set(['app-versions'])

const YEAR_RE = /^\d{4}$/
const MONTH_RE = /^(0[1-9]|1[0-2])$/

/**
 * GENERIC folder-segment rule for the storage manager tree. Accepts any
 * folder name an admin may create ("general-test", "sub folder", "2025")
 * AND is a strict superset of SAFE_TYPE_RE (legacy buckets), YEAR_RE,
 * MONTH_RE and the old GROUP_NAME_RE (lowercase+dash, e.g. the
 * app-versions/desktop installer split) — so every pre-existing layout keeps
 * validating. '..' anywhere in the segment and the exact names '.' / '..' are
 * rejected.
 */
const FOLDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/

function isValidFolderSegment(seg: string): boolean {
  if (seg === '.' || seg === '..' || seg.includes('..')) return false
  return FOLDER_NAME_RE.test(seg)
}

/** First path segment (the bucket): system dirs, or any valid folder name. */
function isValidBucketSegment(seg: string): boolean {
  return SYSTEM_DIRS.has(seg) || isValidFolderSegment(seg)
}

/** Max folder segments of a FILE path including the bucket (see header doc). */
const MAX_PATH_DEPTH = 5

interface WalkedFile {
  rel: string // relative path from STORAGE_ROOT, POSIX separators
  bucket: string
  yyyy: string
  mm: string // '' for flat files
  name: string
  size: number
  mtimeMs: number
}

/**
 * Recursively walk ONE bucket up to MAX_PATH_DEPTH-1 folder levels below the
 * bucket root. Generic: every subdirectory is visited regardless of its name.
 * Location classification keeps the legacy layout where it still matches —
 * bucket/<yyyy>/<mm>/<name> keeps yyyy+mm, system-bucket group folders keep
 * yyyy=<group> and mm=''; any other file reports yyyy = its second path
 * segment (or '' when it sits directly in the bucket) and mm=''.
 */
async function walkBucket(
  bucket: string,
  bucketDir: string,
): Promise<{ files: WalkedFile[]; errors: number }> {
  const files: WalkedFile[] = []
  let errors = 0
  const walk = async (dir: string, segs: string[], depth: number): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      errors++
      return
    }
    for (const f of entries.filter((e) => e.isFile())) {
      try {
        const st = await fs.promises.stat(path.join(dir, f.name))
        const yyyy = segs[0] ?? ''
        const mm =
          segs.length >= 2 && YEAR_RE.test(segs[0]) && MONTH_RE.test(segs[1]) ? segs[1] : ''
        files.push({
          rel: [bucket, ...segs, f.name].join('/'),
          bucket,
          yyyy,
          mm,
          name: f.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
        })
      } catch {
        errors++
      }
    }
    if (depth >= MAX_PATH_DEPTH) return
    for (const d of entries.filter((e) => e.isDirectory())) {
      await walk(path.join(dir, d.name), [...segs, d.name], depth + 1)
    }
  }
  await walk(bucketDir, [], 1)
  return { files, errors }
}

/**
 * Walk the whole storage tree once. Returns every regular file grouped with
 * its parsed location. Works for the legacy bucket/yyyy/mm layout AND for
 * arbitrary admin-created folder trees alike.
 */
async function walkStorage(): Promise<{ files: WalkedFile[]; errors: number }> {
  const files: WalkedFile[] = []
  let errors = 0
  const dirs = await listStorageDirs()
  for (const bucket of dirs) {
    const res = await walkBucket(bucket, path.join(STORAGE_ROOT, bucket))
    files.push(...res.files)
    errors += res.errors
  }
  return { files, errors }
}

interface DiskInfo {
  totalGb: number
  freeGb: number
  usedGb: number
  usagePct: number
}

function statfsAsync(dir: string): Promise<{ blocks: number; bsize: number; bavail: number } | null> {
  return new Promise((resolve) => {
    const anyFs = fs as unknown as {
      statfs?: (p: string, cb: (err: unknown, s: Record<string, number>) => void) => void
    }
    if (typeof anyFs.statfs !== 'function') return resolve(null)
    try {
      anyFs.statfs(dir, (err, s) => {
        if (err || !s || !s.blocks) return resolve(null)
        resolve({ blocks: s.blocks, bsize: s.bsize, bavail: s.bavail })
      })
    } catch {
      resolve(null)
    }
  })
}

async function getDiskUsage(dir: string): Promise<DiskInfo | null> {
  const s = await statfsAsync(dir)
  if (!s) return null
  const totalBytes = s.blocks * s.bsize
  const freeBytes = s.bavail * s.bsize
  const gb = (b: number) => Math.round((b / (1024 * 1024 * 1024)) * 100) / 100
  const usedBytes = Math.max(0, totalBytes - freeBytes)
  return {
    totalGb: gb(totalBytes),
    freeGb: gb(freeBytes),
    usedGb: gb(usedBytes),
    usagePct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

/** Track FileAsset rows in a Map for O(1) membership checks. */
interface TrackedAsset {
  id: string
  size: number
  url: string
  ownerId: string | null
  agencyId: string | null
  createdAt: Date
}
async function loadTrackedMap(): Promise<Map<string, TrackedAsset>> {
  const rows = await db.fileAsset.findMany({
    where: { deletedAt: null },
    select: { id: true, storagePath: true, size: true, url: true, ownerId: true, agencyId: true, createdAt: true },
  })
  const map = new Map<string, TrackedAsset>()
  for (const r of rows) map.set(r.storagePath.replace(/\\/g, '/'), r)
  return map
}

// ─── GET /overview ──────────────────────────────────────────────────────────

app.get('/overview', async (c) => {
  try {
    await requireAdmin(c)
    const [disk, walk, tracked] = await Promise.all([getDiskUsage(STORAGE_ROOT), walkStorage(), loadTrackedMap()])
    const dirs = await listStorageDirs()

    interface Category {
      bucket: string
      files: number
      bytes: number
      dbCount: number
      dbBytes: number
      orphans: number
      missing: number
      lastModifiedMs: number | null
      system: boolean
    }
    const byCategory = new Map<string, Category>()
    const ensure = (bucket: string): Category => {
      let cat = byCategory.get(bucket)
      if (!cat) {
        cat = { bucket, files: 0, bytes: 0, dbCount: 0, dbBytes: 0, orphans: 0, missing: 0, lastModifiedMs: null, system: SYSTEM_DIRS.has(bucket) }
        byCategory.set(bucket, cat)
      }
      return cat
    }
    for (const d of dirs) ensure(d)

    const diskSet = new Set<string>()
    for (const f of walk.files) {
      diskSet.add(f.rel)
      const cat = ensure(f.bucket)
      cat.files++
      cat.bytes += f.size
      if (cat.lastModifiedMs === null || f.mtimeMs > cat.lastModifiedMs) cat.lastModifiedMs = f.mtimeMs
      if (!cat.system) {
        if (tracked.has(f.rel)) {
          cat.dbCount++
          cat.dbBytes += tracked.get(f.rel)!.size
        } else {
          cat.orphans++
        }
      }
    }
    // DB rows with no file on disk (excluding system dirs, which never had rows)
    for (const [storagePath] of tracked) {
      const bucket = storagePath.split('/')[0]
      if (SYSTEM_DIRS.has(bucket)) continue
      const cat = ensure(bucket)
      if (!diskSet.has(storagePath)) cat.missing++
    }

    const categories = [...byCategory.values()].sort((a, b) => b.bytes - a.bytes)
    const totals = categories.reduce(
      (acc, cat) => ({
        files: acc.files + cat.files,
        bytes: acc.bytes + cat.bytes,
        dbTracked: acc.dbTracked + cat.dbCount,
        orphans: acc.orphans + cat.orphans,
        missing: acc.missing + cat.missing,
      }),
      { files: 0, bytes: 0, dbTracked: 0, orphans: 0, missing: 0 },
    )

    return c.json({
      storageRoot: STORAGE_ROOT,
      disk,
      totals: { ...totals, categories: categories.length, walkErrors: walk.errors },
      categories,
    })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /browse?path=... — GENERIC folder listing ──────────────────────────
//
// `path` is a FOLDER path relative to STORAGE_ROOT ('' = root). The legacy
// `?bucket=<name>` query parameter is kept as an alias for `path=<name>` so
// nothing breaks mid-migration. The response works for EVERY level of the
// tree (root buckets, arbitrary subfolders, month folders — all one shape):
//
//   { path, name,
//     folders: [{ name, path, files, bytes, folders }],  // recursive aggregates
//     files:   [{ name, storagePath, size, mtimeMs, url, tracked }],
//     totals:  { files, bytes } }
//
// Folder aggregates use a recursive readdir+stat pass per subfolder (scale
// is small — this is an admin tool).

interface BrowseFolderRow {
  name: string
  path: string
  files: number
  bytes: number
  folders: number
}

interface BrowseFileRow {
  name: string
  storagePath: string
  size: number
  mtimeMs: number
  url: string | null
  tracked: boolean
}

/** Max recursion for aggregate counting (defensive — real trees are shallow). */
const AGG_MAX_DEPTH = 8

async function aggregateDir(dir: string): Promise<{ files: number; bytes: number; folders: number }> {
  const agg = { files: 0, bytes: 0, folders: 0 }
  const visit = async (d: string, depth: number): Promise<void> => {
    if (depth > AGG_MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isFile()) {
        try {
          const st = await fs.promises.stat(path.join(d, e.name))
          agg.files++
          agg.bytes += st.size
        } catch { /* raced */ }
      } else if (e.isDirectory()) {
        agg.folders++
        await visit(path.join(d, e.name), depth + 1)
      }
    }
  }
  await visit(dir, 0)
  return agg
}

app.get('/browse', async (c) => {
  try {
    await requireAdmin(c)
    // New contract: ?path=<folder-relative-to-STORAGE_ROOT> ('' = root).
    // Legacy alias: ?bucket=<name> ≡ path=<name>.
    let rawPath = c.req.query('path') ?? ''
    const legacyBucket = c.req.query('bucket') || ''
    if (!rawPath && legacyBucket) rawPath = legacyBucket

    const normalizedRel = rawPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const parts = normalizedRel.split('/').filter(Boolean)
    if (parts.length > MAX_PATH_DEPTH) return c.json({ success: false, error: 'Invalid path' }, 400)
    if (parts.length && !isValidBucketSegment(parts[0])) {
      return c.json({ success: false, error: 'Invalid path' }, 400)
    }
    if (!parts.slice(1).every(isValidFolderSegment)) {
      return c.json({ success: false, error: 'Invalid path' }, 400)
    }

    const folderAbs = path.resolve(path.join(STORAGE_ROOT, ...parts))
    if (!insideRoot(folderAbs)) return c.json({ success: false, error: 'Invalid path' }, 400)
    try {
      const st = await fs.promises.stat(folderAbs)
      if (!st.isDirectory()) return c.json({ success: false, error: 'Folder not found' }, 404)
    } catch {
      return c.json({ success: false, error: 'Folder not found' }, 404)
    }

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(folderAbs, { withFileTypes: true })
    } catch {
      return c.json({ success: false, error: 'Folder not found' }, 404)
    }

    // Subfolders (any level) with recursive file/byte/subfolder aggregates.
    const folders: BrowseFolderRow[] = []
    const dirEntries = entries.filter((x) => x.isDirectory() && isValidFolderSegment(x.name))
    dirEntries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of dirEntries) {
      const childRel = parts.length ? `${normalizedRel}/${e.name}` : e.name
      const agg = await aggregateDir(path.join(folderAbs, e.name))
      folders.push({ name: e.name, path: childRel, files: agg.files, bytes: agg.bytes, folders: agg.folders })
    }

    // The folder's own files (any level — month folders, group folders,
    // admin folders, and any stray flat files at the root of a bucket).
    const tracked = await loadTrackedMap()
    const files: BrowseFileRow[] = []
    for (const e of entries.filter((x) => x.isFile())) {
      try {
        const st = await fs.promises.stat(path.join(folderAbs, e.name))
        const rel = parts.length ? `${normalizedRel}/${e.name}` : e.name
        files.push({
          name: e.name,
          storagePath: rel,
          size: st.size,
          mtimeMs: st.mtimeMs,
          url: publicFilePathForStoragePath(rel),
          tracked: tracked.has(rel),
        })
      } catch { /* raced */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const totals = {
      files: files.length + folders.reduce((n, f) => n + f.files, 0),
      bytes: files.reduce((n, f) => n + f.size, 0) + folders.reduce((n, f) => n + f.bytes, 0),
    }

    return c.json({
      path: normalizedRel,
      name: parts.length ? parts[parts.length - 1] : '',
      folders,
      files,
      totals,
    })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /folders — every FOLDER path in the tree ───────────────────────────
//
// Feeds the move/upload target pickers in the manager UI: dirs only,
// recursive (same depth cap as the walk), sorted, root '' included.

async function listAllFolderPaths(): Promise<string[]> {
  const out: string[] = ['']
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth >= MAX_PATH_DEPTH) return
    const dir = rel ? path.join(STORAGE_ROOT, rel) : STORAGE_ROOT
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs = entries.filter((x) => x.isDirectory() && (rel ? isValidFolderSegment(x.name) : isValidBucketSegment(x.name)))
    subdirs.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of subdirs) {
      const child = rel ? `${rel}/${e.name}` : e.name
      out.push(child)
      await walk(child, depth + 1)
    }
  }
  await walk('', 0)
  out.sort((a, b) => a.localeCompare(b))
  return out
}

app.get('/folders', async (c) => {
  try {
    await requireAdmin(c)
    const folders = await listAllFolderPaths()
    return c.json({ folders })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /folder { path, name } — create a subfolder ───────────────────────
//
// `path` = existing parent folder ('' = STORAGE_ROOT root → creates a new
// top-level bucket). `name` is validated with FOLDER_NAME_RE; every segment
// of `path` is re-validated; 409 when the target already exists. The 30s
// top-level dir cache is invalidated so /overview sees a new bucket at once.

app.post('/folder', async (c) => {
  try {
    await requireAdmin(c)
    let body: { path?: string; name?: string } = {}
    try {
      body = await c.req.json()
    } catch { /* empty body */ }
    const parentRel = (body.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').trim()
    const name = (body.name || '').trim()
    if (!isValidFolderSegment(name)) {
      return c.json({ success: false, error: 'Invalid folder name' }, 400)
    }

    const parentParts = parentRel.split('/').filter(Boolean)
    // parent + name must stay within MAX_PATH_DEPTH folder segments.
    if (parentParts.length > MAX_PATH_DEPTH - 1) {
      return c.json({ success: false, error: 'Path too deep' }, 400)
    }
    if (parentParts.length && !isValidBucketSegment(parentParts[0])) {
      return c.json({ success: false, error: 'Invalid path' }, 400)
    }
    if (!parentParts.slice(1).every(isValidFolderSegment)) {
      return c.json({ success: false, error: 'Invalid path' }, 400)
    }

    const parentAbs = path.resolve(path.join(STORAGE_ROOT, ...parentParts))
    if (!insideRoot(parentAbs)) return c.json({ success: false, error: 'Invalid path' }, 400)
    // Root ('') always exists; a deeper parent must exist on disk.
    if (parentParts.length) {
      try {
        const st = await fs.promises.stat(parentAbs)
        if (!st.isDirectory()) return c.json({ success: false, error: 'Parent folder not found' }, 404)
      } catch {
        return c.json({ success: false, error: 'Parent folder not found' }, 404)
      }
    }

    const targetAbs = path.join(parentAbs, name)
    try {
      const st = await fs.promises.stat(targetAbs)
      if (st.isDirectory() || st.isFile()) {
        return c.json({ success: false, error: 'Folder already exists' }, 409)
      }
    } catch { /* does not exist — proceed */ }

    await fs.promises.mkdir(targetAbs, { recursive: true })

    // A new top-level bucket may have appeared — drop the 30s dir cache.
    dirCache = null

    return c.json({ success: true, path: [...parentParts, name].join('/') })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /upload — multipart upload into an EXISTING folder ────────────────
//
// multipart/form-data: `path` (target folder, must exist — the root '' is
// rejected: files always live inside a bucket) + one or more `files`.
// Per file: the client filename is sanitized to MANAGER_FILENAME_RE (bad
// chars → '_', dot-leading/empty → 'file' prefix); on conflict an automatic
// suffix name-1.ext, name-2.ext ... is applied (NEVER overwrites). Non-system
// buckets get a FileAsset row (srv-<uuid> device id, original client name).
// A single file over 512MB → 413.

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024

/** Client filename → safe MANAGER_FILENAME_RE name (never empty, no '..'). */
function sanitizeUploadName(raw: string): string {
  let name = (raw || '').split(/[\\/]/).pop() || ''
  name = name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\.\.+/g, '_')
  if (!/^[A-Za-z0-9]/.test(name)) name = `file${name}`
  if (name.length > 120) name = name.slice(0, 120)
  if (!MANAGER_FILENAME_RE.test(name)) name = `file-${Date.now()}`
  return name
}

/** Target path with an automatic -1/-2/... suffix when the name is taken. */
async function uniqueUploadTarget(dirAbs: string, name: string): Promise<{ abs: string; finalName: string }> {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  let n = 1
  // fileExists() tests for FILES; a DIRECTORY with the same name is left to
  // the write failing below (surface as a skipped entry, never an overwrite).
  while (await fileExists(path.join(dirAbs, candidate))) {
    candidate = `${base}-${n}${ext}`
    n++
  }
  return { abs: path.join(dirAbs, candidate), finalName: candidate }
}

app.post('/upload', async (c) => {
  try {
    await requireAdmin(c)
    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      return c.json({ success: false, error: 'multipart/form-data body required' }, 400)
    }

    const folderRaw = String(formData.get('path') ?? '').replace(/\\/g, '/').replace(/\/+$/, '').trim()
    if (!folderRaw) {
      return c.json({ success: false, error: 'Files must live inside a bucket — choose a target folder' }, 400)
    }
    const folderParts = folderRaw.split('/').filter(Boolean)
    if (folderParts.length > MAX_PATH_DEPTH || !isValidBucketSegment(folderParts[0]) || !folderParts.slice(1).every(isValidFolderSegment)) {
      return c.json({ success: false, error: 'Invalid path' }, 400)
    }
    const folderAbs = path.resolve(path.join(STORAGE_ROOT, ...folderParts))
    if (!insideRoot(folderAbs)) return c.json({ success: false, error: 'Invalid path' }, 400)
    try {
      const st = await fs.promises.stat(folderAbs)
      if (!st.isDirectory()) return c.json({ success: false, error: 'Target folder not found' }, 404)
    } catch {
      return c.json({ success: false, error: 'Target folder not found' }, 404)
    }

    // Collect the uploaded blobs (plain string fields are ignored). typeof
    // narrowing keeps this independent of which File declaration wins.
    const inputFiles: File[] = []
    for (const entry of formData.getAll('files')) {
      if (typeof entry === 'string') continue
      inputFiles.push(entry)
    }
    if (inputFiles.length === 0) {
      return c.json({ success: false, error: 'No files provided' }, 400)
    }
    // Reject oversized uploads up-front with a clear 413 (nothing is written).
    for (const file of inputFiles) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json({ success: false, error: `File "${file.name}" exceeds the 512MB upload limit` }, 413)
      }
    }

    const bucket = folderParts[0]
    const isSystem = SYSTEM_DIRS.has(bucket)
    const uploaded: { name: string; storagePath: string; size: number; url: string | null; tracked: boolean }[] = []
    const skipped: { name: string; reason: string }[] = []

    for (const file of inputFiles) {
      try {
        const safeName = sanitizeUploadName(file.name)
        const { abs, finalName } = await uniqueUploadTarget(folderAbs, safeName)
        const buf = Buffer.from(await file.arrayBuffer())
        await fs.promises.writeFile(abs, buf)
        const rel = [...folderParts, finalName].join('/')
        // Track non-system buckets in FileAsset (system dirs never have rows).
        if (!isSystem) {
          try {
            await db.fileAsset.create({
              data: {
                deviceFileId: `srv-${randomUUID()}`,
                bucket,
                storagePath: rel,
                originalName: file.name || finalName,
                mimeType: file.type || downloadMime(finalName),
                size: buf.length,
                url: publicFilePathForStoragePath(rel) ?? '',
              },
            })
          } catch { /* row is best-effort — the file is on disk regardless */ }
        }
        uploaded.push({ name: finalName, storagePath: rel, size: buf.length, url: publicFilePathForStoragePath(rel), tracked: !isSystem })
      } catch {
        skipped.push({ name: file.name || 'file', reason: 'Could not be written' })
      }
    }

    return c.json({ success: true, uploaded, skipped })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

function insideRoot(resolved: string): boolean {
  const root = path.resolve(STORAGE_ROOT)
  return resolved === root || resolved.startsWith(root + path.sep)
}

/**
 * Manager-scoped resolver: like lib/storage.resolveRelativeStoragePath but
 * accepts ANY safe filename (stray/legacy/system files included) instead of
 * only the canonical <ts13>-<hex8>.<ext> shape. Every path segment is
 * validated and the resolved absolute path MUST stay inside STORAGE_ROOT —
 * traversal protection is never relaxed.
 *
 * GENERIC FOLDER MODEL: 2..6 segments (bucket + up to 4 folder levels +
 * filename). The bucket is a known system dir or any FOLDER_NAME_RE name
 * (a superset of SAFE_TYPE_RE); intermediate segments use FOLDER_NAME_RE —
 * a superset of YEAR_RE / MONTH_RE / GROUP_NAME_RE, so legacy
 * bucket/yyyy/mm/group layouts keep resolving unchanged.
 */
const MANAGER_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/
function resolveManagerPath(storagePath: string): string | null {
  const normalized = storagePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length < 2 || parts.length > MAX_PATH_DEPTH + 1) return null
  const [bucket, ...rest] = parts
  if (!isValidBucketSegment(bucket)) return null
  if (rest.some((p) => p === '.' || p === '..')) return null
  const file = rest[rest.length - 1]
  if (!MANAGER_FILENAME_RE.test(file) || file.includes('..')) return null
  for (const seg of rest.slice(0, -1)) {
    // Any folder level (year/month/group names still pass — superset rule)
    if (!isValidFolderSegment(seg)) return null
  }
  const resolved = path.resolve(path.join(STORAGE_ROOT, ...parts))
  return insideRoot(resolved) ? resolved : null
}

/**
 * FOLDER-path resolver (no file tail): '' resolves to STORAGE_ROOT itself,
 * otherwise 1..MAX_PATH_DEPTH segments with the same per-segment rules.
 */
function resolveManagerFolderPath(folderPath: string): string | null {
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return path.resolve(STORAGE_ROOT)
  if (parts.length > MAX_PATH_DEPTH) return null
  if (!isValidBucketSegment(parts[0])) return null
  if (!parts.slice(1).every(isValidFolderSegment)) return null
  const resolved = path.resolve(path.join(STORAGE_ROOT, ...parts))
  return insideRoot(resolved) ? resolved : null
}

// ─── GET /file?path=... ─────────────────────────────────────────────────────

app.get('/file', async (c) => {
  try {
    await requireAdmin(c)
    const storagePath = c.req.query('path') || ''
    const abs = resolveManagerPath(storagePath)
    if (!abs) return c.json({ success: false, error: 'Invalid storage path' }, 400)
    const st = await fs.promises.stat(abs).catch(() => null)
    if (!st || !st.isFile()) return c.json({ success: false, error: 'File not found on disk' }, 404)
    const row = await db.fileAsset.findFirst({ where: { storagePath } })
    return c.json({
      storagePath,
      url: publicFilePathForStoragePath(storagePath),
      disk: { size: st.size, mtimeMs: st.mtimeMs, createdAtMs: st.birthtimeMs },
      db: row
        ? { id: row.id, deviceFileId: row.deviceFileId, bucket: row.bucket, originalName: row.originalName, mimeType: row.mimeType, size: row.size, checksum: row.checksum, url: row.url, ownerId: row.ownerId, agencyId: row.agencyId, syncState: row.syncState, createdAt: row.createdAt, deletedAt: row.deletedAt }
        : null,
    })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /download?path=... — stream a file as an attachment (SUPER_ADMIN) ──
//
// Manager counterpart of the public /api/upload/file/* capability URLs: the
// public route serves Content-Disposition: INLINE (previews must open in the
// browser), while admins explicitly asked for a forced DOWNLOAD per file.
// Streaming pattern mirrors app-versions.ts /:id/download:
//   • fs.createReadStream → Web ReadableStream (constant ~64KB chunks — a
//     155 MB installer never buffers in RAM),
//   • Content-Length from stat, Accept-Ranges + single-range 206 (resumable),
//   • weak ETag (size+mtime) + 304 support,
//   • Content-Disposition: attachment; RFC 5987 filename* for unicode names.
// Auth: requireAdmin (same as every other /api/admin/storage route). Browsers
// follow plain <a href> links with the session cookie; native shells download
// via fetch + Bearer (both are accepted by requireAdmin).

const DL_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  txt: 'text/plain', json: 'application/json', csv: 'text/csv', xml: 'application/xml',
  html: 'text/html', md: 'text/markdown', log: 'text/plain',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  exe: 'application/vnd.microsoft.portable-executable',
  dmg: 'application/x-apple-diskimage', appimage: 'application/x-executable',
  deb: 'application/vnd.debian.binary-package', rpm: 'application/x-rpm',
}

function downloadMime(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return DL_MIME_BY_EXT[ext] || 'application/octet-stream'
}

/** RFC 6266/5987 header pair — ASCII fallback + UTF-8 encoded form. */
function contentDispositionFor(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  const utf8 = encodeURIComponent(name)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

app.get('/download', async (c) => {
  try {
    await requireAdmin(c)
    const storagePath = c.req.query('path') || ''
    const abs = resolveManagerPath(storagePath)
    if (!abs) return c.json({ success: false, error: 'Invalid storage path' }, 400)

    let fileStat: fs.Stats
    try {
      fileStat = fs.statSync(abs)
      if (!fileStat.isFile()) throw new Error('not a file')
    } catch {
      return c.json({ success: false, error: 'File not found on disk' }, 404)
    }

    const fileName = abs.split(path.sep).pop() || 'file'
    const fileSize = fileStat.size
    const etag = `W/"${fileSize.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`
    const baseHeaders: Record<string, string> = {
      'Content-Type': downloadMime(fileName),
      'Content-Disposition': contentDispositionFor(fileName),
      'Accept-Ranges': 'bytes',
      ETag: etag,
      // Short client cache — the manager may re-download after changes.
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    }

    // Conditional request on the full file → 304 (no body, no disk read).
    const ifNoneMatch = c.req.header('if-none-match')
    if (ifNoneMatch && !c.req.header('range')) {
      const matches = ifNoneMatch.split(',').map((t) => t.trim())
      if (matches.includes(etag) || matches.includes(etag.replace(/^W\//, '')) || ifNoneMatch.trim() === '*') {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': baseHeaders['Cache-Control']!, 'Accept-Ranges': 'bytes' },
        })
      }
    }

    // Single-range support (resumable downloads / preview players).
    const rangeHeader = c.req.header('range')
    let start = 0
    let end = fileSize - 1
    let status = 200
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          const suffix = Math.min(parseInt(m[2], 10), fileSize)
          start = Math.max(0, fileSize - suffix)
          end = fileSize - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] === '' ? fileSize - 1 : Math.min(parseInt(m[2], 10), fileSize - 1)
        }
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${fileSize}` } })
        }
        status = 206
      }
    }

    const contentLength = end - start + 1
    const headers: Record<string, string> = { ...baseHeaders, 'Content-Length': String(contentLength) }
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`
    }

    const nodeStream = fs.createReadStream(abs, { start, end })
    nodeStream.on('error', (err) => {
      console.error('[admin-storage] download stream error:', err.message)
      nodeStream.destroy()
    })
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
    return new Response(webStream, { status, headers })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /flat?bucket=... — recursive flat listing of one bucket ────────────
//
// Navigation upgrade for the manager UI: alongside the 3-level drill-down
// (bucket → year → month) there is now a FLAT view — every file of the bucket
// in ONE scrollable, sortable, searchable table (a folder column shows where
// each file lives). Reuses walkStorage()'s single recursive pass + the
// FileAsset tracked map. Sorted by mtime desc server-side; the client
// re-sorts/searches freely.

app.get('/flat', async (c) => {
  try {
    await requireAdmin(c)
    const bucket = c.req.query('bucket') || ''
    // Generic folder model: legacy buckets, system dirs AND arbitrary
    // admin-created buckets all flatten the same way.
    if (!isValidBucketSegment(bucket)) {
      return c.json({ success: false, error: 'Invalid bucket' }, 400)
    }
    const bucketDir = path.join(STORAGE_ROOT, bucket)
    if (!insideRoot(bucketDir)) return c.json({ success: false, error: 'Invalid bucket' }, 400)
    try {
      const st = await fs.promises.stat(bucketDir)
      if (!st.isDirectory()) return c.json({ success: false, error: 'Bucket not found' }, 404)
    } catch {
      return c.json({ success: false, error: 'Bucket not found' }, 404)
    }

    const [walk, tracked] = await Promise.all([walkStorage(), loadTrackedMap()])
    const files = walk.files
      .filter((f) => f.bucket === bucket)
      .map((f) => ({
        name: f.name,
        storagePath: f.rel,
        folder: f.mm && f.yyyy ? `${f.yyyy}/${f.mm}` : f.yyyy ? f.yyyy : '',
        size: f.size,
        mtimeMs: f.mtimeMs,
        url: publicFilePathForStoragePath(f.rel),
        tracked: tracked.has(f.rel),
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    return c.json({ bucket, files, walkErrors: walk.errors })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── DELETE /file { storagePath } ───────────────────────────────────────────

app.delete('/file', async (c) => {
  try {
    await requireAdmin(c)
    let body: { storagePath?: string } = {}
    try {
      body = await c.req.json()
    } catch { /* empty body */ }
    const storagePath = (body.storagePath || '').trim()
    const abs = resolveManagerPath(storagePath)
    if (!abs) return c.json({ success: false, error: 'Invalid storage path' }, 400)
    if (!insideRoot(path.resolve(abs))) return c.json({ success: false, error: 'Invalid storage path' }, 400)

    const existed = await fileExists(abs)
    // abs already came from resolveManagerPath (validated + inside STORAGE_ROOT),
    // so unlink directly — lib/storage.deleteByStoragePath would re-apply its
    // stricter canonical-name guard and reject stray/legacy files.
    let unlinked = false
    if (existed) {
      try {
        await fs.promises.unlink(abs)
        unlinked = true
      } catch {
        unlinked = false
      }
    }
    // Tombstone any FileAsset row (never hard delete — desktop sync relies on tombstones).
    let dbUpdated = 0
    try {
      const res = await db.fileAsset.updateMany({ where: { storagePath, deletedAt: null }, data: { deletedAt: new Date() } })
      dbUpdated = res.count
    } catch { /* row may not exist */ }
    // Cascade (this round): an AppVersion record that PUBLISHES this exact
    // file must not outlive it — deactivate it so the platform falls back to
    // "available"/draft in Public Apps Settings, while the live installer
    // tracker keeps listing sibling same-name builds (they are distinct
    // files with different push date/time and/or byte size). Identity is the
    // full storage key (name + embedded push timestamp), so ONLY the deleted
    // occurrence is deactivated — never its same-name siblings.
    let appVersionsDeactivated = 0
    const deletedBucket = storagePath.split('/')[0] || ''
    if (unlinked && deletedBucket === 'app-versions') {
      try {
        // PATH-CONVENTION NORMALIZATION: the storage manager addresses files
        // relative to STORAGE_ROOT ("app-versions/<key>") while
        // AppVersion.fileStorageKey is relative to the app-versions bucket
        // itself ("<key>" — e.g. "desktop/<file>" or flat legacy names).
        // Strip the bucket prefix or the cascade would never match.
        const avKey = storagePath.slice('app-versions/'.length)
        const res = await db.appVersion.updateMany({
          where: { fileStorageKey: avKey, isPublished: true },
          data: { isPublished: false, publishedAt: null },
        })
        appVersionsDeactivated = res.count
      } catch { /* no rows / table unavailable — tracker self-corrects via key match */ }
    }
    // Task 2-c-2 — cache-tag invalidation after the mutation: deleting an
    // app-versions installer changes what the CACHED public listing
    // /api/app-versions/public/active (60s TTL, tag 'app-versions') reports
    // (file size/availability), so drop those entries immediately.
    if ((unlinked || dbUpdated > 0) && deletedBucket === 'app-versions') {
      invalidateResponseCacheTag('app-versions')
    }
    return c.json({ success: true, existed, unlinked, dbTombstoned: dbUpdated, appVersionsDeactivated })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /rename { storagePath, newName } ──────────────────────────────────
//
// Renames ONE managed file IN PLACE (same directory — bare filename only, no
// cross-directory moves, so bucket semantics stay intact). Downstream
// bookkeeping follows the rename:
//   • FileAsset rows referencing the old storage path are repointed (never
//     tombstoned — the file still exists, desktop sync must converge).
//   • AppVersion rows in the app-versions bucket are repointed too — renaming
//     the CURRENTLY ACTIVE installer keeps it active under its new name
//     (identity travels with the file), and the 'app-versions' cache tag is
//     dropped so the live tracker + public active listing re-read at once.
app.post('/rename', async (c) => {
  try {
    await requireAdmin(c)
    let body: { storagePath?: string; newName?: string } = {}
    try {
      body = await c.req.json()
    } catch { /* empty body */ }
    const storagePath = (body.storagePath || '').trim()
    const newName = (body.newName || '').trim()
    if (!storagePath) return c.json({ success: false, error: 'storagePath is required' }, 400)
    // Bare filename only: no separators, no dot-names, sane length.
    if (!newName || /[\\/]/.test(newName) || newName === '.' || newName === '..') {
      return c.json({ success: false, error: 'Invalid new name' }, 400)
    }
    if (newName.length > 255) return c.json({ success: false, error: 'Name too long' }, 400)

    const abs = resolveManagerPath(storagePath)
    if (!abs) return c.json({ success: false, error: 'Invalid storage path' }, 400)
    if (!insideRoot(path.resolve(abs))) return c.json({ success: false, error: 'Invalid storage path' }, 400)

    const existed = await fileExists(abs)
    if (!existed) return c.json({ success: false, error: 'File not found' }, 404)

    const targetAbs = path.join(path.dirname(abs), newName)
    if (!insideRoot(path.resolve(targetAbs))) return c.json({ success: false, error: 'Invalid target path' }, 400)
    if (path.resolve(targetAbs) === path.resolve(abs)) {
      return c.json({ success: false, error: 'Name unchanged' }, 400)
    }
    if (await fileExists(targetAbs)) {
      return c.json({ success: false, error: 'A file with this name already exists in this folder' }, 409)
    }

    await fs.promises.rename(abs, targetAbs)

    // Same-directory rename → the relative path changes only in its tail.
    const normalized = storagePath.replace(/\\/g, '/')
    const slashIdx = normalized.lastIndexOf('/')
    const newStoragePath = slashIdx === -1 ? newName : `${normalized.slice(0, slashIdx + 1)}${newName}`

    // Repoint FileAsset rows (file still exists — NOT a tombstone).
    let fileAssetRows = 0
    try {
      const res = await db.fileAsset.updateMany({
        where: { storagePath, deletedAt: null },
        data: { storagePath: newStoragePath, originalName: newName },
      })
      fileAssetRows = res.count
    } catch { /* no rows for stray/legacy files */ }

    // Repoint AppVersion rows (renaming the ACTIVE installer keeps it
    // published under the new name — identity = exact storage key).
    // Same path-convention normalization as the delete cascade above:
    // AppVersion.fileStorageKey is relative to the app-versions bucket.
    let appVersionsRepointed = 0
    const bucket = storagePath.split('/')[0] || ''
    if (bucket === 'app-versions') {
      const avKey = storagePath.slice('app-versions/'.length)
      const avKeyNew = newStoragePath.slice('app-versions/'.length)
      try {
        const res = await db.appVersion.updateMany({
          where: { fileStorageKey: avKey },
          data: { fileStorageKey: avKeyNew, fileName: newName },
        })
        appVersionsRepointed = res.count
      } catch { /* no linked rows */ }
      // The live tracker + public active listing derive from this bucket —
      // refresh their cache entries.
      invalidateResponseCacheTag('app-versions')
    }

    return c.json({ success: true, storagePath: newStoragePath, fileAssetRows, appVersionsRepointed })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /move { storagePath, targetFolder } — move a file ─────────────────
//
// Moves ONE managed file to another EXISTING folder (cross-bucket allowed;
// the filename travels unchanged; NEVER overwrites — 409 on conflict).
// Downstream bookkeeping follows the move:
//   • FileAsset rows referencing the old storage path are repointed (never
//     tombstoned — the file still exists) including their bucket + URL.
//   • AppVersion rows in the app-versions bucket are repointed the same way
//     as POST /rename (same path-convention normalization: AppVersion
//     .fileStorageKey is relative to the app-versions BUCKET):
//       - WITHIN app-versions: repoint; an ACTIVE installer stays active
//         (identity travels with the file).
//       - OUT of app-versions: the installer is no longer servable from the
//         public route — deactivate it (isPublished:false, publishedAt:null),
//         same cascade shape as DELETE /file.
//       - INTO app-versions: repoint rows referencing the old (outside)
//         path; isPublished is NOT preserved (the source was outside).
//   • The 'app-versions' response-cache tag is dropped when either side of
//     the move touches that bucket.
app.post('/move', async (c) => {
  try {
    await requireAdmin(c)
    let body: { storagePath?: string; targetFolder?: string } = {}
    try {
      body = await c.req.json()
    } catch { /* empty body */ }
    const storagePath = (body.storagePath || '').trim()
    const targetFolder = (body.targetFolder || '').trim()
    if (!storagePath) return c.json({ success: false, error: 'storagePath is required' }, 400)
    // Files always live inside a bucket — moving INTO the storage root is invalid.
    if (!targetFolder) return c.json({ success: false, error: 'targetFolder is required' }, 400)

    const sourceAbs = resolveManagerPath(storagePath)
    if (!sourceAbs) return c.json({ success: false, error: 'Invalid storage path' }, 400)
    if (!insideRoot(path.resolve(sourceAbs))) return c.json({ success: false, error: 'Invalid storage path' }, 400)

    const targetFolderAbs = resolveManagerFolderPath(targetFolder)
    if (!targetFolderAbs) return c.json({ success: false, error: 'Invalid target folder' }, 400)
    try {
      const st = await fs.promises.stat(targetFolderAbs)
      if (!st.isDirectory()) return c.json({ success: false, error: 'Target folder not found' }, 404)
    } catch {
      return c.json({ success: false, error: 'Target folder not found' }, 404)
    }

    let sourceStat: fs.Stats
    try {
      sourceStat = await fs.promises.stat(sourceAbs)
      if (!sourceStat.isFile()) throw new Error('not a file')
    } catch {
      return c.json({ success: false, error: 'File not found' }, 404)
    }

    const fileName = sourceAbs.split(path.sep).pop() || ''
    const targetAbs = path.join(targetFolderAbs, fileName)
    if (!insideRoot(path.resolve(targetAbs))) return c.json({ success: false, error: 'Invalid target path' }, 400)
    if (path.resolve(targetAbs) === path.resolve(sourceAbs)) {
      return c.json({ success: false, error: 'File is already in this folder' }, 400)
    }
    if (await fileExists(targetAbs)) {
      return c.json({ success: false, error: 'A file with this name already exists in the target folder' }, 409)
    }

    await fs.promises.rename(sourceAbs, targetAbs)

    const normalizedSource = storagePath.replace(/\\/g, '/')
    const sourceParts = normalizedSource.split('/').filter(Boolean)
    const sourceBucket = sourceParts[0] || ''
    const targetParts = targetFolder.replace(/\\/g, '/').split('/').filter(Boolean)
    const targetBucket = targetParts[0] || ''
    const newRel = [...targetParts, fileName].join('/')

    // Repoint FileAsset rows (file still exists — NOT a tombstone): the
    // relative path, the public URL and the bucket all follow the move.
    // originalName stays untouched (the client-facing name did not change).
    let fileAssetRows = 0
    try {
      const res = await db.fileAsset.updateMany({
        where: { storagePath: normalizedSource, deletedAt: null },
        data: {
          storagePath: newRel,
          url: publicFilePathForStoragePath(newRel) || undefined,
          bucket: targetBucket,
        },
      })
      fileAssetRows = res.count
    } catch { /* no rows for stray/legacy/system files */ }

    // AppVersion bookkeeping — see the section comment for the three cases.
    let appVersionsRepointed = 0
    let appVersionsDeactivated = 0
    if (sourceBucket === 'app-versions' || targetBucket === 'app-versions') {
      const avOld = sourceBucket === 'app-versions' ? normalizedSource.slice('app-versions/'.length) : null
      const avNew = targetBucket === 'app-versions' ? newRel.slice('app-versions/'.length) : null
      try {
        if (avOld && avNew) {
          // WITHIN the bucket — repoint; isPublished preserved.
          const res = await db.appVersion.updateMany({
            where: { fileStorageKey: avOld },
            data: { fileStorageKey: avNew },
          })
          appVersionsRepointed = res.count
        } else if (avOld && !avNew) {
          // OUT of the bucket — the installer can no longer be served;
          // deactivate (avNew is undefined → fileStorageKey untouched, the
          // same shape as the DELETE /file cascade).
          const res = await db.appVersion.updateMany({
            where: { fileStorageKey: avOld },
            data: { fileStorageKey: avNew ?? undefined, isPublished: false, publishedAt: null },
          })
          appVersionsRepointed = res.count
          appVersionsDeactivated = res.count
        } else {
          // INTO the bucket — repoint rows that referenced the outside path
          // (rare; isPublished is NOT preserved per the section comment).
          const res = await db.appVersion.updateMany({
            where: { fileStorageKey: normalizedSource },
            data: { fileStorageKey: avNew as string },
          })
          appVersionsRepointed = res.count
        }
      } catch { /* no rows / table unavailable — tracker self-corrects */ }
      // The live tracker + public active listing derive from this bucket —
      // refresh their cache entries.
      invalidateResponseCacheTag('app-versions')
    }

    return c.json({ success: true, storagePath: newRel, fileAssetRows, appVersionsRepointed, appVersionsDeactivated })
  } catch (e) {
    const err = authErrorResponse(e)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

export { app as adminStorageRoutes }
