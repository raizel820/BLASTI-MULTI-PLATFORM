'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { isRTL, type Language } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { KioskQrScanner } from './kiosk-qr-scanner';
import { quickDiscover, getLanApiUrl, type DiscoveredServer } from '@/lib/lan-discovery';
import { apiClient } from '@/lib/api-client';
import {
  Search,
  Ticket,
  Clock,
  Users,
  Loader2,
  CheckCircle,
  Hash,
  Printer,
  RotateCcw,
  Globe,
  AlertTriangle,
  XCircle,
  Pause,
  Monitor,
  Timer,
  ScanLine,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';

type KioskStep = 'code' | 'services' | 'name' | 'ticket' | 'qr-scan';

interface AgencyInfo {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  category: string;
  logoUrl?: string | null;
  workingHoursStart: string;
  workingHoursEnd: string;
  isQueueOpen: boolean;
  isPaused: boolean;
}

interface ServiceInfo {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  prefix: string;
  avgTime: number;
}

interface QueueStats {
  waiting: number;
  currentServing: string | null;
  estimatedWait: number;
  currentlyServingList?: { ticketNumber: string; counterName?: string }[];
}

interface TicketInfo {
  id: string;
  ticketNumber: string;
  position: number;
  estimatedWaitMinutes: number;
}

// ─── Kiosk Confetti Particles ─────────────────────
function KioskConfetti({ active }: { active: boolean }) {
  const [particles] = useState(() =>
    Array.from({ length: 30 }, (_, i) => ({
      id: i,
      x: 20 + Math.random() * 60,
      delay: Math.random() * 0.6,
      duration: 1.5 + Math.random() * 1.5,
      size: 6 + Math.random() * 10,
      color: ['#10b981', '#14b8a6', '#f59e0b', '#f43f5e', '#06b6d4', '#a78bfa', '#ffffff'][Math.floor(Math.random() * 7)],
      rotation: Math.random() * 360,
      xDrift: Math.random() * 40 - 20,
      shape: Math.random() > 0.5 ? 'circle' : 'rect',
    }))
  );

  if (!active) return null;

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-30">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ y: '30%', x: `${p.x}%`, opacity: 1, scale: 0, rotate: 0 }}
          animate={{
            y: '-30%',
            x: `${p.x + p.xDrift}%`,
            opacity: [0, 1, 1, 0],
            scale: [0, 1.5, 1, 0.3],
            rotate: [0, p.rotation * 2, p.rotation * 4],
          }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeOut' }}
          className="absolute"
          style={{
            width: p.size,
            height: p.shape === 'rect' ? p.size * 0.6 : p.size,
            backgroundColor: p.color,
            borderRadius: p.shape === 'circle' ? '50%' : '2px',
          }}
        />
      ))}
    </div>
  );
}

export function KioskMode() {
  const { t, lang, setLang } = useLanguage();
  const rtl = isRTL(lang);

  // State
  const [step, setStep] = useState<KioskStep>('code');
  const [agencyCode, setAgencyCode] = useState(() => {
    // Phase 7a: Persist agency code in localStorage
    if (typeof window !== 'undefined') {
      try { return localStorage.getItem('blasti_kiosk_code') || ''; } catch { return ''; }
    }
    return '';
  });
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

  // Phase 7a: Retry tracking for agency code validation
  const [retryCount, setRetryCount] = useState(0);
  const [showContactAdmin, setShowContactAdmin] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MAX_RETRIES = 3;
  // Exponential backoff delays: 2s, 8s, 32s
  const BACKOFF_DELAYS = [2000, 8000, 32000];

  // Inactivity timer for ticket display (60 seconds)
  const [inactivitySeconds, setInactivitySeconds] = useState(0);

  // Digital clock state
  const [currentTime, setCurrentTime] = useState(new Date());

  // Auto-refresh status bar state
  const [lastStatusRefresh, setLastStatusRefresh] = useState<Date>(new Date());

  const realtime = useRealtime();
  const prevAgencyIdRef = useRef<string | null>(null);

  // ─── LAN Auto-Discovery ─────────────────────
  const [lanServer, setLanServer] = useState<DiscoveredServer | null>(null);
  const [isDiscovering, setIsDiscovering] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function discover() {
      try {
        const server = await quickDiscover();
        if (mounted && server) {
          setLanServer(server);
          // Switch API client to use LAN server
          const lanUrl = getLanApiUrl(server);
          apiClient.setBaseUrl(lanUrl);
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

  // Phase 7a: Persist agency code to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('blasti_kiosk_code', agencyCode); } catch { /* ignore */ }
    }
  }, [agencyCode]);

  // ─── Digital Clock ──────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Format time for display
  const formatClockTime = (date: Date) => {
    return date.toLocaleTimeString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    );
  };

  const formatClockDate = (date: Date) => {
    return date.toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { weekday: 'short', month: 'short', day: 'numeric' }
    );
  };

  // Fetch agency by code — Phase 7a: retry with exponential backoff
  // Use a ref to avoid self-referencing lint issue with useCallback
  const fetchAgencyRef = useRef<(code: string, isAutoRetry?: boolean) => void>(() => {});

  const fetchAgency = useCallback(async (code: string, isAutoRetry = false) => {
    if (!code.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/kiosk/agency?code=${encodeURIComponent(code.trim())}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Agency not found');
        // Phase 7a: Increment retry count and check max retries
        setRetryCount((prev) => {
          const next = prev + 1;
          if (next >= MAX_RETRIES) {
            setShowContactAdmin(true);
          } else {
            // Schedule auto-retry with exponential backoff
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            retryTimerRef.current = setTimeout(() => {
              fetchAgencyRef.current(code, true);
            }, BACKOFF_DELAYS[Math.min(next - 1, BACKOFF_DELAYS.length - 1)]);
          }
          return next;
        });
        return;
      }
      // Success — reset retry count
      setRetryCount(0);
      setShowContactAdmin(false);
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setAgency(data.agency);
      setServices(data.services || []);
      setQueueStats(data.queueStats);
      // Auto-advance if queue is open
      if (data.agency.isQueueOpen && !data.agency.isPaused) {
        setStep('services');
      }
    } catch {
      setError('Network error');
      // Phase 7a: Network errors also count as retries
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
  }, []);

  // Keep the ref in sync with the callback
  useEffect(() => {
    fetchAgencyRef.current = fetchAgency;
  }, [fetchAgency]);

  // Phase 7a: Clean up retry timer on unmount
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  // Phase 7a: On mount, auto-fetch agency if a code was previously saved
  useEffect(() => {
    if (agencyCode.trim()) {
      fetchAgency(agencyCode.trim());
    }

  }, []);

  // Helper to refresh kiosk queue status
  const refreshKioskStatus = useCallback(async (agencyId: string) => {
    try {
      const res = await apiFetch(`/api/kiosk/status?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        setQueueStats({
          waiting: data.totalWaiting ?? 0,
          currentServing: data.currentlyServing?.[0]?.ticketNumber ?? null,
          estimatedWait: data.totalEstimatedWait ?? 0,
          currentlyServingList: data.currentlyServing ?? [],
        });
        setLastStatusRefresh(new Date());
      }
    } catch {
      // silent
    }
  }, []);

  // Auto-refresh queue status every 30 seconds when agency is loaded
  useEffect(() => {
    if (!agency) return;
    // Initial fetch
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

  // ─── Realtime: Join kiosk room for instant updates ──────────────────
  useEffect(() => {
    if (!agency?.id) return;
    // Avoid re-joining if agency hasn't changed
    if (prevAgencyIdRef.current === agency.id) return;
    prevAgencyIdRef.current = agency.id;
    realtime.joinKiosk(agency.id);
    return () => {
      realtime.leaveKiosk(agency.id);
    };
  }, [agency?.id]);

  // ─── Realtime: Instant updates on kiosk events ──────────────────────
  useEffect(() => {
    if (!agency?.id) return;
    const unsubscribers: (() => void)[] = [];

    const handleKioskEvent = () => {
      refreshKioskStatus(agency.id);
    };

    unsubscribers.push(realtime.onKioskUpdate(handleKioskEvent));
    unsubscribers.push(realtime.onQueueCalled(handleKioskEvent));
    unsubscribers.push(realtime.onQueuePaused(handleKioskEvent));
    unsubscribers.push(realtime.onQueueResumed(handleKioskEvent));
    unsubscribers.push(realtime.onQueueCompleted(handleKioskEvent));
    unsubscribers.push(realtime.onQueueJoined(handleKioskEvent));

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [agency?.id, realtime, refreshKioskStatus]);

  // Inactivity timer — auto-return after 60s on ticket screen
  useEffect(() => {
    if (step !== 'ticket') {
      setInactivitySeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setInactivitySeconds((prev) => {
        if (prev >= 60) {
          handleReset();
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [step]);

  // Reset inactivity on any interaction
  const resetInactivity = useCallback(() => {
    if (step === 'ticket') {
      setInactivitySeconds(0);
    }
  }, [step]);

  useEffect(() => {
    if (step !== 'ticket') return;
    const events = ['touchstart', 'click', 'keydown'] as const;
    const handler = () => resetInactivity();
    events.forEach((e) => window.addEventListener(e, handler));
    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
    };
  }, [step, resetInactivity]);

  // Join queue
  const handleJoinQueue = async () => {
    if (!agency || !selectedService) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/kiosk/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agencyId: agency.id,
          serviceId: selectedService,
          customerName: customerName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to join queue');
        return;
      }
      setTicket(data.reservation);
      setStep('ticket');
      setInactivitySeconds(0);
      // Trigger confetti
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3500);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  // Reset kiosk to service selection — Phase 7a: retain agency context
  const handleReset = useCallback(() => {
    setStep('services'); // Go back to service selection, NOT code entry
    // Keep agencyCode and agency intact — operator doesn't need to re-enter code
    setQueueStats(null);
    setSelectedService(null);
    setCustomerName('');
    setTicket(null);
    setError(null);
    setInactivitySeconds(0);
    setShowConfetti(false);
    // Phase 7a: Reset retry state but don't clear agency code
    setRetryCount(0);
    setShowContactAdmin(false);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  // Get localized name
  const getLocalizedName = (obj: { name: string; nameAr?: string | null; nameFr?: string | null }) => {
    if (lang === 'ar' && obj.nameAr) return obj.nameAr;
    if (lang === 'fr' && obj.nameFr) return obj.nameFr;
    return obj.name;
  };

  // Print ticket — Phase 7b: use silent print in Electron to bypass OS print preview.
  // Looks up the agency's default printer (configured in Device Manager) and
  // passes its name to printSilent so the kiosk uses the right printer — whether
  // it's a USB printer connected to the desktop machine or a network printer on
  // the same LAN/WiFi.
  const handlePrint = async () => {
    if (typeof window !== 'undefined' && (window as any).electronAPI?.printSilent) {
      try {
        // Try to look up the agency's default printer
        let printOptions: { deviceName?: string } = {};
        if (agency?.id) {
          try {
            const res = await apiFetch(`/api/agency-devices/discovery/default-printer?agencyId=${agency.id}&XTransformPort=3003`);
            if (res.ok) {
              const data = await res.json();
              if (data.success && data.defaultPrinter) {
                // Prefer the CUPS queue name (works for both USB and network
                // printers that have been added to the OS)
                const printerName = data.defaultPrinter.cupsName || data.defaultPrinter.name;
                if (printerName) printOptions = { deviceName: printerName };
              }
            }
          } catch {
            // Default printer lookup failed — fall back to system default printer
          }
        }
        const result = await (window as any).electronAPI.printSilent(printOptions);
        if (!result?.success) {
          // Printer jam or error — show error on screen
          toast.error(t('printerError') || 'Printer error. Please check the printer and try again.');
          setPrintError(result?.message || t('printerErrorMessage') || 'Printer may be jammed or offline');
        }
      } catch (err) {
        toast.error(t('printerError') || 'Printer error. Please check the printer.');
        setPrintError('Failed to communicate with printer');
      }
    } else {
      window.print();
    }
  };

  // Handle code submit — Phase 7a: reset retry state for new code entry
  const handleCodeSubmit = () => {
    if (agencyCode.trim()) {
      setRetryCount(0);
      setShowContactAdmin(false);
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      fetchAgency(agencyCode.trim());
    }
  };

  const languages: { code: Language; label: string }[] = [
    { code: 'ar', label: 'عربي' },
    { code: 'fr', label: 'FR' },
    { code: 'en', label: 'EN' },
  ];

  const pageVariants = {
    enter: { opacity: 0, x: rtl ? -40 : 40 },
    center: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: rtl ? 40 : -40 },
  };

  // ─── Currently Serving Display Component ───────────
  const CurrentlyServingDisplay = () => {
    const servingList = queueStats?.currentlyServingList;
    const currentServing = queueStats?.currentServing;

    if (!currentServing && (!servingList || servingList.length === 0)) return null;

    return (
      <motion.div
        initial={{ opacity: 0, y: -5 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white/10 backdrop-blur-sm rounded-2xl p-4 print:hidden"
      >
        <div className="flex items-center gap-2 mb-2">
          <Monitor className="h-4 w-4 text-emerald-200" />
          <p className="text-sm font-semibold text-emerald-100">{t('currentlyServingKiosk')}</p>
        </div>
        {servingList && servingList.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {servingList.slice(0, 4).map((item, i) => (
              <div key={i} className="bg-white/10 rounded-xl p-2.5 text-center">
                <p className="text-2xl font-bold text-white">{item.ticketNumber}</p>
                {item.counterName && (
                  <p className="text-[10px] text-emerald-200/80 mt-0.5">{item.counterName}</p>
                )}
              </div>
            ))}
          </div>
        ) : currentServing ? (
          <div className="bg-white/10 rounded-xl p-3 text-center">
            <motion.p
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              className="text-3xl font-bold text-white"
            >
              {currentServing}
            </motion.p>
          </div>
        ) : null}
      </motion.div>
    );
  };

  // ─── Estimated Wait Display ───────────────────────
  const EstimatedWaitDisplay = () => {
    if (!ticket || !queueStats) return null;
    const waitMinutes = ticket.estimatedWaitMinutes || queueStats.estimatedWait || 0;

    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.9 }}
        className="bg-white/10 backdrop-blur-sm rounded-2xl p-4 text-center print:hidden"
      >
        <div className="flex items-center justify-center gap-2 mb-2">
          <Timer className="h-4 w-4 text-emerald-200" />
          <p className="text-sm font-semibold text-emerald-100">{t('yourEstimatedWait') || 'Your Estimated Wait'}</p>
        </div>
        <div className="flex items-baseline justify-center gap-1">
          {waitMinutes >= 60 ? (
            <>
              <motion.p
                animate={{ scale: [1, 1.02, 1] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="text-3xl font-bold text-white"
              >
                {Math.floor(waitMinutes / 60)}
              </motion.p>
              <span className="text-sm text-emerald-200">{lang === 'ar' ? 'ساعة' : lang === 'fr' ? 'h' : 'hr'}</span>
              {waitMinutes % 60 > 0 && (
                <>
                  <motion.p
                    animate={{ scale: [1, 1.02, 1] }}
                    transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
                    className="text-3xl font-bold text-white"
                  >
                    {waitMinutes % 60}
                  </motion.p>
                  <span className="text-sm text-emerald-200">{t('minutesKiosk')}</span>
                </>
              )}
            </>
          ) : (
            <>
              <motion.p
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                className="text-4xl font-bold text-white"
              >
                {waitMinutes}
              </motion.p>
              <span className="text-sm text-emerald-200">{t('minutesKiosk')}</span>
            </>
          )}
        </div>
        {/* Auto-refresh indicator */}
        <p className="text-[10px] text-emerald-200/50 mt-2 flex items-center justify-center gap-1">
          <motion.span
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
          >
            ●
          </motion.span>
          {t('autoRefreshKiosk') || 'Auto-updates every 30s'}
        </p>
      </motion.div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-gradient-to-br from-emerald-600 via-emerald-700 to-teal-800 flex flex-col select-none overflow-hidden"
      dir={rtl ? 'rtl' : 'ltr'}
      onClick={resetInactivity}
      onTouchStart={resetInactivity}
    >
      {/* ─── Digital Clock Header ─────────────────────────── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 print:hidden">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl overflow-hidden bg-white/10 p-0.5">
            <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
          </div>
          <span className="text-lg font-bold text-white">BLASTI</span>
        </div>

        {/* Large Digital Clock */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white/10 backdrop-blur-sm rounded-xl px-4 py-2 text-center"
        >
          <p className="text-2xl sm:text-3xl font-mono font-bold text-white tracking-wider" dir="ltr">
            {formatClockTime(currentTime)}
          </p>
          <p className="text-[10px] text-emerald-200/80 -mt-0.5">
            {formatClockDate(currentTime)}
          </p>
        </motion.div>

        {/* Language selector */}
        <div className="flex gap-1.5">
          {languages.map((l) => (
            <button
              key={l.code}
              onClick={() => setLang(l.code)}
              className={`min-h-[40px] min-w-[40px] px-3 rounded-xl text-sm font-semibold transition-all ${
                lang === l.code
                  ? 'bg-white text-emerald-700 shadow-lg'
                  : 'bg-white/20 text-white hover:bg-white/30'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live connection indicator */}
      {agency && (
        <div className="px-4 pb-1 print:hidden">
          <span className={`inline-flex items-center gap-1.5 text-xs ${realtime.isConnected ? 'text-emerald-300' : 'text-amber-300'}`}>
            <span className={`h-2 w-2 rounded-full inline-block ${realtime.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            {realtime.isConnected ? (t('live') || 'Live') : (t('polling') || 'Polling')}
          </span>
        </div>
      )}

      {/* ─── Currently Serving Banner (shows when agency loaded) ─── */}
      {agency && queueStats && (queueStats.currentServing || (queueStats.currentlyServingList && queueStats.currentlyServingList.length > 0)) && step !== 'ticket' && (
        <div className="px-4 pb-2 print:hidden">
          <CurrentlyServingDisplay />
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
        <AnimatePresence mode="wait">
          {/* ─── Step 1: Enter Agency Code ─── */}
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
              <div className="bg-white rounded-3xl shadow-2xl p-8 text-center">
                <div className="h-16 w-16 mx-auto rounded-2xl bg-emerald-100 flex items-center justify-center mb-4">
                  <Search className="h-8 w-8 text-emerald-600" />
                </div>
                <h1 className="text-2xl font-bold text-gray-900 mb-2">
                  {t('enterAgencyCode')}
                </h1>
                <p className="text-gray-500 mb-6 text-sm">
                  {t('agencyCodePlaceholder')}
                </p>

                <input
                  type="text"
                  value={agencyCode}
                  onChange={(e) => setAgencyCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCodeSubmit(); }}
                  placeholder={t('agencyCodePlaceholder')}
                  className="w-full min-h-[60px] rounded-2xl border-2 border-gray-200 px-5 text-xl text-center font-semibold focus:border-emerald-500 focus:outline-none transition-colors uppercase tracking-widest"
                  autoFocus
                  dir="ltr"
                />

                {/* Phase 7a: Contact Admin screen when max retries exceeded */}
                {showContactAdmin ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="mt-4 p-6 rounded-2xl bg-red-50 border-2 border-red-200 text-center"
                  >
                    <XCircle className="h-12 w-12 text-red-500 mx-auto mb-3" />
                    <h3 className="text-lg font-bold text-red-700 mb-2">
                      {t('contactAdminTitle') || 'Unable to Connect'}
                    </h3>
                    <p className="text-sm text-red-600 mb-4">
                      {t('contactAdminDesc') || 'The agency code could not be verified after multiple attempts. Please contact an administrator for assistance.'}
                    </p>
                    <div className="flex items-center justify-center gap-2 text-xs text-red-400 mb-4">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      <span>{t('retryCountExceeded') || `Retry limit (${MAX_RETRIES}) exceeded`}</span>
                    </div>
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => {
                        setRetryCount(0);
                        setShowContactAdmin(false);
                        setError(null);
                        setAgencyCode('');
                        try { localStorage.removeItem('blasti_kiosk_code'); } catch { /* ignore */ }
                      }}
                      className="min-h-[48px] px-6 rounded-2xl bg-red-600 text-white font-semibold hover:bg-red-700 transition-colors"
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
                      <span className="text-xs text-red-400 ms-2">
                        {t('attempt') || 'Attempt'} {retryCount}/{MAX_RETRIES}
                      </span>
                    )}
                  </motion.div>
                ) : null}

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleCodeSubmit}
                  disabled={loading || !agencyCode.trim() || showContactAdmin}
                  className={`w-full min-h-[64px] rounded-2xl text-xl font-bold shadow-lg mt-6 flex items-center justify-center gap-3 transition-all ${
                    !agencyCode.trim() || loading || showContactAdmin
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
                      : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl'
                  }`}
                >
                  {loading ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <Search className="h-6 w-6" />
                  )}
                  {t('search')}
                </motion.button>

                <div className="mt-6 pt-4 border-t border-gray-100">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setStep('qr-scan')}
                    className="w-full py-3 px-4 rounded-xl border-2 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 flex items-center justify-center gap-2 text-sm font-medium transition-colors"
                  >
                    <ScanLine className="h-5 w-5" />
                    {t('qrScan') || 'Scan QR'}
                  </motion.button>
                  <p className="text-xs text-gray-400 flex items-center justify-center gap-1 mt-3">
                    <Globe className="h-3.5 w-3.5" />
                    {t('scanQrCodeKiosk')}
                  </p>
                </div>
              </div>
            </motion.div>
          )}

          {/* ─── Step 2: Select Service ─── */}
          {step === 'services' && agency && (
            <motion.div
              key="services"
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="w-full max-w-lg"
            >
              <div className="bg-white rounded-3xl shadow-2xl p-6 sm:p-8">
                {/* Agency header */}
                <div className="flex items-center gap-4 mb-6">
                  <button
                    onClick={handleReset}
                    className="min-h-[48px] min-w-[48px] rounded-xl bg-gray-100 flex items-center justify-center hover:bg-gray-200 transition-colors flex-shrink-0"
                  >
                    <svg className={`h-5 w-5 text-gray-600 ${rtl ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                  </button>
                  <div className="min-w-0">
                    <h2 className="text-xl font-bold text-gray-900 truncate">
                      {getLocalizedName(agency)}
                    </h2>
                    <p className="text-sm text-gray-500">
                      {agency.workingHoursStart} — {agency.workingHoursEnd}
                    </p>
                  </div>
                </div>

                {/* Queue status badges */}
                {queueStats && (
                  <div className="flex gap-3 mb-6">
                    <div className="flex-1 bg-emerald-50 rounded-xl p-3 text-center">
                      <Users className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
                      <p className="text-xl font-bold text-emerald-700">{queueStats.waiting}</p>
                      <p className="text-[10px] text-emerald-600">{t('kioskWaiting')}</p>
                    </div>
                    <div className="flex-1 bg-teal-50 rounded-xl p-3 text-center">
                      <Ticket className="h-5 w-5 text-teal-600 mx-auto mb-1" />
                      <p className="text-xl font-bold text-teal-700">{queueStats.currentServing || '—'}</p>
                      <p className="text-[10px] text-teal-600">{t('currentlyServingKiosk')}</p>
                    </div>
                    <div className="flex-1 bg-amber-50 rounded-xl p-3 text-center">
                      <Clock className="h-5 w-5 text-amber-600 mx-auto mb-1" />
                      <p className="text-xl font-bold text-amber-700">{queueStats.estimatedWait}</p>
                      <p className="text-[10px] text-amber-600">{t('minutesKiosk')}</p>
                    </div>
                  </div>
                )}

                {/* Queue status warnings */}
                {!agency.isQueueOpen && (
                  <div className="mb-4 p-4 rounded-2xl bg-red-50 border border-red-200 flex items-center gap-3">
                    <XCircle className="h-6 w-6 text-red-500 flex-shrink-0" />
                    <p className="text-red-700 font-semibold">{t('queueClosedKiosk')}</p>
                  </div>
                )}
                {agency.isPaused && agency.isQueueOpen && (
                  <div className="mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-200 flex items-center gap-3">
                    <Pause className="h-6 w-6 text-amber-500 flex-shrink-0" />
                    <p className="text-amber-700 font-semibold">{t('queuePausedKiosk')}</p>
                  </div>
                )}

                {/* Service selection */}
                <h3 className="text-lg font-semibold text-gray-800 mb-3">
                  {t('selectServiceKiosk')}
                </h3>

                {services.length === 0 ? (
                  <p className="text-gray-400 text-center py-8">{t('kioskNoServices')}</p>
                ) : (
                  <div className="space-y-3 max-h-[40vh] overflow-y-auto pe-1">
                    {services.map((service) => {
                      const isSelected = selectedService === service.id;
                      return (
                        <motion.button
                          key={service.id}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => setSelectedService(service.id)}
                          className={`w-full min-h-[72px] rounded-2xl p-4 text-start transition-all border-2 flex items-center justify-between ${
                            isSelected
                              ? 'border-emerald-500 bg-emerald-50 shadow-lg shadow-emerald-100'
                              : 'border-gray-100 bg-white hover:border-emerald-200 hover:shadow-md'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-bold px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-700">
                              {service.prefix}
                            </span>
                            <div>
                              <p className="text-lg font-semibold text-gray-900">
                                {getLocalizedName(service)}
                              </p>
                              <p className="text-xs text-gray-500 flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                ~{service.avgTime} {t('minutesKiosk')}
                              </p>
                            </div>
                          </div>
                          {isSelected && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              className="w-8 h-8 rounded-full bg-emerald-600 flex items-center justify-center flex-shrink-0"
                            >
                              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            </motion.div>
                          )}
                        </motion.button>
                      );
                    })}
                  </div>
                )}

                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium"
                  >
                    {error}
                  </motion.div>
                )}

                {/* Next button */}
                <motion.button
                  whileHover={{ scale: selectedService ? 1.02 : 1 }}
                  whileTap={{ scale: selectedService ? 0.98 : 1 }}
                  onClick={() => {
                    if (selectedService) {
                      setError(null);
                      setStep('name');
                    }
                  }}
                  disabled={!selectedService || !agency.isQueueOpen || agency.isPaused}
                  className={`w-full min-h-[64px] rounded-2xl text-xl font-bold shadow-lg mt-6 flex items-center justify-center gap-3 transition-all ${
                    !selectedService || !agency.isQueueOpen || agency.isPaused
                      ? 'bg-gray-200 text-gray-400 cursor-not-allowed shadow-none'
                      : 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl'
                  }`}
                >
                  {t('next')}
                </motion.button>
              </div>
            </motion.div>
          )}

          {/* ─── Step 3: Enter Name (optional) ─── */}
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
              <div className="bg-white rounded-3xl shadow-2xl p-8 text-center">
                <div className="h-16 w-16 mx-auto rounded-2xl bg-emerald-100 flex items-center justify-center mb-4">
                  <Users className="h-8 w-8 text-emerald-600" />
                </div>

                <h2 className="text-2xl font-bold text-gray-900 mb-2">
                  {t('enterYourName')}
                </h2>

                {/* Selected service summary */}
                {services.find((s) => s.id === selectedService) && (
                  <div className="mb-6 mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200">
                    <p className="text-sm text-emerald-600 font-medium">
                      {services.find((s) => s.id === selectedService)?.prefix} — {getLocalizedName(services.find((s) => s.id === selectedService)!)}
                    </p>
                  </div>
                )}

                <input
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder={t('enterYourName')}
                  className="w-full min-h-[60px] rounded-2xl border-2 border-gray-200 px-5 text-lg focus:border-emerald-500 focus:outline-none transition-colors text-center"
                  autoFocus
                />

                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm font-medium"
                  >
                    {error}
                  </motion.div>
                )}

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleJoinQueue}
                  disabled={loading}
                  className="w-full min-h-[72px] rounded-2xl text-xl font-bold shadow-lg mt-6 flex items-center justify-center gap-3 bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {loading ? (
                    <Loader2 className="h-7 w-7 animate-spin" />
                  ) : (
                    <Ticket className="h-7 w-7" />
                  )}
                  {t('joinQueueKiosk')}
                </motion.button>

                <button
                  onClick={() => { setStep('services'); setError(null); }}
                  className="mt-4 min-h-[48px] px-6 rounded-xl text-gray-500 hover:text-gray-700 hover:bg-gray-100 font-medium transition-colors"
                >
                  {t('kioskBack')}
                </button>
              </div>
            </motion.div>
          )}

          {/* ─── Step 4: Ticket Display ─── */}
          {step === 'ticket' && ticket && agency && (
            <motion.div
              key="ticket"
              variants={pageVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="w-full max-w-md relative"
            >
              {/* Confetti animation */}
              <KioskConfetti active={showConfetti} />

              <div className="print-area">
                {/* Success icon */}
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
                  className="text-center mb-4"
                >
                  <CheckCircle className="h-16 w-16 text-emerald-300 mx-auto" />
                </motion.div>

                {/* Thank you */}
                <motion.p
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 }}
                  className="text-xl font-medium text-emerald-100 mb-4 text-center"
                >
                  {t('kioskThankYou')}
                </motion.p>

                {/* Ticket card - BIG with dramatic animation */}
                <motion.div
                  initial={{ scale: 0.3, opacity: 0, rotateY: -15 }}
                  animate={{ scale: 1, opacity: 1, rotateY: 0 }}
                  transition={{ type: 'spring', stiffness: 120, damping: 10, delay: 0.2 }}
                  className="bg-white rounded-3xl p-8 shadow-2xl mb-6 ticket-card relative overflow-hidden"
                >
                  {/* Decorative corner accents */}
                  <div className="absolute top-0 start-0 w-16 h-16">
                    <div className="absolute top-2 start-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
                    <div className="absolute top-2 start-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
                  </div>
                  <div className="absolute top-0 end-0 w-16 h-16">
                    <div className="absolute top-2 end-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
                    <div className="absolute top-2 end-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
                  </div>
                  <div className="absolute bottom-0 start-0 w-16 h-16">
                    <div className="absolute bottom-2 start-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
                    <div className="absolute bottom-2 start-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
                  </div>
                  <div className="absolute bottom-0 end-0 w-16 h-16">
                    <div className="absolute bottom-2 end-2 w-8 h-0.5 bg-emerald-400 rounded-full" />
                    <div className="absolute bottom-2 end-2 h-8 w-0.5 bg-emerald-400 rounded-full" />
                  </div>

                  <p className="text-sm font-semibold text-emerald-600 mb-3 uppercase tracking-widest text-center">
                    {t('yourTicketKiosk')}
                  </p>
                  <motion.p
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 200, damping: 12, delay: 0.5 }}
                    className="text-[80px] sm:text-[96px] leading-none font-black text-gray-900 text-center tracking-tight"
                  >
                    {ticket.ticketNumber}
                  </motion.p>

                  {/* Animated underline */}
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '60%' }}
                    transition={{ delay: 0.8, duration: 0.5, ease: 'easeOut' }}
                    className="h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-400 rounded-full mx-auto mt-3"
                  />

                  {/* Agency name */}
                  <p className="text-sm text-gray-500 mt-3 text-center">
                    {getLocalizedName(agency)}
                  </p>
                </motion.div>

                {/* Position & Wait - big numbers */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <motion.div
                    initial={{ opacity: 0, x: rtl ? 20 : -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.6 }}
                    className="bg-white/15 backdrop-blur-sm rounded-2xl p-5 text-center"
                  >
                    <Hash className="h-6 w-6 text-emerald-200 mx-auto mb-2" />
                    <p className="text-4xl font-bold text-white">{ticket.position}</p>
                    <p className="text-sm text-emerald-200">{t('positionInQueue')}</p>
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0, x: rtl ? -20 : 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.7 }}
                    className="bg-white/15 backdrop-blur-sm rounded-2xl p-5 text-center"
                  >
                    <Clock className="h-6 w-6 text-emerald-200 mx-auto mb-2" />
                    <p className="text-4xl font-bold text-white">{ticket.estimatedWaitMinutes}</p>
                    <p className="text-sm text-emerald-200">{t('minutesKiosk')}</p>
                  </motion.div>
                </div>

                {/* Currently Serving at each counter */}
                <CurrentlyServingDisplay />

                {/* Estimated Wait - dedicated display */}
                <div className="mt-4">
                  <EstimatedWaitDisplay />
                </div>
              </div>

              {/* Print error display */}
              {printError && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="w-full p-3 rounded-xl bg-red-500/20 text-red-200 text-sm text-center mb-2 print:hidden"
                >
                  <AlertTriangle className="h-4 w-4 inline mr-1" />
                  {printError}
                  <button
                    onClick={() => setPrintError(null)}
                    className="ml-2 text-red-300 hover:text-white"
                  >
                    ✕
                  </button>
                </motion.div>
              )}

              {/* Action buttons - hidden in print */}
              <div className="flex gap-3 print:hidden mt-4">
                <motion.button
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.9 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handlePrint}
                  className="flex-1 min-h-[60px] rounded-2xl bg-white/20 backdrop-blur-sm text-white font-semibold text-lg flex items-center justify-center gap-2 hover:bg-white/30 transition-colors"
                >
                  <Printer className="h-5 w-5" />
                  {t('printTicket')}
                </motion.button>
                <motion.button
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 1.0 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleReset}
                  className="flex-1 min-h-[60px] rounded-2xl bg-white/20 backdrop-blur-sm text-white font-semibold text-lg flex items-center justify-center gap-2 hover:bg-white/30 transition-colors"
                >
                  <RotateCcw className="h-5 w-5" />
                  {t('newTicket')}
                </motion.button>
              </div>

              {/* Inactivity countdown */}
              {inactivitySeconds > 30 && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-center text-emerald-200/60 text-xs mt-4 print:hidden"
                >
                  {60 - inactivitySeconds}s
                </motion.p>
              )}
            </motion.div>
          )}

          {/* ─── QR Scan Step ─── */}
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
                <KioskQrScanner
                  agencyId={agency?.id}
                  deviceId={`kiosk-${agency?.customCode || 'unknown'}`}
                  onClaimed={(result) => {
                    // After successful claim, show ticket
                    setTicket({
                      id: result.reservation.id,
                      ticketNumber: result.reservation.displayNumber,
                      position: 0,
                      estimatedWaitMinutes: 0,
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
