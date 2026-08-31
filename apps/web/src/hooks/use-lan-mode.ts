'use client';

import { useState, useEffect, useCallback } from 'react';

interface LanServerInfo {
  ip: string;
  port: number;
  hostname?: string;
  webPort?: number;
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
        if (data.service === 'blasti-lan') {
          return data as LanServerInfo & { name: string; version: string };
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
            if (data) return { ip, port: data.port || 3080, hostname: data.hostname };
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
          if (!ok) {
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
