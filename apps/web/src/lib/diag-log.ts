/**
 * diag-log — BLASTI diagnostics ring buffer (renderer side).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY: the intermittent "data loading failed" dashboard error (and the
 * "waiting for syncing" splash releasing before the sync finished) could not
 * be diagnosed from the existing scattered console.log lines alone — by the
 * time someone reads the console, the interesting sequence (login → session
 * import → token rotation → boot gate → dashboard fetch) is gone, and a page
 * reload wipes the console entirely.
 *
 * This module keeps the last N diagnostic events in a ring buffer AND
 * persists them to localStorage, so the full timeline survives a reload and
 * can be dumped on demand:
 *   - diag(event, data)            record one event
 *   - diagDump(reason)             print a formatted, copyable timeline to
 *                                  the console + remember why it was dumped
 *   - window.__blastiDiag          devtools access: .dump(), .log(), .events
 *
 * Everything is best-effort: no throw may ever escape this module (a broken
 * diagnostics layer must never cause the very error it is meant to explain).
 *
 * What gets recorded (instrumented call sites):
 *   api-client        → cloud-fail / lan-fail (status, body snippet, ms)
 *   fetch-with-retry  → auth-expired handling decisions
 *   session-adopt     → token catch-up results
 *   boot-gate         → gate release decision + elapsed ms
 *   sync engine       → sync-start / sync-complete / sync-error (+ target, ms)
 *   agency dashboard  → per-section fetch failures (with response snippets)
 *   login flow        → session lifecycle milestones
 */

const MAX_EVENTS = 250;
const STORAGE_KEY = 'blasti-diag-log';
const MAX_ENTRY_JSON = 600; // cap the serialized payload of one event

export interface DiagEvent {
  /** ISO timestamp */
  t: string;
  /** ms since page load (easier to read sequences) */
  ms: number;
  /** machine-readable event name, e.g. 'lan-fail', 'boot-gate-release' */
  ev: string;
  /** structured payload (already size-capped) */
  d?: Record<string, unknown>;
}

let buffer: DiagEvent[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pageLoadMs: number;

function now(): { t: string; ms: number } {
  const d = new Date();
  const ms = typeof performance !== 'undefined' && pageLoadMs !== undefined
    ? Math.round(performance.now())
    : 0;
  return { t: d.toISOString().slice(11, 23), ms };
}

function capValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_ENTRY_JSON ? value.slice(0, MAX_ENTRY_JSON) + '…' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const json = JSON.stringify(value);
    if (json == null) return String(value);
    return json.length > MAX_ENTRY_JSON
      ? JSON.parse(json.slice(0, MAX_ENTRY_JSON))
      : value;
  } catch {
    return String(value);
  }
}

function capData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    try {
      out[k] = capValue(v);
    } catch {
      out[k] = 'unserializable';
    }
  }
  return out;
}

function schedulePersist(): void {
  if (persistTimer || typeof localStorage === 'undefined') return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
    } catch {
      // Quota/serialisation failure — keep the in-memory buffer only.
    }
  }, 400);
}

function loadPersisted(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Keep only entries from the last 24h so stale dumps don't confuse.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      buffer = parsed.filter(
        (e: DiagEvent) => e && typeof e.t === 'string' && new Date(e.t).getTime() > cutoff,
      ).slice(-MAX_EVENTS);
    }
  } catch {
    buffer = [];
  }
}

// Initialize (browser only).
if (typeof window !== 'undefined') {
  pageLoadMs = 0;
  loadPersisted();
}

/**
 * Record one diagnostic event. Never throws.
 * The event is also printed on the console at debug level so a live session
 * shows the same timeline in place.
 */
export function diag(ev: string, data?: Record<string, unknown>): void {
  try {
    if (typeof window === 'undefined') return;
    const { t, ms } = now();
    const entry: DiagEvent = { t, ms, ev, d: capData(data) };
    buffer.push(entry);
    if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
    schedulePersist();
    // Mirror to the console (kept lightweight — no stacks here).
    try {
      const flat = entry.d && Object.keys(entry.d).length
        ? ' ' + JSON.stringify(entry.d)
        : '';
      console.debug(`[DIAG ${t}] ${ev}${flat}`);
    } catch { /* console unavailable */ }
  } catch { /* diagnostics must never break the app */ }
}

/** Record a diagnostic event from an Error (name + message, no stack spam). */
export function diagError(ev: string, error: unknown, extra?: Record<string, unknown>): void {
  const err = error instanceof Error
    ? { name: error.name, message: error.message }
    : { message: String(error) };
  diag(ev, { ...err, ...extra });
}

function fmtEvent(e: DiagEvent): string {
  const d = e.d && Object.keys(e.d).length ? ' ' + JSON.stringify(e.d) : '';
  return `${e.t} +${String(e.ms).padStart(6, ' ')}ms  ${e.ev}${d}`;
}

/**
 * Dump the whole timeline in a copyable block.
 * Called automatically when the dashboard shows "Failed to load data" and
 * manually via window.__blastiDiag.dump('reason').
 */
export function diagDump(reason: string): string {
  try {
    const lines: string[] = [];
    lines.push('══════════════════════════════════════════════════════════');
    lines.push(`BLASTI DIAGNOSTIC DUMP — reason: ${reason}`);
    lines.push(`at ${new Date().toISOString()} — page uptime ${Math.round(performance.now())}ms`);
    lines.push(`UA: ${navigator.userAgent}`);
    try {
      lines.push(`session: authenticated=${localStorage.getItem('blasti-app')?.includes('"isAuthenticated":true')}`);
    } catch { /* ignore */ }
    lines.push('──────────────────────────────────────────────────────────');
    if (buffer.length === 0) {
      lines.push('(no diagnostic events recorded)');
    } else {
      for (const e of buffer) lines.push(fmtEvent(e));
    }
    lines.push('══════════════════════════════════════════════════════════');
    const text = lines.join('\n');
    console.warn(text);
    diag('diag-dump', { reason, events: buffer.length });
    return text;
  } catch {
    return 'diagDump failed';
  }
}

/** Read the current buffer (devtools / tests). */
export function diagEvents(): DiagEvent[] {
  return [...buffer];
}

/** Clear the buffer (used on a fresh login so timelines don't interleave). */
export function diagReset(reason: string): void {
  try {
    diag('diag-reset', { reason, dropped: buffer.length });
    buffer = [];
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// Devtools / support access point.
if (typeof window !== 'undefined') {
  try {
    (window as unknown as Record<string, unknown>).__blastiDiag = {
      dump: diagDump,
      log: diag,
      events: diagEvents,
      reset: diagReset,
    };
  } catch { /* ignore */ }
}
