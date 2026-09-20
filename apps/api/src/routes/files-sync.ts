import { Hono } from 'hono'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { createHash } from 'crypto'
import {
  SYNC_BUCKETS,
  SAFE_TYPE_RE,
  SAFE_FILENAME_RE,
  saveUpload,
  absoluteFileUrl,
  publicFilePath,
  readByStoragePath,
  deleteByStoragePath,
  storagePathFromUrl,
} from '../lib/storage'
import { db } from '@blasti/db'

const app = new Hono()

/**
 * Round 15 — DESKTOP FILE SYNC endpoints (part of the sync engine family).
 *
 * The desktop local API stores every upload LOCALLY first (offline-first) in
 * its own organized file store and returns a local URL. This route family is
 * how those files reach the cloud (and how files uploaded elsewhere reach
 * the desktop):
 *
 *   POST /api/files/sync/push        device → cloud   (multipart blob + meta)
 *   GET  /api/files/sync/pull        device ← cloud   (metadata since cursor)
 *   GET  /api/files/sync/blob/:id    device ← cloud   (the actual bytes)
 *   DELETE /api/files/sync/:deviceFileId             (tombstone a file)
 *
 * Pushes are IDEMPOTENT: the cloud upserts FileAsset by `deviceFileId`, so a
 * replayed push updates the same row instead of duplicating the blob. Pulls
 * are cursor-based (updatedAt) and skip tombstones.
 */

/** Sanitize the meta object a device sends with a push. */
interface PushMeta {
  deviceFileId: string
  bucket: string
  filename: string
  mimeType?: string
  size?: number
  checksum?: string
  createdAt?: string
  originalName?: string
}

function parseMeta(raw: unknown): PushMeta | null {
  if (!raw || typeof raw !== 'string') return null
  try {
    const m = JSON.parse(raw) as PushMeta
    if (!m || typeof m.deviceFileId !== 'string' || m.deviceFileId.length < 4 || m.deviceFileId.length > 64) return null
    if (!/^[a-zA-Z0-9._:-]+$/.test(m.deviceFileId)) return null
    if (typeof m.bucket !== 'string' || !SAFE_TYPE_RE.test(m.bucket) || !SYNC_BUCKETS.has(m.bucket)) return null
    if (typeof m.filename !== 'string') return null
    return m
  } catch {
    return null
  }
}

// ─── POST /api/files/sync/push — device pushes a locally-stored file ────────

app.post('/push', async (c) => {
  try {
    const user = await requireAuth(c)

    let formData: FormData
    try {
      formData = await c.req.formData()
    } catch {
      return c.json({ success: false, error: 'multipart/form-data body required' }, 400)
    }

    const file = formData.get('file') as File | null
    const meta = parseMeta(formData.get('meta'))

    if (!meta) {
      return c.json({ success: false, error: 'Invalid or missing meta (deviceFileId, bucket, filename required)' }, 400)
    }
    if (!file || typeof file === 'string') {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    // The filename must be the canonical generated shape (the desktop file
    // store produces exactly this) so the storage path round-trips with the
    // URL the cloud will serve.
    if (!SAFE_FILENAME_RE.test(meta.filename)) {
      return c.json({ success: false, error: `Invalid filename shape "${meta.filename}"` }, 400)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.length === 0) {
      return c.json({ success: false, error: 'Empty file' }, 400)
    }
    if (buffer.length > 20 * 1024 * 1024) {
      return c.json({ success: false, error: 'File too large — max 20MB' }, 400)
    }

    const saved = await saveUpload(meta.bucket, buffer, meta.filename)
    const checksum = meta.checksum && /^[a-f0-9]{64}$/.test(meta.checksum)
      ? meta.checksum
      : createHash('sha256').update(buffer).digest('hex')
    const origin = new URL(c.req.url).origin
    const url = absoluteFileUrl(origin, meta.bucket, saved.yyyy, saved.mm, meta.filename)

    const existing = await db.fileAsset.findUnique({ where: { deviceFileId: meta.deviceFileId } })

    const data = {
      bucket: meta.bucket,
      storagePath: saved.storagePath,
      originalName: (meta.originalName || file.name || meta.filename).slice(0, 200),
      mimeType: meta.mimeType || file.type || 'application/octet-stream',
      size: buffer.length,
      checksum,
      url,
      ownerId: user.id,
      agencyId: user.agencyId ?? null,
      deletedAt: null,
    }

    const asset = existing
      ? await db.fileAsset.update({ where: { deviceFileId: meta.deviceFileId }, data })
      : await db.fileAsset.create({
          data: { deviceFileId: meta.deviceFileId, ...data, createdAt: meta.createdAt ? new Date(meta.createdAt) : undefined },
        })

    return c.json({
      success: true,
      fileId: asset.id,
      deviceFileId: meta.deviceFileId,
      url: asset.url,
      path: publicFilePath(meta.bucket, saved.yyyy, saved.mm, meta.filename),
      storagePath: asset.storagePath,
      checksum: asset.checksum,
      duplicate: Boolean(existing),
    }, existing ? 200 : 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /api/files/sync/pull — metadata for files changed since a cursor ───

app.get('/pull', async (c) => {
  try {
    const user = await requireAuth(c)
    const cursorRaw = c.req.query('cursor')
    const limitRaw = c.req.query('limit')
    const limit = Math.min(Math.max(parseInt(limitRaw || '100', 10) || 100, 1), 200)

    // Scope: agency members pull their agency's files + their own user files
    // (avatars). Everything else stays private to its owner.
    const where: Record<string, unknown> = {
      deletedAt: null,
      OR: [
        { agencyId: user.agencyId ?? '__none__' },
        { ownerId: user.id },
      ],
    }
    if (cursorRaw && /^\d{4}-\d{2}-\d{2}T/.test(cursorRaw)) {
      const cursor = new Date(cursorRaw)
      if (!Number.isNaN(cursor.getTime())) where.updatedAt = { gt: cursor }
    }

    const assets = await db.fileAsset.findMany({
      where,
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        deviceFileId: true,
        bucket: true,
        storagePath: true,
        originalName: true,
        mimeType: true,
        size: true,
        checksum: true,
        url: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return c.json({
      success: true,
      files: assets,
      hasMore: assets.length === limit,
      cursor: assets.length ? assets[assets.length - 1].updatedAt.toISOString() : cursorRaw || null,
      serverTime: new Date().toISOString(),
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── GET /api/files/sync/blob/:fileId — download the actual bytes ───────────

app.get('/blob/:fileId', async (c) => {
  try {
    await requireAuth(c)
    const fileId = c.req.param('fileId')

    const asset = await db.fileAsset.findUnique({ where: { id: fileId } })
    if (!asset || asset.deletedAt) {
      return c.json({ success: false, error: 'File not found' }, 404)
    }

    const data = await readByStoragePath(asset.storagePath)
    if (!data) {
      return c.json({ success: false, error: 'File blob missing from storage' }, 404)
    }

    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': asset.mimeType || 'application/octet-stream',
        'Content-Length': String(data.length),
        'Content-Disposition': 'inline',
        'X-File-Id': asset.id,
        ...(asset.checksum ? { 'X-File-Checksum': asset.checksum } : {}),
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// ─── DELETE /api/files/sync/:deviceFileId — tombstone a synced file ─────────

app.delete('/:deviceFileId', async (c) => {
  try {
    const user = await requireAuth(c)
    const deviceFileId = c.req.param('deviceFileId')

    const asset = await db.fileAsset.findUnique({ where: { deviceFileId } })
    if (!asset) {
      return c.json({ success: true, message: 'File not found — already deleted' })
    }

    // Only the owner (or a same-agency staff member) may tombstone.
    if (asset.ownerId && asset.ownerId !== user.id) {
      const sameAgency = user.agencyId && asset.agencyId === user.agencyId
      if (!sameAgency && user.role !== 'SUPER_ADMIN') {
        return c.json({ success: false, error: 'Access denied' }, 403)
      }
    }

    await db.fileAsset.update({ where: { deviceFileId }, data: { deletedAt: new Date() } })
    await deleteByStoragePath(asset.storagePath)

    return c.json({ success: true, message: 'File deleted' })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const filesSyncRoutes = app
