'use client';

// ─── Task 42-e: weekday × hour heatmap ──────────────────────────────────────
// 7 rows (weekday, 0 = Sunday) × 24 columns (hour) CSS-grid heatmap built
// from the SPARSE weekdayHourMatrix (only count>0 cells arrive). Color
// intensity is emerald-scaled; native `title` tooltips keep it dependency-
// free. Hours axis stays LTR inside RTL layouts.

import { useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Grid3x3 } from 'lucide-react';
import { getLocale } from '@/components/agency/dashboard/helpers';
import { ak } from './i18n-keys';
import type { AnalyticsWeekdayHourCell } from './types';

// 2023-01-01 was a Sunday — stable anchor for weekday labels (0 = Sunday).
const SUNDAY_ANCHOR = Date.UTC(2023, 0, 1);

function weekdayLabel(weekday: number, lang: string): string {
  try {
    const fmt = new Intl.DateTimeFormat(getLocale(lang), { weekday: 'short', timeZone: 'UTC' });
    return fmt.format(new Date(SUNDAY_ANCHOR + weekday * 86_400_000));
  } catch {
    return String(weekday);
  }
}

/** Emerald intensity ramp (light → dark) by traffic ratio. */
function intensityClass(ratio: number): string {
  if (ratio <= 0) return 'bg-muted/50 dark:bg-muted/20';
  if (ratio < 0.25) return 'bg-emerald-200/80 dark:bg-emerald-900/50';
  if (ratio < 0.5) return 'bg-emerald-300 dark:bg-emerald-800';
  if (ratio < 0.75) return 'bg-emerald-500 dark:bg-emerald-600';
  return 'bg-emerald-600 dark:bg-emerald-500';
}

const LEGEND_STEPS = [
  'bg-muted/50 dark:bg-muted/20',
  'bg-emerald-200/80 dark:bg-emerald-900/50',
  'bg-emerald-300 dark:bg-emerald-800',
  'bg-emerald-500 dark:bg-emerald-600',
  'bg-emerald-600 dark:bg-emerald-500',
];

export function HeatmapPanel({ weekdayHourMatrix }: { weekdayHourMatrix: AnalyticsWeekdayHourCell[] }) {
  const { t, lang } = useLanguage();

  const { grid, maxCount, hasData } = useMemo(() => {
    const map = new Map<string, number>();
    let max = 0;
    for (const cell of weekdayHourMatrix ?? []) {
      if (!cell || cell.count <= 0) continue;
      const key = `${cell.weekday}-${cell.hour}`;
      const next = (map.get(key) ?? 0) + cell.count;
      map.set(key, next);
      if (next > max) max = next;
    }
    return { grid: map, maxCount: max, hasData: max > 0 };
  }, [weekdayHourMatrix]);

  const safe = (v: unknown): number => (Number.isFinite(v as number) ? (v as number) : 0);

  return (
    <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-600 flex items-center justify-center shrink-0">
            <Grid3x3 className="h-4 w-4 text-white" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold">{t(ak('analyticsSection.heatmap.title'))}</CardTitle>
            <p className="text-[10px] text-muted-foreground">{t(ak('analyticsSection.heatmap.subtitle'))}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center py-10 text-center text-muted-foreground">
            <Grid3x3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
            <p className="text-sm">{t('noDataYet')}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto custom-scrollbar pb-1">
              <div className="min-w-[560px]" dir="ltr">
                {/* Hour header row */}
                <div
                  className="grid gap-[3px] mb-1"
                  style={{ gridTemplateColumns: '44px repeat(24, minmax(0, 1fr))' }}
                >
                  <span />
                  {Array.from({ length: 24 }, (_, h) => (
                    <span key={h} className="text-[8px] text-muted-foreground text-center tabular-nums">
                      {h % 3 === 0 ? h : ''}
                    </span>
                  ))}
                </div>
                {/* Weekday rows */}
                <div className="space-y-[3px]">
                  {Array.from({ length: 7 }, (_, weekday) => (
                    <div
                      key={weekday}
                      className="grid gap-[3px]"
                      style={{ gridTemplateColumns: '44px repeat(24, minmax(0, 1fr))' }}
                    >
                      <span className="text-[10px] font-medium text-muted-foreground leading-[16px] truncate pe-1">
                        {weekdayLabel(weekday, lang)}
                      </span>
                      {Array.from({ length: 24 }, (_, hour) => {
                        const count = safe(grid.get(`${weekday}-${hour}`));
                        const ratio = maxCount > 0 ? count / maxCount : 0;
                        return (
                          <div
                            key={hour}
                            title={`${weekdayLabel(weekday, lang)} ${String(hour).padStart(2, '0')}:00 · ${count.toLocaleString()} ${t('reservationsCount')}`}
                            className={`h-4 rounded-[3px] ${intensityClass(ratio)} transition-transform hover:scale-110`}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {/* Intensity legend */}
            <div className="mt-3 flex items-center justify-end gap-1.5" dir="ltr">
              <span className="text-[10px] text-muted-foreground me-1">{t(ak('analyticsSection.heatmap.less'))}</span>
              {LEGEND_STEPS.map((cls) => (
                <span key={cls} className={`h-3 w-5 rounded-[3px] ${cls}`} />
              ))}
              <span className="text-[10px] text-muted-foreground ms-1">{t(ak('analyticsSection.heatmap.more'))}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
