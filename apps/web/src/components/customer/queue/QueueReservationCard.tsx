'use client';

import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useLanguage } from '@/hooks/use-language';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  Users,
  Clock,
  TicketCheck,
  Volume2,
  XCircle,
  Loader2,
  AlertTriangle,
  Timer,
  Share2,
  Sparkles,
  QrCode,
  ShieldAlert,
  Star,
  ArrowDown,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Reservation } from './types';
import { QueueProgressRing } from './QueueProgressRing';
import { QueueTimeline } from './QueueTimeline';

// Phase 7c: Removed countdown/countdownCircumference/countdownRadius props
// Replaced per-second countdown with static auto-refreshing ETA badge
interface QueueReservationCardProps {
  res: Reservation;
  isCalled: boolean;
  cancelling: string | null;
  lang: string;
  getAgencyName: (r: Reservation) => string;
  getServiceName: (r: Reservation) => string;
  ringCircumference: number;
  ringRadius: number;
  onCancel: (id: string) => void;
  onPostponeOpen: (resId: string) => void;
  onToggleFixedTime: (resId: string, currentEnabled: boolean) => void;
  onReclaim: (id: string) => void;
  onSharePosition: (res: Reservation) => void;
  onQrOpen: (res: Reservation) => void;
  onEmergencyCancel: (resId: string) => void;
  onLeaveQueue: () => void;
  onOpenRatingDialog: (resId: string) => void;
  // Dialog states
  emergencyDialogOpen: boolean;
  emergencyResId: string | null;
  onEmergencyDialogChange: (open: boolean) => void;
  leaveDialogOpen: boolean;
  onLeaveDialogChange: (open: boolean) => void;
  cancellingLeaving: boolean;
  // Phase 7d: Cancel confirmation dialog
  cancelDialogOpen: boolean;
  cancelResId: string | null;
  onCancelDialogChange: (open: boolean) => void;
  // Postpone dialog
  postponeDialogOpen: boolean;
  postponePositions: number;
  postponeLoading: boolean;
  onPostponeDialogChange: (open: boolean) => void;
  onPostponePositionsChange: (n: number) => void;
  onPostponeConfirm: () => void;
  // QR dialog
  qrDialogOpen: boolean;
  qrReservation: Reservation | null;
  onQrDialogChange: (open: boolean) => void;
  // Rating
  feedbackSubmittedIds: Set<string>;
  // Fixed time toggle loading
  fixedTimeToggling: boolean;
}

export function QueueReservationCard({
  res,
  isCalled,
  cancelling,
  lang,
  getAgencyName,
  getServiceName,
  ringCircumference,
  ringRadius,
  onCancel,
  onPostponeOpen,
  onToggleFixedTime,
  onReclaim,
  onSharePosition,
  onQrOpen,
  onEmergencyCancel,
  onLeaveQueue,
  onOpenRatingDialog,
  emergencyDialogOpen,
  emergencyResId,
  onEmergencyDialogChange,
  leaveDialogOpen,
  onLeaveDialogChange,
  cancellingLeaving,
  postponeDialogOpen,
  postponePositions,
  postponeLoading,
  onPostponeDialogChange,
  onPostponePositionsChange,
  onPostponeConfirm,
  qrDialogOpen,
  qrReservation,
  onQrDialogChange,
  feedbackSubmittedIds,
  fixedTimeToggling,
  cancelDialogOpen,
  cancelResId,
  onCancelDialogChange,
}: QueueReservationCardProps) {
  const { t } = useLanguage();

  // Progress ring calculation
  const ringProgress =
    res.peopleAhead <= 0
      ? 100
      : Math.max(5, Math.min(95, 100 - (res.peopleAhead / 20) * 100));
  const ringDashOffset = ringCircumference - (ringProgress / 100) * ringCircumference;

  // ── Strict ETA display — purely from API payload, no client-side guessing ──
  // The backend calculateETA() engine provides min/max range + confidence.
  // We display that directly instead of applying arbitrary ±20% math.
  const formatEtaBadge = (reservation: Reservation): string => {
    const wait = reservation.estimatedWait;
    if (wait <= 0) return t('paused') || 'Paused';
    if (wait >= 60) {
      const hrs = Math.floor(wait / 60);
      const mins = wait % 60;
      return mins > 0 ? `${t('approx') || '~'} ${hrs}${t('hours') || 'h'} ${mins}${t('min') || 'm'}` : `${t('approx') || '~'} ${hrs}${t('hours') || 'h'}`;
    }
    return `${t('approx') || '~'} ${wait} ${t('min') || 'min'}`;
  };

  // Memoized ETA text — recomputes ONLY when server data changes (no client-side timer)
  const etaText = useMemo(() => formatEtaBadge(res), [res.estimatedWait, res.peopleAhead, res.status]);

  // ETA-based progress (replaces countdown-based progress)
  const etaProgress = res.peopleAhead <= 0
    ? 95
    : Math.max(5, Math.min(95, 100 - (res.peopleAhead / Math.max(1, res.peopleAhead + 5)) * 100));
  const countdownProgress = isCalled ? 100 : etaProgress;

  return (
    <motion.div
      key={res.id}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={isCalled ? { opacity: 1, scale: 1, x: [0, -3, 3, -3, 3, 0] } : { opacity: 1, scale: 1 }}
      transition={isCalled ? { duration: 0.5, repeat: Infinity, repeatDelay: 1, ease: 'easeInOut' } : { duration: 0.3 }}
      className="mb-4"
    >
      {/* Ticket-style card with torn edges */}
      <div className="relative">
        {/* Torn edge SVG decorations - top and bottom */}
        <svg className="absolute -top-px inset-x-0 w-full h-3 z-10" viewBox="0 0 400 12" preserveAspectRatio="none">
          <path d="M0,0 L0,12 Q10,6 20,12 Q30,0 40,12 Q50,0 60,12 Q70,0 80,12 Q90,0 100,12 Q110,0 120,12 Q130,0 140,12 Q150,0 160,12 Q170,0 180,12 Q190,0 200,12 Q210,0 220,12 Q230,0 240,12 Q250,0 260,12 Q270,0 280,12 Q290,0 300,12 Q310,0 320,12 Q330,0 340,12 Q350,0 360,12 Q370,0 380,12 Q390,0 400,12 L400,0 Z"
            className={isCalled ? 'fill-white dark:fill-gray-900' : 'fill-white dark:fill-gray-900'}
          />
        </svg>
        <svg className="absolute -bottom-px inset-x-0 w-full h-3 z-10 rotate-180" viewBox="0 0 400 12" preserveAspectRatio="none">
          <path d="M0,0 L0,12 Q10,6 20,12 Q30,0 40,12 Q50,0 60,12 Q70,0 80,12 Q90,0 100,12 Q110,0 120,12 Q130,0 140,12 Q150,0 160,12 Q170,0 180,12 Q190,0 200,12 Q210,0 220,12 Q230,0 240,12 Q250,0 260,12 Q270,0 280,12 Q290,0 300,12 Q310,0 320,12 Q330,0 340,12 Q350,0 360,12 Q370,0 380,12 Q390,0 400,12 L400,0 Z"
            className={isCalled ? 'fill-white dark:fill-gray-900' : 'fill-white dark:fill-gray-900'}
          />
        </svg>

        {/* Left perforation circle */}
        <div className="absolute start-0 top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 sm:h-4 sm:w-4 rounded-full bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/20 z-10 shadow-inner" />
        {/* Right perforation circle */}
        <div className="absolute end-0 top-1/2 -translate-y-1/2 translate-x-1/2 h-3 w-3 sm:h-4 sm:w-4 rounded-full bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:from-gray-950 dark:via-gray-900 dark:to-emerald-950/20 z-10 shadow-inner" />

        {/* Gradient border wrapper for called status */}
        <div
          className={`rounded-2xl p-[2px] transition-all duration-500 ${
            isCalled
              ? 'bg-gradient-to-br from-emerald-400 via-teal-400 to-emerald-500 shadow-lg shadow-emerald-500/20'
              : 'bg-border dark:bg-gray-800'
          }`}
        >
          <Card className="border-0 shadow-none overflow-hidden bg-white dark:bg-gray-900 rounded-xl">
            {/* Status Banner */}
            <div
              className={`px-4 py-2.5 ${
                isCalled
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white'
                  : 'bg-gradient-to-r from-amber-400 to-amber-500 text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                {isCalled ? (
                  <motion.div
                    animate={{ scale: [1, 1.15, 1] }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <Volume2 className="h-5 w-5" />
                  </motion.div>
                ) : (
                  <Clock className="h-5 w-5" />
                )}
                <span className="font-semibold text-sm">
                  {isCalled ? t('statusCalled') : t('statusWaiting')}
                </span>
                <div className="flex items-center gap-1.5 ms-auto flex-shrink-0">
                  {/* Estimated Wait Time Badge for WAITING status */}
                  {res.status === 'WAITING' && !isCalled && res.estimatedWait > 0 && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="text-xs font-medium bg-white/20 px-2.5 py-0.5 rounded-full whitespace-nowrap flex items-center gap-1"
                    >
                      <Clock className="h-3 w-3" />
                      {res.estimatedWait >= 60
                        ? `~${Math.floor(res.estimatedWait / 60)}${t('hours')} ${res.estimatedWait % 60 > 0 ? `${res.estimatedWait % 60}${t('min')}` : ''}`
                        : `~${res.estimatedWait}${t('min')}`
                      }
                    </motion.span>
                  )}
                  {res.status === 'WAITING' && !isCalled && res.estimatedWait <= 0 && (
                    <span className="text-xs font-medium bg-amber-400/30 px-2.5 py-0.5 rounded-full whitespace-nowrap">
                      {t('paused')}
                    </span>
                  )}
                  {isCalled && (
                    <motion.span
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="text-xs font-medium bg-white/20 px-2.5 py-0.5 rounded-full whitespace-nowrap"
                    >
                      <Sparkles className="h-3 w-3 inline me-1" />
                      {t('statusCalled')}!
                    </motion.span>
                  )}
                  {/* Reserved date badge */}
                  {res.reservedDate && (
                    <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full whitespace-nowrap">
                      📅 {new Date(res.reservedDate + 'T00:00:00').toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <CardContent className="p-4 sm:p-5">
              {/* Progress Ring with Queue Number */}
              <QueueProgressRing
                reservation={res}
                isCalled={isCalled}
                ringCircumference={ringCircumference}
                ringRadius={ringRadius}
                ringDashOffset={ringDashOffset}
              />

              {/* Agency & Service */}
              <div className="text-center mb-4 space-y-0.5">
                <p className="text-sm font-medium text-foreground truncate px-2">
                  {getAgencyName(res)}
                </p>
                <p className="text-xs text-muted-foreground truncate px-2">{getServiceName(res)}</p>
                {res.reservedDate && (
                  <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                    📅 {t('reservedFor')} {new Date(res.reservedDate + 'T00:00:00').toLocaleDateString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { month: 'short', day: 'numeric' })}
                  </p>
                )}
              </div>

              {/* Stats Row - responsive 3 cols */}
              <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4">
                {/* People Ahead */}
                <div className="text-center p-2 sm:p-3 rounded-xl bg-teal-50 dark:bg-teal-900/20">
                  <div className="relative inline-block">
                    <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-teal-600 dark:text-teal-400 mx-auto mb-0.5" />
                    {res.peopleAhead > 0 && (
                      <motion.div
                        animate={{ scale: [1, 1.4, 1], opacity: [0.5, 1, 0.5] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                        className="absolute -top-0.5 -end-0.5 h-2 w-2 rounded-full bg-teal-500"
                      />
                    )}
                  </div>
                  <motion.p
                    key={res.peopleAhead}
                    initial={{ scale: 1.3, color: '#0d9488' }}
                    animate={{ scale: 1, color: '#0f766e' }}
                    transition={{ duration: 0.4 }}
                    className="text-base sm:text-lg font-bold text-teal-700 dark:text-teal-400"
                  >
                    {res.peopleAhead}
                  </motion.p>
                  <p className="text-[9px] sm:text-[10px] text-muted-foreground">{t('peopleAhead')}</p>
                </div>
                {/* Phase 7c: Static ETA badge — replaces animated circular countdown */}
                <div className="text-center p-2 sm:p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex flex-col items-center justify-center">
                  <Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-amber-600 dark:text-amber-400 mx-auto mb-0.5" />
                  <p className="text-xs sm:text-sm font-bold text-amber-700 dark:text-amber-400">
                    {etaText}
                  </p>
                  <p className="text-[9px] sm:text-[10px] text-muted-foreground">{t('estimatedWait')}</p>
                </div>
                <div className="text-center p-2 sm:p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20">
                  <TicketCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-emerald-600 dark:text-emerald-400 mx-auto mb-0.5" />
                  <p className="text-base sm:text-lg font-bold text-emerald-700 dark:text-emerald-400">
                    {res.currentServingNumber}
                  </p>
                  <p className="text-[9px] sm:text-[10px] text-muted-foreground">{t('currentServing')}</p>
                </div>
              </div>

              {/* Phase 7c: Static ETA Badge — replaces per-second countdown display */}
              {!isCalled && res.estimatedWait > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-5"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Timer className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{t('estimatedWait') || ''}</span>
                  </div>
                  <div className="flex items-center justify-center">
                    <div className="px-5 py-3 rounded-2xl bg-gradient-to-br from-amber-50 via-orange-50 to-amber-50 dark:from-amber-900/20 dark:via-orange-900/15 dark:to-amber-900/20 border border-amber-200/50 dark:border-amber-800/30">
                      <p className="text-lg sm:text-xl font-bold text-amber-700 dark:text-amber-400 text-center">
                        {etaText}
                      </p>
                      <p className="text-[10px] text-amber-600/70 dark:text-amber-400/70 text-center mt-0.5">
                        {t('updatesWhenAvailable')}
                      </p>
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Position indicator with pulsing animation & progress bar */}
              <div className="mb-4 px-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">{t('queuePosition')}</span>
                  <div className="flex items-center gap-1.5" aria-live="polite">
                    <motion.span
                      key={res.position}
                      initial={{ scale: 1.4, color: '#059669' }}
                      animate={{ scale: 1, color: '#0f172a' }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                      className="text-sm font-bold text-foreground"
                    >
                      #{res.position}
                    </motion.span>
                    <span className="text-[10px] text-muted-foreground">/</span>
                    <span className="text-[10px] text-muted-foreground">
                      {res.peopleAhead + res.position}
                    </span>
                    {/* Pulsing indicator */}
                    <motion.div
                      animate={{ scale: [1, 1.5, 1], opacity: [0.7, 1, 0.7] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                      className="h-2 w-2 rounded-full bg-emerald-500 pulse-ring"
                    />
                  </div>
                </div>
                {/* Progress bar showing position in queue */}
                <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
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

              {/* Queue Position History Timeline */}
              {(res.status === 'WAITING' || res.status === 'CALLED') && (
                <QueueTimeline reservation={res} livePosition={res.position} />
              )}

              {/* Phase 7c: Static ETA Display — replaces countdown-based remaining time */}
              {!isCalled && res.estimatedWait > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-4 p-3.5 rounded-xl bg-gradient-to-br from-amber-50 via-orange-50 to-amber-50 dark:from-amber-900/15 dark:via-orange-900/10 dark:to-amber-900/15 border border-amber-200/50 dark:border-amber-800/30 relative overflow-hidden"
                >
                  <div className="relative">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-sm shadow-amber-500/20">
                          <Clock className="h-3.5 w-3.5 text-white" />
                        </div>
                        <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">{t('estimatedWait')}</span>
                      </div>
                      <span className="text-sm font-bold text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-900/30 px-2 py-0.5 rounded-lg">
                        {etaText}
                      </span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-amber-200/40 dark:bg-amber-900/30 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500"
                        initial={{ width: '0%' }}
                        animate={{
                          width: `${countdownProgress}%`,
                        }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                </motion.div>
              )}

              {/* Share Position + QR Buttons */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Button
                    variant="outline"
                    className="w-full h-10 rounded-xl border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 gap-2 shadow-sm hover:shadow-md transition-all duration-200"
                    onClick={() => onSharePosition(res)}
                  >
                    <Share2 className="h-4 w-4" />
                    {t('sharePosition') || 'Share'}
                  </Button>
                </motion.div>
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.25 }}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Button
                    variant="outline"
                    className="w-full h-10 rounded-xl border-teal-200 dark:border-teal-800 text-teal-600 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 gap-2 shadow-sm hover:shadow-md transition-all duration-200"
                    onClick={() => onQrOpen(res)}
                  >
                    <QrCode className="h-4 w-4" />
                    {t('qrShowPass') || t('shareViaQR')}
                  </Button>
                </motion.div>
              </div>

              {/* Cancel, Postpone & Leave Queue Buttons */}
              {res.status === 'WAITING' && (
                <div className="space-y-2">
                  {/* Fixed Time Toggle */}
                  {res.preferredTime && (
                    <div className="flex items-center justify-between p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30">
                      <div className="flex items-center gap-2 min-w-0">
                        <Clock className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400 truncate">
                            {res.fixedTimeEnabled ? t('fixedTimeOn') : t('fixedTimeOff')}
                          </p>
                          {res.fixedTimeEnabled && res.preferredTime && (
                            <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70" dir="ltr">{res.preferredTime}</p>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px] px-2 rounded-lg border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
                        onClick={() => onToggleFixedTime(res.id, res.fixedTimeEnabled || false)}
                        disabled={fixedTimeToggling}
                      >
                        {t('toggleFixedTime')}
                      </Button>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {/* Postpone */}
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button
                        variant="outline"
                        className="w-full h-11 rounded-xl border-amber-200 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-all duration-300"
                        onClick={() => onPostponeOpen(res.id)}
                      >
                        <ArrowDown className="h-4 w-4 me-2" />
                        <span className="text-sm">{t('postponeTurn')}</span>
                      </Button>
                    </motion.div>
                    {/* Leave Queue */}
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button
                        variant="outline"
                        className="w-full h-11 rounded-xl border-2 border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/20 text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/30 font-semibold transition-all duration-300 gap-2"
                        onClick={onLeaveQueue}
                      >
                        <XCircle className="h-4 w-4" />
                        <span className="text-sm">{t('leaveQueue')}</span>
                      </Button>
                    </motion.div>
                  </div>
                  {/* Cancel Reservation — full width below */}
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Button
                      variant="outline"
                      className="w-full h-11 rounded-xl border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-300"
                      onClick={() => onCancelDialogChange(true)}
                      disabled={cancelling === res.id}
                    >
                      {cancelling === res.id ? (
                        <Loader2 className="h-4 w-4 animate-spin me-2" />
                      ) : (
                        <XCircle className="h-4 w-4 me-2" />
                      )}
                      <span className="text-sm">{t('cancelReservation')}</span>
                    </Button>
                  </motion.div>
                </div>
              )}

              {/* Skipped - Reclaim Button */}
              {res.skippedForNoShow && res.status === 'CALLED' && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-2"
                >
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/30">
                    <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                    <span className="text-xs text-amber-700 dark:text-amber-400">{t('skippedWarning')}</span>
                  </div>
                  <Button
                    className="w-full h-11 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold shadow-lg shadow-amber-500/20 transition-all duration-300"
                    onClick={() => onReclaim(res.id)}
                    disabled={cancelling === res.id}
                  >
                    {cancelling === res.id ? (
                      <Loader2 className="h-4 w-4 animate-spin me-2" />
                    ) : (
                      <ShieldAlert className="h-4 w-4 me-2" />
                    )}
                    {t('reclaimPosition')}
                  </Button>
                </motion.div>
              )}

              {/* Feedback for COMPLETED reservations */}
              {res.status === 'COMPLETED' && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-3"
                >
                  {feedbackSubmittedIds.has(res.id) || res.rating ? (
                    <div className="flex items-center justify-center gap-2 py-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200/50 dark:border-emerald-800/50">
                      <Star className="h-5 w-5 text-amber-500 fill-amber-500" />
                      <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                        {t('ratingSubmitted')}
                      </span>
                      {res.rating && (
                        <div className="flex items-center gap-0.5 ms-1">
                          {[1, 2, 3, 4, 5].map((s) => (
                            <Star
                              key={s}
                              className={`h-3 w-3 ${s <= res.rating! ? 'text-amber-400 fill-amber-400' : 'text-gray-300 dark:text-gray-600'}`}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <Button
                      className="w-full h-10 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-semibold shadow-lg shadow-amber-500/20 transition-all duration-300 gap-2"
                      onClick={() => onOpenRatingDialog(res.id)}
                    >
                      <Star className="h-4 w-4" />
                      {t('rateExperience')}
                    </Button>
                  )}
                </motion.div>
              )}

              {/* Emergency Cancel button removed — redundant with the Cancel Reservation button above. */}

            </CardContent>
          </Card>
        </div>
      </div>

      {/* QR Code Dialog */}
      <Dialog open={qrDialogOpen} onOpenChange={onQrDialogChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-emerald-600" />
              {t('qrCodeTitle')}
            </DialogTitle>
            <DialogDescription>{t('qrCodeDesc')}</DialogDescription>
          </DialogHeader>
          {qrReservation && (
            <div className="flex flex-col items-center gap-4 py-4">
              {/* QR Code placeholder with ticket info */}
              <div className="relative p-4 bg-white dark:bg-gray-900 rounded-2xl border-2 border-dashed border-emerald-300 dark:border-emerald-700">
                <svg className="h-48 w-48" viewBox="0 0 200 200" fill="none">
                  {/* QR code corner squares */}
                  <rect x="10" y="10" width="60" height="60" rx="4" className="fill-emerald-600" />
                  <rect x="130" y="10" width="60" height="60" rx="4" className="fill-emerald-600" />
                  <rect x="10" y="130" width="60" height="60" rx="4" className="fill-emerald-600" />
                  {/* Inner white squares for QR corners */}
                  <rect x="18" y="18" width="44" height="44" rx="2" className="fill-white" />
                  <rect x="138" y="18" width="44" height="44" rx="2" className="fill-white" />
                  <rect x="18" y="138" width="44" height="44" rx="2" className="fill-white" />
                  <rect x="26" y="26" width="28" height="28" rx="1" className="fill-emerald-600" />
                  <rect x="146" y="26" width="28" height="28" rx="1" className="fill-emerald-600" />
                  <rect x="26" y="146" width="28" height="28" rx="1" className="fill-emerald-600" />
                  {/* Data pattern dots */}
                  <rect x="80" y="10" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="10" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="10" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="26" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="26" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="42" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="42" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="42" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="58" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="58" width="8" height="8" className="fill-emerald-500" />
                  <rect x="10" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="26" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="42" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="58" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="130" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="146" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="162" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="178" y="80" width="8" height="8" className="fill-emerald-500" />
                  <rect x="10" y="96" width="8" height="8" className="fill-emerald-500" />
                  <rect x="42" y="96" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="96" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="96" width="8" height="8" className="fill-emerald-500" />
                  <rect x="130" y="96" width="8" height="8" className="fill-emerald-500" />
                  <rect x="162" y="96" width="8" height="8" className="fill-emerald-500" />
                  <rect x="10" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="26" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="42" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="58" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="130" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="146" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="178" y="112" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="130" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="130" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="130" width="8" height="8" className="fill-emerald-500" />
                  <rect x="130" y="130" width="8" height="8" className="fill-emerald-500" />
                  <rect x="146" y="130" width="8" height="8" className="fill-emerald-500" />
                  <rect x="162" y="130" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="146" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="146" width="8" height="8" className="fill-emerald-500" />
                  <rect x="130" y="146" width="8" height="8" className="fill-emerald-500" />
                  <rect x="162" y="146" width="8" height="8" className="fill-emerald-500" />
                  <rect x="178" y="146" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="162" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="162" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="162" width="8" height="8" className="fill-emerald-500" />
                  <rect x="130" y="162" width="8" height="8" className="fill-emerald-500" />
                  <rect x="146" y="162" width="8" height="8" className="fill-emerald-500" />
                  <rect x="80" y="178" width="8" height="8" className="fill-emerald-500" />
                  <rect x="96" y="178" width="8" height="8" className="fill-emerald-500" />
                  <rect x="112" y="178" width="8" height="8" className="fill-emerald-500" />
                  <rect x="146" y="178" width="8" height="8" className="fill-emerald-500" />
                  <rect x="162" y="178" width="8" height="8" className="fill-emerald-500" />
                  <rect x="178" y="178" width="8" height="8" className="fill-emerald-500" />
                  {/* Center label */}
                  <rect x="82" y="132" width="36" height="36" rx="4" className="fill-white" />
                  <text x="100" y="156" textAnchor="middle" className="fill-emerald-600" fontSize="10" fontWeight="bold">QW</text>
                </svg>
              </div>
              {/* Ticket Info Display */}
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                  <span className="text-xs text-muted-foreground">{t('myQueue')}</span>
                  <span className="text-sm font-bold text-foreground">{qrReservation.queueNumber}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-800">
                  <span className="text-xs text-muted-foreground">{getAgencyName(qrReservation)}</span>
                  <span className="text-sm font-medium text-foreground">#{qrReservation.position}</span>
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full rounded-xl gap-2"
                onClick={() => {
                  toast.info(t('comingSoon'));
                }}
              >
                <QrCode className="h-4 w-4" />
                {t('downloadQR')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Emergency Cancel AlertDialog */}
      <AlertDialog open={emergencyDialogOpen} onOpenChange={onEmergencyDialogChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-rose-600">
              <ShieldAlert className="h-5 w-5" />
              {t('emergencyCancel')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('emergencyCancelDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (emergencyResId) {
                  onCancel(emergencyResId);
                }
                onEmergencyDialogChange(false);
              }}
            >
              {t('emergencyCancelConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Leave Queue Confirmation AlertDialog */}
      <AlertDialog open={leaveDialogOpen} onOpenChange={onLeaveDialogChange}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-rose-500" />
              {t('leaveQueueConfirm') || 'Leave Queue?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('leaveQueueDesc') || 'Are you sure you want to leave the queue? This action cannot be undone and you will lose your position.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={onLeaveQueue}
              disabled={cancellingLeaving}
            >
              {cancellingLeaving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('leaving') || 'Leaving...'}
                </span>
              ) : (
                t('leaveQueue') || 'Leave Queue'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Phase 7d: Cancel Reservation Confirmation AlertDialog */}
      <AlertDialog open={cancelDialogOpen} onOpenChange={onCancelDialogChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <XCircle className="h-5 w-5" />
              {t('cancelReservation') || 'Cancel Reservation?'}
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
                  onCancel(cancelResId);
                }
                onCancelDialogChange(false);
              }}
              disabled={cancelling === cancelResId}
            >
              {cancelling === cancelResId ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('cancelling')}
                </span>
              ) : (
                t('cancelReservation') || 'Cancel Reservation'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Postpone Turn Dialog */}
      <Dialog open={postponeDialogOpen} onOpenChange={onPostponeDialogChange}>
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
              <div className="flex items-center gap-3">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    onClick={() => onPostponePositionsChange(n)}
                    className={`h-9 w-9 rounded-lg text-sm font-semibold transition-all duration-200 ${
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
            <Button variant="outline" onClick={() => onPostponeDialogChange(false)} disabled={postponeLoading} className="rounded-xl">
              {lang === 'ar' ? 'إلغاء' : lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button
              onClick={onPostponeConfirm}
              disabled={postponeLoading}
              className="bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl gap-1.5"
            >
              {postponeLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDown className="h-4 w-4" />}
              {t('postponeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
