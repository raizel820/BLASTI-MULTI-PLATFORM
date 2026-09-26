'use client';

// Task 37-e: real counter cards — replaces the fabricated STAFF_NAMES mock
// with the agency's ACTUAL counters (GET /api/agency/counters, enriched with
// branch names from GET /api/agency/branches — the endpoints the branches
// page / fullscreen consume). Each card shows the counter's occupation state
// (occupied-by name via counter.staff.user.fullName, or Free) and a Call Next
// button that posts { agencyId, counterId } to /api/agency/queue/call-next —
// surfacing OCCUPY_COUNTER_FIRST / PERMISSION_DENIED as friendly toasts
// (the server enforces the authority contract).

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useAppStore } from '@/store/use-app-store';
import { useAgencyAuthority } from '@/hooks/use-agency-authority';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Monitor,
  PhoneCall,
  User,
  Loader2,
  Hash,
  Lock,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-fetch';
import { unwrapListPayload } from '@/lib/list-payload';
import type { TranslationKeys } from '@/i18n';

interface CounterInfo {
  id: string;
  number: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  branchId: string | null;
  branchName: string;
  staffId: string | null;
  staffName: string | null;
  currentTicket: string | null;
  isActive: boolean;
}

interface CounterManagementProps {
  waitingList: Array<{
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
  }>;
  calledEntry: Array<{
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
  }>;
  servedToday: number;
  avgWaitTime: number;
  actionLoading: string | null;
  onCallNext: () => void;
  /** Task 37-e: the agency scope — counters are fetched for this agency. */
  agencyId?: string;
  /** Task 31 bug 5: when false (subscription not ACTIVE/TRIAL) the per-counter
   *  Call Next buttons are locked. Defaults to true so unknown state never
   *  falsely locks — the server still enforces the real gate. */
  subscriptionActive?: boolean;
  lang: string;
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
}

const COUNTER_COLORS = [
  'from-emerald-500 to-emerald-700',
  'from-teal-500 to-teal-700',
  'from-amber-500 to-amber-700',
  'from-rose-500 to-rose-700',
  'from-sky-500 to-sky-700',
  'from-violet-500 to-violet-700',
];

const COUNTER_BG_COLORS = [
  'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800',
  'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800',
  'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
  'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800',
  'bg-sky-50 dark:bg-sky-900/20 border-sky-200 dark:border-sky-800',
  'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800',
];

export function CounterManagement({
  servedToday,
  avgWaitTime,
  onCallNext,
  agencyId,
  subscriptionActive = true,
  lang,
  t,
}: CounterManagementProps) {
  const user = useAppStore((s) => s.user);
  const { authority } = useAgencyAuthority();
  const effectiveAgencyId = agencyId || user?.agencyId || '';

  const [counters, setCounters] = useState<CounterInfo[]>([]);
  const [loadingCounters, setLoadingCounters] = useState(true);
  const [callingCounterId, setCallingCounterId] = useState<string | null>(null);

  const myStaffId = authority?.staffId ?? null;
  const isOwnerCaller = authority?.isOwner === true || user?.role === 'AGENCY_OWNER' || user?.role === 'SUPER_ADMIN';

  const fetchCounters = useCallback(async () => {
    if (!effectiveAgencyId) {
      setLoadingCounters(false);
      return;
    }
    try {
      // Counters + branches in parallel (same endpoints the branches page and
      // the fullscreen console consume). Dual-envelope tolerant: the cloud
      // returns { counters } / { branches }, the desktop local API returns
      // { data } for the agency-wide counters list.
      const [cRes, bRes] = await Promise.all([
        apiFetch(`/api/agency/counters?agencyId=${encodeURIComponent(effectiveAgencyId)}`),
        apiFetch(`/api/agency/branches?agencyId=${encodeURIComponent(effectiveAgencyId)}`).catch(() => null),
      ]);
      const branchNames = new Map<string, string>();
      if (bRes && bRes.ok) {
        const bData = await bRes.json();
        // Task 45 root cause: the local dual envelope arrives UNWRAPPED as a
        // raw array (see list-payload.ts) — accept every outcome.
        const branches = unwrapListPayload<{ id: string; name: string }>(bData, ['branches', 'data']);
        branches.forEach((b) => branchNames.set(b.id, b.name));
      }
      if (cRes.ok) {
        const cData = await cRes.json();
        // Task 45 root cause: same unwrap collapse as the branch list.
        const raw = unwrapListPayload<Record<string, unknown>>(cData, ['counters', 'data']);
        setCounters(
          raw.map((c) => {
            const staff = c.staff as { user?: { fullName?: string; username?: string } } | null | undefined;
            const reservation = c.currentReservation as { displayNumber?: string; status?: string } | null | undefined;
            const branchId = typeof c.branchId === 'string' ? c.branchId : null;
            return {
              id: String(c.id),
              number: Number(c.number ?? 0),
              name: String(c.name ?? ''),
              nameAr: (c.nameAr as string | null) ?? null,
              nameFr: (c.nameFr as string | null) ?? null,
              branchId,
              branchName: (branchId ? branchNames.get(branchId) : '') || '',
              staffId: (c.staffId as string | null) ?? null,
              staffName: staff?.user?.fullName ?? null,
              // Only a CALLED reservation counts as "serving" on this counter.
              currentTicket:
                reservation && reservation.status === 'CALLED'
                  ? reservation.displayNumber ?? null
                  : null,
              isActive: c.isActive !== false,
            };
          })
        );
      }
    } catch {
      // silent — the card renders its empty state; the server still gates
    } finally {
      setLoadingCounters(false);
    }
  }, [effectiveAgencyId]);

  useEffect(() => {
    fetchCounters();
    // Lightweight refresh cadence — this is a dashboard card, not a console.
    const interval = setInterval(fetchCounters, 20_000);
    return () => clearInterval(interval);
  }, [fetchCounters]);

  const localizeCounterName = (c: CounterInfo) => {
    if (lang === 'ar' && c.nameAr) return c.nameAr;
    if (lang === 'fr' && c.nameFr) return c.nameFr;
    return c.name || `#${c.number}`;
  };

  const handleCallNextForCounter = async (counterId: string) => {
    if (!effectiveAgencyId) return;
    setCallingCounterId(counterId);
    try {
      const res = await apiFetch('/api/agency/queue/call-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencyId: effectiveAgencyId, counterId }),
      });
      if (res.ok) {
        toast.success(t('statusCalled'));
        fetchCounters();
        onCallNext();
      } else {
        const data = await res.json().catch(() => ({}));
        // Task 37-c contract: friendly toasts for the authority errors.
        if (data.error === 'OCCUPY_COUNTER_FIRST') {
          toast.error(t('occupyFirst'));
        } else if (typeof data.error === 'string' && data.error.startsWith('PERMISSION_DENIED')) {
          toast.error(t('counterPermissionDenied'));
        } else if (data.error === 'COUNTER_OCCUPIED') {
          toast.error(t('counterOccupied'));
          fetchCounters();
        } else {
          toast.error(data.error || t('noQueue'));
        }
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setCallingCounterId(null);
    }
  };

  const occupiedCounters = counters.filter((c) => c.staffId).length;
  const freeCounters = counters.length - occupiedCounters;

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.22 }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50 h-full">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Monitor className="h-4 w-4 text-emerald-600" />
              {t('counterManagement' as any) || 'Service Counters'}
              <Badge variant="secondary" className="text-xs">{counters.length}</Badge>
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-[10px] text-muted-foreground">{occupiedCounters} {t('active' as any) || 'active'}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" />
                <span className="text-[10px] text-muted-foreground">{freeCounters} {t('idle' as any) || 'idle'}</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2.5 max-h-96 overflow-y-auto custom-scrollbar">
            {loadingCounters && counters.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{t('loading' as any) || '...'}</p>
            ) : counters.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{t('noData' as any)}</p>
            ) : (
              counters.map((counter, idx) => {
                const occupiedByOther =
                  !!counter.staffId && !isOwnerCaller && counter.staffId !== myStaffId;
                return (
                  <motion.div
                    key={counter.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(idx * 0.06, 0.3) }}
                    className={`relative rounded-xl border p-3 transition-all duration-200 ${COUNTER_BG_COLORS[idx % COUNTER_BG_COLORS.length]} ${
                      counter.currentTicket ? 'ring-1 ring-emerald-300/50 dark:ring-emerald-700/50' : ''
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Counter Number Badge */}
                      <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${COUNTER_COLORS[idx % COUNTER_COLORS.length]} flex items-center justify-center flex-shrink-0 shadow-md`}>
                        <span className="text-sm font-black text-white">{counter.number}</span>
                      </div>

                      {/* Counter Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-semibold text-foreground truncate max-w-[120px]">
                            {localizeCounterName(counter)}
                          </span>
                          {counter.branchName && (
                            <span className="text-[10px] text-muted-foreground truncate max-w-[100px]">
                              · {counter.branchName}
                            </span>
                          )}
                          {/* Occupation state — real staff relation */}
                          {counter.staffId ? (
                            <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 text-[9px] px-1.5 py-0 h-4 border-0">
                              <User className="h-2.5 w-2.5 me-0.5" />
                              {counter.staffName
                                ? t('counterOccupiedBy', { name: counter.staffName })
                                : t('counterOccupied')}
                            </Badge>
                          ) : (
                            <Badge className="bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400 text-[9px] px-1.5 py-0 h-4 border-0">
                              {t('counterFree')}
                            </Badge>
                          )}
                          {counter.currentTicket && (
                            <Badge className="bg-white/80 dark:bg-gray-900/60 text-emerald-700 dark:text-emerald-400 text-[9px] px-1.5 py-0 h-4 border border-emerald-200 dark:border-emerald-800">
                              {t('serving' as any) || 'Serving'}
                            </Badge>
                          )}
                        </div>

                        {/* Current Ticket Info */}
                        {counter.currentTicket ? (
                          <div className="flex items-center gap-2 mt-1">
                            <div className="flex items-center gap-1">
                              <Hash className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                              <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{counter.currentTicket}</span>
                            </div>
                          </div>
                        ) : (
                          <p className="text-[10px] text-muted-foreground mt-1">{t('noTicketBeingServed' as any)}</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {occupiedByOther ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="cursor-not-allowed">
                                <Button
                                  size="sm"
                                  disabled
                                  className="h-8 px-3 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-700 text-white text-xs font-semibold gap-1 shadow-sm disabled:opacity-50"
                                >
                                  <Lock className="h-3 w-3" />
                                  <span className="hidden sm:inline">{t('callNext')}</span>
                                </Button>
                              </div>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[220px]">
                              {counter.staffName
                                ? t('counterOccupiedBy', { name: counter.staffName })
                                : t('counterOccupied')}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className={!subscriptionActive ? 'cursor-not-allowed' : undefined}>
                                <Button
                                  size="sm"
                                  onClick={() => { if (subscriptionActive) handleCallNextForCounter(counter.id); }}
                                  disabled={!!callingCounterId || !subscriptionActive}
                                  className="h-8 px-3 rounded-lg bg-gradient-to-r from-emerald-500 to-emerald-700 hover:from-emerald-600 hover:to-emerald-800 text-white text-xs font-semibold gap-1 shadow-sm disabled:opacity-50"
                                >
                                  {callingCounterId === counter.id ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : !subscriptionActive ? (
                                    <Lock className="h-3 w-3" />
                                  ) : (
                                    <PhoneCall className="h-3 w-3" />
                                  )}
                                  <span className="hidden sm:inline">{t('callNext')}</span>
                                </Button>
                              </motion.div>
                            </TooltipTrigger>
                            {!subscriptionActive && (
                              <TooltipContent>{t('subscriptionLockedTooltip')}</TooltipContent>
                            )}
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })
            )}
          </div>

          {/* Summary */}
          <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-sm font-bold text-foreground">{counters.length}</p>
                <p className="text-[9px] text-muted-foreground">{t('totalCounters' as any)}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{servedToday}</p>
                <p className="text-[9px] text-muted-foreground">{t('served' as any) || 'served'}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-foreground">~{avgWaitTime}{t('min')}</p>
                <p className="text-[9px] text-muted-foreground">{t('avgServiceTimeLabel') || 'Avg. Service'}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
