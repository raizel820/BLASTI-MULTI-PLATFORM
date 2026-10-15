'use client';

/**
 * BLASTI global-error — the ROOT of last resort (App Router contract).
 *
 * WHY: Next.js's built-in global-error page ("This page couldn't load") was
 * what phone users saw — a dead end with a Reload button and zero context.
 * The mobile "this page could not load" report was literally this screen: a
 * root-level render/effect throw OUTSIDE the layout's ErrorBoundary (which
 * only wraps {children}, not the boot providers) replaces the whole document
 * with Next's default page.
 *
 * This file REPLACES that page with the BLASTI recovery screen:
 *   • the REAL error message + digest (no more blind "could not load"),
 *   • the real installed app version (native versionName — tells us WHICH
 *     build produced the report),
 *   • Reload (App Router requires an explicit reset()/reload here),
 *   • Copy report (error + version + diag-log timeline → clipboard / Share),
 *   • Reset app data — the poisoned-state escape hatch (localStorage,
 *     sessionStorage, Cache Storage, the offline IndexedDB and the native
 *     WebView cache/cookies/SW dir) that makes the shell behave like a fresh
 *     install WITHOUT uninstalling.
 *
 * Contract notes:
 *  - global-error MUST render its own <html> and <body> (it replaces them).
 *  - It renders OUTSIDE every provider: NO store hooks, NO useLanguage — the
 *    copy is self-contained Arabic/English (the app's primary audience is
 *    Arabic; English fallback keeps it universal).
 *  - EVERY storage access is guarded: this screen must render even when the
 *    very thing that crashed is the storage layer.
 *  - The reset deliberately does NOT use the native plugin first — keep the
 *    web-level wipe (works everywhere); the native WebView wipe follows when
 *    the bridge is present (best-effort, never blocking).
 */

import { useEffect, useState } from 'react';
import { getAppVersion } from '@/lib/app-version';
import { diagDump } from '@/lib/diag-log';
import { getNativeDiagnostics, clearNativeWebviewData } from '@/lib/native-diagnostics';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

function safeStorageClear(): void {
  try { localStorage.clear(); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      void caches.keys().then((keys) => {
        keys.forEach((k) => { void caches.delete(k).catch(() => { /* ignore */ }); });
      }).catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
  try {
    if (typeof indexedDB !== 'undefined' && indexedDB.deleteDatabase) {
      indexedDB.deleteDatabase('blasti-watermelondb');
    }
  } catch { /* ignore */ }
}

function buildReport(error: Error & { digest?: string }, version: string | null, ua: string): string {
  const lines: string[] = [];
  lines.push('— BLASTI تقرير خطأ —');
  lines.push(`الخطأ: ${error?.message || 'غير معروف'}`);
  if (error?.digest) lines.push(`digest: ${error.digest}`);
  lines.push(`الإصدار: ${version || 'غير معروف'}`);
  if (ua) lines.push(`UA: ${ua}`);
  lines.push('— آخر الأحداث —');
  lines.push(diagDump('global-error'));
  return lines.join('\n');
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const [version, setVersion] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [ua, setUa] = useState('');

  useEffect(() => {
    try { setUa(navigator.userAgent || ''); } catch { /* ignore */ }
    let alive = true;
    getAppVersion().then((v) => { if (alive) setVersion(v); }).catch(() => { /* keep null */ });
    return () => { alive = false; };
  }, []);

  const copyReport = async (): Promise<void> => {
    const report = buildReport(error, version, ua);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(report);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
        return;
      }
      throw new Error('no clipboard');
    } catch {
      // Native Share sheet fallback (Capacitor), silently ignored elsewhere.
      try {
        const share = (window as unknown as {
          Capacitor?: { Plugins?: Record<string, { share?: (o: { title: string; text: string }) => Promise<unknown> }> };
        }).Capacitor?.Plugins?.Share;
        if (share?.share) {
          await share.share({ title: 'BLASTI', text: report });
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        }
      } catch { /* give up silently — the error text is on screen anyway */ }
    }
  };

  const resetAppData = async (): Promise<void> => {
    setResetting(true);
    try {
      safeStorageClear();
      // Best-effort native wipe (WebView cache/cookies/SW dir) — never blocks.
      await getNativeDiagnostics().then(() => clearNativeWebviewData()).catch(() => undefined);
    } catch { /* ignore — reload anyway */ }
    window.location.reload();
  };

  const message = error?.message || 'Unknown error';
  const digest = error?.digest || '';

  return (
    <html lang="ar" dir="rtl">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f0fdf4' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ width: '100%', maxWidth: 420, background: '#ffffff', borderRadius: 24, padding: 28, boxShadow: '0 10px 40px rgba(0,0,0,0.08)', textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, margin: '0 auto 16px', borderRadius: 20, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 }} aria-hidden>
              ⚠️
            </div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#064e3b', margin: '0 0 6px' }}>
              تعذر تحميل هذه الصفحة
            </h1>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 4px' }}>
              This page couldn&apos;t load — a recovery screen replaced the app after an unexpected error.
            </p>
            {version ? (
              <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px', fontFamily: 'monospace' }} dir="ltr">
                v{version}
              </p>
            ) : null}

            <pre
              style={{
                maxHeight: 120, overflowY: 'auto', textAlign: 'left', direction: 'ltr',
                background: '#0f172a', color: '#6ee7b7', borderRadius: 12, padding: 12,
                fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                margin: '0 0 16px',
              }}
            >
              {message}
              {digest ? `\n[digest ${digest}]` : ''}
            </pre>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                type="button"
                onClick={() => reset()}
                style={{ minHeight: 48, borderRadius: 14, border: 'none', background: 'linear-gradient(to left, #059669, #0d9488)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}
              >
                إعادة المحاولة — Retry
              </button>
              <button
                type="button"
                onClick={() => { void copyReport(); }}
                style={{ minHeight: 44, borderRadius: 14, border: '1px solid #d1fae5', background: '#ffffff', color: '#047857', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
              >
                {copied ? 'تم نسخ التقرير ✓' : 'نسخ تقرير الخطأ — Copy report'}
              </button>
              <button
                type="button"
                onClick={() => { void resetAppData(); }}
                disabled={resetting}
                style={{ minHeight: 44, borderRadius: 14, border: 'none', background: '#ffffff', color: '#b91c1c', fontWeight: 600, fontSize: 13, cursor: resetting ? 'wait' : 'pointer', opacity: resetting ? 0.6 : 1 }}
              >
                {resetting ? 'جارٍ المسح…' : 'مسح بيانات التطبيق وإعادة التشغيل'}
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
