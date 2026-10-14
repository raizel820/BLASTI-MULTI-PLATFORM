'use client';

/**
 * MobileDiagnosticsSheet — on-device recovery for "this page could not load".
 *
 * WHY: a phone that shows a broken page had NO way to answer the three
 * questions every fix depends on — WHICH build is installed, WHICH server the
 * app resolved, and WHAT the last boot actually did. Uninstall/reinstall was
 * the only escape, and it destroys the evidence. This sheet surfaces all of
 * it inside the shell:
 *
 *   • Shell  — the REAL installed versionName/versionCode (native
 *     PackageManager, the same values the update system uses), device model,
 *     Android SDK, WebView engine (from the live UA) and whether a downloaded
 *     update APK is still sitting on disk.
 *   • Server — the resolver's state (locked-baked URL on production builds,
 *     scanned/last-good/manual otherwise) + a LIVE /api/health probe with
 *     timing.
 *   • Events — the diag-log ring-buffer tail (boot gate, sync, network
 *     errors, chunk errors).
 *
 * Actions: reload, copy/share the report (clipboard → Capacitor Share →
 * fallback), and "reset app data" — native WebStorage/cache/cookie wipe plus
 * the web-level localStorage/caches/IndexedDB clear — the poisoned-state
 * killer that makes the phone behave like a fresh install without losing the
 * installed APK.
 *
 * Native shells only: renders null on web/Electron. Entry points: the login
 * screen footer + customer settings About (diagnostics buttons).
 */

import { useCallback, useEffect, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { toast } from 'sonner';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import {
  Activity, RefreshCw, Server, Share2, Smartphone, Trash2, Wifi, WifiOff,
} from 'lucide-react';
import {
  buildDiagnosticsReport,
  clearNativeWebviewData,
  getNativeDiagnostics,
  isNativeShell,
  type NativeDiagnostics,
} from '@/lib/native-diagnostics';
import {
  getNativeCloudState,
  onNativeCloudStateChange,
  SERVER_DISCOVERY_LOCKED,
} from '@/lib/native-cloud-resolver';
import { buildCloudUrl } from '@/lib/api-client';
import { diagEvents } from '@/lib/diag-log';
import { getAppVersion } from '@/lib/app-version';

const DIAG_TAIL_LIMIT = 24;

/** Human size for the pending-update row. */
function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional first line of the report (e.g. the error that opened the sheet). */
  errorLine?: string | null;
}

export function MobileDiagnosticsSheet({ open, onOpenChange, errorLine }: Props) {
  const { t } = useLanguage();
  const [native, setNative] = useState<NativeDiagnostics>({});
  const [fallbackVersion, setFallbackVersion] = useState<string | null>(null);
  const [health, setHealth] = useState<{ state: 'probing' | 'ok' | 'fail'; detail: string }>({ state: 'probing', detail: '' });
  const [cloudState, setCloudState] = useState(() => getNativeCloudState());
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const isNative = isNativeShell();

  // ── Data collection on open ──────────────────────────────────────────────
  useEffect(() => {
    if (!open || !isNative) return;
    let alive = true;
    void getNativeDiagnostics().then((d) => { if (alive) setNative(d || {}); });
    void getAppVersion().then((v) => { if (alive) setFallbackVersion(v); });
    setCloudState(getNativeCloudState());
    const off = onNativeCloudStateChange((s) => { if (alive) setCloudState({ ...s }); });

    // Live API health probe — 6s cap; the sheet must never hang.
    setHealth({ state: 'probing', detail: '' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const started = Date.now();
    void (async () => {
      try {
        const res = await fetch(buildCloudUrl('/api/health'), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        const ms = Date.now() - started;
        if (!alive) return;
        if (res.ok) setHealth({ state: 'ok', detail: `HTTP ${res.status} · ${ms}ms` });
        else setHealth({ state: 'fail', detail: `HTTP ${res.status} · ${ms}ms` });
      } catch (err) {
        if (!alive) return;
        const msg = err instanceof Error ? err.message : String(err);
        setHealth({ state: 'fail', detail: msg.slice(0, 80) || 'network error' });
      } finally {
        clearTimeout(timer);
      }
    })();

    return () => { alive = false; off(); controller.abort(); clearTimeout(timer); };
  }, [open, isNative]);

  // ── Report builder ───────────────────────────────────────────────────────
  const buildReport = useCallback((): string => {
    const tail = diagEvents()
      .slice(-DIAG_TAIL_LIMIT)
      .map((e) => `${e.t} ${e.ev} ${JSON.stringify(e.d ?? {})}`)
      .join('\n');
    return buildDiagnosticsReport({
      native,
      serverUrl: cloudState.url,
      serverSource: cloudState.source,
      serverStatus: cloudState.status,
      discoveryLocked: SERVER_DISCOVERY_LOCKED,
      apiHealth: health.state === 'ok'
        ? `سليم (${health.detail})`
        : health.state === 'fail'
          ? `فاشل (${health.detail})`
          : 'جاري الفحص…',
      diagTail: tail,
      errorLine: errorLine || null,
      route: typeof window !== 'undefined' ? (window.location.hash || '#/') : undefined,
    });
  }, [native, cloudState, health, errorLine]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const copyReport = useCallback(async () => {
    const report = buildReport();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        toast.success(t('diagCopied'));
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      // Clipboard blocked — offer the native Share sheet (Capacitor), else toast the failure.
      try {
        const share = (window as unknown as {
          Capacitor?: { Plugins?: Record<string, { share?: (o: { title: string; text: string; dialogTitle?: string }) => Promise<unknown> }> };
        }).Capacitor?.Plugins?.Share;
        if (share?.share) {
          await share.share({ title: 'BLASTI', text: report, dialogTitle: t('diagCopyReport') });
          return;
        }
      } catch { /* share unavailable — fall through */ }
      toast.error(t('diagCopyFailed'));
    }
  }, [buildReport, t]);

  const performReset = useCallback(async () => {
    setResetting(true);
    try {
      // 1. Web-level best-effort wipe (works even if the native call fails).
      try {
        localStorage.clear();
        sessionStorage.clear();
        if (typeof caches !== 'undefined') {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
        }
        if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) {
          indexedDB.deleteDatabase('blasti-watermelondb');
        }
      } catch { /* hardened reset — keep going */ }
      // 2. Native shell wipe (WebView cache + storage + cookies + SW dir +
      //    pending update APK) — the real fix when the web layer is the
      //    poisoned part.
      await clearNativeWebviewData();
      // 3. Fresh boot.
      window.location.reload();
    } finally {
      setResetting(false);
    }
  }, []);

  if (!isNative) return null;

  const version = native.versionName || fallbackVersion || t('diagVersionUnknown');
  const serverFound = cloudState.status === 'found' && !!cloudState.url;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-3xl p-0">
          <SheetHeader className="px-5 pt-5 pb-3">
            <SheetTitle className="flex items-center gap-2 text-base">
              <Activity className="h-4 w-4 text-emerald-600" aria-hidden />
              {t('diagTitle')}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {t('diagSubtitle')}
            </SheetDescription>
          </SheetHeader>

          <div className="px-5 pb-6 space-y-4">
            {/* Shell */}
            <section className="rounded-2xl border bg-muted/30 p-4 space-y-2" aria-label={t('diagShellSection')}>
              <h3 className="flex items-center gap-2 text-sm font-bold">
                <Smartphone className="h-4 w-4 text-emerald-600" aria-hidden />
                {t('diagShellSection')}
              </h3>
              <dl className="text-xs space-y-1.5 text-muted-foreground" dir="rtl">
                <div className="flex justify-between gap-3">
                  <dt>{t('diagAppVersion')}</dt>
                  <dd className="font-mono text-foreground" dir="ltr">{version}</dd>
                </div>
                {typeof native.versionCode === 'number' && native.versionCode >= 0 && (
                  <div className="flex justify-between gap-3">
                    <dt>{t('diagVersionCode')}</dt>
                    <dd className="font-mono text-foreground" dir="ltr">{native.versionCode}</dd>
                  </div>
                )}
                {(native.deviceModel || native.manufacturer) && (
                  <div className="flex justify-between gap-3">
                    <dt>{t('diagDevice')}</dt>
                    <dd className="font-mono text-foreground" dir="ltr">
                      {[native.manufacturer, native.deviceModel].filter(Boolean).join(' ')}
                    </dd>
                  </div>
                )}
                {typeof native.androidSdk === 'number' && (
                  <div className="flex justify-between gap-3">
                    <dt>Android</dt>
                    <dd className="font-mono text-foreground" dir="ltr">SDK {native.androidSdk}</dd>
                  </div>
                )}
                {native.userAgent && (
                  <div className="flex justify-between gap-3">
                    <dt>{t('diagWebview')}</dt>
                    <dd className="font-mono text-foreground" dir="ltr">
                      {((/Chrome\/([\d.]+)/.exec(native.userAgent)?.[1]) && `Chrome ${/Chrome\/([\d.]+)/.exec(native.userAgent)![1]}`) || '—'}
                    </dd>
                  </div>
                )}
                {native.pendingUpdateApk && (
                  <div className="flex justify-between gap-3 text-amber-600 dark:text-amber-400">
                    <dt>{t('diagPendingUpdate')}</dt>
                    <dd className="font-mono" dir="ltr">{formatBytes(native.pendingUpdateApkBytes)}</dd>
                  </div>
                )}
              </dl>
            </section>

            {/* Server */}
            <section className="rounded-2xl border bg-muted/30 p-4 space-y-2" aria-label={t('diagServerSection')}>
              <h3 className="flex items-center gap-2 text-sm font-bold">
                <Server className="h-4 w-4 text-emerald-600" aria-hidden />
                {t('diagServerSection')}
              </h3>
              <dl className="text-xs space-y-1.5 text-muted-foreground" dir="rtl">
                <div className="flex justify-between gap-3">
                  <dt>{t('diagServerUrl')}</dt>
                  <dd className="font-mono text-foreground break-all text-end" dir="ltr">
                    {cloudState.url || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('diagServerSource')}</dt>
                  <dd className="font-mono text-foreground" dir="ltr">
                    {SERVER_DISCOVERY_LOCKED ? 'locked' : cloudState.source}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>{t('diagApiHealth')}</dt>
                  <dd className="flex items-center gap-1.5">
                    {health.state === 'ok' && <Wifi className="h-3.5 w-3.5 text-emerald-600" aria-hidden />}
                    {health.state === 'fail' && <WifiOff className="h-3.5 w-3.5 text-rose-500" aria-hidden />}
                    <span className={health.state === 'ok' ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : health.state === 'fail' ? 'text-rose-600 dark:text-rose-400 font-semibold' : ''} dir="ltr">
                      {serverFound && health.state === 'probing' ? t('diagProbing') : health.detail || t('diagProbing')}
                    </span>
                  </dd>
                </div>
              </dl>
            </section>

            {/* Events */}
            <section className="rounded-2xl border bg-muted/30 p-4 space-y-2" aria-label={t('diagEventsSection')}>
              <h3 className="text-sm font-bold">{t('diagEventsSection')}</h3>
              <pre className="max-h-48 overflow-y-auto rounded-xl bg-black/90 p-3 font-mono text-[10px] leading-relaxed text-emerald-300 whitespace-pre-wrap break-all" dir="ltr">
                {diagEvents().slice(-DIAG_TAIL_LIMIT).map((e) => (
                  `${e.t} +${e.ms}ms ${e.ev}\n`
                )).join('') || t('diagNoEvents')}
              </pre>
            </section>

            {/* Actions */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
                className="min-h-[44px] rounded-2xl font-semibold gap-2"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t('diagReload')}
              </Button>
              <Button
                onClick={copyReport}
                className="min-h-[44px] rounded-2xl font-semibold gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white"
              >
                <Share2 className="h-4 w-4" aria-hidden />
                {t('diagCopyReport')}
              </Button>
            </div>
            <Button
              variant="ghost"
              onClick={() => setResetOpen(true)}
              className="w-full min-h-[44px] rounded-2xl text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 font-semibold gap-2"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('diagResetData')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t('diagResetTitle')}
        description={t('diagResetDescription')}
        confirmLabel={t('diagResetConfirm')}
        cancelLabel={t('cancel')}
        variant="danger"
        loading={resetting}
        onConfirm={performReset}
      />
    </>
  );
}
