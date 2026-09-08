# BLASTI Model Parity Report

**Generated from:** `packages/db/prisma/schema.prisma`, `apps/api/src/routes/sync.ts`, `apps/desktop/local-api/sync-service.js`  
**Date:** 2025-03-05

---

## 1. Parity Matrix

| Model | Has agencyId? | Has syncVersion? | Has createdAt/updatedAt? | Has deletedAt/tombstone? | In Sync List? | Conflict Strategy | Offline Create Safe? | Offline Update Safe? | Offline Delete Safe? |
|---|---|---|---|---|---|---|---|---|---|
| **Agency** | N (has `ownerId`) | Y | Y | N | Y | last_write_wins | N | N (limited) | N |
| **Service** | Y | Y | Y | N | Y | last_write_wins | Y | Y | Y |
| **Branch** | Y | Y | Y | N | Y | last_write_wins | Y | Y | Y |
| **Counter** | N (has `branchId`) | Y | Y | N | Y | last_write_wins | Y | Y | Y |
| **Reservation** | Y | **N** | Y | N | Y | state_machine | Y | Y | N |
| **Notification** | N (has `userId`) | Y | Y | N | Y | last_write_wins | N | Y (isRead) | N |
| **QueueSettings** | Y | Y | **Partial** (updatedAt only) | N | Y | last_write_wins | N | Y | N |
| **AgencyStaff** | Y | Y | **N** (joinedAt only) | N | Y | last_write_wins | Y | Y | Y |
| **Review** | Y | Y | Y | N | Y | last_write_wins | N | N | N (admin) |
| **User** | N | **N** | Y | N | Y | cloud_wins (default) | N | N | N |
| **SmsSettings** | **N** | **N** | Y | N | Y | last_write_wins | N | Y | N |
| **PaymentSettings** | **N** | **N** | Y | N | Y | cloud_wins | N | N (admin) | N |
| **Announcement** | Y | Y | Y | N | Y | last_write_wins | Y | Y | Y |
| **GlobalAnnouncement** | N | **N** | Y | N | Y | last_write_wins | N (admin) | N (admin) | N (admin) |
| **Transaction** | Y | **N** (has `version`) | Y | N | Y | cloud_wins | N | N | N |
| **SubscriptionPlan** | **N** (has `ownerAgencyId`) | **N** | Y | N | Y | cloud_wins | N (admin) | N (admin) | N (admin) |
| **PlanFeature** | N | **N** | Y | N | Y | cloud_wins | N (admin) | N (admin) | N (admin) |
| **Favorite** | Y | **N** | Y | N | Y | last_write_wins | N (admin) | N | N (admin) |
| **FAQ** | **N** | **N** | Y | N | Y | last_write_wins | Y | Y | Y |

---

## 2. Non-Sync Models (for reference)

| Model | Has agencyId? | Has syncVersion? | In Sync List? | Notes |
|---|---|---|---|---|
| HardwareProduct | N | N | N | Admin-only catalog |
| HardwareOrder | Y | N | N | Agency-scoped, not synced |
| HardwareOrderItem | N | N | N | Child of HardwareOrder |
| EnterpriseContractRequest | Y | N | N | Admin workflow |
| HardwareSettings | N | N | N | Global singleton |
| HardwareCommitmentTier | N | N | N | Global config |
| SmsPurchase | N | N | N | User-scoped purchase |
| SmsLog | N (has smsSettingsId) | N | N | Log table |
| AuditLog | N (has userId) | N | N | Audit trail |
| DeviceRegistration | N (has userId) | N | N | Device tracking |
| UploadedFile | N | N | N | Storage abstraction |
| AgencyDevice | Y (optional) | N | N | Device management |
| SavedTv | Y (optional) | N | N | Discovered TVs |
| DefaultPrinter | Y (optional) | N | N | Printer config |
| DeviceCommand | N (has deviceId) | N | N | Device commands |
| AppVersion | N | N | N | Version management |
| DelayedJob | N (has userId) | N | N | Job scheduler |
| SystemSetting | N | N | N | Global config |
| DeletedRecord | Y | Y | N | Sync infra (tombstone) |
| SyncChange | Y | Y | N | Sync infra (change log) |
| SyncMutation | Y | N | N | Sync infra (idempotency) |
| PendingMutation | Y | N | N | Sync infra (WAL) |
| SyncState | Y | N | N | Sync infra (cursor) |

---

## 3. Critical Findings

### 3A. Models in Sync List but MISSING `syncVersion`

These models are declared in `SYNC_MODELS` and will be pulled/pushed by the sync engine, but **lack the `syncVersion Int @default(0)` column** required for version-based conflict detection. The cloud pull route **selects `syncVersion: true`** for all of them, which will cause runtime errors or return `undefined`.

| Model | Severity | Impact |
|---|---|---|
| **Reservation** | **CRITICAL** | Core queue entity; state_machine strategy depends on version comparison |
| **User** | HIGH | Synced to all clients; no version tracking = undetectable conflicts |
| **Transaction** | HIGH | Financial data; cloud_wins strategy but `version` field exists (different name) |
| **Favorite** | MEDIUM | User bookmarks; low conflict risk but sync select will fail |
| **GlobalAnnouncement** | MEDIUM | Admin broadcast; sync select will fail |
| **SmsSettings** | **CRITICAL** | Agency settings synced; pull selects `syncVersion: true` → runtime error |
| **PaymentSettings** | **CRITICAL** | Payment config synced; pull selects `syncVersion: true` → runtime error |
| **SubscriptionPlan** | HIGH | Billing authority; pull selects `syncVersion: true` → runtime error |
| **PlanFeature** | HIGH | Plan features; pull selects `syncVersion: true` → runtime error |
| **FAQ** | MEDIUM | Public FAQ; pull selects `syncVersion: true` → runtime error |

### 3B. Models with `syncVersion` but NOT in Sync List

| Model | Notes |
|---|---|
| DeletedRecord | Sync infrastructure — expected, not a bug |
| SyncChange | Sync infrastructure — expected, not a bug |

These are by design (infra models).

### 3C. Models Missing `agencyId` That Should Have It

Per `AGENCY_SCOPED_MODELS` in both cloud and desktop sync code, these models are declared as agency-scoped but **lack the `agencyId` column** in the schema:

| Model | Current State | Expected | Severity |
|---|---|---|---|
| **SmsSettings** | No `agencyId` | Should have `agencyId String` | **CRITICAL** — cloud pull selects `agencyId: true` |
| **PaymentSettings** | No `agencyId` | Should have `agencyId String` | **CRITICAL** — cloud pull selects `agencyId: true` |
| **SubscriptionPlan** | Has `ownerAgencyId` (different semantics) | Pull selects `agencyId` | **CRITICAL** — field name mismatch |
| **FAQ** | No `agencyId` | Should have `agencyId String` | **CRITICAL** — cloud pull selects `agencyId: true` |

### 3D. Field Type Mismatches (Cloud Sync Select vs. Local Schema)

The cloud sync pull route selects fields that **do not exist** in the Prisma schema. These will cause Prisma query errors at runtime.

| Model | Field in Sync Select | Actual Schema Field | Severity |
|---|---|---|---|
| **Service** | `averageServiceTime` | **Does not exist** (removed from Service model) | HIGH |
| **Reservation** | `noShowAt` | `skippedAt` / `skippedForNoShow` (different name) | HIGH |
| **Reservation** | `syncVersion` | **Does not exist** | CRITICAL |
| **Reservation** | `createdAt` | **Does not exist** (has `joinedAt`) | HIGH |
| **QueueSettings** | `createdAt` | **Does not exist** (has `openedAt`) | MEDIUM |
| **AgencyStaff** | `createdAt` | **Does not exist** (has `joinedAt`) | MEDIUM |
| **AgencyStaff** | `updatedAt` | **Does not exist** | MEDIUM |
| **SmsSettings** | `agencyId` | **Does not exist** | CRITICAL |
| **SmsSettings** | `isEnabled` | `enabled` (different name) | HIGH |
| **SmsSettings** | `syncVersion` | **Does not exist** | CRITICAL |
| **PaymentSettings** | `agencyId` | **Does not exist** | CRITICAL |
| **PaymentSettings** | `provider` | **Does not exist** | HIGH |
| **PaymentSettings** | `isEnabled` | **Does not exist** | HIGH |
| **PaymentSettings** | `syncVersion` | **Does not exist** | CRITICAL |
| **Announcement** | `title` | **Does not exist** (has `message`, `type`) | HIGH |
| **GlobalAnnouncement** | `title` | **Does not exist** | HIGH |
| **GlobalAnnouncement** | `isActive` | **Does not exist** | MEDIUM |
| **GlobalAnnouncement** | `syncVersion` | **Does not exist** | CRITICAL |
| **Transaction** | `userId` | **Does not exist** (has `reviewedBy`) | HIGH |
| **Transaction** | `type` | **Does not exist** | HIGH |
| **Transaction** | `syncVersion` | `version` (different name) | CRITICAL |
| **SubscriptionPlan** | `agencyId` | `ownerAgencyId` (different name/semantics) | CRITICAL |
| **SubscriptionPlan** | `syncVersion` | **Does not exist** | CRITICAL |
| **PlanFeature** | `syncVersion` | **Does not exist** | CRITICAL |
| **Favorite** | `syncVersion` | **Does not exist** | CRITICAL |
| **FAQ** | `agencyId` | **Does not exist** | CRITICAL |
| **FAQ** | `syncVersion` | **Does not exist** | CRITICAL |

---

## 4. Conflict Strategy Summary

| Strategy | Models |
|---|---|
| **cloud_wins** | Transaction, SubscriptionPlan, PlanFeature, PaymentSettings, User (implicit default) |
| **last_write_wins** | Agency, Service, Branch, Counter, QueueSettings, AgencyStaff, Review, Notification, SmsSettings, Announcement, GlobalAnnouncement, FAQ, Favorite |
| **state_machine** | Reservation (cloud_wins when status ∈ {WAITING, CALLED, COMPLETED}; last_write_wins otherwise) |

---

## 5. Offline Safety Summary

| Capability | Models |
|---|---|
| **Full CRUD offline** | Service, Branch, Counter, AgencyStaff, Announcement, FAQ |
| **Create + Update offline** | Reservation |
| **Update only offline** | Notification (isRead), QueueSettings, SmsSettings |
| **Admin-only CRUD** | SubscriptionPlan, PlanFeature, GlobalAnnouncement, Favorite |
| **Read-only offline** | User, Transaction, PaymentSettings, Review |

---

## 6. Models Missing `createdAt`/`updatedAt` Timestamps

| Model | Missing | Has Instead |
|---|---|---|
| QueueSettings | `createdAt` | `openedAt` |
| AgencyStaff | `createdAt`, `updatedAt` | `joinedAt` only |
| Reservation | `createdAt` | `joinedAt` |

These are important because the sync engine uses `createdAt` to distinguish "created" vs "updated" records in the legacy pull path, and `updatedAt` for `last_write_wins` conflict resolution.

---

## 7. Recommendations

### P0 — Fix Immediately (Runtime Errors)

1. **Add `syncVersion Int @default(0)` to all 10 models** missing it (Reservation, User, Transaction, Favorite, GlobalAnnouncement, SmsSettings, PaymentSettings, SubscriptionPlan, PlanFeature, FAQ)
2. **Add `agencyId String` to SmsSettings, PaymentSettings, FAQ** — the sync engine filters by agencyId for these models
3. **Fix field name mismatches in sync.ts pull selects:**
   - Service: remove `averageServiceTime`
   - Reservation: `noShowAt` → `skippedAt`, remove `syncVersion` (after adding field), `createdAt` → `joinedAt`
   - QueueSettings: `createdAt` → `openedAt`
   - AgencyStaff: `createdAt` → `joinedAt`, add `updatedAt` to schema
   - SmsSettings: `isEnabled` → `enabled`, add `agencyId` + `syncVersion`
   - PaymentSettings: fix all 4 phantom fields
   - Announcement: `title` → `type` (or add `title` to schema)
   - GlobalAnnouncement: add `title`, `isActive`, `syncVersion` or fix select
   - Transaction: `userId` → `reviewedBy`, remove `type`, `syncVersion` → `version`
   - SubscriptionPlan: `agencyId` → `ownerAgencyId`
   - Favorite, PlanFeature, FAQ: add `syncVersion`

### P1 — Fix Soon (Data Integrity)

4. **Add `createdAt` and `updatedAt` to AgencyStaff** — required for last_write_wins conflict resolution
5. **Add `createdAt` to QueueSettings** — sync engine splits created vs updated on this field
6. **Add `createdAt` to Reservation** (or alias `joinedAt` in sync logic)
7. **Rename Transaction.`version` to `syncVersion`** — or update sync select to use `version`

### P2 — Improve (Architecture)

8. **Add `deletedAt DateTime?` soft-delete** to sync-critical models for proper tombstone support (currently only DeletedRecord tracks deletions externally)
9. **Add `agencyId` to Counter** (denormalized from Branch) — enables direct agency-scoped queries without JOIN
10. **Consider adding `agencyId` to Notification** — currently scoped by userId only, but agency staff may need agency-scoped notification sync
11. **Add `syncedAt DateTime?` to User** — all other sync models with syncVersion also have syncedAt

---

## 8. Sync List Parity (Cloud vs Desktop)

| Model | In Cloud SYNC_MODELS? | In Desktop SYNC_TABLES? | Match? |
|---|---|---|---|
| Agency | Y | Y | ✅ |
| Service | Y | Y | ✅ |
| Branch | Y | Y | ✅ |
| Counter | Y | Y | ✅ |
| Reservation | Y | Y | ✅ |
| Notification | Y | Y | ✅ |
| QueueSettings | Y | Y | ✅ |
| AgencyStaff | Y | Y | ✅ |
| Review | Y | Y | ✅ |
| User | Y | Y | ✅ |
| SmsSettings | Y | Y | ✅ |
| PaymentSettings | Y | Y | ✅ |
| Announcement | Y | Y | ✅ |
| GlobalAnnouncement | Y | Y | ✅ |
| Transaction | Y | Y | ✅ |
| SubscriptionPlan | Y | Y | ✅ |
| PlanFeature | Y | Y | ✅ |
| Favorite | Y | Y | ✅ |
| FAQ | Y | Y | ✅ |

Cloud and desktop agree on the sync model list. However, the **agency-scoped lists differ:**

| Model | Cloud AGENCY_SCOPED? | Desktop AGENCY_SCOPED? | Match? |
|---|---|---|---|
| Counter | N | N | ✅ |
| Notification | N | N | ✅ |
| User | N | N | ✅ |
| GlobalAnnouncement | N | N | ✅ |
| All others | Y | Y | ✅ |

Both lists are consistent.

---

## 9. Summary Statistics

| Metric | Count |
|---|---|
| Total models in schema | 42 |
| Models in sync list | 19 |
| Models with `syncVersion` | 10 (of 19 in sync list) |
| Models missing `syncVersion` (in sync list) | **10** |
| Models missing `agencyId` (but agency-scoped) | **4** |
| Field mismatches (sync select vs schema) | **25** |
| Models with full offline CRUD | 6 |
| P0 critical issues | **15+** |
