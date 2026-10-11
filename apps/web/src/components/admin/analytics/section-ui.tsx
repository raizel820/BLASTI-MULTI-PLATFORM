'use client';

// ─── Task 54-b: shared building blocks for the super-admin section pages ────
//
// Presentational primitives reused by every section component so the pages
// stay compact and visually consistent with the existing Overview dashboard:
//   • StatTile / StatTiles   — icon + animated value + label cards
//                             (platform-stats-row pattern);
//   • ChartCard              — card + recharts slot (LTR-wrapped inside RTL);
//   • BucketAxis helpers     — 'YYYY-MM-DD' / 'YYYY-MM' bucket formatting;
//   • CountListPanel         — label/count/share rows with Progress bars,
//                             height-capped ScrollArea + custom-scrollbar
//                             (top-agencies-panel pattern);
//   • SectionTablePanel      — column table for rich distributions,
//                             max-h + custom scrollbar, sticky header;
//   • SectionSkeleton        — per-section loading skeleton (never a bare
//                             spinner);
//   • MessagePanel           — re-exported from the dashboard module's copy
//                             (kept here to avoid circular imports — the
//                             dashboard imports sections, not vice versa).
//
// Palette: emerald/teal/cyan primary, amber warning, rose negative — no
// indigo/blue. Numeric + chart zones stay LTR inside RTL layouts.

import { useLanguage } from '@/hooks/use-language';
import type { TranslationKeys } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, Inbox, RefreshCw, ServerCrash, type LucideIcon } from 'lucide-react';
import type { AdminResolvedWindow } from './section-types';
import { motion } from 'framer-motion';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { AnimatedCounter } from '@/components/agency/dashboard/helpers';
import { AnimatedValue } from './animated-value';
import { ak } from './i18n-keys';
import { Button } from '@/components/ui/button';

// ─── Period label localization ───────────────────────────────────────────────

type Translate = (key: TranslationKeys, params?: Record<string, string>) => string;

/** Localized label for a period token ('30d' → "Last 30 days", 'today' →
 *  "Today", …). Unknown tokens (e.g. future backend aliases) fall back to the
 *  raw token so the {period} interpolation in KPI captions never shows an
 *  untranslated key. */
export function localizedPeriodLabel(period: string, t: Translate): string {
  switch (period) {
    case 'today':
      return t(ak('adminAnalytics.period.today'));
    case 'yesterday':
      return t(ak('adminAnalytics.period.yesterday'));
    case '7d':
      return t(ak('analyticsSection.period7d'));
    case '30d':
      return t(ak('analyticsSection.period30d'));
    case 'this-week':
      return t(ak('adminAnalytics.period.thisWeek'));
    case 'this-month':
      return t(ak('adminAnalytics.period.thisMonth'));
    case 'this-quarter':
      return t(ak('adminAnalytics.period.thisQuarter'));
    case 'this-year':
      return t(ak('adminAnalytics.period.thisYear'));
    case 'custom':
      return t(ak('adminAnalytics.period.custom'));
    default:
      return period;
  }
}

// ─── Stat tiles ──────────────────────────────────────────────────────────────

export interface StatTileItem {
  icon: LucideIcon;
  iconClass: string;
  label: string;
  /** Numeric value (rendered with the integer count-up). */
  value?: number;
  /** Pre-formatted text value — wins over `value` when provided. */
  text?: string;
  decimals?: number;
  suffix?: string;
}

export function StatTile({ item, delay }: { item: StatTileItem; delay: number }) {
  const Icon = item.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: 'easeOut' }}
    >
      <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden h-full">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${item.iconClass}`}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xl sm:text-2xl font-black text-foreground leading-none" dir="ltr">
                {item.text !== undefined ? (
                  item.text
                ) : (
                  <>
                    {item.decimals ? (
                      <AnimatedValue value={Number.isFinite(item.value) ? (item.value as number) : 0} decimals={item.decimals} />
                    ) : (
                      <AnimatedCounter value={Number.isFinite(item.value) ? (item.value as number) : 0} />
                    )}
                    {item.suffix}
                  </>
                )}
              </p>
              <p className="mt-1 text-[11px] font-medium text-muted-foreground truncate" title={item.label}>
                {item.label}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

export function StatTiles({ items }: { items: StatTileItem[] }) {
  const cols = items.length <= 4 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 md:grid-cols-4';
  return (
    <div className={`grid ${cols} gap-3`} role="list">
      {items.map((item, i) => (
        <div key={i} role="listitem">
          <StatTile item={item} delay={i * 0.05} />
        </div>
      ))}
    </div>
  );
}

// ─── Chart card ──────────────────────────────────────────────────────────────

export function formatBucket(bucket: string, lang: string): string {
  try {
    const locale = getLocale(lang);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(bucket)) {
      const d = new Date(`${bucket}:00:00Z`);
      return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: 'numeric', timeZone: 'UTC' }).format(d);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
      const d = new Date(`${bucket}T00:00:00Z`);
      return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
    }
    if (/^\d{4}-\d{2}$/.test(bucket)) {
      const d = new Date(`${bucket}-15T00:00:00Z`);
      return new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(d);
    }
  } catch {
    /* fall through */
  }
  return bucket;
}

export function ChartCard({
  title,
  subtitle,
  icon: Icon,
  iconClass,
  children,
  heightClass = 'h-56 sm:h-64',
  empty,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  iconClass: string;
  children: React.ReactNode;
  heightClass?: string;
  empty?: boolean;
}) {
  const { t } = useLanguage();
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className={`h-8 w-8 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0 ${iconClass}`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {subtitle && <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {empty ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <Inbox className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <div className={heightClass} dir="ltr">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Shared recharts tooltip chrome ──────────────────────────────────────────

export function ChartTooltipBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border border-border/60 bg-white/95 dark:bg-gray-900/95 px-3 py-2 shadow-lg backdrop-blur-sm text-xs"
      dir="ltr"
    >
      {children}
    </div>
  );
}

// ─── Count list panel (label · count · share Progress rows) ──────────────────

export interface CountListRow {
  label: string;
  count: number;
  extra?: string;
}

export function CountListPanel({
  title,
  subtitle,
  icon: Icon,
  iconClass,
  rows,
  emptyIcon: EmptyIcon = Inbox,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  iconClass: string;
  rows: CountListRow[];
  emptyIcon?: LucideIcon;
}) {
  const { t } = useLanguage();
  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);
  const total = rows.reduce((sum, r) => sum + safe(r.count), 0);

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className={`h-8 w-8 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0 ${iconClass}`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {subtitle && <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <EmptyIcon className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <ScrollArea className="max-h-96 custom-scrollbar">
            <div className="space-y-2.5 pe-2">
              {rows.map((row, i) => {
                const share = total > 0 ? Math.min(100, (safe(row.count) / total) * 100) : 0;
                return (
                  <div key={`${row.label}-${i}`}>
                    <div className="flex items-center justify-between gap-2 text-[11px] font-semibold mb-1">
                      <span className="text-foreground truncate min-w-0" title={row.label}>
                        {row.label}
                      </span>
                      <span className="text-muted-foreground shrink-0" dir="ltr">
                        {row.extra ? row.extra + ' · ' : ''}
                        {safe(row.count).toLocaleString()}
                        {total > 0 && ` · ${share.toFixed(0)}%`}
                      </span>
                    </div>
                    <Progress
                      value={share}
                      className="h-1.5 bg-emerald-100 dark:bg-emerald-900/30 [&>div]:bg-emerald-500"
                      aria-label={`${row.label}: ${row.count}`}
                    />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

/** Map a { key: count } record into CountListRows with translated labels. */
export function countMapToRows(
  map: Record<string, number> | undefined,
  labelFor: (key: string) => string,
): CountListRow[] {
  return Object.entries(map ?? {})
    .map(([key, count]) => ({ label: labelFor(key), count: Number.isFinite(count) ? count : 0 }))
    .sort((a, b) => b.count - a.count);
}

// ─── Table panel for rich distributions ──────────────────────────────────────

export interface SectionColumn<T> {
  header: string;
  /** Cell content — return a string, number or node. */
  cell: (row: T) => React.ReactNode;
  /** Tailwind width classes for the column; default flex-1 min-w-0. */
  className?: string;
  align?: 'start' | 'center' | 'end';
}

export function SectionTablePanel<T>({
  title,
  subtitle,
  icon: Icon,
  iconClass,
  rows,
  columns,
  emptyIcon: EmptyIcon = Inbox,
  getKey,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  iconClass: string;
  rows: T[];
  columns: Array<SectionColumn<T>>;
  emptyIcon?: LucideIcon;
  getKey: (row: T, index: number) => string;
}) {
  const { t } = useLanguage();
  const alignClass = (a?: 'start' | 'center' | 'end') =>
    a === 'center' ? 'text-center' : a === 'end' ? 'text-end' : 'text-start';

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className={`h-8 w-8 rounded-lg bg-gradient-to-br flex items-center justify-center shrink-0 ${iconClass}`}>
            <Icon className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">{title}</CardTitle>
            {subtitle && <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <EmptyIcon className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            {/* Column captions */}
            <div className="flex items-center gap-2 px-0.5 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              {columns.map((col, i) => (
                <span key={i} className={`${col.className ?? 'flex-1 min-w-0'} ${alignClass(col.align)}`}>
                  {col.header}
                </span>
              ))}
            </div>
            <ScrollArea className="max-h-96 custom-scrollbar">
              <div className="divide-y divide-border/60 pe-2">
                {rows.map((row, index) => (
                  <div key={getKey(row, index)} className="py-2.5 flex items-center gap-2">
                    {columns.map((col, i) => (
                      <div
                        key={i}
                        className={`${col.className ?? 'flex-1 min-w-0'} ${alignClass(col.align)} text-xs text-foreground`}
                      >
                        {col.cell(row)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Loading skeleton ────────────────────────────────────────────────────────

export function SectionSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Skeleton className="h-64 rounded-2xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }, (_, i) => (
          <Skeleton key={i} className="h-72 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

// ─── Full-panel message state (error / unavailable / empty / idle) ───────────

export function SectionMessagePanel({
  icon: Icon,
  iconClass,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  iconClass: string;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80">
      <CardContent className="py-14 px-6 flex flex-col items-center justify-center text-center">
        <div className={`h-12 w-12 rounded-2xl flex items-center justify-center mb-3 ${iconClass}`}>
          <Icon className="h-6 w-6" />
        </div>
        <p className="text-sm font-bold text-foreground">{title}</p>
        <p className="mt-1.5 text-xs text-muted-foreground max-w-sm leading-relaxed">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </CardContent>
    </Card>
  );
}

export function SectionStatePanels({
  state,
  onRetry,
  isQueryReady,
  customHint,
}: {
  state: 'loading' | 'ready' | 'error' | 'unavailable' | 'empty' | 'idle';
  onRetry: () => void;
  isQueryReady: boolean;
  customHint: string;
}) {
  const { t } = useLanguage();
  if (state === 'loading') return <SectionSkeleton />;

  if (state === 'idle') {
    return (
      <SectionMessagePanel
        icon={ServerCrash}
        iconClass="bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400"
        title={t(ak('adminAnalytics.section.emptyTitle'))}
        body={customHint}
      />
    );
  }

  if (state === 'unavailable') {
    return (
      <SectionMessagePanel
        icon={ServerCrash}
        iconClass="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        title={t('analyticsSection.updateRequiredTitle')}
        body={t('analyticsSection.updateRequiredBody')}
        action={
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" />
            {t('retry')}
          </Button>
        }
      />
    );
  }

  if (state === 'error') {
    return (
      <SectionMessagePanel
        icon={AlertTriangle}
        iconClass="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400"
        title={t('analyticsSection.loadFailed')}
        body={t('analyticsSection.loadFailedBody')}
        action={
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" />
            {t('retry')}
          </Button>
        }
      />
    );
  }

  if (state === 'empty') {
    return (
      <SectionMessagePanel
        icon={Inbox}
        iconClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        title={t(ak('adminAnalytics.section.emptyTitle'))}
        body={t('noDataYet')}
      />
    );
  }

  return null;
}

/** Formats the resolved window for the section caption (dates localized). */
export function useResolvedWindowLabel(): (resolved: AdminResolvedWindow | null) => string | null {
  const { t, lang } = useLanguage();
  return (resolved) => {
    if (!resolved?.from || !resolved?.to) return null;
    try {
      const locale = getLocale(lang);
      const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      const from = fmt.format(new Date(resolved.from));
      const to = fmt.format(new Date(resolved.to));
      return t(ak('adminAnalytics.window.label'), { from, to });
    } catch {
      return null;
    }
  };
}
