'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import {
  ChevronDown,
  ChevronUp,
  ArrowUp,
  ArrowDown,
  Minus,
  Clock,
  MapPin,
  History,
  Loader2,
} from 'lucide-react';
import type { Reservation } from './types';

// ─── Types ─────────────────────────────────
interface TimelineEntry {
  position: number;
  timestamp: string;
  direction: 'joined' | 'up' | 'down' | 'current' | 'stayed';
  label: string;
}

interface PositionHistoryResponse {
  success: boolean;
  timeline: TimelineEntry[];
  currentPosition: number;
  initialPosition: number;
  totalChanges: number;
}

interface QueueTimelineProps {
  reservation: Reservation;
  /** Current live position from the parent's polling */
  livePosition: number;
}

// ─── Helpers ───────────────────────────────
function formatTimeAgo(timestamp: string, lang: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMin / 60);

  if (diffMin < 1) {
    if (lang === 'ar') return 'الآن';
    if (lang === 'fr') return "à l'instant";
    return 'just now';
  }
  if (diffMin < 60) {
    if (lang === 'ar') return `منذ ${diffMin} دقيقة`;
    if (lang === 'fr') return `il y a ${diffMin} min`;
    return `${diffMin}m ago`;
  }
  if (diffHrs < 24) {
    if (lang === 'ar') return `منذ ${diffHrs} ساعة`;
    if (lang === 'fr') return `il y a ${diffHrs}h`;
    return `${diffHrs}h ago`;
  }
  // Fallback: show time
  return new Date(timestamp).toLocaleTimeString(
    lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
    { hour: '2-digit', minute: '2-digit' }
  );
}

function formatTimestamp(timestamp: string, lang: string): string {
  return new Date(timestamp).toLocaleTimeString(
    lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
    { hour: '2-digit', minute: '2-digit' }
  );
}

// ─── Component ─────────────────────────────
export function QueueTimeline({ reservation, livePosition }: QueueTimelineProps) {
  const { t, lang } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const [history, setHistory] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Track live position changes
  const [localEntries, setLocalEntries] = useState<TimelineEntry[]>([]);

  const fetchHistory = useCallback(async () => {
    if (!reservation.id) return;
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch(`/api/reservations/${reservation.id}/position-history`);
      if (!res.ok) {
        setError(true);
        return;
      }
      const data: PositionHistoryResponse = await res.json();
      if (data.success && data.timeline) {
        setHistory(data.timeline);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [reservation.id]);

  // Fetch on first open
  useEffect(() => {
    if (isOpen && history.length === 0 && !loading) {
      fetchHistory();
    }
  }, [isOpen, history.length, loading, fetchHistory]);

  // Track live position changes and append to local entries
  useEffect(() => {
    if (livePosition <= 0) return;

    setLocalEntries((prev) => {
      const lastPos = prev.length > 0 ? prev[prev.length - 1].position : null;
      // Only add if position changed
      if (lastPos === livePosition) return prev;

      const entry: TimelineEntry = {
        position: livePosition,
        timestamp: new Date().toISOString(),
        direction: lastPos === null ? 'joined' : livePosition < lastPos ? 'up' : livePosition > lastPos ? 'down' : 'stayed',
        label: lastPos === null ? 'joined' : livePosition < lastPos ? 'movedUp' : livePosition > lastPos ? 'movedDown' : 'stayedSame',
      };
      return [...prev, entry];
    });
  }, [livePosition]);

  // Merge server history with local entries (local takes priority for overlap)
  const mergedTimeline = useMemo(() => {
    if (history.length === 0 && localEntries.length === 0) return [];
    if (history.length === 0) return localEntries;
    if (localEntries.length === 0) return history;

    // Use server history as base, then overlay local entries
    const serverLastTimestamp = history[history.length - 1]?.timestamp || '';
    const localNewer = localEntries.filter(
      (e) => new Date(e.timestamp) > new Date(serverLastTimestamp)
    );

    // Mark the last entry as current
    const combined = [...history, ...localNewer];
    if (combined.length > 0) {
      combined[combined.length - 1] = {
        ...combined[combined.length - 1],
        direction: 'current',
        label: 'current',
      };
    }
    return combined;
  }, [history, localEntries]);

  // Determine direction arrow
  const getDirectionIcon = (entry: TimelineEntry, prevEntry?: TimelineEntry) => {
    if (entry.direction === 'joined') {
      return <MapPin className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />;
    }
    if (entry.direction === 'current') {
      return <MapPin className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
    }
    if (entry.direction === 'up') {
      return <ArrowUp className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
    }
    if (entry.direction === 'down') {
      return <ArrowDown className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
    }
    return <Minus className="h-3.5 w-3.5 text-gray-400" />;
  };

  const getDirectionLabel = (entry: TimelineEntry) => {
    if (entry.direction === 'joined') return t('joinedAt' as any);
    if (entry.direction === 'current') return t('currentPosition' as any);
    if (entry.direction === 'up') return t('movedUp' as any);
    if (entry.direction === 'down') return t('movedDown' as any);
    return t('stayedSame' as any);
  };

  const getDirectionColor = (entry: TimelineEntry) => {
    if (entry.direction === 'joined') return 'text-teal-600 dark:text-teal-400';
    if (entry.direction === 'current') return 'text-emerald-600 dark:text-emerald-400';
    if (entry.direction === 'up') return 'text-emerald-600 dark:text-emerald-400';
    if (entry.direction === 'down') return 'text-amber-600 dark:text-amber-400';
    return 'text-gray-500';
  };

  // Summary text: "Position #5 → #4 → #3 → #2"
  const getSummaryChain = () => {
    if (mergedTimeline.length === 0) return `#${livePosition}`;
    const positions = mergedTimeline.map((e) => `#${e.position}`);
    // Remove consecutive duplicates
    const unique: string[] = [positions[0]];
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1]) {
        unique.push(positions[i]);
      }
    }
    return unique.join(' → ');
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-3">
      {/* Header / Toggle */}
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="w-full h-auto py-2.5 px-3 rounded-xl hover:bg-emerald-50 dark:hover:bg-emerald-900/20 group transition-all duration-200"
        >
          <div className="flex items-center justify-between w-full gap-2">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-sm">
                <History className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="text-start">
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  {t('positionTimeline' as any)}
                </p>
                {mergedTimeline.length > 0 && (
                  <p className="text-[10px] text-muted-foreground truncate max-w-[180px] sm:max-w-[260px]">
                    {getSummaryChain()}
                  </p>
                )}
              </div>
            </div>
            <motion.div
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
            >
              <ChevronDown className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </motion.div>
          </div>
        </Button>
      </CollapsibleTrigger>

      {/* Collapsible Content */}
      <CollapsibleContent>
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.3, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          <div className="mt-2 p-3 rounded-xl bg-gradient-to-br from-emerald-50/80 via-teal-50/50 to-emerald-50/80 dark:from-emerald-950/20 dark:via-teal-950/10 dark:to-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/30">
            {/* Loading State */}
            {loading && (
              <div className="flex items-center justify-center py-6 gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
                <span className="text-xs text-muted-foreground">{t('loading')}</span>
              </div>
            )}

            {/* Error State */}
            {error && !loading && (
              <div className="text-center py-4">
                <p className="text-xs text-muted-foreground">{t('noHistoryYet')}</p>
              </div>
            )}

            {/* Empty State */}
            {!loading && !error && mergedTimeline.length === 0 && (
              <div className="text-center py-4">
                <History className="h-8 w-8 text-emerald-300 dark:text-emerald-700 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">{t('positionTimelineDesc' as any)}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{t('noHistoryYet')}</p>
              </div>
            )}

            {/* Timeline */}
            {!loading && !error && mergedTimeline.length > 0 && (
              <div className="relative max-h-64 overflow-y-auto custom-scrollbar" dir="ltr">
                {/* RTL wrapper for proper alignment */}
                <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
                  <div className="space-y-0">
                    {mergedTimeline.map((entry, index) => {
                      const prevEntry = index > 0 ? mergedTimeline[index - 1] : undefined;
                      const isCurrent = entry.direction === 'current';
                      const isFirst = index === 0;
                      const isLast = index === mergedTimeline.length - 1;

                      return (
                        <motion.div
                          key={`${entry.position}-${entry.timestamp}-${index}`}
                          initial={{ opacity: 0, x: lang === 'ar' ? 12 : -12 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{
                            duration: 0.3,
                            delay: index * 0.05,
                            ease: 'easeOut',
                          }}
                          className="relative flex items-start gap-3"
                        >
                          {/* Vertical Line */}
                          {!isLast && (
                            <div
                              className="absolute start-[11px] top-6 bottom-0 w-px"
                              style={{
                                background: isCurrent
                                  ? 'linear-gradient(to bottom, #10b981, #14b8a6)'
                                  : 'linear-gradient(to bottom, #d1d5db, #e5e7eb)',
                              }}
                            />
                          )}

                          {/* Dot / Node */}
                          <div className="relative z-10 flex-shrink-0 mt-0.5">
                            {isCurrent ? (
                              <motion.div
                                animate={{
                                  scale: [1, 1.2, 1],
                                  boxShadow: [
                                    '0 0 0 0 rgba(16, 185, 129, 0.4)',
                                    '0 0 0 6px rgba(16, 185, 129, 0)',
                                    '0 0 0 0 rgba(16, 185, 129, 0.4)',
                                  ],
                                }}
                                transition={{
                                  duration: 2,
                                  repeat: Infinity,
                                  ease: 'easeInOut',
                                }}
                                className="h-[22px] w-[22px] rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-md shadow-emerald-500/30"
                              >
                                <div className="h-2 w-2 rounded-full bg-white" />
                              </motion.div>
                            ) : (
                              <div
                                className={`h-[22px] w-[22px] rounded-full flex items-center justify-center border-2 ${
                                  isFirst
                                    ? 'border-teal-400 bg-teal-50 dark:border-teal-600 dark:bg-teal-900/30'
                                    : entry.direction === 'up'
                                    ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-900/20'
                                    : entry.direction === 'down'
                                    ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
                                    : 'border-gray-300 bg-gray-50 dark:border-gray-600 dark:bg-gray-800'
                                }`}
                              >
                                {getDirectionIcon(entry, prevEntry)}
                              </div>
                            )}
                          </div>

                          {/* Content */}
                          <div className={`flex-1 min-w-0 pb-3 ${isLast ? 'pb-0' : ''}`}>
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <motion.span
                                  key={entry.position}
                                  initial={{ scale: isCurrent ? 1.3 : 1 }}
                                  animate={{ scale: 1 }}
                                  className={`text-sm font-bold tabular-nums ${
                                    isCurrent
                                      ? 'text-emerald-700 dark:text-emerald-400'
                                      : 'text-foreground'
                                  }`}
                                >
                                  #{entry.position}
                                </motion.span>
                                <span
                                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${
                                    isCurrent
                                      ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                                      : entry.direction === 'up'
                                      ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400'
                                      : entry.direction === 'down'
                                      ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400'
                                      : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                                  }`}
                                >
                                  {getDirectionLabel(entry)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <Clock className="h-3 w-3 text-muted-foreground" />
                                <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
                                  {formatTimeAgo(entry.timestamp, lang)}
                                </span>
                              </div>
                            </div>
                            {/* Detailed timestamp on hover/focus */}
                            <p className="text-[9px] text-muted-foreground/60 mt-0.5">
                              {formatTimestamp(entry.timestamp, lang)}
                            </p>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Summary Footer */}
            {!loading && !error && mergedTimeline.length > 1 && (
              <div className="mt-3 pt-2 border-t border-emerald-200/50 dark:border-emerald-800/30">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {t('positionTimelineDesc' as any)}
                  </span>
                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    {mergedTimeline.length - 1} {lang === 'ar' ? 'تغيير' : lang === 'fr' ? 'changement(s)' : 'change(s)'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </CollapsibleContent>
    </Collapsible>
  );
}
