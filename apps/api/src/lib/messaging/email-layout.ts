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
 *
 * App logo delivery (0.6.126) — the REAL app logo image, never a placeholder:
 *   The logo is attached INLINE to every email (MIME Content-ID
 *   'blasti-app-logo' — see getAppLogoAttachment(); the send adapter in
 *   email-service.ts merges it into the provider payload) and the header
 *   references it via <img src="cid:blasti-app-logo">. Inline cid images are
 *   the only mechanism that renders reliably across Gmail, Outlook and Apple
 *   Mail — remote URL loading is commonly blocked, and a missing
 *   PUBLIC_BASE_URL previously degraded the header to a text wordmark
 *   placeholder. When the asset file is absent the layout falls back to the
 *   absolute URL (if a public base is configured) or the text wordmark.
 */

import { existsSync, readFileSync } from 'fs'
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

// ─── Inline app-logo attachment (cid: image) ───────────────────────────────────

/** MIME Content-ID of the inline BLASTI app logo — referenced as cid:<CID>. */
export const APP_LOGO_CID = 'blasti-app-logo'

export interface EmailAttachment {
  filename: string
  /** base64-encoded file content */
  content: string
  /** MIME Content-ID — when set the attachment is inline (referenced via cid:) */
  content_id?: string
}

let cachedAppLogoAttachment: EmailAttachment | null | undefined

/**
 * The bundled BLASTI app logo (apps/api/assets/branding/logo.png) as an
 * inline email attachment — base64 + Content-ID. Cached per process; returns
 * null when the asset file is missing (layout degrades to the remote-URL
 * logo, then the text wordmark). Same on-disk asset /api/branding/logo serves.
 */
export function getAppLogoAttachment(): EmailAttachment | null {
  if (cachedAppLogoAttachment !== undefined) return cachedAppLogoAttachment
  try {
    // Resolved relative to this module (src/lib/messaging → api root/assets),
    // same technique as routes/branding.ts.
    const logoPath = new URL('../../../assets/branding/logo.png', import.meta.url).pathname
    if (existsSync(logoPath)) {
      cachedAppLogoAttachment = {
        filename: 'blasti-logo.png',
        content: readFileSync(logoPath).toString('base64'),
        content_id: APP_LOGO_CID,
      }
      return cachedAppLogoAttachment
    }
  } catch {
    // fall through — no inline attachment
  }
  cachedAppLogoAttachment = null
  return null
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
  // Delivery order (most reliable first):
  //   1. cid: inline attachment (blasti-app-logo) — renders even when remote
  //      image loading is blocked (Gmail/Outlook defaults) and works offline
  //      of PUBLIC_BASE_URL. The attachment itself is merged into EVERY
  //      outgoing message by email-service.ts (getAppLogoAttachment()).
  //   2. absolute URL of /api/branding/logo — when PUBLIC_BASE_URL is set.
  //   3. white text wordmark — last resort (no asset, no public base).
  // The white chip keeps colored logos readable on the green band.
  const appLogoSrc = getAppLogoAttachment() ? `cid:${APP_LOGO_CID}` : appLogoAbsoluteUrl()
  const branding = opts.branding
  const year = new Date().getFullYear()

  // ── Header: emerald brand band — white chip holds the real app logo ──
  // The logo is served by /api/branding/logo (the live admin-uploaded asset);
  // the white chip keeps colored logos readable on the green band.
  const appLogoHtml = appLogoSrc
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:10px;"><tr><td style="padding:8px 14px;background:#ffffff;border-radius:10px;"><img src="${appLogoSrc}" alt="${APP_NAME}" height="34" style="height:34px;max-width:150px;width:auto;display:block;border:0;outline:none;" /></td></tr></table>`
    : `<span style="font-size:21px;font-weight:800;color:#ffffff;letter-spacing:0.08em;">${APP_NAME}</span>`

  const agencyLogoHtml = branding?.logoUrl
    ? `<img src="${branding.logoUrl}" alt="${escapeHtml(branding.name ?? '')}" height="36" style="height:36px;max-width:110px;width:auto;display:inline-block;border:0;outline:none;border-radius:6px;" />`
    : branding?.name
      ? `<span style="font-size:13px;font-weight:700;color:#d1fae5;background:rgba(255,255,255,0.14);border-radius:999px;padding:5px 12px;display:inline-block;">${escapeHtml(branding.name)}</span>`
      : ''

  // ── Footer: agency contact block + platform line ──
  const agencyContactBits = [
    branding?.phone,
    branding?.email,
    branding?.website?.replace(/^https?:\/\//i, ''),
    branding?.address,
  ].filter((bit): bit is string => Boolean(bit && bit.trim()))
  const agencyContactHtml = agencyContactBits.length
    ? `<p style="margin:6px 0 0 0;font-size:11px;line-height:1.7;color:#94a3b8;text-align:${align};">${escapeHtml(agencyContactBits.join('  ·  '))}</p>`
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
        <!-- Header — full-width emerald brand band -->
        <tr>
          <td style="padding:0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND_GREEN};background-image:linear-gradient(135deg,#059669 0%,#047857 60%,#065f46 100%);">
              <tr>
                <td style="padding:20px 28px;" dir="${dir}">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="${align}" style="text-align:${align};">${appLogoHtml}</td>
                      ${agencyLogoHtml ? `<td align="${rtl ? 'left' : 'right'}" style="text-align:${rtl ? 'left' : 'right'};">${agencyLogoHtml}</td>` : ''}
                    </tr>
                  </table>
                </td>
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
        <!-- Footer — dark ink footer with agency contact -->
        <tr>
          <td style="padding:18px 28px 20px 28px;background-color:#0f172a;border-top:3px solid ${BRAND_GREEN};" dir="${dir}">
            ${branding?.name ? `<p style="margin:0;font-size:12px;font-weight:700;color:#f8fafc;text-align:${align};">${escapeHtml(branding.name)}</p>` : ''}
            ${agencyContactHtml}
            <p style="margin:8px 0 0 0;font-size:10px;line-height:1.6;color:#64748b;text-align:${align};">
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
