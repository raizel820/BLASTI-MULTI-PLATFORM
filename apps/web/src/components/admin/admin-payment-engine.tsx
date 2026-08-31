'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CreditCard,
  Settings,
  RefreshCw,
  Loader2,
  Save,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  BarChart3,
  Calendar,
  FileText,
  Shield,
  Zap,
  Link,
  Copy,
  ArrowRight,
  DollarSign,
  Activity,
  Key,
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

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

// ─── Color palette for charts ───────────────────────────────────────────────
const CHART_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'];

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ChargilyConfig {
  chargily_api_key: string;
  chargily_secret_key: string;
  chargily_mode: string;
}

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

// ─── Component ───────────────────────────────────────────────────────────────

export function AdminPaymentEngine() {
  const { t } = useLanguage();

  // Chargily config state
  const [config, setConfig] = useState<ChargilyConfig>({
    chargily_api_key: '',
    chargily_secret_key: '',
    chargily_mode: 'sandbox',
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Reconciliation state
  const [reconDate, setReconDate] = useState(new Date().toISOString().split('T')[0]);
  const [reconReport, setReconReport] = useState<ReconciliationReportData | null>(null);
  const [reconResult, setReconResult] = useState<ReconciliationRunResult | null>(null);
  const [runningRecon, setRunningRecon] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);

  // Unreconciled state
  const [unreconciled, setUnreconciled] = useState<UnreconciledData | null>(null);
  const [loadingUnreconciled, setLoadingUnreconciled] = useState(false);

  // ── Fetch Chargily config ──
  const fetchConfig = useCallback(async () => {
    setLoadingConfig(true);
    try {
      const res = await apiFetch('/api/settings/category/payment');
      if (res.ok) {
        const data = await res.json();
        const settings: Record<string, string> = {};
        if (Array.isArray(data.data)) {
          for (const s of data.data) {
            // Don't show encrypted values as-is (they are masked)
            settings[s.key] = s.encrypted ? '' : (s.value || '');
          }
        }
        setConfig({
          chargily_api_key: settings.chargily_api_key || '',
          chargily_secret_key: settings.chargily_secret_key || '',
          chargily_mode: settings.chargily_mode || 'sandbox',
        });
      }
    } catch {
      // Config may not exist yet — that's OK
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  // ── Save Chargily config ──
  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const settings = [
        {
          key: 'chargily_api_key',
          value: config.chargily_api_key,
          encrypted: true,
          category: 'payment',
          description: 'Chargily API key for payment processing',
          valueType: 'string',
        },
        {
          key: 'chargily_secret_key',
          value: config.chargily_secret_key,
          encrypted: true,
          category: 'payment',
          description: 'Chargily secret key for webhook verification',
          valueType: 'string',
        },
        {
          key: 'chargily_mode',
          value: config.chargily_mode,
          encrypted: false,
          category: 'payment',
          description: 'Chargily mode: sandbox or live',
          valueType: 'string',
        },
      ];

      const res = await apiFetch('/api/settings/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        toast.success('Chargily configuration saved');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to save configuration');
      }
    } catch {
      toast.error('Failed to save configuration');
    } finally {
      setSavingConfig(false);
    }
  };

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
        // Refresh the report
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

  // ── Copy webhook URL ──
  const copyWebhookUrl = () => {
    const url = `${window.location.origin}/api/payment/webhook`;
    navigator.clipboard.writeText(url);
    toast.success('Webhook URL copied to clipboard');
  };

  // ── Initial load ──
  useEffect(() => {
    fetchConfig();
    fetchUnreconciled();
    fetchReport(reconDate);
  }, [fetchConfig, fetchUnreconciled, fetchReport, reconDate]);

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
    <div className="space-y-6">
      {/* ─── Header ─── */}
      <motion.div {...fadeUp}>
        <Card className="overflow-hidden border-0 shadow-lg bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30">
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 rounded-xl bg-emerald-600 text-white">
                <CreditCard className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">
                  {t('dualFinancialEngine')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('paymentEngineDesc')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Main Tabs ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.1 }}>
        <Tabs defaultValue="chargily" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chargily" className="gap-2">
              <Settings className="h-4 w-4" />
              {t('chargilyConfig')}
            </TabsTrigger>
            <TabsTrigger value="reconciliation" className="gap-2">
              <Calendar className="h-4 w-4" />
              {t('reconciliation')}
            </TabsTrigger>
            <TabsTrigger value="transactions" className="gap-2">
              <FileText className="h-4 w-4" />
              {t('transactions')}
            </TabsTrigger>
          </TabsList>

          {/* ─── Chargily Config Tab ─── */}
          <TabsContent value="chargily" className="mt-4 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-emerald-600" />
                  {t('chargilySettings')}
                </CardTitle>
                <CardDescription>
                  {t('chargilySettingsDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {loadingConfig ? (
                  <div className="space-y-3">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : (
                  <>
                    {/* API Key */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <Key className="h-3.5 w-3.5 text-amber-600" />
                        {t('chargilyApiKey')}
                      </Label>
                      <div className="relative">
                        <Input
                          type={showApiKey ? 'text' : 'password'}
                          value={config.chargily_api_key}
                          onChange={(e) => setConfig({ ...config, chargily_api_key: e.target.value })}
                          placeholder="test_sk_xxxxxxxxxxxxx"
                          className="pr-10"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="absolute right-0 top-0 h-full px-3"
                          onClick={() => setShowApiKey(!showApiKey)}
                        >
                          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t('apiKeyHint')}
                      </p>
                    </div>

                    {/* Secret Key */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-rose-600" />
                        {t('chargilySecretKey')}
                      </Label>
                      <div className="relative">
                        <Input
                          type={showSecretKey ? 'text' : 'password'}
                          value={config.chargily_secret_key}
                          onChange={(e) => setConfig({ ...config, chargily_secret_key: e.target.value })}
                          placeholder="whsec_xxxxxxxxxxxxx"
                          className="pr-10"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="absolute right-0 top-0 h-full px-3"
                          onClick={() => setShowSecretKey(!showSecretKey)}
                        >
                          {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t('secretKeyHint')}
                      </p>
                    </div>

                    {/* Mode Toggle */}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
                      <div className="space-y-0.5">
                        <Label className="text-sm font-medium">
                          {t('liveMode')}
                        </Label>
                        <p className="text-[11px] text-muted-foreground">
                          {config.chargily_mode === 'live'
                            ? t('liveModeDesc')
                            : t('sandboxModeDesc')
                          }
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={config.chargily_mode === 'live' ? 'destructive' : 'secondary'} className="text-[10px]">
                          {config.chargily_mode === 'live' ? 'LIVE' : 'SANDBOX'}
                        </Badge>
                        <Switch
                          checked={config.chargily_mode === 'live'}
                          onCheckedChange={(v) => setConfig({ ...config, chargily_mode: v ? 'live' : 'sandbox' })}
                        />
                      </div>
                    </div>

                    <Separator />

                    {/* Save Button */}
                    <Button
                      onClick={saveConfig}
                      disabled={savingConfig}
                      className="w-full bg-emerald-600 hover:bg-emerald-700"
                    >
                      {savingConfig ? (
                        <Loader2 className="h-4 w-4 animate-spin me-2" />
                      ) : (
                        <Save className="h-4 w-4 me-2" />
                      )}
                      {t('saveConfiguration')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Webhook URL Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Link className="h-4 w-4 text-blue-600" />
                  {t('webhookConfiguration')}
                </CardTitle>
                <CardDescription>
                  {t('webhookDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border">
                  <code className="text-xs flex-1 break-all font-mono">
                    {typeof window !== 'undefined' ? `${window.location.origin}/api/payment/webhook` : '/api/payment/webhook'}
                  </code>
                  <Button variant="outline" size="sm" onClick={copyWebhookUrl}>
                    <Copy className="h-3.5 w-3.5 me-1" />
                    {t('copy')}
                  </Button>
                </div>
                <div className="mt-3 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-amber-800 dark:text-amber-200">
                      {t('webhookWarning')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── Reconciliation Tab ─── */}
          <TabsContent value="reconciliation" className="mt-4 space-y-4">
            {/* Run Reconciliation */}
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
                      <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 text-center">
                        <DollarSign className="h-5 w-5 text-blue-600 mx-auto mb-1" />
                        <p className="text-sm font-bold text-blue-700 dark:text-blue-400">{formatDZD(reconResult.totalReconciled)}</p>
                        <p className="text-[10px] text-muted-foreground">{t('totalReconciled')}</p>
                      </div>
                    </div>
                  </motion.div>
                )}
              </CardContent>
            </Card>

            {/* Charts */}
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

            {/* Report Summary */}
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
          </TabsContent>

          {/* ─── Transactions Tab ─── */}
          <TabsContent value="transactions" className="mt-4 space-y-4">
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
          </TabsContent>
        </Tabs>
      </motion.div>
    </div>
  );
}


