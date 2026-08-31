'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { translateStatus } from '@/lib/enum-i18n';
import { useRealtime } from '@/hooks/use-realtime';
import { useOnlineStatus } from '@/hooks/use-online-status';
import { isRTL, type Language } from '@/i18n';
import { motion, AnimatePresence } from 'framer-motion';
import { Monitor, Clock, Users, ArrowLeft, RefreshCw, WifiOff, AlertTriangle } from 'lucide-react';

interface CurrentlyServing {
  id: string;
  ticketNumber: string;
  serviceName: string;
  status: string;
  calledAt: string | null;
  counterName?: string;
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

interface QueueStatus {
  agency: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
    isQueueOpen: boolean;
    isPaused: boolean;
  };
  currentlyServing: CurrentlyServing[];
  serviceStats: ServiceStat[];
  totalWaiting: number;
  totalEstimatedWait: number;
  recentCalls: {
    id: string;
    ticketNumber: string;
    status: string;
    calledAt: string | null;
    counterName?: string;
  }[];
}

interface KioskQueueBoardProps {
  agencyId: string;
  onBack: () => void;
  currentLang: Language;
}

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
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {Array.from({ length: 15 }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full bg-gradient-to-r from-emerald-400/10 to-teal-400/10"
          style={{
            width: Math.random() * 6 + 2,
            height: Math.random() * 6 + 2,
            left: `${Math.random() * 100}%`,
            top: `${Math.random() * 100}%`,
          }}
          animate={{
            y: [0, -(Math.random() * 200 + 100), 0],
            x: [0, Math.random() * 40 - 20, 0],
            opacity: [0, 0.6, 0],
          }}
          transition={{
            duration: Math.random() * 8 + 6,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: Math.random() * 5,
          }}
        />
      ))}
    </div>
  );
}

export function KioskQueueBoard({
  agencyId,
  onBack,
  currentLang,
}: KioskQueueBoardProps) {
  const { t } = useLanguage();
  const realtime = useRealtime();
  const isOnline = useOnlineStatus();
  const rtl = isRTL(currentLang);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const CACHE_KEY = `blasti-kiosk-queue-board-${agencyId}`;
  const prevServingIdsRef = useRef<Set<string>>(new Set());
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());

  // Load cached queue status on mount
  useEffect(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, cachedAt: ts } = JSON.parse(cached);
        setStatus(data);
        setCachedAt(ts);
        setLoading(false);
      }
    } catch { /* ignore */ }
  }, [CACHE_KEY]);

  // Update clock every second
  useEffect(() => {
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/agency-devices/public/queue-status?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        // Detect newly called tickets
        if (status) {
          const newIds = new Set<string>();
          const currentIds = new Set(data.currentlyServing?.map((s: CurrentlyServing) => s.id) || []);
          data.currentlyServing?.forEach((item: CurrentlyServing) => {
            if (!prevServingIdsRef.current.has(item.id)) {
              newIds.add(item.id);
            }
          });
          if (newIds.size > 0) {
            setFlashIds(newIds);
            setTimeout(() => setFlashIds(new Set()), 3000);
          }
          prevServingIdsRef.current = currentIds;
        } else {
          const currentIds = new Set(data.currentlyServing?.map((s: CurrentlyServing) => s.id) || []);
          prevServingIdsRef.current = currentIds;
        }
        setStatus(data);
        setLastRefresh(Date.now());
        // Cache to localStorage
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ data, cachedAt: Date.now() }));
          setCachedAt(Date.now());
        } catch { /* ignore */ }
      }
    } catch {
      // silent — will use cached data
    } finally {
      setLoading(false);
    }
  }, [agencyId, status]);

  // Polling fallback — keeps working even if realtime is disconnected, only when online
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      if (isOnline) {
        fetchStatus();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [agencyId, fetchStatus, isOnline]);

  // Join kiosk room for realtime updates
  useEffect(() => {
    if (!agencyId) return;
    realtime.joinKiosk(agencyId);
    return () => {
      realtime.leaveKiosk(agencyId);
    };
  }, [agencyId]);

  // Subscribe to realtime events — instantly refresh on any queue change
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    const handleUpdate = () => {
      fetchStatus();
    };

    unsubscribers.push(realtime.onKioskUpdate(handleUpdate));
    unsubscribers.push(realtime.onQueueCalled(handleUpdate));
    unsubscribers.push(realtime.onQueueJoined(handleUpdate));
    unsubscribers.push(realtime.onQueueWalkIn(handleUpdate));
    unsubscribers.push(realtime.onQueuePaused(handleUpdate));
    unsubscribers.push(realtime.onQueueResumed(handleUpdate));

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, [realtime, fetchStatus]);

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

  if (loading) {
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
        <p className="text-xl mb-4">{t('error')}</p>
        <button
          onClick={onBack}
          className="min-h-[60px] px-8 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-semibold text-lg shadow-lg shadow-emerald-500/25"
        >
          {t('kioskBack')}
        </button>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen text-white flex flex-col select-none relative overflow-hidden"
      dir={rtl ? 'rtl' : 'ltr'}
    >
      {/* Animated gradient background */}
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
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="min-h-[48px] min-w-[48px] rounded-xl bg-gray-700/60 flex items-center justify-center hover:bg-gray-600/60 transition-colors"
          >
            <ArrowLeft className={`h-5 w-5 ${rtl ? 'rotate-180' : ''}`} />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <Monitor className="h-5 w-5 text-emerald-400" />
              <h1 className="text-xl font-bold">{t('kioskQueueBoard')}</h1>
            </div>
            <p className="text-gray-400 text-sm">{getAgencyName()}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-gray-400 text-sm">
          {/* Clock display */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-gray-700/40 backdrop-blur-sm">
            <Clock className="h-4 w-4 text-emerald-400" />
            <span className="font-mono text-sm text-emerald-300">{formatTime(currentTime)}</span>
          </div>
          <span className="flex items-center gap-1">
            <RefreshCw className="h-3.5 w-3.5" />
            5s
          </span>
          {realtime.isConnected && isOnline ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-300">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-bold tracking-wider">LIVE</span>
            </div>
          ) : !isOnline ? (
            <span className="text-amber-400 font-semibold flex items-center gap-1">
              <WifiOff className="h-3.5 w-3.5" /> OFFLINE
            </span>
          ) : (
            <span className="text-gray-500 font-semibold">● POLLING</span>
          )}
        </div>
      </div>

      {/* Offline Banner */}
      {!isOnline && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-amber-500/90 backdrop-blur-sm px-6 py-2.5 flex items-center justify-between"
        >
          <div className="flex items-center gap-2 text-white">
            <WifiOff className="h-4 w-4" />
            <span className="text-sm font-semibold">{t('kioskOfflineMode')}</span>
          </div>
          {cachedAt && (
            <span className="text-xs text-white/80">
              {t('kioskLastUpdated')}: {Math.round((Date.now() - cachedAt) / 60000)} {t('minutesKiosk')}
            </span>
          )}
        </motion.div>
      )}

      {/* Last updated indicator when online but stale */}
      {isOnline && cachedAt && Date.now() - cachedAt > 60000 && (
        <div className="bg-amber-900/30 backdrop-blur-sm px-6 py-1.5 flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-xs text-amber-300">
            {t('kioskLastUpdated')}: {Math.round((Date.now() - cachedAt) / 60000)} {t('minutesKiosk')}
          </span>
        </div>
      )}

      <div className="flex-1 p-6 overflow-y-auto relative">
        {/* Now Serving Section - HUGE numbers */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-6 text-emerald-400 flex items-center gap-2">
            <Users className="h-7 w-7" />
            {t('kioskNowServing')}
          </h2>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {status.currentlyServing.length > 0 ? (
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
                        <p className="font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300 leading-none"
                          style={{ fontSize: 'clamp(4rem, 20vh, 12rem)' }}
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
        <div className="mb-8">
          <h2 className="text-xl font-bold mb-4 text-gray-300">
            {t('services')}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {status.serviceStats.map((stat) => (
              <motion.div
                key={stat.serviceId}
                whileHover={{ scale: 1.02, y: -2 }}
                className="bg-gray-800/60 backdrop-blur-sm rounded-xl p-4 flex items-center justify-between border border-gray-700/30 hover:border-emerald-500/20 transition-all duration-300"
              >
                <div>
                  <span className="text-xs font-bold px-2 py-1 rounded bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-300 me-2 border border-emerald-500/20">
                    {stat.prefix}
                  </span>
                  <span className="text-white font-semibold">
                    {getServiceName(stat)}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <AnimatedCounter
                      value={stat.waiting}
                      className="text-xl font-bold text-amber-400"
                    />
                    <p className="text-[10px] text-gray-500 uppercase">{t('kioskWaiting')}</p>
                  </div>
                  <div className="text-center">
                    <AnimatedCounter
                      value={stat.estimatedWait}
                      className="text-xl font-bold text-teal-400"
                    />
                    <p className="text-[10px] text-gray-500 uppercase">{t('kioskMinutes')}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Recent Calls */}
        {status.recentCalls.length > 0 && (
          <div>
            <h2 className="text-xl font-bold mb-4 text-gray-300 flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t('recent') || 'Recent'}
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
        {/* Scrolling ticker */}
        <div className="bg-gradient-to-r from-emerald-900/60 via-teal-900/60 to-emerald-900/60 backdrop-blur-md border-t border-emerald-500/10 overflow-hidden">
          <div className="flex items-center py-2">
            <motion.div
              animate={{ x: rtl ? [2000, 0] : [0, -2000] }}
              transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
              className="flex items-center gap-8 whitespace-nowrap px-4"
            >
              <span className="text-emerald-300 font-semibold">
                🏛️ {currentLang === 'ar' ? 'المؤسسة' : 'Institution'}: {getAgencyName()}
              </span>
              <span className="text-teal-300">
                📅 {formatDate(currentTime)}
              </span>
              <span className="text-cyan-300">
                ⏰ {formatTime(currentTime)}
              </span>
              <span className="text-emerald-300 font-semibold">
                🏛️ {currentLang === 'ar' ? 'المؤسسة' : 'Institution'}: {getAgencyName()}
              </span>
              <span className="text-teal-300">
                📅 {formatDate(currentTime)}
              </span>
              <span className="text-cyan-300">
                ⏰ {formatTime(currentTime)}
              </span>
            </motion.div>
          </div>
        </div>

        {/* Footer Stats */}
        <div className="bg-gray-800/80 backdrop-blur-md px-6 py-5 flex items-center justify-around border-t border-gray-700/30">
          <div className="text-center">
            <AnimatedCounter
              value={status.totalWaiting}
              className="text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-teal-400"
            />
            <p className="text-xs text-gray-400 uppercase font-semibold mt-1">{t('kioskWaiting')}</p>
          </div>
          <div className="w-px h-12 bg-gradient-to-b from-transparent via-emerald-500/30 to-transparent" />
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
