/**
 * @blasti/api — eSMS Africa adapter (Task 22 / Task 3 docs-conformance pass)
 *
 * Sends SMS through the eSMS Africa REST API per the OFFICIAL documentation
 * (https://esmsafrica.io/docs — API Reference):
 *
 *   POST {apiUrl}/messages/send      { to (E.164), text, sender_id? }   Bearer auth
 *     → 200 { id, status: 'submitted' | 'scheduled' | 'failed' }
 *   GET  {apiUrl}/balance            wallet check (free — used by Test)
 *
 * Error envelope: { error: { code, message } } — HTTP-level codes are mapped
 * to human-readable messages below.
 *
 * ⚠️ The previously guessed shape (POST {apiUrl}/sms/send with {to, message,
 * type}) is NOT part of the documented API and would 404 in production.
 *
 * Direct routes to Algerian operators (Mobilis / Djezzy / Ooredoo) — replaces
 * the previous hardcoded WinSMS/NotifSend/AlgeriaSMS/GreenSMS/M-Target/
 * Twilio/Vonage/generic set.
 */

import { getResolvedConfig, recordTestResult } from './provider-config'
import { normalizeDzPhone } from '../sms-service'

export interface SendSmsProviderResult {
  success: boolean
  error?: string
  responseRaw?: string
  providerMessageId?: string
}

function isDevMode(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * Map the documented eSMS Africa error codes/HTTP statuses to readable
 * messages the admin (and the OTP UI) can act on.
 */
function mapEsmsError(httpStatus: number, raw: string): string {
  let code: string | undefined
  let message: string | undefined
  try {
    const json = JSON.parse(raw) as { error?: { code?: string | number; message?: string } }
    code = json.error?.code !== undefined ? String(json.error.code) : undefined
    message = json.error?.message
  } catch {
    // Non-JSON error body — fall through to the HTTP-status mapping
  }
  const statusKey = code || String(httpStatus)
  switch (statusKey) {
    case '401':
      return `eSMS Africa: missing or invalid API key (401)${message ? ` — ${message}` : ''}`
    case '402':
      return `eSMS Africa: insufficient wallet balance (402). Top up at sms.esmsafrica.io${message ? ` — ${message}` : ''}`
    case '403':
      return `eSMS Africa: sender not approved or recipient opted out (403). Register the sender ID in the dashboard or use the route default.${message ? ` — ${message}` : ''}`
    case '409':
      return `eSMS Africa: duplicate — the same message was sent to this number within 5 minutes (409).${message ? ` — ${message}` : ''}`
    case '413':
      return `eSMS Africa: message too long (413).${message ? ` — ${message}` : ''}`
    case '422':
      return `eSMS Africa: invalid request payload (422). Check the number format (E.164, e.g. +213555123456).${message ? ` — ${message}` : ''}`
    case '429':
      return `eSMS Africa: rate limit exceeded (429) — max 20 messages/second.${message ? ` — ${message}` : ''}`
    default:
      return `eSMS Africa: HTTP ${httpStatus}${message ? ` — ${message}` : ''}`
  }
}

/**
 * Send an SMS via eSMS Africa (POST {apiUrl}/messages/send).
 * In dev mode with no configured provider the send is simulated successfully
 * (console log) so verification flows and the cron reminders work offline.
 */
export async function sendSmsViaProvider(phoneNumber: string, message: string): Promise<SendSmsProviderResult> {
  const config = await getResolvedConfig('SMS')

  if (!config.enabled || !config.apiKey) {
    if (isDevMode()) {
      console.log(`[sms:dev-simulate] to=${phoneNumber}\n${message}`)
      return { success: true, providerMessageId: 'dev-simulated' }
    }
    return { success: false, error: 'SMS_NOT_CONFIGURED' }
  }

  // The documented API requires E.164 numbers (e.g. +213555123456)
  const normalized = normalizeDzPhone(phoneNumber) || phoneNumber

  try {
    const res = await fetch(`${config.apiUrl}/messages/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        to: normalized,
        text: message,
        // Optional approved alphanumeric sender; empty → route default sender
        ...(config.senderId ? { sender_id: config.senderId } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    })

    const raw = await res.text()
    if (!res.ok) {
      return { success: false, error: mapEsmsError(res.status, raw), responseRaw: raw.slice(0, 400) }
    }
    try {
      const json = JSON.parse(raw) as { id?: string; message_id?: string; status?: string }
      // Documented statuses: submitted | scheduled | failed
      if (json.status && /fail|error|reject/i.test(json.status)) {
        return { success: false, error: mapEsmsError(res.status, raw), responseRaw: raw.slice(0, 400) }
      }
      return { success: true, providerMessageId: json.id ?? json.message_id, responseRaw: raw.slice(0, 200) }
    } catch {
      return { success: true, responseRaw: raw.slice(0, 200) }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'SMS_SEND_FAILED' }
  }
}

/** Free connection-check result (no message sent — key reachability probe) */
export interface ConnectionCheckResult {
  ok: boolean
  error?: string
  responseRaw?: string
  details?: Record<string, unknown>
}

/** Best-effort wallet-balance extraction from whatever JSON shape the gateway returns */
function extractBalance(json: Record<string, unknown>): { balance?: unknown; currency?: unknown } {
  const nested = json.data as Record<string, unknown> | undefined
  const candidates = [json.balance, json.credits, json.credit, json.amount, nested?.balance]
  const first = candidates.find((v) => v !== undefined && v !== null)
  if (first === undefined) return {}
  if (typeof first === 'object') {
    const obj = first as Record<string, unknown>
    const amount = obj.amount ?? obj.value ?? obj.balance
    return amount !== undefined
      ? { balance: amount, currency: obj.currency ?? json.currency }
      : {}
  }
  return { balance: first, currency: json.currency }
}

/**
 * FREE connection probe — GET {apiUrl}/balance with the Bearer key.
 * No message is sent; it validates that the stored API key is accepted by
 * eSMS Africa and surfaces the wallet balance when the gateway reports it.
 */
export async function getEsmsBalance(): Promise<ConnectionCheckResult> {
  const config = await getResolvedConfig('SMS')
  if (!config.apiKey) {
    return { ok: false, error: 'SMS_NOT_CONFIGURED — no API key stored' }
  }
  try {
    const res = await fetch(`${config.apiUrl}/balance`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    const raw = await res.text()
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Invalid API key — eSMS Africa rejected the credential', responseRaw: raw.slice(0, 400) }
    }
    if (!res.ok) {
      return { ok: false, error: mapEsmsError(res.status, raw), responseRaw: raw.slice(0, 400) }
    }
    let details: Record<string, unknown> | undefined
    try {
      const { balance, currency } = extractBalance(JSON.parse(raw) as Record<string, unknown>)
      if (balance !== undefined) {
        details = { balance, ...(currency !== undefined ? { currency } : {}) }
      }
    } catch {
      // Non-JSON answer — still a reachable provider, details stay undefined
    }
    return { ok: true, details }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'ESMS_BALANCE_CHECK_FAILED' }
  }
}

/** Admin "send test SMS" — records the outcome on the ProviderConfig row. */
export async function sendTestSms(to?: string): Promise<SendSmsProviderResult & { recorded: boolean }> {
  const config = await getResolvedConfig('SMS')
  const target = to || config.extra.testPhoneNumber
  if (!target) {
    return { success: false, error: 'TEST_PHONE_REQUIRED', recorded: false }
  }
  const result = await sendSmsViaProvider(
    target,
    `[BLASTI] ${new Date().toISOString()} — Test SMS / رسالة اختبار. If you receive this, the eSMS Africa gateway is working.`,
  )
  await recordTestResult('SMS', result.success, result.error ?? result.responseRaw)
  return { ...result, recorded: true }
}
