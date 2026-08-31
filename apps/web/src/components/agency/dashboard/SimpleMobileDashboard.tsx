'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { SlideToConfirm } from '@/components/shared/slide-to-confirm';
import {
  PhoneCall, Users, Clock, CheckCircle2, Pause, Play,
  UserX, Volume2, VolumeX, Wifi, WifiOff,
  RefreshCw, Loader2
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { isApiUnreachable, isBothUnreachable } from '@/lib/api-client';

// ─── Types ─────────────────────────────────────────────────────────────────

interface SimpleMobileDashboardProps {
  agencyId: string;
  onNavigateToSettings?: () => void;
}

interface QueueStats {
  currentlyWaiting: number;
  servedToday: number;
  avgWaitTime: number;
  currentQueueNumber: string;
  isPaused: boolean;
  noShowCount?: number;
  todayReservations?: number;
}

interface CurrentlyServing {
  id: string;
  displayNumber: string;
  customerName: string;
  serviceName: string;
  status: string;
}

// ─── Pulse Animation Keyframes ─────────────────────────────────────────────

const pulseGlow = {
  initial: { scale: 1, opacity: 1 },
  animate: {
    scale: [1, 1.05, 1],
    opacity: [1, 0.9, 1],
    transition: {
      duration: 2,
      repeat: Infinity,
      ease: 'easeInOut',
    },
  },
};

const newTicketPulse = {
  initial: { scale: 1 },
  animate: {
    scale: [1, 1.15, 1.08, 1.15, 1],
    transition: { duration: 0.8, ease: 'easeOut' },
  },
};

// ─── Component ─────────────────────────────────────────────────────────────

export function SimpleMobileDashboard({ agencyId, onNavigateToSettings }: SimpleMobileDashboardProps) {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const realtime = useRealtime();

  // ─── State ───────────────────────────────────────────────────────────
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [currentlyServing, setCurrentlyServing] = useState<CurrentlyServing | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [isPulsing, setIsPulsing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [pollErrorShown, setPollErrorShown] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const keepAwakeSupportedRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // ─── KeepAwake on mount ──────────────────────────────────────────────
  useEffect(() => {
    // Try to keep the screen awake using WakeLock API (web standard)
    // In Capacitor native builds, @capacitor-community/keep-awake is used
    // but we use a runtime check to avoid bundling issues in the web app
    const keepScreenAwake = async () => {
      try {
        // Try Capacitor KeepAwake (only available in native builds)
        const capacitorKeepAwake = (window as any).__CAPACITOR_KEEP_AWAKE__;
        if (capacitorKeepAwake) {
          keepAwakeSupportedRef.current = true;
          await capacitorKeepAwake.keepAwake();
          return;
        }
      } catch {
        // Not in Capacitor environment
      }

      // Fallback: use WakeLock API for web
      try {
        if ('wakeLock' in navigator) {
          const sentinel = await (navigator as any).wakeLock.request('screen');
          wakeLockRef.current = sentinel;
        }
      } catch {
        // WakeLock not supported or denied
      }
    };

    keepScreenAwake();

    // Re-acquire wake lock when page becomes visible again
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        keepScreenAwake();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);

      if (keepAwakeSupportedRef.current) {
        try {
          const capacitorKeepAwake = (window as any).__CAPACITOR_KEEP_AWAKE__;
          if (capacitorKeepAwake) {
            capacitorKeepAwake.allowSleep().catch(() => {});
          }
        } catch {
          // Silent fail
        }
      }
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, []);

  // ─── Audio setup ─────────────────────────────────────────────────────
  useEffect(() => {
    // Create a subtle chime sound for queue events
    try {
      const audio = new Audio();
      // Use a data URI for a simple bell-like tone
      audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      audio.volume = 0.3;
      audioRef.current = audio;
    } catch {
      // Audio not supported
    }
  }, []);

  const playSound = useCallback(() => {
    if (!soundEnabled || !audioRef.current) return;
    try {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    } catch {
      // Silent fail
    }
  }, [soundEnabled]);

  // ─── Data Fetching ───────────────────────────────────────────────────
  const fetchData = useCallback(async (showRefreshing = false, isPoll = false) => {
    if (!agencyId) return;

    if (showRefreshing) setRefreshing(true);

    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const [statsRes, queueRes] = await Promise.all([
        fetchWithRetry(`/api/agency/stats?agencyId=${encodeURIComponent(agencyId)}`),
        fetchWithRetry(`/api/agency/queue?agencyId=${encodeURIComponent(agencyId)}&status=CALLED`),
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats({
          currentlyWaiting: data.currentlyWaiting ?? 0,
          servedToday: data.servedToday ?? 0,
          avgWaitTime: data.avgWaitTime ?? 0,
          currentQueueNumber: data.currentQueueNumber ?? '—',
          isPaused: data.isPaused ?? false,
          noShowCount: data.noShowCount ?? 0,
          todayReservations: data.todayReservations ?? 0,
        });
      }

      if (queueRes.ok) {
        const data = await queueRes.json();
        const entries = data.entries ?? [];
        if (entries.length > 0) {
          const serving = entries[0];
          setCurrentlyServing({
            id: serving.id,
            displayNumber: serving.queueNumber || serving.displayNumber || '—',
            customerName: serving.customerName || serving.walkInCustomerName || '',
            serviceName: lang === 'ar' ? (serving.serviceNameAr || serving.serviceName) : (lang === 'fr' ? (serving.serviceNameFr || serving.serviceName) : serving.serviceName),
            status: serving.status,
          });
        } else {
          // No one currently called — check if stats has a current number
          setCurrentlyServing(null);
        }
      }

      setLastUpdated(new Date());
    } catch {
      // Only show error toast once per offline session (not on every 30s poll)
      if (!isPoll && !pollErrorShown) {
        toast.error(t('error') || 'Failed to load data');
        setPollErrorShown(true);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [agencyId, lang, t]);

  // ─── Auto-refresh with offline backoff ──────────────────────────
  useEffect(() => {
    fetchData(false, false);
    let failures = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const NORMAL = 30_000;

    const getInterval = () => {
      if (failures >= 3) return 120_000;
      if (failures >= 1) return 60_000;
      return NORMAL;
    };

    const tick = async () => {
      if (stopped) return;
      if (isBothUnreachable()) {
        timer = setTimeout(tick, getInterval());
        return;
      }
      await fetchData(false, true);
      if (isApiUnreachable()) failures = Math.min(failures + 1, 10);
      else failures = 0;
      timer = setTimeout(tick, getInterval());
    };

    timer = setTimeout(tick, NORMAL);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [fetchData]);

  // ─── Realtime subscriptions ─────────────────────────────────────────
  useEffect(() => {
    if (!agencyId) return;
    realtime.joinAgency(agencyId);
    return () => {
      realtime.leaveAgency(agencyId);
    };
  }, [agencyId, realtime.joinAgency, realtime.leaveAgency]);

  useEffect(() => {
    const unsubCalled = realtime.onQueueCalled((event: any) => {
      // New ticket called — pulse animation
      setIsPulsing(true);
      playSound();
      setTimeout(() => setIsPulsing(false), 1000);
      fetchData();
    });

    const unsubCompleted = realtime.onQueueCompleted(() => {
      fetchData();
    });

    const unsubNoShow = realtime.onQueueNoShow(() => {
      fetchData();
    });

    const unsubJoined = realtime.onQueueJoined(() => {
      fetchData();
    });

    const unsubPaused = realtime.onQueuePaused(() => {
      fetchData();
    });

    const unsubResumed = realtime.onQueueResumed(() => {
      fetchData();
    });

    const unsubCancelled = realtime.onQueueCancelled(() => {
      fetchData();
    });

    return () => {
      unsubCalled();
      unsubCompleted();
      unsubNoShow();
      unsubJoined();
      unsubPaused();
      unsubResumed();
      unsubCancelled();
    };
  }, [realtime, fetchData, playSound]);

  // ─── Actions ─────────────────────────────────────────────────────────
  const callNext = useCallback(async () => {
    if (actionLoading) return;
    setActionLoading('call');
    try {
      const res = await apiFetch('/api/agency/queue/call-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId }),
      });

      if (res.ok) {
        const data = await res.json();
        toast.success(t('statusCalled') || 'Customer called!');
        setIsPulsing(true);
        playSound();
        setTimeout(() => setIsPulsing(false), 1000);
        fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || t('noQueue') || 'No customers waiting');
      }
    } catch {
      toast.error(t('error') || 'Failed to call next');
    } finally {
      setActionLoading(null);
    }
  }, [agencyId, actionLoading, fetchData, playSound, t]);

  const markCompleted = useCallback(async () => {
    if (!currentlyServing || actionLoading) return;
    setActionLoading('complete');
    try {
      const res = await apiFetch(`/api/reservations/${currentlyServing.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'COMPLETED', agencyId }),
      });

      if (res.ok) {
        toast.success(t('markCompleted') || 'Marked as completed');
        setCurrentlyServing(null);
        fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error') || 'Failed to update');
      }
    } catch {
      toast.error(t('error') || 'Failed to update status');
    } finally {
      setActionLoading(null);
    }
  }, [currentlyServing, actionLoading, agencyId, fetchData, t]);

  const markNoShow = useCallback(async () => {
    if (!currentlyServing || actionLoading) return;
    setActionLoading('noshow');
    try {
      const res = await apiFetch(`/api/reservations/${currentlyServing.id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'NO_SHOW', agencyId }),
      });

      if (res.ok) {
        toast.success(t('statusNoShow') || 'Marked as no-show');
        setCurrentlyServing(null);
        fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error') || 'Failed to update');
      }
    } catch {
      toast.error(t('error') || 'Failed to update status');
    } finally {
      setActionLoading(null);
    }
  }, [currentlyServing, actionLoading, agencyId, fetchData, t]);

  const togglePause = useCallback(async () => {
    if (actionLoading) return;
    setActionLoading('pause');
    try {
      const isCurrentlyPaused = stats?.isPaused ?? false;
      const endpoint = isCurrentlyPaused ? '/api/queue/resume' : '/api/queue/pause';
      const res = await apiFetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId }),
      });

      if (res.ok) {
        toast.success(stats?.isPaused ? (t('queueResumed') || 'Queue resumed') : (t('queuePaused') || 'Queue paused'));
        fetchData();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error') || 'Failed to update');
      }
    } catch {
      toast.error(t('error') || 'Failed to update queue');
    } finally {
      setActionLoading(null);
    }
  }, [actionLoading, agencyId, stats, fetchData, t]);

  // ─── Loading State ───────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-12 w-12 text-emerald-500 animate-spin" />
          <p className="text-emerald-400/70 text-sm font-medium">
            {t('loading') || 'Loading...'}
          </p>
        </div>
      </div>
    );
  }

  // ─── Computed Values ─────────────────────────────────────────────────
  const displayNumber = currentlyServing?.displayNumber
    || stats?.currentQueueNumber
    || '—';
  const waitingCount = stats?.currentlyWaiting ?? 0;
  const completedToday = stats?.servedToday ?? 0;
  const avgTime = stats?.avgWaitTime ?? 0;
  const isPaused = stats?.isPaused ?? false;
  const isRTL = lang === 'ar';

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col safe-area-inset">
      {/* ─── Top Bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        {/* Connection Status */}
        <div className="flex items-center gap-2">
          {realtime.isConnected ? (
            <div className="flex items-center gap-1.5">
              <Wifi className="h-4 w-4 text-emerald-400" />
              <span className="text-[10px] text-emerald-400/70 font-medium">
                {t('connected') || 'Live'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <WifiOff className="h-4 w-4 text-amber-400" />
              <span className="text-[10px] text-amber-400/70 font-medium">
                {t('disconnected') || 'Offline'}
              </span>
            </div>
          )}
        </div>

        {/* Agency Name */}
        <div className="flex-1 text-center">
          <h2 className="text-xs font-bold text-emerald-400/80 truncate max-w-[180px] mx-auto">
            {user?.agencyName || user?.agencyNameAr || user?.agencyNameFr || ''}
          </h2>
        </div>

        {/* Sound + Refresh */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className="p-2 rounded-xl bg-white/5 active:scale-90 transition-transform"
            aria-label={soundEnabled ? 'Mute' : 'Unmute'}
          >
            {soundEnabled ? (
              <Volume2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <VolumeX className="h-4 w-4 text-gray-500" />
            )}
          </button>
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className="p-2 rounded-xl bg-white/5 active:scale-90 transition-transform"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 text-emerald-400 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ─── Currently Serving — HERO SECTION ────────────────────────── */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 -mt-4">
        <p className="text-emerald-400/60 text-xs font-semibold uppercase tracking-widest mb-2">
          {t('currentlyServing') || 'Currently Serving'}
        </p>

        {/* MASSIVE Number */}
        <AnimatePresence mode="wait">
          <motion.div
            key={displayNumber}
            variants={newTicketPulse}
            initial="initial"
            animate={isPulsing ? 'animate' : 'initial'}
            className="relative"
          >
            <motion.div
              variants={pulseGlow}
              initial="initial"
              animate="animate"
              className="relative"
            >
              {/* Glow effect behind the number */}
              <div className="absolute inset-0 blur-3xl bg-emerald-500/20 rounded-full scale-150" />

              <span
                className="relative text-[min(40vw,180px)] font-black leading-none select-none"
                style={{
                  background: 'linear-gradient(135deg, #10b981 0%, #14b8a6 30%, #06b6d4 70%, #10b981 100%)',
                  backgroundSize: '200% 200%',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                  animation: 'gradient-shift 4s ease infinite',
                }}
              >
                {displayNumber}
              </span>
            </motion.div>
          </motion.div>
        </AnimatePresence>

        {/* Customer & Service info */}
        {currentlyServing && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 text-center"
          >
            <p className="text-white/80 text-sm font-semibold">
              {currentlyServing.customerName || (t('walkIn') || 'Walk-in')}
            </p>
            {currentlyServing.serviceName && (
              <p className="text-emerald-400/60 text-xs mt-0.5">
                {currentlyServing.serviceName}
              </p>
            )}
          </motion.div>
        )}

        {/* Paused overlay indicator */}
        {isPaused && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-4 px-4 py-1.5 bg-amber-500/20 rounded-full border border-amber-500/30"
          >
            <p className="text-amber-400 text-xs font-bold uppercase tracking-wider">
              {t('paused') || 'Paused'}
            </p>
          </motion.div>
        )}

        {/* No one serving */}
        {!currentlyServing && displayNumber === '—' && !isPaused && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-4"
          >
            <p className="text-gray-500 text-sm">
              {t('noQueue') || 'No customers in queue'}
            </p>
          </motion.div>
        )}
      </div>

      {/* ─── Stats Row ────────────────────────────────────────────────── */}
      <div className="px-4 pb-3">
        <div className="grid grid-cols-3 gap-2">
          {/* Waiting */}
          <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-3 text-center border border-white/5">
            <Users className="h-5 w-5 text-amber-400 mx-auto mb-1" />
            <p className="text-2xl font-black text-white">{waitingCount}</p>
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
              {t('waiting') || 'Waiting'}
            </p>
          </div>

          {/* Completed */}
          <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-3 text-center border border-white/5">
            <CheckCircle2 className="h-5 w-5 text-emerald-400 mx-auto mb-1" />
            <p className="text-2xl font-black text-white">{completedToday}</p>
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
              {t('servedToday') || 'Done'}
            </p>
          </div>

          {/* Avg Time */}
          <div className="bg-white/5 backdrop-blur-sm rounded-2xl p-3 text-center border border-white/5">
            <Clock className="h-5 w-5 text-cyan-400 mx-auto mb-1" />
            <p className="text-2xl font-black text-white">{avgTime}</p>
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
              {t('avgWaitTime') || 'Min'}
            </p>
          </div>
        </div>
      </div>

      {/* ─── Action Buttons ───────────────────────────────────────────── */}
      <div className="px-4 pb-4 space-y-3">
        {/* Call Next — MASSIVE button */}
        <motion.button
          onClick={callNext}
          disabled={!!actionLoading || isPaused}
          whileTap={{ scale: 0.96 }}
          className={`
            w-full min-h-[80px] rounded-2xl font-bold text-xl
            flex items-center justify-center gap-3
            transition-all duration-150
            ${isPaused
              ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
              : 'bg-gradient-to-r from-emerald-600 via-teal-500 to-cyan-500 text-white shadow-lg shadow-emerald-500/25 active:shadow-emerald-500/40'
            }
          `}
        >
          {actionLoading === 'call' ? (
            <Loader2 className="h-7 w-7 animate-spin" />
          ) : (
            <>
              <PhoneCall className="h-7 w-7" />
              <span>{t('callNext') || 'Call Next'}</span>
            </>
          )}
        </motion.button>

        {/* Currently serving actions */}
        {currentlyServing && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-3"
          >
            {/* Mark Completed */}
            <motion.button
              onClick={markCompleted}
              disabled={!!actionLoading}
              whileTap={{ scale: 0.96 }}
              className="w-full min-h-[56px] rounded-2xl font-bold text-base
                bg-gradient-to-r from-emerald-700 to-emerald-600 text-white
                flex items-center justify-center gap-2
                shadow-md shadow-emerald-600/20"
            >
              {actionLoading === 'complete' ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>
                  <CheckCircle2 className="h-5 w-5" />
                  <span>{t('markCompleted') || 'Mark Completed'}</span>
                </>
              )}
            </motion.button>

            {/* No-Show with SlideToConfirm */}
            <div className="rounded-2xl overflow-hidden bg-gradient-to-r from-red-900/60 to-red-800/40 p-3">
              <p className="text-red-300/70 text-[10px] font-semibold uppercase tracking-wider mb-2 text-center">
                {t('markNoShow') || 'No-Show'}
              </p>
              <SlideToConfirm
                onConfirm={markNoShow}
                label={t('slideNoShow')}
              />
            </div>
          </motion.div>
        )}

        {/* Pause / Resume */}
        <motion.button
          onClick={togglePause}
          disabled={!!actionLoading}
          whileTap={{ scale: 0.96 }}
          className={`
            w-full min-h-[48px] rounded-2xl font-semibold text-sm
            flex items-center justify-center gap-2
            transition-colors duration-150
            ${isPaused
              ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-amber-600/20 text-amber-400 border border-amber-500/30'
            }
          `}
        >
          {actionLoading === 'pause' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isPaused ? (
            <>
              <Play className="h-4 w-4" />
              <span>{t('resumeQueue') || 'Resume Queue'}</span>
            </>
          ) : (
            <>
              <Pause className="h-4 w-4" />
              <span>{t('pauseQueue') || 'Pause Queue'}</span>
            </>
          )}
        </motion.button>
      </div>

      {/* ─── Last Updated ─────────────────────────────────────────────── */}
      <div className="pb-6 text-center">
        <p className="text-[10px] text-gray-600">
          {t('lastUpdated') || 'Last updated'}: {lastUpdated.toLocaleTimeString()}
        </p>
      </div>

      {/* ─── Inline CSS for gradient animation ───────────────────────── */}
      <style jsx>{`
        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      `}</style>
    </div>
  );
}
