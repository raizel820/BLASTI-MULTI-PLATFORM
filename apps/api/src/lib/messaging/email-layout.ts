/**
 * @blasti/api — Professional HTML email layout
 *
 * Wraps the app-template inner content (NotificationTemplate.htmlBody) into a
 * branded, email-client-safe document so every email leaves the system with
 * the BLASTI look (app logo + agency logo/info) instead of a bare text div:
 *
 *   ┌──────────────────────────────┐
 *   │  [app logo]   [agency logo]  │  header
 *   ├──────────────────────────────┤
 *   │  template htmlBody           │  body (admin-editable inner content)
 *   ├──────────────────────────────┤
 *   │  agency contact info         │  footer
 *   │  Sent via BLASTI · © year    │
 *   └──────────────────────────────┘
 *
 * Rules for maximum email-client compatibility:
 *   - table-based layout, inline styles only (no CSS classes)
 *   - no external fonts, no JS, max width 600px
 *   - RTL (dir="rtl") when the template language is Arabic
 *   - bodies that are already full documents (<html …>) pass through unwrapped
 */

import { db } from '@blasti/db'

const APP_NAME = 'BLASTI'
const BRAND_GREEN = '#059669'
const INK = '#111827'
const MUTED = '#6b7280'

/** Resolve the public base of THIS api server (env-driven; empty in pure dev). */
function publicBaseUrl(): string {
  const explicit = (process.env.PUBLIC_BASE_URL || process.env.CORS_ORIGIN || '').replace(/\/+$/, '')
  return explicit && /^https?:\/\//i.test(explicit) ? explicit : ''
}

/**
 * Turn a stored asset path (relative `/api/upload/file/...`) into an absolute
 * URL an email client can load. Absolute URLs pass through untouched; returns
 * null when no public base is configured (layout then degrades to text).
 */
export function absoluteAssetUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null
  if (/^(https?:)?\/\//i.test(pathOrUrl) || /^data:image\//i.test(pathOrUrl)) return pathOrUrl
  if (!pathOrUrl.startsWith('/')) return null
  const base = publicBaseUrl()
  return base ? `${base}${pathOrUrl}` : null
}

/** Absolute URL of the bundled BLASTI app logo (served by /api/branding/logo). */
export function appLogoAbsoluteUrl(): string | null {
  return absoluteAssetUrl('/api/branding/logo')
}

export function isFullHtmlDocument(html: string): boolean {
  return /<html[\s>]/i.test(html) || /<!doctype\s+html/i.test(html)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Agency branding ─────────────────────────────────────────────────────────

export interface EmailBranding {
  name?: string | null
  logoUrl?: string | null
  phone?: string | null
  email?: string | null
  website?: string | null
  address?: string | null
}

/** Load agency contact/logo info for branded emails (null-safe). */
export async function loadAgencyBranding(agencyId: string): Promise<EmailBranding | undefined> {
  try {
    const agency = await db.agency.findUnique({
      where: { id: agencyId },
      select: {
        name: true, logoUrl: true, phone: true, email: true, website: true,
        address: true, city: true,
      },
    })
    if (!agency) return undefined
    return {
      name: agency.name,
      logoUrl: absoluteAssetUrl(agency.logoUrl),
      phone: agency.phone,
      email: agency.email,
      website: agency.website,
      address: [agency.address, agency.city].filter(Boolean).join(', ') || null,
    }
  } catch {
    return undefined
  }
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export interface WrapEmailOptions {
  /** Admin-editable inner content (NotificationTemplate.htmlBody) */
  bodyHtml: string
  /** Template language — drives RTL ('ar') and footer copy */
  language?: string
  /** Optional agency branding (logo + contact info) */
  branding?: EmailBranding
  /** Hidden preheader shown in inbox list views */
  preheader?: string
}

const COPY_FOOTER = {
  en: { sentVia: `Sent via ${APP_NAME}`, rights: 'All rights reserved.' },
  fr: { sentVia: `Envoyé via ${APP_NAME}`, rights: 'Tous droits réservés.' },
  ar: { sentVia: `أُرسل عبر ${APP_NAME}`, rights: 'جميع الحقوق محفوظة.' },
} as const

/**
 * Wrap inner email content into the full branded document. The result is a
 * complete <!doctype html> string ready for the provider's `html` field.
 */
export function wrapEmailHtml(opts: WrapEmailOptions): string {
  const rtl = opts.language === 'ar'
  const dir = rtl ? 'rtl' : 'ltr'
  const align = rtl ? 'right' : 'left'
  const copy = COPY_FOOTER[(opts.language ?? 'en') as keyof typeof COPY_FOOTER] ?? COPY_FOOTER.en
  const appLogo = appLogoAbsoluteUrl()
  const branding = opts.branding
  const year = new Date().getFullYear()

  // ── Header: app logo (or wordmark) + optional agency logo / name ──
  const appLogoHtml = appLogo
    ? `<img src="${appLogo}" alt="${APP_NAME}" height="34" style="height:34px;width:auto;display:block;border:0;outline:none;" />`
    : `<span style="font-size:20px;font-weight:800;color:${BRAND_GREEN};letter-spacing:0.06em;">${APP_NAME}</span>`

  const agencyLogoHtml = branding?.logoUrl
    ? `<img src="${branding.logoUrl}" alt="${escapeHtml(branding.name ?? '')}" height="40" style="height:40px;max-width:120px;width:auto;display:inline-block;border:0;outline:none;" />`
    : branding?.name
      ? `<span style="font-size:14px;font-weight:700;color:${INK};">${escapeHtml(branding.name)}</span>`
      : ''

  // ── Footer: agency contact block + platform line ──
  const agencyContactBits = [
    branding?.phone,
    branding?.email,
    branding?.website?.replace(/^https?:\/\//i, ''),
    branding?.address,
  ].filter((bit): bit is string => Boolean(bit && bit.trim()))
  const agencyContactHtml = agencyContactBits.length
    ? `<p style="margin:6px 0 0 0;font-size:11px;line-height:1.7;color:${MUTED};text-align:${align};">${escapeHtml(agencyContactBits.join('  ·  '))}</p>`
    : ''

  const preheader = opts.preheader
    ? `<span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(opts.preheader)}</span>`
    : ''

  return `<!doctype html>
<html lang="${rtl ? 'ar' : (opts.language ?? 'en')}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<title>${APP_NAME}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;-webkit-font-smoothing:antialiased;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="padding:22px 28px 16px 28px;border-bottom:1px solid #eef2f7;" dir="${dir}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="${align}" style="text-align:${align};">${appLogoHtml}</td>
                ${agencyLogoHtml ? `<td align="${rtl ? 'left' : 'right'}" style="text-align:${rtl ? 'left' : 'right'};">${agencyLogoHtml}</td>` : ''}
              </tr>
            </table>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td dir="${dir}" style="padding:26px 28px 30px 28px;font-family:'Segoe UI',Tahoma,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.7;color:${INK};text-align:${align};">
            ${opts.bodyHtml}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 28px 20px 28px;background-color:#f8fafc;border-top:1px solid #eef2f7;" dir="${dir}">
            ${branding?.name ? `<p style="margin:0;font-size:12px;font-weight:700;color:${INK};text-align:${align};">${escapeHtml(branding.name)}</p>` : ''}
            ${agencyContactHtml}
            <p style="margin:8px 0 0 0;font-size:10px;line-height:1.6;color:#94a3b8;text-align:${align};">
              ${copy.sentVia} · © ${year} ${APP_NAME} — ${copy.rights}
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}
