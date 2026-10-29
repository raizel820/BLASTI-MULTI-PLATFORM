'use client';

/**
 * AdminLogsManager — Logs Manager (logs-2 / 0.6.19)
 *
 * The dedicated SUPER_ADMIN page under "Database & Storage" that owns
 * everything logs. It MOVED OUT of the Storage Manager (user request: "move
 * the logs from storage manager to new page called logs manager under
 * database and storage section") and upgraded from a raw-file browser into a
 * realtime analysis console:
 *
 *   ┌ Overview ── KPI tiles + severity/platform distributions (auto-refresh)
 *   ├ Errors ──── the realtime fingerprint index: isolate bugs by ANY shared
 *   │             attribute (UID, platform, role, app version, device, date),
 *   │             severity-ranked, with a full detail dialog per bug
 *   ├ Daily ───── the auto-generated per-day per-platform JSON (ALL accounts)
 *   └ Raw logs ── the 0.6.16 vault browser (platform-separated folders)
 *
 * Reports are generated on demand ("all errors" button or per-bug) as
 * copyable/downloadable markdown. The analysis itself happens server-side in
 * realtime on every ingested batch (apps/api/src/lib/logs-analyzer.ts) — this
 * page only renders its index.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bug,
  CalendarDays,
  Check,
  Copy,
  Download,
  FileJson,
  FlaskConical,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Siren,
  X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AdminAccountLogsVault } from '@/components/admin/admin-account-logs-vault';

// ─── Types (mirror apps/api/src/lib/logs-analyzer.ts payloads) ───────────────

interface ErrorRec {
  fp: string;
  tag: string;
  level: 'warn' | 'error';
  message: string;
  count: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  severityScore: number;
  firstSeen: string;
  lastSeen: string;
  samples: Array<{ ts: string; message: string; data?: unknown }>;
  affected: {
    uids: string[];
    platforms: string[];
    appVersions: string[];
    devices: string[];
    roles: string[];
    dates: string[];
  };
}

interface AnalysisSummary {
  totalErrors: number;
  bySeverity: Record<string, number>;
  byPlatform: Record<string, number>;
  last24h: number;
  updatedAt: string;
}

interface DailyFileInfo {
  platform: string;
  date: string;
  file: string;
  bytes: number;
}

interface DailyRecord {
  date: string;
  platform: string;
  updatedAt: string;
  totals: { batches: number; entries: number; errors: number; warns: number; accounts: number };
  accounts: Array<{ uid: string; role: string; appVersion: string; device: string; entries: number; errors: number; warns: number; lastSeen: string }>;
  topErrors: Array<{ fp: string; count: number; severity: string; message: string; uids: number }>;
  perf: { pageLoadMsAvg: number | null; pageLoadMsSamples: number; domReadyMsAvg: number | null; heapMbAvg: number | null };
}

interface ReportPayload {
  generatedAt: string;
  scope: string;
  filters: Record<string, string | undefined>;
  summary: AnalysisSummary;
  bugs: ErrorRec[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function humanSize(bytes: number): string {
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

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function downloadText(name: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch { /* non-fatal */ }
}

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-900',
  HIGH: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-900',
  MEDIUM: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900',
  LOW: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/60 dark:text-slate-300 dark:border-slate-700',
};

const PLATFORMS = ['web', 'mobile', 'desktop'] as const;
const ROLES = ['SUPER_ADMIN', 'AGENCY_OWNER', 'STAFF', 'CUSTOMER'] as const;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/** Client-side markdown render of a report payload (copy/download). */
function reportToMarkdown(r: ReportPayload, lang: { t: (k: never) => string }): string {
  const L = [
    `# BLASTI Logs Analysis Report`,
    '',
    `- Generated: ${r.generatedAt}`,
    `- Scope: ${r.scope}`,
    `- Total tracked bugs: ${r.summary.totalErrors} (last 24h: ${r.summary.last24h})`,
    `- By severity: ${Object.entries(r.summary.bySeverity).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `- By platform: ${Object.entries(r.summary.byPlatform).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `- Filters: ${JSON.stringify(r.filters)}`,
    '',
    `---`,
    '',
  ];
  if (r.bugs.length === 0) {
    L.push('No bugs matched the requested scope. / لا أخطاء مطابقة.');
  }
  for (const b of r.bugs) {
    L.push(
      `## [${b.severity}] ${b.tag} — ${b.count} hit(s)`,
      '',
      `- Fingerprint: \`${b.fp}\``,
      `- Level: ${b.level} · Severity score: ${b.severityScore}`,
      `- First seen: ${b.firstSeen} · Last seen: ${b.lastSeen}`,
      `- UIDs (${b.affected.uids.length}): ${b.affected.uids.slice(0, 10).join(', ')}${b.affected.uids.length > 10 ? ' …' : ''}`,
      `- Platforms: ${b.affected.platforms.join(', ')} · Roles: ${b.affected.roles.join(', ')}`,
      `- App versions: ${b.affected.appVersions.join(', ') || 'unknown'}`,
      `- Devices: ${b.affected.devices.slice(0, 5).join(' | ')}${b.affected.devices.length > 5 ? ' …' : ''}`,
      `- Dates: ${b.affected.dates.join(', ')}`,
      '',
      `Latest sample:`,
      '```',
      b.message,
      '```',
      '',
    );
    for (const s of b.samples.slice(0, 3)) {
      L.push(`- sample @ ${s.ts}: ${s.message.slice(0, 300)}`);
    }
    L.push('');
  }
  void lang;
  return L.join('\n');
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Filters {
  q: string;
  uid: string;
  platform: string;
  role: string;
  appVersion: string;
  device: string;
  severity: string;
  minCount: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { q: '', uid: '', platform: '', role: '', appVersion: '', device: '', severity: '', minCount: '', from: '', to: '' };

export function AdminLogsManager() {
  const { t } = useLanguage();

  const [tab, setTab] = useState('overview');
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [errors, setErrors] = useState<ErrorRec[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Error detail dialog
  const [detail, setDetail] = useState<ErrorRec | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Daily tab
  const [dailyFiles, setDailyFiles] = useState<DailyFileInfo[] | null>(null);
  const [dailyView, setDailyView] = useState<{ platform: string; date: string; content: string } | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);

  // Report dialog
  const [report, setReport] = useState<{ title: string; md: string } | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const queryString = useCallback((f: Filters, extra?: Record<string, string>) => {
    const p = new URLSearchParams();
    if (f.uid) p.set('uid', f.uid);
    if (f.platform) p.set('platform', f.platform);
    if (f.role) p.set('role', f.role);
    if (f.appVersion) p.set('appVersion', f.appVersion);
    if (f.device) p.set('device', f.device);
    if (f.severity) p.set('severity', f.severity);
    if (f.minCount) p.set('minCount', f.minCount);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    if (f.q) p.set('q', f.q);
    for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
    return p.toString();
  }, []);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await apiFetch('/api/logs/analysis/summary');
      const body = await res.json().catch(() => null);
      if (res.ok && body?.summary) setSummary(body.summary as AnalysisSummary);
    } catch { /* keep last summary */ }
  }, []);

  const fetchErrors = useCallback(async () => {
    setLoading(true);
    try {
      const qs = queryString(filtersRef.current);
      const res = await apiFetch(`/api/logs/analysis${qs ? `?${qs}` : ''}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        setErrors(Array.isArray(body.errors) ? (body.errors as ErrorRec[]) : []);
        setTotal(typeof body.total === 'number' ? body.total : 0);
        if (body.summary) setSummary(body.summary as AnalysisSummary);
      } else {
        setErrors([]);
      }
    } catch {
      setErrors([]);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  const fetchDaily = useCallback(async () => {
    setDailyLoading(true);
    try {
      const res = await apiFetch('/api/logs/analysis/daily');
      const body = await res.json().catch(() => null);
      setDailyFiles(res.ok && body && Array.isArray(body.files) ? (body.files as DailyFileInfo[]) : []);
    } catch {
      setDailyFiles([]);
    } finally {
      setDailyLoading(false);
    }
  }, []);

  // Initial + filter-driven fetch
  useEffect(() => {
    fetchSummary();
    fetchErrors();
  }, [fetchSummary, fetchErrors]);

  // Tab-driven fetch (daily loads lazily)
  useEffect(() => {
    if (tab === 'daily' && dailyFiles === null) fetchDaily();
  }, [tab, dailyFiles, fetchDaily]);

  // Realtime feel: light auto-refresh while the manager is open (60s).
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchSummary();
      if (tab === 'errors') fetchErrors();
      if (tab === 'daily') fetchDaily();
    }, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, tab, fetchSummary, fetchErrors, fetchDaily]);

  const openDetail = async (fp: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await apiFetch(`/api/logs/analysis/errors/${encodeURIComponent(fp)}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.error) setDetail(body.error as ErrorRec);
    } catch { /* dialog stays closed */ } finally {
      setDetailLoading(false);
    }
  };

  const openDaily = async (platform: string, date: string) => {
    setDailyLoading(true);
    setDailyView(null);
    try {
      const res = await apiFetch(`/api/logs/analysis/daily/${encodeURIComponent(platform)}/${encodeURIComponent(date)}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.daily) {
        setDailyView({ platform, date, content: JSON.stringify(body.daily, null, 2) });
      }
    } catch { /* ignore */ } finally {
      setDailyLoading(false);
    }
  };

  const generateReport = async (fp?: string) => {
    setReportLoading(true);
    setReport(null);
    try {
      const qs = queryString(filtersRef.current, fp ? { fp } : { limit: '500' });
      const res = await apiFetch(`/api/logs/analysis/report${qs ? `?${qs}` : ''}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.report) {
        const md = reportToMarkdown(body.report as ReportPayload, { t: t as never });
        setReport({ title: fp ? `${t('logsManagerReportTitle')} · ${fp}` : t('logsManagerReportAll'), md });
      }
    } catch { /* ignore */ } finally {
      setReportLoading(false);
    }
  };

  const doCopy = async (text: string) => {
    const ok = await copyText(text);
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  const severityChip = (s: string) => (
    <Badge variant="outline" className={`text-[10px] font-semibold ${SEVERITY_STYLES[s] ?? ''}`}>{s}</Badge>
  );

  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((v) => v.trim() !== '').length,
    [filters],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-violet-100 to-fuchsia-100 dark:from-violet-900/40 dark:to-fuchsia-900/30 flex items-center justify-center shrink-0">
              <Activity className="h-5 w-5 text-violet-600 dark:text-violet-400" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle className="text-base">{t('logsManagerTitle')}</CardTitle>
              <CardDescription className="truncate">{t('logsManagerDesc')}</CardDescription>
            </div>
            <Button
              variant={autoRefresh ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAutoRefresh((v) => !v)}
              className="shrink-0"
              title={t('logsManagerAutoRefresh')}
            >
              <Activity className="h-4 w-4 me-1" />
              {t('logsManagerAutoRefresh')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { fetchSummary(); fetchErrors(); }} disabled={loading} className="shrink-0">
              {loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
              {t('storageRefresh')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void generateReport()} disabled={reportLoading} className="shrink-0">
              {reportLoading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <FlaskConical className="h-4 w-4 me-1" />}
              {t('logsManagerReportAll')}
            </Button>
          </div>
          {summary && (
            <CardDescription className="text-[11px]" dir="ltr">
              analyzer updated {new Date(summary.updatedAt).toLocaleString()}
            </CardDescription>
          )}
        </CardHeader>
      </Card>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid grid-cols-4 w-full max-w-xl">
          <TabsTrigger value="overview" className="gap-1"><Siren className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('logsManagerTabOverview')}</span></TabsTrigger>
          <TabsTrigger value="errors" className="gap-1"><Bug className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('logsManagerTabErrors')}</span></TabsTrigger>
          <TabsTrigger value="daily" className="gap-1"><CalendarDays className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('logsManagerTabDaily')}</span></TabsTrigger>
          <TabsTrigger value="raw" className="gap-1"><ScrollText className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('logsManagerTabRaw')}</span></TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <p className="text-[11px] text-muted-foreground">{t('logsManagerKpiBugs')}</p>
                <p className="text-2xl font-bold" dir="ltr">{summary ? summary.totalErrors : '—'}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <p className="text-[11px] text-muted-foreground">{t('logsManagerKpiLast24h')}</p>
                <p className="text-2xl font-bold" dir="ltr">{summary ? summary.last24h : '—'}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <p className="text-[11px] text-muted-foreground">{t('logsManagerKpiCritical')}</p>
                <p className="text-2xl font-bold text-red-600 dark:text-red-400" dir="ltr">{summary ? (summary.bySeverity.CRITICAL ?? 0) : '—'}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3 px-4">
                <p className="text-[11px] text-muted-foreground">{t('logsManagerKpiHigh')}</p>
                <p className="text-2xl font-bold text-orange-600 dark:text-orange-400" dir="ltr">{summary ? (summary.bySeverity.HIGH ?? 0) : '—'}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t('logsManagerBySeverity')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {SEVERITIES.map((s) => {
                  const v = summary?.bySeverity?.[s] ?? 0;
                  const max = Math.max(1, ...SEVERITIES.map((x) => summary?.bySeverity?.[x] ?? 0));
                  return (
                    <div key={s} className="flex items-center gap-2">
                      <span className="w-20 shrink-0">{severityChip(s)}</span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${s === 'CRITICAL' ? 'bg-red-500' : s === 'HIGH' ? 'bg-orange-500' : s === 'MEDIUM' ? 'bg-amber-500' : 'bg-slate-400'}`}
                          style={{ width: `${(v / max) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs font-medium w-8 text-end" dir="ltr">{v}</span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t('logsManagerByPlatform')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {PLATFORMS.map((p) => {
                  const v = summary?.byPlatform?.[p] ?? 0;
                  const max = Math.max(1, ...PLATFORMS.map((x) => summary?.byPlatform?.[x] ?? 0));
                  return (
                    <div key={p} className="flex items-center gap-2">
                      <Badge variant="outline" className="w-20 justify-center shrink-0 uppercase text-[10px]" dir="ltr">{p}</Badge>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-violet-500" style={{ width: `${(v / max) * 100}%` }} />
                      </div>
                      <span className="text-xs font-medium w-8 text-end" dir="ltr">{v}</span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          {/* Top bugs quick list (severity-sorted, same as errors tab head) */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t('logsManagerTopBugs')}</CardTitle>
              <CardDescription className="text-[11px]">{t('logsManagerTopBugsDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin me-2" />{t('loading')}
                </div>
              ) : (errors?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">{t('logsManagerNoErrors')}</p>
              ) : (
                <div className="space-y-1.5">
                  {errors!.slice(0, 8).map((e) => (
                    <button
                      key={e.fp}
                      type="button"
                      onClick={() => void openDetail(e.fp)}
                      className="w-full text-start flex items-center gap-2 rounded-lg border p-2 hover:bg-muted/50 transition-colors"
                    >
                      {severityChip(e.severity)}
                      <Badge variant="secondary" className="text-[10px] shrink-0" dir="ltr">{e.tag}</Badge>
                      <span className="text-xs truncate flex-1 min-w-0" dir="ltr">{e.message}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0" dir="ltr">×{e.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Errors ───────────────────────────────────────────────────── */}
        <TabsContent value="errors" className="space-y-3">
          {/* Filters */}
          <Card>
            <CardContent className="pt-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input value={filters.q} onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} placeholder={t('logsManagerFilterQuery')} className="ps-9 h-9" />
                </div>
                <Input value={filters.uid} onChange={(e) => setFilters((f) => ({ ...f, uid: e.target.value }))} placeholder={t('logsManagerFilterUid')} className="w-36 h-9" dir="ltr" />
                <Input value={filters.appVersion} onChange={(e) => setFilters((f) => ({ ...f, appVersion: e.target.value }))} placeholder={t('logsManagerFilterVersion')} className="w-28 h-9" dir="ltr" />
                <Input value={filters.device} onChange={(e) => setFilters((f) => ({ ...f, device: e.target.value }))} placeholder={t('logsManagerFilterDevice')} className="w-32 h-9" dir="ltr" />
                <Input value={filters.minCount} onChange={(e) => setFilters((f) => ({ ...f, minCount: e.target.value.replace(/\D/g, '') }))} placeholder={t('logsManagerFilterMinCount')} className="w-20 h-9" dir="ltr" />
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={filters.platform || 'all'} onValueChange={(v) => setFilters((f) => ({ ...f, platform: v === 'all' ? '' : v }))}>
                  <SelectTrigger className="w-32 h-9"><SelectValue placeholder={t('logsManagerFilterPlatform')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('logsManagerFilterPlatform')}: {t('logsManagerAll')}</SelectItem>
                    {PLATFORMS.map((p) => <SelectItem key={p} value={p} dir="ltr">{p}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.role || 'all'} onValueChange={(v) => setFilters((f) => ({ ...f, role: v === 'all' ? '' : v }))}>
                  <SelectTrigger className="w-44 h-9"><SelectValue placeholder={t('logsManagerFilterRole')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('logsManagerFilterRole')}: {t('logsManagerAll')}</SelectItem>
                    {ROLES.map((r) => <SelectItem key={r} value={r} dir="ltr">{r}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.severity || 'all'} onValueChange={(v) => setFilters((f) => ({ ...f, severity: v === 'all' ? '' : v }))}>
                  <SelectTrigger className="w-36 h-9"><SelectValue placeholder={t('logsManagerSeverity')} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('logsManagerSeverity')}: {t('logsManagerAll')}</SelectItem>
                    {SEVERITIES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} className="w-36 h-9" dir="ltr" title={t('logsManagerFilterFrom')} />
                <Input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} className="w-36 h-9" dir="ltr" title={t('logsManagerFilterTo')} />
                <Button size="sm" className="h-9" onClick={() => fetchErrors()}>{t('logsManagerApply')}</Button>
                {activeFilterCount > 0 && (
                  <Button size="sm" variant="ghost" className="h-9" onClick={() => { setFilters(EMPTY_FILTERS); }}>
                    <X className="h-3.5 w-3.5 me-1" />{t('logsManagerFiltersClear')} ({activeFilterCount})
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Errors table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t('logsManagerErrorsIndex')}</CardTitle>
              <CardDescription className="text-[11px]">{t('logsManagerErrorsDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin me-2" />{t('loading')}
                </div>
              ) : (errors?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">{t('logsManagerNoErrors')}</p>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground mb-2" dir="ltr">
                    showing {errors!.length} / {total} bug fingerprint(s)
                  </p>
                  <div className="rounded-xl border overflow-hidden">
                    <div className="max-h-[60vh] overflow-y-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-24">{t('logsManagerSeverity')}</TableHead>
                            <TableHead className="w-28">{t('logsManagerColTag')}</TableHead>
                            <TableHead>{t('logsManagerColMessage')}</TableHead>
                            <TableHead className="w-16 text-center">{t('logsManagerColCount')}</TableHead>
                            <TableHead className="w-16 text-center">{t('logsManagerColUids')}</TableHead>
                            <TableHead className="w-28">{t('logsManagerColPlatforms')}</TableHead>
                            <TableHead className="w-40">{t('logsManagerColLastSeen')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {errors!.map((e) => (
                            <TableRow key={e.fp} className="cursor-pointer" onClick={() => void openDetail(e.fp)}>
                              <TableCell>{severityChip(e.severity)}</TableCell>
                              <TableCell><Badge variant="secondary" className="text-[10px]" dir="ltr">{e.tag}</Badge></TableCell>
                              <TableCell><span className="text-xs line-clamp-2" dir="ltr">{e.message}</span></TableCell>
                              <TableCell className="text-center text-xs font-semibold" dir="ltr">{e.count}</TableCell>
                              <TableCell className="text-center text-xs" dir="ltr">{e.affected.uids.length}</TableCell>
                              <TableCell><span className="text-[10px]" dir="ltr">{e.affected.platforms.join(', ')}</span></TableCell>
                              <TableCell><span className="text-[10px] text-muted-foreground" dir="ltr">{new Date(e.lastSeen).toLocaleString()}</span></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Daily JSON ───────────────────────────────────────────────── */}
        <TabsContent value="daily" className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{t('logsManagerDailyTitle')}</CardTitle>
              <CardDescription className="text-[11px]">{t('logsManagerDailyDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {dailyLoading && !dailyFiles ? (
                <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin me-2" />{t('loading')}
                </div>
              ) : (dailyFiles?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">{t('logsManagerDailyEmpty')}</p>
              ) : (
                <div className="rounded-xl border overflow-hidden">
                  <div className="max-h-[60vh] overflow-y-auto divide-y">
                    {dailyFiles!.map((f) => (
                      <div key={f.file} className="flex items-center gap-2 p-3">
                        <FileJson className="h-4 w-4 text-violet-500 shrink-0" />
                        <Badge variant="secondary" className="text-[10px] uppercase shrink-0" dir="ltr">{f.platform}</Badge>
                        <span className="font-mono text-sm" dir="ltr">{f.date}</span>
                        <span className="flex-1" />
                        <span className="text-[10px] text-muted-foreground shrink-0">{humanSize(f.bytes)}</span>
                        <Button variant="outline" size="sm" className="h-7 text-[11px] shrink-0" onClick={() => void openDaily(f.platform, f.date)}>
                          {t('logsManagerView')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Raw logs (the moved vault) ──────────────────────────────── */}
        <TabsContent value="raw">
          <AdminAccountLogsVault />
        </TabsContent>
      </Tabs>

      {/* ── Error detail dialog ─────────────────────────────────────────── */}
      <Dialog open={detailLoading || detail !== null} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {detail ? severityChip(detail.severity) : <Loader2 className="h-4 w-4 animate-spin" />}
              <Badge variant="secondary" className="text-[10px]" dir="ltr">{detail?.tag ?? '…'}</Badge>
              {detail && <span className="text-xs text-muted-foreground" dir="ltr">×{detail.count}</span>}
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] truncate" dir="ltr">
              {detail ? `fp: ${detail.fp}` : t('loading')}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground" dir="ltr">
                <span>first: {new Date(detail.firstSeen).toLocaleString()}</span>
                <span>· last: {new Date(detail.lastSeen).toLocaleString()}</span>
                <span>· score: {detail.severityScore}</span>
              </div>
              <div>
                <p className="text-[11px] font-semibold mb-1">{t('logsManagerAffected')}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded-lg border p-2">
                    <span className="font-medium" dir="ltr">UIDs ({detail.affected.uids.length})</span>
                    <p className="font-mono mt-1 break-all" dir="ltr">{detail.affected.uids.join(', ') || '—'}</p>
                  </div>
                  <div className="rounded-lg border p-2">
                    <span className="font-medium" dir="ltr">{t('logsManagerColPlatforms')} / roles / versions</span>
                    <p className="font-mono mt-1" dir="ltr">{detail.affected.platforms.join(', ')} · {detail.affected.roles.join(', ')} · {detail.affected.appVersions.join(', ') || '?'}</p>
                  </div>
                  <div className="rounded-lg border p-2 sm:col-span-2">
                    <span className="font-medium" dir="ltr">{t('logsManagerColDevices')} ({detail.affected.devices.length})</span>
                    <p className="font-mono mt-1 break-all" dir="ltr">{detail.affected.devices.slice(0, 6).join(' | ') || '—'}</p>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-[11px] font-semibold mb-1">{t('logsManagerSamples')}</p>
                <pre className="text-[11px] leading-4 font-mono whitespace-pre-wrap break-all bg-muted/50 rounded-lg p-3 max-h-56 overflow-y-auto border" dir="ltr">
                  {detail.samples.map((s) => `[${s.ts}] ${s.message}${s.data ? `\n  data: ${JSON.stringify(s.data).slice(0, 400)}` : ''}`).join('\n\n')}
                </pre>
              </div>
              <div className="flex justify-end gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => void doCopy(detail.fp)}>
                  {copied ? <Check className="h-3.5 w-3.5 me-1" /> : <Copy className="h-3.5 w-3.5 me-1" />}
                  {copied ? t('logsManagerCopied') : t('logsManagerCopyFp')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { setDetail(null); void generateReport(detail.fp); }}>
                  <FlaskConical className="h-3.5 w-3.5 me-1" />
                  {t('logsManagerReportThis')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Daily JSON viewer ───────────────────────────────────────────── */}
      <Dialog open={dailyLoading || dailyView !== null} onOpenChange={(open) => { if (!open) setDailyView(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm" dir="ltr">
              {dailyView ? `${dailyView.platform} · ${dailyView.date}` : t('loading')}
            </DialogTitle>
            <DialogDescription className="text-[11px]">{t('logsManagerDailyDesc')}</DialogDescription>
          </DialogHeader>
          {dailyView && (
            <div className="space-y-2">
              <pre className="text-[11px] leading-4 font-mono whitespace-pre-wrap break-all bg-muted/50 rounded-lg p-3 max-h-[55vh] overflow-y-auto border" dir="ltr">
                {dailyView.content}
              </pre>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => void doCopy(dailyView.content)}>
                  {copied ? <Check className="h-3.5 w-3.5 me-1" /> : <Copy className="h-3.5 w-3.5 me-1" />}
                  {copied ? t('logsManagerCopied') : t('logsManagerCopy')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => downloadText(`blasti-daily-${dailyView.platform}-${dailyView.date}.json`, dailyView.content, 'application/json;charset=utf-8')}>
                  <Download className="h-3.5 w-3.5 me-1" />
                  {t('storageDownload')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Report dialog ───────────────────────────────────────────────── */}
      <Dialog open={reportLoading || report !== null} onOpenChange={(open) => { if (!open) setReport(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{report ? report.title : t('logsManagerReportTitle')}</DialogTitle>
            <DialogDescription className="text-[11px]">{t('logsManagerReportDesc')}</DialogDescription>
          </DialogHeader>
          {report && (
            <div className="space-y-2">
              <pre className="text-[11px] leading-4 font-mono whitespace-pre-wrap break-all bg-muted/50 rounded-lg p-3 max-h-[55vh] overflow-y-auto border" dir="ltr">
                {report.md}
              </pre>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => void doCopy(report.md)}>
                  {copied ? <Check className="h-3.5 w-3.5 me-1" /> : <Copy className="h-3.5 w-3.5 me-1" />}
                  {copied ? t('logsManagerCopied') : t('logsManagerCopy')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => downloadText(`blasti-logs-report-${new Date().toISOString().slice(0, 10)}.md`, report.md, 'text/markdown;charset=utf-8')}>
                  <Download className="h-3.5 w-3.5 me-1" />
                  {t('storageDownload')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
