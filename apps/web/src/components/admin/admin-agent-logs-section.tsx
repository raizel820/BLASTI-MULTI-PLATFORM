'use client';

/**
 * AdminAgentLogsSection — Translation agent ACTION TRAIL (0.6.62).
 *
 * Two consumers of the same trail (TranslationAgentLog rows, written by
 * apps/api/src/lib/translation-agent.ts on EVERY agent action):
 *
 *   1. <AdminAgentLogsSection /> — the dedicated "Translation agent" tab
 *      inside the Logs Manager: KPI tiles, action/status filters, search,
 *      paginated table, and a full detail dialog (raw JSON payload).
 *   2. <AgentCallLogCard /> — the compact per-entity call log on the
 *      Agency Category Language page: pass the category id + its term ids
 *      and it lists every agent action touching them (enqueues, batch
 *      windows that applied their translations, etc.).
 *
 * API: GET /api/translation-agent/logs
 *        ?action=&status=&q=&page=&perPage=          (manager)
 *        ?entity=<csv ids>&perPage=                  (per-entity card —
 *          matches refId IN (ids) OR details containing the id)
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { TranslationKeys } from '@/i18n';

// ─── Types (mirror the TranslationAgentLog model) ────────────────────────────

interface AgentLogRow {
  id: string;
  action: string;
  status: string;
  summary: string;
  details: string | null;
  refType: string | null;
  refId: string | null;
  actor: string;
  provider: string | null;
  durationMs: number | null;
  createdAt: string;
}

interface LogsPayload {
  logs: AgentLogRow[];
  total: number;
  page: number;
  perPage: number;
  counts: { total: number; errors: number; last24h: number };
  byAction: Record<string, number>;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** action → i18n label key (unknown actions fall back to the raw code). */
const ACTION_LABEL_KEYS: Record<string, TranslationKeys> = {
  ENQUEUE_AGENCY: 'agentLogActionEnqueueAgency',
  ENQUEUE_CATEGORY: 'agentLogActionEnqueueCategory',
  CREATE_CATEGORY: 'agentLogActionCreateCategory',
  BATCH_RUN: 'agentLogActionBatchRun',
  BATCH_FAIL: 'agentLogActionBatchFail',
  KEY_TEST: 'agentLogActionKeyTest',
  PROCESS_NOW: 'agentLogActionProcessNow',
  SETTINGS_UPDATE: 'agentLogActionSettingsUpdate',
  KEY_CREATE: 'agentLogActionKeyCreate',
  KEY_UPDATE: 'agentLogActionKeyUpdate',
  KEY_DELETE: 'agentLogActionKeyDelete',
  DICTIONARY_EDIT: 'agentLogActionDictionaryEdit',
  DICTIONARY_DELETE: 'agentLogActionDictionaryDelete',
  LOGS_EXPORT: 'agentLogActionLogsExport',
};

function actionLabelKey(action: string): TranslationKeys {
  return ACTION_LABEL_KEYS[action] ?? ('agentLogActionUnknown' as TranslationKeys);
}

const STATUS_STYLES: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900',
  error: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900',
  info: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
};

const STATUS_DOT: Record<string, string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  info: 'bg-slate-400 dark:bg-slate-500',
};

function statusLabelKey(status: string): TranslationKeys {
  if (status === 'error') return 'agentLogStatusError';
  if (status === 'info') return 'agentLogStatusInfo';
  return 'agentLogStatusSuccess';
}

/** Date-range presets shared by the list fetch and the batch download. */
const RANGE_OPTIONS = ['all', '1h', '24h', '7d', '30d'] as const;
type RangeOption = (typeof RANGE_OPTIONS)[number];

function rangeLabelKey(range: string): TranslationKeys {
  if (range === '1h') return 'agentLogRange1h';
  if (range === '24h') return 'agentLogRange24h';
  if (range === '7d') return 'agentLogRange7d';
  if (range === '30d') return 'agentLogRange30d';
  return 'agentLogRangeAll';
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** apiClient auto-unwraps `{ success, data }` envelopes — accept both shapes. */
function unwrapData<T>(payload: unknown): T | null {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return ((payload as { data?: unknown }).data ?? null) as T | null;
  }
  return (payload as T) ?? null;
}

function prettyDetails(row: AgentLogRow): string {
  if (!row.details) return '—';
  try {
    return JSON.stringify(JSON.parse(row.details), null, 2);
  } catch {
    return row.details;
  }
}

const ACTION_BADGE_STYLES: Record<string, string> = {
  BATCH_RUN: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  BATCH_FAIL: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  ENQUEUE_AGENCY: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  ENQUEUE_CATEGORY: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900',
  CREATE_CATEGORY: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  KEY_TEST: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900',
};

function ActionBadge({ action, label }: { action: string; label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] font-semibold whitespace-nowrap', ACTION_BADGE_STYLES[action] ?? '')}
    >
      {label}
    </Badge>
  );
}

// ─── Logs Manager tab ────────────────────────────────────────────────────────

const PER_PAGE = 25;

export function AdminAgentLogsSection() {
  const { t } = useLanguage();

  const [payload, setPayload] = useState<LogsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('all');
  const [status, setStatus] = useState('all');
  const [range, setRange] = useState<RangeOption>('all');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [detail, setDetail] = useState<AgentLogRow | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState<'csv' | 'json' | 'txt' | null>(null);

  /** Query string carrying the CURRENT filters — the download must match
   *  exactly what the table shows (type, status, search, date range). */
  const currentFilterQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (action !== 'all') p.set('action', action);
    if (status !== 'all') p.set('status', status);
    if (range !== 'all') p.set('range', range);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
  }, [action, status, range, q]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('page', String(page));
      p.set('perPage', String(PER_PAGE));
      const filters = currentFilterQuery();
      const res = await apiFetch(`/api/translation-agent/logs?${filters ? `${filters}&` : ''}${p.toString()}`);
      const body = await res.json().catch(() => null);
      const data = res.ok ? unwrapData<LogsPayload>(body) : null;
      if (data) setPayload(data);
    } catch {
      /* keep the last payload */
    } finally {
      setLoading(false);
    }
  }, [page, currentFilterQuery]);

  // Initial + filter/page-driven fetch.
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Light auto-refresh while visible (60s) — matches the manager's rhythm.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchData();
    }, 60_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const doCopy = async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* non-fatal */ }
  };

  /**
   * 0.6.65 — BATCH DOWNLOAD: one request downloads EVERY log row matching
   * the current filters + date range (up to the server cap) as csv/json/txt
   * — no more copying single reports action by action.
   */
  const downloadLogs = async (format: 'csv' | 'json' | 'txt') => {
    setDownloading(format);
    try {
      const res = await apiFetch(`/api/translation-agent/logs/export?${currentFilterQuery()}${currentFilterQuery() ? '&' : ''}format=${format}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const errText = (body as { error?: unknown } | null)?.error;
        toast.error(String(typeof errText === 'string' && errText ? errText : t('error')));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `blasti-agent-logs_${action !== 'all' ? action : 'all-actions'}_${status !== 'all' ? status : 'all-statuses'}_${range}_${stamp}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast.success(t('agentLogDownloaded') as any);
    } catch {
      toast.error(t('error') as any);
    } finally {
      setDownloading(null);
    }
  };

  const counts = payload?.counts ?? { total: 0, errors: 0, last24h: 0 };
  const byAction = payload?.byAction ?? {};
  const pages = Math.max(1, Math.ceil((payload?.total ?? 0) / PER_PAGE));

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('agentLogKpiTotal')}</p>
            <p className="text-2xl font-bold" dir="ltr">{counts.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('agentLogKpiLast24h')}</p>
            <p className="text-2xl font-bold" dir="ltr">{counts.last24h}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('agentLogKpiErrors')}</p>
            <p className={cn('text-2xl font-bold', counts.errors > 0 ? 'text-red-600 dark:text-red-400' : '')} dir="ltr">
              {counts.errors}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('agentLogKpiTypes')}</p>
            <p className="text-2xl font-bold" dir="ltr">{Object.keys(byAction).length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="h-8 w-8 rounded-lg bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center shrink-0">
              <Bot className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-sm">{t('agentLogTitle')}</CardTitle>
              <CardDescription className="text-[11px] truncate">{t('agentLogDesc')}</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void fetchData()} disabled={loading} className="shrink-0 h-8">
              {loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
              {t('refresh')}
            </Button>
            {/* 0.6.65 — BATCH DOWNLOAD: the WHOLE filtered trail in one file,
                respecting the exact filters + date range shown below. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={downloading !== null} className="shrink-0 h-8 gap-1.5">
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin me-0.5" /> : <Download className="h-4 w-4 me-0.5" />}
                  {t('download')}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <p className="px-2 py-1.5 text-[11px] text-muted-foreground leading-4">{t('agentLogDownloadHint')}</p>
                <DropdownMenuItem onClick={() => void downloadLogs('csv')} disabled={downloading !== null}>
                  <span className="font-mono text-[11px] w-10 shrink-0">CSV</span>
                  <span className="text-[11px] text-muted-foreground">Excel</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void downloadLogs('json')} disabled={downloading !== null}>
                  <span className="font-mono text-[11px] w-10 shrink-0">JSON</span>
                  <span className="text-[11px] text-muted-foreground">raw / backup</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void downloadLogs('txt')} disabled={downloading !== null}>
                  <span className="font-mono text-[11px] w-10 shrink-0">TXT</span>
                  <span className="text-[11px] text-muted-foreground">{t('agentLogDownloadReport')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={action}
              onValueChange={(v) => { setAction(v); setPage(1); }}
            >
              <SelectTrigger className="w-full sm:w-52 h-9" aria-label={t('agentLogFilterAction')}>
                <SelectValue placeholder={t('agentLogFilterAction')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('agentLogAllActions')}</SelectItem>
                {Object.entries(byAction).map(([a, count]) => (
                  <SelectItem key={a} value={a}>
                    <span className="flex items-center gap-2">
                      {t(actionLabelKey(a))}
                      <span className="text-[10px] text-muted-foreground" dir="ltr">×{count}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => { setStatus(v); setPage(1); }}
            >
              <SelectTrigger className="w-full sm:w-40 h-9" aria-label={t('agentLogFilterStatus')}>
                <SelectValue placeholder={t('agentLogFilterStatus')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('agentLogAllStatuses')}</SelectItem>
                <SelectItem value="success">{t('agentLogStatusSuccess')}</SelectItem>
                <SelectItem value="error">{t('agentLogStatusError')}</SelectItem>
                <SelectItem value="info">{t('agentLogStatusInfo')}</SelectItem>
              </SelectContent>
            </Select>
            {/* 0.6.65 — date-range filter: applies to the table AND the batch
                download (e.g. "failed, last 24 hours"). */}
            <Select
              value={range}
              onValueChange={(v) => { setRange(v as RangeOption); setPage(1); }}
            >
              <SelectTrigger className="w-full sm:w-44 h-9" aria-label={t('agentLogRange')}>
                <SelectValue placeholder={t('agentLogRange')} />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>{t(rangeLabelKey(r))}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
              <Input
                value={qLive}
                onChange={(e) => setQLive(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { setQ(qLive); setPage(1); } }}
                placeholder={t('agentLogSearchPlaceholder')}
                className="h-9"
                dir="auto"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                onClick={() => { setQ(qLive); setPage(1); }}
                aria-label={t('agentLogSearchPlaceholder')}
              >
                <Search className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Table */}
          {loading && !payload ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin me-2" />{t('loading')}
            </div>
          ) : !payload || payload.logs.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">{t('agentLogEmpty')}</div>
          ) : (
            <div className="rounded-xl border overflow-hidden">
              <div className="max-h-[55vh] overflow-y-auto custom-scrollbar">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">{t('agentLogColTime')}</TableHead>
                      <TableHead className="w-44">{t('agentLogColAction')}</TableHead>
                      <TableHead className="w-20">{t('agentLogColStatus')}</TableHead>
                      <TableHead>{t('agentLogColSummary')}</TableHead>
                      <TableHead className="w-32">{t('agentLogColActor')}</TableHead>
                      <TableHead className="w-24">{t('agentLogColProvider')}</TableHead>
                      <TableHead className="w-20 text-end">{t('agentLogColDuration')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payload.logs.map((row) => (
                      <TableRow
                        key={row.id}
                        className="cursor-pointer"
                        onClick={() => setDetail(row)}
                      >
                        <TableCell><span className="text-[11px] text-muted-foreground" dir="ltr">{fmtTime(row.createdAt)}</span></TableCell>
                        <TableCell><ActionBadge action={row.action} label={t(actionLabelKey(row.action))} /></TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[10px]', STATUS_STYLES[row.status] ?? '')}>
                            {t(statusLabelKey(row.status))}
                          </Badge>
                        </TableCell>
                        <TableCell><span className="text-xs line-clamp-2" dir="auto">{row.summary}</span></TableCell>
                        <TableCell><span className="text-[10px] font-mono text-muted-foreground" dir="ltr">{row.actor}</span></TableCell>
                        <TableCell><span className="text-[10px] text-muted-foreground" dir="ltr">{row.provider || '—'}</span></TableCell>
                        <TableCell className="text-end"><span className="text-[10px] text-muted-foreground" dir="ltr">{fmtDuration(row.durationMs)}</span></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* Pagination */}
          {payload && payload.total > PER_PAGE && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-[11px] text-muted-foreground" dir="ltr">
                {t('agentLogPageOf', { page: String(page), pages: String(pages) })}
                {' · '}
                {payload.total}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((v) => Math.max(1, v - 1))} aria-label={t('agentLogPrev')}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= pages} onClick={() => setPage((v) => Math.min(pages, v + 1))} aria-label={t('agentLogNext')}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <Sparkles className="h-4 w-4 text-teal-600 dark:text-teal-400 shrink-0" />
              {detail ? t(actionLabelKey(detail.action)) : t('loading')}
              {detail && (
                <Badge variant="outline" className={cn('text-[10px]', STATUS_STYLES[detail.status] ?? '')}>
                  {t(statusLabelKey(detail.status))}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-[11px] font-mono" dir="ltr">
              {detail ? `${detail.action}${detail.refType ? ` · ${detail.refType}` : ''}${detail.refId ? ` · ${detail.refId.slice(0, 12)}…` : ''}` : ''}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <p className="text-xs leading-5" dir="auto">{detail.summary}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <div className="rounded-lg border p-2">
                  <span className="text-muted-foreground block">{t('agentLogColTime')}</span>
                  <span dir="ltr">{fmtTime(detail.createdAt)}</span>
                </div>
                <div className="rounded-lg border p-2">
                  <span className="text-muted-foreground block">{t('agentLogColActor')}</span>
                  <span className="font-mono" dir="ltr">{detail.actor}</span>
                </div>
                <div className="rounded-lg border p-2">
                  <span className="text-muted-foreground block">{t('agentLogColProvider')}</span>
                  <span dir="ltr">{detail.provider || '—'}</span>
                </div>
                <div className="rounded-lg border p-2">
                  <span className="text-muted-foreground block">{t('agentLogColDuration')}</span>
                  <span dir="ltr">{fmtDuration(detail.durationMs)}</span>
                </div>
              </div>
              <div>
                <p className="text-[11px] font-semibold mb-1">{t('agentLogDetails')}</p>
                <pre className="text-[11px] leading-4 font-mono whitespace-pre-wrap break-all bg-muted/50 rounded-lg p-3 max-h-64 overflow-y-auto border" dir="ltr">
                  {prettyDetails(detail)}
                </pre>
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => void doCopy(prettyDetails(detail))}>
                  {copied ? <Check className="h-3.5 w-3.5 me-1" /> : <Copy className="h-3.5 w-3.5 me-1" />}
                  {copied ? t('copied') : t('copy')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Per-entity call log (Category Language page) ────────────────────────────

interface AgentCallLogCardProps {
  /** Category id + term ids — the agent actions touching ANY of them. */
  entityIds: string[];
  /** Bump to force a refetch (e.g. right after "translate via agent"). */
  refreshSignal?: number;
}

export function AgentCallLogCard({ entityIds, refreshSignal = 0 }: AgentCallLogCardProps) {
  const { t } = useLanguage();

  const [logs, setLogs] = useState<AgentLogRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Stable identity: the entity list is joined into ONE csv string so the
  // fetch callback (and its effect) do not re-fire on every parent render.
  const entityKey = entityIds.join(',');

  const fetchLogs = useCallback(async () => {
    if (!entityKey) {
      setLogs([]);
      return;
    }
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('entity', entityKey.slice(0, 4000));
      p.set('perPage', '15');
      const res = await apiFetch(`/api/translation-agent/logs?${p.toString()}`);
      const body = await res.json().catch(() => null);
      const data = res.ok ? unwrapData<LogsPayload>(body) : null;
      setLogs(data?.logs ?? []);
    } catch {
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [entityKey]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs, refreshSignal]);

  return (
    <Card className="border-teal-200/70 dark:border-teal-900/50">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="h-8 w-8 rounded-lg bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center shrink-0">
            <Bot className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm flex items-center gap-1.5">
              {t('catLangAgentLogTitle')}
            </CardTitle>
            <CardDescription className="text-[11px]">{t('catLangAgentLogDesc')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => void fetchLogs()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
            {t('refresh')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {!logs || logs.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            {loading ? (
              <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('loading')}</span>
            ) : (
              t('catLangAgentLogEmpty')
            )}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto custom-scrollbar divide-y rounded-xl border">
            {logs.map((row) => (
              <div key={row.id} className="p-2.5">
                <button
                  type="button"
                  className="w-full flex items-start gap-2 text-start cursor-pointer"
                  onClick={() => setExpanded((v) => (v === row.id ? null : row.id))}
                >
                  <span className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', STATUS_DOT[row.status] ?? 'bg-slate-400')} aria-hidden />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <ActionBadge action={row.action} label={t(actionLabelKey(row.action))} />
                      <span className="text-[10px] text-muted-foreground" dir="ltr">{fmtTime(row.createdAt)}</span>
                      {row.durationMs !== null && (
                        <span className="text-[10px] text-muted-foreground" dir="ltr">· {fmtDuration(row.durationMs)}</span>
                      )}
                    </div>
                    <p className="text-[11px] leading-4 text-foreground/90 line-clamp-2 mt-0.5" dir="auto">{row.summary}</p>
                  </div>
                  <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded === row.id && 'rotate-180')} />
                </button>
                {expanded === row.id && (
                  <pre className="mt-2 text-[10px] leading-4 font-mono whitespace-pre-wrap break-all bg-muted/50 rounded-lg p-2.5 max-h-40 overflow-y-auto border" dir="ltr">
                    {prettyDetails(row)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
