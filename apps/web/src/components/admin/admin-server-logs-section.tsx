'use client';

/**
 * AdminServerLogsSection — the Logs Manager "Server logs" tab (0.6.59).
 *
 * The VPS-side half of the logs story, in ONE place:
 *   • Sources  — systemd journal units (blasti-api/web/rebuild/watcher, caddy)
 *                + the log files on the server (deploy-*.log under the storage
 *                root, the repo logs dir).
 *   • Viewer   — structured tail with level/search filters + auto-refresh.
 *   • Download — EVERY format the server can produce: all journalctl output
 *                forms (short/iso/verbose/export/cat/json/ndjson/…), gzip
 *                companions, JSON-array post-processing; files: txt/ndjson/
 *                json-array/gz.
 *   • Cross-analysis — server error groups for a time window, each
 *                CORRELATED with the app-side bug index (keyword overlap +
 *                time-window proximity) so a server event and the client
 *                bugs around it are analyzed together — e.g. the delta
 *                pipeline (asar/outref/504) vs desktop update errors.
 *
 * Backend: apps/api/src/routes/server-logs.ts (mounted at /api/logs-server).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Download,
  FileDown,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Siren,
  Sparkles,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// ─── Types (mirror apps/api/src/routes/server-logs.ts payloads) ──────────────

interface LogSource {
  kind: 'journal' | 'file';
  id: string;
  label: string;
  available: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

interface SourcesPayload {
  journalAvailable: boolean;
  units: LogSource[];
  files: LogSource[];
  generatedAt: string;
}

interface ServerLogEntry {
  ts: string;
  source: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

interface ServerFormat {
  id: string;
  ext: string;
  mime: string;
  gzip: boolean;
  jsonArray: boolean;
}

interface ServerErrorGroup {
  id: string;
  source: string;
  level: 'warn' | 'error';
  template: string;
  sample: string;
  count: number;
  firstTs: string;
  lastTs: string;
  keywords: string[];
}

interface Correlation {
  server: ServerErrorGroup;
  correlatedBugs: Array<{
    fp: string;
    tag: string;
    message: string;
    count: number;
    severity: string;
    triggers: string[];
    platforms: string[];
    lastSeen: string;
    match: { keywords: string[]; timeOverlap: boolean };
    score: number;
  }>;
}

interface AnalysisPayload {
  windowHours: number;
  generatedAt: string;
  summary: {
    serverGroups: number;
    serverHits: number;
    appBugs: number;
    deltaTopicHits: number;
    correlated: number;
  };
  correlations: Correlation[];
}

const LEVEL_STYLES: Record<string, string> = {
  error: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900',
  warn: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900',
  info: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
  debug: 'bg-muted text-muted-foreground border-border',
};

function humanSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function AdminServerLogsSection() {
  const { t } = useLanguage();

  // ── Sources ──
  const [sources, setSources] = useState<SourcesPayload | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selected, setSelected] = useState<string>('');

  // ── Viewer ──
  const [entries, setEntries] = useState<ServerLogEntry[] | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [lines, setLines] = useState('200');
  const [levelFilter, setLevelFilter] = useState('');
  const [query, setQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  // ── Download formats ──
  const [formats, setFormats] = useState<ServerFormat[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);

  // ── Cross-analysis ──
  const [analysisHours, setAnalysisHours] = useState('24');
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const fetchSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const res = await apiFetch('/api/logs-server/sources');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setSources(data as SourcesPayload);
        setSelected((prev) => {
          if (prev) return prev;
          const firstUnit = (data.units as LogSource[]).find((u) => u.available);
          return firstUnit?.id ?? data.files?.[0]?.id ?? '';
        });
      }
    } catch { /* keep last state */ } finally {
      setSourcesLoading(false);
    }
  }, []);

  const fetchView = useCallback(
    async (isRefresh = false) => {
      if (!selected) return;
      if (isRefresh) setViewLoading(true);
      try {
        const p = new URLSearchParams({ source: selected, lines });
        if (levelFilter) p.set('level', levelFilter);
        if (queryRef.current.trim()) p.set('q', queryRef.current.trim());
        const res = await apiFetch(`/api/logs-server/view?${p.toString()}`);
        const data = await res.json().catch(() => null);
        if (res.ok && data?.success) {
          setEntries(data.entries as ServerLogEntry[]);
          setViewError(null);
        } else {
          setEntries([]);
          setViewError(data?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        setViewError(err instanceof Error ? err.message : 'Network error');
      } finally {
        setViewLoading(false);
      }
    },
    [selected, lines, levelFilter],
  );

  const fetchFormats = useCallback(async (source: string) => {
    try {
      const res = await apiFetch(`/api/logs-server/formats?source=${encodeURIComponent(source)}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) setFormats(data.formats as ServerFormat[]);
      else setFormats([]);
    } catch {
      setFormats([]);
    }
  }, []);

  // Initial sources load
  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // Source/params change → reload view + formats
  useEffect(() => {
    if (selected) {
      fetchView();
      fetchFormats(selected);
    }
  }, [selected, lines, levelFilter, fetchView, fetchFormats]);

  // Auto-refresh (30 s) while enabled
  useEffect(() => {
    if (!autoRefresh || !selected) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchView(true);
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, selected, fetchView]);

  const runAnalysis = useCallback(async () => {
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const res = await apiFetch(`/api/logs-server/analysis?hours=${encodeURIComponent(analysisHours)}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) setAnalysis(data as AnalysisPayload);
      else setAnalysisError(data?.error || `HTTP ${res.status}`);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setAnalysisLoading(false);
    }
  }, [analysisHours]);

  const downloadLog = useCallback(
    async (source: string, fmt: ServerFormat) => {
      setDownloading(`${source}:${fmt.id}`);
      try {
        const res = await apiFetch(
          `/api/logs-server/download?source=${encodeURIComponent(source)}&format=${encodeURIComponent(fmt.id)}`,
        );
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            if (j?.error) msg = j.error;
          } catch { /* plain status */ }
          setDownloading(null);
          setViewError(msg);
          return;
        }
        const blob = await res.blob();
        // Content-Disposition carries the server-side filename — reuse it.
        const cd = res.headers?.get?.('content-disposition') || '';
        const m = /filename="?([^";]+)"?/.exec(cd);
        const name = m?.[1] || `blasti-log-${Date.now()}.${fmt.ext}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch (err) {
        setViewError(err instanceof Error ? err.message : 'Download failed');
      } finally {
        setDownloading(null);
      }
    },
    [],
  );

  const formatLabel = (f: ServerFormat): string => {
    const base = f.id.replace('.gz', '').replace('-', ' ');
    if (f.jsonArray) return `JSON array (.${f.ext})`;
    return `${base} (.${f.ext})${f.gzip ? ' · gzip' : ''}`;
  };

  const selectedIsJournal = selected.startsWith('journal:');

  const allSources: LogSource[] = [
    ...(sources?.units ?? []),
    ...(sources?.files ?? []),
  ];

  return (
    <div className="space-y-4">
      {/* ── Sources + viewer ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-slate-100 to-zinc-100 dark:from-slate-900/60 dark:to-zinc-900/40 flex items-center justify-center shrink-0">
                <Server className="h-5 w-5 text-slate-600 dark:text-slate-300" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">{t('serverLogsTitle')}</CardTitle>
                <CardDescription className="truncate">{t('serverLogsDesc')}</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => fetchSources()}
                disabled={sourcesLoading}
                aria-label={t('publicAppRefresh')}
              >
                <RefreshCw className={`h-4 w-4 ${sourcesLoading ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">{t('publicAppRefresh')}</span>
              </Button>
              <Button
                variant={autoRefresh ? 'default' : 'outline'}
                size="sm"
                className="h-9"
                onClick={() => setAutoRefresh((v) => !v)}
                aria-pressed={autoRefresh}
              >
                <Activity className="h-4 w-4" />
                <span className="hidden sm:inline">{t('serverLogsLive')}</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Source picker + download */}
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selected || undefined} onValueChange={setSelected}>
              <SelectTrigger className="h-9 w-full sm:w-72 text-xs" aria-label={t('serverLogsSource')}>
                <SelectValue placeholder={t('serverLogsSource')} />
              </SelectTrigger>
              <SelectContent>
                {sources?.journalAvailable && (sources?.units.length ?? 0) > 0 && (
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t('serverLogsJournalUnits')}
                  </DropdownMenuLabel>
                )}
                {(sources?.units ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id} disabled={!u.available}>
                    <span className="flex items-center gap-2">
                      <Server className="h-3.5 w-3.5" />
                      <span className="font-mono" dir="ltr">{u.id}</span>
                      {!u.available && <Badge variant="secondary" className="h-4 px-1 text-[9px]">{t('serverLogsUnavailable')}</Badge>}
                    </span>
                  </SelectItem>
                ))}
                {(sources?.files.length ?? 0) > 0 && (
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t('serverLogsFiles')}
                  </DropdownMenuLabel>
                )}
                {(sources?.files ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    <span className="flex items-center gap-2 min-w-0">
                      <HardDrive className="h-3.5 w-3.5 shrink-0" />
                      <span className="font-mono truncate" dir="ltr">{f.label}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{humanSize(f.sizeBytes)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Download — ALL formats the server produces for this source */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9" disabled={!selected || formats.length === 0}>
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {t('serverLogsDownload')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto custom-scrollbar">
                <DropdownMenuLabel>{t('serverLogsDownloadFormats')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {formats.map((f) => (
                  <DropdownMenuItem
                    key={f.id}
                    onClick={() => selected && void downloadLog(selected, f)}
                    className="gap-2"
                  >
                    <FileDown className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-xs capitalize">{formatLabel(f)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="relative flex-1 min-w-[160px]">
              <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('serverLogsSearch')}
                className="ps-8 h-9 text-xs"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') fetchView(true);
                }}
              />
            </div>

            <Select value={lines} onValueChange={setLines}>
              <SelectTrigger className="h-9 w-24 text-xs" aria-label={t('serverLogsLines')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['100', '200', '500', '1000'].map((n) => (
                  <SelectItem key={n} value={n} dir="ltr">{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={levelFilter || 'all'} onValueChange={(v) => setLevelFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-9 w-28 text-xs" aria-label={t('serverLogsLevel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('serverLogsLevelAll')}</SelectItem>
                <SelectItem value="error">{t('serverLogsLevelError')}</SelectItem>
                <SelectItem value="warn">{t('serverLogsLevelWarn')}</SelectItem>
                <SelectItem value="info">{t('serverLogsLevelInfo')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Entries */}
          {viewLoading && entries === null && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-5/6" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          )}

          {viewError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive" dir="ltr">
              {viewError}
            </div>
          )}

          {entries !== null && entries.length === 0 && !viewError && (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('serverLogsEmpty')}</p>
          )}

          {entries !== null && entries.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <div
                className="max-h-[420px] overflow-y-auto custom-scrollbar divide-y divide-border/60 bg-muted/20"
                role="log"
                aria-live="off"
                aria-label={t('serverLogsTitle')}
              >
                {entries.map((e, i) => (
                  <div key={`${e.ts}-${i}`} className="flex gap-2 px-3 py-1.5 items-start">
                    <Badge
                      variant="outline"
                      className={`text-[9px] font-semibold shrink-0 mt-0.5 ${LEVEL_STYLES[e.level] ?? ''}`}
                    >
                      {e.level}
                    </Badge>
                    <span className="text-[10px] font-mono text-muted-foreground shrink-0 mt-0.5" dir="ltr">
                      {e.ts.replace('T', ' ').slice(0, 19)}
                    </span>
                    <span className="text-[11px] font-mono break-all leading-relaxed min-w-0" dir="ltr">
                      {e.message}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between px-3 py-1.5 border-t bg-background/60">
                <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">
                  {entries.length} · {selected}
                </span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => fetchView(true)} disabled={viewLoading}>
                  <RefreshCw className={`h-3 w-3 ${viewLoading ? 'animate-spin' : ''}`} />
                  {t('publicAppRefresh')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Cross-analysis: server events × app logs ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-rose-100 to-orange-100 dark:from-rose-900/40 dark:to-orange-900/30 flex items-center justify-center shrink-0">
                <Sparkles className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-base">{t('serverLogsAnalysisTitle')}</CardTitle>
                <CardDescription className="truncate">{t('serverLogsAnalysisDesc')}</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Select value={analysisHours} onValueChange={setAnalysisHours}>
                <SelectTrigger className="h-9 w-28 text-xs" aria-label={t('serverLogsWindow')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="6">6h</SelectItem>
                  <SelectItem value="24">24h</SelectItem>
                  <SelectItem value="72">72h</SelectItem>
                  <SelectItem value="168">7d</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" className="h-9" onClick={() => void runAnalysis()} disabled={analysisLoading}>
                {analysisLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Siren className="h-4 w-4" />}
                {t('serverLogsAnalyze')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {analysisError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive" dir="ltr">
              {analysisError}
            </div>
          )}

          {!analysis && !analysisLoading && !analysisError && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('serverLogsAnalysisIdle')}</p>
          )}

          {analysis && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { label: t('serverLogsKpiGroups'), value: analysis.summary.serverGroups },
                  { label: t('serverLogsKpiHits'), value: analysis.summary.serverHits },
                  { label: t('serverLogsKpiCorrelated'), value: analysis.summary.correlated },
                  { label: t('serverLogsKpiDelta'), value: analysis.summary.deltaTopicHits },
                ].map((kpi) => (
                  <div key={kpi.label} className="rounded-lg border p-2.5 text-center">
                    <p className="text-lg font-bold font-mono" dir="ltr">{kpi.value}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{kpi.label}</p>
                  </div>
                ))}
              </div>

              {analysis.summary.deltaTopicHits > 0 && (
                <div className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-3">
                  <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                    {t('serverLogsDeltaFlag')}
                  </p>
                  <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-0.5">
                    {t('serverLogsDeltaFlagDesc')}
                  </p>
                </div>
              )}

              {analysis.correlations.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('serverLogsAnalysisClean')}</p>
              )}

              <div className="space-y-2 max-h-[480px] overflow-y-auto custom-scrollbar">
                {analysis.correlations.map((c) => (
                  <div key={c.server.id} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant="outline"
                        className={`text-[9px] font-semibold ${LEVEL_STYLES[c.server.level] ?? ''}`}
                      >
                        {c.server.level}
                      </Badge>
                      <span className="text-[10px] font-mono text-muted-foreground" dir="ltr">{c.server.source}</span>
                      <Badge variant="secondary" className="text-[10px] h-5">×{c.server.count}</Badge>
                      <span className="text-[10px] text-muted-foreground font-mono ms-auto" dir="ltr">
                        {c.server.lastTs.replace('T', ' ').slice(0, 19)}
                      </span>
                    </div>
                    <p className="text-xs font-mono break-all leading-relaxed" dir="ltr">
                      {c.server.sample}
                    </p>
                    {c.correlatedBugs.length > 0 && (
                      <div className="rounded-md bg-muted/40 p-2 space-y-1.5">
                        <p className="text-[10px] font-semibold text-muted-foreground">
                          {t('serverLogsCorrelatedWith')}
                        </p>
                        {c.correlatedBugs.map((b) => (
                          <div key={b.fp} className="flex items-start gap-2 text-[11px]">
                            <Badge variant="outline" className={`text-[9px] shrink-0 ${LEVEL_STYLES[b.severity === 'CRITICAL' || b.severity === 'HIGH' ? 'error' : 'warn'] ?? ''}`}>
                              {b.severity}
                            </Badge>
                            <div className="min-w-0">
                              <p className="break-all leading-relaxed" dir="ltr">{b.message}</p>
                              <p className="text-[9px] text-muted-foreground font-mono" dir="ltr">
                                {b.fp.slice(0, 10)} · ×{b.count}
                                {(b.triggers ?? []).length > 0 ? ` · ${b.triggers.join(',')}` : ''}
                                {b.match.timeOverlap ? ` · ${t('serverLogsTimeMatch')}` : ''}
                                {b.match.keywords.length > 0 ? ` · ${b.match.keywords.slice(0, 4).join(', ')}` : ''}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
