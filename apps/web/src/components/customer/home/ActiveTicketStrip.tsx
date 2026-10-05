'use client';

/**
 * Task 79-a — ACTIVE TICKET STRIP.
 *
 * Replaces the giant two-stacked reservation cards of the old home with ONE
 * compact single card: status dot + agency/service on the left, big queue
 * position + "now serving" + estimated-wait chip on the right, and a thin
 * progress rail along the bottom. Tap → queue view. Multiple active
 * reservations show the most urgent one plus a "+N more" chip.
 *
 * Data comes from the same GET /api/reservations/active?userId=… polling the
 * home view already ran (fields are additive extractions, endpoint unchanged).
 */

import { motion } from 'framer-motion';
import { ChevronRight, Clock, TicketCheck, Users } from 'lucide-react';
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
}

interface ActiveTicketStripProps {
  tickets: ActiveTicket[];
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  lang: string;
  onOpenQueue: () => void;
  onFindAgency: () => void;
}

export function ActiveTicketStrip({ tickets, t, lang, onOpenQueue, onFindAgency }: ActiveTicketStripProps) {
  // ── Empty state: slim emerald CTA card ──
  if (tickets.length === 0) {
    return (
      <motion.button
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        whileTap={{ scale: 0.98 }}
        onClick={onFindAgency}
        className="w-full flex items-center gap-3 rounded-2xl border border-emerald-200/70 dark:border-emerald-800/40 bg-emerald-50/70 dark:bg-emerald-900/15 px-4 py-3 text-start hover:bg-emerald-50 dark:hover:bg-emerald-900/25 transition-colors"
      >
        <span className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
          <TicketCheck className="h-[18px] w-[18px] text-emerald-600 dark:text-emerald-400" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-emerald-800 dark:text-emerald-300 truncate">
            {t('noActiveTicket')}
          </span>
          <span className="block text-xs text-emerald-700/70 dark:text-emerald-400/70 truncate">
            {t('noActiveTicketCta')}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 text-emerald-600 dark:text-emerald-400 rtl:rotate-180 flex-shrink-0" />
      </motion.button>
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
  const progress = hero.position <= 1 ? 90 : Math.max(8, Math.min(90, 100 - hero.position * 7));

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="relative"
    >
      <motion.button
        whileTap={{ scale: 0.985 }}
        onClick={onOpenQueue}
        aria-label={t('tapToViewQueue')}
        className={`w-full rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-500/20 text-start overflow-hidden relative ${
          isCalled ? 'ring-2 ring-amber-300 dark:ring-amber-400' : ''
        }`}
      >
        <div className="px-4 pt-3 pb-3.5">
          <div className="flex items-center gap-3">
            {/* Status dot */}
            <span className="relative flex-shrink-0">
              <motion.span
                animate={isCalled ? { scale: [1, 1.35, 1] } : { opacity: [0.6, 1, 0.6] }}
                transition={{ duration: isCalled ? 1 : 2, repeat: Infinity, ease: 'easeInOut' }}
                className={`block h-2.5 w-2.5 rounded-full ${isCalled ? 'bg-amber-300' : 'bg-emerald-300'}`}
              />
            </span>

            {/* Agency + service */}
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="text-[13px] font-bold truncate">{name}</span>
                {isCalled && (
                  <span className="text-[9px] font-bold bg-amber-300/90 text-emerald-900 px-1.5 py-0.5 rounded-full flex-shrink-0">
                    {t('yourTurn')}
                  </span>
                )}
              </span>
              <span className="block text-[11px] text-emerald-100/90 truncate">
                {service || t('activeTicket')}
              </span>
            </span>

            {/* Numbers */}
            <span className="flex items-center gap-3 flex-shrink-0">
              <span className="text-center">
                <span className="block text-xl font-black leading-none tracking-tight">
                  {displayNumber.startsWith('#') ? displayNumber : `#${hero.position}`}
                </span>
                <span className="block text-[9px] text-emerald-100/80 mt-0.5">{t('queuePosition')}</span>
              </span>
              {hero.currentServingNumber && hero.currentServingNumber !== '0' && (
                <span className="text-center hidden sm:block">
                  <span className="block text-sm font-bold leading-none">{hero.currentServingNumber}</span>
                  <span className="block text-[9px] text-emerald-100/80 mt-0.5">{t('currentServing')}</span>
                </span>
              )}
              {!isCalled && !!hero.estimatedWait && hero.estimatedWait > 0 && (
                <span className="flex items-center gap-1 bg-white/15 rounded-full px-2 py-1">
                  <Clock className="h-3 w-3" />
                  <span className="text-[10px] font-semibold whitespace-nowrap">~{hero.estimatedWait} {t('min')}</span>
                </span>
              )}
            </span>
          </div>

          {/* Progress rail */}
          <div className="mt-2.5 h-1 w-full rounded-full bg-white/20 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
              className="h-full rounded-full bg-white/80"
            />
          </div>

          {/* Bottom row: more chip + hint */}
          <div className="mt-1.5 flex items-center justify-between">
            <span className="flex items-center gap-1 text-[10px] text-emerald-100/80">
              <Users className="h-3 w-3" />
              {t('tapToViewQueue')}
            </span>
            {moreCount > 0 && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onOpenQueue(); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onOpenQueue(); } }}
                className="text-[10px] font-bold bg-white/20 hover:bg-white/30 rounded-full px-2 py-0.5 transition-colors"
              >
                {t('moreActiveTickets').replace('{n}', String(moreCount))}
              </span>
            )}
          </div>
        </div>
      </motion.button>
    </motion.div>
  );
}
