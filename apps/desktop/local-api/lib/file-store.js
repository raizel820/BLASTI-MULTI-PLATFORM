/**
 * BLASTI Desktop — Local FILE STORE (Round 15)
 * ═════════════════════════════════════════════════════════════════════════
 *
 * The desktop now keeps its OWN copy of every uploaded file (avatars, logos,
 * receipts, documents, …) under an organized on-disk layout:
 *
 *   <BLASTI_LOCAL_FILES_DIR>/
 *     avatar/<yyyy>/<mm>/<timestamp>-<rand8>.<ext>
 *     logo/<yyyy>/<mm>/...
 *     receipt/<yyyy>/<mm>/...
 *     document/<yyyy>/<mm>/...
 *     general/<yyyy>/<mm>/...
 *
 * Why: uploads used to be forwarded verbatim to the cloud, so (a) the
 * register-time avatar upload failed the moment the cloud was unreachable —
 * the reported "preview never shows an image" — and (b) the desktop held no
 * files at all. Now uploads land HERE first (instant preview, works
 * offline), the URL the client receives points at THIS local API
 * (http://127.0.0.1:3080/api/upload/file/…), and lib/file-sync.js mirrors
 * the files to the cloud storage (same bucket layout) as part of the sync
 * engine.
 *
 * main.js sets BLASTI_LOCAL_FILES_DIR under the Electron userData dir
 * (alongside blasti-local/ for the DB); the standalone default is
 * ~/.blasti/files.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// ─── Layout constants (mirror apps/api/src/lib/storage.ts) ─────────────────

const SAFE_TYPE_RE = /^[a-z][a-z0-9-]{0,23}$/
const SAFE_FILENAME_RE = /^\d{13}-[a-f0-9]{8}\.[a-z0-9]{2,5}$/
const YEAR_RE = /^\d{4}$/
const MONTH_RE = /^(0[1-9]|1[0-2])$/
const YEAR_MM_NAME_RE = /^(\d{4})\/(0[1-9]|1[0-2])\/(\d{13}-[a-f0-9]{8}\.[a-z0-9]{2,5})$/

function resolveFilesRoot() {
  return process.env.BLASTI_LOCAL_FILES_DIR
    ? path.resolve(process.env.BLASTI_LOCAL_FILES_DIR)
    : path.join(os.homedir(), '.blasti', 'files')
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Generate the canonical unguessable filename for a new upload. */
function makeFilename(ext) {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`
}

/**
 * Store bytes under <bucket>/<yyyy>/<mm>/<filename>.
 * @returns {{ filename, storagePath, absPath, yyyy, mm }}
 */
async function saveUpload(bucket, buffer, filename) {
  if (!SAFE_TYPE_RE.test(bucket)) throw new Error(`Invalid storage bucket "${bucket}"`)
  if (!SAFE_FILENAME_RE.test(filename)) throw new Error(`Invalid storage filename "${filename}"`)
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dir = path.join(resolveFilesRoot(), bucket, yyyy, mm)
  await fs.promises.mkdir(dir, { recursive: true })
  const absPath = path.join(dir, filename)
  await fs.promises.writeFile(absPath, buffer)
  return { filename, storagePath: `${bucket}/${yyyy}/${mm}/${filename}`, absPath, yyyy, mm }
}

/**
 * Resolve a "bucket/…" relative path (or "bucket/name" legacy flat shape)
 * to an absolute path inside the files root — traversal-hardened.
 * @returns absolute path or null
 */
function resolveRelativeStoragePath(storagePath) {
  if (typeof storagePath !== 'string') return null
  const normalized = storagePath.replace(/\\/g, '/')
  const cut = normalized.indexOf('/')
  if (cut <= 0) return null
  const bucket = normalized.slice(0, cut)
  const rest = normalized.slice(cut + 1)
  if (!SAFE_TYPE_RE.test(bucket)) return null

  const root = resolveFilesRoot()
  const organized = rest.match(YEAR_MM_NAME_RE)
  if (organized) {
    const resolved = path.resolve(root, bucket, organized[1], organized[2], organized[3])
    if (resolved.startsWith(root + path.sep)) return resolved
    return null
  }
  if (SAFE_FILENAME_RE.test(rest)) {
    const resolved = path.resolve(root, bucket, rest)
    if (resolved.startsWith(root + path.sep)) return resolved
  }
  return null
}

async function readByStoragePath(storagePath) {
  const abs = resolveRelativeStoragePath(storagePath)
  if (!abs) return null
  try {
    return await fs.promises.readFile(abs)
  } catch {
    return null
  }
}

async function deleteByStoragePath(storagePath) {
  const abs = resolveRelativeStoragePath(storagePath)
  if (!abs) return false
  try {
    await fs.promises.unlink(abs)
    return true
  } catch {
    return false
  }
}

/** Extract the storage-relative path from any file URL shape. */
function storagePathFromUrl(url) {
  if (!url || typeof url !== 'string') return null
  const match = url.match(/\/api\/upload\/file\/([a-z0-9-]+\/(?:\d{4}\/(?:0[1-9]|1[0-2])\/)?[a-zA-Z0-9._-]+)$/)
  return match ? match[1] : null
}

/** The URL path this local API serves the file under. */
function publicFilePath(storagePath) {
  return `/api/upload/file/${storagePath}`
}

/** Absolute local URL for a stored file, based on this API's request origin. */
function absoluteFileUrl(requestOrigin, storagePath) {
  return `${(requestOrigin || '').replace(/\/+$/, '')}${publicFilePath(storagePath)}`
}

/** File diagnostics for /api/db-status. */
function getStatus() {
  const root = resolveFilesRoot()
  let files = 0
  let bytes = 0
  try {
    for (const bucket of fs.readdirSync(root)) {
      const bucketDir = path.join(root, bucket)
      if (!fs.statSync(bucketDir).isDirectory()) continue
      for (const year of fs.readdirSync(bucketDir)) {
        const yearDir = path.join(bucketDir, year)
        if (!fs.statSync(yearDir).isDirectory()) continue
        for (const month of fs.readdirSync(yearDir)) {
          const monthDir = path.join(yearDir, month)
          if (!fs.statSync(monthDir).isDirectory()) continue
          for (const name of fs.readdirSync(monthDir)) {
            try {
              const st = fs.statSync(path.join(monthDir, name))
              if (st.isFile()) {
                files++
                bytes += st.size
              }
            } catch { /* raced file */ }
          }
        }
      }
    }
  } catch { /* root not created yet */ }
  return { root, files, bytes }
}

module.exports = {
  makeFilename,
  saveUpload,
  resolveRelativeStoragePath,
  readByStoragePath,
  deleteByStoragePath,
  storagePathFromUrl,
  publicFilePath,
  absoluteFileUrl,
  getStatus,
  resolveFilesRoot,
}
