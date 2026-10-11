/**
 * @blasti/api — Notification template service (Task 22)
 *
 * App-side editable templates (NotificationTemplate table) with seeded
 * defaults per (key, channel, language). Variables use {{name}} placeholders.
 *
 * The admin UI edits these rows; delivery code calls renderTemplate() and, for
 * WhatsApp, can switch to a provider-side approved template per row
 * (useProviderTemplate + providerTemplateId).
 */

import { db } from '@blasti/db'
import { sendEmail } from './email-service'
import { sendSmsViaProvider } from './sms-sender'
import { sendWhatsAppText, sendWhatsAppTemplate, type WhatsAppSendResult } from './whatsapp-service'

export type TemplateChannel = 'EMAIL' | 'SMS' | 'WHATSAPP'

export interface TemplateVars {
  [variable: string]: string | number | undefined
}

interface TemplateSeed {
  key: string
  channel: TemplateChannel
  language: string
  name: string
  subject?: string
  body: string
  htmlBody?: string
  variables: string[]
}

const APP_NAME = 'BLASTI'

// ─── Seeded defaults ─────────────────────────────────────────────────────────

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  // ── Verification (EMAIL) ──
  {
    key: 'verify_email', channel: 'EMAIL', language: 'en', name: 'Email verification',
    subject: `${APP_NAME} — Your verification code`,
    body: `Hello {{fullName}},\n\nYour ${APP_NAME} verification code is: {{code}}\n\nThis code expires in {{expiryMinutes}} minutes. If you did not request it, you can safely ignore this email.\n\n— The ${APP_NAME} Team`,
    htmlBody: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#059669">${APP_NAME}</h2><p>Hello {{fullName}},</p><p>Your verification code is:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#059669">{{code}}</p><p style="color:#6b7280">This code expires in {{expiryMinutes}} minutes. If you did not request it, you can safely ignore this email.</p></div>`,
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'verify_email', channel: 'EMAIL', language: 'ar', name: 'تأكيد البريد الإلكتروني',
    subject: `${APP_NAME} — رمز التحقق الخاص بك`,
    body: `مرحباً {{fullName}}،\n\nرمز التحقق الخاص بك في ${APP_NAME} هو: {{code}}\n\nتنتهي صلاحية هذا الرمز خلال {{expiryMinutes}} دقيقة. إذا لم تطلبه يمكنك تجاهل هذه الرسالة بأمان.\n\n— فريق ${APP_NAME}`,
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'verify_email', channel: 'EMAIL', language: 'fr', name: 'Vérification de l\'email',
    subject: `${APP_NAME} — Votre code de vérification`,
    body: `Bonjour {{fullName}},\n\nVotre code de vérification ${APP_NAME} est : {{code}}\n\nCe code expire dans {{expiryMinutes}} minutes. Si vous ne l'avez pas demandé, ignorez simplement cet email.\n\n— L'équipe ${APP_NAME}`,
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  // ── Verification (SMS) ──
  {
    key: 'verify_phone', channel: 'SMS', language: 'en', name: 'Phone verification',
    body: `${APP_NAME}: Your verification code is {{code}}. Valid for {{expiryMinutes}} minutes.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'verify_phone', channel: 'SMS', language: 'ar', name: 'تأكيد رقم الهاتف',
    body: `${APP_NAME}: رمز التحقق الخاص بك هو {{code}}. صالح لمدة {{expiryMinutes}} دقيقة.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'verify_phone', channel: 'SMS', language: 'fr', name: 'Vérification du téléphone',
    body: `${APP_NAME} : Votre code de vérification est {{code}}. Valable {{expiryMinutes}} minutes.`,
    variables: ['code', 'expiryMinutes'],
  },
  // ── Verification (WHATSAPP) ──
  {
    key: 'verify_phone', channel: 'WHATSAPP', language: 'en', name: 'Phone verification (WhatsApp)',
    body: `${APP_NAME}: Your verification code is *{{code}}*. Valid for {{expiryMinutes}} minutes.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'verify_phone', channel: 'WHATSAPP', language: 'ar', name: 'تأكيد الهاتف عبر واتساب',
    body: `${APP_NAME}: رمز التحقق الخاص بك هو *{{code}}*. صالح لمدة {{expiryMinutes}} دقيقة.`,
    variables: ['code', 'expiryMinutes'],
  },
  // ── Password reset (EMAIL) ──
  {
    key: 'password_reset', channel: 'EMAIL', language: 'en', name: 'Password reset',
    subject: `${APP_NAME} — Reset your password`,
    body: `Hello {{fullName}},\n\nUse this code to reset your password: {{code}}\n\nIt expires in {{expiryMinutes}} minutes.`,
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'EMAIL', language: 'ar', name: 'إعادة تعيين كلمة المرور',
    subject: `${APP_NAME} — إعادة تعيين كلمة المرور`,
    body: `مرحباً {{fullName}}،\n\nاستخدم هذا الرمز لإعادة تعيين كلمة المرور: {{code}}\n\nتنتهي الصلاحية خلال {{expiryMinutes}} دقيقة.`,
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  // ── Queue notifications (SMS + WHATSAPP) — replaces the hardcoded SMS_TEMPLATES ──
  {
    key: 'turn_approaching', channel: 'SMS', language: 'en', name: 'Turn approaching',
    body: `🔄 ${APP_NAME}: Dear {{customerName}}, your turn is approaching! Ticket {{ticketNumber}} at {{agencyName}}. Position: {{position}}. Est. wait: {{estimatedMinutes}} min.`,
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'turn_approaching', channel: 'SMS', language: 'ar', name: 'اقتراب الدور',
    body: `🔄 ${APP_NAME}: {{customerName}}، اقترب دورك! تذكرتك {{ticketNumber}} في {{agencyName}}. المركز: {{position}}. الانتظار المتوقع: {{estimatedMinutes}} دقيقة.`,
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'turn_approaching', channel: 'SMS', language: 'fr', name: 'Tour approchant',
    body: `🔄 ${APP_NAME}: {{customerName}}, votre tour approche ! Billet {{ticketNumber}} a {{agencyName}}. Position : {{position}}. Attente estimee : {{estimatedMinutes}} min.`,
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'your_turn', channel: 'SMS', language: 'en', name: 'Your turn now',
    body: `🎫 ${APP_NAME}: Dear {{customerName}}, it's your turn now! Ticket {{ticketNumber}} at {{agencyName}}. Please proceed.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'your_turn', channel: 'SMS', language: 'ar', name: 'دورك الآن',
    body: `🎫 ${APP_NAME}: {{customerName}}، دورك الآن! تذكرتك {{ticketNumber}} في {{agencyName}}. يرجى التوجه فوراً.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'your_turn', channel: 'SMS', language: 'fr', name: 'C\'est votre tour',
    body: `🎫 ${APP_NAME}: {{customerName}}, c'est votre tour ! Billet {{ticketNumber}} a {{agencyName}}. Veuillez vous presenter.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'SMS', language: 'en', name: 'No-show warning',
    body: `⚠️ ${APP_NAME}: Dear {{customerName}}, your ticket {{ticketNumber}} at {{agencyName}} was skipped due to no-show. You can reclaim your position.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'SMS', language: 'ar', name: 'تحذير عدم الحضور',
    body: `⚠️ ${APP_NAME}: {{customerName}}، تم تخطي تذكرتك {{ticketNumber}} في {{agencyName}} بسبب عدم الحضور. يمكنك استعادة مركزك من التطبيق.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'SMS', language: 'fr', name: 'Absence',
    body: `⚠️ ${APP_NAME}: {{customerName}}, votre billet {{ticketNumber}} a {{agencyName}} a ete saute (absence). Vous pouvez recuperer votre position.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  // ── Welcome ──
  {
    key: 'welcome', channel: 'EMAIL', language: 'en', name: 'Welcome email',
    subject: `Welcome to ${APP_NAME}, {{fullName}}!`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} account is now verified and ready. Skip the line — take a ticket, track your turn live, and get notified the moment it's your time.`,
    htmlBody: `<div style="font-family:sans-serif;max-width:480px"><h2 style="color:#059669">${APP_NAME}</h2><p>Hi {{fullName}},</p><p>Your account is now <b>verified and ready</b>. Skip the line — take a ticket, track your turn live, and get notified the moment it's your time.</p></div>`,
    variables: ['fullName'],
  },
  {
    key: 'welcome', channel: 'EMAIL', language: 'ar', name: 'رسالة ترحيب',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}!`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك في ${APP_NAME} بنجاح. خذ تذكرة، تابع دورك مباشرة، واحصل على إشعار لحظة قدومه.`,
    variables: ['fullName'],
  },
]

/** Known template keys + their user-facing metadata (admin UI) */
export const TEMPLATE_CATALOG: Array<{ key: string; channels: TemplateChannel[]; descriptionEn: string; descriptionAr: string }> = [
  { key: 'verify_email', channels: ['EMAIL'], descriptionEn: 'Email address verification OTP', descriptionAr: 'رمز تأكيد البريد الإلكتروني' },
  { key: 'verify_phone', channels: ['SMS', 'WHATSAPP'], descriptionEn: 'Phone number verification OTP', descriptionAr: 'رمز تأكيد رقم الهاتف' },
  { key: 'password_reset', channels: ['EMAIL'], descriptionEn: 'Password reset code', descriptionAr: 'رمز إعادة تعيين كلمة المرور' },
  { key: 'turn_approaching', channels: ['SMS', 'WHATSAPP'], descriptionEn: 'Queue reminder — turn approaching', descriptionAr: 'تذكير الطابور — اقتراب الدور' },
  { key: 'your_turn', channels: ['SMS', 'WHATSAPP'], descriptionEn: 'Queue alert — it is your turn', descriptionAr: 'تنبيه الطابور — دورك الآن' },
  { key: 'no_show', channels: ['SMS', 'WHATSAPP'], descriptionEn: 'No-show warning', descriptionAr: 'تحذير عدم الحضور' },
  { key: 'welcome', channels: ['EMAIL'], descriptionEn: 'Welcome email after verification', descriptionAr: 'رسالة ترحيب بعد التأكيد' },
]

// ─── Core ─────────────────────────────────────────────────────────────────────

export function applyTemplateVars(template: string, vars: TemplateVars): string {
  let result = template
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue
    result = result.split(`{{${key}}}`).join(String(value))
  }
  return result
}

/** Create any missing default rows (idempotent — safe to call often). */
export async function ensureDefaultTemplates(): Promise<void> {
  const existing = await db.notificationTemplate.findMany({ select: { key: true, channel: true, language: true } })
  const have = new Set(existing.map(t => `${t.key}|${t.channel}|${t.language}`))
  const missing = DEFAULT_TEMPLATES.filter(t => !have.has(`${t.key}|${t.channel}|${t.language}`))
  if (!missing.length) return
  await db.notificationTemplate.createMany({
    data: missing.map(t => ({
      key: t.key,
      channel: t.channel,
      language: t.language,
      name: t.name,
      subject: t.subject,
      body: t.body,
      htmlBody: t.htmlBody,
      variables: JSON.stringify(t.variables),
      enabled: true,
    })),
  })
}

/** Render a template row (creating the default if missing). */
export async function renderTemplate(
  key: string,
  channel: TemplateChannel,
  language: string,
  vars: TemplateVars,
): Promise<{
  subject: string | null
  text: string
  html: string | null
  useProviderTemplate: boolean
  providerTemplateId: string | null
  providerTemplateLang: string | null
} | null> {
  const lang = ['ar', 'fr', 'en'].includes(language) ? language : 'en'
  let row = await db.notificationTemplate.findUnique({
    where: { key_channel_language: { key, channel, language: lang } },
  })
  if (!row) {
    await ensureDefaultTemplates()
    row = await db.notificationTemplate.findUnique({
      where: { key_channel_language: { key, channel, language: lang } },
    })
    // Fall back to English if the requested language has no row
    if (!row && lang !== 'en') {
      row = await db.notificationTemplate.findUnique({
        where: { key_channel_language: { key, channel, language: 'en' } },
      })
    }
  }
  if (!row || !row.enabled) return null

  return {
    subject: row.subject ? applyTemplateVars(row.subject, vars) : null,
    text: applyTemplateVars(row.body, vars),
    html: row.htmlBody ? applyTemplateVars(row.htmlBody, vars) : null,
    useProviderTemplate: row.useProviderTemplate,
    providerTemplateId: row.providerTemplateId,
    providerTemplateLang: row.providerTemplateLang,
  }
}

export interface DeliverResult {
  success: boolean
  error?: string
  responseRaw?: string
  providerMessageId?: string
  /** When WhatsApp OTP has no approved template, delivery falls back to SMS */
  deliveredVia?: 'EMAIL' | 'SMS' | 'WHATSAPP'
}

/**
 * Render + deliver a template to a target through the channel's provider.
 * WhatsApp rows with useProviderTemplate=true send the approved provider
 * template instead of the app-side body.
 */
export async function deliverTemplate(opts: {
  key: string
  channel: TemplateChannel
  target: string
  language: string
  vars: TemplateVars
}): Promise<DeliverResult> {
  const rendered = await renderTemplate(opts.key, opts.channel, opts.language, opts.vars)
  if (!rendered) {
    return { success: false, error: `TEMPLATE_MISSING:${opts.key}:${opts.channel}:${opts.language}` }
  }

  if (opts.channel === 'EMAIL') {
    const r = await sendEmail({ to: opts.target, subject: rendered.subject ?? `[${APP_NAME}]`, text: rendered.text, html: rendered.html ?? undefined })
    return { ...r, deliveredVia: 'EMAIL' }
  }

  if (opts.channel === 'SMS') {
    const r = await sendSmsViaProvider(opts.target, rendered.text)
    return { ...r, deliveredVia: 'SMS' }
  }

  // WHATSAPP
  let wa: WhatsAppSendResult
  if (rendered.useProviderTemplate && rendered.providerTemplateId) {
    wa = await sendWhatsAppTemplate(opts.target, rendered.providerTemplateId, rendered.providerTemplateLang || opts.language, [
      { type: 'body', parameters: Object.values(opts.vars).filter(v => v !== undefined).map(v => ({ type: 'text', text: String(v) })) },
    ])
  } else {
    wa = await sendWhatsAppText(opts.target, rendered.text)
  }
  if (!wa.success && wa.fallbackToSms) {
    const r = await sendSmsViaProvider(opts.target, rendered.text)
    return { ...r, deliveredVia: 'SMS' }
  }
  return { ...wa, deliveredVia: 'WHATSAPP' }
}
