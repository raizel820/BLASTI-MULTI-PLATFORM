'use client'

/**
 * Payment reconciliation panel (r21-6).
 *
 * The reconciliation + unreconciled-transactions sections were previously
 * embedded inside admin-payment-engine.tsx (the old "Financial Engine" page).
 * They are lifted here verbatim (same endpoints, same visuals) so the new
 * unified "Payment Settings" page can embed them as a tab while the old
 * engine page keeps working untouched on disk.
 *
 * Endpoints (all SUPER_ADMIN, cloud API):
 *   GET  /api/reconciliation/report/:date
 *   POST /api/reconciliation/run
 *   GET  /api/reconciliation/unreconciled?limit=20
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  BarChart3,
  Calendar,
  FileText,
  DollarSign,
  Activity,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { translateStatus, translatePaymentMethod } from '@/lib/enum-i18n';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

// ─── Color palette for charts ───────────────────────────────────────────────
const CHART_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'];

interface ReconciliationReportItem {
  id: string;
  amount: number;
  status: string;
  paymentProvider: string;
  providerRef: string | null;
  reconciledAt: string | null;
  reconciledBy: string | null;
  webhookVerified: boolean;
  agencyId: string;
  agencyName: string;
  createdAt: string;
}

interface ReconciliationReportData {
  date: string;
  totalCompleted: number;
  totalReconciled: number;
  totalUnreconciled: number;
  totalPending: number;
  byProvider: Record<string, { count: number; total: number }>;
  transactions: ReconciliationReportItem[];
}

interface ReconciliationRunResult {
  date: string;
  totalExpected: number;
  totalReconciled: number;
  totalDiscrepancies: number;
  matchedCount: number;
  unmatchedCount: number;
  discrepancyCount: number;
  reconciledAt: string;
}

interface UnreconciledData {
  transactions: Array<{
    id: string;
    amount: number;
    status: string;
    paymentProvider: string;
    providerRef: string | null;
    webhookVerified: boolean;
    agencyId: string;
    agency: { id: string; name: string; customCode: string };
    reviewer: { id: string; fullName: string; username: string } | null;
    createdAt: string;
  }>;
  total: number;
}

export function AdminPaymentReconciliation() {
  const { t } = useLanguage();

  // Reconciliation state
  const [reconDate, setReconDate] = useState(new Date().toISOString().split('T')[0]);
  const [reconReport, setReconReport] = useState<ReconciliationReportData | null>(null);
  const [reconResult, setReconResult] = useState<ReconciliationRunResult | null>(null);
  const [runningRecon, setRunningRecon] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);

  // Unreconciled state
  const [unreconciled, setUnreconciled] = useState<UnreconciledData | null>(null);
  const [loadingUnreconciled, setLoadingUnreconciled] = useState(false);

  // ── Fetch reconciliation report ──
  const fetchReport = useCallback(async (date: string) => {
    if (!date) return;
    setLoadingReport(true);
    try {
      const res = await apiFetch(`/api/reconciliation/report/${date}`);
      if (res.ok) {
        const data = await res.json();
        setReconReport(data.data);
      }
    } catch {
      toast.error('Failed to load reconciliation report');
    } finally {
      setLoadingReport(false);
    }
  }, []);

  // ── Run reconciliation ──
  const runReconciliation = async () => {
    if (!reconDate) {
      toast.error('Please select a date');
      return;
    }
    setRunningRecon(true);
    try {
      const res = await apiFetch('/api/reconciliation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: reconDate }),
      });
      if (res.ok) {
        const data = await res.json();
        setReconResult(data.data);
        toast.success(`Reconciliation complete for ${reconDate}`);
        await fetchReport(reconDate);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Reconciliation failed');
      }
    } catch {
      toast.error('Reconciliation failed');
    } finally {
      setRunningRecon(false);
    }
  };

  // ── Fetch unreconciled transactions ──
  const fetchUnreconciled = useCallback(async () => {
    setLoadingUnreconciled(true);
    try {
      const res = await apiFetch('/api/reconciliation/unreconciled?limit=20');
      if (res.ok) {
        const data = await res.json();
        setUnreconciled(data.data);
      }
    } catch {
      toast.error('Failed to load unreconciled transactions');
    } finally {
      setLoadingUnreconciled(false);
    }
  }, []);

  // ── Initial load ──
  useEffect(() => {
    fetchUnreconciled();
    fetchReport(reconDate);
  }, [fetchUnreconciled, fetchReport, reconDate]);

  // ── Chart data ──
  const providerChartData = reconReport?.byProvider
    ? Object.entries(reconReport.byProvider).map(([name, data]) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        value: data.total,
        count: data.count,
      }))
    : [];

  const statusChartData = reconReport
    ? [
        { name: 'Reconciled', value: reconReport.totalReconciled, color: '#10b981' },
        { name: 'Unreconciled', value: reconReport.totalUnreconciled, color: '#f59e0b' },
        { name: 'Pending', value: reconReport.totalPending, color: '#ef4444' },
      ]
    : [];

  // ── Format currency ──
  const formatDZD = (amount: number) => {
    return new Intl.NumberFormat('ar-DZ', {
      style: 'decimal',
      minimumFractionDigits: 0,
    }).format(amount) + ' DZD';
  };

  return (
    <div className="space-y-4">
      {/* ─── Run Reconciliation ─── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Calendar className="h-4 w-4 text-emerald-600" />
            {t('runReconciliation')}
          </CardTitle>
          <CardDescription>
            {t('runReconDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">{t('selectDate')}</Label>
              <Input
                type="date"
                value={reconDate}
                onChange={(e) => setReconDate(e.target.value)}
                className="h-9"
              />
            </div>
            <Button
              onClick={runReconciliation}
              disabled={runningRecon}
              className="bg-emerald-600 hover:bg-emerald-700 h-9"
            >
              {runningRecon ? (
                <Loader2 className="h-4 w-4 animate-spin me-2" />
              ) : (
                <RefreshCw className="h-4 w-4 me-2" />
              )}
              {t('runRecon')}
            </Button>
          </div>

          {/* Reconciliation Result */}
          {reconResult && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4"
            >
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800/30 text-center">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
                  <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{reconResult.matchedCount}</p>
                  <p className="text-[10px] text-muted-foreground">{t('matched')}</p>
                </div>
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 text-center">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mx-auto mb-1" />
                  <p className="text-lg font-bold text-amber-700 dark:text-amber-400">{reconResult.discrepancyCount}</p>
                  <p className="text-[10px] text-muted-foreground">{t('discrepancies')}</p>
                </div>
                <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800/30 text-center">
                  <XCircle className="h-5 w-5 text-red-600 mx-auto mb-1" />
                  <p className="text-lg font-bold text-red-700 dark:text-red-400">{reconResult.unmatchedCount}</p>
                  <p className="text-[10px] text-muted-foreground">{t('unmatched')}</p>
                </div>
                <div className="p-3 rounded-lg bg-teal-50 dark:bg-teal-900/10 border border-teal-200 dark:border-teal-800/30 text-center">
                  <DollarSign className="h-5 w-5 text-teal-600 mx-auto mb-1" />
                  <p className="text-sm font-bold text-teal-700 dark:text-teal-400">{formatDZD(reconResult.totalReconciled)}</p>
                  <p className="text-[10px] text-muted-foreground">{t('totalReconciled')}</p>
                </div>
              </div>
            </motion.div>
          )}
        </CardContent>
      </Card>

      {/* ─── Charts ─── */}
      {reconReport && !loadingReport && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Payment Provider Distribution */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-violet-600" />
                {t('providerDistribution')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {providerChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={providerChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip
                      formatter={(value: number) => formatDZD(value)}
                      contentStyle={{ fontSize: 12 }}
                    />
                    <Bar dataKey="value" name="Amount" radius={[4, 4, 0, 0]}>
                      {providerChartData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
                  {t('noData')}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Reconciliation Status */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-teal-600" />
                {t('reconciliationStatus')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {statusChartData.some(d => d.value > 0) ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={statusChartData.filter(d => d.value > 0)}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                      label={({ name, value }) => `${name}: ${formatDZD(value)}`}
                    >
                      {statusChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value: number) => formatDZD(value)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[200px] text-muted-foreground text-sm">
                  {t('noData')}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Loading state for report */}
      {loadingReport && (
        <Card>
          <CardContent className="p-6 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      )}

      {/* ─── Report Summary ─── */}
      {reconReport && !loadingReport && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-600" />
              {t('reportSummary')} — {reconDate}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="text-center p-2 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">{t('completed')}</p>
                <p className="text-sm font-bold">{formatDZD(reconReport.totalCompleted)}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/10">
                <p className="text-xs text-muted-foreground">{t('reconciled')}</p>
                <p className="text-sm font-bold text-emerald-600">{formatDZD(reconReport.totalReconciled)}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-amber-50 dark:bg-amber-900/10">
                <p className="text-xs text-muted-foreground">{t('unreconciled')}</p>
                <p className="text-sm font-bold text-amber-600">{formatDZD(reconReport.totalUnreconciled)}</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-red-50 dark:bg-red-900/10">
                <p className="text-xs text-muted-foreground">{t('pending')}</p>
                <p className="text-sm font-bold text-red-600">{formatDZD(reconReport.totalPending)}</p>
              </div>
            </div>

            {/* Transactions table */}
            {reconReport.transactions.length > 0 ? (
              <div className="max-h-64 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[11px]">{t('agency')}</TableHead>
                      <TableHead className="text-[11px]">{t('amount')}</TableHead>
                      <TableHead className="text-[11px]">{t('provider')}</TableHead>
                      <TableHead className="text-[11px]">{t('status')}</TableHead>
                      <TableHead className="text-[11px]">{t('reconciled')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconReport.transactions.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell className="text-xs font-medium">{tx.agencyName}</TableCell>
                        <TableCell className="text-xs">{formatDZD(tx.amount)}</TableCell>
                        <TableCell className="text-xs">
                          <Badge variant="outline" className="text-[10px]">
                            {translatePaymentMethod(tx.paymentProvider, t)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge
                            variant={
                              tx.status === 'COMPLETED' ? 'default' :
                              tx.status === 'PENDING' ? 'secondary' :
                              'destructive'
                            }
                            className="text-[10px]"
                          >
                            {translateStatus(tx.status, t)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {tx.reconciledAt ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t('noTransactionsDate')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Unreconciled Transactions ─── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4 text-emerald-600" />
                {t('unreconciledTransactions')}
              </CardTitle>
              <CardDescription>
                {t('unreconciledDesc')}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={fetchUnreconciled}>
              <RefreshCw className="h-3.5 w-3.5 me-1" />
              {t('refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loadingUnreconciled ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : unreconciled && unreconciled.transactions.length > 0 ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {unreconciled.total} {t('total')}
                </Badge>
              </div>
              <div className="max-h-96 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[11px]">{t('agency')}</TableHead>
                      <TableHead className="text-[11px]">{t('amount')}</TableHead>
                      <TableHead className="text-[11px]">{t('provider')}</TableHead>
                      <TableHead className="text-[11px]">{t('verified')}</TableHead>
                      <TableHead className="text-[11px]">{t('date')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unreconciled.transactions.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell className="text-xs font-medium">
                          {tx.agency?.name || '—'}
                        </TableCell>
                        <TableCell className="text-xs">{formatDZD(tx.amount)}</TableCell>
                        <TableCell className="text-xs">
                          <Badge variant="outline" className="text-[10px]">
                            {translatePaymentMethod(tx.paymentProvider, t)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {tx.webhookVerified ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <div className="text-center py-8">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {t('allReconciled')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
