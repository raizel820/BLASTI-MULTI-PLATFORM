/**
 * @blasti/api — Admin Providers & Templates routes (Task 22)
 *
 * SUPER_ADMIN-only CRUD for the messaging provider configuration and the
 * editable notification templates. Mounted at /api/admin/providers.
 *
 * Channels: SMS (eSMS Africa) · EMAIL (Resend) · WHATSAPP (Meta Cloud API)
 *
 * Routes:
 *   GET   /                            → all channel configs (masked) + registry metadata
 *   PUT   /:channel                    → save channel config (secrets encrypted)
 *   POST  /:channel/test               → send a test message via the channel
 *   GET   /:channel/provider-templates → list provider-side templates (WhatsApp Graph)
 *   GET   /templates                   → list app templates (optionally ?channel=&key=)
 *   POST  /templates                   → create a template
 *   PUT   /templates/:id               → update a template
 *   DELETE /templates/:id              → delete a template
 *   POST  /templates/seed              → re-create any missing default templates
 *   POST  /templates/preview           → render a template with sample variables
 *   GET   /logs                        → recent SmsLog entries (sms+whatsapp)
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '@blasti/db'
import { requireAdmin, authErrorResponse } from '../lib/auth'
import { validateBody } from '../lib/validations'
import {
  PROVIDER_REGISTRY,
  CHANNELS,
  type Channel,
} from '../lib/messaging/provider-registry'
import {
  getProviderConfigMasked,
  saveProviderConfig,
  recordTestResult,
} from '../lib/messaging/provider-config'
import { DEV_BYPASS_CODES } from '../lib/verification-service'
import { sendTestEmail } from '../lib/messaging/email-service'
import { sendTestSms } from '../lib/messaging/sms-sender'
import { sendTestWhatsApp, listWhatsAppTemplates } from '../lib/messaging/whatsapp-service'
import {
  ensureDefaultTemplates,
  renderTemplate,
  TEMPLATE_CATALOG,
} from '../lib/messaging/template-service'

const app = new Hono()

function isChannel(value: string): value is Channel {
  return (CHANNELS as string[]).includes(value)
}

// ─── GET / — configs + registry ──────────────────────────────────────────────

app.get('/', async (c) => {
  try {
    await requireAdmin(c)

    const configs = await Promise.all(CHANNELS.map(ch => getProviderConfigMasked(ch)))

    return c.json({
      success: true,
      channels: configs,
      registry: CHANNELS.map(ch => ({
        ...PROVIDER_REGISTRY[ch],
        fields: PROVIDER_REGISTRY[ch].fields.map(f => ({ ...f, help: f.help })),
        extraFields: PROVIDER_REGISTRY[ch].extraFields ?? [],
      })),
      catalog: TEMPLATE_CATALOG,
      devBypass: process.env.NODE_ENV !== 'production' || process.env.VERIFICATION_DEV_BYPASS === 'true',
      devCodes: process.env.NODE_ENV !== 'production' ? { SMS: DEV_BYPASS_CODES.SMS, EMAIL: DEV_BYPASS_CODES.EMAIL } : undefined,
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── PUT /:channel — save config ─────────────────────────────────────────────

const saveConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().max(512).optional(),
  apiKeyIsMasked: z.boolean().optional(),
  senderId: z.string().max(120).optional(),
  phoneNumberId: z.string().max(64).optional(),
  accountId: z.string().max(64).optional(),
  apiUrl: z.string().max(256).optional(),
  extra: z.record(z.string(), z.string().max(512).optional()).optional(),
})

app.put('/:channel', async (c) => {
  try {
    await requireAdmin(c)
    const channel = c.req.param('channel')
    if (!isChannel(channel)) {
      return c.json({ success: false, error: `Invalid channel. Allowed: ${CHANNELS.join(', ')}` }, 400)
    }

    const body = await c.req.json()
    const validation = validateBody(saveConfigSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const data = validation.data

    const saved = await saveProviderConfig({
      channel,
      enabled: data.enabled,
      apiKey: data.apiKey,
      apiKeyIsMasked: data.apiKeyIsMasked,
      senderId: data.senderId,
      phoneNumberId: data.phoneNumberId,
      accountId: data.accountId,
      apiUrl: data.apiUrl,
      extra: data.extra as Record<string, string | undefined>,
    })

    // Sender ID sanity (SMS alphanumeric sender max 11 chars)
    if (channel === 'SMS' && saved.senderId && saved.senderId.length > 11) {
      await recordTestResult(channel, false, 'Sender ID must be 11 characters or fewer')
      return c.json({ success: false, error: 'Sender ID must be 11 characters or fewer' }, 400)
    }

    return c.json({ success: true, config: await getProviderConfigMasked(channel) })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── POST /:channel/test — send test message ────────────────────────────────

app.post('/:channel/test', async (c) => {
  try {
    await requireAdmin(c)
    const channel = c.req.param('channel')
    if (!isChannel(channel)) {
      return c.json({ success: false, error: `Invalid channel. Allowed: ${CHANNELS.join(', ')}` }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    const { to } = body as { to?: string }
    if (!to) {
      return c.json({ success: false, error: 'Test recipient (to) is required' }, 400)
    }

    let result: { success: boolean; error?: string; responseRaw?: string; providerMessageId?: string }
    if (channel === 'EMAIL') result = await sendTestEmail(to)
    else if (channel === 'SMS') result = await sendTestSms(to)
    else result = await sendTestWhatsApp(to)

    return c.json({ success: result.success, error: result.error, responseRaw: result.responseRaw, providerMessageId: result.providerMessageId })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /:channel/provider-templates — provider-side templates ─────────────

app.get('/:channel/provider-templates', async (c) => {
  try {
    await requireAdmin(c)
    const channel = c.req.param('channel')

    if (channel === 'WHATSAPP') {
      const r = await listWhatsAppTemplates()
      return c.json({
        success: r.success,
        error: r.error,
        templates: r.templates.filter(t => t.status === 'APPROVED'),
      })
    }
    // Resend and eSMS Africa have no server-side template gallery:
    // app-side templates are THE templates for those channels.
    return c.json({
      success: true,
      templates: [],
      note: channel === 'EMAIL'
        ? 'Resend has no server-side template gallery — manage email templates in the Templates tab (they are delivered through the Resend /emails endpoint).'
        : 'eSMS Africa has no server-side template gallery — manage SMS templates in the Templates tab.',
    })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── Templates CRUD ──────────────────────────────────────────────────────────

const templateSchema = z.object({
  key: z.string().min(1).max(64),
  channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']),
  language: z.enum(['ar', 'fr', 'en']).default('en'),
  name: z.string().min(1).max(120),
  subject: z.string().max(200).optional().nullable(),
  body: z.string().min(1).max(4000),
  htmlBody: z.string().max(20000).optional().nullable(),
  variables: z.array(z.string().max(40)).optional(),
  useProviderTemplate: z.boolean().optional(),
  providerTemplateId: z.string().max(120).optional().nullable(),
  providerTemplateLang: z.string().max(20).optional().nullable(),
  enabled: z.boolean().optional(),
})

app.get('/templates', async (c) => {
  try {
    await requireAdmin(c)
    await ensureDefaultTemplates()

    const channel = c.req.query('channel')
    const key = c.req.query('key')
    const templates = await db.notificationTemplate.findMany({
      where: {
        ...(channel && isChannel(channel) ? { channel } : {}),
        ...(key ? { key } : {}),
      },
      orderBy: [{ key: 'asc' }, { channel: 'asc' }, { language: 'asc' }],
    })
    return c.json({ success: true, templates, catalog: TEMPLATE_CATALOG })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

app.post('/templates', async (c) => {
  try {
    await requireAdmin(c)
    const body = await c.req.json()
    const validation = validateBody(templateSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const d = validation.data
    const template = await db.notificationTemplate.upsert({
      where: { key_channel_language: { key: d.key, channel: d.channel, language: d.language } },
      create: {
        key: d.key,
        channel: d.channel,
        language: d.language,
        name: d.name,
        subject: d.subject ?? null,
        body: d.body,
        htmlBody: d.htmlBody ?? null,
        variables: JSON.stringify(d.variables ?? []),
        useProviderTemplate: d.useProviderTemplate ?? false,
        providerTemplateId: d.providerTemplateId ?? null,
        providerTemplateLang: d.providerTemplateLang ?? null,
        enabled: d.enabled ?? true,
      },
      update: {
        name: d.name,
        subject: d.subject ?? null,
        body: d.body,
        htmlBody: d.htmlBody ?? null,
        variables: JSON.stringify(d.variables ?? []),
        useProviderTemplate: d.useProviderTemplate ?? false,
        providerTemplateId: d.providerTemplateId ?? null,
        providerTemplateLang: d.providerTemplateLang ?? null,
        enabled: d.enabled ?? true,
      },
    })
    return c.json({ success: true, template }, 201)
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

app.put('/templates/:id', async (c) => {
  try {
    await requireAdmin(c)
    const id = c.req.param('id')
    const body = await c.req.json()
    const validation = validateBody(templateSchema.partial(), body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const d = validation.data
    const existing = await db.notificationTemplate.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Template not found' }, 404)
    }
    const template = await db.notificationTemplate.update({
      where: { id },
      data: {
        name: d.name ?? undefined,
        subject: d.subject !== undefined ? d.subject : undefined,
        body: d.body ?? undefined,
        htmlBody: d.htmlBody !== undefined ? d.htmlBody : undefined,
        variables: d.variables ? JSON.stringify(d.variables) : undefined,
        useProviderTemplate: d.useProviderTemplate ?? undefined,
        providerTemplateId: d.providerTemplateId !== undefined ? d.providerTemplateId : undefined,
        providerTemplateLang: d.providerTemplateLang !== undefined ? d.providerTemplateLang : undefined,
        enabled: d.enabled ?? undefined,
      },
    })
    return c.json({ success: true, template })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

app.delete('/templates/:id', async (c) => {
  try {
    await requireAdmin(c)
    const id = c.req.param('id')
    const existing = await db.notificationTemplate.findUnique({ where: { id } })
    if (!existing) {
      return c.json({ success: false, error: 'Template not found' }, 404)
    }
    await db.notificationTemplate.delete({ where: { id } })
    return c.json({ success: true })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

app.post('/templates/seed', async (c) => {
  try {
    await requireAdmin(c)
    await ensureDefaultTemplates()
    const count = await db.notificationTemplate.count()
    return c.json({ success: true, message: 'Defaults ensured', totalTemplates: count })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

const previewSchema = z.object({
  key: z.string().min(1),
  channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']),
  language: z.enum(['ar', 'fr', 'en']).default('en'),
  vars: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})

app.post('/templates/preview', async (c) => {
  try {
    await requireAdmin(c)
    const body = await c.req.json()
    const validation = validateBody(previewSchema, body)
    if (validation.error) {
      return c.json({ success: false, error: validation.error.error, details: validation.error.details }, 400)
    }
    const { key, channel, language, vars } = validation.data
    const rendered = await renderTemplate(key, channel, language, vars ?? {})
    if (!rendered) {
      return c.json({ success: false, error: 'Template missing or disabled' }, 404)
    }
    return c.json({ success: true, rendered })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

// ─── GET /logs — recent outbound messages ────────────────────────────────────

app.get('/logs', async (c) => {
  try {
    await requireAdmin(c)
    const limit = Math.min(Number(c.req.query('limit') || 20), 100)
    const logs = await db.smsLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, userId: true, phoneNumber: true, message: true,
        status: true, provider: true, errorMessage: true, createdAt: true,
      },
    })
    return c.json({ success: true, logs })
  } catch (error) {
    const err = authErrorResponse(error)
    return c.json({ success: false, error: err.error }, err.status as 400)
  }
})

export const adminProviderRoutes = app
