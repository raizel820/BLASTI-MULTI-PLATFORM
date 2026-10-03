'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { isRTL, type Language } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { Monitor, Clock, Users, ArrowLeft, RefreshCw, Wifi, WifiOff, Maximize, Minimize, Megaphone, PauseCircle, Link2 } from 'lucide-react';
import { quickDiscover, type DiscoveredServer } from '@/lib/lan-discovery';
import { apiFetch } from '@/lib/api-fetch';
import { translateStatus } from '@/lib/enum-i18n';
import { getCachedLocalIp } from '@/lib/get-local-ip';

interface CurrentlyServing {
  id: string;
  ticketNumber: string;
  serviceName: string;
  status: string;
  calledAt: string | null;
  counterName?: string | null;
}

interface ServiceStat {
  serviceId: string;
  serviceName: string;
  serviceNameAr?: string | null;
  serviceNameFr?: string | null;
  prefix: string;
  waiting: number;
  estimatedWait: number;
}

interface AnnouncementItem {
  id: string;
  message: string;
  type: string;
  createdAt?: string;
}

interface QueueStatus {
  agency: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    logoUrl?: string | null;
    isQueueOpen: boolean;
    isPaused: boolean;
  };
  currentlyServing: CurrentlyServing[];
  serviceStats: ServiceStat[];
  totalWaiting: number;
  totalServedToday?: number;
  totalEstimatedWait: number;
  activeCounters?: number;
  recentCalls: {
    id: string;
    ticketNumber: string;
    status: string;
    calledAt: string | null;
    counterName?: string | null;
  }[];
  announcements?: AnnouncementItem[];
}

interface DisplayConfig {
  fontSize?: 'sm' | 'md' | 'lg' | 'xl';
  theme?: 'dark' | 'light' | 'auto';
  language?: 'ar' | 'fr' | 'en';
  showAds?: boolean;
  showLogo?: boolean;
  showClock?: boolean;
  rotationSec?: number;
  showEstimatedWait?: boolean;
  showServiceStats?: boolean;
  serviceFilter?: string[];
}

interface DeviceTvBoardProps {
  agencyId?: string;
  onBack?: () => void;
  currentLang?: Language;
}

// ─── Polling cadence ─────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5_000;
// A screen is "LIVE" while fresh data arrived within this window; beyond it the
// badge flips to STALE — never show LIVE on frozen data (the old UI did).
const FRESH_WINDOW_MS = 15_000;

// Animated counter component
function AnimatedCounter({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(value);
  const prevValue = useRef(value);

  useEffect(() => {
    if (prevValue.current === value) return;
    const diff = value - prevValue.current;
    const steps = Math.min(Math.abs(diff), 10);
    const stepDuration = 300 / steps;
    let current = prevValue.current;
    let step = 0;

    const interval = setInterval(() => {
      step++;
      current = Math.round(prevValue.current + (diff * step) / steps);
      setDisplay(current);
      if (step >= steps) {
        clearInterval(interval);
        setDisplay(value);
        prevValue.current = value;
      }
    }, stepDuration);

    return () => clearInterval(interval);
  }, [value]);

  return <span className={className}>{display}</span>;
}

// Particle effect component
function Particles() {
  const [particles] = useState(() => Array.from({ length: 15 }, (_, i) => ({
    id: i,
    width: Math.random() * 6 + 2,
    height: Math.random() * 6 + 2,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    yEnd: -(Math.random() * 200 + 100),
    xMid: Math.random() * 40 - 20,
    duration: Math.random() * 8 + 6,
    delay: Math.random() * 5,
  })));

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          className="absolute rounded-full bg-gradient-to-r from-emerald-400/10 to-teal-400/10"
          style={{
            width: p.width,
            height: p.height,
            left: p.left,
            top: p.top,
          }}
          animate={{
            y: [0, p.yEnd, 0],
            x: [0, p.xMid, 0],
            opacity: [0, 0.6, 0],
          }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: p.delay,
          }}
        />
      ))}
    </div>
  );
}

function generateFingerprint(): string {
  if (typeof window === 'undefined') return 'server-tv';
  try {
    const nav = navigator as any;
    const ua = nav.userAgent || '';
    const lang = nav.language || '';
    const platform = nav.platform || '';
    const screen = `${screen.width}x${screen.height}x${screen.colorDepth}`;
    const raw = `${ua}|${lang}|${platform}|${screen}`;
    // Simple hash
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

// ─── Display settings delivered via ?ds_* URL params (agency preview links) ──
// agency-devices.tsx getTvBoardUrl() serializes device.displaySettings as
// ds_<key>=<value> — the historic component never read them back.
function parseDisplaySettingsFromUrl(): DisplayConfig {
  if (typeof window === 'undefined') return {};
  try {
    const params = new URLSearchParams(window.location.search);
    const cfg: DisplayConfig = {};
    const num = (k: string) => {
      const raw = params.get(`ds_${k}`);
      if (raw === null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const str = (k: string) => params.get(`ds_${k}`) ?? undefined;
    const bool = (k: string) => {
      const raw = params.get(`ds_${k}`);
      if (raw === null) return undefined;
      return raw === 'true' || raw === '1';
    };
    const fontSize = str('fontSize');
    if (fontSize === 'sm' || fontSize === 'md' || fontSize === 'lg' || fontSize === 'xl') cfg.fontSize = fontSize;
    const theme = str('theme');
    if (theme === 'dark' || theme === 'light' || theme === 'auto') cfg.theme = theme;
    const lang = str('language');
    if (lang === 'ar' || lang === 'fr' || lang === 'en') cfg.language = lang;
    const rotationSec = num('rotationSec');
    if (rotationSec !== undefined) cfg.rotationSec = rotationSec;
    const showClock = bool('showClock');
    if (showClock !== undefined) cfg.showClock = showClock;
    const showLogo = bool('showLogo');
    if (showLogo !== undefined) cfg.showLogo = showLogo;
    const showAds = bool('showAds');
    if (showAds !== undefined) cfg.showAds = showAds;
    const showEstimatedWait = bool('showEstimatedWait');
    if (showEstimatedWait !== undefined) cfg.showEstimatedWait = showEstimatedWait;
    const showServiceStats = bool('showServiceStats');
    if (showServiceStats !== undefined) cfg.showServiceStats = showServiceStats;
    const filterRaw = str('serviceFilter');
    if (filterRaw) {
      try {
        const parsed = JSON.parse(filterRaw);
        if (Array.isArray(parsed)) cfg.serviceFilter = parsed.filter((x) => typeof x === 'string');
      } catch { /* plain comma list fallback */
        const list = filterRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (list.length) cfg.serviceFilter = list;
      }
    }
    return cfg;
  } catch {
    return {};
  }
}

export function DeviceTvBoard({
  agencyId: agencyIdProp,
  onBack,
  currentLang,
}: DeviceTvBoardProps) {
  const { t, lang: langFromHook } = useLanguage();
  const lang = currentLang || langFromHook || 'en';
  const realtime = useRealtime();
  const rtl = isRTL(lang);

  // Resolve agencyId: from prop > URL param > localStorage > device config
  const [resolvedAgencyId, setResolvedAgencyId] = useState<string>('');
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [prevServingIds, setPrevServingIds] = useState<Set<string>>(new Set());
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  // Data freshness — the LIVE badge is driven by this, not socket transport.
  const [lastSuccessAt, setLastSuccessAt] = useState(0);
  const [fetchFailed, setFetchFailed] = useState(false);

  // ─── Fullscreen Management ──────────────────────────────────────────────
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await fullscreenRef.current?.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (err) {
      console.warn('[TV Board] Fullscreen failed:', err);
    }
  }, []);

  // Listen to fullscreen changes (e.g. user presses Escape)
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Auto-fullscreen on first load when in device/TV mode
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'device' && params.get('type') === 'TV') {
      // Auto-enter fullscreen after a short delay to let the page render
      const timer = setTimeout(async () => {
        try {
          if (!document.fullscreenElement && fullscreenRef.current) {
            await fullscreenRef.current.requestFullscreen();
            setIsFullscreen(true);
          }
        } catch {
          console.warn('[TV Board] Auto-fullscreen denied (user gesture may be required)');
        }
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  // ─── Keyboard shortcut: F key to toggle fullscreen ─────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') {
        // Don't trigger if user is typing in an input
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleFullscreen]);

  // Device registration state (hydrated from localStorage)
  const [deviceToken, setDeviceToken] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      try { return localStorage.getItem('blasti_tv_device_token') || ''; } catch { return ''; }
    }
    return '';
  });
  const [deviceId, setDeviceId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      try { return localStorage.getItem('blasti_tv_device_id') || ''; } catch { return ''; }
    }
    return '';
  });
  const [isDeviceRegistered, setIsDeviceRegistered] = useState(false);
  // Merge order: device config (server) < ?ds_* URL params (preview links)
  const [serverDisplaySettings, setServerDisplaySettings] = useState<DisplayConfig>({});
  const urlDisplaySettings = useMemo(() => parseDisplaySettingsFromUrl(), []);
  const displaySettings = useMemo(
    () => ({ ...serverDisplaySettings, ...urlDisplaySettings }),
    [serverDisplaySettings, urlDisplaySettings],
  );
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // LAN Discovery state
  const [lanServer, setLanServer] = useState<DiscoveredServer | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(true);

  // Resolve agencyId from multiple sources
  const agencyId = resolvedAgencyId || agencyIdProp || '';

  // ─── LAN Auto-Discovery ─────────────────────
  useEffect(() => {
    let mounted = true;
    async function discover() {
      try {
        const server = await quickDiscover();
        if (mounted && server) {
          setLanServer(server);
          console.log(`[TV Board] Auto-connected to LAN server: ${server.hostname} (${server.ip})`);
        }
      } catch {
        console.warn('[TV Board] LAN discovery failed, using cloud');
      } finally {
        if (mounted) setIsDiscovering(false);
      }
    }
    discover();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    // Priority: prop > URL param > localStorage
    if (agencyIdProp) {
      setResolvedAgencyId(agencyIdProp);
      return;
    }
    // Try URL param: ?agencyId=XXX or ?code=XXX (agency short code)
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const urlAgencyId = params.get('agencyId');
      const code = params.get('code');
      const lsAgencyId = localStorage.getItem('blasti_tv_agency_id');
      const lsCode = localStorage.getItem('blasti_tv_agency_code');

      if (urlAgencyId) {
        setResolvedAgencyId(urlAgencyId);
        localStorage.setItem('blasti_tv_agency_id', urlAgencyId);
        // Auto-register: fetch agency code for registration
        apiFetch(`/api/agencies/${urlAgencyId}`)
          .then(r => r.json())
          .then(data => {
            if (data.customCode) {
              localStorage.setItem('blasti_tv_agency_code', data.customCode);
              registerTvDevice(urlAgencyId, data.customCode);
            } else {
              // Fallback: register with agencyId (API can look up from there)
              registerTvDeviceWithId(urlAgencyId);
            }
          }).catch(() => {
            registerTvDeviceWithId(urlAgencyId);
          });
      } else if (code) {
        localStorage.setItem('blasti_tv_agency_code', code);
        // Resolve code to agencyId via API (use LAN-aware URL)
        apiFetch(`/api/agency-devices/public/agency?code=${encodeURIComponent(code)}`)
          .then(r => r.json())
          .then(data => {
            if (data.success && data.agency?.id) {
              setResolvedAgencyId(data.agency.id);
              localStorage.setItem('blasti_tv_agency_id', data.agency.id);
              // Auto-register this TV as a device
              registerTvDevice(data.agency.id, code);
            }
          }).catch(() => {});
      } else if (lsAgencyId) {
        setResolvedAgencyId(lsAgencyId);
      } else if (lsCode) {
        apiFetch(`/api/agency-devices/public/agency?code=${encodeURIComponent(lsCode)}`)
          .then(r => r.json())
          .then(data => {
            if (data.success && data.agency?.id) {
              setResolvedAgencyId(data.agency.id);
              localStorage.setItem('blasti_tv_agency_id', data.agency.id);
              // Auto-register this TV as a device
              registerTvDevice(data.agency.id, lsCode);
            }
          }).catch(() => {});
      }
    }
  }, [agencyIdProp]);

  // ─── Auto-register TV as a device ─────────────────
  const registerTvDevice = useCallback(async (resolvedId: string, code: string) => {
    // Already registered — skip
    const savedId = localStorage.getItem('blasti_tv_device_id');
    const savedAgency = localStorage.getItem('blasti_tv_registered_agency_id');
    if (savedId && savedAgency === resolvedId) {
      // Already registered for this agency, just verify token exists
      const token = localStorage.getItem('blasti_tv_device_token');
      if (token) return;
    }

    try {
      const regRes = await apiFetch('/api/agency-devices/public/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyCode: code,
          deviceName: 'BLASTI TV Board',
          deviceType: 'TV',
          connectionType: lanServer ? 'LAN' : 'WIFI',
          deviceFingerprint: generateFingerprint(),
        }),
      });
      const regData = await regRes.json();
      if (regData.success && regData.deviceToken) {
        localStorage.setItem('blasti_tv_device_token', regData.deviceToken);
        localStorage.setItem('blasti_tv_device_id', regData.device.id);
        localStorage.setItem('blasti_tv_registered_agency_id', resolvedId);
        setDeviceToken(regData.deviceToken);
        setDeviceId(regData.device.id);
        setIsDeviceRegistered(true);
        console.log(`[TV Board] Registered as device: ${regData.device.id}`);
      }
    } catch (err) {
      console.warn('[TV Board] Auto-registration failed:', err);
    }
  }, [lanServer]);

  // ─── Register TV with agencyId (fallback when no code available) ────────
  const registerTvDeviceWithId = useCallback(async (resolvedId: string) => {
    const savedId = localStorage.getItem('blasti_tv_device_id');
    const savedAgency = localStorage.getItem('blasti_tv_registered_agency_id');
    if (savedId && savedAgency === resolvedId) {
      const token = localStorage.getItem('blasti_tv_device_token');
      if (token) return;
    }

    try {
      // Use /public/register with agencyId passed as code fallback
      // The register endpoint accepts agencyCode — try using the ID first
      const regRes = await apiFetch('/api/agency-devices/public/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyCode: resolvedId,
          deviceName: 'BLASTI TV Board',
          deviceType: 'TV',
          connectionType: lanServer ? 'LAN' : 'WIFI',
          deviceFingerprint: generateFingerprint(),
        }),
      });
      const regData = await regRes.json();
      if (regData.success && regData.deviceToken) {
        localStorage.setItem('blasti_tv_device_token', regData.deviceToken);
        localStorage.setItem('blasti_tv_device_id', regData.device.id);
        localStorage.setItem('blasti_tv_registered_agency_id', resolvedId);
        setDeviceToken(regData.deviceToken);
        setDeviceId(regData.device.id);
        setIsDeviceRegistered(true);
        console.log(`[TV Board] Registered as device (by ID): ${regData.device.id}`);
      }
    } catch (err) {
      console.warn('[TV Board] Auto-registration by ID failed:', err);
    }
  }, [lanServer]);

  // Update clock every second (also drives the freshness indicator)
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // ─── Device Heartbeat + remote commands (parity with device-kiosk) ─────
  const fetchDeviceConfigRef = useRef<() => void>(() => {});

  const clearDeviceCredentials = useCallback(() => {
    try {
      localStorage.removeItem('blasti_tv_device_token');
      localStorage.removeItem('blasti_tv_device_id');
      localStorage.removeItem('blasti_tv_registered_agency_id');
    } catch { /* private mode */ }
    setDeviceToken('');
    setDeviceId('');
    setIsDeviceRegistered(false);
  }, []);

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
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            appVersion: '1.0.0',
            ipAddress: getCachedLocalIp() || lanServer?.ip || undefined,
          }),
        });
        if (res.status === 401) {
          // Token revoked (device unpaired/disabled) — drop credentials; the
          // registration flow will re-create the device on the next boot.
          console.warn('[TV Board] Heartbeat 401 — token invalid, clearing credentials');
          if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
          clearDeviceCredentials();
          return;
        }
        if (res.ok) {
          const body = await res.json().catch(() => null);
          const commands: Array<{ id: string; type: string }> = body?.pendingCommands ?? [];
          if (commands.length) {
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
              // Unknown command types: ack so they don't age out silently
              await ackCommand(cmd.id);
            }
          }
        }
      } catch {
        // Silent — don't disrupt TV board operation
      }
    };

    // Send immediately, then every 30s
    sendHeartbeat();
    heartbeatTimerRef.current = setInterval(sendHeartbeat, 30_000);
  }, [lanServer, clearDeviceCredentials]);

  // Clean up heartbeat on unmount
  useEffect(() => {
    return () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
      }
    };
  }, []);

  // On mount — fetch device config if deviceToken exists & start heartbeat
  const fetchDeviceConfig = useCallback(() => {
    if (!deviceToken) return;
    setIsDeviceRegistered(true);
    apiFetch('/api/agency-devices/device/config', {
      headers: { 'Authorization': `Bearer ${deviceToken}` },
    })
      .then(res => {
        if (res.status === 401) {
          // L17: Token invalidation — clear token and trigger re-registration
          console.warn('[TV Board] Config fetch 401 — token invalid, clearing credentials');
          setDeviceToken('');
          setDeviceId('');
          setIsDeviceRegistered(false);
          if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
          localStorage.removeItem('blasti_tv_device_token');
          localStorage.removeItem('blasti_tv_device_id');
          return null;
        }
        return res.json();
      })
      .then(data => {
        if (!data) return;
        if (data.success && data.config) {
          try {
            const parsed = data.config.displaySettings || {};
            setServerDisplaySettings(parsed);
          } catch {
            // Invalid JSON, use defaults
          }
          // Resolve agencyId from device config if not already known
          if (!resolvedAgencyId && data.config.agency?.id) {
            setResolvedAgencyId(data.config.agency.id);
            localStorage.setItem('blasti_tv_agency_id', data.config.agency.id);
          }
        }
      })
      .catch(() => {});
  }, [deviceToken, resolvedAgencyId]);

  // Keep a ref so heartbeat command handlers can trigger a config refresh
  useEffect(() => {
    fetchDeviceConfigRef.current = fetchDeviceConfig;
  }, [fetchDeviceConfig]);

  useEffect(() => {
    if (!deviceToken) return;
    fetchDeviceConfig();
    // Start heartbeat
    startDeviceHeartbeat(deviceToken);
  }, [deviceToken, startDeviceHeartbeat, fetchDeviceConfig]);

  // M43: Restart heartbeat when LAN server is discovered
  useEffect(() => {
    if (deviceToken && lanServer) {
      startDeviceHeartbeat(deviceToken);
    }
  }, [lanServer]);

  const fetchStatus = useCallback(async () => {
    if (!agencyId) return;
    try {
      const fetchHeaders: Record<string, string> = {};
      if (deviceToken) fetchHeaders['Authorization'] = `Bearer ${deviceToken}`;
      const res = await apiFetch(`/api/agency-devices/public/queue-status?agencyId=${agencyId}`, { headers: fetchHeaders });
      if (res.ok) {
        const data = await res.json();
        // Detect newly called tickets (using refs to avoid stale closures)
        const prev = prevServingIdsRef.current;
        const newIds = new Set<string>();
        const currentIds = new Set(data.currentlyServing?.map((s: CurrentlyServing) => s.id) || []);
        data.currentlyServing?.forEach((item: CurrentlyServing) => {
          if (!prev.has(item.id)) {
            newIds.add(item.id);
          }
        });
        if (newIds.size > 0) {
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
  // Keep a ref to prevServingIds to avoid adding it to useCallback deps
  const prevServingIdsRef = useRef<Set<string>>(new Set());

  // Polling fallback — keeps working even if realtime is disconnected
  useEffect(() => {
    if (!agencyId) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [agencyId, fetchStatus]);

  // ─── Realtime room joins ─────────────────────────────────────────────
  // A standalone TV has no user session — `join:agency` requires membership
  // and is REJECTED for it (this is why the board never updated live). The
  // correct path is `join:device` (deviceToken → server joins agency + kiosk
  // rooms, marks socket _isDevice). Fallbacks: join the kiosk room (accepted
  // in legacy mode → kiosk:update still arrives); when a USER session exists
  // (in-app preview) join the agency room as well.
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

  // Subscribe to realtime events — instantly (debounced) refresh on any
  // queue change. Includes completions/cancels, which change the footer
  // stats and the "now serving" roster just as much as a call-next does.
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;

    // Trampoline: bursts of events (call-next + kiosk:update + completed…)
    // collapse into ONE fetch within 250ms instead of N immediate calls.
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
      unsubscribers.forEach(unsub => unsub());
    };
  }, [realtime, fetchStatus]);

  // ─── Freshness indicator (1s tick shares the clock interval) ──────────
  const secondsSinceRefresh = lastSuccessAt ? Math.max(0, Math.floor((currentTime.getTime() - lastSuccessAt) / 1000)) : null;
  const dataIsFresh = lastSuccessAt > 0 && (currentTime.getTime() - lastSuccessAt) < FRESH_WINDOW_MS;

  const getAgencyName = () => {
    if (!status) return '';
    if (currentLang === 'ar' && status.agency.nameAr) return status.agency.nameAr;
    if (currentLang === 'fr' && status.agency.nameFr) return status.agency.nameFr;
    return status.agency.name;
  };

  const getServiceName = (stat: ServiceStat) => {
    if (currentLang === 'ar' && stat.serviceNameAr) return stat.serviceNameAr;
    if (currentLang === 'fr' && stat.serviceNameFr) return stat.serviceNameFr;
    return stat.serviceName;
  };

  const formatTime = (date: Date) => {
    try {
      return date.toLocaleTimeString(
        currentLang === 'ar' ? 'ar-DZ' : currentLang === 'fr' ? 'fr-DZ' : 'en-US',
        { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      );
    } catch {
      return date.toLocaleTimeString();
    }
  };

  const formatDate = (date: Date) => {
    try {
      return date.toLocaleDateString(
        currentLang === 'ar' ? 'ar-DZ' : currentLang === 'fr' ? 'fr-DZ' : 'en-US',
        { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
      );
    } catch {
      return date.toLocaleDateString();
    }
  };

  // ─── Display Settings Derived Values ─────────────────
  const showClock = displaySettings.showClock !== false; // default: true
  const showLogo = displaySettings.showLogo !== false; // default: true
  const showEstimatedWait = displaySettings.showEstimatedWait !== false; // default: true
  const showServiceStats = displaySettings.showServiceStats !== false; // default: true

  // Font size mapping for ticket numbers (kept small enough that even
  // 5-char tickets like "R-001" never wrap mid-number on a 720p TV)
  const getFontSizeClass = () => {
    switch (displaySettings.fontSize) {
      case 'sm': return 'clamp(2.5rem, 9vh, 5rem)';
      case 'md': return 'clamp(3rem, 12vh, 7rem)';
      case 'lg': return 'clamp(3rem, 15vh, 9.5rem)';
      case 'xl': return 'clamp(4rem, 19vh, 12rem)';
      default: return 'clamp(3rem, 15vh, 9.5rem)';
    }
  };

  // Auto-rotation between services
  const [focusedServiceIndex, setFocusedServiceIndex] = useState(0);
  useEffect(() => {
    if (!displaySettings.rotationSec || !status?.currentlyServing || status.currentlyServing.length <= 1) return;
    const interval = setInterval(() => {
      setFocusedServiceIndex(prev =>
        (prev + 1) % status.currentlyServing.length
      );
    }, (displaySettings.rotationSec || 10) * 1000);
    return () => clearInterval(interval);
  }, [displaySettings.rotationSec, status?.currentlyServing?.length]);

  // Reset rotation index when the roster changes to avoid pointing at nothing
  useEffect(() => {
    setFocusedServiceIndex(0);
  }, [status?.currentlyServing?.length]);

  // Filter service stats if serviceFilter is configured
  const filteredServiceStats = displaySettings.serviceFilter
    ? status?.serviceStats.filter(s => displaySettings.serviceFilter!.includes(s.serviceId)) || []
    : status?.serviceStats || [];

  // Ticker content: announcements first (they change), then identity/date.
  const tickerItems = useMemo(() => {
    const items: { text: string; className: string }[] = [];
    for (const ann of status?.announcements ?? []) {
      if (ann?.message) items.push({ text: `📢 ${ann.message}`, className: 'text-amber-200 font-semibold' });
    }
    items.push({ text: `🏛️ ${t('tvBoardInstitution')}: ${getAgencyName()}`, className: 'text-emerald-300 font-semibold' });
    items.push({ text: `📅 ${formatDate(currentTime)}`, className: 'text-teal-300' });
    items.push({ text: `⏰ ${formatTime(currentTime)}`, className: 'text-cyan-300' });
    return items;
  }, [status?.announcements, currentTime, lang, status?.agency]);

  // ─── States ──────────────────────────────────────────────────────────

  // No agency resolvable: give operators an actionable screen instead of an
  // infinite spinner (the historic behavior hid the missing ?agencyId/?code).
  if (!isDiscovering && !agencyId && !loading && !status) {
    return (
      <div
        ref={fullscreenRef}
        className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white p-6"
        dir={rtl ? 'rtl' : 'ltr'}
      >
        <Link2 className="h-14 w-14 text-gray-600 mb-6" />
        <h1 className="text-2xl font-bold mb-2">{t('kioskQueueBoard')}</h1>
        <p className="text-gray-400 text-center max-w-md mb-1">
          {t('tvBoardNotLinked')}
        </p>
        <p className="text-gray-500 text-sm text-center max-w-md font-mono">
          ?agencyId=… {rtl ? 'أو' : 'or'} ?code=…
        </p>
        <button
          onClick={onBack || (() => window.history.back())}
          className="mt-8 min-h-[60px] px-8 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold text-lg shadow-lg shadow-emerald-500/25"
        >
          {t('kioskBack')}
        </button>
      </div>
    );
  }

  if (loading || (!status && !agencyId)) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center text-white">
        <RefreshCw className="h-12 w-12 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (!status) {
    return (
      <div
        className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white p-6"
        dir={rtl ? 'rtl' : 'ltr'}
      >
        <WifiOff className="h-14 w-14 text-red-400/70 mb-4" />
        <p className="text-xl mb-1">{t('error')}</p>
        <p className="text-gray-500 text-sm mb-6">
          {fetchFailed ? t('tvBoardCannotReachServer') : ''}
        </p>
        <button
          onClick={onBack || (() => window.history.back())}
          className="min-h-[60px] px-8 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold text-lg shadow-lg shadow-emerald-500/25"
        >
          {t('kioskBack')}
        </button>
      </div>
    );
  }

  // Status badge: driven by DATA freshness (never claim LIVE on frozen data)
  const statusBadge = dataIsFresh ? (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300"
      title={secondsSinceRefresh !== null ? `${t('tvBoardUpdated')} ${secondsSinceRefresh}s` : undefined}
    >
      <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
      <span className="text-xs font-bold tracking-wider">{t('tvBoardLive')}</span>
    </div>
  ) : fetchFailed ? (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/20 text-red-300">
      <WifiOff className="h-3 w-3" />
      <span className="text-xs font-bold tracking-wider">{t('tvBoardOffline')}</span>
    </div>
  ) : (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300">
      <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
      <span className="text-xs font-bold tracking-wider">{t('tvBoardStale')}</span>
    </div>
  );

  const showPausedBanner = status.agency.isPaused || !status.agency.isQueueOpen;

  return (
    <div
      ref={fullscreenRef}
      className="min-h-screen bg-gray-950 text-white flex flex-col select-none relative overflow-hidden"
      dir={rtl ? 'rtl' : 'ltr'}
    >
      {/* Animated gradient background — decorative layer over a SOLID dark
          base: the 400%-sized gradient spends most of its cycle on its
          ~transparent mid-stops, which used to let the white page bleed
          through and wash out the whole board. */}
      <div className="absolute inset-0">
        <motion.div
          animate={{ backgroundPosition: ['0% 0%', '100% 100%', '0% 0%'] }}
          transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
          className="absolute inset-0 bg-[length:400%_400%] bg-gradient-to-br from-gray-900 via-emerald-950/30 to-teal-950/20"
        />
        {/* Gradient orbs */}
        <motion.div
          animate={{ x: [0, 30, 0], y: [0, -20, 0] }}
          transition={{ duration: 15, repeat: Infinity, ease: 'easeInOut' }}
          className="absolute top-0 start-0 w-96 h-96 bg-emerald-600/8 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -20, 0], y: [0, 30, 0] }}
          transition={{ duration: 20, repeat: Infinity, ease: 'easeInOut', delay: 5 }}
          className="absolute bottom-0 end-0 w-96 h-96 bg-teal-600/8 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ y: [0, -25, 0], x: [0, 15, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
          className="absolute top-1/3 end-1/4 w-64 h-64 bg-cyan-600/5 rounded-full blur-3xl"
        />
        {/* Particle effects */}
        <Particles />
      </div>

      {/* Header */}
      <div className="relative bg-gray-800/60 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-emerald-500/10">
        <div className="flex items-center gap-4 min-w-0">
          <button
            onClick={onBack || (() => window.history.back())}
            className="min-h-[48px] min-w-[48px] shrink-0 rounded-xl bg-gray-700/60 flex items-center justify-center hover:bg-gray-600/60 transition-colors"
          >
            <ArrowLeft className={`h-5 w-5 ${rtl ? 'rotate-180' : ''}`} />
          </button>
          {/* Agency logo — served by the API; fallback to the device icon */}
          {showLogo && (
            status.agency.logoUrl ? (
              <img
                src={status.agency.logoUrl}
                alt={getAgencyName() || 'Agency logo'}
                className="h-11 w-11 shrink-0 rounded-xl object-contain bg-gray-700/40 p-1"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="h-11 w-11 shrink-0 rounded-xl bg-gray-700/40 flex items-center justify-center">
                <Monitor className="h-5 w-5 text-emerald-400" />
              </div>
            )
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold truncate">{t('kioskQueueBoard')}</h1>
            </div>
            <p className="text-gray-400 text-sm truncate">{getAgencyName()}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-gray-400 text-sm shrink-0">
          {/* Clock display */}
          {showClock && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-700/40 backdrop-blur-sm">
              <Clock className="h-4 w-4 text-emerald-400" />
              <span className="font-mono text-sm text-emerald-300">{formatTime(currentTime)}</span>
            </div>
          )}
          <span
            className="hidden md:flex items-center gap-1"
            title={secondsSinceRefresh !== null ? `${t('tvBoardUpdated')} ${secondsSinceRefresh}s` : undefined}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {Math.round(POLL_INTERVAL_MS / 1000)}s
          </span>
          {statusBadge}
          {/* Fullscreen toggle — always visible on TV mode */}
          <button
            onClick={toggleFullscreen}
            className="min-h-[48px] min-w-[48px] rounded-xl bg-gray-700/60 flex items-center justify-center hover:bg-gray-600/60 transition-colors"
            title={isFullscreen ? t('tvBoardExitFullscreen') : t('tvBoardFullscreen')}
          >
            {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Paused / closed ribbon — instant via queue:paused/resumed events */}
      <AnimatePresence>
        {showPausedBanner && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="relative bg-amber-500/15 border-b border-amber-500/30 overflow-hidden"
          >
            <div className="px-6 py-2 flex items-center justify-center gap-2 text-amber-300 font-semibold">
              <PauseCircle className="h-5 w-5" />
              {status.agency.isPaused ? t('queuePaused') : t('queueClosed')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 p-6 overflow-y-auto relative">
        {/* Now Serving Section - HUGE numbers */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-6 text-emerald-400 flex items-center gap-2">
            <Users className="h-7 w-7" />
            {t('kioskNowServing')}
          </h2>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {status.currentlyServing.length > 0 ? (
              displaySettings.rotationSec && status.currentlyServing.length > 1 ? (
                // Rotation mode: show one service at a time with animated transition
                <AnimatePresence mode="wait">
                  <motion.div
                    key={status.currentlyServing[focusedServiceIndex]?.id || 'empty'}
                    initial={{ scale: 0.8, opacity: 0, y: 30 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.8, opacity: 0, y: -30 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                    className="relative max-w-2xl mx-auto w-full"
                  >
                    {(() => {
                      const item = status.currentlyServing[focusedServiceIndex];
                      if (!item) return null;
                      const isNew = flashIds.has(item.id);
                      return (
                        <>
                          {isNew && (
                            <motion.div
                              initial={{ opacity: 0.8, scale: 1 }}
                              animate={{ opacity: 0, scale: 1.5 }}
                              transition={{ duration: 1.5, repeat: 2, ease: 'easeOut' }}
                              className="absolute inset-0 rounded-2xl bg-gradient-to-r from-emerald-400/30 via-teal-400/30 to-cyan-400/30 blur-xl"
                            />
                          )}
                          <motion.div
                            animate={{ opacity: [0.3, 0.6, 0.3] }}
                            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                            className="absolute -inset-2 rounded-3xl bg-gradient-to-br from-emerald-500/15 to-teal-500/15 blur-xl"
                          />
                          <div className={`relative rounded-2xl p-8 text-center overflow-hidden ${
                            isNew ? 'bg-emerald-900/60 border-2 border-emerald-400/50' : 'bg-emerald-900/40 border border-emerald-700/30'
                          }`}>
                            <div className="absolute inset-0 opacity-5">
                              <div className="absolute inset-0" style={{
                                backgroundImage: `radial-gradient(circle at 2px 2px, rgba(255,255,255,0.15) 1px, transparent 0)`,
                                backgroundSize: '24px 24px',
                              }} />
                            </div>
                            {item.counterName && (
                              <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="inline-flex items-center gap-1.5 mb-4 px-3 py-1 rounded-full bg-gradient-to-r from-emerald-500/30 to-teal-500/30 border border-emerald-400/30 backdrop-blur-sm"
                              >
                                <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                                <span className="text-sm font-bold text-emerald-300">{item.counterName}</span>
                              </motion.div>
                            )}
                            <motion.div
                              animate={isNew ? { scale: [1, 1.05, 1] } : {}}
                              transition={{ duration: 0.5, repeat: isNew ? 3 : 0 , ease: 'easeInOut' }}
                            >
                              <p className="font-black whitespace-nowrap text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300 leading-none"
                                style={{ fontSize: getFontSizeClass() }}
                              >
                                {item.ticketNumber}
                              </p>
                            </motion.div>
                            <p className="text-emerald-200 text-lg mt-3 font-semibold">{item.serviceName}</p>
                            <p className="text-emerald-400/70 text-sm mt-1 uppercase font-medium">
                              {t('kioskNowServing')}
                            </p>
                            <div className="mt-4 flex items-center justify-center gap-2 text-emerald-500/60">
                              <span className="text-xs">{focusedServiceIndex + 1} / {status.currentlyServing.length}</span>
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </motion.div>
                </AnimatePresence>
              ) : (
              // Normal mode: show all services
              status.currentlyServing.map((item) => {
                const isNew = flashIds.has(item.id);
                return (
                  <motion.div
                    key={item.id}
                    initial={{ scale: 0.8, opacity: 0, y: 30 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                    className="relative"
                  >
                    {/* Flash/pulse animation for newly called */}
                    {isNew && (
                      <motion.div
                        initial={{ opacity: 0.8, scale: 1 }}
                        animate={{ opacity: 0, scale: 1.5 }}
                        transition={{ duration: 1.5, repeat: 2, ease: 'easeOut' }}
                        className="absolute inset-0 rounded-2xl bg-gradient-to-r from-emerald-400/30 via-teal-400/30 to-cyan-400/30 blur-xl"
                      />
                    )}
                    {/* Pulsing glow behind card */}
                    <motion.div
                      animate={{ opacity: [0.3, 0.6, 0.3] }}
                      transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                      className="absolute -inset-2 rounded-3xl bg-gradient-to-br from-emerald-500/15 to-teal-500/15 blur-xl"
                    />

                    <div className={`relative rounded-2xl p-8 text-center overflow-hidden ${
                      isNew ? 'bg-emerald-900/60 border-2 border-emerald-400/50' : 'bg-emerald-900/40 border border-emerald-700/30'
                    }`}>
                      {/* Background pattern */}
                      <div className="absolute inset-0 opacity-5">
                        <div className="absolute inset-0" style={{
                          backgroundImage: `radial-gradient(circle at 2px 2px, rgba(255,255,255,0.15) 1px, transparent 0)`,
                          backgroundSize: '24px 24px',
                        }} />
                      </div>

                      {/* Counter name badge */}
                      {item.counterName && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="inline-flex items-center gap-1.5 mb-4 px-3 py-1 rounded-full bg-gradient-to-r from-emerald-500/30 to-teal-500/30 border border-emerald-400/30 backdrop-blur-sm"
                        >
                          <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                          <span className="text-sm font-bold text-emerald-300">{item.counterName}</span>
                        </motion.div>
                      )}

                      {/* HUGE ticket number with gradient text and glow */}
                      <motion.div
                        animate={isNew ? { scale: [1, 1.05, 1] } : {}}
                        transition={{ duration: 0.5, repeat: isNew ? 3 : 0 , ease: 'easeInOut' }}
                      >
                        <p className="font-black whitespace-nowrap text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300 leading-none"
                          style={{ fontSize: getFontSizeClass() }}
                        >
                          {item.ticketNumber}
                        </p>
                      </motion.div>

                      {/* Pulsing ring effect */}
                      {isNew && (
                        <motion.div
                          animate={{
                            boxShadow: [
                              '0 0 0 0 rgba(16, 185, 129, 0.4)',
                              '0 0 0 30px rgba(16, 185, 129, 0)',
                              '0 0 0 0 rgba(16, 185, 129, 0)',
                            ],
                          }}
                          transition={{ duration: 1.5, repeat: 2 }}
                          className="absolute inset-0 rounded-2xl pointer-events-none"
                        />
                      )}

                      <p className="text-emerald-200 text-lg mt-3 font-semibold">{item.serviceName}</p>
                      <p className="text-emerald-400/70 text-sm mt-1 uppercase font-medium">
                        {t('kioskNowServing')}
                      </p>
                    </div>
                  </motion.div>
                );
              })
              )
            ) : (
              <div className="col-span-full bg-gray-800/60 backdrop-blur-sm rounded-2xl p-12 text-center">
                <motion.div
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 3, repeat: Infinity , ease: 'easeInOut' }}
                >
                  <Users className="h-16 w-16 mx-auto mb-4 text-gray-600" />
                </motion.div>
                <p className="text-gray-400 text-xl">
                  {t('noQueue')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Service Stats */}
        {showServiceStats && (
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4 text-gray-300">
            {t('services')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredServiceStats.map((stat) => (
              <motion.div
                key={stat.serviceId}
                whileHover={{ scale: 1.02, y: -2 }}
                className="bg-gray-800/60 backdrop-blur-sm rounded-xl p-4 flex items-center justify-between border border-gray-700/30 hover:border-emerald-500/20 transition-all duration-300"
              >
                <div className="min-w-0">
                  <span className="text-xs font-bold px-2 py-1 rounded bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 me-2 border border-emerald-500/20">
                    {stat.prefix}
                  </span>
                  <span className="text-white font-semibold">
                    {getServiceName(stat)}
                  </span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-center">
                    <AnimatedCounter
                      value={stat.waiting}
                      className="text-xl font-bold text-amber-400"
                    />
                    <p className="text-[10px] text-gray-500 uppercase">{t('kioskWaiting')}</p>
                  </div>
                  {showEstimatedWait && (
                  <div className="text-center">
                    <AnimatedCounter
                      value={stat.estimatedWait}
                      className="text-xl font-bold text-teal-400"
                    />
                    <p className="text-[10px] text-gray-500 uppercase">{t('kioskMinutes')}</p>
                  </div>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </div>
        )}

        {/* Recent Calls */}
        {status.recentCalls.length > 0 && (
          <div>
            <h2 className="text-xl font-bold mb-4 text-gray-300 flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t('tvBoardRecentCalls')}
            </h2>
            <div className="flex gap-3 flex-wrap">
              {status.recentCalls.map((call) => (
                <motion.div
                  key={call.id}
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  whileHover={{ scale: 1.05 }}
                  className="bg-gray-800/60 backdrop-blur-sm rounded-lg px-4 py-2 flex items-center gap-2 border border-gray-700/30"
                >
                  <span className="text-lg font-bold text-gray-200">
                    {call.ticketNumber}
                  </span>
                  {call.counterName && (
                    <span className="text-xs text-gray-400">{call.counterName}</span>
                  )}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      call.status === 'CALLED'
                        ? 'bg-emerald-900/60 text-emerald-400 border border-emerald-500/20'
                        : call.status === 'SERVING'
                        ? 'bg-teal-900/60 text-teal-400 border border-teal-500/20'
                        : 'bg-gray-700/60 text-gray-400 border border-gray-600/20'
                    }`}
                  >
                    {translateStatus(call.status, t)}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Scrolling Ticker + Footer Stats */}
      <div className="relative">
        {/* Scrolling ticker — announcements (from the API) + identity/date */}
        <div className="bg-gradient-to-r from-emerald-900/60 via-teal-900/60 to-emerald-900/60 backdrop-blur-md border-t border-emerald-500/10 overflow-hidden">
          <div className="flex items-center py-2">
            {(status.announcements?.length ?? 0) > 0 && (
              <div className="shrink-0 px-3 flex items-center gap-1.5 text-amber-300 border-e border-emerald-500/20 me-3">
                <Megaphone className="h-4 w-4" />
                <span className="text-xs font-bold uppercase tracking-wider">{t('tvBoardAnnouncements')}</span>
              </div>
            )}
            <motion.div
              animate={{ x: rtl ? [-2000, 0] : [0, -2000] }}
              transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
              className="flex items-center gap-8 whitespace-nowrap px-4"
            >
              {[...tickerItems, ...tickerItems].map((item, i) => (
                <span key={i} className={item.className}>
                  {item.text}
                </span>
              ))}
            </motion.div>
          </div>
        </div>

        {/* Footer Stats */}
        <div className="bg-gray-800/80 backdrop-blur-md px-6 py-5 flex items-center justify-around border-t border-gray-700/30">
          <div className="text-center">
            <AnimatedCounter
              value={status.activeCounters ?? 0}
              className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-400"
            />
            <p className="text-xs text-gray-400 uppercase font-semibold mt-1">{t('tvBoardActiveCounters')}</p>
          </div>
          <div className="w-px h-12 bg-gradient-to-b from-transparent via-emerald-500/30 to-transparent" />
          <div className="text-center">
            <AnimatedCounter
              value={status.totalWaiting}
              className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-400"
            />
            <p className="text-xs text-gray-400 uppercase font-semibold mt-1">{t('kioskWaiting')}</p>
          </div>
          <div className="w-px h-12 bg-gradient-to-b from-transparent via-amber-500/30 to-transparent" />
          <div className="text-center">
            <AnimatedCounter
              value={status.totalServedToday ?? 0}
              className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-amber-400 to-yellow-400"
            />
            <p className="text-xs text-gray-400 uppercase font-semibold mt-1">{t('tvBoardServedToday')}</p>
          </div>
          <div className="w-px h-12 bg-gradient-to-b from-transparent via-teal-500/30 to-transparent" />
          <div className="text-center">
            <AnimatedCounter
              value={status.totalEstimatedWait}
              className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-cyan-400"
            />
            <p className="text-xs text-gray-400 uppercase font-semibold mt-1">{t('kioskMinutes')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
