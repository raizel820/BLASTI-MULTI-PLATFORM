/**
 * @blasti/api — eSMS Africa adapter (Task 22)
 *
 * Sends SMS through the eSMS Africa REST API
 * (POST {apiUrl}/sms/send, Bearer auth). Direct routes to Algerian
 * operators (Mobilis / Djezzy / Ooredoo) — replaces the previous hardcoded
 * WinSMS/NotifSend/AlgeriaSMS/GreenSMS/M-Target/Twilio/Vonage/generic set.
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
 * Send an SMS via eSMS Africa. In dev mode with no configured provider the
 * send is simulated successfully (console log) so verification flows and the
 * cron reminders work offline.
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

  // eSMS Africa routes African networks directly; normalize DZ numbers when possible
  const normalized = normalizeDzPhone(phoneNumber) || phoneNumber

  try {
    const res = await fetch(`${config.apiUrl}/sms/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        to: normalized,
        sender_id: config.senderId || 'BLASTI',
        message,
        type: 'unicode',
      }),
      signal: AbortSignal.timeout(15000),
    })

    const raw = await res.text()
    if (!res.ok) {
      return { success: false, error: `ESMS_HTTP_${res.status}`, responseRaw: raw.slice(0, 400) }
    }
    try {
      const json = JSON.parse(raw) as { id?: string; message_id?: string; status?: string }
      // Some gateways return 200 with an error payload — honor an explicit error status
      if (json.status && /fail|error|reject/i.test(json.status)) {
        return { success: false, error: `ESMS_STATUS_${json.status}`, responseRaw: raw.slice(0, 400) }
      }
      return { success: true, providerMessageId: json.id ?? json.message_id, responseRaw: raw.slice(0, 200) }
    } catch {
      return { success: true, responseRaw: raw.slice(0, 200) }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'SMS_SEND_FAILED' }
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
