'use client';
import { apiFetch } from '@/lib/api-fetch';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
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
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Activity,
  Server,
  GitBranch,
  GitPullRequest,
  Rocket,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Clock,
  Terminal,
} from 'lucide-react';

// ─── Types ─────────────────────────────────────────────────────────

interface VpsRepo {
  dir?: string;
  branch?: string;
  sha?: string;
  short?: string;
  subject?: string;
  commitTime?: string;
  dirtyFiles?: number;
  remoteUrl?: string;
  slug?: string | null;
  error?: string;
}

interface VpsData {
  vps: {
    hostname: string;
    platform: string;
    osRelease: string;
    cpu: { model: string; cores: number; usagePct: number | null; loadAvg: number[] };
    memory: { totalMb: number; usedMb: number; availableMb: number; usagePct: number };
    disk: { totalGb: number; freeGb: number; usedGb: number; usagePct: number } | null;
    uptimeSec: number;
    processUptimeSec: number;
    runtime: string;
    apiVersion: string;
    nodeEnv: string | null;
    repo: VpsRepo | null;
    now: string;
  };
}

interface NewCommit {
  sha: string;
  short: string;
  subject: string;
  date: string;
}

interface CheckResult {
  repo: { url: string; slug: string | null; branch: string };
  local: { sha: string; short: string; subject: string; commitTime: string };
  remote: { sha: string; short: string };
  upToDate: boolean;
  behind: number;
  ahead: number;
  newCommits: NewCommit[];
  checkedAt: string;
}

// ─── Formatting helpers ────────────────────────────────────────────

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

export function AdminVpsStatus() {
  const { lang } = useLanguage();
  const isRTL = lang === 'ar';

  // ── Poll state ──
  const [data, setData] = useState<VpsData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── GitHub check state ──
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  // ── Rebuild state ──
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const fetchStatus = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await apiFetch('/api/system/vps-status');
      if (res.ok) {
        const json = await res.json();
        if (json?.success) {
          setData(json as VpsData);
          setLoadState('ready');
          return;
        }
      }
      setLoadState((s) => (s !== 'ready' ? 'unavailable' : s));
    } catch {
      setLoadState((s) => (s !== 'ready' ? 'unavailable' : s));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollTimer.current = setInterval(() => fetchStatus(true), 15_000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [fetchStatus]);

  // ── Manual GitHub check (fetches the remote — button only) ──
  const runGithubCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await apiFetch('/api/system/github-check');
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success) {
        setCheck(json.check as CheckResult);
      } else {
        setCheck(null);
        setCheckError(json?.error || `HTTP ${res.status}`);
      }
    } catch {
      setCheck(null);
      setCheckError(isRTL ? 'فشل الاتصال بالخادم' : 'Connection to the server failed');
    } finally {
      setChecking(false);
    }
  }, [isRTL]);

  // ── Manual rebuild (same pipeline as the watcher) ──
  const runRebuild = useCallback(async () => {
    setRebuildConfirmOpen(false);
    setRebuilding(true);
    try {
      const force = check ? check.upToDate : false;
      const res = await apiFetch('/api/system/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.success) {
        toast.success(
          isRTL
            ? 'بدأت إعادة البناء — سيتم سحب آخر إصدار وإعادة تشغيل الخدمات. تابع التقدم في نشاط النشر التلقائي.'
            : 'Rebuild started — the pipeline pulls the latest commit and restarts the services. Track progress in the Auto-Deploy activity.'
        );
        // the served commit changes once the deploy finishes
        setTimeout(() => fetchStatus(true), 60_000);
        setTimeout(() => setRebuilding(false), 180_000);
      } else {
        toast.error(json?.error || (isRTL ? 'فشل بدء إعادة البناء' : 'Failed to start the rebuild'));
        setRebuilding(false);
      }
    } catch {
      toast.error(isRTL ? 'خطأ في الاتصال' : 'Connection error');
      setRebuilding(false);
    }
  }, [check, isRTL, fetchStatus]);

  // ─── Loading / unavailable states ───
  if (loadState === 'loading') {
    return <Skeleton className="h-64 w-full rounded-2xl" />;
  }

  if (loadState === 'unavailable' || !data) {
    return (
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 rounded-xl">
        <CardContent className="p-4 flex items-center gap-3 text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="text-xs">
            {isRTL
              ? 'حالة الخادم (VPS) غير متاحة — يلزم تحديث blasti-api إلى أحدث إصدار.'
              : 'VPS status is not available — blasti-api needs an update to the latest version.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  const v = data.vps;
  const repo = v.repo;

  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}>
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 rounded-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-teal-300 dark:from-emerald-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
                <Server className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
              </div>
              {isRTL ? 'خادم الاستضافة (VPS)' : 'VPS Server'}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] px-2 py-0 text-muted-foreground hidden sm:flex">
                {v.hostname}
              </Badge>
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
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          {/* ── Resource tiles ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* CPU */}
            <div className="rounded-xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Cpu className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {isRTL ? 'المعالج' : 'CPU'}
                </span>
                <span className="text-xs font-semibold font-mono">
                  {v.cpu.usagePct !== null ? `${v.cpu.usagePct}%` : '—'}
                </span>
              </div>
              <Progress value={v.cpu.usagePct ?? 0} className="h-1.5" />
              <p className="text-[10px] text-muted-foreground truncate" title={v.cpu.model}>
                {v.cpu.cores} {isRTL ? 'نواة' : 'cores'}
                {v.cpu.loadAvg?.[0] !== undefined ? ` · load ${v.cpu.loadAvg[0]}` : ''}
              </p>
            </div>
            {/* RAM */}
            <div className="rounded-xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <MemoryStick className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {isRTL ? 'الذاكرة' : 'RAM'}
                </span>
                <span className="text-xs font-semibold font-mono">{v.memory.usagePct}%</span>
              </div>
              <Progress value={v.memory.usagePct} className="h-1.5" />
              <p className="text-[10px] text-muted-foreground">
                {v.memory.usedMb} / {v.memory.totalMb} MB
              </p>
            </div>
            {/* Storage */}
            <div className="rounded-xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <HardDrive className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {isRTL ? 'التخزين' : 'Storage'}
                </span>
                <span className="text-xs font-semibold font-mono">
                  {v.disk ? `${v.disk.usagePct}%` : '—'}
                </span>
              </div>
              <Progress value={v.disk?.usagePct ?? 0} className="h-1.5" />
              <p className="text-[10px] text-muted-foreground">
                {v.disk ? `${v.disk.usedGb} / ${v.disk.totalGb} GB` : isRTL ? 'غير متاح' : 'unavailable'}
              </p>
            </div>
            {/* Uptime */}
            <div className="rounded-xl border border-emerald-200/60 dark:border-emerald-800/40 bg-emerald-50/40 dark:bg-emerald-900/10 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {isRTL ? 'مدة التشغيل' : 'Uptime'}
                </span>
              </div>
              <p className="text-sm font-semibold">{formatUptime(v.uptimeSec, isRTL)}</p>
              <p className="text-[10px] text-muted-foreground">
                {isRTL ? 'الـ API:' : 'API:'} {formatUptime(v.processUptimeSec, isRTL)}
              </p>
            </div>
          </div>

          {/* ── Currently served build ── */}
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <GitBranch className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                {isRTL ? 'الإصدار المشغّل حالياً (git)' : 'Currently served build (git)'}
              </span>
              {repo?.dirtyFiles ? (
                <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 text-[10px] px-1.5 py-0">
                  {isRTL ? `${repo.dirtyFiles} ملف غير مُرحّل` : `${repo.dirtyFiles} uncommitted`}
                </Badge>
              ) : (
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 text-[10px] px-1.5 py-0">
                  {isRTL ? 'نظيف' : 'clean'}
                </Badge>
              )}
            </div>
            {repo?.sha ? (
              <div className="text-[11px] text-muted-foreground space-y-1">
                <p className="flex items-center gap-1 flex-wrap">
                  <span className="font-mono font-semibold text-foreground">
                    {repo.branch} @ {repo.short}
                  </span>
                  <span className="opacity-70">· {formatDateTime(repo.commitTime)}</span>
                </p>
                <p className="truncate" title={repo.subject}>
                  {repo.subject}
                </p>
                <p className="opacity-70 truncate">
                  {repo.slug ?? repo.remoteUrl} · {v.platform} · {v.runtime} · API v{v.apiVersion}
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {repo?.error ??
                  (isRTL ? 'لا توجد معلومات git على هذا الخادم' : 'No git information on this server')}
              </p>
            )}
          </div>

          {/* ── Actions: manual GitHub check + rebuild ── */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                onClick={runGithubCheck}
                disabled={checking}
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5 me-1.5" />
                )}
                {isRTL ? 'فحص GitHub يدوياً' : 'Check GitHub now'}
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-sm"
                onClick={() => setRebuildConfirmOpen(true)}
                disabled={rebuilding}
              >
                {rebuilding ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin me-1.5" />
                ) : (
                  <Rocket className="h-3.5 w-3.5 me-1.5" />
                )}
                {rebuilding
                  ? isRTL
                    ? 'إعادة البناء جارية…'
                    : 'Rebuilding…'
                  : isRTL
                    ? 'إعادة بناء من إصدار جديد'
                    : 'Rebuild from new commit'}
              </Button>
              {check && (
                <span className="text-[10px] text-muted-foreground">
                  {isRTL ? 'فُحص:' : 'checked:'} {formatDateTime(check.checkedAt)}
                </span>
              )}
            </div>

            {/* Check error */}
            {checkError && (
              <div className="rounded-lg border border-red-200/70 dark:border-red-800/40 bg-red-50/60 dark:bg-red-900/10 p-3 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-red-700 dark:text-red-400 break-words">{checkError}</p>
              </div>
            )}

            {/* Check result */}
            {check && (
              <div
                className={`rounded-xl border p-3 space-y-2 ${
                  check.upToDate
                    ? 'border-green-200/60 dark:border-green-800/40 bg-green-50/50 dark:bg-green-900/10'
                    : 'border-amber-200/60 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10'
                }`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-medium flex items-center gap-1.5">
                    {check.upToDate ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                    )}
                    {check.upToDate
                      ? isRTL
                        ? 'الخادم محدَّث — نفس إصدار GitHub'
                        : 'Server is up to date — same commit as GitHub'
                      : isRTL
                        ? `يوجد ${check.behind} إصدار جديد على GitHub — اضغط "إعادة بناء" للتحديث`
                        : `${check.behind} new commit(s) on GitHub — press "Rebuild" to deploy`}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {check.repo.slug ?? ''} · {check.repo.branch} @ {check.remote.short}
                  </span>
                </div>
                {check.newCommits.length > 0 && (
                  <div className="max-h-36 overflow-y-auto custom-scrollbar space-y-1 pe-1">
                    {check.newCommits.map((nc) => (
                      <div key={nc.sha} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Activity className="h-3 w-3 shrink-0 text-amber-500" />
                        <span className="font-mono shrink-0">{nc.short}</span>
                        <span className="truncate">{nc.subject}</span>
                        <span className="shrink-0 opacity-60">{formatDateTime(nc.date)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {check.ahead > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {isRTL
                      ? `ملاحظة: هذا الخادم يتقدّم بـ ${check.ahead} إصدار لم يُرفع بعد`
                      : `Note: this server is ${check.ahead} commit(s) ahead of GitHub (not pushed yet)`}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ── Hint ── */}
          <div className="rounded-lg bg-muted/50 p-3 flex items-start gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground">
              {isRTL
                ? '"إعادة البناء" تشغّل نفس مسار المراقب التلقائي (سحب الإصدار الجديد + إعادة البناء + إعادة تشغيل الخدمات) مع قفل تحديث مشترك حتى لا يتعارض مع أي تحديث جارٍ.'
                : '"Rebuild" runs the same pipeline as the auto-watcher (pull new commit + rebuild + restart services) and holds the shared update lock, so it never races a running update.'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Rebuild confirm ── */}
      <AlertDialog open={rebuildConfirmOpen} onOpenChange={setRebuildConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isRTL ? 'بدء إعادة البناء الآن؟' : 'Start the rebuild now?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isRTL
                ? 'سيتم سحب أحدث إصدار من GitHub وإعادة بناء وإعادة تشغيل blasti-api و blasti-web (انقطاع ثوانٍ قليلة). إذا لم تُضف إصدارات جديدة سيتم فرض إعادة البناء الحالي.'
                : 'The pipeline will pull the latest commit from GitHub, rebuild and restart blasti-api + blasti-web (a few seconds of downtime). If there are no new commits the current build is rebuilt anyway (forced).'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isRTL ? 'إلغاء' : 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={runRebuild}
            >
              <Rocket className="h-4 w-4 me-1" />
              {isRTL ? 'إعادة البناء' : 'Rebuild'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
