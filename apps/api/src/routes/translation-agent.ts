import { Hono } from 'hono'
import { requireRole, authErrorResponse } from '../lib/auth'
import {
  getAgentConfig,
  runTranslationBatch,
  startTranslationAgentScheduler,
  testTranslationApiKey,
  enqueueCategoryTranslations,
  AGENT_LANGS,
} from '../lib/translation-agent'
import { db } from '@blasti/db'

/**
 * BLASTI AI Translation Agent API (0.6.61) — SUPER_ADMIN console behind the
 * "Agency Category Translations" admin page:
 *
 *   GET    /api/translation-agent/settings              → singleton config + queue stats
 *   PUT    /api/translation-agent/settings              → enabled / interval / batch size / model
 *   POST   /api/translation-agent/process-now           → force ONE batch window
 *   GET    /api/translation-agent/jobs?status=          → queue monitor (recent 100)
 *   GET    /api/translation-agent/dictionary            → local dictionary browser
 *                                                        (page, search, sourceLang, targetLang, domain)
 *   PATCH  /api/translation-agent/dictionary/:id        → manual correction (origin='manual')
 *   DELETE /api/translation-agent/dictionary/:id        → remove a dictionary row
 *   GET    /api/translation-agent/keys                  → API keys (secret masked)
 *   POST   /api/translation-agent/keys                  → add key
 *   PATCH  /api/translation-agent/keys/:id              → edit/toggle key
 *   DELETE /api/translation-agent/keys/:id              → remove key
 *   POST   /api/translation-agent/keys/:id/test         → tiny live translation round-trip
 *   POST   /api/translation-agent/enqueue-category      → queue a category name + its terms
 *                                                          for the agent (Category Language page)
 *
 * The agent engine itself lives in lib/translation-agent.ts; the scheduler
 * is started once at boot from index.ts.
 */

const app = new Hono()

app.use('*', async (c, next) => {
  try {
    await requireRole(c, 'SUPER_ADMIN')
    await next()
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 401 | 403)
  }
})

// ─── Settings + queue ────────────────────────────────────────────────────────

app.get('/settings', async (c) => {
  try {
    const config = await getAgentConfig()
    const [pending, processing, done, failed, dictionarySize] = await Promise.all([
      db.translationJob.count({ where: { status: 'pending' } }),
      db.translationJob.count({ where: { status: 'processing' } }),
      db.translationJob.count({ where: { status: 'done' } }),
      db.translationJob.count({ where: { status: 'failed' } }),
      db.translationEntry.count(),
    ])
    const activeKeys = await db.translationApiKey.count({ where: { isActive: true } })
    return c.json({
      success: true,
      data: {
        config,
        queue: { pending, processing, done, failed },
        dictionarySize,
        activeKeys,
        langs: AGENT_LANGS,
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.put('/settings', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled
    if (body.intervalMinutes !== undefined) {
      const n = Number(body.intervalMinutes)
      if (!Number.isFinite(n) || n < 1 || n > 120) return c.json({ success: false, error: 'intervalMinutes must be 1-120' }, 400)
      data.intervalMinutes = Math.round(n)
    }
    if (body.batchSize !== undefined) {
      const n = Number(body.batchSize)
      if (!Number.isFinite(n) || n < 1 || n > 100) return c.json({ success: false, error: 'batchSize must be 1-100' }, 400)
      data.batchSize = Math.round(n)
    }
    if (body.model !== undefined) {
      const m = String(body.model || '').trim()
      if (m && !/^[A-Za-z0-9._\-\/]{2,80}$/.test(m)) return c.json({ success: false, error: 'invalid model id' }, 400)
      data.model = m || 'glm-4.6-flash'
    }
    const config = await db.translationAgentConfig.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data },
      update: data,
    })
    return c.json({ success: true, data: { config } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.post('/process-now', async (c) => {
  try {
    const stats = await runTranslationBatch(true)
    return c.json({ success: true, data: { stats } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.get('/jobs', async (c) => {
  try {
    const status = c.req.query('status')
    const where = status && ['pending', 'processing', 'done', 'failed'].includes(status) ? { status } : {}
    const jobs = await db.translationJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, type: true, status: true, sourceLang: true, targetLang: true,
        sourceText: true, domain: true, key: true, refType: true, field: true,
        attempts: true, error: true, result: true, createdAt: true, processedAt: true,
      },
    })
    return c.json({ success: true, data: { jobs } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

// ─── Local dictionary ────────────────────────────────────────────────────────

app.get('/dictionary', async (c) => {
  try {
    const pageRaw = parseInt(c.req.query('page') || '1', 10)
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1
    const perPage = Math.min(100, Math.max(10, parseInt(c.req.query('perPage') || '25', 10) || 25))
    const search = (c.req.query('search') || '').trim()
    const sourceLang = c.req.query('sourceLang')
    const targetLang = c.req.query('targetLang')
    const domain = c.req.query('domain')

    const where: Record<string, unknown> = {}
    if (sourceLang && (AGENT_LANGS as readonly string[]).includes(sourceLang)) where.sourceLang = sourceLang
    if (targetLang && (AGENT_LANGS as readonly string[]).includes(targetLang)) where.targetLang = targetLang
    if (domain) where.domain = domain
    if (search) {
      where.OR = [
        { sourceText: { contains: search, mode: 'insensitive' } },
        { targetText: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [total, entries] = await Promise.all([
      db.translationEntry.count({ where }),
      db.translationEntry.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ])
    return c.json({ success: true, data: { entries, total, page, perPage } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.patch('/dictionary/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const targetText = String(body.targetText ?? '').trim()
    if (!targetText) return c.json({ success: false, error: 'targetText is required' }, 400)
    const entry = await db.translationEntry.update({
      where: { id },
      data: { targetText: targetText.slice(0, 4000), origin: 'manual' },
    })
    return c.json({ success: true, data: { entry } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.delete('/dictionary/:id', async (c) => {
  try {
    await db.translationEntry.delete({ where: { id: c.req.param('id') } })
    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

// ─── API keys ────────────────────────────────────────────────────────────────

/** Never return the raw key — only a masked tail so the admin recognizes it. */
function maskKey(apiKey: string): string {
  if (!apiKey) return ''
  if (apiKey.length <= 8) return '••••'
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`
}

app.get('/keys', async (c) => {
  try {
    const keys = await db.translationApiKey.findMany({ orderBy: { updatedAt: 'desc' } })
    return c.json({
      success: true,
      data: {
        keys: keys.map((k) => ({
          id: k.id, label: k.label, provider: k.provider, baseUrl: k.baseUrl,
          model: k.model, isActive: k.isActive, maskedKey: maskKey(k.apiKey),
          lastTestAt: k.lastTestAt, lastTestOk: k.lastTestOk, lastTestMessage: k.lastTestMessage,
          createdAt: k.createdAt, updatedAt: k.updatedAt,
        })),
      },
    })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.post('/keys', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const label = String(body.label || '').trim().slice(0, 60)
    const provider = String(body.provider || 'zai').trim()
    const apiKey = String(body.apiKey || '').trim()
    if (!label) return c.json({ success: false, error: 'label is required' }, 400)
    if (!['zai', 'openai-compatible'].includes(provider)) return c.json({ success: false, error: 'invalid provider' }, 400)
    if (provider === 'openai-compatible') {
      if (!apiKey) return c.json({ success: false, error: 'apiKey is required' }, 400)
      const baseUrl = String(body.baseUrl || '').trim()
      if (!/^https?:\/\//.test(baseUrl)) return c.json({ success: false, error: 'baseUrl must be an http(s) URL' }, 400)
    }
    const model = String(body.model || '').trim().slice(0, 80) || null
    const key = await db.translationApiKey.create({
      data: {
        label, provider,
        apiKey: apiKey || 'SDK-MANAGED',
        baseUrl: provider === 'openai-compatible' ? String(body.baseUrl).trim() : null,
        model,
        isActive: body.isActive !== false,
      },
    })
    return c.json({ success: true, data: { id: key.id } }, 201)
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.patch('/keys/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) data.label = String(body.label).trim().slice(0, 60) || 'key'
    if (body.model !== undefined) data.model = String(body.model || '').trim().slice(0, 80) || null
    if (body.baseUrl !== undefined) data.baseUrl = String(body.baseUrl || '').trim() || null
    if (body.apiKey !== undefined && String(body.apiKey).trim()) data.apiKey = String(body.apiKey).trim()
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive
    const key = await db.translationApiKey.update({ where: { id }, data })
    return c.json({ success: true, data: { id: key.id } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.delete('/keys/:id', async (c) => {
  try {
    await db.translationApiKey.delete({ where: { id: c.req.param('id') } })
    return c.json({ success: true })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

app.post('/keys/:id/test', async (c) => {
  try {
    const result = await testTranslationApiKey(c.req.param('id'))
    return c.json({ success: true, data: result })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

// ─── Category enrichment entry point (Category Language page) ───────────────

app.post('/enqueue-category', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const categoryId = String(body.categoryId || '').trim()
    if (!categoryId) return c.json({ success: false, error: 'categoryId is required' }, 400)
    const summary = await enqueueCategoryTranslations(categoryId)
    return c.json({ success: true, data: { summary } })
  } catch (error: unknown) {
    const err = authErrorResponse(error)
    return c.json({ success: err.success, error: err.error }, err.status as 500)
  }
})

// Exported for index.ts — the boot hook also warms the singleton row.
export { startTranslationAgentScheduler }
export default app
