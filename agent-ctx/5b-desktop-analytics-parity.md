# Task 5b: Desktop Analytics Parity

## Task
Fix Desktop Analytics page to use shared agency components instead of its custom implementation.

## Work Completed

### Files Modified
1. **apps/desktop/frontend/src/pages/Analytics.tsx** — Complete rewrite from 203-line custom implementation to comprehensive analytics page using shared components
2. **apps/desktop/frontend/src/i18n/en.ts** — Added `dailyVisitors` key
3. **apps/desktop/frontend/src/i18n/fr.ts** — Added `dailyVisitors` key
4. **apps/desktop/frontend/src/i18n/ar.ts** — Added `dailyVisitors` key

### What Changed in Analytics.tsx

**Before**: Custom 203-line implementation with:
- Simple inline `BarChart` component (CSS bars, no recharts)
- Direct `useApi` + `api.getNoShowAnalytics()` calls
- Basic no-show details (total, no-shows, rate, by-service text list)
- Basic peak hours bar chart
- Basic service breakdown bar chart
- Basic daily visitors bar chart
- No rating distribution, no wait time visualization, no peak hours heatmap

**After**: Comprehensive analytics page using all shared agency components:
- **NoShowAnalytics** (`@/components/agency/no-show-analytics`) — self-fetching, period selector (7/30/90 days), summary cards, daily trend line chart, by-service breakdown, by-hour breakdown
- **PeakHoursAnalytics** (`@/components/agency/peak-hours-analytics`) — self-fetching, peak hour cards, weekday demand heatmap, hourly demand bar chart, avg wait by hour line chart, service peak hours table, daily wait trend
- **WaitTimeChart** (`@/components/agency/wait-time-chart`) — hourly wait bars with trend indicator and throughput
- **RatingDistribution** (`@/components/agency/rating-distribution`) — star distribution bars with average and total
- **ServiceBreakdown** (`@/components/agency/dashboard/service-breakdown`) — service bars with waiting counts and completion percentages
- **DailyVisitorsChart** — recharts BarChart for daily visitors (replaces old custom BarChart)

### Layout
- Page header with i18n title/description
- NoShowAnalytics section (full-width, wrapped in Card with header)
- PeakHoursAnalytics section (full-width, wrapped in Card with header)
- WaitTimeChart + RatingDistribution (2-col grid on lg)
- ServiceBreakdown + DailyVisitorsChart (2-col grid on lg)
- Loading skeletons during data fetch
- Framer-motion entrance animations with staggered delays

### Data Fetching
- `apiFetch` for stats (WaitTimeChart/RatingDistribution data)
- `apiFetch` for services (ServiceBreakdown data)
- `apiFetch` for daily chart
- NoShowAnalytics and PeakHoursAnalytics fetch their own data internally (they take `agencyId` prop)
- `agencyId` obtained from `useAppStore()` (same pattern as dashboard)
