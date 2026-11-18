/**
 * kiosk-lan-base.ts — Kiosk LAN API base override (0.6.86).
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT FIX for "kiosk cannot connect via discovery OR branch code" and
 * "phones/tablets cannot be used in kiosk mode":
 *
 * Production web builds bake NEXT_PUBLIC_API_URL=https://blastidz.online, so
 * a tablet kiosk ALWAYS registered/paired against the CLOUD store while the
 * desktop Device Manager polled the LOCAL (:3080) store. Both sides sat in
 * "waiting" forever with zero errors — the orphan device never appeared in
 * the manager's approval strip because it lived in a DIFFERENT database.
 *
 * This module holds a tiny, validated override that getApiBaseUrl() consults:
 * once a kiosk discovers a desktop LAN server (HTTP sweep) or resolves one
 * from a branch code (cloud /api/lan-topology/resolve), every device API call
 * routes to the DESKTOP's local API — the same store the manager watches.
 *
 * Security: the persisted base is only honored for private-network hosts
 * (RFC1918 / loopback / one of this machine's own LAN IPs) — localStorage
 * tampering cannot redirect kiosk traffic to a public origin.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BranchHostCandidate {
  ip: string;
  port: number;
  name?: string;
  hostname?: string | null;
  role?: string;
  reportedAt?: string;
}

export interface BranchResolveResult {
  agency: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    customCode: string;
    isQueueOpen?: boolean;
    logoUrl?: string | null;
    category?: string | null;
  } | null;
  hosts: BranchHostCandidate[];
  /** The first candidate that answered the /api/discover beacon probe. */
  server: {
    ip: string;
    port: number;
    name?: string;
  } | null;
}

// ─── Storage ────────────────────────────────────────────────────────────────

const KIOSK_LAN_BASE_KEY = 'blasti_kiosk_lan_base';

/** RFC1918 / loopback IPv4 (same guard the desktop's lan-origin.js uses). */
function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const [a, b] = host.split('.').map((n) => parseInt(n, 10));
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Persist the LAN base the kiosk should talk to (null clears it).
 * Only http://<private-ip>:<port> / http://localhost:<port> values are kept.
 */
export function setKioskLanBase(base: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!base) {
      window.localStorage.removeItem(KIOSK_LAN_BASE_KEY);
      return;
    }
    const u = new URL(base);
    if (u.protocol !== 'http:') return; // LAN beacons are plain http
    const host = u.hostname;
    const ok = isPrivateIpv4(host)
      || host === 'localhost'
      || host === '127.0.0.1'
      || (!host.includes('.') && host.length > 0); // bare machine hostname
    if (!ok) {
      console.warn('[KioskLAN] refusing to persist non-private API base:', base);
      return;
    }
    window.localStorage.setItem(KIOSK_LAN_BASE_KEY, base.replace(/\/+$/, ''));
    console.log('[KioskLAN] device API base pinned to LAN desktop:', base);
  } catch {
    /* malformed base — ignore */
  }
}

/** The pinned LAN base (validated), or null. */
export function getKioskLanBase(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KIOSK_LAN_BASE_KEY);
    if (!raw) return null;
    const u = new URL(raw);
    const host = u.hostname;
    if (u.protocol !== 'http:') return null;
    if (!isPrivateIpv4(host) && host !== 'localhost' && host !== '127.0.0.1' && host.includes('.')) {
      return null;
    }
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Drop the override (e.g. repeated LAN failures) — cloud routing resumes. */
export function clearKioskLanBase(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(KIOSK_LAN_BASE_KEY); } catch { /* ignore */ }
}

// ─── Branch-code → LAN host resolution (cloud assist) ───────────────────────

/**
 * Probe one candidate host's discovery beacon. Mirrors lan-discovery.scanIP
 * but tolerates non-standard ports and returns just the identity payload.
 */
async function probeBeacon(ip: string, port: number, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}/api/discover`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
      mode: 'cors',
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { service?: string } | null;
    return data?.service === 'blasti-local';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a branch/agency code to a LIVE desktop LAN host:
 * 1. Ask the CLOUD `/api/lan-topology/resolve?code=…` for candidate hosts the
 *    agency's desktops reported in the last 5 minutes.
 * 2. Probe each candidate's `/api/discover` beacon on the LAN.
 * 3. Return the agency + the first live host (callers then pin the base via
 *    setKioskLanBase and continue the normal register/pair flow against it).
 *
 * Never throws — failures come back as `{ agency: null, hosts: [], server: null }`.
 */
export async function resolveBranchLanServer(code: string, timeoutMs = 6000): Promise<BranchResolveResult> {
  const empty: BranchResolveResult = { agency: null, hosts: [], server: null };
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return empty;
  try {
    // Dynamic import keeps api-client ↔ kiosk-lan-base free of a static cycle.
    const { buildCloudUrl } = await import('./api-client');
    const url = buildCloudUrl('/api/lan-topology/resolve', { code: clean });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let body: { success?: boolean; error?: string; agency?: BranchResolveResult['agency']; hosts?: BranchHostCandidate[] } | null = null;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
      body = (await res.json().catch(() => null)) as typeof body;
    } finally {
      clearTimeout(timer);
    }
    if (!body || body.success !== true || !body.agency) return empty;
    const hosts = (Array.isArray(body.hosts) ? body.hosts : []).filter(
      (h) => h && isPrivateIpv4(String(h.ip)) && Number.isFinite(Number(h.port)) && Number(h.port) > 0,
    );
    for (const host of hosts) {
      const live = await probeBeacon(host.ip, Number(host.port));
      if (live) {
        return {
          agency: body.agency ?? null,
          hosts,
          server: { ip: host.ip, port: Number(host.port), name: host.name },
        };
      }
    }
    return { agency: body.agency ?? null, hosts, server: null };
  } catch {
    return empty;
  }
}

/**
 * Probe a user-supplied desktop IP (:3080 default) and pin it when it answers
 * the beacon. Returns true when pinned.
 */
export async function pinKioskLanBaseFromIp(ipInput: string): Promise<boolean> {
  const raw = String(ipInput || '').trim();
  const m = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (!m) return false;
  const ip = m[1];
  const port = m[2] ? parseInt(m[2], 10) : 3080;
  if (!isPrivateIpv4(ip) || port < 1 || port > 65535) return false;
  const live = await probeBeacon(ip, port);
  if (!live) return false;
  setKioskLanBase(`http://${ip}:${port}`);
  return true;
}
