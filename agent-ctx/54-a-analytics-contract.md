# Task 54-a — Analytics API Contract (doc-2 role-scoped analytics)

> **Audience: frontend agents (54-b super-admin, 54-c owner, 54-d staff+customer). Code strictly against this.**
> Canonical spec: `docs/chatgpt-doc2-analytics-spec.md` (§3.1 periods, §3.2 filters, §5-14 admin, §15-28 owner, §29-37 staff, §38-44 customer, §47-48 permission matrix, §55 backend-enforced authz).
> Backend files: `apps/api/src/lib/analytics-dashboard.ts` (period engine), `apps/api/src/lib/analytics-engine.ts` (pure aggregators), `apps/api/src/routes/admin.ts`, `apps/api/src/routes/agency.ts`, `apps/api/src/routes/staff-analytics.ts`, `apps/api/src/routes/customer-analytics.ts`.
> ALL endpoints below were live-verified 2026-09-27: **169 requests, zero 5xx**, full permission matrix enforced. Battery: `tool-results/tmp/verify-54a-full.ts`. Examples below are REAL captured payloads (trimmed with `…` for repetition), captured by `tool-results/tmp/samples-54a.ts` against seeded data.

---

## 0. Global conventions

### 0.1 Envelope
Every NEW endpoint answers `{ "success": true, "data": { …section, "resolved": … } }` where:

```json
"resolved": { "period": "30d", "granularity": "daily", "from": "2026-08-28T08:25:48.339Z", "to": "2026-09-27T08:25:48.339Z", "previousFrom": "2026-07-29T08:25:48.339Z", "previousTo": "2026-08-28T08:25:48.339Z" }
```

Use `resolved.from/to` for the UI period label, `previousFrom/previousTo` for comparison labels. EXCEPTIONS: `staff/my-overview` + `staff/today-queue` are fixed-TODAY operational views (no `resolved`; data under `today:`); `admin/overview` uses legacy `range` + additive `resolved`. LEGACY routes (§5) have NO envelope.

### 0.2 Period system (§3.1) — query param `period`
`today | yesterday | 7d | 30d | 90d | 12m | this-week | last-week | this-month | last-month | this-quarter | last-quarter | this-year | last-year | custom`

- Legacy `7d|30d|90d|12m` keep EXACT legacy math (end=now; start=end−N×24h; 12m = 11 months back, 1st of month, incl. current). Old dashboards unaffected.
- `custom` REQUIRES `from` + `to` (ISO date `YYYY-MM-DD` or full timestamp; date-only expands to full UTC days). Missing/invalid → **400** `{ "success": false, "error": "PERIOD_INVALID: …" }`.
- Unknown `period` → falls back to section default (silent 200). Defaults: admin 30d; owner 30d; staff my-performance/my-services 30d; customer my-overview/my-activity 30d, my-reservations/my-queue-history/my-ratings 12m.
- Granularity (drives `resolved.granularity` + bucket keys): today/yesterday → hourly; 7d/30d/90d/weeks → daily; months/quarters/12m/years → monthly; custom → daily ≤92 days else monthly. Timeseries `bucket` keys: `YYYY-MM-DDTHH` (hourly) / `YYYY-MM-DD` (daily) / `YYYY-MM` (monthly), UTC, ZERO-FILLED — render directly.

### 0.3 Auth + errors (§55 — backend enforces; hiding nav is NOT sufficient)
- Bearer JWT: `Authorization: Bearer <token>`; token field of `POST /api/auth/login` response.
- `401` `{ "success": false, "error": "…" }` (no/invalid token) · `403` `{ "success": false, "error": "FORBIDDEN" }` or descriptive scope message · `400` `{ "success": false, "error": "PERIOD_INVALID: …" }` · `429` `{ "success": false, "error": "Too many requests, please try again later", "retryAfter": 60 }`.
- Rate limits: GLOBAL 100 req/min/IP over all of `/api/*`; login 10/15 min/IP. Frontend MUST debounce period switches / not fan-out >90 analytics calls per minute.
- Empty data is ZERO-SAFE: counters 0, distributions zero-filled, averages `null` — never an error.

### 0.4 Verified permission matrix (live-tested with real tokens — exact statuses)
| Caller \ Family | `/api/admin/analytics/*` | `/api/agency/analytics/*` operational | `/api/agency/analytics/{payments,working-hours}` | `/api/staff/analytics/*` | `/api/customer/analytics/*` |
|---|---|---|---|---|---|
| SUPER_ADMIN | 200 | 200 (or `?agencyId=` inspect) | 200 | 403 | 403 |
| AGENCY_OWNER | 403 | 200 (own agency only) | 200 | 403 | 403 |
| AGENCY_STAFF (active row + canViewAnalytics) | 403 | 200 (own agency, operational) | **403** | 200 | 403 |
| AGENCY_STAFF (canViewAnalytics=false) | 403 | — | 403 | **403 `PERMISSION_DENIED:canViewAnalytics`** | 403 |
| CUSTOMER | **403** | 403 | 403 | 403 | 200 |
| ANON | 401 | 401 | 401 | 401 | 401 |

Staff seeing OPERATIONAL owner analytics is pre-existing product behavior (legacy `/api/agency/analytics/dashboard` was already owner+staff); doc-2 §37 restricted set (financial/subscription/platform) is enforced 403.

### 0.5 Org filters (§3.2) — on `admin/analytics/reservations` + `owner/analytics/reservations`
`agencyId` (admin only), `category` (admin), `wilaya` (admin), `branchId`, `counterId`, `serviceId`, `staffId`, `status` (`WAITING|CALLED|SERVING|COMPLETED|CANCELLED|NO_SHOW`), `channel` (`walkIn|online`). All combinable with any period. Owner sections lock scope to the caller's own agency regardless of params; a foreign `agencyId` → 403.

---

## 1. SUPER ADMIN — `GET /api/admin/analytics/<section>` (14 sections, all live-verified)

Auth: `requireAdmin` (SUPER_ADMIN only). Default period `30d`.

### 1.1 `/overview` (§6 Platform Overview) — Models: User, Agency, Reservation, Review, Service, Branch, Counter
Legacy dashboard payload PLUS additive `platform` + `resolved`. `timeseries[].date` (legacy key style), `channel.daily[].date`.
```json
{ "period":"30d","generatedAt":"…","range":{"start":"…","end":"…","previousStart":"…","previousEnd":"…"},"kpis":{"total":18,"completed":10,"cancelled":3,"noShow":2,"completionRate":55.6,"cancellationRate":16.7,"noShowRate":11.1,"avgWaitMinutes":6,"avgServiceMinutes":8,"avgRating":3.8,"ratingCount":6,"walkInCount":7,"onlineCount":10,"walkInRate":38.9,"onlineRate":55.6,"uniqueCustomers":1,"deltas":{…}},"timeseries":[{"date":"2026-08-28","total":0,"completed":0,"cancelled":0,"noShow":0,"avgWaitMinutes":null,"walkIn":0,"online":0}],"statusDistribution":[{"status":"WAITING","count":2}],"hourlyTraffic":[{"hour":0,"count":0}],"weekdayHourMatrix":[{"weekday":0,"hour":1,"count":1}],"services":[…],"branches":[],"counters":[],"ratings":{"distribution":[…],"average":3.8,"count":6},"peak":{"busiestHour":8,"busiestWeekday":0,"busiestDay":"2026-09-27"},"channel":{"onlineCount":10,"walkInCount":7,"total":18,"onlineRate":55.6,"walkInRate":38.9,"daily":[…]},"scope":"global","topAgencies":[{"agencyId":"…","name":"My Agency","customCode":"MY ","category":"OTHER","total":18,"completed":10,"completionRate":55.6,"onlineCount":10,"walkInCount":7,"onlineRate":55.6,"walkInRate":38.9,"avgWaitMinutes":6,"avgRating":3.8}],"platform":{"totalAgencies":1,"activeAgencies":1,"totalCustomers":1,"newCustomersInPeriod":1,"totalReservationsAllTime":22,"onlineRateAllTime":54.5,"walkInRateAllTime":36.4,"totalUsers":4,"newUsersInPeriod":4,"byRoleCounts":{"AGENCY_OWNER":1,"AGENCY_STAFF":1,"CUSTOMER":1,"SUPER_ADMIN":1}},"resolved":{…} }
```

### 1.2 `/users` (§11 User Analytics) — Models: User, Reservation
```json
{ "resolved":{…}, "totals":{"totalUsers":4,"activeUsers":4,"suspendedUsers":0,"verifiedUsers":4,"unverifiedUsers":0,"newUsersInPeriod":4}, "byRole":{"AGENCY_OWNER":1,"AGENCY_STAFF":1,"CUSTOMER":1,"SUPER_ADMIN":1}, "newByRole":{…}, "activity":{"dau":1,"wau":1,"mau":1}, "newUsersTimeseries":[{"bucket":"2026-08-28","count":0}] }
```

### 1.3 `/agencies` — Models: Agency, Branch, Counter, Service
```json
{ "resolved":{…}, "totals":{"total":1,"active":1,"inactive":0,"pendingApprovals":0,"newInPeriod":1}, "byCategory":{"OTHER":1}, "bySubscriptionTier":{"FREE":1}, "bySubscriptionStatus":{"INACTIVE":1}, "newAgenciesTimeseries":[…], "platform":{"totalBranches":1,"totalServices":2,"totalCounters":2} }
```

### 1.4 `/categories` (§7) — Models: AgencyCategory, Agency, Reservation, Service, AgencyStaff, Branch, Counter
`categories[]` covers every existing category (zero-filled when unused).
```json
{ "resolved":{…}, "categories":[{ "category":"OTHER","agencies":1,"activeAgencies":1,"newAgencies":1,"branches":1,"services":2,"counters":2,"staff":1,"activeStaff":1,"reservations":18,"completed":10,"cancelled":3,"noShow":2,"completionRate":55.6,"cancellationRate":16.7,"noShowRate":11.1,"avgWaitMinutes":6 }] }
```

### 1.5 `/reservations` (§8 — full §3.2 filter set) — Models: Reservation, Agency, Branch, Counter, Service
`timeseries[]/channel.daily[]` use `bucket` key.
```json
{ "resolved":{…}, "kpis":{"total":18,"byStatus":{…},"completed":10,"cancelled":3,"noShow":2,"waiting":2,"called":0,"serving":1,"completionRate":55.6,"cancellationRate":16.7,"noShowRate":11.1,"walkInCount":7,"onlineCount":10,"walkInRate":38.9,"onlineRate":55.6,"uniqueCustomers":1,"avgWaitMinutes":6,"medianWaitMinutes":6,"maxWaitMinutes":6,"avgServiceMinutes":8,"medianServiceMinutes":8,"maxServiceMinutes":8,"customersPerHour":0}, "statusDistribution":[…], "channel":{"onlineCount":10,"walkInCount":7,"total":18,"onlineRate":55.6,"walkInRate":38.9,"daily":[{"bucket":"2026-08-28","online":0,"walkIn":0}]}, "timeseries":[{"bucket":"2026-08-28","total":0,"completed":0,"cancelled":0,"noShow":0,"walkIn":0,"online":0,"avgWaitMinutes":null}], "hourlyTraffic":[…],"weekdayTraffic":[…],"peak":{…},"topBranches":[],"topServices":[{ "serviceId":"…","name":"Consultation 54a","agencyId":"…","key":"…","count":11,"completed":7,"cancelled":1,"noShow":1,"walkIn":6,"online":5,"completionRate":63.6,"avgWaitMinutes":6,"avgServiceMinutes":8 }],"topAgencies":[…] }
```

### 1.6 `/queues` (§9) — Models: Agency, QueueSettings, Reservation
```json
{ "resolved":{…}, "live":{"agenciesWithOpenQueue":1,"agenciesPaused":0,"currentlyWaiting":2,"currentlyCalled":0,"currentlyServing":1}, "today":{"ticketsServedToday":3}, "period":{"ticketsInPeriod":18,"ticketsServedInPeriod":10,"callsInPeriod":13,"avgWaitingTimeMinutes":6,"medianWaitingTimeMinutes":6,"avgServiceDurationMinutes":8,"callsPerHour":0,"customersServedPerHour":0,"noShowRate":11.1,"abandonmentRate":11.1,"hourlyCalls":[{"hour":0,"count":0}]} }
```

### 1.7 `/services` (§10) — Models: Service, Reservation, Agency
```json
{ "resolved":{…}, "totals":{"totalServices":2,"activeServices":2,"servicesPerAgencyAvg":2}, "topServices":[{ "serviceId":"…","name":"Consultation 54a","agencyId":"…","key":"…","count":11,"completed":7,"cancelled":1,"noShow":1,"walkIn":6,"online":5,"completionRate":63.6,"avgWaitMinutes":6,"avgServiceMinutes":8 }] }
```

### 1.8 `/customers` (§22 scope, platform view — display-safe fields only) — Models: User, Reservation
```json
{ "resolved":{…}, "totals":{"totalCustomers":1,"newCustomersInPeriod":1,"customersWithReservationInPeriod":1,"reservationsPerCustomer":10}, "topCustomers":[{ "userId":"…","name":"Task54a Test Customer","reservations":10 }] }
```

### 1.9 `/subscriptions` (§12) — Models: SubscriptionPlan, Agency
`planDistribution` empty when no agency has an assigned plan.
```json
{ "resolved":{…}, "totals":{"activeSubscriptions":0,"newSubscriptionsInPeriod":0,"expiringWithin30Days":0,"agenciesWithoutPlan":1,"plansInCatalog":3}, "planDistribution":[], "byTier":{"FREE":1}, "byStatus":{"INACTIVE":1} }
```

### 1.10 `/payments` (§13 Payment & Revenue) — Models: Transaction
```json
{ "resolved":{…}, "totals":{"transactionsInPeriod":2,"successfulPayments":1,"pendingPayments":1,"rejectedPayments":0,"totalRevenue":5000,"currency":"DZD","avgTransactionValue":5000}, "byStatus":{"APPROVED":{"count":1,"value":5000},"PENDING":{"count":1,"value":0}}, "byPaymentMethod":{"chargily":{"count":1,"value":5000},"ccp":{"count":1,"value":0}}, "revenueTimeseries":[{"bucket":"2026-08-28","revenue":0}] }
```

### 1.11 `/sms` — Models: SmsLog, SmsPurchase, SmsSettings
```json
{ "resolved":{…}, "messages":{"sentInPeriod":2,"delivered":1,"failed":1,"byStatus":{"DELIVERED":1,"FAILED":1}}, "purchases":{"count":1,"units":100,"value":1000,"byStatus":{"APPROVED":1}}, "provider":{"enabled":false,"provider":null} }
```

### 1.12 `/notifications` — Models: Notification
```json
{ "resolved":{…}, "totals":{"countInPeriod":2,"unreadInPeriod":1,"totalAllTime":2}, "byType":{"completed":1,"queue_called":1} }
```

### 1.13 `/devices` (hardware) — Models: DeviceRegistration, AgencyDevice
```json
{ "resolved":{…}, "agencyDevices":{"total":1,"activeInPeriod":1,"online":1,"offline":0,"onlineByHeartbeat15m":0,"byStatus":{"ONLINE":1},"byType":{"TV":1},"byConnection":{"LAN":1},"totalUptimeSec":0}, "customerDevices":{"total":1,"newInPeriod":1,"activeLast7d":1,"byPlatform":{"web":1}} }
```

### 1.14 `/security-audit` (§5.1 — AGGREGATES ONLY, no raw log entries) — Models: AuditLog
```json
{ "resolved":{…}, "totals":{"eventsInPeriod":58,"distinctActors":4}, "topActions":[{"action":"LOGIN","count":41}], "byEntityType":{"AGENCY":4,"SYSTEM_SETTING":13,"USER":41} }
```

---

## 2. AGENCY OWNER — `GET /api/agency/analytics/<section>` (10 sections, all live-verified)

Auth: `requireAuth` + agency resolution (owner / staff-of-agency / SUPER_ADMIN via `resolveUserAgencyId`; SUPER_ADMIN may pass `?agencyId=<id>`, others CANNOT — foreign id → 403). Default period `30d`. EVERY query locked to the caller's agencyId BEFORE aggregation (§4/§50). `payments` + `working-hours` are owner-or-admin ONLY (staff → 403).

### 2.1 `/overview` (§17) — Models: Reservation, Agency, Branch, AgencyStaff, Counter, AgencyDevice
```json
{ "resolved":{…}, "agency":{"id":"…","name":"My Agency","category":"OTHER","isQueueOpen":true}, "kpis":{"total":18,"byStatus":{…},"completed":10,"cancelled":3,"noShow":2,"waiting":2,"called":0,"serving":1,"completionRate":55.6,"cancellationRate":16.7,"noShowRate":11.1,"walkInCount":7,"onlineCount":10,"walkInRate":38.9,"onlineRate":55.6,"uniqueCustomers":1,"avgWaitMinutes":6,"medianWaitMinutes":6,"maxWaitMinutes":6,"avgServiceMinutes":8,"medianServiceMinutes":8,"maxServiceMinutes":8,"customersPerHour":0}, "statusDistribution":[…], "ratings":{"average":3.8,"count":6,"distribution":[…]}, "resources":{"branchesTotal":1,"branchesActive":1,"staffActive":1,"countersTotal":2,"devicesTotal":1,"devicesOnline":1}, "today":{"servedToday":3}, "timeseries":[{"bucket":"2026-08-28","total":0,"completed":0,"cancelled":0,"noShow":0,"walkIn":0,"online":0,"avgWaitMinutes":null}], "peak":{…} }
```

### 2.2 `/reservations` (§18 — §3.2 filters minus agencyId) — Models: Reservation, Service, Branch, Counter
```json
{ "resolved":{…}, "kpis":{…same shape as admin/reservations…}, "statusDistribution":[…], "channel":{…}, "timeseries":[…], "hourlyTraffic":[…], "weekdayTraffic":[…], "peak":{…}, "byService":[…], "byBranch":[…], "byCounter":[…] }
```

### 2.3 `/queue` (§19 live + period) — Models: Reservation, Agency, QueueSettings, Counter
```json
{ "resolved":{…}, "queueStatus":{"isQueueOpen":true,"isPaused":false,"pausedAt":null,"openedAt":"2026-09-27T06:04:13.006Z"}, "live":{"currentlyWaiting":2,"currentlyCalled":0,"currentlyServing":1,"queueLength":2,"nextTicket":{"id":"…","displayNumber":"T5-011","joinedAt":"…"},"avgCurrentWaitMinutes":2190}, "period":{"avgWaitingTimeMinutes":6,"medianWaitingTimeMinutes":6,"maxWaitingTimeMinutes":6,"avgServiceDurationMinutes":8,"callsPerHour":0,"customersServedPerHour":0,"noShowRate":11.1,"abandonmentRate":11.1,"queueSizeByHour":[{"hour":0,"count":0}],"counterUtilization":[]} }
```

### 2.4 `/branches` (§20) — Models: Branch, Counter, AgencyStaff, AgencyDevice, Reservation (via counters)
```json
{ "resolved":{…}, "totals":{"branches":1,"reservationsInPeriod":18}, "branches":[{ "branchId":"…","name":"Branch 54a","nameAr":null,"nameFr":null,"isActive":true,"isMain":false,"countersTotal":2,"countersActive":2,"staffActive":1,"devicesTotal":1,"devicesOnline":1,"reservations":0,"customersServed":0,"completed":0,"cancelled":0,"noShow":0,"completionRate":0,"avgWaitMinutes":null,"avgServiceMinutes":null }] }
```

### 2.5 `/staff` (§21) — Models: AgencyStaff, User, Counter, Reservation
```json
{ "resolved":{…}, "totals":{"staff":1,"active":1}, "staff":[{ "staffId":"…","userId":"…","name":"Task54a Test Staff","role":"STAFF","isActive":true,"branchId":"…","countersAssigned":1,"reservationsHandled":0,"completed":0,"cancelled":0,"noShow":0,"completionRate":0,"avgServiceMinutes":null,"avgWaitMinutes":null }] }
```

### 2.6 `/customers` (§22 own-agency customers) — Models: Reservation, User, Service
```json
{ "resolved":{…}, "totals":{"uniqueCustomers":1,"newCustomers":0,"returningCustomers":1,"repeatVisits":9,"reservationsPerCustomer":10,"cancellationRate":16.7,"noShowRate":11.1}, "mostRequestedServices":[{"serviceId":"…","name":"Consultation 54a","count":11}], "topCustomers":[{"userId":"…","name":"Task54a Test Customer","reservations":10}] }
```

### 2.7 `/satisfaction` (§23 Review aggregates) — Models: Review, Reservation, Service, Branch, Counter
```json
{ "resolved":{…}, "summary":{"average":5,"count":1,"distribution":[{"stars":1,"count":0}],"responseRate":100,"responded":1}, "byService":[], "byBranch":[], "ratingTrend":[{"bucket":"2026-09","avgRating":5,"count":1}] }
```

### 2.8 `/working-hours` (§24 hour-of-day/weekday; owner-only) — Models: Agency, Reservation
```json
{ "resolved":{…}, "operatingHours":{"start":"08:00","end":"17:00","workingDays":"1,2,3,4,5"}, "reservationsByHour":[{"hour":0,"count":0}], "servedByHour":[…], "avgWaitByHour":[{"hour":0,"avgWaitMinutes":null}], "weekdayTraffic":[{"weekday":0,"count":6}], "peak":{"busiestHour":8,"busiestWeekday":0,"busiestDay":"2026-09-27"} }
```

### 2.9 `/payments` (§26 own agency; owner-only) — Models: Transaction, SubscriptionPlan, Agency
```json
{ "resolved":{…}, "subscription":{"tier":"FREE","status":"INACTIVE","startsAt":null,"expiresAt":null,"plan":null}, "totals":{"transactionsInPeriod":2,"paid":1,"pending":1,"rejected":0,"totalPaid":5000,"currency":"DZD"}, "byStatus":{"APPROVED":{"count":1,"value":5000},"PENDING":{"count":1,"value":0}}, "byPaymentMethod":{"chargily":1,"ccp":1}, "paymentTimeseries":[{"bucket":"2026-08-28","value":0}] }
```

### 2.10 `/devices` (§27) — Models: AgencyDevice, HardwareOrder
```json
{ "resolved":{…}, "totals":{"devices":1,"online":1,"offline":0,"totalUptimeSec":0}, "byStatus":{"ONLINE":1}, "byType":{"TV":1}, "byConnection":{"LAN":1}, "devices":[{ "id":"…","name":"Waiting TV 54a","type":"TV","status":"ONLINE","branchId":"…","lastHeartbeatAt":"…","offlineCapable":false }], "hardwareOrdersInPeriod":{"count":0,"byStatus":{}} }
```

---

## 3. AGENCY STAFF — `GET /api/staff/analytics/<section>` (4 sections, all live-verified)

Auth: `requireAuth` + ACTIVE `AgencyStaff` row for the caller (owners/admins/customers → **403 FORBIDDEN** — they hold no staff row) + LIVE `canViewAnalytics` check on every request (false → **403 `PERMISSION_DENIED:canViewAnalytics`** — protects against stale JWTs). Default period `30d`. DATA SCOPE: staff row's agency + assigned branch (`AgencyStaff.branchId` → counters of that branch) + assigned counters (`Counter.staffId`); live queue lists are agency-wide and payloads say so via `scope.note` (uncalled tickets carry no branch/counter in the data model). Models: AgencyStaff, Counter, Reservation, Service, QueueSettings, Agency.

### 3.1 `/my-overview` (§31 — TODAY, ignores period)
```json
{ "scope":{"branchId":"…","role":"STAFF","note":"live queue counts are agency-wide (uncalled tickets carry no branch in the data model)"}, "today":{"ticketsServed":0,"reservationsHandled":0,"completed":0,"cancelled":0,"noShow":0,"completionRate":0,"avgWaitingTimeMinutes":null,"avgServiceDurationMinutes":null,"currentlyServing":1,"waitingCount":2,"calledCount":0,"statusDistribution":[…]}, "hourlyTraffic":[{"hour":0,"count":0}] }
```

### 3.2 `/today-queue` (§32, ignores period)
```json
{ "scope":{"branchId":"…","note":"waiting/called lists are agency-wide; served counts respect your branch/counter scope"}, "queueStatus":{"isQueueOpen":true,"isPaused":false,"pausedAt":null,"currentServingNumber":0,"lastIssuedNumber":0}, "live":{"queueLength":2,"currentlyWaiting":2,"currentlyCalled":0,"servingCustomer":{"id":"…","displayNumber":"F5-002","joinedAt":"…"},"nextTicket":{"id":"…","displayNumber":"T5-011","joinedAt":"…"},"calledTickets":[],"avgCurrentWaitMinutes":2190.1}, "today":{"ticketsCompleted":0,"noShows":0} }
```

### 3.3 `/my-performance` (§33, accepts period)
```json
{ "resolved":{…}, "scope":{"branchId":"…","role":"STAFF"}, "kpis":{"ticketsCalled":0,"ticketsServed":0,"completed":0,"cancelled":0,"noShow":0,"completionRate":0,"avgHandlingTimeMinutes":null,"avgServiceDurationMinutes":null,"medianServiceDurationMinutes":null,"avgWaitingTimeMinutes":null,"customersPerHour":null}, "statusDistribution":[…], "timeseries":[…], "byCounter":[{"counterId":"…","name":"Counter 54a-1","served":9,"avgServiceMinutes":8}], "byService":[…], "peak":{"busiestHour":null,"busiestWeekday":null,"busiestDay":null} }
```

### 3.4 `/my-services` (§34, accepts period)
```json
{ "resolved":{…}, "scope":{"branchId":"…"}, "totals":{"services":2,"reservationsInScope":0}, "services":[{ "serviceId":"…","name":"Consultation 54a","prefix":"T5","reservations":0,"completed":0,"cancelled":0,"noShow":0,"avgWaitMinutes":null,"avgServiceMinutes":null,"demand":0 }], "peakHours":[{"hour":0,"count":0}] }
```

---

## 4. CUSTOMER — `GET /api/customer/analytics/<section>` (5 sections, all live-verified)

Auth: `requireAuth` + `role === 'CUSTOMER'` (any other role → **403 FORBIDDEN**; owners/staff/admins have their own modules). EVERY query filters `userId = caller` BEFORE aggregation (§4/§57) — personal data only. Models: Reservation, Favorite, Notification, Review, Agency, Service.

### 4.1 `/my-overview` (§40; default 30d)
```json
{ "resolved":{…}, "totals":{"totalReservations":12,"completed":8,"cancelled":2,"noShow":1,"upcoming":1,"favoriteAgencies":1,"agenciesUsed":1,"servicesUsed":2}, "period":{"reservations":10,"avgWaitingTimeMinutes":6,"avgServiceDurationMinutes":8,"timeseries":[…]} }
```

### 4.2 `/my-reservations` (§41; default 12m)
```json
{ "resolved":{…}, "statusDistribution":[…], "timeseries":[…], "byType":{"online":0,"walkIn":0,"fixedTime":1}, "completedCancelledNoShow":{"completed":6,"cancelled":2,"noShow":1}, "avgWaitingTimeMinutes":6, "avgServiceTimeMinutes":8, "mostUsedAgencies":[{ "agencyId":"…","name":"My Agency","category":"OTHER","key":"…","count":10,"completed":6,"cancelled":2,"noShow":1,"walkIn":0,"online":0,"completionRate":60,"avgWaitMinutes":6,"avgServiceMinutes":8 }], "mostUsedServices":[…] }
```

### 4.3 `/my-queue-history` (§42; default 12m)
```json
{ "resolved":{…}, "totals":{"timesJoinedQueue":10,"completedVisits":6,"noShows":1,"cancelledVisits":2}, "wait":{"averageMinutes":6,"longestMinutes":6,"shortestMinutes":6}, "service":{"averageMinutes":8} }
```

### 4.4 `/my-activity` (§43; default 30d)
```json
{ "resolved":{…}, "favorites":{"count":1,"agencies":[{"agencyId":"…","name":"My Agency","category":"OTHER"}],"newInPeriod":1}, "notifications":{"receivedInPeriod":2,"unread":1,"total":2}, "reviews":{"count":1}, "reservations":{"inPeriod":10} }
```

### 4.5 `/my-ratings` (§44; default 12m)
```json
{ "resolved":{…}, "summary":{"reviewsSubmitted":1,"averageRatingGiven":5,"distribution":[{…}],"agenciesReviewed":1,"servicesReviewed":0}, "history":[{"id":"…","rating":5,"comment":"Great service 54a","createdAt":"…","agencyId":"…","agencyName":"My Agency","serviceId":null}] }
```

---

## 5. LEGACY routes — UNTOUCHED (do not migrate frontends off them in this task)

- `GET /api/admin/analytics/dashboard?period=7d|30d|90d|12m&scope=global|average` — raw legacy payload (NO envelope, NO `resolved`, timeseries key `date`).
- `GET /api/admin/analytics/agency/:agencyId?period=…` — legacy per-agency shape.
- `GET /api/agency/analytics?period=30` — legacy thin route, raw `{services:[…]}` (no envelope).
- `GET /api/agency/analytics/dashboard?period=7d|30d|90d|12m` — legacy owner dashboard (owner+staff), no envelope.
- New sections ADD to the family; the four legacy shapes are byte-identical to pre-54-a behavior.

## 6. Shared engine internals (reference)

- Period math: `resolvePeriodRange()` in `lib/analytics-dashboard.ts` — UTC everywhere; exports `ANALYTICS_PERIODS`, `parseAnalyticsPeriod(raw, fallback)`, `ResolvedPeriodRange { period, start, end, previousStart, previousEnd, granularity, bucketKeys, from, to }`.
- Aggregations: `lib/analytics-engine.ts` — `aggregateReservations(rows, range)` → {kpis, statusDistribution, timeseries, hourlyTraffic, weekdayTraffic, peak}; `groupReservationStats(rows, keyOf)`; `aggregateRatings(rows)`; route helpers `resolvePeriodFromQuery(c, fallback)`, `resolvedWindowPayload(range)`, `windowWhere(range, field)`.
- Semantics (identical to legacy engine): walkIn = `isWalkIn`; online = `!isWalkIn && userId != null`; wait = calledAt−joinedAt; service = completedAt−calledAt; rates 0–100 one decimal; durations minutes one decimal, `null` when no data.

## 7. Live verification record (2026-09-27)

- Battery `bun run tool-results/tmp/verify-54a-full.ts`: **169 requests** — 33 new endpoints × periods {today, 30d, this-month, custom(from/to)} + period edge cases + org filters + permission matrix + legacy regression. **0 × 5xx**; every 200 carries `success:true` + `data` (+ `resolved` where specified).
- Extra periods spot-checked everywhere: yesterday, last-month, last-year, this-quarter, 90d, 12m, 7d — all 200.
- 400s verified: `custom` without from/to → `PERIOD_INVALID: custom requires both from and to`; garbage from/to → 400.
- Permission matrix: every cell of §0.4 verified with real tokens (admin/admin123, owner/owner123, staff54a/staff54a-pass, cust54a/cust54a-pass). Customer token on ALL admin analytics sections → 403 (also owner/staff tokens → 403; anon → 401).
- Org filters verified: status/channel/category+wilaya/agencyId(nonexistent→zeroed, 200).
- Seeded demo data (marker `54a`, "My Agency"): branch + 2 counters + 2 services + reservations across today/10d/20d + reviews + transactions + sms logs/purchases + notifications + favorites + device registrations + 1 agency device + 1 staff user assigned to branch/counter. Frontend agents see REAL numbers. Cleanup: `tool-results/tmp/cleanup-54a.ts`; seed: `tool-results/tmp/seed-54a.ts`.
- Harness notes (NOT api bugs): global rate limit 100 req/min — battery throttles 700 ms/req and auto-waits on 429; staff→`/agency/analytics/overview` 200 by design (same gate as legacy staff-visible dashboard); legacy `/api/agency/analytics` has no envelope by design.
