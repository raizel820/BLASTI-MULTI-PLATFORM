'use client';

/**
 * BLASTI LAN Authority Client (0.6.23, R-21F-S2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Client half of the offline LAN-authority feature. When the cloud/internet
 * is unreachable, one desktop on the office LAN is elected MASTER and its
 * local API (:3080) becomes the single source of truth. This module lets
 * every follower client (phone / tablet / kiosk / other desktop — the shared
 * web bundle) do three things:
 *
 *   1. JOIN — POST /api/lan/join with the user's CLOUD session token, the
 *      stable device fingerprint and scope (agency/branch). The master mints
 *      a per-device lanToken ("blan-<id>.<hmac>") that replaces the cloud
 *      Bearer for as long as the override is active (contract rule 3).
 *   2. REPOINT — expose the master's http://ip:port as the API base override
 *      (consumed by api-client.getApiBaseUrl / requestUncached) so ALL
 *      traffic hits the master while offline. A 409 { code:'NOT_MASTER',
 *      master } from any node instantly re-points via handleNotMasterBody().
 *   3. LOG — every decision emits a detailed logEvent() through the existing
 *      remote-logger pipeline (auto-POSTs buffered batches to /api/logs when
 *      back online) with concrete values (ip, port, term, specScore).
 *
 * Design constraints:
 *   - Module-scope code NEVER calls imported bindings (remote-logger imports
 *     buildCloudUrl from api-client which imports this module — a cycle; the
 *     logger's own buffer is in TDZ until its body finishes). safeLog()
 *     guards every log call, so a cycle can never break a LAN decision.
 *   - Never throws: every network call is wrapped, with 3s AbortController
 *     timeouts. Old desktops that lack the additive /api/discover fields make
 *     this module completely inert (nothing activates without lanAuthority).
 */

import { logEvent } from './remote-logger';
import type { DiscoveredServer } from './lan-discovery';

// ─── Types ───────────────────────────────────────────────────────────────────

export type LanAuthorityRole = 'MASTER' | 'FOLLOWER';

export type LanLogTag =
  | 'lan-discovery'
  | 'lan-join'
  | 'lan-repoint'
  | 'lan-master-lost'
  | 'lan-scope-reject'
  | 'lan-failover';

/** The master this client is joined to / pointed at. */
export interface LanMasterInfo {
  ip: string;
  port: number;
  instanceId?: string | null;
  name?: string | null;
  term?: number | null;
}

/** Shape of the `master` hint carried by a 409 NOT_MASTER body. */
export interface LanMasterHint {
  ip: string;
  port: number;
  instanceId?: string | null;
  name?: string | null;
  term?: number | null;
}

/** Minimal discovery shape joinMaster accepts (DiscoveredServer satisfies it). */
export interface LanJoinTarget {
  ip: string;
  port: number;
  instanceId?: string | null;
  name?: string | null;
  displayName?: string | null;
  hostname?: string | null;
  term?: number | null;
}

/** Persisted singleton state (localStorage key `blasti_lan_authority`). */
export interface LanAuthorityState {
  active: boolean;
  master: LanMasterInfo;
  lanToken: string | null;
  joinedAt: string | null;
  /** Date.now() of the last successful master contact (status probe / join). */
  lastMasterContactAt: number;
  /** ISO expiry minted by the master's /api/lan/join — null = no expiry known. */
  expiresAt: string | null;
  role: LanAuthorityRole | null;
}

/** Session material for the join call (cloud token + caller scope). */
export interface JoinSessionInfo {
  token: string;
  agencyId?: string | null;
  branchId?: string | null;
  role?: string | null;
  userId?: string | null;
}

export interface JoinOutcome {
  joined: boolean;
  reason?: string;
}

/** Read-only snapshot for UI surfaces (offline diagnosis panel). */
export interface LanStatusSnapshot {
  active: boolean;
  role: LanAuthorityRole | null;
  master: LanMasterInfo | null;
  lanTokenPresent: boolean;
  joinedAt: string | null;
  lastContactSeconds: number | null;
  expired: boolean;
}

export interface LanStatusProbeResult {
  ok: boolean;
  role?: string;
  term?: number;
  specScore?: number;
  instanceId?: string;
  deviceCount?: number;
  error?: string;
}

interface JoinResponseData {
  lanToken?: unknown;
  term?: unknown;
  expiresAt?: unknown;
  master?: { ip?: unknown; port?: unknown; instanceId?: unknown; name?: unknown };
}

interface StatusResponseData {
  role?: unknown;
  term?: unknown;
  specScore?: unknown;
  instanceId?: unknown;
  deviceCount?: unknown;
}

// ─── Constants + module state ────────────────────────────────────────────────

const STORAGE_KEY = 'blasti_lan_authority';
const MASTER_CONTACT_TTL_MS = 30_000; // override stays live 30s after last contact
const JOIN_TIMEOUT_MS = 3_000;
const STATUS_TIMEOUT_MS = 3_000;

let state: LanAuthorityState | null = null;
let restored = false;
/** Set by api-client when cloud requests fail with network errors. */
let cloudUnreachable = false;

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    const ls = safeLocalStorage();
    if (ls && state) ls.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota/private mode — memory state still works */ }
}

/**
 * Restore persisted state once, lazily, SILENTLY (no logging — module scope
 * and early-cycle calls must never touch remote-logger bindings).
 */
function ensureRestored(): void {
  if (restored) return;
  restored = true;
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<LanAuthorityState> | null;
    const master = parsed?.master;
    if (!parsed || !master || typeof master.ip !== 'string' || typeof master.port !== 'number') {
      ls.removeItem(STORAGE_KEY);
      return;
    }
    state = {
      active: parsed.active === true,
      master: {
        ip: master.ip,
        port: master.port,
        instanceId: typeof master.instanceId === 'string' ? master.instanceId : null,
        name: typeof master.name === 'string' ? master.name : null,
        term: typeof master.term === 'number' ? master.term : null,
      },
      lanToken: typeof parsed.lanToken === 'string' ? parsed.lanToken : null,
      joinedAt: typeof parsed.joinedAt === 'string' ? parsed.joinedAt : null,
      lastMasterContactAt: typeof parsed.lastMasterContactAt === 'number' ? parsed.lastMasterContactAt : 0,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
      role: parsed.role === 'MASTER' || parsed.role === 'FOLLOWER' ? parsed.role : null,
    };
  } catch {
    state = null;
  }
}

/** logEvent guarded — a TDZ/cycle or SSR condition must never break a decision. */
function safeLog(tag: LanLogTag, message: string, data?: Record<string, unknown>): void {
  try {
    logEvent(tag, message, data);
  } catch { /* logging must never break LAN failover */ }
}

function detectClientPlatform(): 'web' | 'mobile' | 'desktop' {
  if (typeof window === 'undefined') return 'web';
  try {
    const w = window as unknown as { Capacitor?: unknown; electronAPI?: unknown };
    if (w.Capacitor) return 'mobile';
    if (w.electronAPI || navigator.userAgent.includes('Electron')) return 'desktop';
  } catch { /* treat as plain web */ }
  return 'web';
}

function deviceNameLabel(): string {
  try {
    return navigator.userAgent.slice(0, 80) || 'unknown-device';
  } catch {
    return 'unknown-device';
  }
}

function isExpired(): boolean {
  if (!state?.expiresAt) return false;
  const t = Date.parse(state.expiresAt);
  return Number.isFinite(t) && Date.now() > t;
}

function hasFreshContact(): boolean {
  return !!state && state.active && Date.now() - state.lastMasterContactAt < MASTER_CONTACT_TTL_MS;
}

// ─── Cloud reachability signal (fed by api-client) ───────────────────────────

/**
 * api-client calls this from its markApiUnreachable/markApiReachable flags:
 * cloud network failures widen the override gate beyond the 30s contact TTL.
 */
export function setCloudUnreachable(unreachable: boolean): void {
  ensureRestored();
  if (cloudUnreachable === unreachable) return;
  cloudUnreachable = unreachable;
  safeLog('lan-failover', `cloud marked ${unreachable ? 'UNREACHABLE — LAN master override gate widened' : 'reachable — override gate back to 30s contact window'}`, { cloudUnreachable });
}

/** Record a successful master contact (join / status probe / discovery hit). */
export function markMasterContact(): void {
  ensureRestored();
  if (!state?.active) return;
  state.lastMasterContactAt = Date.now();
  persist();
}

// ─── Override gate (consumed by api-client) ──────────────────────────────────

/**
 * Non-null ONLY while joined AND (master contact within the last 30s OR the
 * cloud is flagged unreachable). When non-null, api-client routes every
 * request to `baseUrl` and authenticates with the per-device lanToken.
 */
export function getLanAuthorityOverride(): { baseUrl: string; master: LanMasterInfo } | null {
  ensureRestored();
  if (typeof window === 'undefined') return null;
  if (!state || !state.active) return null;
  if (isExpired()) {
    clearLanAuthority('join-expired');
    return null;
  }
  if (!hasFreshContact() && !cloudUnreachable) return null;
  return { baseUrl: `http://${state.master.ip}:${state.master.port}`, master: { ...state.master } };
}

/**
 * The per-device lanToken to use as Bearer while the override is active
 * (contract rule 3). Null when inactive — cloud auth flows resume unchanged.
 */
export function getLanAuthorityLanToken(): string | null {
  const override = getLanAuthorityOverride();
  if (!override) return null;
  const token = state?.lanToken;
  return typeof token === 'string' && token ? token : null;
}

/** Read-only snapshot for UI surfaces. */
export function getLanAuthoritySnapshot(): LanStatusSnapshot {
  ensureRestored();
  if (!state || !state.active) {
    return { active: false, role: null, master: null, lanTokenPresent: false, joinedAt: null, lastContactSeconds: null, expired: false };
  }
  return {
    active: true,
    role: state.role,
    master: { ...state.master },
    lanTokenPresent: !!state.lanToken,
    joinedAt: state.joinedAt,
    lastContactSeconds: state.lastMasterContactAt > 0 ? Math.round((Date.now() - state.lastMasterContactAt) / 1000) : null,
    expired: isExpired(),
  };
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Wipe all state and log the loss with the concrete master we had. */
export function clearLanAuthority(reason: string): void {
  ensureRestored();
  const prev = state;
  state = null;
  try {
    safeLocalStorage()?.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
  if (prev?.active) {
    safeLog('lan-master-lost', `cleared — ${reason} (was ${prev.master.name ?? 'master'} ${prev.master.ip}:${prev.master.port}, instance ${prev.master.instanceId ?? '?'}, term ${prev.master.term ?? '?'}, role ${prev.role ?? '?'})`, { reason, master: prev.master });
  }
}

/**
 * Activate the override from a 409 { code:'NOT_MASTER', master:{...} } hint
 * (contract rule 4): point every subsequent API call at the REAL master and
 * log the repoint. Invalid hints are logged and ignored.
 */
export function handleNotMasterResponse(master: LanMasterHint): void {
  ensureRestored();
  if (typeof window === 'undefined') return;
  if (!master || typeof master.ip !== 'string' || !master.ip || typeof master.port !== 'number' || !Number.isFinite(master.port)) {
    safeLog('lan-repoint', '409 NOT_MASTER carried no usable master hint — ignored', { master: master ?? null });
    return;
  }
  const sameNode = !!state?.active && (
    (master.instanceId && state.master.instanceId && master.instanceId === state.master.instanceId) ||
    (!master.instanceId && state.master.ip === master.ip && state.master.port === master.port)
  );
  if (state?.active && sameNode) {
    markMasterContact();
    return;
  }
  state = {
    active: true,
    master: {
      ip: master.ip,
      port: master.port,
      instanceId: master.instanceId ?? null,
      name: master.name ?? null,
      term: master.term ?? null,
    },
    lanToken: state?.active ? state.lanToken : null,
    joinedAt: state?.active ? state.joinedAt : null,
    lastMasterContactAt: Date.now(),
    expiresAt: state?.active ? state.expiresAt : null,
    role: 'FOLLOWER',
  };
  persist();
  safeLog('lan-repoint', `409 NOT_MASTER — API base repointed to ${master.name ?? 'master'} ${master.ip}:${master.port} (term ${master.term ?? '?'}, instance ${master.instanceId ?? '?'})`, { master: { ...state.master } });
}

/**
 * Validate a parsed 409 body and delegate to handleNotMasterResponse.
 * Accepts `unknown` so callers can hand it raw parsed JSON.
 */
export function handleNotMasterBody(body: unknown): void {
  try {
    if (!body || typeof body !== 'object') return;
    const rec = body as Record<string, unknown>;
    if (rec.code !== 'NOT_MASTER') return;
    const master = rec.master;
    if (!master || typeof master !== 'object') return;
    const m = master as Record<string, unknown>;
    if (typeof m.ip !== 'string' || typeof m.port !== 'number') return;
    handleNotMasterResponse({
      ip: m.ip,
      port: m.port,
      instanceId: typeof m.instanceId === 'string' ? m.instanceId : null,
      name: typeof m.name === 'string' ? m.name : null,
      term: typeof m.term === 'number' ? m.term : null,
    });
  } catch { /* never break the error path */ }
}

// ─── Join flow (contract rule 1) ─────────────────────────────────────────────

/**
 * POST /api/lan/join on the discovered node using raw fetch (NOT apiFetch —
 * this runs pre-repoint, before the override exists). Stores the minted
 * lanToken + master, logs everything, and NEVER throws.
 */
export async function joinMaster(
  discovered: LanJoinTarget,
  session: JoinSessionInfo,
  deviceFingerprint: string,
): Promise<JoinOutcome> {
  ensureRestored();
  if (typeof window === 'undefined') return { joined: false, reason: 'no-window' };
  const ip = discovered.ip;
  const port = discovered.port;
  if (!ip || typeof port !== 'number' || !Number.isFinite(port)) {
    return { joined: false, reason: 'bad-discovery' };
  }
  const masterInstanceId = discovered.instanceId ?? null;

  // Guard: already joined to THIS master with a live token — refresh contact.
  if (
    state?.active && state.lanToken && !isExpired() &&
    masterInstanceId && state.master.instanceId === masterInstanceId
  ) {
    markMasterContact();
    return { joined: true, reason: 'already-joined' };
  }

  const url = `http://${ip}:${port}/api/lan/join`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOIN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      body: JSON.stringify({
        sessionToken: session.token,
        agencyId: session.agencyId ?? null,
        branchId: session.branchId ?? null,
        role: session.role ?? null,
        deviceFingerprint,
        deviceName: deviceNameLabel(),
        platform: detectClientPlatform(),
      }),
      credentials: 'omit',
      signal: controller.signal,
    });

    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { data?: JoinResponseData } | null;
      const data = body?.data;
      if (
        !data || typeof data.lanToken !== 'string' || !data.lanToken ||
        !data.master || typeof data.master.ip !== 'string' || typeof data.master.port !== 'number'
      ) {
        safeLog('lan-join', `join accepted by ${ip}:${port} but payload incomplete — not stored`, { ip, port, status: res.status });
        return { joined: false, reason: 'bad-payload' };
      }
      state = {
        active: true,
        master: {
          ip: data.master.ip,
          port: data.master.port,
          instanceId: typeof data.master.instanceId === 'string' ? data.master.instanceId : masterInstanceId,
          name: typeof data.master.name === 'string' ? data.master.name : (discovered.displayName ?? discovered.hostname ?? discovered.name ?? null),
          term: typeof data.term === 'number' ? data.term : (discovered.term ?? null),
        },
        lanToken: data.lanToken,
        joinedAt: new Date().toISOString(),
        lastMasterContactAt: Date.now(),
        expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
        role: 'FOLLOWER',
      };
      persist();
      safeLog('lan-join', `joined master ${state.master.name ?? ''} ${state.master.ip}:${state.master.port} — term ${state.master.term ?? '?'}, instance ${state.master.instanceId ?? '?'}, expiresAt ${state.expiresAt ?? 'n/a'}, fingerprint ${deviceFingerprint.slice(0, 12)}…`, { master: { ...state.master }, term: state.master.term, expiresAt: state.expiresAt });
      return { joined: true };
    }

    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
      // LAN_SCOPE_MISMATCH — different agency/branch. Surface once, DO NOT retry.
      safeLog('lan-scope-reject', `join rejected 403 ${typeof body?.code === 'string' ? body.code : 'LAN_SCOPE_MISMATCH'} by ${ip}:${port} — agency/branch scope differs from master scope; not retrying${typeof body?.error === 'string' ? `: ${body.error}` : ''}`, { ip, port, code: typeof body?.code === 'string' ? body.code : null });
      return { joined: false, reason: 'scope-mismatch' };
    }

    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { master?: unknown } | null;
      if (body && typeof body === 'object' && body.master && typeof body.master === 'object') {
        handleNotMasterBody(body); // repoint to the hinted master + log
      } else {
        safeLog('lan-join', `join returned 409 NOT_MASTER without a master hint at ${ip}:${port}`, { ip, port });
      }
      return { joined: false, reason: 'not-master' };
    }

    if (res.status === 401) {
      safeLog('lan-join', `join rejected 401 by ${ip}:${port} — cloud session token invalid/expired`, { ip, port });
      return { joined: false, reason: 'unauthorized' };
    }

    safeLog('lan-join', `join failed with HTTP ${res.status} at ${ip}:${port}`, { ip, port, status: res.status });
    return { joined: false, reason: `http-${res.status}` };
  } catch (err) {
    safeLog('lan-join', `join unreachable at ${ip}:${port} — ${err instanceof Error ? err.message : 'network error'}`, { ip, port });
    return { joined: false, reason: 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Master status probe (GET /api/lan/status — no auth) ─────────────────────

/**
 * Re-probe the joined master's status (contract rule 2). On success refreshes
 * the 30s contact window and tracks role/term changes. Never throws.
 */
export async function probeLanMasterStatus(): Promise<LanStatusProbeResult> {
  ensureRestored();
  const override = getLanAuthorityOverride();
  if (!override) return { ok: false, error: 'not-active' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetch(`${override.baseUrl}/api/lan/status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) {
      safeLog('lan-failover', `master status probe HTTP ${res.status} at ${override.master.ip}:${override.master.port}`, { ip: override.master.ip, port: override.master.port, status: res.status });
      return { ok: false, error: `http-${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as { data?: StatusResponseData } | null;
    const data = body?.data;
    if (!data || typeof data !== 'object') {
      safeLog('lan-failover', `master status probe at ${override.master.ip}:${override.master.port} returned no data payload`, { ip: override.master.ip, port: override.master.port });
      return { ok: false, error: 'bad-payload' };
    }
    markMasterContact();
    if (state) {
      if (data.role === 'MASTER' || data.role === 'FOLLOWER') state.role = data.role;
      if (typeof data.term === 'number') state.master.term = data.term;
      if (typeof data.instanceId === 'string' && !state.master.instanceId) state.master.instanceId = data.instanceId;
      persist();
    }
    safeLog('lan-failover', `master status OK — role ${data.role ?? '?'}, term ${data.term ?? '?'}, specScore ${data.specScore ?? '?'}, devices ${data.deviceCount ?? '?'}, instance ${data.instanceId ?? '?'}`, { ip: override.master.ip, port: override.master.port, role: data.role ?? null, term: data.term ?? null, specScore: data.specScore ?? null, deviceCount: data.deviceCount ?? null });
    return {
      ok: true,
      role: typeof data.role === 'string' ? data.role : undefined,
      term: typeof data.term === 'number' ? data.term : undefined,
      specScore: typeof data.specScore === 'number' ? data.specScore : undefined,
      instanceId: typeof data.instanceId === 'string' ? data.instanceId : undefined,
      deviceCount: typeof data.deviceCount === 'number' ? data.deviceCount : undefined,
    };
  } catch (err) {
    safeLog('lan-failover', `master status probe failed at ${override.master.ip}:${override.master.port} — ${err instanceof Error ? err.message : 'network error'}`, { ip: override.master.ip, port: override.master.port });
    return { ok: false, error: 'network-error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Type guard helper used by discovery consumers: true when the beacon
 * advertises LAN authority with an actionable role.
 */
export function isLanAuthorityBeacon(server: Pick<DiscoveredServer, 'lanAuthority' | 'role'>): boolean {
  return server.lanAuthority === true && (server.role === 'MASTER' || server.role === 'FOLLOWER');
}
