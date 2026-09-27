/**
 * @blasti/api — Public-ish App Configuration Routes (Task 51)
 *
 * Mounted at /api/config. Endpoints here return runtime configuration that
 * ANY authenticated user (any role) may read — no secrets, ever.
 *
 * Routes:
 *   GET /maps → Effective map provider/directions configuration for the
 *               client map widgets (see lib/map-settings.ts for the
 *               precedence contract: DB → env → built-in defaults, spec §47).
 *
 * CONTRACT (Task 51 — do not deviate):
 *   { success: true, data: {
 *       provider: "GOOGLE" | "OPENFREEMAP",
 *       fallbackProvider: "NONE" | "GOOGLE" | "OPENFREEMAP",
 *       mapsEnabled: boolean,
 *       directionsEnabled: boolean,
 *       openfreemap: { styleUrl: string },
 *       google: { configured: boolean, geocodingEnabled: boolean, jsApiKey: string | null },
 *       geocoding: { provider: "GOOGLE" | "OSM" },
 *       directions: { destinationMode, origin, openBehavior, buttonLabel }
 *   } }
 *   jsApiKey is returned ONLY when provider === "GOOGLE" and a JS key exists.
 *   (The Google Maps JS key is referrer-restricted by design — it is meant to
 *   be embedded in browser pages and is therefore NOT a secret; the SERVER
 *   Google key never appears here.) Full secrets never appear in any response.
 */

import { Hono } from 'hono'
import { requireAuth, authErrorResponse } from '../lib/auth'
import { buildMapsConfig } from '../lib/map-settings'

const app = new Hono()

// GET /config/maps — effective maps configuration for any authenticated user.
app.get('/maps', async (c) => {
  try {
    await requireAuth(c)

    const config = await buildMapsConfig()
    return c.json({ success: true, data: config })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as any)
  }
})

export const configRoutes = app
