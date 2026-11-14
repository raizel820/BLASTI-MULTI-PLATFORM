'use client';

/**
 * TV Design 2 — "Counters" (0.6.74)
 * ─────────────────────────────────
 * Counter-centric panels filling the whole screen: every active claimed
 * counter gets a giant tile with its ticket number and a live "serving
 * since" timer. When nothing is being served, the tile area collapses into
 * a big clock — the calmest idle screen of the four designs.
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
  elapsedSecSince,
} from '../use-tv-board-data';
import { TvStatusPill, TvPausedRibbon, TvFlash } from '../tv-shared';

interface TvCountersProps {
  status: TvQueueStatus | null;
  loading: boolean;
  currentTime: Date;
  displaySettings: TvDisplayConfig;
  dataIsFresh: boolean;
  fetchFailed: boolean;
  flashIds: Set<string>;
  lang: string;
}

export function TvCounters({ status, loading, currentTime, dataIsFresh, fetchFailed, flashIds, lang }: TvCountersProps) {
  const { t } = useTranslationSafe(lang);

  const counters = useMemo(() => status?.counters ?? [], [status]);
  const busyCounters = counters.filter((c) => c.ticket);
  const idleCounters = counters.filter((c) => !c.ticket);
  const hasAnyCounter = counters.length > 0;

  const servedToday = status?.totalServedToday ?? 0;
  const avgLabel = formatTvDuration(status?.avgServiceTimeSec, lang);

  return (
    <div className="flex h-full min-h-screen flex-col bg-black text-white" dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      {/* Slim header — clock right, freshness left */}
      <header className="flex items-center justify-between gap-4 px-6 pt-4 md:px-12 md:pt-6">
        <TvStatusPill fresh={dataIsFresh} offline={fetchFailed && !status} />
        <div className="text-end">
          <div className="text-4xl md:text-6xl font-bold tabular-nums leading-none">{formatTvClock(currentTime, lang)}</div>
          <div className="mt-1 text-xs md:text-sm text-white/40">{formatTvDate(currentTime, lang)}</div>
        </div>
      </header>

      {(status?.agency.isPaused) && <TvPausedRibbon />}

      <main className="flex flex-1 flex-col overflow-y-auto px-6 py-6 md:px-12">
        {loading && !status ? (
          <div className="grid flex-1 place-items-center text-white/30 text-xl">…</div>
        ) : !hasAnyCounter ? (
          /* Idle: no claimed counters — giant clock + agency name */
          <div className="grid flex-1 place-items-center text-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.6 }}
              className="space-y-6"
            >
              {status?.agency && (
                <p className="text-2xl md:text-4xl font-bold text-white/70">
                  {lang === 'ar' && status.agency.nameAr ? status.agency.nameAr : lang === 'fr' && status.agency.nameFr ? status.agency.nameFr : status.agency.name}
                </p>
              )}
              <p className="text-5xl md:text-7xl font-black tabular-nums">{formatTvClock(currentTime, lang)}</p>
              <p className="text-lg md:text-2xl text-white/40">{t('tvxIdleHint')}</p>
            </motion.div>
          </div>
        ) : (
          <div className="grid flex-1 grid-cols-1 content-start gap-4 sm:grid-cols-2 lg:gap-6">
            {busyCounters.map((counter, idx) => {
              const name = lang === 'ar' && counter.nameAr ? counter.nameAr : lang === 'fr' && counter.nameFr ? counter.nameFr : counter.name;
              const ticket = counter.ticket!;
              const flash = flashIds.has(ticket.id);
              const since = elapsedSecSince(ticket.calledAt, currentTime.getTime());
              const sinceLabel = since === null ? '' : since < 60
                ? (lang === 'ar' ? `${since} ث` : `${since} s`)
                : `${Math.floor(since / 60)}:${String(since % 60).padStart(2, '0')}`;
              return (
                <motion.div
                  key={counter.id}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(idx * 0.05, 0.3), duration: 0.35 }}
                  className="relative flex min-h-[38vh] flex-col justify-between overflow-hidden rounded-3xl bg-gradient-to-br from-emerald-600/20 via-emerald-500/5 to-transparent p-6 ring-1 ring-emerald-500/30 md:p-10"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-xl md:text-3xl font-bold text-white/85">{name}</div>
                      <div className="mt-0.5 text-sm md:text-base text-white/40">{t('tvxServing')}</div>
                    </div>
                    <span className="shrink-0 rounded-full bg-emerald-500/20 px-3 py-1 text-sm font-bold text-emerald-300">
                      {sinceLabel}
                    </span>
                  </div>
                  <TvFlash active={flash}>
                    <div className="text-7xl md:text-[10rem] font-black tabular-nums leading-none tracking-tight text-emerald-300">
                      {ticket.ticketNumber}
                    </div>
                  </TvFlash>
                </motion.div>
              );
            })}

            {/* Idle claimed counters — small dimmed strip at the bottom */}
            {idleCounters.length > 0 && (
              <div className={`flex flex-wrap items-center gap-2 ${busyCounters.length > 0 ? 'col-span-full mt-2' : ''}`}>
                <span className="text-sm text-white/35">{t('tvxReadyToServe')}:</span>
                {idleCounters.map((c) => (
                  <span key={c.id} className="rounded-full bg-white/5 px-3 py-1 text-sm text-white/40 ring-1 ring-white/10">
                    {lang === 'ar' && c.nameAr ? c.nameAr : lang === 'fr' && c.nameFr ? c.nameFr : c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* One-line footer */}
      <footer className="flex items-center justify-center gap-8 border-t border-white/10 px-6 py-3 text-sm md:gap-14 md:text-base">
        <span className="text-white/60">
          {t('tvBoardServedToday')}: <b className="text-emerald-400 tabular-nums">{servedToday}</b>
        </span>
        <span className="text-white/60">
          {t('tvxAvgServiceTime')}: <b className="text-white/85 tabular-nums">{avgLabel}</b>
        </span>
      </footer>
    </div>
  );
}
