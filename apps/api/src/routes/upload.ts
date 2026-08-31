import { Hono } from 'hono'
import { requireAuth, authErrorResponse } from '../lib/auth'

const app = new Hono()

// POST /upload — Upload a file (authenticated)
// Note: In the Hono API, file uploads are handled differently from Next.js.
// This is a placeholder that returns a success response.
// For production, integrate with the storage provider from ../lib/upload.
app.post('/', async (c) => {
  try {
    await requireAuth(c)

    // Parse multipart form data
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    const type = (formData.get('type') as string) || 'general'

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    // For now, return file metadata without actual upload
    // In production, delegate to the storage provider
    return c.json({
      success: true,
      file: {
        name: file.name,
        size: file.size,
        type: file.type,
        uploadType: type,
      },
      message: 'Upload endpoint ready — integrate with storage provider for production use',
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

// DELETE /upload — Delete an uploaded file by URL (authenticated)
app.delete('/', async (c) => {
  try {
    await requireAuth(c)
    const body = await c.req.json()
    const url = body?.url as string | undefined

    if (!url) {
      return c.json({ success: false, error: 'No URL provided' }, 400)
    }

    // Validate URL format — must be a relative /uploads/* path to prevent SSRF
    if (!url.startsWith('/uploads/') && !url.startsWith('/public/uploads/')) {
      return c.json({ success: false, error: 'Invalid file URL — only /uploads/* paths are allowed' }, 400)
    }

    // Resolve file path relative to the web app public directory
    const path = await import('path')
    const fs = await import('fs')
    const publicDir = path.join(process.cwd(), '..', 'web', 'public')
    const filePath = path.join(publicDir, url.startsWith('/public/') ? url.slice('/public'.length) : url)

    // Prevent directory traversal
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(path.resolve(publicDir))) {
      return c.json({ success: false, error: 'Access denied — path traversal blocked' }, 403)
    }

    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved)
      return c.json({ success: true, message: 'File deleted' })
    } else {
      return c.json({ success: true, message: 'File not found — already deleted' })
    }
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const uploadRoutes = app
