'use client';

/**
 * AdminLogsExportDialog — the "Create / update download" composer (0.6.66).
 *
 * ONE dialog serves every download entry point of the Logs Manager:
 *
 *   • per-tab buttons — scope="errors" | "daily" | "raw" | "agent" | "server"
 *     (the log type is locked to that tab; the filter set adapts)
 *   • the Overview "Advanced export" button — scope="advanced"
 *     (log TYPES multi-select + ANALYZE type + every filter, in a bordered
 *     prominent dialog per the user request)
 *
 * The admin tunes any parameter — time range (presets or custom), platform,
 * account type/role, uid, device, app version, severity, trigger, agent
 * action/status, server sources, row limit, old-log deep scan — and the
 * backend route GET /api/logs/analysis/export composes the FINAL file
 * (json | md | csv | ndjson). Pressing "Create & download" again after
 * tweaking a filter re-generates ("update") the file with the new params.
 *
 * Old-logs handling: the "Include old logs" switch (deep=1) replays day-files
 * older than the live 3-day analyzer window into the index before the export
 * is built, and raw exports always walk the WHOLE vault (legacy flat layout
 * included) — nothing stored on the server is invisible to the export.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  Check,
  Download,
  FileJson,
  FileText,
  Loader2,
  ScrollText,
  Server,
  Siren,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { TranslationKeys } from '@/i18n';

export type LogsExportScope = 'errors' | 'daily' | 'raw' | 'agent' | 'server' | 'advanced';
export type LogsExportFormat = 'json' | 'md' | 'csv' | 'ndjson';

export interface LogsExportServerSource {
  id: string;
  label: string;
  kind: 'journal' | 'file';
  available: boolean;
}

interface LogsExportDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scope: LogsExportScope;
  /** Live trigger slugs (summary.byTrigger) merged into the trigger select. */
  triggerOptions?: string[];
  /** Live agent action slugs (byAction) merged into the action select. */
  agentActionOptions?: string[];
  /** Pre-filled state from the calling tab (its current filters). */
  defaults?: Partial<{
    uid: string;
    platform: string;
    role: string;
    appVersion: string;
    device: string;
    severity: string;
    trigger: string;
    minCount: string;
    q: string;
    from: string;
    to: string;
    action: string;
    status: string;
    serverSources: string[];
    serverLines: string;
    level: string;
  }>;
  /** Server sources pre-fetched by the host tab; the dialog fetches lazily when absent. */
  serverSources?: LogsExportServerSource[];
}

interface ExportState {
  types: string[];
  analyze: 'raw' | 'report' | 'summary';
  format: LogsExportFormat;
  range: 'all' | '1h' | '24h' | '7d' | '30d' | 'custom';
  from: string;
  to: string;
  platform: string;
  role: string;
  uid: string;
  device: string;
  appVersion: string;
  severity: string;
  trigger: string;
  minCount: string;
  q: string;
  level: string;
  limit: string;
  agentAction: string;
  agentStatus: string;
  serverSources: string[];
  serverLines: string;
  deep: boolean;
}

const ALL_TYPES = ['errors', 'daily', 'raw', 'agent', 'server'] as const;

const PLATFORMS = ['web', 'mobile', 'desktop', 'kiosk', 'tv', 'legacy'] as const;
/** STAFF + AGENCY_STAFF both listed — old logs carry the legacy label. */
const ROLES = ['SUPER_ADMIN', 'AGENCY_OWNER', 'STAFF', 'AGENCY_STAFF', 'CUSTOMER', 'DEVICE', 'ANONYMOUS'] as const;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const AGENT_ACTIONS = [
  'ENQUEUE_AGENCY', 'ENQUEUE_CATEGORY', 'CREATE_CATEGORY', 'BATCH_RUN', 'BATCH_FAIL',
  'KEY_TEST', 'PROCESS_NOW', 'SETTINGS_UPDATE', 'KEY_CREATE', 'KEY_UPDATE',
  'KEY_DELETE', 'DICTIONARY_EDIT', 'DICTIONARY_DELETE', 'LOGS_EXPORT',
] as const;
const AGENT_STATUSES = ['success', 'error', 'info'] as const;

const SCOPE_BASE: Record<LogsExportScope, Partial<ExportState>> = {
  errors: { types: ['errors'], analyze: 'report', format: 'md' },
  daily: { types: ['daily'], analyze: 'raw', format: 'json' },
  raw: { types: ['raw'], analyze: 'raw', format: 'json' },
  agent: { types: ['agent'], analyze: 'raw', format: 'csv' },
  server: { types: ['server'], analyze: 'raw', format: 'md' },
  advanced: { types: [...ALL_TYPES], analyze: 'raw', format: 'json' },
};

const BASE_STATE: ExportState = {
  types: [...ALL_TYPES],
  analyze: 'raw',
  format: 'json',
  range: 'all',
  from: '',
  to: '',
  platform: '',
  role: '',
  uid: '',
  device: '',
  appVersion: '',
  severity: '',
  trigger: '',
  minCount: '',
  q: '',
  level: '',
  limit: '',
  agentAction: '',
  agentStatus: '',
  serverSources: [],
  serverLines: '300',
  deep: false,
};

const SCOPE_TITLE_KEY: Record<LogsExportScope, TranslationKeys> = {
  errors: 'logsExportScopeErrors',
  daily: 'logsExportScopeDaily',
  raw: 'logsExportScopeRaw',
  agent: 'logsExportScopeAgent',
  server: 'logsExportScopeServer',
  advanced: 'logsExportAdvancedTitle',
};

const TYPE_ICON: Record<string, typeof Siren> = {
  errors: Siren,
  daily: CalendarDays,
  raw: ScrollText,
  agent: Bot,
  server: Server,
};

const TYPE_LABEL_KEY: Record<string, TranslationKeys> = {
  errors: 'logsExportTypeErrors',
  daily: 'logsExportTypeDaily',
  raw: 'logsExportTypeRaw',
  agent: 'logsExportTypeAgent',
  server: 'logsExportTypeServer',
};

export function AdminLogsExportDialog({
  open,
  onOpenChange,
  scope,
  triggerOptions = [],
  agentActionOptions = [],
  defaults,
  serverSources: serverSourcesProp,
}: LogsExportDialogProps) {
  const { t } = useLanguage();
  const advanced = scope === 'advanced';

  const [state, setState] = useState<ExportState>(BASE_STATE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadedOnce, setDownloadedOnce] = useState(false);
  const [sources, setSources] = useState<LogsExportServerSource[]>(serverSourcesProp ?? []);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  const set = useCallback(<K extends keyof ExportState>(key: K, value: ExportState[K]) => {
    setState((s) => ({ ...s, [key]: value }));
  }, []);

  // Reset to the scope defaults (plus the calling tab's filters) on open.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDownloadedOnce(false);
    setState({
      ...BASE_STATE,
      ...SCOPE_BASE[scope],
      types: [...(SCOPE_BASE[scope].types ?? [])],
      ...defaults,
      serverSources: defaults?.serverSources ? [...defaults.serverSources] : [],
    });
  }, [open, scope, defaults]);

  const serverTypeSelected = state.types.includes('server');

  // Lazy server sources fetch (advanced dialog / scoped server without props).
  useEffect(() => {
    if (!open || !serverTypeSelected || (serverSourcesProp && serverSourcesProp.length > 0)) return;
    let cancelled = false;
    setSourcesLoading(true);
    (async () => {
      try {
        const res = await apiFetch('/api/logs-server/sources');
        const data = await res.json().catch(() => null);
        if (!cancelled && res.ok && data?.success) {
          setSources([
            ...(data.units ?? []).filter((u: LogsExportServerSource) => u.available),
            ...(data.files ?? []),
          ]);
        }
      } catch { /* sources stay empty */ } finally {
        if (!cancelled) setSourcesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, serverTypeSelected, serverSourcesProp]);

  // ── Which filter blocks are visible for the selected types ──
  const show = {
    errors: state.types.includes('errors'),
    daily: state.types.includes('daily'),
    raw: state.types.includes('raw'),
    agent: state.types.includes('agent'),
    server: serverTypeSelected,
  };
  const anyVaultType = show.errors || show.daily || show.raw;

  const csvAllowed = state.types.length === 1;
  const ndjsonAllowed = state.types.length === 1 && state.types[0] === 'raw';
  const deepRelevant = show.errors || show.daily;

  const triggerChoices = useMemo(() => {
    const set = new Set<string>([...triggerOptions]);
    return [...set].sort();
  }, [triggerOptions]);

  const actionChoices = useMemo(() => {
    const set = new Set<string>([...AGENT_ACTIONS, ...agentActionOptions]);
    return [...set].sort();
  }, [agentActionOptions]);

  const buildQuery = useCallback((): string => {
    const p = new URLSearchParams();
    p.set('types', state.types.join(','));
    p.set('analyze', state.analyze);
    p.set('format', state.format);
    if (state.range === 'custom') {
      if (state.from) p.set('from', state.from);
      if (state.to) p.set('to', state.to);
    } else {
      p.set('range', state.range);
    }
    // Shared vault filters (errors + daily + raw use them).
    if (anyVaultType) {
      if (state.platform) p.set('platform', state.platform);
      if (state.role) p.set('role', state.role);
      if (state.uid) p.set('uid', state.uid);
      if (state.q) p.set('q', state.q);
      if (state.limit) p.set('limit', state.limit);
    }
    if (show.raw) {
      if (state.device) p.set('device', state.device);
      if (state.appVersion) p.set('appVersion', state.appVersion);
      if (state.level) p.set('level', state.level);
    }
    if (show.errors) {
      if (state.severity) p.set('severity', state.severity);
      if (state.trigger) p.set('trigger', state.trigger);
      if (state.minCount) p.set('minCount', state.minCount);
    }
    if (show.agent) {
      if (state.agentAction) p.set('action', state.agentAction);
      if (state.agentStatus) p.set('status', state.agentStatus);
      if (state.q) p.set('q', state.q);
      if (state.limit) p.set('limit', state.limit);
    }
    if (show.server) {
      if (state.serverSources.length > 0) p.set('serverSources', state.serverSources.join(','));
      if (state.serverLines) p.set('serverLines', state.serverLines);
      if (state.level) p.set('level', state.level);
      if (state.q) p.set('q', state.q);
      if (state.range === 'custom') {
        if (state.from) p.set('from', state.from);
        if (state.to) p.set('to', state.to);
      } else if (state.range !== 'all') {
        p.set('range', state.range);
      }
    }
    if (state.deep && deepRelevant) p.set('deep', '1');
    return p.toString();
  }, [state, anyVaultType, show.errors, show.raw, show.agent, show.server, deepRelevant]);

  const doDownload = useCallback(async () => {
    if (state.types.length === 0) {
      setError(t('logsExportNoTypes'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/logs/analysis/export?${buildQuery()}`);
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch { /* plain status */ }
        setError(msg);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers?.get?.('content-disposition') || '';
      const m = /filename="?([^";]+)"?/.exec(cd);
      const name = m?.[1] || `blasti-logs-export-${Date.now()}.${state.format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDownloadedOnce(true);
      toast.success(t('logsExportStarted'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  }, [state.types, state.format, buildQuery, t]);

  const toggleType = (type: string) => {
    setState((s) => {
      const has = s.types.includes(type);
      const next = has ? s.types.filter((x) => x !== type) : [...s.types, type];
      // Keep a stable order for the filename/query.
      next.sort((a, b) => ALL_TYPES.indexOf(a as typeof ALL_TYPES[number]) - ALL_TYPES.indexOf(b as typeof ALL_TYPES[number]));
      // Format constraints: csv needs exactly one type, ndjson only raw.
      let format = s.format;
      if (format === 'csv' && next.length !== 1) format = 'json';
      if (format === 'ndjson' && !(next.length === 1 && next[0] === 'raw')) format = 'json';
      return { ...s, types: next, format };
    });
  };

  const toggleSource = (id: string) => {
    setState((s) => ({
      ...s,
      serverSources: s.serverSources.includes(id)
        ? s.serverSources.filter((x) => x !== id)
        : [...s.serverSources, id],
    }));
  };

  const selectAllSources = () => {
    setState((s) => ({ ...s, serverSources: s.serverSources.length > 0 ? [] : sources.filter((x) => x.available).map((x) => x.id) }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto custom-scrollbar">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            {t(SCOPE_TITLE_KEY[scope])}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {advanced ? t('logsExportAdvancedDesc') : t('logsExportDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ── Log types (advanced) ── */}
          {advanced && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold">{t('logsExportLogTypes')}</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ALL_TYPES.map((type) => {
                  const Icon = TYPE_ICON[type];
                  const checked = state.types.includes(type);
                  return (
                    <label
                      key={type}
                      className={cn(
                        'flex items-center gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors text-xs',
                        checked
                          ? 'border-violet-300 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40'
                          : 'hover:bg-muted/60',
                      )}
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleType(type)} />
                      {Icon && <Icon className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400 shrink-0" />}
                      <span className="truncate">{t(TYPE_LABEL_KEY[type])}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Analyze type (advanced) ── */}
          {advanced && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">{t('logsExportAnalyze')}</Label>
                <Select value={state.analyze} onValueChange={(v) => set('analyze', v as ExportState['analyze'])}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="raw">{t('logsExportAnalyzeRaw')}</SelectItem>
                    <SelectItem value="report">{t('logsExportAnalyzeReport')}</SelectItem>
                    <SelectItem value="summary">{t('logsExportAnalyzeSummary')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold">{t('logsExportFormat')}</Label>
                <Select value={state.format} onValueChange={(v) => set('format', v as LogsExportFormat)}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json" dir="ltr">JSON (.json)</SelectItem>
                    <SelectItem value="md" dir="ltr">Markdown (.md)</SelectItem>
                    <SelectItem value="csv" disabled={!csvAllowed} dir="ltr">CSV (.csv){!csvAllowed ? ` — ${t('logsExportCsvSingle')}` : ''}</SelectItem>
                    <SelectItem value="ndjson" disabled={!ndjsonAllowed} dir="ltr">NDJSON (.ndjson){!ndjsonAllowed ? ` — raw only` : ''}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* ── Time range ── */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold">{t('logsExportTimeRange')}</Label>
            <div className="flex flex-wrap gap-1.5">
              {(['all', '1h', '24h', '7d', '30d', 'custom'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => set('range', r)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[11px] transition-colors',
                    state.range === r
                      ? 'border-violet-400 bg-violet-100 text-violet-800 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-200'
                      : 'hover:bg-muted/60',
                  )}
                >
                  {t(`logsExportRange${r.charAt(0).toUpperCase()}${r.slice(1)}` as TranslationKeys)}
                </button>
              ))}
            </div>
            {state.range === 'custom' && (
              <div className="flex items-center gap-2 flex-wrap">
                <Input type="date" value={state.from} onChange={(e) => set('from', e.target.value)} className="w-40 h-9" dir="ltr" title={t('logsManagerFilterFrom')} />
                <span className="text-xs text-muted-foreground">→</span>
                <Input type="date" value={state.to} onChange={(e) => set('to', e.target.value)} className="w-40 h-9" dir="ltr" title={t('logsManagerFilterTo')} />
              </div>
            )}
          </div>

          <Separator />

          {/* ── Vault filters (errors / daily / raw) ── */}
          {anyVaultType && (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{t('logsExportFilters')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterPlatform')}</Label>
                  <Select value={state.platform || 'all'} onValueChange={(v) => set('platform', v === 'all' ? '' : v)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                      {PLATFORMS.map((p) => <SelectItem key={p} value={p} dir="ltr">{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t('logsExportAccountType')}</Label>
                  <Select value={state.role || 'all'} onValueChange={(v) => set('role', v === 'all' ? '' : v)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                      {ROLES.map((r) => <SelectItem key={r} value={r} dir="ltr">{r}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                {show.errors && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('logsManagerSeverity')}</Label>
                    <Select value={state.severity || 'all'} onValueChange={(v) => set('severity', v === 'all' ? '' : v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                        {SEVERITIES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {show.errors && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterTrigger')}</Label>
                    <Select value={state.trigger || 'all'} onValueChange={(v) => set('trigger', v === 'all' ? '' : v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                        {triggerChoices.map((s) => <SelectItem key={s} value={s} dir="ltr">{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterUid')}</Label>
                  <Input value={state.uid} onChange={(e) => set('uid', e.target.value)} className="h-9" dir="ltr" />
                </div>
                {show.raw && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterDevice')}</Label>
                    <Input value={state.device} onChange={(e) => set('device', e.target.value)} className="h-9" dir="ltr" />
                  </div>
                )}
                {show.raw && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterVersion')}</Label>
                    <Input value={state.appVersion} onChange={(e) => set('appVersion', e.target.value)} className="h-9" dir="ltr" />
                  </div>
                )}
                {show.errors && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterMinCount')}</Label>
                    <Input value={state.minCount} onChange={(e) => set('minCount', e.target.value.replace(/\D/g, ''))} className="h-9" dir="ltr" />
                  </div>
                )}
                {(show.raw || show.server) && (
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">{t('logsExportLevel')}</Label>
                    <Select value={state.level || 'all'} onValueChange={(v) => set('level', v === 'all' ? '' : v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                        {LEVELS.map((l) => <SelectItem key={l} value={l} dir="ltr">{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Agent filters ── */}
          {show.agent && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{t('logsManagerTabAgent')}</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t('logsExportAction')}</Label>
                  <Select value={state.agentAction || 'all'} onValueChange={(v) => set('agentAction', v === 'all' ? '' : v)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                      {actionChoices.map((a) => <SelectItem key={a} value={a} dir="ltr">{a}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-muted-foreground">{t('logsExportStatus')}</Label>
                  <Select value={state.agentStatus || 'all'} onValueChange={(v) => set('agentStatus', v === 'all' ? '' : v)}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                      {AGENT_STATUSES.map((s) => <SelectItem key={s} value={s} dir="ltr">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* ── Server filters ── */}
          {show.server && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{t('logsExportServerSources')}</p>
                <Button type="button" variant="ghost" size="sm" className="h-6 text-[11px]" onClick={selectAllSources}>
                  {state.serverSources.length > 0 ? t('logsExportSourcesClear') : t('logsExportSourcesAll')}
                </Button>
              </div>
              {sourcesLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />{t('loading')}
                </div>
              ) : sources.length === 0 ? (
                <p className="text-[11px] text-muted-foreground py-1">{t('logsExportNoServerSources')}</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-40 overflow-y-auto custom-scrollbar">
                  {sources.map((src) => {
                    const checked = state.serverSources.includes(src.id);
                    return (
                      <label
                        key={src.id}
                        className={cn(
                          'flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors text-[11px] font-mono',
                          checked ? 'border-violet-300 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/40' : 'hover:bg-muted/60',
                        )}
                        dir="ltr"
                      >
                        <Checkbox checked={checked} onCheckedChange={() => toggleSource(src.id)} />
                        {src.kind === 'journal' ? <Server className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
                        <span className="truncate">{src.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="w-36">
                <Label className="text-[11px] text-muted-foreground">{t('logsExportServerLines')}</Label>
                <Input value={state.serverLines} onChange={(e) => set('serverLines', e.target.value.replace(/\D/g, ''))} className="h-9" dir="ltr" />
              </div>
            </div>
          )}

          {/* ── Search + limit + deep scan ── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-[11px] text-muted-foreground">{t('logsManagerFilterQuery')}</Label>
              <Input value={state.q} onChange={(e) => set('q', e.target.value)} className="h-9" dir="ltr" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">{t('logsExportRowLimit')}</Label>
              <Input value={state.limit} onChange={(e) => set('limit', e.target.value.replace(/\D/g, ''))} placeholder="5000" className="h-9" dir="ltr" />
            </div>
          </div>

          {/* ── Old logs deep scan ── */}
          {(deepRelevant || advanced) && (
            <div className={cn(
              'rounded-lg border p-3 space-y-1.5',
              state.deep ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30' : '',
            )}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    {t('logsExportDeep')}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{t('logsExportDeepHint')}</p>
                </div>
                <Switch checked={state.deep} onCheckedChange={(v) => set('deep', v)} />
              </div>
            </div>
          )}

          {/* ── Raw always full-history note ── */}
          {show.raw && (
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <FileJson className="h-3.5 w-3.5 shrink-0 mt-px" />
              {t('logsExportOldIncluded')}
            </p>
          )}

          {!advanced && (
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">{t('logsExportFormat')}</Label>
              <Select value={state.format} onValueChange={(v) => set('format', v as LogsExportFormat)}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="json" dir="ltr">JSON (.json)</SelectItem>
                  <SelectItem value="md" dir="ltr">Markdown (.md)</SelectItem>
                  <SelectItem value="csv" disabled={!csvAllowed} dir="ltr">CSV (.csv)</SelectItem>
                  {ndjsonAllowed && <SelectItem value="ndjson" dir="ltr">NDJSON (.ndjson)</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40 p-2.5">
              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-px" />
              <p className="text-[11px] text-red-700 dark:text-red-300 break-all" dir="ltr">{error}</p>
            </div>
          )}

          {/* ── Footer ── */}
          <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
            <div className="flex items-center gap-1 flex-wrap">
              {state.types.map((ty) => (
                <Badge key={ty} variant="outline" className="text-[10px] uppercase" dir="ltr">{ty}</Badge>
              ))}
              {state.deep && deepRelevant && (
                <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900">
                  deep
                </Badge>
              )}
            </div>
            <Button
              onClick={() => void doDownload()}
              disabled={busy || state.types.length === 0}
              className={cn('min-w-44', downloadedOnce && 'border-2 border-violet-400 dark:border-violet-600')}
              size="sm"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin me-1.5" /> : downloadedOnce ? <Check className="h-4 w-4 me-1.5" /> : <Download className="h-4 w-4 me-1.5" />}
              {downloadedOnce ? t('logsExportUpdate') : t('logsExportDownload')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
