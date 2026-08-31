'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Settings,
  MessageSquare,
  RefreshCw,
  Loader2,
  Send,
  Save,
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  Shield,
  Clock,
  Calendar,
  TrendingUp,
  AlertTriangle,
  Zap,
  Phone,
  Globe,
  Key,
  Hash,
  FileText,
  Info,
  CheckCircle2,
  XCircle,
  CreditCard,
  Building2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { AdminFaqManager } from '@/components/admin/admin-faq-manager';
import { SystemSettingsConfig } from '@/components/admin/admin-settings-config';
import { AdminPaymentEngine } from '@/components/admin/admin-payment-engine';
import { translateStatus } from '@/lib/enum-i18n';

// ─── Interfaces (shared with admin-dashboard) ─────────────────────
interface SmsSettingsData {
  id: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  senderName: string;
  enabled: boolean;
  smsPerReminder: number;
  maxSmsPerDay: number;
  testPhoneNumber: string | null;
  templateTurnApproaching: string;
  templateYourTurn: string;
  templateNoShow: string;
  templateCustom: string;
  updatedAt: string;
  createdAt: string;
}

interface SmsProviderInfo {
  id: string;
  name: string;
  description: string;
  defaultApiUrl: string;
  senderIdSupport: boolean;
  docsUrl: string;
}

interface SmsUsageStats {
  sentToday: number;
  sentThisWeek: number;
  sentThisMonth: number;
  totalSent: number;
  failedToday: number;
}

interface SmsLogItem {
  id: string;
  phoneNumber: string;
  message: string;
  status: string;
  provider: string;
  errorMessage: string | null;
  createdAt: string;
}

// ─── Default fallback providers ────────────────────────────────────
const DEFAULT_PROVIDERS: SmsProviderInfo[] = [
  { id: 'winsms', name: 'WinSMS', description: 'Algerian SMS provider - winsms.dz', defaultApiUrl: 'https://api.winsms.dz/v1', senderIdSupport: true, docsUrl: 'https://winsms.dz/docs' },
  { id: 'notifsend', name: 'NotifSend', description: 'Algerian notification service - notifsend.com', defaultApiUrl: 'https://api.notifsend.com/v1', senderIdSupport: true, docsUrl: 'https://notifsend.com/docs' },
  { id: 'algeria_sms', name: 'Algeria SMS', description: 'Algeria-focused SMS gateway - algeria-sms.com', defaultApiUrl: 'https://api.algeria-sms.com/v1', senderIdSupport: false, docsUrl: 'https://algeria-sms.com/docs' },
  { id: 'green_send', name: 'GreenSMS', description: 'Moroccan SMS provider - greensms.ma', defaultApiUrl: 'https://api.greensms.ma/v1', senderIdSupport: true, docsUrl: 'https://greensms.ma/docs' },
  { id: 'mtarget', name: 'M-Target', description: 'Algerian SMS provider - mtarget.dz', defaultApiUrl: 'https://api.mtarget.dz/v1', senderIdSupport: false, docsUrl: 'https://mtarget.dz/docs' },
  { id: 'twilio', name: 'Twilio', description: 'Global cloud communications platform - twilio.com', defaultApiUrl: 'https://api.twilio.com/2010-04-01', senderIdSupport: true, docsUrl: 'https://www.twilio.com/docs/sms' },
  { id: 'vonage', name: 'Vonage / Nexmo', description: 'Global communications API - vonage.com', defaultApiUrl: 'https://rest.nexmo.com/sms/json', senderIdSupport: true, docsUrl: 'https://developer.vonage.com/messaging/sms' },
  { id: 'generic', name: 'Generic API', description: 'Custom HTTP API endpoint for any SMS gateway', defaultApiUrl: '', senderIdSupport: true, docsUrl: '' },
];

// ─── Animation variants ───────────────────────────────────────────
const fadeUp = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0 },
};

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.06 } },
};

const staggerItem = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
};

// ─── Component ─────────────────────────────────────────────────────
export function AdminSettings() {
  const { setView } = useAppStore();
  const { t, lang } = useLanguage();

  // ── State ──
  const [loading, setLoading] = useState(true);
  const [smsSettings, setSmsSettings] = useState<SmsSettingsData | null>(null);
  const [smsStats, setSmsStats] = useState<SmsUsageStats | null>(null);
  const [smsLogs, setSmsLogs] = useState<SmsLogItem[]>([]);
  const [smsProviders, setSmsProviders] = useState<SmsProviderInfo[]>(DEFAULT_PROVIDERS);
  const [showApiKey, setShowApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [paymentSettings, setPaymentSettings] = useState<{
    ccpEnabled: boolean; bankEnabled: boolean; electronicEnabled: boolean;
    ccpAccount: string; ccpKey: string; bankName: string;
    bankAccount: string; bankRib: string; ewalletNumber: string;
  }>({ ccpEnabled: false, bankEnabled: false, electronicEnabled: false, ccpAccount: '', ccpKey: '', bankName: '', bankAccount: '', bankRib: '', ewalletNumber: '' });
  const [savingPayment, setSavingPayment] = useState(false);

  // ── Fetch on mount ──
  useEffect(() => {
    fetchSettings();
    fetchPaymentSettings();
  }, []);

  // ── Data fetching ──
  const fetchSettings = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings');
      if (res.ok) {
        const data = await res.json();
        setSmsSettings(data.settings);
        setSmsStats(data.stats);
        setSmsLogs(data.recentLogs ?? []);
        if (data.providers && data.providers.length > 0) {
          setSmsProviders(data.providers);
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // ── Handlers ──
  const handleSave = async () => {
    if (!smsSettings) return;
    setSaving(true);
    try {
      // Don't send masked API key — keep old value on server
      const apiKeyToSend = smsSettings.apiKey.includes('••••') ? undefined : smsSettings.apiKey;
      const res = await apiFetch('/api/admin/sms-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: smsSettings.provider,
          apiUrl: smsSettings.apiUrl,
          apiKey: apiKeyToSend,
          senderName: smsSettings.senderName,
          enabled: smsSettings.enabled,
          smsPerReminder: smsSettings.smsPerReminder,
          maxSmsPerDay: smsSettings.maxSmsPerDay,
          testPhoneNumber: smsSettings.testPhoneNumber,
          templateTurnApproaching: smsSettings.templateTurnApproaching,
          templateYourTurn: smsSettings.templateYourTurn,
          templateNoShow: smsSettings.templateNoShow,
          templateCustom: smsSettings.templateCustom,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSmsSettings(data.settings);
        toast.success(t('smsSaved'));
      } else {
        toast.error(t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSaving(false);
    }
  };

  const handleTestSms = async () => {
    if (!smsSettings?.testPhoneNumber) {
      toast.error(t('smsTestPhoneRequired'));
      return;
    }
    setTestLoading(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: smsSettings.testPhoneNumber }),
      });
      if (res.ok) {
        toast.success(t('smsTestSent'));
        fetchSettings(true);
      } else {
        const data = await res.json();
        toast.error(data.error || t('smsTestFailed'));
      }
    } catch {
      toast.error(t('smsTestFailed'));
    } finally {
      setTestLoading(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate' }),
      });
      const data = await res.json();
      if (data.valid) {
        toast.success(t('smsGatewayValid'));
      } else {
        toast.error(data.error || t('smsTestFailed'));
      }
    } catch {
      toast.error(t('smsTestFailed'));
    } finally {
      setValidating(false);
    }
  };

  // ── Payment settings ──
  const fetchPaymentSettings = async () => {
    try {
      const res = await apiFetch('/api/admin/payment-settings');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setPaymentSettings({
            ccpEnabled: data.settings.ccpEnabled || false,
            bankEnabled: data.settings.bankEnabled || false,
            electronicEnabled: data.settings.electronicEnabled || false,
            ccpAccount: data.settings.ccpAccount || '',
            ccpKey: data.settings.ccpKey || '',
            bankName: data.settings.bankName || '',
            bankAccount: data.settings.bankAccount || '',
            bankRib: data.settings.bankRib || '',
            ewalletNumber: data.settings.ewalletNumber || '',
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

  const handleProviderChange = (providerId: string) => {
    if (!smsSettings) return;
    const provider = smsProviders.find((p) => p.id === providerId);
    setSmsSettings({
      ...smsSettings,
      provider: providerId,
      apiUrl: provider?.defaultApiUrl || smsSettings.apiUrl,
    });
  };

  // ── Helpers ──
  const formatTime = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString(
        lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      );
    } catch {
      return '';
    }
  };

  const getStatusBadge = (status: string) => {
    const upper = status.toUpperCase();
    if (upper === 'SENT' || upper === 'DELIVERED') {
      return (
        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] font-medium px-1.5 py-0">
          <CheckCircle2 className="h-3 w-3 me-1" />
          {translateStatus(status, t)}
        </Badge>
      );
    }
    if (upper === 'FAILED') {
      return (
        <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] font-medium px-1.5 py-0">
          <XCircle className="h-3 w-3 me-1" />
          {translateStatus(status, t)}
        </Badge>
      );
    }
    return (
      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] font-medium px-1.5 py-0">
        <Clock className="h-3 w-3 me-1" />
        {translateStatus(status, t)}
      </Badge>
    );
  };

  const isApiKeySpecified = smsSettings?.apiKey && !smsSettings.apiKey.includes('••••');

  // ── Loading skeleton ──
  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-5">
        {/* Header skeleton */}
        <Skeleton className="h-24 rounded-2xl skeleton-shimmer" />
        {/* SMS Config skeleton */}
        <Skeleton className="h-96 rounded-2xl skeleton-shimmer" />
        {/* Stats skeleton */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl skeleton-shimmer" />
          ))}
        </div>
        {/* Logs skeleton */}
        <Skeleton className="h-64 rounded-2xl skeleton-shimmer" />
      </div>
    );
  }

  // ── Render ──
  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* ─── Header Banner ─── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden mb-2"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
          </div>
          <div className="relative flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Settings className="h-5 w-5 text-white" />
                </div>
                {t('settings')}
              </h1>
              <p className="text-sm text-emerald-100 mt-1 ms-[52px]">
                {'Platform Settings'}
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-3 py-1">
                <Shield className="h-3 w-3 me-1" />
                {t('superAdmin')}
              </Badge>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ─── SMS Gateway Configuration (PRIMARY) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.1 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
                  <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                {t('smsConfigSection')}
              </CardTitle>
              <div className="flex items-center gap-2">
                {smsSettings?.enabled ? (
                  <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-xs font-medium">
                    <Check className="h-3 w-3 me-1" />
                    {t('smsEnabled')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    {t('smsDisabled')}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => fetchSettings(true)}
                  disabled={refreshing}
                  aria-label={t('refresh')}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{t('smsConfigDesc')}</p>
          </CardHeader>

          <CardContent className="pt-0 space-y-4">
            {smsSettings ? (
              <>
                {/* ── SMS Enable/Disable Toggle ── */}
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                  <div className="flex items-center gap-2.5">
                    <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
                      <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {t('smsNotifToggle')}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`relative flex h-2 w-2`}>
                          {smsSettings.enabled && (
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                          )}
                          <span
                            className={`relative inline-flex rounded-full h-2 w-2 ${
                              smsSettings.enabled ? 'bg-emerald-500' : 'bg-gray-400'
                            }`}
                          />
                        </span>
                        <p className="text-[10px] text-muted-foreground">
                          {smsSettings.enabled ? t('smsEnabled') : t('smsDisabled')}
                        </p>
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={smsSettings.enabled}
                    onCheckedChange={(checked) =>
                      setSmsSettings({ ...smsSettings, enabled: checked })
                    }
                    aria-label={t('smsEnabled')}
                  />
                </div>

                {/* ── Configuration Form ── */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Provider Selector */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Globe className="h-3 w-3" />
                      {t('smsProvider')}
                    </Label>
                    <select
                      value={smsSettings.provider}
                      onChange={(e) => handleProviderChange(e.target.value)}
                      className="h-9 w-full px-3 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-colors"
                      aria-label={t('smsProvider')}
                    >
                      {smsProviders.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id === 'algeria_sms' ? t('smsProviderAlgeriaSmsOption') : p.id === 'generic' ? t('smsProviderGenericOption') : p.name}
                          {p.defaultApiUrl ? ` (${p.id})` : ''}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const prov = smsProviders.find(
                        (p) => p.id === smsSettings.provider
                      );
                      if (!prov) return null;
                      return (
                        <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                          <Info className="h-3 w-3 flex-shrink-0" />
                          {prov.id === 'algeria_sms' ? t('smsProviderAlgeriaSmsDesc') : prov.id === 'generic' ? t('smsProviderGenericDesc') : prov.description}
                          {!prov.senderIdSupport && (
                            <span className="text-amber-600 dark:text-amber-400">
                              {' '}⚠️ Uses phone number as sender
                            </span>
                          )}
                        </p>
                      );
                    })()}
                  </div>

                  {/* Sender Name */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Hash className="h-3 w-3" />
                      {t('smsSenderName')}
                    </Label>
                    <Input
                      value={smsSettings.senderName}
                      onChange={(e) =>
                        setSmsSettings({ ...smsSettings, senderName: e.target.value })
                      }
                      placeholder="BLASTI"
                      className="h-9 text-sm"
                      aria-label={t('smsSenderName')}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      {t('testPhoneNumberDesc')}
                    </p>
                  </div>

                  {/* API URL */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Globe className="h-3 w-3" />
                      {t('smsApiUrl')}
                    </Label>
                    <Input
                      value={smsSettings.apiUrl}
                      onChange={(e) =>
                        setSmsSettings({ ...smsSettings, apiUrl: e.target.value })
                      }
                      placeholder="https://api.example.com/v1"
                      className="h-9 text-sm font-mono"
                      dir="ltr"
                      aria-label={t('smsApiUrl')}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      The API endpoint URL for your SMS provider
                    </p>
                  </div>

                  {/* API Key with show/hide toggle */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Key className="h-3 w-3" />
                      {t('smsApiKey')}
                    </Label>
                    <div className="relative">
                      <Input
                        type={showApiKey ? 'text' : 'password'}
                        value={smsSettings.apiKey}
                        onChange={(e) =>
                          setSmsSettings({ ...smsSettings, apiKey: e.target.value })
                        }
                        placeholder="Enter your API key"
                        className="h-9 text-sm font-mono pe-9"
                        dir="ltr"
                        aria-label={t('smsApiKey')}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute end-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowApiKey(!showApiKey)}
                        aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                        tabIndex={-1}
                      >
                        {showApiKey ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                    {smsSettings.apiKey.includes('••••') && (
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Info className="h-3 w-3 flex-shrink-0" />
                        Leave blank to keep the existing key, or enter a new one to update
                      </p>
                    )}
                  </div>

                  {/* Test Phone Number */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <Phone className="h-3 w-3" />
                      {t('testPhoneNumber')}
                    </Label>
                    <Input
                      value={smsSettings.testPhoneNumber || ''}
                      onChange={(e) =>
                        setSmsSettings({
                          ...smsSettings,
                          testPhoneNumber: e.target.value || null,
                        })
                      }
                      placeholder="+213XXXXXXXXX"
                      className="h-9 text-sm"
                      dir="ltr"
                      aria-label={t('testPhoneNumber')}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      {t('smsPhoneFormatDesc')}
                    </p>
                  </div>

                  {/* SMS per Reminder */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <MessageSquare className="h-3 w-3" />
                      {t('smsPerReminder')}
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={smsSettings.smsPerReminder}
                      onChange={(e) =>
                        setSmsSettings({
                          ...smsSettings,
                          smsPerReminder: Math.max(1, parseInt(e.target.value) || 1),
                        })
                      }
                      className="h-9 text-sm w-full"
                      aria-label={t('smsPerReminder')}
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Number of SMS messages sent per reminder notification
                    </p>
                  </div>

                  {/* Max SMS per Day */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      <AlertTriangle className="h-3 w-3" />
                      {'Max SMS per Day'}
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      max={10000}
                      value={smsSettings.maxSmsPerDay}
                      onChange={(e) =>
                        setSmsSettings({
                          ...smsSettings,
                          maxSmsPerDay: Math.max(1, parseInt(e.target.value) || 1),
                        })
                      }
                      className="h-9 text-sm w-full"
                      aria-label='Max SMS per Day'
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Daily limit for SMS sending across the platform
                    </p>
                  </div>
                </div>

                {/* ── Action Buttons ── */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-2">
                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl h-10 gap-2 flex-1 sm:flex-none"
                    aria-label={t('save')}
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {t('save')}
                  </Button>
                  <Button
                    onClick={handleTestSms}
                    disabled={testLoading || !smsSettings.testPhoneNumber}
                    variant="outline"
                    className="rounded-xl h-10 gap-2 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 flex-1 sm:flex-none"
                    aria-label={t('smsTestSend')}
                  >
                    {testLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    {t('smsTestSend')}
                  </Button>
                  <Button
                    onClick={handleValidate}
                    disabled={validating}
                    variant="outline"
                    className="rounded-xl h-10 gap-2 flex-1 sm:flex-none"
                    aria-label={t('smsValidateConnection')}
                  >
                    {validating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Shield className="h-4 w-4" />
                    )}
                    {t('smsValidateConnection')}
                  </Button>
                </div>

                {/* Last updated info */}
                {smsSettings.updatedAt && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-1">
                    <Clock className="h-3 w-3" />
                    {t('lastUpdated')}: {formatTime(smsSettings.updatedAt)}
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm">
                {t('noData')}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── SMS Usage Statistics ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.2 }}>
        <div className="flex items-center gap-2 mb-3">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
            <TrendingUp className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">
            {t('smsUsageStats')}
          </h2>
        </div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="grid grid-cols-2 lg:grid-cols-4 gap-3"
        >
          {[
            {
              label: t('smsSentToday'),
              value: smsStats?.sentToday ?? 0,
              icon: Clock,
              color: 'bg-emerald-50 dark:bg-emerald-900/20',
              iconBg: 'from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40',
              iconColor: 'text-emerald-600 dark:text-emerald-400',
              dotColor: 'bg-emerald-500',
            },
            {
              label: t('smsSentThisWeek'),
              value: smsStats?.sentThisWeek ?? 0,
              icon: Calendar,
              color: 'bg-teal-50 dark:bg-teal-900/20',
              iconBg: 'from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40',
              iconColor: 'text-teal-600 dark:text-teal-400',
              dotColor: 'bg-teal-500',
            },
            {
              label: t('smsSentThisMonth'),
              value: smsStats?.sentThisMonth ?? 0,
              icon: TrendingUp,
              color: 'bg-amber-50 dark:bg-amber-900/20',
              iconBg: 'from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40',
              iconColor: 'text-amber-600 dark:text-amber-400',
              dotColor: 'bg-amber-500',
            },
            {
              label: t('smsTotalSent'),
              value: smsStats?.totalSent ?? 0,
              icon: MessageSquare,
              color: 'bg-rose-50 dark:bg-rose-900/20',
              iconBg: 'from-rose-200 to-rose-300 dark:from-rose-900/40 dark:to-rose-800/40',
              iconColor: 'text-rose-600 dark:text-rose-400',
              dotColor: 'bg-rose-500',
            },
          ].map((stat, idx) => {
            const Icon = stat.icon;
            return (
              <motion.div
                key={idx}
                variants={staggerItem}
                whileHover={{ scale: 1.03, y: -4 }}
                className="cursor-default"
              >
                <div className="rounded-2xl p-[1px] bg-gradient-to-br from-emerald-200/40 via-transparent to-teal-200/40 dark:from-emerald-700/20 dark:via-transparent dark:to-teal-700/20 group">
                  <Card className="border-0 shadow-sm hover:shadow-xl hover:shadow-emerald-500/8 transition-all duration-300 hover:-translate-y-1 bg-white dark:bg-gray-900/90 rounded-[14px]">
                    <CardContent className={`p-4 rounded-t-[14px] ${stat.color}`}>
                      <div className="flex items-start justify-between mb-2">
                        <div
                          className={`h-9 w-9 rounded-xl bg-gradient-to-br ${stat.iconBg} flex items-center justify-center shadow-sm transition-transform duration-300 group-hover:scale-110`}
                        >
                          <Icon className={`h-4 w-4 ${stat.iconColor}`} />
                        </div>
                        <span
                          className={`h-2 w-2 rounded-full ${stat.dotColor} mt-1.5`}
                        />
                      </div>
                      <p className="text-xl font-bold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
                        {stat.value.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                    </CardContent>
                  </Card>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      </motion.div>

      {/* ─── Recent SMS Logs ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.3 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
                <FileText className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              {t('smsLogs')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {smsLogs.length === 0 ? (
              <div className="text-center py-8">
                <div className="h-12 w-12 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-3">
                  <MessageSquare className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">{t('noSmsLogs')}</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {smsLogs.map((log, idx) => (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className="flex items-start gap-3 p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50 hover:bg-gray-100 dark:hover:bg-gray-900/80 transition-colors"
                  >
                    {/* Status indicator */}
                    <div className="mt-0.5 flex-shrink-0">
                      {(() => {
                        const upper = log.status.toUpperCase();
                        if (upper === 'SENT' || upper === 'DELIVERED') {
                          return (
                            <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                            </div>
                          );
                        }
                        if (upper === 'FAILED') {
                          return (
                            <div className="h-8 w-8 rounded-lg bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                              <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                            </div>
                          );
                        }
                        return (
                          <div className="h-8 w-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                            <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                          </div>
                        );
                      })()}
                    </div>

                    {/* Log details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground font-mono" dir="ltr">
                          {log.phoneNumber}
                        </span>
                        {getStatusBadge(log.status)}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                        {log.message}
                      </p>
                      {log.errorMessage && (
                        <p className="text-[10px] text-red-500 dark:text-red-400 mt-0.5 line-clamp-1">
                          {log.errorMessage}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-muted-foreground">
                          {formatTime(log.createdAt)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">·</span>
                        <span className="text-[10px] text-muted-foreground">
                          {log.provider}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── SMS Provider Quick Guide ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.4 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
                <Info className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
              </div>
              {t('smsProvider')} Quick Guide
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {smsProviders
                .filter((p) => p.id !== 'generic')
                .map((provider) => (
                  <div
                    key={provider.id}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${
                      smsSettings?.provider === provider.id
                        ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200/50 dark:border-emerald-800/30'
                        : 'bg-gray-50 dark:bg-gray-900/50 border-transparent hover:border-border'
                    }`}
                  >
                    <div
                      className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        smsSettings?.provider === provider.id
                          ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40'
                          : 'bg-gray-200 dark:bg-gray-800'
                      }`}
                    >
                      <Globe
                        className={`h-4 w-4 ${
                          smsSettings?.provider === provider.id
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-gray-500 dark:text-gray-400'
                        }`}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground truncate">
                          {provider.id === 'algeria_sms' ? t('smsProviderAlgeriaSms') : provider.id === 'generic' ? t('smsProviderGeneric') : provider.name}
                        </p>
                        {smsSettings?.provider === provider.id && (
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                        )}
                        {!provider.senderIdSupport && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800 flex-shrink-0">
                            No SID
                          </Badge>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground line-clamp-1">
                        {provider.id === 'algeria_sms' ? t('smsProviderAlgeriaSmsDesc') : provider.id === 'generic' ? t('smsProviderGenericDesc') : provider.description}
                      </p>
                    </div>
                    {provider.docsUrl && (
                      <a
                        href={provider.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-7 w-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors flex-shrink-0"
                        aria-label={`View ${provider.name} documentation`}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                ))}
            </div>

            {/* Tip */}
            <div className="flex items-start gap-2 mt-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200/50 dark:border-emerald-800/30">
              <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
              <div className="text-[11px] text-emerald-700 dark:text-emerald-400 leading-relaxed">
                <p className="font-medium mb-0.5">{t('tip')}</p>
                <p className="text-sm text-muted-foreground">{t('smsTipDesc')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── SMS Text Templates ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.35 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-200 to-violet-300 dark:from-violet-900/40 dark:to-violet-800/40 flex items-center justify-center shadow-sm">
                  <FileText className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                </div>
                {t('smsTemplates') || 'SMS Text Templates'}
              </CardTitle>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {t('optional') || 'Optional'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('smsTemplatesDesc') || 'Customize the SMS messages sent to customers. Leave blank to use default templates.'}
            </p>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            {smsSettings ? (
              <>
                {/* Available Variables */}
                <div className="p-3 rounded-xl bg-violet-50 dark:bg-violet-900/10 border border-violet-200/50 dark:border-violet-800/30">
                  <p className="text-xs font-semibold text-violet-700 dark:text-violet-400 mb-2 flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5" />
                    {t('smsAvailableVars') || 'Available Variables'}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {[
                      { var: '{customerName}', desc: t('varCustomerName') || 'Customer full name' },
                      { var: '{ticketNumber}', desc: t('varTicketNumber') || 'Queue ticket number' },
                      { var: '{agencyName}', desc: t('varAgencyName') || 'Agency/business name' },
                      { var: '{position}', desc: t('varPosition') || 'Position in queue' },
                      { var: '{estimatedMinutes}', desc: t('varEstimatedMinutes') || 'Estimated wait (min)' },
                    ].map((v) => (
                      <div key={v.var} className="flex items-center gap-1.5 p-1.5 rounded-lg bg-white dark:bg-gray-900/50">
                        <code className="text-[10px] font-mono font-bold text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/30 px-1.5 py-0.5 rounded">{v.var}</code>
                        <span className="text-[10px] text-muted-foreground truncate">{v.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Turn Approaching Template */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <span className="h-5 w-5 rounded bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center text-[10px]">🔄</span>
                    {t('smsTemplateTurnApproaching') || 'Turn Approaching Template'}
                  </Label>
                  <textarea
                    value={smsSettings.templateTurnApproaching || ''}
                    onChange={(e) => setSmsSettings({ ...smsSettings, templateTurnApproaching: e.target.value })}
                    className="w-full min-h-[70px] px-3 py-2 rounded-lg border border-border bg-background text-sm resize-y focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-colors"
                    placeholder="🔄 BLASTI: Dear {customerName}, your turn is approaching! Ticket {ticketNumber} at {agencyName}. Position: {position}. Est. wait: {estimatedMinutes} min."
                    dir="ltr"
                  />
                </div>

                {/* Your Turn Template */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <span className="h-5 w-5 rounded bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center text-[10px]">🎫</span>
                    {t('smsTemplateYourTurn') || 'Your Turn Template'}
                  </Label>
                  <textarea
                    value={smsSettings.templateYourTurn || ''}
                    onChange={(e) => setSmsSettings({ ...smsSettings, templateYourTurn: e.target.value })}
                    className="w-full min-h-[70px] px-3 py-2 rounded-lg border border-border bg-background text-sm resize-y focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-colors"
                    placeholder="🎫 BLASTI: Dear {customerName}, it's your turn now! Ticket {ticketNumber} at {agencyName}. Please proceed."
                    dir="ltr"
                  />
                </div>

                {/* No-Show Warning Template */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <span className="h-5 w-5 rounded bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-[10px]">⚠️</span>
                    {t('smsTemplateNoShow') || 'No-Show Warning Template'}
                  </Label>
                  <textarea
                    value={smsSettings.templateNoShow || ''}
                    onChange={(e) => setSmsSettings({ ...smsSettings, templateNoShow: e.target.value })}
                    className="w-full min-h-[70px] px-3 py-2 rounded-lg border border-border bg-background text-sm resize-y focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-colors"
                    placeholder="⚠️ BLASTI: Dear {customerName}, your ticket {ticketNumber} at {agencyName} was skipped due to no-show. You can reclaim your position."
                    dir="ltr"
                  />
                </div>

                {/* Custom / Additional Template */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <span className="h-5 w-5 rounded bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center text-[10px]">✉️</span>
                    {t('smsTemplateCustom') || 'Custom / Additional Template'}
                  </Label>
                  <textarea
                    value={smsSettings.templateCustom || ''}
                    onChange={(e) => setSmsSettings({ ...smsSettings, templateCustom: e.target.value })}
                    className="w-full min-h-[70px] px-3 py-2 rounded-lg border border-border bg-background text-sm resize-y focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 outline-none transition-colors"
                    placeholder="Enter any custom SMS template using the variables above. This can be used for special notifications."
                    dir="ltr"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {t('smsTemplateCustomDesc') || 'Use this for any additional custom notification template.'}
                  </p>
                </div>

                {/* Save button for templates */}
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded-xl h-9 px-4 text-sm gap-1.5"
                  >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {t('save')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (!smsSettings) return;
                      setSmsSettings({
                        ...smsSettings,
                        templateTurnApproaching: '',
                        templateYourTurn: '',
                        templateNoShow: '',
                        templateCustom: '',
                      });
                    }}
                    className="rounded-xl h-9 px-4 text-sm gap-1.5"
                  >
                    {t('resetToDefault') || 'Reset to Default'}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* ─── Gateway/Payment Settings ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.4 }}>
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-emerald-600" />
              {t('gatewaySettings')}
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">{t('gatewaySettingsDesc')}</p>
          </CardHeader>
          <CardContent className="pt-0 space-y-5">
            {/* CCP Section */}
            <div className="space-y-3 p-3 rounded-xl bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800/30">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium flex items-center gap-2">
                  <Building2 className="h-3.5 w-3.5 text-blue-600" />
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
                </div>
              )}
            </div>

            {/* E-Wallet Section */}
            <div className="space-y-3 p-3 rounded-xl bg-purple-50/50 dark:bg-purple-900/10 border border-purple-100 dark:border-purple-800/30">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium flex items-center gap-2">
                  <Wallet className="h-3.5 w-3.5 text-purple-600" />
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
      </motion.div>

      {/* ─── FAQ Management ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.5 }}>
        <AdminFaqManager />
      </motion.div>

      {/* ─── Dynamic System Configuration ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.6 }}>
        <SystemSettingsConfig />
      </motion.div>

      {/* ─── Dual Financial Engine (Chargily + ECCP) ─── */}
      <motion.div {...fadeUp} transition={{ delay: 0.7 }}>
        <AdminPaymentEngine />
      </motion.div>
    </div>
  );
}
