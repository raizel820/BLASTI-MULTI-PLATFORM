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
}

export interface DiscoveryState {
  status: 'idle' | 'scanning' | 'found' | 'failed';
  server: DiscoveredServer | null;
  scannedCount: number;
  totalToScan: number;
}

type DiscoveryListener = (state: DiscoveryState) => void;

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
      return data as DiscoveredServer;
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

    const found = results.find((r) => r !== null);
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

let isScanning = false;
let inFlightPromise: Promise<DiscoveredServer | null> | null = null; // M31
let listeners: Set<DiscoveryListener> = new Set();

function notifyListeners(state: DiscoveryState) {
  listeners.forEach((listener) => listener(state));
}

export function onDiscoveryStateChange(listener: DiscoveryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function discoverLanServer(
  options?: {
    skipCache?: boolean;
    subnet?: string;
    signal?: AbortSignal;
    onProgress?: (state: DiscoveryState) => void;
  }
): Promise<DiscoveredServer | null> {
  const controller = new AbortController();
  const signal = options?.signal || controller.signal;

  // M31: Return in-flight promise to concurrent callers
  if (isScanning && inFlightPromise) return inFlightPromise;
  if (typeof window === 'undefined') return null;

  // Check cache first
  if (!options?.skipCache) {
    const cached = getCachedServer();
    if (cached) {
      // Filter out stale cache entries pointing to wrong ports (3003 = cloud, not LAN)
      const cachePort = cached.apiPort || cached.port;
      if (cachePort === 3000 || cachePort === 3003) {
        clearCache();
      } else {
        // H14: Verify the cached server is still alive using apiPort
        const alive = await scanIP(cached.ip, cachePort);
        if (alive) {
          notifyListeners({ status: 'found', server: alive, scannedCount: 0, totalToScan: 0 });
          return alive;
        }
        clearCache();
      }
    }
  }

  isScanning = true;
  let scannedCount = 0;
  const scannedSubnets = new Set<string>(); // M25
  const totalToScan = LAN_SUBNETS.length * SCAN_CAP;

  const updateProgress = (status: 'scanning' | 'failed', server: DiscoveredServer | null) => {
    const state: DiscoveryState = { status, server, scannedCount, totalToScan };
    options?.onProgress?.(state);
    notifyListeners(state);
  };

  const discover = async (): Promise<DiscoveredServer | null> => {
    try {
      // Strategy 1: Check localhost
      updateProgress('scanning', null);
      const localhostServer = await checkLocalhost();
      if (localhostServer) {
        cacheServer(localhostServer);
        notifyListeners({ status: 'found', server: localhostServer, scannedCount: 0, totalToScan: 0 });
        return localhostServer;
      }
      scannedCount += 1;

      // Strategy 2+3: derive our LAN subnet(s) — WebRTC local IP first
      // (Capacitor/localhost shells), then the page hostname — probe their
      // gateway (.1) and scan them BEFORE any hardcoded fallback (Task 2-b).
      const derived = await deriveCandidateSubnets();
      const gatewayServer = await checkGatewayServers(derived);
      if (gatewayServer) {
        cacheServer(gatewayServer);
        notifyListeners({ status: 'found', server: gatewayServer, scannedCount: 0, totalToScan: 0 });
        return gatewayServer;
      }
      scannedCount += derived.length;

      for (const subnet of derived) {
        // M25: Track scanned subnets to avoid duplicates
        if (scannedSubnets.has(subnet)) continue;
        scannedSubnets.add(subnet);
        const subnetServer = await scanSubnet(subnet, DEFAULT_API_PORT, (s, _t) => {
          // M28: Accumulate progress instead of overwriting
          scannedCount += s;
          updateProgress('scanning', null);
        });
        if (subnetServer) {
          cacheServer(subnetServer);
          notifyListeners({ status: 'found', server: subnetServer, scannedCount, totalToScan });
          return subnetServer;
        }
      }

      // Strategy 4: Scan all common subnets (fallback AFTER the derived one)
      const targetSubnet = options?.subnet;
      const subnets = targetSubnet ? [targetSubnet] : LAN_SUBNETS;

      for (const subnet of subnets) {
        // M25: Skip already-scanned subnets
        if (scannedSubnets.has(subnet)) continue;
        scannedSubnets.add(subnet);
        const server = await scanSubnet(subnet, DEFAULT_API_PORT, (s, _t) => {
          // M28: Accumulate progress
          scannedCount += s;
          updateProgress('scanning', null);
        });
        if (server) {
          cacheServer(server);
          notifyListeners({ status: 'found', server, scannedCount, totalToScan });
          return server;
        }
      }

      // No server found
      notifyListeners({ status: 'failed', server: null, scannedCount, totalToScan });
      return null;
    } finally {
      isScanning = false;
      inFlightPromise = null;
      controller.abort();
    }
  };

  inFlightPromise = discover();
  return inFlightPromise;
}

// ─── Quick Discovery (for kiosk mode) ───────────────────────────────────────

/**
 * Quick discovery that only checks localhost + the current subnet.
 * Much faster than full scan — ideal for kiosk mode auto-connect.
 */
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

// ─── Connection URL Builder ─────────────────────────────────────────────────

/**
 * Get the best human-readable label for a discovered server.
 * Prefers displayName > hostname > "BLASTI Server (IP)".
 * Includes the network interface if available (e.g., "Wi-Fi").
 */
export function getServerLabel(server: DiscoveredServer): string {
  // Priority: displayName > hostname (if it looks meaningful) > fallback
  const name = server.displayName || server.hostname || 'BLASTI Server';

  // If the name is just an IP or looks generic, use a readable fallback
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name === 'localhost' || name === 'BLASTI Desktop') {
    return `BLASTI Server (${server.ip})`;
  }

  // Add network interface context if available (e.g., "John's MacBook (Wi-Fi)")
  if (server.networkInterface && !['Wi-Fi', 'Ethernet'].some(n => name.includes(n))) {
    return `${name} (${server.networkInterface})`;
  }

  return name;
}

/**
 * Get the platform badge text (e.g., "Windows", "macOS", "Linux").
 */
export function getPlatformBadge(platform: string): string {
  switch (platform) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'android': return 'Android';
    case 'ios': return 'iOS';
    default: return platform;
  }
}

/**
 * Get the best available API URL based on discovery results.
 * Returns the LAN server URL if found, otherwise falls back to cloud/relative.
 */
export function getLanApiUrl(server: DiscoveredServer): string {
  // If the server is on the same machine, use the page's origin (relative path through
  // Next.js proxy) to avoid CORS/routing issues in container/sandbox environments.
  // In production on a real LAN, the IP will be a real LAN IP (192.168.x, 10.x, etc.)
  // and we use it directly.
  if (typeof window === 'undefined') {
    return `http://${server.ip}:${server.apiPort || server.port}`;
  }
  // Detect real LAN IPs — these are reachable from other devices on the network
  const isRealLanIp = server.ip.startsWith('192.168.') ||
    server.ip.startsWith('10.') ||
    (server.ip.startsWith('172.') && parseInt(server.ip.split('.')[1]) >= 16 && parseInt(server.ip.split('.')[1]) <= 31);
  if (isRealLanIp) {
    return `http://${server.ip}:${server.apiPort || server.port}`;
  }
  // H15: Same machine / container / dev environment: use page origin
  // so the Next.js proxy handles it
  return window.location.origin;
}

/**
 * Get the best available Socket.IO URL based on discovery results.
 */
export function getLanSocketUrl(server: DiscoveredServer): string {
  // M29: Same-machine detection for socket URL
  if (typeof window !== 'undefined') {
    const isLoopback = server.ip === '127.0.0.1' || server.ip === 'localhost' || server.ip === '::1';
    const isRealLanIp = server.ip.startsWith('192.168.') ||
      server.ip.startsWith('10.') ||
      (server.ip.startsWith('172.') && parseInt(server.ip.split('.')[1]) >= 16 && parseInt(server.ip.split('.')[1]) <= 31);
    if (isLoopback || !isRealLanIp) {
      return window.location.origin;
    }
  }
  return `http://${server.ip}:${server.apiPort || server.port}`;
}

/**
 * Get the best available web URL for the LAN server.
 */
export function getLanWebUrl(server: DiscoveredServer): string {
  return `http://${server.ip}:${server.webPort || 3000}`;
}