import { Hono } from 'hono'
import path from 'path'
import fs from 'fs'
import { requireAuth, getSessionUser, authErrorResponse } from '../lib/auth'
import { enforceRateLimit, isRateLimitError, rateLimitErrorResponse, recordFailedRequest } from '../lib/rate-limit'
import { createHash, randomUUID } from 'crypto'
import {
  STORAGE_TYPES,
  SAFE_TYPE_RE,
  SAFE_FILENAME_RE,
  resolveStoredPath,
  saveUpload,
  makeFilename,
  absoluteFileUrl,
  publicFilePath,
  storagePathFromUrl,
} from '../lib/storage'
import { db } from '@blasti/db'

/**
 * Cloud file storage route (Round 15 refactor).
 *
 * History: Task 23 turned this from an echo-placeholder into REAL disk
 * storage; Task 24 fixed the type resolution (form field first, then the
 * `?type=` query param every client sends). Round 15 moves the actual
 * filing decisions into lib/storage.ts (organized <bucket>/<yyyy>/<mm>/
 * layout, legacy flat fallback) and registers every upload in the FileAsset
 * table so the desktop file-sync and the storage audit have one registry.
 *
 * The response now carries BOTH the absolute `url` and the relative `path`
 * (`/api/upload/file/<bucket>/<yyyy>/<mm>/<name>`), plus the storagePath.
 */
const app = new Hono()

/** Per-type upload size limits (bytes). */
const TYPE_MAX_BYTES: Record<string, number> = {
  avatar: 2 * 1024 * 1024,
  logo: 2 * 1024 * 1024,
  receipt: 5 * 1024 * 1024,
  document: 10 * 1024 * 1024,
  general: 5 * 1024 * 1024,
}

/**
 * Rate limit for the PUBLIC avatar upload path (register flow — the account
 * does not exist yet, so there is no session to authenticate).
 */
const UPLOAD_RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  prefix: 'upload',
} as const

/**
 * Extensions allowed for the PUBLIC avatar path. Images only — SVG is
 * excluded (scriptable when served inline) and PDF is irrelevant for an
 * avatar. Authenticated types keep the full whitelist below.
 */
const PUBLIC_AVATAR_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

/** Extension → MIME + validation whitelist. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXT))

function mimeForFilename(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

// ─── POST /api/upload — store a file ────────────────────────────────────────

app.post('/', async (c) => {
  let clientIp: string | undefined
  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    // Task 24 fix (kept): the form field is authoritative when present, then
    // the `?type=` query param (what every current client sends), then general.
    const rawType = (
      (formData.get('type') as string | null) ||
      c.req.query('type') ||
      'general'
    ).trim().toLowerCase()
    const type = STORAGE_TYPES.has(rawType) && SAFE_TYPE_RE.test(rawType) ? rawType : 'general'

    if (!file || typeof file === 'string') {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    const ext = (file.name.split('.').pop() || '').toLowerCase()

    // ── Auth decision (Task 23) ─────────────────────────────────────────
    // Account creation uploads an avatar BEFORE the account exists (the
    // session is only issued after email+phone OTP verification), so the
    // avatar path is public but hard-restricted: strict per-IP rate limit,
    // images-only whitelist (no SVG/PDF), 2MB cap, random filenames.
    // Every other upload type stays authenticated.
    let ownerId: string | null = null
    let agencyId: string | null = null
    if (type === 'avatar') {
      clientIp = enforceRateLimit(c, UPLOAD_RATE_LIMIT)
      if (!PUBLIC_AVATAR_EXTENSIONS.has(ext)) {
        return c.json({ success: false, error: `Invalid image type ".${ext}" — allowed: ${[...PUBLIC_AVATAR_EXTENSIONS].join(', ')}` }, 400)
      }
      // Best-effort owner attribution — public path, so a missing session is fine.
      try {
        const maybeUser = await getSessionUser(c)
        if (maybeUser) {
          ownerId = maybeUser.id
          agencyId = maybeUser.agencyId ?? null
        }
      } catch { /* anonymous */ }
    } else {
      const user = await requireAuth(c)
      ownerId = user.id
      agencyId = user.agencyId ?? null
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return c.json({ success: false, error: `Invalid file type ".${ext}" — allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` }, 400)
      }
    }

    const maxBytes = TYPE_MAX_BYTES[type] ?? DEFAULT_MAX_BYTES
    if (file.size > maxBytes) {
      return c.json({ success: false, error: `File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB` }, 400)
    }

    // Never trust the client filename — generate an unguessable one.
    const filename = makeFilename(ext)
    const buffer = Buffer.from(await file.arrayBuffer())
    const saved = await saveUpload(type, buffer, filename)

    const checksum = createHash('sha256').update(buffer).digest('hex')
    const origin = new URL(c.req.url).origin
    const url = absoluteFileUrl(origin, type, saved.yyyy, saved.mm, filename)
    const filePath = publicFilePath(type, saved.yyyy, saved.mm, filename)

    // Register the file in the central FileAsset registry (best-effort —
    // the blob is already durably stored; a registry failure must not 500
    // a successful upload).
    const deviceFileId = `srv-${randomUUID()}`
    try {
      await db.fileAsset.create({
        data: {
          deviceFileId,
          bucket: type,
          storagePath: saved.storagePath,
          originalName: file.name.slice(0, 200),
          mimeType: file.type || mimeForFilename(filename),
          size: buffer.length,
          checksum,
          url,
          ownerId,
          agencyId,
        },
      })
    } catch (regErr) {
      console.warn('[upload] FileAsset registration failed:', (regErr as Error).message)
    }

    return c.json({
      success: true,
      url,
      path: filePath,
      filename,
      storagePath: saved.storagePath,
      deviceFileId,
      provider: 'local',
      size: buffer.length,
      type,
    })
  } catch (error: unknown) {
    if (isRateLimitError(error)) {
      if (clientIp) recordFailedRequest(clientIp)
      const res = rateLimitErrorResponse(error)
      return c.json(res.data, res.status as any)
    }
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /api/upload/file/:type/:name — serve a stored file (public) ───────
//
// Deliberately UNAUTHENTICATED: avatars/logos render through plain <img>
// tags which cannot attach Authorization headers. Filenames are unguessable
// (timestamp + random UUID slice), so the URLs act as capability links.
// Two shapes are served:
//   /file/<bucket>/<yyyy>/<mm>/<name>   (organized, Round 15+)
//   /file/<bucket>/<name>               (legacy flat, pre-Round 15)

function fileResponse(data: Buffer, name: string): Response {
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': mimeForFilename(name),
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': 'inline',
    },
  })
}

app.get('/file/:type/:yyyy/:mm/:name', async (c) => {
  const type = c.req.param('type')
  const yyyy = c.req.param('yyyy')
  const mm = c.req.param('mm')
  const name = c.req.param('name')
  if (!SAFE_TYPE_RE.test(type) || !/^\d{4}$/.test(yyyy) || !/^(0[1-9]|1[0-2])$/.test(mm) || !SAFE_FILENAME_RE.test(name)) {
    return c.json({ success: false, error: 'Invalid file path' }, 400)
  }
  const filePath = resolveStoredPath(type, `${yyyy}/${mm}/${name}`)
  if (!filePath) {
    return c.json({ success: false, error: 'Invalid file path' }, 400)
  }
  try {
    const data = await fs.promises.readFile(filePath)
    return fileResponse(data, name)
  } catch {
    return c.json({ success: false, error: 'File not found' }, 404)
  }
})

app.get('/file/:type/:name', async (c) => {
  const type = c.req.param('type')
  const name = c.req.param('name')
  const filePath = resolveStoredPath(type, name)

  if (!filePath) {
    return c.json({ success: false, error: 'Invalid file path' }, 400)
  }

  try {
    const data = await fs.promises.readFile(filePath)
    return fileResponse(data, name)
  } catch {
    return c.json({ success: false, error: 'File not found' }, 404)
  }
})

// ─── DELETE /api/upload — delete a stored file (authenticated) ──────────────

app.delete('/', async (c) => {
  try {
    await requireAuth(c)
    const body = await c.req.json().catch(() => ({}))
    const url = body?.url as string | undefined

    if (!url) {
      return c.json({ success: false, error: 'No URL provided' }, 400)
    }

    // Canonical + legacy shapes — anything the URL parser recognizes.
    const storagePath = storagePathFromUrl(url)
    if (storagePath) {
      const { deleteByStoragePath } = await import('../lib/storage')
      const deleted = await deleteByStoragePath(storagePath)
      // Tombstone + remove the registry row content reference (best-effort).
      try {
        await db.fileAsset.updateMany({
          where: { storagePath },
          data: { deletedAt: new Date() },
        })
      } catch { /* registry is best-effort here */ }
      if (deleted) {
        return c.json({ success: true, message: 'File deleted' })
      }
      return c.json({ success: true, message: 'File not found — already deleted' })
    }

    // Legacy shape (pre-Task-23 /uploads/... paths pointing at the web app's
    // public dir) — best effort, kept tolerant for old stored URLs.
    if (url.startsWith('/uploads/') || url.startsWith('/public/uploads/')) {
      const publicDir = path.join(process.cwd(), '..', 'web', 'public')
      const filePath = path.join(publicDir, url.startsWith('/public/') ? url.slice('/public'.length) : url)
      const resolved = path.resolve(filePath)
      if (!resolved.startsWith(path.resolve(publicDir))) {
        return c.json({ success: false, error: 'Access denied — path traversal blocked' }, 403)
      }
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved)
        return c.json({ success: true, message: 'File deleted' })
      }
      return c.json({ success: true, message: 'File not found — already deleted' })
    }

    return c.json({ success: false, error: 'Invalid file URL — only /api/upload/file/* paths are allowed' }, 400)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const uploadRoutes = app
