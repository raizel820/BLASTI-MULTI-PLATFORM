'use client';

/**
 * LegalConsentBlock — MANDATORY two-document consent block (Task 5-a).
 *
 * Rendered on EVERY account/agency creation surface (register forms, the
 * staff-create dialog, the create-agency wizard). The user must tick BOTH
 * the role-appropriate User Agreement AND the Privacy Policy before the
 * parent can submit — the cloud API rejects /api/auth/register,
 * /api/agency/staff/create and /api/agencies bodies without
 * `agreeTerms: true`, so the parent lifts the AND of the two internal
 * checkboxes through onCheckedChange.
 *
 * The exact document text is viewable BEFORE consent: each row carries a
 * "View document" link that opens a versioned, scrollable document viewer
 * (localized ACTIVE documents from GET /api/legal-documents).
 *
 * Fetching goes through apiFetch (never throws, fetch-like shape). Successful
 * responses are cached in a module-level Map keyed by `${lang}` — documents
 * stay stable between renders and across mounts; failures are not cached so
 * a retry refetches. Checkboxes stay usable on load failure (the server will
 * still block un-agreed submissions).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

export type LegalConsentRole = 'CUSTOMER' | 'AGENCY_OWNER' | 'STAFF';

interface LegalConsentBlockProps {
  role: LegalConsentRole;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  className?: string;
}

interface LegalDocument {
  docType: string;
  version: number;
  title: string;
  content: string;
  effectiveDate: string;
  updatedAt: string;
}

/** role → agreement docType; PRIVACY_POLICY is always paired. */
const ROLE_TO_AGREEMENT_DOC: Record<LegalConsentRole, string> = {
  CUSTOMER: 'AGREEMENT_CUSTOMER',
  AGENCY_OWNER: 'AGREEMENT_AGENCY_OWNER',
  STAFF: 'AGREEMENT_STAFF',
};

// Module-level cache keyed by `${lang}` (per docType) — success responses
// only. Failed fetches are never cached, so the retry path refetches.
const legalDocsCache = new Map<string, Map<string, LegalDocument>>();

/** Locale-aware date formatting with a raw-string fallback (ar/fr/en). */
function formatLegalDate(value: string | undefined, lang: string): string {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-GB',
      { dateStyle: 'medium' },
    );
  } catch {
    return value;
  }
}

export function LegalConsentBlock({ role, checked, onCheckedChange, className }: LegalConsentBlockProps) {
  const { t, lang } = useLanguage();
  const agreementType = ROLE_TO_AGREEMENT_DOC[role];

  const [agreementDoc, setAgreementDoc] = useState<LegalDocument | null>(null);
  const [privacyDoc, setPrivacyDoc] = useState<LegalDocument | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  // The two internal consent booleans; the parent receives their AND.
  const [agreeDoc, setAgreeDoc] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);

  // Document viewer dialog (null = closed).
  const [viewerDoc, setViewerDoc] = useState<LegalDocument | null>(null);

  const loadDocs = useCallback(async () => {
    setLoadState('loading');
    // 1) cache hit (same lang, both docTypes present) — no network round-trip.
    const cached = legalDocsCache.get(lang);
    const cachedAgreement = cached?.get(agreementType);
    const cachedPrivacy = cached?.get('PRIVACY_POLICY');
    if (cachedAgreement && cachedPrivacy) {
      setAgreementDoc(cachedAgreement);
      setPrivacyDoc(cachedPrivacy);
      setLoadState('ready');
      return;
    }
    // 2) network fetch — apiFetch never throws, so treat !ok as failure.
    try {
      const res = await apiFetch(
        '/api/legal-documents?lang=' + lang + '&types=' + encodeURIComponent(agreementType + ',PRIVACY_POLICY'),
      );
      if (!res.ok) throw new Error('legal-documents ' + res.status);
      const data = await res.json();
      const list: LegalDocument[] = Array.isArray(data?.documents) ? data.documents : [];
      const agreement = list.find((d) => d.docType === agreementType) ?? null;
      const privacy = list.find((d) => d.docType === 'PRIVACY_POLICY') ?? null;
      if (!agreement || !privacy) throw new Error('legal-documents incomplete');
      // Cache the success response so re-renders/mounts stay stable.
      let store = legalDocsCache.get(lang);
      if (!store) {
        store = new Map<string, LegalDocument>();
        legalDocsCache.set(lang, store);
      }
      store.set(agreementType, agreement);
      store.set('PRIVACY_POLICY', privacy);
      setAgreementDoc(agreement);
      setPrivacyDoc(privacy);
      setLoadState('ready');
    } catch {
      // Not cached — the destructive retry row below lets the user refetch.
      setLoadState('error');
    }
  }, [agreementType, lang]);

  // Load on mount and whenever the language changes (locale switch → refetch).
  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  // Propagate the AND of both checkboxes to the parent.
  useEffect(() => {
    onCheckedChange(agreeDoc && agreePrivacy);
  }, [agreeDoc, agreePrivacy, onCheckedChange]);

  // Parent reset sync — react to the checked PROP transitioning to false
  // (form reset, dialog closed), NOT to internal checkbox changes: without
  // the prev-prop guard, ticking the first box would instantly revert while
  // the parent `checked` is still false.
  const prevCheckedRef = useRef(checked);
  useEffect(() => {
    if (prevCheckedRef.current === checked) return;
    prevCheckedRef.current = checked;
    if (!checked && (agreeDoc || agreePrivacy)) {
      setAgreeDoc(false);
      setAgreePrivacy(false);
    }
  }, [checked, agreeDoc, agreePrivacy]);

  const openDoc = (doc: LegalDocument | null) => {
    if (doc) setViewerDoc(doc);
  };

  const viewerArabic = viewerDoc ? /[\u0600-\u06FF]/.test(viewerDoc.content) : false;
  const viewerDate = formatLegalDate(viewerDoc?.effectiveDate, lang);

  const viewDocButton = (doc: LegalDocument | null) => (
    <button
      type="button"
      onClick={() => openDoc(doc)}
      disabled={!doc}
      className="shrink-0 text-xs font-medium text-emerald-600 underline underline-offset-2 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 disabled:pointer-events-none disabled:opacity-50"
    >
      {t('legalConsentViewDoc')}
    </button>
  );

  return (
    <div className={cn('space-y-3', className)}>
      {loadState === 'loading' ? (
        // Loading — two muted skeleton bars (one per document row).
        <div className="space-y-2 py-1" aria-hidden="true">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* Row 1 — role-appropriate User Agreement */}
          <div className="flex items-start gap-3">
            <Checkbox
              id={`legal-agreement-${role}`}
              checked={agreeDoc}
              onCheckedChange={(v) => setAgreeDoc(v === true)}
              className="mt-0.5"
            />
            <label
              htmlFor={`legal-agreement-${role}`}
              className="flex-1 min-w-0 text-sm leading-relaxed cursor-pointer select-none"
            >
              {t('agreeTerms')} {t('legalUserAgreement')}
            </label>
            {viewDocButton(agreementDoc)}
          </div>
          {/* Row 2 — Privacy Policy (always paired with the agreement) */}
          <div className="flex items-start gap-3">
            <Checkbox
              id={`legal-privacy-${role}`}
              checked={agreePrivacy}
              onCheckedChange={(v) => setAgreePrivacy(v === true)}
              className="mt-0.5"
            />
            <label
              htmlFor={`legal-privacy-${role}`}
              className="flex-1 min-w-0 text-sm leading-relaxed cursor-pointer select-none"
            >
              {t('agreeTerms')} {t('privacyPolicy')}
            </label>
            {viewDocButton(privacyDoc)}
          </div>
        </div>
      )}

      {/* Load failure — compact destructive row with retry; checkboxes above
          remain usable (the server still blocks un-agreed submissions). */}
      {loadState === 'error' && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30 px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
          <p className="flex-1 min-w-0 text-xs text-red-600 dark:text-red-400">{t('legalConsentLoadError')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs shrink-0"
            onClick={() => loadDocs()}
          >
            {t('legalConsentRetry')}
          </Button>
        </div>
      )}

      {/* Always-visible muted hint — BOTH documents must be accepted. */}
      <p className="text-xs text-muted-foreground">{t('legalConsentRequiredBoth')}</p>

      {/* Document viewer — the exact text being agreed to, versioned. */}
      <Dialog open={!!viewerDoc} onOpenChange={(open) => { if (!open) setViewerDoc(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pe-6">
              <FileText className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="flex-1 min-w-0 break-words">{viewerDoc?.title}</span>
              <Badge variant="secondary" className="shrink-0">v{viewerDoc?.version}</Badge>
            </DialogTitle>
            <DialogDescription>
              {t('legalConsentVersion')} {viewerDoc?.version} · {t('legalConsentEffective')} {viewerDate}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] rounded-md border">
            <div
              className="whitespace-pre-wrap text-sm leading-relaxed p-4"
              dir={viewerArabic ? 'rtl' : 'ltr'}
            >
              {viewerDoc?.content}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setViewerDoc(null)}>
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
