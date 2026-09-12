# Phase 1: BLASTI Desktop/Web Parity Port — Agency Components

## Summary
Copied ALL agency components from Web (`apps/web/src/components/agency/`) to Desktop (`apps/desktop/frontend/src/components/agency/`) with full adaptation for Vite/React Router environment.

## Files Copied (36 total)

### Dashboard sub-components (13 files)
- `dashboard/types.ts` — Extended with `walkInCount`, `activeCounters`, `beingServed`, `maxReservations`
- `dashboard/use-dashboard-data.ts` — Core data hook, all apiFetch calls preserved
- `dashboard/helpers.tsx` — AnimatedCounter, MiniSparkline, service name helpers
- `dashboard/queue-controls.tsx` — Currently Serving card + Quick Actions
- `dashboard/waiting-list.tsx` — Waiting queue with batch mode
- `dashboard/service-breakdown.tsx` — Service breakdown bars
- `dashboard/todays-summary.tsx` — Today's summary stat cards
- `dashboard/queue-timeline.tsx` — Hourly timeline chart
- `dashboard/queue-efficiency.tsx` — Completion rate ring
- `dashboard/counter-management.tsx` — Service counters view
- `dashboard/ticket-confirmation.tsx` — Walk-in ticket popup
- `dashboard/eta-badge.tsx` — ETA color-coded badge
- `dashboard/offline-indicator.tsx` — Online/offline indicator
- `dashboard/SimpleMobileDashboard.tsx` — Mobile dashboard view

### Main Agency views (12 files)
- `agency-dashboard.tsx`, `agency-settings.tsx`, `agency-profile.tsx`
- `agency-employees.tsx`, `agency-branches.tsx`, `agency-reviews.tsx`
- `agency-subscription.tsx`, `agency-fullscreen.tsx`, `agency-fullscreen-history.tsx`
- `agency-history-sheet.tsx`, `agency-qr-display.tsx`, `create-agency-form.tsx`

### Analytics components (6 files)
- `no-show-analytics.tsx`, `peak-hours-analytics.tsx`
- `wait-time-chart.tsx`, `rating-distribution.tsx`
- `QuickStatsWidget.tsx`, `queue-status-widget.tsx`

### Subscription sub-components (4 files)
- `subscription/plan-card.tsx`, `subscription/payment-form.tsx`
- `subscription/transaction-history.tsx`, `subscription/types.ts`

## Adaptations Applied
1. **Removed `'use client'`** from all files
2. **Replaced `process.env.NEXT_PUBLIC_APP_URL`** with `import.meta.env.`
3. **Fixed framer-motion `ease` types** — added `as const` for string literal types
4. **Fixed `<style jsx>`** → `<style>` (Next.js styled-jsx → regular style)
5. **Extended `DashboardStats` type** with `walkInCount`, `activeCounters`, etc.
6. **Fixed `getServiceName` type** in agency-fullscreen-history.tsx to accept both `serviceName` and `name` props
7. **No next/image, next/link, or next/navigation imports** found in source — no adaptation needed

## Page Shells Updated
- `Dashboard.tsx` → renders `<AgencyDashboard />`
- `Settings.tsx` → renders `<AgencySettings />`
- `Queue.tsx` → renders `<AgencyProfile />`
- `Staff.tsx` → renders `<AgencyEmployees />`
- `Branches.tsx` → renders `<AgencyBranches />`
- `Reviews.tsx` → renders `<AgencyReviews />`
- `Subscription.tsx` → renders `<AgencySubscription />`
- `QrCode.tsx` → renders `<AgencyQrDisplay />`

## Routes Added
- `/fullscreen` → `<AgencyFullscreen />` (no sidebar)
- `/fullscreen/history` → `<AgencyFullscreenHistory />` (no sidebar)

## Verification
- 0 agency-related TypeScript errors
- All key dependencies verified (api-fetch, use-app-store, use-language, framer-motion, recharts, sonner, qrcode)
- All shared components verified (empty-state, error-state, slide-to-confirm, staff-permissions-editor, queue-status-badge)
