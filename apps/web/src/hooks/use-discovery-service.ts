'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import {
  type ScanState,
  type RealDiscoveredDevice,
  type ProtocolStatus,
  type Diagnostics,
  DEFAULT_SCAN_STATE,
} from '@/components/agency/devices/types';

const API_Q = 'XTransformPort=3003';
const POLL_INTERVAL = 3000;
const SLOW_POLL_INTERVAL = 30000;
const AUTO_SCAN_INTERVAL = 30000;

interface DiscoveryServiceReturn {
  scanState: ScanState;
  discoveredDevices: RealDiscoveredDevice[];
  serviceAvailable: boolean;
  protocols: ProtocolStatus[];
  diagnostics: Diagnostics | null;
  startScan: () => Promise<void>;
  stopScan: () => Promise<void>;
}

export function useDiscoveryService(agencyId: string | undefined): DiscoveryServiceReturn {
  const [scanState, setScanState] = useState<ScanState>(DEFAULT_SCAN_STATE);
  const [discoveredDevices, setDiscoveredDevices] = useState<RealDiscoveredDevice[]>([]);
  const [autoScanEnabled, setAutoScanEnabled] = useState(false);
  const [serviceAvailable, setServiceAvailable] = useState(false);
  const [protocols, setProtocols] = useState<ProtocolStatus[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const autoScanTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const mountedRef = useRef(true);

  // Health check — proxy through API
  const checkHealth = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/health?${API_Q}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'ok' && mountedRef.current) {
          setServiceAvailable(true);
          return;
        }
      }
      if (mountedRef.current) setServiceAvailable(false);
    } catch {
      if (mountedRef.current) setServiceAvailable(false);
    }
  }, []);

  // Poll discovered devices — proxy through API
  const pollDevices = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/devices?${API_Q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.devices && Array.isArray(data.devices) && mountedRef.current) {
        const devices: RealDiscoveredDevice[] = data.devices.map((d: Record<string, unknown>) => ({
          id: String(d.id ?? ''),
          source: (d.source as RealDiscoveredDevice['source']) ?? 'database',
          category: (d.category as RealDiscoveredDevice['category']) ?? 'NETWORK',
          type: (d.type as RealDiscoveredDevice['type']) ?? 'UNKNOWN',
          name: String(d.name ?? d.ip ?? 'Unknown'),
          nameAr: d.nameAr ? String(d.nameAr) : undefined,
          nameFr: d.nameFr ? String(d.nameFr) : undefined,
          ip: String(d.ip ?? ''),
          port: Number(d.port ?? 0),
          mac: d.mac ? String(d.mac) : undefined,
          model: d.model ? String(d.model) : undefined,
          manufacturer: d.manufacturer ? String(d.manufacturer) : undefined,
          appVersion: d.appVersion ? String(d.appVersion) : undefined,
          fingerprint: d.fingerprint ? String(d.fingerprint) : undefined,
          capabilities: Array.isArray(d.capabilities) ? d.capabilities.map(String) : [],
          status: d.status === 'ONLINE' ? 'ONLINE' as const : 'STALE' as const,
          lastSeen: typeof d.lastSeen === 'number' ? d.lastSeen : Date.now(),
          firstSeen: typeof d.firstSeen === 'number' ? d.firstSeen : Date.now(),
          connectionType: (['LAN', 'WIFI', 'USB', 'UNKNOWN'].includes(d.connectionType as string)
            ? d.connectionType as RealDiscoveredDevice['connectionType']
            : 'UNKNOWN') as RealDiscoveredDevice['connectionType'],
          ssdpLocation: d.ssdpLocation ? String(d.ssdpLocation) : undefined,
          httpUrl: d.httpUrl ? String(d.httpUrl) : undefined,
          httpTitle: d.httpTitle ? String(d.httpTitle) : undefined,
          httpServer: d.httpServer ? String(d.httpServer) : undefined,
          httpStatus: typeof d.httpStatus === 'number' ? d.httpStatus : undefined,
          ssdpServer: d.ssdpServer ? String(d.ssdpServer) : undefined,
          ssdpSt: d.ssdpSt ? String(d.ssdpSt) : undefined,
          mdnsService: d.mdnsService ? String(d.mdnsService) : undefined,
          usbVendorId: d.usbVendorId ? String(d.usbVendorId) : undefined,
          usbProductId: d.usbProductId ? String(d.usbProductId) : undefined,
          cupsUri: d.cupsUri ? String(d.cupsUri) : undefined,
          cupsName: d.cupsName ? String(d.cupsName) : undefined,
          cupsState: d.cupsState ? String(d.cupsState) : undefined,
          usbBusDevice: d.usbBusDevice ? String(d.usbBusDevice) : undefined,
          macVendor: d.macVendor ? String(d.macVendor) : undefined,
        }));
        setDiscoveredDevices(devices);
      }
    } catch {
      // Silent — discovery service may not be running
    }
  }, []);

  // Poll scan status — proxy through API
  const pollScanStatus = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/scan/status?${API_Q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        let wasScanning = false;
        setScanState((prev) => {
          wasScanning = prev.scanning;
          return {
            ...prev,
            scanning: data.scanning ?? false,
            scanId: data.scanId ?? prev.scanId,
            totalIPs: data.totalIPs ?? prev.totalIPs,
            scannedIPs: data.scannedIPs ?? prev.scannedIPs,
            currentSubnet: data.currentSubnet ?? prev.currentSubnet,
            phase: data.phase ?? (data.scanning ? prev.phase : 'idle'),
            devicesFound: data.devicesFound ?? prev.devicesFound,
            subnets: Array.isArray(data.subnets) ? data.subnets : prev.subnets,
            protocolsUsed: Array.isArray(data.protocolsUsed) ? data.protocolsUsed : prev.protocolsUsed,
            elapsed: typeof data.elapsed === 'number' ? data.elapsed : prev.elapsed,
          };
        });

        // If scan completed, stop status polling
        if (!data.scanning && wasScanning) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = undefined;
          }
          // Final device poll
          await pollDevices();
        }
      }
    } catch {
      // Silent
    }
  }, [pollDevices]);

  // Poll protocols (less frequent — every 30s) — proxy through API
  const pollProtocols = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/protocols?${API_Q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.protocols && Array.isArray(data.protocols) && mountedRef.current) {
        setProtocols(data.protocols);
      }
    } catch {
      // Silent
    }
  }, []);

  // Poll diagnostics (less frequent — every 30s) — proxy through API
  const pollDiagnostics = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/diagnostics?${API_Q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (mountedRef.current) {
        setDiagnostics(data);
      }
    } catch {
      // Silent
    }
  }, []);

  // Start scan — proxy through API
  const startScan = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/agency-devices/discovery/scan/start?${API_Q}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (res.ok) {
        const data = await res.json();
        if (mountedRef.current) {
          setScanState({
            scanning: true,
            scanId: data.scanId ?? null,
            totalIPs: data.totalIPs ?? 254,
            scannedIPs: 0,
            currentSubnet: '',
            phase: 'arp',
            devicesFound: 0,
            subnets: Array.isArray(data.subnets) ? data.subnets : [],
            protocolsUsed: [],
            elapsed: 0,
          });
        }
        // Start polling
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        pollTimerRef.current = setInterval(() => {
          pollScanStatus();
          pollDevices();
        }, POLL_INTERVAL);
        // Immediate first poll
        pollDevices();
      }
    } catch {
      // Discovery service may not be available
    }
  }, [pollScanStatus, pollDevices]);

  // Stop scan — proxy through API
  const stopScan = useCallback(async () => {
    try {
      await apiFetch(`/api/agency-devices/discovery/scan/stop?${API_Q}`, {
        method: 'POST',
      });
    } catch {
      // Silent
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
    if (mountedRef.current) {
      setScanState(DEFAULT_SCAN_STATE);
    }
  }, []);

  // Auto-scan effect
  useEffect(() => {
    if (autoScanEnabled && serviceAvailable) {
      startScan();
      autoScanTimerRef.current = setInterval(() => {
        startScan();
      }, AUTO_SCAN_INTERVAL);
    } else {
      if (autoScanTimerRef.current) {
        clearInterval(autoScanTimerRef.current);
        autoScanTimerRef.current = undefined;
      }
    }
    return () => {
      if (autoScanTimerRef.current) {
        clearInterval(autoScanTimerRef.current);
        autoScanTimerRef.current = undefined;
      }
    };
  }, [autoScanEnabled, serviceAvailable, startScan]);

  // Initial health check + periodic
  useEffect(() => {
    checkHealth();
    const id = setInterval(checkHealth, 15000);
    return () => clearInterval(id);
  }, [checkHealth]);

  // Periodic protocols + diagnostics polling (slower)
  useEffect(() => {
    if (!serviceAvailable) return;
    // Initial poll
    pollProtocols();
    pollDiagnostics();
    const id = setInterval(() => {
      pollProtocols();
      pollDiagnostics();
    }, SLOW_POLL_INTERVAL);
    return () => clearInterval(id);
  }, [serviceAvailable, pollProtocols, pollDiagnostics]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (autoScanTimerRef.current) clearInterval(autoScanTimerRef.current);
    };
  }, []);

  return {
    scanState,
    discoveredDevices,
    serviceAvailable,
    protocols,
    diagnostics,
    startScan,
    stopScan,
  };
}

export function useDiscoveryAutoScan() {
  const [enabled, setEnabled] = useState(false);
  return { autoScanEnabled: enabled, setAutoScanEnabled: setEnabled };
}