'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useIsMobile } from '@/hooks/use-mobile';
import { SimpleMobileDashboard } from './dashboard/SimpleMobileDashboard';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Users,
  Clock,
  CheckCircle2,
  Play,
  Pause,
  PhoneCall,
  UserCheck,
  UserX,
  XCircle,
  RefreshCw,
  Loader2,
  Radio,
  Layers,
  Activity,
  UserPlus,
  Volume2,
  CircleCheckBig,
  Ban,
  Rss,
  CheckSquare,
  Square,
  X,
  Megaphone,
  Download,
  Plus,
  Trash2,
  Star,
  AlertTriangle,
  ChevronDown,
  BarChart3,
  QrCode,
  Zap,
  Eye,
  Lock,
  AlertCircle,
  Building2,
  Maximize,
} from 'lucide-react';
import { motion, useInView, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useRef } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { WaitTimeChart } from '@/components/agency/wait-time-chart';
import { RatingDistribution } from '@/components/agency/rating-distribution';
import { NoShowAnalytics } from '@/components/agency/no-show-analytics';
import { PeakHoursAnalytics } from '@/components/agency/peak-hours-analytics';
import QRCode from 'qrcode';
import { useRealtime } from '@/hooks/use-realtime';
import { CounterManagement } from '@/components/agency/dashboard/counter-management';
import { QueueTimeline } from '@/components/agency/dashboard/queue-timeline';
import { OfflineIndicator } from '@/components/agency/dashboard/offline-indicator';
import { ETABadge } from '@/components/agency/dashboard/eta-badge';
import { TicketConfirmation } from '@/components/agency/dashboard/ticket-confirmation';
import { CreateAgencyForm } from '@/components/agency/create-agency-form';
import { apiFetch } from '@/lib/api-fetch';
import { isBothUnreachable } from '@/lib/api-client';

interface QueueEntry {
  id: string;
  queueNumber: string;
  customerName: string;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  joinedAt: string;
  status: string;
  position: number;
  isWalkIn?: boolean;
  walkInCustomerName?: string;
  preferredTime?: string;
  fixedTimeEnabled?: boolean;
  postponeCount?: number;
}

interface DashboardStats {
  todayReservations: number;
  currentlyWaiting: number;
  servedToday: number;
  avgWaitTime: number;
  currentQueueNumber: string;
  isPaused: boolean;
  noShowCount?: number;
  cancelledCount?: number;
  peakHour?: string;
  avgRating?: number;
  totalRatings?: number;
  noShowRate?: number;
  hourlyWaitTime?: number[];
  ratingDistribution?: number[];
  subscriptionStatus?: string;
  activeCounters?: number;
  walkInCount?: number;
  onlineReservationCount?: number;
  estimatedWaitRange?: { min: number; max: number; confidence: string };
}

interface ServiceStat {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  waitingCount: number;
  completedCount: number;
  _count?: { waiting: number; completed: number };
}

// ─── Animated Number Counter ───────────────────
function AnimatedCounter({ value, duration = 800 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0);
  const prevValue = useRef(0);

  useEffect(() => {
    const start = prevValue.current;
    const end = value;
    if (start === end) return;

    const startTime = performance.now();
    let rafId: number;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(start + (end - start) * eased));
      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      } else {
        prevValue.current = end;
      }
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [value, duration]);

  return <>{display}</>;
}

// ─── Mini Sparkline ─────────────────────────────
function MiniSparkline({ data, color = 'bg-emerald-400' }: { data: number[]; color?: string }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {data.map((val, i) => (
        <motion.div
          key={i}
          initial={{ height: 0 }}
          animate={{ height: `${(val / max) * 100}%` }}
          transition={{ duration: 0.4, delay: i * 0.05 }}
          className={`flex-1 rounded-sm ${color} min-h-[2px]`}
        />
      ))}
    </div>
  );
}

// ─── Activity Event ─────────────────────────────
interface ActivityEvent {
  id: string;
  eventType: string;
  eventKey: string;
  customerName: string;
  queueNumber: string;
  timestamp: string;
  serviceName?: string;
}

function getEventConfig(eventType: string) {
  switch (eventType) {
    case 'joined':
      return { icon: UserPlus, color: 'bg-emerald-500', dotColor: 'bg-emerald-500', badgeClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400', label: 'Joined' };
    case 'called':
      return { icon: Volume2, color: 'bg-sky-500', dotColor: 'bg-sky-500', badgeClass: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400', label: 'Called' };
    case 'completed':
      return { icon: CircleCheckBig, color: 'bg-gray-400', dotColor: 'bg-gray-400', badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', label: 'Done' };
    case 'cancelled':
      return { icon: Ban, color: 'bg-red-500', dotColor: 'bg-red-500', badgeClass: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', label: 'Cancelled' };
    default:
      return { icon: Activity, color: 'bg-gray-400', dotColor: 'bg-gray-400', badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', label: 'Action' };
  }
}

// ─── Circular Progress ──────────────────────────
function CircularProgress({ value, size = 80, strokeWidth = 6 }: { value: number; size?: number; strokeWidth?: number }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value / 100) * circumference;
  const color = value > 80 ? '#10b981' : value > 50 ? '#f59e0b' : '#ef4444';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-gray-200 dark:text-gray-700"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-lg font-bold text-foreground">{Math.round(value)}%</span>
      </div>
    </div>
  );
}

// ─── User Initials Avatar ───────────────────────
function UserAvatar({ name, colorClass }: { name: string; colorClass: string }) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className={`h-7 w-7 rounded-full ${colorClass} flex items-center justify-center flex-shrink-0`}>
      <span className="text-[10px] font-bold text-white">{initials || '?'}</span>
    </div>
  );
}

// ─── Section Header (unified section title) ────
function SectionHeader({ icon: Icon, title, count, action }: { icon: any; title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
          <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        </div>
        <h2 className="text-base font-bold text-foreground">{title}</h2>
        {count !== undefined && (
          <Badge variant="secondary" className="text-xs">{count}</Badge>
        )}
      </div>
      {action}
    </div>
  );
}

// ─── Main Dashboard Component ───────────────────
export function AgencyDashboard() {
  const { user, setView } = useAppStore();
  const { t, lang } = useLanguage();
  const isMobile = useIsMobile();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [waitingList, setWaitingList] = useState<QueueEntry[]>([]);
  const [serviceStats, setServiceStats] = useState<ServiceStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([]);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [announcements, setAnnouncements] = useState<Array<{ id: string; message: string; createdAt: string; type?: string }>>([]);
  const [newAnnouncement, setNewAnnouncement] = useState('');
  const [announcementLoading, setAnnouncementLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(true);
  const [serviceAnalytics, setServiceAnalytics] = useState<Array<{
    serviceId: string;
    serviceName: string;
    serviceNameAr?: string;
    serviceNameFr?: string;
    avgWaitTime: number;
    totalServed: number;
    avgRating: number;
  }>>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const [agencyCode, setAgencyCode] = useState<string>('');
  const [showQrModal, setShowQrModal] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [walkInOpen, setWalkInOpen] = useState(false);
  const [walkInName, setWalkInName] = useState('');
  const [walkInServiceId, setWalkInServiceId] = useState('');
  const [walkInLoading, setWalkInLoading] = useState(false);
  const [ticketConfirmation, setTicketConfirmation] = useState<{ visible: boolean; ticketNumber: string; customerName: string; serviceName: string }>({ visible: false, ticketNumber: '', customerName: '', serviceName: '' });
  const [wasOffline, setWasOffline] = useState(false);
  const fetchInProgressRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollErrorShownRef = useRef(false); // Prevent toast spam during polling
  const currentPollMsRef = useRef(10000);
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true });
  const agencyId = user?.agencyId || '';
  const realtime = useRealtime();

  // Fetch agency profile for QR code
  const fetchAgencyCode = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/profile?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        setAgencyCode(data.code || '');
      }
    } catch { /* silent */ }
  }, [agencyId]);

  // Generate QR code client-side
  useEffect(() => {
    if (!agencyCode) return;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://blasti.dz';
    const qrData = `${baseUrl}/?code=${agencyCode}`;
    QRCode.toDataURL(qrData, {
      width: 256,
      margin: 2,
      color: { dark: '#047857', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then((url) => setQrCodeDataUrl(url))
      .catch(() => { /* silent */ });
  }, [agencyCode]);

  const fetchData = useCallback(async () => {
    if (!agencyId) {
      // No agency assigned — show setup prompt instead of error
      setLoading(false);
      return;
    }
    // Skip if a fetch is already in progress to prevent overlapping requests
    if (fetchInProgressRef.current) return;
    fetchInProgressRef.current = true;
    setFetchError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');

      // Use allSettled so a single section failure (e.g. analytics timeout)
      // never kills the entire dashboard — each section is independent.
      const results = await Promise.allSettled([
        fetchWithRetry(`/api/agency/stats?agencyId=${encodeURIComponent(agencyId)}`, { maxRetries: 0 }),
        fetchWithRetry(`/api/agency/queue?agencyId=${encodeURIComponent(agencyId)}&status=WAITING,CALLED`, { maxRetries: 0 }),
        fetchWithRetry(`/api/agency/services?agencyId=${encodeURIComponent(agencyId)}`, { maxRetries: 0 }),
        fetchWithRetry(`/api/agency/activity?agencyId=${encodeURIComponent(agencyId)}`, { maxRetries: 0 }),
      ]);

      // Extract responses; rejected promises yield null
      const statsRes = results[0].status === 'fulfilled' ? results[0].value : null;
      const listRes = results[1].status === 'fulfilled' ? results[1].value : null;
      const servicesRes = results[2].status === 'fulfilled' ? results[2].value : null;
      const activityRes = results[3].status === 'fulfilled' ? results[3].value : null;

      // Only fatal if EVERY section failed
      const anySuccess = [statsRes, listRes, servicesRes, activityRes].some(r => r?.ok);
      if (!anySuccess) {
        setFetchError(true);
        if (!pollErrorShownRef.current) {
          // Log individual failures for debugging
          const sections = ['stats', 'queue', 'services', 'activity'];
          results.forEach((r, i) => {
            if (r.status === 'rejected') {
              console.warn(`[Dashboard] ${sections[i]} fetch rejected:`, r.reason);
            } else if (r.value && !r.value.ok) {
              console.warn(`[Dashboard] ${sections[i]} returned ${r.value.status}:`, r.value.statusText);
            }
          });
          toast.error(t('error'));
          pollErrorShownRef.current = true;
        }
        return;
      }

      // Process each section independently — partial failures are fine
      if (statsRes?.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
      if (listRes?.ok) {
        const data = await listRes.json();
        setWaitingList(data.entries ?? []);
      }
      if (servicesRes?.ok) {
        const data = await servicesRes.json();
        if (data.services) {
          setServiceStats(
            data.services.map((s: ServiceStat) => ({
              ...s,
              waitingCount: s._count?.waiting ?? 0,
              completedCount: s._count?.completed ?? 0,
            }))
          );
        }
      }
      if (activityRes?.ok) {
        const data = await activityRes.json();
        setActivityEvents(data.events ?? []);
      }
      setLastUpdated(new Date());
      pollErrorShownRef.current = false; // Reset on success so next poll failure can toast once
    } catch {
      // This catch is a safety net for truly unexpected errors (e.g. dynamic import failure).
      // With allSettled, normal fetch failures are handled above.
      setFetchError(true);
      if (!pollErrorShownRef.current) {
        toast.error(t('error'));
        pollErrorShownRef.current = true;
      }
    } finally {
      setLoading(false);
      fetchInProgressRef.current = false;
    }
  }, [agencyId]);

  const handleCallNext = async () => {
    setActionLoading('call');
    try {
      const res = await apiFetch('/api/agency/queue/call-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId }),
      });
      if (res.ok) {
        toast.success(t('statusCalled'));
        fetchData();
      } else {
        const data = await res.json();
        // Show details if available for debugging, otherwise show error or default
        const errorMsg = data.details || data.error || t('noQueue');
        toast.error(errorMsg);
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleTogglePause = async () => {
    setActionLoading('pause');
    try {
      const res = await apiFetch('/api/agency/queue/toggle-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId }),
      });
      if (res.ok) {
        toast.success(stats?.isPaused ? t('queueResumed') : t('queuePaused'));
        fetchData();
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleAction = async (entryId: string, action: 'complete' | 'no_show' | 'cancel') => {
    setActionLoading(`${entryId}-${action}`);
    try {
      const res = await apiFetch(`/api/agency/queue/${entryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(t('success'));
        fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setActionLoading(null);
    }
  };

  const toggleBatchSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleBatchComplete = async () => {
    if (selectedIds.size === 0) return;
    setBatchLoading(true);
    try {
      const promises = Array.from(selectedIds).map(id =>
        apiFetch(`/api/agency/queue/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'complete' }),
        })
      );
      const results = await Promise.allSettled(promises);
      let failedCount = 0;
      for (const r of results) {
        if (r.status === 'rejected') {
          failedCount++;
        } else if (r.status === 'fulfilled' && !r.value.ok) {
          failedCount++;
        }
      }
      if (failedCount === 0) {
        toast.success(t('success'));
      } else if (failedCount < results.length) {
        toast.warning(t('batchPartialFail') || `${failedCount}/${results.length} actions failed, rest succeeded`);
      } else {
        toast.error(t('error'));
      }
      setSelectedIds(new Set());
      setBatchMode(false);
      fetchData();
    } catch {
      toast.error(t('error'));
    } finally {
      setBatchLoading(false);
    }
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  const fetchAnnouncements = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/announcements?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        setAnnouncements(data.announcements ?? []);
      }
    } catch { /* silent */ }
  }, [agencyId]);

  // Adaptive polling: starts at 10s, backs off to 30s on 429 rate limits
  useEffect(() => {
    fetchData();
    fetchAnnouncements();
    fetchAgencyCode();

    const scheduleNextPoll = () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = setInterval(() => {
        // Skip polling when the API is unreachable to avoid a storm of failed requests
        if (isBothUnreachable()) return;
        fetchData();
      }, currentPollMsRef.current);
    };
    scheduleNextPoll();

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [fetchData, fetchAnnouncements, fetchAgencyCode, agencyId]);

  // Watch for 429 responses and back off polling
  useEffect(() => {
    const handler = (_e: Event) => {
      // If we see 429 errors, increase polling interval
      const newInterval = Math.min(currentPollMsRef.current + 10000, 60000);
      if (newInterval !== currentPollMsRef.current) {
        currentPollMsRef.current = newInterval;
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = setInterval(() => {
            if (isBothUnreachable()) return;
            fetchData();
          }, newInterval);
        }
      }
    };
    window.addEventListener('blasti:rate-limited', handler);
    return () => window.removeEventListener('blasti:rate-limited', handler);
  }, [fetchData]);

  // ─── Track offline/online transitions for auto-refresh ──────────────
  useEffect(() => {
    if (!realtime.isConnected) {
      setWasOffline(true);
    } else if (wasOffline && realtime.isConnected) {
      // Reconnected after being offline — auto-refresh data
      setWasOffline(false);
      fetchData();
      toast.success(t('reconnected' as any) || 'Connection restored — data refreshed');
    }
  }, [realtime.isConnected, wasOffline, fetchData, t]);

  // ─── Proactive recovery: refresh when offline cooldown expires ───────
  // When both-unreachable flag is active, the polling skips. After the
  // 30s cooldown expires, we proactively trigger a fetch instead of
  // waiting for the next polling tick (up to 10s delay).
  useEffect(() => {
    if (!isBothUnreachable()) return;
    // The flag expires in ~30s. Schedule a refresh 31s from now
    // (small buffer to ensure the flag has actually expired).
    const timer = setTimeout(() => {
      fetchData();
      fetchAnnouncements();
    }, 31_000);
    return () => clearTimeout(timer);
  }, [isBothUnreachable(), fetchData, fetchAnnouncements]);

  // ─── Realtime: Join agency room for instant updates ──────────────────
  useEffect(() => {
    if (!agencyId) return;
    realtime.joinAgency(agencyId);
    return () => {
      realtime.leaveAgency(agencyId);
    };

  }, [agencyId]);

  // ─── Realtime: Instant updates on queue events ──────────────────────
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    const handleQueueEvent = () => {
      fetchData();
    };

    unsubscribers.push(realtime.onQueueCalled(handleQueueEvent));
    unsubscribers.push(realtime.onQueueCompleted(handleQueueEvent));
    unsubscribers.push(realtime.onQueueNoShow(handleQueueEvent));
    unsubscribers.push(realtime.onQueueCancelled(handleQueueEvent));
    unsubscribers.push(realtime.onQueueJoined(handleQueueEvent));
    unsubscribers.push(realtime.onQueueWalkIn(handleQueueEvent));
    unsubscribers.push(realtime.onQueuePaused(handleQueueEvent));
    unsubscribers.push(realtime.onQueueResumed(handleQueueEvent));
    unsubscribers.push(realtime.onQueuePositionChanged(handleQueueEvent));

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [realtime, fetchData]);

  const handleCreateAnnouncement = async () => {
    if (!newAnnouncement.trim() || !agencyId) return;
    setAnnouncementLoading(true);
    try {
      const res = await apiFetch(`/api/agency/announcements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId, message: newAnnouncement.trim() }),
      });
      if (res.ok) {
        setNewAnnouncement('');
        toast.success(t('announcementCreated') || 'Announcement created');
        fetchAnnouncements();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setAnnouncementLoading(false);
    }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/announcements?id=${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('announcementDeleted') || 'Announcement deleted');
        fetchAnnouncements();
      }
    } catch {
      toast.error(t('error'));
    }
  };

  const fetchServiceAnalytics = useCallback(async () => {
    if (!agencyId) return;
    setAnalyticsLoading(true);
    try {
      const res = await apiFetch(`/api/agency/analytics?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const data = await res.json();
        setServiceAnalytics(data.services ?? []);
      }
    } catch { /* silent */ }
    finally {
      setAnalyticsLoading(false);
    }
  }, [agencyId]);

  const handleExportCsv = async () => {
    if (!agencyId) return;
    setExportLoading(true);
    try {
      const res = await apiFetch(`/api/agency/export-csv?agencyId=${encodeURIComponent(agencyId)}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `blasti-reservations-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t('exportSuccess'));
      } else {
        toast.error(t('exportFailed'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setExportLoading(false);
    }
  };

  const handleAddWalkIn = async () => {
    if (!walkInName.trim() || !agencyId) return;
    setWalkInLoading(true);
    try {
      const body: Record<string, string> = {
        agencyId,
        customerName: walkInName.trim(),
      };
      if (walkInServiceId) body.serviceId = walkInServiceId;
      const res = await apiFetch('/api/agency/queue/walk-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(t('walkInCustomerAdded'));
        setWalkInOpen(false);
        setWalkInName('');
        setWalkInServiceId('');
        // Show ticket confirmation animation
        if (data.queueNumber || data.entry?.queueNumber) {
          const selectedService = serviceStats.find(s => s.id === walkInServiceId);
          setTicketConfirmation({
            visible: true,
            ticketNumber: data.queueNumber || data.entry?.queueNumber || '',
            customerName: walkInName.trim(),
            serviceName: selectedService ? getServiceDisplayName(selectedService) : '',
          });
        }
        fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setWalkInLoading(false);
    }
  };

  const getServiceName = (entry: QueueEntry) => {
    if (lang === 'ar' && entry.serviceNameAr) return entry.serviceNameAr;
    if (lang === 'fr' && entry.serviceNameFr) return entry.serviceNameFr;
    return entry.serviceName;
  };

  const getServiceDisplayName = (s: ServiceStat) => {
    if (lang === 'ar' && s.nameAr) return s.nameAr;
    if (lang === 'fr' && s.nameFr) return s.nameFr;
    return s.name;
  };

  const getAnalyticsServiceName = (s: { serviceName: string; serviceNameAr?: string; serviceNameFr?: string }) => {
    if (lang === 'ar' && s.serviceNameAr) return s.serviceNameAr;
    if (lang === 'fr' && s.serviceNameFr) return s.serviceNameFr;
    return s.serviceName;
  };

  const formatTime = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  };

  // Calculate completion rate
  const served = stats?.servedToday ?? 0;
  const noShows = stats?.noShowCount ?? 0;
  const cancelled = stats?.cancelledCount ?? 0;
  const totalProcessed = served + noShows + cancelled;
  const completionRate = totalProcessed > 0 ? (served / totalProcessed) * 100 : 0;
  const safeCompletionRate = isNaN(completionRate) ? 0 : completionRate;

  // Max waiting count for service breakdown bars
  const maxWaiting = serviceStats.length > 0 ? Math.max(...serviceStats.map(s => s.waitingCount), 1) : 1;

  // Queue progress calculation
  const totalToday = stats?.todayReservations ?? 0;
  const queueProgress = totalToday > 0 ? Math.min(((served + noShows + cancelled) / totalToday) * 100, 100) : 0;

  // Last updated formatted time
  const lastUpdatedStr = useMemo(() => {
    try {
      return lastUpdated.toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  }, [lastUpdated, lang]);

  // ─── Mobile: Show SimpleMobileDashboard (barber/mechanic mode) ────────
  if (isMobile) {
    return <SimpleMobileDashboard agencyId={agencyId} />;
  }

  if (loading) {
    return (
      <div className="p-4 lg:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-36 rounded-lg" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20 rounded-lg" />
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
        </div>
        <Skeleton className="h-24 rounded-2xl skeleton-shimmer" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl skeleton-shimmer" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Skeleton className="h-36 rounded-2xl skeleton-shimmer" />
          <Skeleton className="h-36 rounded-2xl skeleton-shimmer" />
        </div>
        <Skeleton className="h-44 rounded-2xl skeleton-shimmer" />
      </div>
    );
  }

  // Show error state with retry if all fetches failed
  if (fetchError && !stats) {
    return (
      <div className="p-4 lg:p-5">
        <ErrorState onRetry={() => { setLoading(true); setFetchError(false); fetchData(); }} />
      </div>
    );
  }

  // Show agency creation form if user has no agency assigned
  if (!agencyId && !loading) {
    return (
      <div className="p-4 lg:p-5">
        <div className="min-h-[60vh] flex items-center justify-center">
          <CreateAgencyForm
            onAgencyCreated={() => {
              // The Zustand store is already updated by CreateAgencyForm.
              // After a short delay for re-render, fetch the dashboard data.
              setLoading(true);
              setFetchError(false);
              setTimeout(() => fetchData(), 500);
            }}
          />
        </div>
      </div>
    );
  }

  // Generate sparkline data from actual stats
  const sparkData1 = stats?.todayReservations ? [Math.round(stats.todayReservations * 0.4), Math.round(stats.todayReservations * 0.6), Math.round(stats.todayReservations * 0.5), stats.todayReservations, Math.round(stats.todayReservations * 0.8), stats.todayReservations, Math.round(stats.todayReservations * 0.7)] : [0, 1, 0, 2, 1, 3, 1];
  const sparkData2 = stats?.currentlyWaiting ? [Math.round(stats.currentlyWaiting * 0.5), Math.round(stats.currentlyWaiting * 0.3), stats.currentlyWaiting, Math.round(stats.currentlyWaiting * 0.8), Math.round(stats.currentlyWaiting * 0.6), stats.currentlyWaiting, Math.round(stats.currentlyWaiting * 0.4)] : [0, 1, 2, 1, 0, 1, 0];
  const sparkData3 = stats?.servedToday ? [Math.round(stats.servedToday * 0.3), Math.round(stats.servedToday * 0.5), stats.servedToday, Math.round(stats.servedToday * 0.7), Math.round(stats.servedToday * 0.9), stats.servedToday, Math.round(stats.servedToday * 0.8)] : [0, 0, 1, 0, 2, 1, 0];
  const sparkData4 = stats?.avgWaitTime ? [Math.round(stats.avgWaitTime * 0.7), Math.round(stats.avgWaitTime * 0.6), stats.avgWaitTime, Math.round(stats.avgWaitTime * 0.8), stats.avgWaitTime, Math.round(stats.avgWaitTime * 0.9), Math.round(stats.avgWaitTime * 0.7)] : [5, 4, 8, 6, 10, 8, 6];

  // Queue status level for the Now Serving card
  const avgWait = stats?.avgWaitTime ?? 0;
  const waitLevel = avgWait <= 10 ? 'low' : avgWait <= 25 ? 'medium' : 'high';
  const waitLevelConfig = {
    low: { label: t('lowWait'), dotColor: 'bg-emerald-300' },
    medium: { label: t('mediumWait'), dotColor: 'bg-amber-300' },
    high: { label: t('highWait'), dotColor: 'bg-rose-300' },
  };

  return (
    <div className="p-4 lg:p-6 space-y-6 max-w-7xl mx-auto relative" ref={sectionRef}>
      {/* Gradient top border */}
      <div className="absolute top-0 start-0 end-0 h-[3px] bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 rounded-full" />

      {/* Offline Mode Banner */}
      <OfflineIndicator
        isConnected={realtime.isConnected}
        onReconnect={fetchData}
        t={t as any}
      />

      {/* Subscription Inactive Banner */}
      {stats?.subscriptionStatus && stats.subscriptionStatus !== 'ACTIVE' && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl bg-gradient-to-r from-amber-500 via-red-500 to-amber-500 p-[2px]"
        >
          <div className="rounded-[14px] bg-gradient-to-r from-amber-50 to-red-50 dark:from-amber-950/50 dark:to-red-950/50 p-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-500 to-red-500 flex items-center justify-center flex-shrink-0">
              <AlertCircle className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-amber-800 dark:text-amber-200 text-sm">{t('subscriptionInactive')}</p>
              <p className="text-xs text-amber-700/70 dark:text-amber-300/70 mt-0.5">{t('subscriptionRequired')}</p>
            </div>
            <Button
              onClick={() => setView('agency-subscription')}
              className="bg-gradient-to-r from-amber-500 to-red-500 hover:from-amber-600 hover:to-red-600 text-white rounded-xl h-9 px-4 text-sm font-semibold flex-shrink-0"
            >
              {t('activatePlan')}
            </Button>
          </div>
        </motion.div>
      )}

      {/* ═══ HEADER ═══ */}
      <header className="space-y-1">
        <motion.p
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.02 }}
          className="text-sm text-muted-foreground"
        >
          {t('welcomeBack')}, <span className="font-semibold text-foreground">{user?.fullName?.split(' ')[0] || ''}</span> 👋
        </motion.p>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl lg:text-2xl font-bold text-foreground flex items-center gap-2">
              {t('agencyDashboard')}
              <motion.span
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
                className={`flex items-center gap-1.5 text-xs ${realtime.isConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}
              >
                <span className={`h-2 w-2 rounded-full inline-block live-pulse ${realtime.isConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {realtime.isConnected ? t('live') : (t('polling') || 'Polling')}
              </motion.span>
            </h1>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCsv}
              disabled={exportLoading}
              className="h-8 px-2.5 rounded-lg gap-1 text-xs"
            >
              {exportLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{t('exportCsv') || 'Export'}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchData}
              className="h-8 w-8"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                try {
                  const el = document.documentElement;
                  if (el.requestFullscreen) el.requestFullscreen();
                  else if ((el as any).webkitRequestFullscreen) (el as any).webkitRequestFullscreen();
                  else if ((el as any).msRequestFullscreen) (el as any).msRequestFullscreen();
                } catch { /* fullscreen may fail */ }
                setView('agency-fullscreen');
              }}
              className="h-8 px-2.5 rounded-lg gap-1.5 text-xs border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
            >
              <Maximize className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t('fullscreenMode') || 'Fullscreen'}</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ═══ SECTION 1: NOW SERVING (Hero) ═══ */}
      <section>
        <SectionHeader icon={Radio} title={t('nowServing') as string} />
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04, type: 'spring', stiffness: 180, damping: 20 }}
        >
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 p-5 sm:p-7 shadow-xl shadow-emerald-600/20">
            {/* Decorative circles */}
            <div className="absolute top-0 end-0 h-32 w-32 rounded-full bg-white/5 -translate-y-10 translate-x-10" />
            <div className="absolute bottom-0 start-0 h-20 w-20 rounded-full bg-white/5 translate-y-8 -translate-x-8" />
            <div className="absolute top-1/2 end-1/4 h-40 w-40 rounded-full bg-white/[0.03] -translate-y-1/2" />
            {/* Dot pattern overlay */}
            <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)', backgroundSize: '20px 20px' }} />

            <div className="relative flex flex-col sm:flex-row items-center gap-5">
              {/* Left: Serving number with pulse ring */}
              <div className="flex flex-col items-center gap-2 flex-shrink-0">
                <p className="text-emerald-200 text-xs font-semibold tracking-wide uppercase flex items-center gap-1.5">
                  <span className="bg-gradient-to-r from-emerald-200 to-cyan-200 bg-clip-text text-transparent font-bold">
                    {t('nowServingHero') as string}
                  </span>
                  <motion.span
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full inline-block ${waitLevelConfig[waitLevel].dotColor}`} />
                  </motion.span>
                </p>

                {/* Pulsing ring around the number */}
                <div className="relative">
                  {!stats?.isPaused && (
                    <motion.div
                      className="absolute inset-0 rounded-full"
                      animate={{
                        boxShadow: [
                          '0 0 0 0 rgba(110, 231, 183, 0.5)',
                          '0 0 0 20px rgba(110, 231, 183, 0)',
                          '0 0 0 0 rgba(110, 231, 183, 0)',
                        ],
                      }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
                    />
                  )}
                  <motion.div
                    key={waitingList.find(e => e.status === 'CALLED')?.queueNumber || stats?.currentQueueNumber}
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 220, damping: 18 }}
                    className="h-28 w-28 sm:h-32 sm:w-32 lg:h-36 lg:w-36 rounded-full bg-white/10 backdrop-blur-sm border-2 border-white/20 flex items-center justify-center ticket-glow"
                  >
                    <span className="text-5xl sm:text-6xl lg:text-7xl font-black text-white tracking-tight leading-none">
                      {waitingList.find(e => e.status === 'CALLED')?.queueNumber || stats?.currentQueueNumber || '—'}
                    </span>
                  </motion.div>
                </div>

                {/* Counter name */}
                <div className="flex items-center gap-1.5 mt-1">
                  <Badge className={`text-[9px] px-2 py-0.5 h-5 ${
                    stats?.isPaused
                      ? 'bg-amber-400/30 text-amber-100 border-amber-400/30'
                      : 'bg-emerald-400/30 text-emerald-100 border-emerald-400/30'
                  }`}>
                    {stats?.isPaused ? t('queuePausedLabel') : t('queueActive')}
                  </Badge>
                  <span className="text-[11px] text-emerald-200/80 font-medium">
                    {t('counterLabel') as string} {stats?.activeCounters ?? 1}
                  </span>
                </div>
              </div>

              {/* Center: Progress & details */}
              <div className="flex-1 min-w-0 text-center sm:text-start">
                <div className="mb-3">
                  <div className="flex items-center justify-center sm:justify-start gap-2 mb-1.5">
                    <span className="text-emerald-100 text-xs">{t('queueProgress')}</span>
                    <span className="text-white font-bold text-xs">{Math.round(queueProgress)}%</span>
                  </div>
                  <div className="h-3 w-full max-w-md rounded-full bg-white/15 overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${queueProgress}%` }}
                      transition={{ duration: 0.8, ease: 'easeOut' }}
                      className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300"
                    />
                  </div>
                  <div className="flex items-center justify-center sm:justify-between text-[11px] text-emerald-200/70 mt-1.5 max-w-md">
                    <span>{served} {t('servedLabel')}</span>
                    <span>{stats?.currentlyWaiting ?? 0} {t('waitingLabel')}</span>
                  </div>
                </div>

                {/* Live clock */}
                <div className="flex items-center justify-center sm:justify-start gap-3 mt-3">
                  <div className="text-end">
                    <p className="text-2xl sm:text-3xl font-black text-white tabular-nums" dir="ltr">
                      {new Date().toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                      <span className="clock-tick text-emerald-200">:</span>
                      {new Date().toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { second: '2-digit' }).split(':').pop()}
                    </p>
                  </div>
                  <div className="flex flex-col items-start gap-0.5">
                    <div className="flex items-center gap-1.5 text-[10px] text-emerald-200/70">
                      <motion.span
                        animate={{ opacity: [0.4, 1, 0.4] }}
                        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                        className="h-1.5 w-1.5 rounded-full bg-emerald-300"
                      />
                      {t('autoRefreshActive')}
                    </div>
                    <div className="text-[9px] text-emerald-200/50">
                      {t('lastRefreshed')}: {lastUpdatedStr}
                    </div>
                  </div>
                </div>
              </div>

              {/* Right: Action buttons */}
              <div className="flex sm:flex-col gap-2 flex-shrink-0">
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Button
                    onClick={handleCallNext}
                    disabled={actionLoading === 'call' || stats?.isPaused || (stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE')}
                    className="h-11 px-5 rounded-xl bg-gradient-to-r from-emerald-400 to-teal-400 hover:from-emerald-300 hover:to-teal-300 text-emerald-900 font-bold shadow-lg shadow-emerald-400/30 gap-2 disabled:opacity-50 transition-all duration-200 text-sm"
                  >
                    {actionLoading === 'call' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE' ? (
                      <Lock className="h-4 w-4" />
                    ) : (
                      <PhoneCall className="h-4 w-4" />
                    )}
                    {t('callNextAction') as string}
                  </Button>
                </motion.div>
                <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                  <Button
                    onClick={() => {
                      const calledEntry = waitingList.find(e => e.status === 'CALLED');
                      if (calledEntry) handleAction(calledEntry.id, 'complete');
                    }}
                    disabled={!!actionLoading || !waitingList.some(e => e.status === 'CALLED')}
                    className="h-11 px-5 rounded-xl bg-white/15 backdrop-blur-sm hover:bg-white/25 text-white font-bold border border-white/20 shadow-lg gap-2 disabled:opacity-40 transition-all duration-200 text-sm"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {t('completeAction') as string}
                  </Button>
                </motion.div>
              </div>
            </div>
          </div>
        </motion.div>
      </section>

      {/* ═══ SECTION 2: QUICK ACTIONS ═══ */}
      <section>
        <SectionHeader icon={Zap} title={t('quickActions') || 'Quick Actions'} />
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Call Next */}
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                onClick={handleCallNext}
                disabled={actionLoading === 'call' || stats?.isPaused || (stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE')}
                className="w-full h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white font-semibold shadow-lg shadow-emerald-500/20 gap-2 disabled:opacity-50 transition-all duration-200"
              >
                {actionLoading === 'call' ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE' ? (
                  <Lock className="h-5 w-5" />
                ) : (
                  <PhoneCall className="h-5 w-5" />
                )}
                <span className="text-sm">{t('callNext')}</span>
              </Button>
            </motion.div>

            {/* Toggle Queue (Pause/Resume) */}
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                onClick={handleTogglePause}
                disabled={actionLoading === 'pause'}
                variant="outline"
                className={`w-full h-14 rounded-2xl font-semibold gap-2 border-2 transition-all duration-200 ${
                  stats?.isPaused
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30'
                    : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30'
                }`}
              >
                {actionLoading === 'pause' ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : stats?.isPaused ? (
                  <Play className="h-5 w-5" />
                ) : (
                  <Pause className="h-5 w-5" />
                )}
                <span className="text-sm">{stats?.isPaused ? t('resumeQueue') : t('pauseQueue')}</span>
              </Button>
            </motion.div>

            {/* Add Walk-in Customer */}
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                onClick={() => setWalkInOpen(true)}
                variant="outline"
                className="w-full h-14 rounded-2xl font-semibold gap-2 border-2 border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-900/20 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/30 transition-all duration-200"
              >
                <UserPlus className="h-5 w-5" />
                <span className="text-sm">{t('addWalkInCustomer')}</span>
              </Button>
            </motion.div>

            {/* View QR Code */}
            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
              <Button
                onClick={() => setShowQrModal(true)}
                variant="outline"
                className="w-full h-14 rounded-2xl font-semibold gap-2 border-2 border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-700 dark:bg-teal-900/20 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-900/30 transition-all duration-200"
              >
                <QrCode className="h-5 w-5" />
                <span className="text-sm">{t('viewQrCode')}</span>
              </Button>
            </motion.div>
          </div>
        </motion.div>
      </section>

      {/* ═══ SECTION 3: QUEUE OVERVIEW (Stats) ═══ */}
      <section>
        <SectionHeader icon={BarChart3} title={t('queueOverview') || 'Queue Overview'} />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Total Today */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
          >
            <div className="relative overflow-hidden rounded-2xl p-[1px] bg-gradient-to-br from-emerald-400 to-emerald-600">
              <div className="rounded-[14px] bg-white dark:bg-gray-900 p-3 sm:p-4 relative overflow-hidden h-full">
                {/* Dot pattern */}
                <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center">
                        <Users className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium">{t('totalToday')}</span>
                    </div>
                    <p className="text-2xl sm:text-3xl font-black leading-none bg-gradient-to-r from-emerald-500 to-teal-500 bg-clip-text text-transparent">
                      <AnimatedCounter value={stats?.todayReservations ?? 0} />
                    </p>
                  </div>
                  <MiniSparkline data={sparkData1} color="bg-emerald-400" />
                </div>
              </div>
            </div>
          </motion.div>

          {/* Waiting */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="relative overflow-hidden rounded-2xl p-[1px] bg-gradient-to-br from-teal-400 to-teal-600">
              <div className="rounded-[14px] bg-white dark:bg-gray-900 p-3 sm:p-4 relative overflow-hidden h-full">
                <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-teal-500 to-teal-600 flex items-center justify-center">
                        <Clock className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium">{t('queueLengthShort')}</span>
                    </div>
                    <p className="text-2xl sm:text-3xl font-black leading-none bg-gradient-to-r from-teal-500 to-cyan-500 bg-clip-text text-transparent">
                      <AnimatedCounter value={stats?.currentlyWaiting ?? 0} />
                    </p>
                  </div>
                  <MiniSparkline data={sparkData2} color="bg-teal-400" />
                </div>
              </div>
            </div>
          </motion.div>

          {/* Served */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <div className="relative overflow-hidden rounded-2xl p-[1px] bg-gradient-to-br from-cyan-400 to-cyan-600">
              <div className="rounded-[14px] bg-white dark:bg-gray-900 p-3 sm:p-4 relative overflow-hidden h-full">
                <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
                        <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium">{t('customersServed')}</span>
                    </div>
                    <p className="text-2xl sm:text-3xl font-black leading-none bg-gradient-to-r from-cyan-500 to-teal-500 bg-clip-text text-transparent">
                      <AnimatedCounter value={stats?.servedToday ?? 0} />
                    </p>
                  </div>
                  <MiniSparkline data={sparkData3} color="bg-cyan-400" />
                </div>
              </div>
            </div>
          </motion.div>

          {/* No-Show Rate */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="relative overflow-hidden rounded-2xl p-[1px] bg-gradient-to-br from-amber-400 to-amber-600">
              <div className="rounded-[14px] bg-white dark:bg-gray-900 p-3 sm:p-4 relative overflow-hidden h-full">
                <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 flex items-center justify-center">
                        <AlertTriangle className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium">{t('noShowShort')}</span>
                    </div>
                    <p className="text-2xl sm:text-3xl font-black leading-none bg-gradient-to-r from-amber-500 to-amber-600 bg-clip-text text-transparent">
                      <AnimatedCounter value={stats?.noShowRate ?? 0} />
                      <span className="text-sm font-semibold ms-0.5 bg-gradient-to-r from-amber-500 to-amber-600 bg-clip-text text-transparent">%</span>
                    </p>
                  </div>
                  <MiniSparkline data={sparkData4} color="bg-amber-400" />
                </div>
              </div>
            </div>
          </motion.div>

          {/* Walk-in Count */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            <div className="relative overflow-hidden rounded-2xl p-[1px] bg-gradient-to-br from-emerald-400 to-teal-500">
              <div className="rounded-[14px] bg-white dark:bg-gray-900 p-3 sm:p-4 relative overflow-hidden h-full">
                <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center">
                        <UserPlus className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium">{t('walkInCount' as any) || 'Walk-ins'}</span>
                    </div>
                    <p className="text-2xl sm:text-3xl font-black leading-none bg-gradient-to-r from-emerald-500 to-teal-500 bg-clip-text text-transparent">
                      <AnimatedCounter value={stats?.walkInCount ?? 0} />
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Active Counters */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div className="relative overflow-hidden rounded-2xl p-[1px] bg-gradient-to-br from-teal-400 to-emerald-500">
              <div className="rounded-[14px] bg-white dark:bg-gray-900 p-3 sm:p-4 relative overflow-hidden h-full">
                <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle, currentColor 1px, transparent 1px)', backgroundSize: '16px 16px' }} />
                {/* Pulse animation for active counters */}
                {!stats?.isPaused && (stats?.activeCounters ?? 0) > 0 && (
                  <motion.div
                    className="absolute top-2 end-2 h-2.5 w-2.5 rounded-full bg-emerald-500/60"
                    animate={{ scale: [1, 1.5, 1], opacity: [0.6, 1, 0.6] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
                <div className="relative flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-teal-400 to-emerald-500 flex items-center justify-center">
                        <Layers className="h-3.5 w-3.5 text-white" />
                      </div>
                      <span className="text-[10px] text-muted-foreground font-medium">{t('activeCounters' as any) || 'Active Counters'}</span>
                    </div>
                    <p className="text-2xl sm:text-3xl font-black leading-none bg-gradient-to-r from-teal-500 to-emerald-500 bg-clip-text text-transparent">
                      <AnimatedCounter value={stats?.activeCounters ?? 1} />
                    </p>
                    {stats?.estimatedWaitRange && (
                      <p className="text-[10px] text-muted-foreground mt-1">
                        ETA: {(stats.estimatedWaitRange as any).min ?? (stats.estimatedWaitRange as any).minMinutes}–{(stats.estimatedWaitRange as any).max ?? (stats.estimatedWaitRange as any).maxMinutes} min
                      </p>
                    )}
                  </div>
                  {/* Mini pulse rings when active */}
                  {!stats?.isPaused && (stats?.activeCounters ?? 0) > 0 && (
                    <div className="flex items-center gap-0.5 mt-1">
                      {[0, 1, 2].map(i => (
                        <motion.div
                          key={i}
                          className="h-1.5 w-1.5 rounded-full bg-emerald-400/60"
                          animate={{ scale: [1, 1.4, 1], opacity: [0.3, 0.8, 0.3] }}
                          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ═══ SECTION 4: WAITING LIST (Actionable) ═══ */}
      <section>
        <SectionHeader
          icon={Users}
          title={t('waitingList')}
          count={waitingList.length}
          action={
            <Button
              variant={batchMode ? 'default' : 'outline'}
              size="sm"
              className={batchMode
                ? 'h-8 px-3 rounded-lg gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs'
                : 'h-8 px-3 rounded-lg gap-1.5 text-xs'
              }
              onClick={() => batchMode ? exitBatchMode() : setBatchMode(true)}
            >
              {batchMode ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              {batchMode ? t('exitBatchMode') : t('batchMode')}
            </Button>
          }
        />
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardContent className="pt-6 space-y-3">
            {batchMode && selectedIds.size > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('selectTickets')} · {selectedIds.size} {t('selected')}
              </p>
            )}
            {waitingList.length === 0 ? (
              <EmptyState
                iconComponent={Users}
                title={t('noQueue')}
                description={t('noQueueHint')}
              />
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
                {waitingList.map((entry, idx) => (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className={idx % 2 === 0
                      ? "flex items-center justify-between p-3 rounded-xl bg-gray-50/80 dark:bg-gray-900/50 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 hover:shadow-md hover:shadow-emerald-500/5 transition-all duration-200 group"
                      : "flex items-center justify-between p-3 rounded-xl bg-white dark:bg-gray-900/30 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 hover:shadow-md hover:shadow-emerald-500/5 transition-all duration-200 group"
                    }
                  >
                    <div className="flex items-center gap-3">
                      <div className={`min-h-10 min-w-10 px-2.5 py-1 rounded-xl flex items-center justify-center transition-colors duration-200 ${
                        entry.status === 'CALLED'
                          ? 'bg-emerald-500 text-white'
                          : 'bg-emerald-100 dark:bg-emerald-900/30'
                      }`}>
                        <span className={`text-xs sm:text-sm font-bold whitespace-nowrap ${entry.status === 'CALLED' ? 'text-white' : 'text-emerald-700 dark:text-emerald-400'}`}>
                          {entry.queueNumber}
                        </span>
                      </div>
                      <div className="hidden sm:block min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{entry.customerName}</p>
                        <p className="text-xs text-muted-foreground">{getServiceName(entry)}</p>
                      </div>
                      <div className="sm:hidden min-w-0">
                        <p className="text-xs font-medium text-foreground truncate max-w-[80px]">{entry.customerName}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground hidden md:block">
                        {formatTime(entry.joinedAt)}
                      </span>
                      {entry.status === 'CALLED' && (
                        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px]">
                          {t('statusCalled')}
                        </Badge>
                      )}
                      <div className={`flex items-center gap-1 transition-opacity ${batchMode ? 'opacity-100' : 'opacity-60 group-hover:opacity-100'}`}>
                        {batchMode && entry.status === 'WAITING' && (
                          <Checkbox
                            checked={selectedIds.has(entry.id)}
                            onCheckedChange={() => toggleBatchSelection(entry.id)}
                            className="h-8 w-8 rounded-lg border-emerald-300 dark:border-emerald-700 data-[state=checked]:bg-emerald-600 data-[state=checked]:border-emerald-600"
                            aria-label={t('selectTickets')}
                          />
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 p-0 text-emerald-600 border-emerald-200 dark:border-emerald-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                          onClick={() => handleAction(entry.id, 'complete')}
                          title={t('markCompleted')}
                          aria-label={t('markCompleted')}
                          disabled={!!actionLoading}
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 p-0 text-amber-600 border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                          onClick={() => handleAction(entry.id, 'no_show')}
                          title={t('markNoShow')}
                          aria-label={t('markNoShow')}
                          disabled={!!actionLoading}
                        >
                          <UserX className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 w-8 p-0 text-red-600 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20"
                          onClick={() => handleAction(entry.id, 'cancel')}
                          title={t('cancelRes')}
                          aria-label={t('markCancelled')}
                          disabled={!!actionLoading}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ═══ SECTION 5: COUNTERS & TIMELINE ═══ */}
      <section>
        <SectionHeader icon={Layers} title={t('countersTimeline') || 'Counters & Timeline'} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Counter Management */}
          <CounterManagement
            waitingList={waitingList.filter(e => e.status === 'WAITING')}
            calledEntry={waitingList.filter(e => e.status === 'CALLED')}
            servedToday={served}
            avgWaitTime={avgWait}
            actionLoading={actionLoading}
            onCallNext={handleCallNext}
            onCallNextForCounter={(counterId: string) => {
              setActionLoading(`call-${counterId}`);
              handleCallNext();
            }}
            lang={lang}
            t={t as any}
          />

          {/* Queue Timeline */}
          <QueueTimeline
            hourlyWaitTime={stats?.hourlyWaitTime}
            avgWaitTime={avgWait}
            todayReservations={totalToday}
            servedToday={served}
            peakHour={stats?.peakHour}
            lang={lang}
            t={t as any}
          />
        </div>
      </section>

      {/* ═══ SECTION 6: PERFORMANCE ═══ */}
      <section>
        <SectionHeader icon={Activity} title={t('performance') || 'Performance'} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Left: Service Breakdown */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.15 }}
          >
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full overflow-hidden">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
                    <Layers className="h-3.5 w-3.5 text-white" />
                  </div>
                  {t('serviceDistribution') as string}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {serviceStats.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
                    <Layers className="h-8 w-8 text-emerald-400 mb-2" />
                    <p className="text-sm text-muted-foreground">{t('noServiceEntries') as string}</p>
                  </div>
                ) : (
                  <div className="space-y-3.5 max-h-80 overflow-y-auto custom-scrollbar">
                    {serviceStats.map((service, idx) => {
                      const barWidth = maxWaiting > 0 ? (service.waitingCount / maxWaiting) * 100 : 0;
                      const completionPct = (service.waitingCount + service.completedCount) > 0
                        ? (service.completedCount / (service.waitingCount + service.completedCount)) * 100
                        : 0;
                      const isMostPopular = idx === 0 && service.waitingCount > 0;
                      // Assign gradient colors by index: emerald, teal, cyan, repeating
                      const gradients = [
                        'from-emerald-500 to-emerald-400',
                        'from-teal-500 to-teal-400',
                        'from-cyan-500 to-cyan-400',
                        'from-emerald-400 to-teal-400',
                        'from-teal-400 to-cyan-400',
                      ];
                      const barGradient = gradients[idx % gradients.length];
                      return (
                        <motion.div
                          key={service.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.06, type: 'spring', stiffness: 180, damping: 20 }}
                          className="space-y-1.5"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-medium text-sm text-foreground truncate max-w-[55%]">
                                {getServiceDisplayName(service)}
                              </span>
                              {isMostPopular && (
                                <Badge className="text-[8px] px-1.5 py-0 h-4 bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0">
                                  {t('mostPopular') as string}
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
                              <span className="font-semibold bg-gradient-to-r from-emerald-600 to-teal-600 dark:from-emerald-400 dark:to-teal-400 bg-clip-text text-transparent">
                                {service.waitingCount} {t('waiting')}
                              </span>
                              <span className="text-xs opacity-50">
                                {Math.round(completionPct)}%
                              </span>
                            </div>
                          </div>
                          <div className="h-3 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${Math.max(barWidth, 2)}%` }}
                              transition={{ duration: 0.7, delay: idx * 0.08, ease: 'easeOut' }}
                              className={`h-full rounded-full bg-gradient-to-r ${barGradient}`}
                            />
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Right: Performance Overview glass card */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.3 }}
          >
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600/90 via-teal-600/90 to-cyan-600/90 p-4 sm:p-5 text-white shadow-lg shadow-emerald-500/20 backdrop-blur-xl border border-white/10 h-full">
              {/* Decorative circles */}
              <div className="absolute top-0 end-0 h-24 w-24 rounded-full bg-white/10 -translate-y-8 translate-x-8" />
              <div className="absolute bottom-0 start-0 h-16 w-16 rounded-full bg-white/5 translate-y-6 -translate-x-6" />
              <div className="relative">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="h-3.5 w-3.5 text-emerald-200" />
                  <p className="text-xs font-semibold text-emerald-100">{t('performanceMetrics')}</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {/* Avg Rating */}
                  <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Star className="h-3.5 w-3.5 text-amber-300" />
                      <span className="text-[10px] text-emerald-200">{t('avgRatingStat')}</span>
                    </div>
                    <p className="text-2xl font-bold">{(stats?.avgRating ?? 0).toFixed(1)}</p>
                    <div className="flex items-center gap-0.5 mt-1">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star
                          key={s}
                          className={`h-3 w-3 ${s <= Math.round(stats?.avgRating ?? 0) ? 'text-amber-300 fill-amber-300' : 'text-white/30'}`}
                        />
                      ))}
                    </div>
                  </div>
                  {/* Total Ratings */}
                  <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Users className="h-3.5 w-3.5 text-emerald-200" />
                      <span className="text-[10px] text-emerald-200">{t('totalRatingsStat')}</span>
                    </div>
                    <p className="text-2xl font-bold">{stats?.totalRatings ?? 0}</p>
                    <p className="text-[10px] text-emerald-300/70 mt-1">{t('totalRatings')}</p>
                  </div>
                  {/* Completion Rate */}
                  <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-200" />
                      <span className="text-[10px] text-emerald-200">{t('completionRateStat')}</span>
                    </div>
                    <p className="text-2xl font-bold">{safeCompletionRate.toFixed(0)}%</p>
                    <div className="h-1.5 w-full rounded-full bg-white/20 mt-1.5 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(safeCompletionRate, 100)}%` }}
                        transition={{ duration: 1, ease: 'easeOut' }}
                        className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-cyan-300"
                      />
                    </div>
                  </div>
                  {/* No-Show Rate */}
                  <div className="bg-white/15 backdrop-blur-sm rounded-xl p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-200" />
                      <span className="text-[10px] text-emerald-200">{t('noShowRateStat')}</span>
                    </div>
                    <p className="text-2xl font-bold">{stats?.noShowRate ?? 0}%</p>
                    <p className="text-[10px] text-emerald-300/70 mt-1">{t('noShowRate')}</p>
                  </div>
                </div>
                {/* Legend for completion rate color thresholds */}
                <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-white/10">
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-100/80">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
                    &gt; 80%
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-100/80">
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                    50-80%
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-100/80">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                    &lt; 50%
                  </div>
                  <div className="ms-auto text-[10px] text-emerald-100/60">
                    {t('servedToday')}: {served} · {t('noShowRate')}: {noShows} · {t('cancelled')}: {cancelled}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ═══ SECTION 7: CHARTS ═══ */}
      <section>
        <SectionHeader icon={BarChart3} title={t('charts') || 'Charts'} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.35 }}
          >
            <WaitTimeChart
              data={(stats?.hourlyWaitTime ?? []).map((val: number, hour: number) => ({
                hour,
                avgWaitTime: typeof val === 'number' ? val : (val as any)?.avgWaitTime ?? 0,
                servedCount: 0,
              }))}
              currentHour={new Date().getHours()}
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.4 }}
          >
            <RatingDistribution
              ratings={(stats?.ratingDistribution ?? []).map((count: number, i: number) => ({
                rating: i + 1,
                count: typeof count === 'number' ? count : (count as any)?.count ?? 0,
              }))}
              averageRating={stats?.avgRating}
              totalRatings={stats?.totalRatings}
            />
          </motion.div>
        </div>
      </section>

      {/* ═══ SECTION 8: ACTIVITY & TOOLS ═══ */}
      <section>
        <SectionHeader icon={Activity} title={t('activityTools') || 'Activity & Tools'} />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Left (2/3): Recent Activity feed (richer version with avatars) */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.15 }}
            className="lg:col-span-2"
          >
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Rss className="h-4 w-4 text-emerald-600" />
                  {t('recentActivity')}
                  <motion.span
                    animate={{ opacity: [1, 0.3, 1] }}
                    transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
                    className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 ms-auto"
                  >
                    <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                    {t('live')}
                  </motion.span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {activityEvents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
                    <Activity className="h-8 w-8 text-emerald-400 mb-2" />
                    <p className="text-sm text-muted-foreground">{t('noRecentActivity')}</p>
                  </div>
                ) : (
                  <div className="relative space-y-0 max-h-80 overflow-y-auto custom-scrollbar">
                    {/* Timeline line */}
                    <div className="absolute start-[15px] top-2 bottom-2 w-px bg-border" />
                    {activityEvents.map((event, idx) => {
                      const config = getEventConfig(event.eventType);
                      const timeAgoStr = (() => {
                        const diff = Math.floor((Date.now() - new Date(event.timestamp).getTime()) / 1000);
                        if (diff < 60) return t('justNow');
                        if (diff < 3600) return `${Math.floor(diff / 60)} ${t('min')}`;
                        if (diff < 86400) return `${Math.floor(diff / 3600)} ${t('hours')}`;
                        return `${Math.floor(diff / 86400)} ${t('date')}`;
                      })();
                      const label = (t(event.eventKey as 'customerJoinedQueue') || event.eventKey).replace('{name}', event.customerName);

                      return (
                        <motion.div
                          key={event.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className="relative flex items-start gap-3 pb-4 last:pb-0"
                        >
                          {/* User avatar with initials */}
                          <UserAvatar name={event.customerName} colorClass={config.color} />

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm text-foreground leading-snug">{label}</p>
                              <Badge className={`text-[9px] px-1.5 py-0 h-4 ${config.badgeClass}`}>
                                {config.label}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-muted-foreground font-mono">#{event.queueNumber}</span>
                              {event.serviceName && (
                                <span className="text-[10px] text-muted-foreground">· {event.serviceName}</span>
                              )}
                              <span className="text-[10px] text-muted-foreground">· {timeAgoStr}</span>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Right (1/3): Tools card — QR Code display + Announcements combined */}
          <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={isInView ? { opacity: 1, y: 0 } : {}}
            transition={{ delay: 0.2 }}
          >
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <QrCode className="h-4 w-4 text-emerald-600" />
                  {t('qrCodeAgency')}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-3">
                {/* Small QR with View Full QR button */}
                <div className="flex flex-col items-center justify-center">
                  {qrCodeDataUrl ? (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.5 }}
                      className="relative"
                    >
                      <div className="p-2 rounded-2xl bg-white shadow-inner border border-gray-100 dark:border-gray-700">
                        <img
                          src={qrCodeDataUrl}
                          alt={t('qrCodeAgency')}
                          className="h-32 w-32"
                        />
                      </div>
                      {/* Decorative glow */}
                      <div className="absolute -inset-2 rounded-3xl bg-emerald-500/5 -z-10 blur-sm" />
                    </motion.div>
                  ) : (
                    <div className="h-32 w-32 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                      <QrCode className="h-12 w-12 text-gray-300 dark:text-gray-600" />
                    </div>
                  )}
                  {agencyCode && (
                    <div className="mt-2 text-center">
                      <Badge variant="secondary" className="text-xs font-mono px-2.5 py-1">
                        {agencyCode}
                      </Badge>
                      <p className="text-[10px] text-muted-foreground mt-1.5">{t('qrCodeScanHint')}</p>
                    </div>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 rounded-lg gap-1.5 text-xs"
                    onClick={() => setShowQrModal(true)}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t('viewQrCode')}
                  </Button>
                </div>

                {/* Divider */}
                <div className="border-t border-border" />

                {/* Announcements */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                      <Megaphone className="h-3.5 w-3.5" />
                      {t('announcements')}
                    </p>
                    <Badge variant="secondary" className="text-xs">{announcements.length}</Badge>
                  </div>
                  {/* Create new announcement */}
                  <div className="flex gap-2 mb-2">
                    <Textarea
                      value={newAnnouncement}
                      onChange={(e) => setNewAnnouncement(e.target.value)}
                      placeholder={t('announcementPlaceholder') || 'Write an announcement...'}
                      className="min-h-[60px] text-sm rounded-xl border-border resize-none"
                      rows={2}
                    />
                    <Button
                      size="sm"
                      onClick={handleCreateAnnouncement}
                      disabled={!newAnnouncement.trim() || announcementLoading}
                      className="self-end h-9 px-3 rounded-xl gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                    >
                      {announcementLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                  {/* Announcements list */}
                  {announcements.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-3 text-center text-muted-foreground">
                      <Megaphone className="h-6 w-6 text-emerald-400 mb-1 opacity-70" />
                      <p className="text-xs text-muted-foreground">{t('noAnnouncements')}</p>
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
                      <AnimatePresence>
                        {announcements.map((a) => (
                          <motion.div
                            key={a.id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 10 }}
                            className="flex items-start gap-2 p-2 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-900/10 dark:to-orange-900/10 border border-amber-100 dark:border-amber-900/20 group"
                          >
                            <div className="h-7 w-7 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0 mt-0.5">
                              <Megaphone className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-foreground leading-relaxed">{a.message}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {new Date(a.createdAt).toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', {
                                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                                })}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                              onClick={() => handleDeleteAnnouncement(a.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* ═══ SECTION 9: ADVANCED ANALYTICS (Collapsible) ═══ */}
      <section>
        <Collapsible open={analyticsOpen} onOpenChange={(open) => { setAnalyticsOpen(open); if (open) fetchServiceAnalytics(); }}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center justify-between gap-3 w-full mb-3 group">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                  <BarChart3 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <h2 className="text-base font-bold text-foreground">{t('advancedAnalytics') || 'Advanced Analytics'}</h2>
              </div>
              <motion.div animate={{ rotate: analyticsOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
                <ChevronDown className="h-5 w-5 text-muted-foreground group-hover:text-foreground transition-colors" />
              </motion.div>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3">
            {/* Service Analytics table */}
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-emerald-600" />
                  {t('serviceAnalytics')}
                  <Badge variant="secondary" className="text-[10px] px-1.5">{t('last7Days')}</Badge>
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">{t('serviceAnalyticsDesc')}</p>
              </CardHeader>
              <CardContent className="pt-0">
                {analyticsLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : serviceAnalytics.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 text-center text-muted-foreground">
                    <BarChart3 className="h-8 w-8 text-emerald-400 mb-2" />
                    <p className="text-sm text-muted-foreground">{t('noAnalyticsForPeriod')}</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto custom-scrollbar">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-start py-2.5 px-3 text-xs font-semibold text-muted-foreground">{t('serviceName')}</th>
                          <th className="text-center py-2.5 px-3 text-xs font-semibold text-muted-foreground">{t('avgWaitTimePerService')}</th>
                          <th className="text-center py-2.5 px-3 text-xs font-semibold text-muted-foreground">{t('totalServed')}</th>
                          <th className="text-center py-2.5 px-3 text-xs font-semibold text-muted-foreground">{t('avgRatingPerService')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {serviceAnalytics.map((s, idx) => (
                          <tr key={s.serviceId} className={idx % 2 === 0 ? 'bg-gray-50/50 dark:bg-gray-800/20' : ''}>
                            <td className="py-2.5 px-3 font-medium text-foreground">{getAnalyticsServiceName(s)}</td>
                            <td className="py-2.5 px-3 text-center">
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3 text-amber-500" />
                                <span className="font-semibold text-amber-700 dark:text-amber-400">{s.avgWaitTime ?? 0} {t('min')}</span>
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              <span className="inline-flex items-center gap-1">
                                <Users className="h-3 w-3 text-emerald-500" />
                                <span className="font-semibold">{s.totalServed ?? 0}</span>
                              </span>
                            </td>
                            <td className="py-2.5 px-3 text-center">
                              <span className="inline-flex items-center gap-1">
                                <Star className="h-3 w-3 text-amber-500" />
                                <span className="font-semibold">{(s.avgRating ?? 0) > 0 ? (s.avgRating ?? 0).toFixed(1) : '—'}</span>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* No-Show Analytics */}
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <UserX className="h-4 w-4 text-rose-500" />
                  {t('noShowAnalytics')}
                  <Badge variant="secondary" className="text-[10px] px-1.5">{t('last30Days')}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <NoShowAnalytics agencyId={agencyId} />
              </CardContent>
            </Card>

            {/* Peak Hours Analytics */}
            <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap className="h-4 w-4 text-orange-500" />
                  {t('peakHours')}
                  <Badge variant="secondary" className="text-[10px] px-1.5">{t('last30Days')}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <PeakHoursAnalytics agencyId={agencyId} />
              </CardContent>
            </Card>
          </CollapsibleContent>
        </Collapsible>
      </section>

      {/* ═══ MODALS ═══ */}
      {/* Walk-in Customer Dialog */}
      <Dialog open={walkInOpen} onOpenChange={setWalkInOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-rose-600" />
              {t('addWalkInCustomer')}
            </DialogTitle>
            <DialogDescription>
              {lang === 'ar' ? 'إضافة زائر إلى الطابور بدون حساب' : lang === 'fr' ? 'Ajouter un client à la file sans compte' : 'Add a walk-in customer to the queue without an account'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">{t('walkInCustomerName')}</Label>
              <Input
                value={walkInName}
                onChange={(e) => setWalkInName(e.target.value)}
                placeholder={lang === 'ar' ? 'أدخل اسم الزائر' : lang === 'fr' ? 'Nom du client' : 'Enter customer name'}
                className="h-10 text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">
                {lang === 'ar' ? 'الخدمة (اختياري)' : lang === 'fr' ? 'Service (optionnel)' : 'Service (optional)'}
              </Label>
              <select
                value={walkInServiceId}
                onChange={(e) => setWalkInServiceId(e.target.value)}
                className="h-10 w-full px-3 rounded-lg border border-border bg-background text-sm focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-colors"
              >
                <option value="">{lang === 'ar' ? 'تلقائي' : lang === 'fr' ? 'Automatique' : 'Auto'}</option>
                {serviceStats.map((s) => (
                  <option key={s.id} value={s.id}>
                    {getServiceDisplayName(s)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setWalkInOpen(false)} disabled={walkInLoading} className="rounded-xl">
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button
              onClick={handleAddWalkIn}
              disabled={walkInLoading || !walkInName.trim()}
              className="bg-rose-600 hover:bg-rose-700 text-white font-semibold rounded-xl gap-1.5"
            >
              {walkInLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              {t('addWalkInCustomer')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Code Modal (Dialog version only) */}
      <Dialog open={showQrModal} onOpenChange={setShowQrModal}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-emerald-600" />
              {t('agencyQrCode') || 'Agency QR Code'}
            </DialogTitle>
            <DialogDescription>
              {t('qrCodeDesc') || 'Share this QR code for customers to scan and join your queue'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-4">
            {qrCodeDataUrl ? (
              <div className="p-3 rounded-2xl bg-white shadow-inner border border-gray-100 dark:border-gray-700">
                <img src={qrCodeDataUrl} alt="QR Code" className="h-48 w-48 rounded-xl" />
              </div>
            ) : (
              <div className="h-48 w-48 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}
            {agencyCode && (
              <Badge variant="secondary" className="text-sm font-mono px-4 py-1.5">
                {agencyCode}
              </Badge>
            )}
            <p className="text-xs text-muted-foreground text-center">
              {t('qrCodeScanHint')}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Ticket Confirmation (was imported but never rendered) */}
      <TicketConfirmation
        ticketNumber={ticketConfirmation.ticketNumber}
        customerName={ticketConfirmation.customerName}
        serviceName={ticketConfirmation.serviceName}
        isVisible={ticketConfirmation.visible}
        onClose={() => setTicketConfirmation(prev => ({ ...prev, visible: false }))}
        lang={lang}
        t={t as any}
      />

      {/* Floating Batch Action Bar */}
      <AnimatePresence>
        {batchMode && selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="fixed bottom-20 inset-x-4 z-50 lg:inset-x-auto lg:bottom-6 lg:start-auto lg:end-6 lg:w-80"
          >
            <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-2xl shadow-emerald-500/30">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold truncate">
                  {t('completeSelected')} ({selectedIds.size})
                </p>
                <p className="text-[10px] text-emerald-200">
                  {t('selectTickets')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="bg-white text-emerald-700 hover:bg-emerald-50 font-bold rounded-xl h-9 px-4 text-xs gap-1.5"
                  onClick={handleBatchComplete}
                  disabled={batchLoading}
                >
                  {batchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />}
                  {t('markCompleted')}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 text-white/80 hover:text-white hover:bg-white/20 rounded-xl"
                  onClick={exitBatchMode}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
