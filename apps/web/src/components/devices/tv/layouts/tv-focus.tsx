'use client';

/**
 * TV Design 3 — "Focus" (0.6.74)
 * ──────────────────────────────
 * One ticket at a time, cinema-style: the most recently CALLED ticket fills
 * the center of the screen with its counter, the other busy counters appear
 * as compact chips underneath. Time/date top-right, served-today + average
 * serving time as a slim bottom bar. Optimized for the largest possible
 * ticket digits on any 16:9 TV.
 */

import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslationSafe } from '../tv-i18n';
import {
  type TvQueueStatus,
  type TvDisplayConfig,
  formatTvClock,
  formatTvDate,
  formatTvDuration,
} from '../use-tv-board-data';
import { TvAgencyName, TvStatusPill, TvPausedRibbon, TvFlash } from '../tv-shared';

interface TvFocusProps {
  status: TvQueueStatus | null;
  loading: boolean;
  currentTime: Date;
  displaySettings: TvDisplayConfig;
  dataIsFresh: boolean;
  fetchFailed: boolean;
  flashIds: Set<string>;
  lang: string;
}

export function TvFocus({ status, loading, currentTime, dataIsFresh, fetchFailed, flashIds, lang }: TvFocusProps) {
  const { t } = useTranslationSafe(lang);

  // Latest called ticket (API returns currentlyServing ordered by calledAt desc).
  const counters = useMemo(() => status?.counters ?? [], [status]);
  const busy = counters.filter((c) => c.ticket);
  const hero = busy[0] ?? null;
  const others = busy.slice(1);

  const heroName = hero
    ? (lang === 'ar' && hero.nameAr ? hero.nameAr : lang === 'fr' && hero.nameFr ? hero.nameFr : hero.name)
    : '';
  const heroTicket = hero?.ticket ?? null;
  const heroService = heroTicket
    ? (lang === 'ar' && heroTicket.serviceNameAr ? heroTicket.serviceNameAr : lang === 'fr' && heroTicket.serviceNameFr ? heroTicket.serviceNameFr : heroTicket.serviceName)
    : '';

  const avgLabel = formatTvDuration(status?.avgServiceTimeSec, lang);

  return (
    <div className="relative flex h-full min-h-screen flex-col overflow-hidden bg-gradient-to-b from-teal-950 via-gray-950 to-black text-white" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Ambient glow behind the hero ticket */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
        <div className="h-[60vh] w-[60vh] rounded-full bg-emerald-500/10 blur-[120px]" />
      </div>

      <header className="relative z-10 flex items-center justify-between gap-4 px-6 py-4 md:px-12 md:py-6">
        <TvAgencyName agency={status?.agency} lang={lang} className="text-lg md:text-2xl" />
        <div className="flex items-center gap-4">
          <TvStatusPill fresh={dataIsFresh} offline={fetchFailed && !status} />
          <div className="text-end">
            <div className="text-2xl md:text-4xl font-bold tabular-nums leading-none">{formatTvClock(currentTime, lang)}</div>
            <div className="mt-1 hidden text-xs text-white/40 md:block">{formatTvDate(currentTime, lang)}</div>
          </div>
        </div>
      </header>

      {(status?.agency.isPaused) && <TvPausedRibbon />}

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center gap-8 px-8 text-center">
        {loading && !status ? (
          <div className="text-white/30 text-xl">…</div>
        ) : !hero || !heroTicket ? (
          <div className="space-y-4">
            <p className="text-6xl md:text-8xl font-black tabular-nums text-white/85">{formatTvClock(currentTime, lang)}</p>
            <p className="text-xl md:text-3xl text-white/40">{t('tvxNoCounterServing')}</p>
          </div>
        ) : (
          <>
            <AnimatePresence mode="wait">
              <motion.div
                key={heroTicket.id}
                initial={{ opacity: 0, y: 24, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -24, scale: 0.97 }}
                transition={{ duration: 0.45, ease: 'easeOut' }}
                className="space-y-5"
              >
                <div className="text-lg md:text-2xl font-semibold uppercase tracking-[0.3em] text-emerald-400/90">
                  {t('nowServing')}
                </div>
                <TvFlash active={flashIds.has(heroTicket.id)}>
                  <div className="text-[7rem] md:text-[16rem] font-black tabular-nums leading-[0.9] tracking-tight">
                    {heroTicket.ticketNumber}
                  </div>
                </TvFlash>
                <div className="flex flex-wrap items-center justify-center gap-3 text-lg md:text-2xl text-white/70">
                  <span className="rounded-full bg-white/10 px-4 py-1 font-semibold">{heroName}</span>
                  {heroService && <span className="truncate max-w-[40vw] opacity-60">{heroService}</span>}
                </div>
              </motion.div>
            </AnimatePresence>

            {others.length > 0 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="flex flex-wrap items-center justify-center gap-2 md:gap-3"
              >
                {others.slice(0, 6).map((c) => (
                  <span
                    key={c.id}
                    className="flex items-center gap-2 rounded-full bg-white/5 px-4 py-1.5 text-base md:text-xl ring-1 ring-white/10"
                  >
                    <span className="hidden text-white/40 md:inline truncate max-w-[12rem]">
                      {lang === 'ar' && c.nameAr ? c.nameAr : lang === 'fr' && c.nameFr ? c.nameFr : c.name}
                    </span>
                    <b className="tabular-nums text-emerald-300">{c.ticket!.ticketNumber}</b>
                  </span>
                ))}
              </motion.div>
            )}
          </>
        )}
      </main>

      <footer className="relative z-10 flex items-center justify-center gap-8 border-t border-white/10 bg-black/40 px-6 py-3 text-sm md:gap-16 md:text-lg">
        <span className="text-white/60">
          {t('tvBoardServedToday')}: <b className="text-emerald-400 tabular-nums">{status?.totalServedToday ?? 0}</b>
        </span>
        <span className="text-white/60">
          {t('tvxAvgServiceTime')}: <b className="tabular-nums">{avgLabel}</b>
        </span>
        <span className="hidden text-white/40 md:inline">{formatTvDate(currentTime, lang)}</span>
      </footer>
    </div>
  );
}
