'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { isRTL } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PhoneCall,
  UserPlus,
  QrCode,
  Pause,
  Play,
  Shrink,
  Radio,
  Users,
  Clock,
  CheckCircle2,
  UserX,
  Loader2,
  Printer,
  Phone,
  Ticket,
  User,
  XCircle,
  Eye,
  Timer,
  History,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';

// ─── Types ────────────────────────────────────────────────────────────────

interface QueueEntry {
  id: string;
  queueNumber: string;
  customerName: string;
  customerPhone?: string | null;
  customerAvatar?: string | null;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  joinedAt: string;
  calledAt?: string | null;
  status: string;
  position: number;
  isWalkIn?: boolean;
  walkInCustomerName?: string;
  importToken?: string | null;
  service?: { name?: string; nameAr?: string; nameFr?: string };
  counterId?: string | null;
  counterName?: string | null;
}

interface DashboardStats {
  currentlyWaiting: number;
  servedToday: number;
  avgWaitTime: number;
  isPaused: boolean;
  currentQueueNumber: string;
}

interface ServiceOption {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
}

interface WalkInResult {
  id: string;
  queueNumber: string;
  displayNumber: string;
  customerName: string;
  serviceName: string;
  agencyName: string;
  joinedAt: string;
  importToken: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function getServiceName(entry: QueueEntry, lang: string) {
  if (lang === 'ar' && entry.serviceNameAr) return entry.serviceNameAr;
  if (lang === 'fr' && entry.serviceNameFr) return entry.serviceNameFr;
  return entry.serviceName;
}

function formatTime(dateStr: string, lang: string) {
  try {
    return new Date(dateStr).toLocaleTimeString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { hour: '2-digit', minute: '2-digit' }
    );
  } catch {
    return '';
  }
}

function formatDate(dateStr: string, lang: string) {
  try {
    return new Date(dateStr).toLocaleDateString(
      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
      { year: 'numeric', month: 'short', day: 'numeric' }
    );
  } catch {
    return '';
  }
}

function getInitials(name: string) {
  return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

// ─── QR Generation Helper ─────────────────────────────────────────────────

async function generateQRDataURL(data: string, options: { width?: number; darkColor?: string; lightColor?: string } = {}) {
  try {
    const mod = await import('qrcode');
    const QRCode = mod.default || mod;
    if (!QRCode || typeof QRCode.toDataURL !== 'function') {
      console.error('[QR] qrcode module loaded but toDataURL is not a function:', typeof QRCode);
      return null;
    }
    const url = await QRCode.toDataURL(data, {
      width: options.width || 200,
      margin: 1,
      color: { dark: options.darkColor || '#111827', light: options.lightColor || '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    return url;
  } catch (err) {
    console.error('[QR] Failed to generate QR code:', err);
    return null;
  }
}

// ─── Fullscreen API helper (cross-browser) ───────────────────────────────

function requestBrowserFullscreen() {
  try {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
      msRequestFullscreen?: () => Promise<void>;
    };
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    if (el.msRequestFullscreen) return el.msRequestFullscreen();
  } catch (e) {
    console.error('[Fullscreen] requestBrowserFullscreen error:', e);
  }
}

function exitBrowserFullscreen() {
  try {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void>;
      msExitFullscreen?: () => Promise<void>;
    };
    if (doc.exitFullscreen) {
      doc.exitFullscreen().catch(() => { /* ignore — document may not be active */ });
      return;
    }
    if (doc.webkitExitFullscreen) {
      doc.webkitExitFullscreen().catch(() => {});
      return;
    }
    if (doc.msExitFullscreen) {
      doc.msExitFullscreen().catch(() => {});
      return;
    }
  } catch {}
}

// ─── Customer Detail Card Sub-component ───────────────────────────────────

function CustomerDetails({ entry, lang, accent = 'emerald' }: {
  entry: QueueEntry;
  lang: string;
  accent?: 'emerald' | 'gray';
}) {
  const accentText = accent === 'emerald' ? 'text-emerald-200' : 'text-gray-300';
  const accentSub = accent === 'emerald' ? 'text-emerald-200/60' : 'text-gray-500';
  const accentBadge = accent === 'emerald'
    ? 'bg-emerald-400/20 text-emerald-100 border-emerald-400/30'
    : 'bg-gray-600/30 text-gray-300 border-gray-600/30';

  return (
    <div className="flex flex-col gap-1 text-start w-full min-w-0">
      <h2 className={`text-sm sm:text-base font-bold truncate ${accentText}`}>
        {entry.customerName}
      </h2>
      <div className="flex items-center gap-1.5">
        <Badge className={`${accentBadge} border text-[10px] px-1.5 py-0`}>
          {getServiceName(entry, lang)}
        </Badge>
        {entry.isWalkIn && (
          <Badge className="bg-amber-400/20 text-amber-100 border-amber-400/30 text-[9px] px-1 py-0">
            Walk-in
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Clock className={`h-3 w-3 flex-shrink-0 ${accentSub}`} />
        <span className={`text-[11px] ${accentSub}`}>
          {formatTime(entry.joinedAt, lang)} · {formatDate(entry.joinedAt, lang)}
        </span>
      </div>
      {entry.customerPhone && (
        <div className="flex items-center gap-1">
          <Phone className={`h-3 w-3 flex-shrink-0 ${accentSub}`} />
          <span className={`text-[11px] ${accentSub} ltr`}>{entry.customerPhone}</span>
        </div>
      )}
    </div>
  );
}

// ─── Avatar Component ──────────────────────────────────────────────────────

function CustomerAvatar({ entry, size = 'md' }: { entry: QueueEntry; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = { sm: 'h-8 w-8 text-xs', md: 'h-11 w-11 text-sm', lg: 'h-16 w-16 text-lg' };
  if (entry.customerAvatar) {
    return (
      <img
        src={entry.customerAvatar}
        alt={entry.customerName}
        className={`${sizeClasses[size]} rounded-full object-cover border-2 border-white/20 flex-shrink-0`}
      />
    );
  }
  return (
    <div className={`${sizeClasses[size]} rounded-full bg-white/10 border-2 border-white/20 flex items-center justify-center font-bold flex-shrink-0`}>
      {getInitials(entry.customerName)}
    </div>
  );
}

// ─── QR Show Button (replaces inline QR badge) ──────────────────────────────

function QRShowButton({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <Button
      onClick={onClick}
      variant="outline"
      size="sm"
      className="h-7 px-2 gap-1 rounded-lg border border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100 text-[10px] flex-shrink-0"
    >
      <QrCode className="h-3 w-3" />
      <span>{label || 'QR'}</span>
    </Button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────

export function AgencyFullscreen() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const dir = isRTL(lang) ? 'rtl' : 'ltr';
  const agencyId = user?.agencyId || '';
  const agencyName = user?.agencyName || user?.agencyNameAr || user?.agencyNameFr || 'BLASTI';

  const realtime = useRealtime();

  // State
  const queue = useState<QueueEntry[]>([])[0];
  const setQueue = useState<QueueEntry[]>()[1];
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [currentServing, setCurrentServing] = useState<QueueEntry | null>(null);
  const [nextInQueue, setNextInQueue] = useState<QueueEntry | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);

  // Live service duration counter
  const [serviceDurationSeconds, setServiceDurationSeconds] = useState(0);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Counter / Reception selection — for per-reception serving
  interface CounterOption { id: string; number: number; name: string; nameAr?: string | null; nameFr?: string | null; branchName: string }
  const [counters, setCounters] = useState<CounterOption[]>([]);
  const [selectedCounterId, setSelectedCounterId] = useState<string>('');

  // Fetch counters for this agency (all branches)
  const fetchCounters = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/branches?agencyId=${encodeURIComponent(agencyId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !data.branches) return;
      const allCounters: CounterOption[] = [];
      for (const branch of data.branches) {
        const cRes = await apiFetch(`/api/agency/branches/${branch.id}/counters`);
        if (!cRes.ok) continue;
        const cData = await cRes.json();
        if (!cData.success || !cData.counters) continue;
        for (const c of cData.counters) {
          if (!c.isActive) continue;
          allCounters.push({
            id: c.id,
            number: c.number,
            name: c.name,
            nameAr: c.nameAr,
            nameFr: c.nameFr,
            branchName: branch.name,
          });
        }
      }
      setCounters(allCounters);
      // Restore saved counter from localStorage
      const saved = localStorage.getItem(`blasti_counter_${agencyId}`);
      if (saved && allCounters.some(c => c.id === saved)) {
        setSelectedCounterId(saved);
      } else if (allCounters.length === 1) {
        setSelectedCounterId(allCounters[0].id);
      }
    } catch { /* ignore */ }
  }, [agencyId]);

  // Calculate live duration from currentServing's calledAt
  useEffect(() => {
    if (currentServing?.calledAt) {
      const calledTime = new Date(currentServing.calledAt).getTime();
      const updateDuration = () => {
        setServiceDurationSeconds(Math.floor((Date.now() - calledTime) / 1000));
      };
      updateDuration();
      durationTimerRef.current = setInterval(updateDuration, 1000);
      return () => {
        if (durationTimerRef.current) clearInterval(durationTimerRef.current);
      };
    } else {
      setServiceDurationSeconds(0);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    }
  }, [currentServing?.calledAt]);

  // Format seconds into Xm Ys
  const liveDurationDisplay = useMemo(() => {
    const mins = Math.floor(serviceDurationSeconds / 60);
    const secs = serviceDurationSeconds % 60;
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }, [serviceDurationSeconds]);

  // Fullscreen permission state
  const fullscreenReady = true;

  // Walk-in dialog
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  const [walkInServiceId, setWalkInServiceId] = useState('');
  const [walkInLoading, setWalkInLoading] = useState(false);
  const [walkInResult, setWalkInResult] = useState<WalkInResult | null>(null);

  // QR dialog (agency code)
  const [qrOpen, setQrOpen] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [agencyCode, setAgencyCode] = useState('');

  // Walk-in QR detail dialog (big QR + print)
  const [walkInQrOpen, setWalkInQrOpen] = useState(false);
  const [walkInQrUrl, setWalkInQrUrl] = useState<string | null>(null);
  const [walkInQrEntry, setWalkInQrEntry] = useState<QueueEntry | WalkInResult | null>(null);

  // Ticket print dialog
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketQrUrl, setTicketQrUrl] = useState('');
  const [ticketData, setTicketData] = useState<WalkInResult | null>(null);
  const ticketPrintRef = useRef<HTMLDivElement>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ─── Fetch Data ────────────────────────────────────────────────────────

  const fetchQueue = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/queue?agencyId=${encodeURIComponent(agencyId)}&status=WAITING,CALLED`);
      if (res.ok) {
        const data = await res.json();
        const entries: QueueEntry[] = data.entries ?? data.reservations ?? [];
        setQueueEntries(entries);
        setQueue(entries);
        const called = entries.find((e) => e.status === 'CALLED') || null;
        const waiting = entries.filter((e) => e.status === 'WAITING');
        setCurrentServing(called);
        setNextInQueue(waiting.length > 0 ? waiting[0] : null);
      }
    } catch (err) {
      console.error('[Fullscreen] fetchQueue error:', err);
    }
  }, [agencyId]);

  const fetchStats = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/stats?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
        setIsPaused(data.isPaused ?? false);
      }
    } catch (err) {
      console.error('[Fullscreen] fetchStats error:', err);
    }
  }, [agencyId]);

  const fetchServices = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/services?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        setServices(data.services ?? []);
      }
    } catch (err) {
      console.error('[Fullscreen] fetchServices error:', err);
    }
  }, [agencyId]);

  const fetchAll = useCallback(async () => {
    await Promise.all([fetchQueue(), fetchStats()]);
  }, [fetchQueue, fetchStats]);

  const fetchAllWithLoading = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchQueue(), fetchStats(), fetchServices(), fetchCounters()]);
    setLoading(false);
  }, [fetchQueue, fetchStats, fetchServices, fetchCounters]);

  // ─── Show QR Dialog for walk-in entry ──────────────────────────────────

  const openWalkInQrDialog = async (entry: QueueEntry | WalkInResult) => {
    if (!entry.importToken) {
      toast.error('No QR token available for this walk-in customer');
      return;
    }
    setWalkInQrEntry(entry);
    setWalkInQrOpen(true);
    setWalkInQrUrl(null); // loading state

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz';
    const url = await generateQRDataURL(`${baseUrl}/?claim=${entry.importToken}`, { width: 300 });
    setWalkInQrUrl(url);
  };

  // ─── Reprint ticket from a waiting list entry ───────────────────────────

  const handleReprintFromQueue = async (entry: QueueEntry) => {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz';
    const result: WalkInResult = {
      id: entry.id,
      queueNumber: entry.queueNumber,
      displayNumber: entry.queueNumber,
      customerName: entry.customerName,
      serviceName: getServiceName(entry, lang),
      agencyName,
      joinedAt: entry.joinedAt,
      importToken: entry.importToken || '',
    };

    setTicketData(result);

    if (entry.importToken) {
      const url = await generateQRDataURL(`${baseUrl}/?claim=${entry.importToken}`, { width: 200 });
      setTicketQrUrl(url || '');
    } else {
      setTicketQrUrl('');
    }

    setTicketOpen(true);
  };

  // ─── Effects ───────────────────────────────────────────────────────────

  // FIX #17: Offline-aware polling with backoff (was fixed 5s interval)
  useEffect(() => {
    fetchAllWithLoading();
    let failures = 0;
    const NORMAL = 5_000;
    let stopped = false;

    const getInterval = () => {
      if (failures >= 5) return 300_000;
      if (failures >= 3) return 120_000;
      if (failures >= 1) return 30_000; // Fullscreen needs faster recovery
      return NORMAL;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        pollingRef.current = setTimeout(tick, getInterval()) as any;
        return;
      }
      await fetchAll();
      if (isApiUnreachable()) {
        failures = Math.min(failures + 1, 10);
      } else {
        failures = 0;
      }
      pollingRef.current = setTimeout(tick, getInterval()) as any;
    };

    pollingRef.current = setTimeout(tick, NORMAL) as any;
    return () => { stopped = true; if (pollingRef.current) clearTimeout(pollingRef.current as any); };
  }, [fetchAll, fetchAllWithLoading]);

  // Handle browser exiting fullscreen (user presses Escape)
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && !walkInOpen && !qrOpen && !ticketOpen && !walkInQrOpen) {
        setView('agency-dashboard');
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [setView, walkInOpen, qrOpen, ticketOpen, walkInQrOpen]);

  // Realtime subscription
  useEffect(() => {
    if (!agencyId) return;
    realtime.joinAgency(agencyId);
    const unsubs = [
      realtime.onQueueCalled(() => fetchAll()),
      realtime.onQueueCompleted(() => fetchAll()),
      realtime.onQueueNoShow(() => fetchAll()),
      realtime.onQueueCancelled(() => fetchAll()),
      realtime.onQueueJoined(() => fetchAll()),
      realtime.onQueueWalkIn(() => fetchAll()),
      realtime.onQueuePaused(() => fetchStats()),
      realtime.onQueueResumed(() => fetchStats()),
      realtime.onQueueUpdated(() => fetchAll()),
      realtime.onReservationCreated(() => fetchAll()),
      realtime.onReservationUpdated(() => fetchAll()),
    ];
    return () => {
      unsubs.forEach((unsub) => unsub?.());
      realtime.leaveAgency(agencyId);
    };
  }, [agencyId, realtime, fetchAll, fetchStats]);

  // Fetch agency code for QR
  useEffect(() => {
    if (!agencyId) return;
    const fetchCode = async () => {
      try {
        const res = await apiFetch(`/api/agency/profile?agencyId=${encodeURIComponent(agencyId)}`);
        if (res.ok) { const data = await res.json(); setAgencyCode(data.code || ''); }
      } catch {}
    };
    fetchCode();
  }, [agencyId]);

  // Generate agency QR code
  useEffect(() => {
    if (!agencyCode) return;
    const genAgencyQR = async () => {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz';
      const url = await generateQRDataURL(`${baseUrl}/?code=${agencyCode}`, {
        width: 256,
        darkColor: '#10b981',
        lightColor: '#111827',
      });
      if (url) setQrCodeDataUrl(url);
    };
    genAgencyQR();
  }, [agencyCode]);

  // ─── Actions ─────────────────────────────────────────────────────────

  const handleCallNext = async () => {
    if (!agencyId) return;
    setActionLoading('call');
    try {
      const body: Record<string, string> = { agencyId };
      if (selectedCounterId) body.counterId = selectedCounterId;
      const res = await apiFetch('/api/agency/queue/call-next', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (selectedCounterId) localStorage.setItem(`blasti_counter_${agencyId}`, selectedCounterId);
        toast.success(t('statusCalled')); fetchAll();
      }
      else { const data = await res.json(); toast.error(data.details || data.error || t('noQueue')); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleComplete = async (reservationId: string) => {
    setActionLoading(`${reservationId}-complete`);
    try {
      const res = await apiFetch(`/api/agency/queue/${encodeURIComponent(reservationId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      });
      if (res.ok) { toast.success(t('statusCompleted') || 'Completed'); fetchAll(); }
      else { toast.error(t('error')); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleNoShow = async (reservationId: string) => {
    setActionLoading(`${reservationId}-noshow`);
    try {
      const res = await apiFetch(`/api/agency/queue/${encodeURIComponent(reservationId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'no_show' }),
      });
      if (res.ok) { toast.success(t('statusNoShow') || 'Marked as no-show'); fetchAll(); }
      else { toast.error(t('error')); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleCancel = async (reservationId: string) => {
    setActionLoading(`${reservationId}-cancel`);
    try {
      const res = await apiFetch(`/api/agency/queue/${encodeURIComponent(reservationId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      if (res.ok) { toast.success(t('statusCancelled') || 'Cancelled'); fetchAll(); }
      else { toast.error(t('error')); }
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleTogglePause = async () => {
    if (!agencyId) return;
    setActionLoading('pause');
    try {
      const res = await apiFetch('/api/agency/queue/toggle-pause', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId }),
      });
      if (res.ok) fetchStats();
      else toast.error(t('error'));
    } catch { toast.error(t('error')); }
    finally { setActionLoading(null); }
  };

  const handleWalkInSubmit = async () => {
    if (!agencyId || !walkInName.trim() || !walkInServiceId) return;
    setWalkInLoading(true);
    try {
      const res = await apiFetch('/api/agency/queue/walk-in', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId, customerName: walkInName.trim(), serviceId: walkInServiceId }),
      });
      if (res.ok) {
        const data = await res.json();
        const r = data.reservation;
        const result: WalkInResult = {
          id: r.id, queueNumber: r.queueNumber, displayNumber: r.displayNumber,
          customerName: walkInName.trim(),
          serviceName: r.service?.name || getServiceName(r, lang),
          agencyName: agencyName, joinedAt: r.joinedAt,
          importToken: r.importToken || data.importToken || '',
        };

        // Fallback: Generate import token if not returned from walk-in creation
        if (!result.importToken) {
          try {
            const tokenRes = await apiFetch('/api/agency/queue/walk-in-token', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reservationId: r.id }),
            });
            if (tokenRes.ok) {
              const tokenData = await tokenRes.json();
              result.importToken = tokenData.token || '';
            }
          } catch {}
        }

        setWalkInResult(result);
        toast.success(t('walkInAdded'));
        fetchAll();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch { toast.error(t('error')); }
    finally { setWalkInLoading(false); }
  };

  const handlePrintTicket = async (result: WalkInResult) => {
    setTicketData(result);

    // Generate QR for the ticket
    if (result.importToken) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz';
      const url = await generateQRDataURL(`${baseUrl}/?claim=${result.importToken}`, { width: 200 });
      setTicketQrUrl(url || '');
    } else {
      setTicketQrUrl('');
    }
    setTicketOpen(true);
  };

  const executePrint = () => {
    if (ticketPrintRef.current) {
      const printContent = ticketPrintRef.current.innerHTML;
      const win = window.open('', '_blank', 'width=400,height=600');
      if (win) {
        win.document.write(`
          <html><head><title>Ticket</title>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: 'Courier New', monospace; width: 80mm; padding: 4mm; }
            .center { text-align: center; }
            .bold { font-weight: bold; }
            .large { font-size: 28px; font-weight: bold; }
            .medium { font-size: 14px; }
            .small { font-size: 11px; }
            hr { border: none; border-top: 1px dashed #333; margin: 6px 0; }
            .qr { text-align: center; margin: 8px 0; }
            .qr img { width: 180px; height: 180px; }
          </style></head><body>
          ${printContent}
          <script>window.onload=function(){window.print();window.close();}</script>
          </body></html>
        `);
        win.document.close();
      }
    }
  };

  const handleExitFullscreen = () => {
    exitBrowserFullscreen();
    setView('agency-dashboard');
  };

  const closeWalkInDialog = () => {
    setWalkInOpen(false);
    setWalkInName('');
    setWalkInPhone('');
    setWalkInServiceId('');
    setWalkInResult(null);
  };

  // Waiting list (excluding the called entry)
  const waitingList = queueEntries.filter((e) => e.status === 'WAITING');

  // ─── Loading State ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-screen w-screen bg-gray-950 text-white flex items-center justify-center overflow-hidden" dir={dir}>
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
          <p className="text-gray-400 text-sm">{t('loading') || 'Loading queue...'}</p>
        </div>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="h-screen w-screen bg-gray-950 text-white flex flex-col overflow-hidden" dir={dir}>
      {/* ─── Top Bar (compact) ─────────────────────────────────────────── */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 sm:px-6 py-2 bg-gray-900/80 border-b border-gray-800 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-emerald-600 flex items-center justify-center">
              <Radio className="h-3.5 w-3.5 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white leading-tight">{agencyName}</h1>
              <p className="text-[10px] text-gray-500 leading-tight">{t('queueManagement') || 'Queue Management'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Counter / Reception Selector */}
          {counters.length > 0 && (
            <Select value={selectedCounterId} onValueChange={(v) => setSelectedCounterId(v)}>
              <SelectTrigger className="h-7 px-2 bg-gray-800 border-gray-700 text-[11px] text-gray-300 rounded-lg gap-1 min-w-[120px] max-w-[180px]">
                <SelectValue placeholder={t('selectCounter') || 'Select Counter'} />
              </SelectTrigger>
              <SelectContent className="bg-gray-900 border-gray-700">
                {counters.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs text-gray-300">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-emerald-400">#{c.number}</span>
                      <span>{lang === 'ar' ? (c.nameAr || c.name) : lang === 'fr' ? (c.nameFr || c.name) : c.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-1.5">
            <motion.div
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              className={`h-2 w-2 rounded-full ${realtime.isConnected ? 'bg-emerald-400' : 'bg-amber-400'}`}
            />
            <span className="text-[10px] text-gray-400 hidden sm:inline">
              {realtime.isConnected ? (t('live') || 'Live') : (t('polling') || 'Polling')}
            </span>
          </div>
          <Badge className="bg-gray-800 text-gray-300 border-gray-700 text-[10px] px-1.5">
            {waitingList.length} {t('waitingLabel') || 'waiting'}
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => setView('agency-fullscreen-history')}
            className="h-7 px-2 gap-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-[11px]">
            <History className="h-3 w-3" />
            <span className="hidden sm:inline">{t('history') || 'History'}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExitFullscreen}
            className="h-7 px-2 gap-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg text-[11px]">
            <Shrink className="h-3 w-3" />
            <span className="hidden sm:inline">{t('exitFullscreen') || 'Exit'}</span>
          </Button>
        </div>
      </header>

      {/* ─── Main Content Area ──────────────────────────────────────────── */}
      <main className="flex-1 min-h-0 p-3 sm:p-4 lg:p-6 flex flex-col gap-3 sm:gap-4">
        {/* ─── Top Row: Now Serving + Next In Queue ──────────────────────── */}
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">

          {/* ────── NOW SERVING CARD ────── */}
          <Card className="bg-gray-900 border-gray-800 overflow-hidden flex flex-col">
            <div className="bg-gradient-to-br from-emerald-600 via-teal-600 to-emerald-700 flex-1 flex flex-col p-4 sm:p-5 relative overflow-hidden">
              {/* Decorative */}
              <div className="absolute top-0 end-0 h-24 w-24 rounded-full bg-white/5 -translate-y-8 translate-x-8" />
              <div className="absolute bottom-0 start-0 h-16 w-16 rounded-full bg-white/5 translate-y-6 -translate-x-6" />

              <div className="relative flex-1 min-h-0 flex flex-col">
                {/* Label */}
                <div className="flex items-center gap-2 mb-2 flex-shrink-0">
                  <Radio className="h-3.5 w-3.5 text-emerald-200" />
                  <p className="text-emerald-100 text-[11px] sm:text-xs font-semibold uppercase tracking-wide">
                    {t('nowServing') || 'Now Serving'}
                  </p>
                  {isPaused && (
                    <Badge className="bg-amber-400/30 text-amber-100 border-amber-400/30 text-[9px]">
                      {t('queuePausedLabel') || 'Paused'}
                    </Badge>
                  )}
                </div>

                {currentServing ? (
                  <div className="flex-1 min-h-0 flex items-center gap-3 sm:gap-5">
                    {/* LEFT: Queue Number Circle */}
                    <div className="relative flex-shrink-0">
                      {!isPaused && (
                        <motion.div
                          className="absolute -inset-2 rounded-full"
                          animate={{
                            boxShadow: [
                              '0 0 0 0 rgba(110, 231, 183, 0.5)',
                              '0 0 0 16px rgba(110, 231, 183, 0)',
                              '0 0 0 0 rgba(110, 231, 183, 0)',
                            ],
                          }}
                          transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                        />
                      )}
                      <motion.div
                        key={currentServing.queueNumber}
                        initial={{ scale: 0.7, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                        className="h-24 w-24 sm:h-32 sm:w-32 lg:h-40 lg:w-40 rounded-full bg-white/10 backdrop-blur-sm border-2 border-white/20 flex items-center justify-center"
                      >
                        <span className="text-3xl sm:text-4xl lg:text-5xl font-black text-white tracking-tight whitespace-nowrap">
                          {currentServing.queueNumber}
                        </span>
                      </motion.div>
                    </div>

                    {/* RIGHT: Customer Details */}
                    <div className="flex-1 min-h-0 flex flex-col items-center lg:items-start justify-center gap-2">
                      <div className="flex items-center gap-2 sm:gap-3 w-full">
                        <CustomerAvatar entry={currentServing} size="md" />
                        <CustomerDetails entry={currentServing} lang={lang} accent="emerald" />
                        {currentServing.isWalkIn && currentServing.importToken && (
                          <QRShowButton onClick={() => openWalkInQrDialog(currentServing)} />
                        )}
                      </div>

                      {/* Live Service Duration Counter */}
                      <motion.div
                        className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm border border-white/20"
                        animate={{ opacity: [0.7, 1, 0.7] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      >
                        <Timer className="h-3.5 w-3.5 text-emerald-200" />
                        <span className="text-emerald-100 text-xs font-bold tabular-nums">{liveDurationDisplay}</span>
                        <span className="text-emerald-200/60 text-[10px]">{t('serviceDuration') || 'Service Time'}</span>
                      </motion.div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 mt-1 w-full justify-center lg:justify-start">
                        <Button onClick={() => handleComplete(currentServing.id)} disabled={!!actionLoading}
                          className="h-8 px-3 rounded-xl bg-emerald-400 hover:bg-emerald-300 text-emerald-900 font-bold text-[11px] sm:text-xs gap-1 shadow-lg shadow-emerald-500/30">
                          {actionLoading === `${currentServing.id}-complete` ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                          {t('completeService') || 'Complete'}
                        </Button>
                        <Button onClick={() => handleNoShow(currentServing.id)} disabled={!!actionLoading} variant="outline"
                          className="h-8 px-3 rounded-xl border-2 border-amber-400/50 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 text-[11px] sm:text-xs gap-1">
                          {actionLoading === `${currentServing.id}-noshow` ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />}
                          {t('markNoShow') || 'No Show'}
                        </Button>
                        <Button onClick={() => handleCancel(currentServing.id)} disabled={!!actionLoading} variant="outline"
                          className="h-8 px-3 rounded-xl border-2 border-rose-400/50 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20 text-[11px] sm:text-xs gap-1">
                          {actionLoading === `${currentServing.id}-cancel` ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                          {t('cancelReservation') || 'Cancel'}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center gap-3">
                    <div className="h-24 w-24 sm:h-32 sm:w-32 lg:h-40 lg:w-40 rounded-full bg-white/5 border-2 border-dashed border-white/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-3xl sm:text-4xl font-black text-white/30">—</span>
                    </div>
                    <p className="text-white/60 text-xs sm:text-sm">{t('noCustomerBeingServed') || 'No customer being served'}</p>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* ────── NEXT IN QUEUE CARD ────── */}
          <Card className="bg-gray-900 border-gray-800 overflow-hidden flex flex-col">
            <div className="bg-gradient-to-br from-gray-800 to-gray-900 flex-1 flex flex-col p-4 sm:p-5 relative overflow-hidden">
              <div className="absolute top-0 start-0 h-20 w-20 rounded-full bg-emerald-500/5 -translate-y-6 -translate-x-6" />

              <div className="relative flex-1 min-h-0 flex flex-col">
                {/* Label */}
                <div className="flex items-center gap-2 mb-2 flex-shrink-0">
                  <Users className="h-3.5 w-3.5 text-emerald-400" />
                  <p className="text-emerald-400 text-[11px] sm:text-xs font-semibold uppercase tracking-wide">
                    {t('nextInQueue') || 'Next In Queue'}
                  </p>
                </div>

                {nextInQueue ? (
                  <div className="flex-1 min-h-0 flex items-center gap-3 sm:gap-5">
                    {/* LEFT: Queue Number Circle */}
                    <motion.div
                      key={nextInQueue.queueNumber}
                      initial={{ scale: 0.7, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                      className="h-20 w-20 sm:h-28 sm:w-28 lg:h-36 lg:w-36 rounded-full bg-gray-800 border-2 border-emerald-500/30 flex items-center justify-center flex-shrink-0"
                    >
                      <span className="text-2xl sm:text-3xl lg:text-4xl font-black text-emerald-400 whitespace-nowrap">
                        {nextInQueue.queueNumber}
                      </span>
                    </motion.div>

                    {/* RIGHT: Customer Details */}
                    <div className="flex-1 min-h-0 flex flex-col items-center lg:items-start justify-center gap-2">
                      <div className="flex items-center gap-2 sm:gap-3 w-full">
                        <CustomerAvatar entry={nextInQueue} size="md" />
                        <CustomerDetails entry={nextInQueue} lang={lang} accent="gray" />
                        {nextInQueue.isWalkIn && nextInQueue.importToken && (
                          <QRShowButton onClick={() => openWalkInQrDialog(nextInQueue)} />
                        )}
                      </div>
                      <div className="flex items-center gap-2 w-full justify-center lg:justify-start">
                        <Badge className="bg-gray-700 text-gray-300 border-gray-600 text-[10px] px-1.5 py-0">
                          #{nextInQueue.position} {t('position')}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center gap-3">
                    <div className="h-20 w-20 sm:h-28 sm:w-28 lg:h-36 lg:w-36 rounded-full bg-gray-800 border-2 border-dashed border-gray-700 flex items-center justify-center flex-shrink-0">
                      <span className="text-2xl sm:text-3xl font-black text-gray-700">—</span>
                    </div>
                    <p className="text-gray-600 text-xs sm:text-sm">
                      {waitingList.length === 0 ? (t('noQueue') || 'No queue') : (t('noNext') || 'No next ticket')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>

        {/* ─── Action Buttons Row ────────────────────────────────────────── */}
        <div className="flex-shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={handleCallNext} disabled={actionLoading === 'call' || isPaused}
              className="w-full h-12 sm:h-14 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white font-bold shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 disabled:opacity-50">
              {actionLoading === 'call' ? <Loader2 className="h-5 w-5 animate-spin" /> : <PhoneCall className="h-5 w-5" />}
              <span className="text-xs sm:text-sm">{t('callNext') || 'Call Next'}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={() => setWalkInOpen(true)}
              className="w-full h-12 sm:h-14 rounded-xl bg-gradient-to-br from-rose-500 to-rose-700 hover:from-rose-600 hover:to-rose-800 text-white font-bold shadow-lg shadow-rose-500/20 flex items-center justify-center gap-2">
              <UserPlus className="h-5 w-5" />
              <span className="text-xs sm:text-sm">{t('addWalkInCustomer') || 'Add Manual'}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={() => setQrOpen(true)}
              className="w-full h-12 sm:h-14 rounded-xl bg-gradient-to-br from-teal-500 to-teal-700 hover:from-teal-600 hover:to-teal-800 text-white font-bold shadow-lg shadow-teal-500/20 flex items-center justify-center gap-2">
              <QrCode className="h-5 w-5" />
              <span className="text-xs sm:text-sm">{t('viewQrCode') || 'QR Code'}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={handleTogglePause} disabled={actionLoading === 'pause'}
              className={`w-full h-12 sm:h-14 rounded-xl font-bold shadow-lg flex items-center justify-center gap-2 ${
                isPaused
                  ? 'bg-gradient-to-br from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white shadow-emerald-500/20'
                  : 'bg-gradient-to-br from-amber-500 to-amber-700 hover:from-amber-600 hover:to-amber-800 text-white shadow-amber-500/20'
              }`}>
              {actionLoading === 'pause' ? <Loader2 className="h-5 w-5 animate-spin" /> : isPaused ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
              <span className="text-xs sm:text-sm">{isPaused ? (t('resumeQueue') || 'Resume') : (t('pauseQueue') || 'Pause Queue')}</span>
            </Button>
          </motion.div>
        </div>

        {/* ─── Waiting List ──────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex flex-col">
          <Card className="bg-gray-900 border-gray-800 flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-shrink-0 flex items-center justify-between px-3 sm:px-4 py-2 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <Users className="h-3.5 w-3.5 text-emerald-400" />
                <h3 className="text-xs font-bold text-white">{t('waitingList') || 'Waiting List'}</h3>
                <Badge className="bg-gray-800 text-gray-300 border-gray-700 text-[10px] px-1.5">{waitingList.length}</Badge>
              </div>
              {isPaused && (
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] flex items-center gap-1 px-1.5">
                  <Pause className="h-2.5 w-2.5" />{t('queuePausedLabel') || 'Paused'}
                </Badge>
              )}
            </div>
            {waitingList.length > 0 ? (
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800/80 sticky top-0">
                    <tr>
                      <th className="text-start px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">#</th>
                      <th className="text-start px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{t('name') || 'Name'}</th>
                      <th className="text-start px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider hidden sm:table-cell">{t('service') || 'Service'}</th>
                      <th className="text-start px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{t('time') || 'Time'}</th>
                      <th className="text-center px-2 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{t('actions') || 'Actions'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    <AnimatePresence>
                      {waitingList.map((entry, index) => (
                        <motion.tr key={entry.id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 10 }} transition={{ delay: index * 0.03 }}
                          className="hover:bg-gray-800/50 transition-colors">
                          <td className="px-3 py-2">
                            <span className="font-mono font-bold text-emerald-400 text-xs">{entry.queueNumber}</span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <CustomerAvatar entry={entry} size="sm" />
                              <span className="text-white text-xs">{entry.customerName}</span>
                              {entry.isWalkIn && <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[8px] px-1 py-0">W</Badge>}
                            </div>
                          </td>
                          <td className="px-3 py-2 hidden sm:table-cell">
                            <span className="text-gray-400 text-[11px]">{getServiceName(entry, lang)}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="text-gray-500 text-[11px]">{formatTime(entry.joinedAt, lang)}</span>
                          </td>
                          <td className="px-2 py-2 text-center">
                            <div className="flex items-center justify-center gap-0.5">
                              <Button onClick={() => handleComplete(entry.id)} disabled={!!actionLoading} variant="ghost" size="icon"
                                className="h-6 w-6 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10">
                                {actionLoading === `${entry.id}-complete` ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                              </Button>
                              <Button onClick={() => handleNoShow(entry.id)} disabled={!!actionLoading} variant="ghost" size="icon"
                                className="h-6 w-6 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10">
                                {actionLoading === `${entry.id}-noshow` ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />}
                              </Button>
                              <Button onClick={() => handleCancel(entry.id)} disabled={!!actionLoading} variant="ghost" size="icon"
                                className="h-6 w-6 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10">
                                {actionLoading === `${entry.id}-cancel` ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                              </Button>
                              {entry.isWalkIn && entry.importToken && (
                                <Button onClick={() => openWalkInQrDialog(entry)} variant="ghost" size="icon"
                                  className="h-6 w-6 text-amber-300 hover:text-amber-200 hover:bg-amber-500/10" title="Show QR">
                                  <Eye className="h-3 w-3" />
                                </Button>
                              )}
                              {entry.isWalkIn && (
                                <Button onClick={() => handleReprintFromQueue(entry)} variant="ghost" size="icon"
                                  className="h-6 w-6 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10" title={t('reprintTicket') || 'Reprint Ticket'}>
                                  <Printer className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      ))}
                    </AnimatePresence>
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-center">
                  <Users className="h-8 w-8 text-gray-700" />
                  <p className="text-gray-600 text-xs">{t('noQueue') || 'No customers in queue'}</p>
                </div>
              </div>
            )}
          </Card>
        </div>
      </main>

      {/* ─── Walk-in Dialog ─────────────────────────────────────────────── */}
      <Dialog open={walkInOpen} onOpenChange={(v) => { if (!v) closeWalkInDialog(); else setWalkInOpen(true); }}>
        <DialogContent className="bg-gray-900 border-gray-800 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-emerald-400" />
              {t('addWalkInCustomer') || 'Add Walk-in Customer'}
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              {t('walkInDescription') || 'Add a customer who walked in without a reservation.'}
            </DialogDescription>
          </DialogHeader>

          {!walkInResult ? (
            <>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label className="text-gray-300 text-sm">{t('customerName') || 'Customer Name'}</Label>
                  <Input value={walkInName} onChange={(e) => setWalkInName(e.target.value)}
                    placeholder={t('enterCustomerName') || 'Enter customer name'}
                    className="bg-gray-800 border-gray-700 text-white placeholder:text-gray-600" autoFocus />
                </div>
                <div className="space-y-2">
                  <Label className="text-gray-300 text-sm">{t('phoneNumber') || 'Phone Number'}</Label>
                  <Input value={walkInPhone} onChange={(e) => setWalkInPhone(e.target.value)}
                    placeholder="0X XX XX XX XX" type="tel"
                    className="bg-gray-800 border-gray-700 text-white placeholder:text-gray-600" dir="ltr" />
                </div>
                <div className="space-y-2">
                  <Label className="text-gray-300 text-sm">{t('service') || 'Service'}</Label>
                  <select value={walkInServiceId} onChange={(e) => setWalkInServiceId(e.target.value)}
                    className="w-full h-10 rounded-lg bg-gray-800 border border-gray-700 text-white text-sm px-3 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
                    <option value="">{t('selectService') || 'Select service'}</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {lang === 'ar' && s.nameAr ? s.nameAr : lang === 'fr' && s.nameFr ? s.nameFr : s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={closeWalkInDialog} className="text-gray-400 hover:text-white">
                  {t('cancel') || 'Cancel'}
                </Button>
                <Button onClick={handleWalkInSubmit} disabled={walkInLoading || !walkInName.trim() || !walkInServiceId}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">
                  {walkInLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                  {t('add')}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <div className="py-4 space-y-4">
                {/* Success animation */}
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  className="flex flex-col items-center gap-3">
                  <div className="h-16 w-16 rounded-full bg-emerald-500/20 border-2 border-emerald-500 flex items-center justify-center">
                    <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-white font-bold text-sm">{t('walkInAdded')}</p>
                    <p className="text-emerald-400 text-2xl font-black mt-1">{walkInResult.displayNumber}</p>
                    <p className="text-gray-400 text-xs mt-0.5">{walkInResult.customerName}</p>
                  </div>
                </motion.div>

                <div className="flex gap-2">
                  <Button onClick={() => handlePrintTicket(walkInResult)}
                    className="flex-1 h-11 rounded-xl bg-gray-800 hover:bg-gray-700 text-white font-semibold gap-2 border border-gray-700">
                    <Printer className="h-4 w-4" />
                    {t('printTicket') || 'Print Ticket'}
                  </Button>
                  {walkInResult.importToken && (
                    <Button onClick={() => {
                      closeWalkInDialog();
                      openWalkInQrDialog(walkInResult);
                    }}
                      className="flex-1 h-11 rounded-xl bg-gray-800 hover:bg-gray-700 text-white font-semibold gap-2 border border-gray-700">
                      <QrCode className="h-4 w-4" />
                      {t('showQR') || 'Show QR'}
                    </Button>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={closeWalkInDialog} className="text-gray-400 hover:text-white">
                  {t('close') || 'Close'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── Walk-in QR Detail Dialog (Big QR + Print) ──────────────────── */}
      <Dialog open={walkInQrOpen} onOpenChange={setWalkInQrOpen}>
        <DialogContent className="bg-gray-900 border-gray-800 text-white sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-emerald-400" />
              {t('walkInQR') || 'Walk-in QR Code'}
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              {t('walkInQRDescription') || 'Customer can scan this QR to link it to their account and track their queue.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {walkInQrEntry && (
              <div className="text-center">
                <p className="text-white font-bold text-sm">{walkInQrEntry.customerName}</p>
                <p className="text-emerald-400 text-2xl font-black">{walkInQrEntry.queueNumber}</p>
              </div>
            )}
            {walkInQrUrl ? (
              <div className="rounded-2xl bg-white p-4 shadow-lg">
                <img src={walkInQrUrl} alt="QR Code" className="w-56 h-56 sm:w-64 sm:h-64" />
              </div>
            ) : (
              <div className="w-56 h-56 rounded-2xl bg-gray-800 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
              </div>
            )}
            <div className="flex gap-2 w-full">
              <Button onClick={() => {
                if (walkInQrEntry) {
                  setWalkInQrOpen(false);
                  handleReprintFromQueue(walkInQrEntry as QueueEntry);
                }
              }}
                className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2">
                <Printer className="h-4 w-4" />
                {t('reprintTicket') || 'Reprint Ticket'}
              </Button>
              <Button onClick={() => setWalkInQrOpen(false)} variant="outline"
                className="flex-1 h-10 rounded-xl border-gray-700 text-gray-300 hover:bg-gray-800">
                {t('close') || 'Close'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Ticket Print Dialog ────────────────────────────────────────── */}
      <Dialog open={ticketOpen} onOpenChange={setTicketOpen}>
        <DialogContent className="bg-gray-900 border-gray-800 text-white sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ticket className="h-5 w-5 text-emerald-400" />
              {t('printTicket') || 'Print Ticket'}
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              {t('ticketDescription') || 'Print this ticket for the customer to scan and track their queue.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {/* Print area (hidden on screen, used for window.print()) */}
            <div ref={ticketPrintRef} className="hidden">
              {ticketData && (
                <div className="ticket-print-content">
                  <div className="center bold large">{ticketData.agencyName}</div>
                  <hr />
                  <div className="center medium" style={{ marginTop: '4px' }}>
                    <span className="bold" style={{ fontSize: '32px' }}>{ticketData.displayNumber}</span>
                  </div>
                  <hr />
                  <div className="small" style={{ marginTop: '4px' }}>
                    <div className="bold">{ticketData.customerName}</div>
                    <div>{ticketData.serviceName}</div>
                    <div>{new Date(ticketData.joinedAt).toLocaleString()}</div>
                  </div>
                  <hr />
                  {ticketQrUrl && (
                    <div className="qr">
                      <img src={ticketQrUrl} alt="QR" />
                    </div>
                  )}
                  <div className="center small" style={{ marginTop: '4px' }}>
                    Scan QR to track your queue
                  </div>
                  <hr />
                </div>
              )}
            </div>

            {/* Visual preview */}
            {ticketData && (
              <div className="bg-white rounded-2xl p-5 text-gray-900 w-full max-w-[280px] text-center space-y-3">
                <p className="font-bold text-sm">{ticketData.agencyName}</p>
                <hr className="border-dashed border-gray-300" />
                <p className="text-3xl font-black text-gray-900">{ticketData.displayNumber}</p>
                <hr className="border-dashed border-gray-300" />
                <div className="text-sm space-y-0.5">
                  <p className="font-bold">{ticketData.customerName}</p>
                  <p className="text-gray-600">{ticketData.serviceName}</p>
                  <p className="text-gray-500 text-xs">{new Date(ticketData.joinedAt).toLocaleString()}</p>
                </div>
                <hr className="border-dashed border-gray-300" />
                {ticketQrUrl ? (
                  <img src={ticketQrUrl} alt="QR" className="w-36 h-36 mx-auto" />
                ) : (
                  <div className="w-36 h-36 mx-auto bg-gray-200 rounded-lg flex items-center justify-center">
                    <span className="text-gray-400 text-xs">No QR</span>
                  </div>
                )}
                <p className="text-[10px] text-gray-500">{t('scanToTrackQueue') || 'Scan QR to track your queue'}</p>
              </div>
            )}

            <Button onClick={executePrint}
              className="w-full h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold gap-2">
              <Printer className="h-4 w-4" />
              {t('print')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── QR Code Dialog (Agency) ───────────────────────────────────── */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="bg-gray-900 border-gray-800 text-white sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-emerald-400" />
              {t('viewQrCode') || 'Agency QR Code'}
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              {t('scanToJoin') || 'Customers can scan this QR code to join the queue.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {qrCodeDataUrl ? (
              <div className="rounded-2xl bg-white p-4"><img src={qrCodeDataUrl} alt="QR Code" className="w-48 h-48" /></div>
            ) : (
              <div className="w-48 h-48 rounded-2xl bg-gray-800 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
              </div>
            )}
            <div className="text-center">
              <p className="text-white font-bold">{agencyName}</p>
              {agencyCode && <p className="text-gray-400 text-sm mt-1">{t('agencyCode') || 'Code'}: <span className="font-mono text-emerald-400">{agencyCode}</span></p>}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
