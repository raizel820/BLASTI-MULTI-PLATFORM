/**
 * @blasti/api — Billing / Invoice service
 *
 * Legal invoice & receipt engine for BLASTI. One invoice RECORD is created
 * per settled payment (subscription / SMS pack / hardware) with:
 *  - a per-year monotonic sequence number rendered as `0003/2026`
 *    (@@unique([year, number]) → a number can never be reused),
 *  - point-in-time JSON snapshots of the issuer (BLASTI) legal identity,
 *    the recipient (agency/customer) legal identity and the full
 *    transaction detail (tier, price, period, starts/expires, payment
 *    method, Chargily reference),
 *  - a 256-bit random verification token embedded in the invoice QR code.
 *
 * The PDF itself is NEVER generated or stored server-side — clients render
 * it on-demand on the user's device (Electron printToPDF / browser print /
 * Capacitor share) from the invoice record returned by /api/billing.
 */

import { db } from '@blasti/db'
import { randomBytes } from 'crypto'
import { getConfigByCategory, setConfig } from './config-manager'
import { resolveAgencyIdForUser } from './sync-helpers'

// ─── Legal info (BLASTI issuer) — SystemSetting category ───────────────────

export const LEGAL_SETTINGS_CATEGORY = 'billing_legal'

export interface BlastiLegalInfo {
  name: string
  address: string
  /// NIF — رقم التعريف الجبائي
  nif: string
  /// NIS — رقم التعريف الإحصائي
  nis: string
  /// RIB / RIP — رقم الحساب البريدي أو الحساب البنكي
  rib: string
  /// RC number or auto-entrepreneur registration
  rc: string
  /// RC | AUTO_ENTREPRENEUR — which legal form the `rc` field holds
  rcType: string
  /// Customer service phone number(s) — CSV when multiple
  servicePhone: string
}

const DEFAULT_LEGAL: BlastiLegalInfo = {
  name: 'BLASTI',
  address: '',
  nif: '',
  nis: '',
  rib: '',
  rc: '',
  rcType: 'RC',
  servicePhone: '',
}

const LEGAL_KEYS: Record<keyof BlastiLegalInfo, string> = {
  name: 'blasti_legal_name',
  address: 'blasti_legal_address',
  nif: 'blasti_legal_nif',
  nis: 'blasti_legal_nis',
  rib: 'blasti_legal_rib',
  rc: 'blasti_legal_rc',
  rcType: 'blasti_legal_rc_type',
  servicePhone: 'blasti_legal_service_phone',
}

export async function getBlastiLegalInfo(): Promise<BlastiLegalInfo> {
  const values = await getConfigByCategory(LEGAL_SETTINGS_CATEGORY)
  const result = { ...DEFAULT_LEGAL }
  for (const k of Object.keys(LEGAL_KEYS) as (keyof BlastiLegalInfo)[]) {
    const raw = values[LEGAL_KEYS[k]]
    if (raw !== undefined && raw !== null && raw !== '') result[k] = raw
  }
  return result
}

export async function saveBlastiLegalInfo(info: Partial<BlastiLegalInfo>): Promise<BlastiLegalInfo> {
  for (const k of Object.keys(LEGAL_KEYS) as (keyof BlastiLegalInfo)[]) {
    const value = info[k]
    if (value === undefined) continue
    await setConfig(LEGAL_KEYS[k], String(value ?? ''), {
      category: LEGAL_SETTINGS_CATEGORY,
      description: `BLASTI legal info: ${k} (shown on invoices/receipts)`,
      valueType: 'string',
    })
  }
  return getBlastiLegalInfo()
}

// ─── Invoice number formatting ─────────────────────────────────────────────

/** Zero-pads the per-year sequence: (3, 2026) → "0003/2026". */
export function formatInvoiceNumber(year: number, number: number): string {
  return `${String(number).padStart(4, '0')}/${year}`
}

// ─── Verification token ────────────────────────────────────────────────────

function generateVerificationToken(): string {
  return randomBytes(24).toString('base64url') // 32 chars, URL-safe
}

/** Public web URL the QR code encodes → lands on the SPA verify view. */
export function buildInvoiceVerifyUrl(token: string): string {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'https://blastidz.online'
  const clean = base.replace(/\/+$/, '')
  return `${clean}/#/invoice/verify/${encodeURIComponent(token)}`
}

// ─── Snapshots ─────────────────────────────────────────────────────────────

interface AgencyLegalSnapshot {
  name: string
  address: string
  city: string
  wilaya: string
  phone: string
  email: string
  code: string
  nif: string
  nis: string
  rib: string
  rc: string
  servicePhone: string
  legalName: string
  legalAddress: string
}

interface CustomerLegalSnapshot {
  name: string
  phone: string
  email: string
  uid: string
}

function buildAgencySnapshot(agency: {
  name: string; address: string | null; city: string; wilaya: string
  phone: string | null; email: string | null; customCode: string
  legalNif: string | null; legalNis: string | null; legalRib: string | null
  legalRc: string | null; legalServicePhone: string | null
  legalName: string | null; legalAddress: string | null
}): AgencyLegalSnapshot {
  return {
    name: agency.name,
    address: agency.address || '',
    city: agency.city,
    wilaya: agency.wilaya,
    phone: agency.phone || '',
    email: agency.email || '',
    code: agency.customCode,
    nif: agency.legalNif || '',
    nis: agency.legalNis || '',
    rib: agency.legalRib || '',
    rc: agency.legalRc || '',
    servicePhone: agency.legalServicePhone || '',
    legalName: agency.legalName || '',
    legalAddress: agency.legalAddress || '',
  }
}

/** Parse the "(3m)" period suffix from a planName snapshot → 3 (default 1). */
function parsePeriodMonths(planName: string | null | undefined): number {
  const m = planName?.match(/\((\d+)m\)$/)
  return m ? parseInt(m[1], 10) : 1
}

// ─── Invoice creation (idempotent) ─────────────────────────────────────────

const SETTLED = ['APPROVED', 'COMPLETED']

/**
 * Ensure an invoice exists for a settled `Transaction` (SUBSCRIPTION type
 * only — hardware payments are fulfilment orders, not subscription billing
 * documents; they are skipped and return null). Idempotent: an existing
 * invoice for the same transaction is returned untouched.
 */
export async function ensureInvoiceForTransaction(
  transactionId: string,
  opts: { issuedBy?: string } = {},
): Promise<{ id: string; year: number; number: number } | null> {
  const existing = await db.invoice.findUnique({ where: { sourceId: transactionId } })
  if (existing) return { id: existing.id, year: existing.year, number: existing.number }

  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    include: {
      agency: {
        select: {
          id: true, name: true, customCode: true, address: true, city: true,
          wilaya: true, phone: true, email: true, ownerId: true,
          subscriptionStartsAt: true, subscriptionExpiresAt: true,
          legalNif: true, legalNis: true, legalRib: true, legalRc: true,
          legalServicePhone: true, legalName: true, legalAddress: true,
        },
      },
    },
  })
  if (!transaction) return null
  if (!SETTLED.includes(transaction.status)) return null
  if (transaction.type === 'HARDWARE') return null // invoiced with the order fulfilment, not here

  const agency = transaction.agency
  if (!agency) return null

  const issuer = await getBlastiLegalInfo()
  const amount = transaction.amountPaid ?? transaction.priceSnapshot ?? transaction.amount
  const currency = transaction.currencySnapshot || 'DZD'
  const periodMonths = parsePeriodMonths(transaction.planName)
  const planRecord = await db.subscriptionPlan.findFirst({ where: { name: transaction.plan } })
  const billingCycle = planRecord?.billingCycle || 'MONTHLY'

  const details = {
    kind: 'SUBSCRIPTION',
    tier: transaction.plan,
    tierDisplayName: planRecord?.displayNameAr || planRecord?.displayName || transaction.planName || transaction.plan,
    planNameSnapshot: transaction.planName || transaction.plan,
    periodMonths,
    billingCycle,
    periodStartsAt: agency.subscriptionStartsAt?.toISOString() || transaction.createdAt.toISOString(),
    periodExpiresAt: agency.subscriptionExpiresAt?.toISOString() || null,
    paymentMethod: transaction.paymentMethod,
    paymentProvider: transaction.paymentProvider,
    providerRef: transaction.providerRef || '',
    chargilyCheckoutId: transaction.providerRef || '',
    webhookVerified: transaction.webhookVerified,
    transactionId: transaction.id,
    paidAt: (transaction.reviewedAt || transaction.updatedAt || transaction.createdAt).toISOString(),
  }

  const token = generateVerificationToken()
  const year = new Date().getFullYear()

  // Per-year monotonic sequence — allocated inside the same interactive
  // transaction as the invoice row so concurrent settlements can never
  // receive the same (year, number).
  const created = await db.$transaction(async (tx) => {
    let next: number
    const counter = await tx.invoiceCounter.findUnique({ where: { year } })
    if (!counter) {
      await tx.invoiceCounter.create({ data: { year, lastNumber: 1 } })
      next = 1
    } else {
      const updated = await tx.invoiceCounter.update({
        where: { year },
        data: { lastNumber: { increment: 1 } },
      })
      next = updated.lastNumber
    }

    return tx.invoice.create({
      data: {
        number: next,
        year,
        sourceType: 'SUBSCRIPTION',
        sourceId: transaction.id,
        agencyId: agency.id,
        userId: agency.ownerId,
        recipientType: 'AGENCY',
        recipientName: agency.name,
        issuerSnapshot: JSON.stringify(issuer),
        recipientSnapshot: JSON.stringify(buildAgencySnapshot(agency)),
        detailsSnapshot: JSON.stringify(details),
        amount,
        currency,
        status: 'ISSUED',
        verificationToken: token,
        issuedBy: opts.issuedBy || 'AUTO',
      },
      select: { id: true, year: true, number: true },
    })
  })

  try {
    await db.auditLog.create({
      data: {
        action: 'INVOICE_ISSUED',
        entityType: 'INVOICE',
        entityId: created.id,
        details: JSON.stringify({
          displayNumber: formatInvoiceNumber(created.year, created.number),
          sourceType: 'SUBSCRIPTION',
          sourceId: transaction.id,
          agencyId: agency.id,
          amount,
        }),
      },
    })
  } catch (err) {
    console.warn('[billing] Failed to write INVOICE_ISSUED audit log:', err)
  }

  return created
}

/**
 * Ensure an invoice exists for an approved `SmsPurchase` (customer or user
 * SMS credit pack). Idempotent.
 */
export async function ensureInvoiceForSmsPurchase(
  purchaseId: string,
  opts: { issuedBy?: string } = {},
): Promise<{ id: string; year: number; number: number } | null> {
  const existing = await db.invoice.findUnique({ where: { sourceId: purchaseId } })
  if (existing) return { id: existing.id, year: existing.year, number: existing.number }

  const purchase = await db.smsPurchase.findUnique({
    where: { id: purchaseId },
    include: { user: { select: { id: true, fullName: true, phoneNumber: true, email: true, uid: true } } },
  })
  if (!purchase) return null
  if (purchase.status !== 'APPROVED') return null

  const user = purchase.user
  const issuer = await getBlastiLegalInfo()
  const userAgencyId = await resolveAgencyIdForUser(purchase.userId).catch(() => null)

  const details = {
    kind: 'SMS',
    quantity: purchase.quantity,
    unitPrice: purchase.quantity > 0 ? Math.round(purchase.price / purchase.quantity) : purchase.price,
    price: purchase.price,
    paymentMethod: purchase.paymentMethod || 'CHARGILY',
    paymentProvider: purchase.paymentProvider,
    providerRef: purchase.providerRef || '',
    chargilyCheckoutId: purchase.providerRef || '',
    webhookVerified: purchase.webhookVerified,
    smsPurchaseId: purchase.id,
    paidAt: (purchase.updatedAt || purchase.createdAt).toISOString(),
  }

  const token = generateVerificationToken()
  const year = new Date().getFullYear()

  const created = await db.$transaction(async (tx) => {
    let next: number
    const counter = await tx.invoiceCounter.findUnique({ where: { year } })
    if (!counter) {
      await tx.invoiceCounter.create({ data: { year, lastNumber: 1 } })
      next = 1
    } else {
      const updated = await tx.invoiceCounter.update({
        where: { year },
        data: { lastNumber: { increment: 1 } },
      })
      next = updated.lastNumber
    }

    return tx.invoice.create({
      data: {
        number: next,
        year,
        sourceType: 'SMS',
        sourceId: purchase.id,
        agencyId: userAgencyId || null,
        userId: purchase.userId,
        recipientType: 'CUSTOMER',
        recipientName: user.fullName,
        issuerSnapshot: JSON.stringify(issuer),
        recipientSnapshot: JSON.stringify({
          name: user.fullName,
          phone: user.phoneNumber || '',
          email: user.email || '',
          uid: user.uid || '',
        } satisfies CustomerLegalSnapshot),
        detailsSnapshot: JSON.stringify(details),
        amount: purchase.price,
        currency: 'DZD',
        status: 'ISSUED',
        verificationToken: token,
        issuedBy: opts.issuedBy || 'AUTO',
      },
      select: { id: true, year: true, number: true },
    })
  })

  try {
    await db.auditLog.create({
      data: {
        action: 'INVOICE_ISSUED',
        entityType: 'INVOICE',
        entityId: created.id,
        details: JSON.stringify({
          displayNumber: formatInvoiceNumber(created.year, created.number),
          sourceType: 'SMS',
          sourceId: purchase.id,
          userId: purchase.userId,
          amount: purchase.price,
        }),
      },
    })
  } catch (err) {
    console.warn('[billing] Failed to write INVOICE_ISSUED audit log:', err)
  }

  return created
}

// ─── Verification ──────────────────────────────────────────────────────────

export interface InvoiceVerificationResult {
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

/** Public verify-url summary — never leaks legal RIBs or full details. */
function toPublicSummary(inv: {
  year: number; number: number; sourceType: string; status: string
  amount: number; currency: string; recipientName: string; recipientType: string
  issuerSnapshot: string; issuedAt: Date; verificationCount: number
  lastVerifiedAt: Date | null
}) {
  let issuerName = 'BLASTI'
  try {
    const parsed = JSON.parse(inv.issuerSnapshot) as { name?: string }
    if (parsed?.name) issuerName = parsed.name
  } catch { /* keep default */ }
  return {
    displayNumber: formatInvoiceNumber(inv.year, inv.number),
    year: inv.year,
    number: inv.number,
    sourceType: inv.sourceType,
    status: inv.status,
    amount: inv.amount,
    currency: inv.currency,
    recipientName: inv.recipientName,
    recipientType: inv.recipientType,
    issuerName,
    issuedAt: inv.issuedAt.toISOString(),
    verificationCount: inv.verificationCount,
    lastVerifiedAt: inv.lastVerifiedAt ? inv.lastVerifiedAt.toISOString() : null,
  }
}

/**
 * Verify an invoice by its QR token: returns the public summary and marks
 * the invoice "checked" (counter + lastCheckedAt + audit row). Safe to call
 * anonymously (role PUBLIC) or with a session (records the verifier role).
 */
export async function verifyInvoiceByToken(
  token: string,
  verifier: { role?: string; id?: string; ip?: string } = {},
): Promise<InvoiceVerificationResult> {
  const invoice = await db.invoice.findUnique({ where: { verificationToken: token } })
  if (!invoice) return { valid: false, reason: 'NOT_FOUND' }

  if (invoice.status === 'CANCELLED') {
    return { valid: false, reason: 'CANCELLED', invoice: toPublicSummary(invoice) }
  }

  const now = new Date()
  await db.$transaction([
    db.invoice.update({
      where: { id: invoice.id },
      data: { verificationCount: { increment: 1 }, lastVerifiedAt: now },
    }),
    db.invoiceVerification.create({
      data: {
        invoiceId: invoice.id,
        verifierRole: verifier.role || 'PUBLIC',
        verifierId: verifier.id || null,
        ip: verifier.ip || null,
      },
    }),
  ])

  return { valid: true, invoice: toPublicSummary({ ...invoice, verificationCount: invoice.verificationCount + 1, lastVerifiedAt: now }) }
}
