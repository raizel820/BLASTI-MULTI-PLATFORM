'use client';

/**
 * ACTIVE TICKET STRIP — SIMPLIFIED (customer UX simplification round).
 *
 * One plain bordered card: agency + service on the left, ticket number +
 * wait on the right, tap → queue view. Multiple active reservations show
 * the most urgent one plus a "+N more" chip. The old gradient hero with
 * the animated progress rail and pulsing dots is gone.
 *
 * Data comes from the same GET /api/reservations/active?userId=… polling the
 * home view already ran (fields are additive extractions, endpoint unchanged).
 */

import { ChevronRight, Clock, TicketCheck } from 'lucide-react';
import type { TranslationKeys } from '@/i18n';

export interface ActiveTicket {
  agencyId: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  serviceName?: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  queueNumber?: string;
  currentServingNumber?: string;
  estimatedWait?: number;
  position: number;
  status?: string;
  /** r21-8 — counter pointer for CALLED tickets (payload counter field). */
  counterName?: string;
}

interface ActiveTicketStripProps {
  tickets: ActiveTicket[];
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  lang: string;
  onOpenQueue: () => void;
  onFindAgency: () => void;
}

export function ActiveTicketStrip({ tickets, t, lang, onOpenQueue, onFindAgency }: ActiveTicketStripProps) {
  // ── Empty state: plain CTA card ──
  if (tickets.length === 0) {
    return (
      <button
        onClick={onFindAgency}
        className="w-full flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-start hover:bg-muted/40 transition-colors"
      >
        <span className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
          <TicketCheck className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-400" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-foreground truncate">
            {t('noActiveTicket')}
          </span>
          <span className="block text-xs text-muted-foreground truncate">
            {t('noActiveTicketCta')}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 text-muted-foreground rtl:rotate-180 flex-shrink-0" />
      </button>
    );
  }

  // ── Most urgent ticket first (CALLED > WAITING, then lowest position) ──
  const statusRank = (s?: string) => (s === 'CALLED' ? 0 : s === 'DEFERRED_OFFLINE' ? 2 : 1);
  const sorted = [...tickets].sort((a, b) => {
    const r = statusRank(a.status) - statusRank(b.status);
    if (r !== 0) return r;
    return (a.position || 9999) - (b.position || 9999);
  });
  const hero = sorted[0];
  const moreCount = sorted.length - 1;
  const isCalled = hero.status === 'CALLED';

  const name =
    lang === 'ar' && hero.agencyNameAr ? hero.agencyNameAr
    : lang === 'fr' && hero.agencyNameFr ? hero.agencyNameFr
    : hero.agencyName;
  const service =
    lang === 'ar' && hero.serviceNameAr ? hero.serviceNameAr
    : lang === 'fr' && hero.serviceNameFr ? hero.serviceNameFr
    : hero.serviceName;

  const displayNumber = hero.queueNumber || `#${hero.position}`;

  return (
    <button
      onClick={onOpenQueue}
      aria-label={t('tapToViewQueue')}
      className={`w-full rounded-xl border bg-card px-4 py-3 text-start transition-colors hover:bg-muted/40 ${
        isCalled
          ? 'border-emerald-400 dark:border-emerald-600 ring-1 ring-emerald-200 dark:ring-emerald-800'
          : 'border-border'
      }`}
    >
      <div className="flex items-center gap-3">
        {/* Agency + service */}
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="text-[13px] font-bold text-foreground truncate">{name}</span>
            {isCalled && (
              <span className="text-[9px] font-bold bg-emerald-600 text-white px-1.5 py-0.5 rounded-full flex-shrink-0">
                {t('yourTurn')}
              </span>
            )}
          </span>
          <span className="block text-[11px] text-muted-foreground truncate">
            {service || t('activeTicket')}
          </span>
          {/* r21-8 — counter pointer once the ticket is CALLED */}
          {isCalled && hero.counterName && (
            <span className="mt-0.5 inline-flex items-center gap-1 max-w-full text-[10px] font-semibold text-amber-700 dark:text-amber-400">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" />
              <span className="truncate">{t('goCounterName', { name: hero.counterName })}</span>
            </span>
          )}
        </span>

        {/* Numbers */}
        <span className="flex items-center gap-3 flex-shrink-0">
          {!isCalled && !!hero.estimatedWait && hero.estimatedWait > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span className="text-[10px] font-semibold whitespace-nowrap">~{hero.estimatedWait} {t('min')}</span>
            </span>
          )}
          <span className="text-center">
            <span className="block text-xl font-black leading-none tracking-tight text-foreground">
              {displayNumber.startsWith('#') ? displayNumber : `#${hero.position}`}
            </span>
            <span className="block text-[9px] text-muted-foreground mt-0.5">{t('queuePosition')}</span>
          </span>
        </span>
      </div>

      {/* More chip */}
      {moreCount > 0 && (
        <div className="mt-2 pt-2 border-t border-border flex justify-end">
          <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            {t('moreActiveTickets').replace('{n}', String(moreCount))}
          </span>
        </div>
      )}
    </button>
  );
}
