'use client';

/**
 * RootRecoveryBoundary — root-level error boundary for the BOOT PROVIDERS.
 *
 * WHY: layout.tsx's ErrorBoundary only wraps {children} (the page tree).
 * Everything else mounted in the layout — ThemeProvider, AppIntroAnimation,
 * ClientBootHardening, UploadImageRecovery, AppUpdateManager,
 * LockscreenNotificationGate, PlatformProvider, DatabaseProvider, AuthProvider
 * — sits OUTSIDE it. A throw in ANY of those (render or effect) used to
 * escape to Next.js's global-error page: the phone "This page couldn't load"
 * dead end. This boundary catches those BEFORE they reach the root and shows
 * a self-sufficient recovery card instead.
 *
 * SELF-SUFFICIENT BY CONTRACT: the fallback runs OUTSIDE working providers,
 * so it uses NO store hooks, NO i18n hook, NO theme hook — static Arabic +
 * English copy, guarded storage access, and the same three actions as the
 * global-error screen (retry via reload, copy report, reset app data).
 * A broken fallback must never loop — every action is wrapped.
 */

import React from 'react';
import { getAppVersion } from '@/lib/app-version';
import { diagDump } from '@/lib/diag-log';
import { clearNativeWebviewData } from '@/lib/native-diagnostics';
import { reportCaughtError } from '@/lib/error-reporter';

interface State {
  hasError: boolean;
  message: string;
  digest: string;
}

function wipeWebStorage(): void {
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

function RecoveryCard({ message, digest }: { message: string; digest: string }) {
  const [version, setVersion] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    getAppVersion().then((v) => { if (alive) setVersion(v); }).catch(() => { /* keep null */ });
    return () => { alive = false; };
  }, []);

  const copyReport = React.useCallback(async () => {
    const lines = [
      '— BLASTI تقرير خطأ —',
      `الخطأ: ${message || 'غير معروف'}`,
      digest ? `digest: ${digest}` : '',
      `الإصدار: ${version || 'غير معروف'}`,
      '— آخر الأحداث —',
      diagDump('root-recovery'),
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* clipboard blocked — the error stays on screen */ }
  }, [message, digest, version]);

  const resetAppData = React.useCallback(async () => {
    setResetting(true);
    try {
      wipeWebStorage();
      await clearNativeWebviewData().catch(() => undefined);
    } catch { /* ignore */ }
    window.location.reload();
  }, []);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: '#f0fdf4' }}>
      <div style={{ width: '100%', maxWidth: 420, background: '#ffffff', borderRadius: 24, padding: 28, boxShadow: '0 10px 40px rgba(0,0,0,0.08)', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, margin: '0 auto 16px', borderRadius: 20, background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30 }} aria-hidden>
          ⚠️
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#064e3b', margin: '0 0 6px' }}>
          حدث خطأ غير متوقع
        </h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 4px' }}>
          Something went wrong while starting the app. Try again below.
        </p>
        {version ? (
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 12px', fontFamily: 'monospace' }} dir="ltr">v{version}</p>
        ) : null}
        <pre
          style={{
            maxHeight: 110, overflowY: 'auto', textAlign: 'left', direction: 'ltr',
            background: '#0f172a', color: '#6ee7b7', borderRadius: 12, padding: 12,
            fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            margin: '0 0 16px',
          }}
        >
          {message || 'Unknown error'}
        </pre>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            type="button"
            onClick={() => { try { window.location.reload(); } catch { /* ignore */ } }}
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
  );
}

export class RootRecoveryBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '', digest: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || String(error ?? 'unknown'),
      digest: (error as { digest?: string })?.digest || '',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the console + Electron terminal via the global reporter —
    // but NEVER let reporting re-throw inside the recovery path.
    try {
      reportCaughtError(error, 'RootRecoveryBoundary: ' + (info?.componentStack || '').trim().split('\n')[0]);
    } catch { /* reporter must never break recovery */ }
  }

  render() {
    if (this.state.hasError) {
      return <RecoveryCard message={this.state.message} digest={this.state.digest} />;
    }
    return this.props.children;
  }
}
