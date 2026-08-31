/**
 * @blasti/core — SQLite Schema Definition
 *
 * DDL statements for creating all BLASTI tables in SQLite.
 * Mirrors the Prisma schema at packages/db/prisma/schema.prisma.
 *
 * SQLite-specific conventions:
 *   - Boolean → INTEGER (0/1)
 *   - DateTime → INTEGER (epoch milliseconds)
 *   - JSON    → TEXT
 *   - IDs     → TEXT (CUID-compatible, UUID-like)
 *
 * Usage:
 *   import { getCreateTablesSQL } from '@blasti/core/schema'
 *   const sql = getCreateTablesSQL()
 *   db.exec(sql)
 */

export function getCreateTablesSQL(): string {
  return `
    -- ─── Users ─────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "User" (
      "id" TEXT PRIMARY KEY,
      "username" TEXT NOT NULL UNIQUE,
      "fullName" TEXT NOT NULL,
      "email" TEXT UNIQUE,
      "phoneNumber" TEXT UNIQUE,
      "shortAppId" TEXT UNIQUE,
      "passwordHash" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
      "language" TEXT NOT NULL DEFAULT 'ar',
      "avatarUrl" TEXT,
      "avatarStorageProvider" TEXT,
      "avatarStorageKey" TEXT,
      "freeSmsCount" INTEGER NOT NULL DEFAULT 10,
      "notificationPreferences" TEXT NOT NULL DEFAULT '{}',
      "reminderMinutes" INTEGER NOT NULL DEFAULT 10,
      "smsNotificationsEnabled" INTEGER NOT NULL DEFAULT 1,
      "notificationPref" TEXT NOT NULL DEFAULT 'APP_ONLY',
      "isAppOnline" INTEGER NOT NULL DEFAULT 0,
      "fcmToken" TEXT,
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "lastRoleChangeAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS "idx_user_username" ON "User"("username");
    CREATE INDEX IF NOT EXISTS "idx_user_phone" ON "User"("phoneNumber");
    CREATE INDEX IF NOT EXISTS "idx_user_role" ON "User"("role");

    -- ─── Agencies ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Agency" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "nameFr" TEXT,
      "nameAr" TEXT,
      "customCode" TEXT NOT NULL UNIQUE,
      "category" TEXT NOT NULL,
      "address" TEXT,
      "city" TEXT NOT NULL DEFAULT 'M_Sila',
      "wilaya" TEXT NOT NULL DEFAULT '28',
      "phone" TEXT,
      "email" TEXT,
      "website" TEXT,
      "logoUrl" TEXT,
      "logoStorageProvider" TEXT,
      "logoStorageKey" TEXT,
      "coverUrl" TEXT,
      "coverStorageProvider" TEXT,
      "coverStorageKey" TEXT,
      "description" TEXT,
      "descriptionFr" TEXT,
      "descriptionAr" TEXT,
      "averageServiceTime" INTEGER NOT NULL DEFAULT 10,
      "maxActiveReservations" INTEGER NOT NULL DEFAULT 50,
      "autoPauseWhenFull" INTEGER NOT NULL DEFAULT 0,
      "isSponsored" INTEGER NOT NULL DEFAULT 0,
      "subscriptionPlanId" TEXT,
      "subscriptionTier" TEXT NOT NULL DEFAULT 'BASIC',
      "subscriptionStatus" TEXT NOT NULL DEFAULT 'INACTIVE',
      "workingHoursStart" TEXT NOT NULL DEFAULT '08:00',
      "workingHoursEnd" TEXT NOT NULL DEFAULT '17:00',
      "isQueueOpen" INTEGER NOT NULL DEFAULT 1,
      "isPaused" INTEGER NOT NULL DEFAULT 0,
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "kioskModeEnabled" INTEGER NOT NULL DEFAULT 0,
      "sponsorSms" INTEGER NOT NULL DEFAULT 0,
      "smsBalance" INTEGER NOT NULL DEFAULT 0,
      "gracePeriodEndsAt" INTEGER,
      "subscriptionStartsAt" INTEGER,
      "subscriptionExpiresAt" INTEGER,
      "ownerId" TEXT NOT NULL,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("ownerId") REFERENCES "User"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_agency_owner" ON "Agency"("ownerId");
    CREATE INDEX IF NOT EXISTS "idx_agency_code" ON "Agency"("customCode");
    CREATE INDEX IF NOT EXISTS "idx_agency_active" ON "Agency"("isActive");

    -- ─── Subscription Plans ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "SubscriptionPlan" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL UNIQUE,
      "displayName" TEXT NOT NULL,
      "displayNameAr" TEXT,
      "displayNameFr" TEXT,
      "description" TEXT,
      "descriptionAr" TEXT,
      "descriptionFr" TEXT,
      "price" INTEGER NOT NULL DEFAULT 0,
      "currency" TEXT NOT NULL DEFAULT 'DZD',
      "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
      "maxServices" INTEGER NOT NULL DEFAULT 5,
      "maxBranches" INTEGER NOT NULL DEFAULT 1,
      "maxStaff" INTEGER NOT NULL DEFAULT 3,
      "maxActiveReservations" INTEGER NOT NULL DEFAULT 50,
      "maxSmsPerMonth" INTEGER NOT NULL DEFAULT 50,
      "kioskModeEnabled" INTEGER NOT NULL DEFAULT 0,
      "analyticsEnabled" INTEGER NOT NULL DEFAULT 0,
      "priorityListing" INTEGER NOT NULL DEFAULT 0,
      "customBranding" INTEGER NOT NULL DEFAULT 0,
      "apiAccess" INTEGER NOT NULL DEFAULT 0,
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "quarterlyDiscount" INTEGER NOT NULL DEFAULT 0,
      "semiAnnualDiscount" INTEGER NOT NULL DEFAULT 0,
      "annualDiscount" INTEGER NOT NULL DEFAULT 0,
      "biennialDiscount" INTEGER NOT NULL DEFAULT 0,
      "isEnterprise" INTEGER NOT NULL DEFAULT 0,
      "ownerAgencyId" TEXT,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL
    );

    -- ─── Agency Staff ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "AgencyStaff" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "agencyId" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'STAFF',
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "canManageQueue" INTEGER NOT NULL DEFAULT 1,
      "canManageServices" INTEGER NOT NULL DEFAULT 0,
      "canManageStaff" INTEGER NOT NULL DEFAULT 0,
      "canViewAnalytics" INTEGER NOT NULL DEFAULT 0,
      "canManageBranches" INTEGER NOT NULL DEFAULT 0,
      "canManageWorkingHours" INTEGER NOT NULL DEFAULT 0,
      "canExportData" INTEGER NOT NULL DEFAULT 0,
      "canManageProfile" INTEGER NOT NULL DEFAULT 1,
      "joinedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id"),
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_staff_user" ON "AgencyStaff"("userId");
    CREATE INDEX IF NOT EXISTS "idx_staff_agency" ON "AgencyStaff"("agencyId");
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_staff_user_agency" ON "AgencyStaff"("userId", "agencyId");

    -- ─── Services ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Service" (
      "id" TEXT PRIMARY KEY,
      "agencyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "nameFr" TEXT,
      "nameAr" TEXT,
      "prefix" TEXT,
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "estimatedDuration" INTEGER,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "idx_service_agency" ON "Service"("agencyId");

    -- ─── Branches ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Branch" (
      "id" TEXT PRIMARY KEY,
      "agencyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "nameAr" TEXT,
      "nameFr" TEXT,
      "address" TEXT,
      "phone" TEXT,
      "isMain" INTEGER NOT NULL DEFAULT 0,
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "idx_branch_agency" ON "Branch"("agencyId");

    -- ─── Counters ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Counter" (
      "id" TEXT PRIMARY KEY,
      "branchId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "number" INTEGER NOT NULL,
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "staffId" TEXT,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE,
      FOREIGN KEY ("staffId") REFERENCES "User"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_counter_branch" ON "Counter"("branchId");

    -- ─── Queue Settings ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "QueueSettings" (
      "id" TEXT PRIMARY KEY,
      "agencyId" TEXT NOT NULL,
      "currentServingNumber" INTEGER NOT NULL DEFAULT 0,
      "lastIssuedNumber" INTEGER NOT NULL DEFAULT 0,
      "isPaused" INTEGER NOT NULL DEFAULT 0,
      "openedAt" INTEGER,
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "idx_queuesettings_agency" ON "QueueSettings"("agencyId");

    -- ─── Reservations ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Reservation" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT,
      "agencyId" TEXT NOT NULL,
      "serviceId" TEXT NOT NULL,
      "queueNumber" INTEGER NOT NULL DEFAULT 0,
      "displayNumber" TEXT,
      "status" TEXT NOT NULL DEFAULT 'WAITING',
      "counterId" TEXT,
      "branchId" TEXT,
      "position" INTEGER NOT NULL DEFAULT 0,
      "estimatedWait" INTEGER NOT NULL DEFAULT 0,
      "preferredTime" TEXT,
      "fixedTimeEnabled" INTEGER NOT NULL DEFAULT 0,
      "fixedTime" TEXT,
      "reservedDate" TEXT,
      "isWalkIn" INTEGER NOT NULL DEFAULT 0,
      "walkInCustomerName" TEXT,
      "rating" INTEGER,
      "feedback" TEXT,
      "calledAt" INTEGER,
      "completedAt" INTEGER,
      "cancelledAt" INTEGER,
      "noShowAt" INTEGER,
      "joinedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "reminderSent" INTEGER NOT NULL DEFAULT 0,
      "reminderSentAt" INTEGER,
      "smsReminderSent" INTEGER NOT NULL DEFAULT 0,
      "smsReminderSentAt" INTEGER,
      "skippedForNoShow" INTEGER NOT NULL DEFAULT 0,
      "skippedAt" INTEGER,
      "reclaimRequestedAt" INTEGER,
      "importToken" TEXT,
      "qrClaimedAt" INTEGER,
      "qrClaimDeviceId" TEXT,
      "syncDeviceId" TEXT,
      "offlineCreatedAt" INTEGER,
      "syncConflict" TEXT,
      "_status" TEXT DEFAULT 'synced',
      "_changedAt" INTEGER,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id"),
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id"),
      FOREIGN KEY ("serviceId") REFERENCES "Service"("id"),
      FOREIGN KEY ("counterId") REFERENCES "Counter"("id"),
      FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_reservation_agency" ON "Reservation"("agencyId");
    CREATE INDEX IF NOT EXISTS "idx_reservation_user" ON "Reservation"("userId");
    CREATE INDEX IF NOT EXISTS "idx_reservation_status" ON "Reservation"("status");
    CREATE INDEX IF NOT EXISTS "idx_reservation_service" ON "Reservation"("serviceId");
    CREATE INDEX IF NOT EXISTS "idx_reservation_date" ON "Reservation"("createdAt");

    -- ─── Notifications ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Notification" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "isRead" INTEGER NOT NULL DEFAULT 0,
      "entityId" TEXT,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "idx_notification_user" ON "Notification"("userId");
    CREATE INDEX IF NOT EXISTS "idx_notification_read" ON "Notification"("userId", "isRead");

    -- ─── Reviews ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Review" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "agencyId" TEXT NOT NULL,
      "reservationId" TEXT,
      "rating" INTEGER NOT NULL,
      "comment" TEXT,
      "replyText" TEXT,
      "repliedAt" INTEGER,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id"),
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_review_agency" ON "Review"("agencyId");

    -- ─── Audit Log ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "AuditLog" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT,
      "action" TEXT NOT NULL,
      "entityType" TEXT NOT NULL,
      "entityId" TEXT NOT NULL,
      "details" TEXT,
      "ipAddress" TEXT,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY ("userId") REFERENCES "User"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_audit_user" ON "AuditLog"("userId");
    CREATE INDEX IF NOT EXISTS "idx_audit_action" ON "AuditLog"("action");

    -- ─── Favorites ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Favorite" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "agencyId" TEXT NOT NULL,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id"),
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id"),
      UNIQUE("userId", "agencyId")
    );

    -- ─── Announcements ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Announcement" (
      "id" TEXT PRIMARY KEY,
      "agencyId" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "type" TEXT NOT NULL DEFAULT 'INFO',
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "expiresAt" INTEGER,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE
    );

    -- ─── Transactions ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "Transaction" (
      "id" TEXT PRIMARY KEY,
      "agencyId" TEXT NOT NULL,
      "amount" REAL NOT NULL,
      "plan" TEXT NOT NULL DEFAULT 'BASIC',
      "paymentMethod" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "receiptUrl" TEXT,
      "paymentProvider" TEXT,
      "providerRef" TEXT,
      "webhookVerified" INTEGER NOT NULL DEFAULT 0,
      "reviewedBy" TEXT,
      "reviewedAt" INTEGER,
      "rejectionReason" TEXT,
      "amountPaid" REAL,
      "planName" TEXT,
      "version" INTEGER NOT NULL DEFAULT 1,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("agencyId") REFERENCES "Agency"("id"),
      FOREIGN KEY ("reviewedBy") REFERENCES "User"("id")
    );
    CREATE INDEX IF NOT EXISTS "idx_transaction_agency" ON "Transaction"("agencyId");

    -- ─── Deleted Records (Tombstone for sync) ─────────────────────────────
    CREATE TABLE IF NOT EXISTS "DeletedRecord" (
      "id" TEXT PRIMARY KEY,
      "modelName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS "idx_deleted_model" ON "DeletedRecord"("modelName");

    -- ─── System Settings ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "SystemSetting" (
      "id" TEXT PRIMARY KEY,
      "key" TEXT NOT NULL UNIQUE,
      "value" TEXT NOT NULL,
      "encrypted" INTEGER NOT NULL DEFAULT 0,
      "category" TEXT,
      "description" TEXT,
      "valueType" TEXT NOT NULL DEFAULT 'string',
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    -- ─── FAQ ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "FAQ" (
      "id" TEXT PRIMARY KEY,
      "question" TEXT NOT NULL,
      "answer" TEXT NOT NULL,
      "questionAr" TEXT,
      "answerAr" TEXT,
      "questionFr" TEXT,
      "answerFr" TEXT,
      "category" TEXT NOT NULL DEFAULT 'GENERAL',
      "isActive" INTEGER NOT NULL DEFAULT 1,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "updatedAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL
    );

    -- ─── Device Registration ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "DeviceRegistration" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL,
      "platform" TEXT NOT NULL,
      "deviceToken" TEXT,
      "deviceId" TEXT,
      "appVersion" TEXT,
      "deviceFingerprint" TEXT,
      "lastActiveAt" INTEGER,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      "_version" INTEGER NOT NULL DEFAULT 1,
      "_deviceId" TEXT NOT NULL DEFAULT '',
      "_deletedAt" INTEGER DEFAULT NULL,
      FOREIGN KEY ("userId") REFERENCES "User"("id")
    );

    -- ─── Sync Metadata ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "_sync_meta" (
      "key" TEXT PRIMARY KEY,
      "value" TEXT NOT NULL
    );

    -- ─── Sync Conflict Log ───────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS "_sync_conflicts" (
      "id" TEXT PRIMARY KEY,
      "tableName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "localVersion" INTEGER NOT NULL,
      "cloudVersion" INTEGER NOT NULL,
      "localData" TEXT,
      "cloudData" TEXT,
      "resolution" TEXT DEFAULT NULL,
      "resolvedAt" INTEGER DEFAULT NULL,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS "idx_conflict_table" ON "_sync_conflicts"("tableName");
    CREATE INDEX IF NOT EXISTS "idx_conflict_unresolved" ON "_sync_conflicts"("resolution");
  `
}

/**
 * Migration SQL for existing databases.
 * Adds sync columns (_version, _deviceId, _deletedAt) to all tables.
 * Safe to run on databases that already have these columns — execute
 * each statement individually and ignore "duplicate column" errors.
 *
 * Usage in Electron (better-sqlite3):
 *   const sql = getSyncMigrationSQL()
 *   const statements = sql.split(';').filter(s => s.trim())
 *   for (const stmt of statements) {
 *     try { db.exec(stmt) } catch { /* column already exists */ }
 *   }
 */
export function getSyncMigrationSQL(): string {
  // Tables that participate in sync (all except metadata tables)
  const SYNC_TABLES = [
    'User', 'Agency', 'SubscriptionPlan', 'AgencyStaff',
    'Service', 'Branch', 'Counter', 'QueueSettings',
    'Reservation', 'Notification', 'Review',
    'AuditLog', 'Favorite', 'Announcement', 'Transaction',
    'FAQ', 'DeviceRegistration',
  ]

  const statements: string[] = []

  for (const table of SYNC_TABLES) {
    statements.push(`ALTER TABLE "${table}" ADD COLUMN "_version" INTEGER NOT NULL DEFAULT 1`)
    statements.push(`ALTER TABLE "${table}" ADD COLUMN "_deviceId" TEXT NOT NULL DEFAULT ''`)
    statements.push(`ALTER TABLE "${table}" ADD COLUMN "_deletedAt" INTEGER DEFAULT NULL`)
  }

  // Create _sync_conflicts table if not exists
  statements.push(`
    CREATE TABLE IF NOT EXISTS "_sync_conflicts" (
      "id" TEXT PRIMARY KEY,
      "tableName" TEXT NOT NULL,
      "recordId" TEXT NOT NULL,
      "localVersion" INTEGER NOT NULL,
      "cloudVersion" INTEGER NOT NULL,
      "localData" TEXT,
      "cloudData" TEXT,
      "resolution" TEXT DEFAULT NULL,
      "resolvedAt" INTEGER DEFAULT NULL,
      "createdAt" INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `)
  statements.push(`CREATE INDEX IF NOT EXISTS "idx_conflict_table" ON "_sync_conflicts"("tableName")`)
  statements.push(`CREATE INDEX IF NOT EXISTS "idx_conflict_unresolved" ON "_sync_conflicts"("resolution")`)

  return statements.join(';\n')
}

/**
 * Generate a CUID-like ID for new records.
 * Uses crypto.randomUUID() or falls back to timestamp + random.
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback: timestamp + random hex
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 11)
  return `${ts}${rand}`
}

/**
 * Get the current timestamp as epoch milliseconds (for SQLite DateTime fields).
 */
export function nowMs(): number {
  return Date.now()
}

/**
 * Tables that participate in sync (version-based conflict resolution).
 * Excludes: _sync_meta, SystemSetting, AuditLog, DeletedRecord.
 */
const SYNC_TABLES = [
  'User',
  'Agency',
  'SubscriptionPlan',
  'AgencyStaff',
  'Service',
  'Branch',
  'Counter',
  'QueueSettings',
  'Reservation',
  'Notification',
  'Review',
  'Favorite',
  'Announcement',
  'Transaction',
  'FAQ',
  'DeviceRegistration',
] as const

/**
 * Generate ALTER TABLE statements to add sync columns to existing databases.
 *
 * Because SQLite does not support `ALTER TABLE ADD COLUMN IF NOT EXISTS`,
 * the caller must execute each statement individually and ignore
 * "duplicate column name" errors (SQLITE_ERROR code 1, message containing
 * "duplicate column").
 *
 * Usage:
 * ```ts
 *   const stmts = getSyncMigrationSQL()
 *   for (const sql of stmts) {
 *     try { db.exec(sql) } catch (e) { /* ignore duplicate column */ }
 *   }
 * ```
 *
 * @returns Array of individual ALTER TABLE SQL statements.
 */
export function getSyncMigrationSQL(): string[] {
  const statements: string[] = []
  for (const table of SYNC_TABLES) {
    statements.push(
      `ALTER TABLE "${table}" ADD COLUMN "_version" INTEGER NOT NULL DEFAULT 1;`,
      `ALTER TABLE "${table}" ADD COLUMN "_deviceId" TEXT NOT NULL DEFAULT '';`,
      `ALTER TABLE "${table}" ADD COLUMN "_deletedAt" INTEGER DEFAULT NULL;`,
    )
  }
  return statements
}
