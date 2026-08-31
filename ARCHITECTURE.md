# BLASTI Architecture Overview

> **BLASTI (بلاصتي)** — Smart queue management platform for Algerian institutions.
> Multi-platform monorepo: Web, Desktop (Electron), Mobile (Capacitor), and API.

---

## Monorepo Structure

```
blasti-multiplatform/
├── apps/
│   ├── web/          → Next.js 16 web application (port 3000)
│   ├── api/          → Hono API + Socket.IO realtime server (port 3003)
│   ├── desktop/      → Electron shell wrapping the web app
│   └── mobile/       → Capacitor native mobile shell (Android/iOS)
├── packages/
│   └── db/           → Shared Prisma/SQLite database package
│       └── data/custom.db  → SQLite database file
├── package.json      → Root workspace config (bun workspaces)
└── Caddyfile         → Reverse proxy config (Caddy on port 81)
```

### Workspace Layout

| Package | Purpose | Port | Runtime |
|---|---|---|---|
| `apps/web` | Next.js 16 SSR web app | 3000 | Node.js |
| `apps/api` | Hono REST API + Socket.IO | 3003 | Bun |
| `apps/desktop` | Electron native shell | — | Electron |
| `apps/mobile` | Capacitor native shell | — | Android/iOS |
| `packages/db` | Shared Prisma client + schema | — | Shared |

---

## Tech Stack

| Layer | Technology | Details |
|---|---|---|
| **Web Frontend** | Next.js 16, React 19, TypeScript | App Router, Tailwind CSS 4, Framer Motion |
| **UI Components** | shadcn/ui, Radix UI, Lucide icons | Component library with theme support |
| **API Server** | Hono (Bun runtime) | Lightweight, edge-compatible HTTP framework |
| **Realtime** | Socket.IO | WebSocket + polling fallback, room-based |
| **Database** | Prisma ORM + SQLite | Single-file DB at `packages/db/data/custom.db` |
| **Desktop** | Electron 33+ | Remote web shell, system tray, deep links |
| **Mobile** | Capacitor 6 | WebView wrapping Next.js export, native plugins |
| **Auth** | Custom JWT (HS256 via jose) | NextAuth-compatible session cookies |
| **State** | Zustand (persist middleware) | Client-side state with localStorage persistence |
| **Device Management** | Custom (heartbeat + LAN discovery) | Kiosk/TV registration, command pipeline, LAN scanning |
| **i18n** | Custom (ar/fr/en) | Arabic (RTL), French, English |
| **Build** | Bun workspaces | Monorepo with `bun run --filter` |

---

## Web App Proxy Architecture

The Next.js web app does **not** call the Hono API directly from the browser in development. Instead, it proxies all `/api/*` and `/socket.io/*` requests through Next.js rewrites:

```ts
// apps/web/next.config.ts
async rewrites() {
  return [
    { source: "/api/:path*", destination: `http://localhost:3003/api/:path*` },
    { source: "/socket.io/:path*", destination: `http://localhost:3003/socket.io/:path*` },
  ];
}
```

**Benefits:**
- Same-origin cookies are sent automatically (no CORS issues)
- Socket.IO WebSocket upgrade goes through the same origin
- In production, a reverse proxy (Caddy/Nginx) performs the same role

**For native apps** (Electron/Capacitor), the API client uses `NEXT_PUBLIC_API_URL` as the base URL and sends the JWT as a `Bearer` token in the `Authorization` header instead of relying on cookies.

---

## Authentication Flow

### Overview

BLASTI uses a custom JWT authentication system that is **compatible with NextAuth session cookies**, allowing the frontend to work seamlessly with both the old NextAuth and the new Hono API.

### JWT Details

| Property | Value |
|---|---|
| Algorithm | HS256 (enforced, prevents algorithm confusion attacks) |
| Secret | `NEXTAUTH_SECRET` env var |
| Expiry | 30 days |
| Cookie | `next-auth.session-token` (dev) / `__Secure-next-auth.session-token` (prod) |
| Native Auth | `Authorization: Bearer <token>` header |

### Token Lifecycle

1. **Login** (`POST /api/auth/login`): Validate credentials → create signed JWT → set httpOnly cookie
2. **Session Check** (`GET /api/auth/session`): Verify JWT from cookie/header → return user data
3. **API Requests**: JWT extracted from cookie (web) or Authorization header (native) → verified via `jose.jwtVerify()`
4. **Logout** (`POST /api/auth/logout`): Clear session cookie + clear Zustand store

### Stale JWT Prevention (Phase 2b)

- User model has `lastRoleChangeAt` timestamp
- JWT contains `iat` (issued-at) claim
- On verification, if `iat < lastRoleChangeAt`, the token is rejected — forcing re-authentication
- This prevents privilege escalation from stale JWTs after role changes

### Auth Middleware Hierarchy

```
requireAuth()        → Any authenticated user
requireAdmin()       → SUPER_ADMIN only
requireRole(...)     → Specific role(s)
requireAgencyAccess(c, agencyId) → Agency owner or staff
requireStaffPermission(c, agencyId, permission) → Granular staff permission (live DB check)
requireResourceOwnership(c, resourceUserId) → Own resource or SUPER_ADMIN
```

---

## Device Management System

BLASTI supports connecting physical devices (kiosk tablets, TV displays) to agencies for queue management. Devices auto-register, maintain heartbeat connections, and receive commands from the server.

### Device Types

| Type | Purpose | Component |
|---|---|---|
| **KIOSK** | Self-service ticket printer at agency entrance | `device-kiosk.tsx` |
| **TV** | Real-time queue display board on TV/wall monitor | `device-tv-board.tsx` |

### Device Registration Flow

1. Device opens URL: `/?mode=device&type=KIOSK|TV&agencyId={id}`
2. `quickDiscover()` scans LAN for the API server (192.168.x.1-254 on port 3003)
3. Device calls `POST /api/agency-devices/public/register` to create an `AgencyDevice` record
4. Server returns a JWT token; device stores it in localStorage
5. Device is now registered and appears in the agency's device manager

### Heartbeat System

- Devices send `POST /device/heartbeat` every 30 seconds
- Server marks device ONLINE, returns any `pendingCommands`
- Device processes commands (REBOOT → reload, REFRESH → reload, CONFIG_UPDATE → re-fetch config)
- Device acknowledges each command via `POST /device/command/:id/ack`
- Devices with no heartbeat for 90 seconds are marked OFFLINE automatically

### LAN Discovery

Client-side network scanning (`lan-discovery.ts`) for finding the BLASTI server on local network:

1. Check localhost first
2. Scan common LAN subnets (192.168.x.x, 10.0.x.x) for `/api/discover` endpoint
3. Try mDNS: `http://blasti.local:{port}/api/discover`
4. Cache discovered server for subsequent requests
5. Fallback to cloud server if nothing found locally

### Device Commands

The server can queue commands for devices:

| Command | Action |
|---|---|
| `REBOOT` | Full page reload |
| `REFRESH` | Soft refresh |
| `CONFIG_UPDATE` | Re-fetch display configuration |

Commands are sent via heartbeat response and acknowledged by the device.

### Realtime Events

Device events are broadcast via Socket.IO to `agency:{agencyId}` rooms:

| Event | Trigger |
|---|---|
| `device:registered` | New device registers |
| `device:online` | Device heartbeat received |
| `device:status-changed` | Device status changes |

### Casting / Screen Projection

The device manager provides 5 methods to display the TV screen:

1. **New Tab** — Opens TV display in browser tab (auto-fullscreen on load)
2. **Chromecast** — Uses Presentation API to cast to Chromecast/DLNA devices
3. **HDMI** — Desktop app (Electron) opens fullscreen window on second monitor
4. **Copy URL** — Copies TV URL to clipboard for manual input
5. **QR Code** — Generates scannable QR code for instant phone/tablet access

### TV Board Features

- Auto-fullscreen when opened via `?mode=device&type=TV`
- Fullscreen toggle button + keyboard shortcut (F key)
- Real-time queue display via Socket.IO
- Configurable: font size, theme (dark/light), language, rotation
- Auto-discovery of LAN server on load
- Own heartbeat registration as TV device

---

## Real-Time Architecture

### Socket.IO Server

The Hono API server runs a Socket.IO server alongside the REST API on port 3003.

**Configuration:**
- `pingInterval`: 25 seconds
- `pingTimeout`: 20 seconds
- CORS: Configured via `CORS_ORIGIN` env var
- Transport: WebSocket first, polling fallback

### Room Structure

| Room Pattern | Purpose | Who Joins |
|---|---|---|
| `agency:<agencyId>` | Agency-wide queue updates | Agency owners, staff |
| `customer:<userId>` | Personal notifications | Authenticated customers |
| `kiosk:<agencyId>` | Kiosk display updates | Kiosk display terminals |
| `admin:global` | Admin dashboard updates | Super admins |

### Event Types

| Event | Room | Trigger |
|---|---|---|
| `queue:called` | agency | Next ticket called |
| `queue:joined` | agency | Customer joins queue |
| `queue:walk-in` | agency | Walk-in customer via kiosk |
| `queue:completed` | agency | Service completed |
| `queue:no-show` | agency | Ticket skipped |
| `queue:cancelled` | agency | Reservation cancelled |
| `queue:paused` | agency | Queue paused |
| `queue:resumed` | agency | Queue resumed |
| `queue:position-changed` | agency | Position update |
| `queue:settings-updated` | agency | Queue config changed |
| `reservation:created` | agency + customer | New reservation |
| `reservation:updated` | agency + customer | Reservation changed |
| `reservation:cancelled` | agency + customer | Reservation cancelled |
| `notification:your-turn` | customer | Turn called |
| `notification:turn-approaching` | customer | N positions ahead |
| `notification:new` | customer | General notification |
| `kiosk:update` | kiosk | Kiosk display refresh |
| `agency:updated` | agency | Agency profile changed |
| `staff:updated` | agency | Staff changes |
| `admin:stats-updated` | admin:global | Admin stats refresh |
| `device:registered` | customer | Device token registered |
| `notification:routed` | customer | Notification routed through smart router |
| `device:heartbeat` | agency | Device heartbeat received |
| `device:status-changed` | agency | Device online/offline change |

### Server-to-Server Emit

API routes emit events by making internal HTTP POST requests to the `/emit` and `/emit-batch` endpoints on the same server. These endpoints require the `x-internal-secret` header (set via `INTERNAL_SECRET` env var).

```ts
// From any API route:
emitQueueEvent('queue:called', agencyId, { displayNumber, serviceId })
emitNotificationEvent('notification:your-turn', userId, { ticketNumber })
emitBatch([...events]) // Multiple events at once
```

---

## Smart Notification Routing Architecture

### Overview

The notification router is a cost-saving routing layer that treats paid SMS/WhatsApp as a premium last resort, using real-time WebSockets and Push Notifications first.

**Source:** `apps/api/src/lib/notification-router.ts`

### Channel Priority Cascade

| Priority | Channel | Transport | Cost | Condition |
|---|---|---|---|---|
| 1 | WebSocket | Socket.IO | 0 DZD | `user.isAppOnline === true` |
| 2 | FCM Push | Firebase Cloud Messaging | 0 DZD | `user.fcmToken` exists |
| 3 | SMS/WhatsApp | Carrier gateway | Paid | Last resort |

### NotificationType Enum

```ts
type NotificationType =
  | 'TURN_CALL'       // Customer's turn is now — immediate dispatch
  | 'ADVANCE_WARNING' // Turn approaching — delayed via 25% buffer
  | 'TURN_COMPLETED'  // Service completed
  | 'QUEUE_UPDATE'    // Position/ETA change
```

### NotificationPref Enum

```ts
enum NotificationPref {
  SMS       // Carrier SMS only
  WHATSAPP  // WhatsApp only
  BOTH      // SMS + WhatsApp (TURN_CALL sends both)
  APP_ONLY  // In-app only, skip carrier entirely
}
```

### routeNotification() Function

```ts
async function routeNotification(
  io: SocketIOServer,
  payload: NotificationPayload
): Promise<RouteResult>
```

**Routing logic:**

1. If `user.isAppOnline` → emit to `customer:${userId}` room via Socket.IO (free)
2. If `user.fcmToken` exists → send FCM push (free, currently stub)
3. If `notificationPref === APP_ONLY` → create in-app `Notification` record, skip carrier
4. If SMS notifications disabled → in-app only
5. Check carrier balance → skip if insufficient
6. For `ADVANCE_WARNING` → schedule `DelayedJob` with 25% buffer
7. For `TURN_CALL` → immediate carrier dispatch (bypass delay engine)
8. For other types → carrier dispatch based on `notificationPref`

### 25% Mathematical Buffer Rule (ADVANCE_WARNING)

ADVANCE_WARNING alerts are not sent immediately. Instead, they are delayed by 25% of the remaining wait time:

```ts
executeAt = Date.now() + (remainingMinutes × 0.25 × 60 × 1000)
```

This creates a `DelayedJob` record with `status: PENDING`. The background worker picks it up when `executeAt <= now()`.

**Why 25%?** If a customer has 20 minutes remaining, the alert fires at the 15-minute mark (5 min early). This avoids wasting carrier credits on customers who will see the update in-app before the delayed job fires.

### TURN_CALL: Immediate Dispatch

`TURN_CALL` bypasses the delay engine entirely. If the user is offline and carrier channels are available, the notification dispatches immediately through the carrier gateway — no `DelayedJob` is created.

### Balance Deduction Logic

| Condition | Deduction Source | Mechanism |
|---|---|---|
| `agency.sponsorSms === true` | `agency.smsBalance` | Atomic `updateMany` with `gte: 1` guard |
| `agency.sponsorSms === false` | `user.freeSmsCount` | `sendSms()` with `userId` handles deduction internally |
| Agency exhausted mid-flight | Falls back to `user.freeSmsCount` | Prevents double-deduction with `sms-service.ts` |
| Both exhausted | Check purchased SMS credits | `SmsPurchase` aggregate vs `SmsLog` count |

### cancelPendingCustomerAlerts() Utility

**Source:** `apps/api/src/lib/cancel-pending-alerts.ts`

Cancels carrier alerts when the customer opens the app or views their queue tracking dashboard:

```ts
// Cancel alerts for a specific reservation
cancelPendingCustomerAlerts(userId: string, reservationId: string): Promise<number>

// Cancel alerts for all active reservations of a user
// (called on socket handshake)
cancelAllPendingAlertsForUser(userId: string): Promise<number>
```

**Trigger points:**
- Socket handshake (`connection` event) → `cancelAllPendingAlertsForUser()`
- Customer views queue tracking → `cancelPendingCustomerAlerts()` for that reservation

### Routing Decision Tree

```
routeNotification(payload)
│
├── user.isAppOnline?
│   └── YES → WebSocket → DONE (0 DZD)
│
├── user.fcmToken?
│   └── YES → FCM Push → DONE (0 DZD)
│
├── pref === APP_ONLY || smsDisabled?
│   └── YES → In-app Notification → DONE (0 DZD)
│
├── hasBalance === false?
│   └── YES → In-app Notification → DONE (0 DZD)
│
├── type === ADVANCE_WARNING?
│   └── YES → Schedule DelayedJob (25% buffer) → DONE
│
├── type === TURN_CALL?
│   └── YES → Immediate carrier dispatch → DONE (paid)
│
└── type === TURN_COMPLETED | QUEUE_UPDATE?
    └── Carrier dispatch by pref → DONE (paid)
```

---

## Background Notification Worker

**Source:** `apps/api/src/workers/notification-worker.ts`

A 30-second polling loop that processes `DelayedJob` records whose `executeAt` time has arrived.

### Configuration

| Parameter | Value |
|---|---|
| Poll interval | 30 seconds (`POLL_INTERVAL_MS = 30_000`) |
| Batch size | 50 jobs per cycle (`take: 50`) |
| Auto-start | Yes — `startNotificationWorker()` called in `apps/api/src/index.ts` on server boot |

### Public API

```ts
startNotificationWorker(): void  // Start polling (idempotent)
stopNotificationWorker(): void   // Stop polling
```

### Per-Job Processing Logic

```
For each DelayedJob where executeAt <= now() AND status === PENDING:
│
├── 1. Parse payload (phone, message, agencyId, userId, channel)
│
├── 2. Look up agency (sponsorSms, smsBalance)
│   │   └── Agency not found? → CANCELLED
│
├── 3. Check user.isAppOnline
│   │   └── Online? → CANCELLED (free channels already delivered it)
│
├── 4. Resolve channel from notificationPref
│   │   └── APP_ONLY? → CANCELLED
│
├── 5. Check balance
│   │   ├── agency.sponsorSms? → agency.smsBalance > 0
│   │   └── else → user.freeSmsCount > 0
│   │   └── No balance? → CANCELLED
│
├── 6. Send notification
│   │   ├── WHATSAPP → fallback to SMS (TODO: WhatsApp Business API)
│   │   ├── SMS → sendSms(phone, message, userId?)
│   │   └── BOTH → SMS first, WhatsApp for TURN_CALL only
│   └── 7. Update status
    ├── Success? → SENT + deduct balance
    └── Failure? → CANCELLED
```

### WhatsApp Fallback

WhatsApp sends are not yet implemented. When `effectiveChannel === 'WHATSAPP'`, the worker falls back to SMS:

```ts
// TODO: integrate WhatsApp Business API when available
console.log('[notification-worker] WhatsApp not yet available — falling back to SMS')
```

---

## Database Models

### DelayedJob

Stores scheduled carrier notifications (primarily `ADVANCE_WARNING` alerts) for deferred processing by the background worker.

| Field | Type | Description |
|---|---|---|
| `id` | `String` (@id, cuid) | Primary key |
| `reservationId` | `String` | Associated reservation |
| `userId` | `String` | Target user (FK → User) |
| `jobType` | `String` | NotificationType value (e.g. `"ADVANCE_WARNING"`) |
| `payload` | `String` | JSON: `{ phone, message, agencyId, userId, channel? }` |
| `executeAt` | `DateTime` | When the worker should dispatch this job |
| `status` | `JobStatus` | `PENDING` / `SENT` / `CANCELLED` |
| `createdAt` | `DateTime` | Record creation time |

**Relationships:**
- `User` 1:N `DelayedJob` (cascade delete)

**Indexes:**
- `@@index([status, executeAt])` — worker query optimization
- `@@index([userId, reservationId])` — cancellation lookups

**JobStatus enum:**

```prisma
enum JobStatus {
  PENDING     // Awaiting executeAt time
  SENT        // Successfully dispatched
  CANCELLED   // Cancelled (user online, no balance, etc.)
}
```

---

## Queue Management Flow

### Customer Journey

```
1. Browse Agencies (GET /api/agencies)
2. View Agency Details (GET /api/agencies/:id or /api/agencies/code/:code)
3. Join Queue (POST /api/reservations) → Creates WAITING reservation
4. Real-time updates via Socket.IO (position changes, ETA updates)
5. Notification: "Your turn is approaching" (when close to front)
6. Notification: "It's your turn!" (when called)
7. Service Completed → Rating prompt
8. Submit Review (POST /api/reviews)
```

### Agency Staff Journey

```
1. Login → Agency Dashboard
2. Call Next Ticket (POST /api/queue/call-next)
   - Uses queueNumber-based sorting (not join time)
   - Optimistic concurrency: updateMany with status='WAITING' check
   - SQLite BUSY retry with exponential backoff
3. Complete Service (PUT /api/reservations/:id/status → COMPLETED)
4. Pause/Resume Queue (PUT /api/queue/pause | /resume)
5. Manage Services, Staff, Branches, Counters
```

### Kiosk Walk-In Flow

```
1. Kiosk loads with agency code (GET /api/kiosk/agency?code=XXX)
2. Customer selects service
3. Join via kiosk (POST /api/kiosk/join) — No auth required
4. Ticket printed/displayed with displayNumber (e.g., "A-001")
5. Kiosk display shows "Now Serving" via Socket.IO
```

### Queue Number System

- Each service has a `prefix` (e.g., "A", "B")
- Display numbers: `{prefix}-{3-digit number}` (e.g., "A-001", "B-012")
- Queue numbers are monotonically increasing per service
- Postponed tickets retain their original queueNumber (fixes "Postpone Paradox")

### ETA Calculation

- Based on historical service time (last 7 days, up to 200 completed reservations)
- Adjusted per-service counter count (multi-desk support)
- Ghost ticket filtering: WAITING > 2 hours treated as no-shows
- Fixed-time appointment filtering: Only 30-minute immediate window counted
- Returns confidence range: min/max minutes with confidence level

---

## Agency Device Management Architecture

### Overview

Manages physical devices (TVs, kiosks, displays, printers) connected to agency networks. Devices are paired via short codes, report health via heartbeats, and can be auto-discovered on the LAN.

**Source:** `apps/api/src/routes/agency-devices.ts`
**Frontend:** `apps/web/src/components/agency/agency-devices.tsx`

### AgencyDevice Model

| Field | Type | Description |
|---|---|---|
| `type` | `String` | `TV` / `KIOSK` / `DISPLAY` / `PRINTER` |
| `connectionType` | `String` | `LAN` / `WIFI` / `CABLE` / `MANUAL` |
| `status` | `String` | `ONLINE` / `OFFLINE` / `PAIRING` / `DISABLED` |
| `pairingCode` | `String?` (@unique) | 4-hex-char code (e.g. `"A3B7"`) |
| `deviceFingerprint` | `String?` | Hardware/software fingerprint for verification |
| `autoDiscovery` | `Boolean` | Whether the device responds to LAN scans |
| `screenLayout` | `String` | `QUEUE_BOARD` / `TICKET_PRINTER` / `SERVICE_SELECTOR` / `CUSTOM` |
| `displaySettings` | `String` (JSON) | Font size, theme, language, showAds, rotationSec, etc. |
| `lastHeartbeatAt` | `DateTime?` | Last heartbeat timestamp |
| `connectedAt` | `DateTime?` | When device was paired/connected |
| `branchId` | `String?` | Assigned branch (null = main) |
| `serviceFilter` | `String` | Comma-separated service IDs (empty = all) |

**Relationships:**
- `Agency` 1:N `AgencyDevice` (cascade delete)
- `Branch` 1:N `AgencyDevice` (set null on delete)

**Indexes:** `agencyId`, `status`, `pairingCode`

### Pairing Flow

1. Agency owner creates device → `POST /api/agency-devices` → generates `pairingCode` (4 hex chars, unique, up to 10 retry attempts)
2. Device status set to `OFFLINE` initially
3. Re-pair: `POST /api/agency-devices/:id/pair` → new pairing code, status → `PAIRING`
4. Connect: `POST /api/agency-devices/:id/connect` → status → `ONLINE`, sets `connectedAt` + `lastHeartbeatAt`
5. Disconnect: `POST /api/agency-devices/:id/disconnect` → status → `OFFLINE`

### Auto-Discovery

`POST /api/agency-devices/scan` — Simulates LAN scanning (mDNS/SSDP placeholder). Currently returns agency devices with `autoDiscovery: true`. Production implementation will use actual network discovery protocols.

### Heartbeat Endpoint

`POST /api/agency-devices/:id/heartbeat` — Device reports liveness:

```json
{
  "deviceFingerprint": "...",
  "appVersion": "1.2.3"
}
```

Server updates `status → ONLINE`, `lastHeartbeatAt → now()`, and optionally `deviceFingerprint` / `appVersion`.

### API Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agency-devices` | List devices (filter by `?status=` / `?type=`) |
| `POST` | `/api/agency-devices` | Create device |
| `GET` | `/api/agency-devices/:id` | Get single device (with branch info) |
| `PATCH` | `/api/agency-devices/:id` | Update device |
| `DELETE` | `/api/agency-devices/:id` | Delete device |
| `POST` | `/api/agency-devices/:id/pair` | Generate new pairing code |
| `POST` | `/api/agency-devices/:id/connect` | Mark device as connected |
| `POST` | `/api/agency-devices/:id/disconnect` | Mark device as disconnected |
| `POST` | `/api/agency-devices/:id/heartbeat` | Device heartbeat |
| `POST` | `/api/agency-devices/scan` | LAN scan for auto-discoverable devices |

---

## Enterprise Contract Configurator

### Overview

Admin-facing component for creating custom enterprise and government institution contracts with real-time cost calculation.

**Source:** `apps/web/src/components/admin/EnterprisePlanConfigurator.tsx`
**Admin Route:** `/admin/custom-plans`

### Pricing Model

| Component | Cost |
|---|---|
| Base monthly license | 28,000 DZD/month (includes 3 branches, 6 counters) |
| Extra branch | 3,500 DZD/month per branch |
| Extra counter | 1,500 DZD/month per counter |

### Hardware Payment Models

| Model | Description | Upfront Cost |
|---|---|---|
| **Pure HaaS** | Zero upfront capital, higher monthly lease | 0 DZD |
| **Hybrid** | Upfront hardware purchase + low monthly maintenance | 100,000 DZD + 40,000 DZD/extra counter |

### Lease Commitment Tiers

| Tier | HaaS Monthly/Counter | Hybrid Monthly/Counter |
|---|---|---|
| 1-Year | 10,000 DZD | 4,000 DZD |
| 2-Year | 4,500 DZD | 2,000 DZD |
| 3-Year | 3,000 DZD | 1,200 DZD |
| 4-Year | 2,400 DZD | 1,000 DZD |

### Real-Time Cost Calculation

```ts
function calculateTotalPlanCosts() {
  basePrice = 28000 + (extraBranches * 3500) + (extraReceptions * 1500)
  totalMonthlyHardwareLease = receptions * hardwareMonthlyAddition
  totalRecurring = basePrice + totalMonthlyHardwareLease
}
```

The component renders a live **Contract Cost Sheet** card showing upfront capital, monthly software license, monthly HaaS lease, and total recurring invoice — all updating in real-time as sliders move.

---

## Key Design Patterns

### 1. Monorepo with Shared Database Package
All apps import `{ db }` from `@blasti/db`, which provides a singleton Prisma client with:
- **Ghost Delete Trap**: Prisma extension that creates `DeletedRecord` tombstones for offline sync
- **SQLite PRAGMA setup**: `busy_timeout = 5000ms` for concurrent write handling
- **Global caching**: Prevents duplicate PrismaClient instances on hot-reload

### 2. Cross-Platform API Client
`ApiClient` class auto-detects runtime environment:
- **Web**: Relative URLs, cookie-based auth
- **Electron/Capacitor**: Absolute URLs, Bearer token auth
- **SSR**: Internal URL for server-side calls

### 3. Zustand State with Hash-Based Navigation
The app uses Zustand + localStorage persistence with a hash-based view router:
- Views: `landing`, `login`, `register`, `customer-*`, `agency-*`, `admin-*`, `kiosk`
- Hash URLs: `#/customer/queue`, `#/agency/settings`, etc.
- Deep links: `?code=XXX` → auto-join agency, `?mode=kiosk` → kiosk mode

### 4. Optimistic Concurrency Control
- Queue call-next uses `updateMany` with `status: 'WAITING'` check (prevents double-call)
- SQLite BUSY/DEADLOCK retry with exponential backoff (50ms, 150ms, 450ms)
- Transaction model uses `version` field for optimistic concurrency on payment approval

### 5. Rate Limiting + IP Abuse Blocking
- In-memory sliding window rate limiter
- Per-route configurable limits (auth, login, queue, kiosk, SMS, etc.)
- IP abuse detection: 10 failed requests in 5 min → 30-min block
- Null IP trap: Rejects requests with unidentifiable client IPs

### 6. Multi-Tenant Agency Isolation
- `requireAgencyAccess()` verifies user owns/belongs to the agency
- `ensureAgencyIdOwnership()` provides defense-in-depth against cross-tenant access
- Staff permissions are checked live from DB (not from JWT) to prevent stale privilege escalation

### 7. Provider-Neutral File Storage
- Models use `storageProvider` + `storageKey` pattern (replaces legacy URL fields)
- Supports: blob, R2, local storage providers
- Legacy `avatarUrl`/`logoUrl` fields maintained for backward compatibility

### 8. Platform-Adaptive UI
- **Customer**: Bottom navigation (mobile) / Header tabs (Electron)
- **Agency/Admin**: Collapsible sidebar (desktop) / Hamburger menu (mobile)
- **Kiosk**: Full-screen, no chrome
- Platform-specific components: `PlatformFrame`, `CustomerNavigation`, `AdaptiveAgencySidebar`

### 9. Device Heartbeat & Command Pipeline
- Devices send periodic heartbeats (30s interval) with status
- Server responds with queued commands (REBOOT, REFRESH, CONFIG_UPDATE)
- Device acknowledges commands individually via POST
- Missing heartbeats (>90s) trigger automatic OFFLINE status
- Realtime events notify agency dashboard of device state changes

### 10. LAN Discovery for Offline/Closed Networks
- Client-side HTTP subnet scanning (no server dependency)
- `quickDiscover()` checks localhost, common subnets, and mDNS
- Discovered server info cached in memory
- API discover endpoint (`GET /api/discover`) returns server metadata
- Desktop app broadcasts UDP beacon for faster discovery by web clients

---

## Environment Variables

| Variable | Used By | Purpose |
|---|---|---|
| `DATABASE_URL` | All | SQLite connection string |
| `NEXTAUTH_SECRET` | API, Web | JWT signing key |
| `NEXTAUTH_URL` | Web | Base URL for NextAuth |
| `CORS_ORIGIN` | API | Allowed CORS origins |
| `INTERNAL_SECRET` | API | Service-to-service auth for /emit endpoints |
| `API_PORT` | API, Web | API server port (default: 3003) |
| `NEXT_PUBLIC_API_URL` | Web (native) | Absolute API URL for Electron/Capacitor |
| `REALTIME_SERVICE_URL` | API | Override realtime emit URL |
| `ALLOWED_ORIGINS` | API | CSWSH protection for Socket.IO |
| `CAPACITOR_SERVER_URL` | Mobile | Dev server URL for live reload |
| `FCM_PROJECT_ID` | API | Firebase project ID for push notifications |
| `FCM_PRIVATE_KEY` | API | Firebase Admin SDK private key |
| `FCM_CLIENT_EMAIL` | API | Firebase Admin SDK client email |
| `WHATSAPP_API_TOKEN` | API | WhatsApp Business API bearer token |
| `WHATSAPP_PHONE_NUMBER_ID` | API | WhatsApp Business phone number ID |

---

## Development Commands

```bash
# Start both API + Web (dev mode) — uses concurrently for color-coded output
# Works on all platforms: Windows, Mac, Linux
bun run dev

# Start API only
bun run dev:api

# Start Web only
bun run dev:web

# Database operations
bun run db:push      # Push schema changes
bun run db:generate  # Generate Prisma client
bun run db:migrate   # Run migrations
bun run db:seed      # Seed test data
bun run db:reset     # Reset database

# Desktop
bun run electron:dev     # Run Electron dev
bun run electron:build   # Build Electron app

# Mobile
bun run cap:sync   # Sync web build to native projects
```
