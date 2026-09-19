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
