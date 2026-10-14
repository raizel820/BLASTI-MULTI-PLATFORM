'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { translateStatus, translatePaymentMethod } from '@/lib/enum-i18n';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  CreditCard,
  Check,
  X,
  Loader2,
  Image as ImageIcon,
  Building2,
  Download,
  ExternalLink,
  FileText,
  BadgeCheck,
  ShieldCheck,
  Landmark,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

/**
 * Admin transactions console — manual receipt payments AND online Chargily
 * payments in one view.
 *
 *  • Manual payments  → approve / reject (receipt upload flow).
 *  • Online payments  → gateway-owned: never "approved" by an admin. The
 *    settlement lifecycle is driven by Chargily (webhook / checkout poll);
 *    admins reconcile through the gateway: verify with the LIVE checkout,
 *    confirm settled / mark failed (only real gateway states are accepted —
 *    an unpaid charge can never be settled, and a gateway-reported "pending"
 *    checkout cannot be failed either — the API refuses both with 409).
 */
interface AdminPayment {
  id: string;
  agencyName: string;
  amount: number;
  plan: string;
  planName?: string | null;
  method: string;
  status: string;
  receiptUrl?: string;
  createdAt: string;
  reviewedAt?: string | null;
  reconciledAt?: string | null;
  rejectionReason?: string | null;
  /** SUBSCRIPTION (default) | HARDWARE */
  type: string;
  providerRef: string;
  webhookVerified: boolean;
  isOnline: boolean;
  payerName?: string;
  payerContact?: string;
  agencySubscriptionStatus?: string;
  /** 'subscription' (Agency subscription payment) | 'sms_purchase' (customer SMS pack)
   *  — ALL-transactions mandate: the console lists both, subscription-only
   *  actions (review/reconcile) are hidden for sms_purchase rows. */
  kind: 'subscription' | 'sms_purchase';
  /** SMS pack size (sms_purchase rows only). */
  smsQuantity?: number;
}

type TypeFilter = 'ALL' | 'manual' | 'online';
type ReconcileAction = 'verify' | 'mark-settled' | 'mark-failed';

const STATUS_FILTERS = ['ALL', 'PENDING', 'COMPLETED', 'FAILED', 'APPROVED', 'REJECTED'] as const;

/**
 * Get a safe URL for accessing uploaded files.
 * All uploads live on the API server's local disk and are served
 * directly — no external storage provider is involved.
 */
function getProxiedUrl(url: string): string {
  return url || '';
}

export function AdminTransactions() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');

  // Reject dialog
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Receipt preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    fetchPayments();
  }, [statusFilter, typeFilter]);

  const fetchPayments = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (typeFilter !== 'ALL') params.set('type', typeFilter);
      params.set('limit', '50');
      const res = await apiFetch(`/api/transactions?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const mapped = (data.transactions ?? []).map((tx: Record<string, unknown>) => {
          const kind = (tx.kind as string) === 'sms_purchase' ? 'sms_purchase' : 'subscription';
          const agency = tx.agency as
            | { name?: string; subscriptionStatus?: string; owner?: { username?: string; fullName?: string; email?: string } }
            | undefined;
          const owner = agency?.owner;
          const smsBuyer = tx.user as { username?: string; fullName?: string; email?: string } | undefined;
          const providerRef = ((tx.providerRef as string) || '').trim();
          // SMS purchases have no agency — the payer is the customer account.
          const payer = kind === 'sms_purchase'
            ? (smsBuyer?.fullName?.trim() || smsBuyer?.username?.trim() || '')
            : (owner?.fullName?.trim() || owner?.username?.trim() || '');
          const payerEmail = kind === 'sms_purchase'
            ? (smsBuyer?.email?.trim() || '')
            : (owner?.email?.trim() || '');
          return {
            id: tx.id,
            agencyName: kind === 'sms_purchase' ? (t('customerRole') || 'Customer') : (agency?.name || t('unknownAgency')),
            amount: (tx.amountPaid as number) ?? (tx.amount as number),
            plan: (tx.plan as string) || 'SMS_PACK',
            planName: (tx.planName as string) || (kind === 'sms_purchase' ? `SMS Pack ×${tx.quantity}` : null),
            method: (tx.paymentMethod as string) || (tx.paymentProvider as string) || '',
            status: tx.status as string,
            receiptUrl: (tx.receiptUrl as string) || undefined,
            createdAt: tx.createdAt as string,
            reviewedAt: (tx.reviewedAt as string) || null,
            reconciledAt: (tx.reconciledAt as string) || null,
            rejectionReason: (tx.rejectionReason as string) || null,
            type: (tx.type as string) || 'SUBSCRIPTION',
            providerRef,
            webhookVerified: !!tx.webhookVerified,
            // Online payments are ALWAYS created with a Chargily checkout id in
            // providerRef (payment-checkout.ts); manual receipts leave it empty.
            isOnline: kind === 'sms_purchase'
              ? ((tx.paymentProvider as string) === 'chargily')
              : !!providerRef,
            payerName: payer || undefined,
            payerContact: payerEmail || undefined,
            agencySubscriptionStatus: agency?.subscriptionStatus || undefined,
            kind,
            smsQuantity: (tx.quantity as number) || undefined,
          } as AdminPayment;
        });
        setPayments(mapped);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  // ── Manual payments: approve / reject (receipt flow only) ──
  const handleApprove = async (id: string) => {
    setActionLoading(`${id}:approve`);
    try {
      const res = await apiFetch(`/api/admin/transactions/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          reviewedBy: user?.id || undefined,
        }),
      });
      if (res.ok) {
        toast.success(t('approveTransaction'));
        fetchPayments();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async () => {
    if (!rejectId || !rejectReason.trim()) {
      toast.error(t('requiredField'));
      return;
    }
    setActionLoading(`${rejectId}:reject`);
    try {
      const res = await apiFetch(`/api/admin/transactions/${rejectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          reason: rejectReason,
          reviewedBy: user?.id || undefined,
        }),
      });
      if (res.ok) {
        toast.success(t('rejectTransaction'));
        setRejectDialogOpen(false);
        setRejectId(null);
        setRejectReason('');
        fetchPayments();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  // ── Online payments: gateway reconciliation ──
  // verify        → query the LIVE Chargily checkout and apply its true state
  //                 through the idempotent fulfillment path (same code as the
  //                 webhook). The honest default: it settles real payments and
  //                 real failures, and reports "pending" without touching state.
  // mark-settled  → confirm settlement. Refused (409) while the gateway still
  //                 reports the charge as pending; allowed as a documented
  //                 override ONLY when the gateway API is unreachable.
  // mark-failed   → mirror image for abandoned checkouts (same rules).
  const handleReconcile = async (id: string, action: ReconcileAction) => {
    setActionLoading(`${id}:${action}`);
    try {
      const res = await apiFetch(`/api/admin/transactions/${id}/reconcile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        if (action === 'verify') {
          const normalized = data.live?.normalized;
          if (normalized === 'paid') toast.success(t('txVerifyPaid'));
          else if (normalized === 'failed') toast.info(t('txVerifyFailed'));
          else toast.info(t('txVerifyPending'));
        } else if (data.override) {
          // Gateway unreachable — the admin closed the payment out manually.
          toast.warning(t('txOverrideApplied'));
        } else {
          toast.success(action === 'mark-settled' ? t('txVerifyPaid') : t('txVerifyFailed'));
        }
        fetchPayments();
      } else if (res.status === 502) {
        toast.error(data.detail ? `${t('txGatewayUnreachable')} — ${data.detail}` : t('txGatewayUnreachable'));
      } else if (res.status === 409) {
        toast.error(data.error || t('txRefusedPending'));
      } else {
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const openRejectDialog = (id: string) => {
    setRejectId(id);
    setRejectReason('');
    setRejectDialogOpen(true);
  };

  const openPreview = (url: string) => {
    // Use proxy URL for blob URLs, direct URL for local files
    const proxiedUrl = getProxiedUrl(url);
    setPreviewUrl(proxiedUrl);
    setPreviewLoading(true);
    setPreviewError(false);
    setPreviewOpen(true);
  };

  const handlePreviewLoad = () => {
    setPreviewLoading(false);
    setPreviewError(false);
  };

  const handlePreviewError = () => {
    setPreviewLoading(false);
    setPreviewError(true);
  };

  // Determine if a receipt URL is a PDF
  const isPdfUrl = (url?: string) => {
    if (!url) return false;
    return url.toLowerCase().includes('.pdf') || url.toLowerCase().includes('pdf');
  };

  const statusBadgeClass = (status: string) =>
    status === 'PENDING'
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
      : status === 'APPROVED' || status === 'COMPLETED'
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';

  const busy = (id: string, action: string) => actionLoading === `${id}:${action}`;

  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full max-w-xl rounded-lg" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const pendingCount = payments.filter((p) => p.status === 'PENDING').length;

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-foreground">{t('transactions')}</h1>
        {pendingCount > 0 && (
          <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-xs px-2 py-1 self-start">
            {pendingCount} {t('statusPending').toLowerCase()}
          </Badge>
        )}
      </div>

      {/* Type Filter — Manual receipts vs Online (Chargily) payments */}
      <div className="flex flex-wrap items-center gap-2">
        <Landmark className="h-4 w-4 text-muted-foreground" />
        {([
          { key: 'ALL' as TypeFilter, label: t('txTypeAll') },
          { key: 'manual' as TypeFilter, label: t('txTypeManual') },
          { key: 'online' as TypeFilter, label: t('txTypeOnline') },
        ]).map((item) => (
          <button
            key={item.key}
            onClick={() => { setTypeFilter(item.key); }}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
              typeFilter === item.key
              ? 'filter-chip-active'
              : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
            }`
          }
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Status Filter */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => { setStatusFilter(status); }}
            className={`px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
              statusFilter === status
              ? 'filter-chip-active'
              : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700'
            }`
          }
          >
            {status === 'ALL' ? t('all') : translateStatus(status, t)}
          </button>
        ))}
      </div>

      {payments.length === 0 ? (
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardContent className="py-16 text-center">
            <CreditCard className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">{t('noData')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3 max-h-[75vh] overflow-y-auto custom-scrollbar pe-1">
          {payments.map((payment, idx) => (
            <motion.div
              key={payment.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx * 0.03, 0.3) }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    {/* Agency Info */}
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div
                        className={`h-10 w-10 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm ${
                          payment.isOnline
                            ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40'
                            : 'bg-gradient-to-br from-amber-200 to-orange-200 dark:from-amber-900/40 dark:to-orange-800/40'
                        }`}
                      >
                        {payment.isOnline ? (
                          <CreditCard className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Building2 className="h-5 w-5 text-amber-700 dark:text-amber-400" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {payment.kind === 'sms_purchase'
                            ? (payment.payerName || payment.agencyName)
                            : payment.agencyName}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          {/* Manual vs Online badge */}
                          {payment.isOnline ? (
                            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] px-1.5 py-0">
                              <CreditCard className="h-3 w-3 me-0.5" />
                              {t('txBadgeOnline')}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                              {t('txBadgeManual')}
                            </Badge>
                          )}
                          {/* ALL-transactions mandate — SMS pack purchases render as
                              their own kind (badge + payer handled above) and never
                              masquerade as subscription plans */}
                          {payment.kind === 'sms_purchase' ? (
                            <Badge variant="secondary" className="text-[10px]">
                              SMS ×{payment.smsQuantity ?? '—'}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">
                              {payment.plan === 'PREMIUM' ? t('premiumPlan') : payment.plan === 'ENTERPRISE' ? t('enterprisePlan') : t('basicPlan')}
                            </Badge>
                          )}
                          {/* Subscription vs Hardware payment (online rows) */}
                          {payment.isOnline && payment.type === 'HARDWARE' && (
                            <Badge variant="secondary" className="text-[10px]">
                              {t('txHardwarePayment')}
                            </Badge>
                          )}
                          <Badge
                            className={`text-[10px] ${statusBadgeClass(payment.status)}`}
                          >
                            {translateStatus(payment.status, t)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{translatePaymentMethod(payment.method, t)}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(payment.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US')}
                          </span>
                        </div>
                        {/* Online payment details — gateway reference + payer account */}
                        {payment.isOnline && (
                          <div className="flex items-center gap-3 flex-wrap mt-1 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1 min-w-0">
                              <span className="font-medium">{t('txGatewayRef')}:</span>
                              <span className="font-mono truncate max-w-[16rem]" dir="ltr" title={payment.providerRef}>
                                {payment.providerRef}
                              </span>
                            </span>
                            {(payment.payerName || payment.payerContact) && (
                              <span className="inline-flex items-center gap-1 min-w-0">
                                <span className="font-medium">{t('txPayer')}:</span>
                                <span className="truncate max-w-[14rem]">
                                  {payment.payerName}{payment.payerContact ? ` · ${payment.payerContact}` : ''}
                                </span>
                              </span>
                            )}
                            {payment.webhookVerified && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <BadgeCheck className="h-3.5 w-3.5" />
                                {t('verified')}
                              </span>
                            )}
                            {payment.reconciledAt && (
                              <span>
                                {t('txReconciled')}: {new Date(payment.reconciledAt).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US')}
                              </span>
                            )}
                          </div>
                        )}
                        {payment.rejectionReason && (
                          <p className="text-[11px] text-red-600 dark:text-red-400 mt-1 truncate" title={payment.rejectionReason}>
                            {payment.rejectionReason}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Amount + Actions */}
                    <div className="flex items-center gap-2 sm:gap-3 sm:ms-auto flex-wrap justify-end">
                      <div className="text-end me-2">
                        <p className="text-lg font-bold text-foreground">
                          {payment.amount.toLocaleString()} {t('currency')}
                        </p>
                      </div>

                      {payment.receiptUrl && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-9 px-3"
                          onClick={() => openPreview(payment.receiptUrl!)}
                        >
                          <ImageIcon className="h-4 w-4 me-1.5" />
                          <span className="hidden sm:inline">{t('viewDetails')}</span>
                        </Button>
                      )}

                      {/* ── MANUAL payments: approve / reject (unchanged flow).
                          SMS purchases are NOT reviewable here — their manual
                          approval lives in the SMS purchase admin flow; online
                          SMS packs settle via the gateway webhook. */}
                      {!payment.isOnline && payment.status === 'PENDING' && payment.kind === 'subscription' && (
                        <>
                          <Button
                            size="sm"
                            className="h-9 px-3 bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={() => handleApprove(payment.id)}
                            disabled={!!actionLoading}
                          >
                            {busy(payment.id, 'approve') ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Check className="h-4 w-4 me-1.5" />
                            )}
                            {t('approveTransaction')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9 px-3 border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20"
                            onClick={() => openRejectDialog(payment.id)}
                            disabled={!!actionLoading}
                          >
                            <X className="h-4 w-4 me-1.5" />
                            {t('rejectTransaction')}
                          </Button>
                        </>
                      )}

                      {/* ── ONLINE payments: gateway reconciliation only ──
                              The gateway owns the lifecycle; admins never
                              "approve" an unpaid charge. SMS purchases are
                              reconciled through the SMS flow, not here. */}
                      {payment.isOnline && payment.kind === 'subscription' && (
                        <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9 px-3 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
                            onClick={() => handleReconcile(payment.id, 'verify')}
                            disabled={!!actionLoading}
                            title={t('txVerifyWithGateway')}
                          >
                            {busy(payment.id, 'verify') ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <ShieldCheck className="h-4 w-4 me-1.5" />
                            )}
                            <span className="hidden md:inline">{t('txVerifyWithGateway')}</span>
                          </Button>
                          {payment.status === 'PENDING' && (
                            <>
                              <Button
                                size="sm"
                                className="h-9 px-3 bg-emerald-600 hover:bg-emerald-700 text-white"
                                onClick={() => handleReconcile(payment.id, 'mark-settled')}
                                disabled={!!actionLoading}
                                title={t('txMarkSettled')}
                              >
                                {busy(payment.id, 'mark-settled') ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4 me-1.5" />
                                )}
                                <span className="hidden md:inline">{t('txMarkSettled')}</span>
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-9 px-3 border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-900/20"
                                onClick={() => handleReconcile(payment.id, 'mark-failed')}
                                disabled={!!actionLoading}
                                title={t('txMarkFailed')}
                              >
                                {busy(payment.id, 'mark-failed') ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <X className="h-4 w-4 me-1.5" />
                                )}
                                <span className="hidden md:inline">{t('txMarkFailed')}</span>
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Explain why approve/reject is unavailable on online rows */}
                  {payment.isOnline && payment.status === 'PENDING' && (
                    <p className="text-[10px] text-muted-foreground mt-2 flex items-center gap-1">
                      <BadgeCheck className="h-3 w-3" />
                      {t('txGatewayOwned')}
                    </p>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Reject Dialog (manual payments only) */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('rejectTransaction')}</DialogTitle>
            <DialogDescription className="sr-only">{t('rejectionReason')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{t('rejectionReason')}</Label>
              <textarea
                className="w-full min-h-24 p-3 rounded-xl border border-input bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={t('rejectionReason')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={handleReject}
              disabled={actionLoading === `${rejectId}:reject`}
            >
              {actionLoading === `${rejectId}:reject` ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="h-4 w-4 me-1.5" />
              )}
              {t('rejectTransaction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt Preview Dialog (manual payments only) */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('paymentProof')}</DialogTitle>
            <DialogDescription className="sr-only">Dialog for viewing payment proof receipt</DialogDescription>
          </DialogHeader>
          <div className="py-4 flex items-center justify-center min-h-[200px]">
            {previewUrl && !previewError ? (
              <>
                {previewLoading && (
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
                    <p className="text-sm text-muted-foreground">Loading receipt...</p>
                  </div>
                )}
                {isPdfUrl(previewUrl) ? (
                  <div className="w-full">
                    <iframe
                      src={previewUrl}
                      className="w-full h-[60vh] rounded-lg border"
                      title="Receipt PDF"
                      onLoad={handlePreviewLoad}
                      onError={handlePreviewError}
                    />
                    <div className="flex justify-center mt-3">
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700 hover:underline"
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open in new tab
                      </a>
                    </div>
                  </div>
                ) : (
                  <img
                    src={previewUrl}
                    alt="Receipt"
                    className={`max-h-[60vh] max-w-full object-contain rounded-lg ${previewLoading ? 'hidden' : ''}`}
                    onLoad={handlePreviewLoad}
                    onError={handlePreviewError}
                  />
                )}
              </>
            ) : previewError ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <FileText className="h-12 w-12 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Could not load receipt preview</p>
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700 hover:underline"
                  >
                    <Download className="h-4 w-4" />
                    Try downloading directly
                  </a>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">{t('noData')}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
