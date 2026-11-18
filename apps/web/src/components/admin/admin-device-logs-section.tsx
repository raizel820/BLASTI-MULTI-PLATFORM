'use client';

/**
 * AdminDeviceLogsSection — DEVICE EVENT STREAM (0.6.91).
 *
 * The dedicated "Devices" tab inside the Logs Manager. It tails the unified
 * cross-account device stream (logs/_devices/<date>.ndjson) that BOTH sides
 * write into through ONE pipeline:
 *
 *   • CLIENT — device/kiosk surfaces (device manager UI, kiosk webviews on
 *     desktop + mobile, LAN discovery) log through remote-logger.logDevice()
 *     (tag 'device' + channel 'device'); batches ride the normal
 *     POST /api/logs ingest and are MIRRORED into the stream with the account
 *     identity resolved server-side.
 *   • DESKTOP LOCAL-API — scan/pair/link/kiosk events from the Electron box
 *     ride the local /api/logs forward pipeline (platform 'desktop').
 *   • SERVER — the authoritative mutations (socket joins, kiosk-auth,
 *     pairing decisions, cloud discovery scans, heartbeat state changes)
 *     write through apps/api/src/lib/device-event-log.ts.
 *
 * Coverage (the user's question, answered with data):
 *   device-manager scanning · device pairing/linking · device connections
 *   (realtime join/leave/auth-fail) · kiosk mode (enter/exit/auth) — for
 *   BOTH the desktop app and the phone app.
 *
 * Two views:
 *   • EVENTS — the newest raw device entries (filterable).
 *   • DEVICES — one row per device with its full event list, so support sees
 *     the whole lifecycle per device.
 *
 * API: GET /api/logs/devices?event=&deviceId=&agencyId=&origin=&platform=
 *                     &deviceType=&sessionId=&level=&uid=&q=&from=&to=&limit=
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Loader2,
  MonitorSmartphone,
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

// ─── Types (mirror apps/api/src/lib/device-event-log.ts) ─────────────────────

interface DeviceEventEntry {
  ts: string;
  level: string;
  tag: 'device';
  channel: 'device';
  origin: 'client' | 'server';
  event: string;
  message: string;
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  sessionId?: string;
  status?: string;
  uid?: string | null;
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  agencyId?: string | null;
  platform?: string;
  appVersion?: string;
  data?: Record<string, unknown>;
}

interface DeviceTimeline {
  deviceId: string | null;
  deviceName: string | null;
  deviceType: string | null;
  agencyId: string | null;
  platform: string | null;
  firstTs: string;
  lastTs: string;
  events: string[];
  eventCount: number;
  lastLevel: string | null;
}

interface DeviceSummary {
  total: number;
  last24h: number;
  byEvent: Record<string, number>;
  byPlatform: Record<string, number>;
  byType: Record<string, number>;
  errors24h: number;
  timelines: DeviceTimeline[];
}

interface DevicePayload {
  entries: DeviceEventEntry[];
  scanned: number;
  files: number;
  truncated: boolean;
  summary: DeviceSummary;
}

// ─── Presentation constants ──────────────────────────────────────────────────

/** Event → chip style. Failures get the loud colors. */
const EVENT_STYLES: Record<string, string> = {
  // scanning
  scan_started: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900',
  scan_completed: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  scan_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  scan_stopped: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  devices_found: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  // pairing / linking
  pair_started: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  pair_success: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  pair_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  unpair: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
  pairing_requested: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
  pairing_accepted: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  pairing_rejected: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  connect_success: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  connect_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  disconnect: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
  kiosk_credentials_issued: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900',
  // connections
  socket_connected: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  socket_disconnected: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900',
  socket_auth_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  device_online: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  device_offline: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  lan_join: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/40 dark:text-cyan-300 dark:border-cyan-900',
  // kiosk mode
  kiosk_enter: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200 dark:bg-fuchsia-950/40 dark:text-fuchsia-300 dark:border-fuchsia-900',
  kiosk_exit: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  kiosk_registered: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-900',
  kiosk_auth_success: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900',
  kiosk_auth_failed: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900',
  heartbeat_state_change: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900',
};

const EVENT_ORDER = [
  'scan_started', 'devices_found', 'scan_completed', 'scan_stopped', 'scan_failed',
  'pair_started', 'pairing_requested', 'pairing_accepted', 'pairing_rejected',
  'pair_success', 'pair_failed', 'unpair',
  'connect_success', 'connect_failed', 'disconnect',
  'kiosk_credentials_issued',
  'socket_connected', 'socket_disconnected', 'socket_auth_failed',
  'device_online', 'device_offline', 'lan_join', 'heartbeat_state_change',
  'kiosk_enter', 'kiosk_registered', 'kiosk_auth_success', 'kiosk_auth_failed', 'kiosk_exit',
];

const PLATFORMS = ['all', 'desktop', 'mobile', 'web', 'kiosk', 'tv'] as const;
const ORIGINS = ['all', 'client', 'server'] as const;

const PLATFORM_STYLES: Record<string, string> = {
  desktop: 'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300',
  mobile: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  web: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
  kiosk: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
  tv: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
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

export function AdminDeviceLogsSection() {
  const [payload, setPayload] = useState<DevicePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'events' | 'devices'>('events');
  const [event, setEvent] = useState('all');
  const [platform, setPlatform] = useState('all');
  const [origin, setOrigin] = useState('all');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [detail, setDetail] = useState<DeviceEventEntry | null>(null);
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
      if (q.trim()) p.set('q', q.trim());
      const res = await apiFetch(`/api/logs/devices?${p.toString()}`);
      const body = await res.json().catch(() => null);
      const data = res.ok ? unwrapData<DevicePayload>(body) : null;
      if (data) setPayload(data);
    } catch {
      /* keep the last payload */
    } finally {
      setLoading(false);
    }
  }, [event, platform, origin, q]);

  // Debounced search — the query matches message/device ids/names/agency.
  useEffect(() => {
    const id = setTimeout(() => setQ(qLive), 350);
    return () => clearTimeout(id);
  }, [qLive]);

  // Initial + filter-driven fetch.
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Realtime feel: light auto-refresh while visible (30s — devices move fast).
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchData();
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const openDetail = (e: DeviceEventEntry) => {
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
  const timelines = summary?.timelines ?? [];
  const eventChoices = useMemo(() => {
    const set = new Set<string>(EVENT_ORDER);
    for (const k of Object.keys(summary?.byEvent ?? {})) set.add(k);
    return [...set];
  }, [summary]);
  const topPlatforms = useMemo(() => {
    const by = summary?.byPlatform ?? {};
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [summary]);
  const topTypes = useMemo(() => {
    const by = summary?.byType ?? {};
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [summary]);

  return (
    <div className="space-y-4">
      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">Device events</p>
            <p className="text-2xl font-bold" dir="ltr">{summary?.total ?? 0}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5" dir="ltr">24h: {summary?.last24h ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3 px-4">
            <p className="text-[11px] text-muted-foreground">Devices seen</p>
            <p className="text-2xl font-bold" dir="ltr">{timelines.length}</p>
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
            {topTypes.length > 0 && (
              <p className="text-[10px] text-muted-foreground mt-1.5 truncate" dir="ltr">
                types: {topTypes.map(([k, v]) => `${k}=${v}`).join(' · ')}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Header + filters */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-100 to-emerald-100 dark:from-teal-900/40 dark:to-emerald-900/30 flex items-center justify-center shrink-0">
              <MonitorSmartphone className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-sm">Device event stream</CardTitle>
              <CardDescription className="text-xs">
                Scanning · pairing/linking · connections · kiosk mode — desktop AND phone, one timeline
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
                className={cn('px-3 py-1.5 text-xs font-medium', view === 'devices' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                onClick={() => setView('devices')}
              >
                Devices
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
                placeholder="Search message, device, agency…"
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
                    <TableHead className="w-[160px]">Event</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="w-[150px]">Device</TableHead>
                    <TableHead className="w-[80px]">Platform</TableHead>
                    <TableHead className="w-[70px]">Origin</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-xs text-muted-foreground py-8">
                        No device events yet. Events appear here the moment a scan, pairing, connection or kiosk session runs.
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
                      <TableCell className="text-[11px]">
                        <div className="truncate max-w-[140px]" dir="ltr">{e.deviceName || e.deviceId || '—'}</div>
                        {e.deviceType && <div className="text-[10px] text-muted-foreground" dir="ltr">{e.deviceType}</div>}
                      </TableCell>
                      <TableCell><PlatformChip platform={e.platform} /></TableCell>
                      <TableCell className="text-[10px] text-muted-foreground">{e.origin}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* DEVICES view */}
          {view === 'devices' && (
            <div className="grid md:grid-cols-2 gap-3 max-h-[480px] overflow-y-auto blasti-scroll pe-1">
              {timelines.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground md:col-span-2 text-center py-8">
                  No device timelines yet.
                </p>
              )}
              {timelines.map((d) => (
                <Card key={`${d.deviceId ?? d.lastTs}`} className="py-3">
                  <CardContent className="px-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate" dir="ltr">{d.deviceName || d.deviceId || 'Unknown device'}</p>
                        <p className="text-[10px] text-muted-foreground truncate" dir="ltr">
                          {d.deviceType ?? '—'} · {d.platform ?? '—'}{d.agencyId ? ` · agency ${d.agencyId.slice(0, 8)}…` : ''}
                        </p>
                      </div>
                      <div className="text-end shrink-0">
                        <p className="text-lg font-bold leading-none" dir="ltr">{d.eventCount}</p>
                        <p className="text-[10px] text-muted-foreground">events</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {d.events.slice(0, 8).map((ev) => <EventChip key={ev} event={ev} />)}
                      {d.events.length > 8 && (
                        <Badge variant="outline" className="text-[10px]">+{d.events.length - 8} more</Badge>
                      )}
                    </div>
                    <p className="text-[10px] text-muted-foreground" dir="ltr">
                      {fmtTime(d.firstTs)} → {fmtTime(d.lastTs)}
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
              <div className="col-span-2 truncate"><span className="text-muted-foreground">device:</span> {detail?.deviceName ?? detail?.deviceId ?? '—'}</div>
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
