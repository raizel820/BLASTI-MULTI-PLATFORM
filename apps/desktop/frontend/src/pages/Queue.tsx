import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
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
  Clock,
  Users,
  CheckCircle2,
  AlertTriangle,
  PhoneCall,
  Pause,
  Play,
  UserPlus,
  QrCode,
  Loader2,
  RefreshCw,
} from 'lucide-react';

// Shared dashboard sub-components
import { QueueControls } from '@/components/agency/dashboard/queue-controls';
import { WaitingList } from '@/components/agency/dashboard/waiting-list';
import { CounterManagement } from '@/components/agency/dashboard/counter-management';
import { QueueTimeline } from '@/components/agency/dashboard/queue-timeline';
import { TodaysSummary } from '@/components/agency/dashboard/todays-summary';
import { ETABadge } from '@/components/agency/dashboard/eta-badge';
import { ServiceBreakdown } from '@/components/agency/dashboard/service-breakdown';
import { useDashboardData } from '@/components/agency/dashboard/use-dashboard-data';

export default function QueuePage() {
  const {
    t,
    lang,
    stats,
    waitingList,
    serviceStats,
    loading,
    actionLoading,
    currentlyServed,
    waitingOnly,
    served,
    safeCompletionRate,
    maxWaiting,
    queueProgress,
    waitLevel,
    waitLevelConfig,
    lastUpdatedStr,
    sparkData1,
    sparkData2,
    sparkData3,
    batchMode,
    selectedIds,
    walkInOpen,
    walkInName,
    walkInServiceId,
    walkInLoading,
    showQrModal,
    qrCodeDataUrl,
    agencyCode,
    fetchData,
    handleCallNext,
    handleTogglePause,
    handleAction,
    toggleBatchSelection,
    exitBatchMode,
    setBatchMode,
    setWalkInOpen,
    setWalkInName,
    setWalkInServiceId,
    setShowQrModal,
    handleAddWalkIn,
  } = useDashboardData();

  const avgWait = stats?.avgWaitTime ?? 0;
  const totalToday = stats?.todayReservations ?? 0;
  const calledEntries = useMemo(() => waitingList.filter(e => e.status === 'CALLED'), [waitingList]);

  // ─── Loading State ─────────────────────────
  if (loading) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-2xl" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Skeleton className="h-72 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* ═══ Page Header ═══ */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
      >
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Clock className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">
              {t('queueManagement')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('queuePageDesc' as any) || 'Manage your queue, counters, and customer flow'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={`text-xs px-2.5 py-0.5 h-6 border-2 ${
              stats?.isPaused
                ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
                : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
            }`}
          >
            {stats?.isPaused ? (
              <><Pause className="h-3 w-3 me-1" />{t('queuePausedLabel')}</>
            ) : (
              <><Play className="h-3 w-3 me-1" />{t('queueActive')}</>
            )}
          </Badge>
          <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchData()}
              className="h-8 px-3 rounded-lg gap-1.5 text-xs"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('refresh')}
            </Button>
          </motion.div>
        </div>
      </motion.div>

      {/* ═══ Section 1: Today's Summary ═══ */}
      <TodaysSummary
        stats={stats}
        safeCompletionRate={safeCompletionRate}
        sparkData1={sparkData1}
        sparkData2={sparkData2}
        sparkData3={sparkData3}
        t={t}
      />

      {/* ═══ Section 2: Queue Controls (Currently Serving + Actions) ═══ */}
      <div className="space-y-2">
        <QueueControls
          stats={stats}
          currentlyServed={currentlyServed}
          waitingOnly={waitingOnly}
          actionLoading={actionLoading}
          queueProgress={queueProgress}
          served={served}
          lastUpdatedStr={lastUpdatedStr}
          waitLevel={waitLevel}
          waitLevelConfig={waitLevelConfig}
          onCallNext={handleCallNext}
          onTogglePause={handleTogglePause}
          onAction={handleAction}
          onOpenWalkIn={() => setWalkInOpen(true)}
          onOpenQrModal={() => setShowQrModal(true)}
          lang={lang}
          t={t as any}
        />
      </div>

      {/* ═══ Section 3: Waiting List + Service Breakdown ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <WaitingList
          waitingOnly={waitingOnly}
          batchMode={batchMode}
          selectedIds={selectedIds}
          actionLoading={actionLoading}
          onAction={handleAction}
          onToggleBatchSelection={toggleBatchSelection}
          onExitBatchMode={exitBatchMode}
          onSetBatchMode={setBatchMode}
          lang={lang}
          t={t as any}
        />

        <ServiceBreakdown
          serviceStats={serviceStats}
          maxWaiting={maxWaiting}
          lang={lang}
          t={t as any}
        />
      </div>

      {/* ═══ Section 4: Counter Management + Queue Timeline ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <CounterManagement
          waitingList={waitingOnly}
          calledEntry={calledEntries}
          servedToday={served}
          avgWaitTime={avgWait}
          actionLoading={actionLoading}
          onCallNext={handleCallNext}
          onCallNextForCounter={(counterId: string) => {
            handleCallNext();
          }}
          lang={lang}
          t={t as any}
        />

        <QueueTimeline
          hourlyWaitTime={
            stats?.hourlyWaitTime &&
            Array.isArray(stats.hourlyWaitTime) &&
            stats.hourlyWaitTime.length > 0 &&
            typeof stats.hourlyWaitTime[0] === 'object'
              ? (stats.hourlyWaitTime as any[]).map((h: any) => h.avgWaitTime ?? 0)
              : undefined
          }
          avgWaitTime={avgWait}
          todayReservations={totalToday}
          servedToday={served}
          peakHour={stats?.peakHour}
          lang={lang}
          t={t as any}
        />
      </div>

      {/* ═══ Section 5: Quick Stats Footer ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.4 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-6">
                {/* Waiting */}
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-amber-500" />
                  <div>
                    <p className="text-sm font-bold text-foreground">{stats?.currentlyWaiting ?? 0}</p>
                    <p className="text-[10px] text-muted-foreground">{t('queueLengthShort')}</p>
                  </div>
                  {stats?.currentlyWaiting !== undefined && stats.currentlyWaiting > 0 && (
                    <ETABadge minutes={avgWait} lang={lang} minLabel={t('min')} />
                  )}
                </div>

                {/* Being Served */}
                <div className="flex items-center gap-2">
                  <PhoneCall className="h-4 w-4 text-sky-500" />
                  <div>
                    <p className="text-sm font-bold text-foreground">{calledEntries.length}</p>
                    <p className="text-[10px] text-muted-foreground">{t('beingServed' as any) || 'Being Served'}</p>
                  </div>
                </div>

                {/* Served Today */}
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <div>
                    <p className="text-sm font-bold text-foreground">{served}</p>
                    <p className="text-[10px] text-muted-foreground">{t('servedToday')}</p>
                  </div>
                </div>

                {/* No-Show Rate */}
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-rose-500" />
                  <div>
                    <p className="text-sm font-bold text-foreground">
                      {stats?.noShowRate ?? (stats && totalToday > 0 ? Math.round(((stats.noShowCount ?? 0) / totalToday) * 100) : 0)}%
                    </p>
                    <p className="text-[10px] text-muted-foreground">{t('noShowRateStat')}</p>
                  </div>
                </div>
              </div>

              {/* Estimated Wait */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 border border-emerald-200 dark:border-emerald-800">
                <Clock className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">~{avgWait} {t('min')}</p>
                  <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">{t('estimatedWait' as any) || 'Est. Wait'}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ═══ Walk-in Dialog ═══ */}
      <Dialog open={walkInOpen} onOpenChange={setWalkInOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-emerald-600" />
              {t('addWalkInCustomer')}
            </DialogTitle>
            <DialogDescription>
              {t('walkInDialogDesc' as any) || 'Add a walk-in customer to the queue'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="walkin-name">{t('customerName' as any) || 'Customer Name'}</Label>
              <Input
                id="walkin-name"
                value={walkInName}
                onChange={(e) => setWalkInName(e.target.value)}
                placeholder={t('enterCustomerName' as any) || 'Enter customer name'}
                className="rounded-xl"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && walkInName.trim()) handleAddWalkIn();
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="walkin-service">{t('service' as any) || 'Service'}</Label>
              <select
                id="walkin-service"
                value={walkInServiceId}
                onChange={(e) => setWalkInServiceId(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-input bg-background text-foreground text-sm"
              >
                <option value="">{t('autoDetect' as any) || 'Auto-detect'}</option>
                {serviceStats.map((s) => (
                  <option key={s.id} value={s.id}>
                    {lang === 'ar' && s.nameAr ? s.nameAr : lang === 'fr' && s.nameFr ? s.nameFr : s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWalkInOpen(false)} disabled={walkInLoading} className="rounded-xl">
              {t('cancel')}
            </Button>
            <Button
              onClick={handleAddWalkIn}
              disabled={!walkInName.trim() || walkInLoading}
              className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
            >
              {walkInLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              {t('addToQueue' as any) || 'Add to Queue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ═══ QR Code Modal ═══ */}
      <Dialog open={showQrModal} onOpenChange={setShowQrModal}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <QrCode className="h-5 w-5 text-emerald-600" />
              {t('viewQrCode')}
            </DialogTitle>
            <DialogDescription>
              {t('qrScanToJoin')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center py-4">
            {qrCodeDataUrl ? (
              <motion.img
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', stiffness: 200, damping: 20 }}
                src={qrCodeDataUrl}
                alt="Agency QR Code"
                className="w-56 h-56 rounded-xl border-4 border-emerald-100 dark:border-emerald-900 shadow-lg"
              />
            ) : (
              <Skeleton className="w-56 h-56 rounded-xl" />
            )}
            {agencyCode && (
              <Badge variant="outline" className="mt-3 text-xs font-mono">
                {agencyCode}
              </Badge>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
