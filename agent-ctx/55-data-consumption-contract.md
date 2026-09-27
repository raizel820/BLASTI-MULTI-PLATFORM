# Task 55 — Data-Consumption Analytics Contract (SUPER ADMIN ONLY)

Source specs: `docs/chatgpt-doc2-analytics-spec.md` §14 (Data Consumption) + user request
(2026-09-27): totals, per-agency totals, per-agency/per-branch/per-customer averages,
wilaya/category filters, period filter, WIFI/MOBILE/total network filter, and a
**unit selector + price-per-GB cost estimator** for a future sponsored-data contract.

## 0. State already done by the coordinator (55-a) — DO NOT REDO

- `DataUsageEvent` model EXISTS in `packages/db/prisma/schema.prisma` (end of file) and
  `bun run db:push` has been run — the table exists and the RUNNING api has the new client.
- Seed (`packages/db/prisma/seed.ts`) now wipes `dataUsageEvent` and the platform has been
  reset FRESH: only `admin/admin123` (SUPER_ADMIN), `owner/owner123` (AGENCY_OWNER owns
  "My Agency" code MYA, wilaya '28', category 'OTHER', FREE tier) + the plan catalog.
  NO customers, NO branches/services/staff, NO usage events.
- Do NOT run the seed again. Do NOT modify `packages/db/**` (frozen for this task).

## 1. Model (reference)

```prisma
model DataUsageEvent {
  id            String   @id @default(cuid())
  uploadBytes   Int      @default(0)
  downloadBytes Int      @default(0)
  networkType   String   @default("UNKNOWN")  // WIFI | MOBILE | UNKNOWN
  trafficType   String   @default("API")      // API | SYNC | REALTIME | NOTIFICATIONS | FILES | UPDATES
  method        String?
  path          String?
  status        Int?
  userId        String?   // JWT-payload attribution (unverified decode OK — handlers verify)
  agencyId      String?   // JWT agencyId claim (owner/staff) or /api/agencies/:id path match
  deviceId      String?   // x-blasti-device header if present, else null
  createdAt     DateTime @default(now())
  // indexes: createdAt, [agencyId, createdAt], [userId, createdAt], trafficType, networkType
}
```

No FK relations — the ledger is deliberately loose (survives account churn; never cascades).

## 2. BACKEND (Task 55-b) — `apps/api/**`

### 2.1 Recorder — new file `apps/api/src/lib/data-usage.ts`

```ts
export interface DataUsageInput {
  uploadBytes?: number; downloadBytes?: number;
  networkType?: string;            // normalized to WIFI|MOBILE|UNKNOWN
  trafficType?: string;            // validated against the 6-type set, else 'API'
  method?: string; path?: string; status?: number;
  userId?: string | null; agencyId?: string | null; deviceId?: string | null;
}
export function recordDataUsage(input: DataUsageInput): void  // FIRE-AND-FORGET (never await, never throws into the request path)
export function classifyTrafficType(path: string): string
export function normalizeNetworkType(raw: string | undefined | null): 'WIFI' | 'MOBILE' | 'UNKNOWN'
```

Implementation rules:
- In-memory buffer (module-level array) + `setTimeout` flush every 5s OR when buffer ≥ 200
  events → single `db.dataUsageEvent.createMany({ data })`. Flush must `.catch(console.error)`.
- Clamp bytes to `Math.max(0, Math.round(n))` and cap a single event at 2,000,000,000.
- On flush failure: drop the batch (log only) — analytics must never break traffic.
- `classifyTrafficType(path)`: `/api/sync/* | /api/offline-sync/* | /api/files/sync/*` → SYNC;
  `/api/upload/* | /api/files/*` → FILES; `/api/notifications*` → NOTIFICATIONS;
  `/api/app-versions*` → UPDATES; everything else → API.
- `normalizeNetworkType`: case-insensitive; 'wifi'|'lan'|'ethernet' → WIFI;
  'mobile'|'cellular'|'cell'|'data' → MOBILE; anything else (incl. undefined/''/'unknown') → UNKNOWN.

### 2.2 Middleware — in `apps/api/src/index.ts`

Mount ONE middleware for `/api/*` — place it AFTER cors+logger, BEFORE the rate-limit
middleware (so even 429s count as served traffic). There is already a comment line
`// Task 55: data-usage middleware mount point (recorder lives in lib/data-usage.ts)`
exactly where it belongs (above `// ─── Global API Rate Limiting Middleware ───`).

Rules:
- **Skip recording** (next() and return, no event) for: `/api/health`, `/api/dev-tools/*`,
  everything starting `/api/admin/` (admin console traffic is excluded ON PURPOSE so the
  dashboard can never inflate customer/agency consumption — document this in the handler
  comment), and WebSocket upgrade requests.
- `uploadBytes` = `Number(c.req.header('content-length') ?? 0)` (0 when absent; do NOT read bodies).
- `downloadBytes`: prefer `Number(c.res.headers.get('content-length') ?? 0)` after `await next()`.
  When the response has NO content-length and a non-null body (streams), wrap the body with a
  byte-counting `TransformStream` and rebuild `c.res` with it (count chunks; never buffer).
  A null body (204/304) → 0.
- Attribution (cheap, no DB in the hot path unless fallback needed):
  - Decode the JWT payload from the Authorization header WITHOUT verification
    (`jwtDecode`-style: use `jose`'s `decodeJwt` — verification happens in route handlers).
    Take `id` → userId, `agencyId` (empty string → null), `role`.
  - If role is AGENCY_OWNER/AGENCY_STAFF and the token's agencyId is empty: resolve via an
    in-memory Map cache (TTL 60s, max 500 entries): owner → `db.agency.findUnique({ where:
    { ownerId } })`; staff → `db.agencyStaff.findFirst({ where: { userId } })`. Never block
    the response on this — it runs inside the fire-and-forget record call.
  - `agencyId` fallback: if still null and the path matches `^/api/(agencies|agency)/([^/]+)`,
    use that segment (cuid-shaped only: length ≥ 20).
  - `deviceId`: `c.req.header('x-blasti-device')` or null. NOTE: web clients will START
    sending `x-blasti-network` (55-c). Desktop local-api does not send it yet → UNKNOWN.
- Record even for 4xx/5xx and 429 responses (they are real traffic).
- Wrap the whole record call in try/catch — a recorder bug must NEVER affect an API response.

### 2.3 Realtime instrumentation — `apps/api/src/lib/realtime-emit.ts`

Every successful `fetch(...)` POST to the realtime service inside the emit helpers records
ONE event: `recordDataUsage({ trafficType: 'REALTIME', downloadBytes: JSON.stringify(payload).length, agencyId, userId ?? null, path: '/realtime/emit', method: 'POST', status: res?.status })`.
Approximation note (one row per emit, not per connected client) goes in a comment.

### 2.4 Endpoint — `GET /api/admin/analytics/data-consumption`

Add to the existing 54-a admin analytics router (`apps/api/src/routes/admin.ts` — find how
`/analytics/*` sections are mounted; follow the EXACT same style: `requireAdmin`, Zod query
validation, `{ success: true, data }` envelope, `resolved` window key — see the neighboring
section handlers). The route is **super-admin only**; every other role gets 403 via requireAdmin.

Query params (all optional unless noted):
- `period`: today|yesterday|7d|30d|this-week|last-week|this-month|last-month|this-quarter|last-quarter|this-year|last-year|custom — use the SHARED `resolvePeriodRange` from `apps/api/src/lib/analytics-dashboard.ts` (54-a engine; supports all 15 incl. custom). Default `30d`.
- `from`,`to`: REQUIRED together when `period=custom` (ISO date) → 400 otherwise (same convention as 54-a).
- `category`: Agency.category string value (e.g. 'OTHER') → filter events whose agency matches.
- `wilaya`: Agency.wilaya string (e.g. '28').
- `agencyId`: exact agency cuid.
- `network`: ALL|WIFI|MOBILE (default ALL). WIFI → only networkType='WIFI'; MOBILE → only 'MOBILE'; ALL → everything INCLUDING 'UNKNOWN'.
- `trafficType`: ALL|API|SYNC|REALTIME|NOTIFICATIONS|FILES|UPDATES (default ALL).

Response `data` shape (ALL byte counters are raw integer bytes; the frontend does unit math):

```json
{
  "totals": {
    "uploadBytes": 0, "downloadBytes": 0, "totalBytes": 0, "events": 0
  },
  "byNetwork": { "WIFI": 0, "MOBILE": 0, "UNKNOWN": 0 },
  "byTrafficType": { "API": 0, "SYNC": 0, "REALTIME": 0, "NOTIFICATIONS": 0, "FILES": 0, "UPDATES": 0 },
  "averages": {
    "perAgency": 0, "perBranch": 0, "perCustomer": 0, "perDevice": 0,
    "agencyCount": 0, "branchCount": 0, "customerCount": 0, "deviceCount": 0
  },
  "byAgency": [
    { "agencyId": "…", "agencyName": "My Agency", "agencyCode": "MYA", "wilaya": "28",
      "category": "OTHER", "isActive": true,
      "uploadBytes": 0, "downloadBytes": 0, "totalBytes": 0,
      "events": 0, "branchCount": 0,
      "sharePercent": 0.0 }
  ],
  "topCustomers": [
    { "userId": "…", "customerName": "…", "username": "…",
      "totalBytes": 0, "events": 0, "lastActivityAt": "ISO" }
  ],
  "timeseries": [
    { "date": "2026-09-01", "uploadBytes": 0, "downloadBytes": 0, "totalBytes": 0 }
  ],
  "peaks": { "hour": 14, "hourBytes": 0, "day": "2026-09-15", "dayBytes": 0 },
  "resolved": { "period": "…", "from": "ISO", "to": "ISO" },
  "meta": { "recordedSince": "ISO|null", "excludedUnknownNetworkBytes": 0 }
}
```

Semantics (implement EXACTLY):
- Scope rule (doc-2 §4): resolve the period window FIRST, then apply filters, then aggregate.
- `averages.agencyCount` = number of DISTINCT agencies with ≥1 event in the filtered window;
  `perAgency` = totals.totalBytes / agencyCount (0 when count 0). `branchCount` = sum of
  `branches.count({ where: { agencyId in scopeAgencies } })`; `perBranch` = totals/branchCount.
  `customerCount`/`perCustomer` = customers-only bytes (events whose user has role CUSTOMER)
  — join User for role — / distinct customer users. `deviceCount`/`perDevice` = distinct
  non-null deviceId / totals. All averages rounded to whole bytes.
- `byAgency`: ONE grouped query over events (agencyId not null) + ONE `agency.findMany` for
  metadata + branch counts; events with agencyId=null are platform-level and belong in
  totals but NO agency row (that is why ΣbyAgency.totalBytes can be < totals.totalBytes —
  intentional). Sort by totalBytes desc. `sharePercent` = row total / totals.totalBytes*100,
  1 decimal.
- `topCustomers`: top 20 customers by bytes in window (join User for fullName/username).
- `timeseries`: local-day buckets (use the SAME day-bucketing convention as the 54-a
  timeseries helpers in analytics-engine.ts — reuse, don't reinvent).
- `peaks.hour` = hour-of-day 0-23 with max bytes (from createdAt hour in server-local time);
  `peaks.day` = date with max bytes.
- `meta.recordedSince` = MIN(createdAt) over all events (unfiltered) — tells the user when
  recording started. `excludedUnknownNetworkBytes` = bytes with networkType=UNKNOWN (only
  meaningful when network != ALL; when network==ALL it is 0 by definition — still compute
  the UNKNOWN bucket honestly).
- Empty window → zeroed counters, empty arrays (54-a "zeroed counters on empty data" rule).
- Use ONE `Promise.all` for the independent aggregations. Prisma `groupBy` on
  DataUsageEvent (by agencyId / userId / networkType / trafficType / date) + `_sum` +
  `_count`. `Prisma.DbNull` where needed for null filters.

### 2.5 Backend verification (required before you report done)

- `bun run lint` at repo root → exit 0 (or zero NEW issues in your files).
- `cd apps/api && bunx tsc --noEmit` → compare against the documented pre-existing baseline
  (≈121 errors in admin.ts `err.status` family); you must add ZERO new errors.
- LIVE battery with a one-shot script under `apps/api/tool-results/tmp/` (canonical env
  `DATABASE_URL=file:/home/z/my-project/packages/db/data/custom.db` is the fallback — the db
  package resolves it automatically; just `bun run script.ts`):
  1. Generate REAL traffic: login owner (POST /api/auth/login {username,password}) →
     call ~10 owner-facing endpoints (agencies list, reservations, analytics dashboard,
     notifications…). These MUST be recorded (they are not under /api/admin/).
  2. Login admin → GET the new endpoint with: default 30d; period=today; custom with from/to;
     custom missing from → 400; network=WIFI and MOBILE; trafficType=SYNC; wilaya=28;
     category=OTHER; agencyId=<My Agency id>. Assert `success:true`, `resolved` present,
     totals.totalBytes > 0 (proof the middleware records), and byAgency[0].agencyCode === 'MYA'.
  3. Permission: owner token on the endpoint → 403. Customer-less platform: anonymous → 401.
  4. `curl http://localhost:3003/api/health` clean after everything.

### 2.6 Deviations you may note in the worklog (allowed)

- The middleware runs BEFORE auth — attribution decodes the JWT payload WITHOUT verification
  (handlers still verify; a forged userId only pollutes analytics, never authorizes).
- Desktop local-api traffic is recorded as UNKNOWN network until the desktop starts sending
  `x-blasti-network` (future task).
- Admin console traffic is excluded from recording (prevents dashboard self-inflation).

## 3. FRONTEND (Task 55-c) — `apps/web/**`

### 3.1 Section registration (fits the frozen 54-b architecture — read first:
`apps/web/src/components/admin/analytics/section-registry.tsx`, `section-types.ts`,
`use-admin-section-data.ts`, one existing `section-*.tsx` for the house style)

- `section-types.ts`: add `'data-consumption'` to the `AdminSectionId` union.
- `section-registry.tsx`: nav entry `{ id: 'data-consumption', icon: Wifi, labelKey:
  'adminAnalytics.nav.dataConsumption' }` placed AFTER 'devices' (doc-2 §5.1 order),
  component map + title keys entries.
- Fetching via the existing `useAdminSectionData<DataConsumptionPayload>('data-consumption', query)`
  — filters ride the standard `filters` record: `{ category, wilaya, agencyId, network,
  trafficType }` (empty string = not sent). NO new hook.

### 3.2 New component `section-data-consumption.tsx`

Layout (mobile-first, page-level-clean at 375px like the other sections; keep wide tables
inside `overflow-x-auto` containers):

1. **Cost estimator card (THE headline feature)** — prominent, primary accent:
   - Unit selector: segmented buttons `B | KB | MB | GB | TB` (binary 1024 conversions,
     default GB). Pure display conversion — the API always speaks bytes.
   - `Price per GB` numeric input (default empty → cost row shows an instructional hint;
     validate ≥ 0; suffix "DZD / GB").
   - Computed cost = `(totals.totalBytes / 1024^3) × pricePerGB`, formatted with the
     existing DZD formatting helper used by the payments sections; shows "—" when price empty.
   - A second line shows cost per unit-of-time hint: when the active period is a calendar
     month (`this-month`/`last-month`/`30d`) append "(≈ / month)"; otherwise show the
     window (from `resolved`).
   - The estimator reads the FILTERED totals — filters automatically affect it (user requirement).
2. **KPI row**: Total consumed (unit), Upload, Download, Events, + Avg/agency + Avg/branch +
   Avg/customer (all in the selected unit).
3. **Filters row** (same visual language as section-reservations §3.2 filters): period
   selector (shared toolbar handles period — the section renders the EXTRA filters):
   category (text/select of known category values from the payload's agencies), wilaya
   (text input), agency (free text id NOT user-friendly — use a select populated from
   byAgency rows when loaded), network segmented ALL/WIFI/MOBILE, trafficType select
   ALL/API/SYNC/REALTIME/NOTIFICATIONS/FILES/UPDATES. Active-filter count badge + clear-all
   button (same pattern as reservations).
4. **Network split card**: three labeled progress bars WIFI / MOBILE / UNKNOWN with unit values.
5. **Traffic-type split card**: 6 bars or a simple list with values.
6. **Per-agency table**: Agency · Code · Wilaya · Category · Upload · Download · Total (unit)
   · Share % · Est. cost (uses the price input). Sorted desc; `max-h-96 overflow-y-auto`
   custom-scrollbar per repo rules. Empty state text when no rows.
7. **Top customers table**: Customer · Username · Total (unit) · Events · Last activity.
8. **Consumption timeseries**: reuse the chart pattern from an existing section
   (section-reservations/queues timeseries component style; same ResponsiveContainer rules).
9. **Peaks card**: peak hour (0-23 formatted "14:00–15:00") + peak day with values.
10. **Meta line**: `recordedSince` shown as "Recording since …" when present.

All i18n keys under `adminAnalytics.dataConsumption.*` + nav key
`adminAnalytics.nav.dataConsumption` + title key `adminAnalytics.dataConsumption.title` —
EN / AR / FR parity (see the existing `adminAnalytics.*` namespaces in
`apps/web/src/i18n/{en,ar,fr}.ts`; Arabic must be real Arabic, e.g. استهلاك البيانات,
unit names stay Latin: KB/MB/GB/TB).

### 3.3 Web client network header — `apps/web/src/lib/api-client.ts`

Add header `x-blasti-network` to outgoing API requests: derive once (module-level cached):
`navigator.connection?.type` → 'wifi'|'ethernet' → WIFI; 'cellular' → MOBILE; otherwise
`effectiveType` 'slow-2g'|'2g'|'3g' → MOBILE; else UNKNOWN (header still sent with UNKNOWN
or omitted when the API cannot be determined — your call, document it). Guard everything
(`typeof navigator !== 'undefined'`) for SSR. Keep the change minimal — one helper + one
header insertion point in the request pipeline.

### 3.4 Frontend verification (required before you report done)

- `bun run lint` exit 0.
- `bunx tsc --noEmit` in apps/web → zero NEW errors vs the documented baseline (~307, none
  in analytics files).
- Do NOT start servers. The web dev server on :3000 is supervised; if it is down, the
  coordinator will resurrect it (do not attempt spawns).

## 4. Worklog (BOTH tasks)

Append to `/home/z/my-project/worklog.md` (read it first; append, never overwrite):
`---` / `Task ID: 55-b` (or `55-c`) / Agent / Task / Work Log / Stage Summary.
