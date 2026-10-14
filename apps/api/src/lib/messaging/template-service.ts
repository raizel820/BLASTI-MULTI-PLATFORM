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
import { isFullHtmlDocument, loadAgencyBranding, wrapEmailHtml } from './email-layout'

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

// ─── Professional email inner-content builders (BRD-green code cards) ───────

/** Inner HTML for an OTP-code email — big dashed code card, works in all clients. */
function codeEmailInner(opts: { hello: string; intro: string; expiresNote: string; expiryUnit?: string }): string {
  return `<div style="text-align:center;padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:15px;color:#374151;line-height:1.7;">${opts.hello}</p>
  <p style="margin:0 0 16px 0;font-size:15px;color:#374151;line-height:1.7;">${opts.intro}</p>
  <div style="margin:0 auto 18px auto;display:inline-block;padding:14px 30px;border:2px dashed #059669;border-radius:14px;background:#ecfdf5;">
    <span style="font-size:30px;font-weight:800;letter-spacing:8px;color:#059669;font-family:'Courier New',Courier,monospace;">{{code}}</span>
  </div>
  <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.7;">${opts.expiresNote}</p>
</div>`
}

// ─── Seeded defaults ─────────────────────────────────────────────────────────

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  // ── Verification (EMAIL) — professional inner content; wrapEmailHtml adds logo/footer ──
  {
    key: 'verify_email', channel: 'EMAIL', language: 'en', name: 'Email verification',
    subject: `${APP_NAME} — Your verification code`,
    body: `Hello {{fullName}},\n\nYour ${APP_NAME} verification code is: {{code}}\n\nThis code expires in {{expiryMinutes}} minutes. If you did not request it, you can safely ignore this email.\n\n— The ${APP_NAME} Team`,
    htmlBody: codeEmailInner({
      hello: 'Hello <strong>{{fullName}}</strong>,',
      intro: `Your ${APP_NAME} verification code is:`,
      expiresNote: 'This code expires in <strong>{{expiryMinutes}} minutes</strong>. If you did not request it, you can safely ignore this email.',
    }),
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'verify_email', channel: 'EMAIL', language: 'ar', name: 'تأكيد البريد الإلكتروني',
    subject: `${APP_NAME} — رمز التحقق الخاص بك`,
    body: `مرحباً {{fullName}}،\n\nرمز التحقق الخاص بك في ${APP_NAME} هو: {{code}}\n\nتنتهي صلاحية هذا الرمز خلال {{expiryMinutes}} دقيقة. إذا لم تطلبه يمكنك تجاهل هذه الرسالة بأمان.\n\n— فريق ${APP_NAME}`,
    htmlBody: codeEmailInner({
      hello: 'مرحباً <strong>{{fullName}}</strong>،',
      intro: `رمز التحقق الخاص بك في ${APP_NAME} هو:`,
      expiresNote: 'تنتهي صلاحية هذا الرمز خلال <strong>{{expiryMinutes}} دقيقة</strong>. إذا لم تطلبه يمكنك تجاهل هذه الرسالة بأمان.',
    }),
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'verify_email', channel: 'EMAIL', language: 'fr', name: 'Vérification de l\'email',
    subject: `${APP_NAME} — Votre code de vérification`,
    body: `Bonjour {{fullName}},\n\nVotre code de vérification ${APP_NAME} est : {{code}}\n\nCe code expire dans {{expiryMinutes}} minutes. Si vous ne l'avez pas demandé, ignorez simplement cet email.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: codeEmailInner({
      hello: 'Bonjour <strong>{{fullName}}</strong>,',
      intro: `Votre code de vérification ${APP_NAME} est :`,
      expiresNote: 'Ce code expire dans <strong>{{expiryMinutes}} minutes</strong>. Si vous ne l\'avez pas demandé, ignorez simplement cet email.',
    }),
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
  {
    key: 'verify_phone', channel: 'WHATSAPP', language: 'fr', name: 'Vérification du téléphone (WhatsApp)',
    body: `${APP_NAME} : Votre code de vérification est *{{code}}*. Valable {{expiryMinutes}} minutes.`,
    variables: ['code', 'expiryMinutes'],
  },
  // ── Password reset (EMAIL) ──
  {
    key: 'password_reset', channel: 'EMAIL', language: 'en', name: 'Password reset',
    subject: `${APP_NAME} — Reset your password`,
    body: `Hello {{fullName}},\n\nUse this code to reset your password: {{code}}\n\nIt expires in {{expiryMinutes}} minutes. If you did not request a password reset, you can safely ignore this email.\n\n— The ${APP_NAME} Team`,
    htmlBody: codeEmailInner({
      hello: 'Hello <strong>{{fullName}}</strong>,',
      intro: 'Use this code to reset your password:',
      expiresNote: 'It expires in <strong>{{expiryMinutes}} minutes</strong>. Copy the code and paste it in the app to choose a new password. If you did not request a reset, you can safely ignore this email.',
    }),
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'EMAIL', language: 'ar', name: 'إعادة تعيين كلمة المرور',
    subject: `${APP_NAME} — إعادة تعيين كلمة المرور`,
    body: `مرحباً {{fullName}}،\n\nاستخدم هذا الرمز لإعادة تعيين كلمة المرور: {{code}}\n\nتنتهي الصلاحية خلال {{expiryMinutes}} دقيقة. إذا لم تطلب إعادة التعيين يمكنك تجاهل هذه الرسالة بأمان.\n\n— فريق ${APP_NAME}`,
    htmlBody: codeEmailInner({
      hello: 'مرحباً <strong>{{fullName}}</strong>،',
      intro: 'استخدم هذا الرمز لإعادة تعيين كلمة المرور:',
      expiresNote: 'تنتهي الصلاحية خلال <strong>{{expiryMinutes}} دقيقة</strong>. انسخ الرمز والصقه في التطبيق لاختيار كلمة مرور جديدة. إذا لم تطلب إعادة التعيين يمكنك تجاهل هذه الرسالة بأمان.',
    }),
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'EMAIL', language: 'fr', name: 'Réinitialisation du mot de passe',
    subject: `${APP_NAME} — Réinitialisez votre mot de passe`,
    body: `Bonjour {{fullName}},\n\nUtilisez ce code pour réinitialiser votre mot de passe : {{code}}\n\nIl expire dans {{expiryMinutes}} minutes. Si vous n'avez pas demandé de réinitialisation, ignorez simplement cet email.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: codeEmailInner({
      hello: 'Bonjour <strong>{{fullName}}</strong>,',
      intro: 'Utilisez ce code pour réinitialiser votre mot de passe :',
      expiresNote: 'Il expire dans <strong>{{expiryMinutes}} minutes</strong>. Copiez le code et collez-le dans l\'application pour choisir un nouveau mot de passe. Si vous n\'avez pas demandé de réinitialisation, ignorez simplement cet email.',
    }),
    variables: ['fullName', 'code', 'expiryMinutes'],
  },
  // ── Password reset (SMS) — for users without an email address ──
  {
    key: 'password_reset', channel: 'SMS', language: 'en', name: 'Password reset (SMS)',
    body: `${APP_NAME}: Your password reset code is {{code}}. Valid for {{expiryMinutes}} minutes.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'SMS', language: 'ar', name: 'إعادة تعيين كلمة المرور (SMS)',
    body: `${APP_NAME}: رمز إعادة تعيين كلمة المرور هو {{code}}. صالح لمدة {{expiryMinutes}} دقيقة.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'SMS', language: 'fr', name: 'Réinitialisation du mot de passe (SMS)',
    body: `${APP_NAME} : Votre code de réinitialisation est {{code}}. Valable {{expiryMinutes}} minutes.`,
    variables: ['code', 'expiryMinutes'],
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
  // ── Queue notifications (WHATSAPP) — the catalog advertises WHATSAPP for these keys ──
  {
    key: 'turn_approaching', channel: 'WHATSAPP', language: 'en', name: 'Turn approaching (WhatsApp)',
    body: `🔄 ${APP_NAME}: Dear {{customerName}}, your turn is approaching! Ticket *{{ticketNumber}}* at {{agencyName}}. Position: {{position}}. Est. wait: {{estimatedMinutes}} min.`,
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'turn_approaching', channel: 'WHATSAPP', language: 'ar', name: 'اقتراب الدور (واتساب)',
    body: `🔄 ${APP_NAME}: {{customerName}}، اقترب دورك! تذكرتك *{{ticketNumber}}* في {{agencyName}}. المركز: {{position}}. الانتظار المتوقع: {{estimatedMinutes}} دقيقة.`,
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'your_turn', channel: 'WHATSAPP', language: 'en', name: 'Your turn now (WhatsApp)',
    body: `🎫 ${APP_NAME}: Dear {{customerName}}, it's your turn now! Ticket *{{ticketNumber}}* at {{agencyName}}. Please proceed.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'your_turn', channel: 'WHATSAPP', language: 'ar', name: 'دورك الآن (واتساب)',
    body: `🎫 ${APP_NAME}: {{customerName}}، دورك الآن! تذكرتك *{{ticketNumber}}* في {{agencyName}}. يرجى التوجه فوراً.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'WHATSAPP', language: 'en', name: 'No-show warning (WhatsApp)',
    body: `⚠️ ${APP_NAME}: Dear {{customerName}}, your ticket *{{ticketNumber}}* at {{agencyName}} was skipped due to no-show. You can reclaim your position.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'WHATSAPP', language: 'ar', name: 'تحذير عدم الحضور (واتساب)',
    body: `⚠️ ${APP_NAME}: {{customerName}}، تم تخطي تذكرتك *{{ticketNumber}}* في {{agencyName}} بسبب عدم الحضور. يمكنك استعادة مركزك من التطبيق.`,
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  // ── Welcome (EMAIL) — sent once when the account becomes fully verified ──
  {
    key: 'welcome', channel: 'EMAIL', language: 'en', name: 'Welcome email',
    subject: `Welcome to ${APP_NAME}, {{fullName}}!`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} account is now verified and ready. Skip the line — take a ticket, track your turn live, and get notified the moment it's your time.`,
    htmlBody: `<div style="padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:20px;font-weight:800;color:#059669;text-align:center;">Welcome aboard, {{fullName}}! 🎉</p>
  <p style="margin:0 0 12px 0;font-size:15px;color:#374151;line-height:1.8;">Your ${APP_NAME} account is now <strong>verified and ready</strong>. Here is what you can do next:</p>
  <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">✅ &nbsp;Take a ticket at any partner agency — no more standing in line</p>
  <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">📲 &nbsp;Track your turn live from the app, wherever you are</p>
  <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.9;">🔔 &nbsp;Get notified the moment it is almost your time</p>
  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.7;text-align:center;">See you in the app!<br/>— The ${APP_NAME} Team</p>
</div>`,
    variables: ['fullName'],
  },
  {
    key: 'welcome', channel: 'EMAIL', language: 'ar', name: 'رسالة ترحيب',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}!`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك في ${APP_NAME} بنجاح. خذ تذكرة، تابع دورك مباشرة، واحصل على إشعار لحظة قدومه.`,
    htmlBody: `<div style="padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:20px;font-weight:800;color:#059669;text-align:center;">مرحباً بك، {{fullName}}! 🎉</p>
  <p style="margin:0 0 12px 0;font-size:15px;color:#374151;line-height:1.8;">تم تأكيد حسابك في ${APP_NAME} بنجاح. إليك ما يمكنك فعله الآن:</p>
  <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">✅ &nbsp;خذ تذكرة من أي وكالة شريكة — دون الوقوف في الطابور</p>
  <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">📲 &nbsp;تابع دورك مباشرة من التطبيق، من أي مكان</p>
  <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.9;">🔔 &nbsp;احصل على إشعار لحظة اقتراب دورك</p>
  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.7;text-align:center;">نراك في التطبيق!<br/>— فريق ${APP_NAME}</p>
</div>`,
    variables: ['fullName'],
  },
  {
    key: 'welcome', channel: 'EMAIL', language: 'fr', name: 'Email de bienvenue',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} !`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} est désormais vérifié et prêt. Prenez un ticket, suivez votre tour en direct et soyez notifié dès que c'est votre moment.`,
    htmlBody: `<div style="padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:20px;font-weight:800;color:#059669;text-align:center;">Bienvenue, {{fullName}} ! 🎉</p>
  <p style="margin:0 0 12px 0;font-size:15px;color:#374151;line-height:1.8;">Votre compte ${APP_NAME} est désormais <strong>vérifié et prêt</strong>. Voici ce que vous pouvez faire :</p>
  <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">✅ &nbsp;Prenez un ticket dans toute agence partenaire — sans faire la queue</p>
  <p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">📲 &nbsp;Suivez votre tour en direct depuis l'application</p>
  <p style="margin:0 0 16px 0;font-size:14px;color:#374151;line-height:1.9;">🔔 &nbsp;Soyez notifié dès que votre tour approche</p>
  <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.7;text-align:center;">À bientôt dans l'application !<br/>— L'équipe ${APP_NAME}</p>
</div>`,
    variables: ['fullName'],
  },
]

/** Known template keys + their user-facing metadata (admin UI) */
export const TEMPLATE_CATALOG: Array<{ key: string; channels: TemplateChannel[]; descriptionEn: string; descriptionAr: string }> = [
  { key: 'verify_email', channels: ['EMAIL'], descriptionEn: 'Email address verification OTP', descriptionAr: 'رمز تأكيد البريد الإلكتروني' },
  { key: 'verify_phone', channels: ['SMS', 'WHATSAPP'], descriptionEn: 'Phone number verification OTP', descriptionAr: 'رمز تأكيد رقم الهاتف' },
  { key: 'password_reset', channels: ['EMAIL', 'SMS'], descriptionEn: 'Password reset code (email, or SMS when no email)', descriptionAr: 'رمز إعادة تعيين كلمة المرور (بريد، أو SMS عند غياب البريد)' },
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
  if (missing.length) {
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

  // ── Upgrade pass: fill EMPTY htmlBody on existing EMAIL rows ──
  // Rows created before the professional email layout shipped have a null
  // htmlBody (or a bare text div). Fill them from the seeded defaults but
  // NEVER overwrite a non-empty value (that is the admin's own customization).
  const emptyHtmlRows = await db.notificationTemplate.findMany({
    where: { channel: 'EMAIL', OR: [{ htmlBody: null }, { htmlBody: '' }] },
    select: { id: true, key: true, language: true },
  })
  for (const row of emptyHtmlRows) {
    const seed = DEFAULT_TEMPLATES.find(
      t => t.key === row.key && t.channel === 'EMAIL' && t.language === row.language && t.htmlBody,
    )
    if (seed?.htmlBody) {
      await db.notificationTemplate.update({ where: { id: row.id }, data: { htmlBody: seed.htmlBody } })
    }
  }
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
 *
 * EMAIL bodies are wrapped into the professional branded layout
 * (app logo + agency logo/info footer — see email-layout.ts) unless the
 * admin's htmlBody is already a full HTML document.
 */
export async function deliverTemplate(opts: {
  key: string
  channel: TemplateChannel
  target: string
  language: string
  vars: TemplateVars
  /** When set, the email layout is branded with this agency's logo + info */
  agencyId?: string
}): Promise<DeliverResult> {
  const rendered = await renderTemplate(opts.key, opts.channel, opts.language, opts.vars)
  if (!rendered) {
    return { success: false, error: `TEMPLATE_MISSING:${opts.key}:${opts.channel}:${opts.language}` }
  }

  if (opts.channel === 'EMAIL') {
    let html = rendered.html ?? undefined
    if (html && !isFullHtmlDocument(html)) {
      const branding = opts.agencyId ? await loadAgencyBranding(opts.agencyId) : undefined
      html = wrapEmailHtml({ bodyHtml: html, language: opts.language, branding })
    }
    const r = await sendEmail({ to: opts.target, subject: rendered.subject ?? `[${APP_NAME}]`, text: rendered.text, html })
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
