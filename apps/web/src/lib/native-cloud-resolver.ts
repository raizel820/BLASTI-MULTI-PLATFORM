/**
 * BLASTI Native Cloud Resolver — runtime cloud-API discovery for Capacitor shells
 *
 * WHY THIS EXISTS (the "can't login on my phone" bug):
 *   The Capacitor build bakes ONE cloud API URL at build time
 *   (NEXT_PUBLIC_API_URL in apps/web/.env.production). The committed default is
 *   http://10.0.2.2:3003 — the ANDROID EMULATOR's alias for the host PC's
 *   loopback. On a PHYSICAL phone 10.0.2.2 does not exist, so every API request
 *   (login included) dies with "Failed to fetch" while the same app in a desktop
 *   browser works fine (the browser resolves localhost:3003 itself).
 *   Baking the PC's LAN IP fixes one phone until the router re-assigns the IP —
 *   and forces a rebuild for every network. So the URL must be resolved at RUNTIME.
 *
 * Resolution order (first probe that answers as the BLASTI cloud API wins):
 *   1. last-known-good URL (localStorage, validated before reuse)
 *   2. manual override     (localStorage — set from the login screen)
 *   3. build-time env      (NEXT_PUBLIC_API_URL — emulator builds, real servers)
 *   4. gateway .1 of the device's derived subnet(s)
 *   5. full /24 sweep of the derived subnet(s)          (WebRTC local IP)
 *   6. common home/office subnets                        (hardcoded fallbacks)
 *   7. fallback: env value unvalidated (preserves the old behaviour offline)
 *
 * Identity check: the cloud API answers GET /api/discover with
 *   { service: 'blasti-lan', apiPort: 3003, ... }  (apps/api/src/index.ts).
 * NOTE: lan-discovery.ts (desktop scanner) deliberately IGNORES 'blasti-lan'
 * because for DESKTOP discovery it is the wrong service — here it is exactly
 * the right one: we are looking for the cloud API, not a desktop :3080 beacon.
 *
 * This module is self-contained (no api-client import) to avoid cycles —
 * api-client imports US, not the other way around.
 */

import { getLocalIp } from './get-local-ip';

// ─── Constants ────────────────────────────────────────────────────────────────

const CLOUD_PORT = parseInt(process.env.NEXT_PUBLIC_API_PORT || '3003', 10);
const DISCOVERY_ENDPOINT = '/api/discover';
const PROBE_TIMEOUT_MS = 900;
/** Few candidates get a longer leash — a probe may race a full LAN sweep
 * that is saturating the network stack (hundreds of pending sockets). */
const CANDIDATE_PROBE_TIMEOUT_MS = 2500;
const SCAN_CONCURRENCY = 24;
const SCAN_CAP = 128; // per subnet — bounds a full sweep (~6s at 900ms timeout)

const OVERRIDE_KEY = 'blasti-cloud-url-override';
const LAST_GOOD_KEY = 'blasti-cloud-url-last-good';

/** Common LAN prefixes scanned when the derived subnet yields nothing. */
const COMMON_SUBNETS = [
  '192.168.1', '192.168.0', '192.168.2', '192.168.4', '192.168.5',
  '192.168.8', '192.168.10', '192.168.86', '10.0.0', '10.0.1', '172.16.0',
];

// ─── State ────────────────────────────────────────────────────────────────────

export type NativeCloudSource =
  | 'none' | 'scanning' | 'last-good' | 'manual' | 'env' | 'scan' | 'fallback';

export interface NativeCloudState {
  status: 'idle' | 'scanning' | 'found' | 'failed';
  /** Resolved absolute base URL (no trailing slash) or null. */
  url: string | null;
  source: NativeCloudSource;
  scanned: number;
}

let state: NativeCloudState = { status: 'idle', url: null, source: 'none', scanned: 0 };
let listeners = new Set<(s: NativeCloudState) => void>();
let inFlight: Promise<string | null> | null = null;
let bootStarted = false;

/** Generation guard: a NEW scan invalidates every state write from older
 * runs, so a slow boot sweep can never stomp a fresh adoption. */
let scanGeneration = 0;
/** Abort controller for the ACTIVE full scan — the manual-save path aborts
 * the sweep so its in-flight probes stop contending for the network stack. */
let activeScanAbort: AbortController | null = null;

function setState(patch: Partial<NativeCloudState>, gen?: number): void {
  if (gen !== undefined && gen !== scanGeneration) return; // stale run
  state = { ...state, ...patch };
  listeners.forEach((cb) => {
    try { cb(state); } catch { /* listener errors must not break the scan */ }
  });
}

export function getNativeCloudState(): NativeCloudState {
  return state;
}

/** Sync accessor — what every request pipeline should use (may be null pre-resolution). */
export function getNativeCloudUrl(): string | null {
  return state.url;
}

export function onNativeCloudStateChange(cb: (s: NativeCloudState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ─── Storage helpers (SSR-safe) ───────────────────────────────────────────────

function lsGet(key: string): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key: string, value: string): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

function lsRemove(key: string): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function getManualCloudUrl(): string | null {
  return lsGet(OVERRIDE_KEY);
}

/**
 * Normalize user input into `http://host:port` (default port 3003).
 * Accepts "192.168.1.7", "192.168.1.7:3003", "http://192.168.1.7:3003",
 * and "https://api.example.com". Returns null when nothing parseable remains.
 */
function normalizeCloudUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    const port = u.port || (u.protocol === 'https:' ? '' : String(CLOUD_PORT));
    return `${u.protocol}//${u.hostname}${port ? `:${port}` : ''}`;
  } catch {
    return null;
  }
}

export function getNormalizedManualCloudUrl(): string | null {
  const raw = getManualCloudUrl();
  return raw ? normalizeCloudUrl(raw) : null;
}

/** Set (or clear with null) the manual server address. Does NOT trigger a scan. */
export function setManualCloudUrl(raw: string | null): string | null {
  if (raw === null) {
    lsRemove(OVERRIDE_KEY);
    return null;
  }
  const normalized = normalizeCloudUrl(raw);
  if (!normalized) return null;
  lsSet(OVERRIDE_KEY, normalized);
  return normalized;
}

// ─── Probing ──────────────────────────────────────────────────────────────────

interface CloudBeacon {
  service?: string;
  apiPort?: number;
  hostname?: string;
  displayName?: string;
  [k: string]: unknown;
}

/** Per-probe timeout + optional parent (scan) abort, cleaned up afterwards. */
function armProbeSignal(timeoutMs: number, parent?: AbortSignal | null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort);
  }
  return {
    signal: controller.signal,
    disarm: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Probe one candidate base URL; resolve to it when it identifies as the cloud API. */
async function probeCloudUrl(
  baseUrl: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  parent?: AbortSignal | null,
): Promise<CloudBeacon | null> {
  const { signal, disarm } = armProbeSignal(timeoutMs, parent);
  try {
    const res = await fetch(`${baseUrl}${DISCOVERY_ENDPOINT}`, {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json' },
      mode: 'cors',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CloudBeacon;
    // Cloud API identity (apps/api/src/index.ts /api/discover).
    // ALSO accept apiPort===CLOUD_PORT beacons in case the service string changes.
    if (data?.service === 'blasti-lan' || data?.apiPort === CLOUD_PORT) return data;
    return null;
  } catch {
    return null;
  } finally {
    disarm();
  }
}

function adopt(url: string, source: NativeCloudSource, beacon: CloudBeacon | null, gen: number): string {
  lsSet(LAST_GOOD_KEY, url);
  setState({ status: 'found', url, source, scanned: state.scanned }, gen);
  console.log(
    `[NativeCloud] resolved → ${url} (source=${source}${beacon?.hostname ? `, host=${beacon.hostname}` : ''})`,
  );
  return url;
}

/** A candidate is only as good as its reachability — always validate cached URLs. */
async function validateCandidate(url: string | null, parent?: AbortSignal | null): Promise<CloudBeacon | null> {
  if (!url) return null;
  return probeCloudUrl(url, CANDIDATE_PROBE_TIMEOUT_MS, parent);
}

// ─── Subnet derivation ────────────────────────────────────────────────────────

async function deriveSubnets(): Promise<string[]> {
  const subnets: string[] = [];
  const push = (ip: string) => {
    const parts = ip.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
      const subnet = parts.slice(0, 3).join('.');
      if (!subnets.includes(subnet)) subnets.push(subnet);
    }
  };
  // Inside the Capacitor shell the page host is localhost — useless. The
  // WebRTC mDNS-ice trick (get-local-ip) reveals the phone's actual Wi-Fi IP.
  try {
    const rtcIp = await getLocalIp();
    if (rtcIp && /^\d/.test(rtcIp) && !rtcIp.startsWith('0.')) push(rtcIp);
  } catch { /* WebRTC unavailable — fall through */ }
  return subnets;
}

async function scanSubnet(subnet: string, gen: number, parent: AbortSignal): Promise<string | null> {
  const ips = Array.from({ length: Math.min(254, SCAN_CAP) }, (_, i) => `${subnet}.${i + 1}`);
  for (let i = 0; i < ips.length; i += SCAN_CONCURRENCY) {
    if (gen !== scanGeneration || parent.aborted) return null; // a newer scan took over
    const batch = ips.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ip) => {
        const beacon = await probeCloudUrl(`http://${ip}:${CLOUD_PORT}`, PROBE_TIMEOUT_MS, parent);
        setState({ scanned: state.scanned + 1 }, gen);
        return beacon ? `http://${ip}:${CLOUD_PORT}` : null;
      }),
    );
    const hit = results.find((r) => r !== null);
    if (hit) return hit;
  }
  return null;
}

// ─── Emulator detection (informational logging only) ─────────────────────────

/**
 * Best-effort virtual-device check via the natively-registered @capacitor/device
 * plugin (accessed through the Capacitor global — the JS package is NOT a web
 * dependency). UA heuristics cover the case where the plugin is absent.
 * Only used for log output — the probe order above works for both targets.
 */
export async function isProbablyEmulator(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const capacitor = (window as unknown as {
      Capacitor?: {
        Plugins?: Record<string, { getInfo?: () => Promise<{ isVirtual?: boolean; model?: string }> }>;
      };
    }).Capacitor;
    const info = await capacitor?.Plugins?.Device?.getInfo?.();
    if (typeof info?.isVirtual === 'boolean') return info.isVirtual;
    return /sdk_gphone|google_sdk|emulator|genymotion/i.test(info?.model || '');
  } catch {
    if (typeof navigator !== 'undefined') {
      return /sdk_gphone|google_sdk|generic_x86|emulator/i.test(navigator.userAgent);
    }
    return false;
  }
}

// ─── Manual-only fast path ────────────────────────────────────────────────────

/**
 * Validate ONE user-supplied address: probe it, retrying once — the first
 * probe can be aborted by transient network-stack contention while a sweep
 * is winding down, and the user explicitly typed this address, so it earns
 * a second chance before we call it dead.
 */
async function validateManualCandidate(url: string | null): Promise<CloudBeacon | null> {
  if (!url) return null;
  const first = await probeCloudUrl(url, CANDIDATE_PROBE_TIMEOUT_MS);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 300));
  return probeCloudUrl(url, CANDIDATE_PROBE_TIMEOUT_MS);
}

/**
 * Manual-only resolution path used by the login dialog's SAVE action:
 * ABORT any running full scan (its pending probes would otherwise contend
 * with ours), then probe the (just-saved) address up to twice and adopt or
 * fail FAST — no subnet sweep (the user asked for THIS address; sweeping
 * would leave the dialog spinning for a minute before confirming failure).
 */
async function resolveManualOnly(): Promise<string | null> {
  const gen = ++scanGeneration;
  if (activeScanAbort) {
    activeScanAbort.abort();
    activeScanAbort = null;
  }
  setState({ status: 'scanning', scanned: 0 }, gen);
  const manual = getNormalizedManualCloudUrl();
  const beacon = await validateManualCandidate(manual);
  if (gen !== scanGeneration) return getNativeCloudUrl(); // superseded
  if (beacon && manual) return adopt(manual, 'manual', beacon, gen);
  console.warn('[NativeCloud] manual server address did not answer');
  setState({ status: 'failed', url: getNativeCloudUrl() || manual, source: 'fallback' }, gen);
  return null;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Resolve (and cache) the cloud API base URL for this native shell.
 * Concurrent callers share one scan; pass { force: true } to re-run the
 * full scan (Rescan button), or { manualOnly: true } after the user SAVES a
 * manual address (fast validate-or-fail, no sweep).
 */
export async function ensureNativeCloudUrl(
  opts?: { force?: boolean; manualOnly?: boolean },
): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  if (opts?.manualOnly) {
    // Manual-only runs always start fresh (they are user-initiated saves).
    return resolveManualOnly();
  }
  if (inFlight && !opts?.force) return inFlight;

  const gen = ++scanGeneration;
  const parent = new AbortController();
  activeScanAbort = parent;

  const run = async (): Promise<string | null> => {
    try {
      setState({ status: 'scanning', scanned: 0 }, gen);

      // 1+2. persisted URLs first (last-known-good, then manual override)
      const lastGood = lsGet(LAST_GOOD_KEY);
      const lastGoodBeacon = await validateCandidate(lastGood, parent.signal);
      if (gen !== scanGeneration || parent.signal.aborted) return getNativeCloudUrl(); // superseded
      if (lastGoodBeacon && lastGood) return adopt(lastGood, 'last-good', lastGoodBeacon, gen);

      const manual = getNormalizedManualCloudUrl();
      const manualBeacon = await validateCandidate(manual, parent.signal);
      if (gen !== scanGeneration || parent.signal.aborted) return getNativeCloudUrl(); // superseded
      if (manualBeacon && manual) return adopt(manual, 'manual', manualBeacon, gen);

      // 3. build-time env (emulator builds resolve here; physical devices with a
      //    stale emulator alias fail the probe in ~1 probe timeout)
      const envUrl = process.env.NEXT_PUBLIC_API_URL
        || (typeof process !== 'undefined' && (process as any).env?.BLASTI_CLOUD_URL)
        || null;
      const envBeacon = await validateCandidate(envUrl, parent.signal);
      if (gen !== scanGeneration || parent.signal.aborted) return getNativeCloudUrl(); // superseded
      if (envBeacon && envUrl) return adopt(envUrl, 'env', envBeacon, gen);

      // 4+5. the device's own Wi-Fi subnet: gateway first, then the /24 sweep
      const subnets = await deriveSubnets();
      for (const subnet of subnets) {
        const gwUrl = `http://${subnet}.1:${CLOUD_PORT}`;
        const gw = await validateCandidate(gwUrl, parent.signal);
        if (gen !== scanGeneration || parent.signal.aborted) return getNativeCloudUrl(); // superseded
        if (gw) return adopt(gwUrl, 'scan', gw, gen);
      }
      for (const subnet of subnets) {
        const hit = await scanSubnet(subnet, gen, parent.signal);
        if (gen !== scanGeneration || parent.signal.aborted) return getNativeCloudUrl(); // superseded
        if (hit) return adopt(hit, 'scan', null, gen);
      }

      // 6. common home/office subnets
      for (const subnet of COMMON_SUBNETS) {
        if (subnets.includes(subnet)) continue;
        const hit = await scanSubnet(subnet, gen, parent.signal);
        if (gen !== scanGeneration || parent.signal.aborted) return getNativeCloudUrl(); // superseded
        if (hit) return adopt(hit, 'scan', null, gen);
      }

      // 7. nothing answered — keep the env/default fallback so behaviour is no
      //    worse than before, but flag the state as failed so the UI can prompt.
      //    RETURN null (not the fallback) so callers can distinguish "found"
      //    from "not found" — the fallback lives in state.url for the pipeline.
      const fallback = envUrl || `http://10.0.2.2:${CLOUD_PORT}`;
      setState({ status: 'failed', url: fallback, source: 'fallback' }, gen);
      console.warn(`[NativeCloud] no BLASTI server found on the LAN — fallback ${fallback}`);
      return null;
    } finally {
      if (activeScanAbort === parent) activeScanAbort = null;
    }
  };

  inFlight = run().finally(() => {
    if (gen === scanGeneration) inFlight = null;
  });
  return inFlight;
}

/** Fire-and-forget boot resolution — called once when api-client loads. */
export function startNativeCloudResolution(): void {
  if (bootStarted || typeof window === 'undefined') return;
  bootStarted = true;
  void ensureNativeCloudUrl().catch(() => { /* state already 'failed' */ });
}

/** Forget the cached last-good URL (e.g. after repeated network failures). */
export function clearNativeCloudCache(): void {
  lsRemove(LAST_GOOD_KEY);
  setState({ url: null, source: 'none', status: 'idle', scanned: 0 });
}
