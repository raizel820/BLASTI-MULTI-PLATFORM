# Task ID: fix-empty-analytics-charts

## Summary
Added friendly empty-state messaging to the 4 bottom-of-dashboard analytics components (no-show, peak-hours, wait-time, rating-distribution) so that when the API returns all-zero / null-date data, the user sees a centered "No data yet — data will appear as you serve more customers." message with an emerald chart icon instead of a blank chart that looks broken.

Also fixed a real compile error in `wait-time-chart.tsx` that was breaking the entire web app (SWC parser: `Expected '</', got 'ident'` at line 182) — the JSX ternary wrapping was malformed.

## Files changed (7)
- `apps/web/src/i18n/en.ts` — added `noDataYet` key
- `apps/web/src/i18n/ar.ts` — added `noDataYet` key
- `apps/web/src/i18n/fr.ts` — added `noDataYet` key
- `apps/web/src/components/agency/no-show-analytics.tsx` — 3 empty-state gates + null-date filter + formatDate null-safe
- `apps/web/src/components/agency/peak-hours-analytics.tsx` — 4 empty-state gates + limited-data note
- `apps/web/src/components/agency/wait-time-chart.tsx` — fixed broken JSX ternary structure (compile error fix)
- `apps/web/src/components/agency/rating-distribution.tsx` — removed fake fallback data, added empty state

## Empty-state pattern
```tsx
<div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
  <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
  <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as you serve more customers.'}</p>
</div>
```

## Key decisions
1. **No-show KPI cards left ungated** — showing "0%" no-show rate is meaningful (reassuring), so only the chart sections get empty states.
2. **"Meaningful data" = `some(item.value > 0)`**, not just `length > 0`. The API returns `[{hour:0, count:3, avgWait:0}]` for peak-hours (length 1, count 3) — that's real data we want to show, with a "Limited data" note. But `[{date:null, total:3, noShows:0, rate:0}]` for daily-trend has zero variation in `rate`, so it gets the empty state.
3. **Null dates filtered, not just relabeled** — `validDailyTrend` strips entries with null/invalid dates before passing to `<LineChart>`. The `formatDate` helper also returns `'—'` (em dash) as a defensive fallback for any null that slips through to a tickFormatter.
4. **`isAnimationActive={false}`** added to all `<Line>` and `<Bar>` components in the analytics charts — recharts' default draw-in animation makes a 0-value line look "broken" for the first ~600ms after mount; disabling it makes the empty-state-vs-real-data transition instant.
5. **Rating-distribution fake fallback REMOVED entirely** — per task spec. If `ratings` is empty or all counts are 0, the empty state renders. No more `[{rating:5, count:45}, ...]` mock data showing up on new agencies.

## Verification
- `cd /home/z/my-project && bun run lint` → exit 0, 0 errors, 0 warnings.
- `bunx tsc --noEmit -p apps/web/tsconfig.json` → 0 errors in the 4 modified component files (pre-existing TS errors elsewhere in `admin/` are unrelated).
- `tail -30 /home/z/my-project/dev.log` → only `✓ Compiled in <N>ms` and unrelated pre-existing `DialogContent` aria warnings. The wait-time-chart SWC parser error that was logged earlier in the session is resolved.
- `curl http://localhost:3000/` → 200 OK after the fix.

## Worklog
Appended a detailed entry to `/home/z/my-project/worklog.md` (starts with `---` separator, header `## Task ID: fix-empty-analytics-charts`).
