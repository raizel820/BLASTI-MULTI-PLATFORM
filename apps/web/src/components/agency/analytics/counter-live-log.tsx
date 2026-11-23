'use client';

/**
 * CounterLiveLog — agency-OWNER-ONLY live log of counter operations (0.6.105).
 * ────────────────────────────────────────────────────────────────────────
 * The third tab of the owner's "Branches & Counters" panel. Streams the
 * unified queue-event timeline (the SAME store the platform Logs Manager's
 * "Queue" tab reads — GET /api/agency/counter-log) scoped to THIS agency and
 * — via the branch selector — ONE branch at a time:
 *
 *   counter claim / release / control request+approve+reject / force-assign /
 *   counter CRUD / claim contention (two counters racing) / and the
 *   ticket-serving lifecycle the counters drove (claimed · recalled ·
 *   completed · no-show · cancelled · postponed · status).
 *
 * ACCESS: the endpoint is OWNER-ONLY (Agency.ownerId) or SUPER_ADMIN — staff
 * sessions get a clean 403 notice instead of the stream.
 * REFRESH: polls every 10 s + manual refresh; newest entries first.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { apiFetch } from '@/lib/api-fetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Activity, RefreshCw, Loader2, ShieldAlert, ScrollText } from 'lucide-react';
import { getLocalizedString } from '@/components/agency/devices/types';

export interface LiveLogBranchOption {
  branchId: string;
  name: string;
}

interface LiveLogEntry {
  ts: string;
  level?: string;
  event: string;
  message: string;
  counterName?: string;
  counterId?: string;
  ticketNumber?: string;
  username?: string;
  status?: string;
  serviceName?: string;
  branchId?: string;
  origin?: string;
  platform?: string;
  deviceName?: string;
}

type EventChipTone = 'amber' | 'emerald' | 'teal' | 'rose' | 'violet' | 'sky' | 'cyan' | 'slate' | 'gray';

const CHIP_CLASS: Record<EventChipTone, string> = {
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
  teal: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400',
  rose: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-400',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-950/40 dark:text-slate-400',
  gray: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

/** Colour family for one event name (counter ops first — this IS the counter log). */
function eventTone(event: string): EventChipTone {
  if (event === 'claim_contention') return 'rose';
  if (event.startsWith('counter_')) {
    if (event === 'counter_released') return 'slate';
    if (event === 'counter_control_rejected') return 'rose';
    return 'amber';
  }
  if (event === 'ticket_claimed' || event === 'ticket_recalled' || event === 'ticket_reclaimed') return 'emerald';
  if (event === 'ticket_completed' || event === 'batch_completed') return 'teal';
  if (event === 'ticket_no_show' || event === 'ticket_cancelled') return 'rose';
  if (event === 'ticket_created_online' || event === 'ticket_created_walkin' || event === 'ticket_created_kiosk' || event === 'ticket_imported') return 'violet';
  if (event.startsWith('ticket_')) return 'emerald';
  if (event.startsWith('queue_')) return 'violet';
  if (event.startsWith('sync_')) return 'sky';
  if (event.startsWith('kiosk_')) return 'cyan';
  if (event.startsWith('fullscreen_')) return 'slate';
  return 'gray';
}

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso.slice(11, 19);
  }
}

export function CounterLiveLog({
  agencyId,
  branches,
}: {
  agencyId: string | null;
  branches: LiveLogBranchOption[];
}) {
  const { lang } = useLanguage();
  const [entries, setEntries] = useState<LiveLogEntry[]>([]);
  const [branchId, setBranchId] = useState<string>('ALL');
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchLog = useCallback(async (silent = false) => {
    if (!agencyId) return;
    if (!silent) setRefreshing(true);
    try {
      const params = new URLSearchParams({ agencyId, limit: '150' });
      if (branchId && branchId !== 'ALL') params.set('branchId', branchId);
      const res = await apiFetch(`/api/agency/counter-log?${params.toString()}`, { timeout: 15000 });
      if (res.status === 403) {
        setState('forbidden');
        return;
      }
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      if (data?.success) {
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        setState('ready');
        setLastFetchAt(Date.now());
      } else {
        throw new Error(data?.error || 'failed');
      }
    } catch {
      // Network layer — only surface the error banner when we never loaded.
      setEntries((prev) => {
        if (prev.length === 0) setState('error');
        return prev;
      });
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [agencyId, branchId]);

  useEffect(() => {
    if (!agencyId) return;
    fetchLog();
    const interval = setInterval(() => fetchLog(true), 10_000);
    return () => clearInterval(interval);
  }, [agencyId, fetchLog]);

  // Branch switch → debounce one refetch (fetchLog itself re-runs via the
  // dependency above; this keeps the manual button snappy).
  useEffect(() => () => { if (fetchTimer.current) clearTimeout(fetchTimer.current); }, []);

  const summary = useMemo(() => {
    const byEvent = new Map<string, number>();
    for (const e of entries) byEvent.set(e.event, (byEvent.get(e.event) ?? 0) + 1);
    return [...byEvent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [entries]);

  if (!agencyId) return null;

  return (
    <div className="space-y-3">
      {/* Toolbar: branch selector + refresh */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={branchId} onValueChange={setBranchId}>
          <SelectTrigger className="h-8 w-[190px] text-xs" aria-label={getLocalizedString('فرع السجل', 'Succursale du journal', 'Log branch', lang)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL" className="text-xs">
              {getLocalizedString('كل الفروع', 'Toutes les succursales', 'All branches', lang)}
            </SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.branchId} value={b.branchId} className="text-xs">
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => fetchLog()}
          disabled={refreshing}
          aria-label={getLocalizedString('تحديث', 'Rafraîchir', 'Refresh', lang)}
          title={getLocalizedString('تحديث', 'Rafraîchir', 'Refresh', lang)}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin text-emerald-600' : ''}`} />
        </Button>

        {state === 'ready' && (
          <div className="flex items-center gap-2 ms-auto">
            {summary.map(([ev, n]) => (
              <Badge key={ev} variant="secondary" className={`text-[9px] h-5 px-1.5 ${CHIP_CLASS[eventTone(ev)]}`}>
                {ev.replace(/^(counter_|ticket_|queue_)/, '')} · {n}
              </Badge>
            ))}
            <Badge variant="outline" className="gap-1 text-[9px] h-5 shrink-0">
              <Activity className="h-2.5 w-2.5" />
              {entries.length}
            </Badge>
          </div>
        )}
      </div>

      {/* Body */}
      {state === 'loading' ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : state === 'forbidden' ? (
        <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground gap-2">
          <ShieldAlert className="h-8 w-8 text-amber-400 opacity-80" />
          <p className="text-sm">
            {getLocalizedString(
              'سجل العمليات المباشر متاح لحساب المالك فقط.',
              'Journal direct réservé au compte propriétaire.',
              'The live operations log is available to the owner account only.',
              lang,
            )}
          </p>
        </div>
      ) : state === 'error' ? (
        <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground gap-2">
          <ShieldAlert className="h-8 w-8 text-rose-400 opacity-80" />
          <p className="text-sm">
            {getLocalizedString(
              'تعذر تحميل السجل — تحقق من الاتصال بالمخدم.',
              'Impossible de charger le journal — vérifiez la connexion.',
              'Could not load the log — check the server connection.',
              lang,
            )}
          </p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => fetchLog()}>
            {getLocalizedString('إعادة المحاولة', 'Réessayer', 'Retry', lang)}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
          <ScrollText className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
          <p className="text-sm">
            {getLocalizedString(
              'لا توجد عمليات عدّادات بعد — ستظهر هنا فوراً عندما يستدعي موظف العميل التالي.',
              'Aucune opération de guichet — apparaîtra dès qu\'un employé appellera.',
              'No counter operations yet — they appear here the moment a staff member calls the next customer.',
              lang,
            )}
          </p>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-xl border border-border/60 divide-y divide-border/40">
          {entries.map((e, i) => {
            const tone = eventTone(e.event);
            return (
              <div key={`${e.ts}-${i}`} className="flex items-start gap-2.5 px-3 py-2 hover:bg-muted/40 transition-colors">
                <span className="text-[10px] font-mono text-muted-foreground shrink-0 pt-0.5" dir="ltr">
                  {timeLabel(e.ts)}
                </span>
                <Badge variant="secondary" className={`text-[9px] h-5 px-1.5 shrink-0 ${CHIP_CLASS[tone]}`}>
                  {e.event}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground leading-snug break-words">{e.message}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 flex flex-wrap gap-x-2">
                    {e.counterName && <span>{e.counterName}</span>}
                    {e.ticketNumber && <span dir="ltr">#{e.ticketNumber}</span>}
                    {e.serviceName && <span>{e.serviceName}</span>}
                    {e.username && <span>@{e.username}</span>}
                    {e.status && <span dir="ltr">{e.status}</span>}
                    {e.deviceName && <span>{e.deviceName}</span>}
                  </p>
                </div>
                {(e.level === 'warn' || e.level === 'error') && (
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 mt-1.5 ${e.level === 'error' ? 'bg-rose-500' : 'bg-amber-500'}`} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {lastFetchAt && state === 'ready' && entries.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {getLocalizedString('آخر تحديث', 'Dernière actualisation', 'Last refreshed', lang)}:{' '}
          <span dir="ltr">{new Date(lastFetchAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          {' · '}
          {getLocalizedString('تحديث تلقائي كل ١٠ ثوانٍ', 'Actualisation auto toutes les 10 s', 'Auto-refresh every 10 s', lang)}
        </p>
      )}
    </div>
  );
}
