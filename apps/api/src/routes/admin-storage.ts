/**
 * @blasti/api — Storage Manager Routes (SUPER_ADMIN only)
 *
 * Backs the admin sidebar "Database and Storage Management → Storage Manager"
 * page. The cloud API's central file store lives under STORAGE_ROOT
 * (apps/api/src/lib/storage.ts): one folder per category ("bucket"),
 * month-split inside each bucket:
 *
 *   <STORAGE_ROOT>/
 *     avatar/<yyyy>/<mm>/<ts>-<rand8>.<ext>     → user profile pictures
 *     logo/<yyyy>/<mm>/...                      → agency logos & covers
 *     receipt/<yyyy>/<mm>/...                   → payment receipts / invoices
 *     document/<yyyy>/<mm>/...                  → documents (pdf, docs, ...)
 *     general/<yyyy>/<mm>/...                   → general uploads
 *     app-binary/<name>                         → desktop-synced app binaries
 *     app-versions/<platform>-<version>-...     → app version downloads
 *
 * Endpoints (every route requires SUPER_ADMIN):
 *
 *   GET    /overview              → disk usage at STORAGE_ROOT + totals +
 *                                   per-category breakdown + integrity counts
 *   GET    /browse?bucket&yyyy&mm → path-tracked folder listing (months when
 *                                   no mm given, files when yyyy+mm given)
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
 *
 * SAFETY MODEL
 *   - Every route requires SUPER_ADMIN (requireAdmin) + authErrorResponse.
 *   - Bucket names must match SAFE_TYPE_RE (or be a known system dir);
 *     relative paths are resolved through resolveManagerPath below —
 *     traversal-hardened (segments validated, result must stay inside
 *     STORAGE_ROOT) but WITHOUT the strict canonical-filename guard of
 *     lib/storage.ts, so the manager can also inspect/delete stray or
 *     legacy files that were written to disk outside the upload pipeline.
 *   - Deletes ONLY touch files inside STORAGE_ROOT and tombstone (never
 *     hard-delete) the FileAsset row, so desktop sync converges cleanly.
 */

import { Hono } from 'hono'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { invalidateResponseCacheTag } from '../lib/response-cache'
import {
  STORAGE_ROOT,
  SAFE_TYPE_RE,
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
 * Group folder inside a SYSTEM bucket (e.g. app-versions/desktop,
 * app-versions/mobile — the installer split). Lowercase-first so it can never
 * collide with the numeric YEAR_RE / MONTH_RE segments.
 */
const GROUP_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/

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
 * Walk the whole storage tree once. Returns every regular file grouped with
 * its parsed location. Legacy flat files (bucket/<name>) have mm=''.
 */
async function walkStorage(): Promise<{ files: WalkedFile[]; errors: number }> {
  const files: WalkedFile[] = []
  let errors = 0
  const dirs = await listStorageDirs()
  for (const bucket of dirs) {
    const bucketDir = path.join(STORAGE_ROOT, bucket)
    let level1: fs.Dirent[]
    try {
      level1 = await fs.promises.readdir(bucketDir, { withFileTypes: true })
    } catch {
      errors++
      continue
    }
    const months = level1.filter((e) => e.isDirectory() && YEAR_RE.test(e.name))
    const flatFiles = level1.filter((e) => e.isFile())
    // Group folders (SYSTEM buckets only): bucket/<group>/<name>
    // e.g. app-versions/desktop/BLASTI-Setup-0.3.4.exe (CI-uploaded installers).
    const groups = SYSTEM_DIRS.has(bucket)
      ? level1.filter((e) => e.isDirectory() && !YEAR_RE.test(e.name) && GROUP_NAME_RE.test(e.name))
      : []
    for (const groupDir of groups) {
      const group = groupDir.name
      const dir = path.join(bucketDir, group)
      let names: fs.Dirent[]
      try {
        names = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        errors++
        continue
      }
      for (const f of names.filter((e) => e.isFile())) {
        try {
          const st = await fs.promises.stat(path.join(dir, f.name))
          files.push({ rel: `${bucket}/${group}/${f.name}`, bucket, yyyy: group, mm: '', name: f.name, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          errors++
        }
      }
    }
    // Month-split files: bucket/<yyyy>/<mm>/<name>
    for (const yearDir of months) {
      const yyyy = yearDir.name
      let monthDirs: fs.Dirent[]
      try {
        monthDirs = await fs.promises.readdir(path.join(bucketDir, yyyy), { withFileTypes: true })
      } catch {
        errors++
        continue
      }
      for (const monthDir of monthDirs.filter((e) => e.isDirectory() && MONTH_RE.test(e.name))) {
        const mm = monthDir.name
        const dir = path.join(bucketDir, yyyy, mm)
        let names: fs.Dirent[]
        try {
          names = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          errors++
          continue
        }
        for (const f of names.filter((e) => e.isFile())) {
          try {
            const st = await fs.promises.stat(path.join(dir, f.name))
            files.push({ rel: `${bucket}/${yyyy}/${mm}/${f.name}`, bucket, yyyy, mm, name: f.name, size: st.size, mtimeMs: st.mtimeMs })
          } catch {
            errors++
          }
        }
      }
    }
    // Legacy flat files: bucket/<name>
    for (const f of flatFiles) {
      try {
        const st = await fs.promises.stat(path.join(bucketDir, f.name))
        files.push({ rel: `${bucket}/${f.name}`, bucket, yyyy: '', mm: '', name: f.name, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        errors++
      }
    }
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

// ─── GET /browse ────────────────────────────────────────────────────────────

app.get('/browse', async (c) => {
  try {
    await requireAdmin(c)
    const bucket = c.req.query('bucket') || ''
    const yyyy = c.req.query('yyyy') || ''
    const mm = c.req.query('mm') || ''
    if (!SAFE_TYPE_RE.test(bucket)) return c.json({ success: false, error: 'Invalid bucket' }, 400)

    const bucketDir = path.join(STORAGE_ROOT, bucket)
    if (!insideRoot(bucketDir)) return c.json({ success: false, error: 'Invalid bucket' }, 400)
    try {
      const st = await fs.promises.stat(bucketDir)
      if (!st.isDirectory()) return c.json({ success: false, error: 'Bucket not found' }, 404)
    } catch {
      return c.json({ success: false, error: 'Bucket not found' }, 404)
    }

    // Level 1: list years of the bucket
    if (!yyyy) {
      const entries = await fs.promises.readdir(bucketDir, { withFileTypes: true })
      const years = [] as { yyyy: string; folders: number; files: number; bytes: number }[]
      const groups = [] as { group: string; files: number; bytes: number }[]
      const flats = [] as { name: string; size: number; mtimeMs: number; storagePath: string; url: string | null; tracked: boolean }[]
      for (const e of entries.filter((x) => x.isDirectory() && YEAR_RE.test(x.name))) {
        const yyyyDir = path.join(bucketDir, e.name)
        let months: fs.Dirent[] = []
        try {
          months = await fs.promises.readdir(yyyyDir, { withFileTypes: true })
        } catch { /* year counted as empty */ }
        let files = 0
        let bytes = 0
        for (const m of months.filter((x) => x.isDirectory() && MONTH_RE.test(x.name))) {
          try {
            const fstats = await fs.promises.readdir(path.join(yyyyDir, m.name), { withFileTypes: true })
            for (const f of fstats.filter((x) => x.isFile())) {
              try {
                const st = await fs.promises.stat(path.join(yyyyDir, m.name, f.name))
                files++
                bytes += st.size
              } catch { /* raced */ }
            }
          } catch { /* raced */ }
        }
        years.push({ yyyy: e.name, folders: months.filter((x) => x.isDirectory() && MONTH_RE.test(x.name)).length, files, bytes })
      }
      // Group folders (system buckets, e.g. app-versions/desktop + /mobile)
      if (SYSTEM_DIRS.has(bucket)) {
        for (const e of entries.filter((x) => x.isDirectory() && !YEAR_RE.test(x.name) && GROUP_NAME_RE.test(x.name))) {
          let files = 0
          let bytes = 0
          try {
            const fstats = await fs.promises.readdir(path.join(bucketDir, e.name), { withFileTypes: true })
            for (const f of fstats.filter((x) => x.isFile())) {
              try {
                const st = await fs.promises.stat(path.join(bucketDir, e.name, f.name))
                files++
                bytes += st.size
              } catch { /* raced */ }
            }
          } catch { /* raced */ }
          groups.push({ group: e.name, files, bytes })
        }
      }
      const tracked = await loadTrackedMap()
      for (const e of entries.filter((x) => x.isFile())) {
        try {
          const st = await fs.promises.stat(path.join(bucketDir, e.name))
          const rel = `${bucket}/${e.name}`
          flats.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs, storagePath: rel, url: publicFilePathForStoragePath(rel), tracked: tracked.has(rel) })
        } catch { /* raced */ }
      }
      return c.json({ bucket, yyyy: null, years, groups, flatFiles: flats })
    }

    // Group folders (system buckets): bucket/<group> — list its files
    // directly (same response shape as a level-3 month listing, with mm='').
    if (!YEAR_RE.test(yyyy)) {
      if (!SYSTEM_DIRS.has(bucket) || !GROUP_NAME_RE.test(yyyy)) {
        return c.json({ success: false, error: 'Invalid year' }, 400)
      }
      if (mm) return c.json({ success: false, error: 'Invalid month' }, 400)
      const groupDir = path.join(bucketDir, yyyy)
      if (!insideRoot(groupDir)) return c.json({ success: false, error: 'Invalid path' }, 400)
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(groupDir, { withFileTypes: true })
      } catch {
        return c.json({ success: false, error: 'Folder not found' }, 404)
      }
      const tracked = await loadTrackedMap()
      const files = []
      for (const e of entries.filter((x) => x.isFile())) {
        try {
          const st = await fs.promises.stat(path.join(groupDir, e.name))
          const rel = `${bucket}/${yyyy}/${e.name}`
          files.push({
            name: e.name,
            size: st.size,
            mtimeMs: st.mtimeMs,
            storagePath: rel,
            url: publicFilePathForStoragePath(rel),
            tracked: tracked.has(rel),
            dbId: null,
            ownerId: null,
            agencyId: null,
            uploadedAt: null,
          })
        } catch { /* raced */ }
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return c.json({ bucket, yyyy, mm: '', files })
    }

    // Level 2: list months of the year
    if (!mm) {
      const yyyyDir = path.join(bucketDir, yyyy)
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(yyyyDir, { withFileTypes: true })
      } catch {
        return c.json({ success: false, error: 'Year not found' }, 404)
      }
      const months = [] as { mm: string; files: number; bytes: number }[]
      for (const e of entries.filter((x) => x.isDirectory() && MONTH_RE.test(x.name))) {
        let files = 0
        let bytes = 0
        try {
          const fstats = await fs.promises.readdir(path.join(yyyyDir, e.name), { withFileTypes: true })
          for (const f of fstats.filter((x) => x.isFile())) {
            try {
              const st = await fs.promises.stat(path.join(yyyyDir, e.name, f.name))
              files++
              bytes += st.size
            } catch { /* raced */ }
          }
        } catch { /* raced */ }
        months.push({ mm: e.name, files, bytes })
      }
      return c.json({ bucket, yyyy, months })
    }

    if (!MONTH_RE.test(mm)) return c.json({ success: false, error: 'Invalid month' }, 400)

    // Level 3: list files of the month
    const dir = path.join(bucketDir, yyyy, mm)
    if (!insideRoot(dir)) return c.json({ success: false, error: 'Invalid path' }, 400)
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return c.json({ success: false, error: 'Folder not found' }, 404)
    }
    const tracked = await loadTrackedMap()
    const files = []
    for (const e of entries.filter((x) => x.isFile())) {
      try {
        const st = await fs.promises.stat(path.join(dir, e.name))
        const rel = `${bucket}/${yyyy}/${mm}/${e.name}`
        const row = tracked.get(rel)
        files.push({
          name: e.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          storagePath: rel,
          url: publicFilePathForStoragePath(rel),
          tracked: !!row,
          dbId: row?.id ?? null,
          ownerId: row?.ownerId ?? null,
          agencyId: row?.agencyId ?? null,
          uploadedAt: row?.createdAt ?? null,
        })
      } catch { /* raced */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return c.json({ bucket, yyyy, mm, files })
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
 */
const MANAGER_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/
function resolveManagerPath(storagePath: string): string | null {
  const normalized = storagePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length < 2 || parts.length > 4) return null
  const [bucket, ...rest] = parts
  const bucketOk = SAFE_TYPE_RE.test(bucket) || SYSTEM_DIRS.has(bucket)
  if (!bucketOk) return null
  if (rest.some((p) => p === '.' || p === '..')) return null
  const file = rest[rest.length - 1]
  if (!MANAGER_FILENAME_RE.test(file) || file.includes('..')) return null
  for (const seg of rest.slice(0, -1)) {
    // Year, month, or group segment (system buckets, e.g. app-versions/desktop)
    if (!YEAR_RE.test(seg) && !MONTH_RE.test(seg) && !GROUP_NAME_RE.test(seg)) return null
  }
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
    if (!SAFE_TYPE_RE.test(bucket) && !SYSTEM_DIRS.has(bucket)) {
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

export { app as adminStorageRoutes }
