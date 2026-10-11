'use client';

// ─── Task 54-d: Today's Queue section (doc-2 §32) ────────────────────────────
// GET /api/staff/analytics/today-queue — FIXED-TODAY operational view (no
// period selector). Primarily operational: queue status badges, waiting /
// called / serving counters, next + serving tickets, average current wait and
// today's completed / no-show totals. Waiting/called lists are agency-wide
// (payload `scope.note`); served counts respect the branch/counter scope.

import { useLanguage } from '@/hooks/use-language';
import { CheckCircle2, ListOrdered, Radio, Ticket, Timer, UserX, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  SectionStatePanels,
  StatTiles,
} from '@/components/admin/analytics/section-ui';
import { ak } from './i18n-keys';
import type { StaffTodayQueueData } from './staff-types';
import { useStaffSectionData, type StaffSectionQuery } from './use-staff-section-data';
import { StaffForbiddenPanel } from './staff-forbidden';

export function StaffTodayQueueSection({ query }: { query: StaffSectionQuery }) {
  const { t, lang } = useLanguage();
  const { data, state, refresh, isQueryReady } = useStaffSectionData<StaffTodayQueueData>(
    'today-queue',
    query,
    {
      // Zero-safe: live counters exist even for an idle agency — only mark
      // empty when the queue is closed AND nothing is live AND no tickets
      // completed today (a servingCustomer counts as live).
      isEmpty: (d) =>
        !d.queueStatus?.isQueueOpen &&
        (d.live?.queueLength ?? 0) === 0 &&
        !d.live?.servingCustomer &&
        (d.live?.currentlyCalled ?? 0) === 0 &&
        (d.today?.ticketsCompleted ?? 0) === 0 &&
        (d.today?.noShows ?? 0) === 0,
    },
  );

  if (state === 'forbidden') return <StaffForbiddenPanel />;
  if (state !== 'ready' || !data) {
    return <SectionStatePanels state={state} onRetry={refresh} isQueryReady={isQueryReady} customHint="" />;
  }

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const { queueStatus, live, today } = data;

  const joinedAtLabel = (iso: string | undefined): string | null => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleTimeString(
        lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-FR' : 'en-US',
        { hour: '2-digit', minute: '2-digit' },
      );
    } catch {
      return null;
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Queue status strip (§32: queue status + pause status) ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0 shadow-sm shadow-emerald-500/20">
              <Radio className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-black text-foreground">{t(ak('staffAnalytics.queue.liveTitle'))}</p>
                <Badge
                  className={`text-[10px] h-5 shrink-0 ${
                    queueStatus.isPaused
                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                      : queueStatus.isQueueOpen
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                        : 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
                  }`}
                >
                  {queueStatus.isPaused
                    ? t(ak('staffAnalytics.queue.paused'))
                    : queueStatus.isQueueOpen
                      ? t(ak('staffAnalytics.queue.open'))
                      : t(ak('staffAnalytics.queue.closed'))}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground truncate">
                {t(ak('staffAnalytics.queue.lastIssued'))}: <span dir="ltr" className="font-bold">{safe(queueStatus.lastIssuedNumber).toLocaleString()}</span>
              </p>
            </div>
          </div>
          <div className="sm:ms-auto flex items-center gap-4 sm:gap-6 shrink-0">
            {live.servingCustomer ? (
              <div className="text-end">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t(ak('staffAnalytics.queue.servingTicket'))}
                </p>
                <p className="text-lg font-black text-teal-600 dark:text-teal-400 leading-none" dir="ltr">
                  {live.servingCustomer.displayNumber}
                </p>
              </div>
            ) : null}
            {live.nextTicket ? (
              <div className="text-end">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t(ak('staffAnalytics.queue.nextTicket'))}
                </p>
                <p className="text-lg font-black text-foreground leading-none" dir="ltr">
                  {live.nextTicket.displayNumber}
                </p>
                {joinedAtLabel(live.nextTicket.joinedAt) && (
                  <p className="text-[10px] text-muted-foreground" dir="ltr">{joinedAtLabel(live.nextTicket.joinedAt)}</p>
                )}
              </div>
            ) : (
              !live.servingCustomer && (
                <p className="text-[11px] text-muted-foreground">{t(ak('staffAnalytics.queue.noNextTicket'))}</p>
              )
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Live counters + today totals (§32 metrics) ── */}
      <StatTiles
        items={[
          {
            icon: Users,
            iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
            label: t(ak('staffAnalytics.queue.waitingNow')),
            value: safe(live.currentlyWaiting),
          },
          {
            icon: ListOrdered,
            iconClass: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
            label: t(ak('staffAnalytics.queue.queueLength')),
            value: safe(live.queueLength),
          },
          {
            icon: Users,
            iconClass: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
            label: t(ak('staffAnalytics.queue.calledNow')),
            value: safe(live.currentlyCalled),
          },
          {
            icon: Timer,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('staffAnalytics.queue.avgCurrentWait')),
            value: live.avgCurrentWaitMinutes === null ? 0 : safe(live.avgCurrentWaitMinutes),
            text: live.avgCurrentWaitMinutes === null ? '—' : undefined,
            decimals: live.avgCurrentWaitMinutes === null ? undefined : 0,
            suffix: live.avgCurrentWaitMinutes === null ? undefined : ` ${t('min')}`,
          },
          {
            icon: CheckCircle2,
            iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
            label: t(ak('staffAnalytics.queue.completedToday')),
            value: safe(today.ticketsCompleted),
          },
          {
            icon: UserX,
            iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
            label: t('statusNoShow'),
            value: safe(today.noShows),
          },
        ]}
      />

      {/* ── Called tickets (§32: called customers) ── */}
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-teal-600 flex items-center justify-center shrink-0">
              <Ticket className="h-4 w-4 text-white" />
            </div>
            <p className="text-sm font-semibold">{t(ak('staffAnalytics.queue.calledList'))}</p>
            <Badge variant="secondary" className="text-[10px] h-5 ms-auto shrink-0" dir="ltr">
              {safe(live.currentlyCalled).toLocaleString()}
            </Badge>
          </div>
          {(live.calledTickets ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">{t(ak('staffAnalytics.queue.noCalled'))}</p>
          ) : (
            <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto custom-scrollbar" role="list">
              {(live.calledTickets ?? []).map((ticket) => (
                <div
                  key={ticket.id}
                  role="listitem"
                  className="inline-flex items-center gap-2 rounded-xl border border-border bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1.5"
                >
                  <span className="text-sm font-black text-emerald-700 dark:text-emerald-400" dir="ltr">
                    {ticket.displayNumber}
                  </span>
                  {joinedAtLabel(ticket.joinedAt) && (
                    <span className="text-[10px] text-muted-foreground" dir="ltr">{joinedAtLabel(ticket.joinedAt)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
