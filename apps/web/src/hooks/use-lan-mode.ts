'use client';

import { useState, useEffect, useCallback } from 'react';
import { readSessionToken } from '@/lib/auth-storage';
import { getDeviceId } from '@/lib/device-fingerprint';
import {
  clearLanAuthority,
  getLanAuthoritySnapshot,
  joinMaster,
  markMasterContact,
} from '@/lib/lan-authority-client';
import { logEvent } from '@/lib/remote-logger';

interface LanServerInfo {
  ip: string;
  port: number;
  hostname?: string;
  webPort?: number;
  // 0.6.23 (R-21F-S2) — LAN-authority beacon fields (additive, optional).
  role?: string;
  term?: number;
  specScore?: number;
  instanceId?: string;
  lanAuthority?: boolean;
}

// ── Global singleton state (accessible from api-client.ts without React) ──
let globalLanServer: LanServerInfo | null = null;
let globalLanServerSetters: Array<(s: LanServerInfo | null) => void> = [];

export function getGlobalLanServer(): LanServerInfo | null {
  return globalLanServer;
}

export function setGlobalLanServer(server: LanServerInfo | null) {
  globalLanServer = server;
  globalLanServerSetters.forEach(setter => setter(server));
}

let globalIsLanMode = false;
let globalLanModeSetters: Array<(v: boolean) => void> = [];

export function getGlobalLanMode(): boolean {
  return globalIsLanMode;
}

export function setGlobalLanMode(val: boolean) {
  globalIsLanMode = val;
  globalLanModeSetters.forEach(setter => setter(val));
}

// ── 0.6.23 (R-21F-S2): LAN authority join flow ──────────────────────────────────

/** Caller scope read from the persisted zustand store ('blasti-app'). */
interface StoredSessionContext {
  agencyId: string | null;
  branchId: string | null;
  role: string | null;
}

/**
 * Read the logged-in user's agency/branch/role scope for the join call.
 * Staff branch info may live on user.branchId or user.staff.branchId —
 * pass what exists, null otherwise (the master validates the scope itself).
 */
function readStoredSessionUser(): StoredSessionContext {
  try {
    const raw = localStorage.getItem('blasti-app');
    if (!raw) return { agencyId: null, branchId: null, role: null };
    const parsed = JSON.parse(raw) as { state?: { user?: Record<string, unknown> | null } } | null;
    const user = parsed?.state?.user;
    if (!user || typeof user !== 'object') return { agencyId: null, branchId: null, role: null };
    const staff = (user as { staff?: { branchId?: unknown } }).staff;
    const branchId = typeof user.branchId === 'string'
      ? user.branchId
      : staff && typeof staff.branchId === 'string' ? staff.branchId : null;
    return {
      agencyId: typeof user.agencyId === 'string' ? user.agencyId : null,
      branchId,
      role: typeof user.role === 'string' ? user.role : null,
    };
  } catch {
    return { agencyId: null, branchId: null, role: null };
  }
}

/**
 * When a discovered beacon advertises `lanAuthority: true`, join that node
 * as a follower: cloud session token + stable device fingerprint → the
 * master mints a per-device lanToken and api-client repoints all traffic.
 *
 * Guard: only joins when NOT already joined to that master.instanceId.
 * NEVER throws — LAN failures must not break discovery.
 */
async function attemptLanAuthorityJoin(server: LanServerInfo): Promise<void> {
  try {
    if (typeof window === 'undefined' || server.lanAuthority !== true) return;

    // Guard: already joined to THIS master instance — just refresh contact.
    const snap = getLanAuthoritySnapshot();
    if (snap.active && server.instanceId && snap.master?.instanceId && snap.master.instanceId === server.instanceId) {
      markMasterContact();
      return;
    }

    const token = readSessionToken();
    if (!token) {
      logEvent('lan-join', `LAN master ${server.ip}:${server.port} discovered but no cloud session token — join deferred until login (instance ${server.instanceId ?? '?'}, term ${server.term ?? '?'})`, { ip: server.ip, port: server.port, instanceId: server.instanceId ?? null, term: server.term ?? null });
      return;
    }

    const { agencyId, branchId, role } = readStoredSessionUser();
    const fingerprint = await getDeviceId();
    const outcome = await joinMaster(
      {
        ip: server.ip,
        port: server.port,
        instanceId: server.instanceId ?? null,
        name: server.hostname ?? null,
        term: server.term ?? null,
      },
      { token, agencyId, branchId, role },
      fingerprint,
    );
    if (outcome.joined) {
      logEvent('lan-discovery', `join flow complete for ${server.ip}:${server.port} — API base override now points at the LAN master`, { ip: server.ip, port: server.port, instanceId: server.instanceId ?? null });
    }
  } catch {
    /* LAN join must never break discovery */
  }
}

// ── React hook ──
export function useLanMode() {
  const [lanServer, setLanServer] = useState<LanServerInfo | null>(globalLanServer);
  const [isUsingLan, setIsUsingLan] = useState(globalIsLanMode);
  const [isDiscovering, setIsDiscovering] = useState(false);

  // Sync hook state with global state
  useEffect(() => {
    globalLanServerSetters.push(setLanServer);
    globalLanModeSetters.push(setIsUsingLan);
    return () => {
      globalLanServerSetters = globalLanServerSetters.filter(s => s !== setLanServer);
      globalLanModeSetters = globalLanModeSetters.filter(s => s !== setIsUsingLan);
    };
  }, []);

  const isNative = useCallback(() => {
    return !!(window as any).electronAPI || !!(window as any).Capacitor;
  }, []);

  // Quick health check against a known server
  const healthCheck = useCallback(async (ip: string, port = 3080) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://${ip}:${port}/api/discover`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        // The desktop beacon answers service:'blasti-local'; accept both it
        // and the historic 'blasti-lan' so LAN-mode validation actually works
        // (only the Electron-IPC path succeeded before this).
        if (data.service === 'blasti-lan' || data.service === 'blasti-local') {
          // 0.6.23: carry the LAN-authority fields through for the join flow.
          return {
            ...(data as LanServerInfo & { name: string; version: string }),
            role: typeof data.role === 'string' ? data.role : undefined,
            term: typeof data.term === 'number' ? data.term : undefined,
            specScore: typeof data.specScore === 'number' ? data.specScore : undefined,
            instanceId: typeof data.instanceId === 'string' ? data.instanceId : undefined,
            lanAuthority: data.lanAuthority === true,
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  // Discovery strategy
  const discoverServer = useCallback(async () => {
    if (!isNative()) return null;

    setIsDiscovering(true);

    // 1. Try localhost (Electron desktop is the server itself)
    if ((window as any).electronAPI) {
      try {
        const info = await (window as any).electronAPI.getLanServerInfo();
        if (info?.ip && info.port) {
          setGlobalLanServer({ ip: info.ip, port: info.port, hostname: info.hostname });
          setIsDiscovering(false);
          return { ip: info.ip, port: info.port, hostname: info.hostname };
        }
      } catch {
        // getLanServerInfo may not be available yet
      }
    }

    // 2. Try cached server
    if (globalLanServer) {
      const cached = await healthCheck(globalLanServer.ip, globalLanServer.port);
      if (cached) {
        // 0.6.23: if the cached node advertises LAN authority, (re)join it.
        void attemptLanAuthorityJoin(cached);
        setIsDiscovering(false);
        return globalLanServer;
      }
    }

    // 3. Quick subnet scan (192.168.1.x and 192.168.0.x)
    const subnets = ['192.168.1', '192.168.0'];
    const promises: Promise<LanServerInfo | null>[] = [];

    for (const subnet of subnets) {
      for (const last of [1, 100, 101, 102, 105, 110, 115, 120]) {
        const ip = `${subnet}.${last}`;
        promises.push(
          healthCheck(ip).then(data => {
            if (data) {
              // 0.6.23: keep the LAN-authority beacon fields for the join flow.
              return {
                ip,
                port: data.port || 3080,
                hostname: data.hostname,
                role: data.role,
                term: data.term,
                specScore: data.specScore,
                instanceId: data.instanceId,
                lanAuthority: data.lanAuthority === true,
              };
            }
            return null;
          })
        );
      }
    }

    // Run in batches of 5
    for (let i = 0; i < promises.length; i += 5) {
      const batch = promises.slice(i, i + 5);
      const results = await Promise.all(batch);
      const found = results.find(r => r !== null);
      if (found) {
        setGlobalLanServer(found);
        // 0.6.23: a lanAuthority beacon triggers the follower join flow.
        void attemptLanAuthorityJoin(found);
        setIsDiscovering(false);
        return found;
      }
    }

    setIsDiscovering(false);
    return null;
  }, [isNative, healthCheck]);

  // Auto-discover on mount (native only)
  useEffect(() => {
    if (!isNative()) return;
    discoverServer();

    // Periodic health check every 30s — also re-discovers if server was lost
    const interval = setInterval(() => {
      if (globalLanServer) {
        healthCheck(globalLanServer.ip, globalLanServer.port).then(ok => {
          if (ok) {
            // 0.6.23: a live beacon refreshes the LAN-authority 30s contact window.
            markMasterContact();
          } else {
            // 0.6.23: master lost — wipe the join (logs lan-master-lost) and
            // re-discover; a new master may be found and re-joined below.
            if (getLanAuthoritySnapshot().active) {
              clearLanAuthority('master-unreachable');
            }
            setGlobalLanServer(null);
            // Re-discover — the LAN API may have restarted
            discoverServer();
          }
        });
      } else {
        // No server known — keep probing
        discoverServer();
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [isNative, discoverServer, healthCheck]);

  // Auto-switch LAN mode based on online status
  useEffect(() => {
    // BUG FIX: Don't unconditionally disable LAN mode on 'online' events.
    // The browser fires 'online' when ANY network interface is detected,
    // NOT when internet is actually available. On LAN with no internet,
    // this would disable LAN mode, preventing the local API failover.
    // Instead, let the cloud health check in connection-status.tsx handle
    // disabling LAN mode when the cloud is actually reachable.
    const handleOnline = () => {
 // no-op — cloud health check will clear LAN mode when appropriate
    };
    const handleOffline = () => {
      if (globalLanServer) setGlobalLanMode(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Notify Electron main process of online/offline events
    let onlineHandler: (() => void) | undefined;
    let offlineHandler: (() => void) | undefined;
    if ((window as any).electronAPI) {
      onlineHandler = () => (window as any).electronAPI.networkOnline?.();
      offlineHandler = () => (window as any).electronAPI.networkOffline?.();
      window.addEventListener('online', onlineHandler);
      window.addEventListener('offline', offlineHandler);
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (onlineHandler) window.removeEventListener('online', onlineHandler);
      if (offlineHandler) window.removeEventListener('offline', offlineHandler);
    };
  }, []);

  return {
    lanServer,
    isUsingLan,
    isDiscovering,
    discoverServer,
    refreshServer: discoverServer,
  };
}
