'use client';

/**
 * TV Design 1 — "Classic" (0.6.74)
 * ─────────────────────────────────
 * The simplest full board: a clock/date top bar, one big card per ACTIVE
 * CLAIMED counter showing its current ticket, and a footer strip with
 * served-today + average serving time. Dark theme, readable from distance.
 */

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslationSafe } from '../tv-i18n';
import {
  type TvQueueStatus,
  type TvDisplayConfig,
  type TvScreenLayout,
  formatTvClock,
  formatTvDate,
  formatTvDuration,
} from '../use-tv-board-data';
import {
  TvAgencyName,
  TvStatusPill,
  TvPausedRibbon,
  TvStat,
  TvFlash,
} from '../tv-shared';

interface TvClassicProps {
  status: TvQueueStatus | null;
  loading: boolean;
  currentTime: Date;
  displaySettings: TvDisplayConfig;
  dataIsFresh: boolean;
  fetchFailed: boolean;
  flashIds: Set<string>;
  lang: string;
}

export function TvClassic({ status, loading, currentTime, dataIsFresh, fetchFailed, flashIds, lang }: TvClassicProps) {
  const { t } = useTranslationSafe(lang);

  // Only ACTIVE CLAIMED counters with their current ticket — served by the
  // API (counters[] is pre-filtered to claimed + touched within 45min).
  const counters = useMemo(() => status?.counters ?? [], [status]);
  const servingCount = counters.filter((c) => c.ticket).length;

  const avgLabel = formatTvClock(currentTime, lang);
  const dateLabel = formatTvDate(currentTime, lang);

  return (
    <div className="flex h-full min-h-screen flex-col bg-gradient-to-br from-gray-950 via-gray-900 to-emerald-950/40 text-white" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Top bar — agency + clock + date + freshness */}
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-6 py-4 md:px-10 md:py-5">
        <TvAgencyName agency={status?.agency} lang={lang} className="text-xl md:text-3xl" />
        <div className="flex items-center gap-4 md:gap-6">
          <div className="text-end">
            <div className="text-3xl md:text-5xl font-bold tabular-nums leading-none">{avgLabel}</div>
            <div className="mt-1 text-xs md:text-sm text-white/50">{dateLabel}</div>
          </div>
          <TvStatusPill fresh={dataIsFresh} offline={fetchFailed && !status} />
        </div>
      </header>

      {(status?.agency.isPaused) && <TvPausedRibbon />}

      {/* Counter cards grid */}
      <main className="flex-1 overflow-y-auto px-6 py-6 md:px-10">
        {loading && !status ? (
          <div className="grid h-full place-items-center text-white/40 text-xl">{t('tvBoardUpdated')}…</div>
        ) : servingCount === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div className="space-y-3">
              <p className="text-3xl md:text-5xl font-bold text-white/80">{t('tvxNoCounterServing')}</p>
              <p className="text-lg text-white/40">{t('tvxIdleHint')}</p>
            </div>
          </div>
        ) : (
          <div className="grid h-full grid-cols-1 content-start gap-4 sm:grid-cols-2 xl:grid-cols-3 md:gap-6">
            {counters.map((counter, idx) => {
              const name = lang === 'ar' && counter.nameAr ? counter.nameAr : lang === 'fr' && counter.nameFr ? counter.nameFr : counter.name;
              const ticket = counter.ticket;
              const flash = ticket ? flashIds.has(ticket.id) : false;
              const serviceName = ticket
                ? (lang === 'ar' && ticket.serviceNameAr ? ticket.serviceNameAr : lang === 'fr' && ticket.serviceNameFr ? ticket.serviceNameFr : ticket.serviceName)
                : null;
              return (
                <motion.div
                  key={counter.id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.05, 0.4), duration: 0.35 }}
                  className={`relative overflow-hidden rounded-3xl border p-5 md:p-7 ${
                    ticket
                      ? 'border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 via-white/5 to-transparent shadow-[0_0_40px_-12px] shadow-emerald-500/40'
                      : 'border-white/10 bg-white/[0.03] opacity-50'
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="truncate rounded-full bg-white/10 px-3 py-1 text-sm md:text-base font-semibold text-white/80">
                      {name}
                    </span>
                    <span className="shrink-0 rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-300">
                      #{counter.number}
                    </span>
                  </div>
                  {ticket ? (
                    <TvFlash active={flash}>
                      <div className="text-5xl md:text-7xl font-black tabular-nums tracking-tight leading-none">
                        {ticket.ticketNumber}
                      </div>
                      {serviceName && (
                        <div className="mt-2 truncate text-sm md:text-base text-white/50">{serviceName}</div>
                      )}
                    </TvFlash>
                  ) : (
                    <div className="text-3xl md:text-5xl font-black text-white/25 leading-none">— —</div>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </main>

      {/* Footer strip — served today + average serving time */}
      <footer className="border-t border-white/10 bg-black/30 px-6 py-4 md:px-10">
        <div className="mx-auto flex max-w-4xl items-center justify-around gap-6">
          <TvStat label={t('tvBoardServedToday')} value={String(status?.totalServedToday ?? 0)} tone="emerald" />
          <div className="h-10 w-px bg-white/10" aria-hidden />
          <TvStat label={t('tvxAvgServiceTime')} value={formatTvDuration(status?.avgServiceTimeSec, lang)} />
          <div className="h-10 w-px bg-white/10" aria-hidden />
          <TvStat label={t('kioskWaiting')} value={String(status?.totalWaiting ?? 0)} tone="amber" />
        </div>
      </footer>
    </div>
  );
}

