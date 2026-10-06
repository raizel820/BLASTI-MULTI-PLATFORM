'use client';
import { apiFetch } from '@/lib/api-fetch';

import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { motion } from 'framer-motion';
import {
  GitBranch,
  RefreshCw,
  Radio,
  Rocket,
  CheckCircle2,
  XCircle,
  Server,
  Terminal,
  AlertTriangle,
} from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────

interface DeployEvent {
  at: string;
  kind: string;
  status: string;
  commit: string | null;
  message?: string;
  sinceSec?: number | null;
}

interface DeployStatusData {
  watcher: {
    active: boolean;
    lastCheckAt: string | null;
    sinceCheckSec: number | null;
    staleAfterSec: number;
    lastCommit: string | null;
    branch: string | null;
    repo: string | null;
    lastResult: string | null;
    lastMessage: string | null;
  };
  lastDeploy: {
    at: string | null;
    sinceSec: number | null;
    commit: string | null;
    branch: string | null;
    status: string | null;
    kind: string | null;
    durationSec: number | null;
    message: string | null;
  } | null;
  events: DeployEvent[];
  api: {
    version: string;
    uptimeSec: number;
    nodeEnv: string | null;
    now: string;
  };
}

// ─── Formatting helpers ────────────────────────────────────────────

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

function formatAgo(sec: number | null | undefined, isRTL: boolean): string {
  if (sec === null || sec === undefined) return isRTL ? '—' : '—';
  if (sec < 60) return isRTL ? `منذ ${sec} ثانية` : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return isRTL ? `منذ ${min} دقيقة` : `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 48) return isRTL ? `منذ ${hrs} ساعة` : `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return isRTL ? `منذ ${days} يوم` : `${days}d ago`;
}

function formatUptime(sec: number, isRTL: boolean): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return isRTL ? `${d}ي ${h}س` : `${d}d ${h}h`;
  if (h > 0) return isRTL ? `${h}س ${m}د` : `${h}h ${m}m`;
  return isRTL ? `${m}دقيقة` : `${m}m`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── Component ─────────────────────────────────────────────────────

export function AdminDeployStatus() {
  const { lang } = useLanguage();
  const isRTL = lang === 'ar';

  const [data, setData] = useState<DeployStatusData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [refreshing, setRefreshing] = useState(false);

  const fetchStatus = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await apiFetch('/api/system/deploy-status');
      if (res.ok) {
        const json = await res.json();
        if (json?.success) {
          setData(json as DeployStatusData);
          setLoadState('ready');
          return;
        }
      }
      // 401/403/404 → the endpoint exists but is not reachable/authorized here
      if (loadState !== 'ready') setLoadState('unavailable');
    } catch {
      if (loadState !== 'ready') setLoadState('unavailable');
    } finally {
      setRefreshing(false);
    }
  }, [loadState]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => fetchStatus(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loadState === 'loading') {
    return <Skeleton className="h-40 w-full rounded-2xl" />;
  }

  if (loadState === 'unavailable' || !data) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 rounded-xl">
        <CardContent className="p-4 flex items-center gap-3 text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="text-xs">
            {isRTL
              ? 'حالة النشر التلقائي غير متاحة على هذا الخادم (يحتاج تحديثاً إلى أحدث إصدار من الـ API).'
              : 'Deploy status is not available on this server (needs an update to the latest API version).'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const w = data.watcher;
  const d = data.lastDeploy;

  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 rounded-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-200 to-orange-300 dark:from-amber-900/40 dark:to-orange-800/40 flex items-center justify-center shadow-sm">
                <GitBranch className="h-4 w-4 text-amber-700 dark:text-amber-400" />
              </div>
              {isRTL ? 'النشر التلقائي ومراقب جيت هب' : 'Auto-Deploy & GitHub Watcher'}
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => fetchStatus(true)}
              disabled={refreshing}
              title={isRTL ? 'تحديث' : 'Refresh'}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {/* ── Status blocks ── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Watcher liveness */}
            <div className="rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Radio className="h-3.5 w-3.5" />
                  {isRTL ? 'مراقب جيت هب' : 'GitHub Watcher'}
                </span>
                {w.sinceCheckSec === null ? (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                    {isRTL ? 'لا بيانات' : 'no data'}
                  </Badge>
                ) : w.active ? (
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-[10px] px-1.5 py-0">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 me-1 animate-pulse" />
                    {isRTL ? 'نشط' : 'Active'}
                  </Badge>
                ) : (
                  <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] px-1.5 py-0">
                    <XCircle className="h-3 w-3 me-0.5" />
                    {isRTL ? 'غير نشط' : 'Inactive'}
                  </Badge>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground space-y-1">
                <p>
                  {isRTL ? 'آخر فحص:' : 'Last check:'}{' '}
                  <span className="font-medium text-foreground">
                    {formatAgo(w.sinceCheckSec, isRTL)}
                  </span>
                  {w.lastCheckAt ? (
                    <span className="ms-1 opacity-70">({formatDateTime(w.lastCheckAt)})</span>
                  ) : null}
                </p>
                <p className="flex items-center gap-1">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  {w.branch ?? 'master'} @ {shortSha(w.lastCommit)}
                </p>
                {w.sinceCheckSec !== null && !w.active && (
                  <p className="text-red-600 dark:text-red-400 font-medium">
                    {isRTL
                      ? 'لا نبضات لأكثر من 15 دقيقة — راجع systemctl status blasti-watcher.timer'
                      : 'No heartbeat for 15+ minutes — check systemctl status blasti-watcher.timer'}
                  </p>
                )}
              </div>
            </div>

            {/* Last deploy */}
            <div className="rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Rocket className="h-3.5 w-3.5" />
                  {isRTL ? 'آخر نشر للخادم' : 'Last VPS Deploy'}
                </span>
                {d ? (
                  d.status === 'success' ? (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-[10px] px-1.5 py-0">
                      <CheckCircle2 className="h-3 w-3 me-0.5" />
                      {isRTL ? 'نجح' : 'Success'}
                    </Badge>
                  ) : d.status === 'failure' ? (
                    <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] px-1.5 py-0">
                      <XCircle className="h-3 w-3 me-0.5" />
                      {isRTL ? 'فشل' : 'Failed'}
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
                      {isRTL ? 'جارٍ النشر…' : 'Deploying…'}
                    </Badge>
                  )
                ) : (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                    {isRTL ? 'لا بيانات' : 'no data'}
                  </Badge>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground space-y-1">
                {d ? (
                  <>
                    <p>
                      {isRTL ? 'قبل:' : ''}{' '}
                      <span className="font-medium text-foreground">{formatAgo(d.sinceSec, isRTL)}</span>
                      {d.durationSec ? (
                        <span className="ms-1 opacity-70">
                          ({isRTL ? 'استغرق' : 'took'} {formatUptime(d.durationSec, isRTL)})
                        </span>
                      ) : null}
                    </p>
                    <p className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3 shrink-0" />
                      {shortSha(d.commit)}
                      {d.message ? <span className="opacity-70 truncate"> — {d.message}</span> : null}
                    </p>
                  </>
                ) : (
                  <p>
                    {isRTL
                      ? 'لم يُسجّل أي نشر بعد. يُسجَّل تلقائياً بعد أول تحديث من المراقب.'
                      : 'No deploy recorded yet — recorded automatically after the first watcher update.'}
                  </p>
                )}
              </div>
            </div>

            {/* API runtime */}
            <div className="rounded-xl border border-amber-200/60 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5" />
                  {isRTL ? 'خادم الـ API' : 'API Server'}
                </span>
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-[10px] px-1.5 py-0">
                  {isRTL ? 'يعمل' : 'Running'}
                </Badge>
              </div>
              <div className="text-[11px] text-muted-foreground space-y-1">
                <p>
                  {isRTL ? 'الإصدار:' : 'Version:'}{' '}
                  <span className="font-medium text-foreground font-mono">v{data.api.version}</span>
                </p>
                <p>
                  {isRTL ? 'مدة التشغيل:' : 'Uptime:'}{' '}
                  <span className="font-medium text-foreground">
                    {formatUptime(data.api.uptimeSec, isRTL)}
                  </span>
                </p>
                <p className="opacity-70">{formatDateTime(data.api.now)}</p>
              </div>
            </div>
          </div>

          {/* ── Recent events ── */}
          {data.events.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                {isRTL ? 'آخر الأحداث' : 'Recent activity'}
              </p>
              <div className="max-h-32 overflow-y-auto custom-scrollbar space-y-1 pe-1">
                {data.events.slice(0, 8).map((e, i) => (
                  <div
                    key={`${e.at}-${i}`}
                    className="flex items-center gap-2 text-[11px] text-muted-foreground"
                  >
                    {e.kind === 'deploy-result' && e.status === 'failure' ? (
                      <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                    ) : e.kind === 'deploy-result' ? (
                      <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                    ) : e.kind === 'deploy-start' ? (
                      <Rocket className="h-3 w-3 text-amber-500 shrink-0" />
                    ) : (
                      <Radio className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                    )}
                    <span className="w-20 shrink-0 opacity-70">{formatAgo(e.sinceSec ?? null, isRTL)}</span>
                    <span className="font-mono opacity-70">{shortSha(e.commit)}</span>
                    <span className="truncate">{e.message || e.kind}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Hints ── */}
          <div className="rounded-lg bg-muted/50 p-3 space-y-1.5">
            <p className="text-[11px] font-medium flex items-center gap-1.5 text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              {isRTL ? 'أوامر مفيدة (على الـ VPS)' : 'Useful commands (on the VPS)'}
            </p>
            <div className="text-[11px] text-muted-foreground space-y-1">
              <p>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-[10px]">
                  bash scripts/deploy-digitalocean.sh server-watch-status
                </code>{' '}
                — {isRTL ? 'تقرير كامل عن المراقب والنشر' : 'full watcher + deploy report'}
              </p>
              <p>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-[10px]">
                  systemctl status blasti-watcher.timer
                </code>{' '}
                —{' '}
                {isRTL
                  ? 'حالة مؤقّت الفحص كل دقيقتين'
                  : 'state of the 2-minute check timer'}
              </p>
              <p>
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono text-[10px]">
                  bash scripts/deploy-digitalocean.sh server-watch-disable
                </code>{' '}
                — {isRTL ? 'إيقاف النشر التلقائي' : 'turn auto-deploy off'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
