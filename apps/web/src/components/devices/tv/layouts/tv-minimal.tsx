'use client';

/**
 * TV Design 4 — "Minimal" (0.6.74)
 * ────────────────────────────────
 * The light, compact one: a near-white surface, a simple counter/ticket
 * table, and a single stats row. Best for small monitors, bright halls and
 * older panels where a dark board would look washed out.
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslationSafe } from '../tv-i18n';
import {
  type TvQueueStatus,
  type TvDisplayConfig,
  formatTvClock,
  formatTvDate,
  formatTvDuration,
} from '../use-tv-board-data';
import { TvAgencyName, TvFlash } from '../tv-shared';

interface TvMinimalProps {
  status: TvQueueStatus | null;
  loading: boolean;
  currentTime: Date;
  displaySettings: TvDisplayConfig;
  dataIsFresh: boolean;
  fetchFailed: boolean;
  flashIds: Set<string>;
  lang: string;
}

export function TvMinimal({ status, loading, currentTime, dataIsFresh, fetchFailed, flashIds, lang }: TvMinimalProps) {
  const { t } = useTranslationSafe(lang);

  const counters = useMemo(() => status?.counters ?? [], [status]);

  const avgLabel = formatTvDuration(status?.avgServiceTimeSec, lang);

  return (
    <div className="flex h-full min-h-screen flex-col bg-[#f6f7f5] text-gray-900" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Header — agency, date, clock */}
      <header className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-6 py-4 md:px-10">
        <TvAgencyName agency={status?.agency} lang={lang} className="text-lg md:text-2xl text-gray-800" />
        <div className="flex items-center gap-4">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
              fetchFailed && !status
                ? 'bg-red-50 text-red-600 ring-red-200'
                : dataIsFresh
                  ? 'bg-emerald-50 text-emerald-600 ring-emerald-200'
                  : 'bg-amber-50 text-amber-600 ring-amber-200'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${fetchFailed && !status ? 'bg-red-500' : dataIsFresh ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {fetchFailed && !status ? t('tvBoardOffline') : dataIsFresh ? t('tvBoardLive') : t('tvBoardStale')}
          </span>
          <div className="text-end">
            <div className="text-2xl md:text-4xl font-bold tabular-nums leading-none text-gray-800">{formatTvClock(currentTime, lang)}</div>
            <div className="mt-0.5 text-xs md:text-sm text-gray-400">{formatTvDate(currentTime, lang)}</div>
          </div>
        </div>
      </header>

      {(status?.agency.isPaused) && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-sm font-semibold text-amber-700">
          {t('kioskQueuePaused')}
        </div>
      )}

      {/* Counter rows */}
      <main className="flex-1 overflow-y-auto px-6 py-6 md:px-10">
        {loading && !status ? (
          <div className="grid h-full place-items-center text-gray-300 text-xl">…</div>
        ) : counters.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div className="space-y-2">
              <p className="text-3xl md:text-4xl font-bold text-gray-300">{t('tvxNoCounterServing')}</p>
              <p className="text-lg text-gray-300">{t('tvxIdleHint')}</p>
            </div>
          </div>
        ) : (
          <ul className="mx-auto max-w-5xl space-y-3">
            {counters.map((counter, idx) => {
              const name = lang === 'ar' && counter.nameAr ? counter.nameAr : lang === 'fr' && counter.nameFr ? counter.nameFr : counter.name;
              const ticket = counter.ticket;
              const serviceName = ticket
                ? (lang === 'ar' && ticket.serviceNameAr ? ticket.serviceNameAr : lang === 'fr' && ticket.serviceNameFr ? ticket.serviceNameFr : ticket.serviceName)
                : null;
              return (
                <motion.li
                  key={counter.id}
                  initial={{ opacity: 0, x: lang === 'ar' ? 16 : -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(idx * 0.04, 0.3), duration: 0.3 }}
                  className={`flex items-center justify-between gap-4 rounded-2xl border px-5 py-4 md:px-8 md:py-6 ${
                    ticket ? 'border-emerald-200 bg-white shadow-sm' : 'border-gray-100 bg-white/60 opacity-50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-500">#{counter.number}</span>
                      <span className="truncate text-lg md:text-2xl font-bold text-gray-800">{name}</span>
                    </div>
                    {serviceName && (
                      <div className="mt-0.5 truncate text-sm md:text-base text-gray-400">{serviceName}</div>
                    )}
                  </div>
                  {ticket ? (
                    <TvFlash active={flashIds.has(ticket.id)}>
                      <span className="text-4xl md:text-6xl font-black tabular-nums text-emerald-600">{ticket.ticketNumber}</span>
                    </TvFlash>
                  ) : (
                    <span className="text-2xl md:text-4xl font-black text-gray-200">— —</span>
                  )}
                </motion.li>
              );
            })}
          </ul>
        )}
      </main>

      {/* Stats footer */}
      <footer className="border-t border-gray-200 bg-white px-6 py-4 md:px-10">
        <div className="mx-auto flex max-w-5xl items-center justify-around gap-6 text-center">
          <div>
            <div className="text-2xl md:text-3xl font-bold tabular-nums text-emerald-600">{status?.totalServedToday ?? 0}</div>
            <div className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-gray-400">{t('tvBoardServedToday')}</div>
          </div>
          <div className="h-10 w-px bg-gray-100" aria-hidden />
          <div>
            <div className="text-2xl md:text-3xl font-bold tabular-nums text-gray-700">{avgLabel}</div>
            <div className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-gray-400">{t('tvxAvgServiceTime')}</div>
          </div>
          <div className="h-10 w-px bg-gray-100" aria-hidden />
          <div>
            <div className="text-2xl md:text-3xl font-bold tabular-nums text-amber-500">{status?.totalWaiting ?? 0}</div>
            <div className="text-[11px] md:text-xs font-medium uppercase tracking-wide text-gray-400">{t('kioskWaiting')}</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
