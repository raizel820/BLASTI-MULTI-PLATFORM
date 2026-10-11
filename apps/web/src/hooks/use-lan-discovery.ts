/**
 * useLanDiscovery — React hook for BLASTI LAN server auto-discovery
 *
 * Automatically discovers BLASTI desktop servers on the local network
 * and switches the API client to use the LAN server when found.
 *
 * Usage:
 *   const { server, status, scan, connectToServer } = useLanDiscovery()
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  discoverLanServer,
  quickDiscover,
  onDiscoveryStateChange,
  clearCache,
  getLanApiUrl,
  type DiscoveredServer,
  type DiscoveryState,
} from '@/lib/lan-discovery';
import { apiClient } from '@/lib/api-client';

export type { DiscoveredServer };

export interface UseLanDiscoveryReturn {
  /** Current discovery status */
  status: 'idle' | 'scanning' | 'found' | 'failed';
  /** The discovered server, if any */
  server: DiscoveredServer | null;
  /** Number of IPs scanned so far */
  scannedCount: number;
  /** Total IPs to scan */
  totalToScan: number;
  /** Whether currently connected to a LAN server */
  isConnectedToLan: boolean;
  /** The URL of the connected LAN server (or null) */
  lanApiUrl: string | null;
  /** Trigger a quick scan (localhost + current subnet only) */
  quickScan: () => Promise<DiscoveredServer | null>;
  /** Trigger a full LAN scan (all subnets) */
  fullScan: () => Promise<DiscoveredServer | null>;
  /** Manually connect to a discovered server */
  connectToServer: (server: DiscoveredServer) => void;
  /** Disconnect from the LAN server and return to cloud mode */
  disconnect: () => void;
  /** Clear the discovery cache */
  clearDiscoveryCache: () => void;
}

const LAN_API_URL_KEY = 'blasti_lan_api_url';

/** Read a previously-saved LAN URL from localStorage (SSR-safe). */
function readSavedLanUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(LAN_API_URL_KEY);
  } catch {
    return null;
  }
}

export function useLanDiscovery(autoScan = false): UseLanDiscoveryReturn {
  const [state, setState] = useState<DiscoveryState>({
    status: 'idle',
    server: null,
    scannedCount: 0,
    totalToScan: 0,
  });

  const previousBaseUrl = useRef<string | null>(null);

  // Restore LAN connection state from localStorage via lazy initializer
  // We do NOT access the ref here — we set it up in a mount effect below.
  const [lanApiUrl, setLanApiUrl] = useState<string | null>(() => readSavedLanUrl());
  const [isConnectedToLan, setIsConnectedToLan] = useState(() => lanApiUrl !== null);

  // On mount, apply the saved URL to the apiClient and save the previous base URL
  useEffect(() => {
    if (lanApiUrl) {
      previousBaseUrl.current = apiClient.getBaseUrl();
      apiClient.setBaseUrl(lanApiUrl);
    }
  }, [lanApiUrl]);

  // Subscribe to discovery state changes
  useEffect(() => {
    const unsubscribe = onDiscoveryStateChange(setState);
    return unsubscribe;
  }, []);

  // Auto-scan on mount if requested
  useEffect(() => {
    if (autoScan && !isConnectedToLan) {
      quickDiscover().then((server) => {
        if (server) {
          setState({ status: 'found', server, scannedCount: 0, totalToScan: 0 });
        }
      });
    }
  }, [autoScan, isConnectedToLan]);

  const quickScan = useCallback(async (): Promise<DiscoveredServer | null> => {
    const server = await quickDiscover();
    if (server) {
      setState({ status: 'found', server, scannedCount: 0, totalToScan: 0 });
    } else {
      setState({ status: 'failed', server: null, scannedCount: 0, totalToScan: 0 });
    }
    return server;
  }, []);

  const fullScan = useCallback(async (): Promise<DiscoveredServer | null> => {
    const server = await discoverLanServer({
      skipCache: true,
      onProgress: setState,
    });
    return server;
  }, []);

  const connectToServer = useCallback((server: DiscoveredServer) => {
    const url = getLanApiUrl(server);
    if (!previousBaseUrl.current) {
      previousBaseUrl.current = apiClient.getBaseUrl();
    }
    apiClient.setBaseUrl(url);
    setLanApiUrl(url);
    setIsConnectedToLan(true);

    // Persist the LAN API URL
    try {
      localStorage.setItem(LAN_API_URL_KEY, url);
    } catch {
      // ignore
    }

    console.log(`[LAN Discovery] Connected to ${server.name} at ${url}`);
  }, []);

  const disconnect = useCallback(() => {
    if (previousBaseUrl.current) {
      apiClient.setBaseUrl(previousBaseUrl.current);
      previousBaseUrl.current = null;
    }
    setLanApiUrl(null);
    setIsConnectedToLan(false);

    try {
      localStorage.removeItem(LAN_API_URL_KEY);
    } catch {
      // ignore
    }

    console.log('[LAN Discovery] Disconnected from LAN server');
  }, []);

  const clearDiscoveryCache = useCallback(() => {
    clearCache();
    setState({ status: 'idle', server: null, scannedCount: 0, totalToScan: 0 });
  }, []);

  return {
    status: state.status,
    server: state.server,
    scannedCount: state.scannedCount,
    totalToScan: state.totalToScan,
    isConnectedToLan,
    lanApiUrl,
    quickScan,
    fullScan,
    connectToServer,
    disconnect,
    clearDiscoveryCache,
  };
}
