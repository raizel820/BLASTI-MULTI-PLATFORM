# Task ID: admin-hardware-enterprise-ui

## Summary
Added the admin-side UI for the existing hardware-catalog + enterprise-request backend endpoints. Two new lazy-loaded admin views, wired into the ViewRouter and admin sidebar, with full i18n in en/ar/fr.

## Files created
- `apps/web/src/components/admin/admin-hardware.tsx` — `AdminHardware` (3 sections: Hardware Settings card with toggle + discount, Hardware Products table with create/edit/delete + inline active toggle, Commitment Tiers grid with inline extra-percentage editing).
- `apps/web/src/components/admin/admin-enterprise-requests.tsx` — `AdminEnterpriseRequests` (filter buttons + request cards with status pill, contact info, branches/counters/hardware summary, message, requested features, admin notes, custom plan link, and Review / Reject / Create Custom Plan actions; full plan-creation dialog).

## Files modified
- `apps/web/src/app/page.tsx` — added 2 `lazy()` imports + 2 `case` clauses in ViewRouter.
- `apps/web/src/components/platform/adaptive-sidebar.tsx` — added `Cpu` + `MailCheck` imports and 2 nav items (`admin-hardware`, `admin-enterprise-requests`) to the admin sidebar.
- `apps/web/src/store/use-app-store.ts` — added the 2 new view names to `ViewName` union, `viewHashMap`, and `VALID_VIEW_NAMES` runtime set (so hash deep links + persisted state work).
- `apps/web/src/i18n/en.ts`, `ar.ts`, `fr.ts` — added 30 new keys covering hardware management, commitment tiers, enterprise requests, and admin plan creation. Avoided duplicating existing keys (`upfrontDiscount`, `extraPercentage`, `enterpriseRequests`, `sortOrder`, `planPrice`, `billingCycle`, `branchesCounters`).

## Backend (no changes — already implemented)
- `GET/PATCH /api/admin/hardware` (list + create)
- `GET/PATCH /api/admin/hardware/:id` (update + delete) + `DELETE`
- `GET/PATCH /api/admin/hardware/settings` (settings + commitment tiers)
- `PATCH /api/admin/hardware/commitment-tiers/:id`
- `GET/POST /api/admin/enterprise-requests` + `/enterprise-requests/:id/create-plan`

## Verification
- `bun run lint` → exit 0 (clean).
- Dev server (web :3000) running and responding 200.
- No backend files modified.
- No agency subscription page modified.
- No test code added.
- All API calls use relative paths only.

## Notes for downstream agents
- Pre-existing TS errors in `apps/web/src/i18n/*.ts` (duplicate keys at e.g. en.ts lines 289-291 vs 1914-1916) and `apps/web/src/lib/route-map.ts` (missing ViewName entries) are from previous tasks — out of scope here. ESLint passes cleanly.
- The new admin views use the same gradient-header + `motion.div` pattern as `admin-subscription-plans.tsx` for visual consistency.
- Hardware product `isActive` toggle and commitment tier `isActive` toggle both use optimistic UI with revert-on-error.
- Enterprise request status updates also use optimistic local state updates (no full re-fetch unless the user clicks Refresh).
- The "Create Custom Plan" form is pre-populated with derived defaults from the request (`maxBranches` from `branchesNeeded`, feature toggles from `requestedFeatures`, plan name sanitized from `agencyName`).
