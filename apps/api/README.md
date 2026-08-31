# @blasti/api — Hono REST API + Socket.IO Realtime Server

> Headless backend server for the BLASTI queue management platform.
> Built with Hono on Bun, featuring Socket.IO for real-time updates.

---

## Quick Start

```bash
# From repo root
DATABASE_URL="file:/path/to/packages/db/data/custom.db" \
NEXTAUTH_SECRET="blast1-dev-s3cr3t-k3y-f0r-d3v3l0pm3nt-0nly" \
CORS_ORIGIN="*" \
INTERNAL_SECRET="blast1-internal-secret-dev" \
bun run dev:api
```

The server starts on **port 3003** by default (configurable via `API_PORT` env var).

---

## Routes & Endpoints

All API routes are mounted under `/api/`. The Hono app registers route modules in `src/index.ts`.

### Auth Routes (`/api/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | Public | Authenticate user, set JWT session cookie |
| `POST` | `/api/auth/register` | Public | Create new account, set session cookie |
| `POST` | `/api/auth/logout` | Public | Clear session cookie |
| `GET` | `/api/auth/logout` | Public | Clear session cookie (browser-navigable) |
| `GET` | `/api/auth/session` | Cookie | Validate session, return user data (NextAuth-compatible) |
| `POST` | `/api/auth/forgot-password` | Public | Request password reset token (in-memory store) |
| `POST` | `/api/auth/reset-password` | Public | Reset password with token |
| `GET` | `/api/auth/check-username` | Public | Check username availability |

### Queue Routes (`/api/queue`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/queue/call-next` | Agency | Call the next waiting customer |
| `PUT` | `/api/queue/pause` | Agency | Pause the queue |
| `PUT` | `/api/queue/resume` | Agency | Resume the queue |
| `PUT` | `/api/queue/settings` | Agency | Update queue settings (avg service time, max reservations, open/close) |
| `GET` | `/api/queue/status` | Public | Get queue status with per-service ETA ranges |

### Reservation Routes (`/api/reservations`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/reservations` | Customer | Create reservation (join queue) |
| `GET` | `/api/reservations` | Auth | List user's reservations |
| `GET` | `/api/reservations/:id` | Owner | Get reservation details |
| `PUT` | `/api/reservations/:id/status` | Agency | Update status (CALLED → SERVING → COMPLETED, NO_SHOW, CANCELLED) |
| `POST` | `/api/reservations/:id/postpone` | Customer | Postpone reservation |
| `POST` | `/api/reservations/:id/reclaim` | Customer | Reclaim position after no-show |
| `POST` | `/api/reservations/:id/rate` | Customer | Rate completed service |

### Agency Routes (`/api/agency`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/agency/activity` | Agency | Recent activity feed |
| `GET` | `/api/agency/dashboard` | Agency | Dashboard stats |
| `GET` | `/api/agency/stats` | Agency | Detailed statistics |
| `GET` | `/api/agency/profile` | Agency | Get agency profile |
| `PUT` | `/api/agency/profile` | Agency | Update profile (name, description, logo, etc.) |
| `PUT` | `/api/agency/settings` | Agency | Update settings (working hours, kiosk mode, auto-pause) |
| `POST` | `/api/agency/services` | Agency | Create service |
| `PUT` | `/api/agency/services/:id` | Agency | Update service |
| `DELETE` | `/api/agency/services/:id` | Agency | Delete service |
| `POST` | `/api/agency/staff` | Agency | Add staff member |
| `PUT` | `/api/agency/staff/:id` | Agency | Update staff permissions |
| `DELETE` | `/api/agency/staff/:id` | Agency | Remove staff |
| `POST` | `/api/agency/branches` | Agency | Create branch |
| `PUT` | `/api/agency/branches/:id` | Agency | Update branch |
| `DELETE` | `/api/agency/branches/:id` | Agency | Delete branch |
| `POST` | `/api/agency/counters` | Agency | Create counter |
| `PUT` | `/api/agency/counters/:id` | Agency | Update counter |
| `DELETE` | `/api/agency/counters/:id` | Agency | Delete counter |
| `POST` | `/api/agency/announcements` | Agency | Create announcement |
| `PUT` | `/api/agency/announcements/:id` | Agency | Update announcement |
| `DELETE` | `/api/agency/announcements/:id` | Agency | Delete announcement |
| `POST` | `/api/agency/reviews` | Customer | Submit review |
| `POST` | `/api/agency/subscription/pay` | Agency | Initiate subscription payment |
| `POST` | `/api/agency/subscription/unsubscribe` | Agency | Cancel subscription |
| `PUT` | `/api/agency/working-hours` | Agency | Update working hours |
| `GET` | `/api/agency/qr` | Agency | Generate agency QR code |

### Agencies Routes (`/api/agencies`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/agencies` | Public | Search/list agencies (with ratings, pagination) |
| `GET` | `/api/agencies/code/:code` | Public | Lookup agency by custom code |
| `GET` | `/api/agencies/:id` | Public | Get agency by ID |
| `POST` | `/api/agencies` | Agency Owner / Admin | Create new agency |
| `PUT` | `/api/agencies/:id` | Agency | Update agency |

### Kiosk Routes (`/api/kiosk`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/kiosk/join` | **Public** | Walk-in customer joins queue (no auth required) |
| `GET` | `/api/kiosk/status` | **Public** | Kiosk display status |
| `GET` | `/api/kiosk/agency` | **Public** | Agency info by code for kiosk |

### Admin Routes (`/api/admin`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/admin/agencies` | Super Admin | Create agency |
| `GET` | `/api/admin/agencies` | Super Admin | List all agencies |
| `PATCH` | `/api/admin/agencies/:id` | Super Admin | Update agency |
| `DELETE` | `/api/admin/agencies/:id` | Super Admin | Delete agency |
| `GET` | `/api/admin/users` | Super Admin | List all users |
| `PATCH` | `/api/admin/users/:id` | Super Admin | Update user (role, status) |
| `DELETE` | `/api/admin/users/:id` | Super Admin | Delete user |
| `GET` | `/api/admin/transactions` | Super Admin | List all transactions |
| `PATCH` | `/api/admin/transactions/:id` | Super Admin | Approve/reject transaction |
| `GET` | `/api/admin/stats` | Super Admin | Platform statistics |
| `GET` | `/api/admin/audit` | Super Admin | Audit logs |
| `GET` | `/api/admin/settings` | Super Admin | Platform settings |
| `PUT` | `/api/admin/settings` | Super Admin | Update settings |
| `GET` | `/api/admin/announcements` | Super Admin | Global announcements |
| `POST` | `/api/admin/announcements` | Super Admin | Create global announcement |
| `DELETE` | `/api/admin/announcements/:id` | Super Admin | Delete global announcement |
| `GET` | `/api/admin/faqs` | Super Admin | List FAQs |
| `POST` | `/api/admin/faqs` | Super Admin | Create FAQ |
| `PUT` | `/api/admin/faqs/:id` | Super Admin | Update FAQ |
| `DELETE` | `/api/admin/faqs/:id` | Super Admin | Delete FAQ |
| `GET` | `/api/admin/payment-settings` | Super Admin | Payment settings |
| `PUT` | `/api/admin/payment-settings` | Super Admin | Update payment settings |
| `GET` | `/api/admin/sms-settings` | Super Admin | SMS gateway settings |
| `PUT` | `/api/admin/sms-settings` | Super Admin | Update SMS settings |
| `POST` | `/api/admin/sms/test` | Super Admin | Send test SMS |
| `GET` | `/api/admin/sms/logs` | Super Admin | SMS logs |
| `POST` | `/api/admin/sms/purchase` | Super Admin | Record SMS purchase |
| `POST` | `/api/admin/subscription-plans` | Super Admin | Create subscription plan |
| `PUT` | `/api/admin/subscription-plans/:id` | Super Admin | Update subscription plan |
| `DELETE` | `/api/admin/subscription-plans/:id` | Super Admin | Delete subscription plan |

### User Routes (`/api/user`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/user/profile` | Auth | Get user profile |
| `PATCH` | `/api/user/profile` | Auth | Update profile (name, language, avatar, preferences) |
| `POST` | `/api/user/change-password` | Auth | Change password |
| `POST` | `/api/user/avatar` | Auth | Upload avatar |

### Notification Routes (`/api/notifications`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/notifications` | Auth | List user's notifications |
| `POST` | `/api/notifications` | Auth | Create notification |
| `PATCH` | `/api/notifications/read` | Auth | Mark notifications as read |
| `PATCH` | `/api/notifications/read-all` | Auth | Mark all as read |
| `DELETE` | `/api/notifications/:id` | Owner | Delete notification |

### Other Routes

| Module | Prefix | Key Endpoints |
|---|---|---|
| Reviews | `/api/reviews` | CRUD for agency reviews, reply to reviews |
| Favorites | `/api/favorites` | Add/remove/list favorite agencies |
| Transactions | `/api/transactions` | Agency transaction history |
| SMS | `/api/sms` | Send SMS, SMS purchase, SMS settings |
| Payment Settings | `/api/payment-settings` | Agency payment configuration |
| Services | `/api/services` | Service CRUD |
| QR | `/api/qr` | QR code generation |
| Upload | `/api/upload` | File upload (avatars, logos, receipts) |
| Devices | `/api/devices` | Device registration for push notifications |
| Cron | `/api/cron` | Scheduled task webhooks (no-show auto-skip) |
| Sync | `/api/sync` | WatermelonDB sync endpoint (Phase 5) |
| Stats | `/api/stats` | Server stats |
| FAQs | `/api/faqs` | Public FAQ listing |

### Internal Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | Public | Health check |
| `GET` | `/stats` | Public | Socket.IO connection stats |
| `POST` | `/emit` | Internal Secret | Emit single Socket.IO event |
| `POST` | `/emit-batch` | Internal Secret | Emit multiple Socket.IO events |

---

## Authentication Middleware

### Token Extraction

The auth middleware extracts JWT tokens from (in order of priority):

1. **Authorization header**: `Bearer <token>` (for native clients)
2. **Session cookie**: `next-auth.session-token` (dev) or `__Secure-next-auth.session-token` (prod)

### Auth Guard Functions

```ts
requireAuth(c)                    // Any authenticated user
requireAdmin(c)                   // SUPER_ADMIN only
requireRole(c, ...roles)          // Specific role(s)
requireAgencyAccess(c, agencyId)  // Agency owner or staff
requireStaffPermission(c, agencyId, permission)  // Granular permission (live DB check)
requireResourceOwnership(c, resourceUserId)       // Own resource or SUPER_ADMIN
```

### Staff Permissions (Phase 2b)

Granular boolean permissions on `AgencyStaff` model:
- `canManageQueue` — Call next, complete, pause/resume
- `canManageServices` — Create/edit/delete services
- `canManageStaff` — Add/remove staff, change permissions
- `canViewAnalytics` — View dashboard stats
- `canManageBranches` — Create/edit/delete branches
- `canManageWorkingHours` — Update working hours
- `canExportData` — Export data to CSV
- `canManageProfile` — Edit agency profile

**Security note:** Staff permissions are checked via live DB lookup (not JWT claims) to prevent stale JWT privilege escalation. SUPER_ADMIN and agency owners bypass all permission checks.

---

## Socket.IO Events

### Client → Server (Room Management)

| Event | Data | Description |
|---|---|---|
| `join:agency` | `agencyId: string` | Join agency room |
| `leave:agency` | `agencyId: string` | Leave agency room |
| `join:customer` | `userId: string` | Join customer room |
| `leave:customer` | `userId: string` | Leave customer room |
| `join:kiosk` | `agencyId: string` | Join kiosk room |
| `leave:kiosk` | `agencyId: string` | Leave kiosk room |
| `join:admin` | — | Join admin room |
| `leave:admin` | — | Leave admin room |

### Server → Client (Event Types)

| Event | Target Room | Data Fields |
|---|---|---|
| `queue:called` | `agency:<id>` | `reservationId`, `displayNumber`, `serviceId`, `counterId`, `counterName` |
| `queue:joined` | `agency:<id>` | `reservationId`, `displayNumber`, `serviceId`, `estimatedWait` |
| `queue:walk-in` | `agency:<id>` | `reservationId`, `displayNumber`, `customerName`, `serviceId` |
| `queue:completed` | `agency:<id>` | `reservationId`, `displayNumber` |
| `queue:no-show` | `agency:<id>` | `reservationId`, `displayNumber` |
| `queue:cancelled` | `agency:<id>` | `reservationId`, `displayNumber` |
| `queue:paused` | `agency:<id>` | `action: 'pause'` |
| `queue:resumed` | `agency:<id>` | `action: 'resume'` |
| `queue:position-changed` | `agency:<id>` | Position and ETA data |
| `queue:settings-updated` | `agency:<id>` | Updated settings fields |
| `reservation:created` | `agency:<id>` + `customer:<id>` | Reservation details |
| `reservation:updated` | `agency:<id>` + `customer:<id>` | Updated fields |
| `reservation:cancelled` | `agency:<id>` + `customer:<id>` | Cancellation data |
| `notification:your-turn` | `customer:<id>` | `ticketNumber`, `agencyName`, `serviceName` |
| `notification:turn-approaching` | `customer:<id>` | Position and ETA data |
| `notification:new` | `customer:<id>` | `notificationId`, `type`, `title` |
| `kiosk:update` | `kiosk:<id>` | `action`, `displayNumber` |
| `agency:updated` | `agency:<id>` | Updated agency data |
| `staff:updated` | `agency:<id>` | Staff change data |
| `admin:stats-updated` | `admin:global` | Platform statistics |
| `device:registered` | `customer:<id>` | Device registration data |

---

## Rate Limiting

### Preset Configurations

| Preset | Window | Max Requests | Prefix | Used By |
|---|---|---|---|---|
| `AUTH_RATE_LIMIT` | 15 min | 5 | `auth` | Registration |
| `LOGIN_RATE_LIMIT` | 15 min | 10 | `login` | Login |
| `REGISTRATION_RATE_LIMIT` | 1 min | 3 | `register` | Registration |
| `PASSWORD_RESET_RATE_LIMIT` | 1 hour | 3 | `pwreset` | Password reset |
| `QUEUE_RATE_LIMIT` | 1 min | 30 | `queue` | Queue operations |
| `RESERVATION_RATE_LIMIT` | 1 min | 10 | `reservation` | Reservation creation |
| `WALK_IN_RATE_LIMIT` | 1 min | 10 | `walkin` | Walk-in creation |
| `KIOSK_RATE_LIMIT` | 5 min | 20 | `kiosk-join` | Kiosk join (public) |
| `KIOSK_READ_RATE_LIMIT` | 1 min | 60 | `kiosk-read` | Kiosk read (public) |
| `AGENCY_LISTING_RATE_LIMIT` | 1 min | 60 | `agencies` | Agency listing |
| `GENERAL_RATE_LIMIT` | 1 min | 100 | `api` | General API |
| `PUBLIC_RATE_LIMIT` | 1 min | 60 | `public` | Public routes |
| `SMS_RATE_LIMIT` | 1 hour | 10 | `sms` | SMS sending |
| `CRON_RATE_LIMIT` | 1 min | 10 | `cron` | Cron webhooks |

### IP Abuse Blocking

- 10 failed requests (4xx from public routes) within 5 minutes → IP blocked for 30 minutes
- Cleanup interval: every 60 seconds
- IP extraction priority: `x-connecting-ip` > Hono conninfo > rightmost `X-Forwarded-For` > `X-Real-IP` > `CF-Connecting-IP` > UA hash

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | SQLite connection string |
| `NEXTAUTH_SECRET` | Yes | — | JWT signing key (HS256) |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origins (comma-separated) |
| `INTERNAL_SECRET` | No | — | Secret for `/emit` and `/emit-batch` endpoints |
| `API_PORT` | No | `3003` | Server port |
| `ALLOWED_ORIGINS` | No | `http://localhost:3000` | Allowed origins for Socket.IO CSWSH protection |
| `REALTIME_SERVICE_URL` | No | `http://localhost:3003` | Override for realtime emit URL |
| `NODE_ENV` | No | — | `production` enables secure cookies |

---

## Source Structure

```
apps/api/src/
├── index.ts              → Server entry point (Hono + Socket.IO setup)
├── routes/
│   ├── auth.ts           → Authentication (login, register, logout, password reset)
│   ├── agency.ts         → Agency management (profile, services, staff, branches, counters)
│   ├── agencies.ts       → Public agency listing and lookup
│   ├── admin.ts          → Admin dashboard, user management, platform settings
│   ├── reservations.ts   → Reservation CRUD and status management
│   ├── queue.ts          → Queue operations (call-next, pause, resume, status)
│   ├── kiosk.ts          → Kiosk endpoints (public, unauthenticated)
│   ├── notifications.ts  → Notification CRUD
│   ├── user.ts           → User profile and preferences
│   ├── reviews.ts        → Review system
│   ├── favorites.ts      → Favorite agencies
│   ├── transactions.ts   → Transaction management
│   ├── sms.ts            → SMS service routes
│   ├── payment-settings.ts → Payment configuration
│   ├── services.ts       → Service management
│   ├── qr.ts             → QR code generation
│   ├── upload.ts         → File upload handling
│   ├── devices.ts        → Device registration for push notifications
│   ├── cron.ts           → Scheduled task webhooks
│   ├── sync.ts           → WatermelonDB sync endpoint
│   ├── stats.ts          → Server statistics
│   └── faqs.ts           → FAQ management
└── lib/
    ├── auth.ts           → JWT auth, session management, permission guards
    ├── rate-limit.ts     → In-memory rate limiter + IP abuse blocking
    ├── realtime-emit.ts  → Socket.IO event emission helpers
    ├── password.ts       → Scrypt password hashing/verification
    ├── validations.ts    → Zod schemas for request body validation
    ├── enums.ts          → String enum constants (roles, statuses, types)
    ├── eta-calculator.ts → ETA calculation with historical data
    ├── queue-scheduler.ts → Queue ordering logic (preferred time, next customer)
    ├── sms-service.ts    → SMS gateway integration
    ├── upload.ts         → File upload/storage abstraction
    ├── audit.ts          → Audit logging helpers
    ├── date-utils.ts     → Date/timezone utilities
    └── device-fingerprint.ts → Device fingerprinting
```
