'use client';

/**
 * AdminTranslationAgent (0.6.61) — "Agency Category Translations" console.
 *
 * The admin surface of the AI Translation Agent (lib/translation-agent.ts on
 * the API). THREE tabs:
 *
 *   1. Agent & Queue  — enable/disable, batching interval (minutes), batch
 *      size, GLM model, last-window outcome, force "process now", recent
 *      jobs monitor (pending/processing/done/failed).
 *   2. Local Dictionary — the wide translation library built over time
 *      (words AND sentences, keyed by normalized source hash). Search,
 *      filter by language pair / domain, manual corrections (origin flips to
 *      'manual'), delete rows. Dictionary hits NEVER cost an agent call.
 *   3. API Keys — manage + TEST the agent's keys: the bundled 'zai' SDK
 *      (free GLM flash) or 'openai-compatible' endpoints (z.ai open
 *      platform / any OpenAI-shaped provider). The newest active
 *      openai-compatible key wins; otherwise the SDK is used.
 *
 * Registered as view 'admin-translation-agent' → /admin/translation-agent
 * (Agencies Management group, SUPER_ADMIN-only via the admin- prefix guard).
 */

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Languages,
  Plus,
  Loader2,
  RefreshCw,
  Sparkles,
  BookA,
  KeyRound,
  Play,
  Trash2,
  Pencil,
  Bot,
  Clock,
  CheckCircle2,
  XCircle,
  Database,
} from 'lucide-react';
import { toast } from 'sonner';
import { AdminAgenciesManagementSectionPage } from '@/components/admin/admin-agencies-management-section-page';
import type { TranslationKeys } from '@/i18n';

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentConfig {
  id: string;
  enabled: boolean;
  intervalMinutes: number;
  batchSize: number;
  model: string;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunMessage: string | null;
}

interface SettingsPayload {
  config: AgentConfig;
  queue: { pending: number; processing: number; done: number; failed: number };
  dictionarySize: number;
  activeKeys: number;
}

interface JobRow {
  id: string;
  type: string;
  status: string;
  sourceLang: string | null;
  targetLang: string | null;
  sourceText: string | null;
  domain: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
}

interface DictionaryEntry {
  id: string;
  sourceLang: string;
  sourceText: string;
  targetLang: string;
  targetText: string;
  domain: string;
  key: string | null;
  origin: string;
  usageCount: number;
  updatedAt: string;
}

interface ApiKeyRow {
  id: string;
  label: string;
  provider: string;
  baseUrl: string | null;
  model: string | null;
  isActive: boolean;
  maskedKey: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

const DOMAIN_OPTIONS = ['agency', 'service', 'category', 'term', 'manual', 'general'];

/** apiClient auto-unwraps `{ success, data }` envelopes — accept both shapes. */
function unwrapPayload<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in (payload as Record<string, unknown>)) {
    return ((payload as { data?: unknown }).data ?? payload) as T;
  }
  return payload as T;
}

function timeAgo(iso: string | null, lang: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return lang === 'ar' ? 'الآن' : lang === 'fr' ? "à l'instant" : 'just now';
  if (mins < 60) return lang === 'ar' ? `قبل ${mins} د` : `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return lang === 'ar' ? `قبل ${hours} س` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return lang === 'ar' ? `قبل ${days} ي` : `${days} d`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AdminTranslationAgent() {
  const { t, lang } = useLanguage();

  // ── Settings + queue ──
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [processingNow, setProcessingNow] = useState(false);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [jobFilter, setJobFilter] = useState<string>('all');

  // ── Dictionary ──
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null);
  const [entriesTotal, setEntriesTotal] = useState(0);
  const [entriesPage, setEntriesPage] = useState(1);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [dictSearch, setDictSearch] = useState('');
  const [dictSourceLang, setDictSourceLang] = useState('all');
  const [dictTargetLang, setDictTargetLang] = useState('all');
  const [dictDomain, setDictDomain] = useState('all');
  const [editEntry, setEditEntry] = useState<DictionaryEntry | null>(null);
  const [editText, setEditText] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null);

  // ── API keys ──
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [keysLoading, setKeysLoading] = useState(true);
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [keyForm, setKeyForm] = useState({ label: '', provider: 'zai', baseUrl: '', apiKey: '' });
  const [savingKey, setSavingKey] = useState(false);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [deleteKeyId, setDeleteKeyId] = useState<string | null>(null);

  // ── Loaders ──
  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await apiFetch('/api/translation-agent/settings');
      const data = unwrapPayload<SettingsPayload>(await res.json().catch(() => null));
      if (res.ok && data?.config) setSettings(data);
    } catch { /* surfaced via skeletons */ }
    setSettingsLoading(false);
  }, []);

  const loadJobs = useCallback(async (filter: string) => {
    try {
      const qs = filter && filter !== 'all' ? `?status=${filter}` : '';
      const res = await apiFetch(`/api/translation-agent/jobs${qs}`);
      const data = unwrapPayload<{ jobs: JobRow[] }>(await res.json().catch(() => null));
      if (res.ok && data?.jobs) setJobs(data.jobs);
    } catch { /* keep previous */ }
  }, []);

  const loadEntries = useCallback(async (page: number) => {
    setEntriesLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: '25' });
      if (dictSearch.trim()) params.set('search', dictSearch.trim());
      if (dictSourceLang !== 'all') params.set('sourceLang', dictSourceLang);
      if (dictTargetLang !== 'all') params.set('targetLang', dictTargetLang);
      if (dictDomain !== 'all') params.set('domain', dictDomain);
      const res = await apiFetch(`/api/translation-agent/dictionary?${params.toString()}`);
      const data = unwrapPayload<{ entries: DictionaryEntry[]; total: number }>(await res.json().catch(() => null));
      if (res.ok && data?.entries) {
        setEntries(data.entries);
        setEntriesTotal(data.total ?? 0);
      }
    } catch { /* keep previous */ }
    setEntriesLoading(false);
  }, [dictSearch, dictSourceLang, dictTargetLang, dictDomain]);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await apiFetch('/api/translation-agent/keys');
      const data = unwrapPayload<{ keys: ApiKeyRow[] }>(await res.json().catch(() => null));
      if (res.ok && data?.keys) setKeys(data.keys);
    } catch { /* keep previous */ }
    setKeysLoading(false);
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => { void loadJobs(jobFilter); }, [jobFilter, loadJobs]);
  useEffect(() => {
    const timer = setTimeout(() => { void loadEntries(entriesPage); }, 250);
    return () => clearTimeout(timer);
  }, [entriesPage, loadEntries]);
  useEffect(() => { setEntriesPage(1); }, [dictSearch, dictSourceLang, dictTargetLang, dictDomain]);
  useEffect(() => { void loadKeys(); }, [loadKeys]);

  // ── Actions ──
  const patchSettings = async (patch: Partial<AgentConfig>) => {
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/translation-agent/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(t('trAgentSaved') as any);
        await loadSettings();
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setSavingSettings(false);
  };

  const processNow = async () => {
    setProcessingNow(true);
    try {
      const res = await apiFetch('/api/translation-agent/process-now', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        const stats = data?.data?.stats || {};
        if (stats.ran) {
          toast.success((t('trAgentWindowDone') as any as string)
            .replace('{text}', String(stats.textJobs ?? 0))
            .replace('{categories}', String(stats.categoryJobs ?? 0)));
        } else {
          toast.info(t('trAgentWindowEmpty') as any);
        }
        await Promise.all([loadSettings(), loadJobs(jobFilter)]);
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setProcessingNow(false);
  };

  const saveEntry = async () => {
    if (!editEntry || !editText.trim()) return;
    setSavingEntry(true);
    try {
      const res = await apiFetch(`/api/translation-agent/dictionary/${editEntry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetText: editText.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(t('trAgentSaved') as any);
        setEditEntry(null);
        await loadEntries(entriesPage);
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setSavingEntry(false);
  };

  const deleteEntry = async (id: string) => {
    try {
      const res = await apiFetch(`/api/translation-agent/dictionary/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(t('trAgentEntryDeleted') as any);
        await loadEntries(entriesPage);
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setDeleteEntryId(null);
  };

  const addKey = async () => {
    if (!keyForm.label.trim() || (keyForm.provider === 'openai-compatible' && (!keyForm.apiKey.trim() || !keyForm.baseUrl.trim()))) {
      toast.error(t('trAgentKeyMissingFields') as any);
      return;
    }
    setSavingKey(true);
    try {
      const res = await apiFetch('/api/translation-agent/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keyForm),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(t('trAgentKeyAdded') as any);
        setAddKeyOpen(false);
        setKeyForm({ label: '', provider: 'zai', baseUrl: '', apiKey: '' });
        await loadKeys();
        await loadSettings();
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setSavingKey(false);
  };

  const testKey = async (id: string) => {
    setTestingKeyId(id);
    try {
      const res = await apiFetch(`/api/translation-agent/keys/${id}/test`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        const result = data?.data || {};
        if (result.ok) {
          toast.success((t('trAgentKeyTestOk') as any as string) + (result.sample ? ` — "${String(result.sample).slice(0, 60)}"` : ''));
        } else {
          toast.error(`${t('trAgentKeyTestFail') as any}: ${String(result.message || '')}`);
        }
        await loadKeys();
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setTestingKeyId(null);
  };

  const deleteKey = async (id: string) => {
    try {
      const res = await apiFetch(`/api/translation-agent/keys/${id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        toast.success(t('trAgentKeyDeleted') as any);
        await loadKeys();
        await loadSettings();
      } else {
        toast.error(String(data?.error || t('error')));
      }
    } catch {
      toast.error(t('error'));
    }
    setDeleteKeyId(null);
  };

  const statusBadge = (status: string) => {
    if (status === 'done') return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-0"><CheckCircle2 className="h-3 w-3 me-1" />{t('trAgentStatusDone')}</Badge>;
    if (status === 'failed') return <Badge className="bg-red-500/15 text-red-700 dark:text-red-400 border-0"><XCircle className="h-3 w-3 me-1" />{t('trAgentStatusFailed')}</Badge>;
    if (status === 'processing') return <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 border-0"><Loader2 className="h-3 w-3 me-1 animate-spin" />{t('trAgentStatusProcessing')}</Badge>;
    return <Badge variant="outline"><Clock className="h-3 w-3 me-1" />{t('trAgentStatusPending')}</Badge>;
  };

  const totalPages = Math.max(1, Math.ceil(entriesTotal / 25));

  return (
    <AdminAgenciesManagementSectionPage
      icon={Languages}
      titleKey={'trAgentTitle' as TranslationKeys}
      descKey={'trAgentDesc' as TranslationKeys}
    >
      <Tabs defaultValue="agent" className="space-y-4">
        <TabsList className="grid grid-cols-3 w-full sm:w-auto sm:inline-grid">
          <TabsTrigger value="agent" className="gap-1.5 text-xs sm:text-sm">
            <Bot className="h-4 w-4" />{t('trAgentTabAgent')}
          </TabsTrigger>
          <TabsTrigger value="dictionary" className="gap-1.5 text-xs sm:text-sm">
            <BookA className="h-4 w-4" />{t('trAgentTabDictionary')}
          </TabsTrigger>
          <TabsTrigger value="keys" className="gap-1.5 text-xs sm:text-sm">
            <KeyRound className="h-4 w-4" />{t('trAgentTabKeys')}
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Agent & Queue ── */}
        <TabsContent value="agent" className="space-y-4">
          <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
            <CardContent className="p-5 space-y-5">
              {settingsLoading || !settings ? (
                <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label className="text-sm font-medium">{t('trAgentEnabled')}</Label>
                      <p className="text-xs text-muted-foreground">{t('trAgentEnabledHint')}</p>
                    </div>
                    <Switch
                      checked={settings.config.enabled}
                      disabled={savingSettings}
                      onCheckedChange={(v) => void patchSettings({ enabled: v })}
                      aria-label={t('trAgentEnabled') as any}
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('trAgentInterval')}</Label>
                      <Input
                        type="number" min={1} max={120}
                        defaultValue={settings.config.intervalMinutes}
                        id="tr-agent-interval"
                        key={`interval-${settings.config.intervalMinutes}`}
                        onBlur={(e) => {
                          const v = Number((e.target as HTMLInputElement).value);
                          if (Number.isFinite(v) && v >= 1 && v <= 120 && v !== settings.config.intervalMinutes) void patchSettings({ intervalMinutes: v });
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground">{t('trAgentIntervalHint')}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('trAgentBatch')}</Label>
                      <Input
                        type="number" min={1} max={100}
                        defaultValue={settings.config.batchSize}
                        id="tr-agent-batch"
                        key={`batch-${settings.config.batchSize}`}
                        onBlur={(e) => {
                          const v = Number((e.target as HTMLInputElement).value);
                          if (Number.isFinite(v) && v >= 1 && v <= 100 && v !== settings.config.batchSize) void patchSettings({ batchSize: v });
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground">{t('trAgentBatchHint')}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('trAgentModel')}</Label>
                      {/* 0.6.64 — the model is PINNED server-side to the free
                          flash id in ALL cases (stored key ids / hand-typed
                          ids kept pointing at models that do not exist on
                          api.z.ai and broke key connections). Display-only —
                          there is nothing to edit anymore. */}
                      <Input value="glm-4.7-flash" readOnly dir="ltr" className="font-mono bg-muted/50 cursor-default" aria-readonly />
                      <p className="text-[11px] text-muted-foreground">{t('trAgentModelHint')}</p>
                    </div>
                  </div>

                  {/* Queue stats */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {([
                      ['pending', settings.queue.pending, 'trAgentQueuePending'],
                      ['processing', settings.queue.processing, 'trAgentQueueProcessing'],
                      ['done', settings.queue.done, 'trAgentQueueDone'],
                      ['failed', settings.queue.failed, 'trAgentQueueFailed'],
                    ] as const).map(([key, value, label]) => (
                      <div key={key} className="rounded-xl border p-3 text-center">
                        <p className="text-xl font-bold text-foreground">{value}</p>
                        <p className="text-[11px] text-muted-foreground">{t(label as TranslationKeys)}</p>
                      </div>
                    ))}
                  </div>

                  {/* Last run + process now */}
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border bg-muted/30 p-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium flex items-center gap-1.5">
                        <Database className="h-3.5 w-3.5 text-teal-600" />
                        {t('trAgentLastRun')}: {timeAgo(settings.config.lastRunAt, lang)}
                        {settings.config.lastRunOk === true && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                        {settings.config.lastRunOk === false && <XCircle className="h-3.5 w-3.5 text-red-500" />}
                      </p>
                      {settings.config.lastRunMessage && (
                        <p className="text-[11px] text-muted-foreground truncate" dir="ltr" title={settings.config.lastRunMessage}>
                          {settings.config.lastRunMessage}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground">
                        {t('trAgentDictionarySize')}: <span className="font-semibold">{settings.dictionarySize}</span>
                        {' · '}{t('trAgentActiveKeys')}: <span className="font-semibold">{settings.activeKeys}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={processNow}
                      disabled={processingNow}
                      className="gap-2 bg-teal-600 hover:bg-teal-700 text-white shrink-0"
                    >
                      {processingNow ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      {t('trAgentProcessNow')}
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Recent jobs */}
          <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
            <CardContent className="p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t('trAgentJobs')}</h3>
                <div className="flex items-center gap-2">
                  <Select value={jobFilter} onValueChange={setJobFilter}>
                    <SelectTrigger className="h-8 w-36 text-xs" aria-label={t('trAgentJobs')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('trAgentFilterAll')}</SelectItem>
                      <SelectItem value="pending">{t('trAgentStatusPending')}</SelectItem>
                      <SelectItem value="processing">{t('trAgentStatusProcessing')}</SelectItem>
                      <SelectItem value="done">{t('trAgentStatusDone')}</SelectItem>
                      <SelectItem value="failed">{t('trAgentStatusFailed')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void loadJobs(jobFilter)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="rounded-xl border overflow-hidden">
                <div className="max-h-80 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead className="text-xs">{t('trAgentColText')}</TableHead>
                        <TableHead className="text-xs w-20">{t('trAgentColLangs')}</TableHead>
                        <TableHead className="text-xs w-24">{t('trAgentColStatus')}</TableHead>
                        <TableHead className="text-xs w-20">{t('trAgentColAge')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!jobs ? (
                        [...Array(3)].map((_, i) => <TableRow key={i}><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>)
                      ) : jobs.length === 0 ? (
                        <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-6">{t('trAgentJobsEmpty')}</TableCell></TableRow>
                      ) : jobs.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell className="max-w-[280px]">
                            <p className="text-xs truncate" title={job.sourceText ?? ''}>{job.sourceText || `— (${job.type})`}</p>
                            {job.error && <p className="text-[10px] text-red-500 truncate" title={job.error}>{job.error}</p>}
                          </TableCell>
                          <TableCell className="text-xs font-mono" dir="ltr">
                            {job.sourceLang}→{job.targetLang ?? '🏷'}
                          </TableCell>
                          <TableCell>{statusBadge(job.status)}</TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">{timeAgo(job.createdAt, lang)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: Local Dictionary ── */}
        <TabsContent value="dictionary" className="space-y-4">
          <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
            <CardContent className="p-5 space-y-4">
              <p className="text-xs text-muted-foreground leading-relaxed">{t('trAgentDictHint')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Input
                  value={dictSearch}
                  onChange={(e) => setDictSearch(e.target.value)}
                  placeholder={t('trAgentDictSearch') as any}
                  className="h-9 col-span-2 sm:col-span-1"
                />
                <Select value={dictSourceLang} onValueChange={setDictSourceLang}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('trAgentFilterAll')}</SelectItem>
                    <SelectItem value="ar">AR</SelectItem>
                    <SelectItem value="en">EN</SelectItem>
                    <SelectItem value="fr">FR</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={dictTargetLang} onValueChange={setDictTargetLang}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('trAgentFilterAll')}</SelectItem>
                    <SelectItem value="ar">AR</SelectItem>
                    <SelectItem value="en">EN</SelectItem>
                    <SelectItem value="fr">FR</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={dictDomain} onValueChange={setDictDomain}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('trAgentFilterAll')}</SelectItem>
                    {DOMAIN_OPTIONS.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-xl border overflow-hidden">
                <div className="max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead className="text-xs">{t('trAgentColSource')}</TableHead>
                        <TableHead className="text-xs">{t('trAgentColTarget')}</TableHead>
                        <TableHead className="text-xs w-16">{t('trAgentColDomain')}</TableHead>
                        <TableHead className="text-xs w-16">{t('trAgentColActions')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entriesLoading && !entries ? (
                        [...Array(5)].map((_, i) => <TableRow key={i}><TableCell colSpan={4}><Skeleton className="h-6 w-full" /></TableCell></TableRow>)
                      ) : !entries || entries.length === 0 ? (
                        <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-6">{t('trAgentDictEmpty')}</TableCell></TableRow>
                      ) : entries.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell className="max-w-[200px]">
                            <p className="text-xs truncate" dir="auto" title={entry.sourceText}>{entry.sourceText}</p>
                            <p className="text-[10px] text-muted-foreground font-mono" dir="ltr">{entry.sourceLang}→{entry.targetLang}{entry.origin === 'manual' ? ' · ✎' : ''}</p>
                          </TableCell>
                          <TableCell className="max-w-[200px]">
                            <p className="text-xs truncate" dir="auto" title={entry.targetText}>{entry.targetText}</p>
                          </TableCell>
                          <TableCell className="text-[11px] text-muted-foreground">{entry.domain}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost" size="sm" className="h-7 w-7 p-0"
                                onClick={() => { setEditEntry(entry); setEditText(entry.targetText); }}
                                aria-label={t('edit') as any}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                                onClick={() => setDeleteEntryId(entry.id)}
                                aria-label={t('delete') as any}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              {entriesTotal > 25 && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{entriesTotal} {t('trAgentDictTotal') as any}</span>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-7" disabled={entriesPage <= 1 || entriesLoading} onClick={() => setEntriesPage((p) => p - 1)}>{t('prev') as any}</Button>
                    <span className="font-mono">{entriesPage}/{totalPages}</span>
                    <Button variant="outline" size="sm" className="h-7" disabled={entriesPage >= totalPages || entriesLoading} onClick={() => setEntriesPage((p) => p + 1)}>{t('next') as any}</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: API Keys ── */}
        <TabsContent value="keys" className="space-y-4">
          <Card className="border-0 shadow-lg shadow-black/5 dark:shadow-black/20">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs text-muted-foreground leading-relaxed flex-1">{t('trAgentKeysHint')}</p>
                <Button size="sm" className="gap-1.5 bg-teal-600 hover:bg-teal-700 text-white shrink-0" onClick={() => setAddKeyOpen(true)}>
                  <Plus className="h-4 w-4" />{t('trAgentKeyAdd')}
                </Button>
              </div>

              {keysLoading ? (
                <div className="space-y-3">{[...Array(2)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
              ) : !keys || keys.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center space-y-2">
                  <Sparkles className="h-6 w-6 mx-auto text-teal-500" />
                  <p className="text-xs text-muted-foreground">{t('trAgentKeysEmpty')}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {keys.map((key) => (
                    <div key={key.id} className="rounded-xl border p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <KeyRound className="h-4 w-4 text-teal-600 shrink-0" />
                          <span className="text-sm font-medium truncate">{key.label}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">{key.provider === 'zai' ? 'GLM SDK' : 'OpenAI-compatible'}</Badge>
                          {key.provider === 'openai-compatible' && key.model && (
                            <Badge variant="outline" className="text-[10px] font-mono shrink-0" dir="ltr">{key.model}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Switch
                            checked={key.isActive}
                            onCheckedChange={(v) => {
                              void (async () => {
                                await apiFetch(`/api/translation-agent/keys/${key.id}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ isActive: v }),
                                });
                                await loadKeys();
                              })();
                            }}
                            aria-label={key.label}
                          />
                          <Button
                            variant="outline" size="sm" className="h-7 gap-1 text-xs"
                            disabled={testingKeyId === key.id}
                            onClick={() => void testKey(key.id)}
                          >
                            {testingKeyId === key.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                            {t('trAgentKeyTest')}
                          </Button>
                          <Button
                            variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                            onClick={() => setDeleteKeyId(key.id)}
                            aria-label={t('delete') as any}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap" dir="ltr">
                        <span className="font-mono">{key.maskedKey}</span>
                        {key.baseUrl && <span className="truncate">· {key.baseUrl}</span>}
                        <span>· {t('trAgentLastTest')}: {timeAgo(key.lastTestAt, lang)}</span>
                        {key.lastTestOk === true && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                        {key.lastTestOk === false && <XCircle className="h-3 w-3 text-red-500" />}
                        {key.lastTestMessage && <span className="truncate max-w-[200px]" title={key.lastTestMessage}>· {key.lastTestMessage}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Edit dictionary entry dialog */}
      <Dialog open={!!editEntry} onOpenChange={(open) => { if (!open) setEditEntry(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('trAgentEditEntry')}</DialogTitle>
            <DialogDescription dir="auto" className="line-clamp-2">{editEntry?.sourceText}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">
              {t('trAgentColTarget')} ({editEntry?.sourceLang}→{editEntry?.targetLang})
            </Label>
            <Input value={editText} onChange={(e) => setEditText(e.target.value)} dir="auto" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditEntry(null)}>{t('cancel')}</Button>
            <Button onClick={saveEntry} disabled={savingSettings || savingEntry || !editText.trim()} className="gap-1.5">
              {savingEntry ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add API key dialog */}
      <Dialog open={addKeyOpen} onOpenChange={setAddKeyOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('trAgentKeyAdd')}</DialogTitle>
            <DialogDescription>{t('trAgentKeyAddHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('trAgentKeyLabel')}</Label>
              <Input value={keyForm.label} onChange={(e) => setKeyForm((f) => ({ ...f, label: e.target.value }))} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('trAgentKeyProvider')}</Label>
              <Select value={keyForm.provider} onValueChange={(v) => setKeyForm((f) => ({ ...f, provider: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="zai">GLM SDK ({t('trAgentProviderZai')})</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {keyForm.provider === 'openai-compatible' && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('trAgentKeyBaseUrl')}</Label>
                <Input value={keyForm.baseUrl} onChange={(e) => setKeyForm((f) => ({ ...f, baseUrl: e.target.value }))} dir="ltr" placeholder="https://api.z.ai/api/paas/v4" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('trAgentKeyModel')}</Label>
              {/* 0.6.64 — display-only: the model is PINNED server-side in
                  ALL cases (glm-4.7-flash, the free flash tier on api.z.ai);
                  there is no model input to get wrong anymore. */}
              <Input value="glm-4.7-flash" readOnly dir="ltr" className="font-mono bg-muted/50 cursor-default" aria-readonly />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('trAgentKeyValue')}</Label>
              <Input
                type="password"
                value={keyForm.apiKey}
                onChange={(e) => setKeyForm((f) => ({ ...f, apiKey: e.target.value }))}
                dir="ltr"
                placeholder={keyForm.provider === 'zai' ? t('trAgentKeyZaiOptional') as any : 'sk-…'}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddKeyOpen(false)}>{t('cancel')}</Button>
            <Button onClick={addKey} disabled={savingKey} className="gap-1.5">
              {savingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dictionary entry confirm */}
      <AlertDialog open={!!deleteEntryId} onOpenChange={(open) => { if (!open) setDeleteEntryId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('trAgentDeleteEntryTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('trAgentDeleteEntryDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700 text-white" onClick={() => deleteEntryId && void deleteEntry(deleteEntryId)}>
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete API key confirm */}
      <AlertDialog open={!!deleteKeyId} onOpenChange={(open) => { if (!open) setDeleteKeyId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('trAgentDeleteKeyTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('trAgentDeleteKeyDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700 text-white" onClick={() => deleteKeyId && void deleteKey(deleteKeyId)}>
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminAgenciesManagementSectionPage>
  );
}

export default AdminTranslationAgent;
