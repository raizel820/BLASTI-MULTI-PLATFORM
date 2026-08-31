# @blasti/db — Shared Prisma Database Package

> Single source of truth for database access across the BLASTI monorepo.
> Uses Prisma ORM with SQLite, plus a Ghost Delete Trap for offline sync.

---

## Quick Start

```bash
# Generate Prisma client
bun run db:generate

# Push schema changes (dev)
bun run db:push

# Run migrations (production)
bun run db:migrate

# Seed test data
bun run db:seed

# Open Prisma Studio
bun run db:studio
```

---

## Database

- **Provider:** SQLite
- **Location:** `packages/db/data/custom.db`
- **Connection string:** `DATABASE_URL="file:/path/to/packages/db/data/custom.db"`

---

## Prisma Client Singleton

Import the shared Prisma client from this package:

```ts
import { db, Prisma } from '@blasti/db';

// Use like any Prisma client
const user = await db.user.findUnique({ where: { id: '...' } });
```

**Features:**
- Global caching in development (prevents duplicate PrismaClient on hot-reload)
- Ghost Delete Trap (Prisma Client Extension)
- SQLite PRAGMA setup (`busy_timeout = 5000ms`)

### Ghost Delete Trap

A Prisma Client Extension intercepts every `delete()` and `deleteMany()` call and creates a `DeletedRecord` tombstone. This ensures offline WatermelonDB clients receive the delete row instead of a "ghost" that appears to still exist.

- **Skip mechanism:** Set `SKIP_GHOST_DELETE=1` to bypass during seed/migration
- **Recursion guard:** `DeletedRecord` model is excluded from tombstone creation
- **Non-blocking:** Tombstone creation failure never blocks the actual delete

### SQLite PRAGMA Setup

```ts
import { setupSQLitePragmas } from '@blasti/db';

// Call once at server startup
await setupSQLitePragmas(); // Sets busy_timeout = 5000ms
```

---

## Models & Relationships

### Entity Relationship Diagram (Simplified)

```
User ───┬─── ownedAgencies ───→ Agency
        ├─── staffAgencies ───→ AgencyStaff ───→ Agency
        ├─── reservations ───→ Reservation
        ├─── notifications ───→ Notification
        ├─── favorites ───→ Favorite
        ├─── reviews ───→ Review
        ├─── smsPurchases ───→ SmsPurchase
        ├─── auditLogs ───→ AuditLog
        └─── devices ───→ DeviceRegistration

Agency ─┬─── owner ───→ User
        ├─── staff ───→ AgencyStaff
        ├─── services ───→ Service ───→ Reservation
        ├─── branches ───→ Branch ───→ Counter
        ├─── queueSettings ───→ QueueSettings
        ├─── reservations ───→ Reservation
        ├─── transactions ───→ Transaction
        ├─── announcements ───→ Announcement
        ├─── favorites ───→ Favorite
        ├─── reviews ───→ Review
        └─── subscriptionPlan ───→ SubscriptionPlan ───→ PlanFeature

Reservation ─┬─── user ───→ User
             ├─── agency ───→ Agency
             ├─── service ───→ Service
             ├─── counter ───→ Counter
             └─── review ───→ Review
```

---

## All Models

### User

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | Primary key |
| `username` | String | — | Unique |
| `fullName` | String | — | — |
| `email` | String? | — | Unique |
| `phoneNumber` | String? | — | Unique |
| `passwordHash` | String | — | scrypt hash |
| `role` | String | `"CUSTOMER"` | See UserRole enum |
| `language` | String | `"ar"` | ar/fr/en |
| `avatarUrl` | String? | — | Legacy URL |
| `avatarStorageProvider` | String? | — | 'blob', 'r2', 'local' |
| `avatarStorageKey` | String? | — | Provider-neutral key |
| `freeSmsCount` | Int | `10` | Free SMS credits |
| `notificationPreferences` | String | JSON | Queue event preferences |
| `reminderMinutes` | Int | `10` | Reminder timing |
| `smsNotificationsEnabled` | Boolean | `true` | — |
| `isActive` | Boolean | `true` | Account status |
| `lastRoleChangeAt` | DateTime | now() | Stale JWT detection |
| `createdAt` | DateTime | now() | — |
| `updatedAt` | DateTime | auto | — |

### Agency

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | Primary key |
| `name` | String | — | — |
| `nameFr` / `nameAr` | String? | — | i18n names |
| `customCode` | String | — | Unique agency code |
| `category` | String | — | See AgencyCategory enum |
| `address` | String? | — | — |
| `city` | String | `"M'Sila"` | — |
| `wilaya` | String | `"28"` | Algerian wilaya code |
| `phone` / `email` / `website` | String? | — | Contact info |
| `logoUrl` / `coverUrl` | String? | — | Legacy URLs |
| `logoStorageProvider/Key` | String? | — | Provider-neutral storage |
| `coverStorageProvider/Key` | String? | — | Provider-neutral storage |
| `description` / `descriptionFr` / `descriptionAr` | String? | — | — |
| `averageServiceTime` | Int | `10` | Minutes |
| `maxActiveReservations` | Int | `50` | — |
| `autoPauseWhenFull` | Boolean | `false` | — |
| `isSponsored` | Boolean | `false` | Featured listing |
| `subscriptionPlanId` | String? | — | FK → SubscriptionPlan |
| `subscriptionTier` | String | `"BASIC"` | See SubscriptionTier enum |
| `subscriptionStatus` | String | `"INACTIVE"` | See SubscriptionStatus enum |
| `workingHoursStart` / `workingHoursEnd` | String | `"08:00"` / `"17:00"` | — |
| `isQueueOpen` | Boolean | `true` | — |
| `isActive` | Boolean | `true` | — |
| `kioskModeEnabled` | Boolean | `false` | — |
| `gracePeriodEndsAt` | DateTime? | — | Downgrade grace period |
| `ownerId` | String | — | FK → User |

### SubscriptionPlan (Phase 2: Dynamic Plans)

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `name` | String | — | Unique plan identifier |
| `displayName` / `displayNameAr` / `displayNameFr` | String | — | — |
| `description` / `descriptionAr` / `descriptionFr` | String? | — | — |
| `price` | Int | `0` | In DZD (Algerian Dinar) |
| `currency` | String | `"DZD"` | — |
| `billingCycle` | String | `"MONTHLY"` | MONTHLY/YEARLY/ONE_TIME |
| `maxServices` | Int | `5` | — |
| `maxBranches` | Int | `1` | — |
| `maxStaff` | Int | `3` | — |
| `maxActiveReservations` | Int | `50` | — |
| `maxSmsPerMonth` | Int | `50` | — |
| `kioskModeEnabled` | Boolean | `false` | Feature flags |
| `analyticsEnabled` | Boolean | `false` | — |
| `priorityListing` | Boolean | `false` | — |
| `customBranding` | Boolean | `false` | — |
| `apiAccess` | Boolean | `false` | — |
| `isActive` | Boolean | `true` | — |
| `sortOrder` | Int | `0` | Display order |

### PlanFeature

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `planId` | String | — | FK → SubscriptionPlan (cascade delete) |
| `featureKey` | String | — | e.g., "kiosk_mode", "analytics" |
| `featureName` / `featureNameAr` / `featureNameFr` | String | — | — |
| `enabled` | Boolean | `false` | — |
| `limitValue` | Int? | — | Optional numeric limit |
| **Unique** | `[planId, featureKey]` | — | — |

### AgencyStaff

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `userId` | String | — | FK → User |
| `agencyId` | String | — | FK → Agency |
| `branchId` | String? | — | FK → Branch |
| `role` | String | `"STAFF"` | STAFF/MANAGER/OWNER |
| `canManageQueue` | Boolean | `true` | Granular permissions |
| `canManageServices` | Boolean | `false` | — |
| `canManageStaff` | Boolean | `false` | — |
| `canViewAnalytics` | Boolean | `true` | — |
| `canManageBranches` | Boolean | `false` | — |
| `canManageWorkingHours` | Boolean | `false` | — |
| `canExportData` | Boolean | `false` | — |
| `canManageProfile` | Boolean | `false` | — |
| `permissions` | String | JSON | Legacy JSON (backward compat) |
| `isActive` | Boolean | `true` | — |
| **Unique** | `[userId, agencyId]` | — | — |

### Service

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `agencyId` | String | — | FK → Agency |
| `name` / `nameFr` / `nameAr` | String | — | — |
| `description` | String? | — | — |
| `prefix` | String | `"A"` | Ticket prefix (e.g., "A-001") |
| `isActive` | Boolean | `true` | — |
| **Unique** | `[agencyId, name]` | — | — |

### QueueSettings

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `agencyId` | String | — | FK → Agency |
| `currentServingNumber` | Int | `0` | Currently serving |
| `lastIssuedNumber` | Int | `0` | Last issued |
| `isPaused` | Boolean | `false` | — |
| `pausedAt` | DateTime? | — | When paused |
| `openedAt` | DateTime | now() | Queue open time |

### Reservation

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `userId` | String? | — | FK → User (null for walk-ins) |
| `agencyId` | String | — | FK → Agency |
| `serviceId` | String | — | FK → Service |
| `queueNumber` | Int | — | Monotonically increasing per service |
| `displayNumber` | String | — | e.g., "A-001" |
| `status` | String | `"WAITING"` | See ReservationStatus enum |
| `estimatedWait` | Int? | — | Minutes |
| `reservedDate` | String? | — | Date string |
| `joinedAt` | DateTime | now() | — |
| `calledAt` | DateTime? | — | — |
| `completedAt` | DateTime? | — | — |
| `cancelledAt` | DateTime? | — | — |
| `rating` | Int? | — | 1-5 stars |
| `feedback` | String? | — | Text feedback |
| `notes` | String? | — | Staff notes |
| `reminderSent` / `smsReminderSent` | Boolean | `false` | — |
| `skippedForNoShow` | Boolean | `false` | — |
| `reclaimRequestedAt` | DateTime? | — | — |
| `preferredTime` | String? | — | Fixed appointment time |
| `fixedTimeEnabled` | Boolean | `false` | — |
| `postponeCount` | Int | `0` | — |
| `isWalkIn` | Boolean | `false` | — |
| `walkInCustomerName` | String? | — | For unauthenticated kiosk |
| `priceSnapshot` / `currencySnapshot` / `planNameSnapshot` | Int?/String? | — | Price at booking time |
| `counterId` | String? | — | FK → Counter (multi-desk) |
| **Indexes** | `[agencyId, status, queueNumber]`, `[agencyId, serviceId, status]`, `[userId, status]` | — | Performance |

### Transaction

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `agencyId` | String | — | FK → Agency |
| `amount` | Int | — | In DZD |
| `plan` | String | — | BASIC/PREMIUM/ENTERPRISE |
| `paymentMethod` | String | — | CCP/BANK_TRANSFER/E_WALLET/CASH |
| `receiptUrl` / `receiptStorageProvider` / `receiptStorageKey` | String? | — | Receipt file |
| `status` | String | `"PENDING"` | PENDING/APPROVED/REJECTED |
| `rejectionReason` | String? | — | — |
| `reviewedBy` | String? | — | FK → User |
| `reviewedAt` | DateTime? | — | — |
| `amountPaid` / `planName` / `priceSnapshot` / `currencySnapshot` | Int?/String? | — | Snapshot fields |
| `version` | Int | `0` | Optimistic concurrency control |

### Counter (Phase 2: Multi-Desk)

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `number` | Int | — | Counter number |
| `name` / `nameAr` / `nameFr` | String | — | — |
| `isActive` | Boolean | `true` | — |
| `branchId` | String | — | FK → Branch (cascade delete) |
| `staffId` | String? | — | FK → AgencyStaff |
| `currentReservationId` | String? | — | FK → Reservation (unique, 1:1) |

### Branch

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `name` / `nameAr` / `nameFr` | String | — | — |
| `address` / `phone` | String? | — | — |
| `isActive` | Boolean | `true` | — |
| `isMain` | Boolean | `false` | Main branch flag |
| `agencyId` | String | — | FK → Agency (cascade delete) |

### Review

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `rating` | Int | — | 1-5 stars |
| `comment` | String? | — | — |
| `replyText` | String? | — | Agency reply |
| `repliedAt` | DateTime? | — | — |
| `userId` | String | — | FK → User |
| `agencyId` | String | — | FK → Agency |
| `reservationId` | String? | — | FK → Reservation (unique) |
| **Unique** | `[userId, agencyId]` | — | One review per user per agency |

### Notification

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `userId` | String | — | FK → User |
| `type` | String | — | See NotificationType enum |
| `title` | String | — | — |
| `message` | String | `""` | — |
| `isRead` | Boolean | `false` | — |
| `entityId` | String? | — | Related entity ID |

### SmsSettings / SmsLog / SmsPurchase

SMS gateway configuration, delivery logs, and credit purchases.

### AuditLog

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | String | cuid() | — |
| `userId` | String? | — | FK → User |
| `action` | String | — | See AuditLogAction enum |
| `entityType` | String? | — | USER/AGENCY/RESERVATION/TRANSACTION |
| `entityId` | String? | — | — |
| `details` | String? | — | JSON details |
| `ipAddress` | String? | — | — |

### Favorite

Many-to-many between User and Agency. Unique on `[userId, agencyId]`.

### Announcement / GlobalAnnouncement

Agency-specific and platform-wide announcements with type (INFO/WARNING/URGENT) and optional expiry.

### FAQ

Platform FAQs with category (SUBSCRIPTION/QUEUE/SMS/PAYMENT/GENERAL) and i18n support.

### PaymentSettings

Platform-wide payment configuration (CCP, bank transfer, e-wallet).

### DeviceRegistration

Push notification device tokens for multi-platform support (web/electron/android/ios).

### UploadedFile

Provider-neutral file tracking with `storageProvider` + `storageKey`.

### DeletedRecord

Tombstone table for WatermelonDB offline sync. Created automatically by the Ghost Delete Trap Prisma extension.

---

## Enums (String Constants)

Since SQLite doesn't support native ENUM types, all enum-like fields use string constants defined in `@blasti/db` (and mirrored in `apps/api/src/lib/enums.ts`):

| Enum | Values |
|---|---|
| **UserRole** | `SUPER_ADMIN`, `AGENCY_OWNER`, `AGENCY_STAFF`, `CUSTOMER` |
| **ReservationStatus** | `WAITING`, `CALLED`, `SERVING`, `COMPLETED`, `CANCELLED`, `NO_SHOW` |
| **TransactionStatus** | `PENDING`, `APPROVED`, `REJECTED` |
| **SubscriptionTier** | `BASIC`, `PREMIUM`, `ENTERPRISE` |
| **SubscriptionStatus** | `ACTIVE`, `INACTIVE`, `TRIAL`, `EXPIRED`, `PENDING` |
| **StaffRole** | `STAFF`, `MANAGER`, `OWNER` |
| **PaymentMethod** | `CCP`, `BANK_TRANSFER`, `E_WALLET`, `CASH` |
| **AgencyCategory** | `CLINIC`, `AGENCY`, `LAW_FIRM`, `LABORATORY`, `GOVERNMENT`, `OTHER` |
| **AnnouncementType** | `INFO`, `WARNING`, `URGENT` |
| **NotificationType** | `QUEUE_CALLED`, `QUEUE_JOINED`, `QUEUE_COMPLETED`, `QUEUE_CANCELLED`, `QUEUE_POSTPONED`, `QUEUE_TIME_TOGGLE`, `QUEUE_WAITING`, `QUEUE_SERVING`, `QUEUE_NO_SHOW`, `TURN_APPROACHING`, `NO_SHOW_WARNING`, `RESERVATION_CANCELLED`, `RECLAIM_SUCCESS`, `CANCELLED`, `SMS_PURCHASED`, `RATING_SUBMITTED` |
| **AuditLogAction** | `LOGIN`, `AGENCY_CREATE`, `AGENCY_DELETE`, `USER_SUSPEND`, `USER_ACTIVATE`, `USER_DELETE`, `SETTINGS_UPDATE`, `QUEUE_CALL`, `QUEUE_JOIN`, `QUEUE_POSTPONE`, `RESERVATION_CANCEL`, `AUTO_SKIP_NO_SHOW`, `RECLAIM_POSITION`, `WALK_IN_ADDED`, `RATING_SUBMITTED`, `PAYMENT_APPROVE`, `PAYMENT_REJECT` |
| **SmsPurchaseStatus** | `PENDING`, `APPROVED`, `REJECTED` |
| **SmsLogStatus** | `PENDING`, `SENT`, `FAILED`, `DELIVERED` |
| **UserLanguage** | `ar`, `en`, `fr` |
| **FaqCategory** | `SUBSCRIPTION`, `QUEUE`, `SMS`, `PAYMENT`, `GENERAL` |

---

## Seeding

Run `bun run db:seed` to populate the database with test data:

### Seed Data

| Entity | Count | Details |
|---|---|---|
| **Admin** | 1 | `admin` / `admin123` (SUPER_ADMIN) |
| **Agency Owners** | 2 | `owner1` / `owner123` |
| **Agency Staff** | 2 | `staff1` / `staff123` |
| **Customers** | 2 | `customer1` / `customer123` |
| **Subscription Plans** | 3 | FREE, PRO, ENTERPRISE |
| **Agencies** | 2 | Clinic + Law firm, with services |
| **Branches** | 2+ | Per agency |
| **Counters** | 4+ | Per branch |
| **Services** | 4+ | Per agency with prefixes |
| **Reservations** | 15+ | Various statuses |
| **Reviews** | 2+ | Completed service reviews |
| **Payment Settings** | 1 | Platform defaults |
| **FAQs** | 5+ | Per category |

### Test Accounts

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | SUPER_ADMIN |
| `owner1` | `owner123` | AGENCY_OWNER |
| `staff1` | `staff123` | AGENCY_STAFF |
| `customer1` | `customer123` | CUSTOMER |

---

## Package Structure

```
packages/db/
├── package.json           → NPM package config (@blasti/db)
├── index.ts               → Prisma client singleton + Ghost Delete Trap
├── prisma/
│   ├── schema.prisma      → Database schema (all models)
│   └── seed.ts            → Seed script with test data
└── data/
    └── custom.db          → SQLite database file
```
