import { Hono } from 'hono'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { z } from 'zod'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'

const app = new Hono()

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

const UPLOAD_DIR = path.join(os.tmpdir(), 'blasti-app-uploads')

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  }
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

// ─── POST /app-versions — Create a new app version ──────────────────────────

app.post('/', async (c) => {
  try {
    await requireAdmin(c)

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
    await requireAdmin(c)

    ensureUploadDir()

    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const platform = formData.get('platform') as string | null
    const version = formData.get('version') as string | null

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    if (!platform || !version) {
      return c.json({ success: false, error: 'Platform and version are required' }, 400)
    }

    // Save file to temp directory
    const safeName = `${platform}-${version}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const filePath = path.join(UPLOAD_DIR, safeName)

    const buffer = Buffer.from(await file.arrayBuffer())
    fs.writeFileSync(filePath, buffer)

    // Calculate file hash for integrity
    const hash = crypto.createHash('sha256').update(buffer).digest('hex')

    // Update the app version record with file info
    const appVersion = await db.appVersion.findUnique({
      where: { platform_version: { platform, version } },
    })

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

    const filePath = path.join(UPLOAD_DIR, appVersion.fileStorageKey)
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
      const filePath = path.join(UPLOAD_DIR, existing.fileStorageKey)
      if (fs.existsSync(filePath)) {
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
