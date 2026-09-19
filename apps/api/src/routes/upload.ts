import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { enforceRateLimit, isRateLimitError, rateLimitErrorResponse, recordFailedRequest } from '../lib/rate-limit'

/**
 * Task 23: REAL file storage for the cloud API.
 *
 * History: this route was a placeholder that only echoed file metadata and
 * never stored anything — while the web app's use-upload hook expected a
 * `{ url }` response. Combined with the hook's raw relative XHR (which never
 * reached this service at all), profile-image upload at registration was
 * completely broken ("invalid response from the server").
 *
 * Now: files are stored on local disk under <cwd>/uploads/<type>/ and served
 * back through GET /api/upload/file/:type/:name with an ABSOLUTE url so the
 * avatar renders on every client (web :3000, desktop static export, mobile)
 * regardless of its own origin.
 */
const app = new Hono()

// ─── Storage layout ─────────────────────────────────────────────────────────

const STORAGE_ROOT = path.join(process.cwd(), 'uploads')

/** Sub-directories accepted in the `type` form field (also URL segments). */
const STORAGE_TYPES = new Set(['general', 'avatar', 'logo', 'receipt'])

/** Per-type upload size limits (bytes). */
const TYPE_MAX_BYTES: Record<string, number> = {
  avatar: 2 * 1024 * 1024,
  logo: 2 * 1024 * 1024,
  receipt: 5 * 1024 * 1024,
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

/** Safe filename shape produced by this route: <timestamp>-<uuid8>.<ext> */
const SAFE_FILENAME_RE = /^\d{13}-[a-f0-9]{8}\.[a-z0-9]{2,5}$/
const SAFE_TYPE_RE = /^[a-z][a-z0-9-]{0,23}$/

function resolveStoragePath(type: string, filename: string): string | null {
  if (!SAFE_TYPE_RE.test(type) || !STORAGE_TYPES.has(type)) return null
  if (!SAFE_FILENAME_RE.test(filename)) return null
  const dir = path.join(STORAGE_ROOT, type)
  const resolved = path.resolve(dir, filename)
  // Defense in depth — the regexes above already forbid traversal segments.
  if (!resolved.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) return null
  return resolved
}

// ─── POST /api/upload — store a file (authenticated) ────────────────────────

app.post('/', async (c) => {
  let clientIp: string | undefined
  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const rawType = ((formData.get('type') as string) || 'general').trim().toLowerCase()
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
    if (type === 'avatar') {
      clientIp = enforceRateLimit(c, UPLOAD_RATE_LIMIT)
      if (!PUBLIC_AVATAR_EXTENSIONS.has(ext)) {
        return c.json({ success: false, error: `Invalid image type ".${ext}" — allowed: ${[...PUBLIC_AVATAR_EXTENSIONS].join(', ')}` }, 400)
      }
    } else {
      await requireAuth(c)
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        return c.json({ success: false, error: `Invalid file type ".${ext}" — allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` }, 400)
      }
    }

    const maxBytes = TYPE_MAX_BYTES[type] ?? DEFAULT_MAX_BYTES
    if (file.size > maxBytes) {
      return c.json({ success: false, error: `File too large — max ${Math.round(maxBytes / 1024 / 1024)}MB` }, 400)
    }

    // Never trust the client filename — generate an unguessable one.
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
    const dir = path.join(STORAGE_ROOT, type)
    await fs.promises.mkdir(dir, { recursive: true })
    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.promises.writeFile(path.join(dir, filename), buffer)

    // Absolute URL (built from the request origin) so every client — web,
    // desktop static export, mobile — can render the file regardless of its
    // own origin.
    const origin = new URL(c.req.url).origin
    const url = `${origin}/api/upload/file/${type}/${filename}`

    return c.json({
      success: true,
      url,
      filename,
      provider: 'local',
      size: file.size,
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

app.get('/file/:type/:name', async (c) => {
  const type = c.req.param('type')
  const name = c.req.param('name')
  const filePath = resolveStoragePath(type, name)

  if (!filePath) {
    return c.json({ success: false, error: 'Invalid file path' }, 400)
  }

  try {
    const data = await fs.promises.readFile(filePath)
    const ext = (name.split('.').pop() || '').toLowerCase()
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Disposition': 'inline',
      },
    })
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

    // New canonical shape: …/api/upload/file/<type>/<name>
    const match = url.match(/\/api\/upload\/file\/([a-z0-9-]+)\/([a-zA-Z0-9._-]+)$/)
    if (match) {
      const filePath = resolveStoragePath(match[1], match[2])
      if (!filePath) {
        return c.json({ success: false, error: 'Invalid file URL' }, 400)
      }
      try {
        await fs.promises.unlink(filePath)
        return c.json({ success: true, message: 'File deleted' })
      } catch {
        return c.json({ success: true, message: 'File not found — already deleted' })
      }
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
