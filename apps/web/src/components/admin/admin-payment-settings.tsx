'use client';

/**
 * Unified Payment Settings page (r21-6).
 *
 * Replaces TWO former platform-settings pages with ONE sidebar entry:
 *   - admin-payment-gateway-settings.tsx ("Payment Gateway" — manual CCP /
 *     bank / e-wallet receipt settings) → now the "Transfers" tab.
 *   - admin-payment-engine.tsx ("Financial Engine" — Chargily keys + tests +
 *     ECCP reconciliation) → now the "Gateways" tab + the embedded
 *     reconciliation panel (admin-payment-reconciliation.tsx).
 *
 * The old components remain on disk (dead routes, no sidebar entries) but
 * are no longer reachable from the admin sidebar / settings hub.
 *
 * Tabs:
 *   1. Gateways (البوابات الإلكترونية) — Chargily enable toggle
 *      (SystemSetting chargily_enabled, category 'payment'), sandbox/live
 *      mode, masked API/secret keys (keep-empty-on-save), TEST CONNECTION
 *      (GET /api/payment/test) + TEST CHECKOUT (GET /api/payment/test-checkout)
 *      probes with inline success/failure badges, webhook URL card.
 *   2. Transfers (حوالات البريد والبنك) — CCP (enable, RIP, key, holder name,
 *      address), Bank (enable, name, account, RIB, holder name, address),
 *      BaridiMob (enable, number) and the legacy e-wallet — all persisted
 *      through PUT /api/admin/payment-settings and displayed to agencies in
 *      the subscription payment dialog via the public GET /api/payment-settings.
 *   3. Reconciliation — the ECCP payment reconciliation report + run +
 *      unreconciled transactions (lifted panel).
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
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Wallet,
  CreditCard,
  Building2,
  Landmark,
  Smartphone,
  Loader2,
  Save,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Shield,
  Zap,
  Key,
  Link,
  Copy,
  Info,
  Calendar,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { AdminSettingsSectionPage } from '@/components/admin/admin-settings-section-page';
import { AdminPaymentReconciliation } from '@/components/admin/admin-payment-reconciliation';

const fadeUp = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3 },
};

// ─── Chargily gateway config (SystemSetting rows, category 'payment') ──────

interface ChargilyConfig {
  chargily_api_key: string;
  chargily_secret_key: string;
  chargily_mode: string;
  chargily_enabled: boolean;
}

// Which encrypted keys already have a value stored on the server.
// (The API masks encrypted values, so the client can never read them back —
// it can only know THAT they exist, not WHAT they are.)
interface SavedKeyFlags {
  chargily_api_key: boolean;
  chargily_secret_key: boolean;
}

// ─── Manual transfer settings (PaymentSettings singleton) ──────────────────

interface TransferSettings {
  ccpEnabled: boolean;
  ccpAccount: string;
  ccpKey: string;
  ccpHolderName: string;
  ccpAddress: string;
  bankEnabled: boolean;
  bankName: string;
  bankAccount: string;
  bankRib: string;
  bankHolderName: string;
  bankAddress: string;
  electronicEnabled: boolean;
  ewalletNumber: string;
  baridiMobEnabled: boolean;
  baridiMobNumber: string;
}

const EMPTY_TRANSFERS: TransferSettings = {
  ccpEnabled: false,
  ccpAccount: '',
  ccpKey: '',
  ccpHolderName: '',
  ccpAddress: '',
  bankEnabled: false,
  bankName: '',
  bankAccount: '',
  bankRib: '',
  bankHolderName: '',
  bankAddress: '',
  electronicEnabled: false,
  ewalletNumber: '',
  baridiMobEnabled: false,
  baridiMobNumber: '',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function AdminPaymentSettings() {
  const { t } = useLanguage();

  // ── Gateway (Chargily) state ──
  const [config, setConfig] = useState<ChargilyConfig>({
    chargily_api_key: '',
    chargily_secret_key: '',
    chargily_mode: 'sandbox',
    chargily_enabled: true,
  });
  const [savedKeys, setSavedKeys] = useState<SavedKeyFlags>({
    chargily_api_key: false,
    chargily_secret_key: false,
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Test-connection state (GET /api/payment/test — super admin only)
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Test-checkout state (GET /api/payment/test-checkout — full creation probe)
  const [testingCheckout, setTestingCheckout] = useState(false);
  const [checkoutTestResult, setCheckoutTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Transfer settings state ──
  const [paymentSettings, setPaymentSettings] = useState<TransferSettings>(EMPTY_TRANSFERS);
  const [savingPayment, setSavingPayment] = useState(false);

  // ── Fetch Chargily config (GET /api/settings/category/payment) ──
  const fetchConfig = useCallback(async () => {
    setLoadingConfig(true);
    try {
      const res = await apiFetch('/api/settings/category/payment');
      if (res.ok) {
        const body = await res.json();
        // apiFetch/apiClient UNWRAPS the {success, data} envelope — the
        // settings array is either `body` directly or `body.data`.
        const list: Array<{ key: string; value?: string; encrypted?: boolean }> = Array.isArray(body)
          ? body
          : Array.isArray((body as { data?: unknown[] })?.data)
            ? (body as { data: Array<{ key: string; value?: string; encrypted?: boolean }> }).data
            : [];
        const settings: Record<string, string> = {};
        const hasValue: Record<string, boolean> = {};
        for (const s of list) {
          // Encrypted values are masked server-side ("••••••••") — we can't
          // show them, but we REMEMBER that they exist so the UI can display
          // a "saved" state and Save never wipes them with an empty string.
          hasValue[s.key] = Boolean(s.encrypted || (s.value && s.value.trim() !== ''));
          settings[s.key] = s.encrypted ? '' : (s.value || '');
        }
        // Fresh config object from the server: never pre-fill encrypted keys
        // (masked → ''), keep the mode + enable flag. Absent
        // chargily_enabled row → enabled (server default, backward compat).
        setConfig({
          chargily_api_key: '',
          chargily_secret_key: '',
          chargily_mode: settings.chargily_mode || 'sandbox',
          chargily_enabled: settings.chargily_enabled !== 'false',
        });
        setSavedKeys({
          chargily_api_key: Boolean(hasValue.chargily_api_key),
          chargily_secret_key: Boolean(hasValue.chargily_secret_key),
        });
      }
    } catch {
      toast.error('Failed to load gateway configuration');
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  // ── Save Chargily config ──
  // CRITICAL: empty encrypted fields are NOT sent — otherwise reloading the
  // page (fields blank because values are masked) and pressing Save would
  // silently WIPE the stored keys. Only fields the admin actually typed are
  // written; mode + the enable flag are always sent (they are not sensitive).
  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const settings: Array<{
        key: string;
        value: string;
        encrypted?: boolean;
        category?: string;
        description?: string;
        valueType?: string;
      }> = [];

      if (config.chargily_api_key.trim() !== '') {
        settings.push({
          key: 'chargily_api_key',
          value: config.chargily_api_key.trim(),
          encrypted: true,
          category: 'payment',
          description: 'Chargily API key for payment processing',
          valueType: 'string',
        });
      }

      if (config.chargily_secret_key.trim() !== '') {
        settings.push({
          key: 'chargily_secret_key',
          value: config.chargily_secret_key.trim(),
          encrypted: true,
          category: 'payment',
          description: 'Chargily secret key for webhook verification',
          valueType: 'string',
        });
      }

      settings.push({
        key: 'chargily_mode',
        value: config.chargily_mode,
        encrypted: false,
        category: 'payment',
        description: 'Chargily mode: sandbox or live',
        valueType: 'string',
      });

      // r21-6 — master enable switch. 'true'/'false' string (SystemSetting
      // valueType 'boolean'); absent row means enabled (server default).
      settings.push({
        key: 'chargily_enabled',
        value: config.chargily_enabled ? 'true' : 'false',
        encrypted: false,
        category: 'payment',
        description: 'Chargily gateway master switch (enable/disable without deleting keys)',
        valueType: 'boolean',
      });

      const res = await apiFetch('/api/settings/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        toast.success(t('chargilySavedKeep'));
        // Reflect the new "saved" state + clear the typed values (they are
        // now stored masked — leaving them visible would be misleading).
        setSavedKeys({
          chargily_api_key: savedKeys.chargily_api_key || config.chargily_api_key.trim() !== '',
          chargily_secret_key: savedKeys.chargily_secret_key || config.chargily_secret_key.trim() !== '',
        });
        setConfig((prev) => ({
          chargily_api_key: '',
          chargily_secret_key: '',
          chargily_mode: prev.chargily_mode,
          chargily_enabled: prev.chargily_enabled,
        }));
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

  // ── Test the Chargily connection (validates the saved keys) ──
  const testConnection = async () => {
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/payment/test');
      const body = await res.json().catch(() => null);
      // apiFetch/apiClient UNWRAPS the {success, data} envelope — accept both
      // the unwrapped data object (has `mode`) and the full envelope.
      const info = (
        body && typeof body === 'object' && 'mode' in body
          ? body
          : (body as { data?: { mode?: string; dzdBalance?: number | null } })?.data
      ) || {};
      if (res.ok && info.mode) {
        let message = `${t('chargilyTestOk')} ${info.mode === 'live' ? 'live' : 'sandbox'}`;
        if (info.dzdBalance !== null && info.dzdBalance !== undefined) {
          // Chargily reports the balance in centimes.
          message += ` · ${t('chargilyBalanceLabel')}: ${(info.dzdBalance / 100).toLocaleString()} DZD`;
        }
        setTestResult({ ok: true, message });
        toast.success(t('connectionOk'));
      } else {
        const bodyErr = body as { error?: string; details?: string };
        const error = bodyErr?.error || 'Connection test failed';
        // Surface Chargily's own answer (status + body) so the admin sees WHY.
        const details = bodyErr?.details ? `\n${bodyErr.details.slice(0, 300)}` : '';
        setTestResult({ ok: false, message: `${error}${details}` });
        toast.error(`${t('connectionFailed')} — ${error}`);
      }
    } catch {
      setTestResult({ ok: false, message: t('connectionFailed') });
      toast.error(t('connectionFailed'));
    } finally {
      setTestingConnection(false);
    }
  };

  // ── Full checkout-creation probe (exercises the REAL payment path) ──
  const testCheckout = async () => {
    setTestingCheckout(true);
    setCheckoutTestResult(null);
    try {
      const res = await apiFetch('/api/payment/test-checkout');
      const body = await res.json().catch(() => null);
      const info = (
        body && typeof body === 'object' && 'mode' in body
          ? body
          : (body as { data?: { mode?: string; amountEchoed?: number; expired?: boolean } })?.data
      ) || {};
      if (res.ok && info.mode) {
        // Chargily amounts are in centimes (echo included).
        const echoed = typeof info.amountEchoed === 'number' ? (info.amountEchoed / 100).toLocaleString() : null;
        let message = `${t('testCheckoutOk')} — ${info.mode === 'live' ? 'live' : 'sandbox'}`;
        if (echoed !== null) message += ` · ${echoed} DZD`;
        setCheckoutTestResult({ ok: true, message });
        toast.success(t('testCheckout'));
      } else {
        const bodyErr = body as { error?: string; details?: string };
        const error = bodyErr?.error || t('testCheckoutFailed');
        const details = bodyErr?.details ? `\n${bodyErr.details.slice(0, 300)}` : '';
        setCheckoutTestResult({ ok: false, message: `${error}${details}` });
        toast.error(`${t('testCheckoutFailed')} — ${error}`);
      }
    } catch {
      setCheckoutTestResult({ ok: false, message: t('testCheckoutFailed') });
      toast.error(t('testCheckoutFailed'));
    } finally {
      setTestingCheckout(false);
    }
  };

  // ── Copy webhook URL ──
  const copyWebhookUrl = () => {
    const url = `${window.location.origin}/api/payment/webhook`;
    navigator.clipboard.writeText(url);
    toast.success('Webhook URL copied to clipboard');
  };

  // ── Transfer settings (GET/PUT /api/admin/payment-settings) ──
  const fetchPaymentSettings = async () => {
    try {
      const res = await apiFetch('/api/admin/payment-settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setPaymentSettings({
            ccpEnabled: data.settings.ccpEnabled || false,
            ccpAccount: data.settings.ccpAccount || '',
            ccpKey: data.settings.ccpKey || '',
            ccpHolderName: data.settings.ccpHolderName || '',
            ccpAddress: data.settings.ccpAddress || '',
            bankEnabled: data.settings.bankEnabled || false,
            bankName: data.settings.bankName || '',
            bankAccount: data.settings.bankAccount || '',
            bankRib: data.settings.bankRib || '',
            bankHolderName: data.settings.bankHolderName || '',
            bankAddress: data.settings.bankAddress || '',
            electronicEnabled: data.settings.electronicEnabled || false,
            ewalletNumber: data.settings.ewalletNumber || '',
            baridiMobEnabled: data.settings.baridiMobEnabled || false,
            baridiMobNumber: data.settings.baridiMobNumber || '',
          });
        }
      }
    } catch {
      // silent fail
    }
  };

  const savePaymentSettings = async () => {
    setSavingPayment(true);
    try {
      const res = await apiFetch('/api/admin/payment-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(paymentSettings),
      });
      if (res.ok) {
        toast.success(t('paymentSaved'));
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSavingPayment(false);
    }
  };

  // ── Initial load ──
  useEffect(() => {
    fetchConfig();
    fetchPaymentSettings();
  }, [fetchConfig]);

  return (
    <AdminSettingsSectionPage icon={Wallet} titleKey="settingsPaymentCenter" descKey="settingsPaymentCenterDesc">
      <motion.div {...fadeUp}>
        <Tabs defaultValue="gateways" className="w-full">
          <TabsList className="grid w-full grid-cols-3 mb-4">
            <TabsTrigger value="gateways" className="gap-2 text-xs sm:text-sm">
              <CreditCard className="h-4 w-4" />
              {t('paymentGatewaysTab')}
            </TabsTrigger>
            <TabsTrigger value="transfers" className="gap-2 text-xs sm:text-sm">
              <Landmark className="h-4 w-4" />
              {t('paymentTransfersTab')}
            </TabsTrigger>
            <TabsTrigger value="reconciliation" className="gap-2 text-xs sm:text-sm">
              <Calendar className="h-4 w-4" />
              {t('reconciliation')}
            </TabsTrigger>
          </TabsList>

          {/* ═══ Tab 1 — Electronic Gateways (Chargily) ═══ */}
          <TabsContent value="gateways" className="mt-2 space-y-4">
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
                    {/* Master enable switch (r21-6) — turn the gateway off
                        without deleting the encrypted keys. */}
                    <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-800/30">
                      <div className="space-y-0.5">
                        <Label className="text-sm font-medium">
                          {t('chargilyEnabled')}
                        </Label>
                        <p className="text-[11px] text-muted-foreground">
                          {t('chargilyEnabledDesc')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={config.chargily_enabled ? 'default' : 'secondary'}
                          className={`text-[10px] ${config.chargily_enabled ? 'bg-emerald-600' : ''}`}
                        >
                          {config.chargily_enabled ? t('chargilyOn') : t('chargilyOff')}
                        </Badge>
                        <Switch
                          checked={config.chargily_enabled}
                          onCheckedChange={(v) => setConfig({ ...config, chargily_enabled: v })}
                        />
                      </div>
                    </div>

                    {/* API Key */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <Key className="h-3.5 w-3.5 text-amber-600" />
                        {t('chargilyApiKey')}
                        {savedKeys.chargily_api_key && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-900/10"
                          >
                            <CheckCircle2 className="h-3 w-3 me-1" />
                            {t('keySavedBadge')}
                          </Badge>
                        )}
                      </Label>
                      <div className="relative">
                        <Input
                          type={showApiKey ? 'text' : 'password'}
                          value={config.chargily_api_key}
                          onChange={(e) => setConfig({ ...config, chargily_api_key: e.target.value })}
                          placeholder={savedKeys.chargily_api_key ? t('savedKeyPlaceholder') : 'test_sk_xxxxxxxxxxxxx'}
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
                      {config.chargily_api_key.includes('pk_') && (
                        <p className="text-[11px] font-medium text-red-600 dark:text-red-400">
                          {t('chargilyPublicKeyWarning')}
                        </p>
                      )}
                    </div>

                    {/* Secret Key */}
                    <div className="space-y-2">
                      <Label className="text-sm font-medium flex items-center gap-2">
                        <Shield className="h-3.5 w-3.5 text-rose-600" />
                        {t('chargilySecretKey')}
                        {savedKeys.chargily_secret_key && (
                          <Badge
                            variant="outline"
                            className="text-[10px] border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-900/10"
                          >
                            <CheckCircle2 className="h-3 w-3 me-1" />
                            {t('keySavedBadge')}
                          </Badge>
                        )}
                      </Label>
                      <div className="relative">
                        <Input
                          type={showSecretKey ? 'text' : 'password'}
                          value={config.chargily_secret_key}
                          onChange={(e) => setConfig({ ...config, chargily_secret_key: e.target.value })}
                          placeholder={savedKeys.chargily_secret_key ? t('savedKeyPlaceholder') : 'test_sk_xxxxxxxxxxxxx'}
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
                      {config.chargily_secret_key.includes('pk_') && (
                        <p className="text-[11px] font-medium text-red-600 dark:text-red-400">
                          {t('chargilyPublicKeyWarning')}
                        </p>
                      )}
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

                    {/* Save + Test connection + Test checkout buttons */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <Button
                        onClick={saveConfig}
                        disabled={savingConfig}
                        className="bg-emerald-600 hover:bg-emerald-700"
                      >
                        {savingConfig ? (
                          <Loader2 className="h-4 w-4 animate-spin me-2" />
                        ) : (
                          <Save className="h-4 w-4 me-2" />
                        )}
                        {t('saveConfiguration')}
                      </Button>
                      <Button
                        onClick={testConnection}
                        disabled={testingConnection}
                        variant="outline"
                        className="border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                      >
                        {testingConnection ? (
                          <Loader2 className="h-4 w-4 animate-spin me-2" />
                        ) : (
                          <Zap className="h-4 w-4 me-2" />
                        )}
                        {t('testConnection')}
                      </Button>
                      <Button
                        onClick={testCheckout}
                        disabled={testingCheckout}
                        variant="outline"
                        className="border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                      >
                        {testingCheckout ? (
                          <Loader2 className="h-4 w-4 animate-spin me-2" />
                        ) : (
                          <CreditCard className="h-4 w-4 me-2" />
                        )}
                        {t('testCheckout')}
                      </Button>
                    </div>

                    {/* Test result (green/red inline badge) */}
                    {testResult && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex items-start gap-2 p-2.5 rounded-lg border text-[11px] leading-relaxed ${
                          testResult.ok
                            ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-200'
                            : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30 text-red-800 dark:text-red-200'
                        }`}
                        dir="auto"
                      >
                        {testResult.ok ? (
                          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
                        ) : (
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />
                        )}
                        <span className="whitespace-pre-line">{testResult.message}</span>
                      </motion.div>
                    )}

                    {/* Checkout-creation probe result */}
                    {checkoutTestResult && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex items-start gap-2 p-2.5 rounded-lg border text-[11px] leading-relaxed ${
                          checkoutTestResult.ok
                            ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800/30 text-emerald-800 dark:text-emerald-200'
                            : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/30 text-red-800 dark:text-red-200'
                        }`}
                        dir="auto"
                      >
                        {checkoutTestResult.ok ? (
                          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
                        ) : (
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />
                        )}
                        <span className="whitespace-pre-line">{checkoutTestResult.message}</span>
                      </motion.div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Webhook URL Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Link className="h-4 w-4 text-teal-600" />
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
                {/* Optional webhook note — payments settle without it too */}
                <div className="mt-2 p-2.5 rounded-lg bg-muted/30 border border-dashed">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                    <p className="text-[11px] text-muted-foreground">
                      {t('webhookOptionalNote')}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ═══ Tab 2 — Mail & Bank Transfers ═══ */}
          <TabsContent value="transfers" className="mt-2 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-emerald-600" />
                  {t('paymentTransfersSettings')}
                </CardTitle>
                <CardDescription>
                  {t('paymentTransfersSettingsDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent className="pt-0 space-y-5">
                {/* CCP Section */}
                <div className="space-y-3 p-3 rounded-xl bg-teal-50/50 dark:bg-teal-900/10 border border-teal-100 dark:border-teal-800/30">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 text-teal-600" />
                      {t('ccpEnabled')}
                    </Label>
                    <Switch
                      checked={paymentSettings.ccpEnabled}
                      onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, ccpEnabled: v })}
                    />
                  </div>
                  {paymentSettings.ccpEnabled && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('ccpAccount')}</Label>
                        <Input
                          value={paymentSettings.ccpAccount}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, ccpAccount: e.target.value })}
                          placeholder="0000000000"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('ccpKey')}</Label>
                        <Input
                          value={paymentSettings.ccpKey}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, ccpKey: e.target.value })}
                          placeholder="00"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('ccpHolderName')}</Label>
                        <Input
                          value={paymentSettings.ccpHolderName}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, ccpHolderName: e.target.value })}
                          placeholder={t('holderNamePlaceholder')}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('ccpAddress')}</Label>
                        <Input
                          value={paymentSettings.ccpAddress}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, ccpAddress: e.target.value })}
                          placeholder={t('holderAddressPlaceholder')}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Bank Section */}
                <div className="space-y-3 p-3 rounded-xl bg-green-50/50 dark:bg-green-900/10 border border-green-100 dark:border-green-800/30">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 text-green-600" />
                      {t('bankEnabled')}
                    </Label>
                    <Switch
                      checked={paymentSettings.bankEnabled}
                      onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, bankEnabled: v })}
                    />
                  </div>
                  {paymentSettings.bankEnabled && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('bankName')}</Label>
                        <Input
                          value={paymentSettings.bankName}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, bankName: e.target.value })}
                          placeholder="BNA"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('bankAccount')}</Label>
                        <Input
                          value={paymentSettings.bankAccount}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, bankAccount: e.target.value })}
                          placeholder="0000000000"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('bankRib')}</Label>
                        <Input
                          value={paymentSettings.bankRib}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, bankRib: e.target.value })}
                          placeholder="00000000000000000000"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-muted-foreground">{t('bankHolderName')}</Label>
                        <Input
                          value={paymentSettings.bankHolderName}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, bankHolderName: e.target.value })}
                          placeholder={t('holderNamePlaceholder')}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label className="text-[10px] text-muted-foreground">{t('bankAddress')}</Label>
                        <Input
                          value={paymentSettings.bankAddress}
                          onChange={(e) => setPaymentSettings({ ...paymentSettings, bankAddress: e.target.value })}
                          placeholder={t('holderAddressPlaceholder')}
                          className="h-8 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* BaridiMob Section (r21-6) */}
                <div className="space-y-3 p-3 rounded-xl bg-sky-50/50 dark:bg-sky-900/10 border border-sky-100 dark:border-sky-800/30">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-2">
                      <Smartphone className="h-3.5 w-3.5 text-sky-600" />
                      {t('baridiMobEnabled')}
                    </Label>
                    <Switch
                      checked={paymentSettings.baridiMobEnabled}
                      onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, baridiMobEnabled: v })}
                    />
                  </div>
                  {paymentSettings.baridiMobEnabled && (
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">{t('baridiMobNumber')}</Label>
                      <Input
                        value={paymentSettings.baridiMobNumber}
                        onChange={(e) => setPaymentSettings({ ...paymentSettings, baridiMobNumber: e.target.value })}
                        placeholder="00799999 0000000000 00"
                        className="h-8 text-xs"
                      />
                    </div>
                  )}
                </div>

                {/* E-Wallet Section (kept from the retired gateway page —
                    electronicEnabled/ewalletNumber stay manageable) */}
                <div className="space-y-3 p-3 rounded-xl bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-800/30">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-2">
                      <CreditCard className="h-3.5 w-3.5 text-purple-600" />
                      {t('electronicEnabled')}
                    </Label>
                    <Switch
                      checked={paymentSettings.electronicEnabled}
                      onCheckedChange={(v) => setPaymentSettings({ ...paymentSettings, electronicEnabled: v })}
                    />
                  </div>
                  {paymentSettings.electronicEnabled && (
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">{t('ewalletNumber')}</Label>
                      <Input
                        value={paymentSettings.ewalletNumber}
                        onChange={(e) => setPaymentSettings({ ...paymentSettings, ewalletNumber: e.target.value })}
                        placeholder={t('phonePlaceholder')}
                        className="h-8 text-xs"
                      />
                    </div>
                  )}
                </div>

                {/* Save button */}
                <Button onClick={savePaymentSettings} disabled={savingPayment} className="w-full h-9 text-xs bg-emerald-600 hover:bg-emerald-700">
                  {savingPayment ? <Loader2 className="h-3.5 w-3.5 animate-spin me-2" /> : <Save className="h-3.5 w-3.5 me-2" />}
                  {t('save')}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ═══ Tab 3 — Reconciliation (lifted from the old engine page) ═══ */}
          <TabsContent value="reconciliation" className="mt-2">
            <AdminPaymentReconciliation />
          </TabsContent>
        </Tabs>
      </motion.div>
    </AdminSettingsSectionPage>
  );
}
