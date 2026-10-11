/**
 * @blasti/api — Resend email adapter (Task 22)
 *
 * Sends transactional email through the Resend REST API
 * (POST {apiUrl}/emails, Bearer auth). Templates are app-side
 * (NotificationTemplate) — see template-service.ts.
 */

import { getResolvedConfig, recordTestResult } from './provider-config'

export interface SendEmailResult {
  success: boolean
  error?: string
  responseRaw?: string
  providerMessageId?: string
}

interface EmailPayload {
  to: string | string[]
  subject: string
  text?: string
  html?: string
  replyTo?: string
}

function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * Send an email via Resend. In dev mode with no configured provider the send
 * is simulated successfully (console log) so verification flows work offline.
 */
export async function sendEmail(payload: EmailPayload): Promise<SendEmailResult> {
  const config = await getResolvedConfig('EMAIL')

  if (!config.enabled || !config.apiKey || !config.senderId) {
    if (isDevMode()) {
      console.log(`[email:dev-simulate] to=${payload.to} subject="${payload.subject}"\n${payload.text ?? payload.html ?? ''}`)
      return { success: true, providerMessageId: 'dev-simulated' }
    }
    return { success: false, error: 'EMAIL_NOT_CONFIGURED' }
  }

  try {
    const res = await fetch(`${config.apiUrl}/emails`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        from: config.senderId,
        to: Array.isArray(payload.to) ? payload.to : [payload.to],
        subject: payload.subject,
        text: payload.text || undefined,
        html: payload.html || undefined,
        reply_to: payload.replyTo || config.extra.replyTo || undefined,
      }),
      signal: AbortSignal.timeout(15000),
    })

    const raw = await res.text()
    if (!res.ok) {
      return { success: false, error: `RESEND_HTTP_${res.status}`, responseRaw: raw.slice(0, 400) }
    }
    try {
      const json = JSON.parse(raw) as { id?: string }
      return { success: true, providerMessageId: json.id }
    } catch {
      return { success: true, responseRaw: raw.slice(0, 200) }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'EMAIL_SEND_FAILED' }
  }
}

/** Free connection-check result (no message sent — key reachability probe) */
export interface EmailConnectionCheckResult {
  ok: boolean
  error?: string
  responseRaw?: string
  details?: Record<string, unknown>
}

/**
 * FREE connection probe — GET {apiUrl}/domains with the Bearer key (Resend).
 * No email is sent; it validates that the stored API key is accepted by
 * Resend and surfaces the verified-domain count. 401 maps to "invalid API key".
 */
export async function checkEmailConnection(): Promise<EmailConnectionCheckResult> {
  const config = await getResolvedConfig('EMAIL')
  if (!config.apiKey) {
    return { ok: false, error: 'EMAIL_NOT_CONFIGURED — no API key stored' }
  }
  try {
    const res = await fetch(`${config.apiUrl}/domains`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    const raw = await res.text()
    // Resend maps a malformed/revoked key to 401 — but also 400 validation_error
    // with "API key is invalid" in the body — surface both as an invalid key.
    if (res.status === 401 || res.status === 403 || /api.?key.{0,20}(invalid|missing)|invalid.{0,20}api.?key/i.test(raw)) {
      return { ok: false, error: 'Invalid API key — Resend rejected the credential', responseRaw: raw.slice(0, 400) }
    }
    if (!res.ok) {
      return { ok: false, error: `RESEND_HTTP_${res.status}`, responseRaw: raw.slice(0, 400) }
    }
    let domainCount: number | undefined
    try {
      const json = JSON.parse(raw) as { data?: unknown[]; total?: number }
      domainCount = typeof json.total === 'number' ? json.total : Array.isArray(json.data) ? json.data.length : undefined
    } catch {
      // Non-JSON answer — still a reachable provider
    }
    return { ok: true, details: domainCount !== undefined ? { domainCount } : undefined }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'RESEND_CONNECTION_CHECK_FAILED' }
  }
}

/** Admin "send test email" — records the outcome on the ProviderConfig row. */
export async function sendTestEmail(to?: string): Promise<SendEmailResult & { recorded: boolean }> {
  const config = await getResolvedConfig('EMAIL')
  const target = to || config.extra.testEmailAddress
  if (!target) {
    return { success: false, error: 'TEST_EMAIL_ADDRESS_REQUIRED', recorded: false }
  }
  const result = await sendEmail({
    to: target,
    subject: '[BLASTI] Test email — email provider is working',
    text: `BLASTI test email (${new Date().toISOString()}).\n\nIf you received this message, the Resend integration is configured correctly.`,
  })
  await recordTestResult('EMAIL', result.success, result.error ?? result.responseRaw)
  return { ...result, recorded: true }
}
