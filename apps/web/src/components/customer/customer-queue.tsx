'use client';

/**
 * Customer queue list — SIMPLIFIED (customer UX simplification round).
 *
 * The old screen was a design-system showcase: a hero ticket with a progress
 * ring, an expandable-rows section, a wait-time predictor card, a position
 * timeline, gradient status strips, a pulsing background, share/copy/QR
 * action rows and a second destructive "leave queue" flow. All of that is
 * gone.
 *
 * What the screen is now — one plain CARD PER ACTIVE RESERVATION:
 *   · agency name (+ service, reserved date, preferred time)
 *   · ticket number (big)
 *   · time remaining (~min, from the same ETA payload)
 *   · basic queue facts (position, people ahead, now serving)
 *   · buttons: Postpone + Cancel (WAITING only)
 * A CALLED ticket keeps a highlighted card + the "go to counter" line, and
 * the YOUR TURN alert (sound + slide-to-confirm) is unchanged — that is
 * function, not decoration.
 *
 * Logic below the render is byte-for-byte the pre-simplification engine:
 * smart polling with offline backoff, realtime subscriptions, turn-alert
 * sleep state, localStorage caches, cancel/postpone/rate endpoints, queue
 * event logs.
 */

import { apiFetch } from '@/lib/api-fetch';
// 0.6.16 — revalidate the active ticket when the app resumes to the foreground
// (close-and-reopen resumes the WebView without a remount; the socket may
// have silently died while suspended → the ticket looked frozen until a
// manual refresh; see lib/resume-refresh.ts).
import { useResumeRefresh } from '@/lib/resume-refresh';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';
import { logQueue } from '@/lib/remote-logger';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { debounceTrailing } from '@/lib/debounce';
// Hotfix 0.6.12 — per-category terminology scope (see original note below):
// this import was missing once and the hook call threw a runtime
// ReferenceError that crashed the whole queue page. Every consumer imports
// it explicitly.
import { useCategoryTermScope } from '@/hooks/use-category-terms';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { startNotificationSound, stopNotificationSound, playConfirmSound, markReservationConfirmed, isReservationConfirmed } from '@/lib/sounds';
import { enterSleepMode, shouldShowAlert, clearSleep, subscribe, isReactivationDue, markReactivationShown, closeTurnNotifications } from '@/lib/turn-alert-sleep';
import {
  Users,
  Clock,
  TicketCheck,
  XCircle,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ShieldAlert,
  Star,
  ArrowDown,
  MapPin,
  History,
} from 'lucide-react';
import { toast } from 'sonner';
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
import { QueueTurnAlert } from '@/components/customer/queue/QueueTurnAlert';
import { QueueRatingDialog } from '@/components/customer/queue/QueueRatingDialog';
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
  // Task 5-b — parent agency category (raw payload field; drives the
  // per-category terminology scope below).
  agencyCategory?: string;
  // r21-8 — counter pointer for CALLED tickets (queue:called /
  // notification:your-turn payloads carry counter: { id, name, number }).
  counterName?: string;
  counterNumber?: number;
}

export function CustomerQueue() {
  const { setView, user } = useAppStore();
  const { t, lang } = useLanguage();
  const [reservations, setReservations] = useState<Reservation[]>([]);

  // Task 5-b — per-category terminology scope. The active-reservations
  // payload includes agency.category; the scope follows the MOST RECENT
  // active ticket's category (single scope per screen — mixed-category
  // tickets resolve to the newest one). Falsy until reservations load; a
  // failed terms fetch degrades silently to the standard dictionary.
  const queueAgencyCategory = reservations.find((r) => r.agencyCategory)?.agencyCategory ?? null;
  useCategoryTermScope(queueAgencyCategory);

  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [showTurnAlert, setShowTurnAlert] = useState(false);
  const [soundMuted, setSoundMuted] = useState(false);
  const [refreshInterval] = useState<number>(10000);
  // 0.6.16 — resume revalidation nonce (see lib/resume-refresh.ts).
  const [resumeNonce, setResumeNonce] = useState(0);
  useResumeRefresh(() => setResumeNonce((n) => n + 1));
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [confettiKey, setConfettiKey] = useState(0);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelResId, setCancelResId] = useState<string | null>(null);
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
  const [showPast, setShowPast] = useState(false);
  // r21-8 — counter hints learned from realtime events (queue:called /
  // notification:your-turn carry counter { id, name, number }): keyed by
  // reservationId, merged with any counter fields on the fetched rows.
  const [calledCounterHints, setCalledCounterHints] = useState<Record<string, string>>({});

  const realtime = useRealtime();

  // 0.6.127 — mirror of `reservations` for event handlers. The subscription
  // and room-join effects used to depend on the `reservations` ARRAY ITSELF:
  // every fetch produced a new array → all ~12 socket subscriptions were
  // torn down and re-registered and every agency room was left/re-joined on
  // EVERY fetch (and events landing inside the teardown window were
  // silently dropped). Handlers now read the ref; the effects depend on a
  // stable derived key instead.
  const reservationsRef = useRef<Reservation[]>([]);
  useEffect(() => { reservationsRef.current = reservations; }, [reservations]);

  // ─── Fetch Reservations (unchanged logic) ─────────────────────────────
  const fetchReservations = useCallback(async () => {
    if (!user?.id) return;
    const previouslyCalledIds = Object.entries(prevStatusRef.current)
      .filter(([, status]) => status === 'CALLED')
      .map(([id]) => id);
    try {
      // 0.6.126 — cacheTtl 0: the customer's live queue cards must move the
      // moment a ticket is called/completed (realtime handlers refetch here);
      // the 30s GET-cache fresh window was exactly the reported staleness.
      const res = await apiFetch(`/api/reservations/active?userId=${user.id}`, { cacheTtl: 0 });
      if (res.ok) {
        const data = await res.json();
        const list = (data.reservations ?? []).map((r: Record<string, unknown>) => {
          const agency = r.agency as Record<string, string> | undefined;
          const service = r.service as Record<string, string> | undefined;
          const etaData = r.eta as Record<string, unknown> | undefined;
          const counter = r.counter as { name?: string; number?: number } | null | undefined;
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
            agencyCategory: typeof agency?.category === 'string' ? agency.category : undefined,
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
            // r21-8 — counter pointer when the payload carries one (the CALLED
            // card shows "head to counter: X").
            counterName: counter?.name || undefined,
            counterNumber: typeof counter?.number === 'number' ? counter.number : undefined,
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
      // 0.6.127 — fast-poll ONLY while realtime is down: the 3s per-customer
      // poll used to run even with the socket connected, amplifying load
      // (venue NAT shares one rate-limit bucket) for data events already
      // deliver instantly. Socket up → events + the 10s reconciliation tick;
      // socket down → fast-poll resumes.
      return (isFastPolling && !realtime.isConnected) ? 3_000 : refreshInterval;
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
    // resumeNonce — 0.6.16: a resume remounts the poller → immediate fresh
    // fetch instead of waiting out the backoff interval.
  }, [fetchReservations, refreshInterval, isFastPolling, resumeNonce]);

  // ─── Realtime: Join rooms ────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    realtime.joinCustomer(user.id);
    return () => {
      realtime.leaveCustomer(user.id);
    };
  }, [user?.id, realtime]);

  useEffect(() => {
    // 0.6.127 — stable join key: the room set only changes when the customer
    // actually books with a DIFFERENT agency — not on every fetch tick.
    const agencyIdsKey = Array.from(new Set(reservations.map(r => r.agencyId).filter(Boolean) as string[])).sort().join(',');
    const ids = agencyIdsKey ? agencyIdsKey.split(',').filter(Boolean) : [];
    ids.forEach(id => realtime.joinAgency(id));
    return () => {
      ids.forEach(id => realtime.leaveAgency(id));
    };
  }, [reservations, realtime]);

  // ─── Realtime: Event subscriptions ────────────────────────────────────
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // 0.6.127 — trailing-debounced event fetch: a staff call-next emits 2-3
    // queue events; without the debounce each one was an immediate full
    // refetch (phones behind venue NAT share one rate-limit bucket).
    const fetchOnEvent = debounceTrailing(() => { void fetchReservations(); }, 300);

    const handleQueueEvent = () => {
      fetchOnEvent();
    };

    const handleTerminalQueueEvent = () => {
      clearSleep();
      fetchOnEvent();
    };

    // r21-8 — learn the counter pointer from the event payloads (the ticket
    // card then renders "head to counter: X" once the ticket is CALLED).
    const learnCounterHint = (event: unknown) => {
      const d = ((event as { data?: Record<string, unknown> })?.data
        ?? (event as unknown as Record<string, unknown>)) as Record<string, unknown>;
      const resId = d.reservationId || d.id;
      const counter = d.counter as { name?: string; number?: number } | null | undefined;
      if (!resId || !counter) return;
      const label = counter.name || (counter.number != null ? `#${counter.number}` : '');
      if (!label) return;
      setCalledCounterHints((prev) => ({ ...prev, [String(resId)]: label }));
    };

    unsubscribers.push(realtime.onQueueCalled((event: unknown) => {
      learnCounterHint(event);
      fetchOnEvent();
    }));
    unsubscribers.push(realtime.onQueueCompleted(handleTerminalQueueEvent));
    unsubscribers.push(realtime.onQueueNoShow(handleTerminalQueueEvent));
    unsubscribers.push(realtime.onQueueCancelled(handleTerminalQueueEvent));
    unsubscribers.push(realtime.onQueueJoined(handleQueueEvent));
    unsubscribers.push(realtime.onQueueWalkIn(handleQueueEvent));
    unsubscribers.push(realtime.onQueuePaused(handleQueueEvent));
    unsubscribers.push(realtime.onQueueResumed(handleQueueEvent));
    unsubscribers.push(realtime.onQueuePositionChanged(handleQueueEvent));

    unsubscribers.push(realtime.onTurnApproaching((event: unknown) => {
      fetchOnEvent();
      toast.info(t('turnApproachingNotif'), {
        description: t('turnApproachingNotifDesc'),
        duration: 6000,
        icon: <Clock className="h-4 w-4 text-amber-500" />,
      });
      // Field report: "cooling turn notification is no longer showing in lock
      // screen" — the approaching alert was an in-app toast ONLY. Fire the
      // SAME dedicated native lock-screen notification the turn-call uses
      // (high-importance PUBLIC channel, Stop action button + swipe-to-stop
      // via the dismiss receiver), gated by the turn_approaching preference.
      const data = (event as { data?: Record<string, unknown> })?.data
        ?? (event as Record<string, unknown> | null);
      const ticket = (data?.ticketNumber as string) || (data?.displayNumber as string) || '';
      const agency = (data?.agencyName as string) || '';
      const ahead = typeof data?.peopleAhead === 'number' ? data.peopleAhead : null;
      const body =
        `Ticket ${ticket || '---'}${agency ? ` at ${agency}` : ''}` +
        (ahead === null ? '' : ahead === 0 ? ' — You are next!' : ` — ~${ahead} ahead of you`);
      import('@/lib/notification-channel')
        .then(({ scheduleTurnNotification }) =>
          scheduleTurnNotification(
            'دورك يقترب! / Your Turn is Approaching!',
            body,
            ticket,
            undefined,
            'approaching',
          ),
        )
        .catch(() => { /* notification must never break the queue view */ });
    }));

    unsubscribers.push(realtime.onYourTurn((event: unknown) => {
      learnCounterHint(event);
      fetchOnEvent();
      const calledRes = reservationsRef.current.find(r => r.status === 'CALLED');
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
      fetchOnEvent.cancel();
      unsubscribers.forEach(unsub => unsub());
    };
  }, [realtime, fetchReservations, soundMuted, t]);

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
    // Queue event data — the reservation row (agencyId etc.) comes from the
    // already-loaded list; omitted when not found (ids are never fabricated).
    const target = reservations.find((r) => r.id === id);
    setCancelling(id);
    try {
      const res = await apiFetch(`/api/reservations/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'CANCELLED' }),
      });
      if (res.ok) {
        // Queue event log — customer self-cancelled the ticket.
        try { logQueue('ticket_cancelled', 'Customer cancelled the ticket', { agencyId: target?.agencyId || undefined, ticketId: id, ticketNumber: target?.queueNumber || undefined, status: 'CANCELLED', source: 'online' }); } catch { /* never block */ }
        toast.success(t('cancelSuccess'));
        fetchReservations();
      } else {
        const data = await res.json();
        // Queue event log — self-cancel failed (endpoint error included).
        try { logQueue('ticket_cancelled', `Self-cancel failed: ${data?.error || 'rejected'}`, { agencyId: target?.agencyId || undefined, ticketId: id }, 'error'); } catch { /* never block */ }
        toast.error(data.error || t('error'));
      }
    } catch {
      // Queue event log — self-cancel network failure.
      try { logQueue('ticket_cancelled', 'Self-cancel failed — network error', { agencyId: target?.agencyId || undefined, ticketId: id }, 'error'); } catch { /* never block */ }
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
        // Queue event log — ticket postponed by the customer.
        try {
          const target = reservations.find((r) => r.id === postponeResId);
          logQueue('ticket_postponed', `Ticket postponed by ${postponePositions} position(s)`, {
            agencyId: target?.agencyId || undefined,
            ticketId: postponeResId,
            ticketNumber: target?.queueNumber || undefined,
            positions: postponePositions,
          });
        } catch { /* never block */ }
        toast.success(t('postponeSuccess'));
        setPostponeDialogOpen(false);
        setPostponeResId(null);
        setPostponePositions(1);
        fetchReservations();
      } else {
        const data = await res.json();
        // Queue event log — postpone failed (endpoint error included).
        try { logQueue('ticket_postponed', `Postpone failed: ${data?.error || 'rejected'}`, { ticketId: postponeResId, positions: postponePositions }, 'error'); } catch { /* never block */ }
        toast.error(data.error || t('error'));
      }
    } catch {
      // Queue event log — postpone network failure.
      try { logQueue('ticket_postponed', 'Postpone failed — network error', { ticketId: postponeResId, positions: postponePositions }, 'error'); } catch { /* never block */ }
      toast.error(t('error'));
    } finally {
      setPostponeLoading(false);
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
        // Queue event log — customer reclaimed a ticket from history.
        try {
          const target = reservations.find((r) => r.id === id);
          logQueue('ticket_reclaimed', 'Customer reclaimed the ticket', {
            agencyId: target?.agencyId || undefined,
            ticketId: id,
            ticketNumber: target?.queueNumber || undefined,
          });
        } catch { /* never block */ }
        toast.success(t('reclaimSuccess'));
        fetchReservations();
      } else {
        const data = await res.json();
        // Queue event log — reclaim failed (endpoint error included).
        try { logQueue('ticket_reclaimed', `Reclaim failed: ${data?.error || 'rejected'}`, { ticketId: id }, 'error'); } catch { /* never block */ }
        toast.error(data.error || t('error'));
      }
    } catch {
      // Queue event log — reclaim network failure.
      try { logQueue('ticket_reclaimed', 'Reclaim failed — network error', { ticketId: id }, 'error'); } catch { /* never block */ }
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
        // Queue event log — customer rated the ticket.
        try {
          const target = reservations.find((r) => r.id === resId);
          logQueue('ticket_rated', `Ticket rated ${rating}/5`, {
            agencyId: target?.agencyId || undefined,
            ticketId: resId,
            ticketNumber: target?.queueNumber || undefined,
            rating,
          });
        } catch { /* never block */ }
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
        // Queue event log — rating failed (endpoint error included).
        try { logQueue('ticket_rated', `Rating failed: ${data?.error || 'rejected'}`, { ticketId: resId, rating }, 'error'); } catch { /* never block */ }
        toast.error(data.error || t('error'));
      }
    } catch {
      // Queue event log — rating network failure.
      try { logQueue('ticket_rated', 'Rating failed — network error', { ticketId: resId, rating }, 'error'); } catch { /* never block */ }
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

  // ─── Computed ─────────────────────────────────────────────────────────
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

  // Time remaining display ("time remaining" is the ONLY wait metric the
  // simplified card shows — min–max range when the ETA payload has both).
  const getTimeRemaining = (res: Reservation): string => {
    const etaMin = res.etaMin || 0;
    const etaMax = res.etaMax || res.estimatedWait || 0;

    if (etaMax <= 0) return t('calculating');

    const min = Math.max(0, etaMin);
    const max = etaMax;

    if (min === max) return `~${max} ${t('minutes')}`;
    if (min > 0) return `~${min}–${max} ${t('minutes')}`;
    return `~${max} ${t('minutes')}`;
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'CALLED': return t('statusCalled');
      case 'WAITING': return t('statusWaiting');
      case 'DEFERRED_OFFLINE': return t('statusDeferredOffline');
      default: return status;
    }
  };

  // Every active ticket is a card — CALLED first, then by position.
  const statusRank = (s: string) => (s === 'CALLED' ? 0 : s === 'DEFERRED_OFFLINE' ? 2 : 1);
  const activeList = reservations
    .filter((r) => r.status === 'WAITING' || r.status === 'CALLED' || r.status === 'DEFERRED_OFFLINE')
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || (a.position || 9999) - (b.position || 9999));
  const calledRes = reservations.find(r => r.status === 'CALLED');
  const pastRes = reservations.filter((r) => r.status === 'COMPLETED');

  // ─── Loading State ───────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="px-4 py-3 pb-24 lg:pb-8 max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-7 w-28 rounded-lg" />
          <Skeleton className="h-8 w-8 rounded-xl" />
        </div>
        <Skeleton className="h-36 rounded-xl mb-3" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    );
  }

  // ─── Empty State ─────────────────────────────────────────────────────
  if (activeList.length === 0 && reservations.length === 0) {
    return <QueueEmptyState />;
  }

  // ─── Main JSX ────────────────────────────────────────────────────────
  return (
    <div className="px-4 py-3 pb-24 lg:pb-8 max-w-2xl mx-auto">
      {/* ── 1. Header: Title + Refresh + Connection pill ── */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-bold">{t('myQueue')}</h1>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${
            realtime.isConnected
              ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
              : isReconnecting
                ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
                : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${
              realtime.isConnected ? 'bg-emerald-500' : isReconnecting ? 'bg-amber-500 animate-pulse' : 'bg-red-500'
            }`} />
            <span>{realtime.isConnected ? t('live') : isReconnecting ? t('reconnecting') : t('offline')}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-xl"
            onClick={fetchReservations}
            aria-label={t('refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── 2. Offline notice (only when tickets exist) ── */}
      {!realtime.isConnected && reservations.length > 0 && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800/30">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-700 dark:text-red-400">
            {t('lastUpdatedOffline').replace('{time}', lastUpdated.toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { hour: '2-digit', minute: '2-digit' }))}
          </p>
        </div>
      )}

      {/* ── 3. YOUR TURN alert (unchanged — function, not decoration) ── */}
      <div ref={turnAlertRef}>
        {showTurnAlert && calledRes && (
          <QueueTurnAlert
            showTurnAlert={showTurnAlert}
            confettiKey={confettiKey}
            activeRes={{
              ...calledRes,
              // r21-8 — surface the realtime-learned counter hint to the alert.
              counterName: calledRes.counterName || calledCounterHints[calledRes.id],
            }}
            soundMuted={soundMuted}
            agencyName={getAgencyName(calledRes)}
            onConfirm={handleConfirmTurn}
            onMute={handleMuteSound}
            onUnmute={handleUnmuteSound}
          />
        )}
      </div>

      {/* ── 4. ONE SIMPLE CARD PER RESERVATION ── */}
      <div className="space-y-3">
        {activeList.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">{t('noActiveReservations')}</p>
        )}
        {activeList.map((res) => {
          const isCalled = res.status === 'CALLED';
          const counterHint = res.counterName || calledCounterHints[res.id];
          return (
            <div
              key={res.id}
              className={`rounded-xl border bg-card p-4 ${
                isCalled
                  ? 'border-emerald-400 dark:border-emerald-600 ring-1 ring-emerald-200 dark:ring-emerald-800'
                  : 'border-border'
              }`}
            >
              {/* Agency + status */}
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{getAgencyName(res)}</p>
                  <p className="text-xs text-muted-foreground truncate">{getServiceName(res)}</p>
                </div>
                <Badge
                  variant="outline"
                  className={`flex-shrink-0 text-[10px] ${
                    isCalled
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                      : res.status === 'DEFERRED_OFFLINE'
                        ? 'bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                  }`}
                >
                  {getStatusLabel(res.status)}
                </Badge>
              </div>

              {/* Ticket number + time remaining + position */}
              <div className="flex items-center gap-5 mb-2">
                <div className="min-w-[72px]">
                  <p className="text-3xl font-black tracking-tight text-foreground leading-none">{res.queueNumber}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{t('yourQueueNumber')}</p>
                </div>
                {!isCalled && (
                  <div className="min-w-[72px]">
                    <p className="text-sm font-semibold text-foreground leading-none mt-0.5">{getTimeRemaining(res)}</p>
                    <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {t('timeRemaining')}
                    </p>
                  </div>
                )}
                <div className="min-w-[72px]">
                  <p className="text-sm font-semibold text-foreground leading-none mt-0.5 flex items-center gap-1">
                    <Users className="h-3.5 w-3.5 text-muted-foreground" />
                    #{res.position}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-1.5">{res.peopleAhead} {t('peopleAhead')}</p>
                </div>
              </div>

              {/* Basic info line: now serving / reserved date / preferred time */}
              {(res.currentServingNumber && res.currentServingNumber !== '0') && (
                <p className="text-xs text-muted-foreground">
                  {t('currentServing')}: <span className="font-semibold text-foreground">{res.currentServingNumber}</span>
                </p>
              )}
              {res.reservedDate && (
                <p className="text-xs text-muted-foreground">
                  {new Date(res.reservedDate + 'T00:00:00').toLocaleDateString(
                    lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
                    { month: 'short', day: 'numeric' }
                  )}
                </p>
              )}
              {res.preferredTime && (
                <p className="text-xs text-muted-foreground" dir="ltr">
                  {res.fixedTimeEnabled ? t('fixedTimeOn') : t('fixedTimeOff')} · {res.preferredTime}
                </p>
              )}

              {/* CALLED: go to counter */}
              {isCalled && (
                <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40">
                  <AlertTriangle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                    {t('statusCalled')} — {getAgencyName(res)}
                  </p>
                </div>
              )}
              {isCalled && counterHint && (
                <div className="mt-1.5 flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
                  <MapPin className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                    {t('goCounterName', { name: counterHint })}
                  </p>
                </div>
              )}

              {/* Skipped: warning + reclaim */}
              {res.skippedForNoShow && isCalled && (
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200/50 dark:border-amber-800/30">
                    <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                    <span className="text-xs text-amber-700 dark:text-amber-400">{t('skippedWarning')}</span>
                  </div>
                  <Button
                    className="w-full h-10 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-sm gap-2"
                    onClick={() => handleReclaim(res.id)}
                    disabled={cancelling === res.id}
                  >
                    {cancelling === res.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
                    {t('reclaimPosition')}
                  </Button>
                </div>
              )}

              {/* Actions: Postpone + Cancel (WAITING only) */}
              {res.status === 'WAITING' && (
                <div className="flex gap-2 mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-10 rounded-xl border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 text-xs gap-1"
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
                    variant="outline"
                    size="sm"
                    className="flex-1 h-10 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 text-xs gap-1"
                    onClick={() => { setCancelResId(res.id); setCancelDialogOpen(true); }}
                    disabled={cancelling === res.id}
                  >
                    {cancelling === res.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                    {t('cancelReservation')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 5. Past tickets — collapsed disclosure (rate flow kept) ── */}
      {reservations.length > 0 && (
        <div className="mt-5">
          <button
            onClick={() => setShowPast(!showPast)}
            className="w-full flex items-center gap-2.5 rounded-xl border border-border bg-muted/40 dark:bg-gray-900/60 px-3.5 py-2.5 text-start hover:bg-muted/70 transition-colors"
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

          {showPast && (
            <div className="mt-2 space-y-2">
              {pastRes.length === 0 ? (
                <p className="text-xs text-muted-foreground px-1 py-2">{t('noDataYet')}</p>
              ) : (
                pastRes.map((res) => (
                  <div
                    key={res.id}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-2.5"
                  >
                    <span className="h-8 w-8 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
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
                        className="h-8 text-[11px] gap-1 rounded-lg border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 flex-shrink-0"
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
                className="w-full flex items-center justify-center gap-1 rounded-xl border border-dashed border-border px-3.5 py-2.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors"
              >
                {t('viewAllHistory')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 6. Cancel Reservation Confirmation ── */}
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

      {/* ── 7. Postpone Turn Dialog ── */}
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

      {/* ── 8. Rating Dialog (modular component) ── */}
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
