'use client';

// Legal & Agreements — SUPER_ADMIN console (0.6.120).
// Read / edit-publish / download / roll back every trilingual legal document
// (agency-owner, staff and customer agreements + privacy policy) and inspect
// the proof-of-consent ledger. Talks to the cloud legal-documents API routes
// through apiFetch (3-layer failover + session auth handled server-side).

import { apiFetch } from '@/lib/api-fetch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  BookOpen,
  ChevronDown,
  Download,
  Eye,
  FileText,
  History,
  Loader2,
  Pencil,
  Scale,
} from 'lucide-react';

interface LegalDocument {
  id: string;
  docType: string;
  version: number;
  title: string;
  titleFr?: string | null;
  titleAr?: string | null;
  content: string;
  contentFr?: string | null;
  contentAr?: string | null;
  isActive: boolean;
  effectiveDate: string;
  createdBy: string;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConsentRecord {
  id: string;
  userId: string;
  username?: string | null;
  fullName?: string | null;
  role?: string | null;
  docType: string;
  docVersion: number;
  context: string;
  requestIp?: string | null;
  consentedAt: string;
}

type ReadTab = 'EN' | 'FR' | 'AR';
type DownloadFmt = 'txt' | 'md';

const DOC_TYPE_ORDER: string[] = [
  'AGREEMENT_AGENCY_OWNER',
  'AGREEMENT_STAFF',
  'AGREEMENT_CUSTOMER',
  'PRIVACY_POLICY',
];

// Local escapeHtml for the print/PDF window (never inject raw doc text).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function docTypeSlug(docType: string): string {
  return docType.toLowerCase().replace(/_/g, '-');
}

export function AdminLegalManager() {
  const { t, lang } = useLanguage();

  // ── documents state ──
  const [documents, setDocuments] = useState<LegalDocument[] | null>(null);
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [consentsRecorded, setConsentsRecorded] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  // ── tabs ──
  const [tab, setTab] = useState<'docs' | 'ledger'>('docs');

  // ── read dialog ──
  const [readDoc, setReadDoc] = useState<LegalDocument | null>(null);
  const [readTab, setReadTab] = useState<ReadTab>('EN');

  // ── edit & publish dialog ──
  const [editOpen, setEditOpen] = useState(false);
  const [editDocType, setEditDocType] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editTitleFr, setEditTitleFr] = useState('');
  const [editTitleAr, setEditTitleAr] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editContentFr, setEditContentFr] = useState('');
  const [editContentAr, setEditContentAr] = useState('');
  const [editPreview, setEditPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // ── version history + rollback ──
  const [openVersions, setOpenVersions] = useState<Record<string, boolean>>({});
  const [rollbackTarget, setRollbackTarget] = useState<LegalDocument | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);

  // ── consent ledger state ──
  const [consents, setConsents] = useState<ConsentRecord[] | null>(null);
  const [consentsTotal, setConsentsTotal] = useState(0);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);

  // ── data loading ──
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/legal-documents/admin');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setDocuments(Array.isArray(data?.documents) ? data.documents : []);
      setDocTypes(Array.isArray(data?.docTypes) ? data.docTypes : []);
      setConsentsRecorded(typeof data?.consentsRecorded === 'number' ? data.consentsRecorded : 0);
    } catch {
      toast.error(t('adminLegalLoadFail'));
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const ensureConsents = useCallback(async () => {
    if (ledgerLoaded || ledgerLoading) return;
    setLedgerLoading(true);
    try {
      const res = await apiFetch('/api/legal-documents/admin/consents?limit=50');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const rows: ConsentRecord[] = Array.isArray(data?.consents) ? data.consents : [];
      setConsents(rows);
      setConsentsTotal(typeof data?.total === 'number' ? data.total : rows.length);
      setLedgerLoaded(true);
    } catch {
      toast.error(t('adminLegalLoadFail'));
    } finally {
      setLedgerLoading(false);
    }
  }, [ledgerLoaded, ledgerLoading, t]);

  const handleTabChange = (value: string) => {
    const next = value === 'ledger' ? 'ledger' : 'docs';
    setTab(next);
    if (next === 'ledger') void ensureConsents();
  };

  // ── localization helpers ──
  const localeTag = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-GB';

  const formatDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString(localeTag, { dateStyle: 'medium' });
    } catch {
      return iso;
    }
  };

  const formatDateTime = (iso: string): string => {
    try {
      return new Date(iso).toLocaleString(localeTag, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return iso;
    }
  };

  const docTypeLabel = (docType: string): string => {
    switch (docType) {
      case 'AGREEMENT_AGENCY_OWNER':
        return t('adminLegalDocOwner');
      case 'AGREEMENT_STAFF':
        return t('adminLegalDocStaff');
      case 'AGREEMENT_CUSTOMER':
        return t('adminLegalDocCustomer');
      case 'PRIVACY_POLICY':
        return t('adminLegalDocPrivacy');
      default:
        return docType;
    }
  };

  const contextLabel = (ctx: string): string => {
    switch (ctx) {
      case 'registration':
        return t('adminLegalCtxRegistration');
      case 'staff_create':
        return t('adminLegalCtxStaffCreate');
      case 'agency_create':
        return t('adminLegalCtxAgencyCreate');
      default:
        return ctx;
    }
  };

  const localizedTitle = (doc: LegalDocument): string => {
    if (lang === 'ar') return doc.titleAr || doc.title;
    if (lang === 'fr') return doc.titleFr || doc.title;
    return doc.title;
  };

  const localizedContent = (doc: LegalDocument): string => {
    if (lang === 'ar' && doc.contentAr && doc.contentAr.trim()) return doc.contentAr;
    if (lang === 'fr' && doc.contentFr && doc.contentFr.trim()) return doc.contentFr;
    return doc.content;
  };

  const createdByLabel = (doc: LegalDocument): string =>
    doc.createdBy === 'system-default' ? t('adminLegalSystem') : doc.createdBy;

  // ── grouping: 4 docType groups, versions newest-first (API order) ──
  const groups = useMemo<Array<[string, LegalDocument[]]>>(() => {
    const byType = new Map<string, LegalDocument[]>();
    for (const d of documents ?? []) {
      const list = byType.get(d.docType);
      if (list) list.push(d);
      else byType.set(d.docType, [d]);
    }
    const ordered: Array<[string, LegalDocument[]]> = [];
    const seen = new Set<string>();
    const order = docTypes.length ? docTypes : DOC_TYPE_ORDER;
    for (const dt of order) {
      const list = byType.get(dt);
      if (list) {
        ordered.push([dt, list]);
        seen.add(dt);
      }
    }
    for (const [dt, list] of byType) {
      if (!seen.has(dt)) ordered.push([dt, list]);
    }
    return ordered;
  }, [documents, docTypes]);

  // ── read dialog ──
  const openRead = (doc: LegalDocument) => {
    setReadDoc(doc);
    setReadTab(lang === 'ar' ? 'AR' : lang === 'fr' ? 'FR' : 'EN');
  };

  const readContentFor = (rt: ReadTab): { content: string; missing: boolean } => {
    if (!readDoc) return { content: '', missing: false };
    if (rt === 'FR') {
      const fr = readDoc.contentFr?.trim();
      return fr ? { content: fr, missing: false } : { content: readDoc.content, missing: true };
    }
    if (rt === 'AR') {
      const ar = readDoc.contentAr?.trim();
      return ar ? { content: ar, missing: false } : { content: readDoc.content, missing: true };
    }
    return { content: readDoc.content, missing: false };
  };

  // ── edit & publish ──
  const openEdit = (docType: string) => {
    const versions = groups.find(([dt]) => dt === docType)?.[1] ?? [];
    const active = versions.find((d) => d.isActive) ?? versions[0];
    setEditDocType(docType);
    setEditTitle(active?.title ?? '');
    setEditTitleFr(active?.titleFr ?? '');
    setEditTitleAr(active?.titleAr ?? '');
    setEditContent(active?.content ?? '');
    setEditContentFr(active?.contentFr ?? '');
    setEditContentAr(active?.contentAr ?? '');
    setEditPreview(false);
    setEditOpen(true);
  };

  const publish = async () => {
    if (!editDocType) return;
    if (!editTitle.trim() || !editContent.trim()) {
      toast.error(t('adminLegalCannotEmpty'));
      return;
    }
    setPublishing(true);
    try {
      const res = await apiFetch('/api/legal-documents/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docType: editDocType,
          title: editTitle,
          titleFr: editTitleFr,
          titleAr: editTitleAr,
          content: editContent,
          contentFr: editContentFr,
          contentAr: editContentAr,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!data?.success) throw new Error('publish-failed');
      toast.success(t('adminLegalPublishDone'));
      setEditOpen(false);
      await loadDocuments();
    } catch {
      toast.error(t('adminLegalPublishFail'));
    } finally {
      setPublishing(false);
    }
  };

  // ── downloads (client-side blob / print window) ──
  const downloadDoc = (doc: LegalDocument, fmt: DownloadFmt) => {
    if (typeof window === 'undefined') return;
    const body = fmt === 'txt' ? `${doc.title}\n\n${doc.content}` : `# ${doc.title}\n\n${doc.content}`;
    const blob = new Blob([body], {
      type: fmt === 'txt' ? 'text/plain;charset=utf-8' : 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blasti-${docTypeSlug(doc.docType)}-v${doc.version}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const printDoc = (doc: LegalDocument) => {
    const w = window.open('', '_blank');
    if (!w) {
      toast.error(t('error'));
      return;
    }
    const isAr = lang === 'ar';
    const title = localizedTitle(doc);
    const content = localizedContent(doc);
    w.document.write(
      `<html dir="${isAr ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
        `<body style="font-family:sans-serif;padding:24px"><h1>${escapeHtml(title)}</h1>` +
        `<pre style="white-space:pre-wrap;line-height:1.5">${escapeHtml(content)}</pre></body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  // ── rollback ──
  const confirmRollback = async () => {
    if (!rollbackTarget) return;
    const target = rollbackTarget;
    setRollbackBusy(true);
    try {
      const res = await apiFetch('/api/legal-documents/admin/activate', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: target.id }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (!data?.success) throw new Error('activate-failed');
      toast.success(t('adminLegalRollbackDone', { v: String(target.version) }));
      setRollbackTarget(null);
      await loadDocuments();
    } catch {
      toast.error(t('adminLegalRollbackFail'));
    } finally {
      setRollbackBusy(false);
    }
  };

  const renderVersionRow = (v: LegalDocument) => (
    <div key={v.id} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">v{v.version}</Badge>
        {v.isActive && (
          <Badge className="bg-emerald-600 text-white">{t('adminLegalActiveVersion')}</Badge>
        )}
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <p>
          {t('adminLegalUpdated')}: {formatDate(v.updatedAt)} · {t('adminLegalEffective')}:{' '}
          {formatDate(v.effectiveDate)}
        </p>
        <p>
          {t('adminLegalCreatedBy')}: {createdByLabel(v)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => openRead(v)}>
          <BookOpen className="me-1.5 h-4 w-4" />
          {t('adminLegalRead')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={v.isActive || rollbackBusy}
          onClick={() => setRollbackTarget(v)}
        >
          <History className="me-1.5 h-4 w-4" />
          {t('adminLegalRollback')}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6 p-4 lg:p-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold">{t('adminLegalTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('adminLegalSubtitle')}</p>
        </div>
        <Badge variant="secondary" className="w-fit shrink-0">
          <Scale className="me-1.5 h-3.5 w-3.5" />
          {t('adminLegalConsentsTotal')}: {consentsRecorded ?? '—'}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          <TabsTrigger value="docs">{t('adminLegalTabDocs')}</TabsTrigger>
          <TabsTrigger value="ledger">{t('adminLegalTabLedger')}</TabsTrigger>
        </TabsList>

        {/* ── DOCUMENTS TAB ── */}
        <TabsContent value="docs" className="mt-4">
          {loading && !documents ? (
            <div className="grid gap-4 md:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse space-y-3 rounded-lg border p-6">
                  <div className="h-5 w-2/3 rounded bg-muted" />
                  <div className="h-4 w-1/2 rounded bg-muted" />
                  <div className="h-3 w-1/3 rounded bg-muted" />
                  <div className="h-3 w-1/4 rounded bg-muted" />
                  <div className="h-9 w-full rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {groups.map(([docType, versions]) => {
                const activeDoc = versions.find((d) => d.isActive) ?? versions[0];
                const versionsOpen = !!openVersions[docType];
                return (
                  <Card key={docType} className="flex flex-col">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base leading-snug">
                          {docTypeLabel(docType)}
                        </CardTitle>
                        {activeDoc &&
                          (activeDoc.isActive ? (
                            <Badge
                              variant="outline"
                              className="shrink-0 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"
                            >
                              v{activeDoc.version}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="shrink-0">
                              v{activeDoc.version}
                            </Badge>
                          ))}
                      </div>
                      {activeDoc && (
                        <p className="text-sm text-muted-foreground">{localizedTitle(activeDoc)}</p>
                      )}
                    </CardHeader>
                    <CardContent className="space-y-3 pt-0">
                      {activeDoc && (
                        <Collapsible
                          open={versionsOpen}
                          onOpenChange={(o) =>
                            setOpenVersions((prev) => ({ ...prev, [docType]: o }))
                          }
                        >
                          <div className="space-y-1 text-xs text-muted-foreground">
                            <p>
                              {t('adminLegalUpdated')}: {formatDate(activeDoc.updatedAt)}
                            </p>
                            <p>
                              {t('adminLegalEffective')}: {formatDate(activeDoc.effectiveDate)}
                            </p>
                            <p>
                              {t('adminLegalCreatedBy')}: {createdByLabel(activeDoc)}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button size="sm" variant="outline" onClick={() => openRead(activeDoc)}>
                              <BookOpen className="me-1.5 h-4 w-4" />
                              {t('adminLegalRead')}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => openEdit(docType)}>
                              <Pencil className="me-1.5 h-4 w-4" />
                              {t('adminLegalEdit')}
                            </Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline">
                                  <Download className="me-1.5 h-4 w-4" />
                                  {t('adminLegalDownload')}
                                  <ChevronDown className="ms-1 h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => downloadDoc(activeDoc, 'txt')}>
                                  <FileText className="me-2 h-4 w-4" />
                                  {t('adminLegalDownloadTxt')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => downloadDoc(activeDoc, 'md')}>
                                  <FileText className="me-2 h-4 w-4" />
                                  {t('adminLegalDownloadMd')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => printDoc(activeDoc)}>
                                  <BookOpen className="me-2 h-4 w-4" />
                                  {t('adminLegalDownloadPdf')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            <CollapsibleTrigger asChild>
                              <Button size="sm" variant="ghost">
                                <History className="me-1.5 h-4 w-4" />
                                {t('adminLegalVersions')}
                                <ChevronDown
                                  className={cn(
                                    'ms-1 h-4 w-4 transition-transform',
                                    versionsOpen && 'rotate-180',
                                  )}
                                />
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                          <CollapsibleContent>
                            <div className="max-h-80 space-y-2 overflow-y-auto border-t pt-3">
                              {versions.map(renderVersionRow)}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── CONSENT LEDGER TAB ── */}
        <TabsContent value="ledger" className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('adminLegalLedgerShowing', {
              n: String(consents?.length ?? 0),
              total: String(consentsTotal),
            })}
          </p>
          {ledgerLoading && !consents ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          ) : !consents || consents.length === 0 ? (
            <div className="rounded-md border p-8 text-center text-sm text-muted-foreground">
              {t('adminLegalLedgerEmpty')}
            </div>
          ) : (
            <div className="max-h-96 overflow-auto rounded-md border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('adminLegalConsentUser')}</TableHead>
                    <TableHead>{t('adminLegalConsentDoc')}</TableHead>
                    <TableHead>{t('adminLegalConsentVer')}</TableHead>
                    <TableHead>{t('adminLegalConsentCtx')}</TableHead>
                    <TableHead>{t('adminLegalConsentIp')}</TableHead>
                    <TableHead>{t('adminLegalConsentTime')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {consents.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="text-sm">{c.fullName || c.username || '—'}</div>
                        {c.username && (
                          <div className="text-xs text-muted-foreground">@{c.username}</div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{docTypeLabel(c.docType)}</div>
                        <div className="text-xs text-muted-foreground">v{c.docVersion}</div>
                      </TableCell>
                      <TableCell className="text-sm">{c.docVersion}</TableCell>
                      <TableCell className="text-sm">{contextLabel(c.context)}</TableCell>
                      <TableCell className="font-mono text-sm">{c.requestIp || '—'}</TableCell>
                      <TableCell className="text-sm">{formatDateTime(c.consentedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── READ DIALOG ── */}
      <Dialog open={!!readDoc} onOpenChange={(o) => { if (!o) setReadDoc(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">{readDoc ? localizedTitle(readDoc) : ''}</DialogTitle>
            <DialogDescription>
              {readDoc ? `${docTypeLabel(readDoc.docType)} · v${readDoc.version}` : ''}
            </DialogDescription>
          </DialogHeader>
          <Tabs value={readTab} onValueChange={(v) => setReadTab(v as ReadTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="EN" className="flex-1">{t('adminLegalLangEn')}</TabsTrigger>
              <TabsTrigger value="FR" className="flex-1">{t('adminLegalLangFr')}</TabsTrigger>
              <TabsTrigger value="AR" className="flex-1">{t('adminLegalLangAr')}</TabsTrigger>
            </TabsList>
            {(['EN', 'FR', 'AR'] as ReadTab[]).map((rt) => {
              const { content, missing } = readContentFor(rt);
              return (
                <TabsContent key={rt} value={rt} className="mt-3">
                  {missing && (
                    <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                      {t('adminLegalMissing')}
                    </p>
                  )}
                  <ScrollArea className="max-h-[70vh] rounded-md border p-4">
                    <div
                      className="whitespace-pre-wrap text-sm leading-relaxed"
                      dir={rt === 'AR' ? 'rtl' : 'ltr'}
                    >
                      {content}
                    </div>
                  </ScrollArea>
                </TabsContent>
              );
            })}
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* ── EDIT & PUBLISH DIALOG ── */}
      <Dialog open={editOpen} onOpenChange={(o) => { if (!o && !publishing) setEditOpen(false); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">{t('adminLegalEditTitle')}</DialogTitle>
            <DialogDescription>
              {editDocType ? docTypeLabel(editDocType) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {t('adminLegalPublishNote')}
          </div>
          <ScrollArea className="max-h-[60vh]">
            <div className="space-y-4 pe-2">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="legal-title-en">{t('adminLegalTitleEn')} *</Label>
                  <Input
                    id="legal-title-en"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    dir="ltr"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="legal-title-fr">{t('adminLegalTitleFr')}</Label>
                  <Input
                    id="legal-title-fr"
                    value={editTitleFr}
                    onChange={(e) => setEditTitleFr(e.target.value)}
                    dir="ltr"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="legal-title-ar">{t('adminLegalTitleAr')}</Label>
                  <Input
                    id="legal-title-ar"
                    value={editTitleAr}
                    onChange={(e) => setEditTitleAr(e.target.value)}
                    dir="rtl"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="legal-content-en">{t('adminLegalContentEn')} *</Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditPreview((p) => !p)}
                  >
                    <Eye className="me-1.5 h-4 w-4" />
                    {t('adminLegalPreview')}
                  </Button>
                </div>
                {editPreview && (
                  <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-background p-3 text-sm leading-relaxed">
                    {editContent || '—'}
                  </div>
                )}
                <Textarea
                  id="legal-content-en"
                  rows={12}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  dir="ltr"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="legal-content-fr">{t('adminLegalContentFr')}</Label>
                <Textarea
                  id="legal-content-fr"
                  rows={12}
                  value={editContentFr}
                  onChange={(e) => setEditContentFr(e.target.value)}
                  dir="ltr"
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="legal-content-ar">{t('adminLegalContentAr')}</Label>
                <Textarea
                  id="legal-content-ar"
                  rows={12}
                  value={editContentAr}
                  onChange={(e) => setEditContentAr(e.target.value)}
                  dir="rtl"
                  className="font-mono text-sm"
                />
              </div>
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" disabled={publishing} onClick={() => setEditOpen(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={publish} disabled={publishing}>
              {publishing && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('adminLegalPublish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── ROLLBACK CONFIRM DIALOG ── */}
      <Dialog
        open={!!rollbackTarget}
        onOpenChange={(o) => { if (!o && !rollbackBusy) setRollbackTarget(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{t('adminLegalRollback')}</DialogTitle>
            <DialogDescription>
              {rollbackTarget
                ? t('adminLegalRollbackConfirm', { v: String(rollbackTarget.version) })
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={rollbackBusy}
              onClick={() => setRollbackTarget(null)}
            >
              {t('cancel')}
            </Button>
            <Button variant="destructive" disabled={rollbackBusy} onClick={confirmRollback}>
              {rollbackBusy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t('adminLegalRollback')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
