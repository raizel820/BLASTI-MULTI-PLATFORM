'use client'

/**
 * Admin → Notifications & Providers (Task 22-c)
 *
 * Full provider management hub replacing the legacy SMS-only settings page.
 * One tab per delivery channel plus templates and delivery logs:
 *
 *   Overview  — per-channel status cards (enabled / configured / last test)
 *   SMS       → eSMS Africa            (API key + sender ID + API URL override)
 *   Email     → Resend                 (API key + from address + API URL override)
 *   WhatsApp  → Meta WhatsApp Cloud    (token + phone number ID + WABA ID + Graph URL)
 *   Templates — editable notification templates (NotificationTemplate rows)
 *   Logs      — recent outbound delivery log
 *
 * The channel forms are rendered GENERICALLY from the backend registry
 * (GET /api/admin/providers → registry[].fields / extraFields / notes), so a
 * provider change on the API is reflected in the UI without a frontend edit.
 *
 * Secrets come back masked ('esm••••••••abcd'); when saving, a value that
 * still contains the mask is flagged with apiKeyIsMasked / omitted from the
 * extras diff so the stored secret is kept untouched.
 *
 * All user-visible strings live in a LOCAL bilingual COPY dict (AR/EN, with
 * the global i18n dictionaries untouched — see desktop-agency-login.tsx for
 * the pattern). RTL is driven by the active language.
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Settings2, MessageSquare, Mail, MessageCircle, LayoutGrid, FileText, ScrollText,
  Eye, EyeOff, Send, Save, Loader2, RefreshCw, CheckCircle2, XCircle, Clock,
  AlertTriangle, Info, ExternalLink, KeyRound, FlaskConical, ChevronDown, Trash2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

// ─── Types (mirror the backend API shapes) ──────────────────────────

type Channel = 'SMS' | 'EMAIL' | 'WHATSAPP';
type TemplateLanguage = 'ar' | 'fr' | 'en';

interface ProviderFieldMeta {
  key: string;
  label: string;
  target: 'apiKey' | 'senderId' | 'phoneNumberId' | 'accountId' | 'apiUrl' | 'extra';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

interface RegistryEntry {
  id: string;
  name: string;
  channel: Channel;
  description: string;
  docsUrl: string;
  defaultApiUrl: string;
  supportsProviderTemplateList: boolean;
  supportsOtp: boolean;
  fields: ProviderFieldMeta[];
  extraFields?: ProviderFieldMeta[];
  notes?: string[];
}

interface ChannelConfig {
  channel: Channel;
  provider: string;
  enabled: boolean;
  apiKey: string;
  hasApiKey: boolean;
  senderId: string;
  phoneNumberId: string;
  accountId: string;
  apiUrl: string;
  extra: Record<string, string>;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  configured: boolean;
}

interface CatalogEntry {
  key: string;
  channels: Channel[];
  descriptionEn: string;
  descriptionAr: string;
}

interface TemplateRow {
  id: string;
  key: string;
  channel: Channel;
  language: TemplateLanguage;
  name: string;
  subject: string | null;
  body: string;
  htmlBody: string | null;
  /** JSON string array of variable names */
  variables: string;
  useProviderTemplate: boolean;
  providerTemplateId: string | null;
  providerTemplateLang: string | null;
  enabled: boolean;
}

interface ProviderTemplateInfo {
  name: string;
  language: string;
  status: string;
  category: string;
}

interface LogItem {
  id: string;
  userId: string | null;
  phoneNumber: string;
  message: string;
  status: string;
  provider: string;
  errorMessage: string | null;
  createdAt: string;
}

interface ProvidersData {
  channels: ChannelConfig[];
  registry: RegistryEntry[];
  catalog: CatalogEntry[];
  devBypass: boolean;
  devCodes?: { SMS?: string; EMAIL?: string };
}

/** Editable form state for one channel tab */
interface ChannelFormState {
  enabled: boolean;
  /** keyed by registry field key (apiKey, senderId, phoneNumberId, accountId, apiUrl) */
  values: Record<string, string>;
  /** keyed by extra field key (testPhoneNumber, replyTo, webhookVerifyToken, otpChannel, ...) */
  extras: Record<string, string>;
}

interface TestResult {
  success: boolean;
  error?: string;
  responseRaw?: string;
  providerMessageId?: string;
}

/** Editor state for one (key, channel, language) template */
interface TemplateDraft {
  language: TemplateLanguage;
  name: string;
  subject: string;
  body: string;
  htmlBody: string;
  variables: string[];
  enabled: boolean;
  useProviderTemplate: boolean;
  providerTemplateId: string;
  providerTemplateLang: string;
}

// ─── Local bilingual copy (AR/EN — global i18n dictionaries untouched) ──

const COPY = {
  ar: {
    title: 'الإشعارات والمزودون',
    subtitle: 'إدارة مزودي الرسائل (SMS / بريد إلكتروني / واتساب) وقوالب الإشعارات وسجل التسليم',
    tabOverview: 'نظرة عامة',
    tabSms: 'رسائل SMS',
    tabEmail: 'البريد الإلكتروني',
    tabWhatsapp: 'واتساب',
    tabTemplates: 'القوالب',
    tabLogs: 'السجلات',
    // Overview
    overviewSubtitle: 'حالة قنوات الإشعارات الثلاث — فعّل القناة، تحقق من الإعداد وآخر اختبار، أو انتقل إلى تبويبها للتهيئة.',
    configured: 'مُهيأ',
    notConfigured: 'غير مُهيأ',
    enabledLabel: 'مُفعّل',
    disabledLabel: 'معطّل',
    lastTest: 'آخر اختبار',
    neverTested: 'لم يُجرَ اختبار بعد',
    testPassed: 'نجح الاختبار',
    testFailed: 'فشل الاختبار',
    configure: 'تهيئة',
    hasKey: 'المفتاح محفوظ',
    noKey: 'لا يوجد مفتاح API',
    devModeTitle: 'وضع التطوير مُفعّل — رموز التحقق ثابتة',
    devModeDesc: 'يمكنك تجاوز التحقق في بيئة التطوير بهذه الرموز:',
    devSmsCode: 'رمز SMS',
    devEmailCode: 'رمز البريد',
    // Channel tab
    channelDocs: 'وثائق المزود',
    channelFormSection: 'بيانات الاعتماد',
    extraFieldsSection: 'إعدادات إضافية',
    otpSection: 'رموز التحقق (OTP)',
    otpChannelLabel: 'قناة إرسال رمز التحقق',
    otpChannelHelp: 'أي قناة تحمل رموز تأكيد الهاتف — رسائل SMS أو واتساب.',
    otpChannelSms: 'رسائل SMS',
    otpChannelWhatsapp: 'واتساب',
    otpTemplateNameLabel: 'اسم قالب واتساب للتحقق',
    otpTemplateNameHelp: 'اسم قالب المصادقة المعتمد من ميتا (مطلوب لإرسال OTP عبر واتساب). بدون قالب معتمد يرتد الإرسال تلقائياً إلى SMS.',
    otpTemplateLangLabel: 'لغة قالب التحقق',
    otpTemplateLangHelp: 'رمز لغة القالب عند ميتا (مثل ar أو en_US).',
    providerTemplatesTitle: 'قوالب ميتا المعتمدة',
    providerTemplatesHint: 'اختر قالباً معتمداً لملء اسم القالب ولغته تلقائياً.',
    providerTemplatesEmpty: 'لا توجد قوالب معتمدة في هذا حساب واتساب للأعمال.',
    providerTemplatesFailed: 'تعذر جلب قوالب المزود',
    fetchTemplates: 'جلب قوالب المزود',
    fetching: 'جارٍ الجلب...',
    secretMaskHint: 'القيمة مخفية — اتركها كما هي للاحتفاظ بالمفتاح المحفوظ، أو أدخل مفتاحاً جديداً.',
    requiredMark: 'إلزامي',
    save: 'حفظ',
    saving: 'جارٍ الحفظ...',
    saved: 'تم حفظ إعدادات القناة',
    sendTest: 'إرسال اختبار',
    testing: 'جارٍ الإرسال...',
    testTargetRequired: 'أدخل رقم هاتف / بريد الاختبار أولاً',
    testOkMsg: 'تم إرسال رسالة الاختبار بنجاح',
    testFailMsg: 'فشل إرسال رسالة الاختبار',
    testMessageId: 'معرّف الرسالة لدى المزود',
    testRawResponse: 'رد المزود الخام',
    notesTitle: 'ملاحظات',
    loadFailed: 'تعذر تحميل بيانات المزودين',
    authRequired: 'هذه الصفحة تتطلب صلاحية مدير عام (SUPER_ADMIN).',
    retry: 'إعادة المحاولة',
    // Templates
    templatesSubtitle: 'قوالب الإشعارات المرسلة لكل قناة وكل لغة. استخدم {{متغير}} داخل النص ليُستبدل عند الإرسال.',
    templatesListTitle: 'كتالوج القوالب',
    templatesEmpty: 'لا توجد قوالب محفوظة لهذا المفتاح والقناة بعد.',
    pickTemplateToEdit: 'اختر قالباً من القائمة للتحرير',
    languageLabel: 'اللغة',
    nameLabel: 'اسم القالب',
    subjectLabel: 'الموضوع (للبريد الإلكتروني)',
    bodyLabel: 'نص الرسالة',
    bodyPlaceholder: 'مرحباً {{fullName}}، رمز التحقق الخاص بك هو {{code}}...',
    htmlLabel: 'هيكل HTML (اختياري — للبريد الإلكتروني)',
    showHtml: 'إظهار محرر HTML',
    hideHtml: 'إخفاء محرر HTML',
    variablesLabel: 'المتغيرات',
    variablesHint: 'استخدم {{variableName}} داخل النص ليُستبدل بقيمته.',
    enabledTemplate: 'القالب مُفعّل',
    disabledTemplate: 'القالب معطّل',
    sourceTitle: 'مصدر القالب',
    sourceApp: 'قالب التطبيق',
    sourceAppDesc: 'يُسلَّم نص القالب أعلاه عبر مزود القناة.',
    sourceProvider: 'قالب المزود',
    sourceProviderDesc: 'يُسلَّم قالب معتمد لدى المزود بدلاً من النص أعلاه (واتساب فقط).',
    providerTemplateIdLabel: 'اسم/معرّف قالب المزود',
    providerTemplateLangLabel: 'لغة قالب المزود',
    fetchFromMeta: 'جلب من ميتا',
    preview: 'معاينة',
    previewTitle: 'معاينة القالب',
    previewSubject: 'الموضوع',
    previewBody: 'النص',
    previewHtml: 'HTML',
    previewProviderNote: 'سيُسلَّم هذا الإشعار كقالب مزود معتمد:',
    previewFailed: 'تعذر توليد المعاينة — القالب مفقود أو معطّل.',
    saveTemplate: 'حفظ القالب',
    savingTemplate: 'جارٍ الحفظ...',
    templateSaved: 'تم حفظ القالب',
    templateValidation: 'املأ اسم القالب ونص الرسالة أولاً',
    resetDefault: 'استعادة الافتراضي',
    resetHint: 'يحذف التعديل المحفوظ ثم يُعاد إنشاء القالب الافتراضي تلقائياً.',
    resetDone: 'تمت الاستعادة إلى القالب الافتراضي',
    draftBadge: 'جديد',
    appTemplateShort: 'تطبيق',
    providerTemplateShort: 'مزود',
    seedButton: 'إصلاح القوالب الافتراضية',
    seeded: 'تم التأكد من القوالب الافتراضية',
    // Logs
    logsSubtitle: 'آخر الرسائل الصادرة عبر قنوات SMS وواتساب.',
    refresh: 'تحديث',
    noLogs: 'لا توجد رسائل صادرة بعد.',
    colPhone: 'الجهة المستهدفة',
    colMessage: 'الرسالة',
    colStatus: 'الحالة',
    colProvider: 'المزود',
    colError: 'الخطأ',
    colTime: 'الوقت',
    logsFailed: 'تعذر تحميل السجلات',
    justNow: 'الآن',
    minAgo: 'دقيقة',
    hoursAgo: 'ساعة',
  },
  en: {
    title: 'Notifications & Providers',
    subtitle: 'Manage your messaging providers (SMS / email / WhatsApp), notification templates and the delivery log',
    tabOverview: 'Overview',
    tabSms: 'SMS',
    tabEmail: 'Email',
    tabWhatsapp: 'WhatsApp',
    tabTemplates: 'Templates',
    tabLogs: 'Logs',
    // Overview
    overviewSubtitle: 'Health of the three delivery channels — toggle them on, check configuration and last test, or jump to their tab.',
    configured: 'Configured',
    notConfigured: 'Not configured',
    enabledLabel: 'Enabled',
    disabledLabel: 'Disabled',
    lastTest: 'Last test',
    neverTested: 'Never tested',
    testPassed: 'Test passed',
    testFailed: 'Test failed',
    configure: 'Configure',
    hasKey: 'Key stored',
    noKey: 'No API key',
    devModeTitle: 'Dev mode active — fixed verification codes',
    devModeDesc: 'Verification can be bypassed in development with these codes:',
    devSmsCode: 'SMS code',
    devEmailCode: 'Email code',
    // Channel tab
    channelDocs: 'Provider docs',
    channelFormSection: 'Credentials',
    extraFieldsSection: 'Extra settings',
    otpSection: 'Verification codes (OTP)',
    otpChannelLabel: 'OTP delivery channel',
    otpChannelHelp: 'Which channel carries phone verification codes — SMS or WhatsApp.',
    otpChannelSms: 'SMS',
    otpChannelWhatsapp: 'WhatsApp',
    otpTemplateNameLabel: 'WhatsApp OTP template name',
    otpTemplateNameHelp: 'Name of the Meta-APPROVED authentication template (required for WhatsApp OTP). Without an approved template, WhatsApp OTP automatically falls back to SMS.',
    otpTemplateLangLabel: 'OTP template language',
    otpTemplateLangHelp: 'Meta template language code (e.g. ar, en_US).',
    providerTemplatesTitle: 'Approved Meta templates',
    providerTemplatesHint: 'Pick an approved template to fill its name and language automatically.',
    providerTemplatesEmpty: 'No approved templates in this WhatsApp Business Account yet.',
    providerTemplatesFailed: 'Could not fetch provider templates',
    fetchTemplates: 'Fetch provider templates',
    fetching: 'Fetching...',
    secretMaskHint: 'Value hidden — leave as-is to keep the stored secret, or type a new one to replace it.',
    requiredMark: 'required',
    save: 'Save',
    saving: 'Saving...',
    saved: 'Channel settings saved',
    sendTest: 'Send test',
    testing: 'Sending...',
    testTargetRequired: 'Enter a test phone number / email first',
    testOkMsg: 'Test message sent successfully',
    testFailMsg: 'Test message failed',
    testMessageId: 'Provider message ID',
    testRawResponse: 'Raw provider response',
    notesTitle: 'Notes',
    loadFailed: 'Failed to load provider data',
    authRequired: 'This page requires SUPER_ADMIN permissions.',
    retry: 'Retry',
    // Templates
    templatesSubtitle: 'Notification templates per channel and language. Use {{variable}} placeholders in the body — they are replaced at delivery time.',
    templatesListTitle: 'Template catalog',
    templatesEmpty: 'No templates saved for this key and channel yet.',
    pickTemplateToEdit: 'Pick a template from the list to edit it',
    languageLabel: 'Language',
    nameLabel: 'Template name',
    subjectLabel: 'Subject (email only)',
    bodyLabel: 'Message body',
    bodyPlaceholder: 'Hello {{fullName}}, your verification code is {{code}}...',
    htmlLabel: 'HTML body (optional — email only)',
    showHtml: 'Show HTML editor',
    hideHtml: 'Hide HTML editor',
    variablesLabel: 'Variables',
    variablesHint: 'Use {{variableName}} in the body — it is replaced with a value.',
    enabledTemplate: 'Template enabled',
    disabledTemplate: 'Template disabled',
    sourceTitle: 'Template source',
    sourceApp: 'App template',
    sourceAppDesc: 'The body above is delivered through the channel provider.',
    sourceProvider: 'Provider template',
    sourceProviderDesc: 'A provider-side approved template is delivered instead of the body above (WhatsApp only).',
    providerTemplateIdLabel: 'Provider template name/ID',
    providerTemplateLangLabel: 'Provider template language',
    fetchFromMeta: 'Fetch from Meta',
    preview: 'Preview',
    previewTitle: 'Template preview',
    previewSubject: 'Subject',
    previewBody: 'Text',
    previewHtml: 'HTML',
    previewProviderNote: 'This notification will be delivered as an approved provider template:',
    previewFailed: 'Could not render the preview — template missing or disabled.',
    saveTemplate: 'Save template',
    savingTemplate: 'Saving...',
    templateSaved: 'Template saved',
    templateValidation: 'Fill the template name and body first',
    resetDefault: 'Reset to default',
    resetHint: 'Deletes the saved override; the default template is re-created automatically.',
    resetDone: 'Reset to the default template',
    draftBadge: 'new',
    appTemplateShort: 'app',
    providerTemplateShort: 'provider',
    seedButton: 'Repair default templates',
    seeded: 'Default templates ensured',
    // Logs
    logsSubtitle: 'Most recent outbound messages sent through the SMS and WhatsApp channels.',
    refresh: 'Refresh',
    noLogs: 'No outbound messages yet.',
    colPhone: 'Recipient',
    colMessage: 'Message',
    colStatus: 'Status',
    colProvider: 'Provider',
    colError: 'Error',
    colTime: 'Time',
    logsFailed: 'Failed to load logs',
    justNow: 'just now',
    minAgo: 'min ago',
    hoursAgo: 'h ago',
  },
};

// ─── Constants ──────────────────────────────────────────────────────

const CHANNELS: Channel[] = ['SMS', 'EMAIL', 'WHATSAPP'];

const CHANNEL_ICONS: Record<Channel, LucideIcon> = {
  SMS: MessageSquare,
  EMAIL: Mail,
  WHATSAPP: MessageCircle,
};

/** Mask marker used by the backend when returning secrets */
const MASK = '••••';

/** Sample variables for the template preview dialog, per catalog key */
const SAMPLE_VARS: Record<string, Record<string, string>> = {
  verify_email: { fullName: 'أحمد بن علي', code: '123456', expiryMinutes: '10' },
  verify_phone: { code: '123456', expiryMinutes: '10' },
  password_reset: { fullName: 'أحمد بن علي', code: '654321', expiryMinutes: '10' },
  turn_approaching: { customerName: 'أحمد', ticketNumber: 'A-001', agencyName: 'وكالة النور', position: '3', estimatedMinutes: '12' },
  your_turn: { customerName: 'أحمد', ticketNumber: 'A-001', agencyName: 'وكالة النور' },
  no_show: { customerName: 'أحمد', ticketNumber: 'A-001', agencyName: 'وكالة النور' },
  welcome: { fullName: 'أحمد بن علي' },
};

const FALLBACK_SAMPLE_VARS: Record<string, string> = {
  fullName: 'أحمد',
  code: '123456',
  expiryMinutes: '10',
  ticketNumber: 'A-001',
  agencyName: 'وكالة النور',
  position: '3',
  estimatedMinutes: '12',
};

// ─── Animation variants (same pattern as admin-settings.tsx) ────────

const fadeUp = {
  initial: { opacity: 0, y: 15 },
  animate: { opacity: 1, y: 0 },
};

// ─── Small helpers ──────────────────────────────────────────────────

/** Parse a NotificationTemplate.variables JSON string safely */
const parseVariables = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json || '[]');
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

/** Extract {{variable}} names used inside a template body */
const extractVars = (text: string): string[] => {
  const found = new Set<string>();
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let m = re.exec(text);
  while (m) {
    found.add(m[1]);
    m = re.exec(text);
  }
  return [...found];
};

/** Build the editable form state for a channel from its masked config */
const buildFormState = (config: ChannelConfig, registry: RegistryEntry | undefined): ChannelFormState => {
  const values: Record<string, string> = {};
  const extras: Record<string, string> = {};
  if (registry) {
    for (const f of registry.fields) {
      if (f.target === 'extra') values[f.key] = config.extra?.[f.key] ?? '';
      else values[f.key] = (config as unknown as Record<string, string>)[f.target] ?? '';
    }
    for (const f of registry.extraFields ?? []) {
      extras[f.key] = config.extra?.[f.key] ?? '';
    }
  }
  // WhatsApp OTP routing extras (not part of the static registry list)
  if (config.channel === 'WHATSAPP') {
    extras.otpChannel = config.extra?.otpChannel || 'SMS';
    extras.otpTemplateName = config.extra?.otpTemplateName ?? '';
    extras.otpTemplateLang = config.extra?.otpTemplateLang ?? '';
  }
  return { enabled: config.enabled, values, extras };
};

// ─── Reusable bits ──────────────────────────────────────────────────

/** Password input with an eye toggle (for secret fields) */
function SecretInput({
  value, onChange, placeholder, label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 text-sm font-mono pe-9"
        dir="ltr"
        aria-label={label}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute end-0 top-0 h-9 w-9 text-muted-foreground hover:text-foreground"
        onClick={() => setShow(!show)}
        aria-label={show ? 'Hide value' : 'Show value'}
        tabIndex={-1}
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

/** Provider-side (Meta) approved template list with fetch + pick */
function ProviderTemplateList({
  channel, onPick, copy,
}: {
  channel: Channel;
  onPick: (t: ProviderTemplateInfo) => void;
  copy: (typeof COPY)['en'];
}) {
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<ProviderTemplateInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fetched, setFetched] = useState(false);

  const fetchTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/providers/${channel}/provider-templates`);
      const data = await res.json();
      if (res.ok && data.success) {
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
        if (data.note) setError(data.note);
      } else {
        setError(data.error || copy.providerTemplatesFailed);
      }
    } catch {
      setError(copy.providerTemplatesFailed);
    } finally {
      setLoading(false);
      setFetched(true);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={fetchTemplates}
        disabled={loading}
        className="h-8 gap-1.5 rounded-lg border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-xs"
      >
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        {loading ? copy.fetching : copy.fetchTemplates}
      </Button>

      {error && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {fetched && templates.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden">
          <p className="text-[11px] font-semibold text-foreground px-3 py-2 bg-muted/50 flex items-center gap-1.5">
            <FileText className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
            {copy.providerTemplatesTitle}
          </p>
          <div className="max-h-52 overflow-y-auto custom-scrollbar divide-y divide-border/60">
            {templates.map((tpl) => (
              <button
                key={tpl.name}
                type="button"
                onClick={() => onPick(tpl)}
                className="w-full text-start px-3 py-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors flex items-center gap-2 flex-wrap"
              >
                <span className="text-xs font-medium text-foreground font-mono" dir="ltr">{tpl.name}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground">{tpl.language}</Badge>
                <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[9px] px-1 py-0">{tpl.status}</Badge>
                {tpl.category && (
                  <span className="text-[10px] text-muted-foreground ms-auto">{tpl.category}</span>
                )}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground px-3 py-1.5 bg-muted/30">{copy.providerTemplatesHint}</p>
        </div>
      )}

      {fetched && !error && templates.length === 0 && (
        <p className="text-[11px] text-muted-foreground">{copy.providerTemplatesEmpty}</p>
      )}
    </div>
  );
}

/** One field of the generic registry-driven form */
function RegistryFieldInput({
  field, value, onChange, copy,
}: {
  field: ProviderFieldMeta;
  value: string;
  onChange: (v: string) => void;
  copy: (typeof COPY)['en'];
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        {field.key === 'apiKey' && <KeyRound className="h-3 w-3" />}
        {field.label}
        {field.required && <span className="text-red-500">*</span>}
        {field.secret && value.includes(MASK) && (
          <Badge variant="outline" className="text-[9px] px-1 py-0 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800">
            <Eye className="h-2.5 w-2.5" />
            {copy.secretMaskHint}
          </Badge>
        )}
      </Label>
      {field.secret ? (
        <SecretInput value={value} onChange={onChange} placeholder={field.placeholder} label={field.label} />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="h-9 text-sm font-mono"
          dir="ltr"
          aria-label={field.label}
        />
      )}
      {field.help && (
        <p className="text-[10px] text-muted-foreground flex items-start gap-1">
          <Info className="h-3 w-3 mt-0.5 shrink-0" />
          {field.help}
        </p>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────

type TabKey = 'overview' | Channel | 'templates' | 'logs';

export function AdminProvidersSettings() {
  const { lang } = useLanguage();
  const c = COPY[lang === 'ar' ? 'ar' : 'en'];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  // ── Data state ──
  const [data, setData] = useState<ProvidersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // ── Per-channel form state ──
  const [forms, setForms] = useState<Record<Channel, ChannelFormState>>({
    SMS: { enabled: false, values: {}, extras: {} },
    EMAIL: { enabled: false, values: {}, extras: {} },
    WHATSAPP: { enabled: false, values: {}, extras: {} },
  });
  const [savingChannel, setSavingChannel] = useState<Channel | null>(null);
  const [testingChannel, setTestingChannel] = useState<Channel | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<Channel, TestResult>>>({});

  // ── Templates state ──
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [selChannel, setSelChannel] = useState<Channel | null>(null);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [showHtmlEditor, setShowHtmlEditor] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [resettingTemplate, setResettingTemplate] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{ subject: string | null; text: string; html: string | null; useProviderTemplate: boolean; providerTemplateId: string | null } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // ── Logs state ──
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  // ── Registry lookup ──
  const getRegistry = useCallback(
    (channel: Channel): RegistryEntry | undefined =>
      data?.registry.find((r) => r.channel === channel),
    [data],
  );

  const getConfig = useCallback(
    (channel: Channel): ChannelConfig | undefined =>
      data?.channels.find((ch) => ch.channel === channel),
    [data],
  );

  // ── Data fetching ──
  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch('/api/admin/providers');
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          const providersData: ProvidersData = {
            channels: json.channels ?? [],
            registry: json.registry ?? [],
            catalog: json.catalog ?? [],
            devBypass: json.devBypass === true,
            devCodes: json.devCodes,
          };
          setData(providersData);
          // Rebuild form state from the (fresh) masked configs
          const nextForms = {} as Record<Channel, ChannelFormState>;
          for (const channel of CHANNELS) {
            const config = providersData.channels.find((ch) => ch.channel === channel);
            const registry = providersData.registry.find((r) => r.channel === channel);
            nextForms[channel] = config
              ? buildFormState(config, registry)
              : { enabled: false, values: {}, extras: {} };
          }
          setForms(nextForms);
        } else {
          setLoadError(json.error || c.loadFailed);
        }
      } else {
        const json = await res.json().catch(() => ({}));
        setLoadError(res.status === 401 || res.status === 403 ? c.authRequired : (json.error || c.loadFailed));
      }
    } catch {
      setLoadError(c.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [c.loadFailed, c.authRequired]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ── Templates fetching (lazy) — returns the fresh rows for callers ──
  const fetchTemplates = useCallback(async (): Promise<TemplateRow[]> => {
    setTemplatesLoading(true);
    try {
      const res = await apiFetch('/api/admin/providers/templates');
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          const rows: TemplateRow[] = json.templates ?? [];
          setTemplates(rows);
          setTemplatesLoaded(true);
          return rows;
        }
      }
    } catch {
      // handled by empty state
    } finally {
      setTemplatesLoading(false);
    }
    return [];
  }, []);

  useEffect(() => {
    if (activeTab === 'templates' && !templatesLoaded && !templatesLoading) {
      fetchTemplates();
    }
  }, [activeTab, templatesLoaded]);

  // ── Logs fetching (lazy) ──
  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await apiFetch('/api/admin/providers/logs?limit=20');
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          setLogs(json.logs ?? []);
          setLogsLoaded(true);
        }
      } else {
        toast.error(c.logsFailed);
      }
    } catch {
      toast.error(c.logsFailed);
    } finally {
      setLogsLoading(false);
    }
  }, [c.logsFailed]);

  useEffect(() => {
    if (activeTab === 'logs' && !logsLoaded && !logsLoading) {
      fetchLogs();
    }
  }, [activeTab, logsLoaded]);

  // ── Channel form mutation helpers ──
  const updateForm = (channel: Channel, patch: Partial<ChannelFormState>) => {
    setForms((prev) => ({ ...prev, [channel]: { ...prev[channel], ...patch } }));
  };

  const setFieldValue = (channel: Channel, key: string, value: string) => {
    setForms((prev) => ({
      ...prev,
      [channel]: { ...prev[channel], values: { ...prev[channel].values, [key]: value } },
    }));
  };

  const setExtraValue = (channel: Channel, key: string, value: string) => {
    setForms((prev) => ({
      ...prev,
      [channel]: { ...prev[channel], extras: { ...prev[channel].extras, [key]: value } },
    }));
  };

  /** Replace the stored config + rebuild the form after a successful save */
  const applySavedConfig = (config: ChannelConfig) => {
    setData((prev) =>
      prev
        ? { ...prev, channels: prev.channels.map((ch) => (ch.channel === config.channel ? config : ch)) }
        : prev,
    );
    const registry = data?.registry.find((r) => r.channel === config.channel);
    setForms((prev) => ({ ...prev, [config.channel]: buildFormState(config, registry) }));
  };

  /** Build the PUT payload — masked secrets are flagged / omitted, not overwritten */
  const buildSavePayload = (channel: Channel, form: ChannelFormState): Record<string, unknown> => {
    const registry = getRegistry(channel);
    const body: Record<string, unknown> = { enabled: form.enabled };
    for (const f of registry?.fields ?? []) {
      const v = (form.values[f.key] ?? '').trim();
      if (f.target === 'apiKey') {
        if (v.includes(MASK)) body.apiKeyIsMasked = true;
        else body.apiKey = v;
      } else if (f.target !== 'extra') {
        body[f.target] = v;
      }
    }
    const extra: Record<string, string | undefined> = {};
    for (const f of registry?.extraFields ?? []) {
      const v = form.extras[f.key] ?? '';
      // Secret extra still showing the mask → omit so the stored value is kept
      if (f.secret && v.includes(MASK)) continue;
      extra[f.key] = v;
    }
    if (channel === 'WHATSAPP') {
      extra.otpChannel = form.extras.otpChannel || 'SMS';
      extra.otpTemplateName = form.extras.otpTemplateName ?? '';
      extra.otpTemplateLang = form.extras.otpTemplateLang ?? '';
    }
    body.extra = extra;
    return body;
  };

  const saveChannel = async (channel: Channel): Promise<boolean> => {
    setSavingChannel(channel);
    try {
      const res = await apiFetch(`/api/admin/providers/${channel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSavePayload(channel, forms[channel])),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        applySavedConfig(json.config as ChannelConfig);
        toast.success(c.saved);
        return true;
      }
      toast.error(json.error || c.loadFailed);
      return false;
    } catch {
      toast.error(c.loadFailed);
      return false;
    } finally {
      setSavingChannel(null);
    }
  };

  const sendTest = async (channel: Channel) => {
    const registry = getRegistry(channel);
    const testField = registry?.extraFields?.find((f) => f.key.toLowerCase().startsWith('test'));
    const target = testField ? (forms[channel].extras[testField.key] ?? '').trim() : '';
    if (!target) {
      toast.error(c.testTargetRequired);
      return;
    }
    // Save first so the test exercises the credentials currently on screen
    const saved = await saveChannel(channel);
    if (!saved) return;
    setTestingChannel(channel);
    try {
      const res = await apiFetch(`/api/admin/providers/${channel}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: target }),
      });
      const json = await res.json().catch(() => ({}));
      const result: TestResult = {
        success: res.ok && json.success === true,
        error: json.error,
        responseRaw: json.responseRaw,
        providerMessageId: json.providerMessageId,
      };
      setTestResults((prev) => ({ ...prev, [channel]: result }));
      if (result.success) toast.success(c.testOkMsg);
      else toast.error(json.error || c.testFailMsg);
      // Refresh last-test metadata in the background
      fetchData(true);
    } catch {
      setTestResults((prev) => ({ ...prev, [channel]: { success: false, error: c.testFailMsg } }));
      toast.error(c.testFailMsg);
    } finally {
      setTestingChannel(null);
    }
  };

  /** Overview toggle — optimistic, PUT { enabled } only */
  const toggleChannelEnabled = async (channel: Channel, checked: boolean) => {
    const prevConfig = getConfig(channel);
    // Optimistic update
    setData((prev) =>
      prev
        ? { ...prev, channels: prev.channels.map((ch) => (ch.channel === channel ? { ...ch, enabled: checked } : ch)) }
        : prev,
    );
    updateForm(channel, { enabled: checked });
    try {
      const res = await apiFetch(`/api/admin/providers/${channel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        applySavedConfig(json.config as ChannelConfig);
      } else {
        throw new Error(json.error || 'save failed');
      }
    } catch {
      // Revert on failure
      if (prevConfig) applySavedConfig(prevConfig);
      toast.error(c.loadFailed);
    }
  };

  // ── Template editor helpers ──

  /** Select a (key, channel) pair and load its existing row for the best language */
  const selectTemplatePair = (key: string, channel: Channel) => {
    setSelKey(key);
    setSelChannel(channel);
    const rows = templates.filter((t) => t.key === key && t.channel === channel);
    const uiLang: TemplateLanguage = lang === 'ar' ? 'ar' : 'en';
    const row = rows.find((r) => r.language === uiLang) ?? rows.find((r) => r.language === 'ar') ?? rows.find((r) => r.language === 'en') ?? rows[0];
    loadDraftFromRow(key, channel, row);
  };

  const loadDraftFromRow = (key: string, channel: Channel, row: TemplateRow | undefined) => {
    setDraftIsNew(!row);
    setShowHtmlEditor(false);
    const language: TemplateLanguage = row?.language ?? (lang === 'ar' ? 'ar' : 'en');
    const declaredVars = row ? parseVariables(row.variables) : [];
    const catalogEntry = data?.catalog.find((entry) => entry.key === key);
    setDraft({
      language,
      name: row?.name ?? catalogEntry?.descriptionEn ?? key,
      subject: row?.subject ?? '',
      body: row?.body ?? '',
      htmlBody: row?.htmlBody ?? '',
      variables: declaredVars,
      enabled: row?.enabled ?? true,
      useProviderTemplate: row?.useProviderTemplate ?? false,
      providerTemplateId: row?.providerTemplateId ?? '',
      providerTemplateLang: row?.providerTemplateLang ?? '',
    });
  };

  /** Switch the editor language — loads the existing row or starts a draft */
  const switchTemplateLanguage = (language: TemplateLanguage) => {
    if (!selKey || !selChannel) return;
    const row = templates.find((t) => t.key === selKey && t.channel === selChannel && t.language === language);
    loadDraftFromRow(selKey, selChannel, row);
  };

  /** Variables shown as chips = declared + any discovered in the body */
  const effectiveVariables = (d: TemplateDraft): string[] => {
    const set = new Set<string>([...d.variables, ...extractVars(d.body), ...extractVars(d.subject), ...extractVars(d.htmlBody)]);
    return [...set];
  };

  const currentRow = (): TemplateRow | undefined => {
    if (!selKey || !selChannel || !draft) return undefined;
    return templates.find((t) => t.key === selKey && t.channel === selChannel && t.language === draft.language);
  };

  const saveTemplate = async () => {
    if (!selKey || !selChannel || !draft) return;
    if (!draft.name.trim() || !draft.body.trim()) {
      toast.error(c.templateValidation);
      return;
    }
    setSavingTemplate(true);
    try {
      const payload: Record<string, unknown> = {
        key: selKey,
        channel: selChannel,
        language: draft.language,
        name: draft.name.trim(),
        body: draft.body,
        variables: effectiveVariables(draft),
        useProviderTemplate: draft.useProviderTemplate,
        enabled: draft.enabled,
      };
      if (selChannel === 'EMAIL') {
        payload.subject = draft.subject.trim() || null;
        payload.htmlBody = draft.htmlBody.trim() || null;
      }
      if (draft.useProviderTemplate) {
        payload.providerTemplateId = draft.providerTemplateId.trim() || null;
        payload.providerTemplateLang = draft.providerTemplateLang.trim() || null;
      }
      const res = await apiFetch('/api/admin/providers/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        toast.success(c.templateSaved);
        const fresh = await fetchTemplates();
        const savedRow = fresh.find(
          (t) => t.key === selKey && t.channel === selChannel && t.language === draft.language,
        );
        if (savedRow) loadDraftFromRow(selKey, selChannel, savedRow);
        setDraftIsNew(false);
      } else {
        toast.error(json.error || c.loadFailed);
      }
    } catch {
      toast.error(c.loadFailed);
    } finally {
      setSavingTemplate(false);
    }
  };

  const resetTemplate = async () => {
    const row = currentRow();
    if (!row || !selKey || !selChannel) return;
    setResettingTemplate(true);
    try {
      const res = await apiFetch(`/api/admin/providers/templates/${row.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(c.resetDone);
        // The backend re-seeds defaults on the next GET — reload and reselect the fresh row
        const fresh = await fetchTemplates();
        const newRow = fresh.find(
          (t) => t.key === selKey && t.channel === selChannel && t.language === draft?.language,
        );
        loadDraftFromRow(selKey, selChannel, newRow);
      } else {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error || c.loadFailed);
      }
    } catch {
      toast.error(c.loadFailed);
    } finally {
      setResettingTemplate(false);
    }
  };

  const seedTemplates = async () => {
    setSeeding(true);
    try {
      const res = await apiFetch('/api/admin/providers/templates/seed', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        toast.success(c.seeded);
        await fetchTemplates();
      } else {
        toast.error(json.error || c.loadFailed);
      }
    } catch {
      toast.error(c.loadFailed);
    } finally {
      setSeeding(false);
    }
  };

  const openPreview = async () => {
    if (!selKey || !selChannel || !draft) return;
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);
    try {
      const vars = { ...FALLBACK_SAMPLE_VARS, ...(SAMPLE_VARS[selKey] ?? {}) };
      const res = await apiFetch('/api/admin/providers/templates/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: selKey, channel: selChannel, language: draft.language, vars }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        setPreviewData(json.rendered);
      } else {
        setPreviewError(json.error || c.previewFailed);
      }
    } catch {
      setPreviewError(c.previewFailed);
    } finally {
      setPreviewLoading(false);
    }
  };

  // ── Formatting helpers ──
  const formatTime = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString(lang === 'ar' ? 'ar-DZ' : 'en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  const formatRelative = (dateStr: string) => {
    try {
      const diffMs = Date.now() - new Date(dateStr).getTime();
      const minutes = Math.floor(diffMs / 60000);
      if (minutes < 1) return c.justNow;
      if (minutes < 60) return `${minutes} ${c.minAgo}`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} ${c.hoursAgo}`;
      return formatTime(dateStr);
    } catch {
      return '';
    }
  };

  // ── Loading skeleton ──
  if (loading) {
    return (
      <div className="space-y-4" dir={dir}>
        <Skeleton className="h-24 rounded-2xl skeleton-shimmer" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 rounded-2xl skeleton-shimmer" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-2xl skeleton-shimmer" />
      </div>
    );
  }

  // ── Load error (401/403/network) ──
  if (loadError && !data) {
    return (
      <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20" dir={dir}>
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertTitle>{c.loadFailed}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <span>{loadError}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchData()}
            className="w-fit h-8 gap-1.5 rounded-lg text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {c.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const catalog = data?.catalog ?? [];

  return (
    <div className="space-y-4" dir={dir}>
      {/* ─── Section header ─── */}
      <motion.div {...fadeUp} transition={{ duration: 0.35 }}>
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-200 to-teal-300 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
            <Settings2 className="h-4.5 w-4.5 text-emerald-700 dark:text-emerald-400" />
          </div>
          <div>
            <h2 className="text-base font-bold text-foreground">{c.title}</h2>
            <p className="text-xs text-muted-foreground">{c.subtitle}</p>
          </div>
        </div>
      </motion.div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)} className="w-full">
        <TabsList className="flex flex-wrap h-auto w-full justify-start gap-1 rounded-xl bg-muted/60 p-1">
          <TabsTrigger value="overview" className="gap-1.5 text-xs rounded-lg px-3 py-1.5">
            <LayoutGrid className="h-3.5 w-3.5" />
            {c.tabOverview}
          </TabsTrigger>
          {CHANNELS.map((channel) => {
            const Icon = CHANNEL_ICONS[channel];
            const label = channel === 'SMS' ? c.tabSms : channel === 'EMAIL' ? c.tabEmail : c.tabWhatsapp;
            return (
              <TabsTrigger key={channel} value={channel} className="gap-1.5 text-xs rounded-lg px-3 py-1.5">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </TabsTrigger>
            );
          })}
          <TabsTrigger value="templates" className="gap-1.5 text-xs rounded-lg px-3 py-1.5">
            <FileText className="h-3.5 w-3.5" />
            {c.tabTemplates}
          </TabsTrigger>
          <TabsTrigger value="logs" className="gap-1.5 text-xs rounded-lg px-3 py-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            {c.tabLogs}
          </TabsTrigger>
        </TabsList>

        {/* ═════════ OVERVIEW ═════════ */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          <p className="text-xs text-muted-foreground">{c.overviewSubtitle}</p>

          {/* Dev bypass alert */}
          {data?.devBypass && (
            <Alert className="border-violet-200 bg-violet-50 dark:border-violet-900/40 dark:bg-violet-950/20">
              <FlaskConical className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              <AlertTitle className="text-violet-700 dark:text-violet-300">{c.devModeTitle}</AlertTitle>
              <AlertDescription>
                <span className="text-xs text-violet-600/80 dark:text-violet-400/80">{c.devModeDesc}</span>
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  {data.devCodes?.SMS && (
                    <Badge variant="outline" className="gap-1 bg-white/60 dark:bg-violet-900/20 border-violet-300 dark:border-violet-800 text-[11px]">
                      {c.devSmsCode}: <code className="font-mono font-bold text-violet-700 dark:text-violet-300" dir="ltr">{data.devCodes.SMS}</code>
                    </Badge>
                  )}
                  {data.devCodes?.EMAIL && (
                    <Badge variant="outline" className="gap-1 bg-white/60 dark:bg-violet-900/20 border-violet-300 dark:border-violet-800 text-[11px]">
                      {c.devEmailCode}: <code className="font-mono font-bold text-violet-700 dark:text-violet-300" dir="ltr">{data.devCodes.EMAIL}</code>
                    </Badge>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Per-channel status cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {CHANNELS.map((channel, idx) => {
              const config = getConfig(channel);
              const registry = getRegistry(channel);
              const Icon = CHANNEL_ICONS[channel];
              const label = channel === 'SMS' ? c.tabSms : channel === 'EMAIL' ? c.tabEmail : c.tabWhatsapp;
              if (!config) return null;
              return (
                <motion.div
                  key={channel}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.08 * idx, duration: 0.35 }}
                >
                  <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 h-full">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-200 to-teal-300 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm shrink-0">
                            <Icon className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-foreground truncate">{registry?.name ?? channel}</p>
                            <p className="text-[10px] font-medium text-muted-foreground">{label}</p>
                          </div>
                        </div>
                        <Switch
                          checked={config.enabled}
                          onCheckedChange={(checked) => toggleChannelEnabled(channel, checked)}
                          aria-label={`${label} — ${c.enabledLabel}`}
                        />
                      </div>

                      <div className="flex items-center gap-1.5 flex-wrap">
                        {config.enabled ? (
                          <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px]">
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            {c.enabledLabel}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">{c.disabledLabel}</Badge>
                        )}
                        {config.configured ? (
                          <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px]">
                            <CheckCircle2 className="h-2.5 w-2.5" />
                            {c.configured}
                          </Badge>
                        ) : (
                          <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px]">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {c.notConfigured}
                          </Badge>
                        )}
                        <span className="text-[9px] text-muted-foreground ms-auto">
                          {config.hasApiKey ? c.hasKey : c.noKey}
                        </span>
                      </div>

                      {/* Last test */}
                      <div className="rounded-lg bg-muted/40 px-2.5 py-2 space-y-0.5">
                        <p className="text-[10px] font-medium text-muted-foreground flex items-center gap-1">
                          <Clock className="h-2.5 w-2.5" />
                          {c.lastTest}
                        </p>
                        {config.lastTestAt ? (
                          <>
                            <p className={`text-[11px] font-semibold flex items-center gap-1 ${config.lastTestOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                              {config.lastTestOk ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                              {config.lastTestOk ? c.testPassed : c.testFailed}
                              <span className="font-normal text-muted-foreground">· {formatTime(config.lastTestAt)}</span>
                            </p>
                            {!config.lastTestOk && config.lastTestError && (
                              <p className="text-[9px] text-red-500/80 dark:text-red-400/80 line-clamp-2 break-all" dir="ltr">
                                {config.lastTestError}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">{c.neverTested}</p>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setActiveTab(channel)}
                        className="w-full h-8 rounded-lg text-xs gap-1.5 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                      >
                        <Settings2 className="h-3 w-3" />
                        {c.configure}
                      </Button>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </TabsContent>

        {/* ═════════ SMS / EMAIL / WHATSAPP (registry-driven) ═════════ */}
        {CHANNELS.map((channel) => {
          const registry = getRegistry(channel);
          const config = getConfig(channel);
          const form = forms[channel];
          const Icon = CHANNEL_ICONS[channel];
          const label = channel === 'SMS' ? c.tabSms : channel === 'EMAIL' ? c.tabEmail : c.tabWhatsapp;
          const testField = registry?.extraFields?.find((f) => f.key.toLowerCase().startsWith('test'));
          const otherExtras = registry?.extraFields?.filter((f) => f !== testField) ?? [];
          const testResult = testResults[channel];
          const testing = testingChannel === channel;
          const saving = savingChannel === channel;
          if (!registry || !form) return null;
          return (
            <TabsContent key={channel} value={channel} className="mt-4">
              <motion.div {...fadeUp} transition={{ duration: 0.35 }}>
                <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-200 to-teal-300 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm shrink-0">
                          <Icon className="h-5 w-5 text-emerald-700 dark:text-emerald-400" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                            {registry.name}
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">{channel}</Badge>
                            {config?.configured ? (
                              <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[9px] px-1.5 py-0">{c.configured}</Badge>
                            ) : (
                              <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[9px] px-1.5 py-0">{c.notConfigured}</Badge>
                            )}
                          </CardTitle>
                          <p className="text-xs text-muted-foreground mt-0.5">{registry.description}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {registry.docsUrl && (
                          <a
                            href={registry.docsUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                            aria-label={`${registry.name} — ${c.channelDocs}`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
                          <span className="text-xs font-medium text-foreground">{form.enabled ? c.enabledLabel : c.disabledLabel}</span>
                          <Switch
                            checked={form.enabled}
                            onCheckedChange={(checked) => updateForm(channel, { enabled: checked })}
                            aria-label={`${label} — ${c.enabledLabel}`}
                          />
                        </div>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="pt-0 space-y-5">
                    {/* ── Credentials (registry fields) ── */}
                    <section className="space-y-3">
                      <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                        <KeyRound className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        {c.channelFormSection}
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {registry.fields.map((field) => (
                          <RegistryFieldInput
                            key={field.key}
                            field={field}
                            value={form.values[field.key] ?? ''}
                            onChange={(v) => setFieldValue(channel, field.key, v)}
                            copy={c}
                          />
                        ))}
                      </div>
                    </section>

                    {/* ── Extra settings (registry extraFields) ── */}
                    {(otherExtras.length > 0 || channel === 'WHATSAPP') && (
                      <>
                        <Separator />
                        <section className="space-y-3">
                          <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                            <Settings2 className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />
                            {c.extraFieldsSection}
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {otherExtras.map((field) => (
                              <div key={field.key} className="space-y-1.5">
                                <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                  {field.label}
                                  {field.required && <span className="text-red-500">*</span>}
                                </Label>
                                {field.secret ? (
                                  <SecretInput
                                    value={form.extras[field.key] ?? ''}
                                    onChange={(v) => setExtraValue(channel, field.key, v)}
                                    placeholder={field.placeholder}
                                    label={field.label}
                                  />
                                ) : (
                                  <Input
                                    value={form.extras[field.key] ?? ''}
                                    onChange={(e) => setExtraValue(channel, field.key, e.target.value)}
                                    placeholder={field.placeholder}
                                    className="h-9 text-sm"
                                    dir={field.key.toLowerCase().includes('email') || field.key.toLowerCase().includes('phone') ? 'ltr' : undefined}
                                    aria-label={field.label}
                                  />
                                )}
                                {field.help && (
                                  <p className="text-[10px] text-muted-foreground flex items-start gap-1">
                                    <Info className="h-3 w-3 mt-0.5 shrink-0" />
                                    {field.help}
                                  </p>
                                )}
                              </div>
                            ))}

                            {/* WhatsApp OTP routing extras */}
                            {channel === 'WHATSAPP' && (
                              <>
                                <div className="space-y-1.5">
                                  <Label className="text-xs font-medium text-muted-foreground">{c.otpChannelLabel}</Label>
                                  <Select
                                    value={form.extras.otpChannel || 'SMS'}
                                    onValueChange={(v) => setExtraValue(channel, 'otpChannel', v)}
                                  >
                                    <SelectTrigger className="h-9 text-sm w-full" aria-label={c.otpChannelLabel}>
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="SMS">{c.otpChannelSms}</SelectItem>
                                      <SelectItem value="WHATSAPP">{c.otpChannelWhatsapp}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  <p className="text-[10px] text-muted-foreground flex items-start gap-1">
                                    <Info className="h-3 w-3 mt-0.5 shrink-0" />
                                    {c.otpChannelHelp}
                                  </p>
                                </div>
                                <div className="space-y-1.5">
                                  <Label className="text-xs font-medium text-muted-foreground">{c.otpTemplateLangLabel}</Label>
                                  <Input
                                    value={form.extras.otpTemplateLang ?? ''}
                                    onChange={(e) => setExtraValue(channel, 'otpTemplateLang', e.target.value)}
                                    placeholder="en_US"
                                    className="h-9 text-sm font-mono"
                                    dir="ltr"
                                    aria-label={c.otpTemplateLangLabel}
                                  />
                                  <p className="text-[10px] text-muted-foreground flex items-start gap-1">
                                    <Info className="h-3 w-3 mt-0.5 shrink-0" />
                                    {c.otpTemplateLangHelp}
                                  </p>
                                </div>
                                <div className="space-y-1.5 sm:col-span-2">
                                  <Label className="text-xs font-medium text-muted-foreground">{c.otpTemplateNameLabel}</Label>
                                  <Input
                                    value={form.extras.otpTemplateName ?? ''}
                                    onChange={(e) => setExtraValue(channel, 'otpTemplateName', e.target.value)}
                                    placeholder="blasti_otp_code"
                                    className="h-9 text-sm font-mono"
                                    dir="ltr"
                                    aria-label={c.otpTemplateNameLabel}
                                  />
                                  <p className="text-[10px] text-muted-foreground flex items-start gap-1">
                                    <Info className="h-3 w-3 mt-0.5 shrink-0" />
                                    {c.otpTemplateNameHelp}
                                  </p>
                                  <div className="pt-1">
                                    <ProviderTemplateList
                                      channel={channel}
                                      copy={c}
                                      onPick={(tpl) => {
                                        setExtraValue(channel, 'otpTemplateName', tpl.name);
                                        setExtraValue(channel, 'otpTemplateLang', tpl.language);
                                      }}
                                    />
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        </section>
                      </>
                    )}

                    {/* ── Registry notes ── */}
                    {registry.notes && registry.notes.length > 0 && (
                      <div className="rounded-xl bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-900/40 p-3">
                        <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1.5">
                          <Info className="h-3.5 w-3.5" />
                          {c.notesTitle}
                        </p>
                        <ul className="space-y-1">
                          {registry.notes.map((note, i) => (
                            <li key={i} className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-relaxed">
                              <span className="mt-1.5 h-1 w-1 rounded-full bg-emerald-500 shrink-0" />
                              {note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* ── Actions ── */}
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                      <Button
                        onClick={() => saveChannel(channel)}
                        disabled={saving || testing}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl h-10 gap-2"
                      >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        {saving ? c.saving : c.save}
                      </Button>
                      {testField && (
                        <Button
                          onClick={() => sendTest(channel)}
                          disabled={saving || testing}
                          variant="outline"
                          className="rounded-xl h-10 gap-2 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                        >
                          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                          {testing ? c.testing : c.sendTest}
                        </Button>
                      )}
                    </div>

                    {/* ── Inline test result ── */}
                    {testResult && (
                      <div
                        className={`rounded-xl p-3 border text-xs space-y-1.5 ${
                          testResult.success
                            ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40'
                            : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900/40'
                        }`}
                        role="status"
                      >
                        <p className={`font-semibold flex items-center gap-1.5 ${testResult.success ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
                          {testResult.success ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                          {testResult.success ? c.testOkMsg : (testResult.error || c.testFailMsg)}
                        </p>
                        {testResult.providerMessageId && (
                          <p className="text-[11px] text-muted-foreground">
                            {c.testMessageId}: <code className="font-mono" dir="ltr">{testResult.providerMessageId}</code>
                          </p>
                        )}
                        {testResult.responseRaw && (
                          <p className="text-[10px] text-muted-foreground break-all line-clamp-3 font-mono" dir="ltr">
                            {c.testRawResponse}: {testResult.responseRaw.slice(0, 300)}
                            {testResult.responseRaw.length > 300 ? '…' : ''}
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            </TabsContent>
          );
        })}

        {/* ═════════ TEMPLATES ═════════ */}
        <TabsContent value="templates" className="mt-4">
          <motion.div {...fadeUp} transition={{ duration: 0.35 }}>
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-violet-200 to-violet-300 dark:from-violet-900/40 dark:to-violet-800/40 flex items-center justify-center shadow-sm">
                        <FileText className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                      </div>
                      {c.tabTemplates}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">{c.templatesSubtitle}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => fetchTemplates()}
                      disabled={templatesLoading}
                      aria-label={c.refresh}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${templatesLoading ? 'animate-spin' : ''}`} />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => seedTemplates()}
                      disabled={seeding}
                      className="h-8 rounded-lg text-xs gap-1.5"
                    >
                      {seeding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {c.seedButton}
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="pt-0">
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,340px)_1fr] gap-4">
                  {/* ── Left: catalog × channel list ── */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-foreground">{c.templatesListTitle}</p>
                    <div className="max-h-[560px] overflow-y-auto custom-scrollbar space-y-2 pe-1">
                      {templatesLoading && !templatesLoaded
                        ? [...Array(5)].map((_, i) => <Skeleton key={i} className="h-16 rounded-xl skeleton-shimmer" />)
                        : catalog.map((entry) =>
                            entry.channels.map((channel) => {
                              const rows = templates.filter((t) => t.key === entry.key && t.channel === channel);
                              const selected = selKey === entry.key && selChannel === channel;
                              const Icon = CHANNEL_ICONS[channel];
                              return (
                                <button
                                  key={`${entry.key}-${channel}`}
                                  type="button"
                                  onClick={() => selectTemplatePair(entry.key, channel)}
                                  className={`w-full text-start rounded-xl border p-3 transition-all ${
                                    selected
                                      ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700 shadow-sm'
                                      : 'bg-muted/30 border-transparent hover:border-border hover:bg-muted/50'
                                  }`}
                                >
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Icon className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`} />
                                    <code className="text-[11px] font-bold font-mono text-foreground" dir="ltr">{entry.key}</code>
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground">{channel}</Badge>
                                    <div className="flex items-center gap-1 ms-auto">
                                      {['ar', 'fr', 'en'].map((lng) => {
                                        const has = rows.some((r) => r.language === lng);
                                        return has ? (
                                          <span key={lng} className="h-1.5 w-1.5 rounded-full bg-emerald-500" title={lng} />
                                        ) : (
                                          <span key={lng} className="h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-700" title={lng} />
                                        );
                                      })}
                                    </div>
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-1 line-clamp-1">
                                    {lang === 'ar' ? entry.descriptionAr : entry.descriptionEn}
                                  </p>
                                </button>
                              );
                            }),
                          )}
                    </div>
                  </div>

                  {/* ── Right: editor ── */}
                  <div className="space-y-4">
                    {!selKey || !selChannel || !draft ? (
                      <div className="h-full min-h-[240px] flex flex-col items-center justify-center text-center rounded-xl border border-dashed border-border p-8">
                        <FileText className="h-8 w-8 text-muted-foreground/50 mb-3" />
                        <p className="text-sm text-muted-foreground">{c.pickTemplateToEdit}</p>
                      </div>
                    ) : (
                      <>
                        {/* Row header: key+channel, language select, per-language chips */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <code className="text-xs font-bold font-mono text-foreground" dir="ltr">{selKey}</code>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground">{selChannel}</Badge>
                          {draftIsNew && (
                            <Badge className="bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400 text-[9px] px-1.5 py-0">{c.draftBadge}</Badge>
                          )}
                          <div className="ms-auto flex items-center gap-2">
                            <Label className="text-[11px] text-muted-foreground">{c.languageLabel}</Label>
                            <Select value={draft.language} onValueChange={(v) => switchTemplateLanguage(v as TemplateLanguage)}>
                              <SelectTrigger className="h-8 w-[110px] text-xs" aria-label={c.languageLabel}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ar">العربية (ar)</SelectItem>
                                <SelectItem value="fr">Français (fr)</SelectItem>
                                <SelectItem value="en">English (en)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* name */}
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{c.nameLabel}</Label>
                          <Input
                            value={draft.name}
                            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            className="h-9 text-sm"
                            aria-label={c.nameLabel}
                          />
                        </div>

                        {/* subject (EMAIL only) */}
                        {selChannel === 'EMAIL' && (
                          <div className="space-y-1.5">
                            <Label className="text-xs font-medium text-muted-foreground">{c.subjectLabel}</Label>
                            <Input
                              value={draft.subject}
                              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                              className="h-9 text-sm"
                              dir="auto"
                              aria-label={c.subjectLabel}
                            />
                          </div>
                        )}

                        {/* body */}
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{c.bodyLabel}</Label>
                          <Textarea
                            value={draft.body}
                            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                            placeholder={c.bodyPlaceholder}
                            className="min-h-[110px] text-sm resize-y font-mono"
                            dir="auto"
                            aria-label={c.bodyLabel}
                          />
                        </div>

                        {/* htmlBody (EMAIL only, collapsible) */}
                        {selChannel === 'EMAIL' && (
                          <Collapsible open={showHtmlEditor} onOpenChange={setShowHtmlEditor}>
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground gap-1">
                                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showHtmlEditor ? 'rotate-180' : ''}`} />
                                {showHtmlEditor ? c.hideHtml : c.showHtml}
                              </Button>
                            </CollapsibleTrigger>
                            <CollapsibleContent className="pt-2">
                              <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-muted-foreground">{c.htmlLabel}</Label>
                                <Textarea
                                  value={draft.htmlBody}
                                  onChange={(e) => setDraft({ ...draft, htmlBody: e.target.value })}
                                  placeholder="<div>…</div>"
                                  className="min-h-[130px] text-xs resize-y font-mono"
                                  dir="ltr"
                                  aria-label={c.htmlLabel}
                                />
                              </div>
                            </CollapsibleContent>
                          </Collapsible>
                        )}

                        {/* variables chips */}
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{c.variablesLabel}</Label>
                          <div className="flex flex-wrap gap-1.5">
                            {effectiveVariables(draft).length === 0 ? (
                              <span className="text-[10px] text-muted-foreground">—</span>
                            ) : (
                              effectiveVariables(draft).map((v) => (
                                <code key={v} className="text-[10px] font-mono font-bold text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/30 px-1.5 py-0.5 rounded" dir="ltr">
                                  {`{{${v}}}`}
                                </code>
                              ))
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground">{c.variablesHint}</p>
                        </div>

                        <Separator />

                        {/* enabled switch */}
                        <div className="flex items-center justify-between p-3 rounded-xl bg-muted/40">
                          <div className="flex items-center gap-2">
                            <div className={`relative flex h-2 w-2`}>
                              {draft.enabled && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${draft.enabled ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                            </div>
                            <p className="text-xs font-medium text-foreground">
                              {draft.enabled ? c.enabledTemplate : c.disabledTemplate}
                            </p>
                          </div>
                          <Switch
                            checked={draft.enabled}
                            onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })}
                            aria-label={c.enabledTemplate}
                          />
                        </div>

                        {/* template source radio */}
                        <div className="space-y-2.5 p-3 rounded-xl border border-border">
                          <p className="text-xs font-semibold text-foreground">{c.sourceTitle}</p>
                          <RadioGroup
                            value={draft.useProviderTemplate ? 'provider' : 'app'}
                            onValueChange={(v) => setDraft({ ...draft, useProviderTemplate: v === 'provider' })}
                            className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                          >
                            <label
                              className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                                !draft.useProviderTemplate ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/20' : 'border-border'
                              }`}
                            >
                              <RadioGroupItem value="app" className="mt-0.5" />
                              <span className="space-y-0.5">
                                <span className="block text-xs font-medium text-foreground">{c.sourceApp}</span>
                                <span className="block text-[10px] text-muted-foreground leading-relaxed">{c.sourceAppDesc}</span>
                              </span>
                            </label>
                            <label
                              className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors ${
                                draft.useProviderTemplate ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/20' : 'border-border'
                              }`}
                            >
                              <RadioGroupItem value="provider" className="mt-0.5" />
                              <span className="space-y-0.5">
                                <span className="block text-xs font-medium text-foreground">{c.sourceProvider}</span>
                                <span className="block text-[10px] text-muted-foreground leading-relaxed">{c.sourceProviderDesc}</span>
                              </span>
                            </label>
                          </RadioGroup>

                          {draft.useProviderTemplate && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                              <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-muted-foreground">{c.providerTemplateIdLabel}</Label>
                                <Input
                                  value={draft.providerTemplateId}
                                  onChange={(e) => setDraft({ ...draft, providerTemplateId: e.target.value })}
                                  placeholder="blasti_otp_code"
                                  className="h-9 text-sm font-mono"
                                  dir="ltr"
                                  aria-label={c.providerTemplateIdLabel}
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-medium text-muted-foreground">{c.providerTemplateLangLabel}</Label>
                                <Input
                                  value={draft.providerTemplateLang}
                                  onChange={(e) => setDraft({ ...draft, providerTemplateLang: e.target.value })}
                                  placeholder="en_US"
                                  className="h-9 text-sm font-mono"
                                  dir="ltr"
                                  aria-label={c.providerTemplateLangLabel}
                                />
                              </div>
                              {selChannel === 'WHATSAPP' && (
                                <div className="sm:col-span-2">
                                  <ProviderTemplateList
                                    channel={selChannel}
                                    copy={c}
                                    onPick={(tpl) =>
                                      setDraft((prev) =>
                                        prev
                                          ? { ...prev, providerTemplateId: tpl.name, providerTemplateLang: tpl.language }
                                          : prev,
                                      )
                                    }
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* editor actions */}
                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                          <Button
                            onClick={() => saveTemplate()}
                            disabled={savingTemplate}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl h-9 gap-2"
                          >
                            {savingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            {savingTemplate ? c.savingTemplate : c.saveTemplate}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => openPreview()}
                            className="rounded-xl h-9 gap-2 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                          >
                            <Eye className="h-4 w-4" />
                            {c.preview}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => resetTemplate()}
                            disabled={resettingTemplate || !currentRow()}
                            className="rounded-xl h-9 gap-2 text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/20"
                          >
                            {resettingTemplate ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            {c.resetDefault}
                          </Button>
                        </div>
                        <p className="text-[10px] text-muted-foreground">{c.resetHint}</p>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </TabsContent>

        {/* ═════════ LOGS ═════════ */}
        <TabsContent value="logs" className="mt-4">
          <motion.div {...fadeUp} transition={{ duration: 0.35 }}>
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
                        <ScrollText className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                      </div>
                      {c.tabLogs}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">{c.logsSubtitle}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fetchLogs()}
                    disabled={logsLoading}
                    className="h-8 gap-1.5 rounded-lg text-xs"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${logsLoading ? 'animate-spin' : ''}`} />
                    {c.refresh}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {logsLoading && !logsLoaded ? (
                  <div className="space-y-2">
                    {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 rounded-xl skeleton-shimmer" />)}
                  </div>
                ) : logs.length === 0 ? (
                  <div className="text-center py-8">
                    <div className="h-12 w-12 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-3">
                      <ScrollText className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">{c.noLogs}</p>
                  </div>
                ) : (
                  <div className="max-h-96 overflow-y-auto custom-scrollbar overflow-x-auto">
                    <div className="min-w-[640px]">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">{c.colPhone}</TableHead>
                            <TableHead className="text-xs">{c.colMessage}</TableHead>
                            <TableHead className="text-xs">{c.colStatus}</TableHead>
                            <TableHead className="text-xs">{c.colProvider}</TableHead>
                            <TableHead className="text-xs">{c.colError}</TableHead>
                            <TableHead className="text-xs">{c.colTime}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {logs.map((log) => {
                            const upper = (log.status || '').toUpperCase();
                            const sent = upper === 'SENT' || upper === 'DELIVERED';
                            const failed = upper === 'FAILED';
                            return (
                              <TableRow key={log.id}>
                                <TableCell className="text-xs font-mono whitespace-nowrap" dir="ltr">
                                  {log.phoneNumber}
                                </TableCell>
                                <TableCell className="text-xs max-w-[220px]">
                                  <span className="line-clamp-2">{log.message}</span>
                                </TableCell>
                                <TableCell>
                                  {sent ? (
                                    <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] px-1.5 py-0">
                                      <CheckCircle2 className="h-2.5 w-2.5" />
                                      {upper}
                                    </Badge>
                                  ) : failed ? (
                                    <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] px-1.5 py-0">
                                      <XCircle className="h-2.5 w-2.5" />
                                      {upper}
                                    </Badge>
                                  ) : (
                                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
                                      <Clock className="h-2.5 w-2.5" />
                                      {upper}
                                    </Badge>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">{log.provider}</TableCell>
                                <TableCell className="text-[10px] text-red-500 dark:text-red-400 max-w-[180px]">
                                  <span className="line-clamp-2 break-all" dir="ltr">{log.errorMessage || '—'}</span>
                                </TableCell>
                                <TableCell className="text-[10px] text-muted-foreground whitespace-nowrap">
                                  {formatRelative(log.createdAt)}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </TabsContent>
      </Tabs>

      {/* ─── Preview dialog ─── */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto custom-scrollbar" dir={dir}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Eye className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              {c.previewTitle}
              {selKey && <code className="text-[11px] font-mono text-muted-foreground" dir="ltr">{selKey} · {selChannel} · {draft?.language}</code>}
            </DialogTitle>
            <DialogDescription>{c.variablesHint}</DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="space-y-2 py-4">
              <Skeleton className="h-8 rounded-lg skeleton-shimmer" />
              <Skeleton className="h-24 rounded-lg skeleton-shimmer" />
            </div>
          ) : previewError ? (
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              {previewError || c.previewFailed}
            </div>
          ) : previewData ? (
            <div className="space-y-3">
              {previewData.useProviderTemplate && previewData.providerTemplateId && (
                <div className="rounded-lg border border-violet-200 dark:border-violet-900/40 bg-violet-50 dark:bg-violet-950/20 p-2.5 text-[11px] text-violet-700 dark:text-violet-300 flex items-start gap-2">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    {c.previewProviderNote}{' '}
                    <code className="font-mono font-bold" dir="ltr">{previewData.providerTemplateId}</code>
                  </span>
                </div>
              )}
              {previewData.subject && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">{c.previewSubject}</p>
                  <p className="text-sm font-medium text-foreground rounded-lg bg-muted/50 px-3 py-2">{previewData.subject}</p>
                </div>
              )}
              <div className="space-y-1">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">{c.previewBody}</p>
                <p className="text-sm text-foreground whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 leading-relaxed" dir="auto">
                  {previewData.text}
                </p>
              </div>
              {previewData.html && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">{c.previewHtml}</p>
                  <div
                    className="rounded-lg border border-border p-3 bg-white text-sm overflow-x-auto"
                    // Admin-side preview of the admin's own stored email HTML
                    dangerouslySetInnerHTML={{ __html: previewData.html }}
                  />
                </div>
              )}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)} className="rounded-xl h-9 text-xs">
              {lang === 'ar' ? 'إغلاق' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
