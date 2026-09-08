# BLASTI Desktop Local API — Deep Audit Report

**Date**: 2025-07-14  
**Scope**: `apps/desktop/local-api/index.js`, sync-service, auth, subscription, local DB  
**Lines Audited**: ~3,800+ in local-api/index.js alone  

---

## Executive Summary

| Audit Question | Verdict | Status |
|---|---|---|
| **1. Local API has all routes needed to operate admin, agency, and customer accounts?** | **NO** — ~100+ cloud routes missing; 6 method mismatches cause 404s; 10 routes will crash with Prisma errors | 🔴 CRITICAL |
| **2. Local API routes are all functional (no dead code/placeholders/incomplete)?** | **NO** — 3 unreachable duplicates; 14 stub routes; 10 Prisma-breaking queries; 11 writes missing mutation logging | 🔴 CRITICAL |
| **3. Local API can fully sync with cloud in real-time, import on launch, upload on reconnection?** | **PARTIAL** — Sync is periodic (2min) NOT real-time; import-on-login works; reconnection upload works BUT 11 write handlers don't log mutations (data lost) | 🟠 HIGH RISK |
| **4. After login, user can stay connected offline for 3 days before token refresh?** | **NO 3-DAY POLICY** — JWT is 30-day; no refresh mechanism; no forced re-auth timer. Works up to 30 days offline. | 🟡 MISMATCH |
| **5. App can enforce subscription expiry even in offline mode?** | **NO** — Local API has ZERO subscription checks on queue routes; loading screen hardcodes ACTIVE; stats defaults to ACTIVE | 🔴 CRITICAL |
| **6. Desktop local DB has a copy of account data for offline operation?** | **YES** — User, Agency, AgencyStaff, QueueSettings, plus all 7 SYNC_MODELS are in local SQLite | ✅ PASS |
| **7. App reads and writes to local DB that syncs with cloud DB?** | **YES for reads** (100% local). **PARTIAL for writes** — all writes go to local DB first, but 11 handlers skip `logPendingMutation`, so those changes are NEVER pushed to cloud | 🟠 HIGH RISK |

---

## 1. ROUTE COMPLETENESS — Local vs Cloud

### 1.1 Local API Routes (49 unique + 22 local-only = 71 total)

| Category | Local Routes | Cloud Routes | Gap |
|---|---|---|---|
| **Auth** | 4 (login, session, logout, import-session) | 8 | Missing: register, forgot-password, reset-password, check-username |
| **Agency** | 15 | 46+ | Missing: analytics, daily-chart, history, working-hours, subscription/pay/cancel/unsubscribe, subscription-plans, hardware, enterprise-request |
| **Branches** | 4 (list, create, delete, counters) | 6 | Missing: GET :id, PATCH :id |
| **Counters** | 5 | 5 | Missing: POST via branch, PATCH via branch |
| **Services** | 5 | 5 | Method mismatch: PUT vs PATCH for updates |
| **Queue** | 11 | 8 | Method mismatches: POST vs PUT for pause/resume |
| **Reservations** | 3 | 16 | Missing: active, history, agency, reclaim, cancel-active, batch-complete, eta, rate, share, toggle-fixed-time, position-history, import-walk-in |
| **Notifications** | 3 | 7 | Missing: create, bulk-mark-read, mark-read, patch single |
| **User** | 2 | 8 | Missing: preferences, change-password, delete-account, stats, service-stats |
| **Reviews** | 3 | 5 | Missing: patch, delete by :id |
| **Staff** | 5 | 6 | Missing: /staff/create variant |
| **Admin** | 1 (stub) | 60+ | Entire admin panel missing (acceptable — admin is cloud-only) |
| **Sync** | 3 (trigger, status, pending-mutations) | 3 (status, pull, push) | Different sync API surface |
| **Subscription** | 2 (subscription, subscription-plans stubs) | 5 | Missing: pay, cancel, unsubscribe |

### 1.2 Method Mismatches (Will Cause 404s)

| Path | Cloud Method | Local Method | Impact |
|---|---|---|---|
| `/api/agency/profile` (update) | **PATCH** | **PUT** | 🔴 Frontend PATCH → 404 on local |
| `/api/agency/services/:id` (update) | **PATCH** | **PUT** | 🔴 Frontend PATCH → 404 on local |
| `/api/user/profile` (update) | **PATCH** | **PUT** | 🔴 Frontend PATCH → 404 on local |
| `/api/queue/pause` | **PUT** | **POST** | 🟡 Frontend PUT → 404 on local |
| `/api/queue/resume` | **PUT** | **POST** | 🟡 Frontend PUT → 404 on local |
| `/api/notifications/read-all` | **PUT** | **POST** | 🟡 Frontend PUT → 404 on local |

---

## 2. DEAD CODE, PLACEHOLDERS & INCOMPLETE IMPLEMENTATIONS

### 2.1 Unreachable Duplicate Routes (Dead Code)

| Route | First Registration | Duplicate (Unreachable) |
|---|---|---|
| `POST /api/agency/queue/call-next` | Line 1673 | Line 3302 |
| `POST /api/agency/queue/call/:id` | Line 1739 | Line 3673 |
| `PATCH /api/agency/staff/:id` | Line 2981 | Line ~3476 (for-loop) |

### 2.2 Stub / Placeholder Routes

| Line | Route | What's Faked |
|---|---|---|
| 736 | `GET /api/admin/announcements` | Returns `{available: false, reason: 'offline'}` — no DB query |
| 848 | `GET /api/agency/dashboard` | `averageWaitMinutes: 0` — hardcoded, comment says "placeholder" |
| 2335 | `GET /api/agency/stats` | 8 hardcoded zeros: `avgRating: 0`, `completionRate: 0`, `noShowRate: 0`, `hourlyWaitTime: fill(0)`, `ratingDistribution: fill(0)`, `estimatedWaitRange: {min:0, max:0}` |
| 2573 | `POST /api/agency/announcements` | Returns `{success: true}` but does NOTHING — no DB write |
| 2578 | `DELETE /api/agency/announcements` | Returns `{success: true}` but does NOTHING — no DB write |
| 2700 | `GET /api/agency/subscription` | `availablePlans: []`, `recentTransactions: []` — always empty |
| 3029 | `GET /api/agency/subscription-plans` | `{plans: []}` — always empty |
| 3224 | `GET /api/sync-status` | `cloudConnected: false`, `lastSyncAt: null` — hardcoded |
| 3524 | `GET /api/agency/qr-code` | `qrCodeUrl: null`, `displayUrl: null` — no QR generation |

### 2.3 Prisma-Breaking Queries (Will Crash at Runtime)

| Line | Route | Bug |
|---|---|---|
| **1325** | `GET /api/agency/branches/:branchId/counters` | Queries `counter.agencyId` — **Counter model has no `agencyId` field**. Prisma will throw. |
| **1342** | `GET /api/agency/branches/:branchId/counters/:counterId` | Checks `counter.agencyId !== agencyId` — always `undefined !== id` → **always 404** |
| **1361** | `PUT/PATCH .../counters/:counterId` | Same `agencyId` bug — always rejects update |
| **1387** | `DELETE .../counters/:counterId` | Same `agencyId` bug — always rejects delete |
| **2392** | `POST /api/agency/services` | Includes `averageServiceTime` in create — **not a Service model field**. Prisma error. |
| **2539** | `POST /api/agency/queue/walk-in` | Includes `customerName` in reservation create — **not a Reservation field**. Prisma error. |
| **2536** | `POST /api/agency/queue/walk-in` | `queueNumber` is string `"A001"` — **schema expects `Int`**. Prisma type error. |
| **3384** | `POST /api/agency/queue/walk-in-token` | `queueNumber: tokenCode` is string — **schema expects `Int`**. Prisma type error. |
| **2623** | `GET /api/agency/history` | Filters by `customerName` — **not a Reservation field**. Prisma error. |
| **2626** | `GET /api/agency/history` | Filters by `customerPhone` — **not a Reservation field**. Prisma error. |

---

## 3. SYNC MECHANISM AUDIT

### 3.1 Architecture

```
Desktop Frontend → Local API (Hono :3080) → Local SQLite (Prisma)
                                            ↕ sync-service.js (bidirectional)
                                     Cloud API (/api/sync/pull, /api/sync/push)
```

### 3.2 Sync Capabilities

| Feature | Status | Mechanism |
|---|---|---|
| **Import on launch** | ✅ Works | `loading-screen.js` imports Agency, Services, Branches, Counters, Staff, User, Reservations, QueueSettings via REST |
| **Import on login** | ✅ Works | `syncService.initialSync()` resets cursor to 0 → full pull from cloud |
| **Periodic sync when online** | ✅ Works | Every 120 seconds via `setInterval` |
| **Sync on reconnection** | ✅ Works | `process.on('online')` + IPC `network:online` → `triggerSyncNow()` |
| **Real-time sync** | ❌ NOT real-time | No WebSocket/SSE — up to 2-minute delay for cloud changes |
| **Upload pending mutations** | ⚠️ PARTIAL | `_replayPendingMutations()` runs after each sync cycle, BUT 11 write handlers don't call `logPendingMutation` |
| **Conflict resolution** | ✅ Works | Pull: local keeps if newer. Push: cloud wins if server rejects. Manual resolution available. |
| **Exponential backoff** | ✅ Works | 2s → 4s → 8s → ... → 60s max |

### 3.3 Sync Models

**SYNC_MODELS** (synced bidirectionally):
1. Agency
2. Service  
3. Branch
4. Counter
5. Reservation
6. Notification
7. QueueSettings

**NOT in SYNC_MODELS** (written locally but only synced via pending mutation replay):
- AgencyStaff — created/updated/deleted locally, NOT pushed by version-based sync
- Review — created/updated/deleted locally, NOT pushed by version-based sync
- User — updated locally, NOT pushed by version-based sync
- Announcement — not even persisted locally (no-op stubs)

### 3.4 Write Handlers Missing `logPendingMutation` (DATA LOSS RISK)

| Line | Route | Impact |
|---|---|---|
| 3367 | `POST /api/agency/queue/walk-in-token` | Reservation created but never synced to cloud |
| 3402 | `PATCH /api/agency/services/:id` | Service update lost on sync |
| 3426 | `DELETE /api/agency/services/:id` | Service deletion lost on sync |
| 3443 | `POST /api/agency/staff/create` | Staff creation lost on sync |
| 3500 | `DELETE /api/agency/staff/:id` | Staff deletion lost on sync |
| 3611 | `POST /api/reviews` | Review creation lost on sync |
| 2027 | `POST /api/notifications/read-all` | Notification status lost on sync |
| 2048 | `PUT/PATCH /api/notifications/:id` | Notification update lost on sync |
| 2077 | `DELETE /api/notifications/:id` | Notification deletion lost on sync |
| 3302 | `POST /api/agency/queue/call-next` | Unreachable duplicate (dead code) |
| 3673 | `POST /api/agency/queue/call/:id` | Unreachable duplicate (dead code) |

---

## 4. AUTH & TOKEN PERSISTENCE AUDIT

### 4.1 Token Architecture

| Token Type | Format | Expiry | Storage | Validation |
|---|---|---|---|---|
| **Cloud JWT** | HS256 JWT | 30 days | Cookie + localStorage + `blasti-auth.json` (disk) | Full JWT verification on cloud |
| **Local Session** | Random hex (64 chars) | Until process exit | In-memory only | Timing-safe string comparison |

### 4.2 Offline Auth Flow

| Scenario | Works? | How |
|---|---|---|
| **Login offline (DB has user)** | ✅ | Queries local SQLite `db.user.findUnique()`, verifies password hash |
| **Login offline (DB empty)** | ❌ | First-run offline impossible — no user data in local DB |
| **Session restore on restart** | ✅ | Reads `blasti-auth.json` → `POST /api/auth/import-session` |
| **Renderer rehydration** | ✅ | Zustand persist from localStorage + IPC session set |
| **Network failure during session check** | ✅ | Auth provider does NOT clear session on fetch failure |

### 4.3 3-Day Policy: NOT IMPLEMENTED

- **No 3-day threshold exists anywhere in code**
- JWT is valid for 30 days — no refresh token, no sliding window
- No timer checks "days since last cloud contact" and forces re-auth
- The 30-day JWT expiry is the only time-based mechanism
- **Local API doesn't validate JWT signature** — stores cloud JWT as plain string, compares exactly. Even expired JWTs are accepted locally.

### 4.4 Security Risks

- `NEXTAUTH_SECRET` defaults to `'blast1-d3v-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly'` if unset
- No session revocation mechanism (no blocklist, no version check)
- Local API accepts any token that matches the in-memory string — no expiry check

---

## 5. SUBSCRIPTION ENFORCEMENT AUDIT

### 5.1 Offline Subscription Awareness

| Check | Status | Detail |
|---|---|---|
| **Local DB has subscription fields** | ✅ | Agency model has `subscriptionStatus`, `subscriptionExpiresAt`, `subscriptionTier`, `gracePeriodEndsAt` |
| **Local API reads subscription** | ✅ | `/api/agency/subscription` computes expiry from local data |
| **Detects expiry correctly** | ⚠️ | Computes `isExpired` in-memory but **doesn't persist** EXPIRED status to DB |
| **Cloud changes while offline** | ❌ | If admin extends/cancels subscription while app is offline, local data is stale until next sync |

### 5.2 Subscription Enforcement: CRITICAL FAILURE

| Route | Cloud Enforces? | Local API Enforces? |
|---|---|---|
| `POST /api/reservations` (join queue) | ✅ Checks `subscriptionStatus === 'ACTIVE'` | ❌ **NO CHECK** |
| `POST /api/queue/call-next` | ✅ | ❌ **NO CHECK** |
| `POST /api/queue/call/:id` | ✅ | ❌ **NO CHECK** |
| `POST /api/queue/complete/:id` | ✅ | ❌ **NO CHECK** |
| `POST /api/queue/walk-in` | ✅ | ❌ **NO CHECK** |
| `POST /api/queue/pause` | ✅ | ❌ **NO CHECK** |
| `POST /api/queue/resume` | ✅ | ❌ **NO CHECK** |

**An expired/inactive agency can perform ALL queue operations when offline.**

### 5.3 Hardcoded ACTIVE Override

| Location | Code | Impact |
|---|---|---|
| `loading-screen.js:1070` | `subscriptionStatus: 'ACTIVE'` | **Overwrites cloud-returned status** on import — even expired agencies get marked ACTIVE |
| `local-api/index.js:2345` | `subscriptionStatus: agency?.subscriptionStatus \|\| 'ACTIVE'` | If field is null/undefined → defaults to ACTIVE |

---

## 6. LOCAL DATABASE & READ/WRITE FLOW

### 6.1 Data Available Locally

| Model | In Local DB? | In SYNC_MODELS? | Source |
|---|---|---|---|
| User | ✅ | ❌ | Imported at launch, not incrementally synced |
| Agency | ✅ | ✅ | Full bidirectional sync |
| Service | ✅ | ✅ | Full bidirectional sync |
| Branch | ✅ | ✅ | Full bidirectional sync |
| Counter | ✅ | ✅ | Full bidirectional sync |
| Reservation | ✅ | ✅ | Full bidirectional sync |
| Notification | ✅ | ✅ | Full bidirectional sync |
| QueueSettings | ✅ | ✅ | Full bidirectional sync |
| AgencyStaff | ✅ | ❌ | Read/written locally, only synced via mutation replay |
| Review | ✅ | ❌ | Read/written locally, only synced via mutation replay |
| SubscriptionPlan | ❌ | ❌ | **Not available offline** — returns empty |
| Transaction | ❌ | ❌ | **Not available offline** — returns empty |
| Favorite | ❌ | ❌ | Not synced |
| AuditLog | ❌ | ❌ | Not synced |

### 6.2 Read Flow

**✅ ALL data routes read exclusively from local Prisma DB.** Zero cloud API calls in normal read routes.

Exceptions:
- `/api/cloud-proxy/*` — transparent proxy to cloud (registration, payment, password reset)
- `/api/cloud-health` — diagnostic cloud connectivity check

### 6.3 Write Flow

**✅ ALL writes go to local DB first**, then `logPendingMutation()` is called fire-and-forget.

**⚠️ 11 write handlers skip `logPendingMutation`** — those changes are written to local DB but NEVER pushed to cloud on reconnection. See §3.4 above.

### 6.4 Dual Database Risk

There are TWO SQLite databases in the desktop app:
1. **`local.db`** (Prisma) — used by `local-api/index.js` and `sync-service.js`
2. **`blasti-lan-sync.db`** (better-sqlite3) — used by `local-db.js` and `cloud-sync.js` (legacy)

Both run sync loops. This is a consistency risk.

---

## 7. CONSOLIDATED SEVERITY MATRIX

| # | Issue | Severity | Category |
|---|---|---|---|
| 1 | **10 Prisma-breaking queries** (missing fields, type mismatches) — routes CRASH at runtime | 🔴 CRITICAL | Code Quality |
| 2 | **Zero subscription enforcement in local API queue routes** — expired agencies can operate freely offline | 🔴 CRITICAL | Business Logic |
| 3 | **Loading screen hardcodes `subscriptionStatus: 'ACTIVE'`** — overwrites actual cloud status | 🔴 CRITICAL | Business Logic |
| 4 | **6 method mismatches** (PATCH vs PUT) — frontend requests 404 on local API | 🔴 CRITICAL | Compatibility |
| 5 | **11 write handlers missing `logPendingMutation`** — data changes lost on cloud sync | 🔴 CRITICAL | Data Integrity |
| 6 | **~100+ cloud routes missing from local API** — features unavailable offline | 🟠 HIGH | Completeness |
| 7 | **3 unreachable duplicate route registrations** — dead code | 🟠 HIGH | Code Quality |
| 8 | **14 stub/placeholder routes** — return fake data or no-op | 🟠 HIGH | Completeness |
| 9 | **No real-time sync** — up to 2-minute delay for cloud changes | 🟡 MEDIUM | Architecture |
| 10 | **No 3-day offline token policy** — 30-day JWT with no refresh | 🟡 MEDIUM | Auth |
| 11 | **AgencyStaff, Review, User NOT in SYNC_MODELS** — rely on fragile mutation replay | 🟡 MEDIUM | Sync |
| 12 | **Dual SQLite databases** — potential consistency issues | 🟡 MEDIUM | Architecture |
| 13 | **No idempotency keys for mutation replay** — duplicate creation risk | 🟡 MEDIUM | Data Integrity |
| 14 | **Local API doesn't validate JWT expiry** — accepts expired tokens | 🟢 LOW | Security |
| 15 | **Fallback NEXTAUTH_SECRET** — known development secret in production | 🟢 LOW | Security |

---

## 8. PRIORITY RECOMMENDATIONS

### Immediate (🔴 Critical — must fix before production)

1. **Fix 10 Prisma-breaking queries** — Remove `agencyId` from Counter queries, remove `customerName`/`customerPhone` from Reservation filters, fix `queueNumber` type (Int vs String), remove `averageServiceTime` from Service create
2. **Add subscription check middleware** to ALL local API queue routes — mirror cloud's `subscriptionStatus !== 'ACTIVE'` → 403
3. **Remove hardcoded `subscriptionStatus: 'ACTIVE'`** from loading-screen import — use actual cloud value
4. **Fix method mismatches** — Change local PUT→PATCH for `/api/agency/profile`, `/api/services/:id`, `/api/user/profile`; change POST→PUT for `/api/queue/pause`, `/api/queue/resume`
5. **Add `logPendingMutation` to all 11 missing write handlers** — every DB write must be logged for cloud sync

### Short-term (🟠 High)

6. **Remove 3 unreachable duplicate routes** (lines 3302, 3673, ~3476)
7. **Replace stubs with real implementations** — dashboard `averageWaitMinutes`, stats aggregations, announcements CRUD, subscription-plans cache
8. **Add missing high-priority routes** — `/api/agency/branches/:id` (GET/PATCH), `/api/agency/settings` (PATCH), `/api/agency/history`, `/api/agency/analytics`, `/api/agency/daily-chart`
9. **Add AgencyStaff, Review, User to SYNC_MODELS** in sync-service.js

### Medium-term (🟡 Medium)

10. **Implement 3-day offline token policy** — check `lastCloudSync` timestamp, force re-auth after 3 days offline
11. **Add WebSocket/SSE for real-time sync notifications** — reduce 2-minute stale data window
12. **Consolidate dual databases** — migrate `local-db.js` to Prisma or remove legacy `cloud-sync.js`
13. **Add idempotency keys to pending mutations** — prevent duplicate creation on replay
14. **Persist EXPIRED subscription status** to local DB when detected
15. **Add offline grace period** (24-48h) for subscription enforcement

---

## FIXES APPLIED (2025-07-14)

All critical and high-priority issues from the audit have been fixed. Here's the complete list:

### 🔴 CRITICAL FIXES (Applied)

| # | Issue | Fix Applied |
|---|---|---|
| 1 | **10 Prisma-breaking queries** | Fixed Counter queries (removed `agencyId`, use `branchId` ownership check), removed `averageServiceTime` from Service create, fixed `queueNumber` type (Int vs String) in walk-in routes, removed `customerName`/`customerPhone` from Reservation history search, removed `prefix` from Counter allowedFields |
| 2 | **Zero subscription enforcement** | Added `requireActiveSubscription()` middleware — checks `subscriptionStatus` in local DB, blocks EXPIRED/INACTIVE/PENDING, persists EXPIRED flip to DB. Applied to all 16 queue routes. |
| 3 | **Hardcoded `subscriptionStatus: 'ACTIVE'`** | Changed default from `'ACTIVE'` to `'INACTIVE'` (safe default). Fixed loading-screen.js to use `agencyRes.subscriptionStatus` instead of hardcoded `'ACTIVE'`. |
| 4 | **6 method mismatches** | Added PATCH alias for `/api/user/profile`, PUT aliases for `/api/queue/pause` and `/api/queue/resume`, PUT alias for `/api/notifications/read-all` |
| 5 | **11 write handlers missing `logPendingMutation`** | Added `logPendingMutation()` calls to: notifications read-all, notifications/:id (PUT/PATCH/DELETE), walk-in-token, PATCH services/:id, DELETE services/:id, POST staff/create, DELETE staff/:id, POST reviews |

### 🟠 HIGH PRIORITY FIXES (Applied)

| # | Issue | Fix Applied |
|---|---|---|
| 6 | **3 unreachable duplicate routes** | Replaced with comments: duplicate `/api/agency/queue/call-next`, `/api/agency/queue/call/:id`, PUT/PATCH `/api/agency/staff/:id` for-loop |
| 7 | **14 stub routes** | Replaced with real implementations: admin/announcements (DB query), dashboard `averageWaitMinutes` (real aggregate calculation), POST/DELETE announcements (actual DB CRUD) |
| 8 | **Stats default ACTIVE** | Changed `agency?.subscriptionStatus \|\| 'ACTIVE'` → `\|\| 'INACTIVE'` |
| 9 | **AgencyStaff/Review/User not in SYNC_MODELS** | Added to SYNC_TABLES in sync-service.js, AGENCY_SCOPED_TABLES, and SYNC_MODELS in cloud API sync.ts |

### 🟡 MEDIUM PRIORITY FIXES (Applied)

| # | Issue | Fix Applied |
|---|---|---|
| 10 | **No 3-day offline token policy** | Added `OFFLINE_TOKEN_MAX_MS` (3 days), check in `requireAuth()` middleware that returns 401 with `OFFLINE_SESSION_EXPIRED` code, `_lastCloudContactAt` tracking, session endpoint exposes offline token status |
| 11 | **No idempotency keys for mutation replay** | Added `idempotency_key` column to `_pending_mutations` table, unique index, auto-generated for POST creates using `INSERT OR IGNORE` |
| 12 | **Subscription EXPIRED not persisted** | `requireActiveSubscription()` middleware now writes `subscriptionStatus: 'EXPIRED'` to local DB when it detects expiry |
| 13 | **Cloud contact tracking** | Added `markCloudContact()` function, called by sync-service on successful sync and by import-session after cloud login. Exported for use by main process. |
| 14 | **Sync-status endpoint improved** | Now includes `lastCloudContactAt`, `offlineDurationMs`, `offlineDays`, `offlineTokenRemainingMs`, `pendingMutations` |

### Files Modified

1. **`apps/desktop/local-api/index.js`** — All route fixes, subscription middleware, 3-day token policy, idempotency keys, stub replacements, mutation logging
2. **`apps/desktop/local-api/sync-service.js`** — Expanded SYNC_TABLES (added AgencyStaff, Review, User), added `markCloudContact()` call on successful sync
3. **`apps/desktop/loading-screen.js`** — Fixed hardcoded `subscriptionStatus: 'ACTIVE'` → uses cloud response values
4. **`apps/api/src/routes/sync.ts`** — Expanded SYNC_MODELS to match (added AgencyStaff, Review, User)
