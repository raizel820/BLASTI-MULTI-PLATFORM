// ─── Legal & Agreements — server-side helpers ───────────────────────────────
// Default-document seeding, active-version lookup and the proof-of-consent
// ledger (Law 18-07 requires consent to be demonstrable). All consent writes
// are best-effort: a ledger failure must never block an account creation.

import { db } from '@blasti/db'
import { legalDocumentDefaults } from './legal'

export type LegalConsentContext = 'registration' | 'staff_create' | 'agency_create'

/**
 * Seed the four default legal documents on first boot (empty table). Each
 * starts as version 1 / active, so a fresh deployment immediately has all
 * consent surfaces available. Safe to call concurrently: guarded by a count
 * check and a per-docType conflict re-check.
 *
 * 0.6.120 — audited-default refresh: when the table is NOT empty, rows still
 * carrying the system seed signature (createdBy 'system-default' AND version 1
 * — i.e. never republished or edited by an admin) are refreshed in place to
 * the current audited master text, so existing deployments receive the
 * corrected legal citations without touching admin-published documents.
 */
export async function ensureDefaultLegalDocuments(): Promise<void> {
  try {
    const count = await db.legalDocument.count()
    if (count > 0) {
      for (const doc of legalDocumentDefaults) {
        const active = await db.legalDocument.findFirst({
          where: { docType: doc.docType, isActive: true },
          orderBy: { version: 'desc' },
        })
        if (!active) continue
        if (active.createdBy !== 'system-default' || active.version !== 1) continue
        if (
          active.content === doc.content &&
          active.contentFr === doc.contentFr &&
          active.contentAr === doc.contentAr
        ) continue
        await db.legalDocument.update({
          where: { id: active.id },
          data: {
            title: doc.title,
            titleFr: doc.titleFr,
            titleAr: doc.titleAr,
            content: doc.content,
            contentFr: doc.contentFr,
            contentAr: doc.contentAr,
            updatedBy: 'system-default',
          },
        })
      }
      return
    }
    for (const doc of legalDocumentDefaults) {
      const exists = await db.legalDocument.findFirst({ where: { docType: doc.docType }, select: { id: true } })
      if (exists) continue
      await db.legalDocument.create({
        data: {
          docType: doc.docType,
          version: 1,
          title: doc.title,
          titleFr: doc.titleFr,
          titleAr: doc.titleAr,
          content: doc.content,
          contentFr: doc.contentFr,
          contentAr: doc.contentAr,
          isActive: true,
          effectiveDate: new Date(),
          createdBy: 'system-default',
          updatedBy: 'system-default',
        },
      })
    }
  } catch (error) {
    console.error('[legal] default seeding failed:', error instanceof Error ? error.message : error)
  }
}

/** The single ACTIVE version of a document type (null when none published). */
export async function getActiveLegalDocument(docType: string) {
  return db.legalDocument.findFirst({
    where: { docType, isActive: true },
    orderBy: { version: 'desc' },
  })
}

/**
 * The agreement document types a given role must consent to, in display
 * order. SUPER_ADMIN registrations (admin console) accept the owner
 * agreement — there is no separate platform-admin agreement.
 */
export function getConsentDocTypesForRole(role: string | null | undefined): string[] {
  switch (role) {
    case 'AGENCY_STAFF':
      return ['AGREEMENT_STAFF', 'PRIVACY_POLICY']
    case 'AGENCY_OWNER':
    case 'SUPER_ADMIN':
      return ['AGREEMENT_AGENCY_OWNER', 'PRIVACY_POLICY']
    case 'CUSTOMER':
    default:
      return ['AGREEMENT_CUSTOMER', 'PRIVACY_POLICY']
  }
}

/**
 * Record proof-of-consent rows for a user (one per document version).
 * Best-effort and never throws: the boolean consent gate on the request body
 * is the enforceable check; this ledger is the durable evidence trail.
 */
export async function recordUserConsents(
  userId: string,
  role: string | null | undefined,
  opts: { context: LegalConsentContext; requestIp?: string | null; userAgent?: string | null },
): Promise<void> {
  try {
    const docTypes = getConsentDocTypesForRole(role)
    for (const docType of docTypes) {
      const doc = await getActiveLegalDocument(docType)
      if (!doc) continue
      await db.consentRecord.create({
        data: {
          userId,
          docType,
          docVersion: doc.version,
          context: opts.context,
          requestIp: opts.requestIp || null,
          userAgent: (opts.userAgent || '').slice(0, 300) || null,
        },
      })
    }
  } catch (error) {
    console.error('[legal] consent ledger write failed (non-blocking):', error instanceof Error ? error.message : error)
  }
}
