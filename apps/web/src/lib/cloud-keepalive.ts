'use client';

/**
 * cloud-keepalive — 0.6.68 connection-stability heartbeat.
 *
 * WHY: the recurring field pattern "always fails on the FIRST try, passes on
 * the second" is a COLD connection. The first request a freshly booted app
 * makes to the server pays the one-time connection costs — DNS resolution,
 * TCP connect, TLS handshake — and on slow/IPv6-fallback links that budget
 * exceeds the caller's timeout, so the user sees "requires an internet
 * connection" even though the network is fine. The SECOND attempt reuses the
 * now-warm connection pool and lands instantly.
 *
 * The desktop local API already warms its own cloud pool at boot
 * (warmCloudConnection in local-api/index.js). This module covers the WEB and
 * MOBILE (Capacitor) runtimes: a light periodic probe keeps the browser's
 * connection pool to the server warm so the user's FIRST real action of the
 * session (register, verify, agency create) never pays the cold-start tax.
 *
 * Design:
 *  - One module-level singleton; startCloudKeepalive() is idempotent and
 *    SSR-safe (no-op without a window).
 *  - Probe every 4 min (below typical NAT/TLS idle windows of 5–15 min),
 *    with one early probe ~20 s after boot to warm the session.
 *  - Visibility-aware: skipped while the document is hidden; a probe fires
 *    immediately when the app becomes visible again after a long hide
 *    (returning from background on mobile) so the pool is warm BEFORE the
 *    user's first tap.
 *  - Desktop (Electron): the renderer talks to the LOCAL API, whose cloud
 *    pool is warmed by the local API itself — the probe targets the local
 *    /api/cloud-status route instead, keeping the renderer↔local hop warm
 *    and recording the cloud verdict for diagnostics.
 *  - Never throws, never toasts, never logs spam: failures land in the diag
 *    ring buffer only (throttled).
 */

import { apiClient, isElectronRuntime } from '@/lib/api-client';
import { diag } from '@/lib/diag-log';

export interface CloudHeartbeatSnapshot {
  /** true/false from the last completed probe; null = never probed. */
  ok: boolean | null;
  /** Epoch ms of the last completed probe (0 = never). */
  lastProbeAt: number;
  /** Epoch ms of the last SUCCESSFUL probe (0 = never). */
  lastOkAt: number;
  /** How many probes have run since startCloudKeepalive(). */
  probes: number;
}

let snapshot: CloudHeartbeatSnapshot = { ok: null, lastProbeAt: 0, lastOkAt: 0, probes: 0 };
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** Read-only snapshot for diagnostics UIs (ConnectionStatus, diag panel…). */
export function getCloudHeartbeatSnapshot(): CloudHeartbeatSnapshot {
  return snapshot;
}

async function probeOnce(): Promise<boolean> {
  if (inFlight) return snapshot.ok === true;
  inFlight = true;
  try {
    // cacheTtl: 0 — a cached health answer proves nothing about the CURRENT
    // connection; the probe must touch the network to keep the pool warm.
    if (isElectronRuntime()) {
      const res = await apiClient
        .get<{ reachable?: boolean }>('/api/cloud-status', { cacheTtl: 0, timeout: 9_000 })
        .catch(() => null);
      const ok = res?.data?.reachable === true;
      record(ok);
      return ok;
    }
    const res = await apiClient.get('/api/health', { cacheTtl: 0, timeout: 9_000 }).catch(() => null);
    // ANY http answer (even 4xx/5xx from a proxy) proves the server path is
    // alive — reachability, not business health, is what we warm.
    const ok = !!res && res.status > 0;
    record(ok);
    return ok;
  } finally {
    inFlight = false;
  }
}

function record(ok: boolean) {
  const now = Date.now();
  const prevOk = snapshot.ok;
  snapshot = {
    ok,
    lastProbeAt: now,
    lastOkAt: ok ? now : snapshot.lastOkAt,
    probes: snapshot.probes + 1,
  };
  // Diag only on FLIP (ok↔fail) — a stable connection must stay silent.
  if (prevOk !== null && prevOk !== ok) {
    diag(ok ? 'keepalive-recovered' : 'keepalive-lost', { at: now });
  }
}

const PROBE_INTERVAL_MS = 4 * 60 * 1000; // 4 min — under NAT/TLS idle windows
const FIRST_DELAY_MS = 20_000; // warm the session shortly after boot

/**
 * Starts the heartbeat. Idempotent: a second call while running is a no-op.
 * Returns a stop function (unused by app code — the heartbeat lives for the
 * page lifetime; exported for tests/hot-reload hygiene).
 */
export function startCloudKeepalive(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (timer) return () => undefined;

  const first = setTimeout(() => { void probeOnce(); }, FIRST_DELAY_MS);
  timer = setInterval(() => {
    // Hidden tab / backgrounded app — skip; the visibility handler catches up.
    if (typeof document !== 'undefined' && document.hidden) return;
    void probeOnce();
  }, PROBE_INTERVAL_MS);

  // Return-to-foreground catch-up: mobile apps come back from background
  // with a DEAD connection pool — warm it BEFORE the user's first tap.
  const onVisible = () => {
    if (typeof document === 'undefined' || document.hidden) return;
    if (snapshot.lastProbeAt && Date.now() - snapshot.lastProbeAt < 2 * 60 * 1000) return;
    void probeOnce();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    clearTimeout(first);
    if (timer) { clearInterval(timer); timer = null; }
    document.removeEventListener('visibilitychange', onVisible);
  };
}
