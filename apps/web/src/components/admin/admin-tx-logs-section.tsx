'use client';

/**
 * AdminTxLogsSection — TRANSACTION EVENT STREAM (0.6.81).
 *
 * The dedicated "Transactions" tab inside the Logs Manager. It tails the
 * unified cross-account transaction stream (logs/_transactions/<date>.ndjson)
 * that BOTH sides write into through ONE pipeline:
 *
 *   • CLIENT — the payment UIs (subscriptions page, SMS purchase dialog,
 *     hardware pay, payment result view) log the funnel through
 *     remote-logger.logTx() (tag 'tx' + channel 'transactions'); those
 *     batches ride the normal POST /api/logs ingest and are MIRRORED into
 *     the stream with the account identity resolved server-side.
 *   • SERVER — the authoritative mutations (checkout created/failed,
 *     webhook received, settlements, manual review) write through
 *     apps/api/src/lib/tx-log.ts.
 *
 * Funnel covered (user mandate): page_enter → purchase_ui_open →
 * purchase_ui_interact → checkout_* → redirect_gateway → return_received →
 * verify_poll → webhook_received → settle_* → redirect_back → result_final.
 *
 * Two views:
 *   • EVENTS — the newest raw funnel entries (filterable).
 *   • FUNNELS — one row per transaction (ref/checkoutId) with its full
 *     stage list + final status, so support sees the whole journey.
 *
 * API: GET /api/logs/transactions?stage=&txType=&status=&origin=&uid=&q=&from=&to=&limit=
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  CreditCard,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Wallet,
  ArrowLeftRight,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { AdminLogsExportDialog } from '@/components/admin/admin-logs-export-dialog';

// ─── Types (mirror apps/api/src/lib/tx-log.ts) ───────────────────────────────

interface TxEvent {
  ts: string;
  level: string;
  tag: 'tx';
  channel: 'transactions';
  origin: 'client' | 'server';
  stage: string;
  message: string;
  txType?: string;
  ref?: string;
  checkoutId?: string;
  status?: string;
  amount?: number;
  method?: string;
  uid?: string | null;
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  agencyId?: string | null;
  platform?: string;
  appVersion?: string;
  data?: Record<string, unknown>;
}

interface TxFunnel {
  ref: string | null;
  checkoutId: string | null;
  txType: string | null;
  amount: number | null;
  uid: string | null;
  agencyId: string | null;
  firstTs: string;
  lastTs: string;
  stages: string[];
  finalStatus: string | null;
  eventCount: number;
}

interface TxSummary {
  total: number;
  last24h: number;
  byStage: Record<string, number>;
  byType: Record<string, number>;
  paid: number;
  failed: number;
  pendingRefs: number;
  funnels: TxFunnel[];
}

interface TxPayload {
  entries: TxEvent[];
  scanned: number;
  files: number;
  truncated: boolean;
  summary: TxSummary;
}

// ─── Presentation constants ──────────────────────────────────────────────────

/** Stage → chip style. Money-critical stages get the loud colors. */
const STAGE_STYLES: Record<string, string> = {
  page_enter: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  purchase_ui_open: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  purchase_ui_interact: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  checkout_creating: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
  checkout_created: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  checkout_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  redirect_gateway: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  redirect_back: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  return_received: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900',
  verify_poll: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  settle_push: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  webhook_received: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  webhook_rejected: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  settle_paid: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  settle_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  settle_duplicate: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  manual_submit: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
  manual_approved: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  manual_rejected: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  result_final: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900',
};

const STAGE_ORDER = [
  'page_enter', 'purchase_ui_open', 'purchase_ui_interact',
  'checkout_creating', 'checkout_created', 'checkout_failed',
  'redirect_gateway', 'return_received', 'verify_poll',
  'webhook_received', 'webhook_rejected', 'settle_push',
  'settle_paid', 'settle_failed', 'settle_duplicate',
  'manual_submit', 'manual_approved', 'manual_rejected',
  'redirect_back', 'result_final',
];

const TX_TYPES = ['subscription', 'sms', 'hardware'] as const;
const TX_ORIGINS = ['client', 'server'] as const;

const TYPE_STYLES: Record<string, string> = {
  subscription: 'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300',
  sms: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  hardware: 'bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300',
};

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

/** Stage chip — short, colored, monospace-friendly. */
function StageChip({ stage }: { stage: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold whitespace-nowrap font-mono', STAGE_STYLES[stage] ?? '')}>
      {stage}
    </Badge>
  );
}

function TypeChip({ txType }: { txType?: string }) {
  if (!txType) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold whitespace-nowrap', TYPE_STYLES[txType] ?? '')}>
      {txType}
    </Badge>
  );
}

function fmtAmount(amount?: number | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return `${amount.toLocaleString()} DA`;
}

// ─── Component ───────────────────────────────────────────────────────────────

const RANGE_OPTIONS = ['all', '1h', '24h', '7d', '30d'] as const;
type RangeOption = (typeof RANGE_OPTIONS)[number];

function rangeToDates(range: RangeOption): { from?: string; to?: string } {
  if (range === 'all') return {};
  const hours = range === '1h' ? 1 : range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  // The stream files are day-grained — a 1h window still reads today's file
  // (the ts filter would need per-line matching; the KPI "last 24h" tile
  // already gives the precise figure server-side).
  void hours;
  return {};
}

export function AdminTxLogsSection() {
  const { t } = useLanguage();

  const [payload, setPayload] = useState<TxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'events' | 'funnels'>('events');
  const [stage, setStage] = useState('all');
  const [txType, setTxType] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [range, setRange] = useState<RangeOption>('all');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [detail, setDetail] = useState<TxEvent | null>(null);
  const [detailData, setDetailData] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  /** Query string carrying the CURRENT filters (fetch + export parity). */
  const currentFilterQuery = useCallback(() => {
    const p = new URLSearchParams();
    if (stage !== 'all') p.set('stage', stage);
    if (txType !== 'all') p.set('txType', txType);
    if (origin !== 'all') p.set('origin', origin);
    const dates = rangeToDates(range);
    if (dates.from) p.set('from', dates.from);
    if (dates.to) p.set('to', dates.to);
    if (q.trim()) p.set('q', q.trim());
    return p.toString();
  }, [stage, txType, origin, range, q]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const filters = currentFilterQuery();
      const res = await apiFetch(`/api/logs/transactions?limit=600${filters ? `&${filters}` : ''}`);
      const body = await res.json().catch(() => null);
      const data = res.ok ? unwrapData<TxPayload>(body) : null;
      if (data) setPayload(data);
    } catch {
      /* keep the last payload */
    } finally {
      setLoading(false);
    }
  }, [currentFilterQuery]);

  // Debounced search — the funnel query matches message/ref/uid/agency.
  useEffect(() => {
    const id = setTimeout(() => setQ(qLive), 350);
    return () => clearTimeout(id);
  }, [qLive]);

  // Initial + filter-driven fetch.
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Realtime feel: light auto-refresh while visible (30s — money moves fast).
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchData();
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const openDetail = (e: TxEvent) => {
    setDetail(e);
    setDetailData(JSON.stringify(e, null, 2));
  };

  const doCopy = async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* non-fatal */ }
  };

  const summary = payload?.summary;
  const entries = payload?.entries ?? [];
  const funnels = summary?.funnels ?? [];
  const stageChoices = useMemo(() => {
    const set = new Set<string>(STAGE_ORDER);
    for (const k of Object.keys(summary?.byStage ?? {})) set.add(k);
    return [...set];
  }, [summary]);

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('txLogKpiEvents')}</p>
            <p className="text-2xl font-bold" dir="ltr">{summary?.total ?? 0}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5" dir="ltr">24h: {summary?.last24h ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('txLogKpiPaid')}</p>
            <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400" dir="ltr">{summary?.paid ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('txLogKpiFailed')}</p>
            <p className={cn('text-2xl font-bold', (summary?.failed ?? 0) > 0 ? 'text-red-600 dark:text-red-400' : '')} dir="ltr">
              {summary?.failed ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('txLogKpiPending')}</p>
            <p className="text-2xl font-bold text-amber-600 dark:text-amber-400" dir="ltr">{summary?.pendingRefs ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">{t('txLogKpiFunnels')}</p>
            <p className="text-2xl font-bold" dir="ltr">{funnels.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Header + filters */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
              <ArrowLeftRight className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-sm">{t('txLogTitle')}</CardTitle>
              <CardDescription className="text-[11px] truncate">{t('txLogDesc')}</CardDescription>
            </div>
            {/* View toggle */}
            <div className="flex rounded-lg border overflow-hidden shrink-0">
              <button
                type="button"
                onClick={() => setView('events')}
                className={cn(
                  'px-2.5 h-8 text-[11px] font-medium flex items-center gap-1',
                  view === 'events' ? 'bg-emerald-600 text-white' : 'hover:bg-muted/60',
                )}
              >
                <Wallet className="h-3 w-3" />
                {t('txLogViewEvents')}
              </button>
              <button
                type="button"
                onClick={() => setView('funnels')}
                className={cn(
                  'px-2.5 h-8 text-[11px] font-medium flex items-center gap-1',
                  view === 'funnels' ? 'bg-emerald-600 text-white' : 'hover:bg-muted/60',
                )}
              >
                <CreditCard className="h-3 w-3" />
                {t('txLogViewFunnels')}
              </button>
            </div>
            <Button variant="outline" size="sm" onClick={() => void fetchData()} disabled={loading} className="shrink-0 h-8">
              {loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
              {t('refresh')}
            </Button>
            {/* Unified export (0.6.81 — transactions joined the composer) */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 h-8 gap-1.5">
                  <Download className="h-4 w-4 me-0.5" />
                  {t('download')}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setExportOpen(true)}>
                  <Sparkles className="h-3.5 w-3.5 me-1.5 text-violet-600 dark:text-violet-400" />
                  <span className="text-[11px] font-medium">{t('logsExportCustom')}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-[10px] text-muted-foreground leading-4">{t('txLogExportHint')}</p>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Filter row */}
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="h-3.5 w-3.5 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={qLive}
                onChange={(e) => setQLive(e.target.value)}
                placeholder={t('txLogSearchPlaceholder')}
                className="h-8 ps-8 text-xs"
                dir="ltr"
              />
              {qLive && (
                <button
                  type="button"
                  onClick={() => setQLive('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={t('close')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Select value={stage} onValueChange={setStage}>
              <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                {stageChoices.map((s) => <SelectItem key={s} value={s} dir="ltr" className="font-mono text-[11px]">{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={txType} onValueChange={setTxType}>
              <SelectTrigger className="h-8 w-[130px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                {TX_TYPES.map((ty) => <SelectItem key={ty} value={ty} dir="ltr">{ty}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={origin} onValueChange={setOrigin}>
              <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('logsManagerAll')}</SelectItem>
                {TX_ORIGINS.map((o) => <SelectItem key={o} value={o} dir="ltr">{o}</SelectItem>)}
              </SelectContent>
            </Select>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[10px] transition-colors',
                  range === r
                    ? 'border-emerald-400 bg-emerald-100 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200'
                    : 'hover:bg-muted/60',
                )}
                dir="ltr"
              >
                {r}
              </button>
            ))}
          </div>
          {payload?.truncated && (
            <CardDescription className="text-[10px] text-amber-600 dark:text-amber-400">
              {t('txLogTruncated')}
            </CardDescription>
          )}
        </CardHeader>
      </Card>

      {/* ── EVENTS view ── */}
      {view === 'events' && (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[540px] overflow-y-auto custom-scrollbar">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="w-[150px] text-[11px]">{t('time')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColStage')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColType')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColAmount')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColAccount')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColMessage')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColOrigin')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-xs text-muted-foreground">
                        {t('txLogEmpty')}
                      </TableCell>
                    </TableRow>
                  )}
                  {entries.map((e, i) => (
                    <TableRow
                      key={`${e.ts}-${i}`}
                      className="cursor-pointer"
                      onClick={() => openDetail(e)}
                    >
                      <TableCell className="text-[10px] text-muted-foreground whitespace-nowrap" dir="ltr">{fmtTime(e.ts)}</TableCell>
                      <TableCell><StageChip stage={e.stage} /></TableCell>
                      <TableCell><TypeChip txType={e.txType} /></TableCell>
                      <TableCell className="text-[11px] font-semibold whitespace-nowrap" dir="ltr">{fmtAmount(e.amount)}</TableCell>
                      <TableCell className="text-[10px] max-w-[140px]">
                        <span className="block truncate font-mono" dir="ltr" title={e.uid ?? e.userId ?? ''}>
                          {e.username || e.uid || e.agencyId || e.userId || '—'}
                        </span>
                        {e.platform && <span className="block text-[9px] text-muted-foreground" dir="ltr">{e.platform}</span>}
                      </TableCell>
                      <TableCell className="text-[11px] max-w-[320px]">
                        <span className="line-clamp-2" title={e.message}>{e.message}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn('text-[9px]', e.origin === 'server' ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300' : 'bg-slate-50 text-slate-600 dark:bg-slate-900/60 dark:text-slate-300')}>
                          {e.origin}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── FUNNELS view ── */}
      {view === 'funnels' && (
        <Card>
          <CardContent className="p-0">
            <div className="max-h-[540px] overflow-y-auto custom-scrollbar">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="text-[11px]">{t('txColType')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColAmount')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColAccount')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColRef')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColJourney')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColFinal')}</TableHead>
                    <TableHead className="text-[11px]">{t('txColEvents')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {funnels.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-xs text-muted-foreground">
                        {t('txLogEmpty')}
                      </TableCell>
                    </TableRow>
                  )}
                  {funnels.map((f, i) => (
                    <TableRow key={`${f.ref || f.checkoutId || i}-${i}`}>
                      <TableCell><TypeChip txType={f.txType ?? undefined} /></TableCell>
                      <TableCell className="text-[11px] font-semibold whitespace-nowrap" dir="ltr">{fmtAmount(f.amount)}</TableCell>
                      <TableCell className="text-[10px] max-w-[130px]">
                        <span className="block truncate font-mono" dir="ltr">{f.uid || f.agencyId || '—'}</span>
                      </TableCell>
                      <TableCell className="text-[10px] max-w-[150px]">
                        <span className="block truncate font-mono" dir="ltr" title={f.ref ?? f.checkoutId ?? ''}>
                          {f.ref || f.checkoutId || '—'}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[340px]">
                        <div className="flex flex-wrap gap-1">
                          {f.stages.slice(0, 8).map((s) => <StageChip key={s} stage={s} />)}
                          {f.stages.length > 8 && (
                            <Badge variant="outline" className="text-[9px]">+{f.stages.length - 8}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] font-semibold',
                            f.finalStatus === 'PAID'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300'
                              : f.finalStatus === 'FAILED' || f.finalStatus === 'REJECTED'
                                ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300'
                                : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
                          )}
                          dir="ltr"
                        >
                          {f.finalStatus || 'PENDING'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[11px]" dir="ltr">{f.eventCount}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Event detail dialog */}
      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto custom-scrollbar">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <StageChip stage={detail?.stage ?? ''} />
              <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">{detail ? fmtTime(detail.ts) : ''}</span>
            </DialogTitle>
            <DialogDescription className="text-xs" dir="ltr">{detail?.message}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              {([
                ['txColType', detail?.txType],
                ['txColAmount', detail?.amount !== undefined ? fmtAmount(detail.amount) : null],
                ['txColStatus', detail?.status],
                ['txColMethod', detail?.method],
                ['txColRef', detail?.ref],
                ['txLogColCheckout', detail?.checkoutId],
                ['txColAccount', detail?.uid ?? detail?.userId ?? detail?.agencyId],
                ['txColRole', detail?.role],
                ['txColOrigin', detail?.origin],
                ['txColPlatform', detail?.platform ? `${detail.platform}${detail.appVersion ? ` · v${detail.appVersion}` : ''}` : null],
              ] as Array<[TranslationKeys, string | number | null | undefined]>).map(([label, value]) => (
                value !== null && value !== undefined ? (
                  <div key={label} className="flex items-start gap-1.5">
                    <span className="text-muted-foreground shrink-0">{t(label)}:</span>
                    <span className="font-mono break-all" dir="ltr">{String(value)}</span>
                  </div>
                ) : null
              ))}
            </div>
            {detail?.data && Object.keys(detail.data).length > 0 && (
              <>
                <p className="text-[11px] font-semibold text-muted-foreground mt-2">{t('txColData')}</p>
                <pre className="rounded-lg bg-muted/60 p-2.5 text-[10px] font-mono overflow-x-auto max-h-52 overflow-y-auto custom-scrollbar" dir="ltr">
                  {JSON.stringify(detail.data, null, 2)}
                </pre>
              </>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void doCopy(detailData)} disabled={copied}>
                {copied ? <Check className="h-3.5 w-3.5 me-1" /> : <Copy className="h-3.5 w-3.5 me-1" />}
                {t('logsManagerCopy')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unified export (transactions scope) */}
      <AdminLogsExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        scope="transactions"
        defaults={{ q: q.trim() }}
      />
    </div>
  );
}

export default AdminTxLogsSection;
