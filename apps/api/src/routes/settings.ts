/**
 * @blasti/api — System Settings Routes
 *
 * Admin-only CRUD for the dynamic configuration system.
 * All routes require SUPER_ADMIN authentication.
 *
 * Routes:
 *   GET    /                    → List all settings (encrypted values masked)
 *   GET    /categories          → List all categories
 *   GET    /category/:category  → Get settings by category
 *   GET    /:key                → Get a specific setting
 *   PUT    /:key                → Create or update a setting
 *   DELETE /:key                → Delete a setting
 *   POST   /bulk                → Bulk update settings
 */

import { Hono } from 'hono'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import {
  getConfig,
  getAllSettingsRaw,
  getSettingRaw,
  getSettingCategories,
  setConfig,
  deleteConfig,
  bulkSetConfig,
  invalidateCache,
} from '../lib/config-manager'

const app = new Hono()

/**
 * Mask an encrypted value for display.
 * Returns "••••••••" for encrypted values.
 */
function maskValue(value: string, encrypted: boolean): string {
  if (!encrypted) return value
  return '••••••••'
}

// ─── GET / — List all settings (encrypted values masked) ──────────────

app.get('/', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const settings = await getAllSettingsRaw()
    return c.json({
      success: true,
      data: settings.map(s => ({
        ...s,
        value: maskValue(s.value, s.encrypted),
      })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /categories — List all distinct categories ───────────────────

app.get('/categories', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const categories = await getSettingCategories()
    return c.json({ success: true, data: categories })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /category/:category — Get settings by category ───────────────

app.get('/category/:category', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const category = c.req.param('category')
    const settings = await getAllSettingsRaw()
    const filtered = settings.filter(s => s.category === category)
    return c.json({
      success: true,
      data: filtered.map(s => ({
        ...s,
        value: maskValue(s.value, s.encrypted),
      })),
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /:key — Get a specific setting ───────────────────────────────

app.get('/:key', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const key = c.req.param('key')
    const setting = await getSettingRaw(key)
    if (!setting) {
      return c.json({ success: false, error: 'Setting not found' }, 404)
    }
    return c.json({
      success: true,
      data: {
        ...setting,
        value: maskValue(setting.value, setting.encrypted),
      },
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── PUT /:key — Create or update a setting ───────────────────────────

app.put('/:key', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const key = c.req.param('key')
    const body = await c.req.json()

    const { value, encrypted, category, description, valueType } = body

    if (value === undefined || value === null) {
      return c.json({ success: false, error: 'Value is required' }, 400)
    }

    await setConfig(key, String(value), {
      encrypted: encrypted === true,
      category: category || 'general',
      description: description || '',
      valueType: valueType || 'string',
    })

    // Return the updated setting (masked)
    const updated = await getSettingRaw(key)
    return c.json({
      success: true,
      data: updated ? { ...updated, value: maskValue(updated.value, updated.encrypted) } : null,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    if (err.status === 401 || err.status === 403) {
      return c.json({ success: false, error: err.error }, err.status as 400)
    }
    console.error('[settings PUT] Error:', error)
    return c.json({ success: false, error: 'Failed to save setting' }, 500)
  }
})

// ─── DELETE /:key — Delete a setting ──────────────────────────────────

app.delete('/:key', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const key = c.req.param('key')
    const deleted = await deleteConfig(key)
    if (!deleted) {
      return c.json({ success: false, error: 'Setting not found' }, 404)
    }
    return c.json({ success: true, message: 'Setting deleted' })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /bulk — Bulk update settings ────────────────────────────────

app.post('/bulk', async (c) => {
  try {
    const admin = await requireAdmin(c)
    const body = await c.req.json()

    if (!Array.isArray(body.settings)) {
      return c.json({ success: false, error: 'settings array is required' }, 400)
    }

    // Validate each entry
    for (const entry of body.settings) {
      if (!entry.key || entry.value === undefined || entry.value === null) {
        return c.json({
          success: false,
          error: `Each setting must have 'key' and 'value' fields. Invalid entry: ${JSON.stringify(entry)}`,
        }, 400)
      }
    }

    await bulkSetConfig(body.settings.map((entry: any) => ({
      key: entry.key,
      value: String(entry.value),
      encrypted: entry.encrypted === true,
      category: entry.category,
      description: entry.description,
      valueType: entry.valueType,
    })))

    return c.json({ success: true, message: `${body.settings.length} settings updated` })
  } catch (error) {
    const err = authErrorResponse(error)
    if (err.status === 401 || err.status === 403) {
      return c.json({ success: false, error: err.error }, err.status as 400)
    }
    console.error('[settings POST /bulk] Error:', error)
    return c.json({ success: false, error: 'Failed to bulk update settings' }, 500)
  }
})

export const settingsRoutes = app
