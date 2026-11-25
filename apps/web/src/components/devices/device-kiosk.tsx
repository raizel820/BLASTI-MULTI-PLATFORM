'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime, repointRealtimeToLanBase } from '@/hooks/use-realtime';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { isRTL } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { DeviceQrScanner } from './device-qr-scanner';
import { quickDiscover, type DiscoveredServer } from '@/lib/lan-discovery';
// 0.6.86 — kiosk LAN base pinning + branch-code → desktop resolution.
import {
  setKioskLanBase,
  getKioskLanBase,
  resolveBranchLanServer,
  pinKioskLanBaseFromIp,
} from '@/lib/kiosk-lan-base';
import { apiFetch } from '@/lib/api-fetch';
// 0.6.110 — QR claim deep-link base: the QR must encode an address the
// customer's PHONE can open on the same WiFi — NOT the kiosk window's own
// origin (inside the desktop shell that is http://127.0.0.1:3080, a loopback
// no phone can reach, so the printed/displayed QR was silently dead).
import { buildClaimUrl } from '@/lib/claim-base';
import { APP_VERSION } from '@/lib/version';
// 0.6.92 — the phone ANNOUNCES itself over the LAN while in the pairing-ready
// state (user request: the desktop Device Manager scan must see the active
// BLASTI app on phones linked to the same network). Native UDP beacon.
// 0.6.106 — the same beacon lifecycle now also RECEIVES device-to-device
// pairing offers (desktop → this device, UDP :3082, no cloud hop).
import { startPairingBeacon, stopPairingBeacon, onLanPairingOffer, type LanPairingOffer } from '@/lib/pairing-beacon';
import { getLocalIp } from '@/lib/get-local-ip';
import { flushLogsNow, logDevice, logQueue } from '@/lib/remote-logger';
import type { ApiFetchResponse } from '@/lib/api-fetch';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  Loader2,
  ScanLine,
  Globe,
  XCircle,
  AlertTriangle,
  RotateCcw,
  Wifi,
  WifiOff,
  Monitor,
  ArrowLeft,
  FileUp,
  Printer,
} from 'lucide-react';

import {
  KioskStepIndicator,
} from './kiosk/kiosk-step-indicator';
// 0.6.114 — the default-printer setting ON the kiosk (among the agency's
// REGISTERED printers). Pairs with the direct-print-only receipt button.
import { KioskPrinterSettings } from './kiosk/kiosk-printer-settings';
import {
  KioskDiscoveryLogin,
  KioskMethodSelect,
  KioskCredentialsLogin,
  DiscoveryStartButton,
  type DiscoveryStatus,
} from './kiosk/kiosk-discovery-login';
import type { PairingRequest, PairingRegistrationProof, KioskViewportSize } from './kiosk/kiosk-types';
import { KioskOfflineBanner } from './kiosk/kiosk-offline-banner';
import { KioskServiceSelector } from './kiosk/kiosk-service-selector';
import { KioskTicketDisplay } from './kiosk/kiosk-ticket-display';
import {
  type KioskStep,
  type OfflineTicket,
  type AgencyCache,
  type AgencyInfo,
  type ServiceInfo,
  type QueueStats,
  type TicketInfo,
  MAX_RETRIES,
  BACKOFF_DELAYS,
  getStableDeviceFingerprint,
  setDeviceSurfaceActive,
  reportDeviceSurfaceIdentity,
  clearDeviceSurfaceIdentity,
  generateQRDataURL,
  getLocalizedName,
  getPageVariants,
  formatClockTime,
  formatClockDate,
  loadOfflineTickets,
  saveOfflineTickets,
  loadAgencyCache,
  saveAgencyCache,
  loadSavedAgencyCode,
  saveAgencyCode,
  removeAgencyCode,
  loadDeviceToken,
  saveDeviceToken,
  removeDeviceToken,
  loadDeviceId,
  saveDeviceId,
} from './kiosk/kiosk-types';
import { useCategoryTermScope } from '@/hooks/use-category-terms';

/**
 * 0.6.96 — STABLE kiosk/phone fingerprint, persisted in localStorage.
 * The OLD code generated a fresh fingerprint on every beacon effect run and
 * every register call, so the desktop Device Manager could never correlate a
 * beacon card with a registered device (dedupe flapped, pairing-by-identity
 * had nothing to match). Persisted once, reused for: the UDP beacon `uid`,
 * every discover-register/kiosk-auth `deviceFingerprint`, and the manager's
 * pairing-by-identity lookup — one stable identity end-to-end.
 *
 * 0.6.99 — moved to kiosk-types.ts as getStableDeviceFingerprint() so the TV
 * board surface shares the SAME per-machine identity (and the beacon, the
 * register calls and the manager all agree). Collision-safe (random suffix).
 */
function getStableKioskFingerprint(): string {
  return getStableDeviceFingerprint();
}

// ─── 0.6.104 — Kiosk viewport classification (multi-layout support) ────
// Classifies the viewport so EVERY kiosk screen — from a ~320x560 phone to a
// large tablet — renders a layout where ALL buttons and information stay on
// screen (content is never pushed below the fold, no scrolling required).
//   xs : width < 360 OR height < 640   (very small phones)
//   sm : width < 480 OR height < 780   (phones / short landscape screens)
//   md : width < 768                   (small tablets)
//   lg : everything else               (large tablets / desktop kiosks)
function classifyKioskViewport(width: number, height: number): KioskViewportSize {
  if (width < 360 || height < 640) return 'xs';
  if (width < 480 || height < 780) return 'sm';
  if (width < 768) return 'md';
  return 'lg';
}

function useKioskViewportSize(): KioskViewportSize {
  // SSR-safe default ('lg'); corrected before interaction via the effect below.
  const [size, setSize] = useState<KioskViewportSize>('lg');
  const measure = useCallback(() => {
    setSize(classifyKioskViewport(window.innerWidth, window.innerHeight));
  }, []);
  useEffect(() => {
    measure();
    // Resize/orientation events are rare on kiosks — no debounce needed.
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [measure]);
  return size;
}

export function DeviceKiosk() {
  const { t, lang, setLang } = useLanguage();
  const rtl = isRTL(lang);

  // ─── State ─────────────────────────────────────────────────
  const [step, setStep] = useState<KioskStep>('method-select');
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [agencyCode, setAgencyCode] = useState(() => loadSavedAgencyCode());
  const [agency, setAgency] = useState<AgencyInfo | null>(null);

  // 0.6.76 — activate the paired agency's SPECIALIZED terminology for every
  // t() call in the kiosk tree ("Patient" instead of "Customer" for a clinic,
  // "Client" for a law firm...). Silent-degrade: unpaired / fetch failure →
  // standard dictionary words.
  useCategoryTermScope(agency?.category || null);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  // 0.6.104 — the optional customer-name step was REMOVED (user request:
  // reserve directly from services). customerName is intentionally gone: every
  // join is anonymous (server stores 'Anonymous' when the name is absent).
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  // 0.6.114 — kiosk-side default-printer sheet (visible on the setup screens
  // once the kiosk is paired — the operator surface, never on customer steps).
  const [printerSettingsOpen, setPrinterSettingsOpen] = useState(false);
  const [ticketQrUrl, setTicketQrUrl] = useState<string | null>(null);
  const [showQrDetail, setShowQrDetail] = useState(false);

  // Retry tracking
  const [retryCount, setRetryCount] = useState(0);
  const [showContactAdmin, setShowContactAdmin] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Device registration state
  const [deviceToken, setDeviceToken] = useState(() => loadDeviceToken());
  const [deviceId, setDeviceId] = useState(() => loadDeviceId());
  const [isDeviceRegistered, setIsDeviceRegistered] = useState(false);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const agencyCodeRef = useRef(agencyCode);
  useEffect(() => { agencyCodeRef.current = agencyCode; }, [agencyCode]);

  // 0.6.91 — device event stream: kiosk mode ENTERED (was invisible before —
  // support could not tell whether a kiosk ever reached this surface).
  const kioskEnterLoggedRef = useRef(false);
  useEffect(() => {
    if (kioskEnterLoggedRef.current) return;
    kioskEnterLoggedRef.current = true;
    try {
      logDevice('kiosk_enter', 'Kiosk mode entered (device surface mounted)', { deviceType: 'KIOSK' });
    } catch { /* never block the kiosk */ }
  }, []);

  // ─── 0.6.99 — device-surface flag + Electron beacon identity ──────────
  // (1) The flag lets getApiBaseUrl() point a kiosk running INSIDE the
  //     desktop webview at a REMOTE branch desktop it discovered (a kiosk PC
  //     is a terminal of the branch store, which holds the agency data and
  //     the pairing commands — its own local db is empty).
  // (2) The Electron IPC report makes the UDP beacon advertise the SAME
  //     fingerprint the kiosk registers with — the missing half of pairing
  //     (the manager paired the instanceId-only beacon card and the request
  //     never reached the waiting kiosk).
  useEffect(() => {
    setDeviceSurfaceActive(true);
    reportDeviceSurfaceIdentity('kiosk');
    return () => {
      setDeviceSurfaceActive(false);
      clearDeviceSurfaceIdentity();
    };
  }, []);

  // Inactivity timer
  const [inactivitySeconds, setInactivitySeconds] = useState(0);
  // 0.6.104 — auto-return timer after the receipt choice (fault 4: once the
  // operator has decided about printing, the kiosk must go back to the
  // services page for the next customer). Cleared on reset and unmount.
  const printResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Digital clock
  const [currentTime, setCurrentTime] = useState(new Date());
  const [lastStatusRefresh, setLastStatusRefresh] = useState<Date>(new Date());

  const realtime = useRealtime();
  const isOnline = useOnlineStatus();

  // Discovery mode
  const [discoveryToken, setDiscoveryToken] = useState('');
  const discoveryTokenRef = useRef('');
  const [discoveryStatus, setDiscoveryStatus] = useState<DiscoveryStatus>('idle');
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [pairingRequests, setPairingRequests] = useState<PairingRequest[]>([]);
  const discoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 0.6.112 — silent background re-register loop: when the cloud discover-
  // register keeps failing (slow/absent internet), the kiosk STILL waits on
  // the LAN (beacon + UDP offers + socket rooms) while this loop retries the
  // cloud identity every 10s. Cleared on adoption / back / reset / unmount.
  const discoveryRegisterRetryRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 0.6.112 — the retry loop must never yank the kiosk out of a later flow
  // step (accept → services): every exit path flips this off.
  const discoveryFlowActiveRef = useRef(false);
  // 0.6.113 — HARDENED PAIRING PROTOCOL: the LAN base the orphan row was
  // created on (captured the moment discover-register succeeded). After a
  // verified pairing the kiosk binds THAT store's orphan row too, so the
  // pair exists on BOTH ends (the historic "pairing is done but the kiosk
  // never shows as a paired device" fault — the kiosk's own store kept the
  // orphan in PAIRING forever).
  const orphanStoreBaseRef = useRef('');
  // 0.6.103 — IN-FLIGHT GUARD: accept/reject must be a single-flight action.
  // During a connectivity flap every failed call just disappears into the
  // apiFetch failover chain (no visual change on the card), so operators
  // tapped Accept over and over — the logs show 10-12 accept-pairing POSTs
  // per SECOND. One request at a time, buttons disabled + spinner while it
  // runs: the button can no longer "look dead".
  const [pairingActionId, setPairingActionId] = useState<string | null>(null);
  const pairingActionRef = useRef(false);

  // ─── 0.6.101 — LIVE pairing-request delivery (socket rooms) ──────────────
  // The fallback poll is 2s (0.6.106 — the 5s poll made a request that missed
  // the socket channels feel "extremely slow"), but requests normally arrive
  // INSTANTLY through one of three channels: the LAN UDP offer (device-to-
  // device, below), the pairing-wait socket rooms (local + cloud), and the
  // poll. While the kiosk is waiting for pairing it joins the public
  // `pairing-wait` rooms (keyed by its device id + stable fingerprint) and
  // the manager's pairing request is pushed into those rooms by both the
  // local API and the cloud. socket.io-client buffers the join while
  // disconnected and flushes it on connect; the effect re-runs whenever
  // `connected` flips, so a reconnect (which creates a fresh server-side
  // connection with NO rooms) re-joins automatically.
  const pairingWaitActive =
    discoveryStatus === 'waiting' || step === 'discovery' || step === 'pairing-approval';
  useEffect(() => {
    if (!pairingWaitActive) return;
    realtime.emit('join:pairing-wait', {
      deviceId: deviceId || undefined,
      fingerprint: getStableKioskFingerprint(),
    });
  }, [pairingWaitActive, deviceId, realtime.connected, realtime]);

  useEffect(() => {
    if (!pairingWaitActive) return;
    const handler = (...args: unknown[]) => {
      const payload = args[0] as Partial<PairingRequest> | undefined;
      if (!payload || typeof payload.id !== 'string' || !payload.id) return;
      const agencyId = typeof payload.agencyId === 'string' ? payload.agencyId : '';
      if (!agencyId) return;
      // Build the full request BEFORE the updater so TypeScript keeps the
      // narrowed types (the guard above guarantees id/agencyId are strings).
      const request: PairingRequest = {
        id: payload.id,
        agencyId,
        agencyName: payload.agencyName || '',
        agencyNameAr: payload.agencyNameAr || undefined,
        agencyNameFr: payload.agencyNameFr || undefined,
        branchName: payload.branchName || undefined,
        sentByName: payload.sentByName || undefined,
        deviceToken: payload.deviceToken || undefined,
        sentAt: payload.sentAt || new Date().toISOString(),
      };
      // Dedupe: the same request may also arrive through the LAN offer or the poll.
      setPairingRequests((prev) => {
        if (prev.some((r) => r.id === request.id)) return prev;
        return [...prev, request];
      });
    };
    return realtime.on('pairing-request', handler);
  }, [pairingWaitActive, realtime]);

  // ─── 0.6.106 → 0.6.107 — DEVICE-TO-DEVICE pairing offers (UDP :3082, LAN) ─
  // The manager's desktop unicasts the pairing offer STRAIGHT to this device
  // while the beacon announces — no cloud round-trip. The native plugin
  // bridges the datagram here as 'blastiPairingOffer'; we map it to the same
  // PairingRequest shape the socket/poll channels use. When the offer carries
  // the manager's LAN address, the ACCEPT posts directly to THAT desktop.
  // 0.6.107 — the offer ALSO pins the manager as this kiosk's LAN base and
  // repoints the realtime socket at it: from that moment every device
  // operation (heartbeat, services, join-queue, print, queue calls) runs
  // device-to-device over the Wi-Fi/LAN and NEVER through the cloud — even
  // with the internet completely down.
  useEffect(() => {
    if (!pairingWaitActive) return;
    return onLanPairingOffer((offer: LanPairingOffer) => {
      const commandId = typeof offer.commandId === 'string' ? offer.commandId : (typeof offer.id === 'string' ? offer.id : '');
      const agencyId = typeof offer.agencyId === 'string' ? offer.agencyId : '';
      if (!commandId || !agencyId) return;
      const offerManagerIp = typeof offer.managerIp === 'string' ? offer.managerIp : undefined;
      const offerManagerPort = typeof offer.managerPort === 'number' ? offer.managerPort : undefined;
      if (offerManagerIp) {
        try {
          const base = `http://${offerManagerIp}:${offerManagerPort || 3080}`;
          if (getKioskLanBase() !== base) {
            setKioskLanBase(base);
            repointRealtimeToLanBase(base);
          }
        } catch { /* pin is best-effort — the accept still goes LAN-direct */ }
      }
      const request: PairingRequest = {
        id: commandId,
        agencyId,
        agencyName: typeof offer.agencyName === 'string' ? offer.agencyName : '',
        agencyNameAr: typeof offer.agencyNameAr === 'string' ? offer.agencyNameAr : undefined,
        agencyNameFr: typeof offer.agencyNameFr === 'string' ? offer.agencyNameFr : undefined,
        sentByName: typeof offer.sentByName === 'string' ? offer.sentByName : undefined,
        deviceToken: typeof offer.deviceToken === 'string' ? offer.deviceToken : undefined,
        sentAt: typeof offer.sentAt === 'string' ? offer.sentAt : new Date().toISOString(),
        managerIp: offerManagerIp,
        managerPort: offerManagerPort,
      };
      try { logDevice('pairing_offer_lan', 'Pairing offer received DEVICE-TO-DEVICE over the LAN (UDP)', { deviceType: 'KIOSK', status: 'PENDING' }); } catch { /* never block */ }
      setPairingRequests((prev) => (prev.some((r) => r.id === request.id) ? prev : [...prev, request]));
    });
  }, [pairingWaitActive]);

  // Offline mode
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [offlineTickets, setOfflineTickets] = useState<OfflineTicket[]>(() => loadOfflineTickets());
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncCount, setSyncCount] = useState(0);
  const [agencyCache, setAgencyCache] = useState<AgencyCache | null>(() => loadAgencyCache());

  // LAN discovery
  const [lanServer, setLanServer] = useState<DiscoveredServer | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(true);

  // Kiosk's own IP (detected via WebRTC)
  const [kioskIp, setKioskIp] = useState<string | null>(null);

  // Step indicator labels (only shown for queue steps, not login).
  // 0.6.104 — the 'name' step is gone (services → join directly).
  const stepLabels: Record<string, string> = {
    code: t('kioskStepCode'),
    services: t('kioskStepService'),
    ticket: t('kioskStepTicket'),
  };

  // 0.6.104 — viewport classification drives the multi-layout responsive flow.
  const viewportSize = useKioskViewportSize();

  const languages: { code: 'ar' | 'fr' | 'en'; label: string }[] = [
    { code: 'ar', label: 'عربي' },
    { code: 'fr', label: 'FR' },
    { code: 'en', label: 'EN' },
  ];



  // ─── 0.6.107 — AUTO-CONNECT INFRASTRUCTURE (declared early) ───────────────
  // A paired kiosk must rejoin its agency on launch EVEN OFFLINE, from the
  // pinned desktop's local store. The first boot attempt can fire before the
  // LAN sweep has pinned a desktop (the call would have gone to the
  // unreachable cloud), so the discovery effect below retries the moment a
  // desktop is pinned. `userChoseStep` keeps any manual choice authoritative.
  const userChoseStep = useRef(false);
  const autoConnectBusyRef = useRef(false);
  const autoConnectDoneRef = useRef(false);
  const tryAutoConnectRef = useRef<() => Promise<void>>(async () => {});
  const retryAutoConnectAfterDiscovery = useCallback(() => {
    if (!loadDeviceToken()) return;
    if (autoConnectDoneRef.current || userChoseStep.current) return;
    if (autoConnectBusyRef.current) return;
    void tryAutoConnectRef.current();
  }, []);

  // ─── LAN Auto-Discovery ────────────────────────────────────
  // 0.6.99 — device surfaces prefer a REMOTE branch desktop: a kiosk/TV PC is
  // a terminal of the branch store (which holds the agency data and the
  // pairing commands) — its own local db is empty when nobody signed in, and
  // pairing/queue ops against it could never work. `selfIps` keeps the sweep
  // from pinning this machine as "remote". When no remote desktop answers,
  // the same-PC kiosk falls back to its own store (which IS the branch store
  // when the operator signed in here).
  useEffect(() => {
    let mounted = true;
    async function discover() {
      try {
        const server = await quickDiscover({
          preferRemote: true,
          selfIps: kioskIp ? [kioskIp] : [],
          // 0.6.103 — the device token lets the cloud-topology probe answer for
          // THIS kiosk (device-scope read) — the desktop's reported LAN IP is
          // pinned in ONE probe instead of the 6-18s four-subnet sweep.
          deviceToken: discoveryTokenRef.current || loadDeviceToken() || undefined,
        });
        if (mounted && server) {
          setLanServer(server);
          // 0.6.86 — ROOT FIX (store mismatch): pin the device API base to the
          // discovered desktop so register/pair/heartbeat hit the SAME local
          // store the desktop Device Manager polls. Without this, production
          // kiosks kept the baked cloud base and paired against the CLOUD
          // while the manager watched the LOCAL db — both sides waited forever.
          // 0.6.107 — also repoint the realtime socket: all device ops now
          // run device-to-device over the LAN (offline-capable).
          const pinnedBase = `http://${server.ip}:${server.apiPort || server.port || 3080}`;
          if (getKioskLanBase() !== pinnedBase) {
            setKioskLanBase(pinnedBase);
            repointRealtimeToLanBase(pinnedBase);
          }
          console.log(`[Kiosk] Auto-connected to LAN server: ${server.hostname} (${server.ip})`);
          // 0.6.107 — the sweep may finish AFTER the boot auto-connect attempt
          // ran against a stale/absent pin. Retry auto-connect now that a
          // desktop is pinned (paired device must rejoin its agency offline).
          retryAutoConnectAfterDiscovery();
        }
      } catch (err) {
        console.warn('[Kiosk] LAN discovery failed, using cloud:', err);
      } finally {
        if (mounted) setIsDiscovering(false);
      }
    }
    discover();
    return () => { mounted = false; };
    // retryAutoConnectAfterDiscovery is a stable callback (no deps) — it
    // re-runs boot auto-connect once the sweep pins a LAN desktop.
  }, [kioskIp, retryAutoConnectAfterDiscovery]);

  // ─── Detect Kiosk's Own IP ──────────────────────────────────
  useEffect(() => {
    let mounted = true;
    getLocalIp().then((ip) => {
      if (mounted && ip) {
        setKioskIp(ip);
        console.log(`[Kiosk] Detected local IP: ${ip}`);
      }
    });
    return () => { mounted = false; };
  }, []);

  // Fallback: if WebRTC couldn't detect IP but we know the LAN server IP,
  // the kiosk is likely on the same machine/subnet — use that as a hint.
  const displayKioskIp = kioskIp || (lanServer ? lanServer.ip : null);

  // Persist agency code
  useEffect(() => { saveAgencyCode(agencyCode); }, [agencyCode]);

  // ─── Offline mode detection ────────────────────────────────
  useEffect(() => {
    setIsOfflineMode(!isOnline);
    if (isOnline) syncOfflineTickets();
  }, [isOnline]);

  // Cache agency data when loaded
  useEffect(() => {
    if (!agency || services.length === 0) return;
    try {
      const cache: AgencyCache = { agency, services, lastIssuedNumbers: {}, cachedAt: Date.now() };
      const prevCache = localStorage.getItem('blasti-kiosk-agency-cache');
      if (prevCache) {
        try {
          const parsed = JSON.parse(prevCache) as AgencyCache;
          if (parsed.agency.id === agency.id) cache.lastIssuedNumbers = parsed.lastIssuedNumbers || {};
        } catch { /* ignore */ }
      }
      saveAgencyCache(cache);
      setAgencyCache(cache);
    } catch { /* ignore */ }
  }, [agency, services]);

  // ─── Digital Clock ─────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // ─── Device Heartbeat ──────────────────────────────────────
  // 0.6.95 — heartbeat dedupe (field log: HTTP 429 "Heartbeat too frequent"
  // on POST /api/agency-devices/device/heartbeat): startDeviceHeartbeat is
  // restarted from several effects (lanServer discovery, auto-connect,
  // fetchAgency success incl. its auto-retry loop, accept-pairing) and every
  // restart fired an IMMEDIATE beat. Two beats <10s apart trip the server's
  // per-device cap and get logged as tracked bugs. Guard both sides: a
  // restart with the SAME token keeps the existing timer, and a beat fired
  // inside the server's 10s window is skipped silently.
  const lastHeartbeatTokenRef = useRef<string>('');
  const heartbeatLastSentAtRef = useRef<number>(0);

  const startDeviceHeartbeat = useCallback((token: string) => {
    if (heartbeatTimerRef.current && lastHeartbeatTokenRef.current === token) return;
    lastHeartbeatTokenRef.current = token;
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    const sendHeartbeat = async () => {
      const nowMs = Date.now();
      if (nowMs - heartbeatLastSentAtRef.current < 10_000) return;
      heartbeatLastSentAtRef.current = nowMs;
      try {
        const res = await apiFetch('/api/agency-devices/device/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ appVersion: APP_VERSION, ipAddress: kioskIp || lanServer?.ip || undefined }),
        });
        if (res.status === 401) {
          console.warn('[Kiosk] Heartbeat 401 — token invalid, clearing credentials');
          handleForgetDevice();
          return;
        }
        if (res.ok) {
          const body = await res.json().catch(() => null);
          const commands: Array<{ id: string; type: string }> = body?.pendingCommands ?? [];
          const forceDisconnectCmd = commands.find(c => c.type === 'FORCE_DISCONNECT');
          if (forceDisconnectCmd) {
            try {
              await apiFetch(`/api/agency-devices/device/command/${forceDisconnectCmd.id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ status: 'DELIVERED' }) });
            } catch {}
            // Device was unpaired — clear local state and return to login
            if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
            removeDeviceToken();
            // removeDeviceId() call removed (hotfix 0.6.12): no such export
            // exists — this threw a ReferenceError on every FORCE_DISCONNECT
            // (device unpair) and took down the kiosk heartbeat flow. The
            // persisted device id IS cleared by removeDeviceToken() above
            // (it removes both DEVICE_TOKEN_KEY and DEVICE_ID_KEY).
            removeAgencyCode();
            setDeviceToken('');
            setDeviceId('');
            setAgency(null);
            setServices([]);
            setQueueStats(null);
            setSelectedService(null);
            setTicket(null);
            setStep('method-select');
            setIsDeviceRegistered(false);
            if (discoveryPollRef.current) clearInterval(discoveryPollRef.current);
            discoveryPollRef.current = null;
            setDiscoveryStatus('idle');
            setDiscoveryToken('');
            discoveryTokenRef.current = '';
            setPairingRequests([]);
            toast.error(t('deviceUnpairedByAdmin') || 'Device was unpaired by the agency administrator');
            return;
          }
          const rebootCmd = commands.find(c => c.type === 'REBOOT');
          const refreshCmd = commands.find(c => c.type === 'REFRESH');
          if (rebootCmd || refreshCmd) {
            const cmd = rebootCmd || refreshCmd;
            try { await apiFetch(`/api/agency-devices/device/command/${cmd.id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ status: 'DELIVERED' }) }); } catch {}
            window.location.reload();
            return;
          }
          const ackPromises = commands.map(cmd =>
            apiFetch(`/api/agency-devices/device/command/${cmd.id}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }, body: JSON.stringify({ status: 'DELIVERED' }) }).catch(() => {})
          );
          await Promise.allSettled(ackPromises);
          for (const cmd of commands) {
            if (cmd.type === 'CONFIG_UPDATE') fetchAgencyRef.current(agencyCodeRef.current.trim(), false);
          }
        }
      } catch { /* silent */ }
    };
    sendHeartbeat();
    heartbeatTimerRef.current = setInterval(sendHeartbeat, 30_000);
  }, [lanServer, kioskIp]);

  // ─── Credentials Login Handler ──────────────────────────────
  const handleCredentialsLogin = useCallback(async (code: string, token: string) => {
    setCredLoading(true);
    setCredError(null);
    try {
      const res = await apiFetch('/api/agency-devices/public/kiosk-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: code, deviceToken: token }),
      });
      const data = await res.json();
      if (data.success && data.agency) {
        setDeviceToken(data.deviceToken);
        saveDeviceToken(data.deviceToken);
        if (data.device?.id) { setDeviceId(data.device.id); saveDeviceId(data.device.id); }
        setAgency({
          id: data.agency.id,
          name: data.agency.name,
          nameAr: data.agency.nameAr,
          nameFr: data.agency.nameFr,
          category: data.agency.category || '',
          customCode: data.agency.customCode,
          logoUrl: data.agency.logoUrl,
          workingHoursStart: data.agency.workingHoursStart,
          workingHoursEnd: data.agency.workingHoursEnd,
          isQueueOpen: data.agency.isQueueOpen,
          isPaused: data.agency.isPaused,
        });
        setServices((data.agency.services || []).map((s: any) => ({
          id: s.id, name: s.name, nameAr: s.nameAr, nameFr: s.nameFr,
          prefix: s.prefix, avgTime: 0,
        })));
        if (data.agency.customCode) { setAgencyCode(data.agency.customCode); saveAgencyCode(data.agency.customCode); }
        setIsDeviceRegistered(true);
        startDeviceHeartbeat(data.deviceToken);
        if (data.agency.isQueueOpen && !data.agency.isPaused) setStep('services');
        else setStep('services');
        // 0.6.91 — device event stream: kiosk credentials accepted.
        try {
          logDevice('kiosk_auth_success', `Kiosk authenticated (pairing code accepted) — agency ${data.agency.name || ''}`, { deviceId: data.device?.id || undefined, deviceType: data.device?.type || 'KIOSK', agencyId: data.agency.id, status: 'ONLINE' });
        } catch { /* never block the kiosk */ }
        toast.success(t('kioskPairedSuccessfully') || 'Connected!');
      } else {
        // 0.6.91 — device event stream: kiosk credentials rejected.
        try {
          logDevice('kiosk_auth_failed', `Kiosk authentication failed: ${data.error || 'rejected'}`, { deviceType: 'KIOSK', status: data.error ? 'INVALID' : undefined }, 'warn');
        } catch { /* never block the kiosk */ }
        setCredError(data.error || 'Authentication failed');
      }
    } catch {
      // 0.6.91 — device event stream: kiosk auth network failure.
      try {
        logDevice('kiosk_auth_failed', 'Kiosk authentication failed — network error', { deviceType: 'KIOSK' }, 'error');
      } catch { /* never block the kiosk */ }
      setCredError('Network error');
    } finally {
      setCredLoading(false);
    }
  }, [t, startDeviceHeartbeat]);

  // Restart heartbeat when LAN server is discovered
  useEffect(() => {
    if (deviceToken && lanServer) startDeviceHeartbeat(deviceToken);
  }, [lanServer]);

  // ─── Forget Device ─────────────────────────────────────────
  const handleForgetDevice = useCallback(() => {
    if (deviceToken) realtime.emit('leave:device');
    setDeviceToken('');
    setDeviceId('');
    setIsDeviceRegistered(false);
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    lastHeartbeatTokenRef.current = '';
    heartbeatLastSentAtRef.current = 0;
    removeDeviceToken();
    // 0.6.91 — device event stream: device forgotten / kiosk logged out.
    try { logDevice('kiosk_exit', 'Kiosk device forgotten — credentials cleared locally', { deviceType: 'KIOSK' }); } catch { /* never block */ }
  }, [deviceToken, realtime]);

  // ─── Fetch Agency (with retry) ─────────────────────────────
  const fetchAgencyRef = useRef<(code: string, isAutoRetry?: boolean) => void>(() => {});

  const fetchAgency = useCallback(async (code: string, isAutoRetry = false) => {
    if (!code.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const fetchHeaders: Record<string, string> = {};
      if (deviceToken) fetchHeaders['Authorization'] = `Bearer ${deviceToken}`;
      const res = await apiFetch(`/api/agency-devices/public/agency?code=${encodeURIComponent(code.trim())}`, { headers: fetchHeaders });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Agency not found');
        setRetryCount((prev) => {
          const next = prev + 1;
          if (next >= MAX_RETRIES) {
            setShowContactAdmin(true);
          } else {
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
              fetchAgencyRef.current(code, true);
            }, BACKOFF_DELAYS[Math.min(next - 1, BACKOFF_DELAYS.length - 1)]);
          }
          return next;
        });
        return;
      }
      setRetryCount(0);
      setShowContactAdmin(false);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      setAgency(data.agency);
      setServices(data.services || []);
      setQueueStats(data.queueStats);
      if (data.agency.isQueueOpen && !data.agency.isPaused) setStep('services');

      // Auto-register if needed
      if (!deviceToken) {
        try {
          const regRes = await apiFetch('/api/agency-devices/public/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agencyCode: code.trim(), deviceName: 'BLASTI Kiosk', deviceType: 'KIOSK', connectionType: lanServer ? 'LAN' : 'WIFI', deviceFingerprint: getStableKioskFingerprint() }),
          });
          // 0.6.119 — 409 = the manager deleted this device: drop the saved
          // branch code so the kiosk stops silently re-registering ghosts on
          // every mount (the removed-device tombstone is manager-lifted only).
          if (regRes.status === 409) {
            removeAgencyCode();
            try { logDevice('device_removed_by_manager', 'auto-register blocked by the removed-device tombstone — saved branch code cleared', { deviceType: 'KIOSK', status: 'REMOVED' }, 'warn'); } catch { /* never block */ }
          }
          const regData = await regRes.json();
          if (regData.success && regData.deviceToken) {
            setDeviceToken(regData.deviceToken);
            setDeviceId(regData.device.id);
            setIsDeviceRegistered(true);
            saveDeviceToken(regData.deviceToken);
            saveDeviceId(regData.device.id);
            startDeviceHeartbeat(regData.deviceToken);
          }
        } catch (err) {
          console.warn('[Kiosk] Device registration failed, continuing in public mode:', err);
        }
      } else {
        setIsDeviceRegistered(true);
        startDeviceHeartbeat(deviceToken);
      }
    } catch {
      setError('Network error');
      // 0.6.107 — OFFLINE-FIRST BOOT: when the agency fetch fails (desktop
      // rebooting, AP isolation, internet completely down) but this kiosk has
      // a saved cache for the SAME agency, adopt it immediately — services
      // stay selectable and tickets keep issuing offline. The retry/backoff
      // + contact-admin ladder only applies when there is nothing cached.
      const cached = agencyCache;
      if (cached && (cached.agency.customCode || '') === code.trim()) {
        setAgency(cached.agency);
        setServices(cached.services || []);
        setRetryCount(0);
        setShowContactAdmin(false);
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
        if (cached.agency.isQueueOpen !== false) setStep('services');
        try { logDevice('kiosk_offline_cache', 'Agency fetch failed — serving the saved agency cache (offline device-to-device mode)', { deviceType: 'KIOSK', status: 'OFFLINE' }); } catch { /* never block */ }
        return;
      }
      setRetryCount((prev) => {
        const next = prev + 1;
        if (next >= MAX_RETRIES) {
          setShowContactAdmin(true);
        } else {
          if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
          retryTimerRef.current = setTimeout(() => {
            fetchAgencyRef.current(code, true);
          }, BACKOFF_DELAYS[Math.min(next - 1, BACKOFF_DELAYS.length - 1)]);
        }
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [deviceToken, lanServer, startDeviceHeartbeat, agencyCache]);

  useEffect(() => { fetchAgencyRef.current = fetchAgency; }, [fetchAgency]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      // 0.6.104 — clear the pending post-print auto-return.
      if (printResetTimerRef.current) clearTimeout(printResetTimerRef.current);
    };
  }, []);

  // ─── 0.6.96 — LAN pairing beacon while the kiosk waits for pairing ──────
  // USER REQUEST (0.6.96): "update kiosk mode waiting-for-discovery mode to
  // send signals to expose itself, waiting for pairing requests from the
  // BLASTI app". The beacon now announces on EVERY pre-pairing screen —
  // method chooser, branch code, credentials, QR, discovery — not just two of
  // them. The device exposes itself, the manager's scan (or the live beacon
  // feed) shows it, and the operator sends a pairing request. The beacon uses
  // the STABLE fingerprint so pairing-by-identity matches across restarts.
  useEffect(() => {
    const announcing =
      step !== 'services' &&
      step !== 'ticket' &&
      discoveryStatus !== 'discovered' &&
      discoveryStatus !== 'connecting' &&
      // 0.6.113 — the final registration check is mid-pairing: this device
      // must NOT advertise "ready-for-pairing" while the verification runs.
      discoveryStatus !== 'verifying';
    if (!announcing) return;
    void startPairingBeacon({
      name: 'BLASTI App',
      uid: getStableKioskFingerprint(),
      status: 'ready-for-pairing',
      // 0.6.102 — audit fix: the kiosk beacon never carried its surface, so
      // the scanner classified this device as a generic PHONE card. The
      // manager's strict result filters need mode 'kiosk' to render it as
      // "PHONE/TABLET WITH BLASTI APP IN KIOSK MODE".
      mode: 'kiosk',
    });
    return () => { void stopPairingBeacon(); };
  }, [step, discoveryStatus]);


  // Auto-fetch agency on mount if code was saved
  useEffect(() => { if (agencyCode.trim()) fetchAgency(agencyCode.trim()); }, []);

  // ─── Refresh Queue Status ──────────────────────────────────
  const refreshKioskStatus = useCallback(async (agencyId: string) => {
    try {
      const statusHeaders: Record<string, string> = {};
      if (deviceToken) statusHeaders['Authorization'] = `Bearer ${deviceToken}`;
      const res = await apiFetch(`/api/agency-devices/public/queue-status?agencyId=${agencyId}`, { headers: statusHeaders });
      if (res.ok) {
        const data = await res.json();
        setQueueStats({ waiting: data.totalWaiting ?? 0, currentServing: data.currentlyServing?.[0]?.ticketNumber ?? null, estimatedWait: data.totalEstimatedWait ?? 0, currentlyServingList: data.currentlyServing ?? [] });
        setLastStatusRefresh(new Date());
      }
    } catch { /* silent */ }
  }, [deviceToken]);

  // Auto-refresh queue status every 30s
  useEffect(() => {
    if (!agency) return;
    refreshKioskStatus(agency.id);
    const interval = setInterval(() => refreshKioskStatus(agency.id), 30000);
    return () => clearInterval(interval);
  }, [agency, refreshKioskStatus]);

  // Faster refresh on ticket screen (every 10s)
  useEffect(() => {
    if (step !== 'ticket' || !agency) return;
    const interval = setInterval(() => refreshKioskStatus(agency.id), 10000);
    return () => clearInterval(interval);
  }, [step, agency, refreshKioskStatus]);

  // ─── Realtime subscriptions ────────────────────────────────
  useEffect(() => {
    if (!agency?.id) return;
    if (deviceToken) { realtime.emit('join:device', deviceToken); } else { realtime.joinKiosk(agency.id); }
    return () => {
      if (deviceToken) realtime.emit('leave:device');
      realtime.leaveKiosk(agency.id);
    };
  }, [agency?.id, deviceToken, realtime]);

  useEffect(() => {
    if (!agency?.id) return;
    const unsubscribers: (() => void)[] = [];
    const handleKioskEvent = () => refreshKioskStatus(agency.id);
    unsubscribers.push(realtime.onKioskUpdate(handleKioskEvent));
    unsubscribers.push(realtime.onQueueCalled(handleKioskEvent));
    unsubscribers.push(realtime.onQueuePaused(handleKioskEvent));
    unsubscribers.push(realtime.onQueueResumed(handleKioskEvent));
    unsubscribers.push(realtime.onQueueCompleted(handleKioskEvent));
    unsubscribers.push(realtime.onQueueJoined(handleKioskEvent));
    return () => { unsubscribers.forEach(unsub => unsub()); };
  }, [agency?.id, realtime, refreshKioskStatus]);

  // ─── Inactivity Timer ──────────────────────────────────────
  const handleReset = useCallback(() => {
    setStep('services');
    setQueueStats(null);
    setSelectedService(null);
    setTicket(null);
    setTicketQrUrl(null);
    setShowQrDetail(false);
    setError(null);
    setInactivitySeconds(0);
    setShowConfetti(false);
    setRetryCount(0);
    setShowContactAdmin(false);
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    // 0.6.104 — a pending post-print auto-return is satisfied by any reset.
    if (printResetTimerRef.current) { clearTimeout(printResetTimerRef.current); printResetTimerRef.current = null; }
  }, []);

  useEffect(() => {
    if (step !== 'ticket') { setInactivitySeconds(0); return; }
    const interval = setInterval(() => {
      setInactivitySeconds((prev) => {
        if (prev >= 60) { handleReset(); return 0; }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [step, handleReset]);

  const resetInactivity = useCallback(() => {
    if (step === 'ticket') setInactivitySeconds(0);
  }, [step]);

  useEffect(() => {
    if (step !== 'ticket') return;
    const events = ['touchstart', 'click', 'keydown'] as const;
    const handler = () => resetInactivity();
    events.forEach((e) => window.addEventListener(e, handler));
    return () => { events.forEach((e) => window.removeEventListener(e, handler)); };
  }, [step, resetInactivity]);

  // ─── Sync Offline Tickets ──────────────────────────────────
  const syncOfflineTickets = useCallback(async () => {
    try {
      const stored = localStorage.getItem('blasti-kiosk-offline-tickets');
      if (!stored) return;
      const tickets: OfflineTicket[] = JSON.parse(stored);
      const unsynced = tickets.filter(tk => !tk.synced);
      if (unsynced.length === 0) return;
      setSyncStatus('syncing');
      let synced = 0;
      for (const offlineTicket of unsynced) {
        try {
          const joinHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (deviceToken) joinHeaders['Authorization'] = `Bearer ${deviceToken}`;
          const res = await apiFetch('/api/agency-devices/public/join-queue', {
            method: 'POST',
            headers: joinHeaders,
            body: JSON.stringify({ agencyId: offlineTicket.agencyId, serviceId: offlineTicket.serviceId, customerName: offlineTicket.customerName || undefined }),
          });
          if (res.ok) { offlineTicket.synced = true; synced++; }
        } catch { /* retry next time */ }
      }
      const remaining = tickets.filter(tk => !tk.synced);
      saveOfflineTickets(remaining);
      setOfflineTickets(remaining);
      if (synced > 0) {
        // Queue event log — ONE event per sync run (never per ticket).
        try {
          logQueue('kiosk_ticket_synced', `${synced} offline ticket(s) synced to the server`, {
            agencyId: unsynced[0]?.agencyId || undefined,
            count: synced,
            remaining: remaining.length,
          });
        } catch { /* never block */ }
        setSyncCount(synced);
        setSyncStatus('success');
        toast.success(`${synced} ${t('kioskTicketsSynced')}`);
        setTimeout(() => setSyncStatus('idle'), 5000);
      } else if (unsynced.length > 0) {
        setSyncStatus('error');
        setTimeout(() => setSyncStatus('idle'), 5000);
      } else { setSyncStatus('idle'); }
    } catch {
      setSyncStatus('error');
      setTimeout(() => setSyncStatus('idle'), 5000);
    }
  }, [deviceToken, t]);

  // ─── Join Queue ────────────────────────────────────────────
  const joiningRef = useRef(false);

  // 0.6.95 — self-heal for the join 403 ("Device not authorized for this
  // agency"): the persisted token can belong to an orphan registration (a
  // different store, an old agency, or a pre-pairing discovery). Instead of
  // surfacing a permissions error, clear the stale credentials, register a
  // FRESH device against the CURRENT API base, and retry the join once.
  const reregisterAndRetryJoin = async (
    agencyId: string,
    serviceId: string,
    customerName: string | undefined,
  ): Promise<{ ok: boolean; data?: any }> => {
    try {
      removeDeviceToken();
      lastHeartbeatTokenRef.current = '';
      setDeviceToken('');
      setDeviceId('');
      setIsDeviceRegistered(false);
      const regRes = await apiFetch('/api/agency-devices/public/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyCode: agency.customCode || agencyCodeRef.current || '',
          deviceName: 'BLASTI Kiosk',
          deviceType: 'KIOSK',
          connectionType: lanServer ? 'LAN' : 'WIFI',
          deviceFingerprint: getStableKioskFingerprint(),
        }),
      });
      const regData = await regRes.json();
      // 0.6.119 — join self-heal must respect the removed-device tombstone:
      // 409 = the manager deleted this device — clear the branch code and
      // refuse to mint a replacement row.
      if (regRes.status === 409 || regData?.removed) {
        removeAgencyCode();
        try { logDevice('device_removed_by_manager', 'join self-heal register blocked by the removed-device tombstone — branch code cleared', { deviceType: 'KIOSK', status: 'REMOVED' }, 'warn'); } catch { /* never block */ }
        return { ok: false };
      }
      if (!regData?.success || !regData.deviceToken) return { ok: false };
      setDeviceToken(regData.deviceToken);
      setDeviceId(regData.device?.id || '');
      setIsDeviceRegistered(true);
      saveDeviceToken(regData.deviceToken);
      if (regData.device?.id) saveDeviceId(regData.device.id);
      startDeviceHeartbeat(regData.deviceToken);
      const retry = await apiFetch('/api/agency-devices/public/join-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${regData.deviceToken}` },
        body: JSON.stringify({ agencyId, serviceId, customerName }),
      });
      const retryData = await retry.json();
      return retryData?.success ? { ok: true, data: retryData } : { ok: false };
    } catch {
      return { ok: false };
    }
  };

  const handleJoinQueue = async () => {
    if (!agency || !selectedService) return;
    if (joiningRef.current) return;
    joiningRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const joinHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (deviceToken) joinHeaders['Authorization'] = `Bearer ${deviceToken}`;
      const res = await apiFetch('/api/agency-devices/public/join-queue', {
        method: 'POST',
        headers: joinHeaders,
        // 0.6.104 — name step removed: kiosk joins are anonymous (the server
        // already stores 'Anonymous' when customerName is absent).
        body: JSON.stringify({ agencyId: agency.id, serviceId: selectedService }),
      });
      const data = await res.json();
      if (!data.success) {
        // 0.6.95 — self-heal: a 403 "Device not authorized for this agency"
        // means the persisted device token is stale/orphaned/cross-agency.
        // Re-register against the CURRENT base and retry once instead of
        // showing the kiosk a permissions failure (the field-log CRITICAL).
        if (res.status === 403 && /not authorized/i.test(String(data.error || ''))) {
          const healed = await reregisterAndRetryJoin(agency.id, selectedService, undefined);
          if (healed.ok && healed.data) {
            const rd = healed.data;
            try {
              logQueue('ticket_created_kiosk', `Kiosk ticket ${rd.reservation?.ticketNumber || ''} issued (self-healed registration)`.trim(), {
                agencyId: agency.id,
                serviceId: selectedService,
                deviceId: rd.deviceId || deviceId || undefined,
                ticketId: rd.reservation?.id,
                ticketNumber: rd.reservation?.ticketNumber,
                source: 'kiosk',
              });
            } catch { /* never block */ }
            setTicket(rd.reservation);
            setStep('ticket');
            setInactivitySeconds(0);
            setShowQrDetail(false);
            if (rd.reservation?.importToken) {
              // 0.6.110 — resolve a phone-reachable claim base (desktop LAN IP
              // via the /api/discover beacon, else the current origin, else
              // the cloud URL) instead of the kiosk window's loopback origin.
              const claimUrl = await buildClaimUrl(rd.reservation.importToken);
              const qrUrl = await generateQRDataURL(claimUrl, { width: 200 });
              setTicketQrUrl(qrUrl);
            } else { setTicketQrUrl(null); }
            setShowConfetti(true);
            setTimeout(() => setShowConfetti(false), 3500);
            return;
          }
        }
        // Queue event log — kiosk join failed (endpoint error included).
        try { logQueue('ticket_created_kiosk', `Kiosk join failed: ${data.error || 'rejected'}`, { agencyId: agency.id, serviceId: selectedService, deviceId: data.deviceId || deviceId || undefined, source: 'kiosk' }, 'error'); } catch { /* never block */ }
        setError(data.error || 'Failed to join queue');
        return;
      }
      // Queue event log — kiosk ticket created (success; ticket identity from
      // the response's reservation mirror).
      try {
        logQueue('ticket_created_kiosk', `Kiosk ticket ${data.reservation?.ticketNumber || ''} issued`.trim(), {
          agencyId: agency.id,
          serviceId: selectedService,
          deviceId: data.deviceId || deviceId || undefined,
          ticketId: data.reservation?.id,
          ticketNumber: data.reservation?.ticketNumber,
          source: 'kiosk',
        });
      } catch { /* never block */ }
      setTicket(data.reservation);
      setStep('ticket');
      setInactivitySeconds(0);
      setShowQrDetail(false);
      if (data.reservation?.importToken) {
        // 0.6.110 — phone-reachable claim base (see buildClaimUrl).
        const claimUrl = await buildClaimUrl(data.reservation.importToken);
        const qrUrl = await generateQRDataURL(claimUrl, { width: 200 });
        setTicketQrUrl(qrUrl);
      } else { setTicketQrUrl(null); }
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3500);
    } catch {
      // Queue event log — kiosk join network failure.
      try { logQueue('ticket_created_kiosk', 'Kiosk join failed — network error', { agencyId: agency?.id, serviceId: selectedService || undefined, source: 'kiosk' }, 'error'); } catch { /* never block */ }
      // 0.6.107 — OFFLINE-FIRST GUARANTEE: a network failure must NEVER block
      // ticket issuance. Whether the pinned desktop is rebooting, the AP
      // isolated this device, or the internet is gone, the kiosk issues the
      // ticket LOCALLY from the saved cache (numbering cursor included) and
      // syncs it automatically once the desktop answers again.
      setError(null);
      handleOfflineJoinQueue();
    }
    finally { setLoading(false); joiningRef.current = false; }
  };

  // ─── Print Ticket ──────────────────────────────────────────
  // 0.6.104 — after the receipt choice the kiosk AUTO-RETURNS to the services
  // page for the next customer (1.8s after a SUCCESSFUL print so the success
  // toast is readable). On print FAILURE the error banner stays visible and
  // the operator taps "Done — next customer" manually — the kiosk is never
  // trapped on a failed print.
  const schedulePostPrintReset = useCallback(() => {
    if (printResetTimerRef.current) clearTimeout(printResetTimerRef.current);
    // 0.6.104 — auto-return to services for the next customer after the receipt choice.
    printResetTimerRef.current = setTimeout(() => { handleReset(); }, 1800);
  }, [handleReset]);

  const handlePrint = async () => {
    if (!ticket) return;
    if (typeof window !== 'undefined' && (window as any).electronAPI?.printSilent) {
      try {
        const result = await (window as any).electronAPI.printSilent();
        if (!result?.success) {
          // Failure — keep the error visible; NO auto-return.
          toast.error(t('printerError'));
          setPrintError(result?.message || t('printerErrorMessage'));
          return;
        }
        schedulePostPrintReset();
        return;
      } catch { toast.error(t('printerError')); setPrintError('Failed to communicate with printer'); return; }
    }
    // 0.6.78 → 0.6.114 — DIRECT PRINT ONLY (user requirement: "print receipt
    // button in kiosk should not open the receipt — directly print the
    // receipt using the selected printer as default option for kiosk
    // printing"). The old browser popup fallback (window.open + a printable
    // receipt page) is REMOVED: a kiosk never OPENS the receipt, it PRINTS
    // it. The desktop local API resolves the target printer in order:
    //   1. the printer ASSIGNED to this kiosk (printerConfig
    //      .defaultPrinterDeviceId — the "Default printer" select on this
    //      kiosk's card in the Device Manager),
    //   2. the agency's saved default printer (last resort),
    // and delivers by host-forward (USB printer on a branch PC), os-print
    // (locally attached) or raw TCP/ESC-POS (network printer).
    let serverError = '';
    try {
      const printRes = await apiFetch('/api/agency-devices/discovery/print', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(deviceToken ? { 'X-Device-Token': deviceToken } : {}),
        },
        body: JSON.stringify({
          // 0.6.104 — the kiosk's device id lets the desktop print route resolve
          // the printer ASSIGNED to this kiosk (printerConfig.defaultPrinterDeviceId)
          // and fall back to the agency default printer when none is assigned.
          deviceId: deviceId || undefined,
          ticket: {
            agencyName: ticket.agencyName,
            branchName: ticket.branchName || undefined,
            ticketNumber: ticket.ticketNumber,
            lines: [
              ticket.serviceName || '',
              ticket.customerName ? `Customer: ${ticket.customerName}` : '',
              ticket.joinedAt ? new Date(ticket.joinedAt).toLocaleString('en-GB') : '',
              `Wait: ~${ticket.estimatedWaitMinutes} min`,
            ].filter(Boolean),
            // 0.6.110 — phone-reachable claim base on the ESC-POS receipt QR.
            qrData: ticket.importToken ? await buildClaimUrl(ticket.importToken) : undefined,
            footer: 'BLASTI',
          },
        }),
      });
      const printData = await printRes.json().catch(() => ({}));
      if (printRes.ok && printData.success) {
        toast.success(t('printTicket') || 'Ticket sent to printer');
        // 0.6.104 — successful LAN print → auto-return for the next customer.
        schedulePostPrintReset();
        return;
      }
      serverError = (printData && typeof printData.error === 'string' && printData.error)
        || `Print failed (server ${printRes.status})`;
    } catch {
      serverError = t('kioskPrinterUnreachable') || 'Printer service unreachable — check that the branch PC is running BLASTI on the same network';
    }
    // 0.6.114 — FAILURE: NO popup, NO receipt window. An explicit,
    // actionable error instead — the "No printer target" answer means the
    // kiosk has no assigned printer AND the agency has no default printer.
    const noPrinter = /No printer target|default printer/i.test(serverError);
    const finalMsg = noPrinter
      ? `${serverError} — ${t('kioskNoPrinterConfigured') || 'no default printer is set for this kiosk — open the Device Manager on the branch PC, open this kiosk card and pick a Default printer (or save an agency default printer)'}`
      : serverError;
    toast.error(t('printerError'));
    setPrintError(finalMsg);
  };

  // ─── Code Submit ───────────────────────────────────────────
  // 0.6.86 — "connect by branch code" now ACTUALLY connects the kiosk to the
  // desktop: the entered code is resolved via the cloud lan-topology
  // registry (the desktop reports its LAN IP there every 30s) and the first
  // reachable host is pinned as the device API base BEFORE the agency
  // lookup, so the registration lands in the desktop's local store (the
  // store the manager's approval strip watches). A bare IPv4 in the same
  // field connects directly ("192.168.1.10" or "192.168.1.10:3080").
  const handleCodeSubmit = async () => {
    const code = agencyCode.trim();
    if (!code) return;
    setRetryCount(0);
    setShowContactAdmin(false);
    setError(null);
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    // Direct desktop IP entry (field accepts "192.168.x.x[:3080]").
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(code)) {
      setLoading(true);
      const pinned = await pinKioskLanBaseFromIp(code);
      setLoading(false);
      if (pinned) {
        toast.success(t('kioskPinnedToDesktop') || 'Connected to the desktop on this network');
        setLanServer(null);
      } else {
        toast.error(t('kioskDesktopUnreachable') || 'No BLASTI desktop answered at that address — check the IP and that the desktop app is running');
      }
      return;
    }
    // Branch-code cloud assist — only when no LAN server was discovered yet.
    if (!lanServer && !getKioskLanBase()) {
      setLoading(true);
      const resolved = await resolveBranchLanServer(code);
      if (resolved.server) {
        setKioskLanBase(`http://${resolved.server.ip}:${resolved.server.port}`);
        setLanServer({
          service: 'blasti-local', version: '', name: resolved.server.name || 'BLASTI Desktop',
          hostname: resolved.server.hostname || resolved.server.name || 'BLASTI Desktop',
          ip: resolved.server.ip, port: resolved.server.port, apiPort: resolved.server.port,
          webPort: 0, platform: '', uptime: 0,
        });
        toast.success(t('kioskPinnedToDesktop') || 'Connected to the desktop on this network');
      } else if (resolved.hosts.length > 0) {
        setLoading(false);
        toast.error(t('kioskDesktopUnreachable') || 'The branch desktop is registered but unreachable from this device — make sure both are on the same Wi-Fi network and the desktop app is running');
        return;
      }
      setLoading(false);
    }
    fetchAgency(code);
  };

  // ─── Discovery Login ───────────────────────────────────────
  // 0.6.105 — PAIRING SPEED: field logs showed discover-register failing with
  // a 15s caller abort ("Request was cancelled") whenever the store was busy
  // or the client's failover chain retried — the kiosk then sat on an error
  // and the whole pairing flow felt "very slow". The register call now gets
  // a 30s window (the ApiClient failover chain can legitimately take ~20s on
  // a bad LAN pin) and ONE automatic retry, so a single hiccup no longer
  // bounces the customer back to the idle screen.
  const discoverRegisterOnce = useCallback(async (signal: AbortSignal) => {
    return apiFetch('/api/agency-devices/public/discover-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ deviceName: 'BLASTI Kiosk', deviceType: 'KIOSK', connectionType: lanServer ? 'LAN' : 'WIFI', deviceFingerprint: getStableKioskFingerprint() }),
    });
  }, [lanServer]);

  const handleStartDiscovery = useCallback(async () => {
    userChoseStep.current = true;
    discoveryFlowActiveRef.current = true;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setDiscoveryStatus('registering');
    setPairingRequests([]);

    // ── 0.6.112 — shared adoption path (direct register OR background retry).
    // 0.6.112 — WAITING MODE IS NEVER DEAD (field fault 2026-11-23): on a slow
    // cloud the register surfaced a caller-cancel as a fake "500 Request was
    // cancelled" and the kiosk bounced to an error dead-end — WITH the
    // pairing-offer listeners switched OFF (pairingWaitActive only turns on
    // for 'waiting'/discovery), so the manager's request "never reached the
    // kiosk" while the beacon was announcing the whole time. Register failure
    // now ALWAYS lands in the token-less waiting screen: the beacon keeps
    // announcing, the LAN UDP offer listener and pairing-wait socket rooms
    // stay live, and a silent 10s loop retries the cloud register until it
    // succeeds.
    const adoptDiscoveryRegistration = (data: { success?: boolean; deviceToken?: string; device?: { id: string }; error?: string }) => {
      if (!(data && data.success && data.deviceToken && data.device && typeof data.device.id === 'string')) return false;
      setDiscoveryToken(data.deviceToken);
      discoveryTokenRef.current = data.deviceToken;
      setDeviceToken(data.deviceToken);
      setDeviceId(data.device.id);
      saveDeviceToken(data.deviceToken);
      saveDeviceId(data.device.id);
      // 0.6.113 — remember WHICH store this orphan row lives on (the base
      // discover-register just used). The hardened accept binds it after the
      // registration is verified, so the pair persists on this end as well.
      orphanStoreBaseRef.current = getKioskLanBase() || '';
      setDiscoveryStatus('waiting');
      setStep('discovery');
      startDeviceHeartbeat(data.deviceToken);
      // The cloud identity is live — stop the silent re-register loop.
      if (discoveryRegisterRetryRef.current) { clearInterval(discoveryRegisterRetryRef.current); discoveryRegisterRetryRef.current = null; }
      // Poll device-status for pairing requests (0.6.106 — 2s fallback:
      // the LAN UDP offer + the socket rooms deliver instantly; this poll
      // is only for the rare case where both channels missed).
      if (discoveryPollRef.current) clearInterval(discoveryPollRef.current);
      discoveryPollRef.current = setInterval(async () => {
        try {
          const statusRes = await apiFetch('/api/agency-devices/public/device-status', {
            headers: { 'Authorization': `Bearer ${data.deviceToken}` },
          });
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.success && statusData.pairingRequests?.length > 0) {
              setPairingRequests(statusData.pairingRequests);
            }
            // If device was paired via another mechanism (e.g. auto-register), load agency
            if (statusData.status === 'ONLINE' && statusData.agency) {
              setDiscoveryStatus('discovered');
              if (discoveryPollRef.current) { clearInterval(discoveryPollRef.current); discoveryPollRef.current = null; }
              setTimeout(async () => {
                setDiscoveryStatus('connecting');
                try {
                  const agencyRes = await apiFetch(`/api/agency-devices/public/agency?code=${encodeURIComponent(statusData.agency.customCode || '')}`, {
                    headers: { 'Authorization': `Bearer ${data.deviceToken}` },
                  });
                  const agencyData = await agencyRes.json();
                  if (agencyData.success) {
                    setAgency(agencyData.agency);
                    setServices(agencyData.services || []);
                    setQueueStats(agencyData.queueStats);
                    if (agencyData.agency.customCode) setAgencyCode(agencyData.agency.customCode);
                    setIsDeviceRegistered(true);
                    if (agencyData.agency.isQueueOpen && !agencyData.agency.isPaused) setStep('services');
                  }
                } catch { setDiscoveryStatus('waiting'); }
              }, 1500);
            }
          }
        } catch { /* polling continues */ }
      }, 2000);
      return true;
    };

    // 0.6.119 — the manager DELETED this device: register answered 409
    // DEVICE_REMOVED_BY_MANAGER. Stop every loop, wipe the stored identity
    // (token + branch code) so nothing re-registers, and show the removed
    // state (the ghost-device fix — previously the kiosk silently minted a
    // fresh row seconds after every delete).
    const enterRemovedState = (source: string) => {
      if (discoveryRegisterRetryRef.current) { clearInterval(discoveryRegisterRetryRef.current); discoveryRegisterRetryRef.current = null; }
      if (discoveryPollRef.current) { clearInterval(discoveryPollRef.current); discoveryPollRef.current = null; }
      removeDeviceToken();
      removeAgencyCode();
      setDeviceToken('');
      setDeviceId('');
      setIsDeviceRegistered(false);
      setDiscoveryToken('');
      discoveryTokenRef.current = '';
      setPairingRequests([]);
      setDiscoveryError(null);
      setDiscoveryStatus('removed');
      setStep('discovery');
      try { logDevice('device_removed_by_manager', `register blocked by the removed-device tombstone (${source}) — stored identity cleared, retry loop stopped`, { deviceType: 'KIOSK', status: 'REMOVED' }, 'warn'); } catch { /* never block */ }
    };

    // Token-less degraded waiting: everything except the cloud identity.
    const enterWaitingFallback = (reason: string) => {
      setDiscoveryError(reason);
      setDiscoveryStatus('waiting');
      setStep('discovery');
      try { logDevice('discovery_register_degraded', 'discover-register failed — waiting mode stays LIVE (beacon + LAN offers + socket rooms); cloud register retries every 10s', { deviceType: 'KIOSK', status: 'PENDING' }, 'warn'); } catch { /* never block */ }
      if (discoveryRegisterRetryRef.current) clearInterval(discoveryRegisterRetryRef.current);
      discoveryRegisterRetryRef.current = setInterval(async () => {
        if (!discoveryFlowActiveRef.current) {
          if (discoveryRegisterRetryRef.current) { clearInterval(discoveryRegisterRetryRef.current); discoveryRegisterRetryRef.current = null; }
          return;
        }
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 20_000);
          const retryRes = await discoverRegisterOnce(ctl.signal).finally(() => clearTimeout(timer));
          if (!retryRes.ok) {
            // 0.6.119 — the retry must NEVER fight a deleted-device tombstone:
            // 409 means the manager removed this device — stop the loop.
            if (retryRes.status === 409) {
              enterRemovedState('background-retry');
              return;
            }
            return;
          }
          const retryData = await retryRes.json().catch(() => null);
          if (retryData && retryData.removed) {
            enterRemovedState('background-retry-body');
            return;
          }
          if (retryData && retryData.success && retryData.deviceToken) {
            try { logDevice('discovery_register_recovered', 'background re-register succeeded — cloud identity adopted', { deviceType: 'KIOSK', status: 'PENDING' }); } catch { /* never block */ }
            adoptDiscoveryRegistration(retryData);
          }
        } catch { /* silent — the next tick retries */ }
      }, 10_000);
    };

    try {
      // 30s window + ONE automatic retry (0.6.105 — was a bare 15s abort).
      const attemptRegister = async (): Promise<ApiFetchResponse> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30_000);
          try {
            return await discoverRegisterOnce(controller.signal);
          } catch (err) {
            const aborted = err instanceof DOMException && err.name === 'AbortError';
            if (attempt === 0) {
              try { logDevice('scan_retry', `discover-register attempt 1 failed (${aborted ? 'timeout' : 'network'}) — retrying once`, undefined, 'warn'); } catch { /* never block */ }
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            }
            throw err;
          } finally {
            clearTimeout(timeoutId);
          }
        }
        throw new Error('unreachable');
      };

      const res = await attemptRegister();

      if (!res.ok) {
        // Surface the actual API error body instead of a useless "500".
        // The API returns { success:false, error:"..." } on failures, but
        // a 500 can also come from Next.js dev rewrites when the API server
        // (port 3003) is down — in which case the body is an HTML error page.
        // 0.6.112 — a 499 here is a CLIENT cancel (slow failover chain), not
        // a server fault; either way this is NOT a dead end.
        let detail = '';
        try {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const errBody = await res.json();
            detail = errBody?.error || JSON.stringify(errBody);
          } else {
            const text = await res.text();
            detail = text.slice(0, 300) || `(empty body, status ${res.status})`;
          }
        } catch { detail = `(could not read response body, status ${res.status})`; }
        // 0.6.119 — 409 = the manager deleted this device. No retry loop, no
        // waiting mode: show the removed state with the identity wiped.
        if (res.status === 409) {
          console.warn('[Kiosk Discovery] discover-register blocked — device was removed by the manager');
          enterRemovedState('discover-register');
          return;
        }
        const message = `Server returned ${res.status}${detail ? `: ${detail}` : ''}`;
        console.error('[Kiosk Discovery] discover-register failed:', res.status, detail);
        // 0.6.112 — token-less waiting mode: the device stays pairable over
        // the LAN while the background loop retries the cloud register.
        enterWaitingFallback(message);
        return;
      }
      const data = await res.json();
      if (!adoptDiscoveryRegistration(data)) {
        // Server answered but did not mint an identity (success:false etc.).
        enterWaitingFallback(data?.error || 'Discovery registration failed');
      }
    } catch (err: unknown) {
      const message = err instanceof Error
        ? (err.name === 'AbortError' ? 'Connection timed out. Please check your network and try again.' : err.message)
        : 'Network error — could not reach the server';
      console.warn('[Kiosk Discovery] discover-register threw — entering waiting mode:', message);
      // 0.6.112 — never dead-end: waiting mode + background re-register.
      enterWaitingFallback(message);
    } finally {
      setDiscoveryLoading(false);
    }
  }, [discoverRegisterOnce, startDeviceHeartbeat]);
  // ─── Accept Pairing Request ───────────────────────────────
  // 0.6.113 — HARDENED PAIRING PROTOCOL (user requirement: "kiosk do not
  // immediately get the token and right to access but first a final checking
  // if the kiosk got registered first, only then give access token and
  // navigate to service selector"). Three strictly ordered phases:
  //
  //   PHASE A — ACCEPT (a registration REQUEST, never access):
  //     the accept POST goes LAN-direct to the offering manager desktop when
  //     the request carries managerIp, else to the pinned store. A response
  //     that explicitly reports registered:false is a HARD FAIL — no token,
  //     no navigation. The manager store itself now read-back-verifies the
  //     write before answering (0.6.113).
  //
  //   PHASE B — FINAL CHECK (the kiosk independently verifies registration):
  //     the card switches to the 'verifying' state ("Final check: verifying
  //     registration…") and the kiosk re-reads the registration from the
  //     manager store through GET /public/pairing-verify — a SECOND, read-only
  //     view — until the row PROVES agency bound + ONLINE (+ the pairing
  //     command completed when known). Up to 6 attempts, 700ms apart.
  //     While this phase runs: NO token adoption, NO heartbeat switch, NO
  //     navigation. If the check never passes → pairing cancelled, the token
  //     is NOT granted, the kiosk returns to the waiting screen.
  //
  //   PHASE C — GRANT + PERSIST (only after a VERIFIED registration):
  //     adopt the manager-minted token, persist the device id, bind the
  //     kiosk's OWN orphan row (the store discover-register created it on —
  //     the historic "pairing done but kiosk never registered as a paired
  //     device" fault) and ONLY THEN navigate to the service selector.
  const handleAcceptPairing = useCallback(async (request: PairingRequest) => {
    // 0.6.103 — single-flight: ignore extra taps while one accept runs.
    if (pairingActionRef.current) return;
    // Use ref to avoid stale closure — discoveryToken may not be in the React
    // state yet when the user clicks Accept (it was set by handleStartDiscovery
    // in a prior render cycle but the callback captures the old '' value).
    const token = discoveryTokenRef.current || discoveryToken;
    // 0.6.112 — a LAN UDP offer / socket push / poll request carries the
    // MANAGER-MINTED deviceToken: the accept can run even when this kiosk
    // never managed a cloud register (token-less waiting mode). Only a
    // request that carries NO token at all cannot proceed.
    const acceptTokenAvailable = request.deviceToken || token;
    if (!acceptTokenAvailable) {
      console.warn('[Kiosk] Accept pairing called but no device token available (neither local nor manager-minted)');
      toast.error('No device token — please try discovery again');
      setDiscoveryStatus('waiting');
      return;
    }
    pairingActionRef.current = true;
    setPairingActionId(request.id);
    setDiscoveryStatus('connecting');
    // Stop discovery polling immediately to avoid race conditions
    if (discoveryPollRef.current) { clearInterval(discoveryPollRef.current); discoveryPollRef.current = null; }
    const pairingDeclined = (message: string) => {
      // 0.6.113 — every refusal path lands back in waiting mode with the
      // token WITHHELD: the kiosk never enters the service selector unverified.
      setDiscoveryStatus('waiting');
      toast.error(message);
    };
    // 0.6.100 — PHASE C helper: grant access + enter the service selector.
    // Runs ONLY after the final registration check passed.
    const grantAccessAndEnter = (data: { agency?: any; services?: any[] }) => {
      if (!(data && data.agency)) return false;
      // ADOPT the manager-issued device token when the pairing request
      // carries one: from now on the manager store and THIS device share
      // ONE canonical token (this is what authorizes shared-printer jobs
      // and other cross-store commands).
      const adoptedToken = request.deviceToken;
      if (adoptedToken && adoptedToken !== token) {
        try {
          saveDeviceToken(adoptedToken);
          discoveryTokenRef.current = adoptedToken;
          setDiscoveryToken(adoptedToken);
          setDeviceToken(adoptedToken);
          logDevice('kiosk_token_adopted', 'Adopted the manager-issued device token AFTER the registration was verified', { deviceType: 'KIOSK', status: 'ONLINE' });
        } catch { /* keep the old token — pairing still works */ }
      }
      setAgency({
        id: data.agency.id,
        name: data.agency.name,
        nameAr: data.agency.nameAr || '',
        nameFr: data.agency.nameFr || '',
        category: data.agency.category || '',
        workingHoursStart: data.agency.workingHoursStart || '08:00',
        workingHoursEnd: data.agency.workingHoursEnd || '18:00',
        isQueueOpen: data.agency.isQueueOpen !== false,
        isPaused: data.agency.isPaused || false,
        logoUrl: data.agency.logoUrl || '',
        customCode: data.agency.customCode || '',
      });
      setServices((data.services || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        nameAr: s.nameAr || '',
        nameFr: s.nameFr || '',
        prefix: s.prefix || '',
        avgTime: s.avgTime || s.averageServiceTime || 0,
      })));
      if (data.agency.customCode) setAgencyCode(data.agency.customCode);
      setIsDeviceRegistered(true);
      setPairingRequests([]);
      // pairing done (VERIFIED): stop the background re-register loop and close
      // the discovery flow so a late cloud adoption cannot yank the kiosk back
      // from 'services' to the waiting screen.
      if (discoveryRegisterRetryRef.current) { clearInterval(discoveryRegisterRetryRef.current); discoveryRegisterRetryRef.current = null; }
      discoveryFlowActiveRef.current = false;
      // Restart heartbeat to ensure it uses the correct token post-pairing
      // (the ADOPTED manager-issued token when one was carried).
      startDeviceHeartbeat(discoveryTokenRef.current || token);
      setStep('services');
      toast.success(t('kioskPairedSuccessfully') || 'Successfully connected!');
      return true;
    };
    try {
      // ── PHASE A — ACCEPT (registration request; LAN-direct → pinned store) ──
      const offerToken = request.deviceToken || token;
      let acceptData: { success?: boolean; error?: string; registered?: boolean; registration?: PairingRegistrationProof; agency?: any; services?: any[]; device?: any } | null = null;
      if (request.managerIp && typeof request.managerIp === 'string') {
        try {
          const base = `http://${request.managerIp}:${request.managerPort || 3080}`;
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 6000);
          const directRes = await fetch(`${base}/api/agency-devices/device/accept-pairing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${offerToken}` },
            body: JSON.stringify({ commandId: request.id, agencyId: request.agencyId }),
            signal: ctl.signal,
          });
          clearTimeout(timer);
          const directData = await directRes.json().catch(() => null);
          if (directData && directData.success && directData.agency) {
            acceptData = directData;
            // 0.6.107 — the accepting desktop becomes this kiosk's permanent
            // device-to-device base: heartbeat/services/tickets/printing and
            // the realtime queue channel all run against it, offline-first.
            try {
              if (getKioskLanBase() !== base) {
                setKioskLanBase(base);
                repointRealtimeToLanBase(base);
              }
            } catch { /* pin best-effort */ }
            try { logDevice('kiosk_accept_lan', 'Pairing accepted DIRECTLY against the manager desktop over the LAN', { deviceType: 'KIOSK', agencyId: request.agencyId, status: 'ONLINE' }); } catch { /* never block */ }
          }
          // Direct failed (401/404/409/network) — fall through to the
          // pinned-store accept below.
        } catch { /* LAN unreachable — pinned-store accept still runs */ }
      }
      if (!acceptData) {
        const res = await apiFetch('/api/agency-devices/device/accept-pairing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${offerToken}` },
          body: JSON.stringify({ commandId: request.id, agencyId: request.agencyId }),
          timeout: 8000,
        });
        const data = await res.json();
        if (data.success && data.agency) {
          acceptData = data;
        } else {
          pairingDeclined(data.error || 'Pairing failed');
          return;
        }
      }
      // 0.6.113 — an accept response that explicitly reports the registration
      // did NOT persist is a hard fail: the store itself withheld the
      // registration, so this kiosk gets NO token and NO access.
      if (acceptData && acceptData.registered === false) {
        try { logDevice('kiosk_accept_unregistered', 'accept-pairing reported registered:false — token withheld, kiosk stays waiting', { deviceType: 'KIOSK', status: 'PAIRING' }, 'warn'); } catch { /* never block */ }
        pairingDeclined(acceptData.error || 'Registration failed — access not granted');
        return;
      }

      // ── PHASE B — FINAL CHECK: verify the kiosk IS REGISTERED ──
      // Independent read-back through /public/pairing-verify. The token the
      // request carries is still only a CANDIDATE — access is granted when
      // the manager store's row proves the registration.
      setDiscoveryStatus('verifying');
      setPairingRequests([]);
      const managerBase = (request.managerIp && typeof request.managerIp === 'string'
        ? `http://${request.managerIp}:${request.managerPort || 3080}`
        : getKioskLanBase()) || '';
      const VERIFY_ATTEMPTS = 6;
      const VERIFY_GAP_MS = 700;
      let verified: { registered?: boolean; registration?: PairingRegistrationProof; device?: { id?: string; agencyId?: string; status?: string }; agency?: any; services?: any[] } | null = null;
      const verifyRegistration = async (): Promise<void> => {
        const params = new URLSearchParams();
        params.set('agencyId', request.agencyId);
        if (request.id) params.set('commandId', request.id);
        if (managerBase) {
          // LAN-direct verification against the manager desktop (offline OK).
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 4000);
          try {
            const vRes = await fetch(`${managerBase}/api/agency-devices/public/pairing-verify?${params.toString()}`, {
              headers: { 'Authorization': `Bearer ${offerToken}` },
              signal: ctl.signal,
            });
            const vData = await vRes.json().catch(() => null);
            if (vData && vData.success && vData.registered === true && vData.device && vData.device.agencyId === request.agencyId && vData.device.status === 'ONLINE') {
              verified = vData;
            }
          } finally {
            clearTimeout(timer);
          }
        } else {
          // Cloud store verification (kiosk never pinned a LAN desktop).
          const vRes = await apiFetch(`/api/agency-devices/public/pairing-verify?${params.toString()}`, {
            headers: { 'Authorization': `Bearer ${offerToken}` },
            timeout: 4000,
          });
          const vData = await vRes.json().catch(() => null);
          if (vData && vData.success && vData.registered === true && vData.device && vData.device.agencyId === request.agencyId && vData.device.status === 'ONLINE') {
            verified = vData;
          }
        }
      };
      for (let attempt = 0; attempt < VERIFY_ATTEMPTS && !verified; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, VERIFY_GAP_MS));
        try {
          await verifyRegistration();
        } catch { /* retry — the manager write may still be settling */ }
      }
      if (!verified) {
        // Registration could NOT be confirmed on the manager store → the
        // access token is NOT granted and the kiosk NEVER reaches the
        // service selector. Back to waiting; the operator can retry.
        try { logDevice('kiosk_pairing_verify_failed', 'Final registration check FAILED — access token withheld, kiosk returned to waiting', { deviceType: 'KIOSK', agencyId: request.agencyId, status: 'PAIRING' }, 'warn'); } catch { /* never block */ }
        pairingDeclined('Registration could not be verified — pairing cancelled, access not granted');
        return;
      }
      try { logDevice('kiosk_pairing_verified', 'Final registration check PASSED — token granted, entering the service selector', { deviceType: 'KIOSK', agencyId: request.agencyId, status: 'ONLINE' }); } catch { /* never block */ }

      // ── PHASE C — GRANT: persist the pair on the KIOSK's own store too ──
      // The verified registration lives on the MANAGER store. The orphan row
      // THIS kiosk created when it entered waiting mode (on its own pinned
      // store) must be bound as well — otherwise the kiosk machine never
      // shows the device as paired (the "kiosk does not get registered as a
      // paired device" fault). Best-effort: it must never block the grant.
      try {
        const verifiedRegistration = (verified as { registration?: PairingRegistrationProof }).registration;
        if (verifiedRegistration && verifiedRegistration.deviceId) {
          saveDeviceId(verifiedRegistration.deviceId);
          setDeviceId(verifiedRegistration.deviceId);
        }
        const orphanBase = orphanStoreBaseRef.current;
        if (orphanBase && managerBase && orphanBase !== managerBase && token && token !== offerToken) {
          const bindCtl = new AbortController();
          const bindTimer = setTimeout(() => bindCtl.abort(), 4000);
          try {
            await fetch(`${orphanBase}/api/agency-devices/device/accept-pairing`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ commandId: request.id, agencyId: request.agencyId }),
              signal: bindCtl.signal,
            });
            try { logDevice('kiosk_orphan_bound', 'Kiosk-side orphan row bound after verified pairing — the pair now exists on BOTH stores', { deviceType: 'KIOSK', status: 'ONLINE' }); } catch { /* never block */ }
          } finally {
            clearTimeout(bindTimer);
          }
        }
      } catch { /* best-effort bind — the grant never depends on it */ }

      // ── PHASE C — GRANT + NAVIGATE: token adopted, service selector entered ──
      const verifiedPayload = verified as { agency?: any; services?: any[] } | null;
      if (!grantAccessAndEnter({
        agency: (verifiedPayload && verifiedPayload.agency) || (acceptData ? acceptData.agency : null),
        services: (verifiedPayload && verifiedPayload.services) || (acceptData ? acceptData.services : []),
      })) {
        pairingDeclined('Paired, but the agency configuration is unavailable — please retry');
      }
    } catch {
      pairingDeclined('Network error during pairing');
    } finally {
      pairingActionRef.current = false;
      setPairingActionId(null);
    }
  }, [discoveryToken, t, startDeviceHeartbeat]);

  // ─── Reject Pairing Request ───────────────────────────────
  const handleRejectPairing = useCallback(async (request: PairingRequest) => {
    // 0.6.103 — single-flight guard (same rationale as Accept).
    if (pairingActionRef.current) return;
    const token = discoveryTokenRef.current || discoveryToken;
    // 0.6.112 — the manager-minted token rides the request; a token-less
    // waiting kiosk can still reject politely.
    if (!token && !request.deviceToken) return;
    pairingActionRef.current = true;
    setPairingActionId(request.id);
    try {
      await apiFetch('/api/agency-devices/device/reject-pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.deviceToken || token}` },
        body: JSON.stringify({ commandId: request.id }),
        timeout: 8000,
      });
      setPairingRequests(prev => prev.filter(r => r.id !== request.id));
      toast.success(t('kioskPairingRejected') || 'Pairing request rejected');
    } catch {
      toast.error('Failed to reject pairing');
    } finally {
      pairingActionRef.current = false;
      setPairingActionId(null);
    }
  }, [discoveryToken, t]);

  // ─── 0.6.100 — MANDATORY ACCEPTANCE ─────────────────────────────────
  // The 0.6.95 auto-accept (3s grace) is REMOVED per the user requirement:
  // "pairing request must reach the kiosk device or other pc and they must
  // ACCEPT before pairing and connecting devices". The operator now always
  // taps Accept (or Reject) on the discovery screen — unattended kiosks are
  // paired by a human walking past, not silently by the manager.
  const handleAcceptPairingRef = useRef(handleAcceptPairing);
  const handleRejectPairingRef = useRef(handleRejectPairing);
  useEffect(() => { handleAcceptPairingRef.current = handleAcceptPairing; }, [handleAcceptPairing]);
  useEffect(() => { handleRejectPairingRef.current = handleRejectPairing; }, [handleRejectPairing]);

  // Cleanup discovery poll on unmount
  useEffect(() => {
    return () => {
      if (discoveryPollRef.current) clearInterval(discoveryPollRef.current);
      // 0.6.112 — the silent background re-register loop dies with the screen.
      if (discoveryRegisterRetryRef.current) { clearInterval(discoveryRegisterRetryRef.current); discoveryRegisterRetryRef.current = null; }
      discoveryFlowActiveRef.current = false;
    };
  }, []);

  // ─── Auto-Connect for Already-Paired Devices ───────────────
  // If a deviceToken is saved in localStorage, verify it and auto-connect.
  // Guard: skip auto-connect if user has already manually chosen a step.
  // 0.6.107 — the callable body lives in tryAutoConnectRef so the LAN
  // discovery effect can RETRY it the moment a desktop is pinned: a paired
  // kiosk booting OFFLINE must rejoin its agency from the pinned desktop's
  // local store (heartbeat + device-status are device-to-device there).
  useEffect(() => {
    const token = loadDeviceToken();
    if (!token) return;

    let cancelled = false;
    async function tryAutoConnect() {
      if (cancelled || autoConnectBusyRef.current || autoConnectDoneRef.current) return;
      if (userChoseStep.current) return;
      autoConnectBusyRef.current = true;
      try {
        // Send a heartbeat first to bring the device back to ONLINE
        await apiFetch('/api/agency-devices/device/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ appVersion: APP_VERSION, ipAddress: kioskIp || lanServer?.ip || undefined }),
        }).catch(() => {});

        if (cancelled || userChoseStep.current) return;

        // Now check device status
        const res = await apiFetch('/api/agency-devices/public/device-status', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok || cancelled || userChoseStep.current) return;
        const data = await res.json();
        if (!data.success || cancelled || userChoseStep.current) return;

        // If device has an agency → auto-connect
        if (data.agency) {
          autoConnectDoneRef.current = true;
          setDeviceToken(token);
          setAgency({
            id: data.agency.id,
            name: data.agency.name,
            nameAr: data.agency.nameAr || '',
            nameFr: data.agency.nameFr || '',
            category: data.agency.category || '',
            customCode: data.agency.customCode || '',
            logoUrl: data.agency.logoUrl || '',
            workingHoursStart: data.agency.workingHoursStart || '08:00',
            workingHoursEnd: data.agency.workingHoursEnd || '18:00',
            isQueueOpen: data.agency.isQueueOpen !== false,
            isPaused: data.agency.isPaused || false,
          });
          setServices((data.agency.services || []).map((s: any) => ({
            id: s.id, name: s.name, nameAr: s.nameAr || '', nameFr: s.nameFr || '',
            prefix: s.prefix || '', avgTime: s.avgTime || s.averageServiceTime || 0,
          })));
          setQueueStats(data.agency.queueStats || null);
          if (data.agency.customCode) setAgencyCode(data.agency.customCode);
          setIsDeviceRegistered(true);
          startDeviceHeartbeat(token);
          setStep('services');
          console.log('[Kiosk] Auto-connected to agency:', data.agency.name);
        }
      } catch {
        // Silent — will show method-select screen
      } finally {
        autoConnectBusyRef.current = false;
      }
    }

    tryAutoConnectRef.current = tryAutoConnect;
    // Wait briefly for LAN discovery to complete first
    const timer = setTimeout(tryAutoConnect, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // ─── Offline Ticket Issuance ───────────────────────────────
  const handleOfflineJoinQueue = useCallback(() => {
    if (!agency || !selectedService) return;
    const service = services.find(s => s.id === selectedService);
    if (!service) return;
    let lastIssuedNumbers: Record<string, number> = {};
    try {
      const stored = localStorage.getItem('blasti-kiosk-agency-cache');
      if (stored) { const parsed = JSON.parse(stored) as AgencyCache; lastIssuedNumbers = parsed.lastIssuedNumbers || {}; }
    } catch { /* ignore */ }
    const lastNum = lastIssuedNumbers[service.id] || 0;
    const nextNum = lastNum + 1;
    const ticketNumber = `${service.prefix}-${String(nextNum).padStart(3, '0')}`;
    lastIssuedNumbers[service.id] = nextNum;
    try {
      const stored = localStorage.getItem('blasti-kiosk-agency-cache');
      if (stored) { const parsed = JSON.parse(stored) as AgencyCache; parsed.lastIssuedNumbers = lastIssuedNumbers; localStorage.setItem('blasti-kiosk-agency-cache', JSON.stringify(parsed)); }
    } catch { /* ignore */ }
    const offlineTicket: OfflineTicket = {
      id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agencyId: agency.id,
      serviceId: selectedService,
      serviceName: getLocalizedName(service, lang),
      servicePrefix: service.prefix,
      ticketNumber,
      // 0.6.104 — anonymous (name step removed); offline tickets stay nameless.
      customerName: '',
      issuedAt: new Date().toISOString(),
      synced: false,
    };
    const existing: OfflineTicket[] = [];
    try {
      const stored = localStorage.getItem('blasti-kiosk-offline-tickets');
      if (stored) existing.push(...JSON.parse(stored));
    } catch { /* ignore */ }
    existing.push(offlineTicket);
    saveOfflineTickets(existing);
    setOfflineTickets(existing);
    setTicket({
      id: offlineTicket.id,
      ticketNumber: offlineTicket.ticketNumber,
      position: 1,
      estimatedWaitMinutes: service.avgTime,
      customerName: offlineTicket.customerName,
      serviceName: offlineTicket.serviceName,
      agencyName: getLocalizedName(agency, lang),
      agencyNameAr: agency.nameAr,
      agencyNameFr: agency.nameFr,
      joinedAt: offlineTicket.issuedAt,
      importToken: '',
    });
    setStep('ticket');
    setInactivitySeconds(0);
    setShowQrDetail(false);
    setTicketQrUrl(null);
    setShowConfetti(true);
    setTimeout(() => setShowConfetti(false), 3500);
    toast.success(t('kioskOfflineTicketIssued'));
  }, [agency, selectedService, services, lang, t]);

  const pageVariants = getPageVariants(rtl);

  // ─── Render ────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-[100] bg-gradient-to-br from-emerald-600 via-emerald-700 to-teal-800 flex flex-col select-none overflow-hidden"
      dir={rtl ? 'rtl' : 'ltr'}
      onClick={resetInactivity}
      onTouchStart={resetInactivity}
    >
      {/* Compact Header: logo + clock + connection + languages in ONE row */}
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5 print:hidden shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg overflow-hidden bg-white/10 p-0.5">
            <img src="/logo.png" alt="BLASTI" width={32} height={32} className="h-full w-full object-contain" />
          </div>
          <span className="text-base font-bold text-white hidden sm:inline">BLASTI</span>
          {agency && (
            <span className={`inline-flex items-center gap-1 text-[10px] ms-1 ${realtime.isConnected ? 'text-emerald-300' : 'text-amber-300'}`}>
              <span className={`h-1.5 w-1.5 rounded-full inline-block ${realtime.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
              {realtime.isConnected ? (t('live') || 'Live') : (t('polling') || 'Polling')}
            </span>
          )}
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white/10 backdrop-blur-sm rounded-lg px-3 py-1 text-center"
        >
          <p className="text-lg sm:text-xl font-mono font-bold text-white tracking-wider leading-tight" dir="ltr">
            {formatClockTime(currentTime, lang)}
          </p>
          <p className="text-[9px] text-emerald-200/80 leading-tight">
            {formatClockDate(currentTime, lang)}
          </p>
        </motion.div>

        <div className="flex gap-1 items-center">
          {/* STRICT LOGS (0.6.30) — manual upload even on the kiosk surface.
              The device token authenticates the batch (no user session). */}
          <button
            onClick={() => {
              void flushLogsNow({ manual: true }).then((res) => {
                if (res.ok) toast.success(t('logsUploadedOk') || 'Logs uploaded');
                else toast.error((t('logsUploadFailed') || 'Log upload failed') + (res.error ? ` (${res.error})` : ''));
              });
            }}
            title={t('uploadLogsNow') || 'Upload logs now'}
            aria-label={t('uploadLogsNow') || 'Upload logs now'}
            className="min-h-[32px] min-w-[32px] rounded-lg bg-white/20 text-white hover:bg-white/30 flex items-center justify-center transition-all"
          >
            <FileUp className="h-3.5 w-3.5" />
          </button>
          {languages.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={`min-h-[32px] min-w-[32px] px-2 rounded-lg text-xs font-semibold transition-all ${
                lang === l.code ? 'bg-white text-emerald-700 shadow' : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Offline Mode Banner */}
      {isOfflineMode && agency && (
        <KioskOfflineBanner
          t={t}
          offlineTickets={offlineTickets}
          syncStatus={syncStatus}
          syncCount={syncCount}
        />
      )}

      {/* Step Indicator — compact variant on xs/sm viewports (0.6.104) */}
      {step !== 'code' && step !== 'discovery' && step !== 'qr-scan' && step !== 'method-select' && step !== 'credentials' && (
        <div className="px-4 pt-0.5 pb-0.5 print:hidden shrink-0">
          <KioskStepIndicator currentStep={step} stepLabels={stepLabels} rtl={rtl} compact={viewportSize === 'xs' || viewportSize === 'sm'} />
        </div>
      )}

      {/* Currently Serving Banner (compact) — hidden on xs: every pixel of
          height matters there (0.6.104) */}
      {agency && queueStats && !isOfflineMode && (queueStats.currentServing || (queueStats.currentlyServingList && queueStats.currentlyServingList.length > 0)) && step !== 'ticket' && viewportSize !== 'xs' && (
        <div className="px-4 pb-1 print:hidden shrink-0">
          <motion.div
            initial={{ opacity: 0, y: -5 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/10 backdrop-blur-sm rounded-xl p-2"
          >
            <div className="flex items-center gap-2 mb-1">
              <Monitor className="h-3.5 w-3.5 text-emerald-200" />
              <p className="text-xs font-semibold text-emerald-100">{t('currentlyServingKiosk')}</p>
            </div>
            {queueStats.currentlyServingList && queueStats.currentlyServingList.length > 0 ? (
              <div className="grid grid-cols-4 gap-1.5">
                {queueStats.currentlyServingList.slice(0, 4).map((item, i) => (
                  <div key={i} className="bg-white/10 rounded-lg p-1.5 text-center">
                    <p className="text-lg font-bold text-white leading-tight">{item.ticketNumber}</p>
                    {item.counterName && <p className="text-[9px] text-emerald-200/80 leading-tight truncate">{item.counterName}</p>}
                  </div>
                ))}
              </div>
            ) : queueStats.currentServing ? (
              <div className="bg-white/10 rounded-lg p-1.5 text-center">
                <motion.p animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }} className="text-2xl font-bold text-white leading-tight">{queueStats.currentServing}</motion.p>
              </div>
            ) : null}
          </motion.div>
        </div>
      )}

      {/* Main content area — flexes to fill remaining viewport */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-3 sm:p-4">
        <AnimatePresence mode="wait">
          {/* Method Selection */}
          {step === 'method-select' && (
            <KioskMethodSelect
              t={t}
              pageVariants={pageVariants}
              onSelectCode={() => setStep('code')}
              onSelectCredentials={() => { setCredError(null); setStep('credentials'); }}
              onSelectDiscovery={handleStartDiscovery}
              onSelectQr={() => setStep('qr-scan')}
              discoveryLoading={discoveryLoading}
              discoveryError={discoveryError}
            />
          )}

          {/* Credentials Login */}
          {step === 'credentials' && (
            <KioskCredentialsLogin
              t={t}
              pageVariants={pageVariants}
              loading={credLoading}
              error={credError}
              onLogin={handleCredentialsLogin}
              onBack={() => { setCredError(null); setStep('method-select'); }}
            />
          )}

          {/* Step 1: Enter Agency Code */}
          {step === 'code' && (
            <motion.div
              key="code"
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="w-full max-w-md"
            >
              <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl p-5 sm:p-6 text-center">
                <div className="h-12 w-12 mx-auto rounded-xl bg-emerald-100 flex items-center justify-center mb-2">
                  <Search className="h-6 w-6 text-emerald-600" />
                </div>
                <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-1">{t('enterAgencyCode')}</h1>
                <p className="text-gray-500 dark:text-gray-400 mb-4 text-sm">{t('agencyCodePlaceholder')}</p>

                <input
                  type="text"
                  value={agencyCode}
                  onChange={(e) => setAgencyCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCodeSubmit(); }}
                  placeholder={t('agencyCodePlaceholder')}
                  className="w-full min-h-[52px] rounded-2xl border-2 border-gray-200 dark:border-gray-700 px-5 text-lg text-center font-semibold focus:border-emerald-500 focus:outline-none transition-colors uppercase tracking-widest"
                  autoFocus
                  dir="ltr"
                />

                {showContactAdmin ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="mt-3 p-4 rounded-2xl bg-red-50 border-2 border-red-200 text-center"
                  >
                    <XCircle className="h-10 w-10 text-red-500 mx-auto mb-2" />
                    <h3 className="text-base font-bold text-red-700 mb-1">{t('contactAdminTitle')}</h3>
                    <p className="text-sm text-red-600 mb-3">{t('contactAdminDesc')}</p>
                    <div className="flex items-center justify-center gap-2 text-xs text-red-400 mb-3">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>{t('retryCountExceeded')}</span>
                    </div>
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => { setRetryCount(0); setShowContactAdmin(false); setError(null); setAgencyCode(''); removeAgencyCode(); }}
                      className="min-h-[44px] px-5 rounded-xl bg-red-600 text-white font-semibold hover:bg-red-700 transition-colors"
                    >
                      <RotateCcw className="h-4 w-4 inline me-2" />
                      {t('tryAgain') || 'Try Again'}
                    </motion.button>
                  </motion.div>
                ) : error ? (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium flex items-center justify-between"
                  >
                    <span>{error}</span>
                    {retryCount > 0 && retryCount < MAX_RETRIES && (
                      <span className="text-xs text-red-400 ms-2">{t('attempt')} {retryCount}/{MAX_RETRIES}</span>
                    )}
                  </motion.div>
                ) : null}

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleCodeSubmit}
                  disabled={loading || !agencyCode.trim() || showContactAdmin}
                  className={`w-full min-h-[52px] rounded-2xl text-lg font-bold shadow-lg mt-4 flex items-center justify-center gap-2 transition-all ${
                    !agencyCode.trim() || loading || showContactAdmin
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
                      : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl'
                  }`}
                >
                  {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Search className="h-5 w-5" />}
                  {t('search')}
                </motion.button>

                <DiscoveryStartButton
                  status={discoveryStatus}
                  t={t}
                  onClick={handleStartDiscovery}
                />

                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setStep('method-select')}
                  className="w-full min-h-[44px] mt-3 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 font-medium hover:bg-gray-200 transition-colors flex items-center justify-center gap-2 text-sm"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t('kioskBack')}
                </motion.button>
              </div>
            </motion.div>
          )}

          {/* Discovery Step */}
          {step === 'discovery' && (
            <KioskDiscoveryLogin
              status={discoveryStatus}
              pairingRequests={pairingRequests}
              pairingActionId={pairingActionId}
              t={t}
              lang={lang}
              kioskIp={displayKioskIp}
              pageVariants={pageVariants}
              onBack={() => {
                if (discoveryPollRef.current) clearInterval(discoveryPollRef.current);
                discoveryPollRef.current = null;
                // 0.6.112 — leaving discovery also stops the re-register loop.
                if (discoveryRegisterRetryRef.current) { clearInterval(discoveryRegisterRetryRef.current); discoveryRegisterRetryRef.current = null; }
                discoveryFlowActiveRef.current = false;
                setDiscoveryStatus('idle');
                setPairingRequests([]);
                setStep('code');
              }}
              onAcceptPairing={handleAcceptPairing}
              onRejectPairing={handleRejectPairing}
            />
          )}

          {/* Step 2: Select Service */}
          {step === 'services' && agency && (
            <KioskServiceSelector
              agency={agency}
              services={services}
              queueStats={queueStats}
              selectedService={selectedService}
              isOfflineMode={isOfflineMode}
              rtl={rtl}
              lang={lang}
              error={error}
              size={viewportSize}
              t={t}
              pageVariants={pageVariants}
              onSelectService={setSelectedService}
              onBack={handleReset}
              onNext={() => {
                if (selectedService) {
                  setError(null);
                  // 0.6.104 — name step REMOVED (user request: reserve directly
                  // from services). Services → join; the join is anonymous
                  // (customerName omitted, server stores 'Anonymous').
                  if (isOfflineMode) { handleOfflineJoinQueue(); } else { handleJoinQueue(); }
                }
              }}
            />
          )}

          {/* Step 3: Ticket Display */}
          {step === 'ticket' && ticket && agency && (
            <KioskTicketDisplay
              ticket={ticket}
              queueStats={queueStats}
              isOfflineMode={isOfflineMode}
              rtl={rtl}
              lang={lang}
              size={viewportSize}
              t={t}
              pageVariants={pageVariants}
              showConfetti={showConfetti}
              ticketQrUrl={ticketQrUrl}
              showQrDetail={showQrDetail}
              printError={printError}
              inactivitySeconds={inactivitySeconds}
              onPrint={handlePrint}
              onReset={handleReset}
              onToggleQrDetail={() => setShowQrDetail(!showQrDetail)}
              onClearPrintError={() => setPrintError(null)}
            />
          )}

          {/* QR Scan Step */}
          {step === 'qr-scan' && (
            <motion.div
              key="qr-scan"
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="w-full max-w-2xl"
            >
              <div className="bg-white dark:bg-gray-900 rounded-3xl shadow-2xl p-6 sm:p-8">
                <DeviceQrScanner
                  agencyId={agency?.id}
                  deviceId={`kiosk-${agency?.customCode || agencyCode || 'unknown'}`}
                  onClaimed={async (result) => {
                    let position = 1;
                    let estimatedWaitMinutes = 0;
                    if (result.reservation.agency?.id) {
                      try {
                        const statusHeaders: Record<string, string> = {};
                        if (deviceToken) statusHeaders['Authorization'] = `Bearer ${deviceToken}`;
                        const statusRes = await apiFetch(`/api/agency-devices/public/queue-status?agencyId=${result.reservation.agency.id}`, { headers: statusHeaders });
                        if (statusRes.ok) {
                          const statusData = await statusRes.json();
                          position = (statusData.totalWaiting ?? 1);
                          estimatedWaitMinutes = statusData.totalEstimatedWait ?? 0;
                        }
                      } catch { /* fallback */ }
                    }
                    setTicket({
                      id: result.reservation.id,
                      ticketNumber: result.reservation.displayNumber,
                      position,
                      estimatedWaitMinutes,
                    });
                    setStep('ticket');
                  }}
                  onBack={() => setStep('code')}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer — hidden on xs: every pixel of height matters there (0.6.104) */}
      {viewportSize !== 'xs' && (
        <div className="text-center pb-4 text-white/40 text-xs print:hidden">
          BLASTI — {t('kioskTitle')}
        </div>
      )}

      {/* LAN Connection Indicator — hidden on xs (0.6.104) */}
      {!isDiscovering && viewportSize !== 'xs' && (
        <div className="fixed bottom-4 end-4 z-50">
          {lanServer ? (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
              <Wifi className="h-3 w-3 me-1" />
              LAN: {lanServer.hostname}
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700">
              <WifiOff className="h-3 w-3 me-1" />
              Cloud Mode
            </Badge>
          )}
        </div>
      )}

      {/* 0.6.114 — KIOSK DEFAULT-PRINTER SETTING (operator surface). Visible
          ONLY on the setup screens (connect / waiting-for-pairing) once the
          kiosk holds a device token — never on the customer-facing service
          selector or ticket screens. Opens the sheet listing the agency's
          REGISTERED printers; the pick persists on this kiosk's own row and
          the receipt button prints directly on it. */}
      {(step === 'code' || step === 'discovery') && deviceToken && (
        <button
          type="button"
          onClick={() => setPrinterSettingsOpen(true)}
          aria-label={t('kioskPrinterSettings') || 'Printer settings'}
          className="fixed bottom-4 start-4 z-40 inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-2xl bg-white/10 backdrop-blur-sm text-white/80 hover:text-white hover:bg-white/20 border border-white/15 text-xs font-medium transition-colors"
        >
          <Printer className="h-4 w-4" />
          <span className="hidden sm:inline">{t('kioskPrinterSettings') || 'Printer settings'}</span>
        </button>
      )}

      {/* 0.6.114 — the sheet itself (renders nothing while closed) */}
      <KioskPrinterSettings
        open={printerSettingsOpen}
        onOpenChange={setPrinterSettingsOpen}
        deviceToken={deviceToken}
        t={t}
        lang={lang}
      />
    </div>
  );
}