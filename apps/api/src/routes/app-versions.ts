import { Hono } from 'hono'
import type { Context } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { STORAGE_ROOT } from '../lib/storage'
import { z } from 'zod'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const app = new Hono()

// ─── Deploy-token auth (CI / automation) ────────────────────────────────────
//
// Installers can be uploaded not only by an admin in Public Apps Settings,
// but also by CI (GitHub Actions) using the shared DEPLOY_TOKEN from
// /etc/blasti/blasti.env. Requests with a valid `x-deploy-token` header
// bypass the admin session check; everyone else still needs an admin
// session. If no token is configured the header is simply ignored.

const DEPLOY_TOKEN = () => process.env.BLASTI_DEPLOY_TOKEN || process.env.DEPLOY_TOKEN || ''

async function requireAdminOrDeployToken(c: Context): Promise<void> {
  const expected = DEPLOY_TOKEN()
  const provided = c.req.header('x-deploy-token')
  if (expected && provided && provided === expected) return
  await requireAdmin(c)
}

// ─── Validation Schemas ─────────────────────────────────────────────────────

const createAppVersionSchema = z.object({
  platform: z.enum(['android', 'ios', 'electron', 'windows', 'mac', 'linux']),
  version: z.string().min(1).max(50).regex(/^\d+\.\d+\.\d+/, 'Version must be semver (e.g. 1.2.3)'),
  versionCode: z.number().int().min(0).default(0),
  releaseNotes: z.string().default(''),
  releaseNotesAr: z.string().optional(),
  releaseNotesFr: z.string().optional(),
  isMandatory: z.boolean().default(false),
  isPublished: z.boolean().default(false),
  isPatch: z.boolean().default(false),
  downloadUrl: z.string().default(''),
  minAppVersion: z.string().optional(),
})

const updateAppVersionSchema = z.object({
  version: z.string().min(1).max(50).regex(/^\d+\.\d+\.\d+/).optional(),
  versionCode: z.number().int().min(0).optional(),
  releaseNotes: z.string().optional(),
  releaseNotesAr: z.string().nullable().optional(),
  releaseNotesFr: z.string().nullable().optional(),
  isMandatory: z.boolean().optional(),
  isPublished: z.boolean().optional(),
  isPatch: z.boolean().optional(),
  downloadUrl: z.string().optional(),
  minAppVersion: z.string().nullable().optional(),
})

// ─── Upload directory ───────────────────────────────────────────────────────
//
// Round 15 storage audit FIX: app binaries used to be written into
// os.tmpdir()/blasti-app-uploads — a directory the OS may WIPE on reboot,
// silently breaking every previously uploaded binary. Binaries now live in
// the central storage root (lib/storage.ts) under the app-versions bucket.
// Reads fall back to the legacy tmpdir location so binaries uploaded before
// this change keep downloading until re-uploaded.

const UPLOAD_DIR = path.join(STORAGE_ROOT, 'app-versions')
const LEGACY_UPLOAD_DIR = path.join(os.tmpdir(), 'blasti-app-uploads')

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  }
}

/** Resolve a stored binary: organized dir first, legacy tmpdir second. */
function resolveBinaryPath(storageKey: string): string | null {
  const organized = path.resolve(UPLOAD_DIR, storageKey)
  if (organized.startsWith(path.resolve(UPLOAD_DIR) + path.sep) && fs.existsSync(organized)) return organized
  const legacy = path.resolve(LEGACY_UPLOAD_DIR, storageKey)
  if (legacy.startsWith(path.resolve(LEGACY_UPLOAD_DIR) + path.sep) && fs.existsSync(legacy)) return legacy
  return null
}

// ─── GET /app-versions — List all app versions ──────────────────────────────

app.get('/', async (c) => {
  try {
    await requireAdmin(c)

    const platform = c.req.query('platform')
    const published = c.req.query('published')

    const where: any = {}
    if (platform) where.platform = platform
    if (published === 'true') where.isPublished = true
    if (published === 'false') where.isPublished = false

    const versions = await db.appVersion.findMany({
      where,
      orderBy: [{ platform: 'asc' }, { createdAt: 'desc' }],
    })

    return c.json({ success: true, versions })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/latest — Get latest published version for each platform

app.get('/latest', async (c) => {
  try {
    await requireAdmin(c)

    const platforms = ['android', 'ios', 'electron', 'windows', 'mac', 'linux'] as const
    const latest: Record<string, any> = {}

    for (const platform of platforms) {
      const version = await db.appVersion.findFirst({
        where: { platform, isPublished: true },
        orderBy: { createdAt: 'desc' },
      })
      latest[platform] = version
    }

    return c.json({ success: true, latest })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/check — PUBLIC update check (Task 47-b) ─────────────
//
// Query params: platform (android|ios|electron|windows|mac|linux), version.
// Compares the provided version against the latest PUBLISHED version for the
// platform (ordered by versionCode desc, then createdAt desc).
//
// IMPORTANT: this must stay PUBLIC (no requireAdmin) and be registered
// BEFORE the GET /:id route below — Hono matches routes in registration
// order and /check would otherwise be captured by the /:id handler.

app.get('/check', async (c) => {
  try {
    const platform = c.req.query('platform')
    const version = c.req.query('version')

    if (!platform || !version) {
      return c.json({ success: false, error: 'platform and version query params are required' }, 400)
    }

    const latestVersion = await db.appVersion.findFirst({
      where: { platform, isPublished: true },
      orderBy: [{ versionCode: 'desc' }, { createdAt: 'desc' }],
    })

    const updateAvailable = !!latestVersion && compareVersions(latestVersion.version, version) > 0

    return c.json({
      success: true,
      platform,
      currentVersion: version,
      latestVersion: latestVersion?.version ?? '',
      versionCode: latestVersion?.versionCode ?? 0,
      updateAvailable,
      isMandatory: updateAvailable ? (latestVersion?.isMandatory ?? false) : false,
      downloadUrl: updateAvailable ? (latestVersion?.downloadUrl ?? '') : '',
      releaseNotes: latestVersion?.releaseNotes ?? '',
      releaseNotesAr: latestVersion?.releaseNotesAr ?? '',
      releaseNotesFr: latestVersion?.releaseNotesFr ?? '',
    })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Update check failed' }, 500)
  }
})

// ─── POST /app-versions — Create a new app version ──────────────────────────

app.post('/', async (c) => {
  try {
    await requireAdminOrDeployToken(c)

    const body = await c.req.json()
    const validation = createAppVersionSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.errors }, 400)
    }

    const data = validation.data

    // Check for duplicate platform+version
    const existing = await db.appVersion.findUnique({
      where: { platform_version: { platform: data.platform, version: data.version } },
    })
    if (existing) {
      return c.json({ success: false, error: 'Version already exists for this platform' }, 409)
    }

    const appVersion = await db.appVersion.create({
      data: {
        platform: data.platform,
        version: data.version,
        versionCode: data.versionCode,
        releaseNotes: data.releaseNotes,
        releaseNotesAr: data.releaseNotesAr,
        releaseNotesFr: data.releaseNotesFr,
        isMandatory: data.isMandatory,
        isPublished: data.isPublished,
        isPatch: data.isPatch,
        downloadUrl: data.downloadUrl,
        minAppVersion: data.minAppVersion,
        publishedAt: data.isPublished ? new Date() : null,
      },
    })

    return c.json({ success: true, version: appVersion })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/upload — Upload an app binary ──────────────────────

app.post('/upload', async (c) => {
  try {
    await requireAdminOrDeployToken(c)

    ensureUploadDir()

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const platform = formData.get('platform') as string | null
    const version = formData.get('version') as string | null
    // create=1 (form field or query): CI convenience — auto-create the
    // version record when it does not exist yet, so one multipart call
    // both registers the version and attaches the binary.
    const autoCreate =
      formData.get('create') === '1' || formData.get('create') === 'true' || c.req.query('create') === '1'

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    if (!platform || !version) {
      return c.json({ success: false, error: 'Platform and version are required' }, 400)
    }

    if (!['android', 'ios', 'electron', 'windows', 'mac', 'linux'].includes(platform)) {
      return c.json({ success: false, error: 'Invalid platform' }, 400)
    }
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return c.json({ success: false, error: 'Version must be semver (e.g. 1.2.3)' }, 400)
    }

    // Save file to temp directory
    const safeName = `${platform}-${version}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const filePath = path.join(UPLOAD_DIR, safeName)

    const buffer = Buffer.from(await file.arrayBuffer())
    fs.writeFileSync(filePath, buffer)

    // Calculate file hash for integrity
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')

    // Update the app version record with file info (create it first when
    // requested — used by CI uploads of brand-new versions)
    let appVersion = await db.appVersion.findUnique({
      where: { platform_version: { platform, version } },
    })

    if (!appVersion && autoCreate) {
      const versionCodeRaw = formData.get('versionCode')
      const versionCode = versionCodeRaw ? parseInt(String(versionCodeRaw), 10) || 0 : 0
      const notes = String(formData.get('releaseNotes') ?? '')
      appVersion = await db.appVersion.create({
        data: {
          platform,
          version,
          versionCode,
          releaseNotes: notes.slice(0, 2000),
          isPublished: false, // CI uploads land as drafts — an admin activates them
        },
      })
    }

    if (!appVersion) {
      return c.json({ success: false, error: 'App version record not found. Create the version first, then upload the file.' }, 404)
    }

    const updated = await db.appVersion.update({
      where: { id: appVersion.id },
      data: {
        fileStorageKey: safeName,
        fileStorageProvider: 'local',
        fileName: file.name,
        fileSize: file.size,
        fileHash: hash,
        downloadUrl: `/api/app-versions/${appVersion.id}/download`,
      },
    })

    return c.json({
      success: true,
      version: updated,
      fileInfo: {
        name: file.name,
        size: file.size,
        type: file.type,
        hash,
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/public/active — PUBLIC active downloads ────────────
//
// Used by the public landing page download section: returns the ACTIVE
// (published) version per platform so visitors can download the installer
// the admin selected in Public Apps Settings. Metadata only, no secrets.
// NOTE: registered before GET /:id (Hono matches in registration order).

app.get('/public/active', async (c) => {
  try {
    const platforms = ['android', 'ios', 'electron', 'windows', 'mac', 'linux'] as const
    const versions: Array<Record<string, unknown>> = []

    for (const platform of platforms) {
      const v = await db.appVersion.findFirst({
        where: { platform, isPublished: true },
        orderBy: [{ versionCode: 'desc' }, { createdAt: 'desc' }],
      })
      if (!v) continue
      versions.push({
        platform: v.platform,
        version: v.version,
        versionCode: v.versionCode,
        releaseNotes: v.releaseNotes,
        releaseNotesAr: v.releaseNotesAr,
        releaseNotesFr: v.releaseNotesFr,
        isMandatory: v.isMandatory,
        fileName: v.fileName,
        fileSize: v.fileSize,
        downloadCount: v.downloadCount,
        publishedAt: v.publishedAt,
        downloadUrl: v.downloadUrl || `/api/app-versions/${v.id}/download`,
      })
    }

    return c.json({ success: true, versions })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Failed to load public downloads' }, 500)
  }
})

// ─── POST /app-versions/:id/activate — Make this THE active version ──────
//
// "Select the active version" from Public Apps Settings: publishes this
// version and unpublishes every other version of the same platform in a
// single transaction, so exactly one installer per platform is public.

app.post('/:id/activate', async (c) => {
  try {
    await requireAdmin(c)

    const existing = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    const activated = await db.$transaction(async (tx) => {
      await tx.appVersion.updateMany({
        where: { platform: existing.platform, id: { not: existing.id } },
        data: { isPublished: false },
      })
      return tx.appVersion.update({
        where: { id: existing.id },
        data: {
          isPublished: true,
          publishedAt: existing.publishedAt ?? new Date(),
        },
      })
    })

    return c.json({ success: true, version: activated })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /app-versions/:id/download — Download an app binary ────────────────

app.get('/:id/download', async (c) => {
  try {
    // Public endpoint — no auth required (for app update checks)
    const appVersion = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })

    if (!appVersion || !appVersion.fileStorageKey) {
      return c.json({ success: false, error: 'File not found' }, 404)
    }

    const filePath = resolveBinaryPath(appVersion.fileStorageKey)
    if (!filePath) {
      return c.json({ success: false, error: 'File not found' }, 404)
    }
    if (!fs.existsSync(filePath)) {
      return c.json({ success: false, error: 'File not found on disk' }, 404)
    }

    // Increment download count
    await db.appVersion.update({
      where: { id: c.req.param('id') },
      data: { downloadCount: { increment: 1 } },
    })

    const fileBuffer = fs.readFileSync(filePath)
    const fileName = appVersion.fileName || appVersion.fileStorageKey

    return new Response(fileBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(fileBuffer.length),
      },
    })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Download failed' }, 500)
  }
})

// ─── GET /app-versions/:id — Get a single app version ───────────────────────

app.get('/:id', async (c) => {
  try {
    await requireAdmin(c)

    const appVersion = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })

    if (!appVersion) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    return c.json({ success: true, version: appVersion })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── PATCH /app-versions/:id — Update an app version ────────────────────────

app.patch('/:id', async (c) => {
  try {
    await requireAdmin(c)

    const body = await c.req.json()
    const validation = updateAppVersionSchema.safeParse(body)
    if (!validation.success) {
      return c.json({ success: false, error: 'Invalid input', details: validation.error.errors }, 400)
    }

    const data = validation.data

    const existing = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    // If publishing for the first time, set publishedAt
    const publishData: any = {}
    if (data.isPublished === true && !existing.isPublished && !existing.publishedAt) {
      publishData.publishedAt = new Date()
    }

    const appVersion = await db.appVersion.update({
      where: { id: c.req.param('id') },
      data: { ...data, ...publishData },
    })

    return c.json({ success: true, version: appVersion })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── DELETE /app-versions/:id — Delete an app version ───────────────────────

app.delete('/:id', async (c) => {
  try {
    await requireAdmin(c)

    const existing = await db.appVersion.findUnique({
      where: { id: c.req.param('id') },
    })
    if (!existing) {
      return c.json({ success: false, error: 'Version not found' }, 404)
    }

    // Clean up file if it exists
    if (existing.fileStorageKey) {
      const filePath = resolveBinaryPath(existing.fileStorageKey)
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    }

    await db.appVersion.delete({ where: { id: c.req.param('id') } })

    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── POST /app-versions/check-update — Public endpoint for apps to check for updates

app.post('/check-update', async (c) => {
  try {
    const body = await c.req.json()
    const { platform, currentVersion } = body as { platform?: string; currentVersion?: string }

    if (!platform || !currentVersion) {
      return c.json({ success: false, error: 'platform and currentVersion are required' }, 400)
    }

    const latestVersion = await db.appVersion.findFirst({
      where: { platform, isPublished: true },
      orderBy: { createdAt: 'desc' },
    })

    if (!latestVersion) {
      return c.json({ success: false, updateAvailable: false })
    }

    // Simple semver comparison
    const isNewer = compareVersions(latestVersion.version, currentVersion) > 0

    if (!isNewer) {
      return c.json({ success: true, updateAvailable: false })
    }

    return c.json({
      success: true,
      updateAvailable: true,
      isMandatory: latestVersion.isMandatory,
      version: {
        version: latestVersion.version,
        versionCode: latestVersion.versionCode,
        releaseNotes: latestVersion.releaseNotes,
        releaseNotesAr: latestVersion.releaseNotesAr,
        releaseNotesFr: latestVersion.releaseNotesFr,
        isPatch: latestVersion.isPatch,
        downloadUrl: latestVersion.downloadUrl || `/api/app-versions/${latestVersion.id}/download`,
        minAppVersion: latestVersion.minAppVersion,
        fileSize: latestVersion.fileSize,
        fileHash: latestVersion.fileHash,
        publishedAt: latestVersion.publishedAt,
      },
    })
  } catch (error: unknown) {
    return c.json({ success: false, error: 'Update check failed' }, 500)
  }
})

// ─── Helper: Simple semver comparison ────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const aVal = aParts[i] || 0
    const bVal = bParts[i] || 0
    if (aVal > bVal) return 1
    if (aVal < bVal) return -1
  }
  return 0
}

export const appVersionRoutes = app
