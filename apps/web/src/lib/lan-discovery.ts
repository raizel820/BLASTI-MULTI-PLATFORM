/**
 * BLASTI LAN Discovery Client
 *
 * Automatically discovers BLASTI desktop servers on the local network.
 * Uses HTTP scanning since browsers can't receive UDP broadcasts.
 *
 * Discovery Strategy:
 * 1. Check if we're already on the same host (localhost)
 * 2. Probe the gateway of our DERIVED subnet (WebRTC local IP when the page
 *    hostname isn't a real IP — Capacitor/localhost shells; else the page IP)
 * 3. Scan the derived /24, then the common LAN ranges on the API port
 * 4. Fall back to the cloud server if nothing found
 *
 * Only `service: 'blasti-local'` responses count as a desktop. The historic
 * 'blasti-lan' service is IGNORED here — it polluted the LAN cache and made
 * it flap between cloud and LAN entries (Task 2-b).
 *
 * The discovered server info is cached and used for API + Socket.IO connections.
 */

import { getLocalIp } from './get-local-ip';
// 0.6.91 — device event stream (Logs Manager "Devices" tab).
import { logDevice } from './remote-logger';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * 0.6.23 (R-21F-S2) — the elected master as advertised by a node's beacon
 * (`GET /api/discover` additive fields). Old desktops omit everything here.
 */
export interface DiscoveredMasterHint {
  instanceId?: string;
  name?: string;
  ip?: string;
  port?: number;
  term?: number;
}

export interface DiscoveredServer {
  service: string;
  version: string;
  name: string;
  displayName?: string;
  hostname: string;
  ip: string;
  port: number;
  apiPort: number;
  webPort: number;
  platform: string;
  uptime: number;
  networkInterface?: string;
  syncReady?: boolean;
  // ── 0.6.23 LAN authority (additive, optional — absent on old desktops) ──
  /** 'MASTER' | 'FOLLOWER' | 'CANDIDATE' — election role of this node. */
  role?: string;
  /** Current election term of this node. */
  term?: number;
  /** Node hardware/health score used by the election. */
  specScore?: number;
  /** Stable instance id of this node. */
  instanceId?: string;
  /** Agency scope this node serves (null = unrestricted). */
  agencyId?: string | null;
  /** Branch scope this node serves (null = unrestricted). */
  branchId?: string | null;
  /** The node's view of the current master (null while it IS the master). */
  master?: DiscoveredMasterHint | null;
  /** True when this desktop runs a LAN-authority-capable build. */
  lanAuthority?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DISCOVERY_ENDPOINT = '/api/discover';
const DISCOVERY_TIMEOUT = 800; // 0.6.75: local HTTP beacons answer in ms — 800ms is generous
const CACHE_KEY = 'blasti_lan_server';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
// 0.6.75 speed pass: bounded worker pool (48) instead of sequential waves of
// 10 — the batch loop waited for the slowest IP of each wave (up to one full
// timeout) before the next wave started, so a /24 took ~13s in the worst case.
const SCAN_CONCURRENCY = 48; // Probe 48 IPs at once (32–64 recommended band)
// 0.6.86 — full /24 coverage: the old cap of 128 silently skipped .129-.254,
// which is exactly where DHCP placed many desktops/kiosks — those peers were
// UNDISCOVERABLE ("cannot link computers for multi-window use", "kiosk cannot
// connect"). 254 hosts × 48-way pool × 800ms timeout bounds the sweep.
const SCAN_CAP = 254; // Max IPs scanned per subnet — full /24
const DEFAULT_API_PORT = parseInt(process.env.NEXT_PUBLIC_API_PORT || '3080', 10);

// M27: single-sweep mutex — 0.6.75 restores the actual flag (the check
// existed but the flag was never assigned, so the mutex never engaged).
let isScanning = false;

// ─── Cache Management ───────────────────────────────────────────────────────

export function getCachedServer(): DiscoveredServer | null {
  if (typeof window === 'undefined') return null;
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;
    const { server, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp > CACHE_TTL) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return server;
  } catch {
    return null;
  }
}

function cacheServer(server: DiscoveredServer): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ server, timestamp: Date.now() }));
  } catch {
    // ignore
  }
}

export function clearCache(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

// ─── Single IP Scanner ──────────────────────────────────────────────────────

/**
 * 0.6.23 — rank a discovered node for sweep preference: an elected MASTER
 * always beats a FOLLOWER, which beats an unknown/CANDIDATE node.
 */
function lanAuthorityRank(server: DiscoveredServer): number {
  if (server.role === 'MASTER') return 0;
  if (server.role === 'FOLLOWER') return 1;
  return 2;
}

async function scanIP(ip: string, port: number): Promise<DiscoveredServer | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT);

  try {
    const url = `http://${ip}:${port}${DISCOVERY_ENDPOINT}`;
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
      mode: 'cors',
    });

    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    // Task 2-b: ONLY 'blasti-local' is a desktop. 'blasti-lan' (cloud LAN
    // helper) responses used to be cached here and made the cache flap
    // between the cloud origin and the real LAN server.
    if (data.service === 'blasti-local') {
      const beacon = data as DiscoveredServer;
      // 0.6.23 (R-21F-S2): pass the LAN-authority election fields through
      // when the desktop serves them (additive — absent fields stay unset and
      // everything behaves exactly as before on old desktops).
      return {
        ...beacon,
        role: typeof data.role === 'string' ? data.role : undefined,
        term: typeof data.term === 'number' ? data.term : undefined,
        specScore: typeof data.specScore === 'number' ? data.specScore : undefined,
        instanceId: typeof data.instanceId === 'string' ? data.instanceId : undefined,
        agencyId: typeof data.agencyId === 'string' ? data.agencyId : null,
        branchId: typeof data.branchId === 'string' ? data.branchId : null,
        master: data.master && typeof data.master === 'object' ? (data.master as DiscoveredMasterHint) : null,
        lanAuthority: data.lanAuthority === true,
      };
    }
    return null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

// ─── Gateway Probe (replaces the fake mDNS lookups) ─────────────────────────

/**
 * Probe the gateway (assumed .1) of each candidate subnet for the desktop
 * beacon. The previous implementation "checked" blasti.local /
 * blasti._tcp.local — names nothing in the system announces — so it burned
 * a DNS timeout on every discovery pass. The gateway .1 is where the BLASTI
 * desktop (often also the router/NAT) is most likely to live.
 * 0.6.75: all gateways probed in PARALLEL (was: one sequential await each).
 */
async function checkGatewayServers(subnets: string[]): Promise<DiscoveredServer | null> {
  const results = await Promise.all(
    subnets.map((subnet) => scanIP(`${subnet}.1`, DEFAULT_API_PORT))
  );
  return (
    results
      .filter((r): r is DiscoveredServer => r !== null)
      .sort((a, b) => lanAuthorityRank(a) - lanAuthorityRank(b))[0] ?? null
  );
}

// ─── Localhost Check ────────────────────────────────────────────────────────

async function checkLocalhost(): Promise<DiscoveredServer | null> {
  // If we're already served from localhost, check if the LAN server is running
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return await scanIP('127.0.0.1', DEFAULT_API_PORT);
  }
  return null;
}

// ─── LAN Scanner ────────────────────────────────────────────────────────────

async function scanSubnet(
  subnet: string,
  port: number,
  onProgress?: (scanned: number, total: number) => void
): Promise<DiscoveredServer | null> {
  // L13: Skip .255 broadcast address — scan .1 through .{SCAN_CAP}
  // Task 2-b: a full 254-host sweep × 13 subnets is minutes of waiting on
  // unresponsive hosts; SCAN_CAP bounds each subnet scan.
  const ips = Array.from({ length: Math.min(254, SCAN_CAP) }, (_, i) => `${subnet}.${i + 1}`);
  const total = ips.length;
  // 0.6.75 — bounded worker pool instead of sequential batches of 10. The old
  // loop waited for the SLOWEST IP of each batch (up to one full timeout)
  // before starting the next batch; a shared-index worker pool keeps every
  // slot busy and stops the whole subnet the moment an elected MASTER answers.
  let index = 0;
  let scanned = 0;
  let best: DiscoveredServer | null = null;
  let bestRank = 3; // 0 = MASTER (best possible) … 2 = unknown — 3 = none yet

  const workers = Array.from(
    { length: Math.min(SCAN_CONCURRENCY, ips.length) },
    async () => {
      while (index < ips.length) {
        if (bestRank === 0) return; // early exit — nothing beats a MASTER
        const ip = ips[index++];
        const result = await scanIP(ip, port);
        scanned++;
        onProgress?.(scanned, total);
        if (result) {
          const rank = lanAuthorityRank(result);
          if (rank < bestRank) {
            bestRank = rank;
            best = result;
          }
        }
      }
    }
  );

  await Promise.all(workers);
  return best;
}

// ─── Local Subnet Derivation (Task 2-b) ─────────────────────────────────

/**
 * Derive the most likely LAN subnet(s) for THIS device.
 * Order: (1) the /24 of the page hostname when it IS a real IP (served from
 * a LAN host), (2) the /24 of the WebRTC local IP — the only reliable source
 * inside Capacitor/localhost shells, where window.location.hostname is
 * 'localhost' and the old hostname-derived subnet never existed.
 */
async function deriveCandidateSubnets(): Promise<string[]> {
  const subnets: string[] = [];
  const push = (ip: string) => {
    const parts = ip.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
      const subnet = parts.slice(0, 3).join('.');
      if (!subnets.includes(subnet)) subnets.push(subnet);
    }
  };
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(currentHost || '')) {
    push(currentHost);
  }
  try {
    const rtcIp = await getLocalIp();
    if (rtcIp) push(rtcIp);
  } catch { /* WebRTC blocked — fall through to the hardcoded list */ }
  return subnets;
}

// ─── Main Discovery Function ────────────────────────────────────────────────

export async function quickDiscover(): Promise<DiscoveredServer | null> {
  // M27: Check isScanning mutex
  if (isScanning) return null;
  if (typeof window === 'undefined') return null;
  isScanning = true;
  // 0.6.91 — device event stream: LAN discovery is now visible in the Logs
  // Manager "Devices" tab (previously this sweep was COMPLETELY silent — the
  // user could not tell whether the phone ever looked for the desktop box).
  const scanStartedAt = Date.now();
  try { logDevice('scan_started', 'LAN discovery started (cached → localhost → gateways → subnet sweep)'); } catch { /* never block */ }
  try {
    const derived = await deriveCandidateSubnets();

    // 0.6.75 — stage 1 runs in PARALLEL: cached-server liveness, localhost
    // probe and all derived-subnet gateway probes used to run back-to-back,
    // each paying up to one full timeout before the next stage started.
    const cached = getCachedServer();
    const cacheTask = (async (): Promise<DiscoveredServer | null> => {
      if (!cached) return null;
      // Filter out stale cache entries pointing to wrong ports (3003 = cloud, not LAN)
      const cachePort = cached.apiPort || cached.port;
      if (cachePort === 3000 || cachePort === 3003) {
        clearCache();
        return null;
      }
      // H14: Use apiPort for cache liveness check
      const alive = await scanIP(cached.ip, cachePort);
      if (alive) return alive;
      clearCache();
      return null;
    })();
    const localhostTask = checkLocalhost();
    const gatewayTask = checkGatewayServers(derived);

    const [cachedAlive, localhost, gateway] = await Promise.all([
      cacheTask,
      localhostTask,
      gatewayTask,
    ]);

    // Strict precedence preserved from the sequential version:
    // a live cached server > localhost > derived-subnet gateway.
    if (cachedAlive) {
      try { logDevice('scan_completed', `LAN discovery found the cached desktop box at ${cachedAlive.ip}:${cachedAlive.apiPort || cachedAlive.port}`, { deviceName: cachedAlive.name || undefined, deviceType: cachedAlive.role || undefined, status: 'ONLINE' }); } catch { /* never block */ }
      return cachedAlive;
    }
    if (localhost) {
      cacheServer(localhost); // M26: Cache localhost result
      try { logDevice('scan_completed', `LAN discovery found the local desktop at ${localhost.ip}:${localhost.apiPort || localhost.port}`, { deviceName: localhost.name || undefined, deviceType: localhost.role || undefined, status: 'ONLINE' }); } catch { /* never block */ }
      return localhost;
    }
    if (gateway) {
      cacheServer(gateway); // M26: Cache gateway result
      try { logDevice('scan_completed', `LAN discovery found the gateway desktop at ${gateway.ip}:${gateway.apiPort || gateway.port}`, { deviceName: gateway.name || undefined, deviceType: gateway.role || undefined, status: 'ONLINE' }); } catch { /* never block */ }
      return gateway;
    }

    // 0.6.75 — all candidate subnets scan CONCURRENTLY; the sequential loop
    // paid a full sweep per subnet before even trying the next one. The
    // common subnet (M25) joins the candidates instead of a second pass;
    // equal ranks keep candidate order (derived subnets first, stable sort).
    const candidates = derived.includes('192.168.1') ? derived : [...derived, '192.168.1'];
    const found = (
      await Promise.all(candidates.map((subnet) => scanSubnet(subnet, DEFAULT_API_PORT)))
    )
      .filter((s): s is DiscoveredServer => s !== null)
      .sort((a, b) => lanAuthorityRank(a) - lanAuthorityRank(b));

    const winner = found[0] ?? null;
    if (winner) cacheServer(winner);
    try {
      logDevice(
        winner ? 'scan_completed' : 'scan_failed',
        winner
          ? `LAN discovery found the desktop box at ${winner.ip}:${winner.apiPort || winner.port} after ${Math.round((Date.now() - scanStartedAt) / 1000)}s`
          : `LAN discovery finished with NO desktop box found after ${Math.round((Date.now() - scanStartedAt) / 1000)}s (${candidates.length} subnet(s) swept)`,
        winner
          ? { deviceName: winner.name || undefined, deviceType: winner.role || undefined, status: 'ONLINE' }
          : { subnets: candidates.length },
        winner ? 'info' : 'warn',
      );
    } catch { /* never block */ }
    return winner;
  } catch (err) {
    // 0.6.91 — device event stream: discovery crashed (was invisible before).
    try {
      logDevice('scan_failed', `LAN discovery failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`, undefined, 'error');
    } catch { /* never block */ }
    throw err;
  } finally {
    isScanning = false;
  }
}
