/**
 * @blasti/api — Meta WhatsApp Cloud API adapter (Task 22)
 *
 * Replaces the previous fake-success WhatsApp stub in notification-router.ts
 * with real Graph API calls:
 *   - free-form text (24h customer service window only)
 *   - approved template messages (authentication OTP + notifications)
 *   - template gallery listing (for the admin "use a provider template" switch)
 */

import { getResolvedConfig, recordTestResult } from './provider-config'

export interface WhatsAppSendResult {
  success: boolean
  error?: string
  responseRaw?: string
  providerMessageId?: string
  /** true when the caller should fall back to another channel (e.g. SMS OTP) */
  fallbackToSms?: boolean
}

interface Recipient {
  phoneNumber: string
}

function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production'
}

async function postMessage(body: Record<string, unknown>): Promise<WhatsAppSendResult> {
  const config = await getResolvedConfig('WHATSAPP')

  if (!config.enabled || !config.apiKey || !config.phoneNumberId) {
    return { success: false, error: 'WHATSAPP_NOT_CONFIGURED', fallbackToSms: true }
  }

  try {
    const res = await fetch(`${config.apiUrl}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        ...body,
      }),
      signal: AbortSignal.timeout(15000),
    })

    const raw = await res.text()
    if (!res.ok) {
      // 131047 = re-engagement message (outside 24h window without template)
      const fb = /"error_subcode"\s*:\s*(\d+)/.exec(raw)
      const subcode = fb?.[1]
      return {
        success: false,
        error: `WHATSAPP_HTTP_${res.status}${subcode ? `_SUB_${subcode}` : ''}`,
        responseRaw: raw.slice(0, 400),
        fallbackToSms: subcode === '131047',
      }
    }
    try {
      const json = JSON.parse(raw) as { messages?: Array<{ id?: string }> }
      return { success: true, providerMessageId: json.messages?.[0]?.id, responseRaw: raw.slice(0, 200) }
    } catch {
      return { success: true, responseRaw: raw.slice(0, 200) }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'WHATSAPP_SEND_FAILED' }
  }
}

function normalizeRecipient(phoneNumber: string): string {
  // Graph API expects the number WITHOUT '+' and without spaces
  return phoneNumber.replace(/[\s\-().]/g, '').replace(/^\+/, '')
}

/** Free-form text — only delivered inside the 24h customer service window. */
export async function sendWhatsAppText(phoneNumber: string, message: string): Promise<WhatsAppSendResult> {
  if (isDevMode()) {
    const config = await getResolvedConfig('WHATSAPP')
    if (!config.enabled || !config.apiKey) {
      console.log(`[whatsapp:dev-simulate] to=${phoneNumber}\n${message}`)
      return { success: true, providerMessageId: 'dev-simulated' }
    }
  }
  return postMessage({
    to: normalizeRecipient(phoneNumber),
    type: 'text',
    text: { preview_url: false, body: message },
  })
}

/**
 * Send an approved template message.
 * components follow the Graph API shape, e.g.
 * [{ type: 'body', parameters: [{ type: 'text', text: '...' }] }]
 * or for authentication templates:
 * [{ type: 'body', parameters: [{ type: 'text', text: code }] },
 *  { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }]
 */
export async function sendWhatsAppTemplate(
  phoneNumber: string,
  templateName: string,
  languageCode: string,
  components: Array<Record<string, unknown>> = [],
): Promise<WhatsAppSendResult> {
  if (isDevMode()) {
    const config = await getResolvedConfig('WHATSAPP')
    if (!config.enabled || !config.apiKey) {
      console.log(`[whatsapp:dev-simulate] template=${templateName} to=${phoneNumber}`)
      return { success: true, providerMessageId: 'dev-simulated' }
    }
  }
  return postMessage({
    to: normalizeRecipient(phoneNumber),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode || 'en' },
      ...(components.length ? { components } : {}),
    },
  })
}

/** OTP through an approved AUTHENTICATION template (copy-code/one-tap). */
export async function sendWhatsAppOtp(recipient: Recipient & { code: string; templateName?: string; languageCode?: string }): Promise<WhatsAppSendResult> {
  const { phoneNumber, code, templateName, languageCode } = recipient
  const config = await getResolvedConfig('WHATSAPP')
  const tpl = templateName || config.extra.otpTemplateName || ''
  if (!tpl) {
    // No approved authentication template selected → caller should fall back to SMS
    return { success: false, error: 'WHATSAPP_OTP_TEMPLATE_NOT_SELECTED', fallbackToSms: true }
  }
  return sendWhatsAppTemplate(phoneNumber, tpl, languageCode || config.extra.otpTemplateLang || 'en', [
    { type: 'body', parameters: [{ type: 'text', text: code }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
  ])
}

export interface ProviderTemplateInfo {
  name: string
  language: string
  status: string
  category: string
  /** For authentication templates: the button style if present */
  components?: Array<Record<string, unknown>>
}

/** List approved message templates from the WABA (for the admin template switcher). */
export async function listWhatsAppTemplates(): Promise<{ success: boolean; error?: string; templates: ProviderTemplateInfo[] }> {
  const config = await getResolvedConfig('WHATSAPP')
  if (!config.apiKey || !config.accountId) {
    return { success: false, error: 'WHATSAPP_NOT_CONFIGURED', templates: [] }
  }
  try {
    const res = await fetch(
      `${config.apiUrl}/${config.accountId}/message_templates?limit=100&fields=name,status,category,language,components`,
      {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(15000),
      },
    )
    const raw = await res.text()
    if (!res.ok) {
      return { success: false, error: `GRAPH_HTTP_${res.status}: ${raw.slice(0, 200)}`, templates: [] }
    }
    const json = JSON.parse(raw) as {
      data?: Array<{ name: string; status: string; category: string; language: string; components?: Array<Record<string, unknown>> }>
    }
    const templates = (json.data ?? []).map(t => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      components: t.components,
    }))
    return { success: true, templates }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'GRAPH_REQUEST_FAILED', templates: [] }
  }
}

/** Admin "send test WhatsApp message" — records the outcome on the ProviderConfig row. */
export async function sendTestWhatsApp(to?: string): Promise<WhatsAppSendResult & { recorded: boolean }> {
  const config = await getResolvedConfig('WHATSAPP')
  const target = to || config.extra.testPhoneNumber
  if (!target) {
    return { success: false, error: 'TEST_PHONE_REQUIRED', recorded: false }
  }
  const result = await sendWhatsAppText(
    target,
    `[BLASTI] ${new Date().toISOString()} — Test WhatsApp message / رسالة اختبار. The WhatsApp Cloud API integration is working.`,
  )
  await recordTestResult('WHATSAPP', result.success, result.error ?? result.responseRaw)
  return { ...result, recorded: true }
}
