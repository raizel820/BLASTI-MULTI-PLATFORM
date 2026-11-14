'use client';

/**
 * Shared presentational atoms for the four simple BLASTI TV screens.
 * Kept deliberately tiny — every layout must remain readable from 5+ meters.
 */

import { motion } from 'framer-motion';
import { useTranslationSafe } from './tv-i18n';
import { getProxiedUrl } from '@/lib/utils';

// ─── Agency header (logo + localized name) ──────────────────────────────────

export function TvAgencyName({
  agency,
  lang,
  className,
}: {
  agency: { name: string; nameAr?: string | null; nameFr?: string | null; logoUrl?: string | null } | null | undefined;
  lang: string;
  className?: string;
}) {
  if (!agency) return null;
  const name = lang === 'ar' && agency.nameAr ? agency.nameAr : lang === 'fr' && agency.nameFr ? agency.nameFr : agency.name;
  return (
    <div className={`flex items-center gap-3 min-w-0 ${className ?? ''}`}>
      {agency.logoUrl && (
        <img
          src={getProxiedUrl(agency.logoUrl)}
          alt={name}
          className="h-10 w-10 md:h-12 md:w-12 rounded-xl object-cover bg-white/10 shrink-0"
        />
      )}
      <span className="truncate font-bold tracking-tight">{name}</span>
    </div>
  );
}

// ─── Live / stale / offline pill ────────────────────────────────────────────

export function TvStatusPill({ fresh, offline }: { fresh: boolean; offline: boolean }) {
  const { t } = useTranslationSafe();
  if (offline) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 text-xs font-semibold text-red-400 ring-1 ring-red-500/30">
        <span className="h-2 w-2 rounded-full bg-red-500" />
        {t('tvBoardOffline')}
      </span>
    );
  }
  if (!fresh) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-400 ring-1 ring-amber-500/30">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        {t('tvBoardStale')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-400 ring-1 ring-emerald-500/30">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      {t('tvBoardLive')}
    </span>
  );
}

// ─── Paused / closed ribbon ─────────────────────────────────────────────────

export function TvPausedRibbon() {
  const { t } = useTranslationSafe();
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-sm font-semibold text-amber-400">
      <span className="text-base leading-none">&#9208;</span>
      {t('kioskQueuePaused')}
    </div>
  );
}

// ─── Footer stat chip ───────────────────────────────────────────────────────

export function TvStat({
  label,
  value,
  tone = 'default',
  className,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'emerald' | 'amber';
  className?: string;
}) {
  const tones = {
    default: 'text-foreground/90',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
  } as const;
  return (
    <div className={`flex flex-col items-center gap-0.5 ${className ?? ''}`}>
      <span className={`text-2xl md:text-3xl font-bold tabular-nums leading-none ${tones[tone]}`}>{value}</span>
      <span className="text-[11px] md:text-xs font-medium uppercase tracking-wide opacity-60">{label}</span>
    </div>
  );
}

// ─── Ticket flash wrapper ───────────────────────────────────────────────────

export function TvFlash({ active, children, className }: { active: boolean; children: React.ReactNode; className?: string }) {
  if (!active) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ scale: 1.04 }}
      animate={{ scale: 1 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <motion.div
        animate={{ opacity: [1, 0.45, 1, 0.45, 1] }}
        transition={{ duration: 1.2, times: [0, 0.2, 0.4, 0.6, 1] }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

// ─── Empty / loading screen shared by all layouts ───────────────────────────

export function TvEmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center">
      <p className="text-2xl font-semibold opacity-40">{message}</p>
    </div>
  );
}
