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

/** Inner HTML for an OTP-code email — solid emerald brand card, works in all clients. */
function codeEmailInner(opts: { hello: string; intro: string; expiresNote: string; expiryUnit?: string }): string {
  return `<div style="text-align:center;padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:15px;color:#374151;line-height:1.7;">${opts.hello}</p>
  <p style="margin:0 0 16px 0;font-size:15px;color:#374151;line-height:1.7;">${opts.intro}</p>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 18px auto;"><tr><td style="background:#059669;background-image:linear-gradient(135deg,#059669 0%,#047857 100%);border-radius:16px;padding:18px 36px;">
    <span style="font-size:32px;font-weight:800;letter-spacing:10px;color:#ffffff;font-family:'Courier New',Courier,monospace;">{{code}}</span>
  </td></tr></table>
  <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.7;">${opts.expiresNote}</p>
</div>`
}

/** Inner HTML for a queue-event email — branded event banner + detail rows. */
function queueEmailInner(opts: { emoji: string; headline: string; rows: Array<[string, string]>; outro?: string }): string {
  const rowHtml = opts.rows
    .map(([label, value]) => `<tr><td style="padding:7px 12px;font-size:13px;color:#6b7280;border-bottom:1px solid #eef2f7;">${label}</td><td style="padding:7px 12px;font-size:13px;font-weight:700;color:#111827;border-bottom:1px solid #eef2f7;text-align:left;">${value}</td></tr>`)
    .join('\n  ')
  return `<div style="padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:17px;font-weight:800;color:#059669;text-align:center;">${opts.emoji} &nbsp;${opts.headline}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;overflow:hidden;">
  ${rowHtml}
  </table>
  ${opts.outro ? `<p style="margin:14px 0 0 0;font-size:13px;color:#374151;line-height:1.7;text-align:center;">${opts.outro}</p>` : ''}
</div>`
}

/**
 * 0.6.67 — inner HTML for the differentiated welcome emails. One checklist
 * card whose steps depend on the AUDIENCE (agency owner vs regular customer)
 * and whose framing depends on the PLATFORM the account was verified from
 * (desktop app / mobile app / web browser).
 */
function welcomeChecklistInner(opts: { headline: string; intro: string; items: string[]; outro: string }): string {
  const itemsHtml = opts.items
    .map((item) => `<p style="margin:0 0 6px 0;font-size:14px;color:#374151;line-height:1.9;">✅ &nbsp;${item}</p>`)
    .join('\n  ')
  return `<div style="padding:6px 0 2px 0;">
  <p style="margin:0 0 14px 0;font-size:20px;font-weight:800;color:#059669;text-align:center;">${opts.headline}</p>
  <p style="margin:0 0 12px 0;font-size:15px;color:#374151;line-height:1.8;">${opts.intro}</p>
  ${itemsHtml}
  <p style="margin:14px 0 0 0;font-size:13px;color:#6b7280;line-height:1.7;text-align:center;">${opts.outro}</p>
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
  // ── Password reset (WHATSAPP) — dedicated WhatsApp wording (bold code) ──
  {
    key: 'password_reset', channel: 'WHATSAPP', language: 'en', name: 'Password reset (WhatsApp)',
    body: `${APP_NAME}: Your password reset code is *{{code}}*. Valid for {{expiryMinutes}} minutes. If you did not request it, ignore this message.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'WHATSAPP', language: 'ar', name: 'إعادة تعيين كلمة المرور (واتساب)',
    body: `${APP_NAME}: رمز إعادة تعيين كلمة المرور هو *{{code}}*. صالح لمدة {{expiryMinutes}} دقيقة. إذا لم تطلبه تجاهل هذه الرسالة.`,
    variables: ['code', 'expiryMinutes'],
  },
  {
    key: 'password_reset', channel: 'WHATSAPP', language: 'fr', name: 'Réinitialisation du mot de passe (WhatsApp)',
    body: `${APP_NAME} : Votre code de réinitialisation est *{{code}}*. Valable {{expiryMinutes}} minutes. Si vous ne l'avez pas demandé, ignorez ce message.`,
    variables: ['code', 'expiryMinutes'],
  },
  // ── Queue notifications (EMAIL) — dedicated branded variants ──
  {
    key: 'turn_approaching', channel: 'EMAIL', language: 'en', name: 'Turn approaching',
    subject: `${APP_NAME} — Your turn is approaching ({{ticketNumber}})`,
    body: `Hello {{customerName}},\n\nYour turn is approaching! Ticket {{ticketNumber}} at {{agencyName}}. Position: {{position}}. Estimated wait: {{estimatedMinutes}} minutes.\n\n— The ${APP_NAME} Team`,
    htmlBody: queueEmailInner({
      emoji: '🔄', headline: 'Your turn is approaching!',
      rows: [['Ticket', '{{ticketNumber}}'], ['Agency', '{{agencyName}}'], ['Position', '{{position}}'], ['Estimated wait', '{{estimatedMinutes}} minutes']],
      outro: 'Head over to the agency now so you do not miss your turn.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'turn_approaching', channel: 'EMAIL', language: 'ar', name: 'اقتراب الدور',
    subject: `${APP_NAME} — اقترب دورك ({{ticketNumber}})`,
    body: `مرحباً {{customerName}}،\n\nاقترب دورك! تذكرتك {{ticketNumber}} في {{agencyName}}. المركز: {{position}}. الانتظار المتوقع: {{estimatedMinutes}} دقيقة.\n\n— فريق ${APP_NAME}`,
    htmlBody: queueEmailInner({
      emoji: '🔄', headline: 'اقترب دورك!',
      rows: [['التذكرة', '{{ticketNumber}}'], ['الوكالة', '{{agencyName}}'], ['المركز', '{{position}}'], ['الانتظار المتوقع', '{{estimatedMinutes}} دقيقة']],
      outro: 'توجه إلى الوكالة الآن حتى لا يفوتك دورك.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'turn_approaching', channel: 'EMAIL', language: 'fr', name: 'Tour approchant',
    subject: `${APP_NAME} — Votre tour approche ({{ticketNumber}})`,
    body: `Bonjour {{customerName}},\n\nVotre tour approche ! Billet {{ticketNumber}} a {{agencyName}}. Position : {{position}}. Attente estimee : {{estimatedMinutes}} minutes.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: queueEmailInner({
      emoji: '🔄', headline: 'Votre tour approche !',
      rows: [['Billet', '{{ticketNumber}}'], ['Agence', '{{agencyName}}'], ['Position', '{{position}}'], ['Attente estimee', '{{estimatedMinutes}} minutes']],
      outro: "Rendez-vous a l'agence maintenant pour ne pas manquer votre tour.",
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName', 'position', 'estimatedMinutes'],
  },
  {
    key: 'your_turn', channel: 'EMAIL', language: 'en', name: 'Your turn now',
    subject: `${APP_NAME} — It is your turn now ({{ticketNumber}})`,
    body: `Hello {{customerName}},\n\nIt is your turn now! Ticket {{ticketNumber}} at {{agencyName}}. Please proceed to the counter.\n\n— The ${APP_NAME} Team`,
    htmlBody: queueEmailInner({
      emoji: '🎫', headline: "It's your turn now!",
      rows: [['Ticket', '{{ticketNumber}}'], ['Agency', '{{agencyName}}']],
      outro: 'Please proceed to the counter immediately.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'your_turn', channel: 'EMAIL', language: 'ar', name: 'دورك الآن',
    subject: `${APP_NAME} — دورك الآن ({{ticketNumber}})`,
    body: `مرحباً {{customerName}}،\n\nدورك الآن! تذكرتك {{ticketNumber}} في {{agencyName}}. يرجى التوجه إلى الشباك فوراً.\n\n— فريق ${APP_NAME}`,
    htmlBody: queueEmailInner({
      emoji: '🎫', headline: 'دورك الآن!',
      rows: [['التذكرة', '{{ticketNumber}}'], ['الوكالة', '{{agencyName}}']],
      outro: 'يرجى التوجه إلى الشباك فوراً.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'your_turn', channel: 'EMAIL', language: 'fr', name: "C'est votre tour",
    subject: `${APP_NAME} — C'est votre tour ({{ticketNumber}})`,
    body: `Bonjour {{customerName}},\n\nC'est votre tour ! Billet {{ticketNumber}} a {{agencyName}}. Veuillez vous presenter au guichet.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: queueEmailInner({
      emoji: '🎫', headline: "C'est votre tour !",
      rows: [['Billet', '{{ticketNumber}}'], ['Agence', '{{agencyName}}']],
      outro: 'Veuillez vous presenter au guichet immediatement.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'EMAIL', language: 'en', name: 'No-show warning',
    subject: `${APP_NAME} — Missed turn ({{ticketNumber}})`,
    body: `Hello {{customerName}},\n\nYour ticket {{ticketNumber}} at {{agencyName}} was skipped due to no-show. You can reclaim your position from the app.\n\n— The ${APP_NAME} Team`,
    htmlBody: queueEmailInner({
      emoji: '⚠️', headline: 'Missed turn — no-show',
      rows: [['Ticket', '{{ticketNumber}}'], ['Agency', '{{agencyName}}']],
      outro: 'You can reclaim your position from the app while spots remain.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'EMAIL', language: 'ar', name: 'تحذير عدم الحضور',
    subject: `${APP_NAME} — تم تخطي دورك ({{ticketNumber}})`,
    body: `مرحباً {{customerName}}،\n\nتم تخطي تذكرتك {{ticketNumber}} في {{agencyName}} بسبب عدم الحضور. يمكنك استعادة مركزك من التطبيق.\n\n— فريق ${APP_NAME}`,
    htmlBody: queueEmailInner({
      emoji: '⚠️', headline: 'تم تخطي الدور — عدم حضور',
      rows: [['التذكرة', '{{ticketNumber}}'], ['الوكالة', '{{agencyName}}']],
      outro: 'يمكنك استعادة مركزك من التطبيق ما دامت هناك أماكن.',
    }),
    variables: ['customerName', 'ticketNumber', 'agencyName'],
  },
  {
    key: 'no_show', channel: 'EMAIL', language: 'fr', name: 'Absence',
    subject: `${APP_NAME} — Tour manque ({{ticketNumber}})`,
    body: `Bonjour {{customerName}},\n\nVotre billet {{ticketNumber}} a {{agencyName}} a ete saute (absence). Vous pouvez recuperer votre position depuis l'application.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: queueEmailInner({
      emoji: '⚠️', headline: 'Tour manque — absence',
      rows: [['Billet', '{{ticketNumber}}'], ['Agence', '{{agencyName}}']],
      outro: "Vous pouvez recuperer votre position depuis l'application tant qu'il reste des places.",
    }),
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

  // ── 0.6.67 — DIFFERENTIATED welcome emails ─────────────────────────────────
  // The welcome email adapts to WHO the account is (agency owner vs regular
  // customer) and WHERE it was verified (desktop app / mobile app / web
  // browser). Six variants × three languages; deliverWelcomeEmail() walks the
  // specificity cascade (variant → generic 'welcome') so an admin can delete
  // any variant row without breaking delivery. Each variant is fully
  // editable in the admin templates manager like every other row.
  {
    key: 'welcome_owner_desktop', channel: 'EMAIL', language: 'en', name: 'Welcome — agency owner (desktop app)',
    subject: `Welcome to ${APP_NAME}, {{fullName}}! — your agency desktop console is ready`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} agency account is verified and your desktop console is ready. Create your agency profile, add your services and counters, invite your staff — and run the queue from a console that keeps working even when the internet drops (offline-first).\n\n— The ${APP_NAME} Team`,
    htmlBody: welcomeChecklistInner({
      headline: `Welcome aboard, {{fullName}}! 🎉`,
      intro: `Your ${APP_NAME} <strong>agency owner</strong> account is verified — and you signed in from the <strong>desktop app</strong>, so your console works offline too. Here is your setup path:`,
      items: [
        'Create your agency profile — name, specialty, location',
        'Add your services and counters so the queue starts flowing',
        'Invite your staff and grant them the right permissions',
        'Run the queue from the desktop console — it keeps working even when the internet drops',
      ],
      outro: `See you in your console!<br/>— The ${APP_NAME} Team`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_desktop', channel: 'EMAIL', language: 'ar', name: 'ترحيب — صاحب وكالة (تطبيق سطح المكتب)',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}! — منصة وكالتك على سطح المكتب جاهزة`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك كصاحب وكالة في ${APP_NAME}، ومنصة سطح المكتب جاهزة. أنشئ ملف وكالتك، أضف خدماتك ومكاتبك، وادعُ فريقك — وتحكّم في الطابور من منصة تعمل حتى عند انقطاع الإنترنت (العمل دون اتصال أولاً).\n\n— فريق ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `مرحباً بك، {{fullName}}! 🎉`,
      intro: `تم تأكيد حسابك في ${APP_NAME} بصفتك <strong>صاحب وكالة</strong> — وقد سجّلت الدخول من <strong>تطبيق سطح المكتب</strong>، لذا تعمل منصتك دون اتصال أيضاً. إليك خطوات البدء:`,
      items: [
        'أنشئ ملف وكالتك — الاسم، التخصص، الموقع',
        'أضف خدماتك ومكاتبك ليتدفق الطابور',
        'ادعُ موظفيك وامنحهم الصلاحيات المناسبة',
        'أدر الطابور من منصة سطح المكتب — تُبقي العمل جارياً حتى عند انقطاع الإنترنت',
      ],
      outro: `نراك في منصتك!<br/>— فريق ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_desktop', channel: 'EMAIL', language: 'fr', name: 'Bienvenue — propriétaire d\u2019agence (appli bureau)',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} ! — votre console de bureau est prête`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} propriétaire d'agence est vérifié et votre console de bureau est prête. Créez la fiche de votre agence, ajoutez services et guichets, invitez votre équipe — et gérez la file depuis une console qui fonctionne même sans Internet (hors ligne d'abord).\n\n— L'équipe ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `Bienvenue, {{fullName}} ! 🎉`,
      intro: `Votre compte ${APP_NAME} <strong>propriétaire d'agence</strong> est vérifié — et vous êtes connecté depuis l'<strong>application de bureau</strong>, votre console fonctionne donc aussi hors ligne. Voici votre parcours :`,
      items: [
        'Créez la fiche de votre agence — nom, spécialité, localisation',
        'Ajoutez vos services et guichets pour faire circuler la file',
        'Invitez votre équipe et accordez les bonnes permissions',
        'Gérez la file depuis la console de bureau — elle fonctionne même sans Internet',
      ],
      outro: `À bientôt dans votre console !<br/>— L'équipe ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_mobile', channel: 'EMAIL', language: 'en', name: 'Welcome — agency owner (mobile app)',
    subject: `Welcome to ${APP_NAME}, {{fullName}}! — run your agency from your phone`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} agency account is verified and the mobile app is ready. Create your agency, call the next turns, and watch your queue live — everything from your phone, wherever you are.\n\n— The ${APP_NAME} Team`,
    htmlBody: welcomeChecklistInner({
      headline: `Welcome aboard, {{fullName}}! 🎉`,
      intro: `Your ${APP_NAME} <strong>agency owner</strong> account is verified — and you are set up on the <strong>mobile app</strong>, so your agency fits in your pocket:`,
      items: [
        'Create your agency profile — name, specialty, location',
        'Add your services and counters, then open the queue',
        'Call the next turn with one tap and keep the line moving',
        'Watch live stats and get alerts wherever you are',
      ],
      outro: `See you in the app!<br/>— The ${APP_NAME} Team`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_mobile', channel: 'EMAIL', language: 'ar', name: 'ترحيب — صاحب وكالة (تطبيق الهاتف)',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}! — أدر وكالتك من هاتفك`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك كصاحب وكالة في ${APP_NAME}، وتطبيق الهاتف جاهز. أنشئ وكالتك، اتصل بالأدوار التالية، وتابع الطابور مباشرة — كل ذلك من هاتفك وأينما كنت.\n\n— فريق ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `مرحباً بك، {{fullName}}! 🎉`,
      intro: `تم تأكيد حسابك في ${APP_NAME} بصفتك <strong>صاحب وكالة</strong> — وأنت الآن على <strong>تطبيق الهاتف</strong>، فوكالتك في جيبك:`,
      items: [
        'أنشئ ملف وكالتك — الاسم، التخصص، الموقع',
        'أضف خدماتك ومكاتبك ثم افتح الطابور',
        'اتصل بالدور التالي بلمسة واحدة وحافظ على انسياب الطابور',
        'تابع الإحصائيات مباشرة واستلم التنبيهات أينما كنت',
      ],
      outro: `نراك في التطبيق!<br/>— فريق ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_mobile', channel: 'EMAIL', language: 'fr', name: 'Bienvenue — propriétaire d\u2019agence (appli mobile)',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} ! — gérez votre agence depuis votre téléphone`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} propriétaire d'agence est vérifié et l'application mobile est prête. Créez votre agence, appelez les tours suivants et suivez votre file en direct — le tout depuis votre téléphone, où que vous soyez.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `Bienvenue, {{fullName}} ! 🎉`,
      intro: `Votre compte ${APP_NAME} <strong>propriétaire d'agence</strong> est vérifié — et vous êtes sur l'<strong>application mobile</strong> : votre agence tient dans votre poche :`,
      items: [
        'Créez la fiche de votre agence — nom, spécialité, localisation',
        'Ajoutez services et guichets, puis ouvrez la file',
        'Appelez le tour suivant en un geste et gardez la file fluide',
        'Suivez les statistiques en direct et recevez les alertes partout',
      ],
      outro: `À bientôt dans l'application !<br/>— L'équipe ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_web', channel: 'EMAIL', language: 'en', name: 'Welcome — agency owner (web console)',
    subject: `Welcome to ${APP_NAME}, {{fullName}}! — your agency workspace is ready`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} agency account is verified and your browser workspace is ready. Create your agency profile, add services and counters, invite staff, and follow the analytics — all from the web console.\n\n— The ${APP_NAME} Team`,
    htmlBody: welcomeChecklistInner({
      headline: `Welcome aboard, {{fullName}}! 🎉`,
      intro: `Your ${APP_NAME} <strong>agency owner</strong> account is verified — and you are on the <strong>web console</strong>, the full workspace in your browser:`,
      items: [
        'Create your agency profile — name, specialty, location',
        'Add your services and counters so the queue starts flowing',
        'Invite your staff and grant them the right permissions',
        'Follow the queue and the analytics from the dashboard',
      ],
      outro: `See you in your workspace!<br/>— The ${APP_NAME} Team`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_web', channel: 'EMAIL', language: 'ar', name: 'ترحيب — صاحب وكالة (منصة الويب)',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}! — مساحة عمل وكالتك جاهزة`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك كصاحب وكالة في ${APP_NAME}، ومساحة العمل في المتصفح جاهزة. أنشئ ملف وكالتك، أضف الخدمات والمكاتب، وادعُ الموظفين، وتابع التحليلات — كل ذلك من منصة الويب.\n\n— فريق ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `مرحباً بك، {{fullName}}! 🎉`,
      intro: `تم تأكيد حسابك في ${APP_NAME} بصفتك <strong>صاحب وكالة</strong> — وأنت على <strong>منصة الويب</strong>، مساحة العمل الكاملة في متصفحك:`,
      items: [
        'أنشئ ملف وكالتك — الاسم، التخصص، الموقع',
        'أضف خدماتك ومكاتبك ليتدفق الطابور',
        'ادعُ موظفيك وامنحهم الصلاحيات المناسبة',
        'تابع الطابور والتحليلات من لوحة التحكم',
      ],
      outro: `نراك في مساحة عملك!<br/>— فريق ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_owner_web', channel: 'EMAIL', language: 'fr', name: 'Bienvenue — propriétaire d\u2019agence (console web)',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} ! — votre espace agence est prêt`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} propriétaire d'agence est vérifié et votre espace de travail navigateur est prêt. Créez la fiche de votre agence, ajoutez services et guichets, invitez l'équipe et suivez les analyses — tout depuis la console web.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `Bienvenue, {{fullName}} ! 🎉`,
      intro: `Votre compte ${APP_NAME} <strong>propriétaire d'agence</strong> est vérifié — et vous êtes sur la <strong>console web</strong>, l'espace de travail complet dans votre navigateur :`,
      items: [
        'Créez la fiche de votre agence — nom, spécialité, localisation',
        'Ajoutez vos services et guichets pour faire circuler la file',
        'Invitez votre équipe et accordez les bonnes permissions',
        'Suivez la file et les analyses depuis le tableau de bord',
      ],
      outro: `À bientôt dans votre espace !<br/>— L'équipe ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_desktop', channel: 'EMAIL', language: 'en', name: 'Welcome — customer (desktop app)',
    subject: `Welcome to ${APP_NAME}, {{fullName}}! — skip the line from your desktop`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} account is verified and ready. Browse partner agencies, take a ticket, and track your turn live — right from your desktop app.\n\n— The ${APP_NAME} Team`,
    htmlBody: welcomeChecklistInner({
      headline: `Welcome aboard, {{fullName}}! 🎉`,
      intro: `Your ${APP_NAME} account is now <strong>verified and ready</strong> — on the <strong>desktop app</strong>:`,
      items: [
        'Browse every partner agency and pick where to go',
        'Take a ticket from your desk — no more standing in line',
        'Track your turn live and get notified before it comes',
      ],
      outro: `See you in the app!<br/>— The ${APP_NAME} Team`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_desktop', channel: 'EMAIL', language: 'ar', name: 'ترحيب — زبون (تطبيق سطح المكتب)',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}! — ادفع الطابور من سطح مكتبك`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك في ${APP_NAME} بنجاح. تصفّح الوكالات الشريكة، خذ تذكرتك، وتابع دورك مباشرة — من تطبيق سطح المكتب مباشرة.\n\n— فريق ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `مرحباً بك، {{fullName}}! 🎉`,
      intro: `تم تأكيد حسابك في ${APP_NAME} بنجاح — على <strong>تطبيق سطح المكتب</strong>:`,
      items: [
        'تصفّح كل الوكالات الشريكة واختر وجهتك',
        'خذ تذكرتك من مكانك — دون الوقوف في الطابور',
        'تابع دورك مباشرة واستلم إشعاراً قبل قدومه',
      ],
      outro: `نراك في التطبيق!<br/>— فريق ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_desktop', channel: 'EMAIL', language: 'fr', name: 'Bienvenue — client (appli bureau)',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} ! — évitez la file depuis votre bureau`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} est vérifié et prêt. Parcourez les agences partenaires, prenez un ticket et suivez votre tour en direct — directement depuis l'application de bureau.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `Bienvenue, {{fullName}} ! 🎉`,
      intro: `Votre compte ${APP_NAME} est désormais <strong>vérifié et prêt</strong> — sur l'<strong>application de bureau</strong> :`,
      items: [
        'Parcourez toutes les agences partenaires et choisissez votre destination',
        'Prenez un ticket depuis votre bureau — sans faire la queue',
        'Suivez votre tour en direct et soyez notifié avant qu\u2019il arrive',
      ],
      outro: `À bientôt dans l'application !<br/>— L'équipe ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_mobile', channel: 'EMAIL', language: 'en', name: 'Welcome — customer (mobile app)',
    subject: `Welcome to ${APP_NAME}, {{fullName}}! — your ticket is in your pocket`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} account is verified and ready. Take a ticket at any partner agency, track your turn live, and get notified the moment it is almost your time — all from your phone.\n\n— The ${APP_NAME} Team`,
    htmlBody: welcomeChecklistInner({
      headline: `Welcome aboard, {{fullName}}! 🎉`,
      intro: `Your ${APP_NAME} account is now <strong>verified and ready</strong> — on the <strong>mobile app</strong>:`,
      items: [
        'Take a ticket at any partner agency — no more standing in line',
        'Track your turn live from your phone, wherever you are',
        'Get notified the moment it is almost your time',
      ],
      outro: `See you in the app!<br/>— The ${APP_NAME} Team`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_mobile', channel: 'EMAIL', language: 'ar', name: 'ترحيب — زبون (تطبيق الهاتف)',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}! — تذكرتك في جيبك`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك في ${APP_NAME} بنجاح. خذ تذكرة من أي وكالة شريكة، تابع دورك مباشرة، واحصل على إشعار لحظة اقترابه — كل ذلك من هاتفك.\n\n— فريق ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `مرحباً بك، {{fullName}}! 🎉`,
      intro: `تم تأكيد حسابك في ${APP_NAME} بنجاح — على <strong>تطبيق الهاتف</strong>:`,
      items: [
        'خذ تذكرة من أي وكالة شريكة — دون الوقوف في الطابور',
        'تابع دورك مباشرة من هاتفك، من أي مكان',
        'احصل على إشعار لحظة اقتراب دورك',
      ],
      outro: `نراك في التطبيق!<br/>— فريق ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_mobile', channel: 'EMAIL', language: 'fr', name: 'Bienvenue — client (appli mobile)',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} ! — votre ticket dans votre poche`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} est vérifié et prêt. Prenez un ticket dans toute agence partenaire, suivez votre tour en direct et soyez notifié dès que votre tour approche — le tout depuis votre téléphone.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `Bienvenue, {{fullName}} ! 🎉`,
      intro: `Votre compte ${APP_NAME} est désormais <strong>vérifié et prêt</strong> — sur l'<strong>application mobile</strong> :`,
      items: [
        'Prenez un ticket dans toute agence partenaire — sans faire la queue',
        'Suivez votre tour en direct depuis votre téléphone, où que vous soyez',
        'Soyez notifié dès que votre tour approche',
      ],
      outro: `À bientôt dans l'application !<br/>— L'équipe ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_web', channel: 'EMAIL', language: 'en', name: 'Welcome — customer (web)',
    subject: `Welcome to ${APP_NAME}, {{fullName}}! — skip the line from your browser`,
    body: `Hi {{fullName}},\n\nYour ${APP_NAME} account is verified and ready. Browse partner agencies, take a ticket, and track your turn live — all from your browser.\n\n— The ${APP_NAME} Team`,
    htmlBody: welcomeChecklistInner({
      headline: `Welcome aboard, {{fullName}}! 🎉`,
      intro: `Your ${APP_NAME} account is now <strong>verified and ready</strong> — on the <strong>web app</strong>:`,
      items: [
        'Browse every partner agency and pick where to go',
        'Take a ticket from your browser — no more standing in line',
        'Track your turn live and get notified before it comes',
      ],
      outro: `See you in the app!<br/>— The ${APP_NAME} Team`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_web', channel: 'EMAIL', language: 'ar', name: 'ترحيب — زبون (الويب)',
    subject: `مرحباً بك في ${APP_NAME}، {{fullName}}! — ادفع الطابور من متصفحك`,
    body: `مرحباً {{fullName}}،\n\nتم تأكيد حسابك في ${APP_NAME} بنجاح. تصفّح الوكالات الشريكة، خذ تذكرتك، وتابع دورك مباشرة — كل ذلك من متصفحك.\n\n— فريق ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `مرحباً بك، {{fullName}}! 🎉`,
      intro: `تم تأكيد حسابك في ${APP_NAME} بنجاح — على <strong>تطبيق الويب</strong>:`,
      items: [
        'تصفّح كل الوكالات الشريكة واختر وجهتك',
        'خذ تذكرتك من متصفحك — دون الوقوف في الطابور',
        'تابع دورك مباشرة واستلم إشعاراً قبل قدومه',
      ],
      outro: `نراك في التطبيق!<br/>— فريق ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
  {
    key: 'welcome_customer_web', channel: 'EMAIL', language: 'fr', name: 'Bienvenue — client (web)',
    subject: `Bienvenue sur ${APP_NAME}, {{fullName}} ! — évitez la file depuis votre navigateur`,
    body: `Bonjour {{fullName}},\n\nVotre compte ${APP_NAME} est vérifié et prêt. Parcourez les agences partenaires, prenez un ticket et suivez votre tour en direct — le tout depuis votre navigateur.\n\n— L'équipe ${APP_NAME}`,
    htmlBody: welcomeChecklistInner({
      headline: `Bienvenue, {{fullName}} ! 🎉`,
      intro: `Votre compte ${APP_NAME} est désormais <strong>vérifié et prêt</strong> — sur l'<strong>application web</strong> :`,
      items: [
        'Parcourez toutes les agences partenaires et choisissez votre destination',
        'Prenez un ticket depuis votre navigateur — sans faire la queue',
        'Suivez votre tour en direct et soyez notifié avant qu\u2019il arrive',
      ],
      outro: `À bientôt dans l'application !<br/>— L'équipe ${APP_NAME}`,
    }),
    variables: ['fullName'],
  },
]

/** Known template keys + their user-facing metadata (admin UI) */
export const TEMPLATE_CATALOG: Array<{ key: string; channels: TemplateChannel[]; descriptionEn: string; descriptionAr: string }> = [
  { key: 'verify_email', channels: ['EMAIL'], descriptionEn: 'Email address verification OTP', descriptionAr: 'رمز تأكيد البريد الإلكتروني' },
  { key: 'verify_phone', channels: ['SMS', 'WHATSAPP'], descriptionEn: 'Phone number verification OTP', descriptionAr: 'رمز تأكيد رقم الهاتف' },
  { key: 'password_reset', channels: ['EMAIL', 'SMS', 'WHATSAPP'], descriptionEn: 'Password reset code — dedicated wording per channel (sent to VERIFIED contacts only)', descriptionAr: 'رمز إعادة تعيين كلمة المرور — صياغة مخصصة لكل قناة (يُرسل للجهات المُتحقق منها فقط)' },
  { key: 'turn_approaching', channels: ['EMAIL', 'SMS', 'WHATSAPP'], descriptionEn: 'Queue reminder — turn approaching', descriptionAr: 'تذكير الطابور — اقتراب الدور' },
  { key: 'your_turn', channels: ['EMAIL', 'SMS', 'WHATSAPP'], descriptionEn: 'Queue alert — it is your turn', descriptionAr: 'تنبيه الطابور — دورك الآن' },
  { key: 'no_show', channels: ['EMAIL', 'SMS', 'WHATSAPP'], descriptionEn: 'No-show warning', descriptionAr: 'تحذير عدم الحضور' },
  { key: 'welcome', channels: ['EMAIL'], descriptionEn: 'Welcome email after verification (generic fallback)', descriptionAr: 'رسالة ترحيب بعد التأكيد (احتياطية عامة)' },
  // 0.6.67 — differentiated welcome variants (audience × device type)
  { key: 'welcome_owner_desktop', channels: ['EMAIL'], descriptionEn: 'Welcome email — agency owner, verified from the desktop app', descriptionAr: 'رسالة ترحيب — صاحب وكالة، تم التأكيد من تطبيق سطح المكتب' },
  { key: 'welcome_owner_mobile', channels: ['EMAIL'], descriptionEn: 'Welcome email — agency owner, verified from the mobile app', descriptionAr: 'رسالة ترحيب — صاحب وكالة، تم التأكيد من تطبيق الهاتف' },
  { key: 'welcome_owner_web', channels: ['EMAIL'], descriptionEn: 'Welcome email — agency owner, verified from the web console', descriptionAr: 'رسالة ترحيب — صاحب وكالة، تم التأكيد من منصة الويب' },
  { key: 'welcome_customer_desktop', channels: ['EMAIL'], descriptionEn: 'Welcome email — regular customer, verified from the desktop app', descriptionAr: 'رسالة ترحيب — زبون عادي، تم التأكيد من تطبيق سطح المكتب' },
  { key: 'welcome_customer_mobile', channels: ['EMAIL'], descriptionEn: 'Welcome email — regular customer, verified from the mobile app', descriptionAr: 'رسالة ترحيب — زبون عادي، تم التأكيد من تطبيق الهاتف' },
  { key: 'welcome_customer_web', channels: ['EMAIL'], descriptionEn: 'Welcome email — regular customer, verified from the web app', descriptionAr: 'رسالة ترحيب — زبون عادي، تم التأكيد من تطبيق الويب' },
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

// ─── 0.6.67 — Differentiated welcome email (audience × device type) ──────────

export type WelcomePlatform = 'desktop' | 'mobile' | 'web'
export type WelcomeAudience = 'owner' | 'customer'

/**
 * Agency accounts (owners/staff) get setup-oriented wording; everyone else
 * (regular customers) gets take-a-ticket wording.
 */
export function welcomeAudienceForRole(role: string): WelcomeAudience {
  return role === 'AGENCY_OWNER' || role === 'AGENCY_STAFF' ? 'owner' : 'customer'
}

/** The most specific welcome template key for an audience × platform pair. */
export function welcomeTemplateKey(audience: WelcomeAudience, platform: WelcomePlatform): string {
  return `welcome_${audience}_${platform}`
}

/**
 * Deliver the welcome email for a freshly fully-verified account, choosing
 * the template by WHO the account is (agency owner vs regular customer) and
 * WHERE the verification happened (desktop app / mobile app / web browser).
 *
 * Specificity cascade: (audience × platform) row → the generic 'welcome' row.
 * renderTemplate() returns null for a key with neither a DB row nor a seed,
 * so a deleted/customized variant gracefully falls back. Every row stays
 * admin-editable in the templates manager.
 */
export async function deliverWelcomeEmail(opts: {
  target: string
  language: string
  fullName: string
  role: string
  platform: WelcomePlatform
  /** Optional agency branding for the email layout footer. */
  agencyId?: string
}): Promise<DeliverResult> {
  const audience = welcomeAudienceForRole(opts.role)
  const vars: TemplateVars = { fullName: opts.fullName }
  for (const key of [welcomeTemplateKey(audience, opts.platform), 'welcome']) {
    const rendered = await renderTemplate(key, 'EMAIL', opts.language, vars)
    if (!rendered) continue
    let html = rendered.html ?? undefined
    if (html && !isFullHtmlDocument(html)) {
      const branding = opts.agencyId ? await loadAgencyBranding(opts.agencyId) : undefined
      html = wrapEmailHtml({ bodyHtml: html, language: opts.language, branding })
    }
    const r = await sendEmail({ to: opts.target, subject: rendered.subject ?? `[${APP_NAME}]`, text: rendered.text, html })
    return { ...r, deliveredVia: 'EMAIL' }
  }
  return { success: false, error: `TEMPLATE_MISSING:welcome:${opts.language}` }
}
