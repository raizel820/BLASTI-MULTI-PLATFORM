/**
 * @blasti/api — Public branding routes
 *
 * GET /api/branding/logo → the bundled BLASTI app logo (PNG).
 *
 * Used by the email layout (wrapEmailHtml) to embed the app logo into
 * professional emails, and available to any integration that needs a
 * stable, publicly-reachable logo URL.
 *
 * The file is read from disk on each request (tiny, cacheable) so a
 * re-brand only means replacing apps/api/assets/branding/logo.png.
 * Falls back to an inline SVG wordmark when the asset is missing.
 */

import { Hono } from 'hono'
import { existsSync, readFileSync } from 'fs'

const app = new Hono()

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80">
  <rect width="240" height="80" rx="14" fill="#059669"/>
  <text x="120" y="52" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="800" fill="#ffffff" text-anchor="middle">BLASTI</text>
</svg>`

app.get('/logo', (c) => {
  try {
    const logoPath = new URL('../../assets/branding/logo.png', import.meta.url).pathname
    if (existsSync(logoPath)) {
      const data = readFileSync(logoPath)
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      })
    }
  } catch {
    // fall through to the SVG wordmark
  }
  return new Response(FALLBACK_SVG, {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  })
})

export const brandingRoutes = app
