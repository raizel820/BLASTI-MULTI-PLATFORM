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
} from 'lucide-react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';

interface PendingPayment {
  id: string;
  agencyName: string;
  amount: number;
  plan: string;
  method: string;
  status: string;
  receiptUrl?: string;
  createdAt: string;
}

/**
 * Get a proxied URL for accessing private storage files.
 * Delegates to the shared utility from @/lib/utils.
 */
function getProxiedUrl(url: string): string {
  if (!url) return url;
  // Blob URLs need to go through the proxy
  if (url.includes('.blob.vercel-storage.com')) {
    return `/api/upload/proxy?url=${encodeURIComponent(url)}`;
  }
  // R2 URLs without public domain need proxying
  if (url.includes('.r2.cloudflarestorage.com')) {
    return `/api/upload/proxy?url=${encodeURIComponent(url)}`;
  }
  // Local URLs and other URLs can be used directly
  return url;
}

export function AdminTransactions() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const [payments, setPayments] = useState<PendingPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('PENDING');

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
  }, [statusFilter]);

  const fetchPayments = async () => {
    setLoading(true);
    try {
      const statusParam = statusFilter !== 'ALL' ? `?status=${statusFilter}` : '';
      const res = await apiFetch(`/api/transactions${statusParam}`);
      if (res.ok) {
        const data = await res.json();
        const mapped = (data.transactions ?? []).map((tx: Record<string, unknown>) => {
          const agency = tx.agency as Record<string, string> | undefined;
          return {
            id: tx.id,
            agencyName: agency?.name || t('unknownAgency'),
            amount: tx.amount as number,
            plan: tx.plan as string,
            method: tx.paymentMethod as string,
            status: tx.status as string,
            receiptUrl: (tx.receiptUrl as string) || undefined,
            createdAt: tx.createdAt as string,
          };
        });
        setPayments(mapped);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (id: string) => {
    setActionLoading(id);
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
    setActionLoading(rejectId);
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

  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t('pendingPayments')}</h1>
      </div>

      {/* Status Filter */}
      <div className="flex gap-2">
        {['ALL', 'PENDING', 'APPROVED', 'REJECTED'].map((status) => (
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
        <div className="space-y-3">
          {payments.map((payment, idx) => (
            <motion.div
              key={payment.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    {/* Agency Info */}
                    <div className="flex items-center gap-3 flex-1">
                      <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center flex-shrink-0 shadow-sm">
                        <Building2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {payment.agencyName}
                        </p>
                        <div className="flex items-center gap-2 flex-wrap mt-0.5">
                          <Badge variant="secondary" className="text-[10px]">
                            {payment.plan === 'PREMIUM' ? t('premiumPlan') : payment.plan === 'ENTERPRISE' ? t('enterprisePlan') : t('basicPlan')}
                          </Badge>
                          <Badge
                            className={`text-[10px] ${
                              payment.status === 'PENDING'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : payment.status === 'APPROVED'
                                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                  : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            }`}
                          >
                            {translateStatus(payment.status, t)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{translatePaymentMethod(payment.method, t)}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(payment.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US')}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Amount + Actions */}
                    <div className="flex items-center gap-3 sm:ms-auto">
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

                      {payment.status === 'PENDING' && (
                        <>
                          <Button
                            size="sm"
                            className="h-9 px-3 bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={() => handleApprove(payment.id)}
                            disabled={!!actionLoading}
                          >
                            {actionLoading === payment.id ? (
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
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      {/* Reject Dialog */}
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
              disabled={actionLoading === rejectId}
            >
              {actionLoading === rejectId ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <X className="h-4 w-4 me-1.5" />
              )}
              {t('rejectTransaction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt Preview Dialog */}
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
