'use client';

import { useState } from 'react';
import {
  Users,
  Clock,
  CheckCircle2,
  Play,
  Pause,
  PhoneCall,
  UserX,
  XCircle,
  Loader2,
  Radio,
  Activity,
  UserPlus,
  QrCode,
  Plus,
  Lock,
  ArrowRight,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
import type { TranslationKeys } from '@/i18n';
import type { DashboardStats, QueueEntry } from './types';
import { AnimatedCounter, getServiceName, formatTime } from './helpers';

interface QueueControlsProps {
  stats: DashboardStats | null;
  currentlyServed: QueueEntry | undefined;
  waitingOnly: QueueEntry[];
  actionLoading: string | null;
  queueProgress: number;
  served: number;
  lastUpdatedStr: string;
  waitLevel: 'low' | 'medium' | 'high';
  waitLevelConfig: Record<string, { label: string; dotColor: string }>;
  onCallNext: () => void;
  onTogglePause: () => void;
  onAction: (entryId: string, action: 'complete' | 'no_show' | 'cancel') => void;
  onOpenWalkIn: () => void;
  onOpenQrModal: () => void;
  lang: string;
  t: (key: TranslationKeys) => string;
}

export function QueueControls({
  stats,
  currentlyServed,
  waitingOnly,
  actionLoading,
  queueProgress,
  served,
  lastUpdatedStr,
  waitLevel,
  waitLevelConfig,
  onCallNext,
  onTogglePause,
  onAction,
  onOpenWalkIn,
  onOpenQrModal,
  lang,
  t,
}: QueueControlsProps) {
  // Phase 7d: Confirmation dialog state for destructive actions
  const [confirmAction, setConfirmAction] = useState<{
    type: 'cancel' | 'no-show';
    reservationId: string;
    displayNumber: string;
  } | null>(null);

  const handleConfirmAction = () => {
    if (confirmAction) {
      const actionType = confirmAction.type === 'cancel' ? 'cancel' : 'no_show';
      onAction(confirmAction.reservationId, actionType);
      setConfirmAction(null);
    }
  };

  return (
    <>
      {/* AlertDialog for destructive action confirmation — Phase 7d */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === 'cancel' ? t('cancelRes') : t('markNoShow')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.type === 'cancel'
                ? `${t('confirmCancelTicket' as any)} ${confirmAction.displayNumber}? ${t('actionCannotBeUndone' as any)}`
                : `${t('confirmNoShowTicket' as any)} ${confirmAction.displayNumber} ${t('asNoShow' as any)}? ${t('actionCannotBeUndone' as any)}`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('goBack' as any)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmAction}
              className={confirmAction?.type === 'cancel' ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-amber-600 hover:bg-amber-700 text-white'}
            >
              {confirmAction?.type === 'cancel' ? t('cancelRes') : t('markNoShow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* ─── CURRENTLY SERVING CARD ─── */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 }}>
        <Card className="border-0 shadow-sm overflow-hidden bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <div className="relative bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 px-4 py-5 sm:py-6">
            {/* Decorative */}
            <div className="absolute top-0 end-0 h-24 w-24 rounded-full bg-white/5 -translate-y-8 translate-x-8" />
            <div className="absolute bottom-0 start-0 h-16 w-16 rounded-full bg-white/5 translate-y-6 -translate-x-6" />

            {/* Pulse ring */}
            {!stats?.isPaused && (
              <motion.div className="absolute start-4 top-4 h-3 w-3 rounded-full bg-emerald-300"
                animate={{ boxShadow: ['0 0 0 0 rgba(110, 231, 183, 0.6)', '0 0 0 12px rgba(110, 231, 183, 0)', '0 0 0 0 rgba(110, 231, 183, 0)'] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
              />
            )}

            <div className="relative">
              {/* Header row */}
              <div className="flex items-center gap-2 mb-3">
                <Radio className="h-4 w-4 text-emerald-200" />
                <p className="text-emerald-100 text-sm font-semibold">{t('currentlyServing')}</p>
                <Badge className={`text-[9px] px-1.5 py-0 h-4 ${stats?.isPaused ? 'bg-amber-400/30 text-amber-100 border-amber-400/30' : 'bg-emerald-400/30 text-emerald-100 border-emerald-400/30'}`}>
                  {stats?.isPaused ? t('queuePausedLabel') : t('queueActive')}
                </Badge>
                <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }} className="flex items-center gap-1 ms-auto">
                  <span className={`h-1.5 w-1.5 rounded-full ${waitLevelConfig[waitLevel].dotColor}`} />
                  <span className="text-[10px] text-emerald-200">{waitLevelConfig[waitLevel].label}</span>
                </motion.div>
              </div>

              {currentlyServed ? (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  {/* Customer info */}
                  <div className="flex items-center gap-4">
                    <motion.div key={currentlyServed.queueNumber} initial={{ y: -10, opacity: 0, scale: 0.9 }} animate={{ y: 0, opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 20 }} className="min-h-16 min-w-16 px-3 py-2 rounded-2xl bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/20">
                      <span className="text-2xl sm:text-3xl font-black text-white ticket-glow">{currentlyServed.queueNumber}</span>
                    </motion.div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-xl sm:text-2xl font-bold text-white">{currentlyServed.customerName}</h2>
                        {currentlyServed.isWalkIn && <Badge className="bg-amber-400/30 text-amber-100 border-amber-400/30 text-[10px] px-1.5 py-0 h-5">{t('walkInBadge')}</Badge>}
                      </div>
                      <p className="text-sm text-emerald-200 mt-0.5">{getServiceName(currentlyServed, lang)}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Clock className="h-3 w-3 text-emerald-300" />
                        <span className="text-xs text-emerald-200/80">{t('calledAt' as any)} {formatTime(currentlyServed.joinedAt, lang)}</span>
                      </div>
                    </div>
                  </div>
                  {/* Action buttons */}
                  <div className="flex items-center gap-2">
                    <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                      <Button onClick={() => onAction(currentlyServed.id, 'complete')} disabled={!!actionLoading} className="h-11 px-5 rounded-xl bg-emerald-400 hover:bg-emerald-300 text-emerald-900 font-bold text-sm gap-2 shadow-lg shadow-emerald-500/30">
                        {actionLoading === `${currentlyServed.id}-complete` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                        {t('completeService' as any)}
                      </Button>
                    </motion.div>
                    <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                      <Button onClick={() => setConfirmAction({ type: 'no-show', reservationId: currentlyServed.id, displayNumber: currentlyServed.queueNumber })} disabled={!!actionLoading} variant="outline" className="h-11 px-4 rounded-xl border-2 border-amber-300 bg-amber-500/20 text-amber-100 hover:bg-amber-500/30 font-semibold text-sm gap-2">
                        {actionLoading === `${currentlyServed.id}-no_show` ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
                        {t('markNoShow')}
                      </Button>
                    </motion.div>
                    <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                      <Button onClick={() => setConfirmAction({ type: 'cancel', reservationId: currentlyServed.id, displayNumber: currentlyServed.queueNumber })} disabled={!!actionLoading} variant="outline" className="h-11 px-3 rounded-xl border-2 border-red-400/50 bg-red-500/10 text-red-200 hover:bg-red-500/20 text-sm gap-1.5">
                        {actionLoading === `${currentlyServed.id}-cancel` ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                        <span className="hidden sm:inline">{t('cancelRes')}</span>
                      </Button>
                    </motion.div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="h-16 w-16 rounded-2xl bg-white/10 backdrop-blur-sm flex items-center justify-center border border-white/20 border-dashed">
                      <span className="text-3xl font-black text-white/40">—</span>
                    </div>
                    <div>
                      <h2 className="text-lg sm:text-xl font-semibold text-white/80">{t('noCustomerBeingServed' as any)}</h2>
                      <p className="text-sm text-emerald-200/60 mt-0.5">
                        {waitingOnly.length > 0 ? `${waitingOnly.length} ${t('waitingLabel')} · ${t('nextUp' as any)}: ${waitingOnly[0]?.queueNumber || ''}` : t('noQueue')}
                      </p>
                    </div>
                  </div>
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                    <Button onClick={onCallNext} disabled={actionLoading === 'call' || stats?.isPaused || (stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE')} className="h-12 px-6 rounded-xl bg-emerald-400 hover:bg-emerald-300 text-emerald-900 font-bold text-sm gap-2 shadow-lg shadow-emerald-500/30">
                      {actionLoading === 'call' ? <Loader2 className="h-5 w-5 animate-spin" /> : <PhoneCall className="h-5 w-5" />}
                      {t('callNext')}
                      <ArrowRight className="h-4 w-4 rtl:rotate-180" />
                    </Button>
                  </motion.div>
                </div>
              )}

              {/* Progress bar */}
              <div className="mt-4 max-w-full">
                <div className="flex items-center justify-between text-[10px] text-emerald-200/70 mb-1">
                  <span>{t('queueProgress')}</span><span>{Math.round(queueProgress)}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-white/20 overflow-hidden">
                  <motion.div initial={{ width: 0 }} animate={{ width: `${queueProgress}%` }} transition={{ duration: 0.8, ease: 'easeOut' }} className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-teal-300 to-cyan-300" />
                </div>
                <div className="flex items-center justify-between text-[9px] text-emerald-200/50 mt-1">
                  <span>{served} {t('servedLabel')}</span>
                  <div className="flex items-center gap-1.5">
                    <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 3, repeat: Infinity , ease: 'easeInOut' }} className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                    {t('autoRefreshActive')}
                    <span className="ms-1">{t('lastRefreshed')}: {lastUpdatedStr}</span>
                  </div>
                  <span>{stats?.currentlyWaiting ?? 0} {t('waitingLabel')}</span>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </motion.div>

      {/* ─── Quick Actions Bar ─── */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
        <div className="flex flex-wrap gap-2">
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={onCallNext} disabled={actionLoading === 'call' || stats?.isPaused || (stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE')} className="h-11 px-4 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white font-semibold shadow-lg shadow-emerald-500/20 gap-2 disabled:opacity-50">
              {actionLoading === 'call' ? <Loader2 className="h-4 w-4 animate-spin" /> : stats?.subscriptionStatus !== undefined && stats.subscriptionStatus !== 'ACTIVE' ? <Lock className="h-4 w-4" /> : <PhoneCall className="h-4 w-4" />}
              <span className="text-sm">{t('callNext')}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={onTogglePause} disabled={actionLoading === 'pause'} variant="outline" className={`h-11 px-4 rounded-xl font-semibold gap-2 border-2 ${stats?.isPaused ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100' : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400 hover:bg-amber-100'}`}>
              {actionLoading === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : stats?.isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              <span className="text-sm">{stats?.isPaused ? t('resumeQueue') : t('pauseQueue')}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={onOpenWalkIn} variant="outline" className="h-11 px-4 rounded-xl font-semibold gap-2 border-2 border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-900/20 dark:text-rose-400 hover:bg-rose-100">
              <UserPlus className="h-4 w-4" /><span className="text-sm">{t('addWalkInCustomer')}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={onOpenQrModal} variant="outline" className="h-11 px-4 rounded-xl font-semibold gap-2 border-2 border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-700 dark:bg-teal-900/20 dark:text-teal-400 hover:bg-teal-100">
              <QrCode className="h-4 w-4" /><span className="text-sm">{t('viewQrCode')}</span>
            </Button>
          </motion.div>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Button onClick={() => { const event = new CustomEvent('navigate', { detail: 'services' }); window.dispatchEvent(event); }} variant="outline" className="h-11 px-3 rounded-xl font-semibold gap-1.5 border-2 border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-900/20 dark:text-sky-400 hover:bg-sky-100">
              <Plus className="h-4 w-4" /><span className="text-sm hidden sm:inline">{t('addService')}</span>
            </Button>
          </motion.div>
        </div>
      </motion.div>

      {/* ─── Queue Status Indicator (Glass-morphism) ─── */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.07 }}>
        <div className="relative rounded-2xl overflow-hidden bg-white/70 dark:bg-gray-900/60 backdrop-blur-xl border border-white/30 dark:border-gray-700/30 shadow-lg">
          <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/10 via-teal-500/5 to-transparent pointer-events-none" />
          <div className="relative p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <h3 className="text-sm font-bold text-foreground">{t('queueStatus')}</h3>
              </div>
              <div className="flex items-center gap-2">
                <motion.div
                  animate={{ scale: [1, 1.3, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                  className={`h-3 w-3 rounded-full ${
                    stats?.isPaused ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]'
                  }`}
                />
                <span className={`text-xs font-semibold ${stats?.isPaused ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {stats?.isPaused ? t('queuePausedStatusLabel') : t('queueOpenStatus')}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <div className="text-center p-2.5 rounded-xl bg-emerald-50/80 dark:bg-emerald-900/20 backdrop-blur-sm">
                <Users className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mx-auto mb-1" />
                <motion.p
                  key={stats?.currentlyWaiting ?? 0}
                  initial={{ scale: 1.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="text-xl font-black text-emerald-700 dark:text-emerald-400"
                >
                  <AnimatedCounter value={stats?.currentlyWaiting ?? 0} />
                </motion.p>
                <p className="text-[9px] text-muted-foreground">{t('queueLengthShort')}</p>
              </div>
              <div className="text-center p-2.5 rounded-xl bg-teal-50/80 dark:bg-teal-900/20 backdrop-blur-sm">
                <Clock className="h-4 w-4 text-teal-600 dark:text-teal-400 mx-auto mb-1" />
                <motion.p
                  key={stats?.avgWaitTime ?? 0}
                  initial={{ scale: 1.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="text-xl font-black text-teal-700 dark:text-teal-400"
                >
                  ~<AnimatedCounter value={stats?.avgWaitTime ?? 0} />
                </motion.p>
                <p className="text-[9px] text-muted-foreground">{t('min')}</p>
              </div>
              <div className="text-center p-2.5 rounded-xl bg-amber-50/80 dark:bg-amber-900/20 backdrop-blur-sm">
                <CheckCircle2 className="h-4 w-4 text-amber-600 dark:text-amber-400 mx-auto mb-1" />
                <motion.p
                  key={stats?.servedToday ?? 0}
                  initial={{ scale: 1.3, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="text-xl font-black text-amber-700 dark:text-amber-400"
                >
                  <AnimatedCounter value={stats?.servedToday ?? 0} />
                </motion.p>
                <p className="text-[9px] text-muted-foreground">{t('servedToday')}</p>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <motion.div
                  animate={{ opacity: [0.4, 1, 0.4] }}
                  transition={{ duration: 2, repeat: Infinity , ease: 'easeInOut' }}
                  className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                />
                <span className="text-[10px] text-muted-foreground">{t('autoRefreshActive')} · {lastUpdatedStr}</span>
              </div>
              <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
                <Button
                  onClick={onTogglePause}
                  disabled={actionLoading === 'pause'}
                  variant="outline"
                  size="sm"
                  className={`h-8 px-3 rounded-lg gap-1.5 text-xs font-semibold border-2 ${
                    stats?.isPaused
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 hover:bg-emerald-100'
                      : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400 hover:bg-amber-100'
                  }`}
                >
                  {actionLoading === 'pause' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : stats?.isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {stats?.isPaused ? t('resumeQueue') : t('pauseQueue')}
                </Button>
              </motion.div>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}
