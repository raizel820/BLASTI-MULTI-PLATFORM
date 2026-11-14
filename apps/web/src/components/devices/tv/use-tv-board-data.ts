'use client';

/**
 * Shared data hook for the BLASTI TV screens (0.6.74).
 * ─────────────────────────────────────────────────────────────────────────
 * Extracted from the historic rich board so the four new simple designs
 * (classic / counters / focus / minimal) share ONE identity, registration,
 * polling, realtime and heartbeat implementation:
 *
 *  - Identity:  prop > ?agencyId= > ?code= > localStorage (blasti_tv_*)
 *  - Register:  POST /api/agency-devices/public/register  (deviceType 'TV')
 *  - Data:      GET  /api/agency-devices/public/queue-status (5s poll)
 *               + realtime queue:* / kiosk:* events (250ms debounce)
 *  - Lifecycle: POST /device/heartbeat every 30s, remote commands handled
 *               (FORCE_DISCONNECT / REBOOT / REFRESH / CONFIG_UPDATE)
 *  - Config:    GET /device/config → displaySettings (merged with ?ds_*)
 *  - LAN:       quickDiscover() finds the branch master PC for offline mode
 *
 * Works identically against the cloud API and the desktop local API
 * (device-board-routes.js serves the same shapes on :3080 offline).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRealtime } from '@/hooks/use-realtime';
import { apiFetch } from '@/lib/api-fetch';
import { APP_VERSION } from '@/lib/version';
import { quickDiscover, type DiscoveredServer } from '@/lib/lan-discovery';
import { getCachedLocalIp } from '@/lib/get-local-ip';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TvCounterTicket {
  id: string;
  ticketNumber: string;
  status: string;
  calledAt: string | null;
  serviceName: string;
  serviceNameAr?: string | null;
  serviceNameFr?: string | null;
  servicePrefix: string;
}

export interface TvCounter {
  id: string;
  number: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  claimedAt?: string | null;
  ticket: TvCounterTicket | null;
}

export interface TvCurrentlyServing {
  id: string;
  ticketNumber: string;
  serviceName: string;
  status: string;
  calledAt: string | null;
  counterName?: string | null;
}

export interface TvQueueStatus {
  agency: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    logoUrl?: string | null;
    isQueueOpen: boolean;
    isPaused: boolean;
  };
  currentlyServing: TvCurrentlyServing[];
  counters?: TvCounter[];
  avgServiceTimeSec?: number | null;
  totalServedToday?: number;
  totalWaiting: number;
  recentCalls?: Array<{
    id: string;
    ticketNumber: string;
    status: string;
    calledAt: string | null;
    counterName?: string | null;
  }>;
}

export interface TvDisplayConfig {
  fontSize?: 'sm' | 'md' | 'lg' | 'xl';
  theme?: 'dark' | 'light' | 'auto';
  language?: 'ar' | 'fr' | 'en';
  showClock?: boolean;
  showLogo?: boolean;
  rotationSec?: number;
  serviceFilter?: string[];
}

export type TvScreenLayout = 'TV_CLASSIC' | 'TV_COUNTERS' | 'TV_FOCUS' | 'TV_MINIMAL';

const POLL_INTERVAL_MS = 5_000;
const FRESH_WINDOW_MS = 15_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function generateTvFingerprint(): string {
  if (typeof window === 'undefined') return 'server-tv';
  try {
    const nav = navigator as { userAgent?: string; language?: string; platform?: string };
    const ua = nav.userAgent || '';
    const lang = nav.language || '';
    const platform = nav.platform || '';
    const screen = `${window.screen.width}x${window.screen.height}x${window.screen.colorDepth}`;
    const raw = `${ua}|${lang}|${platform}|${screen}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const chr = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return 'tv_' + Math.abs(hash).toString(16);
  } catch {
    return 'tv_fallback_' + Date.now();
  }
}

/** Parse display settings delivered via ?ds_* URL params (agency preview links). */
export function parseTvDisplaySettingsFromUrl(): TvDisplayConfig {
  if (typeof window === 'undefined') return {};
  try {
    const params = new URLSearchParams(window.location.search);
    const cfg: TvDisplayConfig = {};
    const str = (k: string) => params.get(`ds_${k}`) ?? undefined;
    const bool = (k: string) => {
      const raw = params.get(`ds_${k}`);
      return raw === null ? undefined : raw === 'true' || raw === '1';
    };
    const fontSize = str('fontSize');
    if (fontSize === 'sm' || fontSize === 'md' || fontSize === 'lg' || fontSize === 'xl') cfg.fontSize = fontSize;
    const theme = str('theme');
    if (theme === 'dark' || theme === 'light' || theme === 'auto') cfg.theme = theme;
    const lang = str('language');
    if (lang === 'ar' || lang === 'fr' || lang === 'en') cfg.language = lang;
    const showClock = bool('showClock');
    if (showClock !== undefined) cfg.showClock = showClock;
    const showLogo = bool('showLogo');
    if (showLogo !== undefined) cfg.showLogo = showLogo;
    const rotationSecRaw = params.get('ds_rotationSec');
    if (rotationSecRaw !== null) {
      const n = Number(rotationSecRaw);
      if (Number.isFinite(n)) cfg.rotationSec = n;
    }
    const filterRaw = str('serviceFilter');
    if (filterRaw) {
      try {
        const parsed = JSON.parse(filterRaw);
        if (Array.isArray(parsed)) cfg.serviceFilter = parsed.filter((x) => typeof x === 'string');
      } catch {
        const list = filterRaw.split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) cfg.serviceFilter = list;
      }
    }
    return cfg;
  } catch {
    return {};
  }
}

/** Format seconds as a compact duration label, e.g. "4 min" / "1 h 05". */
export function formatDurationSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return '—';
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

/**
 * Localized duration for TV footers — Arabic gets Arabic unit letters so the
 * value never mixes LTR units ("21 s") into an RTL sentence (bidi garbling).
 */
export function formatTvDuration(sec: number | null | undefined, lang: string): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return '—';
  if (lang === 'ar') {
    if (sec < 60) return `${sec} ث`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} د`;
    return `${Math.floor(min / 60)} س ${String(min % 60).padStart(2, '0')} د`;
  }
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

export function formatTvClock(date: Date, lang: string): string {
  try {
    return date.toLocaleTimeString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { hour: '2-digit', minute: '2-digit' },
    );
  } catch {
    return date.toLocaleTimeString();
  }
}

export function formatTvClockWithSeconds(date: Date, lang: string): string {
  try {
    return date.toLocaleTimeString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { hour: '2-digit', minute: '2-digit', second: '2-digit' },
    );
  } catch {
    return date.toLocaleTimeString();
  }
}

export function formatTvDate(date: Date, lang: string): string {
  try {
    return date.toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
    );
  } catch {
    return date.toLocaleDateString();
  }
}

/** Elapsed seconds since a timestamp (for live "serving since" counters). */
export function elapsedSecSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseTvBoardDataOptions {
  agencyId?: string;
  /** When false, skip LAN discovery (manager preview iframes). */
  discoverLan?: boolean;
  /**
   * Gate for device auto-registration. The shell keeps it false while the
   * rich board is the active renderer (it performs its own registration) —
   * prevents the double-register race that created duplicate devices.
   */
  registerEnabled?: boolean;
}

// ─── Registration dedupe (module scope — survives StrictMode remounts) ────
// registerWith can fire twice within milliseconds (React StrictMode effect
// double-run, prop/URL resolution overlap). Both calls race the server's
// findFirst-and-create and produce DUPLICATE devices. A module-level
// per-agency cooldown closes that window.
const recentTvRegisters = new Map<string, number>();
const TV_REGISTER_DEDUPE_MS = 15_000;

function shouldSkipTvRegister(agencyKey: string): boolean {
  const last = recentTvRegisters.get(agencyKey);
  if (last && Date.now() - last < TV_REGISTER_DEDUPE_MS) return true;
  recentTvRegisters.set(agencyKey, Date.now());
  return false;
}

export function useTvBoardData({ agencyId: agencyIdProp, discoverLan = true, registerEnabled = true }: UseTvBoardDataOptions = {}) {
  const realtime = useRealtime();

  const [resolvedAgencyId, setResolvedAgencyId] = useState('');
  const [status, setStatus] = useState<TvQueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [lastSuccessAt, setLastSuccessAt] = useState(0);
  const [currentTime, setCurrentTime] = useState(() => new Date());

  const [deviceToken, setDeviceToken] = useState<string>('');
  const [serverDisplaySettings, setServerDisplaySettings] = useState<TvDisplayConfig>({});
  const urlDisplaySettings = useMemo(() => parseTvDisplaySettingsFromUrl(), []);
  const displaySettings = useMemo(
    () => ({ ...serverDisplaySettings, ...urlDisplaySettings }),
    [serverDisplaySettings, urlDisplaySettings],
  );

  const [lanServer, setLanServer] = useState<DiscoveredServer | null>(null);

  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevServingIdsRef = useRef<Set<string>>(new Set());
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());

  const agencyId = resolvedAgencyId || agencyIdProp || '';

  // Hydrate stored credentials once on mount.
  useEffect(() => {
    try {
      const token = localStorage.getItem('blasti_tv_device_token') || '';
      if (token) setDeviceToken(token);
    } catch { /* private mode */ }
  }, []);

  // ─── LAN discovery (finds the branch master PC for offline operation) ────
  useEffect(() => {
    if (!discoverLan) return;
    let mounted = true;
    (async () => {
      try {
        const server = await quickDiscover();
        if (mounted && server) setLanServer(server);
      } catch { /* cloud fallback */ }
    })();
    return () => { mounted = false; };
  }, [discoverLan]);

  // ─── Fullscreen is owned by the screen shell (see device-tv-board.tsx) ───

  const isDeviceMode = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'device' && params.get('type') === 'TV';
  }, []);

  // ─── Identity resolution + registration ──────────────────────────────────
  useEffect(() => {
    if (agencyIdProp) {
      setResolvedAgencyId(agencyIdProp);
      return;
    }
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const urlAgencyId = params.get('agencyId');
    const code = params.get('code');
    const lsAgencyId = localStorage.getItem('blasti_tv_agency_id');
    const lsCode = localStorage.getItem('blasti_tv_agency_code');

    const registerWith = async (id: string, agencyCode: string) => {
      if (!registerEnabled) return;
      if (shouldSkipTvRegister(id)) return;
      try {
        const savedId = localStorage.getItem('blasti_tv_device_id');
        const savedAgency = localStorage.getItem('blasti_tv_registered_agency_id');
        if (savedId && savedAgency === id && localStorage.getItem('blasti_tv_device_token')) return;
        const regRes = await apiFetch('/api/agency-devices/public/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agencyCode,
            deviceName: 'BLASTI TV Board',
            deviceType: 'TV',
            connectionType: lanServer ? 'LAN' : 'WIFI',
            deviceFingerprint: generateTvFingerprint(),
          }),
        });
        const regData = await regRes.json();
        if (regData.success && regData.deviceToken) {
          localStorage.setItem('blasti_tv_device_token', regData.deviceToken);
          localStorage.setItem('blasti_tv_device_id', regData.device.id);
          localStorage.setItem('blasti_tv_registered_agency_id', id);
          setDeviceToken(regData.deviceToken);
        }
      } catch { /* registration is best-effort */ }
    };

    if (urlAgencyId) {
      setResolvedAgencyId(urlAgencyId);
      localStorage.setItem('blasti_tv_agency_id', urlAgencyId);
      apiFetch(`/api/agencies/${urlAgencyId}`)
        .then((r) => r.json())
        .then((data) => {
          const agencyCode = data?.customCode || urlAgencyId;
          localStorage.setItem('blasti_tv_agency_code', agencyCode);
          return registerWith(urlAgencyId, agencyCode);
        })
        .catch(() => registerWith(urlAgencyId, urlAgencyId));
    } else if (code) {
      localStorage.setItem('blasti_tv_agency_code', code);
      apiFetch(`/api/agency-devices/public/agency?code=${encodeURIComponent(code)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.success && data.agency?.id) {
            setResolvedAgencyId(data.agency.id);
            localStorage.setItem('blasti_tv_agency_id', data.agency.id);
            return registerWith(data.agency.id, code);
          }
        })
        .catch(() => {});
    } else if (lsAgencyId) {
      setResolvedAgencyId(lsAgencyId);
    } else if (lsCode) {
      apiFetch(`/api/agency-devices/public/agency?code=${encodeURIComponent(lsCode)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.success && data.agency?.id) {
            setResolvedAgencyId(data.agency.id);
            localStorage.setItem('blasti_tv_agency_id', data.agency.id);
            return registerWith(data.agency.id, lsCode);
          }
        })
        .catch(() => {});
    }
  }, [agencyIdProp, registerEnabled]);

  // ─── Clock tick (1s — drives "serving since" timers + freshness) ────────
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // ─── Heartbeat + remote commands ─────────────────────────────────────────
  const clearDeviceCredentials = useCallback(() => {
    try {
      localStorage.removeItem('blasti_tv_device_token');
      localStorage.removeItem('blasti_tv_device_id');
      localStorage.removeItem('blasti_tv_registered_agency_id');
    } catch { /* private mode */ }
    setDeviceToken('');
  }, []);

  const fetchDeviceConfigRef = useRef<() => void>(() => {});

  const startDeviceHeartbeat = useCallback((token: string) => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);

    const ackCommand = async (cmdId: string) => {
      try {
        await apiFetch(`/api/agency-devices/device/command/${cmdId}/ack`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ status: 'DELIVERED' }),
        });
      } catch { /* best-effort */ }
    };

    const sendHeartbeat = async () => {
      try {
        const res = await apiFetch('/api/agency-devices/device/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            appVersion: APP_VERSION,
            ipAddress: getCachedLocalIp() || lanServer?.ip || undefined,
          }),
        });
        if (res.status === 401) {
          if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
          clearDeviceCredentials();
          return;
        }
        if (res.ok) {
          const body = await res.json().catch(() => null);
          const commands: Array<{ id: string; type: string }> = body?.pendingCommands ?? [];
          for (const cmd of commands) {
            if (cmd.type === 'FORCE_DISCONNECT') {
              await ackCommand(cmd.id);
              if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
              clearDeviceCredentials();
              window.location.reload();
              return;
            }
            if (cmd.type === 'REBOOT' || cmd.type === 'REFRESH') {
              await ackCommand(cmd.id);
              window.location.reload();
              return;
            }
            if (cmd.type === 'CONFIG_UPDATE') {
              await ackCommand(cmd.id);
              fetchDeviceConfigRef.current();
              continue;
            }
            await ackCommand(cmd.id);
          }
        }
      } catch { /* silent */ }
    };

    sendHeartbeat();
    heartbeatTimerRef.current = setInterval(sendHeartbeat, 30_000);
  }, [lanServer, clearDeviceCredentials]);

  useEffect(() => {
    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    };
  }, []);

  const fetchDeviceConfig = useCallback(() => {
    if (!deviceToken) return;
    apiFetch('/api/agency-devices/device/config', {
      headers: { 'Authorization': `Bearer ${deviceToken}` },
    })
      .then((res) => {
        if (res.status === 401) {
          setDeviceToken('');
          if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
          try {
            localStorage.removeItem('blasti_tv_device_token');
            localStorage.removeItem('blasti_tv_device_id');
          } catch { /* private mode */ }
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        if (data.success && data.config) {
          try {
            const parsed = typeof data.config.displaySettings === 'string'
              ? JSON.parse(data.config.displaySettings || '{}')
              : data.config.displaySettings || {};
            setServerDisplaySettings(parsed);
          } catch { /* invalid JSON — defaults */ }
          if (!resolvedAgencyId && data.config.agency?.id) {
            setResolvedAgencyId(data.config.agency.id);
            try { localStorage.setItem('blasti_tv_agency_id', data.config.agency.id); } catch { /* ignore */ }
          }
        }
      })
      .catch(() => {});
  }, [deviceToken, resolvedAgencyId]);

  useEffect(() => {
    fetchDeviceConfigRef.current = fetchDeviceConfig;
  }, [fetchDeviceConfig]);

  useEffect(() => {
    if (!deviceToken) return;
    // When the rich board owns the screen it also owns the lifecycle
    // (config + heartbeat) — the hook must stay passive to avoid double
    // heartbeats (the API rate-limits them).
    if (!registerEnabled) return;
    fetchDeviceConfig();
    startDeviceHeartbeat(deviceToken);
  }, [deviceToken, startDeviceHeartbeat, fetchDeviceConfig, registerEnabled]);

  // ─── Queue-status polling ────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!agencyId) return;
    try {
      const headers: Record<string, string> = {};
      if (deviceToken) headers['Authorization'] = `Bearer ${deviceToken}`;
      const res = await apiFetch(`/api/agency-devices/public/queue-status?agencyId=${agencyId}`, { headers });
      if (res.ok) {
        const data = await res.json();
        // Detect newly called tickets for flash animations.
        const prev = prevServingIdsRef.current;
        const currentIds = new Set<string>((data.currentlyServing ?? []).map((s: TvCurrentlyServing) => s.id));
        const newIds = new Set<string>();
        (data.currentlyServing ?? []).forEach((item: TvCurrentlyServing) => {
          if (!prev.has(item.id)) newIds.add(item.id);
        });
        if (newIds.size > 0 && prev.size > 0) {
          setFlashIds(newIds);
          setTimeout(() => setFlashIds(new Set()), 3000);
        }
        prevServingIdsRef.current = currentIds;
        setStatus(data);
        setLastSuccessAt(Date.now());
        setFetchFailed(false);
      } else {
        setFetchFailed(true);
      }
    } catch {
      setFetchFailed(true);
    } finally {
      setLoading(false);
    }
  }, [agencyId, deviceToken]);

  useEffect(() => {
    if (!agencyId) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [agencyId, fetchStatus]);

  // ─── Realtime room joins + subscriptions ─────────────────────────────────
  useEffect(() => {
    if (!agencyId) return;
    if (deviceToken) {
      realtime.joinDevice(deviceToken);
    } else {
      realtime.joinKiosk(agencyId);
    }
    if (realtime.hasSession) {
      realtime.joinAgency(agencyId);
    }
    return () => {
      if (deviceToken) {
        realtime.leaveDevice();
      } else {
        realtime.leaveKiosk(agencyId);
      }
      if (realtime.hasSession) {
        realtime.leaveAgency(agencyId);
      }
    };
  }, [agencyId, deviceToken, realtime]);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;
    const handleUpdate = () => {
      if (fetchTimer) return;
      fetchTimer = setTimeout(() => {
        fetchTimer = null;
        fetchStatus();
      }, 250);
    };
    unsubscribers.push(realtime.onKioskUpdate(handleUpdate));
    unsubscribers.push(realtime.onQueueCalled(handleUpdate));
    unsubscribers.push(realtime.onQueueJoined(handleUpdate));
    unsubscribers.push(realtime.onQueueWalkIn(handleUpdate));
    unsubscribers.push(realtime.onQueuePaused(handleUpdate));
    unsubscribers.push(realtime.onQueueResumed(handleUpdate));
    unsubscribers.push(realtime.onQueueCompleted(handleUpdate));
    unsubscribers.push(realtime.onQueueNoShow(handleUpdate));
    unsubscribers.push(realtime.onQueueCancelled(handleUpdate));
    unsubscribers.push(realtime.onQueueSettingsUpdated(handleUpdate));
    return () => {
      if (fetchTimer) clearTimeout(fetchTimer);
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [realtime, fetchStatus]);

  // ─── Derived ─────────────────────────────────────────────────────────────
  const dataIsFresh = lastSuccessAt > 0 && (currentTime.getTime() - lastSuccessAt) < FRESH_WINDOW_MS;

  const filteredStatus = useMemo<TvQueueStatus | null>(() => {
    if (!status) return null;
    const filter = displaySettings.serviceFilter;
    if (!filter || filter.length === 0) return status;
    return {
      ...status,
      counters: status.counters?.filter(
        (c) => c.ticket && (filter.includes(c.ticket.servicePrefix) || filter.includes(c.ticket.serviceName)),
      ),
      currentlyServing: status.currentlyServing.filter(
        (s) => filter.includes(s.serviceName) || s.serviceName === undefined,
      ),
    };
  }, [status, displaySettings.serviceFilter]);

  return {
    agencyId,
    status: filteredStatus,
    loading,
    fetchFailed,
    dataIsFresh,
    displaySettings,
    deviceToken,
    lanServer,
    currentTime,
    flashIds,
    isDeviceMode,
  };
}
