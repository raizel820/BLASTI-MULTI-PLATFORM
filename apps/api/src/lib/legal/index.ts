// ─── Legal & Agreements — default document set (merged) ─────────────────────
// Merges the master English texts with the Arabic/French translations and
// exposes one flat list consumed by ensureDefaultLegalDocuments() on first
// boot. Arabic/French live in sibling files so they can be maintained
// independently of the English masters.

import { customerAgreementDefault, type LegalDocDefault } from './defaults-customer-agreement'
import { agencyOwnerAgreementDefault } from './defaults-agency-owner-agreement'
import { staffAgreementDefault } from './defaults-staff-agreement'
import { privacyPolicyDefault } from './defaults-privacy-policy'
import { legalDefaultsAr } from './ar-defaults'
import { legalDefaultsFr } from './fr-defaults'

export type { LegalDocDefault }

const rawDefaults: LegalDocDefault[] = [
  customerAgreementDefault,
  agencyOwnerAgreementDefault,
  staffAgreementDefault,
  privacyPolicyDefault,
]

const TRANSLATION_KEYS = ['AGREEMENT_CUSTOMER', 'AGREEMENT_AGENCY_OWNER', 'AGREEMENT_STAFF', 'PRIVACY_POLICY'] as const

/** Canonical doc types + the display order used by the admin console. */
export const LEGAL_DOC_TYPES = TRANSLATION_KEYS as unknown as string[]

export const LEGAL_DOC_TYPE_LABELS: Record<string, string> = {
  AGREEMENT_AGENCY_OWNER: 'User Agreement — Agency Owner',
  AGREEMENT_STAFF: 'User Agreement — Staff',
  AGREEMENT_CUSTOMER: 'User Agreement — Customer',
  PRIVACY_POLICY: 'Privacy Policy',
}

/**
 * The four default legal documents with every language variant merged in.
 * Titles fall back to the English master when a translation is missing so a
 * partial translation file can never produce a title-less document.
 */
export const legalDocumentDefaults: Array<LegalDocDefault & { titleAr: string; titleFr: string; contentAr: string; contentFr: string }> =
  rawDefaults.map((doc) => {
    const ar = legalDefaultsAr[doc.docType]
    const fr = legalDefaultsFr[doc.docType]
    return {
      ...doc,
      titleAr: ar?.title || doc.title,
      titleFr: fr?.title || doc.title,
      contentAr: ar?.content || doc.content,
      contentFr: fr?.content || doc.content,
    }
  })
