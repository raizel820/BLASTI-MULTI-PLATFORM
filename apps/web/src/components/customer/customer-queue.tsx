'use client';

/**
 * Task 79-a — CustomerQueue v2 (Design System v2 rebuild, logic preserved).
 *
 * Structure:
 *   1. Header: title + refresh + live/offline pill + settings (refresh cadence).
 *   2. Offline banner + smart-polling indicator (unchanged behavior).
 *   3. YOUR TURN alert (QueueTurnAlert, confetti + slide-to-confirm).
 *   4. THE active ticket — ONE compact hero card (display number + position +
 *      progress ring + agency/service + ETA + now-serving + actions).
 *   5. Other active reservations — slim expandable rows with the same actions.
 *   6. Past tickets — collapsed disclosure (rate flow kept) + link to history.
 *
 * Everything else (endpoints, polling/backoff, realtime events, sounds,
 * sleep-state, localStorage caches, dialogs, toasts) is byte-for-byte the
 * pre-rebuild logic.
 */

import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { SlideToConfirm } from '@/components/shared/slide-to-confirm';
import { startNotificationSound, stopNotificationSound, playConfirmSound, markReservationConfirmed, isReservationConfirmed } from '@/lib/sounds';
import { enterSleepMode, shouldShowAlert, clearSleep, subscribe, isReactivationDue, markReactivationShown, closeTurnNotifications } from '@/lib/turn-alert-sleep';
import { CustomerQrPass } from '@/components/customer/customer-qr-pass';
import {
  Users,
  Clock,
  TicketCheck,
  Volume2,
  VolumeX,
  XCircle,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ChevronDown,
  Share2,
  QrCode,
  ShieldAlert,
  Star,
  ArrowDown,
  WifiOff,
  Copy,
  Check,
  Settings,
  History,
} from 'lucide-react';
import { WaitTimePredictor } from '@/components/customer/WaitTimePredictor';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { QueueTurnAlert } from '@/components/customer/queue/QueueTurnAlert';
import { QueueProgressRing } from '@/components/customer/queue/QueueProgressRing';
import { QueueRatingDialog } from '@/components/customer/queue/QueueRatingDialog';
import { QueueTimeline } from '@/components/customer/queue/QueueTimeline';
import { QueueEmptyState } from '@/components/customer/queue/QueueEmptyState';

interface Reservation {
  id: string;
  queueNumber: string;
  status: string;
  position: number;
  peopleAhead: number;
  estimatedWait: number;
  etaMin?: number;
  etaMax?: number;
  etaConfidence?: 'high' | 'medium' | 'low';
  currentServingNumber: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  agencyId?: string;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  joinedAt: string;
  reservedDate?: string;
  rating?: number | null;
  skippedForNoShow?: boolean;
  preferredTime?: string;
  fixedTimeEnabled?: boolean;
  postponeCount?: number;
  isWalkIn?: boolean;
  customerName?: string;
}

export function CustomerQueue() {
  const { setView, user } = useAppStore();
  const { t, lang } = useLanguage();
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [showTurnAlert, setShowTurnAlert] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<number>(10000);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [confettiKey, setConfettiKey] = useState(0);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrReservation, setQrReservation] = useState<Reservation | null>(null);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [leaveTargetRes, setLeaveTargetRes] = useState<Reservation | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelResId, setCancelResId] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState<string | null>(null);
  const [userRating, setUserRating] = useState<Record<string, number>>({});
  const [submittingRating, setSubmittingRating] = useState<string | null>(null);
  const [feedbackComment, setFeedbackComment] = useState<Record<string, string>>({});
  const [feedbackSubmittedIds, setFeedbackSubmittedIds] = useState<Set<string>>(new Set());
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);
  const [ratingTargetId, setRatingTargetId] = useState<string | null>(null);
  const [selectedRating, setSelectedRating] = useState(0);
  const prevStatusRef = useRef<Record<string, string>>({});
  const soundStartedRef = useRef(false);
  const turnAlertRef = useRef<HTMLDivElement>(null);
  const [isFastPolling, setIsFastPolling] = useState(false);
  const [postponeDialogOpen, setPostponeDialogOpen] = useState(false);
  const [postponeResId, setPostponeResId] = useState<string | null>(null);
  const [postponePositions, setPostponePositions] = useState(1);
  const [postponeLoading, setPostponeLoading] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const prevPeopleAheadRef = useRef<Record<string, number>>({});
  const connectionStatusWasConnected = useRef(false);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  const realtime = useRealtime();

  // ─── Fetch Reservations (unchanged logic) ─────────────────────────────
  const fetchReservations = useCallback(async () => {
    if (!user?.id) return;
    const previouslyCalledIds = Object.entries(prevStatusRef.current)
      .filter(([, status]) => status === 'CALLED')
      .map(([id]) => id);
    try {
      const res = await apiFetch(`/api/reservations/active?userId=${user.id}`);
      if (res.ok) {
        const data = await res.json();
        const list = (data.reservations ?? []).map((r: Record<string, unknown>) => {
          const agency = r.agency as Record<string, string> | undefined;
          const service = r.service as Record<string, string> | undefined;
          const etaData = r.eta as Record<string, unknown> | undefined;
          return {
            id: r.id,
            queueNumber: r.displayNumber || `${r.queueNumber}`,
            status: r.status,
            position: (r.position as number) || 0,
            peopleAhead: (r.peopleAhead as number) || 0,
            estimatedWait: (r.estimatedWait as number) || (etaData?.estimatedMaxMinutes as number) || 0,
            etaMin: (etaData?.estimatedMinMinutes as number) || (r.estimatedWait as number) || 0,
            etaMax: (etaData?.estimatedMaxMinutes as number) || (r.estimatedWait as number) || 0,
            etaConfidence: (etaData?.confidence as 'high' | 'medium' | 'low') || 'medium',
            currentServingNumber: (r.currentServingNumber as string) || '0',
            agencyId: (r.agencyId as string) || agency?.id || '',
            agencyName: agency?.name || t('defaultAgency'),
            agencyNameAr: agency?.nameAr,
            agencyNameFr: agency?.nameFr,
            serviceName: service?.name || t('defaultService'),
            serviceNameAr: service?.nameAr,
            serviceNameFr: service?.nameFr,
            joinedAt: r.joinedAt,
            reservedDate: (r.reservedDate as string) || undefined,
            rating: (r.rating as number) ?? null,
            skippedForNoShow: (r as Record<string, unknown>).skippedForNoShow === true,
            preferredTime: (r.preferredTime as string) || undefined,
            fixedTimeEnabled: (r.fixedTimeEnabled as boolean) || false,
            postponeCount: (r.postponeCount as number) || 0,
            isWalkIn: (r as Record<string, unknown>).isWalkIn === true,
            customerName: (r as Record<string, unknown>).walkInCustomerName as string || (r as Record<string, unknown>).customerName as string || undefined,
          } as Reservation;
        });

        // Detect position changes
        list.forEach((r: Reservation) => {
          const prev = prevPeopleAheadRef.current[r.id];
          if (prev !== undefined && r.peopleAhead < prev && r.peopleAhead >= 0) {
            toast.success(t('positionUpdated'), {
              duration: 3000,
              icon: <ArrowDown className="h-4 w-4 text-emerald-500" />,
            });
          }
        });
        const currentPeopleAhead: Record<string, number> = {};
        list.forEach((r: Reservation) => { currentPeopleAhead[r.id] = r.peopleAhead; });
        prevPeopleAheadRef.current = currentPeopleAhead;

        // Detect status changes to CALLED
        list.forEach((r: Reservation) => {
          if (prevStatusRef.current[r.id] && prevStatusRef.current[r.id] !== r.status && r.status === 'CALLED') {
            // Task 24: also respect the persisted sleep state — a dismissed alert
            // must not re-trigger (shouldShowAlert reads localStorage)
            if (!soundStartedRef.current && !isReservationConfirmed(r.id) && shouldShowAlert(r.id)) {
              soundStartedRef.current = true;
              if (!soundMuted) {
                startNotificationSound(r.id);
              }
              setShowTurnAlert(true);
              setConfettiKey((k) => k + 1);
              if (typeof window !== 'undefined' && 'Notification' in window) {
                if (Notification.permission === 'default') {
                  Notification.requestPermission();
                }
                if (Notification.permission === 'granted') {
                  new Notification(t('yourTurn'), {
                    body: t('turnNotifBody'),
                    icon: '/logo.png',
                    tag: 'blasti-turn',
                    requireInteraction: true,
                  });
                }
              }
            }
          }
        });

        const currentStatuses: Record<string, string> = {};
        list.forEach((r: Reservation) => { currentStatuses[r.id] = r.status; });
        prevStatusRef.current = currentStatuses;

        setReservations(list);
        setLastUpdated(new Date());

        // Sleep-state cleanup
        if (previouslyCalledIds.length > 0) {
          const stillCalled = list.some(
            (r: Reservation) => r.status === 'CALLED' && previouslyCalledIds.includes(r.id)
          );
          if (!stillCalled) {
            clearSleep();
          }
        }

        // Cache to localStorage
        try {
          localStorage.setItem('blasti_queue_cache', JSON.stringify({ reservations: list, timestamp: Date.now() }));
        } catch { /* ignore */ }

        // Check for unconfirmed CALLED
        // Task 24: shouldShowAlert (persisted sleep state) prevents a dismissed
        // alert from RE-TRIGGERING after a page reload.
        const unconfirmedCalled = list.find((r: Reservation) => r.status === 'CALLED' && !isReservationConfirmed(r.id) && shouldShowAlert(r.id));
        if (unconfirmedCalled && !soundStartedRef.current) {
          soundStartedRef.current = true;
          if (!soundMuted) {
            startNotificationSound(unconfirmedCalled.id);
          }
          setShowTurnAlert(true);
          setConfettiKey((k) => k + 1);
          if (typeof window !== 'undefined' && 'Notification' in window) {
            if (Notification.permission === 'default') {
              Notification.requestPermission();
            }
            if (Notification.permission === 'granted') {
              new Notification(t('yourTurn'), {
                body: t('turnNotifBody'),
                icon: '/logo.png',
                tag: 'blasti-turn',
                requireInteraction: true,
              });
            }
          }
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  }, [user?.id, soundMuted, t]);

  // ─── Load cached state on mount ──────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem('blasti_feedback_submitted');
      if (stored) {
        setFeedbackSubmittedIds(new Set(JSON.parse(stored)));
      }
    } catch { /* ignore */ }
    try {
      const cached = localStorage.getItem('blasti_queue_cache');
      if (cached) {
        const { reservations: cachedList, timestamp } = JSON.parse(cached);
        if (Array.isArray(cachedList) && cachedList.length > 0 && reservations.length === 0) {
          setReservations(cachedList);
          setLastUpdated(new Date(timestamp));
        }
      }
    } catch { /* ignore */ }
  }, []);

  // Cleanup sound on unmount
  useEffect(() => {
    return () => {
      stopNotificationSound();
    };
  }, []);

  // Smart polling
  useEffect(() => {
    const waitingRes = reservations.find((r) => r.status === 'WAITING');
    if (waitingRes && waitingRes.peopleAhead <= 3 && waitingRes.peopleAhead > 0 && refreshInterval > 0) {
      setIsFastPolling(true);
    } else {
      setIsFastPolling(false);
    }
  }, [reservations, refreshInterval]);

  // FIX #18 preserved: auto-refresh with offline backoff
  useEffect(() => {
    fetchReservations();
    if (refreshInterval <= 0) return;

    let failures = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const getInterval = () => {
      if (isBothUnreachable()) return 300_000;
      if (failures >= 3) return 120_000;
      if (failures >= 1) return 60_000;
      return isFastPolling ? 3_000 : refreshInterval;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }
      await fetchReservations();
      if (isApiUnreachable()) {
        failures = Math.min(failures + 1, 10);
      } else {
        failures = 0;
      }
      timer = setTimeout(tick, getInterval());
    };

    timer = setTimeout(tick, getInterval());
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [fetchReservations, refreshInterval, isFastPolling]);

  // ─── Realtime: Join rooms ────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    realtime.joinCustomer(user.id);
    return () => {
      realtime.leaveCustomer(user.id);
    };
  }, [user?.id, realtime]);

  useEffect(() => {
    const agencyIds = new Set(reservations.map(r => r.agencyId).filter(Boolean) as string[]);
    agencyIds.forEach(id => realtime.joinAgency(id));
    return () => {
      agencyIds.forEach(id => realtime.leaveAgency(id));
    };
  }, [reservations, realtime]);

  // ─── Realtime: Event subscriptions ────────────────────────────────────
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    const handleQueueEvent = () => {
      fetchReservations();
    };

    const handleTerminalQueueEvent = () => {
      clearSleep();
      fetchReservations();
    };

    unsubscribers.push(realtime.onQueueCalled(handleQueueEvent));
    unsubscribers.push(realtime.onQueueCompleted(handleTerminalQueueEvent));
    unsubscribers.push(realtime.onQueueNoShow(handleTerminalQueueEvent));
    unsubscribers.push(realtime.onQueueCancelled(handleTerminalQueueEvent));
    unsubscribers.push(realtime.onQueueJoined(handleQueueEvent));
    unsubscribers.push(realtime.onQueueWalkIn(handleQueueEvent));
    unsubscribers.push(realtime.onQueuePaused(handleQueueEvent));
    unsubscribers.push(realtime.onQueueResumed(handleQueueEvent));
    unsubscribers.push(realtime.onQueuePositionChanged(handleQueueEvent));

    unsubscribers.push(realtime.onTurnApproaching(() => {
      fetchReservations();
      toast.info(t('turnApproachingNotif'), {
        description: t('turnApproachingNotifDesc'),
        duration: 6000,
        icon: <Clock className="h-4 w-4 text-amber-500" />,
      });
    }));

    unsubscribers.push(realtime.onYourTurn(() => {
      fetchReservations();
      const calledRes = reservations.find(r => r.status === 'CALLED');
      if (calledRes && !shouldShowAlert(calledRes.id)) return;
      if (!soundStartedRef.current) {
        soundStartedRef.current = true;
        if (!soundMuted) {
          startNotificationSound(calledRes?.id || 'default');
        }
        setShowTurnAlert(true);
        setConfettiKey((k) => k + 1);
        if (typeof window !== 'undefined' && 'Notification' in window) {
          if (Notification.permission === 'default') {
            Notification.requestPermission();
          }
          if (Notification.permission === 'granted') {
            new Notification(t('yourTurn'), {
              body: t('turnNotifBody'),
              icon: '/logo.png',
              tag: 'blasti-turn',
              requireInteraction: true,
            });
          }
        }
      }
    }));

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [realtime, fetchReservations, soundMuted, t, reservations]);

  // Reactivation: re-show alert ONCE when 10-min sleep expires
  useEffect(() => {
    const unsub = subscribe(() => {
      const calledRes = reservations.find(r => r.status === 'CALLED');
      if (!calledRes) return;
      if (isReactivationDue(calledRes.id)) {
        markReactivationShown(calledRes.id);
        soundStartedRef.current = true;
        if (!soundMuted) startNotificationSound(calledRes.id);
        setShowTurnAlert(true);
        setConfettiKey((k) => k + 1);
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(t('yourTurn'), {
            body: t('turnNotifBody'),
            icon: '/logo.png',
            tag: 'blasti-turn',
            requireInteraction: true,
          });
        }
      }
    });
    return unsub;
  }, [reservations, soundMuted, t]);

  // Auto-scroll to turn alert
  useEffect(() => {
    if (showTurnAlert && turnAlertRef.current) {
      turnAlertRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showTurnAlert]);

  // Track reconnecting state
  useEffect(() => {
    if (!realtime.isConnected && connectionStatusWasConnected.current) {
      setIsReconnecting(true);
      const timer = setTimeout(() => setIsReconnecting(false), 8000);
      return () => clearTimeout(timer);
    }
    if (realtime.isConnected) {
      setIsReconnecting(false);
      connectionStatusWasConnected.current = true;
    }
  }, [realtime.isConnected]);

  // Time ago helper
  const getTimeAgo = () => {
    const diff = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
    if (diff < 5) return t('justNow');
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    return `${Math.floor(diff / 3600)}h`;
  };
  const [timeAgo, setTimeAgo] = useState('');
  useEffect(() => {
    setTimeAgo(getTimeAgo());
    const interval = setInterval(() => setTimeAgo(getTimeAgo()), 5000);
    return () => clearInterval(interval);
  }, [lastUpdated, lang]);

  // ─── Handlers (unchanged logic) ──────────────────────────────────────
  const handleConfirmTurn = () => {
    const calledRes = reservations.find(r => r.status === 'CALLED');
    if (calledRes) {
      markReservationConfirmed(calledRes.id);
      enterSleepMode(calledRes.id);
    }
    stopNotificationSound();
    playConfirmSound();
    setShowTurnAlert(false);
    closeTurnNotifications();
    toast.success(t('confirmed'));
  };

  const handleMuteSound = () => {
    setSoundMuted(true);
    stopNotificationSound();
    toast.success(t('notificationSoundOff'));
  };

  const handleUnmuteSound = () => {
    setSoundMuted(false);
    const hasUnconfirmedCalled = reservations.some((r) => r.status === 'CALLED' && !isReservationConfirmed(r.id));
    if (hasUnconfirmedCalled) {
      const calledRes = reservations.find((r) => r.status === 'CALLED' && !isReservationConfirmed(r.id));
      startNotificationSound(calledRes?.id);
    }
    toast.success(t('notificationSoundOn'));
  };

  const handleCancel = async (id: string) => {
    setCancelling(id);
    try {
      const res = await apiFetch(`/api/reservations/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CANCELLED' }),
      });
      if (res.ok) {
        toast.success(t('cancelSuccess'));
        fetchReservations();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCancelling(null);
    }
  };

  const handlePostpone = async () => {
    if (!postponeResId || postponePositions < 1) return;
    setPostponeLoading(true);
    try {
      const res = await apiFetch(`/api/reservations/${postponeResId}/postpone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id, positions: postponePositions }),
      });
      if (res.ok) {
        toast.success(t('postponeSuccess'));
        setPostponeDialogOpen(false);
        setPostponeResId(null);
        setPostponePositions(1);
        fetchReservations();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setPostponeLoading(false);
    }
  };

  const handleToggleFixedTime = async (resId: string, currentEnabled: boolean) => {
    setCancelling(resId);
    try {
      const res = await apiFetch(`/api/reservations/${resId}/toggle-fixed-time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id, fixedTimeEnabled: !currentEnabled }),
      });
      if (res.ok) {
        toast.success(!currentEnabled ? t('fixedTimeOn') : t('fixedTimeOff'));
        fetchReservations();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCancelling(null);
    }
  };

  const handleLeaveQueue = async () => {
    clearSleep();
    setCancelling('leaving');
    try {
      const res = await apiFetch(`/api/reservations/cancel-active?userId=${user?.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        toast.success(t('queueLeft'));
        setLeaveDialogOpen(false);
        stopNotificationSound();
        soundStartedRef.current = false;
        setView('customer-home');
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCancelling(null);
    }
  };

  const handleReclaim = async (id: string) => {
    setCancelling(id);
    try {
      const res = await apiFetch('/api/reservations/reclaim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId: id }),
      });
      if (res.ok) {
        toast.success(t('reclaimSuccess'));
        fetchReservations();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCancelling(null);
    }
  };

  const openRatingDialog = (resId: string) => {
    setRatingTargetId(resId);
    setSelectedRating(0);
    setRatingDialogOpen(true);
  };

  const handleSubmitRating = async (resId: string, rating: number) => {
    setSubmittingRating(resId);
    try {
      const comment = feedbackComment[resId]?.trim() || '';
      const res = await apiFetch(`/api/reservations/${resId}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment, userId: user?.id }),
      });
      if (res.ok) {
        setUserRating((prev) => ({ ...prev, [resId]: rating }));
        setFeedbackSubmittedIds((prev) => {
          const next = new Set(prev);
          next.add(resId);
          try { localStorage.setItem('blasti_feedback_submitted', JSON.stringify([...next])); } catch { /* ignore */ }
          return next;
        });
        setRatingDialogOpen(false);
        setRatingTargetId(null);
        toast.success(t('ratingSubmitted'));
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setSubmittingRating(null);
    }
  };

  const handleDialogSubmitRating = () => {
    if (ratingTargetId && selectedRating >= 1 && selectedRating <= 5) {
      handleSubmitRating(ratingTargetId, selectedRating);
    }
  };

  const handleSharePosition = (res: Reservation) => {
    const agencyName = lang === 'ar' && res.agencyNameAr ? res.agencyNameAr : lang === 'fr' && res.agencyNameFr ? res.agencyNameFr : res.agencyName;
    const serviceName = lang === 'ar' && res.serviceNameAr ? res.serviceNameAr : lang === 'fr' && res.serviceNameFr ? res.serviceNameFr : res.serviceName;
    const shareText = t('queueShareText')
      .replace('{position}', String(res.position))
      .replace('{agency}', agencyName)
      .replace('{service}', serviceName)
      .replace('{number}', res.queueNumber);
    if (navigator.share) {
      navigator.share({ title: 'BLASTI', text: shareText, url: `${window.location.origin}/#ticket-${res.id}` }).catch(() => {});
    } else {
      navigator.clipboard.writeText(shareText + `\n${window.location.origin}/#ticket-${res.id}`).then(() => {
        toast.success(t('copied'));
      }).catch(() => {
        toast.error(t('error'));
      });
    }
  };

  const handleCopyPosition = async (res: Reservation) => {
    const agencyName = lang === 'ar' && res.agencyNameAr ? res.agencyNameAr : lang === 'fr' && res.agencyNameFr ? res.agencyNameFr : res.agencyName;
    const serviceName = lang === 'ar' && res.serviceNameAr ? res.serviceNameAr : lang === 'fr' && res.serviceNameFr ? res.serviceNameFr : res.serviceName;
    const statusText = `${t('yourQueueNumber')}: ${res.queueNumber}\n${t('positionInQueue')}: #${res.position}\n${agencyName} — ${serviceName}\n${t('peopleAhead')}: ${res.peopleAhead}\n${t('estimatedWait')}: ${res.estimatedWait} ${t('minutes')}`;
    try {
      await navigator.clipboard.writeText(statusText);
      setShareCopied(res.id);
      toast.success(t('copied'));
      setTimeout(() => setShareCopied(null), 2000);
    } catch {
      toast.error(t('error'));
    }
  };

  // ─── Computed ─────────────────────────────────────────────────────────
  const activeRes = reservations.find(
    (r) => r.status === 'WAITING' || r.status === 'CALLED' || r.status === 'DEFERRED_OFFLINE'
  );

  const getAgencyName = (r: Reservation) => {
    if (lang === 'ar' && r.agencyNameAr) return r.agencyNameAr;
    if (lang === 'fr' && r.agencyNameFr) return r.agencyNameFr;
    return r.agencyName;
  };

  const getServiceName = (r: Reservation) => {
    if (lang === 'ar' && r.serviceNameAr) return r.serviceNameAr;
    if (lang === 'fr' && r.serviceNameFr) return r.serviceNameFr;
    return r.serviceName;
  };

  // Per-reservation ETA display
  const getEtaDisplay = (res: Reservation): string => {
    const etaMin = res.etaMin || 0;
    const etaMax = res.etaMax || res.estimatedWait || 0;

    if (etaMax <= 0) return t('calculating');

    const min = Math.max(0, etaMin);
    const max = etaMax;

    if (min === max) return `~${max} ${t('minutes')}`;
    if (min > 0) return `~${min}–${max} ${t('minutes')}`;
    return `~${max} ${t('minutes')}`;
  };

  // Progress ring helpers
  const ringRadius = 52;
  const ringCircumference = 2 * Math.PI * ringRadius;

  const getRingProgress = (res: Reservation) =>
    res.peopleAhead <= 0
      ? 100
      : Math.max(5, Math.min(95, 100 - (res.peopleAhead / 20) * 100));

  // Status gradient helper
  const getStatusGradient = (status: string) => {
    switch (status) {
      case 'CALLED': return 'from-emerald-500 to-teal-500';
      case 'WAITING': return 'from-amber-400 to-amber-500';
      case 'DEFERRED_OFFLINE': return 'from-orange-400 to-orange-500';
      case 'COMPLETED': return 'from-gray-400 to-gray-500';
      default: return 'from-gray-300 to-gray-400';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'CALLED': return t('statusCalled');
      case 'WAITING': return t('statusWaiting');
      case 'DEFERRED_OFFLINE': return t('statusDeferredOffline');
      default: return status;
    }
  };

  // ─── Loading State ───────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8 max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-7 w-28 rounded-lg" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-xl" />
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-10 rounded-2xl mb-4" />
        <Skeleton className="h-[300px] rounded-2xl" />
      </div>
    );
  }

  // ─── Empty State ─────────────────────────────────────────────────────
  if (!activeRes && reservations.length === 0) {
    return <QueueEmptyState />;
  }

  const otherActive = reservations.filter(
    (r) => r.id !== activeRes?.id && (r.status === 'WAITING' || r.status === 'CALLED' || r.status === 'DEFERRED_OFFLINE')
  );
  const pastRes = reservations.filter((r) => r.status === 'COMPLETED');

  // ─── Ticket card body (hero + expanded rows share this) ──────────────
  const renderTicketBody = (res: Reservation, isHero: boolean) => {
    const isCalled = res.status === 'CALLED';
    const isDeferredOffline = res.status === 'DEFERRED_OFFLINE';
    const ringProgress = getRingProgress(res);
    const ringDashOffset = ringCircumference - (ringProgress / 100) * ringCircumference;

    return (
      <CardContent className="p-3.5">
        {/* Ring + identity, side by side (compact hero layout) */}
        <div className="flex items-center gap-3 mb-3">
          <QueueProgressRing
            reservation={res}
            isCalled={isCalled}
            ringCircumference={ringCircumference}
            ringRadius={ringRadius}
            ringDashOffset={ringDashOffset}
            compact={isHero}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground truncate">
              {getAgencyName(res)}
            </p>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
              <span className="truncate">{getServiceName(res)}</span>
              {res.reservedDate && (
                <>
                  <span>•</span>
                  <span className="whitespace-nowrap">
                    {new Date(res.reservedDate + 'T00:00:00').toLocaleDateString(
                      lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
                      { month: 'short', day: 'numeric' }
                    )}
                  </span>
                </>
              )}
            </div>
            {(res.customerName || res.isWalkIn) && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium truncate mt-0.5">
                👤 {res.customerName || res.queueNumber}
              </p>
            )}

            {/* Fixed Time Toggle (conditional) */}
            {res.status === 'WAITING' && res.preferredTime && (
              <div className="flex items-center justify-between gap-2 p-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200/50 dark:border-emerald-800/30 mt-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Clock className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 truncate">
                      {res.fixedTimeEnabled ? t('fixedTimeOn') : t('fixedTimeOff')}
                      {res.fixedTimeEnabled && res.preferredTime && (
                        <span className="ms-1 font-normal opacity-70" dir="ltr">{res.preferredTime}</span>
                      )}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] px-2 rounded-lg border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 flex-shrink-0"
                  onClick={() => handleToggleFixedTime(res.id, res.fixedTimeEnabled || false)}
                  disabled={cancelling === res.id}
                >
                  {t('toggleFixedTime')}
                </Button>
              </div>
            )}

            {/* Position progress mini-bar */}
            <div className="mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground">{t('queuePosition')}</span>
                <span className="flex items-center gap-1">
                  <motion.span
                    key={res.position}
                    initial={{ scale: 1.3 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.4 }}
                    className="text-xs font-bold text-foreground"
                  >
                    #{res.position}
                  </motion.span>
                  <span className="text-[10px] text-muted-foreground">/ {res.peopleAhead + res.position}</span>
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{
                    width: `${Math.max(5, Math.min(100, 100 - (res.peopleAhead / Math.max(res.peopleAhead + res.position, 1)) * 100))}%`,
                  }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                  className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-500"
                />
              </div>
            </div>
          </div>
        </div>

        {/* ─ Stats Row: 3 Columns ─ */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          {/* People Ahead */}
          <div className="bg-muted/60 rounded-xl p-2.5 text-center">
            <Users className="h-3.5 w-3.5 mx-auto mb-0.5 text-teal-600 dark:text-teal-400" />
            <p className="text-base font-bold text-teal-700 dark:text-teal-400">{res.peopleAhead}</p>
            <p className="text-[9px] text-muted-foreground">{t('peopleAhead')}</p>
          </div>
          {/* ETA */}
          <div className="bg-amber-50 dark:bg-amber-900/15 rounded-xl p-2.5 text-center">
            <Clock className="h-3.5 w-3.5 mx-auto mb-0.5 text-amber-600 dark:text-amber-400" />
            <p className="text-sm font-bold text-amber-700 dark:text-amber-400">
              {!isCalled ? getEtaDisplay(res) : '—'}
            </p>
            {res.etaConfidence && !isCalled ? (
              <div className={`flex items-center justify-center gap-0.5 mt-0.5 ${
                res.etaConfidence === 'high' ? 'text-emerald-600' : res.etaConfidence === 'medium' ? 'text-amber-600' : 'text-red-600'
              }`}>
                <span className={`h-1 w-1 rounded-full ${
                  res.etaConfidence === 'high' ? 'bg-emerald-500' : res.etaConfidence === 'medium' ? 'bg-amber-500' : 'bg-red-500'
                }`} />
                <span className="text-[8px] font-medium">{t(`confidence${res.etaConfidence.charAt(0).toUpperCase() + res.etaConfidence.slice(1)}` as Parameters<typeof t>[0])}</span>
              </div>
            ) : (
              <p className="text-[9px] text-muted-foreground">{isCalled ? t('statusCalled') : ''}</p>
            )}
          </div>
          {/* Now Serving */}
          <div className="bg-emerald-50 dark:bg-emerald-900/15 rounded-xl p-2.5 text-center">
            <TicketCheck className="h-3.5 w-3.5 mx-auto mb-0.5 text-emerald-600 dark:text-emerald-400" />
            <p className="text-base font-bold text-emerald-700 dark:text-emerald-400">
              {res.currentServingNumber}
            </p>
            <p className="text-[9px] text-muted-foreground">{t('currentServing')}</p>
          </div>
        </div>

        {/* ─ CALLED Prominent Notice ─ */}
        {isCalled && (
          <motion.div
            animate={{ scale: [1, 1.01, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="mb-3"
          >
            <div className="w-full py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-semibold text-xs flex items-center justify-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('statusCalled')} — {getAgencyName(res)}
            </div>
          </motion.div>
        )}

        {/* ─ Action Buttons Row 1: Cancel / Postpone / Leave (WAITING only) ─ */}
        {res.status === 'WAITING' && (
          <div className="flex gap-2 mb-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 text-xs gap-1"
              onClick={() => { setCancelResId(res.id); setCancelDialogOpen(true); }}
              disabled={cancelling === res.id}
            >
              {cancelling === res.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
              {t('cancelReservation')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9 rounded-xl border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-xs gap-1"
              onClick={() => {
                setPostponeResId(res.id);
                setPostponePositions(1);
                setPostponeDialogOpen(true);
              }}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {t('postponeTurn')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="flex-1 h-9 rounded-xl text-xs gap-1 font-semibold"
              onClick={() => { setLeaveTargetRes(res); setLeaveDialogOpen(true); }}
            >
              <XCircle className="h-3.5 w-3.5" />
              {t('leaveQueue')}
            </Button>
          </div>
        )}

        {/* ─ Action Buttons Row 2: Share / Copy / QR pass ─ */}
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 h-9 rounded-xl text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-xs gap-1"
            onClick={() => handleSharePosition(res)}
          >
            <Share2 className="h-3.5 w-3.5" />
            {t('sharePosition')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`flex-1 h-9 rounded-xl text-xs gap-1 ${
              shareCopied === res.id
                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20'
                : 'text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20'
            }`}
            onClick={() => handleCopyPosition(res)}
          >
            {shareCopied === res.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {shareCopied === res.id ? t('copied') : t('copyPosition')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 h-9 rounded-xl text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-xs gap-1"
            onClick={() => {
              setQrReservation(res);
              setQrDialogOpen(true);
            }}
          >
            <QrCode className="h-3.5 w-3.5" />
            {t('shareTicket')}
          </Button>
        </div>

        {/* ─ Skipped Reclaim (conditional) ─ */}
        {res.skippedForNoShow && res.status === 'CALLED' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 space-y-2"
          >
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200/50 dark:border-amber-800/30">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
              <span className="text-xs text-amber-700 dark:text-amber-400">{t('skippedWarning')}</span>
            </div>
            <Button
              className="w-full h-10 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold text-sm gap-2"
              onClick={() => handleReclaim(res.id)}
              disabled={cancelling === res.id}
            >
              {cancelling === res.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
              {t('reclaimPosition')}
            </Button>
          </motion.div>
        )}

        {/* ─ Rating for COMPLETED ─ */}
        {res.status === 'COMPLETED' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3"
          >
            {feedbackSubmittedIds.has(res.id) || res.rating || userRating[res.id] ? (
              <div className="flex items-center justify-center gap-2 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200/50 dark:border-emerald-800/50">
                <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
                <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t('ratingSubmitted')}</span>
                {(res.rating || userRating[res.id]) && (
                  <div className="flex items-center gap-0.5 ms-1">
                    {[1, 2, 3, 4, 5].map((s) => (
                      <Star key={s} className={`h-3 w-3 ${s <= (res.rating || userRating[res.id] || 0) ? 'text-amber-400 fill-amber-400' : 'text-gray-300 dark:text-gray-600'}`} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Button
                className="w-full h-10 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold text-sm gap-2"
                onClick={() => openRatingDialog(res.id)}
              >
                <Star className="h-4 w-4" />
                {t('rateExperience')}
              </Button>
            )}
          </motion.div>
        )}

        {/* ─ Position Timeline (collapsible) ─ */}
        {(res.status === 'WAITING' || res.status === 'CALLED') && (
          <QueueTimeline reservation={res} livePosition={res.position} />
        )}
      </CardContent>
    );
  };

  // ─── Main JSX ────────────────────────────────────────────────────────
  return (
    <div className="px-4 py-3 pb-24 lg:pb-8 max-w-3xl mx-auto">
      {/* Subtle background pulse when waiting */}
      {activeRes && activeRes.status === 'WAITING' && (
        <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
          <motion.div
            animate={{ scale: [1, 1.5, 1], opacity: [0.03, 0.01, 0.03] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
            className="absolute top-1/4 start-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-emerald-400 dark:bg-emerald-600"
          />
        </div>
      )}

      {/* ── 1. Header: Title + Connection + Settings ── */}
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-bold">{t('myQueue')}</h1>
        <div className="flex items-center gap-1.5">
          {/* Manual refresh */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-xl"
            onClick={fetchReservations}
            aria-label={t('refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {/* Connection indicator */}
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${
            realtime.isConnected
              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
              : isReconnecting
                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${
              realtime.isConnected ? 'bg-emerald-500 animate-pulse' : isReconnecting ? 'bg-amber-500 animate-pulse' : 'bg-red-500'
            }`} />
            <span>{realtime.isConnected ? t('live') : isReconnecting ? t('reconnecting') : t('offline')}</span>
          </div>
          {/* Settings gear — contains refresh interval selector */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl" aria-label={t('settings')}>
                <Settings className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3 rounded-2xl space-y-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('updatedAgo')}</p>
                <p className="text-sm font-medium">{timeAgo}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1.5">{t('refreshEvery')}</p>
                <Select value={String(refreshInterval)} onValueChange={(v) => setRefreshInterval(Number(v))}>
                  <SelectTrigger className="h-8 w-full px-2.5 py-0 text-xs rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5000">{t('seconds5')}</SelectItem>
                    <SelectItem value="10000">{t('seconds10')}</SelectItem>
                    <SelectItem value="30000">{t('seconds30')}</SelectItem>
                    <SelectItem value="0">{t('off')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* ── 2. Offline Banner ── */}
      <AnimatePresence>
        {!realtime.isConnected && reservations.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-3"
          >
            <Card className="border-destructive/50 bg-destructive/5 rounded-2xl p-2.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-destructive">{t('offlineBanner')}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {t('lastUpdatedOffline').replace('{time}', lastUpdated.toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { hour: '2-digit', minute: '2-digit' }))}
                  </p>
                </div>
                {isReconnecting && (
                  <span className="text-[10px] text-destructive font-medium flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t('reconnecting')}
                  </span>
                )}
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 3. Smart Polling Indicator ── */}
      <AnimatePresence>
        {isFastPolling && activeRes?.status === 'WAITING' && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30"
          >
            <motion.div
              animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
              className="h-2.5 w-2.5 rounded-full bg-amber-500"
            />
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t('smartPollingActive')}</span>
            <span className="text-[10px] text-amber-600/70 dark:text-amber-400/70">· {t('smartPollingDesc')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 4. YOUR TURN Alert ── */}
      <div ref={turnAlertRef}>
        <AnimatePresence>
          {showTurnAlert && activeRes?.status === 'CALLED' && (
            <QueueTurnAlert
              showTurnAlert={showTurnAlert}
              confettiKey={confettiKey}
              activeRes={activeRes}
              soundMuted={soundMuted}
              agencyName={getAgencyName(activeRes)}
              onConfirm={handleConfirmTurn}
              onMute={handleMuteSound}
              onUnmute={handleUnmuteSound}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ── 5. Wait Time Predictor ── */}
      {activeRes && activeRes.status === 'WAITING' && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="mb-3"
        >
          <WaitTimePredictor
            currentPosition={activeRes.position || activeRes.peopleAhead + 1}
            estimatedWaitMinutes={activeRes.etaMax || activeRes.estimatedWait || 0}
            avgServiceTime={Math.max(1, Math.round((activeRes.estimatedWait || 10) / Math.max(1, activeRes.peopleAhead || 1)))}
            totalWaiting={activeRes.peopleAhead || 0}
            agencyName={getAgencyName(activeRes)}
          />
        </motion.div>
      )}

      {/* ── 6. THE active ticket — ONE compact hero card ── */}
      {activeRes && (
        <motion.div
          key={activeRes.id}
          layout
          initial={{ opacity: 0, scale: 0.98 }}
          animate={activeRes.status === 'CALLED'
            ? { opacity: 1, scale: 1, x: [0, -2, 2, 0] }
            : { opacity: 1, scale: 1 }}
          transition={activeRes.status === 'CALLED'
            ? { duration: 0.5, repeat: Infinity, repeatDelay: 2, ease: 'easeInOut' }
            : { duration: 0.25 }}
        >
          <Card className="overflow-hidden rounded-2xl shadow-sm border-border">
            {/* Slim status strip */}
            <div className={`h-9 bg-gradient-to-r ${getStatusGradient(activeRes.status)} flex items-center px-3.5 gap-2 text-white`}>
              {activeRes.status === 'CALLED' ? (
                <motion.div animate={{ scale: [1, 1.15, 1] }} transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}>
                  <Volume2 className="h-3.5 w-3.5" />
                </motion.div>
              ) : activeRes.status === 'DEFERRED_OFFLINE' ? (
                <WifiOff className="h-3.5 w-3.5" />
              ) : (
                <Clock className="h-3.5 w-3.5" />
              )}
              <Badge variant="secondary" className="bg-white/20 text-white border-0 text-[10px] px-1.5 py-0 h-[18px] hover:bg-white/30">
                {getStatusLabel(activeRes.status)}
              </Badge>
              <span className="text-xs font-medium truncate flex-1">{getAgencyName(activeRes)}</span>
              {activeRes.isWalkIn && (
                <span className="text-[9px] font-semibold bg-white/20 px-1.5 py-0.5 rounded-full flex items-center gap-0.5 flex-shrink-0">
                  {t('walkInBadge')}
                </span>
              )}
            </div>
            {renderTicketBody(activeRes, true)}
          </Card>
        </motion.div>
      )}

      {/* ── 7. Other active reservations — slim expandable rows ── */}
      {otherActive.length > 0 && (
        <div className="mt-4">
          <h2 className="text-sm font-semibold text-foreground mb-2">{t('otherActiveTickets')}</h2>
          <div className="space-y-2">
            {otherActive.map((res) => {
              const expanded = expandedRowId === res.id;
              const isCalled = res.status === 'CALLED';
              return (
                <motion.div key={res.id} layout>
                  <button
                    onClick={() => setExpandedRowId(expanded ? null : res.id)}
                    className={`w-full flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 text-start transition-colors ${
                      isCalled
                        ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50/60 dark:bg-emerald-900/15'
                        : 'border-border bg-white dark:bg-gray-900/80 hover:bg-muted/50'
                    }`}
                    aria-expanded={expanded}
                  >
                    <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
                      isCalled ? 'bg-emerald-500 animate-pulse' : res.status === 'DEFERRED_OFFLINE' ? 'bg-orange-500' : 'bg-amber-500'
                    }`} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold text-foreground truncate">
                        {getAgencyName(res)} · <span className="font-black">{res.queueNumber}</span>
                      </span>
                      <span className="block text-[10px] text-muted-foreground truncate">
                        {getStatusLabel(res.status)} · #{res.position} · {getServiceName(res)}
                      </span>
                    </span>
                    <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${expanded ? 'rotate-180' : ''}`} />
                  </button>
                  <AnimatePresence initial={false}>
                    {expanded && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <Card className="mt-2 overflow-hidden rounded-2xl shadow-sm border-border">
                          <div className={`h-9 bg-gradient-to-r ${getStatusGradient(res.status)} flex items-center px-3.5 gap-2 text-white`}>
                            <Badge variant="secondary" className="bg-white/20 text-white border-0 text-[10px] px-1.5 py-0 h-[18px] hover:bg-white/30">
                              {getStatusLabel(res.status)}
                            </Badge>
                            <span className="text-xs font-medium truncate flex-1">{getAgencyName(res)}</span>
                          </div>
                          {renderTicketBody(res, false)}
                        </Card>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 8. Past tickets — collapsed disclosure (rate flow kept) ── */}
      {(pastRes.length > 0 || reservations.length > 0) && (
        <div className="mt-4">
          <button
            onClick={() => setShowPast(!showPast)}
            className="w-full flex items-center gap-2.5 rounded-2xl border border-border bg-muted/40 dark:bg-gray-900/60 px-3.5 py-2.5 text-start hover:bg-muted/70 transition-colors"
            aria-expanded={showPast}
          >
            <History className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <span className="flex-1 text-[13px] font-semibold text-foreground">
              {t('pastTickets')}
              {pastRes.length > 0 && (
                <Badge variant="secondary" className="ms-2 text-[10px] px-1.5 py-0 h-4">{pastRes.length}</Badge>
              )}
            </span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${showPast ? 'rotate-180' : ''}`} />
          </button>

          <AnimatePresence initial={false}>
            {showPast && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="mt-2 space-y-2">
                  {pastRes.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1 py-2">{t('noDataYet')}</p>
                  ) : (
                    pastRes.map((res) => (
                      <div
                        key={res.id}
                        className="flex items-center gap-2.5 rounded-2xl border border-border bg-white dark:bg-gray-900/80 px-3.5 py-2.5"
                      >
                        <span className="h-8 w-8 rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
                          <TicketCheck className="h-4 w-4 text-muted-foreground" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[13px] font-semibold text-foreground truncate">
                            {getAgencyName(res)} · {res.queueNumber}
                          </span>
                          <span className="block text-[10px] text-muted-foreground truncate">
                            {getServiceName(res)}
                            {res.reservedDate && (
                              <> · {new Date(res.reservedDate + 'T00:00:00').toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { month: 'short', day: 'numeric' })}</>
                            )}
                          </span>
                        </span>
                        {feedbackSubmittedIds.has(res.id) || res.rating ? (
                          <span className="flex items-center gap-0.5 flex-shrink-0">
                            {[1, 2, 3, 4, 5].map((s) => (
                              <Star key={s} className={`h-3 w-3 ${s <= (res.rating || 0) ? 'text-amber-400 fill-amber-400' : 'text-gray-300 dark:text-gray-600'}`} />
                            ))}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-[11px] gap-1 rounded-xl border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 flex-shrink-0"
                            onClick={() => openRatingDialog(res.id)}
                          >
                            <Star className="h-3 w-3" />
                            {t('rateExperience')}
                          </Button>
                        )}
                      </div>
                    ))
                  )}

                  {/* Full history lives in the dedicated history view */}
                  <button
                    onClick={() => setView('customer-history')}
                    className="w-full flex items-center justify-center gap-1 rounded-2xl border border-dashed border-border px-3.5 py-2.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors"
                  >
                    {t('viewAllHistory')}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ── 9. QR Pass Dialog ── */}
      {qrReservation && (
        <CustomerQrPass
          open={qrDialogOpen}
          onOpenChange={setQrDialogOpen}
          reservationId={qrReservation.id}
          displayNumber={qrReservation.queueNumber}
          agencyName={qrReservation.agencyName}
          agencyNameAr={qrReservation.agencyNameAr}
          agencyNameFr={qrReservation.agencyNameFr}
          serviceName={qrReservation.serviceName}
          serviceNameAr={qrReservation.serviceNameAr}
          serviceNameFr={qrReservation.serviceNameFr}
          position={qrReservation.position}
          status={qrReservation.status}
        />
      )}

      {/* ── 10. Leave Queue Confirmation (SlideToConfirm) ── */}
      <AlertDialog open={leaveDialogOpen} onOpenChange={setLeaveDialogOpen}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-rose-600">
              <XCircle className="h-5 w-5" />
              {t('leaveQueueConfirm')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t('leaveQueueWarning')}
                </p>
                {leaveTargetRes && (
                  <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/30">
                    <p className="text-xs font-semibold text-rose-700 dark:text-rose-400 mb-1.5">{t('yourJourney')}:</p>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-rose-400 flex-shrink-0" />
                        {t('yourQueueNumber')}: <span className="font-bold">{leaveTargetRes.queueNumber}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-rose-400 flex-shrink-0" />
                        {t('positionLabel')}: <span className="font-bold">#{leaveTargetRes.position}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-rose-400 flex-shrink-0" />
                        {t('peopleAhead')}: <span className="font-bold">{leaveTargetRes.peopleAhead}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-rose-400 flex-shrink-0" />
                        {t('estimatedWait')}: <span className="font-bold">{leaveTargetRes.estimatedWait} {t('minutes')}</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-rose-500/70 dark:text-rose-400/50 mt-2 italic">
                      {t('leaveQueueIrreversible')}
                    </p>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-3 sm:flex-row">
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <div className="flex-1">
              <SlideToConfirm
                onConfirm={handleLeaveQueue}
                label={t('slideToLeave')}
              />
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── 11. Cancel Reservation Confirmation ── */}
      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <XCircle className="h-5 w-5" />
              {t('cancelReservation')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('cancelReservationDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white shadow-xs hover:bg-destructive/90"
              onClick={() => {
                if (cancelResId) {
                  handleCancel(cancelResId);
                }
                setCancelDialogOpen(false);
              }}
              disabled={cancelling === cancelResId}
            >
              {cancelling === cancelResId ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('cancelling')}
                </span>
              ) : (
                t('cancelReservation')
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── 12. Postpone Turn Dialog ── */}
      <Dialog open={postponeDialogOpen} onOpenChange={setPostponeDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowDown className="h-5 w-5 text-amber-600" />
              {t('postponeTurn')}
            </DialogTitle>
            <DialogDescription>
              {t('postponeLimit')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-3">
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t('postponeBy')}</Label>
              <div className="flex items-center gap-2 flex-wrap">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    onClick={() => setPostponePositions(n)}
                    className={`h-9 w-9 rounded-xl text-sm font-semibold transition-all duration-200 ${
                      postponePositions === n
                        ? 'bg-amber-500 text-white shadow-md shadow-amber-500/30 scale-110'
                        : 'bg-gray-100 dark:bg-gray-800 text-muted-foreground hover:bg-amber-100 dark:hover:bg-amber-900/20 hover:text-amber-600'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('postponePositions')}: <span className="font-semibold text-amber-600">{postponePositions}</span>
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setPostponeDialogOpen(false)} disabled={postponeLoading} className="rounded-xl">
              {t('cancel')}
            </Button>
            <Button
              onClick={handlePostpone}
              disabled={postponeLoading}
              className="bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl gap-1.5"
            >
              {postponeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}
              {t('postponeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 13. Rating Dialog (modular component) ── */}
      <QueueRatingDialog
        open={ratingDialogOpen}
        onOpenChange={setRatingDialogOpen}
        ratingTargetId={ratingTargetId}
        selectedRating={selectedRating}
        onRatingSelect={setSelectedRating}
        feedbackComment={ratingTargetId ? (feedbackComment[ratingTargetId] || '') : ''}
        onFeedbackChange={(comment: string) => {
          if (ratingTargetId) {
            setFeedbackComment(prev => ({ ...prev, [ratingTargetId]: comment }));
          }
        }}
        onSubmit={handleDialogSubmitRating}
        submitting={submittingRating === ratingTargetId}
      />
    </div>
  );
}
