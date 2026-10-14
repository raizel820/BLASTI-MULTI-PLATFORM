/**
 * BLASTI native shell diagnostics + recovery — "this page could not load" fix.
 *
 * Talks to BlastiNativeStatus.getDiagnostics / clearWebviewData through the
 * shared bridge probe (lib/native-plugin.ts — the ONLY reliable Capacitor 8
 * surface). ZERO @capacitor imports: apps/web does not depend on @capacitor/*.
 *
 * WHY: when the phone shows a broken page ("this page could not load") there
 * was NO way to see the real installed version, the WebView engine, or to
 * reset the shell's poisoned state without uninstalling. These helpers power
 * the in-app diagnostics sheet (components/shared/mobile-diagnostics-sheet.tsx)
 * and the error-boundary recovery actions:
 *   - getNativeDiagnostics() → { versionName, versionCode, androidSdk,
 *     deviceModel, userAgent, pendingUpdateApk, … } — every field optional.
 *   - clearNativeWebviewData() → wipes the WebView's HTTP cache,
 *     localStorage/IndexedDB/WebSQL, cookies, SW registrations and the
 *     pending update APK — the "reset app data" escape hatch.
 *
 * Both are SSR-safe and NEVER reject (null / false on any failure).
 */

import { getNativePlugin, type NativePlugin } from './native-plugin';

/** Shape returned by BlastiNativeStatus.getDiagnostics (all fields optional). */
export interface NativeDiagnostics {
  versionName?: string;
  versionCode?: number;
  packageName?: string;
  androidSdk?: number;
  deviceModel?: string;
  manufacturer?: string;
  userAgent?: string;
  pendingUpdateApk?: boolean;
  pendingUpdateApkBytes?: number;
}

function statusPlugin(): NativePlugin | null {
  return getNativePlugin('BlastiNativeStatus');
}

/** True inside a Capacitor shell (the diagnostics UI is native-only). */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!(window as unknown as { Capacitor?: unknown }).Capacitor;
  } catch {
    return false;
  }
}

/**
 * One-shot shell diagnostics read. Never throws; resolves {} outside a
 * native shell or when the plugin call fails.
 */
export async function getNativeDiagnostics(): Promise<NativeDiagnostics> {
  try {
    const get = statusPlugin()?.getDiagnostics as
      | (() => Promise<NativeDiagnostics>)
      | undefined;
    const res = await get?.();
    return res && typeof res === 'object' ? res : {};
  } catch {
    return {};
  }
}

/**
 * Reset the shell's WebView storage (cache + storage + cookies + SW dir +
 * the pending update APK). Resolves false outside a native shell / on
 * failure — the caller then falls back to the web-level reset.
 */
export async function clearNativeWebviewData(): Promise<boolean> {
  try {
    const clear = statusPlugin()?.clearWebviewData as
      | (() => Promise<{ ok?: boolean }>)
      | undefined;
    const res = await clear?.();
    return !!res?.ok;
  } catch {
    return false;
  }
}

/**
 * Build a shareable multi-line diagnostic report (clipboard / Share sheet):
 * shell info + resolved server + the diag-log ring buffer tail. Plain text,
 * Arabic-labelled, safe to paste into a chat.
 */
export function buildDiagnosticsReport(input: {
  native: NativeDiagnostics;
  serverUrl: string | null;
  serverSource: string;
  serverStatus: string;
  discoveryLocked: boolean;
  apiHealth: string;
  diagTail: string;
  errorLine?: string | null;
  route?: string;
}): string {
  const lines: string[] = [];
  const n = input.native || {};
  lines.push('— BLASTI تقرير التشخيص —');
  if (input.errorLine) lines.push(`الخطأ: ${input.errorLine}`);
  lines.push(`إصدار التطبيق: ${n.versionName || 'غير معروف'} (code ${n.versionCode ?? '?'})`);
  if (n.deviceModel) lines.push(`الجهاز: ${n.manufacturer || ''} ${n.deviceModel}`.trim());
  if (typeof n.androidSdk === 'number') lines.push(`Android SDK: ${n.androidSdk}`);
  if (n.userAgent) {
    const m = /Chrome\/([\d.]+)/.exec(n.userAgent);
    lines.push(`WebView: ${m ? `Chrome/${m[1]}` : n.userAgent.slice(0, 120)}`);
  }
  if (n.pendingUpdateApk) lines.push('تحديث مُنزَّل بانتظار التثبيت: نعم');
  lines.push(`السيرفر: ${input.serverUrl || 'غير محدد'} (${input.serverSource}, ${input.serverStatus})`);
  lines.push(`قفل الاكتشاف: ${input.discoveryLocked ? 'مُقفل (نسخة الإنتاج)' : 'حُر'}`);
  lines.push(`صحة الـAPI: ${input.apiHealth}`);
  if (input.route) lines.push(`الصفحة: ${input.route}`);
  if (input.diagTail) lines.push('— آخر الأحداث —', input.diagTail);
  return lines.join('\n');
}
