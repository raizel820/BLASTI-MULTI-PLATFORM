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
const DISCOVERY_TIMEOUT = 1000; // 1s per IP — local HTTP beacons answer in ms
const CACHE_KEY = 'blasti_lan_server';
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
const SCAN_CONCURRENCY = 10; // Scan 10 IPs at once
const SCAN_CAP = 128; // Max IPs scanned per subnet — bounds a full sweep
const DEFAULT_API_PORT = parseInt(process.env.NEXT_PUBLIC_API_PORT || '3080', 10);

// Common LAN subnets to scan
const LAN_SUBNETS = [
  '192.168.1',   // Most home routers
  '192.168.0',   // Alternative common subnet
  '192.168.2',   // Less common but exists
  '10.0.0',      // Corporate networks
  '10.0.1',      // Apple AirPort
  '192.168.4',   // Android hotspot
  '172.16.0',    // Corporate VPN
  '192.168.5',   // M30: Additional common subnets
  '192.168.8',
  '192.168.86',
  '192.168.10',
  '10.0.2',      // VirtualBox/Genymotion
  '169.254',     // L12: Link-local addresses
];

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
 */
async function checkGatewayServers(subnets: string[]): Promise<DiscoveredServer | null> {
  for (const subnet of subnets) {
    const server = await scanIP(`${subnet}.1`, DEFAULT_API_PORT);
    if (server) return server;
  }
  return null;
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
  let scanned = 0;

  // Scan in batches of SCAN_CONCURRENCY
  for (let i = 0; i < ips.length; i += SCAN_CONCURRENCY) {
    const batch = ips.slice(i, i + SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (ip) => {
        const result = await scanIP(ip, port);
        scanned++;
        onProgress?.(scanned, total);
        return result;
      })
    );

    // 0.6.23: prefer an elected MASTER over a FOLLOWER/unknown node when a
    // single sweep batch finds several desktops (stable rank, then first hit).
    const found = results
      .filter((r): r is DiscoveredServer => r !== null)
      .sort((a, b) => lanAuthorityRank(a) - lanAuthorityRank(b))[0];
    if (found) return found;
  }

  return null;
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

  // Check cache
  const cached = getCachedServer();
  if (cached) {
    // Filter out stale cache entries pointing to wrong ports (3003 = cloud, not LAN)
    const cachePort = cached.apiPort || cached.port;
    if (cachePort === 3000 || cachePort === 3003) {
      clearCache();
    } else {
      // H14: Use apiPort for cache liveness check
      const alive = await scanIP(cached.ip, cachePort);
      if (alive) return alive;
      clearCache();
    }
  }

  // Check localhost
  const localhost = await checkLocalhost();
  if (localhost) {
    cacheServer(localhost); // M26: Cache localhost result
    return localhost;
  }

  // Probe the gateway (.1) of the derived subnet(s), then scan them.
  const derived = await deriveCandidateSubnets();
  const gateway = await checkGatewayServers(derived);
  if (gateway) {
    cacheServer(gateway); // M26: Cache gateway result
    return gateway;
  }

  const scannedSubnets = new Set<string>(); // M25
  for (const subnet of derived) {
    scannedSubnets.add(subnet); // M25: Track scanned subnet
    const server = await scanSubnet(subnet, DEFAULT_API_PORT);
    if (server) {
      cacheServer(server);
      return server;
    }
  }

  // Try the most common subnet (M25: skip if already scanned)
  if (!scannedSubnets.has('192.168.1')) {
    scannedSubnets.add('192.168.1');
    const commonServer = await scanSubnet('192.168.1', DEFAULT_API_PORT);
    if (commonServer) {
      cacheServer(commonServer);
      return commonServer;
    }
  }

  return null;
}
