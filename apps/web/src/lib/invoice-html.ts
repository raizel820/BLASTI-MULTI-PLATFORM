/**
 * Invoice / receipt A4 document builder (client-side, on-device rendering).
 *
 * Builds a STANDALONE HTML document for the invoice — used by:
 *  - the admin billing-manager preview dialog (iframe srcDoc),
 *  - the print flow (hidden iframe → window.print → Save as PDF),
 *  - the Electron printToPDF flow (apps/desktop main.js → invoice:save-pdf).
 *
 * A4 (210mm × 297mm), supports ar (RTL) / fr / en, and embeds the BLASTI
 * logo + verification QR as base64 data URLs so the document is fully
 * self-contained (works from srcDoc, data: URLs and print contexts).
 */

import type { InvoiceRecord } from './billing-client'
import { isRTL, type Language } from '@/i18n'

export interface InvoiceDocumentAssets {
  logoDataUrl?: string
  qrDataUrl?: string
  verifyUrl?: string
}

// ─── Labels (self-contained — the PDF must render standalone) ───────────────

type L10N = Record<string, string>

const L: Record<'ar' | 'fr' | 'en', L10N> = {
  ar: {
    invoice: 'فاتورة',
    receipt: 'وصل دفع',
    number: 'رقم الفاتورة',
    issueDate: 'تاريخ الإصدار',
    issuer: 'المُصدر',
    recipient: 'العميل',
    customerService: 'خدمة العملاء',
    description: 'البيان',
    qty: 'الكمية',
    unitPrice: 'سعر الوحدة',
    amount: 'المبلغ',
    total: 'المجموع المدفوع',
    paidAmount: 'المبلغ المدفوع',
    paymentDetails: 'تفاصيل الدفع',
    paymentMethod: 'طريقة الدفع',
    paymentProvider: 'مزود الدفع',
    transactionRef: 'مرجع العملية',
    chargilyRef: 'معرف Chargily',
    transactionId: 'معرف العملية',
    paidAt: 'تاريخ الدفع',
    subscriptionPeriod: 'فترة الاشتراك',
    periodStart: 'البداية',
    periodEnd: 'النهاية',
    tier: 'الخطة',
    period: 'المدة',
    months: '{n} شهر',
    smsPack: 'حزمة رسائل SMS',
    subscriptionDesc: 'اشتراك BLASTI — {tier}',
    smsDesc: 'حزمة {qty} رسالة SMS',
    verifyTitle: 'التحقق من صحة المستند',
    verifyHint: 'امسح رمز QR أو استخدم الرابط للتحقق من صحة هذه الفاتورة عبر خوادم BLASTI.',
    footerNote: 'هذه الفاتورة صادرة إلكترونياً وصالحة دون توقيع يدوي. يُحتسب المبلغ بالدينار الجزائري (DZD).',
    cancelNote: '⚠ هذه الفاتورة ملغاة ولا تعد صالحة.',
    legal: 'المعلومات القانونية',
    currencyDZD: 'دج',
    tel: 'هاتف',
    email: 'البريد',
    code: 'رمز الوكالة',
    uid: 'المعرف',
  },
  fr: {
    invoice: 'Facture',
    receipt: 'Reçu de paiement',
    number: 'N° de facture',
    issueDate: "Date d'émission",
    issuer: 'Émetteur',
    recipient: 'Client',
    customerService: 'Service client',
    description: 'Désignation',
    qty: 'Qté',
    unitPrice: 'Prix unitaire',
    amount: 'Montant',
    total: 'Total payé',
    paidAmount: 'Montant payé',
    paymentDetails: 'Détails du paiement',
    paymentMethod: 'Mode de paiement',
    paymentProvider: 'Fournisseur de paiement',
    transactionRef: 'Référence de transaction',
    chargilyRef: 'ID Chargily',
    transactionId: 'ID de transaction',
    paidAt: 'Date de paiement',
    subscriptionPeriod: "Période d'abonnement",
    periodStart: 'Début',
    periodEnd: 'Fin',
    tier: 'Formule',
    period: 'Durée',
    months: '{n} mois',
    smsPack: 'Pack de SMS',
    subscriptionDesc: 'Abonnement BLASTI — {tier}',
    smsDesc: 'Pack de {qty} SMS',
    verifyTitle: 'Vérification du document',
    verifyHint: "Scannez le QR code ou utilisez le lien pour vérifier l'authenticité de cette facture via les serveurs BLASTI.",
    footerNote: "Facture émise électroniquement, valable sans signature manuscrite. Montants en dinar algérien (DZD).",
    cancelNote: '⚠ Cette facture est annulée et n\'est plus valable.',
    legal: 'Informations légales',
    currencyDZD: 'DZD',
    tel: 'Tél',
    email: 'E-mail',
    code: "Code de l'agence",
    uid: 'ID',
  },
  en: {
    invoice: 'Invoice',
    receipt: 'Payment receipt',
    number: 'Invoice number',
    issueDate: 'Issue date',
    issuer: 'Issuer',
    recipient: 'Customer',
    customerService: 'Customer service',
    description: 'Description',
    qty: 'Qty',
    unitPrice: 'Unit price',
    amount: 'Amount',
    total: 'Total paid',
    paidAmount: 'Amount paid',
    paymentDetails: 'Payment details',
    paymentMethod: 'Payment method',
    paymentProvider: 'Payment provider',
    transactionRef: 'Transaction reference',
    chargilyRef: 'Chargily ID',
    transactionId: 'Transaction ID',
    paidAt: 'Payment date',
    subscriptionPeriod: 'Subscription period',
    periodStart: 'Start',
    periodEnd: 'End',
    tier: 'Plan',
    period: 'Duration',
    months: '{n} month(s)',
    smsPack: 'SMS pack',
    subscriptionDesc: 'BLASTI subscription — {tier}',
    smsDesc: '{qty} SMS credits pack',
    verifyTitle: 'Document verification',
    verifyHint: 'Scan the QR code or open the link to verify the authenticity of this invoice with the BLASTI servers.',
    footerNote: 'This invoice is issued electronically and is valid without a handwritten signature. Amounts in Algerian Dinar (DZD).',
    cancelNote: '⚠ This invoice has been cancelled and is no longer valid.',
    legal: 'Legal information',
    currencyDZD: 'DZD',
    tel: 'Tel',
    email: 'Email',
    code: 'Agency code',
    uid: 'ID',
  },
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function money(amount: number, currency: string, lang: Language): string {
  try {
    const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US'
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(amount) + ` ${currency === 'DZD' && lang === 'ar' ? 'دج' : currency}`
  } catch {
    return `${amount} ${currency}`
  }
}

function fmtDate(iso: string | null | undefined, lang: Language): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-GB'
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return iso
  }
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function nvl(value: unknown, fallback = '—'): string {
  const s = String(value ?? '').trim()
  return s ? s : fallback
}

const PAYMENT_METHOD_LABELS: Record<string, Partial<L10N>> = {
  CCP: { ar: 'حساب بريدي جاري (CCP)', fr: 'Compte postal (CCP)', en: 'CCP postal account' },
  BANK_TRANSFER: { ar: 'تحويل بنكي', fr: 'Virement bancaire', en: 'Bank transfer' },
  E_WALLET: { ar: 'محفظة إلكترونية', fr: 'Portefeuille électronique', en: 'E-wallet' },
  CASH: { ar: 'نقداً', fr: 'Espèces', en: 'Cash' },
  EDAHABIA: { ar: 'بطاقة الذهبية', fr: 'Carte EDAHABIA', en: 'EDAHABIA card' },
  CIB: { ar: 'بطاقة CIB', fr: 'Carte CIB', en: 'CIB card' },
}

function methodLabel(method: string | undefined, lang: Language): string {
  if (!method) return '—'
  const known = PAYMENT_METHOD_LABELS[method]?.[lang]
  return known || method
}

// ─── Document builder ────────────────────────────────────────────────────────

export interface InvoiceHtmlOptions {
  lang: Language
  assets?: InvoiceDocumentAssets
}

export function buildInvoiceHtml(invoice: InvoiceRecord, options: InvoiceHtmlOptions): string {
  const lang = options.lang
  const rtl = isRTL(lang)
  const t = (key: string, params?: Record<string, string>): string => {
    let str = L[lang][key] ?? L.en[key] ?? key
    if (params) {
      Object.entries(params).forEach(([k, v]) => { str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v) })
    }
    return str
  }

  const { logoDataUrl, qrDataUrl, verifyUrl } = options.assets || {}
  const issuer = invoice.issuer || {}
  const recipient = (invoice.recipient || {}) as Record<string, unknown>
  const details = invoice.details || {}
  const isSms = invoice.sourceType === 'SMS'
  const docTitle = isSms ? t('receipt') : t('invoice')

  // ── Line items ──
  const items: Array<{ description: string; qty: number; unitPrice: number; amount: number }> = []
  if (isSms) {
    const qty = Number(details.quantity ?? 1)
    const price = Number(invoice.amount ?? details.price ?? 0)
    items.push({
      description: t('smsDesc', { qty: String(qty) }),
      qty,
      unitPrice: qty > 0 ? price / qty : price,
      amount: price,
    })
  } else {
    const tier = nvl(details.tierDisplayName || details.tier, invoice.sourceType)
    const months = Number(details.periodMonths ?? 1)
    items.push({
      description: t('subscriptionDesc', { tier }),
      qty: 1,
      unitPrice: invoice.amount,
      amount: invoice.amount,
    })
    // Period sub-line rendered in the details grid below (not a priced row).
    void months
  }

  const itemsRows = items.map((it) => `
    <tr>
      <td class="desc">${esc(it.description)}</td>
      <td class="num">${it.qty}</td>
      <td class="num">${esc(money(it.unitPrice, invoice.currency, lang))}</td>
      <td class="num strong">${esc(money(it.amount, invoice.currency, lang))}</td>
    </tr>
  `).join('')

  // ── Issuer / recipient blocks ──
  const legalRow = (label: string, value: string) => `
    <div class="legal-row"><span class="legal-label">${esc(label)}</span><span class="legal-value">${esc(nvl(value))}</span></div>`
  const rcLabel = issuer.rcType === 'AUTO_ENTREPRENEUR'
    ? { ar: 'المقاول الذاتي', fr: 'Auto-entrepreneur', en: 'Auto-entrepreneur' }[lang]
    : { ar: 'السجل التجاري (RC)', fr: 'Registre de commerce (RC)', en: 'Commercial register (RC)' }[lang]

  const issuerBlock = `
    <div class="party">
      <div class="party-title">${esc(t('issuer'))}</div>
      <div class="party-name">${esc(nvl(issuer.name, 'BLASTI'))}</div>
      ${legalRow('NIF', nvl(issuer.nif))}
      ${legalRow('NIS', nvl(issuer.nis))}
      ${legalRow('RIB/RIP', nvl(issuer.rib))}
      ${legalRow(rcLabel, nvl(issuer.rc))}
      ${legalRow(t('customerService'), nvl(issuer.servicePhone))}
      ${legalRow('', nvl(issuer.address))}
    </div>`

  const recipientIsAgency = invoice.recipientType === 'AGENCY'
  const recipientBlock = `
    <div class="party">
      <div class="party-title">${esc(t('recipient'))}</div>
      <div class="party-name">${esc(nvl(recipient.legalName || invoice.recipientName))}</div>
      ${recipientIsAgency ? legalRow(t('code'), nvl(recipient.code)) : ''}
      ${legalRow('NIF', nvl(recipient.nif))}
      ${legalRow('NIS', nvl(recipient.nis))}
      ${recipientIsAgency ? legalRow('RIB/RIP', nvl(recipient.rib)) : ''}
      ${legalRow(rcLabel, nvl(recipient.rc))}
      ${legalRow(t('tel'), nvl(recipient.phone || recipient.servicePhone))}
      ${legalRow(t('email'), nvl(recipient.email))}
      ${legalRow('', nvl(recipient.legalAddress || recipient.address))}
    </div>`

  // ── Payment details grid ──
  const paymentRows: string[] = []
  paymentRows.push(kvRow(t('paymentMethod'), methodLabel(details.paymentMethod as string, lang)))
  const provider = String(details.paymentProvider ?? '').trim()
  if (provider) paymentRows.push(kvRow(t('paymentProvider'), provider === 'chargily' ? 'Chargily (EDAHABIA / CIB)' : provider))
  const chargilyRef = String(details.chargilyCheckoutId ?? details.providerRef ?? '').trim()
  if (chargilyRef) paymentRows.push(kvRow(t('chargilyRef'), chargilyRef))
  if (details.transactionId) paymentRows.push(kvRow(t('transactionId'), String(details.transactionId)))
  if (details.smsPurchaseId) paymentRows.push(kvRow(t('transactionId'), String(details.smsPurchaseId)))
  paymentRows.push(kvRow(t('paidAt'), fmtDate((details.paidAt as string) || invoice.issuedAt, lang)))

  function kvRow(label: string, value: string): string {
    return `<div class="kv"><span class="kv-label">${esc(label)}</span><span class="kv-value">${esc(nvl(value))}</span></div>`
  }

  // ── Subscription period (only for SUBSCRIPTION invoices) ──
  const periodBlock = !isSms ? `
    <div class="section">
      <div class="section-title">${esc(t('subscriptionPeriod'))}</div>
      <div class="kv-grid">
        ${kvRow(t('tier'), nvl(details.tierDisplayName || details.tier))}
        ${kvRow(t('period'), t('months', { n: String(Number(details.periodMonths ?? 1)) }))}
        ${kvRow(t('periodStart'), fmtDate(details.periodStartsAt as string, lang))}
        ${kvRow(t('periodEnd'), fmtDate((details.periodExpiresAt as string) || null, lang))}
      </div>
    </div>` : ''

  // ── Verification footer ──
  const verifyBlock = qrDataUrl ? `
    <div class="verify">
      <div class="verify-text">
        <div class="verify-title">${esc(t('verifyTitle'))}</div>
        <div class="verify-hint">${esc(t('verifyHint'))}</div>
        ${verifyUrl ? `<div class="verify-url" dir="ltr">${esc(verifyUrl)}</div>` : ''}
      </div>
      <img class="verify-qr" src="${qrDataUrl}" alt="QR" />
    </div>` : ''

  const cancelledBanner = invoice.status === 'CANCELLED'
    ? `<div class="cancelled">${esc(t('cancelNote'))}</div>` : ''

  const dir = rtl ? 'rtl' : 'ltr'
  const align = rtl ? 'right' : 'left'

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8" />
<title>${esc(docTitle)} ${esc(invoice.displayNumber)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", "Noto Naskh Arabic", "Amiri", Tahoma, Arial, sans-serif;
    color: #1e293b; font-size: 11.5pt; line-height: 1.45;
  }
  .page { width: 186mm; margin: 0 auto; padding: 10mm 12mm; }
  .doc-header { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 3px solid #0f766e; padding-bottom: 6mm; margin-bottom: 6mm; }
  .brand { display: flex; align-items: center; gap: 4mm; }
  .brand img { height: 18mm; width: auto; }
  .doc-kind { text-align: ${align === 'right' ? 'left' : 'right'}; }
  .doc-kind h1 { margin: 0 0 2mm; font-size: 20pt; color: #0f766e; letter-spacing: 1px; }
  .doc-num { font-size: 13pt; font-weight: 700; direction: ltr; unicode-bidi: embed; }
  .doc-date { color: #64748b; font-size: 10pt; margin-top: 1.5mm; }
  .parties { display: flex; gap: 6mm; margin-bottom: 6mm; }
  .party { flex: 1; border: 1px solid #cbd5e1; border-radius: 3mm; padding: 4mm 5mm; background: #f8fafc; }
  .party-title { font-size: 9pt; text-transform: uppercase; letter-spacing: 1.5px; color: #0f766e; font-weight: 700; margin-bottom: 2mm; }
  .party-name { font-weight: 700; font-size: 13pt; margin-bottom: 2.5mm; }
  .legal-row { display: flex; gap: 3mm; font-size: 9.5pt; padding: 0.4mm 0; }
  .legal-label { color: #64748b; min-width: 24mm; }
  .legal-value { font-weight: 600; }
  .section { border: 1px solid #cbd5e1; border-radius: 3mm; padding: 4mm 5mm; margin-bottom: 5mm; }
  .section-title { font-size: 9pt; text-transform: uppercase; letter-spacing: 1.5px; color: #0f766e; font-weight: 700; margin-bottom: 2.5mm; }
  .kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1mm 6mm; }
  .kv { display: flex; gap: 3mm; font-size: 10pt; padding: 0.5mm 0; }
  .kv-label { color: #64748b; min-width: 34mm; }
  .kv-value { font-weight: 600; word-break: break-all; }
  table.items { width: 100%; border-collapse: collapse; margin: 2mm 0 5mm; }
  table.items th { background: #0f766e; color: #fff; font-size: 10pt; padding: 2.5mm 3mm; text-align: ${align}; }
  table.items td { border-bottom: 1px solid #e2e8f0; padding: 3mm; font-size: 10.5pt; text-align: ${align}; }
  table.items td.num { text-align: end; white-space: nowrap; }
  table.items td.desc { text-align: ${align}; }
  table.items td.strong { font-weight: 700; }
  table.items tfoot td { font-weight: 800; font-size: 12pt; color: #0f172a; background: #f1f5f9; }
  .verify { display: flex; gap: 6mm; align-items: center; border: 1.5px dashed #0f766e; border-radius: 3mm; padding: 4mm 5mm; margin-top: 6mm; background: #f0fdfa; }
  .verify-title { font-weight: 700; font-size: 11pt; margin-bottom: 1mm; }
  .verify-hint { font-size: 9.5pt; color: #475569; }
  .verify-url { font-size: 8.5pt; color: #0f766e; direction: ltr; unicode-bidi: embed; word-break: break-all; margin-top: 1.5mm; font-family: monospace; }
  .verify-qr { width: 30mm; height: 30mm; flex-shrink: 0; }
  .cancelled { background: #fef2f2; color: #b91c1c; border: 1.5px solid #ef4444; border-radius: 3mm; padding: 3mm 5mm; margin: 4mm 0; font-weight: 700; text-align: center; }
  .footer-note { margin-top: 6mm; padding-top: 3mm; border-top: 1px solid #e2e8f0; font-size: 9pt; color: #64748b; }
  .status-badge { display: inline-block; padding: 1mm 3mm; border-radius: 2mm; font-size: 9pt; font-weight: 700; }
  .status-issued { background: #dcfce7; color: #166534; }
  .status-cancelled { background: #fee2e2; color: #b91c1c; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page { width: auto; padding: 0; } }
</style>
</head>
<body>
  <div class="page">
    <div class="doc-header">
      <div class="brand">
        ${logoDataUrl ? `<img src="${logoDataUrl}" alt="BLASTI" />` : `<div style="font-size:18pt;font-weight:800;color:#0f766e;">BLASTI</div>`}
      </div>
      <div class="doc-kind">
        <h1>${esc(docTitle)}</h1>
        <div class="doc-num">${esc(invoice.displayNumber)}</div>
        <div class="doc-date">${esc(t('issueDate'))}: ${esc(fmtDate(invoice.issuedAt, lang))}</div>
        <div style="margin-top:2mm;"><span class="status-badge ${invoice.status === 'CANCELLED' ? 'status-cancelled' : 'status-issued'}">${esc(invoice.status === 'CANCELLED' ? (lang === 'ar' ? 'ملغاة' : lang === 'fr' ? 'ANNULÉE' : 'CANCELLED') : (lang === 'ar' ? 'صالحة' : lang === 'fr' ? 'VALIDE' : 'VALID'))}</span></div>
      </div>
    </div>

    ${cancelledBanner}

    <div class="parties">
      ${issuerBlock}
      ${recipientBlock}
    </div>

    <table class="items">
      <thead>
        <tr>
          <th class="desc">${esc(t('description'))}</th>
          <th>${esc(t('qty'))}</th>
          <th>${esc(t('unitPrice'))}</th>
          <th>${esc(t('amount'))}</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRows}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3" class="num">${esc(t('total'))}</td>
          <td class="num strong">${esc(money(invoice.amount, invoice.currency, lang))}</td>
        </tr>
      </tfoot>
    </table>

    ${periodBlock}

    <div class="section">
      <div class="section-title">${esc(t('paymentDetails'))}</div>
      <div class="kv-grid">
        ${paymentRows.join('')}
      </div>
    </div>

    ${verifyBlock}

    <div class="footer-note">${esc(t('footerNote'))}</div>
  </div>
</body>
</html>`
}

// ─── Actions: print / download PDF (on-device) ───────────────────────────────

declare global {
  interface Window {
    electronAPI?: {
      saveInvoicePdf?: (html: string, suggestedName: string) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
      [key: string]: unknown
    }
  }
}

function uniqueHtmlWindowId(): string {
  return `blasti-invoice-${Date.now()}`
}

/**
 * Print (or save as PDF) the invoice natively on the user's device:
 *  - Electron: main-process `printToPDF` (native Chromium PDF engine) with a
 *    system save dialog → a real .pdf file. Falls back to silent printing.
 *  - Browser (web + mobile shells): hidden iframe + window.print() — the OS
 *    print dialog natively offers "Save as PDF".
 */
export async function printOrDownloadInvoice(
  invoice: InvoiceRecord,
  assets: InvoiceDocumentAssets,
  lang: Language,
  mode: 'print' | 'download',
): Promise<{ ok: boolean; message?: string }> {
  const html = buildInvoiceHtml(invoice, { lang, assets })
  const fileName = `BLASTI-${invoice.displayNumber.replace('/', '-')}.pdf`

  // 1) Electron — native PDF via the main process (real file on disk).
  //    ('download' mode only — 'print' goes straight to the print flow.)
  if (mode === 'download' && typeof window !== 'undefined' && window.electronAPI?.saveInvoicePdf) {
    try {
      const result = await window.electronAPI.saveInvoicePdf(html, fileName)
      if (result?.ok) return { ok: true, message: result.path }
      if (result?.canceled) return { ok: false, message: 'canceled' }
      // On failure, fall through to the browser print flow.
    } catch {
      // fall through to the browser print flow
    }
  }

  // 2) Browser — hidden iframe + print (user picks a printer or Save as PDF).
  if (typeof window === 'undefined') return { ok: false, message: 'no window' }

  const iframe = document.createElement('iframe')
  iframe.id = uniqueHtmlWindowId()
  iframe.style.position = 'fixed'
  iframe.style.right = '0'
  iframe.style.bottom = '0'
  iframe.style.width = '0'
  iframe.style.height = '0'
  iframe.style.border = '0'
  iframe.setAttribute('aria-hidden', 'true')
  iframe.title = fileName

  document.body.appendChild(iframe)
  try {
    const doc = iframe.contentDocument
    if (!doc) throw new Error('iframe document unavailable')
    doc.open()
    doc.write(html)
    doc.close()

    await new Promise<void>((resolve) => {
      if (iframe.contentWindow?.document.readyState === 'complete') resolve()
      else iframe.addEventListener('load', () => resolve(), { once: true })
    })
    // Give the embedded data-URL images (logo/QR) a beat to decode.
    await new Promise((resolve) => setTimeout(resolve, 350))

    iframe.contentWindow?.focus()
    iframe.contentWindow?.print()
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  } finally {
    // Remove the frame once the dialog closes (print blocks until done).
    setTimeout(() => { try { iframe.remove() } catch { /* noop */ } }, 60_000)
  }
}

/** Open the verify URL encoded in the QR (admin/agency/customer can share it). */
export function openInvoiceVerifyUrl(verifyUrl: string): void {
  try { window.open(verifyUrl, '_blank', 'noopener') } catch { /* popup blocked */ }
}
