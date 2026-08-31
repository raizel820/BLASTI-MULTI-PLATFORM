'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { isRTL } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { DeviceQrScanner } from './device-qr-scanner';
import { quickDiscover, type DiscoveredServer } from '@/lib/lan-discovery';
import { apiFetch } from '@/lib/api-fetch';
import { getLocalIp } from '@/lib/get-local-ip';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  Users,
  Loader2,
  Ticket,
  ScanLine,
  Globe,
  XCircle,
  AlertTriangle,
  RotateCcw,
  Wifi,
  WifiOff,
  Monitor,
  ArrowLeft,
} from 'lucide-react';

import {
  KioskStepIndicator,
} from './kiosk/kiosk-step-indicator';
import {
  KioskDiscoveryLogin,
  KioskMethodSelect,
  KioskCredentialsLogin,
  DiscoveryStartButton,
  type DiscoveryStatus,
} from './kiosk/kiosk-discovery-login';
import type { PairingRequest } from './kiosk/kiosk-types';
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
  generateFingerprint,
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

export function DeviceKiosk() {
  const { t, lang, setLang } = useLanguage();
  const rtl = isRTL(lang);

  // ─── State ─────────────────────────────────────────────────
  const [step, setStep] = useState<KioskStep>('method-select');
  const [credLoading, setCredLoading] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);
  const [agencyCode, setAgencyCode] = useState(() => loadSavedAgencyCode());
  const [agency, setAgency] = useState<AgencyInfo | null>(null);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
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

  // Inactivity timer
  const [inactivitySeconds, setInactivitySeconds] = useState(0);

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

  // Step indicator labels (only shown for queue steps, not login)
  const stepLabels: Record<string, string> = {
    code: t('kioskStepCode'),
    services: t('kioskStepService'),
    name: t('kioskStepName'),
    ticket: t('kioskStepTicket'),
  };

  const languages: { code: 'ar' | 'fr' | 'en'; label: string }[] = [
    { code: 'ar', label: 'عربي' },
    { code: 'fr', label: 'FR' },
    { code: 'en', label: 'EN' },
  ];



  // ─── LAN Auto-Discovery ────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    async function discover() {
      try {
        const server = await quickDiscover();
        if (mounted && server) {
          setLanServer(server);
          console.log(`[Kiosk] Auto-connected to LAN server: ${server.hostname} (${server.ip})`);
        }
      } catch (err) {
        console.warn('[Kiosk] LAN discovery failed, using cloud:', err);
      } finally {
        if (mounted) setIsDiscovering(false);
      }
    }
    discover();
    return () => { mounted = false; };
  }, []);

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
  const startDeviceHeartbeat = useCallback((token: string) => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    const sendHeartbeat = async () => {
      try {
        const res = await apiFetch('/api/agency-devices/device/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ appVersion: '1.0.0', ipAddress: kioskIp || lanServer?.ip || undefined }),
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
            removeDeviceId();
            removeAgencyCode();
            setDeviceToken('');
            setDeviceId('');
            setAgency(null);
            setServices([]);
            setQueueStats(null);
            setSelectedService(null);
            setCustomerName('');
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
        toast.success(t('kioskPairedSuccessfully') || 'Connected!');
      } else {
        setCredError(data.error || 'Authentication failed');
      }
    } catch {
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
    removeDeviceToken();
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
            body: JSON.stringify({ agencyCode: code.trim(), deviceName: 'BLASTI Kiosk', deviceType: 'KIOSK', connectionType: lanServer ? 'LAN' : 'WIFI', deviceFingerprint: generateFingerprint() }),
          });
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
  }, [deviceToken, lanServer, startDeviceHeartbeat]);

  useEffect(() => { fetchAgencyRef.current = fetchAgency; }, [fetchAgency]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    };
  }, []);

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
    setCustomerName('');
    setTicket(null);
    setTicketQrUrl(null);
    setShowQrDetail(false);
    setError(null);
    setInactivitySeconds(0);
    setShowConfetti(false);
    setRetryCount(0);
    setShowContactAdmin(false);
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
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
        body: JSON.stringify({ agencyId: agency.id, serviceId: selectedService, customerName: customerName.trim() || undefined }),
      });
      const data = await res.json();
      if (!data.success) { setError(data.error || 'Failed to join queue'); return; }
      setTicket(data.reservation);
      setStep('ticket');
      setInactivitySeconds(0);
      setShowQrDetail(false);
      if (data.reservation?.importToken) {
        const baseUrl = window.location.origin;
        const claimUrl = `${baseUrl}/?claim=${data.reservation.importToken}`;
        const qrUrl = await generateQRDataURL(claimUrl, { width: 200 });
        setTicketQrUrl(qrUrl);
      } else { setTicketQrUrl(null); }
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3500);
    } catch { setError('Network error'); }
    finally { setLoading(false); joiningRef.current = false; }
  };

  // ─── Print Ticket ──────────────────────────────────────────
  const handlePrint = async () => {
    if (!ticket) return;
    if (typeof window !== 'undefined' && (window as any).electronAPI?.printSilent) {
      try {
        const result = await (window as any).electronAPI.printSilent();
        if (!result?.success) { toast.error(t('printerError')); setPrintError(result?.message || t('printerErrorMessage')); }
      } catch (err) { toast.error(t('printerError')); setPrintError('Failed to communicate with printer'); }
      return;
    }
    let qrImage = ticketQrUrl;
    if (!qrImage && ticket.importToken) {
      try {
        const baseUrl = window.location.origin;
        const claimUrl = `${baseUrl}/?claim=${ticket.importToken}`;
        qrImage = await generateQRDataURL(claimUrl, { width: 200 });
        if (qrImage) setTicketQrUrl(qrImage);
      } catch { /* proceed without QR */ }
    }
    try {
      const agencyDisplayName = ticket.agencyNameAr && lang === 'ar' ? ticket.agencyNameAr : ticket.agencyNameFr && lang === 'fr' ? ticket.agencyNameFr : ticket.agencyName;
      const serviceDisplayName = ticket.serviceNameAr && lang === 'ar' ? ticket.serviceNameAr : ticket.serviceNameFr && lang === 'fr' ? ticket.serviceNameFr : ticket.serviceName;
      const qrHtml = qrImage ? `<div class="qr"><img src="${qrImage}" alt="QR" /></div>\n<div class="center small">${t('scanToTrackQueue') || 'Scan QR to track your queue'}</div>` : '';
      const methodLabel = ticket.method === 'WALK_IN' ? (t('walkIn') || 'Walk-in') : (ticket.method || (t('walkIn') || 'Walk-in'));
      const branchDisplayName = ticket.branchNameAr && lang === 'ar' ? ticket.branchNameAr : ticket.branchNameFr && lang === 'fr' ? ticket.branchNameFr : ticket.branchName || '';
      const receiptHtml = `
        <div class="center bold large">${agencyDisplayName}</div>
        <hr />
        <div class="center medium" style="margin-top:4px">
          <span class="bold" style="font-size:32px">${ticket.ticketNumber}</span>
        </div>
        <hr />
        <div class="small" style="margin-top:4px">
          <div class="bold">${ticket.customerName}</div>
          <div>${serviceDisplayName}</div>
          ${branchDisplayName ? `<div>${branchDisplayName}</div>` : ''}
          <div>${t('reservationMethod') || 'Method'}: ${methodLabel}</div>
          <div>${ticket.joinedAt ? new Date(ticket.joinedAt).toLocaleString() : ''}</div>
          <div>${t('estimatedWait') || 'Estimated Wait'}: ~${ticket.estimatedWaitMinutes} ${t('minutesKiosk') || 'min'}</div>
        </div>
        <hr />
        ${qrHtml}
        <hr />
        <div class="center small" style="margin-top:4px">${t('kioskThankYou') || 'Thank you'}</div>
      `;
      const win = window.open('', '_blank', 'width=400,height=600');
      if (win) {
        win.document.write(`<html><head><title>${t('printTicket') || 'Print Ticket'}</title>
          <style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: 'Courier New', monospace; width: 80mm; padding: 4mm; } .center { text-align: center; } .bold { font-weight: bold; } .large { font-size: 28px; font-weight: bold; } .medium { font-size: 14px; } .small { font-size: 11px; } hr { border: none; border-top: 1px dashed #333; margin: 6px 0; } .qr { text-align: center; margin: 8px 0; } .qr img { width: 180px; height: 180px; }</style></head><body>
          ${receiptHtml}
          <script>window.onload=function(){window.print();window.close();}</script>
          </body></html>`);
        win.document.close();
      } else { setPrintError('Popup blocked — please allow popups for this site'); }
    } catch { setPrintError('Failed to print ticket'); }
  };

  // ─── Code Submit ───────────────────────────────────────────
  const handleCodeSubmit = () => {
    if (agencyCode.trim()) {
      setRetryCount(0);
      setShowContactAdmin(false);
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      fetchAgency(agencyCode.trim());
    }
  };

  // ─── Discovery Login ───────────────────────────────────────
  const handleStartDiscovery = useCallback(async () => {
    userChoseStep.current = true;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setDiscoveryStatus('registering');
    setPairingRequests([]);
    try {
      // Use AbortController with 15s timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);

      const res = await apiFetch('/api/agency-devices/public/discover-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ deviceName: 'BLASTI Kiosk', deviceType: 'KIOSK', connectionType: lanServer ? 'LAN' : 'WIFI', deviceFingerprint: generateFingerprint() }),
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        // Surface the actual API error body instead of a useless "500".
        // The API returns { success:false, error:"..." } on failures, but
        // a 500 can also come from Next.js dev rewrites when the API server
        // (port 3003) is down — in which case the body is an HTML error page.
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
        const message = `Server returned ${res.status}${detail ? `: ${detail}` : ''}`;
        console.error('[Kiosk Discovery] discover-register failed:', res.status, detail);
        throw new Error(message);
      }
      const data = await res.json();
      if (data.success && data.deviceToken) {
        setDiscoveryToken(data.deviceToken);
        discoveryTokenRef.current = data.deviceToken;
        setDeviceToken(data.deviceToken);
        setDeviceId(data.device.id);
        saveDeviceToken(data.deviceToken);
        saveDeviceId(data.device.id);
        setDiscoveryStatus('waiting');
        setStep('discovery');
        startDeviceHeartbeat(data.deviceToken);
        // Poll device-status for pairing requests
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
        }, 5000);
      } else {
        setDiscoveryStatus('idle');
        setDiscoveryError(data.error || 'Discovery registration failed');
        toast.error(data.error || 'Discovery registration failed');
      }
    } catch (err: unknown) {
      setDiscoveryStatus('idle');
      const message = err instanceof Error
        ? (err.name === 'AbortError' ? 'Connection timed out. Please check your network and try again.' : err.message)
        : 'Network error — could not reach the server';
      setDiscoveryError(message);
      toast.error(message);
    } finally {
      setDiscoveryLoading(false);
    }
  }, [lanServer, startDeviceHeartbeat]);

  // ─── Accept Pairing Request ───────────────────────────────
  const handleAcceptPairing = useCallback(async (request: PairingRequest) => {
    // Use ref to avoid stale closure — discoveryToken may not be in the React
    // state yet when the user clicks Accept (it was set by handleStartDiscovery
    // in a prior render cycle but the callback captures the old '' value).
    const token = discoveryTokenRef.current || discoveryToken;
    if (!token) {
      console.warn('[Kiosk] Accept pairing called but no discovery token available');
      toast.error('No device token — please try discovery again');
      setDiscoveryStatus('waiting');
      return;
    }
    setDiscoveryStatus('connecting');
    // Stop discovery polling immediately to avoid race conditions
    if (discoveryPollRef.current) { clearInterval(discoveryPollRef.current); discoveryPollRef.current = null; }
    try {
      const res = await apiFetch('/api/agency-devices/device/accept-pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ commandId: request.id, agencyId: request.agencyId }),
      });
      const data = await res.json();
      if (data.success && data.agency) {
        // Use agency + services directly from the accept-pairing response
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
        // Restart heartbeat to ensure it uses the correct token post-pairing
        startDeviceHeartbeat(token);
        setStep('services');
        toast.success(t('kioskPairedSuccessfully') || 'Successfully connected!');
      } else {
        setDiscoveryStatus('waiting');
        toast.error(data.error || 'Pairing failed');
      }
    } catch {
      setDiscoveryStatus('waiting');
      toast.error('Network error during pairing');
    }
  }, [discoveryToken, t, startDeviceHeartbeat]);

  // ─── Reject Pairing Request ───────────────────────────────
  const handleRejectPairing = useCallback(async (request: PairingRequest) => {
    const token = discoveryTokenRef.current || discoveryToken;
    if (!token) return;
    try {
      await apiFetch('/api/agency-devices/device/reject-pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ commandId: request.id }),
      });
      setPairingRequests(prev => prev.filter(r => r.id !== request.id));
      toast.success(t('kioskPairingRejected') || 'Pairing request rejected');
    } catch {
      toast.error('Failed to reject pairing');
    }
  }, [discoveryToken, t]);

  // Cleanup discovery poll on unmount
  useEffect(() => {
    return () => { if (discoveryPollRef.current) clearInterval(discoveryPollRef.current); };
  }, []);

  // ─── Auto-Connect for Already-Paired Devices ───────────────
  // If a deviceToken is saved in localStorage, verify it and auto-connect.
  // Guard: skip auto-connect if user has already manually chosen a step.
  const userChoseStep = useRef(false);
  useEffect(() => {
    const token = loadDeviceToken();
    if (!token) return;

    let cancelled = false;
    async function tryAutoConnect() {
      try {
        // Don't override if user already chose a step (e.g., clicked "Wait for Discovery")
        if (cancelled || userChoseStep.current) return;

        // Send a heartbeat first to bring the device back to ONLINE
        await apiFetch('/api/agency-devices/device/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ appVersion: '1.0.0', ipAddress: kioskIp || lanServer?.ip || undefined }),
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
      }
    }

    // Wait briefly for LAN discovery to complete first
    const timer = setTimeout(tryAutoConnect, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      customerName: customerName.trim(),
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
  }, [agency, selectedService, services, customerName, lang, t]);

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

        <div className="flex gap-1">
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

      {/* Step Indicator */}
      {step !== 'code' && step !== 'discovery' && step !== 'qr-scan' && step !== 'method-select' && step !== 'credentials' && (
        <div className="px-4 pt-0.5 pb-0.5 print:hidden shrink-0">
          <KioskStepIndicator currentStep={step} stepLabels={stepLabels} rtl={rtl} />
        </div>
      )}

      {/* Currently Serving Banner (compact) */}
      {agency && queueStats && !isOfflineMode && (queueStats.currentServing || (queueStats.currentlyServingList && queueStats.currentlyServingList.length > 0)) && step !== 'ticket' && (
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
              <div className="bg-white rounded-3xl shadow-2xl p-5 sm:p-6 text-center">
                <div className="h-12 w-12 mx-auto rounded-xl bg-emerald-100 flex items-center justify-center mb-2">
                  <Search className="h-6 w-6 text-emerald-600" />
                </div>
                <h1 className="text-xl font-bold text-gray-900 mb-1">{t('enterAgencyCode')}</h1>
                <p className="text-gray-500 mb-4 text-sm">{t('agencyCodePlaceholder')}</p>

                <input
                  type="text"
                  value={agencyCode}
                  onChange={(e) => setAgencyCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCodeSubmit(); }}
                  placeholder={t('agencyCodePlaceholder')}
                  className="w-full min-h-[52px] rounded-2xl border-2 border-gray-200 px-5 text-lg text-center font-semibold focus:border-emerald-500 focus:outline-none transition-colors uppercase tracking-widest"
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
                  className="w-full min-h-[44px] mt-3 rounded-xl bg-gray-100 text-gray-600 font-medium hover:bg-gray-200 transition-colors flex items-center justify-center gap-2 text-sm"
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
              t={t}
              lang={lang}
              kioskIp={displayKioskIp}
              pageVariants={pageVariants}
              onBack={() => {
                if (discoveryPollRef.current) clearInterval(discoveryPollRef.current);
                discoveryPollRef.current = null;
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
              t={t}
              pageVariants={pageVariants}
              onSelectService={setSelectedService}
              onBack={handleReset}
              onNext={() => {
                if (selectedService) {
                  setError(null);
                  if (isOfflineMode) { handleOfflineJoinQueue(); } else { setStep('name'); }
                }
              }}
            />
          )}

          {/* Step 3: Enter Name (optional) */}
          {step === 'name' && agency && selectedService && (
            <motion.div
              key="name"
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="w-full max-w-md"
            >
              <div className="bg-white rounded-3xl shadow-2xl p-5 sm:p-6 text-center">
                <div className="h-12 w-12 mx-auto rounded-xl bg-emerald-100 flex items-center justify-center mb-2">
                  <Users className="h-6 w-6 text-emerald-600" />
                </div>
                <h2 className="text-xl font-bold text-gray-900 mb-1">{t('enterYourName')}</h2>

                {services.find((s) => s.id === selectedService) && (
                  <div className="mb-4 mt-3 p-2.5 rounded-xl bg-emerald-50 border border-emerald-200">
                    <p className="text-sm text-emerald-600 font-medium">
                      {services.find((s) => s.id === selectedService)?.prefix} — {getLocalizedName(services.find((s) => s.id === selectedService)!, lang)}
                    </p>
                  </div>
                )}

                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder={t('enterYourName')}
                  className="w-full min-h-[52px] rounded-2xl border-2 border-gray-200 px-5 text-lg focus:border-emerald-500 focus:outline-none transition-colors text-center text-gray-900"
                  autoFocus
                />

                {error && (
                  <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mt-3 p-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium">
                    {error}
                  </motion.div>
                )}

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={isOfflineMode ? handleOfflineJoinQueue : handleJoinQueue}
                  disabled={loading && !isOfflineMode}
                  className={`w-full min-h-[56px] rounded-2xl text-lg font-bold shadow-lg mt-4 flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                    isOfflineMode
                      ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:shadow-xl'
                      : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl'
                  }`}
                >
                  {loading && !isOfflineMode ? <Loader2 className="h-6 w-6 animate-spin" /> : isOfflineMode ? <WifiOff className="h-6 w-6" /> : <Ticket className="h-6 w-6" />}
                  {isOfflineMode ? t('kioskOfflineMode') : t('joinQueueKiosk')}
                </motion.button>

                <button
                  onClick={() => { setStep('services'); setError(null); }}
                  className="mt-3 min-h-[44px] px-5 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 font-medium transition-colors"
                >
                  {t('kioskBack')}
                </button>
              </div>
            </motion.div>
          )}

          {/* Step 4: Ticket Display */}
          {step === 'ticket' && ticket && agency && (
            <KioskTicketDisplay
              ticket={ticket}
              queueStats={queueStats}
              isOfflineMode={isOfflineMode}
              rtl={rtl}
              lang={lang}
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

      {/* Footer */}
      <div className="text-center pb-4 text-white/40 text-xs print:hidden">
        BLASTI — {t('kioskTitle')}
      </div>

      {/* LAN Connection Indicator */}
      {!isDiscovering && (
        <div className="fixed bottom-4 left-4 z-50">
          {lanServer ? (
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
              <Wifi className="h-3 w-3 ml-1" />
              LAN: {lanServer.hostname}
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700">
              <WifiOff className="h-3 w-3 ml-1" />
              Cloud Mode
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}