/**
 * Billing / Invoice API client (web + desktop + mobile shells).
 *
 * All endpoints live under /api/billing (see apps/api/src/routes/billing.ts).
 * The PDF is rendered ON-DEVICE from the invoice record — the server never
 * generates or stores PDFs.
 *
 * Every call goes through apiFetch() so the 3-layer failover chain
 * (Cloud API → LAN master → offline cache) applies to billing too.
 */

import { apiFetch } from './api-fetch'

export interface InvoiceRecord {
  id: string
  displayNumber: string
  number: number
  year: number
  sourceType: 'SUBSCRIPTION' | 'SMS' | 'HARDWARE' | string
  sourceId: string
  agencyId: string | null
  userId: string
  recipientType: 'AGENCY' | 'CUSTOMER' | string
  recipientName: string
  issuer: {
    name?: string
    address?: string
    nif?: string
    nis?: string
    rib?: string
    rc?: string
    rcType?: string
    servicePhone?: string
  }
  recipient: Record<string, unknown>
  details: {
    kind?: string
    tier?: string
    tierDisplayName?: string
    planNameSnapshot?: string
    periodMonths?: number
    billingCycle?: string
    periodStartsAt?: string
    periodExpiresAt?: string | null
    quantity?: number
    unitPrice?: number
    price?: number
    paymentMethod?: string
    paymentProvider?: string
    providerRef?: string
    chargilyCheckoutId?: string
    webhookVerified?: boolean
    transactionId?: string
    smsPurchaseId?: string
    paidAt?: string
    [key: string]: unknown
  }
  amount: number
  currency: string
  status: 'ISSUED' | 'CANCELLED' | string
  verificationToken: string
  verificationCount: number
  lastVerifiedAt: string | null
  issuedBy: string
  issuedAt: string
  createdAt: string
  updatedAt: string
}

export interface InvoiceVerificationEvent {
  id: string
  verifierRole: string
  verifierId: string | null
  ip: string | null
  verifiedAt: string
}

export interface BlastiLegalInfo {
  name: string
  address: string
  nif: string
  nis: string
  rib: string
  rc: string
  rcType: string
  servicePhone: string
}

async function readError(res: { ok: boolean; status: number; json: () => Promise<unknown> }): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    return data?.error || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as T & { success?: boolean; error?: string }
  if (data && data.success === false) throw new Error(data.error || 'Request failed')
  return data
}

async function sendJson<T>(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = (await res.json()) as T & { success?: boolean; error?: string }
  if (data && data.success === false) throw new Error(data.error || 'Request failed')
  return data
}

// ─── Invoices ────────────────────────────────────────────────────────────────

export interface InvoiceListFilters {
  year?: number
  sourceType?: string
  status?: string
  q?: string
  limit?: number
  offset?: number
}

/** 0.6.55 — server-computed KPI totals over the whole filtered set. */
export interface InvoiceTotals {
  issuedCount: number
  invoicedAmount: number
  cancelled: number
  verifications: number
}

export async function fetchInvoices(filters: InvoiceListFilters = {}): Promise<{ invoices: InvoiceRecord[]; total: number; totals?: InvoiceTotals }> {
  const params = new URLSearchParams()
  if (filters.year) params.set('year', String(filters.year))
  if (filters.sourceType) params.set('sourceType', filters.sourceType)
  if (filters.status) params.set('status', filters.status)
  if (filters.q) params.set('q', filters.q)
  params.set('limit', String(filters.limit ?? 50))
  params.set('offset', String(filters.offset ?? 0))
  const data = await getJson<{ invoices: InvoiceRecord[]; total: number; totals?: InvoiceTotals }>(`/api/billing/invoices?${params.toString()}`)
  return { invoices: data.invoices ?? [], total: data.total ?? 0, totals: data.totals }
}

export async function fetchInvoice(id: string): Promise<InvoiceRecord> {
  const data = await getJson<{ invoice: InvoiceRecord }>(`/api/billing/invoices/${id}`)
  return data.invoice
}

/** QR PNG data URL + the public verify URL encoded inside it. */
export async function fetchInvoiceQr(id: string): Promise<{ dataUrl: string; verifyUrl: string; token: string }> {
  return getJson<{ dataUrl: string; verifyUrl: string; token: string }>(`/api/billing/invoices/${id}/qr`)
}

export async function fetchInvoiceVerifications(id: string): Promise<InvoiceVerificationEvent[]> {
  const data = await getJson<{ verifications: InvoiceVerificationEvent[] }>(`/api/billing/invoices/${id}/verifications`)
  return data.verifications ?? []
}

/** Admin backfill — issue an invoice for a legacy settled payment. */
export async function ensureInvoice(sourceType: 'TRANSACTION' | 'SMS', sourceId: string): Promise<InvoiceRecord> {
  const data = await sendJson<{ invoice: InvoiceRecord }>('/api/billing/invoices/ensure', 'POST', { sourceType, sourceId })
  return data.invoice
}

// ─── 0.6.55 — legacy backfill (bulk) ────────────────────────────────────────

export interface BackfillStatus {
  missing: number
  candidates: number
  byType: { transaction: number; sms: number }
}

export interface BackfillRunResult {
  created: number
  failed: number
  remaining: number
  scanned: number
  errors: Array<{ sourceId: string; error: string }>
}

/** How many settled payments still lack an invoice (drives the banner). */
export async function fetchBackfillStatus(): Promise<BackfillStatus> {
  const data = await getJson<BackfillStatus>('/api/billing/invoices/backfill-status')
  return data
}

/** Idempotently issue invoices for up to `max` settled payments lacking one. */
export async function runBackfillAll(max = 100): Promise<BackfillRunResult> {
  return sendJson<BackfillRunResult>('/api/billing/invoices/backfill-all', 'POST', { max })
}

export async function cancelInvoice(id: string): Promise<InvoiceRecord> {
  const data = await sendJson<{ invoice: InvoiceRecord }>(`/api/billing/invoices/${id}/cancel`, 'POST')
  return data.invoice
}

// ─── Verification (QR scan / public link) ────────────────────────────────────

export interface InvoiceVerifyResult {
  valid: boolean
  reason?: 'NOT_FOUND' | 'CANCELLED'
  invoice?: {
    displayNumber: string
    year: number
    number: number
    sourceType: string
    status: string
    amount: number
    currency: string
    recipientName: string
    recipientType: string
    issuerName: string
    issuedAt: string
    verificationCount: number
    lastVerifiedAt: string | null
  }
}

/** Extract the verification token from a scanned QR payload (URL or raw token). */
export function extractVerificationToken(payload: string): string | null {
  const raw = (payload || '').trim()
  if (!raw) return null
  const m = raw.match(/\/invoice\/verify\/([A-Za-z0-9_\-.]+)/)
  if (m) return m[1]
  // Raw token pasted directly (32-char base64url)
  if (/^[A-Za-z0-9_\-.]{20,120}$/.test(raw)) return raw
  return null
}

/** POST — the in-app QR scanner path. Marks the invoice checked on success. */
export async function verifyInvoiceToken(token: string): Promise<InvoiceVerifyResult> {
  return sendJson<InvoiceVerifyResult>('/api/billing/invoices/verify', 'POST', { token })
}

/** GET — the public web-link path (`#/invoice/verify/<token>`). */
export async function verifyInvoiceTokenPublic(token: string): Promise<InvoiceVerifyResult> {
  const res = await apiFetch(`/api/billing/verify/${encodeURIComponent(token)}`)
  if (!res.ok) {
    // Rate limits / invalid payloads still carry a JSON body — surface it.
    try {
      return (await res.json()) as InvoiceVerifyResult
    } catch {
      return { valid: false, reason: 'NOT_FOUND' }
    }
  }
  return (await res.json()) as InvoiceVerifyResult
}

// ─── BLASTI legal info (admin) ───────────────────────────────────────────────

export async function fetchBlastiLegalInfo(): Promise<BlastiLegalInfo> {
  const data = await getJson<{ legalInfo: BlastiLegalInfo }>('/api/billing/legal-info')
  return data.legalInfo
}

export async function saveBlastiLegalInfo(info: Partial<BlastiLegalInfo>): Promise<BlastiLegalInfo> {
  const data = await sendJson<{ legalInfo: BlastiLegalInfo }>('/api/billing/legal-info', 'PUT', info)
  return data.legalInfo
}

// ─── Shared assets for the on-device document ────────────────────────────────

/** BLASTI logo as a base64 data URL (embeddable in standalone HTML / PDFs). */
export async function fetchLogoDataUrl(): Promise<string> {
  try {
    // Raw fetch on purpose: the logo is a static binary asset — the apiClient
    // pipeline is JSON/mutation-oriented and mangles blob responses. The
    // endpoint is public and same-origin (served by the API behind the same
    // gateway as the app), so no failover is needed here.
    const res = await fetch('/api/branding/logo')
    if (!res.ok) throw new Error('logo http error')
    const blob = await res.blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    // Fallback: inline SVG wordmark — data URLs keep working inside the
    // isolated srcDoc/print iframe where relative paths do not resolve.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="60" viewBox="0 0 220 60"><text x="110" y="40" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="#0f766e" text-anchor="middle">BLASTI</text></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }
}
