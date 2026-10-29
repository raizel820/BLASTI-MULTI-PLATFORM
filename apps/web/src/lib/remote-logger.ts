'use client';

/**
 * BLASTI Remote Account Logger (logs-1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Fully-detailed client log support for EVERY app surface (web console,
 * Capacitor mobile, Electron desktop — all share this module):
 *
 *   • Captures console.log/info/warn/error, window 'error',
 *     'unhandledrejection' (via the global error reporter's console output),
 *     route changes, auth events, and explicit logEvent() calls from features.
 *   • Buffers entries in memory + persists them to localStorage so a crash or
 *     app kill never loses the trail.
 *   • AUTO-UPLOADS batches to the VPS log vault (POST /api/logs) every
 *     FLUSH_INTERVAL while authenticated — the API files each batch under the
 *     account's UID folder (logs/<UID>/<date>.ndjson).
 *   • MANUAL UPLOAD: flushLogsNow({ manual: true }) — wired to the "upload
 *     logs now" buttons in the profile/settings pages; also writes a
 *     standalone manual-<ts>.ndjson snapshot on the server "just in case the
 *     log is not updating in realtime".
 *
 * Design constraints:
 *   - NEVER throw, never block the UI thread, never recurse (the logger's own
 *     console writes are routed around the interceptor).
 *   - No auth token handling here — apiFetch injects it; uploads simply no-op
 *     until the user is logged in (buffer keeps growing, capped).
 *   - Desktop: the main process keeps its own ring buffer (main.js) which the
 *     preload bridge exposes as electronAPI.getRecentMainLogs(); we merge the
 *     most recent main-process lines into every desktop flush so Electron-only
 *     crashes (installer, local API, updater) reach the same vault.
 */

import { apiFetch } from './api-fetch';
import { buildCloudUrl } from './api-client';
import { detectPlatform } from './platform';

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  message: string;
  data?: unknown;
}

const FLUSH_INTERVAL_MS = 30_000;         // auto-upload cadence while logged in
const MAX_BUFFER = 600;                   // in-memory cap (oldest dropped)
const MAX_PERSISTED = 900;                // localStorage cap across restarts
const STORE_KEY = 'blasti-remote-log-buffer';
const LAST_FLUSH_KEY = 'blasti-remote-log-lastflush';
const MIN_FLUSH_GAP_MS = 8_000;           // manual-button debounce

let buffer: LogEntry[] = [];
let installed = false;
let flushing = false;

// 0.6.16 field-fix — a 404 from POST /api/logs means the SERVER is too old
// (the vault route only exists since 0.6.15; the VPS was still pre-0.6.15).
// The old behavior treated that 404 like a poisoned payload and DROPPED half
// the buffer every 30s cycle — destroying the very trail the system exists
// to keep, while burning battery/radio on a deterministic failure.
// NEW: a 404 keeps EVERY entry and pauses AUTO-flush for 15 minutes (manual
// "upload logs now" always still attempts, so the button reports the truth).
const STALE_SERVER_404_COOLDOWN_MS = 15 * 60_000;
let staleServer404Until = 0;
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let uidCache: string | null | undefined; // undefined = not yet known
let lastPersistAt = 0;

// ─── Persistence ─────────────────────────────────────────────────────────────

function persist(): void {
  try {
    if (buffer.length > MAX_PERSISTED) buffer = buffer.slice(-MAX_PERSISTED);
    localStorage.setItem(STORE_KEY, JSON.stringify(buffer.slice(-MAX_PERSISTED)));
  } catch { /* quota/private mode — memory buffer still works */ }
}

function restore(): void {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as LogEntry[];
    if (Array.isArray(parsed)) buffer = parsed.filter((e) => e && typeof e.ts === 'string').slice(-MAX_PERSISTED);
  } catch { /* corrupted buffer — start fresh */ }
}

// ─── Entry intake ────────────────────────────────────────────────────────────

function pushEntry(level: LogEntry['level'], tag: string, message: string, data?: unknown): void {
  if (buffer.length >= MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER + 1);
  buffer.push({ ts: new Date().toISOString(), level, tag, message, data });
  // Cheap persistence throttle — at most once per 5s.
  if (Date.now() - lastPersistAt > 5_000) {
    lastPersistAt = Date.now();
    persist();
  }
}

/** Public API for features: logEvent('queue', 'claim failed', { id }). */
export function logEvent(tag: string, message: string, data?: unknown): void {
  pushEntry('info', tag, message, data);
}
export function logWarn(tag: string, message: string, data?: unknown): void {
  pushEntry('warn', tag, message, data);
}
export function logError(tag: string, message: string, data?: unknown): void {
  pushEntry('error', tag, message, data);
}

// ─── Console interception ────────────────────────────────────────────────────

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ')
    .slice(0, 2_000);
}

function installConsoleHook(): void {
  if (installed) return;
  installed = true;
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  // Noise floor: the app logs a LOT of per-poll chatter; keep the vault
  // signal-rich by capturing warn/error fully but sampling debug/info.
  console.log = (...args: unknown[]) => {
    const msg = fmt(args);
    if (!msg.startsWith('[RendererError]')) pushEntry('debug', 'console', msg);
    orig.log(...args);
  };
  console.info = (...args: unknown[]) => {
    pushEntry('info', 'console', fmt(args));
    orig.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    pushEntry('warn', 'console', fmt(args));
    orig.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    pushEntry('error', 'console', fmt(args));
    orig.error(...args);
  };
  window.addEventListener('error', (e) => {
    pushEntry('error', 'window-error', e.message || 'unknown', { source: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    pushEntry('error', 'unhandled-rejection', (r && (r as Error).message) || String(r), {
      stack: r && (r as Error).stack ? String((r as Error).stack).slice(0, 2_000) : undefined,
    });
  });
}

// ─── Desktop main-process log merge (Electron only) ──────────────────────────

async function mergeDesktopMainLogs(): Promise<void> {
  try {
    const w = window as unknown as { electronAPI?: { getRecentMainLogs?: () => unknown[] } };
    const lines = w.electronAPI?.getRecentMainLogs?.();
    if (!Array.isArray(lines) || lines.length === 0) return;
    const lastMerged = buffer.findLastIndex?.((e) => e.tag === 'electron-main') ?? -1;
    const already = lastMerged >= 0 ? new Set(buffer.slice(lastMerged).map((e) => e.message)) : new Set<string>();
    for (const line of lines.slice(-120)) {
      const msg = typeof line === 'string' ? line : String((line as { line?: string })?.line ?? '');
      if (msg && !already.has(msg)) pushEntry('info', 'electron-main', msg.slice(0, 2_000));
    }
  } catch { /* bridge unavailable — renderer-only logging continues */ }
}

// ─── UID resolution (labels the VPS folder server-side; cached client-side too) ─

function readUidFromStore(): string | null {
  try {
    const raw = localStorage.getItem('blasti-app');
    if (!raw) return null;
    const state = JSON.parse(raw)?.state;
    const uid = state?.user?.uid;
    return typeof uid === 'string' && uid ? uid : null;
  } catch { return null; }
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * 0.6.20 — direct-to-cloud POST used by the Electron renderer (see
 * uploadBatch). Reads the cloud session JWT from the persisted zustand store
 * (the SAME token import-session copies into the local API — the cloud
 * minted it). Never throws: network failures become { ok:false } so the
 * flush loop keeps its buffered-retry semantics.
 */
async function fetchLogsDirect(url: string, body: unknown): Promise<Response> {
  let token: string | null = null;
  try {
    const raw = localStorage.getItem('blasti-app');
    token = JSON.parse(raw || '{}')?.state?.sessionToken || null;
  } catch { /* no store — anonymous upload attempt (401 keeps buffering) */ }
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-blasti-client': 'desktop',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `network: ${String(err)}` }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function uploadBatch(manual: boolean): Promise<{ ok: boolean; accepted?: number; error?: string }> {
  if (buffer.length === 0) return { ok: true, accepted: 0 };
  if (typeof window === 'undefined') return { ok: false, error: 'no-window' };

  const platform = detectPlatform();
  const platformName = platform.isElectron ? 'desktop' : platform.isCapacitor ? 'mobile' : 'web';

  // Desktop: pull the main-process ring buffer into this flush.
  if (platform.isElectron) await mergeDesktopMainLogs();

  const uid = uidCache ?? readUidFromStore();
  uidCache = uid ?? null;

  const batch = buffer.slice(-MAX_BUFFER);
  const body = {
    manual,
    platform: platformName,
    appVersion: await appVersionSafe(),
    device: deviceDescription(),
    sessionHref: typeof window !== 'undefined' ? window.location.hash || window.location.pathname : '',
    sessionId: sessionIdSafe(),
    deviceSpecs: deviceSpecsSafe(),
    perf: perfSafe(),
    entries: batch,
  };

  // 0.6.20 audit fix — the logs vault lives ONLY on the cloud VPS. apiFetch
  // routes EVERYTHING to the embedded local API (:3080, local-first, no
  // cloud failover) inside Electron, and the local API has no /api/logs
  // ingest route — every desktop upload 404'd ("server too old" cooldown)
  // and renderer+main logs never left the device. Desktop uploads therefore
  // go to the CLOUD base directly (buildCloudUrl resolves electronAPI.
  // cloudBaseUrl), authenticated with the cloud-minted session JWT the store
  // already holds. Offline → fetch throws → same buffered-retry semantics.
  const res = platform.isElectron
    ? await fetchLogsDirect(buildCloudUrl('/api/logs'), body)
    : await apiFetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

  if (res.ok) {
    const data = await res.json().catch(() => ({ accepted: batch.length }));
    // Drop exactly what we sent (buffer may have grown meanwhile).
    buffer = buffer.slice(batch.length);
    persist();
    try { localStorage.setItem(LAST_FLUSH_KEY, new Date().toISOString()); } catch { /* ignore */ }
    return { ok: true, accepted: typeof data?.accepted === 'number' ? data.accepted : batch.length };
  }
  // 401 → not logged in yet; keep buffering. A 404 → the server predates the
  // logs vault: keep EVERYTHING (nothing is wrong with the payload) and open
  // the stale-server cooldown instead of retrying every 30s. Other 4xx →
  // drop the poisoned half. 5xx/network → keep everything.
  if (res.status === 404) {
    staleServer404Until = Date.now() + STALE_SERVER_404_COOLDOWN_MS;
    pushEntry('warn', 'logger', 'log vault unavailable (server too old — /api/logs 404). Auto-upload paused 15 min; entries kept. Update the VPS API to 0.6.15+ to restore streaming.');
    persist();
    return { ok: false, error: 'server-missing-logs-route' };
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 401) {
    buffer = buffer.slice(-Math.floor(MAX_BUFFER / 2));
    persist();
  }
  let error = `HTTP ${res.status}`;
  try { error = (await res.json())?.error || error; } catch { /* keep status text */ }
  return { ok: false, error };
}

let cachedAppVersion: string | null = null;
async function appVersionSafe(): Promise<string> {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const { getAppVersion } = await import('./app-version');
    const v = await getAppVersion();
    // Native shells (mobile APK / desktop where the bridge answers) report
    // their real versionName; plain web has no bridge — fall back to the
    // build-time monorepo version (next.config.ts env, scripts/version-set.js).
    cachedAppVersion = typeof v === 'string' && v
      ? v
      : (process.env.NEXT_PUBLIC_BLASTI_VERSION || 'unknown');
  } catch {
    cachedAppVersion = process.env.NEXT_PUBLIC_BLASTI_VERSION || 'unknown';
  }
  return cachedAppVersion;
}

function deviceDescription(): string {
  try {
    const ua = navigator.userAgent;
    const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatformId?: () => string } };
    if (w.Capacitor?.isNativePlatform?.()) return `capacitor-${w.Capacitor.getPlatformId?.() ?? 'android'}; ${ua.slice(0, 90)}`;
    if (ua.includes('Electron')) return `electron; ${ua.slice(0, 90)}`;
    return ua.slice(0, 120);
  } catch { return 'unknown'; }
}

// ─── 0.6.19 enrichment — deviceSpecs + perf (Logs Manager analyzer inputs) ──
// Collected at FLUSH time (not per entry): cheap synchronous reads only, each
// guarded, so a missing/odd browser API can never break the upload path.

function deviceSpecsSafe(): Record<string, string | number | boolean> | undefined {
  try {
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { effectiveType?: string; downlink?: number; rtt?: number };
    };
    const specs: Record<string, string | number | boolean> = {};
    if (nav.hardwareConcurrency) specs.cores = nav.hardwareConcurrency;
    if (nav.deviceMemory) specs.memoryGb = nav.deviceMemory;
    specs.screen = `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`;
    specs.dpr = window.devicePixelRatio ?? 1;
    if (typeof document !== 'undefined') specs.viewport = `${window.innerWidth}x${window.innerHeight}`;
    const conn = nav.connection;
    if (conn?.effectiveType) specs.net = conn.effectiveType;
    if (typeof conn?.downlink === 'number') specs.downlinkMb = conn.downlink;
    if (typeof conn?.rtt === 'number') specs.rttMs = conn.rtt;
    specs.lang = (nav.language || '').slice(0, 12);
    try { specs.tz = Intl.DateTimeFormat().resolvedOptions().timeZone?.slice(0, 40) ?? ''; } catch { /* ignore */ }
    // Chromium-only JS heap — the single best cross-session memory signal.
    const perfMem = (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
    if (perfMem?.usedJSHeapSize) specs.heapMb = Math.round(perfMem.usedJSHeapSize / (1024 * 1024));
    if (perfMem?.jsHeapSizeLimit) specs.heapLimitMb = Math.round(perfMem.jsHeapSizeLimit / (1024 * 1024));
    const uaData = (nav as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } }).userAgentData;
    if (uaData?.platform) specs.uaPlatform = uaData.platform;
    if (uaData && typeof uaData.mobile === 'boolean') specs.uaMobile = uaData.mobile;
    return Object.keys(specs).length > 0 ? specs : undefined;
  } catch { return undefined; }
}

function perfSafe(): Record<string, string | number | boolean> | undefined {
  try {
    const perf: Record<string, string | number | boolean> = {};
    perf.uptimeMin = Math.round((performance.now() / 60_000) * 10) / 10;
    const navEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (navEntry) {
      if (navEntry.domContentLoadedEventEnd > 0) perf.domReadyMs = Math.round(navEntry.domContentLoadedEventEnd);
      if (navEntry.loadEventEnd > 0) perf.pageLoadMs = Math.round(navEntry.loadEventEnd);
      if (navEntry.responseStart > 0 && navEntry.requestStart > 0) perf.ttfbMs = Math.round(navEntry.responseStart - navEntry.requestStart);
    }
    return Object.keys(perf).length > 0 ? perf : undefined;
  } catch { return undefined; }
}

/** One stable id per app session (tab/webview boot) — groups related batches. */
function sessionIdSafe(): string {
  try {
    const KEY = 'blasti-log-session-id';
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch { return 'no-session-storage'; }
}

// ─── Public flush API (auto + manual button) ─────────────────────────────────

export async function flushLogsNow(opts?: { manual?: boolean }): Promise<{ ok: boolean; accepted?: number; error?: string }> {
  if (flushing) return { ok: false, error: 'flush-in-progress' };
  const now = Date.now();
  // Stale-server cooldown: skip AUTO flushes only — the manual button
  // (opts.manual) always goes through so support can still force a snapshot
  // and see the real server answer.
  if (!opts?.manual && now < staleServer404Until) {
    return { ok: false, error: 'stale-server-cooldown' };
  }
  if (opts?.manual && now - lastFlushAt < MIN_FLUSH_GAP_MS) {
    return { ok: false, error: 'too-soon' };
  }
  flushing = true;
  try {
    const out = await uploadBatch(opts?.manual === true);
    lastFlushAt = Date.now();
    // A success clears the stale-server state (server got updated).
    if (out.ok) staleServer404Until = 0;
    return out;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'flush-failed' };
  } finally {
    flushing = false;
  }
}

/** When the vault last accepted a flush (shown next to the manual button). */
export function lastLogFlushAt(): string | null {
  try { return localStorage.getItem(LAST_FLUSH_KEY); } catch { return null; }
}

/** Buffer size for UI badges ("N unsent log entries"). */
export function pendingLogCount(): number {
  return buffer.length;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

export function installRemoteLogger(): void {
  if (typeof window === 'undefined') return;
  restore();
  installConsoleHook();

  // Route changes — the cheapest "what page was the user on" timeline.
  let lastHref = window.location.hash || window.location.pathname;
  window.addEventListener('hashchange', () => {
    const href = window.location.hash || window.location.pathname;
    if (href !== lastHref) {
      pushEntry('info', 'route', `${lastHref} → ${href}`);
      lastHref = href;
    }
  });

  // Flush triggers: interval, tab hide (mobile app pause), and beforeunload.
  flushTimer = setInterval(() => { void flushLogsNow(); }, FLUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { void flushLogsNow(); }
  });
  window.addEventListener('pagehide', () => { void flushLogsNow(); });

  pushEntry('info', 'logger', `remote logger installed (buffer restored: ${buffer.length} entries)`);
}

/** Call after login/logout — updates the UID label + forces a boundary flush. */
export function markAuthBoundary(uid: string | null | undefined): void {
  uidCache = uid ?? null;
  pushEntry('info', 'auth', uid ? `session bound to uid ${uid}` : 'session ended');
  void flushLogsNow();
}
