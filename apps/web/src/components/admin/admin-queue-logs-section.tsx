'use client';

/**
 * AdminQueueLogsSection — QUEUE EVENT STREAM (0.6.94).
 *
 * The dedicated "Queue" tab inside the Logs Manager. It tails the unified
 * cross-account queue stream (logs/_queue/<date>.ndjson) that BOTH sides
 * write into through ONE pipeline:
 *
 *   • CLIENT — queue surfaces (agency console + full-screen display, mobile
 *     dashboard, customer booking/cancel flows, kiosk webviews) log through
 *     remote-logger.logQueue() (tag 'queue' + channel 'queue'); batches ride
 *     the normal POST /api/logs ingest and are MIRRORED into the stream with
 *     the account identity resolved server-side.
 *   • DESKTOP LOCAL-API — LAN queue mutations, the offline outbox and the
 *     sync pull/push/conflict events ride the local /api/logs forward
 *     pipeline (platform 'desktop').
 *   • SERVER — the authoritative mutations (reservations, call-next, counter
 *     control, kiosk join, scheduler) write through
 *     apps/api/src/lib/queue-event-log.ts.
 *
 * Coverage (the user's mandate, answered with data):
 *   queue engine (pause/resume/settings) · ALL queue operations from ONLINE
 *   reservation → LOCAL walk-in → KIOSK dispensing on ALL devices/platforms ·
 *   counters managing the SAME queue list (claim/release/control/assign) ·
 *   LAN device interactions (outbox → push → pull → conflicts) · full-screen
 *   mode enter/exit.
 *
 * Three views:
 *   • EVENTS   — the newest raw queue entries (filterable).
 *   • TICKETS  — one card per ticket with its full event list, so support
 *                sees the whole lifecycle per ticket (A-012: created online →
 *                claimed by Counter 2 → completed).
 *   • COUNTERS — one card per counter with its ops, so support sees how two
 *                counters managed the SAME queue list.
 *
 * API: GET /api/logs/queue?event=&agencyId=&branchId=&serviceId=&counterId=
 *                   &ticketId=&ticketNumber=&source=&status=&origin=&platform=
 *                   &sessionId=&level=&uid=&q=&from=&to=&limit=
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Loader2,
  ListOrdered,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

// ─── Types (mirror apps/api/src/lib/queue-event-log.ts) ──────────────────────

interface QueueEventEntry {
  ts: string;
  level: string;
  tag: 'queue';
  channel: 'queue';
  origin: 'client' | 'server';
  event: string;
  message: string;
  agencyId?: string;
  branchId?: string;
  serviceId?: string;
  serviceName?: string;
  counterId?: string;
  counterName?: string;
  ticketId?: string;
  ticketNumber?: string;
  source?: string;
  status?: string;
  waitMs?: number;
  serviceMs?: number;
  sessionId?: string;
  deviceId?: string;
  deviceName?: string;
  uid?: string | null;
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  platform?: string;
  appVersion?: string;
  data?: Record<string, unknown>;
}

interface QueueTimeline {
  ticketId: string | null;
  ticketNumber: string | null;
  agencyId: string | null;
  serviceName: string | null;
  source: string | null;
  status: string | null;
  platform: string | null;
  firstTs: string;
  lastTs: string;
  events: string[];
  eventCount: number;
  lastLevel: string | null;
}

interface CounterTimeline {
  counterId: string | null;
  counterName: string | null;
  agencyId: string | null;
  platform: string | null;
  firstTs: string;
  lastTs: string;
  events: string[];
  eventCount: number;
  lastLevel: string | null;
}

interface QueueSummary {
  total: number;
  last24h: number;
  byEvent: Record<string, number>;
  byPlatform: Record<string, number>;
  bySource: Record<string, number>;
  byStatus: Record<string, number>;
  medianWaitMs: number | null;
  medianServiceMs: number | null;
  errors24h: number;
  ticketTimelines: QueueTimeline[];
  counterTimelines: CounterTimeline[];
}

interface QueuePayload {
  entries: QueueEventEntry[];
  scanned: number;
  files: number;
  truncated: boolean;
  summary: QueueSummary;
}

// ─── Presentation constants ──────────────────────────────────────────────────

/** Event → chip style. Failures get the loud colors. */
const EVENT_STYLES: Record<string, string> = {
  // queue engine state
  queue_paused: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  queue_resumed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  queue_settings_updated: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  // ticket creation sources
  ticket_created_online: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
  ticket_created_walkin: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  ticket_created_kiosk: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900',
  ticket_imported: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  // ticket lifecycle
  ticket_claimed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  claim_contention: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  ticket_recalled: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900',
  ticket_completed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  ticket_no_show: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
  ticket_cancelled: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  ticket_postponed: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  ticket_status_changed: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  ticket_reclaimed: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  ticket_rated: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  ticket_shared: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
  ticket_fixed_time_toggled: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  batch_completed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  // counter operations
  counter_claimed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  counter_released: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  counter_control_requested: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  counter_control_approved: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  counter_control_rejected: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  counter_assigned: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  counter_created: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  counter_updated: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  counter_deleted: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  // kiosk mode
  kiosk_ticket_synced: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900',
  // full-screen mode
  fullscreen_enter: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900',
  fullscreen_exit: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  // LAN sync propagation
  sync_mutation_queued: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
  sync_push_replayed: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  sync_pull_applied: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  sync_conflict: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
};

const EVENT_ORDER = [
  'ticket_created_online', 'ticket_created_walkin', 'ticket_created_kiosk', 'ticket_imported',
  'ticket_claimed', 'claim_contention', 'ticket_recalled', 'ticket_completed', 'ticket_no_show',
  'ticket_cancelled', 'ticket_postponed', 'ticket_status_changed', 'ticket_reclaimed',
  'ticket_rated', 'ticket_shared', 'ticket_fixed_time_toggled', 'batch_completed',
  'queue_paused', 'queue_resumed', 'queue_settings_updated',
  'counter_claimed', 'counter_released', 'counter_control_requested', 'counter_control_approved',
  'counter_control_rejected', 'counter_assigned', 'counter_created', 'counter_updated', 'counter_deleted',
  'kiosk_ticket_synced', 'fullscreen_enter', 'fullscreen_exit',
  'sync_mutation_queued', 'sync_push_replayed', 'sync_pull_applied', 'sync_conflict',
];

const PLATFORMS = ['all', 'desktop', 'mobile', 'web', 'kiosk', 'tv'] as const;
const ORIGINS = ['all', 'client', 'server'] as const;
const SOURCES = ['all', 'online', 'walkin', 'kiosk', 'import'] as const;

const PLATFORM_STYLES: Record<string, string> = {
  desktop: 'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300',
  mobile: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  web: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  kiosk: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
  tv: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  server: 'bg-slate-200 text-slate-800 dark:bg-slate-900/70 dark:text-slate-300',
};

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** apiClient auto-unwraps `{ success, data }` envelopes — accept both shapes. */
function unwrapData<T>(payload: unknown): T | null {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return ((payload as { data?: unknown }).data ?? null) as T | null;
  }
  return (payload as T) ?? null;
}

/** Event chip — short, colored, monospace-friendly. */
function EventChip({ event }: { event: string }) {
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold whitespace-nowrap font-mono', EVENT_STYLES[event] ?? '')}>
      {event}
    </Badge>
  );
}

function PlatformChip({ platform }: { platform?: string }) {
  if (!platform) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" className={cn('text-[10px] font-semibold whitespace-nowrap', PLATFORM_STYLES[platform] ?? '')}>
      {platform}
    </Badge>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function AdminQueueLogsSection() {
  const [payload, setPayload] = useState<QueuePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'events' | 'tickets' | 'counters'>('events');
  const [event, setEvent] = useState('all');
  const [platform, setPlatform] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [source, setSource] = useState('all');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [detail, setDetail] = useState<QueueEventEntry | null>(null);
  const [detailData, setDetailData] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      p.set('limit', '600');
      if (event !== 'all') p.set('event', event);
      if (platform !== 'all') p.set('platform', platform);
      if (origin !== 'all') p.set('origin', origin);
      if (source !== 'all') p.set('source', source);
      if (q.trim()) p.set('q', q.trim());
      const res = await apiFetch(`/api/logs/queue?${p.toString()}`);
      const body = await res.json().catch(() => null);
      const data = res.ok ? unwrapData<QueuePayload>(body) : null;
      if (data) setPayload(data);
    } catch {
      /* keep the last payload */
    } finally {
      setLoading(false);
    }
  }, [event, platform, origin, source, q]);

  // Debounced search — the query matches message/ticket/counter/service/agency.
  useEffect(() => {
    const id = setTimeout(() => setQ(qLive), 350);
    return () => clearTimeout(id);
  }, [qLive]);

  // Initial + filter-driven fetch.
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Realtime feel: light auto-refresh while visible (30s — queues move fast).
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchData();
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const openDetail = (e: QueueEventEntry) => {
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
  const tickets = summary?.ticketTimelines ?? [];
  const counters = summary?.counterTimelines ?? [];
  const eventChoices = useMemo(() => {
    const set = new Set<string>(EVENT_ORDER);
    for (const k of Object.keys(summary?.byEvent ?? {})) set.add(k);
    return [...set];
  }, [summary]);
  const topPlatforms = useMemo(() => {
    const by = summary?.byPlatform ?? {};
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [summary]);
  const topSources = useMemo(() => {
    const by = summary?.bySource ?? {};
    return Object.entries(by).sort((a, b) => b[1] - a[1]);
  }, [summary]);

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">Queue events</p>
            <p className="text-2xl font-bold" dir="ltr">{summary?.total ?? 0}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5" dir="ltr">24h: {summary?.last24h ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">Tickets touched</p>
            <p className="text-2xl font-bold" dir="ltr">{tickets.length}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5" dir="ltr">
              wait {summary?.medianWaitMs != null ? fmtDuration(summary.medianWaitMs) : '—'} · serve {summary?.medianServiceMs != null ? fmtDuration(summary.medianServiceMs) : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">Errors / warnings 24h</p>
            <p className={cn('text-2xl font-bold', (summary?.errors24h ?? 0) > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')} dir="ltr">
              {summary?.errors24h ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">By platform</p>
            <div className="flex flex-wrap gap-1 mt-1.5">
              {topPlatforms.length === 0 ? (
                <span className="text-[11px] text-muted-foreground">—</span>
              ) : (
                topPlatforms.map(([plat, n]) => (
                  <Badge key={plat} variant="outline" className={cn('text-[10px]', PLATFORM_STYLES[plat] ?? '')}>
                    {plat}: {n}
                  </Badge>
                ))
              )}
            </div>
            {topSources.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1.5 truncate" dir="ltr">
                sources: {topSources.map(([k, v]) => `${k}=${v}`).join(' · ')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Header + filters */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 dark:from-amber-900/40 dark:to-orange-900/30 flex items-center justify-center shrink-0">
              <ListOrdered className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-sm">Queue event stream</CardTitle>
              <CardDescription className="text-xs">
                Engine · online/walk-in/kiosk tickets · counters on the same queue · LAN sync · full-screen — every platform, one timeline
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={fetchData} disabled={loading} className="shrink-0">
              {loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* View switch */}
            <div className="flex rounded-lg border overflow-hidden shrink-0">
              <button
                className={cn('px-3 py-1.5 text-xs font-medium', view === 'events' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                onClick={() => setView('events')}
              >
                Events
              </button>
              <button
                className={cn('px-3 py-1.5 text-xs font-medium', view === 'tickets' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                onClick={() => setView('tickets')}
              >
                Tickets
              </button>
              <button
                className={cn('px-3 py-1.5 text-xs font-medium', view === 'counters' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                onClick={() => setView('counters')}
              >
                Counters
              </button>
            </div>
            <Select value={event} onValueChange={setEvent}>
              <SelectTrigger className="w-[190px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">All events</SelectItem>
                {eventChoices.map((e) => <SelectItem key={e} value={e} className="font-mono text-xs">{e}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={platform} onValueChange={setPlatform}>
              <SelectTrigger className="w-[130px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((pOpt) => <SelectItem key={pOpt} value={pOpt} className="text-xs">{pOpt}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map((sOpt) => <SelectItem key={sOpt} value={sOpt} className="text-xs">{sOpt}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={origin} onValueChange={setOrigin}>
              <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ORIGINS.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute start-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={qLive}
                onChange={(e) => setQLive(e.target.value)}
                placeholder="Search message, ticket, counter, service, agency…"
                className="h-8 text-xs ps-8 pe-8"
                dir="ltr"
              />
              {qLive && (
                <button className="absolute end-2 top-1/2 -translate-y-1/2" onClick={() => setQLive('')} aria-label="Clear search">
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>

          {payload?.truncated && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400" dir="ltr">
              Result truncated — showing the newest {entries.length} of more matches. Narrow the filters.
            </p>
          )}

          {/* EVENTS view */}
          {view === 'events' && (
            <div className="rounded-lg border max-h-[480px] overflow-y-auto blasti-scroll">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead className="w-[130px]">Time</TableHead>
                    <TableHead className="w-[170px]">Event</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-[110px]">Ticket</TableHead>
                    <TableHead className="w-[120px]">Counter</TableHead>
                    <TableHead className="w-[80px]">Platform</TableHead>
                    <TableHead className="w-[70px]">Origin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-8">
                        No queue events yet. Events appear here the moment a reservation, walk-in, kiosk join, call-next, counter action or full-screen session runs.
                      </TableCell>
                    </TableRow>
                  )}
                  {entries.map((e, i) => (
                    <TableRow
                      key={`${e.ts}-${i}`}
                      className={cn(
                        'cursor-pointer',
                        (e.level === 'error' || e.level === 'warn') && 'bg-red-50/40 dark:bg-red-950/20',
                      )}
                      onClick={() => openDetail(e)}
                    >
                      <TableCell className="text-[11px] font-mono whitespace-nowrap" dir="ltr">{fmtTime(e.ts)}</TableCell>
                      <TableCell><EventChip event={e.event} /></TableCell>
                      <TableCell className="text-xs max-w-0"><span className="line-clamp-2">{e.message}</span></TableCell>
                      <TableCell className="text-[11px] font-mono" dir="ltr">{e.ticketNumber || (e.ticketId ? e.ticketId.slice(0, 8) : '—')}</TableCell>
                      <TableCell className="text-[11px]">
                        <div className="truncate max-w-[110px]" dir="ltr">{e.counterName || e.counterId || '—'}</div>
                      </TableCell>
                      <TableCell><PlatformChip platform={e.platform} /></TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{e.origin}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* TICKETS view */}
          {view === 'tickets' && (
            <div className="grid md:grid-cols-2 gap-3 max-h-[480px] overflow-y-auto blasti-scroll pe-1">
              {tickets.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground md:col-span-2 text-center py-8">
                  No ticket timelines yet.
                </p>
              )}
              {tickets.map((t) => (
                <Card key={`${t.ticketId ?? t.lastTs}`} className="py-3">
                  <CardContent className="px-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate font-mono" dir="ltr">{t.ticketNumber || t.ticketId || 'Unknown ticket'}</p>
                        <p className="text-[10px] text-muted-foreground truncate" dir="ltr">
                          {t.serviceName ?? '—'} · {t.source ?? '—'} · {t.status ?? '—'}{t.agencyId ? ` · agency ${t.agencyId.slice(0, 8)}…` : ''}
                        </p>
                      </div>
                      <div className="text-end shrink-0">
                        <p className="text-lg font-bold leading-none" dir="ltr">{t.eventCount}</p>
                        <p className="text-[10px] text-muted-foreground">events</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {t.events.slice(0, 8).map((ev) => <EventChip key={ev} event={ev} />)}
                      {t.events.length > 8 && (
                        <Badge variant="outline" className="text-[10px]">+{t.events.length - 8} more</Badge>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground" dir="ltr">
                      {fmtTime(t.firstTs)} → {fmtTime(t.lastTs)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* COUNTERS view */}
          {view === 'counters' && (
            <div className="grid md:grid-cols-2 gap-3 max-h-[480px] overflow-y-auto blasti-scroll pe-1">
              {counters.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground md:col-span-2 text-center py-8">
                  No counter timelines yet.
                </p>
              )}
              {counters.map((ct) => (
                <Card key={`${ct.counterId ?? ct.lastTs}`} className="py-3">
                  <CardContent className="px-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" dir="ltr">{ct.counterName || ct.counterId || 'Unknown counter'}</p>
                        <p className="text-[10px] text-muted-foreground truncate" dir="ltr">
                          {ct.platform ?? '—'}{ct.agencyId ? ` · agency ${ct.agencyId.slice(0, 8)}…` : ''}
                        </p>
                      </div>
                      <div className="text-end shrink-0">
                        <p className="text-lg font-bold leading-none" dir="ltr">{ct.eventCount}</p>
                        <p className="text-[10px] text-muted-foreground">events</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {ct.events.slice(0, 8).map((ev) => <EventChip key={ev} event={ev} />)}
                      {ct.events.length > 8 && (
                        <Badge variant="outline" className="text-[10px]">+{ct.events.length - 8} more</Badge>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground" dir="ltr">
                      {fmtTime(ct.firstTs)} → {fmtTime(ct.lastTs)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm" dir="ltr">{detail?.event}</DialogTitle>
            <DialogDescription className="text-xs" dir="ltr">{detail?.message}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-[11px]" dir="ltr">
              <div><span className="text-muted-foreground">time:</span> {detail ? fmtTime(detail.ts) : ''}</div>
              <div><span className="text-muted-foreground">level:</span> {detail?.level}</div>
              <div><span className="text-muted-foreground">origin:</span> {detail?.origin}</div>
              <div><span className="text-muted-foreground">platform:</span> {detail?.platform ?? '—'}</div>
              <div><span className="text-muted-foreground">ticket:</span> {detail?.ticketNumber ?? detail?.ticketId ?? '—'}</div>
              <div><span className="text-muted-foreground">counter:</span> {detail?.counterName ?? detail?.counterId ?? '—'}</div>
              <div><span className="text-muted-foreground">source:</span> {detail?.source ?? '—'}</div>
              <div><span className="text-muted-foreground">status:</span> {detail?.status ?? '—'}</div>
              {detail?.waitMs !== undefined && <div><span className="text-muted-foreground">wait:</span> {fmtDuration(detail.waitMs)}</div>}
              {detail?.serviceMs !== undefined && <div><span className="text-muted-foreground">service:</span> {fmtDuration(detail.serviceMs)}</div>}
              {detail?.agencyId && <div className="col-span-2 truncate"><span className="text-muted-foreground">agency:</span> {detail.agencyId}</div>}
              {detail?.sessionId && <div className="col-span-2 truncate"><span className="text-muted-foreground">session:</span> {detail.sessionId}</div>}
              {detail?.username && <div className="col-span-2 truncate"><span className="text-muted-foreground">user:</span> {detail.username}</div>}
            </div>
            <pre className="text-[10px] bg-muted rounded-lg p-3 overflow-x-auto whitespace-pre-wrap" dir="ltr">{detailData}</pre>
            <Button variant="outline" size="sm" onClick={() => void doCopy(detailData)}>
              <Copy className="h-3.5 w-3.5 me-1" />
              {copied ? 'Copied!' : 'Copy JSON'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
